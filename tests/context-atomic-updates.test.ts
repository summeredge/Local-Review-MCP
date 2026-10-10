import { ReviewCompletionRouter } from "../src/router/review-completion-router.js";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { TaskContextService } from "../src/context/service.js";
import { taskContextFile } from "../src/context/task.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { ReviewRequestService } from "../src/context/review-request-service.js";
import { reviewRequestFile } from "../src/context/review-request.js";
import { ConversationRoutingService } from "../src/context/conversation-routing-service.js";
import { ReviewDeliveryService } from "../src/context/review-delivery-service.js";
import { reviewDeliveryFile } from "../src/context/review-delivery.js";
import { ReviewResultService } from "../src/context/review-result-service.js";
import { reviewResultFile } from "../src/context/review-result.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];
afterEach(async () => { vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile); vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(kind: string) {
  const root = await fs.mkdtemp(join(tmpdir(), "lrm-atomic-business-")); roots.push(root);
  const tasks = new TaskContextService(root); const requests = new ReviewRequestService(root);
  const deliveries = new ReviewDeliveryService(root); const results = new ReviewResultService(root);
  await tasks.createTaskContext({ task_id: "task-a", workspace_id: "workspace-a", status: "reviewing" });
  await new ExecutionContextService(root).createExecutionContext({ workspace_id: "workspace-a", task_id: "task-a", execution_id: "execution-a", status: "passed" });
  await requests.createReviewRequest({ workspace_id: "workspace-a", task_id: "task-a", execution_id: "execution-a", review_request_id: "review-a", status: "reviewing" });
  const routing = await new ConversationRoutingService(root).createRouting({ workspace_id: "workspace-a", task_id: "task-a", review_request_id: "review-a", conversation_id: "conversation-a" });
  const delivery = await deliveries.createDelivery({ workspace_id: routing.workspace_id, task_id: routing.task_id, review_request_id: routing.review_request_id, routing_id: routing.routing_id, conversation_id: routing.conversation_id });
  await deliveries.beginDeliveryAttempt("workspace-a", delivery.delivery_id);
  if (kind !== "delivery") await deliveries.markDelivered("workspace-a", delivery.delivery_id);
  const input = { workspace_id: "workspace-a", review_request_id: "review-a", delivery_id: delivery.delivery_id, result_id: "result-a" };
  if (kind === "result") await results.createReviewResult({ ...input, status: "FAILED", error: "previous failure" });
  const file = kind === "task" ? taskContextFile(root, "task-a") : kind === "request" ? reviewRequestFile(root, "workspace-a", "review-a")
    : kind === "delivery" ? reviewDeliveryFile(root, "workspace-a", delivery.delivery_id) : reviewResultFile(root, "workspace-a", "result-a");
  const update = () => kind === "task" ? tasks.updateTaskContext("task-a", { status: "completed" }) : kind === "request" ? requests.updateReviewRequest("workspace-a", "review-a", { status: "completed" })
    : kind === "delivery" ? deliveries.markDelivered("workspace-a", delivery.delivery_id) : results.createReviewResult({ ...input, status: "COMPLETED", content: "review passed" });
  return { root, file, update, tasks, requests, deliveries, results, delivery, input };
}

it.each(["task", "request", "delivery", "result"])("keeps %s readable after interrupted temp writes and failed atomic publication", async kind => {
  const f = await fixture(kind); const before = await fs.readFile(f.file, "utf8");
  for (const boundary of ["write", "rename"]) {
    if (boundary === "write") vi.mocked(fs.writeFile).mockImplementation(async (path, contents, options) => {
      if (String(path).startsWith(f.file + ".") && String(path).endsWith(".tmp")) {
        await actual.writeFile(path, '{"partial":', options); throw Object.assign(new Error("interrupted write"), { code: "ENOSPC" });
      }
      return actual.writeFile(path, contents, options);
    });
    else vi.mocked(fs.rename).mockImplementation(async (source, target) => {
      if (target === f.file) throw Object.assign(new Error("publish locked"), { code: "EPERM" });
      return actual.rename(source, target);
    });
    await expect(f.update()).rejects.toThrow("could not be saved");
    expect(await fs.readFile(f.file, "utf8")).toBe(before);
    expect(JSON.parse(before)).toHaveProperty("status");
    expect((await fs.readdir(dirname(f.file))).some(name => name.endsWith(".tmp"))).toBe(false);
    vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile); vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  }
  await f.update();
  expect(JSON.parse(await fs.readFile(f.file, "utf8")).status).toBe(kind === "result" ? "COMPLETED" : kind === "delivery" ? "delivered" : "completed");
});

