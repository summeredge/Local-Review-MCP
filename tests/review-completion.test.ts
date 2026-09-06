import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  ChatGPTCompletionDetector,
} from "../src/browser-worker/completion/detector.js";
import { ChatGPTResultExtractor } from "../src/browser-worker/completion/extractor.js";
import { CHATGPT_ASSISTANT_MESSAGE_SELECTOR } from "../src/browser-worker/selectors/chatgpt.js";
import { BrowserWorkerClient } from "../src/browser-worker-client/browser-worker-client.js";
import { ConversationRoutingService } from "../src/context/conversation-routing-service.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { ReviewDeliveryService } from "../src/context/review-delivery-service.js";
import { ReviewRequestService } from "../src/context/review-request-service.js";
import { ReviewResultService } from "../src/context/review-result-service.js";
import { TaskContextService } from "../src/context/service.js";
import { ReviewCompletionRouter } from "../src/router/review-completion-router.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

class TextLocator {
  public constructor(
    private readonly text: () => string,
    private readonly matches = 1,
    private readonly visible = false,
  ) {}

  public async count(): Promise<number> { return this.matches; }
  public nth(): TextLocator { return this; }
  public async isVisible(): Promise<boolean> { return this.visible; }
  public async innerText(): Promise<string> { return this.text(); }
  public async textContent(): Promise<string> { return this.text(); }
}

function makePage(options: {
  readonly count?: () => number;
  readonly text?: () => string;
  readonly generating?: () => boolean;
} = {}): Page {
  const count = options.count ?? (() => 1);
  const text = options.text ?? (() => "Review result");
  const generating = options.generating ?? (() => false);
  return {
    locator: (selector: string): TextLocator => {
      if (selector === CHATGPT_ASSISTANT_MESSAGE_SELECTOR) {
        return new TextLocator(text, count(), true);
      }
      if (selector.includes("stop-button") || selector.includes("Stop generating")) {
        return new TextLocator(() => "", generating() ? 1 : 0, true);
      }
      return new TextLocator(() => "", 0);
    },
  } as unknown as Page;
}

async function makeStorageRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-completion-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeDeliveredChain(storageRoot: string) {
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
  const request = await new ReviewRequestService(storageRoot).createReviewRequest({
    review_request_id: "review-001",
    task_id: "task-001",
    execution_id: "execution-001",
    workspace_id: "workspace-a",
  });
  const routing = await new ConversationRoutingService(storageRoot).createRouting({
    routing_id: "routing-001",
    workspace_id: "workspace-a",
    task_id: "task-001",
    review_request_id: request.review_request_id,
    conversation_id: "conversation-001",
  });
  const deliveries = new ReviewDeliveryService(storageRoot);
  const created = await deliveries.createDelivery({
    workspace_id: routing.workspace_id,
    task_id: routing.task_id,
    review_request_id: routing.review_request_id,
    routing_id: routing.routing_id,
    conversation_id: routing.conversation_id,
  });
  await deliveries.beginDeliveryAttempt("workspace-a", created.delivery_id);
  const delivery = await deliveries.markDelivered("workspace-a", created.delivery_id);
  return { request, routing, delivery };
}

describe("Review completion detector", () => {
  it("detects an assistant response after it appears", async () => {
    let polls = 0;
    const page = makePage({
      count: () => polls++ === 0 ? 0 : 1,
    });

    await expect(new ChatGPTCompletionDetector({ timeoutMs: 100, pollIntervalMs: 1 })
      .waitForCompletion(page)).resolves.toEqual({ status: "COMPLETED" });
  });

  it("waits for an assistant response to become stable", async () => {
    let reads = 0;
    const page = makePage({ text: () => reads++ === 0 ? "draft" : "final" });

    await expect(new ChatGPTCompletionDetector({ timeoutMs: 100, pollIntervalMs: 1 })
      .waitForCompletion(page)).resolves.toEqual({ status: "COMPLETED" });
  });

  it("times out while the assistant response is still generating", async () => {
    let reads = 0;
    const page = makePage({
      text: () => `draft-${reads++}`,
      generating: () => true,
    });

    await expect(new ChatGPTCompletionDetector({ timeoutMs: 10, pollIntervalMs: 1 })
      .waitForCompletion(page)).resolves.toMatchObject({ status: "TIMEOUT" });
  });
});

