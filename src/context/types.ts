export const TASK_STATUSES = [
  "pending",
  "reviewing",
  "completed",
  "failed",
] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

export interface TaskContext {
  readonly task_id: string;
  readonly workspace_id: string;
  readonly conversation_id?: string;
  readonly status: TaskStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateTaskContextInput {
  readonly task_id?: string;
  readonly workspace_id: string;
  readonly conversation_id?: string;
  readonly status?: TaskStatus;
}

export interface UpdateTaskContextInput {
  readonly conversation_id?: string;
  readonly status?: TaskStatus;
}

export const EXECUTION_STATUSES = [
  "running",
  "passed",
  "failed",
] as const;

export type ExecutionStatus = typeof EXECUTION_STATUSES[number];

export interface ExecutionContext {
  readonly execution_id: string;
  readonly task_id: string;
  readonly workspace_id: string;
  readonly status: ExecutionStatus;
  readonly command?: string;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly summary?: string;
}

export interface CreateExecutionContextInput {
  readonly execution_id?: string;
  readonly task_id: string;
  readonly workspace_id: string;
  readonly status?: ExecutionStatus;
  readonly command?: string;
  readonly summary?: string;
}

export interface UpdateExecutionContextInput {
  readonly status?: ExecutionStatus;
  readonly command?: string;
  readonly summary?: string;
}
