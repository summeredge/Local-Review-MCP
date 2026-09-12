import { DispatchCommandBroker } from "../control-plane/dispatch-command-broker.js";
import {
  ExtensionDeliveryConflictError,
  ExtensionDeliveryNotFoundError,
  ExtensionDeliveryNotReadyError,
  ExtensionDeliveryUnavailableError,
  type ExtensionDeliveryReceipt,
} from "../control-plane/extension-delivery.js";
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

function receiptError(receipt: ExtensionDeliveryReceipt, fallback: string): ReviewDeliveryError {
  return {
    code: receipt.status === "ambiguous" ? "EXTENSION_DELIVERY_AMBIGUOUS" : "EXTENSION_DELIVERY_FAILED",
    message: (receipt.error ?? fallback).slice(0, 4000),
  };
}

function brokerFailure(error: unknown): ReviewDeliveryResult {
  const code = error instanceof ExtensionDeliveryConflictError
    ? "EXTENSION_DELIVERY_CONFLICT"
    : error instanceof ExtensionDeliveryNotFoundError
      ? "EXTENSION_DELIVERY_NOT_FOUND"
      : error instanceof ExtensionDeliveryNotReadyError
        ? "EXTENSION_NOT_READY"
        : error instanceof ExtensionDeliveryUnavailableError
          ? "EXTENSION_DELIVERY_UNAVAILABLE"
          : "EXTENSION_DELIVERY_BROKER_FAILED";
  return {
    status: "failed",
    retryable: error instanceof ExtensionDeliveryNotReadyError
      || error instanceof ExtensionDeliveryUnavailableError,
    error: { code, message: errorMessage(error) },
  };
}

export class ExtensionDeliveryAdapter implements ReviewDeliveryAdapter {
  public constructor(
    private readonly broker: Pick<DispatchCommandBroker, "dispatch"> = new DispatchCommandBroker(),
  ) {}

  public async deliver(request: ReviewDeliveryRequest): Promise<ReviewDeliveryResult> {
    let receipt: ExtensionDeliveryReceipt | null;
    try {
      receipt = await this.broker.dispatch(request);
    } catch (error: unknown) {
      return brokerFailure(error);
    }
    if (receipt === null) {
      return {
        status: "failed",
        retryable: true,
        error: {
          code: "EXTENSION_DELIVERY_TIMEOUT",
          message: "Extension Delivery did not produce a durable result before the timeout.",
        },
      };
    }
    if (receipt.status === "delivered") {
      return {
        status: "delivered",
        delivered_at: new Date(receipt.completed_at).toISOString(),
      };
    }
    if (receipt.status === "ambiguous") {
      return {
        status: "ambiguous",
        error: receiptError(receipt, "Extension Delivery could not prove whether the message was sent."),
      };
    }
    return {
      status: "failed",
      retryable: false,
      error: receiptError(receipt, "Extension Delivery did not send the message."),
    };
  }
}
