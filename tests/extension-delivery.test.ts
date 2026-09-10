import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildReviewMessage } from "../src/delivery/review-message.js";

const ORIGIN = "https://chatgpt.com";
const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const command = {
  delivery_id: "32ca0d45-8b29-414a-bbe4-8e26c3aae911",
  conversation_id: A,
  message: "send exactly once",
  deadline: Date.now() + 30_000,
};
const MULTILINE_MESSAGE = "Review Request:\r\nfirst paragraph\u00a0with space\r\n\r\nsecond paragraph";
const REVIEW_REQUEST = buildReviewMessage({
  workspace_id: "workspace-local-review",
  task_id: "task-realistic-001",
  execution_id: "execution-realistic-001",
  review_request_id: "review-request-realistic-001",
  routing_id: "routing-realistic-001",
});

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
  insertPrompt(message: string): boolean | Promise<boolean>;
  clearPromptExact(message: string): boolean;
  send(message: string, current: () => boolean, timeoutMs?: number): Promise<{ clicked: boolean; message_id: string | null }>;
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

  it("delivers a multiline block-normalized message only after exact insertion", async () => {
    const deliveredCommand = { ...command, message: MULTILINE_MESSAGE };
    const dom = domHarness({
      blockComposer: true,
      emptyComposerBlock: true,
      normalizeAsync: true,
      message: MULTILINE_MESSAGE,
    });
    expect((dom.composer as FakeNode & { innerText: string }).innerText).toBe("\n");
    expect(dom.dom.ready()).toBe(true);
    dom.setClickReceipt("message-block");
    const harness = contentHarness(dom.dom, (message) =>
      message.type === "delivery_claim" ? { ok: true, command: deliveredCommand } : { ok: true });
    const ack = await waitForMessage(harness.messages, (message) => message.type === "delivery_ack");
    const types = harness.messages.map((message) => message.type);

    expect(ack).toMatchObject({
      delivery_id: command.delivery_id,
      status: "sent",
      message_id: "message-block",
    });
    expect(types).toContain("register_document");
    expect(types).toContain("delivery_claim");
    expect(types.indexOf("delivery_submit_started")).toBeGreaterThan(types.indexOf("delivery_claim"));
    expect(types.indexOf("delivery_ack")).toBeGreaterThan(types.indexOf("delivery_submit_started"));
    expect(dom.composer.textContent).not.toMatch(/\r?\n/u);
    expect(dom.composer.childNodes?.map((node) => node.nodeName)).toEqual(["P", "P", "P", "P"]);
    expect(dom.clickCount()).toBe(1);
  });

  it("ACKs not_sent when insertion cannot prove the complete message", async () => {
    const dom = readyDom({ clicked: true, message_id: "must-not-send" });
    dom.insertPrompt.mockReturnValue(false);
    const harness = contentHarness(dom, (message) =>
      message.type === "delivery_claim" ? { ok: true, command } : { ok: true });
    const ack = await waitForMessage(harness.messages, (message) => message.type === "delivery_ack");

    expect(ack).toMatchObject({ status: "not_sent", error: "composer refused exact message" });
    expect(harness.messages.some((message) => message.type === "delivery_submit_started")).toBe(false);
    expect(dom.send).not.toHaveBeenCalled();
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
  nodeName?: string;
  nodeType?: number;
  nodeValue?: string | null;
  childNodes?: FakeNode[];
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

function domHarness(options: {
  blockComposer?: boolean;
  emptyComposerBlock?: boolean;
  normalizeAsync?: boolean;
  message?: string;
} = {}): {
  dom: {
    ready(): boolean;
    insertPrompt(message: string): boolean | Promise<boolean>;
    clearPromptExact(message: string): boolean;
    send(message: string, current: () => boolean, timeoutMs?: number): Promise<{ clicked: boolean; message_id: string | null }>;
  };
  composer: FakeNode;
  setAttachment(value: boolean): void;
  setStop(value: boolean): void;
  setClickReceipt(id: string | null): void;
  setComposerText(value: string): void;
  setComposerBlocks(blocks: FakeNode[]): void;
  clickCount(): number;
} {
  let attachment = false;
  let stop = false;
  let clickReceipt: string | null = null;
  let clicks = 0;
  let blockNodes: FakeNode[] = options.emptyComposerBlock
    ? [node("", "P", [node("", "BR")])]
    : [];
  let observer: (() => void) | null = null;
  const submittedMessage = options.message ?? command.message;
  const users: FakeNode[] = [];
  const form = node();
  const composer = node();
  composer.isConnected = true;
  composer.parentElement = form;
  composer.closest = (selector) => selector === "form" ? form : null;
  form.querySelector = () => attachment ? node() : null;
  if (options.blockComposer) {
    Object.defineProperty(composer, "childNodes", { configurable: true, get: () => blockNodes });
    Object.defineProperty(composer, "innerText", {
      configurable: true,
      get: () => blockNodes.map((block) => block.nodeName === "P" && block.childNodes?.some((child) => child.nodeName === "BR")
        ? "\n"
        : block.textContent).join(""),
    });
  }
  const blocksForText = (value: string) => value.split("\n").map((line) =>
    line === "" ? node("", "P", [node("", "BR")]) : node(line, "P", [textNode(line)]));
  const setComposerText = (value: string) => {
    if (!options.blockComposer) {
      composer.textContent = value;
      return;
    }
    const normalized = value.replace(/\r\n?/gu, "\n");
    composer.textContent = normalized.replace(/\n/gu, "");
    blockNodes = options.normalizeAsync ? [] : blocksForText(normalized);
    if (options.normalizeAsync) {
      setTimeout(() => { blockNodes = blocksForText(normalized); }, 0);
    }
  };
  const setComposerBlocks = (blocks: FakeNode[]) => {
    blockNodes = blocks;
    composer.textContent = blocks.map((block) => block.textContent).join("");
  };
  const button = node();
  button.click = () => {
    clicks += 1;
    if (!clickReceipt) return;
    const message = node(submittedMessage);
    message.hasAttribute = (name) => name === "data-message-id";
    message.getAttribute = (name) => name === "data-message-id" ? clickReceipt : null;
    message.querySelectorAll = (selector) => selector === ".whitespace-pre-wrap" ? [node(submittedMessage)] : [];
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
      if (action === "insertText") setComposerText(value ?? "");
      if (action === "delete") setComposerText("");
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
      insertPrompt(message: string): boolean | Promise<boolean>;
      clearPromptExact(message: string): boolean;
      send(message: string, current: () => boolean, timeoutMs?: number): Promise<{ clicked: boolean; message_id: string | null }>;
    } }).LRM_DOM,
    composer,
    setAttachment: (value) => { attachment = value; },
    setStop: (value) => { stop = value; },
    setClickReceipt: (id) => { clickReceipt = id; },
    setComposerText,
    setComposerBlocks,
    clickCount: () => clicks,
  };
}

