import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKEND_CLOSED_SUMMARY,
  CodexAppServerBackend,
  ORPHANED_EXECUTION_SUMMARY,
  type AppServerClientFactory,
} from "../src/backends/codex_app_server/backend.js";
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
  public readonly processInfo: CodexAppServerProcessInfo = {
    process_id: 9_001,
    codex_version: "fake",
    transport: "stdio",
    status: "ready",
  };
  public readonly stream = new FakeEventStream();
  public readonly listModels = vi.fn(async (): Promise<readonly AppServerModel[]> => []);
  public readonly startThread = vi.fn(async (input: { cwd: string; model?: string }): Promise<AppServerThread> => ({
    thread_id: "thread-001",
    session_id: "provider-session-001",
    cwd: input.cwd,
  }));
  public readonly startTurn = vi.fn(async (): Promise<AppServerTurn> => ({
    turn_id: "turn-001",
    status: "in_progress",
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
