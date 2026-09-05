import type { BrowserContext, Page } from "playwright";
import { conversationUrl } from "../../delivery/conversation-url.js";

export { conversationUrl };

export interface BrowserContextProvider {
  initialize(): Promise<BrowserContext>;
}

export interface NavigationResult {
  readonly conversationId: string;
  readonly url?: string;
  readonly status: "NAVIGATED" | "FAILED";
  readonly error?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 4000);
  return String(error).slice(0, 4000);
}

export class ConversationNavigator implements ConversationNavigator {
  public constructor(private readonly browserProfile: BrowserContextProvider) {}

  public async navigate(conversationId: string): Promise<NavigationResult> {
    let url: string;
    try {
      url = conversationUrl(conversationId);
    } catch (error: unknown) {
      return {
        conversationId,
        status: "FAILED",
        error: errorMessage(error),
      };
    }

    let page: Page | undefined;
    try {
      const context = await this.browserProfile.initialize();
      page = await context.newPage();
      const response = await page.goto(url);
      const statusCode = response?.status();
      if (statusCode !== undefined && statusCode >= 400) {
        return {
          conversationId,
          url,
          status: "FAILED",
          error: `Conversation navigation returned HTTP ${statusCode}.`,
        };
      }
      return { conversationId, url, status: "NAVIGATED" };
    } catch (error: unknown) {
      return {
        conversationId,
        url,
        status: "FAILED",
        error: errorMessage(error),
      };
    } finally {
      if (page !== undefined && typeof page.close === "function") {
        await page.close().catch(() => undefined);
      }
    }
  }
}
