import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CodexAppRuntimeError,
  connectCodexAppMcp as connectRuntime,
  discoverCodexAppRuntime,
  type CodexAppMcpClient,
  type CodexAppMcpTransport,
  type CodexAppRuntimeDiscoveryOptions,
  type CodexAppRuntimeInfo,
} from "../desktop-codex/codex-app-runtime.js";

export type CodexAppMcpRuntime = CodexAppRuntimeInfo;

export interface DesktopProcessMetadata {
  readonly name?: string;
  readonly executablePath?: string;
}

export interface CodexAppMcpDiagnosticArgs {
  readonly serverPath?: string;
  readonly pipePath?: string;
}

export interface CodexAppMcpDiscoveryOptions extends CodexAppRuntimeDiscoveryOptions {
  readonly processReader?: () => Promise<readonly DesktopProcessMetadata[]>;
}

export interface CodexAppMcpDiagnosticDependencies extends CodexAppMcpDiscoveryOptions {
  readonly createClient?: () => CodexAppMcpClient;
  readonly createTransport?: (server: StdioServerParameters) => CodexAppMcpTransport;
}

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

export class CodexAppMcpDiagnosticError extends Error {
  public constructor(
    public readonly stage: Exclude<CodexAppMcpDiagnosticStage, "ok">,
    public readonly state: DiagnosticState,
  ) {
    super(stage);
    this.name = "CodexAppMcpDiagnosticError";
  }
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

function stateFromRuntimeError(error: CodexAppRuntimeError): DiagnosticState {
  return stateFor(error.metadata);
}

function stageFromRuntimeError(error: CodexAppRuntimeError): Exclude<CodexAppMcpDiagnosticStage, "ok"> {
  switch (error.code) {
    case "runtime_unavailable":
      return "desktop_not_running";
    case "bundle_not_found":
      return "bundle_not_found";
    case "pipe_unavailable":
      return "pipe_discovery_unavailable";
    case "runtime_contract_incompatible":
      return "runtime_contract_unknown";
    default:
      return "runtime_contract_unknown";
  }
}

export async function discoverCodexAppMcpRuntime(
  options: CodexAppMcpDiscoveryOptions = {},
): Promise<CodexAppMcpRuntime> {
  try {
    return await discoverCodexAppRuntime(options);
  } catch (error: unknown) {
    if (error instanceof CodexAppRuntimeError) {
      throw new CodexAppMcpDiagnosticError(stageFromRuntimeError(error), stateFromRuntimeError(error));
    }
    throw error;
  }
}

export const connectCodexAppMcp = connectRuntime;

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
    if (error instanceof CodexAppMcpDiagnosticError) return resultFrom(error.state, error.stage);
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

  let client: CodexAppMcpClient | undefined;
  let transport: CodexAppMcpTransport | undefined;
  let started = false;
  try {
    try {
      const connected = await connectRuntime(runtime, {
        ...dependencies,
        signal: abortController.signal,
        onTransportStarted: () => { started = true; },
      });
      client = connected.client;
      transport = connected.transport;
    } catch {
      return resultFrom(state, interrupted ? "diagnostic_interrupted" : started ? "mcp_initialize_failed" : "mcp_spawn_failed", {
        mcpStarted: started,
      });
    }

    try {
      const listed = await client!.listTools(undefined, { signal: abortController.signal });
      const tools = listed.tools.map((tool) => tool.name);
      return resultFrom(state, "ok", {
        mcpStarted: started,
        initialized: true,
        toolsListed: true,
        toolCount: tools.length,
        tools,
      });
    } catch {
      return resultFrom(state, interrupted ? "diagnostic_interrupted" : "tools_list_failed", {
        mcpStarted: started,
        initialized: true,
      });
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  }
}
