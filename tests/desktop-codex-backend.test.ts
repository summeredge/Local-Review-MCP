import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolRequestParams, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliExecutionBackend,
  ExecutionBackendRouter,
  ExecutionService,
  ExecutionLaunchIndeterminateError,
  type ExecutionBackend,
  type ExecutionBackendStartRequest,
  type ExecutionStartResult,
} from "../src/control-plane/execution-service.js";
import {
  ActuationAuthorizationStore,
  ControlledActuationService,
  type ActuationAuthorizationInput,
} from "../src/control-plane/controlled-actuation.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { SessionStore } from "../src/context/session-store.js";
import { sessionFile } from "../src/context/session.js";
import { TaskContextService } from "../src/context/service.js";
import { EventStore, eventsFile } from "../src/control-plane/events/store.js";
import { DesktopCodexBackend } from "../src/desktop-codex/desktop-codex-backend.js";
import { CodexAppRuntimeError } from "../src/desktop-codex/codex-app-runtime.js";
import { CapabilityNegotiator } from "../src/control-plane/capability-negotiation.js";
import { DesktopThreadBindingStore } from "../src/desktop-codex/desktop-thread-binding-store.js";
import { DesktopToolsPipeHandoff } from "../src/desktop-codex/desktop-tools-pipe-handoff.js";
import {
  DesktopCodexRuntimeFactory,
  type DesktopCodexRuntimeLike,
  type DesktopCodexRuntimeProvider,
} from "../src/desktop-codex/desktop-tools-pipe-probe.js";
import type { DesktopSyncState } from "../src/desktop-sync/desktop-sync-state.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import type { ExecutionContext } from "../src/context/types.js";
import { AutoIterationService, AutoIterationStore } from "../src/control-plane/auto-iteration.js";
import { GoalOrchestrationService } from "../src/control-plane/goal-orchestration.js";
import { StatusQueryService } from "../src/control-plane/status-query.js";
import { BrowserRouter } from "../src/router/browser-router.js";
import { ReviewCompletionRouter } from "../src/router/review-completion-router.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { GoalSubmissionService } from "../src/control-plane/goal-submission.js";
import { PendingGoalSubmissionService } from "../src/control-plane/pending-goal-submission.js";
import { ConversationCorrelationRegistry } from "../src/control-plane/conversation-correlation.js";
import { DesktopCompletionObserver } from "../src/desktop-codex/completion-observer.js";
import { ExecutionRoutingService } from "../src/control-plane/execution-routing.js";

/**
 * P5.4.1 acceptance tests for the Desktop codex_app production interactive route.
 *
 * Every test drives the real ExecutionBackendRouter/ExecutionService and the real
 * ControlledActuationService. Only the Desktop MCP transport is faked, so the tests prove routing,
 * preflight, durability, and terminal ordering rather than the transport itself.
 */

const syncRoots: string[] = [];

afterEach(() => {
  for (const directory of syncRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lrm-p541-"));
  syncRoots.push(root);
  return root;
}

/**
 * The Desktop list_projects fixture must report the exact canonical workspace path. Tests either
 * supply it explicitly (to exercise resolver failures) or let the fixture bind it to its own
 * temporary workspace root.
 */
const OTHER_WORKSPACE_PATH = "C:\\work\\project";

function desktopTools(): Tool[] {
  return [
    { name: "list_projects", inputSchema: { type: "object", properties: {} } },
    { name: "send_message_to_thread", inputSchema: { type: "object", properties: {
      threadId: { type: "string" }, hostId: { type: "string" }, prompt: { type: "string" },
    }, required: ["threadId", "hostId", "prompt"] } },
    {
      name: "create_thread",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          model: { type: "string" },
          thinking: {
            type: "string",
            enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
          },
          target: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["project"] },
              projectId: { type: "string" },
              environment: {
                type: "object",
                properties: { type: { type: "string", enum: ["local"] } },
                required: ["type"],
              },
            },
            required: ["type", "projectId", "environment"],
          },
        },
        required: ["prompt", "target"],
      },
    },
    {
      name: "send_message_to_thread",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          hostId: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["threadId", "hostId", "prompt"],
      },
    },
    {
      name: "read_thread",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          hostId: { type: "string" },
          turnLimit: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["threadId"],
      },
    },
    {
      name: "wait_threads",
      inputSchema: {
        type: "object",
        properties: {
          targets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                threadId: { type: "string" },
                hostId: { type: "string" },
                afterCursor: { type: "string" },
              },
              required: ["threadId"],
            },
          },
          timeoutMs: { type: "integer", minimum: 0, maximum: 120000 },
        },
        required: ["targets"],
      },
    },
  ];
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

interface FakeDesktop {
  readonly calls: CallToolRequestParams[];
  readonly createThreadCount: () => number;
  readonly sendCount: () => number;
  readonly runtimeCloseCount: () => number;
  readonly runtime: DesktopCodexRuntimeLike & { readonly mcpClient: { callTool(params: CallToolRequestParams): Promise<CallToolResult> } };
  readonly runtimeFactory: { connect(): Promise<DesktopCodexRuntimeLike> };
  setTurns(turns: readonly Turn[]): void;
  setListTools(tools: readonly Tool[]): void;
  setProjectPath(path: string): void;
  failConnect(error: Error): void;
  /** Make the next N read_thread calls return CallToolResult.isError === true. */
  setReadErrors(count: number): void;
}

interface Turn {
  readonly id: string;
  readonly status: string;
  readonly error?: unknown;
  readonly startedAt?: number;
  readonly completedAt: number | null;
  readonly durationMs?: number | null;
  readonly items?: readonly unknown[];
}

function fakeDesktop(options: {
  readonly threadId?: string;
  readonly hostId?: string;
  readonly turns?: readonly Turn[];
  readonly projectPath?: string;
  readonly uniqueThreads?: boolean;
  readonly turnLimit?: number;
} = {}): FakeDesktop {
  const threadId = options.threadId ?? "target-thread-1";
  const hostId = options.hostId ?? "local";
  const calls: CallToolRequestParams[] = [];
  let turns: readonly Turn[] = options.turns ?? [];
  let tools: readonly Tool[] = desktopTools();
  let projectPath = options.projectPath ?? OTHER_WORKSPACE_PATH;
  let connectError: Error | undefined;
  let runtimeCloses = 0;
  let readErrors = 0;

  const client = {
    callTool: async (params: CallToolRequestParams): Promise<CallToolResult> => {
      calls.push(params);
      switch (params.name) {
        case "list_projects":
          return jsonResult({
            projects: [{
              projectId: "project-1",
              hostId: "local",
              projectKind: "local",
              path: projectPath,
            }],
          });
        case "create_thread":
          return jsonResult({ threadId: options.uniqueThreads
            ? `${threadId}-${calls.filter((call) => call.name === "create_thread").length}` : threadId, hostId });
        case "send_message_to_thread":
          return jsonResult({ ok: true });
        case "read_thread":
          if (readErrors > 0) {
            readErrors -= 1;
            return { isError: true, content: [{ type: "text", text: "thread is not visible yet" }] };
          }
          return jsonResult({
            thread: { id: options.uniqueThreads ? params.arguments?.threadId : threadId,
              hostId, status: { type: "idle" } },
            turns: (options.turnLimit === undefined ? turns : turns.slice(-options.turnLimit)).map((turn) => ({
              error: null,
              startedAt: 1,
              durationMs: turn.status === "completed" ? 1 : null,
              items: [],
              ...turn,
            })),
          });
        case "wait_threads":
          return jsonResult({ timedOut: false, polls: [] });
        default:
          return jsonResult({ ok: true });
      }
    },
  };

  const runtime = {
    info: {
      desktopDetected: true,
      bundleDetected: true,
      mcpTransport: "stdio" as const,
      nativeDesktopTransport: "windows_named_pipe" as const,
    },
    listTools: async () => ({ tools: tools as never }),
    close: async () => { runtimeCloses += 1; },
    mcpClient: client,
  };

  return {
    calls,
    createThreadCount: () => calls.filter((call) => call.name === "create_thread").length,
    sendCount: () => calls.filter((call) => call.name === "send_message_to_thread").length,
    runtimeCloseCount: () => runtimeCloses,
    runtime,
    runtimeFactory: {
      connect: async () => {
        if (connectError !== undefined) throw connectError;
        return runtime as DesktopCodexRuntimeLike;
      },
    },
    setTurns: (value) => { turns = value; },
    setListTools: (value) => { tools = value; },
    failConnect: (error) => { connectError = error; },
    setProjectPath: (value) => { projectPath = value; },
    setReadErrors: (count) => { readErrors = count; },
  };
}

function desktopState(overrides: Partial<DesktopSyncState> = {}): DesktopSyncState {
  return {
    connected: true,
    currentConversationId: "executor-conversation-1",
    followingThreads: new Set<string>(),
    ownerClientId: "owner-1",
    ...overrides,
  };
}

interface Fixture {
  readonly root: string;
  readonly registry: WorkspaceRegistry;
  readonly sessions: SessionStore;
  readonly executions: ExecutionContextService;
  readonly events: EventStore;
  readonly service: ExecutionService;
  readonly controlled: ControlledActuationService;
  readonly appServerStart: ReturnType<typeof vi.fn>;
  readonly cliStart: ReturnType<typeof vi.fn>;
  readonly desktop: FakeDesktop;
  readonly terminals: ExecutionContext[];
  readonly backend: DesktopCodexBackend;
}

async function fixture(options: {
  // A supplied Desktop keeps its project path unless projectPath overrides it; positive tests use
  // desktop.setProjectPath(value.registry.active.manager.canonicalRoot) after fixture creation.
  readonly desktop?: FakeDesktop;
  readonly state?: () => DesktopSyncState;
  readonly projectPath?: string;
  readonly runtimeFactory?: DesktopCodexRuntimeProvider;
  readonly openDesktopThread?: (url: string) => Promise<void>;
  readonly completionTimeoutMs?: number;
  readonly pollIntervalMs?: number;
} = {}): Promise<Fixture> {
  const root = createRoot();
  const workspaceRoot = mkdtempSync(join(tmpdir(), "lrm-p541-ws-"));
  syncRoots.push(workspaceRoot);
  const registry = new WorkspaceRegistry([{ id: "workspace-a", name: "Workspace A", path: workspaceRoot }]);
  const tasks = new TaskContextService(root);
  const executions = new ExecutionContextService(root);
  const sessions = new SessionStore(root);
  const events = new EventStore(root);
  const desktop = options.desktop ?? fakeDesktop();
  const terminals: ExecutionContext[] = [];
  // Bind the Desktop project record to this fixture's real workspace root for an exact match,
  // unless the test explicitly wants a different path to exercise the resolver.
  if (options.projectPath !== undefined) desktop.setProjectPath(options.projectPath);
  else if (options.desktop === undefined) desktop.setProjectPath(registry.active.manager.canonicalRoot);

  const cliStart = vi.fn(async (
    input: ExecutionBackendStartRequest,
  ): Promise<ExecutionStartResult & { readonly process_id: number }> => {
    const execution = await executions.createExecutionContext({
      execution_id: input.execution_id,
      task_id: input.task_id,
      workspace_id: input.workspace_id,
      process_id: 9_002,
      command: "codex exec --json -",
    });
    return {
      execution_id: execution.execution_id,
      process_id: 9_002,
      started_at: execution.started_at,
      accepted: "new",
    };
  });

  // The private app-server backend must never start on the production interactive route.
  const appServerStart = vi.fn(async (): Promise<ExecutionStartResult> => {
    throw new Error("CodexAppServerBackend must not start for the production interactive route");
  });

  const desktopBackend = new DesktopCodexBackend(registry, {
    storageRoot: root,
    eventStore: events,
    runtimeFactory: options.runtimeFactory ?? desktop.runtimeFactory,
    desktopState: options.state ?? (() => desktopState()),
    completionTimeoutMs: options.completionTimeoutMs ?? 1_500,
    pollIntervalMs: options.pollIntervalMs ?? 1,
    openDesktopThread: options.openDesktopThread ?? vi.fn(async () => undefined),
  });

  const router = new ExecutionBackendRouter({
    batch: new CliExecutionBackend({ start: cliStart }),
    interactive: desktopBackend,
  });
  const service = new ExecutionService(router);
  service.setTerminalListener((execution) => { terminals.push(execution); });

  const authorizations = new ActuationAuthorizationStore(root);
  const controlled = new ControlledActuationService(registry, {
    storageRoot: root,
    authorizationStore: authorizations,
    taskContextService: tasks,
    executionContextService: executions,
    adapter: service,
  });

  return {
    root,
    registry,
    sessions,
    executions,
    events,
    service,
    controlled,
    appServerStart,
    cliStart,
    desktop,
    terminals,
    backend: desktopBackend,
  };
}

