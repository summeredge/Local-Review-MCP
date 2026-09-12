import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { defaultTaskContextStorageRoot } from "../context/task.js";

const STATE_VERSION = 1;
const MAX_DELIVERIES = 1_000;
const LEASE_MS = 30_000;
const ID = /^[A-Za-z0-9_-]+$/u;
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const logicalDeliveryIdSchema = z.string().min(1).max(128);

const enqueueSchema = z.object({
  conversation_id: z.string().min(1).max(256).regex(CONVERSATION_ID),
  message: z.string().min(1).max(48 * 1024),
  logical_delivery_id: logicalDeliveryIdSchema.optional(),
}).strict();

const ownerSchema = z.object({
  client_id: z.string().min(1).max(128).regex(ID),
  document_id: z.string().min(1).max(256).regex(ID),
  navigation_epoch: z.number().int().nonnegative().refine(Number.isSafeInteger),
}).strict();

export const extensionDeliveryClaimSchema = ownerSchema.extend({
  conversation_id: z.string().min(1).max(256).regex(CONVERSATION_ID),
}).strict();

const ackBaseSchema = extensionDeliveryClaimSchema.extend({
  delivery_id: z.string().uuid(),
});

export const extensionDeliveryAckSchema = z.discriminatedUnion("status", [
  ackBaseSchema.extend({
    status: z.literal("sent"),
    message_id: z.string().min(1).max(256).regex(ID),
  }).strict(),
  ackBaseSchema.extend({
    status: z.literal("not_sent"),
    error: z.string().min(1).max(500),
  }).strict(),
  ackBaseSchema.extend({
    status: z.literal("ambiguous"),
    error: z.string().min(1).max(500),
  }).strict(),
]);

export type ExtensionDeliveryClaim = z.infer<typeof extensionDeliveryClaimSchema>;
export type ExtensionDeliveryAck = z.infer<typeof extensionDeliveryAckSchema>;
export type ExtensionDeliveryPhase = "queued" | "leased" | "delivered" | "failed" | "ambiguous";

export interface ExtensionDeliveryLease extends ExtensionDeliveryClaim {
  readonly claimed_at: number;
  readonly deadline: number;
}

export interface ExtensionDeliveryReceipt extends ExtensionDeliveryClaim {
  readonly delivery_id: string;
  readonly status: "delivered" | "failed" | "ambiguous";
  readonly message_id?: string;
  readonly error?: string;
  readonly completed_at: number;
}

export interface ExtensionDelivery {
  readonly delivery_id: string;
  readonly logical_delivery_id?: string;
  readonly conversation_id: string;
  readonly message: string;
  readonly created_at: number;
  readonly phase: ExtensionDeliveryPhase;
  readonly lease?: ExtensionDeliveryLease;
  readonly receipt?: ExtensionDeliveryReceipt;
}

export interface LeasedExtensionDelivery {
  readonly delivery_id: string;
  readonly conversation_id: string;
  readonly message: string;
  readonly deadline: number;
}

export interface ExtensionDeliveryReadiness {
  readonly ready: boolean;
  readonly reason?: string;
}

export type ExtensionDeliveryReadinessCheck = (
  conversationId: string,
) => ExtensionDeliveryReadiness | boolean | Promise<ExtensionDeliveryReadiness | boolean>;

const leaseSchema = extensionDeliveryClaimSchema.extend({
  claimed_at: z.number().int().nonnegative().refine(Number.isSafeInteger),
  deadline: z.number().int().nonnegative().refine(Number.isSafeInteger),
}).strict();

const receiptBaseSchema = extensionDeliveryClaimSchema.extend({
  delivery_id: z.string().uuid(),
  completed_at: z.number().int().nonnegative().refine(Number.isSafeInteger),
});

const receiptSchema = z.discriminatedUnion("status", [
  receiptBaseSchema.extend({
    status: z.literal("delivered"),
    message_id: z.string().min(1).max(256).regex(ID),
  }).strict(),
  receiptBaseSchema.extend({
    status: z.literal("failed"),
    error: z.string().min(1).max(500),
  }).strict(),
  receiptBaseSchema.extend({
    status: z.literal("ambiguous"),
    error: z.string().min(1).max(500),
  }).strict(),
]);

