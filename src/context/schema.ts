import { z } from "zod";
import { isReservedWindowsName } from "../workspace/path.js";
import { EXECUTION_STATUSES, TASK_STATUSES } from "./types.js";

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

export const executionIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ID_PATTERN)
  .refine((value) => !isReservedWindowsName(value), "execution_id is a reserved filename");

export const executionStatusSchema = z.enum(EXECUTION_STATUSES);
const executionCommandSchema = z.string().min(1).max(1000);
const executionSummarySchema = z.string().min(1).max(4000);

export const executionContextSchema = z.object({
  execution_id: executionIdSchema,
  task_id: taskIdSchema,
  workspace_id: workspaceIdSchema,
  status: executionStatusSchema,
  command: executionCommandSchema.optional(),
  started_at: timestampSchema,
  finished_at: timestampSchema.optional(),
  summary: executionSummarySchema.optional(),
}).strict();

export const createExecutionContextInputSchema = z.object({
  execution_id: executionIdSchema.optional(),
  task_id: taskIdSchema,
  workspace_id: workspaceIdSchema,
  status: executionStatusSchema.default("running"),
  command: executionCommandSchema.optional(),
  summary: executionSummarySchema.optional(),
}).strict();

export const updateExecutionContextInputSchema = z.object({
  status: executionStatusSchema.optional(),
  command: executionCommandSchema.optional(),
  summary: executionSummarySchema.optional(),
}).strict();
