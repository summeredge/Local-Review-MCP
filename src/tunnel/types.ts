export const CONNECTION_STATES = [
  "LOCAL_ONLY",
  "REMOTE_STARTING",
  "REMOTE_READY",
  "REMOTE_ERROR",
  "STOPPED",
] as const;

export type ConnectionState = typeof CONNECTION_STATES[number];

export interface TunnelInfo {
  readonly endpoint: string;
}

export interface TunnelStatus {
  readonly state: ConnectionState;
  readonly endpoint?: string;
}

export interface TunnelProvider {
  start(): Promise<TunnelInfo>;
  stop(): Promise<void>;
  status(): Promise<TunnelStatus>;
}
