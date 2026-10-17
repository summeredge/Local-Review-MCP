import { EventStore } from "../src/control-plane/events/store.js";
import { ControlledActuationService } from "../src/control-plane/controlled-actuation.js";
import { ReviewRequestService } from "../src/context/review-request-service.js";
import { AutoIterationService, AutoIterationStore } from "../src/control-plane/auto-iteration.js";
import { BrowserRouter } from "../src/router/browser-router.js";
import { ReviewCompletionRouter } from "../src/router/review-completion-router.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_SERVER_COMMAND,
  BACKEND_CLOSED_SUMMARY,
  CodexAppServerBackend,
  ORPHANED_EXECUTION_SUMMARY,
  type AppServerClientFactory,
} from "../src/backends/codex_app_server/backend.js";
import { ExecutionLaunchIndeterminateError } from "../src/control-plane/execution-service.js";
import { CodexAppServerNotDispatchedError, CodexAppServerRpcError } from "../src/backends/codex_app_server/protocol.js";
import type { CodexAppServerEvent } from "../src/backends/codex_app_server/events.js";
import type {
  AppServerModel,
  AppServerThread,
  AppServerTurn,
  CodexAppServerExit,
  CodexAppServerProcessInfo,
} from "../src/backends/codex_app_server/models.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { SessionStore } from "../src/context/session-store.js";
import { TaskContextService } from "../src/context/service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const temporaryDirectories: string[] = [];

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
  public constructor(private cwd = "") {}
  public get cwdValue(): string { return this.cwd; }
  public readonly processInfo: CodexAppServerProcessInfo = {
    process_id: 9_001,
    codex_version: "fake",
    transport: "stdio",
    status: "ready",
  };
  public readonly stream = new FakeEventStream();
  public readonly listModels = vi.fn(async (): Promise<readonly AppServerModel[]> => []);
  public readonly startThread = vi.fn(async (input: { cwd: string; model?: string }): Promise<AppServerThread> => {
    this.cwd = input.cwd;
    return {
    thread_id: "thread-001",
    session_id: "provider-session-001",
    cwd: input.cwd,
    };
  });
  public readonly startTurn = vi.fn(async (): Promise<AppServerTurn> => ({
    turn_id: "turn-001",
    status: "in_progress",
  }));
  public readonly readThread = vi.fn(async (input: { threadId: string }) => ({
    thread_id: input.threadId,
    cwd: this.cwd,
    turns: [{ turn_id: "turn-001", status: "completed" as const }],
  }));
  public readonly resumeThread = vi.fn(async (input: { threadId: string; cwd: string }) => ({
    thread_id: input.threadId,
    cwd: input.cwd,
    turns: [{ turn_id: "turn-001", status: "completed" as const }],
  }));
  public readonly close = vi.fn(async (): Promise<CodexAppServerExit> => {
    this.stream.close();
    return { process_id: this.processInfo.process_id, exit_code: 0, signal: null, stdout: "", stderr: "" };
  });

  public events(): AsyncIterable<CodexAppServerEvent> {
    return this.stream;
  }
}

const startRequest = {
  goal_id: "goal-1",
  workspace_id: "workspace-1",
  task_id: "task-1",
  execution_id: "execution-1",
  instruction: "reply",
  execution_mode: "interactive" as const,
};

interface Harness {
  readonly root: string;
  readonly backend: CodexAppServerBackend;
  readonly client: FakeAppServerClient;
  readonly terminal: ReturnType<typeof vi.fn>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "lrm-appserver-orphan-"));
  temporaryDirectories.push(root);
  await new TaskContextService(root).createTaskContext({ task_id: "task-1", workspace_id: "workspace-1" });
  const client = new FakeAppServerClient();
  const backend = new CodexAppServerBackend(
    new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: root }]),
    { storageRoot: root, clientFactory: (async () => client) as AppServerClientFactory },
  );
  const terminal = vi.fn();
  backend.setTerminalListener(terminal);
  return { root, backend, client, terminal };
}

async function executionState(root: string) {
  return new ExecutionContextService(root).getExecutionContext("workspace-1", "task-1", "execution-1");
}

