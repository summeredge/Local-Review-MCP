import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://chatgpt.com";
const CONVERSATION_A = "11111111-2222-3333-4444-555555555555";
const CONVERSATION_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let fiberSource = "";
let contentSource = "";
let backgroundSource = "";

beforeAll(async () => {
  [fiberSource, contentSource, backgroundSource] = await Promise.all([
    readFile("extension/fiber.js", "utf8"),
    readFile("extension/content.js", "utf8"),
    readFile("extension/background.js", "utf8"),
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

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "local-review-mcp.goal-handoff",
    schema_version: "2",
    handoff_id: "handoff-2026-09-13-a",
    request_id: "request-fiber-a",
    workspace_id: "workspace-a",
    goal: {
      title: "Capture Goal",
      goal: "Verify the browser handoff path.",
      requirements: ["Keep the signed fields unchanged."],
      acceptance_criteria: ["The Bridge receives the original envelope."],
      max_iterations: 2,
    },
    issued_at: "2026-09-13T10:00:00.000Z",
    expires_at: "2026-09-13T10:02:00.000Z",
    signature: "a".repeat(64),
    ...overrides,
  };
}

function user(id: string, text: string): Record<string, unknown> {
  return {
    id,
    author: { role: "user" },
    content: { content_type: "text", parts: [text] },
  };
}

function request(id: string, tool = "prepare_goal_handoff"): Record<string, unknown> {
  return {
    id,
    author: { role: "assistant" },
    recipient: "api_tool.call_tool",
    content: { content_type: "code", text: `{"path":"/Local-Review-MCP/link_test/${tool}","args":{}}` },
    metadata: { request_id: "request-trace-not-used" },
  };
}

function result(
  id: string,
  parentId: string,
  value: unknown,
  tool = "prepare_goal_handoff",
): Record<string, unknown> {
  return {
    id,
    author: { role: "tool" },
    recipient: "all",
    content: {
      content_type: "text",
      parts: [JSON.stringify({ structuredContent: value })],
    },
    metadata: {
      parent_id: parentId,
      invoked_resource: { resource_uri: `/Local-Review-MCP/asdk_test/link_test/${tool}` },
    },
  };
}

function fiberSection(
  conversationId: unknown,
  messages: unknown[],
  turnId = "turn-1",
): Record<string, unknown> {
  let model: Record<string, unknown> = {
    memoizedProps: {
      ...(typeof conversationId === "string" ? { conversation: { id: conversationId } } : {}),
      turn: { id: turnId, messages },
    },
    return: null,
  };
  for (let depth = 0; depth < 30; depth += 1) {
    model = { memoizedProps: { children: null }, return: model };
  }
  return { __reactFiber$test: model, getAttribute: () => turnId };
}

function scanFiber(sections: Record<string, unknown>[]): Record<string, any> {
  const window = pageWindow();
  const context = {
    window,
    document: { querySelectorAll: () => sections },
    location: { origin: ORIGIN },
  } as Record<string, unknown>;
  vm.runInNewContext(fiberSource, context, { filename: "fiber.js" });
  let reply: Record<string, any> | undefined;
  window.addEventListener("message", (event) => {
    if (event.data && typeof event.data === "object"
      && (event.data as Record<string, unknown>).source === "lrm-extension-identity-reply") {
      reply = event.data as Record<string, any>;
    }
  });
  window.postMessage({ source: "lrm-extension-identity-ask", nonce: "fiber-test" }, ORIGIN);
  if (reply === undefined) throw new Error("Fiber helper did not answer");
  return reply;
}

interface ContentHarness {
  readonly messages: Record<string, unknown>[];
  readonly rescan: () => void;
  readonly fiberScanStarted: Promise<void>;
  readonly releaseFiberReply: () => void;
  readonly navigate: (conversationId: string) => void;
}

class Storage {
  public readonly data: Record<string, unknown>;

  public constructor(initial: Record<string, unknown> = {}) {
    this.data = structuredClone(initial);
  }

  public async get(keys: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(keys.filter((key) => key in this.data)
      .map((key) => [key, structuredClone(this.data[key])]));
  }

  public async set(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.data, structuredClone(values));
  }
}

function bridgeResponse(status: number, body: unknown): Record<string, unknown> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(body),
  };
}

