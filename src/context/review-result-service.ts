import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateWorkspaceIdentityConsistency } from "../workspace/identity.js";
import { WorkspacePathError } from "../workspace/path.js";
import type { WorkspaceIdentity } from "../workspace/types.js";
import { ReviewDeliveryService } from "./review-delivery-service.js";
import {
  createResultId,
  reviewResultFile,
  reviewResultsDirectory,
  type CreateReviewResultInput,
  type ReviewResult,
} from "./review-result.js";
import {
  createReviewResultInputSchema,
  reviewResultSchema,
} from "./review-result-schema.js";
import { reviewRequestIdSchema } from "./review-schema.js";
import { defaultTaskContextStorageRoot } from "./task.js";
import { ReviewRequestService } from "./review-request-service.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function json(result: ReviewResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function workspaceMismatch(message: string): WorkspacePathError {
  return new WorkspacePathError(
    "WORKSPACE_IDENTITY_MISMATCH",
    `WORKSPACE_IDENTITY_MISMATCH: ${message}`,
  );
}

export class ReviewResultService {
  public readonly storageRoot: string;
  private readonly runtimeIdentity: WorkspaceIdentity | undefined;
  private readonly reviewRequests: ReviewRequestService;
  private readonly deliveries: ReviewDeliveryService;

  public constructor(
    storageRoot = defaultTaskContextStorageRoot(),
    runtimeIdentity?: WorkspaceIdentity,
  ) {
    this.storageRoot = resolve(storageRoot);
    this.runtimeIdentity = runtimeIdentity;
    this.reviewRequests = new ReviewRequestService(this.storageRoot);
    this.deliveries = new ReviewDeliveryService(this.storageRoot, runtimeIdentity);
  }

  public async createReviewResult(input: CreateReviewResultInput): Promise<ReviewResult> {
    const parsed = createReviewResultInputSchema.parse(input);
    this.validateRuntimeIdentity(parsed.workspace_id);

    const request = await this.reviewRequests.getReviewRequest(
      parsed.workspace_id,
      parsed.review_request_id,
    );
    if (request === null) {
      throw new Error(`Review request "${parsed.review_request_id}" was not found.`);
    }
    if (request.workspace_id !== parsed.workspace_id) {
      throw workspaceMismatch("Review request does not belong to the result workspace.");
    }

    const delivery = await this.deliveries.getDelivery(parsed.workspace_id, parsed.delivery_id);
    if (delivery === null) {
      throw new Error(`Review delivery "${parsed.delivery_id}" was not found.`);
    }
    await this.deliveries.validateDelivery(delivery, this.runtimeIdentity);
    if (delivery.status !== "delivered") {
      throw new Error("Review result requires a delivered review request.");
    }
    if (delivery.review_request_id !== parsed.review_request_id) {
      throw new Error("Review result request does not match the review delivery.");
    }
    if (request.task_id !== delivery.task_id) {
      throw new Error("Review result task does not match the review delivery.");
    }
    if (parsed.task_id !== undefined && parsed.task_id !== delivery.task_id) {
      throw new Error("Review result task does not match the review delivery.");
    }

    const existing = await this.getReviewResultByRequest(
      parsed.workspace_id,
      parsed.review_request_id,
    );
    if (existing !== null && existing.status === "COMPLETED") return existing;

    const result = reviewResultSchema.parse({
      ...parsed,
      result_id: existing?.result_id ?? parsed.result_id ?? createResultId(),
      task_id: delivery.task_id,
      created_at: existing?.created_at ?? new Date().toISOString(),
    });
    const directory = reviewResultsDirectory(this.storageRoot, result.workspace_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        reviewResultFile(this.storageRoot, result.workspace_id, result.result_id),
        json(result),
        { encoding: "utf8", flag: existing === null ? "wx" : "w", mode: 0o600 },
      );
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") {
        const current = await this.getReviewResultByRequest(
          parsed.workspace_id,
          parsed.review_request_id,
        );
        if (current !== null) return current;
      }
      throw new Error("Review result could not be saved.", { cause: error });
    }
    return result;
  }

  public async getReviewResult(
    workspaceId: string,
    resultId: string,
  ): Promise<ReviewResult | null> {
    const file = reviewResultFile(this.storageRoot, workspaceId, resultId);
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Review result could not be read.", { cause: error });
    }

    try {
      return reviewResultSchema.parse(JSON.parse(contents) as unknown);
    } catch (error: unknown) {
      throw new Error(`Review result "${resultId}" is invalid.`, { cause: error });
    }
  }

  public async getReviewResultByRequest(
    workspaceId: string,
    reviewRequestId: string,
  ): Promise<ReviewResult | null> {
    reviewRequestIdSchema.parse(reviewRequestId);
    const directory = reviewResultsDirectory(this.storageRoot, workspaceId);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Review results could not be inspected.", { cause: error });
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const resultId = entry.name.slice(0, -".json".length);
      const result = await this.getReviewResult(workspaceId, resultId);
      if (result?.review_request_id === reviewRequestId) return result;
    }
    return null;
  }

  public async listReviewResults(workspaceId: string): Promise<ReviewResult[]> {
    const directory = reviewResultsDirectory(this.storageRoot, workspaceId);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return [];
      throw new Error("Review results could not be listed.", { cause: error });
    }

    const results: ReviewResult[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const resultId = entry.name.slice(0, -".json".length);
      const result = await this.getReviewResult(workspaceId, resultId);
      if (result !== null) results.push(result);
    }
    return results.sort((left, right) => left.result_id.localeCompare(right.result_id));
  }

  private validateRuntimeIdentity(workspaceId: string): void {
    if (this.runtimeIdentity === undefined) return;
    validateWorkspaceIdentityConsistency(
      { ...this.runtimeIdentity, id: workspaceId },
      this.runtimeIdentity,
    );
  }
}
