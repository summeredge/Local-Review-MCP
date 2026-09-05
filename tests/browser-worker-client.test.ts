import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserWorkerClient,
  BrowserWorkerClientError,
} from "../src/browser-worker-client/browser-worker-client.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function startServer(
  handler: (response: ServerResponse, body: unknown) => void,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      body = undefined;
    }
    handler(response, body);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("BrowserWorkerClient", () => {
  it("posts a conversation ID and returns a successful navigation result", async () => {
    let requestBody: unknown;
    const { baseUrl } = await startServer((response, body) => {
      requestBody = body;
      sendJson(response, 200, {
        conversationId: "conversation-001",
        url: "https://chatgpt.com/c/conversation-001",
        status: "NAVIGATED",
      });
    });

    await expect(new BrowserWorkerClient({ baseUrl }).navigate("conversation-001"))
      .resolves.toEqual({
        conversationId: "conversation-001",
        url: "https://chatgpt.com/c/conversation-001",
        status: "NAVIGATED",
      });
    expect(requestBody).toEqual({ conversationId: "conversation-001" });
  });

  it("returns a valid failed navigation result for an HTTP-success response", async () => {
    const { baseUrl } = await startServer((response) => {
      sendJson(response, 200, {
        conversationId: "conversation-001",
        url: "https://chatgpt.com/c/conversation-001",
        status: "FAILED",
        error: "navigation failed",
      });
    });

    await expect(new BrowserWorkerClient({ baseUrl }).navigate("conversation-001"))
      .resolves.toMatchObject({ status: "FAILED", error: "navigation failed" });
  });

  it("wraps non-success HTTP responses", async () => {
    const { baseUrl } = await startServer((response) => {
      sendJson(response, 503, { error: "worker unavailable" });
    });

    const result = new BrowserWorkerClient({ baseUrl }).navigate("conversation-001");
    await expect(result).rejects.toMatchObject({
      name: "BrowserWorkerClientError",
      code: "HTTP_ERROR",
      statusCode: 503,
    });
    await expect(result).rejects.toBeInstanceOf(BrowserWorkerClientError);
  });

  it("wraps a request timeout", async () => {
    const { baseUrl } = await startServer((response) => {
      setTimeout(() => sendJson(response, 200, {
        conversationId: "conversation-001",
        url: "https://chatgpt.com/c/conversation-001",
        status: "NAVIGATED",
      }), 200);
    });

    await expect(new BrowserWorkerClient({ baseUrl, timeoutMs: 20 }).navigate("conversation-001"))
      .rejects.toMatchObject({ name: "BrowserWorkerClientError", code: "TIMEOUT" });
  });

  it("rejects an invalid navigation response", async () => {
    const { baseUrl } = await startServer((response) => {
      sendJson(response, 200, { conversationId: "conversation-001", status: "NAVIGATED" });
    });

    await expect(new BrowserWorkerClient({ baseUrl }).navigate("conversation-001"))
      .rejects.toMatchObject({ name: "BrowserWorkerClientError", code: "INVALID_RESPONSE" });
  });
});
