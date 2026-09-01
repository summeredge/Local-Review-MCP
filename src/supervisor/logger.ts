import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SupervisorLogEvent, SupervisorLogger } from "./types.js";

export const DEFAULT_LOG_DIRECTORY_NAME = "LocalReviewMCP";

export function defaultLogDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return join(
    environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    DEFAULT_LOG_DIRECTORY_NAME,
    "logs",
  );
}

export class NullSupervisorLogger implements SupervisorLogger {
  public info(_event: SupervisorLogEvent): void {}
}

export class FileSupervisorLogger implements SupervisorLogger {
  public readonly filePath: string;

  public constructor(public readonly logDirectory = defaultLogDirectory()) {
    this.filePath = join(logDirectory, "supervisor.log");
  }

  public info(event: SupervisorLogEvent): void {
    try {
      mkdirSync(this.logDirectory, { recursive: true });
      appendFileSync(this.filePath, `${new Date().toISOString()} ${event}\n`, "utf8");
    } catch {
      // Logging must not take down the runtime it is observing.
    }
  }
}
