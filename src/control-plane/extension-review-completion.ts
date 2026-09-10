import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { reviewDeliveryIdSchema as reviewDeliveryIdentitySchema } from "../context/review-delivery-schema.js";
import { reviewRequestIdSchema } from "../context/review-schema.js";
import {
  conversationIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";

const STATE_VERSION = 1;
const MAX_COMPLETIONS = 1_000;
export const EXTENSION_REVIEW_COMPLETION_LEASE_MS = 30_000;
export const MAX_REVIEW_COMPLETION_CONTENT_BYTES = 256 * 1024;
const ID = /^[A-Za-z0-9_-]+$/u;
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const safeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger);
const completionContentSchema = z.string()
  .min(1)
  .max(MAX_REVIEW_COMPLETION_CONTENT_BYTES)
  .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_REVIEW_COMPLETION_CONTENT_BYTES, {
    message: "completion content is too large",
  });

const createSchema = z.object({
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  review_request_id: reviewRequestIdSchema,
  review_delivery_id: reviewDeliveryIdentitySchema,
  conversation_id: conversationIdSchema.regex(CONVERSATION_ID),
  expected_user_message_id: z.string().min(1).max(256).regex(MESSAGE_ID),
}).strict();

const ownerSchema = z.object({
  client_id: z.string().min(1).max(128).regex(ID),
  document_id: z.string().min(1).max(256).regex(ID),
  navigation_epoch: safeInteger,
}).strict();

export const extensionReviewCompletionClaimSchema = ownerSchema.extend({
  conversation_id: conversationIdSchema.regex(CONVERSATION_ID),
}).strict();

const ackBaseSchema = extensionReviewCompletionClaimSchema.extend({
  completion_id: z.string().uuid(),
});

export const extensionReviewCompletionAckSchema = z.discriminatedUnion("status", [
  ackBaseSchema.extend({
    status: z.literal("completed"),
    assistant_message_id: z.string().min(1).max(256).regex(MESSAGE_ID),
    content: completionContentSchema,
  }).strict(),
  ackBaseSchema.extend({
    status: z.literal("failed"),
    error: z.string().min(1).max(500),
  }).strict(),
  ackBaseSchema.extend({
    status: z.literal("ambiguous"),
    error: z.string().min(1).max(500),
  }).strict(),
]);

export type ExtensionReviewCompletionInput = z.infer<typeof createSchema>;
export type ExtensionReviewCompletionClaim = z.infer<typeof extensionReviewCompletionClaimSchema>;
export type ExtensionReviewCompletionAck = z.infer<typeof extensionReviewCompletionAckSchema>;
export type ExtensionReviewCompletionPhase = "queued" | "leased" | "completed" | "failed" | "ambiguous";

export interface ExtensionReviewCompletionLease extends ExtensionReviewCompletionClaim {
  readonly claimed_at: number;
  readonly deadline: number;
}

export interface ExtensionReviewCompletionReceipt {
  readonly completion_id: string;
  readonly conversation_id: string;
  readonly client_id: string;
  readonly document_id: string;
  readonly navigation_epoch: number;
  readonly status: "completed" | "failed" | "ambiguous";
  readonly assistant_message_id?: string;
  readonly content?: string;
  readonly error?: string;
  readonly completed_at: number;
}

export interface ExtensionReviewCompletion {
  readonly completion_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly review_request_id: string;
  readonly review_delivery_id: string;
  readonly conversation_id: string;
  readonly expected_user_message_id: string;
  readonly created_at: number;
  readonly phase: ExtensionReviewCompletionPhase;
  readonly lease?: ExtensionReviewCompletionLease;
  readonly receipt?: ExtensionReviewCompletionReceipt;
}

export interface LeasedExtensionReviewCompletion {
  readonly completion_id: string;
  readonly conversation_id: string;
  readonly review_request_id: string;
  readonly expected_user_message_id: string;
  readonly deadline: number;
}

const leaseSchema: z.ZodType<ExtensionReviewCompletionLease> = extensionReviewCompletionClaimSchema.extend({
  claimed_at: safeInteger,
  deadline: safeInteger,
}).strict();

const receiptBaseSchema = z.object({
  completion_id: z.string().uuid(),
  conversation_id: conversationIdSchema.regex(CONVERSATION_ID),
  client_id: z.string().min(1).max(128).regex(ID),
  document_id: z.string().min(1).max(256).regex(ID),
  navigation_epoch: safeInteger,
  completed_at: safeInteger,
}).strict();

