import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutoIterationService,
  type AutoIteration,
} from "../../src/control-plane/auto-iteration.js";
import {
  ActuationAuthorizationStore,
  ControlledActuationService,
} from "../../src/control-plane/controlled-actuation.js";
import {
  ExecutionRoutingService,
  type ExecutionCompletedEvent,
} from "../../src/control-plane/execution-routing.js";
import {
  GoalOrchestrationService,
  type GoalOrchestration,
} from "../../src/control-plane/goal-orchestration.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { ReviewRequestService } from "../../src/context/review-request-service.js";
import { TaskContextService } from "../../src/context/service.js";
import { ReviewCompletionRouter } from "../../src/router/review-completion-router.js";
import { BrowserRouter } from "../../src/router/browser-router.js";
import type { ReviewCompletionAdapter } from "../../src/delivery/review-completion-adapter.js";
import type {
  ReviewDeliveryAdapter,
  ReviewDeliveryRequest,
  ReviewDeliveryResult,
} from "../../src/delivery/review-delivery-adapter.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

type ReviewDecision = "APPROVE" | "ITERATE" | "HUMAN_REQUIRED" | "FAILED";

function verdict(reviewRequestId: string, decision: Exclude<ReviewDecision, "FAILED">): string {
  return `<lrm-review-result>${JSON.stringify({
    schema_version: 1,
    review_request_id: reviewRequestId,
    decision,
    summary: `${decision} summary`,
    ...(decision === "ITERATE" ? {
      iteration: {
        goal: "Fix the blocking review issue",
        requirements: ["Change the implementation"],
        acceptance_criteria: ["The focused test passes"],
      },
    } : {}),
  })}</lrm-review-result>`;
}

class FakeReviewDelivery implements ReviewDeliveryAdapter {
  public readonly requests: ReviewDeliveryRequest[] = [];

  public constructor(private readonly outcome: "delivered" | "failed") {}

  public async deliver(request: ReviewDeliveryRequest): Promise<ReviewDeliveryResult> {
    this.requests.push(structuredClone(request));
    return this.outcome === "delivered"
      ? { status: "delivered", delivered_at: new Date().toISOString() }
      : {
        status: "failed",
        retryable: false,
        error: { code: "TEST_DELIVERY_FAILED", message: "delivery failed" },
      };
  }
}

class FakeReviewCompletion implements ReviewCompletionAdapter {
  public readonly requests: string[] = [];

  public constructor(private readonly decision: ReviewDecision) {}

  public async collect(request: { readonly review_request_id: string }): Promise<{
    readonly status: "COMPLETED";
    readonly content: string;
  } | { readonly status: "FAILED"; readonly error: string }> {
    this.requests.push(request.review_request_id);
    if (this.decision === "FAILED") {
      return { status: "FAILED", error: "completion failed" };
    }
    return {
      status: "COMPLETED",
      content: verdict(request.review_request_id, this.decision),
    };
  }
}

async function harness(options: {
  readonly conversationId?: string | null;
  readonly decision?: ReviewDecision;
  readonly delivery?: "delivered" | "failed";
} = {}): Promise<{
  readonly root: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly registry: WorkspaceRegistry;
  readonly executions: ExecutionContextService;
  readonly goals: GoalOrchestrationService;
  readonly auto: AutoIterationService;
  readonly router: ExecutionRoutingService;
  readonly starts: string[];
  readonly deliveries: FakeReviewDelivery;
  readonly completions: FakeReviewCompletion;
}> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-execution-routing-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-execution-routing-workspace-"));
  temporaryDirectories.push(root, workspaceRoot);

  const workspaceId = "workspace-a";
  const taskId = "task-1";
  const executionId = "execution-1";
  const conversationId = options.conversationId ?? "conversation-1";
  const registry = new WorkspaceRegistry([{ id: workspaceId, name: "Workspace A", path: workspaceRoot }]);
  const tasks = new TaskContextService(root);
  const executions = new ExecutionContextService(root);
  await tasks.createTaskContext({
    task_id: taskId,
    workspace_id: workspaceId,
    ...(options.conversationId !== null ? { conversation_id: conversationId } : {}),
  });
  await executions.createExecutionContext({
    execution_id: executionId,
    task_id: taskId,
    workspace_id: workspaceId,
    status: "passed",
    summary: "Codex completed",
  });

  const authorizations = new ActuationAuthorizationStore(root);
  const starts: string[] = [];
  const controlled = new ControlledActuationService(registry, {
    storageRoot: root,
    authorizationStore: authorizations,
    taskContextService: tasks,
    executionContextService: executions,
    adapter: {
      start: async (request) => {
        starts.push(request.execution_id);
        const execution = await executions.createExecutionContext({
          execution_id: request.execution_id,
          task_id: request.task_id,
          workspace_id: request.workspace_id,
          process_id: 10_000 + starts.length,
          command: "fake-codex exec --json -",
        });
        return {
          execution_id: execution.execution_id,
          process_id: execution.process_id!,
          started_at: execution.started_at,
          accepted: "new" as const,
        };
      },
    },
  });
  const deliveries = new FakeReviewDelivery(options.delivery ?? "delivered");
  const completions = new FakeReviewCompletion(options.decision ?? "APPROVE");
  const browserRouter = new BrowserRouter(root, deliveries);
  const completionRouter = new ReviewCompletionRouter(root, completions);
  const auto = new AutoIterationService(registry, {
    storageRoot: root,
    taskContextService: tasks,
    executionContextService: executions,
    browserRouter,
    completionRouter,
    controlledActuation: controlled,
  });
  const goals = new GoalOrchestrationService(registry, {
    storageRoot: root,
    taskContextService: tasks,
    executionContextService: executions,
    authorizationStore: authorizations,
    controlledActuation: controlled,
    autoIteration: auto,
  });
  auto.setTerminalListener((loop: AutoIteration) => goals.onAutoIterationTerminal(loop));
  const router = new ExecutionRoutingService(registry, {
    storageRoot: root,
    taskContextService: tasks,
    executionContextService: executions,
    autoIteration: auto,
    goalOrchestration: goals,
  });
  return {
    root,
    workspaceId,
    taskId,
    executionId,
    registry,
    executions,
    goals,
    auto,
    router,
    starts,
    deliveries,
    completions,
  };
}

