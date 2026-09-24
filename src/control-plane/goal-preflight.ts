import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import {
  conversationIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import type { ResolvedSettings } from "../config/settings.js";
import {
  bridgeStatus,
  extensionDeliveryReadiness,
  type BridgeStatus,
} from "./bridge.js";
import {
  diagnoseChatGPTConnector,
  remoteProbeTimelineEntrySchema,
  type ChatGPTConnectorDiagnostic,
} from "./chatgpt-connector.js";
import type {
  ExtensionDeliveryReadiness,
  ExtensionDeliveryReadinessCheck,
} from "./extension-delivery.js";
import { executionModeSchema } from "./execution-service.js";
import type {
  DesktopInteractiveBlockReason,
  DesktopInteractiveReadiness,
} from "../desktop-codex/desktop-interactive-preflight.js";

export const GOAL_PREFLIGHT_EXTENSION_READY_TIMEOUT_MS = 60_000;
export const GOAL_PREFLIGHT_POLL_INTERVAL_MS = 250;
/**
 * P5.7.2 Desktop capability readiness synchronization. The Desktop tools pipe capability is
 * delivered by the SessionStart hook handoff, which can land after `submit_goal` was already
 * accepted, so the Desktop check waits for it for a bounded window.
 */
export const GOAL_PREFLIGHT_DESKTOP_READY_TIMEOUT_MS = 30_000;
export const GOAL_PREFLIGHT_DESKTOP_POLL_INTERVAL_MS = 1_000;

export const goalPreflightInputSchema = z.object({
  workspace_id: workspaceIdSchema,
  conversation_id: conversationIdSchema,
  /**
   * The route the Goal will actually take. Only the interactive Desktop route has a backend
   * capability precondition (a resolvable Desktop tools pipe), so batch Goals omit it.
   */
  execution_mode: executionModeSchema.optional(),
}).strict();

const readinessStateSchema = z.enum([
  "bridge_unavailable",
  "extension_not_paired",
  "extension_not_present",
  "ready",
]);

const goalPreflightResultSchemaBase = z.object({
  ready: z.boolean(),
  runtime: z.object({ ready: z.boolean() }).strict(),
  connector: z.object({
    ready: z.boolean(),
    status: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    remote_ready: z.boolean().optional(),
    oauth_ready: z.boolean().optional(),
    timeline: z.array(remoteProbeTimelineEntrySchema).optional(),
  }).strict(),
  extension: z.object({
    ready: z.boolean(),
    paired: z.boolean().optional(),
    present: z.boolean().optional(),
    bridge_available: z.boolean().optional(),
    last_seen_at: z.number().int().nonnegative().nullable().optional(),
    readiness_state: readinessStateSchema.optional(),
    reason: z.string().min(1).optional(),
  }).strict(),
  workspace: z.object({
    valid: z.boolean(),
    workspace_id: workspaceIdSchema,
  }).strict(),
  conversation: z.object({
    valid: z.boolean(),
    conversation_id: conversationIdSchema,
  }).strict(),
  failure_stage: z.enum(["runtime", "workspace", "conversation", "desktop", "connector", "extension"]).optional(),
  failure_reason: z.string().min(1).max(4000).optional(),
  /**
   * Desktop interactive route capability evidence. Present only for interactive Goals, because
   * only that route needs a resolvable Desktop tools pipe before any Goal/Task/Execution exists.
   */
  desktop: z.object({
    ready: z.boolean(),
    reason: z.enum([
      "desktop_disconnected",
      "executor_identity_unavailable",
      "desktop_tools_pipe_unavailable",
    ]).optional(),
    pipe_source: z.enum(["handoff", "current_environment"]).optional(),
  }).strict().optional(),
}).strict();

export const goalPreflightResultSchema = goalPreflightResultSchemaBase.superRefine((result, context) => {
  if (result.ready && (result.failure_stage !== undefined || result.failure_reason !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "ready preflight must not have a failure" });
  }
  if (!result.ready && (result.failure_stage === undefined || result.failure_reason === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "failed preflight must identify its failure" });
  }
  if (result.desktop !== undefined) {
    if (!result.desktop.ready && result.desktop.reason === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "blocked Desktop preflight must state its reason" });
    }
    if (result.desktop.ready && result.desktop.reason !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "ready Desktop preflight must not have a reason" });
    }
  }
  if (result.failure_stage === "desktop"
    && (result.desktop === undefined || result.desktop.ready)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "desktop failure requires a blocked Desktop result" });
  }
});

