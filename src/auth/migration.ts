import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { workspaceIdSchema } from "../context/schema.js";
import {
  readOAuthClientRecords,
  writeOAuthClientRecords,
  type OAuthRegisteredClient,
} from "./oauth.js";
import {
  OAUTH_DEFAULT_SUBJECT,
  readOAuthTokenRecords,
  writeOAuthTokenRecords,
  type StoredOAuthToken,
} from "./token.js";
import type { WorkspaceGrantStore } from "./workspace-grants.js";

export type OAuthInstanceStateMigrationStatus =
  | "not_needed"
  | "migrated"
  | "reauthorization_required";

export interface InstanceOAuthStatePaths {
  readonly clientRegistryPath: string;
  readonly tokenStorePath: string;
  readonly workspaceGrantsPath: string;
  readonly backupDirectory: string;
}

export interface OAuthInstanceStateMigration {
  readonly paths: InstanceOAuthStatePaths;
  readonly migration: OAuthInstanceStateMigrationStatus;
  readonly granted_workspaces: readonly string[];
  readonly conflicts: number;
}

export function instanceOAuthStatePaths(storageRoot: string): InstanceOAuthStatePaths {
  const oauthRoot = join(resolve(storageRoot), "oauth");
  return {
    clientRegistryPath: join(oauthRoot, "clients.json"),
    tokenStorePath: join(oauthRoot, "tokens.json"),
    workspaceGrantsPath: join(oauthRoot, "workspace-grants.json"),
    backupDirectory: join(oauthRoot, "backups"),
  };
}

export function resolveInstanceOAuthStatePaths(
  storageRoot: string | undefined,
  overrides: {
    readonly clientRegistryPath?: string;
    readonly tokenStorePath?: string;
  } = {},
): InstanceOAuthStatePaths | undefined {
  const base = storageRoot === undefined ? undefined : instanceOAuthStatePaths(storageRoot);
  const clientRegistryPath = overrides.clientRegistryPath ?? base?.clientRegistryPath;
  if (clientRegistryPath === undefined) return undefined;
  const oauthRoot = dirname(clientRegistryPath);
  return {
    clientRegistryPath,
    tokenStorePath: overrides.tokenStorePath ?? join(oauthRoot, "tokens.json"),
    workspaceGrantsPath: join(oauthRoot, "workspace-grants.json"),
    backupDirectory: join(oauthRoot, "backups"),
  };
}

export function workspaceOAuthStatePaths(
  workspaceId: string,
  storageRoot: string,
): { readonly clientRegistryPath: string; readonly tokenStorePath: string } {
  const safeWorkspaceId = workspaceIdSchema.parse(workspaceId);
  const oauthRoot = join(resolve(storageRoot), "workspaces", `ws-${safeWorkspaceId}`, "oauth");
  return {
    clientRegistryPath: join(oauthRoot, "clients.json"),
    tokenStorePath: join(oauthRoot, "tokens.json"),
  };
}

function readClients(path: string): readonly OAuthRegisteredClient[] | null {
  if (!existsSync(path)) return [];
  try {
    return readOAuthClientRecords(path);
  } catch {
    return null;
  }
}

function readTokens(path: string, now: number): readonly StoredOAuthToken[] | null {
  if (!existsSync(path)) return [];
  try {
    return readOAuthTokenRecords(path, now);
  } catch {
    return null;
  }
}

function sameClient(left: OAuthRegisteredClient, right: OAuthRegisteredClient): boolean {
  return left.client_id === right.client_id
    && left.client_secret === right.client_secret
    && left.client_name === right.client_name
    && left.client_id_issued_at === right.client_id_issued_at
    && left.redirect_uris.length === right.redirect_uris.length
    && left.redirect_uris.every((value, index) => value === right.redirect_uris[index]);
}

function backup(path: string, directory: string, stamp: number): void {
  if (!existsSync(path)) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  copyFileSync(path, join(directory, `${path.split(/[\\/]/u).pop() ?? "state"}.${stamp}.bak.json`));
}

function migrationMarkerPath(paths: InstanceOAuthStatePaths): string {
  return join(dirname(paths.workspaceGrantsPath), "instance-migration.json");
}

function writeMigrationMarker(path: string, now: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ schema_version: 1, completed_at: now }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error: unknown) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * One LRM instance has one OAuth registry. Workspace-scoped registries from the previous
 * architecture are merged into it without modifying the source files; workspace access for each
 * imported token set is recorded separately as an explicit owner grant.
 */
