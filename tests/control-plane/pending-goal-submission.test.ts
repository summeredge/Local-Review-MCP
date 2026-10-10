const faults = vi.hoisted(() => ({ rename: vi.fn(), chmod: vi.fn(), readFile: vi.fn() }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => { await faults.readFile(...args); return actual.readFile(...args); },
    rename: async (...args: Parameters<typeof actual.rename>) => { await faults.rename(...args); return actual.rename(...args); },
    chmod: async (...args: Parameters<typeof actual.chmod>) => { await faults.chmod(...args); return actual.chmod(...args); },
  };
});
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridge from "../../src/control-plane/bridge.js";
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
import {
  GoalStartError,
  type GoalSubmissionRequest,
  type GoalSubmissionResult,
} from "../../src/control-plane/goal-submission.js";

const temporaryDirectories: string[] = [];
const CORRELATION_A = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  faults.readFile.mockReset();
  faults.rename.mockReset();
  faults.chmod.mockReset();
  vi.spyOn(bridge, "extensionDeliveryReadiness").mockReturnValue({ ready: true, readiness_state: "ready" });
});

afterEach(async () => {
  vi.restoreAllMocks();
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
    start_confirmed: true,
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
  it("restores ACKed early evidence after runtime restart and starts a later Pending exactly once", async () => {
    const root = await makeRoot();
    const submitGoal = vi.fn(async () => result());
    const first = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    await expect(first.receiveIdentityEvidence(evidence())).resolves.toEqual({ accepted: true, durable: true });
    const correlations = new ConversationCorrelationRegistry(root);
    const restarted = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
    await restarted.recover();
    expect(correlations.correlation(CORRELATION_A)).toBeNull();
    await restarted.accept(input());
    await waitFor(async () => (await restarted.get(CORRELATION_A))?.state === "started");
    await Promise.all(Array.from({ length: 5 }, () => restarted.receiveIdentityEvidence(evidence())));
    await restarted.resolve(CORRELATION_A);
    expect(submitGoal).toHaveBeenCalledTimes(1);
    await expect(restarted.receiveIdentityEvidence({ ...evidence(), conversation_id: "conversation-b" }))
      .rejects.toThrow("different conversation");
    expect(correlations.correlation(CORRELATION_A)?.conversation_id).toBe("conversation-a");
  });

  it("recovers an existing Pending when the runtime stopped after Inbox save and before correlation observation", async () => {
    const root = await makeRoot();
    const submitGoal = vi.fn(async () => result());
    const first = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    await first.accept(input());
    await first.evidenceInbox.put(evidence());
    const restored = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    await restored.recover();
    await waitFor(async () => (await restored.get(CORRELATION_A))?.state === "started");
    expect(submitGoal).toHaveBeenCalledTimes(1);
    const again = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    await again.recover();
    await again.receiveIdentityEvidence(evidence());
    expect(submitGoal).toHaveBeenCalledTimes(1);
  });

  it("fails closed for conflicting early evidence and never consumes expired Inbox entries", async () => {
    const root = await makeRoot();
    let now = Date.now();
    const submitGoal = vi.fn(async () => result());
    const correlations = new ConversationCorrelationRegistry(root);
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root, now: () => now });
    await pending.receiveIdentityEvidence(evidence());
    await expect(pending.receiveIdentityEvidence({ ...evidence(), conversation_id: "conversation-b" }))
      .rejects.toThrow("different conversation");
    now += 5 * 60 * 1000;
    await pending.accept(input());
    expect(correlations.correlation(CORRELATION_A)).toBeNull();
    expect(submitGoal).not.toHaveBeenCalled();
    now += PENDING_GOAL_SUBMISSION_TTL_MS;
    await pending.expire(CORRELATION_A);
    expect(await pending.get(CORRELATION_A)).toMatchObject({ state: "failed", error: "pending_identity_expired" });
  });

  it("rejects an unavailable Browser channel before any pending side effect", async () => {
    vi.mocked(bridge.extensionDeliveryReadiness).mockRestore();
    const root = await makeRoot();
    const record = vi.fn();
    const submitGoal = vi.fn(async () => result());
    const pending = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal },
      { storageRoot: root, identityTrace: { record } });
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(pending.accept(input())).rejects.toThrow("bridge_unavailable");
      expect(await pending.list()).toEqual([]);
      await expect(readFile(pendingGoalSubmissionStateFile(root))).rejects.toMatchObject({ code: "ENOENT" });
      expect(record).not.toHaveBeenCalled();
      expect(timer).not.toHaveBeenCalled();
      expect(submitGoal).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });
  it("reproduces expiry when no evidence is delivered, without attributing the upstream loss", async () => {
    const root = await makeRoot();
    let now = Date.parse('2026-09-17T05:10:39.248Z');
    const submitGoal = vi.fn(async () => result());
    const pending = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal },
      { storageRoot: root, now: () => now, environment: {} });
    await pending.accept(input());
    now += 120000;
    await pending.expire(CORRELATION_A);
    expect(await pending.get(CORRELATION_A)).toMatchObject({ state: 'failed', error: 'pending_identity_expired' });
    expect(submitGoal).not.toHaveBeenCalled();
  });
  it("waits for delayed correlation evidence and resolves the pending Goal automatically", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const trace = vi.fn();
    const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => result(request.conversation_id));
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, {
      storageRoot: root,
      environment: { LRM_PENDING_IDENTITY_TIMEOUT_MS: "500" },
      identityTrace: { record: trace },
    });

    await pending.accept(input());
    expect(await pending.get(CORRELATION_A)).toMatchObject({ state: "pending_identity" });
    await correlations.observe(evidence());
    await waitFor(() => submitGoal.mock.calls.length === 1);

    expect(submitGoal).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: "conversation-a",
      execution_mode: "interactive",
    }));
    expect((await pending.get(CORRELATION_A))?.state).toBe("started");
    expect(trace.mock.calls.map(([event]) => event.event)).toEqual([
      "pending_created",
      "evidence_match_success",
      "goal_started",
    ]);
  });

  it("keeps omitted execution mode distinct from explicit batch for idempotency", async () => {
    const root = await makeRoot();
    const trace = vi.fn();
    const pending = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), {
      submitGoal: vi.fn(async () => result()),
    }, { storageRoot: root, identityTrace: { record: trace } });

    await pending.accept(input());
    await expect(pending.accept({ ...input(), execution_mode: "interactive" })).resolves.toMatchObject({ accepted: true });
    await expect(pending.accept({ ...input(), execution_mode: "batch" }))
      .rejects.toThrow("different pending Goal submission");
    expect((await pending.get(CORRELATION_A))?.execution_mode).toBeUndefined();
    expect(trace.mock.calls[0]?.[0]).not.toHaveProperty("execution_mode");
  });

  it("restores a legacy Pending without writing batch and resolves it to interactive", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const initial = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), {
      submitGoal: vi.fn(async () => result()),
    }, { storageRoot: root });
    await initial.accept(input());
    const file = pendingGoalSubmissionStateFile(root);
    const state = JSON.parse(await readFile(file, "utf8")) as {
      submissions: Array<Record<string, unknown>>;
    };
    delete state.submissions[0]!.execution_mode;
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await correlations.observe(evidence());

    const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => result(request.conversation_id));
    const restored = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
    await restored.restore();
    expect((await restored.get(CORRELATION_A))?.execution_mode).toBeUndefined();
    const restoredState = JSON.parse(await readFile(file, "utf8")) as { submissions: Array<Record<string, unknown>> };
    expect(restoredState.submissions[0]).not.toHaveProperty("execution_mode");

    await restored.resolve(CORRELATION_A);
    await waitFor(async () => (await restored.get(CORRELATION_A))?.state === "started");
    expect(submitGoal).toHaveBeenCalledWith(expect.objectContaining({ execution_mode: "interactive" }));
    const finished = JSON.parse(await readFile(file, "utf8")) as { submissions: Array<Record<string, unknown>> };
    expect(finished.submissions[0]).not.toHaveProperty("execution_mode");
  });

  it("fails closed after the identity timeout when correlation never arrives", async () => {
    const root = await makeRoot();
    const submitGoal = vi.fn(async () => result());
    const pending = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, {
      storageRoot: root,
      environment: { LRM_PENDING_IDENTITY_TIMEOUT_MS: "50" },
    });

    await pending.accept(input());
    await waitFor(async () => (await pending.get(CORRELATION_A))?.state === "failed");

    await expect(pending.get(CORRELATION_A)).resolves.toMatchObject({
      state: "failed",
      error: "pending_identity_expired",
    });
    expect(submitGoal).not.toHaveBeenCalled();
  });

  it("resolves immediately when correlation already exists", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    await correlations.observe(evidence());
    const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => result(request.conversation_id));
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });

    await pending.accept(input());
    await waitFor(() => submitGoal.mock.calls.length === 1);

    expect(submitGoal).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: "conversation-a",
    }));
    expect((await pending.get(CORRELATION_A))?.state).toBe("started");
  });

  it("persists only authenticated provenance and keeps the correlation gate fail-closed", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const submitGoal = vi.fn(async (
      _request: GoalSubmissionRequest,
      provenance?: { readonly source: "authenticated_mcp_invocation" },
    ) => {
      expect(provenance).toEqual({ source: "authenticated_mcp_invocation" });
      return result();
    });
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
    const proof = { source: "authenticated_mcp_invocation" as const };

    await pending.accept({ ...input(), workspace_id: "workspace-d" }, proof);
    expect(await pending.get(CORRELATION_A)).toMatchObject({
      state: "pending_identity",
      workspace_id: "workspace-d",
      connector_provenance: proof,
    });
    await expect(readFile(pendingGoalSubmissionStateFile(root), "utf8"))
      .resolves.toContain('"source": "authenticated_mcp_invocation"');
    await expect(readFile(pendingGoalSubmissionStateFile(root), "utf8"))
      .resolves.not.toContain("access-token-secret");

    await correlations.observe(evidence("00000000-0000-4000-8000-000000000002"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(submitGoal).not.toHaveBeenCalled();
    expect((await pending.get(CORRELATION_A))?.state).toBe("pending_identity");

    await correlations.observe(evidence());
    await waitFor(() => submitGoal.mock.calls.length === 1);
    expect((await pending.get(CORRELATION_A))?.state).toBe("started");
  });

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
    const restoredCorrelations = new ConversationCorrelationRegistry(root);
    await restoredCorrelations.observe(evidence());

    const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => result(request.conversation_id));
    const restarted = new PendingGoalSubmissionService(restoredCorrelations, { submitGoal }, { storageRoot: root });
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
    // Seed the interrupted checkpoint before evidence can trigger the live resolver.
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

  it("refuses an unconfirmed result even when an Execution ID is allocated", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const record = vi.fn();
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal: async () => ({ ...result(), start_confirmed: undefined }) }, { storageRoot: root, identityTrace: { record } });
    await pending.accept(input());
    await correlations.observe(evidence());
    await pending.resolve(CORRELATION_A);
    expect(await pending.get(CORRELATION_A)).toMatchObject({ state: "indeterminate", error: expect.stringContaining("confirmation") });
    expect(record.mock.calls.filter(([event]) => event.event === "goal_started")).toHaveLength(0);
  });

  it.each(["failed", "indeterminate"] as const)("does not emit goal_started for %s launch results", async state => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const record = vi.fn();
    const submitGoal = vi.fn(async () => { throw new GoalStartError(state, { ...result(), status: state === "failed" ? "failed" : "human_required" }, "Desktop stage=create_thread: unavailable"); });
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root, identityTrace: { record } });
    await pending.accept(input());
    await correlations.observe(evidence());
    await pending.resolve(CORRELATION_A);
    expect(await pending.get(CORRELATION_A)).toMatchObject({ state, error: expect.stringContaining("create_thread"), result: { goal_id: result().goal_id, task_id: "task-1", execution_id: "execution-1" } });
    expect(record.mock.calls.filter(([event]) => event.event === "goal_started")).toHaveLength(0);
    expect(record.mock.calls.filter(([event]) => event.event === "goal_start_failed")).toMatchObject([[{ goal_id: result().goal_id, task_id: "task-1", execution_id: "execution-1", failure_reason: expect.stringContaining("create_thread") }]]);
    const restored = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
    await restored.recover();
    await restored.resolve(CORRELATION_A);
    expect(submitGoal).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "completed", "failed"] as const)("emits exactly one goal_started for a confirmed %s result", async status => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const record = vi.fn();
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal: vi.fn(async () => ({ ...result(), status })) }, { storageRoot: root, identityTrace: { record } });
    await pending.accept(input());
    await correlations.observe(evidence());
    await pending.resolve(CORRELATION_A);
    await pending.resolve(CORRELATION_A);
    expect(await pending.get(CORRELATION_A)).toMatchObject({ state: "started", status });
    expect(record.mock.calls.filter(([event]) => event.event === "goal_started")).toHaveLength(1);
  });

});

