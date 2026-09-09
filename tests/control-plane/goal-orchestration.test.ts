import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoIterationSchema,
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

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
  const service = new GoalOrchestrationService(registry, {
    storageRoot: root,
    taskContextService: tasks,
    executionContextService: executions,
    authorizationStore: authorizations,
    controlledActuation: controlled,
    autoIteration: auto,
  });
  return { root, registry, tasks, executions, authorizations, controlled, starts, auto, service };
}

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
    expect(f.starts.mock.calls[0]![0].instruction).toBe([
      "## 修改目标",
      "Make the change",
      "",
      "## 修改要求",
      "- Keep it small",
      "",
      "## 验收标准",
      "- Tests pass",
    ].join("\n"));
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

  it("recovers an existing authorization without creating another authorization or execution", async () => {
    const f = await fixture();
    const plan = input();
    const checkpoint = runningGoal(plan);
    await f.tasks.createTaskContext({
      task_id: "task-1",
      workspace_id: plan.workspace_id,
      conversation_id: plan.conversation_id,
    });
    const authorization = await f.controlled.authorize({
      actuation_id: checkpoint.actuation_id!,
      workspace_id: plan.workspace_id,
      task_id: "task-1",
      execution_id: checkpoint.execution_id!,
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
    expect(f.starts).toHaveBeenCalledTimes(1);
    expect((await f.authorizations.getAuthorizationByActuation(checkpoint.actuation_id!))!.authorization_id)
      .toBe(authorization.authorization_id);
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
      instruction: "wrong instruction",
    });
    await persistGoal(f.root, checkpoint);
    await f.service.recover();

    expect((await f.service.getGoal(plan.goal_id))!.status).toBe("human_required");
    expect(f.starts).not.toHaveBeenCalled();
    expect(await f.executions.listExecutions(plan.workspace_id, "task-1")).toEqual([]);
  });

  it("stores only schema v1 orchestration data under control-plane and rejects corrupt or unknown state", async () => {
    const f = await fixture();
    const created = await f.service.createGoal(input());
    const file = goalOrchestrationStateFile(f.root);
    const state = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(file).toBe(join(f.root, "control-plane", "goal-orchestrations.json"));
    expect(state).toMatchObject({ schema_version: 1, goals: [created] });
    expect(JSON.stringify(state)).not.toContain("authorization_id");
    expect(JSON.stringify(state)).not.toContain("process_id");

    for (const contents of ["not json", JSON.stringify({ schema_version: 2, goals: [] })]) {
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