const GOAL_ID = "goal-1";
const TASK_ID = "task-1";
const EXECUTION_ID = "execution-1";
const ACTUATION_ID = "actuation-1";

describe("Desktop Execution status checks and manual resolution", () => {
  it.each(["check", "close"] as const)("converges Goal, Task and Review Loop through existing terminal notifications: %s", async action => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);
    const review = vi.fn(async request => ({ status: "COMPLETED" as const,
      content: `<lrm-review-result>${JSON.stringify({ schema_version: 1, review_request_id: request.review_request_id,
        decision: "APPROVE", summary: "Reviewed" })}</lrm-review-result>` }));
    const auto = new AutoIterationService(value.registry, { storageRoot: value.root, controlledActuation: value.controlled,
      browserRouter: new BrowserRouter(value.root, { deliver: async () => ({ status: "delivered", delivered_at: new Date().toISOString() }) }),
      completionRouter: new ReviewCompletionRouter(value.root, { collect: review }) });
    const goals = new GoalOrchestrationService(value.registry, { storageRoot: value.root,
      controlledActuation: value.controlled, autoIteration: auto });
    auto.setTerminalListener(loop => goals.onAutoIterationTerminal(loop));
    const restarted = new DesktopCodexBackend(value.registry, { storageRoot: value.root, runtimeFactory: value.desktop.runtimeFactory });
    const routing = new ExecutionRoutingService(value.registry, { storageRoot: value.root, autoIteration: auto, goalOrchestration: goals });
    restarted.setTerminalListener(execution => routing.onExecutionTerminal(execution));
    try {
      await goals.createGoal({ goal_id: GOAL_ID, workspace_id: "workspace-a", conversation_id: "conversation-1",
        execution_mode: "interactive", phases: [{ phase_id: "phase-1", objective: "Implement", tasks: [{
          task_id: TASK_ID, goal: "Fix the change", requirements: ["Keep it small"], acceptance_criteria: ["Tests pass"], max_iterations: 2,
        }] }] });
      const goal = await goals.startGoal({ goal_id: GOAL_ID });
      const session = (await value.sessions.listSessions())[0]!;
      await vi.waitFor(async () => expect((await value.events.listEvents(session.session_id))
        .some(event => event.event_type === "turn_started")).toBe(true));
      await value.backend.close();
      value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
      const input = { action, workspace_id: "workspace-a", task_id: TASK_ID, execution_id: goal.execution_id!,
        session_id: session.session_id, thread_id: session.thread_id!, turn_id: "turn-1",
        ...(action === "close" ? { outcome: "completed" as const, confirmed: true as const, note: "人工确认" } : {}) };
      await restarted.executionAction(input);
      await vi.waitFor(async () => expect((await goals.getGoal(GOAL_ID))?.status).toBe(action === "check" ? "completed" : "human_required"));
      expect((await new TaskContextService(value.root).getTaskContext(TASK_ID))?.status).toBe(action === "check" ? "completed" : "human_required");
      expect((await auto.getLoop(goal.loop_id!))?.stage).toBe(action === "check" ? "completed" : "human_required");
      await restarted.executionAction(input);
      await restarted.reconcileOrphanedExecutions();
      await auto.recover();
      await goals.recover();
      expect(review).toHaveBeenCalledTimes(action === "check" ? 1 : 0);
      const rows = await new StatusQueryService({ storageRoot: value.root, goals }).listExecutionSummaries();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: action === "check" ? "passed" : "terminated", turn_id: "turn-1" });
      if (action === "close") expect(rows[0]?.manual_resolution?.outcome).toBe("completed");
      expect(value.desktop.createThreadCount()).toBe(1);
    } finally { goals.dispose(); auto.dispose(); await restarted.close(); await value.backend.close(); }
  });

  async function suspended() {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);
    await authorizeAndActuate(value, {}, "launch");
    const session = (await value.sessions.listSessions())[0]!;
    await vi.waitFor(async () => expect((await value.events.listEvents(session.session_id))
      .some(event => event.event_type === "turn_started")).toBe(true));
    await value.backend.close();
    const restarted = new DesktopCodexBackend(value.registry, { storageRoot: value.root,
      runtimeFactory: value.desktop.runtimeFactory,
      desktopState: () => desktopState({ currentConversationId: "unrelated-foreground" }) });
    const notified = vi.fn(async () => undefined);
    restarted.setTerminalListener(notified);
    const identity = { workspace_id: "workspace-a", task_id: TASK_ID, execution_id: EXECUTION_ID,
      session_id: session.session_id, thread_id: session.thread_id!, turn_id: "turn-1" };
    return { value, session, restarted, notified, identity };
  }

  it.each(["completed", "failed", "inProgress"])("checks only the durable original Turn after restart: %s", async status => {
    const f = await suspended();
    try {
      f.value.desktop.setTurns([{ id: "turn-1", status, completedAt: status === "inProgress" ? null : 1 },
        { id: "turn-2", status: "completed", completedAt: 2 }]);
      const result = await f.restarted.executionAction({ ...f.identity, action: "check" });
      expect(result.execution.status).toBe(status === "completed" ? "passed" : status === "failed" ? "failed" : "running");
      expect(f.value.desktop.calls.filter(call => call.name === "read_thread").at(-1)?._meta?.["openai/threadId"])
        .toBe("executor-conversation-1");
      await f.restarted.executionAction({ ...f.identity, action: "check" });
      expect(f.notified).toHaveBeenCalledTimes(status === "inProgress" ? 0 : 1);
      expect((await f.value.sessions.getSession(f.session.session_id))?.status)
        .toBe(status === "completed" ? "completed" : status === "failed" ? "failed" : "active");
      expect((await f.value.events.listEvents(f.session.session_id)).filter(event => event.event_type === "turn_completed"))
        .toHaveLength(status === "completed" ? 1 : 0);
      expect(f.value.desktop.createThreadCount()).toBe(1);
      expect(f.value.desktop.sendCount()).toBe(0);
    } finally { await f.restarted.close(); }
  });

  it("restores a background observer using the original durable executor", async () => {
    const f = await suspended();
    try {
      f.value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
      await Promise.all([f.restarted.reconcileOrphanedExecutions(), f.restarted.reconcileOrphanedExecutions()]);
      await f.restarted.whenIdle();
      expect((await f.value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))?.status).toBe("passed");
      expect(f.notified).toHaveBeenCalledTimes(1);
      expect(f.value.desktop.createThreadCount()).toBe(1);
    } finally { await f.restarted.close(); }
  });

  it("preserves running and the precise diagnostic when executor identity is unavailable", async () => {
    const f = await suspended();
    try {
      const binding = (await new DesktopThreadBindingStore(f.value.root).load("workspace-a", f.session.session_id))!;
      const { executor_thread_id: _executor, ...legacy } = binding;
      await writeFile(join(f.value.root, ".task", "desktop_thread_bindings", "workspace-a", f.session.session_id + ".json"), JSON.stringify(legacy));
      expect(await f.restarted.executionAction({ ...f.identity, action: "check" }))
        .toMatchObject({ reason: "executor_identity_unavailable", execution: { status: "running", summary: expect.stringContaining("manual_confirmation_required") } });
      expect(f.notified).not.toHaveBeenCalled();
      expect(f.value.desktop.createThreadCount()).toBe(1);
    } finally { await f.restarted.close(); }
  });

  it("does not let duplicate checks or a manual close overwrite a trusted terminal", async () => {
    const f = await suspended();
    try {
      f.value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
      await Promise.all([f.restarted.executionAction({ ...f.identity, action: "check" }),
        f.restarted.executionAction({ ...f.identity, action: "check" })]);
      const closed = await f.restarted.executionAction({ ...f.identity, action: "close", confirmed: true, outcome: "unknown" });
      expect(closed.execution).toMatchObject({ status: "passed" });
      expect(closed.execution.manual_resolution).toBeUndefined();
      expect(f.notified).toHaveBeenCalledTimes(1);
      expect((await f.value.events.listEvents(f.session.session_id)).filter(event => event.event_type === "turn_completed")).toHaveLength(1);
    } finally { await f.restarted.close(); }
  });

  it("persists manual resolution once and defeats a late original provider completion", async () => {
    const f = await suspended();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let readStarted = false;
    const original = f.value.desktop.runtime.mcpClient.callTool;
    f.value.desktop.runtime.mcpClient.callTool = async params => {
      if (params.name === "read_thread") { readStarted = true; await gate; }
      return original(params);
    };
    try {
      f.value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
      const checking = f.restarted.executionAction({ ...f.identity, action: "check" });
      await vi.waitFor(() => expect(readStarted).toBe(true));
      const close = { ...f.identity, action: "close" as const, outcome: "completed" as const, confirmed: true as const, note: "工程师人工确认" };
      const [first, repeated] = await Promise.all([f.restarted.executionAction(close), f.restarted.executionAction(close)]);
      expect(repeated.execution.manual_resolution).toEqual(first.execution.manual_resolution);
      release();
      expect((await checking).execution.status).toBe("terminated");
      expect((await f.value.sessions.getSession(f.session.session_id))?.status).toBe("terminated");
      expect(first.execution.manual_resolution).toMatchObject({ outcome: "completed", note: "工程师人工确认",
        session_id: f.session.session_id, thread_id: f.session.thread_id, turn_id: "turn-1",
        monitoring_summary: expect.stringContaining("runtime_closed") });
      expect(f.notified).toHaveBeenCalledTimes(1);
      expect((await f.value.events.listEvents(f.session.session_id)).some(event => ["turn_completed", "execution_failed"].includes(event.event_type))).toBe(false);
      await expect(f.restarted.executionAction({ ...close, thread_id: "foreign-thread" })).rejects.toMatchObject({ code: "desktop_target_conflict" });
      await f.restarted.close();
      const restartedAgain = new DesktopCodexBackend(f.value.registry, { storageRoot: f.value.root,
        runtimeFactory: { connect: async () => { throw new Error("must not reconnect closed records"); } } });
      try {
        await restartedAgain.reconcileOrphanedExecutions();
        expect((await restartedAgain.executionAction(close)).execution.manual_resolution).toEqual(first.execution.manual_resolution);
        expect(await f.value.executions.listExecutions("workspace-a", TASK_ID)).toHaveLength(1);
      } finally { await restartedAgain.close(); }
    } finally { release(); await f.restarted.close(); }
  });

  it.each(["legacy", "corrupt"])("keeps the catalog and manual close usable when evidence is %s", async evidence => {
    const f = await suspended();
    try {
      const eventFile = eventsFile(f.value.root, f.session.session_id);
      if (evidence === "legacy") {
        const { execution_id: _execution, ...legacy } = f.session;
        await writeFile(join(f.value.root, ".task", "sessions", f.session.session_id + ".json"), JSON.stringify(legacy));
        await writeFile(eventFile, "[]");
      } else await writeFile(eventFile, "{broken events");
      const rows = await new StatusQueryService({ storageRoot: f.value.root }).listExecutionSummaries();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ execution_id: EXECUTION_ID, session_id: f.session.session_id, thread_id: f.session.thread_id });
      expect(rows[0]?.turn_id).toBeUndefined();
      if (evidence === "corrupt") expect(rows[0]?.monitoring_error).toBe("event_store_unavailable");
      const identity = { ...f.identity, turn_id: undefined };
      const checked = await f.restarted.executionAction({ ...identity, action: "check" });
      expect(checked.execution.status).toBe("running");
      expect(checked.reason).toBe(evidence === "corrupt" ? "event_store_unavailable" : "execution_not_recoverable");
      const closed = await f.restarted.executionAction({
        ...(evidence === "corrupt" ? f.identity : identity), action: "close", outcome: "unknown", confirmed: true,
      });
      expect(closed.execution.status).toBe("terminated");
      expect(closed.execution.manual_resolution?.turn_id).toBeUndefined();
      if (evidence === "corrupt") expect(closed.execution.manual_resolution?.evidence_error).toBe("event_store_unavailable");
      expect((await f.value.sessions.getSession(f.session.session_id))?.status).toBe("terminated");
      expect(await readFile(eventFile, "utf8")).toBe(evidence === "corrupt" ? "{broken events" : "[]");
      await f.restarted.executionAction({ ...identity, action: "close", outcome: "unknown", confirmed: true });
      expect(f.notified).toHaveBeenCalledTimes(1);
    } finally { await f.restarted.close(); }
  });

  it("does not use the unique legacy fallback when another execution exists", async () => {
    const f = await suspended();
    try {
      const { execution_id: _execution, ...legacy } = f.session;
      await writeFile(join(f.value.root, ".task", "sessions", f.session.session_id + ".json"), JSON.stringify(legacy));
      await writeFile(eventsFile(f.value.root, f.session.session_id), "[]");
      await f.value.executions.createExecutionContext({ workspace_id: "workspace-a", task_id: TASK_ID,
        execution_id: "execution-2", command: "desktop codex_app" });
      const rows = await new StatusQueryService({ storageRoot: f.value.root }).listExecutionSummaries();
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.session_id === undefined)).toBe(true);
      await expect(f.restarted.executionAction({ ...f.identity, turn_id: undefined, action: "close", outcome: "unknown", confirmed: true }))
        .rejects.toMatchObject({ code: "desktop_target_conflict" });
      expect((await f.value.sessions.getSession(f.session.session_id))?.status).toBe("active");
    } finally { await f.restarted.close(); }
  });

  it("retains the independently verified current Session when an unrelated legacy Session is damaged", async () => {
    const f = await suspended();
    try {
      const older = await f.value.sessions.createSession({ task_id: TASK_ID, goal_id: GOAL_ID,
        workspace: f.value.registry.active.manager.canonicalRoot, backend_type: "desktop_codex_app", status: "active", thread_id: "old-thread" });
      const oldEvents = eventsFile(f.value.root, older.session_id);
      await writeFile(oldEvents, "{broken old events");
      const rows = await new StatusQueryService({ storageRoot: f.value.root }).listExecutionSummaries();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ session_id: f.session.session_id, thread_id: f.session.thread_id, turn_id: "turn-1" });
      const closed = await f.restarted.executionAction({ ...f.identity, action: "close", outcome: "unknown", confirmed: true });
      expect(closed.execution).toMatchObject({ status: "terminated", manual_resolution: {
        session_id: f.session.session_id, thread_id: f.session.thread_id, turn_id: "turn-1" } });
      expect((await f.value.sessions.getSession(f.session.session_id))?.status).toBe("terminated");
      expect((await f.value.sessions.getSession(older.session_id))?.status).toBe("active");
      expect(await readFile(oldEvents, "utf8")).toBe("{broken old events");
      await f.restarted.reconcileOrphanedExecutions();
      expect(f.notified).toHaveBeenCalledTimes(1);
    } finally { await f.restarted.close(); }
  });

  it("does not pick a latest Session when two Sessions prove the same Execution identity", async () => {
    const f = await suspended();
    try {
      await f.value.sessions.createSession({ execution_id: EXECUTION_ID, task_id: TASK_ID, goal_id: GOAL_ID,
        workspace: f.value.registry.active.manager.canonicalRoot, backend_type: "desktop_codex_app", status: "active", thread_id: "duplicate-thread" });
      const rows = await new StatusQueryService({ storageRoot: f.value.root }).listExecutionSummaries();
      expect(rows[0]?.session_id).toBeUndefined();
      await expect(f.restarted.executionAction({ ...f.identity, action: "close", outcome: "unknown", confirmed: true }))
        .rejects.toMatchObject({ code: "desktop_target_conflict" });
      await expect(f.restarted.executionAction({ workspace_id: "workspace-a", task_id: TASK_ID, execution_id: EXECUTION_ID,
        action: "close", outcome: "unknown", confirmed: true })).rejects.toMatchObject({ code: "desktop_target_conflict" });
      expect((await f.value.sessions.getSession(f.session.session_id))?.status).toBe("active");
    } finally { await f.restarted.close(); }
  });
});
const INSTRUCTION = "Only return LRM_DESKTOP_BACKEND_PASS";

