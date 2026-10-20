import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { summarizeRuntimeStderr } from "./logger.js";
import type {
  RuntimeProcessExit,
  RuntimeProcessExitListener,
  RuntimeProcessManager,
  RuntimeProcessStatus,
} from "./types.js";

export interface ProcessManagerOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawn?: typeof defaultSpawn;
}

export class ProcessManager implements RuntimeProcessManager {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd: string | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly spawnProcess: typeof defaultSpawn;
  private child: ChildProcess | undefined;
  private running = false;
  private stopping: Promise<void> | undefined;
  private readonly expectedExits = new WeakSet<ChildProcess>();
  private starting: Promise<RuntimeProcessStatus> | undefined;
  private cancelStarting: (() => void) | undefined;
  private readonly exitListeners = new Set<RuntimeProcessExitListener>();

  public constructor(options: ProcessManagerOptions = {}) {
    this.command = options.command ?? process.execPath;
    this.args = options.args ?? (process.argv[1] === undefined ? [] : [process.argv[1], "--runtime"]);
    this.cwd = options.cwd;
    this.environment = { ...(options.environment ?? process.env) };
    this.spawnProcess = options.spawn ?? defaultSpawn;
  }

  public start(): Promise<RuntimeProcessStatus> {
    if (this.stopping !== undefined) return this.stopping.then(() => this.start());
    if (this.child !== undefined && !this.running && this.starting === undefined) {
      return Promise.reject(new Error("Previous runtime has not exited"));
    }
    if (this.running) return Promise.resolve(this.status());
    if (this.starting !== undefined) return this.starting;

    const promise = new Promise<RuntimeProcessStatus>((resolve, reject) => {
      let child: ChildProcess | undefined;
      let settled = false;
      let exited = false;
      let stderr = "";

      const clear = (): void => {
        if (this.child === child) {
          this.child = undefined;
          this.running = false;
        }
        if (this.cancelStarting !== undefined) this.cancelStarting = undefined;
      };
      const fail = (cause?: unknown): void => {
        if (settled) return;
        settled = true;
        if (child === undefined || child.pid === undefined || exited) clear();
        reject(cause === undefined
          ? new Error("Runtime process failed to start")
          : new Error("Runtime process failed to start", { cause }));
      };
      const markExited = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (exited) return;
        exited = true;
        if (this.child === child) {
          this.child = undefined;
          this.running = false;
          const exit: RuntimeProcessExit = { code, signal, pid: child?.pid,
            expected: child !== undefined && this.expectedExits.has(child),
            ...(stderr === "" ? {} : { stderr: summarizeRuntimeStderr(stderr) }),
          };
          for (const listener of this.exitListeners) {
            try {
              listener(exit);
            } catch {
              // Exit observers must not affect process bookkeeping.
            }
          }
        }
        if (!settled) fail();
      };
      const started = (): void => {
        if (settled || exited || child === undefined) return;
        settled = true;
        this.running = true;
        resolve(this.status());
      };

      try {
        const spawnOptions: SpawnOptions = {
          env: this.environment,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
          ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
        };
        child = this.spawnProcess(this.command, this.args, spawnOptions);
        this.child = child;
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk.slice(-4096)).slice(-4096); });
        child.once("spawn", started);
        child.once("error", (error) => fail(error));
        child.once("exit", markExited);
        child.once("close", (code, signal) => markExited(code, signal));
      } catch (error: unknown) {
        fail(error);
      }

      this.cancelStarting = () => fail();
    });

    this.starting = promise;
    promise.finally(() => {
      if (this.starting === promise) this.starting = undefined;
      this.cancelStarting = undefined;
    }).catch(() => undefined);
    return promise;
  }

  public stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    const child = this.child;
    this.cancelStarting?.();
    this.cancelStarting = undefined;
    if (child === undefined) return Promise.resolve();
    this.expectedExits.add(child);
    const operation = new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        child.removeListener("exit", finish);
        child.removeListener("close", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        child.removeListener("exit", finish);
        child.removeListener("close", finish);
        reject(new Error("Runtime process stop timed out"));
      }, 5000);
      child.once("exit", finish);
      child.once("close", finish);
      try {
        if (!child.killed) child.kill();
      } catch {
        clearTimeout(timer);
        child.removeListener("exit", finish);
        child.removeListener("close", finish);
        reject(new Error("Runtime process stop failed"));
      }
    });
    this.stopping = operation;
    void operation.finally(() => {
      if (this.stopping === operation) this.stopping = undefined;
    }).catch(() => undefined);
    return operation;
  }

  public status(): RuntimeProcessStatus {
    return {
      running: this.running,
      ...(this.child?.pid === undefined ? {} : { pid: this.child.pid }),
    };
  }

  public onExit(listener: RuntimeProcessExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}

export { ProcessManager as RuntimeProcessManagerImpl };
