import { z } from "zod";
import {
  extensionIdentityEvidenceSchema,
} from "./extension-identity.js";
import {
  goalHandoffEnvelopeV2Schema,
  type GoalHandoffEnvelopeV2,
} from "./goal-handoff-schema.js";

const browserIdentityShape = extensionIdentityEvidenceSchema.shape;

export const goalHandoffCaptureSchema = z.object({
  handoff: goalHandoffEnvelopeV2Schema,
  conversation_id: browserIdentityShape.conversation_id,
  document_id: browserIdentityShape.document_id,
  navigation_epoch: browserIdentityShape.navigation_epoch,
}).strict();

export type GoalHandoffCapture = z.infer<typeof goalHandoffCaptureSchema>;
export type GoalHandoffCaptureAcceptance = "new" | "existing" | "conflict";

const MAX_CAPTURED_HANDOFFS = 200;

export class GoalHandoffCaptureStore {
  private readonly entries = new Map<string, GoalHandoffCapture>();

  public capture(value: unknown): GoalHandoffCaptureAcceptance {
    const parsed = goalHandoffCaptureSchema.parse(value);
    const handoffId = parsed.handoff.handoff_id;
    const previous = this.entries.get(handoffId);
    if (previous !== undefined) {
      return JSON.stringify(previous) === JSON.stringify(parsed) ? "existing" : "conflict";
    }
    if (this.entries.size >= MAX_CAPTURED_HANDOFFS) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(handoffId, parsed);
    return "new";
  }

  public list(): readonly GoalHandoffCapture[] {
    return [...this.entries.values()].map((entry) => structuredClone(entry));
  }

  public clear(): void {
    this.entries.clear();
  }
}

export type CapturedSignedGoalHandoff = GoalHandoffEnvelopeV2;
