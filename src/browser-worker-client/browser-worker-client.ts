import { z } from "zod";
import {
  DEFAULT_BROWSER_WORKER_HOST,
  DEFAULT_BROWSER_WORKER_PORT,
} from "../browser-worker/config.js";
import type { NavigationResult } from "../browser-worker/navigation/conversation-navigator.js";

export type { NavigationResult };

export const DEFAULT_BROWSER_WORKER_BASE_URL =
  `http://${DEFAULT_BROWSER_WORKER_HOST}:${DEFAULT_BROWSER_WORKER_PORT}` as const;
export const DEFAULT_BROWSER_WORKER_TIMEOUT_MS = 5_000;

export interface BrowserWorkerClientConfig {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
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

function parseTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BrowserWorkerClientError(
      "INVALID_CONFIG",
      "Browser Worker timeoutMs must be a positive integer.",
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
  private readonly timeoutMs: number;

  public constructor(
    config: BrowserWorkerClientConfig = { baseUrl: DEFAULT_BROWSER_WORKER_BASE_URL },
  ) {
    const baseUrl = parseBaseUrl(config.baseUrl);
    this.endpoint = new URL("/conversation/navigate", baseUrl).toString();
    this.timeoutMs = parseTimeout(config.timeoutMs ?? DEFAULT_BROWSER_WORKER_TIMEOUT_MS);
  }

  public async navigate(conversationId: string): Promise<NavigationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();

    try {
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId }),
          signal: controller.signal,
        });
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          throw new BrowserWorkerClientError(
            "TIMEOUT",
            `Browser Worker request timed out after ${this.timeoutMs}ms.`,
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
            `Browser Worker request timed out after ${this.timeoutMs}ms.`,
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
          "Browser Worker returned an invalid JSON response.",
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

      const parsed = navigationResultSchema.safeParse(body);
      if (!parsed.success || parsed.data.conversationId !== conversationId) {
        throw new BrowserWorkerClientError(
          "INVALID_RESPONSE",
          parsed.success && parsed.data.conversationId !== conversationId
            ? "Browser Worker navigation response does not match the requested conversation."
            : "Browser Worker returned an invalid navigation response.",
        );
      }
      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof BrowserWorkerClientError) throw error;
      if (controller.signal.aborted) {
        throw new BrowserWorkerClientError(
          "TIMEOUT",
          `Browser Worker request timed out after ${this.timeoutMs}ms.`,
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
