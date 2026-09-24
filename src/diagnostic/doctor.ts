import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../backends/codex_app_server/client.js";
import type { ResolvedSettings } from "../config/settings.js";
import type { CapabilitySnapshot } from "../control-plane/capability-negotiation.js";
import { resolveCodexExecutable } from "../control-plane/codex-execution-adapter.js";
import type { DesktopSyncState } from "../desktop-sync/desktop-sync-state.js";
import {
  LAUNCHER_DESKTOP_TOOLS_PIPE_PATH,
  validateDesktopToolsPipePath,
  type DesktopToolsPipeHandoff,
} from "../desktop-codex/desktop-tools-pipe-handoff.js";
import type {
  DesktopToolsPipeResolver,
  DesktopToolsPipeSource,
} from "../desktop-codex/desktop-tools-pipe-resolver.js";
import type { WorkspaceSelection } from "../workspace/registry.js";

export interface DoctorCheck {
  component: string;
  status: "PASS" | "WARN" | "FAIL";
  reason?: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export interface DoctorReport {
  status: "READY" | "DEGRADED" | "FAILED";
  checks: DoctorCheck[];
  generatedAt: string;
}

export interface DoctorProbeResult {
  status: "PASS" | "WARN" | "FAIL";
  reason?: string;
  details?: Record<string, unknown>;
}

export interface DoctorCodexAppServerClient {
  start(options: {
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly executable?: string;
    readonly requestTimeoutMs?: number;
    readonly clientName?: string;
  }): Promise<{
    initialize(): Promise<{ readonly user_agent: string }>;
    listModels(): Promise<readonly unknown[]>;
    readonly processInfo: { readonly transport: string };
    close(): Promise<unknown>;
  }>;
}

export interface DoctorRuntimeCheck {
  readonly running: boolean;
  readonly workspaceId: string;
  readonly configurationLoaded: boolean;
}

export interface DoctorRunnerOptions {
  readonly settings: ResolvedSettings;
  readonly workspace: Pick<WorkspaceSelection, "id" | "name" | "manager">;
  readonly desktopState: () => DesktopSyncState;
  readonly handoff?: Pick<DesktopToolsPipeHandoff, "stateFor" | "hasAcceptedCapability">;
  readonly pipeResolver?: Pick<DesktopToolsPipeResolver, "resolve">;
  readonly capabilitySnapshot?: () => CapabilitySnapshot | null;
  readonly standaloneBackend?: { readonly storageRoot: string };
  readonly appServerProbe?: () => Promise<DoctorProbeResult>;
  readonly appServerClient?: DoctorCodexAppServerClient;
  readonly runtimeRunning?: boolean;
  readonly runtimeCheck?: () => DoctorRuntimeCheck;
  readonly trampolineProbe?: () => DoctorProbeResult;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

function findTrampolineRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(current, "tools", "desktop-bootstrap-trampoline");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(process.cwd(), "tools", "desktop-bootstrap-trampoline");
}

const DEFAULT_TRAMPOLINE_ROOT = findTrampolineRoot();

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function timestamp(now: () => number): string {
  return new Date(now()).toISOString();
}

function errorCode(error: unknown, fallback: string): string {
  if (typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && error.code.trim() !== "") {
    return error.code.trim();
  }
  return fallback;
}

function withoutDesktopExecutionEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.CODEX_CLI_PATH;
  delete sanitized.CODEX_APP_TOOLS_PIPE_PATH;
  return sanitized;
}

function reportStatus(checks: readonly DoctorCheck[]): DoctorReport["status"] {
  if (checks.some((check) => check.status === "FAIL")) return "FAILED";
  return checks.some((check) => check.status === "WARN") ? "DEGRADED" : "READY";
}

function capabilityDetails(snapshot: CapabilitySnapshot | null): Record<string, unknown> {
  return {
    state: snapshot?.state ?? null,
    source: snapshot?.source ?? null,
    reason: snapshot?.reason ?? null,
    error_code: snapshot?.error_code ?? null,
  };
}

