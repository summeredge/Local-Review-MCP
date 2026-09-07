import { defaultTaskContextStorageRoot } from "../context/task.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { executionContextSchema, taskContextSchema } from "../context/schema.js";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import type { ReviewDelivery } from "../context/review-delivery.js";
import { reviewDeliverySchema } from "../context/review-delivery-schema.js";
import { ReviewRequestService } from "../context/review-request-service.js";
import type { ReviewSnapshotProvider } from "../context/review-request-snapshot.js";
import { reviewRequestContextSchema, reviewSnapshotSchema } from "../context/review-schema.js";
import { ReviewResultService } from "../context/review-result-service.js";
import type { ReviewResult } from "../context/review-result.js";
import { reviewResultSchema } from "../context/review-result-schema.js";
import { TaskContextService } from "../context/service.js";
import type {
  ExecutionContext,
  ReviewRequestContext,
  TaskContext,
} from "../context/types.js";
import {
  ReviewVerdictParseError,
  ReviewVerdictParser,
} from "./review-verdict-parser.js";
import { reviewVerdictSchema } from "./review-verdict-schema.js";
import type { ReviewVerdict } from "./review-verdict.js";
import { createLoopDecisionId } from "./loop-decision.js";
import { loopDecisionSchema } from "./loop-decision-schema.js";
import type { LoopDecision } from "./loop-decision.js";
import { sameReviewSnapshot, type ReviewSnapshot } from "../git/types.js";

export interface LoopControllerFacts {
  readonly task: TaskContext;
  readonly execution: ExecutionContext;
  readonly review_request: ReviewRequestContext;
  readonly review_delivery?: ReviewDelivery | null;
  readonly review_result?: ReviewResult | null;
  readonly review_verdict?: ReviewVerdict;
  readonly current_review_snapshot?: ReviewSnapshot;
}

export interface LoopControllerOptions {
  readonly reviewSnapshotProvider?: ReviewSnapshotProvider;
}

export class LoopControllerIdentityError extends Error {
  public readonly code = "LOOP_IDENTITY_MISMATCH" as const;

  public constructor(message: string) {
    super(`LOOP_IDENTITY_MISMATCH: ${message}`);
    this.name = "LoopControllerIdentityError";
  }
}

function invalidVerdictSummary(code: string): string {
  return `Review verdict is invalid (${code}); the review must be retried.`;
}

export class LoopController {
  private readonly tasks: TaskContextService;
  private readonly executions: ExecutionContextService;
  private readonly reviewRequests: ReviewRequestService;
  private readonly deliveries: ReviewDeliveryService;
  private readonly results: ReviewResultService;
  private readonly reviewSnapshotProvider?: ReviewSnapshotProvider;

  public constructor(
    storageRoot = defaultTaskContextStorageRoot(),
    private readonly parser: Pick<ReviewVerdictParser, "parse"> = new ReviewVerdictParser(),
    options: LoopControllerOptions = {},
  ) {
    this.tasks = new TaskContextService(storageRoot);
    this.executions = new ExecutionContextService(storageRoot);
    this.reviewRequests = new ReviewRequestService(storageRoot);
    this.deliveries = new ReviewDeliveryService(storageRoot);
    this.results = new ReviewResultService(storageRoot);
    this.reviewSnapshotProvider = options.reviewSnapshotProvider;
  }

