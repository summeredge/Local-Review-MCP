import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateWorkspaceIdentityConsistency } from "../workspace/identity.js";
import { WorkspacePathError } from "../workspace/path.js";
import type { WorkspaceIdentity } from "../workspace/types.js";
import { ConversationRoutingService } from "./conversation-routing-service.js";
import {
  CONVERSATION_ROUTINGS_DIRECTORY,
  type ConversationRouting,
} from "./conversation-routing.js";
import { defaultTaskContextStorageRoot } from "./task.js";
import {
  createDeliveryId,
  reviewDeliveriesDirectory,
  reviewDeliveryFile,
  type CreateReviewDeliveryInput,
  type ReviewDelivery,
  type ReviewDeliveryError,
} from "./review-delivery.js";
import {
  createReviewDeliveryInputSchema,
  markReviewDeliveryFailedInputSchema,
  reviewDeliveryTimestampSchema,
  reviewDeliverySchema,
} from "./review-delivery-schema.js";
import { conversationRoutingIdSchema } from "./conversation-routing-schema.js";
import { workspaceIdSchema } from "./schema.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function json(delivery: ReviewDelivery): string {
  return `${JSON.stringify(delivery, null, 2)}\n`;
}

function workspaceMismatch(message: string): WorkspacePathError {
  return new WorkspacePathError(
    "WORKSPACE_IDENTITY_MISMATCH",
    `WORKSPACE_IDENTITY_MISMATCH: ${message}`,
  );
}

export class ReviewDeliveryService {
  public readonly storageRoot: string;
  private readonly runtimeIdentity: WorkspaceIdentity | undefined;
  private readonly routings: ConversationRoutingService;

  public constructor(
    storageRoot = defaultTaskContextStorageRoot(),
    runtimeIdentity?: WorkspaceIdentity,
  ) {
    this.storageRoot = resolve(storageRoot);
    this.runtimeIdentity = runtimeIdentity;
    this.routings = new ConversationRoutingService(this.storageRoot, runtimeIdentity);
  }

