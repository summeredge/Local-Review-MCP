import { sessionForExecution, syncTerminalSession } from "../../context/session-execution.js";
import { resolve } from "node:path";
import { ExecutionContextService } from "../../context/execution-service.js";
import { SessionStore } from "../../context/session-store.js";
import { AutoIterationStore, type AutoIteration } from "../../control-plane/auto-iteration.js";
import { TaskContextService } from "../../context/service.js";
import type { ExecutionContext, Session } from "../../context/types.js";
import { defaultTaskContextStorageRoot } from "../../context/task.js";
import type { WorkspaceRegistry } from "../../workspace/registry.js";
import type { ReasoningEffortValue } from "../../models/model-catalog.js";
import { ModelResolutionError } from "../../models/model-resolver.js";
import { EventStore } from "../../control-plane/events/store.js";
import type { LrmEvent } from "../../control-plane/events/model.js";
import { CodexEventAdapter } from "./event-adapter.js";
import { CodexAppServerClient } from "./client.js";
import { CodexAppServerNotDispatchedError, CodexAppServerRpcError } from "./protocol.js";
import type {
  AppServerModel,
  CodexAppServerClientOptions,
  StartThreadInput,
  StartTurnInput,
} from "./models.js";
import {
  executionBackendStartRequestSchema,
  ExecutionLaunchIndeterminateError,
  type ExecutionBackend,
  type ExecutionBackendStartRequest,
  type ExecutionStartResult,
  type ExecutionTerminalListener,
} from "../../control-plane/execution-service.js";

export const APP_SERVER_COMMAND = "codex app-server --listen stdio://";
const SUMMARY_MAX_LENGTH = 4_000;
/** Stable summary when the backend shuts down before a turn produced terminal evidence. */
export const BACKEND_CLOSED_SUMMARY = "Codex AppServer backend closed before terminal turn evidence.";
/** Stable summary for a running Execution a previous runtime left behind. */
export const ORPHANED_EXECUTION_SUMMARY =
  "Codex AppServer execution was orphaned by a previous runtime shutdown.";

interface ExecutionIdentity {
  readonly workspace_id: string;
  readonly task_id: string;
  readonly execution_id: string;
}

interface WatcherEntry {
  readonly identity: ExecutionIdentity;
  readonly request: ExecutionBackendStartRequest;
  readonly sessionId: string;
  readonly turnId: string;
  readonly done: Promise<void>;
}

type AppServerClient = Pick<
  CodexAppServerClient,
  "processInfo" | "listModels" | "startThread" | "startTurn" | "readThread" | "resumeThread" | "events" | "close"
>;

interface ContinuationTarget {
  readonly threadId: string;
  readonly turnId: string;
  /** Present only when this runtime still holds the exact Client that started the prior Turn. */
  readonly client?: AppServerClient;
}

export type AppServerClientFactory = (
  options: CodexAppServerClientOptions,
) => Promise<AppServerClient>;

