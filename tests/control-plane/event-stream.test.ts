import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexEventAdapter,
  EventStore,
  type LrmEvent,
} from "../../src/control-plane/events/index.js";
import {
  CodexAppServerBackend,
  type AppServerClientFactory,
} from "../../src/backends/codex_app_server/backend.js";
import type {
  AppServerModel,
  AppServerThread,
  AppServerTurn,
  CodexAppServerExit,
  CodexAppServerProcessInfo,
} from "../../src/backends/codex_app_server/models.js";
import type { CodexAppServerEvent } from "../../src/backends/codex_app_server/events.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { SessionStore } from "../../src/context/session-store.js";
import { TaskContextService } from "../../src/context/service.js";
import { goalOrchestrationSchema, type GoalOrchestration } from "../../src/control-plane/goal-orchestration.js";
import { StatusQueryService } from "../../src/control-plane/status-query.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const temporaryDirectories: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

function adapter(): CodexEventAdapter {
  return new CodexEventAdapter({
    session_id: "session-1",
    execution_id: "execution-1",
    thread_id: "thread-1",
    turn_id: "turn-1",
    now: () => "2026-09-15T00:00:00.000Z",
  });
}

function providerEvents() {
  return [
    { type: "thread_started", thread_id: "thread-1", session_id: "provider-session-1" } as const,
    { type: "turn_started", thread_id: "thread-1", turn_id: "turn-1" } as const,
    {
      type: "agent_message_delta",
      thread_id: "thread-1",
      turn_id: "turn-1",
      item_id: "item-1",
      content: "LRM_PHASE4_",
    } as const,
    {
      type: "agent_message_completed",
      thread_id: "thread-1",
      turn_id: "turn-1",
      item_id: "item-1",
      content: "LRM_PHASE4_EVENT_PASS",
    } as const,
    { type: "turn_completed", thread_id: "thread-1", turn_id: "turn-1" } as const,
  ];
}

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

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for event stream");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Codex Event Adapter and LRM event stream", () => {
  it("converts provider events without exposing provider session metadata", () => {
    const eventAdapter = adapter();
    const converted = providerEvents().map((event) => eventAdapter.adapt(event));
    const events = converted.filter((event): event is LrmEvent => event !== undefined);

    expect(events.map((event) => event.event_type)).toEqual([
      "session_started",
      "turn_started",
      "agent_message_delta",
      "agent_message_completed",
      "turn_completed",
    ]);
    expect(events[0]).toMatchObject({
      session_id: "session-1",
      execution_id: "execution-1",
      thread_id: "thread-1",
      payload: {},
    });
    expect(events[2]).toMatchObject({
      turn_id: "turn-1",
      item_id: "item-1",
      payload: { content: "LRM_PHASE4_" },
    });
    expect(events[3]).toMatchObject({ payload: { content: "EVENT_PASS" } });
    expect(JSON.stringify(events)).not.toContain("provider-session-1");
    expect(adapter().adapt({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    })).toMatchObject({ event_type: "turn_started", turn_id: "turn-1" });
  });

  it("persists ordered normalized events in the application state root", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-events-"));
    temporaryDirectories.push(root);
    const store = new EventStore(root);
    const eventAdapter = adapter();
    const normalized = providerEvents()
      .map((event) => eventAdapter.adapt(event))
      .filter((event): event is LrmEvent => event !== undefined);

    await store.appendEvent(normalized[0]!);
    await store.appendEvent(normalized[1]!);
    const events = await store.listEvents("session-1");

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.event_type)).toEqual(["session_started", "turn_started"]);
  });

  it("supports the Session lifecycle including running_turn and waiting_input", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-session-events-"));
    temporaryDirectories.push(root);
    const store = new SessionStore(root);
    const session = await store.createSession({
      session_id: "session-1",
      goal_id: "goal-1",
      task_id: "task-1",
      backend_type: "codex_app_server",
      workspace: "C:\\workspace",
    });

    await store.updateSession(session.session_id, { status: "active" });
    await store.updateSession(session.session_id, { status: "running_turn" });
    await store.updateSession(session.session_id, { status: "waiting_input" });
    const completed = await store.updateSession(session.session_id, { status: "completed" });

    expect(completed.status).toBe("completed");
    expect((await store.getSession(session.session_id))?.status).toBe("completed");
  });

  it("syncs interactive turn events to Execution and Session status", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-event-backend-"));
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-event-workspace-"));
    temporaryDirectories.push(root, workspace);
    const registry = new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: workspace }]);
    const stream = new FakeEventStream();
    const client = {
      processInfo: {
        process_id: 9_001,
        codex_version: "fake",
        transport: "stdio",
        status: "ready",
      } satisfies CodexAppServerProcessInfo,
      listModels: async (): Promise<readonly AppServerModel[]> => [],
      startThread: async (input: { cwd: string }): Promise<AppServerThread> => ({
        thread_id: "thread-1",
        session_id: "provider-session-1",
        cwd: input.cwd,
      }),
      startTurn: async (_input: { threadId: string; text: string }): Promise<AppServerTurn> => ({
        turn_id: "turn-1",
        status: "in_progress",
      }),
      events: (): AsyncIterable<CodexAppServerEvent> => stream,
      close: async (): Promise<CodexAppServerExit> => {
        stream.close();
        return { process_id: 9_001, exit_code: 0, signal: null, stdout: "", stderr: "" };
      },
    };
    const backend = new CodexAppServerBackend(registry, {
      storageRoot: root,
      clientFactory: (async () => client) as AppServerClientFactory,
    });
    const started = await backend.start({
      goal_id: "goal-1",
      workspace_id: "workspace-1",
      task_id: "task-1",
      execution_id: "execution-1",
      instruction: "reply",
      execution_mode: "interactive",
    });
    const sessions = new SessionStore(root);
    const session = await sessions.getSession(started.session_id!);
    const events = new EventStore(root);

    const rawEvents = providerEvents();
    stream.push(rawEvents[0]!);
    stream.push(rawEvents[1]!);
    await waitFor(async () => (await sessions.getSession(session!.session_id))?.status === "running_turn");
    stream.push(rawEvents[2]!);
    stream.push(rawEvents[3]!);
    stream.push(rawEvents[4]!);
    await waitFor(async () => (await sessions.getSession(session!.session_id))?.status === "completed");

    await expect(new ExecutionContextService(root).getExecutionContext(
      "workspace-1",
      "task-1",
      "execution-1",
    )).resolves.toMatchObject({ status: "passed" });
    expect((await events.listEvents(session!.session_id)).map((event) => event.event_type)).toEqual([
      "session_started",
      "turn_started",
      "agent_message_delta",
      "agent_message_completed",
      "turn_completed",
    ]);
    await backend.close();
  });

  it("returns Session and Execution status through the read-only query service", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-status-query-"));
    temporaryDirectories.push(root);
    const timestamp = "2026-09-15T00:00:00.000Z";
    const goal = goalOrchestrationSchema.parse({
      goal_id: "goal-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      phases: [{
        phase_id: "phase-1",
        objective: "Phase",
        tasks: [{
          task_id: "task-1",
          goal: "Reply",
          requirements: ["Use app-server"],
          acceptance_criteria: ["Reply"],
          max_iterations: 1,
        }],
        status: "running",
      }],
      status: "running",
      current_phase_id: "phase-1",
      current_task_id: "task-1",
      execution_id: "execution-1",
      actuation_id: "actuation-1",
      loop_id: "loop-1",
      created_at: timestamp,
      updated_at: timestamp,
    });
    const sessions = new SessionStore(root);
    const session = await sessions.createSession({
      session_id: "session-1",
      goal_id: "goal-1",
      task_id: "task-1",
      backend_type: "codex_app_server",
      status: "running_turn",
      workspace: "C:\\workspace",
      thread_id: "thread-1",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
    });
    const executions = new ExecutionContextService(root);
    await new TaskContextService(root).createTaskContext({
      task_id: "task-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
    });
    await executions.createExecutionContext({
      execution_id: "execution-1",
      workspace_id: "workspace-1",
      task_id: "task-1",
      process_id: 9_001,
    });
    const eventStore = new EventStore(root);
    const eventAdapter = new CodexEventAdapter({
      session_id: session.session_id,
      execution_id: "execution-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      now: () => timestamp,
    });
    for (const event of providerEvents()) {
      const normalized = eventAdapter.adapt(event);
      if (normalized !== undefined) await eventStore.appendEvent(normalized);
    }
    const query = new StatusQueryService({
      storageRoot: root,
      goals: {
        getGoal: async () => goal,
        listGoals: async () => [goal],
      },
      eventStore,
    });

    await expect(query.getSessionStatus({ goal_id: "goal-1" })).resolves.toMatchObject({
      session_id: "session-1",
      thread_id: "thread-1",
      status: "running_turn",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      current_execution: {
        execution_id: "execution-1",
        status: "running",
        turn_id: "turn-1",
      },
    });
    await expect(query.getExecutionStatus({
      execution_id: "execution-1",
      goal_id: "goal-1",
      session_id: "session-1",
    })).resolves.toMatchObject({
      execution_id: "execution-1",
      status: "running",
      session_id: "session-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      agent_output: "LRM_PHASE4_EVENT_PASS",
    });
    await expect(query.listSessionEvents({ session_id: "session-1", limit: 2 })).resolves.toMatchObject({
      returned: 2,
      has_more: true,
    });
    await expect(query.listSessionSummaries("workspace-1")).resolves.toMatchObject([{
      session_id: "session-1",
      goal_id: "goal-1",
      task_id: "task-1",
      goal_name: "Phase",
      task_name: "Reply",
      backend_type: "codex_app_server",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      updated_at: expect.any(String),
    }]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({
      registry: new WorkspaceRegistry([{ id: "workspace-1", name: "Workspace", path: root }]),
      statusQuery: query,
    });
    const client = new Client({ name: "event-stream-test", version: "0.1.0" });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const mcpResult = await client.callTool({
      name: "get_session_status",
      arguments: { goal_id: "goal-1", workspace_id: "workspace-1" },
    });
    expect(mcpResult.isError).not.toBe(true);
    expect(mcpResult.structuredContent).toMatchObject({
      session_id: "session-1",
      status: "running_turn",
      current_execution: { execution_id: "execution-1" },
    });
    const executionResult = await client.callTool({
      name: "get_execution_status",
      arguments: { execution_id: "execution-1", workspace_id: "workspace-1" },
    });
    expect(executionResult.isError).not.toBe(true);
    expect(executionResult.structuredContent).toMatchObject({
      execution_id: "execution-1",
      status: "running",
    });
    const eventsResult = await client.callTool({
      name: "list_session_events",
      arguments: { session_id: "session-1", workspace_id: "workspace-1", limit: 2 },
    });
    expect(eventsResult.isError).not.toBe(true);
    expect(eventsResult.structuredContent).toMatchObject({ returned: 2, has_more: true });
  });

  it("clears terminal interactive records while retaining active Sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-status-cleanup-"));
    temporaryDirectories.push(root);
    const sessions = new SessionStore(root);
    const terminal = await sessions.createSession({
      session_id: "session-terminal",
      goal_id: "goal-terminal",
      task_id: "task-terminal",
      backend_type: "codex_app_server",
      status: "completed",
      workspace: "C:\\workspace",
      thread_id: "thread-terminal",
    });
    const active = await sessions.createSession({
      session_id: "session-active",
      goal_id: "goal-active",
      task_id: "task-active",
      backend_type: "codex_app_server",
      status: "active",
      workspace: "C:\\workspace",
      thread_id: "thread-active",
    });
    const tasks = new TaskContextService(root);
    await tasks.createTaskContext({ task_id: terminal.task_id, workspace_id: "workspace-1" });
    const executions = new ExecutionContextService(root);
    await executions.createExecutionContext({
      execution_id: "execution-terminal",
      workspace_id: "workspace-1",
      task_id: terminal.task_id,
      process_id: 9_001,
    });
    const events = new EventStore(root);
    await events.appendEvent({
      session_id: terminal.session_id,
      execution_id: "execution-terminal",
      thread_id: "thread-terminal",
      timestamp: "2026-09-15T00:00:00.000Z",
      event_type: "session_started",
      payload: {},
    });
    const query = new StatusQueryService({
      storageRoot: root,
      sessions,
      goals: {
        getGoal: async (goalId) => ({ goal_id: goalId, workspace_id: "workspace-1" } as GoalOrchestration),
      },
    });

    await expect(query.clearSessionRecords("workspace-1")).resolves.toEqual({
      deleted_sessions: 1,
      deleted_events: 1,
      deleted_tasks: 1,
    });
    await expect(sessions.getSession(terminal.session_id)).resolves.toBeNull();
    await expect(sessions.getSession(active.session_id)).resolves.toMatchObject({ status: "active" });
    await expect(tasks.getTaskContext(terminal.task_id)).resolves.toBeNull();
    await expect(executions.getExecutionContext(
      "workspace-1",
      terminal.task_id,
      "execution-terminal",
    )).resolves.toBeNull();
    await expect(events.listEvents(terminal.session_id)).resolves.toEqual([]);
  });
});