it.each(["failed response", "rpc rejection", "not dispatched", "lost response"])(
  "keeps launch records consistent for %s without resending", async outcome => {
    const { root, backend, client } = await harness();
    if (outcome === "failed response") client.startTurn.mockResolvedValue({ turn_id: "turn-001", status: "failed" });
    else client.startTurn.mockRejectedValue(outcome === "rpc rejection"
      ? new CodexAppServerRpcError(-32000, "rejected")
      : outcome === "not dispatched" ? new CodexAppServerNotDispatchedError("closed before dispatch")
      : new Error("response lost"));
    const registry = new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: root }]);
    const controlled = new ControlledActuationService(registry, { storageRoot: root, adapter: backend });
    const auth = await controlled.authorize({ ...startRequest, actuation_id: "launch-actuation" });
    try {
      const error = await controlled.actuate({ actuation_id: auth.actuation_id, authorization_id: auth.authorization_id })
        .catch(error => error);
      expect(error instanceof ExecutionLaunchIndeterminateError).toBe(outcome === "lost response");
      expect(error).toBeInstanceOf(Error);
      const status = outcome === "lost response" ? "terminated" : "failed";
      expect(await executionState(root)).toMatchObject({ status });
      expect((await new SessionStore(root).listSessions())[0]).toMatchObject({ status });
      if (outcome === "lost response") expect((await executionState(root))?.summary).toMatch(/outcome unknown; no retry/);
      expect((await controlled.authorizationStore.getActuation(auth.actuation_id))?.status)
        .toBe(outcome === "lost response" ? "starting" : "failed");
      await controlled.actuate({ actuation_id: auth.actuation_id, authorization_id: auth.authorization_id }).catch(() => undefined);
      expect(client.startTurn).toHaveBeenCalledOnce();
      expect(client.close).toHaveBeenCalledOnce();
    } finally { await backend.close(); }
  },
);

it.each(["authorized thread", "session lookup", "session persistence", "execution persistence", "model validation"]
  .flatMap(failure => [false, true].map(borrowed => ({ failure, borrowed }))))(
  "handles continuation ownership on $failure failure, borrowed=$borrowed", async ({ failure, borrowed }) => {
    const { root, backend, client, terminal } = await harness();
    await backend.start(startRequest);
    client.stream.push({ type: "turn_completed", thread_id: "thread-001", turn_id: "turn-001" });
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());
    const timestamp = new Date().toISOString();
    await new AutoIterationStore(root).put({ loop_id: "ownership-loop", initial_execution_id: "execution-1",
      workspace_id: "workspace-1", task_id: "task-1", conversation_id: "conversation-1", max_iterations: 2,
      iteration: 2, execution_id: "execution-2", stage: "execution", created_at: timestamp, updated_at: timestamp });
    const registry = new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: root }]);
      const fresh = new FakeAppServerClient();
      fresh.readThread.mockResolvedValue({ thread_id: "thread-001", cwd: root,
        turns: [{ turn_id: "turn-001", status: "completed" }] });
      const active = borrowed ? backend : new CodexAppServerBackend(registry, { storageRoot: root, clientFactory: async () => fresh });
      const spy = failure === "session persistence" ? vi.spyOn(SessionStore.prototype, "createSession").mockRejectedValue(new Error("session persistence"))
        : failure === "execution persistence" ? vi.spyOn(ExecutionContextService.prototype, "createExecutionContext").mockRejectedValue(new Error("execution persistence"))
        : undefined;
      if (failure === "session lookup") {
        await new SessionStore(root).createSession({ execution_id: "execution-2", goal_id: "goal-1", task_id: "task-1",
          backend_type: "codex_app_server", workspace: root });
      }
      try {
        await expect(active.start({ ...startRequest, execution_id: "execution-2",
          thread_id: failure === "authorized thread" ? "wrong-thread" : "thread-001",
          ...(failure === "model validation" ? { model_id: "missing-model" } : {}) })).rejects.toThrow();
        expect(client.close).not.toHaveBeenCalled();
        expect(fresh.close).toHaveBeenCalledTimes(borrowed || failure === "authorized thread" ? 0 : 1);
        expect(fresh.startTurn).not.toHaveBeenCalled();
      } finally { spy?.mockRestore(); if (!borrowed) await active.close(); }
    await backend.close();
  },
);

