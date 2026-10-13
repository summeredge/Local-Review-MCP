import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  conversationIdSchema,
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { TaskContextService } from "../context/service.js";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import type { TaskStatus } from "../context/types.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { reasoningEffortValueSchema } from "../models/model-catalog.js";
import { migrateLegacyModelIdFields } from "../models/model-resolver.js";
import {
  AutoIterationService,
  autoIterationIdSchema,
  autoIterationSchema,
  buildAutoIterationInstruction,
  type AutoIteration,
} from "./auto-iteration.js";
import {
  ActuationAuthorizationStore,
  ControlledActuationService,
  type ActuationAuthorization,
  type ControlledActuation,
} from "./controlled-actuation.js";
import { executionModeSchema } from "./execution-service.js";
import { backupLegacyState, stateRestoreDiagnostic } from "./state-migration.js";
import { ExtensionDeliveryService, retryableNotSent } from "./extension-delivery.js";

const STATE_VERSION = 2;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const timestampSchema = z.string().datetime({ offset: true });
const instructionItemSchema = z.string().min(1).max(16_000);

export const goalIdSchema = z.string().min(1).max(128).regex(ID_PATTERN);
export const phaseIdSchema = z.string().min(1).max(128).regex(ID_PATTERN);
export const goalOrchestrationStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "human_required",
]);

export const goalTaskPlanSchema = z.object({
  task_id: taskIdSchema,
  goal: instructionItemSchema,
  requirements: z.array(instructionItemSchema).min(1).max(1_000),
  acceptance_criteria: z.array(instructionItemSchema).min(1).max(1_000),
  max_iterations: z.number().int().min(1).max(10_000),
}).strict();

export const createGoalInputSchema = z.object({
  goal_id: goalIdSchema,
  workspace_id: workspaceIdSchema,
  conversation_id: conversationIdSchema,
  execution_mode: executionModeSchema,
  model_id: z.string().min(1).max(256).optional(),
  reasoning_effort: reasoningEffortValueSchema.optional(),
  phases: z.array(z.object({
    phase_id: phaseIdSchema,
    objective: instructionItemSchema,
    tasks: z.array(goalTaskPlanSchema).min(1).max(1_000),
  }).strict()).min(1).max(1_000),
}).strict().superRefine((goal, context) => {
  const phaseIds = new Set<string>();
  const taskIds = new Set<string>();
  goal.phases.forEach((phase, phaseIndex) => {
    if (phaseIds.has(phase.phase_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phases", phaseIndex, "phase_id"],
        message: "phase_id is duplicated",
      });
    }
    phaseIds.add(phase.phase_id);
    phase.tasks.forEach((task, taskIndex) => {
      if (taskIds.has(task.task_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phases", phaseIndex, "tasks", taskIndex, "task_id"],
          message: "task_id is duplicated",
        });
      }
      taskIds.add(task.task_id);
    });
  });
});

export const startGoalInputSchema = z.object({ goal_id: goalIdSchema }).strict();

export const startReviewGoalInputSchema = z.object({
  goal_id: goalIdSchema,
  phase_id: phaseIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  conversation_id: conversationIdSchema,
  execution_id: executionIdSchema,
  title: instructionItemSchema,
  goal: instructionItemSchema,
  requirements: z.array(instructionItemSchema).min(1).max(1_000),
  acceptance_criteria: z.array(instructionItemSchema).min(1).max(1_000),
  max_iterations: z.number().int().min(1).max(10_000),
}).strict();

const phaseSchema = z.object({
  phase_id: phaseIdSchema,
  objective: instructionItemSchema,
  tasks: z.array(goalTaskPlanSchema).min(1).max(1_000),
  status: goalOrchestrationStatusSchema,
}).strict();

export const humanRequiredInfoSchema = z.object({
  goal_id: goalIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  phase_id: phaseIdSchema,
  stage: z.string(),
  terminal_reason: z.string(),
  terminal_summary: z.string(),
  completed_work: z.string(),
  required_action: z.string(),
  review_result_id: z.string().optional(),
}).strict();

