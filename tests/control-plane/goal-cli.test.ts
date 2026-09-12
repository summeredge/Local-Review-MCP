import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../src/app.js";
import type { ResolvedSettings } from "../../src/config/settings.js";
import {
  autoIterationSchema,
  type AutoIteration,
} from "../../src/control-plane/auto-iteration.js";
import {
  goalCliFailure,
  parseGoalStatusCliArgs,
  parseGoalSubmissionCliArgs,
  runGoalStatusCommand,
  runGoalSubmissionCommand,
} from "../../src/control-plane/goal-cli.js";
import {
  GoalPreflightError,
  type GoalPreflightResult,
} from "../../src/control-plane/goal-preflight.js";
import {
  goalOrchestrationSchema,
  type GoalOrchestration,
} from "../../src/control-plane/goal-orchestration.js";
import type {
  GoalSubmissionRequest,
  GoalSubmissionResult,
} from "../../src/control-plane/goal-submission.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { ReviewRequestService } from "../../src/context/review-request-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

const settings: ResolvedSettings = {
  host: "127.0.0.1",
  port: 12081,
  workspace: "C:\\workspace",
  auth: { token: "token" },
  remote: { enabled: false, endpoint: "" },
  supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
};

function server(): Server {
  const value = {
    listening: true,
    close: vi.fn((callback?: (error?: Error) => void) => {
      value.listening = false;
      callback?.();
      return value;
    }),
  };
  return value as unknown as Server;
}

function submissionArgs(): string[] {
  return [
    "--config", "settings.json",
    "--workspace-id", "workspace-a",
    "--conversation-id", "conversation-1",
    "--title", "CLI goal",
    "--goal", "Run the requested Goal workflow.",
    "--max-iterations", "4",
  ];
}

function preflightFailure(stage: "connector" | "extension"): GoalPreflightResult {
  return {
    ready: false,
    runtime: { ready: true },
    connector: {
      ready: stage !== "connector",
      status: stage === "connector" ? "unconfigured" : "verified",
      action: "none",
      reason: stage === "connector" ? "remote_not_configured" : undefined,
    },
    extension: {
      ready: false,
      paired: stage !== "extension",
      present: false,
      bridge_available: false,
      readiness_state: stage === "extension" ? "extension_not_paired" : "extension_not_present",
      reason: stage === "extension" ? "Extension is not paired." : undefined,
    },
    workspace: { valid: true, workspace_id: "workspace-a" },
    conversation: { valid: true, conversation_id: "conversation-1" },
    failure_stage: stage,
    failure_reason: stage === "connector" ? "remote_not_configured" : "Extension is not paired.",
  };
}

describe("Goal submission CLI", () => {
  it("routes a submission through AppContext and returns workflow identities", async () => {
    const createdServer = server();
    const submitGoal = vi.fn(async (request: GoalSubmissionRequest): Promise<GoalSubmissionResult> => {
      expect(request).toMatchObject({
        workspace_id: "workspace-a",
        conversation_id: "conversation-1",
        requirements: ["Complete the requested goal."],
        acceptance_criteria: ["The requested goal is complete."],
        max_iterations: 4,
      });
      return {
        goal_id: "goal-1",
        phase_id: "phase-1",
        task_id: "task-1",
        execution_id: "execution-1",
        status: "running",
      };
    });
    const context = { goalSubmission: { submitGoal } } as unknown as AppContext;
    const loadSettings = vi.fn(async (argv: readonly string[] = []) => {
      expect(argv).toEqual(["--config", "settings.json"]);
      return settings;
    });
    const createAppContext = vi.fn(() => context);
    const startApp = vi.fn(async () => createdServer);
    const registerShutdown = vi.fn();

    await expect(runGoalSubmissionCommand(submissionArgs(), {
      loadSettings,
      createAppContext,
      startApp,
      registerShutdown,
    })).resolves.toEqual({
      goal_id: "goal-1",
      phase_id: "phase-1",
      task_id: "task-1",
      execution_id: "execution-1",
      status: "running",
    });

    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(createAppContext).toHaveBeenCalledWith(settings);
    expect(startApp).toHaveBeenCalledWith(settings, context, { silent: true });
    expect(submitGoal).toHaveBeenCalledTimes(1);
    expect(registerShutdown).toHaveBeenCalledTimes(1);
  });

  it("accepts repeatable requirements and acceptance criteria options", () => {
    expect(parseGoalSubmissionCliArgs([
      "--workspace-id", "workspace-a",
      "--conversation-id", "conversation-1",
      "--title", "CLI goal",
      "--goal", "Run the requested Goal workflow.",
      "--requirements", "Keep the change small.",
      "--requirements", "Use the existing services.",
      "--acceptance-criteria", "The workflow starts.",
    ]).request).toMatchObject({
      requirements: ["Keep the change small.", "Use the existing services."],
      acceptance_criteria: ["The workflow starts."],
    });
  });

  it.each([
    ["--goal", "--goal is required"],
    ["--workspace-id", "--workspace-id is required"],
    ["--conversation-id", "--conversation-id is required"],
  ])("rejects a missing required %s argument", (missing, message) => {
    const args = [
      "--workspace-id", "workspace-a",
      "--conversation-id", "conversation-1",
      "--title", "CLI goal",
      "--goal", "Run the requested Goal workflow.",
    ].filter((argument, index, values) => argument !== missing
      && values[index - 1] !== missing);
    expect(() => parseGoalSubmissionCliArgs(args)).toThrow(message);
  });

  it("maps Connector and Extension Preflight failures without creating a Goal", async () => {
    for (const stage of ["connector", "extension"] as const) {
      const createdServer = server();
      const failure = preflightFailure(stage);
      const submitGoal = vi.fn(async () => {
        throw new GoalPreflightError(failure);
      });
      const context = { goalSubmission: { submitGoal } } as unknown as AppContext;
      const closeServer = vi.fn(async (value: Server) => {
        value.close();
      });

      let error: unknown;
      try {
        await runGoalSubmissionCommand(submissionArgs(), {
          loadSettings: vi.fn(async () => settings),
          createAppContext: vi.fn(() => context),
          startApp: vi.fn(async () => createdServer),
          closeServer,
        });
      } catch (caught: unknown) {
        error = caught;
      }

      expect(error).toBeInstanceOf(GoalPreflightError);
      expect(goalCliFailure(error)).toEqual({
        status: "failed",
        stage,
        reason: failure.failure_reason,
      });
      expect(submitGoal).toHaveBeenCalledTimes(1);
      expect(closeServer).toHaveBeenCalledWith(createdServer);
    }
  });
});

