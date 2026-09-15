import { z } from "zod";
import { isReservedWindowsName } from "../workspace/path.js";
import {
  EXECUTION_STATUSES,
  SESSION_BACKEND_TYPES,
  SESSION_STATUSES,
  TASK_STATUSES,
} from "./types.js";

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
export const goalIdSchema = z.string().min(1).max(128).regex(ID_PATTERN);
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
const executionProcessIdSchema = z.number().int().positive();
const executionCommandSchema = z.string().min(1).max(1000);
export const EXECUTION_SUMMARY_MAX_LENGTH = 4000;
const executionSummarySchema = z.string().min(1).max(EXECUTION_SUMMARY_MAX_LENGTH);

export const executionContextSchema = z.object({
  execution_id: executionIdSchema,
  task_id: taskIdSchema,
  workspace_id: workspaceIdSchema,
  status: executionStatusSchema,
  process_id: executionProcessIdSchema.optional(),
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
  process_id: executionProcessIdSchema.optional(),
  command: executionCommandSchema.optional(),
  summary: executionSummarySchema.optional(),
}).strict();

export const updateExecutionContextInputSchema = z.object({
  status: executionStatusSchema.optional(),
  process_id: executionProcessIdSchema.optional(),
  command: executionCommandSchema.optional(),
  summary: executionSummarySchema.optional(),
}).strict();

export const sessionIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ID_PATTERN)
  .refine((value) => !isReservedWindowsName(value), "session_id is a reserved filename");

export const sessionBackendTypeSchema = z.enum(SESSION_BACKEND_TYPES);
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
const sessionWorkspaceSchema = z.string().min(1).max(4096);
const sessionThreadIdSchema = z.string().max(256);
const sessionModelSchema = z.string().min(1).max(256);
const sessionReasoningEffortSchema = z.string().min(1).max(64);

export const sessionSchema = z.object({
  session_id: sessionIdSchema,
  goal_id: goalIdSchema,
  task_id: taskIdSchema,
  backend_type: sessionBackendTypeSchema,
  status: sessionStatusSchema,
  workspace: sessionWorkspaceSchema,
  thread_id: sessionThreadIdSchema.optional(),
  model: sessionModelSchema.optional(),
  reasoning_effort: sessionReasoningEffortSchema.optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const createSessionInputSchema = z.object({
  session_id: sessionIdSchema.optional(),
  goal_id: goalIdSchema,
  task_id: taskIdSchema,
  backend_type: sessionBackendTypeSchema,
  status: sessionStatusSchema.default("created"),
  workspace: sessionWorkspaceSchema,
  thread_id: sessionThreadIdSchema.optional(),
  model: sessionModelSchema.optional(),
  reasoning_effort: sessionReasoningEffortSchema.optional(),
}).strict();

export const updateSessionInputSchema = z.object({
  status: sessionStatusSchema.optional(),
  thread_id: sessionThreadIdSchema.optional(),
  model: sessionModelSchema.optional(),
  reasoning_effort: sessionReasoningEffortSchema.optional(),
}).strict();
