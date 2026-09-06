export const BROWSER_DELIVERY_STATUSES = [
  "SUBMITTED",
  "AUTH_REQUIRED",
  "CONVERSATION_NOT_FOUND",
  "COMPOSER_NOT_FOUND",
  "SUBMIT_FAILED",
] as const;

export type BrowserDeliveryStatus = typeof BROWSER_DELIVERY_STATUSES[number];

export interface NavigationResult {
  readonly conversationId: string;
  readonly url?: string;
  readonly status: "NAVIGATED" | "FAILED";
  readonly error?: string;
}

export interface BrowserDeliveryResult {
  readonly conversationId: string;
  readonly url?: string;
  readonly status: BrowserDeliveryStatus;
  readonly error?: string;
}

export const BROWSER_COMPLETION_STATUSES = ["COMPLETED", "TIMEOUT", "FAILED"] as const;
export type BrowserCompletionStatus = typeof BROWSER_COMPLETION_STATUSES[number];

export type BrowserCompletionResult =
  | {
    readonly conversationId: string;
    readonly url?: string;
    readonly status: "COMPLETED";
    readonly content: string;
    readonly extractedAt: string;
  }
  | {
    readonly conversationId: string;
    readonly url?: string;
    readonly status: Exclude<BrowserCompletionStatus, "COMPLETED">;
    readonly error: string;
  };
