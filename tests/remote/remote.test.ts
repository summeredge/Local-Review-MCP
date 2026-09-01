import { request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../../src/app.js";
import type { ResolvedSettings } from "../../src/config/settings.js";
import { TunnelManager } from "../../src/tunnel/manager.js";
import type { TunnelProvider, TunnelStatus } from "../../src/tunnel/types.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";

const runningServers: Server[] = [];
const temporaryDirectories: string[] = [];
const TOKEN = "remote-auth-token";
const REMOTE_ENDPOINT = "https://review.example/mcp";

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

function remoteSettings(workspace: string): ResolvedSettings {
  return {
    host: "127.0.0.1",
    port: 0,
    workspace,
    auth: { token: TOKEN },
    remote: { enabled: true, provider: "cloudflare", endpoint: REMOTE_ENDPOINT },
  };
}

function readyProvider(endpoint = REMOTE_ENDPOINT): TunnelProvider {
  let current: TunnelStatus = { state: "LOCAL_ONLY" };
  return {
    async start() {
      current = { state: "REMOTE_READY", endpoint };
      return { endpoint };
    },
    async stop() {
      current = { state: "STOPPED" };
    },
    async status() {
      return current;
    },
  };
}

async function makeRemoteServer(provider: TunnelProvider): Promise<{ port: number; server: Server }> {
  const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-remote-"));
  temporaryDirectories.push(workspace);
  const settings = remoteSettings(workspace);
  const context = {
    settings,
    tunnel: new TunnelManager(provider, true),
    workspace: new WorkspaceManager(workspace),
  };
  const server = await startApp(settings, context);
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
      clientInfo: { name: "remote-test", version: "0.1.0" },
    },
  });
}

async function postMcp(port: number, authorization?: string): Promise<number> {
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
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function getHealth(port: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/health" }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("remote MCP deployment", () => {
  it("keeps Bearer authentication on the tunneled MCP endpoint", async () => {
    const { port } = await makeRemoteServer(readyProvider());

    await expect(postMcp(port)).resolves.toBe(401);
    await expect(postMcp(port, "Bearer wrong-token")).resolves.toBe(401);
    await expect(postMcp(port, `Bearer ${TOKEN}`)).resolves.toBe(200);
  });

  it("reports safe remote health state and endpoint metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-remote-health-"));
    temporaryDirectories.push(workspace);
    const settings = remoteSettings(workspace);
    const server = await startApp(settings, {
      settings,
      tunnel: new TunnelManager(readyProvider(), true),
      workspace: new WorkspaceManager(workspace),
    });
    runningServers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");

    const response = await getHealth(address.port);
    const health = JSON.parse(response.text) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(health).toMatchObject({
      status: "ok",
      remote_status: "REMOTE_READY",
      endpoint_status: "ready",
      endpoint: REMOTE_ENDPOINT,
    });
    expect(response.text).not.toContain(TOKEN);
    expect(response.text).not.toContain("Authorization");
    expect(response.text).not.toContain(workspace);
    expect(response.text).not.toContain("127.0.0.1");
  });

  it("keeps local MCP running when the tunnel fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const provider: TunnelProvider = {
        async start() { throw new Error("secret-tunnel-token"); },
        async stop() {},
        async status() { return { state: "REMOTE_ERROR" }; },
      };
      const { port } = await makeRemoteServer(provider);

      await expect(getHealth(port)).resolves.toMatchObject({ status: 200 });
      expect(error.mock.calls.flat().join(" ")).toContain("Tunnel failed");
      expect(error.mock.calls.flat().join(" ")).not.toContain("secret-tunnel-token");
    } finally {
      error.mockRestore();
    }
  });

  it("starts local-only when remote access is disabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-local-only-"));
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

    const health = JSON.parse((await getHealth(address.port)).text) as Record<string, unknown>;
    expect(health).toMatchObject({
      status: "ok",
      remote_status: "LOCAL_ONLY",
      endpoint_status: "stopped",
    });
  });
});
