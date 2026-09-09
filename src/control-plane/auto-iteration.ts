import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  executionContextSchema,
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
  conversationIdSchema,
} from "../context/schema.js";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { TaskContextService } from "../context/service.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import { ConversationRoutingService } from "../context/conversation-routing-service.js";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import { ReviewResultService } from "../context/review-result-service.js";
import { reviewRequestIdSchema } from "../context/review-schema.js";
import { conversationRoutingIdSchema } from "../context/conversation-routing-schema.js";
import { reviewDeliveryIdSchema } from "../context/review-delivery-schema.js";
import { reviewResultIdSchema } from "../context/review-result-schema.js";
import type { ExecutionContext, ReviewRequestContext } from "../context/types.js";
import type { ReviewDelivery } from "../context/review-delivery.js";
import {
  ActuationAuthorizationStore,
  ControlledActuationService,
  type ActuationAuthorization,
  type ControlledActuationResult,
} from "./controlled-actuation.js";
import { DispatchCommandBroker } from "./dispatch-command-broker.js";
import { ExtensionDeliveryService } from "./extension-delivery.js";
import { ExtensionDeliveryAdapter } from "../delivery/extension-delivery-adapter.js";
import type { ReviewDeliveryAdapter } from "../delivery/review-delivery-adapter.js";
import { BrowserRouter } from "../router/browser-router.js";
import { ReviewCompletionRouter } from "../router/review-completion-router.js";
import {
  ReviewVerdictParser,
  ReviewVerdictParseError,
} from "../control/review-verdict-parser.js";
import {
  reviewVerdictIterationSchema,
  reviewVerdictSchema,
} from "../control/review-verdict-schema.js";
import type { ReviewVerdict, ReviewVerdictIteration } from "../control/review-verdict.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";

const STATE_VERSION = 1;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const timestampSchema = z.string().datetime({ offset: true });
export const autoIterationIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ID_PATTERN);
const actuationIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ID_PATTERN);
export const autoIterationStageSchema = z.enum([
  "execution",
  "review_request",
  "routing",
  "delivery",
  "review_completion",
  "verdict",
  "actuation",
  "completed",
  "human_required",
  "failed",
]);
export const autoIterationTerminalDecisionSchema = z.enum(["APPROVE", "HUMAN_REQUIRED", "FAILED"]);
const pendingIterationSchema = reviewVerdictIterationSchema;

export const autoIterationSchema = z.object({
  loop_id: autoIterationIdSchema,
  initial_execution_id: executionIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  conversation_id: conversationIdSchema,
  max_iterations: z.number().int().min(1).max(10_000),
  iteration: z.number().int().min(1).max(10_000),
  execution_id: executionIdSchema,
  review_request_id: reviewRequestIdSchema.optional(),
  routing_id: conversationRoutingIdSchema.optional(),
  delivery_id: reviewDeliveryIdSchema.optional(),
  review_result_id: reviewResultIdSchema.optional(),
  actuation_id: actuationIdSchema.optional(),
  authorization_id: z.string().uuid().optional(),
  pending_iteration: pendingIterationSchema.optional(),
  stage: autoIterationStageSchema,
  terminal_decision: autoIterationTerminalDecisionSchema.optional(),
  terminal_reason: z.string().min(1).max(4000).optional(),
  terminal_summary: z.string().min(1).max(4000).optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict().superRefine((loop, context) => {
  const terminal = loop.stage === "completed"
    || loop.stage === "human_required"
    || loop.stage === "failed";
  if (terminal !== (loop.terminal_decision !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["terminal_decision"],
      message: "terminal decision must match terminal stage",
    });
  }
  if (loop.stage === "completed" && loop.terminal_decision !== "APPROVE") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["terminal_decision"],
      message: "completed loops must have an APPROVE decision",
    });
  }
  if (loop.stage === "failed" && loop.terminal_decision !== "FAILED") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["terminal_decision"],
      message: "failed loops must have a FAILED decision",
    });
  }
  if (loop.stage === "human_required" && loop.terminal_decision !== "HUMAN_REQUIRED") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["terminal_decision"],
      message: "human-required loops must have a HUMAN_REQUIRED decision",
    });
  }
  if (loop.iteration > loop.max_iterations) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["iteration"],
      message: "iteration cannot exceed max_iterations",
    });
  }
});

export const autoIterationStateSchema = z.object({
  schema_version: z.literal(STATE_VERSION),
  loops: z.array(autoIterationSchema).max(10_000),
}).strict().superRefine((state, context) => {
  const ids = new Set<string>();
  state.loops.forEach((loop, index) => {
    if (ids.has(loop.loop_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["loops", index, "loop_id"],
        message: "loop_id is duplicated",
      });
    }
    ids.add(loop.loop_id);
  });
});

