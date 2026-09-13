import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GOAL_HANDOFF_PROTOCOL,
  GOAL_HANDOFF_SCHEMA_VERSION,
  GOAL_HANDOFF_TTL_MS,
  GoalHandoffService,
  goalHandoffInputSchema,
  type GoalHandoffEnvelopeV2,
} from "../../src/control-plane/goal-handoff.js";
import { ConversationCorrelationRegistry } from "../../src/control-plane/conversation-correlation.js";
import type {
  GoalSubmissionRequest,
  GoalSubmissionResult,
} from "../../src/control-plane/goal-submission.js";
import { withInboundRequestId } from "../../src/mcp/inbound.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const clients: Client[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
    goal: "Prepare the requested Goal for Codex.",
    requirements: ["Use the existing Goal workflow."],
    acceptance_criteria: ["The handoff is complete and verifiable."],
  };
}

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(root, path));
    }
  }
  await visit(root);
  return files.sort();
}

async function fixture(withCorrelations = false) {
  const workspaceA = await mkdtemp(join(tmpdir(), "local-review-mcp-goal-handoff-a-"));
  const workspaceB = await mkdtemp(join(tmpdir(), "local-review-mcp-goal-handoff-b-"));
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-goal-handoff-state-"));
  temporaryDirectories.push(workspaceA, workspaceB, storageRoot);
  const registry = new WorkspaceRegistry([
    { id: "workspace-a", name: "Workspace A", path: workspaceA },
    { id: "workspace-b", name: "Workspace B", path: workspaceB },
  ], { activeWorkspaceId: "workspace-a" });
  const correlations = withCorrelations === true
    ? new ConversationCorrelationRegistry(storageRoot)
    : undefined;
  const goalHandoff = new GoalHandoffService();
  const submitGoal = vi.fn(async (request: GoalSubmissionRequest): Promise<GoalSubmissionResult> => ({
    goal_id: `goal-${request.conversation_id}`,
    phase_id: "phase-1",
    task_id: "task-1",
    execution_id: "execution-1",
    status: "running",
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    registry,
    correlations,
    goalHandoff,
    goalSubmission: { submitGoal },
  });
  const client = new Client({ name: "goal-handoff-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, correlations, goalHandoff, submitGoal, registry, storageRoot };
}

function callFor(
  client: Client,
  requestId: string,
  arguments_: Record<string, unknown> = goalArguments(),
) {
  return withInboundRequestId(requestId, () => client.callTool({
    name: "prepare_goal_handoff",
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

describe("prepare_goal_handoff MCP tool", () => {
  it("returns a complete signed envelope without conversation correlation", async () => {
    const { client, goalHandoff } = await fixture();

    const result = await callFor(client, "request-A");
    const envelope = toolJson(result) as unknown as GoalHandoffEnvelopeV2;

    expect(result.isError).not.toBe(true);
    expect(envelope).toMatchObject({
      protocol: GOAL_HANDOFF_PROTOCOL,
      schema_version: GOAL_HANDOFF_SCHEMA_VERSION,
      request_id: "request-A",
      workspace_id: "workspace-a",
      goal: { ...goalArguments(), max_iterations: 2 },
    });
    expect(envelope.schema_version).toBe("2");
    expect(envelope).not.toHaveProperty("conversation_id");
    expect(envelope.handoff_id).toMatch(/^handoff-/u);
    expect(Date.parse(envelope.expires_at) - Date.parse(envelope.issued_at))
      .toBe(GOAL_HANDOFF_TTL_MS);
    expect(goalHandoff.verifyGoalHandoffEnvelope(envelope)).toBe(true);
  });

  it("ignores a mismatched existing conversation correlation", async () => {
    const { client, correlations } = await fixture(true);
    if (correlations === undefined) throw new Error("correlation fixture is unavailable");
    await correlations.observe(evidence("fiber-request-B", "conversation-X"));
    const lookup = vi.spyOn(correlations, "correlation");
    const wait = vi.spyOn(correlations, "awaitCorrelation");

    const result = await callFor(client, "http-request-A");
    const envelope = toolJson(result) as unknown as GoalHandoffEnvelopeV2;

    expect(result.isError).not.toBe(true);
    expect(envelope).toMatchObject({
      request_id: "http-request-A",
      workspace_id: "workspace-a",
    });
    expect(envelope).not.toHaveProperty("conversation_id");
    expect(lookup).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("fails closed for an unknown workspace without generating a handoff", async () => {
    const { client, goalHandoff } = await fixture();
    const prepare = vi.spyOn(goalHandoff, "prepareGoalHandoff");

    const result = await callFor(client, "request-A", {
      ...goalArguments(),
      workspace_id: "workspace-missing",
    });

    expect(result.isError).toBe(true);
    expect(toolJson(result)).toEqual({
      error: "UNKNOWN_WORKSPACE_ID",
      message: "Unknown workspace_id",
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("fails closed when the inbound MCP request trace is missing", async () => {
    const { client, goalHandoff } = await fixture();
    const prepare = vi.spyOn(goalHandoff, "prepareGoalHandoff");

    const result = await client.callTool({
      name: "prepare_goal_handoff",
      arguments: goalArguments(),
    });

    expect(result.isError).toBe(true);
    expect(toolJson(result)).toEqual({ error: "INTERNAL_ERROR" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps concurrent calls bound to their own MCP request traces", async () => {
    const { client } = await fixture();

    const results = await Promise.all([
      callFor(client, "request-A"),
      callFor(client, "request-B"),
    ]);

    expect(results.map((result) => toolJson(result).request_id).sort())
      .toEqual(["request-A", "request-B"]);
  });

  it("resolves the selected workspace identity", async () => {
    const { client } = await fixture();

    const selected = await callFor(client, "request-A", {
      ...goalArguments(),
      workspace_id: "workspace-b",
    });
    expect(toolJson(selected)).toMatchObject({ workspace_id: "workspace-b" });
  });

  it("rejects model-supplied identity fields", () => {
    expect(goalHandoffInputSchema.safeParse({
      ...goalArguments(),
      conversation_id: "model-supplied-conversation",
    }).success).toBe(false);
    expect(goalHandoffInputSchema.safeParse({
      ...goalArguments(),
      request_id: "model-supplied-request",
    }).success).toBe(false);
    expect(goalHandoffInputSchema.safeParse({
      ...goalArguments(),
      handoff_id: "model-supplied-handoff",
    }).success).toBe(false);
    expect(goalHandoffInputSchema.safeParse({
      ...goalArguments(),
      signature: "0".repeat(64),
    }).success).toBe(false);
  });

  it("uses the existing Goal schema constraints and default max_iterations", () => {
    const valid = goalHandoffInputSchema.parse(goalArguments());
    expect(valid.max_iterations).toBe(2);
    expect(goalHandoffInputSchema.safeParse({ ...goalArguments(), requirements: [] }).success).toBe(false);
    expect(goalHandoffInputSchema.safeParse({
      ...goalArguments(),
      title: "x".repeat(16_001),
    }).success).toBe(false);
    expect(goalHandoffInputSchema.safeParse({ ...goalArguments(), max_iterations: 0 }).success).toBe(false);
  });

  it("generates unique handoff ids", async () => {
    const { goalHandoff } = await fixture();
    const input = {
      ...goalArguments(),
      request_id: "request-A",
      workspace_id: "workspace-a",
    } as const;

    const first = goalHandoff.prepareGoalHandoff(input);
    const second = goalHandoff.prepareGoalHandoff(input);

    expect(first.handoff_id).not.toBe(second.handoff_id);
  });

  it("rejects any signed-field mutation and preserves read-only state", async () => {
    const { client, goalHandoff, submitGoal, storageRoot } = await fixture();
    const before = await filesUnder(storageRoot);
    const result = await callFor(client, "request-A");
    const envelope = toolJson(result) as unknown as GoalHandoffEnvelopeV2;

    expect(goalHandoff.verifyGoalHandoffEnvelope(envelope)).toBe(true);
    expect(goalHandoff.verifyGoalHandoffEnvelope({
      ...envelope,
      goal: { ...envelope.goal, goal: "changed" },
    })).toBe(false);
    expect(goalHandoff.verifyGoalHandoffEnvelope({
      ...envelope,
      workspace_id: "workspace-b",
    })).toBe(false);
    expect(goalHandoff.verifyGoalHandoffEnvelope({
      ...envelope,
      request_id: "request-B",
    })).toBe(false);
    expect(goalHandoff.verifyGoalHandoffEnvelope({
      ...envelope,
      handoff_id: "handoff-other",
    })).toBe(false);
    expect(goalHandoff.verifyGoalHandoffEnvelope({
      ...envelope,
      issued_at: new Date(Date.parse(envelope.issued_at) + 1_000).toISOString(),
    })).toBe(false);
    expect(goalHandoff.verifyGoalHandoffEnvelope({
      ...envelope,
      expires_at: new Date(Date.parse(envelope.expires_at) + 1_000).toISOString(),
    })).toBe(false);

    expect(submitGoal).not.toHaveBeenCalled();
    expect(await filesUnder(storageRoot)).toEqual(before);
    expect(await filesUnder(storageRoot)).not.toContain("control-plane/goal-orchestrations.json");
  });

  it("advertises the tool as read-only with the handoff contract", async () => {
    const { client } = await fixture();
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === "prepare_goal_handoff");

    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(tool?.description).toContain("does not create or start a Goal");
    expect(tool?.inputSchema).not.toHaveProperty("properties.conversation_id");
    expect(tool?.outputSchema).toMatchObject({
      properties: {
        protocol: expect.any(Object),
        schema_version: expect.any(Object),
        handoff_id: expect.any(Object),
        request_id: expect.any(Object),
        workspace_id: expect.any(Object),
        goal: expect.any(Object),
        issued_at: expect.any(Object),
        expires_at: expect.any(Object),
        signature: expect.any(Object),
      },
    });
    expect(tool?.outputSchema).not.toHaveProperty("properties.conversation_id");
  });
});
