import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { resolve } from "node:path";
import {
  resolveCodexExecutable,
} from "../../control-plane/codex-execution-adapter.js";
import {
  codexVersionFromUserAgent,
  parseInitializeResult,
  parseModelListPage,
  parseThreadStartResult,
  parseTurnStartResult,
  type AppServerInitializeResult,
  type AppServerModel,
  type AppServerThread,
  type AppServerTurn,
  type CodexAppServerClientOptions,
  type CodexAppServerExit,
  type CodexAppServerProcessInfo,
  type StartThreadInput,
  type StartTurnInput,
} from "./models.js";
import {
  CodexAppServerProtocolError,
  CodexAppServerRpcError,
  isRpcRequest,
  isRpcResponse,
  parseRpcLine,
  serializeRpc,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.js";
import {
  parseCodexAppServerNotification,
  type CodexAppServerEvent,
} from "./events.js";

const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
const FORCE_CLOSE_TIMEOUT_MS = 2_000;
const MAX_CAPTURE_CHARS = 1_000_000;

interface PendingRequest {
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: Error | null = null;

  public push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  public close(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error ?? null;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (this.failure !== null) waiter.reject(this.failure);
      else waiter.resolve({ done: true, value: undefined as never });
    }
  }

  public next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined as never });
    return new Promise<IteratorResult<T>>((resolveNext, rejectNext) => {
      this.waiters.push({ resolve: resolveNext, reject: rejectNext });
    });
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

function appendCapture(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_CAPTURE_CHARS ? next : next.slice(-MAX_CAPTURE_CHARS);
}

