import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AutoIterationService, AutoIterationStore, autoIterationSchema } from "../../src/control-plane/auto-iteration.js";
import { ExtensionDeliveryService } from "../../src/control-plane/extension-delivery.js";
import { ReviewVerdictSubmissionService, REVIEW_VERDICT_CONFIRMATION_TIMEOUT_MS, submitReviewVerdictInputSchema } from "../../src/control-plane/review-verdict-submission.js";
import { ControlledActuationService, ActuationAuthorizationStore } from "../../src/control-plane/controlled-actuation.js";
import { TaskContextService } from "../../src/context/service.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { ReviewRequestService } from "../../src/context/review-request-service.js";
import { reviewRequestFile } from "../../src/context/review-request.js";
import { ConversationRoutingService } from "../../src/context/conversation-routing-service.js";
import { ReviewDeliveryService } from "../../src/context/review-delivery-service.js";
import { ReviewResultService } from "../../src/context/review-result-service.js";
import { reviewResultFile } from "../../src/context/review-result.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { buildReviewMessage } from "../../src/delivery/review-message.js";
import { createAppContext, startApp } from "../../src/app.js";
import { bridgePort, stopBridge } from "../../src/control-plane/bridge.js";
import { LOCAL_CONTROL_BRIDGE_PROTOCOL } from "../../src/control-plane/bridge-protocol.js";
import type { ResolvedSettings } from "../../src/config/settings.js";

const roots: string[] = [];
const autos: AutoIterationService[] = [];
const clients: Client[] = [];
const proof = { source: "authenticated_mcp_invocation" } as const;
const owner = { client_id: "client-a", document_id: "document-a", navigation_epoch: 1, conversation_id: "conversation-a" };
const key = "00000000-0000-4000-8000-000000000001";

