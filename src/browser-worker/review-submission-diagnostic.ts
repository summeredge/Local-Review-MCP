import type { BrowserContext, Page } from "playwright";
import { rm } from "node:fs/promises";
import { join } from "node:path";
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

async function post(worker: BrowserWorker, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${worker.port}/conversation/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await response.json() as Record<string, unknown>;
}

export async function generateReviewSubmissionExample(): Promise<ReviewSubmissionDiagnosticResult> {
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
    const submitted = await post(worker, {
      conversationId: "diagnostic-conversation",
      message: "请 review 这次修改。\n中文 message",
    });
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

    if (submitted.status !== "SUBMITTED"
      || authRequired.status !== "AUTH_REQUIRED"
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
  }
}
