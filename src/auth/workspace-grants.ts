import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { workspaceIdSchema } from "../context/schema.js";

export const WORKSPACE_GRANTS_SCHEMA_VERSION = 1 as const;

export interface WorkspaceGrant {
  readonly subject: string;
  readonly workspace_id: string;
  readonly granted_at: number;
}

interface PersistedWorkspaceGrants {
  readonly schema_version: 1;
  readonly grants: readonly WorkspaceGrant[];
}

export interface WorkspaceGrantStatus {
  readonly storage_path: string;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly grant_count: number;
  readonly grants: readonly WorkspaceGrant[];
}

export interface WorkspaceGrantStoreOptions {
  readonly path?: string;
}

function defaultWorkspaceGrantsPath(): string {
  return join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "LocalReviewMCP",
    "oauth",
    "workspace-grants.json",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGrants(raw: string): WorkspaceGrant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Workspace grant registry is invalid");
  }
  if (!isRecord(parsed)
    || parsed.schema_version !== WORKSPACE_GRANTS_SCHEMA_VERSION
    || !Array.isArray(parsed.grants)) {
    throw new Error("Workspace grant registry is invalid");
  }
  const grants: WorkspaceGrant[] = [];
  const seen = new Set<string>();
  for (const value of parsed.grants) {
    if (!isRecord(value)
      || typeof value.subject !== "string" || value.subject === "" || value.subject.length > 128
      || typeof value.workspace_id !== "string" || !workspaceIdSchema.safeParse(value.workspace_id).success
      || typeof value.granted_at !== "number" || !Number.isSafeInteger(value.granted_at)
      || value.granted_at < 0) {
      throw new Error("Workspace grant registry is invalid");
    }
    const key = `${value.subject}\u0000${value.workspace_id}`;
    if (seen.has(key)) throw new Error("Workspace grant registry is invalid");
    seen.add(key);
    grants.push({
      subject: value.subject,
      workspace_id: value.workspace_id,
      granted_at: value.granted_at,
    });
  }
  return grants;
}

/**
 * Workspace access is server-side state keyed by the OAuth subject, never by client_id alone.
 * The file is re-read on every check so a grant or revocation applies to existing tokens.
 */
export class WorkspaceGrantStore {
  private readonly path: string;
  private loaded = true;
  private error: string | null = null;

  public constructor(options: WorkspaceGrantStoreOptions = {}) {
    this.path = resolve(options.path ?? defaultWorkspaceGrantsPath());
    this.reload();
  }

  public isGranted(subject: string, workspaceId: string): boolean {
    return this.reload().some((grant) =>
      grant.subject === subject && grant.workspace_id === workspaceId);
  }

  public grant(subject: string, workspaceId: string, now = Date.now()): WorkspaceGrant {
    const grants = this.reload();
    this.assertWritable();
    const existing = grants.find((grant) =>
      grant.subject === subject && grant.workspace_id === workspaceId);
    if (existing !== undefined) return existing;
    const grant: WorkspaceGrant = { subject, workspace_id: workspaceId, granted_at: now };
    this.save([...grants, grant]);
    return grant;
  }

  public revoke(subject: string, workspaceId: string): boolean {
    const grants = this.reload();
    this.assertWritable();
    const next = grants.filter((grant) =>
      !(grant.subject === subject && grant.workspace_id === workspaceId));
    if (next.length === grants.length) return false;
    this.save(next);
    return true;
  }

  public getStatus(): WorkspaceGrantStatus {
    const grants = this.reload();
    return {
      storage_path: join("oauth", "workspace-grants.json"),
      loaded: this.loaded,
      error: this.error,
      grant_count: grants.length,
      grants,
    };
  }

  private reload(): readonly WorkspaceGrant[] {
    try {
      const grants = parseGrants(readFileSync(this.path, "utf8"));
      this.loaded = true;
      this.error = null;
      return grants;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        this.error = null;
        return [];
      }
      if (this.error === null) console.warn("Workspace grant registry unavailable");
      this.loaded = false;
      this.error = error instanceof Error ? error.message : "Workspace grant registry is invalid";
      return [];
    }
  }

  private assertWritable(): void {
    if (!this.loaded) throw new Error("Workspace grant registry is unavailable");
  }

  private save(grants: readonly WorkspaceGrant[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const state: PersistedWorkspaceGrants = {
      schema_version: WORKSPACE_GRANTS_SCHEMA_VERSION,
      grants,
    };
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, this.path);
    } catch (error: unknown) {
      rmSync(temporary, { force: true });
      throw new Error("Workspace grant registry could not be saved", { cause: error });
    }
    this.loaded = true;
    this.error = null;
  }
}
