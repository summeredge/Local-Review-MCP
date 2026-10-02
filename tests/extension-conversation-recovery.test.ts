import { webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bridgePort, conversationDeliveryReadiness, startBridge, stopBridge } from "../src/control-plane/bridge.js";
import { DispatchCommandBroker } from "../src/control-plane/dispatch-command-broker.js";
import { ExtensionDeliveryService } from "../src/control-plane/extension-delivery.js";
import { ExtensionDeliveryAdapter } from "../src/delivery/extension-delivery-adapter.js";
import type { ReviewDeliveryRequest } from "../src/delivery/review-delivery-adapter.js";

const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const conversation = "conversation-target";
const owner = { conversation_id: conversation, client_id: "client-one", document_id: "document-one", navigation_epoch: 0 };
let backgroundSource: string;
let contentSource: string;
let fiberSource: string;
const roots: string[] = [];
beforeAll(async () => {
  [backgroundSource, contentSource, fiberSource] = await Promise.all([
    readFile("extension/background.js", "utf8"), readFile("extension/content.js", "utf8"),
    readFile("extension/fiber.js", "utf8"),
  ]);
});
afterEach(async () => {
  await stopBridge();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup(timeoutMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), "lrm-conversation-recovery-"));
  roots.push(root);
  const deliveries = new ExtensionDeliveryService(root);
  const connect = async (service: ExtensionDeliveryService) => {
    // Avoid Fetch-forbidden random ephemeral ports; these are separate from production ports.
    await startBridge({ ports: [18081, 18082, 18083, 18084, 18085],
      claimExtensionDelivery: claim => service.claim(claim),
      ackExtensionDelivery: ack => service.acknowledge(ack),
      conversationRecoveryTargets: () => service.recoveryTargets(),
      reportConversationRecoveryFailure: failure => service.reportRecoveryFailure(failure),
    });
    const response = await bridgeFetch(`http://127.0.0.1:${bridgePort()}/pair`, {
      method: "POST", body: "{}", headers: { "x-lrm-bridge-protocol": "3" },
    });
    return (await response.json() as { token: string }).token;
  };
  const token = await connect(deliveries);
  const request: ReviewDeliveryRequest = { delivery_id: "delivery-recovery", workspace_id: "workspace-a",
    task_id: "task-a", review_request_id: "review-a", routing_id: "routing-a", conversation_id: conversation,
    message: "review the change exactly once" };
  const adapter = (service = deliveries, dispatchTimeoutMs = timeoutMs) => new ExtensionDeliveryAdapter(new DispatchCommandBroker(service, {
    timeoutMs: dispatchTimeoutMs, readiness: conversationDeliveryReadiness,
  }));
  return { root, deliveries, token, request, adapter, connect };
}

function bridgeFetch(input: string, init: RequestInit = {}) {
  // Restart tests must not reuse a socket from the retired Bridge instance.
  return fetch(input, { ...init, headers: { ...init.headers, origin, connection: "close" } });
}

type Tab = { id: number; url: string; pendingUrl?: string; discarded?: boolean; status?: string };
function browser() {
  const tabs: Tab[] = [];
  const storage: Record<string, unknown> = { extensionClientId: owner.client_id };
  const pages = new Map<number, (message: unknown) => Promise<unknown>>();
  const reloaded = vi.fn(async (_id: number) => undefined);
  const created = vi.fn(async ({ url }: { url: string }) => {
    const tab = { id: tabs.length + 1, url };
    tabs.push(tab);
    return tab;
  });
  return { tabs, storage, created, pages, reloaded };
}

