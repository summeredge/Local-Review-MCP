import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../src/app.js";
import type { ResolvedSettings } from "../../src/config/settings.js";
import {
  buildDiagnosticGoalPlan,
  DIAGNOSTIC_MAX_ITERATIONS,
  parseGoalE2EDiagnosticArgs,
  runGoalE2EDiagnostic,
} from "../../src/control-plane/goal-e2e-diagnostic.js";
import type { GoalOrchestration } from "../../src/control-plane/goal-orchestration.js";

const settings: ResolvedSettings = {
  host: "127.0.0.1",
  port: 12080,
  workspace: "C:\\workspace",
  auth: { token: "token" },
  remote: { enabled: false, endpoint: "" },
  supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
};

function server(): Server {
  const value = {
    listening: true,
    close: vi.fn((callback?: () => void) => {
      value.listening = false;
      callback?.();
      return value;
    }),
  };
  return value as unknown as Server;
}

function goal(plan: ReturnType<typeof buildDiagnosticGoalPlan>, status: "pending" | "running"): GoalOrchestration {
  const phase = plan.phases[0]!;
  const task = phase.tasks[0]!;
  return {
    ...plan,
    phases: [{ ...phase, status }],
    status,
    ...(status === "running"
      ? {
        current_phase_id: phase.phase_id,
        current_task_id: task.task_id,
        execution_id: "execution-1",
        actuation_id: "actuation-1",
        loop_id: "loop-1",
      }
      : {}),
    created_at: "2026-09-09T00:00:00.000Z",
    updated_at: "2026-09-09T00:00:00.000Z",
  } as GoalOrchestration;
}

describe("diagnose-goal-e2e", () => {
  it("requires conversation identity and rejects max-iteration overrides before runtime startup", async () => {
    expect(() => parseGoalE2EDiagnosticArgs(["--config", "settings.json"]))
      .toThrow("--conversation-id is required");
    expect(() => parseGoalE2EDiagnosticArgs([
      "--conversation-id", "conversation-1", "--max-iterations", "10",
    ])).toThrow("unknown argument: --max-iterations");

    const loadSettings = vi.fn();
    await expect(runGoalE2EDiagnostic([
      "--conversation-id", "conversation-1", "--max-iterations", "10",
    ], { loadSettings })).rejects.toThrow("unknown argument: --max-iterations");
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it("builds a new single-task plan with a fixed two-iteration limit", () => {
    const left = buildDiagnosticGoalPlan("workspace-1", "conversation-1");
    const right = buildDiagnosticGoalPlan("workspace-1", "conversation-1");
    expect(left.phases).toHaveLength(1);
    expect(left.phases[0]!.tasks).toHaveLength(1);
    expect(left.phases[0]!.tasks[0]!.max_iterations).toBe(DIAGNOSTIC_MAX_ITERATIONS);
    expect(left.goal_id).not.toBe(right.goal_id);
    expect(left.phases[0]!.tasks[0]!.task_id).not.toBe(right.phases[0]!.tasks[0]!.task_id);
    expect(left.phases[0]!.tasks[0]!.goal).toContain("docs/e2e-validation-marker.md");
    expect(left.phases[0]!.tasks[0]!.requirements.join("\n")).not.toContain("src/");
  });

  it("starts the real app before creating and starting exactly one Goal", async () => {
    const events: string[] = [];
    const logs: unknown[][] = [];
    const createdServer = server();
    let plan: ReturnType<typeof buildDiagnosticGoalPlan> | undefined;
    const created = vi.fn(async (input: ReturnType<typeof buildDiagnosticGoalPlan>) => {
      events.push("createGoal");
      plan = input;
      return goal(input, "pending");
    });
    const started = vi.fn(async (input: { goal_id: string }) => {
      events.push("startGoal");
      expect(input.goal_id).toBe(plan?.goal_id);
      return goal(plan!, "running");
    });
    const context = {
      registry: { active: { id: "workspace-1" } },
      goalOrchestration: { storageRoot: "C:\\state", createGoal: created, startGoal: started },
    } as unknown as AppContext;
    const load = vi.fn(async () => {
      events.push("loadSettings");
      return settings;
    });
    const createContext = vi.fn(() => {
      events.push("createAppContext");
      return context;
    });
    const start = vi.fn(async () => {
      events.push("startApp");
      return createdServer;
    });
    const log = vi.fn((...values: unknown[]) => logs.push(values));

    await runGoalE2EDiagnostic(["--config", "settings.json", "--conversation-id", "conversation-1"], {
      loadSettings: load,
      createAppContext: createContext,
      startApp: start,
      log,
      registerShutdown: vi.fn(),
      bridgeStatus: () => ({ available: false, address: "127.0.0.1", port: null, paired: false }),
    });

    expect(load).toHaveBeenCalledWith(["--config", "settings.json"]);
    expect(events).toEqual([
      "loadSettings",
      "createAppContext",
      "startApp",
      "createGoal",
      "startGoal",
    ]);
    expect(created).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledTimes(1);
    expect(plan?.conversation_id).toBe("conversation-1");
    expect(plan?.phases[0]!.tasks[0]!.max_iterations).toBe(2);
    const output = logs.flat().join("\n");
    expect(output).toContain("goal_id:");
    expect(output).toContain("task_id:");
    expect(output).toContain("loop_id:");
    expect(output).toContain("max_iterations: 2");
    expect(output).toContain("max_iterations=2");
  });
});
