import { defaultTaskContextStorageRoot } from "../context/task.js";
import { ConversationRoutingService } from "../context/conversation-routing-service.js";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import { ReviewResultService } from "../context/review-result-service.js";
import type { ReviewResultStatus } from "../context/review-result-schema.js";
import type { ReviewResult } from "../context/review-result.js";
import {
  BrowserWorkerClient,
  type BrowserCompletionResult,
} from "../browser-worker-client/browser-worker-client.js";
import type { WorkspaceIdentity } from "../workspace/types.js";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 4000);
  return String(error).slice(0, 4000);
}

function completionResultInput(
  result: BrowserCompletionResult,
  workspaceId: string,
  taskId: string,
  reviewRequestId: string,
  deliveryId: string,
): {
  readonly workspace_id: string;
  readonly task_id: string;
  readonly review_request_id: string;
  readonly delivery_id: string;
  readonly status: ReviewResultStatus;
  readonly content?: string;
  readonly error?: string;
} {
  return result.status === "COMPLETED"
    ? {
      workspace_id: workspaceId,
      task_id: taskId,
      review_request_id: reviewRequestId,
      delivery_id: deliveryId,
      status: "COMPLETED",
      content: result.content,
    }
    : {
      workspace_id: workspaceId,
      task_id: taskId,
      review_request_id: reviewRequestId,
      delivery_id: deliveryId,
      status: result.status,
      error: result.error,
    };
}

export class ReviewCompletionRouter {
  private readonly routings: ConversationRoutingService;
  private readonly deliveries: ReviewDeliveryService;
  private readonly reviewRequests: ReviewRequestService;
  private readonly results: ReviewResultService;

  public constructor(
    storageRoot: string = defaultTaskContextStorageRoot(),
    private readonly client: Pick<BrowserWorkerClient, "collectCompletion"> = new BrowserWorkerClient(),
    runtimeIdentity?: WorkspaceIdentity,
  ) {
    this.routings = new ConversationRoutingService(storageRoot, runtimeIdentity);
    this.deliveries = new ReviewDeliveryService(storageRoot, runtimeIdentity);
    this.reviewRequests = new ReviewRequestService(storageRoot);
    this.results = new ReviewResultService(storageRoot, runtimeIdentity);
  }

  public async collect(workspaceId: string, routingId: string): Promise<ReviewResult> {
    const routing = await this.routings.getRouting(workspaceId, routingId);
    if (routing === null) throw new Error(`Conversation routing "${routingId}" was not found.`);
    await this.routings.validateRouting(routing);

    const request = await this.reviewRequests.getReviewRequest(workspaceId, routing.review_request_id);
    if (request === null) {
      throw new Error(`Review request "${routing.review_request_id}" was not found.`);
    }
    const delivery = await this.deliveries.getDeliveryByRouting(workspaceId, routing.routing_id);
    if (delivery === null) {
      throw new Error(`Review delivery for routing "${routing.routing_id}" was not found.`);
    }
    await this.deliveries.validateDelivery(delivery);
    if (delivery.status !== "delivered") {
      throw new Error("Review completion requires a delivered review request.");
    }

    const existing = await this.results.getReviewResultByRequest(
      workspaceId,
      request.review_request_id,
    );
    if (existing?.status === "COMPLETED") return existing;

    await this.reviewRequests.updateReviewRequest(
      workspaceId,
      request.review_request_id,
      { status: "reviewing" },
    );

    let completion: BrowserCompletionResult;
    try {
      completion = await this.client.collectCompletion(
        routing.conversation_id,
        request.review_request_id,
      );
    } catch (error: unknown) {
      completion = {
        conversationId: routing.conversation_id,
        status: "FAILED",
        error: errorMessage(error),
      };
    }

    const result = await this.results.createReviewResult(completionResultInput(
      completion,
      workspaceId,
      routing.task_id,
      request.review_request_id,
      delivery.delivery_id,
    ));
    await this.reviewRequests.updateReviewRequest(
      workspaceId,
      request.review_request_id,
      { status: completion.status === "COMPLETED" ? "completed" : "requested" },
    );
    return result;
  }
}

export type { ReviewResult } from "../context/review-result.js";
