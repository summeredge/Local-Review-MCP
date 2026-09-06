import { z } from "zod";
import {
  DEFAULT_BROWSER_WORKER_HOST,
  DEFAULT_BROWSER_WORKER_PORT,
} from "../browser-worker/config.js";
import {
  BROWSER_COMPLETION_STATUSES,
  BROWSER_DELIVERY_STATUSES,
  type BrowserCompletionResult,
  type BrowserDeliveryResult,
  type NavigationResult,
} from "../browser-worker/protocol.js";

export type { NavigationResult };
export type { BrowserDeliveryResult };
export type { BrowserCompletionResult };

export const DEFAULT_BROWSER_WORKER_BASE_URL =
  `http://${DEFAULT_BROWSER_WORKER_HOST}:${DEFAULT_BROWSER_WORKER_PORT}` as const;
export const DEFAULT_BROWSER_WORKER_TIMEOUT_MS = 5_000;
export const DEFAULT_BROWSER_WORKER_COMPLETION_TIMEOUT_MS = 35_000;

export interface BrowserWorkerClientConfig {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly completionTimeoutMs?: number;
}

export const BROWSER_WORKER_CLIENT_ERROR_CODES = [
  "INVALID_CONFIG",
  "TIMEOUT",
  "UNAVAILABLE",
  "HTTP_ERROR",
  "INVALID_RESPONSE",
] as const;

export type BrowserWorkerClientErrorCode = typeof BROWSER_WORKER_CLIENT_ERROR_CODES[number];

export class BrowserWorkerClientError extends Error {
  public readonly code: BrowserWorkerClientErrorCode;
  public readonly statusCode?: number;

  public constructor(
    code: BrowserWorkerClientErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly statusCode?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BrowserWorkerClientError";
    this.code = code;
    this.statusCode = options.statusCode;
  }
}

const navigationResultSchema = z.object({
  conversationId: z.string().min(1).max(256),
  url: z.string().url().optional(),
  status: z.enum(["NAVIGATED", "FAILED"]),
  error: z.string().min(1).max(4000).optional(),
}).strict().superRefine((result, context) => {
  if (result.status === "NAVIGATED" && result.url === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "NAVIGATED responses must include url",
    });
  }
  if (result.status === "FAILED" && result.error === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "FAILED responses must include error",
    });
  }
});

const browserDeliveryResultSchema = z.object({
  conversationId: z.string().min(1).max(256),
  url: z.string().url().optional(),
  status: z.enum(BROWSER_DELIVERY_STATUSES),
  error: z.string().min(1).max(4000).optional(),
}).strict().superRefine((result, context) => {
  if (result.status === "SUBMITTED" && result.error !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "SUBMITTED responses must not include error",
    });
  }
  if (result.status !== "SUBMITTED" && result.error === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "failed delivery responses must include error",
    });
  }
});

const browserCompletionResultSchema = z.object({
  conversationId: z.string().min(1).max(256),
  url: z.string().url().optional(),
  status: z.enum(BROWSER_COMPLETION_STATUSES),
  content: z.string().min(1).max(1024 * 1024).optional(),
  extractedAt: z.string().datetime({ offset: true }).optional(),
  error: z.string().min(1).max(4000).optional(),
}).strict().superRefine((result, context) => {
  if (result.status === "COMPLETED") {
    if (result.content === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "COMPLETED responses must include content",
      });
    }
    if (result.extractedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extractedAt"],
        message: "COMPLETED responses must include extractedAt",
      });
    }
    if (result.error !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "COMPLETED responses must not include error",
      });
    }
  } else {
    if (result.error === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "failed completion responses must include error",
      });
    }
    if (result.content !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "failed completion responses must not include content",
      });
    }
    if (result.extractedAt !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extractedAt"],
        message: "failed completion responses must not include extractedAt",
      });
    }
  }
}) as z.ZodType<BrowserCompletionResult>;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 4000);
  return String(error).slice(0, 4000);
}

function parseBaseUrl(value: string): URL {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BrowserWorkerClientError("INVALID_CONFIG", "Browser Worker baseUrl is required.");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(value);
  } catch (error: unknown) {
    throw new BrowserWorkerClientError(
      "INVALID_CONFIG",
      "Browser Worker baseUrl must be a valid HTTP(S) URL.",
      { cause: error },
    );
  }
  if ((baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:")
    || baseUrl.username !== "" || baseUrl.password !== "") {
    throw new BrowserWorkerClientError(
      "INVALID_CONFIG",
      "Browser Worker baseUrl must be a valid HTTP(S) URL without credentials.",
    );
  }
  return baseUrl;
}

function parseTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BrowserWorkerClientError(
      "INVALID_CONFIG",
      `Browser Worker ${name} must be a positive integer.`,
    );
  }
  return value;
}

function responseErrorMessage(statusCode: number, body: unknown): string {
  const candidate = typeof body === "object" && body !== null
    ? body as { error?: unknown }
    : undefined;
  const detail = typeof candidate?.error === "string" && candidate.error.length > 0
    ? `: ${candidate.error.slice(0, 4000)}`
    : "";
  return `Browser Worker returned HTTP ${statusCode}${detail}`;
}

export class BrowserWorkerClient {
  private readonly endpoint: string;
  private readonly deliveryEndpoint: string;
  private readonly completionEndpoint: string;
  private readonly timeoutMs: number;
  private readonly completionTimeoutMs: number;

  public constructor(
    config: BrowserWorkerClientConfig = { baseUrl: DEFAULT_BROWSER_WORKER_BASE_URL },
  ) {
    const baseUrl = parseBaseUrl(config.baseUrl);
    this.endpoint = new URL("/conversation/navigate", baseUrl).toString();
    this.deliveryEndpoint = new URL("/conversation/deliver", baseUrl).toString();
    this.completionEndpoint = new URL("/conversation/completion", baseUrl).toString();
    this.timeoutMs = parseTimeout(config.timeoutMs ?? DEFAULT_BROWSER_WORKER_TIMEOUT_MS, "timeoutMs");
    this.completionTimeoutMs = parseTimeout(
      config.completionTimeoutMs ?? DEFAULT_BROWSER_WORKER_COMPLETION_TIMEOUT_MS,
      "completionTimeoutMs",
    );
  }

  public async navigate(conversationId: string): Promise<NavigationResult> {
    return this.post(this.endpoint, { conversationId }, navigationResultSchema, conversationId,
      "navigation");
  }

  public async deliver(conversationId: string, message: string): Promise<BrowserDeliveryResult> {
    return this.post(
      this.deliveryEndpoint,
      { conversationId, message },
      browserDeliveryResultSchema,
      conversationId,
      "delivery",
    );
  }

  public async collectCompletion(
    conversationId: string,
    reviewRequestId: string,
  ): Promise<BrowserCompletionResult> {
    return this.post(
      this.completionEndpoint,
      { conversationId, reviewRequestId },
      browserCompletionResultSchema,
      conversationId,
      "completion",
      this.completionTimeoutMs,
    );
  }

  private async post<T extends { readonly conversationId: string }>(
    endpoint: string,
    requestBody: unknown,
    schema: z.ZodType<T>,
    conversationId: string,
    responseKind: "navigation" | "delivery" | "completion",
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();

    try {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          throw new BrowserWorkerClientError(
            "TIMEOUT",
            `Browser Worker request timed out after ${timeoutMs}ms.`,
            { cause: error },
          );
        }
        throw new BrowserWorkerClientError(
          "UNAVAILABLE",
          `Browser Worker request failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          throw new BrowserWorkerClientError(
            "TIMEOUT",
            `Browser Worker request timed out after ${timeoutMs}ms.`,
            { cause: error },
          );
        }
        if (!response.ok) {
          throw new BrowserWorkerClientError(
            "HTTP_ERROR",
            `Browser Worker returned HTTP ${response.status}.`,
            { cause: error, statusCode: response.status },
          );
        }
        throw new BrowserWorkerClientError(
          "INVALID_RESPONSE",
          `Browser Worker returned an invalid ${responseKind} JSON response.`,
          { cause: error },
        );
      }

      if (!response.ok) {
        throw new BrowserWorkerClientError(
          "HTTP_ERROR",
          responseErrorMessage(response.status, body),
          { statusCode: response.status },
        );
      }

      const parsed = schema.safeParse(body);
      if (!parsed.success || parsed.data.conversationId !== conversationId) {
        throw new BrowserWorkerClientError(
          "INVALID_RESPONSE",
          parsed.success && parsed.data.conversationId !== conversationId
            ? `Browser Worker ${responseKind} response does not match the requested conversation.`
            : `Browser Worker returned an invalid ${responseKind} response.`,
        );
      }
      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof BrowserWorkerClientError) throw error;
      if (controller.signal.aborted) {
        throw new BrowserWorkerClientError(
          "TIMEOUT",
          `Browser Worker request timed out after ${timeoutMs}ms.`,
          { cause: error },
        );
      }
      throw new BrowserWorkerClientError(
        "UNAVAILABLE",
        `Browser Worker request failed: ${errorMessage(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
