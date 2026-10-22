import type { ReasoningEffortValue } from "../models/model-catalog.js";

export const TASK_STATUSES = [
  "pending",
  "reviewing",
  "completed",
  "failed",
  "human_required",
] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

export interface TaskContext {
  readonly task_id: string;
  readonly workspace_id: string;
  /** Compatibility metadata only; ConversationRouting owns review delivery routing. */
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
  "terminated",
] as const;

export type ExecutionStatus = typeof EXECUTION_STATUSES[number];

export interface ExecutionContext {
  readonly manual_resolution?: ManualResolution;
  readonly execution_id: string;
  readonly task_id: string;
  readonly workspace_id: string;
  readonly status: ExecutionStatus;
  /** LRM-owned OS process identity. Desktop executions own no process and omit it. */
  readonly process_id?: number;
  readonly command?: string;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly summary?: string;
  readonly extension_transport?: Readonly<Record<string, unknown>>;
}

export interface CreateExecutionContextInput {
  readonly execution_id?: string;
  readonly task_id: string;
  readonly workspace_id: string;
  readonly status?: ExecutionStatus;
  readonly process_id?: number;
  readonly command?: string;
  readonly summary?: string;
}

export interface UpdateExecutionContextInput {
  readonly manual_resolution?: ManualResolution;
  readonly status?: ExecutionStatus;
  readonly process_id?: number;
  readonly command?: string;
  readonly summary?: string;
}

export interface ManualResolution {
  readonly outcome: "completed" | "incomplete" | "unknown";
  readonly note: string;
  readonly resolved_at: string;
  readonly session_id?: string;
  readonly thread_id?: string;
  readonly turn_id?: string;
  readonly monitoring_summary?: string;
  readonly evidence_error?: string;
}

export const SESSION_BACKEND_TYPES = [
  "cli",
  "codex_app_server",
  "desktop_codex_app",
] as const;

export type SessionBackendType = typeof SESSION_BACKEND_TYPES[number];

export const SESSION_STATUSES = [
  "created",
  "starting",
  "active",
  "running_turn",
  "waiting_input",
  "completed",
  "failed",
  "terminated",
] as const;

export type SessionStatus = typeof SESSION_STATUSES[number];

export interface Session {
  readonly execution_id?: string;
  readonly session_id: string;
  readonly goal_id: string;
  readonly task_id: string;
  readonly backend_type: SessionBackendType;
  readonly status: SessionStatus;
  /** Canonical workspace path or registered workspace reference. */
  readonly workspace: string;
  /** Omitted for CLI sessions; populated with the provider Thread ID for app-server sessions. */
  readonly thread_id?: string;
  readonly model_id?: string;
  /** Saved default; mapped to a future app-server turn/start.effort field. */
  readonly reasoning_effort?: ReasoningEffortValue;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateSessionInput {
  readonly execution_id?: string;
  readonly session_id?: string;
  readonly goal_id: string;
  readonly task_id: string;
  readonly backend_type: SessionBackendType;
  readonly status?: SessionStatus;
  readonly workspace: string;
  readonly thread_id?: string;
  readonly model_id?: string;
  readonly reasoning_effort?: ReasoningEffortValue;
}

export interface UpdateSessionInput {
  readonly execution_id?: string;
  readonly status?: SessionStatus;
  readonly thread_id?: string;
  readonly model_id?: string;
  readonly reasoning_effort?: ReasoningEffortValue;
}

export const REVIEW_REQUEST_STATUSES = [
  "pending",
  "requested",
  "reviewing",
  "completed",
] as const;

export type ReviewRequestStatus = typeof REVIEW_REQUEST_STATUSES[number];

export interface ReviewRequestContext {
  readonly verdict_protocol?: "text_v1" | "tool_v1";
  readonly review_request_id: string;
  readonly task_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  /** Compatibility metadata only; ConversationRouting owns the formal review target. */
  readonly conversation_id?: string;
  readonly status: ReviewRequestStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly review_snapshot?: import("../git/types.js").ReviewSnapshot;
}

export interface CreateReviewRequestInput {
  readonly verdict_protocol?: "text_v1" | "tool_v1";
  readonly review_request_id?: string;
  readonly task_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly conversation_id?: string;
  readonly status?: ReviewRequestStatus;
  readonly review_snapshot?: import("../git/types.js").ReviewSnapshot;
}

export interface UpdateReviewRequestInput {
  readonly conversation_id?: string;
  readonly status?: ReviewRequestStatus;
}
