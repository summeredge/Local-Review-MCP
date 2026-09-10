import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutoIterationService,
  autoIterationSchema,
  autoIterationStateFile,
  buildAutoIterationInstruction,
  type AutoIteration,
} from "../../src/control-plane/auto-iteration.js";
import {
  ActuationAuthorizationStore,
  ControlledActuationService,
  controlledActuationStateFile,
  type ActuationAuthorization,
  type ControlledActuation,
} from "../../src/control-plane/controlled-actuation.js";
import {
  type CodexExecutionStartRequest,
  type CodexExecutionStartResult,
} from "../../src/control-plane/codex-execution-adapter.js";
import {
  GoalOrchestrationService,
  goalOrchestrationSchema,
  goalOrchestrationStateFile,
  type CreateGoalInput,
  type GoalOrchestration,
} from "../../src/control-plane/goal-orchestration.js";
import { ExtensionDeliveryAdapter } from "../../src/delivery/extension-delivery-adapter.js";
import { BrowserWorkerReviewCompletionAdapter } from "../../src/delivery/browser-worker-review-completion-adapter.js";
import type { ReviewDeliveryRequest } from "../../src/delivery/review-delivery-adapter.js";
import type { ExtensionDeliveryReceipt } from "../../src/control-plane/extension-delivery.js";
import { BrowserWorkerClient, type BrowserCompletionResult } from "../../src/browser-worker-client/browser-worker-client.js";
import { ConversationRoutingService } from "../../src/context/conversation-routing-service.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { ReviewDeliveryService } from "../../src/context/review-delivery-service.js";
import { ReviewRequestService } from "../../src/context/review-request-service.js";
import { ReviewResultService } from "../../src/context/review-result-service.js";
import type { ExecutionContext } from "../../src/context/types.js";
import { TaskContextService } from "../../src/context/service.js";
import { BrowserRouter } from "../../src/router/browser-router.js";
import { ReviewCompletionRouter } from "../../src/router/review-completion-router.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

type ReviewDecision = "APPROVE" | "ITERATE" | "HUMAN_REQUIRED";
type ExecutionTerminalStatus = "passed" | "failed";

const temporaryDirectories: string[] = [];
const fakeExtractedAt = "2026-01-01T00:00:00.000Z";
const fakeDeliveredAt = 1_767_225_600_000;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

function verdict(reviewRequestId: string, decision: ReviewDecision): string {
  return `<lrm-review-result>${JSON.stringify({
    schema_version: 1,
    review_request_id: reviewRequestId,
    decision,
    summary: `${decision} summary`,
    ...(decision === "ITERATE" ? {
      iteration: {
        goal: "Fix the blocking defect",
        requirements: ["Change the implementation"],
        acceptance_criteria: ["The focused test passes"],
      },
    } : {}),
  })}</lrm-review-result>`;
}

function goalIdentity(kind: string, goalId: string, phaseId: string, taskId: string): string {
  const digest = createHash("sha256")
    .update(`${goalId}\0${phaseId}\0${taskId}\0${kind}`)
    .digest("hex")
    .slice(0, 32);
  return `goal-${kind}-${digest}`;
}

function loopIdentity(kind: string, loopId: string, iteration: number): string {
  const digest = createHash("sha256")
    .update(`${loopId}\0${iteration}\0${kind}`)
    .digest("hex")
    .slice(0, 32);
  return `auto-${kind}-${digest}`;
}

function plan(goalId: string, taskIds: readonly string[] = ["task-1"]): CreateGoalInput {
  return {
    goal_id: goalId,
    workspace_id: "workspace-a",
    conversation_id: "conversation-1",
    phases: [{
      phase_id: "phase-1",
      objective: "Implement the requested change",
      tasks: taskIds.map((taskId) => ({
        task_id: taskId,
        goal: `Complete ${taskId}`,
        requirements: ["Keep the change narrow"],
        acceptance_criteria: ["The integration test passes"],
        max_iterations: 2,
      })),
    }],
  };
}

class FakeCodexExecution {
  public readonly starts: CodexExecutionStartRequest[] = [];

  public readonly start = vi.fn(async (
    request: CodexExecutionStartRequest,
  ): Promise<CodexExecutionStartResult> => {
    this.starts.push(structuredClone(request));
    const existing = await this.executions.getExecutionContext(
      request.workspace_id,
      request.task_id,
      request.execution_id,
    );
    if (existing !== null) throw new Error("Fake Codex received a duplicate execution start.");

    const execution = await this.executions.createExecutionContext({
      execution_id: request.execution_id,
      workspace_id: request.workspace_id,
      task_id: request.task_id,
      status: "running",
      process_id: 40_000 + this.starts.length,
      command: "fake-codex exec --json -",
    });
    return {
      execution_id: execution.execution_id,
      process_id: execution.process_id!,
      started_at: execution.started_at,
      accepted: "new",
    };
  });

