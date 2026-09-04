import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { taskIdSchema } from "./schema.js";

export const TASK_DIRECTORY = ".task" as const;
export const TASK_CONTEXTS_DIRECTORY = join(TASK_DIRECTORY, "contexts");

export function defaultTaskContextStorageRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(
      environment.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      "LocalReviewMCP",
    );
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "LocalReviewMCP");
  }
  return join(
    environment.XDG_STATE_HOME ?? join(home, ".local", "state"),
    "LocalReviewMCP",
  );
}

export function taskContextsDirectory(storageRoot: string): string {
  if (typeof storageRoot !== "string" || storageRoot.trim() === "") {
    throw new Error("Task context storage root is required.");
  }
  return join(resolve(storageRoot), TASK_CONTEXTS_DIRECTORY);
}

export function taskContextFile(storageRoot: string, taskId: string): string {
  const safeTaskId = taskIdSchema.parse(taskId);
  return join(taskContextsDirectory(storageRoot), `${safeTaskId}.json`);
}

export function createTaskId(): string {
  return randomUUID();
}
