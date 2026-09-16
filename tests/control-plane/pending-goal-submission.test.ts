import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationCorrelationRegistry,
} from "../../src/control-plane/conversation-correlation.js";
import {
  GoalPreflightError,
  type GoalPreflightResult,
} from "../../src/control-plane/goal-preflight.js";
import {
  PendingGoalSubmissionService,
  PENDING_GOAL_SUBMISSION_TTL_MS,
  pendingGoalSubmissionStateFile,
  type PendingGoalSubmissionInput,
} from "../../src/control-plane/pending-goal-submission.js";
import type {
  GoalSubmissionRequest,
  GoalSubmissionResult,
} from "../../src/control-plane/goal-submission.js";

const temporaryDirectories: string[] = [];
const CORRELATION_A = "00000000-0000-4000-8000-000000000001";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function input(correlation_key = CORRELATION_A): PendingGoalSubmissionInput {
  return {
    correlation_key,
    workspace_id: "workspace-a",
    title: "Pending Goal",
    goal: "Run this Goal after the canonical conversation is known.",
    requirements: ["Keep the existing workflow."],
    acceptance_criteria: ["The Goal starts exactly once."],
    max_iterations: 2,
  };
}

function evidence(request_id = CORRELATION_A) {
  return {
    request_id,
    conversation_id: "conversation-a",
    document_id: "document-a",
    navigation_epoch: 1,
  };
}

function result(conversation_id = "conversation-a"): GoalSubmissionResult {
  return {
    goal_id: `goal-${conversation_id}`,
    phase_id: "phase-1",
    task_id: "task-1",
    execution_id: "execution-1",
    status: "running",
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for pending Goal submission");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-pending-goal-"));
  temporaryDirectories.push(root);
  return root;
}

function preflightFailure(): GoalPreflightResult {
  return {
    ready: false,
    runtime: { ready: true },
    connector: { ready: false, status: "verified", action: "none", timeline: [{
      attempt: 1, retry_count: 0, elapsed_ms: 25,
      state: "mcp_endpoint_unreachable", http_status: 403,
      current_mcp_url: "https://mcp.example.test/mcp",
      resource_metadata_url: null, protected_resource_metadata_url: null,
      authorization_server_url: null, failed_stage: "/mcp",
      error_type: "mcp_unexpected_http_status_403",
    }] },
    extension: { ready: false },
    workspace: { valid: true, workspace_id: "workspace-a" },
    conversation: { valid: true, conversation_id: "conversation-a" },
    failure_stage: "connector",
    failure_reason: "mcp_unexpected_http_status_403",
  };
}