const deliverySchema = z.object({
  delivery_id: z.string().uuid(),
  logical_delivery_id: z.string().min(1).max(128).optional(),
  conversation_id: z.string().min(1).max(256).regex(CONVERSATION_ID),
  message: z.string().min(1).max(48 * 1024),
  created_at: z.number().int().nonnegative().refine(Number.isSafeInteger),
  phase: z.enum(["queued", "leased", "delivered", "failed", "ambiguous"]),
  lease: leaseSchema.optional(),
  receipt: receiptSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.phase === "leased") !== (value.lease !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "lease does not match phase" });
  }
  if (value.lease && (value.lease.conversation_id !== value.conversation_id
    || value.lease.deadline < value.lease.claimed_at)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "lease identity is invalid" });
  }
  const terminal = value.phase === "delivered" || value.phase === "failed" || value.phase === "ambiguous";
  if (terminal !== (value.receipt !== undefined) || (value.receipt && value.receipt.status !== value.phase)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "receipt does not match phase" });
  }
  if (value.receipt && (value.receipt.delivery_id !== value.delivery_id
    || value.receipt.conversation_id !== value.conversation_id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "receipt identity is invalid" });
  }
});

const stateSchema = z.object({
  schema_version: z.literal(STATE_VERSION),
  deliveries: z.array(deliverySchema).max(MAX_DELIVERIES),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const logicalIds = new Set<string>();
  value.deliveries.forEach((delivery, index) => {
    if (ids.has(delivery.delivery_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deliveries", index, "delivery_id"],
        message: "delivery id is duplicated",
      });
    }
    ids.add(delivery.delivery_id);
    if (delivery.logical_delivery_id !== undefined) {
      if (logicalIds.has(delivery.logical_delivery_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deliveries", index, "logical_delivery_id"],
          message: "logical delivery id is duplicated",
        });
      }
      logicalIds.add(delivery.logical_delivery_id);
    }
  });
});

