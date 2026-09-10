export interface ReviewCompletionRequest {
  readonly workspace_id: string;
  readonly task_id: string;
  readonly review_request_id: string;
  readonly delivery_id: string;
  readonly conversation_id: string;
}

export type ReviewCompletionResult =
  | {
    readonly status: "COMPLETED";
    readonly content: string;
  }
  | {
    readonly status: "TIMEOUT" | "FAILED";
    readonly error: string;
  };

export interface ReviewCompletionAdapter {
  collect(request: ReviewCompletionRequest): Promise<ReviewCompletionResult>;
}