  public async createDelivery(input: CreateReviewDeliveryInput): Promise<ReviewDelivery> {
    const parsed = createReviewDeliveryInputSchema.parse(input);
    this.validateRuntimeIdentity(parsed.workspace_id, this.runtimeIdentity);

    const routing = await this.routingForDelivery(parsed.workspace_id, parsed.routing_id);
    this.assertRoutingLinks(parsed, routing);
    await this.routings.validateRouting(routing, this.runtimeIdentity);

    const existing = await this.findDeliveryByRouting(parsed.workspace_id, parsed.routing_id);
    if (existing !== null) {
      if (parsed.delivery_id !== undefined && parsed.delivery_id !== existing.delivery_id) {
        throw new Error(
          `Routing "${parsed.routing_id}" is already associated with delivery "${existing.delivery_id}".`,
        );
      }
      await this.validateDelivery(existing, this.runtimeIdentity);
      return existing;
    }

    const timestamp = new Date().toISOString();
    const delivery = reviewDeliverySchema.parse({
      ...parsed,
      delivery_id: parsed.delivery_id ?? createDeliveryId(),
      status: "pending",
      attempt_count: 0,
      created_at: timestamp,
      updated_at: timestamp,
    });
    await this.validateDelivery(delivery, this.runtimeIdentity);

    const directory = reviewDeliveriesDirectory(this.storageRoot, delivery.workspace_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        reviewDeliveryFile(this.storageRoot, delivery.workspace_id, delivery.delivery_id),
        json(delivery),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Review delivery "${delivery.delivery_id}" already exists.`, { cause: error });
      }
      throw new Error("Review delivery could not be saved.", { cause: error });
    }
    return delivery;
  }

  public async getDelivery(
    workspaceId: string,
    deliveryId: string,
  ): Promise<ReviewDelivery | null> {
    const file = reviewDeliveryFile(this.storageRoot, workspaceId, deliveryId);
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Review delivery could not be read.", { cause: error });
    }

    try {
      return reviewDeliverySchema.parse(JSON.parse(contents) as unknown);
    } catch (error: unknown) {
      throw new Error(`Review delivery "${deliveryId}" is invalid.`, { cause: error });
    }
  }

  public async getDeliveryByRouting(
    workspaceId: string,
    routingId: string,
  ): Promise<ReviewDelivery | null> {
    this.validateRuntimeIdentity(workspaceId, this.runtimeIdentity);
    return this.findDeliveryByRouting(
      workspaceId,
      conversationRoutingIdSchema.parse(routingId),
    );
  }

  public async beginDeliveryAttempt(
    workspaceId: string,
    deliveryId: string,
  ): Promise<ReviewDelivery> {
    const current = await this.requiredDelivery(workspaceId, deliveryId);
    await this.validateDelivery(current, this.runtimeIdentity);
    if (current.status !== "pending" && current.status !== "failed") {
      throw new Error(`Review delivery cannot begin from status "${current.status}".`);
    }

    const { last_error: _lastError, delivered_at: _deliveredAt, ...base } = current;
    const next = reviewDeliverySchema.parse({
      ...base,
      status: "delivering",
      attempt_count: current.attempt_count + 1,
      updated_at: new Date().toISOString(),
    });
    return this.saveUpdatedDelivery(next);
  }

  public async markDelivered(
    workspaceId: string,
    deliveryId: string,
    deliveredAt?: string,
  ): Promise<ReviewDelivery> {
    const current = await this.requiredDelivery(workspaceId, deliveryId);
    await this.validateDelivery(current, this.runtimeIdentity);
    if (current.status !== "delivering") {
      throw new Error(`Review delivery cannot be marked delivered from status "${current.status}".`);
    }

    const { last_error: _lastError, delivered_at: _previousDeliveredAt, ...base } = current;
    const timestamp = reviewDeliveryTimestampSchema.parse(deliveredAt ?? new Date().toISOString());
    const next = reviewDeliverySchema.parse({
      ...base,
      status: "delivered",
      updated_at: timestamp,
      delivered_at: timestamp,
    });
    return this.saveUpdatedDelivery(next);
  }

  public async markFailed(
    workspaceId: string,
    deliveryId: string,
    error: ReviewDeliveryError,
  ): Promise<ReviewDelivery> {
    const current = await this.requiredDelivery(workspaceId, deliveryId);
    await this.validateDelivery(current, this.runtimeIdentity);
    if (current.status !== "delivering") {
      throw new Error(`Review delivery cannot be marked failed from status "${current.status}".`);
    }

    const parsedError = markReviewDeliveryFailedInputSchema.parse(error);
    const { last_error: _previousError, delivered_at: _deliveredAt, ...base } = current;
    const next = reviewDeliverySchema.parse({
      ...base,
      status: "failed",
      last_error: parsedError,
      updated_at: new Date().toISOString(),
    });
    return this.saveUpdatedDelivery(next);
  }

  public async validateDelivery(
    delivery: ReviewDelivery,
    runtimeIdentity: WorkspaceIdentity | undefined = this.runtimeIdentity,
  ): Promise<void> {
    const parsed = reviewDeliverySchema.parse(delivery);
    this.validateRuntimeIdentity(parsed.workspace_id, runtimeIdentity);
    const routing = await this.routingForDelivery(parsed.workspace_id, parsed.routing_id);
    this.assertRoutingLinks(parsed, routing);
    await this.routings.validateRouting(routing, runtimeIdentity);
  }

  private async requiredDelivery(workspaceId: string, deliveryId: string): Promise<ReviewDelivery> {
    const delivery = await this.getDelivery(workspaceId, deliveryId);
    if (delivery === null) throw new Error(`Review delivery "${deliveryId}" was not found.`);
    return delivery;
  }

  private async saveUpdatedDelivery(delivery: ReviewDelivery): Promise<ReviewDelivery> {
    try {
      await writeFile(
        reviewDeliveryFile(this.storageRoot, delivery.workspace_id, delivery.delivery_id),
        json(delivery),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error: unknown) {
      throw new Error("Review delivery could not be saved.", { cause: error });
    }
    return delivery;
  }

  private async findDeliveryByRouting(
    workspaceId: string,
    routingId: string,
  ): Promise<ReviewDelivery | null> {
    const directory = reviewDeliveriesDirectory(this.storageRoot, workspaceId);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Review deliveries could not be inspected.", { cause: error });
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const deliveryId = entry.name.slice(0, -".json".length);
      const delivery = await this.getDelivery(workspaceId, deliveryId);
      if (delivery?.routing_id === routingId) return delivery;
    }
    return null;
  }

  private async routingForDelivery(
    workspaceId: string,
    routingId: string,
  ): Promise<ConversationRouting> {
    const routing = await this.routings.getRouting(workspaceId, routingId);
    if (routing !== null) return routing;

    const elsewhere = await this.findRouting(routingId);
    if (elsewhere !== null) {
      throw workspaceMismatch("Conversation routing belongs to another workspace.");
    }
    throw new Error(`Conversation routing "${routingId}" was not found.`);
  }

  private async findRouting(routingId: string): Promise<ConversationRouting | null> {
    const root = join(this.storageRoot, CONVERSATION_ROUTINGS_DIRECTORY);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Conversation routings could not be inspected.", { cause: error });
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !workspaceIdSchema.safeParse(entry.name).success) continue;
      const routing = await this.routings.getRouting(entry.name, routingId);
      if (routing !== null) return routing;
    }
    return null;
  }

  private assertRoutingLinks(
    delivery: Pick<ReviewDelivery, "workspace_id" | "task_id" | "review_request_id" | "routing_id" | "conversation_id">,
    routing: ConversationRouting,
  ): void {
    if (routing.workspace_id !== delivery.workspace_id) {
      throw workspaceMismatch("Conversation routing does not belong to the delivery workspace.");
    }
    if (routing.task_id !== delivery.task_id) {
      throw new Error("Review delivery task does not match the conversation routing.");
    }
    if (routing.review_request_id !== delivery.review_request_id) {
      throw new Error("Review delivery request does not match the conversation routing.");
    }
    if (routing.routing_id !== delivery.routing_id) {
      throw new Error("Review delivery routing id does not match the conversation routing.");
    }
    if (routing.conversation_id !== delivery.conversation_id) {
      throw new Error("Review delivery conversation does not match the conversation routing.");
    }
  }

  private validateRuntimeIdentity(
    workspaceId: string,
    runtimeIdentity: WorkspaceIdentity | undefined,
  ): void {
    if (runtimeIdentity === undefined) return;
    validateWorkspaceIdentityConsistency(
      { ...runtimeIdentity, id: workspaceId },
      runtimeIdentity,
    );
  }
}