export interface CodexAppServerBackendOptions {
  readonly storageRoot?: string;
  readonly eventStore?: Pick<EventStore, "appendEvent" | "listEvents"> & { readonly storageRoot?: string };
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly clientFactory?: AppServerClientFactory;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

function boundedSummary(value: string | undefined, fallback: string): string {
  const summary = value?.trim().slice(0, SUMMARY_MAX_LENGTH) ?? "";
  return summary === "" ? fallback : summary;
}

function requestKey(request: ExecutionIdentity): string {
  return `${request.workspace_id}\0${request.task_id}\0${request.execution_id}`;
}

function selectedModel(
  request: ExecutionBackendStartRequest,
  models: readonly AppServerModel[],
): AppServerModel | undefined {
  if (request.model_id !== undefined) {
    const selected = models.find((model) => model.model_id === request.model_id);
    if (selected === undefined) {
      throw new ModelResolutionError({ code: "model_unknown", input: request.model_id });
    }
    return selected;
  }

  const defaults = models.filter((model) => model.is_default === true);
  if (defaults.length > 1) throw new Error("Codex app-server returned multiple default models.");
  return defaults[0];
}

function selectedEffort(
  request: ExecutionBackendStartRequest,
  model: AppServerModel | undefined,
): ReasoningEffortValue | undefined {
  if (request.reasoning_effort !== undefined) {
    if (model === undefined || !model.reasoning_efforts.includes(request.reasoning_effort)) {
      throw new ModelResolutionError({
        code: "reasoning_effort_unsupported", input: model?.model_id ?? request.model_id ?? "default",
        reasoning_effort: request.reasoning_effort,
      });
    }
    return request.reasoning_effort;
  }
  if (model?.default_effort === undefined) return undefined;
  if (!model.reasoning_efforts.includes(model.default_effort)) {
    throw new Error(`Codex app-server returned an unsupported default reasoning effort: ${model.default_effort}`);
  }
  return model.default_effort;
}

function threadInput(cwd: string, model: AppServerModel | undefined): StartThreadInput {
  return model === undefined ? { cwd } : { cwd, model: model.model_id };
}

function turnInput(
  threadId: string,
  instruction: string,
  model: AppServerModel | undefined,
  effort: string | undefined,
): StartTurnInput {
  return {
    threadId,
    text: instruction,
    ...(model === undefined ? {} : { model: model.model_id }),
    ...(effort === undefined ? {} : { effort }),
  };
}

export class CodexAppServerBackend implements ExecutionBackend {
  public readonly storageRoot: string;
  private readonly sessions: SessionStore;
  private readonly executions: ExecutionContextService;
  private readonly events: Pick<EventStore, "appendEvent" | "listEvents">;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly clientFactory: AppServerClientFactory;
  private readonly executable: string | undefined;
  private readonly requestTimeoutMs: number | undefined;
  private readonly inFlight = new Map<string, Promise<ExecutionStartResult>>();
  private readonly clients = new Map<string, AppServerClient>();
  /**
   * Watchers this backend instance actually owns, keyed by Execution. A watcher is the only live
   * proof that a persisted running Execution is still executing in this process, so both
   * `existing()` ownership checks and `close()` drain this map.
   */
  private readonly watchers = new Map<string, WatcherEntry>();
  private readonly tasks: TaskContextService;
  private readonly notified = new Set<string>();
  private terminalListener: ExecutionTerminalListener | undefined;
  private closing = false;

  public constructor(
    private readonly registry: WorkspaceRegistry,
    options: CodexAppServerBackendOptions = {},
  ) {
    this.storageRoot = resolve(options.storageRoot ?? defaultTaskContextStorageRoot());
    this.sessions = new SessionStore(this.storageRoot);
    this.executions = new ExecutionContextService(this.storageRoot);
    this.tasks = new TaskContextService(this.storageRoot);
    this.events = options.eventStore ?? new EventStore(this.storageRoot);
    this.environment = { ...process.env, ...(options.environment ?? {}) };
    this.executable = options.executable?.trim() || undefined;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.clientFactory = options.clientFactory ?? ((clientOptions) => CodexAppServerClient.start(clientOptions));
  }

