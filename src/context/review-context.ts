import { randomUUID } from "node:crypto";

export interface ReviewContextProjection {
  readonly review_context_id: string;
  readonly workspace_id: string;
  readonly task: {
    readonly task_id: string;
    readonly title?: string;
    readonly description?: string;
    readonly status?: string;
  };
  readonly execution: {
    readonly execution_id: string;
    readonly status: string;
    readonly command?: string;
    readonly summary?: string;
    readonly started_at: string;
    readonly finished_at?: string;
  };
  readonly review_request: {
    readonly review_request_id: string;
    readonly status: string;
    readonly conversation_id?: string;
  };
  readonly generated_at: string;
}

export function createReviewContextId(): string {
  return `review-context-${randomUUID()}`;
}
