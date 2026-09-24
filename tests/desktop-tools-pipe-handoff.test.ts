import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../src/mcp/http.js";
import { startApp } from "../src/app.js";
import type { ResolvedSettings } from "../src/config/settings.js";
import {
  DesktopToolsPipeHandoff,
  DesktopToolsPipeHandoffError,
  type DesktopToolsPipeHandoffLifecycleEvent,
  MAX_DESKTOP_TOOLS_PIPE_PATH_LENGTH,
  sendDesktopToolsPipeHandoff,
  validateDesktopToolsPipePath,
  LAUNCHER_DESKTOP_TOOLS_PIPE_PATH,
  LAUNCHER_DESKTOP_TOOLS_PIPE_PROBE_PATH,
} from "../src/desktop-codex/desktop-tools-pipe-handoff.js";
import {
  DesktopCodexRuntimeFactory,
  probeDesktopToolsPipe,
  REQUIRED_DESKTOP_TOOLS,
  type DesktopCodexRuntimeLike,
} from "../src/desktop-codex/desktop-tools-pipe-probe.js";
import type { CodexAppRuntimeMetadata } from "../src/desktop-codex/codex-app-runtime.js";
import type { DesktopSyncState } from "../src/desktop-sync/desktop-sync-state.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const PIPE = "\\\\.\\pipe\\codex-tools-test";
const OWNER = "desktop-instance-1";
const runningServers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function connectedState(owner = OWNER, conversation = "conversation-1"): DesktopSyncState {
  return {
    connected: true,
    currentConversationId: conversation,
    ownerClientId: owner,
    followingThreads: new Set(),
  };
}

function runtimeMetadata(): CodexAppRuntimeMetadata {
  return {
    desktopDetected: true,
    bundleDetected: true,
    mcpTransport: "stdio",
    nativeDesktopTransport: "windows_named_pipe",
    desktopVersion: "26.915.4065.0",
    codexAppToolsVersion: "0.1.4",
  };
}

function fakeRuntime(calls: string[], close: () => void = () => undefined): DesktopCodexRuntimeLike {
  return {
    info: runtimeMetadata(),
    async listTools() {
      calls.push("tools/list");
      return {
        tools: REQUIRED_DESKTOP_TOOLS.map((name) => ({
          name,
          description: "test",
          inputSchema: { type: "object" },
        })),
      };
    },
    async close() {
      close();
    },
  };
}

