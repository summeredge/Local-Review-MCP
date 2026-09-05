import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { reviewDeliveryIdSchema } from "./review-delivery-schema.js";
import { workspaceIdSchema } from "./schema.js";
import { TASK_DIRECTORY } from "./task.js";
import type { ReviewDeliveryStatus } from "./review-delivery-schema.js";

export interface ReviewDeliveryError {
  readonly code?: string;
  readonly message: string;
}

export interface ReviewDelivery {
  readonly delivery_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly review_request_id: string;
  readonly routing_id: string;
  readonly conversation_id: string;
  readonly status: ReviewDeliveryStatus;
  readonly attempt_count: number;
  readonly last_error?: ReviewDeliveryError;
  readonly created_at: string;
  readonly updated_at: string;
  readonly delivered_at?: string;
}

export interface CreateReviewDeliveryInput {
  readonly delivery_id?: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly review_request_id: string;
  readonly routing_id: string;
  readonly conversation_id: string;
}

export type {
  ReviewDeliveryAdapter,
  ReviewDeliveryRequest,
  ReviewDeliveryResult,
} from "../delivery/review-delivery-adapter.js";

export const REVIEW_DELIVERIES_DIRECTORY = join(TASK_DIRECTORY, "review_deliveries");

export function reviewDeliveriesDirectory(storageRoot: string, workspaceId: string): string {
  const safeWorkspaceId = workspaceIdSchema.parse(workspaceId);
  return join(resolve(storageRoot), REVIEW_DELIVERIES_DIRECTORY, safeWorkspaceId);
}

export function reviewDeliveryFile(
  storageRoot: string,
  workspaceId: string,
  deliveryId: string,
): string {
  const safeDeliveryId = reviewDeliveryIdSchema.parse(deliveryId);
  return join(reviewDeliveriesDirectory(storageRoot, workspaceId), `${safeDeliveryId}.json`);
}

export function createDeliveryId(): string {
  return `delivery-${randomUUID()}`;
}
