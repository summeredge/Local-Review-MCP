import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../src/app.js";
import type { ResolvedSettings } from "../../src/config/settings.js";
import {
  buildDiagnosticGoalPlan,
  DIAGNOSTIC_MAX_ITERATIONS,
  parseGoalE2EDiagnosticArgs,
  runGoalE2EDiagnostic,
  waitForExtensionReady,
} from "../../src/control-plane/goal-e2e-diagnostic.js";
import { diagnoseChatGPTConnector } from "../../src/control-plane/chatgpt-connector.js";
import type { GoalPreflightResult } from "../../src/control-plane/goal-preflight.js";
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

function goal(
  plan: ReturnType<typeof buildDiagnosticGoalPlan>,
  status: "pending" | "running" | "completed",
): GoalOrchestration {
  const phase = plan.phases[0]!;
  const task = phase.tasks[0]!;
  return {
    ...plan,
    phases: [{ ...phase, status }],
    status,
    ...(status !== "pending"
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
  it("waits for Extension presence recovery without weakening readiness", async () => {
    let now = 0;
    const states = [
      { ready: false, reason: "Extension is not paired." },
      { ready: false, reason: "Extension is not connected." },
      { ready: true, readiness_state: "ready" as const },
    ];
    const readiness = vi.fn(() => states.shift() ?? { ready: true, readiness_state: "ready" as const });
    const result = await waitForExtensionReady(readiness, "conversation-1", {
      timeoutMs: 1_000,
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
    });
    expect(result).toMatchObject({ ready: true, readiness_state: "ready" });
    expect(readiness).toHaveBeenCalledTimes(3);
  });

  it("returns the last blocked readiness state after the bounded wait", async () => {
    let now = 0;
    const result = await waitForExtensionReady(
      () => ({ ready: false, reason: "Extension is not connected.", readiness_state: "extension_not_present" }),
      "conversation-1",
      {
        timeoutMs: 500,
        now: () => now,
        wait: async (milliseconds) => { now += milliseconds; },
      },
    );
    expect(result).toEqual({
      ready: false,
      reason: "Extension is not connected.",
      readiness_state: "extension_not_present",
    });
  });

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

  it("preflights Connector and Extension before one Goal and prints a terminal summary", async () => {
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
    const getGoal = vi.fn(async () => goal(plan!, "completed"));
    const context = {
      registry: { active: { id: "workspace-1" } },
      goalOrchestration: { storageRoot: "C:\\state", createGoal: created, startGoal: started, getGoal },
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
    const diagnoseConnector = vi.fn(async () => {
      events.push("diagnoseConnector");
      return {
        ok: true,
        connector: { status: "verified", action: "none", reason: "verified_endpoint_matches" },
      } as Awaited<ReturnType<typeof diagnoseChatGPTConnector>>;
    });

    const result = await runGoalE2EDiagnostic(["--config", "settings.json", "--conversation-id", "conversation-1"], {
      loadSettings: load,
      createAppContext: createContext,
      startApp: start,
      diagnoseConnector,
      extensionReadiness: () => ({
        ready: true,
        bridge_available: true,
        extension_paired: true,
        last_seen_at: Date.now(),
        readiness_state: "ready",
      }),
      log,
      registerShutdown: vi.fn(),
      bridgeStatus: () => ({
        available: false,
        address: "127.0.0.1",
        port: null,
        paired: false,
        present: false,
        lastSeenAt: null,
      }),
    });

    expect(load).toHaveBeenCalledWith(["--config", "settings.json"]);
    expect(events).toEqual([
      "loadSettings",
      "createAppContext",
      "startApp",
      "diagnoseConnector",
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
    expect(output).toContain("review_completion_transport: extension");
    expect(output).toContain("browser_worker_required: false");
    expect(output).toContain("E2E Pre-run Snapshot");
    expect(output).toContain("E2E Run Summary");
    expect(result.summary).toMatchObject({
      runtime_status: "RUNNING",
      connector_status: "verified",
      extension_ready: true,
      goal_status: "completed",
    });
  });

  it("does not create a Goal when the shared Preflight fails", async () => {
    const createdServer = server();
    const plan = buildDiagnosticGoalPlan("workspace-1", "conversation-1");
    const created = vi.fn();
    const started = vi.fn();
    const context = {
      registry: { active: { id: "workspace-1" } },
      goalOrchestration: {
        storageRoot: "C:\\state",
        createGoal: created,
        startGoal: started,
        getGoal: vi.fn(),
      },
    } as unknown as AppContext;
    const preflight = {
      checkGoalPreflight: vi.fn(async (): Promise<GoalPreflightResult> => ({
        ready: false,
        runtime: { ready: true },
        connector: {
          ready: false,
          status: "unconfigured",
          action: "none",
          reason: "remote_not_configured",
        },
        extension: {
          ready: false,
          paired: false,
          present: false,
          readiness_state: "extension_not_paired",
          reason: "Extension is not paired.",
        },
        workspace: { valid: true, workspace_id: plan.workspace_id },
        conversation: { valid: true, conversation_id: plan.conversation_id },
        failure_stage: "connector",
        failure_reason: "remote_not_configured",
      })),
    };
    const logs: unknown[][] = [];

    await expect(runGoalE2EDiagnostic(["--conversation-id", "conversation-1"], {
      loadSettings: vi.fn(async () => settings),
      createAppContext: vi.fn(() => context),
      startApp: vi.fn(async () => createdServer),
      preflight,
      log: (...values: unknown[]) => logs.push(values),
    })).rejects.toThrow("ChatGPT Connector is not ready: remote_not_configured");

    expect(preflight.checkGoalPreflight).toHaveBeenCalledWith({
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
    });
    expect(created).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(logs.flat().join("\n")).toContain('"failure_stage": "connector"');
  });
});
