import { ReviewDeliveryService } from "../../src/context/review-delivery-service.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewResultService } from "../../src/context/review-result-service.js";
import { reviewResultFile } from "../../src/context/review-result.js";
import { reviewDeliveryFile } from "../../src/context/review-delivery.js";
import { ExtensionReviewCompletionService } from "../../src/control-plane/extension-review-completion.js";
import { ExtensionDeliveryService } from "../../src/control-plane/extension-delivery.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function put(file: string, record: unknown) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, typeof record === "string" ? record : JSON.stringify(record)); }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lrm-review-history-")); roots.push(root);
  const timestamp = new Date().toISOString();
  const completionId = randomUUID(); const deliveryId = randomUUID();
  const owner = { conversation_id: "conversation-a", client_id: "client-a", document_id: "document-a", navigation_epoch: 1 };
  const completion = { completion_id: completionId, workspace_id: "workspace-a", task_id: "task-a", review_request_id: "review-a", review_delivery_id: "delivery-a",
    conversation_id: owner.conversation_id, expected_user_message_id: "user-a", created_at: Date.now(), phase: "completed", receipt: { ...owner, completion_id: completionId,
      status: "completed", assistant_message_id: "assistant-a", completed_at: Date.now() } };
  const result = { result_id: "result-a", review_request_id: "review-a", delivery_id: "delivery-a", workspace_id: "workspace-a", task_id: "task-a",
    status: "COMPLETED", content: "review content", created_at: timestamp, extension_transport: completion };
  const delivery = { delivery_id: "delivery-a", workspace_id: "workspace-a", task_id: "task-a", review_request_id: "review-a", routing_id: "routing-a",
    conversation_id: owner.conversation_id, status: "delivered", attempt_count: 1, created_at: timestamp, updated_at: timestamp, delivered_at: timestamp,
    extension_transport: { delivery_id: deliveryId, logical_delivery_id: "delivery-a", conversation_id: owner.conversation_id, message: "review", created_at: Date.now(), phase: "delivered",
      receipt: { ...owner, delivery_id: deliveryId, status: "delivered", message_id: "user-a", completed_at: Date.now() } } };
  await put(reviewResultFile(root, "workspace-a", "result-a"), result);
  await put(reviewDeliveryFile(root, "workspace-a", "delivery-a"), delivery);
  return { root, result, delivery, completionId, deliveryId, owner };
}

it("isolates unrelated JSON and schema errors while restoring current Review and historical ACKs", async () => {
  const f = await fixture(); const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  for (const workspace of ["workspace-a", "workspace-old"]) {
    await put(reviewResultFile(f.root, workspace, "000-broken"), "invalid JSON");
    await put(reviewResultFile(f.root, workspace, "001-invalid"), { review_request_id: "review-old" });
    await put(reviewDeliveryFile(f.root, workspace, "000-broken"), "invalid JSON");
  }
  expect(await new ReviewResultService(f.root).getReviewResultByRequest("workspace-a", "review-a")).toMatchObject({ result_id: "result-a" });
  // References in unrelated broken content are not authoritative identity fields.
  await put(reviewResultFile(f.root, "workspace-a", "002-reference"), '{"note":"review-a",');
  await put(reviewResultFile(f.root, "workspace-a", "003-reference"), '{"note":' + JSON.stringify(f.completionId) + ',');
  await put(reviewDeliveryFile(f.root, "workspace-a", "002-reference"), '{"note":' + JSON.stringify(f.deliveryId) + ',');
  const completions = new ExtensionReviewCompletionService(f.root);
  expect(await completions.get(f.completionId)).toMatchObject({ completion_id: f.completionId, receipt: { content: "review content" } });
  expect(await completions.getByReviewRequestId("review-a", "workspace-a")).toMatchObject({ completion_id: f.completionId });
  const deliveries = new ExtensionDeliveryService(f.root);
  expect(await deliveries.get(f.deliveryId)).toMatchObject({ logical_delivery_id: "delivery-a" });
  await expect(deliveries.acknowledge({ ...f.owner, delivery_id: f.deliveryId, status: "sent", message_id: "user-a" })).resolves.toMatchObject({ accepted: "existing" });
  await expect(completions.acknowledge({ ...f.owner, completion_id: f.completionId, status: "completed", assistant_message_id: "assistant-a", content: "review content" })).resolves.toMatchObject({ accepted: "existing" });
  expect(warn).toHaveBeenCalled();
});

it.each(["schema", "identity", "syntax"])("keeps current Result %s corruption strict", async fault => {
  const f = await fixture();
  await put(reviewResultFile(f.root, "workspace-a", "result-a"), fault === "syntax" ? '{"review_request_id":"review-a",' : { ...f.result,
    ...(fault === "schema" ? { status: "invalid" } : { workspace_id: "workspace-wrong" }) });
  await expect(new ReviewResultService(f.root).getReviewResultByRequest("workspace-a", "review-a")).rejects.toThrow();
  await expect(new ExtensionReviewCompletionService(f.root).getByReviewRequestId("review-a", "workspace-a")).rejects.toThrow();
});

it("rejects conflicting archived completion evidence and duplicate Result identity", async () => {
  const f = await fixture();
  await put(reviewResultFile(f.root, "workspace-a", "result-a"), { ...f.result, extension_transport: { ...f.result.extension_transport, task_id: "wrong-task" } });
  await expect(new ExtensionReviewCompletionService(f.root).get(f.completionId)).rejects.toThrow("does not match");
  await put(reviewResultFile(f.root, "workspace-a", "result-copy"), { ...f.result, result_id: "result-copy" });
  await expect(new ReviewResultService(f.root).getReviewResultByRequest("workspace-a", "review-a")).rejects.toThrow("Multiple");
});

it.each(["schema", "identity", "syntax"])("keeps the current Delivery %s corruption strict", async fault => {
  const f = await fixture();
  await put(reviewDeliveryFile(f.root, "workspace-a", "delivery-a"), fault === "syntax" ? '{"routing_id":"routing-a",' : { ...f.delivery,
    ...(fault === "schema" ? { status: "invalid" } : { workspace_id: "workspace-wrong" }) });
  await expect(new ReviewDeliveryService(f.root).getDeliveryByRouting("workspace-a", "routing-a")).rejects.toThrow();
});
