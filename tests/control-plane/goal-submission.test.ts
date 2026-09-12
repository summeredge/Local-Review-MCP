import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoIterationSchema,
  type AutoIteration,
  type AutoIterationStartInput,
} from "../../src/control-plane/auto-iteration.js";
import {
  ActuationAuthorizationStore,
  ControlledActuationService,
} from "../../src/control-plane/controlled-actuation.js";
import {
  GoalOrchestrationService,
} from "../../src/control-plane/goal-orchestration.js";
import {
  GoalSubmissionService,
  type GoalSubmissionOrchestration,
  type GoalSubmissionRequest,
} from "../../src/control-plane/goal-submission.js";
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

function request(): GoalSubmissionRequest {
  return {
    workspace_id: "workspace-a",
    conversation_id: "conversation-1",
    title: "Implement the requested feature",
    goal: "Add the feature through the existing Goal workflow.",
    requirements: ["Keep the change within the Control Plane."],
    acceptance_criteria: ["The complete Goal workflow remains usable."],
  };
}

async function fixture(): Promise<{
  readonly orchestration: GoalOrchestrationService;
  readonly tasks: TaskContextService;
  readonly executions: ExecutionContextService;
  readonly auto: { readonly start: ReturnType<typeof vi.fn> };
}> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-goal-submission-"));
  const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-goal-submission-workspace-"));
  temporaryDirectories.push(root, workspace);
  const registry = new WorkspaceRegistry([{ id: "workspace-a", name: "Workspace A", path: workspace }]);
  const tasks = new TaskContextService(root);
  const executions = new ExecutionContextService(root);
  const authorizations = new ActuationAuthorizationStore(root);
  const controlled = new ControlledActuationService(registry, {
    storageRoot: root,
    authorizationStore: authorizations,
    taskContextService: tasks,
    executionContextService: executions,
    adapter: {
      start: async (input) => {
        const execution = await executions.createExecutionContext({
          execution_id: input.execution_id,
          task_id: input.task_id,
          workspace_id: input.workspace_id,
          process_id: 1234,
          command: "codex exec --json -",
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
  const loops = new Map<string, AutoIteration>();
  const start = vi.fn(async (input: AutoIterationStartInput): Promise<AutoIteration> => {
    const existing = loops.get(input.loop_id);
    if (existing !== undefined) return structuredClone(existing);
    const timestamp = new Date().toISOString();
    const loop = autoIterationSchema.parse({
      ...input,
      initial_execution_id: input.execution_id,
      iteration: 1,
      stage: "execution",
      created_at: timestamp,
      updated_at: timestamp,
    });
    loops.set(loop.loop_id, loop);
    return structuredClone(loop);
  });
  const auto = {
    start,
    getLoop: vi.fn(async (loopId: string) => structuredClone(loops.get(loopId) ?? null)),
    advance: vi.fn(async (loopId: string) => {
      const loop = loops.get(loopId);
      if (loop === undefined) throw new Error("loop not found");
      return structuredClone(loop);
    }),
  };
  return {
    orchestration: new GoalOrchestrationService(registry, {
      storageRoot: root,
      taskContextService: tasks,
      executionContextService: executions,
      authorizationStore: authorizations,
      controlledActuation: controlled,
      autoIteration: auto,
    }),
    tasks,
    executions,
    auto,
  };
}

describe("GoalSubmissionService", () => {
  it("creates and starts one standard Goal workflow", async () => {
    const f = await fixture();
    const createGoal = vi.spyOn(f.orchestration, "createGoal");
    const startGoal = vi.spyOn(f.orchestration, "startGoal");
    const submitted = await new GoalSubmissionService(f.orchestration).submitGoal(request());
    const plan = createGoal.mock.calls[0]![0];
    const phase = plan.phases[0]!;
    const task = phase.tasks[0]!;

    expect(startGoal).toHaveBeenCalledWith({ goal_id: plan.goal_id });
    expect(plan).toMatchObject({
      workspace_id: "workspace-a",
      conversation_id: "conversation-1",
      phases: [{
        objective: "Implement the requested feature",
        tasks: [{
          goal: "Add the feature through the existing Goal workflow.",
          max_iterations: 2,
        }],
      }],
    });
    expect(submitted).toMatchObject({
      goal_id: plan.goal_id,
      phase_id: phase.phase_id,
      task_id: task.task_id,
      execution_id: expect.any(String),
      status: "running",
    });
    expect(await f.orchestration.getGoal(submitted.goal_id)).toMatchObject({
      status: "running",
      current_phase_id: submitted.phase_id,
      current_task_id: submitted.task_id,
      execution_id: submitted.execution_id,
    });
    expect(await f.tasks.getTaskContext(submitted.task_id)).toMatchObject({
      task_id: submitted.task_id,
      workspace_id: "workspace-a",
      conversation_id: "conversation-1",
      status: "pending",
    });
    expect(await f.executions.getExecutionContext(
      "workspace-a",
      submitted.task_id,
      submitted.execution_id,
    )).toMatchObject({
      execution_id: submitted.execution_id,
      task_id: submitted.task_id,
      workspace_id: "workspace-a",
      status: "running",
    });
    expect(f.auto.start).toHaveBeenCalledTimes(1);
  });

  it("rejects missing required fields before calling Goal Orchestration", async () => {
    const orchestration: GoalSubmissionOrchestration = {
      createGoal: vi.fn(),
      startGoal: vi.fn(),
    };
    const invalid = { ...request(), title: undefined };

    await expect(new GoalSubmissionService(orchestration).submitGoal(invalid as never))
      .rejects.toThrow(/title/);
    expect(orchestration.createGoal).not.toHaveBeenCalled();
    expect(orchestration.startGoal).not.toHaveBeenCalled();
  });
});
