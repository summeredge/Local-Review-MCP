import { join, resolve } from "node:path";
import { z } from "zod";
import {
  sessionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { TASK_DIRECTORY } from "../context/task.js";

export const DESKTOP_THREAD_BINDINGS_DIRECTORY = join(
  TASK_DIRECTORY,
  "desktop_thread_bindings",
);

const timestampSchema = z.string().datetime({ offset: true });
const identitySchema = z.string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() !== "", "identity must not be empty");

export interface DesktopThreadBinding {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly task_id: string;
  readonly session_id: string;
  readonly backend_identity: "desktop_codex_app";
  readonly target_thread_id: string;
  readonly host_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export const desktopThreadBindingSchema: z.ZodType<DesktopThreadBinding> = z.object({
  schema_version: z.literal(1),
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  session_id: sessionIdSchema,
  backend_identity: z.literal("desktop_codex_app"),
  target_thread_id: identitySchema,
  host_id: identitySchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

function requiredStorageRoot(storageRoot: string): string {
  if (typeof storageRoot !== "string" || storageRoot.trim() === "") {
    throw new Error("Desktop thread binding storage root is required.");
  }
  return resolve(storageRoot);
}

export function desktopThreadBindingsDirectory(
  storageRoot: string,
  workspaceId: string,
): string {
  const root = requiredStorageRoot(storageRoot);
  const safeWorkspaceId = workspaceIdSchema.parse(workspaceId);
  return join(root, DESKTOP_THREAD_BINDINGS_DIRECTORY, safeWorkspaceId);
}

export function desktopThreadBindingFile(
  storageRoot: string,
  workspaceId: string,
  sessionId: string,
): string {
  const safeSessionId = sessionIdSchema.parse(sessionId);
  return join(
    desktopThreadBindingsDirectory(storageRoot, workspaceId),
    `${safeSessionId}.json`,
  );
}
