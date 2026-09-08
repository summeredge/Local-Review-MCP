import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://chatgpt.com";
const CONVERSATION_A = "11111111-2222-3333-4444-555555555555";
const CONVERSATION_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const WFR_REQUEST_ID = "wfr_01a014bdd7cd7a15b6b533d3ce2b42f2";
const UUID_REQUEST_ID = "32ca0d45-8b29-414a-bbe4-8e26c3aae911";
const REAL_TURN_DEPTH = 30;

let fiberSource = "";
let contentSource = "";
let backgroundSource = "";
let manifest: Record<string, unknown>;

beforeAll(async () => {
  const files = await Promise.all([
    readFile("extension/fiber.js", "utf8"),
    readFile("extension/content.js", "utf8"),
    readFile("extension/background.js", "utf8"),
    readFile("extension/manifest.json", "utf8"),
  ]);
  [fiberSource, contentSource, backgroundSource] = files;
  manifest = JSON.parse(files[3]) as Record<string, unknown>;
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
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
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

function fiberSection(
  conversationId: unknown,
  messages: unknown[],
  extraProps: Record<string, unknown> = {},
  turnId = "turn-1",
): Record<string, unknown> {
  let returnFiber: Record<string, unknown> = {
    memoizedProps: {
      ...(typeof conversationId === "string" ? { conversation: { id: conversationId } } : {}),
      turn: {
        messages,
      },
      return: null,
    },
    return: null,
  };
  for (let depth = 0; depth < REAL_TURN_DEPTH; depth += 1) {
    returnFiber = {
      memoizedProps: { children: null },
      return: returnFiber,
    };
  }
  return {
    getAttribute(name: string) {
      return name === "data-turn-id" ? turnId : null;
    },
    __reactFiber$test: {
      memoizedProps: { children: null, ...extraProps },
      return: returnFiber,
    },
  };
}

function scanFiber(sections: Record<string, unknown>[]): Record<string, unknown> {
  const window = pageWindow();
  const context = {
    window,
    document: { querySelectorAll: () => sections },
    location: { origin: ORIGIN },
  };
  vm.runInNewContext(fiberSource, context, { filename: "fiber.js" });
  let reply: Record<string, unknown> | undefined;
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data && typeof data === "object"
      && (data as Record<string, unknown>).source === "lrm-extension-identity-reply") {
      reply = data as Record<string, unknown>;
    }
  });
  window.postMessage({ source: "lrm-extension-identity-ask", nonce: "test" }, ORIGIN);
  if (!reply) throw new Error("fiber helper did not answer");
  return reply;
}

describe("MAIN-world Fiber identity evidence", () => {
  it("is directly loadable as one minimal Chrome/Edge MV3 extension", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: "background.js" });
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.host_permissions).toEqual([
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "http://127.0.0.1:12081/*",
      "http://127.0.0.1:12082/*",
      "http://127.0.0.1:12083/*",
      "http://127.0.0.1:12084/*",
      "http://127.0.0.1:12085/*",
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(/popup|scripting|webNavigation|activeTab|tabs/iu);
  });

  it("allowlists metadata.request_id and the matching Fiber conversation", () => {
    const reply = scanFiber([fiberSection(CONVERSATION_A, [
      { metadata: { request_id: WFR_REQUEST_ID }, content: { text: '{"args":{"secret":"no"}}' } },
      { metadata: { request_id: "invalid.id" } },
    ])]);
    expect(reply.evidence).toEqual([{
      request_id: WFR_REQUEST_ID,
      fiber_conversation_id: CONVERSATION_A,
    }]);
  });

  it("preserves an opaque UUID request id from Fiber through content evidence", async () => {
    const reply = scanFiber([fiberSection(CONVERSATION_A, [
      { metadata: { request_id: UUID_REQUEST_ID } },
    ])]);
    const evidence = reply.evidence as Array<{ request_id: string; fiber_conversation_id: string }>;
    expect(evidence).toEqual([{
      request_id: UUID_REQUEST_ID,
      fiber_conversation_id: CONVERSATION_A,
    }]);

    const harness = loadContent(
      CONVERSATION_A,
      CONVERSATION_A,
      `/c/${CONVERSATION_A}`,
      evidence[0]!.request_id,
    );
    await settleContent();
    expect(harness.messages.filter((message) => message.type === "identity_evidence")).toEqual([{
      type: "identity_evidence",
      request_id: UUID_REQUEST_ID,
      conversation_id: CONVERSATION_A,
      navigation_epoch: 0,
    }]);
  });

  it("follows the real section-to-turn Fiber traversal and groups split sections", () => {
    const message = { metadata: { request_id: "wfr_deep_turn" } };
    const reply = scanFiber([
      fiberSection(CONVERSATION_A, [message], {}, "logical-turn"),
      fiberSection(CONVERSATION_A, [message], {}, "logical-turn"),
    ]);
    expect(reply.evidence).toEqual([{
      request_id: "wfr_deep_turn",
      fiber_conversation_id: CONVERSATION_A,
    }]);
  });

  it("fails closed for missing/invalid request ids and unknown Fiber shapes", () => {
    expect(scanFiber([fiberSection(CONVERSATION_A, [
      { metadata: {} },
      { metadata: { request_id: "wfr.bad" } },
    ])]).evidence).toEqual([]);
    expect(scanFiber([{ __reactFiber$test: { memoizedProps: { random: true }, return: null } }]).evidence).toEqual([]);
  });

  it("fails closed when a Fiber branch has conflicting conversations", () => {
    const reply = scanFiber([fiberSection(CONVERSATION_A, [{ metadata: { request_id: "wfr_conflict" } }], {
      conversationId: CONVERSATION_B,
    })]);
    expect(reply.evidence).toEqual([]);
  });

  it("drops an id that appears under two different Fiber conversations", () => {
    const reply = scanFiber([
      fiberSection(CONVERSATION_A, [{ metadata: { request_id: "wfr_same" } }], {}, "turn-a"),
      fiberSection(CONVERSATION_B, [{ metadata: { request_id: "wfr_same" } }], {}, "turn-b"),
    ]);
    expect(reply.evidence).toEqual([]);
  });

  it("does not give page code a Bridge or bearer-token path", () => {
    expect(fiberSource).not.toMatch(/\bfetch\s*\(/u);
    expect(fiberSource).not.toMatch(/\bchrome\./u);
    expect(contentSource).not.toMatch(/\bfetch\s*\(/u);
    expect(contentSource).not.toMatch(/chrome\.storage/u);
    expect(contentSource).toContain("url.pathname");
    expect(contentSource).toContain("A-Za-z0-9][A-Za-z0-9_-]{0,255}");
  });
});

