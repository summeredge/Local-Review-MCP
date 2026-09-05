import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { BrowserWorker } from "../src/browser-worker/worker.js";
import { defaultBrowserProfileRoot } from "../src/browser-worker/config.js";
import {
  ConversationNavigator,
  conversationUrl,
} from "../src/browser-worker/navigation/conversation-navigator.js";

const workers: BrowserWorker[] = [];
const testProfileName = "conversation-navigator-test";

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await rm(join(defaultBrowserProfileRoot(), testProfileName), { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeContext(page: Page): BrowserContext {
  return {
    browser: () => undefined,
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  } as unknown as BrowserContext;
}

describe("ConversationNavigator", () => {
  it("validates conversation IDs without creating a page", async () => {
    const newPage = vi.fn();
    const context = { newPage } as unknown as BrowserContext;
    const navigator = new ConversationNavigator({
      initialize: async (): Promise<BrowserContext> => context,
    });

    await expect(navigator.navigate("../outside")).resolves.toMatchObject({
      conversationId: "../outside",
      status: "FAILED",
      error: expect.stringMatching(/conversation_id/iu),
    });
    expect(newPage).not.toHaveBeenCalled();
    expect(() => conversationUrl("conversation/id")).toThrow(/conversation_id/iu);
  });

  it("constructs the URL, creates a page, and reports navigation", async () => {
    const page = {
      goto: vi.fn(async (): Promise<null> => null),
      close: vi.fn(async (): Promise<void> => undefined),
    } as unknown as Page;
    const context = makeContext(page);
    const initialize = vi.fn(async (): Promise<BrowserContext> => context);
    const navigator = new ConversationNavigator({ initialize });

    await expect(navigator.navigate("conversation-001")).resolves.toEqual({
      conversationId: "conversation-001",
      url: "https://chatgpt.com/c/conversation-001",
      status: "NAVIGATED",
    });
    expect(initialize).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledWith("https://chatgpt.com/c/conversation-001");
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("returns a failed result for browser and HTTP navigation failures", async () => {
    const browserFailurePage = {
      goto: vi.fn(async (): Promise<never> => { throw new Error("network down"); }),
      close: vi.fn(async (): Promise<void> => undefined),
    } as unknown as Page;
    const browserFailure = new ConversationNavigator({
      initialize: async (): Promise<BrowserContext> => makeContext(browserFailurePage),
    });

    await expect(browserFailure.navigate("conversation-failed")).resolves.toEqual({
      conversationId: "conversation-failed",
      url: "https://chatgpt.com/c/conversation-failed",
      status: "FAILED",
      error: "network down",
    });

    const httpFailurePage = {
      goto: vi.fn(async () => ({ status: () => 404 })),
      close: vi.fn(async (): Promise<void> => undefined),
    } as unknown as Page;
    const httpFailure = new ConversationNavigator({
      initialize: async (): Promise<BrowserContext> => makeContext(httpFailurePage),
    });

    await expect(httpFailure.navigate("conversation-missing")).resolves.toMatchObject({
      conversationId: "conversation-missing",
      url: "https://chatgpt.com/c/conversation-missing",
      status: "FAILED",
      error: "Conversation navigation returned HTTP 404.",
    });
  });
});

describe("Browser Worker conversation navigation API", () => {
  it("navigates through the persistent context and returns validation failures", async () => {
    let failNavigation = false;
    const page = {
      goto: vi.fn(async (): Promise<null> => {
        if (failNavigation) throw new Error("navigation unavailable");
        return null;
      }),
      close: vi.fn(async (): Promise<void> => undefined),
    } as unknown as Page;
    const context = makeContext(page);
    const worker = new BrowserWorker({
      port: 0,
      profileName: testProfileName,
      launchPersistentContext: async (): Promise<BrowserContext> => context,
    });
    workers.push(worker);
    await worker.start();

    const successResponse = await fetch(`http://127.0.0.1:${worker.port}/conversation/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "conversation-api" }),
    });
    await expect(successResponse.json()).resolves.toEqual({
      conversationId: "conversation-api",
      url: "https://chatgpt.com/c/conversation-api",
      status: "NAVIGATED",
    });
    expect(successResponse.status).toBe(200);

    failNavigation = true;
    const failedResponse = await fetch(`http://127.0.0.1:${worker.port}/conversation/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "conversation-api-failed" }),
    });
    await expect(failedResponse.json()).resolves.toEqual({
      conversationId: "conversation-api-failed",
      url: "https://chatgpt.com/c/conversation-api-failed",
      status: "FAILED",
      error: "navigation unavailable",
    });
    expect(failedResponse.status).toBe(200);

    const invalidResponse = await fetch(`http://127.0.0.1:${worker.port}/conversation/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "../outside" }),
    });
    await expect(invalidResponse.json()).resolves.toMatchObject({
      conversationId: "../outside",
      status: "FAILED",
      error: expect.stringMatching(/conversation_id/iu),
    });
    expect(invalidResponse.status).toBe(400);
  });
});
