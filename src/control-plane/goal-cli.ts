import type { Server } from "node:http";
import { ZodError } from "zod";
import { createAppContext, startApp, type AppContext } from "../app.js";
import { loadSettings, type ResolvedSettings } from "../config/settings.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import { ReviewResultService } from "../context/review-result-service.js";
import type { ExecutionStatus } from "../context/types.js";
import { GoalPreflightError } from "./goal-preflight.js";
import {
  goalIdSchema,
  type GoalOrchestration,
} from "./goal-orchestration.js";
import {
  goalSubmissionRequestSchema,
  type GoalSubmissionRequest,
  type GoalSubmissionResult,
} from "./goal-submission.js";

const SETTINGS_OPTIONS = new Set(["--config", "--port", "--workspace", "--token"]);
const CLI_DEFAULT_REQUIREMENTS = ["Complete the requested goal."];
const CLI_DEFAULT_ACCEPTANCE_CRITERIA = ["The requested goal is complete."];

export interface GoalSubmissionCliArgs {
  readonly settingsArgs: readonly string[];
  readonly request: GoalSubmissionRequest;
}

export interface GoalStatusCliArgs {
  readonly settingsArgs: readonly string[];
  readonly goalId: string;
}

export interface GoalCliDependencies {
  readonly loadSettings?: typeof loadSettings;
  readonly createAppContext?: typeof createAppContext;
  readonly startApp?: typeof startApp;
  readonly closeServer?: (server: Server) => Promise<void>;
  readonly registerShutdown?: (close: () => void) => void;
}

export class GoalCliValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GoalCliValidationError";
  }
}

export interface GoalStatusCliResult {
  readonly goal_id: string;
  readonly status: GoalOrchestration["status"];
  readonly phase_id: string | null;
  readonly task_id: string | null;
  readonly execution_id: string | null;
  readonly execution_status: ExecutionStatus | null;
  readonly review_status: string | null;
  readonly review_request_id: string | null;
  readonly review_result_status: string | null;
}

function valueFor(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new GoalCliValidationError(`${option} requires a value`);
  }
  return value;
}

function settingArgsFor(
  argv: readonly string[],
  index: number,
  option: string,
  settingsArgs: string[],
): number {
  const value = valueFor(argv, index, option);
  settingsArgs.push(option, value);
  return index + 1;
}

export function parseGoalSubmissionCliArgs(argv: readonly string[]): GoalSubmissionCliArgs {
  let workspaceId: string | undefined;
  let conversationId: string | undefined;
  let title: string | undefined;
  let goal: string | undefined;
  let maxIterations: number | undefined;
  const requirements: string[] = [];
  const acceptanceCriteria: string[] = [];
  const settingsArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (SETTINGS_OPTIONS.has(argument)) {
      index = settingArgsFor(argv, index, argument, settingsArgs);
      continue;
    }
    const value = valueFor(argv, index, argument);
    switch (argument) {
      case "--workspace-id":
        workspaceId = value;
        break;
      case "--conversation-id":
        conversationId = value;
        break;
      case "--title":
        title = value;
        break;
      case "--goal":
        goal = value;
        break;
      case "--requirements":
        requirements.push(value);
        break;
      case "--acceptance-criteria":
        acceptanceCriteria.push(value);
        break;
      case "--max-iterations": {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
          throw new GoalCliValidationError("--max-iterations must be an integer between 1 and 10000");
        }
        maxIterations = parsed;
        break;
      }
      default:
        throw new GoalCliValidationError(`unknown argument: ${argument}`);
    }
    index += 1;
  }

  if (workspaceId === undefined) throw new GoalCliValidationError("--workspace-id is required");
  if (conversationId === undefined) throw new GoalCliValidationError("--conversation-id is required");
  if (title === undefined) throw new GoalCliValidationError("--title is required");
  if (goal === undefined) throw new GoalCliValidationError("--goal is required");

  return {
    settingsArgs,
    request: goalSubmissionRequestSchema.parse({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      title,
      goal,
      requirements: requirements.length > 0 ? requirements : CLI_DEFAULT_REQUIREMENTS,
      acceptance_criteria: acceptanceCriteria.length > 0
        ? acceptanceCriteria
        : CLI_DEFAULT_ACCEPTANCE_CRITERIA,
      ...(maxIterations === undefined ? {} : { max_iterations: maxIterations }),
    }),
  };
}

