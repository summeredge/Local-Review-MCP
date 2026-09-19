import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type {
  DesktopIPCConnection,
  DesktopIPCConnectionFactory,
} from "./desktop-ipc-client.js";
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

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_MS = 1_000;
const CLIENT_TYPE = "local-review-mcp-desktop-thread-visibility-diagnostic";

type JsonRecord = Record<string, unknown>;
export type DesktopThreadVisibilityDiagnosticLine = Readonly<Record<string, unknown>>;
export type DesktopThreadVisibilityDiagnosticLineListener =
  (line: DesktopThreadVisibilityDiagnosticLine) => void;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function safeId(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || value.length > 512) return undefined;
  if (/\b(?:bearer|basic)\s+\S+/iu.test(value)
    || /(?:authorization|cookie|oauth|token|password|secret)\s*[:=]/iu.test(value)) {
    return undefined;
  }
  return value;
}

const SENSITIVE_KEY = /(?:authorization|bearer|cookie|credential|oauth|token|password|secret|api[-_]?key|prompt|text|content|body|message|user[-_]?input|assistant[-_]?message)/iu;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function safeShape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  if (depth >= 8) return Array.isArray(value) ? { type: "array", truncated: true } : "object";
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      ...(value.length === 0 ? {} : { items: safeShape(value[0], depth + 1) }),
    };
  }
  const shaped: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isSensitiveKey(key)) shaped[key] = safeShape(child, depth + 1);
  }
  return shaped;
}

interface SafeFields {
  requestId?: string | number;
  conversationId?: string;
  currentConversationId?: string;
  threadId?: string;
  sourceClientId?: string;
  ownerClientId?: string;
  following?: boolean;
  event?: string;
  method?: string;
  type?: string;
  version?: number;
}

const SAFE_FIELD_NAMES: Readonly<Record<string, keyof SafeFields>> = {
  requestId: "requestId",
  request_id: "requestId",
  conversationId: "conversationId",
  conversation_id: "conversationId",
  currentConversationId: "currentConversationId",
  current_conversation_id: "currentConversationId",
  threadId: "threadId",
  thread_id: "threadId",
  sourceClientId: "sourceClientId",
  source_client_id: "sourceClientId",
  ownerClientId: "ownerClientId",
  owner_client_id: "ownerClientId",
  following: "following",
  isFollowing: "following",
  is_following: "following",
  event: "event",
  eventName: "event",
  method: "method",
  type: "type",
  version: "version",
};

function safeString(value: unknown): string | undefined {
  const result = safeId(value);
  return typeof result === "string" ? result : undefined;
}

function putSafeField(fields: SafeFields, name: keyof SafeFields, value: unknown): void {
  if (fields[name] !== undefined) return;
  if (name === "following") {
    if (typeof value === "boolean") fields.following = value;
    return;
  }
  if (name === "version") {
    if (typeof value === "number" && Number.isSafeInteger(value)) fields.version = value;
    return;
  }
  if (name === "requestId") {
    const id = safeId(value);
    if (id !== undefined) fields.requestId = id;
    return;
  }
  const text = safeString(value);
  if (text !== undefined) fields[name] = text as never;
}

function collectSafeFields(value: unknown, fields: SafeFields, depth = 0): void {
  if (depth >= 8) return;
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 128)) collectSafeFields(child, fields, depth + 1);
    return;
  }
  const source = record(value);
  if (source === undefined) return;
  for (const [key, child] of Object.entries(source)) {
    const safeName = SAFE_FIELD_NAMES[key];
    if (safeName !== undefined) putSafeField(fields, safeName, child);
  }
  for (const [key, child] of Object.entries(source)) {
    if (!isSensitiveKey(key)) collectSafeFields(child, fields, depth + 1);
  }
}