describe("Codex AppServer shutdown and orphan reconciliation", () => {
  it("A. fails a running turn and its Session when the backend closes mid-turn", async () => {
    const { root, backend, client, terminal } = await harness();
    const started = await backend.start(startRequest);
    client.stream.push({ type: "turn_started", thread_id: "thread-001", turn_id: "turn-001" });
    await vi.waitFor(async () =>
      (await new SessionStore(root).getSession(started.session_id!))?.status === "running_turn");

    await backend.close();

    // Persistence and the terminal notification are complete by the time close() resolves.
    await expect(executionState(root)).resolves.toMatchObject({
      status: "failed",
      summary: BACKEND_CLOSED_SUMMARY,
    });
    await expect(new SessionStore(root).getSession(started.session_id!))
      .resolves.toMatchObject({ status: "failed" });
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]![0]).toMatchObject({ status: "failed", summary: BACKEND_CLOSED_SUMMARY });
  });

  it("B. still fails an unexpected event-stream end during normal operation", async () => {
    const { root, backend, client, terminal } = await harness();
    const started = await backend.start(startRequest);
    client.stream.close();

    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());
    await expect(executionState(root)).resolves.toMatchObject({
      status: "failed",
      summary: "app-server ended without terminal turn evidence",
    });
    await expect(new SessionStore(root).getSession(started.session_id!))
      .resolves.toMatchObject({ status: "failed" });
    await backend.close();
  });

  it("C. keeps a completed turn passed and does not re-notify on close", async () => {
    const { root, backend, client, terminal } = await harness();
    const started = await backend.start(startRequest);
    client.stream.push({ type: "turn_completed", thread_id: "thread-001", turn_id: "turn-001" });
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());

    await backend.close();

    await expect(executionState(root)).resolves.toMatchObject({ status: "passed" });
    await expect(new SessionStore(root).getSession(started.session_id!))
      .resolves.toMatchObject({ status: "completed" });
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it("D. does not repeat the terminal notification for an already failed turn", async () => {
    const { root, backend, client, terminal } = await harness();
    const started = await backend.start(startRequest);
    client.stream.push({
      type: "turn_failed",
      thread_id: "thread-001",
      turn_id: "turn-001",
      reason: "turn failed",
    });
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());

    await backend.close();

    await expect(executionState(root)).resolves.toMatchObject({ status: "failed", summary: "turn failed" });
    await expect(new SessionStore(root).getSession(started.session_id!))
      .resolves.toMatchObject({ status: "failed" });
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it("E. fails a persisted orphan at startup without starting or switching anything", async () => {
    const { root, backend, client, terminal } = await harness();
    const executions = new ExecutionContextService(root);
    const sessions = new SessionStore(root);
    const session = await sessions.createSession({
      goal_id: "goal-1",
      task_id: "task-1",
      backend_type: "codex_app_server",
      status: "active",
      workspace: root,
      thread_id: "thread-001",
    });
    await sessions.updateSession(session.session_id, { status: "running_turn" });
    await executions.createExecutionContext({
      execution_id: "execution-1",
      task_id: "task-1",
      workspace_id: "workspace-1",
      status: "running",
      process_id: 4242,
      command: "codex app-server --listen stdio://",
    });

    await expect(backend.reconcileOrphanedExecutions()).resolves.toMatchObject([{
      execution_id: "execution-1",
      status: "failed",
    }]);

    await expect(executionState(root)).resolves.toMatchObject({
      status: "failed",
      summary: ORPHANED_EXECUTION_SUMMARY,
    });
    await expect(sessions.getSession(session.session_id)).resolves.toMatchObject({ status: "failed" });
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]![0]).toMatchObject({ status: "failed" });
    // No Codex process is started, no thread or turn is submitted, and no Desktop migration occurs.
    expect(client.listModels).not.toHaveBeenCalled();
    expect(client.startThread).not.toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    await backend.close();
  });

  it("F. reconciles orphans idempotently without a second notification", async () => {
    const { root, backend, terminal } = await harness();
    const sessions = new SessionStore(root);
    const session = await sessions.createSession({
      goal_id: "goal-1",
      task_id: "task-1",
      backend_type: "codex_app_server",
      status: "running_turn",
      workspace: root,
      thread_id: "thread-001",
    });
    await new ExecutionContextService(root).createExecutionContext({
      execution_id: "execution-1",
      task_id: "task-1",
      workspace_id: "workspace-1",
      status: "running",
      process_id: 4242,
      command: "codex app-server --listen stdio://",
    });

    await expect(backend.reconcileOrphanedExecutions()).resolves.toHaveLength(1);
    const failed = await executionState(root);
    await expect(backend.reconcileOrphanedExecutions()).resolves.toEqual([]);

    expect(await executionState(root)).toEqual(failed);
    await expect(sessions.getSession(session.session_id)).resolves.toMatchObject({ status: "failed" });
    expect(await sessions.listSessions()).toHaveLength(1);
    await expect(new ExecutionContextService(root).listExecutions("workspace-1", "task-1"))
      .resolves.toHaveLength(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    await backend.close();
  });

  it("G. returns existing only for a turn this backend instance still owns", async () => {
    const { root, backend, client } = await harness();
    const started = await backend.start(startRequest);

    await expect(backend.start(startRequest)).resolves.toMatchObject({
      accepted: "existing",
      execution_id: "execution-1",
      session_id: started.session_id,
      thread_id: "thread-001",
    });
    expect(client.startThread).toHaveBeenCalledOnce();
    expect(client.startTurn).toHaveBeenCalledOnce();

    // A fresh instance holding only the persisted running record has no live ownership.
    const restarted = new CodexAppServerBackend(
      new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: root }]),
      { storageRoot: root, clientFactory: (async () => new FakeAppServerClient()) as AppServerClientFactory },
    );
    await expect(restarted.start(startRequest)).rejects.toThrow(/no live Codex app-server client/u);
    await expect(executionState(root)).resolves.toMatchObject({
      status: "failed",
      summary: ORPHANED_EXECUTION_SUMMARY,
    });
    await expect(new SessionStore(root).getSession(started.session_id!))
      .resolves.toMatchObject({ status: "failed" });

    await restarted.close();
    await backend.close();
  });
});

