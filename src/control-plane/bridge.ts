import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { APP_VERSION } from "../config/settings.js";
import {
  ExtensionDeliveryConflictError,
  ExtensionDeliveryNotFoundError,
  ExtensionDeliveryUnavailableError,
  extensionDeliveryAckSchema,
  extensionDeliveryClaimSchema,
  type ExtensionDeliveryAck,
  type ExtensionDeliveryClaim,
  type ExtensionDeliveryReceipt,
  type LeasedExtensionDelivery,
} from "./extension-delivery.js";
import {
  ExtensionReviewCompletionConflictError,
  ExtensionReviewCompletionNotFoundError,
  ExtensionReviewCompletionUnavailableError,
  extensionReviewCompletionAckSchema,
  extensionReviewCompletionClaimSchema,
  type ExtensionReviewCompletionAck,
  type ExtensionReviewCompletionClaim,
  type ExtensionReviewCompletionReceipt,
  type LeasedExtensionReviewCompletion,
} from "./extension-review-completion.js";
import {
  extensionIdentityEvidenceSchema,
  type ExtensionIdentityEvidence,
} from "./extension-identity.js";
import {
  BRIDGE_PROTOCOL_HEADER,
  isCompatibleBridgeProtocol,
  LOCAL_CONTROL_BRIDGE_HOST,
  LOCAL_CONTROL_BRIDGE_PORTS,
  LOCAL_CONTROL_BRIDGE_PROTOCOL,
  LOCAL_CONTROL_BRIDGE_SERVICE,
  MAX_BRIDGE_REQUEST_BYTES,
  MAX_BRIDGE_COMPLETION_ACK_REQUEST_BYTES,
  parseExtensionOrigin,
} from "./bridge-protocol.js";

export interface BridgeStartOptions {
  readonly ports?: readonly number[];
  readonly onIdentityEvidence?: (evidence: ExtensionIdentityEvidence) => void | Promise<void>;
  readonly claimExtensionDelivery?: (
    claim: ExtensionDeliveryClaim,
  ) => LeasedExtensionDelivery | null | Promise<LeasedExtensionDelivery | null>;
  readonly ackExtensionDelivery?: (ack: ExtensionDeliveryAck) => {
    readonly accepted: "new" | "existing";
    readonly receipt: ExtensionDeliveryReceipt;
  } | Promise<{
    readonly accepted: "new" | "existing";
    readonly receipt: ExtensionDeliveryReceipt;
  }>;
  readonly claimExtensionReviewCompletion?: (
    claim: ExtensionReviewCompletionClaim,
  ) => LeasedExtensionReviewCompletion | null | Promise<LeasedExtensionReviewCompletion | null>;
  readonly ackExtensionReviewCompletion?: (ack: ExtensionReviewCompletionAck) => {
    readonly accepted: "new" | "existing";
    readonly receipt: ExtensionReviewCompletionReceipt;
  } | Promise<{
    readonly accepted: "new" | "existing";
    readonly receipt: ExtensionReviewCompletionReceipt;
  }>;
}

export interface BridgeStatus {
  readonly available: boolean;
  readonly address: typeof LOCAL_CONTROL_BRIDGE_HOST;
  readonly port: number | null;
  readonly paired: boolean;
}

class RequestBodyTooLargeError extends Error {}

let bridgeServer: Server | null = null;
let activePort: number | null = null;
let pairedOrigin: string | null = null;
let bearerToken: string | null = null;
let onIdentityEvidence: (evidence: ExtensionIdentityEvidence) => void | Promise<void> = () => undefined;
let claimExtensionDelivery: NonNullable<BridgeStartOptions["claimExtensionDelivery"]> = () => null;
let ackExtensionDelivery: NonNullable<BridgeStartOptions["ackExtensionDelivery"]> = () => {
  throw new ExtensionDeliveryNotFoundError("delivery not found");
};
let claimExtensionReviewCompletion: NonNullable<BridgeStartOptions["claimExtensionReviewCompletion"]> = () => {
  throw new ExtensionReviewCompletionUnavailableError("extension review completion unavailable");
};
let ackExtensionReviewCompletion: NonNullable<BridgeStartOptions["ackExtensionReviewCompletion"]> = () => {
  throw new ExtensionReviewCompletionUnavailableError("extension review completion unavailable");
};
let lifecycleQueue: Promise<void> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleQueue.then(operation, operation);
  lifecycleQueue = result.then(() => undefined, () => undefined);
  return result;
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin: string | null = null,
): void {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(payload, "utf8")),
    "content-type": "application/json",
  };
  if (origin !== null) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-headers"] = `authorization, content-type, ${BRIDGE_PROTOCOL_HEADER}`;
    headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
  }
  response.writeHead(status, headers);
  response.end(payload);
}

