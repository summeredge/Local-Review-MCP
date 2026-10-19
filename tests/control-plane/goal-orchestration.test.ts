import { ExecutionLaunchIndeterminateError } from "../../src/control-plane/execution-service.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoIterationSchema,
  buildAutoIterationInstruction,
  type AutoIteration,
  type AutoIterationStartInput,
} from "../../src/control-plane/auto-iteration.js";
import {
  GoalOrchestrationConflictError,
  GoalOrchestrationService,
  GoalOrchestrationUnavailableError,
  goalOrchestrationSchema,
  goalOrchestrationStateFile,
  type CreateGoalInput,
  type GoalOrchestration,
} from "../../src/control-plane/goal-orchestration.js";
import {
  ActuationAuthorizationStore,
  ControlledActuationService,
  controlledActuationStateFile,
} from "../../src/control-plane/controlled-actuation.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { TaskContextService } from "../../src/context/service.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { ExtensionDeliveryService } from "../../src/control-plane/extension-delivery.js";
import { StatusQueryService } from "../../src/control-plane/status-query.js";

const temporaryDirectories: string[] = [];
const services: GoalOrchestrationService[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

afterEach(async () => {
  services.splice(0).forEach(service => service.dispose());
  vi.mocked(fs.rename).mockReset().mockImplementation(actualFs.rename);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

function identity(kind: string, goalId: string, phaseId: string, taskId: string): string {
  const digest = createHash("sha256")
    .update(`${goalId}\0${phaseId}\0${taskId}\0${kind}`)
    .digest("hex")
    .slice(0, 32);
  return `goal-${kind}-${digest}`;
}

function input(phases: CreateGoalInput["phases"] = [{
  phase_id: "phase-1",
  objective: "Implement",
  tasks: [{
    task_id: "task-1",
    goal: "Make the change",
    requirements: ["Keep it small"],
    acceptance_criteria: ["Tests pass"],
    max_iterations: 2,
  }],
}]): CreateGoalInput {
  return {
    goal_id: "goal-1",
    workspace_id: "workspace-a",
    conversation_id: "conversation-1",
    execution_mode: "batch",
    phases,
  };
}

class FakeAutoIteration {
  public readonly loops = new Map<string, AutoIteration>();
  public readonly start = vi.fn(async (request: AutoIterationStartInput): Promise<AutoIteration> => {
    const existing = this.loops.get(request.loop_id);
    if (existing !== undefined) return structuredClone(existing);
    const timestamp = new Date().toISOString();
    const loop = autoIterationSchema.parse({
      loop_id: request.loop_id,
      initial_execution_id: request.execution_id,
      workspace_id: request.workspace_id,
      task_id: request.task_id,
      conversation_id: request.conversation_id,
      max_iterations: request.max_iterations,
      iteration: 1,
      execution_id: request.execution_id,
      stage: "execution",
      created_at: timestamp,
      updated_at: timestamp,
    });
    this.loops.set(loop.loop_id, loop);
    return structuredClone(loop);
  });

  public readonly getLoop = vi.fn(async (loopId: string): Promise<AutoIteration | null> =>
    structuredClone(this.loops.get(loopId) ?? null));

  public readonly advance = vi.fn(async (loopId: string): Promise<AutoIteration> => {
    const loop = this.loops.get(loopId);
    if (loop === undefined) throw new Error("loop not found");
    return structuredClone(loop);
  });

  public terminal(loopId: string, stage: "completed" | "failed" | "human_required"): AutoIteration {
    const loop = this.loops.get(loopId)!;
    const next = autoIterationSchema.parse({
      ...loop,
      stage,
      terminal_decision: stage === "completed" ? "APPROVE" : stage === "failed" ? "FAILED" : "HUMAN_REQUIRED",
      terminal_reason: `TEST_${stage.toUpperCase()}`,
      terminal_summary: `${stage} summary`,
      updated_at: new Date().toISOString(),
    });
    this.loops.set(loopId, next);
    return next;
  }
}

async function fixture(auto = new FakeAutoIteration()): Promise<{
  readonly root: string;
  readonly registry: WorkspaceRegistry;
  readonly tasks: TaskContextService;
  readonly executions: ExecutionContextService;
  readonly authorizations: ActuationAuthorizationStore;
  readonly controlled: ControlledActuationService;
  readonly starts: ReturnType<typeof vi.fn>;
  readonly auto: FakeAutoIteration;
  readonly service: GoalOrchestrationService;
  readonly deliveries: ExtensionDeliveryService;
}> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-goal-"));
  const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-goal-workspace-"));
  temporaryDirectories.push(root, workspace);
  const registry = new WorkspaceRegistry([{ id: "workspace-a", name: "Workspace A", path: workspace }]);
  const tasks = new TaskContextService(root);
  const executions = new ExecutionContextService(root);
  const authorizations = new ActuationAuthorizationStore(root);
  const starts = vi.fn(async (request: {
    workspace_id: string;
    task_id: string;
    execution_id: string;
    instruction: string;
  }) => {
    const execution = await executions.createExecutionContext({
      execution_id: request.execution_id,
      workspace_id: request.workspace_id,
      task_id: request.task_id,
      process_id: 8000 + starts.mock.calls.length,
      command: "codex exec --json -",
    });
    return {
      execution_id: execution.execution_id,
      process_id: execution.process_id!,
      started_at: execution.started_at,
      accepted: "new" as const,
    };
  });
  const controlled = new ControlledActuationService(registry, {
    storageRoot: root,
    authorizationStore: authorizations,
    taskContextService: tasks,
    executionContextService: executions,
    adapter: { start: starts },
  });
  const deliveries = new ExtensionDeliveryService(root);
  const service = new GoalOrchestrationService(registry, {
    storageRoot: root,
    taskContextService: tasks,
    executionContextService: executions,
    authorizationStore: authorizations,
    controlledActuation: controlled,
    autoIteration: auto,
    extensionDeliveries: deliveries,
  });
  services.push(service);
  return { root, registry, tasks, executions, authorizations, controlled, starts, auto, service, deliveries };
}

describe("Goal terminal persistence failures", () => {
  it("does not include another conversation's conflicting Loop evidence in the notice", async () => {
    const f = await fixture();
    await f.service.createGoal(input());
    const running = await f.service.startGoal({ goal_id: "goal-1" });
    const loop = f.auto.terminal(running.loop_id!, "human_required");
    f.auto.loops.set(loop.loop_id, { ...loop, conversation_id: "another-conversation",
      terminal_summary: "foreign private evidence" });
    const stopped = await f.service.advanceGoal("goal-1");
    expect(stopped.human_required_info).toMatchObject({ terminal_reason: "GOAL_ORCHESTRATION_ERROR" });
    const notice = await f.deliveries.getByLogicalDeliveryId(identity("human-required", "goal-1", "phase-1", "task-1"));
    expect(notice?.conversation_id).toBe("conversation-1");
    expect(notice?.message).not.toContain("foreign private evidence");
  });
  it("recovers a persisted human-required Goal when notification enqueue failed, and retries only proven not-sent", async () => {
    const f = await fixture();
    await f.service.createGoal(input());
    const running = await f.service.startGoal({ goal_id: "goal-1" });
    f.auto.terminal(running.loop_id!, "human_required");
    const enqueue = vi.spyOn(f.deliveries, "enqueue").mockRejectedValueOnce(new Error("queue unavailable"));
    expect(await f.service.advanceGoal("goal-1")).toMatchObject({ status: "human_required", human_required_info: {
      terminal_reason: "TEST_HUMAN_REQUIRED",
    } });
    expect(await f.deliveries.recoveryTargets()).toEqual([]);
    f.service.dispose();
    enqueue.mockRestore();
    // Legacy records and a crash before info publication are recovered from the existing Loop.
    const path = goalOrchestrationStateFile(f.root);
    const state = JSON.parse(await readFile(path, "utf8"));
    delete state.goals[0].human_required_info;
    await writeFile(path, JSON.stringify(state));
    const restarted = new GoalOrchestrationService(f.registry, { storageRoot: f.root,
      autoIteration: f.auto, controlledActuation: f.controlled, extensionDeliveries: f.deliveries });
    services.push(restarted);
    await restarted.recover();
    const owner = { conversation_id: "conversation-1", client_id: "client", document_id: "document", navigation_epoch: 1 };
    const first = (await f.deliveries.claim(owner))!;
    await f.deliveries.acknowledge({ ...owner, delivery_id: first.delivery_id, status: "not_sent", error: "composer_busy" });
    await restarted.advanceGoal("goal-1");
    const retry = (await f.deliveries.claim(owner))!;
    expect(retry.delivery_id).not.toBe(first.delivery_id);
    expect(retry.message).toBe(first.message);
    await f.deliveries.acknowledge({ ...owner, delivery_id: retry.delivery_id, status: "ambiguous", error: "send outcome unknown" });
    await restarted.recover();
    expect(await f.deliveries.claim(owner)).toBeNull();
    expect(f.starts).toHaveBeenCalledTimes(1);
  });
  it.each(["REVIEW_REQUIRES_HUMAN", "MAX_ITERATIONS_REACHED", "EXTENSION_NOT_READY"])(
    "persists and delivers %s to the original conversation without another execution", async reason => {
      const f = await fixture();
      await f.service.createGoal(input());
      const running = await f.service.startGoal({ goal_id: "goal-1" });
      const loop = { ...f.auto.terminal(running.loop_id!, "human_required"), terminal_reason: reason,
        terminal_stage: "verdict" as const, review_result_id: "review-result-1" };
      f.auto.loops.set(loop.loop_id, loop);
      await f.executions.updateExecutionContext("workspace-a", "task-1", running.execution_id!, {
        status: "passed", summary: "Implementation and tests completed",
      });
      await f.service.onAutoIterationTerminal(loop);
      const stopped = (await f.service.getGoal("goal-1"))!;
      expect(stopped).toMatchObject({ status: "human_required", human_required_info: {
        goal_id: "goal-1", task_id: "task-1", execution_id: loop.execution_id, stage: "verdict",
        terminal_reason: reason, terminal_summary: "human_required summary", review_result_id: "review-result-1",
        completed_work: expect.stringContaining("Implementation and tests completed"),
      } });
      const deliveries = new ExtensionDeliveryService(f.root);
      expect(await deliveries.recoveryTargets()).toEqual([]);
      const notice = (await deliveries.getByLogicalDeliveryId(identity("human-required", "goal-1", "phase-1", "task-1")))!;
      expect(notice.conversation_id).toBe("conversation-1");
      expect(notice.message).toContain("请在本 ChatGPT 对话中回复处理决定");
      expect(notice.message).toContain("submit_goal");
      expect(notice.message).toContain(reason);
      expect(notice.message).toContain(reason === "REVIEW_REQUIRES_HUMAN" ? "Review 需要用户决策"
        : reason === "MAX_ITERATIONS_REACHED" ? "已达到最大迭代次数" : "执行或基础设施异常");
      const rows = await new StatusQueryService({ storageRoot: f.root, goals: f.service }).listExecutionSummaries();
      expect(rows[0]).toMatchObject({ goal_status: "human_required", human_required_info: stopped.human_required_info });
      f.service.dispose();
      const restarted = new GoalOrchestrationService(f.registry, { storageRoot: f.root, autoIteration: f.auto,
        controlledActuation: f.controlled, extensionDeliveries: deliveries });
      services.push(restarted);
      await restarted.recover();
      expect(await deliveries.recoveryTargets()).toEqual([]);
      expect((await deliveries.getByLogicalDeliveryId(notice.logical_delivery_id!))?.delivery_id).toBe(notice.delivery_id);
      const owner = { conversation_id: "conversation-1", client_id: "client", document_id: "document", navigation_epoch: 1 };
      await expect(deliveries.claim({ ...owner, conversation_id: "another-conversation" })).resolves.toBeNull();
      expect(await deliveries.claim(owner)).toMatchObject({ delivery_id: notice.delivery_id, message: notice.message });
      await deliveries.acknowledge({ ...owner, delivery_id: notice.delivery_id, status: "sent", message_id: "notice-message" });
      await restarted.onAutoIterationTerminal(loop);
      await restarted.advanceGoal("goal-1");
      await restarted.recover();
      expect(await deliveries.recoveryTargets()).toEqual([]);
      expect(await deliveries.claim(owner)).toBeNull();
      expect(f.starts).toHaveBeenCalledTimes(1);
      expect((await restarted.getGoal("goal-1"))!.human_required_info).toEqual(stopped.human_required_info);
    });
  it.each(["completed", "failed", "human_required"] as const)("recovers %s after retry exhaustion without another execution", async (status) => {
    const f = await fixture();
    await f.service.createGoal(input());
    const running = await f.service.startGoal({ goal_id: "goal-1" });
    const terminal = f.auto.terminal(running.loop_id!, status);
    let locked = true;
    let attempts = 0;
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      if (destination === goalOrchestrationStateFile(f.root) && locked) {
        attempts += 1;
        throw Object.assign(new Error("file occupied"), { code: "EPERM" });
      }
      return actualFs.rename(source, destination);
    });
    await f.service.onAutoIterationTerminal(terminal);
    expect(attempts).toBe(3);
    expect((await f.service.getGoal("goal-1"))!.status).toBe("running");
    expect((await f.tasks.getTaskContext("task-1"))!.status).toBe(status);
    if (status === "completed") {
      await vi.waitFor(() => expect(attempts).toBe(6), { timeout: 3000 });
      expect(f.starts).toHaveBeenCalledTimes(1);
    }
    locked = false;
    await vi.waitFor(async () => expect((await f.service.getGoal("goal-1"))!.status).toBe(status), { timeout: 3000 });
    await f.service.onAutoIterationTerminal(terminal);
    await f.service.recover();
    expect(f.starts).toHaveBeenCalledTimes(1);
    expect(f.auto.start).toHaveBeenCalledTimes(1);
  });

  it("retries a transient publish and recovers durable evidence after restart", async () => {
    const f = await fixture();
    await f.service.createGoal(input());
    const running = await f.service.startGoal({ goal_id: "goal-1" });
    const terminal = f.auto.terminal(running.loop_id!, "completed");
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      if (destination === goalOrchestrationStateFile(f.root)) throw Object.assign(new Error("occupied"), { code: "EBUSY" });
      return actualFs.rename(source, destination);
    });
    await f.service.onAutoIterationTerminal(terminal);
    f.service.dispose();
    vi.mocked(fs.rename).mockImplementation(actualFs.rename);
    const restarted = new GoalOrchestrationService(f.registry, { storageRoot: f.root,
      taskContextService: f.tasks, executionContextService: f.executions,
      authorizationStore: f.authorizations, controlledActuation: f.controlled, autoIteration: f.auto });
    services.push(restarted);
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("occupied"), { code: "EACCES" }));
    await restarted.recover();
    expect((await restarted.getGoal("goal-1"))!.status).toBe("completed");
    expect(f.starts).toHaveBeenCalledTimes(1);
  });
});