it("starts a separate ITERATE execution after the previous turn passed", async () => {
  const { root, backend, client, terminal } = await harness();
  try {
    const first = await backend.start(startRequest);
    client.stream.push({ type: "turn_completed", thread_id: "thread-001", turn_id: "turn-001" });
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());
    const timestamp = new Date().toISOString();
    await new AutoIterationStore(root).put({
      loop_id: "iterate-loop", initial_execution_id: "execution-1", workspace_id: "workspace-1",
      task_id: "task-1", conversation_id: "conversation-1", max_iterations: 2, iteration: 2,
      execution_id: "execution-2", stage: "execution", created_at: timestamp, updated_at: timestamp,
    });
    const second = await backend.start({ ...startRequest, execution_id: "execution-2", thread_id: "thread-001" });
    expect(second.session_id).not.toBe(first.session_id);
    expect(second.thread_id).toBe(first.thread_id);
    expect(client.startThread).toHaveBeenCalledOnce();
    expect(await backend.start({ ...startRequest, execution_id: "execution-2" })).toMatchObject({ accepted: "existing", session_id: second.session_id });
    expect(client.startTurn).toHaveBeenCalledTimes(2);
    const sessions = await new SessionStore(root).listSessions();
    expect(sessions.map(session => session.execution_id).sort()).toEqual(["execution-1", "execution-2"]);
    expect(terminal.mock.calls[0]![0].execution_id).toBe("execution-1");
  } finally { await backend.close(); }
});

