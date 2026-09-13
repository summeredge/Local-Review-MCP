import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationCorrelationRegistry,
} from "../../src/control-plane/conversation-correlation.js";
import {
  GOAL_SUBMISSION_CORRELATION_TIMEOUT_MS,
  createMcpServer,
} from "../../src/mcp/server.js";
import { withInboundRequestId } from "../../src/mcp/inbound.js";
import type {
  GoalSubmissionRequest,
  GoalSubmissionResult,
} from "../../src/control-plane/goal-submission.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const clients: Client[] = [];
const temporaryDirectories: string[] = [];

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

function goalArguments() {
  return {
    title: "MCP Goal",
    goal: "Run the requested Goal through Codex.",
    requirements: ["Use the existing Goal workflow."],
    acceptance_criteria: ["The Goal workflow starts."],
    max_iterations: 2,
  };
}

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-submit-goal-"));
  temporaryDirectories.push(workspace);
  const registry = WorkspaceRegistry.fromManager(new WorkspaceManager(workspace));
  const correlations = new ConversationCorrelationRegistry(workspace);
  const submitGoal = vi.fn(async (request: GoalSubmissionRequest): Promise<GoalSubmissionResult> => ({
    goal_id: `goal-${request.conversation_id}`,
    phase_id: "phase-1",
    task_id: "task-1",
    execution_id: "execution-1",
    status: "running",
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ registry, correlations, goalSubmission: { submitGoal } });
  const client = new Client({ name: "submit-goal-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, correlations, submitGoal, workspaceId: registry.active.id };
}

function callFor(
  client: Client,
  requestId: string,
  arguments_: Record<string, unknown> = goalArguments(),
) {
  return withInboundRequestId(requestId, () => client.callTool({
    name: "submit_goal",
    arguments: arguments_,
  }));
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
  it("binds an existing exact correlation and reuses GoalSubmissionService", async () => {
    const { client, correlations, submitGoal, workspaceId } = await fixture();
    await correlations.observe(evidence("request-A", "conversation-A"));

    const result = await callFor(client, "request-A");

    expect(result.isError).not.toBe(true);
    expect(toolJson(result)).toEqual({
      goal_id: "goal-conversation-A",
      phase_id: "phase-1",
      task_id: "task-1",
      execution_id: "execution-1",
      status: "running",
    });
    expect(submitGoal).toHaveBeenCalledWith({
      ...goalArguments(),
      workspace_id: workspaceId,
      conversation_id: "conversation-A",
    });
  });

  it("waits for late evidence for the same exact request id", async () => {
    const { client, correlations, submitGoal } = await fixture();
    const pending = callFor(client, "request-A");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(submitGoal).not.toHaveBeenCalled();

    await correlations.observe(evidence("request-A", "conversation-A"));
    const result = await pending;
    expect(result.isError).not.toBe(true);
    expect(submitGoal).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: "conversation-A",
    }));
  });

  it("fails closed when the current request remains uncorrelated", async () => {
    const { client, correlations, submitGoal } = await fixture();
    await correlations.observe(evidence("request-B", "conversation-B"));
    const wait = vi.spyOn(correlations, "awaitCorrelation").mockResolvedValue(null);

    const result = await callFor(client, "request-A");

    expect(result.isError).toBe(true);
    expect(toolJson(result)).toEqual({ error: "conversation_not_correlated" });
    expect(wait).toHaveBeenCalledWith("request-A", GOAL_SUBMISSION_CORRELATION_TIMEOUT_MS);
    expect(submitGoal).not.toHaveBeenCalled();
  });

  it("keeps concurrent calls bound to their own conversations", async () => {
    const { client, correlations, submitGoal } = await fixture();
    await correlations.observe(evidence("request-A", "conversation-A"));
    await correlations.observe(evidence("request-B", "conversation-B"));

    await Promise.all([
      callFor(client, "request-A"),
      callFor(client, "request-B"),
    ]);

    expect(submitGoal.mock.calls.map(([request]) => request.conversation_id).sort())
      .toEqual(["conversation-A", "conversation-B"]);
  });

  it("keeps the first proven owner when conflicting evidence arrives", async () => {
    const { client, correlations, submitGoal } = await fixture();
    await correlations.observe(evidence("request-A", "conversation-A"));
    await expect(correlations.observe(evidence("request-A", "conversation-B"))).resolves.toBe("refused");

    await callFor(client, "request-A");

    expect(submitGoal).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: "conversation-A",
    }));
    expect(submitGoal).not.toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: "conversation-B",
    }));
  });
});
