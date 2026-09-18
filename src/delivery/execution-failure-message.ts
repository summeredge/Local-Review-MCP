export interface ExecutionFailureMessageInput {
  readonly workspace_id: string;
  readonly task_id: string;
  readonly execution_id: string;
  readonly loop_id: string;
  readonly reason: "EXECUTION_FAILED";
  readonly summary?: string;
}

export function buildExecutionFailureMessage(input: ExecutionFailureMessageInput): string {
  return [
    "Local Review MCP execution failed.",
    "",
    `workspace_id: ${input.workspace_id}`,
    `task_id: ${input.task_id}`,
    `execution_id: ${input.execution_id}`,
    `loop_id: ${input.loop_id}`,
    "",
    `reason: ${input.reason}`,
    `summary: ${input.summary ?? "—"}`,
    "",
    "This is an execution failure notification, not a code review request.",
    "Do not produce a ReviewVerdict.",
    "Report the failure and its reason to the user.",
    "Do not automatically resubmit the Goal unless the user explicitly asks.",
  ].join("\n");
}
