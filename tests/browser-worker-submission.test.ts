import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { BrowserWorker } from "../src/browser-worker/worker.js";
import { defaultBrowserProfileRoot } from "../src/browser-worker/config.js";
import { ChatGPTInteraction } from "../src/browser-worker/interaction/chatgpt-interaction.js";

type Mode = "submitted" | "auth" | "missing" | "not-found" | "submit-failed";

const workers: BrowserWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await rm(join(defaultBrowserProfileRoot(), "browser-worker-submission-test"), {
    recursive: true,
    force: true,
  });
});

function makePage(): { page: Page; state: { mode: Mode; message: string; users: number } } {
  const state = { mode: "submitted" as Mode, message: "", users: 0 };
  const input = {
    count: async () => state.mode === "missing" ? 0 : 1,
    isVisible: async () => true,
    isEditable: async () => true,
    fill: async (value: string) => { state.message = value; },
    inputValue: async () => state.message,
    textContent: async () => state.message,
  };
  const send = {
    count: async () => state.mode === "missing" ? 0 : 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      if (state.mode === "submitted") {
        state.message = "";
        state.users += 1;
      }
    },
  };
  const users = { count: async () => state.users };
  const auth = {
    count: async () => state.mode === "auth" ? 1 : 0,
    isVisible: async () => true,
  };
  const page = {
    goto: vi.fn(async () => state.mode === "not-found" ? { status: () => 404 } : null),
    url: () => state.mode === "auth" ? "https://chatgpt.com/auth/login" : "https://chatgpt.com/c/conversation-001",
    locator: (selector: string) => {
      if (selector === '[data-message-author-role="user"]') return users;
      if (selector.includes("/login") || selector.includes("login-button")) return auth;
      if (selector.startsWith("textarea") || selector.includes("contenteditable")
        || selector.includes("role=\"textbox\"")) return input;
      if (selector.startsWith("button")) return send;
      return { count: async () => 0 };
    },
    close: vi.fn(async () => undefined),
  } as unknown as Page;
  return { page, state };
}

async function post(worker: BrowserWorker, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${worker.port}/conversation/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as unknown };
}

describe("Browser Worker review submission endpoint", () => {
  it("navigates, submits, confirms, and closes the page", async () => {
    const { page, state } = makePage();
    const context = {
      browser: () => undefined,
      newPage: async () => page,
      close: vi.fn(async () => undefined),
    } as unknown as BrowserContext;
    const worker = new BrowserWorker({
      port: 0,
      profileName: "browser-worker-submission-test",
      launchPersistentContext: async () => context,
      interaction: new ChatGPTInteraction({ confirmationTimeoutMs: 0 }),
    });
    workers.push(worker);
    await worker.start();

    const submitted = await post(worker, {
      conversationId: "conversation-001",
      message: "中文 review\nwith multiple lines",
    });
    expect(submitted).toEqual({
      status: 200,
      body: {
        conversationId: "conversation-001",
        url: "https://chatgpt.com/c/conversation-001",
        status: "SUBMITTED",
      },
    });
    expect(state.message).toBe("");
    expect(page.close).toHaveBeenCalledOnce();
    const readyProfile = await fetch(`http://127.0.0.1:${worker.port}/profile`);
    await expect(readyProfile.json()).resolves.toMatchObject({ authStatus: "READY" });

    state.mode = "auth";
    await expect(post(worker, { conversationId: "conversation-001", message: "review" }))
      .resolves.toMatchObject({ status: 200, body: { status: "AUTH_REQUIRED" } });
    const profileResponse = await fetch(`http://127.0.0.1:${worker.port}/profile`);
    await expect(profileResponse.json()).resolves.toMatchObject({ authStatus: "AUTH_REQUIRED" });

    state.mode = "missing";
    await expect(post(worker, { conversationId: "conversation-001", message: "review" }))
      .resolves.toMatchObject({ status: 200, body: { status: "COMPOSER_NOT_FOUND" } });

    state.mode = "not-found";
    await expect(post(worker, { conversationId: "conversation-001", message: "review" }))
      .resolves.toMatchObject({ status: 200, body: { status: "CONVERSATION_NOT_FOUND" } });

    state.mode = "submit-failed";
    await expect(post(worker, { conversationId: "conversation-001", message: "review" }))
      .resolves.toMatchObject({ status: 200, body: { status: "SUBMIT_FAILED" } });
  });
});
