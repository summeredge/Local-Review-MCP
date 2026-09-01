import type { RuntimeState } from "./state.js";

export const SUPERVISOR_LOG_EVENTS = [
  "runtime started",
  "runtime stopped",
  "health failed",
  "restart triggered",
  "tunnel state changed",
] as const;

export type SupervisorLogEvent = typeof SUPERVISOR_LOG_EVENTS[number];

export interface RuntimeProcessStatus {
  readonly running: boolean;
  readonly pid?: number;
}

export interface RuntimeProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type RuntimeProcessExitListener = (exit: RuntimeProcessExit) => void;

export interface RuntimeProcessManager {
  start(): Promise<RuntimeProcessStatus>;
  stop(): Promise<void>;
  status(): RuntimeProcessStatus;
  onExit?(listener: RuntimeProcessExitListener): () => void;
}

export interface HealthMonitorLike {
  check(): Promise<boolean>;
  start(listener: (healthy: boolean) => void | Promise<void>): void;
  stop(): void;
}

export interface SupervisorTunnelStatus {
  readonly state: string;
  readonly endpoint?: string;
}

export interface SupervisorTunnel {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  status(): Promise<SupervisorTunnelStatus>;
}

export interface SupervisorLogger {
  info(event: SupervisorLogEvent): void;
}

export interface SupervisorStatus {
  readonly state: RuntimeState;
  readonly workspace: string;
  readonly pid?: number;
  readonly restartAttempts: number;
  readonly maxRestartAttempts: number;
  readonly healthFailures: number;
  readonly tunnel: SupervisorTunnelStatus;
}

export interface SupervisorOptions {
  readonly processManager: RuntimeProcessManager;
  readonly healthMonitor: HealthMonitorLike;
  readonly tunnel: SupervisorTunnel;
  readonly maxRestartAttempts: number;
  readonly workspace?: string;
  readonly logger?: SupervisorLogger;
  readonly logDirectory?: string;
}
