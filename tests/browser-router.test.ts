import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationRoutingService } from "../src/context/conversation-routing-service.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { ReviewDeliveryService } from "../src/context/review-delivery-service.js";
import { ReviewRequestService } from "../src/context/review-request-service.js";
import { TaskContextService } from "../src/context/service.js";
import { BrowserDeliveryAdapter } from "../src/delivery/browser-delivery-adapter.js";
import { MockBrowserDeliveryDriver } from "../src/delivery/browser-delivery-driver.js";
import { conversationUrl } from "../src/delivery/conversation-url.js";
import { BrowserRouter } from "../src/router/browser-router.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeStorageRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-browser-router-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeChain(storageRoot: string) {
  await new TaskContextService(storageRoot).createTaskContext({
    task_id: "task-001",
    workspace_id: "workspace-a",
    status: "reviewing",
  });
  await new ExecutionContextService(storageRoot).createExecutionContext({
    execution_id: "execution-001",
    task_id: "task-001",
    workspace_id: "workspace-a",
  });
  await new ReviewRequestService(storageRoot).createReviewRequest({
    review_request_id: "review-001",
    task_id: "task-001",
    execution_id: "execution-001",
    workspace_id: "workspace-a",
  });
  const routing = await new ConversationRoutingService(storageRoot).createRouting({
    routing_id: "routing-001",
    workspace_id: "workspace-a",
    task_id: "task-001",
    review_request_id: "review-001",
    conversation_id: "conversation-001",
  });
  const delivery = await new ReviewDeliveryService(storageRoot).createDelivery({
    workspace_id: routing.workspace_id,
    task_id: routing.task_id,
    review_request_id: routing.review_request_id,
    routing_id: routing.routing_id,
    conversation_id: routing.conversation_id,
  });
  return { routing, delivery };
}

describe("BrowserRouter", () => {
  it("delivers the task-scoped request and does not repeat a delivered delivery", async () => {
    const storageRoot = await makeStorageRoot();
    const { routing } = await makeChain(storageRoot);
    const driver = new MockBrowserDeliveryDriver();
    const router = new BrowserRouter(storageRoot, new BrowserDeliveryAdapter(driver));

    const delivered = await router.deliver("workspace-a", routing.routing_id);
    const repeated = await router.deliver("workspace-a", routing.routing_id);

    expect(delivered).toMatchObject({
      routing_id: "routing-001",
      conversation_id: "conversation-001",
      status: "delivered",
      attempt_count: 1,
    });
    expect(repeated).toEqual(delivered);
    expect(driver.openedConversationIds).toEqual(["conversation-001"]);
    expect(driver.sentMessages).toHaveLength(1);
    expect(driver.sentMessages[0]?.message).toContain("workspace_id=workspace-a");
    expect(driver.sentMessages[0]?.message).toContain("task_id=task-001");
    expect(driver.sentMessages[0]?.message).toContain("review_request_id=review-001");

    const request = await new ReviewRequestService(storageRoot)
      .getReviewRequest("workspace-a", "review-001");
    expect(request?.status).toBe("requested");
    expect(request?.status).not.toBe("completed");
  });

  it("records a retryable failure and permits a later retry", async () => {
    const storageRoot = await makeStorageRoot();
    const { routing } = await makeChain(storageRoot);
    const driver = new MockBrowserDeliveryDriver();
    driver.result = {
      status: "failed",
      error: { code: "BROWSER_NOT_AVAILABLE", message: "Browser is unavailable." },
    };
    const router = new BrowserRouter(storageRoot, new BrowserDeliveryAdapter(driver));

    const failed = await router.deliver("workspace-a", routing.routing_id);
    driver.result = { status: "delivered", delivered_at: new Date().toISOString() };
    const delivered = await router.deliver("workspace-a", routing.routing_id);

    expect(failed).toMatchObject({
      status: "failed",
      attempt_count: 1,
      last_error: { code: "BROWSER_NOT_AVAILABLE" },
    });
    expect(delivered).toMatchObject({ status: "delivered", attempt_count: 2 });
    expect(driver.sentMessages).toHaveLength(2);
  });

  it("records non-retryable driver failures without an automatic retry loop", async () => {
    const storageRoot = await makeStorageRoot();
    const { routing } = await makeChain(storageRoot);
    const driver = new MockBrowserDeliveryDriver({
      status: "failed",
      error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation was not found." },
    });
    const router = new BrowserRouter(storageRoot, new BrowserDeliveryAdapter(driver));

    const failed = await router.deliver("workspace-a", routing.routing_id);

    expect(failed).toMatchObject({
      status: "failed",
      attempt_count: 1,
      last_error: { code: "CONVERSATION_NOT_FOUND" },
    });
    expect(driver.sentMessages).toHaveLength(1);
  });

  it("builds only safe ChatGPT Conversation URLs", () => {
    expect(conversationUrl("conversation-001"))
      .toBe("https://chatgpt.com/c/conversation-001");
    for (const value of ["", "../outside", "https://evil.example/c/id", "conversation/id"]) {
      expect(() => conversationUrl(value)).toThrow(/conversation_id/iu);
    }
  });
});