export function migrateOAuthStateToInstance(options: {
  readonly storageRoot: string;
  readonly instancePaths?: InstanceOAuthStatePaths;
  readonly workspaceIds: readonly string[];
  readonly activeWorkspaceId?: string;
  readonly grants: WorkspaceGrantStore;
  readonly applyGrants?: boolean;
  readonly applyCredentials?: boolean;
  readonly now?: number;
}): OAuthInstanceStateMigration {
  const now = options.now ?? Date.now();
  const paths = options.instancePaths ?? instanceOAuthStatePaths(options.storageRoot);
  const clients = new Map<string, OAuthRegisteredClient>();
  const tokens = new Map<string, StoredOAuthToken>();
  let conflicts = 0;
  let reauthorization = false;
  let changed = false;
  let legacyGlobalPresent = false;

  const globalClients = readClients(paths.clientRegistryPath);
  const globalTokens = readTokens(paths.tokenStorePath, now);
  legacyGlobalPresent = globalClients !== null && globalClients.length > 0
    || globalTokens !== null && globalTokens.length > 0;
  if (globalClients === null) {
    try { backup(paths.clientRegistryPath, paths.backupDirectory, now); } catch { /* retry next start */ }
    reauthorization = true;
  } else {
    for (const client of globalClients) clients.set(client.client_id, client);
  }
  if (globalTokens === null) {
    try { backup(paths.tokenStorePath, paths.backupDirectory, now); } catch { /* retry next start */ }
    reauthorization = true;
  } else {
    for (const token of globalTokens) tokens.set(token.hash, token);
  }

  const presentWorkspaces = options.workspaceIds.filter((workspaceId) =>
    workspaceIdSchema.safeParse(workspaceId).success);
  const scoped = presentWorkspaces.map((workspaceId) => {
    const paths = workspaceOAuthStatePaths(workspaceId, options.storageRoot);
    return {
      workspaceId,
      clients: readClients(paths.clientRegistryPath),
      tokens: readTokens(paths.tokenStorePath, now),
    };
  });

  for (const state of scoped) {
    if (state.clients === null || state.tokens === null) {
      reauthorization = true;
      continue;
    }
    for (const client of state.clients) {
      const existing = clients.get(client.client_id);
      if (existing === undefined) {
        clients.set(client.client_id, client);
        changed = true;
      } else if (!sameClient(existing, client)) {
        conflicts += 1;
        reauthorization = true;
      }
    }
  }

  const grantedWorkspaces = new Set<string>();
  for (const state of scoped) {
    if (state.clients === null || state.tokens === null) continue;
    for (const token of state.tokens) {
      const existing = tokens.get(token.hash);
      if (existing !== undefined) {
        if (existing.client_id !== token.client_id
          || existing.resource !== token.resource
          || existing.subject !== token.subject) {
          conflicts += 1;
          reauthorization = true;
        }
        continue;
      }
      if (clients.get(token.client_id) === undefined) {
        reauthorization = true;
        continue;
      }
      tokens.set(token.hash, token);
      changed = true;
    }
    if (state.clients.length > 0 || state.tokens.length > 0) {
      grantedWorkspaces.add(state.workspaceId);
    }
  }

  // The pre-upgrade runtime kept a single global token set, which was valid only for the
  // workspace that was active at the time. Preserve that boundary rather than granting all.
  if (legacyGlobalPresent && options.activeWorkspaceId !== undefined
    && presentWorkspaces.includes(options.activeWorkspaceId)
    && !scoped.some((state) => state.tokens !== null && state.tokens.length > 0)) {
    grantedWorkspaces.add(options.activeWorkspaceId);
  }

  if (changed && options.applyCredentials !== false) {
    try {
      backup(paths.clientRegistryPath, paths.backupDirectory, now);
      backup(paths.tokenStorePath, paths.backupDirectory, now);
      writeOAuthClientRecords(paths.clientRegistryPath, clients.values());
      writeOAuthTokenRecords(paths.tokenStorePath, tokens.values(), now);
    } catch {
      // The previous instance data is still intact; retry on the next start.
      reauthorization = true;
    }
  }

  const markerPath = migrationMarkerPath(paths);
  const appliedGrants: string[] = [];
  if (!existsSync(markerPath) && options.applyGrants !== false) {
    let grantsWritten = true;
    // An existing grants file means a previous build already applied the migration, including a
    // user's deliberate revocations. Never derive those grants again.
    if (!existsSync(paths.workspaceGrantsPath)) {
      for (const workspaceId of grantedWorkspaces) {
        try {
          if (options.grants.isGranted(OAUTH_DEFAULT_SUBJECT, workspaceId)) continue;
          options.grants.grant(OAUTH_DEFAULT_SUBJECT, workspaceId, now);
          appliedGrants.push(workspaceId);
        } catch {
          grantsWritten = false;
          reauthorization = true;
        }
      }
    }
    const grantsLoaded = options.grants.getStatus().loaded;
    if (grantsWritten && grantsLoaded) {
      try {
        writeMigrationMarker(markerPath, now);
      } catch {
        reauthorization = true;
      }
    } else if (!grantsLoaded) {
      reauthorization = true;
    }
  }

  return {
    paths,
    migration: reauthorization
      ? "reauthorization_required"
      : changed || appliedGrants.length > 0 ? "migrated" : "not_needed",
    granted_workspaces: appliedGrants.sort(),
    conflicts,
  };
}