describe("terminal Session recovery", () => {
  it.each([ ["passed", false], ["failed", false], ["passed", true], ["failed", true] ] as const)(
    "recovers %s with persistent Session failure=%s", async (outcome, persistent) => {
      const value = await harness();
      const registry = new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: value.root }]);
      const request = startRequest;
      const sessions = new SessionStore(value.root);
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
        value.client.stream.push({ type: outcome === "passed" ? "turn_completed" : "turn_failed", thread_id: "thread-001", turn_id: "turn-001", reason: "injected turn failure" });
        await vi.waitFor(() => expect(notifications).toBe(1));
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
        const restarted = new CodexAppServerBackend(registry, { storageRoot: value.root, clientFactory: async () => { throw new Error("must not redispatch"); } });
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

it.each(["failed response", "lost response", "completed response"])(
  "settles reentrant AppServer actuation and terminal callbacks for %s", async outcome => {
    const { root, backend, client } = await harness();
    const registry = new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: root }]);
    const controlled = new ControlledActuationService(registry, { storageRoot: root, adapter: backend });
    const initial = await controlled.authorize({ ...startRequest, actuation_id: "initial-actuation" });
    let reviews = 0;
    const auto = new AutoIterationService(registry, { storageRoot: root, controlledActuation: controlled,
      browserRouter: new BrowserRouter(root, { deliver: async () => ({ status: "delivered", delivered_at: new Date().toISOString() }) }),
      completionRouter: new ReviewCompletionRouter(root, { collect: async input => ({ status: "COMPLETED",
        content: '<lrm-review-result>' + JSON.stringify({ schema_version: 1, review_request_id: input.review_request_id,
          decision: ++reviews === 1 ? "ITERATE" : "APPROVE", summary: "Reviewed",
          ...(reviews === 1 ? { iteration: { goal: "Fix", requirements: ["Fix"], acceptance_criteria: ["Pass"] } } : {}),
        }) + '</lrm-review-result>' }) }),
    });
    const listener = vi.fn(execution => auto.onExecutionTerminal(execution));
    backend.setTerminalListener(listener);
    try {
      client.startTurn.mockResolvedValueOnce({ turn_id: "turn-001", status: "completed" });
      await controlled.actuate({ actuation_id: initial.actuation_id, authorization_id: initial.authorization_id });
      if (outcome === "lost response") client.startTurn.mockRejectedValueOnce(new Error("turn/start response lost"));
      else client.startTurn.mockResolvedValueOnce({ turn_id: "turn-002",
        status: outcome === "failed response" ? "failed" : "completed" });
      // Backend -> terminal listener -> AutoIteration runs inside this same loop's actuation.
      await auto.start({ loop_id: "reentrant-loop", workspace_id: "workspace-1", task_id: "task-1",
        conversation_id: "conversation-1", execution_id: "execution-1", max_iterations: 2 });
      const loop = (await auto.getLoop("reentrant-loop"))!;
      expect(loop.stage).toBe(outcome === "lost response" ? "human_required"
        : outcome === "failed response" ? "failed" : "completed");
      if (outcome === "lost response") expect(loop.terminal_reason).toBe("ACTUATION_UNCERTAIN");
      const execution = (await new ExecutionContextService(root).getExecutionContext(
        "workspace-1", "task-1", loop.execution_id))!;
      const status = outcome === "lost response" ? "terminated" : outcome === "failed response" ? "failed" : "passed";
      expect(execution.status).toBe(status);
      expect((await new SessionStore(root).listSessions()).find(session => session.execution_id === loop.execution_id)?.status)
        .toBe(status === "passed" ? "completed" : status);
      expect((await controlled.getActuation(loop.actuation_id!))?.status)
        .toBe(outcome === "lost response" ? "starting" : outcome === "failed response" ? "failed" : "started");
      if (outcome === "lost response") expect(execution.summary).toMatch(/outcome unknown; no retry/);
      expect(listener).toHaveBeenCalledTimes(2);
      await Promise.all(listener.mock.results.map(result => result.value));
      await auto.onExecutionTerminal(execution);
      await auto.recover();
      await auto.advance(loop.loop_id);
      expect((await auto.getLoop(loop.loop_id))?.stage).toBe(loop.stage);
      expect(client.startTurn).toHaveBeenCalledTimes(2);
      expect(reviews).toBe(outcome === "completed response" ? 2 : 1);
      expect((await new TaskContextService(root).getTaskContext("task-1"))?.status).toBe(loop.stage);
    } finally { auto.dispose(); await backend.close(); }
  }, 5_000,
);

