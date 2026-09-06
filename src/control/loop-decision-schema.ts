import { z } from "zod";
import { isReservedWindowsName } from "../workspace/path.js";
import {
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { reviewRequestIdSchema } from "../context/review-schema.js";
import { reviewResultIdSchema } from "../context/review-result-schema.js";
import {
  LOOP_DECISION_ACTIONS,
  LOOP_DECISION_REASON_CODES,
  type LoopDecision,
} from "./loop-decision.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const loopDecisionIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(ID_PATTERN)
  .refine((value) => !isReservedWindowsName(value), "decision_id is a reserved filename");

export const loopDecisionActionSchema = z.enum(LOOP_DECISION_ACTIONS);
export const loopDecisionReasonCodeSchema = z.enum(LOOP_DECISION_REASON_CODES);

const summarySchema = z.string().min(1).max(4000);
const timestampSchema = z.string().datetime({ offset: true });

export const loopDecisionSchema: z.ZodType<LoopDecision> = z.object({
  decision_id: loopDecisionIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  review_request_id: reviewRequestIdSchema,
  review_result_id: reviewResultIdSchema.optional(),
  action: loopDecisionActionSchema,
  reason_code: loopDecisionReasonCodeSchema,
  summary: summarySchema.optional(),
  created_at: timestampSchema,
}).strict();
