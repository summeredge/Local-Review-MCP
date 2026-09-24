import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityExecutionError,
  CapabilityNegotiator,
  DesktopCapabilityProvider,
  type CapabilityProvider,
  type CapabilityPreparation,
  StandaloneCapabilityProvider,
} from "../../src/control-plane/capability-negotiation.js";
import { CapabilityTimeline } from "../../src/control-plane/capability-timeline.js";
import type { ResolvedSettings } from "../../src/config/settings.js";
import {
  createHttpServer,
  LAUNCHER_CAPABILITY_PATH,
  LAUNCHER_CAPABILITY_TIMELINE_PATH,
} from "../../src/mcp/http.js";
import type {
  ExecutionBackendStartRequest,
  ExecutionStartResult,
} from "../../src/control-plane/execution-service.js";
import type { DesktopSyncState } from "../../src/desktop-sync/desktop-sync-state.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function requestFor(executionId: string, taskId = "task-1", actuationId = `actuation-${executionId}`): ExecutionBackendStartRequest {
  return {
    workspace_id: "workspace-1",
    task_id: taskId,
    actuation_id: actuationId,
    execution_id: executionId,
    instruction: "run the task",
    execution_mode: "interactive",
  };
}

const request = requestFor("execution-1");

function startedFor(value: ExecutionBackendStartRequest): ExecutionStartResult {
  return {
    execution_id: value.execution_id,
    started_at: "2026-09-23T00:00:00.000Z",
    accepted: "new",
  };
}

function provider(
  source: "desktop" | "standalone",
  preparation: CapabilityPreparation,
  start: (request: ExecutionBackendStartRequest) => Promise<ExecutionStartResult>
    = async (value) => startedFor(value),
): CapabilityProvider {
  return {
    source,
    prepare: vi.fn(async () => preparation),
    start: vi.fn(start),
    close: vi.fn(async () => undefined),
  };
}

function clock() {
  let current = 0;
  let blocked = false;
  let release: (() => void) | undefined;
  return {
    now: () => current,
    wait: async (milliseconds: number): Promise<void> => {
      if (!blocked) {
        current += milliseconds;
        if (current >= 2) blocked = true;
        return;
      }
      await new Promise<void>((resolve) => { release = resolve; });
    },
    release: () => release?.(),
  };
}

