import {
  ExtensionDeliveryService,
  type ExtensionDeliveryReceipt,
} from "./extension-delivery.js";
import type { ReviewDeliveryRequest } from "../delivery/review-delivery-adapter.js";
import { buildReviewMessage } from "../delivery/review-message.js";

export const DEFAULT_DISPATCH_COMMAND_TIMEOUT_MS = 30_000;

export interface DispatchCommandBrokerOptions {
  readonly timeoutMs?: number;
}

export class DispatchCommandBroker {
  private readonly timeoutMs: number;

  public constructor(
    private readonly extensionDeliveries: Pick<ExtensionDeliveryService, "enqueue" | "awaitResult"> = new ExtensionDeliveryService(),
    options: DispatchCommandBrokerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DISPATCH_COMMAND_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("Dispatch Command Broker timeoutMs must be a positive integer.");
    }
  }

  public async dispatch(request: ReviewDeliveryRequest): Promise<ExtensionDeliveryReceipt | null> {
    const command = await this.extensionDeliveries.enqueue(
      request.conversation_id,
      request.message ?? buildReviewMessage(request),
      request.delivery_id,
    );
    return this.extensionDeliveries.awaitResult(command.delivery_id, this.timeoutMs);
  }
}
