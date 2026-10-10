import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolRequestParams, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliExecutionBackend,
  ExecutionBackendRouter,
  ExecutionService,
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
import { TaskContextService } from "../src/context/service.js";
import { EventStore } from "../src/control-plane/events/store.js";
import { DesktopCodexBackend } from "../src/desktop-codex/desktop-codex-backend.js";
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
import { AutoIterationService } from "../src/control-plane/auto-iteration.js";
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
            turns: turns.map((turn) => ({
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
  overrides: Partial<ActuationAuthorizationInput> = {},
  waitForTerminal = true,
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
  if (waitForTerminal) {
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
    const value = await fixture({ desktop });
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
        desktop.setTurns([{ id: `turn-${round}`, status: "completed", completedAt: 1 }]);
        await value.backend.whenIdle();
        desktop.setTurns([]);
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
      }
      expect((await goals.getGoal(GOAL_ID))?.status).toBe("completed");
      const sessions = await value.sessions.listSessions();
      expect(sessions).toHaveLength(mode === "interactive" ? 3 : 0);
      expect(desktop.createThreadCount()).toBe(mode === "interactive" ? 3 : 0);
      expect(value.cliStart).toHaveBeenCalledTimes(mode === "batch" ? 3 : 0);
      if (mode === "interactive") {
        expect(new Set(sessions.map((session) => session.thread_id)).size).toBe(3);
        for (const call of desktop.calls.filter((call) => call.name === "create_thread")) {
          expect(call.arguments).toMatchObject({ model: "gpt-5.6-luna", thinking: "max" });
        }
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
    await authorizeAndActuate(value);
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
    await authorizeAndActuate(value);

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

    await authorizeAndActuate(value, { model_id: "gpt-5.6-luna", reasoning_effort: "max" });

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

  it("keeps the Desktop route unchanged when no provider model is given", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);

    await authorizeAndActuate(value);

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
    await authorizeAndActuate(value);

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

  it("never persists the executor identity into Session, binding, or Execution", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "completed", completedAt: 1 }]);
    await authorizeAndActuate(value);

    const session = (await value.sessions.listSessions())[0]!;
    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    const binding = await new DesktopThreadBindingStore(value.root).load("workspace-a", session.session_id);
    const sessionRaw = await readFile(
      join(value.root, ".task", "sessions", session.session_id + ".json"),
      "utf8",
    );

    expect(sessionRaw).not.toContain("executor-conversation-1");
    expect(JSON.stringify(execution)).not.toContain("executor-conversation-1");
    expect(JSON.stringify(binding)).not.toContain("executor-conversation-1");
    expect(session.thread_id).not.toBe("executor-conversation-1");
  });

  it("fails closed when a newly created target already shows more than one new turn", async () => {
    const value = await fixture();
    value.desktop.setTurns([
      { id: "turn-1", status: "completed", completedAt: 1 },
      { id: "turn-2", status: "completed", completedAt: 2 },
    ]);
    await authorizeAndActuate(value);

    const execution = await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID);
    expect(execution?.status).toBe("failed");
    expect(execution?.summary).toContain("ambiguous_new_turn");
    expect((await value.sessions.listSessions())[0]!.status).toBe("failed");
    expect(value.terminals).toHaveLength(1);
  });

  it("keeps the Execution running while the Desktop turn is in progress", async () => {
    const value = await fixture();
    value.desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);
    await authorizeAndActuate(value, {}, false);
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

    await authorizeAndActuate(value);

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
    await authorizeAndActuate(value);

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
    await authorizeAndActuate(value);

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
    await authorizeAndActuate(value);
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

    await authorizeAndActuate(value);

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
    await authorizeAndActuate(value);

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
    await authorizeAndActuate(value);

    // Exactly one capture happens per Execution; the project resolver reuses that value.
    expect(seen).toHaveLength(1);
    const listProjects = value.desktop.calls.find((call) => call.name === "list_projects");
    const createThread = value.desktop.calls.find((call) => call.name === "create_thread");
    expect(listProjects?._meta?.["openai/threadId"]).toBe("executor-1");
    expect(createThread?._meta?.["openai/threadId"]).toBe("executor-1");
  });
});

