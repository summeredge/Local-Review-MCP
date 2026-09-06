import { z } from "zod";
import { reviewRequestIdSchema } from "../context/review-schema.js";
import {
  REVIEW_VERDICT_DECISIONS,
  type ReviewVerdict,
} from "./review-verdict.js";

const nonEmptyTextSchema = z.string().min(1).refine(
  (value) => value.trim().length > 0,
  "must contain non-whitespace text",
);

export const reviewVerdictIterationSchema = z.object({
  goal: nonEmptyTextSchema,
  requirements: z.array(nonEmptyTextSchema).min(1),
  acceptance_criteria: z.array(nonEmptyTextSchema).min(1),
}).strict();

export const reviewVerdictSchema: z.ZodType<ReviewVerdict> = z.object({
  schema_version: z.literal(1),
  review_request_id: reviewRequestIdSchema,
  decision: z.enum(REVIEW_VERDICT_DECISIONS),
  summary: nonEmptyTextSchema,
  iteration: reviewVerdictIterationSchema.optional(),
}).strict().superRefine((verdict, context) => {
  if (verdict.decision === "ITERATE" && verdict.iteration === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["iteration"],
      message: "ITERATE verdicts must include iteration",
    });
  }
  if (verdict.decision !== "ITERATE" && verdict.iteration !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["iteration"],
      message: "only ITERATE verdicts may include iteration",
    });
  }
});