function interactiveRequest(
  overrides: Partial<ExecutionBackendStartRequest> = {},
): ExecutionBackendStartRequest {
  return {
    goal_id: GOAL_ID,
    workspace_id: "workspace-a",
    task_id: TASK_ID,
    execution_id: EXECUTION_ID,
    instruction: INSTRUCTION,
    execution_mode: "interactive",
    ...overrides,
  };
}

async function seedTask(value: Fixture): Promise<void> {
  await new TaskContextService(value.root).createTaskContext({
    task_id: TASK_ID,
    workspace_id: "workspace-a",
  });
}

async function authorizeAndActuate(
  value: Fixture,
  overrides: Partial<ActuationAuthorizationInput>,
  waitFor: "terminal" | "launch",
): Promise<void> {
  await seedTask(value);
  const authorization = await value.controlled.authorize({
    actuation_id: ACTUATION_ID,
    goal_id: GOAL_ID,
    workspace_id: "workspace-a",
    task_id: TASK_ID,
    execution_id: EXECUTION_ID,
    instruction: INSTRUCTION,
    execution_mode: "interactive",
    ...overrides,
  });
  await value.controlled.actuate({
    actuation_id: ACTUATION_ID,
    authorization_id: authorization.authorization_id,
  });
  if (waitFor === "terminal") {
    // The Desktop turn completes asynchronously through the completion observer. Wait for the
    // durable Execution terminal state so assertions observe the committed result, not a snapshot.
    await waitForTerminalExecution(value);
  }
}

async function waitForTerminalExecution(value: Fixture): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const execution = await value.executions.getExecutionContext(
      "workspace-a",
      TASK_ID,
      EXECUTION_ID,
    );
    if (execution !== null && execution.status !== "running") {
      // Wait for the backend to finish projecting terminal Session/event state too, so the test
      // never races the still-running watch against its own temporary-directory cleanup.
      await value.backend.whenIdle();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Desktop execution did not reach a terminal state");
}

