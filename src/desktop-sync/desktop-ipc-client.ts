import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  createDesktopIPCInitializeRequest,
  DESKTOP_IPC_PIPE_PATH,
  DesktopIPCFrameParser,
  parseDesktopIPCMessage,
  serializeDesktopIPCMessage,
  type DesktopIPCInitializeOptions,
  type DesktopIPCParsedMessage,
  type DesktopIPCRpcId,
} from "./desktop-ipc-protocol.js";

export interface DesktopIPCConnection {
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  write(data: string | Uint8Array): boolean;
  destroy(error?: Error): this;
}

export type DesktopIPCConnectionFactory = (options: { readonly path: string }) => DesktopIPCConnection;

export interface DesktopIPCClientOptions extends DesktopIPCInitializeOptions {
  readonly pipePath?: string;
  readonly reconnectDelayMs?: number;
  readonly connectTimeoutMs?: number;
  readonly createConnection?: DesktopIPCConnectionFactory;
}

export type DesktopIPCMessageListener = (message: DesktopIPCParsedMessage) => void;
export type DesktopIPCConnectionStateListener = (connected: boolean) => void;
export type DesktopIPCErrorListener = (error: Error) => void;

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

function errorOf(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}

function positiveMilliseconds(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer.`);
  return result;
}

const defaultConnection: DesktopIPCConnectionFactory = (options) => createConnection(options);

export class DesktopIPCClient {
  private readonly pipePath: string;
  private readonly reconnectDelayMs: number;
  private readonly connectTimeoutMs: number;
  private readonly initializeOptions: DesktopIPCInitializeOptions;
  private readonly connectionFactory: DesktopIPCConnectionFactory;
  private readonly messageListeners = new Set<DesktopIPCMessageListener>();
  private readonly connectionStateListeners = new Set<DesktopIPCConnectionStateListener>();
  private readonly errorListeners = new Set<DesktopIPCErrorListener>();
  private readonly frameParser = new DesktopIPCFrameParser();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connectTimer: NodeJS.Timeout | undefined;
  private socket: DesktopIPCConnection | undefined;
  private initializeRequestId: DesktopIPCRpcId | undefined;
  private running = false;
  private connectedState = false;

  public constructor(options: DesktopIPCClientOptions = {}) {
    this.pipePath = options.pipePath ?? DESKTOP_IPC_PIPE_PATH;
    if (this.pipePath.trim() === "") throw new Error("Desktop IPC pipe path is required.");
    this.reconnectDelayMs = positiveMilliseconds(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS, "reconnectDelayMs");
    this.connectTimeoutMs = positiveMilliseconds(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, "connectTimeoutMs");
    this.initializeOptions = {
      ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
      ...(options.clientType === undefined ? {} : { clientType: options.clientType }),
      ...(options.clientName === undefined ? {} : { clientName: options.clientName }),
      ...(options.clientVersion === undefined ? {} : { clientVersion: options.clientVersion }),
    };
    this.connectionFactory = options.createConnection ?? defaultConnection;
  }

  public get pipe(): string {
    return this.pipePath;
  }

  public get connected(): boolean {
    return this.connectedState;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  public stop(): void {
    this.running = false;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearConnectTimer();
    this.frameParser.reset();
    this.initializeRequestId = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (this.connectedState) {
      this.connectedState = false;
      this.notifyConnectionState(false);
    }
    socket?.destroy();
  }

  public onMessage(listener: DesktopIPCMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  public onConnectionStateChanged(listener: DesktopIPCConnectionStateListener): () => void {
    this.connectionStateListeners.add(listener);
    return () => this.connectionStateListeners.delete(listener);
  }

  public onError(listener: DesktopIPCErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private connect(): void {
    if (!this.running || this.socket !== undefined) return;
    let socket: DesktopIPCConnection;
    try {
      socket = this.connectionFactory({ path: this.pipePath });
    } catch (error: unknown) {
      this.reportError(errorOf(error, "Desktop IPC connection failed."));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.frameParser.reset();
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      const error = new Error(`Desktop IPC connection timed out: ${this.pipePath}`);
      this.reportError(error);
      this.disconnect(socket);
      socket.destroy();
    }, this.connectTimeoutMs);

    socket.once("connect", () => {
      if (this.socket !== socket || !this.running) return;
      this.clearConnectTimer();
      this.connectedState = true;
      this.notifyConnectionState(true);
      try {
        const id = randomUUID();
        this.initializeRequestId = id;
        socket.write(serializeDesktopIPCMessage(createDesktopIPCInitializeRequest(id, this.initializeOptions)));
      } catch (error: unknown) {
        this.reportError(errorOf(error, "Desktop IPC initialize handshake failed."));
        this.disconnect(socket);
        socket.destroy();
      }
    });
    socket.on("data", (chunk: Buffer | Uint8Array | string) => this.handleData(socket, chunk));
    socket.once("error", (error: unknown) => {
      if (this.socket !== socket) return;
      this.reportError(errorOf(error, "Desktop IPC connection failed."));
      this.disconnect(socket);
      socket.destroy();
    });
    socket.once("end", () => {
      if (this.socket !== socket) return;
      this.disconnect(socket);
      socket.destroy();
    });
    socket.once("close", () => this.disconnect(socket));
  }

  private handleData(socket: DesktopIPCConnection, chunk: Buffer | Uint8Array | string): void {
    if (this.socket !== socket) return;
    let frames: string[];
    try {
      frames = this.frameParser.push(chunk);
    } catch (error: unknown) {
      this.reportError(errorOf(error, "Desktop IPC frame parsing failed."));
      this.frameParser.reset();
      return;
    }
    for (const frame of frames) {
      let message: DesktopIPCParsedMessage | undefined;
      try {
        message = parseDesktopIPCMessage(frame);
      } catch (error: unknown) {
        this.reportError(errorOf(error, "Desktop IPC message parsing failed."));
        continue;
      }
      if (message === undefined) {
        continue;
      }
      if (message.kind === "response") {
        if (this.initializeRequestId === undefined || message.id !== this.initializeRequestId) continue;
        this.initializeRequestId = undefined;
        if (message.error !== undefined) {
          const reason = typeof message.error === "string" ? message.error : message.error.message;
          this.reportError(new Error(`Desktop IPC initialize failed: ${reason}`));
          this.disconnect(socket);
          socket.destroy();
          continue;
        }
      }
      this.notifyMessage(message);
    }
  }

  private disconnect(socket: DesktopIPCConnection): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.clearConnectTimer();
    this.frameParser.reset();
    this.initializeRequestId = undefined;
    if (this.connectedState) {
      this.connectedState = false;
      this.notifyConnectionState(false);
    }
    if (this.running) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== undefined) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.reconnectDelayMs);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer === undefined) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  private notifyMessage(message: DesktopIPCParsedMessage): void {
    for (const listener of this.messageListeners) {
      try {
        listener(message);
      } catch (error: unknown) {
        this.reportError(errorOf(error, "Desktop IPC message listener failed."));
      }
    }
  }

  private notifyConnectionState(connected: boolean): void {
    for (const listener of this.connectionStateListeners) {
      try {
        listener(connected);
      } catch (error: unknown) {
        this.reportError(errorOf(error, "Desktop IPC connection listener failed."));
      }
    }
  }

  private reportError(error: Error): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        // Diagnostics must not affect reconnect or observation.
      }
    }
  }
}
