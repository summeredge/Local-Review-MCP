import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ExecutionContextService } from "../context/execution-service.js";
import {
  executionIdSchema,
  goalIdSchema,
  sessionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { TaskContextService } from "../context/service.js";
import { SessionStore } from "../context/session-store.js";
import { DesktopThreadBindingStore } from "../desktop-codex/desktop-thread-binding-store.js";
import type { ExecutionContext } from "../context/types.js";
import { isReservedWindowsName } from "../workspace/path.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { migrateLegacyModelIdFields } from "../models/model-resolver.js";
import { reasoningEffortValueSchema, type ReasoningEffortValue } from "../models/model-catalog.js";
import {
  CODEX_EXECUTION_COMMAND,
  CodexExecutionAdapter,
} from "./codex-execution-adapter.js";
import { backupLegacyState, stateRestoreDiagnostic } from "./state-migration.js";
import {
  ExecutionLaunchIndeterminateError,
  executionModeSchema,
  type ExecutionBackend,
  type ExecutionBackendStartRequest,
  type ExecutionStartResult,
  type ExecutionMode,
} from "./execution-service.js";

const STATE_VERSION = 2;
const ACTUATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const timestampSchema = z.string().datetime({ offset: true });
const actuationIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ACTUATION_ID_PATTERN)
  .refine((value) => !isReservedWindowsName(value), "actuation_id is a reserved filename");
const authorizationIdSchema = z.string().uuid();
const instructionSchema = z.string()
  .min(1)
  .max(1_000_000)
  .refine((value) => value.trim() !== "", "instruction is required")
  .refine((value) => !value.includes("\0"), "instruction contains a null byte");

export const controlledActuationStateFile = (storageRoot: string): string =>
  join(resolve(storageRoot), "control-plane", "controlled-actuations.json");

export interface ActuationAuthorizationInput {
  readonly actuation_id: string;
  readonly goal_id?: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly execution_id: string;
  readonly instruction: string;
  readonly execution_mode: ExecutionMode;
  readonly model_id?: string;
  readonly reasoning_effort?: ReasoningEffortValue;
  /** Exact backend of the initial Execution. ITERATE reuses it instead of renegotiating. */
  readonly backend?: "desktop_codex_app" | "codex_app_server";
  /** Original Thread of the initial Execution; required for interactive continuation. */
  readonly thread_id?: string;
}

export interface ActuationAuthorization extends ActuationAuthorizationInput {
  readonly authorization_id: string;
  readonly status: "authorized" | "consumed";
  readonly created_at: string;
  readonly replay_blocked_reason?: string;
}

export interface ControlledActuationRequest {
  readonly actuation_id: string;
  readonly authorization_id: string;
}

export interface ControlledActuation {
  readonly actuation_id: string;
  readonly authorization_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly execution_id: string;
  readonly status: "starting" | "started" | "failed";
  readonly created_at: string;
  readonly updated_at: string;
  readonly error?: string;
}

export interface ControlledActuationResult extends ExecutionStartResult {
  readonly actuation: ControlledActuation;
}

export const actuationAuthorizationInputSchema = z.object({
  actuation_id: actuationIdSchema,
  goal_id: goalIdSchema.optional(),
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  instruction: instructionSchema,
  execution_mode: executionModeSchema,
  model_id: z.string().min(1).max(256).optional(),
  reasoning_effort: reasoningEffortValueSchema.optional(),
  backend: z.enum(["desktop_codex_app", "codex_app_server"]).optional(),
  thread_id: z.string().min(1).max(256).optional(),
}).strict();

export const actuationAuthorizationSchema = actuationAuthorizationInputSchema.extend({
  authorization_id: authorizationIdSchema,
  status: z.enum(["authorized", "consumed"]),
  created_at: timestampSchema,
  replay_blocked_reason: z.string().min(1).max(4_000).optional(),
}).strict();

export const controlledActuationRequestSchema = z.object({
  actuation_id: actuationIdSchema,
  authorization_id: authorizationIdSchema,
}).strict();