describe("Interactive Pending identity persistence recovery", () => {
  it.each([ ["EPERM", 1], ["EACCES", 3], ["EBUSY", 2] ] as const)("retries %s across %s starting publish failures", async (code, failures) => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => {
      expect(request.execution_mode).toBe("interactive");
      expect(request.conversation_id).toBe("conversation-a");
      return result();
    });
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
    await pending.accept({ ...input(), execution_mode: "interactive" });
    let attempts = 0;
    faults.rename.mockImplementation(async (source, target) => {
      if (target === pendingGoalSubmissionStateFile(root) && (await readFile(source, "utf8")).includes('"state": "starting"')) {
        if (++attempts <= failures) throw Object.assign(new Error("publish occupied"), { code });
      }
    });
    await pending.receiveIdentityEvidence(evidence());
    await Promise.all([pending.resolve(CORRELATION_A), pending.resolve(CORRELATION_A)]);
    await waitFor(async () => (await pending.get(CORRELATION_A))?.state === "started", 3_000);
    await Promise.all([pending.resolve(CORRELATION_A), pending.resolve(CORRELATION_A), pending.receiveIdentityEvidence(evidence())]);
    expect(attempts).toBe(failures + 1);
    expect(submitGoal).toHaveBeenCalledTimes(1);
    const restarted = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    await restarted.recover();
    expect((await restarted.get(CORRELATION_A))?.state).toBe("started");
    expect(submitGoal).toHaveBeenCalledTimes(1);
  });

  it("sets permissions before publication and never errors after successful rename", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const submitGoal = vi.fn(async () => result());
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
    faults.chmod.mockImplementation(async path => {
      if (path === pendingGoalSubmissionStateFile(root)) throw Object.assign(new Error("post-publish permission denied"), { code: "EPERM" });
    });
    await pending.accept({ ...input(), execution_mode: "interactive" });
    await pending.receiveIdentityEvidence(evidence());
    await waitFor(async () => (await pending.get(CORRELATION_A))?.state === "started");
    expect(faults.chmod.mock.calls.some(([path]) => path === pendingGoalSubmissionStateFile(root))).toBe(false);
    expect(faults.chmod.mock.calls.some(([path]) => String(path).includes(".pending-goal-submissions-") && String(path).endsWith(".tmp"))).toBe(true);
    const disk = JSON.parse(await readFile(pendingGoalSubmissionStateFile(root), "utf8"));
    expect(disk.submissions[0].state).toBe("started");
    expect(submitGoal).toHaveBeenCalledTimes(1);
  });

  it("bounds persistent publish failures and retains normal expiry semantics", async () => {
    const root = await makeRoot(); let now = Date.now();
    const correlations = new ConversationCorrelationRegistry(root);
    const submitGoal = vi.fn(async () => result());
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root, now: () => now });
    // Disable automatic waiter scheduling so this test measures one bounded resolver.
    const isolated = new PendingGoalSubmissionService({
      correlation: key => correlations.correlation(key), observe: proof => correlations.observe(proof),
      awaitCorrelation: async () => null,
    }, { submitGoal }, { storageRoot: root, now: () => now });
    await isolated.accept({ ...input(), execution_mode: "interactive" });
    await correlations.observe(evidence());
    let attempts = 0;
    faults.rename.mockImplementation(async (source, target) => {
      if (target === pendingGoalSubmissionStateFile(root) && (await readFile(source, "utf8")).includes('"state": "starting"')) {
        attempts++; throw Object.assign(new Error("publish occupied"), { code: "EBUSY" });
      }
    });
    await expect(isolated.resolve(CORRELATION_A)).rejects.toMatchObject({ code: "EBUSY" });
    expect(attempts).toBe(6);
    expect(submitGoal).not.toHaveBeenCalled();
    now += PENDING_GOAL_SUBMISSION_TTL_MS;
    await isolated.expire(CORRELATION_A);
    expect(await isolated.get(CORRELATION_A)).toMatchObject({ state: "failed", error: "pending_identity_expired" });
  });

  it("does not retry an uncertain launch even if the launch error has a transient filesystem code", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const submitGoal = vi.fn(async () => { throw Object.assign(new Error("unknown launch result"), { code: "EPERM" }); });
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
    await pending.accept({ ...input(), execution_mode: "interactive" });
    await pending.receiveIdentityEvidence(evidence());
    await waitFor(async () => (await pending.get(CORRELATION_A))?.state === "indeterminate");
    await Promise.all([pending.resolve(CORRELATION_A), pending.resolve(CORRELATION_A)]);
    expect(submitGoal).toHaveBeenCalledTimes(1);
  });
});

