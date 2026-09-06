import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { reviewResultIdSchema } from "./review-result-schema.js";
import { workspaceIdSchema } from "./schema.js";
import { TASK_DIRECTORY } from "./task.js";
import type { ReviewResultStatus } from "./review-result-schema.js";

export interface ReviewResult {
  readonly result_id: string;
  readonly review_request_id: string;
  readonly delivery_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly status: ReviewResultStatus;
  readonly content?: string;
  readonly error?: string;
  readonly created_at: string;
}

export interface CreateReviewResultInput {
  readonly result_id?: string;
  readonly review_request_id: string;
  readonly delivery_id: string;
  readonly workspace_id: string;
  readonly task_id?: string;
  readonly status: ReviewResultStatus;
  readonly content?: string;
  readonly error?: string;
}

export const REVIEW_RESULTS_DIRECTORY = join(TASK_DIRECTORY, "review_results");

export function reviewResultsDirectory(storageRoot: string, workspaceId: string): string {
  const safeWorkspaceId = workspaceIdSchema.parse(workspaceId);
  return join(resolve(storageRoot), REVIEW_RESULTS_DIRECTORY, safeWorkspaceId);
}

export function reviewResultFile(
  storageRoot: string,
  workspaceId: string,
  resultId: string,
): string {
  const safeResultId = reviewResultIdSchema.parse(resultId);
  return join(reviewResultsDirectory(storageRoot, workspaceId), `${safeResultId}.json`);
}

export function createResultId(): string {
  return `result-${randomUUID()}`;
}
