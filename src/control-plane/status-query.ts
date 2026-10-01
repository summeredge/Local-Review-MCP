import { readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  executionIdSchema,
  executionStatusSchema,
  goalIdSchema,
  sessionIdSchema,
  sessionBackendTypeSchema,
  sessionStatusSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { executionFile, TASK_EXECUTIONS_DIRECTORY, taskExecutionsDirectory } from "../context/execution.js";
import { SessionStore } from "../context/session-store.js";
import { sessionFile } from "../context/session.js";
import { defaultTaskContextStorageRoot, taskContextFile } from "../context/task.js";
import { TaskContextService } from "../context/service.js";
import type { ExecutionContext, Session, SessionBackendType } from "../context/types.js";
import type { ExecutionMode } from "./execution-service.js";
import type { GoalOrchestrationService, GoalOrchestration } from "./goal-orchestration.js";
import {
  lrmEventSchema,
  type StoredLrmEvent,
} from "./events/model.js";
import { EventStore, eventsFile } from "./events/store.js";

const providerIdSchema = z.string().min(1).max(256);
const optionalModelSchema = z.string().min(1).max(256).optional();
const optionalEffortSchema = z.string().min(1).max(64).optional();

export const sessionStatusQueryInputSchema = z.object({
  session_id: sessionIdSchema.optional(),
  goal_id: goalIdSchema.optional(),
  workspace_id: workspaceIdSchema.optional(),
}).strict().refine(
  (input) => input.session_id !== undefined || input.goal_id !== undefined,
  "session_id or goal_id is required",
);

export const executionStatusQueryInputSchema = z.object({
  execution_id: executionIdSchema,
  session_id: sessionIdSchema.optional(),
  goal_id: goalIdSchema.optional(),
  workspace_id: workspaceIdSchema.optional(),
}).strict();

export const sessionEventsQueryInputSchema = z.object({
  session_id: sessionIdSchema,
  workspace_id: workspaceIdSchema.optional(),
  after_sequence: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(1_000).optional().default(200),
}).strict();

const currentExecutionSchema = z.object({
  execution_id: executionIdSchema,
  status: executionStatusSchema,
  turn_id: providerIdSchema.optional(),
}).strict();

export const sessionStatusOutputSchema = z.object({
  session_id: sessionIdSchema,
  goal_id: goalIdSchema,
  task_id: taskIdSchema,
  backend_type: sessionBackendTypeSchema,
  status: sessionStatusSchema,
  thread_id: providerIdSchema.optional(),
  model: optionalModelSchema,
  reasoning_effort: optionalEffortSchema,
  goal_status: z.enum(["pending", "running", "completed", "failed", "human_required"]).optional(),
  current_execution: currentExecutionSchema.optional(),
}).strict();

export const executionStatusOutputSchema = z.object({
  execution_id: executionIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  status: executionStatusSchema,
  started_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }).optional(),
  summary: z.string().max(4_000).optional(),
  goal_id: goalIdSchema.optional(),
  goal_status: z.enum(["pending", "running", "completed", "failed", "human_required"]).optional(),
  session_id: sessionIdSchema.optional(),
  backend_type: sessionBackendTypeSchema.optional(),
  thread_id: providerIdSchema.optional(),
  turn_id: providerIdSchema.optional(),
  agent_output: z.string().max(100_000).optional(),
}).strict();

export const sessionEventsOutputSchema = z.object({
  session_id: sessionIdSchema,
  events: z.array(lrmEventSchema),
  returned: z.number().int().min(0),
  has_more: z.boolean(),
}).strict();

export type SessionStatusQueryInput = z.input<typeof sessionStatusQueryInputSchema>;
export type ExecutionStatusQueryInput = z.input<typeof executionStatusQueryInputSchema>;
export type SessionEventsQueryInput = z.input<typeof sessionEventsQueryInputSchema>;
export type SessionStatusOutput = z.infer<typeof sessionStatusOutputSchema>;
export type ExecutionStatusOutput = z.infer<typeof executionStatusOutputSchema>;
export type SessionEventsOutput = z.infer<typeof sessionEventsOutputSchema>;

