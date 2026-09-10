import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { ChatGPTCompletionDetector } from "../src/browser-worker/completion/detector.js";
import { ChatGPTResultExtractor } from "../src/browser-worker/completion/extractor.js";
import {
  CHATGPT_ASSISTANT_MESSAGE_SELECTOR,
  CHATGPT_CONVERSATION_MESSAGE_SELECTOR,
  CHATGPT_USER_MESSAGE_SELECTOR,
} from "../src/browser-worker/selectors/chatgpt.js";
import { BrowserWorkerClient } from "../src/browser-worker-client/browser-worker-client.js";
import { BrowserWorkerReviewCompletionAdapter } from "../src/delivery/browser-worker-review-completion-adapter.js";
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

type MessageRole = "user" | "assistant";

interface FakeMessage {
  readonly role: MessageRole;
  readonly text: string;
  readonly generating?: boolean;
}

class FakeConversationPage {
  public constructor(
    public readonly messages: FakeMessage[],
    public readonly generating = false,
  ) {}

  public locator(selector: string): FakeLocator {
    if (selector === CHATGPT_CONVERSATION_MESSAGE_SELECTOR) return new FakeLocator(this);
    if (selector === CHATGPT_USER_MESSAGE_SELECTOR) return new FakeLocator(this, "user");
    if (selector === CHATGPT_ASSISTANT_MESSAGE_SELECTOR) return new FakeLocator(this, "assistant");
    if (selector.includes("stop-button") || selector.includes("Stop generating")) {
      return new FakeLocator(this, undefined, undefined, true);
    }
    return new FakeLocator(this, undefined, undefined, false, true);
  }
}

class FakeLocator {
  public constructor(
    private readonly page: FakeConversationPage,
    private readonly role?: MessageRole,
    private readonly index?: number,
    private readonly generatingLocator = false,
    private readonly emptyLocator = false,
  ) {}

  private indexes(): number[] {
    if (this.generatingLocator) return this.page.generating ? [0] : [];
    if (this.emptyLocator) return [];
    return this.page.messages
      .map((message, index) => this.role === undefined || message.role === this.role ? index : -1)
      .filter((index) => index >= 0);
  }

  private message(): FakeMessage {
    const message = this.index === undefined ? undefined : this.page.messages[this.index];
    if (message === undefined) throw new Error("fake message is not selected");
    return message;
  }

  public async count(): Promise<number> { return this.indexes().length; }

  public nth(index: number): FakeLocator {
    return new FakeLocator(
      this.page,
      this.role,
      this.indexes()[index],
      this.generatingLocator,
      this.emptyLocator,
    );
  }

  public async isVisible(): Promise<boolean> { return true; }

  public async getAttribute(name: string): Promise<string | null> {
    if (this.generatingLocator || this.emptyLocator) return null;
    const message = this.message();
    if (name === "data-message-author-role") return message.role;
    if (name === "aria-busy") return message.generating === true ? "true" : null;
    return null;
  }

  public async innerText(): Promise<string> { return this.generatingLocator ? "" : this.message().text; }
  public async textContent(): Promise<string> { return this.generatingLocator ? "" : this.message().text; }
}

function makePage(messages: FakeMessage[], generating = false): Page {
  return new FakeConversationPage(messages, generating) as unknown as Page;
}

function reviewMessage(reviewRequestId: string): string {
  return `Review this change.\nreview_request_id: ${reviewRequestId}\nPlease review it.`;
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
  it("ignores a historical assistant response when the current request has no response", async () => {
    const page = makePage([
      { role: "user", text: "old request" },
      { role: "assistant", text: "old response" },
      { role: "user", text: reviewMessage("review-001") },
    ]);

    await expect(new ChatGPTCompletionDetector({ timeoutMs: 10, pollIntervalMs: 1 })
      .waitForCompletion(page, { reviewRequestId: "review-001" }))
      .resolves.toMatchObject({ status: "TIMEOUT" });
  });

  it("times out without falling back to history when the request message is absent", async () => {
    const page = makePage([
      { role: "user", text: "old request" },
      { role: "assistant", text: "old response" },
    ]);

    await expect(new ChatGPTCompletionDetector({ timeoutMs: 10, pollIntervalMs: 1 })
      .waitForCompletion(page, { reviewRequestId: "review-001" }))
      .resolves.toMatchObject({ status: "TIMEOUT" });
  });

  it("does not complete while the correlated response is generating", async () => {
    const page = makePage([
      { role: "user", text: "old request" },
      { role: "assistant", text: "old response" },
      { role: "user", text: reviewMessage("review-001") },
      { role: "assistant", text: "partial response", generating: true },
    ], true);

    await expect(new ChatGPTCompletionDetector({ timeoutMs: 10, pollIntervalMs: 1 })
      .waitForCompletion(page, { reviewRequestId: "review-001" }))
      .resolves.toMatchObject({ status: "TIMEOUT" });
  });

  it("returns the ordered index of the correlated assistant response", async () => {
    const page = makePage([
      { role: "user", text: "old request" },
      { role: "assistant", text: "old response" },
      { role: "user", text: reviewMessage("review-a") },
      { role: "assistant", text: "review A result" },
      { role: "user", text: reviewMessage("review-b") },
      { role: "assistant", text: "review B result" },
    ]);

    const detected = await new ChatGPTCompletionDetector({ timeoutMs: 100, pollIntervalMs: 1 })
      .waitForCompletion(page, { reviewRequestId: "review-b" });
    expect(detected).toEqual({ status: "COMPLETED", assistantMessageIndex: 5 });
  });
});

