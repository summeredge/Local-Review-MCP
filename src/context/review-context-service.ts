import { defaultTaskContextStorageRoot } from "./task.js";
import { ExecutionContextService } from "./execution-service.js";
import { ReviewRequestService } from "./review-request-service.js";
import { TaskContextService } from "./service.js";
import { createReviewContextId, type ReviewContextProjection } from "./review-context.js";
import { reviewContextProjectionSchema } from "./review-context-schema.js";
import type { ReviewRequestContext } from "./types.js";

export class ReviewContextService {
  private readonly tasks: TaskContextService;
  private readonly executions: ExecutionContextService;
  private readonly reviewRequests: ReviewRequestService;

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.tasks = new TaskContextService(storageRoot);
    this.executions = new ExecutionContextService(storageRoot);
    this.reviewRequests = new ReviewRequestService(storageRoot);
  }

  public async createReviewContext(
    workspaceId: string,
    reviewRequestId: string,
  ): Promise<ReviewContextProjection> {
    return this.buildReviewContext(workspaceId, reviewRequestId);
  }

  public async getReviewContext(
    workspaceId: string,
    reviewRequestId: string,
  ): Promise<ReviewContextProjection | null> {
    const reviewRequest = await this.reviewRequests.getReviewRequest(workspaceId, reviewRequestId);
    if (reviewRequest === null) return null;
    return this.project(workspaceId, reviewRequestId, reviewRequest);
  }

  public async buildReviewContext(
    workspaceId: string,
    reviewRequestId: string,
  ): Promise<ReviewContextProjection> {
    const reviewRequest = await this.reviewRequests.getReviewRequest(workspaceId, reviewRequestId);
    if (reviewRequest === null) {
      throw new Error(`Review request "${reviewRequestId}" was not found.`);
    }
    return this.project(workspaceId, reviewRequestId, reviewRequest);
  }

  private async project(
    workspaceId: string,
    reviewRequestId: string,
    reviewRequest: ReviewRequestContext,
  ): Promise<ReviewContextProjection> {
    if (reviewRequest.review_request_id !== reviewRequestId
      || reviewRequest.workspace_id !== workspaceId) {
      throw new Error("Review request does not belong to the requested workspace.");
    }

    const task = await this.tasks.getTaskContext(reviewRequest.task_id);
    if (task === null) {
      throw new Error(`Task context "${reviewRequest.task_id}" was not found.`);
    }
    if (task.workspace_id !== workspaceId) {
      throw new Error("Task context does not belong to the requested workspace.");
    }

    const execution = await this.executions.getExecutionContext(
      workspaceId,
      task.task_id,
      reviewRequest.execution_id,
    );
    if (execution === null) {
      throw new Error(`Execution context "${reviewRequest.execution_id}" was not found.`);
    }
    if (execution.execution_id !== reviewRequest.execution_id
      || execution.task_id !== task.task_id
      || execution.workspace_id !== workspaceId) {
      throw new Error("Execution context does not match the requested review.");
    }

    return reviewContextProjectionSchema.parse({
      review_context_id: createReviewContextId(),
      workspace_id: workspaceId,
      task: {
        task_id: task.task_id,
        status: task.status,
      },
      execution: {
        execution_id: execution.execution_id,
        status: execution.status,
        ...(execution.command === undefined ? {} : { command: execution.command }),
        ...(execution.summary === undefined ? {} : { summary: execution.summary }),
        started_at: execution.started_at,
        ...(execution.finished_at === undefined ? {} : { finished_at: execution.finished_at }),
      },
      review_request: {
        review_request_id: reviewRequest.review_request_id,
        status: reviewRequest.status,
        ...(reviewRequest.conversation_id === undefined
          ? {}
          : { conversation_id: reviewRequest.conversation_id }),
      },
      generated_at: new Date().toISOString(),
    });
  }
}