describe("P5.4.1 route selection", () => {
  it("continues on the original thread when the first Turn is outside the latest ten Turns", async () => {
    const desktop = fakeDesktop({ turnLimit: 10 });
    let foregroundConversationId = "executor-conversation-1";
    const value = await fixture({ desktop,
      state: () => desktopState({ currentConversationId: foregroundConversationId }) });
    desktop.setProjectPath(value.registry.active.manager.canonicalRoot);
    try {
      await seedTask(value);
      desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
      const first = await value.backend.start(interactiveRequest());
      await value.backend.whenIdle();
      foregroundConversationId = first.thread_id!;
      const history = Array.from({ length: 12 }, (_, index) => ({
        id: `turn-${index + 1}`, status: "completed", completedAt: index + 1,
      }));
      desktop.setTurns(history);
      const now = new Date().toISOString();
      await new AutoIterationStore(value.root).put({ loop_id: "reuse-loop", workspace_id: "workspace-a",
        task_id: TASK_ID, conversation_id: "conversation-1", initial_execution_id: EXECUTION_ID,
        execution_id: "execution-2", iteration: 2, max_iterations: 3, stage: "execution",
        created_at: now, updated_at: now });
      const readsBefore = desktop.calls.filter(call => call.name === "read_thread").length;
      const second = await value.backend.start(interactiveRequest({ execution_id: "execution-2" }));
      await vi.waitFor(() => expect(desktop.calls.filter(call => call.name === "read_thread").length)
        .toBeGreaterThan(readsBefore + 1));
      expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, "execution-2"))?.status).toBe("running");
      expect((await value.events.listEvents(second.session_id!)).some(event => event.event_type === "turn_completed")).toBe(false);
      expect(second.thread_id).toBe(first.thread_id);
      expect(second.session_id).not.toBe(first.session_id);
      expect(desktop.createThreadCount()).toBe(1);
      expect(desktop.sendCount()).toBe(1);
      expect(desktop.calls.find(call => call.name === "send_message_to_thread")?._meta)
        .toMatchObject({ "openai/threadId": "executor-conversation-1" });
      expect(desktop.calls.filter(call => call.name === "read_thread").every(call => call.arguments?.turnLimit === 10)).toBe(true);

      desktop.setTurns([...history, { id: "turn-13", status: "inProgress", completedAt: null }]);
      await vi.waitFor(async () => expect((await value.events.listEvents(second.session_id!))
        .some(event => event.event_type === "turn_started" && event.turn_id === "turn-13")).toBe(true));
      expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, "execution-2"))?.status).toBe("running");
      desktop.setTurns([...history, { id: "turn-13", status: "completed", completedAt: 13 }]);
      await value.backend.whenIdle();
      expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, "execution-2"))?.status).toBe("passed");
      expect((await value.events.listEvents(second.session_id!)).filter(event => event.event_type === "turn_completed"))
        .toEqual([expect.objectContaining({ execution_id: "execution-2", thread_id: first.thread_id, turn_id: "turn-13" })]);
    } finally { await value.service.close(); }
  });

  it.each(["known-turn", "unknown-turn", "uncertain-send"])("recovers continuation without resending: %s", async recovery => {
    const value = await fixture();
    let restarted: DesktopCodexBackend | undefined;
    try {
      await seedTask(value);
      const history = { id: "turn-1", status: "completed", completedAt: 1 };
      value.desktop.setTurns([history]);
      await value.backend.start(interactiveRequest());
      await value.backend.whenIdle();
      const now = new Date().toISOString();
      await new AutoIterationStore(value.root).put({ loop_id: "reuse-loop", workspace_id: "workspace-a",
        task_id: TASK_ID, conversation_id: "conversation-1", initial_execution_id: EXECUTION_ID,
        execution_id: "execution-2", iteration: 2, max_iterations: 3, stage: "execution",
        created_at: now, updated_at: now });
      const request = interactiveRequest({ execution_id: "execution-2" });
      if (recovery === "uncertain-send") {
        const call = value.desktop.runtime.mcpClient.callTool;
        vi.spyOn(value.desktop.runtime.mcpClient, "callTool").mockImplementation(async params => {
          const result = await call(params);
          if (params.name === "send_message_to_thread") throw new CodexAppRuntimeError("transport_failed", "lost acknowledgement");
          return result;
        });
        await expect(value.backend.start(request)).rejects.toBeInstanceOf(ExecutionLaunchIndeterminateError);
      } else {
        await value.backend.start(request);
      }
      const session = (await value.sessions.listSessions()).find(candidate => candidate.execution_id === "execution-2")!;
      if (recovery === "known-turn") {
        value.desktop.setTurns([history, { id: "turn-2", status: "inProgress", completedAt: null }]);
        await vi.waitFor(async () => expect((await value.events.listEvents(session.session_id))
          .some(event => event.event_type === "turn_started" && event.turn_id === "turn-2")).toBe(true));
      }
      await value.backend.close();
      restarted = new DesktopCodexBackend(value.registry, { storageRoot: value.root,
        runtimeFactory: value.desktop.runtimeFactory, desktopState: () => desktopState(),
        openDesktopThread: async () => undefined, pollIntervalMs: 5 });
      await Promise.all([restarted.start(request), restarted.start(request)]);
      if (recovery === "known-turn") {
        value.desktop.setTurns([history, { id: "turn-2", status: "completed", completedAt: 2 }]);
        await restarted.whenIdle();
        expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, "execution-2"))?.status).toBe("passed");
      } else {
        expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, "execution-2"))?.status).toBe("running");
        expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, "execution-2"))?.summary)
          .toContain("manual_confirmation_required");
      }
      expect(value.desktop.sendCount()).toBe(1);
      expect(value.desktop.createThreadCount()).toBe(1);
    } finally { await restarted?.close(); await value.service.close(); }
  });

  it.each(["host", "thread", "goal", "missing", "missing-completion"])("refuses continuation with invalid %s evidence", async fault => {
    const value = await fixture();
    try {
      await seedTask(value);
      value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
      const first = await value.backend.start(interactiveRequest());
      await value.backend.whenIdle();
      const now = new Date().toISOString();
      await new AutoIterationStore(value.root).put({ loop_id: "reuse-loop", workspace_id: "workspace-a",
        task_id: TASK_ID, conversation_id: "conversation-1", initial_execution_id: EXECUTION_ID,
        execution_id: "execution-2", iteration: 2, max_iterations: 3, stage: "execution",
        created_at: now, updated_at: now });
      const file = join(value.root, ".task", "desktop_thread_bindings", "workspace-a", first.session_id! + ".json");
      const binding = (await new DesktopThreadBindingStore(value.root).load("workspace-a", first.session_id!))!;
      if (fault === "host") await writeFile(file, JSON.stringify({ ...binding, host_id: "other-host" }));
      if (fault === "thread") await writeFile(file, JSON.stringify({ ...binding, target_thread_id: "other-thread" }));
      if (fault === "goal") await writeFile(sessionFile(value.root, first.session_id!), JSON.stringify({
        ...(await value.sessions.getSession(first.session_id!)), goal_id: "other-goal",
      }));
      if (fault === "missing") await writeFile(file, "{}");
      if (fault === "missing-completion") await writeFile(eventsFile(value.root, first.session_id!), "[]");
      await expect(value.backend.start(interactiveRequest({ execution_id: "execution-2" }))).rejects.toThrow();
      expect(value.desktop.createThreadCount()).toBe(1);
      expect(value.desktop.sendCount()).toBe(0);
    } finally { await value.service.close(); }
  });

  it("creates separate threads for different Goals on the same Task", async () => {
    const desktop = fakeDesktop({ uniqueThreads: true, turns: [{ id: "turn-1", status: "completed", completedAt: 1 }] });
    const value = await fixture({ desktop });
    desktop.setProjectPath(value.registry.active.manager.canonicalRoot);
    try {
      await seedTask(value);
      const first = await value.backend.start(interactiveRequest());
      await value.backend.whenIdle();
      const second = await value.backend.start(interactiveRequest({ goal_id: "goal-2", execution_id: "execution-2" }));
      await value.backend.whenIdle();
      expect(first.thread_id).not.toBe(second.thread_id);
      expect(desktop.createThreadCount()).toBe(2);
      expect(desktop.sendCount()).toBe(0);
    } finally { await value.service.close(); }
  });

  it.each(["transport", "session_persistence", "binding_persistence"] as const)("keeps %s launch uncertainty without redispatch", async failure => {
    const value = await fixture();
    const originalCall = value.desktop.runtime.mcpClient.callTool;
    if (failure === "transport") value.desktop.runtime.mcpClient.callTool = async params => {
      if (params.name === "create_thread") { value.desktop.calls.push(params); throw new Error("transport disconnected after dispatch"); }
      return originalCall(params);
    };
    const originalUpdate = SessionStore.prototype.updateSession;
    const update = failure === "session_persistence" ? vi.spyOn(SessionStore.prototype, "updateSession").mockImplementation(async function (this: SessionStore, id, input) {
      if (input.status === "active") throw new Error("session disk unavailable");
      return originalUpdate.call(this, id, input);
    }) : undefined;
    const binding = failure === "binding_persistence" ? vi.spyOn(DesktopThreadBindingStore.prototype, "createIfAbsent").mockRejectedValue(new Error("binding disk unavailable")) : undefined;
    try {
      await seedTask(value);
      const authorization = await value.controlled.authorize({ actuation_id: ACTUATION_ID, ...interactiveRequest() });
      const request = { actuation_id: ACTUATION_ID, authorization_id: authorization.authorization_id };
      await expect(value.controlled.actuate(request)).rejects.toBeDefined();
      expect(await value.controlled.getActuation(ACTUATION_ID)).toMatchObject({ status: "starting", error: expect.stringContaining(failure === "transport" ? "create_thread" : "persistence") });
      await expect(value.controlled.actuate(request)).rejects.toBeDefined();
      expect(value.desktop.createThreadCount()).toBe(1);
      expect(value.appServerStart).not.toHaveBeenCalled();
      expect(value.cliStart).not.toHaveBeenCalled();
      expect(value.desktop.runtimeCloseCount()).toBe(1);
    } finally { update?.mockRestore(); binding?.mockRestore(); await value.service.close(); }
  });

  it.each([false, true])("routes omitted MCP execution mode through Desktop preflight and completion with activation failure=%s", async (activationFails) => {
    const open = vi.fn(async () => {
      if (activationFails) throw new Error("activation failed");
    });
    const value = await fixture({ openDesktopThread: open });
    const review = vi.fn(async (request) => ({ status: "COMPLETED" as const,
      content: `<lrm-review-result>${JSON.stringify({ schema_version: 1,
        review_request_id: request.review_request_id, decision: "APPROVE", summary: "Reviewed" })}</lrm-review-result>`,
    }));
    const auto = new AutoIterationService(value.registry, { storageRoot: value.root,
      controlledActuation: value.controlled,
      browserRouter: new BrowserRouter(value.root, { deliver: async () => ({
        status: "delivered", delivered_at: new Date().toISOString(),
      }) }),
      completionRouter: new ReviewCompletionRouter(value.root, { collect: review }),
    });
    const goals = new GoalOrchestrationService(value.registry, { storageRoot: value.root,
      controlledActuation: value.controlled, authorizationStore: value.controlled.authorizationStore,
      autoIteration: auto });
    value.service.setTerminalListener((execution) => auto.onExecutionTerminal(execution));
    auto.setTerminalListener((loop) => goals.onAutoIterationTerminal(loop));
    const preflight = vi.fn(async (input) => ({ ready: true, runtime: { ready: true },
      connector: { ready: true }, extension: { ready: true },
      workspace: { valid: true, workspace_id: input.workspace_id },
      conversation: { valid: true, conversation_id: input.conversation_id },
    }));
    const correlations = new ConversationCorrelationRegistry(value.root);
    const pending = new PendingGoalSubmissionService(correlations,
      new GoalSubmissionService(goals, { checkGoalPreflight: preflight }), {
        storageRoot: value.root, browserReadiness: () => ({ ready: true, bridge_available: true,
          extension_paired: true, extension_present: true, readiness_state: "ready" }),
      });
    const server = createMcpServer({ registry: value.registry, correlations, pendingGoalSubmission: pending });
    const client = new Client({ name: "desktop-interactive-route-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const correlation = "00000000-0000-4000-8000-000000000091";
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const accepted = await client.callTool({ name: "submit_goal", arguments: {
        correlation_key: correlation, title: "Desktop interactive", goal: INSTRUCTION,
        requirements: ["Use Desktop"], acceptance_criteria: ["Review completes"],
      } });
      expect(accepted.isError).not.toBe(true);
      expect((await pending.get(correlation))?.execution_mode).toBe("interactive");
      await correlations.observe({ request_id: correlation, conversation_id: "conversation-1",
        document_id: "document-1", navigation_epoch: 1 });
      pending.scheduleResolve(correlation);
      await vi.waitFor(async () => expect((await pending.get(correlation))?.state).toBe("started"));
      const record = (await pending.get(correlation))!;
      if (record.state !== "started") throw new Error("Goal was not started");
      const result = record;
      expect(value.cliStart).not.toHaveBeenCalled();
      expect(value.appServerStart).not.toHaveBeenCalled();
      expect(preflight).toHaveBeenCalledWith(expect.objectContaining({
        workspace_id: "workspace-a", execution_mode: "interactive",
      }));
      expect(value.desktop.createThreadCount()).toBe(1);
      const session = (await value.sessions.listSessions())[0]!;
      expect(open).toHaveBeenCalledWith(`codex://threads/${session.thread_id}`);
      expect(value.desktop.calls.find((call) => call.name === "create_thread")?.arguments)
        .toMatchObject({ prompt: expect.stringContaining(INSTRUCTION) });
      expect((await value.executions.getExecutionContext("workspace-a", result.task_id, result.execution_id))?.status)
        .toBe("running");
      value.desktop.setTurns([{ id: "turn-default", status: "completed", completedAt: 1,
        items: [{ id: "message-default", type: "agentMessage", text: "DESKTOP_DEFAULT_PASS" }] }]);
      await value.backend.whenIdle();
      await vi.waitFor(async () => expect((await goals.getGoal(result.goal_id))?.status).toBe("completed"));
      expect(review).toHaveBeenCalledOnce();
      expect((await new TaskContextService(value.root).getTaskContext(result.task_id))?.status).toBe("completed");
      expect(await value.executions.getExecutionContext("workspace-a", result.task_id, result.execution_id))
        .toMatchObject({ status: "passed", summary: "Desktop turn completed successfully." });
      expect((await value.events.listEvents(session.session_id)).map((event) => event.event_type))
        .toEqual(expect.arrayContaining(["session_started", "turn_started", "agent_message_completed", "turn_completed"]));
      expect(await new StatusQueryService({ storageRoot: value.root }).getExecutionStatus({
        workspace_id: "workspace-a", execution_id: result.execution_id,
      })).toMatchObject({ status: "passed", agent_output: "DESKTOP_DEFAULT_PASS" });
    } finally {
      await client.close();
      await server.close();
      auto.dispose();
      await value.service.close();
    }
  });

  it.each(["interactive", "batch"] as const)("preserves %s Goal routing across three rounds and restart", async (mode) => {
    const desktop = fakeDesktop({ uniqueThreads: true });
    const openThread = vi.fn(async (_url: string) => undefined);
    const value = await fixture({ desktop, openDesktopThread: openThread });
    desktop.setProjectPath(value.registry.active.manager.canonicalRoot);
    let reviews = 0;
    const browserRouter = new BrowserRouter(value.root, {
      deliver: async () => ({ status: "delivered", delivered_at: new Date().toISOString() }),
    });
    const completionRouter = new ReviewCompletionRouter(value.root, {
      collect: async (request) => {
        const decision = ++reviews < 3 ? "ITERATE" : "APPROVE";
        return { status: "COMPLETED", content: `<lrm-review-result>${JSON.stringify({
          schema_version: 1, review_request_id: request.review_request_id, decision, summary: "Reviewed",
          ...(decision === "ITERATE" ? { iteration: {
            goal: "Fix the defect", requirements: ["Keep the route"], acceptance_criteria: ["Tests pass"],
          } } : {}),
        })}</lrm-review-result>` };
      },
    });
    const makeAuto = () => new AutoIterationService(value.registry, { storageRoot: value.root,
      browserRouter, completionRouter, controlledActuation: value.controlled });
    let auto = makeAuto();
    const makeGoals = () => new GoalOrchestrationService(value.registry, { storageRoot: value.root,
      controlledActuation: value.controlled, authorizationStore: value.controlled.authorizationStore,
      autoIteration: auto });
    let goals = makeGoals();
    const query = new StatusQueryService({ storageRoot: value.root, goals: {
      getGoal: (id) => goals.getGoal(id), listGoals: () => goals.listGoals(),
    } });
    await goals.createGoal({ goal_id: GOAL_ID, workspace_id: "workspace-a", conversation_id: "conversation-1",
      execution_mode: mode, model_id: "gpt-5.6-luna", reasoning_effort: "max", phases: [{
        phase_id: "phase-1", objective: "Fix", tasks: [{ task_id: TASK_ID, goal: "Fix",
          requirements: ["Keep it small"], acceptance_criteria: ["Tests pass"], max_iterations: 3 }],
      }] });
    try {
      const first = await goals.startGoal({ goal_id: GOAL_ID });
      expect(await query.listExecutionSummaries()).toHaveLength(1);
      for (let round = 1; round <= 3; round += 1) {
        desktop.setTurns(Array.from({ length: round }, (_, index) => ({
          id: `turn-${index + 1}`, status: "completed", completedAt: 1,
        })));
        await value.backend.whenIdle();
        const loop = (await auto.getLoop(first.loop_id!))!;
        expect(loop.iteration).toBe(round);
        const authorization = await new ActuationAuthorizationStore(value.root).getAuthorizationByExecution(
          "workspace-a", TASK_ID, loop.execution_id,
        );
        expect(authorization).toMatchObject({ goal_id: GOAL_ID, execution_mode: mode,
          model_id: "gpt-5.6-luna", reasoning_effort: "max" });
        if (mode === "batch") {
          await value.executions.updateExecutionContext("workspace-a", TASK_ID, loop.execution_id, { status: "passed" });
        }
        // Reconstruct services before the second verdict to exercise durable inheritance.
        if (round === 2) {
          auto.dispose();
          auto = makeAuto();
          goals = makeGoals();
        }
        await goals.advanceGoal(GOAL_ID);
        if (mode === "interactive" && round < 3) {
          const nextLoop = (await auto.getLoop(first.loop_id!))!;
          expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, nextLoop.execution_id))?.status).toBe("running");
          expect(reviews).toBe(round);
          await Promise.all([value.backend.start({ ...interactiveRequest(), execution_id: nextLoop.execution_id }),
            value.backend.start({ ...interactiveRequest(), execution_id: nextLoop.execution_id })]);
          expect(desktop.sendCount()).toBe(round);
        }
      }
      expect((await goals.getGoal(GOAL_ID))?.status).toBe("completed");
      const sessions = await value.sessions.listSessions();
      expect(sessions).toHaveLength(mode === "interactive" ? 3 : 0);
      expect(desktop.createThreadCount()).toBe(mode === "interactive" ? 1 : 0);
      expect(desktop.sendCount()).toBe(mode === "interactive" ? 2 : 0);
      expect(value.cliStart).toHaveBeenCalledTimes(mode === "batch" ? 3 : 0);
      if (mode === "interactive") {
        expect(new Set(sessions.map((session) => session.thread_id)).size).toBe(1);
        expect(new Set(sessions.map((session) => session.execution_id)).size).toBe(3);
        expect(new Set(sessions.map((session) => session.session_id)).size).toBe(3);
        for (const call of desktop.calls.filter((call) => call.name === "create_thread")) {
          expect(call.arguments).toMatchObject({ model: "gpt-5.6-luna", thinking: "max" });
        }
        for (const call of desktop.calls.filter((call) => call.name === "send_message_to_thread")) {
          expect(call.arguments).toMatchObject({ threadId: sessions[0]!.thread_id, hostId: "local" });
        }
        expect(openThread.mock.calls.map(([url]) => url)).toEqual(Array(3).fill(`codex://threads/${sessions[0]!.thread_id}`));
      }
      const rows = await query.listExecutionSummaries();
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toMatchObject({ execution_mode: mode, model: "gpt-5.6-luna", reasoning_effort: "max",
          backend: mode === "interactive" ? "desktop_codex_app" : "cli" });
        if (mode === "interactive") {
          expect((await value.events.listEvents(row.session_id!)).some((event) =>
            event.execution_id === row.execution_id && event.thread_id === row.thread_id)).toBe(true);
        } else expect(row.session_id).toBeUndefined();
      }
      if (mode === "interactive") expect(new Set(rows.map((row) => row.session_id)).size).toBe(3);
      if (mode === "interactive") expect(new Set(rows.map((row) => row.turn_id))).toEqual(new Set(["turn-1", "turn-2", "turn-3"]));
    } finally {
      auto.dispose();
      await value.service.close();
    }
  });

  it("keeps batch on the CLI backend and routes interactive to the Desktop backend", async () => {
    const batchValue = await fixture();
    const batch = await batchValue.service.start({
      workspace_id: "workspace-a",
      task_id: TASK_ID,
      execution_id: "execution-batch",
      instruction: "batch",
      execution_mode: "batch",
    });
    expect(batch.process_id).toBe(9_002);
    expect(batchValue.cliStart).toHaveBeenCalledTimes(1);
    expect(batchValue.desktop.createThreadCount()).toBe(0);
    expect(batchValue.appServerStart).not.toHaveBeenCalled();

    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
    await authorizeAndActuate(value, {}, "terminal");
    expect(value.cliStart).not.toHaveBeenCalled();
    expect(value.appServerStart).not.toHaveBeenCalled();
    expect(value.desktop.createThreadCount()).toBe(1);
  });

  it("rejects a missing execution mode before selecting a backend", async () => {
    const value = await fixture();
    await seedTask(value);

    await expect(value.service.start({
      workspace_id: "workspace-a",
      task_id: TASK_ID,
      execution_id: "execution-no-mode",
      instruction: INSTRUCTION,
    } as never)).rejects.toThrow();
    expect(value.cliStart).not.toHaveBeenCalled();
    expect(value.desktop.createThreadCount()).toBe(0);
  });

  it("does not fall back to the private app-server backend when Desktop fails", async () => {
    const value = await fixture({ state: () => desktopState({ connected: false }) });
    await seedTask(value);
    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();
    expect(value.appServerStart).not.toHaveBeenCalled();
    expect(value.desktop.createThreadCount()).toBe(0);
  });
});