interface ContentHarness {
  readonly messages: Record<string, unknown>[];
  readonly setFiberEvidence: (conversationId: string) => void;
  readonly navigate: (conversationId: string) => void;
  readonly navigatePath: (path: string) => void;
}

function loadContent(
  initialConversation: string,
  initialFiberConversation: string,
  initialPath = `/c/${initialConversation}`,
  requestId = "wfr_content",
): ContentHarness {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const messages: Record<string, unknown>[] = [];
  let fiberConversation = initialFiberConversation;
  const location = { origin: ORIGIN, href: new URL(initialPath, ORIGIN).href };
  const window: PageWindow = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    postMessage(data, targetOrigin) {
      if (targetOrigin !== ORIGIN || !data || typeof data !== "object"
        || (data as Record<string, unknown>).source !== "lrm-extension-identity-ask") return;
      const reply = {
        source: "lrm-extension-identity-reply",
        nonce: (data as Record<string, unknown>).nonce,
        version: 1,
        evidence: [{ request_id: requestId, fiber_conversation_id: fiberConversation }],
      };
      for (const listener of listeners.get("message") ?? []) {
        listener({ source: window, origin: ORIGIN, data: reply });
      }
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
  const chrome = {
    runtime: {
      sendMessage(message: Record<string, unknown>, callback: (value: Record<string, unknown>) => void) {
        messages.push(structuredClone(message));
        callback({ ok: true });
      },
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
    setInterval: () => 0,
  }, { filename: "content.js" });
  return {
    messages,
    setFiberEvidence: (conversationId) => { fiberConversation = conversationId; },
    navigate: (conversationId) => history.pushState({}, "", `/c/${conversationId}`),
    navigatePath: (path) => history.pushState({}, "", path),
  };
}

async function settleContent(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 220));
}

