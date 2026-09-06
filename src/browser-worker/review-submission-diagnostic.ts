import type { BrowserContext, Page } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWorkerClient } from "../browser-worker-client/browser-worker-client.js";
import { ConversationRoutingService } from "../context/conversation-routing-service.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import { TaskContextService } from "../context/service.js";
import { BrowserWorkerDeliveryAdapter } from "../delivery/browser-worker-delivery-adapter.js";
import { BrowserRouter } from "../router/browser-router.js";
import { BrowserWorker } from "./worker.js";
import { defaultBrowserProfileRoot } from "./config.js";
import { ChatGPTInteraction } from "./interaction/chatgpt-interaction.js";

type DiagnosticMode = "submitted" | "auth" | "not-found" | "missing" | "submit-failed";

export interface ReviewSubmissionDiagnosticResult {
  readonly submitted: "SUBMITTED";
  readonly auth_required: "AUTH_REQUIRED";
  readonly conversation_not_found: "CONVERSATION_NOT_FOUND";
  readonly composer_not_found: "COMPOSER_NOT_FOUND";
  readonly submit_failed: "SUBMIT_FAILED";
}

class DiagnosticPage {
  public mode: DiagnosticMode = "submitted";
  private message = "";
  private users = 0;
  private readonly submittedMessages: string[] = [];

  public get submittedMessageCount(): number {
    return this.submittedMessages.length;
  }

  public get lastSubmittedMessage(): string | undefined {
    return this.submittedMessages.at(-1);
  }

  private readonly input = {
    count: async (): Promise<number> => this.mode === "missing" ? 0 : 1,
    isVisible: async (): Promise<boolean> => true,
    isEditable: async (): Promise<boolean> => true,
    fill: async (value: string): Promise<void> => { this.message = value; },
    inputValue: async (): Promise<string> => this.message,
    textContent: async (): Promise<string> => this.message,
  };

  private readonly send = {
    count: async (): Promise<number> => this.mode === "missing" ? 0 : 1,
    isVisible: async (): Promise<boolean> => true,
    isEnabled: async (): Promise<boolean> => true,
    click: async (): Promise<void> => {
      if (this.mode === "submitted") {
        this.submittedMessages.push(this.message);
        this.message = "";
        this.users += 1;
      }
    },
  };

  private readonly auth = {
    count: async (): Promise<number> => this.mode === "auth" ? 1 : 0,
    isVisible: async (): Promise<boolean> => true,
  };

  public async goto(): Promise<{ status: () => number } | null> {
    return this.mode === "not-found" ? { status: () => 404 } : null;
  }

  public url(): string {
    return this.mode === "auth"
      ? "https://chatgpt.com/auth/login"
      : "https://chatgpt.com/c/diagnostic-conversation";
  }

  public locator(selector: string): unknown {
    if (selector === '[data-message-author-role="user"]') return { count: async () => this.users };
    if (selector.includes("/login") || selector.includes("login-button")) return this.auth;
    if (selector.startsWith("textarea") || selector.includes("contenteditable")
      || selector.includes("role=\"textbox\"")) return this.input;
    if (selector.startsWith("button")) return this.send;
    return { count: async () => 0 };
  }

  public async close(): Promise<void> {}
}

async function createDeliveryChain(storageRoot: string): Promise<void> {
  await new TaskContextService(storageRoot).createTaskContext({
    task_id: "diagnostic-task",
    workspace_id: "diagnostic-workspace",
    status: "reviewing",
  });
  await new ExecutionContextService(storageRoot).createExecutionContext({
    execution_id: "diagnostic-execution",
    task_id: "diagnostic-task",
    workspace_id: "diagnostic-workspace",
  });
  await new ReviewRequestService(storageRoot).createReviewRequest({
    review_request_id: "diagnostic-review",
    task_id: "diagnostic-task",
    execution_id: "diagnostic-execution",
    workspace_id: "diagnostic-workspace",
  });
  const routing = await new ConversationRoutingService(storageRoot).createRouting({
    routing_id: "diagnostic-routing",
    workspace_id: "diagnostic-workspace",
    task_id: "diagnostic-task",
    review_request_id: "diagnostic-review",
    conversation_id: "diagnostic-conversation",
  });
  await new ReviewDeliveryService(storageRoot).createDelivery({
    workspace_id: routing.workspace_id,
    task_id: routing.task_id,
    review_request_id: routing.review_request_id,
    routing_id: routing.routing_id,
    conversation_id: routing.conversation_id,
  });
}