describe("P5.4.1 Desktop preflight fail-closed", () => {
  it("connects through the host environment pipe when this process already holds it", async () => {
    const desktop = fakeDesktop();
    desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
    const seenPipePaths: string[] = [];
    const environmentPipe = "\\\\.\\pipe\\codex-env-pipe";
    // No handoff capability is ever accepted here, but this process already inherits the pipe via
    // CODEX_APP_TOOLS_PIPE_PATH, so the runtime resolves that compatibility source instead of
    // failing with desktop_tools_pipe_unavailable. This is not a Launcher auto-acquisition path.
    const runtimeFactory = new DesktopCodexRuntimeFactory(
      new DesktopToolsPipeHandoff(),
      () => desktopState(),
      async ({ pipePath }) => {
        seenPipePaths.push(pipePath!);
        return desktop.runtime as DesktopCodexRuntimeLike;
      },
      { environment: { CODEX_APP_TOOLS_PIPE_PATH: environmentPipe } },
    );
    const value = await fixture({ desktop, runtimeFactory });
    // The fixture only auto-binds the Desktop project record for its own default fake.
    desktop.setProjectPath(value.registry.active.manager.canonicalRoot);
    await authorizeAndActuate(value, {}, "terminal");

    expect(seenPipePaths).toEqual([environmentPipe]);
    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    expect(execution?.status).toBe("passed");
    expect(value.desktop.createThreadCount()).toBe(1);
  });

  it("fails closed when Desktop is disconnected", async () => {
    const value = await fixture({ state: () => desktopState({ connected: false }) });
    await seedTask(value);
    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.desktop.sendCount()).toBe(0);
    expect(value.appServerStart).not.toHaveBeenCalled();
  });

  it("fails closed when the executor conversation identity is unavailable", async () => {
    const value = await fixture({ state: () => desktopState({ currentConversationId: undefined }) });
    await seedTask(value);
    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.appServerStart).not.toHaveBeenCalled();
  });

  it("fails closed when the runtime cannot connect", async () => {
    const desktop = fakeDesktop();
    desktop.failConnect(new Error("transport failed"));
    const value = await fixture({ desktop });
    await seedTask(value);
    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.appServerStart).not.toHaveBeenCalled();
  });

  it("fails closed when the tools contract is incompatible", async () => {
    const desktop = fakeDesktop();
    desktop.setListTools([{ name: "list_projects", inputSchema: { type: "object", properties: {} } }]);
    const value = await fixture({ desktop });
    await seedTask(value);
    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.appServerStart).not.toHaveBeenCalled();
  });

  it("fails closed when no exact local project matches", async () => {
    const value = await fixture({ projectPath: "C:\\other\\project" });
    await seedTask(value);
    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.desktop.sendCount()).toBe(0);
    expect(value.appServerStart).not.toHaveBeenCalled();
  });

  it("fails closed when more than one exact local project matches", async () => {
    const desktop = fakeDesktop();
    const original = desktop.runtime.mcpClient.callTool;
    let workspacePath = OTHER_WORKSPACE_PATH;
    desktop.runtime.mcpClient.callTool = async (params: CallToolRequestParams) => {
      if (params.name !== "list_projects") return original(params);
      return jsonResult({
        projects: [
          { projectId: "project-1", hostId: "local", projectKind: "local", path: workspacePath },
          { projectId: "project-2", hostId: "local", projectKind: "local", path: workspacePath },
        ],
      });
    };
    const value = await fixture({ desktop });
    workspacePath = value.registry.active.manager.canonicalRoot;
    await seedTask(value);
    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.appServerStart).not.toHaveBeenCalled();
  });
});

describe("Desktop interactive Goal model and reasoning effort", () => {
  it("dispatches create_thread for an interactive Goal that carries model and reasoning_effort", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);

    await authorizeAndActuate(value, { model_id: "gpt-5.6-luna", reasoning_effort: "max" }, "terminal");

    expect(value.desktop.createThreadCount()).toBe(1);
    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    expect(execution?.status).toBe("passed");

    const createThread = value.desktop.calls.find((call) => call.name === "create_thread")!;
    expect(createThread.arguments).toEqual({
      model: "gpt-5.6-luna",
      prompt: INSTRUCTION,
      target: { type: "project", projectId: "project-1", environment: { type: "local" } },
      thinking: "max",
    });

    // The Session keeps the canonical model selection; only the provider call renames it.
    const session = (await value.sessions.listSessions())[0]!;
    expect(session).toMatchObject({ model_id: "gpt-5.6-luna", reasoning_effort: "max" });
  });

  it("passes business instructions containing LRM and submit_goal unchanged to Codex", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
    const instruction = "修复 LRM 中 submit_goal 的任务状态回执处理，并保留原始业务要求。";
    await authorizeAndActuate(value, { instruction }, "terminal");
    const createThread = value.desktop.calls.find((call) => call.name === "create_thread")!;
    expect(createThread.arguments!.prompt).toBe(instruction);
  });

  it("keeps the Desktop route unchanged when no provider model is given", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);

    await authorizeAndActuate(value, {}, "terminal");

    expect(value.desktop.createThreadCount()).toBe(1);
    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    expect(execution?.status).toBe("passed");
  });

  it("still delivers model and reasoning_effort to a non-Desktop interactive backend", async () => {
    const seen: ExecutionBackendStartRequest[] = [];
    const capture: ExecutionBackend = {
      start: async (request) => {
        seen.push(request);
        throw new Error("captured before any provider start");
      },
    };
    const value = await fixture();
    const service = new ExecutionService(new ExecutionBackendRouter({
      batch: new CliExecutionBackend({ start: value.cliStart }),
      interactive: capture,
    }));

    await seedTask(value);
    await expect(service.start(interactiveRequest({
      model_id: "gpt-5.6-luna",
      reasoning_effort: "max",
    }))).rejects.toBeDefined();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ model_id: "gpt-5.6-luna", reasoning_effort: "max" });
  });

  it("leaves the batch route on the CLI backend when model and reasoning_effort are given", async () => {
    const value = await fixture();
    await seedTask(value);

    const started = await value.service.start({
      workspace_id: "workspace-a",
      task_id: TASK_ID,
      execution_id: "execution-batch",
      instruction: INSTRUCTION,
      execution_mode: "batch",
      model_id: "gpt-5.6-luna",
      reasoning_effort: "max",
    });

    expect(started.process_id).toBe(9_002);
    expect(value.cliStart).toHaveBeenCalledTimes(1);
    expect(value.desktop.createThreadCount()).toBe(0);
  });
});

describe("P5.4.1 first turn on a newly created Desktop target", () => {
  it("completes the first turn from an empty baseline and persists durable Desktop identity", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 42 }]);
    await authorizeAndActuate(value, {}, "terminal");

    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    expect(execution).toMatchObject({ status: "passed", command: "desktop codex_app" });
    expect(execution?.process_id).toBeUndefined();
    expect(value.desktop.createThreadCount()).toBe(1);
    expect(value.desktop.sendCount()).toBe(0);

    const session = (await value.sessions.listSessions())[0]!;
    expect(session.backend_type).toBe("desktop_codex_app");
    expect(session.status).toBe("completed");
    expect(session.thread_id).toBe("target-thread-1");

    const binding = await new DesktopThreadBindingStore(value.root).load("workspace-a", session.session_id);
    expect(binding).toMatchObject({
      backend_identity: "desktop_codex_app",
      target_thread_id: "target-thread-1",
      host_id: "local",
    });

    expect(value.terminals).toHaveLength(1);
    expect(value.terminals[0]).toMatchObject({ status: "passed" });

    const events = await value.events.listEvents(session.session_id);
    expect(events.map((event) => event.event_type)).toContain("turn_completed");
  });

  it("persists the original executor only in its trusted target binding", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
    await authorizeAndActuate(value, {}, "terminal");

    const session = (await value.sessions.listSessions())[0]!;
    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    const binding = await new DesktopThreadBindingStore(value.root).load("workspace-a", session.session_id);
    const sessionRaw = await readFile(
      join(value.root, ".task", "sessions", session.session_id + ".json"),
      "utf8",
    );

    expect(sessionRaw).not.toContain("executor-conversation-1");
    expect(JSON.stringify(execution)).not.toContain("executor-conversation-1");
    expect(binding?.executor_thread_id).toBe("executor-conversation-1");
    expect(session.thread_id).not.toBe("executor-conversation-1");
  });

  it("retains running when a newly created target already shows more than one new turn", async () => {
    const value = await fixture();
    value.desktop.setTurns([
      { id: "turn-1", status: "completed", completedAt: 1 },
      { id: "turn-2", status: "completed", completedAt: 2 },
    ]);
    await authorizeAndActuate(value, {}, "launch");
    await value.backend.whenIdle();

    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    expect(execution?.status).toBe("running");
    expect(execution?.summary).toContain("ambiguous_new_turn");
    expect((await value.sessions.listSessions())[0]!.status).toBe("active");
    expect(value.terminals).toHaveLength(0);
  });

  it("keeps the Execution running while the Desktop turn is in progress", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);
    await authorizeAndActuate(value, {}, "launch");
    await new Promise((resolve) => setTimeout(resolve, 25));

    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    expect(execution?.status).toBe("running");
    expect((await value.sessions.listSessions())[0]!.status).toBe("active");
    expect(value.terminals).toHaveLength(0);

    await value.backend.close();
    await value.backend.whenIdle();
  });

  it("recovers from a transient observer wait error and completes", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);
    const original = value.desktop.runtime.mcpClient.callTool;
    let transient = true;
    value.desktop.runtime.mcpClient.callTool = async (params: CallToolRequestParams) => {
      if (params.name === "wait_threads" && transient) {
        transient = false;
        value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
        return { isError: true, content: [{ type: "text", text: "temporary wait failure" }] };
      }
      return original(params);
    };

    await authorizeAndActuate(value, {}, "terminal");

    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    expect(execution?.status).toBe("passed");
    expect((await value.sessions.listSessions())[0]!.status).toBe("completed");
    const events = await value.events.listEvents((await value.sessions.listSessions())[0]!.session_id);
    expect(events.map((event) => event.event_type)).toContain("turn_completed");
    expect(events.map((event) => event.event_type)).not.toContain("execution_failed");
  });

  it("recovers the first turn when the target is not yet visible on the first read", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 42 }]);
    // The freshly created target is momentarily unreadable; the first-turn visibility grace retries.
    value.desktop.setReadErrors(1);
    await authorizeAndActuate(value, {}, "terminal");

    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    expect(execution).toMatchObject({ status: "passed" });
    expect(value.desktop.createThreadCount()).toBe(1);
    const reads = value.desktop.calls.filter((call) => call.name === "read_thread");
    expect(reads.length).toBeGreaterThan(1);
    const session = (await value.sessions.listSessions())[0]!;
    const events = await value.events.listEvents(session.session_id);
    expect(events.map((event) => event.event_type)).toContain("turn_completed");
  });
});