it("restores durable Interactive evidence and retries starting publication after restart", async () => {
  const root = await makeRoot();
  const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => { expect(request.execution_mode).toBe("interactive"); return result(); });
  const first = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
  await first.accept({ ...input(), execution_mode: "interactive" });
  await first.evidenceInbox.put(evidence());
  let failures = 0;
  faults.rename.mockImplementation(async (source, target) => {
    if (target === pendingGoalSubmissionStateFile(root) && (await readFile(source, "utf8")).includes('"state": "starting"') && failures++ < 2) {
      throw Object.assign(new Error("restored publish locked"), { code: "EACCES" });
    }
  });
  const correlations = new ConversationCorrelationRegistry(root);
  const restored = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
  await restored.recover();
  await waitFor(async () => (await restored.get(CORRELATION_A))?.state === "started", 3_000);
  expect(correlations.correlation(CORRELATION_A)?.conversation_id).toBe("conversation-a");
  expect(submitGoal).toHaveBeenCalledTimes(1);
});

it("does not extend the original Interactive Pending expiry while a retry is waiting", async () => {
  const root = await makeRoot(); let now = Date.now();
  const correlations = new ConversationCorrelationRegistry(root);
  const submitGoal = vi.fn(async () => result());
  const pending = new PendingGoalSubmissionService({ correlation: key => correlations.correlation(key),
    observe: proof => correlations.observe(proof), awaitCorrelation: async () => null }, { submitGoal }, { storageRoot: root, now: () => now });
  const receipt = await pending.accept({ ...input(), execution_mode: "interactive" });
  await correlations.observe(evidence());
  let attempts = 0;
  faults.rename.mockImplementation(async (source, target) => {
    if (target === pendingGoalSubmissionStateFile(root) && (await readFile(source, "utf8")).includes('"state": "starting"')) {
      attempts++; throw Object.assign(new Error("locked until expiry"), { code: "EPERM" });
    }
  });
  const resolving = pending.resolve(CORRELATION_A);
  await waitFor(() => attempts === 1);
  now = Date.parse(receipt.expires_at);
  await resolving;
  expect(attempts).toBe(1);
  expect(submitGoal).not.toHaveBeenCalled();
  expect(await pending.get(CORRELATION_A)).toMatchObject({ state: "failed", error: "pending_identity_expired", expires_at: receipt.expires_at });
});

