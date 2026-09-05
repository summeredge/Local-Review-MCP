import type { ReviewDeliveryError } from "../context/review-delivery.js";

export interface ReviewDeliveryRequest {
  readonly delivery_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly review_request_id: string;
  readonly routing_id: string;
  readonly conversation_id: string;
  readonly message: string;
  readonly execution_id?: string;
}

export type ReviewDeliveryResult =
  | {
    readonly status: "delivered";
    readonly delivered_at: string;
  }
  | {
    readonly status: "failed";
    readonly retryable: boolean;
    readonly error: ReviewDeliveryError;
  };

export interface ReviewDeliveryAdapter {
  deliver(request: ReviewDeliveryRequest): Promise<ReviewDeliveryResult>;
}
