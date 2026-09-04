import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { executionIdSchema, taskIdSchema, workspaceIdSchema } from "./schema.js";
import { TASK_CONTEXTS_DIRECTORY } from "./task.js";

export const TASK_EXECUTIONS_DIRECTORY = join(TASK_CONTEXTS_DIRECTORY, "..", "executions");

export function taskExecutionsDirectory(
  storageRoot: string,
  workspaceId: string,
  taskId: string,
): string {
  const safeWorkspaceId = workspaceIdSchema.parse(workspaceId);
  const safeTaskId = taskIdSchema.parse(taskId);
  return join(resolve(storageRoot), TASK_EXECUTIONS_DIRECTORY, safeWorkspaceId, safeTaskId);
}

export function executionFile(
  storageRoot: string,
  workspaceId: string,
  taskId: string,
  executionId: string,
): string {
  const safeExecutionId = executionIdSchema.parse(executionId);
  return join(taskExecutionsDirectory(storageRoot, workspaceId, taskId), `${safeExecutionId}.json`);
}

export function createExecutionId(): string {
  return randomUUID();
}
