import type { IterationDirective } from "./iteration-directive.js";

const REVIEW_SECTIONS = ["# 修改目标", "# 修改要求", "# 验收标准"] as const;

export class CodexHandoffRenderer {
  public render(directive: IterationDirective): string {
    const requirements = directive.requirements.map((item) => `- ${item}`);
    const acceptanceCriteria = directive.acceptance_criteria.map((item) => `- ${item}`);
    const boundaryRequirements = [
      "修改范围保持在当前 Task 内。",
      "基于当前 Workspace 实际代码完成修复。",
      "不处理本次 blocking requirements 之外的旁支优化。",
    ].map((item) => `- ${item}`);
    return [
      "针对当前 Review ITERATE 结论的修复任务。",
      "",
      REVIEW_SECTIONS[0],
      `当前 Task: ${directive.task_id}`,
      `基于 Execution: ${directive.source_execution_id}`,
      `Review Request: ${directive.review_request_id}`,
      directive.goal,
      "",
      REVIEW_SECTIONS[1],
      ...requirements,
      ...boundaryRequirements,
      "",
      REVIEW_SECTIONS[2],
      ...acceptanceCriteria,
      "- npm run typecheck",
      "- npm test",
      "- npm run build",
    ].join("\n");
  }
}
