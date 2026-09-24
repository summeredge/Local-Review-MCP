import type {
  CapabilityFailureReason,
  CapabilitySource,
  CapabilityState,
} from "./capability-negotiation.js";

export type CapabilityTimelineEventName =
  | CapabilityState
  | "fallback_waiting"
  | "fallback_selected"
  | "desktop_capability_restored";

export interface CapabilityTimelineEvent {
  readonly timestamp: string;
  readonly execution_id: string;
  readonly task_id: string;
  readonly previous_state: CapabilityState | null;
  readonly current_state: CapabilityState;
  readonly source: CapabilitySource | null;
  readonly reason: CapabilityFailureReason | null;
  readonly error_code: string | null;
  /** State transitions use their state name; decision-only events use an explicit name. */
  readonly event?: CapabilityTimelineEventName;
}

export class CapabilityTimeline {
  private readonly events: CapabilityTimelineEvent[] = [];

  public constructor(private readonly maxEvents = 1_000) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
      throw new Error("Capability timeline maxEvents must be a positive safe integer.");
    }
  }

  public record(event: CapabilityTimelineEvent): void {
    this.events.push({ ...event, event: event.event ?? event.current_state });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  public recent(executionId?: string, limit = 100): readonly CapabilityTimelineEvent[] {
    const count = Number.isSafeInteger(limit) && limit > 0
      ? Math.min(limit, this.maxEvents)
      : 100;
    const events = executionId === undefined
      ? this.events
      : this.events.filter((event) => event.execution_id === executionId);
    return events.slice(-count).map((event) => ({ ...event }));
  }
}
