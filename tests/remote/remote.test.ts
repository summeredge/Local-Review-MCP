import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp, type AppContext } from "../../src/app.js";
import type { ResolvedSettings } from "../../src/config/settings.js";
import { TunnelManager } from "../../src/tunnel/manager.js";
import type { TunnelProvider, TunnelStatus } from "../../src/tunnel/types.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { EXPECTED_REGISTERED_TOOL_NAMES } from "../fixtures/v01-tools.js";

const runProcess = promisify(execFile);
const clients: Client[] = [];
const runningServers: Server[] = [];
const temporaryDirectories: string[] = [];
const TOKEN = "remote-auth-token";
const REMOTE_ENDPOINT = "https://review.example/mcp";

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
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
    remote: {
      enabled: true,
      provider: "cloudflare",
      tunnelName: "review-tunnel",
      endpoint: REMOTE_ENDPOINT,
    },
    supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
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

async function startRemoteServer(
  workspace: string,
  provider: TunnelProvider = readyProvider(),
): Promise<{ port: number; context: AppContext }> {
  const settings = remoteSettings(workspace);
  const context: AppContext = {
    settings,
    tunnel: new TunnelManager(provider, true),
    workspace: new WorkspaceManager(workspace),
  };
  const server = await startApp(settings, context);
  runningServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return { port: address.port, context };
}

async function makeRemoteWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-remote-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(workspace: string, ...args: string[]): Promise<void> {
  await runProcess("git", args, {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
}

async function makeReviewWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-review-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "sample-project");
  await mkdir(workspace);
  await git(workspace, "init", "-b", "main");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "config", "user.name", "Local Review Test");
  await writeFile(join(workspace, "modified-file.ts"), "export const reviewState = \"before\";\n");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "initial");
  await writeFile(join(workspace, "modified-file.ts"), "export const reviewState = \"after\";\n");
  return workspace;
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