function empty(response: ServerResponse, status: number, origin: string): void {
  response.writeHead(status, {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": `authorization, content-type, ${BRIDGE_PROTOCOL_HEADER}`,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    "cache-control": "no-store",
  });
  response.end();
}

function methodNotAllowed(request: IncomingMessage, response: ServerResponse): void {
  request.resume();
  json(response, 405, { error: "method_not_allowed" }, parseExtensionOrigin(request.headers.origin));
}

function incompatibleProtocol(response: ServerResponse, origin: string): void {
  json(response, 426, {
    error: "incompatible_protocol",
    protocol: LOCAL_CONTROL_BRIDGE_PROTOCOL,
  }, origin);
}

function forbiddenOrigin(request: IncomingMessage, response: ServerResponse): void {
  request.resume();
  json(response, 403, { error: "forbidden_origin" });
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length > 0
    && leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

function authorized(request: IncomingMessage, origin: string): boolean {
  const header = request.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  return pairedOrigin === origin && bearerToken !== null && safeEqual(token, bearerToken);
}

function readJson(
  request: IncomingMessage,
  maxBytes = MAX_BRIDGE_REQUEST_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentLength = request.headers["content-length"];
    if (typeof contentLength === "string"
      && Number.isFinite(Number(contentLength))
      && Number(contentLength) > maxBytes) {
      request.resume();
      reject(new RequestBodyTooLargeError());
      return;
    }

    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        request.resume();
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function pair(request: IncomingMessage, response: ServerResponse, origin: string): Promise<void> {
  try {
    await readJson(request);
  } catch (error: unknown) {
    if (error instanceof RequestBodyTooLargeError) {
      json(response, 413, { error: "body_too_large" }, origin);
      return;
    }
    json(response, 400, { error: "bad_request" }, origin);
    return;
  }

  if (pairedOrigin !== null && pairedOrigin !== origin) {
    json(response, 409, { error: "pairing_owned" }, origin);
    return;
  }
  if (bearerToken === null) {
    pairedOrigin = origin;
    bearerToken = randomBytes(32).toString("base64url");
  }
  json(response, 200, { token: bearerToken }, origin);
}

async function receiveIdentityEvidence(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error: unknown) {
    if (error instanceof RequestBodyTooLargeError) {
      json(response, 413, { error: "body_too_large" }, origin);
      return;
    }
    json(response, 400, { error: "bad_request" }, origin);
    return;
  }

  const parsed = extensionIdentityEvidenceSchema.safeParse(body);
  if (!parsed.success) {
    json(response, 400, { error: "invalid_identity_evidence" }, origin);
    return;
  }
  await onIdentityEvidence(parsed.data);
  json(response, 202, { accepted: true }, origin);
}

async function receiveDeliveryClaim(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error: unknown) {
    json(response, error instanceof RequestBodyTooLargeError ? 413 : 400, {
      error: error instanceof RequestBodyTooLargeError ? "body_too_large" : "bad_request",
    }, origin);
    return;
  }
  const parsed = extensionDeliveryClaimSchema.safeParse(body);
  if (!parsed.success) {
    json(response, 400, { error: "invalid_delivery_claim" }, origin);
    return;
  }
  try {
    const command = await claimExtensionDelivery(parsed.data);
    json(response, 200, { command }, origin);
  } catch (error: unknown) {
    if (error instanceof ExtensionDeliveryUnavailableError) {
      json(response, 503, { error: "delivery_unavailable" }, origin);
      return;
    }
    throw error;
  }
}