describe("P5.9.1 capability negotiation", () => {
  it("restores a bound Desktop capability without sending another handoff", async () => {
    const desktopState: DesktopSyncState = {
      connected: true,
      currentConversationId: "conversation-1",
      ownerClientId: "desktop-1",
      followingThreads: new Set(),
    };
    const prepare = vi.fn(async (): Promise<CapabilityPreparation> => ({
      ready: false,
      reason: "desktop_tools_pipe_unavailable",
    }));
    const desktopStart = vi.fn(async (value: ExecutionBackendStartRequest) => startedFor(value));
    const pipeResolver = {
      resolve: vi.fn(() => ({
        pipePath: "\\\\.\\pipe\\codex-tools-handoff",
        source: "handoff" as const,
      })),
    };
    const timeline = new CapabilityTimeline();
    const negotiator = new CapabilityNegotiator({
      desktop: {
        source: "desktop",
        prepare,
        start: desktopStart,
      },
      standalone: provider("standalone", { ready: true }),
      timeline,
      desktopState: () => desktopState,
      desktopPipeResolver: pipeResolver,
      workspaceId: request.workspace_id,
    });

    const pending = negotiator.start(request);
    expect(negotiator.snapshot(request.execution_id)).toMatchObject({ state: "desktop_pending" });
    expect(negotiator.reconcileDesktopCapability(undefined, desktopState)).toMatchObject({
      state: "desktop_ready",
      source: "desktop",
      reason: "desktop_binding_recovered",
    });

    await expect(pending).resolves.toEqual(startedFor(request));
    expect(prepare).toHaveBeenCalledOnce();
    expect(pipeResolver.resolve).toHaveBeenCalledOnce();
    expect(desktopStart).toHaveBeenCalledOnce();
    expect(timeline.recent(request.execution_id).at(-1)).toMatchObject({
      previous_state: "desktop_pending",
      current_state: "desktop_ready",
      source: "desktop",
      reason: "desktop_binding_recovered",
      event: "desktop_capability_restored",
    });
  });

  it("does not restore a Desktop capability without the same conversation and pipe", async () => {
    let desktopState: DesktopSyncState = {
      connected: true,
      currentConversationId: "conversation-1",
      ownerClientId: "desktop-1",
      followingThreads: new Set(),
    };
    const releaseWait = (() => {
      let release: (() => void) | undefined;
      return {
        wait: () => new Promise<void>((resolve) => { release = resolve; }),
        release: () => release?.(),
      };
    })();
    const pipeResolver = { resolve: vi.fn(() => { throw new Error("pipe unavailable"); }) };
    const negotiator = new CapabilityNegotiator({
      desktop: provider("desktop", { ready: false, reason: "desktop_tools_pipe_unavailable" }),
      standalone: provider("standalone", { ready: true }),
      desktopTimeoutMs: 0,
      fallbackTimeoutMs: 10_000,
      now: () => 0,
      wait: releaseWait.wait,
      desktopState: () => desktopState,
      desktopPipeResolver: pipeResolver,
      workspaceId: request.workspace_id,
    });

    const pending = negotiator.start(request);
    desktopState = { ...desktopState, currentConversationId: undefined };
    expect(negotiator.reconcileDesktopCapability(request.execution_id)).toMatchObject({
      state: "desktop_pending",
      source: "desktop",
    });
    desktopState = { ...desktopState, currentConversationId: "conversation-1" };
    expect(negotiator.reconcileDesktopCapability(request.execution_id)).toMatchObject({
      state: "desktop_pending",
      source: "desktop",
    });
    expect(pipeResolver.resolve).toHaveBeenCalledOnce();

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(negotiator.snapshot(request.execution_id)).toMatchObject({ state: "desktop_failed" });

    negotiator.selectStandalone(request.execution_id);
    releaseWait.release();
    await expect(pending).resolves.toEqual(startedFor(request));
  });

  it("keeps fallback waiting when Desktop returns", async () => {
    const desktopState: DesktopSyncState = {
      connected: true,
      currentConversationId: "conversation-1",
      ownerClientId: "desktop-1",
      followingThreads: new Set(),
    };
    const waits = clock();
    const pipeResolver = {
      resolve: vi.fn(() => ({
        pipePath: "\\\\.\\pipe\\codex-tools-handoff",
        source: "handoff" as const,
      })),
    };
    const negotiator = new CapabilityNegotiator({
      desktop: provider("desktop", { ready: false, reason: "desktop_handoff_failed" }),
      standalone: provider("standalone", { ready: true }),
      fallbackTimeoutMs: 10_000,
      now: waits.now,
      wait: waits.wait,
      desktopState: () => desktopState,
      desktopPipeResolver: pipeResolver,
      workspaceId: request.workspace_id,
    });

    const pending = negotiator.start(request);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(negotiator.snapshot(request.execution_id)).toMatchObject({
      state: "desktop_failed",
      source: "desktop",
      timestamps: { fallbackDeadlineAt: expect.any(String) },
    });
    expect(negotiator.reconcileDesktopCapability(request.execution_id)).toMatchObject({
      state: "desktop_failed",
      source: "desktop",
      reason: "desktop_handoff_failed",
    });
    expect(pipeResolver.resolve).not.toHaveBeenCalled();
    negotiator.selectStandalone(request.execution_id);
    waits.release();
    await expect(pending).resolves.toEqual(startedFor(request));
  });

  it("records an ordered execution timeline and preserves provider errors", async () => {
    const waits = clock();
    const backendError = Object.assign(new Error("app-server unavailable"), { code: "app_server_unavailable" });
    const timeline = new CapabilityTimeline();
    const negotiator = new CapabilityNegotiator({
      desktop: provider("desktop", { ready: false, reason: "desktop_handoff_failed" }),
      standalone: new StandaloneCapabilityProvider({
        start: vi.fn(async () => { throw backendError; }),
      }),
      fallbackTimeoutMs: 2,
      pollIntervalMs: 1,
      now: waits.now,
      wait: waits.wait,
      timeline,
    });

    await expect(negotiator.start(request)).rejects.toMatchObject({
      provider: "standalone",
      code: "app_server_unavailable",
    });

    expect(timeline.recent(request.execution_id).map((event) => [
      event.event,
      event.previous_state,
      event.current_state,
      event.reason,
      event.error_code,
    ])).toEqual([
      ["initializing", null, "initializing", null, null],
      ["desktop_pending", "initializing", "desktop_pending", null, null],
      ["desktop_failed", "desktop_pending", "desktop_failed", "desktop_handoff_failed", "desktop_handoff_failed"],
      ["fallback_waiting", "desktop_failed", "desktop_failed", "desktop_handoff_failed", "desktop_handoff_failed"],
      ["fallback_selected", "desktop_failed", "fallback_ready", "desktop_handoff_timeout", "desktop_handoff_timeout"],
      ["fallback_ready", "fallback_ready", "fallback_ready", "standalone_execution_failed", "app_server_unavailable"],
    ]);
  });

  it("continues provider selection when timeline recording fails", async () => {
    const timeline = {
      record: vi.fn(() => { throw new Error("timeline unavailable"); }),
      recent: vi.fn(() => []),
    };
    const desktopStart = vi.fn(async (value: ExecutionBackendStartRequest) => startedFor(value));
    const negotiator = new CapabilityNegotiator({
      desktop: {
        ...provider("desktop", { ready: true }),
        start: desktopStart,
      },
      standalone: provider("standalone", { ready: true }),
      timeline,
    });

    await expect(negotiator.start(request)).resolves.toEqual(startedFor(request));
    expect(desktopStart).toHaveBeenCalledOnce();
  });

  it("uses Desktop after a capability recheck succeeds", async () => {
    let checks = 0;
    const desktopStart = vi.fn(async (value: ExecutionBackendStartRequest) => startedFor(value));
    const desktop = new DesktopCapabilityProvider({
      backend: { start: desktopStart },
      readiness: () => ++checks >= 2
        ? { ready: true, pipeSource: "handoff" }
        : { ready: false, reason: "desktop_tools_pipe_unavailable" },
    });
    const standaloneStart = vi.fn(async (value: ExecutionBackendStartRequest) => startedFor(value));
    const negotiator = new CapabilityNegotiator({
      desktop,
      standalone: new StandaloneCapabilityProvider({ start: standaloneStart }),
      desktopTimeoutMs: 10,
      fallbackTimeoutMs: 10,
      pollIntervalMs: 1,
    });

    await expect(negotiator.start(request)).resolves.toEqual(startedFor(request));
    expect(desktopStart).toHaveBeenCalledOnce();
    expect(standaloneStart).not.toHaveBeenCalled();
    expect(negotiator.snapshot(request.execution_id)).toMatchObject({
      execution_id: request.execution_id,
      task_id: request.task_id,
      actuation_id: request.actuation_id,
      state: "desktop_ready",
      source: "desktop",
    });
    expect(negotiator.timeline(request.execution_id).map((event) => [
      event.previous_state,
      event.current_state,
    ])).toEqual([
      [null, "initializing"],
      ["initializing", "desktop_pending"],
      ["desktop_pending", "desktop_ready"],
    ]);
  });

  it("reports Desktop capability timeout before fallback selection", async () => {
    const waits = clock();
    const desktop = provider("desktop", { ready: false, reason: "desktop_tools_pipe_unavailable" });
    const standaloneStart = vi.fn(async (value: ExecutionBackendStartRequest) => startedFor(value));
    const negotiator = new CapabilityNegotiator({
      desktop,
      standalone: new StandaloneCapabilityProvider({ start: standaloneStart }),
      desktopTimeoutMs: 2,
      fallbackTimeoutMs: 10_000,
      pollIntervalMs: 1,
      now: waits.now,
      wait: waits.wait,
    });
    const promise = negotiator.start(request);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(standaloneStart).not.toHaveBeenCalled();
    expect(negotiator.snapshot(request.execution_id)).toMatchObject({
      state: "desktop_failed",
      source: "desktop",
      reason: "desktop_handoff_timeout",
      error_code: "desktop_handoff_timeout",
      actions: ["recheck", "standalone"],
    });
    negotiator.selectStandalone(request.execution_id);
    waits.release();
    await expect(promise).resolves.toEqual(startedFor(request));
  });

  it("rechecks only the targeted execution capability", async () => {
    let checks = 0;
    const desktopStart = vi.fn(async (value: ExecutionBackendStartRequest) => startedFor(value));
    const desktop = provider("desktop", { ready: false, reason: "desktop_tools_pipe_unavailable" }, async (value) => {
      checks += 1;
      return startedFor(value);
    });
    desktop.prepare = vi.fn(async () => checks++ >= 1
      ? { ready: true }
      : { ready: false, reason: "desktop_tools_pipe_unavailable" as const });
    desktop.start = desktopStart;
    const negotiator = new CapabilityNegotiator({
      desktop,
      standalone: new StandaloneCapabilityProvider({ start: vi.fn(async (value) => startedFor(value)) }),
      desktopTimeoutMs: 10_000,
      fallbackTimeoutMs: 10_000,
      pollIntervalMs: 1,
    });
    const promise = negotiator.start(request);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const before = negotiator.snapshot(request.execution_id);
    expect(before).toMatchObject({ state: "desktop_pending", actions: ["recheck", "standalone"] });
    expect(negotiator.recheckDesktop(request.execution_id)).toMatchObject({
      execution_id: request.execution_id,
      state: "initializing",
      requestedAction: "recheck",
    });
    await expect(promise).resolves.toEqual(startedFor(request));
    expect(desktopStart).toHaveBeenCalledOnce();
    expect(negotiator.snapshot(request.execution_id)).toMatchObject({ state: "desktop_ready" });
  });

  it("starts standalone when the user selects the targeted fallback", async () => {
    const waits = clock();
    const standaloneStart = vi.fn(async (value: ExecutionBackendStartRequest) => startedFor(value));
    const negotiator = new CapabilityNegotiator({
      desktop: provider("desktop", { ready: false, reason: "desktop_handoff_failed" }),
      standalone: new StandaloneCapabilityProvider({ start: standaloneStart }),
      fallbackTimeoutMs: 10_000,
      now: waits.now,
      wait: waits.wait,
    });
    const promise = negotiator.start(request);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(negotiator.snapshot(request.execution_id)).toMatchObject({ state: "desktop_failed" });
    expect(negotiator.selectStandalone(request.execution_id)).toMatchObject({
      state: "fallback_ready",
      source: "standalone",
      requestedAction: "standalone",
    });
    waits.release();

    await expect(promise).resolves.toEqual(startedFor(request));
    expect(standaloneStart).toHaveBeenCalledOnce();
    expect(negotiator.snapshot(request.execution_id)).toMatchObject({
      state: "fallback_running",
      source: "standalone",
      reason: null,
      error_code: null,
    });
    expect(negotiator.timeline(request.execution_id).map((event) => event.event)).toEqual([
      "initializing",
      "desktop_pending",
      "desktop_failed",
      "fallback_waiting",
      "fallback_selected",
      "fallback_running",
    ]);
    expect(negotiator.timeline(request.execution_id).at(-1)).toMatchObject({
      previous_state: "fallback_ready",
      current_state: "fallback_running",
      event: "fallback_running",
    });
  });

  it("keeps two concurrent executions isolated", async () => {
    const requestA = requestFor("execution-a", "task-a", "actuation-a");
    const requestB = requestFor("execution-b", "task-b", "actuation-b");
    const standaloneStart = vi.fn(async (value: ExecutionBackendStartRequest) => startedFor(value));
    const negotiator = new CapabilityNegotiator({
      desktop: provider("desktop", { ready: false, reason: "desktop_handoff_failed" }),
      standalone: new StandaloneCapabilityProvider({ start: standaloneStart }),
      fallbackTimeoutMs: 1_000,
      pollIntervalMs: 1,
    });
    const promiseA = negotiator.start(requestA);
    const promiseB = negotiator.start(requestB);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(negotiator.snapshot(requestA.execution_id)).toMatchObject({
      execution_id: requestA.execution_id,
      task_id: requestA.task_id,
      actuation_id: requestA.actuation_id,
      state: "desktop_failed",
    });
    expect(negotiator.snapshot(requestB.execution_id)).toMatchObject({
      execution_id: requestB.execution_id,
      task_id: requestB.task_id,
      actuation_id: requestB.actuation_id,
      state: "desktop_failed",
    });

    negotiator.selectStandalone(requestA.execution_id);
    await expect(promiseA).resolves.toEqual(startedFor(requestA));
    expect(standaloneStart).toHaveBeenCalledWith(requestA);
    expect(standaloneStart).not.toHaveBeenCalledWith(requestB);
    expect(negotiator.snapshot(requestB.execution_id)).toMatchObject({
      execution_id: requestB.execution_id,
      state: "desktop_failed",
      source: "desktop",
    });
    negotiator.selectStandalone(requestB.execution_id);
    await expect(promiseB).resolves.toEqual(startedFor(requestB));
    expect(standaloneStart.mock.calls.map(([value]) => value.execution_id)).toEqual([
      requestA.execution_id,
      requestB.execution_id,
    ]);
  });

  it("automatically falls back after the decision timeout", async () => {
    const waits = clock();
    const standaloneStart = vi.fn(async (value: ExecutionBackendStartRequest) => startedFor(value));
    const negotiator = new CapabilityNegotiator({
      desktop: provider("desktop", { ready: false, reason: "desktop_handoff_failed" }),
      standalone: new StandaloneCapabilityProvider({ start: standaloneStart }),
      fallbackTimeoutMs: 2,
      pollIntervalMs: 1,
      now: waits.now,
      wait: waits.wait,
    });

    await expect(negotiator.start(request)).resolves.toEqual(startedFor(request));
    expect(standaloneStart).toHaveBeenCalledOnce();
    expect(negotiator.snapshot(request.execution_id)).toMatchObject({
      state: "fallback_running",
      source: "standalone",
      reason: "desktop_handoff_timeout",
      error_code: "desktop_handoff_timeout",
    });
    expect(negotiator.timeline(request.execution_id).map((event) => event.event)).toEqual([
      "initializing",
      "desktop_pending",
      "desktop_failed",
      "fallback_waiting",
      "fallback_selected",
      "fallback_running",
    ]);
  });

  it("keeps fallback_ready when standalone start fails and preserves provider error details", async () => {
    const waits = clock();
    const backendError = Object.assign(new Error("app-server unavailable"), { code: "app_server_unavailable" });
    const negotiator = new CapabilityNegotiator({
      desktop: provider("desktop", { ready: false, reason: "desktop_handoff_failed" }),
      standalone: new StandaloneCapabilityProvider({
        start: vi.fn(async () => { throw backendError; }),
      }),
      fallbackTimeoutMs: 2,
      pollIntervalMs: 1,
      now: waits.now,
      wait: waits.wait,
    });

    const failure = await negotiator.start(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CapabilityExecutionError);
    expect(failure).toMatchObject({ provider: "standalone", code: "app_server_unavailable", cause: backendError });
    expect(negotiator.snapshot(request.execution_id)).toMatchObject({
      state: "fallback_ready",
      source: "standalone",
      error_code: "app_server_unavailable",
    });
    expect(negotiator.snapshot(request.execution_id)).not.toMatchObject({ state: "fallback_running" });
  });

  it("exposes authenticated execution-scoped state and actions through the launcher endpoint", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-capability-http-"));
    temporaryDirectories.push(workspace);
    const waits = clock();
    const negotiator = new CapabilityNegotiator({
      desktop: provider("desktop", { ready: false, reason: "desktop_handoff_failed" }),
      standalone: new StandaloneCapabilityProvider({ start: vi.fn(async (value) => startedFor(value)) }),
      fallbackTimeoutMs: 10_000,
      now: waits.now,
      wait: waits.wait,
    });
    const pending = negotiator.start(request);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const settings: ResolvedSettings = {
      host: "127.0.0.1",
      port: 0,
      workspace,
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    };
    const server = createHttpServer(settings, {
      registry: new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: workspace }]),
      capabilityNegotiator: negotiator,
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("server has no address");
    const url = `http://127.0.0.1:${address.port}${LAUNCHER_CAPABILITY_PATH}`;
    const headers = { authorization: "Bearer test-token" };

    expect((await fetch(url)).status).toBe(401);
    await expect((await fetch(`${url}?execution_id=current`, { headers })).json()).resolves.toMatchObject({
      execution_id: request.execution_id,
      task_id: request.task_id,
      actuation_id: request.actuation_id,
      state: "desktop_failed",
      reason: "desktop_handoff_failed",
      error_code: "desktop_handoff_failed",
      actions: ["recheck", "standalone"],
    });
    await expect((await fetch(`${url.replace(LAUNCHER_CAPABILITY_PATH, LAUNCHER_CAPABILITY_TIMELINE_PATH)}?execution_id=${request.execution_id}`, {
      headers,
    })).json()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          execution_id: request.execution_id,
          task_id: request.task_id,
          previous_state: null,
          current_state: "initializing",
        }),
        expect.objectContaining({
          previous_state: "desktop_pending",
          current_state: "desktop_failed",
          reason: "desktop_handoff_failed",
          error_code: "desktop_handoff_failed",
          event: "desktop_failed",
        }),
        expect.objectContaining({
          current_state: "desktop_failed",
          event: "fallback_waiting",
        }),
      ]),
    });
    await expect((await fetch(`${url}?execution_id=${request.execution_id}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ action: "recheck", execution_id: request.execution_id }),
    })).json()).resolves.toMatchObject({
      execution_id: request.execution_id,
      state: "initializing",
      requestedAction: "recheck",
    });
    await expect((await fetch(`${url}?execution_id=${request.execution_id}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", execution_id: request.execution_id }),
    })).status).toBe(400);

    negotiator.selectStandalone(request.execution_id);
    waits.release();
    await pending;
  });
});