  public constructor(private readonly executions: ExecutionContextService) {}

  public async trigger(
    executionId: string,
    status: "running" | ExecutionTerminalStatus,
  ): Promise<ExecutionContext> {
    const request = this.starts.find((candidate) => candidate.execution_id === executionId);
    if (request === undefined) throw new Error(`Fake execution "${executionId}" was not started.`);
    return this.executions.updateExecutionContext(
      request.workspace_id,
      request.task_id,
      executionId,
      status === "running"
        ? { status, process_id: 40_000 + this.starts.indexOf(request) + 1 }
        : { status, summary: `fake execution ${status}` },
    );
  }
}

class FakeExtensionDeliveryBroker {
  public readonly requests: ReviewDeliveryRequest[] = [];

  public readonly dispatch = vi.fn(async (
    request: ReviewDeliveryRequest,
  ): Promise<ExtensionDeliveryReceipt> => {
    this.requests.push(structuredClone(request));
    return {
      delivery_id: "00000000-0000-4000-8000-000000000001",
      conversation_id: request.conversation_id,
      client_id: "fake-extension",
      document_id: "fake-document",
      navigation_epoch: 0,
      status: "delivered",
      message_id: `fake-message-${this.requests.length}`,
      completed_at: fakeDeliveredAt,
    };
  });
}

class FakeReviewCompletionClient implements Pick<BrowserWorkerClient, "collectCompletion"> {
  public readonly requests: Array<{
    readonly conversation_id: string;
    readonly review_request_id: string;
  }> = [];
  private nextDecision = 0;

  public readonly collectCompletion = vi.fn(async (
    conversationId: string,
    reviewRequestId: string,
  ): Promise<BrowserCompletionResult> => {
    this.requests.push({ conversation_id: conversationId, review_request_id: reviewRequestId });
    const decision = this.decisions[Math.min(this.nextDecision++, this.decisions.length - 1)]!;
    return {
      conversationId,
      status: "COMPLETED",
      content: verdict(reviewRequestId, decision),
      extractedAt: fakeExtractedAt,
    };
  });

  public constructor(private readonly decisions: readonly ReviewDecision[]) {
    if (decisions.length === 0) throw new Error("Fake review decisions must not be empty.");
  }
}

class FakeReviewBoundary {
  public readonly broker = new FakeExtensionDeliveryBroker();
  public readonly completionClient: FakeReviewCompletionClient;
  public readonly deliveryAdapter = new ExtensionDeliveryAdapter(this.broker);

  public constructor(decisions: readonly ReviewDecision[]) {
    this.completionClient = new FakeReviewCompletionClient(decisions);
  }
}

type Harness = {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly registry: WorkspaceRegistry;
  readonly tasks: TaskContextService;
  readonly executions: ExecutionContextService;
  readonly authorizations: ActuationAuthorizationStore;
  readonly codex: FakeCodexExecution;
  readonly review: FakeReviewBoundary;
  readonly controlled: ControlledActuationService;
  readonly browserRouter: BrowserRouter;
  readonly completionRouter: ReviewCompletionRouter;
  readonly auto: AutoIterationService;
  readonly goals: GoalOrchestrationService;
  readonly drainTerminalListeners: () => Promise<void>;
};

type RestartedHarness = Harness & {
  readonly noSpawn: ReturnType<typeof vi.fn>;
};

function wireGoalAdvance(
  auto: AutoIterationService,
  goals: GoalOrchestrationService,
): () => Promise<void> {
  const jobs: Promise<void>[] = [];
  auto.setTerminalListener((loop) => {
    const job = goals.onAutoIterationTerminal(loop);
    jobs.push(job);
    return job;
  });
  return async () => {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      await Promise.resolve();
      const pending = jobs.splice(0);
      if (pending.length === 0) {
        if (attempt > 0) return;
        continue;
      }
      await Promise.all(pending);
    }
    throw new Error("Fake terminal listeners did not settle.");
  };
}