function settings(workspace: string): ResolvedSettings {
  return {
    host: "127.0.0.1",
    port: 0,
    workspace,
    auth: { token: "test-token" },
    remote: { enabled: false, endpoint: "" },
    supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return address.port;
}

describe("Desktop tools pipe handoff", () => {
  it.each([
    ["", "desktop_tools_pipe_invalid"],
    ["relative-pipe", "desktop_tools_pipe_invalid"],
    ["C:\\temp\\pipe", "desktop_tools_pipe_invalid"],
    ["\\\\server\\pipe\\remote", "desktop_tools_pipe_invalid"],
    [`${PIPE}\0`, "desktop_tools_pipe_invalid"],
    [`\\\\.\\pipe\\${"x".repeat(MAX_DESKTOP_TOOLS_PIPE_PATH_LENGTH)}`, "desktop_tools_pipe_invalid"],
  ] as const)("rejects unsafe pipe path %s", (value, code) => {
    expect(() => validateDesktopToolsPipePath(value)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("accepts only a local named pipe without normalizing it", () => {
    expect(validateDesktopToolsPipePath(PIPE)).toBe(PIPE);
  });

  it("keeps the capability in memory and binds it to the Desktop owner", () => {
    let now = "2026-09-20T01:00:00.000Z";
    const handoff = new DesktopToolsPipeHandoff(() => now);
    expect(handoff.pipePathFor(connectedState())).toBeUndefined();
    handoff.accept(PIPE, OWNER);
    expect(handoff.pipePathFor(connectedState())).toBe(PIPE);
    expect(handoff.pipePathFor({ ...connectedState(), connected: false })).toBeUndefined();
    expect(handoff.pipePathFor(connectedState("desktop-instance-2"))).toBeUndefined();
    expect(handoff.pipePathFor(connectedState(OWNER, "conversation-2"))).toBe(PIPE);
    now = "2026-09-20T02:00:00.000Z";
    expect(new DesktopToolsPipeHandoff().pipePathFor(connectedState())).toBeUndefined();
  });

  it("keeps a cold-start handoff pending until Desktop IPC supplies an owner", () => {
    let now = "2026-09-20T01:00:00.000Z";
    const lifecycle: DesktopToolsPipeHandoffLifecycleEvent[] = [];
    const handoff = new DesktopToolsPipeHandoff(() => now, (event) => lifecycle.push(event));
    const ownerlessState: DesktopSyncState = { connected: true, followingThreads: new Set() };

    handoff.observeDesktopState(ownerlessState);
    const pending = handoff.stagePending(PIPE);
    expect(pending).toMatchObject({
      pipePath: PIPE,
      receivedAt: now,
      provenance: "authenticated_loopback",
      expiresAt: "2026-09-20T01:00:45.000Z",
    });
    expect(handoff.pipePathFor(ownerlessState)).toBeUndefined();
    expect(handoff.stateFor(ownerlessState)).toBe("pending");
    expect(handoff.hasAcceptedCapability()).toBe(false);

    now = "2026-09-20T01:00:01.000Z";
    handoff.observeDesktopState(connectedState());
    expect(handoff.pipePathFor(connectedState())).toBe(PIPE);
    expect(handoff.stateFor(connectedState())).toBe("active");
    expect(handoff.hasAcceptedCapability()).toBe(true);
    expect(lifecycle).toEqual([
      {
        state: "pending_registered",
        timestamp: "2026-09-20T01:00:00.000Z",
        pendingRegisteredAt: "2026-09-20T01:00:00.000Z",
        expiresAt: "2026-09-20T01:00:45.000Z",
      },
      {
        state: "owner_bound",
        timestamp: "2026-09-20T01:00:01.000Z",
        pendingRegisteredAt: "2026-09-20T01:00:00.000Z",
        ownerBindingAt: "2026-09-20T01:00:01.000Z",
      },
      {
        state: "promoted",
        timestamp: "2026-09-20T01:00:01.000Z",
        pendingRegisteredAt: "2026-09-20T01:00:00.000Z",
        ownerBindingAt: "2026-09-20T01:00:01.000Z",
        promotionAt: "2026-09-20T01:00:01.000Z",
      },
    ]);
  });

  it("discards a pending handoff after its TTL or a Desktop disconnect", () => {
    let now = "2026-09-20T01:00:00.000Z";
    const handoff = new DesktopToolsPipeHandoff(() => now);
    const ownerlessState: DesktopSyncState = { connected: true, followingThreads: new Set() };

    handoff.observeDesktopState(ownerlessState);
    handoff.stagePending(PIPE);
    now = "2026-09-20T01:00:45.000Z";
    handoff.observeDesktopState(connectedState());
    expect(handoff.pipePathFor(connectedState())).toBeUndefined();
    expect(handoff.stateFor(connectedState())).toBe("unavailable");
    expect(handoff.hasAcceptedCapability()).toBe(false);

    handoff.stagePending(PIPE);
    handoff.observeDesktopState({ connected: false, followingThreads: new Set() });
    handoff.observeDesktopState(connectedState());
    expect(handoff.pipePathFor(connectedState())).toBeUndefined();
  });

  it("does not promote pending evidence across an observed owner change", () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.observeDesktopState(connectedState("desktop-instance-1"));
    handoff.stagePending(PIPE);
    handoff.observeDesktopState(connectedState("desktop-instance-2"));
    expect(handoff.pipePathFor(connectedState("desktop-instance-2"))).toBeUndefined();
    expect(handoff.hasAcceptedCapability()).toBe(false);
  });

  it("permanently invalidates a capability after disconnect and owner changes", () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.accept(PIPE, OWNER);
    handoff.observeDesktopState(connectedState());
    expect(handoff.pipePathFor(connectedState())).toBe(PIPE);

    handoff.observeDesktopState({ connected: false, followingThreads: new Set() });
    expect(handoff.pipePathFor(connectedState())).toBeUndefined();
    handoff.observeDesktopState(connectedState());
    expect(handoff.pipePathFor(connectedState())).toBeUndefined();

    handoff.accept(PIPE, OWNER);
    handoff.observeDesktopState(connectedState("desktop-instance-2"));
    expect(handoff.pipePathFor(connectedState("desktop-instance-2"))).toBeUndefined();
    const replacementPipe = "\\\\.\\pipe\\codex-tools-test-owner-b";
    handoff.accept(replacementPipe, "desktop-instance-2");
    expect(handoff.pipePathFor(connectedState("desktop-instance-2"))).toBe(replacementPipe);
    handoff.observeDesktopState(connectedState());
    expect(handoff.pipePathFor(connectedState())).toBeUndefined();
  });

  it("preserves a capability across same-owner conversation changes and accepts a new handoff", () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.accept(PIPE, OWNER);
    handoff.observeDesktopState(connectedState(OWNER, "conversation-1"));
    handoff.observeDesktopState(connectedState(OWNER, "conversation-2"));
    expect(handoff.pipePathFor(connectedState(OWNER, "conversation-2"))).toBe(PIPE);

    handoff.observeDesktopState({ connected: false, followingThreads: new Set() });
    const newPipe = "\\\\.\\pipe\\codex-tools-test-new";
    handoff.accept(newPipe, OWNER);
    handoff.observeDesktopState(connectedState(OWNER, "conversation-3"));
    expect(handoff.pipePathFor(connectedState(OWNER, "conversation-3"))).toBe(newPipe);
  });

  it("uses the explicit handed-off pipe and only probes tools/list", async () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.accept(PIPE, OWNER);
    const seenPipePaths: string[] = [];
    const calls: string[] = [];
    let closed = 0;
    const factory = new DesktopCodexRuntimeFactory(
      handoff,
      () => connectedState(),
      async ({ pipePath }) => {
        seenPipePaths.push(pipePath!);
        return fakeRuntime(calls, () => { closed += 1; });
      },
    );
    const result = await probeDesktopToolsPipe(factory);
    expect(seenPipePaths).toEqual([PIPE]);
    expect(calls).toEqual(["tools/list"]);
    expect(closed).toBe(1);
    expect(result).toMatchObject({
      connected: true,
      desktopDetected: true,
      bundleDetected: true,
      mcpTransport: "stdio",
      nativeDesktopTransport: "windows_named_pipe",
      pipeSource: "handoff",
      toolCount: REQUIRED_DESKTOP_TOOLS.length,
    });
    expect(result.requiredToolsPresent).toEqual(Object.fromEntries(
      REQUIRED_DESKTOP_TOOLS.map((name) => [name, true]),
    ));
    expect(JSON.stringify(result)).not.toContain(PIPE);
  });

  it("fails the factory closed when Desktop evidence is stale", async () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.accept(PIPE, OWNER);
    const factory = new DesktopCodexRuntimeFactory(
      handoff,
      () => connectedState("desktop-instance-2"),
      vi.fn(),
    );
    await expect(factory.connect()).rejects.toMatchObject({ code: "desktop_tools_pipe_unavailable" });
  });

  it("fails the sender closed when the Desktop environment does not provide a pipe", async () => {
    const fetch = vi.fn();
    await expect(sendDesktopToolsPipeHandoff(settings("C:\\workspace"), {
      environment: {},
      fetch,
    })).rejects.toMatchObject({ code: "desktop_tools_pipe_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sanitizes the sender response", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ pipePath: PIPE }));
      return new Response(JSON.stringify({
        accepted: true,
        source: "desktop_environment",
        received_at: "2026-09-20T01:00:00.000Z",
        desktop_owner_bound: true,
        pipePath: PIPE,
      }), { status: 200 });
    });
    const result = await sendDesktopToolsPipeHandoff(settings("C:\\workspace"), {
      environment: { CODEX_APP_TOOLS_PIPE_PATH: PIPE },
      fetch,
    });
    expect(result).toEqual({
      accepted: true,
      source: "desktop_environment",
      received_at: "2026-09-20T01:00:00.000Z",
      desktop_owner_bound: true,
    });
    expect(JSON.stringify(result)).not.toContain(PIPE);
  });

  it("recognizes a pending sender response without treating it as owner-bound", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      accepted: false,
      pending: true,
      source: "desktop_environment",
      received_at: "2026-09-20T01:00:00.000Z",
      desktop_owner_bound: false,
      pipePath: PIPE,
    }), { status: 202 }));
    const result = await sendDesktopToolsPipeHandoff(settings("C:\\workspace"), {
      environment: { CODEX_APP_TOOLS_PIPE_PATH: PIPE },
      fetch,
    });
    expect(result).toEqual({
      accepted: false,
      pending: true,
      source: "desktop_environment",
      received_at: "2026-09-20T01:00:00.000Z",
      desktop_owner_bound: false,
    });
    expect(JSON.stringify(result)).not.toContain(PIPE);
  });
});

