import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import { parseExtensionReviewCompletionDiagnosticArgs } from "../src/control-plane/extension-review-completion-diagnostic.js";

const ORIGIN = "https://chatgpt.com";
const CONVERSATION_A = "11111111-2222-3333-4444-555555555555";
const CONVERSATION_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const COMPLETION_ID = "62ca0d45-8b29-414a-bbe4-8e26c3aae911";
const EXPECTED_USER = "user-review-001";

let fiberSource = "";
let contentSource = "";

beforeAll(async () => {
  [fiberSource, contentSource] = await Promise.all([
    readFile("extension/fiber.js", "utf8"),
    readFile("extension/content.js", "utf8"),
  ]);
});

type Message = Record<string, unknown> & {
  id: string;
  author: { role: string };
};

interface Fiber {
  memoizedProps: Record<string, unknown>;
  return: Fiber | null;
}

interface Section {
  getAttribute(name: string): string | null;
  [key: string]: unknown;
}

function user(id: string, text = "Review this change"): Message {
  return {
    id,
    author: { role: "user" },
    recipient: "all",
    content: { content_type: "text", parts: [text] },
  };
}

function assistant(
  id: string,
  text: string,
  options: {
    readonly status?: string;
    readonly endTurn?: boolean;
    readonly channel?: string;
    readonly workingTurnId?: string;
    readonly turnExchangeId?: string;
    readonly createTime?: number;
    readonly parentId?: string;
    readonly hidden?: boolean;
  } = {},
): Message {
  return {
    id,
    author: { role: "assistant" },
    recipient: "all",
    status: options.status ?? "finished_successfully",
    end_turn: options.endTurn ?? true,
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    create_time: options.createTime ?? 1_700_000_000,
    content: { content_type: "text", parts: [text] },
    metadata: {
      working_turn_id: options.workingTurnId ?? "working-turn-1",
      turn_exchange_id: options.turnExchangeId ?? "exchange-1",
      ...(options.parentId === undefined ? {} : { parent_id: options.parentId }),
      ...(options.hidden ? { is_visually_hidden_from_conversation: true } : {}),
    },
  };
}

function thought(id: string, endTurn = true): Message {
  return {
    id,
    author: { role: "assistant" },
    recipient: "all",
    status: "finished_successfully",
    end_turn: endTurn,
    content: { content_type: "thoughts", parts: null },
  };
}

function toolRequest(id: string): Message {
  return {
    id,
    author: { role: "assistant" },
    recipient: "api_tool.call_tool",
    status: "finished_successfully",
    end_turn: true,
    content: { content_type: "code", text: '{"path":"/tool"}' },
  };
}

function toolResult(id: string): Message {
  return {
    id,
    author: { role: "tool" },
    recipient: "all",
    status: "finished_successfully",
    end_turn: true,
    content: { content_type: "code", text: "tool result" },
  };
}

function section(
  messages: Message[],
  options: { readonly conversationId?: string; readonly turnId?: string; readonly extra?: Record<string, unknown> } = {},
): Section {
  let model: Fiber = {
    memoizedProps: {
      conversation: { id: options.conversationId ?? CONVERSATION_A },
      turn: { messages },
    },
    return: null,
  };
  for (let depth = 0; depth < 30; depth += 1) {
    model = { memoizedProps: { children: null }, return: model };
  }
  return {
    getAttribute: (name) => name === "data-turn-id" ? (options.turnId ?? "turn-1") : null,
    __reactFiber$test: {
      memoizedProps: { children: null, ...(options.extra ?? {}) },
      return: model,
    },
  };
}

interface PageWindow {
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
  removeEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
  postMessage(data: unknown, targetOrigin: string): void;
  [key: string]: unknown;
}

function pageFor(sections: Section[], href = `${ORIGIN}/c/${CONVERSATION_A}`): {
  readonly window: PageWindow;
  readonly location: URL;
} {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const location = new URL(href);
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
  vm.runInNewContext(fiberSource, {
    window,
    document: { querySelectorAll: () => sections },
    location,
    URL,
  }, { filename: "fiber.js" });
  return { window, location };
}

