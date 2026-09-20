import { execFile as defaultExecFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolRequestParams, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const CODEX_APP_TOOLS_PIPE_ENV = "CODEX_APP_TOOLS_PIPE_PATH" as const;
export const CODEX_APP_EXECUTOR_METADATA_KEY = "openai/threadId" as const;

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

export type CodexAppRuntimeErrorCode =
  | "runtime_unavailable"
  | "bundle_not_found"
  | "runtime_contract_incompatible"
  | "pipe_unavailable"
  | "transport_failed"
  | "tool_contract_incompatible"
  | "executor_thread_missing"
  | "tool_call_timeout"
  | "tool_call_aborted"
  | "tool_call_failed"
  | "project_not_found"
  | "project_ambiguous"
  | "invalid_project_result"
  | "thread_identity_missing"
  | "thread_identity_conflict";

export interface DesktopProcessMetadata {
  readonly name?: string;
  readonly executablePath?: string;
}

export interface CodexAppRuntimeMetadata {
  readonly desktopDetected: boolean;
  readonly bundleDetected: boolean;
  readonly mcpTransport?: "stdio";
  readonly nativeDesktopTransport?: "windows_named_pipe" | "unknown";
  readonly desktopVersion?: string;
  readonly codexVersion?: string;
  readonly codexAppToolsVersion?: string;
  readonly pipeDiscovery?: "explicit_override" | "current_environment" | "unavailable";
}

export interface CodexAppRuntimeInfo extends CodexAppRuntimeMetadata {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environmentOverrides: Readonly<Record<string, string>>;
  readonly requiresNativePipe: boolean;
  readonly discoverySource: "desktop_bundle" | "explicit_override";
  readonly serverInfo: StdioServerParameters;
}

export interface CodexAppRuntimeDiscoveryOptions {
  /** Test/diagnostic override; production discovery omits this field. */
  readonly serverPath?: string;
  readonly pipePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly processReader?: () => Promise<readonly DesktopProcessMetadata[]>;
}

export type CodexAppMcpClient = Pick<Client, "connect" | "listTools" | "callTool" | "close">;
export type CodexAppMcpTransport = Transport;

export interface CodexAppRuntimeConnectionOptions {
  readonly createClient?: () => CodexAppMcpClient;
  readonly createTransport?: (server: StdioServerParameters) => CodexAppMcpTransport;
  readonly signal?: AbortSignal;
  readonly onTransportStarted?: () => void;
}

export interface CallCodexAppToolInput {
  readonly client: Pick<CodexAppMcpClient, "callTool">;
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly executorThreadId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class CodexAppRuntimeError extends Error {
  public constructor(
    public readonly code: CodexAppRuntimeErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly metadata?: CodexAppRuntimeMetadata } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexAppRuntimeError";
    this.metadata = options.metadata ?? { desktopDetected: false, bundleDetected: false };
  }

  public readonly metadata: CodexAppRuntimeMetadata;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function safeVersion(value: unknown): string | undefined {
  const text = nonEmpty(value);
  return text !== undefined && /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$/u.test(text)
    ? text
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateFor(values: Partial<CodexAppRuntimeMetadata> = {}): CodexAppRuntimeMetadata {
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
    return safeVersion(content.match(/<Identity\b[^>]*\bVersion="([^"]+)"/iu)?.[1]);
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
  if (pipePath !== undefined) result[CODEX_APP_TOOLS_PIPE_ENV] = pipePath;
  return result;
}

function pipeFor(
  explicitPipePath: string | undefined,
  environment: NodeJS.ProcessEnv,
): { readonly path?: string; readonly source?: "explicit_override" | "current_environment" } {
  const explicit = nonEmpty(explicitPipePath);
  if (explicit !== undefined) return { path: explicit, source: "explicit_override" };
  const inherited = nonEmpty(environment[CODEX_APP_TOOLS_PIPE_ENV]);
  return inherited === undefined ? {} : { path: inherited, source: "current_environment" };
}

function runtimeFromBundle(
  bundlePath: string,
  options: CodexAppRuntimeDiscoveryOptions,
  state: CodexAppRuntimeMetadata,
  desktopExecutablePath?: string,
  source: "desktop_bundle" | "explicit_override" = "desktop_bundle",
): CodexAppRuntimeInfo {
  const environment = options.environment ?? process.env;
  const contract = readBundleContract(bundlePath);
  const commonState = stateFor({
    ...state,
    mcpTransport: "stdio",
    nativeDesktopTransport: "windows_named_pipe",
    ...(contract?.version === undefined ? {} : { codexAppToolsVersion: contract.version }),
  });
  if (contract === undefined) {
    throw new CodexAppRuntimeError("runtime_contract_incompatible", "codex_app runtime contract is unavailable.", {
      metadata: commonState,
    });
  }
  const pipe = pipeFor(options.pipePath, environment);
  if (pipe.path === undefined) {
    throw new CodexAppRuntimeError("pipe_unavailable", "codex_app native pipe is unavailable.", {
      metadata: stateFor({ ...commonState, pipeDiscovery: "unavailable" }),
    });
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
  options: CodexAppRuntimeDiscoveryOptions,
): CodexAppRuntimeInfo {
  const environment = options.environment ?? process.env;
  const resolvedServer = resolve(serverPath);
  const candidate = existsSync(resolvedServer) ? resolvedServer : join(resolvedServer, SERVER_NAME);
  if (!existsSync(candidate)) {
    throw new CodexAppRuntimeError("bundle_not_found", "codex_app server override is unavailable.");
  }
  const bundlePath = dirname(candidate);
  const state = stateFor({ bundleDetected: bundleFilesExist(bundlePath) });
  if (state.bundleDetected) return runtimeFromBundle(bundlePath, options, state, undefined, "explicit_override");

  const node = nonEmpty(environment.CODEX_MCP_NODE_PATH);
  const command = node !== undefined && existsSync(node) ? node : process.execPath;
  const pipe = pipeFor(options.pipePath, environment);
  const serverInfo: StdioServerParameters = {
    command,
    args: [candidate],
    cwd: dirname(candidate),
    ...(pipe.path === undefined ? {} : { env: { [CODEX_APP_TOOLS_PIPE_ENV]: pipe.path } }),
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

export async function discoverCodexAppRuntime(
  options: CodexAppRuntimeDiscoveryOptions = {},
): Promise<CodexAppRuntimeInfo> {
  const environment = options.environment ?? process.env;
  const codexVersion = safeVersion(environment.CODEX_VERSION);
  if (options.serverPath !== undefined) return runtimeFromExplicitServer(options.serverPath, options);

  let processes: readonly DesktopProcessMetadata[];
  try {
    processes = await (options.processReader ?? readDesktopProcesses)();
  } catch (error: unknown) {
    throw new CodexAppRuntimeError("runtime_unavailable", "Desktop runtime discovery failed.", {
      cause: error,
      metadata: stateFor({ codexVersion }),
    });
  }
  const namedDesktopProcess = processes.find((entry) => entry.name?.toLowerCase() === DESKTOP_PROCESS_NAME.toLowerCase());
  if (namedDesktopProcess === undefined) {
    throw new CodexAppRuntimeError("runtime_unavailable", "Desktop runtime is unavailable.", {
      metadata: stateFor({ codexVersion }),
    });
  }
  const executablePath = nonEmpty(namedDesktopProcess.executablePath);
  if (executablePath === undefined) {
    throw new CodexAppRuntimeError("bundle_not_found", "Desktop bundle is unavailable.", {
      metadata: stateFor({ desktopDetected: true, codexVersion }),
    });
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
    throw new CodexAppRuntimeError("bundle_not_found", "Desktop bundle is unavailable.", { metadata: state });
  }
  return runtimeFromBundle(bundlePath, options, state, executablePath);
}

function createClient(): CodexAppMcpClient {
  return new Client({ name: "local-review-mcp-codex-app", version: "0.1.0" });
}

const createTransport = (server: StdioServerParameters): CodexAppMcpTransport =>
  new StdioClientTransport(server);

export interface ConnectedCodexAppMcp {
  readonly client: CodexAppMcpClient;
  readonly transport: CodexAppMcpTransport;
}

export async function connectCodexAppMcp(
  runtime: CodexAppRuntimeInfo,
  options: CodexAppRuntimeConnectionOptions = {},
): Promise<ConnectedCodexAppMcp> {
  let client: CodexAppMcpClient | undefined;
  let transport: CodexAppMcpTransport | undefined;
  try {
    client = (options.createClient ?? createClient)();
    transport = (options.createTransport ?? createTransport)(runtime.serverInfo);
    if (options.onTransportStarted !== undefined) {
      const originalStart = transport.start.bind(transport);
      transport.start = async (): Promise<void> => {
        await originalStart();
        options.onTransportStarted?.();
      };
    }
    await client.connect(transport, options.signal === undefined ? undefined : { signal: options.signal });
    return { client, transport };
  } catch (error: unknown) {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    throw new CodexAppRuntimeError("transport_failed", "codex_app MCP transport failed.", { cause: error });
  }
}

export class CodexAppRuntime {
  private readonly client: CodexAppMcpClient;
  private readonly transport: CodexAppMcpTransport;
  private closePromise: Promise<void> | null = null;

  private constructor(
    public readonly info: CodexAppRuntimeInfo,
    connection: ConnectedCodexAppMcp,
  ) {
    this.client = connection.client;
    this.transport = connection.transport;
  }

  public static async connect(
    options: CodexAppRuntimeDiscoveryOptions & CodexAppRuntimeConnectionOptions = {},
  ): Promise<CodexAppRuntime> {
    const info = await discoverCodexAppRuntime(options);
    const connection = await connectCodexAppMcp(info, options);
    return new CodexAppRuntime(info, connection);
  }

  public async listTools(signal?: AbortSignal): Promise<ListToolsResult> {
    try {
      return await this.client.listTools(undefined, signal === undefined ? undefined : { signal });
    } catch (error: unknown) {
      throw new CodexAppRuntimeError("tool_call_failed", "codex_app tools/list failed.", { cause: error });
    }
  }

  public callTool(input: Omit<CallCodexAppToolInput, "client">): Promise<CallToolResult> {
    return callCodexAppTool({ ...input, client: this.client });
  }

  public close(): Promise<void> {
    this.closePromise ??= Promise.all([
      this.client.close().catch(() => undefined),
      this.transport.close().catch(() => undefined),
    ]).then(() => undefined);
    return this.closePromise;
  }
}

function positiveTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("timeoutMs must be a positive integer.");
  return value;
}

export async function callCodexAppTool(input: CallCodexAppToolInput): Promise<CallToolResult> {
  const executorThreadId = nonEmpty(input.executorThreadId);
  if (executorThreadId === undefined) {
    throw new CodexAppRuntimeError("executor_thread_missing", "executorThreadId is required.");
  }
  const timeoutMs = positiveTimeout(input.timeoutMs);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    if (input.signal?.aborted) {
      throw new CodexAppRuntimeError("tool_call_aborted", "codex_app tool call was aborted.");
    }
    const params: CallToolRequestParams = {
      name: input.tool,
      arguments: input.arguments,
      _meta: { [CODEX_APP_EXECUTOR_METADATA_KEY]: executorThreadId },
    };
    const request = input.client.callTool(params, undefined, { signal: controller.signal }) as Promise<CallToolResult>;
    const races: Array<Promise<CallToolResult>> = [request];
    if (input.signal !== undefined) {
      races.push(new Promise<CallToolResult>((_, reject) => {
        abortHandler = (): void => {
          controller.abort();
          reject(new CodexAppRuntimeError("tool_call_aborted", "codex_app tool call was aborted."));
        };
        input.signal!.addEventListener("abort", abortHandler, { once: true });
      }));
    }
    if (timeoutMs !== undefined) {
      races.push(new Promise<CallToolResult>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new CodexAppRuntimeError("tool_call_timeout", "codex_app tool call timed out."));
        }, timeoutMs);
        timer.unref?.();
      }));
    }
    return (await Promise.race(races)) as CallToolResult;
  } catch (error: unknown) {
    if (error instanceof CodexAppRuntimeError) throw error;
    throw new CodexAppRuntimeError("tool_call_failed", "codex_app tool call failed.", { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortHandler !== undefined && input.signal !== undefined) {
      input.signal.removeEventListener("abort", abortHandler);
    }
  }
}