describe("P5.4.1 durable launch identity without a process id", () => {
  it("recovers a Desktop Execution from Session plus DesktopThreadBinding instead of a PID", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
    await authorizeAndActuate(value, {}, "terminal");

    const authorization = await value.controlled.authorizationStore.getAuthorizationByActuation(ACTUATION_ID);
    expect(authorization).not.toBeNull();

    // Recovery must come from durable Desktop evidence and must not resend or re-create anything.
    const recovered = await value.controlled.actuate({
      actuation_id: ACTUATION_ID,
      authorization_id: authorization!.authorization_id,
    });
    expect(recovered.accepted).toBe("existing");
    expect(recovered.process_id).toBeUndefined();
    expect(value.desktop.createThreadCount()).toBe(1);
    expect(value.desktop.sendCount()).toBe(0);
  });

  it("still rejects a PID-less running Execution with no Desktop durable evidence", async () => {
    const value = await fixture();
    await seedTask(value);
    await value.executions.createExecutionContext({
      execution_id: EXECUTION_ID,
      task_id: TASK_ID,
      workspace_id: "workspace-a",
      command: "codex exec --json -",
    });

    // authorize() is the first gate and must already refuse an ambiguous PID-less Execution.
    const outcome = await value.controlled.authorize({
      actuation_id: ACTUATION_ID,
      goal_id: GOAL_ID,
      workspace_id: "workspace-a",
      task_id: TASK_ID,
      execution_id: EXECUTION_ID,
      instruction: INSTRUCTION,
      execution_mode: "interactive",
    }).then(() => "authorized", (error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toMatch(/ambiguous launch state/u);
    expect(value.desktop.createThreadCount()).toBe(0);
  });

  it("preserves CLI process identity", async () => {
    const value = await fixture();
    await seedTask(value);
    const authorization = await value.controlled.authorize({
      actuation_id: ACTUATION_ID,
      goal_id: GOAL_ID,
      workspace_id: "workspace-a",
      task_id: TASK_ID,
      execution_id: EXECUTION_ID,
      instruction: "codex exec",
      execution_mode: "batch",
    });
    const result = await value.controlled.actuate({
      actuation_id: ACTUATION_ID,
      authorization_id: authorization.authorization_id,
    });
    expect(result.process_id).toBe(9_002);
  });
});

describe("P5.4.1 StatusQuery and terminal ordering", () => {
  it("reports desktop_codex_app with the Desktop target thread and completed turn", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
    await authorizeAndActuate(value, {}, "terminal");
    const session = (await value.sessions.listSessions())[0]!;

    const { StatusQueryService } = await import("../src/control-plane/status-query.js");
    const statusQuery = new StatusQueryService({ storageRoot: value.root });

    const sessionStatus = await statusQuery.getSessionStatus({ session_id: session.session_id });
    expect(sessionStatus).toMatchObject({
      backend_type: "desktop_codex_app",
      thread_id: "target-thread-1",
      status: "completed",
      current_execution: { execution_id: EXECUTION_ID, status: "passed", turn_id: "turn-1" },
    });

    const executionStatus = await statusQuery.getExecutionStatus({ execution_id: EXECUTION_ID });
    expect(executionStatus).toMatchObject({
      status: "passed",
      backend_type: "desktop_codex_app",
      thread_id: "target-thread-1",
      turn_id: "turn-1",
    });
    expect(executionStatus.agent_output).toBeUndefined();
  });

  it("persists terminal Execution, Session, and event state before notifying the listener once", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
    const observed: Array<{ readonly execution: string; readonly session: string; readonly event: boolean }> = [];
    value.service.setTerminalListener(async (execution) => {
      const session = (await value.sessions.listSessions())[0]!;
      const persisted = await value.executions.getExecutionContext(
        execution.workspace_id,
        execution.task_id,
        execution.execution_id,
      );
      const events = await value.events.listEvents(session.session_id);
      observed.push({
        execution: persisted?.status ?? "missing",
        session: session.status,
        event: events.some((event) => event.event_type === "turn_completed"),
      });
    });

    await authorizeAndActuate(value, {}, "terminal");

    expect(observed).toEqual([{ execution: "passed", session: "completed", event: true }]);
    // The service has a single terminal listener, so this test's listener replaced the fixture's.
    expect(observed).toHaveLength(1);
  });
});

describe("P5.4.1 FIX executor identity is captured exactly once", () => {
  it("keeps every codex_app tools/call on the captured executor after a foreground switch", async () => {
    // The Desktop state reader reports executor-A on the first read (captured at start) and
    // executor-B afterwards, simulating a foreground conversation switch mid-execution.
    let reads = 0;
    const state = (): DesktopSyncState => {
      reads += 1;
      return desktopState({
        currentConversationId: reads === 1 ? "executor-A" : "executor-B",
      });
    };
    const value = await fixture({ state });
    // First read sees a pending turn so the observer issues wait_threads, then it completes.
    // This makes the assertion cover list_projects, create_thread, read_thread and wait_threads.
    let readsAfterDispatch = 0;
    const original = value.desktop.runtime.mcpClient.callTool;
    value.desktop.runtime.mcpClient.callTool = async (params: CallToolRequestParams) => {
      if (params.name === "read_thread") {
        readsAfterDispatch += 1;
        if (readsAfterDispatch > 1) value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
      }
      return original(params);
    };
    value.desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);
    await authorizeAndActuate(value, {}, "terminal");

    const toolCalls = value.desktop.calls.filter((call) =>
      call.name === "list_projects"
      || call.name === "create_thread"
      || call.name === "read_thread"
      || call.name === "wait_threads");
    expect(toolCalls.length).toBeGreaterThan(0);

    // Real MCP request metadata must carry the captured executor for every tool call.
    const executors = toolCalls.map((call) => call._meta?.["openai/threadId"]);
    expect(executors.every((executor) => executor === "executor-A")).toBe(true);
    expect(executors).not.toContain("executor-B");

    // Every tool class involved in this Execution must use the captured executor.
    for (const name of ["list_projects", "create_thread", "read_thread", "wait_threads"]) {
      expect(toolCalls.filter((call) => call.name === name).length).toBeGreaterThan(0);
    }

    // The target must still differ from the executor, and the executor must stay non-durable.
    const session = (await value.sessions.listSessions())[0]!;
    expect(session.thread_id).toBe("target-thread-1");
    expect(session.thread_id).not.toBe("executor-A");
    expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))?.status)
      .toBe("passed");
  });

  it("does not re-read the executor while resolving the Desktop project", async () => {
    const seen: string[] = [];
    const value = await fixture({
      state: () => {
        seen.push(`read-${seen.length + 1}`);
        return desktopState({ currentConversationId: `executor-${seen.length}` });
      },
    });
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
    await authorizeAndActuate(value, {}, "terminal");

    // Exactly one capture happens per Execution; the project resolver reuses that value.
    expect(seen).toHaveLength(1);
    const listProjects = value.desktop.calls.find((call) => call.name === "list_projects");
    const createThread = value.desktop.calls.find((call) => call.name === "create_thread");
    expect(listProjects?._meta?.["openai/threadId"]).toBe("executor-1");
    expect(createThread?._meta?.["openai/threadId"]).toBe("executor-1");
  });
});

