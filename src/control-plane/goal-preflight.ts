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
  type ChatGPTConnectorDiagnostic,
} from "./chatgpt-connector.js";
import type {
  ExtensionDeliveryReadiness,
  ExtensionDeliveryReadinessCheck,
} from "./extension-delivery.js";

export const GOAL_PREFLIGHT_EXTENSION_READY_TIMEOUT_MS = 60_000;
export const GOAL_PREFLIGHT_POLL_INTERVAL_MS = 250;

export const goalPreflightInputSchema = z.object({
  workspace_id: workspaceIdSchema,
  conversation_id: conversationIdSchema,
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
  failure_stage: z.enum(["runtime", "workspace", "conversation", "connector", "extension"]).optional(),
  failure_reason: z.string().min(1).max(4000).optional(),
}).strict();

export const goalPreflightResultSchema = goalPreflightResultSchemaBase.superRefine((result, context) => {
  if (result.ready && (result.failure_stage !== undefined || result.failure_reason !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "ready preflight must not have a failure" });
  }
  if (!result.ready && (result.failure_stage === undefined || result.failure_reason === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "failed preflight must identify its failure" });
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

export class GoalPreflightService {
  private readonly runtimeReadyCheck: GoalPreflightServiceOptions["runtimeReady"];
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
    if (!extension.ready) {
      return fail(result, "extension", extension.reason ?? "Extension is not ready");
    }
    const { failure_stage: _failureStage, failure_reason: _failureReason, ...withoutFailure } = result;
    return goalPreflightResultSchema.parse({ ...withoutFailure, ready: true });
  }
}