function completionReply(
  sections: Section[],
  expectedUserMessageId = EXPECTED_USER,
  conversationId = CONVERSATION_A,
): Record<string, unknown> {
  const page = pageFor(sections, `${ORIGIN}/c/${conversationId}`);
  let reply: Record<string, unknown> | undefined;
  page.window.addEventListener("message", (event) => {
    const data = event.data;
    if (data && typeof data === "object"
      && (data as Record<string, unknown>).source === "lrm-extension-review-completion-reply") {
      reply = data as Record<string, unknown>;
    }
  });
  page.window.postMessage({
    source: "lrm-extension-review-completion-ask",
    nonce: "completion-test",
    version: 1,
    completion_id: COMPLETION_ID,
    conversation_id: conversationId,
    expected_user_message_id: expectedUserMessageId,
  }, ORIGIN);
  if (reply === undefined) throw new Error("completion Fiber helper did not answer");
  return reply;
}

function finalMessage(id = "assistant-final", text = "Final answer", options: Parameters<typeof assistant>[2] = {}) {
  return assistant(id, text, options);
}

describe("MAIN-world review completion observation", () => {
  it("anchors to the exact user message and returns raw Markdown plus a stable assistant id", () => {
    const reply = completionReply([section([
      user("old-user"),
      finalMessage("old-assistant", "old answer", { createTime: 1 }),
      user(EXPECTED_USER),
      finalMessage("assistant-now", "# Exact **Markdown**\n\n```ts\nreturn 1;\n```", { createTime: 2 })
    ])]);

    expect(reply).toMatchObject({
      status: "completed",
      conversation_id: CONVERSATION_A,
      expected_user_message_id: EXPECTED_USER,
      assistant_message_id: "assistant:working-turn-1:exchange-1:2000",
      content: "# Exact **Markdown**\n\n```ts\nreturn 1;\n```",
    });
    expect(Object.keys(reply).sort()).toEqual([
      "assistant_message_id",
      "completion_id",
      "content",
      "conversation_id",
      "expected_user_message_id",
      "nonce",
      "source",
      "status",
      "version",
    ]);
  });

  it.each([
    ["streaming", finalMessage("assistant-streaming", "partial", { status: "in_progress", endTurn: false })],
    ["finished without end_turn", finalMessage("assistant-no-end", "partial", { endTurn: false })],
    ["end_turn without successful status", finalMessage("assistant-failed", "partial", { status: "in_progress" })],
  ])("keeps a non-terminal public assistant %s pending", (_name, message) => {
    expect(completionReply([section([user(EXPECTED_USER), message])])).toMatchObject({ status: "pending" });
  });

  it("does not reuse an old completed attempt while a newer retry is active", () => {
    expect(completionReply([section([
      user(EXPECTED_USER),
      finalMessage("old-final", "old", { workingTurnId: "w", turnExchangeId: "e", createTime: 1 }),
      finalMessage("retry-active", "retrying", {
        status: "finished_successfully",
        endTurn: false,
        workingTurnId: "w2",
        turnExchangeId: "e2",
        createTime: 2,
      }),
    ])])).toMatchObject({ status: "pending" });
  });

  it.each([
    ["analysis", { ...thought("analysis-ghost"), channel: "analysis" }],
    ["commentary", finalMessage("commentary-ghost", "wrapping up", { channel: "commentary", endTurn: false })],
  ])("ignores a trailing %s ghost after a terminal final answer", (_name, ghost) => {
    const reply = completionReply([section([
      user(EXPECTED_USER),
      finalMessage("assistant-final", "Finished", { channel: "final" }),
      ghost,
    ])]);
    expect(reply).toMatchObject({ status: "completed", content: "Finished" });
  });

  it.each([
    ["thoughts", thought("thought-terminal")],
    ["tool request", toolRequest("tool-request")],
    ["tool result", toolResult("tool-result")],
    ["hidden assistant", finalMessage("hidden", "secret", { hidden: true })],
  ])("never treats a %s message as Review Completion", (_name, message) => {
    expect(completionReply([section([user(EXPECTED_USER), message])])).toMatchObject({ status: "pending" });
  });

  it("keeps missing user and temporarily unreadable Fiber pending", () => {
    expect(completionReply([section([user("other-user"), finalMessage()])])).toMatchObject({ status: "pending" });
    expect(completionReply([])).toMatchObject({ status: "pending" });
    expect(completionReply([section([user(EXPECTED_USER), finalMessage()], { extra: { conversationId: "" } })]))
      .toMatchObject({ status: "pending" });
  });

  it("fails closed for wrong route/conversation and Fiber identity conflicts", () => {
    expect(completionReply([section([user(EXPECTED_USER), finalMessage()], { conversationId: CONVERSATION_B })]))
      .toMatchObject({ status: "ambiguous", error: "completion_identity_ambiguous" });
    expect(completionReply([section([user(EXPECTED_USER), finalMessage()], {
      extra: { conversationId: CONVERSATION_B },
    })])).toMatchObject({ status: "ambiguous", error: "completion_identity_ambiguous" });
  });

  it("marks duplicate target turns and colliding assistant identities ambiguous", () => {
    const duplicateTarget = completionReply([
      section([user(EXPECTED_USER), finalMessage("first")], { turnId: "turn-one" }),
      section([user(EXPECTED_USER), finalMessage("second")], { turnId: "turn-two" }),
    ]);
    expect(duplicateTarget).toMatchObject({ status: "ambiguous" });

    const collision = completionReply([section([
      user(EXPECTED_USER),
      finalMessage("raw-one", "one", { workingTurnId: "same", turnExchangeId: "same", createTime: 3 }),
      finalMessage("raw-two", "two", { workingTurnId: "same", turnExchangeId: "same", createTime: 3 }),
    ])]);
    expect(collision).toMatchObject({ status: "ambiguous", error: "completion_assistant_identity_ambiguous" });
  });

  it("rejects oversized public content without truncating it", () => {
    const tooLarge = "é".repeat(131_073);
    expect(Buffer.byteLength(tooLarge, "utf8")).toBeGreaterThan(256 * 1024);
    expect(completionReply([section([user(EXPECTED_USER), finalMessage("too-large", tooLarge)])]))
      .toMatchObject({ status: "failed", error: "completion_content_too_large" });
  });

  it("fails closed when the terminal assistant has no stable page identity", () => {
    const unstable = finalMessage("raw-only", "answer");
    unstable.metadata = {};
    delete unstable.create_time;
    expect(completionReply([section([user(EXPECTED_USER), unstable])]))
      .toMatchObject({ status: "failed", error: "completion_assistant_message_id_unavailable" });
  });

  it("keeps the COS logical identity across raw UUID and parent changes", () => {
    const first = completionReply([section([user(EXPECTED_USER), finalMessage("raw-one", "answer", {
      workingTurnId: "working-stable",
      turnExchangeId: "exchange-stable",
      createTime: 42,
      parentId: "parent-one",
    })])]);
    const reloaded = completionReply([section([user(EXPECTED_USER), finalMessage("raw-two", "answer", {
      workingTurnId: "working-stable",
      turnExchangeId: "exchange-stable",
      createTime: 42,
      parentId: "parent-two",
    })])]);
    expect(reloaded.assistant_message_id).toBe(first.assistant_message_id);
  });
});

