import {
  BrowserWorkerClientError,
  type BrowserWorkerClient,
} from "../browser-worker-client/browser-worker-client.js";
import type { BrowserDeliveryResult } from "../browser-worker/protocol.js";
import type { ReviewDeliveryError } from "../context/review-delivery.js";
import type {
  ReviewDeliveryAdapter,
  ReviewDeliveryRequest,
  ReviewDeliveryResult,
} from "./review-delivery-adapter.js";
import { buildReviewMessage } from "./review-message.js";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 4000);
  return String(error).slice(0, 4000);
}

function resultFailure(result: BrowserDeliveryResult): ReviewDeliveryResult {
  const details: Record<BrowserDeliveryResult["status"], {
    readonly code: string;
    readonly retryable: boolean;
    readonly fallback: string;
  }> = {
    AUTH_REQUIRED: {
      code: "AUTH_REQUIRED",
      retryable: false,
      fallback: "ChatGPT authentication is required.",
    },
    CONVERSATION_NOT_FOUND: {
      code: "CONVERSATION_NOT_FOUND",
      retryable: false,
      fallback: "Conversation was not found.",
    },
    COMPOSER_NOT_FOUND: {
      code: "COMPOSER_NOT_FOUND",
      retryable: true,
      fallback: "ChatGPT composer was not found.",
    },
    SUBMIT_FAILED: {
      code: "SUBMIT_FAILED",
      retryable: true,
      fallback: "ChatGPT review message submission failed.",
    },
    SUBMITTED: {
      code: "SUBMITTED",
      retryable: false,
      fallback: "Review message was submitted.",
    },
  };
  const detail = details[result.status];
  return {
    status: "failed",
    retryable: detail.retryable,
    error: {
      code: detail.code,
      message: (result.error ?? detail.fallback).slice(0, 4000),
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
    private readonly client: Pick<BrowserWorkerClient, "deliver">,
  ) {}

  public async deliver(request: ReviewDeliveryRequest): Promise<ReviewDeliveryResult> {
    try {
      const result = await this.client.deliver(
        request.conversation_id,
        request.message ?? buildReviewMessage(request),
      );
      if (result.status === "SUBMITTED") {
        return { status: "delivered", delivered_at: new Date().toISOString() };
      }
      return resultFailure(result);
    } catch (error: unknown) {
      return clientFailure(error);
    }
  }
}
