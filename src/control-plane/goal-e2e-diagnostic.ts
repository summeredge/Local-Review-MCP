import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createAppContext, startApp, type AppContext } from "../app.js";
import { endpoint, loadSettings, type ResolvedSettings } from "../config/settings.js";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import { conversationIdSchema } from "../context/schema.js";
import { bridgeStatus, extensionDeliveryReadiness } from "./bridge.js";
import { diagnoseChatGPTConnector } from "./chatgpt-connector.js";
import {
  GOAL_PREFLIGHT_EXTENSION_READY_TIMEOUT_MS,
  GOAL_PREFLIGHT_POLL_INTERVAL_MS,
  GoalPreflightService,
  normalizeReadiness,
  waitForExtensionReady,
  type GoalPreflightResult,
} from "./goal-preflight.js";
import type {
  ExtensionDeliveryReadinessCheck,
} from "./extension-delivery.js";
import type {
  CreateGoalInput,
  GoalOrchestration,
  GoalOrchestrationService,
} from "./goal-orchestration.js";

export const DIAGNOSTIC_MAX_ITERATIONS = 2 as const;
export const E2E_EXTENSION_READY_TIMEOUT_MS = GOAL_PREFLIGHT_EXTENSION_READY_TIMEOUT_MS;
export const E2E_GOAL_TIMEOUT_MS = 10 * 60_000;
const E2E_POLL_INTERVAL_MS = GOAL_PREFLIGHT_POLL_INTERVAL_MS;

export { waitForExtensionReady };

export interface GoalE2EDiagnosticArgs {
  readonly configPath?: string;
  readonly conversationId: string;
  readonly settingsArgs: readonly string[];
}

export interface GoalE2EDiagnosticDependencies {
  readonly loadSettings?: typeof loadSettings;
  readonly createAppContext?: typeof createAppContext;
  readonly startApp?: typeof startApp;
  readonly endpoint?: typeof endpoint;
  readonly bridgeStatus?: typeof bridgeStatus;
  readonly diagnoseConnector?: typeof diagnoseChatGPTConnector;
  readonly extensionReadiness?: ExtensionDeliveryReadinessCheck;
  readonly preflight?: GoalPreflightPort;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly extensionReadyTimeoutMs?: number;
  readonly goalTimeoutMs?: number;
  readonly log?: (...values: unknown[]) => void;
  readonly registerShutdown?: (close: () => void) => void;
}

export interface GoalE2EDiagnosticResult {
  readonly server: Server;
  readonly plan: CreateGoalInput;
  readonly created: GoalOrchestration;
  readonly started: GoalOrchestration;
  readonly terminal: GoalOrchestration;
  readonly summary: E2ERunSummary;
}

export interface E2ERunSummary {
  readonly run_id: string;
  readonly runtime_status: "RUNNING";
  readonly connector_status: string;
  readonly extension_ready: boolean;
  readonly delivery_status: string;
  readonly completion_status: string;
  readonly verdict: string;
  readonly goal_status: string;
  readonly failure_stage: string | null;
  readonly failure_reason: string | null;
  readonly delivery: {
    readonly delivery_id: string | null;
    readonly created_at: string | null;
    readonly readiness_check_time: string | null;
    readonly readiness_result: string | null;
    readonly claim_time: string | null;
    readonly ack_time: string | null;
    readonly timeout_reason: string | null;
  };
  readonly extension_readiness: {
    readonly bridge_available: boolean | null;
    readonly extension_paired: boolean | null;
    readonly last_seen_at: string | null;
    readonly readiness_state: string | null;
  };
  readonly completion: {
    readonly completion_id: string | null;
    readonly identity_source: "extension_receipt" | null;
    readonly assistant_message_id: string | null;
    readonly completion_reason: string | null;
  };
}

type GoalOrchestrationPort = Pick<GoalOrchestrationService, "createGoal" | "startGoal" | "getGoal"> & {
  readonly storageRoot?: string;
};
type GoalPreflightPort = Pick<GoalPreflightService, "checkGoalPreflight">
  & Partial<Pick<GoalPreflightService, "setRuntimeReady">>;

