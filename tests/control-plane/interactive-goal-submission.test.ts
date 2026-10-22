import { PendingGoalSubmissionService, PENDING_GOAL_SUBMISSION_TTL_MS } from "../../src/control-plane/pending-goal-submission.js";
import { ConversationCorrelationRegistry } from "../../src/control-plane/conversation-correlation.js";
import { BrowserRouter } from "../../src/router/browser-router.js";
import { ReviewCompletionRouter } from "../../src/router/review-completion-router.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutoIterationService,
  autoIterationSchema,
  type AutoIteration,
  type AutoIterationStartInput,
} from "../../src/control-plane/auto-iteration.js";
import {
  ActuationAuthorizationStore,
  ControlledActuationService,
} from "../../src/control-plane/controlled-actuation.js";
import {
  CliExecutionBackend,
  ExecutionBackendRouter,
  ExecutionService,
  type ExecutionBackendStartRequest,
  type ExecutionStartResult,
} from "../../src/control-plane/execution-service.js";
import { CodexAppServerBackend, type AppServerClientFactory } from "../../src/backends/codex_app_server/backend.js";
import type { CodexAppServerEvent } from "../../src/backends/codex_app_server/events.js";
import type { CodexAppServerExit, CodexAppServerProcessInfo, AppServerModel, AppServerThread, AppServerTurn } from "../../src/backends/codex_app_server/models.js";
import { GoalOrchestrationService } from "../../src/control-plane/goal-orchestration.js";
import type { GoalPreflightInput, GoalPreflightResult } from "../../src/control-plane/goal-preflight.js";
import { ExecutionRoutingService } from "../../src/control-plane/execution-routing.js";
import { GoalStartError, GoalSubmissionService, type GoalSubmissionRequest } from "../../src/control-plane/goal-submission.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { ReviewRequestService } from "../../src/context/review-request-service.js";
import type { ExecutionContext } from "../../src/context/types.js";
import { SessionStore } from "../../src/context/session-store.js";
import { TaskContextService } from "../../src/context/service.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { CapabilityNegotiator, StandaloneCapabilityProvider } from "../../src/control-plane/capability-negotiation.js";

const temporaryDirectories: string[] = [];

function legacyTextReviewRequests(root: string): ReviewRequestService {
  const service = new ReviewRequestService(root);
  const create = service.createReviewRequest.bind(service);
  service.createReviewRequest = (input) => create({ ...input, verdict_protocol: "text_v1" });
  return service;
}