function pipeLifecycle(
  handoff: Pick<DesktopToolsPipeHandoff, "stateFor" | "hasAcceptedCapability">,
  state: DesktopSyncState,
): "ready" | "pending" | "expired" | "unavailable" {
  const handoffState = handoff.stateFor(state);
  if (handoffState === "active") return "ready";
  if (handoffState === "pending") return "pending";
  return handoff.hasAcceptedCapability() ? "expired" : "unavailable";
}

function desktopDetails(state: DesktopSyncState): Record<string, unknown> {
  return {
    connected: state.connected === true,
    desktop_visible: state.connected === true && nonEmpty(state.currentConversationId) !== undefined,
    owner_bound: state.connected === true && nonEmpty(state.ownerClientId) !== undefined,
  };
}

function inspectTrampoline(
  environment: NodeJS.ProcessEnv,
  root: string,
): DoctorProbeResult {
  const configPath = nonEmpty(environment.LRM_P58_CONFIG)
    ?? join(root, "trampoline.config.ini");
  const sourcePath = join(root, "src", "DesktopBootstrapTrampoline.cs");
  const configPresent = existsSync(configPath);
  const sourcePresent = existsSync(sourcePath);
  const source = sourcePresent ? readFileSync(sourcePath, "utf8") : "";
  const argvContractPresent = source.includes("ArgumentTail(commandLine)")
    && source.includes("CreateProcessW");
  const configuredCli = nonEmpty(environment.CODEX_CLI_PATH);
  const configText = configPresent ? readFileSync(configPath, "utf8") : "";
  const configValue = (key: string): string | undefined => {
    const match = configText.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, "imu"));
    return nonEmpty(match?.[1]);
  };
  const realCli = configValue("realcodexpath") ?? nonEmpty(environment.LRM_PROBE_REAL_CODEX);
  let cliPathValid = false;
  let cliReason: string | undefined;
  try {
    resolveCodexExecutable({
      environment: withoutDesktopExecutionEnvironment(environment),
      codexExecutable: realCli,
    });
    cliPathValid = true;
  } catch (error: unknown) {
    cliReason = errorCode(error, "codex_cli_path_invalid");
  }
  const trampolinePathValid = configuredCli === undefined || existsSync(configuredCli);

  const pipeValue = nonEmpty(environment.CODEX_APP_TOOLS_PIPE_PATH);
  let pipeValid = true;
  if (pipeValue !== undefined) {
    try {
      validateDesktopToolsPipePath(pipeValue);
    } catch {
      pipeValid = false;
    }
  }
  const details: Record<string, unknown> = {
    config_present: configPresent,
    cli_path_configured: configuredCli !== undefined,
    trampoline_path_valid: trampolinePathValid,
    cli_path_valid: cliPathValid,
    cli_path_source: realCli === undefined ? "desktop_bundle" : "configured",
    source_present: sourcePresent,
    argv_contract: argvContractPresent ? "forwarded" : "unavailable",
    pipe_environment_present: pipeValue !== undefined,
    pipe_environment_valid: pipeValid,
  };

  if (configuredCli === undefined) return { status: "WARN", reason: "trampoline_not_configured", details };
  if (!configPresent) return { status: "WARN", reason: "trampoline_config_missing", details };
  if (!cliPathValid) return { status: "WARN", reason: cliReason, details };
  if (!trampolinePathValid) return { status: "WARN", reason: "trampoline_cli_path_invalid", details };
  if (!sourcePresent || !argvContractPresent) {
    return { status: "WARN", reason: "trampoline_argv_contract_unavailable", details };
  }
  if (!pipeValid) return { status: "WARN", reason: "trampoline_pipe_environment_invalid", details };
  return { status: "PASS", details: { ...details, installed: true } };
}

