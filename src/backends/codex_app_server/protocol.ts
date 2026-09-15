export type RpcId = number | string;

export interface RpcRequest {
  readonly id: RpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcErrorBody {
  readonly code: number;
  readonly message: string;
}

export interface RpcResponse {
  readonly id: RpcId;
  readonly result?: unknown;
  readonly error?: RpcErrorBody;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export class CodexAppServerProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodexAppServerProtocolError";
  }
}

export class CodexAppServerRpcError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

export function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function isRpcResponse(value: RpcMessage): value is RpcResponse {
  return "id" in value && ("result" in value || "error" in value) && !("method" in value);
}

export function isRpcRequest(value: RpcMessage): value is RpcRequest {
  return "id" in value && "method" in value;
}

export function serializeRpc(value: RpcRequest | RpcNotification | RpcResponse): string {
  return `${JSON.stringify(value)}\n`;
}

export function parseRpcLine(line: string): RpcMessage {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new CodexAppServerProtocolError("Codex app-server emitted invalid JSON.");
  }
  const record = jsonRecord(value);
  if (record === undefined) {
    throw new CodexAppServerProtocolError("Codex app-server emitted a non-object JSON message.");
  }

  const method = record.method;
  const id = record.id;
  if (typeof method === "string" && (typeof id === "number" || typeof id === "string")) {
    return {
      id,
      method,
      ...(Object.prototype.hasOwnProperty.call(record, "params") ? { params: record.params } : {}),
    };
  }
  if (typeof method === "string") {
    return {
      method,
      ...(Object.prototype.hasOwnProperty.call(record, "params") ? { params: record.params } : {}),
    };
  }
  if (typeof id !== "number" && typeof id !== "string") {
    throw new CodexAppServerProtocolError("Codex app-server emitted a message without an id or method.");
  }
  if (Object.prototype.hasOwnProperty.call(record, "error")) {
    const error = jsonRecord(record.error);
    if (error === undefined || typeof error.code !== "number" || typeof error.message !== "string") {
      throw new CodexAppServerProtocolError("Codex app-server emitted an invalid RPC error.");
    }
    return { id, error: { code: error.code, message: error.message } };
  }
  if (!Object.prototype.hasOwnProperty.call(record, "result")) {
    throw new CodexAppServerProtocolError("Codex app-server emitted an invalid RPC response.");
  }
  return { id, result: record.result };
}