export interface LauncherSessionSummary {
  readonly session_id: string;
  readonly goal_id: string;
  readonly task_id: string;
  readonly goal_name: string;
  readonly task_name: string;
  readonly backend_type: SessionStatusOutput["backend_type"];
  readonly status: SessionStatusOutput["status"];
  readonly thread_id?: string;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly goal_status?: SessionStatusOutput["goal_status"];
  readonly current_execution?: SessionStatusOutput["current_execution"];
  readonly updated_at: string;
}

/**
 * One Launcher dashboard row. The Execution is the primary object; Goal and Session are optional
 * associations, so a batch Execution with no Session is a complete row rather than a gap.
 * `backend` keeps the internal identity ("cli", "codex_app_server", "desktop_codex_app") and
 * `backend_type` repeats the matched Session's identity, which is where `backend` comes from when
 * a Session exists.
 */
export interface LauncherExecutionSummary {
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly goal_id?: string;
  readonly name: string;
  readonly goal_name?: string;
  readonly task_name: string;
  readonly execution_mode?: ExecutionMode;
  readonly backend?: SessionBackendType;
  readonly status: ExecutionContext["status"];
  readonly started_at: string;
  readonly finished_at?: string;
  readonly summary?: string;
  readonly session_id?: string;
  readonly thread_id?: string;
  readonly backend_type?: SessionBackendType;
  readonly model?: string;
  readonly reasoning_effort?: string;
  readonly updated_at: string;
}

type GoalReader = Pick<GoalOrchestrationService, "getGoal"> & {
  readonly listGoals?: GoalOrchestrationService["listGoals"];
};
type SessionReader = Pick<SessionStore, "getSession" | "listSessions"> & { readonly storageRoot?: string };
type ExecutionReader = Pick<ExecutionContextService, "getExecutionContext" | "listExecutions">
  & { readonly storageRoot?: string };
type TaskReader = Pick<TaskContextService, "listTaskContexts"> & { readonly storageRoot?: string };
type EventReader = Pick<EventStore, "listEvents"> & { readonly storageRoot?: string };

export interface StatusQueryServiceOptions {
  readonly storageRoot?: string;
  readonly goals?: GoalReader;
  readonly goalOrchestration?: GoalReader;
  readonly sessions?: SessionReader;
  readonly sessionStore?: SessionReader;
  readonly executions?: ExecutionReader;
  readonly executionContextService?: ExecutionReader;
  readonly tasks?: TaskReader;
  readonly taskContextService?: TaskReader;
  readonly events?: EventReader;
  readonly eventStore?: EventReader;
}

interface ExecutionMatch {
  readonly execution: ExecutionContext;
  readonly goal?: GoalOrchestration;
  readonly session?: Session;
  readonly events: readonly StoredLrmEvent[];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function plannedTask(goal: GoalOrchestration, taskId: string) {
  for (const phase of goal.phases) {
    const task = phase.tasks.find((candidate) => candidate.task_id === taskId);
    if (task !== undefined) return { phase, task };
  }
  return undefined;
}

function latestEvent(
  events: readonly StoredLrmEvent[],
  executionId: string,
): StoredLrmEvent | undefined {
  return [...events]
    .filter((event) => event.execution_id === executionId)
    .sort((left, right) => right.sequence - left.sequence)[0];
}

function latestSessionEvent(events: readonly StoredLrmEvent[]): StoredLrmEvent | undefined {
  return [...events].sort((left, right) => right.sequence - left.sequence)[0];
}

function turnIdFor(events: readonly StoredLrmEvent[], executionId: string): string | undefined {
  const event = latestEvent(events, executionId);
  return event !== undefined && "turn_id" in event ? event.turn_id : undefined;
}

function eventStatus(event: StoredLrmEvent | undefined): "running" | "passed" | "failed" | undefined {
  if (event === undefined) return undefined;
  if (event.event_type === "turn_completed") return "passed";
  if (event.event_type === "execution_failed") return "failed";
  return "running";
}

function outputFromEvents(events: readonly StoredLrmEvent[], executionId: string): string | undefined {
  const content = events
    .filter((event) => event.execution_id === executionId
      && (event.event_type === "agent_message_delta" || event.event_type === "agent_message_completed"))
    .map((event) => "content" in event.payload ? event.payload.content : "")
    .join("")
    .slice(0, 100_000);
  return content === "" ? undefined : content;
}

export class StatusQueryService {
  public readonly storageRoot: string;
  private readonly goals: GoalReader | undefined;
  private readonly sessions: SessionReader;
  private readonly executions: ExecutionReader;
  private readonly tasks: TaskReader;
  private readonly events: EventReader;

