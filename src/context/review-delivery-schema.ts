import { z } from "zod";
import { isReservedWindowsName } from "../workspace/path.js";
import { conversationIdSchema, taskIdSchema, workspaceIdSchema } from "./schema.js";
import { conversationRoutingIdSchema } from "./conversation-routing-schema.js";
import { reviewRequestIdSchema } from "./review-schema.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const reviewDeliveryIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ID_PATTERN)
  .refine((value) => !isReservedWindowsName(value), "delivery_id is a reserved filename");

export const reviewDeliveryStatusSchema = z.enum([
  "pending",
  "delivering",
  "delivered",
  "failed",
]);

const timestampSchema = z.string().datetime({ offset: true });

export const reviewDeliveryErrorSchema = z.object({
  code: z.string().min(1).max(128).optional(),
  message: z.string().min(1).max(4000),
}).strict();

export const reviewDeliverySchema = z.object({
  delivery_id: reviewDeliveryIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  review_request_id: reviewRequestIdSchema,
  routing_id: conversationRoutingIdSchema,
  conversation_id: conversationIdSchema,
  status: reviewDeliveryStatusSchema,
  attempt_count: z.number().int().nonnegative(),
  last_error: reviewDeliveryErrorSchema.optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  delivered_at: timestampSchema.optional(),
}).strict().superRefine((delivery, context) => {
  if (delivery.status === "pending" && delivery.attempt_count !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attempt_count"],
      message: "pending deliveries must not have delivery attempts",
    });
  }
  if (delivery.status !== "pending" && delivery.attempt_count < 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attempt_count"],
      message: "active deliveries must have at least one delivery attempt",
    });
  }
  if (delivery.status === "failed" && delivery.last_error === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["last_error"],
      message: "failed deliveries must record the last error",
    });
  }
  if (delivery.status !== "failed" && delivery.last_error !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["last_error"],
      message: "only failed deliveries may record the last error",
    });
  }
  if (delivery.status === "delivered" && delivery.delivered_at === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["delivered_at"],
      message: "delivered deliveries must record delivered_at",
    });
  }
  if (delivery.status !== "delivered" && delivery.delivered_at !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["delivered_at"],
      message: "only delivered deliveries may record delivered_at",
    });
  }
});

export const createReviewDeliveryInputSchema = z.object({
  delivery_id: reviewDeliveryIdSchema.optional(),
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  review_request_id: reviewRequestIdSchema,
  routing_id: conversationRoutingIdSchema,
  conversation_id: conversationIdSchema,
}).strict();

export const markReviewDeliveryFailedInputSchema = reviewDeliveryErrorSchema;

export type ReviewDeliveryStatus = z.infer<typeof reviewDeliveryStatusSchema>;
