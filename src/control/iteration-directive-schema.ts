import { z } from "zod";
import {
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { reviewResultIdSchema } from "../context/review-result-schema.js";
import { reviewRequestIdSchema } from "../context/review-schema.js";
import { loopDecisionIdSchema } from "./loop-decision-schema.js";
import type { IterationDirective } from "./iteration-directive.js";

const nonEmptyTextSchema = z.string().min(1).refine(
  (value) => value.trim().length > 0,
  "must contain non-whitespace text",
);
const timestampSchema = z.string().datetime({ offset: true });

export const iterationDirectiveSchema: z.ZodType<IterationDirective> = z.object({
  directive_id: loopDecisionIdSchema,
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  source_execution_id: executionIdSchema,
  review_request_id: reviewRequestIdSchema,
  review_result_id: reviewResultIdSchema,
  loop_decision_id: loopDecisionIdSchema,
  goal: nonEmptyTextSchema,
  requirements: z.array(nonEmptyTextSchema).min(1),
  acceptance_criteria: z.array(nonEmptyTextSchema).min(1),
  created_at: timestampSchema,
}).strict();
