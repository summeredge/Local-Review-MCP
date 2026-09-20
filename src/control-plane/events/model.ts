import { z } from "zod";
import {
  executionIdSchema,
  sessionIdSchema,
} from "../../context/schema.js";

export const LRM_EVENT_TYPES = [
  "session_started",
  "turn_started",
  "agent_message_delta",
  "agent_message_completed",
  "turn_completed",
  "execution_failed",
] as const;

export type LrmEventType = typeof LRM_EVENT_TYPES[number];

const timestampSchema = z.string().datetime({ offset: true });
const providerIdSchema = z.string().min(1).max(256);
const contentSchema = z.string().max(4_000);

const commonEventFields = {
  session_id: sessionIdSchema,
  execution_id: executionIdSchema,
  thread_id: providerIdSchema,
  timestamp: timestampSchema,
};

const sessionStartedEventSchema = z.object({
  ...commonEventFields,
  event_type: z.literal("session_started"),
  payload: z.object({}).strict(),
}).strict();

const turnStartedEventSchema = z.object({
  ...commonEventFields,
  event_type: z.literal("turn_started"),
  turn_id: providerIdSchema,
  payload: z.object({}).strict(),
}).strict();

const agentMessageDeltaEventSchema = z.object({
  ...commonEventFields,
  event_type: z.literal("agent_message_delta"),
  turn_id: providerIdSchema,
  item_id: providerIdSchema,
  payload: z.object({ content: contentSchema }).strict(),
}).strict();

const agentMessageCompletedEventSchema = z.object({
  ...commonEventFields,
  event_type: z.literal("agent_message_completed"),
  turn_id: providerIdSchema,
  item_id: providerIdSchema,
  payload: z.object({ content: contentSchema }).strict(),
}).strict();

const turnCompletedEventSchema = z.object({
  ...commonEventFields,
  event_type: z.literal("turn_completed"),
  turn_id: providerIdSchema,
  payload: z.object({}).strict(),
}).strict();

const executionFailedEventSchema = z.object({
  ...commonEventFields,
  event_type: z.literal("execution_failed"),
  /**
   * Optional because a Desktop execution can fail before any verifiable turn exists
   * (completion timeout, unknown completion, or a pre-target launch failure). Providers that do
   * have a real turn id still always supply it.
   */
  turn_id: providerIdSchema.optional(),
  payload: z.object({ reason: z.string().max(4_000).optional() }).strict(),
}).strict();

export const lrmEventInputSchema = z.union([
  sessionStartedEventSchema,
  turnStartedEventSchema,
  agentMessageDeltaEventSchema,
  agentMessageCompletedEventSchema,
  turnCompletedEventSchema,
  executionFailedEventSchema,
]);

const storedSessionStartedEventSchema = sessionStartedEventSchema.extend({
  sequence: z.number().int().positive(),
});
const storedTurnStartedEventSchema = turnStartedEventSchema.extend({
  sequence: z.number().int().positive(),
});
const storedAgentMessageDeltaEventSchema = agentMessageDeltaEventSchema.extend({
  sequence: z.number().int().positive(),
});
const storedAgentMessageCompletedEventSchema = agentMessageCompletedEventSchema.extend({
  sequence: z.number().int().positive(),
});
const storedTurnCompletedEventSchema = turnCompletedEventSchema.extend({
  sequence: z.number().int().positive(),
});
const storedExecutionFailedEventSchema = executionFailedEventSchema.extend({
  sequence: z.number().int().positive(),
});

export const lrmEventSchema = z.union([
  storedSessionStartedEventSchema,
  storedTurnStartedEventSchema,
  storedAgentMessageDeltaEventSchema,
  storedAgentMessageCompletedEventSchema,
  storedTurnCompletedEventSchema,
  storedExecutionFailedEventSchema,
]);

export type LrmEvent = z.infer<typeof lrmEventInputSchema>;
export type StoredLrmEvent = z.infer<typeof lrmEventSchema>;

export type LRMEvent = LrmEvent;