it("does not retry nontransient Interactive identity publication errors", async () => {
  const root = await makeRoot();
  const correlations = new ConversationCorrelationRegistry(root);
  const submitGoal = vi.fn(async () => result());
  const pending = new PendingGoalSubmissionService({ correlation: key => correlations.correlation(key),
    observe: proof => correlations.observe(proof), awaitCorrelation: async () => null }, { submitGoal }, { storageRoot: root });
  await pending.accept({ ...input(), execution_mode: "interactive" });
  await correlations.observe(evidence());
  let attempts = 0;
  faults.rename.mockImplementation(async (source, target) => {
    if (target === pendingGoalSubmissionStateFile(root) && (await readFile(source, "utf8")).includes('"state": "starting"')) {
      attempts++; throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }
  });
  await expect(pending.resolve(CORRELATION_A)).rejects.toMatchObject({ code: "ENOSPC" });
  expect(attempts).toBe(1);
  expect(submitGoal).not.toHaveBeenCalled();
});

describe("Interactive Pending deferred recovery", () => {
  it("recovers a lock longer than the short retry window without new evidence, and deduplicates later evidence", async () => {
    const root = await makeRoot();
    const correlations = new ConversationCorrelationRegistry(root);
    const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => {
      expect(request.execution_mode).toBe("interactive");
      return result();
    });
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, { storageRoot: root });
    await pending.accept({ ...input(), execution_mode: "interactive" });
    const lockedUntil = Date.now() + 2_600;
    let attempts = 0;
    faults.rename.mockImplementation(async (source, target) => {
      if (target === pendingGoalSubmissionStateFile(root) && (await readFile(source, "utf8")).includes('"state": "starting"')) {
        attempts++;
        if (Date.now() < lockedUntil) throw Object.assign(new Error("long publish lock"), { code: "EPERM" });
      }
    });
    await pending.receiveIdentityEvidence(evidence());
    await waitFor(() => attempts === 6, 3_000);
    expect(submitGoal).not.toHaveBeenCalled();
    await pending.recover(); // Lifecycle recovery must not bypass the one deferred timer.
    await waitFor(async () => (await pending.get(CORRELATION_A))?.state === "started", 8_000);
    await Promise.all(Array.from({ length: 5 }, () => pending.receiveIdentityEvidence(evidence())));
    expect(submitGoal).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(7);
    expect((pending as unknown as { deferredResolves: Map<string, unknown> }).deferredResolves.size).toBe(0);
  }, 15_000);

  it("expires under a persistent starting lock and cancels deferred recovery", async () => {
    const root = await makeRoot();
    const submitGoal = vi.fn(async () => result());
    const pending = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, {
      storageRoot: root, environment: { LRM_PENDING_IDENTITY_TIMEOUT_MS: "3000" },
    });
    const accepted = await pending.accept({ ...input(), execution_mode: "interactive" });
    faults.rename.mockImplementation(async (source, target) => {
      if (target === pendingGoalSubmissionStateFile(root) && (await readFile(source, "utf8")).includes('"state": "starting"')) {
        throw Object.assign(new Error("locked through TTL"), { code: "EBUSY" });
      }
    });
    await pending.receiveIdentityEvidence(evidence());
    await waitFor(async () => (await pending.get(CORRELATION_A))?.state === "failed", 5_000);
    expect(await pending.get(CORRELATION_A)).toMatchObject({ error: "pending_identity_expired", expires_at: accepted.expires_at });
    expect(submitGoal).not.toHaveBeenCalled();
    expect((pending as unknown as { deferredResolves: Map<string, unknown> }).deferredResolves.size).toBe(0);
  }, 8_000);

  it.each(["pending", "inbox"])("retries a transient %s restore and shares concurrent restore work", async location => {
    const root = await makeRoot();
    const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => { expect(request.execution_mode).toBe("interactive"); return result(); });
    const first = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    await first.accept({ ...input(), execution_mode: "interactive" });
    await first.evidenceInbox.put(evidence());
    const file = location === "pending" ? pendingGoalSubmissionStateFile(root) : first.evidenceInbox.file;
    let reads = 0;
    faults.readFile.mockImplementation(async path => {
      if (path === file && ++reads === 1) throw Object.assign(new Error("restore locked"), { code: "EPERM" });
    });
    const restored = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    const a = restored.restore(); const b = restored.restore();
    expect(a).toBe(b);
    await expect(a).rejects.toMatchObject({ code: "EPERM" });
    await expect(b).rejects.toMatchObject({ code: "EPERM" });
    await restored.recover();
    await waitFor(async () => (await restored.get(CORRELATION_A))?.state === "started");
    expect(reads).toBe(2);
    expect(submitGoal).toHaveBeenCalledTimes(1);
  });

  it("automatically retries initial lifecycle restore errors but keeps invalid JSON fail-closed", async () => {
    const root = await makeRoot();
    const submitGoal = vi.fn(async () => result());
    const first = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    await first.accept({ ...input(), execution_mode: "interactive" });
    await first.evidenceInbox.put(evidence());
    let failures = 2;
    faults.readFile.mockImplementation(async path => {
      if (path === pendingGoalSubmissionStateFile(root) && failures-- > 0) throw Object.assign(new Error("initial restore locked"), { code: "EACCES" });
    });
    const restored = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    await restored.recover();
    await waitFor(async () => (await restored.get(CORRELATION_A))?.state === "started");
    expect(submitGoal).toHaveBeenCalledTimes(1);
    faults.readFile.mockReset();
    await writeFile(pendingGoalSubmissionStateFile(root), "invalid JSON", "utf8");
    const corrupt = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    const failed = corrupt.restore();
    await expect(failed).rejects.toThrow();
    expect(corrupt.restore()).toBe(failed);
    await expect(corrupt.recover()).rejects.toThrow();
    expect((corrupt as unknown as { recoveryTimer: unknown }).recoveryTimer).toBeUndefined();
    expect(submitGoal).toHaveBeenCalledTimes(1);
  });
});