function background(state: ReturnType<typeof browser>) {
  let alarm: (value: { name: string }) => void;
  let onCompleted: (value: { tabId: number; url: string; statusCode: number }) => void;
  let onUpdated: (tabId: number, value: { url: string }) => void;
  let listener: (message: unknown, sender: unknown, respond: (value: Record<string, unknown>) => void) => void;
  let clock = Date.now();
  let requests = 0;
  const chrome = {
    storage: { local: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter(key => key in state.storage)
        .map(key => [key, structuredClone(state.storage[key])])),
      set: async (values: Record<string, unknown>) => { Object.assign(state.storage, structuredClone(values)); },
    } },
    tabs: { query: async () => state.tabs.map(tab => ({ ...tab })), create: state.created,
      reload: state.reloaded,
      sendMessage: async (id: number, message: unknown) => {
        const page = state.pages.get(id);
        if (!page) throw new Error("content document absent");
        return page(message);
      },
      onUpdated: { addListener: (fn: typeof onUpdated) => { onUpdated = fn; } } },
    webRequest: { onCompleted: { addListener: (fn: typeof onCompleted) => { onCompleted = fn; } } },
    runtime: { onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    alarms: { create: async () => undefined, onAlarm: { addListener: (fn: typeof alarm) => { alarm = fn; } } },
  };
  runInNewContext(backgroundSource, { chrome, URL, AbortController, crypto: webcrypto, console,
    setTimeout, clearTimeout, Date: { now: () => clock },
    fetch: (input: string, init: RequestInit) => {
      if (new URL(input).pathname === "/delivery/recovery-targets") requests++;
      // Keep the Extension's fixed-port contract while isolating this real HTTP Bridge.
      const url = new URL(input);
      url.port = String(bridgePort());
      return bridgeFetch(url.toString(), init);
    },
  });
  return {
    wake() { clock += 5001; alarm({ name: "delivery-conversation-recovery" }); },
    get requests() { return requests; },
    completed(tabId: number, statusCode: number) {
      onCompleted({ tabId, statusCode, url: `https://chatgpt.com/c/${conversation}` });
    },
    auth(tabId: number) { onUpdated(tabId, { url: "https://auth.openai.com/log-in" }); },
    send(message: Record<string, unknown>, tabId = 1, senderUrl = `https://chatgpt.com/c/${conversation}`) {
      return new Promise<Record<string, unknown>>(resolve => listener(message, {
        tab: { id: tabId, url: state.tabs.find(tab => tab.id === tabId)?.pendingUrl
          || state.tabs.find(tab => tab.id === tabId)?.url || senderUrl },
        frameId: 0, documentId: `document-${tabId}`, url: senderUrl,
      }, resolve));
    },
  };
}

function content(worker: ReturnType<typeof background>, options: {
  state?: ReturnType<typeof browser>; tabId?: number; href?: string; canonical?: string | null;
  senderUrl?: string; localId?: boolean;
} = {}) {
  const messages: Record<string, unknown>[] = [];
  const dom = {
    ready: () => true, insertPrompt: vi.fn(() => true), clearPromptExact: () => true,
    send: vi.fn(async () => ({ clicked: true, message_id: "message-recovered" })),
  };
  const tabId = options.tabId ?? 1;
  let canonical = options.canonical === undefined ? conversation : options.canonical;
  const listeners = new Set<(event: unknown) => void>();
  const window = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { if (type === "message") listeners.add(fn); },
    removeEventListener: (_type: string, fn: (event: unknown) => void) => { listeners.delete(fn); },
    postMessage: (data: unknown) => { for (const fn of [...listeners]) fn({ source: window, origin: "https://chatgpt.com", data }); },
  };
  const section = { getAttribute: () => null, __reactFiber$test: {
    get memoizedProps() {
      return { conversation: { id: options.localId ? "WEB:32ca0d45-8b29-414a-bbe4-8e26c3aae911" : canonical,
        serverId$: () => canonical }, turn: { messages: [] } };
    }, return: null,
  } };
  const intervals: Array<() => void> = [];
  const location = { origin: "https://chatgpt.com", href: options.href ?? `https://chatgpt.com/c/${conversation}` };
  const history = { pushState: (_state: unknown, _title: string, href: string) => {
    location.href = href;
    const tab = options.state?.tabs.find(candidate => candidate.id === tabId);
    if (tab) tab.url = href;
  } };
  const context = { chrome: { runtime: {
    onMessage: { addListener: (fn: (message: unknown, sender: unknown, respond: (reply: unknown) => void) => void) => {
      options.state?.pages.set(tabId, message => new Promise(resolve => fn(message, {}, resolve)));
    } },
    sendMessage: (message: Record<string, unknown>, callback: (reply: unknown) => void) => {
      messages.push(message);
      void worker.send(message, tabId, options.senderUrl).then(callback);
    },
  } }, LRM_DOM: dom, URL, Math, console: { debug: () => undefined }, setTimeout, clearTimeout,
    setInterval: (fn: () => void) => { intervals.push(fn); return 0; },
    document: { documentElement: {}, querySelectorAll: () => canonical ? [section] : [] }, MutationObserver: undefined,
    location, history, window,
  };
  runInNewContext(fiberSource, context);
  runInNewContext(contentSource, context);
  return { dom, messages, tick: () => intervals.forEach(fn => fn()),
    navigate: (value: string) => { canonical = value; history.pushState({}, "", `https://chatgpt.com/c/${value}`); },
    identity: (value: string | null) => { canonical = value; } };
}