  public constructor(options: StatusQueryServiceOptions = {}) {
    this.storageRoot = resolve(
      options.storageRoot
        ?? options.sessions?.storageRoot
        ?? options.sessionStore?.storageRoot
        ?? options.executions?.storageRoot
        ?? options.executionContextService?.storageRoot
        ?? options.tasks?.storageRoot
        ?? options.taskContextService?.storageRoot
        ?? options.events?.storageRoot
        ?? options.eventStore?.storageRoot
        ?? defaultTaskContextStorageRoot(),
    );
    this.goals = options.goals ?? options.goalOrchestration;
    this.sessions = options.sessions ?? options.sessionStore ?? new SessionStore(this.storageRoot);
    this.executions = options.executions
      ?? options.executionContextService
      ?? new ExecutionContextService(this.storageRoot);
    this.tasks = options.tasks ?? options.taskContextService ?? new TaskContextService(this.storageRoot);
    this.events = options.events ?? options.eventStore ?? new EventStore(this.storageRoot);
    for (const dependency of [
      this.sessions.storageRoot,
      this.executions.storageRoot,
      this.tasks.storageRoot,
      this.events.storageRoot,
    ]) {
      if (dependency !== undefined && resolve(dependency) !== this.storageRoot) {
        throw new Error("Status Query dependencies must share one storage root.");
      }
    }
  }

  public async getSessionStatus(
    input: SessionStatusQueryInput | string,
  ): Promise<SessionStatusOutput> {
    const parsed = sessionStatusQueryInputSchema.parse(
      typeof input === "string" ? { session_id: input } : input,
    );
    const goal = parsed.goal_id === undefined ? undefined : await this.requiredGoal(parsed.goal_id);
    let session: Session | null;
    if (parsed.session_id !== undefined) {
      session = await this.sessions.getSession(parsed.session_id);
      if (session === null) throw new Error(`Session "${parsed.session_id}" was not found.`);
      if (goal !== undefined && session.goal_id !== goal.goal_id) {
        throw new Error("Session does not belong to the requested Goal.");
      }
    } else {
      const matches = (await this.sessions.listSessions()).filter((candidate) =>
        candidate.goal_id === parsed.goal_id,
      );
      if (matches.length > 1) throw new Error("More than one Session matches the requested Goal.");
      session = matches[0] ?? null;
      if (session === null) throw new Error(`No Session was found for Goal "${parsed.goal_id}".`);
    }

    const sessionGoal = goal ?? await this.optionalGoal(session.goal_id);
    this.assertWorkspace(parsed.workspace_id, sessionGoal);
    if (sessionGoal !== undefined && sessionGoal.current_task_id !== session.task_id) {
      throw new Error("Session task identity does not match the Goal checkpoint.");
    }
    const events = await this.events.listEvents(session.session_id);
    const executionId = this.executionIdFor(session, sessionGoal, events);
    const execution = executionId === undefined || sessionGoal === undefined
      ? undefined
      : await this.executions.getExecutionContext(
        sessionGoal.workspace_id,
        session.task_id,
        executionId,
      );
    const currentEvent = executionId === undefined ? undefined : latestEvent(events, executionId);
    const currentExecutionStatus = execution?.status ?? eventStatus(currentEvent);

    return sessionStatusOutputSchema.parse({
      session_id: session.session_id,
      goal_id: session.goal_id,
      task_id: session.task_id,
      backend_type: session.backend_type,
      status: session.status,
      ...(session.thread_id === undefined ? {} : { thread_id: session.thread_id }),
      ...(session.model === undefined ? {} : { model: session.model }),
      ...(session.reasoning_effort === undefined ? {} : { reasoning_effort: session.reasoning_effort }),
      ...(sessionGoal === undefined ? {} : { goal_status: sessionGoal.status }),
      ...(executionId === undefined || currentExecutionStatus === undefined ? {} : {
        current_execution: {
          execution_id: executionId,
          status: currentExecutionStatus,
          ...(turnIdFor(events, executionId) === undefined ? {} : { turn_id: turnIdFor(events, executionId) }),
        },
      }),
    });
  }