  public start(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    const parsed = executionBackendStartRequestSchema.parse(request);
    if (parsed.execution_mode !== "interactive") {
      throw new Error("CodexAppServerBackend only handles interactive executions.");
    }
    if (parsed.goal_id === undefined) throw new Error("Interactive execution requires goal_id.");
    if (this.closing) throw new Error("Codex app-server backend is closed.");

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

  public async close(): Promise<void> {
    this.closing = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    // Closing the client ends its event stream, which is what releases every watcher blocked on
    // client.events(). Drain them so a turn interrupted by shutdown has already persisted its
    // terminal failure and notified the terminal listener before close() resolves.
    await Promise.all([...this.watchers.values()].map((entry) => entry.done.catch(() => undefined)));
    this.watchers.clear();
  }

  private async startOnce(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    const workspace = this.registry.resolve(request.workspace_id);
    const cwd = workspace.manager.canonicalRoot;
    const existing = await this.executions.getExecutionContext(
      request.workspace_id,
      request.task_id,
      request.execution_id,
    );
    if (existing !== null) return this.existing(request, existing);
    const loop = await this.iterationLoop(request);
    // Nothing has been dispatched yet, so a refused continuation is not a failed backend attempt.
    // Report it as indeterminate so AutoIteration stops for a human instead of recording failure.
    const continuation = loop === undefined ? undefined : await this.resumeContinuation(
      request, cwd, loop,
    ).catch((error: unknown) => {
      throw new ExecutionLaunchIndeterminateError(errorMessage(error), { cause: error });
    });

    let session: Session | undefined;
    let execution: ExecutionContext | undefined;
    let client = continuation?.client;
    const borrowedClient = client !== undefined && [...this.clients.values()].includes(client);
    let stage = "backend_connect";
    try {
      const staleSession = await this.findSession(request);
      if (staleSession !== null) {
        throw new Error(`Interactive Session "${staleSession.session_id}" exists without its Execution.`);
      }
      session = await this.sessions.createSession({
        execution_id: request.execution_id,
        goal_id: request.goal_id!,
        task_id: request.task_id,
        backend_type: "codex_app_server",
        status: "created",
        workspace: cwd,
      });
      session = await this.sessions.updateSession(session.session_id, { status: "starting" });
      execution = await this.executions.createExecutionContext({
        execution_id: request.execution_id,
        task_id: request.task_id,
        workspace_id: request.workspace_id,
        status: "running",
        command: APP_SERVER_COMMAND,
      });

      client ??= continuation?.client ?? await this.clientFactory({
        cwd,
        ...(this.executable === undefined ? {} : { executable: this.executable }),
        environment: this.environment,
        ...(this.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.requestTimeoutMs }),
      });
      if (client === undefined) throw new Error("Codex app-server continuation has no client.");
      const processId = client.processInfo.process_id;
      if (!Number.isInteger(processId) || processId <= 0) {
        throw new Error("Codex app-server did not expose a valid process identity.");
      }
      this.clients.set(session.session_id, client);
      execution = await this.executions.updateExecutionContext(
        request.workspace_id,
        request.task_id,
        request.execution_id,
        { process_id: processId },
      );

      stage = "model/list";
      const models = await client.listModels();
      stage = "model_validation";
      const model = selectedModel(request, models);
      const effort = selectedEffort(request, model);
      session = await this.sessions.updateSession(session.session_id, {
        ...(model === undefined ? {} : { model_id: model.model_id }),
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
      });

      stage = continuation === undefined ? "thread/start" : "thread/reuse";
      const threadId = continuation === undefined
        ? (await client.startThread(threadInput(cwd, model))).thread_id
        : continuation.thread_id;
      session = await this.sessions.updateSession(session.session_id, {
        status: "active",
        thread_id: threadId,
      });

      stage = "turn/start";
      const turn = await client.startTurn(turnInput(threadId, request.instruction, model, effort));
      stage = "turn/result";
      const eventAdapter = new CodexEventAdapter({
        session_id: session.session_id,
        execution_id: request.execution_id,
        thread_id: threadId,
        turn_id: turn.turn_id,
      });
      if (turn.status === "completed") {
        await this.recordEvent(eventAdapter.adapt({
          type: "turn_completed",
          thread_id: threadId,
          turn_id: turn.turn_id,
        }));
        await this.complete(request, session.session_id, threadId, turn.turn_id);
      } else if (turn.status === "failed") {
        await this.recordEvent(eventAdapter.adapt({
          type: "turn_failed",
          thread_id: threadId,
          turn_id: turn.turn_id,
        }));
        await this.fail(request, session.session_id, turn.turn_id);
        throw new Error("Codex app-server turn failed to start.");
      } else {
        this.startWatching(
          client,
          request,
          session.session_id,
          threadId,
          turn.turn_id,
          eventAdapter,
        );
      }

      return {
        execution_id: execution.execution_id,
        process_id: processId,
        started_at: execution.started_at,
        accepted: "new",
        session_id: session.session_id,
        thread_id: threadId,
        turn_id: turn.turn_id,
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        error.message = `AppServer stage=${stage} model=${request.model_id ?? "default"} reasoning_effort=${request.reasoning_effort ?? "default"}: ${error.message}`;
      }
      if (client !== undefined && session !== undefined) this.clients.delete(session.session_id);
      if (!borrowedClient) await client?.close().catch(() => undefined);
      // The request may have reached the provider before the response was lost. There is no turn
      // identity to observe, so the honest outcome is "unknown": stop for a human, never resend.
      if (stage === "turn/start" && !(error instanceof CodexAppServerRpcError)
        && !(error instanceof CodexAppServerNotDispatchedError)) {
        if (execution !== undefined) await this.terminate(execution, session?.session_id,
          `AppServer turn/start outcome unknown; no retry: ${errorMessage(error)}`, "terminated");
        throw new ExecutionLaunchIndeterminateError(errorMessage(error), { cause: error });
      }
      await this.failLaunch(request, session, execution, error);
      throw error;
    }
  }