describe("conversation recovery through the production Extension transport", () => {
  it("recovers the original conversation after its live document navigates elsewhere during execution", async () => {
    const f = await setup(3000);
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    state.tabs.push({ id: 1, url: `https://chatgpt.com/c/${conversation}` });
    const worker = background(state);
    const original = content(worker, { state });
    await vi.waitFor(() => expect(conversationDeliveryReadiness(conversation).ready).toBe(true));
    original.navigate("conversation-other");
    original.tick();
    await vi.waitFor(() => expect(conversationDeliveryReadiness("conversation-other").ready).toBe(true));
    expect(conversationDeliveryReadiness(conversation).ready).toBe(false);
    const pending = f.adapter().deliver(f.request);
    await vi.waitFor(async () => expect(await f.deliveries.recoveryTargets()).toHaveLength(1));
    worker.wake();
    await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
    const recovered = content(worker, { state, tabId: state.tabs[1]!.id });
    await expect(pending).resolves.toMatchObject({ status: "delivered" });
    expect(original.dom.send).not.toHaveBeenCalled();
    expect(recovered.dom.send).toHaveBeenCalledOnce();
    recovered.tick(); original.tick(); worker.wake();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(recovered.dom.send).toHaveBeenCalledOnce();
  });

  it.each([false, true])("delivers with Fiber canonical identity and a stale/absent URL id: %s", async absent => {
    const f = await setup(3000);
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    const href = absent ? "https://chatgpt.com/" : `https://chatgpt.com/c/${conversation}`;
    state.tabs.push({ id: 1, url: href });
    const worker = background(state);
    const page = content(worker, { state, href, senderUrl: "https://chatgpt.com/", localId: true });
    await vi.waitFor(() => expect(conversationDeliveryReadiness(conversation).ready).toBe(true));
    const pending = f.adapter().deliver(f.request);
    await vi.waitFor(async () => expect(await f.deliveries.recoveryTargets()).toHaveLength(1));
    worker.wake();
    // Probe finds the canonical model even when no /c route exists, then claims the queue.
    await expect(pending).resolves.toMatchObject({ status: "delivered" });
    expect(state.created).not.toHaveBeenCalled();
    expect(page.dom.send).toHaveBeenCalledOnce();
    expect(page.messages).toContainEqual(expect.objectContaining({ type: "delivery_claim",
      identity_source: "fiber", conversation_id: conversation }));
    page.tick(); page.tick(); worker.wake();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(page.dom.send).toHaveBeenCalledOnce();
  });

  it.each([null, "conversation-other"])("refuses an empty or wrong current model: %s", async canonical => {
    const f = await setup();
    const command = await f.deliveries.enqueue(conversation, f.request.message!, f.request.delivery_id);
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    state.tabs.push({ id: 1, url: "https://chatgpt.com/" });
    const worker = background(state);
    const page = content(worker, { state, href: "https://chatgpt.com/", canonical, senderUrl: "https://chatgpt.com/" });
    await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
    expect(page.dom.send).not.toHaveBeenCalled();
    expect(conversationDeliveryReadiness(conversation).ready).toBe(false);
    expect((await f.deliveries.get(command.delivery_id))?.phase).toBe("queued");
    const recovered = content(worker, { state, tabId: state.tabs[1]!.id });
    await vi.waitFor(async () => expect((await f.deliveries.get(command.delivery_id))?.phase).toBe("delivered"));
    expect(recovered.dom.send).toHaveBeenCalledOnce();
  });

  it("reloads an existing URL without a live document once, then completes registration through ACK", async () => {
    const f = await setup(3000);
    const pending = f.adapter().deliver(f.request);
    await vi.waitFor(async () => expect(await f.deliveries.recoveryTargets()).toHaveLength(1));
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    state.tabs.push({ id: 1, url: `https://chatgpt.com/c/${conversation}`, status: "complete" });
    const worker = background(state);
    await vi.waitFor(() => expect(state.reloaded).toHaveBeenCalledOnce());
    worker.wake();
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(state.reloaded).toHaveBeenCalledOnce();
    const page = content(worker, { state });
    await expect(pending).resolves.toMatchObject({ status: "delivered" });
    expect(page.dom.send).toHaveBeenCalledOnce();
    expect(page.messages.map(message => message.type)).toEqual(expect.arrayContaining([
      "register_document", "delivery_claim", "delivery_submit_started", "delivery_ack",
    ]));
  });

  it("rechecks Fiber before clicking even if the URL has not changed", async () => {
    const f = await setup();
    const command = await f.deliveries.enqueue(conversation, f.request.message!, f.request.delivery_id);
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    state.tabs.push({ id: 1, url: `https://chatgpt.com/c/${conversation}` });
    const worker = background(state);
    const page = content(worker, { state });
    page.dom.insertPrompt.mockImplementation(() => { page.identity("conversation-other"); return true; });
    await vi.waitFor(() => expect(page.dom.insertPrompt).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(page.dom.send).not.toHaveBeenCalled();
    expect((await f.deliveries.get(command.delivery_id))?.receipt?.status).not.toBe("delivered");
  });

  it.each(["auth", "404"])("retains recovery failure ownership across MV3 restart before the next target query: %s", async failure => {
    const f = await setup();
    const command = await f.deliveries.enqueue(conversation, f.request.message!, f.request.delivery_id);
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    const first = background(state);
    await vi.waitFor(() => expect(state.storage.conversationRecoveryTabs).toBeDefined());
    await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(first.requests).toBeGreaterThan(0);
    const second = background(state);
    if (failure === "auth") second.auth(1);
    else second.completed(1, 404);
    await vi.waitFor(async () => expect((await f.deliveries.get(command.delivery_id))?.recovery_error)
      .toBe(failure === "auth" ? "TARGET_CONVERSATION_AUTH_REQUIRED" : "TARGET_CONVERSATION_NOT_FOUND"));
    expect(await f.deliveries.claim(owner)).toBeNull();
    expect(state.created).toHaveBeenCalledOnce();
  });

  it("blocks expired submitting recovery before it can resend or create another tab", async () => {
    const f = await setup();
    const command = await f.deliveries.enqueue(conversation, f.request.message!, f.request.delivery_id);
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    const first = background(state);
    await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
    await first.send({ type: "register_document", navigation_epoch: 0 });
    await first.send({ type: "delivery_claim", conversation_id: conversation, navigation_epoch: 0 });
    await first.send({ type: "delivery_submit_started", delivery_id: command.delivery_id, navigation_epoch: 0 });
    const entries = state.storage.deliveryInFlight as Array<Record<string, unknown>>;
    entries[0]!.deadline = Date.now() - 1;
    const file = join(f.root, "control-plane", "extension-deliveries.json");
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    snapshot.deliveries[0].lease.deadline = Date.now() - 1;
    await writeFile(file, JSON.stringify(snapshot));
    await stopBridge();
    const restored = new ExtensionDeliveryService(f.root);
    const token = await f.connect(restored);
    Object.assign(state.storage, { port: bridgePort(), token });
    background(state);
    await vi.waitFor(async () => expect((await restored.get(command.delivery_id))?.phase).toBe("ambiguous"));
    expect(await restored.recoveryTargets()).toEqual([]);
    expect(state.created).toHaveBeenCalledOnce();
    expect(await restored.claim(owner)).toBeNull();
  });

  it("recovers an expired unsubmitted lease after browser/Runtime restart", async () => {
    const f = await setup(3000);
    const command = await f.deliveries.enqueue(conversation, f.request.message!, f.request.delivery_id);
    const claim = await f.deliveries.claim(owner);
    expect(claim).not.toBeNull();
    // Simulate downtime past the lease deadline in the durable backend state.
    const file = join(f.root, "control-plane", "extension-deliveries.json");
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    snapshot.deliveries[0].lease.deadline = Date.now() - 1;
    await writeFile(file, JSON.stringify(snapshot));
    await stopBridge();
    const restored = new ExtensionDeliveryService(f.root);
    const token = await f.connect(restored);
    expect(await restored.recoveryTargets()).toEqual([{ delivery_id: command.delivery_id, conversation_id: conversation }]);
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token });
    const worker = background(state);
    await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
    const pending = f.adapter(restored).deliver(f.request);
    const page = content(worker, { state });
    await expect(pending).resolves.toMatchObject({ status: "delivered" });
    expect(page.dom.send).toHaveBeenCalledOnce();
    expect((await restored.get(command.delivery_id))?.phase).toBe("delivered");
  });

  it("keeps an online target in its existing tab and claims only from that conversation", async () => {
    const f = await setup();
    await bridgeFetch(`http://127.0.0.1:${bridgePort()}/delivery/claim`, {
      method: "POST", body: JSON.stringify(owner), headers: {
        "x-lrm-bridge-protocol": "3", authorization: `Bearer ${f.token}`,
      },
    });
    expect(conversationDeliveryReadiness(conversation).ready).toBe(true);
    const pending = f.adapter().deliver(f.request);
    await vi.waitFor(async () => expect(await f.deliveries.recoveryTargets()).toHaveLength(1));
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    state.tabs.push({ id: 1, url: `https://chatgpt.com/c/${conversation}` });
    const worker = background(state);
    await vi.waitFor(() => expect(worker.requests).toBeGreaterThan(0));
    const page = content(worker);
    await expect(pending).resolves.toMatchObject({ status: "delivered" });
    expect(state.created).not.toHaveBeenCalled();
    expect(page.dom.send).toHaveBeenCalledOnce();
    expect(conversationDeliveryReadiness("conversation-other").ready).toBe(false);
  });

  it.each([false, true])("recovers a closed target while another ChatGPT tab exists: %s", async otherTab => {
    const f = await setup(otherTab ? 1000 : 5000);
    const pending = f.adapter().deliver(f.request);
    await vi.waitFor(async () => expect(await f.deliveries.recoveryTargets()).toHaveLength(1));
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    if (otherTab) state.tabs.push({ id: 7, url: "https://chatgpt.com/c/conversation-other" });
    const worker = background(state);
    await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
    // Navigation succeeded; the target content document registers later.
    expect(conversationDeliveryReadiness(conversation)).toMatchObject({ ready: false,
      extension_present: true, readiness_state: "target_conversation_not_present" });
    await new Promise(resolve => setTimeout(resolve, otherTab ? 30 : 2100));
    const page = content(worker);
    await expect(pending).resolves.toMatchObject({ status: "delivered" });
    expect(page.dom.send).toHaveBeenCalledOnce();
    expect(state.created).toHaveBeenCalledWith({ url: `https://chatgpt.com/c/${conversation}` });
    expect(page.messages).toContainEqual(expect.objectContaining({ type: "delivery_ack", status: "sent" }));
  });

  it("deduplicates concurrent recovery and reuses a pending tab across worker and Runtime restarts", async () => {
    const f = await setup();
    await f.deliveries.enqueue(conversation, f.request.message!, f.request.delivery_id);
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    const first = background(state);
    first.wake(); first.wake();
    await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 10));
    await stopBridge();
    const restored = new ExtensionDeliveryService(f.root);
    const token = await f.connect(restored);
    Object.assign(state.storage, { port: bridgePort(), token });
    const tab = state.tabs[0]!;
    tab.pendingUrl = tab.url;
    tab.url = "about:blank";
    const second = background(state);
    await vi.waitFor(() => expect(second.requests).toBeGreaterThan(0));
    const pending = f.adapter(restored).deliver(f.request);
    const page = content(second);
    await expect(pending).resolves.toMatchObject({ status: "delivered" });
    expect(page.dom.send).toHaveBeenCalledOnce();
    expect(state.created).toHaveBeenCalledOnce();
    // The receipt remains authoritative even with no live page after another restart.
    await stopBridge();
    const again = new ExtensionDeliveryService(f.root);
    await expect(f.adapter(again).deliver(f.request)).resolves.toMatchObject({ status: "delivered" });
    expect(await again.recoveryTargets()).toEqual([]);
  });

  it.each([404, 401, 403])("maps HTTP %s to a terminal navigation error without claim or submit", async status => {
    const f = await setup(1000);
    const pending = f.adapter().deliver(f.request);
    await vi.waitFor(async () => expect(await f.deliveries.recoveryTargets()).toHaveLength(1));
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    const worker = background(state);
    await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
    worker.completed(1, status);
    await expect(pending).resolves.toMatchObject({ status: "failed", retryable: false,
      error: { code: status === 404 ? "TARGET_CONVERSATION_NOT_FOUND" : "TARGET_CONVERSATION_AUTH_REQUIRED" } });
    expect(await f.deliveries.claim(owner)).toBeNull();
    expect(await f.deliveries.recoveryTargets()).toEqual([]);
  });

  it("maps an explicit auth redirect to human intervention", async () => {
    const f = await setup(1000);
    const pending = f.adapter().deliver(f.request);
    await vi.waitFor(async () => expect(await f.deliveries.recoveryTargets()).toHaveLength(1));
    const state = browser();
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    const worker = background(state);
    await vi.waitFor(() => expect(state.created).toHaveBeenCalledOnce());
    worker.auth(1);
    await expect(pending).resolves.toMatchObject({ retryable: false,
      error: { code: "TARGET_CONVERSATION_AUTH_REQUIRED" } });
  });

  it("bounds Extension registration and allows a later manual reopen to resume", async () => {
    const f = await setup(100);
    await expect(f.adapter().deliver(f.request)).resolves.toMatchObject({ status: "failed", retryable: true,
      error: { code: "TARGET_CONVERSATION_EXTENSION_NOT_READY" } });
    expect(await f.deliveries.recoveryTargets()).toEqual([]);
    const retry = f.adapter(f.deliveries, 3000).deliver(f.request);
    await vi.waitFor(async () => expect(await f.deliveries.recoveryTargets()).toHaveLength(1));
    const state = browser();
    state.tabs.push({ id: 1, url: `https://chatgpt.com/c/${conversation}` });
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    const worker = background(state);
    content(worker);
    await expect(retry).resolves.toMatchObject({ status: "delivered" });
    expect(state.created).not.toHaveBeenCalled();
  });

  it("reports a tab creation failure as retryable and retires only the unclaimed command", async () => {
    const f = await setup(1000);
    const pending = f.adapter().deliver(f.request);
    await vi.waitFor(async () => expect(await f.deliveries.recoveryTargets()).toHaveLength(1));
    const state = browser();
    state.created.mockRejectedValue(new Error("browser navigation unavailable"));
    Object.assign(state.storage, { port: bridgePort(), token: f.token });
    background(state);
    await expect(pending).resolves.toMatchObject({ status: "failed", retryable: true,
      error: { code: "TARGET_CONVERSATION_NAVIGATION_FAILED" } });
    expect(await f.deliveries.recoveryTargets()).toEqual([]);
  });

  it("rejects unauthenticated discovery and mismatched recovery reports without changing the command", async () => {
    const f = await setup();
    const command = await f.deliveries.enqueue(conversation, f.request.message!, f.request.delivery_id);
    const url = `http://127.0.0.1:${bridgePort()}`;
    expect((await bridgeFetch(`${url}/delivery/recovery-targets`, {
      method: "POST", body: "{}", headers: { "x-lrm-bridge-protocol": "3" },
    })).status).toBe(401);
    const headers = { "x-lrm-bridge-protocol": "3", authorization: `Bearer ${f.token}` };
    expect((await bridgeFetch(`${url}/delivery/recovery-failure`, {
      method: "POST", headers, body: JSON.stringify({ delivery_id: command.delivery_id,
        conversation_id: "conversation-wrong", code: "TARGET_CONVERSATION_NOT_FOUND" }),
    })).status).toBe(409);
    expect((await bridgeFetch(`${url}/delivery/recovery-failure`, {
      method: "POST", headers, body: JSON.stringify({ delivery_id: command.delivery_id,
        conversation_id: conversation, code: "TARGET_CONVERSATION_NOT_FOUND", message: "untrusted" }),
    })).status).toBe(400);
    expect((await f.deliveries.get(command.delivery_id))?.recovery_error).toBeUndefined();
    expect(await f.deliveries.recoveryTargets()).toEqual([{ delivery_id: command.delivery_id, conversation_id: conversation }]);
  });
});