  public async evaluate(workspaceId: string, reviewRequestId: string): Promise<LoopDecision> {
    const reviewRequest = await this.reviewRequests.getReviewRequest(workspaceId, reviewRequestId);
    if (reviewRequest === null) {
      throw new Error(`Review request "${reviewRequestId}" was not found.`);
    }

    const task = await this.tasks.getTaskContext(reviewRequest.task_id);
    if (task === null) {
      throw new Error(`Task context "${reviewRequest.task_id}" was not found.`);
    }
    const execution = await this.executions.getExecutionContext(
      workspaceId,
      reviewRequest.task_id,
      reviewRequest.execution_id,
    );
    if (execution === null) {
      throw new Error(`Execution context "${reviewRequest.execution_id}" was not found.`);
    }

    const reviewResult = await this.results.getReviewResultByRequest(
      workspaceId,
      reviewRequest.review_request_id,
    );
    const reviewDelivery = reviewResult === null
      ? await this.deliveries.getDeliveryByReviewRequest(workspaceId, reviewRequest.review_request_id)
      : await this.deliveries.getDelivery(workspaceId, reviewResult.delivery_id);
    if (reviewDelivery !== null) await this.deliveries.validateDelivery(reviewDelivery);

    let currentReviewSnapshot: LoopControllerFacts["current_review_snapshot"];
    if (reviewResult?.status === "COMPLETED" && reviewRequest.review_snapshot !== undefined) {
      try {
        currentReviewSnapshot = await this.reviewSnapshotProvider?.capture(workspaceId);
      } catch {
        currentReviewSnapshot = undefined;
      }
    }

    return this.decide({
      task,
      execution,
      review_request: reviewRequest,
      review_delivery: reviewDelivery,
      review_result: reviewResult,
      ...(currentReviewSnapshot === undefined ? {} : { current_review_snapshot: currentReviewSnapshot }),
    });
  }

  public decide(facts: LoopControllerFacts): LoopDecision {
    this.validateIdentity(facts);
    const reviewResult = facts.review_result ?? null;
    if (reviewResult === null) {
      if (facts.review_verdict !== undefined) {
        throw new LoopControllerIdentityError("ReviewVerdict exists without a ReviewResult.");
      }
      return this.createDecision(facts, "WAIT", "REVIEW_PENDING", "Review result is not available yet.");
    }

    if (reviewResult.status === "TIMEOUT") {
      return this.createDecision(
        facts,
        "RETRY_REVIEW",
        "REVIEW_TIMEOUT",
        "Review completion timed out; the review should be retried.",
      );
    }
    if (reviewResult.status === "FAILED") {
      return this.createDecision(
        facts,
        "RETRY_REVIEW",
        "REVIEW_FAILED",
        "Review completion failed; the review should be retried.",
      );
    }

    const originalReviewSnapshot = facts.review_request.review_snapshot;
    if (originalReviewSnapshot === undefined) {
      return this.createDecision(
        facts,
        "RETRY_REVIEW",
        "REVIEW_SNAPSHOT_MISSING",
        "The completed review has no workspace snapshot; the review must be retried.",
      );
    }
    if (facts.current_review_snapshot === undefined) {
      return this.createDecision(
        facts,
        "RETRY_REVIEW",
        "REVIEW_SNAPSHOT_UNAVAILABLE",
        "The current workspace snapshot could not be captured; the review must be retried.",
      );
    }
    if (!sameReviewSnapshot(originalReviewSnapshot, facts.current_review_snapshot)) {
      return this.createDecision(
        facts,
        "RETRY_REVIEW",
        "STALE_REVIEW",
        "The workspace changed after the review was created; the review must be retried.",
      );
    }

    let verdict: ReviewVerdict;
    if (facts.review_verdict === undefined) {
      try {
        verdict = this.parser.parse(reviewResult);
      } catch (error: unknown) {
        if (!(error instanceof ReviewVerdictParseError)) throw error;
        return this.createDecision(
          facts,
          "RETRY_REVIEW",
          "REVIEW_VERDICT_INVALID",
          invalidVerdictSummary(error.code),
        );
      }
    } else {
      const parsed = reviewVerdictSchema.safeParse(facts.review_verdict);
      if (!parsed.success) {
        return this.createDecision(
          facts,
          "RETRY_REVIEW",
          "REVIEW_VERDICT_INVALID",
          invalidVerdictSummary("VERDICT_SCHEMA_INVALID"),
        );
      }
      if (parsed.data.review_request_id !== reviewResult.review_request_id) {
        return this.createDecision(
          facts,
          "RETRY_REVIEW",
          "REVIEW_VERDICT_INVALID",
          invalidVerdictSummary("REVIEW_REQUEST_MISMATCH"),
        );
      }
      verdict = parsed.data;
    }

    switch (verdict.decision) {
      case "APPROVE":
        return this.createDecision(facts, "COMPLETE", "REVIEW_APPROVED", verdict.summary);
      case "ITERATE":
        return this.createDecision(
          facts,
          "ITERATE",
          "REVIEW_REQUIRES_ITERATION",
          verdict.summary,
        );
      case "HUMAN_REQUIRED":
        return this.createDecision(facts, "HUMAN_REQUIRED", "REVIEW_REQUIRES_HUMAN", verdict.summary);
    }
  }