export const goalOrchestrationSchema = z.object({
  goal_id: goalIdSchema,
  workspace_id: workspaceIdSchema,
  conversation_id: conversationIdSchema,
  execution_mode: executionModeSchema,
  model_id: z.string().min(1).max(256).optional(),
  reasoning_effort: reasoningEffortValueSchema.optional(),
  review_only: z.boolean().optional(),
  error: z.string().min(1).max(4_000).optional(),
  human_required_info: humanRequiredInfoSchema.optional(),
  phases: z.array(phaseSchema).min(1).max(1_000),
  status: goalOrchestrationStatusSchema,
  current_phase_id: phaseIdSchema.optional(),
  current_task_id: taskIdSchema.optional(),
  execution_id: executionIdSchema.optional(),
  actuation_id: z.string().min(1).max(128).regex(ID_PATTERN).optional(),
  loop_id: autoIterationIdSchema.optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict().superRefine((goal, context) => {
  const checkpoint = [
    goal.current_phase_id,
    goal.current_task_id,
    goal.execution_id,
    goal.actuation_id,
    goal.loop_id,
  ];
  const checkpointCount = checkpoint.filter((value) => value !== undefined).length;
  if (goal.status === "pending" && checkpointCount !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "pending goal has an active checkpoint" });
  }
  if (goal.status !== "pending" && checkpointCount !== checkpoint.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "active or terminal goal checkpoint is incomplete" });
  }

  const phaseIds = new Set<string>();
  const taskIds = new Set<string>();
  goal.phases.forEach((phase, phaseIndex) => {
    if (phaseIds.has(phase.phase_id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["phases", phaseIndex, "phase_id"], message: "phase_id is duplicated" });
    }
    phaseIds.add(phase.phase_id);
    phase.tasks.forEach((task, taskIndex) => {
      if (taskIds.has(task.task_id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["phases", phaseIndex, "tasks", taskIndex, "task_id"], message: "task_id is duplicated" });
      }
      taskIds.add(task.task_id);
    });
  });

  if (goal.status === "pending") {
    if (goal.phases.some((phase) => phase.status !== "pending")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "pending goal has a non-pending phase" });
    }
    return;
  }
  const phaseIndex = goal.phases.findIndex((phase) => phase.phase_id === goal.current_phase_id);
  const phase = goal.phases[phaseIndex];
  if (phase === undefined || !phase.tasks.some((task) => task.task_id === goal.current_task_id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "goal checkpoint does not reference a planned task" });
    return;
  }
  if (goal.status === "completed") {
    if (goal.phases.some((candidate) => candidate.status !== "completed")) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "completed goal has an incomplete phase" });
    }
    return;
  }
  goal.phases.forEach((candidate, index) => {
    const expected = index < phaseIndex
      ? "completed"
      : index > phaseIndex
        ? "pending"
        : goal.status;
    if (candidate.status !== expected) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["phases", index, "status"], message: "phase status does not match goal progress" });
    }
  });
});

export const goalOrchestrationStateSchema = z.object({
  schema_version: z.literal(STATE_VERSION),
  goals: z.array(goalOrchestrationSchema).max(10_000),
}).strict().superRefine((state, context) => {
  const ids = new Set<string>();
  state.goals.forEach((goal, index) => {
    if (ids.has(goal.goal_id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["goals", index, "goal_id"], message: "goal_id is duplicated" });
    }
    ids.add(goal.goal_id);
  });
});

export type CreateGoalInput = z.input<typeof createGoalInputSchema>;
export type StartGoalInput = z.input<typeof startGoalInputSchema>;
export type StartReviewGoalInput = z.input<typeof startReviewGoalInputSchema>;
export type GoalTaskPlan = z.infer<typeof goalTaskPlanSchema>;
export type GoalOrchestration = z.infer<typeof goalOrchestrationSchema>;

export const goalOrchestrationStateFile = (storageRoot: string): string =>
  join(resolve(storageRoot), "control-plane", "goal-orchestrations.json");

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

function stableIdentity(kind: string, goalId: string, phaseId: string, taskId: string): string {
  const digest = createHash("sha256")
    .update(`${goalId}\0${phaseId}\0${taskId}\0${kind}`)
    .digest("hex")
    .slice(0, 32);
  return `goal-${kind}-${digest}`;
}

function planIdentity(goal: GoalOrchestration): z.infer<typeof createGoalInputSchema> {
  return createGoalInputSchema.parse({
    goal_id: goal.goal_id,
    workspace_id: goal.workspace_id,
    conversation_id: goal.conversation_id,
    execution_mode: goal.execution_mode,
    ...(goal.model_id === undefined ? {} : { model_id: goal.model_id }),
    ...(goal.reasoning_effort === undefined ? {} : { reasoning_effort: goal.reasoning_effort }),
    phases: goal.phases.map(({ status: _status, ...phase }) => phase),
  });
}

export class GoalOrchestrationConflictError extends Error {}
export class GoalOrchestrationUnavailableError extends Error {}

class GoalOrchestrationStore {
  private readonly file: string;
  private state: z.infer<typeof goalOrchestrationStateSchema> = { schema_version: STATE_VERSION, goals: [] };
  private restorePromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(storageRoot: string) {
    this.file = goalOrchestrationStateFile(storageRoot);
  }

