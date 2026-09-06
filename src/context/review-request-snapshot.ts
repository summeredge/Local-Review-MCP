import { GitService } from "../git/service.js";
import type { ReviewSnapshot } from "../git/types.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { ReviewRequestService } from "./review-request-service.js";
import type { CreateReviewRequestInput, ReviewRequestContext } from "./types.js";

export interface ReviewSnapshotProvider {
  capture(workspaceId: string): Promise<ReviewSnapshot>;
}

export class WorkspaceReviewSnapshotProvider {
  public constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly createGitService: (workspaceId: string) => Pick<GitService, "snapshot"> =
      (workspaceId) => new GitService(this.registry.resolve(workspaceId).manager),
  ) {}

  public capture(workspaceId: string): Promise<ReviewSnapshot> {
    return this.createGitService(workspaceId).snapshot();
  }
}

export class ReviewRequestSnapshotCoordinator {
  public constructor(
    private readonly requests: ReviewRequestService,
    private readonly snapshots: ReviewSnapshotProvider,
  ) {}

  public async createReviewRequest(
    input: CreateReviewRequestInput,
  ): Promise<ReviewRequestContext> {
    const reviewSnapshot = await this.snapshots.capture(input.workspace_id);
    return this.requests.createReviewRequest({ ...input, review_snapshot: reviewSnapshot });
  }
}
