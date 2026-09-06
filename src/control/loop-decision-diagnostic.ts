import type { ReviewResult } from "../context/review-result.js";
import type {
  ExecutionContext,
  ReviewRequestContext,
  TaskContext,
} from "../context/types.js";
import type { ReviewDelivery } from "../context/review-delivery.js";
import { LoopController } from "./loop-controller.js";
import type { LoopDecisionAction, LoopDecisionReasonCode } from "./loop-decision.js";
import type { ReviewSnapshot } from "../git/types.js";

export interface LoopDecisionDiagnosticResult {
  readonly approve: { readonly action: LoopDecisionAction; readonly reason_code: LoopDecisionReasonCode };
  readonly iterate: { readonly action: LoopDecisionAction; readonly reason_code: LoopDecisionReasonCode };
  readonly human_required: { readonly action: LoopDecisionAction; readonly reason_code: LoopDecisionReasonCode };
  readonly timeout: { readonly action: LoopDecisionAction; readonly reason_code: LoopDecisionReasonCode };
  readonly invalid_verdict: { readonly action: LoopDecisionAction; readonly reason_code: LoopDecisionReasonCode };
  readonly missing_snapshot: { readonly action: LoopDecisionAction; readonly reason_code: LoopDecisionReasonCode };
  readonly stale: { readonly action: LoopDecisionAction; readonly reason_code: LoopDecisionReasonCode };
  readonly wait: { readonly action: LoopDecisionAction; readonly reason_code: LoopDecisionReasonCode };
}

const reviewSnapshot: ReviewSnapshot = {
  branch: "main",
  head: "0123456789abcdef0123456789abcdef01234567",
  diff_sha256: "a".repeat(64),
};

const task: TaskContext = {
  task_id: "diagnostic-task",
  workspace_id: "diagnostic-workspace",
  status: "reviewing",
  created_at: "2026-09-06T00:00:00.000Z",
  updated_at: "2026-09-06T00:00:00.000Z",
};

const execution: ExecutionContext = {
  execution_id: "diagnostic-execution",
  task_id: task.task_id,
  workspace_id: task.workspace_id,
  status: "passed",
  started_at: "2026-09-06T00:00:00.000Z",
  finished_at: "2026-09-06T00:01:00.000Z",
};

const reviewRequest: ReviewRequestContext = {
  review_request_id: "diagnostic-review",
  task_id: task.task_id,
  execution_id: execution.execution_id,
  workspace_id: task.workspace_id,
  status: "completed",
  review_snapshot: reviewSnapshot,
  created_at: "2026-09-06T00:00:00.000Z",
  updated_at: "2026-09-06T00:00:00.000Z",
};

const reviewDelivery: ReviewDelivery = {
  delivery_id: "diagnostic-delivery",
  workspace_id: task.workspace_id,
  task_id: task.task_id,
  review_request_id: reviewRequest.review_request_id,
  routing_id: "diagnostic-routing",
  conversation_id: "diagnostic-conversation",
  status: "delivered",
  attempt_count: 1,
  created_at: "2026-09-06T00:00:00.000Z",
  updated_at: "2026-09-06T00:00:00.000Z",
  delivered_at: "2026-09-06T00:00:00.000Z",
};

function result(
  resultId: string,
  status: ReviewResult["status"],
  content?: string,
): ReviewResult {
  return {
    result_id: resultId,
    review_request_id: reviewRequest.review_request_id,
    delivery_id: reviewDelivery.delivery_id,
    workspace_id: task.workspace_id,
    task_id: task.task_id,
    status,
    ...(content === undefined ? { error: "diagnostic review failure" } : { content }),
    created_at: "2026-09-06T00:02:00.000Z",
  };
}

function verdictContent(decision: "APPROVE" | "ITERATE" | "HUMAN_REQUIRED"): string {
  const payload = decision === "APPROVE"
    ? {
      schema_version: 1,
      review_request_id: reviewRequest.review_request_id,
      decision,
      summary: "The diagnostic review is approved.",
    }
    : decision === "ITERATE"
      ? {
        schema_version: 1,
        review_request_id: reviewRequest.review_request_id,
        decision,
        summary: "The diagnostic review requires another iteration.",
        iteration: {
          goal: "Fix the diagnostic issue.",
          requirements: ["Keep the change within the current task."],
          acceptance_criteria: ["The diagnostic check passes."],
        },
      }
      : {
        schema_version: 1,
        review_request_id: reviewRequest.review_request_id,
        decision,
        summary: "The diagnostic review requires human intervention.",
      };
  return `<lrm-review-result>${JSON.stringify(payload)}</lrm-review-result>`;
}