export const controlledActuationSchema = z.object({
  actuation_id: actuationIdSchema,
  authorization_id: authorizationIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  status: z.enum(["starting", "started", "failed"]),
  error: z.string().min(1).max(4_000).optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

const stateSchema = z.object({
  schema_version: z.literal(STATE_VERSION),
  authorizations: z.array(actuationAuthorizationSchema),
  actuations: z.array(controlledActuationSchema),
}).strict().superRefine((state, context) => {
  const authorizationsById = new Map<string, z.infer<typeof actuationAuthorizationSchema>>();
  const authorizationsByActuation = new Map<string, z.infer<typeof actuationAuthorizationSchema>>();
  const actuationsById = new Map<string, z.infer<typeof controlledActuationSchema>>();
  const actuationsByAuthorization = new Map<string, z.infer<typeof controlledActuationSchema>>();

  state.authorizations.forEach((authorization, index) => {
    if (authorizationsById.has(authorization.authorization_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizations", index, "authorization_id"],
        message: "authorization_id is duplicated",
      });
    }
    if (authorizationsByActuation.has(authorization.actuation_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizations", index, "actuation_id"],
        message: "actuation_id is already authorized",
      });
    }
    authorizationsById.set(authorization.authorization_id, authorization);
    authorizationsByActuation.set(authorization.actuation_id, authorization);
  });

  state.actuations.forEach((actuation, index) => {
    if (actuationsById.has(actuation.actuation_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actuations", index, "actuation_id"],
        message: "actuation_id is duplicated",
      });
    }
    if (actuationsByAuthorization.has(actuation.authorization_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actuations", index, "authorization_id"],
        message: "authorization_id is consumed more than once",
      });
    }
    actuationsById.set(actuation.actuation_id, actuation);
    actuationsByAuthorization.set(actuation.authorization_id, actuation);
  });

  for (const [index, authorization] of state.authorizations.entries()) {
    const actuation = actuationsById.get(authorization.actuation_id);
    if (authorization.status === "authorized" && actuation !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizations", index, "status"],
        message: "authorized authorization already has an actuation record",
      });
    }
    if (authorization.status === "consumed"
      && (actuation === undefined || actuation.authorization_id !== authorization.authorization_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizations", index, "status"],
        message: "consumed authorization does not have its actuation record",
      });
    }
  }

  for (const [index, actuation] of state.actuations.entries()) {
    const authorization = authorizationsById.get(actuation.authorization_id);
    if (authorization === undefined
      || authorization.status !== "consumed"
      || authorization.actuation_id !== actuation.actuation_id
      || authorization.workspace_id !== actuation.workspace_id
      || authorization.task_id !== actuation.task_id
      || authorization.execution_id !== actuation.execution_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actuations", index],
        message: "actuation identity does not match its authorization",
      });
    }
  }
});

export const controlledActuationStartResultSchema = z.object({
  execution_id: executionIdSchema,
  process_id: z.number().int().positive().optional(),
  started_at: timestampSchema,
  accepted: z.enum(["new", "existing"]),
  session_id: sessionIdSchema.optional(),
  thread_id: z.string().max(256).optional(),
  turn_id: z.string().max(256).optional(),
}).strict();

type DurableState = z.infer<typeof stateSchema>;

const legacyStateSchema = z.object({
  schema_version: z.literal(1),
  authorizations: z.array(actuationAuthorizationSchema.extend({ execution_mode: executionModeSchema.optional() })),
  actuations: z.array(controlledActuationSchema),
}).strict();