function stateFile(storageRoot: string): string {
  return join(resolve(storageRoot), "control-plane", "extension-deliveries.json");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameOwner(lease: ExtensionDeliveryLease, owner: ExtensionDeliveryClaim): boolean {
  return lease.conversation_id === owner.conversation_id
    && lease.client_id === owner.client_id
    && lease.document_id === owner.document_id
    && lease.navigation_epoch === owner.navigation_epoch;
}

function receiptFor(ack: ExtensionDeliveryAck, completedAt: number): ExtensionDeliveryReceipt {
  return {
    delivery_id: ack.delivery_id,
    conversation_id: ack.conversation_id,
    client_id: ack.client_id,
    document_id: ack.document_id,
    navigation_epoch: ack.navigation_epoch,
    status: ack.status === "sent" ? "delivered" : ack.status === "not_sent" ? "failed" : "ambiguous",
    ...(ack.status === "sent" ? { message_id: ack.message_id } : { error: ack.error }),
    completed_at: completedAt,
  };
}

function sameReceipt(receipt: ExtensionDeliveryReceipt, ack: ExtensionDeliveryAck): boolean {
  const candidate = receiptFor(ack, receipt.completed_at);
  return receipt.delivery_id === candidate.delivery_id
    && receipt.conversation_id === candidate.conversation_id
    && receipt.client_id === candidate.client_id
    && receipt.document_id === candidate.document_id
    && receipt.navigation_epoch === candidate.navigation_epoch
    && receipt.status === candidate.status
    && receipt.message_id === candidate.message_id
    && receipt.error === candidate.error
    && receipt.completed_at === candidate.completed_at;
}

export class ExtensionDeliveryConflictError extends Error {}
export class ExtensionDeliveryNotFoundError extends Error {}
export class ExtensionDeliveryNotReadyError extends Error {}
export class ExtensionDeliveryUnavailableError extends Error {}

export class ExtensionDeliveryService {
  public readonly storageRoot: string;
  private readonly file: string;
  private deliveries = new Map<string, ExtensionDelivery>();
  private readonly waiters = new Map<string, Set<(receipt: ExtensionDeliveryReceipt) => void>>();
  private restorePromise: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.storageRoot = resolve(storageRoot);
    this.file = stateFile(this.storageRoot);
  }

  public restore(): Promise<void> {
    this.restorePromise ??= this.exclusive(async () => {
      let raw: string;
      try {
        raw = await readFile(this.file, "utf8");
      } catch (error: unknown) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new ExtensionDeliveryUnavailableError("extension delivery state could not be restored", { cause: error });
      }
      try {
        const state = stateSchema.parse(JSON.parse(raw));
        this.deliveries = new Map(state.deliveries.map((delivery) => [delivery.delivery_id, delivery]));
      } catch (error: unknown) {
        throw new ExtensionDeliveryUnavailableError("extension delivery state could not be restored", { cause: error });
      }
    });
    return this.restorePromise;
  }

  public async enqueue(
    conversationId: string,
    message: string,
    logicalDeliveryId?: string,
  ): Promise<ExtensionDelivery> {
    await this.restore();
    const parsed = enqueueSchema.parse({
      conversation_id: conversationId,
      message,
      ...(logicalDeliveryId === undefined ? {} : { logical_delivery_id: logicalDeliveryId }),
    });
    return this.exclusive(async () => {
      const next = new Map(this.deliveries);
      if (parsed.logical_delivery_id !== undefined) {
        const existing = [...next.values()].find((delivery) =>
          delivery.logical_delivery_id === parsed.logical_delivery_id);
        if (existing !== undefined) {
          if (existing.conversation_id !== parsed.conversation_id || existing.message !== parsed.message) {
            throw new ExtensionDeliveryConflictError("logical delivery command already targets different content");
          }
          return clone(existing);
        }
      }
      while (next.size >= MAX_DELIVERIES) {
        const terminal = [...next.values()].find((delivery) =>
          delivery.receipt !== undefined && delivery.logical_delivery_id === undefined);
        if (!terminal) throw new Error("extension delivery queue is full");
        next.delete(terminal.delivery_id);
      }
      const delivery: ExtensionDelivery = {
        delivery_id: randomUUID(),
        ...parsed,
        created_at: Date.now(),
        phase: "queued",
      };
      next.set(delivery.delivery_id, delivery);
      await this.persist(next);
      this.deliveries = next;
      return clone(delivery);
    });
  }

  public async claim(input: ExtensionDeliveryClaim): Promise<LeasedExtensionDelivery | null> {
    await this.restore();
    const owner = extensionDeliveryClaimSchema.parse(input);
    return this.exclusive(async () => {
      const now = Date.now();
      const next = new Map(this.deliveries);
      let changed = false;
      for (const delivery of next.values()) {
        if (delivery.conversation_id !== owner.conversation_id || delivery.phase !== "leased") continue;
        if (delivery.lease && sameOwner(delivery.lease, owner) && delivery.lease.deadline > now) {
          return {
            delivery_id: delivery.delivery_id,
            conversation_id: delivery.conversation_id,
            message: delivery.message,
            deadline: delivery.lease.deadline,
          };
        }
        if (delivery.lease && delivery.lease.deadline <= now) {
          next.set(delivery.delivery_id, { ...delivery, phase: "queued", lease: undefined });
          changed = true;
        }
      }
      const delivery = [...next.values()].find((candidate) =>
        candidate.phase === "queued" && candidate.conversation_id === owner.conversation_id);
      if (!delivery) {
        if (changed) {
          await this.persist(next);
          this.deliveries = next;
        }
        return null;
      }
      const lease: ExtensionDeliveryLease = {
        ...owner,
        claimed_at: now,
        deadline: now + LEASE_MS,
      };
      const leased: ExtensionDelivery = { ...delivery, phase: "leased", lease };
      next.set(delivery.delivery_id, leased);
      await this.persist(next);
      this.deliveries = next;
      return {
        delivery_id: leased.delivery_id,
        conversation_id: leased.conversation_id,
        message: leased.message,
        deadline: lease.deadline,
      };
    });
  }

  public async acknowledge(input: ExtensionDeliveryAck): Promise<{
    readonly accepted: "new" | "existing";
    readonly receipt: ExtensionDeliveryReceipt;
  }> {
    await this.restore();
    const ack = extensionDeliveryAckSchema.parse(input);
    return this.exclusive(async () => {
      const current = this.deliveries.get(ack.delivery_id);
      if (!current) throw new ExtensionDeliveryNotFoundError("delivery not found");
      if (current.receipt) {
        if (!sameReceipt(current.receipt, ack)) throw new ExtensionDeliveryConflictError("conflicting delivery receipt");
        return { accepted: "existing", receipt: clone(current.receipt) };
      }
      if (current.phase !== "leased" || !current.lease || !sameOwner(current.lease, ack)) {
        throw new ExtensionDeliveryConflictError("delivery lease owner changed");
      }
      const receipt = receiptFor(ack, Date.now());
      const next = new Map(this.deliveries);
      next.set(current.delivery_id, {
        ...current,
        phase: receipt.status,
        lease: undefined,
        receipt,
      });
      await this.persist(next);
      this.deliveries = next;
      this.wake(receipt);
      return { accepted: "new", receipt: clone(receipt) };
    });
  }

  public async get(deliveryId: string): Promise<ExtensionDelivery | null> {
    await this.restore();
    const delivery = this.deliveries.get(z.string().uuid().parse(deliveryId));
    return delivery ? clone(delivery) : null;
  }

  public async getByLogicalDeliveryId(logicalDeliveryId: string): Promise<ExtensionDelivery | null> {
    await this.restore();
    const parsedId = logicalDeliveryIdSchema.parse(logicalDeliveryId);
    const delivery = [...this.deliveries.values()].find((candidate) =>
      candidate.logical_delivery_id === parsedId);
    return delivery ? clone(delivery) : null;
  }

  public async awaitResult(deliveryId: string, timeoutMs: number): Promise<ExtensionDeliveryReceipt | null> {
    await this.restore();
    const parsedDeliveryId = z.string().uuid().parse(deliveryId);
    const registration = await this.exclusive<{
      readonly receipt: ExtensionDeliveryReceipt | null;
      readonly pending: Promise<ExtensionDeliveryReceipt | null> | null;
    }>(() => {
      const delivery = this.deliveries.get(parsedDeliveryId);
      if (delivery?.receipt || timeoutMs <= 0) {
        return Promise.resolve({
          receipt: delivery?.receipt ? clone(delivery.receipt) : null,
          pending: null,
        });
      }

      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      let resolveWait!: (receipt: ExtensionDeliveryReceipt | null) => void;
      const pending = new Promise<ExtensionDeliveryReceipt | null>((resolveWaiter) => {
        resolveWait = resolveWaiter;
      });
      const held = this.waiters.get(parsedDeliveryId) ?? new Set();
      const finish = (receipt: ExtensionDeliveryReceipt | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        held.delete(onReceipt);
        if (held.size === 0) this.waiters.delete(parsedDeliveryId);
        resolveWait(receipt ? clone(receipt) : null);
      };
      const onReceipt = (receipt: ExtensionDeliveryReceipt): void => finish(receipt);
      held.add(onReceipt);
      this.waiters.set(parsedDeliveryId, held);
      timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
      return Promise.resolve({ receipt: null, pending });
    });
    return registration.pending ?? registration.receipt;
  }

  public async expire(deliveryId: string): Promise<ExtensionDeliveryReceipt | null> {
    await this.restore();
    const parsedDeliveryId = z.string().uuid().parse(deliveryId);
    return this.exclusive(async () => {
      const current = this.deliveries.get(parsedDeliveryId);
      if (current === undefined || current.receipt !== undefined) {
        return current?.receipt === undefined ? null : clone(current.receipt);
      }

      const next = new Map(this.deliveries);
      if (current.phase === "queued") {
        next.delete(parsedDeliveryId);
        await this.persist(next);
        this.deliveries = next;
        return null;
      }

      if (current.lease === undefined) {
        throw new ExtensionDeliveryUnavailableError("extension delivery lease is missing");
      }
      const receipt: ExtensionDeliveryReceipt = {
        delivery_id: current.delivery_id,
        conversation_id: current.conversation_id,
        client_id: current.lease.client_id,
        document_id: current.lease.document_id,
        navigation_epoch: current.lease.navigation_epoch,
        status: "ambiguous",
        error: "Extension Delivery timed out before an acknowledgement was recorded.",
        completed_at: Date.now(),
      };
      next.set(parsedDeliveryId, {
        ...current,
        phase: "ambiguous",
        lease: undefined,
        receipt,
      });
      await this.persist(next);
      this.deliveries = next;
      this.wake(receipt);
      return null;
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private wake(receipt: ExtensionDeliveryReceipt): void {
    const held = this.waiters.get(receipt.delivery_id);
    if (!held) return;
    this.waiters.delete(receipt.delivery_id);
    for (const resolveWait of held) resolveWait(receipt);
  }

  private async persist(deliveries: Map<string, ExtensionDelivery>): Promise<void> {
    const directory = dirname(this.file);
    const temporary = join(directory, `.extension-deliveries-${process.pid}-${randomUUID()}.tmp`);
    const snapshot = `${JSON.stringify({
      schema_version: STATE_VERSION,
      deliveries: [...deliveries.values()],
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