describe("P5.4.1 FIX failure terminal projection", () => {
  it("fails Desktop orphans after Host restart once without creating or resending a thread", async () => {
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
      .toMatchObject({ status: "failed", summary: expect.stringContaining("previous runtime shutdown") });
    expect((await value.sessions.getSession(session.session_id))?.status).toBe("failed");
    expect(value.terminals).toHaveLength(1);
    expect(value.desktop.createThreadCount()).toBe(0);
    expect(value.cliStart).not.toHaveBeenCalled();
  });

  it("keeps observing the dispatched task when target activation fails without dispatching a second task", async () => {
    const value = await fixture({ openDesktopThread: async () => { throw new Error("activation failed"); } });
    value.desktop.setTurns([{ id: "turn-1", status: "inProgress", completedAt: null }]);
    await authorizeAndActuate(value, {}, false);
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

  it("fails the Execution when CompletionObserver initialization rejects its configuration", async () => {
    const value = await fixture({ pollIntervalMs: -1 });
    await authorizeAndActuate(value);
    expect(await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))
      .toMatchObject({ status: "failed", summary: expect.stringContaining("pollIntervalMs") });
    expect((await value.sessions.listSessions())[0]!.status).toBe("failed");
  });

  it("fails the Execution when CompletionObserver throws during observation", async () => {
    const observer = vi.spyOn(DesktopCompletionObserver.prototype, "waitForCompletion")
      .mockRejectedValue(new Error("observer initialization failed"));
    try {
      const value = await fixture();
      await authorizeAndActuate(value);
      expect(await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))
        .toMatchObject({ status: "failed", summary: expect.stringContaining("observer initialization failed") });
      expect((await value.sessions.listSessions())[0]!.status).toBe("failed");
    } finally { observer.mockRestore(); }
  });

  it("bounds repeated first-turn visibility and tool errors instead of leaving Execution running", async () => {
    const observer = vi.spyOn(DesktopCompletionObserver.prototype, "waitForCompletion")
      .mockResolvedValue({ status: "unknown", reason: "first_turn_visibility_unavailable",
        targetThreadId: "target-thread-1", hostId: "local" });
    try {
      const value = await fixture({ completionTimeoutMs: 10 });
      await authorizeAndActuate(value);
      expect(await value.executions.getExecutionContext("workspace-a", TASK_ID, EXECUTION_ID))
        .toMatchObject({ status: "failed", summary: "Desktop turn completion observation unavailable." });
      // Timer granularity can require another observation; terminal state, not an exact count, is the contract.
      expect(observer.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect((await value.sessions.listSessions())[0]!.status).toBe("failed");
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

    await authorizeAndActuate(value);

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      execution: "failed",
      session: "failed",
      event: "execution_failed",
    });
    // A failed turn has no completion event, so it must not be fabricated.
    expect(observed[0]?.turnId).toBe("absent");
  });

  it("persists an execution_failed event without a fabricated turn id for unknown completion", async () => {
    const value = await fixture();
    // Two first-seen turns make completion ambiguous, which is an unverifiable completion.
    value.desktop.setTurns([
      { id: "turn-1", status: "completed", completedAt: 1 },
      { id: "turn-2", status: "completed", completedAt: 2 },
    ]);
    await authorizeAndActuate(value);

    const session = (await value.sessions.listSessions())[0]!;
    const events = await value.events.listEvents(session.session_id);
    const failure = events.find((event) => event.event_type === "execution_failed");
    expect(failure).toBeDefined();
    expect("turn_id" in failure! ? failure!.turn_id : undefined).toBeUndefined();
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

    await authorizeAndActuate(value);

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

    await authorizeAndActuate(value, {}, false);
    expect(value.desktop.runtimeCloseCount()).toBe(0);

    await value.backend.close();
    await value.backend.whenIdle();
    expect(value.desktop.runtimeCloseCount()).toBe(1);
    const execution = await value.executions.getExecutionContext(
      "workspace-a",
      TASK_ID,
      EXECUTION_ID,
    );
    expect(execution?.status).toBe("failed");
    expect((await value.sessions.listSessions())[0]!.status).toBe("failed");
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
