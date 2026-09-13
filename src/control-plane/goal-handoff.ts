import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { workspaceIdSchema } from "../context/schema.js";
import {
  goalSubmissionRequestSchema,
  goalSubmissionToolInputSchema,
} from "./goal-submission.js";
import {
  GOAL_HANDOFF_PROTOCOL,
  GOAL_HANDOFF_SCHEMA_VERSION,
  goalHandoffEnvelopeV2Schema,
  type GoalHandoffEnvelopeV2,
} from "./goal-handoff-schema.js";

export {
  GOAL_HANDOFF_PROTOCOL,
  GOAL_HANDOFF_SCHEMA_VERSION,
  goalHandoffEnvelopeV2Schema,
} from "./goal-handoff-schema.js";
export type { GoalHandoffEnvelopeV2 } from "./goal-handoff-schema.js";

export const GOAL_HANDOFF_TTL_MS = 2 * 60 * 1000;

const requestIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u);

const goalHandoffGoalSchema = goalSubmissionRequestSchema.pick({
  title: true,
  goal: true,
  requirements: true,
  acceptance_criteria: true,
  max_iterations: true,
}).strict();

export const goalHandoffInputSchema = goalSubmissionToolInputSchema;

export type GoalHandoffInput = z.input<typeof goalHandoffInputSchema>;
export type GoalHandoffPreparationInput = Omit<GoalHandoffInput, "workspace_id"> & {
  readonly request_id: string;
  readonly workspace_id: string;
};
type GoalHandoffSignedFields = Omit<GoalHandoffEnvelopeV2, "signature">;

function canonicalGoalHandoffPayload(envelope: GoalHandoffSignedFields): string {
  return [
    ["protocol", envelope.protocol],
    ["schema_version", envelope.schema_version],
    ["handoff_id", envelope.handoff_id],
    ["request_id", envelope.request_id],
    ["workspace_id", envelope.workspace_id],
    ["goal.title", envelope.goal.title],
    ["goal.goal", envelope.goal.goal],
    ["goal.requirements", envelope.goal.requirements],
    ["goal.acceptance_criteria", envelope.goal.acceptance_criteria],
    ["goal.max_iterations", envelope.goal.max_iterations],
    ["issued_at", envelope.issued_at],
    ["expires_at", envelope.expires_at],
  ].map(([field, value]) => `${field}=${JSON.stringify(value)}`).join("\n");
}

function signatureFor(envelope: GoalHandoffSignedFields, secret: Uint8Array): string {
  return createHmac("sha256", secret)
    .update(canonicalGoalHandoffPayload(envelope), "utf8")
    .digest("hex");
}

function validTimeWindow(envelope: GoalHandoffEnvelopeV2, now: number): boolean {
  const issuedAt = Date.parse(envelope.issued_at);
  const expiresAt = Date.parse(envelope.expires_at);
  return Number.isFinite(now)
    && Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt)
    && expiresAt - issuedAt === GOAL_HANDOFF_TTL_MS
    && now >= issuedAt
    && now < expiresAt;
}

export function verifyGoalHandoffEnvelope(
  value: unknown,
  secret: Uint8Array,
  now = Date.now(),
): boolean {
  const parsed = goalHandoffEnvelopeV2Schema.safeParse(value);
  if (!parsed.success || !validTimeWindow(parsed.data, now)) return false;
  const expected = Buffer.from(signatureFor(parsed.data, secret), "hex");
  const actual = Buffer.from(parsed.data.signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class GoalHandoffService {
  private readonly signingSecret = randomBytes(32);

  public prepareGoalHandoff(
    input: GoalHandoffPreparationInput,
    now = Date.now(),
  ): GoalHandoffEnvelopeV2 {
    const goal = goalHandoffGoalSchema.parse({
      title: input.title,
      goal: input.goal,
      requirements: input.requirements,
      acceptance_criteria: input.acceptance_criteria,
      max_iterations: input.max_iterations,
    });
    const issuedAt = new Date(now);
    const unsigned: GoalHandoffSignedFields = {
      protocol: GOAL_HANDOFF_PROTOCOL,
      schema_version: GOAL_HANDOFF_SCHEMA_VERSION,
      handoff_id: `handoff-${randomUUID()}`,
      request_id: requestIdSchema.parse(input.request_id),
      workspace_id: workspaceIdSchema.parse(input.workspace_id),
      goal,
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(now + GOAL_HANDOFF_TTL_MS).toISOString(),
    };
    return goalHandoffEnvelopeV2Schema.parse({
      ...unsigned,
      signature: signatureFor(unsigned, this.signingSecret),
    });
  }

  public verifyGoalHandoffEnvelope(value: unknown, now = Date.now()): boolean {
    return verifyGoalHandoffEnvelope(value, this.signingSecret, now);
  }
}
