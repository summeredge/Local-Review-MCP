export interface ReviewMessageInput {
  readonly workspace_id: string;
  readonly task_id: string;
  readonly review_request_id: string;
  readonly execution_id?: string;
  readonly routing_id?: string;
}

export function buildReviewMessage(input: ReviewMessageInput): string {
  const identifiers = [
    `workspace_id=${input.workspace_id}`,
    `task_id=${input.task_id}`,
    `review_request_id=${input.review_request_id}`,
    ...(input.execution_id === undefined ? [] : [`execution_id=${input.execution_id}`]),
    ...(input.routing_id === undefined ? [] : [`routing_id=${input.routing_id}`]),
  ].join(" ");
  return `请 Review 当前任务。请使用 Local Review MCP 读取 ${identifiers} 对应 Workspace，并基于当前 Review Context、Git 状态和未提交 diff 检查本次修改。`;
}