it("runs AppServer through ITERATE and reviews each execution exactly once", async () => {
  const { root, backend, client } = await harness();
  const registry = new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: root }]);
  const controlled = new ControlledActuationService(registry, { storageRoot: root, adapter: backend });
  const initial = await controlled.authorize({ ...startRequest, actuation_id: "initial-actuation" });
  let reviews = 0;
  const identities: string[] = [];
  const auto = new AutoIterationService(registry, { storageRoot: root, controlledActuation: controlled,
    browserRouter: new BrowserRouter(root, { deliver: async () => ({ status: "delivered", delivered_at: new Date().toISOString() }) }),
    completionRouter: new ReviewCompletionRouter(root, { collect: async input => {
      identities.push((await new ReviewRequestService(root).getReviewRequest("workspace-1", input.review_request_id))!.execution_id);
      const decision = ++reviews === 1 ? "ITERATE" : "APPROVE";
      return { status: "COMPLETED", content: '<lrm-review-result>' + JSON.stringify({ schema_version: 1,
        review_request_id: input.review_request_id, decision, summary: "Reviewed",
        ...(decision === "ITERATE" ? { iteration: { goal: "Fix defect", requirements: ["Fix"], acceptance_criteria: ["Pass"] } } : {}),
      }) + '</lrm-review-result>' };
    } }),
  });
  backend.setTerminalListener(execution => auto.onExecutionTerminal(execution));
  try {
    await controlled.actuate({ actuation_id: initial.actuation_id, authorization_id: initial.authorization_id });
    await auto.start({ loop_id: "iterate-loop", workspace_id: "workspace-1", task_id: "task-1",
      conversation_id: "conversation-1", execution_id: "execution-1", max_iterations: 2 });
    client.stream.push({ type: "turn_completed", thread_id: "thread-001", turn_id: "turn-001" });
    await vi.waitFor(() => expect(client.startTurn).toHaveBeenCalledTimes(2));
    const second = (await auto.getLoop("iterate-loop"))!;
    expect(second.execution_id).not.toBe("execution-1");
    client.stream.push({ type: "turn_completed", thread_id: "thread-001", turn_id: "turn-001" });
    await vi.waitFor(async () => expect((await auto.getLoop("iterate-loop"))?.stage).toBe("completed"));
    const executions = await new ExecutionContextService(root).listExecutions("workspace-1", "task-1");
    expect(executions).toHaveLength(2);
    expect(executions.every(execution => execution.status === "passed")).toBe(true);
    expect(identities).toEqual(["execution-1", second.execution_id]);
    await Promise.all(executions.map(execution => auto.onExecutionTerminal(execution)));
    expect(reviews).toBe(2);
    expect(client.startTurn).toHaveBeenCalledTimes(2);
  } finally { auto.dispose(); await backend.close(); }
});