async function receiveDeliveryAck(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error: unknown) {
    json(response, error instanceof RequestBodyTooLargeError ? 413 : 400, {
      error: error instanceof RequestBodyTooLargeError ? "body_too_large" : "bad_request",
    }, origin);
    return;
  }
  const parsed = extensionDeliveryAckSchema.safeParse(body);
  if (!parsed.success) {
    json(response, 400, { error: "invalid_delivery_ack" }, origin);
    return;
  }
  try {
    const result = await ackExtensionDelivery(parsed.data);
    json(response, 200, result, origin);
  } catch (error: unknown) {
    if (error instanceof ExtensionDeliveryUnavailableError) {
      json(response, 503, { error: "delivery_unavailable" }, origin);
      return;
    }
    if (error instanceof ExtensionDeliveryConflictError) {
      json(response, 409, { error: "conflicting_delivery_ack" }, origin);
      return;
    }
    if (error instanceof ExtensionDeliveryNotFoundError) {
      json(response, 404, { error: "delivery_not_found" }, origin);
      return;
    }
    throw error;
  }
}

async function receiveCompletionClaim(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error: unknown) {
    json(response, error instanceof RequestBodyTooLargeError ? 413 : 400, {
      error: error instanceof RequestBodyTooLargeError ? "body_too_large" : "bad_request",
    }, origin);
    return;
  }
  const parsed = extensionReviewCompletionClaimSchema.safeParse(body);
  if (!parsed.success) {
    json(response, 400, { error: "invalid_completion_claim" }, origin);
    return;
  }
  try {
    const completion = await claimExtensionReviewCompletion(parsed.data);
    json(response, 200, completion === null ? { command: null } : completion, origin);
  } catch (error: unknown) {
    if (error instanceof ExtensionReviewCompletionUnavailableError) {
      json(response, 503, { error: "completion_unavailable" }, origin);
      return;
    }
    throw error;
  }
}

