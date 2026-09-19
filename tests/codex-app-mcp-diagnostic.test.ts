import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverCodexAppMcpRuntime,
  parseCodexAppMcpDiagnosticArgs,
  runCodexAppMcpDiagnostic,
} from "../src/desktop-sync/codex-app-mcp-diagnostic.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

function fakeServer(
  mode: "success" | "initialize-failure" | "tools-list-failure" | "hang-initialize" = "success",
): { server: string; log: string; closed: string; pid: string } {
  const root = temporaryRoot("codex-app-mcp");
  const server = join(root, "server.mjs");
  const log = join(root, "requests.log");
  const closed = join(root, "closed");
  const pid = join(root, "pid");
  writeFileSync(server, `
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = ${JSON.stringify(mode)};
const log = ${JSON.stringify(log)};
const closed = ${JSON.stringify(closed)};
writeFileSync(${JSON.stringify(pid)}, String(process.pid));

function reply(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(log, String(request.method) + "\\n");
  if (request.method === "initialize") {
    if (mode === "initialize-failure") {
      reply({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fake initialize failure" } });
    } else if (mode !== "hang-initialize") {
      reply({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-codex-app", version: "1.0.0" },
        },
      });
    }
  } else if (request.method === "tools/list") {
    if (mode === "tools-list-failure") {
      reply({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fake tools/list failure" } });
    } else {
      reply({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [
            { name: "create_thread", description: "fake", inputSchema: { type: "object" } },
            { name: "send_message_to_thread", description: "fake", inputSchema: { type: "object" } },
          ],
        },
      });
    }
  }
});
input.on("close", () => {
  writeFileSync(closed, "closed");
  process.exit(0);
});
setInterval(() => {}, 1000);
`, "utf8");
  return { server, log, closed, pid };
}

function fakeBundle(): { packageRoot: string; executable: string; bundle: string } {
  const packageRoot = temporaryRoot("codex-bundle");
  const executable = join(packageRoot, "app", "ChatGPT.exe");
  const bundle = join(
    packageRoot,
    "app",
    "resources",
    "plugins",
    "openai-bundled",
    "plugins",
    "codex-app-tools",
  );
  mkdirSync(join(bundle, ".codex-plugin"), { recursive: true });
  mkdirSync(join(bundle, "scripts"), { recursive: true });
  mkdirSync(join(packageRoot, "app"), { recursive: true });
  writeFileSync(executable, "", "utf8");
  writeFileSync(join(packageRoot, "AppxManifest.xml"),
    "<Identity Name=\"OpenAI.Codex\" Version=\"26.915.4065.0\" />", "utf8");
  writeFileSync(join(bundle, ".codex-plugin", "plugin.json"),
    JSON.stringify({ version: "0.1.4" }), "utf8");
  writeFileSync(join(bundle, ".mcp.json"), JSON.stringify({
    mcpServers: {
      codex_app: {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "call", "./scripts/launch_codex_app_tools_mcp.cmd", "./server.mjs"],
        cwd: ".",
        env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_MCP_NODE_PATH"],
      },
    },
  }), "utf8");
  writeFileSync(join(bundle, "server.mjs"), "", "utf8");
  writeFileSync(join(bundle, "scripts", "launch_codex_app_tools_mcp.cmd"), "", "utf8");
  return { packageRoot, executable, bundle };
}

async function waitForFile(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      readFileSync(path, "utf8");
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return false;
}

