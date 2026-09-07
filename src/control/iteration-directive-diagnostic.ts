import { CodexHandoffRenderer } from "./codex-handoff-renderer.js";
import {
  IterationDirectiveBuildError,
  IterationDirectiveBuilder,
} from "./iteration-directive-builder.js";
import type { IterationDirective } from "./iteration-directive.js";
import type { LoopDecision } from "./loop-decision.js";
import type { ReviewVerdict } from "./review-verdict.js";

export interface IterationDirectiveDiagnosticResult {
  readonly directive: IterationDirective;
  readonly prompt: string;
  readonly rejected_complete: IterationDirectiveBuildError["code"];
}

const decision: LoopDecision = {
  decision_id: "diagnostic-loop-decision",
  workspace_id: "diagnostic-workspace",
  task_id: "diagnostic-task",
  execution_id: "diagnostic-execution",
  review_request_id: "diagnostic-review",
  review_result_id: "diagnostic-result",
  action: "ITERATE",
  reason_code: "REVIEW_REQUIRES_ITERATION",
  summary: "The diagnostic review requires another iteration.",
  created_at: "2026-09-06T00:02:00.000Z",
};

const verdict: ReviewVerdict = {
  schema_version: 1,
  review_request_id: decision.review_request_id,
  decision: "ITERATE",
  summary: "The diagnostic review requires another iteration.",
  iteration: {
    goal: "Fix the diagnostic issue.",
    requirements: ["Keep the change within the current task."],
    acceptance_criteria: ["The diagnostic check passes."],
  },
};

export function generateIterationDirectiveExample(): IterationDirectiveDiagnosticResult {
  const builder = new IterationDirectiveBuilder();
  const directive = builder.build(decision, verdict);
  if (directive.goal !== verdict.iteration?.goal
    || directive.requirements.join("\n") !== verdict.iteration.requirements.join("\n")
    || directive.acceptance_criteria.join("\n")
      !== verdict.iteration.acceptance_criteria.join("\n")) {
    throw new Error("Iteration directive diagnostic did not preserve the verdict payload.");
  }

  const prompt = new CodexHandoffRenderer().render(directive);
  for (const section of ["# 修改目标", "# 修改要求", "# 验收标准"]) {
    if (!prompt.includes(section)) {
      throw new Error(`Iteration directive prompt is missing ${section}.`);
    }
  }

  let rejectedComplete: IterationDirectiveBuildError["code"] | undefined;
  try {
    builder.build({
      ...decision,
      action: "COMPLETE",
      reason_code: "REVIEW_APPROVED",
    }, verdict);
  } catch (error: unknown) {
    if (error instanceof IterationDirectiveBuildError) {
      rejectedComplete = error.code;
    } else {
      throw error;
    }
  }
  if (rejectedComplete !== "LOOP_DECISION_NOT_ITERATE") {
    throw new Error("Iteration directive diagnostic did not reject COMPLETE/APPROVE.");
  }

  return {
    directive,
    prompt,
    rejected_complete: rejectedComplete,
  };
}
