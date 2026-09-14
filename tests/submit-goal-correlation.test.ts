import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://chatgpt.com";
const CONVERSATION = "11111111-2222-3333-4444-555555555555";
const KEY_A = "00000000-0000-4000-8000-000000000001";
const KEY_B = "00000000-0000-4000-8000-000000000002";

let fiberSource = "";
let contentSource = "";

beforeAll(async () => {
  [fiberSource, contentSource] = await Promise.all([
    readFile("extension/fiber.js", "utf8"),
    readFile("extension/content.js", "utf8"),
  ]);
});

interface PageWindow {
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
  removeEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
  postMessage(data: unknown, targetOrigin: string): void;
  [key: string]: unknown;
}

function pageWindow(): PageWindow {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const window: PageWindow = {
    addEventListener(type, listener) {
      const held = listeners.get(type) ?? new Set();
      held.add(listener);
      listeners.set(type, held);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    postMessage(data, targetOrigin) {
      if (targetOrigin !== ORIGIN) return;
      for (const listener of listeners.get("message") ?? []) {
        listener({ source: window, origin: ORIGIN, data });
      }
    },
  };
  return window;
}

function request(id: string, tool: string, correlationKey?: string): Record<string, unknown> {
  return {
    id,
    author: { role: "assistant" },
    recipient: "api_tool.call_tool",
    content: {
      content_type: "code",
      text: JSON.stringify({
        path: `/Local-Review-MCP/link_test/${tool}`,
        args: correlationKey === undefined ? {} : { correlation_key: correlationKey },
      }),
    },
    metadata: { request_id: "request-trace-not-used" },
  };
}

function fiberSection(messages: unknown[]): Record<string, unknown> {
  let model: Record<string, unknown> = {
    memoizedProps: { conversation: { id: CONVERSATION }, turn: { id: "turn-1", messages } },
    return: null,
  };
  for (let depth = 0; depth < 30; depth += 1) {
    model = { memoizedProps: { children: null }, return: model };
  }
  return { __reactFiber$test: model, getAttribute: () => "turn-1" };
}

function scanFiber(messages: unknown[]): Record<string, any> {
  const window = pageWindow();
  vm.runInNewContext(fiberSource, {
    window,
    document: { querySelectorAll: () => [fiberSection(messages)] },
    location: { origin: ORIGIN },
  }, { filename: "fiber.js" });
  let reply: Record<string, any> | undefined;
  window.addEventListener("message", (event) => {
    if ((event.data as Record<string, unknown>)?.source === "lrm-extension-identity-reply") {
      reply = event.data as Record<string, any>;
    }
  });
  window.postMessage({ source: "lrm-extension-identity-ask", nonce: "test" }, ORIGIN);
  if (reply === undefined) throw new Error("Fiber helper did not answer");
  return reply;
}

async function contentMessages(reply: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const messages: Record<string, unknown>[] = [];
  const location = { origin: ORIGIN, href: `${ORIGIN}/c/${CONVERSATION}` };
  const window: PageWindow = {
    addEventListener(type, listener) {
      const held = listeners.get(type) ?? new Set();
      held.add(listener);
      listeners.set(type, held);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    postMessage(data, targetOrigin) {
      if (targetOrigin !== ORIGIN || (data as Record<string, unknown>)?.source !== "lrm-extension-identity-ask") return;
      for (const listener of listeners.get("message") ?? []) {
        listener({
          source: window,
          origin: ORIGIN,
          data: { ...reply, source: "lrm-extension-identity-reply", nonce: (data as Record<string, unknown>).nonce },
        });
      }
    },
  };
  vm.runInNewContext(contentSource, {
    window,
    location,
    history: { pushState() {}, replaceState() {} },
    document: { documentElement: {} },
    chrome: { runtime: { sendMessage(message: Record<string, unknown>, callback: (value: object) => void) {
      messages.push(structuredClone(message));
      callback(message.type === "register_document"
        ? { ok: true, document_id: "document-a", navigation_epoch: 0 }
        : { ok: true });
    } } },
    MutationObserver: undefined,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
  }, { filename: "content.js" });
  await new Promise((resolve) => setTimeout(resolve, 220));
  return messages;
}

describe("Extension submit_goal correlation evidence", () => {
  it("extracts each strict submit_goal key independently", () => {
    const reply = scanFiber([
      request("submit-a", "submit_goal", KEY_A),
      request("submit-b", "submit_goal", KEY_B),
    ]);
    const keys = reply.evidence.map((entry: Record<string, unknown>) => entry.request_id);
    expect(keys).toEqual(expect.arrayContaining([KEY_A, KEY_B]));
    expect(keys.filter((key: string) => key === KEY_A)).toHaveLength(1);
    expect(keys.filter((key: string) => key === KEY_B)).toHaveLength(1);
  });

  it("rejects invalid keys, other tools, and text-only injection", () => {
    const reply = scanFiber([
      request("invalid", "submit_goal", "00000000-0000-1000-8000-000000000003"),
      request("other", "workspace_info", KEY_A),
      { author: { role: "user" }, content: { content_type: "text", parts: [`correlation_key=${KEY_A}`] } },
    ]);
    const keys = reply.evidence.map((entry: Record<string, unknown>) => entry.request_id);
    expect(keys).toContain("request-trace-not-used");
    expect(keys).not.toContain(KEY_A);
  });

  it("passes the submit_goal key through the identity-evidence content path", async () => {
    const messages = await contentMessages(scanFiber([request("submit", "submit_goal", KEY_A)]));
    expect(messages).toContainEqual({
      type: "identity_evidence",
      request_id: KEY_A,
      conversation_id: CONVERSATION,
      navigation_epoch: 0,
    });
  });
});
