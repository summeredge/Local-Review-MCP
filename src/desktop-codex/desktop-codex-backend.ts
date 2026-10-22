import { sessionForExecution, syncTerminalSession } from "../context/session-execution.js";
import { ExecutionLaunchIndeterminateError } from "../control-plane/execution-service.js";
import { AutoIterationStore } from "../control-plane/auto-iteration.js";
﻿import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import type { DesktopThreadBinding } from "./desktop-thread-binding.js";
import { DesktopThreadCoordinator } from "./desktop-thread-coordinator.js";
import { DesktopCodexThreadCommands } from "./thread-commands.js";
import { openDesktopThread } from "./desktop-thread-activator.js";
import { z } from "zod";
import { workspaceIdSchema, taskIdSchema, executionIdSchema, sessionIdSchema } from "../context/schema.js";

export const desktopExecutionActionSchema = z.object({
  workspace_id: workspaceIdSchema, task_id: taskIdSchema, execution_id: executionIdSchema,
  session_id: sessionIdSchema.optional(), thread_id: z.string().min(1).max(256).optional(),
  turn_id: z.string().min(1).max(256).optional(),
  action: z.enum(["check", "close"]),
  outcome: z.enum(["completed", "incomplete", "unknown"]).optional(),
  note: z.string().max(1000).optional(), confirmed: z.literal(true).optional(),
}).strict().refine(input => input.action !== "close" || (input.confirmed === true && input.outcome !== undefined),
  "人工结案需要处理结果及明确确认。");
export type DesktopExecutionAction = z.infer<typeof desktopExecutionActionSchema>;

/** Stable, honest command label. Desktop executions never claim an app-server command. */
export const DESKTOP_EXECUTION_COMMAND = "desktop codex_app";
export const DESKTOP_EXECUTION_BACKEND_IDENTITY = "desktop_codex_app" as const;

const SUMMARY_MAX_LENGTH = 4_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000;

export type DesktopExecutionErrorCode =
  | "desktop_backend_closed"
  | "desktop_execution_mode_required"
  | "desktop_goal_required"
  | "desktop_disconnected"
  | "executor_identity_unavailable"
  | "turn_identity_unavailable"
  | "session_identity_unavailable"
  | "event_store_unavailable"
  | "desktop_tools_pipe_unavailable"
  | "runtime_connect_failed"
  | "tools_contract_incompatible"
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
  readonly eventStore?: Pick<EventStore, "appendEvent" | "listEvents">;
  readonly runtimeFactory?: DesktopCodexRuntimeProvider;
  readonly desktopState?: () => DesktopSyncState;
  readonly completionTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => string;
  readonly openDesktopThread?: (url: string) => Promise<void>;
}

interface DesktopRuntime {
  listTools(): Promise<{ readonly tools: readonly { readonly name: string }[] }>;
  readonly mcpClient?: Pick<CodexAppMcpClient, "callTool">;
  close(): Promise<void>;
}

