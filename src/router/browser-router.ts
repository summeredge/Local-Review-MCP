import { defaultTaskContextStorageRoot } from "../context/task.js";
import { ConversationRoutingService } from "../context/conversation-routing-service.js";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import type { ReviewDelivery } from "../context/review-delivery.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import type { WorkspaceIdentity } from "../workspace/types.js";
import { conversationUrl } from "../delivery/conversation-url.js";
import type {
  ReviewDeliveryAdapter,
  ReviewDeliveryRequest,
  ReviewDeliveryResult,
} from "../delivery/review-delivery-adapter.js";
import { buildReviewMessage } from "../delivery/review-message.js";

export class BrowserRouter {
  private readonly routings: ConversationRoutingService;
  private readonly deliveries: ReviewDeliveryService;
  private readonly reviewRequests: ReviewRequestService;

  public constructor(
    storageRoot: string = defaultTaskContextStorageRoot(),
    private readonly adapter: ReviewDeliveryAdapter,
    runtimeIdentity?: WorkspaceIdentity,
  ) {
    this.routings = new ConversationRoutingService(storageRoot, runtimeIdentity);
    this.deliveries = new ReviewDeliveryService(storageRoot, runtimeIdentity);
    this.reviewRequests = new ReviewRequestService(storageRoot);
  }

  public async deliver(workspaceId: string, routingId: string): Promise<ReviewDelivery> {
    const routing = await this.routings.getRouting(workspaceId, routingId);
    if (routing === null) throw new Error(`Conversation routing "${routingId}" was not found.`);
    await this.routings.validateRouting(routing);
    conversationUrl(routing.conversation_id);

    const delivery = await this.deliveries.getDeliveryByRouting(workspaceId, routingId);
    if (delivery === null) {
      throw new Error(`Review delivery for routing "${routingId}" was not found.`);
    }
    await this.deliveries.validateDelivery(delivery);
    if (delivery.status === "delivered") return delivery;

    const attempt = await this.deliveries.beginDeliveryAttempt(workspaceId, delivery.delivery_id);
    const request: ReviewDeliveryRequest = {
      delivery_id: attempt.delivery_id,
      workspace_id: attempt.workspace_id,
      task_id: attempt.task_id,
      review_request_id: attempt.review_request_id,
      routing_id: attempt.routing_id,
      conversation_id: attempt.conversation_id,
      message: buildReviewMessage({
        workspace_id: attempt.workspace_id,
        task_id: attempt.task_id,
        review_request_id: attempt.review_request_id,
        execution_id: routing.execution_id,
        routing_id: attempt.routing_id,
      }),
      ...(routing.execution_id === undefined ? {} : { execution_id: routing.execution_id }),
    };

    let result: ReviewDeliveryResult;
    try {
      result = await this.adapter.deliver(request);
    } catch (error: unknown) {
      return this.deliveries.markFailed(workspaceId, attempt.delivery_id, {
        code: "SEND_FAILED",
        message: error instanceof Error && error.message.length > 0
          ? error.message.slice(0, 4000)
          : "Review delivery adapter failed.",
      });
    }

    if (result.status === "delivered") {
      const delivered = await this.deliveries.markDelivered(
        workspaceId,
        attempt.delivery_id,
        result.delivered_at,
      );
      await this.markReviewRequested(delivered.workspace_id, delivered.review_request_id);
      return delivered;
    }
    return this.deliveries.markFailed(workspaceId, attempt.delivery_id, result.error);
  }

  private async markReviewRequested(workspaceId: string, reviewRequestId: string): Promise<void> {
    const request = await this.reviewRequests.getReviewRequest(workspaceId, reviewRequestId);
    if (request === null) throw new Error(`Review request "${reviewRequestId}" was not found.`);
    if (request.status === "pending") {
      await this.reviewRequests.updateReviewRequest(workspaceId, reviewRequestId, { status: "requested" });
    }
  }
}