const receiptSchema = z.discriminatedUnion("status", [
  receiptBaseSchema.extend({
    status: z.literal("completed"),
    assistant_message_id: z.string().min(1).max(256).regex(MESSAGE_ID),
    content: completionContentSchema,
  }).strict(),
  receiptBaseSchema.extend({
    status: z.literal("failed"),
    error: z.string().min(1).max(500),
  }).strict(),
  receiptBaseSchema.extend({
    status: z.literal("ambiguous"),
    error: z.string().min(1).max(500),
  }).strict(),
 ]) as z.ZodType<ExtensionReviewCompletionReceipt>;

const completionSchema: z.ZodType<ExtensionReviewCompletion> = z.object({
  completion_id: z.string().uuid(),
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  review_request_id: reviewRequestIdSchema,
  review_delivery_id: reviewDeliveryIdentitySchema,
  conversation_id: conversationIdSchema.regex(CONVERSATION_ID),
  expected_user_message_id: z.string().min(1).max(256).regex(MESSAGE_ID),
  created_at: safeInteger,
  phase: z.enum(["queued", "leased", "completed", "failed", "ambiguous"]),
  lease: leaseSchema.optional(),
  receipt: receiptSchema.optional(),
}).strict().superRefine((completion, context) => {
  if ((completion.phase === "leased") !== (completion.lease !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "lease does not match phase" });
  }
  if (completion.lease && (completion.lease.conversation_id !== completion.conversation_id
    || completion.lease.deadline < completion.lease.claimed_at)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "lease identity is invalid" });
  }
  const terminal = completion.phase === "completed"
    || completion.phase === "failed"
    || completion.phase === "ambiguous";
  if (terminal !== (completion.receipt !== undefined)
    || (completion.receipt && completion.receipt.status !== completion.phase)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "receipt does not match phase" });
  }
  if (completion.receipt && (completion.receipt.completion_id !== completion.completion_id
    || completion.receipt.conversation_id !== completion.conversation_id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "receipt identity is invalid" });
  }
});

const stateSchema: z.ZodType<{
  readonly schema_version: typeof STATE_VERSION;
  readonly completions: ExtensionReviewCompletion[];
}> = z.object({
  schema_version: z.literal(STATE_VERSION),
  completions: z.array(completionSchema).max(MAX_COMPLETIONS),
}).strict().superRefine((state, context) => {
  const completionIds = new Set<string>();
  const reviewRequestIds = new Set<string>();
  state.completions.forEach((completion, index) => {
    if (completionIds.has(completion.completion_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completions", index, "completion_id"],
        message: "completion id is duplicated",
      });
    }
    completionIds.add(completion.completion_id);
    if (reviewRequestIds.has(completion.review_request_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completions", index, "review_request_id"],
        message: "review request id is duplicated",
      });
    }
    reviewRequestIds.add(completion.review_request_id);
  });
});

