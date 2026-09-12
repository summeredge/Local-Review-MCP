import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { ExecutionContextService } from "../context/execution-service.js";
import {
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { TaskContextService } from "../context/service.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import type { ExecutionContext, ReviewRequestContext, TaskContext } from "../context/types.js";
import { reviewRequestIdSchema } from "../context/review-schema.js";
import {
  GoalOrchestrationService,
  goalIdSchema,
  type GoalOrchestration,
  type StartReviewGoalInput,
} from "./goal-orchestration.js";
import { AutoIterationService, type AutoIteration } from "./auto-iteration.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";

const eventConversationIdSchema = z.string().max(256);
const executionCompletedStatusSchema = z.enum(["completed", "passed"])
  .default("passed")
  .transform(() => "passed" as const);

export const executionCompletedEventSchema = z.object({
  execution_id: executionIdSchema,
  task_id: taskIdSchema.optional(),
  workspace_id: workspaceIdSchema,
  conversation_id: eventConversationIdSchema.optional(),
  status: executionCompletedStatusSchema,
  result: z.unknown().optional(),
  diff_available: z.boolean().optional(),
}).strict();

export const executionRoutingResultSchema = z.object({
  execution_id: executionIdSchema,
  goal_id: goalIdSchema,
  review_request_id: reviewRequestIdSchema,
  routing_status: z.enum(["created", "existing"]),
}).strict();

export type ExecutionCompletedEvent = z.input<typeof executionCompletedEventSchema>;
export type ExecutionRoutingResult = z.infer<typeof executionRoutingResultSchema>;

export class ExecutionRoutingError extends Error {
  public readonly code: string;

  public constructor(public readonly reason: string, message = reason) {
    super(message.includes(reason) ? message : `${reason}: ${message}`);
    this.name = "ExecutionRoutingError";
    this.code = reason;
  }
}

type TaskPort = Pick<TaskContextService, "getTaskContext" | "listTaskContexts"> & {
  readonly storageRoot?: string;
};
type ExecutionPort = Pick<ExecutionContextService, "getExecutionContext"> & {
  readonly storageRoot?: string;
};
type ReviewRequestPort = Pick<ReviewRequestService, "getReviewRequest" | "listReviewRequests"> & {
  readonly storageRoot?: string;
};
type GoalPort = Pick<
  GoalOrchestrationService,
  "listGoals" | "advanceGoal" | "startReviewGoal"
> & { readonly storageRoot?: string };
type AutoIterationPort = Pick<
  AutoIterationService,
  "start" | "advance" | "getLoop" | "onExecutionTerminal"
> & {
  readonly storageRoot?: string;
};

export interface ExecutionRoutingServiceOptions {
  readonly storageRoot?: string;
  readonly taskContextService?: TaskPort;
  readonly executionContextService?: ExecutionPort;
  readonly reviewRequestService?: ReviewRequestPort;
  readonly goalOrchestration?: GoalPort;
  readonly autoIteration?: AutoIterationPort;
}

interface ResolvedExecution {
  readonly task: TaskContext;
  readonly execution: ExecutionContext;
}

interface GoalMatch {
  readonly goal: GoalOrchestration;
  readonly loop: AutoIteration | null;
}

function stableId(kind: string, workspaceId: string, taskId: string, executionId: string): string {
  const digest = createHash("sha256")
    .update(`${workspaceId}\0${taskId}\0${executionId}\0${kind}`)
    .digest("hex")
    .slice(0, 32);
  return `execution-${kind}-${digest}`;
}

function reviewGoalInput(
  event: z.output<typeof executionCompletedEventSchema>,
  taskId: string,
  conversationId: string,
): StartReviewGoalInput {
  const evidence = event.diff_available === false
    ? "Review the completed execution evidence."
    : "Review the completed execution and the available diff.";
  return {
    goal_id: stableId("goal", event.workspace_id, taskId, event.execution_id),
    phase_id: stableId("phase", event.workspace_id, taskId, event.execution_id),
    workspace_id: event.workspace_id,
    task_id: taskId,
    conversation_id: conversationId,
    execution_id: event.execution_id,
    title: `Review Codex execution ${event.execution_id}`,
    goal: `Review the completed Codex execution ${event.execution_id}.`,
    requirements: [evidence],
    acceptance_criteria: ["Produce a review verdict for the completed execution."],
    max_iterations: 2,
  };
}

function goalContainsTask(goal: GoalOrchestration, taskId: string): boolean {
  return goal.phases.some((phase) => phase.tasks.some((task) => task.task_id === taskId));
}

export class ExecutionRoutingService {
  public readonly storageRoot: string;
  private readonly tasks: TaskPort;
  private readonly executions: ExecutionPort;
  private readonly reviewRequests: ReviewRequestPort;
  private readonly goals: GoalPort;
  private readonly auto: AutoIterationPort;
  private readonly inFlight = new Map<string, Promise<ExecutionRoutingResult>>();

  public constructor(
    private readonly registry: WorkspaceRegistry,
    options: ExecutionRoutingServiceOptions = {},
  ) {
    this.storageRoot = resolve(
      options.storageRoot
        ?? options.executionContextService?.storageRoot
        ?? options.taskContextService?.storageRoot
        ?? options.reviewRequestService?.storageRoot
        ?? options.goalOrchestration?.storageRoot
        ?? options.autoIteration?.storageRoot
        ?? defaultTaskContextStorageRoot(),
    );
    this.tasks = options.taskContextService ?? new TaskContextService(this.storageRoot);
    this.executions = options.executionContextService ?? new ExecutionContextService(this.storageRoot);
    this.reviewRequests = options.reviewRequestService ?? new ReviewRequestService(this.storageRoot);
    this.auto = options.autoIteration ?? new AutoIterationService(registry, { storageRoot: this.storageRoot });
    this.goals = options.goalOrchestration ?? new GoalOrchestrationService(registry, {
      storageRoot: this.storageRoot,
      autoIteration: this.auto,
    });

    for (const dependency of [
      this.tasks.storageRoot,
      this.executions.storageRoot,
      this.reviewRequests.storageRoot,
      this.goals.storageRoot,
      this.auto.storageRoot,
    ]) {
      if (dependency !== undefined && resolve(dependency) !== this.storageRoot) {
        throw new Error("Execution Routing dependencies must share one storage root.");
      }
    }
  }

  public onCompleted(event: ExecutionCompletedEvent): Promise<ExecutionRoutingResult> {
    const parsed = executionCompletedEventSchema.parse(event);
    const key = `${this.storageRoot}\0${parsed.workspace_id}\0${parsed.task_id ?? ""}\0${parsed.execution_id}`;
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const operation = this.routeOnce(parsed);
    this.inFlight.set(key, operation);
    void operation.finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  public onExecutionCompleted(event: ExecutionCompletedEvent): Promise<ExecutionRoutingResult> {
    return this.onCompleted(event);
  }

  public notifyExecutionCompleted(event: ExecutionCompletedEvent): Promise<ExecutionRoutingResult> {
    return this.onCompleted(event);
  }

  public async onExecutionTerminal(execution: ExecutionContext): Promise<void> {
    if (execution.status === "running") return;
    await this.auto.onExecutionTerminal(execution);
  }

  public notifyExecutionTerminal(execution: ExecutionContext): Promise<void> {
    return this.onExecutionTerminal(execution);
  }

  private async routeOnce(
    event: z.output<typeof executionCompletedEventSchema>,
  ): Promise<ExecutionRoutingResult> {
    this.registry.resolve(event.workspace_id);
    const resolved = await this.resolveExecution(event);
    if (resolved.execution.status !== "passed") {
      throw new ExecutionRoutingError(
        "execution_not_completed",
        `Execution "${event.execution_id}" is not completed successfully.`,
      );
    }

    const conversationId = this.conversationId(event, resolved.task);
    const existingRequest = await this.findReviewRequest(
      event.workspace_id,
      resolved.task.task_id,
      event.execution_id,
      conversationId,
    );
    const match = await this.findGoal(
      event.workspace_id,
      resolved.task.task_id,
      event.execution_id,
    );

    if (match !== null) {
      if (match.goal.conversation_id !== conversationId) {
        throw new ExecutionRoutingError(
          "conversation_mismatch",
          "The completion conversation does not match the Goal.",
        );
      }
      await this.advanceExisting(match, resolved.execution);
      const reviewRequestId = await this.requiredReviewRequest(
        event.workspace_id,
        resolved.task.task_id,
        event.execution_id,
        conversationId,
        match.loop,
      );
      return this.result(event.execution_id, match.goal.goal_id, reviewRequestId,
        existingRequest === null ? "created" : "existing");
    }

    const started = await this.goals.startReviewGoal(
      reviewGoalInput(event, resolved.task.task_id, conversationId),
    );
    const reviewRequestId = await this.requiredReviewRequest(
      event.workspace_id,
      resolved.task.task_id,
      event.execution_id,
      conversationId,
      started.loop_id === undefined ? null : await this.auto.getLoop(started.loop_id),
    );
    return this.result(
      event.execution_id,
      started.goal_id,
      reviewRequestId,
      existingRequest === null ? "created" : "existing",
    );
  }

  private async resolveExecution(
    event: z.output<typeof executionCompletedEventSchema>,
  ): Promise<ResolvedExecution> {
    if (event.task_id !== undefined) {
      const task = await this.tasks.getTaskContext(event.task_id);
      if (task === null || task.workspace_id !== event.workspace_id) {
        throw new ExecutionRoutingError("execution_not_found", "The completion Execution was not found.");
      }
      const execution = await this.executions.getExecutionContext(
        event.workspace_id,
        event.task_id,
        event.execution_id,
      );
      if (execution === null) {
        throw new ExecutionRoutingError("execution_not_found", "The completion Execution was not found.");
      }
      this.assertExecutionIdentity(execution, event.workspace_id, event.task_id, event.execution_id);
      return { task, execution };
    }

    const matches: ResolvedExecution[] = [];
    for (const task of await this.tasks.listTaskContexts()) {
      if (task.workspace_id !== event.workspace_id) continue;
      const execution = await this.executions.getExecutionContext(
        event.workspace_id,
        task.task_id,
        event.execution_id,
      );
      if (execution !== null) matches.push({ task, execution });
    }
    if (matches.length === 0) {
      throw new ExecutionRoutingError("execution_not_found", "The completion Execution was not found.");
    }
    if (matches.length > 1) {
      throw new ExecutionRoutingError(
        "execution_identity_ambiguous",
        `Execution "${event.execution_id}" belongs to more than one Task.`,
      );
    }
    return matches[0]!;
  }

  private conversationId(
    event: z.output<typeof executionCompletedEventSchema>,
    task: TaskContext,
  ): string {
    const explicit = event.conversation_id?.trim();
    if (explicit === undefined || explicit === "") {
      throw new ExecutionRoutingError(
        "conversation_required",
        "conversation_id is required for automatic review routing.",
      );
    }
    const conversationId = event.conversation_id!;
    if (task.conversation_id !== undefined && task.conversation_id !== conversationId) {
      throw new ExecutionRoutingError(
        "conversation_mismatch",
        "The completion conversation does not match the Task.",
      );
    }
    return conversationId;
  }

  private async findGoal(
    workspaceId: string,
    taskId: string,
    executionId: string,
  ): Promise<GoalMatch | null> {
    const matches: GoalMatch[] = [];
    for (const goal of await this.goals.listGoals()) {
      if (goal.workspace_id !== workspaceId || !goalContainsTask(goal, taskId)) continue;
      const loop = goal.loop_id === undefined ? null : await this.auto.getLoop(goal.loop_id);
      if (goal.execution_id === executionId
        || loop?.execution_id === executionId
        || loop?.initial_execution_id === executionId) {
        matches.push({ goal, loop });
      }
    }
    if (matches.length > 1) {
      throw new ExecutionRoutingError(
        "goal_identity_ambiguous",
        `Execution "${executionId}" matches more than one Goal.`,
      );
    }
    return matches[0] ?? null;
  }

  private async advanceExisting(
    match: GoalMatch,
    execution: ExecutionContext,
  ): Promise<void> {
    if (match.loop !== null) await this.auto.onExecutionTerminal(execution);
    await this.goals.advanceGoal(match.goal.goal_id);
  }

  private async findReviewRequest(
    workspaceId: string,
    taskId: string,
    executionId: string,
    conversationId: string,
  ): Promise<ReviewRequestContext | null> {
    const matches = (await this.reviewRequests.listReviewRequests(workspaceId)).filter((request) =>
      request.task_id === taskId
      && request.execution_id === executionId
      && request.conversation_id === conversationId);
    if (matches.length > 1) {
      throw new ExecutionRoutingError(
        "review_request_identity_ambiguous",
        `Execution "${executionId}" has more than one Review Request.`,
      );
    }
    return matches[0] ?? null;
  }

  private async requiredReviewRequest(
    workspaceId: string,
    taskId: string,
    executionId: string,
    conversationId: string,
    loop: AutoIteration | null,
  ): Promise<string> {
    if (loop?.review_request_id !== undefined) {
      const request = await this.reviewRequests.getReviewRequest(workspaceId, loop.review_request_id);
      if (request !== null) {
        if (request.task_id === taskId
          && request.execution_id === executionId
          && request.conversation_id === conversationId) {
          return request.review_request_id;
        }
      }
    }
    const request = await this.findReviewRequest(workspaceId, taskId, executionId, conversationId);
    if (request !== null) return request.review_request_id;
    if (loop?.review_request_id !== undefined) {
      throw new ExecutionRoutingError(
        "review_request_identity_mismatch",
        "Review Request identity does not match the completion event.",
      );
    }
    throw new ExecutionRoutingError(
      "review_request_not_created",
      `No Review Request was created for Execution "${executionId}".`,
    );
  }

  private result(
    executionId: string,
    goalId: string,
    reviewRequestId: string,
    routingStatus: "created" | "existing",
  ): ExecutionRoutingResult {
    return executionRoutingResultSchema.parse({
      execution_id: executionId,
      goal_id: goalId,
      review_request_id: reviewRequestId,
      routing_status: routingStatus,
    });
  }

  private assertExecutionIdentity(
    execution: ExecutionContext,
    workspaceId: string,
    taskId: string,
    executionId: string,
  ): void {
    if (execution.workspace_id !== workspaceId
      || execution.task_id !== taskId
      || execution.execution_id !== executionId) {
      throw new ExecutionRoutingError(
        "execution_identity_mismatch",
        "Execution identity does not match the completion event.",
      );
    }
  }
}

export { ExecutionRoutingService as ExecutionRouter };