async function createHarness(
  decisions: readonly ReviewDecision[] = ["APPROVE"],
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-control-loop-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-control-loop-workspace-"));
  temporaryDirectories.push(root, workspaceRoot);

  const registry = new WorkspaceRegistry([{
    id: "workspace-a",
    name: "Workspace A",
    path: workspaceRoot,
  }]);
  const tasks = new TaskContextService(root);
  const executions = new ExecutionContextService(root);
  const authorizations = new ActuationAuthorizationStore(root);
  const codex = new FakeCodexExecution(executions);
  const review = new FakeReviewBoundary(decisions);
  const controlled = new ControlledActuationService(registry, {
    storageRoot: root,
    authorizationStore: authorizations,
    taskContextService: tasks,
    executionContextService: executions,
    adapter: codex,
  });
  const browserRouter = new BrowserRouter(root, review.deliveryAdapter);
  const completionRouter = new ReviewCompletionRouter(
    root,
    new BrowserWorkerReviewCompletionAdapter(review.completionClient),
  );
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
  const drainTerminalListeners = wireGoalAdvance(auto, goals);
  return {
    root,
    workspaceRoot,
    registry,
    tasks,
    executions,
    authorizations,
    codex,
    review,
    controlled,
    browserRouter,
    completionRouter,
    auto,
    goals,
    drainTerminalListeners,
  };
}

async function restart(harness: Harness): Promise<RestartedHarness> {
  const tasks = new TaskContextService(harness.root);
  const executions = new ExecutionContextService(harness.root);
  const authorizations = new ActuationAuthorizationStore(harness.root);
  const noSpawn = vi.fn(async (_request: CodexExecutionStartRequest): Promise<CodexExecutionStartResult> => {
    throw new Error("A restarted control plane must not start another Codex process.");
  });
  const controlled = new ControlledActuationService(harness.registry, {
    storageRoot: harness.root,
    authorizationStore: authorizations,
    taskContextService: tasks,
    executionContextService: executions,
    adapter: { start: noSpawn },
  });
  const browserRouter = new BrowserRouter(harness.root, harness.review.deliveryAdapter);
  const completionRouter = new ReviewCompletionRouter(
    harness.root,
    new BrowserWorkerReviewCompletionAdapter(harness.review.completionClient),
  );
  const auto = new AutoIterationService(harness.registry, {
    storageRoot: harness.root,
    taskContextService: tasks,
    executionContextService: executions,
    browserRouter,
    completionRouter,
    controlledActuation: controlled,
  });
  const goals = new GoalOrchestrationService(harness.registry, {
    storageRoot: harness.root,
    taskContextService: tasks,
    executionContextService: executions,
    authorizationStore: authorizations,
    controlledActuation: controlled,
    autoIteration: auto,
  });
  const drainTerminalListeners = wireGoalAdvance(auto, goals);
  return {
    ...harness,
    tasks,
    executions,
    authorizations,
    controlled,
    browserRouter,
    completionRouter,
    auto,
    goals,
    drainTerminalListeners,
    noSpawn,
  };
}

async function startPlan(harness: Harness, value: CreateGoalInput): Promise<{
  readonly goal: GoalOrchestration;
  readonly loop: AutoIteration;
}> {
  await harness.goals.createGoal(value);
  const goal = await harness.goals.startGoal({ goal_id: value.goal_id });
  const loop = await harness.auto.getLoop(goal.loop_id!);
  if (loop === null) throw new Error("Goal start did not create an AutoIteration loop.");
  return { goal, loop };
}

async function emitTerminal(
  harness: Harness,
  executionId: string,
  status: ExecutionTerminalStatus,
): Promise<void> {
  const execution = await harness.codex.trigger(executionId, status);
  await harness.auto.onExecutionTerminal(execution);
  await harness.drainTerminalListeners();
}

async function controlledState(harness: Harness): Promise<{
  readonly authorizations: ActuationAuthorization[];
  readonly actuations: ControlledActuation[];
}> {
  return JSON.parse(await readFile(controlledActuationStateFile(harness.root), "utf8")) as {
    authorizations: ActuationAuthorization[];
    actuations: ControlledActuation[];
  };
}

async function persistLoop(root: string, loop: AutoIteration): Promise<void> {
  const file = autoIterationStateFile(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    schema_version: 1,
    loops: [autoIterationSchema.parse(loop)],
  }, null, 2)}\n`, "utf8");
}

async function persistGoal(root: string, goal: GoalOrchestration): Promise<void> {
  const file = goalOrchestrationStateFile(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    schema_version: 1,
    goals: [goalOrchestrationSchema.parse(goal)],
  }, null, 2)}\n`, "utf8");
}

