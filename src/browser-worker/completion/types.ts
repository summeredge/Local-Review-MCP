import type { Page } from "playwright";

export const REVIEW_COMPLETION_STATUSES = [
  "WAITING",
  "COMPLETED",
  "TIMEOUT",
  "FAILED",
] as const;

export type ReviewCompletionStatus = typeof REVIEW_COMPLETION_STATUSES[number];

export interface ReviewCompletionOptions {
  readonly reviewRequestId: string;
}

export type CompletionResult =
  | { readonly status: "WAITING" }
  | { readonly status: "COMPLETED"; readonly assistantMessageIndex: number }
  | { readonly status: "TIMEOUT"; readonly error: string }
  | { readonly status: "FAILED"; readonly error: string };

export interface ReviewCompletionDetector {
  waitForCompletion(page: Page, options: ReviewCompletionOptions): Promise<CompletionResult>;
}

export interface ReviewResultExtractionOptions extends ReviewCompletionOptions {
  readonly assistantMessageIndex: number;
}

export interface ReviewResult {
  readonly status: "COMPLETED";
  readonly content: string;
  readonly extractedAt: string;
}

export interface ReviewResultExtractor {
  extract(page: Page, options: ReviewResultExtractionOptions): Promise<ReviewResult>;
}