async function migrateLegacyState(value: unknown, storageRoot: string): Promise<unknown> {
  if (typeof value !== "object" || value === null || !("schema_version" in value)
    || value.schema_version !== 1) return value;
  const legacy = legacyStateSchema.parse(value);
  const missing = legacy.authorizations.filter((record) => record.execution_mode === undefined);
  let goals: unknown[] = [];
  let goalReadError: string | undefined;
  if (missing.length !== 0) {
    const file = join(storageRoot, "control-plane", "goal-orchestrations.json");
    try {
      const data = z.object({ schema_version: z.union([z.literal(1), z.literal(2)]), goals: z.array(z.unknown()) }).strict().parse(JSON.parse(await readFile(file, "utf8")));
      goals = data.goals;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") goalReadError = stateRestoreDiagnostic(file, error);
    }
  }
  const goalEvidenceSchema = z.object({
    goal_id: goalIdSchema, workspace_id: workspaceIdSchema,
    execution_mode: executionModeSchema.optional(),
    phases: z.array(z.object({ tasks: z.array(z.object({ task_id: taskIdSchema }).passthrough()) }).passthrough()),
  }).passthrough();
  const executions = new ExecutionContextService(storageRoot);
  const authorizations = [];
  for (const record of legacy.authorizations) {
    if (record.execution_mode !== undefined) { authorizations.push(record); continue; }
    let mode: ExecutionMode | undefined;
    let blocked = goalReadError;
    const matches = goals.filter((goal) => typeof goal === "object" && goal !== null
      && ((record.goal_id !== undefined && "goal_id" in goal && goal.goal_id === record.goal_id)
        || ("actuation_id" in goal && goal.actuation_id === record.actuation_id)));
    if (matches.length > 1) blocked = "Legacy authorization has multiple matching Goals";
    else if (matches.length === 1) {
      const goal = goalEvidenceSchema.safeParse(matches[0]);
      if (!goal.success || goal.data.workspace_id !== record.workspace_id
        || !goal.data.phases.some((phase) => phase.tasks.some((task) => task.task_id === record.task_id))) {
        blocked = "Legacy authorization Goal evidence is invalid or has a different identity";
      } else mode = goal.data.execution_mode ?? "batch";
    }
    try {
      const execution = await executions.getExecutionContext(record.workspace_id, record.task_id, record.execution_id);
      if (execution?.command !== undefined) {
        const observed = execution.command === CODEX_EXECUTION_COMMAND ? "batch"
          : ["desktop codex_app", "codex app-server --listen stdio://"].includes(execution.command) ? "interactive" : undefined;
        if (observed === undefined) blocked = "Legacy execution backend is unknown";
        else if (mode !== undefined && mode !== observed) blocked = "Legacy Goal and execution modes disagree";
        else mode = observed;
      }
    } catch (error: unknown) {
      blocked = `Legacy execution evidence is unavailable: ${stateRestoreDiagnostic(record.execution_id, error)}`;
    }
    // Before 4361eaa, omitted authorization modes used the router's batch default.
    // This historical default does not change the interactive default for new Goals.
    authorizations.push({ ...record, execution_mode: mode ?? "batch",
      ...(blocked === undefined ? {} : { replay_blocked_reason: blocked.slice(0, 4_000) }) });
  }
  return { ...legacy, schema_version: STATE_VERSION, authorizations };
}

const actuationFlights = new Map<string, Promise<ControlledActuationResult>>();

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyState(): DurableState {
  return { schema_version: STATE_VERSION, authorizations: [], actuations: [] };
}

export class ControlledActuationConflictError extends Error {}
export class ControlledActuationUnavailableError extends Error {}

export interface ActuationReservation {
  readonly accepted: "new" | "existing";
  readonly authorization: ActuationAuthorization;
  readonly actuation: ControlledActuation;
}

