import {
  BrowserWorkerClient,
  type BrowserCompletionResult,
} from "../browser-worker-client/browser-worker-client.js";
import type {
  ReviewCompletionAdapter,
  ReviewCompletionRequest,
  ReviewCompletionResult,
} from "./review-completion-adapter.js";

function resultOf(result: BrowserCompletionResult): ReviewCompletionResult {
  return result.status === "COMPLETED"
    ? { status: "COMPLETED", content: result.content }
    : { status: result.status, error: result.error };
}

export class BrowserWorkerReviewCompletionAdapter implements ReviewCompletionAdapter {
  public constructor(
    private readonly client: Pick<BrowserWorkerClient, "collectCompletion"> = new BrowserWorkerClient(),
  ) {}

  public async collect(request: ReviewCompletionRequest): Promise<ReviewCompletionResult> {
    return resultOf(await this.client.collectCompletion(
      request.conversation_id,
      request.review_request_id,
    ));
  }
}
