import { describe, expect, it } from "vitest";
import { CodexHandoffRenderer } from "../src/control/codex-handoff-renderer.js";
import {
  IterationDirectiveBuildError,
  IterationDirectiveBuilder,
} from "../src/control/iteration-directive-builder.js";
import type { LoopDecision } from "../src/control/loop-decision.js";
import type { ReviewVerdict } from "../src/control/review-verdict.js";

const decision: LoopDecision = {
  decision_id: "decision-001",
  workspace_id: "workspace-001",
  task_id: "task-001",
  execution_id: "execution-001",
  review_request_id: "review-001",
  review_result_id: "result-001",
  action: "ITERATE",
  reason_code: "REVIEW_REQUIRES_ITERATION",
  summary: "A blocking issue requires another iteration.",
  created_at: "2026-09-06T00:00:00.000Z",
};

const verdict: ReviewVerdict = {
  schema_version: 1,
  review_request_id: "review-001",
  decision: "ITERATE",
  summary: "A blocking issue requires another iteration.",
  iteration: {
    goal: "Fix the blocking issue within the current task.",
    requirements: [
      "Keep the change inside the current task.",
      "Do not add unrelated features.",
    ],
    acceptance_criteria: [
      "The blocking issue is fixed.",
      "The existing check passes.",
    ],
  },
};

const builder = new IterationDirectiveBuilder();

function expectBuildError(
  loopDecision: LoopDecision,
  reviewVerdict: ReviewVerdict,
  code: IterationDirectiveBuildError["code"],
): void {
  try {
    builder.build(loopDecision, reviewVerdict);
    throw new Error(`expected ${code}`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(IterationDirectiveBuildError);
    expect((error as IterationDirectiveBuildError).code).toBe(code);
  }
}

describe("IterationDirectiveBuilder", () => {
  it("builds an IterationDirective from a valid ITERATE pair", () => {
    const directive = builder.build(decision, verdict);
    expect(directive).toMatchObject({
      workspace_id: "workspace-001",
      task_id: "task-001",
      source_execution_id: "execution-001",
      review_request_id: "review-001",
      review_result_id: "result-001",
      loop_decision_id: "decision-001",
      goal: "Fix the blocking issue within the current task.",
      requirements: [
        "Keep the change inside the current task.",
        "Do not add unrelated features.",
      ],
      acceptance_criteria: [
        "The blocking issue is fixed.",
        "The existing check passes.",
      ],
    });
    expect(directive.directive_id).toMatch(/^iteration-directive-/u);
  });

  it("rejects every non-ITERATE loop decision", () => {
    const verdicts: ReviewVerdict[] = [
      { ...verdict, decision: "APPROVE", iteration: undefined },
    ];
    const cases: [LoopDecision["action"], LoopDecision["reason_code"]][] = [
      ["COMPLETE", "REVIEW_APPROVED"],
      ["COMPLETE", "REVIEW_REQUIRES_ITERATION"],
      ["HUMAN_REQUIRED", "REVIEW_REQUIRES_HUMAN"],
      ["WAIT", "REVIEW_PENDING"],
      ["RETRY_REVIEW", "REVIEW_TIMEOUT"],
      ["RETRY_REVIEW", "REVIEW_VERDICT_INVALID"],
      ["RETRY_REVIEW", "STALE_REVIEW"],
    ];
    for (const [action, reasonCode] of cases) {
      expectBuildError({ ...decision, action, reason_code: reasonCode }, verdicts[0],
        "LOOP_DECISION_NOT_ITERATE");
    }
  });

  it("rejects ITERATE action with an invalid reason code", () => {
    expectBuildError(
      { ...decision, action: "ITERATE", reason_code: "REVIEW_APPROVED" },
      verdict,
      "LOOP_DECISION_REASON_INVALID",
    );
    expectBuildError(
      { ...decision, action: "ITERATE", reason_code: "STALE_REVIEW" },
      verdict,
      "LOOP_DECISION_REASON_INVALID",
    );
  });

  it("rejects a non-ITERATE review verdict and missing iteration payload", () => {
    expectBuildError(
      decision,
      { ...verdict, decision: "APPROVE", iteration: undefined },
      "REVIEW_VERDICT_NOT_ITERATE",
    );
    expectBuildError(
      decision,
      { ...verdict, iteration: undefined },
      "ITERATION_PAYLOAD_MISSING",
    );
  });

  it("rejects review_request_id mismatch and missing review_result_id", () => {
    expectBuildError(decision, { ...verdict, review_request_id: "review-002" },
      "REVIEW_REQUEST_MISMATCH");
    expectBuildError({ ...decision, review_result_id: undefined }, verdict,
      "REVIEW_RESULT_ID_MISSING");
  });

  it("does not mutate LoopDecision or ReviewVerdict", () => {
    const decisionBefore = JSON.stringify(decision);
    const verdictBefore = JSON.stringify(verdict);
    const directive = builder.build(decision, verdict);
    expect(JSON.stringify(decision)).toBe(decisionBefore);
    expect(JSON.stringify(verdict)).toBe(verdictBefore);
    expect(directive.requirements).not.toBe(verdict.iteration?.requirements);
    expect(directive.acceptance_criteria).not.toBe(verdict.iteration?.acceptance_criteria);
  });
});

describe("CodexHandoffRenderer", () => {
  const directive = builder.build(decision, verdict);
  const prompt = new CodexHandoffRenderer().render(directive);

  it("renders exactly the three required sections and maps all payload items", () => {
    expect(prompt).toContain("# 修改目标");
    expect(prompt).toContain("# 修改要求");
    expect(prompt).toContain("# 验收标准");
    expect(prompt.match(/^# /gmu)?.length).toBe(3);
    expect(prompt.split("# 修改目标")[1].split("# 修改要求")[0]).toContain("Fix the blocking issue within the current task.");
    const requirements = prompt.split("# 修改要求")[1].split("# 验收标准")[0];
    expect(requirements).toContain("Keep the change inside the current task.");
    expect(requirements).toContain("Do not add unrelated features.");
    const acceptance = prompt.split("# 验收标准")[1];
    expect(acceptance).toContain("The blocking issue is fixed.");
    expect(acceptance).toContain("The existing check passes.");
  });

  it("includes the common verification commands and no restricted content", () => {
    expect(prompt).toContain("npm run typecheck");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("npm run build");
    expect(prompt).not.toContain("review_result_id");
    expect(prompt).not.toContain("result-001");
    expect(prompt).not.toContain("Cookie");
    expect(prompt).not.toContain("DOM");
    expect(prompt).not.toContain("Browser Worker");
    expect(prompt).not.toMatch(/自动(?:执行|运行) Codex/u);
    expect(prompt).not.toMatch(/自动 Review/u);
  });
});