  private async existing(
    request: ExecutionBackendStartRequest,
    execution: ExecutionContext,
  ): Promise<ExecutionStartResult> {
    if (execution.status !== "running" || execution.process_id === undefined) {
      throw new Error(`Execution "${execution.execution_id}" is already terminal or has no process identity.`);
    }
    const session = await this.findSession(request);
    if (session === null || session.thread_id === undefined) {
      throw new Error(`Interactive Execution "${execution.execution_id}" has no recoverable Session.`);
    }
    // A persisted running record is not proof of a live turn. Only a watcher this instance still
    // owns proves the app-server client is running here; anything else is an orphan from a previous
    // runtime, which is reported as failed instead of being resumed or reported as existing.
    const owned = this.watchers.get(execution.execution_id);
    if (owned === undefined || owned.sessionId !== session.session_id) {
      await this.terminate(execution, session.session_id, ORPHANED_EXECUTION_SUMMARY);
      throw new Error(
        `Interactive Execution "${execution.execution_id}" has no live Codex app-server client in this runtime.`,
      );
    }
    return {
      execution_id: execution.execution_id,
      process_id: execution.process_id,
      started_at: execution.started_at,
      accepted: "existing",
      session_id: session.session_id,
      thread_id: session.thread_id,
    };
  }

  /**
   * ITERATE target resolution. The initial Session carries the Thread the first Execution used;
   * a running prior Turn or a missing Session is not proof that another Turn may be submitted.
   * A live Client is reused only when it is still tracked for a Session of this same Thread.
   */
  private async continuationTarget(
    request: ExecutionBackendStartRequest,
    cwd: string,
    loop: AutoIteration,
  ): Promise<ContinuationTarget | undefined> {
    const initialId = loop.initial_execution_id;
    if (initialId === request.execution_id) return undefined;
    const initial = await this.executions.getExecutionContext(
      request.workspace_id, request.task_id, initialId,
    );
    const sessions = await this.sessions.listSessions();
    const initialSession = initial === null ? undefined : await sessionForExecution(
      sessions.filter((session) => session.backend_type === "codex_app_server"
        && session.goal_id === request.goal_id
        && session.task_id === request.task_id),
      initial,
      await this.executions.listExecutions(request.workspace_id, request.task_id),
      this.events,
    );
    if (initial?.command !== APP_SERVER_COMMAND || initial.status !== "passed"
      || initialSession === null || initialSession === undefined
      || initialSession.execution_id !== initialId
      || initialSession.backend_type !== "codex_app_server"
      || initialSession.thread_id === undefined) {
      throw new Error(
        "Initial AppServer Execution has no verified completed Turn and original Thread; continuation requires human handling.",
      );
    }
    const threadId = initialSession.thread_id;
    if (request.thread_id !== threadId) {
      throw new Error("Authorized Thread differs from the initial AppServer Session Thread.");
    }
    const turns = (await this.events.listEvents(initialSession.session_id))
      .filter((event) => event.execution_id === initialId
        && event.thread_id === threadId
        && event.event_type === "turn_completed");
    if (turns.length !== 1 || !("turn_id" in turns[0]!) || turns[0]!.turn_id === undefined) {
      throw new Error("Initial AppServer Execution has no durable completed Turn; refusing to resend.");
    }
    const sessionIds = new Set((await this.sessions.listSessions())
      .filter((session) => session.backend_type === "codex_app_server"
        && session.task_id === request.task_id
        && session.thread_id === threadId)
      .map((session) => session.session_id));
    const live = [...this.clients.entries()].find(([sessionId]) => sessionIds.has(sessionId))?.[1];
    return { threadId, turnId: turns[0]!.turn_id, ...(live === undefined ? {} : { client: live }) };
  }