  public restore(): Promise<void> {
    this.restorePromise ??= this.exclusive(async () => {
      let raw: string;
      try {
        raw = await readFile(this.file, "utf8");
      } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") return;
        throw new GoalOrchestrationUnavailableError(`goal orchestration state could not be restored: ${stateRestoreDiagnostic(this.file, error)}`, { cause: error });
      }
      try {
        const source = migrateLegacyModelIdFields(JSON.parse(raw) as unknown);
        const legacy = typeof source === "object" && source !== null && "schema_version" in source && source.schema_version === 1;
        let migrated = source;
        if (legacy) {
          const data = z.object({ goals: z.array(z.unknown()) }).passthrough().parse(source);
          migrated = { ...data, schema_version: STATE_VERSION, goals: data.goals.map((goal) =>
            typeof goal === "object" && goal !== null && !("execution_mode" in goal)
              ? { ...goal, execution_mode: "batch" } : goal) };
        }
        const next = goalOrchestrationStateSchema.parse(migrated);
        if (legacy) { await backupLegacyState(this.file, raw); await this.persist(next); }
        this.state = next;
      } catch (error: unknown) {
        throw new GoalOrchestrationUnavailableError(`goal orchestration state could not be restored: ${stateRestoreDiagnostic(this.file, error)}`, { cause: error });
      }
    }).catch((error: unknown) => { this.restorePromise = null; throw error; });
    return this.restorePromise;
  }

  public async get(goalId: string): Promise<GoalOrchestration | null> {
    await this.restore();
    const parsedId = goalIdSchema.parse(goalId);
    return this.exclusive(async () => {
      const goal = this.state.goals.find((candidate) => candidate.goal_id === parsedId);
      return goal === undefined ? null : clone(goal);
    });
  }

  public async list(): Promise<GoalOrchestration[]> {
    await this.restore();
    return this.exclusive(async () => this.state.goals.map(clone));
  }

  public async put(goal: GoalOrchestration): Promise<GoalOrchestration> {
    await this.restore();
    const parsed = goalOrchestrationSchema.parse(goal);
    return this.exclusive(async () => {
      const goals = this.state.goals.some((candidate) => candidate.goal_id === parsed.goal_id)
        ? this.state.goals.map((candidate) => candidate.goal_id === parsed.goal_id ? parsed : candidate)
        : [...this.state.goals, parsed];
      const next = goalOrchestrationStateSchema.parse({ schema_version: STATE_VERSION, goals });
      await this.persist(next);
      this.state = next;
      return clone(parsed);
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(state: z.infer<typeof goalOrchestrationStateSchema>): Promise<void> {
    const directory = dirname(this.file);
    const temporary = join(directory, `.goal-orchestrations-${process.pid}-${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
      await chmod(this.file, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

type AuthorizationReader = Pick<
  ActuationAuthorizationStore,
  "getAuthorization" | "getAuthorizationByActuation" | "getAuthorizationByExecution"
> & { readonly storageRoot?: string };
type ControlledActuationPort = Pick<ControlledActuationService, "authorize" | "actuate" | "getActuation"> & {
  readonly authorizationStore?: AuthorizationReader;
  readonly storageRoot?: string;
};
type AutoIterationPort = Pick<AutoIterationService, "start" | "advance" | "getLoop"> & {
  readonly storageRoot?: string;
  readonly extensionDeliveries?: ExtensionDeliveryService;
};

export interface GoalOrchestrationServiceOptions {
  readonly storageRoot?: string;
  readonly taskContextService?: TaskContextService;
  readonly executionContextService?: ExecutionContextService;
  readonly authorizationStore?: AuthorizationReader;
  readonly controlledActuation?: ControlledActuationPort;
  readonly autoIteration?: AutoIterationPort;
  readonly extensionDeliveries?: ExtensionDeliveryService;
}

export class GoalOrchestrationService {
  public readonly storageRoot: string;
  private readonly store: GoalOrchestrationStore;
  private readonly tasks: TaskContextService;
  private readonly executions: ExecutionContextService;
  private readonly authorizations: AuthorizationReader;
  private readonly controlled: ControlledActuationPort;
  private readonly auto: AutoIterationPort;
  private readonly deliveries: ExtensionDeliveryService;
  private readonly operations = new Map<string, Promise<void>>();
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  public constructor(
    private readonly registry: WorkspaceRegistry,
    options: GoalOrchestrationServiceOptions = {},
  ) {
    this.storageRoot = resolve(
      options.storageRoot
        ?? options.executionContextService?.storageRoot
        ?? options.taskContextService?.storageRoot
        ?? defaultTaskContextStorageRoot(),
    );
    this.tasks = options.taskContextService ?? new TaskContextService(this.storageRoot);
    this.executions = options.executionContextService ?? new ExecutionContextService(this.storageRoot);
    this.controlled = options.controlledActuation ?? new ControlledActuationService(registry, {
      storageRoot: this.storageRoot,
      taskContextService: this.tasks,
      executionContextService: this.executions,
    });
    this.authorizations = options.authorizationStore
      ?? this.controlled.authorizationStore
      ?? new ActuationAuthorizationStore(this.storageRoot);
    this.auto = options.autoIteration ?? new AutoIterationService(registry, {
      storageRoot: this.storageRoot,
      taskContextService: this.tasks,
      executionContextService: this.executions,
      controlledActuation: this.controlled,
      authorizationStore: this.authorizations,
    });
    this.store = new GoalOrchestrationStore(this.storageRoot);
    this.deliveries = options.extensionDeliveries ?? this.auto.extensionDeliveries ?? new ExtensionDeliveryService(this.storageRoot);
    for (const dependency of [
      this.tasks.storageRoot,
      this.executions.storageRoot,
      this.authorizations.storageRoot,
      this.controlled.storageRoot,
      this.auto.storageRoot,
      this.deliveries.storageRoot,
    ]) {
      if (dependency !== undefined && resolve(dependency) !== this.storageRoot) {
        throw new Error("Goal Orchestration dependencies must share one storage root.");
      }
    }
  }

  public restore(): Promise<void> {
    return this.store.restore();
  }

  public dispose(): void {
    this.disposed = true;
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
  }

  private scheduleRecovery(goalId: string): void {
    if (this.disposed || this.recoveryTimers.has(goalId)) return;
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(goalId);
      void this.advanceGoal(goalId).catch((error: unknown) => {
        console.warn(`Goal orchestration recovery failed for "${goalId}"`, errorMessage(error));
        this.scheduleRecovery(goalId);
      });
    }, 1_000);
    timer.unref();
    this.recoveryTimers.set(goalId, timer);
  }

  public getGoal(goalId: string): Promise<GoalOrchestration | null> {
    return this.store.get(goalId);
  }

  public listGoals(): Promise<GoalOrchestration[]> {
    return this.store.list();
  }

  public createGoal(input: CreateGoalInput): Promise<GoalOrchestration> {
    const parsed = createGoalInputSchema.parse(input);
    return this.serial(parsed.goal_id, async () => {
      this.registry.resolve(parsed.workspace_id);
      const existing = await this.store.get(parsed.goal_id);
      if (existing !== null) {
        if (JSON.stringify(planIdentity(existing)) !== JSON.stringify(parsed)) {
          throw new GoalOrchestrationConflictError(`Goal "${parsed.goal_id}" is bound to another plan.`);
        }
        return existing;
      }
      const timestamp = new Date().toISOString();
      return this.store.put(goalOrchestrationSchema.parse({
        ...parsed,
        phases: parsed.phases.map((phase) => ({ ...phase, status: "pending" as const })),
        status: "pending",
        created_at: timestamp,
        updated_at: timestamp,
      }));
    });
  }

  public async getStartEvidence(goalId: string): Promise<{ status: "started" | "failed" | "indeterminate"; error?: string }> {
    const goal = await this.requiredGoal(goalId);
    const phase = goal.phases[0]!;
    const task = phase.tasks[0]!;
    const actuationId = stableIdentity("actuation", goalId, phase.phase_id, task.task_id);
    const executionId = stableIdentity("execution", goalId, phase.phase_id, task.task_id);
    const [authorization, actuation, execution] = await Promise.all([
      this.authorizations.getAuthorizationByActuation(actuationId),
      this.controlled.getActuation(actuationId),
      this.executions.getExecutionContext(goal.workspace_id, task.task_id, executionId),
    ]);
    if (authorization !== null && actuation !== null
      && authorization.actuation_id === actuationId && actuation.actuation_id === actuationId
      && authorization.goal_id === goalId && authorization.workspace_id === goal.workspace_id
      && authorization.task_id === task.task_id && authorization.execution_id === executionId
      && actuation.authorization_id === authorization.authorization_id
      && actuation.workspace_id === goal.workspace_id && actuation.task_id === task.task_id
      && actuation.execution_id === executionId) {
      if (actuation.status === "started" && execution !== null
        && execution.workspace_id === goal.workspace_id && execution.task_id === task.task_id
        && execution.execution_id === executionId) return { status: "started" };
      if (actuation.status === "failed") return { status: "failed", error: actuation.error ?? execution?.summary ?? goal.error ?? "Backend launch failed" };
    }
    return { status: "indeterminate", error: actuation?.error ?? goal.error ?? "Durable launch confirmation is missing or inconsistent" };
  }

  public startGoal(input: StartGoalInput): Promise<GoalOrchestration> {
    const parsed = startGoalInputSchema.parse(input);
    return this.serial(parsed.goal_id, () => this.startOnce(parsed.goal_id));
  }

  public startReviewGoal(input: StartReviewGoalInput): Promise<GoalOrchestration> {
    const parsed = startReviewGoalInputSchema.parse(input);
    return this.serial(parsed.goal_id, () => this.startReviewGoalOnce(parsed));
  }

  public createReviewGoal(input: StartReviewGoalInput): Promise<GoalOrchestration> {
    return this.startReviewGoal(input);
  }

  public advanceGoal(goalId: string): Promise<GoalOrchestration> {
    const parsedId = goalIdSchema.parse(goalId);
    return this.serial(parsedId, () => this.advanceOnce(parsedId));
  }

  public async onAutoIterationTerminal(loop: AutoIteration): Promise<void> {
    const parsed = autoIterationSchema.parse(loop);
    const goals = await this.store.list();
    await Promise.all(goals
      .filter((goal) => goal.status === "running" && goal.loop_id === parsed.loop_id)
      .map(async (goal) => {
        try {
          await this.advanceGoal(goal.goal_id);
        } catch (error: unknown) {
          console.warn(`Goal terminal notification failed for "${goal.goal_id}"`, errorMessage(error));
        }
      }));
  }

  public async recover(): Promise<void> {
    const goals = await this.store.list();
    for (const goal of goals) {
      if (goal.status !== "running" && goal.status !== "human_required") continue;
      try {
        await this.advanceGoal(goal.goal_id);
      } catch (error: unknown) {
        console.warn(`Goal orchestration recovery failed for "${goal.goal_id}"`, errorMessage(error));
      }
    }
  }

  private async startOnce(goalId: string): Promise<GoalOrchestration> {
    let goal = await this.requiredGoal(goalId);
    if (goal.status === "completed" || goal.status === "failed" || goal.status === "human_required") return goal;
    if (goal.status === "pending") {
      const phase = goal.phases[0]!;
      goal = await this.checkpoint(goal, phase.phase_id, phase.tasks[0]!.task_id, {
        status: "running",
        phases: goal.phases.map((candidate, index) => ({
          ...candidate,
          status: index === 0 ? "running" as const : "pending" as const,
        })),
      });
    }
    return this.drive(goal);
  }

  private async startReviewGoalOnce(input: StartReviewGoalInput): Promise<GoalOrchestration> {
    this.registry.resolve(input.workspace_id);
    const task = await this.tasks.getTaskContext(input.task_id);
    if (task === null) throw new Error(`Task context "${input.task_id}" was not found.`);
    if (task.workspace_id !== input.workspace_id) {
      throw new Error("Task context does not belong to the requested workspace.");
    }
    if (task.conversation_id !== undefined && task.conversation_id !== input.conversation_id) {
      throw new Error("TaskContext conversation identity does not match the review Goal.");
    }

    const execution = await this.executions.getExecutionContext(
      input.workspace_id,
      input.task_id,
      input.execution_id,
    );
    if (execution === null) {
      throw new Error(`Execution context "${input.execution_id}" was not found.`);
    }
    if (execution.status !== "passed") {
      throw new Error(`Execution "${input.execution_id}" is not completed successfully.`);
    }

    const plan = createGoalInputSchema.parse({
      goal_id: input.goal_id,
      workspace_id: input.workspace_id,
      conversation_id: input.conversation_id,
      execution_mode: "batch",
      phases: [{
        phase_id: input.phase_id,
        objective: input.title,
        tasks: [{
          task_id: input.task_id,
          goal: input.goal,
          requirements: input.requirements,
          acceptance_criteria: input.acceptance_criteria,
          max_iterations: input.max_iterations,
        }],
      }],
    });
    let goal = await this.store.get(input.goal_id);
    if (goal !== null) {
      if (!goal.review_only || JSON.stringify(planIdentity(goal)) !== JSON.stringify(plan)
        || goal.execution_id !== input.execution_id) {
        throw new GoalOrchestrationConflictError(
          `Goal "${input.goal_id}" is bound to another review execution.`,
        );
      }
      if (goal.status === "completed" || goal.status === "failed" || goal.status === "human_required") {
        return goal;
      }
    } else {
      const timestamp = new Date().toISOString();
      goal = await this.store.put(goalOrchestrationSchema.parse({
        ...plan,
        review_only: true,
        phases: plan.phases.map((phase) => ({ ...phase, status: "running" as const })),
        status: "running",
        current_phase_id: input.phase_id,
        current_task_id: input.task_id,
        execution_id: input.execution_id,
        actuation_id: stableIdentity("actuation", input.goal_id, input.phase_id, input.task_id),
        loop_id: stableIdentity("loop", input.goal_id, input.phase_id, input.task_id),
        created_at: timestamp,
        updated_at: timestamp,
      }));
    }

    await this.auto.start({
      loop_id: goal.loop_id!,
      workspace_id: input.workspace_id,
      task_id: input.task_id,
      conversation_id: input.conversation_id,
      execution_id: input.execution_id,
      max_iterations: input.max_iterations,
    });
    return this.drive(await this.requiredGoal(input.goal_id));
  }

  private async advanceOnce(goalId: string): Promise<GoalOrchestration> {
    const goal = await this.requiredGoal(goalId);
    if (goal.status === "human_required") return this.notifyHumanRequired(goal);
    if (goal.status !== "running") return goal;
    return this.drive(goal);
  }

  private async drive(initial: GoalOrchestration): Promise<GoalOrchestration> {
    let goal = initial;
    const taskCount = goal.phases.reduce((count, phase) => count + phase.tasks.length, 0);
    for (let step = 0; step <= taskCount; step += 1) {
      if (goal.status !== "running") return goal;
      const active = this.activeTask(goal);
      let outcome: "active" | "completed" | "failed" | "human_required";
      try {
        outcome = await this.driveTask(goal, active.task);
      } catch (error: unknown) {
        console.warn(`Goal task recovery failed for "${goal.goal_id}/${active.task.task_id}"`, errorMessage(error));
        return this.finish(await this.update(goal, { error: errorMessage(error).slice(0, 4_000) }), "human_required");
      }
      if (outcome === "active") return this.requiredGoal(goal.goal_id);
      if (outcome === "failed" || outcome === "human_required") return this.finish(goal, outcome);
      goal = await this.completeTask(goal, active.phaseIndex, active.taskIndex);
    }
    throw new Error(`Goal "${goal.goal_id}" did not reach a stable state.`);
  }

  private async driveTask(
    goal: GoalOrchestration,
    task: GoalTaskPlan,
  ): Promise<"active" | "completed" | "failed" | "human_required"> {
    const actuationId = goal.actuation_id!;
    const executionId = goal.execution_id!;
    const loopId = goal.loop_id!;
    let [taskContext, authorization, actuation, execution, loop] = await Promise.all([
      this.tasks.getTaskContext(task.task_id),
      this.authorizations.getAuthorizationByActuation(actuationId),
      this.controlled.getActuation(actuationId),
      this.executions.getExecutionContext(goal.workspace_id, task.task_id, executionId),
      this.auto.getLoop(loopId),
    ]);
    const hasLowerEvidence = authorization !== null || actuation !== null || execution !== null || loop !== null;
    if (taskContext === null) {
      if (hasLowerEvidence) throw new Error("lower durable state exists without its TaskContext");
      try {
        taskContext = await this.tasks.createTaskContext({
          task_id: task.task_id,
          workspace_id: goal.workspace_id,
          conversation_id: goal.conversation_id,
        });
      } catch (error: unknown) {
        taskContext = await this.tasks.getTaskContext(task.task_id);
        if (taskContext === null) throw error;
      }
    }
    if (taskContext.workspace_id !== goal.workspace_id
      || (taskContext.conversation_id !== undefined && taskContext.conversation_id !== goal.conversation_id)) {
      throw new Error("TaskContext identity does not match the Goal task");
    }

    const instruction = buildAutoIterationInstruction({
      goal: task.goal,
      requirements: task.requirements,
      acceptance_criteria: task.acceptance_criteria,
    });
    this.assertEvidence(goal, task, instruction, authorization, actuation, loop);
    if (goal.review_only === true && authorization === null && actuation === null && loop === null) {
      if (execution === null) throw new Error("Review Goal Execution is missing.");
      loop = await this.auto.start({
        loop_id: loopId,
        workspace_id: goal.workspace_id,
        task_id: task.task_id,
        conversation_id: goal.conversation_id,
        execution_id: executionId,
        max_iterations: task.max_iterations,
      });
      this.assertLoop(goal, task, loop);
      return this.loopOutcome(loop);
    }
    if (loop !== null) {
      if (goal.review_only === true && authorization === null && actuation === null) {
        if (execution === null) throw new Error("Review Goal Execution is missing.");
        loop = await this.auto.advance(loopId);
        this.assertLoop(goal, task, loop);
        return this.loopOutcome(loop);
      }
      if (authorization === null || actuation === null || execution === null) {
        throw new Error("AutoIteration exists without its initial actuation evidence");
      }
      if (actuation.status === "failed") {
        throw new Error("AutoIteration exists for a failed initial actuation");
      }
      const taskTerminal = taskContext.status === "completed"
        ? "completed"
        : taskContext.status === "failed"
          ? "failed"
          : taskContext.status === "human_required"
            ? "human_required"
            : null;
      const loopTerminal = this.loopOutcome(loop);
      if (taskTerminal !== null && taskTerminal !== loopTerminal) {
        throw new Error("TaskContext terminal status conflicts with its AutoIteration");
      }
      loop = await this.auto.advance(loopId);
      this.assertLoop(goal, task, loop);
      return this.loopOutcome(loop);
    }
    if (taskContext.status === "completed" || taskContext.status === "failed"
      || taskContext.status === "human_required" || taskContext.status === "reviewing") {
      throw new Error("terminal or reviewing TaskContext exists without its AutoIteration");
    }
    if (execution !== null && actuation === null) {
      throw new Error("Execution exists without its durable actuation reservation");
    }
    if (actuation?.status === "failed") return "failed";
    if (authorization === null && (actuation !== null || execution !== null)) {
      throw new Error("execution or actuation exists without its authorization");
    }
    if (actuation !== null && execution === null) {
      throw new Error("actuation launch state is ambiguous");
    }

    if (authorization === null) {
      try {
        authorization = await this.controlled.authorize({
          actuation_id: actuationId,
          goal_id: goal.goal_id,
          workspace_id: goal.workspace_id,
          task_id: task.task_id,
          execution_id: executionId,
          instruction,
          execution_mode: goal.execution_mode,
          ...(goal.model_id === undefined ? {} : { model_id: goal.model_id }),
          ...(goal.reasoning_effort === undefined ? {} : { reasoning_effort: goal.reasoning_effort }),
        });
      } catch (error: unknown) {
        authorization = await this.authorizations.getAuthorizationByActuation(actuationId);
        if (authorization === null) throw error;
      }
      this.assertAuthorization(goal, task, instruction, authorization);
    }

    try {
      const result = await this.controlled.actuate({
        actuation_id: actuationId,
        authorization_id: authorization.authorization_id,
      });
      if (result.execution_id !== executionId
        || result.actuation.actuation_id !== actuationId
        || result.actuation.authorization_id !== authorization.authorization_id) {
        throw new Error("Controlled Actuation returned another identity");
      }
    } catch (error: unknown) {
      const observedActuation = await this.controlled.getActuation(actuationId);
      if (observedActuation?.status === "failed") return "failed";
      throw error;
    }

    try {
      loop = await this.auto.start({
        loop_id: loopId,
        workspace_id: goal.workspace_id,
        task_id: task.task_id,
        conversation_id: goal.conversation_id,
        execution_id: executionId,
        max_iterations: task.max_iterations,
      });
    } catch (error: unknown) {
      loop = await this.auto.getLoop(loopId);
      if (loop === null) throw error;
    }
    this.assertLoop(goal, task, loop);
    return this.loopOutcome(loop);
  }

  private assertEvidence(
    goal: GoalOrchestration,
    task: GoalTaskPlan,
    instruction: string,
    authorization: ActuationAuthorization | null,
    actuation: ControlledActuation | null,
    loop: AutoIteration | null,
  ): void {
    if (authorization !== null) this.assertAuthorization(goal, task, instruction, authorization);
    if (actuation !== null && (actuation.actuation_id !== goal.actuation_id
      || actuation.workspace_id !== goal.workspace_id
      || actuation.task_id !== task.task_id
      || actuation.execution_id !== goal.execution_id
      || actuation.authorization_id !== authorization?.authorization_id)) {
      throw new Error("Controlled Actuation identity does not match the Goal task");
    }
    if (loop !== null) this.assertLoop(goal, task, loop);
  }

  private assertAuthorization(
    goal: GoalOrchestration,
    task: GoalTaskPlan,
    instruction: string,
    authorization: ActuationAuthorization,
  ): void {
    if (authorization.actuation_id !== goal.actuation_id
      || (authorization.goal_id !== undefined && authorization.goal_id !== goal.goal_id)
      || authorization.workspace_id !== goal.workspace_id
      || authorization.task_id !== task.task_id
      || authorization.execution_id !== goal.execution_id
      || authorization.instruction !== instruction
      || authorization.execution_mode !== goal.execution_mode
      || authorization.model_id !== goal.model_id
      || authorization.reasoning_effort !== goal.reasoning_effort
      || (goal.execution_mode === "interactive" && authorization.goal_id !== goal.goal_id)) {
      throw new Error("Actuation authorization identity does not match the Goal task");
    }
  }

  private assertLoop(goal: GoalOrchestration, task: GoalTaskPlan, loop: AutoIteration): void {
    if (loop.loop_id !== goal.loop_id
      || loop.workspace_id !== goal.workspace_id
      || loop.task_id !== task.task_id
      || loop.conversation_id !== goal.conversation_id
      || loop.initial_execution_id !== goal.execution_id
      || loop.max_iterations !== task.max_iterations) {
      throw new Error("AutoIteration identity does not match the Goal task");
    }
  }

  private loopOutcome(loop: AutoIteration): "active" | "completed" | "failed" | "human_required" {
    if (loop.stage === "completed") return "completed";
    if (loop.stage === "failed") return "failed";
    if (loop.stage === "human_required") return "human_required";
    return "active";
  }

  private async completeTask(
    goal: GoalOrchestration,
    phaseIndex: number,
    taskIndex: number,
  ): Promise<GoalOrchestration> {
    const phase = goal.phases[phaseIndex]!;
    const task = phase.tasks[taskIndex]!;
    await this.setTaskStatus(goal, task.task_id, "completed");
    const nextTask = phase.tasks[taskIndex + 1];
    if (nextTask !== undefined) return this.checkpoint(goal, phase.phase_id, nextTask.task_id);

    const phases = goal.phases.map((candidate, index) => index === phaseIndex
      ? { ...candidate, status: "completed" as const }
      : candidate);
    const nextPhase = goal.phases[phaseIndex + 1];
    if (nextPhase === undefined) {
      return this.update(goal, { status: "completed", phases });
    }
    phases[phaseIndex + 1] = { ...phases[phaseIndex + 1]!, status: "running" };
    return this.checkpoint(goal, nextPhase.phase_id, nextPhase.tasks[0]!.task_id, { phases });
  }

  private async finish(
    goal: GoalOrchestration,
    status: "failed" | "human_required",
  ): Promise<GoalOrchestration> {
    const active = this.activeTask(goal);
    await this.setTaskStatus(goal, active.task.task_id, status);
    const phases = goal.phases.map((phase, index) => index === active.phaseIndex
      ? { ...phase, status }
      : phase);
    const terminal = await this.update(goal, { status, phases });
    return status === "human_required" ? this.notifyHumanRequired(terminal) : terminal;
  }

  private async notifyHumanRequired(initial: GoalOrchestration): Promise<GoalOrchestration> {
    let goal = initial;
    try {
      if (goal.human_required_info === undefined) {
        let loop = await this.auto.getLoop(goal.loop_id!).catch((error: unknown) => {
          if (goal.error === undefined) throw error;
          return null;
        });
        if (loop !== null && (loop.workspace_id !== goal.workspace_id || loop.task_id !== goal.current_task_id
          || loop.conversation_id !== goal.conversation_id || loop.initial_execution_id !== goal.execution_id)) loop = null;
        const execution = await this.executions.getExecutionContext(goal.workspace_id, goal.current_task_id!,
          loop?.execution_id ?? goal.execution_id!).catch((error: unknown) => {
          if (goal.error === undefined) throw error;
          return null;
        });
        const reason = goal.error === undefined ? loop?.terminal_reason ?? "GOAL_ORCHESTRATION_ERROR" : "GOAL_ORCHESTRATION_ERROR";
        const decision = reason === "REVIEW_REQUIRES_HUMAN"
          ? "Review 需要用户决策：请确认审查意见和下一步修改要求。"
          : reason === "MAX_ITERATIONS_REACHED"
            ? "已达到最大迭代次数：请决定是否继续，并明确后续范围与迭代上限。"
            : "执行或基础设施异常：请检查错误详情，处理连接、授权或环境问题后明确是否继续。";
        const active = this.activeTask(goal);
        const completedTasks = goal.phases.flatMap(phase => {
          if (phase.status === "completed") return phase.tasks;
          return phase.phase_id === goal.current_phase_id ? phase.tasks.slice(0, active.taskIndex) : [];
        });
        goal = await this.update(goal, { human_required_info: {
          goal_id: goal.goal_id, task_id: goal.current_task_id!, execution_id: loop?.execution_id ?? goal.execution_id!,
          phase_id: goal.current_phase_id!, stage: goal.error === undefined
            ? loop?.terminal_stage ?? (loop ? "review_loop" : "goal_orchestration") : "goal_orchestration",
          terminal_reason: reason, terminal_summary: goal.error ?? loop?.terminal_summary ?? "未提供额外错误详情。",
          completed_work: `已完成任务（${completedTasks.length} 项）：${completedTasks.slice(0, 50).map(task => task.task_id).join("、") || "无"}。当前执行：${execution?.status ?? "执行记录不可用"}；${execution?.summary ?? "未提供执行摘要"}`,
          required_action: decision,
          ...(loop?.review_result_id === undefined ? {} : { review_result_id: loop.review_result_id }),
        } });
      }
      const info = goal.human_required_info!;
      const delivery = await this.deliveries.enqueue(goal.conversation_id, [
        "LRM 已暂停，需人工处理。",
        `Goal：${info.goal_id}；Task：${info.task_id}；Execution：${info.execution_id}`,
        `断点阶段：${info.phase_id} / ${info.stage}`,
        `原因：${info.terminal_reason}`, `摘要：${info.terminal_summary}`,
        `已完成工作：${info.completed_work}`, `需要确认：${info.required_action}`,
        ...(info.review_result_id === undefined ? [] : [`Review 证据：${info.review_result_id}`]),
        "请在本 ChatGPT 对话中回复处理决定。只有用户明确决定继续或修改任务后，才通过 submit_goal 使用新的 Goal / Task 标识发起后续执行，并在任务要求中保留原 Goal / Task / Execution 和 Review 证据关联，沿用原 Workspace 与对话绑定。保留原 Goal 终止记录，不自动重试或重新提交。",
      ].join("\n"), stableIdentity("human-required", goal.goal_id, goal.current_phase_id!, goal.current_task_id!));
      if (delivery.phase === "queued" || delivery.phase === "leased"
        || (delivery.receipt !== undefined && retryableNotSent(delivery.receipt))) this.scheduleRecovery(goal.goal_id);
    } catch (error: unknown) {
      console.warn(`Human-required notification pending for "${goal.goal_id}"`, errorMessage(error));
      this.scheduleRecovery(goal.goal_id);
    }
    return goal;
  }

  private async setTaskStatus(goal: GoalOrchestration, taskId: string, status: TaskStatus): Promise<void> {
    const task = await this.tasks.getTaskContext(taskId);
    if (task === null || task.workspace_id !== goal.workspace_id) return;
    if (task.status !== status) await this.tasks.updateTaskContext(taskId, { status });
  }

  private activeTask(goal: GoalOrchestration): {
    readonly phaseIndex: number;
    readonly taskIndex: number;
    readonly task: GoalTaskPlan;
  } {
    const phaseIndex = goal.phases.findIndex((phase) => phase.phase_id === goal.current_phase_id);
    const phase = goal.phases[phaseIndex];
    const taskIndex = phase?.tasks.findIndex((task) => task.task_id === goal.current_task_id) ?? -1;
    const task = phase?.tasks[taskIndex];
    if (phase === undefined || task === undefined) throw new Error("Goal active checkpoint is invalid.");
    return { phaseIndex, taskIndex, task };
  }

  private checkpoint(
    goal: GoalOrchestration,
    phaseId: string,
    taskId: string,
    patch: Partial<GoalOrchestration> = {},
  ): Promise<GoalOrchestration> {
    return this.update(goal, {
      ...patch,
      current_phase_id: phaseId,
      current_task_id: taskId,
      execution_id: stableIdentity("execution", goal.goal_id, phaseId, taskId),
      actuation_id: stableIdentity("actuation", goal.goal_id, phaseId, taskId),
      loop_id: stableIdentity("loop", goal.goal_id, phaseId, taskId),
    });
  }

  private async update(goal: GoalOrchestration, patch: Partial<GoalOrchestration>): Promise<GoalOrchestration> {
    const next = goalOrchestrationSchema.parse({
      ...goal,
      ...patch,
      updated_at: new Date().toISOString(),
    });
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.store.put(next);
      } catch (error: unknown) {
        if (attempt >= 2 || !["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "")) {
          // The persisted running checkpoint and Loop outcome remain the recovery source.
          if (goal.status === "running") this.scheduleRecovery(goal.goal_id);
          throw error;
        }
      }
      await delay(10 * (attempt + 1));
    }
  }

  private async requiredGoal(goalId: string): Promise<GoalOrchestration> {
    const goal = await this.store.get(goalId);
    if (goal === null) throw new Error(`Goal "${goalId}" was not found.`);
    return goal;
  }

  private serial<T>(goalId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(goalId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.operations.set(goalId, settled);
    void settled.finally(() => {
      if (this.operations.get(goalId) === settled) this.operations.delete(goalId);
    });
    return result;
  }
}