export type GoalPreflightInput = z.input<typeof goalPreflightInputSchema>;
export type GoalPreflightResult = z.infer<typeof goalPreflightResultSchema>;
export interface GoalPreflightWorkspaceRegistry {
  readonly active: { readonly id: string };
  readonly resolve?: (workspaceId?: string) => { readonly id: string } | null;
}
export type GoalPreflightConnectorCheck = (
  settings: ResolvedSettings,
) => Promise<ChatGPTConnectorDiagnostic>;
export type GoalPreflightExtensionStatus = Pick<
  BridgeStatus,
  "available" | "paired" | "present" | "lastSeenAt"
>;

export interface GoalPreflightServiceOptions {
  readonly settings: ResolvedSettings;
  readonly registry: GoalPreflightWorkspaceRegistry;
  readonly storageRoot?: string;
  readonly runtimeReady?: () => boolean | Promise<boolean>;
  /**
   * Desktop interactive route capability check. It is required for interactive Goals and is the
   * only way this preflight can observe a blocked Desktop tools pipe capability.
   */
  readonly desktopReadiness?: () => DesktopInteractiveReadiness;
  /** Interactive Goals may continue while the negotiator waits for Desktop or selects standalone. */
  readonly desktopFallbackAvailable?: () => boolean;
  /**
   * Bounded wait window for a Desktop capability that is still being handed off. It only applies
   * to `desktop_tools_pipe_unavailable`; every other reason keeps failing immediately.
   */
  readonly desktopReadyTimeoutMs?: number;
  readonly onDesktopWait?: (observation: DesktopWaitObservation) => void;
  readonly diagnoseConnector?: GoalPreflightConnectorCheck;
  readonly extensionReadiness?: ExtensionDeliveryReadinessCheck;
  readonly extensionStatus?: () => GoalPreflightExtensionStatus;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly extensionReadyTimeoutMs?: number;
}