  public async getExecutionStatus(
    input: ExecutionStatusQueryInput | string,
  ): Promise<ExecutionStatusOutput> {
    const parsed = executionStatusQueryInputSchema.parse(
      typeof input === "string" ? { execution_id: input } : input,
    );
    const match = await this.resolveExecution(parsed);
    this.assertWorkspace(parsed.workspace_id, match.goal, match.execution.workspace_id);
    return executionStatusOutputSchema.parse({
      execution_id: match.execution.execution_id,
      workspace_id: match.execution.workspace_id,
      task_id: match.execution.task_id,
      status: match.execution.status,
      started_at: match.execution.started_at,
      ...(match.execution.finished_at === undefined ? {} : { finished_at: match.execution.finished_at }),
      ...(match.execution.summary === undefined ? {} : { summary: match.execution.summary }),
      ...(match.goal === undefined ? {} : {
        goal_id: match.goal.goal_id,
        goal_status: match.goal.status,
      }),
      ...(match.session === undefined ? {} : {
        session_id: match.session.session_id,
        backend_type: match.session.backend_type,
        ...(match.session.thread_id === undefined ? {} : { thread_id: match.session.thread_id }),
      }),
      ...(turnIdFor(match.events, match.execution.execution_id) === undefined
        ? {}
        : { turn_id: turnIdFor(match.events, match.execution.execution_id) }),
      ...(outputFromEvents(match.events, match.execution.execution_id) === undefined
        ? {}
        : { agent_output: outputFromEvents(match.events, match.execution.execution_id) }),
    });
  }

  public async listSessionEvents(input: SessionEventsQueryInput): Promise<SessionEventsOutput> {
    const parsed = sessionEventsQueryInputSchema.parse(input);
    const session = await this.sessions.getSession(parsed.session_id);
    if (session === null) throw new Error(`Session "${parsed.session_id}" was not found.`);
    const goal = await this.optionalGoal(session.goal_id);
    this.assertWorkspace(parsed.workspace_id, goal);
    const all = await this.events.listEvents(session.session_id);
    const after = parsed.after_sequence;
    const available = all.filter((event) => event.sequence > after);
    const selected = available.slice(0, parsed.limit);
    return sessionEventsOutputSchema.parse({
      session_id: session.session_id,
      events: selected,
      returned: selected.length,
      has_more: available.length > selected.length,
    });
  }

