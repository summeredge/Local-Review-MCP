import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationRoutingService } from "../src/context/conversation-routing-service.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { generateReviewDeliveryExample } from "../src/context/review-delivery-diagnostic.js";
import { ReviewDeliveryService } from "../src/context/review-delivery-service.js";
import { ReviewRequestService } from "../src/context/review-request-service.js";
import { TaskContextService } from "../src/context/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeStorageRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-delivery-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeRouting(storageRoot: string, workspaceId = "workspace-a") {
  await new TaskContextService(storageRoot).createTaskContext({
    task_id: "task-001",
    workspace_id: workspaceId,
    status: "reviewing",
  });
  await new ExecutionContextService(storageRoot).createExecutionContext({
    execution_id: "execution-001",
    task_id: "task-001",
    workspace_id: workspaceId,
  });
  await new ReviewRequestService(storageRoot).createReviewRequest({
    review_request_id: "review-001",
    task_id: "task-001",
    execution_id: "execution-001",
    workspace_id: workspaceId,
  });
  return new ConversationRoutingService(storageRoot).createRouting({
    workspace_id: workspaceId,
    task_id: "task-001",
    review_request_id: "review-001",
    conversation_id: "conversation-001",
  });
}

describe("ReviewDeliveryService", () => {
  it("creates one pending delivery per routing and persists it", async () => {
    const storageRoot = await makeStorageRoot();
    const routing = await makeRouting(storageRoot);
    const service = new ReviewDeliveryService(storageRoot);
    const input = {
      workspace_id: routing.workspace_id,
      task_id: routing.task_id,
      review_request_id: routing.review_request_id,
      routing_id: routing.routing_id,
      conversation_id: routing.conversation_id,
    };

    const created = await service.createDelivery(input);
    const duplicate = await service.createDelivery(input);

    expect(created).toMatchObject({
      ...input,
      status: "pending",
      attempt_count: 0,
    });
    expect(duplicate).toEqual(created);
    expect(await service.getDelivery("workspace-a", created.delivery_id)).toEqual(created);
    expect(JSON.parse(await readFile(join(
      storageRoot,
      ".task",
      "review_deliveries",
      "workspace-a",
      `${created.delivery_id}.json`,
    ), "utf8"))).toEqual(created);
  });

  it("supports retry and keeps delivered deliveries terminal", async () => {
    const storageRoot = await makeStorageRoot();
    const routing = await makeRouting(storageRoot);
    const service = new ReviewDeliveryService(storageRoot);
    const delivery = await service.createDelivery({
      workspace_id: routing.workspace_id,
      task_id: routing.task_id,
      review_request_id: routing.review_request_id,
      routing_id: routing.routing_id,
      conversation_id: routing.conversation_id,
    });

    const firstAttempt = await service.beginDeliveryAttempt("workspace-a", delivery.delivery_id);
    const failed = await service.markFailed("workspace-a", delivery.delivery_id, {
      code: "ADAPTER_UNAVAILABLE",
      message: "The future adapter is unavailable.",
    });
    const secondAttempt = await service.beginDeliveryAttempt("workspace-a", delivery.delivery_id);
    const delivered = await service.markDelivered("workspace-a", delivery.delivery_id);

    expect(firstAttempt).toMatchObject({ status: "delivering", attempt_count: 1 });
    expect(failed).toMatchObject({
      status: "failed",
      attempt_count: 1,
      last_error: { code: "ADAPTER_UNAVAILABLE" },
    });
    expect(secondAttempt).toMatchObject({ status: "delivering", attempt_count: 2 });
    expect(delivered).toMatchObject({ status: "delivered", attempt_count: 2 });
    expect(delivered.delivered_at).toBeTruthy();
    await expect(service.beginDeliveryAttempt("workspace-a", delivery.delivery_id))
      .rejects.toThrow('status "delivered"');
    expect(await service.createDelivery({
      workspace_id: routing.workspace_id,
      task_id: routing.task_id,
      review_request_id: routing.review_request_id,
      routing_id: routing.routing_id,
      conversation_id: routing.conversation_id,
    })).toEqual(delivered);
  });

  it("rejects routing mismatches and cross-workspace references", async () => {
    const storageRoot = await makeStorageRoot();
    const routing = await makeRouting(storageRoot);
    const service = new ReviewDeliveryService(storageRoot);

    await expect(service.createDelivery({
      workspace_id: "workspace-a",
      task_id: "other-task",
      review_request_id: routing.review_request_id,
      routing_id: routing.routing_id,
      conversation_id: routing.conversation_id,
    })).rejects.toThrow("task does not match");

    await expect(service.createDelivery({
      workspace_id: "workspace-b",
      task_id: routing.task_id,
      review_request_id: routing.review_request_id,
      routing_id: routing.routing_id,
      conversation_id: routing.conversation_id,
    })).rejects.toMatchObject({ code: "WORKSPACE_IDENTITY_MISMATCH" });
  });

  it("generates a delivered diagnostic record without retaining state", async () => {
    const delivery = await generateReviewDeliveryExample();

    expect(delivery).toMatchObject({
      workspace_id: "example-workspace",
      task_id: "example-task",
      review_request_id: "example-review",
      status: "delivered",
      attempt_count: 1,
    });
  });
});
