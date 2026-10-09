import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ExtensionDeliveryService, type ExtensionDelivery, type ExtensionDeliveryReceipt } from "../../src/control-plane/extension-delivery.js";
import { AutoIterationService, autoIterationSchema, autoIterationStateFile, executionFailureNotificationId } from "../../src/control-plane/auto-iteration.js";
import { executionFile } from "../../src/context/execution.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { buildExecutionFailureMessage } from "../../src/delivery/execution-failure-message.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { ExtensionReviewCompletionService } from "../../src/control-plane/extension-review-completion.js";
import { reviewDeliveryFile } from "../../src/context/review-delivery.js";
import { reviewResultFile } from "../../src/context/review-result.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];
const owner = { conversation_id: "conversation-a", client_id: "client-a", document_id: "document-a", navigation_epoch: 0 };
afterEach(async () => {
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(kind: "delivery" | "completion", evidence = true) {
  const root = await fs.mkdtemp(join(tmpdir(), "lrm-transport-capacity-"));
  roots.push(root);
  const timestamp = new Date().toISOString();
  const records = Array.from({ length: 1000 }, (_, i) => {
    const id = randomUUID();
    if (kind === "delivery") return { delivery_id: id, logical_delivery_id: `delivery-${i}`,
      conversation_id: owner.conversation_id, message: `review ${i}`, created_at: Date.now(), phase: "delivered",
      receipt: { ...owner, delivery_id: id, status: "delivered", message_id: `user-${i}`, completed_at: Date.now() } };
    return { completion_id: id, workspace_id: "workspace-a", task_id: "task-a", review_request_id: `review-${i}`,
      review_delivery_id: `delivery-${i}`, conversation_id: owner.conversation_id, expected_user_message_id: `user-${i}`,
      created_at: Date.now(), phase: "completed", receipt: { ...owner, completion_id: id, status: "completed",
        assistant_message_id: `assistant-${i}`, content: `result ${i}`, completed_at: Date.now() } };
  });
  const queue = join(root, "control-plane", kind === "delivery" ? "extension-deliveries.json" : "extension-review-completions.json");
  await fs.mkdir(dirname(queue), { recursive: true });
  await fs.writeFile(queue, JSON.stringify({ schema_version: 1, [kind === "delivery" ? "deliveries" : "completions"]: records }));
  if (evidence) {
    // The first three entries exercise protected states; entry four is the reclaim candidate.
    await Promise.all(records.slice(0, 4).map(async (_, i) => {
      const file = kind === "delivery" ? reviewDeliveryFile(root, "workspace-a", `delivery-${i}`)
        : reviewResultFile(root, "workspace-a", `result-${i}`);
      await fs.mkdir(dirname(file), { recursive: true });
      const review = kind === "delivery" ? { delivery_id: `delivery-${i}`, workspace_id: "workspace-a", task_id: "task-a",
        review_request_id: `review-${i}`, routing_id: `routing-${i}`, conversation_id: owner.conversation_id,
        status: "delivered", attempt_count: 1, created_at: timestamp, updated_at: timestamp, delivered_at: timestamp }
        : { result_id: `result-${i}`, review_request_id: `review-${i}`, delivery_id: `delivery-${i}`,
          workspace_id: "workspace-a", task_id: "task-a", status: "COMPLETED", content: `result ${i}`, created_at: timestamp };
      await fs.writeFile(file, JSON.stringify(review));
    }));
  }
  return { root, queue, records };
}

const completionInput = (i: number) => ({ workspace_id: "workspace-a", task_id: "task-a", review_request_id: `review-${i}`,
  review_delivery_id: `delivery-${i}`, conversation_id: owner.conversation_id, expected_user_message_id: `user-${i}` });

it.each(["delivered", "failed"] as const)("reclaims 1000 anonymous %s receipts across restart", async phase => {
  const f = await fixture("delivery", false);
  const records = (f.records as ExtensionDelivery[]).map(({ logical_delivery_id: _logicalId, ...record }) => ({ ...record, phase,
    receipt: phase === "delivered" ? record.receipt : { ...owner, delivery_id: record.delivery_id,
      status: "failed", error: "not sent", completed_at: Date.now() } }));
  await fs.writeFile(f.queue, JSON.stringify({ schema_version: 1, deliveries: records }));
  const service = new ExtensionDeliveryService(f.root);
  await service.enqueue(owner.conversation_id, "new");
  const restarted = new ExtensionDeliveryService(f.root);
  expect(await restarted.get(records[0]!.delivery_id)).toBeNull();
  await expect(restarted.acknowledge({ ...owner, delivery_id: records[0]!.delivery_id,
    status: "sent", message_id: "user-0" })).rejects.toThrow("delivery not found");
  await restarted.enqueue(owner.conversation_id, "another");
  expect(JSON.parse(await fs.readFile(f.queue, "utf8")).deliveries).toHaveLength(1000);
});

it.each(["queued", "leased", "ambiguous"] as const)("does not reclaim 1000 anonymous %s records", async phase => {
  const f = await fixture("delivery", false);
  const records = (f.records as ExtensionDelivery[]).map(({ logical_delivery_id: _logicalId, ...record }) => ({ ...record, phase,
    receipt: phase === "ambiguous" ? { ...owner, delivery_id: record.delivery_id, status: "ambiguous", error: "uncertain", completed_at: Date.now() } : undefined,
    lease: phase === "leased" ? { ...owner, claimed_at: Date.now(), deadline: Date.now() + 30000 } : undefined }));
  await fs.writeFile(f.queue, JSON.stringify({ schema_version: 1, deliveries: records }));
  const before = await fs.readFile(f.queue, "utf8");
  await expect(new ExtensionDeliveryService(f.root).enqueue(owner.conversation_id, "new")).rejects.toThrow("queue is full");
  expect(await fs.readFile(f.queue, "utf8")).toBe(before);
});

it("protects anonymous ambiguous receipts, active waiters and persistence failure", async () => {
  const f = await fixture("delivery", false);
  const records = (f.records as ExtensionDelivery[]).map(({ logical_delivery_id: _logicalId, ...record }) => record);
  const timeout = "Extension Delivery timed out before an acknowledgement was recorded.";
  records[0] = { ...records[0]!, phase: "ambiguous", timeout_reason: timeout,
    receipt: { ...owner, delivery_id: records[0]!.delivery_id, status: "ambiguous", error: timeout, completed_at: Date.now() } };
  await fs.writeFile(f.queue, JSON.stringify({ schema_version: 1, deliveries: records }));
  const before = await fs.readFile(f.queue, "utf8");
  const service = new ExtensionDeliveryService(f.root);
  const internal = service as unknown as { waiters: Map<string, Set<(receipt: ExtensionDeliveryReceipt) => void>> };
  internal.waiters.set(records[1]!.delivery_id, new Set([vi.fn()]));
  vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("occupied"), { code: "EPERM" }));
  await expect(service.enqueue(owner.conversation_id, "new")).rejects.toThrow("occupied");
  expect(await fs.readFile(f.queue, "utf8")).toBe(before);
  expect(await service.get(records[2]!.delivery_id)).not.toBeNull();
  await service.enqueue(owner.conversation_id, "new");
  expect(await service.get(records[0]!.delivery_id)).toMatchObject({ phase: "ambiguous" });
  expect(await service.get(records[1]!.delivery_id)).not.toBeNull();
  expect(await service.get(records[2]!.delivery_id)).toBeNull();
  await expect(service.acknowledge({ ...owner, delivery_id: records[0]!.delivery_id, status: "sent", message_id: "late" }))
    .resolves.toMatchObject({ accepted: "new", receipt: { status: "delivered" } });
});

