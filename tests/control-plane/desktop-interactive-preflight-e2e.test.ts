import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../../src/mcp/http.js";
import type { ResolvedSettings } from "../../src/config/settings.js";
import {
  DesktopToolsPipeHandoff,
  LAUNCHER_DESKTOP_TOOLS_PIPE_PATH,
} from "../../src/desktop-codex/desktop-tools-pipe-handoff.js";
import { DesktopInteractivePreflight } from "../../src/desktop-codex/desktop-interactive-preflight.js";
import {
  DesktopCodexRuntimeFactory,
  type DesktopCodexRuntimeLike,
} from "../../src/desktop-codex/desktop-tools-pipe-probe.js";
import {
  GoalPreflightService,
  GoalPreflightError,
} from "../../src/control-plane/goal-preflight.js";
import type { ChatGPTConnectorDiagnostic } from "../../src/control-plane/chatgpt-connector.js";
import { GoalSubmissionService } from "../../src/control-plane/goal-submission.js";
import type { DesktopSyncState } from "../../src/desktop-sync/desktop-sync-state.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

/**
 * P5.4.1 production Desktop pipe source correction, end to end.
 *
 * These tests prove the production consequence rather than the resolver in isolation: a
 * Launcher-started LRM Host with no accepted handoff and no inherited
 * `CODEX_APP_TOOLS_PIPE_PATH` must fail the interactive Goal closed with a queryable
 * `desktop_tools_pipe_unavailable` reason, before any Goal, Task, Session, or Execution exists.
 */

const PIPE_PREFIX = "\\\\.\\pipe\\";
const HANDOFF_PIPE = PIPE_PREFIX + "codex-preflight-handoff";
const HOST_ENV_PIPE = PIPE_PREFIX + "codex-preflight-host-env";
const OWNER = "desktop-instance-1";
const runningServers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

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

function connectedState(overrides: Partial<DesktopSyncState> = {}): DesktopSyncState {
  return {
    connected: true,
    currentConversationId: "conversation-1",
    ownerClientId: OWNER,
    followingThreads: new Set(),
    ...overrides,
  };
}

function fakeRuntime(): DesktopCodexRuntimeLike {
  return {
    info: { desktopDetected: true, bundleDetected: true },
    async listTools() {
      return { tools: [] };
    },
    async close() {},
  };
}

/**
 * The Desktop capability is the only readiness under test here, so Connector and Extension are
 * stubbed ready. That keeps a blocked Desktop reason attributable to the Desktop check alone.
 */
function readyConnector(): ChatGPTConnectorDiagnostic {
  return {
    ok: true,
    workspace_id: "workspace-a",
    workspace_name: "Workspace A",
    remote: {
      ready: true,
      mcp_url: "https://mcp.example.test/mcp",
      readiness: { attempts: 1, timeline: [], final_state: "ready" },
    },
    oauth: {
      ready: true,
      pkce_s256: true,
      dynamic_registration: true,
      refresh_token: true,
      migration: "not_needed",
      reauthorization_required: false,
    },
    connector: {
      name: "Workspace A",
      status: "verified",
      action: "none",
      mcp_url: "https://mcp.example.test/mcp",
      verified_mcp_url: "https://mcp.example.test/mcp",
      reason: "verified_endpoint_matches",
    },
    pages: {
      plugins: "https://chatgpt.com/admin/plugins",
      create_connector: "https://chatgpt.com/gpts/editor",
    },
  };
}

function preflightService(
  interactivePreflight: DesktopInteractivePreflight,
  options: {
    readonly desktopReadyTimeoutMs?: number;
    readonly wait?: (milliseconds: number) => Promise<void>;
  } = {},
): GoalPreflightService {
  return new GoalPreflightService({
    settings: settings("C:\\workspace"),
    registry: { active: { id: "workspace-a" }, resolve: () => ({ id: "workspace-a" }) },
    runtimeReady: () => true,
    desktopReadiness: () => interactivePreflight.check(),
    diagnoseConnector: async () => readyConnector(),
    extensionReadiness: async () => ({
      ready: true,
      bridge_available: true,
      extension_paired: true,
      readiness_state: "ready" as const,
    }),
    extensionReadyTimeoutMs: 0,
    // The bounded Desktop capability wait is exercised in the goal-preflight unit tests; these
    // production-path tests assert the immediate fail-closed result.
    desktopReadyTimeoutMs: options.desktopReadyTimeoutMs ?? 0,
    wait: options.wait,
  });
}

interface ProductionFixture {
  readonly preflight: GoalPreflightService;
  readonly submission: GoalSubmissionService;
  readonly createGoal: ReturnType<typeof vi.fn>;
  readonly startGoal: ReturnType<typeof vi.fn>;
}

function productionFixture(options: {
  readonly state: () => DesktopSyncState;
  readonly environment: NodeJS.ProcessEnv;
  readonly handoff?: DesktopToolsPipeHandoff;
  readonly desktopReadyTimeoutMs?: number;
  readonly desktopWait?: (milliseconds: number) => Promise<void>;
}): ProductionFixture {
  const handoff = options.handoff ?? new DesktopToolsPipeHandoff();
  const interactivePreflight = new DesktopInteractivePreflight(
    handoff,
    options.state,
    { environment: options.environment },
  );
  const preflight = preflightService(interactivePreflight, {
    desktopReadyTimeoutMs: options.desktopReadyTimeoutMs,
    wait: options.desktopWait,
  });
  const createGoal = vi.fn(async () => ({ goal_id: "goal-1" }));
  const startGoal = vi.fn(async () => ({
    goal_id: "goal-1",
    status: "running",
    execution_id: "execution-1",
  }));
  const submission = new GoalSubmissionService(
    { createGoal, startGoal } as never,
    preflight,
  );
  return { preflight, submission, createGoal, startGoal };
}

