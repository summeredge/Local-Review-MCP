import type { Locator, Page } from "playwright";
import { CHATGPT_ASSISTANT_MESSAGE_SELECTOR } from "../selectors/chatgpt.js";
import type { ReviewResult, ReviewResultExtractor } from "./types.js";

async function readText(locator: Locator): Promise<string> {
  try {
    return (await locator.innerText()).trim();
  } catch {
    return (await locator.textContent() ?? "").trim();
  }
}

export class ChatGPTResultExtractor implements ReviewResultExtractor {
  public async extract(page: Page): Promise<ReviewResult> {
    const messages = page.locator(CHATGPT_ASSISTANT_MESSAGE_SELECTOR);
    const count = await messages.count();
    if (count === 0) throw new Error("ChatGPT assistant response was not found.");

    const content = await readText(messages.nth(count - 1));
    if (content === "") throw new Error("ChatGPT assistant response was empty.");

    return {
      status: "COMPLETED",
      content,
      extractedAt: new Date().toISOString(),
    };
  }
}

export type { ReviewResult, ReviewResultExtractor } from "./types.js";
