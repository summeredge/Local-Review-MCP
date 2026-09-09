import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ExecutionContextService } from "../context/execution-service.js";
import {
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { TaskContextService } from "../context/service.js";
import { isReservedWindowsName } from "../workspace/path.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import {
  CodexExecutionAdapter,
  type CodexExecutionStartResult,
  type CodexExecutionStartRequest,
} from "./codex-execution-adapter.js";

const STATE_VERSION = 1;
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
  readonly workspace_id: string;
  readonly task_id: string;
  readonly execution_id: string;
  readonly instruction: string;
}

export interface ActuationAuthorization extends ActuationAuthorizationInput {
  readonly authorization_id: string;
  readonly status: "authorized" | "consumed";
  readonly created_at: string;
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
}

export interface ControlledActuationResult extends CodexExecutionStartResult {
  readonly actuation: ControlledActuation;
}

export const actuationAuthorizationInputSchema = z.object({
  actuation_id: actuationIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  instruction: instructionSchema,
}).strict();

export const actuationAuthorizationSchema = actuationAuthorizationInputSchema.extend({
  authorization_id: authorizationIdSchema,
  status: z.enum(["authorized", "consumed"]),
  created_at: timestampSchema,
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

  for (const authorization of state.authorizations) {
    const actuation = actuationsById.get(authorization.actuation_id);
    if (authorization.status === "authorized" && actuation !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authorized authorization already has an actuation record",
      });
    }
    if (authorization.status === "consumed"
      && (actuation === undefined || actuation.authorization_id !== authorization.authorization_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "consumed authorization does not have its actuation record",
      });
    }
  }

  for (const actuation of state.actuations) {
    const authorization = authorizationsById.get(actuation.authorization_id);
    if (authorization === undefined
      || authorization.status !== "consumed"
      || authorization.actuation_id !== actuation.actuation_id
      || authorization.workspace_id !== actuation.workspace_id
      || authorization.task_id !== actuation.task_id
      || authorization.execution_id !== actuation.execution_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "actuation identity does not match its authorization",
      });
    }
  }
});

export const controlledActuationStartResultSchema = z.object({
  execution_id: executionIdSchema,
  process_id: z.number().int().positive(),
  started_at: timestampSchema,
  accepted: z.enum(["new", "existing"]),
}).strict();

type DurableState = z.infer<typeof stateSchema>;

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
          "controlled actuation state could not be restored",
          { cause: error },
        );
      }
      try {
        this.state = stateSchema.parse(JSON.parse(raw) as unknown);
      } catch (error: unknown) {
        throw new ControlledActuationUnavailableError(
          "controlled actuation state could not be restored",
          { cause: error },
        );
      }
    });
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
  ): Promise<ControlledActuation> {
    await this.restore();
    const parsedId = actuationIdSchema.parse(actuationId);
    const parsedStatus = z.enum(["starting", "started", "failed"]).parse(status);
    return this.exclusive(async () => {
      const current = this.state.actuations.find((candidate) => candidate.actuation_id === parsedId);
      if (current === undefined) throw new Error(`Actuation "${parsedId}" was not found.`);
      if (current.status === parsedStatus) return clone(current);
      if (current.status !== "starting") {
        throw new ControlledActuationConflictError(
          `Actuation "${parsedId}" is already ${current.status}.`,
        );
      }
      const nextActuation = controlledActuationSchema.parse({
        ...current,
        status: parsedStatus,
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
      await rename(temporary, this.file);
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
  readonly adapter?: Pick<CodexExecutionAdapter, "start">;
}

export class ControlledActuationService {
  public readonly storageRoot: string;
  public readonly authorizationStore: ActuationAuthorizationStore;
  public readonly adapter: Pick<CodexExecutionAdapter, "start">;
  private readonly tasks: TaskContextService;
  private readonly executions: ExecutionContextService;

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
    let started: CodexExecutionStartResult;
    try {
      const request: CodexExecutionStartRequest = {
        workspace_id: authorization.workspace_id,
        task_id: authorization.task_id,
        execution_id: authorization.execution_id,
        instruction: authorization.instruction,
      };
      started = await this.adapter.start(request);
    } catch (error: unknown) {
      await this.markFailed(actuation.actuation_id, error);
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
        `Actuation "${actuation.actuation_id}" started but its state could not be persisted.`,
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
      throw new Error(
        `Execution "${authorization.execution_id}" has an ambiguous launch state; refusing to spawn another process.`,
      );
    }
    const recoveredActuation = actuation.status === "starting"
      ? await this.authorizationStore.setActuationStatus(actuation.actuation_id, "started")
      : actuation;
    return {
      execution_id: execution.execution_id,
      process_id: execution.process_id,
      started_at: execution.started_at,
      accepted: "existing",
      actuation: recoveredActuation,
    };
  }

  private async markFailed(actuationId: string, error: unknown): Promise<void> {
    try {
      await this.authorizationStore.setActuationStatus(actuationId, "failed");
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
      throw new Error(
        `Execution "${target.execution_id}" has an ambiguous launch state; refusing to actuate it.`,
      );
    }
  }
}