it("serializes independent Task and Review Request patches across service instances", async () => {
  const f = await fixture("task");
  await Promise.all([f.tasks.updateTaskContext("task-a", { status: "completed" }), new TaskContextService(f.root).updateTaskContext("task-a", { conversation_id: "conversation-new" })]);
  expect(await f.tasks.getTaskContext("task-a")).toMatchObject({ status: "completed", conversation_id: "conversation-new" });
  await Promise.all([f.requests.updateReviewRequest("workspace-a", "review-a", { status: "completed" }), new ReviewRequestService(f.root).updateReviewRequest("workspace-a", "review-a", { conversation_id: "conversation-new" })]);
  expect(await f.requests.getReviewRequest("workspace-a", "review-a")).toMatchObject({ status: "completed", conversation_id: "conversation-new" });
});

it("does not let a concurrent Delivery failure overwrite confirmed delivery", async () => {
  const f = await fixture("delivery");
  const outcomes = await Promise.allSettled([f.deliveries.markDelivered("workspace-a", f.delivery.delivery_id), new ReviewDeliveryService(f.root).markFailed("workspace-a", f.delivery.delivery_id, { code: "FAILURE", message: "late failure" })]);
  expect(outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "rejected"]);
  expect(await f.deliveries.getDelivery("workspace-a", f.delivery.delivery_id)).toMatchObject({ status: "delivered", attempt_count: 1 });
});

it("keeps completed Results terminal under concurrent completion, late failure and duplicate completion", async () => {
  const f = await fixture("result");
  const outcomes = await Promise.all([f.results.createReviewResult({ ...f.input, status: "COMPLETED", content: "review passed" }), new ReviewResultService(f.root).createReviewResult({ ...f.input, status: "FAILED", error: "late failure" })]);
  expect(outcomes.every(result => result.status === "COMPLETED" && result.result_id === "result-a")).toBe(true);
  expect(await f.results.createReviewResult({ ...f.input, status: "COMPLETED", content: "review passed" })).toMatchObject({ result_id: "result-a", status: "COMPLETED" });
  expect(await f.results.listReviewResults("workspace-a")).toHaveLength(1);
});

it("completes and deduplicates the current Review despite unrelated broken Results and Deliveries", async () => {
  const f = await fixture("result"); const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  for (const file of [reviewResultFile(f.root, "workspace-a", "000-broken"), reviewDeliveryFile(f.root, "workspace-a", "000-broken")]) await fs.writeFile(file, "invalid JSON");
  const collect = vi.fn(async () => ({ status: "COMPLETED" as const, content: "review passed" }));
  const router = new ReviewCompletionRouter(f.root, { collect });
  const first = await router.collect("workspace-a", f.delivery.routing_id);
  const second = await router.collect("workspace-a", f.delivery.routing_id);
  expect(first.status).toBe("COMPLETED"); expect(second.result_id).toBe(first.result_id);
  expect(collect).toHaveBeenCalledTimes(1);
  expect(await f.requests.getReviewRequest("workspace-a", "review-a")).toMatchObject({ status: "completed" });
  expect(warn).toHaveBeenCalled(); warn.mockRestore();
});
