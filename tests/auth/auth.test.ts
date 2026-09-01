import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../../src/app.js";

const runningServers: Server[] = [];
const temporaryDirectories: string[] = [];
const TOKEN = "test-auth-token";

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeServer(): Promise<{ port: number; server: Server }> {
  const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-auth-"));
  temporaryDirectories.push(workspace);
  const server = await startApp({
    host: "127.0.0.1",
    port: 0,
    workspace,
    auth: { token: TOKEN },
    remote: { enabled: false, endpoint: "" },
  });
  runningServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return { port: address.port, server };
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "auth-test", version: "0.1.0" },
    },
  });
}

async function postMcp(port: number, authorization?: string): Promise<{ status: number; text: string }> {
  const body = Buffer.from(initializeBody(), "utf8");
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": body.byteLength,
        ...(authorization === undefined ? {} : { authorization }),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("HTTP Bearer authentication", () => {
  it("rejects missing and incorrect tokens with the same generic response", async () => {
    const { port } = await makeServer();

    const missing = await postMcp(port);
    const wrong = await postMcp(port, "Bearer wrong-token");

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.text).toBe(JSON.stringify({ error: "unauthorized" }));
    expect(wrong.text).toBe(missing.text);
    expect(missing.text).not.toContain(TOKEN);
  });

  it("allows a correctly authenticated MCP request", async () => {
    const { port } = await makeServer();
    await expect(postMcp(port, `Bearer ${TOKEN}`)).resolves.toMatchObject({ status: 200 });
  });

  it("logs only a safe authentication event", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { port } = await makeServer();
      await postMcp(port, `Bearer ${TOKEN}`);
      await postMcp(port, "Bearer wrong-token");

      const logs = warning.mock.calls.flat().join(" ");
      expect(logs).toContain("Auth failed");
      expect(logs).not.toContain(TOKEN);
      expect(logs).not.toContain(`Bearer ${TOKEN}`);
    } finally {
      warning.mockRestore();
    }
  });
});
