import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationCorrelationRegistry,
} from "../../src/control-plane/conversation-correlation.js";
import {
  extensionIdentityEvidenceSchema,
} from "../../src/control-plane/extension-identity.js";
import {
  PendingGoalSubmissionService,
  pendingGoalSubmissionStateFile,
  PENDING_GOAL_SUBMISSION_TTL_MS,
  type PendingGoalSubmissionInput,
} from "../../src/control-plane/pending-goal-submission.js";
import {
  createMcpServer,
} from "../../src/mcp/server.js";
import type {
  GoalSubmissionRequest,
  GoalSubmissionResult,
} from "../../src/control-plane/goal-submission.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const clients: Client[] = [];
const temporaryDirectories: string[] = [];
const CORRELATION_A = "00000000-0000-4000-8000-000000000001";
const CORRELATION_B = "00000000-0000-4000-8000-000000000002";

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

function goalArguments(correlation_key = CORRELATION_A) {
  return {
    correlation_key,
    title: "MCP Goal",
    goal: "Run the requested Goal through Codex.",
    requirements: ["Use the existing Goal workflow."],
    acceptance_criteria: ["The Goal workflow starts."],
    max_iterations: 2,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for pending Goal submission");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(options: { readonly now?: () => number } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-submit-goal-workspace-"));
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-submit-goal-state-"));
  temporaryDirectories.push(workspace, storageRoot);
  const registry = WorkspaceRegistry.fromManager(new WorkspaceManager(workspace));
  const correlations = new ConversationCorrelationRegistry(storageRoot);
  const submitGoal = vi.fn(async (request: GoalSubmissionRequest): Promise<GoalSubmissionResult> => ({
    goal_id: `goal-${request.conversation_id}`,
    phase_id: "phase-1",
    task_id: "task-1",
    execution_id: "execution-1",
    status: "running",
  }));
  const pending = new PendingGoalSubmissionService(correlations, { submitGoal }, {
    storageRoot,
    now: options.now,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    registry,
    correlations,
    pendingGoalSubmission: pending,
  });
  const client = new Client({ name: "submit-goal-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    correlations,
    pending,
    submitGoal,
    storageRoot,
    workspaceId: registry.active.id,
  };
}

function callFor(
  client: Client,
  arguments_: Record<string, unknown> = goalArguments(),
) {
  return client.callTool({ name: "submit_goal", arguments: arguments_ });
}

function toolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || typeof content[0] !== "object" || content[0] === null
    || typeof (content[0] as { text?: unknown }).text !== "string") {
    throw new Error("tool did not return text content");
  }
  return JSON.parse((content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("submit_goal MCP tool", () => {
  it("durably accepts without correlation and does not start a Goal", async () => {
    const { client, pending, submitGoal, storageRoot } = await fixture();

    const result = await callFor(client);

    expect(result.isError).not.toBe(true);
    expect(toolJson(result)).toMatchObject({ accepted: true, correlation_key: CORRELATION_A });
    expect(submitGoal).not.toHaveBeenCalled();
    expect((await pending.get(CORRELATION_A))?.state).toBe("pending_identity");
    await expect(readFile(pendingGoalSubmissionStateFile(storageRoot), "utf8"))
      .resolves.toContain(CORRELATION_A);
  });

  it("preserves interactive execution mode through the pending identity gate", async () => {
    const { client, correlations, pending, submitGoal, workspaceId } = await fixture();

    await callFor(client, {
      ...goalArguments(),
      execution_mode: "interactive",
    });
    expect((await pending.get(CORRELATION_A))?.execution_mode).toBe("interactive");

    await correlations.observe(evidence(CORRELATION_A, "conversation-interactive"));
    pending.scheduleResolve(CORRELATION_A);
    await waitFor(() => submitGoal.mock.calls.length === 1);
    await waitFor(async () => (await pending.get(CORRELATION_A))?.state === "started");

    expect(submitGoal).toHaveBeenCalledWith(expect.objectContaining({
      execution_mode: "interactive",
    }));
  });

  it("consumes a pending submission after late canonical evidence", async () => {
    const { client, correlations, pending, submitGoal, workspaceId } = await fixture();

    await callFor(client);
    await correlations.observe(evidence(CORRELATION_A, "conversation-A"));
    pending.scheduleResolve(CORRELATION_A);
    await waitFor(() => submitGoal.mock.calls.length === 1);
    await waitFor(async () => (await pending.get(CORRELATION_A))?.state === "started");

    expect(submitGoal).toHaveBeenCalledWith({
      workspace_id: workspaceId,
      conversation_id: "conversation-A",
      title: "MCP Goal",
      goal: "Run the requested Goal through Codex.",
      requirements: ["Use the existing Goal workflow."],
      acceptance_criteria: ["The Goal workflow starts."],
      max_iterations: 2,
    });
    expect((await pending.get(CORRELATION_A))?.state).toBe("started");
  });

  it("rejects WEB provisional identity before consuming the later canonical identity", async () => {
    const { client, correlations, pending, submitGoal } = await fixture();

    await callFor(client);

    const provisional = evidence(CORRELATION_A, "WEB:temporary-id");
    expect(extensionIdentityEvidenceSchema.safeParse(provisional).success).toBe(false);
    await expect(correlations.observe(provisional as never)).rejects.toThrow();
    expect(correlations.correlation(CORRELATION_A)).toBeNull();
    expect((await pending.get(CORRELATION_A))?.state).toBe("pending_identity");
    expect(submitGoal).not.toHaveBeenCalled();

    await expect(correlations.observe(evidence(CORRELATION_A, "conversation-A")))
      .resolves.toBe("stored");
    pending.scheduleResolve(CORRELATION_A);
    await waitFor(() => submitGoal.mock.calls.length === 1);
    await waitFor(async () => (await pending.get(CORRELATION_A))?.state === "started");

    expect(submitGoal).toHaveBeenCalledTimes(1);
    expect(submitGoal).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: "conversation-A",
    }));
    expect(submitGoal).not.toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: "WEB:temporary-id",
    }));
    expect((await pending.get(CORRELATION_A))?.state).toBe("started");
  });

  it("starts only once when evidence is duplicated", async () => {
    const { correlations, pending, submitGoal, workspaceId } = await fixture();
    await pending.accept({
      ...goalArguments(),
      workspace_id: workspaceId,
    } as PendingGoalSubmissionInput);
    await correlations.observe(evidence(CORRELATION_A, "conversation-A"));
    await correlations.observe(evidence(CORRELATION_A, "conversation-A"));
    pending.scheduleResolve(CORRELATION_A);
    pending.scheduleResolve(CORRELATION_A);
    await waitFor(() => submitGoal.mock.calls.length === 1);
    await waitFor(async () => (await pending.get(CORRELATION_A))?.state === "started");

    expect(submitGoal).toHaveBeenCalledTimes(1);
  });

  it("is idempotent for duplicate submission payloads", async () => {
    const { client, pending, submitGoal } = await fixture();

    const first = await callFor(client);
    const second = await callFor(client);

    expect(toolJson(second)).toEqual(toolJson(first));
    expect(await pending.list()).toHaveLength(1);
    expect(submitGoal).not.toHaveBeenCalled();
  });

  it("rejects the same key with a different payload", async () => {
    const { client, submitGoal } = await fixture();
    await callFor(client);

    const result = await callFor(client, {
      ...goalArguments(),
      goal: "Different Goal payload.",
    });

    expect(result.isError).toBe(true);
    expect(toolJson(result)).toEqual({ error: "CONFLICTING_PENDING_GOAL_SUBMISSION" });
    expect(submitGoal).not.toHaveBeenCalled();
  });

  it("expires pending identity without creating a Goal", async () => {
    let now = Date.now();
    const { client, pending, submitGoal } = await fixture({ now: () => now });
    await callFor(client);

    now += PENDING_GOAL_SUBMISSION_TTL_MS;
    await pending.resolve(CORRELATION_A);

    expect((await pending.get(CORRELATION_A))?.state).toBe("failed");
    expect(submitGoal).not.toHaveBeenCalled();
  });

  it("does not guess a conversation while canonical evidence is missing", async () => {
    const { pending, submitGoal, workspaceId } = await fixture();
    await pending.accept({
      ...goalArguments(CORRELATION_B),
      workspace_id: workspaceId,
    });

    await pending.resolve(CORRELATION_B);

    expect((await pending.get(CORRELATION_B))?.state).toBe("pending_identity");
    expect(submitGoal).not.toHaveBeenCalled();
  });

  it("rejects caller-supplied conversation identity and invalid correlation keys", async () => {
    const { client, submitGoal } = await fixture();

    const callerConversation = await callFor(client, {
      ...goalArguments(),
      conversation_id: "caller-conversation",
    });
    const invalidKey = await callFor(client, {
      ...goalArguments(),
      correlation_key: "00000000-0000-1000-8000-000000000003",
    });

    expect(callerConversation.isError).toBe(true);
    expect(invalidKey.isError).toBe(true);
    expect(submitGoal).not.toHaveBeenCalled();
  });
});
