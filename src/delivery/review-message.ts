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
  ].join("\n");
}