it("cancels deferred resolution on starting and never redispatches an in-flight Interactive Goal", async () => {
  const root = await makeRoot();
  let complete!: (value: GoalSubmissionResult) => void;
  const submitted = new Promise<GoalSubmissionResult>(resolve => { complete = resolve; });
  const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => { expect(request.execution_mode).toBe("interactive"); return submitted; });
  const pending = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
  await pending.accept({ ...input(), execution_mode: "interactive" });
  let locked = true;
  faults.rename.mockImplementation(async (source, target) => {
    if (locked && target === pendingGoalSubmissionStateFile(root) && (await readFile(source, "utf8")).includes('"state": "starting"')) {
      throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
    }
  });
  await pending.receiveIdentityEvidence(evidence());
  const timers = (pending as unknown as { deferredResolves: Map<string, unknown> }).deferredResolves;
  await waitFor(() => timers.size === 1, 3_000);
  locked = false;
  const resolving = pending.resolve(CORRELATION_A);
  await waitFor(() => submitGoal.mock.calls.length === 1);
  expect((await pending.get(CORRELATION_A))?.state).toBe("starting");
  expect(timers.size).toBe(0);
  await Promise.all([pending.receiveIdentityEvidence(evidence()), pending.resolve(CORRELATION_A), pending.recover()]);
  expect(submitGoal).toHaveBeenCalledTimes(1);
  complete(result()); await resolving;
  expect((await pending.get(CORRELATION_A))?.state).toBe("started");
}, 6_000);

