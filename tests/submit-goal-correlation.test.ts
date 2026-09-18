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

function fiberSection(
  messages: unknown[],
  turnId = "turn-1",
  conversationId = CONVERSATION,
): Record<string, unknown> {
  let model: Record<string, unknown> = {
    memoizedProps: { conversation: { id: conversationId }, turn: { id: turnId, messages } },
    return: null,
  };
  for (let depth = 0; depth < 30; depth += 1) {
    model = { memoizedProps: { children: null }, return: model };
  }
  return { __reactFiber$test: model, getAttribute: () => turnId };
}

function scanFiberSections(sections: Record<string, unknown>[]): Record<string, any> {
  const window = pageWindow();
  const debugMessages: string[] = [];
  vm.runInNewContext(fiberSource, {
    window,
    document: { querySelectorAll: () => sections },
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
  it("reports registration, Fiber reply timeout, worker rejection, and navigation fencing independently", async () => {
    const reply = scanFiber([currentConnectorRequest('a', 'submit_goal', KEY_A)]);
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
  it("distinguishes missing root, missing trusted identity, and a newer non-goal tool without historical claiming", async () => {
    const noRoot = scanFiberSections([{}]);
    expect(noRoot.scan_diagnostic).toMatchObject({ fiber_root_detected: false, current_key_found: false });
    const noIdentity = scanFiberSections([fiberSection([currentConnectorRequest('a', 'submit_goal', KEY_A)], 'turn', 'WEB:00000000-0000-4000-8000-000000000001')]);
    expect(noIdentity.evidence).toEqual([]);
    expect(noIdentity.scan_diagnostic).toMatchObject({ fiber_root_detected: true, current_key_found: true,
      correlation_key: KEY_A, conversation_unreadable: true, conversation_id_found: false });
    const laterTool = scanFiber([currentConnectorRequest('a', 'submit_goal', KEY_A), request('b', 'get_status')]);
    expect(laterTool.evidence).toEqual([]);
    expect(laterTool.scan_diagnostic).toMatchObject({ correlation_key_found: true, current_key_found: false, correlation_key: null });
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
          turn: { messages: [currentConnectorRequest("fresh", "submit_goal", FRESH_KEY)] },
        },
        return: null,
      },
      getAttribute: () => "fresh-turn",
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
          turn: { messages: [currentConnectorRequest("fresh", "submit_goal", KEY_B)] },
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
      fiberSection([currentConnectorRequest("current", "submit_goal", KEY_D)], "turn-d"),
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

  it("extracts a valid key from the current direct Connector request shape", () => {
    const reply = scanFiber([currentConnectorRequest("submit-current", "submit_goal", KEY_A)]);
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
    expect(scanFiber([contentArguments]).evidence).toEqual([{ request_id: KEY_A, fiber_conversation_id: CONVERSATION }]);
    expect(scanFiber([messageArguments]).evidence).toEqual([{ request_id: KEY_B, fiber_conversation_id: CONVERSATION }]);

    const textPayload = {
      id: "text-payload",
      author: { role: "assistant" },
      recipient: "Local_MCP_Connector.submit_goal",
      content: { content_type: "tool_call", text: JSON.stringify({ correlation_key: KEY_C }) },
    };
    expect(scanFiber([textPayload]).evidence).toEqual([{ request_id: KEY_C, fiber_conversation_id: CONVERSATION }]);
  });

  it("reports fail-closed submit_goal parsing reasons without generating evidence", async () => {
    const cases = [
      {
        reason: "recipient_mismatch",
        found: false,
        message: currentConnectorRequest("other-tool", "workspace_info", KEY_A),
      },
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

    for (const testCase of cases) {
      const reply = scanFiber([testCase.message]);
      expect(reply.evidence).toEqual([]);
      expect(reply.scan_diagnostic).toMatchObject({
        submit_goal_found: testCase.found,
        correlation_key_found: false,
        submit_goal_reason: testCase.reason,
      });
    }

    const missingKey = scanFiber([cases[4].message]);
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
      currentConnectorRequest("workspace", "workspace_info", KEY_A),
      currentConnectorRequest("other", "review_summary", KEY_B),
    ]);
    const keys = reply.evidence.map((entry: Record<string, unknown>) => entry.request_id);
    expect(keys).not.toContain(KEY_A);
    expect(keys).not.toContain(KEY_B);
  });

  it("rejects invalid keys, text-only injection, and non-request messages", () => {
    const reply = scanFiber([
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
    const reply = scanFiber([request("old", "workspace_info", undefined, "A"), currentConnectorRequest("current", "submit_goal", KEY_B)]);
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
    const messages = await contentMessages(scanFiber([request("submit", "submit_goal", KEY_A)]));
    expect(messages).toContainEqual({
      type: "identity_evidence",
      request_id: KEY_A,
      conversation_id: CONVERSATION,
      navigation_epoch: 0,
    });
  });

  it("keeps each conversation's current submit_goal key isolated", () => {
    const replyA = scanFiberSections([
      fiberSection([currentConnectorRequest("conversation-a", "submit_goal", KEY_A)], "turn-a", CONVERSATION),
    ]);
    const replyB = scanFiberSections([
      fiberSection([currentConnectorRequest("conversation-b", "submit_goal", KEY_B)], "turn-b", CONVERSATION_B),
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
      scanFiber([currentConnectorRequest("current", "submit_goal", KEY_B)]),
      { fiberReplyDelayMs: 100, navigateBeforeFiberReply: `/c/${CONVERSATION_B}` },
    );
    expect(messages.filter((message) => message.type === "identity_evidence")).toEqual([]);
  });
});