describe("content route ownership and navigation epochs", () => {
  it("publishes Project identity evidence with the request id from Fiber metadata", async () => {
    const harness = loadContent(
      CONVERSATION_A,
      CONVERSATION_A,
      `/g/g-p-6a951d05cc448191a399974588cdcf2b/c/${CONVERSATION_A}`,
      "wfr_project",
    );
    await settleContent();

    expect(harness.messages.filter((message) => message.type === "identity_evidence")).toEqual([{
      type: "identity_evidence",
      request_id: "wfr_project",
      conversation_id: CONVERSATION_A,
      navigation_epoch: 0,
    }]);
  });

  it("accepts only root and one-segment Project conversation routes", async () => {
    for (const path of [
      `/c/${CONVERSATION_A}`,
      `/g/g-p-xxxxxxxx/c/${CONVERSATION_A}`,
      `/g/g-xxxxxxxx/c/${CONVERSATION_A}`,
    ]) {
      const harness = loadContent(CONVERSATION_A, CONVERSATION_A, path);
      await settleContent();
      expect(harness.messages.filter((message) => message.type === "identity_evidence"), path)
        .toHaveLength(1);
    }

    for (const path of [
      "/",
      "/c/",
      `/share/c/${CONVERSATION_A}`,
      `/foo/c/${CONVERSATION_A}`,
      "/g/project/",
      `/g/project/foo/c/${CONVERSATION_A}`,
      "/g/project/c/",
    ]) {
      const harness = loadContent(CONVERSATION_A, CONVERSATION_A, path);
      await settleContent();
      expect(harness.messages.filter((message) => message.type === "identity_evidence"), path)
        .toEqual([]);
    }
  });

  it("sends only Fiber evidence that equals the real /c route and advances A to B to A", async () => {
    const harness = loadContent(CONVERSATION_A, CONVERSATION_A);
    await settleContent();
    harness.setFiberEvidence(CONVERSATION_B);
    harness.navigate(CONVERSATION_B);
    await settleContent();
    harness.setFiberEvidence(CONVERSATION_A);
    harness.navigate(CONVERSATION_A);
    await settleContent();

    const evidence = harness.messages.filter((message) => message.type === "identity_evidence");
    expect(evidence).toHaveLength(3);
    expect(evidence.map((message) => [message.conversation_id, message.navigation_epoch])).toEqual([
      [CONVERSATION_A, 0],
      [CONVERSATION_B, 1],
      [CONVERSATION_A, 2],
    ]);
    expect(harness.messages.filter((message) => message.type === "register_document")
      .map((message) => message.navigation_epoch)).toEqual([0, 1, 2]);
  });

  it("advances Project route epochs from A to B to A", async () => {
    const harness = loadContent(CONVERSATION_A, CONVERSATION_A, `/g/project/c/${CONVERSATION_A}`);
    await settleContent();
    harness.setFiberEvidence(CONVERSATION_B);
    harness.navigatePath(`/g/project/c/${CONVERSATION_B}`);
    await settleContent();
    harness.setFiberEvidence(CONVERSATION_A);
    harness.navigatePath(`/g/project/c/${CONVERSATION_A}`);
    await settleContent();

    expect(harness.messages.filter((message) => message.type === "identity_evidence")
      .map((message) => [message.conversation_id, message.navigation_epoch])).toEqual([
        [CONVERSATION_A, 0],
        [CONVERSATION_B, 1],
        [CONVERSATION_A, 2],
      ]);
  });

  it("increments the epoch when switching from a root conversation to a Project", async () => {
    const harness = loadContent(CONVERSATION_A, CONVERSATION_A);
    await settleContent();
    harness.setFiberEvidence(CONVERSATION_B);
    harness.navigatePath(`/g/project/c/${CONVERSATION_B}`);
    await settleContent();

    expect(harness.messages.filter((message) => message.type === "identity_evidence")
      .map((message) => [message.conversation_id, message.navigation_epoch])).toEqual([
        [CONVERSATION_A, 0],
        [CONVERSATION_B, 1],
      ]);
  });

  it("does not publish a Fiber conversation that disagrees with the concrete route", async () => {
    const harness = loadContent(CONVERSATION_A, CONVERSATION_B);
    await settleContent();
    expect(harness.messages.filter((message) => message.type === "identity_evidence")).toEqual([]);
  });
});

class Storage {
  readonly data: Record<string, unknown>;

  public constructor(initial: Record<string, unknown> = {}) {
    this.data = structuredClone(initial);
  }

  public async get(keys: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(keys.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])]));
  }

  public async set(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.data, structuredClone(values));
  }
}

interface FetchCall {
  readonly input: string;
  readonly init: Record<string, unknown>;
}

function response(status: number, body: unknown): Record<string, unknown> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(body),
  };
}

function loadBackground(
  storage: Storage,
  responder: (url: URL, init: Record<string, unknown>) => Promise<Record<string, unknown>>,
): { calls: FetchCall[]; send: (message: Record<string, unknown>, documentId: string, tabId?: number) => Promise<Record<string, unknown>> } {
  let listener: ((message: Record<string, unknown>, sender: Record<string, unknown>, sendResponse: (value: Record<string, unknown>) => void) => boolean) | null = null;
  const calls: FetchCall[] = [];
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
  if (!listener) throw new Error("background listener was not registered");
  return {
    calls,
    send: (message, documentId, tabId = 7) => new Promise((resolve, reject) => {
      try {
        const keep = listener!(message, { tab: { id: tabId }, documentId, frameId: 0 }, resolve);
        if (keep !== true) reject(new Error("background listener did not keep response channel open"));
      } catch (error) {
        reject(error);
      }
    }),
  };
}

