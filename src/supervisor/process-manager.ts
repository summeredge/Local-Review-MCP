import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
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
    if (this.running) return Promise.resolve(this.status());
    if (this.starting !== undefined) return this.starting;

    const promise = new Promise<RuntimeProcessStatus>((resolve, reject) => {
      let child: ChildProcess | undefined;
      let settled = false;
      let exited = false;

      const clear = (): void => {
        if (this.child === child) {
          this.child = undefined;
          this.running = false;
        }
        if (this.cancelStarting !== undefined) this.cancelStarting = undefined;
      };
      const fail = (): void => {
        if (settled) return;
        settled = true;
        clear();
        reject(new Error("Runtime process failed to start"));
      };
      const markExited = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (exited) return;
        exited = true;
        if (this.child === child) {
          this.child = undefined;
          this.running = false;
          const exit: RuntimeProcessExit = { code, signal };
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
          stdio: "ignore",
          ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
        };
        child = this.spawnProcess(this.command, this.args, spawnOptions);
        this.child = child;
        child.once("spawn", started);
        child.once("error", fail);
        child.once("exit", markExited);
        child.once("close", (code, signal) => markExited(code, signal));
      } catch {
        fail();
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

  public async stop(): Promise<void> {
    this.cancelStarting?.();
    this.cancelStarting = undefined;
    const child = this.child;
    this.child = undefined;
    this.running = false;
    if (child !== undefined && !child.killed) child.kill();
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
