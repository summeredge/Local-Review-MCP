import type { ReviewResult } from "../context/review-result.js";
import { reviewVerdictSchema } from "./review-verdict-schema.js";
import type { ReviewVerdict } from "./review-verdict.js";

export const REVIEW_VERDICT_OPEN_TAG = "<lrm-review-result>";
export const REVIEW_VERDICT_CLOSE_TAG = "</lrm-review-result>";

export const REVIEW_VERDICT_PARSE_ERROR_CODES = [
  "REVIEW_RESULT_NOT_COMPLETED",
  "VERDICT_BLOCK_MISSING",
  "VERDICT_BLOCK_MULTIPLE",
  "VERDICT_JSON_INVALID",
  "VERDICT_SCHEMA_INVALID",
  "REVIEW_REQUEST_MISMATCH",
] as const;

export type ReviewVerdictParseErrorCode = typeof REVIEW_VERDICT_PARSE_ERROR_CODES[number];

export class ReviewVerdictParseError extends Error {
  public readonly code: ReviewVerdictParseErrorCode;

  public constructor(code: ReviewVerdictParseErrorCode, message: string, cause?: unknown) {
    super(`${code}: ${message}`);
    this.name = "ReviewVerdictParseError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function countOccurrences(content: string, value: string): number {
  return content.split(value).length - 1;
}

export class ReviewVerdictParser {
  public parse(result: ReviewResult): ReviewVerdict {
    if (result.status !== "COMPLETED") {
      throw new ReviewVerdictParseError(
        "REVIEW_RESULT_NOT_COMPLETED",
        `Review result status is ${result.status}.`,
      );
    }
    if (result.content === undefined) {
      throw new ReviewVerdictParseError(
        "VERDICT_BLOCK_MISSING",
        "Completed review result has no content.",
      );
    }

    const content = result.content;
    const openingCount = countOccurrences(content, REVIEW_VERDICT_OPEN_TAG);
    const closingCount = countOccurrences(content, REVIEW_VERDICT_CLOSE_TAG);
    if (openingCount === 0 || closingCount === 0) {
      throw new ReviewVerdictParseError(
        "VERDICT_BLOCK_MISSING",
        "Review result does not contain one complete verdict block.",
      );
    }
    if (openingCount !== 1 || closingCount !== 1) {
      throw new ReviewVerdictParseError(
        "VERDICT_BLOCK_MULTIPLE",
        "Review result contains more than one verdict block.",
      );
    }

    const start = content.indexOf(REVIEW_VERDICT_OPEN_TAG) + REVIEW_VERDICT_OPEN_TAG.length;
    const end = content.indexOf(REVIEW_VERDICT_CLOSE_TAG, start);
    if (end < start) {
      throw new ReviewVerdictParseError(
        "VERDICT_BLOCK_MISSING",
        "Review result does not contain one ordered verdict block.",
      );
    }

    const jsonText = content.slice(start, end).trim();
    let payload: unknown;
    try {
      payload = JSON.parse(jsonText) as unknown;
    } catch (error: unknown) {
      throw new ReviewVerdictParseError(
        "VERDICT_JSON_INVALID",
        "Verdict block does not contain valid JSON.",
        error,
      );
    }

    const parsed = reviewVerdictSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ReviewVerdictParseError(
        "VERDICT_SCHEMA_INVALID",
        `Verdict does not satisfy schema v1: ${parsed.error.message}`,
        parsed.error,
      );
    }
    if (parsed.data.review_request_id !== result.review_request_id) {
      throw new ReviewVerdictParseError(
        "REVIEW_REQUEST_MISMATCH",
        "Verdict review_request_id does not match the ReviewResult.",
      );
    }
    return parsed.data;
  }
}

export function parseReviewVerdict(result: ReviewResult): ReviewVerdict {
  return new ReviewVerdictParser().parse(result);
}