function interactiveRequest() {
  return {
    workspace_id: "workspace-a",
    conversation_id: "conversation-1",
    title: "Interactive Desktop Goal",
    goal: "Run the Desktop Goal.",
    requirements: ["Use the Desktop route."],
    acceptance_criteria: ["The Desktop route starts once."],
    execution_mode: "interactive" as const,
  };
}

describe("production interactive Desktop preflight", () => {
  it("fails closed with a queryable reason and creates no Goal when no pipe source exists", async () => {
    const fixture = productionFixture({ state: () => connectedState(), environment: {} });

    const error = await fixture.submission.submitGoal(interactiveRequest())
      .then(() => null, (value: unknown) => value);
    expect(error).toBeInstanceOf(GoalPreflightError);
    expect((error as GoalPreflightError).result).toMatchObject({
      ready: false,
      failure_stage: "desktop",
      failure_reason: expect.stringContaining("desktop_tools_pipe_unavailable"),
      desktop: { ready: false, reason: "desktop_tools_pipe_unavailable" },
    });
    // No Goal, Task, Session, or Execution may exist for a blocked capability.
    expect(fixture.createGoal).not.toHaveBeenCalled();
    expect(fixture.startGoal).not.toHaveBeenCalled();
  });

  it("waits for a SessionStart handoff that arrives after submit_goal and starts the Goal", async () => {
    const handoff = new DesktopToolsPipeHandoff();
    let ticks = 0;
    const fixture = productionFixture({
      state: () => connectedState(),
      environment: {},
      handoff,
      desktopReadyTimeoutMs: 30_000,
      // The capability is handed off while the preflight is already waiting for it.
      desktopWait: async () => {
        ticks += 1;
        if (ticks === 2) handoff.accept(HANDOFF_PIPE, OWNER);
      },
    });

    await expect(fixture.submission.submitGoal(interactiveRequest())).resolves.toMatchObject({
      goal_id: "goal-1",
      execution_id: "execution-1",
    });
    expect(ticks).toBeGreaterThan(1);
    expect(fixture.createGoal).toHaveBeenCalledTimes(1);
    expect(fixture.startGoal).toHaveBeenCalledTimes(1);
  });

  it("reports the host environment source when the LRM process already holds the pipe", async () => {
    const fixture = productionFixture({
      state: () => connectedState(),
      environment: { CODEX_APP_TOOLS_PIPE_PATH: HOST_ENV_PIPE },
    });

    const ready = await fixture.preflight.checkGoalPreflight({
      workspace_id: "workspace-a",
      conversation_id: "conversation-1",
      execution_mode: "interactive",
    });
    expect(ready).toMatchObject({
      ready: true,
      desktop: { ready: true, pipe_source: "current_environment" },
    });
  });

  it("prefers an accepted handoff over the host environment", async () => {
    const handoff = new DesktopToolsPipeHandoff();
    handoff.accept(HANDOFF_PIPE, OWNER);
    const interactivePreflight = new DesktopInteractivePreflight(
      handoff,
      () => connectedState(),
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: HOST_ENV_PIPE } },
    );
    const preflight = preflightService(interactivePreflight);

    await expect(preflight.checkGoalPreflight({
      workspace_id: "workspace-a",
      conversation_id: "conversation-1",
      execution_mode: "interactive",
    })).resolves.toMatchObject({
      ready: true,
      desktop: { ready: true, pipe_source: "handoff" },
    });
  });

  it("exposes the blocked reason over the loopback launcher endpoint", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-desktop-preflight-"));
    temporaryDirectories.push(workspace);
    const handoff = new DesktopToolsPipeHandoff();
    const interactivePreflight = new DesktopInteractivePreflight(
      handoff,
      () => connectedState(),
      { environment: {} },
    );
    const server = createHttpServer(settings(workspace), {
      registry: new WorkspaceRegistry([{ id: "workspace-a", name: "Workspace A", path: workspace }]),
      desktopSyncObserver: { getState: () => connectedState() },
      desktopToolsPipeHandoff: handoff,
      desktopCodexRuntimeFactory: new DesktopCodexRuntimeFactory(
        handoff,
        () => connectedState(),
        async () => fakeRuntime(),
        { environment: {} },
      ),
      desktopInteractivePreflight: () => interactivePreflight.check(),
    });
    runningServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/launcher/desktop-interactive`,
      { headers: { authorization: "Bearer test-token" } },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({
      ready: false,
      reason: "desktop_tools_pipe_unavailable",
      pipeSource: null,
      pipeState: "unavailable",
    });
    expect(JSON.stringify(body)).not.toContain(PIPE_PREFIX);

    // The pipe handoff endpoint stays the only acquisition seam; the probe endpoint must not be
    // reachable as a capability substitute here.
    const handoffResponse = await fetch(
      `http://127.0.0.1:${address.port}${LAUNCHER_DESKTOP_TOOLS_PIPE_PATH}`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ pipePath: HANDOFF_PIPE }),
      },
    );
    expect(handoffResponse.status).toBe(200);
    const afterHandoff = await fetch(
      `http://127.0.0.1:${address.port}/launcher/desktop-interactive`,
      { headers: { authorization: "Bearer test-token" } },
    );
    await expect(afterHandoff.json()).resolves.toEqual({
      ready: true,
      reason: null,
      pipeSource: "handoff",
      pipeState: "active",
    });
  });
});
