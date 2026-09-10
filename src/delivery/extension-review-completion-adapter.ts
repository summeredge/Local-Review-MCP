import type {
  ExtensionDelivery,
  ExtensionDeliveryService,
} from "../control-plane/extension-delivery.js";
import type {
  ExtensionReviewCompletion,
  ExtensionReviewCompletionReceipt,
  ExtensionReviewCompletionService,
} from "../control-plane/extension-review-completion.js";
import type {
  ReviewCompletionAdapter,
  ReviewCompletionRequest,
  ReviewCompletionResult,
} from "./review-completion-adapter.js";

export const DEFAULT_EXTENSION_REVIEW_COMPLETION_TIMEOUT_MS = 120_000;

export interface ExtensionReviewCompletionAdapterOptions {
  readonly timeoutMs?: number;
}

type ExtensionDeliveryLookup = Pick<ExtensionDeliveryService, "getByLogicalDeliveryId">;
type ExtensionReviewCompletionPort = Pick<
  ExtensionReviewCompletionService,
  "enqueue" | "awaitResult"
>;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 4000);
  return String(error).slice(0, 4000);
}

function failed(error: string): ReviewCompletionResult {
  return { status: "FAILED", error: error.slice(0, 4000) };
}

function validateDelivery(
  request: ReviewCompletionRequest,
  delivery: ExtensionDelivery,
): string | null {
  if (delivery.logical_delivery_id !== request.delivery_id) {
    return "Extension Delivery logical_delivery_id does not match the Review Delivery identity.";
  }
  if (delivery.conversation_id !== request.conversation_id) {
    return "Extension Delivery conversation_id does not match the Review Completion request.";
  }
  if (delivery.phase !== "delivered" || delivery.receipt?.status !== "delivered") {
    return "Extension Delivery has not produced a delivered receipt.";
  }
  if (delivery.receipt.delivery_id !== delivery.delivery_id
    || delivery.receipt.conversation_id !== delivery.conversation_id) {
    return "Extension Delivery receipt identity is invalid.";
  }
  if (typeof delivery.receipt.message_id !== "string" || delivery.receipt.message_id === "") {
    return "Extension Delivery delivered receipt is missing message_id.";
  }
  return null;
}

function validateCompletion(
  request: ReviewCompletionRequest,
  expectedUserMessageId: string,
  completion: ExtensionReviewCompletion,
): string | null {
  if (completion.workspace_id !== request.workspace_id
    || completion.task_id !== request.task_id
    || completion.review_request_id !== request.review_request_id
    || completion.review_delivery_id !== request.delivery_id
    || completion.conversation_id !== request.conversation_id
    || completion.expected_user_message_id !== expectedUserMessageId) {
    return "Extension Review Completion identity conflict.";
  }
  return null;
}

function resultOf(receipt: ExtensionReviewCompletionReceipt): ReviewCompletionResult {
  if (receipt.status === "completed") {
    return typeof receipt.content === "string"
      ? { status: "COMPLETED", content: receipt.content }
      : failed("Extension Review Completion completed receipt is missing content.");
  }
  if (receipt.status === "ambiguous") {
    return failed(`Extension Review Completion ambiguous: ${receipt.error ?? "no error was recorded"}`);
  }
  return failed(receipt.error ?? "Extension Review Completion failed.");
}

export class ExtensionReviewCompletionAdapter implements ReviewCompletionAdapter {
  private readonly timeoutMs: number;

  public constructor(
    private readonly extensionDeliveries: ExtensionDeliveryLookup,
    private readonly extensionReviewCompletions: ExtensionReviewCompletionPort,
    options: ExtensionReviewCompletionAdapterOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EXTENSION_REVIEW_COMPLETION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 0) {
      throw new Error("Extension Review Completion timeoutMs must be a non-negative integer.");
    }
  }

  public async collect(request: ReviewCompletionRequest): Promise<ReviewCompletionResult> {
    try {
      const delivery = await this.extensionDeliveries.getByLogicalDeliveryId(request.delivery_id);
      if (delivery === null) {
        return failed(`Extension Delivery for logical id "${request.delivery_id}" was not found.`);
      }
      const deliveryError = validateDelivery(request, delivery);
      if (deliveryError !== null) return failed(deliveryError);

      const expectedUserMessageId = delivery.receipt!.message_id!;
      const completion = await this.extensionReviewCompletions.enqueue({
        workspace_id: request.workspace_id,
        task_id: request.task_id,
        review_request_id: request.review_request_id,
        review_delivery_id: request.delivery_id,
        conversation_id: request.conversation_id,
        expected_user_message_id: expectedUserMessageId,
      });
      const completionError = validateCompletion(request, expectedUserMessageId, completion);
      if (completionError !== null) return failed(completionError);

      const receipt = await this.extensionReviewCompletions.awaitResult(
        completion.completion_id,
        this.timeoutMs,
      );
      if (receipt === null) {
        return {
          status: "TIMEOUT",
          error: "Extension Review Completion did not produce a durable result before the timeout.",
        };
      }
      return resultOf(receipt);
    } catch (error: unknown) {
      return failed(errorMessage(error));
    }
  }
}
