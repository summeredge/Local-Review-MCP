import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";

const projectDirectory = join(dirname(fileURLToPath(import.meta.url)), "../..");
const preflightScript = join(projectDirectory, "scripts", "preflight-check.ps1");
const verifyScript = join(projectDirectory, "scripts", "verify-remote.ps1");
const temporaryDirectories: string[] = [];
const runningServers: Server[] = [];
const REMOTE_TOKEN = "deployment-test-token";

interface ScriptResult {
  readonly code: number;
  readonly output: string;
}

function runPowerShell(
  script: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<ScriptResult> {
  const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const shellArgs = ["-NoLogo", "-NoProfile", "-NonInteractive"];
  if (process.platform === "win32") shellArgs.push("-ExecutionPolicy", "Bypass");
  shellArgs.push("-File", script, ...args);

  return new Promise((resolve) => {
    execFile(shell, shellArgs, {
      cwd: projectDirectory,
      env: { ...process.env, ...environment },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = error === null
        ? 0
        : typeof error.code === "number" ? error.code : 1;
      resolve({ code, output: `${stdout}\n${stderr}` });
    });
  });
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(projectDirectory, "deployment-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function writeConfig(
  directory: string,
  options: { workspace: string; remoteEnabled: boolean },
): Promise<string> {
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify({
    port: await getFreePort(),
    workspace: options.workspace,
    auth: { token: "deployment-test-token" },
    remote: {
      enabled: options.remoteEnabled,
      provider: "cloudflare",
      ...(options.remoteEnabled ? {
        tunnelName: "review-tunnel",
        endpoint: "https://review.example/mcp",
      } : { endpoint: "" }),
    },
    supervisor: {
      enabled: false,
      healthIntervalSeconds: 30,
      maxRestartAttempts: 3,
    },
  }));
  return path;
}

function withoutCloudflared(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const nodeDirectory = dirname(process.execPath);
  const pathValue = [
    nodeDirectory,
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].join(";");
  const missingRoot = join(projectDirectory, "missing-cloudflared-home");
  return {
    Path: pathValue,
    PATH: pathValue,
    CLOUDFLARED_PATH: join(missingRoot, "cloudflared.exe"),
    ProgramW6432: missingRoot,
    ProgramFiles: missingRoot,
    "ProgramFiles(x86)": missingRoot,
    LOCALAPPDATA: missingRoot,
    USERPROFILE: missingRoot,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function makeRemoteServer(): Promise<string> {
  const server = createServer((request, response) => {
    void (async () => {
      const authorization = request.headers.authorization;
      if (request.url === "/health") {
        if (authorization !== `Bearer ${REMOTE_TOKEN}`) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url !== "/mcp" || request.method !== "POST") {
        response.writeHead(404);
        response.end();
        return;
      }
      if (authorization !== `Bearer ${REMOTE_TOKEN}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const message = JSON.parse(body) as { id?: unknown; method?: unknown };
      const result = message.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "local-review-mcp", version: "0.1.0" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                "workspace_info",
                "list_files",
                "read_file",
                "search_text",
                "git_status",
                "git_diff",
              ].map((name) => ({ name })),
            }
          : undefined;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result,
      })}\n\n`);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  runningServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("remote server has no port");
  return `http://127.0.0.1:${address.port}/mcp`;
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(closeServer));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("deployment scripts", () => {
  it("fails when the production config is missing", async () => {
    const directory = await makeTemporaryDirectory();
    const result = await runPowerShell(preflightScript, ["-Config", join(directory, "missing.json")]);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/production config.*not found/i);
  });

  it("fails when the configured workspace does not exist", async () => {
    const directory = await makeTemporaryDirectory();
    const config = await writeConfig(directory, {
      workspace: join(directory, "missing-workspace"),
      remoteEnabled: false,
    });
    const result = await runPowerShell(preflightScript, ["-Config", config]);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/workspace.*(missing|directory|accessible)/i);
  });

  it("fails when remote access is enabled without cloudflared", async () => {
    const directory = await makeTemporaryDirectory();
    const config = await writeConfig(directory, {
      workspace: directory,
      remoteEnabled: true,
    });
    const result = await runPowerShell(preflightScript, ["-Config", config], withoutCloudflared());

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/cloudflared/i);
  });

  it("passes without cloudflared when remote access is disabled", async () => {
    const directory = await makeTemporaryDirectory();
    const config = await writeConfig(directory, {
      workspace: directory,
      remoteEnabled: false,
    });
    const result = await runPowerShell(preflightScript, ["-Config", config], withoutCloudflared());

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/preflight passed/i);
    expect(result.output).toMatch(/cloudflare tunnel: disabled/i);
  });

  it("rejects an incorrect remote token", async () => {
    const remoteUrl = await makeRemoteServer();
    const result = await runPowerShell(verifyScript, [], {
      LOCAL_REVIEW_MCP_REMOTE_URL: remoteUrl,
      LOCAL_REVIEW_MCP_REMOTE_TOKEN: "wrong-deployment-token",
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/authenticated health check.*401/i);
  });

  it("verifies health, MCP initialize, and the six read-only tools", async () => {
    const remoteUrl = await makeRemoteServer();
    const result = await runPowerShell(verifyScript, [], {
      LOCAL_REVIEW_MCP_REMOTE_URL: remoteUrl,
      LOCAL_REVIEW_MCP_REMOTE_TOKEN: REMOTE_TOKEN,
    });
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/health: passed.*status=ok/i);
    expect(result.output).toMatch(/mcp initialize: passed/i);
    expect(result.output).toMatch(/tools\/list: passed.*six read-only tools/i);
    expect(result.output).toMatch(/remote verification passed/i);
    expect(result.output).not.toContain(REMOTE_TOKEN);
  });
});
