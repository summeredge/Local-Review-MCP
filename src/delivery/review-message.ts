import type { ReviewDeliveryRequest } from "./review-delivery-adapter.js";

export function buildReviewMessage(
  request: Pick<ReviewDeliveryRequest,
    "workspace_id" | "task_id" | "execution_id" | "review_request_id" | "routing_id">,
): string {
  return [
    "Review this change using Local Review MCP.",
    `workspace_id: ${request.workspace_id}`,
    `task_id: ${request.task_id}`,
    ...(request.execution_id === undefined ? [] : [`execution_id: ${request.execution_id}`]),
    `review_request_id: ${request.review_request_id}`,
    `routing_id: ${request.routing_id}`,
    "",
    "Use Local Review MCP to read the corresponding Workspace, Review Context, Git status, and uncommitted diff, then review this change.",
    "First provide a normal, human-readable code review. Then end the response with exactly one machine-readable verdict block.",
    "The verdict block must be the final content, must contain valid schema v1 JSON, and must not use a Markdown code fence.",
    "Use exactly one of these decision values: APPROVE, ITERATE, HUMAN_REQUIRED.",
    "APPROVE means there is no blocking defect within the current task scope; future refactors, naming preferences, optional cleanup, and non-blocking optimizations may remain suggestions and must not force ITERATE.",
    "ITERATE means a blocking issue within the current task scope must be fixed, and it requires goal, at least one requirement, and at least one acceptance_criteria item.",
    "HUMAN_REQUIRED means the result needs user decision or clarification, is outside the current task scope, or cannot be safely decided by the current iteration. Do not expand the iteration for out-of-scope issues.",
    "Do not output controller, retry, transport, or lifecycle states as verdict decisions.",
    "The block must use this exact review_request_id:",
    "<lrm-review-result>",
    "{",
    '  "schema_version": 1,',
    `  "review_request_id": "${request.review_request_id}",`,
    '  "decision": "APPROVE",',
    '  "summary": "..."',
    "}",
    "</lrm-review-result>",
  ].join("\n");
}