describe("P5.4.1 FIX failure terminal projection", () => {
  it.each(["completed", "failed"])("reconnects observation of the same Turn until real %s without dispatching again", async outcome => {
    const desktop = fakeDesktop();
    let connections = 0;
    let broken = false;
    const original = desktop.runtime.mcpClient.callTool;
    desktop.runtime.mcpClient.callTool = async params => {
      if (params.name === "read_thread" && broken && connections === 1) {
        return { isError: true, content: [{ type: "text", text: "transport unavailable" }] };
      }
      return original(params);
    };
    const value = await fixture({ desktop, completionTimeoutMs: 10, runtimeFactory: {
      connect: async () => {
        connections++;
        if (connections > 1) desktop.setListTools(desktopTools().filter(tool => tool.name === "read_thread"));
        return desktop.runtime;
      },
    } });
    desktop.setProjectPath(value.registry.active.manager.canonicalRoot);
    desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);
    await authorizeAndActuate(value, {}, "launch");
    const session = (await value.sessions.listSessions())[0]!;
    await vi.waitFor(async () => expect((await value.events.listEvents(session.session_id))
      .filter(event => event.event_type === "turn_started")).toHaveLength(1));
    broken = true;
    await vi.waitFor(() => expect(connections).toBe(2));
    desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null },
      { id: "turn-2", status: "completed", completedAt: 2 }]);
    await vi.waitFor(async () => expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))?.summary)
      .toContain('"monitor":"recovered"'));
    expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))?.status).toBe("running");
    desktop.setTurns([{ id: "turn-1", status: outcome, completedAt: 1 },
      { id: "turn-2", status: "completed", completedAt: 2 }]);
    await value.backend.whenIdle();
    expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))?.status)
      .toBe(outcome === "completed" ? "passed" : "failed");
    const events = await value.events.listEvents(session.session_id);
    expect(events.filter(event => event.event_type === "turn_started")).toHaveLength(1);
    expect(events.filter(event => event.event_type === "execution_failed")).toHaveLength(outcome === "failed" ? 1 : 0);
    expect(desktop.createThreadCount()).toBe(1);
    expect(desktop.sendCount()).toBe(0);
    expect(value.terminals).toHaveLength(1);
    expect(desktop.runtimeCloseCount()).toBe(2);
  });

  it.each(["existing", "reconcile", "concurrent"])("bounds reconnect failures and lets %s reattach with captured identity", async recovery => {
    const desktop = fakeDesktop();
    let connections = 0;
    let broken = false;
    const original = desktop.runtime.mcpClient.callTool;
    desktop.runtime.mcpClient.callTool = async params => {
      if (params.name === "read_thread" && broken) throw new Error("transport disconnected");
      return original(params);
    };
    const value = await fixture({ desktop, completionTimeoutMs: 10, runtimeFactory: {
      connect: async () => { connections++; if (broken) throw new Error("runtime unavailable"); return desktop.runtime; },
    } });
    desktop.setProjectPath(value.registry.active.manager.canonicalRoot);
    desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);
    await authorizeAndActuate(value, {}, "launch");
    const session = (await value.sessions.listSessions())[0]!;
    await vi.waitFor(async () => expect((await value.events.listEvents(session.session_id))
      .some(event => event.event_type === "turn_started")).toBe(true));
    broken = true;
    await value.backend.whenIdle();
    expect(connections).toBe(4);
    expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID)))
      .toMatchObject({ status: "running", summary: expect.stringContaining('"monitor":"unavailable"') });
    expect(value.terminals).toHaveLength(0);
    expect((await value.events.listEvents(session.session_id)).some(event => event.event_type === "execution_failed")).toBe(false);
    broken = false;
    desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
    if (recovery === "existing") {
      expect(await value.backend.start(interactiveRequest())).toMatchObject({ accepted: "existing", thread_id: session.thread_id });
    } else if (recovery === "reconcile") {
      await value.backend.reconcileOrphanedExecutions();
    } else {
      await Promise.all([value.backend.start(interactiveRequest()), value.backend.reconcileOrphanedExecutions()]);
    }
    await value.backend.whenIdle();
    expect(connections).toBe(5);
    expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))?.status).toBe("passed");
    expect(desktop.createThreadCount()).toBe(1);
    expect(desktop.sendCount()).toBe(0);
    expect((await value.events.listEvents(session.session_id)).filter(event => event.event_type === "turn_started")).toHaveLength(1);
  });

  it("keeps a running Execution after process restart despite an unrelated foreground executor", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);
    await authorizeAndActuate(value, {}, "launch");
    await value.backend.close();
    const sessionBeforeRestart = (await value.sessions.listSessions())[0]!;
    const binding = (await new DesktopThreadBindingStore(value.root).load("workspace-a", sessionBeforeRestart.session_id))!;
    const { executor_thread_id: _executor, ...legacyBinding } = binding;
    await writeFile(join(value.root, ".task", "desktop_thread_bindings", "workspace-a", sessionBeforeRestart.session_id + ".json"), JSON.stringify(legacyBinding));
    const connect = vi.fn(value.desktop.runtimeFactory.connect);
    const restarted = new DesktopCodexBackend(value.registry, { storageRoot: value.root,
      runtimeFactory: { connect }, desktopState: () => desktopState({ currentConversationId: "unrelated-foreground" }),
    });
    try {
      expect(await restarted.start(interactiveRequest())).toMatchObject({ accepted: "existing" });
      await restarted.reconcileOrphanedExecutions();
      expect((await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID)))
        .toMatchObject({ status: "running", summary: expect.stringContaining("executor_identity_unavailable") });
      expect(connect).not.toHaveBeenCalled();
      expect(value.desktop.createThreadCount()).toBe(1);
      expect(value.desktop.sendCount()).toBe(0);
      const session = (await value.sessions.listSessions())[0]!;
      expect((await value.events.listEvents(session.session_id)).some(event => event.event_type === "execution_failed")).toBe(false);
    } finally { await restarted.close(); }
  });

  it("retains Desktop orphans after Host restart once without creating or resending a thread", async () => {
    const value = await fixture();
    await seedTask(value);
    const session = await value.sessions.createSession({ goal_id: GOAL_ID, task_id: TASK_ID,
      backend_type: "desktop_codex_app", workspace: value.registry.active.manager.canonicalRoot,
      status: "active", thread_id: "previous-thread" });
    for (const thread_id of ["older-thread-1", "older-thread-2"]) {
      await value.sessions.createSession({ goal_id: GOAL_ID, task_id: TASK_ID,
        backend_type: "desktop_codex_app", workspace: value.registry.active.manager.canonicalRoot,
        status: "completed", thread_id });
    }
    await value.events.appendEvent({
      session_id: session.session_id,
      execution_id: EXECUTION_ID,
      thread_id: "previous-thread",
      timestamp: new Date().toISOString(),
      event_type: "session_started",
      payload: {},
    });
    await value.executions.createExecutionContext({ workspace_id: "workspace-a", task_id: TASK_ID,
      execution_id: EXECUTION_ID, command: "desktop codex_app" });
    await value.backend.reconcileOrphanedExecutions();
    await value.backend.reconcileOrphanedExecutions();
    expect(await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))
      .toMatchObject({ status: "running", summary: expect.stringContaining("executor_identity_unavailable") });
    expect((await value.sessions.getSession(session.session_id))?.status).toBe("active");
    expect(value.terminals).toHaveLength(0);
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.cliStart).not.toHaveBeenCalled();
  });

  it("keeps observing the dispatched task when target activation fails without dispatching a second task", async () => {
    const value = await fixture({ openDesktopThread: async () => { throw new Error("activation failed"); } });
    value.desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);
    await authorizeAndActuate(value, {}, "launch");
    expect(await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))
      .toMatchObject({ status: "running" });
    const session = (await value.sessions.listSessions())[0]!;
    expect(session.status).toBe("active");
    expect(value.desktop.runtimeCloseCount()).toBe(0);
    expect(value.terminals).toHaveLength(0);

    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
    await value.backend.whenIdle();
    expect(await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))
      .toMatchObject({ status: "passed" });
    expect((await value.sessions.getSession(session.session_id))?.status).toBe("completed");
    expect(value.terminals).toHaveLength(1);
    expect((await value.events.listEvents(session.session_id)).map((event) => event.event_type))
      .not.toContain("execution_failed");
    expect(value.desktop.createThreadCount()).toBe(1);
    expect(value.desktop.sendCount()).toBe(0);
    expect(value.desktop.runtimeCloseCount()).toBe(1);
    expect(value.cliStart).not.toHaveBeenCalled();
    expect(value.appServerStart).not.toHaveBeenCalled();
  });

  it("retains the Execution when CompletionObserver initialization rejects its configuration", async () => {
    const value = await fixture({ pollIntervalMs: -1 });
    await authorizeAndActuate(value, {}, "launch");
    await value.backend.whenIdle();
    expect(await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))
      .toMatchObject({ status: "running", summary: expect.stringContaining("unavailable") });
    expect((await value.sessions.listSessions())[0]!.status).toBe("active");
  });

  it("retains the Execution when CompletionObserver throws during observation", async () => {
    const observer = vi.spyOn(DesktopCompletionObserver.prototype, "waitForCompletion")
      .mockRejectedValue(new Error("observer initialization failed"));
    try {
      const value = await fixture();
      await authorizeAndActuate(value, {}, "launch");
      await value.backend.whenIdle();
      expect(await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))
        .toMatchObject({ status: "running", summary: expect.stringContaining("unavailable") });
      expect((await value.sessions.listSessions())[0]!.status).toBe("active");
    } finally { observer.mockRestore(); }
  });

  it("bounds repeated first-turn visibility errors while retaining Execution running", async () => {
    const observer = vi.spyOn(DesktopCompletionObserver.prototype, "waitForCompletion")
      .mockResolvedValue({ status: "unknown", reason: "first_turn_visibility_unavailable",
        targetThreadId: "target-thread-1", hostId: "local" });
    try {
      const value = await fixture({ completionTimeoutMs: 10 });
      await authorizeAndActuate(value, {}, "launch");
      await value.backend.whenIdle();
      expect(await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))
        .toMatchObject({ status: "running", summary: expect.stringContaining("unavailable") });
      // Exhausted observation retries retain the Execution without a terminal notification.
      expect(observer.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect((await value.sessions.listSessions())[0]!.status).toBe("active");
    } finally { observer.mockRestore(); }
  });

  it.each([
    ["Project unavailable", "create_thread failed: Project unavailable"],
    ["", "create_thread returned an error."],
  ])("persists create_thread provider error in failed Execution and Session: %s", async (text, summary) => {
    const value = await fixture();
    const original = value.desktop.runtime.mcpClient.callTool;
    value.desktop.runtime.mcpClient.callTool = async (params: CallToolRequestParams) => {
      if (params.name === "create_thread") {
        value.desktop.calls.push(params);
        return { isError: true, content: [{ type: "text", text }] };
      }
      return original(params);
    };
    await seedTask(value);
    const standaloneStart = vi.fn();
    const negotiator = new CapabilityNegotiator({
      desktop: {
        source: "desktop", prepare: async () => ({ ready: true }),
        start: (request) => value.backend.start(request),
      },
      standalone: { source: "standalone", prepare: async () => ({ ready: true }), start: standaloneStart },
    });
    await expect(negotiator.start(interactiveRequest())).rejects.toMatchObject({
      code: "tool_call_failed", message: expect.stringContaining(summary),
    });
    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    expect(execution).toMatchObject({ status: "failed", summary: expect.stringContaining(summary) });
    expect(execution?.summary).toContain("Desktop stage=create_thread");
    expect((await value.sessions.listSessions())[0]).toMatchObject({ status: "failed" });
    expect(value.desktop.createThreadCount()).toBe(1);
    expect(value.appServerStart).not.toHaveBeenCalled();
    expect(value.cliStart).not.toHaveBeenCalled();
    expect(standaloneStart).not.toHaveBeenCalled();
    expect(negotiator.snapshot(EXECUTION_ID)).toMatchObject({
      state: "desktop_failed", reason: "desktop_execution_failed", execution_id: EXECUTION_ID, actions: [],
    });
  });

  it("persists Execution, Session, and execution_failed before the listener for an authoritative turn failure", async () => {
    const value = await fixture();
    value.desktop.setTurns([{
      id: "turn-1",
      status: "completed",
      error: { code: "failed" },
      completedAt: 1,
    }]);
    const observed: Array<{
      readonly execution: string;
      readonly session: string;
      readonly event: string;
      readonly turnId: unknown;
    }> = [];
    value.service.setTerminalListener(async (execution) => {
      const session = (await value.sessions.listSessions())[0]!;
      const persisted = await value.executions.getExecutionContext(
        execution.workspace_id,
        execution.task_id,
        execution.execution_id,
      );
      const events = await value.events.listEvents(session.session_id);
      const failure = events.find((event) => event.event_type === "execution_failed");
      observed.push({
        execution: persisted?.status ?? "missing",
        session: session.status,
        event: failure?.event_type ?? "missing",
        turnId: failure !== undefined && "turn_id" in failure ? failure.turn_id : "absent",
      });
    });

    await authorizeAndActuate(value, {}, "terminal");

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      execution: "failed",
      session: "failed",
      event: "execution_failed",
    });
    // The failed Turn identity is authoritative; no completion event is fabricated.
    expect(observed[0]?.turnId).toBe("turn-1");
  });

  it("retains unknown completion without an execution_failed event", async () => {
    const value = await fixture();
    // Two first-seen turns make completion ambiguous, which is an unverifiable completion.
    value.desktop.setTurns([
      { id: "turn-1", status: "completed", completedAt: 1 },
      { id: "turn-2", status: "completed", completedAt: 2 },
    ]);
    await authorizeAndActuate(value, {}, "launch");
    await value.backend.whenIdle();

    const session = (await value.sessions.listSessions())[0]!;
    const events = await value.events.listEvents(session.session_id);
    const failure = events.find((event) => event.event_type === "execution_failed");
    expect(failure).toBeUndefined();
    expect(events.some((event) => event.event_type === "turn_completed")).toBe(false);
  });

  it("persists Session and Execution failure before the listener on a post-start launch failure", async () => {
    const value = await fixture();
    // Fail create_thread after Session and Execution already exist, so the launch failure happens
    // with a durable Session but before any Desktop target identity exists.
    const original = value.desktop.runtime.mcpClient.callTool;
    value.desktop.runtime.mcpClient.callTool = async (params: CallToolRequestParams) => {
      if (params.name === "create_thread") {
        // Record the attempt so the assertion sees the effectful call, then fail it.
        value.desktop.calls.push(params);
        return { isError: true, content: [{ type: "text", text: "create_thread rejected" }] };
      }
      return original(params);
    };

    const observed: Array<{ readonly execution: string; readonly session: string }> = [];
    value.service.setTerminalListener(async (execution) => {
      const session = (await value.sessions.listSessions())[0]!;
      const persisted = await value.executions.getExecutionContext(
        execution.workspace_id,
        execution.task_id,
        execution.execution_id,
      );
      observed.push({
        execution: persisted?.status ?? "missing",
        session: session.status,
      });
    });

    await seedTask(value);
    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();
    await value.backend.whenIdle();

    // No target was ever created, so no failure event may claim a thread identity.
    const session = (await value.sessions.listSessions())[0]!;
    const events = await value.events.listEvents(session.session_id);
    expect(events.some((event) => event.event_type === "execution_failed")).toBe(false);
    expect(events.some((event) => event.event_type === "session_started")).toBe(false);
    expect(value.desktop.createThreadCount()).toBe(1);

    // The listener, if it ran, must never observe Execution failed with a non-terminal Session.
    for (const entry of observed) {
      expect(entry.execution).toBe("failed");
      expect(entry.session).toBe("failed");
    }
    expect(observed.length).toBeLessThanOrEqual(1);
  });
});

