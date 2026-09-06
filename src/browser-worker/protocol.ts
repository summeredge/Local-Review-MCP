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