function event(h: Awaited<ReturnType<typeof harness>>, conversationId?: string): ExecutionCompletedEvent {
  return {
    execution_id: h.executionId,
    task_id: h.taskId,
    workspace_id: h.workspaceId,
    ...(conversationId === undefined ? {} : { conversation_id: conversationId }),
    status: "completed",
    result: { status: "completed" },
    diff_available: true,
  };
}

describe("ExecutionRoutingService", () => {
  it("creates one Review Goal and enters the existing review workflow", async () => {
    const h = await harness();
    const { task_id: _taskId, ...eventWithoutTask } = event(h, "conversation-1");

    const result = await h.router.onCompleted(eventWithoutTask);

    expect(result).toMatchObject({
      execution_id: h.executionId,
      goal_id: expect.any(String),
      review_request_id: expect.any(String),
      routing_status: "created",
    });
    expect(await h.goals.listGoals()).toHaveLength(1);
    expect(await new ReviewRequestService(h.root).listReviewRequests(h.workspaceId))
      .toHaveLength(1);
    expect(h.deliveries.requests).toHaveLength(1);
    expect(h.completions.requests).toHaveLength(1);
  });

  it("rejects automatic routing with conversation_required when no conversation is bound", async () => {
    const h = await harness();

    await expect(h.router.onCompleted(event(h))).rejects.toMatchObject({
      name: "ExecutionRoutingError",
      reason: "conversation_required",
      code: "conversation_required",
    });
    expect(await h.goals.listGoals()).toEqual([]);
    expect(await new ReviewRequestService(h.root).listReviewRequests(h.workspaceId))
      .toEqual([]);
  });

  it("is idempotent for a repeated completion event", async () => {
    const h = await harness();
    const first = await h.router.onCompleted(event(h, "conversation-1"));
    const second = await h.router.onCompleted(event(h, "conversation-1"));

    expect(second).toMatchObject({
      execution_id: first.execution_id,
      goal_id: first.goal_id,
      review_request_id: first.review_request_id,
      routing_status: "existing",
    });
    expect(await h.goals.listGoals()).toHaveLength(1);
    expect(await new ReviewRequestService(h.root).listReviewRequests(h.workspaceId))
      .toHaveLength(1);
    expect(h.deliveries.requests).toHaveLength(1);
    expect(h.completions.requests).toHaveLength(1);
  });

  it("advances an existing Goal without starting another Codex execution", async () => {
    const h = await harness();
    await h.goals.createGoal({
      goal_id: "goal-existing",
      workspace_id: h.workspaceId,
      conversation_id: "conversation-1",
      phases: [{
        phase_id: "phase-existing",
        objective: "Review the existing Goal execution",
        tasks: [{
          task_id: h.taskId,
          goal: "Complete the existing Goal execution.",
          requirements: ["Keep the review routing intact."],
          acceptance_criteria: ["The review workflow completes."],
          max_iterations: 2,
        }],
      }],
    });
    const started = await h.goals.startGoal({ goal_id: "goal-existing" });
    if (started.execution_id === undefined) throw new Error("existing Goal did not start");
    await h.executions.updateExecutionContext(h.workspaceId, h.taskId, started.execution_id, {
      status: "passed",
      summary: "Codex completed",
    });

    const result = await h.router.onCompleted({
      execution_id: started.execution_id,
      task_id: h.taskId,
      workspace_id: h.workspaceId,
      conversation_id: "conversation-1",
      status: "completed",
    });

    expect(result.goal_id).toBe("goal-existing");
    expect(h.starts).toHaveLength(1);
    expect((await h.goals.getGoal("goal-existing"))?.status).toBe("completed");
    expect(await new ReviewRequestService(h.root).listReviewRequests(h.workspaceId))
      .toHaveLength(1);
  });

  it.each([
    ["delivery failure", { delivery: "failed" as const }, "human_required" as const],
    ["review completion failure", { decision: "FAILED" as const }, "human_required" as const],
    ["HUMAN_REQUIRED verdict", { decision: "HUMAN_REQUIRED" as const }, "human_required" as const],
    ["ITERATE verdict", { decision: "ITERATE" as const }, "running" as const],
  ])("propagates %s through the existing Goal workflow", async (_name, options, expectedStatus) => {
    const h = await harness(options);

    const result = await h.router.onCompleted(event(h, "conversation-1"));
    const goals = await h.goals.listGoals();
    const goal = goals.find((candidate: GoalOrchestration) => candidate.goal_id === result.goal_id);
    if (goal === undefined) throw new Error("routed Goal was not persisted");

    expect(goal.status).toBe(expectedStatus);
    expect(await new ReviewRequestService(h.root).listReviewRequests(h.workspaceId))
      .toHaveLength(1);
    if ("decision" in options && options.decision === "ITERATE") {
      expect(h.completions.requests).toHaveLength(1);
      expect(await h.auto.getLoop(goal.loop_id!)).toMatchObject({ stage: "execution", iteration: 2 });
    }
  });
});
