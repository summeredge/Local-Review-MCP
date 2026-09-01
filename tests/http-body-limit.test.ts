import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../src/app.js";
import { createHttpServer, MAX_MCP_REQUEST_BYTES } from "../src/mcp/http.js";
import type { ResolvedSettings } from "../src/config/settings.js";
import type { WorkspaceManager } from "../src/workspace/manager.js";

const runningServers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-body-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return address.port;
}

async function postJson(port: number, body: string): Promise<{ status: number; text: string }> {
  const payload = Buffer.from(body, "utf8");
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": payload.byteLength,
        authorization: "Bearer test-token",
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "body-limit-test", version: "0.1.0" },
    },
  });
}

function oversizedBody(): string {
  const prefix = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{},"padding":"';
  const suffix = '"}';
  const paddingBytes = MAX_MCP_REQUEST_BYTES + 1 - Buffer.byteLength(prefix + suffix, "utf8");
  return prefix + "x".repeat(paddingBytes) + suffix;
}

describe("MCP HTTP request body limit", () => {
  it("accepts a small JSON request", async () => {
    const workspace = await makeWorkspace();
    const server = await startApp({
      host: "127.0.0.1",
      port: 0,
      workspace,
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
    });
    runningServers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");

    const response = await postJson(address.port, initializeBody());
    expect(response.status).toBe(200);
  });

  it("returns 413 and never invokes the MCP handler for an oversized body", async () => {
    let handlerAccesses = 0;
    const workspace = new Proxy({} as WorkspaceManager, {
      get() {
        handlerAccesses += 1;
        throw new Error("MCP handler executed");
      },
    });
    const server = createHttpServer({
      host: "127.0.0.1",
      port: 0,
      workspace: "unused",
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
    } satisfies ResolvedSettings, { workspace });
    runningServers.push(server);
    const port = await listen(server);
    const body = oversizedBody();
    expect(Buffer.byteLength(body, "utf8")).toBe(MAX_MCP_REQUEST_BYTES + 1);

    const response = await postJson(port, body);
    expect(response.status).toBe(413);
    expect(JSON.parse(response.text)).toEqual({ error: "payload_too_large" });
    expect(handlerAccesses).toBe(0);
  });
});
