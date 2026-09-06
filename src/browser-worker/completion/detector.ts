import type { Locator, Page } from "playwright";
import {
  CHATGPT_CONVERSATION_MESSAGE_SELECTOR,
  CHATGPT_GENERATING_SELECTORS,
} from "../selectors/chatgpt.js";
import type {
  CompletionResult,
  ReviewCompletionDetector,
  ReviewCompletionOptions,
} from "./types.js";

export const DEFAULT_COMPLETION_TIMEOUT_MS = 30_000;
export const DEFAULT_COMPLETION_POLL_INTERVAL_MS = 250;
const COMPLETION_STABLE_POLLS = 2;

export interface ReviewCompletionDetectorOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

interface ConversationMessage {
  readonly index: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly locator: Locator;
}

function timingOption(
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero: boolean,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`Review completion ${name} must be a ${allowZero ? "non-negative" : "positive"} integer.`);
  }
  return value;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readText(locator: Locator): Promise<string> {
  try {
    return (await locator.innerText()).trim();
  } catch {
    return (await locator.textContent() ?? "").trim();
  }
}

async function readAttribute(locator: Locator, name: string): Promise<string | null> {
  return locator.getAttribute(name);
}

async function readConversationMessages(page: Page): Promise<ConversationMessage[]> {
  const messages = page.locator(CHATGPT_CONVERSATION_MESSAGE_SELECTOR);
  const count = await messages.count();
  const result: ConversationMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const locator = messages.nth(index);
    const role = await readAttribute(locator, "data-message-author-role");
    if (role !== "user" && role !== "assistant") continue;
    result.push({ index, role, text: await readText(locator), locator });
  }
  return result;
}

function isReviewRequestMessage(text: string, reviewRequestId: string): boolean {
  const anchor = `review_request_id: ${reviewRequestId}`;
  return text.split(/\r?\n/u).some((line) => line.trim() === anchor);
}

function targetAssistant(
  messages: readonly ConversationMessage[],
  reviewRequestId: string,
): { readonly request: ConversationMessage | undefined; readonly response: ConversationMessage | undefined } {
  const request = messages.find(
    (message) => message.role === "user" && isReviewRequestMessage(message.text, reviewRequestId),
  );
  if (request === undefined) return { request, response: undefined };
  return {
    request,
    response: messages.find(
      (message) => message.index > request.index && message.role === "assistant",
    ),
  };
}

async function hasVisibleMatch(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = await matches.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = count === 1 ? matches : matches.nth(index);
      if (await candidate.isVisible().catch(() => false)) return true;
    }
  }
  return false;
}

async function isGenerating(page: Page, response: ConversationMessage): Promise<boolean> {
  if (await readAttribute(response.locator, "aria-busy") === "true") return true;
  return hasVisibleMatch(page, CHATGPT_GENERATING_SELECTORS);
}

export class ChatGPTCompletionDetector implements ReviewCompletionDetector {
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;

  public constructor(options: ReviewCompletionDetectorOptions = {}) {
    this.timeoutMs = timingOption(options.timeoutMs, DEFAULT_COMPLETION_TIMEOUT_MS, "timeoutMs", true);
    this.pollIntervalMs = timingOption(
      options.pollIntervalMs,
      DEFAULT_COMPLETION_POLL_INTERVAL_MS,
      "pollIntervalMs",
      false,
    );
  }

  public async waitForCompletion(
    page: Page,
    options: ReviewCompletionOptions,
  ): Promise<CompletionResult> {
    const deadline = Date.now() + this.timeoutMs;
    let previousText: string | undefined;
    let stablePolls = 0;
    let requestSeen = false;
    let responseSeen = false;

    do {
      try {
        const messages = await readConversationMessages(page);
        const target = targetAssistant(messages, options.reviewRequestId);
        requestSeen ||= target.request !== undefined;
        responseSeen ||= target.response !== undefined;
        if (target.response !== undefined) {
          const generating = await isGenerating(page, target.response);
          if (target.response.text !== "" && !generating) {
            stablePolls = target.response.text === previousText ? stablePolls + 1 : 1;
            previousText = target.response.text;
            if (stablePolls >= COMPLETION_STABLE_POLLS) {
              return {
                status: "COMPLETED",
                assistantMessageIndex: target.response.index,
              };
            }
          } else {
            previousText = target.response.text;
            stablePolls = 0;
          }
        } else {
          previousText = undefined;
          stablePolls = 0;
        }
      } catch (error: unknown) {
        return {
          status: "FAILED",
          error: error instanceof Error && error.message.length > 0
            ? error.message.slice(0, 4000)
            : "ChatGPT conversation messages could not be inspected.",
        };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await wait(Math.min(this.pollIntervalMs, remaining));
    } while (true);

    return {
      status: "TIMEOUT",
      error: !requestSeen
        ? "Review request message did not appear before the timeout."
        : !responseSeen
          ? "Assistant response for the review request did not appear before the timeout."
          : "Assistant response for the review request did not finish before the timeout.",
    };
  }
}

export {
  CHATGPT_CONVERSATION_MESSAGE_SELECTOR,
} from "../selectors/chatgpt.js";
export type {
  CompletionResult,
  ReviewCompletionDetector,
  ReviewCompletionOptions,
} from "./types.js";