export class ActuationAuthorizationStore {
  public readonly storageRoot: string;
  private readonly file: string;
  private state = emptyState();
  private restorePromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.storageRoot = resolve(storageRoot);
    this.file = controlledActuationStateFile(this.storageRoot);
  }

  public restore(): Promise<void> {
    this.restorePromise ??= this.exclusive(async () => {
      let raw: string;
      try {
        raw = await readFile(this.file, "utf8");
      } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") return;
        throw new ControlledActuationUnavailableError(
          `controlled actuation state could not be restored: ${stateRestoreDiagnostic(this.file, error)}`,
          { cause: error },
        );
      }
      try {
        const source = migrateLegacyModelIdFields(JSON.parse(raw) as unknown);
        const next = stateSchema.parse(await migrateLegacyState(source, this.storageRoot));
        if (typeof source === "object" && source !== null && "schema_version" in source && source.schema_version === 1) {
          await backupLegacyState(this.file, raw);
          await this.persist(next);
        }
        this.state = next;
      } catch (error: unknown) {
        throw new ControlledActuationUnavailableError(
          `controlled actuation state could not be restored: ${stateRestoreDiagnostic(this.file, error)}`,
          { cause: error },
        );
      }
    }).catch((error: unknown) => { this.restorePromise = null; throw error; });
    return this.restorePromise;
  }

  public async createAuthorization(input: ActuationAuthorizationInput): Promise<ActuationAuthorization> {
    await this.restore();
    const parsed = actuationAuthorizationInputSchema.parse(input);
    return this.exclusive(async () => {
      if (this.state.authorizations.some((authorization) => authorization.actuation_id === parsed.actuation_id)) {
        throw new ControlledActuationConflictError(
          `Actuation "${parsed.actuation_id}" already has an authorization.`,
        );
      }
      const authorization = actuationAuthorizationSchema.parse({
        ...parsed,
        authorization_id: randomUUID(),
        status: "authorized",
        created_at: new Date().toISOString(),
      });
      const next = stateSchema.parse({
        ...this.state,
        authorizations: [...this.state.authorizations, authorization],
      });
      await this.persist(next);
      this.state = next;
      return clone(authorization);
    });
  }

  public async getAuthorization(authorizationId: string): Promise<ActuationAuthorization | null> {
    await this.restore();
    const parsedId = authorizationIdSchema.parse(authorizationId);
    return this.exclusive(async () => {
      const authorization = this.state.authorizations.find((candidate) => candidate.authorization_id === parsedId);
      return authorization === undefined ? null : clone(authorization);
    });
  }

  public async getAuthorizationByActuation(actuationId: string): Promise<ActuationAuthorization | null> {
    await this.restore();
    const parsedId = actuationIdSchema.parse(actuationId);
    return this.exclusive(async () => {
      const authorization = this.state.authorizations.find((candidate) => candidate.actuation_id === parsedId);
      return authorization === undefined ? null : clone(authorization);
    });
  }

  public async getAuthorizationByExecution(
    workspaceId: string,
    taskId: string,
    executionId: string,
  ): Promise<ActuationAuthorization | null> {
    await this.restore();
    const workspace = workspaceIdSchema.parse(workspaceId);
    const task = taskIdSchema.parse(taskId);
    const execution = executionIdSchema.parse(executionId);
    return this.exclusive(async () => {
      const matches = this.state.authorizations.filter((candidate) =>
        candidate.workspace_id === workspace && candidate.task_id === task
        && candidate.execution_id === execution);
      if (matches.length > 1) throw new ControlledActuationConflictError("Execution has multiple authorizations.");
      return matches[0] === undefined ? null : clone(matches[0]);
    });
  }

  public async getActuation(actuationId: string): Promise<ControlledActuation | null> {
    await this.restore();
    const parsedId = actuationIdSchema.parse(actuationId);
    return this.exclusive(async () => {
      const actuation = this.state.actuations.find((candidate) => candidate.actuation_id === parsedId);
      return actuation === undefined ? null : clone(actuation);
    });
  }

  public async reserveActuation(request: ControlledActuationRequest): Promise<ActuationReservation> {
    await this.restore();
    const parsed = controlledActuationRequestSchema.parse(request);
    return this.exclusive(async () => {
      const authorization = this.state.authorizations.find(
        (candidate) => candidate.authorization_id === parsed.authorization_id,
      );
      if (authorization === undefined) {
        throw new Error(`Authorization "${parsed.authorization_id}" was not found.`);
      }
      if (authorization.replay_blocked_reason !== undefined) {
        throw new ControlledActuationConflictError(`Legacy authorization cannot be replayed: ${authorization.replay_blocked_reason}`);
      }
      if (authorization.actuation_id !== parsed.actuation_id) {
        throw new ControlledActuationConflictError(
          `Authorization "${parsed.authorization_id}" is bound to another actuation.`,
        );
      }

      const existing = this.state.actuations.find((candidate) => candidate.actuation_id === parsed.actuation_id);
      if (existing !== undefined) {
        if (existing.authorization_id !== parsed.authorization_id) {
          throw new ControlledActuationConflictError(
            `Actuation "${parsed.actuation_id}" is bound to another authorization.`,
          );
        }
        return {
          accepted: "existing",
          authorization: clone(authorization),
          actuation: clone(existing),
        };
      }
      if (authorization.status !== "authorized") {
        throw new ControlledActuationConflictError(
          `Authorization "${parsed.authorization_id}" has already been consumed.`,
        );
      }

      const timestamp = new Date().toISOString();
      const actuation = controlledActuationSchema.parse({
        actuation_id: authorization.actuation_id,
        authorization_id: authorization.authorization_id,
        workspace_id: authorization.workspace_id,
        task_id: authorization.task_id,
        execution_id: authorization.execution_id,
        status: "starting",
        created_at: timestamp,
        updated_at: timestamp,
      });
      const consumed = actuationAuthorizationSchema.parse({ ...authorization, status: "consumed" });
      const next = stateSchema.parse({
        ...this.state,
        authorizations: this.state.authorizations.map((candidate) =>
          candidate.authorization_id === authorization.authorization_id ? consumed : candidate),
        actuations: [...this.state.actuations, actuation],
      });
      await this.persist(next);
      this.state = next;
      return {
        accepted: "new",
        authorization: clone(consumed),
        actuation: clone(actuation),
      };
    });
  }

  public async setActuationStatus(
    actuationId: string,
    status: ControlledActuation["status"],
    error?: string,
  ): Promise<ControlledActuation> {
    await this.restore();
    const parsedId = actuationIdSchema.parse(actuationId);
    const parsedStatus = z.enum(["starting", "started", "failed"]).parse(status);
    return this.exclusive(async () => {
      const current = this.state.actuations.find((candidate) => candidate.actuation_id === parsedId);
      if (current === undefined) throw new Error(`Actuation "${parsedId}" was not found.`);
      if (current.status === parsedStatus && error === undefined) return clone(current);
      if (current.status !== "starting") {
        throw new ControlledActuationConflictError(
          `Actuation "${parsedId}" is already ${current.status}.`,
        );
      }
      const nextActuation = controlledActuationSchema.parse({
        ...current,
        status: parsedStatus,
        ...(error === undefined ? {} : { error: error.slice(0, 4_000) }),
        updated_at: new Date().toISOString(),
      });
      const next = stateSchema.parse({
        ...this.state,
        actuations: this.state.actuations.map((candidate) =>
          candidate.actuation_id === parsedId ? nextActuation : candidate),
      });
      await this.persist(next);
      this.state = next;
      return clone(nextActuation);
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(state: DurableState): Promise<void> {
    const directory = dirname(this.file);
    const temporary = join(directory, `.controlled-actuations-${process.pid}-${randomUUID()}.tmp`);
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      // Windows readers can briefly deny replacement; retry publication of the same snapshot only.
      const retryDelays = [10, 20, 40, 80, 160];
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temporary, this.file);
          break;
        } catch (error: unknown) {
          const retryDelay = process.platform === "win32"
            && ["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "")
            ? retryDelays[attempt] : undefined;
          if (retryDelay === undefined) throw error;
          await delay(retryDelay);
        }
      }
      await chmod(this.file, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export interface ControlledActuationServiceOptions {
  readonly storageRoot?: string;
  readonly authorizationStore?: ActuationAuthorizationStore;
  readonly taskContextService?: TaskContextService;
  readonly executionContextService?: ExecutionContextService;
  readonly sessionStore?: Pick<SessionStore, "listSessions">;
  readonly desktopThreadBindingStore?: Pick<DesktopThreadBindingStore, "load">;
  readonly adapter?: ExecutionBackend;
}

export class ControlledActuationService {
  public readonly storageRoot: string;
  public readonly authorizationStore: ActuationAuthorizationStore;
  public readonly adapter: ExecutionBackend;
  private readonly tasks: TaskContextService;
  private readonly executions: ExecutionContextService;
  private readonly sessions: Pick<SessionStore, "listSessions">;
  private readonly desktopBindings: Pick<DesktopThreadBindingStore, "load">;

  public constructor(
    private readonly registry: WorkspaceRegistry,
    options: ControlledActuationServiceOptions = {},
  ) {
    this.storageRoot = resolve(
      options.storageRoot
        ?? options.authorizationStore?.storageRoot
        ?? options.executionContextService?.storageRoot
        ?? options.taskContextService?.storageRoot
        ?? defaultTaskContextStorageRoot(),
    );
    this.authorizationStore = options.authorizationStore ?? new ActuationAuthorizationStore(this.storageRoot);
    this.tasks = options.taskContextService ?? new TaskContextService(this.storageRoot);
    this.executions = options.executionContextService ?? new ExecutionContextService(this.storageRoot);
    this.sessions = options.sessionStore ?? new SessionStore(this.storageRoot);
    this.desktopBindings = options.desktopThreadBindingStore ?? new DesktopThreadBindingStore(this.storageRoot);
    this.adapter = options.adapter ?? new CodexExecutionAdapter(this.registry, { storageRoot: this.storageRoot });
    for (const dependency of [
      this.authorizationStore.storageRoot,
      this.tasks.storageRoot,
      this.executions.storageRoot,
    ]) {
      if (resolve(dependency) !== this.storageRoot) {
        throw new Error("Controlled Actuation dependencies must share one storage root.");
      }
    }
  }

  public restore(): Promise<void> {
    return this.authorizationStore.restore();
  }

  public getAuthorization(authorizationId: string): Promise<ActuationAuthorization | null> {
    return this.authorizationStore.getAuthorization(authorizationId);
  }

  public getActuation(actuationId: string): Promise<ControlledActuation | null> {
    return this.authorizationStore.getActuation(actuationId);
  }

  public async authorize(input: ActuationAuthorizationInput): Promise<ActuationAuthorization> {
    const parsed = actuationAuthorizationInputSchema.parse(input);
    await this.validateTarget(parsed);
    return this.authorizationStore.createAuthorization(parsed);
  }

  public async actuate(request: ControlledActuationRequest): Promise<ControlledActuationResult> {
    const parsed = controlledActuationRequestSchema.parse(request);
    const key = `${this.storageRoot}\0${parsed.actuation_id}\0${parsed.authorization_id}`;
    const pending = actuationFlights.get(key);
    if (pending !== undefined) {
      return pending.then((result) => ({ ...result, accepted: "existing" as const }));
    }

    const operation = this.actuateOnce(parsed);
    actuationFlights.set(key, operation);
    void operation.finally(() => {
      if (actuationFlights.get(key) === operation) actuationFlights.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  private async actuateOnce(request: ControlledActuationRequest): Promise<ControlledActuationResult> {
    const authorization = await this.authorizationStore.getAuthorization(request.authorization_id);
    if (authorization === null) {
      throw new Error(`Authorization "${request.authorization_id}" was not found.`);
    }
    if (authorization.replay_blocked_reason !== undefined) {
      throw new ControlledActuationConflictError(`Legacy authorization cannot be replayed: ${authorization.replay_blocked_reason}`);
    }
    if (authorization.actuation_id !== request.actuation_id) {
      throw new ControlledActuationConflictError(
        `Authorization "${request.authorization_id}" is bound to another actuation.`,
      );
    }

    const existing = await this.authorizationStore.getActuation(request.actuation_id);
    if (existing !== null) {
      if (existing.authorization_id !== request.authorization_id) {
        throw new ControlledActuationConflictError(
          `Actuation "${request.actuation_id}" is bound to another authorization.`,
        );
      }
      await this.validateTarget(authorization, true);
      return this.recoverExisting(authorization, existing);
    }

    await this.validateTarget(authorization);
    const reservation = await this.authorizationStore.reserveActuation(request);
    if (reservation.accepted === "existing") {
      await this.validateTarget(reservation.authorization, true);
      return this.recoverExisting(reservation.authorization, reservation.actuation);
    }
    return this.startReserved(reservation.authorization, reservation.actuation);
  }

  private async startReserved(
    authorization: ActuationAuthorization,
    actuation: ControlledActuation,
  ): Promise<ControlledActuationResult> {
    let started: ExecutionStartResult;
    try {
      const request: ExecutionBackendStartRequest = {
        ...(authorization.goal_id === undefined ? {} : { goal_id: authorization.goal_id }),
        ...(authorization.execution_mode === "interactive"
          ? { actuation_id: authorization.actuation_id }
          : {}),
        workspace_id: authorization.workspace_id,
        task_id: authorization.task_id,
        execution_id: authorization.execution_id,
        instruction: authorization.instruction,
        execution_mode: authorization.execution_mode,
        ...(authorization.model_id === undefined ? {} : { model_id: authorization.model_id }),
        ...(authorization.reasoning_effort === undefined
          ? {}
          : { reasoning_effort: authorization.reasoning_effort }),
        ...(authorization.backend === undefined ? {} : { backend: authorization.backend }),
        ...(authorization.thread_id === undefined ? {} : { thread_id: authorization.thread_id }),
      };
      started = await this.adapter.start(request);
    } catch (error: unknown) {
      if (error instanceof ExecutionLaunchIndeterminateError
        || (error instanceof Error && error.cause instanceof ExecutionLaunchIndeterminateError)) {
        await this.authorizationStore.setActuationStatus(actuation.actuation_id, "starting", errorMessage(error));
        throw error;
      }
      await this.markFailed(actuation.actuation_id, error);
      // Interactive launch can fail before a backend materializes its Execution (IPC/bootstrap
      // or fallback preparation). Keep the reserved identity queryable and terminal in that case.
      if (authorization.execution_mode === "interactive") {
        const current = await this.executions.getExecutionContext(
          authorization.workspace_id, authorization.task_id, authorization.execution_id,
        );
        const failure = { status: "failed" as const, summary: errorMessage(error).slice(0, 4_000) };
        if (current === null) {
          await this.executions.createExecutionContext({
            workspace_id: authorization.workspace_id,
            task_id: authorization.task_id,
            execution_id: authorization.execution_id,
            ...failure,
          });
        } else if (current.status === "running") {
          await this.executions.updateExecutionContext(
            authorization.workspace_id, authorization.task_id, authorization.execution_id, failure,
          );
        }
      }
      throw error;
    }

    const parsed = controlledActuationStartResultSchema.safeParse(started);
    if (!parsed.success || parsed.data.execution_id !== authorization.execution_id) {
      const error = new Error("Codex adapter returned an invalid execution identity.");
      await this.markFailed(actuation.actuation_id, error);
      throw error;
    }

    let completed: ControlledActuation;
    try {
      completed = await this.authorizationStore.setActuationStatus(actuation.actuation_id, "started");
    } catch (error: unknown) {
      throw new Error(
        `Actuation "${actuation.actuation_id}" started but its state could not be persisted: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    return {
      ...parsed.data,
      actuation: completed,
    };
  }

  private async recoverExisting(
    authorization: ActuationAuthorization,
    actuation: ControlledActuation,
  ): Promise<ControlledActuationResult> {
    if (actuation.status === "failed") {
      throw new Error(
        `Actuation "${actuation.actuation_id}" has already failed; refusing to spawn another process.`,
      );
    }
    const execution = await this.executions.getExecutionContext(
      authorization.workspace_id,
      authorization.task_id,
      authorization.execution_id,
    );
    if (execution === null) {
      throw new Error(
        `Execution "${authorization.execution_id}" is not recoverable; refusing to spawn another process.`,
      );
    }
    if (execution.process_id === undefined) {
      if (!await this.hasDesktopLaunchEvidence(authorization, execution)) {
        throw new Error(
          `Execution "${authorization.execution_id}" has an ambiguous launch state; refusing to spawn another process.`,
        );
      }
    }
    const recoveredActuation = actuation.status === "starting"
      ? await this.authorizationStore.setActuationStatus(actuation.actuation_id, "started")
      : actuation;
    return {
      execution_id: execution.execution_id,
      ...(execution.process_id === undefined ? {} : { process_id: execution.process_id }),
      started_at: execution.started_at,
      accepted: "existing",
      actuation: recoveredActuation,
    };
  }

  /**
   * Desktop executions own no LRM process, so a missing process_id is only acceptable when the
   * full durable Desktop launch evidence is present: a matching goal/task Session whose thread_id
   * matches the persisted DesktopThreadBinding for that Session.
   */
  private async hasDesktopLaunchEvidence(
    authorization: ActuationAuthorization,
    execution: ExecutionContext,
  ): Promise<boolean> {
    if (authorization.goal_id === undefined) return false;
    const sessions = (await this.sessions.listSessions()).filter((session) =>
      session.goal_id === authorization.goal_id
      && session.task_id === authorization.task_id
      && session.backend_type === "desktop_codex_app");
    if (sessions.length !== 1) return false;
    const session = sessions[0]!;
    if (session.thread_id === undefined || session.thread_id.trim() === "") return false;
    let binding;
    try {
      binding = await this.desktopBindings.load(authorization.workspace_id, session.session_id);
    } catch {
      return false;
    }
    return binding !== undefined
      && binding.workspace_id === authorization.workspace_id
      && binding.task_id === authorization.task_id
      && binding.session_id === session.session_id
      && binding.backend_identity === "desktop_codex_app"
      && binding.target_thread_id === session.thread_id
      && execution.task_id === authorization.task_id
      && execution.workspace_id === authorization.workspace_id;
  }

  private async markFailed(actuationId: string, error: unknown): Promise<void> {
    try {
      await this.authorizationStore.setActuationStatus(actuationId, "failed", errorMessage(error));
    } catch (persistError: unknown) {
      throw new Error(
        `Codex execution launch failed (${errorMessage(error)}); actuation failure could not be persisted.`,
        { cause: persistError },
      );
    }
  }

  private async validateTarget(
    target: ActuationAuthorizationInput,
    allowTerminalExecution = false,
  ): Promise<void> {
    this.registry.resolve(target.workspace_id);
    const task = await this.tasks.getTaskContext(target.task_id);
    if (task === null) throw new Error(`Task context "${target.task_id}" was not found.`);
    if (task.workspace_id !== target.workspace_id) {
      throw new Error("Task context does not belong to the requested workspace.");
    }

    const execution = await this.executions.getExecutionContext(
      target.workspace_id,
      target.task_id,
      target.execution_id,
    );
    // A new execution is materialized by CodexExecutionAdapter after the durable actuation reservation.
    if (execution === null) return;
    if (execution.execution_id !== target.execution_id
      || execution.task_id !== target.task_id
      || execution.workspace_id !== target.workspace_id) {
      throw new Error("Execution context does not belong to the requested workspace and task.");
    }
    if (execution.status !== "running") {
      if (allowTerminalExecution) return;
      throw new Error(
        `Execution "${target.execution_id}" is already terminal; refusing to actuate it again.`,
      );
    }
    if (execution.process_id === undefined) {
      const authorization = target.goal_id === undefined
        ? null
        : await this.authorizationStore.getAuthorizationByActuation(target.actuation_id);
      if (authorization === null || !await this.hasDesktopLaunchEvidence(authorization, execution)) {
        throw new Error(
          `Execution "${target.execution_id}" has an ambiguous launch state; refusing to actuate it.`,
        );
      }
    }
  }
}
