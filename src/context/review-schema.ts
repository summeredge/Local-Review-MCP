import { z } from "zod";
import { isReservedWindowsName } from "../workspace/path.js";
import {
  conversationIdSchema,
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "./schema.js";
import { REVIEW_REQUEST_STATUSES } from "./types.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const reviewRequestIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ID_PATTERN)
  .refine((value) => !isReservedWindowsName(value), "review_request_id is a reserved filename");

export const reviewRequestStatusSchema = z.enum(REVIEW_REQUEST_STATUSES);
const timestampSchema = z.string().datetime({ offset: true });
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const reviewSnapshotSchema = z.object({
  branch: z.string().nullable(),
  head: z.string().min(1),
  diff_sha256: sha256HexSchema,
}).strict();

export const reviewRequestContextSchema = z.object({
  review_request_id: reviewRequestIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  workspace_id: workspaceIdSchema,
  conversation_id: conversationIdSchema.optional(),
  status: reviewRequestStatusSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  review_snapshot: reviewSnapshotSchema.optional(),
}).strict();

export const createReviewRequestInputSchema = z.object({
  review_request_id: reviewRequestIdSchema.optional(),
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  workspace_id: workspaceIdSchema,
  conversation_id: conversationIdSchema.optional(),
  status: reviewRequestStatusSchema.default("pending"),
  review_snapshot: reviewSnapshotSchema.optional(),
}).strict();

export const updateReviewRequestInputSchema = z.object({
  conversation_id: conversationIdSchema.optional(),
  status: reviewRequestStatusSchema.optional(),
}).strict();
