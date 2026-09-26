import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://chatgpt.com";
const CONVERSATION = "11111111-2222-3333-4444-555555555555";
const CONVERSATION_B = "66666666-7777-4888-8999-000000000000";
const KEY_A = "00000000-0000-4000-8000-000000000001";
const KEY_B = "00000000-0000-4000-8000-000000000002";
const KEY_C = "00000000-0000-4000-8000-000000000003";
const KEY_D = "00000000-0000-4000-8000-000000000004";
const PLATFORM_REQUEST_ID = "platform-request-id";

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

function request(id: string, tool: string, correlationKey?: string, requestId = "request-trace-not-used"): Record<string, unknown> {
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
    metadata: { request_id: requestId },
  };
}

function currentConnectorRequest(
  id: string,
  tool: string,
  correlationKey?: string,
  requestId = PLATFORM_REQUEST_ID,
): Record<string, unknown> {
  return {
    id,
    author: { role: "assistant" },
    recipient: `Local_MCP_Connector.${tool}`,
    content: {
      content_type: "code",
      text: JSON.stringify({
        name: tool,
        arguments: JSON.stringify(correlationKey === undefined ? {} : { correlation_key: correlationKey }),
      }),
    },
    metadata: { request_id: requestId },
  };
}

function userMessage(id = "user-current"): Record<string, unknown> {
  return { id, author: { role: "user" } };
}

// Real ChatGPT does not guarantee a stable message id on every visible user message.
function unstableUserMessage(): Record<string, unknown> {
  return { author: { role: "user" } };
}

function fiberSection(
  messages: unknown[],
  turnId = "turn-1",
  conversationId: string | undefined = CONVERSATION,
  extraProps: Record<string, unknown> = {},
): Record<string, unknown> {
  let model: Record<string, unknown> = {
    memoizedProps: {
      ...(conversationId === undefined ? {} : { conversation: { id: conversationId } }),
      turn: { id: turnId, messages },
      ...extraProps,
    },
    return: null,
  };
  for (let depth = 0; depth < 30; depth += 1) {
    model = { memoizedProps: { children: null }, return: model };
  }
  return { __reactFiber$test: model, getAttribute: (name: string) => name === 'data-turn-id' ? turnId : null };
}

function scanFiberSections(sections: Record<string, unknown>[], selector?: string): Record<string, any> {
  const window = pageWindow();
  const debugMessages: string[] = [];
  vm.runInNewContext(fiberSource, {
    window,
    document: { querySelectorAll: (value: string) => !selector || value === selector ? sections : [] },
    location: { origin: ORIGIN, href: `${ORIGIN}/c/${CONVERSATION}` },
    URL,
    console: { debug: (message: string) => debugMessages.push(message) },
  }, { filename: "fiber.js" });
  let reply: Record<string, any> | undefined;
  window.addEventListener("message", (event) => {
    if ((event.data as Record<string, unknown>)?.source === "lrm-extension-identity-reply") {
      reply = event.data as Record<string, any>;
    }
  });
  window.postMessage({ source: "lrm-extension-identity-ask", nonce: "test" }, ORIGIN);
  if (reply === undefined) throw new Error("Fiber helper did not answer");
  const lastDebug = debugMessages.at(-1);
  return { ...reply, debug: lastDebug ? JSON.parse(lastDebug) : undefined };
}

function scanFiber(messages: unknown[]): Record<string, any> {
  return scanFiberSections([fiberSection(messages)]);
}

