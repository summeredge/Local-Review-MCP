import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import { beforeAll, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://chatgpt.com";
const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const command = {
  delivery_id: "32ca0d45-8b29-414a-bbe4-8e26c3aae911",
  conversation_id: A,
  message: "send exactly once",
  deadline: Date.now() + 30_000,
};

let contentSource = "";
let domSource = "";

beforeAll(async () => {
  [contentSource, domSource] = await Promise.all([
    readFile("extension/content.js", "utf8"),
    readFile("extension/chatgpt-dom.js", "utf8"),
  ]);
});

interface DomMock {
  ready(): boolean;
  insertPrompt(message: string): boolean;
  clearPromptExact(message: string): boolean;
  send(message: string, current: () => boolean): Promise<{ clicked: boolean; message_id: string | null }>;
}

function contentHarness(
  dom: DomMock,
  responder: (message: Record<string, unknown>) => unknown | Promise<unknown>,
): {
  messages: Record<string, unknown>[];
  navigate(conversation: string): void;
} {
  const messages: Record<string, unknown>[] = [];
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const location = { origin: ORIGIN, href: `${ORIGIN}/c/${A}` };
  const window = {
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      const held = listeners.get(type) ?? new Set();
      held.add(listener);
      listeners.set(type, held);
    },
    removeEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      listeners.get(type)?.delete(listener);
    },
    postMessage(data: unknown) {
      if (!data || typeof data !== "object") return;
      const record = data as Record<string, unknown>;
      if (record.source !== "lrm-extension-identity-ask") return;
      for (const listener of listeners.get("message") ?? []) {
        listener({
          source: window,
          origin: ORIGIN,
          data: { source: "lrm-extension-identity-reply", version: 1, nonce: record.nonce, evidence: [] },
        });
      }
    },
  };
  const history = {
    pushState(_state: unknown, _title: string, path: string) {
      location.href = new URL(path, location.href).href;
    },
    replaceState(_state: unknown, _title: string, path: string) {
      location.href = new URL(path, location.href).href;
    },
  };
  const chrome = {
    runtime: {
      sendMessage(message: Record<string, unknown>, callback: (reply: unknown) => void) {
        messages.push(structuredClone(message));
        void Promise.resolve(responder(message)).then(callback);
      },
    },
  };
  vm.runInNewContext(contentSource, {
    window,
    location,
    history,
    document: { documentElement: {} },
    chrome,
    LRM_DOM: dom,
    URL,
    Math,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    MutationObserver: undefined,
  }, { filename: "content.js" });
  return {
    messages,
    navigate(conversation) { history.pushState({}, "", `/c/${conversation}`); },
  };
}

async function waitForMessage(
  messages: Record<string, unknown>[],
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("message not observed");
}

function readyDom(sendResult: { clicked: boolean; message_id: string | null }): DomMock & {
  insertPrompt: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  return {
    ready: () => true,
    insertPrompt: vi.fn(() => true),
    clearPromptExact: vi.fn(() => true),
    send: vi.fn(async () => sendResult),
  };
}

