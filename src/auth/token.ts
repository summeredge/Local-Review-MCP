// Token persistence and refresh rotation are adapted from codex-with-chatgpt (MIT).
// See THIRD_PARTY_NOTICES.md.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface IssuedOAuthToken {
  readonly token: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export interface StoredOAuthToken {
  readonly hash: string;
  readonly kind: "access" | "refresh";
  readonly client_id: string;
  readonly resource: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly revoked: boolean;
}

interface PersistedOAuthTokens {
  readonly schema_version: 1;
  readonly tokens: readonly StoredOAuthToken[];
}

export interface OAuthTokenStoreOptions {
  readonly path?: string;
  readonly accessTtlSeconds?: number;
  readonly refreshTtlSeconds?: number;
}

export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  return /^Bearer[ \t]+([^\s]+)$/iu.exec(header)?.[1];
}

export function tokensMatch(expected: string, candidate: string | undefined): boolean {
  if (candidate === undefined) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isStoredToken(value: unknown): value is StoredOAuthToken {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const token = value as Record<string, unknown>;
  return typeof token.hash === "string"
    && /^[a-f0-9]{64}$/u.test(token.hash)
    && (token.kind === "access" || token.kind === "refresh")
    && typeof token.client_id === "string" && token.client_id !== ""
    && typeof token.resource === "string" && token.resource !== ""
    && typeof token.issued_at === "number" && Number.isSafeInteger(token.issued_at)
    && typeof token.expires_at === "number" && Number.isSafeInteger(token.expires_at)
    && token.issued_at >= 0 && token.expires_at > token.issued_at
    && typeof token.revoked === "boolean";
}

export class OAuthTokenStore {
  private readonly tokens = new Map<string, StoredOAuthToken>();
  private readonly path: string | undefined;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  public constructor(options: number | OAuthTokenStoreOptions = {}) {
    const resolved = typeof options === "number"
      ? { accessTtlSeconds: options }
      : options;
    this.accessTtlSeconds = resolved.accessTtlSeconds ?? OAUTH_ACCESS_TOKEN_TTL_SECONDS;
    this.refreshTtlSeconds = resolved.refreshTtlSeconds ?? OAUTH_REFRESH_TOKEN_TTL_SECONDS;
    this.path = resolved.path === undefined ? undefined : resolve(resolved.path);
    this.load();
  }

  public issue(resource: string, now?: number): IssuedOAuthToken;
  public issue(resource: string, clientId: string, now?: number): IssuedOAuthToken;
  public issue(
    resource: string,
    clientIdOrNow: string | number = "legacy",
    requestedNow = Date.now(),
  ): IssuedOAuthToken {
    const clientId = typeof clientIdOrNow === "string" ? clientIdOrNow : "legacy";
    const now = typeof clientIdOrNow === "number" ? clientIdOrNow : requestedNow;
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    this.tokens.set(hashToken(accessToken), {
      hash: hashToken(accessToken),
      kind: "access",
      client_id: clientId,
      resource,
      issued_at: now,
      expires_at: now + this.accessTtlSeconds * 1000,
      revoked: false,
    });
    this.tokens.set(hashToken(refreshToken), {
      hash: hashToken(refreshToken),
      kind: "refresh",
      client_id: clientId,
      resource,
      issued_at: now,
      expires_at: now + this.refreshTtlSeconds * 1000,
      revoked: false,
    });
    this.save(now);
    return { token: accessToken, refreshToken, expiresIn: this.accessTtlSeconds };
  }

  public validate(token: string | undefined, resource: string, now = Date.now()): boolean {
    if (token === undefined) return false;
    const stored = this.tokens.get(hashToken(token));
    if (stored === undefined || stored.kind !== "access" || stored.revoked) return false;
    if (stored.expires_at <= now) {
      this.tokens.delete(stored.hash);
      this.save(now);
      return false;
    }
    return stored.resource === resource;
  }

  public rotate(
    refreshToken: string,
    clientId: string,
    resource?: string,
    now = Date.now(),
  ): IssuedOAuthToken | null {
    const key = hashToken(refreshToken);
    const stored = this.tokens.get(key);
    if (stored === undefined
      || stored.kind !== "refresh"
      || stored.revoked
      || stored.expires_at <= now
      || stored.client_id !== clientId
      || (resource !== undefined && stored.resource !== resource)) {
      return null;
    }
    this.tokens.delete(key);
    return this.issue(stored.resource, stored.client_id, now);
  }

  public delete(token: string): void {
    const key = hashToken(token);
    const stored = this.tokens.get(key);
    if (stored === undefined) return;
    this.tokens.delete(key);
    this.save();
  }

  private load(): void {
    if (this.path === undefined) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("OAuth token store could not be loaded", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      throw new Error("OAuth token store is invalid", { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      || (parsed as { schema_version?: unknown }).schema_version !== 1
      || !Array.isArray((parsed as { tokens?: unknown }).tokens)
      || !(parsed as { tokens: unknown[] }).tokens.every(isStoredToken)) {
      throw new Error("OAuth token store is invalid");
    }
    const now = Date.now();
    for (const token of (parsed as PersistedOAuthTokens).tokens) {
      if (!token.revoked && token.expires_at > now) this.tokens.set(token.hash, token);
    }
  }

  private save(now = Date.now()): void {
    if (this.path === undefined) return;
    const directory = dirname(this.path);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const state: PersistedOAuthTokens = {
      schema_version: 1,
      tokens: [...this.tokens.values()].filter((token) => !token.revoked && token.expires_at > now),
    };
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, this.path);
      chmodSync(this.path, 0o600);
    } catch (error: unknown) {
      rmSync(temporary, { force: true });
      throw new Error("OAuth token store could not be saved", { cause: error });
    }
  }
}
