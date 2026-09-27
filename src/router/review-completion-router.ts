import { defaultTaskContextStorageRoot } from "../context/task.js";
import { ConversationRoutingService } from "../context/conversation-routing-service.js";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import { ReviewResultService } from "../context/review-result-service.js";
import type { ReviewResultStatus } from "../context/review-result-schema.js";
import type { ReviewResult } from "../context/review-result.js";
import {
  BrowserWorkerReviewCompletionAdapter,
} from "../delivery/browser-worker-review-completion-adapter.js";
import type {
  ReviewCompletionAdapter,
  ReviewCompletionResult,
} from "../delivery/review-completion-adapter.js";
import { validateWorkspaceIdentityConsistency } from "../workspace/identity.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type { WorkspaceIdentity } from "../workspace/types.js";

type ReviewWorkspaceAuthority = WorkspaceIdentity | Pick<WorkspaceRegistry, "resolve">;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 4000);
  return String(error).slice(0, 4000);
}

function completionResultInput(
  result: ReviewCompletionResult,
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
  private readonly storageRoot: string;
  private readonly reviewRequests: ReviewRequestService;
  private readonly inFlight = new Map<string, Promise<ReviewResult>>();

  public constructor(
    storageRoot: string = defaultTaskContextStorageRoot(),
    private readonly adapter: ReviewCompletionAdapter = new BrowserWorkerReviewCompletionAdapter(),
    private readonly workspaceAuthority?: ReviewWorkspaceAuthority,
  ) {
    this.reviewRequests = new ReviewRequestService(storageRoot);
    this.storageRoot = this.reviewRequests.storageRoot;
  }

  public collect(workspaceId: string, routingId: string): Promise<ReviewResult> {
    const key = `${workspaceId}\0${routingId}`;
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;
    const operation = this.collectOnce(workspaceId, routingId);
    this.inFlight.set(key, operation);
    void operation.finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  private async collectOnce(workspaceId: string, routingId: string): Promise<ReviewResult> {
    const runtimeIdentity = this.workspaceIdentityFor(workspaceId);
    const routings = new ConversationRoutingService(this.storageRoot, runtimeIdentity);
    const deliveries = new ReviewDeliveryService(this.storageRoot, runtimeIdentity);
    const results = new ReviewResultService(this.storageRoot, runtimeIdentity);
    const routing = await routings.getRouting(workspaceId, routingId);
    if (routing === null) throw new Error(`Conversation routing "${routingId}" was not found.`);
    await routings.validateRouting(routing);

    const request = await this.reviewRequests.getReviewRequest(workspaceId, routing.review_request_id);
    if (request === null) {
      throw new Error(`Review request "${routing.review_request_id}" was not found.`);
    }
    const delivery = await deliveries.getDeliveryByRouting(workspaceId, routing.routing_id);
    if (delivery === null) {
      throw new Error(`Review delivery for routing "${routing.routing_id}" was not found.`);
    }
    await deliveries.validateDelivery(delivery);
    if (delivery.status !== "delivered") {
      throw new Error("Review completion requires a delivered review request.");
    }

    const existing = await results.getReviewResultByRequest(
      workspaceId,
      request.review_request_id,
    );
    if (existing?.status === "COMPLETED") {
      if (request.status !== "completed") {
        await this.reviewRequests.updateReviewRequest(
          workspaceId,
          request.review_request_id,
          { status: "completed" },
        );
      }
      return existing;
    }

    await this.reviewRequests.updateReviewRequest(
      workspaceId,
      request.review_request_id,
      { status: "reviewing" },
    );

    let completion: ReviewCompletionResult;
    try {
      completion = await this.adapter.collect({
        workspace_id: workspaceId,
        task_id: routing.task_id,
        review_request_id: request.review_request_id,
        delivery_id: delivery.delivery_id,
        conversation_id: routing.conversation_id,
      });
    } catch (error: unknown) {
      completion = {
        status: "FAILED",
        error: errorMessage(error),
      };
    }

    const result = await results.createReviewResult(completionResultInput(
      completion,
      workspaceId,
      routing.task_id,
      request.review_request_id,
      delivery.delivery_id,
    ));
    await this.reviewRequests.updateReviewRequest(
      workspaceId,
      request.review_request_id,
      { status: result.status === "COMPLETED" ? "completed" : "requested" },
    );
    return result;
  }

  private workspaceIdentityFor(workspaceId: string): WorkspaceIdentity | undefined {
    if (this.workspaceAuthority === undefined) return undefined;
    if ("resolve" in this.workspaceAuthority) return this.workspaceAuthority.resolve(workspaceId);
    validateWorkspaceIdentityConsistency(
      { ...this.workspaceAuthority, id: workspaceId },
      this.workspaceAuthority,
    );
    return this.workspaceAuthority;
  }
}

export type { ReviewResult } from "../context/review-result.js";