  private validateIdentity(facts: LoopControllerFacts): void {
    const { task, execution, review_request: reviewRequest } = facts;
    try {
      taskContextSchema.parse(task);
      executionContextSchema.parse(execution);
      reviewRequestContextSchema.parse(reviewRequest);
      if (facts.review_delivery !== undefined && facts.review_delivery !== null) {
        reviewDeliverySchema.parse(facts.review_delivery);
      }
      if (facts.review_result !== undefined && facts.review_result !== null) {
        reviewResultSchema.parse(facts.review_result);
      }
      if (facts.current_review_snapshot !== undefined) {
        reviewSnapshotSchema.parse(facts.current_review_snapshot);
      }
    } catch {
      throw new LoopControllerIdentityError("Core identity facts do not satisfy their schemas.");
    }
    if (reviewRequest.workspace_id !== task.workspace_id) {
      throw new LoopControllerIdentityError("ReviewRequest and Task belong to different workspaces.");
    }
    if (reviewRequest.task_id !== task.task_id) {
      throw new LoopControllerIdentityError("ReviewRequest does not belong to the Task.");
    }
    if (execution.workspace_id !== reviewRequest.workspace_id
      || execution.task_id !== reviewRequest.task_id
      || execution.execution_id !== reviewRequest.execution_id) {
      throw new LoopControllerIdentityError("Execution does not match the ReviewRequest chain.");
    }

    const reviewDelivery = facts.review_delivery ?? null;
    if (reviewDelivery !== null && (
      reviewDelivery.workspace_id !== reviewRequest.workspace_id
      || reviewDelivery.task_id !== reviewRequest.task_id
      || reviewDelivery.review_request_id !== reviewRequest.review_request_id
    )) {
      throw new LoopControllerIdentityError("ReviewDelivery does not match the ReviewRequest chain.");
    }

    const reviewResult = facts.review_result ?? null;
    if (reviewResult === null) return;
    if (reviewResult.workspace_id !== reviewRequest.workspace_id
      || reviewResult.task_id !== reviewRequest.task_id
      || reviewResult.review_request_id !== reviewRequest.review_request_id) {
      throw new LoopControllerIdentityError("ReviewResult does not match the ReviewRequest chain.");
    }
    if (reviewDelivery === null || reviewResult.delivery_id !== reviewDelivery.delivery_id) {
      throw new LoopControllerIdentityError("ReviewResult does not match the ReviewDelivery chain.");
    }
  }

  private createDecision(
    facts: LoopControllerFacts,
    action: LoopDecision["action"],
    reasonCode: LoopDecision["reason_code"],
    summary: string,
  ): LoopDecision {
    const reviewResult = facts.review_result ?? null;
    return loopDecisionSchema.parse({
      decision_id: createLoopDecisionId(),
      workspace_id: facts.review_request.workspace_id,
      task_id: facts.review_request.task_id,
      execution_id: facts.review_request.execution_id,
      review_request_id: facts.review_request.review_request_id,
      ...(reviewResult === null ? {} : { review_result_id: reviewResult.result_id }),
      action,
      reason_code: reasonCode,
      summary,
      created_at: new Date().toISOString(),
    });
  }
}