function runningGoal(value: CreateGoalInput): GoalOrchestration {
  const phase = value.phases[0]!;
  const task = phase.tasks[0]!;
  const timestamp = new Date().toISOString();
  return goalOrchestrationSchema.parse({
    ...value,
    phases: value.phases.map((candidate, index) => ({
      ...candidate,
      status: index === 0 ? "running" : "pending",
    })),
    status: "running",
    current_phase_id: phase.phase_id,
    current_task_id: task.task_id,
    execution_id: goalIdentity("execution", value.goal_id, phase.phase_id, task.task_id),
    actuation_id: goalIdentity("actuation", value.goal_id, phase.phase_id, task.task_id),
    loop_id: goalIdentity("loop", value.goal_id, phase.phase_id, task.task_id),
    created_at: timestamp,
    updated_at: timestamp,
  });
}

async function createReviewChain(harness: Harness, loop: AutoIteration): Promise<{
  readonly reviewRequestId: string;
  readonly routingId: string;
  readonly deliveryId: string;
}> {
  const reviewRequestId = loop.review_request_id
    ?? loopIdentity("review", loop.loop_id, loop.iteration);
  const routingId = loop.routing_id
    ?? loopIdentity("routing", loop.loop_id, loop.iteration);
  const deliveryId = loop.delivery_id
    ?? loopIdentity("delivery", loop.loop_id, loop.iteration);
  await new ReviewRequestService(harness.root).createReviewRequest({
    review_request_id: reviewRequestId,
    task_id: loop.task_id,
    execution_id: loop.execution_id,
    workspace_id: loop.workspace_id,
    conversation_id: loop.conversation_id,
  });
  await new ConversationRoutingService(harness.root).createRouting({
    routing_id: routingId,
    workspace_id: loop.workspace_id,
    task_id: loop.task_id,
    execution_id: loop.execution_id,
    review_request_id: reviewRequestId,
    conversation_id: loop.conversation_id,
  });
  await new ReviewDeliveryService(harness.root).createDelivery({
    delivery_id: deliveryId,
    workspace_id: loop.workspace_id,
    task_id: loop.task_id,
    review_request_id: reviewRequestId,
    routing_id: routingId,
    conversation_id: loop.conversation_id,
  });
  return { reviewRequestId, routingId, deliveryId };
}

