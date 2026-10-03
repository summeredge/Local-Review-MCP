import { resolve } from "node:path";
import { ExecutionContextService } from "../../context/execution-service.js";
import { SessionStore } from "../../context/session-store.js";
import { TaskContextService } from "../../context/service.js";
import type { ExecutionContext, Session } from "../../context/types.js";
import { defaultTaskContextStorageRoot } from "../../context/task.js";
import type { WorkspaceRegistry } from "../../workspace/registry.js";
import { EventStore } from "../../control-plane/events/store.js";
import type { LrmEvent } from "../../control-plane/events/model.js";
import { CodexEventAdapter } from "./event-adapter.js";
import { CodexAppServerClient } from "./client.js";
import type {
  AppServerModel,
  CodexAppServerClientOptions,
  StartThreadInput,
  StartTurnInput,
} from "./models.js";
import {
  executionBackendStartRequestSchema,
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
  "processInfo" | "listModels" | "startThread" | "startTurn" | "events" | "close"
>;

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

function requestKey(request: ExecutionBackendStartRequest): string {
  return `${request.workspace_id}\0${request.task_id}\0${request.execution_id}`;
}

function selectedModel(
  request: ExecutionBackendStartRequest,
  models: readonly AppServerModel[],
): AppServerModel | undefined {
  if (request.model !== undefined) {
    const selected = models.find((model) => model.model === request.model);
    if (selected === undefined) {
      throw new Error(`Requested model was not returned by model/list: ${request.model}`);
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
): string | undefined {
  if (request.reasoning_effort !== undefined) {
    if (model === undefined || !model.efforts.includes(request.reasoning_effort)) {
      throw new Error(`Reasoning effort is not supported by the selected model: ${request.reasoning_effort}`);
    }
    return request.reasoning_effort;
  }
  if (model?.default_effort === undefined) return undefined;
  if (!model.efforts.includes(model.default_effort)) {
    throw new Error(`Codex app-server returned an unsupported default reasoning effort: ${model.default_effort}`);
  }
  return model.default_effort;
}

function threadInput(cwd: string, model: AppServerModel | undefined): StartThreadInput {
  return model === undefined ? { cwd } : { cwd, model: model.model };
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
    ...(model === undefined ? {} : { model: model.model }),
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

    const staleSession = await this.findSession(request);
    if (staleSession !== null) {
      throw new Error(`Interactive Session "${staleSession.session_id}" exists without its Execution.`);
    }

    let session: Session | undefined;
    let execution: ExecutionContext | undefined;
    let client: AppServerClient | undefined;
    try {
      session = await this.sessions.createSession({
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

      client = await this.clientFactory({
        cwd,
        ...(this.executable === undefined ? {} : { executable: this.executable }),
        environment: this.environment,
        ...(this.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: this.requestTimeoutMs }),
      });
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

      const models = await client.listModels();
      const model = selectedModel(request, models);
      const effort = selectedEffort(request, model);
      session = await this.sessions.updateSession(session.session_id, {
        ...(model === undefined ? {} : { model: model.model }),
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
      });

      const thread = await client.startThread(threadInput(cwd, model));
      session = await this.sessions.updateSession(session.session_id, {
        status: "active",
        thread_id: thread.thread_id,
      });

      const turn = await client.startTurn(turnInput(thread.thread_id, request.instruction, model, effort));
      const eventAdapter = new CodexEventAdapter({
        session_id: session.session_id,
        execution_id: request.execution_id,
        thread_id: thread.thread_id,
        turn_id: turn.turn_id,
      });
      if (turn.status === "completed") {
        await this.recordEvent(eventAdapter.adapt({
          type: "turn_completed",
          thread_id: thread.thread_id,
          turn_id: turn.turn_id,
        }));
        await this.complete(request, session.session_id, thread.thread_id, turn.turn_id);
      } else if (turn.status === "failed") {
        await this.recordEvent(eventAdapter.adapt({
          type: "turn_failed",
          thread_id: thread.thread_id,
          turn_id: turn.turn_id,
        }));
        await this.fail(request, session.session_id, turn.turn_id);
        throw new Error("Codex app-server turn failed to start.");
      } else {
        this.startWatching(
          client,
          request,
          session.session_id,
          thread.thread_id,
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
        thread_id: thread.thread_id,
        turn_id: turn.turn_id,
      };
    } catch (error: unknown) {
      if (client !== undefined && session !== undefined) this.clients.delete(session.session_id);
      await client?.close().catch(() => undefined);
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
   * Startup orphan reconciliation. It never resumes, retries, or migrates anything: a running
   * app-server Execution that this instance does not own is terminated as failed so Goal and
   * Auto Iteration see the standard execution failure and route to human handling. Safe to call
   * repeatedly; an already terminal record is left untouched and not notified twice.
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
      const session = sessions
        .filter((candidate) => candidate.task_id === task.task_id)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
      for (const execution of executions) {
        if (execution.status !== "running" || execution.command !== APP_SERVER_COMMAND) continue;
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
    if (matches.length > 1) throw new Error("More than one interactive Session matches the Goal task.");
    return matches[0] ?? null;
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
    if (execution === null || execution.status !== "running") return;
    const next = await this.executions.updateExecutionContext(
      request.workspace_id,
      request.task_id,
      request.execution_id,
      { status: "passed", summary: "Codex turn completed successfully." },
    );
    await this.sessions.updateSession(sessionId, { status: "completed" });
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
    if (execution === null || execution.status !== "running") return;
    const next = await this.executions.updateExecutionContext(
      request.workspace_id,
      request.task_id,
      request.execution_id,
      { status: "failed", summary: boundedSummary(reason, "Codex turn failed.") },
    );
    await this.sessions.updateSession(sessionId, { status: "failed" });
    await this.notifyTerminal(next);
  }

  /**
   * Single terminal write for every path where the turn will not produce further evidence:
   * backend shutdown and startup orphan reconciliation. A non-running Execution is left alone, so
   * an already terminal record is never downgraded and never notified twice.
   */
  private async terminate(
    execution: ExecutionContext,
    sessionId: string | undefined,
    summary: string,
  ): Promise<ExecutionContext | null> {
    if (execution.status !== "running") return null;
    const next = await this.executions.updateExecutionContext(
      execution.workspace_id,
      execution.task_id,
      execution.execution_id,
      { status: "failed", summary: boundedSummary(summary, summary) },
    );
    if (sessionId !== undefined) {
      await this.sessions.updateSession(sessionId, { status: "failed" });
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
    if (current?.status === "running") {
      const next = await this.executions.updateExecutionContext(
        request.workspace_id,
        request.task_id,
        request.execution_id,
        { status: "failed", summary: boundedSummary(errorMessage(error), "Interactive execution failed.") },
      ).catch(() => undefined);
      if (next !== undefined) await this.notifyTerminal(next);
    }
    if (session !== undefined) await this.sessions.updateSession(session.session_id, { status: "failed" }).catch(() => undefined);
  }

  private async notifyTerminal(execution: ExecutionContext): Promise<void> {
    try {
      await this.terminalListener?.(execution);
    } catch (error: unknown) {
      console.warn("Interactive execution terminal notification failed", errorMessage(error));
    }
  }

  private async recordEvent(event: LrmEvent | undefined): Promise<void> {
    if (event !== undefined) await this.events.appendEvent(event);
  }
}

export type { AppServerClient };