it("keeps persisted Interactive identity across a shutdown between deferred scheduling and restart", async () => {
  const root = await makeRoot();
  const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => { expect(request.execution_mode).toBe("interactive"); expect(request.conversation_id).toBe("conversation-a"); return result(); });
  const first = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
  await first.accept({ ...input(), execution_mode: "interactive" });
  faults.rename.mockImplementation(async (source, target) => {
    if (target === pendingGoalSubmissionStateFile(root) && (await readFile(source, "utf8")).includes('"state": "starting"')) {
      throw Object.assign(new Error("locked before shutdown"), { code: "EBUSY" });
    }
  });
  await first.receiveIdentityEvidence(evidence());
  const previous = first as unknown as { deferredResolves: Map<string, unknown>; cancelExpiry(key: string): void };
  await waitFor(() => previous.deferredResolves.size === 1, 3_000);
  // A stopped runtime cannot keep its process-local timers; preserve only its durable records.
  previous.cancelExpiry(CORRELATION_A);
  faults.rename.mockReset();
  const restarted = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
  await restarted.recover();
  await Promise.all([restarted.receiveIdentityEvidence(evidence()), restarted.recover()]);
  await waitFor(async () => (await restarted.get(CORRELATION_A))?.state === "started");
  expect(submitGoal).toHaveBeenCalledTimes(1);
  expect(previous.deferredResolves.size).toBe(0);
}, 6_000);

