import { resolve } from "node:path";
import { ExecutionContextService } from "../context/execution-service.js";
import { SessionStore } from "../context/session-store.js";
import { TaskContextService } from "../context/service.js";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import type { ExecutionContext, Session } from "../context/types.js";
import type { DesktopSyncState } from "../desktop-sync/desktop-sync-state.js";
import { EventStore } from "../control-plane/events/store.js";
import type { LrmEvent } from "../control-plane/events/model.js";
import {
  executionBackendStartRequestSchema,
  type ExecutionBackend,
  type ExecutionBackendStartRequest,
  type ExecutionStartResult,
  type ExecutionTerminalListener,
} from "../control-plane/execution-service.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { createCodexAppToolContracts } from "./codex-app-contracts.js";
import { CodexAppRuntimeError, type CodexAppMcpClient } from "./codex-app-runtime.js";
import type { DesktopCodexRuntimeProvider } from "./desktop-tools-pipe-probe.js";
import {
  DesktopCompletionObserver,
  type DesktopCompletionBaseline,
  type DesktopCompletionResult,
} from "./completion-observer.js";
import { resolveDesktopProject } from "./desktop-project-resolver.js";
import { DesktopThreadBindingStore } from "./desktop-thread-binding-store.js";
import { DesktopThreadCoordinator } from "./desktop-thread-coordinator.js";
import { DesktopCodexThreadCommands } from "./thread-commands.js";

/** Stable, honest command label. Desktop executions never claim an app-server command. */
export const DESKTOP_EXECUTION_COMMAND = "desktop codex_app";
export const DESKTOP_EXECUTION_BACKEND_IDENTITY = "desktop_codex_app" as const;

const SUMMARY_MAX_LENGTH = 4_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 120_000;

export type DesktopExecutionErrorCode =
  | "desktop_backend_closed"
  | "desktop_execution_mode_required"
  | "desktop_goal_required"
  | "desktop_disconnected"
  | "executor_identity_unavailable"
  | "desktop_tools_pipe_unavailable"
  | "runtime_connect_failed"
  | "tools_contract_incompatible"
  | "unsupported_execution_option"
  | "execution_not_recoverable"
  | "desktop_target_conflict";

export class DesktopExecutionError extends Error {
  public constructor(public readonly code: DesktopExecutionErrorCode, message: string) {
    super(message);
    this.name = "DesktopExecutionError";
  }
}

export interface DesktopCodexBackendOptions {
  readonly storageRoot?: string;
  readonly eventStore?: Pick<EventStore, "appendEvent">;
  readonly runtimeFactory?: DesktopCodexRuntimeProvider;
  readonly desktopState?: () => DesktopSyncState;
  readonly completionTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => string;
}

interface DesktopRuntime {
  listTools(): Promise<{ readonly tools: readonly { readonly name: string }[] }>;
  readonly mcpClient?: Pick<CodexAppMcpClient, "callTool">;
  close(): Promise<void>;
}

