export const RUNTIME_STATES = [
  "STOPPED",
  "STARTING",
  "RUNNING",
  "DEGRADED",
  "ERROR",
  "STOPPING",
] as const;

export const SUPERVISOR_STATES = RUNTIME_STATES;
export type RuntimeState = typeof RUNTIME_STATES[number];
export type SupervisorState = RuntimeState;

export class RuntimeStateStore {
  private current: RuntimeState = "STOPPED";

  public get value(): RuntimeState {
    return this.current;
  }

  public set(value: RuntimeState): RuntimeState {
    this.current = value;
    return value;
  }
}
