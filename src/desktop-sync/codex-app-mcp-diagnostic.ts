import { execFile as defaultExecFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const PIPE_ENV_VAR = "CODEX_APP_TOOLS_PIPE_PATH";
const DESKTOP_PROCESS_NAME = "ChatGPT.exe";
const CODEX_APP_TOOLS_PLUGIN = [
  "resources",
  "plugins",
  "openai-bundled",
  "plugins",
  "codex-app-tools",
] as const;
const LAUNCHER_NAME = "launch_codex_app_tools_mcp.cmd";
const SERVER_NAME = "server.mjs";
const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  `Get-CimInstance Win32_Process -Filter \"Name = '${DESKTOP_PROCESS_NAME}'\"`,
  "| Select-Object Name, ExecutablePath",
  "| ConvertTo-Json -Compress",
].join(" ");

const execFile = promisify(defaultExecFile);

export type CodexAppMcpDiagnosticStage =
  | "ok"
  | "desktop_not_running"
  | "bundle_not_found"
  | "runtime_contract_unknown"
  | "pipe_discovery_unavailable"
  | "mcp_spawn_failed"
  | "mcp_initialize_failed"
  | "tools_list_failed"
  | "diagnostic_interrupted";

export interface DesktopProcessMetadata {
  readonly name?: string;
  readonly executablePath?: string;
}

export interface CodexAppMcpRuntime {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environmentOverrides: Readonly<Record<string, string>>;
  readonly desktopDetected: boolean;
  readonly bundleDetected: boolean;
  readonly mcpTransport: "stdio";
  readonly nativeDesktopTransport: "windows_named_pipe" | "unknown";
  readonly requiresNativePipe: boolean;
  readonly discoverySource: "desktop_bundle" | "explicit_override";
  readonly desktopVersion?: string;
  readonly codexVersion?: string;
  readonly codexAppToolsVersion?: string;
  readonly pipeDiscovery?: "explicit_override" | "current_environment";
  readonly serverInfo: StdioServerParameters;
}

interface DiagnosticState {
  readonly desktopDetected: boolean;
  readonly bundleDetected: boolean;
  readonly mcpTransport?: "stdio";
  readonly nativeDesktopTransport?: "windows_named_pipe" | "unknown";
  readonly desktopVersion?: string;
  readonly codexVersion?: string;
  readonly codexAppToolsVersion?: string;
  readonly pipeDiscovery?: "explicit_override" | "current_environment" | "unavailable";
}

export interface CodexAppMcpDiagnosticResult extends DiagnosticState {
  readonly ok: boolean;
  readonly stage: CodexAppMcpDiagnosticStage;
  readonly mcpStarted: boolean;
  readonly initialized: boolean;
  readonly toolsListed: boolean;
  readonly toolCount: number;
  readonly tools: readonly string[];
}

export interface CodexAppMcpDiagnosticArgs {
  readonly serverPath?: string;
  readonly pipePath?: string;
}

export interface CodexAppMcpDiscoveryOptions {
  readonly serverPath?: string;
  readonly pipePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly processReader?: () => Promise<readonly DesktopProcessMetadata[]>;
}

export interface CodexAppMcpDiagnosticDependencies extends CodexAppMcpDiscoveryOptions {
  readonly createClient?: () => Client;
  readonly createTransport?: (server: StdioServerParameters) => StdioClientTransport;
}

