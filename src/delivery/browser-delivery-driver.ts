export const BROWSER_DELIVERY_ERROR_CODES = [
  "CONVERSATION_NOT_FOUND",
  "BROWSER_NOT_AVAILABLE",
  "DELIVERY_TIMEOUT",
  "SEND_FAILED",
  "AUTH_REQUIRED",
] as const;

export type BrowserDeliveryErrorCode = typeof BROWSER_DELIVERY_ERROR_CODES[number];

export interface BrowserDeliveryError {
  readonly code: BrowserDeliveryErrorCode;
  readonly message: string;
}

export type BrowserDeliveryResult =
  | {
    readonly status: "delivered";
    readonly delivered_at: string;
  }
  | {
    readonly status: "failed";
    readonly error: BrowserDeliveryError;
  };

export interface BrowserDeliveryDriver {
  openConversation(conversationId: string): Promise<void>;
  sendMessage(conversationId: string, message: string): Promise<BrowserDeliveryResult>;
}

export class BrowserDriverError extends Error {
  public readonly code: BrowserDeliveryErrorCode;

  public constructor(code: BrowserDeliveryErrorCode, message: string) {
    super(message);
    this.name = "BrowserDriverError";
    this.code = code;
  }
}

export function isRetryableBrowserError(code: BrowserDeliveryErrorCode): boolean {
  return code === "BROWSER_NOT_AVAILABLE"
    || code === "DELIVERY_TIMEOUT"
    || code === "SEND_FAILED";
}

function isBrowserDeliveryErrorCode(value: unknown): value is BrowserDeliveryErrorCode {
  return typeof value === "string"
    && (BROWSER_DELIVERY_ERROR_CODES as readonly string[]).includes(value);
}

export function classifyBrowserDeliveryError(error: unknown): BrowserDeliveryError {
  const candidate = typeof error === "object" && error !== null
    ? error as { code?: unknown; message?: unknown }
    : undefined;
  return {
    code: isBrowserDeliveryErrorCode(candidate?.code) ? candidate.code : "SEND_FAILED",
    message: typeof candidate?.message === "string" && candidate.message.length > 0
      ? candidate.message.slice(0, 4000)
      : "Browser delivery failed.",
  };
}

export class MockBrowserDeliveryDriver implements BrowserDeliveryDriver {
  public readonly openedConversationIds: string[] = [];
  public readonly sentMessages: Array<{ conversation_id: string; message: string }> = [];
  public result: BrowserDeliveryResult;
  public openError: unknown;

  public constructor(result?: BrowserDeliveryResult) {
    this.result = result ?? { status: "delivered", delivered_at: new Date().toISOString() };
  }

  public async openConversation(conversationId: string): Promise<void> {
    this.openedConversationIds.push(conversationId);
    if (this.openError !== undefined) throw this.openError;
  }

  public async sendMessage(conversationId: string, message: string): Promise<BrowserDeliveryResult> {
    this.sentMessages.push({ conversation_id: conversationId, message });
    return this.result;
  }
}
