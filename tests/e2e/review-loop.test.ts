import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoIterationSchema,
  type AutoIteration,
  type AutoIterationStartInput,
} from "../../src/control-plane/auto-iteration.js";
import {
  ActuationAuthorizationStore,
  ControlledActuationService,
} from "../../src/control-plane/controlled-actuation.js";
import {
  CodexAppServerBackend,
  type AppServerClientFactory,
} from "../../src/backends/codex_app_server/backend.js";
import type { CodexAppServerEvent } from "../../src/backends/codex_app_server/events.js";
import type {
  AppServerModel,
  AppServerThread,
  AppServerTurn,
  CodexAppServerExit,
  CodexAppServerProcessInfo,
} from "../../src/backends/codex_app_server/models.js";
import {
  CliExecutionBackend,
  ExecutionBackendRouter,
  ExecutionService,
} from "../../src/control-plane/execution-service.js";
import {
  ConversationCorrelationRegistry,
} from "../../src/control-plane/conversation-correlation.js";
import {
  PendingGoalSubmissionService,
  type PendingGoalSubmission,
} from "../../src/control-plane/pending-goal-submission.js";
import { EventStore } from "../../src/control-plane/events/store.js";
import {
  GoalOrchestrationService,
} from "../../src/control-plane/goal-orchestration.js";
import {
  GoalSubmissionService,
} from "../../src/control-plane/goal-submission.js";
import {
  SessionStore,
} from "../../src/context/session-store.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { TaskContextService } from "../../src/context/service.js";
import {
  StatusQueryService,
  type ExecutionStatusOutput,
  type SessionEventsOutput,
  type SessionStatusOutput,
} from "../../src/control-plane/status-query.js";
import type { ReviewResult } from "../../src/context/review-result.js";
import {
  ReviewVerdictParser,
} from "../../src/control/review-verdict-parser.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { ReviewContextService, type WorkspaceReviewContext } from "../../src/review/review-context.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];
const clients: Client[] = [];
const executionServices: ExecutionService[] = [];

afterEach(async () => {
  await Promise.all(executionServices.splice(0).map((service) => service.close()));
  await Promise.all(clients.splice(0).map((client) => client.close()));
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
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ done: true, value: undefined as never });
    }
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
    process_id: 56_001,
    codex_version: "phase56-test",
    transport: "stdio",
    status: "ready",
  };
  public readonly thread = vi.fn(async (input: { cwd: string; model?: string }): Promise<AppServerThread> => ({
    thread_id: "thread-phase56",
    session_id: "provider-session-phase56",
    ...(input.model === undefined ? {} : { model: input.model }),
    cwd: input.cwd,
  }));
  public readonly turn = vi.fn(async (_input: {
    threadId: string;
    text: string;
    model?: string;
    effort?: string;
  }): Promise<AppServerTurn> => ({
    turn_id: "turn-phase56",
    status: "in_progress",
  }));
  public readonly stream = new FakeEventStream();
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

  public constructor(private readonly target: string) {
    this.turn.mockImplementation(async (input) => {
      await writeFile(this.target, "LRM_PHASE5_6_BASELINE\nLRM_PHASE5_6_INTERACTIVE_PASS\n", "utf8");
      return {
        turn_id: "turn-phase56",
        status: "in_progress",
      };
    });
  }

  public listModels(): Promise<readonly AppServerModel[]> {
    return Promise.resolve([{
      model: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      default_effort: "medium",
      is_default: false,
    }]);
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

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    env: gitEnvironment(),
    windowsHide: true,
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Phase 5.6 E2E state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function callTool<T>(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: arguments_ });
  expect(result.isError).not.toBe(true);
  return result.structuredContent as T;
}

function startedSubmission(record: PendingGoalSubmission | null): Extract<PendingGoalSubmission, { state: "started" }> {
  if (record?.state !== "started") throw new Error("Pending Goal submission did not start.");
  return record;
}

