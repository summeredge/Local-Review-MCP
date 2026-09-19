export const DESKTOP_IPC_PIPE_PATH = "\\\\.\\pipe\\codex-ipc" as const;
export const DESKTOP_IPC_INITIALIZE_METHOD = "initialize" as const;
export const DESKTOP_IPC_INITIALIZED_METHOD = "initialized" as const;
export const DESKTOP_IPC_MAX_FRAME_BYTES = 256 * 1024 * 1024;

export const DESKTOP_IPC_EVENT_NAMES = [
  "thread-stream-following-changed",
  "thread-stream-following-status-requested",
] as const;

export const DESKTOP_IPC_EVENT_VERSIONS: Readonly<Record<DesktopIPCEventName, number>> = {
  "thread-stream-following-changed": 1,
  "thread-stream-following-status-requested": 1,
};

export type DesktopIPCEventName = typeof DESKTOP_IPC_EVENT_NAMES[number];
export type DesktopIPCRpcId = number | string;

export interface DesktopIPCFollowingEvent {
  readonly kind: "broadcast";
  readonly event: DesktopIPCEventName;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sourceClientId?: string;
  readonly currentConversationId?: string;
  readonly conversationId?: string;
  readonly threadId?: string;
  readonly following?: boolean;
  readonly ownerClientId?: string;
}

export interface DesktopIPCResponse {
  readonly kind: "response";
  readonly id: DesktopIPCRpcId;
  readonly resultType?: "success" | "error";
  readonly method?: string;
  readonly handledByClientId?: string;
  readonly result?: unknown;
  readonly error?: string | {
    readonly code: number;
    readonly message: string;
  };
}

export interface DesktopIPCRequest {
  readonly kind: "request";
  readonly id: DesktopIPCRpcId;
  readonly sourceClientId?: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface DesktopIPCNotification {
  readonly kind: "notification";
  readonly method: string;
  readonly params?: unknown;
}

export type DesktopIPCParsedMessage =
  | DesktopIPCFollowingEvent
  | DesktopIPCResponse
  | DesktopIPCRequest
  | DesktopIPCNotification;

export class DesktopIPCProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DesktopIPCProtocolError";
  }
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rpcId(value: unknown): DesktopIPCRpcId | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))
    ? value
    : undefined;
}