export function extensionReviewCompletionStateFile(storageRoot: string): string {
  return join(resolve(storageRoot), "control-plane", "extension-review-completions.json");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameOwner(
  lease: ExtensionReviewCompletionLease,
  owner: ExtensionReviewCompletionClaim,
): boolean {
  return lease.conversation_id === owner.conversation_id
    && lease.client_id === owner.client_id
    && lease.document_id === owner.document_id
    && lease.navigation_epoch === owner.navigation_epoch;
}

function sameInput(
  completion: ExtensionReviewCompletion,
  input: ExtensionReviewCompletionInput,
): boolean {
  return completion.workspace_id === input.workspace_id
    && completion.task_id === input.task_id
    && completion.review_request_id === input.review_request_id
    && completion.review_delivery_id === input.review_delivery_id
    && completion.conversation_id === input.conversation_id
    && completion.expected_user_message_id === input.expected_user_message_id;
}

function leased(completion: ExtensionReviewCompletion): LeasedExtensionReviewCompletion {
  if (completion.lease === undefined) throw new Error("completion lease is missing");
  return {
    completion_id: completion.completion_id,
    conversation_id: completion.conversation_id,
    review_request_id: completion.review_request_id,
    expected_user_message_id: completion.expected_user_message_id,
    deadline: completion.lease.deadline,
  };
}

function receiptFor(
  ack: ExtensionReviewCompletionAck,
  completedAt: number,
): ExtensionReviewCompletionReceipt {
  return {
    completion_id: ack.completion_id,
    conversation_id: ack.conversation_id,
    client_id: ack.client_id,
    document_id: ack.document_id,
    navigation_epoch: ack.navigation_epoch,
    status: ack.status,
    ...(ack.status === "completed"
      ? { assistant_message_id: ack.assistant_message_id, content: ack.content }
      : { error: ack.error }),
    completed_at: completedAt,
  };
}

function sameReceipt(
  receipt: ExtensionReviewCompletionReceipt,
  ack: ExtensionReviewCompletionAck,
): boolean {
  const candidate = receiptFor(ack, receipt.completed_at);
  return receipt.completion_id === candidate.completion_id
    && receipt.conversation_id === candidate.conversation_id
    && receipt.client_id === candidate.client_id
    && receipt.document_id === candidate.document_id
    && receipt.navigation_epoch === candidate.navigation_epoch
    && receipt.status === candidate.status
    && receipt.assistant_message_id === candidate.assistant_message_id
    && receipt.content === candidate.content
    && receipt.error === candidate.error
    && receipt.completed_at === candidate.completed_at;
}

export class ExtensionReviewCompletionConflictError extends Error {}
export class ExtensionReviewCompletionNotFoundError extends Error {}
export class ExtensionReviewCompletionUnavailableError extends Error {}

export class ExtensionReviewCompletionService {
  public readonly storageRoot: string;
  private readonly file: string;
  private completions = new Map<string, ExtensionReviewCompletion>();
  private readonly waiters = new Map<string, Set<(receipt: ExtensionReviewCompletionReceipt) => void>>();
  private restorePromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.storageRoot = resolve(storageRoot);
    this.file = extensionReviewCompletionStateFile(this.storageRoot);
  }

  public restore(): Promise<void> {
    this.restorePromise ??= this.exclusive(async () => {
      let raw: string;
      try {
        raw = await readFile(this.file, "utf8");
      } catch (error: unknown) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new ExtensionReviewCompletionUnavailableError(
          "extension review completion state could not be restored",
          { cause: error },
        );
      }
      try {
        const state = stateSchema.parse(JSON.parse(raw));
        this.completions = new Map(state.completions.map((completion) => [
          completion.completion_id,
          completion,
        ]));
      } catch (error: unknown) {
        throw new ExtensionReviewCompletionUnavailableError(
          "extension review completion state could not be restored",
          { cause: error },
        );
      }
    });
    return this.restorePromise;
  }

  public async enqueue(input: ExtensionReviewCompletionInput): Promise<ExtensionReviewCompletion> {
    await this.restore();
    const parsed = createSchema.parse(input);
    return this.exclusive(async () => {
      const next = new Map(this.completions);
      const existing = [...next.values()].find((completion) =>
        completion.review_request_id === parsed.review_request_id);
      if (existing !== undefined) {
        if (!sameInput(existing, parsed)) {
          throw new ExtensionReviewCompletionConflictError(
            "review request already targets different completion identity",
          );
        }
        return clone(existing);
      }
      if (next.size >= MAX_COMPLETIONS) throw new Error("extension review completion queue is full");
      const completion: ExtensionReviewCompletion = {
        completion_id: randomUUID(),
        ...parsed,
        created_at: Date.now(),
        phase: "queued",
      };
      next.set(completion.completion_id, completion);
      await this.persist(next);
      this.completions = next;
      return clone(completion);
    });
  }

  public async get(completionId: string): Promise<ExtensionReviewCompletion | null> {
    await this.restore();
    const parsedId = z.string().uuid().parse(completionId);
    const completion = this.completions.get(parsedId);
    return completion === undefined ? null : clone(completion);
  }

  public async getByReviewRequestId(
    reviewRequestId: string,
  ): Promise<ExtensionReviewCompletion | null> {
    await this.restore();
    const parsedId = reviewRequestIdSchema.parse(reviewRequestId);
    const completion = [...this.completions.values()].find((candidate) =>
      candidate.review_request_id === parsedId);
    return completion === undefined ? null : clone(completion);
  }

  public async claim(
    input: ExtensionReviewCompletionClaim,
  ): Promise<LeasedExtensionReviewCompletion | null> {
    await this.restore();
    const owner = extensionReviewCompletionClaimSchema.parse(input);
    return this.exclusive(async () => {
      const now = Date.now();
      const next = new Map(this.completions);
      let changed = false;
      for (const completion of next.values()) {
        if (completion.phase !== "leased" || completion.lease === undefined) continue;
        if (completion.lease.deadline <= now) {
          next.set(completion.completion_id, { ...completion, phase: "queued", lease: undefined });
          changed = true;
          continue;
        }
        if (sameOwner(completion.lease, owner)) {
          if (changed) {
            await this.persist(next);
            this.completions = next;
          }
          return leased(completion);
        }
      }

      const completion = [...next.values()].find((candidate) =>
        candidate.phase === "queued" && candidate.conversation_id === owner.conversation_id);
      if (completion === undefined) {
        if (changed) {
          await this.persist(next);
          this.completions = next;
        }
        return null;
      }

      const lease: ExtensionReviewCompletionLease = {
        ...owner,
        claimed_at: now,
        deadline: now + EXTENSION_REVIEW_COMPLETION_LEASE_MS,
      };
      const leasedCompletion: ExtensionReviewCompletion = {
        ...completion,
        phase: "leased",
        lease,
      };
      next.set(completion.completion_id, leasedCompletion);
      await this.persist(next);
      this.completions = next;
      return leased(leasedCompletion);
    });
  }

  public async acknowledge(input: ExtensionReviewCompletionAck): Promise<{
    readonly accepted: "new" | "existing";
    readonly receipt: ExtensionReviewCompletionReceipt;
  }> {
    await this.restore();
    const ack = extensionReviewCompletionAckSchema.parse(input);
    return this.exclusive(async () => {
      const current = this.completions.get(ack.completion_id);
      if (current === undefined) {
        throw new ExtensionReviewCompletionNotFoundError("completion not found");
      }
      if (current.receipt !== undefined) {
        if (!sameReceipt(current.receipt, ack)) {
          throw new ExtensionReviewCompletionConflictError("conflicting completion receipt");
        }
        return { accepted: "existing", receipt: clone(current.receipt) };
      }
      if (current.phase !== "leased" || current.lease === undefined
        || current.lease.deadline <= Date.now() || !sameOwner(current.lease, ack)) {
        throw new ExtensionReviewCompletionConflictError("completion lease owner changed");
      }
      const receipt = receiptFor(ack, Date.now());
      const next = new Map(this.completions);
      next.set(current.completion_id, {
        ...current,
        phase: receipt.status,
        lease: undefined,
        receipt,
      });
      await this.persist(next);
      this.completions = next;
      this.wake(receipt);
      return { accepted: "new", receipt: clone(receipt) };
    });
  }

  public async awaitResult(
    completionId: string,
    timeoutMs: number,
  ): Promise<ExtensionReviewCompletionReceipt | null> {
    await this.restore();
    const parsedId = z.string().uuid().parse(completionId);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error("completion await timeoutMs must be a non-negative integer");
    }
    const registration = await this.exclusive<{
      readonly receipt: ExtensionReviewCompletionReceipt | null;
      readonly pending: Promise<ExtensionReviewCompletionReceipt | null> | null;
    }>(() => {
      const completion = this.completions.get(parsedId);
      if (completion?.receipt !== undefined || timeoutMs === 0) {
        return Promise.resolve({
          receipt: completion?.receipt === undefined ? null : clone(completion.receipt),
          pending: null,
        });
      }

      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      let resolveWait!: (receipt: ExtensionReviewCompletionReceipt | null) => void;
      const pending = new Promise<ExtensionReviewCompletionReceipt | null>((resolveWaiter) => {
        resolveWait = resolveWaiter;
      });
      const held = this.waiters.get(parsedId) ?? new Set();
      const finish = (receipt: ExtensionReviewCompletionReceipt | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        held.delete(onReceipt);
        if (held.size === 0) this.waiters.delete(parsedId);
        resolveWait(receipt === null ? null : clone(receipt));
      };
      const onReceipt = (receipt: ExtensionReviewCompletionReceipt): void => finish(receipt);
      held.add(onReceipt);
      this.waiters.set(parsedId, held);
      timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
      return Promise.resolve({ receipt: null, pending });
    });
    return registration.pending ?? registration.receipt;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private wake(receipt: ExtensionReviewCompletionReceipt): void {
    const held = this.waiters.get(receipt.completion_id);
    if (!held) return;
    this.waiters.delete(receipt.completion_id);
    for (const resolveWait of held) resolveWait(receipt);
  }

  private async persist(completions: Map<string, ExtensionReviewCompletion>): Promise<void> {
    const directory = dirname(this.file);
    const temporary = join(directory, `.extension-review-completions-${process.pid}-${randomUUID()}.tmp`);
    const snapshot = `${JSON.stringify({
      schema_version: STATE_VERSION,
      completions: [...completions.values()],
    }, null, 2)}\n`;
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
