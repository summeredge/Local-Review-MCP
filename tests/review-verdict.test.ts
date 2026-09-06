import { describe, expect, it } from "vitest";
import type { ReviewResult } from "../src/context/review-result.js";
import { buildReviewMessage } from "../src/delivery/review-message.js";
import {
  ReviewVerdictParseError,
  ReviewVerdictParser,
} from "../src/control/review-verdict-parser.js";

const parser = new ReviewVerdictParser();

function result(content: string, status: ReviewResult["status"] = "COMPLETED"): ReviewResult {
  return {
    result_id: "result-001",
    review_request_id: "review-001",
    delivery_id: "delivery-001",
    workspace_id: "workspace-001",
    task_id: "task-001",
    status,
    ...(status === "COMPLETED" ? { content } : { error: "review did not complete" }),
    created_at: "2026-09-06T00:00:00.000Z",
  };
}

function block(payload: Record<string, unknown>, trailing = ""): string {
  return [
    "Human-readable review.",
    "<lrm-review-result>",
    JSON.stringify(payload),
    "</lrm-review-result>",
  ].join("\n") + trailing;
}

function iteratePayload(): Record<string, unknown> {
  return {
    schema_version: 1,
    review_request_id: "review-001",
    decision: "ITERATE",
    summary: "A blocking issue requires a fix.",
    iteration: {
      goal: "Fix the blocking issue.",
      requirements: ["Change the implementation within the task scope."],
      acceptance_criteria: ["The blocking issue is fixed."],
    },
  };
}

function expectCode(content: string, code: ReviewVerdictParseError["code"]): void {
  try {
    parser.parse(result(content));
    throw new Error("expected parser to reject the result");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ReviewVerdictParseError);
    expect((error as ReviewVerdictParseError).code).toBe(code);
  }
}

describe("ReviewVerdictParser", () => {
  it("parses APPROVE, ITERATE, and HUMAN_REQUIRED without changing ReviewResult", () => {
    const approve = parser.parse(result(block({
      schema_version: 1,
      review_request_id: "review-001",
      decision: "APPROVE",
      summary: "No blocking findings.",
    })));
    const iterate = parser.parse(result(block(iteratePayload())));
    const humanRequired = parser.parse(result(block({
      schema_version: 1,
      review_request_id: "review-001",
      decision: "HUMAN_REQUIRED",
      summary: "The scope needs user clarification.",
    })));

    expect(approve).toEqual({
      schema_version: 1,
      review_request_id: "review-001",
      decision: "APPROVE",
      summary: "No blocking findings.",
    });
    expect(iterate.decision).toBe("ITERATE");
    expect(humanRequired).not.toHaveProperty("iteration");
    expect(result(block(iteratePayload()))).not.toHaveProperty("decision");
  });

  it("rejects a missing, multiple, or malformed verdict block", () => {
    expectCode("The review has no machine-readable verdict.", "VERDICT_BLOCK_MISSING");
    expectCode(
      `${block({ schema_version: 1, review_request_id: "review-001", decision: "APPROVE", summary: "ok" })}\n${block({ schema_version: 1, review_request_id: "review-001", decision: "APPROVE", summary: "again" })}`,
      "VERDICT_BLOCK_MULTIPLE",
    );
    expectCode(
      "<lrm-review-result>{not json}</lrm-review-result>",
      "VERDICT_JSON_INVALID",
    );
  });

  it("requires the verdict block to be final except for whitespace", () => {
    const approve = {
      schema_version: 1,
      review_request_id: "review-001",
      decision: "APPROVE",
      summary: "No blocking findings.",
    };

    expect(parser.parse(result(block(approve, "\n  \t\r\n")))).toMatchObject({
      decision: "APPROVE",
    });
    expectCode(block(approve, "\nextra text"), "VERDICT_BLOCK_NOT_FINAL");
    expectCode(block(approve, "\n```markdown\n"), "VERDICT_BLOCK_NOT_FINAL");
  });

  it("rejects invalid schema and decision combinations", () => {
    const invalidPayloads: Record<string, unknown>[] = [
      { ...iteratePayload(), decision: "RETRY_REVIEW" },
      { ...iteratePayload(), schema_version: 2 },
      { ...iteratePayload(), extra: true },
      { ...iteratePayload(), iteration: undefined },
      {
        schema_version: 1,
        review_request_id: "review-001",
        decision: "APPROVE",
        summary: "ok",
        iteration: iteratePayload().iteration,
      },
      { ...iteratePayload(), iteration: { ...iteratePayload().iteration as object, requirements: [] } },
      { ...iteratePayload(), iteration: { ...iteratePayload().iteration as object, acceptance_criteria: [" "] } },
    ];

    for (const payload of invalidPayloads) {
      expectCode(block(payload), "VERDICT_SCHEMA_INVALID");
    }
  });

  it("rejects identity mismatches and non-completed ReviewResults", () => {
    const mismatched = block({
      schema_version: 1,
      review_request_id: "review-002",
      decision: "APPROVE",
      summary: "No blocking findings.",
    });
    try {
      parser.parse(result(mismatched));
      throw new Error("expected identity mismatch");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "REVIEW_REQUEST_MISMATCH" });
    }

    for (const status of ["TIMEOUT", "FAILED"] as const) {
      try {
        parser.parse(result("<lrm-review-result>{}</lrm-review-result>", status));
        throw new Error("expected non-completed result rejection");
      } catch (error: unknown) {
        expect(error).toMatchObject({ code: "REVIEW_RESULT_NOT_COMPLETED" });
      }
    }
  });
});

describe("buildReviewMessage", () => {
  it("preserves review identity and describes the strict verdict protocol", () => {
    const message = buildReviewMessage({
      workspace_id: "workspace-001",
      task_id: "task-001",
      execution_id: "execution-001",
      review_request_id: "review-001",
      routing_id: "routing-001",
    });

    expect(message).toContain("workspace_id: workspace-001");
    expect(message).toContain("task_id: task-001");
    expect(message).toContain("execution_id: execution-001");
    expect(message).toContain("review_request_id: review-001");
    expect(message).toContain("routing_id: routing-001");
    expect(message).toContain("Use Local Review MCP to read");
    expect(message).toContain("APPROVE");
    expect(message).toContain("ITERATE");
    expect(message).toContain("HUMAN_REQUIRED");
    expect(message).toContain("must not force ITERATE");
    expect(message).toContain("exactly one machine-readable verdict block");
    expect(message).toContain('"review_request_id": "review-001"');
    expect(message.indexOf("<lrm-review-result>")).toBeGreaterThan(-1);
    expect(message.indexOf("</lrm-review-result>")).toBe(message.length - "</lrm-review-result>".length);
  });
});