  private async iterationLoop(request: ExecutionBackendStartRequest): Promise<AutoIteration | undefined> {
    const loops = (await new AutoIterationStore(this.storageRoot).list()).filter((loop) =>
      loop.workspace_id === request.workspace_id
      && loop.task_id === request.task_id
      && loop.execution_id === request.execution_id);
    if (loops.length > 1) throw new Error("AppServer iteration identity is ambiguous.");
    return loops[0];
  }

  /** Verify both persisted and provider-visible thread identity before submitting a new Turn. */
  private async verifyContinuation(
    client: AppServerClient,
    target: ContinuationTarget,
    cwd: string,
  ): Promise<void> {
    const persisted = await client.readThread({ threadId: target.threadId, includeTurns: true });
    if (persisted.thread_id !== target.threadId || resolve(persisted.cwd) !== resolve(cwd)
      || !persisted.turns.some((turn) => turn.turn_id === target.turnId && turn.status === "completed")) {
      throw new Error("Original AppServer Thread identity or completed Turn cannot be verified.");
    }
    const resumed = await client.resumeThread({ threadId: target.threadId, cwd });
    if (resumed.thread_id !== target.threadId || resolve(resumed.cwd) !== resolve(cwd)
      || !resumed.turns.some((turn) => turn.turn_id === target.turnId && turn.status === "completed")) {
      throw new Error("Codex app-server resumed a different Thread; refusing to continue.");
    }
  }

  /**
   * Reuse a live client in this runtime; otherwise reconnect and resume the exact persisted Thread.
   * The extra read verifies the provider's stored cwd and a completed Turn before any new input.
   */
  private async resumeContinuation(
    request: ExecutionBackendStartRequest,
    cwd: string,
    loop: AutoIteration,
  ): Promise<{ readonly client: AppServerClient; readonly thread_id: string }> {
    const target = await this.continuationTarget(request, cwd, loop);
    if (target === undefined) throw new Error("AppServer continuation has no initial Thread.");
    if (target.client !== undefined) {
      await this.verifyContinuation(target.client, target, cwd);
      return { client: target.client, thread_id: target.threadId };
    }
    const client = await this.clientFactory({
      cwd,
      ...(this.executable === undefined ? {} : { executable: this.executable }),
      environment: this.environment,
      ...(this.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.requestTimeoutMs }),
    });
    try {
      await this.verifyContinuation(client, target, cwd);
    } catch (error: unknown) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return { client, thread_id: target.threadId };
  }

  /**
   * Startup orphan reconciliation. It never resumes, retries, or migrates anything: a running
   * app-server Execution that this instance does not own is terminated as failed so Goal and
   * Auto Iteration see the standard execution failure and route to human handling. Safe to call
   * repeatedly; terminal records also repair Session state and retry unsuccessful notifications.
   */
  public async reconcileOrphanedExecutions(): Promise<ExecutionContext[]> {
    const reconciled: ExecutionContext[] = [];
    const sessions = (await this.sessions.listSessions())
      .filter((session) => session.backend_type === "codex_app_server");
    for (const task of await this.tasks.listTaskContexts()) {
      let executions: ExecutionContext[];
      try {
        executions = await this.executions.listExecutions(task.workspace_id, task.task_id);
      } catch (error: unknown) {
        console.warn(
          `Codex AppServer orphan reconciliation could not list executions for Task ${task.task_id}; `
          + "keeping execution state unchanged",
          errorMessage(error),
        );
        continue;
      }

      for (const execution of executions) {
        if (execution.command !== APP_SERVER_COMMAND) continue;
        const session = await sessionForExecution(
          sessions.filter(candidate => candidate.task_id === task.task_id
            && candidate.workspace === this.registry.resolve(task.workspace_id).manager.canonicalRoot),
          execution, executions.filter(candidate => candidate.command === APP_SERVER_COMMAND), this.events);
        if (execution.status !== "running") {
          await syncTerminalSession(this.sessions, session?.session_id, execution);
          await this.notifyTerminal(execution);
          continue;
        }
        if (this.watchers.has(execution.execution_id)) continue;
        const next = await this.terminate(
          execution,
          session?.session_id,
          ORPHANED_EXECUTION_SUMMARY,
        );
        if (next !== null) reconciled.push(next);
      }
    }
    return reconciled;
  }