it("expires a repeated authenticated submission without changing the running Goal, Execution or Session", async () => {
  const value = await fixture();
  let now = Date.now();
  const pending = new PendingGoalSubmissionService(new ConversationCorrelationRegistry(value.root), value.submit, {
    storageRoot: value.root, now: () => now,
    browserReadiness: () => ({ ready: true, readiness_state: "ready" }),
  });
  const keyA = "00000000-0000-4000-8000-000000000091";
  const keyB = "00000000-0000-4000-8000-000000000092";
  const payload = { workspace_id: "workspace-a", title: "Same task", goal: "Fix the same code",
    requirements: ["Preserve contracts"], acceptance_criteria: ["Tests pass"], execution_mode: "interactive" as const };
  try {
    await pending.accept({ ...payload, correlation_key: keyA });
    await pending.receiveIdentityEvidence({ request_id: keyA, conversation_id: "conversation-001", document_id: "document-1", navigation_epoch: 1 });
    await vi.waitFor(async () => expect((await pending.get(keyA))?.state).toBe("started"));
    const first = (await pending.get(keyA))!;
    if (first.state !== "started") throw new Error("first submission did not start");
    const goal = await value.goals.getGoal(first.goal_id);
    const execution = await value.executions.getExecutionContext("workspace-a", first.task_id, first.execution_id);
    const sessions = await value.sessions.listSessions();
    expect(sessions).toHaveLength(1);
    await pending.accept({ ...payload, correlation_key: keyB }, { source: "authenticated_mcp_invocation" });
    await pending.resolve(keyB);
    expect((await pending.get(keyB))?.state).toBe("pending_identity");
    now += PENDING_GOAL_SUBMISSION_TTL_MS;
    await pending.expire(keyB);
    await pending.resolve(keyB);
    await pending.receiveIdentityEvidence({ request_id: keyB, conversation_id: "conversation-001", document_id: "document-1", navigation_epoch: 1 });
    expect(await pending.get(keyB)).toMatchObject({ state: "failed", error: "pending_identity_expired" });
    expect(await pending.get(keyA)).toEqual(first);
    expect(await value.goals.getGoal(first.goal_id)).toEqual(goal);
    expect(await value.executions.getExecutionContext("workspace-a", first.task_id, first.execution_id)).toEqual(execution);
    expect(await value.sessions.listSessions()).toEqual(sessions);
    expect(value.appClient.thread).toHaveBeenCalledTimes(1);
    expect(value.appClient.turn).toHaveBeenCalledTimes(1);
  } finally {
    value.goals.dispose();
    await value.executionService.close();
  }
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

class FakeEventStream implements AsyncIterable<CodexAppServerEvent>, AsyncIterator<CodexAppServerEvent> {
  private readonly values: CodexAppServerEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<CodexAppServerEvent>) => void> = [];
  private ended = false;

  public push(value: CodexAppServerEvent): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ done: false, value });
    else this.values.push(value);
  }

  public close(): void {
    this.ended = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ done: true, value: undefined as never });
  }

  public next(): Promise<IteratorResult<CodexAppServerEvent>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.ended) return Promise.resolve({ done: true, value: undefined as never });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  public [Symbol.asyncIterator](): AsyncIterator<CodexAppServerEvent> {
    return this;
  }
}

class FakeAppServerClient {
  public readonly processInfo: CodexAppServerProcessInfo = {
    process_id: 9_001,
    codex_version: "fake",
    transport: "stdio",
    status: "ready",
  };
  public readonly thread = vi.fn(async (input: { cwd: string; model?: string }): Promise<AppServerThread> => ({
    thread_id: "thread-001",
    session_id: "provider-session-001",
    ...(input.model === undefined ? {} : { model_id: input.model }),
    cwd: input.cwd,
  }));
  public readonly turn = vi.fn(async (_input: {
    threadId: string;
    text: string;
    model?: string;
    effort?: string;
  }): Promise<AppServerTurn> => ({
    turn_id: "turn-001",
    status: "in_progress",
  }));
  public readonly stream = new FakeEventStream();
  public readonly readThread = vi.fn(async (input: { threadId: string }) => ({
    thread_id: input.threadId, cwd: "", turns: [],
  }));
  public readonly resumeThread = vi.fn(async (input: { threadId: string; cwd: string }) => ({
    thread_id: input.threadId, cwd: input.cwd, turns: [],
  }));
  public readonly close = vi.fn(async (): Promise<CodexAppServerExit> => {
    this.stream.close();
    return {
      process_id: this.processInfo.process_id,
      exit_code: 0,
      signal: null,
      stdout: "",
      stderr: "",
    };
  });

  public async listModels(): Promise<readonly AppServerModel[]> {
    return [{
      model_id: "provider-default",
      display_name: "Provider default",
      reasoning_efforts: ["high"],
      default_effort: "high",
      is_default: true,
    }];
  }

  public startThread(input: { cwd: string; model?: string }): Promise<AppServerThread> {
    return this.thread(input);
  }

  public startTurn(input: {
    threadId: string;
    text: string;
    model?: string;
    effort?: string;
  }): Promise<AppServerTurn> {
    return this.turn(input);
  }

  public events(): AsyncIterable<CodexAppServerEvent> {
    return this.stream;
  }
}