it("continues the original AppServer Thread for the next ITERATE turn", async () => {
  const value = await harness();
  const registry = new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: value.root }]);
  const controlled = new ControlledActuationService(registry, { storageRoot: value.root, adapter: value.backend });
  const initial = await controlled.authorize({ ...startRequest, actuation_id: "initial-actuation" });
  let reviews = 0;
  const makeAuto = () => new AutoIterationService(registry, { storageRoot: value.root,
    controlledActuation: controlled,
    browserRouter: new BrowserRouter(value.root, { deliver: async () => ({ status: "delivered", delivered_at: new Date().toISOString() }) }),
    completionRouter: new ReviewCompletionRouter(value.root, { collect: async input => ({
      status: "COMPLETED", content: '<lrm-review-result>' + JSON.stringify({ schema_version: 1,
        review_request_id: input.review_request_id, decision: ++reviews === 1 ? "ITERATE" : "APPROVE", summary: "Reviewed",
        ...(reviews === 1 ? { iteration: { goal: "Fix", requirements: ["Fix"], acceptance_criteria: ["Pass"] } } : {}) },
      ) + '</lrm-review-result>',
    }) }),
  });
  const auto = makeAuto();
  try {
    value.backend.setTerminalListener(execution => auto.onExecutionTerminal(execution));
    await controlled.actuate({ actuation_id: initial.actuation_id, authorization_id: initial.authorization_id });
    await auto.start({ loop_id: "restart-iterate", workspace_id: "workspace-1", task_id: "task-1",
      conversation_id: "conversation-1", execution_id: "execution-1", max_iterations: 2 });
    const firstSession = (await new SessionStore(value.root).listSessions())[0]!;
    value.client.stream.push({ type: "turn_completed", thread_id: "thread-001", turn_id: "turn-001" });
    await vi.waitFor(async () => expect((await new SessionStore(value.root).getSession(firstSession.session_id))?.status)
      .toBe("completed"));
    expect((await new ExecutionContextService(value.root)
      .getExecutionContext("workspace-1", "task-1", "execution-1"))?.status).toBe("passed");
    value.client.startTurn.mockImplementation(async () => ({ turn_id: "turn-002", status: "in_progress" }));
    await auto.advance("restart-iterate");
    await vi.waitFor(() => expect(value.client.startTurn).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    const loop = (await auto.getLoop("restart-iterate"))!;
    expect(value.client.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-001" }));
    expect(value.client.startThread).toHaveBeenCalledOnce();
    const second = (await new ExecutionContextService(value.root).getExecutionContext(
      "workspace-1", "task-1", loop.execution_id))!;
    expect(second).toMatchObject({ status: "running", command: APP_SERVER_COMMAND });
    value.client.stream.push({ type: "turn_completed", thread_id: "thread-001", turn_id: "turn-002" });
    await vi.waitFor(async () => expect((await auto.getLoop("restart-iterate"))?.stage)
      .toBe("completed"), { timeout: 5_000 });
    const secondSession = (await new SessionStore(value.root).listSessions())
      .find(session => session.execution_id === loop.execution_id)!;
    expect(secondSession.thread_id).toBe("thread-001");
    expect(await new ExecutionContextService(value.root).getExecutionContext(
      "workspace-1", "task-1", loop.execution_id)).toMatchObject({ status: "passed" });
  } finally { auto.dispose(); await value.backend.close().catch(() => undefined); }
});

it.each([
  ["missing completed turn", (client: FakeAppServerClient) => client.readThread.mockImplementation(async (input: { threadId: string }) => ({
    thread_id: input.threadId, cwd: client.cwdValue, turns: [],
  }))],
  ["different resumed thread", (client: FakeAppServerClient) => client.resumeThread.mockImplementation(async () => ({
    thread_id: "thread-other", cwd: client.cwdValue, turns: [],
  }))],
  ["different completed turn", (client: FakeAppServerClient) => client.readThread.mockImplementation(async (input: { threadId: string }) => ({
    thread_id: input.threadId, cwd: client.cwdValue, turns: [{ turn_id: "unrelated-turn", status: "completed" as const }],
  }))],
  ["different resumed turn", (client: FakeAppServerClient) => client.resumeThread.mockImplementation(async (input: { threadId: string }) => ({
    thread_id: input.threadId, cwd: client.cwdValue, turns: [{ turn_id: "unrelated-turn", status: "completed" as const }],
  }))],
])("refuses AppServer continuation when %s", async (name, mutate) => {
  const value = await harness();
  const registry = new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: value.root }]);
  const controlled = new ControlledActuationService(registry, { storageRoot: value.root, adapter: value.backend });
  const initial = await controlled.authorize({ ...startRequest, actuation_id: "initial-actuation" });
  try {
    await controlled.actuate({ actuation_id: initial.actuation_id, authorization_id: initial.authorization_id });
    const timestamp = new Date().toISOString();
    await new AutoIterationStore(value.root).put({
      loop_id: "evidence-iterate", initial_execution_id: "execution-1", workspace_id: "workspace-1",
      task_id: "task-1", conversation_id: "conversation-1", max_iterations: 2, iteration: 2,
      execution_id: "execution-2", stage: "execution", created_at: timestamp, updated_at: timestamp,
    });
    value.client.stream.push({ type: "turn_completed", thread_id: "thread-001", turn_id: "turn-001" });
    await vi.waitFor(async () => expect((await new ExecutionContextService(value.root)
      .getExecutionContext("workspace-1", "task-1", "execution-1"))?.status).toBe("passed"));
    const resumed = new FakeAppServerClient(value.root);
    resumed.startThread.mockRejectedValue(new Error("new Thread must not be created"));
    resumed.readThread.mockResolvedValue({ thread_id: "thread-001", cwd: value.root,
      turns: [{ turn_id: "turn-001", status: "completed" }] });
    resumed.resumeThread.mockResolvedValue({ thread_id: "thread-001", cwd: value.root,
      turns: [{ turn_id: "turn-001", status: "completed" }] });
    mutate(resumed);
    const restarted = new CodexAppServerBackend(registry, { storageRoot: value.root,
      clientFactory: (async () => resumed) as AppServerClientFactory });
    try {
      await expect(restarted.start({ ...startRequest, execution_id: "execution-2", thread_id: "thread-001" }))
        .rejects.toBeInstanceOf(ExecutionLaunchIndeterminateError);
      expect(resumed.startTurn).not.toHaveBeenCalled();
      expect(resumed.startThread).not.toHaveBeenCalled();
      expect(resumed.close).toHaveBeenCalledOnce();
      expect(resumed.readThread).toHaveBeenCalledOnce();
      expect(resumed.resumeThread).toHaveBeenCalledTimes(name.includes("resumed") ? 1 : 0);
      await expect(new ExecutionContextService(value.root)
        .getExecutionContext("workspace-1", "task-1", "execution-2")).resolves.toBeNull();
    } finally { await restarted.close(); }
  } finally { await value.backend.close().catch(() => undefined); }
});