function fieldsFromMessage(raw: JsonRecord, parsed: DesktopIPCParsedMessage | undefined): SafeFields {
  const fields: SafeFields = {};
  collectSafeFields(raw, fields);
  if (parsed === undefined) return fields;
  switch (parsed.kind) {
    case "broadcast":
      putSafeField(fields, "event", parsed.event);
      putSafeField(fields, "method", parsed.event);
      putSafeField(fields, "sourceClientId", parsed.sourceClientId);
      putSafeField(fields, "currentConversationId", parsed.currentConversationId);
      putSafeField(fields, "conversationId", parsed.conversationId);
      putSafeField(fields, "threadId", parsed.threadId);
      putSafeField(fields, "following", parsed.following);
      putSafeField(fields, "ownerClientId", parsed.ownerClientId);
      break;
    case "response":
      putSafeField(fields, "requestId", parsed.id);
      putSafeField(fields, "method", parsed.method);
      break;
    case "request":
      putSafeField(fields, "requestId", parsed.id);
      putSafeField(fields, "method", parsed.method);
      putSafeField(fields, "sourceClientId", parsed.sourceClientId);
      break;
    case "notification":
      putSafeField(fields, "method", parsed.method);
      break;
  }
  return fields;
}

function structuralKind(raw: JsonRecord): "request" | "response" | "notification" | "broadcast" | "unknown" {
  const type = typeof raw.type === "string" ? raw.type : undefined;
  if (type === "response") return "response";
  if (type === "request") return "request";
  if (type === "notification") return "notification";
  if (type === "broadcast" || type === "event") return "broadcast";
  const hasId = raw.requestId !== undefined || raw.id !== undefined;
  if (hasId && typeof raw.method === "string") return "request";
  if (typeof raw.method === "string") return "notification";
  return "unknown";
}

