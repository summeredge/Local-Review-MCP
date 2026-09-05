import { z } from "zod";
import {
  conversationIdSchema,
  executionIdSchema,
  executionStatusSchema,
  taskIdSchema,
  taskStatusSchema,
  workspaceIdSchema,
} from "./schema.js";
import {
  reviewRequestIdSchema,
  reviewRequestStatusSchema,
} from "./review-schema.js";

const timestampSchema = z.string().datetime({ offset: true });

const taskProjectionSchema = z.object({
  task_id: taskIdSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  status: taskStatusSchema.optional(),
}).strict();

const executionProjectionSchema = z.object({
  execution_id: executionIdSchema,
  status: executionStatusSchema,
  command: z.string().min(1).max(1000).optional(),
  summary: z.string().min(1).max(4000).optional(),
  started_at: timestampSchema,
  finished_at: timestampSchema.optional(),
}).strict();

const reviewRequestProjectionSchema = z.object({
  review_request_id: reviewRequestIdSchema,
  status: reviewRequestStatusSchema,
  conversation_id: conversationIdSchema.optional(),
}).strict();

export const reviewContextProjectionSchema = z.object({
  review_context_id: z.string().min(1).max(256),
  workspace_id: workspaceIdSchema,
  task: taskProjectionSchema,
  execution: executionProjectionSchema,
  review_request: reviewRequestProjectionSchema,
  generated_at: timestampSchema,
}).strict();
