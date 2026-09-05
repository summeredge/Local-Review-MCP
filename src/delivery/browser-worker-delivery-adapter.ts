import {
  BrowserWorkerClientError,
  type BrowserWorkerClient,
} from "../browser-worker-client/browser-worker-client.js";
import type { ReviewDeliveryError } from "../context/review-delivery.js";
import type {
  ReviewDeliveryAdapter,
  ReviewDeliveryRequest,
  ReviewDeliveryResult,
} from "./review-delivery-adapter.js";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 4000);
  return String(error).slice(0, 4000);
}

function resultFailure(message: string): ReviewDeliveryResult {
  return {
    status: "failed",
    retryable: true,
    error: {
      code: "BROWSER_NAVIGATION_FAILED",
      message: message.slice(0, 4000),
    },
  };
}

function clientFailure(error: unknown): ReviewDeliveryResult {
  if (!(error instanceof BrowserWorkerClientError)) {
    return {
      status: "failed",
      retryable: true,
      error: { code: "BROWSER_WORKER_UNAVAILABLE", message: errorMessage(error) },
    };
  }

  const mapped: ReviewDeliveryError = error.code === "TIMEOUT"
    ? { code: "DELIVERY_TIMEOUT", message: error.message }
    : error.code === "UNAVAILABLE"
      ? { code: "BROWSER_NOT_AVAILABLE", message: error.message }
      : error.code === "HTTP_ERROR"
        ? { code: "BROWSER_WORKER_HTTP_ERROR", message: error.message }
        : error.code === "INVALID_RESPONSE"
          ? { code: "BROWSER_WORKER_INVALID_RESPONSE", message: error.message }
          : { code: "BROWSER_WORKER_CONFIG_ERROR", message: error.message };

  return {
    status: "failed",
    retryable: error.code === "TIMEOUT"
      || error.code === "UNAVAILABLE"
      || (error.code === "HTTP_ERROR" && (error.statusCode === undefined || error.statusCode >= 500)),
    error: mapped,
  };
}

export class BrowserWorkerDeliveryAdapter implements ReviewDeliveryAdapter {
  public constructor(
    private readonly client: Pick<BrowserWorkerClient, "navigate">,
  ) {}

  public async deliver(request: ReviewDeliveryRequest): Promise<ReviewDeliveryResult> {
    try {
      const result = await this.client.navigate(request.conversation_id);
      if (result.status === "NAVIGATED") {
        return { status: "delivered", delivered_at: new Date().toISOString() };
      }
      return resultFailure(result.error ?? "Browser Worker failed to navigate the conversation.");
    } catch (error: unknown) {
      return clientFailure(error);
    }
  }
}