function runningGoal(plan: CreateGoalInput, phaseIndex = 0, taskIndex = 0): GoalOrchestration {
  const timestamp = new Date().toISOString();
  const phase = plan.phases[phaseIndex]!;
  const task = phase.tasks[taskIndex]!;
  return goalOrchestrationSchema.parse({
    ...plan,
    phases: plan.phases.map((candidate, index) => ({
      ...candidate,
      status: index < phaseIndex ? "completed" : index === phaseIndex ? "running" : "pending",
    })),
    status: "running",
    current_phase_id: phase.phase_id,
    current_task_id: task.task_id,
    execution_id: identity("execution", plan.goal_id, phase.phase_id, task.task_id),
    actuation_id: identity("actuation", plan.goal_id, phase.phase_id, task.task_id),
    loop_id: identity("loop", plan.goal_id, phase.phase_id, task.task_id),
    created_at: timestamp,
    updated_at: timestamp,
  });
}

async function persistGoal(root: string, goal: GoalOrchestration): Promise<void> {
  const file = goalOrchestrationStateFile(root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ schema_version: 1, goals: [goal] }, null, 2)}\n`, "utf8");
}

async function ensureStartedEvidence(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  goal: GoalOrchestration,
  taskId: string,
): Promise<void> {
  let task = await fixtureValue.tasks.getTaskContext(taskId);
  if (task === null) {
    task = await fixtureValue.tasks.createTaskContext({
      task_id: taskId,
      workspace_id: goal.workspace_id,
      conversation_id: goal.conversation_id,
    });
  }
  const phase = goal.phases.find((candidate) => candidate.tasks.some((taskPlan) => taskPlan.task_id === taskId))!;
  const taskPlan = phase.tasks.find((candidate) => candidate.task_id === taskId)!;
  const actuationId = identity("actuation", goal.goal_id, phase.phase_id, taskId);
  const executionId = identity("execution", goal.goal_id, phase.phase_id, taskId);
  const authorization = await fixtureValue.controlled.authorize({
    actuation_id: actuationId,
    workspace_id: goal.workspace_id,
    task_id: taskId,
    execution_id: executionId,
    execution_mode: goal.execution_mode,
    instruction: [
      "## 修改目标",
      taskPlan.goal,
      "",
      "## 修改要求",
      ...taskPlan.requirements.map((item) => `- ${item}`),
      "",
      "## 验收标准",
      ...taskPlan.acceptance_criteria.map((item) => `- ${item}`),
    ].join("\n"),
  });
  await fixtureValue.controlled.actuate({
    actuation_id: actuationId,
    authorization_id: authorization.authorization_id,
  });
}

describe("GoalOrchestrationService", () => {
  it("keeps a reservation with unknown launch outcome safe across recovery", async () => {
    const f = await fixture();
    const plan = input();
    await f.service.createGoal(plan);
    f.starts.mockRejectedValue(new ExecutionLaunchIndeterminateError("Desktop stage=session_persistence: disk unavailable"));
    const goal = await f.service.startGoal({ goal_id: plan.goal_id });
    expect(goal).toMatchObject({ status: "human_required", error: expect.stringContaining("disk unavailable") });
    expect(goal.human_required_info).toMatchObject({ stage: "goal_orchestration",
      terminal_reason: "GOAL_ORCHESTRATION_ERROR", terminal_summary: expect.stringContaining("disk unavailable"),
      required_action: expect.stringContaining("执行或基础设施异常") });
    expect(await f.service.getStartEvidence(plan.goal_id)).toMatchObject({ status: "indeterminate" });
    expect(await f.controlled.getActuation(goal.actuation_id!)).toMatchObject({ status: "starting", error: expect.stringContaining("session_persistence") });
    await f.service.recover();
    await f.service.startGoal({ goal_id: plan.goal_id });
    expect(f.starts).toHaveBeenCalledTimes(1);
  });

  it("persists confirmed backend launch failure and its cause", async () => {
    const f = await fixture();
    const plan = input();
    f.starts.mockRejectedValue(new Error("Desktop stage=create_thread: Project unavailable"));
    await f.service.createGoal(plan);
    const goal = await f.service.startGoal({ goal_id: plan.goal_id });
    expect(goal.status).toBe("failed");
    expect(await f.service.getStartEvidence(plan.goal_id)).toEqual({ status: "failed", error: "Desktop stage=create_thread: Project unavailable" });
    const restored = new ActuationAuthorizationStore(f.root);
    expect(await restored.getActuation(goal.actuation_id!)).toMatchObject({ status: "failed", error: "Desktop stage=create_thread: Project unavailable" });
  });

  it.each(["passed", "failed"] as const)("confirms start even when the Execution is already %s", async status => {
    const f = await fixture();
    const plan = input();
    const original = f.starts.getMockImplementation()!;
    f.starts.mockImplementation(async request => {
      const result = await original(request);
      await f.executions.updateExecutionContext(request.workspace_id, request.task_id, request.execution_id, { status });
      return result;
    });
    await f.service.createGoal(plan);
    const goal = await f.service.startGoal({ goal_id: plan.goal_id });
    expect(await f.service.getStartEvidence(plan.goal_id)).toEqual({ status: "started" });
    expect(f.auto.start).toHaveBeenCalledTimes(1);
    await f.service.advanceGoal(goal.goal_id);
    expect(f.starts).toHaveBeenCalledTimes(1);
  });
  it("creates an immutable pending plan without starting any lower state", async () => {
    const f = await fixture();
    const created = await f.service.createGoal(input());
    const same = await f.service.createGoal(input());

    expect(created.status).toBe("pending");
    expect(same).toEqual(created);
    expect(await f.tasks.listTaskContexts()).toEqual([]);
    expect(f.starts).not.toHaveBeenCalled();
    expect(f.auto.start).not.toHaveBeenCalled();
    await expect(readFile(controlledActuationStateFile(f.root), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const changed = input();
    changed.phases[0]!.tasks[0]!.max_iterations = 3;
    await expect(f.service.createGoal(changed)).rejects.toBeInstanceOf(GoalOrchestrationConflictError);
    expect((await f.service.getGoal("goal-1"))!.phases[0]!.tasks[0]!.max_iterations).toBe(2);
  });

  it("accepts only goal_id at start and coalesces concurrent starts to one Codex execution", async () => {
    const f = await fixture();
    await f.service.createGoal(input());
    expect(() => f.service.startGoal({ goal_id: "goal-1", workspace_id: "workspace-a" } as never)).toThrow();

    const [left, right] = await Promise.all([
      f.service.startGoal({ goal_id: "goal-1" }),
      f.service.startGoal({ goal_id: "goal-1" }),
    ]);
    expect(left.status).toBe("running");
    expect(right.status).toBe("running");
    expect(left.current_task_id).toBe("task-1");
    expect(f.starts).toHaveBeenCalledTimes(1);
    expect(f.auto.start).toHaveBeenCalledTimes(1);
    expect(f.starts.mock.calls[0]![0].instruction).toBe(buildAutoIterationInstruction({
      goal: "Make the change", requirements: ["Keep it small"], acceptance_criteria: ["Tests pass"],
    }));
  });

  it("runs tasks and phases strictly in order and completes the Goal", async () => {
    const f = await fixture();
    const plan = input([
      {
        phase_id: "phase-1",
        objective: "First phase",
        tasks: [
          { task_id: "task-1", goal: "One", requirements: ["Do one"], acceptance_criteria: ["One passes"], max_iterations: 2 },
          { task_id: "task-2", goal: "Two", requirements: ["Do two"], acceptance_criteria: ["Two passes"], max_iterations: 2 },
        ],
      },
      {
        phase_id: "phase-2",
        objective: "Second phase",
        tasks: [{ task_id: "task-3", goal: "Three", requirements: ["Do three"], acceptance_criteria: ["Three passes"], max_iterations: 2 }],
      },
    ]);
    await f.service.createGoal(plan);
    let goal = await f.service.startGoal({ goal_id: plan.goal_id });
    expect(f.starts).toHaveBeenCalledTimes(1);

    f.auto.terminal(goal.loop_id!, "completed");
    goal = await f.service.advanceGoal(plan.goal_id);
    expect(goal.current_task_id).toBe("task-2");
    expect(f.starts).toHaveBeenCalledTimes(2);
    expect(goal.phases.map((phase) => phase.status)).toEqual(["running", "pending"]);

    f.auto.terminal(goal.loop_id!, "completed");
    goal = await f.service.advanceGoal(plan.goal_id);
    expect(goal.current_task_id).toBe("task-3");
    expect(f.starts).toHaveBeenCalledTimes(3);
    expect(goal.phases.map((phase) => phase.status)).toEqual(["completed", "running"]);

    f.auto.terminal(goal.loop_id!, "completed");
    goal = await f.service.advanceGoal(plan.goal_id);
    expect(goal.status).toBe("completed");
    expect(goal.phases.map((phase) => phase.status)).toEqual(["completed", "completed"]);
    expect((await f.tasks.getTaskContext("task-3"))!.status).toBe("completed");
  });

  it("attaches human-required details only to the breakpoint execution, not historical tasks or iterations", async () => {
    const f = await fixture();
    await f.service.createGoal(input([{
      phase_id: "phase-1", objective: "Phase", tasks: [
        { task_id: "task-1", goal: "One", requirements: ["Do one"], acceptance_criteria: ["One passes"], max_iterations: 2 },
        { task_id: "task-2", goal: "Two", requirements: ["Do two"], acceptance_criteria: ["Two passes"], max_iterations: 2 },
      ],
    }]));
    const first = await f.service.startGoal({ goal_id: "goal-1" });
    await f.executions.updateExecutionContext("workspace-a", "task-1", first.execution_id!, { status: "passed" });
    f.auto.terminal(first.loop_id!, "completed");
    const next = await f.service.advanceGoal("goal-1");
    await f.executions.createExecutionContext({ workspace_id: "workspace-a", task_id: "task-2",
      execution_id: "earlier-task-2", command: "codex exec --json -", process_id: 9000 });
    await f.executions.updateExecutionContext("workspace-a", "task-2", "earlier-task-2", { status: "passed" });
    f.auto.terminal(next.loop_id!, "human_required");
    const stopped = await f.service.advanceGoal("goal-1");
    const rows = await new StatusQueryService({ storageRoot: f.root, goals: f.service }).listExecutionSummaries();
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.execution_id === next.execution_id)).toMatchObject({
      goal_status: "human_required", human_required_info: stopped.human_required_info, updated_at: stopped.updated_at,
    });
    for (const row of rows.filter(row => row.execution_id !== next.execution_id)) {
      expect(row).toMatchObject({ goal_id: "goal-1", goal_status: "human_required", status: "passed" });
      expect(row.human_required_info).toBeUndefined();
      expect(row.updated_at).toBe(row.finished_at);
    }
  });

  it.each(["failed", "human_required"] as const)("propagates %s and never starts the next task", async (terminal) => {
    const f = await fixture();
    const plan = input([{
      phase_id: "phase-1",
      objective: "Phase",
      tasks: [
        { task_id: "task-1", goal: "One", requirements: ["Do one"], acceptance_criteria: ["One passes"], max_iterations: 2 },
        { task_id: "task-2", goal: "Two", requirements: ["Do two"], acceptance_criteria: ["Two passes"], max_iterations: 2 },
      ],
    }]);
    await f.service.createGoal(plan);
    let goal = await f.service.startGoal({ goal_id: plan.goal_id });
    f.auto.terminal(goal.loop_id!, terminal);
    goal = await f.service.advanceGoal(plan.goal_id);

    expect(goal.status).toBe(terminal);
    expect(goal.phases[0]!.status).toBe(terminal);
    expect((await f.tasks.getTaskContext("task-1"))!.status).toBe(terminal);
    expect(f.starts).toHaveBeenCalledTimes(1);
    await f.service.startGoal({ goal_id: plan.goal_id });
    await f.service.advanceGoal(plan.goal_id);
    await f.service.recover();
    expect(f.starts).toHaveBeenCalledTimes(1);
  });

  it("does not auto-start a pending Goal after restart", async () => {
    const f = await fixture();
    await f.service.createGoal(input());
    const restarted = new GoalOrchestrationService(f.registry, {
      storageRoot: f.root,
      taskContextService: f.tasks,
      executionContextService: f.executions,
      authorizationStore: f.authorizations,
      controlledActuation: f.controlled,
      autoIteration: f.auto,
    });
    await restarted.recover();
    expect((await restarted.getGoal("goal-1"))!.status).toBe("pending");
    expect(f.starts).not.toHaveBeenCalled();
  });

  it("recovers a running checkpoint before authorization and after actuation without duplicate spawn", async () => {
    const f = await fixture();
    const plan = input();
    const checkpoint = runningGoal(plan);
    await persistGoal(f.root, checkpoint);
    await f.service.recover();
    expect(f.starts).toHaveBeenCalledTimes(1);
    expect(f.auto.start).toHaveBeenCalledTimes(1);

    const restarted = new GoalOrchestrationService(f.registry, {
      storageRoot: f.root,
      taskContextService: f.tasks,
      executionContextService: f.executions,
      authorizationStore: f.authorizations,
      controlledActuation: f.controlled,
      autoIteration: f.auto,
    });
    await restarted.recover();
    expect(f.starts).toHaveBeenCalledTimes(1);
    expect(f.auto.start).toHaveBeenCalledTimes(1);
  });

  it("recovers an existing authorization without duplicate execution", async () => {
    const f = await fixture();
    const plan = input();
    const checkpoint = runningGoal(plan);
    await f.tasks.createTaskContext({
      task_id: "task-1",
      workspace_id: plan.workspace_id,
      conversation_id: plan.conversation_id,
    });
    const instruction = buildAutoIterationInstruction({
      goal: "Make the change", requirements: ["Keep it small"], acceptance_criteria: ["Tests pass"],
    });
    const authorization = await f.controlled.authorize({
      actuation_id: checkpoint.actuation_id!,
      workspace_id: plan.workspace_id,
      task_id: "task-1",
      execution_id: checkpoint.execution_id!,
      execution_mode: plan.execution_mode,
      instruction,
    });
    await persistGoal(f.root, checkpoint);

    await f.service.recover();
    expect(f.starts).toHaveBeenCalledTimes(1);
    expect((await f.authorizations.getAuthorizationByActuation(checkpoint.actuation_id!))!.authorization_id)
      .toBe(authorization.authorization_id);
  });

  it("fails closed when authorization and execution exist without an actuation reservation", async () => {
    const f = await fixture();
    const plan = input();
    const checkpoint = runningGoal(plan);
    await f.tasks.createTaskContext({
      task_id: "task-1",
      workspace_id: plan.workspace_id,
      conversation_id: plan.conversation_id,
    });
    const execution = await f.executions.createExecutionContext({
      execution_id: checkpoint.execution_id!,
      task_id: "task-1",
      workspace_id: plan.workspace_id,
      process_id: 9001,
      command: "codex exec --json -",
    });
    await f.controlled.authorize({
      actuation_id: checkpoint.actuation_id!,
      workspace_id: plan.workspace_id,
      task_id: "task-1",
      execution_id: checkpoint.execution_id!,
      execution_mode: plan.execution_mode,
      instruction: [
        "## 修改目标",
        "Make the change",
        "",
        "## 修改要求",
        "- Keep it small",
        "",
        "## 验收标准",
        "- Tests pass",
      ].join("\n"),
    });
    await persistGoal(f.root, checkpoint);

    await f.service.recover();

    expect((await f.service.getGoal(plan.goal_id))!.status).toBe("human_required");
    expect(f.starts).not.toHaveBeenCalled();
    expect(f.auto.start).not.toHaveBeenCalled();
    expect(f.auto.loops.size).toBe(0);
    expect(await f.controlled.getActuation(checkpoint.actuation_id!)).toBeNull();
    expect(await f.executions.getExecutionContext(
      plan.workspace_id,
      "task-1",
      checkpoint.execution_id!,
    )).toEqual(execution);
  });

  it("serializes concurrent advance and terminal notification races", async () => {
    const f = await fixture();
    const plan = input([{
      phase_id: "phase-1",
      objective: "Phase",
      tasks: [
        { task_id: "task-1", goal: "One", requirements: ["Do one"], acceptance_criteria: ["One passes"], max_iterations: 2 },
        { task_id: "task-2", goal: "Two", requirements: ["Do two"], acceptance_criteria: ["Two passes"], max_iterations: 2 },
      ],
    }]);
    await f.service.createGoal(plan);
    const goal = await f.service.startGoal({ goal_id: plan.goal_id });
    const terminal = f.auto.terminal(goal.loop_id!, "completed");

    await Promise.all([
      f.service.advanceGoal(plan.goal_id),
      f.service.advanceGoal(plan.goal_id),
      f.service.onAutoIterationTerminal(terminal),
    ]);
    expect((await f.service.getGoal(plan.goal_id))!.current_task_id).toBe("task-2");
    expect(f.starts).toHaveBeenCalledTimes(2);
    expect(f.auto.start).toHaveBeenCalledTimes(2);
  });

  it("recovers a terminal loop and an already-started next task from the previous checkpoint", async () => {
    const f = await fixture();
    const plan = input([{
      phase_id: "phase-1",
      objective: "Phase",
      tasks: [
        { task_id: "task-1", goal: "One", requirements: ["Do one"], acceptance_criteria: ["One passes"], max_iterations: 2 },
        { task_id: "task-2", goal: "Two", requirements: ["Do two"], acceptance_criteria: ["Two passes"], max_iterations: 2 },
      ],
    }]);
    const oldCheckpoint = runningGoal(plan);
    await ensureStartedEvidence(f, oldCheckpoint, "task-1");
    await ensureStartedEvidence(f, oldCheckpoint, "task-2");
    const firstLoopId = identity("loop", plan.goal_id, "phase-1", "task-1");
    const secondLoopId = identity("loop", plan.goal_id, "phase-1", "task-2");
    await f.auto.start({
      loop_id: firstLoopId,
      workspace_id: plan.workspace_id,
      task_id: "task-1",
      conversation_id: plan.conversation_id,
      execution_id: identity("execution", plan.goal_id, "phase-1", "task-1"),
      max_iterations: 2,
    });
    f.auto.terminal(firstLoopId, "completed");
    await f.auto.start({
      loop_id: secondLoopId,
      workspace_id: plan.workspace_id,
      task_id: "task-2",
      conversation_id: plan.conversation_id,
      execution_id: identity("execution", plan.goal_id, "phase-1", "task-2"),
      max_iterations: 2,
    });
    await persistGoal(f.root, oldCheckpoint);
    const startsBeforeRecovery = f.starts.mock.calls.length;

    await f.service.recover();
    const recovered = await f.service.getGoal(plan.goal_id);
    expect(recovered!.current_task_id).toBe("task-2");
    expect(recovered!.status).toBe("running");
    expect(f.starts).toHaveBeenCalledTimes(startsBeforeRecovery);
  });

  it("keeps a completed Goal and all lower durable evidence terminally stable", async () => {
    const f = await fixture();
    const plan = input();
    await f.service.createGoal(plan);
    let goal = await f.service.startGoal({ goal_id: plan.goal_id });
    f.auto.terminal(goal.loop_id!, "completed");
    goal = await f.service.advanceGoal(plan.goal_id);
    expect(goal.status).toBe("completed");

    const before = {
      goal,
      tasks: await f.tasks.listTaskContexts(),
      executions: await f.executions.listExecutions(plan.workspace_id, "task-1"),
      controlled: await readFile(controlledActuationStateFile(f.root), "utf8"),
      loops: structuredClone([...f.auto.loops]),
      starts: f.starts.mock.calls.length,
      autoStarts: f.auto.start.mock.calls.length,
    };

    await f.service.startGoal({ goal_id: plan.goal_id });
    await f.service.advanceGoal(plan.goal_id);
    await f.service.recover();

    expect(await f.service.getGoal(plan.goal_id)).toEqual(before.goal);
    expect(await f.tasks.listTaskContexts()).toEqual(before.tasks);
    expect(await f.executions.listExecutions(plan.workspace_id, "task-1")).toEqual(before.executions);
    expect(await readFile(controlledActuationStateFile(f.root), "utf8")).toBe(before.controlled);
    expect([...f.auto.loops]).toEqual(before.loops);
    expect(f.starts).toHaveBeenCalledTimes(before.starts);
    expect(f.auto.start).toHaveBeenCalledTimes(before.autoStarts);
  });

  it("fails closed on lower identity conflict without creating an execution", async () => {
    const f = await fixture();
    const plan = input();
    const checkpoint = runningGoal(plan);
    await f.tasks.createTaskContext({
      task_id: "task-1",
      workspace_id: plan.workspace_id,
      conversation_id: plan.conversation_id,
    });
    await f.controlled.authorize({
      actuation_id: checkpoint.actuation_id!,
      workspace_id: plan.workspace_id,
      task_id: "task-1",
      execution_id: checkpoint.execution_id!,
      execution_mode: plan.execution_mode,
      instruction: "wrong instruction",
    });
    await persistGoal(f.root, checkpoint);
    await f.service.recover();

    expect((await f.service.getGoal(plan.goal_id))!.status).toBe("human_required");
    expect(f.starts).not.toHaveBeenCalled();
    expect(await f.executions.listExecutions(plan.workspace_id, "task-1")).toEqual([]);
  });

  it("stores schema v2 orchestration data under control-plane and rejects corrupt or unknown state", async () => {
    const f = await fixture();
    const created = await f.service.createGoal(input());
    const file = goalOrchestrationStateFile(f.root);
    const state = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(file).toBe(join(f.root, "control-plane", "goal-orchestrations.json"));
    expect(state).toMatchObject({ schema_version: 2, goals: [created] });
    expect(JSON.stringify(state)).not.toContain("authorization_id");
    expect(JSON.stringify(state)).not.toContain("process_id");

    for (const contents of ["not json", JSON.stringify({ schema_version: 99, goals: [] })]) {
      const root = await mkdtemp(join(tmpdir(), "local-review-mcp-goal-invalid-"));
      temporaryDirectories.push(root);
      const invalidFile = goalOrchestrationStateFile(root);
      await mkdir(dirname(invalidFile), { recursive: true });
      await writeFile(invalidFile, contents, "utf8");
      const unavailable = new GoalOrchestrationService(f.registry, { storageRoot: root });
      await expect(unavailable.restore()).rejects.toBeInstanceOf(GoalOrchestrationUnavailableError);
    }
  });
});