it.each([true, false])("protects Session residue with explicit execution identity=%s", async explicit => {
  const { root, backend, client } = await harness();
  await new SessionStore(root).createSession({ goal_id: "goal-1", task_id: "task-1", backend_type: "codex_app_server",
    workspace: root, ...(explicit ? { execution_id: "execution-1" } : {}) });
  try {
    await expect(backend.start(startRequest)).rejects.toThrow(/exists without its Execution/);
    expect(client.startTurn).not.toHaveBeenCalled();
  } finally { await backend.close(); }
});

it.each(["passed", "failed"] as const)("restarts from durable %s with an unsynchronized Loop", async outcome => {
  const value = await harness();
  const registry = new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: value.root }]);
  const request = startRequest;
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
    value.client.stream.push({ type: outcome === "passed" ? "turn_completed" : "turn_failed", thread_id: "thread-001", turn_id: "turn-001" });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect((await auto.getLoop("restart-loop"))?.stage).toBe("execution");
    await value.backend.close(); auto.dispose(); spy.mockRestore();
    auto = makeAuto();
    const restarted = new CodexAppServerBackend(registry, { storageRoot: value.root, clientFactory: async () => { throw new Error("unexpected dispatch"); } });
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

it.each([true, false])("recovers a legacy historical Session using event evidence=%s", async withEvents => {
  const { root, backend, client } = await harness();
  const sessions = new SessionStore(root);
  const historical = await sessions.createSession({ goal_id: "goal-1", task_id: "task-1", backend_type: "codex_app_server",
    workspace: root, status: "completed", thread_id: "old-thread" });
  await new ExecutionContextService(root).createExecutionContext({ workspace_id: "workspace-1", task_id: "task-1",
    execution_id: "old-execution", status: "passed", command: "codex app-server --listen stdio://" });
  if (withEvents) await new EventStore(root).appendEvent({ session_id: historical.session_id, execution_id: "old-execution",
    thread_id: "old-thread", event_type: "turn_completed", turn_id: "old-turn", timestamp: new Date().toISOString(), payload: {} });
  try {
    const current = await backend.start(startRequest);
    expect(current.session_id).not.toBe(historical.session_id);
    expect((await sessions.getSession(historical.session_id))?.execution_id).toBe("old-execution");
    client.stream.push({ type: "turn_completed", thread_id: "thread-001", turn_id: "turn-001" });
    await backend.close();
    await backend.reconcileOrphanedExecutions();
    expect((await sessions.getSession(historical.session_id))?.status).toBe("completed");
  } finally { await backend.close(); }
});
