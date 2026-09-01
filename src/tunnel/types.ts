export const CONNECTION_STATES = [
  "DISABLED",
  "LOCAL_ONLY",
  "REMOTE_READY",
  "REMOTE_ERROR",
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