function loadBackground(
  storage: Storage,
  responder: (url: URL, init: Record<string, unknown>) => Promise<Record<string, unknown>>,
): {
  readonly calls: Array<{ readonly input: string; readonly init: Record<string, unknown> }>;
  readonly send: (
    message: Record<string, unknown>,
    documentId: string,
    tabId?: number,
    url?: string,
  ) => Promise<Record<string, unknown>>;
} {
  let listener: ((
    message: Record<string, unknown>,
    sender: Record<string, unknown>,
    sendResponse: (value: Record<string, unknown>) => void,
  ) => boolean) | null = null;
  const calls: Array<{ readonly input: string; readonly init: Record<string, unknown> }> = [];
  const chrome = {
    storage: { local: storage },
    runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
  };
  const fetch = async (input: string, init: Record<string, unknown> = {}) => {
    calls.push({ input, init });
    return responder(new URL(input), init);
  };
  vm.runInNewContext(backgroundSource, {
    chrome,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    console,
  }, { filename: "background.js" });
  if (listener === null) throw new Error("background listener was not registered");
  return {
    calls,
    send: (message, documentId, tabId = 7, url = `${ORIGIN}/c/${CONVERSATION_A}`) =>
      new Promise((resolve, reject) => {
        try {
          const keep = listener!(message, {
            tab: { id: tabId }, documentId, frameId: 0, url,
          }, resolve);
          if (keep !== true) reject(new Error("background listener did not keep response channel open"));
        } catch (error) {
          reject(error);
        }
      }),
  };
}

function loadContent(
  reply: Record<string, unknown>,
  options: {
    readonly delayFirstFiberReply?: boolean;
    readonly subsequentFiberReply?: Record<string, unknown>;
  } = {},
): ContentHarness {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const messages: Record<string, unknown>[] = [];
  const intervalCallbacks: Array<() => void> = [];
  const location = { origin: ORIGIN, href: `${ORIGIN}/c/${CONVERSATION_A}` };
  let fiberReplyCount = 0;
  let releaseFiberReply: (() => void) | null = null;
  let resolveFiberScanStarted: (() => void) | null = null;
  const fiberScanStarted = new Promise<void>((resolve) => {
    resolveFiberScanStarted = resolve;
  });
  const dispatchFiberReply = (nonce: unknown, fiberReply: Record<string, unknown>) => {
    const response = {
      source: "lrm-extension-identity-reply",
      nonce,
      version: 1,
      evidence: [],
      handoffs: fiberReply.handoffs ?? [],
    };
    for (const listener of listeners.get("message") ?? []) {
      listener({ source: window, origin: ORIGIN, data: response });
    }
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
      if (targetOrigin !== ORIGIN || !data || typeof data !== "object"
        || (data as Record<string, unknown>).source !== "lrm-extension-identity-ask") return;
      const firstReply = fiberReplyCount === 0;
      fiberReplyCount += 1;
      if (firstReply) {
        resolveFiberScanStarted?.();
        resolveFiberScanStarted = null;
      }
      const fiberReply = firstReply ? reply : (options.subsequentFiberReply ?? reply);
      const dispatch = () => dispatchFiberReply((data as Record<string, unknown>).nonce, fiberReply);
      if (firstReply && options.delayFirstFiberReply) releaseFiberReply = dispatch;
      else dispatch();
    },
  };
  const chrome = {
    runtime: {
      sendMessage(message: Record<string, unknown>, callback: (value: Record<string, unknown>) => void) {
        messages.push(structuredClone(message));
        callback(message.type === "register_document"
          ? { ok: true, document_id: "document-a", navigation_epoch: 0 }
          : { ok: true });
      },
    },
  };
  const history = {
    pushState(_state: unknown, _title: string, url: string) {
      location.href = new URL(url, location.href).href;
    },
    replaceState(_state: unknown, _title: string, url: string) {
      location.href = new URL(url, location.href).href;
    },
  };
  vm.runInNewContext(contentSource, {
    window,
    location,
    history,
    document: { documentElement: {} },
    chrome,
    MutationObserver: undefined,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: (callback: () => void) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
  }, { filename: "content.js" });
  return {
    messages,
    rescan: () => intervalCallbacks[1]?.(),
    fiberScanStarted,
    releaseFiberReply: () => {
      const release = releaseFiberReply;
      releaseFiberReply = null;
      release?.();
    },
    navigate: (conversationId) => history.pushState({}, "", `${ORIGIN}/c/${conversationId}`),
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 220));
}