export function parseGoalStatusCliArgs(argv: readonly string[]): GoalStatusCliArgs {
  let goalId: string | undefined;
  const settingsArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (SETTINGS_OPTIONS.has(argument)) {
      index = settingArgsFor(argv, index, argument, settingsArgs);
      continue;
    }
    if (argument.startsWith("--")) throw new GoalCliValidationError(`unknown argument: ${argument}`);
    if (goalId !== undefined) throw new GoalCliValidationError(`unexpected argument: ${argument}`);
    goalId = argument;
  }

  if (goalId === undefined) throw new GoalCliValidationError("goal_id is required");
  return { settingsArgs, goalId: goalIdSchema.parse(goalId) };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function registerShutdown(server: Server): void {
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void closeServer(server).catch(() => undefined);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

export async function runGoalSubmissionCommand(
  argv: readonly string[],
  dependencies: GoalCliDependencies = {},
): Promise<GoalSubmissionResult> {
  const args = parseGoalSubmissionCliArgs(argv);
  const settings = await (dependencies.loadSettings ?? loadSettings)(args.settingsArgs);
  const context = (dependencies.createAppContext ?? createAppContext)(settings);
  if (context.goalSubmission === undefined) throw new Error("GoalSubmission unavailable");

  let server: Server | undefined;
  try {
    server = await (dependencies.startApp ?? startApp)(settings, context, { silent: true });
    const result = await context.goalSubmission.submitGoal(args.request);
    if (result.status === "running") {
      if (dependencies.registerShutdown !== undefined) {
        const close = (): void => {
          void (dependencies.closeServer ?? closeServer)(server!).catch(() => undefined);
        };
        dependencies.registerShutdown(close);
      } else {
        registerShutdown(server);
      }
    } else {
      await (dependencies.closeServer ?? closeServer)(server);
    }
    return result;
  } catch (error: unknown) {
    if (server !== undefined) {
      const close = dependencies.closeServer ?? closeServer;
      await close(server).catch(() => undefined);
    }
    throw error;
  }
}

async function readGoalStatus(
  context: AppContext,
  goalId: string,
): Promise<GoalStatusCliResult> {
  const orchestration = context.goalOrchestration;
  if (orchestration === undefined) throw new Error("GoalOrchestration unavailable");
  const goal = await orchestration.getGoal(goalId);
  if (goal === null) throw new Error(`Goal "${goalId}" was not found.`);

  const storageRoot = context.storageRoot ?? orchestration.storageRoot;
  const execution = goal.current_task_id === undefined || goal.execution_id === undefined
    ? null
    : await new ExecutionContextService(storageRoot).getExecutionContext(
      goal.workspace_id,
      goal.current_task_id,
      goal.execution_id,
    );
  const loop = goal.loop_id === undefined || context.autoIteration === undefined
    ? null
    : await context.autoIteration.getLoop(goal.loop_id);
  const reviewRequest = loop?.review_request_id === undefined
    ? null
    : await new ReviewRequestService(storageRoot).getReviewRequest(
      goal.workspace_id,
      loop.review_request_id,
    );
  const reviewResult = loop?.review_request_id === undefined
    ? null
    : await new ReviewResultService(storageRoot).getReviewResultByRequest(
      goal.workspace_id,
      loop.review_request_id,
    );

  return {
    goal_id: goal.goal_id,
    status: goal.status,
    phase_id: goal.current_phase_id ?? null,
    task_id: goal.current_task_id ?? null,
    execution_id: goal.execution_id ?? null,
    execution_status: execution?.status ?? null,
    review_status: reviewRequest?.status ?? loop?.stage ?? null,
    review_request_id: loop?.review_request_id ?? null,
    review_result_status: reviewResult?.status ?? null,
  };
}

export async function runGoalStatusCommand(
  argv: readonly string[],
  dependencies: Pick<GoalCliDependencies, "loadSettings" | "createAppContext"> = {},
): Promise<GoalStatusCliResult> {
  const args = parseGoalStatusCliArgs(argv);
  const settings: ResolvedSettings = await (dependencies.loadSettings ?? loadSettings)(args.settingsArgs);
  const context = (dependencies.createAppContext ?? createAppContext)(settings);
  return readGoalStatus(context, args.goalId);
}

export interface GoalCliFailure {
  readonly status: "failed";
  readonly stage: string;
  readonly reason: string;
}

function zodReason(error: ZodError): string {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "input" : issue.path.join(".");
    return `${path}: ${issue.message}`;
  }).join("; ");
}

export function goalCliFailure(error: unknown, fallbackStage = "submission"): GoalCliFailure {
  if (error instanceof GoalPreflightError) {
    return {
      status: "failed",
      stage: error.result.failure_stage ?? "preflight",
      reason: error.result.failure_reason ?? error.message,
    };
  }
  return {
    status: "failed",
    stage: error instanceof GoalCliValidationError || error instanceof ZodError
      ? "validation"
      : fallbackStage,
    reason: error instanceof ZodError
      ? zodReason(error)
      : error instanceof Error && error.message !== "" ? error.message : String(error),
  };
}