function node(textContent = "", nodeName = "", childNodes?: FakeNode[]): FakeNode {
  return {
    textContent,
    nodeName,
    childNodes,
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

function textNode(value: string): FakeNode {
  return { ...node(value, "#text"), nodeType: 3, nodeValue: value };
}

function paragraph(value: string, children = [textNode(value)]): FakeNode {
  return node(value, "P", children);
}

describe("ChatGPT DOM delivery adapter", () => {
  it("treats only structurally empty composers as ready", () => {
    expect(domHarness().dom.ready()).toBe(true);

    const emptyBlock = domHarness({ blockComposer: true, emptyComposerBlock: true });
    expect((emptyBlock.composer as FakeNode & { innerText: string }).innerText).toBe("\n");
    expect(emptyBlock.dom.ready()).toBe(true);

    for (const text of ["A", " ", "\t", "user draft", "first line\nsecond line"]) {
      const harness = domHarness({ blockComposer: true });
      harness.setComposerText(text);
      expect(harness.dom.ready(), JSON.stringify(text)).toBe(false);
    }
  });

  it("protects drafts, attachments, and generating pages", async () => {
    const harness = domHarness();
    harness.composer.textContent = "user draft";
    expect(harness.dom.ready()).toBe(false);
    await expect(harness.dom.insertPrompt(command.message)).resolves.toBe(false);
    expect(harness.composer.textContent).toBe("user draft");
    harness.composer.textContent = "";
    harness.setAttachment(true);
    expect(harness.dom.ready()).toBe(false);
    harness.setAttachment(false);
    harness.setStop(true);
    expect(harness.dom.ready()).toBe(false);
  });

  it("uses one exact canonical text for multiline block insertion and clearing", async () => {
    const harness = domHarness({ blockComposer: true, normalizeAsync: true });
    await expect(harness.dom.insertPrompt(MULTILINE_MESSAGE)).resolves.toBe(true);
    expect(harness.composer.textContent).not.toMatch(/\r?\n/u);
    expect(harness.composer.childNodes?.map((node) => node.nodeName)).toEqual(["P", "P", "P", "P"]);
    expect(harness.dom.clearPromptExact(MULTILINE_MESSAGE)).toBe(true);
    expect(harness.composer.textContent).toBe("");
  });

  it("proves a complete production Review Request through block insertion, clearing, and send", async () => {
    expect(REVIEW_REQUEST).toContain("workspace_id: workspace-local-review");
    expect(REVIEW_REQUEST).toContain("task_id: task-realistic-001");
    expect(REVIEW_REQUEST).toContain("execution_id: execution-realistic-001");
    expect(REVIEW_REQUEST).toContain("review_request_id: review-request-realistic-001");
    expect(REVIEW_REQUEST).toContain("routing_id: routing-realistic-001");
    expect(REVIEW_REQUEST).toContain("\n\nUse Local Review MCP");
    expect(REVIEW_REQUEST).toContain('\n  "schema_version": 1,');
    expect(REVIEW_REQUEST).toContain("<lrm-review-result>\n");
    expect(REVIEW_REQUEST).toContain("\n</lrm-review-result>");

    const harness = domHarness({ blockComposer: true, normalizeAsync: true, message: REVIEW_REQUEST });
    await expect(harness.dom.insertPrompt(REVIEW_REQUEST)).resolves.toBe(true);
    expect((harness.composer as FakeNode & { innerText: string }).innerText).not.toBe(REVIEW_REQUEST);
    expect(harness.dom.clearPromptExact(REVIEW_REQUEST)).toBe(true);
    expect(harness.composer.textContent).toBe("");

    await expect(harness.dom.insertPrompt(REVIEW_REQUEST)).resolves.toBe(true);
    harness.setClickReceipt("review-request-message");
    await expect(harness.dom.send(REVIEW_REQUEST, () => true, 20)).resolves.toEqual({
      clicked: true,
      message_id: "review-request-message",
    });
  });

  it.each([
    ["a changed blank-line count", REVIEW_REQUEST.replace("routing_id: routing-realistic-001\n\nUse", "routing_id: routing-realistic-001\nUse")],
    ["a changed JSON indentation", REVIEW_REQUEST.replace('  "schema_version"', ' "schema_version"')],
  ])("refuses to send when the production Review Request has %s", async (_label, modified) => {
    const harness = domHarness({ blockComposer: true, message: REVIEW_REQUEST });
    await expect(harness.dom.insertPrompt(REVIEW_REQUEST)).resolves.toBe(true);
    harness.setComposerText(modified);

    await expect(harness.dom.send(REVIEW_REQUEST, () => true, 10)).resolves.toEqual({
      clicked: false,
      message_id: null,
    });
    expect(harness.clickCount()).toBe(0);
  });

  it.each([
    ["adjacent paragraphs", [paragraph("A"), paragraph("B")], "A\nB"],
    ["an empty paragraph between paragraphs", [paragraph("A"), node("", "P", [node("", "BR")]), paragraph("B")], "A\n\nB"],
    ["nested marks", [paragraph("AB", [node("A", "SPAN", [textNode("A")]), node("B", "MARK", [textNode("B")])])], "AB"],
    ["a real block break", [paragraph("AB", [textNode("A"), node("", "BR"), textNode("B")])], "A\nB"],
  ])("reads %s as exact logical text", async (_label, blocks, expected) => {
    const harness = domHarness({ blockComposer: true, message: expected });
    harness.setComposerBlocks(blocks as FakeNode[]);
    harness.setClickReceipt("structured-message");

    await expect(harness.dom.send(expected, () => true, 20)).resolves.toEqual({
      clicked: true,
      message_id: "structured-message",
    });
  });

  it.each([
    ["a missing character", MULTILINE_MESSAGE.slice(0, -1)],
    ["an extra visible character", `${MULTILINE_MESSAGE}!`],
    ["a modified paragraph", MULTILINE_MESSAGE.replace("second paragraph", "changed paragraph")],
  ])("refuses to send when the composer has %s", async (_label, modified) => {
    const harness = domHarness({ blockComposer: true, message: MULTILINE_MESSAGE });
    await expect(harness.dom.insertPrompt(MULTILINE_MESSAGE)).resolves.toBe(true);
    harness.setComposerText(modified);

    await expect(harness.dom.send(MULTILINE_MESSAGE, () => true, 10)).resolves.toEqual({
      clicked: false,
      message_id: null,
    });
    expect(harness.clickCount()).toBe(0);
  });

  it("does not clear a composer after the user changes its exact message", async () => {
    const harness = domHarness({ blockComposer: true });
    await expect(harness.dom.insertPrompt(MULTILINE_MESSAGE)).resolves.toBe(true);
    harness.setComposerText(`${MULTILINE_MESSAGE}!`);

    expect(harness.dom.clearPromptExact(MULTILINE_MESSAGE)).toBe(false);
    expect(harness.composer.textContent).not.toBe("");
  });

  it.each([
    ["an attachment", (harness: ReturnType<typeof domHarness>) => harness.setAttachment(true)],
    ["a generating/stop state", (harness: ReturnType<typeof domHarness>) => harness.setStop(true)],
  ])("does not send when %s appears after insertion", async (_label, block) => {
    const harness = domHarness();
    await expect(harness.dom.insertPrompt(command.message)).resolves.toBe(true);
    harness.setClickReceipt("must-not-send");
    block(harness);

    await expect(harness.dom.send(command.message, () => true, 10)).resolves.toEqual({
      clicked: false,
      message_id: null,
    });
    expect(harness.clickCount()).toBe(0);
  });

  it("does not send after the identity fence changes", async () => {
    const harness = domHarness();
    await expect(harness.dom.insertPrompt(command.message)).resolves.toBe(true);

    await expect(harness.dom.send(command.message, () => false, 10)).resolves.toEqual({
      clicked: false,
      message_id: null,
    });
    expect(harness.clickCount()).toBe(0);
  });

  it("returns only a new exact user-message receipt and never equates click with success", async () => {
    const harness = domHarness();
    await expect(harness.dom.insertPrompt(command.message)).resolves.toBe(true);
    const missing = await harness.dom.send(command.message, () => true, 1) as { clicked: boolean; message_id: string | null };
    expect(missing).toEqual({ clicked: true, message_id: null });

    harness.setClickReceipt("message-exact");
    const receipt = await harness.dom.send(command.message, () => true, 20) as { clicked: boolean; message_id: string | null };
    expect(receipt).toEqual({ clicked: true, message_id: "message-exact" });
  });
});