describe("Interactive startup recovery scheduling", () => {
  it.each(["pending", "inbox"])("automatically restores a %s file locked for seconds after startup retries are exhausted", async location => {
    const root = await makeRoot();
    const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => { expect(request.execution_mode).toBe("interactive"); expect(request.conversation_id).toBe("conversation-a"); return result(); });
    const first = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    const receipt = await first.accept({ ...input(), execution_mode: "interactive" });
    await first.evidenceInbox.put(evidence());
    (first as unknown as { cancelExpiry(key: string): void }).cancelExpiry(CORRELATION_A);
    const file = location === "pending" ? pendingGoalSubmissionStateFile(root) : first.evidenceInbox.file;
    const unlockAt = Date.now() + 2_500;
    let reads = 0;
    faults.readFile.mockImplementation(async path => {
      if (path === file) { reads++; if (Date.now() < unlockAt) throw Object.assign(new Error("startup file locked"), { code: "EPERM" }); }
    });
    const restored = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    const a = restored.recover(); const b = restored.recover();
    expect(a).toBe(b);
    await expect(a).rejects.toMatchObject({ code: "EPERM" });
    await expect(b).rejects.toMatchObject({ code: "EPERM" });
    expect(submitGoal).not.toHaveBeenCalled();
    // No recover(), get(), resubmission, or evidence receipt triggers the automatic retry.
    await waitFor(() => submitGoal.mock.calls.length === 1, 7_000);
    await waitFor(async () => (await restored.get(CORRELATION_A))?.state === "started");
    expect((await restored.get(CORRELATION_A))?.expires_at).toBe(receipt.expires_at);
    expect(submitGoal).toHaveBeenCalledTimes(1);
    expect(reads).toBeGreaterThan(3);
    expect((restored as unknown as { recoveryTimer: unknown }).recoveryTimer).toBeUndefined();
    await Promise.all([restored.recover(), restored.recover()]);
    expect(submitGoal).toHaveBeenCalledTimes(1);
  }, 10_000);

  it.each(["pending_identity", "starting"] as const)("automatically reconciles restored %s without dispatch after a lock outlasts the original TTL", async state => {
    const root = await makeRoot();
    const submitGoal = vi.fn(async () => result());
    const first = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, {
      storageRoot: root, environment: { LRM_PENDING_IDENTITY_TIMEOUT_MS: "500" },
    });
    const receipt = await first.accept({ ...input(), execution_mode: "interactive" });
    await first.evidenceInbox.put(evidence());
    (first as unknown as { cancelExpiry(key: string): void }).cancelExpiry(CORRELATION_A);
    const file = pendingGoalSubmissionStateFile(root);
    const disk = JSON.parse(await readFile(file, "utf8")); disk.submissions[0].state = state;
    await writeFile(file, JSON.stringify(disk), "utf8");
    const unlockedAt = Date.now() + 800;
    faults.readFile.mockImplementation(async path => {
      if (path === file && Date.now() < unlockedAt) throw Object.assign(new Error("startup locked past pending TTL"), { code: "EBUSY" });
    });
    const restored = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    await expect(restored.recover()).rejects.toMatchObject({ code: "EBUSY" });
    await waitFor(async () => {
      const persisted = JSON.parse(await readFile(file, "utf8").catch(() => '{"submissions":[]}'));
      return persisted.submissions[0]?.state === (state === "starting" ? "indeterminate" : "failed");
    }, 4_000);
    expect(await restored.get(CORRELATION_A)).toMatchObject({ state: state === "starting" ? "indeterminate" : "failed", expires_at: receipt.expires_at });
    expect(submitGoal).not.toHaveBeenCalled();
    expect((restored as unknown as { recoveryTimer: unknown }).recoveryTimer).toBeUndefined();
  }, 6_000);

  it("stops automatic startup retries at the fixed recovery deadline and reports the failure", async () => {
    const root = await makeRoot(); let now = Date.now();
    const submitGoal = vi.fn(async () => result());
    const first = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, { storageRoot: root });
    await first.accept({ ...input(), execution_mode: "interactive" });
    (first as unknown as { cancelExpiry(key: string): void }).cancelExpiry(CORRELATION_A);
    const file = pendingGoalSubmissionStateFile(root); const original = await readFile(file, "utf8");
    let reads = 0;
    faults.readFile.mockImplementation(async path => {
      if (path === file) { reads++; throw Object.assign(new Error("persistent startup lock"), { code: "EACCES" }); }
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const restored = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(root), { submitGoal }, {
      storageRoot: root, now: () => now, environment: { LRM_PENDING_IDENTITY_TIMEOUT_MS: "1000" },
    });
    await expect(restored.recover()).rejects.toMatchObject({ code: "EACCES" });
    now += 1000;
    await waitFor(() => (restored as unknown as { recoveryTimer: unknown }).recoveryTimer === undefined, 2_000);
    expect(reads).toBe(3);
    expect(warn.mock.calls.some(([message]) => String(message).includes("deadline exhausted"))).toBe(true);
    expect(submitGoal).not.toHaveBeenCalled();
    faults.readFile.mockReset();
    expect(await readFile(file, "utf8")).toBe(original);
  }, 4_000);
});