describe("Extension delivery content fence", () => {
  it("does not claim while the composer is non-empty or ChatGPT is generating", async () => {
    const messages: Record<string, unknown>[] = [];
    const harness = contentHarness({
      ready: () => false,
      insertPrompt: () => { throw new Error("must not insert"); },
      clearPromptExact: () => false,
      send: async () => { throw new Error("must not send"); },
    }, async (message) => {
      messages.push(message);
      return { ok: true };
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.messages.some((message) => message.type === "delivery_claim")).toBe(false);
  });

  it("ACKs sent only with the exact observed ChatGPT message id", async () => {
    const dom = readyDom({ clicked: true, message_id: "message-one" });
    const harness = contentHarness(dom, (message) =>
      message.type === "delivery_claim" ? { ok: true, command } : { ok: true });
    const ack = await waitForMessage(harness.messages, (message) => message.type === "delivery_ack");
    expect(ack).toMatchObject({
      delivery_id: command.delivery_id,
      status: "sent",
      message_id: "message-one",
      navigation_epoch: 0,
    });
    expect(dom.send).toHaveBeenCalledTimes(1);
  });

  it("treats a click without a stable message receipt as ambiguous", async () => {
    const dom = readyDom({ clicked: true, message_id: null });
    const harness = contentHarness(dom, (message) =>
      message.type === "delivery_claim" ? { ok: true, command } : { ok: true });
    await expect(waitForMessage(harness.messages, (message) => message.type === "delivery_ack"))
      .resolves.toMatchObject({ status: "ambiguous" });
  });

  it("blocks an old command across A to B to A navigation epochs", async () => {
    let release!: (value: unknown) => void;
    const claim = new Promise((resolve) => { release = resolve; });
    const dom = readyDom({ clicked: true, message_id: "must-not-send" });
    const harness = contentHarness(dom, (message) =>
      message.type === "delivery_claim" ? claim : { ok: true });
    await waitForMessage(harness.messages, (message) => message.type === "delivery_claim");
    harness.navigate(B);
    harness.navigate(A);
    release({ ok: true, command });
    await waitForMessage(harness.messages, (message) => message.type === "delivery_ack");
    expect(dom.insertPrompt).not.toHaveBeenCalled();
    expect(dom.send).not.toHaveBeenCalled();
  });
});

interface FakeNode {
  textContent: string;
  isConnected?: boolean;
  disabled?: boolean;
  parentElement?: FakeNode | null;
  closest(selector: string): FakeNode | null;
  querySelector(selector: string): FakeNode | null;
  querySelectorAll(selector: string): FakeNode[];
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  focus(): void;
  dispatchEvent(event: unknown): boolean;
  click(): void;
}

function domHarness(): {
  dom: {
    ready(): boolean;
    insertPrompt(message: string): boolean;
    send(message: string, current: () => boolean, timeoutMs: number): Promise<unknown>;
  };
  composer: FakeNode;
  setAttachment(value: boolean): void;
  setStop(value: boolean): void;
  setClickReceipt(id: string | null): void;
} {
  let attachment = false;
  let stop = false;
  let clickReceipt: string | null = null;
  let observer: (() => void) | null = null;
  const users: FakeNode[] = [];
  const form = node();
  const composer = node();
  composer.isConnected = true;
  composer.parentElement = form;
  composer.closest = (selector) => selector === "form" ? form : null;
  form.querySelector = () => attachment ? node() : null;
  const button = node();
  button.click = () => {
    if (!clickReceipt) return;
    const message = node(command.message);
    message.hasAttribute = (name) => name === "data-message-id";
    message.getAttribute = (name) => name === "data-message-id" ? clickReceipt : null;
    message.querySelectorAll = (selector) => selector === ".whitespace-pre-wrap" ? [node(command.message)] : [];
    users.push(message);
    observer?.();
  };
  const document = {
    documentElement: {},
    querySelector(selector: string) {
      if (selector === "#prompt-textarea") return composer;
      if (selector.includes("stop-button")) return stop ? node() : null;
      if (selector.includes("send-button")) return button;
      return null;
    },
    querySelectorAll(selector: string) {
      return selector === '[data-message-author-role="user"]' ? users : [];
    },
    execCommand(action: string, _ui: boolean, value?: string) {
      if (action === "insertText") composer.textContent = value ?? "";
      if (action === "delete") composer.textContent = "";
      return true;
    },
  };
  class Observer {
    public constructor(callback: () => void) { observer = callback; }
    public observe(): void {}
    public disconnect(): void {}
  }
  class EventInput {
    public constructor(_type: string, _options: unknown) {}
  }
  const context = vm.createContext({ document, MutationObserver: Observer, InputEvent: EventInput, setTimeout, clearTimeout });
  vm.runInContext(domSource, context, { filename: "chatgpt-dom.js" });
  return {
    dom: (context as unknown as { LRM_DOM: {
      ready(): boolean;
      insertPrompt(message: string): boolean;
      send(message: string, current: () => boolean, timeoutMs: number): Promise<unknown>;
    } }).LRM_DOM,
    composer,
    setAttachment: (value) => { attachment = value; },
    setStop: (value) => { stop = value; },
    setClickReceipt: (id) => { clickReceipt = id; },
  };
}

function node(textContent = ""): FakeNode {
  return {
    textContent,
    parentElement: null,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    hasAttribute: () => false,
    getAttribute: (name) => name === "contenteditable" ? "true" : null,
    focus: () => undefined,
    dispatchEvent: () => true,
    click: () => undefined,
  };
}

describe("ChatGPT DOM delivery adapter", () => {
  it("protects drafts, attachments, and generating pages", () => {
    const harness = domHarness();
    harness.composer.textContent = "user draft";
    expect(harness.dom.ready()).toBe(false);
    expect(harness.dom.insertPrompt(command.message)).toBe(false);
    expect(harness.composer.textContent).toBe("user draft");
    harness.composer.textContent = "";
    harness.setAttachment(true);
    expect(harness.dom.ready()).toBe(false);
    harness.setAttachment(false);
    harness.setStop(true);
    expect(harness.dom.ready()).toBe(false);
  });

  it("returns only a new exact user-message receipt and never equates click with success", async () => {
    const harness = domHarness();
    expect(harness.dom.insertPrompt(command.message)).toBe(true);
    const missing = await harness.dom.send(command.message, () => true, 1) as { clicked: boolean; message_id: string | null };
    expect(missing).toEqual({ clicked: true, message_id: null });

    harness.setClickReceipt("message-exact");
    const receipt = await harness.dom.send(command.message, () => true, 20) as { clicked: boolean; message_id: string | null };
    expect(receipt).toEqual({ clicked: true, message_id: "message-exact" });
  });
});