afterEach(async () => {
  autos.splice(0).forEach((auto) => auto.dispose());
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await stopBridge();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(decision: "APPROVE" | "ITERATE" | "HUMAN_REQUIRED" = "APPROVE", maxIterations = 2) {
  const root = await mkdtemp(join(tmpdir(), "lrm-tool-verdict-"));
  roots.push(root);
  await mkdir(join(root, "b"));
  const registry = new WorkspaceRegistry([{ id: "workspace-a", name: "A", path: root }, { id: "workspace-b", name: "B", path: join(root, "b") }]);
  await new TaskContextService(root).createTaskContext({ task_id: "task-a", workspace_id: "workspace-a", status: "reviewing" });
  const executions = new ExecutionContextService(root);
  await executions.createExecutionContext({ execution_id: "execution-a", task_id: "task-a", workspace_id: "workspace-a", status: "passed" });
  const request = await new ReviewRequestService(root).createReviewRequest({ review_request_id: "review-a", task_id: "task-a", execution_id: "execution-a", workspace_id: "workspace-a", conversation_id: owner.conversation_id, verdict_protocol: "tool_v1" });
  const routing = await new ConversationRoutingService(root).createRouting({ routing_id: "routing-a", workspace_id: request.workspace_id, task_id: request.task_id, execution_id: request.execution_id, review_request_id: request.review_request_id, conversation_id: owner.conversation_id });
  const deliveries = new ReviewDeliveryService(root);
  const delivery = await deliveries.createDelivery({ delivery_id: "delivery-a", routing_id: routing.routing_id, workspace_id: request.workspace_id, task_id: request.task_id, review_request_id: request.review_request_id, conversation_id: owner.conversation_id });
  await deliveries.beginDeliveryAttempt(request.workspace_id, delivery.delivery_id);
  await deliveries.markDelivered(request.workspace_id, delivery.delivery_id);
  const extension = new ExtensionDeliveryService(root);
  const physical = await extension.enqueue(owner.conversation_id, "review", delivery.delivery_id);
  await extension.claim(owner);
  await extension.acknowledge({ ...owner, delivery_id: physical.delivery_id, status: "sent", message_id: "user-a" });
  const store = new AutoIterationStore(root);
  await store.put(autoIterationSchema.parse({ loop_id: "loop-a", initial_execution_id: "execution-a", workspace_id: request.workspace_id, task_id: request.task_id, conversation_id: owner.conversation_id, max_iterations: maxIterations, iteration: 1, execution_id: request.execution_id, review_request_id: request.review_request_id, routing_id: routing.routing_id, delivery_id: delivery.delivery_id, stage: "review_completion", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }));
  const results = new ReviewResultService(root);
  const collect = vi.fn(async () => results.createReviewResult({ workspace_id: request.workspace_id, task_id: request.task_id, review_request_id: request.review_request_id, delivery_id: delivery.delivery_id, status: "COMPLETED", content: "普通审查报告，无任何 Verdict 文本标记。" }));
  const start = vi.fn(async (input: { workspace_id: string; task_id: string; execution_id: string }) => {
    const execution = await executions.createExecutionContext({ workspace_id: input.workspace_id, task_id: input.task_id, execution_id: input.execution_id, process_id: 1234, command: "codex exec" });
    return { execution_id: execution.execution_id, process_id: 1234, started_at: execution.started_at, accepted: "new" as const };
  });
  // The production authorization boundary is exercised even though the Codex process is a test double.
  const controlled = new ControlledActuationService(registry, { storageRoot: root, adapter: { start } });
  await new ActuationAuthorizationStore(root).createAuthorization({ actuation_id: "initial", workspace_id: request.workspace_id, task_id: request.task_id, execution_id: request.execution_id, instruction: "initial", execution_mode: "batch" });
  const options = { storageRoot: root, extensionDeliveries: extension, completionRouter: { collect }, controlledActuation: controlled };
  const auto = new AutoIterationService(registry, options);
  autos.push(auto);
  const input = submitReviewVerdictInputSchema.parse({ workspace_id: request.workspace_id, correlation_key: key, verdict: { schema_version: 1, review_request_id: request.review_request_id, decision, summary: "最终审查结论", ...(decision === "ITERATE" ? { iteration: { goal: "修复阻断缺陷", requirements: ["修复当前问题"], acceptance_criteria: ["相关回归通过"] } } : {}) } });
  const evidence = { request_id: key, conversation_id: owner.conversation_id, document_id: owner.document_id, navigation_epoch: owner.navigation_epoch, tool_name: "submit_review_verdict" as const, connector: "Local MCP Connector" as const, workspace_id: request.workspace_id, review_request_id: request.review_request_id, expected_user_message_id: "user-a", tool_call_id: "tool-a", verdict: input.verdict };
  return { root, registry, request, routing, delivery, extension, store, auto, options, input, evidence, collect, start, results, service: auto.reviewVerdictSubmission };
}

describe("tool_v1 structured Review Verdict", () => {
  it.each(["APPROVE", "ITERATE", "HUMAN_REQUIRED"] as const)("applies %s through the existing controller only after Completion", async (decision) => {
    const f = await fixture(decision);
    await f.service.accept(f.input, proof);
    await f.service.receiveIdentityEvidence(f.evidence);
    expect(f.collect).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.service.getConfirmed("workspace-a", "review-a")).toEqual(f.input.verdict);
    const loop = await f.auto.advance("loop-a");
    expect(loop.stage).toBe(decision === "APPROVE" ? "completed" : decision === "ITERATE" ? "execution" : "human_required");
    expect(f.start).toHaveBeenCalledTimes(decision === "ITERATE" ? 1 : 0);
    expect(f.collect).toHaveBeenCalledTimes(1);
    expect((await f.results.getReviewResultByRequest("workspace-a", "review-a"))?.content).toBe("普通审查报告，无任何 Verdict 文本标记。");
    const restarted = new AutoIterationService(f.registry, f.options);
    autos.push(restarted);
    await restarted.recover();
    expect(f.start).toHaveBeenCalledTimes(decision === "ITERATE" ? 1 : 0);
    expect(f.collect).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("accepts evidence before/after submission with Completion already waiting (evidenceFirst=%s)", async (evidenceFirst) => {
    const f = await fixture();
    const running = f.auto.advance("loop-a");
    await vi.waitFor(async () => expect((await f.auto.getLoop("loop-a"))?.stage).toBe("verdict"));
    if (evidenceFirst) await f.service.receiveIdentityEvidence(f.evidence);
    else await f.service.accept(f.input, proof);
    expect((await f.auto.getLoop("loop-a"))?.stage).toBe("verdict");
    if (evidenceFirst) await f.service.accept(f.input, proof);
    else await f.service.receiveIdentityEvidence(f.evidence);
    expect((await running).stage).toBe("completed");
  });

  it("restores a pending submission and confirmed evidence without duplicate writes or decisions", async () => {
    const f = await fixture();
    await Promise.all([f.service.accept(f.input, proof), f.service.accept(f.input, proof)]);
    const restored = new ReviewVerdictSubmissionService(f.registry, { storageRoot: f.root, extensionDeliveries: f.extension, listLoops: () => f.auto.listLoops() });
    expect(await restored.getConfirmed("workspace-a", "review-a")).toBeNull();
    await restored.receiveIdentityEvidence(f.evidence);
    const file = join(f.root, "control-plane", "review-verdicts", "workspace-a", "review-a.json");
    const before = await readFile(file, "utf8");
    await restored.receiveIdentityEvidence(f.evidence);
    await restored.accept(f.input, proof);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await new ReviewVerdictSubmissionService(f.registry, { storageRoot: f.root, extensionDeliveries: f.extension, listLoops: () => f.auto.listLoops() }).getConfirmed("workspace-a", "review-a")).toEqual(f.input.verdict);
    await expect(restored.accept({ ...f.input, verdict: { ...f.input.verdict, summary: "冲突" } }, proof)).rejects.toMatchObject({ code: "VERDICT_SUBMISSION_CONFLICT" });
    await expect(restored.receiveIdentityEvidence({ ...f.evidence, tool_call_id: "another-tool" })).rejects.toMatchObject({ code: "VERDICT_EVIDENCE_CONFLICT" });
  });

  it.each([
    { conversation_id: "another-conversation" }, { workspace_id: "workspace-b" },
    { expected_user_message_id: "historical-user" }, { document_id: "another-document" },
    { navigation_epoch: 2 }, { review_request_id: "another-review" },
    { connector: "Another Connector" }, { tool_name: "submit_goal" }, { tool_call_id: undefined },
  ])("refuses mismatched or forged evidence %j", async (patch) => {
    const f = await fixture();
    await f.service.accept(f.input, proof);
    await expect(f.service.receiveIdentityEvidence({ ...f.evidence, ...patch })).rejects.toThrow();
    expect(await f.service.getConfirmed("workspace-a", "review-a")).toBeNull();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("binds the actual tool payload, rather than trusting the correlation key alone", async () => {
    const f = await fixture();
    await f.service.accept(f.input, proof);
    await expect(f.service.receiveIdentityEvidence({ ...f.evidence, verdict: { ...f.evidence.verdict, decision: "HUMAN_REQUIRED" } })).rejects.toMatchObject({ code: "VERDICT_SUBMISSION_CONFLICT" });
    expect(await f.service.getConfirmed("workspace-a", "review-a")).toBeNull();
  });

  it("does not let an unproved call from another conversation reserve the current Review", async () => {
    const f = await fixture();
    const foreign = { ...f.input, correlation_key: "00000000-0000-4000-8000-000000000002", verdict: { ...f.input.verdict, decision: "HUMAN_REQUIRED" as const, summary: "unauthorized pending call" } };
    await f.service.accept(foreign, proof);
    await expect(f.service.receiveIdentityEvidence({ ...f.evidence, request_id: foreign.correlation_key, conversation_id: "foreign-conversation", verdict: foreign.verdict })).rejects.toThrow();
    await f.service.accept(f.input, proof);
    expect(await f.service.getConfirmed("workspace-a", "review-a")).toBeNull();
    await f.service.receiveIdentityEvidence(f.evidence);
    expect((await f.auto.advance("loop-a")).stage).toBe("completed");
    await expect(f.service.accept({ ...f.input, correlation_key: "00000000-0000-4000-8000-000000000003" }, proof)).rejects.toMatchObject({ code: "VERDICT_SUBMISSION_CONFLICT" });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("keeps an unmatched correlation unconfirmed and recovers evidence before its matching MCP call", async () => {
    const f = await fixture();
    const otherKey = "00000000-0000-4000-8000-000000000002";
    await f.service.accept(f.input, proof);
    await f.service.receiveIdentityEvidence({ ...f.evidence, request_id: otherKey });
    expect(await f.service.getConfirmed("workspace-a", "review-a")).toBeNull();
    expect(await f.service.confirmationDiagnostic("workspace-a", "review-a")).toBe("TOOL_VERDICT_CONFIRMATION_TIMEOUT");
    await f.service.accept({ ...f.input, correlation_key: otherKey }, proof);
    expect((await f.auto.advance("loop-a")).stage).toBe("completed");
  });

  it("uses the persisted Completion deadline even when evidence arrives over 120 seconds after tool receipt", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const f = await fixture();
    await f.service.accept(f.input, proof);
    await vi.advanceTimersByTimeAsync(60_000);
    const running = f.auto.advance("loop-a");
    await vi.waitFor(async () => expect((await f.auto.getLoop("loop-a"))?.stage).toBe("verdict"));
    await vi.advanceTimersByTimeAsync(61_000);
    await f.service.receiveIdentityEvidence(f.evidence);
    expect((await running).stage).toBe("completed");
  });

  it("rejects unauthenticated, unknown-field, blank-summary and invalid iteration submissions", async () => {
    const f = await fixture();
    await expect(f.service.accept(f.input)).rejects.toMatchObject({ code: "VERDICT_AUTHENTICATION_REQUIRED" });
    for (const verdict of [{ ...f.input.verdict, summary: " " }, { ...f.input.verdict, unknown: true }, { ...f.input.verdict, decision: "ITERATE" }, { ...f.input.verdict, iteration: { goal: "x", requirements: ["x"], acceptance_criteria: ["x"] } }]) {
      expect(submitReviewVerdictInputSchema.safeParse({ ...f.input, verdict }).success).toBe(false);
    }
    await expect(f.service.accept({ ...f.input, workspace_id: "workspace-b" }, proof)).rejects.toThrow();
  });

  it.each([false, true])("times out without a second Review or prose APPROVE (pendingSubmission=%s)", async (pendingSubmission) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const f = await fixture();
    if (pendingSubmission) await f.service.accept(f.input, proof);
    const running = f.auto.advance("loop-a");
    await vi.waitFor(async () => expect((await f.auto.getLoop("loop-a"))?.stage).toBe("verdict"));
    await vi.advanceTimersByTimeAsync(REVIEW_VERDICT_CONFIRMATION_TIMEOUT_MS + 1);
    const loop = await running;
    expect(loop).toMatchObject({ stage: "human_required", terminal_reason: "VERDICT_CONFIRMATION_TIMEOUT" });
    expect(loop.terminal_summary).toContain(pendingSubmission ? "TOOL_VERDICT_IDENTITY_UNCONFIRMED" : "TOOL_VERDICT_NOT_SUBMITTED");
    expect(loop.terminal_summary).toContain("TOOL_VERDICT_CONFIRMATION_TIMEOUT");
    expect(loop.verdict_recovery).toBeUndefined();
    expect(await new ReviewRequestService(f.root).listReviewRequests("workspace-a")).toHaveLength(1);
    expect(f.collect).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
    await expect(f.service.receiveIdentityEvidence(f.evidence)).rejects.toThrow();
  });

  it("recovers the Completion deadline after restart without extending it or dispatching", async () => {
    const f = await fixture();
    const result = await f.collect();
    await writeFile(reviewResultFile(f.root, "workspace-a", result.result_id), JSON.stringify({ ...result, created_at: new Date(Date.now() - REVIEW_VERDICT_CONFIRMATION_TIMEOUT_MS - 1).toISOString() }));
    await f.store.put({ ...(await f.store.get("loop-a"))!, stage: "verdict", review_result_id: result.result_id });
    await f.auto.recover();
    expect((await f.auto.getLoop("loop-a"))?.terminal_reason).toBe("VERDICT_CONFIRMATION_TIMEOUT");
    expect(f.collect).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("preserves the maximum iteration limit", async () => {
    const f = await fixture("ITERATE", 1);
    await f.service.accept(f.input, proof);
    await f.service.receiveIdentityEvidence(f.evidence);
    expect(await f.auto.advance("loop-a")).toMatchObject({ stage: "human_required", terminal_reason: "MAX_ITERATIONS_REACHED" });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("cancels the bounded wait on shutdown and resumes the same checkpoint after restart", async () => {
    const f = await fixture();
    const running = f.auto.advance("loop-a");
    await vi.waitFor(async () => expect((await f.auto.getLoop("loop-a"))?.stage).toBe("verdict"));
    f.auto.dispose();
    expect((await running).stage).toBe("verdict");
    const restarted = new AutoIterationService(f.registry, f.options);
    autos.push(restarted);
    await restarted.reviewVerdictSubmission.accept(f.input, proof);
    await restarted.reviewVerdictSubmission.receiveIdentityEvidence(f.evidence);
    await restarted.recover();
    expect((await restarted.getLoop("loop-a"))?.stage).toBe("completed");
    expect(f.collect).toHaveBeenCalledTimes(1);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("routes complete evidence through the authenticated app Bridge without feeding submit_goal identity", async () => {
    const f = await fixture();
    const workspace = { id: "workspace-a", name: "A", path: f.root };
    const settings: ResolvedSettings = { host: "127.0.0.1", port: 0, workspace: f.root, workspaceIdentity: workspace, workspaces: [workspace], auth: { token: "mcp-test" }, remote: { enabled: false, endpoint: "" }, supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 } };
    const runtime = createAppContext(settings, { ...process.env, LOCALAPPDATA: f.root, XDG_STATE_HOME: f.root });
    const goalEvidence = vi.spyOn(runtime.pendingGoalSubmission!, "receiveIdentityEvidence");
    vi.spyOn(f.auto, "recover").mockResolvedValue();
    const server = await startApp(settings, { ...runtime, autoIteration: f.auto, reviewVerdictSubmission: f.service, extensionDeliveries: f.extension }, { bridgePorts: [0], silent: true });
    const headers = { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "x-lrm-bridge-protocol": String(LOCAL_CONTROL_BRIDGE_PROTOCOL), "content-type": "application/json" };
    const post = (path: string, body: unknown, token?: string) => fetch(`http://127.0.0.1:${bridgePort()}${path}`, { method: "POST", headers: { ...headers, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
    try {
      await f.service.accept(f.input, proof);
      expect((await post("/identity-evidence", f.evidence)).status).toBe(403);
      const paired = await post("/pair", {});
      const { token } = await paired.json() as { token: string };
      expect((await post("/identity-evidence", { ...f.evidence, expected_user_message_id: "wrong-user" }, token)).status).toBe(409);
      const accepted = await post("/identity-evidence", f.evidence, token);
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toEqual({ accepted: true, durable: true });
      expect(await f.service.getConfirmed("workspace-a", "review-a")).toEqual(f.input.verdict);
      expect(goalEvidence).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
      goalEvidence.mockRestore();
    }
  });

  it("refuses historical or terminal Review calls and preserves absent legacy protocol fields", async () => {
    const f = await fixture();
    const file = reviewRequestFile(f.root, "workspace-a", "review-a");
    const { verdict_protocol, ...legacy } = f.request;
    await writeFile(file, JSON.stringify(legacy));
    expect((await new ReviewRequestService(f.root).getReviewRequest("workspace-a", "review-a"))?.verdict_protocol).toBeUndefined();
    await expect(f.service.accept(f.input, proof)).rejects.toMatchObject({ code: "VERDICT_REVIEW_NOT_TOOL_PROTOCOL" });
    await writeFile(file, JSON.stringify(f.request));
    await f.store.put({ ...(await f.store.get("loop-a"))!, stage: "completed", terminal_decision: "APPROVE" });
    // A fresh instance reads the changed checkpoint rather than a previously restored in-memory store.
    const service = new ReviewVerdictSubmissionService(f.registry, { storageRoot: f.root, extensionDeliveries: f.extension, listLoops: () => f.store.list() });
    await expect(service.accept(f.input, proof)).rejects.toMatchObject({ code: "VERDICT_REVIEW_NOT_ACTIVE" });
  });

  it("routes MCP registration, authentication, strict parameters and receipt through the real service", async () => {
    const f = await fixture();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ registry: f.registry, reviewVerdictSubmission: f.service });
    await server.connect(serverTransport);
    const client = new Client({ name: "verdict-test", version: "1" });
    clients.push(client);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.find((tool) => tool.name === "submit_review_verdict")).toBeDefined();
    expect((await client.callTool({ name: "submit_review_verdict", arguments: f.input })).isError).toBe(true);
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) => send(message, { ...options, authInfo: { token: "test-token", clientId: "chatgpt", scopes: [] } });
    expect((await client.callTool({ name: "submit_review_verdict", arguments: { ...f.input, unknown: true } })).isError).toBe(true);
    const accepted = await client.callTool({ name: "submit_review_verdict", arguments: f.input });
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent).toMatchObject({ accepted: true, state: "pending_confirmation", review_request_id: "review-a", correlation_key: key });
    expect(await f.service.getConfirmed("workspace-a", "review-a")).toBeNull();
  });

  it("requests only the structured tool for tool_v1 and retains the historical prompt", () => {
    const request = { workspace_id: "workspace-a", task_id: "task-a", execution_id: "execution-a", review_request_id: "review-a", routing_id: "routing-a" };
    const message = buildReviewMessage({ ...request, verdict_protocol: "tool_v1" });
    expect(message).toContain("submit_review_verdict exactly once");
    expect(message).not.toMatch(/lrm-review-result|LRM_REVIEW_VERDICT_BEGIN|LRM_REVIEW_VERDICT_END/);
    expect(buildReviewMessage(request)).toContain("LRM_REVIEW_VERDICT_BEGIN");
  });
});