export class GoalPreflightError extends Error {
  public constructor(public readonly result: GoalPreflightResult) {
    super(`Goal preflight failed at ${result.failure_stage}: ${result.failure_reason}`);
    this.name = "GoalPreflightError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

export function normalizeReadiness(
  value: ExtensionDeliveryReadiness | boolean,
): ExtensionDeliveryReadiness {
  return typeof value === "boolean" ? { ready: value } : value;
}

export async function waitForExtensionReady(
  readiness: ExtensionDeliveryReadinessCheck,
  conversationId: string,
  options: {
    readonly timeoutMs?: number;
    readonly now?: () => number;
    readonly wait?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<ExtensionDeliveryReadiness> {
  const now = options.now ?? Date.now;
  const sleep = options.wait ?? (async (milliseconds: number): Promise<void> => {
    await wait(milliseconds);
  });
  const deadline = now() + (options.timeoutMs ?? GOAL_PREFLIGHT_EXTENSION_READY_TIMEOUT_MS);
  let latest = normalizeReadiness(await readiness(conversationId));
  while (!latest.ready && now() < deadline) {
    await sleep(GOAL_PREFLIGHT_POLL_INTERVAL_MS);
    latest = normalizeReadiness(await readiness(conversationId));
  }
  return latest;
}

/**
 * P5.7.2 wait diagnostics. Deliberately limited to counts, elapsed time, and reason/source codes so
 * a blocked or slow Desktop capability never leaks a pipe path, an environment value, or a token.
 */
export interface DesktopWaitObservation {
  readonly state: "waiting" | "ready" | "blocked" | "timeout";
  readonly reason?: DesktopInteractiveBlockReason;
  readonly retry: number;
  readonly elapsed_ms: number;
  readonly pipe_source?: DesktopInteractiveReadiness["pipeSource"];
}

/**
 * P5.7.2 Desktop capability bounded wait.
 *
 * The Desktop tools pipe capability arrives through the SessionStart hook handoff, so it can appear
 * shortly after `submit_goal` was already accepted. Only the "no capability yet" reason waits, and
 * only for a bounded window: a disconnected Desktop or an unavailable executor identity still fails
 * immediately, and a timeout keeps the original fail-closed `desktop_tools_pipe_unavailable` result.
 */
export async function waitForDesktopReady(
  check: () => DesktopInteractiveReadiness,
  options: {
    readonly timeoutMs?: number;
    readonly now?: () => number;
    readonly wait?: (milliseconds: number) => Promise<void>;
    readonly observe?: (observation: DesktopWaitObservation) => void;
  } = {},
): Promise<DesktopInteractiveReadiness> {
  const now = options.now ?? Date.now;
  const sleep = options.wait ?? (async (milliseconds: number): Promise<void> => {
    await wait(milliseconds);
  });
  const observe = (observation: DesktopWaitObservation): void => {
    try {
      options.observe?.(observation);
    } catch {
      // Waiting diagnostics are observational and must never change the preflight decision.
    }
  };

  let latest = check();
  if (latest.ready || latest.reason !== "desktop_tools_pipe_unavailable") return latest;

  // The retry budget bounds the loop independently of the injected clock, so a wait seam that never
  // advances time still cannot wait forever.
  const timeoutMs = options.timeoutMs ?? GOAL_PREFLIGHT_DESKTOP_READY_TIMEOUT_MS;
  const maxRetries = Math.max(0, Math.ceil(timeoutMs / GOAL_PREFLIGHT_DESKTOP_POLL_INTERVAL_MS));
  const startedAt = now();
  let retry = 0;
  observe({ state: "waiting", reason: latest.reason, retry, elapsed_ms: 0 });
  while (retry < maxRetries) {
    await sleep(GOAL_PREFLIGHT_DESKTOP_POLL_INTERVAL_MS);
    retry += 1;
    latest = check();
    const elapsed_ms = now() - startedAt;
    if (latest.ready) {
      observe({
        state: "ready",
        retry,
        elapsed_ms,
        ...(latest.pipeSource === undefined ? {} : { pipe_source: latest.pipeSource }),
      });
      return latest;
    }
    if (latest.reason !== "desktop_tools_pipe_unavailable") {
      observe({ state: "blocked", reason: latest.reason, retry, elapsed_ms });
      return latest;
    }
    observe({ state: "waiting", reason: latest.reason, retry, elapsed_ms });
  }
  observe({ state: "timeout", reason: latest.reason, retry, elapsed_ms: now() - startedAt });
  return latest;
}

function initialResult(input: GoalPreflightInput): GoalPreflightResult {
  return goalPreflightResultSchema.parse({
    ready: false,
    runtime: { ready: false },
    connector: { ready: false },
    extension: { ready: false },
    workspace: { valid: false, workspace_id: input.workspace_id },
    conversation: { valid: true, conversation_id: input.conversation_id },
    failure_stage: "runtime",
    failure_reason: "Goal preflight has not run.",
  });
}

function fail(
  result: GoalPreflightResult,
  stage: GoalPreflightResult["failure_stage"],
  reason: string,
): GoalPreflightResult {
  return goalPreflightResultSchema.parse({
    ...result,
    ready: false,
    failure_stage: stage,
    failure_reason: reason,
  });
}

function extensionState(
  readiness: ExtensionDeliveryReadiness,
  status: GoalPreflightExtensionStatus | undefined,
): GoalPreflightResult["extension"] {
  const present = status?.present ?? readiness.ready;
  return {
    ready: readiness.ready,
    ...(readiness.extension_paired === undefined && status === undefined
      ? {}
      : { paired: readiness.extension_paired ?? status?.paired }),
    ...(present === undefined ? {} : { present }),
    ...(readiness.bridge_available === undefined && status === undefined
      ? {}
      : { bridge_available: readiness.bridge_available ?? status?.available }),
    ...(readiness.last_seen_at === undefined && status === undefined
      ? {}
      : { last_seen_at: readiness.last_seen_at !== undefined
        ? readiness.last_seen_at
        : status?.lastSeenAt }),
    ...(readiness.readiness_state === undefined ? {} : { readiness_state: readiness.readiness_state }),
    ...(readiness.reason === undefined ? {} : { reason: readiness.reason }),
  };
}

function desktopState(readiness: DesktopInteractiveReadiness): NonNullable<GoalPreflightResult["desktop"]> {
  return {
    ready: readiness.ready,
    ...(readiness.reason === undefined ? {} : { reason: readiness.reason }),
    ...(readiness.pipeSource === undefined ? {} : { pipe_source: readiness.pipeSource }),
  };
}

const DESKTOP_FAILURE_REASONS: Record<DesktopInteractiveBlockReason, string> = {
  desktop_disconnected: "desktop_disconnected: Desktop is not connected.",
  executor_identity_unavailable:
    "executor_identity_unavailable: Desktop executor conversation identity is unavailable.",
  desktop_tools_pipe_unavailable:
    "desktop_tools_pipe_unavailable: no verified handoff and no host CODEX_APP_TOOLS_PIPE_PATH.",
};

export class GoalPreflightService {
  private readonly runtimeReadyCheck: GoalPreflightServiceOptions["runtimeReady"];
  private desktopReadinessCheck: GoalPreflightServiceOptions["desktopReadiness"];
  private desktopFallbackAvailable: GoalPreflightServiceOptions["desktopFallbackAvailable"];
  private readonly desktopReadyTimeoutMs: number | undefined;
  private desktopWaitReporter: GoalPreflightServiceOptions["onDesktopWait"];
  private readonly connectorCheck: GoalPreflightConnectorCheck;
  private readonly extensionCheck: ExtensionDeliveryReadinessCheck;
  private readonly extensionStatus: (() => GoalPreflightExtensionStatus) | undefined;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly extensionReadyTimeoutMs: number | undefined;
  private runtimeReadyValue = false;

  public constructor(private readonly options: GoalPreflightServiceOptions) {
    const storageRoot = options.storageRoot ?? defaultTaskContextStorageRoot();
    this.runtimeReadyCheck = options.runtimeReady;
    this.desktopReadinessCheck = options.desktopReadiness;
    this.desktopFallbackAvailable = options.desktopFallbackAvailable;
    this.desktopReadyTimeoutMs = options.desktopReadyTimeoutMs;
    this.desktopWaitReporter = options.onDesktopWait;
    this.connectorCheck = options.diagnoseConnector
      ?? ((settings) => diagnoseChatGPTConnector(settings, { storageRoot }));
    this.extensionCheck = options.extensionReadiness ?? extensionDeliveryReadiness;
    this.extensionStatus = options.extensionStatus;
    this.now = options.now ?? Date.now;
    this.sleep = options.wait ?? (async (milliseconds: number): Promise<void> => {
      await wait(milliseconds);
    });
    this.extensionReadyTimeoutMs = options.extensionReadyTimeoutMs;
  }

  public setRuntimeReady(ready: boolean): void {
    this.runtimeReadyValue = ready;
  }

  /**
   * Bind the Desktop interactive capability check once the Desktop tools-pipe handoff and IPC
   * observer exist. This is a wiring seam, not a policy switch: it never relaxes the check.
   */
  public setDesktopReadiness(check: GoalPreflightServiceOptions["desktopReadiness"]): void {
    this.desktopReadinessCheck = check;
  }

  public setDesktopFallbackAvailable(
    check: GoalPreflightServiceOptions["desktopFallbackAvailable"],
  ): void {
    this.desktopFallbackAvailable = check;
  }

  /**
   * Bind the Desktop capability wait diagnostics once the runtime diagnostic log exists. This is a
   * wiring seam, not a policy switch: it never changes the wait window or the preflight outcome.
   */
  public setDesktopWaitReporter(reporter: GoalPreflightServiceOptions["onDesktopWait"]): void {
    this.desktopWaitReporter = reporter;
  }

  public async checkGoalPreflight(input: GoalPreflightInput): Promise<GoalPreflightResult> {
    const parsed = goalPreflightInputSchema.parse(input);
    let result = initialResult(parsed);
    if (parsed.conversation_id.trim() === "") {
      result = goalPreflightResultSchema.parse({
        ...result,
        conversation: { valid: false, conversation_id: parsed.conversation_id },
      });
      return fail(result, "conversation", "conversation_id must be a non-empty value");
    }

    let workspaceIdValid = false;
    try {
      const resolved = this.options.registry.resolve === undefined
        ? this.options.registry.active.id === parsed.workspace_id ? this.options.registry.active : null
        : this.options.registry.resolve(parsed.workspace_id);
      workspaceIdValid = resolved !== null
        && resolved !== undefined
        && resolved.id === parsed.workspace_id
        && this.options.registry.active.id === parsed.workspace_id
        && (this.options.settings.workspaceIdentity === undefined
          || this.options.settings.workspaceIdentity.id === parsed.workspace_id);
    } catch {
      workspaceIdValid = false;
    }
    result = goalPreflightResultSchema.parse({
      ...result,
      workspace: { valid: workspaceIdValid, workspace_id: parsed.workspace_id },
    });
    if (!workspaceIdValid) {
      return fail(result, "workspace", "workspace identity does not match the active workspace");
    }

    let runtimeReady: boolean;
    try {
      runtimeReady = this.runtimeReadyCheck === undefined
        ? this.runtimeReadyValue
        : await this.runtimeReadyCheck();
    } catch (error: unknown) {
      return fail(result, "runtime", `Runtime readiness check failed: ${errorMessage(error)}`);
    }
    result = goalPreflightResultSchema.parse({ ...result, runtime: { ready: runtimeReady } });
    if (!runtimeReady) return fail(result, "runtime", "Runtime is not ready");

    // Observe the interactive Desktop route before Goal creation. Without a fallback provider a
    // blocked capability remains a fail-closed preflight result; the P5.9 negotiator may instead
    // carry the same evidence into its bounded Desktop/standalone selection.
    if (parsed.execution_mode === "interactive") {
      const check = this.desktopReadinessCheck;
      const fallbackAvailable = this.desktopFallbackAvailable?.() === true;
      // An unbound check can never become ready, so it keeps failing closed without waiting.
      const readiness = check === undefined
        ? { ready: false as const, reason: "desktop_tools_pipe_unavailable" as const }
        : fallbackAvailable
          ? check()
          : await waitForDesktopReady(check, {
              timeoutMs: this.desktopReadyTimeoutMs,
              now: this.now,
              wait: this.sleep,
              ...(this.desktopWaitReporter === undefined ? {} : { observe: this.desktopWaitReporter }),
            });
      result = goalPreflightResultSchema.parse({ ...result, desktop: desktopState(readiness) });
      if (!readiness.ready && !fallbackAvailable) {
        return fail(
          result,
          "desktop",
          DESKTOP_FAILURE_REASONS[readiness.reason ?? "desktop_tools_pipe_unavailable"],
        );
      }
    }

    let connector: ChatGPTConnectorDiagnostic;
    try {
      connector = await this.connectorCheck(this.options.settings);
    } catch (error: unknown) {
      return fail(result, "connector", `Connector readiness check failed: ${errorMessage(error)}`);
    }
    if (connector.workspace_id !== undefined && connector.workspace_id !== parsed.workspace_id) {
      return fail(result, "workspace", "Connector workspace identity does not match the requested workspace");
    }
    const connectorReady = connector.ok
      && (connector.remote === undefined || connector.remote.ready)
      && (connector.oauth === undefined || connector.oauth.ready)
      && connector.connector.status === "verified"
      && connector.connector.action === "none";
    result = goalPreflightResultSchema.parse({
      ...result,
      connector: {
        ready: connectorReady,
        status: connector.connector.status,
        action: connector.connector.action,
        reason: connector.connector.reason,
        ...(connector.remote === undefined ? {} : { remote_ready: connector.remote.ready }),
        ...(connector.remote?.readiness?.timeline === undefined
          ? {} : { timeline: connector.remote.readiness.timeline }),
        ...(connector.oauth === undefined ? {} : { oauth_ready: connector.oauth.ready }),
      },
    });
    const readExtension = async (waitForReady: boolean): Promise<GoalPreflightResult["extension"]> => {
      try {
        const readiness = waitForReady
          ? await waitForExtensionReady(this.extensionCheck, parsed.conversation_id, {
              timeoutMs: this.extensionReadyTimeoutMs,
              now: this.now,
              wait: this.sleep,
            })
          : normalizeReadiness(await this.extensionCheck(parsed.conversation_id));
        return extensionState(readiness, this.extensionStatus?.());
      } catch (error: unknown) {
        return { ready: false, reason: `Extension readiness check failed: ${errorMessage(error)}` };
      }
    };
    if (!connectorReady) {
      result = goalPreflightResultSchema.parse({ ...result, extension: await readExtension(false) });
      return fail(result, "connector", connector.connector.reason || "Connector is not ready");
    }

    const extension = await readExtension(true);
    result = goalPreflightResultSchema.parse({ ...result, extension });
    const { failure_stage: _failureStage, failure_reason: _failureReason, ...withoutFailure } = result;
    return goalPreflightResultSchema.parse({ ...withoutFailure, ready: true });
  }
}