describe("codex app MCP diagnostic", () => {
  it("parses explicit server and pipe overrides", () => {
    expect(parseCodexAppMcpDiagnosticArgs([
      "--server", "C:/server.mjs", "--pipe", "\\\\.\\pipe\\codex-test",
    ])).toEqual({ serverPath: "C:/server.mjs", pipePath: "\\\\.\\pipe\\codex-test" });
  });

  it("discovers the current Desktop bundle contract and runtime pipe from supplied evidence", async () => {
    const bundle = fakeBundle();
    const runtime = await discoverCodexAppMcpRuntime({
      environment: {
        CODEX_APP_TOOLS_PIPE_PATH: "\\\\.\\pipe\\codex-test",
        CODEX_VERSION: "0.155.0-alpha.9.2",
      },
      processReader: async () => [{ name: "ChatGPT.exe", executablePath: bundle.executable }],
    });

    expect(runtime).toMatchObject({
      command: "cmd.exe",
      cwd: bundle.bundle,
      desktopDetected: true,
      bundleDetected: true,
      mcpTransport: "stdio",
      nativeDesktopTransport: "windows_named_pipe",
      desktopVersion: "26.915.4065.0",
      codexVersion: "0.155.0-alpha.9.2",
      codexAppToolsVersion: "0.1.4",
      pipeDiscovery: "current_environment",
    });
    expect(runtime.environmentOverrides.CODEX_APP_TOOLS_PIPE_PATH).toBe("\\\\.\\pipe\\codex-test");
  });

  it("fails closed when Desktop is not running or the bundle is absent", async () => {
    const notRunning = await runCodexAppMcpDiagnostic([], {
      environment: {},
      processReader: async () => [],
    });
    expect(notRunning).toMatchObject({
      ok: false,
      stage: "desktop_not_running",
      desktopDetected: false,
      bundleDetected: false,
      mcpStarted: false,
    });

    const missingBundle = await runCodexAppMcpDiagnostic([], {
      environment: {},
      processReader: async () => [{ name: "ChatGPT.exe", executablePath: join(temporaryRoot("missing"), "ChatGPT.exe") }],
    });
    expect(missingBundle).toMatchObject({
      ok: false,
      stage: "bundle_not_found",
      desktopDetected: true,
      bundleDetected: false,
    });
  });

  it("reports missing pipe discovery without guessing a pipe name", async () => {
    const bundle = fakeBundle();
    const result = await runCodexAppMcpDiagnostic([], {
      environment: {},
      processReader: async () => [{ name: "ChatGPT.exe", executablePath: bundle.executable }],
    });
    expect(result).toMatchObject({
      ok: false,
      stage: "pipe_discovery_unavailable",
      desktopDetected: true,
      bundleDetected: true,
      mcpTransport: "stdio",
      nativeDesktopTransport: "windows_named_pipe",
      pipeDiscovery: "unavailable",
    });
  });

  it("uses an explicit server override and completes initialize plus tools/list", async () => {
    const fake = fakeServer();
    const result = await runCodexAppMcpDiagnostic(["--server", fake.server], { environment: {} });
    expect(result).toMatchObject({
      ok: true,
      stage: "ok",
      mcpStarted: true,
      initialized: true,
      toolsListed: true,
      toolCount: 2,
      tools: ["create_thread", "send_message_to_thread"],
      mcpTransport: "stdio",
    });
    expect(readFileSync(fake.log, "utf8").split(/\r?\n/).filter(Boolean))
      .toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(readFileSync(fake.log, "utf8")).not.toContain("tools/call");
  });

  it("honors the explicit pipe override for a bundle runtime", async () => {
    const bundle = fakeBundle();
    const runtime = await discoverCodexAppMcpRuntime({
      serverPath: join(bundle.bundle, "server.mjs"),
      pipePath: "\\\\.\\pipe\\explicit-codex-test",
      environment: {},
    });
    expect(runtime.pipeDiscovery).toBe("explicit_override");
    expect(runtime.environmentOverrides.CODEX_APP_TOOLS_PIPE_PATH)
      .toBe("\\\\.\\pipe\\explicit-codex-test");
  });

  it("classifies initialize and tools/list failures separately", async () => {
    const initializeFailure = fakeServer("initialize-failure");
    await expect(runCodexAppMcpDiagnostic(["--server", initializeFailure.server], { environment: {} }))
      .resolves.toMatchObject({ stage: "mcp_initialize_failed", mcpStarted: true, initialized: false });

    const toolsFailure = fakeServer("tools-list-failure");
    await expect(runCodexAppMcpDiagnostic(["--server", toolsFailure.server], { environment: {} }))
      .resolves.toMatchObject({ stage: "tools_list_failed", mcpStarted: true, initialized: true });
  });

  it("closes the diagnostic-owned child after normal completion", async () => {
    const fake = fakeServer();
    await runCodexAppMcpDiagnostic(["--server", fake.server], { environment: {} });
    expect(await waitForFile(fake.closed)).toBe(true);
  });

  it("stops and cleans up on Ctrl+C", async () => {
    const fake = fakeServer("hang-initialize");
    const running = runCodexAppMcpDiagnostic(["--server", fake.server], { environment: {} });
    expect(await waitForFile(fake.pid)).toBe(true);
    process.emit("SIGINT");
    await expect(running).resolves.toMatchObject({
      ok: false,
      stage: "diagnostic_interrupted",
      mcpStarted: true,
    });
    expect(await waitForFile(fake.closed)).toBe(true);
  });
});
