import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type ResolvedSettings, MCP_PATH } from "../config/settings.js";
import { createMcpServer } from "./server.js";

async function parseBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  let body: unknown;
  try {
    body = await parseBody(request);
  } catch {
    sendJson(response, 400, { error: "invalid_json_body" });
    return;
  }
  if (body === undefined || typeof body !== "object" || body === null) {
    sendJson(response, 400, { error: "invalid_json_body" });
    return;
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => void transport.close());
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}

export function createHttpServer(_settings: ResolvedSettings): Server {
  return createServer((request, response) => {
    if (request.url !== MCP_PATH) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    void handleMcpRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(response, 500, { error: "internal_server_error" });
    });
  });
}

export async function checkPort(settings: ResolvedSettings): Promise<void> {
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

export async function startHttpServer(settings: ResolvedSettings): Promise<Server> {
  await checkPort(settings);
  const server = createHttpServer(settings);
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
    server.listen(settings.port, settings.host);
  });
  return server;
}

export function isPortInUse(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}
