import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgePort, startBridge, stopBridge } from "../../src/control-plane/bridge.js";
import {
  EVIDENCE_TRANSPORT_EVENT_HEADER,
  EXTENSION_EVIDENCE_CREATED_EVENT,
  LOCAL_CONTROL_BRIDGE_PROTOCOL,
} from "../../src/control-plane/bridge-protocol.js";
import { ConversationCorrelationRegistry } from "../../src/control-plane/conversation-correlation.js";
import {
  EvidenceTransportTraceService,
  evidenceTransportTraceStateFile,
} from "../../src/control-plane/evidence-transport-trace.js";
import type { GoalSubmissionRequest, GoalSubmissionResult } from "../../src/control-plane/goal-submission.js";
import {
  PendingGoalSubmissionService,
} from "../../src/control-plane/pending-goal-submission.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_A = "00000000-0000-4000-8000-000000000001";
const CONVERSATION_A = "conversation-a";
const temporaryDirectories: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await stopBridge();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for evidence transport trace");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function request(
  path: string,
  options: {
    readonly method?: string;
    readonly token?: string;
    readonly body?: unknown;
    readonly extensionEvidenceCreated?: boolean;
  } = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  const port = bridgePort();
  if (port === null) throw new Error("Bridge is not listening");
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    ["x-lrm-bridge-protocol"]: String(LOCAL_CONTROL_BRIDGE_PROTOCOL),
  };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.extensionEvidenceCreated === true) {
    headers[EVIDENCE_TRANSPORT_EVENT_HEADER] = EXTENSION_EVIDENCE_CREATED_EVENT;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

async function pair(): Promise<string> {
  const result = await request("/pair", { method: "POST", body: {} });
  if (result.status !== 200 || !result.body || typeof result.body !== "object"
    || typeof (result.body as { token?: unknown }).token !== "string") {
    throw new Error("Bridge pairing failed");
  }
  return (result.body as { token: string }).token;
}

function evidence() {
  return {
    request_id: KEY_A,
    conversation_id: CONVERSATION_A,
    document_id: "document-a",
    navigation_epoch: 1,
  };
}

function input() {
  return {
    correlation_key: KEY_A,
    workspace_id: "workspace-a",
    title: "Trace Goal",
    goal: "Trace the evidence transport.",
    requirements: ["Keep identity validation unchanged."],
    acceptance_criteria: ["Every transport boundary is observable."],
    max_iterations: 1,
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

describe("EvidenceTransportTraceService", () => {
  it("traces extension, Bridge, connector, and resolver order without storing identity plaintext", async () => {
    const root = await makeRoot("local-review-mcp-evidence-transport-normal-");
    const trace = new EvidenceTransportTraceService(root);
    const correlations = new ConversationCorrelationRegistry(root);
    const pending = new PendingGoalSubmissionService(correlations, {
      submitGoal: vi.fn(async (request: GoalSubmissionRequest) => result(request)),
    }, {
      storageRoot: root,
      evidenceTransportTrace: trace,
    });
    await pending.accept(input());

    await startBridge({
      ports: [0],
      evidenceTransportTrace: trace,
      onIdentityEvidence: async (received) => {
        trace.record({
          event: "connector_evidence_received",
          correlation_key: received.request_id,
          conversation_id: received.conversation_id,
        });
        trace.record({
          event: "extension_evidence_received",
          correlation_key: received.request_id,
          conversation_id: received.conversation_id,
        });
        const observation = await correlations.observe(received);
        if (observation !== "refused") pending.scheduleResolve(received.request_id);
      },
    });
    const token = await pair();
    const posted = await request("/identity-evidence", {
      method: "POST",
      token,
      body: evidence(),
      extensionEvidenceCreated: true,
    });
    expect(posted).toEqual({ status: 202, body: { accepted: true } });

    await waitFor(async () => (await pending.get(KEY_A))?.state === "started");
    await expect(trace.getEvidenceTransportTrace(KEY_A)).resolves.toEqual({
      events: [
        { event: "extension_evidence_created", timestamp: expect.any(String) },
        { event: "bridge_evidence_received", timestamp: expect.any(String) },
        { event: "bridge_evidence_forwarded", timestamp: expect.any(String) },
        { event: "connector_evidence_received", timestamp: expect.any(String) },
        { event: "extension_evidence_received", timestamp: expect.any(String) },
        { event: "connector_resolve_called", timestamp: expect.any(String) },
        { event: "evidence_resolve_attempted", timestamp: expect.any(String) },
        { event: "evidence_resolve_success", timestamp: expect.any(String) },
      ],
    });

    const contents = await readFile(trace.file, "utf8");
    expect(contents).not.toContain(KEY_A);
    expect(contents).not.toContain(CONVERSATION_A);
    expect(trace.file).toBe(evidenceTransportTraceStateFile(root));
  });

  it("shows an extension-created event with no Bridge event when the Bridge is missing", async () => {
    const root = await makeRoot("local-review-mcp-evidence-transport-missing-bridge-");
    const trace = new EvidenceTransportTraceService(root);
    trace.record({
      event: "extension_evidence_created",
      correlation_key: KEY_A,
      conversation_id: CONVERSATION_A,
    });

    await expect(trace.getEvidenceTransportTrace(KEY_A)).resolves.toEqual({
      events: [{ event: "extension_evidence_created", timestamp: expect.any(String) }],
    });
  });

  it("exposes the trace through a read-only MCP query", async () => {
    const root = await makeRoot("local-review-mcp-evidence-transport-query-");
    const workspace = await makeRoot("local-review-mcp-evidence-transport-query-workspace-");
    const trace = new EvidenceTransportTraceService(root);
    trace.record({ event: "extension_evidence_created", correlation_key: KEY_A, conversation_id: CONVERSATION_A });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      registry: WorkspaceRegistry.fromManager(new WorkspaceManager(workspace)),
      evidenceTransportTrace: trace,
    });
    const client = new Client({ name: "evidence-transport-trace-test", version: "0.1.0" });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "get_evidence_transport_trace",
      arguments: { correlation_key: KEY_A },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      events: [{ event: "extension_evidence_created", timestamp: expect.any(String) }],
    });
  });

  it("records Bridge rejection for schema errors without invoking the connector", async () => {
    const root = await makeRoot("local-review-mcp-evidence-transport-rejected-");
    const trace = new EvidenceTransportTraceService(root);
    const connector = vi.fn();
    await startBridge({ ports: [0], evidenceTransportTrace: trace, onIdentityEvidence: connector });
    const token = await pair();

    const missingConversation = await request("/identity-evidence", {
      method: "POST",
      token,
      body: { request_id: KEY_A, document_id: "document-a", navigation_epoch: 1 },
    });
    expect(missingConversation.status).toBe(400);
    expect(connector).not.toHaveBeenCalled();
    await expect(trace.getEvidenceTransportTrace(KEY_A)).resolves.toMatchObject({
      events: [
        { event: "bridge_evidence_rejected" },
      ],
    });

    const missingCorrelation = await request("/identity-evidence", {
      method: "POST",
      token,
      body: { conversation_id: CONVERSATION_A, document_id: "document-a", navigation_epoch: 1 },
    });
    expect(missingCorrelation.status).toBe(400);
    const contents = await readFile(trace.file, "utf8");
    expect(contents).toContain('"event":"bridge_evidence_rejected"');
    expect(contents).not.toContain(CONVERSATION_A);
  });

});