async function failureFixture() {
  const f = await fixture("delivery", false);
  const timestamp = new Date().toISOString();
  const loops = Array.from({ length: 6 }, (_, i) => autoIterationSchema.parse({ loop_id: `loop-${i}`,
    workspace_id: "workspace-a", task_id: "task-a", conversation_id: owner.conversation_id,
    initial_execution_id: `execution-${i}`, execution_id: `execution-${i}`, iteration: 1, max_iterations: 2,
    stage: "failed", terminal_decision: "FAILED", terminal_reason: "EXECUTION_FAILED", created_at: timestamp, updated_at: timestamp }));
  await fs.writeFile(autoIterationStateFile(f.root), JSON.stringify({ schema_version: 1, loops }));
  await fs.mkdir(dirname(executionFile(f.root, "workspace-a", "task-a", "execution-0")), { recursive: true });
  await Promise.all(loops.map(loop => fs.writeFile(executionFile(f.root, loop.workspace_id, loop.task_id, loop.execution_id),
    JSON.stringify({ workspace_id: loop.workspace_id, task_id: loop.task_id, execution_id: loop.execution_id,
      status: "failed", summary: "execution failed", started_at: timestamp, finished_at: timestamp }))));
  const records = (f.records as Array<ExtensionDelivery & { logical_delivery_id: string }>).map((record, i) => {
    const loop = loops[i];
    return loop === undefined ? record : { ...record,
      logical_delivery_id: executionFailureNotificationId(loop),
      message: buildExecutionFailureMessage({ ...loop, reason: "EXECUTION_FAILED", summary: "execution failed" }) };
  });
  await fs.writeFile(f.queue, JSON.stringify({ schema_version: 1, deliveries: records }));
  return { ...f, loops, records };
}