function knownEvent(value: unknown): value is DesktopIPCEventName {
  return typeof value === "string"
    && (DESKTOP_IPC_EVENT_NAMES as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function firstString(
  sources: readonly Record<string, unknown>[],
  fields: readonly string[],
): string | undefined {
  for (const source of sources) {
    for (const field of fields) {
      const value = nonEmptyString(source[field]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function firstBoolean(
  sources: readonly Record<string, unknown>[],
  fields: readonly string[],
): boolean | undefined {
  for (const source of sources) {
    for (const field of fields) {
      if (typeof source[field] === "boolean") return source[field];
    }
  }
  return undefined;
}

function withoutKeys(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result = { ...source };
  for (const key of keys) delete result[key];
  return result;
}

function parseBroadcast(
  record: Record<string, unknown>,
  methodEvent?: DesktopIPCEventName,
): DesktopIPCFollowingEvent | undefined {
  const params = jsonRecord(record.params);
  const container = params ?? record;
  const nestedEvent = jsonRecord(container.event);
  const nestedContainer = nestedEvent ?? jsonRecord(container.broadcast) ?? container;
  const event = methodEvent
    ?? (knownEvent(nestedContainer.event) ? nestedContainer.event : undefined)
    ?? (knownEvent(nestedContainer.eventName) ? nestedContainer.eventName : undefined)
    ?? (knownEvent(nestedContainer.name) ? nestedContainer.name : undefined)
    ?? (knownEvent(nestedContainer.type) ? nestedContainer.type : undefined)
    ?? (knownEvent(record.event) ? record.event : undefined)
    ?? (knownEvent(record.eventName) ? record.eventName : undefined)
    ?? (knownEvent(record.type) ? record.type : undefined);
  if (event === undefined) return undefined;
  if (record.type === "broadcast"
    && record.version !== undefined
    && record.version !== DESKTOP_IPC_EVENT_VERSIONS[event]) return undefined;

  const explicitPayload = jsonRecord(nestedContainer.payload)
    ?? jsonRecord(nestedContainer.data)
    ?? jsonRecord(nestedContainer.body)
    ?? jsonRecord(nestedContainer.eventPayload);
  const payload = explicitPayload ?? withoutKeys(nestedContainer, [
    "event",
    "eventName",
    "name",
    "type",
    "payload",
    "data",
    "body",
    "eventPayload",
  ]);
  const nestedPayload = jsonRecord(payload.thread)
    ?? jsonRecord(payload.conversation)
    ?? jsonRecord(payload.threadInfo)
    ?? jsonRecord(payload.conversationInfo);
  const sources = [payload, ...(nestedPayload === undefined ? [] : [nestedPayload]), nestedContainer, record];

  return {
    kind: "broadcast",
    event,
    payload,
    ...(firstString(sources, ["sourceClientId", "source_client_id"]) === undefined
      ? {}
      : { sourceClientId: firstString(sources, ["sourceClientId", "source_client_id"]) }),
    ...(firstString(sources, ["currentConversationId", "current_conversation_id"]) === undefined
      ? {}
      : { currentConversationId: firstString(sources, ["currentConversationId", "current_conversation_id"]) }),
    ...(firstString(sources, ["conversationId", "conversation_id"]) === undefined
      ? {}
      : { conversationId: firstString(sources, ["conversationId", "conversation_id"]) }),
    ...(firstString(sources, ["threadId", "thread_id"]) === undefined
      ? {}
      : { threadId: firstString(sources, ["threadId", "thread_id"]) }),
    ...(firstBoolean(sources, ["following", "isFollowing", "is_following"]) === undefined
      ? {}
      : { following: firstBoolean(sources, ["following", "isFollowing", "is_following"]) }),
    ...(firstString(sources, ["ownerClientId", "owner_client_id", "sourceClientId", "source_client_id"]) === undefined
      ? {}
      : { ownerClientId: firstString(sources, ["ownerClientId", "owner_client_id", "sourceClientId", "source_client_id"]) }),
  };
}

function parseResponse(record: Record<string, unknown>): DesktopIPCResponse {
  const id = rpcId(record.requestId ?? record.id);
  if (id === undefined) throw new DesktopIPCProtocolError("Desktop IPC response has an invalid id.");
  const resultType = record.resultType === "success" || record.resultType === "error"
    ? record.resultType
    : undefined;
  const method = nonEmptyString(record.method);
  const handledByClientId = nonEmptyString(record.handledByClientId);
  if (record.type === "response") {
    if (resultType === "success") {
      return {
        kind: "response",
        id,
        resultType,
        ...(method === undefined ? {} : { method }),
        ...(handledByClientId === undefined ? {} : { handledByClientId }),
        result: record.result,
      };
    }
    if (resultType === "error") {
      const error = typeof record.error === "string"
        ? record.error
        : jsonRecord(record.error);
      if (typeof error === "string") return { kind: "response", id, resultType, ...(method === undefined ? {} : { method }), error };
      if (error !== undefined && typeof error.message === "string") {
        return {
          kind: "response",
          id,
          resultType,
          ...(method === undefined ? {} : { method }),
          error: { code: typeof error.code === "number" ? error.code : -1, message: error.message },
        };
      }
      throw new DesktopIPCProtocolError("Desktop IPC response has an invalid error.");
    }
    throw new DesktopIPCProtocolError("Desktop IPC response has an invalid result type.");
  }
  const hasResult = Object.prototype.hasOwnProperty.call(record, "result");
  const hasError = Object.prototype.hasOwnProperty.call(record, "error");
  if (hasResult === hasError) {
    throw new DesktopIPCProtocolError("Desktop IPC response must contain exactly one result or error.");
  }
  if (hasResult) return { kind: "response", id, result: record.result };

  const error = jsonRecord(record.error);
  if (error === undefined || typeof error.code !== "number" || typeof error.message !== "string") {
    throw new DesktopIPCProtocolError("Desktop IPC response has an invalid error.");
  }
  return { kind: "response", id, error: { code: error.code, message: error.message } };
}

export function parseDesktopIPCMessage(input: unknown): DesktopIPCParsedMessage | undefined {
  let value: unknown = input;
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    try {
      value = JSON.parse(input.toString()) as unknown;
    } catch {
      throw new DesktopIPCProtocolError("Desktop IPC emitted invalid JSON.");
    }
  }

  const record = jsonRecord(value);
  if (record === undefined) throw new DesktopIPCProtocolError("Desktop IPC emitted a non-object JSON message.");

  if (record.type === "response") return parseResponse(record);
  if (record.type === "broadcast") {
    const method = knownEvent(record.method) ? record.method : undefined;
    return parseBroadcast(record, method);
  }
  if (record.type === "request") {
    const id = rpcId(record.requestId ?? record.id);
    const method = nonEmptyString(record.method);
    if (id === undefined || method === undefined) {
      throw new DesktopIPCProtocolError("Desktop IPC request has an invalid id or method.");
    }
    return {
      kind: "request",
      id,
      method,
      ...(nonEmptyString(record.sourceClientId) === undefined ? {} : { sourceClientId: nonEmptyString(record.sourceClientId) }),
      ...(record.params === undefined ? {} : { params: record.params }),
    };
  }

  const id = rpcId(record.id);
  const method = typeof record.method === "string" ? record.method : undefined;
  if (method === undefined && id !== undefined && (
    Object.prototype.hasOwnProperty.call(record, "result")
    || Object.prototype.hasOwnProperty.call(record, "error")
  )) return parseResponse(record);

  if (method !== undefined) {
    if (method === "broadcast" || method === "desktop/broadcast" || method === "desktop.broadcast") {
      return parseBroadcast(record);
    }
    if (knownEvent(method)) return parseBroadcast(record, method);
    if (method === DESKTOP_IPC_INITIALIZE_METHOD) {
      if (id === undefined) return { kind: "notification", method, ...(record.params === undefined ? {} : { params: record.params }) };
      return { kind: "request", id, method, ...(record.params === undefined ? {} : { params: record.params }) };
    }
    if (method === DESKTOP_IPC_INITIALIZED_METHOD) {
      return { kind: "notification", method, ...(record.params === undefined ? {} : { params: record.params }) };
    }
    return undefined;
  }

  if (record.type === "initialize") {
    if (id === undefined) throw new DesktopIPCProtocolError("Desktop IPC initialize request has an invalid id.");
    return { kind: "request", id, method: DESKTOP_IPC_INITIALIZE_METHOD, ...(record.params === undefined ? {} : { params: record.params }) };
  }
  if (record.type === "broadcast" || record.type === "event" || knownEvent(record.event) || knownEvent(record.type)) {
    return parseBroadcast(record);
  }
  return undefined;
}

export function parseDesktopIPCLine(line: string): DesktopIPCParsedMessage | undefined {
  return parseDesktopIPCMessage(line);
}

export function serializeDesktopIPCMessage(message: Record<string, unknown>): Buffer {
  let json: string;
  try {
    json = JSON.stringify(message);
  } catch (error: unknown) {
    throw new DesktopIPCProtocolError(`Desktop IPC message could not be serialized: ${String(error)}`);
  }
  if (json === undefined) throw new DesktopIPCProtocolError("Desktop IPC message could not be serialized.");
  const body = Buffer.from(json, "utf8");
  if (body.length === 0 || body.length > DESKTOP_IPC_MAX_FRAME_BYTES) {
    throw new DesktopIPCProtocolError("Desktop IPC message exceeds the frame limit.");
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export interface DesktopIPCInitializeOptions {
  readonly clientId?: string;
  readonly clientType?: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

export function createDesktopIPCInitializeRequest(
  id: DesktopIPCRpcId,
  options: DesktopIPCInitializeOptions = {},
): Record<string, unknown> {
  const clientId = options.clientId?.trim() || "initializing-client";
  return {
    type: "request",
    requestId: id,
    sourceClientId: clientId,
    method: DESKTOP_IPC_INITIALIZE_METHOD,
    params: {
      clientType: options.clientType?.trim()
        || options.clientName?.trim()
        || "local-review-mcp-desktop-ipc-observer",
    },
  };
}

export function createDesktopIPCInitializedNotification(): Record<string, unknown> {
  return { jsonrpc: "2.0", method: DESKTOP_IPC_INITIALIZED_METHOD };
}

function headerEnd(buffer: Buffer): { readonly index: number; readonly size: number } | undefined {
  const crlf = buffer.indexOf(Buffer.from("\r\n\r\n"));
  const lf = buffer.indexOf(Buffer.from("\n\n"));
  if (crlf < 0 && lf < 0) return undefined;
  if (crlf < 0) return { index: lf, size: 2 };
  if (lf < 0 || crlf < lf) return { index: crlf, size: 4 };
  return { index: lf, size: 2 };
}

function contentLength(header: string): number {
  const match = header.split(/\r?\n/u).find((line) => /^content-length\s*:/iu.test(line));
  const raw = match?.replace(/^content-length\s*:\s*/iu, "").trim();
  const value = raw === undefined ? NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > DESKTOP_IPC_MAX_FRAME_BYTES) {
    throw new DesktopIPCProtocolError("Desktop IPC content length is invalid.");
  }
  return value;
}

export class DesktopIPCFrameParser {
  private buffer = Buffer.alloc(0);

  public push(chunk: Buffer | Uint8Array | string): string[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > DESKTOP_IPC_MAX_FRAME_BYTES + 4) {
      throw new DesktopIPCProtocolError("Desktop IPC receive buffer is too large.");
    }

    const frames: string[] = [];
    for (;;) {
      if (this.buffer.length === 0) return frames;

      if (this.buffer.length >= 4) {
        const announced = this.buffer.readUInt32LE(0);
        const first = this.buffer[0]!;
        const binaryLength = announced > 0
          && announced <= DESKTOP_IPC_MAX_FRAME_BYTES
          && (this.buffer[1] === 0 || this.buffer[2] === 0 || this.buffer[3] === 0
            || ![0x09, 0x0a, 0x0d, 0x20, 0x22, 0x43, 0x5b, 0x66, 0x6e, 0x74, 0x7b].includes(first));
        if (binaryLength) {
          if (this.buffer.length < announced + 4) return frames;
          frames.push(this.buffer.subarray(4, announced + 4).toString("utf8"));
          this.buffer = this.buffer.subarray(announced + 4);
          continue;
        }
      }

      while (this.buffer.length > 0 && [0x09, 0x0a, 0x0d, 0x20].includes(this.buffer[0]!)) {
        this.buffer = this.buffer.subarray(1);
      }
      if (this.buffer.length === 0) return frames;

      const prefix = this.buffer.subarray(0, Math.min(this.buffer.length, 15)).toString("ascii");
      if (prefix.toLowerCase().startsWith("content-length:")) {
        const end = headerEnd(this.buffer);
        if (end === undefined) {
          if (this.buffer.length > 4_096) throw new DesktopIPCProtocolError("Desktop IPC header is too large.");
          return frames;
        }
        const header = this.buffer.subarray(0, end.index).toString("ascii");
        const length = contentLength(header);
        const bodyStart = end.index + end.size;
        if (this.buffer.length < bodyStart + length) return frames;
        frames.push(this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
        this.buffer = this.buffer.subarray(bodyStart + length);
        continue;
      }

      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > DESKTOP_IPC_MAX_FRAME_BYTES) {
          throw new DesktopIPCProtocolError("Desktop IPC line is too large.");
        }
        return frames;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line !== "") frames.push(line);
    }
  }

  public reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