export const autoIterationStartInputSchema = z.object({
  loop_id: autoIterationIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  conversation_id: conversationIdSchema,
  execution_id: executionIdSchema,
  max_iterations: z.number().int().min(1).max(10_000),
}).strict();

export type AutoIteration = z.infer<typeof autoIterationSchema>;
export type AutoIterationLoop = AutoIteration;
export type AutoIterationStartInput = z.infer<typeof autoIterationStartInputSchema>;
export type AutoIterationStage = z.infer<typeof autoIterationStageSchema>;
export type AutoIterationTerminalDecision = z.infer<typeof autoIterationTerminalDecisionSchema>;
export type AutoIterationTerminalListener = (
  loop: AutoIteration,
) => void | Promise<void>;

export const autoIterationStateFile = (storageRoot: string): string =>
  join(resolve(storageRoot), "control-plane", "auto-iterations.json");

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyState(): z.infer<typeof autoIterationStateSchema> {
  return { schema_version: STATE_VERSION, loops: [] };
}

function stableIdentity(kind: string, loopId: string, iteration: number): string {
  const digest = createHash("sha256")
    .update(`${loopId}\0${iteration}\0${kind}`)
    .digest("hex")
    .slice(0, 32);
  return `auto-${kind}-${digest}`;
}

function iterationInstruction(iteration: ReviewVerdictIteration): string {
  const parsed = reviewVerdictIterationSchema.parse(iteration);
  return [
    "## 修改目标",
    parsed.goal,
    "",
    "## 修改要求",
    ...parsed.requirements.map((item) => `- ${item}`),
    "",
    "## 验收标准",
    ...parsed.acceptance_criteria.map((item) => `- ${item}`),
  ].join("\n");
}

export function buildAutoIterationInstruction(iteration: ReviewVerdictIteration): string {
  return iterationInstruction(iteration);
}

export class AutoIterationUnavailableError extends Error {}

class AutoIterationStore {
  private readonly file: string;
  private state = emptyState();
  private restorePromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(storageRoot: string) {
    this.file = autoIterationStateFile(storageRoot);
  }

  public restore(): Promise<void> {
    this.restorePromise ??= this.exclusive(async () => {
      let raw: string;
      try {
        raw = await readFile(this.file, "utf8");
      } catch (error: unknown) {
        if (errorCode(error) === "ENOENT") return;
        throw new AutoIterationUnavailableError(
          "auto iteration state could not be restored",
          { cause: error },
        );
      }
      try {
        this.state = autoIterationStateSchema.parse(JSON.parse(raw) as unknown);
      } catch (error: unknown) {
        throw new AutoIterationUnavailableError(
          "auto iteration state could not be restored",
          { cause: error },
        );
      }
    });
    return this.restorePromise;
  }

  public async get(loopId: string): Promise<AutoIteration | null> {
    await this.restore();
    const parsedId = autoIterationIdSchema.parse(loopId);
    return this.exclusive(async () => {
      const loop = this.state.loops.find((candidate) => candidate.loop_id === parsedId);
      return loop === undefined ? null : clone(loop);
    });
  }

  public async list(): Promise<AutoIteration[]> {
    await this.restore();
    return this.exclusive(async () => this.state.loops
      .map(clone)
      .sort((left, right) => left.loop_id.localeCompare(right.loop_id)));
  }