function timestamp(value: number | undefined): string | null {
  return value === undefined ? null : new Date(value).toISOString();
}

async function countStateRecords(storageRoot: string, file: string, key: string): Promise<number> {
  try {
    const value = JSON.parse(await readFile(join(storageRoot, "control-plane", file), "utf8")) as Record<string, unknown>;
    return Array.isArray(value[key]) ? value[key].length : 0;
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function preRunSnapshot(
  storageRoot: string,
  runId: string,
  connectorStatus: string,
  readiness: GoalPreflightResult["extension"],
): Promise<Record<string, unknown>> {
  const [deliveries, completions, correlations] = await Promise.all([
    countStateRecords(storageRoot, "extension-deliveries.json", "deliveries"),
    countStateRecords(storageRoot, "extension-review-completions.json", "completions"),
    countStateRecords(storageRoot, "request-correlations.json", "entries"),
  ]);
  return {
    run_id: runId,
    marker: "docs/e2e-validation-marker.md",
    connector_status: connectorStatus,
    extension_ready: readiness.ready,
    bridge_available: readiness.bridge_available ?? null,
    extension_paired: readiness.paired ?? null,
    last_seen_at: timestamp(readiness.last_seen_at ?? undefined),
    readiness_state: readiness.readiness_state ?? null,
    extension_delivery_count: deliveries,
    extension_completion_count: completions,
    request_correlation_count: correlations,
  };
}

async function waitForTerminalGoal(
  orchestration: GoalOrchestrationPort,
  goalId: string,
  options: {
    readonly timeoutMs: number;
    readonly now: () => number;
    readonly wait: (milliseconds: number) => Promise<void>;
  },
): Promise<{ readonly goal: GoalOrchestration; readonly timedOut: boolean }> {
  const deadline = options.now() + options.timeoutMs;
  let current = await orchestration.getGoal(goalId);
  while (current !== null
    && current.status !== "completed"
    && current.status !== "failed"
    && current.status !== "human_required"
    && options.now() < deadline) {
    await options.wait(E2E_POLL_INTERVAL_MS);
    current = await orchestration.getGoal(goalId);
  }
  if (current === null) throw new Error(`Goal "${goalId}" disappeared during E2E validation.`);
  return {
    goal: current,
    timedOut: current.status !== "completed"
      && current.status !== "failed"
      && current.status !== "human_required",
  };
}

async function collectRunSummary(
  context: AppContext,
  goal: GoalOrchestration,
  connectorStatus: string,
  timedOut: boolean,
  getReadiness: ExtensionDeliveryReadinessCheck,
): Promise<E2ERunSummary> {
  const loop = goal.loop_id === undefined ? null : await context.autoIteration?.getLoop(goal.loop_id) ?? null;
  const delivery = loop?.delivery_id === undefined || context.storageRoot === undefined
    ? null
    : await new ReviewDeliveryService(context.storageRoot).getDelivery(goal.workspace_id, loop.delivery_id);
  const extensionDelivery = loop?.delivery_id === undefined
    ? null
    : await context.extensionDeliveries.getByLogicalDeliveryId(loop.delivery_id);
  const completion = loop?.review_request_id === undefined
    ? null
    : await context.extensionReviewCompletions.getByReviewRequestId(loop.review_request_id);
  const readiness = normalizeReadiness(await getReadiness(goal.conversation_id));
  const receipt = completion?.receipt;
  const completed = goal.status === "completed";
  return {
    run_id: goal.goal_id,
    runtime_status: "RUNNING",
    connector_status: connectorStatus,
    extension_ready: readiness.ready,
    delivery_status: delivery?.status ?? "not_created",
    completion_status: completion?.phase ?? "not_created",
    verdict: loop?.terminal_decision ?? "UNKNOWN",
    goal_status: goal.status,
    failure_stage: timedOut ? "goal_timeout" : completed ? null : loop?.stage ?? goal.status,
    failure_reason: timedOut ? "E2E goal timed out" : completed ? null : loop?.terminal_reason ?? null,
    delivery: {
      delivery_id: delivery?.delivery_id ?? null,
      created_at: delivery?.created_at ?? null,
      readiness_check_time: timestamp(extensionDelivery?.readiness_check_time),
      readiness_result: extensionDelivery?.readiness_result ?? delivery?.last_error?.message ?? null,
      claim_time: timestamp(extensionDelivery?.claim_time),
      ack_time: timestamp(extensionDelivery?.ack_time),
      timeout_reason: extensionDelivery?.timeout_reason
        ?? (delivery?.last_error?.code === "EXTENSION_DELIVERY_TIMEOUT" ? delivery.last_error.message : null),
    },
    extension_readiness: {
      bridge_available: readiness.bridge_available ?? null,
      extension_paired: readiness.extension_paired ?? null,
      last_seen_at: timestamp(readiness.last_seen_at ?? undefined),
      readiness_state: readiness.readiness_state ?? null,
    },
    completion: {
      completion_id: completion?.completion_id ?? null,
      identity_source: receipt === undefined ? null : "extension_receipt",
      assistant_message_id: receipt?.assistant_message_id ?? null,
      completion_reason: receipt === undefined
        ? null
        : receipt.status === "completed" ? "assistant_message_observed" : receipt.error ?? receipt.status,
    },
  };
}

function blockedRunSummary(
  runId: string,
  connectorStatus: string,
  readiness: GoalPreflightResult["extension"],
  failureStage: string,
  failureReason: string,
): E2ERunSummary {
  return {
    run_id: runId,
    runtime_status: "RUNNING",
    connector_status: connectorStatus,
    extension_ready: readiness.ready,
    delivery_status: "not_created",
    completion_status: "not_created",
    verdict: "UNKNOWN",
    goal_status: "not_started",
    failure_stage: failureStage,
    failure_reason: failureReason,
    delivery: {
      delivery_id: null,
      created_at: null,
      readiness_check_time: null,
      readiness_result: readiness.readiness_state ?? readiness.reason ?? null,
      claim_time: null,
      ack_time: null,
      timeout_reason: null,
    },
    extension_readiness: {
      bridge_available: readiness.bridge_available ?? null,
      extension_paired: readiness.paired ?? null,
      last_seen_at: timestamp(readiness.last_seen_at ?? undefined),
      readiness_state: readiness.readiness_state ?? null,
    },
    completion: {
      completion_id: null,
      identity_source: null,
      assistant_message_id: null,
      completion_reason: null,
    },
  };
}

export function parseGoalE2EDiagnosticArgs(
  argv: readonly string[],
): GoalE2EDiagnosticArgs {
  const settingsArgs: string[] = [];
  let configPath: string | undefined;
  let conversationId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config" || argument === "--conversation-id") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--config") {
        if (configPath !== undefined) throw new Error("duplicate argument: --config");
        configPath = value;
        settingsArgs.push(argument, value);
      } else {
        if (conversationId !== undefined) throw new Error("duplicate argument: --conversation-id");
        conversationId = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (conversationId === undefined) throw new Error("--conversation-id is required");
  if (conversationId.trim() === "") throw new Error("--conversation-id must be a non-empty value");
  try {
    conversationIdSchema.parse(conversationId);
  } catch (error: unknown) {
    throw new Error("--conversation-id is invalid", { cause: error });
  }

  return { configPath, conversationId, settingsArgs };
}

export function buildDiagnosticGoalPlan(
  workspaceId: string,
  conversationId: string,
): CreateGoalInput {
  const suffix = randomUUID();
  const goalId = `diagnostic-goal-${suffix}`;
  const phaseId = `diagnostic-phase-${suffix}`;
  const taskId = `diagnostic-task-${suffix}`;
  return {
    goal_id: goalId,
    workspace_id: workspaceId,
    conversation_id: conversationId,
    phases: [{
      phase_id: phaseId,
      objective: "E2E Validation",
      tasks: [{
        task_id: taskId,
        goal: "Create or update docs/e2e-validation-marker.md with an E2E validation marker.",
        requirements: [
          `The file must contain this diagnostic goal_id: ${goalId}.`,
          "Modify only docs/e2e-validation-marker.md; do not modify any production source code or configuration.",
          "Do not create a git commit.",
        ],
        acceptance_criteria: [
          "docs/e2e-validation-marker.md exists.",
          `docs/e2e-validation-marker.md contains this diagnostic goal_id: ${goalId}.`,
          "npm run typecheck passes.",
        ],
        max_iterations: DIAGNOSTIC_MAX_ITERATIONS,
      }],
    }],
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function registerProcessShutdown(server: Server): void {
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void closeServer(server).catch(() => undefined);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

function diagnosticOutput(
  settings: ResolvedSettings,
  orchestration: GoalOrchestrationPort,
  plan: CreateGoalInput,
  goal: GoalOrchestration,
  getEndpoint: typeof endpoint,
  getBridgeStatus: typeof bridgeStatus,
): string {
  const phase = plan.phases[0]!;
  const task = phase.tasks[0]!;
  const bridge = getBridgeStatus();
  const bridgeEndpoint = bridge.port === null
    ? "unavailable"
    : `http://${bridge.address}:${bridge.port}`;
  const lines = [
    "Goal E2E diagnostic started",
    `goal_id: ${goal.goal_id}`,
    `workspace_id: ${goal.workspace_id}`,
    `conversation_id: ${goal.conversation_id}`,
    `phase_id: ${goal.current_phase_id ?? phase.phase_id}`,
    `task_id: ${goal.current_task_id ?? task.task_id}`,
    `max_iterations: ${task.max_iterations}`,
    `max_iterations=${task.max_iterations}`,
    `goal_status: ${goal.status}`,
    `storage_root: ${orchestration.storageRoot ?? "unknown"}`,
    `runtime_endpoint: ${getEndpoint(settings)}`,
    `bridge_endpoint: ${bridgeEndpoint}`,
    "review_completion_transport: extension",
    "browser_worker_required: false",
  ];
  if (goal.execution_id !== undefined) lines.push(`execution_id: ${goal.execution_id}`);
  if (goal.actuation_id !== undefined) lines.push(`actuation_id: ${goal.actuation_id}`);
  if (goal.loop_id !== undefined) lines.push(`loop_id: ${goal.loop_id}`);
  lines.push("Keep this process running until the Goal reaches a terminal state.");
  return lines.join("\n");
}

function createDiagnosticPreflight(
  settings: ResolvedSettings,
  context: AppContext,
  orchestration: GoalOrchestrationPort,
  server: Server,
  dependencies: GoalE2EDiagnosticDependencies,
): GoalPreflightPort {
  const configured = dependencies.preflight
    ?? (dependencies.diagnoseConnector === undefined
      && dependencies.extensionReadiness === undefined
      && dependencies.bridgeStatus === undefined
      ? context.goalPreflight
      : undefined);
  const preflight = configured ?? new GoalPreflightService({
    settings,
    registry: context.registry,
    storageRoot: orchestration.storageRoot ?? context.storageRoot,
    diagnoseConnector: dependencies.diagnoseConnector === undefined
      ? undefined
      : (currentSettings) => dependencies.diagnoseConnector!(currentSettings),
    extensionReadiness: dependencies.extensionReadiness,
    extensionStatus: dependencies.bridgeStatus,
    now: dependencies.now,
    wait: dependencies.wait,
    extensionReadyTimeoutMs: dependencies.extensionReadyTimeoutMs,
  });
  preflight.setRuntimeReady?.(server.listening === true);
  return preflight;
}

export async function runGoalE2EDiagnostic(
  argv: readonly string[],
  dependencies: GoalE2EDiagnosticDependencies = {},
): Promise<GoalE2EDiagnosticResult> {
  const args = parseGoalE2EDiagnosticArgs(argv);
  const settings = await (dependencies.loadSettings ?? loadSettings)(args.settingsArgs);
  const context = (dependencies.createAppContext ?? createAppContext)(settings);
  let server: Server | undefined;
  try {
    server = await (dependencies.startApp ?? startApp)(settings, context);
    const orchestration = context.goalOrchestration as GoalOrchestrationPort | undefined;
    if (orchestration === undefined) throw new Error("GoalOrchestration unavailable");

    const plan = buildDiagnosticGoalPlan(context.registry.active.id, args.conversationId);
    const log = dependencies.log ?? console.log;
    const readinessCheck = dependencies.extensionReadiness ?? extensionDeliveryReadiness;
    const preflight = createDiagnosticPreflight(settings, context, orchestration, server, dependencies);
    const checked = await preflight.checkGoalPreflight({
      workspace_id: plan.workspace_id,
      conversation_id: plan.conversation_id,
    });
    const connectorStatus = checked.connector.status ?? "unknown";
    if (!checked.ready && checked.failure_stage !== "extension") {
      log("E2E Run Summary");
      log(JSON.stringify(blockedRunSummary(
        plan.goal_id,
        connectorStatus,
        checked.extension,
        checked.failure_stage ?? "preflight",
        checked.failure_reason ?? "Goal preflight failed",
      ), null, 2));
      if (checked.failure_stage === "connector") {
        throw new Error(`ChatGPT Connector is not ready: ${checked.failure_reason}`);
      }
      throw new Error(`Goal preflight failed: ${checked.failure_reason}`);
    }
    log("E2E Pre-run Snapshot");
    log(JSON.stringify(await preRunSnapshot(
      orchestration.storageRoot ?? context.storageRoot ?? "",
      plan.goal_id,
      connectorStatus,
      checked.extension,
    ), null, 2));
    if (!checked.ready) {
      const reason = checked.failure_reason ?? "readiness timed out";
      log("E2E Run Summary");
      log(JSON.stringify(blockedRunSummary(
        plan.goal_id,
        connectorStatus,
        checked.extension,
        "extension_readiness",
        reason,
      ), null, 2));
      throw new Error(`Extension Delivery is not ready: ${reason}`);
    }
    const created = await orchestration.createGoal(plan);
    log("created Goal");
    log(`goal_id: ${created.goal_id}`);
    const started = await orchestration.startGoal({ goal_id: created.goal_id });
    log(diagnosticOutput(
      settings,
      orchestration,
      plan,
      started,
      dependencies.endpoint ?? endpoint,
      dependencies.bridgeStatus ?? bridgeStatus,
    ));
    if (dependencies.registerShutdown !== undefined) {
      dependencies.registerShutdown(() => {
        void closeServer(server!).catch(() => undefined);
      });
    } else {
      registerProcessShutdown(server);
    }
    const terminal = await waitForTerminalGoal(orchestration, started.goal_id, {
      timeoutMs: dependencies.goalTimeoutMs ?? E2E_GOAL_TIMEOUT_MS,
      now: dependencies.now ?? Date.now,
      wait: dependencies.wait ?? (async (milliseconds: number): Promise<void> => {
        await wait(milliseconds);
      }),
    });
    const summary = await collectRunSummary(
      context,
      terminal.goal,
      connectorStatus,
      terminal.timedOut,
      readinessCheck,
    );
    log("E2E Run Summary");
    log(JSON.stringify(summary, null, 2));
    if (terminal.timedOut || terminal.goal.status !== "completed") {
      throw new Error(`E2E run did not complete: ${summary.failure_reason ?? summary.failure_stage ?? "unknown"}`);
    }
    return { server, plan, created, started, terminal: terminal.goal, summary };
  } catch (error: unknown) {
    if (server !== undefined) await closeServer(server).catch(() => undefined);
    throw error;
  }
}