const bridgeHello = { service: "local-review-control-bridge", protocol: 1 };
const evidenceMessage = (conversationId: string, navigation_epoch: number, extra: Record<string, unknown> = {}) => ({
  type: "identity_evidence",
  request_id: UUID_REQUEST_ID,
  conversation_id: conversationId,
  navigation_epoch,
  ...extra,
});

describe("Extension background identity authority", () => {
  it("discovers only the fixed Bridge ports, pairs, and stores the token", async () => {
    const storage = new Storage();
    const calls: string[] = [];
    const worker = loadBackground(storage, async (url) => {
      calls.push(`${url.port}${url.pathname}`);
      if (url.pathname === "/hello" && url.port === "12083") return response(200, bridgeHello);
      if (url.pathname === "/pair" && url.port === "12083") return response(200, { token: "paired-token" });
      if (url.pathname === "/identity-evidence") return response(202, { accepted: true });
      return response(503, {});
    });

    expect(await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1")).toMatchObject({ ok: true });
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1")).toMatchObject({ ok: true });
    expect(calls.slice(0, 3)).toEqual(["12081/hello", "12082/hello", "12083/hello"]);
    expect(storage.data.token).toBe("paired-token");
    expect(new URL(worker.calls.at(-1)!.input).pathname).toBe("/identity-evidence");
    expect(JSON.parse(String(worker.calls.at(-1)!.init.body))).toMatchObject({ request_id: UUID_REQUEST_ID });
  });

  it("uses sender.documentId and rejects stale epochs/documents across A to B to A", async () => {
    const storage = new Storage();
    const worker = loadBackground(storage, async (url) => {
      if (url.pathname === "/hello") return response(200, bridgeHello);
      if (url.pathname === "/pair") return response(200, { token: "paired-token" });
      return response(202, { accepted: true });
    });
    const doc1 = "document-1";
    const doc2 = "document-2";

    await worker.send({ type: "register_document", navigation_epoch: 0 }, doc1);
    await worker.send(evidenceMessage(CONVERSATION_A, 0, { document_id: "spoofed-body-id" }), doc1);
    await worker.send({ type: "navigation", navigation_epoch: 1 }, doc1);
    await worker.send(evidenceMessage(CONVERSATION_B, 1), doc1);
    await worker.send({ type: "navigation", navigation_epoch: 2 }, doc1);
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), doc1)).toMatchObject({ ok: false, error: "stale_navigation" });

    expect(await worker.send({ type: "register_document", navigation_epoch: 0 }, doc2)).toMatchObject({ ok: true });
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 2), doc1)).toMatchObject({ ok: false, error: "stale_document" });
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), doc2)).toMatchObject({ ok: true });

    const posted = worker.calls.filter((call) => new URL(call.input).pathname === "/identity-evidence");
    expect(posted).toHaveLength(3);
    expect(JSON.parse(String(posted[0]!.init.body))).toMatchObject({ document_id: doc1, navigation_epoch: 0 });
    expect(JSON.parse(String(posted[2]!.init.body))).toMatchObject({ document_id: doc2, navigation_epoch: 0 });
  });

  it("clears a stale token after 401, re-pairs once, and retries", async () => {
    const storage = new Storage({ port: 12081, token: "stale-token" });
    let evidenceAttempts = 0;
    let pairAttempts = 0;
    const worker = loadBackground(storage, async (url) => {
      if (url.pathname === "/hello") return response(200, bridgeHello);
      if (url.pathname === "/pair") {
        pairAttempts += 1;
        return response(200, { token: "fresh-token" });
      }
      evidenceAttempts += 1;
      return evidenceAttempts === 1 ? response(401, { error: "unauthorized" }) : response(202, { accepted: true });
    });

    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1")).toMatchObject({ ok: true });
    expect(pairAttempts).toBe(1);
    expect(evidenceAttempts).toBe(2);
    expect(storage.data.token).toBe("fresh-token");
    const posted = worker.calls.filter((call) => new URL(call.input).pathname === "/identity-evidence");
    expect((posted[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer stale-token");
    expect((posted[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer fresh-token");
  });

  it("keeps the Bridge out of content and Fiber and leaves no Core correlation hook", () => {
    expect(contentSource).not.toMatch(/identity-evidence.*fetch/isu);
    expect(fiberSource).not.toMatch(/inboundRequestId|ConversationRouting|tool_result|authorization|cookie/iu);
    expect(backgroundSource).not.toMatch(/inboundRequestId|ConversationRouting|ReviewDelivery/iu);
  });
});
