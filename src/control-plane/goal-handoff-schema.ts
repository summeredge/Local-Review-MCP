import { z } from "zod";
import { workspaceIdSchema } from "../context/schema.js";

export const GOAL_HANDOFF_PROTOCOL = "local-review-mcp.goal-handoff" as const;
export const GOAL_HANDOFF_SCHEMA_VERSION = "2" as const;

const requestIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u);
const handoffIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const timestampSchema = z.string().datetime({ offset: true });
const instructionItemSchema = z.string().min(1).max(16_000);

export const goalHandoffGoalSchema = z.object({
  title: instructionItemSchema,
  goal: instructionItemSchema,
  requirements: z.array(instructionItemSchema).min(1).max(1_000),
  acceptance_criteria: z.array(instructionItemSchema).min(1).max(1_000),
  max_iterations: z.number().int().min(1).max(10_000),
}).strict();

export const goalHandoffEnvelopeV2Schema = z.object({
  protocol: z.literal(GOAL_HANDOFF_PROTOCOL),
  schema_version: z.literal(GOAL_HANDOFF_SCHEMA_VERSION),
  handoff_id: handoffIdSchema,
  request_id: requestIdSchema,
  workspace_id: workspaceIdSchema,
  goal: goalHandoffGoalSchema,
  issued_at: timestampSchema,
  expires_at: timestampSchema,
  signature: z.string().length(64).regex(/^[0-9a-f]+$/u),
}).strict();

export type GoalHandoffEnvelopeV2 = z.infer<typeof goalHandoffEnvelopeV2Schema>;
