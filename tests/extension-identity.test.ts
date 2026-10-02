import { readFile } from "node:fs/promises";
import * as vm from "node:vm";
import { webcrypto, createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://chatgpt.com";
const CONVERSATION_A = "11111111-2222-3333-4444-555555555555";
const CONVERSATION_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
// Legacy `metadata.request_id` sample and non-UUID key. Only negative tests may use it:
// the formal correlation source is a strict UUIDv4 `submit_goal` correlation key.
const LEGACY_REQUEST_ID = "wfr_01a014bdd7cd7a15b6b533d3ce2b42f2";
const UUID_REQUEST_ID = "32ca0d45-8b29-414a-bbe4-8e26c3aae911";
const UUID_REQUEST_ID_B = "7f3d9c1a-5b6e-4d2f-8a91-0c4e6b8d2f37";
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

// Correlation authority is the current submit_goal `arguments.correlation_key`, never
// `metadata.request_id` and never prose content.
function submitGoalRequest(
  args: Record<string, unknown>,
  id = "submit-current",
): Record<string, unknown> {
  return {
    id,
    author: { role: "assistant" },
    recipient: "Local_MCP_Connector.submit_goal",
    content: { content_type: "tool_call", arguments: { arguments: args } },
  };
}

describe("MAIN-world Fiber identity evidence", () => {
  it("resolves delivery identity without a current submit_goal and rejects conflicting/unreadable models", () => {
    const local = { conversation: { id: "WEB:32ca0d45-8b29-414a-bbe4-8e26c3aae911", serverId$: () => CONVERSATION_A } };
    const reply = scanFiber([fiberSection(CONVERSATION_A, [], local)]);
    expect(reply.conversation_id).toBe(CONVERSATION_A);
    expect(reply.evidence).toEqual([]);
    expect(scanFiber([]).conversation_id).toBeNull();
    expect(scanFiber([fiberSection(CONVERSATION_A, []), fiberSection(CONVERSATION_B, [])])
      .conversation_id).toBeNull();
    expect(scanFiber([fiberSection(CONVERSATION_A, []), fiberSection(null, [])]).conversation_id).toBeNull();
    expect(scanFiber([fiberSection(CONVERSATION_A, [], {
      conversation: { id: "WEB:32ca0d45-8b29-414a-bbe4-8e26c3aae911", serverId$: () => { throw new Error("unreadable"); } },
    })]).conversation_id).toBeNull();
  });

  it("is directly loadable as one minimal Chrome/Edge MV3 extension", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({ service_worker: "background.js" });
    expect(manifest.permissions).toEqual(["storage", "alarms", "tabs", "webRequest"]);
    expect(manifest.host_permissions).toEqual([
      "https://chatgpt.com/*",
      "https://chat.openai.com/*",
      "http://127.0.0.1:12081/*",
      "http://127.0.0.1:12082/*",
      "http://127.0.0.1:12083/*",
      "http://127.0.0.1:12084/*",
      "http://127.0.0.1:12085/*",
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(/popup|scripting|webNavigation|activeTab/iu);
  });

  it("allowlists the current submit_goal correlation key and the matching Fiber conversation", () => {
    const reply = scanFiber([fiberSection(CONVERSATION_A, [
      submitGoalRequest({ correlation_key: UUID_REQUEST_ID }),
    ])]);
    expect(reply.evidence).toEqual([{
      request_id: UUID_REQUEST_ID,
      fiber_conversation_id: CONVERSATION_A,
    }]);
    expect(reply.scan_diagnostic).toMatchObject({
      submit_goal_found: true,
      correlation_key_found: true,
      correlation_key: UUID_REQUEST_ID,
      conversation_id_found: true,
      conversation_conflict: false,
      conversation_unreadable: false,
    });
    // Neither a tool `metadata.request_id` nor prose content is a correlation source.
    expect(scanFiber([fiberSection(CONVERSATION_A, [
      { metadata: { request_id: LEGACY_REQUEST_ID }, content: { text: '{"args":{"secret":"no"}}' } },
    ])]).evidence).toEqual([]);
  });

  it("preserves the submit_goal correlation key from Fiber through content evidence", async () => {
    const reply = scanFiber([fiberSection(CONVERSATION_A, [
      submitGoalRequest({ correlation_key: UUID_REQUEST_ID }),
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
      UUID_REQUEST_ID,
    );
    await settleContent();
    expect(harness.messages.filter((message) => message.type === "identity_evidence")).toEqual([{
      type: "identity_evidence",
      identity_source: "fiber",
      request_id: UUID_REQUEST_ID,
      conversation_id: CONVERSATION_A,
      navigation_epoch: 0,
    }]);
  });

  it("follows the real section-to-turn Fiber traversal and groups split sections", () => {
    const message = submitGoalRequest({ correlation_key: UUID_REQUEST_ID }, "submit-split");
    const reply = scanFiber([
      fiberSection(CONVERSATION_A, [message], {}, "logical-turn"),
      fiberSection(CONVERSATION_A, [message], {}, "logical-turn"),
    ]);
    expect(reply.evidence).toEqual([{
      request_id: UUID_REQUEST_ID,
      fiber_conversation_id: CONVERSATION_A,
    }]);
  });

  it("fails closed for missing/invalid correlation keys and unknown Fiber shapes", () => {
    expect(scanFiber([fiberSection(CONVERSATION_A, [
      { metadata: {} },
      submitGoalRequest({ correlation_key: LEGACY_REQUEST_ID }, "not-a-uuid"),
    ])]).evidence).toEqual([]);
    expect(scanFiber([fiberSection(CONVERSATION_A, [
      submitGoalRequest({}, "missing-key"),
    ])]).evidence).toEqual([]);
    expect(scanFiber([fiberSection(CONVERSATION_A, [
      submitGoalRequest({ correlation_key: undefined }, "undefined-key"),
    ])]).evidence).toEqual([]);
    expect(scanFiber([{ __reactFiber$test: { memoizedProps: { random: true }, return: null } }]).evidence).toEqual([]);
  });

  it("fails closed when a Fiber branch has conflicting conversations", () => {
    const reply = scanFiber([fiberSection(CONVERSATION_A, [submitGoalRequest({ correlation_key: UUID_REQUEST_ID })], {
      conversationId: CONVERSATION_B,
    })]);
    expect(reply.evidence).toEqual([]);
    // The key was recognized but withheld: a conflicting conversation is fail closed.
    expect(reply.scan_diagnostic).toMatchObject({
      current_key_found: true,
      correlation_key: UUID_REQUEST_ID,
      conversation_conflict: true,
      conversation_id_found: false,
    });
  });

  it("drops a correlation key that appears under two different Fiber conversations", async () => {
    const harness = loadContent(CONVERSATION_A, CONVERSATION_A, `/c/${CONVERSATION_A}`, UUID_REQUEST_ID, [
      { request_id: UUID_REQUEST_ID, fiber_conversation_id: CONVERSATION_B },
    ]);
    await settleContent();
    expect(harness.messages.filter((message) => message.type === "identity_evidence")).toEqual([]);
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
  requestId = UUID_REQUEST_ID,
  extraEvidence: Record<string, unknown>[] = [],
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
        conversation_id: fiberConversation,
        evidence: [{ request_id: requestId, fiber_conversation_id: fiberConversation }, ...extraEvidence],
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
  it("publishes Project identity evidence with the submit_goal correlation key", async () => {
    const harness = loadContent(
      CONVERSATION_A,
      CONVERSATION_A,
      `/g/g-p-6a951d05cc448191a399974588cdcf2b/c/${CONVERSATION_A}`,
      UUID_REQUEST_ID_B,
    );
    await settleContent();

    expect(harness.messages.filter((message) => message.type === "identity_evidence")).toEqual([{
      type: "identity_evidence",
      identity_source: "fiber",
      request_id: UUID_REQUEST_ID_B,
      conversation_id: CONVERSATION_A,
      navigation_epoch: 0,
    }]);
  });

  it("accepts canonical Fiber identity on conversation and unassigned chat routes only", async () => {
    for (const path of [
      `/c/${CONVERSATION_A}`,
      `/g/g-p-xxxxxxxx/c/${CONVERSATION_A}`,
      `/g/g-xxxxxxxx/c/${CONVERSATION_A}`,
      "/",
      "/g/project/",
    ]) {
      const harness = loadContent(CONVERSATION_A, CONVERSATION_A, path);
      await settleContent();
      expect(harness.messages.filter((message) => message.type === "identity_evidence"), path)
        .toHaveLength(1);
    }

    for (const path of [
      "/c/",
      `/share/c/${CONVERSATION_A}`,
      `/foo/c/${CONVERSATION_A}`,
      "/auth/login",
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
  readonly writes: Record<string, unknown>[] = [];
  failNextWrites = 0;

  public constructor(initial: Record<string, unknown> = {}) {
    this.data = structuredClone(initial);
  }

  public async get(keys: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(keys.filter((key) => key in this.data).map((key) => [key, structuredClone(this.data[key])]));
  }

  public async set(values: Record<string, unknown>): Promise<void> {
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new Error("storage unavailable");
    }
    this.writes.push(structuredClone(values));
    Object.assign(this.data, structuredClone(values));
  }
}

class DeliveryWriteGateStorage extends Storage {
  private deliveryWriteGate: Promise<void> | null = null;
  private releaseDeliveryWriteGate: (() => void) | null = null;
  private deliveryWriteStarted: (() => void) | null = null;

  public armDeliveryWriteGate(): Promise<void> {
    const started = new Promise<void>((resolve) => { this.deliveryWriteStarted = resolve; });
    this.deliveryWriteGate = new Promise<void>((resolve) => { this.releaseDeliveryWriteGate = resolve; });
    return started;
  }

  public releaseDeliveryWrite(): void {
    this.releaseDeliveryWriteGate?.();
  }

  public override async set(values: Record<string, unknown>): Promise<void> {
    const gate = this.deliveryWriteGate;
    if (gate !== null && Object.prototype.hasOwnProperty.call(values, "deliveryInFlight")) {
      this.deliveryWriteGate = null;
      this.deliveryWriteStarted?.();
      await gate;
    }
    await super.set(values);
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
  enableAlarms = false,
): { calls: FetchCall[]; send: (
  message: Record<string, unknown>,
  documentId: string,
  tabId?: number,
  url?: string,
) => Promise<Record<string, unknown>>; alarm: () => void } {
  let listener: ((message: Record<string, unknown>, sender: Record<string, unknown>, sendResponse: (value: Record<string, unknown>) => void) => boolean) | null = null;
  const calls: FetchCall[] = [];
  let alarmListener: ((alarm: { name: string }) => void) | undefined;
  const chrome = {
    storage: { local: storage },
    runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    ...(enableAlarms ? { alarms: {
      create: vi.fn(async () => undefined),
      onAlarm: { addListener: (fn: typeof alarmListener) => { alarmListener = fn; } },
    } } : {}),
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
    crypto: webcrypto,
    TextEncoder,
  }, { filename: "background.js" });
  if (!listener) throw new Error("background listener was not registered");
  return {
    calls,
    alarm: () => alarmListener?.({ name: "identity-evidence-retry" }),
    send: (message, documentId, tabId = 7, url) => new Promise((resolve, reject) => {
      try {
        const keep = listener!(message, { tab: { id: tabId }, documentId, frameId: 0, url }, resolve);
        if (keep !== true) reject(new Error("background listener did not keep response channel open"));
      } catch (error) {
        reject(error);
      }
    }),
  };
}

const bridgeHello = { service: "local-review-control-bridge", protocol: 3, paired: true };
const evidenceMessage = (conversationId: string, navigation_epoch: number, extra: Record<string, unknown> = {}) => ({
  type: "identity_evidence",
  request_id: UUID_REQUEST_ID,
  conversation_id: conversationId,
  navigation_epoch,
  ...extra,
});

async function waitForEvidence(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Evidence outbox did not flush");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("Extension durable identity evidence Outbox", () => {
  it("writes verified evidence before POST, then retries from an alarm after Fiber disappears", async () => {
    const storage = new Storage({ port: 12081, token: "paired-token" });
    let available = false;
    const worker = loadBackground(storage, async (url, init) => {
      if (url.pathname === "/hello") return response(200, bridgeHello);
      if (url.pathname === "/identity-evidence") {
        expect(storage.data.identityEvidenceOutbox).toEqual([expect.objectContaining(JSON.parse(String(init.body)))]);
        return available ? response(202, { accepted: true, durable: true }) : response(503, {});
      }
      return response(200, {});
    }, true);
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    await expect(worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1"))
      .resolves.toMatchObject({ ok: false, status: 503 });
    const saved = structuredClone(storage.data.identityEvidenceOutbox);
    // The source tab navigated away and produces no new Fiber messages.
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-new", 7, `${ORIGIN}/c/${CONVERSATION_B}`);
    available = true;
    worker.alarm();
    await waitForEvidence(() => (storage.data.identityEvidenceOutbox as unknown[]).length === 0);
    const posted = worker.calls.filter(call => new URL(call.input).pathname === "/identity-evidence");
    expect(posted).toHaveLength(2);
    expect(JSON.parse(String(posted[1]!.init.body))).toMatchObject({ document_id: "document-1", conversation_id: CONVERSATION_A });
    expect((saved as unknown[])).toHaveLength(1);
  });

  it("restores the Outbox on worker startup and resends lost ACKs without another content message", async () => {
    const storage = new Storage({ port: 12081, token: "paired-token" });
    const accepted = new Set<string>();
    const first = loadBackground(storage, async (url, init) => {
      if (url.pathname === "/hello") return response(200, bridgeHello);
      if (url.pathname === "/pair") return response(200, { token: "paired-token" });
      accepted.add(JSON.parse(String(init.body)).request_id);
      throw new Error("ACK response lost after durable acceptance");
    });
    await first.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    await first.send(evidenceMessage(CONVERSATION_A, 0), "document-1");
    const saved = structuredClone(storage.data.identityEvidenceOutbox);
    const restored = loadBackground(storage, async (url, init) => {
      if (url.pathname === "/hello") return response(200, bridgeHello);
      if (url.pathname === "/pair") return response(200, { token: "paired-token" });
      const { received_at, expires_at, ...expected } = (saved as Record<string, unknown>[])[0]!;
      expect(JSON.parse(String(init.body))).toEqual(expected);
      accepted.add(JSON.parse(String(init.body)).request_id);
      return response(202, { accepted: true, durable: true });
    }, true);
    // No register_document, no identity_evidence, no Fiber rescan after restart.
    await waitForEvidence(() => (storage.data.identityEvidenceOutbox as unknown[]).length === 0);
    expect(restored.calls.filter(call => new URL(call.input).pathname === "/identity-evidence")).toHaveLength(1);
    expect(accepted.size).toBe(1);
  });

  it.each([response(202, { accepted: true }), response(200, { accepted: true, durable: true })])(
    "retains evidence until an explicit durable 202 ACK", async invalidAck => {
      const storage = new Storage({ port: 12081, token: "paired-token" });
      let durable = false;
      const worker = loadBackground(storage, async url => url.pathname === "/hello" ? response(200, bridgeHello)
        : durable ? response(202, { accepted: true, durable: true }) : invalidAck);
      await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
      await expect(worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1"))
        .resolves.toMatchObject({ ok: false, error: "identity_evidence_ack_not_durable" });
      expect(storage.data.identityEvidenceOutbox).toHaveLength(1);
      durable = true;
      await expect(worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1")).resolves.toMatchObject({ ok: true });
      expect(storage.data.identityEvidenceOutbox).toEqual([]);
    });

  it("never POSTs if Outbox storage fails", async () => {
    class FailingEvidenceStorage extends Storage {
      public override async set(values: Record<string, unknown>): Promise<void> {
        if ("identityEvidenceOutbox" in values) throw new Error("disk unavailable");
        await super.set(values);
      }
    }
    const worker = loadBackground(new FailingEvidenceStorage(), async () => response(200, bridgeHello));
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1")).toMatchObject({ ok: false });
    expect(worker.calls.some(call => new URL(call.input).pathname === "/identity-evidence")).toBe(false);
  });

  it("rejects conflicting queued conversations without replacing proof", async () => {
    const storage = new Storage({ port: 12081, token: "paired-token" });
    const worker = loadBackground(storage, async url => url.pathname === "/hello" ? response(200, bridgeHello) : response(503, {}));
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1");
    const saved = structuredClone(storage.data.identityEvidenceOutbox);
    await expect(worker.send(evidenceMessage(CONVERSATION_B, 1), "document-1"))
      .resolves.toMatchObject({ ok: false, error: "identity_evidence_conflict" });
    expect(storage.data.identityEvidenceOutbox).toEqual(saved);
  });

  it("expires stale Outbox evidence on startup without POST or a Fiber scan", async () => {
    const now = Date.now();
    const storage = new Storage({ identityEvidenceOutbox: [{ request_id: UUID_REQUEST_ID,
      conversation_id: CONVERSATION_A, document_id: "document-1", navigation_epoch: 0,
      received_at: now - 5 * 60 * 1000 - 1, expires_at: now - 1 }] });
    const worker = loadBackground(storage, async () => { throw new Error("must not send expired evidence"); }, true);
    await waitForEvidence(() => (storage.data.identityEvidenceOutbox as unknown[]).length === 0);
    expect(worker.calls).toEqual([]);
  });

  it("keeps a conflicting key queued without blocking an unrelated key", async () => {
    const now = Date.now();
    const storedEvidence = { conversation_id: CONVERSATION_A, document_id: "document-1",
      navigation_epoch: 0, received_at: now, expires_at: now + 5 * 60 * 1000 };
    const storage = new Storage({ port: 12081, token: "paired-token", identityEvidenceOutbox: [
      { ...storedEvidence, request_id: "request-conflict" }, { ...storedEvidence, request_id: "request-valid" },
    ] });
    loadBackground(storage, async (url, init) => url.pathname === "/hello" ? response(200, bridgeHello)
      : JSON.parse(String(init.body)).request_id === "request-conflict" ? response(409, {})
        : response(202, { accepted: true, durable: true }), true);
    await waitForEvidence(() => (storage.data.identityEvidenceOutbox as unknown[]).length === 1);
    expect(storage.data.identityEvidenceOutbox).toEqual([{ ...storedEvidence, request_id: "request-conflict" }]);
  });

  it.each([null, [{ request_id: "malformed" }]])("does not overwrite a corrupt Outbox", async malformed => {
    const storage = new Storage({ identityEvidenceOutbox: malformed });
    const worker = loadBackground(storage, async () => { throw new Error("must not send"); });
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1")).toMatchObject({ ok: false });
    expect(storage.data.identityEvidenceOutbox).toEqual(malformed);
    expect(worker.calls).toEqual([]);
  });

  it("rejects new evidence when full instead of evicting queued proof", async () => {
    const now = Date.now();
    const entries = Array.from({ length: 1000 }, (_, i) => ({ request_id: `request-${i}`,
      conversation_id: CONVERSATION_A, document_id: "document-1", navigation_epoch: 0,
      received_at: now, expires_at: now + 5 * 60 * 1000 }));
    const storage = new Storage({ identityEvidenceOutbox: entries });
    const worker = loadBackground(storage, async () => { throw new Error("must not send"); });
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    await expect(worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1"))
      .resolves.toMatchObject({ ok: false, error: "identity_evidence_outbox_full" });
    expect(storage.data.identityEvidenceOutbox).toEqual(entries);
    expect(worker.calls).toEqual([]);
  });
});

describe("Extension background identity authority", () => {
  it("retains diagnostics without credentials and flushes after normal delivery pairing", async () => {
    const storage = new Storage({ port: null, token: null });
    const url = `${ORIGIN}/c/${CONVERSATION_A}`;
    const sample = { type: 'identity_diagnostic', stage: 'scan_started', scan_id: 1, navigation_epoch: 0 };
    const worker = loadBackground(storage, async (endpoint) => {
      if (endpoint.pathname === '/hello') return response(200, { ...bridgeHello, paired: false });
      if (endpoint.pathname === '/pair') return response(200, { token: 'paired-token' });
      if (endpoint.pathname === '/delivery/claim') return response(200, { command: null });
      if (endpoint.pathname === '/identity-diagnostic') return response(202, { accepted: true, durable: true });
      throw new Error(`unexpected request: ${endpoint.pathname}`);
    });
    expect(await worker.send(sample, 'document-1', 7, url)).toMatchObject({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(storage.data.identityDiagnosticOutbox).toHaveLength(1);
    expect(worker.calls).toEqual([]);
    await worker.send({ type: 'register_document', navigation_epoch: 0 }, 'document-1', 7, url);
    expect(await worker.send({ type: 'delivery_claim', conversation_id: CONVERSATION_A, navigation_epoch: 0 },
      'document-1', 7, url)).toMatchObject({ ok: true });
    expect(storage.data.token).toBe('paired-token');
    await worker.send({ ...sample, scan_id: 2 }, 'document-1', 7, url);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(storage.data.identityDiagnosticOutbox).toEqual([]);
    expect(worker.calls.filter(call => new URL(call.input).pathname === '/identity-diagnostic')).toHaveLength(2);
    expect(worker.calls.some(call => new URL(call.input).pathname === '/identity-evidence')).toBe(false);
  });

  it("persists hash-only diagnostics across a worker restart and keeps telemetry out of identity authority", async () => {
    const storage = new Storage({ port: 12081, token: 'paired-token' });
    const url = `${ORIGIN}/c/${CONVERSATION_A}`;
    const sample = { type: 'identity_diagnostic', stage: 'fiber_scanned', scan_id: 7, navigation_epoch: 0,
      correlation_key: UUID_REQUEST_ID, fiber_root_detected: true, fiber_evidence_count: 0,
      prompt: 'SECRET-PROMPT', token: 'SECRET-TOKEN', document_id: 'spoofed-document' };
    const first = loadBackground(storage, async () => response(503, {}));
    expect(await first.send(sample, 'document-1', 7, url)).toMatchObject({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 40));
    const queued = storage.data.identityDiagnosticOutbox as Record<string, unknown>[];
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ scan_id: 7,
      correlation_key_hash: createHash('sha256').update(UUID_REQUEST_ID).digest('hex'),
      document_id_hash: createHash('sha256').update('document-1').digest('hex') });
    expect(JSON.stringify(queued)).not.toMatch(/SECRET|spoofed|32ca0d45|document-1/);
    expect(first.calls.every(call => new URL(call.input).pathname === '/identity-diagnostic')).toBe(true);
    const restarted = loadBackground(storage, async (_url, init) => {
      expect((storage.data.identityDiagnosticOutbox as unknown[]).length).toBeGreaterThan(0);
      expect(JSON.parse(String(init.body))).toHaveProperty('document_id_hash');
      return response(202, { accepted: true, durable: true });
    });
    await restarted.send({ ...sample, scan_id: 8 }, 'document-1', 7, url);
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(storage.data.identityDiagnosticOutbox).toEqual([]);
    expect(restarted.calls).toHaveLength(2);
    expect(storage.data.tabDocuments).toBeUndefined();
    expect(await restarted.send(sample, 'document-1', 7, 'https://evil.example/c/a')).toMatchObject({ ok: false });
  });

  it("observes a valid-sender evidence rejection before Bridge without claiming document authority", async () => {
    const storage = new Storage({ port: 12081, token: 'paired-token' });
    const worker = loadBackground(storage, async () => response(503, {}));
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), 'document-1', 7, `${ORIGIN}/c/${CONVERSATION_A}`))
      .toMatchObject({ ok: false, error: 'document_unregistered' });
    await new Promise(resolve => setTimeout(resolve, 60));
    const entries = storage.data.identityDiagnosticOutbox as Record<string, unknown>[];
    expect(entries.map(entry => entry.stage)).toEqual(expect.arrayContaining(['background_received', 'document_authorized']));
    expect(entries.find(entry => entry.stage === 'document_authorized')).toMatchObject({ flags: { document_authorized: false } });
    expect(worker.calls.some(call => new URL(call.input).pathname === '/identity-evidence')).toBe(false);
  });
  it("discovers only the fixed Bridge ports, pairs, and stores the token", async () => {
    const storage = new Storage();
    const calls: string[] = [];
    const worker = loadBackground(storage, async (url) => {
      calls.push(`${url.port}${url.pathname}`);
      if (url.pathname === "/hello" && url.port === "12083") return response(200, bridgeHello);
      if (url.pathname === "/pair" && url.port === "12083") return response(200, { token: "paired-token" });
      if (url.pathname === "/identity-evidence") return response(202, { accepted: true, durable: true });
      return response(503, {});
    });

    expect(await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1")).toMatchObject({ ok: true });
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1")).toMatchObject({ ok: true });
    expect(calls.slice(0, 3)).toEqual(["12081/hello", "12082/hello", "12083/hello"]);
    expect(storage.data.token).toBe("paired-token");
    expect(new URL(worker.calls.at(-1)!.input).pathname).toBe("/identity-evidence");
    expect(JSON.parse(String(worker.calls.at(-1)!.init.body))).toMatchObject({ request_id: UUID_REQUEST_ID });
    expect((worker.calls.at(-1)!.init.headers as Record<string, string>)["x-lrm-evidence-transport-event"])
      .toBe("extension_evidence_created");
    const hellos = worker.calls.filter((call) => new URL(call.input).pathname === "/hello").length;
    await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1");
    expect(worker.calls.filter((call) => new URL(call.input).pathname === "/hello")).toHaveLength(hellos);
  });

  it("uses sender.documentId and rejects stale epochs/documents across A to B to A", async () => {
    const storage = new Storage();
    const worker = loadBackground(storage, async (url) => {
      if (url.pathname === "/hello") return response(200, bridgeHello);
      if (url.pathname === "/pair") return response(200, { token: "paired-token" });
      return response(202, { accepted: true, durable: true });
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

  it("re-pairs before delivery when hello invalidates a cached token", async () => {
    const storage = new Storage({ port: 12081, token: "stale-token" });
    let paired = false;
    const worker = loadBackground(storage, async (url) => {
      if (url.pathname === "/hello") return response(200, { ...bridgeHello, paired });
      if (url.pathname === "/pair") {
        paired = true;
        return response(200, { token: "fresh-token" });
      }
      return response(202, { accepted: true, durable: true });
    });

    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1")).toMatchObject({ ok: true });

    expect(worker.calls.map((call) => `${String(call.init.method ?? "GET")} ${new URL(call.input).pathname}`)).toEqual([
      "GET /hello",
      "POST /pair",
      "POST /identity-evidence",
    ]);
    expect((worker.calls[2]!.init.headers as Record<string, string>).authorization).toBe("Bearer fresh-token");
    expect(storage.data).toMatchObject({ port: 12081, token: "fresh-token" });
    expect(storage.writes.filter((write) => "token" in write)).toEqual([
      { port: 12081, token: null },
      { port: 12081, token: "fresh-token" },
    ]);

    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1")).toMatchObject({ ok: true });
    expect(storage.writes.filter((write) => "token" in write)).toHaveLength(2);
  });

  it("drops the cached token when discovery loses the Bridge and re-pairs after restart", async () => {
    const storage = new Storage({ port: 12081, token: "stale-token" });
    let available = false;
    const responder = async (url: URL) => {
      if (!available) throw new Error("bridge unavailable");
      if (url.pathname === "/hello") return response(200, { ...bridgeHello, paired: false });
      if (url.pathname === "/pair") return response(200, { token: "fresh-token" });
      return response(202, { accepted: true, durable: true });
    };
    const first = loadBackground(storage, responder);

    await first.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    expect(await first.send(evidenceMessage(CONVERSATION_A, 0), "document-1"))
      .toMatchObject({ ok: false, error: "bridge_unavailable" });
    expect(storage.data).toMatchObject({ port: null, token: null });

    available = true;
    const afterWorkerRestart = loadBackground(storage, responder);
    await afterWorkerRestart.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    expect(await afterWorkerRestart.send(evidenceMessage(CONVERSATION_A, 0), "document-1"))
      .toMatchObject({ ok: true });
    expect(afterWorkerRestart.calls.map((call) => `${String(call.init.method ?? "GET")} ${new URL(call.input).pathname}`))
      .toEqual(["GET /hello", "POST /pair", "POST /identity-evidence"]);
    expect(storage.data).toMatchObject({ port: 12081, token: "fresh-token" });
  });

  it("normalizes a portless cached token when the service worker reloads", async () => {
    const storage = new Storage({ port: null, token: "stale-token" });
    const worker = loadBackground(storage, async (url) => {
      if (url.pathname === "/hello") return response(200, { ...bridgeHello, paired: false });
      if (url.pathname === "/pair") return response(200, { token: "fresh-token" });
      return response(202, { accepted: true, durable: true });
    });

    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    expect(storage.data).toMatchObject({ port: null, token: null });
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1"))
      .toMatchObject({ ok: true });
    expect(storage.data).toMatchObject({ port: 12081, token: "fresh-token" });
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
      return evidenceAttempts === 1 ? response(401, { error: "unauthorized" }) : response(202, { accepted: true, durable: true });
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

  it("fails closed on 403 while hello reports another pairing", async () => {
    const storage = new Storage({ port: 12081, token: "stale-token" });
    const worker = loadBackground(storage, async (url) => {
      if (url.pathname === "/hello") return response(200, bridgeHello);
      if (url.pathname === "/pair") throw new Error("must not pair");
      return response(403, { error: "forbidden_origin" });
    });

    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1"))
      .toMatchObject({ ok: false, error: "bridge_http_403" });
    expect(worker.calls.map((call) => new URL(call.input).pathname)).toEqual(["/hello", "/identity-evidence"]);
    expect(storage.data.token).toBe("stale-token");
  });

  it("bounds unpaired recovery when the retried delivery returns 403", async () => {
    const storage = new Storage({ port: 12081, token: "stale-token" });
    const worker = loadBackground(storage, async (url) => {
      if (url.pathname === "/hello") return response(200, { ...bridgeHello, paired: false });
      if (url.pathname === "/pair") return response(200, { token: "fresh-token" });
      return response(403, { error: "forbidden_origin" });
    });

    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    expect(await worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1"))
      .toMatchObject({ ok: false, error: "bridge_http_403" });
    expect(worker.calls.map((call) => new URL(call.input).pathname)).toEqual([
      "/hello",
      "/pair",
      "/identity-evidence",
    ]);
  });

  it("shares one recovery pairing across concurrent evidence", async () => {
    const storage = new Storage({ port: 12081, token: "stale-token" });
    let pairStarted!: () => void;
    let releasePair!: () => void;
    const started = new Promise<void>((resolve) => { pairStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releasePair = resolve; });
    let pairAttempts = 0;
    const worker = loadBackground(storage, async (url) => {
      if (url.pathname === "/hello") return response(200, { ...bridgeHello, paired: false });
      if (url.pathname === "/pair") {
        pairAttempts += 1;
        pairStarted();
        await gate;
        return response(200, { token: "fresh-token" });
      }
      return response(202, { accepted: true, durable: true });
    });

    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-1");
    const deliveries = Promise.all([
      worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1"),
      worker.send(evidenceMessage(CONVERSATION_A, 0), "document-1"),
    ]);
    await started;
    releasePair();

    expect(await deliveries).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    expect(pairAttempts).toBe(1);
    expect(worker.calls.filter((call) => new URL(call.input).pathname === "/identity-evidence"))
      .toHaveLength(1);
  });

  it("serializes same-conversation claims so only one tab owns the delivery", async () => {
    const storage = new Storage();
    let claimCount = 0;
    let releaseClaim!: () => void;
    let claimStarted!: () => void;
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const started = new Promise<void>((resolve) => { claimStarted = resolve; });
    const command = {
      delivery_id: "62ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_A,
      message: "one owner",
      deadline: Date.now() + 30_000,
    };
    const worker = loadBackground(storage, async (url) => {
      if (url.pathname === "/hello") return response(200, bridgeHello);
      if (url.pathname === "/pair") return response(200, { token: "paired-token" });
      if (url.pathname === "/delivery/claim") {
        claimCount += 1;
        if (claimCount === 1) {
          claimStarted();
          await claimGate;
        }
        return response(200, { command });
      }
      return response(404, {});
    });
    const url = `${ORIGIN}/c/${CONVERSATION_A}`;
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-two", 8, url);

    const first = worker.send({ type: "delivery_claim", conversation_id: CONVERSATION_A, navigation_epoch: 0 }, "document-one", 7, url);
    await claimStarted;
    const second = worker.send({ type: "delivery_claim", conversation_id: CONVERSATION_A, navigation_epoch: 0 }, "document-two", 8, url);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(claimCount).toBe(1);
    releaseClaim();

    await expect(first).resolves.toMatchObject({ ok: true, command });
    await expect(second).resolves.toEqual({ ok: true, command: null });
    expect(claimCount).toBe(1);
    expect(storage.data.deliveryInFlight).toMatchObject([{ delivery_id: command.delivery_id }]);
  });

  it("serializes concurrent claim, submit, and ACK state mutations without losing entries", async () => {
    const storage = new DeliveryWriteGateStorage({
      extensionClientId: "client-one",
      deliveryAckOutbox: [],
      deliveryInFlight: [
        {
          delivery_id: "72ca0d45-8b29-414a-bbe4-8e26c3aae911",
          conversation_id: CONVERSATION_A,
          client_id: "client-one",
          document_id: "document-one",
          navigation_epoch: 0,
          deadline: Date.now() + 30_000,
          phase: "claimed",
        },
        {
          delivery_id: "82ca0d45-8b29-414a-bbe4-8e26c3aae911",
          conversation_id: CONVERSATION_B,
          client_id: "client-one",
          document_id: "document-two",
          navigation_epoch: 0,
          deadline: Date.now() + 30_000,
          phase: "claimed",
        },
      ],
    });
    const commandA = {
      delivery_id: "72ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_A,
      message: "first concurrent command",
      deadline: Date.now() + 30_000,
    };
    const commandB = {
      delivery_id: "82ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_B,
      message: "second concurrent command",
      deadline: Date.now() + 30_000,
    };
    const worker = loadBackground(storage, async (url, init) => {
      if (url.pathname === "/hello") return response(200, bridgeHello);
      if (url.pathname === "/pair") return response(200, { token: "paired-token" });
      if (url.pathname === "/delivery/claim") {
        const body = JSON.parse(String(init.body)) as { conversation_id: string };
        return response(200, { command: body.conversation_id === CONVERSATION_A ? commandA : commandB });
      }
      if (url.pathname === "/delivery/ack") return response(200, { accepted: "new" });
      return response(404, {});
    });
    const urlA = `${ORIGIN}/c/${CONVERSATION_A}`;
    const urlB = `${ORIGIN}/c/${CONVERSATION_B}`;
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, urlA);
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-two", 8, urlB);

    let started = storage.armDeliveryWriteGate();
    const submitA = worker.send({ type: "delivery_submit_started", delivery_id: commandA.delivery_id, navigation_epoch: 0 }, "document-one", 7, urlA);
    await started;
    const submitB = worker.send({ type: "delivery_submit_started", delivery_id: commandB.delivery_id, navigation_epoch: 0 }, "document-two", 8, urlB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    storage.releaseDeliveryWrite();
    await expect(Promise.all([submitA, submitB])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(storage.data.deliveryInFlight).toMatchObject([
      { delivery_id: commandA.delivery_id, phase: "submitting" },
      { delivery_id: commandB.delivery_id, phase: "submitting" },
    ]);

    started = storage.armDeliveryWriteGate();
    const ackA = worker.send({
      type: "delivery_ack",
      delivery_id: commandA.delivery_id,
      navigation_epoch: 0,
      status: "sent",
      message_id: "message-one",
    }, "document-one", 7, urlA);
    await started;
    const ackB = worker.send({
      type: "delivery_ack",
      delivery_id: commandB.delivery_id,
      navigation_epoch: 0,
      status: "sent",
      message_id: "message-two",
    }, "document-two", 8, urlB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    storage.releaseDeliveryWrite();
    await expect(Promise.all([ackA, ackB])).resolves.toEqual([
      { ok: true, queued: false },
      { ok: true, queued: false },
    ]);
    expect(storage.data.deliveryAckOutbox).toEqual([]);
    expect(storage.data.deliveryInFlight).toEqual([]);
  });

  it("fails closed on a malformed durable ACK outbox while identity still works", async () => {
    const malformed = {
      delivery_id: "92ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_A,
      client_id: "client-one",
      document_id: "document-one",
      navigation_epoch: 0,
      status: "sent",
      message_id: "message-one",
      unexpected: true,
    };
    const storage = new Storage({ deliveryAckOutbox: [malformed], deliveryInFlight: [] });
    let claimCalls = 0;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const worker = loadBackground(storage, async (url) => {
        if (url.pathname === "/hello") return response(200, bridgeHello);
        if (url.pathname === "/pair") return response(200, { token: "paired-token" });
        if (url.pathname === "/delivery/claim") {
          claimCalls += 1;
          return response(200, { command: null });
        }
        return response(202, { accepted: true, durable: true });
      });
      const url = `${ORIGIN}/c/${CONVERSATION_A}`;
      await expect(worker.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url))
        .resolves.toMatchObject({ ok: true });
      await expect(worker.send(evidenceMessage(CONVERSATION_A, 0), "document-one", 7, url))
        .resolves.toMatchObject({ ok: true });
      await expect(worker.send({ type: "delivery_claim", conversation_id: CONVERSATION_A, navigation_epoch: 0 }, "document-one", 7, url))
        .resolves.toEqual({ ok: false, error: "delivery_state_corrupt" });
      expect(claimCalls).toBe(0);
      expect(storage.data.deliveryAckOutbox).toEqual([malformed]);
      expect(storage.writes.some((write) => Object.prototype.hasOwnProperty.call(write, "deliveryAckOutbox"))).toBe(false);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it("fails closed on a malformed in-flight entry without automatic resend", async () => {
    const malformed = {
      delivery_id: "a2ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_A,
      client_id: "client-one",
      document_id: "document-one",
      navigation_epoch: 0,
      deadline: Date.now() - 1,
      phase: "submitting",
      unexpected: true,
    };
    const storage = new Storage({ deliveryAckOutbox: [], deliveryInFlight: [malformed] });
    const routes: string[] = [];
    const worker = loadBackground(storage, async (url) => {
      routes.push(url.pathname);
      if (url.pathname === "/hello") return response(200, bridgeHello);
      if (url.pathname === "/pair") return response(200, { token: "paired-token" });
      if (url.pathname === "/delivery/claim") return response(200, { command: null });
      return response(202, { accepted: true, durable: true });
    });
    const url = `${ORIGIN}/c/${CONVERSATION_A}`;
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
    await expect(worker.send({ type: "delivery_claim", conversation_id: CONVERSATION_A, navigation_epoch: 0 }, "document-one", 7, url))
      .resolves.toEqual({ ok: false, error: "delivery_state_corrupt" });
    expect(routes).not.toContain("/delivery/claim");
    expect(routes).not.toContain("/delivery/ack");
    expect(storage.data.deliveryInFlight).toEqual([malformed]);
    expect(storage.writes.some((write) => Object.prototype.hasOwnProperty.call(write, "deliveryInFlight"))).toBe(false);
  });

  it("keeps the Bridge out of content and Fiber and leaves no Core correlation hook", () => {
    expect(contentSource).not.toMatch(/identity-evidence.*fetch/isu);
    expect(fiberSource).not.toMatch(/inboundRequestId|ConversationRouting|authorization|cookie/iu);
    expect(backgroundSource).not.toMatch(/inboundRequestId|ConversationRouting|ReviewDelivery/iu);
  });

  it("rejects an old identity-only Bridge protocol", async () => {
    const worker = loadBackground(new Storage(), async (url) =>
      url.pathname === "/hello"
        ? response(200, { ...bridgeHello, protocol: 1 })
        : response(500, {}));
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-old");
    await expect(worker.send(evidenceMessage(CONVERSATION_A, 0), "document-old"))
      .resolves.toMatchObject({ ok: false, error: "bridge_unavailable" });
  });

  it("durably retries a lost sent ACK before claiming new work after worker restart", async () => {
    const storage = new Storage({ port: 12081, token: "paired-token" });
    const url = `${ORIGIN}/c/${CONVERSATION_A}`;
    const command = {
      delivery_id: "32ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_A,
      message: "send once",
      deadline: Date.now() + 30_000,
    };
    const first = loadBackground(storage, async (requestUrl) => {
      if (requestUrl.pathname === "/hello") return response(200, bridgeHello);
      if (requestUrl.pathname === "/delivery/claim") return response(200, { command });
      if (requestUrl.pathname === "/delivery/ack") return response(503, { error: "lost" });
      return response(404, {});
    });
    await first.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
    const claimed = await first.send({
      type: "delivery_claim",
      conversation_id: CONVERSATION_A,
      navigation_epoch: 0,
    }, "document-one", 7, url);
    expect(claimed).toMatchObject({ ok: true, command });
    expect(JSON.stringify(storage.data.deliveryInFlight)).not.toContain(command.message);
    await first.send({
      type: "delivery_submit_started",
      delivery_id: command.delivery_id,
      navigation_epoch: 0,
    }, "document-one", 7, url);
    await expect(first.send({
      type: "delivery_ack",
      delivery_id: command.delivery_id,
      navigation_epoch: 0,
      status: "sent",
      message_id: "message-one",
    }, "document-one", 7, url)).resolves.toMatchObject({ ok: false });
    expect(storage.data.deliveryAckOutbox).toMatchObject([{
      delivery_id: command.delivery_id,
      status: "sent",
      message_id: "message-one",
    }]);
    expect(storage.data.deliveryInFlight).toEqual([]);

    const routes: string[] = [];
    const restarted = loadBackground(storage, async (requestUrl) => {
      routes.push(requestUrl.pathname);
      if (requestUrl.pathname === "/hello") return response(200, bridgeHello);
      if (requestUrl.pathname === "/delivery/ack") return response(200, { accepted: "existing" });
      if (requestUrl.pathname === "/delivery/claim") return response(200, { command: null });
      return response(404, {});
    });
    await restarted.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
    await restarted.send({
      type: "delivery_claim",
      conversation_id: CONVERSATION_A,
      navigation_epoch: 0,
    }, "document-one", 7, url);
    expect(routes.indexOf("/delivery/ack")).toBeLessThan(routes.indexOf("/delivery/claim"));
    expect(routes.filter((route) => route === "/delivery/claim")).toHaveLength(1);
    expect(storage.data.deliveryAckOutbox).toEqual([]);
  });

  it("turns an expired submit-without-receipt into ambiguous before any new claim", async () => {
    const storage = new Storage({ port: 12081, token: "paired-token" });
    const url = `${ORIGIN}/c/${CONVERSATION_A}`;
    const command = {
      delivery_id: "42ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_A,
      message: "maybe sent",
      deadline: Date.now() + 20,
    };
    const first = loadBackground(storage, async (requestUrl) => {
      if (requestUrl.pathname === "/hello") return response(200, bridgeHello);
      if (requestUrl.pathname === "/delivery/claim") return response(200, { command });
      return response(404, {});
    });
    await first.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
    await first.send({ type: "delivery_claim", conversation_id: CONVERSATION_A, navigation_epoch: 0 }, "document-one", 7, url);
    await first.send({ type: "delivery_submit_started", delivery_id: command.delivery_id, navigation_epoch: 0 }, "document-one", 7, url);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const posted: Record<string, unknown>[] = [];
    const restarted = loadBackground(storage, async (requestUrl, init) => {
      if (requestUrl.pathname === "/hello") return response(200, bridgeHello);
      if (requestUrl.pathname === "/delivery/ack") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response(200, { accepted: "new" });
      }
      if (requestUrl.pathname === "/delivery/claim") return response(200, { command: null });
      return response(404, {});
    });
    await restarted.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
    await restarted.send({ type: "delivery_claim", conversation_id: CONVERSATION_A, navigation_epoch: 0 }, "document-one", 7, url);
    expect(posted).toMatchObject([{
      delivery_id: command.delivery_id,
      conversation_id: CONVERSATION_A,
      status: "ambiguous",
    }]);
  });

  it("never posts an ACK before its outbox write succeeds", async () => {
    const storage = new Storage({ port: 12081, token: "paired-token" });
    const url = `${ORIGIN}/c/${CONVERSATION_A}`;
    const command = {
      delivery_id: "52ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_A,
      message: "durable first",
      deadline: Date.now() + 30_000,
    };
    let ackPosts = 0;
    const worker = loadBackground(storage, async (requestUrl) => {
      if (requestUrl.pathname === "/hello") return response(200, bridgeHello);
      if (requestUrl.pathname === "/delivery/claim") return response(200, { command });
      if (requestUrl.pathname === "/delivery/ack") {
        ackPosts += 1;
        return response(200, { accepted: "new" });
      }
      return response(404, {});
    });
    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
    await worker.send({ type: "delivery_claim", conversation_id: CONVERSATION_A, navigation_epoch: 0 }, "document-one", 7, url);
    await worker.send({ type: "delivery_submit_started", delivery_id: command.delivery_id, navigation_epoch: 0 }, "document-one", 7, url);
    storage.failNextWrites = 1;

    await expect(worker.send({
      type: "delivery_ack",
      delivery_id: command.delivery_id,
      navigation_epoch: 0,
      status: "sent",
      message_id: "message-one",
    }, "document-one", 7, url)).resolves.toMatchObject({ ok: false, error: "internal_error" });
    expect(ackPosts).toBe(0);
    expect(storage.data.deliveryAckOutbox).toEqual([]);
    expect(storage.data.deliveryInFlight).toMatchObject([{ phase: "submitting" }]);
  });
});

describe("Extension background review completion transport", () => {
  it("claims exact registered conversation ownership and fences an old navigation epoch", async () => {
    const storage = new Storage();
    const url = `${ORIGIN}/c/${CONVERSATION_A}`;
    const watch = {
      completion_id: "32ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_A,
      review_request_id: "review-completion-a",
      expected_user_message_id: "user-message-a",
      deadline: Date.now() + 30_000,
    };
    const claimBodies: Record<string, unknown>[] = [];
    const worker = loadBackground(storage, async (requestUrl, init) => {
      if (requestUrl.pathname === "/hello") return response(200, bridgeHello);
      if (requestUrl.pathname === "/pair") return response(200, { token: "paired-token" });
      if (requestUrl.pathname === "/completion/claim") {
        claimBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return response(200, watch);
      }
      return response(404, {});
    });

    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
    await expect(worker.send({
      type: "completion_claim",
      conversation_id: CONVERSATION_A,
      navigation_epoch: 0,
    }, "document-one", 7, url)).resolves.toMatchObject({ ok: true, ...watch });
    expect(claimBodies).toMatchObject([{
      conversation_id: CONVERSATION_A,
      document_id: "document-one",
      navigation_epoch: 0,
    }]);
    expect(claimBodies[0]?.client_id).toBe(storage.data.extensionClientId);
    expect(storage.data.completionInFlight).toMatchObject([{
      completion_id: watch.completion_id,
      review_request_id: watch.review_request_id,
      expected_user_message_id: watch.expected_user_message_id,
      phase: "claimed",
    }]);

    await worker.send({ type: "navigation", navigation_epoch: 1 }, "document-one", 7, url);
    await expect(worker.send({
      type: "completion_ack",
      completion_id: watch.completion_id,
      navigation_epoch: 0,
      status: "completed",
      assistant_message_id: "assistant:logical-a",
      content: "final text",
    }, "document-one", 7, url)).resolves.toMatchObject({ ok: false, error: "wrong_conversation" });
    await expect(worker.send({
      type: "completion_claim",
      conversation_id: CONVERSATION_A,
      navigation_epoch: 0,
    }, "document-two", 8, url)).resolves.toMatchObject({ ok: false, error: "wrong_conversation" });
  });

  it("writes completion ACK custody before POST and removes it only after server success", async () => {
    const storage = new Storage();
    const url = `${ORIGIN}/c/${CONVERSATION_A}`;
    const watch = {
      completion_id: "42ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_A,
      review_request_id: "review-completion-b",
      expected_user_message_id: "user-message-b",
      deadline: Date.now() + 30_000,
    };
    let outboxVisibleAtPost = false;
    const worker = loadBackground(storage, async (requestUrl) => {
      if (requestUrl.pathname === "/hello") return response(200, bridgeHello);
      if (requestUrl.pathname === "/pair") return response(200, { token: "paired-token" });
      if (requestUrl.pathname === "/completion/claim") return response(200, watch);
      if (requestUrl.pathname === "/completion/ack") {
        outboxVisibleAtPost = Array.isArray(storage.data.completionAckOutbox)
          && storage.data.completionAckOutbox.length === 1;
        return response(200, { accepted: "new" });
      }
      return response(404, {});
    });

    await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
    await worker.send({ type: "completion_claim", conversation_id: CONVERSATION_A, navigation_epoch: 0 }, "document-one", 7, url);
    await expect(worker.send({
      type: "completion_ack",
      completion_id: watch.completion_id,
      navigation_epoch: 0,
      status: "completed",
      assistant_message_id: "assistant:logical-b",
      content: "final text",
    }, "document-one", 7, url)).resolves.toMatchObject({ ok: true, queued: false });
    expect(outboxVisibleAtPost).toBe(true);
    expect(storage.data.completionAckOutbox).toEqual([]);
    expect(storage.data.completionInFlight).toEqual([]);
    const posted = worker.calls.find((call) => new URL(call.input).pathname === "/completion/ack");
    expect(JSON.parse(String(posted?.init.body))).toMatchObject({
      completion_id: watch.completion_id,
      assistant_message_id: "assistant:logical-b",
      content: "final text",
    });
  });

  it("restores a completion ACK outbox and flushes it before a new claim", async () => {
    const storage = new Storage({ port: 12081, token: "paired-token" });
    const url = `${ORIGIN}/c/${CONVERSATION_A}`;
    const watch = {
      completion_id: "52ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_A,
      review_request_id: "review-completion-c",
      expected_user_message_id: "user-message-c",
      deadline: Date.now() + 30_000,
    };
    const first = loadBackground(storage, async (requestUrl) => {
      if (requestUrl.pathname === "/hello") return response(200, bridgeHello);
      if (requestUrl.pathname === "/completion/claim") return response(200, watch);
      if (requestUrl.pathname === "/completion/ack") return response(503, { error: "temporary" });
      return response(404, {});
    });
    await first.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
    await first.send({ type: "completion_claim", conversation_id: CONVERSATION_A, navigation_epoch: 0 }, "document-one", 7, url);
    await expect(first.send({
      type: "completion_ack",
      completion_id: watch.completion_id,
      navigation_epoch: 0,
      status: "failed",
      error: "observation unavailable",
    }, "document-one", 7, url)).resolves.toMatchObject({ ok: false, status: 503 });
    expect(storage.data.completionAckOutbox).toMatchObject([{
      completion_id: watch.completion_id,
      status: "failed",
      error: "observation unavailable",
    }]);
    expect(storage.data.completionInFlight).toEqual([]);

    const routes: string[] = [];
    const restarted = loadBackground(storage, async (requestUrl) => {
      routes.push(requestUrl.pathname);
      if (requestUrl.pathname === "/hello") return response(200, bridgeHello);
      if (requestUrl.pathname === "/completion/ack") return response(200, { accepted: "existing" });
      if (requestUrl.pathname === "/completion/claim") return response(200, { command: null });
      return response(404, {});
    });
    await restarted.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
    await expect(restarted.send({
      type: "completion_claim",
      conversation_id: CONVERSATION_A,
      navigation_epoch: 0,
    }, "document-one", 7, url)).resolves.toEqual({ ok: true, command: null });
    expect(routes.indexOf("/completion/ack")).toBeLessThan(routes.indexOf("/completion/claim"));
    expect(storage.data.completionAckOutbox).toEqual([]);
  });

  it("blocks corrupt completion state without blocking the existing delivery path", async () => {
    const malformed = {
      completion_id: "62ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: CONVERSATION_A,
      client_id: "client-one",
      document_id: "document-one",
      navigation_epoch: 0,
      status: "completed",
      assistant_message_id: "assistant:logical-d",
      content: "final",
      unexpected: true,
    };
    const storage = new Storage({ completionAckOutbox: [malformed], deliveryAckOutbox: [], deliveryInFlight: [] });
    const routes: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const worker = loadBackground(storage, async (requestUrl) => {
        routes.push(requestUrl.pathname);
        if (requestUrl.pathname === "/hello") return response(200, bridgeHello);
        if (requestUrl.pathname === "/pair") return response(200, { token: "paired-token" });
        if (requestUrl.pathname === "/delivery/claim") return response(200, { command: null });
        throw new Error("unexpected route");
      });
      const url = `${ORIGIN}/c/${CONVERSATION_A}`;
      await worker.send({ type: "register_document", navigation_epoch: 0 }, "document-one", 7, url);
      await expect(worker.send({
        type: "completion_claim",
        conversation_id: CONVERSATION_A,
        navigation_epoch: 0,
      }, "document-one", 7, url)).resolves.toEqual({ ok: false, error: "completion_state_corrupt" });
      await expect(worker.send({
        type: "delivery_claim",
        conversation_id: CONVERSATION_A,
        navigation_epoch: 0,
      }, "document-one", 7, url)).resolves.toEqual({ ok: true, command: null });
      expect(routes).toContain("/delivery/claim");
      expect(routes).not.toContain("/completion/claim");
      expect(storage.data.completionAckOutbox).toEqual([malformed]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});
