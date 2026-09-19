import {
  DesktopIPCClient,
  type DesktopIPCClientOptions,
  type DesktopIPCErrorListener,
  type DesktopIPCMessageListener,
  type DesktopIPCConnectionStateListener,
} from "./desktop-ipc-client.js";
import type { DesktopIPCParsedMessage } from "./desktop-ipc-protocol.js";
import {
  DesktopSyncStateStore,
  type DesktopSyncState,
  type DesktopSyncStateListener,
} from "./desktop-sync-state.js";

export interface DesktopIPCObserverLogger {
  readonly info?: (message: string) => void;
  readonly warn?: (message: string, error?: Error) => void;
  readonly error?: (message: string, error?: Error) => void;
}

export interface DesktopIPCClientLike {
  start(): void;
  stop(): void;
  onMessage(listener: DesktopIPCMessageListener): () => void;
  onConnectionStateChanged(listener: DesktopIPCConnectionStateListener): () => void;
  onError(listener: DesktopIPCErrorListener): () => void;
}

export interface DesktopIPCObserverOptions {
  readonly client?: DesktopIPCClientLike;
  readonly clientOptions?: DesktopIPCClientOptions;
  readonly logger?: DesktopIPCObserverLogger;
  readonly now?: () => string;
}

const defaultLogger: DesktopIPCObserverLogger = {
  info: (message) => console.info(message),
  warn: (message, error) => console.warn(message, error?.message ?? ""),
  error: (message, error) => console.error(message, error?.message ?? ""),
};

export class DesktopIPCObserver {
  private readonly client: DesktopIPCClientLike;
  private readonly state: DesktopSyncStateStore;
  private readonly logger: DesktopIPCObserverLogger;
  private readonly unsubscribe: Array<() => void>;
  private started = false;

  public constructor(options: DesktopIPCObserverOptions = {}) {
    this.client = options.client ?? new DesktopIPCClient(options.clientOptions);
    this.state = new DesktopSyncStateStore(options.now);
    this.logger = options.logger ?? defaultLogger;
    this.unsubscribe = [
      this.client.onMessage((message) => this.handleMessage(message)),
      this.client.onConnectionStateChanged((connected) => this.state.setConnected(connected)),
      this.client.onError((error) => this.handleError(error)),
    ];
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.client.start();
  }

  public stop(): void {
    if (!this.started) {
      this.client.stop();
      this.state.setConnected(false);
      return;
    }
    this.started = false;
    this.client.stop();
    this.state.setConnected(false);
  }

  public getState(): DesktopSyncState {
    return this.state.getState();
  }

  public onStateChanged(callback: DesktopSyncStateListener): () => void {
    return this.state.onStateChanged(callback);
  }

  public dispose(): void {
    this.stop();
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }

  private handleMessage(message: DesktopIPCParsedMessage): void {
    if (message.kind === "broadcast") {
      this.state.applyEvent(message);
      return;
    }
    if (message.kind === "response") {
      if (message.error !== undefined) {
        if (message.method === "initialize") {
          const reason = typeof message.error === "string" ? message.error : message.error.message;
          this.logger.warn?.("Desktop IPC initialize response contained an error.", new Error(reason));
        }
        return;
      }
      this.state.applyInitializeResult(message.result);
    }
  }

  private handleError(error: Error): void {
    this.logger.warn?.("Desktop IPC message or connection was ignored.", error);
  }
}

export interface DesktopIPCDiagnosticOptions {
  readonly observer?: DesktopIPCObserver;
  readonly output?: (line: string) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

function stateOutput(state: DesktopSyncState): Record<string, unknown> {
  return {
    connected: state.connected,
    currentConversationId: state.currentConversationId ?? null,
    following: state.currentConversationId === undefined
      ? null
      : state.followingThreads.has(state.currentConversationId),
    followingThreads: [...state.followingThreads].sort(),
    ownerClientId: state.ownerClientId ?? null,
    lastEventTime: state.lastEventTime ?? null,
  };
}

function valueFor(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function parseDiagnosticArgs(argv: readonly string[]): {
  readonly watch: boolean;
  readonly waitMs: number;
  readonly pipePath?: string;
} {
  let watch = false;
  let waitMs = 1_000;
  let pipePath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--watch") {
      watch = true;
      continue;
    }
    if (argument === "--once") continue;
    if (argument === "--wait-ms") {
      const value = Number(valueFor(argv, index, argument));
      if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
        throw new Error("--wait-ms must be an integer between 0 and 60000.");
      }
      waitMs = value;
      index += 1;
      continue;
    }
    if (argument === "--pipe") {
      pipePath = valueFor(argv, index, argument);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { watch, waitMs, ...(pipePath === undefined ? {} : { pipePath }) };
}

export async function runDesktopIPCDiagnostic(
  argv: readonly string[] = [],
  options: DesktopIPCDiagnosticOptions = {},
): Promise<void> {
  const args = parseDiagnosticArgs(argv);
  const output = options.output ?? console.log;
  const observer = options.observer ?? new DesktopIPCObserver({
    clientOptions: args.pipePath === undefined ? undefined : { pipePath: args.pipePath },
  });
  const print = (event: string, state: DesktopSyncState): void => {
    output(JSON.stringify({ event, ...stateOutput(state) }));
  };
  const unsubscribe = observer.onStateChanged((state) => print("state-changed", state));
  observer.start();
  print("initial", observer.getState());

  if (args.watch) {
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } else {
    await (options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    })))(args.waitMs);
  }
  observer.stop();
  unsubscribe();
}
