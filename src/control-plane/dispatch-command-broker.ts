import {
  ExtensionDeliveryNotReadyError,
  ExtensionDeliveryService,
  type ExtensionDeliveryReceipt,
  type ExtensionDeliveryReadinessCheck,
} from "./extension-delivery.js";
import type { ReviewDeliveryRequest } from "../delivery/review-delivery-adapter.js";
import { buildReviewMessage } from "../delivery/review-message.js";

export const DEFAULT_DISPATCH_COMMAND_TIMEOUT_MS = 30_000;

export interface DispatchCommandBrokerOptions {
  readonly timeoutMs?: number;
  readonly readiness?: ExtensionDeliveryReadinessCheck;
}

export class DispatchCommandBroker {
  private readonly timeoutMs: number;
  private readonly readiness: ExtensionDeliveryReadinessCheck;

  public constructor(
    private readonly extensionDeliveries: Pick<ExtensionDeliveryService, "enqueue" | "awaitResult">
      & Partial<Pick<ExtensionDeliveryService, "expire">> = new ExtensionDeliveryService(),
    options: DispatchCommandBrokerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DISPATCH_COMMAND_TIMEOUT_MS;
    this.readiness = options.readiness ?? (() => ({ ready: true }));
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("Dispatch Command Broker timeoutMs must be a positive integer.");
    }
  }

  public async dispatch(request: ReviewDeliveryRequest): Promise<ExtensionDeliveryReceipt | null> {
    let readiness: Awaited<ReturnType<ExtensionDeliveryReadinessCheck>>;
    try {
      readiness = await this.readiness(request.conversation_id);
    } catch (error: unknown) {
      throw new ExtensionDeliveryNotReadyError("Extension Delivery readiness could not be confirmed.", {
        cause: error,
      });
    }
    const ready = typeof readiness === "boolean" ? readiness : readiness.ready;
    if (!ready) {
      const reason = typeof readiness === "boolean" ? undefined : readiness.reason;
      throw new ExtensionDeliveryNotReadyError(
        reason === undefined ? "Extension Delivery is not ready." : `Extension Delivery is not ready: ${reason}`,
      );
    }

    const command = await this.extensionDeliveries.enqueue(
      request.conversation_id,
      request.message ?? buildReviewMessage(request),
      request.delivery_id,
    );
    const receipt = await this.extensionDeliveries.awaitResult(command.delivery_id, this.timeoutMs);
    if (receipt !== null) return receipt;
    return this.extensionDeliveries.expire === undefined
      ? null
      : this.extensionDeliveries.expire(command.delivery_id);
  }
}