it.each(["delivered", "failed"] as const)("reclaims long-running %s failure notifications without replay through AutoIteration recovery", async phase => {
  const f = await failureFixture();
  if (phase === "failed") {
    f.records[0] = { ...f.records[0]!, phase, receipt: { ...owner, delivery_id: f.records[0]!.delivery_id,
      status: "failed", error: "not sent", completed_at: Date.now() } } as typeof f.records[number];
    await fs.writeFile(f.queue, JSON.stringify({ schema_version: 1, deliveries: f.records }));
  }
  const service = new ExtensionDeliveryService(f.root);
  await service.enqueue(owner.conversation_id, "new", "new-command");
  const notification = f.records[0]!;
  const restarted = new ExtensionDeliveryService(f.root);
  expect(await restarted.getByLogicalDeliveryId(notification.logical_delivery_id)).toEqual(notification);
  await expect(restarted.enqueue(notification.conversation_id, notification.message, notification.logical_delivery_id)).resolves.toEqual(notification);
  await expect(restarted.enqueue(notification.conversation_id, "wrong", notification.logical_delivery_id)).rejects.toThrow("different content");
  const ack = phase === "delivered"
    ? { ...owner, delivery_id: notification.delivery_id, status: "sent" as const, message_id: "user-0" }
    : { ...owner, delivery_id: notification.delivery_id, status: "not_sent" as const, error: "not sent" };
  await expect(restarted.acknowledge(ack)).resolves.toMatchObject({ accepted: "existing" });
  await expect(restarted.acknowledge({ ...ack, document_id: "wrong" })).rejects.toThrow("conflicting");
  const registry = new WorkspaceRegistry([{ id: "workspace-a", name: "Workspace A", path: f.root }]);
  const auto = new AutoIterationService(registry, { storageRoot: f.root, extensionDeliveries: restarted });
  try { await auto.recover(); } finally { auto.dispose(); }
  expect(await restarted.claim(owner)).toMatchObject({ message: "new" });
  const state = JSON.parse(await fs.readFile(f.queue, "utf8"));
  expect(state.deliveries).toHaveLength(1000);
  expect(state.deliveries.some((record: ExtensionDelivery) => record.logical_delivery_id === notification.logical_delivery_id)).toBe(false);
});

it("keeps failure notifications when evidence or publication is unreliable", async () => {
  const f = await failureFixture();
  const service = new ExtensionDeliveryService(f.root);
  const before = await fs.readFile(f.queue, "utf8");
  for (const boundary of ["history", "queue"]) {
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      if ((destination === f.queue) === (boundary === "queue")) throw Object.assign(new Error("occupied"), { code: "EPERM" });
      return actual.rename(source, destination);
    });
    await expect(service.enqueue(owner.conversation_id, "new")).rejects.toThrow("occupied");
    expect(await fs.readFile(f.queue, "utf8")).toBe(before);
  }
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  await fs.rm(autoIterationStateFile(f.root));
  await expect(service.enqueue(owner.conversation_id, "new")).rejects.toThrow("queue is full");
  const executions = new ExecutionContextService(f.root);
  expect((await executions.getExecutionContext("workspace-a", "task-a", "execution-0"))?.extension_transport)
    .toHaveProperty(f.records[0]!.logical_delivery_id);
});