async function contentMessages(
  reply: Record<string, unknown>,
  options: { fiberReplyDelayMs?: number; navigateBeforeFiberReply?: string; dropReply?: boolean;
    registrationFails?: boolean; workerFails?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const messages: Record<string, unknown>[] = [];
  const location = { origin: ORIGIN, href: `${ORIGIN}/c/${CONVERSATION}` };
  let navigated = false;
  const history = {
    pushState(_state: unknown, _title: string, url: string) {
      location.href = new URL(url, location.href).href;
    },
    replaceState(_state: unknown, _title: string, url: string) {
      location.href = new URL(url, location.href).href;
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
      if (targetOrigin !== ORIGIN || (data as Record<string, unknown>)?.source !== "lrm-extension-identity-ask") return;
      if (options.dropReply) return;
      if (options.navigateBeforeFiberReply && !navigated) {
        navigated = true;
        history.pushState({}, "", options.navigateBeforeFiberReply);
      }
      const deliver = () => {
        for (const listener of listeners.get("message") ?? []) {
          listener({
            source: window,
            origin: ORIGIN,
            data: { ...reply, source: "lrm-extension-identity-reply", nonce: (data as Record<string, unknown>).nonce },
          });
        }
      };
      if (options.fiberReplyDelayMs && options.fiberReplyDelayMs > 0) setTimeout(deliver, options.fiberReplyDelayMs);
      else deliver();
    },
  };
  vm.runInNewContext(contentSource, {
    window,
    location,
    history,
    document: { documentElement: {} },
    chrome: { runtime: { sendMessage(message: Record<string, unknown>, callback: (value: object) => void) {
      messages.push(structuredClone(message));
      callback(message.type === "register_document"
        ? { ok: !options.registrationFails, document_id: "document-a", navigation_epoch: 0 }
        : { ok: !(options.workerFails && message.type === 'identity_evidence') });
    } } },
    MutationObserver: undefined,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
  }, { filename: "content.js" });
  const settleMs = options.dropReply ? 1800 : options.fiberReplyDelayMs && options.fiberReplyDelayMs > 0
    ? 440 + options.fiberReplyDelayMs : 220;
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  return messages;
}

describe("Extension submit_goal correlation evidence", () => {
  function timelineCall(key: unknown = KEY_A): Record<string, any> {
    return { type: 'mcp-tool-call', functionName: 'Local MCP Connector__link_test/submit_goal',
      invocation: { server: 'Local MCP Connector', tool: 'link_test/submit_goal', arguments: { correlation_key: key } } };
  }

  function scanTimeline(items: unknown[], options: { current?: boolean; conversation?: string; parentConversation?: string } = {}) {
    const entry = { isMostRecentTurn: options.current ?? true, conversationId: options.conversation ?? CONVERSATION,
      turn: { items } };
    const section = { getAttribute: (name: string) => name === 'data-turn-key' ? 'timeline-turn' : null,
      __reactFiber$test: { memoizedProps: { 'data-turn-key': 'timeline-turn' },
        return: { memoizedProps: { entry }, return: options.parentConversation
          ? { memoizedProps: { conversationId: options.parentConversation }, return: null } : null } } };
    return scanFiberSections([section], 'section[data-testid^="conversation-turn"], [data-turn-key]');
  }

  it('reads the production timeline DOM and nested structured MCP invocation', () => {
    const reply = scanTimeline([{ type: 'user-message', messageId: 'user-current' },
      { type: 'chatgpt-reasoning-group', items: [timelineCall()] }, { type: 'assistant-message' }]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
    expect(reply.scan_diagnostic.current_turn_present).toBe(true);
  });

  it('does not claim a virtualized historical timeline viewport', () => {
    expect(scanTimeline([timelineCall()], { current: false }).evidence).toEqual([]);
  });

  it('keeps latest submit authority and rejects malformed latest timeline calls', () => {
    expect(scanTimeline([timelineCall(), timelineCall(KEY_B)]).evidence[0].request_id).toBe(KEY_B);
    for (const malformed of [timelineCall('invalid'), { ...timelineCall(), invocation: null },
      { ...timelineCall(), functionName: 'Other__link_test/submit_goal' }]) {
      expect(scanTimeline([timelineCall(), malformed]).evidence).toEqual([]);
    }
  });

  it('never extracts timeline identity from prose, results, foreign tools or metadata', () => {
    const foreign = timelineCall();
    foreign.invocation.server = 'Other';
    foreign.functionName = 'Other__link_test/submit_goal';
    expect(scanTimeline([foreign, { type: 'assistant-message', content: JSON.stringify(timelineCall()) },
      { type: 'reasoning', metadata: { request_id: KEY_A } }]).evidence).toEqual([]);
    const diagnostic = timelineCall();
    diagnostic.invocation.tool = 'link_test/get_identity_trace';
    diagnostic.functionName = 'Local MCP Connector__link_test/get_identity_trace';
    expect(scanTimeline([timelineCall(), diagnostic]).evidence[0].request_id).toBe(KEY_A);
  });

  it('preserves timeline user boundaries and same-lineage conversation rejection', () => {
    const user = { type: 'user-message' };
    expect(scanTimeline([user, timelineCall()]).evidence[0].request_id).toBe(KEY_A);
    expect(scanTimeline([timelineCall(), user]).evidence).toEqual([]);
    expect(scanTimeline([timelineCall()], { parentConversation: CONVERSATION_B }).evidence).toEqual([]);
    expect(scanTimeline([timelineCall()], { conversation: 'invalid identity' }).evidence).toEqual([]);
    expect(scanTimeline([{ type: 'chatgpt-reasoning-group', items: null }, timelineCall()]).evidence).toEqual([]);
  });

  it("reports registration, Fiber reply timeout, worker rejection, and navigation fencing independently", async () => {
    const reply = scanFiber([userMessage(), currentConnectorRequest('a', 'submit_goal', KEY_A)]);
    const registration = await contentMessages(reply, { registrationFails: true });
    expect(registration).toContainEqual(expect.objectContaining({ stage: 'document_registered', register_document_ok: false }));
    expect(registration.some(message => message.stage === 'fiber_scanned')).toBe(false);
    const timeout = await contentMessages(reply, { dropReply: true });
    expect(timeout).toContainEqual(expect.objectContaining({ stage: 'fiber_scanned', fiber_reply_received: false }));
    const rejected = await contentMessages(reply, { workerFails: true });
    expect(rejected).toContainEqual(expect.objectContaining({ stage: 'worker_send_finished', worker_reply_ok: false }));
    const navigated = await contentMessages(reply, { navigateBeforeFiberReply: `/c/${CONVERSATION_B}` });
    expect(navigated).toContainEqual(expect.objectContaining({ stage: 'fiber_scanned', navigation_epoch_unchanged: false }));
    expect(navigated.some(message => message.type === 'identity_evidence')).toBe(false);
  });
  it("distinguishes missing root and missing trusted identity, and keeps the key after a newer non-goal tool", async () => {
    const noRoot = scanFiberSections([{}]);
    expect(noRoot.scan_diagnostic).toMatchObject({ fiber_root_detected: false, current_key_found: false });
    const noIdentity = scanFiberSections([fiberSection([userMessage(), currentConnectorRequest('a', 'submit_goal', KEY_A)], 'turn', 'WEB:00000000-0000-4000-8000-000000000001')]);
    expect(noIdentity.evidence).toEqual([]);
    expect(noIdentity.scan_diagnostic).toMatchObject({ fiber_root_detected: true, current_key_found: true,
      correlation_key: KEY_A, conversation_unreadable: true, conversation_id_found: false });
    const laterTool = scanFiber([userMessage(), currentConnectorRequest('a', 'submit_goal', KEY_A), request('b', 'get_status')]);
    expect(laterTool.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
    expect(laterTool.scan_diagnostic).toMatchObject({ correlation_key_found: true, current_key_found: true, correlation_key: KEY_A });
    const messages = await contentMessages(noIdentity);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'identity_diagnostic', stage: 'fiber_scanned',
      correlation_key: KEY_A, fiber_evidence_count: 0, evidence_generated: false, conversation_unreadable: true }));
    expect(messages.some(message => message.type === 'identity_evidence')).toBe(false);
    const mismatch = await contentMessages({ version: 1, evidence: [{ request_id: KEY_A, fiber_conversation_id: CONVERSATION_B }] });
    expect(mismatch).toContainEqual(expect.objectContaining({ stage: 'route_checked', fiber_route_match: false }));
    expect(mismatch.some(message => message.type === 'identity_evidence')).toBe(false);
  });
  it("reports the reloaded conversation identity as matched for the fresh correlation key", () => {
    const FRESH_KEY = "dd3bf476-5a9e-4a5d-b445-a09e5dfe9dec";
    const reply = scanFiberSections([{
      __reactFiber$test: {
        memoizedProps: {
          conversation: { id: `WEB:${KEY_A}`, serverId$: () => CONVERSATION },
          turn: { messages: [userMessage("user-fresh"), currentConnectorRequest("fresh", "submit_goal", FRESH_KEY)] },
        },
        return: null,
      },
      getAttribute: (name: string) => name === 'data-turn-id' ? 'fresh-turn' : null,
    }]);
    expect(reply.debug).toMatchObject({
      conversation_id_found: true,
      conversation_conflict: false,
      conversation_unreadable: false,
      fiber_route_match: true,
    });
    expect(reply.evidence).toEqual([{ request_id: FRESH_KEY, fiber_conversation_id: CONVERSATION }]);
  });

  it("resolves a fresh chat only through its own server identity and preserves conflicts", async () => {
    const section = (serverId: unknown, extra: Record<string, unknown> = {}) => ({
      __reactFiber$test: {
        memoizedProps: {
          conversation: { id: `WEB:${KEY_A}`, serverId$: serverId },
          turn: { messages: [userMessage("user-fresh"), currentConnectorRequest("fresh", "submit_goal", KEY_B)] },
          ...extra,
        },
        return: null,
      },
    });
    const valid = scanFiberSections([section(() => CONVERSATION)]);
    expect(valid.evidence).toEqual([{ request_id: KEY_B, fiber_conversation_id: CONVERSATION }]);
    expect((await contentMessages(valid)).filter((m) => m.type === "identity_evidence")).toHaveLength(1);
    for (const serverId of [undefined, () => null, () => "", () => `WEB:${KEY_A}`,
      () => ({}), () => { throw new Error("unavailable"); }]) {
      expect(scanFiberSections([section(serverId)]).evidence).toEqual([]);
    }
    expect(scanFiberSections([section(() => CONVERSATION, { conversationId: CONVERSATION_B })]).evidence).toEqual([]);
    const mismatch = scanFiberSections([section(() => CONVERSATION_B)]);
    expect((await contentMessages(mismatch)).filter((m) => m.type === "identity_evidence")).toEqual([]);
  });

  it("sends only the current submit_goal key when history has older keys", () => {
    const reply = scanFiberSections([
      fiberSection([currentConnectorRequest("old-a", "submit_goal", KEY_A)], "turn-a"),
      fiberSection([currentConnectorRequest("old-b", "submit_goal", KEY_B)], "turn-b"),
      fiberSection([currentConnectorRequest("old-c", "submit_goal", KEY_C)], "turn-c"),
      fiberSection([userMessage(), currentConnectorRequest("current", "submit_goal", KEY_D)], "turn-d"),
    ]);
    expect(reply.evidence).toEqual([{
      request_id: KEY_D,
      fiber_conversation_id: CONVERSATION,
    }]);
    expect(reply.diagnostic).toEqual({ source: "assistant_tool_arguments", matched: true });
  });

  it("does not emit an old submit_goal key when the current turn has no submit_goal", () => {
    const reply = scanFiberSections([
      fiberSection([currentConnectorRequest("old", "submit_goal", KEY_A)], "turn-a"),
      fiberSection([{ author: { role: "user" }, content: { content_type: "text", text: "current" } }], "turn-b"),
    ]);
    expect(reply.evidence).toEqual([]);
    expect(reply.diagnostic).toEqual({ source: "none", matched: false });
  });

  it("selects the tool-bearing turn before the latest final assistant turn", () => {
    const reply = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "user-turn"),
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "tool-turn"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "final-turn"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("uses the latest submit_goal even when a non-goal tool precedes it", () => {
    const reply = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "user-turn"),
      fiberSection([
        currentConnectorRequest("workspace", "workspace_info", KEY_B),
        currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      ], "tool-turn"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "final-turn"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("does not cross the latest user boundary for historical correlation", () => {
    const reply = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "old-user-turn"),
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "old-tool-turn"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "old-final-turn"),
      fiberSection([{ id: "user-b", author: { role: "user" } }], "current-user-turn"),
      fiberSection([{ id: "final-b", author: { role: "assistant" } }], "current-final-turn"),
    ]);
    expect(reply.evidence).toEqual([]);
  });

  it("does not use the previous exchange tool when the current user and final share one turn", () => {
    const reply = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "old-user-turn"),
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "old-tool-turn"),
      fiberSection([
        { id: "user-b", author: { role: "user" } },
        { id: "final-b", author: { role: "assistant" } },
      ], "current-turn"),
    ]);
    expect(reply.evidence).toEqual([]);
  });

  it("selects a tool that follows the user message inside one snapshot", () => {
    const reply = scanFiberSections([
      fiberSection([
        { id: "user-a", author: { role: "user" } },
        currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      ], "current-turn"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("keeps the latest submit_goal after an unrelated tool inside one snapshot", () => {
    const reply = scanFiberSections([
      fiberSection([
        { id: "user-a", author: { role: "user" } },
        currentConnectorRequest("workspace", "workspace_info", KEY_B),
        currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      ], "current-turn"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("keeps the tool authority when a final assistant message follows it", () => {
    const reply = scanFiberSections([
      fiberSection([
        { id: "user-a", author: { role: "user" } },
        currentConnectorRequest("submit-a", "submit_goal", KEY_A),
        { id: "final-a", author: { role: "assistant" } },
      ], "current-turn"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("never uses a tool that precedes the current user message", () => {
    const reply = scanFiberSections([
      fiberSection([
        currentConnectorRequest("old-submit", "submit_goal", KEY_A),
        { id: "user-b", author: { role: "user" } },
        { id: "final-b", author: { role: "assistant" } },
      ], "current-turn"),
    ]);
    expect(reply.evidence).toEqual([]);
  });

  it("walks back to the tool turn when the final turn carries the current user message", () => {
    const reply = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "user-turn"),
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "tool-turn"),
      fiberSection([
        { id: "user-a", author: { role: "user" } },
        { id: "final-a", author: { role: "assistant" } },
      ], "final-turn"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("stops at the current user boundary when the exchange has no tool", () => {
    const reply = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "old-user-turn"),
      fiberSection([currentConnectorRequest("old-submit", "submit_goal", KEY_A)], "old-tool-turn"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "old-final-turn"),
      fiberSection([{ id: "user-b", author: { role: "user" } }], "current-user-turn"),
      fiberSection([
        { id: "user-b", author: { role: "user" } },
        { id: "final-b", author: { role: "assistant" } },
      ], "current-final-turn"),
    ]);
    expect(reply.evidence).toEqual([]);
  });

  it("keeps the submit_goal key when the exchange ends with a non-goal tool", () => {
    const reply = scanFiberSections([
      fiberSection([
        { id: "user-a", author: { role: "user" } },
        currentConnectorRequest("submit-a", "submit_goal", KEY_A),
        currentConnectorRequest("review", "review_summary", KEY_B),
        { id: "final-a", author: { role: "assistant" } },
      ], "current-turn"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
    expect(reply.scan_diagnostic).toMatchObject({ current_key_found: true, correlation_key: KEY_A });
  });

  it("selects the latest submit_goal-bearing section snapshot without merging messages", () => {
    const reply = scanFiberSections([
      fiberSection([currentConnectorRequest("workspace", "workspace_info")], "split-turn"),
      fiberSection([userMessage(), currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "split-turn"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
    expect(reply.scan_diagnostic.assistant_tool_calls_found).toBe(1);
  });

  it("prefers a complete fresh snapshot with the same message id", () => {
    const reply = scanFiberSections([
      fiberSection([currentConnectorRequest("same-message", "submit_goal")], "refresh-turn"),
      fiberSection([userMessage(), currentConnectorRequest("same-message", "submit_goal", KEY_A)], "refresh-turn"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("does not let a same-user final snapshot hide an earlier tool snapshot", () => {
    const reply = scanFiberSections([
      fiberSection([
        { id: "user-a", author: { role: "user" } },
        currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      ], "same-turn"),
      fiberSection([
        { id: "user-a", author: { role: "user" } },
        { id: "final-a", author: { role: "assistant" } },
      ], "same-turn"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("does not use an earlier tool that precedes the anchor user", () => {
    const reply = scanFiberSections([
      fiberSection([
        currentConnectorRequest("old-submit", "submit_goal", KEY_A),
        { id: "user-a", author: { role: "user" } },
      ], "same-turn"),
      fiberSection([
        { id: "user-a", author: { role: "user" } },
        { id: "final-a", author: { role: "assistant" } },
      ], "same-turn"),
    ]);
    expect(reply.evidence).toEqual([]);
  });

  it("rejects an invalid authoritative snapshot without falling back", () => {
    const conflict = scanFiberSections([
      fiberSection([currentConnectorRequest("old", "submit_goal", KEY_B)], "identity-turn"),
      fiberSection([userMessage(), currentConnectorRequest("current", "submit_goal", KEY_A)], "identity-turn", CONVERSATION, {
        conversationId: CONVERSATION_B,
      }),
    ]);
    expect(conflict.evidence).toEqual([]);
    expect(conflict.scan_diagnostic).toMatchObject({ conversation_conflict: true, conversation_id_found: false });

    const unreadable = scanFiberSections([
      fiberSection([currentConnectorRequest("old", "submit_goal", KEY_B)], "identity-turn"),
      fiberSection([userMessage(), currentConnectorRequest("current", "submit_goal", KEY_A)], "identity-turn", `WEB:${KEY_A}`),
    ]);
    expect(unreadable.evidence).toEqual([]);
    expect(unreadable.scan_diagnostic).toMatchObject({ conversation_unreadable: true, conversation_id_found: false });
  });

  it("extracts a valid key from the current direct Connector request shape", () => {
    const reply = scanFiber([userMessage(), currentConnectorRequest("submit-current", "submit_goal", KEY_A)]);
    expect(reply.evidence).toContainEqual({
      request_id: KEY_A,
      fiber_conversation_id: CONVERSATION,
    });
  });

  it("extracts a key from the standard tool-call argument fields", () => {
    const contentArguments = {
      id: "content-arguments",
      author: { role: "assistant" },
      recipient: "Local_MCP_Connector.submit_goal",
      content: { content_type: "tool_call", arguments: JSON.stringify({ correlation_key: KEY_A }) },
    };
    const messageArguments = {
      id: "message-arguments",
      author: { role: "assistant" },
      recipient: "Local_MCP_Connector.submit_goal",
      content: { content_type: "tool_call" },
      arguments: { correlation_key: KEY_B },
    };
    expect(scanFiber([userMessage(), contentArguments]).evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
    expect(scanFiber([userMessage(), messageArguments]).evidence).toEqual([{ request_id: KEY_B, fiber_conversation_id: CONVERSATION }]);

    const textPayload = {
      id: "text-payload",
      author: { role: "assistant" },
      recipient: "Local_MCP_Connector.submit_goal",
      content: { content_type: "tool_call", text: JSON.stringify({ correlation_key: KEY_C }) },
    };
    expect(scanFiber([userMessage(), textPayload]).evidence).toEqual([{ request_id: KEY_C, fiber_conversation_id: CONVERSATION }]);
  });

  it("reports fail-closed submit_goal parsing reasons without generating evidence", async () => {
    const cases = [
      {
        reason: "unsupported_content_type",
        found: true,
        message: {
          id: "unsupported-content",
          author: { role: "assistant" },
          recipient: "Local_MCP_Connector.submit_goal",
          content: { content_type: "text", text: JSON.stringify({ correlation_key: KEY_A }) },
        },
      },
      {
        reason: "missing_tool_payload",
        found: true,
        message: {
          id: "missing-payload",
          author: { role: "assistant" },
          recipient: "Local_MCP_Connector.submit_goal",
          content: { content_type: "tool_call" },
        },
      },
      {
        reason: "invalid_json",
        found: true,
        message: {
          id: "invalid-json",
          author: { role: "assistant" },
          recipient: "Local_MCP_Connector.submit_goal",
          content: { content_type: "tool_call", arguments: "{bad" },
        },
      },
      {
        reason: "missing_correlation_key",
        found: true,
        message: {
          id: "missing-key",
          author: { role: "assistant" },
          recipient: "Local_MCP_Connector.submit_goal",
          content: { content_type: "tool_call", arguments: {} },
        },
      },
      {
        reason: "invalid_correlation_key",
        found: true,
        message: {
          id: "invalid-key",
          author: { role: "assistant" },
          recipient: "Local_MCP_Connector.submit_goal",
          content: { content_type: "tool_call", arguments: { correlation_key: "invalid" } },
        },
      },
    ] as const;

    const unrelated = scanFiber([userMessage(), currentConnectorRequest("other-tool", "workspace_info", KEY_A)]);
    expect(unrelated.evidence).toEqual([]);
    expect(unrelated.scan_diagnostic).toMatchObject({ submit_goal_found: false, correlation_key_found: false });

    for (const testCase of cases) {
      const reply = scanFiber([userMessage(), testCase.message]);
      expect(reply.evidence).toEqual([]);
      expect(reply.scan_diagnostic).toMatchObject({
        submit_goal_found: testCase.found,
        correlation_key_found: false,
        submit_goal_reason: testCase.reason,
      });
    }

    const missingKey = scanFiber([userMessage(), cases[3].message]);
    const messages = await contentMessages(missingKey);
    expect(messages).toContainEqual(expect.objectContaining({
      type: "identity_diagnostic",
      stage: "fiber_scanned",
      submit_goal_reason: "missing_correlation_key",
      evidence_generated: false,
    }));
    expect(messages.some((message) => message.type === "identity_evidence")).toBe(false);
  });

  it("does not use another current Connector tool as submit_goal correlation", () => {
    const reply = scanFiber([
      userMessage(),
      currentConnectorRequest("workspace", "workspace_info", KEY_A),
      currentConnectorRequest("other", "review_summary", KEY_B),
    ]);
    const keys = reply.evidence.map((entry: Record<string, unknown>) => entry.request_id);
    expect(keys).not.toContain(KEY_A);
    expect(keys).not.toContain(KEY_B);
  });

  it("rejects invalid keys, text-only injection, and non-request messages", () => {
    const reply = scanFiber([
      userMessage(),
      request("invalid", "submit_goal", "00000000-0000-1000-8000-000000000003"),
      currentConnectorRequest("invalid-current", "submit_goal", "00000000-0000-1000-8000-000000000004"),
      request("other", "workspace_info", KEY_A),
      { author: { role: "user" }, content: { content_type: "text", parts: [`correlation_key=${KEY_A}`] } },
      { author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: [KEY_A] } },
      { author: { role: "tool" }, recipient: "all", content: {
        content_type: "code",
        text: JSON.stringify({ name: "submit_goal", arguments: JSON.stringify({ correlation_key: KEY_A }) }),
      } },
    ]);
    const keys = reply.evidence.map((entry: Record<string, unknown>) => entry.request_id);
    expect(keys).toEqual([]);
  });

  it("does not let an old Fiber request id pollute the current key", async () => {
    const reply = scanFiber([userMessage(), request("old", "workspace_info", undefined, "A"), currentConnectorRequest("current", "submit_goal", KEY_B)]);
    const messages = await contentMessages(reply);
    expect(messages.filter((message) => message.type === "identity_evidence").map((message) => message.request_id))
      .toEqual([KEY_B]);
  });

  it("fails closed when the current submit_goal has no correlation_key", () => {
    const reply = scanFiber([
      currentConnectorRequest("old", "submit_goal", KEY_A),
      currentConnectorRequest("current", "submit_goal"),
    ]);
    expect(reply.evidence).toEqual([]);
  });

  it("uses the submit_goal key instead of metadata.request_id", async () => {
    const messages = await contentMessages(scanFiber([
      userMessage(),
      currentConnectorRequest("submit-current", "submit_goal", KEY_B, KEY_A),
    ]));
    expect(messages.filter((message) => message.type === "identity_evidence")).toEqual([{
      type: "identity_evidence",
      request_id: KEY_B,
      conversation_id: CONVERSATION,
      navigation_epoch: 0,
    }]);
  });

  it("passes the legacy submit_goal key through identity evidence", async () => {
    const messages = await contentMessages(scanFiber([userMessage(), request("submit", "submit_goal", KEY_A)]));
    expect(messages).toContainEqual({
      type: "identity_evidence",
      request_id: KEY_A,
      conversation_id: CONVERSATION,
      navigation_epoch: 0,
    });
  });

  it("keeps each conversation's current submit_goal key isolated", () => {
    const replyA = scanFiberSections([
      fiberSection([userMessage("user-a"), currentConnectorRequest("conversation-a", "submit_goal", KEY_A)], "turn-a", CONVERSATION),
    ]);
    const replyB = scanFiberSections([
      fiberSection([userMessage("user-b"), currentConnectorRequest("conversation-b", "submit_goal", KEY_B)], "turn-b", CONVERSATION_B),
    ]);
    expect(replyA.evidence).toEqual([{
      request_id: KEY_A,
      fiber_conversation_id: CONVERSATION,
    }]);
    expect(replyB.evidence).toEqual([{
      request_id: KEY_B,
      fiber_conversation_id: CONVERSATION_B,
    }]);
  });

  it("does not submit evidence after navigation changes during the Fiber scan", async () => {
    const messages = await contentMessages(
      scanFiber([userMessage(), currentConnectorRequest("current", "submit_goal", KEY_B)]),
      { fiberReplyDelayMs: 100, navigateBeforeFiberReply: `/c/${CONVERSATION_B}` },
    );
    expect(messages.filter((message) => message.type === "identity_evidence")).toEqual([]);
  });

  it("matrix A: keeps the submit_goal key after identity and transport diagnostics", () => {
    const reply = scanFiber([
      userMessage(),
      currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      currentConnectorRequest("identity", "get_identity_trace"),
      currentConnectorRequest("transport", "get_evidence_transport_trace"),
      { id: "final-a", author: { role: "assistant" } },
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("matrix B: keeps the submit_goal key after a plain review_summary tool", () => {
    const reply = scanFiber([userMessage(),
      currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      currentConnectorRequest("review", "review_summary")]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("matrix C: keeps the submit_goal key when another tool precedes it", () => {
    const reply = scanFiber([userMessage(),
      currentConnectorRequest("workspace", "workspace_info"),
      currentConnectorRequest("submit-a", "submit_goal", KEY_A)]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("matrix D: the latest submit_goal wins over an earlier valid one", () => {
    const reply = scanFiber([userMessage(),
      currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      currentConnectorRequest("workspace", "workspace_info"),
      currentConnectorRequest("submit-b", "submit_goal", KEY_B),
      currentConnectorRequest("review", "review_summary")]);
    expect(reply.evidence).toEqual([{ request_id: KEY_B, fiber_conversation_id: CONVERSATION }]);
  });

  it("matrix E: a malformed latest submit_goal fails closed without falling back", () => {
    const reply = scanFiber([userMessage(),
      currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      currentConnectorRequest("review", "review_summary"),
      currentConnectorRequest("submit-latest", "submit_goal"),
      currentConnectorRequest("identity", "get_identity_trace")]);
    expect(reply.evidence).toEqual([]);
    expect(reply.scan_diagnostic).toMatchObject({ current_key_found: false, correlation_key: null,
      submit_goal_reason: "missing_correlation_key" });
  });

  it("matrix F: an invalid UUID latest submit_goal fails closed without falling back", () => {
    const reply = scanFiber([userMessage(),
      currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      currentConnectorRequest("submit-latest", "submit_goal", "00000000-0000-1000-8000-000000000005")]);
    expect(reply.evidence).toEqual([]);
    expect(reply.scan_diagnostic).toMatchObject({ current_key_found: false, correlation_key: null,
      submit_goal_reason: "invalid_correlation_key" });
  });

  it("matrix G: keeps the submit_goal key across a later diagnostic logical turn", () => {
    const reply = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "turn-1"),
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "turn-2"),
      fiberSection([currentConnectorRequest("identity", "get_identity_trace")], "turn-3"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "turn-4"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("matrix H: keeps the submit_goal key when a later section only carries diagnostics", () => {
    const reply = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }, currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "split-turn"),
      fiberSection([{ id: "user-a", author: { role: "user" } }, currentConnectorRequest("identity", "get_identity_trace"), { id: "final-a", author: { role: "assistant" } }], "split-turn"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("matrix I: does not reach back into a previous user exchange", () => {
    const reply = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }, currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "turn-1"),
      fiberSection([{ id: "user-b", author: { role: "user" } }, currentConnectorRequest("workspace", "workspace_info"), { id: "final-b", author: { role: "assistant" } }], "turn-2"),
    ]);
    expect(reply.evidence).toEqual([]);
  });

  it("matrix J: does not use a submit_goal that precedes the anchor user", () => {
    const reply = scanFiberSections([
      fiberSection([currentConnectorRequest("old-submit", "submit_goal", KEY_A),
        { id: "user-b", author: { role: "user" } }, currentConnectorRequest("identity", "get_identity_trace"), { id: "final-b", author: { role: "assistant" } }], "turn-1"),
    ]);
    expect(reply.evidence).toEqual([]);
  });

  it("matrix K: a conflict or unreadable identity on the selected snapshot fails closed", () => {
    const reply = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }, currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "turn-1"),
      fiberSection([currentConnectorRequest("submit-b", "submit_goal", KEY_B)], "turn-2", CONVERSATION, { conversationId: CONVERSATION_B }),
    ]);
    expect(reply.evidence).toEqual([]);
    expect(reply.scan_diagnostic).toMatchObject({ conversation_conflict: true, conversation_id_found: false });
  });

  it("unanchored: keeps a current submit_goal without any stable user anchor", () => {
    const singleTurn = scanFiber([
      currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      { id: "final-a", author: { role: "assistant" } },
    ]);
    expect(singleTurn.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);

    const afterFinal = scanFiberSections([
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "turn-1"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "turn-2"),
    ]);
    expect(afterFinal.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);

    const afterDiagnostic = scanFiberSections([
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "turn-1"),
      fiberSection([currentConnectorRequest("identity", "get_identity_trace")], "turn-2"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "turn-3"),
    ]);
    expect(afterDiagnostic.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);

    const diagnosticAfterTool = scanFiber([
      currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      currentConnectorRequest("identity", "get_identity_trace"),
    ]);
    expect(diagnosticAfterTool.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("unanchored: never reaches back across a user boundary", () => {
    const unreadableCurrentUser = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "turn-1"),
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "turn-2"),
      fiberSection([{ author: { role: "user" } }], "turn-3"),
      fiberSection([{ id: "final-b", author: { role: "assistant" } }], "turn-4"),
    ]);
    expect(unreadableCurrentUser.evidence).toEqual([]);

    const unreadableUserAfterTool = scanFiberSections([
      fiberSection([currentConnectorRequest("old", "submit_goal", KEY_A)], "turn-1"),
      fiberSection([{ author: { role: "user" } }], "turn-2"),
      fiberSection([{ id: "final-b", author: { role: "assistant" } }], "turn-3"),
    ]);
    expect(unreadableUserAfterTool.evidence).toEqual([]);

    const newerSubmitGoal = scanFiberSections([
      fiberSection([currentConnectorRequest("old", "submit_goal", KEY_A)], "turn-1"),
      fiberSection([{ id: "user-a", author: { role: "user" } }], "turn-2"),
      fiberSection([currentConnectorRequest("new", "submit_goal", KEY_B)], "turn-3"),
    ]);
    expect(newerSubmitGoal.evidence).toEqual([{ request_id: KEY_B, fiber_conversation_id: CONVERSATION }]);
  });

  it("anchored: never reaches back across a user boundary between logical turns", () => {
    const separatedTurns = scanFiberSections([
      fiberSection([currentConnectorRequest("old-submit", "submit_goal", KEY_A)], "old-tool-turn"),
      fiberSection([{ id: "user-a", author: { role: "user" } }], "current-user-turn"),
    ]);
    expect(separatedTurns.evidence).toEqual([]);

    const separatedWithFinal = scanFiberSections([
      fiberSection([currentConnectorRequest("old-submit", "submit_goal", KEY_A)], "old-tool-turn"),
      fiberSection([{ id: "user-a", author: { role: "user" } }], "current-user-turn"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "current-final-turn"),
    ]);
    expect(separatedWithFinal.evidence).toEqual([]);
  });

  it("unanchored: refuses a submit_goal older than the local tail", () => {
    const oneBeyondBoundary = scanFiberSections([
      fiberSection([currentConnectorRequest("old-submit", "submit_goal", KEY_A)], "turn-1"),
      fiberSection([{ id: "note-a", author: { role: "assistant" } }], "turn-2"),
      fiberSection([currentConnectorRequest("identity", "get_identity_trace")], "turn-3"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "turn-4"),
    ]);
    expect(oneBeyondBoundary.evidence).toEqual([]);

    const distantHistory = scanFiberSections([
      fiberSection([currentConnectorRequest("old-submit", "submit_goal", KEY_A)], "turn-1"),
      fiberSection([{ id: "note-a", author: { role: "assistant" } }], "turn-2"),
      fiberSection([currentConnectorRequest("workspace", "workspace_info")], "turn-3"),
      fiberSection([{ id: "note-b", author: { role: "assistant" } }], "turn-4"),
      fiberSection([currentConnectorRequest("review", "review_summary")], "turn-5"),
      fiberSection([{ id: "note-c", author: { role: "assistant" } }], "turn-6"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "turn-7"),
    ]);
    expect(distantHistory.evidence).toEqual([]);
  });

  it("anchored: may span more turns than the unanchored local tail", () => {
    const reply = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "turn-1"),
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "turn-2"),
      fiberSection([currentConnectorRequest("identity", "get_identity_trace")], "turn-3"),
      fiberSection([{ id: "note-a", author: { role: "assistant" } }], "turn-4"),
      fiberSection([{ id: "user-a", author: { role: "user" } }, { id: "final-a", author: { role: "assistant" } }], "turn-5"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("unanchored: a historical user anchor cannot lift the local tail limit", () => {
    const staleAnchor = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "turn-1"),
      fiberSection([currentConnectorRequest("old-submit", "submit_goal", KEY_A)], "turn-2"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "turn-3"),
      fiberSection([{ id: "note-a", author: { role: "assistant" } }], "turn-4"),
      fiberSection([currentConnectorRequest("identity", "get_identity_trace")], "turn-5"),
      fiberSection([{ id: "final-current", author: { role: "assistant" } }], "turn-6"),
    ]);
    expect(staleAnchor.evidence).toEqual([]);

    const staleAnchorOneShorter = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "turn-1"),
      fiberSection([currentConnectorRequest("old-submit", "submit_goal", KEY_A)], "turn-2"),
      fiberSection([{ id: "note-a", author: { role: "assistant" } }], "turn-3"),
      fiberSection([currentConnectorRequest("identity", "get_identity_trace")], "turn-4"),
      fiberSection([{ id: "final-current", author: { role: "assistant" } }], "turn-5"),
    ]);
    expect(staleAnchorOneShorter.evidence).toEqual([]);
  });

  it("anchored: a current-tail anchor still reaches back to an older submit_goal", () => {
    const anchorInsideTail = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "turn-1"),
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "turn-2"),
      fiberSection([currentConnectorRequest("identity", "get_identity_trace")], "turn-3"),
      fiberSection([{ id: "user-a", author: { role: "user" } }, { id: "final-a", author: { role: "assistant" } }], "turn-4"),
    ]);
    expect(anchorInsideTail.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);

    const anchorSixTurnsBack = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "turn-1"),
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "turn-2"),
      fiberSection([{ id: "note-a", author: { role: "assistant" } }], "turn-3"),
      fiberSection([currentConnectorRequest("identity", "get_identity_trace")], "turn-4"),
      fiberSection([{ id: "note-b", author: { role: "assistant" } }], "turn-5"),
      fiberSection([{ id: "user-a", author: { role: "user" } }, { id: "final-a", author: { role: "assistant" } }], "turn-6"),
    ]);
    expect(anchorSixTurnsBack.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("unstable user: keeps a current submit_goal that follows an unnamed user boundary", () => {
    // A: the boundary turn, the submit_goal turn and the final turn are separate.
    const caseA = scanFiberSections([
      fiberSection([unstableUserMessage()], "turn-1"),
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "turn-2"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "turn-3"),
    ]);
    expect(caseA.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);

    // C: a diagnostic turn may sit between the boundary and the submit_goal inside the tail.
    const caseC = scanFiberSections([
      fiberSection([unstableUserMessage()], "turn-1"),
      fiberSection([currentConnectorRequest("identity", "get_identity_trace")], "turn-2"),
      fiberSection([currentConnectorRequest("submit-a", "submit_goal", KEY_A)], "turn-3"),
    ]);
    expect(caseC.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);

    // E: the boundary and the submit_goal share one snapshot.
    const caseE = scanFiberSections([
      fiberSection([
        unstableUserMessage(),
        currentConnectorRequest("submit-a", "submit_goal", KEY_A),
      ], "current-turn"),
    ]);
    expect(caseE.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);

    // G: an older diagnostic, then the boundary, then the submit_goal, all in one snapshot.
    const caseG = scanFiberSections([
      fiberSection([
        currentConnectorRequest("identity", "get_identity_trace"),
        unstableUserMessage(),
        currentConnectorRequest("submit-a", "submit_goal", KEY_A),
        { id: "final-a", author: { role: "assistant" } },
      ], "current-turn"),
    ]);
    expect(caseG.evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
  });

  it("unstable user: never reaches back across an unnamed user boundary", () => {
    // B: the old submit_goal is its own turn, the boundary is the next one.
    const caseB = scanFiberSections([
      fiberSection([currentConnectorRequest("old", "submit_goal", KEY_A)], "turn-1"),
      fiberSection([unstableUserMessage()], "turn-2"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "turn-3"),
    ]);
    expect(caseB.evidence).toEqual([]);

    // D: the old submit_goal precedes the boundary inside one snapshot.
    const caseD = scanFiberSections([
      fiberSection([
        currentConnectorRequest("old", "submit_goal", KEY_A),
        unstableUserMessage(),
        { id: "final-a", author: { role: "assistant" } },
      ], "current-turn"),
    ]);
    expect(caseD.evidence).toEqual([]);

    // D: a newer submit_goal after the same boundary stays claimable.
    const newer = scanFiberSections([
      fiberSection([currentConnectorRequest("old", "submit_goal", KEY_A)], "turn-1"),
      fiberSection([unstableUserMessage()], "turn-2"),
      fiberSection([currentConnectorRequest("new", "submit_goal", KEY_B)], "turn-3"),
    ]);
    expect(newer.evidence).toEqual([{ request_id: KEY_B, fiber_conversation_id: CONVERSATION }]);
  });

  it("unstable user: an unnamed boundary is not a stable anchor and does not widen the tail", () => {
    // D: the boundary turn holds no submit_goal, so no earlier turn is reachable.
    const caseD = scanFiberSections([
      fiberSection([unstableUserMessage()], "turn-1"),
      fiberSection([currentConnectorRequest("identity", "get_identity_trace")], "turn-2"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "turn-3"),
    ]);
    expect(caseD.evidence).toEqual([]);

    // An older stable user must not become the anchor once an unnamed boundary is newer.
    const historicalStableUser = scanFiberSections([
      fiberSection([{ id: "user-a", author: { role: "user" } }], "turn-1"),
      fiberSection([currentConnectorRequest("old", "submit_goal", KEY_A)], "turn-2"),
      fiberSection([unstableUserMessage()], "turn-3"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "turn-4"),
    ]);
    expect(historicalStableUser.evidence).toEqual([]);

    // A submit_goal before the unnamed boundary stays unreachable even inside the tail.
    const olderThanBoundary = scanFiberSections([
      fiberSection([currentConnectorRequest("old", "submit_goal", KEY_A)], "turn-1"),
      fiberSection([{ id: "note-a", author: { role: "assistant" } }], "turn-2"),
      fiberSection([unstableUserMessage()], "turn-3"),
      fiberSection([{ id: "final-a", author: { role: "assistant" } }], "turn-4"),
    ]);
    expect(olderThanBoundary.evidence).toEqual([]);
  });

  it("anchored: does not claim a submit_goal between an older unstable user and a newer stable anchor", () => {
    const separatedTurns = scanFiberSections([
      fiberSection([unstableUserMessage()], "turn-1"),
      fiberSection([currentConnectorRequest("old", "submit_goal", KEY_A)], "turn-2"),
      fiberSection([{ id: "user-b", author: { role: "user" } }, { id: "final-b", author: { role: "assistant" } }], "turn-3"),
    ]);
    expect(separatedTurns.evidence).toEqual([]);

    // The submit_goal sits after the unnamed user, but that user still cannot be shown to
    // be the same person as the stable anchor discovered in a later turn.
    const sameOldSnapshot = scanFiberSections([
      fiberSection([
        unstableUserMessage(),
        currentConnectorRequest("old", "submit_goal", KEY_A),
      ], "turn-1"),
      fiberSection([
        { id: "user-b", author: { role: "user" } },
        { id: "final-b", author: { role: "assistant" } },
      ], "turn-2"),
    ]);
    expect(sameOldSnapshot.evidence).toEqual([]);
  });

  it("anchored: keeps a submit_goal that follows the stable anchor when an older user is unnamed", () => {
    const reply = scanFiberSections([
      fiberSection([unstableUserMessage()], "turn-1"),
      fiberSection([{ id: "user-b", author: { role: "user" } }], "turn-2"),
      fiberSection([currentConnectorRequest("submit-b", "submit_goal", KEY_B)], "turn-3"),
      fiberSection([{ id: "final-b", author: { role: "assistant" } }], "turn-4"),
    ]);
    expect(reply.evidence).toEqual([{ request_id: KEY_B, fiber_conversation_id: CONVERSATION }]);
  });
});