function hasOwn(source: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function safeKeys(source: JsonRecord): string[] {
  return Object.keys(source).filter((key) => !isSensitiveKey(key));
}

function targetThreadMatch(fields: SafeFields, targetThreadId: string | undefined): boolean | undefined {
  if (targetThreadId === undefined) return undefined;
  return [fields.threadId, fields.conversationId, fields.currentConversationId]
    .some((value) => value === targetThreadId);
}

function valueFor(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

export interface DesktopThreadVisibilityDiagnosticArgs {
  readonly watch: boolean;
  readonly waitMs: number;
  readonly pipePath?: string;
  readonly threadId?: string;
}

export function parseDesktopThreadVisibilityDiagnosticArgs(
  argv: readonly string[] = [],
): DesktopThreadVisibilityDiagnosticArgs {
  let watch = false;
  let waitMs = DEFAULT_WAIT_MS;
  let pipePath: string | undefined;
  let threadId: string | undefined;
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
    if (argument === "--thread") {
      const value = valueFor(argv, index, argument).trim();
      if (value === "") throw new Error("--thread requires a non-empty value.");
      threadId = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return {
    watch,
    waitMs,
    ...(pipePath === undefined ? {} : { pipePath }),
    ...(threadId === undefined ? {} : { threadId }),
  };
}

export interface DesktopThreadVisibilityDiagnosticClientOptions extends DesktopIPCInitializeOptions {
  readonly pipePath?: string;
  readonly targetThreadId?: string;
  readonly reconnectDelayMs?: number;
  readonly connectTimeoutMs?: number;
  readonly createConnection?: DesktopIPCConnectionFactory;
  readonly now?: () => string;
}

const defaultConnection: DesktopIPCConnectionFactory = ({ path }) => createConnection({ path });

function positiveMilliseconds(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer.`);
  return result;
}

export class DesktopThreadVisibilityDiagnosticClient {
  private readonly pipePath: string;
  private readonly targetThreadId: string | undefined;
  private readonly reconnectDelayMs: number;
  private readonly connectTimeoutMs: number;
  private readonly initializeOptions: DesktopIPCInitializeOptions;
  private readonly connectionFactory: DesktopIPCConnectionFactory;
  private readonly now: () => string;
  private readonly listeners = new Set<DesktopThreadVisibilityDiagnosticLineListener>();
  private readonly frameParser = new DesktopIPCFrameParser();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connectTimer: NodeJS.Timeout | undefined;
  private socket: DesktopIPCConnection | undefined;
  private initializeRequestId: DesktopIPCRpcId | undefined;
  private running = false;
  private hasConnectedBefore = false;

  public constructor(options: DesktopThreadVisibilityDiagnosticClientOptions = {}) {
    this.pipePath = options.pipePath ?? DESKTOP_IPC_PIPE_PATH;
    if (this.pipePath.trim() === "") throw new Error("Desktop IPC pipe path is required.");
    this.targetThreadId = options.targetThreadId?.trim() || undefined;
    this.reconnectDelayMs = positiveMilliseconds(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS, "reconnectDelayMs");
    this.connectTimeoutMs = positiveMilliseconds(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, "connectTimeoutMs");
    this.initializeOptions = {
      clientId: options.clientId?.trim() || `${CLIENT_TYPE}-${randomUUID()}`,
      clientType: options.clientType?.trim() || CLIENT_TYPE,
      ...(options.clientName === undefined ? {} : { clientName: options.clientName }),
      ...(options.clientVersion === undefined ? {} : { clientVersion: options.clientVersion }),
    };
    this.connectionFactory = options.createConnection ?? defaultConnection;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public onLine(listener: DesktopThreadVisibilityDiagnosticLineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    const socket = this.socket;
    if (socket !== undefined) {
      this.disconnect(socket);
      socket.destroy();
    }
    this.frameParser.reset();
    this.initializeRequestId = undefined;
    this.hasConnectedBefore = false;
  }

  private connect(): void {
    if (!this.running || this.socket !== undefined) return;
    let socket: DesktopIPCConnection;
    try {
      socket = this.connectionFactory({ path: this.pipePath });
    } catch {
      this.emitLifecycle("disconnected");
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.frameParser.reset();
    this.connectTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      this.disconnect(socket);
      socket.destroy();
    }, this.connectTimeoutMs);

    socket.once("connect", () => {
      if (this.socket !== socket || !this.running) return;
      this.clearConnectTimer();
      this.emitLifecycle(this.hasConnectedBefore ? "reconnected" : "connected");
      this.hasConnectedBefore = true;
      this.writeInitialize(socket);
    });
    socket.on("data", (chunk: Buffer | Uint8Array | string) => this.handleData(socket, chunk));
    socket.once("error", () => {
      if (this.socket !== socket) return;
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

  private writeInitialize(socket: DesktopIPCConnection): void {
    const requestId = randomUUID();
    this.initializeRequestId = requestId;
    const request = createDesktopIPCInitializeRequest(requestId, this.initializeOptions);
    try {
      socket.write(serializeDesktopIPCMessage(request));
      this.observeMessage("out", request);
    } catch {
      this.disconnect(socket);
      socket.destroy();
    }
  }

  private handleData(socket: DesktopIPCConnection, chunk: Buffer | Uint8Array | string): void {
    if (this.socket !== socket) return;
    let frames: string[];
    try {
      frames = this.frameParser.push(chunk);
    } catch {
      this.frameParser.reset();
      return;
    }
    for (const frame of frames) {
      let value: unknown;
      try {
        value = JSON.parse(frame) as unknown;
      } catch {
        this.emit({ event: "protocol-error", reason: "invalid-json" });
        continue;
      }
      const message = record(value);
      if (message === undefined) {
        this.emit({ event: "protocol-error", reason: "non-object-message" });
        continue;
      }
      this.observeMessage("in", message);
    }
  }

  private observeMessage(direction: "in" | "out", raw: JsonRecord): void {
    let parsed: DesktopIPCParsedMessage | undefined;
    try {
      parsed = parseDesktopIPCMessage(raw);
    } catch {
      parsed = undefined;
    }
    const kind = parsed?.kind ?? structuralKind(raw);
    const fields = fieldsFromMessage(raw, parsed);
    const messageEvent = parsed?.kind === "broadcast" ? parsed.event : undefined;
    const line: JsonRecord = {
      event: messageEvent ?? "ipc-message",
      recordType: "ipc-message",
      direction,
      kind,
      type: fields.type ?? kind,
      keys: safeKeys(raw),
      ...(fields.method === undefined ? {} : { method: fields.method }),
      ...(fields.event === undefined ? {} : { protocolEvent: fields.event }),
      ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
      ...(fields.conversationId === undefined ? {} : { conversationId: fields.conversationId }),
      ...(fields.currentConversationId === undefined ? {} : { currentConversationId: fields.currentConversationId }),
      ...(fields.threadId === undefined ? {} : { threadId: fields.threadId }),
      ...(fields.following === undefined ? {} : { following: fields.following }),
      ...(fields.sourceClientId === undefined ? {} : { sourceClientId: fields.sourceClientId }),
      ...(fields.ownerClientId === undefined ? {} : { ownerClientId: fields.ownerClientId }),
      ...(fields.version === undefined ? {} : { version: fields.version }),
      ...(hasOwn(raw, "params") ? { paramsShape: safeShape(raw.params) } : {}),
      ...(hasOwn(raw, "result") ? { resultShape: safeShape(raw.result) } : {}),
      ...(hasOwn(raw, "error") ? { errorShape: safeShape(raw.error) } : {}),
    };
    const targetMatch = targetThreadMatch(fields, this.targetThreadId);
    if (targetMatch !== undefined) line.targetThreadMatch = targetMatch;
    this.emit(line);

    if (direction !== "in" || this.initializeRequestId === undefined) return;
    const responseId = raw.requestId ?? raw.id;
    if (responseId !== this.initializeRequestId || kind !== "response") return;
    const hasError = raw.resultType === "error" || hasOwn(raw, "error") || parsed?.kind === "response" && parsed.error !== undefined;
    const requestId = this.initializeRequestId;
    this.initializeRequestId = undefined;
    if (hasError) {
      const socket = this.socket;
      if (socket !== undefined) {
        this.disconnect(socket);
        socket.destroy();
      }
      return;
    }
    this.emitLifecycle("initialized", { requestId });
  }

  private disconnect(socket: DesktopIPCConnection): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.clearConnectTimer();
    this.frameParser.reset();
    this.initializeRequestId = undefined;
    this.emitLifecycle("disconnected");
    this.scheduleReconnect();
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

  private emitLifecycle(event: "connected" | "reconnected" | "initialized" | "disconnected", fields: JsonRecord = {}): void {
    this.emit({ event, ...fields });
  }

  private emit(line: JsonRecord): void {
    const output = { timestamp: this.now(), ...line };
    for (const listener of this.listeners) {
      try {
        listener(output);
      } catch {
        // A diagnostic sink must not affect the pipe or reconnect loop.
      }
    }
  }
}

export interface DesktopThreadVisibilityDiagnosticOptions {
  readonly client?: DesktopThreadVisibilityDiagnosticClient;
  readonly output?: (line: string) => void;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

function waitForSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (): void => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export async function runDesktopThreadVisibilityDiagnostic(
  argv: readonly string[] = [],
  options: DesktopThreadVisibilityDiagnosticOptions = {},
): Promise<void> {
  const args = parseDesktopThreadVisibilityDiagnosticArgs(argv);
  const output = options.output ?? console.log;
  const client = options.client ?? new DesktopThreadVisibilityDiagnosticClient({
    pipePath: args.pipePath,
    targetThreadId: args.threadId,
  });
  const unsubscribe = client.onLine((line) => output(JSON.stringify(line)));
  client.start();
  try {
    if (args.watch) {
      await waitForSignal();
    } else {
      await (options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      })))(args.waitMs);
    }
  } finally {
    client.stop();
    unsubscribe();
  }
}
