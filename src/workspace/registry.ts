import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { WorkspaceManager, WorkspacePathError } from "./manager.js";
import type { WorkspaceRegistryEntry, WorkspaceSummary } from "./types.js";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface WorkspaceSelection {
  readonly id: string;
  readonly name: string;
  readonly manager: WorkspaceManager;
}

export interface WorkspaceRegistryOptions {
  readonly activeWorkspaceId?: string;
  readonly activeWorkspacePath?: string;
}

function registryInvalid(message = "Workspace registry is invalid."): WorkspacePathError {
  return new WorkspacePathError("WORKSPACE_REGISTRY_INVALID", message);
}

function comparablePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalPathForComparison(value: string): string {
  try {
    return comparablePath(realpathSync.native(resolve(value)));
  } catch {
    return comparablePath(resolve(value));
  }
}

export class WorkspaceRegistry {
  private readonly records: readonly WorkspaceSelection[];
  private readonly recordsById: ReadonlyMap<string, WorkspaceSelection>;
  public readonly activeWorkspaceId: string;

  public constructor(
    entries: readonly WorkspaceRegistryEntry[],
    options: WorkspaceRegistryOptions | string = {},
  ) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw registryInvalid("Workspace registry must contain at least one workspace.");
    }

    const ids = new Set<string>();
    const roots = new Set<string>();
    const records: WorkspaceSelection[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null
        || typeof entry.id !== "string"
        || !WORKSPACE_ID_PATTERN.test(entry.id)
        || typeof entry.name !== "string"
        || entry.name.trim() === ""
        || typeof entry.path !== "string"
        || entry.path.trim() === "") {
        throw registryInvalid("Each workspace must have a valid id, name, and path.");
      }
      if (ids.has(entry.id)) throw registryInvalid("Workspace registry contains duplicate ids.");
      ids.add(entry.id);

      const manager = new WorkspaceManager(entry.path);
      const root = comparablePath(manager.canonicalRoot);
      if (roots.has(root)) throw registryInvalid("Workspace registry contains duplicate paths.");
      roots.add(root);
      records.push({ id: entry.id, name: entry.name.trim(), manager });
    }

    this.records = records;
    this.recordsById = new Map(records.map((record) => [record.id, record]));
    const resolvedOptions = typeof options === "string"
      ? { activeWorkspaceId: options }
      : options ?? {};
    let activeWorkspaceId = resolvedOptions.activeWorkspaceId;
    if (activeWorkspaceId !== undefined && !this.recordsById.has(activeWorkspaceId)) {
      throw registryInvalid("The active workspace is not registered.");
    }
    if (activeWorkspaceId === undefined && resolvedOptions.activeWorkspacePath !== undefined) {
      const activePath = canonicalPathForComparison(resolvedOptions.activeWorkspacePath);
      activeWorkspaceId = records.find((record) =>
        comparablePath(record.manager.canonicalRoot) === activePath)?.id;
      if (activeWorkspaceId === undefined) {
        throw registryInvalid("The active workspace path is not registered.");
      }
    }
    this.activeWorkspaceId = activeWorkspaceId ?? records[0]!.id;
  }

  public static fromManager(manager: WorkspaceManager): WorkspaceRegistry {
    const name = basename(manager.canonicalRoot) || "workspace";
    return new WorkspaceRegistry([{
      id: manager.workspaceId,
      name,
      path: manager.canonicalRoot,
    }]);
  }

  public get active(): WorkspaceSelection {
    return this.resolve();
  }

  public resolve(workspaceId?: string): WorkspaceSelection {
    const id = workspaceId === undefined ? this.activeWorkspaceId : workspaceId;
    const selected = typeof id === "string" && WORKSPACE_ID_PATTERN.test(id)
      ? this.recordsById.get(id)
      : undefined;
    if (selected === undefined) {
      throw new WorkspacePathError("UNKNOWN_WORKSPACE_ID", "Unknown workspace_id.");
    }
    return selected;
  }

  public list(): readonly WorkspaceSummary[] {
    return this.records.map(({ id, name }) => ({ id, name }));
  }
}
