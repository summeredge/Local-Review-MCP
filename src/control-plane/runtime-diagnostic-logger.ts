import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultLogDirectory } from "../supervisor/logger.js";

export interface BridgeStartedDiagnosticEvent {
  readonly event: "bridge_started";
  readonly timestamp: string;
  readonly host: string;
  readonly port: number;
  readonly protocol: number;
}

/**
 * P5.7.2 Desktop capability wait observability. It carries counts, elapsed time, and reason/source
 * codes only: never a pipe path, an environment value, or a credential.
 */
export interface DesktopWaitDiagnosticEvent {
  readonly event: "desktop_preflight_wait";
  readonly timestamp: string;
  readonly state: "waiting" | "ready" | "blocked" | "timeout";
  readonly retry: number;
  readonly elapsed_ms: number;
  readonly reason?: string;
  readonly pipe_source?: "handoff" | "current_environment";
}

export type RuntimeDiagnosticEvent = BridgeStartedDiagnosticEvent | DesktopWaitDiagnosticEvent;

export interface RuntimeDiagnosticLogger {
  write(event: RuntimeDiagnosticEvent): void;
}

export class FileRuntimeDiagnosticLogger implements RuntimeDiagnosticLogger {
  public readonly filePath: string;

  public constructor(public readonly logDirectory = defaultLogDirectory()) {
    this.filePath = join(logDirectory, "runtime.log");
  }

  public write(event: RuntimeDiagnosticEvent): void {
    try {
      mkdirSync(this.logDirectory, { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // Diagnostic logging is observational only and must not affect the runtime.
    }
  }
}

export function writeRuntimeDiagnostic(
  logger: RuntimeDiagnosticLogger | undefined,
  event: RuntimeDiagnosticEvent,
): void {
  try {
    logger?.write(event);
  } catch {
    // An injected diagnostic logger must also remain fail-soft.
  }
}