describe("P5.4.1 FIX Desktop runtime ownership", () => {
  it("never closes a runtime that failed to connect", async () => {
    const desktop = fakeDesktop();
    desktop.failConnect(new Error("transport failed"));
    const value = await fixture({ desktop });
    await seedTask(value);

    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();

    // No runtime was ever acquired, so cleanup must not fabricate one.
    expect(value.desktop.runtimeCloseCount()).toBe(0);
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.appServerStart).not.toHaveBeenCalled();
  });

  it("closes the runtime exactly once when the tools contract is incompatible", async () => {
    const desktop = fakeDesktop();
    desktop.setListTools([{ name: "list_projects", inputSchema: { type: "object", properties: {} } }]);
    const value = await fixture({ desktop });
    await seedTask(value);

    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();

    expect(value.desktop.runtimeCloseCount()).toBe(1);
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.appServerStart).not.toHaveBeenCalled();
  });

  it("closes the runtime exactly once when no exact local project matches", async () => {
    const value = await fixture({ projectPath: "C:\\other\\project" });
    await seedTask(value);

    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();

    expect(value.desktop.runtimeCloseCount()).toBe(1);
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.appServerStart).not.toHaveBeenCalled();
  });

  it("closes the runtime exactly once when more than one exact local project matches", async () => {
    const desktop = fakeDesktop();
    const original = desktop.runtime.mcpClient.callTool;
    let workspacePath = OTHER_WORKSPACE_PATH;
    desktop.runtime.mcpClient.callTool = async (params: CallToolRequestParams) => {
      if (params.name !== "list_projects") return original(params);
      return jsonResult({
        projects: [
          { projectId: "project-1", hostId: "local", projectKind: "local", path: workspacePath },
          { projectId: "project-2", hostId: "local", projectKind: "local", path: workspacePath },
        ],
      });
    };
    const value = await fixture({ desktop });
    workspacePath = value.registry.active.manager.canonicalRoot;
    await seedTask(value);

    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();

    expect(value.desktop.runtimeCloseCount()).toBe(1);
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.appServerStart).not.toHaveBeenCalled();
  });

  it("closes the runtime exactly once when create_thread fails after the Session exists", async () => {
    const value = await fixture();
    const original = value.desktop.runtime.mcpClient.callTool;
    value.desktop.runtime.mcpClient.callTool = async (params: CallToolRequestParams) => {
      if (params.name === "create_thread") {
        // Record the attempt so the assertion sees the effectful call, then fail it.
        value.desktop.calls.push(params);
        return { isError: true, content: [{ type: "text", text: "create_thread rejected" }] };
      }
      return original(params);
    };

    await seedTask(value);
    await expect(value.service.start(interactiveRequest())).rejects.toBeDefined();
    await value.backend.whenIdle();

    expect(value.desktop.createThreadCount()).toBe(1);
    expect(value.desktop.runtimeCloseCount()).toBe(1);
    expect(value.appServerStart).not.toHaveBeenCalled();

    // The launch failure still projects terminal Session/Execution state before the listener.
    const session = (await value.sessions.listSessions())[0]!;
    expect(session.status).toBe("failed");
    const execution = await value.executions.getExecutionContext(
      "workspace-a",
      TASK_ID,
      EXECUTION_ID,
    );
    expect(execution?.status).toBe("failed");
  });

  it("keeps the runtime open through the completion watch and closes it once afterwards", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 2 }]);

    await authorizeAndActuate(value, {}, "terminal");

    // The watch owns the runtime: exactly one close, and only after the Execution terminated.
    expect(value.desktop.runtimeCloseCount()).toBe(1);
    const execution = await value.executions.getExecutionContext(
      "workspace-a",
      TASK_ID,
      EXECUTION_ID,
    );
    expect(execution?.status).toBe("passed");
    expect((await value.sessions.listSessions())[0]!.status).toBe("completed");
  });

  it("keeps the runtime open while the Desktop turn runs and closes it once on shutdown", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);

    await authorizeAndActuate(value, {}, "launch");
    expect(value.desktop.runtimeCloseCount()).toBe(0);

    await value.backend.close();
    await value.backend.whenIdle();
    expect(value.desktop.runtimeCloseCount()).toBe(1);
    const execution = await value.executions.getExecutionContext(
      "workspace-a",
      TASK_ID,
      EXECUTION_ID,
    );
    expect(execution?.status).toBe("running");
    expect((await value.sessions.listSessions())[0]!.status).toBe("active");
  });

  it("closes a runtime held in the active map when the backend is shut down", async () => {
    const value = await fixture();
    // A non-completing turn keeps the watch (and its runtime) active while close() runs.
    value.desktop.setTurns([]);
    await seedTask(value);

    const started = value.service.start(interactiveRequest());
    // Wait until the runtime has been registered as active before shutting the backend down.
    const deadline = Date.now() + 5_000;
    while (!value.desktop.calls.some((call) => call.name === "read_thread") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await value.backend.close();
    await started.catch(() => undefined);
    await value.backend.whenIdle();

    // Shutdown and the watch finally must not double close the same runtime.
    expect(value.desktop.runtimeCloseCount()).toBe(1);
  });
});


describe("terminal Session recovery", () => {
  it.each([ ["passed", false], ["failed", false], ["passed", true], ["failed", true] ] as const)(
    "recovers %s with persistent Session failure=%s", async (outcome, persistent) => {
      const value = await fixture({ pollIntervalMs: 1 });
      await seedTask(value);
      const registry = value.registry;
      const request = interactiveRequest();
      const sessions = value.sessions;
      const makeAuto = () => new AutoIterationService(registry, { storageRoot: value.root,
        browserRouter: new BrowserRouter(value.root, { deliver: async () => ({ status: "delivered", delivered_at: new Date().toISOString() }) }),
        completionRouter: new ReviewCompletionRouter(value.root, { collect: async input => ({ status: "COMPLETED",
          content: '<lrm-review-result>' + JSON.stringify({ schema_version: 1, review_request_id: input.review_request_id,
            decision: "APPROVE", summary: "Reviewed" }) + '</lrm-review-result>' }) }),
      });
      let auto = makeAuto();
      let notifications = 0;
      value.backend.setTerminalListener(async execution => { notifications++; await auto.onExecutionTerminal(execution); });
      const original = SessionStore.prototype.updateSession;
      let attempts = 0;
      const spy = vi.spyOn(SessionStore.prototype, "updateSession").mockImplementation(async function(this: SessionStore, id, patch) {
        if (this.storageRoot === value.root && patch.status === (outcome === "passed" ? "completed" : "failed")) {
          attempts++;
          if (persistent || attempts === 1) throw Object.assign(new Error("terminal publish occupied"), { code: "EPERM" });
        }
        return original.call(this, id, patch);
      });
      try {
        const started = await value.backend.start(request);
        await auto.start({ loop_id: "terminal-loop", workspace_id: request.workspace_id, task_id: request.task_id,
          conversation_id: "conversation-1", execution_id: request.execution_id, max_iterations: 2 });
        value.desktop.setTurns([{ id: "turn-1", status: outcome === "passed" ? "completed" : "failed", completedAt: 1 }]);
        await value.backend.whenIdle();
        expect(notifications).toBe(1);
        const terminal = await new ExecutionContextService(value.root).getExecutionContext(request.workspace_id, request.task_id, request.execution_id);
        expect(terminal?.status).toBe(outcome);
        await vi.waitFor(async () => expect((await auto.getLoop("terminal-loop"))?.stage).toBe(outcome === "passed" ? "completed" : "failed"));
        const loop = await auto.getLoop("terminal-loop");
        expect(loop?.stage).toBe(outcome === "passed" ? "completed" : "failed");
        const reviewId = loop?.review_request_id;
        await Promise.all([auto.onExecutionTerminal(terminal!), auto.onExecutionTerminal(terminal!)]);
        expect((await auto.getLoop("terminal-loop"))?.review_request_id).toBe(reviewId);
        if (!persistent) expect((await sessions.getSession(started.session_id!))?.status).toBe(outcome === "passed" ? "completed" : "failed");
        spy.mockRestore();
        await value.backend.close();
        auto.dispose();
        auto = makeAuto();
        const restarted = new DesktopCodexBackend(registry, { storageRoot: value.root, runtimeFactory: { connect: async () => { throw new Error("must not redispatch"); } } });
        restarted.setTerminalListener(execution => auto.onExecutionTerminal(execution));
        try {
          await restarted.reconcileOrphanedExecutions();
          await auto.recover();
          await restarted.reconcileOrphanedExecutions();
          expect((await sessions.getSession(started.session_id!))?.status).toBe(outcome === "passed" ? "completed" : "failed");
          expect((await auto.getLoop("terminal-loop"))?.review_request_id).toBe(reviewId);
          expect((await auto.getLoop("terminal-loop"))?.stage).toBe(outcome === "passed" ? "completed" : "failed");
        } finally { await restarted.close(); }
      } finally { spy.mockRestore(); auto.dispose(); await value.backend.close(); }
    });
});

it.each(["passed", "failed"] as const)("restarts from durable %s with an unsynchronized Loop", async outcome => {
  const value = await fixture({ pollIntervalMs: 1 });
  await seedTask(value);
  const registry = value.registry;
  const request = interactiveRequest();
  const makeAuto = () => new AutoIterationService(registry, { storageRoot: value.root,
    browserRouter: new BrowserRouter(value.root, { deliver: async () => ({ status: "delivered", delivered_at: new Date().toISOString() }) }),
    completionRouter: new ReviewCompletionRouter(value.root, { collect: async input => ({ status: "COMPLETED",
      content: '<lrm-review-result>' + JSON.stringify({ schema_version: 1, review_request_id: input.review_request_id,
      decision: "APPROVE", summary: "Reviewed" }) + '</lrm-review-result>' }) }),
  });
  let auto = makeAuto();
  const notify = vi.fn(async () => { throw new Error("terminal listener unavailable"); });
  value.backend.setTerminalListener(notify);
  const original = SessionStore.prototype.updateSession;
  const spy = vi.spyOn(SessionStore.prototype, "updateSession").mockImplementation(async function(this: SessionStore, id, patch) {
    if (this.storageRoot === value.root && (patch.status === "completed" || patch.status === "failed")) throw new Error("Session unavailable");
    return original.call(this, id, patch);
  });
  try {
    const started = await value.backend.start(request);
    await auto.start({ loop_id: "restart-loop", workspace_id: request.workspace_id, task_id: request.task_id,
      execution_id: request.execution_id, conversation_id: "conversation-1", max_iterations: 2 });
    value.desktop.setTurns([{ id: "turn-1", status: outcome === "passed" ? "completed" : "failed", completedAt: 1 }]);
    await value.backend.whenIdle();
    expect((await auto.getLoop("restart-loop"))?.stage).toBe("execution");
    await value.backend.close(); auto.dispose(); spy.mockRestore();
    auto = makeAuto();
    const restarted = new DesktopCodexBackend(registry, { storageRoot: value.root, runtimeFactory: { connect: async () => { throw new Error("unexpected dispatch"); } } });
    restarted.setTerminalListener(execution => auto.onExecutionTerminal(execution));
    try {
      await restarted.reconcileOrphanedExecutions();
      expect((await auto.getLoop("restart-loop"))?.stage).toBe(outcome === "passed" ? "completed" : "failed");
      expect((await new SessionStore(value.root).getSession(started.session_id!))?.status).toBe(outcome === "passed" ? "completed" : "failed");
      await restarted.reconcileOrphanedExecutions();
      expect(await new ExecutionContextService(value.root).listExecutions(request.workspace_id, request.task_id)).toHaveLength(1);
    } finally { await restarted.close(); }
  } finally { spy.mockRestore(); auto.dispose(); await value.backend.close(); }
});

it("recovers Pending identity persistence before desktop Interactive dispatch without a duplicate start", async () => {
  const value = await fixture();
  const correlations = new ConversationCorrelationRegistry(value.root);
  const goals = new GoalOrchestrationService(value.registry, { storageRoot: value.root,
    controlledActuation: value.controlled, authorizationStore: value.controlled.authorizationStore });
  const submission = new GoalSubmissionService(goals, { checkGoalPreflight: async input => ({ ready: true,
    runtime: { ready: true }, connector: { ready: true }, extension: { ready: true },
    workspace: { valid: true, workspace_id: input.workspace_id }, conversation: { valid: true, conversation_id: input.conversation_id } }) });
  const pending = new PendingGoalSubmissionService(correlations, submission, { storageRoot: value.root,
    browserReadiness: () => ({ ready: true, readiness_state: "ready" }) });
  const key = "00000000-0000-4000-8000-000000000098";
  const proof = { request_id: key, conversation_id: "conversation-001", document_id: "document-1", navigation_epoch: 1 };
  const persistence = pending as unknown as { persist(records: Map<string, { state: string }>): Promise<void> };
  const persist = persistence.persist.bind(pending);
  let failures = 0;
  const spy = vi.spyOn(persistence, "persist").mockImplementation(async records => {
    if (records.get(key)?.state === "starting" && failures++ < 2) throw Object.assign(new Error("Pending publish locked"), { code: "EPERM" });
    await persist(records);
  });
  try {
    await pending.accept({ correlation_key: key, workspace_id: "workspace-a", title: "Interactive identity retry",
      goal: "Start once", requirements: ["Use interactive"], acceptance_criteria: ["No duplicate dispatch"], execution_mode: "interactive" });
    await pending.receiveIdentityEvidence(proof);
    await vi.waitFor(async () => expect((await pending.get(key))?.state).toBe("started"));
    await Promise.all([pending.resolve(key), pending.resolve(key), pending.receiveIdentityEvidence(proof)]);
    expect(value.cliStart).not.toHaveBeenCalled();
    expect(value.appServerStart).not.toHaveBeenCalled();
    expect(value.desktop.createThreadCount()).toBe(1);
    expect(await value.sessions.listSessions()).toHaveLength(1);
    const record = (await pending.get(key))!;
    if (record.state !== "started") throw new Error("Pending did not start");
    expect(await value.executions.listExecutions("workspace-a", record.task_id)).toHaveLength(1);
  } finally { spy.mockRestore(); await value.service.close(); }
});