describe("Goal status CLI", () => {
  it("parses a positional Goal identity and existing settings arguments", () => {
    expect(parseGoalStatusCliArgs([
      "goal-1", "--config", "settings.json", "--workspace", "C:\\workspace",
    ])).toEqual({
      goalId: "goal-1",
      settingsArgs: ["--config", "settings.json", "--workspace", "C:\\workspace"],
    });
  });

  it("reads Goal, Execution, and Review state without creating new state", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-goal-cli-"));
    temporaryDirectories.push(storageRoot);
    await new ExecutionContextService(storageRoot).createExecutionContext({
      execution_id: "execution-1",
      task_id: "task-1",
      workspace_id: "workspace-a",
      status: "running",
    });
    await new ReviewRequestService(storageRoot).createReviewRequest({
      review_request_id: "review-1",
      task_id: "task-1",
      execution_id: "execution-1",
      workspace_id: "workspace-a",
      status: "reviewing",
    });
    const goal: GoalOrchestration = goalOrchestrationSchema.parse({
      goal_id: "goal-1",
      workspace_id: "workspace-a",
      conversation_id: "conversation-1",
      phases: [{
        phase_id: "phase-1",
        objective: "CLI goal",
        status: "running",
        tasks: [{
          task_id: "task-1",
          goal: "Run the requested Goal workflow.",
          requirements: ["Complete the requested goal."],
          acceptance_criteria: ["The requested goal is complete."],
          max_iterations: 2,
        }],
      }],
      status: "running",
      current_phase_id: "phase-1",
      current_task_id: "task-1",
      execution_id: "execution-1",
      actuation_id: "actuation-1",
      loop_id: "loop-1",
      created_at: "2026-09-12T00:00:00.000Z",
      updated_at: "2026-09-12T00:00:00.000Z",
    });
    const loop: AutoIteration = autoIterationSchema.parse({
      loop_id: "loop-1",
      initial_execution_id: "execution-1",
      workspace_id: "workspace-a",
      task_id: "task-1",
      conversation_id: "conversation-1",
      max_iterations: 2,
      iteration: 1,
      execution_id: "execution-1",
      review_request_id: "review-1",
      stage: "review_request",
      created_at: "2026-09-12T00:00:00.000Z",
      updated_at: "2026-09-12T00:00:00.000Z",
    });
    const context = {
      storageRoot,
      goalOrchestration: {
        storageRoot,
        getGoal: vi.fn(async () => goal),
      },
      autoIteration: { getLoop: vi.fn(async () => loop) },
    } as unknown as AppContext;

    await expect(runGoalStatusCommand(["goal-1", "--config", "settings.json"], {
      loadSettings: vi.fn(async () => settings),
      createAppContext: vi.fn(() => context),
    })).resolves.toEqual({
      goal_id: "goal-1",
      status: "running",
      phase_id: "phase-1",
      task_id: "task-1",
      execution_id: "execution-1",
      execution_status: "running",
      review_status: "reviewing",
      review_request_id: "review-1",
      review_result_status: null,
    });
  });
});