describe("Review result extractor", () => {
  it("extracts only the correlated assistant response", async () => {
    const page = makePage([
      { role: "user", text: "old request" },
      { role: "assistant", text: "old response" },
      { role: "user", text: reviewMessage("review-001") },
      { role: "assistant", text: "current review result" },
    ]);

    const detected = await new ChatGPTCompletionDetector({ timeoutMs: 100, pollIntervalMs: 1 })
      .waitForCompletion(page, { reviewRequestId: "review-001" });
    if (detected.status !== "COMPLETED") throw new Error("expected a completed response");
    await expect(new ChatGPTResultExtractor().extract(page, {
      reviewRequestId: "review-001",
      assistantMessageIndex: detected.assistantMessageIndex,
    })).resolves.toMatchObject({
      status: "COMPLETED",
      content: "current review result",
    });
  });

  it("rejects an empty correlated assistant response", async () => {
    const page = makePage([
      { role: "user", text: reviewMessage("review-001") },
      { role: "assistant", text: "" },
    ]);

    await expect(new ChatGPTResultExtractor().extract(page, {
      reviewRequestId: "review-001",
      assistantMessageIndex: 1,
    })).rejects.toThrow("assistant response was empty");
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

  it("rejects a stored result whose identity does not match its file", async () => {
    const storageRoot = await makeStorageRoot();
    const { request, delivery } = await makeDeliveredChain(storageRoot);
    const service = new ReviewResultService(storageRoot);
    const result = await service.createReviewResult({
      review_request_id: request.review_request_id,
      delivery_id: delivery.delivery_id,
      workspace_id: request.workspace_id,
      status: "COMPLETED",
      content: "review result",
    });
    await writeFile(
      join(
        storageRoot,
        ".task",
        "review_results",
        "workspace-a",
        result.result_id + ".json",
      ),
      JSON.stringify({ ...result, result_id: "result-002" }),
    );

    await expect(service.getReviewResult("workspace-a", result.result_id))
      .rejects.toThrow(/invalid/iu);
  });
});

describe("ReviewCompletionRouter", () => {
  it("passes the request identity, stores the result, and is idempotent", async () => {
    const storageRoot = await makeStorageRoot();
    const { request, routing, delivery } = await makeDeliveredChain(storageRoot);
    let calls = 0;
    let requestedReviewId = "";
    const router = new ReviewCompletionRouter(storageRoot, new BrowserWorkerReviewCompletionAdapter({
      collectCompletion: async (conversationId: string, reviewRequestId: string) => {
        calls += 1;
        requestedReviewId = reviewRequestId;
        return {
          conversationId,
          status: "COMPLETED" as const,
          content: "review result",
          extractedAt: new Date().toISOString(),
        };
      },
    }));

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
    expect(requestedReviewId).toBe(request.review_request_id);
    await expect(new ReviewRequestService(storageRoot)
      .getReviewRequest("workspace-a", request.review_request_id))
      .resolves.toMatchObject({ status: "completed" });
  });

  it("keeps one result record when a timeout is retried successfully", async () => {
    const storageRoot = await makeStorageRoot();
    const { request, routing } = await makeDeliveredChain(storageRoot);
    let timedOut = true;
    const router = new ReviewCompletionRouter(storageRoot, new BrowserWorkerReviewCompletionAdapter({
      collectCompletion: async (conversationId: string, _reviewRequestId: string) => timedOut
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
    }));

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
  it("posts both conversation and review request identities", async () => {
    let requestBody: unknown;
    let requestPath: string | undefined;
    const listener = createServer(async (request, response) => {
      requestPath = request.url;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        conversationId: "conversation-001",
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
      }).collectCompletion("conversation-001", "review-001")).resolves.toMatchObject({
        conversationId: "conversation-001",
        status: "COMPLETED",
        content: "review result",
      });
      expect(requestPath).toBe("/conversation/completion");
      expect(requestBody).toEqual({
        conversationId: "conversation-001",
        reviewRequestId: "review-001",
      });
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
