import type { Locator, Page } from "playwright";

export const CHATGPT_COMPOSER_SELECTORS = [
  'textarea[aria-label*="message" i]',
  'textarea[placeholder*="message" i]',
  'textarea#prompt-textarea',
  'textarea',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
  '[role="textbox"]',
] as const;

export const CHATGPT_SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send message" i]',
  'button[aria-label="Send prompt" i]',
  'button[aria-label*="send" i]',
  'button[type="submit"]',
] as const;

export type ComposerLocatorResult =
  | {
    readonly status: "READY";
    readonly input: Locator;
    readonly sendButton: Locator;
  }
  | {
    readonly status: "COMPOSER_NOT_FOUND";
    readonly error: string;
  };

async function firstUsable(
  page: Page,
  selectors: readonly string[],
  requireEditable: boolean,
): Promise<Locator | undefined> {
  for (const selector of selectors) {
    let matches: Locator;
    try {
      matches = page.locator(selector);
    } catch {
      continue;
    }
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = count === 1 ? matches : matches.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      if (requireEditable && !await candidate.isEditable().catch(() => false)) continue;
      return candidate;
    }
  }
  return undefined;
}

export class ComposerLocator {
  public async locate(page: Page): Promise<ComposerLocatorResult> {
    const input = await firstUsable(page, CHATGPT_COMPOSER_SELECTORS, true);
    if (input === undefined) {
      return {
        status: "COMPOSER_NOT_FOUND",
        error: "ChatGPT composer input was not found.",
      };
    }

    const sendButton = await firstUsable(page, CHATGPT_SEND_BUTTON_SELECTORS, false);
    if (sendButton === undefined) {
      return {
        status: "COMPOSER_NOT_FOUND",
        error: "ChatGPT composer send button was not found.",
      };
    }

    return { status: "READY", input, sendButton };
  }
}