function preflight(input: GoalPreflightInput): GoalPreflightResult {
  return {
    ready: true,
    runtime: { ready: true },
    connector: { ready: true, status: "verified", action: "none" },
    extension: { ready: true, paired: true, present: true, bridge_available: true },
    workspace: { valid: true, workspace_id: input.workspace_id },
    conversation: { valid: true, conversation_id: input.conversation_id },
  };
}

function request(execution_mode?: "batch" | "interactive"): GoalSubmissionRequest {
  return {
    workspace_id: "workspace-a",
    conversation_id: "conversation-001",
    title: "Interactive Goal",
    goal: "Run the requested Goal.",
    requirements: ["Use the selected execution backend."],
    acceptance_criteria: ["The selected backend starts exactly once."],
    ...(execution_mode === undefined ? {} : { execution_mode }),
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for interactive execution");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(options: { readonly terminalRouting?: boolean } = {}): Promise<{
  readonly root: string;
  readonly workspaceRoot: string;
  readonly executions: ExecutionContextService;
  readonly sessions: SessionStore;
  readonly cliStart: ReturnType<typeof vi.fn>;
  readonly appClient: FakeAppServerClient;
  readonly appFactory: ReturnType<typeof vi.fn>;
  readonly executionService: ExecutionService;
  readonly goals: GoalOrchestrationService;
  readonly controlled: ControlledActuationService;
  readonly auto: AutoIterationService | undefined;
  readonly terminalListener: ReturnType<typeof vi.fn>;
  readonly submit: GoalSubmissionService;
}> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-interactive-goal-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-interactive-workspace-"));
  temporaryDirectories.push(root, workspaceRoot);
  const registry = new WorkspaceRegistry([{ id: "workspace-a", name: "Workspace A", path: workspaceRoot }]);
  const tasks = new TaskContextService(root);
  const executions = new ExecutionContextService(root);
  const sessions = new SessionStore(root);
  const appClient = new FakeAppServerClient();
  const appFactory = vi.fn<AppServerClientFactory>(async () => appClient);
  const appBackend = new CodexAppServerBackend(registry, {
    storageRoot: root,
    clientFactory: appFactory,
  });
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
  const executionService = new ExecutionService(new ExecutionBackendRouter({
    batch: new CliExecutionBackend({ start: cliStart }),
    interactive: new CapabilityNegotiator({
      desktop: { source: "desktop", prepare: async () => ({ ready: false, reason: "desktop_disconnected" }),
        start: async () => { throw new Error("Disconnected Desktop must not start"); } },
      standalone: new StandaloneCapabilityProvider(appBackend),
      desktopTimeoutMs: 0,
      fallbackAfkTimeoutMs: 0,
    }),
  }));
  const authorizations = new ActuationAuthorizationStore(root);
  const controlled = new ControlledActuationService(registry, {
    storageRoot: root,
    authorizationStore: authorizations,
    taskContextService: tasks,
    executionContextService: executions,
    adapter: executionService,
  });
  const loops = new Map<string, AutoIteration>();
  const runtimeAuto = options.terminalRouting ? new AutoIterationService(registry, {
    storageRoot: root,
    reviewRequestService: legacyTextReviewRequests(root),
    taskContextService: tasks,
    executionContextService: executions,
    controlledActuation: controlled,
    browserRouter: new BrowserRouter(root, {
      deliver: async () => ({ status: "delivered", delivered_at: new Date().toISOString() }),
    }),
    completionRouter: new ReviewCompletionRouter(root, {
      collect: async ({ review_request_id }) => ({
        status: "COMPLETED",
        content: `<lrm-review-result>${JSON.stringify({
          schema_version: 1,
          review_request_id,
          decision: "APPROVE",
          summary: "The completed execution passed review.",
        })}</lrm-review-result>`,
      }),
    }),
  }) : undefined;
  const auto = runtimeAuto ?? {
    start: vi.fn(async (input: AutoIterationStartInput): Promise<AutoIteration> => {
      const existing = loops.get(input.loop_id);
      if (existing !== undefined) return structuredClone(existing);
      const timestamp = new Date().toISOString();
      const loop = autoIterationSchema.parse({
        ...input,
        initial_execution_id: input.execution_id,
        iteration: 1,
        stage: "execution",
        created_at: timestamp,
        updated_at: timestamp,
      });
      loops.set(loop.loop_id, loop);
      return structuredClone(loop);
    }),
    getLoop: vi.fn(async (loopId: string) => structuredClone(loops.get(loopId) ?? null)),
    advance: vi.fn(async (loopId: string) => structuredClone(loops.get(loopId)!)),
  };
  const orchestration = new GoalOrchestrationService(registry, {
    storageRoot: root,
    taskContextService: tasks,
    executionContextService: executions,
    authorizationStore: authorizations,
    controlledActuation: controlled,
    autoIteration: auto,
  });
  let router: ExecutionRoutingService | undefined;
  const terminalListener = vi.fn((execution: ExecutionContext) => router!.onExecutionTerminal(execution));
  if (runtimeAuto !== undefined) {
    runtimeAuto.setTerminalListener((loop) => orchestration.onAutoIterationTerminal(loop));
    router = new ExecutionRoutingService(registry, {
      storageRoot: root,
      taskContextService: tasks,
      executionContextService: executions,
      autoIteration: runtimeAuto,
      goalOrchestration: orchestration,
    });
    executionService.setTerminalListener(terminalListener);
  }
  return {
    root,
    workspaceRoot,
    executions,
    sessions,
    cliStart,
    appClient,
    appFactory,
    executionService,
    goals: orchestration,
    controlled,
    auto: runtimeAuto,
    terminalListener,
    submit: new GoalSubmissionService(orchestration, { checkGoalPreflight: async (input) => preflight(input) }),
  };
}

