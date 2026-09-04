import { z } from "zod";
import { isReservedWindowsName } from "../workspace/path.js";
import { TASK_STATUSES } from "./types.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const taskIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ID_PATTERN)
  .refine((value) => !isReservedWindowsName(value), "task_id is a reserved filename");

export const workspaceIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ID_PATTERN);

export const conversationIdSchema = z.string().min(1).max(256);
export const taskStatusSchema = z.enum(TASK_STATUSES);
const timestampSchema = z.string().datetime({ offset: true });

export const taskContextSchema = z.object({
  task_id: taskIdSchema,
  workspace_id: workspaceIdSchema,
  conversation_id: conversationIdSchema.optional(),
  status: taskStatusSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const createTaskContextInputSchema = z.object({
  task_id: taskIdSchema.optional(),
  workspace_id: workspaceIdSchema,
  conversation_id: conversationIdSchema.optional(),
  status: taskStatusSchema.default("pending"),
}).strict();

export const updateTaskContextInputSchema = z.object({
  conversation_id: conversationIdSchema.optional(),
  status: taskStatusSchema.optional(),
}).strict();
