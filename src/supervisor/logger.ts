import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SupervisorLogDetails, SupervisorLogEvent, SupervisorLogger } from "./types.js";

export const DEFAULT_LOG_DIRECTORY_NAME = "LocalReviewMCP";

export function defaultLogDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return join(
    environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    DEFAULT_LOG_DIRECTORY_NAME,
    "logs",
  );
}

// Only fixed error identifiers are retained; arbitrary stderr may contain credentials.
export function summarizeRuntimeStderr(value: string): string {
  const identifiers = value.match(/\b(?:EADDRINUSE|EACCES|ENOENT|ENOMEM|ECONNREFUSED|ECONNRESET|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|SyntaxError|TypeError|RangeError|ReferenceError|AssertionError)\b/gu);
  return [...new Set(identifiers ?? [])].join(", ") || "[stderr omitted]";
}

export class NullSupervisorLogger implements SupervisorLogger {
  public info(_event: SupervisorLogEvent): void {}
}

export class FileSupervisorLogger implements SupervisorLogger {
  public readonly filePath: string;

  public constructor(public readonly logDirectory = defaultLogDirectory()) {
    this.filePath = join(logDirectory, "supervisor.log");
  }

  public info(event: SupervisorLogEvent, details?: SupervisorLogDetails): void {
    try {
      const safeDetails = details === undefined ? undefined : {
        ...details,
        ...(details.stderr === undefined ? {} : { stderr: summarizeRuntimeStderr(details.stderr) }),
      };
      mkdirSync(this.logDirectory, { recursive: true });
      const suffix = safeDetails === undefined ? "" : ` ${JSON.stringify(safeDetails)}`;
      appendFileSync(this.filePath, `${new Date().toISOString()} ${event}${suffix}\n`, "utf8");
    } catch {
      // Logging must not take down the runtime it is observing.
    }
  }
}