function exitError(exit: CodexAppServerExit): Error {
  return new Error(
    `Codex app-server exited before completion (code=${exit.exit_code ?? "null"}, signal=${exit.signal ?? "none"}).`,
  );
}

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly requestTimeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly onStderr?: (chunk: string) => void;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly eventQueue = new AsyncEventQueue<CodexAppServerEvent>();
  private readonly exitPromise: Promise<CodexAppServerExit>;
  private resolveExit!: (exit: CodexAppServerExit) => void;
  private requestId = 0;
  private stdout = "";
  private stderr = "";
  private exit: CodexAppServerExit | null = null;
  private closePromise: Promise<CodexAppServerExit> | null = null;
  private initialized: AppServerInitializeResult | null = null;
  private initializePromise: Promise<AppServerInitializeResult> | null = null;
  private failed: Error | null = null;
  private closing = false;
  private processState: CodexAppServerProcessInfo;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: CodexAppServerClientOptions,
    executable: string,
  ) {
    this.child = child;
    this.cwd = resolve(options.cwd);
    this.environment = { ...process.env, ...(options.environment ?? {}) };
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.clientName = options.clientName ?? "local-review-mcp-codex-app-server-prototype";
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.onStderr = options.onStderr;
    this.processState = {
      process_id: typeof child.pid === "number" && child.pid > 0 ? child.pid : 0,
      codex_version: "unknown",
      transport: "stdio",
      status: "starting",
    };
    this.exitPromise = new Promise<CodexAppServerExit>((resolveExit) => {
      this.resolveExit = resolveExit;
    });

    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.stderr = appendCapture(this.stderr, text);
      this.onStderr?.(text);
    });
    child.once("error", (error) => {
      if (!this.closing) this.fail(error);
    });
    child.once("close", (code, signal) => {
      const exit: CodexAppServerExit = {
        process_id: this.processState.process_id,
        exit_code: code,
        signal,
        stdout: this.stdout,
        stderr: this.stderr,
      };
      this.exit = exit;
      this.resolveExit(exit);
      if (!this.closing) {
        this.fail(exitError(exit));
      }
    });

    if (executable.trim() === "") throw new Error("Codex app-server executable is empty.");
  }

  public static async start(options: CodexAppServerClientOptions): Promise<CodexAppServerClient> {
    const cwd = resolve(options.cwd);
    const executable = resolveCodexExecutable({
      codexExecutable: options.executable,
      environment: options.environment,
    });
    const environment = { ...process.env, ...(options.environment ?? {}) };
    const child = spawn(executable, [...APP_SERVER_ARGS], {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new CodexAppServerClient(child, { ...options, cwd }, executable);
    try {
      await client.waitForSpawn();
      return client;
    } catch (error: unknown) {
      await client.close().catch(() => undefined);
      throw new Error(`Codex app-server could not start: ${errorMessage(error)}`, { cause: error });
    }
  }

  public get processInfo(): CodexAppServerProcessInfo {
    return { ...this.processState };
  }

  public get capturedStdout(): string {
    return this.stdout;
  }

  public get capturedStderr(): string {
    return this.stderr;
  }

  public events(): AsyncIterable<CodexAppServerEvent> {
    return this.eventQueue;
  }

  public initialize(): Promise<AppServerInitializeResult> {
    if (this.initialized !== null) return Promise.resolve(this.initialized);
    this.initializePromise ??= this.initializeOnce().catch((error: unknown) => {
      this.fail(error);
      throw error;
    });
    return this.initializePromise;
  }

  public async listModels(): Promise<readonly AppServerModel[]> {
    await this.initialize();
    const models: AppServerModel[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = parseModelListPage(await this.request<unknown>(
        "model/list",
        cursor === undefined ? {} : { cursor },
      ));
      models.push(...page.models);
      if (page.next_cursor === null) return models;
      if (page.next_cursor === cursor) throw new Error("Codex app-server model/list cursor did not advance.");
      cursor = page.next_cursor;
    }
  }

  public async startThread(input: StartThreadInput = {}): Promise<AppServerThread> {
    await this.initialize();
    const params: Record<string, unknown> = { cwd: resolve(input.cwd ?? this.cwd) };
    if (input.model?.trim() !== undefined && input.model.trim() !== "") params.model = input.model.trim();
    return parseThreadStartResult(await this.request<unknown>("thread/start", params));
  }

  public async startTurn(input: StartTurnInput): Promise<AppServerTurn> {
    await this.initialize();
    if (input.threadId.trim() === "") throw new Error("threadId is required.");
    if (input.text.trim() === "") throw new Error("turn text is required.");
    const params: Record<string, unknown> = {
      threadId: input.threadId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
    };
    if (input.model?.trim() !== undefined && input.model.trim() !== "") params.model = input.model.trim();
    if (input.effort?.trim() !== undefined && input.effort.trim() !== "") params.effort = input.effort.trim();
    return parseTurnStartResult(await this.request<unknown>("turn/start", params));
  }

  public close(): Promise<CodexAppServerExit> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async initializeOnce(): Promise<AppServerInitializeResult> {
    const initialized = parseInitializeResult(await this.request<unknown>("initialize", {
      clientInfo: {
        name: this.clientName,
        title: "Local Review MCP",
        version: this.clientVersion,
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    }));
    this.sendNotification({ method: "initialized" });
    this.initialized = initialized;
    this.processState = {
      ...this.processState,
      codex_version: codexVersionFromUserAgent(initialized.user_agent),
      status: "ready",
    };
    return initialized;
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    this.ensureUsable();
    const id = this.requestId++;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Codex app-server request timed out: ${method}.`));
      }, this.requestTimeoutMs);
      const pending: PendingRequest = {
        timer,
        resolve: (value) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolveRequest(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending.delete(id);
          rejectRequest(error);
        },
      };
      this.pending.set(id, pending);
      try {
        this.write({
          id,
          method,
          ...(params === undefined ? {} : { params }),
        });
      } catch (error: unknown) {
        pending.reject(error);
      }
    });
  }

  private sendNotification(notification: RpcNotification): void {
    this.ensureUsable();
    this.write(notification);
  }

  private write(message: RpcRequest | RpcNotification | RpcResponse): void {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      throw new Error("Codex app-server stdin is closed.");
    }
    this.child.stdin.write(serializeRpc(message));
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    this.stdout = appendCapture(this.stdout, `${line}\n`);
    try {
      const message = parseRpcLine(line);
      this.handleMessage(message);
    } catch (error: unknown) {
      this.fail(error);
    }
  }

  private handleMessage(message: RpcMessage): void {
    if (isRpcResponse(message)) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) throw new CodexAppServerProtocolError("Unexpected Codex app-server response id.");
      if (message.error !== undefined) {
        pending.reject(new CodexAppServerRpcError(message.error.code, message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (isRpcRequest(message)) {
      this.write({
        id: message.id,
        error: { code: -32601, message: "Prototype does not handle server requests." },
      });
      return;
    }
    const event = parseCodexAppServerNotification(message);
    if (event !== undefined) this.eventQueue.push(event);
  }

  private fail(error: unknown): void {
    if (this.failed !== null) return;
    this.failed = error instanceof Error ? error : new Error(errorMessage(error));
    this.processState = { ...this.processState, status: "failed" };
    for (const pending of this.pending.values()) pending.reject(this.failed);
    this.eventQueue.close(this.failed);
  }

  private ensureUsable(): void {
    if (this.failed !== null) throw this.failed;
    if (this.closing || this.processState.status === "stopped") {
      throw new Error("Codex app-server client is closed.");
    }
  }

  private waitForSpawn(): Promise<void> {
    return new Promise<void>((resolveSpawn, rejectSpawn) => {
      const onSpawn = (): void => {
        const processId = this.child.pid;
        if (typeof processId !== "number" || !Number.isInteger(processId) || processId <= 0) {
          this.child.removeListener("error", onError);
          rejectSpawn(new Error("Codex app-server started without a valid process id."));
          return;
        }
        this.processState = {
          ...this.processState,
          process_id: processId,
        };
        this.child.removeListener("error", onError);
        resolveSpawn();
      };
      const onError = (error: Error): void => {
        this.child.removeListener("spawn", onSpawn);
        rejectSpawn(error);
      };
      this.child.once("spawn", onSpawn);
      this.child.once("error", onError);
    });
  }

  private async closeOnce(): Promise<CodexAppServerExit> {
    this.closing = true;
    if (this.processState.status !== "failed" && this.processState.status !== "stopped") {
      this.processState = { ...this.processState, status: "stopping" };
    }
    if (this.exit === null) {
      if (!this.child.stdin.writableEnded) this.child.stdin.end();
      await this.waitForExit(CLOSE_TIMEOUT_MS);
    }
    if (this.exit === null) {
      this.child.kill();
      await this.waitForExit(FORCE_CLOSE_TIMEOUT_MS);
    }
    const exit = this.exit ?? {
      process_id: this.processState.process_id,
      exit_code: null,
      signal: null,
      stdout: this.stdout,
      stderr: this.stderr,
    } satisfies CodexAppServerExit;
    this.lines.close();
    if (this.failed === null) this.processState = { ...this.processState, status: "stopped" };
    for (const pending of this.pending.values()) pending.reject(new Error("Codex app-server client closed."));
    this.eventQueue.close();
    return exit;
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    if (this.exit !== null) return;
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolveTimeout) => {
        const timer = setTimeout(resolveTimeout, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }
}
