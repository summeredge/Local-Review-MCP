import type { Locator, Page } from "playwright";
import {
  CHATGPT_COMPOSER_SELECTORS,
  ComposerLocator,
  type ComposerLocatorResult,
} from "./composer-locator.js";
import type { BrowserDeliveryStatus } from "../protocol.js";

export const DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS = 2_000;
export const DEFAULT_SUBMISSION_CONFIRMATION_POLL_MS = 50;

const AUTHENTICATION_SELECTORS = [
  'a[href*="/auth/login"]',
  'a[href*="/login"]',
  'a[href*="/log-in"]',
  '[data-testid="login-button"]',
  'button[data-testid="login-button"]',
  'form[action*="/login"]',
  'form[action*="/log-in"]',
] as const;

export type ChatGPTInteractionResult =
  | { readonly status: "SUBMITTED" }
  | {
    readonly status: Exclude<BrowserDeliveryStatus, "SUBMITTED" | "CONVERSATION_NOT_FOUND">;
    readonly error: string;
  };

export interface ChatGPTInteractionOptions {
  readonly composerLocator?: ComposerLocator;
  readonly confirmationTimeoutMs?: number;
  readonly confirmationPollMs?: number;
}

function optionNumber(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("ChatGPT interaction timing options must be non-negative integers.");
  }
  return value;
}

async function readComposerValue(input: Locator): Promise<string | undefined> {
  try {
    return await input.inputValue();
  } catch {
    try {
      return await input.textContent() ?? "";
    } catch {
      return undefined;
    }
  }
}

async function hasVisibleMatch(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    try {
      const matches = page.locator(selector);
      const count = await matches.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = index === 0 ? matches : matches.nth(index);
        if (await candidate.isVisible().catch(() => false)) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function isAuthenticationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "auth.openai.com"
      || /\/(?:auth\/login|login|log-in)(?:\/|$)/iu.test(url.pathname);
  } catch {
    return false;
  }
}

async function isAuthRequired(page: Page): Promise<boolean> {
  const currentUrl = typeof page.url === "function" ? page.url() : "";
  return isAuthenticationUrl(currentUrl) || await hasVisibleMatch(page, AUTHENTICATION_SELECTORS);
}

async function userMessageCount(page: Page): Promise<number> {
  try {
    return await page.locator('[data-message-author-role="user"]').count();
  } catch {
    return 0;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ChatGPTInteraction {
  private readonly composerLocator: ComposerLocator;
  private readonly confirmationTimeoutMs: number;
  private readonly confirmationPollMs: number;

  public constructor(options: ChatGPTInteractionOptions = {}) {
    this.composerLocator = options.composerLocator ?? new ComposerLocator();
    this.confirmationTimeoutMs = optionNumber(
      options.confirmationTimeoutMs,
      DEFAULT_SUBMISSION_CONFIRMATION_TIMEOUT_MS,
    );
    this.confirmationPollMs = optionNumber(
      options.confirmationPollMs,
      DEFAULT_SUBMISSION_CONFIRMATION_POLL_MS,
    );
  }

  public async submitMessage(
    page: Page,
    message: string,
  ): Promise<ChatGPTInteractionResult> {
    if (await isAuthRequired(page)) {
      return { status: "AUTH_REQUIRED", error: "ChatGPT authentication is required." };
    }

    let located: ComposerLocatorResult;
    try {
      located = await this.composerLocator.locate(page);
    } catch {
      return {
        status: "COMPOSER_NOT_FOUND",
        error: "ChatGPT composer could not be inspected.",
      };
    }
    if (located.status !== "READY") {
      if (await isAuthRequired(page)) {
        return { status: "AUTH_REQUIRED", error: "ChatGPT authentication is required." };
      }
      return located;
    }

    const beforeUserMessages = await userMessageCount(page);
    try {
      await located.input.fill(message);
    } catch {
      return {
        status: "SUBMIT_FAILED",
        error: "Review message could not be written to the ChatGPT composer.",
      };
    }

    if (await readComposerValue(located.input) !== message) {
      return {
        status: "SUBMIT_FAILED",
        error: "ChatGPT composer did not contain the requested review message.",
      };
    }

    if (!await located.sendButton.isEnabled().catch(() => false)) {
      return { status: "SUBMIT_FAILED", error: "ChatGPT Send button is not ready." };
    }

    try {
      await located.sendButton.click();
    } catch {
      return { status: "SUBMIT_FAILED", error: "ChatGPT review message could not be submitted." };
    }

    const deadline = Date.now() + this.confirmationTimeoutMs;
    do {
      const cleared = await readComposerValue(located.input);
      if (cleared === "" || await userMessageCount(page) > beforeUserMessages) {
        return { status: "SUBMITTED" };
      }
      if (Date.now() >= deadline) break;
      await wait(this.confirmationPollMs);
    } while (true);

    return {
      status: "SUBMIT_FAILED",
      error: "ChatGPT did not confirm accepting the review message.",
    };
  }
}

export { CHATGPT_COMPOSER_SELECTORS };
