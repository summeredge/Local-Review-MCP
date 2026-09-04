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