export async function probeCodexAppServer(options: {
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly executable?: string;
  readonly client?: DoctorCodexAppServerClient;
}): Promise<DoctorProbeResult> {
  let client: Awaited<ReturnType<DoctorCodexAppServerClient["start"]>> | undefined;
  try {
    const sanitizedEnvironment = withoutDesktopExecutionEnvironment(options.environment ?? process.env);
    const executable = resolveCodexExecutable({
      environment: sanitizedEnvironment,
      codexExecutable: options.executable,
    });
    const environment = {
      ...sanitizedEnvironment,
      // The health check must not re-enter the Desktop trampoline or hand off a pipe.
      CODEX_CLI_PATH: "",
      CODEX_APP_TOOLS_PIPE_PATH: "",
    };
    const start = options.client?.start.bind(options.client) ?? CodexAppServerClient.start.bind(CodexAppServerClient);
    client = await start({
      cwd: options.cwd,
      environment,
      executable,
      requestTimeoutMs: 5_000,
      clientName: "local-review-mcp-doctor",
    });
    const initialized = await client.initialize();
    const models = await client.listModels();
    return {
      status: "PASS",
      details: {
        transport: client.processInfo.transport,
        protocol: "initialize",
        user_agent: initialized.user_agent,
        model_protocol_available: true,
        thread_created: false,
        turn_started: false,
      },
    };
  } catch (error: unknown) {
    return {
      status: "FAIL",
      reason: errorCode(error, "codex_app_server_health_check_failed"),
      details: { transport: "stdio", protocol: "initialize", thread_created: false, turn_started: false },
    };
  } finally {
    await client?.close().catch(() => undefined);
  }
}

export class DoctorRunner {
  private readonly now: () => number;
  private readonly environment: NodeJS.ProcessEnv;

  public constructor(private readonly options: DoctorRunnerOptions) {
    this.now = options.now ?? Date.now;
    this.environment = options.environment ?? process.env;
  }

  public async run(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    let appServerProbePromise: Promise<DoctorProbeResult> | undefined;
    const appServerProbe = (): Promise<DoctorProbeResult> => {
      appServerProbePromise ??= this.options.appServerProbe?.() ?? probeCodexAppServer({
        cwd: this.options.workspace.manager.canonicalRoot,
        environment: this.environment,
        client: this.options.appServerClient,
      });
      return appServerProbePromise;
    };
    checks.push(await this.check("MCP Runtime", () => this.checkMcpRuntime()));
    checks.push(await this.check("Desktop IPC", () => this.checkDesktopIpc()));
    checks.push(await this.check("Desktop Handoff", () => this.checkDesktopHandoff()));
    checks.push(await this.check("Desktop Trampoline", () => this.checkDesktopTrampoline()));
    checks.push(await this.check("Standalone Backend", () => this.checkStandaloneBackend(appServerProbe)));
    checks.push(await this.check("Codex App Server", appServerProbe));
    return {
      status: reportStatus(checks),
      checks,
      generatedAt: timestamp(this.now),
    };
  }

  private async check(
    component: string,
    run: () => DoctorProbeResult | Promise<DoctorProbeResult>,
  ): Promise<DoctorCheck> {
    try {
      const result = await run();
      return { component, ...result, timestamp: timestamp(this.now) };
    } catch (error: unknown) {
      return {
        component,
        status: "FAIL",
        reason: errorCode(error, "doctor_check_failed"),
        timestamp: timestamp(this.now),
      };
    }
  }

  private checkMcpRuntime(): DoctorProbeResult {
    const runtime = this.options.runtimeCheck?.();
    if (runtime?.running === false || this.options.runtimeRunning === false) {
      return { status: "FAIL", reason: "mcp_runtime_stopped", details: { runtime_running: false } };
    }
    let workspaceAccessible = false;
    try {
      workspaceAccessible = this.options.workspace.manager.resolveExisting(".").absolutePath !== "";
    } catch (error: unknown) {
      return { status: "FAIL", reason: errorCode(error, "workspace_unavailable") };
    }
    const configLoaded = runtime?.configurationLoaded ?? (typeof this.options.settings.auth.token === "string"
      && this.options.settings.auth.token.trim() !== ""
      && Number.isInteger(this.options.settings.port)
      && this.options.settings.port >= 0
      && this.options.settings.port <= 65_535);
    if (!configLoaded) {
      return { status: "FAIL", reason: "mcp_configuration_invalid", details: { workspace_accessible: workspaceAccessible } };
    }
    return {
      status: "PASS",
      details: {
        workspace_id: runtime?.workspaceId ?? this.options.workspace.id,
        workspace_name: this.options.workspace.name,
        workspace_accessible: workspaceAccessible,
        runtime_running: true,
        configuration_loaded: true,
      },
    };
  }