describe("Review result extractor", () => {
  it("extracts only the latest assistant message", async () => {
    const page = {
      locator: (selector: string): TextLocator => selector === CHATGPT_ASSISTANT_MESSAGE_SELECTOR
        ? new TextLocator(() => "latest review", 2, true)
        : new TextLocator(() => "", 0),
    } as unknown as Page;

    await expect(new ChatGPTResultExtractor().extract(page)).resolves.toMatchObject({
      status: "COMPLETED",
      content: "latest review",
    });
  });

  it("rejects an empty assistant response", async () => {
    await expect(new ChatGPTResultExtractor().extract(makePage({ text: () => "" })))
      .rejects.toThrow("assistant response was empty");
  });
});

describe("ReviewResultService", () => {
  it("persists one result per review request and returns duplicates", async () => {
    const storageRoot = await makeStorageRoot();
    const { request, delivery } = await makeDeliveredChain(storageRoot);
    const service = new ReviewResultService(storageRoot);
    const input = {
      review_request_id: request.review_request_id,
      delivery_id: delivery.delivery_id,
      workspace_id: "workspace-a",
      status: "COMPLETED" as const,
      content: "review result",
    };

    const created = await service.createReviewResult(input);
    const duplicate = await service.createReviewResult({ ...input, content: "ignored" });

    expect(created).toMatchObject({
      review_request_id: "review-001",
      delivery_id: delivery.delivery_id,
      task_id: "task-001",
      status: "COMPLETED",
      content: "review result",
    });
    expect(duplicate).toEqual(created);
    expect(await service.getReviewResult("workspace-a", created.result_id)).toEqual(created);
    expect(JSON.parse(await readFile(join(
      storageRoot,
      ".task",
      "review_results",
      "workspace-a",
      `${created.result_id}.json`,
    ), "utf8"))).toEqual(created);
    await expect(service.listReviewResults("workspace-a")).resolves.toHaveLength(1);
  });
});

describe("ReviewCompletionRouter", () => {
  it("collects, stores, completes the request, and is idempotent", async () => {
    const storageRoot = await makeStorageRoot();
    const { request, routing, delivery } = await makeDeliveredChain(storageRoot);
    let calls = 0;
    const router = new ReviewCompletionRouter(storageRoot, {
      collectCompletion: async (conversationId: string) => {
        calls += 1;
        return {
          conversationId,
          status: "COMPLETED" as const,
          content: "review result",
          extractedAt: new Date().toISOString(),
        };
      },
    });

    const first = await router.collect("workspace-a", routing.routing_id);
    const second = await router.collect("workspace-a", routing.routing_id);

    expect(first).toMatchObject({
      review_request_id: request.review_request_id,
      delivery_id: delivery.delivery_id,
      status: "COMPLETED",
      content: "review result",
    });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    await expect(new ReviewRequestService(storageRoot)
      .getReviewRequest("workspace-a", request.review_request_id))
      .resolves.toMatchObject({ status: "completed" });
  });

  it("keeps one result record when a timeout is retried successfully", async () => {
    const storageRoot = await makeStorageRoot();
    const { request, routing } = await makeDeliveredChain(storageRoot);
    let timedOut = true;
    const router = new ReviewCompletionRouter(storageRoot, {
      collectCompletion: async (conversationId: string) => timedOut
        ? {
          conversationId,
          status: "TIMEOUT" as const,
          error: "assistant did not finish",
        }
        : {
          conversationId,
          status: "COMPLETED" as const,
          content: "review result",
          extractedAt: new Date().toISOString(),
        },
    });

    const failed = await router.collect("workspace-a", routing.routing_id);
    timedOut = false;
    const completed = await router.collect("workspace-a", routing.routing_id);

    expect(failed).toMatchObject({ status: "TIMEOUT", error: "assistant did not finish" });
    expect(completed).toMatchObject({ status: "COMPLETED", content: "review result" });
    expect(completed.result_id).toBe(failed.result_id);
    await expect(new ReviewResultService(storageRoot).listReviewResults("workspace-a"))
      .resolves.toHaveLength(1);
    await expect(new ReviewRequestService(storageRoot)
      .getReviewRequest("workspace-a", request.review_request_id))
      .resolves.toMatchObject({ status: "completed" });
  });
});

describe("BrowserWorkerClient completion API", () => {
  it("posts a conversation ID and validates a completed result", async () => {
    const listener = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        conversationId: JSON.parse(Buffer.concat(chunks).toString("utf8")).conversationId,
        status: "COMPLETED",
        content: "review result",
        extractedAt: new Date().toISOString(),
      }));
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");

    try {
      await expect(new BrowserWorkerClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        completionTimeoutMs: 1000,
      }).collectCompletion("conversation-001")).resolves.toMatchObject({
        conversationId: "conversation-001",
        status: "COMPLETED",
        content: "review result",
      });
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
