import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { GoalSubmissionService, type GoalSubmissionRequest } from "../../src/control-plane/goal-submission.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { SessionStore } from "../../src/context/session-store.js";
import { TaskContextService } from "../../src/context/service.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

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
  public readonly thread = vi.fn(async (input: { cwd: string; model?: string }): Promise<AppServerThread> => ({
    thread_id: "thread-001",
    session_id: "provider-session-001",
    ...(input.model === undefined ? {} : { model: input.model }),
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
      model: "provider-default",
      label: "Provider default",
      efforts: ["high"],
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

async function fixture(): Promise<{
  readonly root: string;
  readonly workspaceRoot: string;
  readonly executions: ExecutionContextService;
  readonly sessions: SessionStore;
  readonly cliStart: ReturnType<typeof vi.fn>;
  readonly appClient: FakeAppServerClient;
  readonly appFactory: ReturnType<typeof vi.fn>;
  readonly executionService: ExecutionService;
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
  const cliStart = vi.fn(async (input: ExecutionBackendStartRequest): Promise<ExecutionStartResult> => {
    const execution = await executions.createExecutionContext({
      execution_id: input.execution_id,
      task_id: input.task_id,
      workspace_id: input.workspace_id,
      process_id: 9_002,
      command: "codex exec --json -",
    });
    return {
      execution_id: execution.execution_id,
      process_id: execution.process_id!,
      started_at: execution.started_at,
      accepted: "new",
    };
  });
  const executionService = new ExecutionService(new ExecutionBackendRouter({
    batch: new CliExecutionBackend({ start: cliStart }),
    interactive: appBackend,
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
    storageRoot: root,
    taskContextService: tasks,
    executionContextService: executions,
    authorizationStore: authorizations,
    controlledActuation: controlled,
    autoIteration: auto,
  });
  return {
    root,
    workspaceRoot,
    executions,
    sessions,
    cliStart,
    appClient,
    appFactory,
    executionService,
    submit: new GoalSubmissionService(orchestration, { checkGoalPreflight: async (input) => preflight(input) }),
  };
}

describe("interactive Goal submission", () => {
  it("keeps the default batch route on the existing CLI backend", async () => {
    const value = await fixture();
    const submitted = await value.submit.submitGoal(request());

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
    const submitted = await value.submit.submitGoal(request("interactive"));
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
      model: "provider-default",
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
});