interface ContentHarness {
  readonly messages: Record<string, unknown>[];
  readonly claims: Record<string, unknown>[];
  readonly asks: Record<string, unknown>[];
  readonly acks: Record<string, unknown>[];
  readonly triggerMutation: () => void;
  readonly setMessages: (messages: Message[]) => void;
  readonly navigate: (conversationId: string) => void;
}

function contentHarness(initialMessages: Message[], options: { readonly navigateBeforeReply?: boolean } = {}): ContentHarness {
  const messages: Record<string, unknown>[] = [];
  const claims: Record<string, unknown>[] = [];
  const asks: Record<string, unknown>[] = [];
  const acks: Record<string, unknown>[] = [];
  const sectionMessages = [...initialMessages];
  const sections = [section(sectionMessages)];
  let mutation: (() => void) | undefined;
  let navigateBeforeReply = options.navigateBeforeReply === true;
  let acknowledged = false;
  const location = new URL(`${ORIGIN}/c/${CONVERSATION_A}`);
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const history = {
    pushState(_state: unknown, _title: string, path: string) {
      location.href = new URL(path, location.href).href;
    },
    replaceState(_state: unknown, _title: string, path: string) {
      location.href = new URL(path, location.href).href;
    },
  };
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
      if (data && typeof data === "object"
        && (data as Record<string, unknown>).source === "lrm-extension-review-completion-ask") {
        asks.push(structuredClone(data) as Record<string, unknown>);
      }
      if (data && typeof data === "object"
        && (data as Record<string, unknown>).source === "lrm-extension-review-completion-reply"
        && navigateBeforeReply) {
        navigateBeforeReply = false;
        history.pushState({}, "", `/c/${CONVERSATION_B}`);
      }
      for (const listener of listeners.get("message") ?? []) {
        listener({ source: window, origin: ORIGIN, data });
      }
    },
  };
  const responder = (message: Record<string, unknown>): Record<string, unknown> => {
    messages.push(structuredClone(message));
    if (message.type === "completion_claim") {
      claims.push(structuredClone(message));
      return acknowledged ? { ok: true, command: null } : {
        ok: true,
        completion_id: COMPLETION_ID,
        conversation_id: CONVERSATION_A,
        review_request_id: "review-001",
        expected_user_message_id: EXPECTED_USER,
        deadline: Date.now() + 30_000,
      };
    }
    if (message.type === "completion_ack") {
      acks.push(structuredClone(message));
      acknowledged = true;
    }
    return { ok: true };
  };
  class Observer {
    public constructor(callback: () => void) { mutation = callback; }
    public observe(): void {}
  }
  const chrome = {
    runtime: {
      sendMessage(message: Record<string, unknown>, callback: (reply: Record<string, unknown>) => void) {
        callback(responder(message));
      },
    },
  };
  const document = { documentElement: {}, querySelectorAll: () => sections };
  const dom = { ready: () => false };
  const context = {
    window,
    location,
    history,
    document,
    chrome,
    LRM_DOM: dom,
    MutationObserver: Observer,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
  };
  vm.runInNewContext(fiberSource, context, { filename: "fiber.js" });
  vm.runInNewContext(contentSource, context, { filename: "content.js" });
  return {
    messages,
    claims,
    asks,
    acks,
    triggerMutation: () => mutation?.(),
    setMessages: (next) => {
      sectionMessages.splice(0, sectionMessages.length, ...next);
    },
    navigate: (conversationId) => history.pushState({}, "", `/c/${conversationId}`),
  };
}

