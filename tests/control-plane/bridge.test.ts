import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppContext, startApp } from "../../src/app.js";
import type { ResolvedSettings } from "../../src/config/settings.js";
import {
  bridgePort,
  bridgeStatus,
  startBridge,
  stopBridge,
} from "../../src/control-plane/bridge.js";
import { ConversationCorrelationRegistry } from "../../src/control-plane/conversation-correlation.js";
import { CodexExecutionCompletionService } from "../../src/control-plane/codex-execution-completion.js";
import { ExtensionDeliveryService } from "../../src/control-plane/extension-delivery.js";
import {
  ExtensionReviewCompletionService,
  extensionReviewCompletionStateFile,
} from "../../src/control-plane/extension-review-completion.js";
import {
  LOCAL_CONTROL_BRIDGE_HOST,
  LOCAL_CONTROL_BRIDGE_PORTS,
  LOCAL_CONTROL_BRIDGE_PROTOCOL,
  LOCAL_CONTROL_BRIDGE_SERVICE,
  MAX_BRIDGE_REQUEST_BYTES,
  MAX_BRIDGE_COMPLETION_ACK_REQUEST_BYTES,
} from "../../src/control-plane/bridge-protocol.js";

const ORIGIN_A = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const ORIGIN_B = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface RequestOptions {
  readonly method?: string;
  readonly origin?: string | null;
  readonly protocol?: string | null;
  readonly token?: string | null;
  readonly body?: string | unknown;
}