export class CodexAppMcpDiagnosticError extends Error {
  public constructor(
    public readonly stage: Exclude<CodexAppMcpDiagnosticStage, "ok">,
    public readonly state: DiagnosticState,
  ) {
    super(stage);
    this.name = "CodexAppMcpDiagnosticError";
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function safeVersion(value: unknown): string | undefined {
  const text = nonEmpty(value);
  return text !== undefined && /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$/.test(text)
    ? text
    : undefined;
}

function stateFor(values: Partial<DiagnosticState> = {}): DiagnosticState {
  return {
    desktopDetected: values.desktopDetected ?? false,
    bundleDetected: values.bundleDetected ?? false,
    ...(values.mcpTransport === undefined ? {} : { mcpTransport: values.mcpTransport }),
    ...(values.nativeDesktopTransport === undefined
      ? {}
      : { nativeDesktopTransport: values.nativeDesktopTransport }),
    ...(values.desktopVersion === undefined ? {} : { desktopVersion: values.desktopVersion }),
    ...(values.codexVersion === undefined ? {} : { codexVersion: values.codexVersion }),
    ...(values.codexAppToolsVersion === undefined
      ? {}
      : { codexAppToolsVersion: values.codexAppToolsVersion }),
    ...(values.pipeDiscovery === undefined ? {} : { pipeDiscovery: values.pipeDiscovery }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonArray(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

async function readDesktopProcesses(): Promise<readonly DesktopProcessMetadata[]> {
  if (process.platform !== "win32") return [];
  try {
    const result = await execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      POWERSHELL_SCRIPT,
    ], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    const parsed: unknown = JSON.parse(result.stdout.toString());
    return parseJsonArray(parsed).map((entry) => ({
      ...(typeof entry.Name === "string" ? { name: entry.Name } : {}),
      ...(typeof entry.ExecutablePath === "string" ? { executablePath: entry.ExecutablePath } : {}),
    }));
  } catch {
    return [];
  }
}

function readObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface BundleContract {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environmentNames: readonly string[];
  readonly version?: string;
}

function readBundleContract(bundlePath: string): BundleContract | undefined {
  const config = readObject(join(bundlePath, ".mcp.json"));
  const servers = config?.mcpServers;
  const codexApp = isRecord(servers) ? servers.codex_app : undefined;
  if (!isRecord(codexApp)) return undefined;

  const command = nonEmpty(codexApp.command);
  const args = Array.isArray(codexApp.args)
    ? codexApp.args.filter((value): value is string => typeof value === "string")
    : [];
  const cwd = nonEmpty(codexApp.cwd) ?? ".";
  const environmentNames = Array.isArray(codexApp.env_vars)
    ? codexApp.env_vars.filter((value): value is string => typeof value === "string" && value.trim() !== "")
    : [];
  const plugin = readObject(join(bundlePath, ".codex-plugin", "plugin.json"));
  const version = safeVersion(plugin?.version);
  if (command === undefined || args.length === 0 || environmentNames.length === 0) return undefined;
  return {
    command,
    args,
    cwd,
    environmentNames,
    ...(version === undefined ? {} : { version }),
  };
}

function readDesktopVersion(executablePath: string): string | undefined {
  const manifest = join(dirname(dirname(executablePath)), "AppxManifest.xml");
  try {
    const content = readFileSync(manifest, "utf8");
    return safeVersion(content.match(/<Identity\b[^>]*\bVersion="([^"]+)"/i)?.[1]);
  } catch {
    return undefined;
  }
}

function bundleFilesExist(bundlePath: string): boolean {
  return [
    join(bundlePath, ".mcp.json"),
    join(bundlePath, ".codex-plugin", "plugin.json"),
    join(bundlePath, SERVER_NAME),
    join(bundlePath, "scripts", LAUNCHER_NAME),
  ].every((path) => existsSync(path));
}

function environmentOverrides(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
  pipePath: string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = nonEmpty(environment[name]);
    if (value !== undefined) result[name] = value;
  }
  if (pipePath !== undefined) result[PIPE_ENV_VAR] = pipePath;
  return result;
}

function pipeFor(
  explicitPipePath: string | undefined,
  environment: NodeJS.ProcessEnv,
): { readonly path?: string; readonly source?: "explicit_override" | "current_environment" } {
  const explicit = nonEmpty(explicitPipePath);
  if (explicit !== undefined) return { path: explicit, source: "explicit_override" };
  const inherited = nonEmpty(environment[PIPE_ENV_VAR]);
  return inherited === undefined ? {} : { path: inherited, source: "current_environment" };
}

function runtimeFromBundle(
  bundlePath: string,
  options: CodexAppMcpDiscoveryOptions,
  state: DiagnosticState,
  desktopExecutablePath?: string,
  source: "desktop_bundle" | "explicit_override" = "desktop_bundle",
): CodexAppMcpRuntime {
  const environment = options.environment ?? process.env;
  const contract = readBundleContract(bundlePath);
  const commonState = stateFor({
    ...state,
    mcpTransport: "stdio",
    nativeDesktopTransport: "windows_named_pipe",
    ...(contract?.version === undefined ? {} : { codexAppToolsVersion: contract.version }),
  });
  if (contract === undefined) {
    throw new CodexAppMcpDiagnosticError("runtime_contract_unknown", commonState);
  }
  const pipe = pipeFor(options.pipePath, environment);
  if (pipe.path === undefined) {
    throw new CodexAppMcpDiagnosticError("pipe_discovery_unavailable", stateFor({
      ...commonState,
      pipeDiscovery: "unavailable",
    }));
  }
  const serverInfo: StdioServerParameters = {
    command: contract.command,
    args: [...contract.args],
    cwd: isAbsolute(contract.cwd) ? contract.cwd : resolve(bundlePath, contract.cwd),
    env: environmentOverrides(contract.environmentNames, environment, pipe.path),
    stderr: "pipe",
  };
  const desktopVersion = state.desktopVersion ?? (
    desktopExecutablePath === undefined ? undefined : readDesktopVersion(desktopExecutablePath)
  );
  return {
    command: serverInfo.command,
    args: serverInfo.args ?? [],
    cwd: serverInfo.cwd ?? bundlePath,
    environmentOverrides: serverInfo.env ?? {},
    desktopDetected: state.desktopDetected,
    bundleDetected: state.bundleDetected,
    mcpTransport: "stdio",
    nativeDesktopTransport: "windows_named_pipe",
    requiresNativePipe: true,
    discoverySource: source,
    ...(desktopVersion === undefined ? {} : { desktopVersion }),
    ...(state.codexVersion === undefined ? {} : { codexVersion: state.codexVersion }),
    ...(contract.version === undefined ? {} : { codexAppToolsVersion: contract.version }),
    ...(pipe.source === undefined ? {} : { pipeDiscovery: pipe.source }),
    serverInfo,
  };
}

function runtimeFromExplicitServer(
  serverPath: string,
  options: CodexAppMcpDiscoveryOptions,
): CodexAppMcpRuntime {
  const environment = options.environment ?? process.env;
  const resolvedServer = resolve(serverPath);
  const candidate = existsSync(resolvedServer) ? resolvedServer : join(resolvedServer, SERVER_NAME);
  if (!existsSync(candidate)) {
    throw new CodexAppMcpDiagnosticError("bundle_not_found", stateFor());
  }
  const bundlePath = dirname(candidate);
  const state = stateFor({ bundleDetected: bundleFilesExist(bundlePath) });
  if (state.bundleDetected) {
    return runtimeFromBundle(bundlePath, options, state, undefined, "explicit_override");
  }

  const node = nonEmpty(environment.CODEX_MCP_NODE_PATH);
  const command = node !== undefined && existsSync(node) ? node : process.execPath;
  const pipe = pipeFor(options.pipePath, environment);
  const serverInfo: StdioServerParameters = {
    command,
    args: [candidate],
    cwd: dirname(candidate),
    ...(pipe.path === undefined ? {} : { env: { [PIPE_ENV_VAR]: pipe.path } }),
    stderr: "pipe",
  };
  return {
    command,
    args: [candidate],
    cwd: dirname(candidate),
    environmentOverrides: serverInfo.env ?? {},
    desktopDetected: false,
    bundleDetected: false,
    mcpTransport: "stdio",
    nativeDesktopTransport: "unknown",
    requiresNativePipe: false,
    discoverySource: "explicit_override",
    ...(pipe.source === undefined ? {} : { pipeDiscovery: pipe.source }),
    serverInfo,
  };
}

export function parseCodexAppMcpDiagnosticArgs(
  argv: readonly string[] = [],
): CodexAppMcpDiagnosticArgs {
  let serverPath: string | undefined;
  let pipePath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument !== "--server" && argument !== "--pipe") {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === "") {
      throw new Error(`${argument} requires a value.`);
    }
    if (argument === "--server") serverPath = value;
    else pipePath = value;
    index += 1;
  }
  return {
    ...(serverPath === undefined ? {} : { serverPath }),
    ...(pipePath === undefined ? {} : { pipePath }),
  };
}

export async function discoverCodexAppMcpRuntime(
  options: CodexAppMcpDiscoveryOptions = {},
): Promise<CodexAppMcpRuntime> {
  const environment = options.environment ?? process.env;
  const codexVersion = safeVersion(environment.CODEX_VERSION);
  if (options.serverPath !== undefined) {
    return runtimeFromExplicitServer(options.serverPath, options);
  }

  const processes = await (options.processReader ?? readDesktopProcesses)();
  const namedDesktopProcess = processes.find((entry) => entry.name?.toLowerCase() === DESKTOP_PROCESS_NAME.toLowerCase());
  if (namedDesktopProcess === undefined) {
    throw new CodexAppMcpDiagnosticError("desktop_not_running", stateFor({ codexVersion }));
  }
  const executablePath = nonEmpty(namedDesktopProcess.executablePath);
  if (executablePath === undefined) {
    throw new CodexAppMcpDiagnosticError("bundle_not_found", stateFor({
      desktopDetected: true,
      codexVersion,
    }));
  }
  const bundlePath = join(dirname(executablePath), ...CODEX_APP_TOOLS_PLUGIN);
  const bundleDetected = bundleFilesExist(bundlePath);
  const state = stateFor({
    desktopDetected: true,
    bundleDetected,
    ...(bundleDetected ? { mcpTransport: "stdio" as const, nativeDesktopTransport: "windows_named_pipe" as const } : {}),
    desktopVersion: readDesktopVersion(executablePath),
    codexVersion,
  });
  if (!bundleDetected) {
    throw new CodexAppMcpDiagnosticError("bundle_not_found", state);
  }
  return runtimeFromBundle(bundlePath, options, state, executablePath);
}

export interface ConnectedCodexAppMcp {
  readonly client: Client;
  readonly transport: StdioClientTransport;
}

function makeClient(): Client {
  return new Client({
    name: "local-review-mcp-codex-app-mcp-diagnostic",
    version: "0.1.0",
  });
}

type ConnectionOptions = Pick<CodexAppMcpDiagnosticDependencies, "createClient" | "createTransport"> & {
  readonly signal?: AbortSignal;
};

function createCodexAppMcpConnection(
  runtime: CodexAppMcpRuntime,
  options: ConnectionOptions = {},
): ConnectedCodexAppMcp {
  const client = (options.createClient ?? makeClient)();
  const transport = (options.createTransport ?? ((server) => new StdioClientTransport(server)))(runtime.serverInfo);
  return { client, transport };
}

export async function connectCodexAppMcp(
  runtime: CodexAppMcpRuntime,
  options: ConnectionOptions = {},
): Promise<ConnectedCodexAppMcp> {
  const { client, transport } = createCodexAppMcpConnection(runtime, options);
  await client.connect(transport, options.signal === undefined ? undefined : { signal: options.signal });
  return { client, transport };
}

function resultFrom(
  state: DiagnosticState,
  stage: CodexAppMcpDiagnosticStage,
  values: Partial<Pick<CodexAppMcpDiagnosticResult, "mcpStarted" | "initialized" | "toolsListed" | "toolCount" | "tools">> = {},
): CodexAppMcpDiagnosticResult {
  const tools = values.tools ?? [];
  return {
    ...state,
    ok: stage === "ok",
    stage,
    mcpStarted: values.mcpStarted ?? false,
    initialized: values.initialized ?? false,
    toolsListed: values.toolsListed ?? false,
    toolCount: values.toolCount ?? tools.length,
    tools,
  };
}

function stateFromRuntime(runtime: CodexAppMcpRuntime): DiagnosticState {
  return stateFor({
    desktopDetected: runtime.desktopDetected,
    bundleDetected: runtime.bundleDetected,
    mcpTransport: runtime.mcpTransport,
    nativeDesktopTransport: runtime.nativeDesktopTransport,
    desktopVersion: runtime.desktopVersion,
    codexVersion: runtime.codexVersion,
    codexAppToolsVersion: runtime.codexAppToolsVersion,
    pipeDiscovery: runtime.pipeDiscovery,
  });
}

export async function runCodexAppMcpDiagnostic(
  argv: readonly string[] = [],
  dependencies: CodexAppMcpDiagnosticDependencies = {},
): Promise<CodexAppMcpDiagnosticResult> {
  const args = parseCodexAppMcpDiagnosticArgs(argv);
  let runtime: CodexAppMcpRuntime;
  try {
    runtime = await discoverCodexAppMcpRuntime({
      ...dependencies,
      serverPath: args.serverPath ?? dependencies.serverPath,
      pipePath: args.pipePath ?? dependencies.pipePath,
    });
  } catch (error: unknown) {
    if (error instanceof CodexAppMcpDiagnosticError) {
      return resultFrom(error.state, error.stage);
    }
    return resultFrom(stateFor(), "runtime_contract_unknown");
  }

  const state = stateFromRuntime(runtime);
  const abortController = new AbortController();
  let interrupted = false;
  const stop = (): void => {
    interrupted = true;
    abortController.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const { client, transport } = createCodexAppMcpConnection(runtime, dependencies);
  let started = false;
  let initialized = false;
  let tools: string[] = [];
  try {
    const originalStart = transport.start.bind(transport);
    transport.start = async (): Promise<void> => {
      await originalStart();
      started = true;
    };
    try {
      await client.connect(transport, { signal: abortController.signal });
      initialized = true;
    } catch {
      const stage: CodexAppMcpDiagnosticStage = interrupted
        ? "diagnostic_interrupted"
        : started ? "mcp_initialize_failed" : "mcp_spawn_failed";
      return resultFrom(state, stage, { mcpStarted: started });
    }
    try {
      const listed = await client.listTools(undefined, { signal: abortController.signal });
      tools = listed.tools.map((tool) => tool.name);
      return resultFrom(state, "ok", {
        mcpStarted: started,
        initialized,
        toolsListed: true,
        toolCount: tools.length,
        tools,
      });
    } catch {
      return resultFrom(state, interrupted ? "diagnostic_interrupted" : "tools_list_failed", {
        mcpStarted: started,
        initialized,
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