interface WatchContext {
  readonly runtime: DesktopRuntime;
  readonly request: ExecutionBackendStartRequest;
  readonly sessionId: string;
  readonly executorThreadId: string;
  readonly baseline: DesktopCompletionBaseline;
  readonly threadId: string;
  readonly hostId: string;
  /** Set once the observer has produced a verifiable turn id for this Execution. */
  resolvedTurnId?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

function boundedSummary(value: string | undefined, fallback: string): string {
  const summary = value?.trim().slice(0, SUMMARY_MAX_LENGTH) ?? "";
  return summary === "" ? fallback : summary;
}

function requestKey(request: ExecutionBackendStartRequest): string {
  return request.workspace_id + "\0" + request.task_id + "\0" + request.execution_id;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export class DesktopCodexBackend implements ExecutionBackend {
  public readonly storageRoot: string;
  private readonly sessions: SessionStore;
  private readonly executions: ExecutionContextService;
  private readonly tasks: TaskContextService;
  private readonly events: Pick<EventStore, "appendEvent">;
  private readonly runtimeFactory: DesktopCodexRuntimeProvider | undefined;
  private readonly desktopState: (() => DesktopSyncState) | undefined;
  private readonly completionTimeoutMs: number;
  private readonly pollIntervalMs: number | undefined;
  private readonly now: () => string;
  private readonly inFlight = new Map<string, Promise<ExecutionStartResult>>();
  private readonly runtimes = new Map<string, DesktopRuntime>();
  private readonly completions = new Map<string, Promise<void>>();
  private terminalListener: ExecutionTerminalListener | undefined;
  private closing = false;

  public constructor(
    private readonly registry: WorkspaceRegistry,
    options: DesktopCodexBackendOptions = {},
  ) {
    this.storageRoot = resolve(options.storageRoot ?? defaultTaskContextStorageRoot());
    this.sessions = new SessionStore(this.storageRoot);
    this.executions = new ExecutionContextService(this.storageRoot);
    this.tasks = new TaskContextService(this.storageRoot);
    this.events = options.eventStore ?? new EventStore(this.storageRoot);
    this.runtimeFactory = options.runtimeFactory;
    this.desktopState = options.desktopState;
    this.completionTimeoutMs = options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public start(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    const parsed = executionBackendStartRequestSchema.parse(request);
    if (parsed.execution_mode !== "interactive") {
      throw new DesktopExecutionError(
        "desktop_execution_mode_required",
        "DesktopCodexBackend only handles interactive executions.",
      );
    }
    if (parsed.goal_id === undefined) {
      throw new DesktopExecutionError("desktop_goal_required", "Interactive execution requires goal_id.");
    }
    if (parsed.model !== undefined || parsed.reasoning_effort !== undefined) {
      throw new DesktopExecutionError(
        "unsupported_execution_option",
        "Desktop codex_app does not accept an explicit model or reasoning_effort.",
      );
    }
    if (this.closing) {
      throw new DesktopExecutionError("desktop_backend_closed", "Desktop codex_app backend is closed.");
    }

    const key = requestKey(parsed);
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending.then((result) => ({ ...result, accepted: "existing" as const }));

    const operation = this.startOnce(parsed);
    this.inFlight.set(key, operation);
    void operation.finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  public setTerminalListener(listener: ExecutionTerminalListener | undefined): void {
    this.terminalListener = listener;
  }

  /**
   * Test/shutdown seam: resolves once every in-flight Desktop execution has finished projecting its
   * terminal Session and Execution state. It never starts work.
   */
  public whenIdle(): Promise<void> {
    return Promise.all([...this.completions.values()]).then(() => undefined);
  }

  public async close(): Promise<void> {
    this.closing = true;
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(runtimes.map((runtime) => runtime.close().catch(() => undefined)));
  }

  private executorIdentity(): string {
    let state: DesktopSyncState | undefined;
    try {
      state = this.desktopState?.();
    } catch {
      state = undefined;
    }
    if (state?.connected !== true) {
      throw new DesktopExecutionError("desktop_disconnected", "Desktop is not connected.");
    }
    const conversationId = nonEmpty(state.currentConversationId);
    if (conversationId === undefined) {
      throw new DesktopExecutionError(
        "executor_identity_unavailable",
        "Desktop executor conversation identity is unavailable.",
      );
    }
    return conversationId;
  }

  private async startOnce(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    const workspace = this.registry.resolve(request.workspace_id);
    const cwd = workspace.manager.canonicalRoot;
    const task = await this.tasks.getTaskContext(request.task_id);
    if (task === null) throw new Error('Task context "' + request.task_id + '" was not found.');
    if (task.workspace_id !== request.workspace_id) {
      throw new Error("Task context does not belong to the requested workspace.");
    }

    const existing = await this.executions.getExecutionContext(
      request.workspace_id,
      request.task_id,
      request.execution_id,
    );
    if (existing !== null) return this.existing(request, existing);

    // The executor identity is captured once per Execution and never persisted.
    const executorThreadId = this.executorIdentity();

    const runtime = await this.connectRuntime();
    let session: Session | undefined;
    let execution: ExecutionContext | undefined;
    try {
      const { commands, contracts, client } = await this.prepare(runtime);
      // Every codex_app tools/call in this Execution must use the executor captured above, so the
      // value is threaded through instead of being re-read from the current Desktop foreground.
      const projectId = await this.resolveProject(commands, cwd, executorThreadId);

      session = await this.sessions.createSession({
        goal_id: request.goal_id!,
        task_id: request.task_id,
        backend_type: DESKTOP_EXECUTION_BACKEND_IDENTITY,
        status: "created",
        workspace: cwd,
      });
      session = await this.sessions.updateSession(session.session_id, { status: "starting" });
      execution = await this.executions.createExecutionContext({
        execution_id: request.execution_id,
        task_id: request.task_id,
        workspace_id: request.workspace_id,
        status: "running",
        command: DESKTOP_EXECUTION_COMMAND,
      });

      const coordinator = new DesktopThreadCoordinator({
        commands,
        bindings: new DesktopThreadBindingStore(this.storageRoot),
      });
      const created = await coordinator.createOrReuseThread({
        workspace_id: request.workspace_id,
        task_id: request.task_id,
        session_id: session.session_id,
        executorThreadId,
        projectId,
        prompt: request.instruction,
      });
      if (!created.created) {
        throw new DesktopExecutionError(
          "execution_not_recoverable",
          'Desktop target for Session "' + session.session_id + '" already existed; refusing to resend.',
        );
      }

      const threadId = created.binding.target_thread_id;
      const hostId = created.binding.host_id;
      session = await this.sessions.updateSession(session.session_id, {
        status: "active",
        thread_id: threadId,
      });
      await this.recordEvent({
        session_id: session.session_id,
        execution_id: request.execution_id,
        thread_id: threadId,
        timestamp: this.now(),
        event_type: "session_started",
        payload: {},
      });

      this.runtimes.set(session.session_id, runtime);
      const sessionId = session.session_id;
      const watch: WatchContext = {
        runtime,
        request,
        sessionId,
        executorThreadId,
        baseline: { targetThreadId: threadId, hostId, turnIds: [] },
        threadId,
        hostId,
      };
      const completion = this.watch(watch, client, contracts).catch(() => undefined);
      this.completions.set(sessionId, completion);
      void completion.finally(() => {
        if (this.completions.get(sessionId) === completion) this.completions.delete(sessionId);
      });

      return {
        execution_id: execution.execution_id,
        started_at: execution.started_at,
        accepted: "new",
        session_id: sessionId,
        thread_id: threadId,
      };
    } catch (error: unknown) {
      if (session !== undefined) this.runtimes.delete(session.session_id);
      await this.failLaunch(request, session, execution, error);
      throw error;
    }
  }

  private async prepare(runtime: DesktopRuntime): Promise<{
    readonly commands: DesktopCodexThreadCommands;
    readonly contracts: ReturnType<typeof createCodexAppToolContracts>;
    readonly client: Pick<CodexAppMcpClient, "callTool">;
  }> {
    const client = runtime.mcpClient;
    if (client === undefined) {
      throw new DesktopExecutionError(
        "tools_contract_incompatible",
        "Desktop codex_app runtime did not expose a tool client.",
      );
    }
    let listed: { readonly tools: readonly { readonly name: string }[] };
    try {
      listed = await runtime.listTools();
    } catch (error: unknown) {
      throw new DesktopExecutionError(
        "tools_contract_incompatible",
        "Desktop codex_app tools/list failed: " + errorMessage(error),
      );
    }
    let contracts: ReturnType<typeof createCodexAppToolContracts>;
    try {
      contracts = createCodexAppToolContracts(listed.tools as never);
      contracts.requireListProjects();
      contracts.createThreadArguments("probe", "probe");
      contracts.readThreadArguments("probe", "probe");
      contracts.waitThreadsArguments("probe", "probe", 1);
    } catch (error: unknown) {
      throw new DesktopExecutionError(
        "tools_contract_incompatible",
        "Desktop codex_app tool contract is incompatible: " + errorMessage(error),
      );
    }
    return {
      commands: new DesktopCodexThreadCommands({ client, contracts }),
      contracts,
      client,
    };
  }

  private async resolveProject(
    commands: DesktopCodexThreadCommands,
    cwd: string,
    executorThreadId: string,
  ): Promise<string> {
    const projects = await commands.listProjects({ executorThreadId, timeoutMs: this.completionTimeoutMs });
    try {
      return resolveDesktopProject(projects, cwd).projectId;
    } catch (error: unknown) {
      if (error instanceof CodexAppRuntimeError) throw error;
      throw new DesktopExecutionError(
        "execution_not_recoverable",
        "Desktop project resolution failed: " + errorMessage(error),
      );
    }
  }

  private async connectRuntime(): Promise<DesktopRuntime> {
    if (this.runtimeFactory === undefined) {
      throw new DesktopExecutionError(
        "desktop_tools_pipe_unavailable",
        "Desktop tools pipe handoff is unavailable.",
      );
    }
    try {
      return await this.runtimeFactory.connect();
    } catch (error: unknown) {
      const code = error instanceof CodexAppRuntimeError
        && error.code === "transport_failed"
        ? "runtime_connect_failed"
        : "desktop_tools_pipe_unavailable";
      throw new DesktopExecutionError(code, "Desktop codex_app runtime is unavailable: " + errorMessage(error));
    }
  }

  private async existing(
    request: ExecutionBackendStartRequest,
    execution: ExecutionContext,
  ): Promise<ExecutionStartResult> {
    if (execution.status !== "running") {
      throw new DesktopExecutionError(
        "execution_not_recoverable",
        'Execution "' + execution.execution_id + '" is already terminal.',
      );
    }
    const session = await this.findSession(request);
    if (session === null || session.thread_id === undefined) {
      throw new DesktopExecutionError(
        "execution_not_recoverable",
        'Execution "' + execution.execution_id + '" has no recoverable Desktop Session.',
      );
    }
    return {
      execution_id: execution.execution_id,
      started_at: execution.started_at,
      accepted: "existing",
      session_id: session.session_id,
      thread_id: session.thread_id,
    };
  }

  private async findSession(request: ExecutionBackendStartRequest): Promise<Session | null> {
    if (request.goal_id === undefined) return null;
    const matches = (await this.sessions.listSessions()).filter((session) =>
      session.goal_id === request.goal_id
      && session.task_id === request.task_id
      && session.backend_type === DESKTOP_EXECUTION_BACKEND_IDENTITY);
    if (matches.length > 1) throw new Error("More than one Desktop Session matches the Goal task.");
    return matches[0] ?? null;
  }

  private async watch(
    watch: WatchContext,
    client: Pick<CodexAppMcpClient, "callTool">,
    contracts: ReturnType<typeof createCodexAppToolContracts>,
  ): Promise<void> {
    try {
      const observer = new DesktopCompletionObserver({
        client,
        contracts,
        ...(this.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.pollIntervalMs }),
      });
      const completion = await observer.waitForCompletion({
        executorThreadId: watch.executorThreadId,
        targetThreadId: watch.threadId,
        hostId: watch.hostId,
        timeoutMs: this.completionTimeoutMs,
        baseline: watch.baseline,
      });
      if (completion.status === "completed") {
        await this.complete(watch, completion);
        return;
      }
      // Only a verifiable observer turn id is carried into failure projection; never synthesize one.
      if (completion.turnId !== undefined) watch.resolvedTurnId = completion.turnId;
      await this.fail(
        watch,
        completion.status === "timed_out"
          ? "Desktop turn timed out."
          : "Desktop turn completion was unverifiable (" + (completion.reason ?? "unknown") + ").",
      );
    } catch (error: unknown) {
      if (this.closing) return;
      await this.fail(watch, "Desktop turn failed: " + errorMessage(error));
    } finally {
      this.runtimes.delete(watch.sessionId);
      await watch.runtime.close().catch(() => undefined);
    }
  }

  private async complete(watch: WatchContext, completion: DesktopCompletionResult): Promise<void> {
    const execution = await this.executions.getExecutionContext(
      watch.request.workspace_id,
      watch.request.task_id,
      watch.request.execution_id,
    );
    if (execution === null || execution.status !== "running") return;
    if (completion.turnId !== undefined) {
      await this.recordEvent({
        session_id: watch.sessionId,
        execution_id: watch.request.execution_id,
        thread_id: watch.threadId,
        timestamp: this.now(),
        event_type: "turn_completed",
        turn_id: completion.turnId,
        payload: {},
      });
    }
    const next = await this.executions.updateExecutionContext(
      watch.request.workspace_id,
      watch.request.task_id,
      watch.request.execution_id,
      { status: "passed", summary: "Desktop turn completed successfully." },
    );
    await this.sessions.updateSession(watch.sessionId, { status: "completed" });
    await this.notifyTerminal(next);
  }

  private async fail(watch: WatchContext, reason: string): Promise<void> {
    const execution = await this.executions.getExecutionContext(
      watch.request.workspace_id,
      watch.request.task_id,
      watch.request.execution_id,
    );
    if (execution === null || execution.status !== "running") return;
    await this.projectFailure(watch.request, watch.sessionId, {
      summary: boundedSummary(reason, "Desktop turn failed."),
      ...(watch.resolvedTurnId === undefined ? {} : { turnId: watch.resolvedTurnId }),
      ...(watch.threadId === undefined ? {} : { threadId: watch.threadId }),
    });
  }

  private async failLaunch(
    request: ExecutionBackendStartRequest,
    session: Session | undefined,
    execution: ExecutionContext | undefined,
    error: unknown,
  ): Promise<void> {
    const current = execution === undefined
      ? null
      : await this.executions.getExecutionContext(
        request.workspace_id,
        request.task_id,
        request.execution_id,
      ).catch(() => null);
    // A launch failure may happen before any Desktop target exists, so there is no honest turn
    // identity to project. Session and Execution are still persisted before the listener runs.
    if (current?.status !== "running" && session === undefined) return;
    await this.projectFailure(request, session?.session_id, {
      summary: boundedSummary(errorMessage(error), "Desktop execution failed."),
      persistEvent: session !== undefined && current?.status === "running",
    });
  }

  /**
   * Persist every honestly expressible terminal state before notifying the listener:
   * Execution terminal, then Session terminal, then the failure event, then the listener.
   * A failure event is only written when a Desktop target thread is already durable, because the
   * event schema requires a thread identity and the backend must never fabricate one.
   */
  private async projectFailure(
    request: ExecutionBackendStartRequest,
    sessionId: string | undefined,
    values: {
      readonly summary: string;
      readonly turnId?: string;
      readonly threadId?: string;
      readonly persistEvent?: boolean;
    },
  ): Promise<void> {
    let next: ExecutionContext | undefined;
    try {
      const current = await this.executions.getExecutionContext(
        request.workspace_id,
        request.task_id,
        request.execution_id,
      );
      if (current !== null && current.status === "running") {
        next = await this.executions.updateExecutionContext(
          request.workspace_id,
          request.task_id,
          request.execution_id,
          { status: "failed", summary: values.summary },
        );
      } else if (current !== null) {
        next = current;
      }
    } catch (error: unknown) {
      console.warn("Desktop execution failure could not be persisted", errorMessage(error));
    }

    if (sessionId !== undefined) {
      await this.sessions.updateSession(sessionId, { status: "failed" }).catch((error: unknown) => {
        console.warn("Desktop Session failure could not be persisted", errorMessage(error));
      });
    }

    if (values.persistEvent !== false && values.threadId !== undefined && sessionId !== undefined) {
      try {
        await this.recordEvent({
          session_id: sessionId,
          execution_id: request.execution_id,
          thread_id: values.threadId,
          timestamp: this.now(),
          event_type: "execution_failed",
          ...(values.turnId === undefined ? {} : { turn_id: values.turnId }),
          payload: { reason: values.summary },
        });
      } catch (error: unknown) {
        console.warn("Desktop execution failure event could not be persisted", errorMessage(error));
      }
    }

    if (next !== undefined) await this.notifyTerminal(next);
  }

  private async notifyTerminal(execution: ExecutionContext): Promise<void> {
    try {
      await this.terminalListener?.(execution);
    } catch (error: unknown) {
      console.warn("Desktop execution terminal notification failed", errorMessage(error));
    }
  }

  private async recordEvent(event: LrmEvent): Promise<void> {
    await this.events.appendEvent(event);
  }
}
