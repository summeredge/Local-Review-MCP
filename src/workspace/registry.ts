import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { validateWorkspaceIdentity } from "./identity.js";
import { WorkspaceManager, WorkspacePathError } from "./manager.js";
import type { WorkspaceIdentity, WorkspaceRegistryEntry, WorkspaceSummary } from "./types.js";

export interface WorkspaceSelection extends WorkspaceIdentity {
  readonly manager: WorkspaceManager;
}

export interface WorkspaceRegistryOptions {
  readonly activeWorkspaceId?: string;
  readonly activeWorkspacePath?: string;
  readonly activeWorkspaceIdentity?: WorkspaceIdentity;
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
      let identity: WorkspaceIdentity;
      try {
        identity = validateWorkspaceIdentity(entry);
      } catch {
        throw registryInvalid("Each workspace must have a valid id, name, and path.");
      }
      if (ids.has(identity.id)) throw registryInvalid("Workspace registry contains duplicate ids.");
      ids.add(identity.id);

      const manager = new WorkspaceManager(identity.path, identity);
      const root = comparablePath(manager.canonicalRoot);
      if (roots.has(root)) throw registryInvalid("Workspace registry contains duplicate paths.");
      roots.add(root);
      records.push({ ...identity, manager });
    }

    this.records = records;
    this.recordsById = new Map(records.map((record) => [record.id, record]));
    const resolvedOptions = typeof options === "string"
      ? { activeWorkspaceId: options }
      : options ?? {};
    let activeWorkspaceId = resolvedOptions.activeWorkspaceId;
    const activeIdentity = resolvedOptions.activeWorkspaceIdentity === undefined
      ? undefined
      : validateWorkspaceIdentity(resolvedOptions.activeWorkspaceIdentity);
    if (activeIdentity !== undefined) {
      const selected = this.recordsById.get(activeIdentity.id);
      if (selected === undefined
        || selected.name !== activeIdentity.name
        || canonicalPathForComparison(selected.path) !== canonicalPathForComparison(activeIdentity.path)) {
        throw registryInvalid("The active workspace identity does not match the registry.");
      }
      activeWorkspaceId = activeIdentity.id;
    }
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
    return new WorkspaceRegistry([{
      ...manager.identity,
    }]);
  }

  public get active(): WorkspaceSelection {
    return this.resolve();
  }

  public resolve(workspaceId?: string): WorkspaceSelection {
    const id = workspaceId === undefined ? this.activeWorkspaceId : workspaceId;
    const selected = typeof id === "string" ? this.recordsById.get(id) : undefined;
    if (selected === undefined) {
      throw new WorkspacePathError("UNKNOWN_WORKSPACE_ID", "Unknown workspace_id.");
    }
    return selected;
  }

  public list(): readonly WorkspaceSummary[] {
    return this.records.map(({ id, name }) => ({ id, name }));
  }
}