  private async findSession(request: ExecutionBackendStartRequest): Promise<Session | null> {
    if (request.goal_id === undefined) return null;
    const matches = (await this.sessions.listSessions()).filter((session) =>
      session.goal_id === request.goal_id
      && session.task_id === request.task_id
      && session.backend_type === "codex_app_server");
    const current: Session[] = [];
    for (const session of matches) {
      let ids = session.execution_id === undefined
        ? [...new Set((await this.events.listEvents(session.session_id)).map((event) => event.execution_id))]
        : [session.execution_id];
      if (ids.length === 0 && matches.length === 1) {
        const evidence = (await this.executions.listExecutions(request.workspace_id, request.task_id))
          .filter(execution => execution.command === APP_SERVER_COMMAND);
        if (evidence.length === 1) ids = [evidence[0]!.execution_id];
      }
      if (ids.length === 0) {
        // Legacy records without execution evidence cannot safely authorize another dispatch.
        throw new Error(`Interactive Session "${session.session_id}" exists without its Execution association.`);
      }
      if (ids.length !== 1) throw new Error("Interactive Session has conflicting Execution associations.");
      if (session.execution_id === undefined) {
        await this.sessions.updateSession(session.session_id, { execution_id: ids[0]! });
      }
      if (ids[0] === request.execution_id) current.push(session);
      else {
        const history = await this.executions.getExecutionContext(request.workspace_id, request.task_id, ids[0]!);
        if (history === null || history.status === "running") {
          throw new Error("Interactive Session has an unresolved historical Execution.");
        }
      }
    }
    if (current.length > 1) throw new Error("More than one interactive Session matches the Execution.");
    return current[0] ?? null;
  }

  private async watch(
    client: AppServerClient,
    request: ExecutionBackendStartRequest,
    sessionId: string,
    threadId: string,
    turnId: string,
    eventAdapter: CodexEventAdapter,
  ): Promise<void> {
    try {
      for await (const providerEvent of client.events()) {
        const event = eventAdapter.adapt(providerEvent);
        if (event === undefined) continue;
        if (event.event_type === "turn_started") {
          await this.executions.updateExecutionContext(
            request.workspace_id,
            request.task_id,
            request.execution_id,
            { status: "running" },
          );
          await this.sessions.updateSession(sessionId, { status: "running_turn" });
        }
        await this.recordEvent(event);
        if (event.event_type === "turn_completed") {
          await this.complete(request, sessionId, threadId, turnId);
          return;
        }
        if (event.event_type === "execution_failed") {
          await this.fail(request, sessionId, turnId, event.payload.reason);
          return;
        }
      }
      // The event stream ending is the end of this watcher's evidence. A normal unexpected end and
      // a backend shutdown both leave the turn without terminal evidence, so both persist the same
      // terminal failure; only the summary distinguishes them for the human reader.
      await this.fail(
        request,
        sessionId,
        turnId,
        this.closing
          ? BACKEND_CLOSED_SUMMARY
          : "app-server ended without terminal turn evidence",
      );
    } catch (error: unknown) {
      if (this.closing) await this.fail(request, sessionId, turnId, BACKEND_CLOSED_SUMMARY);
      else await this.fail(request, sessionId, turnId, errorMessage(error));
    }
  }

