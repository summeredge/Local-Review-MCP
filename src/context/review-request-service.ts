import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createReviewRequestId,
  reviewRequestFile,
  reviewRequestsDirectory,
} from "./review-request.js";
import {
  createReviewRequestInputSchema,
  reviewRequestContextSchema,
  updateReviewRequestInputSchema,
} from "./review-schema.js";
import { defaultTaskContextStorageRoot } from "./task.js";
import type {
  CreateReviewRequestInput,
  ReviewRequestContext,
  UpdateReviewRequestInput,
} from "./types.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function json(context: ReviewRequestContext): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

export class ReviewRequestService {
  public readonly storageRoot: string;

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.storageRoot = resolve(storageRoot);
  }

  public async createReviewRequest(
    input: CreateReviewRequestInput,
  ): Promise<ReviewRequestContext> {
    const parsed = createReviewRequestInputSchema.parse({
      ...input,
      review_request_id: input.review_request_id ?? createReviewRequestId(),
    });
    const timestamp = new Date().toISOString();
    const context: ReviewRequestContext = reviewRequestContextSchema.parse({
      review_request_id: parsed.review_request_id,
      task_id: parsed.task_id,
      execution_id: parsed.execution_id,
      workspace_id: parsed.workspace_id,
      ...(parsed.conversation_id === undefined ? {} : { conversation_id: parsed.conversation_id }),
      status: parsed.status,
      created_at: timestamp,
      updated_at: timestamp,
    });
    const directory = reviewRequestsDirectory(this.storageRoot, context.workspace_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = reviewRequestFile(
      this.storageRoot,
      context.workspace_id,
      context.review_request_id,
    );
    try {
      await writeFile(file, json(context), { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") {
        throw new Error(
          `Review request "${context.review_request_id}" already exists.`,
          { cause: error },
        );
      }
      throw new Error("Review request could not be saved.", { cause: error });
    }
    return context;
  }

  public async getReviewRequest(
    workspaceId: string,
    reviewRequestId: string,
  ): Promise<ReviewRequestContext | null> {
    const file = reviewRequestFile(this.storageRoot, workspaceId, reviewRequestId);
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Review request could not be read.", { cause: error });
    }

    try {
      return reviewRequestContextSchema.parse(JSON.parse(contents) as unknown);
    } catch (error: unknown) {
      throw new Error(`Review request "${reviewRequestId}" is invalid.`, { cause: error });
    }
  }

  public async updateReviewRequest(
    workspaceId: string,
    reviewRequestId: string,
    patch: UpdateReviewRequestInput,
  ): Promise<ReviewRequestContext> {
    const current = await this.getReviewRequest(workspaceId, reviewRequestId);
    if (current === null) {
      throw new Error(`Review request "${reviewRequestId}" was not found.`);
    }

    const parsed = updateReviewRequestInputSchema.parse(patch);
    const next = reviewRequestContextSchema.parse({
      ...current,
      ...(parsed.conversation_id === undefined ? {} : { conversation_id: parsed.conversation_id }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      updated_at: new Date().toISOString(),
    });
    try {
      await writeFile(
        reviewRequestFile(this.storageRoot, workspaceId, reviewRequestId),
        json(next),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error: unknown) {
      throw new Error("Review request could not be saved.", { cause: error });
    }
    return next;
  }

  public async listReviewRequests(
    workspaceId: string,
  ): Promise<ReviewRequestContext[]> {
    const directory = reviewRequestsDirectory(this.storageRoot, workspaceId);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return [];
      throw new Error("Review requests could not be listed.", { cause: error });
    }

    const requests: ReviewRequestContext[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const reviewRequestId = entry.name.slice(0, -".json".length);
      const request = await this.getReviewRequest(workspaceId, reviewRequestId);
      if (request !== null) requests.push(request);
    }
    return requests.sort((left, right) => left.review_request_id.localeCompare(right.review_request_id));
  }
}
