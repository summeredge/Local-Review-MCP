import { createIterationDirectiveId } from "./iteration-directive.js";
import type { IterationDirective } from "./iteration-directive.js";
import { iterationDirectiveSchema } from "./iteration-directive-schema.js";
import type { LoopDecision } from "./loop-decision.js";
import { loopDecisionSchema } from "./loop-decision-schema.js";
import {
  reviewVerdictIterationSchema,
  reviewVerdictSchema,
} from "./review-verdict-schema.js";
import type { ReviewVerdict } from "./review-verdict.js";

export const ITERATION_DIRECTIVE_BUILD_ERROR_CODES = [
  "LOOP_DECISION_NOT_ITERATE",
  "LOOP_DECISION_REASON_INVALID",
  "REVIEW_VERDICT_NOT_ITERATE",
  "ITERATION_PAYLOAD_MISSING",
  "REVIEW_REQUEST_MISMATCH",
  "REVIEW_RESULT_ID_MISSING",
  "LOOP_DECISION_SCHEMA_INVALID",
  "REVIEW_VERDICT_SCHEMA_INVALID",
] as const;

export type IterationDirectiveBuildErrorCode =
  typeof ITERATION_DIRECTIVE_BUILD_ERROR_CODES[number];

export class IterationDirectiveBuildError extends Error {
  public readonly code: IterationDirectiveBuildErrorCode;

  public constructor(code: IterationDirectiveBuildErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "IterationDirectiveBuildError";
    this.code = code;
  }
}

export class IterationDirectiveBuilder {
  public build(decision: LoopDecision, verdict: ReviewVerdict): IterationDirective {
    if (decision.action !== "ITERATE") {
      throw new IterationDirectiveBuildError(
        "LOOP_DECISION_NOT_ITERATE",
        `Loop decision action is ${decision.action}.`,
      );
    }
    if (decision.reason_code !== "REVIEW_REQUIRES_ITERATION") {
      throw new IterationDirectiveBuildError(
        "LOOP_DECISION_REASON_INVALID",
        `ITERATE decision reason code is ${decision.reason_code}.`,
      );
    }
    if (verdict.decision !== "ITERATE") {
      throw new IterationDirectiveBuildError(
        "REVIEW_VERDICT_NOT_ITERATE",
        `Review verdict decision is ${verdict.decision}.`,
      );
    }
    if (verdict.iteration === undefined) {
      throw new IterationDirectiveBuildError(
        "ITERATION_PAYLOAD_MISSING",
        "ITERATE verdict has no iteration payload.",
      );
    }
    if (decision.review_request_id !== verdict.review_request_id) {
      throw new IterationDirectiveBuildError(
        "REVIEW_REQUEST_MISMATCH",
        "Loop decision and review verdict belong to different review requests.",
      );
    }
    if (decision.review_result_id === undefined) {
      throw new IterationDirectiveBuildError(
        "REVIEW_RESULT_ID_MISSING",
        "ITERATE decision has no review_result_id.",
      );
    }

    const parsedDecision = loopDecisionSchema.safeParse(decision);
    if (!parsedDecision.success) {
      throw new IterationDirectiveBuildError(
        "LOOP_DECISION_SCHEMA_INVALID",
        `Loop decision is invalid: ${parsedDecision.error.message}`,
      );
    }
    const parsedIteration = reviewVerdictIterationSchema.safeParse(verdict.iteration);
    if (!parsedIteration.success) {
      throw new IterationDirectiveBuildError(
        "ITERATION_PAYLOAD_MISSING",
        `Iteration payload is invalid: ${parsedIteration.error.message}`,
      );
    }
    const parsedVerdict = reviewVerdictSchema.safeParse(verdict);
    if (!parsedVerdict.success) {
      throw new IterationDirectiveBuildError(
        "REVIEW_VERDICT_SCHEMA_INVALID",
        `Review verdict is invalid: ${parsedVerdict.error.message}`,
      );
    }

    const directive = iterationDirectiveSchema.safeParse({
      directive_id: createIterationDirectiveId(),
      workspace_id: parsedDecision.data.workspace_id,
      task_id: parsedDecision.data.task_id,
      source_execution_id: parsedDecision.data.execution_id,
      review_request_id: parsedDecision.data.review_request_id,
      review_result_id: parsedDecision.data.review_result_id,
      loop_decision_id: parsedDecision.data.decision_id,
      goal: parsedIteration.data.goal,
      requirements: [...parsedIteration.data.requirements],
      acceptance_criteria: [...parsedIteration.data.acceptance_criteria],
      created_at: new Date().toISOString(),
    });
    if (!directive.success) {
      throw new IterationDirectiveBuildError(
        "ITERATION_PAYLOAD_MISSING",
        `Iteration payload is invalid: ${directive.error.message}`,
      );
    }
    return directive.data;
  }
}
