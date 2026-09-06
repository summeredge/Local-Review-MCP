import { z } from "zod";
import { isReservedWindowsName } from "../workspace/path.js";
import {
  taskIdSchema,
  workspaceIdSchema,
} from "./schema.js";
import { reviewRequestIdSchema } from "./review-schema.js";
import { reviewDeliveryIdSchema } from "./review-delivery-schema.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const reviewResultIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ID_PATTERN)
  .refine((value) => !isReservedWindowsName(value), "result_id is a reserved filename");

export const reviewResultStatusSchema = z.enum(["COMPLETED", "TIMEOUT", "FAILED"]);
export type ReviewResultStatus = z.infer<typeof reviewResultStatusSchema>;

const timestampSchema = z.string().datetime({ offset: true });
const contentSchema = z.string().min(1).max(1024 * 1024);
const errorSchema = z.string().min(1).max(4000);

export const reviewResultSchema = z.object({
  result_id: reviewResultIdSchema,
  review_request_id: reviewRequestIdSchema,
  delivery_id: reviewDeliveryIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  status: reviewResultStatusSchema,
  content: contentSchema.optional(),
  error: errorSchema.optional(),
  created_at: timestampSchema,
}).strict().superRefine((result, context) => {
  if (result.status === "COMPLETED" && result.content === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "completed review results must include content",
    });
  }
  if (result.status === "COMPLETED" && result.error !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "completed review results must not include error",
    });
  }
  if (result.status !== "COMPLETED" && result.error === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "failed review results must include error",
    });
  }
  if (result.status !== "COMPLETED" && result.content !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "failed review results must not include content",
    });
  }
});

export const createReviewResultInputSchema = z.object({
  result_id: reviewResultIdSchema.optional(),
  review_request_id: reviewRequestIdSchema,
  delivery_id: reviewDeliveryIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema.optional(),
  status: reviewResultStatusSchema,
  content: contentSchema.optional(),
  error: errorSchema.optional(),
}).strict();