it("preserves each notification receipt when two Loops share a failed Execution", async () => {
  const f = await failureFixture();
  f.loops[1] = { ...f.loops[1]!, execution_id: "execution-0", initial_execution_id: "execution-0" };
  f.records[1] = { ...f.records[1]!, logical_delivery_id: executionFailureNotificationId(f.loops[1]!),
    message: buildExecutionFailureMessage({ ...f.loops[1]!, reason: "EXECUTION_FAILED", summary: "execution failed" }) };
  await fs.writeFile(autoIterationStateFile(f.root), JSON.stringify({ schema_version: 1, loops: f.loops }));
  await fs.writeFile(f.queue, JSON.stringify({ schema_version: 1, deliveries: f.records }));
  const service = new ExtensionDeliveryService(f.root);
  await service.enqueue(owner.conversation_id, "new");
  await service.enqueue(owner.conversation_id, "another");
  const executions = new ExecutionContextService(f.root);
  await executions.updateExecutionContext("workspace-a", "task-a", "execution-0", { summary: "execution failed" });
  const restarted = new ExtensionDeliveryService(f.root);
  for (const notification of f.records.slice(0, 2)) {
    expect(await restarted.getByLogicalDeliveryId(notification.logical_delivery_id)).toEqual(notification);
  }
  expect(Object.keys((await executions.getExecutionContext("workspace-a", "task-a", "execution-0"))!.extension_transport!))
    .toHaveLength(2);
});

it("protects retryable, ambiguous, waiting and unproven failure notifications", async () => {
  const f = await failureFixture();
  f.records[0] = { ...f.records[0]!, phase: "ambiguous", receipt: { ...owner, delivery_id: f.records[0]!.delivery_id,
    status: "ambiguous", error: "uncertain", completed_at: Date.now() } } as typeof f.records[number];
  f.records[1] = { ...f.records[1]!, phase: "failed", receipt: { ...owner, delivery_id: f.records[1]!.delivery_id,
    status: "failed", error: "composer_busy", completed_at: Date.now() } } as typeof f.records[number];
  f.records[4] = { ...f.records[4]!, message: "wrong identity" };
  await fs.writeFile(f.queue, JSON.stringify({ schema_version: 1, deliveries: f.records }));
  await new ExecutionContextService(f.root).updateExecutionContext("workspace-a", "task-a", "execution-3", { status: "running" });
  const service = new ExtensionDeliveryService(f.root);
  const internal = service as unknown as { waiters: Map<string, Set<(receipt: ExtensionDeliveryReceipt) => void>> };
  internal.waiters.set(f.records[2]!.delivery_id, new Set([vi.fn()]));
  await service.enqueue(owner.conversation_id, "new");
  const retained = JSON.parse(await fs.readFile(f.queue, "utf8")).deliveries as ExtensionDelivery[];
  expect(retained.slice(0, 5)).toEqual(f.records.slice(0, 5));
  expect(retained.some(record => record.delivery_id === f.records[5]!.delivery_id)).toBe(false);
});

it.each(["delivery", "completion"] as const)("retains active and uncertain %s records even with Review terminal evidence", async kind => {
  const f = await fixture(kind);
  const pending = f.records.slice(0, 3).map((record, index) => ({ ...record,
    phase: index === 0 ? "queued" : index === 1 ? "leased" : "ambiguous",
    receipt: index === 2 ? { ...owner, ...(kind === "delivery" ? { delivery_id: record.delivery_id }
      : { completion_id: record.completion_id }), status: "ambiguous", error: "ACK timeout", completed_at: Date.now() } : undefined,
    lease: index === 1 ? { ...owner, claimed_at: Date.now(), deadline: Date.now() + 30000 } : undefined }));
  await fs.writeFile(f.queue, JSON.stringify({ schema_version: 1,
    [kind === "delivery" ? "deliveries" : "completions"]: [...pending, ...f.records.slice(3)] }));
  if (kind === "delivery") await new ExtensionDeliveryService(f.root).enqueue(owner.conversation_id, "new", "delivery-new");
  else await new ExtensionReviewCompletionService(f.root).enqueue(completionInput(1000));
  const saved = JSON.parse(await fs.readFile(f.queue, "utf8"));
  expect(saved[kind === "delivery" ? "deliveries" : "completions"].slice(0, 3))
    .toEqual(JSON.parse(JSON.stringify(pending)));
});

