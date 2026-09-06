import { describe, expect, it } from "vitest";
import type { BrowserDeliveryResult } from "../src/browser-worker-client/browser-worker-client.js";
import { BrowserWorkerClientError } from "../src/browser-worker-client/browser-worker-client.js";
import { BrowserWorkerDeliveryAdapter } from "../src/delivery/browser-worker-delivery-adapter.js";
import type { ReviewDeliveryRequest } from "../src/delivery/review-delivery-adapter.js";

const request: ReviewDeliveryRequest = {
  delivery_id: "delivery-001",
  workspace_id: "workspace-001",
  task_id: "task-001",
  review_request_id: "review-001",
  routing_id: "routing-001",
  conversation_id: "conversation-001",
  message: "must not be sent by the navigation-only adapter",
};

describe("BrowserWorkerDeliveryAdapter", () => {
  it("maps only SUBMITTED to delivered and sends the review message", async () => {
    const requests: Array<{ conversationId: string; message: string }> = [];
    const client = {
      deliver: async (conversationId: string, message: string): Promise<BrowserDeliveryResult> => {
        requests.push({ conversationId, message });
        return {
          conversationId,
          url: `https://chatgpt.com/c/${conversationId}`,
          status: "SUBMITTED",
        };
      },
    };

    const result = await new BrowserWorkerDeliveryAdapter(client).deliver(request);

    expect(result).toMatchObject({ status: "delivered" });
    expect(result.status === "delivered" && Number.isNaN(Date.parse(result.delivered_at))).toBe(false);
    expect(requests).toEqual([{
      conversationId: "conversation-001",
      message: "must not be sent by the navigation-only adapter",
    }]);
  });

  it("maps a non-submitted delivery result to failed", async () => {
    const client = {
      deliver: async (conversationId: string): Promise<BrowserDeliveryResult> => ({
        conversationId,
        status: "COMPOSER_NOT_FOUND",
        error: "conversation composer missing",
      }),
    };

    await expect(new BrowserWorkerDeliveryAdapter(client).deliver(request)).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: {
        code: "COMPOSER_NOT_FOUND",
        message: "conversation composer missing",
      },
    });
  });

  it("keeps authentication and missing conversations non-retryable", async () => {
    for (const status of ["AUTH_REQUIRED", "CONVERSATION_NOT_FOUND"] as const) {
      const client = {
        deliver: async (conversationId: string): Promise<BrowserDeliveryResult> => ({
          conversationId,
          status,
          error: status === "AUTH_REQUIRED"
            ? "ChatGPT authentication is required."
            : "Conversation was not found.",
        }),
      };

      await expect(new BrowserWorkerDeliveryAdapter(client).deliver(request))
        .resolves.toMatchObject({ status: "failed", retryable: false, error: { code: status } });
    }
  });

  it("maps Browser Worker transport failures without claiming delivery", async () => {
    const client = {
      deliver: async (): Promise<BrowserDeliveryResult> => {
        throw new BrowserWorkerClientError("TIMEOUT", "Browser Worker request timed out.");
      },
    };

    await expect(new BrowserWorkerDeliveryAdapter(client).deliver(request)).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: { code: "DELIVERY_TIMEOUT", message: "Browser Worker request timed out." },
    });
  });
});
