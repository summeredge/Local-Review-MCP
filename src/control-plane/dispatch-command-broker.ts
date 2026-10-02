import {
  EXTENSION_DELIVERY_LEASE_MS,
  ExtensionDeliveryNotReadyError,
  ExtensionDeliveryConflictError,
  ExtensionDeliveryService,
  TargetConversationDeliveryError,
  type ExtensionDeliveryReceipt,
  type ExtensionDeliveryReadinessCheck,
} from "./extension-delivery.js";
import type { ReviewDeliveryRequest } from "../delivery/review-delivery-adapter.js";
import { buildReviewMessage } from "../delivery/review-message.js";

export const DEFAULT_DISPATCH_COMMAND_TIMEOUT_MS = EXTENSION_DELIVERY_LEASE_MS;

export interface DispatchCommandBrokerOptions {
  readonly timeoutMs?: number;
  readonly readiness?: ExtensionDeliveryReadinessCheck;
}

export class DispatchCommandBroker {
  private readonly timeoutMs: number;
  private readonly readiness: ExtensionDeliveryReadinessCheck;

  public constructor(
    private readonly extensionDeliveries: Pick<ExtensionDeliveryService, "enqueue" | "awaitResult">
      & Partial<Pick<ExtensionDeliveryService, "expire" | "getByLogicalDeliveryId" | "get">> = new ExtensionDeliveryService(),
    options: DispatchCommandBrokerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DISPATCH_COMMAND_TIMEOUT_MS;
    this.readiness = options.readiness ?? (() => ({ ready: true }));
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("Dispatch Command Broker timeoutMs must be a positive integer.");
    }
  }

  public async dispatch(request: ReviewDeliveryRequest): Promise<ExtensionDeliveryReceipt | null> {
    const message = request.message ?? buildReviewMessage(request);
    const existing = await this.extensionDeliveries.getByLogicalDeliveryId?.(request.delivery_id);
    if (existing) {
      if (existing.conversation_id !== request.conversation_id || existing.message !== message) {
        throw new ExtensionDeliveryConflictError("logical delivery command already targets different content");
      }
      // A durable receipt is authoritative even if the extension has since disconnected.
      if (existing.receipt?.status === "delivered") return existing.receipt;
    }
    const readinessCheckTime = Date.now();
    let readiness: Awaited<ReturnType<ExtensionDeliveryReadinessCheck>>;
    try {
      readiness = await this.readiness(request.conversation_id);
    } catch (error: unknown) {
      throw new ExtensionDeliveryNotReadyError("Extension Delivery readiness could not be confirmed.", {
        cause: error,
      });
    }
    const ready = typeof readiness === "boolean" ? readiness : readiness.ready;
    // Queue before page recovery: the authenticated MV3 worker can discover this durable
    // target even when every ChatGPT content document has been closed.
    const recoverable = typeof readiness !== "boolean" && ["extension_not_present",
      "target_conversation_not_present"].includes(readiness.readiness_state ?? "");
    if (!ready && !recoverable) {
      const reason = typeof readiness === "boolean" ? undefined : readiness.reason;
      throw new ExtensionDeliveryNotReadyError(
        reason === undefined ? "Extension Delivery is not ready." : `Extension Delivery is not ready: ${reason}`,
      );
    }

    const command = await this.extensionDeliveries.enqueue(
      request.conversation_id,
      message,
      request.delivery_id,
      {
        readiness_check_time: readinessCheckTime,
        readiness_result: typeof readiness === "boolean"
          ? "ready"
          : readiness.readiness_state ?? "ready",
      },
    );
    const receipt = await this.extensionDeliveries.awaitResult(command.delivery_id, this.timeoutMs);
    if (receipt !== null) return receipt;
    const current = await this.extensionDeliveries.get?.(command.delivery_id);
    const expired = this.extensionDeliveries.expire === undefined
      ? null
      : await this.extensionDeliveries.expire(command.delivery_id);
    if (expired !== null) return expired;
    // A claim can acquire the service lock between the snapshot and expire. Its
    // retained ambiguous command must keep the ACK path, not become a page error.
    const retained = await this.extensionDeliveries.get?.(command.delivery_id);
    if (current?.phase === "queued" && (retained === null || retained?.phase === "queued")) {
      const code = current.recovery_error ?? (recoverable
        ? "TARGET_CONVERSATION_EXTENSION_NOT_READY" : "TARGET_CONVERSATION_NOT_PRESENT");
      throw new TargetConversationDeliveryError(code,
        code !== "TARGET_CONVERSATION_NOT_FOUND" && code !== "TARGET_CONVERSATION_AUTH_REQUIRED");
    }
    return null;
  }
}
