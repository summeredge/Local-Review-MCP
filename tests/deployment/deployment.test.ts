import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { REGISTERED_TOOL_NAMES } from "../../src/mcp/server.js";

const projectDirectory = join(dirname(fileURLToPath(import.meta.url)), "../..");
const preflightScript = join(projectDirectory, "scripts", "preflight-check.ps1");
const startProductionScript = join(projectDirectory, "scripts", "start-production.ps1");
const verifyScript = join(projectDirectory, "scripts", "verify-remote.ps1");
const temporaryDirectories: string[] = [];
const runningServers: Server[] = [];
const runningProcesses = new Set<ChildProcess>();
const REMOTE_TOKEN = "deployment-test-token";
const POWERSHELL_TIMEOUT_MS = 12_000;
const POWERSHELL_TEST_TIMEOUT_MS = 15_000;
const POWERSHELL_BUILD_TIMEOUT_MS = 40_000;
const POWERSHELL_BUILD_TEST_TIMEOUT_MS = 45_000;

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
      if (error !== null && child.exitCode === null) child.kill();
    });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { child.kill("SIGKILL"); }
}

interface ScriptResult {
  readonly code: number;
  readonly output: string;
}

function runPowerShell(
  script: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  timeoutMs = POWERSHELL_TIMEOUT_MS,
): Promise<ScriptResult> {
  const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const shellArgs = ["-NoLogo", "-NoProfile", "-NonInteractive"];
  if (process.platform === "win32") shellArgs.push("-ExecutionPolicy", "Bypass");
  shellArgs.push("-File", script, ...args);

  return new Promise((resolve) => {
    let timedOut = false;
    let outputTooLarge = false;
    let spawnFailed = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(shell, shellArgs, {
      cwd: projectDirectory,
      env: { ...process.env, ...environment },
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    runningProcesses.add(child);
    const append = (target: "stdout" | "stderr", chunk: string) => {
      if (outputTooLarge) return;
      if (target === "stdout") {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > 1024 * 1024) {
          outputTooLarge = true;
          terminateProcessTree(child);
          return;
        }
        stdout += chunk;
      } else {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > 1024 * 1024) {
          outputTooLarge = true;
          terminateProcessTree(child);
          return;
        }
        stderr += chunk;
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => append("stdout", chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => append("stderr", chunk));
    child.once("error", () => { spawnFailed = true; });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timeout);
      runningProcesses.delete(child);
      resolve({ code: timedOut || outputTooLarge || spawnFailed ? 1 : code ?? 1, output: `${stdout}\n${stderr}` });
    });
    child.once("spawn", () => {
      if (timedOut) terminateProcessTree(child);
    });
  });
}

