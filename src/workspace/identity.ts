import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { WorkspacePathError } from "./path.js";
import type { WorkspaceIdentity } from "./types.js";

export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function validateWorkspaceIdentity(value: unknown): WorkspaceIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspacePathError("WORKSPACE_IDENTITY_INVALID", "Workspace identity must be an object.");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !WORKSPACE_ID_PATTERN.test(raw.id) || raw.id.length > 128) {
    throw new WorkspacePathError("WORKSPACE_IDENTITY_INVALID", "Workspace identity id is invalid.");
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new WorkspacePathError("WORKSPACE_IDENTITY_INVALID", "Workspace identity name is invalid.");
  }
  if (typeof raw.path !== "string" || raw.path.trim() === "") {
    throw new WorkspacePathError("WORKSPACE_IDENTITY_INVALID", "Workspace identity path is invalid.");
  }
  return {
    id: raw.id,
    name: raw.name.trim(),
    path: raw.path.trim(),
  };
}

function comparablePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function canonicalPathForComparison(value: string): string {
  try {
    return comparablePath(realpathSync.native(resolve(value)));
  } catch {
    return comparablePath(resolve(value));
  }
}

export function validateWorkspaceIdentityConsistency(
  registryIdentity: WorkspaceIdentity,
  runtimeIdentity: WorkspaceIdentity,
): void {
  const registry = validateWorkspaceIdentity(registryIdentity);
  const runtime = validateWorkspaceIdentity(runtimeIdentity);
  if (registry.id !== runtime.id
    || registry.name !== runtime.name
    || canonicalPathForComparison(registry.path) !== canonicalPathForComparison(runtime.path)) {
    throw new WorkspacePathError(
      "WORKSPACE_IDENTITY_MISMATCH",
      "WORKSPACE_IDENTITY_MISMATCH: Workspace identity does not match the runtime registry.",
    );
  }
}