async function postMcp(
  port: number,
  authorization?: string,
): Promise<{ status: number; text: string }> {
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

async function getHealth(
  port: number,
  authorization?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/health",
      method: "GET",
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function connectRemote(port: number): Promise<Client> {
  const client = new Client({ name: "chatgpt-remote-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } },
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

function toolText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || typeof content[0] !== "object" || content[0] === null
    || typeof (content[0] as { text?: unknown }).text !== "string") {
    throw new Error("tool did not return text content");
  }
  return (content[0] as { text: string }).text;
}

function toolJson(result: unknown): Record<string, unknown> {
  return JSON.parse(toolText(result)) as Record<string, unknown>;
}

function structuredToolJson(result: unknown): Record<string, unknown> {
  const parsed = toolJson(result);
  expect((result as { structuredContent?: unknown }).structuredContent).toEqual(parsed);
  return parsed;
}

describe("remote MCP deployment", () => {
  it("initializes, lists the read-only tool surface, and completes an ordered code review", async () => {
    const workspace = await makeReviewWorkspace();
    const { port } = await startRemoteServer(workspace);
    const client = await connectRemote(port);

    expect(client.getServerVersion()).toEqual({ name: "local-review-mcp", version: "0.1.0" });
    expect(client.getServerCapabilities()).toMatchObject({ tools: expect.any(Object) });

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_REGISTERED_TOOL_NAMES].sort());
    expect(listed.tools.find((tool) => tool.name === "workspace_info")?.outputSchema).toMatchObject({
      type: "object",
      properties: { workspace_id: expect.any(Object) },
    });

    const infoResult = await client.callTool({ name: "workspace_info", arguments: {} });
    expect(infoResult.isError).not.toBe(true);
    const info = toolJson(infoResult);
    expect(infoResult.structuredContent).toEqual(info);
    expect(info).toMatchObject({
      workspace_name: "sample-project",
      root_alias: "workspace:/",
    });
    expect(toolText(infoResult)).not.toContain(workspace);

    const statusResult = await client.callTool({ name: "git_status", arguments: {} });
    expect(statusResult.isError).not.toBe(true);
    expect(structuredToolJson(statusResult)).toMatchObject({
      branch: "main",
      entries: [{ path: "modified-file.ts", status: "modified" }],
    });

    const diffResult = await client.callTool({ name: "git_diff", arguments: {} });
    expect(diffResult.isError).not.toBe(true);
    expect(structuredToolJson(diffResult)).toMatchObject({
      files: ["modified-file.ts"],
      diff: expect.stringContaining('+export const reviewState = "after";'),
    });

    const readResult = await client.callTool({
      name: "read_file",
      arguments: { path: "modified-file.ts" },
    });
    expect(readResult.isError).not.toBe(true);
    expect(toolJson(readResult)).toMatchObject({
      path: "modified-file.ts",
      content: 'export const reviewState = "after";',
    });

    const searchResult = await client.callTool({
      name: "search_text",
      arguments: { query: "reviewState" },
    });
    expect(searchResult.isError).not.toBe(true);
    expect(toolJson(searchResult)).toMatchObject({
      returned: 1,
      results: [{ path: "modified-file.ts", line: 1 }],
    });
  });

  it("requires Bearer authentication for health and MCP requests through remote mode", async () => {
    const workspace = await makeRemoteWorkspace();
    const { port } = await startRemoteServer(workspace);

    await expect(getHealth(port)).resolves.toMatchObject({ status: 401 });
    await expect(getHealth(port, "Bearer wrong-token")).resolves.toMatchObject({ status: 401 });
    await expect(getHealth(port, `Bearer ${TOKEN}`)).resolves.toMatchObject({ status: 200 });

    await expect(postMcp(port)).resolves.toMatchObject({ status: 401 });
    await expect(postMcp(port, "Bearer wrong-token")).resolves.toMatchObject({ status: 401 });
    await expect(postMcp(port, `Bearer ${TOKEN}`)).resolves.toMatchObject({ status: 200 });
  });

  it("returns only safe remote health metadata", async () => {
    const workspace = await makeRemoteWorkspace();
    const { port } = await startRemoteServer(workspace);
    const response = await getHealth(port, `Bearer ${TOKEN}`);
    const health = JSON.parse(response.text) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(health).toMatchObject({
      status: "ok",
      remote_status: "REMOTE_READY",
      endpoint_status: "ready",
      endpoint: REMOTE_ENDPOINT,
    });
    for (const secret of [
      TOKEN,
      process.env.CLOUDFLARE_TUNNEL_TOKEN,
      process.env.LOCAL_REVIEW_MCP_TOKEN,
    ]) {
      if (secret !== undefined && secret !== "") expect(response.text).not.toContain(secret);
    }
    for (const localPath of [workspace, process.env.USERPROFILE, process.env.HOME, process.cwd()]) {
      if (localPath !== undefined && localPath !== "") expect(response.text).not.toContain(localPath);
    }
  });

  it("keeps local MCP running when the tunnel fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const workspace = await makeRemoteWorkspace();
      const provider: TunnelProvider = {
        async start() { throw new Error("secret-tunnel-token"); },
        async stop() {},
        async status() { return { state: "REMOTE_ERROR" }; },
      };
      const { port } = await startRemoteServer(workspace, provider);

      await expect(getHealth(port, `Bearer ${TOKEN}`)).resolves.toMatchObject({ status: 200 });
      expect(error.mock.calls.flat().join(" ")).toContain("Tunnel failed");
      expect(error.mock.calls.flat().join(" ")).not.toContain("secret-tunnel-token");
    } finally {
      error.mockRestore();
    }
  });

  it("starts local-only when remote access is disabled", async () => {
    const workspace = await makeRemoteWorkspace();
    const server = await startApp({
      host: "127.0.0.1",
      port: 0,
      workspace,
      auth: { token: TOKEN },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    });
    runningServers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");

    const health = JSON.parse((await getHealth(address.port, `Bearer ${TOKEN}`)).text) as Record<string, unknown>;
    expect(health).toMatchObject({
      status: "ok",
      remote_status: "LOCAL_ONLY",
      endpoint_status: "stopped",
    });
  });

  it("rejects sensitive files through the remote read_file tool", async () => {
    const workspace = await makeRemoteWorkspace();
    for (const path of [".env", ".env.local", "credentials.json", "private.pem", "private.key"]) {
      await writeFile(join(workspace, path), "secret-value\n");
    }
    const { port } = await startRemoteServer(workspace);
    const client = await connectRemote(port);

    for (const path of [".env", ".env.local", "credentials.json", "private.pem", "private.key"]) {
      const result = await client.callTool({ name: "read_file", arguments: { path } });
      expect(result.isError, path).toBe(true);
      expect(toolJson(result), path).toEqual({ error: "SENSITIVE_PATH" });
    }
  });

  it("applies the workspace path policy to remote traversal, absolute, drive, and link paths", async () => {
    const workspace = await makeRemoteWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "local-review-mcp-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.txt"), "outside-secret\n");
    await symlink(
      outside,
      join(workspace, "outside-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const { port } = await startRemoteServer(workspace);
    const client = await connectRemote(port);
    const paths = [
      ["../outside.txt", "INVALID_PATH"],
      [join(workspace, "outside.txt"), "INVALID_PATH"],
      ["D:\\outside\\secret.txt", "INVALID_PATH"],
      ["outside-link/secret.txt", "PATH_OUTSIDE_WORKSPACE"],
    ] as const;

    for (const [path, error] of paths) {
      const result = await client.callTool({ name: "read_file", arguments: { path } });
      expect(result.isError, path).toBe(true);
      expect(toolJson(result), path).toEqual({ error });
    }
  });

  it("restarts the tunnel while retaining the configured connector endpoint", async () => {
    const workspace = await makeRemoteWorkspace();
    let starts = 0;
    let current: TunnelStatus = { state: "LOCAL_ONLY" };
    const provider: TunnelProvider = {
      async start() {
        starts += 1;
        current = { state: "REMOTE_READY", endpoint: REMOTE_ENDPOINT };
        return { endpoint: REMOTE_ENDPOINT };
      },
      async stop() {
        current = { state: "STOPPED" };
      },
      async status() {
        return current;
      },
    };
    const { port, context } = await startRemoteServer(workspace, provider);
    const first = await getHealth(port, `Bearer ${TOKEN}`);
    expect(JSON.parse(first.text)).toMatchObject({
      remote_status: "REMOTE_READY",
      endpoint: REMOTE_ENDPOINT,
    });

    await context.tunnel.stop();
    const stopped = await getHealth(port, `Bearer ${TOKEN}`);
    expect(stopped.status).toBe(200);
    expect(JSON.parse(stopped.text)).toMatchObject({
      remote_status: "STOPPED",
      endpoint_status: "stopped",
    });

    await context.tunnel.start();
    const restarted = await getHealth(port, `Bearer ${TOKEN}`);
    expect(JSON.parse(restarted.text)).toMatchObject({
      remote_status: "REMOTE_READY",
      endpoint: REMOTE_ENDPOINT,
    });
    expect(starts).toBe(2);

    const client = await connectRemote(port);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("workspace_info");
  });
});