async function makeIsolatedBuildProject(directory: string): Promise<string> {
  const root = join(directory, "build-project");
  await mkdir(join(root, "scripts"), { recursive: true });
  await Promise.all([
    cp(startProductionScript, join(root, "scripts", "start-production.ps1")),
    cp(preflightScript, join(root, "scripts", "preflight-check.ps1")),
    cp(join(projectDirectory, "package.json"), join(root, "package.json")),
  ]);
  const tsconfig = JSON.parse(await readFile(join(projectDirectory, "tsconfig.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  tsconfig.compilerOptions.rootDir = projectDirectory;
  tsconfig.compilerOptions.outDir = join(root, "dist");
  tsconfig.include = ["../../src/**/*.ts", "../../tests/**/*.ts", "src/**/*.ts"];
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  await symlink(join(projectDirectory, "node_modules"), join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir");
  return root;
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

function withoutCloudflared(directory: string): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const nodeDirectory = dirname(process.execPath);
  const pathValue = [
    nodeDirectory,
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ].join(";");
  const missingRoot = join(directory, "missing-cloudflared-home");
  return {
    Path: pathValue,
    PATH: pathValue,
    CLOUDFLARED_PATH: join(missingRoot, "cloudflared.exe"),
    ProgramW6432: missingRoot,
    ProgramFiles: missingRoot,
    "ProgramFiles(x86)": missingRoot,
    LOCALAPPDATA: missingRoot,
    USERPROFILE: missingRoot,
    PSModuleAnalysisCachePath: join(directory, "ModuleAnalysisCache"),
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function writeNpmShim(directory: string, realBuild = false): Promise<void> {
  await writeFile(join(directory, "npm.cmd"), [
    "@echo off",
    "if \"%~1\"==\"--version\" goto version",
    "if \"%~1\"==\"run\" goto run",
    "if \"%~1\"==\"start\" goto start",
    "exit /b 0",
    ":version",
    "echo 10.0.0",
    "exit /b 0",
    ":run",
    "echo run build>>\"%~dp0npm-log.txt\"",
    "if \"%NPM_SHIM_REAL_BUILD%\"==\"1\" goto realbuild",
    "if \"%NPM_SHIM_BUILD_EXIT%\"==\"1\" exit /b 1",
    "exit /b 0",
    ":realbuild",
    "call \"%NPM_SHIM_REAL_NPM%\" %*",
    "exit /b %ERRORLEVEL%",
    ":start",
    "echo start %*>>\"%~dp0npm-log.txt\"",
    "echo start-args [%2][%3][%~4][%~5]>>\"%~dp0npm-log.txt\"",
    "exit /b 0",
    "",
  ].join("\r\n"), "utf8");
}

function withNpmShim(shimDirectory: string, buildExitCode: number, realBuild = false): NodeJS.ProcessEnv {
  const pathValue = [
    shimDirectory,
    dirname(process.execPath),
    process.env.Path ?? process.env.PATH ?? "",
  ].join(";");
  return {
    Path: pathValue,
    PATH: pathValue,
    NPM_SHIM_BUILD_EXIT: String(buildExitCode),
    NPM_SHIM_REAL_BUILD: realBuild ? "1" : "0",
    NPM_SHIM_REAL_NPM: join(dirname(process.execPath), "npm.cmd"),
  };
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
          ? { tools: REGISTERED_TOOL_NAMES.map((name) => ({ name })) }
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
  const processes = [...runningProcesses];
  processes.forEach(terminateProcessTree);
  await Promise.all(processes.map((child) => new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  })));
  await Promise.all(runningServers.splice(0).map(closeServer));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("deployment scripts", () => {
  it("terminates a PowerShell process that exceeds its deadline", async () => {
    const directory = await makeTemporaryDirectory();
    const script = join(directory, "sleep.ps1");
    await writeFile(script, "Start-Sleep -Seconds 30\n");
    const result = await runPowerShell(script, [], {}, 100);

    expect(result.code).not.toBe(0);
  });

  it("fails when the production config is missing", async () => {
    const directory = await makeTemporaryDirectory();
    const result = await runPowerShell(preflightScript, ["-Config", join(directory, "missing.json")]);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/production config.*not found/i);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it("fails when the configured workspace does not exist", async () => {
    const directory = await makeTemporaryDirectory();
    const config = await writeConfig(directory, {
      workspace: join(directory, "missing-workspace"),
      remoteEnabled: false,
    });
    const result = await runPowerShell(preflightScript, ["-Config", config]);

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/workspace.*(missing|directory|accessible)/i);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it("fails when remote access is enabled without cloudflared", async () => {
    const directory = await makeTemporaryDirectory();
    const config = await writeConfig(directory, {
      workspace: directory,
      remoteEnabled: true,
    });
    const result = await runPowerShell(preflightScript, ["-Config", config], withoutCloudflared(directory));

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/cloudflared/i);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it("passes without cloudflared when remote access is disabled", async () => {
    const directory = await makeTemporaryDirectory();
    const config = await writeConfig(directory, {
      workspace: directory,
      remoteEnabled: false,
    });
    const result = await runPowerShell(preflightScript, ["-Config", config], withoutCloudflared(directory));

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/preflight passed/i);
    expect(result.output).toMatch(/cloudflare tunnel: disabled/i);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it("rejects an incorrect remote token", async () => {
    const remoteUrl = await makeRemoteServer();
    const result = await runPowerShell(verifyScript, [], {
      LOCAL_REVIEW_MCP_REMOTE_URL: remoteUrl,
      LOCAL_REVIEW_MCP_REMOTE_TOKEN: "wrong-deployment-token",
    });

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/authenticated health check.*401/i);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it("builds the production runtime before starting it", async () => {
    const directory = await makeTemporaryDirectory();
    const shimDirectory = await makeTemporaryDirectory();
    await writeNpmShim(shimDirectory);
    const configDirectory = join(directory, "Test User", "Local Review MCP");
    await mkdir(configDirectory, { recursive: true });
    const config = await writeConfig(configDirectory, { workspace: directory, remoteEnabled: false });

    const result = await runPowerShell(
      startProductionScript,
      ["-Config", config, "-SkipDesktopBootstrap"],
      withNpmShim(shimDirectory, 0),
    );

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/build: pass \(local-review-mcp /i);
    const npmLog = await readFile(join(shimDirectory, "npm-log.txt"), "utf8");
    expect(npmLog.trim().split(/\r?\n/)).toEqual([
      "run build",
      `start start -- --config "${config}"`,
      `start-args [--][--config][${config}][]`,
    ]);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it("keeps the desktop bootstrap disabled without an explicit opt-in", async () => {
    const directory = await makeTemporaryDirectory();
    const shimDirectory = await makeTemporaryDirectory();
    await writeNpmShim(shimDirectory);
    const config = await writeConfig(directory, { workspace: directory, remoteEnabled: false });

    const result = await runPowerShell(
      startProductionScript,
      ["-Config", config],
      withNpmShim(shimDirectory, 0),
    );

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/desktop bootstrap: disabled/i);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it("does not start the runtime when the production build fails", async () => {
    const directory = await makeTemporaryDirectory();
    const shimDirectory = await makeTemporaryDirectory();
    await writeNpmShim(shimDirectory);
    const config = await writeConfig(directory, { workspace: directory, remoteEnabled: false });

    const result = await runPowerShell(
      startProductionScript,
      ["-Config", config, "-SkipDesktopBootstrap"],
      withNpmShim(shimDirectory, 1),
    );

    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/production build failed/i);
    expect(result.output).not.toMatch(/starting local review mcp/i);
    await expect(readFile(join(shimDirectory, "npm-log.txt"), "utf8"))
      .resolves.toMatch(/^run build\r?\n$/);
  }, POWERSHELL_TEST_TIMEOUT_MS);

  it("compiles the current src into dist before invoking npm start", async () => {
    const directory = await makeTemporaryDirectory();
    const shimDirectory = await makeTemporaryDirectory();
    const buildProject = await makeIsolatedBuildProject(directory);
    const probe = `launcher-build-probe-${randomUUID()}`;
    const sourcePath = join(buildProject, "src", `${probe}.ts`);
    const outputPath = join(buildProject, "dist", relative(projectDirectory, sourcePath).replace(/\.ts$/u, ".js"));
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, `export const buildProbe = ${JSON.stringify(probe)};\n`);

    await writeNpmShim(shimDirectory, true);
    const configDirectory = join(directory, "Test User", "Local Review MCP");
    await mkdir(configDirectory, { recursive: true });
    const config = await writeConfig(configDirectory, { workspace: directory, remoteEnabled: false });
    const result = await runPowerShell(
      join(buildProject, "scripts", "start-production.ps1"),
      ["-Config", config, "-SkipDesktopBootstrap"],
      withNpmShim(shimDirectory, 0, true),
      POWERSHELL_BUILD_TIMEOUT_MS,
    );
    expect(result.code, result.output).toBe(0);
    await expect(readFile(join(buildProject, "dist", "src", "app.js"), "utf8")).resolves.toBeTruthy();
    expect(await readFile(outputPath, "utf8")).toContain(probe);
    expect((await readFile(join(shimDirectory, "npm-log.txt"), "utf8")).trim().split(/\r?\n/))
      .toEqual([
        "run build",
        `start start -- --config "${config}"`,
        `start-args [--][--config][${config}][]`,
      ]);
  }, POWERSHELL_BUILD_TEST_TIMEOUT_MS);

  it("does not start when TypeScript compilation fails", async () => {
    const directory = await makeTemporaryDirectory();
    const shimDirectory = await makeTemporaryDirectory();
    const buildProject = await makeIsolatedBuildProject(directory);
    const probe = `launcher-build-error-${randomUUID()}`;
    const sourcePath = join(buildProject, "src", `${probe}.ts`);
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, `const invalid: number = ${JSON.stringify(probe)};\nexport { invalid };\n`);

    await writeNpmShim(shimDirectory, true);
    const configDirectory = join(directory, "Test User", "Local Review MCP");
    await mkdir(configDirectory, { recursive: true });
    const config = await writeConfig(configDirectory, { workspace: directory, remoteEnabled: false });
    const result = await runPowerShell(
      join(buildProject, "scripts", "start-production.ps1"),
      ["-Config", config, "-SkipDesktopBootstrap"],
      withNpmShim(shimDirectory, 0, true),
      POWERSHELL_BUILD_TIMEOUT_MS,
    );

    expect(result.code).not.toBe(0);
    expect(result.output.replace(/\s+/gu, "")).toMatch(/productionbuildfailed/i);
    expect((await readFile(join(shimDirectory, "npm-log.txt"), "utf8")).trim().split(/\r?\n/))
      .toEqual(["run build"]);
  }, POWERSHELL_BUILD_TEST_TIMEOUT_MS);

  it("verifies health, MCP initialize, and the MCP tools", async () => {
    const remoteUrl = await makeRemoteServer();
    const result = await runPowerShell(verifyScript, [], {
      LOCAL_REVIEW_MCP_REMOTE_URL: remoteUrl,
      LOCAL_REVIEW_MCP_REMOTE_TOKEN: REMOTE_TOKEN,
    });
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/health: passed.*status=ok/i);
    expect(result.output).toMatch(/mcp initialize: passed/i);
    expect(result.output).toMatch(/tools\/list: passed.*\d+ tools/i);
    expect(result.output).toMatch(/remote verification passed/i);
    expect(result.output).not.toContain(REMOTE_TOKEN);
  }, POWERSHELL_TEST_TIMEOUT_MS);
});
