import { describe, expect, it } from "vitest";
import type { NavigationResult } from "../src/browser-worker-client/browser-worker-client.js";
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
  it("maps NAVIGATED to delivered and routes only the conversation ID", async () => {
    const conversationIds: string[] = [];
    const client = {
      navigate: async (conversationId: string): Promise<NavigationResult> => {
        conversationIds.push(conversationId);
        return {
          conversationId,
          url: `https://chatgpt.com/c/${conversationId}`,
          status: "NAVIGATED",
        };
      },
    };

    const result = await new BrowserWorkerDeliveryAdapter(client).deliver(request);

    expect(result).toMatchObject({ status: "delivered" });
    expect(result.status === "delivered" && Number.isNaN(Date.parse(result.delivered_at))).toBe(false);
    expect(conversationIds).toEqual(["conversation-001"]);
  });

  it("maps a FAILED navigation result to failed", async () => {
    const client = {
      navigate: async (conversationId: string): Promise<NavigationResult> => ({
        conversationId,
        status: "FAILED",
        error: "conversation navigation failed",
      }),
    };

    await expect(new BrowserWorkerDeliveryAdapter(client).deliver(request)).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: {
        code: "BROWSER_NAVIGATION_FAILED",
        message: "conversation navigation failed",
      },
    });
  });

  it("maps Browser Worker transport failures without claiming delivery", async () => {
    const client = {
      navigate: async (): Promise<NavigationResult> => {
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
