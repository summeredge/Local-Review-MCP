import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { sessionIdSchema } from "./schema.js";
import { TASK_DIRECTORY } from "./task.js";

export const SESSIONS_DIRECTORY = join(TASK_DIRECTORY, "sessions");

export function sessionsDirectory(storageRoot: string): string {
  if (typeof storageRoot !== "string" || storageRoot.trim() === "") {
    throw new Error("Session storage root is required.");
  }
  return join(resolve(storageRoot), SESSIONS_DIRECTORY);
}

export function sessionFile(storageRoot: string, sessionId: string): string {
  return join(sessionsDirectory(storageRoot), `${sessionIdSchema.parse(sessionId)}.json`);
}

export function createSessionId(): string {
  return randomUUID();
}
