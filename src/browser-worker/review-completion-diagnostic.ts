import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { BrowserWorkerClient } from "../browser-worker-client/browser-worker-client.js";
import { ConversationRoutingService } from "../context/conversation-routing-service.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import { TaskContextService } from "../context/service.js";
import { BrowserWorkerDeliveryAdapter } from "../delivery/browser-worker-delivery-adapter.js";
import { BrowserRouter } from "../router/browser-router.js";
import { ReviewCompletionRouter } from "../router/review-completion-router.js";
import type { ReviewCompletionDetector, ReviewResultExtractor } from "./completion/types.js";
import { defaultBrowserProfileRoot } from "./config.js";
import { BrowserWorker } from "./worker.js";

type DiagnosticMode = "success" | "timeout" | "missing";

export interface ReviewCompletionDiagnosticResult {
  readonly submitted: "SUBMITTED";
  readonly completion: "COMPLETED";
  readonly stored: "COMPLETED";
  readonly timeout: "TIMEOUT";
  readonly response_missing: "FAILED";
  readonly extraction_failure: "FAILED";
}

class DiagnosticPage {
  public mode: DiagnosticMode = "success";
  private message = "";
  private users = 0;

  private readonly input = {
    count: async (): Promise<number> => 1,
    isVisible: async (): Promise<boolean> => true,
    isEditable: async (): Promise<boolean> => true,
    fill: async (value: string): Promise<void> => { this.message = value; },
    inputValue: async (): Promise<string> => this.message,
    textContent: async (): Promise<string> => this.message,
  };

  private readonly send = {
    count: async (): Promise<number> => 1,
    isVisible: async (): Promise<boolean> => true,
    isEnabled: async (): Promise<boolean> => true,
    click: async (): Promise<void> => {
      this.message = "";
      this.users += 1;
    },
  };

  private readonly assistant = {
    count: async (): Promise<number> => this.mode === "success" && this.users === 0 ? 0 : 1,
    nth: (): { innerText: () => Promise<string>; textContent: () => Promise<string> } => ({
      innerText: async (): Promise<string> => this.mode === "missing"
        ? ""
        : "Review result from the diagnostic assistant.",
      textContent: async (): Promise<string> => this.mode === "missing"
        ? ""
        : "Review result from the diagnostic assistant.",
    }),
  };

  public async goto(): Promise<null> { return null; }

  public url(): string {
    return "https://chatgpt.com/c/diagnostic-conversation";
  }

  public locator(selector: string): unknown {
    if (selector === '[data-message-author-role="user"]') {
      return { count: async (): Promise<number> => this.users };
    }
    if (selector === '[data-message-author-role="assistant"]') return this.assistant;
    if (selector.includes("aria-busy") || selector.includes("stop-button")
      || selector.includes("Stop generating")) {
      return {
        count: async (): Promise<number> => this.mode === "timeout" ? 1 : 0,
        isVisible: async (): Promise<boolean> => true,
      };
    }
    if (selector.includes("/login") || selector.includes("login-button")) {
      return { count: async (): Promise<number> => 0, isVisible: async (): Promise<boolean> => false };
    }
    if (selector.startsWith("textarea") || selector.includes("contenteditable")
      || selector.includes('role="textbox"')) return this.input;
    if (selector.startsWith("button")) return this.send;
    return { count: async (): Promise<number> => 0 };
  }

  public async close(): Promise<void> {}
}

async function createChain(storageRoot: string) {
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
  const request = await new ReviewRequestService(storageRoot).createReviewRequest({
    review_request_id: "diagnostic-review",
    task_id: "diagnostic-task",
    execution_id: "diagnostic-execution",
    workspace_id: "diagnostic-workspace",
  });
  const routing = await new ConversationRoutingService(storageRoot).createRouting({
    routing_id: "diagnostic-routing",
    workspace_id: "diagnostic-workspace",
    task_id: "diagnostic-task",
    review_request_id: request.review_request_id,
    conversation_id: "diagnostic-conversation",
  });
  await new ReviewDeliveryService(storageRoot).createDelivery({
    workspace_id: routing.workspace_id,
    task_id: routing.task_id,
    review_request_id: routing.review_request_id,
    routing_id: routing.routing_id,
    conversation_id: routing.conversation_id,
  });
  return { request, routing };
}

