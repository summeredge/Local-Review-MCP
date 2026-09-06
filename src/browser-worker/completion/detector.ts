import type { Locator, Page } from "playwright";
import {
  CHATGPT_ASSISTANT_MESSAGE_SELECTOR,
  CHATGPT_GENERATING_SELECTORS,
} from "../selectors/chatgpt.js";
import type { CompletionResult, ReviewCompletionDetector } from "./types.js";

export const DEFAULT_COMPLETION_TIMEOUT_MS = 30_000;
export const DEFAULT_COMPLETION_POLL_INTERVAL_MS = 250;
const COMPLETION_STABLE_POLLS = 2;

export interface ReviewCompletionDetectorOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
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

async function latestAssistantText(page: Page): Promise<string | undefined> {
  const messages = page.locator(CHATGPT_ASSISTANT_MESSAGE_SELECTOR);
  const count = await messages.count();
  if (count === 0) return undefined;
  return readText(messages.nth(count - 1));
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

  public async waitForCompletion(page: Page): Promise<CompletionResult> {
    const deadline = Date.now() + this.timeoutMs;
    let previousText: string | undefined;
    let stablePolls = 0;
    let assistantSeen = false;

    do {
      try {
        const text = await latestAssistantText(page);
        assistantSeen ||= text !== undefined;
        const generating = await hasVisibleMatch(page, CHATGPT_GENERATING_SELECTORS);
        if (text !== undefined && text !== "" && !generating) {
          stablePolls = text === previousText ? stablePolls + 1 : 1;
          previousText = text;
          if (stablePolls >= COMPLETION_STABLE_POLLS) return { status: "COMPLETED" };
        } else {
          previousText = text;
          stablePolls = 0;
        }
      } catch (error: unknown) {
        return {
          status: "FAILED",
          error: error instanceof Error && error.message.length > 0
            ? error.message.slice(0, 4000)
            : "ChatGPT assistant response could not be inspected.",
        };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await wait(Math.min(this.pollIntervalMs, remaining));
    } while (true);

    return {
      status: "TIMEOUT",
      error: assistantSeen
        ? "ChatGPT assistant response did not finish before the timeout."
        : "ChatGPT assistant response did not appear before the timeout.",
    };
  }
}

export type { CompletionResult, ReviewCompletionDetector } from "./types.js";
