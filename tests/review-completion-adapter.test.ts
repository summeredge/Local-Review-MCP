import { describe, expect, it, vi } from "vitest";
import { BrowserWorkerReviewCompletionAdapter } from "../src/delivery/browser-worker-review-completion-adapter.js";

const request = {
  workspace_id: "workspace-a",
  task_id: "task-a",
  review_request_id: "review-a",
  delivery_id: "delivery-a",
  conversation_id: "conversation-a",
} as const;

describe("BrowserWorkerReviewCompletionAdapter", () => {
  it("passes the full completion identity to Browser Worker and preserves result semantics", async () => {
    const collectCompletion = vi.fn(async () => ({
      conversationId: request.conversation_id,
      status: "COMPLETED" as const,
      content: "final assistant text",
      extractedAt: new Date().toISOString(),
    }));
    const adapter = new BrowserWorkerReviewCompletionAdapter({ collectCompletion });

    await expect(adapter.collect(request)).resolves.toEqual({
      status: "COMPLETED",
      content: "final assistant text",
    });
    expect(collectCompletion).toHaveBeenCalledWith(
      request.conversation_id,
      request.review_request_id,
    );
  });

  it.each(["TIMEOUT", "FAILED"] as const)("preserves %s errors", async (status) => {
    const adapter = new BrowserWorkerReviewCompletionAdapter({
      collectCompletion: async () => ({
        conversationId: request.conversation_id,
        status,
        error: "completion did not finish",
      }),
    });

    await expect(adapter.collect(request)).resolves.toEqual({
      status,
      error: "completion did not finish",
    });
  });
});
