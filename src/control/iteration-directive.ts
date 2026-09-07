import { randomUUID } from "node:crypto";

export interface IterationDirective {
  readonly directive_id: string;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly source_execution_id: string;
  readonly review_request_id: string;
  readonly review_result_id: string;
  readonly loop_decision_id: string;
  readonly goal: string;
  readonly requirements: readonly string[];
  readonly acceptance_criteria: readonly string[];
  readonly created_at: string;
}

export function createIterationDirectiveId(): string {
  return "iteration-directive-" + randomUUID();
}
