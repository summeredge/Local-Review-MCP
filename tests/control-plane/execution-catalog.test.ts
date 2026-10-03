import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskExecutionsDirectory } from "../../src/context/execution.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { SessionStore } from "../../src/context/session-store.js";
import { sessionsDirectory } from "../../src/context/session.js";
import { TaskContextService } from "../../src/context/service.js";
import { EventStore } from "../../src/control-plane/events/store.js";
import { CODEX_EXECUTION_COMMAND, codexExecutionLogPaths } from "../../src/control-plane/codex-execution-completion.js";
import {
  goalOrchestrationSchema,
  type GoalOrchestration,
} from "../../src/control-plane/goal-orchestration.js";
import { StatusQueryService } from "../../src/control-plane/status-query.js";

const temporaryDirectories: string[] = [];
const timestamp = "2026-09-15T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function storageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-execution-catalog-"));
  temporaryDirectories.push(root);
  return root;
}

function plannedGoal(options: {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly executionMode?: "batch" | "interactive";
  readonly objective?: string;
  readonly taskGoal?: string;
}): GoalOrchestration {
  return goalOrchestrationSchema.parse({
    goal_id: options.goalId,
    workspace_id: options.workspaceId,
    conversation_id: "conversation-1",
    execution_mode: options.executionMode ?? "batch",
    phases: [{
      phase_id: "phase-1",
      objective: options.objective ?? "Phase",
      tasks: [{
        task_id: options.taskId,
        goal: options.taskGoal ?? "Task",
        requirements: ["Requirement"],
        acceptance_criteria: ["Criterion"],
        max_iterations: 1,
      }],
      status: "running",
    }],
    status: "running",
    current_phase_id: "phase-1",
    current_task_id: options.taskId,
    execution_id: options.executionId,
    actuation_id: "actuation-1",
    loop_id: "loop-1",
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function queryFor(root: string, goals: readonly GoalOrchestration[]): StatusQueryService {
  return new StatusQueryService({
    storageRoot: root,
    goals: {
      getGoal: async (goalId) => goals.find((goal) => goal.goal_id === goalId) ?? null,
      listGoals: async () => [...goals],
    },
  });
}

async function seedExecution(root: string, options: {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly status?: "running" | "passed" | "failed" | "terminated";
  readonly command?: string;
  readonly summary?: string;
}): Promise<void> {
  const tasks = new TaskContextService(root);
  if (await tasks.getTaskContext(options.taskId) === null) {
    await tasks.createTaskContext({
      task_id: options.taskId,
      workspace_id: options.workspaceId,
      conversation_id: "conversation-1",
    });
  }
  const executions = new ExecutionContextService(root);
  await executions.createExecutionContext({
    execution_id: options.executionId,
    task_id: options.taskId,
    workspace_id: options.workspaceId,
    command: options.command ?? CODEX_EXECUTION_COMMAND,
    ...(options.summary === undefined ? {} : { summary: options.summary }),
  });
  if (options.status !== undefined && options.status !== "running") {
    await executions.updateExecutionContext(
      options.workspaceId,
      options.taskId,
      options.executionId,
      { status: options.status },
    );
  }
}

async function seedSession(root: string, options: {
  readonly sessionId: string;
  readonly executionId?: string;
  readonly goalId: string;
  readonly taskId: string;
  readonly backendType: "codex_app_server" | "desktop_codex_app";
  readonly threadId?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly status?: "created" | "starting" | "active" | "running_turn" | "waiting_input" | "completed" | "failed" | "terminated";
}): Promise<void> {
  await new SessionStore(root).createSession({
    session_id: options.sessionId,
    goal_id: options.goalId,
    task_id: options.taskId,
    backend_type: options.backendType,
    status: options.status ?? "active",
    workspace: "C:\\workspace",
    ...(options.threadId === undefined ? {} : { thread_id: options.threadId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: options.reasoningEffort }),
  });
  if (options.executionId !== undefined) {
    await new EventStore(root).appendEvent({
      session_id: options.sessionId,
      execution_id: options.executionId,
      thread_id: options.threadId ?? "thread-1",
      timestamp,
      event_type: "session_started",
      payload: {},
    });
  }
}

describe("Launcher Execution catalog", () => {
  it("binds each iteration by execution_id and shows an actual batch under an interactive Goal", async () => {
    const root = await storageRoot();
    const goal = plannedGoal({ goalId: "goal-1", workspaceId: "workspace-1", taskId: "task-1",
      executionId: "execution-1", executionMode: "interactive" });
    for (let round = 1; round <= 3; round += 1) {
      await seedExecution(root, { workspaceId: "workspace-1", taskId: "task-1",
        executionId: `execution-${round}`, command: "desktop codex_app" });
      await seedSession(root, { sessionId: `session-${round}`, executionId: `execution-${round}`,
        goalId: "goal-1", taskId: "task-1", backendType: "desktop_codex_app",
        threadId: `thread-${round}`, model: `model-${round}`, reasoningEffort: "high" });
    }
    await seedExecution(root, { workspaceId: "workspace-1", taskId: "task-1", executionId: "execution-batch" });
    await seedExecution(root, { workspaceId: "workspace-1", taskId: "task-1",
      executionId: "execution-no-session", command: "desktop codex_app" });
    // Task/Goal alone, or a matching Execution under another Goal, must never bind a Session.
    await seedSession(root, { sessionId: "session-unbound", goalId: "goal-1", taskId: "task-1",
      backendType: "desktop_codex_app" });
    await seedSession(root, { sessionId: "session-wrong-goal", executionId: "execution-no-session",
      goalId: "goal-other", taskId: "task-1", backendType: "desktop_codex_app" });
    const query = queryFor(root, [goal]);
    const rows = await query.listExecutionSummaries();
    await expect(query.getExecutionStatus({ execution_id: "execution-1", workspace_id: "workspace-1" }))
      .resolves.toMatchObject({ session_id: "session-1", thread_id: "thread-1" });
    await expect(query.getExecutionStatus({ execution_id: "execution-1", workspace_id: "workspace-1",
      session_id: "session-2" })).rejects.toThrow("Session does not belong to the requested Execution.");
    for (let round = 1; round <= 3; round += 1) {
      expect(rows.find((row) => row.execution_id === `execution-${round}`)).toMatchObject({
        execution_mode: "interactive", backend: "desktop_codex_app", session_id: `session-${round}`,
        thread_id: `thread-${round}`, model: `model-${round}`, reasoning_effort: "high",
      });
    }
    const batch = rows.find((row) => row.execution_id === "execution-batch")!;
    expect(batch).toMatchObject({ goal_id: "goal-1", execution_mode: "batch", backend: "cli" });
    expect(batch.session_id).toBeUndefined();
    expect(batch.backend_type).toBeUndefined();
    const missing = rows.find((row) => row.execution_id === "execution-no-session")!;
    expect(missing.session_id).toBeUndefined();
    expect(missing.thread_id).toBeUndefined();
    expect(missing.model).toBeUndefined();
  });

  it.each(["passed", "failed", "terminated"] as const)("clears a %s batch Execution without creating a Session", async (status) => {
    const root = await storageRoot();
    await seedExecution(root, {
      workspaceId: "workspace-1", taskId: "task-1", executionId: "execution-1", status,
    });
    await expect(queryFor(root, []).clearExecutionRecords("workspace-1")).resolves.toEqual({
      deleted_executions: 1, deleted_sessions: 0, deleted_events: 0, deleted_tasks: 1,
    });
    await expect(new SessionStore(root).listSessions()).resolves.toEqual([]);
    await expect(queryFor(root, []).listExecutionSummaries("workspace-1")).resolves.toEqual([]);
  });

  it("clears terminal Executions when Session metadata is damaged, retaining uncertain Tasks", async () => {
    const root = await storageRoot();
    await seedExecution(root, {
      workspaceId: "workspace-1", taskId: "task-1", executionId: "execution-1", status: "passed",
    });
    const directory = sessionsDirectory(root);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "session-broken.json"), "{ not json", "utf8");
    await expect(queryFor(root, []).clearExecutionRecords("workspace-1")).resolves.toEqual({
      deleted_executions: 1, deleted_sessions: 0, deleted_events: 0, deleted_tasks: 0,
    });
    await expect(new ExecutionContextService(root).getExecutionContext(
      "workspace-1", "task-1", "execution-1",
    )).resolves.toBeNull();
    await expect(new TaskContextService(root).getTaskContext("task-1")).resolves.not.toBeNull();
  });

  it("fails closed without a valid Workspace scope or with damaged Execution metadata", async () => {
    const root = await storageRoot();
    await seedExecution(root, {
      workspaceId: "workspace-1", taskId: "task-1", executionId: "execution-1", status: "passed",
    });
    const query = queryFor(root, []);
    await expect(query.clearExecutionRecords()).rejects.toThrow("Workspace scope is required");
    await expect(query.clearExecutionRecords("../workspace-1")).rejects.toThrow("Workspace scope is required");
    await writeFile(join(taskExecutionsDirectory(root, "workspace-1", "task-1"), "execution-broken.json"), "{ not json", "utf8");
    await expect(query.clearExecutionRecords("workspace-1")).resolves.toEqual({
      deleted_executions: 0, deleted_sessions: 0, deleted_events: 0, deleted_tasks: 0,
    });
    await expect(new ExecutionContextService(root).getExecutionContext(
      "workspace-1", "task-1", "execution-1",
    )).resolves.toMatchObject({ status: "passed" });
  });

  it("lists a batch Execution that owns no Session", async () => {
    const root = await storageRoot();
    const goal = plannedGoal({
      goalId: "goal-batch",
      workspaceId: "workspace-1",
      taskId: "task-batch",
      executionId: "execution-batch",
      objective: "PCA WebUI chart",
      taskGoal: "Add the time coloring",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-batch",
      executionId: "execution-batch",
      status: "passed",
      summary: "Batch finished",
    });

    const summaries = await queryFor(root, [goal]).listExecutionSummaries();

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      execution_id: "execution-batch",
      workspace_id: "workspace-1",
      task_id: "task-batch",
      goal_id: "goal-batch",
      execution_mode: "batch",
      name: "PCA WebUI chart",
      goal_name: "PCA WebUI chart",
      task_name: "Add the time coloring",
      backend: "cli",
      status: "passed",
      started_at: expect.any(String),
      finished_at: expect.any(String),
      summary: "Batch finished",
      updated_at: expect.any(String),
    });
  });

  it("reads and refreshes bounded running batch events from only the requested Execution log", async () => {
    const root = await storageRoot();
    const query = queryFor(root, []);
    await seedExecution(root, {
      workspaceId: "workspace-1", taskId: "task-batch", executionId: "execution-batch",
    });
    const paths = codexExecutionLogPaths(root, "workspace-1", "task-batch", "execution-batch");
    await mkdir(dirname(paths.stdout), { recursive: true });
    const initialLines = [
      { type: "thread.started", thread_id: "private-thread" },
      { type: "item.started", item: { id: "message-1", type: "agent_message" } },
      { type: "item.delta", item_id: "message-1", delta: "working Bearer " },
      { type: "item.delta", item_id: "message-1", delta: "private-token-value API_TOKEN=private-value" },
      { type: "item.started", item: { id: "command-1", type: "command_execution", command: "API_TOKEN=private" } },
      { type: "future.event", token: "private-token-value" },
    ].map((event) => JSON.stringify(event));
    await writeFile(paths.stdout, `${initialLines.join("\n")}\n{"type":"item.delta","item_id":"message-1","delta":" now"`, "utf8");
    const identity = {
      execution_id: "execution-batch",
      workspace_id: "workspace-1",
      task_id: "task-batch",
    };

    const first = await query.listExecutionEvents(identity);
    expect(first.events.map(({ event_type }) => event_type)).toEqual([
      "execution_started", "agent_message", "command_started", "codex_event",
    ]);
    expect(first.events[1]?.content).toBe("working Bearer [REDACTED] API_TOKEN=[REDACTED]");
    expect(first.events[2]?.content).toBe("Command started.");
    expect(first.events[3]?.content).toBe("future.event");
    expect(JSON.stringify(first)).not.toContain("private-token-value");
    expect(JSON.stringify(first)).not.toContain("API_TOKEN=private");
    expect(first.events[1]?.content).not.toContain("private-thread");

    await writeFile(paths.stdout, "}\n", { encoding: "utf8", flag: "a" });
    const refreshed = await query.listExecutionEvents(identity);
    expect(refreshed.events.map(({ event_type }) => event_type)).toEqual([
      "execution_started", "agent_message", "command_started", "codex_event",
    ]);
    expect(refreshed.events[1]?.content).toBe("working Bearer [REDACTED] API_TOKEN=[REDACTED] now");
    await expect(query.listExecutionEvents({ ...identity, workspace_id: "workspace-2" }))
      .rejects.toThrow("was not found");
    await expect(query.listExecutionEvents({ ...identity, task_id: "task-other" }))
      .rejects.toThrow("was not found");
  });

  it.each(["passed", "failed"] as const)("adds the persisted %s batch terminal event", async (status) => {
    const root = await storageRoot();
    await seedExecution(root, {
      workspaceId: "workspace-1", taskId: "task-batch", executionId: "execution-batch",
      status: "running",
    });
    const executions = new ExecutionContextService(root);
    await executions.updateExecutionContext("workspace-1", "task-batch", "execution-batch", { status });
    const paths = codexExecutionLogPaths(root, "workspace-1", "task-batch", "execution-batch");
    await mkdir(dirname(paths.stdout), { recursive: true });
    await writeFile(paths.stdout, '{"type":"thread.started"}', "utf8");

    await expect(queryFor(root, []).listExecutionEvents({
      execution_id: "execution-batch", workspace_id: "workspace-1", task_id: "task-batch",
    })).resolves.toMatchObject({
      events: [{ event_type: "execution_started" }, { event_type: status === "passed" ? "execution_completed" : "execution_failed" }],
    });
  });

  it("ignores malformed and incomplete running JSONL records", async () => {
    const root = await storageRoot();
    await seedExecution(root, {
      workspaceId: "workspace-1", taskId: "task-batch", executionId: "execution-batch",
    });
    const paths = codexExecutionLogPaths(root, "workspace-1", "task-batch", "execution-batch");
    await mkdir(dirname(paths.stdout), { recursive: true });
    await writeFile(paths.stdout, [
      "not json",
      JSON.stringify({ type: "thread.started" }),
      "{broken json",
      '{"type":"item.delta","item_id":"message-1","delta":"partial"',
    ].join("\n"), "utf8");

    await expect(queryFor(root, []).listExecutionEvents({
      execution_id: "execution-batch", workspace_id: "workspace-1", task_id: "task-batch",
    })).resolves.toMatchObject({ events: [{ event_type: "execution_started" }] });
  });

  it("caps a batch event snapshot at the latest 500 rows while retaining execution start", async () => {
    const root = await storageRoot();
    await seedExecution(root, {
      workspaceId: "workspace-1", taskId: "task-batch", executionId: "execution-batch",
    });
    const paths = codexExecutionLogPaths(root, "workspace-1", "task-batch", "execution-batch");
    await mkdir(dirname(paths.stdout), { recursive: true });
    const contents = [
      { type: "thread.started" },
      ...Array.from({ length: 600 }, (_, index) => ({ type: `future.event.${index}` })),
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    await writeFile(paths.stdout, contents, "utf8");

    const result = await queryFor(root, []).listExecutionEvents({
      execution_id: "execution-batch", workspace_id: "workspace-1", task_id: "task-batch",
    });
    expect(result.events).toHaveLength(500);
    expect(result.events[0]?.event_type).toBe("execution_started");
    expect(result.events[1]?.content).toBe("future.event.101");
    expect(result.events[499]?.content).toBe("future.event.599");
  });

  it("keeps the Desktop Session, model, and reasoning of an interactive Execution", async () => {
    const root = await storageRoot();
    const goal = plannedGoal({
      goalId: "goal-desktop",
      workspaceId: "workspace-1",
      taskId: "task-desktop",
      executionId: "execution-desktop",
      executionMode: "interactive",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-desktop",
      executionId: "execution-desktop",
      command: "desktop codex_app",
    });
    await seedSession(root, {
      sessionId: "session-desktop",
      executionId: "execution-desktop",
      goalId: "goal-desktop",
      taskId: "task-desktop",
      backendType: "desktop_codex_app",
      threadId: "thread-1",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
    });

    const summaries = await queryFor(root, [goal]).listExecutionSummaries();

    expect(summaries[0]).toMatchObject({
      execution_id: "execution-desktop",
      execution_mode: "interactive",
      backend: "desktop_codex_app",
      backend_type: "desktop_codex_app",
      session_id: "session-desktop",
      thread_id: "thread-1",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      status: "running",
    });
  });

  it("reports the app-server backend of an interactive Execution", async () => {
    const root = await storageRoot();
    const goal = plannedGoal({
      goalId: "goal-app-server",
      workspaceId: "workspace-1",
      taskId: "task-app-server",
      executionId: "execution-app-server",
      executionMode: "interactive",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-app-server",
      executionId: "execution-app-server",
      command: "codex app-server --listen stdio://",
    });
    await seedSession(root, {
      sessionId: "session-app-server",
      executionId: "execution-app-server",
      goalId: "goal-app-server",
      taskId: "task-app-server",
      backendType: "codex_app_server",
      threadId: "thread-2",
    });

    const summaries = await queryFor(root, [goal]).listExecutionSummaries();

    expect(summaries[0]).toMatchObject({
      execution_mode: "interactive",
      backend: "codex_app_server",
      backend_type: "codex_app_server",
      session_id: "session-app-server",
      thread_id: "thread-2",
    });
    expect(summaries[0]!.model).toBeUndefined();
    expect(summaries[0]!.reasoning_effort).toBeUndefined();
  });

  it("shows batch and interactive Executions in one table", async () => {
    const root = await storageRoot();
    const batch = plannedGoal({
      goalId: "goal-batch",
      workspaceId: "workspace-1",
      taskId: "task-batch",
      executionId: "execution-batch",
    });
    const interactive = plannedGoal({
      goalId: "goal-desktop",
      workspaceId: "workspace-1",
      taskId: "task-desktop",
      executionId: "execution-desktop",
      executionMode: "interactive",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-batch",
      executionId: "execution-batch",
      status: "passed",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-desktop",
      executionId: "execution-desktop",
      command: "desktop codex_app",
    });
    await seedSession(root, {
      sessionId: "session-desktop",
      executionId: "execution-desktop",
      goalId: "goal-desktop",
      taskId: "task-desktop",
      backendType: "desktop_codex_app",
      threadId: "thread-1",
    });

    const summaries = await queryFor(root, [batch, interactive]).listExecutionSummaries();

    expect(summaries.map((summary) => [
      summary.execution_id,
      summary.execution_mode,
      summary.backend,
      summary.status,
    ]).sort()).toEqual([
      ["execution-batch", "batch", "cli", "passed"],
      ["execution-desktop", "interactive", "desktop_codex_app", "running"],
    ]);
  });

  it("reports the stored Execution status without rewriting it", async () => {
    const root = await storageRoot();
    const goals = [
      plannedGoal({
        goalId: "goal-running",
        workspaceId: "workspace-1",
        taskId: "task-running",
        executionId: "execution-running",
      }),
      plannedGoal({
        goalId: "goal-failed",
        workspaceId: "workspace-1",
        taskId: "task-failed",
        executionId: "execution-failed",
      }),
    ];
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-running",
      executionId: "execution-running",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-failed",
      executionId: "execution-failed",
      status: "failed",
    });

    const summaries = await queryFor(root, goals).listExecutionSummaries();

    expect(new Map(summaries.map((summary) => [summary.execution_id, summary.status]))).toEqual(
      new Map([["execution-running", "running"], ["execution-failed", "failed"]]),
    );
  });

  it("scopes the catalog to the requested workspace", async () => {
    const root = await storageRoot();
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-1",
      executionId: "execution-1",
    });
    await seedExecution(root, {
      workspaceId: "workspace-2",
      taskId: "task-2",
      executionId: "execution-2",
    });

    const scoped = await queryFor(root, []).listExecutionSummaries("workspace-1");
    const all = await queryFor(root, []).listExecutionSummaries();

    expect(scoped.map((summary) => summary.execution_id)).toEqual(["execution-1"]);
    expect(all.map((summary) => summary.execution_id).sort()).toEqual([
      "execution-1",
      "execution-2",
    ]);
  });

  it("degrades a damaged or unassociated Execution without losing the rest", async () => {
    const root = await storageRoot();
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-intact",
      executionId: "execution-intact",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-orphan",
      executionId: "execution-orphan",
    });
    const brokenDirectory = taskExecutionsDirectory(root, "workspace-1", "task-broken");
    await mkdir(brokenDirectory, { recursive: true });
    await writeFile(join(brokenDirectory, "execution-broken.json"), "{ not json", "utf8");

    const summaries = await queryFor(root, []).listExecutionSummaries();

    expect(summaries.map((summary) => summary.execution_id).sort()).toEqual([
      "execution-intact",
      "execution-orphan",
    ]);
    expect(summaries[0]).toMatchObject({
      name: expect.any(String),
      status: "running",
    });
    const orphan = summaries.find((summary) => summary.execution_id === "execution-orphan")!;
    expect(orphan).toEqual({
      execution_id: "execution-orphan",
      workspace_id: "workspace-1",
      task_id: "task-orphan",
      name: "task-orphan",
      task_name: "task-orphan",
      execution_mode: "batch",
      backend: "cli",
      status: "running",
      started_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it("clears terminal batch Executions in one Workspace and keeps running or shared records", async () => {
    const root = await storageRoot();
    const tasks = new TaskContextService(root);
    const executions = new ExecutionContextService(root);
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-terminal-batch",
      executionId: "execution-terminal-batch",
      status: "passed",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-shared",
      executionId: "execution-terminal-shared",
      status: "failed",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-shared",
      executionId: "execution-running-shared",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-running-batch",
      executionId: "execution-running-batch",
    });
    await seedExecution(root, {
      workspaceId: "workspace-2",
      taskId: "task-other-workspace",
      executionId: "execution-other-workspace",
      status: "passed",
    });
    const query = queryFor(root, []);

    await expect(query.clearSessionRecords("workspace-1")).resolves.toEqual({
      deleted_executions: 2,
      deleted_sessions: 0,
      deleted_events: 0,
      deleted_tasks: 1,
    });
    await expect(tasks.getTaskContext("task-terminal-batch")).resolves.toBeNull();
    await expect(tasks.getTaskContext("task-shared")).resolves.toMatchObject({ task_id: "task-shared" });
    await expect(executions.getExecutionContext(
      "workspace-1", "task-shared", "execution-terminal-shared",
    )).resolves.toBeNull();
    await expect(executions.getExecutionContext(
      "workspace-1", "task-shared", "execution-running-shared",
    )).resolves.toMatchObject({ status: "running" });
    await expect(executions.getExecutionContext(
      "workspace-1", "task-running-batch", "execution-running-batch",
    )).resolves.toMatchObject({ status: "running" });
    await expect(executions.getExecutionContext(
      "workspace-2", "task-other-workspace", "execution-other-workspace",
    )).resolves.toMatchObject({ status: "passed" });

    await expect(query.listExecutionSummaries("workspace-1")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ execution_id: "execution-running-shared", status: "running" }),
      expect.objectContaining({ execution_id: "execution-running-batch", status: "running" }),
    ]));
    await expect(query.listExecutionSummaries("workspace-1")).resolves.toEqual(expect.not.arrayContaining([
      expect.objectContaining({ execution_id: "execution-terminal-batch" }),
      expect.objectContaining({ execution_id: "execution-terminal-shared" }),
    ]));
    await expect(query.listExecutionSummaries("workspace-2")).resolves.toEqual([
      expect.objectContaining({ execution_id: "execution-other-workspace", status: "passed" }),
    ]);
  });

  it.each(["passed", "failed", "terminated"] as const)("clears a %s interactive Execution, Session, and its Events", async (status) => {
    const root = await storageRoot();
    const goal = plannedGoal({
      goalId: "goal-terminal-interactive",
      workspaceId: "workspace-1",
      taskId: "task-terminal-interactive",
      executionId: "execution-terminal-interactive",
      executionMode: "interactive",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-terminal-interactive",
      executionId: "execution-terminal-interactive",
      status,
    });
    await seedSession(root, {
      sessionId: "session-terminal-interactive",
      goalId: goal.goal_id,
      taskId: "task-terminal-interactive",
      backendType: "desktop_codex_app",
      threadId: "thread-terminal-interactive",
      status: "completed",
    });
    const events = new EventStore(root);
    await events.appendEvent({
      session_id: "session-terminal-interactive",
      execution_id: "execution-terminal-interactive",
      thread_id: "thread-terminal-interactive",
      timestamp,
      event_type: "session_started",
      payload: {},
    });
    const query = queryFor(root, [goal]);

    await expect(query.clearSessionRecords("workspace-1")).resolves.toEqual({
      deleted_executions: 1,
      deleted_sessions: 1,
      deleted_events: 1,
      deleted_tasks: 0,
    });
    await expect(new SessionStore(root).getSession("session-terminal-interactive")).resolves.toBeNull();
    await expect(events.listEvents("session-terminal-interactive")).resolves.toEqual([]);
    await expect(new ExecutionContextService(root).getExecutionContext(
      "workspace-1", "task-terminal-interactive", "execution-terminal-interactive",
    )).resolves.toBeNull();
    await expect(query.listExecutionSummaries("workspace-1")).resolves.toEqual([]);
  });

  it("retains a running interactive Execution, Session, and Events", async () => {
    const root = await storageRoot();
    const goal = plannedGoal({
      goalId: "goal-running-interactive",
      workspaceId: "workspace-1",
      taskId: "task-running-interactive",
      executionId: "execution-running-interactive",
      executionMode: "interactive",
    });
    await seedExecution(root, {
      workspaceId: "workspace-1",
      taskId: "task-running-interactive",
      executionId: "execution-running-interactive",
      command: "codex app-server --listen stdio://",
    });
    await seedSession(root, {
      sessionId: "session-running-interactive",
      goalId: goal.goal_id,
      taskId: "task-running-interactive",
      backendType: "codex_app_server",
      threadId: "thread-running-interactive",
      status: "running_turn",
    });
    const events = new EventStore(root);
    await events.appendEvent({
      session_id: "session-running-interactive",
      execution_id: "execution-running-interactive",
      thread_id: "thread-running-interactive",
      timestamp,
      event_type: "session_started",
      payload: {},
    });
    const query = queryFor(root, [goal]);

    await expect(query.clearSessionRecords("workspace-1")).resolves.toEqual({
      deleted_executions: 0,
      deleted_sessions: 0,
      deleted_events: 0,
      deleted_tasks: 0,
    });
    await expect(new SessionStore(root).getSession("session-running-interactive"))
      .resolves.toMatchObject({ status: "running_turn" });
    await expect(events.listEvents("session-running-interactive")).resolves.toHaveLength(1);
    await expect(query.listExecutionSummaries("workspace-1")).resolves.toMatchObject([
      expect.objectContaining({
        execution_id: "execution-running-interactive",
        execution_mode: "interactive",
        backend: "codex_app_server",
      }),
    ]);
  });
});
