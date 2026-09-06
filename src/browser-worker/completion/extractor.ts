import type { Locator, Page } from "playwright";
import { CHATGPT_CONVERSATION_MESSAGE_SELECTOR } from "../selectors/chatgpt.js";
import type {
  ReviewResult,
  ReviewResultExtractionOptions,
  ReviewResultExtractor,
} from "./types.js";

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

function isReviewRequestMessage(text: string, reviewRequestId: string): boolean {
  const anchor = `review_request_id: ${reviewRequestId}`;
  return text.split(/\r?\n/u).some((line) => line.trim() === anchor);
}

export class ChatGPTResultExtractor implements ReviewResultExtractor {
  public async extract(
    page: Page,
    options: ReviewResultExtractionOptions,
  ): Promise<ReviewResult> {
    const messages = page.locator(CHATGPT_CONVERSATION_MESSAGE_SELECTOR);
    const count = await messages.count();
    let requestIndex: number | undefined;
    for (let index = 0; index < count; index += 1) {
      const message = messages.nth(index);
      if (await readAttribute(message, "data-message-author-role") !== "user") continue;
      if (isReviewRequestMessage(await readText(message), options.reviewRequestId)) {
        requestIndex = index;
        break;
      }
    }
    if (requestIndex === undefined) {
      throw new Error("Review request message was not found.");
    }
    if (options.assistantMessageIndex <= requestIndex
      || options.assistantMessageIndex >= count) {
      throw new Error("Assistant response no longer follows the review request.");
    }

    const response = messages.nth(options.assistantMessageIndex);
    if (await readAttribute(response, "data-message-author-role") !== "assistant") {
      throw new Error("Review request response is no longer an assistant message.");
    }
    const content = await readText(response);
    if (content === "") throw new Error("ChatGPT assistant response was empty.");

    return {
      status: "COMPLETED",
      content,
      extractedAt: new Date().toISOString(),
    };
  }
}

export type {
  ReviewResult,
  ReviewResultExtractionOptions,
  ReviewResultExtractor,
} from "./types.js";