describe("Extension GoalHandoffEnvelopeV2 Fiber capture", () => {
  it("identifies the target tool result by request/result identity and preserves the envelope", () => {
    const original = envelope();
    const reply = scanFiber([fiberSection(CONVERSATION_A, [
      user("user-a", "建立一个 Goal：请把它交给 Codex 执行"),
      request("request-a"),
      result("result-a", "request-a", original),
    ])]);

    expect(reply.handoffs).toHaveLength(1);
    expect(reply.handoffs[0].handoff).toEqual(original);
    expect(reply.handoffs[0]).toMatchObject({
      fiber_conversation_id: CONVERSATION_A,
      request_message_id: "request-a",
      result_message_id: "result-a",
      request_order: 1,
      result_order: 2,
      user_orders: [0],
      activation_orders: [0],
    });
  });

  it("ignores another tool, V1, malformed, and envelope conversation identities", () => {
    const messages = [
      user("user-a", "建立一个 Goal：交给 Codex 执行"),
      request("other-request", "submit_goal"),
      result("other-result", "other-request", envelope({ handoff_id: "handoff-other" }), "submit_goal"),
      request("v1-request"),
      result("v1-result", "v1-request", envelope({ schema_version: "1", handoff_id: "handoff-v1" })),
      request("bad-request"),
      result("bad-result", "bad-request", envelope({ signature: "bad", handoff_id: "handoff-bad" })),
      request("conversation-request"),
      result("conversation-result", "conversation-request", envelope({
        handoff_id: "handoff-conversation",
        conversation_id: CONVERSATION_A,
      })),
    ];

    expect(scanFiber([fiberSection(CONVERSATION_A, messages)]).handoffs).toEqual([]);
  });

  it("drops conflicting payloads for the same handoff or invocation", () => {
    const first = envelope();
    const second = envelope({ goal: { ...first.goal as Record<string, unknown>, goal: "changed" } });
    const reply = scanFiber([fiberSection(CONVERSATION_A, [
      user("user-a", "创建一个 Goal，交给 Codex 执行"),
      request("request-a"),
      result("result-a", "request-a", first),
      result("result-b", "request-a", second),
    ])]);

    expect(reply.handoffs).toEqual([]);
  });

  it("only considers the latest turn, so old page history cannot activate a handoff", () => {
    const reply = scanFiber([
      fiberSection(CONVERSATION_A, [
        user("old-user", "建立一个 Goal，交给 Codex 执行"),
        request("old-request"),
        result("old-result", "old-request", envelope({ handoff_id: "handoff-old" })),
      ], "old-turn"),
      fiberSection(CONVERSATION_A, [user("new-user", "普通跟进")], "new-turn"),
    ]);

    expect(reply.handoffs).toEqual([]);
  });
});