async function assertIdentity(
  harness: Harness,
  value: CreateGoalInput,
  taskId: string,
  reviewRequired = true,
): Promise<void> {
  const goal = await harness.goals.getGoal(value.goal_id);
  if (goal === null) throw new Error("Goal identity was not persisted.");
  const phase = value.phases.find((candidate) => candidate.tasks.some((task) => task.task_id === taskId));
  if (phase === undefined) throw new Error(`Task "${taskId}" is not in the test plan.`);
  const loop = await harness.auto.getLoop(goal.loop_id!);
  if (loop === null) throw new Error("Loop identity was not persisted.");
  const task = await harness.tasks.getTaskContext(taskId);
  if (task === null) throw new Error("Task identity was not persisted.");
  const execution = await harness.executions.getExecutionContext(
    value.workspace_id,
    taskId,
    loop.execution_id,
  );
  if (execution === null) throw new Error("Execution identity was not persisted.");
  const state = await controlledState(harness);
  const actuation = state.actuations.find((candidate) =>
    candidate.task_id === taskId && candidate.execution_id === loop.execution_id);
  if (actuation === undefined) throw new Error("Actuation identity was not persisted.");
  const authorization = state.authorizations.find((candidate) =>
    candidate.authorization_id === actuation.authorization_id);
  if (authorization === undefined) throw new Error("Authorization identity was not persisted.");

  expect(goal.goal_id).toBe(value.goal_id);
  expect(goal.workspace_id).toBe(value.workspace_id);
  expect(goal.conversation_id).toBe(value.conversation_id);
  expect(goal.current_phase_id).toBe(phase.phase_id);
  expect(goal.current_task_id).toBe(taskId);
  expect(goal.loop_id).toBe(loop.loop_id);
  expect(loop.initial_execution_id).toBe(goal.execution_id);
  expect(loop.workspace_id).toBe(value.workspace_id);
  expect(loop.task_id).toBe(taskId);
  expect(loop.conversation_id).toBe(value.conversation_id);
  expect(task.task_id).toBe(taskId);
  expect(task.workspace_id).toBe(value.workspace_id);
  expect(task.conversation_id).toBe(value.conversation_id);
  expect(execution.execution_id).toBe(loop.execution_id);
  expect(execution.task_id).toBe(taskId);
  expect(execution.workspace_id).toBe(value.workspace_id);
  expect(actuation.actuation_id).toBe(loop.actuation_id ?? goal.actuation_id);
  expect(actuation.workspace_id).toBe(value.workspace_id);
  expect(actuation.task_id).toBe(taskId);
  expect(actuation.execution_id).toBe(loop.execution_id);
  expect(authorization.actuation_id).toBe(actuation.actuation_id);
  expect(authorization.workspace_id).toBe(value.workspace_id);
  expect(authorization.task_id).toBe(taskId);
  expect(authorization.execution_id).toBe(loop.execution_id);
  expect(authorization.instruction).toContain("## 修改目标");

  if (!reviewRequired) return;
  if (loop.review_request_id === undefined) throw new Error("Review request identity was not persisted.");
  const request = await new ReviewRequestService(harness.root).getReviewRequest(
    value.workspace_id,
    loop.review_request_id,
  );
  if (request === null) throw new Error("Review request was not persisted.");
  if (loop.routing_id === undefined || loop.delivery_id === undefined) {
    throw new Error("Review routing identity was not persisted.");
  }
  const routing = await new ConversationRoutingService(harness.root).getRouting(
    value.workspace_id,
    loop.routing_id,
  );
  const delivery = await new ReviewDeliveryService(harness.root).getDelivery(
    value.workspace_id,
    loop.delivery_id,
  );
  const result = await new ReviewResultService(harness.root).getReviewResultByRequest(
    value.workspace_id,
    loop.review_request_id,
  );
  if (routing === null || delivery === null || result === null) {
    throw new Error("Review chain identity was not persisted.");
  }
  expect(request.review_request_id).toBe(loop.review_request_id);
  expect(request.workspace_id).toBe(value.workspace_id);
  expect(request.task_id).toBe(taskId);
  expect(request.execution_id).toBe(loop.execution_id);
  expect(request.conversation_id).toBe(value.conversation_id);
  expect(routing.routing_id).toBe(loop.routing_id);
  expect(routing.workspace_id).toBe(value.workspace_id);
  expect(routing.task_id).toBe(taskId);
  expect(routing.execution_id).toBe(loop.execution_id);
  expect(routing.review_request_id).toBe(request.review_request_id);
  expect(routing.conversation_id).toBe(value.conversation_id);
  expect(delivery.delivery_id).toBe(loop.delivery_id);
  expect(delivery.workspace_id).toBe(value.workspace_id);
  expect(delivery.task_id).toBe(taskId);
  expect(delivery.review_request_id).toBe(request.review_request_id);
  expect(delivery.routing_id).toBe(routing.routing_id);
  expect(delivery.conversation_id).toBe(value.conversation_id);
  expect(result.review_request_id).toBe(request.review_request_id);
  expect(result.delivery_id).toBe(delivery.delivery_id);
  expect(result.workspace_id).toBe(value.workspace_id);
  expect(result.task_id).toBe(taskId);
}