  public async put(loop: AutoIteration): Promise<AutoIteration> {
    await this.restore();
    const parsed = autoIterationSchema.parse(loop);
    return this.exclusive(async () => {
      const loops = this.state.loops.some((candidate) => candidate.loop_id === parsed.loop_id)
        ? this.state.loops.map((candidate) => candidate.loop_id === parsed.loop_id ? parsed : candidate)
        : [...this.state.loops, parsed];
      const next = autoIterationStateSchema.parse({
        schema_version: STATE_VERSION,
        loops,
      });
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

  private async persist(state: z.infer<typeof autoIterationStateSchema>): Promise<void> {
    const directory = dirname(this.file);
    const temporary = join(directory, `.auto-iterations-${process.pid}-${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.file);
      await chmod(this.file, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

type AuthorizationReader = Pick<
  ActuationAuthorizationStore,
  "getAuthorization" | "getAuthorizationByActuation"
>;

type ControlledActuationPort = Pick<
  ControlledActuationService,
  "authorize" | "actuate" | "getActuation"
>;

export interface AutoIterationServiceOptions {
  readonly storageRoot?: string;
  readonly taskContextService?: TaskContextService;
  readonly executionContextService?: ExecutionContextService;
  readonly reviewRequestService?: ReviewRequestService;
  readonly routingService?: ConversationRoutingService;
  readonly reviewDeliveryService?: ReviewDeliveryService;
  readonly reviewResultService?: ReviewResultService;
  readonly browserRouter?: Pick<BrowserRouter, "deliver">;
  readonly completionRouter?: Pick<ReviewCompletionRouter, "collect">;
  readonly verdictParser?: Pick<ReviewVerdictParser, "parse">;
  readonly extensionDeliveries?: ExtensionDeliveryService;
  readonly dispatchCommandBroker?: Pick<DispatchCommandBroker, "dispatch">;
  readonly reviewDeliveryAdapter?: ReviewDeliveryAdapter;
  readonly authorizationStore?: AuthorizationReader;
  readonly controlledActuation?: ControlledActuationPort & {
    readonly authorizationStore?: AuthorizationReader;
  };
  readonly terminalListener?: AutoIterationTerminalListener;
}

export class AutoIterationService {
  public readonly storageRoot: string;
  public readonly registry: WorkspaceRegistry;
  public readonly browserRouter: Pick<BrowserRouter, "deliver">;
  public readonly completionRouter: Pick<ReviewCompletionRouter, "collect">;
  public readonly controlledActuation: ControlledActuationPort;
  public readonly extensionDeliveries: ExtensionDeliveryService;

  private readonly store: AutoIterationStore;
  private readonly tasks: TaskContextService;
  private readonly executions: ExecutionContextService;
  private readonly reviewRequests: ReviewRequestService;
  private readonly routings: ConversationRoutingService;
  private readonly deliveries: ReviewDeliveryService;
  private readonly results: ReviewResultService;
  private readonly parser: Pick<ReviewVerdictParser, "parse">;
  private readonly authorizationStore: AuthorizationReader;
  private readonly flights = new Map<string, Promise<AutoIteration>>();
  private terminalListener?: AutoIterationTerminalListener;

  public constructor(
    registry: WorkspaceRegistry,
    options: AutoIterationServiceOptions = {},
  ) {
    this.registry = registry;
    this.storageRoot = resolve(
      options.storageRoot
        ?? options.executionContextService?.storageRoot
        ?? options.taskContextService?.storageRoot
        ?? options.reviewRequestService?.storageRoot
        ?? options.reviewDeliveryService?.storageRoot
        ?? options.reviewResultService?.storageRoot
        ?? defaultTaskContextStorageRoot(),
    );
    this.tasks = options.taskContextService ?? new TaskContextService(this.storageRoot);
    this.executions = options.executionContextService ?? new ExecutionContextService(this.storageRoot);
    this.reviewRequests = options.reviewRequestService ?? new ReviewRequestService(this.storageRoot);
    this.routings = options.routingService ?? new ConversationRoutingService(this.storageRoot);
    this.deliveries = options.reviewDeliveryService ?? new ReviewDeliveryService(this.storageRoot);
    this.results = options.reviewResultService ?? new ReviewResultService(this.storageRoot);
    this.extensionDeliveries = options.extensionDeliveries ?? new ExtensionDeliveryService(this.storageRoot);
    const broker = options.dispatchCommandBroker ?? new DispatchCommandBroker(this.extensionDeliveries);
    const adapter = options.reviewDeliveryAdapter ?? new ExtensionDeliveryAdapter(broker);
    this.browserRouter = options.browserRouter ?? new BrowserRouter(this.storageRoot, adapter);
    this.completionRouter = options.completionRouter ?? new ReviewCompletionRouter(this.storageRoot);
    this.parser = options.verdictParser ?? new ReviewVerdictParser();
    this.authorizationStore = options.authorizationStore
      ?? options.controlledActuation?.authorizationStore
      ?? new ActuationAuthorizationStore(this.storageRoot);
    this.controlledActuation = options.controlledActuation
      ?? new ControlledActuationService(registry, {
        storageRoot: this.storageRoot,
        authorizationStore: this.authorizationStore instanceof ActuationAuthorizationStore
          ? this.authorizationStore
          : new ActuationAuthorizationStore(this.storageRoot),
        taskContextService: this.tasks,
        executionContextService: this.executions,
      });
    this.store = new AutoIterationStore(this.storageRoot);
    this.terminalListener = options.terminalListener;

    for (const dependency of [
      this.tasks.storageRoot,
      this.executions.storageRoot,
      this.reviewRequests.storageRoot,
      this.routings.storageRoot,
      this.deliveries.storageRoot,
      this.results.storageRoot,
      this.extensionDeliveries.storageRoot,
      this.authorizationStore instanceof ActuationAuthorizationStore
        ? this.authorizationStore.storageRoot
        : this.storageRoot,
    ]) {
      if (resolve(dependency) !== this.storageRoot) {
        throw new Error("Auto Iteration dependencies must share one storage root.");
      }
    }
  }

  public restore(): Promise<void> {
    return this.store.restore();
  }

  public async getLoop(loopId: string): Promise<AutoIteration | null> {
    return this.store.get(loopId);
  }

  public async listLoops(): Promise<AutoIteration[]> {
    return this.store.list();
  }

  public setTerminalListener(listener: AutoIterationTerminalListener | undefined): void {
    this.terminalListener = listener;
  }

  public start(input: AutoIterationStartInput): Promise<AutoIteration> {
    const parsed = autoIterationStartInputSchema.parse(input);
    return this.serial(parsed.loop_id, () => this.startOnce(parsed));
  }

  public bind(input: AutoIterationStartInput): Promise<AutoIteration> {
    return this.start(input);
  }

  public advance(loopId: string): Promise<AutoIteration> {
    const parsedId = autoIterationIdSchema.parse(loopId);
    return this.serial(parsedId, () => this.advanceOnce(parsedId));
  }

  public async onExecutionTerminal(execution: ExecutionContext): Promise<void> {
    const parsed = executionContextSchema.parse(execution);
    if (parsed.status === "running") return;
    const loops = await this.store.list();
    await Promise.all(loops
      .filter((loop) => loop.stage !== "completed"
        && loop.stage !== "human_required"
        && loop.stage !== "failed"
        && loop.workspace_id === parsed.workspace_id
        && loop.task_id === parsed.task_id
        && loop.execution_id === parsed.execution_id)
      .map((loop) => this.advanceNotifiedLoop(loop, parsed)));
  }

  public notifyExecutionTerminal(execution: ExecutionContext): Promise<void> {
    return this.onExecutionTerminal(execution);
  }

  public async recover(): Promise<void> {
    const loops = await this.store.list();
    for (const loop of loops) {
      if (loop.stage === "completed" || loop.stage === "human_required" || loop.stage === "failed") {
        this.notifyTerminal(loop);
        continue;
      }
      try {
        await this.advance(loop.loop_id);
      } catch (error: unknown) {
        console.warn(`Auto Iterate recovery failed for loop "${loop.loop_id}"`, errorMessage(error));
      }
    }
  }

  public recoverRunningLoops(): Promise<void> {
    return this.recover();
  }

  private async startOnce(input: AutoIterationStartInput): Promise<AutoIteration> {
    this.registry.resolve(input.workspace_id);
    const task = await this.tasks.getTaskContext(input.task_id);
    if (task === null) throw new Error(`Task context "${input.task_id}" was not found.`);
    if (task.workspace_id !== input.workspace_id) {
      throw new Error("Task context does not belong to the requested workspace.");
    }
    const execution = await this.executions.getExecutionContext(
      input.workspace_id,
      input.task_id,
      input.execution_id,
    );
    if (execution === null) {
      throw new Error(`Execution context "${input.execution_id}" was not found.`);
    }

    const existing = await this.store.get(input.loop_id);
    if (existing !== null) {
      if (existing.workspace_id !== input.workspace_id
        || existing.task_id !== input.task_id
        || existing.conversation_id !== input.conversation_id
        || existing.max_iterations !== input.max_iterations
        || (existing.initial_execution_id !== input.execution_id
          && existing.execution_id !== input.execution_id)) {
        throw new Error(`Auto iteration loop "${input.loop_id}" is bound to another identity.`);
      }
      return this.advanceOnce(existing.loop_id);
    }

    const timestamp = new Date().toISOString();
    const loop = autoIterationSchema.parse({
      loop_id: input.loop_id,
      initial_execution_id: input.execution_id,
      workspace_id: input.workspace_id,
      task_id: input.task_id,
      conversation_id: input.conversation_id,
      max_iterations: input.max_iterations,
      iteration: 1,
      execution_id: input.execution_id,
      stage: execution.status === "passed" ? "review_request" : "execution",
      created_at: timestamp,
      updated_at: timestamp,
    });
    await this.store.put(loop);
    return this.advanceOnce(loop.loop_id);
  }

  private async advanceOnce(loopId: string): Promise<AutoIteration> {
    for (let step = 0; step < 32; step += 1) {
      const loop = await this.store.get(loopId);
      if (loop === null) throw new Error(`Auto iteration loop "${loopId}" was not found.`);
      if (loop.stage === "completed" || loop.stage === "human_required" || loop.stage === "failed") {
        return loop;
      }
      if (loop.stage === "review_request"
        || loop.stage === "routing"
        || loop.stage === "delivery"
        || loop.stage === "review_completion"
        || loop.stage === "verdict") {
        const execution = await this.executions.getExecutionContext(
          loop.workspace_id,
          loop.task_id,
          loop.execution_id,
        );
        if (execution === null) return this.humanRequired(loop, "EXECUTION_MISSING");
        if (execution.status === "failed") return this.failed(loop, "EXECUTION_FAILED", execution.summary);
        if (execution.status === "running") return loop;
      }

      switch (loop.stage) {
        case "execution": {
          const next = await this.advanceExecution(loop);
          if (next.stage === "review_request") break;
          return next;
        }
        case "review_request":
          await this.advanceReviewRequest(loop);
          break;
        case "routing":
          await this.advanceRouting(loop);
          break;
        case "delivery":
          await this.advanceDelivery(loop);
          break;
        case "review_completion":
          await this.advanceReviewCompletion(loop);
          break;
        case "verdict":
          await this.advanceVerdict(loop);
          break;
        case "actuation":
          await this.advanceActuation(loop);
          break;
        default:
          throw new Error(`Auto iteration loop "${loopId}" has an unsupported stage.`);
      }
    }
    throw new Error(`Auto iteration loop "${loopId}" did not reach a stable stage.`);
  }

  private async advanceExecution(loop: AutoIteration): Promise<AutoIteration> {
    const execution = await this.executions.getExecutionContext(
      loop.workspace_id,
      loop.task_id,
      loop.execution_id,
    );
    if (execution === null) return this.humanRequired(loop, "EXECUTION_MISSING");
    if (execution.status === "running") return loop;
    if (execution.status === "failed") {
      return this.failed(loop, "EXECUTION_FAILED", execution.summary);
    }
    return this.update(loop, { stage: "review_request" });
  }

  private async advanceReviewRequest(loop: AutoIteration): Promise<void> {
    let current = loop;
    try {
      const reviewRequestId = current.review_request_id
        ?? stableIdentity("review", current.loop_id, current.iteration);
      if (current.review_request_id === undefined) {
        current = await this.update(current, { review_request_id: reviewRequestId });
      }

      let request = await this.reviewRequests.getReviewRequest(
        current.workspace_id,
        reviewRequestId,
      );
      if (request === null) {
        try {
          request = await this.reviewRequests.createReviewRequest({
            review_request_id: reviewRequestId,
            task_id: current.task_id,
            execution_id: current.execution_id,
            workspace_id: current.workspace_id,
            conversation_id: current.conversation_id,
          });
        } catch (error: unknown) {
          request = await this.reviewRequests.getReviewRequest(
            current.workspace_id,
            reviewRequestId,
          );
          if (request === null) throw error;
        }
      }
      this.assertReviewRequest(current, request);
      await this.tasks.updateTaskContext(current.task_id, { status: "reviewing" });
      await this.update(current, { stage: "routing" });
    } catch (error: unknown) {
      await this.humanRequired(current, "REVIEW_REQUEST_UNAVAILABLE", errorMessage(error));
    }
  }

  private async advanceRouting(loop: AutoIteration): Promise<void> {
    let current = loop;
    try {
      const reviewRequestId = this.required(loop.review_request_id, "review_request_id");
      const routingId = current.routing_id
        ?? stableIdentity("routing", current.loop_id, current.iteration);
      if (current.routing_id === undefined) {
        current = await this.update(current, { routing_id: routingId });
      }

      let routing = await this.routings.getRouting(current.workspace_id, routingId);
      if (routing === null) {
        try {
          routing = await this.routings.createRouting({
            routing_id: routingId,
            workspace_id: current.workspace_id,
            task_id: current.task_id,
            execution_id: current.execution_id,
            review_request_id: reviewRequestId,
            conversation_id: current.conversation_id,
          });
        } catch (error: unknown) {
          routing = await this.routings.getRouting(current.workspace_id, routingId);
          if (routing === null) throw error;
        }
      }
      if (routing.task_id !== current.task_id
        || routing.workspace_id !== current.workspace_id
        || routing.execution_id !== current.execution_id
        || routing.review_request_id !== reviewRequestId
        || routing.conversation_id !== current.conversation_id) {
        throw new Error("Conversation routing identity does not match the loop.");
      }
      await this.update(current, { stage: "delivery" });
    } catch (error: unknown) {
      await this.humanRequired(current, "ROUTING_UNAVAILABLE", errorMessage(error));
    }
  }

  private async advanceDelivery(loop: AutoIteration): Promise<void> {
    let current = loop;
    try {
      const routingId = this.required(loop.routing_id, "routing_id");
      const reviewRequestId = this.required(loop.review_request_id, "review_request_id");
      const deliveryId = current.delivery_id
        ?? stableIdentity("delivery", current.loop_id, current.iteration);
      if (current.delivery_id === undefined) {
        current = await this.update(current, { delivery_id: deliveryId });
      }

      let delivery = await this.deliveries.getDelivery(current.workspace_id, deliveryId);
      if (delivery === null) {
        const byRouting = await this.deliveries.getDeliveryByRouting(
          current.workspace_id,
          routingId,
        );
        if (byRouting !== null) {
          if (byRouting.delivery_id !== deliveryId) {
            current = await this.update(current, { delivery_id: byRouting.delivery_id });
          }
          delivery = byRouting;
        }
      }
      if (delivery === null) {
        try {
          delivery = await this.deliveries.createDelivery({
            delivery_id: deliveryId,
            workspace_id: current.workspace_id,
            task_id: current.task_id,
            review_request_id: reviewRequestId,
            routing_id: routingId,
            conversation_id: current.conversation_id,
          });
        } catch (error: unknown) {
          delivery = await this.deliveries.getDeliveryByRouting(
            current.workspace_id,
            routingId,
          );
          if (delivery === null) throw error;
          current = await this.update(current, { delivery_id: delivery.delivery_id });
        }
      }
      this.assertDelivery(current, delivery, reviewRequestId, routingId);
      await this.deliveries.validateDelivery(delivery);

      if (delivery.status === "delivered") {
        await this.update(current, { stage: "review_completion" });
        return;
      }
      if (delivery.status !== "pending") {
        await this.humanRequired(
          current,
          delivery.status === "delivering" ? "DELIVERY_UNCERTAIN" : "DELIVERY_FAILED",
          delivery.last_error?.message,
        );
        return;
      }

      let delivered: ReviewDelivery;
      try {
        delivered = await this.browserRouter.deliver(current.workspace_id, routingId);
      } catch (error: unknown) {
        await this.humanRequired(current, "DELIVERY_FAILED", errorMessage(error));
        return;
      }
      if (delivered.status !== "delivered") {
        await this.humanRequired(
          current,
          delivered.status === "delivering" ? "DELIVERY_UNCERTAIN" : "DELIVERY_FAILED",
          delivered.last_error?.message,
        );
        return;
      }
      await this.update(current, { stage: "review_completion" });
    } catch (error: unknown) {
      await this.humanRequired(current, "DELIVERY_UNAVAILABLE", errorMessage(error));
    }
  }

  private async advanceReviewCompletion(loop: AutoIteration): Promise<void> {
    try {
      const routingId = this.required(loop.routing_id, "routing_id");
      const reviewRequestId = this.required(loop.review_request_id, "review_request_id");
      const deliveryId = this.required(loop.delivery_id, "delivery_id");
      const delivery = await this.deliveries.getDelivery(loop.workspace_id, deliveryId);
      if (delivery === null || delivery.status !== "delivered") {
        await this.humanRequired(loop, "DELIVERY_NOT_CONFIRMED");
        return;
      }
      this.assertDelivery(loop, delivery, reviewRequestId, routingId);
      await this.deliveries.validateDelivery(delivery);

      let result = loop.review_result_id === undefined
        ? await this.results.getReviewResultByRequest(loop.workspace_id, reviewRequestId)
        : await this.results.getReviewResult(loop.workspace_id, loop.review_result_id);
      if (result === null && loop.review_result_id !== undefined) {
        result = await this.results.getReviewResultByRequest(loop.workspace_id, reviewRequestId);
      }
      if (result === null) {
        try {
          result = await this.completionRouter.collect(loop.workspace_id, routingId);
        } catch (error: unknown) {
          await this.humanRequired(loop, "REVIEW_COMPLETION_FAILED", errorMessage(error));
          return;
        }
      }
      if (result === null
        || result.workspace_id !== loop.workspace_id
        || result.task_id !== loop.task_id
        || result.review_request_id !== reviewRequestId
        || result.delivery_id !== deliveryId) {
        await this.humanRequired(loop, "REVIEW_RESULT_IDENTITY_INVALID");
        return;
      }

      if (result.status !== "COMPLETED") {
        await this.humanRequired(loop, `REVIEW_COMPLETION_${result.status}`, result.error);
        return;
      }
      const current = loop.review_result_id === result.result_id
        ? loop
        : await this.update(loop, { review_result_id: result.result_id });
      await this.update(current, { stage: "verdict" });
    } catch (error: unknown) {
      await this.humanRequired(loop, "REVIEW_COMPLETION_UNAVAILABLE", errorMessage(error));
    }
  }

  private async advanceVerdict(loop: AutoIteration): Promise<void> {
    try {
      const reviewRequestId = this.required(loop.review_request_id, "review_request_id");
      let result = loop.review_result_id === undefined
        ? await this.results.getReviewResultByRequest(loop.workspace_id, reviewRequestId)
        : await this.results.getReviewResult(loop.workspace_id, loop.review_result_id);
      if (result === null && loop.review_result_id !== undefined) {
        result = await this.results.getReviewResultByRequest(loop.workspace_id, reviewRequestId);
      }
      if (result === null || result.status !== "COMPLETED") {
        await this.humanRequired(loop, "REVIEW_RESULT_NOT_COMPLETED");
        return;
      }

      let verdict: ReviewVerdict;
      try {
        verdict = this.parser.parse(result);
      } catch (error: unknown) {
        const code = error instanceof ReviewVerdictParseError ? error.code : "VERDICT_INVALID";
        await this.humanRequired(loop, `INVALID_VERDICT_${code}`, errorMessage(error));
        return;
      }
      const parsed = reviewVerdictSchema.safeParse(verdict);
      if (!parsed.success || parsed.data.review_request_id !== reviewRequestId) {
        await this.humanRequired(loop, "INVALID_VERDICT_SCHEMA");
        return;
      }

      if (parsed.data.decision === "APPROVE") {
        await this.complete(loop, parsed.data.summary);
        return;
      }
      if (parsed.data.decision === "HUMAN_REQUIRED") {
        await this.humanRequired(loop, "REVIEW_REQUIRES_HUMAN", parsed.data.summary);
        return;
      }
      if (loop.iteration >= loop.max_iterations) {
        await this.humanRequired(loop, "MAX_ITERATIONS_REACHED", parsed.data.summary);
        return;
      }

      const iteration = parsed.data.iteration;
      if (iteration === undefined) {
        await this.humanRequired(loop, "ITERATION_PAYLOAD_MISSING");
        return;
      }
      const nextIteration = loop.iteration + 1;
      const nextExecutionId = stableIdentity("execution", loop.loop_id, nextIteration);
      const nextActuationId = stableIdentity("actuation", loop.loop_id, nextIteration);
      await this.update(loop, {
        iteration: nextIteration,
        execution_id: nextExecutionId,
        review_request_id: undefined,
        routing_id: undefined,
        delivery_id: undefined,
        review_result_id: undefined,
        actuation_id: nextActuationId,
        authorization_id: undefined,
        pending_iteration: {
          goal: iteration.goal,
          requirements: [...iteration.requirements],
          acceptance_criteria: [...iteration.acceptance_criteria],
        },
        stage: "actuation",
      });
    } catch (error: unknown) {
      await this.humanRequired(loop, "VERDICT_UNAVAILABLE", errorMessage(error));
    }
  }

  private async advanceActuation(loop: AutoIteration): Promise<void> {
    let current = loop;
    try {
      const actuationId = this.required(loop.actuation_id, "actuation_id");
      const pendingIteration = loop.pending_iteration;
      if (pendingIteration === undefined) {
        await this.humanRequired(loop, "ITERATION_PAYLOAD_MISSING");
        return;
      }
      const instruction = iterationInstruction(pendingIteration);
      let authorization: ActuationAuthorization | null = loop.authorization_id === undefined
        ? await this.authorizationStore.getAuthorizationByActuation(actuationId)
        : await this.authorizationStore.getAuthorization(loop.authorization_id);
      if (authorization === null && loop.authorization_id !== undefined) {
        authorization = await this.authorizationStore.getAuthorizationByActuation(actuationId);
      }

      if (authorization === null) {
        try {
          authorization = await this.controlledActuation.authorize({
            actuation_id: actuationId,
            workspace_id: loop.workspace_id,
            task_id: loop.task_id,
            execution_id: loop.execution_id,
            instruction,
          });
        } catch (error: unknown) {
          const recovered = await this.authorizationStore.getAuthorizationByActuation(actuationId);
          if (recovered === null) throw error;
          authorization = recovered;
        }
      }
      if (authorization.actuation_id !== actuationId
        || authorization.workspace_id !== loop.workspace_id
        || authorization.task_id !== loop.task_id
        || authorization.execution_id !== loop.execution_id
        || authorization.instruction !== instruction) {
        await this.humanRequired(loop, "AUTHORIZATION_IDENTITY_INVALID");
        return;
      }

      if (current.authorization_id !== authorization.authorization_id) {
        current = await this.update(current, { authorization_id: authorization.authorization_id });
      }
      const existingActuation = await this.controlledActuation.getActuation(actuationId);
      if (existingActuation?.status === "failed") {
        await this.failed(current, "ACTUATION_FAILED");
        return;
      }

      let result: ControlledActuationResult;
      try {
        result = await this.controlledActuation.actuate({
          actuation_id: actuationId,
          authorization_id: authorization.authorization_id,
        });
      } catch (error: unknown) {
        const execution = await this.executions.getExecutionContext(
          current.workspace_id,
          current.task_id,
          current.execution_id,
        );
        if (execution?.status === "failed") {
          await this.failed(current, "ACTUATION_FAILED", execution.summary);
        } else {
          await this.humanRequired(current, "ACTUATION_UNCERTAIN", errorMessage(error));
        }
        return;
      }
      if (result.execution_id !== current.execution_id
        || result.actuation.actuation_id !== actuationId
        || result.actuation.authorization_id !== authorization.authorization_id) {
        await this.humanRequired(current, "ACTUATION_IDENTITY_INVALID");
        return;
      }
      await this.update(current, {
        stage: "execution",
        pending_iteration: undefined,
      });
    } catch (error: unknown) {
      await this.humanRequired(current, "ACTUATION_UNAVAILABLE", errorMessage(error));
    }
  }

  private async complete(loop: AutoIteration, summary: string): Promise<AutoIteration> {
    const current = await this.update(loop, {
      stage: "completed",
      terminal_decision: "APPROVE",
      terminal_reason: "REVIEW_APPROVED",
      terminal_summary: summary,
    });
    try {
      await this.tasks.updateTaskContext(current.task_id, { status: "completed" });
    } catch (error: unknown) {
      console.warn(`Auto Iterate task completion update failed for loop "${current.loop_id}"`, errorMessage(error));
    }
    this.notifyTerminal(current);
    return current;
  }

  private async advanceNotifiedLoop(
    loop: AutoIteration,
    execution: ExecutionContext,
  ): Promise<void> {
    try {
      await this.advance(loop.loop_id);
      const current = await this.store.get(loop.loop_id);
      if (current === null
        || current.stage !== "execution"
        || current.execution_id !== execution.execution_id) {
        return;
      }
      const observed = await this.executions.getExecutionContext(
        execution.workspace_id,
        execution.task_id,
        execution.execution_id,
      );
      if (observed?.status !== "running") await this.advance(loop.loop_id);
    } catch (error: unknown) {
      console.warn(`Auto Iterate terminal notification failed for loop "${loop.loop_id}"`, errorMessage(error));
    }
  }

  private async failed(
    loop: AutoIteration,
    reason: string,
    summary?: string,
  ): Promise<AutoIteration> {
    const current = await this.update(loop, {
      stage: "failed",
      terminal_decision: "FAILED",
      terminal_reason: reason,
      ...(summary === undefined ? {} : { terminal_summary: summary }),
    });
    try {
      await this.tasks.updateTaskContext(current.task_id, { status: "failed" });
    } catch (error: unknown) {
      console.warn(`Auto Iterate task failure update failed for loop "${current.loop_id}"`, errorMessage(error));
    }
    this.notifyTerminal(current);
    return current;
  }

  private async humanRequired(
    loop: AutoIteration,
    reason: string,
    summary?: string,
  ): Promise<AutoIteration> {
    const current = await this.update(loop, {
      stage: "human_required",
      terminal_decision: "HUMAN_REQUIRED",
      terminal_reason: reason,
      ...(summary === undefined ? {} : { terminal_summary: summary }),
    });
    try {
      await this.tasks.updateTaskContext(current.task_id, { status: "human_required" });
    } catch (error: unknown) {
      console.warn(`Auto Iterate task human-required update failed for loop "${current.loop_id}"`, errorMessage(error));
    }
    this.notifyTerminal(current);
    return current;
  }

  private notifyTerminal(loop: AutoIteration): void {
    if (this.terminalListener === undefined) return;
    const listener = this.terminalListener;
    void Promise.resolve()
      .then(() => listener(clone(loop)))
      .catch((error: unknown) => {
        console.warn(`Auto Iterate terminal listener failed for loop "${loop.loop_id}"`, errorMessage(error));
      });
  }

  private async update(loop: AutoIteration, patch: Partial<AutoIteration>): Promise<AutoIteration> {
    return this.store.put(autoIterationSchema.parse({
      ...loop,
      ...patch,
      updated_at: new Date().toISOString(),
    }));
  }

  private serial(loopId: string, operation: () => Promise<AutoIteration>): Promise<AutoIteration> {
    const pending = this.flights.get(loopId);
    if (pending !== undefined) return pending.then((loop) => ({ ...loop }));
    const current = operation();
    this.flights.set(loopId, current);
    void current.finally(() => {
      if (this.flights.get(loopId) === current) this.flights.delete(loopId);
    }).catch(() => undefined);
    return current;
  }

  private required<T>(value: T | undefined, name: string): T {
    if (value === undefined) throw new Error(`Auto iteration checkpoint is missing ${name}.`);
    return value;
  }

  private assertReviewRequest(loop: AutoIteration, request: ReviewRequestContext): void {
    if (request.workspace_id !== loop.workspace_id
      || request.task_id !== loop.task_id
      || request.execution_id !== loop.execution_id
      || request.conversation_id !== loop.conversation_id) {
      throw new Error("Review request identity does not match the loop.");
    }
  }

  private assertDelivery(
    loop: AutoIteration,
    delivery: ReviewDelivery,
    reviewRequestId: string,
    routingId: string,
  ): void {
    if (delivery.workspace_id !== loop.workspace_id
      || delivery.task_id !== loop.task_id
      || delivery.review_request_id !== reviewRequestId
      || delivery.routing_id !== routingId
      || delivery.conversation_id !== loop.conversation_id) {
      throw new Error("Review delivery identity does not match the loop.");
    }
  }
}
