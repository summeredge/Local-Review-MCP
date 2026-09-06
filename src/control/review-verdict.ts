export const REVIEW_VERDICT_DECISIONS = [
  "APPROVE",
  "ITERATE",
  "HUMAN_REQUIRED",
] as const;

export type ReviewVerdictDecision = typeof REVIEW_VERDICT_DECISIONS[number];

export interface ReviewVerdictIteration {
  readonly goal: string;
  readonly requirements: readonly string[];
  readonly acceptance_criteria: readonly string[];
}

export interface ReviewVerdict {
  readonly schema_version: 1;
  readonly review_request_id: string;
  readonly decision: ReviewVerdictDecision;
  readonly summary: string;
  readonly iteration?: ReviewVerdictIteration;
}
