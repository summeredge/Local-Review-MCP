import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { AccessPolicy } from "./policy.js";
import {
  isContainedPath,
  normalizeRemotePath,
  WorkspacePathError,
} from "./path.js";

export interface ResolvedWorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

function workspaceInvalid(): WorkspacePathError {
  return new WorkspacePathError("WORKSPACE_INVALID", "Workspace root is invalid.");
}

function pathError(
  code: "PATH_OUTSIDE_WORKSPACE" | "PATH_NOT_FOUND" | "PATH_NOT_DIRECTORY",
  relativePath: string,
): WorkspacePathError {
  const message = code === "PATH_OUTSIDE_WORKSPACE"
    ? `Workspace path "${relativePath}" is outside the workspace.`
    : code === "PATH_NOT_DIRECTORY"
      ? `Workspace path "${relativePath}" requires a directory.`
      : `Workspace path "${relativePath}" was not found.`;
  return new WorkspacePathError(code, message, relativePath);
}

function canonicalIdInput(canonicalRoot: string): string {
  const normalized = canonicalRoot.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function makeWorkspaceId(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalIdInput(canonicalRoot)).digest("hex").slice(0, 12);
}

function canonicalRelativePath(root: string, candidate: string): string {
  const value = relative(root, candidate).replaceAll("\\", "/");
  return value === "" ? "." : value;
}

function canonicalizeCandidate(candidate: string, relativePath: string): string {
  const missingTail: string[] = [];
  let current = candidate;

  while (true) {
    let exists = false;
    try {
      lstatSync(current);
      exists = true;
    } catch (error: unknown) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw pathError("PATH_NOT_FOUND", relativePath);
    }

    if (exists) {
      let canonicalCurrent: string;
      try {
        canonicalCurrent = realpathSync.native(current);
      } catch {
        throw pathError("PATH_NOT_FOUND", relativePath);
      }

      if (missingTail.length > 0) {
        try {
          if (!statSync(current).isDirectory()) throw pathError("PATH_NOT_DIRECTORY", relativePath);
        } catch (error: unknown) {
          if (error instanceof WorkspacePathError) throw error;
          throw pathError("PATH_NOT_DIRECTORY", relativePath);
        }
      }

      return missingTail.length === 0
        ? canonicalCurrent
        : join(canonicalCurrent, ...missingTail);
    }

    missingTail.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) throw pathError("PATH_NOT_FOUND", relativePath);
    current = parent;
  }
}

function canonicalizeWorkspaceRoot(input: string): string {
  if (typeof input !== "string") throw workspaceInvalid();

  let absoluteRoot: string;
  try {
    absoluteRoot = resolve(input);
  } catch {
    throw workspaceInvalid();
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(absoluteRoot);
    if (!statSync(canonicalRoot).isDirectory()) throw workspaceInvalid();
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) throw error;
    throw workspaceInvalid();
  }
  return canonicalRoot;
}

export class WorkspaceManager {
  public readonly canonicalRoot: string;
  public readonly workspaceId: string;
  public readonly policy: AccessPolicy;

  public constructor(workspaceRoot: string) {
    this.canonicalRoot = canonicalizeWorkspaceRoot(workspaceRoot);
    this.workspaceId = makeWorkspaceId(this.canonicalRoot);
    this.policy = new AccessPolicy(this.canonicalRoot);
  }

  public get root(): string {
    return this.canonicalRoot;
  }

  public resolvePath(remotePath: string): ResolvedWorkspacePath {
    const relativePath = normalizeRemotePath(remotePath);
    const candidate = resolve(this.canonicalRoot, relativePath);
    if (!isContainedPath(this.canonicalRoot, candidate)) {
      throw pathError("PATH_OUTSIDE_WORKSPACE", relativePath);
    }

    const canonicalPath = canonicalizeCandidate(candidate, relativePath);
    if (!isContainedPath(this.canonicalRoot, canonicalPath)) {
      throw pathError("PATH_OUTSIDE_WORKSPACE", relativePath);
    }

    this.policy.assertAllowed(relativePath);
    const canonicalRelative = canonicalRelativePath(this.canonicalRoot, canonicalPath);
    if (canonicalRelative !== relativePath) this.policy.assertAllowed(canonicalRelative);
    return { absolutePath: canonicalPath, relativePath };
  }

  public resolveExisting(remotePath: string): ResolvedWorkspacePath {
    const resolvedPath = this.resolvePath(remotePath);
    try {
      statSync(resolvedPath.absolutePath);
    } catch {
      throw pathError("PATH_NOT_FOUND", resolvedPath.relativePath);
    }
    return resolvedPath;
  }
}

export {
  assertSafeRemotePathSyntax,
  containsAdsSyntax,
  isContainedPath,
  isReservedWindowsName,
  normalizeRemotePath,
  WorkspacePathError,
} from "./path.js";
export type { WorkspaceErrorCode } from "./path.js";
