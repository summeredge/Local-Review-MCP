import { conversationUrl } from "./conversation-url.js";
import {
  classifyBrowserDeliveryError,
  isRetryableBrowserError,
  type BrowserDeliveryDriver,
} from "./browser-delivery-driver.js";
import type {
  ReviewDeliveryAdapter,
  ReviewDeliveryRequest,
  ReviewDeliveryResult,
} from "./review-delivery-adapter.js";

export class BrowserDeliveryAdapter implements ReviewDeliveryAdapter {
  public constructor(private readonly driver: BrowserDeliveryDriver) {}

  public async deliver(request: ReviewDeliveryRequest): Promise<ReviewDeliveryResult> {
    conversationUrl(request.conversation_id);
    try {
      await this.driver.openConversation(request.conversation_id);
      const result = await this.driver.sendMessage(request.conversation_id, request.message);
      if (result.status === "delivered") return result;

      const error = classifyBrowserDeliveryError(result.error);
      return { status: "failed", retryable: isRetryableBrowserError(error.code), error };
    } catch (error: unknown) {
      const classified = classifyBrowserDeliveryError(error);
      return {
        status: "failed",
        retryable: isRetryableBrowserError(classified.code),
        error: classified,
      };
    }
  }
}