describe("Desktop tools pipe launcher endpoints", () => {
  it("registers a cold-start pipe as pending and promotes it after owner binding", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-tools-pipe-pending-"));
    temporaryDirectories.push(workspace);
    let state: DesktopSyncState = { connected: true, followingThreads: new Set() };
    const handoff = new DesktopToolsPipeHandoff(() => "2026-09-20T01:00:00.000Z");
    const calls: string[] = [];
    const server = createHttpServer(settings(workspace), {
      registry: new WorkspaceRegistry([{ id: "tools-pipe-pending", name: "Tools Pipe Pending", path: workspace }]),
      desktopSyncObserver: { getState: () => state },
      desktopToolsPipeHandoff: handoff,
      desktopCodexRuntimeFactory: new DesktopCodexRuntimeFactory(
        handoff,
        () => state,
        async () => fakeRuntime(calls),
      ),
    });
    runningServers.push(server);
    const port = await listen(server);
    const handoffUrl = `http://127.0.0.1:${port}${LAUNCHER_DESKTOP_TOOLS_PIPE_PATH}`;
    const probeUrl = `http://127.0.0.1:${port}${LAUNCHER_DESKTOP_TOOLS_PIPE_PROBE_PATH}`;
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };

    const pending = await fetch(handoffUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ pipePath: PIPE }),
    });
    expect(pending.status).toBe(202);
    await expect(pending.json()).resolves.toEqual({
      accepted: false,
      pending: true,
      source: "desktop_environment",
      received_at: "2026-09-20T01:00:00.000Z",
      desktop_owner_bound: false,
    });
    expect(handoff.pipePathFor(state)).toBeUndefined();

    state = connectedState();
    handoff.observeDesktopState(state);
    const probe = await fetch(probeUrl, { method: "POST", headers });
    expect(probe.status).toBe(200);
    await expect(probe.json()).resolves.toMatchObject({ connected: true, pipeSource: "handoff" });
    expect(calls).toEqual(["tools/list"]);
  });

  it("requires loopback, static auth, POST, and never returns the pipe", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-tools-pipe-http-"));
    temporaryDirectories.push(workspace);
    let state = connectedState();
    const handoff = new DesktopToolsPipeHandoff(() => "2026-09-20T01:00:00.000Z");
    const calls: string[] = [];
    const server = createHttpServer(settings(workspace), {
      registry: new WorkspaceRegistry([{ id: "tools-pipe", name: "Tools Pipe", path: workspace }]),
      desktopSyncObserver: { getState: () => state },
      desktopToolsPipeHandoff: handoff,
      desktopCodexRuntimeFactory: new DesktopCodexRuntimeFactory(
        handoff,
        () => state,
        async () => fakeRuntime(calls),
      ),
    });
    runningServers.push(server);
    const port = await listen(server);
    const handoffUrl = `http://127.0.0.1:${port}${LAUNCHER_DESKTOP_TOOLS_PIPE_PATH}`;
    const probeUrl = `http://127.0.0.1:${port}${LAUNCHER_DESKTOP_TOOLS_PIPE_PROBE_PATH}`;
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    const body = JSON.stringify({ pipePath: PIPE });

    expect((await fetch(handoffUrl, { method: "POST", headers: { ...headers, authorization: "Bearer wrong" }, body })).status)
      .toBe(401);
    expect((await fetch(handoffUrl, { method: "GET", headers })).status).toBe(405);
    expect((await fetch(handoffUrl, { method: "POST", headers: { ...headers, "x-forwarded-for": "127.0.0.1" }, body })).status)
      .toBe(404);

    const accepted = await fetch(handoffUrl, { method: "POST", headers, body });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json() as Record<string, unknown>;
    expect(acceptedBody).toEqual({
      accepted: true,
      source: "desktop_environment",
      received_at: "2026-09-20T01:00:00.000Z",
      desktop_owner_bound: true,
    });
    expect(JSON.stringify(acceptedBody)).not.toContain(PIPE);

    const probe = await fetch(probeUrl, { method: "POST", headers });
    expect(probe.status).toBe(200);
    const probeBody = await probe.json() as Record<string, unknown>;
    expect(probeBody).toMatchObject({
      connected: true,
      pipeSource: "handoff",
      requiredToolsPresent: Object.fromEntries(REQUIRED_DESKTOP_TOOLS.map((name) => [name, true])),
    });
    expect(JSON.stringify(probeBody)).not.toContain(PIPE);
    expect(calls).toEqual(["tools/list"]);

    state = { connected: false, followingThreads: new Set() };
    const stale = await fetch(probeUrl, { method: "POST", headers });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ connected: false, error: "desktop_tools_pipe_unavailable" });
  });
});

