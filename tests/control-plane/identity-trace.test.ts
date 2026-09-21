import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridge from "../../src/control-plane/bridge.js";

beforeEach(() => {
  vi.spyOn(bridge, "extensionDeliveryReadiness").mockReturnValue({ ready: true, readiness_state: "ready" });
});
afterEach(() => vi.restoreAllMocks());
import { ConversationCorrelationRegistry } from "../../src/control-plane/conversation-correlation.js";
import {
  IdentityTraceService,
  identityHash,
} from "../../src/control-plane/identity-trace.js";
import {
  PendingGoalSubmissionService,
  PENDING_GOAL_SUBMISSION_TTL_MS,
} from "../../src/control-plane/pending-goal-submission.js";
import type {
  GoalSubmissionRequest,
  GoalSubmissionResult,
} from "../../src/control-plane/goal-submission.js";
import { GoalPreflightError } from "../../src/control-plane/goal-preflight.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const clients: Client[] = [];
const temporaryDirectories: string[] = [];
const KEY_A = "00000000-0000-4000-8000-000000000001";
const KEY_B = "00000000-0000-4000-8000-000000000002";

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function evidence(request_id: string, conversation_id: string) {
  return {
    request_id,
    conversation_id,
    document_id: "document-a",
    navigation_epoch: 1,
  };
}

function input(correlation_key = KEY_A, workspace_id = "workspace-a") {
  return {
    correlation_key,
    workspace_id,
    title: "Trace Goal",
    goal: "Run the trace diagnostic.",
    requirements: ["Keep the existing behavior."],
    acceptance_criteria: ["The trace records every identity boundary."],
    max_iterations: 2,
  };
}