describe("interactive Goal submission", () => {
  it.each([
    { model: "provider-missing", code: "model_unknown", effort: undefined },
    { model: "provider-default", code: "reasoning_effort_unsupported", effort: "low" },
  ])("rejects $code before provider dispatch and keeps model diagnostics", async ({ model, code, effort }) => {
    const value = await fixture();
    try {
      await expect(value.submit.submitExternalGoal({ ...request(), model, reasoning_effort: effort }))
        .rejects.toMatchObject({ state: "failed", result: expect.objectContaining({ status: "failed" }), message: expect.stringContaining("stage=model_validation") });
      expect(value.appClient.thread).not.toHaveBeenCalled();
      expect(value.appClient.turn).not.toHaveBeenCalled();
      expect(value.cliStart).not.toHaveBeenCalled();
      const session = (await value.sessions.listSessions())[0]!;
      expect(session.status).toBe("failed");
      expect((await value.executions.listExecutions("workspace-a", session.task_id))[0])
        .toMatchObject({ status: "failed", summary: expect.stringContaining(`stage=model_validation model=${model}`) });
      expect((await value.executions.listExecutions("workspace-a", session.task_id))[0]!.summary)
        .toContain(code === "model_unknown" ? "Unknown model" : "not supported");
    } finally { await value.executionService.close(); }
  });
  it("defaults omitted execution mode to the interactive backend", async () => {
    const value = await fixture();
    const submitted = await value.submit.submitExternalGoal(request());

    expect(submitted.status).toBe("running");
    expect(value.cliStart).not.toHaveBeenCalled();
    expect(value.appFactory).toHaveBeenCalledTimes(1);
    expect(await value.sessions.listSessions()).toHaveLength(1);
    await value.executionService.close();
  });

  it("keeps the explicit batch route on the existing CLI backend", async () => {
    const value = await fixture();
    const submitted = await value.submit.submitExternalGoal(request("batch"));

    expect(submitted.status).toBe("running");
    expect(value.cliStart).toHaveBeenCalledTimes(1);
    expect(value.cliStart).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: "workspace-a",
      instruction: expect.any(String),
    }));
    expect(value.appFactory).not.toHaveBeenCalled();
    expect(await value.sessions.listSessions()).toEqual([]);
  });

  it("creates a Session, binds the Thread, and starts one Turn", async () => {
    const value = await fixture();
    const submitted = await value.submit.submitExternalGoal(request("interactive"));
    const session = (await value.sessions.listSessions())[0]!;

    expect(submitted.status).toBe("running");
    expect(value.cliStart).not.toHaveBeenCalled();
    expect(value.appFactory).toHaveBeenCalledTimes(1);
    expect(session).toMatchObject({
      goal_id: submitted.goal_id,
      task_id: submitted.task_id,
      backend_type: "codex_app_server",
      status: "active",
      thread_id: "thread-001",
      model_id: "provider-default",
      reasoning_effort: "high",
    });
    expect(value.appClient.thread).toHaveBeenCalledWith({
      cwd: value.workspaceRoot,
      model: "provider-default",
    });
    expect(value.appClient.turn).toHaveBeenCalledWith({
      threadId: "thread-001",
      text: expect.stringContaining("Run the requested Goal."),
      model: "provider-default",
      effort: "high",
    });
    await expect(value.executions.getExecutionContext(
      "workspace-a",
      submitted.task_id,
      submitted.execution_id,
    )).resolves.toMatchObject({ status: "running", process_id: 9_001 });

    value.appClient.stream.push({
      type: "turn_completed",
      thread_id: "thread-001",
      turn_id: "turn-001",
    });
    await waitFor(async () => (await value.sessions.getSession(session.session_id))?.status === "completed");
    await expect(value.executions.getExecutionContext(
      "workspace-a",
      submitted.task_id,
      submitted.execution_id,
    )).resolves.toMatchObject({ status: "passed" });
    await value.executionService.close();
  });

  it("queues an initial terminated Goal callback without waiting on its active start operation", async () => {
    const value = await fixture({ terminalRouting: true });
    const actualAdvance = value.goals.advanceGoal.bind(value.goals);
    const advance = vi.spyOn(value.goals, "advanceGoal")
      .mockImplementation((goalId) => actualAdvance(goalId));
    const recovery = vi.spyOn(value.goals, "scheduleRecovery");
    value.appClient.turn.mockRejectedValueOnce(new Error("turn/start response lost"));
    let timer: NodeJS.Timeout | undefined;
    const timeout = Symbol("start timeout");
    try {
      const outcome = await Promise.race([
        value.submit.submitExternalGoal({ ...request(), execution_mode: "interactive" })
          .then((result) => ({ result }), (error: unknown) => ({ error })),
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), 1_000);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      expect(outcome).not.toBe(timeout);
      if (outcome === timeout) throw new Error("Initial Goal start waited on its terminal callback");
      expect("error" in outcome && outcome.error).toBeInstanceOf(GoalStartError);
      if (!("error" in outcome) || !(outcome.error instanceof GoalStartError)) {
        throw new Error("Expected an indeterminate initial Goal start");
      }
      const { goal_id, task_id, execution_id } = outcome.error.result;
      const goal = await value.goals.getGoal(goal_id);
      expect(goal).toMatchObject({ status: "human_required" });
      expect(value.terminalListener).toHaveBeenCalledOnce();
      expect(value.terminalListener).toHaveBeenCalledWith(expect.objectContaining({ status: "terminated" }));
      expect(advance).toHaveBeenCalledExactlyOnceWith(goal_id);
      await expect(advance.mock.results[0]!.value).resolves.toMatchObject({ status: "human_required" });
      await expect(value.executions.getExecutionContext("workspace-a", task_id, execution_id))
        .resolves.toMatchObject({ status: "terminated", summary: expect.stringContaining("outcome unknown; no retry") });
      await expect(value.controlled.getActuation(goal!.actuation_id!)).resolves.toMatchObject({ status: "starting" });
      await expect(value.sessions.listSessions()).resolves.toMatchObject([
        expect.objectContaining({ goal_id, thread_id: "thread-001", status: "terminated" }),
      ]);
      await expect(value.goals.startGoal({ goal_id })).resolves.toMatchObject({ status: "human_required" });
      expect(value.appClient.thread).toHaveBeenCalledTimes(1);
      expect(value.appClient.turn).toHaveBeenCalledTimes(1);

      advance.mockImplementationOnce(async () => { throw new Error("temporary Goal read failure"); });
      const terminal = await value.executions.getExecutionContext("workspace-a", task_id, execution_id);
      await value.terminalListener(terminal!);
      expect(recovery).toHaveBeenCalledWith(goal_id);
      await expect(advance.mock.results[1]!.value).rejects.toThrow("temporary Goal read failure");
      await vi.waitFor(() => expect(advance).toHaveBeenCalledTimes(3), { timeout: 2_500 });
      await expect(advance.mock.results[2]!.value).resolves.toMatchObject({ status: "human_required" });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      value.auto?.dispose();
      value.goals.dispose();
      await value.executionService.close();
    }
  });

  it("keeps an explicit initial AppServer failure on the failed Goal path", async () => {
    const value = await fixture({ terminalRouting: true });
    value.appClient.turn.mockResolvedValueOnce({ turn_id: "turn-001", status: "failed" });
    try {
      const error = await value.submit.submitExternalGoal({ ...request(), execution_mode: "interactive" })
        .then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(GoalStartError);
      if (!(error instanceof GoalStartError)) throw new Error("Expected explicit Goal start failure");
      const { goal_id, task_id, execution_id } = error.result;
      expect(error.state).toBe("failed");
      await expect(value.goals.getGoal(goal_id)).resolves.toMatchObject({ status: "failed" });
      await expect(value.executions.getExecutionContext("workspace-a", task_id, execution_id))
        .resolves.toMatchObject({ status: "failed" });
      expect(value.terminalListener).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
      expect(value.appClient.turn).toHaveBeenCalledTimes(1);
    } finally {
      value.auto?.dispose();
      value.goals.dispose();
      await value.executionService.close();
    }
  });

  it("advances a normally completed initial AppServer Goal through Review", async () => {
    const value = await fixture({ terminalRouting: true });
    try {
      const submitted = await value.submit.submitExternalGoal({ ...request(), execution_mode: "interactive" });
      const session = (await value.sessions.listSessions())[0]!;
      value.appClient.stream.push({ type: "turn_completed", thread_id: "thread-001", turn_id: "turn-001" });
      await waitFor(async () => (await value.goals.getGoal(submitted.goal_id))?.status === "completed");
      await expect(value.executions.getExecutionContext("workspace-a", submitted.task_id, submitted.execution_id))
        .resolves.toMatchObject({ status: "passed" });
      await expect(value.goals.getGoal(submitted.goal_id)).resolves.toMatchObject({ status: "completed" });
      expect(value.terminalListener).toHaveBeenCalledWith(expect.objectContaining({ status: "passed" }));
      expect(value.appClient.thread).toHaveBeenCalledTimes(1);
      expect(value.appClient.turn).toHaveBeenCalledTimes(1);
      expect((await value.sessions.getSession(session.session_id))?.thread_id).toBe("thread-001");
    } finally {
      value.auto?.dispose();
      value.goals.dispose();
      await value.executionService.close();
    }
  });
});

it("recovers Pending identity persistence before standalone Interactive dispatch without a duplicate start", async () => {
  const value = await fixture();
  const correlations = new ConversationCorrelationRegistry(value.root);
  const submission = value.submit;
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
    expect(value.appFactory).toHaveBeenCalledTimes(1);
    expect(value.appClient.turn).toHaveBeenCalledTimes(1);
    expect(await value.sessions.listSessions()).toHaveLength(1);
    const record = (await pending.get(key))!;
    if (record.state !== "started") throw new Error("Pending did not start");
    expect(await value.executions.listExecutions("workspace-a", record.task_id)).toHaveLength(1);
  } finally { spy.mockRestore(); await value.executionService.close(); }
});