  private startWatching(
    client: AppServerClient,
    request: ExecutionBackendStartRequest,
    sessionId: string,
    threadId: string,
    turnId: string,
    eventAdapter: CodexEventAdapter,
  ): void {
    const identity: ExecutionIdentity = {
      workspace_id: request.workspace_id,
      task_id: request.task_id,
      execution_id: request.execution_id,
    };
    // Ownership is published before the loop starts, so a concurrent existing() or a close() that
    // races the first provider event sees a live watcher instead of an orphan.
    const entry: WatcherEntry = {
      identity,
      request,
      sessionId,
      turnId,
      done: this.watch(client, request, sessionId, threadId, turnId, eventAdapter).finally(() => {
        if (this.watchers.get(identity.execution_id) === entry) this.watchers.delete(identity.execution_id);
      }),
    };
    this.watchers.set(request.execution_id, entry);
  }

  private async complete(
    request: ExecutionBackendStartRequest,
    sessionId: string,
    _threadId: string,
    _turnId: string,
  ): Promise<void> {
    const execution = await this.executions.getExecutionContext(
      request.workspace_id,
      request.task_id,
      request.execution_id,
    );
    if (execution === null) return;
    if (execution.status !== "running") {
      await syncTerminalSession(this.sessions, sessionId, execution);
      await this.notifyTerminal(execution);
      return;
    }
    const next = await this.executions.updateExecutionContext(
      request.workspace_id,
      request.task_id,
      request.execution_id,
      { status: "passed", summary: "Codex turn completed successfully." },
    );
    await syncTerminalSession(this.sessions, sessionId, next);
    await this.notifyTerminal(next);
  }

  private async fail(
    request: ExecutionBackendStartRequest,
    sessionId: string,
    _turnId: string,
    reason?: string,
  ): Promise<void> {
    const execution = await this.executions.getExecutionContext(
      request.workspace_id,
      request.task_id,
      request.execution_id,
    );
    if (execution === null) return;
    if (execution.status !== "running") {
      await syncTerminalSession(this.sessions, sessionId, execution);
      await this.notifyTerminal(execution);
      return;
    }
    const next = await this.executions.updateExecutionContext(
      request.workspace_id,
      request.task_id,
      request.execution_id,
      { status: "failed", summary: boundedSummary(reason, "Codex turn failed.") },
    );
    await syncTerminalSession(this.sessions, sessionId, next);
    await this.notifyTerminal(next);
  }

  /**
   * Single terminal write for every path where the turn will not produce further evidence:
   * unknown launch, backend shutdown and startup orphan reconciliation. A non-running Execution is left alone, so
   * an already terminal record is never downgraded and never notified twice.
   */
  private async terminate(
    execution: ExecutionContext,
    sessionId: string | undefined,
    summary: string,
    status: "failed" | "terminated" = "failed",
  ): Promise<ExecutionContext | null> {
    if (execution.status !== "running") return null;
    const next = await this.executions.updateExecutionContext(
      execution.workspace_id,
      execution.task_id,
      execution.execution_id,
      { status, summary: boundedSummary(summary, summary) },
    );
    if (sessionId !== undefined) {
      await syncTerminalSession(this.sessions, sessionId, next);
    }
    await this.notifyTerminal(next);
    return next;
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
    if (current !== null && current.status !== "running") {
      await syncTerminalSession(this.sessions, session?.session_id, current);
      await this.notifyTerminal(current);
      return;
    }
    if (current?.status === "running") {
      const next = await this.executions.updateExecutionContext(
        request.workspace_id,
        request.task_id,
        request.execution_id,
        { status: "failed", summary: boundedSummary(errorMessage(error), "Interactive execution failed.") },
      ).catch(() => undefined);
      if (next !== undefined) {
        await syncTerminalSession(this.sessions, session?.session_id, next);
        await this.notifyTerminal(next);
        return;
      }
    }
    if (session !== undefined) await this.sessions.updateSession(session.session_id, { status: "failed" }).catch(() => undefined);
  }

  private async notifyTerminal(execution: ExecutionContext): Promise<void> {
    const key = requestKey(execution);
    if (this.notified.has(key) || this.terminalListener === undefined) return;
    try {
      await this.terminalListener(execution);
      this.notified.add(key);
    } catch (error: unknown) {
      console.warn("Interactive execution terminal notification failed", errorMessage(error));
    }
  }

  private async recordEvent(event: LrmEvent | undefined): Promise<void> {
    if (event !== undefined) await this.events.appendEvent(event);
  }
}

export type { AppServerClient };