function result(request: GoalSubmissionRequest): GoalSubmissionResult {
  return {
    goal_id: `goal-${request.conversation_id}`,
    phase_id: "phase-trace",
    task_id: "task-trace",
    execution_id: "execution-trace",
    status: "running",
  };
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for identity trace flow");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("IdentityTraceService", () => {
  it("records the normal submit_goal to Goal flow in observation order and keeps identities hashed", async () => {
    const root = await makeRoot("local-review-mcp-identity-trace-normal-");
    const workspace = await makeRoot("local-review-mcp-identity-trace-workspace-");
    const registry = WorkspaceRegistry.fromManager(new WorkspaceManager(workspace));
    const correlations = new ConversationCorrelationRegistry(root);
    const trace = new IdentityTraceService(root);
    const submitGoal = vi.fn(async (request: GoalSubmissionRequest) => result(request));
    const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, {
      storageRoot: root,
      identityTrace: trace,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      registry,
      correlations,
      pendingGoalSubmission: pending,
      identityTrace: trace,
    });
    const client = new Client({ name: "identity-trace-test", version: "0.1.0" });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const accepted = await client.callTool({
      name: "submit_goal",
      arguments: { ...input(KEY_A, registry.active.id), execution_mode: "interactive" },
    });
    expect(accepted.isError).not.toBe(true);

    const currentEvidence = evidence(KEY_A, "conversation-a");
    trace.record({
      event: "extension_evidence_received",
      correlation_key: currentEvidence.request_id,
      conversation_id: currentEvidence.conversation_id,
      workspace_id: registry.active.id,
    });
    await correlations.observe(currentEvidence);
    await pending.diagnoseEvidence(currentEvidence, registry.active.id);
    pending.scheduleResolve(KEY_A);
    await waitFor(async () => (await pending.get(KEY_A))?.state === "started");

    const queried = await client.callTool({
      name: "get_identity_trace",
      arguments: { correlation_key: KEY_A },
    });
    const events = (queried.structuredContent as { events: Array<Record<string, unknown>> }).events;
    expect(events.map((event) => event.event)).toEqual([
      "submit_goal_received",
      "pending_created",
      "extension_evidence_received",
      "evidence_match_success",
      "goal_started",
    ]);
    expect(events.find((event) => event.event === "pending_created")).toMatchObject({
      execution_mode: "interactive",
      created_at: expect.any(String),
      expires_at: expect.any(String),
      timeout_ms: PENDING_GOAL_SUBMISSION_TTL_MS,
    });
    expect(events.find((event) => event.event === "extension_evidence_received")).toMatchObject({
      received_at: expect.any(String),
    });
    expect(events.find((event) => event.event === "goal_started")).toMatchObject({
      goal_id: "goal-conversation-a",
      execution_id: "execution-trace",
    });

    const contents = await readFile(trace.file, "utf8");
    expect(contents).toContain(identityHash(KEY_A));
    expect(contents).not.toContain(KEY_A);
    expect(contents).not.toContain('"conversation_id":"conversation-a"');
    expect(events.every((event) => !("correlation_key" in event) && !("conversation_id" in event))).toBe(true);
  });

  it("records the pending expiry boundary", async () => {
    const root = await makeRoot("local-review-mcp-identity-trace-expiry-");
    let now = Date.now();
    const trace = new IdentityTraceService(root, { now: () => now });
    const correlations = new ConversationCorrelationRegistry(root);
    const pending = new PendingGoalSubmissionService(correlations, {
      submitGoal: vi.fn(async () => result({ conversation_id: "unused" } as GoalSubmissionRequest)),
    }, {
      storageRoot: root,
      now: () => now,
      identityTrace: trace,
    });

    await pending.accept(input());
    now += PENDING_GOAL_SUBMISSION_TTL_MS;
    await pending.expire(KEY_A);

    await expect(pending.get(KEY_A)).resolves.toMatchObject({
      state: "failed",
      error: "pending_identity_expired",
    });
    await expect(trace.getIdentityTrace(KEY_A)).resolves.toMatchObject({
      events: [
        { event: "pending_created", timeout_ms: PENDING_GOAL_SUBMISSION_TTL_MS },
        {
          event: "pending_expired",
          created_at: expect.any(String),
          expires_at: expect.any(String),
          timeout_ms: PENDING_GOAL_SUBMISSION_TTL_MS,
        },
      ],
    });
  });

  it("records a correlation mismatch against the pending submission", async () => {
    const root = await makeRoot("local-review-mcp-identity-trace-mismatch-");
    const trace = new IdentityTraceService(root);
    const correlations = new ConversationCorrelationRegistry(root);
    const pending = new PendingGoalSubmissionService(correlations, {
      submitGoal: vi.fn(async () => result({ conversation_id: "unused" } as GoalSubmissionRequest)),
    }, {
      storageRoot: root,
      identityTrace: trace,
    });

    await pending.accept(input(KEY_A));
    const wrongEvidence = evidence(KEY_B, "conversation-b");
    trace.record({
      event: "extension_evidence_received",
      correlation_key: wrongEvidence.request_id,
      conversation_id: wrongEvidence.conversation_id,
      workspace_id: "workspace-a",
    });
    await correlations.observe(wrongEvidence);
    await pending.diagnoseEvidence(wrongEvidence, "workspace-a");

    const traceResult = await trace.getIdentityTrace(KEY_A);
    expect(traceResult.events.map((event) => event.event)).toEqual([
      "pending_created",
      "evidence_match_failed",
    ]);
    expect(traceResult.events[1]).toMatchObject({
      reason: "correlation_mismatch",
      observed_correlation_key_hash: identityHash(KEY_B),
      conversation_id_hash: identityHash("conversation-b"),
    });
  });

  it("records a bounded Goal start failure without storing its reason text", async () => {
    const root = await makeRoot("local-review-mcp-identity-trace-start-failure-");
    const trace = new IdentityTraceService(root);
    const correlations = new ConversationCorrelationRegistry(root);
    const failureReason = "Connector readiness failed at the configured endpoint.";
    const pending = new PendingGoalSubmissionService(correlations, {
      submitGoal: vi.fn(async () => {
        throw new GoalPreflightError({
          ready: false,
          runtime: { ready: true },
          connector: { ready: false },
          extension: { ready: false },
          workspace: { valid: true, workspace_id: "workspace-a" },
          conversation: { valid: true, conversation_id: "conversation-a" },
          failure_stage: "connector",
          failure_reason: failureReason,
        });
      }),
    }, { storageRoot: root, identityTrace: trace });

    await pending.accept(input());
    await correlations.observe(evidence(KEY_A, "conversation-a"));
    await waitFor(async () => (await pending.get(KEY_A))?.state === "failed");

    await expect(trace.getIdentityTrace(KEY_A)).resolves.toMatchObject({
      events: [
        { event: "pending_created" },
        { event: "evidence_match_success" },
        {
          event: "goal_start_failed",
          reason: "goal_start_failed",
          failure_stage: "connector",
          failure_reason_hash: identityHash(failureReason),
        },
      ],
    });
    const contents = await readFile(trace.file, "utf8");
    expect(contents).not.toContain(failureReason);
  });

  it("records a blocked Desktop pipe capability as a queryable desktop failure", async () => {
    const root = await makeRoot("local-review-mcp-identity-trace-desktop-");
    const trace = new IdentityTraceService(root);
    const correlations = new ConversationCorrelationRegistry(root);
    const failureReason =
      "desktop_tools_pipe_unavailable: no verified handoff and no host CODEX_APP_TOOLS_PIPE_PATH.";
    const pending = new PendingGoalSubmissionService(correlations, {
      submitGoal: vi.fn(async () => {
        throw new GoalPreflightError({
          ready: false,
          runtime: { ready: true },
          connector: { ready: false },
          extension: { ready: false },
          workspace: { valid: true, workspace_id: "workspace-a" },
          conversation: { valid: true, conversation_id: "conversation-a" },
          desktop: { ready: false, reason: "desktop_tools_pipe_unavailable" },
          failure_stage: "desktop",
          failure_reason: failureReason,
        });
      }),
    }, { storageRoot: root, identityTrace: trace });

    await pending.accept(input());
    await correlations.observe(evidence(KEY_A, "conversation-a"));
    await waitFor(async () => (await pending.get(KEY_A))?.state === "failed");

    await expect(trace.getIdentityTrace(KEY_A)).resolves.toMatchObject({
      events: [
        { event: "pending_created" },
        { event: "evidence_match_success" },
        {
          event: "goal_start_failed",
          reason: "goal_start_failed",
          failure_stage: "desktop",
          failure_reason_hash: identityHash(failureReason),
        },
      ],
    });
    // The blocked capability stays queryable on the durable pending submission too.
    await expect(pending.get(KEY_A)).resolves.toMatchObject({
      state: "failed",
      preflight: {
        failure_stage: "desktop",
        desktop: { ready: false, reason: "desktop_tools_pipe_unavailable" },
      },
    });
    const contents = await readFile(trace.file, "utf8");
    expect(contents).not.toContain(failureReason);
  });
});