async function post(worker: BrowserWorker, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${worker.port}/conversation/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await response.json() as Record<string, unknown>;
}

export async function generateReviewSubmissionExample(): Promise<ReviewSubmissionDiagnosticResult> {
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-review-submission-"));
  const mockPage = new DiagnosticPage();
  const page = mockPage as unknown as Page;
  const context = {
    browser: () => undefined,
    newPage: async (): Promise<Page> => page,
    close: async (): Promise<void> => undefined,
  } as unknown as BrowserContext;
  const worker = new BrowserWorker({
    port: 0,
    profileName: "diagnostic-submission",
    launchPersistentContext: async (): Promise<BrowserContext> => context,
    interaction: new ChatGPTInteraction({ confirmationTimeoutMs: 0 }),
  });

  try {
    await worker.start();
    await createDeliveryChain(storageRoot);
    const router = new BrowserRouter(
      storageRoot,
      new BrowserWorkerDeliveryAdapter(new BrowserWorkerClient({
        baseUrl: `http://127.0.0.1:${worker.port}`,
      })),
    );
    const delivered = await router.deliver("diagnostic-workspace", "diagnostic-routing");
    const repeated = await router.deliver("diagnostic-workspace", "diagnostic-routing");
    const reviewRequest = await new ReviewRequestService(storageRoot)
      .getReviewRequest("diagnostic-workspace", "diagnostic-review");
    if (delivered.status !== "delivered"
      || repeated.status !== "delivered"
      || repeated.attempt_count !== 1
      || mockPage.submittedMessageCount !== 1
      || !mockPage.lastSubmittedMessage?.includes("review_request_id: diagnostic-review")
      || reviewRequest?.status !== "pending") {
      throw new Error("Review submission diagnostic did not verify the full delivery chain.");
    }

    mockPage.mode = "auth";
    const authRequired = await post(worker, {
      conversationId: "diagnostic-conversation",
      message: "review",
    });
    mockPage.mode = "not-found";
    const conversationNotFound = await post(worker, {
      conversationId: "diagnostic-conversation",
      message: "review",
    });
    mockPage.mode = "missing";
    const composerNotFound = await post(worker, {
      conversationId: "diagnostic-conversation",
      message: "review",
    });
    mockPage.mode = "submit-failed";
    const submitFailed = await post(worker, {
      conversationId: "diagnostic-conversation",
      message: "review",
    });

    if (authRequired.status !== "AUTH_REQUIRED"
      || conversationNotFound.status !== "CONVERSATION_NOT_FOUND"
      || composerNotFound.status !== "COMPOSER_NOT_FOUND"
      || submitFailed.status !== "SUBMIT_FAILED") {
      throw new Error("Review submission diagnostic returned an invalid status.");
    }
    return {
      submitted: "SUBMITTED",
      auth_required: "AUTH_REQUIRED",
      conversation_not_found: "CONVERSATION_NOT_FOUND",
      composer_not_found: "COMPOSER_NOT_FOUND",
      submit_failed: "SUBMIT_FAILED",
    };
  } finally {
    await worker.stop();
    await rm(join(defaultBrowserProfileRoot(), "diagnostic-submission"), {
      recursive: true,
      force: true,
    });
    await rm(storageRoot, { recursive: true, force: true });
  }
}
