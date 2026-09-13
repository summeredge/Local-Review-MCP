import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defaultLogDirectory } from "../supervisor/logger.js";

export type RuntimeDiagnosticEvent =
  | {
      readonly event: "bridge_started";
      readonly timestamp: string;
      readonly host: string;
      readonly port: number;
      readonly protocol: number;
    }
  | {
      readonly event: "goal_handoff_captured";
      readonly timestamp: string;
      readonly handoff_id: string;
      readonly workspace_id: string;
      readonly schema_version: string;
      readonly conversation_id: string;
      readonly navigation_epoch: number;
      readonly document_id_present: boolean;
    };

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