interface WatchContext {
  runtime: DesktopRuntime;
  readonly request: Pick<ExecutionBackendStartRequest, "workspace_id" | "task_id" | "execution_id">;
  readonly sessionId: string;
  readonly executorThreadId: string;
  readonly baseline: DesktopCompletionBaseline;
  readonly threadId: string;
  readonly hostId: string;
  signal: AbortSignal;
  /** Set once the observer has produced a verifiable turn id for this Execution. */
  resolvedTurnId?: string;
  lastSuccessfulRead?: string;
  failureSince?: number;
  errorCode?: string;
  reconnectAttempts?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

function boundedSummary(value: string | undefined, fallback: string): string {
  const summary = value?.trim().slice(0, SUMMARY_MAX_LENGTH) ?? "";
  return summary === "" ? fallback : summary;
}

function requestKey(request: Pick<ExecutionBackendStartRequest, "workspace_id" | "task_id" | "execution_id">): string {
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
  private readonly events: Pick<EventStore, "appendEvent" | "listEvents">;
  private readonly runtimeFactory: DesktopCodexRuntimeProvider | undefined;
  private readonly desktopState: (() => DesktopSyncState) | undefined;
  private readonly completionTimeoutMs: number;
  private readonly pollIntervalMs: number | undefined;
  private readonly now: () => string;
  private readonly openThread: (url: string) => Promise<void>;
  private readonly inFlight = new Map<string, Promise<ExecutionStartResult>>();
  private readonly runtimes = new Map<string, DesktopRuntime>();
  private readonly watchAbortControllers = new Map<string, AbortController>();
  private readonly completions = new Map<string, Promise<void>>();
  // The captured identity is also durable in the binding; never substitute the foreground.
  private readonly watches = new Map<string, WatchContext>();
  private readonly notified = new Set<string>();
  private readonly terminalFlights = new Map<string, Promise<unknown>>();
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
    this.completionTimeoutMs = options.completionTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs;
    this.now = options.now ?? (() => new Date().toISOString());
    this.openThread = options.openDesktopThread ?? openDesktopThread;
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

  private serial<T>(request: Pick<ExecutionBackendStartRequest, "workspace_id" | "task_id" | "execution_id">,
    action: () => Promise<T>): Promise<T> {
    const key = requestKey(request);
    const next = (this.terminalFlights.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.terminalFlights.set(key, next);
    void next.finally(() => {
      if (this.terminalFlights.get(key) === next) this.terminalFlights.delete(key);
    }).catch(() => undefined);
    return next;
  }

  public async executionAction(input: DesktopExecutionAction): Promise<{ execution: ExecutionContext; reason?: string }> {
    const request = desktopExecutionActionSchema.parse(input);
    const execution = await this.executions.getExecutionContext(request.workspace_id, request.task_id, request.execution_id);
    if (execution === null || execution.command !== DESKTOP_EXECUTION_COMMAND) {
      throw new DesktopExecutionError("execution_not_recoverable", "所选记录不是可处理的 Desktop Execution。");
    }
    const executions = await this.executions.listExecutions(request.workspace_id, request.task_id);
    let evidenceError: string | undefined;
    const candidates = (await this.sessions.listSessions()).filter(candidate =>
      candidate.task_id === request.task_id && candidate.backend_type === DESKTOP_EXECUTION_BACKEND_IDENTITY
      && candidate.workspace === this.registry.resolve(request.workspace_id).manager.canonicalRoot);
    const session = await sessionForExecution(candidates, execution,
      executions.filter(candidate => candidate.command === DESKTOP_EXECUTION_COMMAND), this.events)
      .catch(() => { evidenceError = "event_store_unavailable"; return undefined; });
    const turns = session === undefined ? [] : [...new Set((await this.events.listEvents(session.session_id)
      .catch(() => { evidenceError = "event_store_unavailable"; return []; }))
      .filter(event => event.execution_id === request.execution_id && event.thread_id === session.thread_id)
      .flatMap(event => "turn_id" in event && event.turn_id !== undefined ? [event.turn_id] : []))];
    const turnId = turns.length === 1 ? turns[0] : undefined;
    if (request.session_id !== session?.session_id || request.thread_id !== session?.thread_id
      || (evidenceError === undefined && request.turn_id !== turnId)) {
      throw new DesktopExecutionError("desktop_target_conflict", "执行身份已变化，请刷新后重新选择。");
    }
    if (request.action === "close") return this.serial(request, async () => {
      if (session === undefined && candidates.some(candidate => candidate.execution_id === undefined
        || candidate.execution_id === request.execution_id)) {
        throw new DesktopExecutionError("desktop_target_conflict", "Session 关联无法唯一验证，不能结案；请核实关联身份。");
      }
      if (this.inFlight.has(requestKey(request))) {
        throw new DesktopExecutionError("desktop_target_conflict", "执行尚在启动，请等待启动结果后再结案。");
      }
      const current = (await this.executions.getExecutionContext(request.workspace_id, request.task_id, request.execution_id))!;
      if (current.status !== "running") {
        await syncTerminalSession(this.sessions, session?.session_id, current);
        if (current.manual_resolution !== undefined) await this.tasks.updateTaskContext(request.task_id, { status: "human_required" });
        await this.notifyTerminal(current);
        return { execution: current, reason: "already_terminal" };
      }
      const next = await this.executions.updateExecutionContext(request.workspace_id, request.task_id, request.execution_id, {
        status: "terminated", summary: "人工结案，需人工处理；未取得 provider 成功证明。",
        manual_resolution: { outcome: request.outcome!, note: request.note ?? "", resolved_at: this.now(),
          ...(session === undefined ? {} : { session_id: session.session_id }),
          ...(session?.thread_id === undefined ? {} : { thread_id: session.thread_id }),
          ...(turnId === undefined ? {} : { turn_id: turnId }),
          ...(current.summary === undefined ? {} : { monitoring_summary: current.summary }),
          ...(evidenceError === undefined ? {} : { evidence_error: evidenceError }) },
      });
      if (session !== undefined) this.watchAbortControllers.get(session.session_id)?.abort();
      await syncTerminalSession(this.sessions, session?.session_id, next);
      await this.tasks.updateTaskContext(request.task_id, { status: "human_required" });
      await this.notifyTerminal(next);
      return { execution: next };
    });
    if (execution.status !== "running") return this.serial(request, async () => {
      await syncTerminalSession(this.sessions, session?.session_id, execution);
      await this.notifyTerminal(execution);
      return { execution, reason: "already_terminal" };
    });
    let runtime: DesktopRuntime | undefined;
    try {
      if (evidenceError !== undefined) throw new DesktopExecutionError("event_store_unavailable", "事件证据无法读取，需人工核实。");
      if (session === undefined) throw new DesktopExecutionError("session_identity_unavailable", "关联 Session 身份不可用。");
      const binding = await new DesktopThreadBindingStore(this.storageRoot).load(request.workspace_id, session.session_id);
      if (this.watches.get(session.session_id)?.executorThreadId === undefined && binding?.executor_thread_id === undefined) {
        throw new DesktopExecutionError("executor_identity_unavailable", "原执行者身份未持久化，需人工核实。");
      }
      runtime = await this.connectRuntime();
      const prepared = await this.prepare(runtime, true);
      const watch = await this.restoreWatch(request, session, runtime, new AbortController().signal);
      const completion = await this.observer(watch, prepared.client, prepared.contracts).checkCompletion({
        executorThreadId: watch.executorThreadId, targetThreadId: watch.threadId, hostId: watch.hostId,
        turnId: watch.resolvedTurnId!, timeoutMs: this.completionTimeoutMs,
      });
      if (completion.status === "completed") await this.complete(watch, completion);
      else if (completion.status === "failed") await this.fail(watch, "Desktop turn failed.");
      else await this.monitoringDiagnostic(request, session.session_id,
        completion.status === "running" ? "observing" : "manual_confirmation_required", completion.reason ?? completion.status, watch);
      if (completion.status === "running") await this.resumeObservation(request, session);
      return { execution: (await this.executions.getExecutionContext(request.workspace_id, request.task_id, request.execution_id))!,
        ...(completion.reason === undefined ? {} : { reason: completion.reason }) };
    } catch (error: unknown) {
      const reason = error instanceof DesktopExecutionError ? error.code : errorMessage(error);
      await this.monitoringDiagnostic(request, session?.session_id, "manual_confirmation_required", reason);
      return { execution: (await this.executions.getExecutionContext(request.workspace_id, request.task_id, request.execution_id))!, reason };
    } finally {
      await runtime?.close().catch(() => undefined);
    }
  }

  private async restoreWatch(
    request: Pick<ExecutionBackendStartRequest, "workspace_id" | "task_id" | "execution_id">,
    session: Session, runtime: DesktopRuntime, signal: AbortSignal,
  ): Promise<WatchContext> {
    const existing = this.watches.get(session.session_id);
    const binding = await new DesktopThreadBindingStore(this.storageRoot).load(request.workspace_id, session.session_id);
    if (binding === undefined) throw new DesktopExecutionError("execution_not_recoverable", "binding_identity_unavailable");
    await this.requireBinding(request, session.session_id, binding.target_thread_id, binding.host_id);
    const executorThreadId = existing?.executorThreadId ?? binding.executor_thread_id;
    if (executorThreadId === undefined || (existing !== undefined && (requestKey(existing.request) !== requestKey(request)
      || (binding.executor_thread_id !== undefined && binding.executor_thread_id !== existing.executorThreadId)))) {
      throw new DesktopExecutionError("executor_identity_unavailable", "原执行者身份未持久化，需人工核实。");
    }
    const turns = [...new Set((await this.events.listEvents(session.session_id))
      .filter(event => event.execution_id === request.execution_id && event.thread_id === binding.target_thread_id)
      .flatMap(event => "turn_id" in event && event.turn_id !== undefined ? [event.turn_id] : []))];
    const resolvedTurnId = existing?.resolvedTurnId ?? (turns.length === 1 ? turns[0] : undefined);
    if (resolvedTurnId === undefined) throw new DesktopExecutionError("turn_identity_unavailable", "原 Turn 身份不可用。");
    return { runtime, signal, sessionId: session.session_id, executorThreadId, resolvedTurnId,
      request,
      threadId: binding.target_thread_id, hostId: binding.host_id,
      baseline: { targetThreadId: binding.target_thread_id, hostId: binding.host_id, turnIds: [] } };
  }

  /**
   * Test/shutdown seam: resolves once every in-flight Desktop execution has finished projecting its
   * terminal Session and Execution state. It never starts work.
   */
  public whenIdle(): Promise<void> {
    return Promise.all([...this.completions.values()]).then(() => undefined);
  }

  /** Startup reconciliation never resends a task whose completion observer belonged to an old Host. */
  public async reconcileOrphanedExecutions(): Promise<void> {
    const sessions = await this.sessions.listSessions();
    for (const task of await this.tasks.listTaskContexts()) {
      let cwd: string;
      try { cwd = this.registry.resolve(task.workspace_id).manager.canonicalRoot; }
      catch { continue; }
      const executions = await this.executions.listExecutions(task.workspace_id, task.task_id);
      for (const execution of executions) {
        if (execution.command !== DESKTOP_EXECUTION_COMMAND) continue;
        const associated = await sessionForExecution(sessions.filter(session => session.task_id === task.task_id
          && session.backend_type === DESKTOP_EXECUTION_BACKEND_IDENTITY && session.workspace === cwd),
          execution, executions.filter(candidate => candidate.command === DESKTOP_EXECUTION_COMMAND), this.events);
        if (execution.status !== "running") {
          await syncTerminalSession(this.sessions, associated?.session_id, execution);
          if (execution.manual_resolution !== undefined) await this.tasks.updateTaskContext(task.task_id, { status: "human_required" });
          await this.notifyTerminal(execution);
          continue;
        }
        const identity = { workspace_id: task.workspace_id, task_id: task.task_id, execution_id: execution.execution_id };
        if (this.inFlight.has(requestKey(identity))) continue;
        if (associated === undefined) {
          await this.monitoringDiagnostic(identity, undefined, "manual_confirmation_required", "session_identity_unavailable");
          continue;
        }
        const session = associated;
        if (this.completions.has(session.session_id)) continue;
        await this.resumeObservation(identity, session);
      }
    }
  }

  public async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.watchAbortControllers.values()) controller.abort();
    const completions = [...this.completions.values()];
    const runtimes = [...this.runtimes.entries()];
    this.runtimes.clear();
    await Promise.all(runtimes.map(([sessionId, runtime]) =>
      this.watchAbortControllers.has(sessionId)
        ? Promise.resolve()
        : runtime.close().catch(() => undefined)));
    await Promise.all(completions);
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

    const loops = (await new AutoIterationStore(this.storageRoot).list()).filter(loop =>
      loop.workspace_id === request.workspace_id && loop.task_id === request.task_id
      && loop.execution_id === request.execution_id);
    if (loops.length > 1) throw new DesktopExecutionError("desktop_target_conflict", "Desktop iteration identity is ambiguous.");
    const initialExecutionId = loops[0]?.initial_execution_id;
    let originalBinding: DesktopThreadBinding | undefined;
    if (initialExecutionId !== undefined && initialExecutionId !== request.execution_id) {
      const initial = await this.executions.getExecutionContext(request.workspace_id, request.task_id, initialExecutionId);
      const original = await this.findSession({ ...request, execution_id: initialExecutionId });
      if (initial?.command !== DESKTOP_EXECUTION_COMMAND || initial.status !== "passed"
        || original === null || original.thread_id === undefined) {
        throw new DesktopExecutionError("execution_not_recoverable", "Initial Desktop execution cannot authorize continuation.");
      }
      originalBinding = await new DesktopThreadBindingStore(this.storageRoot).load(request.workspace_id, original.session_id);
      if (originalBinding === undefined) throw new DesktopExecutionError("execution_not_recoverable", "Initial Desktop binding is unavailable.");
      await this.requireBinding({ ...request, execution_id: initialExecutionId }, original.session_id,
        originalBinding.target_thread_id, originalBinding.host_id);
    }

    // A prior start opens its target in Desktop, so continuation must reuse the saved executor.
    const executorThreadId = originalBinding?.executor_thread_id ?? this.executorIdentity();

    const runtime = await this.connectRuntime().catch((error: unknown) => {
      if (error instanceof Error) error.message = `Desktop stage=backend_connection: ${error.message}`;
      throw error;
    });
    let session: Session | undefined;
    let execution: ExecutionContext | undefined;
    // Runtime ownership starts here and moves to the completion watch exactly once. Until the
    // transfer happens, this frame is responsible for closing the runtime on every exit path.
    let runtimeOwnedByWatch = false;
    let turnDispatched = false;
    let stage = "tools/list";
    try {
      const { commands, contracts, client } = await this.prepare(runtime);
      // Every codex_app tools/call in this Execution must use the executor captured above, so the
      // value is threaded through instead of being re-read from the current Desktop foreground.
      stage = "project_resolution";
      const projectId = originalBinding === undefined
        ? await this.resolveProject(commands, cwd, executorThreadId) : undefined;

      stage = "session_persistence";
      session = await this.sessions.createSession({
        execution_id: request.execution_id,
        goal_id: request.goal_id!,
        task_id: request.task_id,
        backend_type: DESKTOP_EXECUTION_BACKEND_IDENTITY,
        status: "created",
        workspace: cwd,
        ...(request.model_id === undefined ? {} : { model_id: request.model_id }),
        ...(request.reasoning_effort === undefined ? {} : { reasoning_effort: request.reasoning_effort }),
      });
      session = await this.sessions.updateSession(session.session_id, { status: "starting" });
      stage = "execution_persistence";
      execution = await this.executions.createExecutionContext({
        execution_id: request.execution_id,
        task_id: request.task_id,
        workspace_id: request.workspace_id,
        status: "running",
        command: DESKTOP_EXECUTION_COMMAND,
      });

      const bindings = new DesktopThreadBindingStore(this.storageRoot);
      const coordinator = new DesktopThreadCoordinator({
        commands,
        bindings,
      });
      let baseline: DesktopCompletionBaseline;
      let binding;
      if (originalBinding !== undefined) {
        const original = originalBinding;
        stage = "continuation_baseline";
        baseline = await new DesktopCompletionObserver({ client, contracts }).captureBaseline({
          executorThreadId, targetThreadId: originalBinding.target_thread_id,
          hostId: originalBinding.host_id, timeoutMs: this.completionTimeoutMs,
        });
        const completedTurns = (await this.events.listEvents(original.session_id)).filter(event =>
          event.execution_id === initialExecutionId && event.thread_id === original.target_thread_id
          && event.event_type === "turn_completed");
        if (completedTurns.length !== 1 || !("turn_id" in completedTurns[0]!)
          || completedTurns[0]!.turn_id === undefined) {
          throw new DesktopExecutionError("turn_identity_unavailable", "Initial completed Turn has no durable identity.");
        }
        stage = "thread_binding_persistence";
        binding = await bindings.createIfAbsent({ ...originalBinding, session_id: session.session_id,
          executor_thread_id: executorThreadId, created_at: this.now(), updated_at: this.now() });
        session = await this.sessions.updateSession(session.session_id, { thread_id: binding.target_thread_id });
        stage = "send_message_to_thread";
        await coordinator.sendToBoundThread({ workspace_id: request.workspace_id, task_id: request.task_id,
          session_id: session.session_id, executorThreadId, prompt: request.instruction });
      } else {
        stage = "create_thread";
        const created = await coordinator.createOrReuseThread({
          workspace_id: request.workspace_id,
          task_id: request.task_id,
          session_id: session.session_id,
          executorThreadId,
          projectId: projectId!,
          prompt: request.instruction,
          ...(request.model_id === undefined ? {} : { model_id: request.model_id }),
          ...(request.reasoning_effort === undefined ? {} : { reasoning_effort: request.reasoning_effort }),
        });
        if (!created.created) {
          throw new DesktopExecutionError(
            "execution_not_recoverable",
            'Desktop target for Session "' + session.session_id + '" already existed; refusing to resend.',
          );
        }
        binding = created.binding;
        baseline = { targetThreadId: binding.target_thread_id, hostId: binding.host_id, turnIds: [] };
      }

      turnDispatched = true;
      const threadId = binding.target_thread_id;
      const hostId = binding.host_id;
      const abortController = new AbortController();
      stage = "session_persistence";
      session = await this.sessions.updateSession(session.session_id, {
        status: "active",
        thread_id: threadId,
      });
      // The turn is already dispatched. Navigation is only a UI hint and must
      // not prevent observation or incorrectly fail an execution that is still running.
      try {
        await this.openThread(`codex://threads/${encodeURIComponent(threadId)}`);
      } catch (error: unknown) {
        console.warn("Desktop thread activation failed; completion observation will continue", errorMessage(error));
      }
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
        baseline,
        threadId,
        hostId,
        signal: abortController.signal,
      };
      this.watchAbortControllers.set(sessionId, abortController);
      this.watches.set(sessionId, watch);
      const completion = this.watch(watch, client, contracts).catch(() => undefined);
      this.completions.set(sessionId, completion);
      void completion.finally(() => {
        if (this.completions.get(sessionId) === completion) this.completions.delete(sessionId);
      });

      // The watch owns the runtime from here on; its own finally releases it exactly once.
      runtimeOwnedByWatch = true;

      return {
        execution_id: execution.execution_id,
        started_at: execution.started_at,
        accepted: "new",
        session_id: sessionId,
        thread_id: threadId,
      };
    } catch (error: unknown) {
      if (error instanceof Error && !error.message.startsWith("Desktop stage=")) {
        error.message = `Desktop stage=${stage} model=${request.model_id ?? "default"} reasoning_effort=${request.reasoning_effort ?? "default"}: ${error.message}`;
      }
      if (session !== undefined) this.runtimes.delete(session.session_id);
      if (turnDispatched || error instanceof ExecutionLaunchIndeterminateError
        || (["create_thread", "send_message_to_thread"].includes(stage) && error instanceof CodexAppRuntimeError
          && (["tool_call_timeout", "tool_call_aborted", "transport_failed", "thread_identity_missing"].includes(error.code)
            || (error.code === "tool_call_failed" && error.cause instanceof Error)))) {
        throw new ExecutionLaunchIndeterminateError(errorMessage(error), { cause: error });
      }
      await this.failLaunch(request, session, execution, error);
      throw error;
    } finally {
      // Preflight/launch failures must not leak a successfully connected runtime. The success path
      // already handed ownership to the completion watch, so this closes nothing in that case.
      if (!runtimeOwnedByWatch) {
        await runtime.close().catch(() => undefined);
      }
    }
  }

  private async prepare(runtime: DesktopRuntime, observationOnly = false): Promise<{
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
      contracts.readThreadArguments("probe", "probe");
      if (!observationOnly) {
        contracts.requireListProjects();
        contracts.createThreadArguments("probe", "probe");
        contracts.waitThreadsArguments("probe", "probe", 1);
      }
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
    if (!this.completions.has(session.session_id)) {
      await this.resumeObservation(request, session);
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
    const executions = await this.executions.listExecutions(request.workspace_id, request.task_id);
    const execution = executions.find(candidate => candidate.execution_id === request.execution_id);
    return execution === undefined ? null : await sessionForExecution(matches, execution, executions, this.events) ?? null;
  }

  private async requireBinding(
    request: Pick<ExecutionBackendStartRequest, "workspace_id" | "task_id" | "execution_id">,
    sessionId: string, threadId: string, hostId: string,
  ): Promise<void> {
    const binding = await new DesktopThreadBindingStore(this.storageRoot).load(request.workspace_id, sessionId);
    const session = await this.sessions.getSession(sessionId);
    if (binding === undefined || binding.task_id !== request.task_id || binding.target_thread_id !== threadId
      || binding.host_id !== hostId || session?.thread_id !== threadId || session.task_id !== request.task_id
      || session.execution_id !== request.execution_id || session.backend_type !== DESKTOP_EXECUTION_BACKEND_IDENTITY
      || session.workspace !== this.registry.resolve(request.workspace_id).manager.canonicalRoot) {
      throw new DesktopExecutionError("execution_not_recoverable", "Desktop binding identity cannot be verified.");
    }
  }

  private async resumeObservation(
    request: Pick<ExecutionBackendStartRequest, "workspace_id" | "task_id" | "execution_id">, session: Session,
  ): Promise<void> {
    if (this.closing || this.completions.has(session.session_id)) return;
    let watch = this.watches.get(session.session_id);
    // Only the original captured or durable executor may authorize observation after restart.
    const binding = await new DesktopThreadBindingStore(this.storageRoot).load(request.workspace_id, session.session_id).catch(() => undefined);
    if (this.closing || this.completions.has(session.session_id)) return;
    if ((watch === undefined && binding?.executor_thread_id === undefined)
      || (watch !== undefined && requestKey(watch.request) !== requestKey(request))) {
      await this.monitoringDiagnostic(request, session.session_id, "manual_confirmation_required", "executor_identity_unavailable");
      return;
    }
    let observation: Promise<void> | undefined;
    const setup = (async () => {
      let runtime: DesktopRuntime | undefined;
      try {
        runtime = await this.connectRuntime();
        const controller = new AbortController();
        watch = await this.restoreWatch(request, session, runtime, controller.signal);
        const prepared = await this.prepare(runtime, true);
        const current = await this.executions.getExecutionContext(request.workspace_id, request.task_id, request.execution_id);
        if (this.closing || current?.status !== "running") { await runtime.close(); return; }
        watch.reconnectAttempts = 1;
        this.runtimes.set(session.session_id, runtime);
        this.watchAbortControllers.set(session.session_id, controller);
        this.watches.set(session.session_id, watch);
        observation = this.watch(watch, prepared.client, prepared.contracts).catch(() => undefined);
      } catch (error: unknown) {
        await runtime?.close().catch(() => undefined);
        await this.monitoringDiagnostic(request, session.session_id, "manual_confirmation_required",
          error instanceof DesktopExecutionError ? error.code : "binding_or_runtime_unavailable", watch);
      }
    })();
    // Reserve the existing completion slot during connection setup so startup and existing()
    // cannot both create an observer for the same Execution.
    const completion = setup.then(() => observation);
    this.completions.set(session.session_id, completion);
    void completion.finally(() => {
      if (this.completions.get(session.session_id) === completion) this.completions.delete(session.session_id);
    });
    await setup;
  }

  private async monitoringDiagnostic(
    request: Pick<ExecutionBackendStartRequest, "workspace_id" | "task_id" | "execution_id">,
    sessionId: string | undefined, state: string, code: string, watch?: WatchContext,
  ): Promise<void> {
    return this.serial(request, () => this.persistMonitoringDiagnostic(request, sessionId, state, code, watch));
  }

  private async persistMonitoringDiagnostic(
    request: Pick<ExecutionBackendStartRequest, "workspace_id" | "task_id" | "execution_id">,
    sessionId: string | undefined, state: string, code: string, watch?: WatchContext,
  ): Promise<void> {
    const session = sessionId === undefined ? null : await this.sessions.getSession(sessionId).catch(() => null);
    const binding = sessionId === undefined ? undefined
      : await new DesktopThreadBindingStore(this.storageRoot).load(request.workspace_id, sessionId).catch(() => undefined);
    const summary = JSON.stringify({ monitor: state, phase: "completion_observation", error_type: code,
      session_id: sessionId, execution_id: request.execution_id, target_thread_id: watch?.threadId ?? session?.thread_id,
      host_id: watch?.hostId ?? binding?.host_id, last_successful_read_at: watch?.lastSuccessfulRead ?? null,
      continuous_failure_ms: watch?.failureSince === undefined ? 0 : Date.now() - watch.failureSince,
      reconnect_attempts: watch?.reconnectAttempts ?? 0 });
    try {
      const current = await this.executions.getExecutionContext(request.workspace_id, request.task_id, request.execution_id);
      if (current?.status !== "running" || current.summary === summary) return;
      await this.executions.updateExecutionContext(request.workspace_id, request.task_id, request.execution_id, { summary });
      console.warn("Desktop completion monitor", summary);
    } catch {
      console.warn("Desktop completion monitor diagnostic could not be persisted", request.execution_id, state, code);
    }
  }

  private observer(watch: WatchContext, client: Pick<CodexAppMcpClient, "callTool">,
    contracts: ReturnType<typeof createCodexAppToolContracts>): DesktopCompletionObserver {
    return new DesktopCompletionObserver({ client, contracts, readFailureTimeoutMs: this.completionTimeoutMs,
      onTurnStarted: (turnId) => this.recordTurnStarted(watch, turnId),
      onSuccessfulRead: async () => {
        const recovered = (watch.reconnectAttempts ?? 0) > 0;
        watch.lastSuccessfulRead = this.now();
        if (recovered) await this.monitoringDiagnostic(watch.request, watch.sessionId, "recovered", "none", watch);
        watch.failureSince = undefined;
        watch.reconnectAttempts = 0;
      },
      onReadFailure: (code) => { watch.failureSince ??= Date.now(); watch.errorCode = code; },
      ...(this.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.pollIntervalMs }),
    });
  }

  private async watch(
    watch: WatchContext,
    client: Pick<CodexAppMcpClient, "callTool">,
    contracts: ReturnType<typeof createCodexAppToolContracts>,
  ): Promise<void> {
    let runtimeOpen = true;
    try {
      let observer = this.observer(watch, client, contracts);
      while (!this.closing) {
        const completion = await observer.waitForCompletion({
          executorThreadId: watch.executorThreadId,
          targetThreadId: watch.threadId,
          hostId: watch.hostId,
          signal: watch.signal,
          baseline: watch.baseline,
          ...(watch.resolvedTurnId === undefined ? {} : { turnId: watch.resolvedTurnId }),
        });
        if (completion.status === "completed") {
          await this.complete(watch, completion);
          return;
        }
        if (completion.status === "failed" && completion.turnId !== undefined) {
          await this.recordTurnStarted(watch, completion.turnId);
          await this.fail(watch, "Desktop turn failed.");
          return;
        }
        const reason = completion.reason ?? completion.status;
        if (!["capability_unavailable", "tool_error", "first_turn_visibility_unavailable", "timed_out"].includes(reason)) {
          await this.monitoringDiagnostic(watch.request, watch.sessionId, "manual_confirmation_required", reason, watch);
          return;
        }
        watch.failureSince ??= Date.now();
        if (Date.now() - watch.failureSince < this.completionTimeoutMs) {
          await delay(Math.min(250, this.completionTimeoutMs), undefined, { signal: watch.signal });
          continue;
        }
        if ((watch.reconnectAttempts ?? 0) >= 3) {
          await this.monitoringDiagnostic(watch.request, watch.sessionId, "unavailable", watch.errorCode ?? reason, watch);
          return;
        }
        // Retry connection/contract validation with bounded backoff; never dispatch the Goal again.
        let connected = false;
        while (!connected && (watch.reconnectAttempts ?? 0) < 3) {
          watch.reconnectAttempts = (watch.reconnectAttempts ?? 0) + 1;
          await this.monitoringDiagnostic(watch.request, watch.sessionId, "reconnecting", watch.errorCode ?? reason, watch);
          await delay(Math.min(30_000, Math.min(1_000, this.completionTimeoutMs) * 2 ** (watch.reconnectAttempts - 1)),
            undefined, { signal: watch.signal });
          if (runtimeOpen) { await watch.runtime.close().catch(() => undefined); runtimeOpen = false; }
          let replacement: DesktopRuntime | undefined;
          try {
            await this.requireBinding(watch.request, watch.sessionId, watch.threadId, watch.hostId);
            replacement = await this.connectRuntime();
            const prepared = await this.prepare(replacement, true);
            if (watch.signal.aborted) throw new Error("observer_stopped");
            const replacementObserver = this.observer(watch, prepared.client, prepared.contracts);
            watch.runtime = replacement;
            runtimeOpen = true;
            this.runtimes.set(watch.sessionId, replacement);
            observer = replacementObserver;
            connected = true;
          } catch (error: unknown) {
            await replacement?.close().catch(() => undefined);
            watch.errorCode = error instanceof DesktopExecutionError ? error.code : "reconnect_failed";
          }
        }
        if (!connected) {
          await this.monitoringDiagnostic(watch.request, watch.sessionId, "unavailable", watch.errorCode ?? reason, watch);
          return;
        }
      }
      await this.monitoringDiagnostic(watch.request, watch.sessionId, "stopped", "runtime_closed", watch);
    } catch (error: unknown) {
      await this.monitoringDiagnostic(watch.request, watch.sessionId,
        watch.signal.aborted ? "stopped" : "unavailable",
        watch.signal.aborted ? "runtime_closed" : error instanceof Error ? error.name : "observer_error", watch);
    } finally {
      this.watchAbortControllers.delete(watch.sessionId);
      this.runtimes.delete(watch.sessionId);
      if (runtimeOpen) await watch.runtime.close().catch(() => undefined);
      const execution = await this.executions.getExecutionContext(watch.request.workspace_id,
        watch.request.task_id, watch.request.execution_id).catch(() => null);
      if (execution !== null && execution.status !== "running") this.watches.delete(watch.sessionId);
    }
  }

  private async complete(watch: WatchContext, completion: DesktopCompletionResult): Promise<void> {
    return this.serial(watch.request, () => this.completeOnce(watch, completion));
  }

  private async completeOnce(watch: WatchContext, completion: DesktopCompletionResult): Promise<void> {
    const execution = await this.executions.getExecutionContext(
      watch.request.workspace_id,
      watch.request.task_id,
      watch.request.execution_id,
    );
    if (execution === null) return;
    if (execution.status !== "running") {
      await syncTerminalSession(this.sessions, watch.sessionId, execution);
      await this.notifyTerminal(execution);
      return;
    }
    if (completion.turnId !== undefined) {
      await this.recordTurnStarted(watch, completion.turnId);
      for (const message of completion.agentMessages ?? []) {
        for (let offset = 0; offset < message.text.length; offset += 4_000) {
          const content = message.text.slice(offset, offset + 4_000);
          await this.recordEvent({
            session_id: watch.sessionId, execution_id: watch.request.execution_id,
            thread_id: watch.threadId, timestamp: this.now(),
            event_type: offset + content.length < message.text.length
              ? "agent_message_delta"
              : "agent_message_completed",
            turn_id: completion.turnId, item_id: message.id,
            payload: { content },
          });
        }
      }
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
    await syncTerminalSession(this.sessions, watch.sessionId, next);
    await this.notifyTerminal(next);
  }

  private async recordTurnStarted(watch: WatchContext, turnId: string): Promise<void> {
    if (watch.resolvedTurnId === turnId) return;
    await this.recordEvent({ session_id: watch.sessionId, execution_id: watch.request.execution_id,
      thread_id: watch.threadId, timestamp: this.now(), event_type: "turn_started", turn_id: turnId, payload: {} });
    watch.resolvedTurnId = turnId;
  }

  private async fail(watch: WatchContext, reason: string): Promise<void> {
    return this.serial(watch.request, () => this.failOnce(watch, reason));
  }

  private async failOnce(watch: WatchContext, reason: string): Promise<void> {
    const execution = await this.executions.getExecutionContext(
      watch.request.workspace_id,
      watch.request.task_id,
      watch.request.execution_id,
    );
    if (execution === null) return;
    if (execution.status !== "running") {
      await syncTerminalSession(this.sessions, watch.sessionId, execution);
      await this.notifyTerminal(execution);
      return;
    }
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
      ...(session?.thread_id === undefined ? {} : { threadId: session.thread_id }),
    });
  }

  /**
   * Persist every honestly expressible terminal state before notifying the listener:
   * Execution terminal, then Session terminal, then the failure event, then the listener.
   * A failure event is only written when a Desktop target thread is already durable, because the
   * event schema requires a thread identity and the backend must never fabricate one.
   */
  private async projectFailure(
    request: Pick<ExecutionBackendStartRequest, "workspace_id" | "task_id" | "execution_id">,
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

    if (next !== undefined) await syncTerminalSession(this.sessions, sessionId, next);
    else if (sessionId !== undefined) {
      await this.sessions.updateSession(sessionId, { status: "failed" }).catch(error => {
        console.warn("Desktop Session failure could not be persisted", errorMessage(error));
      });
    }

    if (next?.status === "failed" && values.persistEvent !== false && values.threadId !== undefined && sessionId !== undefined) {
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
    const key = requestKey(execution);
    if (this.notified.has(key) || this.terminalListener === undefined) return;
    try {
      await this.terminalListener(execution);
      this.notified.add(key);
    } catch (error: unknown) {
      console.warn("Desktop execution terminal notification failed", errorMessage(error));
    }
  }

  private async recordEvent(event: LrmEvent): Promise<void> {
    await this.events.appendEvent(event);
  }
}
