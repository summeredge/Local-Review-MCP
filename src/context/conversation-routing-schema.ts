import { z } from "zod";
import { isReservedWindowsName } from "../workspace/path.js";
import {
  conversationIdSchema,
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "./schema.js";
import { reviewRequestIdSchema } from "./review-schema.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const conversationRoutingIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ID_PATTERN)
  .refine((value) => !isReservedWindowsName(value), "routing_id is a reserved filename");

const timestampSchema = z.string().datetime({ offset: true });

export const conversationRoutingSchema = z.object({
  routing_id: conversationRoutingIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema.optional(),
  review_request_id: reviewRequestIdSchema,
  conversation_id: conversationIdSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const createConversationRoutingInputSchema = z.object({
  routing_id: conversationRoutingIdSchema.optional(),
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema.optional(),
  review_request_id: reviewRequestIdSchema,
  conversation_id: conversationIdSchema,
}).strict();