const configuredRemoteUrl = process.env.LOCAL_REVIEW_MCP_REMOTE_URL;
const configuredRemoteToken = process.env.LOCAL_REVIEW_MCP_REMOTE_TOKEN;
const externalRemoteIt = configuredRemoteUrl !== undefined && configuredRemoteToken !== undefined
  ? it
  : it.skip;

externalRemoteIt("validates a configured public HTTPS Remote MCP endpoint", async () => {
  if (configuredRemoteUrl === undefined || configuredRemoteToken === undefined) return;
  expect(new URL(configuredRemoteUrl).protocol).toBe("https:");
  const health = await fetch(new URL("/health", configuredRemoteUrl), {
    headers: { authorization: `Bearer ${configuredRemoteToken}` },
  });
  const healthText = await health.text();
  expect(health.status).toBe(200);
  expect(healthText).not.toContain(configuredRemoteToken);
  const client = new Client({ name: "remote-deployment-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(configuredRemoteUrl), {
    requestInit: { headers: { authorization: `Bearer ${configuredRemoteToken}` } },
  });
  try {
    await client.connect(transport);
    expect(client.getServerVersion()).toEqual({ name: "local-review-mcp", version: "0.1.0" });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_REGISTERED_TOOL_NAMES].sort());
  } finally {
    await client.close();
  }
}, 30_000);
