import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityNegotiator,
  DesktopCapabilityProvider,
  type CapabilityProvider,
  type CapabilityPreparation,
  StandaloneCapabilityProvider,
} from "../../src/control-plane/capability-negotiation.js";
import type { ResolvedSettings } from "../../src/config/settings.js";
import { createHttpServer, LAUNCHER_CAPABILITY_PATH } from "../../src/mcp/http.js";
import type {
  ExecutionBackendStartRequest,
  ExecutionStartResult,
} from "../../src/control-plane/execution-service.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const request: ExecutionBackendStartRequest = {
  workspace_id: "workspace-1",
  task_id: "task-1",
  execution_id: "execution-1",
  instruction: "run the task",
  execution_mode: "interactive",
};

const started: ExecutionStartResult = {
  execution_id: request.execution_id,
  started_at: "2026-09-23T00:00:00.000Z",
  accepted: "new",
};

function provider(
  source: "desktop" | "standalone",
  preparation: CapabilityPreparation,
  start: () => Promise<ExecutionStartResult> = async () => started,
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

describe("P5.9 capability negotiation", () => {
  it("uses Desktop after trampoline handoff succeeds", async () => {
    let ready = false;
    const desktopStart = vi.fn(async () => started);
    const desktop = new DesktopCapabilityProvider({
      backend: { start: desktopStart },
      readiness: () => ready
        ? { ready: true, pipeSource: "handoff" }
        : { ready: false, reason: "desktop_tools_pipe_unavailable" },
      trampolineHandoff: () => { ready = true; },
      sessionStartHandoff: vi.fn(),
    });
    const standaloneStart = vi.fn(async () => started);
    const negotiator = new CapabilityNegotiator({
      desktop,
      standalone: new StandaloneCapabilityProvider({ start: standaloneStart }),
      desktopTimeoutMs: 1,
      fallbackTimeoutMs: 1,
    });

    await expect(negotiator.start(request)).resolves.toEqual(started);
    expect(desktopStart).toHaveBeenCalledOnce();
    expect(standaloneStart).not.toHaveBeenCalled();
    expect(negotiator.snapshot()).toMatchObject({ state: "desktop_ready", source: "desktop" });
  });

  it("reports Desktop handoff timeout before fallback selection", async () => {
    const waits = clock();
    const desktop = provider("desktop", { ready: false, reason: "desktop_tools_pipe_unavailable" });
    const standaloneStart = vi.fn(async () => started);
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
    expect(negotiator.snapshot()).toMatchObject({ state: "desktop_failed", source: "desktop" });
    negotiator.selectStandalone();
    waits.release();
    await promise;
  });

  it("starts standalone when the user selects the fallback", async () => {
    const waits = clock();
    const desktop = provider("desktop", { ready: false, reason: "desktop_handoff_failed" });
    const standaloneStart = vi.fn(async () => started);
    const negotiator = new CapabilityNegotiator({
      desktop,
      standalone: new StandaloneCapabilityProvider({ start: standaloneStart }),
      fallbackTimeoutMs: 10_000,
      now: waits.now,
      wait: waits.wait,
    });
    const promise = negotiator.start(request);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(negotiator.snapshot()).toMatchObject({ state: "desktop_failed", source: "desktop" });
    negotiator.selectStandalone();
    waits.release();

    await expect(promise).resolves.toEqual(started);
    expect(standaloneStart).toHaveBeenCalledOnce();
    expect(negotiator.snapshot()).toMatchObject({ state: "fallback_running", source: "standalone" });
  });

  it("automatically falls back after the decision timeout", async () => {
    const waits = clock();
    const standaloneStart = vi.fn(async () => started);
    const negotiator = new CapabilityNegotiator({
      desktop: provider("desktop", { ready: false, reason: "desktop_handoff_failed" }),
      standalone: new StandaloneCapabilityProvider({ start: standaloneStart }),
      fallbackTimeoutMs: 2,
      pollIntervalMs: 1,
      now: waits.now,
      wait: waits.wait,
    });

    await expect(negotiator.start(request)).resolves.toEqual(started);
    expect(standaloneStart).toHaveBeenCalledOnce();
    expect(negotiator.snapshot()).toMatchObject({ state: "fallback_running", source: "standalone" });
  });

  it("supports standalone execution as an explicit capability choice", async () => {
    const desktopStart = vi.fn(async () => started);
    const standaloneStart = vi.fn(async () => started);
    const negotiator = new CapabilityNegotiator({
      desktop: provider("desktop", { ready: true }, desktopStart),
      standalone: new StandaloneCapabilityProvider({ start: standaloneStart }),
    });

    negotiator.selectStandalone();
    await expect(negotiator.start(request)).resolves.toEqual(started);
    expect(standaloneStart).toHaveBeenCalledOnce();
    expect(desktopStart).not.toHaveBeenCalled();
  });

  it("exposes authenticated state and user actions through the launcher endpoint", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-capability-http-"));
    temporaryDirectories.push(workspace);
    const negotiator = new CapabilityNegotiator({
      desktop: provider("desktop", { ready: true }),
      standalone: new StandaloneCapabilityProvider({ start: vi.fn(async () => started) }),
    });
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
    await expect((await fetch(url, { headers })).json()).resolves.toMatchObject({
      state: "initializing",
      source: null,
    });
    await expect((await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ action: "standalone" }),
    })).json()).resolves.toMatchObject({ state: "fallback_ready", source: "standalone" });
    await expect((await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ action: "retry" }),
    })).json()).resolves.toMatchObject({ state: "initializing", source: null });
  });
});