describe("Control Plane control loop integration", () => {
  it("completes Goal -> Task -> Execution -> Review -> Goal with one actuation", async () => {
    const harness = await createHarness(["APPROVE"]);
    const value = plan("goal-success");
    const { goal } = await startPlan(harness, value);

    expect(goal.status).toBe("running");
    expect((await harness.codex.trigger(goal.execution_id!, "running")).status).toBe("running");
    await emitTerminal(harness, goal.execution_id!, "passed");

    const completed = await harness.goals.getGoal(value.goal_id);
    expect(completed?.status).toBe("completed");
    expect(completed?.phases.map((phase) => phase.status)).toEqual(["completed"]);
    expect((await harness.tasks.getTaskContext("task-1"))?.status).toBe("completed");
    expect(harness.codex.starts).toHaveLength(1);
    expect(harness.review.broker.requests).toHaveLength(1);
    expect(harness.review.completionClient.requests).toHaveLength(1);
    expect((await controlledState(harness)).actuations).toHaveLength(1);
    expect(await new ReviewRequestService(harness.root).listReviewRequests(value.workspace_id))
      .toHaveLength(1);
    await assertIdentity(harness, value, "task-1");
  });

  it("keeps one Goal/Phase/Task and runs ITERATE as execution E2 before APPROVE", async () => {
    const harness = await createHarness(["ITERATE", "APPROVE"]);
    const value = plan("goal-iterate");
    const { goal, loop: firstLoop } = await startPlan(harness, value);
    const firstExecutionId = goal.execution_id!;

    expect(firstLoop.iteration).toBe(1);
    await emitTerminal(harness, firstExecutionId, "passed");

    const iteratingLoop = await harness.auto.getLoop(goal.loop_id!);
    if (iteratingLoop === null) throw new Error("Iterating loop was not persisted.");
    expect(iteratingLoop).toMatchObject({
      loop_id: firstLoop.loop_id,
      initial_execution_id: firstExecutionId,
      iteration: 2,
      stage: "execution",
      task_id: "task-1",
      conversation_id: value.conversation_id,
    });
    expect(iteratingLoop.execution_id).not.toBe(firstExecutionId);
    const secondExecutionId = iteratingLoop.execution_id;
    expect(harness.codex.starts.map((request) => request.execution_id)).toEqual([
      firstExecutionId,
      secondExecutionId,
    ]);
    expect((await controlledState(harness)).actuations).toHaveLength(2);
    expect((await new ReviewRequestService(harness.root).listReviewRequests(value.workspace_id)))
      .toHaveLength(1);

    await emitTerminal(harness, secondExecutionId, "passed");

    const completed = await harness.goals.getGoal(value.goal_id);
    expect(completed?.status).toBe("completed");
    expect(completed?.phases).toHaveLength(1);
    expect(completed?.phases[0]?.tasks).toHaveLength(1);
    expect((await harness.auto.getLoop(firstLoop.loop_id))?.iteration).toBe(2);
    expect((await new ReviewRequestService(harness.root).listReviewRequests(value.workspace_id)))
      .toHaveLength(2);
    expect(harness.review.broker.requests).toHaveLength(2);
    expect(harness.review.completionClient.requests).toHaveLength(2);

    const requests = await new ReviewRequestService(harness.root).listReviewRequests(value.workspace_id);
    expect(requests.every((request) =>
      request.task_id === "task-1"
      && request.workspace_id === value.workspace_id
      && request.conversation_id === value.conversation_id)).toBe(true);
    const state = await controlledState(harness);
    expect(new Set(state.actuations.map((actuation) => actuation.actuation_id)).size)
      .toBe(2);
    expect(state.actuations.every((actuation) =>
      actuation.task_id === "task-1" && actuation.workspace_id === value.workspace_id)).toBe(true);
    expect(harness.review.broker.requests.every((request) =>
      request.task_id === "task-1"
      && request.workspace_id === value.workspace_id
      && request.conversation_id === value.conversation_id)).toBe(true);
    await assertIdentity(harness, value, "task-1");
  });

  it("stops at HUMAN_REQUIRED without a second execution or actuation", async () => {
    const harness = await createHarness(["HUMAN_REQUIRED"]);
    const value = plan("goal-human");
    const { goal } = await startPlan(harness, value);

    await emitTerminal(harness, goal.execution_id!, "passed");

    const stopped = await harness.goals.getGoal(value.goal_id);
    expect(stopped?.status).toBe("human_required");
    expect(stopped?.phases.map((phase) => phase.status)).toEqual(["human_required"]);
    expect((await harness.tasks.getTaskContext("task-1"))?.status).toBe("human_required");
    expect(harness.codex.starts).toHaveLength(1);
    expect((await controlledState(harness)).actuations).toHaveLength(1);
    expect(harness.review.broker.requests).toHaveLength(1);
    expect(harness.review.completionClient.requests).toHaveLength(1);
    expect((await harness.auto.getLoop(goal.loop_id!))?.terminal_decision).toBe("HUMAN_REQUIRED");
    await assertIdentity(harness, value, "task-1");
  });

  it("propagates a failed execution and never creates a Review Request", async () => {
    const harness = await createHarness(["APPROVE"]);
    const value = plan("goal-failed");
    const { goal } = await startPlan(harness, value);

    await emitTerminal(harness, goal.execution_id!, "failed");

    const failed = await harness.goals.getGoal(value.goal_id);
    expect(failed?.status).toBe("failed");
    expect(failed?.phases.map((phase) => phase.status)).toEqual(["failed"]);
    expect((await harness.tasks.getTaskContext("task-1"))?.status).toBe("failed");
    expect((await harness.executions.getExecutionContext(
      value.workspace_id,
      "task-1",
      goal.execution_id!,
    ))?.status).toBe("failed");
    expect(harness.codex.starts).toHaveLength(1);
    expect(harness.review.broker.requests).toHaveLength(0);
    expect(harness.review.completionClient.requests).toHaveLength(0);
    expect(await new ReviewRequestService(harness.root).listReviewRequests(value.workspace_id))
      .toHaveLength(0);
    await assertIdentity(harness, value, "task-1", false);
  });

  it("recovers a created Review Request without creating it twice", async () => {
    const harness = await createHarness(["APPROVE"]);
    const value = plan("goal-recovery-request");
    const { goal, loop } = await startPlan(harness, value);
    await emitWithoutNotification(harness, goal.execution_id!, "passed");
    const chain = await createReviewChain(harness, loop);
    await persistLoop(harness.root, {
      ...loop,
      review_request_id: chain.reviewRequestId,
      stage: "review_request",
    });
    expect((await harness.goals.getGoal(value.goal_id))?.status).toBe("running");

    const restarted = await restart(harness);
    await restarted.auto.recover();
    await restarted.drainTerminalListeners();

    expect((await restarted.goals.getGoal(value.goal_id))?.status).toBe("completed");
    expect(await new ReviewRequestService(harness.root).listReviewRequests(value.workspace_id))
      .toHaveLength(1);
    expect(harness.review.broker.requests).toHaveLength(1);
    expect(harness.review.completionClient.requests).toHaveLength(1);
    expect(harness.codex.starts).toHaveLength(1);
    expect(restarted.noSpawn).not.toHaveBeenCalled();
    await assertIdentity(restarted, value, "task-1");
  });

  it("recovers delivered review state without sending the review twice", async () => {
    const harness = await createHarness(["APPROVE"]);
    const value = plan("goal-recovery-delivery");
    const { goal, loop } = await startPlan(harness, value);
    await emitWithoutNotification(harness, goal.execution_id!, "passed");
    const chain = await createReviewChain(harness, loop);
    const delivered = await harness.browserRouter.deliver(value.workspace_id, chain.routingId);
    expect(delivered.status).toBe("delivered");
    await persistLoop(harness.root, {
      ...loop,
      review_request_id: chain.reviewRequestId,
      routing_id: chain.routingId,
      delivery_id: chain.deliveryId,
      stage: "review_completion",
    });
    expect((await new ReviewDeliveryService(harness.root).getDelivery(
      value.workspace_id,
      chain.deliveryId,
    ))).toMatchObject({ status: "delivered", attempt_count: 1 });
    expect(await new ReviewResultService(harness.root).listReviewResults(value.workspace_id))
      .toHaveLength(0);

    const restarted = await restart(harness);
    await restarted.auto.recover();
    await restarted.drainTerminalListeners();

    expect((await restarted.goals.getGoal(value.goal_id))?.status).toBe("completed");
    expect(harness.review.broker.requests).toHaveLength(1);
    expect(harness.review.completionClient.requests).toHaveLength(1);
    expect(await new ReviewResultService(harness.root).listReviewResults(value.workspace_id))
      .toHaveLength(1);
    expect(restarted.noSpawn).not.toHaveBeenCalled();
    await assertIdentity(restarted, value, "task-1");
  });

  it("advances a persisted APPROVE result once after restart", async () => {
    const harness = await createHarness(["APPROVE"]);
    const value = plan("goal-recovery-result");
    const { goal, loop } = await startPlan(harness, value);
    await emitWithoutNotification(harness, goal.execution_id!, "passed");
    const chain = await createReviewChain(harness, loop);
    await harness.browserRouter.deliver(value.workspace_id, chain.routingId);
    const result = await new ReviewResultService(harness.root).createReviewResult({
      review_request_id: chain.reviewRequestId,
      delivery_id: chain.deliveryId,
      workspace_id: value.workspace_id,
      task_id: "task-1",
      status: "COMPLETED",
      content: verdict(chain.reviewRequestId, "APPROVE"),
    });
    await new ReviewRequestService(harness.root).updateReviewRequest(
      value.workspace_id,
      chain.reviewRequestId,
      { status: "completed" },
    );
    await persistLoop(harness.root, {
      ...loop,
      review_request_id: chain.reviewRequestId,
      routing_id: chain.routingId,
      delivery_id: chain.deliveryId,
      review_result_id: result.result_id,
      stage: "verdict",
    });

    const restarted = await restart(harness);
    await restarted.auto.recover();
    await restarted.drainTerminalListeners();
    const goalStateAfterFirstAdvance = await readFile(goalOrchestrationStateFile(harness.root), "utf8");

    expect((await restarted.goals.getGoal(value.goal_id))?.status).toBe("completed");
    expect(harness.review.broker.requests).toHaveLength(1);
    expect(harness.review.completionClient.requests).toHaveLength(0);
    expect(harness.codex.starts).toHaveLength(1);
    expect(restarted.noSpawn).not.toHaveBeenCalled();

    await Promise.all([
      restarted.goals.advanceGoal(value.goal_id),
      restarted.goals.recover(),
    ]);
    expect(await readFile(goalOrchestrationStateFile(harness.root), "utf8"))
      .toBe(goalStateAfterFirstAdvance);
    await assertIdentity(restarted, value, "task-1");
  });

  it("recovers Actuation started + Execution running without a second spawn", async () => {
    const harness = await createHarness(["APPROVE"]);
    const value = plan("goal-recovery-actuation");
    await harness.goals.createGoal(value);
    const checkpoint = runningGoal(value);
    await harness.tasks.createTaskContext({
      task_id: "task-1",
      workspace_id: value.workspace_id,
      conversation_id: value.conversation_id,
    });
    const taskPlan = value.phases[0]!.tasks[0]!;
    const authorization = await harness.controlled.authorize({
      actuation_id: checkpoint.actuation_id!,
      workspace_id: value.workspace_id,
      task_id: "task-1",
      execution_id: checkpoint.execution_id!,
      instruction: buildAutoIterationInstruction({
        goal: taskPlan.goal,
        requirements: taskPlan.requirements,
        acceptance_criteria: taskPlan.acceptance_criteria,
      }),
    });
    await harness.controlled.actuate({
      actuation_id: authorization.actuation_id,
      authorization_id: authorization.authorization_id,
    });
    await persistGoal(harness.root, checkpoint);
    expect(await harness.auto.getLoop(checkpoint.loop_id!)).toBeNull();

    const restarted = await restart(harness);
    await restarted.goals.recover();

    expect((await restarted.goals.getGoal(value.goal_id))?.status).toBe("running");
    expect((await restarted.auto.getLoop(checkpoint.loop_id!))?.stage).toBe("execution");
    expect(harness.codex.starts).toHaveLength(1);
    expect(restarted.noSpawn).not.toHaveBeenCalled();
    expect((await harness.executions.getExecutionContext(
      value.workspace_id,
      "task-1",
      checkpoint.execution_id!,
    ))?.status).toBe("running");
    expect(await new ReviewRequestService(harness.root).listReviewRequests(value.workspace_id))
      .toHaveLength(0);
    await assertIdentity(restarted, value, "task-1", false);
  });

  it("coalesces terminal notification, Goal advance, and recovery before starting the next Task", async () => {
    const harness = await createHarness(["APPROVE"]);
    const value = plan("goal-concurrent", ["task-1", "task-2"]);
    const { goal } = await startPlan(harness, value);
    const firstExecution = await harness.codex.trigger(goal.execution_id!, "passed");

    await Promise.all([
      harness.auto.onExecutionTerminal(firstExecution),
      harness.goals.advanceGoal(value.goal_id),
      harness.goals.recover(),
    ]);
    await harness.drainTerminalListeners();

    const recovered = await harness.goals.getGoal(value.goal_id);
    expect(recovered).toMatchObject({
      status: "running",
      current_phase_id: "phase-1",
      current_task_id: "task-2",
    });
    expect(harness.codex.starts.filter((request) => request.task_id === "task-1"))
      .toHaveLength(1);
    expect(harness.codex.starts.filter((request) => request.task_id === "task-2"))
      .toHaveLength(1);
    expect(await new ReviewRequestService(harness.root).listReviewRequests(value.workspace_id))
      .toHaveLength(1);
    expect(harness.review.broker.requests).toHaveLength(1);
    const state = await controlledState(harness);
    expect(state.actuations.filter((actuation) => actuation.task_id === "task-1"))
      .toHaveLength(1);
    expect(state.actuations.filter((actuation) => actuation.task_id === "task-2"))
      .toHaveLength(1);
    expect(await harness.executions.listExecutions(value.workspace_id, "task-1"))
      .toHaveLength(1);
    expect(await harness.executions.listExecutions(value.workspace_id, "task-2"))
      .toHaveLength(1);
    expect((await harness.auto.listLoops()).filter((loop) =>
      !["completed", "failed", "human_required"].includes(loop.stage))).toHaveLength(1);
    await assertIdentity(harness, value, "task-2", false);
  });
});

async function emitWithoutNotification(
  harness: Harness,
  executionId: string,
  status: ExecutionTerminalStatus,
): Promise<void> {
  await harness.codex.trigger(executionId, status);
}