function facts(
  reviewResult?: ReviewResult,
  currentReviewSnapshot?: ReviewSnapshot,
): Parameters<LoopController["decide"]>[0] {
  return {
    task,
    execution,
    review_request: reviewRequest,
    review_delivery: reviewDelivery,
    ...(reviewResult === undefined ? {} : { review_result: reviewResult }),
    ...(currentReviewSnapshot === undefined ? {} : { current_review_snapshot: currentReviewSnapshot }),
  };
}

function outcome(
  decision: ReturnType<LoopController["decide"]>,
): { readonly action: LoopDecisionAction; readonly reason_code: LoopDecisionReasonCode } {
  return { action: decision.action, reason_code: decision.reason_code };
}

export function generateLoopDecisionExample(): LoopDecisionDiagnosticResult {
  const controller = new LoopController();
  const approve = controller.decide(facts(
    result("diagnostic-result-approve", "COMPLETED", verdictContent("APPROVE")),
    reviewSnapshot,
  ));
  const iterate = controller.decide(facts(
    result("diagnostic-result-iterate", "COMPLETED", verdictContent("ITERATE")),
    reviewSnapshot,
  ));
  const humanRequired = controller.decide(facts(
    result("diagnostic-result-human", "COMPLETED", verdictContent("HUMAN_REQUIRED")),
    reviewSnapshot,
  ));
  const timeout = controller.decide(facts(
    result("diagnostic-result-timeout", "TIMEOUT"),
    reviewSnapshot,
  ));
  const invalidVerdict = controller.decide(facts(result(
    "diagnostic-result-invalid",
    "COMPLETED",
    "The review has no machine-readable verdict.",
  ), reviewSnapshot));
  const historicalRequest: ReviewRequestContext = {
    ...reviewRequest,
    review_snapshot: undefined,
  };
  const missingSnapshotFacts: Parameters<LoopController["decide"]>[0] = {
    ...facts(
      result("diagnostic-result-missing-snapshot", "COMPLETED", verdictContent("APPROVE")),
    ),
    review_request: historicalRequest,
  };
  const missingSnapshot = controller.decide(missingSnapshotFacts);
  const stale = controller.decide(facts(
    result("diagnostic-result-stale", "COMPLETED", verdictContent("APPROVE")),
    { ...reviewSnapshot, diff_sha256: "b".repeat(64) },
  ));
  const wait = controller.decide(facts());

  if (approve.action !== "COMPLETE" || approve.reason_code !== "REVIEW_APPROVED") {
    throw new Error("Loop decision diagnostic did not map APPROVE to COMPLETE.");
  }
  if (iterate.action !== "ITERATE" || iterate.reason_code !== "REVIEW_REQUIRES_ITERATION") {
    throw new Error("Loop decision diagnostic did not map ITERATE to ITERATE.");
  }
  if (humanRequired.action !== "HUMAN_REQUIRED"
    || humanRequired.reason_code !== "REVIEW_REQUIRES_HUMAN") {
    throw new Error("Loop decision diagnostic did not map HUMAN_REQUIRED to HUMAN_REQUIRED.");
  }
  if (timeout.action !== "RETRY_REVIEW" || timeout.reason_code !== "REVIEW_TIMEOUT") {
    throw new Error("Loop decision diagnostic did not map TIMEOUT to RETRY_REVIEW.");
  }
  if (invalidVerdict.action !== "RETRY_REVIEW" || invalidVerdict.reason_code !== "REVIEW_VERDICT_INVALID") {
    throw new Error("Loop decision diagnostic did not map invalid verdict to RETRY_REVIEW.");
  }
  if (missingSnapshot.action !== "RETRY_REVIEW"
    || missingSnapshot.reason_code !== "REVIEW_SNAPSHOT_MISSING") {
    throw new Error("Loop decision diagnostic did not map a missing snapshot to RETRY_REVIEW.");
  }
  if (wait.action !== "WAIT" || wait.reason_code !== "REVIEW_PENDING") {
    throw new Error("Loop decision diagnostic did not map a missing result to WAIT.");
  }
  if (stale.action !== "RETRY_REVIEW" || stale.reason_code !== "STALE_REVIEW") {
    throw new Error("Loop decision diagnostic did not map a stale snapshot to RETRY_REVIEW.");
  }

  return {
    approve: outcome(approve),
    iterate: outcome(iterate),
    human_required: outcome(humanRequired),
    timeout: outcome(timeout),
    invalid_verdict: outcome(invalidVerdict),
    missing_snapshot: outcome(missingSnapshot),
    stale: outcome(stale),
    wait: outcome(wait),
  };
}