describe("PendingGoalSubmissionService", () => {
  it("uses the configured identity timeout in expiry and trace", async () => {
    const root = await makeRoot();
    let now = Date.now();
    const identityTrace = { record: vi.fn() };
    const pending = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), {
      submitGoal: vi.fn(async () => result()),
    }, {
      storageRoot: root,
      now: () => now,
      environment: { LRM_PENDING_IDENTITY_TIMEOUT_MS: "600000" },
      identityTrace,
    });

    await pending.accept(input());
    expect(identityTrace.record).toHaveBeenCalledWith(expect.objectContaining({
      event: "pending_created",
      timeout_ms: 600000,
    }));

    now += 600000;
    await pending.expire(CORRELATION_A);
    expect(identityTrace.record).toHaveBeenLastCalledWith(expect.objectContaining({
      event: "pending_expired",
      timeout_ms: 600000,
    }));
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["invalid", "not-a-number"],
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
  ] as const)("falls back to the default identity timeout for %s values", async (_label, value) => {
    const root = await makeRoot();
    let now = Date.now();
    const identityTrace = { record: vi.fn() };
    const pending = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), {
      submitGoal: vi.fn(async () => result()),
    }, {
      storageRoot: root,
      now: () => now,
      environment: value === undefined ? {} : { LRM_PENDING_IDENTITY_TIMEOUT_MS: value },
      identityTrace,
    });

    await pending.accept(input());
    expect(identityTrace.record).toHaveBeenCalledWith(expect.objectContaining({
      event: "pending_created",
      timeout_ms: PENDING_GOAL_SUBMISSION_TTL_MS,
    }));

    now += PENDING_GOAL_SUBMISSION_TTL_MS;
    await pending.expire(CORRELATION_A);
  });

  it("recovers a pending submission when canonical correlation was restored", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const first = new PendingGoalSubmissionService(correlations, {
      submitGoal: vi.fn(async () => result()),
    }, { storageRoot: root });
    await first.accept(input());
    await correlations.observe(evidence());

    const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => result(request.conversation_id));
    const restarted = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
    await restarted.restore();
    await restarted.recover();
    await waitFor(() => submitGoal.mock.calls.length === 1);

    expect(submitGoal).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: "workspace-a",
      conversation_id: "conversation-a",
    }));
    expect((await restarted.get(CORRELATION_A))?.state).toBe("started");
  });

  it("converts restored starting work to indeterminate without retrying", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const first = new PendingGoalSubmissionService(correlations, {
      submitGoal: vi.fn(async () => result()),
    }, { storageRoot: root });
    await first.accept(input());
    await correlations.observe(evidence());
    const file = pendingGoalSubmissionStateFile(root);
    const state = JSON.parse(await readFile(file, "utf8")) as {
      submissions: Array<Record<string, unknown>>;
    };
    state.submissions[0]!.state = "starting";
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const submitGoal = vi.fn(async () => result());
    const restarted = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
    await restarted.restore();
    await restarted.recover();

    expect((await restarted.get(CORRELATION_A))?.state).toBe("indeterminate");
    expect(submitGoal).not.toHaveBeenCalled();
  });

  it("stores a terminal result and ignores later duplicate evidence", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const submitGoal = vi.fn(async () => result());
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
    await pending.accept(input());
    await correlations.observe(evidence());
    await Promise.all([pending.resolve(CORRELATION_A), pending.resolve(CORRELATION_A)]);
    await correlations.observe(evidence());
    await pending.resolve(CORRELATION_A);

    expect(submitGoal).toHaveBeenCalledTimes(1);
    expect((await pending.get(CORRELATION_A))?.state).toBe("started");
    expect((await pending.get(CORRELATION_A)) as Record<string, unknown>).toMatchObject({
      goal_id: "goal-conversation-a",
      phase_id: "phase-1",
      task_id: "task-1",
      execution_id: "execution-1",
      status: "running",
    });
  });

  it("marks a known preflight failure failed and an uncertain failure indeterminate", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const knownFailure = new PendingGoalSubmissionService(correlations, {
      submitGoal: vi.fn(async () => {
        throw new GoalPreflightError(preflightFailure());
      }),
    }, { storageRoot: root });
    await knownFailure.accept(input());
    await correlations.observe(evidence());
    await knownFailure.resolve(CORRELATION_A);
    expect((await knownFailure.get(CORRELATION_A))?.state).toBe("failed");
    const restored = new PendingGoalSubmissionService(correlations, {
      submitGoal: vi.fn(async () => result()),
    }, { storageRoot: root });
    await expect(restored.get(CORRELATION_A)).resolves.toMatchObject({
      state: "failed", preflight: preflightFailure(),
    });

    const uncertainRoot = await makeRoot();
    const uncertainCorrelations = new ConversationCorrelationRegistry(uncertainRoot);
    const uncertainSubmit = vi.fn(async () => {
      throw new Error("startup outcome is unknown");
    });
    const uncertain = new PendingGoalSubmissionService(uncertainCorrelations, {
      submitGoal: uncertainSubmit,
    }, { storageRoot: uncertainRoot });
    await uncertain.accept(input());
    await uncertainCorrelations.observe(evidence());
    await uncertain.resolve(CORRELATION_A);
    await uncertain.resolve(CORRELATION_A);
    expect((await uncertain.get(CORRELATION_A))?.state).toBe("indeterminate");
    expect(uncertainSubmit).toHaveBeenCalledTimes(1);
  });

});