async function settle(delayMs = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

describe("isolated-world completion polling", () => {
  it("claims an exact watch without DOM readiness and ACKs only a terminal Fiber result", async () => {
    const harness = contentHarness([user(EXPECTED_USER)]);
    await settle();
    expect(harness.claims).toHaveLength(1);
    expect(harness.asks[0]).toMatchObject({
      conversation_id: CONVERSATION_A,
      expected_user_message_id: EXPECTED_USER,
      completion_id: COMPLETION_ID,
    });
    expect(harness.acks).toEqual([]);

    harness.setMessages([user(EXPECTED_USER), finalMessage("assistant-final", "Exact result")]);
    harness.triggerMutation();
    await settle(220);
    expect(harness.acks).toHaveLength(1);
    expect(harness.acks[0]).toMatchObject({
      type: "completion_ack",
      completion_id: COMPLETION_ID,
      conversation_id: CONVERSATION_A,
      navigation_epoch: 0,
      status: "completed",
      content: "Exact result",
    });
  });

  it("does not ACK pending observations, route changes, or a repeated terminal answer", async () => {
    const pending = contentHarness([user(EXPECTED_USER), finalMessage("active", "partial", {
      status: "in_progress",
      endTurn: false,
    })]);
    await settle();
    expect(pending.acks).toEqual([]);
    pending.setMessages([user(EXPECTED_USER), finalMessage("done", "done")]);
    pending.triggerMutation();
    await settle(220);
    pending.triggerMutation();
    await settle(220);
    expect(pending.acks).toHaveLength(1);

    const navigated = contentHarness([user(EXPECTED_USER), finalMessage("done", "done")], {
      navigateBeforeReply: true,
    });
    await settle();
    expect(navigated.acks).toEqual([]);
    expect(navigated.messages.some((message) => message.type === "completion_ack")).toBe(false);
  });
});

describe("extension completion diagnostic arguments", () => {
  it("keeps settings arguments separate from the conversation probe", () => {
    expect(parseExtensionReviewCompletionDiagnosticArgs([
      "--config", "config.production.json", "--conversation-id", CONVERSATION_A, "--timeout-ms", "5000",
    ])).toEqual({
      settingsArgs: ["--config", "config.production.json"],
      conversationId: CONVERSATION_A,
      timeoutMs: 5000,
    });
  });
});