async function receiveCompletionAck(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(request, MAX_BRIDGE_COMPLETION_ACK_REQUEST_BYTES);
  } catch (error: unknown) {
    json(response, error instanceof RequestBodyTooLargeError ? 413 : 400, {
      error: error instanceof RequestBodyTooLargeError ? "body_too_large" : "bad_request",
    }, origin);
    return;
  }
  const parsed = extensionReviewCompletionAckSchema.safeParse(body);
  if (!parsed.success) {
    json(response, 400, { error: "invalid_completion_ack" }, origin);
    return;
  }
  try {
    const result = await ackExtensionReviewCompletion(parsed.data);
    json(response, 200, result, origin);
  } catch (error: unknown) {
    if (error instanceof ExtensionReviewCompletionUnavailableError) {
      json(response, 503, { error: "completion_unavailable" }, origin);
      return;
    }
    if (error instanceof ExtensionReviewCompletionConflictError) {
      json(response, 409, { error: "conflicting_completion_ack" }, origin);
      return;
    }
    if (error instanceof ExtensionReviewCompletionNotFoundError) {
      json(response, 404, { error: "completion_not_found" }, origin);
      return;
    }
    throw error;
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${LOCAL_CONTROL_BRIDGE_HOST}`);
  const route = url.pathname;

  if (route === "/hello") {
    if (request.method !== "GET") {
      methodNotAllowed(request, response);
      return;
    }
    const origin = parseExtensionOrigin(request.headers.origin);
    if (request.headers.origin !== undefined && origin === null) {
      forbiddenOrigin(request, response);
      return;
    }
    json(response, 200, {
      service: LOCAL_CONTROL_BRIDGE_SERVICE,
      protocol: LOCAL_CONTROL_BRIDGE_PROTOCOL,
      version: APP_VERSION,
      paired: pairedOrigin !== null && bearerToken !== null,
    }, origin);
    return;
  }

  if (route !== "/pair" && route !== "/status" && route !== "/identity-evidence"
    && route !== "/delivery/claim" && route !== "/delivery/ack"
    && route !== "/completion/claim" && route !== "/completion/ack") {
    request.resume();
    json(response, 404, { error: "not_found" });
    return;
  }

  if (request.method === "OPTIONS") {
    const origin = parseExtensionOrigin(request.headers.origin);
    if (origin === null) {
      forbiddenOrigin(request, response);
      return;
    }
    empty(response, 204, origin);
    return;
  }

  if (route === "/pair" && request.method !== "POST") {
    methodNotAllowed(request, response);
    return;
  }
  if (route === "/status" && request.method !== "GET") {
    methodNotAllowed(request, response);
    return;
  }
  if (route === "/identity-evidence" && request.method !== "POST") {
    methodNotAllowed(request, response);
    return;
  }
  if ((route === "/delivery/claim" || route === "/delivery/ack"
    || route === "/completion/claim" || route === "/completion/ack")
    && request.method !== "POST") {
    methodNotAllowed(request, response);
    return;
  }

  const origin = parseExtensionOrigin(request.headers.origin);
  if (origin === null) {
    forbiddenOrigin(request, response);
    return;
  }
  if (!isCompatibleBridgeProtocol(request.headers[BRIDGE_PROTOCOL_HEADER])) {
    incompatibleProtocol(response, origin);
    return;
  }

  if (route === "/pair") {
    await pair(request, response, origin);
    return;
  }

  if (pairedOrigin !== origin) {
    request.resume();
    json(response, 403, { error: "forbidden_origin" }, origin);
    return;
  }
  if (!authorized(request, origin)) {
    request.resume();
    json(response, 401, { error: "unauthorized" }, origin);
    return;
  }
  if (route === "/identity-evidence") {
    await receiveIdentityEvidence(request, response, origin);
    return;
  }
  if (route === "/delivery/claim") {
    await receiveDeliveryClaim(request, response, origin);
    return;
  }
  if (route === "/delivery/ack") {
    await receiveDeliveryAck(request, response, origin);
    return;
  }
  if (route === "/completion/claim") {
    await receiveCompletionClaim(request, response, origin);
    return;
  }
  if (route === "/completion/ack") {
    await receiveCompletionAck(request, response, origin);
    return;
  }
  json(response, 200, {
    status: "ok",
    protocol: LOCAL_CONTROL_BRIDGE_PROTOCOL,
    version: APP_VERSION,
    port: activePort,
  }, origin);
}

function createBridgeServer(): Server {
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "internal_server_error" });
      else response.destroy();
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LOCAL_CONTROL_BRIDGE_HOST);
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function validPorts(ports: readonly number[]): readonly number[] {
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`invalid bridge port: ${String(port)}`);
    }
  }
  return ports;
}

async function startBridgeOnce(options: BridgeStartOptions): Promise<number | null> {
  if (bridgeServer?.listening === true) return activePort;

  const ports = validPorts(options.ports ?? LOCAL_CONTROL_BRIDGE_PORTS);
  for (const candidate of ports) {
    const server = createBridgeServer();
    try {
      await listen(server, candidate);
      const address = server.address();
      if (address === null || typeof address === "string") {
        await close(server);
        continue;
      }
      bridgeServer = server;
      activePort = address.port;
      server.once("close", () => {
        if (bridgeServer === server) {
          bridgeServer = null;
          activePort = null;
        }
      });
      return activePort;
    } catch (error: unknown) {
      await close(server);
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
      throw error;
    }
  }
  return null;
}

export function startBridge(options: BridgeStartOptions = {}): Promise<number | null> {
  onIdentityEvidence = options.onIdentityEvidence ?? (() => undefined);
  claimExtensionDelivery = options.claimExtensionDelivery ?? (() => null);
  ackExtensionDelivery = options.ackExtensionDelivery ?? (() => {
    throw new ExtensionDeliveryNotFoundError("delivery not found");
  });
  claimExtensionReviewCompletion = options.claimExtensionReviewCompletion ?? (() => {
    throw new ExtensionReviewCompletionUnavailableError("extension review completion unavailable");
  });
  ackExtensionReviewCompletion = options.ackExtensionReviewCompletion ?? (() => {
    throw new ExtensionReviewCompletionUnavailableError("extension review completion unavailable");
  });
  return enqueue(() => startBridgeOnce(options));
}

export function stopBridge(): Promise<void> {
  return enqueue(async () => {
    const server = bridgeServer;
    bridgeServer = null;
    activePort = null;
    pairedOrigin = null;
    bearerToken = null;
    onIdentityEvidence = () => undefined;
    claimExtensionDelivery = () => null;
    ackExtensionDelivery = () => {
      throw new ExtensionDeliveryNotFoundError("delivery not found");
    };
    claimExtensionReviewCompletion = () => {
      throw new ExtensionReviewCompletionUnavailableError("extension review completion unavailable");
    };
    ackExtensionReviewCompletion = () => {
      throw new ExtensionReviewCompletionUnavailableError("extension review completion unavailable");
    };
    if (server !== null) await close(server);
  });
}

export function bridgePort(): number | null {
  return activePort;
}

export function bridgeStatus(): BridgeStatus {
  return {
    available: bridgeServer?.listening === true,
    address: LOCAL_CONTROL_BRIDGE_HOST,
    port: activePort,
    paired: pairedOrigin !== null && bearerToken !== null,
  };
}
