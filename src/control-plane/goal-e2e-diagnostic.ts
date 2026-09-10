import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { createAppContext, startApp, type AppContext } from "../app.js";
import { endpoint, loadSettings, type ResolvedSettings } from "../config/settings.js";
import { conversationIdSchema } from "../context/schema.js";
import { bridgeStatus } from "./bridge.js";
import type {
  CreateGoalInput,
  GoalOrchestration,
  GoalOrchestrationService,
} from "./goal-orchestration.js";

export const DIAGNOSTIC_MAX_ITERATIONS = 2 as const;

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
  readonly log?: (...values: unknown[]) => void;
  readonly registerShutdown?: (close: () => void) => void;
}

export interface GoalE2EDiagnosticResult {
  readonly server: Server;
  readonly plan: CreateGoalInput;
  readonly created: GoalOrchestration;
  readonly started: GoalOrchestration;
}

type GoalOrchestrationPort = Pick<GoalOrchestrationService, "createGoal" | "startGoal"> & {
  readonly storageRoot?: string;
};

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
    const created = await orchestration.createGoal(plan);
    const log = dependencies.log ?? console.log;
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
    return { server, plan, created, started };
  } catch (error: unknown) {
    if (server !== undefined) await closeServer(server).catch(() => undefined);
    throw error;
  }
}
