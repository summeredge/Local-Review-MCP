import type { BrowserContext, Page } from "playwright";
import type { NavigationResult } from "../protocol.js";
import { conversationUrl } from "../../delivery/conversation-url.js";

export { conversationUrl };
export type { NavigationResult } from "../protocol.js";

export interface BrowserContextProvider {
  initialize(): Promise<BrowserContext>;
}

export type NavigationFailureCode =
  | "AUTH_REQUIRED"
  | "CONVERSATION_NOT_FOUND"
  | "NAVIGATION_FAILED";

export type NavigationSessionResult =
  | (NavigationResult & {
    readonly status: "NAVIGATED";
    readonly url: string;
    readonly page: Page;
  })
  | (NavigationResult & {
    readonly status: "FAILED";
    readonly failureCode?: NavigationFailureCode;
  });

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 4000);
  return String(error).slice(0, 4000);
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

export class ConversationNavigator {
  public constructor(private readonly browserProfile: BrowserContextProvider) {}

  public async navigate(conversationId: string): Promise<NavigationSessionResult> {
    let url: string;
    try {
      url = conversationUrl(conversationId);
    } catch (error: unknown) {
      return {
        conversationId,
        status: "FAILED",
        error: errorMessage(error),
        failureCode: "NAVIGATION_FAILED",
      };
    }

    let page: Page | undefined;
    let retainPage = false;
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
          error: statusCode === 404
            ? "Conversation was not found."
            : statusCode === 401 || statusCode === 403
              ? "ChatGPT authentication is required."
              : `Conversation navigation returned HTTP ${statusCode}.`,
          failureCode: statusCode === 404
            ? "CONVERSATION_NOT_FOUND"
            : statusCode === 401 || statusCode === 403
              ? "AUTH_REQUIRED"
              : "NAVIGATION_FAILED",
        };
      }
      const currentUrl = typeof page.url === "function" ? page.url() : url;
      if (isAuthenticationUrl(currentUrl)) {
        return {
          conversationId,
          url,
          status: "FAILED",
          error: "ChatGPT authentication is required.",
          failureCode: "AUTH_REQUIRED",
        };
      }
      retainPage = true;
      return { conversationId, url, status: "NAVIGATED", page };
    } catch (error: unknown) {
      return {
        conversationId,
        url,
        status: "FAILED",
        error: errorMessage(error),
        failureCode: "NAVIGATION_FAILED",
      };
    } finally {
      if (page !== undefined && !retainPage && typeof page.close === "function") {
        await page.close().catch(() => undefined);
      }
    }
  }
}
