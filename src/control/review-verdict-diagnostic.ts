import type { ReviewResult } from "../context/review-result.js";
import {
  ReviewVerdictParseError,
  ReviewVerdictParser,
} from "./review-verdict-parser.js";

export interface ReviewVerdictDiagnosticResult {
  readonly decision: "ITERATE";
  readonly review_request_id: string;
  readonly identity_mismatch: "REVIEW_REQUEST_MISMATCH";
}

function verdictContent(reviewRequestId: string): string {
  return [
    "Human-readable review: a blocking issue requires a focused iteration.",
    "<lrm-review-result>",
    JSON.stringify({
      schema_version: 1,
      review_request_id: reviewRequestId,
      decision: "ITERATE",
      summary: "A blocking issue must be fixed.",
      iteration: {
        goal: "Fix the blocking review issue.",
        requirements: ["Fix the issue within the current task scope."],
        acceptance_criteria: ["The blocking issue is fixed and tests pass."],
      },
    }),
    "</lrm-review-result>",
  ].join("\n");
}

export function generateReviewVerdictExample(): ReviewVerdictDiagnosticResult {
  const result: ReviewResult = {
    result_id: "diagnostic-result",
    review_request_id: "diagnostic-review",
    delivery_id: "diagnostic-delivery",
    workspace_id: "diagnostic-workspace",
    task_id: "diagnostic-task",
    status: "COMPLETED",
    content: verdictContent("diagnostic-review"),
    created_at: new Date().toISOString(),
  };
  const parser = new ReviewVerdictParser();
  const verdict = parser.parse(result);
  if (verdict.decision !== "ITERATE"
    || verdict.review_request_id !== result.review_request_id) {
    throw new Error("Review verdict diagnostic did not parse the expected ITERATE verdict.");
  }

  try {
    parser.parse({ ...result, content: verdictContent("other-review") });
  } catch (error: unknown) {
    if (error instanceof ReviewVerdictParseError
      && error.code === "REVIEW_REQUEST_MISMATCH") {
      return {
        decision: verdict.decision,
        review_request_id: verdict.review_request_id,
        identity_mismatch: error.code,
      };
    }
    throw error;
  }
  throw new Error("Review verdict diagnostic did not reject an identity mismatch.");
}
