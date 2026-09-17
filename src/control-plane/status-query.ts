import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  executionIdSchema,
  executionStatusSchema,
  goalIdSchema,
  sessionIdSchema,
  sessionStatusSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { taskExecutionsDirectory } from "../context/execution.js";
import { SessionStore } from "../context/session-store.js";
import { sessionFile } from "../context/session.js";
import { defaultTaskContextStorageRoot, taskContextFile } from "../context/task.js";
import { TaskContextService } from "../context/service.js";
import type { ExecutionContext, Session } from "../context/types.js";
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
  backend_type: z.enum(["cli", "codex_app_server"]),
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
  backend_type: z.enum(["cli", "codex_app_server"]).optional(),
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

  public async clearSessionRecords(workspaceId?: string): Promise<{
    readonly deleted_sessions: number;
    readonly deleted_events: number;
    readonly deleted_tasks: number;
  }> {
    const sessions = await this.sessions.listSessions();
    const terminal = new Set(["completed", "failed", "terminated"]);
    const candidates: Array<{ readonly session: Session; readonly workspace_id: string }> = [];
    for (const session of sessions) {
      if (session.backend_type !== "codex_app_server" || !terminal.has(session.status)) continue;
      const goal = await this.optionalGoal(session.goal_id);
      if (goal === undefined || (workspaceId !== undefined && goal.workspace_id !== workspaceId)) continue;
      candidates.push({ session, workspace_id: goal.workspace_id });
    }

    const candidateIds = new Set(candidates.map(({ session }) => session.session_id));
    const retainedTasks = new Set(sessions
      .filter((session) => !candidateIds.has(session.session_id))
      .map((session) => session.task_id));
    const deletedTasks = new Set<string>();
    for (const { session, workspace_id } of candidates) {
      await rm(sessionFile(this.storageRoot, session.session_id), { force: true });
      await rm(eventsFile(this.storageRoot, session.session_id), { force: true });
      const taskKey = `${workspace_id}\0${session.task_id}`;
      if (!retainedTasks.has(session.task_id) && !deletedTasks.has(taskKey)) {
        await rm(taskContextFile(this.storageRoot, session.task_id), { force: true });
        await rm(taskExecutionsDirectory(this.storageRoot, workspace_id, session.task_id), {
          recursive: true,
          force: true,
        });
        deletedTasks.add(taskKey);
      }
    }
    return {
      deleted_sessions: candidates.length,
      deleted_events: candidates.length,
      deleted_tasks: deletedTasks.size,
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

  private async goalForExecution(execution: ExecutionContext): Promise<GoalOrchestration | undefined> {
    for (const goal of await this.listGoals()) {
      if (goal.execution_id === execution.execution_id
        && goal.workspace_id === execution.workspace_id
        && goal.current_task_id === execution.task_id) return goal;
    }
    return undefined;
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