async function fixture(): Promise<{
  readonly client: Client;
  readonly appClient: FakeAppServerClient;
  readonly correlations: ConversationCorrelationRegistry;
  readonly pending: PendingGoalSubmissionService;
  readonly sessions: SessionStore;
  readonly statusQuery: StatusQueryService;
  readonly workspaceId: string;
  readonly target: string;
}> {
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-phase56-state-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-phase56-workspace-"));
  temporaryDirectories.push(storageRoot, workspaceRoot);

  const target = join(workspaceRoot, "docs", "e2e-validation-marker.md");
  await mkdir(join(workspaceRoot, "docs"), { recursive: true });
  await writeFile(target, "LRM_PHASE5_6_BASELINE\n", "utf8");
  await git(workspaceRoot, "init", "-b", "main");
  await git(workspaceRoot, "config", "user.email", "phase56@example.invalid");
  await git(workspaceRoot, "config", "user.name", "Phase 5.6 E2E");
  await git(workspaceRoot, "add", "docs/e2e-validation-marker.md");
  await git(workspaceRoot, "commit", "-m", "phase56 baseline");

  const workspaceId = "phase56-e2e";
  const registry = new WorkspaceRegistry([{
    id: workspaceId,
    name: "Phase 5.6 E2E",
    path: workspaceRoot,
  }]);
  const tasks = new TaskContextService(storageRoot);
  const executions = new ExecutionContextService(storageRoot);
  const sessions = new SessionStore(storageRoot);
  const events = new EventStore(storageRoot);
  const appClient = new FakeAppServerClient(target);
  const appFactory = vi.fn<AppServerClientFactory>(async () => appClient);
  const appBackend = new CodexAppServerBackend(registry, {
    storageRoot,
    clientFactory: appFactory,
  });
  const executionService = new ExecutionService(new ExecutionBackendRouter({
    batch: new CliExecutionBackend({
      start: async () => { throw new Error("batch backend is outside this E2E scenario"); },
    }),
    interactive: appBackend,
  }));
  executionServices.push(executionService);
  const authorizations = new ActuationAuthorizationStore(storageRoot);
  const controlled = new ControlledActuationService(registry, {
    storageRoot,
    authorizationStore: authorizations,
    taskContextService: tasks,
    executionContextService: executions,
    adapter: executionService,
  });
  const loops = new Map<string, AutoIteration>();
  const auto = {
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
    storageRoot,
    taskContextService: tasks,
    executionContextService: executions,
    authorizationStore: authorizations,
    controlledActuation: controlled,
    autoIteration: auto,
  });
  const goalSubmission = new GoalSubmissionService(orchestration, {
    checkGoalPreflight: async (input) => ({
      ready: true,
      runtime: { ready: true },
      connector: { ready: true, status: "verified", action: "none" },
      extension: { ready: true, paired: true, present: true, bridge_available: true },
      workspace: { valid: true, workspace_id: input.workspace_id },
      conversation: { valid: true, conversation_id: input.conversation_id },
    }),
  });
  const correlations = new ConversationCorrelationRegistry(storageRoot);
  const pending = new PendingGoalSubmissionService(correlations, goalSubmission, { storageRoot });
  const statusQuery = new StatusQueryService({
    storageRoot,
    goals: orchestration,
    sessions,
    executions,
    tasks,
    events,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ registry, pendingGoalSubmission: pending, statusQuery });
  const client = new Client({ name: "phase56-e2e", version: "0.1.0" });
  clients.push(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, appClient, correlations, pending, sessions, statusQuery, workspaceId, target };
}