describe("Extension Goal handoff activation and transport gate", () => {
  it("requires author.role === user for activation; assistant text cannot activate", async () => {
    const base = [request("request-a"), result("result-a", "request-a", envelope())];
    const noActivation = scanFiber([fiberSection(CONVERSATION_A, [
      user("user-a", "请准备一份说明，但不要启动执行"),
      ...base,
    ])]);
    const assistantOnly = scanFiber([fiberSection(CONVERSATION_A, [
      user("user-a", "请准备一份说明"),
      { ...base[0], author: { role: "assistant" }, content: { content_type: "text", parts: ["建立一个 Goal，交给 Codex 执行"] } },
      base[1],
    ])]);
    const noActivationHarness = loadContent(noActivation);
    const assistantOnlyHarness = loadContent(assistantOnly);
    await settle();

    expect(assistantOnly.handoffs[0]).toMatchObject({ user_orders: [0], activation_orders: [] });
    expect(noActivationHarness.messages.filter((message) => message.type === "goal_handoff_capture")).toEqual([]);
    expect(assistantOnlyHarness.messages.filter((message) => message.type === "goal_handoff_capture")).toEqual([]);
  });

  it("ignores activation phrases injected into assistant and tool-result content", async () => {
    const ordinaryUser = user("user-a", "请只查看当前信息");
    const assistantInjected = scanFiber([fiberSection(CONVERSATION_A, [
      ordinaryUser,
      {
        ...request("assistant-request"),
        content: { content_type: "text", parts: ["建立一个 Goal，交给 Codex 执行"] },
      },
      result("assistant-result", "assistant-request", envelope({ handoff_id: "handoff-assistant" })),
    ])]);
    const toolInjected = scanFiber([fiberSection(CONVERSATION_A, [
      ordinaryUser,
      request("tool-request"),
      result("tool-result", "tool-request", envelope({
        handoff_id: "handoff-tool",
        goal: {
          ...(envelope().goal as Record<string, unknown>),
          title: "建立一个 Goal，交给 Codex 执行",
        },
      })),
    ])]);

    expect(assistantInjected.handoffs[0]).toMatchObject({ user_orders: [0], activation_orders: [] });
    expect(toolInjected.handoffs[0]).toMatchObject({ user_orders: [0], activation_orders: [] });

    const assistantHarness = loadContent(assistantInjected);
    const toolHarness = loadContent(toolInjected);
    await settle();

    expect(assistantHarness.messages.filter((message) => message.type === "goal_handoff_capture")).toEqual([]);
    expect(toolHarness.messages.filter((message) => message.type === "goal_handoff_capture")).toEqual([]);
  });

  it("forwards one exact handoff payload only after explicit user activation", async () => {
    const original = envelope();
    const reply = scanFiber([fiberSection(CONVERSATION_A, [
      user("user-a", "创建一个 Goal：把这项工作交给 Codex 执行"),
      request("request-a"),
      result("result-a", "request-a", original),
    ])]);
    const harness = loadContent(reply);
    await settle();
    harness.rescan();
    await settle();

    const captures = harness.messages.filter((message) => message.type === "goal_handoff_capture");
    expect(captures).toHaveLength(1);
    expect(captures[0]).toEqual({
      type: "goal_handoff_capture",
      handoff: original,
      conversation_id: CONVERSATION_A,
      navigation_epoch: 0,
    });
  });

  it("rejects a Fiber conversation that disagrees with the current URL", async () => {
    const reply = scanFiber([fiberSection(CONVERSATION_B, [
      user("user-a", "启动一个 Goal，交给 Codex 执行"),
      request("request-a"),
      result("result-a", "request-a", envelope()),
    ])]);
    const harness = loadContent(reply);
    await settle();

    expect(harness.messages.filter((message) => message.type === "goal_handoff_capture")).toEqual([]);
  });

  it("fails closed when an in-flight A scan returns after an SPA switch to B", async () => {
    const reply = scanFiber([fiberSection(CONVERSATION_A, [
      user("user-a", "建立一个 Goal，交给 Codex 执行"),
      request("request-a"),
      result("result-a", "request-a", envelope()),
    ])]);
    const harness = loadContent(reply, {
      delayFirstFiberReply: true,
      subsequentFiberReply: { evidence: [], handoffs: [] },
    });

    await harness.fiberScanStarted;
    harness.navigate(CONVERSATION_B);
    harness.releaseFiberReply();
    await settle();

    expect(harness.messages
      .filter((message) => message.type === "register_document")
      .map((message) => message.navigation_epoch)).toEqual([0, 1]);
    expect(harness.messages.filter((message) => message.type === "goal_handoff_capture")).toEqual([]);
  });

  it("does not revive an old A scan after an A-to-B-to-A epoch advance", async () => {
    const reply = scanFiber([fiberSection(CONVERSATION_A, [
      user("user-a", "建立一个 Goal，交给 Codex 执行"),
      request("request-a"),
      result("result-a", "request-a", envelope()),
    ])]);
    const harness = loadContent(reply, {
      delayFirstFiberReply: true,
      subsequentFiberReply: { evidence: [], handoffs: [] },
    });

    await harness.fiberScanStarted;
    harness.navigate(CONVERSATION_B);
    harness.navigate(CONVERSATION_A);
    harness.releaseFiberReply();
    await settle();

    expect(harness.messages
      .filter((message) => message.type === "register_document")
      .map((message) => message.navigation_epoch)).toEqual([0, 1, 2]);
    expect(harness.messages.filter((message) => message.type === "goal_handoff_capture")).toEqual([]);
  });
});

describe("Extension Goal handoff browser identity authority", () => {
  it("attaches sender document identity, rejects malformed/stale captures, and never uses body document_id", async () => {
    const storage = new Storage();
    const posted: Record<string, unknown>[] = [];
    const worker = loadBackground(storage, async (url, init) => {
      if (url.pathname === "/hello") return bridgeResponse(200, {
        service: "local-review-control-bridge", protocol: 3, paired: true,
      });
      if (url.pathname === "/pair") return bridgeResponse(200, { token: "paired-token" });
      if (url.pathname === "/goal-handoff-capture") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return bridgeResponse(202, { accepted: "new" });
      }
      return bridgeResponse(404, {});
    });
    const capture = {
      type: "goal_handoff_capture",
      handoff: envelope(),
      conversation_id: CONVERSATION_A,
      document_id: "spoofed-body-document",
      navigation_epoch: 0,
    };

    expect(await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-real"))
      .toMatchObject({ ok: true });
    expect(await worker.send({ ...capture, handoff: { ...capture.handoff, schema_version: "1" } }, "document-real"))
      .toMatchObject({ ok: false, error: "invalid_goal_handoff_capture" });
    expect(await worker.send(capture, "document-real")).toMatchObject({ ok: true });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      handoff: capture.handoff,
      conversation_id: CONVERSATION_A,
      document_id: "document-real",
      navigation_epoch: 0,
    });

    expect(await worker.send({ type: "navigation", navigation_epoch: 1 }, "document-real"))
      .toMatchObject({ ok: true });
    expect(await worker.send(capture, "document-real")).toMatchObject({ ok: false, error: "stale_navigation" });
    expect(await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-new"))
      .toMatchObject({ ok: true });
    expect(await worker.send(capture, "document-real")).toMatchObject({ ok: false, error: "stale_document" });
  });
});