  public async listSessionSummaries(workspaceId?: string): Promise<LauncherSessionSummary[]> {
    const summaries: LauncherSessionSummary[] = [];
    for (const session of await this.sessions.listSessions()) {
      const goal = await this.optionalGoal(session.goal_id);
      if (workspaceId !== undefined && (goal === undefined || goal.workspace_id !== workspaceId)) continue;

      let status: SessionStatusOutput;
      try {
        status = await this.getSessionStatus({
          session_id: session.session_id,
          ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
        });
      } catch {
        continue;
      }
      if (status.backend_type !== "codex_app_server") continue;

      const phase = goal?.phases.find((candidate) => candidate.phase_id === goal.current_phase_id);
      const task = phase?.tasks.find((candidate) => candidate.task_id === session.task_id);
      summaries.push({
        ...status,
        goal_name: phase?.objective.slice(0, 256) || status.goal_id,
        task_name: task?.goal.slice(0, 256) || status.task_id,
        updated_at: session.updated_at,
      });
    }
    return summaries.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  /**
   * Unified Execution catalog for the Launcher task dashboard. Executions are read from their own
   * durable records, so a batch Execution stays observable without a Session; Goal and Session are
   * optional associations, and a missing or damaged one only degrades its own row.
   */
  public async listExecutionSummaries(workspaceId?: string): Promise<LauncherExecutionSummary[]> {
    const goals = await this.availableGoals();
    const sessions = await this.availableSessions();
    const summaries: LauncherExecutionSummary[] = [];
    for (const target of await this.executionTargets(workspaceId)) {
      let executions: ExecutionContext[];
      try {
        executions = await this.executions.listExecutions(target.workspace_id, target.task_id);
      } catch {
        continue;
      }
      for (const execution of executions) {
        try {
          summaries.push(await this.executionSummary(execution, goals, sessions));
        } catch {
          continue;
        }
      }
    }
    return summaries.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  private async executionSummary(
    execution: ExecutionContext,
    goals: readonly GoalOrchestration[],
    sessions: readonly Session[],
  ): Promise<LauncherExecutionSummary> {
    const goal = await this.goalForExecution(execution, goals);
    const session = this.sessionFor(execution, goal, sessions);
    const plan = goal === undefined ? undefined : plannedTask(goal, execution.task_id);
    const goalName = goal === undefined
      ? undefined
      : (plan?.phase.objective.slice(0, 256) || goal.goal_id);
    const taskName = plan?.task.goal.slice(0, 256) || execution.task_id;
    // Backend evidence, not Session presence: the fixed route only ever sends a batch Execution to
    // the CLI backend, so a batch row keeps its identity even without a Session record. Anything
    // else stays unresolved instead of being guessed.
    const backend = session?.backend_type ?? (goal?.execution_mode === "batch" ? "cli" : undefined);
    return {
      execution_id: execution.execution_id,
      workspace_id: execution.workspace_id,
      task_id: execution.task_id,
      ...(goal === undefined ? {} : {
        goal_id: goal.goal_id,
        execution_mode: goal.execution_mode,
      }),
      name: goalName ?? taskName,
      ...(goalName === undefined ? {} : { goal_name: goalName }),
      task_name: taskName,
      ...(backend === undefined ? {} : { backend }),
      status: execution.status,
      started_at: execution.started_at,
      ...(execution.finished_at === undefined ? {} : { finished_at: execution.finished_at }),
      ...(execution.summary === undefined ? {} : { summary: execution.summary }),
      ...(session === undefined ? {} : {
        session_id: session.session_id,
        backend_type: session.backend_type,
        ...(session.thread_id === undefined ? {} : { thread_id: session.thread_id }),
        ...(session.model === undefined ? {} : { model: session.model }),
        ...(session.reasoning_effort === undefined
          ? {}
          : { reasoning_effort: session.reasoning_effort }),
      }),
      updated_at: session?.updated_at ?? execution.finished_at ?? execution.started_at,
    };
  }

  /**
   * Sessions are matched by Task identity and, when the Goal is known, by Goal identity. Provider
   * event evidence is deliberately left out so polling the dashboard stays a bounded read.
   */
  private sessionFor(
    execution: ExecutionContext,
    goal: GoalOrchestration | undefined,
    sessions: readonly Session[],
  ): Session | undefined {
    const matches = sessions.filter((session) => session.task_id === execution.task_id
      && (goal === undefined || session.goal_id === goal.goal_id));
    return matches.reduce<Session | undefined>(
      (latest, candidate) => latest === undefined || candidate.updated_at > latest.updated_at
        ? candidate
        : latest,
      undefined,
    );
  }

  /** Damaged Goal state degrades the Execution catalog; it never fails the whole query. */
  private async availableGoals(): Promise<GoalOrchestration[]> {
    try {
      return await this.listGoals();
    } catch {
      return [];
    }
  }

  private async availableSessions(): Promise<readonly Session[]> {
    try {
      return await this.sessions.listSessions();
    } catch {
      return [];
    }
  }

  /**
   * Executions are enumerated from their own directory layout instead of from Task records, so an
   * Execution whose TaskContext was cleaned up or never stored stays visible.
   */
  private async executionTargets(
    workspaceId?: string,
  ): Promise<Array<{ readonly workspace_id: string; readonly task_id: string }>> {
    const root = join(this.storageRoot, TASK_EXECUTIONS_DIRECTORY);
    const targets = new Map<string, { readonly workspace_id: string; readonly task_id: string }>();
    for (const workspace of await this.directories(root)) {
      if (!workspaceIdSchema.safeParse(workspace).success) continue;
      if (workspaceId !== undefined && workspace !== workspaceId) continue;
      for (const task of await this.directories(join(root, workspace))) {
        if (!taskIdSchema.safeParse(task).success) continue;
        targets.set(`${workspace}\0${task}`, { workspace_id: workspace, task_id: task });
      }
    }
    return [...targets.values()];
  }

  private async directories(directory: string): Promise<string[]> {
    try {
      return (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  public async clearSessionRecords(workspaceId?: string) {
    return this.clearExecutionRecords(workspaceId);
  }

  public async clearExecutionRecords(workspaceId?: string): Promise<{
    readonly deleted_executions: number;
    readonly deleted_sessions: number;
    readonly deleted_events: number;
    readonly deleted_tasks: number;
  }> {
    if (workspaceId === undefined || !workspaceIdSchema.safeParse(workspaceId).success) {
      throw new Error("Workspace scope is required to clear persisted task records.");
    }

    let sessions: readonly Session[] | undefined;
    try {
      sessions = await this.sessions.listSessions();
    } catch {
      // Unreadable Session metadata must not block Execution cleanup or permit Task deletion.
      sessions = undefined;
    }
    const terminalExecutions = new Set(["passed", "failed", "terminated"]);
    const terminalSessions = new Set(["completed", "failed", "terminated"]);
    const interactiveBackends = new Set(["codex_app_server", "desktop_codex_app"]);
    const sessionsToDelete = new Map<string, {
      readonly session: Session;
      readonly events: StoredLrmEvent[];
      readonly workspace_id: string;
    }>();
    const emptyTaskTargets: Array<{ readonly workspace_id: string; readonly task_id: string }> = [];
    let deletedExecutions = 0;
    let deletedEvents = 0;

    for (const target of await this.executionTargets(workspaceId)) {
      let executions: ExecutionContext[];
      try {
        executions = await this.executions.listExecutions(target.workspace_id, target.task_id);
      } catch {
        continue;
      }
      const terminalIds = new Set(executions
        .filter((execution) => terminalExecutions.has(execution.status))
        .map((execution) => execution.execution_id));
      if (terminalIds.size === 0) continue;

      for (const session of sessions ?? []) {
        if (session.task_id !== target.task_id
          || !interactiveBackends.has(session.backend_type)
          || !terminalSessions.has(session.status)
          || sessionsToDelete.has(session.session_id)) continue;
        let goal: GoalOrchestration | undefined;
        let sessionEvents: StoredLrmEvent[];
        try {
          goal = await this.optionalGoal(session.goal_id);
          if (goal?.workspace_id !== target.workspace_id) continue;
          sessionEvents = await this.events.listEvents(session.session_id);
        } catch {
          continue;
        }

        const relatedIds = unique([
          ...sessionEvents.map((event) => event.execution_id),
          ...(goal.current_task_id === target.task_id && goal.execution_id !== undefined
            ? [goal.execution_id]
            : []),
        ]);
        if (!relatedIds.some((id) => terminalIds.has(id))) continue;
        // Unknown or running associations keep the whole Session and its event stream intact.
        if (relatedIds.some((id) => !terminalIds.has(id))) continue;
        sessionsToDelete.set(session.session_id, {
          session,
          events: sessionEvents,
          workspace_id: target.workspace_id,
        });
      }

      for (const executionId of terminalIds) {
        await rm(executionFile(this.storageRoot, target.workspace_id, target.task_id, executionId), {
          force: true,
        });
        deletedExecutions += 1;
      }
      for (const [sessionId, candidate] of sessionsToDelete) {
        if (candidate.workspace_id !== target.workspace_id || candidate.session.task_id !== target.task_id) continue;
        await rm(sessionFile(this.storageRoot, sessionId), { force: true });
        await rm(eventsFile(this.storageRoot, sessionId), { force: true });
        deletedEvents += candidate.events.length;
      }
      if (executions.every((execution) => terminalIds.has(execution.execution_id))) {
        emptyTaskTargets.push(target);
      }
    }

    const remainingSessions = new Set((sessions ?? [])
      .filter((session) => !sessionsToDelete.has(session.session_id))
      .map((session) => session.task_id));
    let taskContexts: Awaited<ReturnType<TaskReader["listTaskContexts"]>> | undefined;
    try {
      taskContexts = await this.tasks.listTaskContexts();
    } catch {
      taskContexts = undefined;
    }
    let goalsForCleanup: GoalOrchestration[] | undefined;
    try {
      if (this.goals?.listGoals !== undefined) goalsForCleanup = await this.goals.listGoals();
    } catch {
      goalsForCleanup = undefined;
    }
    let deletedTasks = 0;
    for (const target of emptyTaskTargets) {
      if (sessions === undefined || remainingSessions.has(target.task_id) || goalsForCleanup === undefined
        || goalsForCleanup.some((goal) => goal.status !== "completed" && goal.status !== "failed"
          && goal.phases.some((phase) => phase.tasks.some((task) => task.task_id === target.task_id)))) continue;
      try {
        await rmdir(taskExecutionsDirectory(this.storageRoot, target.workspace_id, target.task_id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      const task = taskContexts?.find((candidate) => candidate.task_id === target.task_id);
      if (task === undefined || task.workspace_id !== target.workspace_id) continue;
      await rm(taskContextFile(this.storageRoot, task.task_id), { force: true });
      deletedTasks += 1;
    }

    return {
      deleted_executions: deletedExecutions,
      deleted_sessions: sessionsToDelete.size,
      deleted_events: deletedEvents,
      deleted_tasks: deletedTasks,
    };
  }

  private async resolveExecution(input: z.output<typeof executionStatusQueryInputSchema>): Promise<ExecutionMatch> {
    const requestedGoal = input.goal_id === undefined ? undefined : await this.requiredGoal(input.goal_id);
    const requestedSession = input.session_id === undefined
      ? undefined
      : await this.requiredSession(input.session_id);
    if (requestedGoal !== undefined && requestedSession !== undefined
      && requestedSession.goal_id !== requestedGoal.goal_id) {
      throw new Error("Session does not belong to the requested Goal.");
    }

    let candidates: Array<{ execution: ExecutionContext; goal?: GoalOrchestration; session?: Session }> = [];
    if (requestedGoal !== undefined) {
      if (requestedGoal.execution_id !== input.execution_id) {
        throw new Error("Execution does not match the requested Goal checkpoint.");
      }
      if (requestedGoal.current_task_id === undefined) {
        throw new Error("Requested Goal has no current Task checkpoint.");
      }
      const execution = await this.executions.getExecutionContext(
        requestedGoal.workspace_id,
        requestedGoal.current_task_id,
        input.execution_id,
      );
      if (execution !== null) candidates.push({ execution, goal: requestedGoal, session: requestedSession });
    } else if (requestedSession !== undefined) {
      const goal = await this.optionalGoal(requestedSession.goal_id);
      const task = await this.findTask(requestedSession.task_id, input.workspace_id ?? goal?.workspace_id);
      if (task !== undefined) {
        const execution = await this.executions.getExecutionContext(
          task.workspace_id,
          task.task_id,
          input.execution_id,
        );
        if (execution !== null) candidates.push({ execution, goal, session: requestedSession });
      }
    } else {
      for (const task of await this.tasks.listTaskContexts()) {
        if (input.workspace_id !== undefined && task.workspace_id !== input.workspace_id) continue;
        const execution = await this.executions.getExecutionContext(
          task.workspace_id,
          task.task_id,
          input.execution_id,
        );
        if (execution !== null) candidates.push({ execution });
      }
      const goals = await this.listGoals();
      for (const goal of goals) {
        if (goal.execution_id !== input.execution_id) continue;
        const candidate = candidates.find((item) => item.execution.workspace_id === goal.workspace_id
          && item.execution.task_id === goal.current_task_id);
        if (candidate !== undefined) candidate.goal = goal;
      }
    }

    const identities = unique(candidates.map((candidate) =>
      `${candidate.execution.workspace_id}\0${candidate.execution.task_id}\0${candidate.execution.execution_id}`));
    if (identities.length === 0) throw new Error(`Execution "${input.execution_id}" was not found.`);
    if (identities.length > 1) throw new Error(`Execution "${input.execution_id}" is ambiguous.`);
    const candidate = candidates.find((item) =>
      `${item.execution.workspace_id}\0${item.execution.task_id}\0${item.execution.execution_id}` === identities[0],
    )!;
    const goal = candidate.goal ?? await this.goalForExecution(candidate.execution);
    const session = await this.sessionForExecution(input.session_id, candidate.execution, goal);
    const events = session === undefined ? [] : await this.events.listEvents(session.session_id);
    return { execution: candidate.execution, ...(goal === undefined ? {} : { goal }), ...(session === undefined ? {} : { session }), events };
  }

  private async sessionForExecution(
    requestedSessionId: string | undefined,
    execution: ExecutionContext,
    goal: GoalOrchestration | undefined,
  ): Promise<Session | undefined> {
    if (requestedSessionId !== undefined) {
      const session = await this.requiredSession(requestedSessionId);
      const events = await this.events.listEvents(session.session_id);
      if (session.task_id !== execution.task_id
        || (goal === undefined && !events.some((event) => event.execution_id === execution.execution_id))
        || (goal !== undefined && session.goal_id !== goal.goal_id)
        || (goal !== undefined
          && goal.execution_id !== execution.execution_id
          && !events.some((event) => event.execution_id === execution.execution_id))) {
        throw new Error("Session does not belong to the requested Execution.");
      }
      return session;
    }
    const matches: Session[] = [];
    for (const session of await this.sessions.listSessions()) {
      if (session.task_id !== execution.task_id) continue;
      if (goal !== undefined && session.goal_id !== goal.goal_id) continue;
      const events = await this.events.listEvents(session.session_id);
      if (events.some((event) => event.execution_id === execution.execution_id)
        || (goal !== undefined && goal.execution_id === execution.execution_id)) matches.push(session);
    }
    if (matches.length > 1) throw new Error("More than one Session matches the requested Execution.");
    return matches[0];
  }

  private async goalForExecution(
    execution: ExecutionContext,
    goals?: readonly GoalOrchestration[],
  ): Promise<GoalOrchestration | undefined> {
    const candidates = goals ?? await this.listGoals();
    const checkpoint = candidates.find((goal) => goal.execution_id === execution.execution_id
      && goal.workspace_id === execution.workspace_id
      && goal.current_task_id === execution.task_id);
    if (checkpoint !== undefined) return checkpoint;
    // A Goal only checkpoints its active Execution, so an earlier Execution of the same Goal is
    // linked back through the planned Task identity instead of being reported as unassociated.
    const planned = candidates.filter((goal) => goal.workspace_id === execution.workspace_id
      && goal.phases.some((phase) =>
        phase.tasks.some((task) => task.task_id === execution.task_id)));
    return planned.length === 1 ? planned[0] : undefined;
  }

  private async findTask(taskId: string, workspaceId?: string) {
    const matches = (await this.tasks.listTaskContexts()).filter((task) =>
      task.task_id === taskId && (workspaceId === undefined || task.workspace_id === workspaceId),
    );
    if (matches.length > 1) throw new Error(`Task "${taskId}" is ambiguous.`);
    return matches[0];
  }

  private executionIdFor(
    session: Session,
    goal: GoalOrchestration | undefined,
    events: readonly StoredLrmEvent[],
  ): string | undefined {
    const currentEvent = latestSessionEvent(events);
    if (currentEvent !== undefined) return currentEvent.execution_id;
    if (goal?.current_task_id !== session.task_id) return undefined;
    return goal?.execution_id;
  }

  private async optionalGoal(goalId: string): Promise<GoalOrchestration | undefined> {
    return this.goals === undefined ? undefined : (await this.goals.getGoal(goalId)) ?? undefined;
  }

  private async requiredGoal(goalId: string): Promise<GoalOrchestration> {
    const goal = await this.optionalGoal(goalId);
    if (goal === undefined) throw new Error(`Goal "${goalId}" was not found.`);
    return goal;
  }

  private async requiredSession(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (session === null) throw new Error(`Session "${sessionId}" was not found.`);
    return session;
  }

  private async listGoals(): Promise<GoalOrchestration[]> {
    return this.goals?.listGoals === undefined ? [] : this.goals.listGoals();
  }

  private assertWorkspace(
    workspaceId: string | undefined,
    goal: GoalOrchestration | undefined,
    recordWorkspaceId?: string,
  ): void {
    const ownerWorkspaceId = goal?.workspace_id ?? recordWorkspaceId;
    if (workspaceId !== undefined && ownerWorkspaceId !== workspaceId) {
      throw new Error("Status query workspace does not match the requested record.");
    }
  }
}