it("does not accept an OAuth-shaped bearer as a desktop handoff credential", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-tools-pipe-auth-"));
  temporaryDirectories.push(workspace);
  const state = connectedState();
  const server = createHttpServer(settings(workspace), {
    registry: new WorkspaceRegistry([{ id: "tools-pipe-auth", name: "Tools Pipe Auth", path: workspace }]),
    desktopSyncObserver: { getState: () => state },
    desktopToolsPipeHandoff: new DesktopToolsPipeHandoff(),
  });
  runningServers.push(server);
  const port = await listen(server);
  const response = await fetch(`http://127.0.0.1:${port}${LAUNCHER_DESKTOP_TOOLS_PIPE_PATH}`, {
    method: "POST",
    headers: { authorization: "Bearer oauth-token", "content-type": "application/json" },
    body: JSON.stringify({ pipePath: PIPE }),
  });
  expect(response.status).toBe(401);
});

it("wires Desktop IPC state changes into handoff invalidation and removes the listener on close", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-tools-pipe-wiring-"));
  temporaryDirectories.push(workspace);
  let state = connectedState();
  let stateListener: ((next: DesktopSyncState) => void) | undefined;
  const unsubscribe = vi.fn();
  const observer = {
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    getState: vi.fn(() => state),
    onStateChanged: vi.fn((listener: (next: DesktopSyncState) => void) => {
      stateListener = listener;
      return unsubscribe;
    }),
  };
  const server = await startApp(settings(workspace), undefined, {
    bridgePorts: [],
    desktopSyncObserver: observer,
    silent: true,
  });
  runningServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  const url = `http://127.0.0.1:${address.port}${LAUNCHER_DESKTOP_TOOLS_PIPE_PATH}`;
  const probeUrl = `http://127.0.0.1:${address.port}${LAUNCHER_DESKTOP_TOOLS_PIPE_PROBE_PATH}`;
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  const accepted = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ pipePath: PIPE }),
  });
  expect(accepted.status).toBe(200);
  expect(observer.onStateChanged).toHaveBeenCalledTimes(1);
  expect(stateListener).toBeDefined();

  state = { connected: false, followingThreads: new Set() };
  stateListener!(state);
  state = connectedState();
  stateListener!(state);
  const staleProbe = await fetch(probeUrl, { method: "POST", headers });
  expect(staleProbe.status).toBe(409);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const index = runningServers.indexOf(server);
  if (index >= 0) runningServers.splice(index, 1);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