describe("Phase 5.6 end-to-end Review Loop", () => {
  it("carries an authorized workspace through interactive execution to APPROVE", async () => {
    const value = await fixture();
    const listed = await value.client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining([
      "workspace_list",
      "workspace_review_context",
      "workspace_read_file",
      "workspace_search",
      "submit_goal",
      "get_session_status",
      "get_execution_status",
      "list_session_events",
    ]));
    for (const name of ["workspace_review_context", "workspace_read_file", "workspace_search"]) {
      expect(listed.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
    }
    expect(toolNames).not.toEqual(expect.arrayContaining(["write_file", "execute", "shell"]));

    const initial = await callTool<WorkspaceReviewContext>(
      value.client,
      "workspace_review_context",
      { workspace_id: value.workspaceId },
    );
    expect(initial).toMatchObject({
      workspace_id: value.workspaceId,
      git_status: { status: "clean" },
      changed_files: [],
      review_candidates: [],
    });
    expect(initial.git_status.branch).toBe("main");

    const before = await callTool<{
      readonly path: string;
      readonly content: string;
      readonly start_line: number;
      readonly end_line: number;
      readonly truncated: boolean;
    }>(value.client, "workspace_read_file", {
      workspace_id: value.workspaceId,
      path: "docs/e2e-validation-marker.md",
      start_line: 1,
      end_line: 10,
    });
    expect(before).toMatchObject({
      path: "docs/e2e-validation-marker.md",
      content: "LRM_PHASE5_6_BASELINE",
      start_line: 1,
      end_line: 1,
      truncated: false,
    });
    const locatedBefore = await callTool<{
      readonly results: readonly { path: string; line: number; text: string }[];
      readonly truncated: boolean;
    }>(value.client, "workspace_search", {
      workspace_id: value.workspaceId,
      query: "LRM_PHASE5_6_BASELINE",
      path: "docs",
    });
    expect(locatedBefore).toMatchObject({
      results: [{ path: "docs/e2e-validation-marker.md", line: 1 }],
      truncated: false,
    });

    const correlationKey = crypto.randomUUID();
    const accepted = await callTool<{ readonly accepted: true; readonly correlation_key: string }>(
      value.client,
      "submit_goal",
      {
        workspace_id: value.workspaceId,
        correlation_key: correlationKey,
        title: "Phase 5.6 interactive E2E marker",
        goal: "Append one validation line to docs/e2e-validation-marker.md.",
        requirements: [
          "Use the interactive Codex backend.",
          "Modify only docs/e2e-validation-marker.md.",
          "Do not create a git commit.",
        ],
        acceptance_criteria: [
          "The target file contains LRM_PHASE5_6_INTERACTIVE_PASS.",
          "The execution finishes successfully.",
        ],
        max_iterations: 1,
        execution_mode: "interactive",
        model: "gpt-5.6-luna",
        reasoning_effort: "max",
      },
    );
    expect(accepted).toMatchObject({ accepted: true, correlation_key: correlationKey });
    expect((await value.pending.get(correlationKey))?.execution_mode).toBe("interactive");
    expect((await value.pending.get(correlationKey))?.model).toBe("gpt-5.6-luna");
    expect((await value.pending.get(correlationKey))?.reasoning_effort).toBe("max");

    await value.correlations.observe({
      request_id: correlationKey,
      conversation_id: "phase56-conversation",
      document_id: "phase56-document",
      navigation_epoch: 0,
    });
    value.pending.scheduleResolve(correlationKey);
    const submission = startedSubmission(await (async () => {
      await waitFor(async () => (await value.pending.get(correlationKey))?.state === "started");
      return value.pending.get(correlationKey);
    })());

    const session = (await value.sessions.listSessions()).find((candidate) => candidate.goal_id === submission.goal_id);
    expect(session).toBeDefined();
    expect(session).toMatchObject({
      backend_type: "codex_app_server",
      status: "active",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      thread_id: "thread-phase56",
    });
    expect(value.appClient.thread).toHaveBeenCalledWith({
      cwd: expect.any(String),
      model: "gpt-5.6-luna",
    });
    expect(value.appClient.turn).toHaveBeenCalledWith({
      threadId: "thread-phase56",
      text: expect.stringContaining("Append one validation line"),
      model: "gpt-5.6-luna",
      effort: "max",
    });

    value.appClient.stream.push({
      type: "thread_started",
      thread_id: "thread-phase56",
      session_id: "provider-session-phase56",
    });
    value.appClient.stream.push({
      type: "turn_started",
      thread_id: "thread-phase56",
      turn_id: "turn-phase56",
    });
    await waitFor(async () => (await value.sessions.getSession(session!.session_id))?.status === "running_turn");
    value.appClient.stream.push({
      type: "agent_message_delta",
      thread_id: "thread-phase56",
      turn_id: "turn-phase56",
      item_id: "item-phase56",
      content: "LRM_PHASE5_6_",
    });
    value.appClient.stream.push({
      type: "agent_message_completed",
      thread_id: "thread-phase56",
      turn_id: "turn-phase56",
      item_id: "item-phase56",
      content: "LRM_PHASE5_6_INTERACTIVE_PASS",
    });
    value.appClient.stream.push({
      type: "turn_completed",
      thread_id: "thread-phase56",
      turn_id: "turn-phase56",
    });
    await waitFor(async () => (await value.sessions.getSession(session!.session_id))?.status === "completed");

    const sessionStatus = await callTool<SessionStatusOutput>(value.client, "get_session_status", {
      workspace_id: value.workspaceId,
      session_id: session!.session_id,
    });
    expect(sessionStatus).toMatchObject({
      session_id: session!.session_id,
      status: "completed",
      backend_type: "codex_app_server",
      thread_id: "thread-phase56",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
      current_execution: { execution_id: submission.execution_id, status: "passed", turn_id: "turn-phase56" },
    });
    const executionStatus = await callTool<ExecutionStatusOutput>(value.client, "get_execution_status", {
      workspace_id: value.workspaceId,
      execution_id: submission.execution_id,
      session_id: session!.session_id,
    });
    expect(executionStatus).toMatchObject({
      execution_id: submission.execution_id,
      status: "passed",
      session_id: session!.session_id,
      thread_id: "thread-phase56",
      turn_id: "turn-phase56",
      agent_output: "LRM_PHASE5_6_INTERACTIVE_PASS",
    });
    const eventStatus = await callTool<SessionEventsOutput>(value.client, "list_session_events", {
      workspace_id: value.workspaceId,
      session_id: session!.session_id,
    });
    expect(eventStatus.events.map((event) => event.event_type)).toEqual([
      "session_started",
      "turn_started",
      "agent_message_delta",
      "agent_message_completed",
      "turn_completed",
    ]);

    const launcher = await value.statusQuery.listSessionSummaries(value.workspaceId);
    expect(launcher).toEqual([expect.objectContaining({
      goal_id: submission.goal_id,
      task_id: submission.task_id,
      session_id: session!.session_id,
      thread_id: "thread-phase56",
      status: "completed",
      model: "gpt-5.6-luna",
      reasoning_effort: "max",
    })]);

    const after = await callTool<WorkspaceReviewContext>(
      value.client,
      "workspace_review_context",
      { workspace_id: value.workspaceId },
    );
    expect(after).toMatchObject({
      workspace_id: value.workspaceId,
      git_status: { status: "dirty" },
      changed_files: ["docs/e2e-validation-marker.md"],
      review_candidates: [{ path: "docs/e2e-validation-marker.md", status: "modified" }],
      diff_summary: { files_changed: 1, insertions: 1, deletions: 0 },
    });
    expect(after.diff.unstaged).toContain("+LRM_PHASE5_6_INTERACTIVE_PASS");
    const changed = await callTool<{ readonly content: string; readonly path: string }>(
      value.client,
      "workspace_read_file",
      {
        workspace_id: value.workspaceId,
        path: "docs/e2e-validation-marker.md",
        start_line: 1,
        end_line: 10,
      },
    );
    expect(changed).toMatchObject({
      path: "docs/e2e-validation-marker.md",
      content: "LRM_PHASE5_6_BASELINE\nLRM_PHASE5_6_INTERACTIVE_PASS",
    });
    const locatedAfter = await callTool<{
      readonly results: readonly { path: string; line: number; text: string }[];
      readonly truncated: boolean;
    }>(value.client, "workspace_search", {
      workspace_id: value.workspaceId,
      query: "LRM_PHASE5_6_INTERACTIVE_PASS",
      path: "docs",
    });
    expect(locatedAfter).toMatchObject({
      results: [{ path: "docs/e2e-validation-marker.md", line: 2 }],
      truncated: false,
    });
    expect((await readFile(value.target, "utf8")).trim()).toBe(
      "LRM_PHASE5_6_BASELINE\nLRM_PHASE5_6_INTERACTIVE_PASS",
    );

    const reviewRequestId = "review-phase56-e2e";
    const reviewResult: ReviewResult = {
      result_id: "result-phase56-e2e",
      review_request_id: reviewRequestId,
      delivery_id: "delivery-phase56-e2e",
      workspace_id: value.workspaceId,
      task_id: submission.task_id,
      status: "COMPLETED",
      content: [
        "The requested marker is the only change.",
        "<lrm-review-result>",
        JSON.stringify({
          schema_version: 1,
          review_request_id: reviewRequestId,
          decision: "APPROVE",
          summary: "Only the low-risk validation marker changed; no blocking findings.",
        }),
        "</lrm-review-result>",
      ].join("\n"),
      created_at: "2026-09-15T00:00:00.000Z",
    };
    expect(new ReviewVerdictParser().parse(reviewResult)).toMatchObject({
      decision: "APPROVE",
      review_request_id: reviewRequestId,
    });
  });
});