async function startWorker(
  page: DiagnosticPage,
  profileName: string,
  options: {
    readonly completionDetector?: ReviewCompletionDetector;
    readonly resultExtractor?: ReviewResultExtractor;
  } = {},
): Promise<BrowserWorker> {
  const context = {
    browser: () => undefined,
    newPage: async (): Promise<Page> => page as unknown as Page,
    close: async (): Promise<void> => undefined,
  } as unknown as BrowserContext;
  const worker = new BrowserWorker({
    port: 0,
    profileName,
    launchPersistentContext: async (): Promise<BrowserContext> => context,
    completionTimeoutMs: 50,
    completionPollIntervalMs: 1,
    ...options,
  });
  await worker.start();
  return worker;
}

async function postCompletion(worker: BrowserWorker): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${worker.port}/conversation/completion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "diagnostic-conversation" }),
  });
  return await response.json() as Record<string, unknown>;
}

export async function generateReviewCompletionExample(): Promise<ReviewCompletionDiagnosticResult> {
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-review-completion-"));
  const workers: Array<{ worker: BrowserWorker; profile: string }> = [];
  try {
    const page = new DiagnosticPage();
    const worker = await startWorker(page, "diagnostic-completion");
    workers.push({ worker, profile: "diagnostic-completion" });
    const { request, routing } = await createChain(storageRoot);
    const client = new BrowserWorkerClient({
      baseUrl: `http://127.0.0.1:${worker.port}`,
      completionTimeoutMs: 1000,
    });
    const delivery = await new BrowserRouter(
      storageRoot,
      new BrowserWorkerDeliveryAdapter(client),
    ).deliver("diagnostic-workspace", routing.routing_id);
    const stored = await new ReviewCompletionRouter(storageRoot, client)
      .collect("diagnostic-workspace", routing.routing_id);

    page.mode = "timeout";
    const timeout = await postCompletion(worker);

    const missingPage = new DiagnosticPage();
    missingPage.mode = "missing";
    const immediateDetector: ReviewCompletionDetector = {
      waitForCompletion: async () => ({ status: "COMPLETED" }),
    };
    const missingWorker = await startWorker(missingPage, "diagnostic-completion-missing", {
      completionDetector: immediateDetector,
    });
    workers.push({ worker: missingWorker, profile: "diagnostic-completion-missing" });
    const responseMissing = await postCompletion(missingWorker);

    const extractionWorker = await startWorker(new DiagnosticPage(), "diagnostic-completion-extraction", {
      completionDetector: immediateDetector,
      resultExtractor: {
        extract: async () => { throw new Error("diagnostic extraction failure"); },
      },
    });
    workers.push({ worker: extractionWorker, profile: "diagnostic-completion-extraction" });
    const extractionFailure = await postCompletion(extractionWorker);

    const reviewRequest = await new ReviewRequestService(storageRoot)
      .getReviewRequest("diagnostic-workspace", request.review_request_id);
    if (delivery.status !== "delivered"
      || stored.status !== "COMPLETED"
      || reviewRequest?.status !== "completed"
      || timeout.status !== "TIMEOUT"
      || responseMissing.status !== "FAILED"
      || extractionFailure.status !== "FAILED") {
      throw new Error("Review completion diagnostic did not verify the full result collection chain.");
    }
    return {
      submitted: "SUBMITTED",
      completion: "COMPLETED",
      stored: "COMPLETED",
      timeout: "TIMEOUT",
      response_missing: "FAILED",
      extraction_failure: "FAILED",
    };
  } finally {
    await Promise.all(workers.map(({ worker }) => worker.stop()));
    await Promise.all(workers.map(({ profile }) => rm(join(defaultBrowserProfileRoot(), profile), {
      recursive: true,
      force: true,
    })));
    await rm(storageRoot, { recursive: true, force: true });
  }
}