async function request(path: string, options: RequestOptions = {}): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const port = bridgePort();
  if (port === null) throw new Error("bridge is not listening");
  const headers: Record<string, string> = {};
  const origin = options.origin === undefined ? ORIGIN_A : options.origin;
  if (origin !== null) headers.origin = origin;
  const protocol = options.protocol === undefined
    ? String(LOCAL_CONTROL_BRIDGE_PROTOCOL)
    : options.protocol;
  if (protocol !== null) headers["x-lrm-bridge-protocol"] = protocol;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`http://${LOCAL_CONTROL_BRIDGE_HOST}:${port}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? null : JSON.parse(text),
  };
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOCAL_CONTROL_BRIDGE_HOST, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no address");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

beforeEach(async () => {
  await expect(startBridge({ ports: [0] })).resolves.toBeGreaterThan(0);
});

afterEach(async () => {
  await stopBridge();
});

describe("Local Control Bridge protocol", () => {
  it("uses its own loopback discovery range and serves safe discovery metadata", async () => {
    expect(LOCAL_CONTROL_BRIDGE_PORTS).toEqual([12081, 12082, 12083, 12084, 12085]);
    expect(LOCAL_CONTROL_BRIDGE_PORTS.some((port) => [8765, 8766, 8767, 8768, 8769].includes(port))).toBe(false);
    expect(bridgeStatus()).toMatchObject({ available: true, address: LOCAL_CONTROL_BRIDGE_HOST });

    const response = await request("/hello", { origin: null, protocol: null });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      service: LOCAL_CONTROL_BRIDGE_SERVICE,
      protocol: LOCAL_CONTROL_BRIDGE_PROTOCOL,
      version: "0.1",
      paired: false,
    });
    expect((await request("/hello", { origin: "https://chatgpt.com" })).status).toBe(403);
  });

  it("pairs once, returns a 256-bit token, and keeps the token stable", async () => {
    const first = await request("/pair", { method: "POST", body: {} });
    expect(first.status).toBe(200);
    const token = (first.body as { token: string }).token;
    expect(Buffer.from(token, "base64url")).toHaveLength(32);

    const second = await request("/pair", { method: "POST", body: {} });
    expect(second).toEqual({ status: 200, body: { token } });
    expect((await request("/hello")).body).toMatchObject({ paired: true });
  });

  it.each([
    "https://chatgpt.com",
    "http://localhost",
    "file:///tmp/extension",
    "null",
    "chrome-extension://not-an-extension",
    "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/path",
    "chrome-extension://user:pass@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:443",
    "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?query",
    "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#hash",
  ])("rejects invalid pairing Origin %s", async (origin) => {
    expect((await request("/pair", { method: "POST", origin, body: {} })).status).toBe(403);
    expect((await request("/hello")).body).toMatchObject({ paired: false });
  });

  it("rejects a missing pairing Origin", async () => {
    expect((await request("/pair", { method: "POST", origin: null, body: {} })).status).toBe(403);
  });

  it("rejects missing and incompatible protocol headers", async () => {
    expect((await request("/pair", { method: "POST", protocol: null, body: {} })).status).toBe(426);
    expect((await request("/pair", { method: "POST", protocol: "1", body: {} })).status).toBe(426);
    expect((await request("/pair", { method: "POST", protocol: "2", body: {} })).status).toBe(426);
    expect((await request("/pair", { method: "POST", body: {} })).status).toBe(200);
  });

  it("does not allow another extension Origin to take ownership", async () => {
    const token = ((await request("/pair", { method: "POST", body: {} })).body as { token: string }).token;
    expect((await request("/pair", { method: "POST", origin: ORIGIN_B, body: {} })).status).toBe(409);
    expect((await request("/status", { origin: ORIGIN_B, token })).status).toBe(403);
    expect((await request("/pair", { method: "POST", body: {} })).body).toEqual({ token });
  });

  it("requires protocol, paired Origin, and constant-time bearer authentication for status", async () => {
    const token = ((await request("/pair", { method: "POST", body: {} })).body as { token: string }).token;
    expect((await request("/status")).status).toBe(401);
    expect((await request("/status", { token: "wrong-token" })).status).toBe(401);
    expect((await request("/status", { origin: ORIGIN_B, token })).status).toBe(403);
    expect((await request("/status", { protocol: null, token })).status).toBe(426);
    expect((await request("/status", { token })).body).toEqual({
      status: "ok",
      protocol: LOCAL_CONTROL_BRIDGE_PROTOCOL,
      version: "0.1",
      port: bridgePort(),
    });
  });

  it("authenticates identity evidence and delivers the exact payload to the sink", async () => {
    await stopBridge();
    const sink = vi.fn();
    await expect(startBridge({ ports: [0], onIdentityEvidence: sink })).resolves.toBeGreaterThan(0);
    const token = ((await request("/pair", { method: "POST", body: {} })).body as { token: string }).token;
    const evidence = {
      request_id: "32ca0d45-8b29-414a-bbe4-8e26c3aae911",
      conversation_id: "11111111-2222-3333-4444-555555555555",
      document_id: "chrome-document-id",
      navigation_epoch: 2,
    };
    const wfrEvidence = { ...evidence, request_id: "wfr_01a014bdd7cd7a15b6b533d3ce2b42f2" };

    expect((await request("/identity-evidence", {
      method: "POST",
      protocol: null,
      token,
      body: evidence,
    })).status).toBe(426);
    expect((await request("/identity-evidence", {
      method: "POST",
      origin: ORIGIN_B,
      token,
      body: evidence,
    })).status).toBe(403);
    expect((await request("/identity-evidence", {
      method: "POST",
      token: "wrong-token",
      body: evidence,
    })).status).toBe(401);
    expect((await request("/identity-evidence", {
      method: "POST",
      token,
      body: { ...evidence, unexpected: true },
    })).status).toBe(400);
    expect(await request("/identity-evidence", { method: "POST", token, body: evidence })).toEqual({
      status: 202,
      body: { accepted: true },
    });
    expect(await request("/identity-evidence", { method: "POST", token, body: wfrEvidence })).toEqual({
      status: 202,
      body: { accepted: true },
    });
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenNthCalledWith(1, evidence);
    expect(sink).toHaveBeenNthCalledWith(2, wfrEvidence);
  });

  it("validates and transports exact delivery claims and idempotent ACKs", async () => {
    await stopBridge();
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-bridge-delivery-"));
    const deliveries = new ExtensionDeliveryService(root);
    await deliveries.restore();
    const queued = await deliveries.enqueue("conversation-one", "send exactly once");
    await startBridge({
      ports: [0],
      claimExtensionDelivery: (claim) => deliveries.claim(claim),
      ackExtensionDelivery: (ack) => deliveries.acknowledge(ack),
    });
    try {
      const token = ((await request("/pair", { method: "POST", body: {} })).body as { token: string }).token;
      const owner = {
        conversation_id: "conversation-one",
        client_id: "client-one",
        document_id: "document-one",
        navigation_epoch: 4,
      };
      expect((await request("/delivery/claim", { method: "POST", token, body: { ...owner, extra: true } })).status)
        .toBe(400);
      const claimed = await request("/delivery/claim", { method: "POST", token, body: owner });
      expect(claimed).toMatchObject({
        status: 200,
        body: { command: { delivery_id: queued.delivery_id, message: "send exactly once" } },
      });
      expect((await request("/delivery/claim", {
        method: "POST",
        token,
        body: { ...owner, document_id: "document-two" },
      })).body).toEqual({ command: null });

      const ack = {
        ...owner,
        delivery_id: queued.delivery_id,
        status: "sent",
        message_id: "message-one",
      };
      expect(await request("/delivery/ack", { method: "POST", token, body: ack })).toMatchObject({
        status: 200,
        body: { accepted: "new", receipt: { status: "delivered", message_id: "message-one" } },
      });
      expect(await request("/delivery/ack", { method: "POST", token, body: ack })).toMatchObject({
        status: 200,
        body: { accepted: "existing" },
      });
      expect((await request("/delivery/ack", {
        method: "POST",
        token,
        body: { ...ack, message_id: "message-two" },
      })).status).toBe(409);
      expect((await request("/delivery/claim", { method: "POST", token: "wrong", body: owner })).status).toBe(401);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates and transports exact completion claims and idempotent ACKs", async () => {
    await stopBridge();
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-bridge-completion-"));
    const completions = new ExtensionReviewCompletionService(root);
    await completions.restore();
    const queued = await completions.enqueue({
      workspace_id: "workspace-a",
      task_id: "task-a",
      review_request_id: "review-a",
      review_delivery_id: "delivery-a",
      conversation_id: "conversation-one",
      expected_user_message_id: "user-message-1",
    });
    await startBridge({
      ports: [0],
      claimExtensionReviewCompletion: (claim) => completions.claim(claim),
      ackExtensionReviewCompletion: (ack) => completions.acknowledge(ack),
    });
    try {
      const token = ((await request("/pair", { method: "POST", body: {} })).body as { token: string }).token;
      const owner = {
        conversation_id: "conversation-one",
        client_id: "client-one",
        document_id: "document-one",
        navigation_epoch: 4,
      };
      expect((await request("/completion/claim", {
        method: "POST",
        token,
        body: { ...owner, extra: true },
      })).status).toBe(400);
      expect((await request("/completion/claim", {
        method: "POST",
        token,
        body: { ...owner, conversation_id: "conversation-two" },
      })).body).toEqual({ command: null });
      const claimed = await request("/completion/claim", { method: "POST", token, body: owner });
      expect(claimed).toMatchObject({
        status: 200,
        body: {
          completion_id: queued.completion_id,
          conversation_id: "conversation-one",
          review_request_id: "review-a",
          expected_user_message_id: "user-message-1",
        },
      });

      const ack = {
        ...owner,
        completion_id: queued.completion_id,
        status: "completed",
        assistant_message_id: "assistant:logical-1",
        content: "final review",
      };
      expect(await request("/completion/ack", { method: "POST", token, body: ack })).toMatchObject({
        status: 200,
        body: { accepted: "new", receipt: { status: "completed", content: "final review" } },
      });
      expect(await request("/completion/ack", { method: "POST", token, body: ack })).toMatchObject({
        status: 200,
        body: { accepted: "existing" },
      });
      expect((await request("/completion/ack", {
        method: "POST",
        token,
        body: { ...ack, content: "different" },
      })).status).toBe(409);
      expect((await request("/completion/ack", {
        method: "POST",
        token,
        body: { ...ack, completion_id: randomUUID() },
      })).status).toBe(404);
    } finally {
      await stopBridge();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives completion ACKs a larger body limit without enlarging ordinary routes", async () => {
    await stopBridge();
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-bridge-completion-size-"));
    const completions = new ExtensionReviewCompletionService(root);
    const queued = await completions.enqueue({
      workspace_id: "workspace-a",
      task_id: "task-a",
      review_request_id: "review-size",
      review_delivery_id: "delivery-size",
      conversation_id: "conversation-size",
      expected_user_message_id: "user-size",
    });
    await startBridge({
      ports: [0],
      claimExtensionReviewCompletion: (claim) => completions.claim(claim),
      ackExtensionReviewCompletion: (ack) => completions.acknowledge(ack),
    });
    try {
      const token = ((await request("/pair", { method: "POST", body: {} })).body as { token: string }).token;
      const owner = {
        conversation_id: "conversation-size",
        client_id: "client-size",
        document_id: "document-size",
        navigation_epoch: 0,
      };
      await expect(request("/completion/claim", { method: "POST", token, body: owner })).resolves.toMatchObject({ status: 200 });
      const content = "x".repeat(256 * 1024);
      const ack = {
        ...owner,
        completion_id: queued.completion_id,
        status: "completed",
        assistant_message_id: "assistant-size",
        content,
      };
      expect(Buffer.byteLength(JSON.stringify(ack), "utf8")).toBeLessThanOrEqual(
        MAX_BRIDGE_COMPLETION_ACK_REQUEST_BYTES,
      );
      expect(await request("/completion/ack", { method: "POST", token, body: ack })).toMatchObject({ status: 200 });
      expect((await request("/identity-evidence", {
        method: "POST",
        token,
        body: { request_id: "request-size", conversation_id: "conversation-size", document_id: "document-size", navigation_epoch: 0, padding: "x".repeat(MAX_BRIDGE_REQUEST_BYTES) },
      })).status).toBe(413);
    } finally {
      await stopBridge();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds JSON bodies and returns stable route errors", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(MAX_BRIDGE_REQUEST_BYTES) });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_BRIDGE_REQUEST_BYTES);
    expect((await request("/pair", { method: "POST", body: oversized })).status).toBe(413);
    expect((await request("/pair", { method: "POST", body: "{bad" })).status).toBe(400);
    expect((await request("/pair", { method: "POST", body: {} })).status).toBe(200);
    expect((await request("/missing")).status).toBe(404);
    expect((await request("/hello", { method: "POST" })).status).toBe(405);
    expect((await request("/pair")).status).toBe(405);
    expect((await request("/status", { method: "POST" })).status).toBe(405);
  });

  it("releases the listening socket on stop", async () => {
    await stopBridge();
    const probe = createServer();
    const port = await listen(probe);
    await close(probe);

    await expect(startBridge({ ports: [port] })).resolves.toBe(port);
    await stopBridge();

    const rebound = createServer();
    await expect(listen(rebound, port)).resolves.toBe(port);
    await close(rebound);
  });

  it("reports unavailable without taking another port when every candidate is occupied", async () => {
    await stopBridge();
    const occupied = createServer();
    const port = await listen(occupied);
    await expect(startBridge({ ports: [port] })).resolves.toBeNull();
    expect(bridgeStatus()).toMatchObject({ available: false, port: null });
    await close(occupied);
  });

  it("uses the first available candidate in order", async () => {
    await stopBridge();
    const occupied = createServer();
    const first = await listen(occupied);
    const second = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      void listen(probe).then((port) => close(probe).then(() => resolve(port), reject), reject);
    });

    await expect(startBridge({ ports: [first, second] })).resolves.toBe(second);
    await close(occupied);
  });
});

describe("Local Control Bridge app lifecycle", () => {
  function settings(): ResolvedSettings {
    return {
      host: "127.0.0.1",
      port: 0,
      workspace: process.cwd(),
      auth: { token: "mcp-test-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    };
  }

  it("starts with MCP and stops when the MCP server closes", async () => {
    await stopBridge();
    const server = await startApp(settings(), undefined, { bridgePorts: [0] });
    expect(server.listening).toBe(true);
    expect(bridgeStatus().available).toBe(true);
    await close(server);
    await stopBridge();
    expect(bridgeStatus()).toMatchObject({ available: false, port: null, paired: false });
  });

  it("keeps MCP available when the Bridge candidates are unavailable", async () => {
    await stopBridge();
    const occupied = createServer();
    const port = await listen(occupied);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const server = await startApp(settings(), undefined, { bridgePorts: [port] });
      expect(server.listening).toBe(true);
      expect(bridgeStatus().available).toBe(false);
      expect(warning).toHaveBeenCalledWith("Local Control Bridge unavailable; local MCP remains available");
      await close(server);
    } finally {
      warning.mockRestore();
      await close(occupied);
    }
  });

  it("keeps MCP available when Codex completion recovery fails", async () => {
    await stopBridge();
    const completion = new CodexExecutionCompletionService();
    vi.spyOn(completion, "recoverRunningExecutions").mockRejectedValue(new Error("corrupt"));
    const runtime = createAppContext(settings());
    const context = { ...runtime, codexExecutionCompletion: completion };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let server: Server | null = null;
    try {
      server = await startApp(settings(), context, { bridgePorts: [0] });
      expect(server.listening).toBe(true);
      expect(warning).toHaveBeenCalledWith(
        "Codex execution completion recovery failed; local MCP remains available",
      );
    } finally {
      warning.mockRestore();
      if (server !== null) await close(server);
    }
  });

  it("keeps MCP available when Goal Orchestration recovery fails", async () => {
    await stopBridge();
    const runtime = createAppContext(settings());
    vi.spyOn(runtime.goalOrchestration!, "recover").mockRejectedValue(new Error("corrupt"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let server: Server | null = null;
    try {
      server = await startApp(settings(), runtime, { bridgePorts: [0] });
      expect(server.listening).toBe(true);
      expect(warning).toHaveBeenCalledWith(
        "Goal Orchestration recovery failed; local MCP remains available",
      );
    } finally {
      warning.mockRestore();
      if (server !== null) await close(server);
    }
  });

  it("routes accepted identity evidence into the production correlation registry", async () => {
    await stopBridge();
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-app-correlation-"));
    await mkdir(join(root, "control-plane"), { recursive: true });
    await writeFile(join(root, "control-plane", "request-correlations.json"), "{broken", "utf8");
    const runtime = createAppContext(settings());
    const context = {
      ...runtime,
      correlations: new ConversationCorrelationRegistry(root),
    };
    const observer = vi.fn();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let server: Server | null = null;
    try {
      server = await startApp(settings(), context, {
        bridgePorts: [0],
        onIdentityEvidence: observer,
      });
      const token = ((await request("/pair", { method: "POST", body: {} })).body as { token: string }).token;
      const evidence = {
        request_id: "wfr_app_integration",
        conversation_id: "conversation-app",
        document_id: "document-app",
        navigation_epoch: 3,
      };

      expect(await request("/identity-evidence", { method: "POST", token, body: evidence })).toEqual({
        status: 202,
        body: { accepted: true },
      });
      expect(context.correlations.correlation(evidence.request_id)?.conversation_id).toBe(
        evidence.conversation_id,
      );
      expect(observer).toHaveBeenCalledWith(evidence);
      expect(warning).toHaveBeenCalledWith(
        "Conversation correlation state could not be restored; starting without restored proof",
      );
    } finally {
      if (server !== null) await close(server);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Bridge identity available when extension delivery state is corrupt", async () => {
    await stopBridge();
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-app-delivery-corrupt-"));
    const deliveryFile = join(root, "control-plane", "extension-deliveries.json");
    await mkdir(join(root, "control-plane"), { recursive: true });
    await writeFile(deliveryFile, "{broken", "utf8");
    const runtime = createAppContext(settings());
    const context = {
      ...runtime,
      correlations: new ConversationCorrelationRegistry(root),
      extensionDeliveries: new ExtensionDeliveryService(root),
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let server: Server | null = null;
    try {
      server = await startApp(settings(), context, { bridgePorts: [0] });
      expect(server.listening).toBe(true);
      expect(bridgeStatus().available).toBe(true);

      expect(await request("/hello", { origin: null, protocol: null })).toMatchObject({ status: 200 });
      const token = ((await request("/pair", { method: "POST", body: {} })).body as { token: string }).token;
      const evidence = {
        request_id: "wfr_delivery_corrupt_app",
        conversation_id: "conversation-delivery-corrupt",
        document_id: "document-delivery-corrupt",
        navigation_epoch: 0,
      };
      expect(await request("/identity-evidence", { method: "POST", token, body: evidence })).toEqual({
        status: 202,
        body: { accepted: true },
      });
      expect(context.correlations.correlation(evidence.request_id)?.conversation_id).toBe(evidence.conversation_id);

      const owner = {
        conversation_id: evidence.conversation_id,
        client_id: "client-delivery-corrupt",
        document_id: evidence.document_id,
        navigation_epoch: evidence.navigation_epoch,
      };
      expect(await request("/delivery/claim", { method: "POST", token, body: owner })).toEqual({
        status: 503,
        body: { error: "delivery_unavailable" },
      });
      expect(await request("/delivery/ack", {
        method: "POST",
        token,
        body: {
          ...owner,
          delivery_id: "b2ca0d45-8b29-414a-bbe4-8e26c3aae911",
          status: "ambiguous",
          error: "delivery unavailable",
        },
      })).toEqual({
        status: 503,
        body: { error: "delivery_unavailable" },
      });
      expect(await readFile(deliveryFile, "utf8")).toBe("{broken");
      expect(warning).toHaveBeenCalledWith("Extension Delivery unavailable; durable state could not be restored");
    } finally {
      warning.mockRestore();
      if (server !== null) await close(server);
      await stopBridge();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps MCP and Delivery available when completion state is corrupt", async () => {
    await stopBridge();
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-app-completion-corrupt-"));
    await mkdir(join(root, "control-plane"), { recursive: true });
    const completionFile = extensionReviewCompletionStateFile(root);
    await writeFile(completionFile, "{broken", "utf8");
    const runtime = createAppContext(settings());
    const context = {
      ...runtime,
      extensionDeliveries: new ExtensionDeliveryService(root),
      extensionReviewCompletions: new ExtensionReviewCompletionService(root),
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let server: Server | null = null;
    try {
      server = await startApp(settings(), context, { bridgePorts: [0] });
      const token = ((await request("/pair", { method: "POST", body: {} })).body as { token: string }).token;
      const owner = {
        conversation_id: "conversation-completion-corrupt",
        client_id: "client-completion-corrupt",
        document_id: "document-completion-corrupt",
        navigation_epoch: 0,
      };
      expect(await request("/completion/claim", { method: "POST", token, body: owner })).toEqual({
        status: 503,
        body: { error: "completion_unavailable" },
      });
      expect(await request("/delivery/claim", { method: "POST", token, body: owner })).toMatchObject({
        status: 200,
        body: { command: null },
      });
      expect(warning).toHaveBeenCalledWith(
        "Extension Review Completion unavailable; durable state could not be restored",
      );
      expect(await readFile(completionFile, "utf8")).toBe("{broken");
    } finally {
      warning.mockRestore();
      if (server !== null) await close(server);
      await stopBridge();
      await rm(root, { recursive: true, force: true });
    }
  });
});
