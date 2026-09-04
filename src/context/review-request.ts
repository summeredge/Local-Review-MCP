import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { workspaceIdSchema } from "./schema.js";
import { reviewRequestIdSchema } from "./review-schema.js";
import { TASK_DIRECTORY } from "./task.js";

export const REVIEW_REQUESTS_DIRECTORY = join(TASK_DIRECTORY, "review_requests");

export function reviewRequestsDirectory(storageRoot: string, workspaceId: string): string {
  const safeWorkspaceId = workspaceIdSchema.parse(workspaceId);
  return join(resolve(storageRoot), REVIEW_REQUESTS_DIRECTORY, safeWorkspaceId);
}

export function reviewRequestFile(
  storageRoot: string,
  workspaceId: string,
  reviewRequestId: string,
): string {
  const safeReviewRequestId = reviewRequestIdSchema.parse(reviewRequestId);
  return join(reviewRequestsDirectory(storageRoot, workspaceId), `${safeReviewRequestId}.json`);
}

export function createReviewRequestId(): string {
  return randomUUID();
}
