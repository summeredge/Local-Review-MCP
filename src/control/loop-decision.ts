import { randomUUID } from "node:crypto";

export const LOOP_DECISION_ACTIONS = [
  "COMPLETE",
  "ITERATE",
  "HUMAN_REQUIRED",
  "RETRY_REVIEW",
  "WAIT",
] as const;

export type LoopDecisionAction = typeof LOOP_DECISION_ACTIONS[number];

export const LOOP_DECISION_REASON_CODES = [
  "REVIEW_APPROVED",
  "REVIEW_REQUIRES_ITERATION",
  "REVIEW_REQUIRES_HUMAN",
  "REVIEW_TIMEOUT",
  "REVIEW_FAILED",
  "REVIEW_VERDICT_INVALID",
  "REVIEW_PENDING",
] as const;

export type LoopDecisionReasonCode = typeof LOOP_DECISION_REASON_CODES[number];

export interface LoopDecision {
  readonly decision_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly execution_id: string;
  readonly review_request_id: string;
  /** Absent only while WAIT means that no ReviewResult exists yet. */
  readonly review_result_id?: string;
  readonly action: LoopDecisionAction;
  readonly reason_code: LoopDecisionReasonCode;
  readonly summary?: string;
  readonly created_at: string;
}

export function createLoopDecisionId(): string {
  return `loop-decision-${randomUUID()}`;
}
