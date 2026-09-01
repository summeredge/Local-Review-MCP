import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isAuthenticated } from "../auth/middleware.js";
import {
  APP_VERSION,
  DEFAULT_HOST,
  HEALTH_PATH,
  MCP_PATH,
  type ResolvedSettings,
} from "../config/settings.js";
import type { TunnelProvider, TunnelStatus } from "../tunnel/types.js";
import { createMcpServer, type McpRuntimeContext } from "./server.js";

export const MAX_MCP_REQUEST_BYTES = 1024 * 1024;

type HttpRuntimeContext = McpRuntimeContext & {
  readonly tunnel?: Pick<TunnelProvider, "status">;
};

class RequestBodyTooLargeError extends Error {
  public constructor() {
    super("MCP request body exceeds the maximum allowed size.");
    this.name = "RequestBodyTooLargeError";
  }
}

async function parseBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string"
    && Number.isFinite(Number(contentLength))
    && Number(contentLength) > MAX_MCP_REQUEST_BYTES) {
    request.resume();
    throw new RequestBodyTooLargeError();
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_MCP_REQUEST_BYTES) {
      request.resume();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendUnauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": "Bearer",
  });
  response.end(JSON.stringify({ error: "unauthorized" }));
}

async function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: HttpRuntimeContext,
): Promise<void> {
  if (request.method !== "GET") {
    request.resume();
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  let tunnel: TunnelStatus = { state: "LOCAL_ONLY" };
  try {
    if (context.tunnel !== undefined) tunnel = await context.tunnel.status();
  } catch {
    tunnel = { state: "REMOTE_ERROR" };
  }
  sendJson(response, 200, {
    status: "ok",
    workspace: context.workspace.workspaceId,
    version: APP_VERSION,
    remote_status: tunnel.state,
    endpoint_status: tunnel.endpoint === undefined
      ? tunnel.state === "REMOTE_ERROR"
        ? "error"
        : tunnel.state === "REMOTE_STARTING"
          ? "starting"
          : "stopped"
      : "ready",
    ...(tunnel.endpoint === undefined ? {} : { endpoint: tunnel.endpoint }),
  });
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: McpRuntimeContext,
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  let body: unknown;
  try {
    body = await parseBody(request);
  } catch (error: unknown) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, { error: "payload_too_large" });
      return;
    }
    sendJson(response, 400, { error: "invalid_json_body" });
    return;
  }
  if (body === undefined || typeof body !== "object" || body === null) {
    sendJson(response, 400, { error: "invalid_json_body" });
    return;
  }

  const server = createMcpServer(context);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => void transport.close());
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}

export function createHttpServer(settings: ResolvedSettings, context: HttpRuntimeContext): Server {
  return createServer((request, response) => {
    if (request.url === HEALTH_PATH || request.url === MCP_PATH) {
      if (!isAuthenticated(request, settings.auth.token)) {
        request.resume();
        console.warn("Auth failed");
        sendUnauthorized(response);
        return;
      }
    }
    if (request.url === HEALTH_PATH) {
      void handleHealthRequest(request, response, context).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: "internal_server_error" });
      });
      return;
    }
    if (request.url !== MCP_PATH) {
      request.resume();
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    void handleMcpRequest(request, response, context).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(response, 500, { error: "internal_server_error" });
    });
  });
}

function assertLoopbackHost(settings: ResolvedSettings): void {
  if (settings.host !== DEFAULT_HOST) {
    throw new Error(
      `Local Review MCP refuses to bind to "${String(settings.host)}"; `
      + `only "${DEFAULT_HOST}" is allowed.`,
    );
  }
}

export async function checkPort(settings: ResolvedSettings): Promise<void> {
  assertLoopbackHost(settings);
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      probe.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      probe.removeListener("error", onError);
      probe.close((closeError) => closeError ? reject(closeError) : resolve());
    };
    probe.once("error", onError);
    probe.once("listening", onListening);
    probe.listen(settings.port, settings.host);
  });
}

export async function startHttpServer(
  settings: ResolvedSettings,
  context: HttpRuntimeContext,
): Promise<Server> {
  assertLoopbackHost(settings);
  await checkPort(settings);
  const server = createHttpServer(settings, context);
  await new Promise<void>((resolve, reject) => {
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
    assertLoopbackHost(settings);
    server.listen(settings.port, settings.host);
  });
  return server;
}

export function isPortInUse(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}