it.each(["delivery", "completion"] as const)("reclaims %s with durable Review evidence and preserves restart, duplicate submission and ACK", async kind => {
  const f = await fixture(kind);
  const delivery = new ExtensionDeliveryService(f.root);
  const completion = new ExtensionReviewCompletionService(f.root);
  if (kind === "delivery") {
    await delivery.enqueue(owner.conversation_id, "new", "delivery-new");
    const archived = await delivery.getByLogicalDeliveryId("delivery-0");
    expect(archived).toEqual(f.records[0]);
    const restarted = new ExtensionDeliveryService(f.root);
    await expect(restarted.enqueue(owner.conversation_id, "review 0", "delivery-0")).resolves.toEqual(archived);
    await expect(restarted.enqueue(owner.conversation_id, "wrong", "delivery-0")).rejects.toThrow("different content");
    const ack = { ...owner, delivery_id: archived!.delivery_id, status: "sent" as const, message_id: "user-0" };
    await expect(restarted.acknowledge(ack)).resolves.toMatchObject({ accepted: "existing" });
    await expect(restarted.acknowledge({ ...ack, document_id: "wrong" })).rejects.toThrow("conflicting");
    await expect(restarted.awaitResult(archived!.delivery_id, 0)).resolves.toEqual(archived!.receipt);
    expect(await restarted.recoveryTargets()).toHaveLength(1);
    await restarted.enqueue(owner.conversation_id, "another", "delivery-new-2");
  } else {
    await completion.enqueue(completionInput(1000));
    const archived = await completion.getByReviewRequestId("review-0");
    expect(archived).toEqual(f.records[0]);
    const restarted = new ExtensionReviewCompletionService(f.root);
    await expect(restarted.enqueue(completionInput(0))).resolves.toEqual(archived);
    await expect(restarted.enqueue({ ...completionInput(0), expected_user_message_id: "wrong" })).rejects.toThrow("different completion");
    const ack = { ...owner, completion_id: archived!.completion_id, status: "completed" as const,
      assistant_message_id: "assistant-0", content: "result 0" };
    await expect(restarted.acknowledge(ack)).resolves.toMatchObject({ accepted: "existing" });
    await expect(restarted.acknowledge({ ...ack, content: "wrong" })).rejects.toThrow("conflicting");
    await expect(restarted.awaitResult(archived!.completion_id, 0)).resolves.toEqual(archived!.receipt);
    expect(await restarted.recoveryTargets()).toEqual([]);
    await restarted.enqueue(completionInput(1001));
  }
  const saved = JSON.parse(await fs.readFile(f.queue, "utf8"));
  expect(saved[kind === "delivery" ? "deliveries" : "completions"]).toHaveLength(1000);
});

it.each(["delivery", "completion"] as const)("does not reclaim %s without reliable evidence", async kind => {
  const f = await fixture(kind, false);
  const before = await fs.readFile(f.queue, "utf8");
  const enqueue = kind === "delivery" ? new ExtensionDeliveryService(f.root).enqueue(owner.conversation_id, "new", "new")
    : new ExtensionReviewCompletionService(f.root).enqueue(completionInput(1000));
  await expect(enqueue).rejects.toThrow("queue is full");
  expect(await fs.readFile(f.queue, "utf8")).toBe(before);
});

it.each(["delivery", "completion"] as const)("keeps %s state consistent when history or queue publication fails", async kind => {
  const f = await fixture(kind);
  const before = await fs.readFile(f.queue, "utf8");
  const service = kind === "delivery" ? new ExtensionDeliveryService(f.root) : new ExtensionReviewCompletionService(f.root);
  const enqueue = () => service instanceof ExtensionDeliveryService ? service.enqueue(owner.conversation_id, "new", "delivery-new")
    : service.enqueue(completionInput(1000));
  for (const boundary of ["history", "queue"]) {
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      if ((destination === f.queue) === (boundary === "queue")) throw Object.assign(new Error("occupied"), { code: "EPERM" });
      return actual.rename(source, destination);
    });
    await expect(enqueue()).rejects.toThrow("occupied");
    expect(await fs.readFile(f.queue, "utf8")).toBe(before);
  }
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  await expect(enqueue()).resolves.toMatchObject({ phase: "queued" });
});