  private checkDesktopIpc(): DoctorProbeResult {
    const state = this.options.desktopState();
    const details = desktopDetails(state);
    if (state.connected !== true) return { status: "WARN", reason: "desktop_disconnected", details };
    if (details.desktop_visible !== true) return { status: "WARN", reason: "desktop_not_visible", details };
    if (details.owner_bound !== true) return { status: "WARN", reason: "owner_binding_unavailable", details };
    return { status: "PASS", details };
  }

  private checkDesktopHandoff(): DoctorProbeResult {
    const state = this.options.desktopState();
    const snapshot = this.options.capabilitySnapshot?.() ?? null;
    const details: Record<string, unknown> = {
      capability: capabilityDetails(snapshot),
    };
    if (this.options.handoff === undefined || this.options.pipeResolver === undefined) {
      return {
        status: "WARN",
        reason: "desktop_handoff_observer_unavailable",
        details,
      };
    }
    const lifecycle = pipeLifecycle(this.options.handoff, state);
    details.lifecycle = lifecycle;
    details.endpoint = LAUNCHER_DESKTOP_TOOLS_PIPE_PATH;
    try {
      const resolved = this.options.pipeResolver.resolve();
      details.pipe_source = resolved.source satisfies DesktopToolsPipeSource;
      if (lifecycle === "ready" || resolved.source === "current_environment") {
        details.capability = { ...capabilityDetails(snapshot), readiness: "ready" };
        return { status: "PASS", details };
      }
      return { status: "WARN", reason: `desktop_handoff_${lifecycle}`, details };
    } catch (error: unknown) {
      const reason = snapshot?.reason ?? errorCode(error, "desktop_tools_pipe_unavailable");
      return {
        status: "WARN",
        reason,
        details: {
          ...details,
          resolver_reason: errorCode(error, "desktop_tools_pipe_unavailable"),
          capability: { ...capabilityDetails(snapshot), readiness: lifecycle },
        },
      };
    }
  }

  private checkDesktopTrampoline(): DoctorProbeResult {
    return this.options.trampolineProbe?.()
      ?? inspectTrampoline(this.environment, DEFAULT_TRAMPOLINE_ROOT);
  }

  private async checkStandaloneBackend(appServerProbe: () => Promise<DoctorProbeResult>): Promise<DoctorProbeResult> {
    const backend = this.options.standaloneBackend;
    if (backend === undefined || nonEmpty(backend.storageRoot) === undefined) {
      return { status: "FAIL", reason: "standalone_backend_unavailable" };
    }
    const probe = await appServerProbe();
    return {
      status: probe.status,
      ...(probe.reason === undefined ? {} : { reason: probe.reason }),
      details: {
        backend: "codex_app_server",
        initialized: probe.status === "PASS",
        execution_started: false,
        ...(probe.details ?? {}),
      },
    };
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["LRM Doctor", ""];
  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.component}${check.reason === undefined ? "" : ` — ${check.reason}`}`);
  }
  lines.push("", "Status:", report.status);
  return lines.join("\n");
}

export function offlineDoctorReport(reason = "mcp_runtime_unavailable"): DoctorReport {
  const now = new Date().toISOString();
  return {
    status: "FAILED",
    checks: [{
      component: "MCP Runtime",
      status: "FAIL",
      reason,
      timestamp: now,
    }],
    generatedAt: now,
  };
}
