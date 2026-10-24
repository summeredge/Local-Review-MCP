// Token persistence and refresh rotation are adapted from codex-with-chatgpt (MIT).
// See THIRD_PARTY_NOTICES.md.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
// Single-owner LRM: every OAuth client identifies the same local authorized subject.
export const OAUTH_DEFAULT_SUBJECT = "owner";

export interface IssuedOAuthToken {
  readonly token: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export interface StoredOAuthToken {
  readonly hash: string;
  readonly kind: "access" | "refresh";
  readonly client_id: string;
  readonly subject: string;
  readonly resource: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly revoked: boolean;
}

export interface OAuthTokenIdentity {
  readonly subject: string;
  readonly clientId: string;
}

export function readOAuthTokenRecords(path: string, now = Date.now()): StoredOAuthToken[] {
  const raw = readFileSync(path, "utf8");
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
  return (parsed as PersistedOAuthTokens).tokens
    .map(normalizeToken)
    .filter((token) => !token.revoked && token.expires_at > now);
}

export function writeOAuthTokenRecords(
  path: string,
  tokens: Iterable<StoredOAuthToken>,
  now = Date.now(),
): void {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const state: PersistedOAuthTokens = {
    schema_version: 1,
    tokens: [...tokens].filter((token) => !token.revoked && token.expires_at > now),
  };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error: unknown) {
    rmSync(temporary, { force: true });
    throw new Error("OAuth token store could not be saved", { cause: error });
  }
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
    && (token.subject === undefined || (typeof token.subject === "string" && token.subject !== ""))
    && typeof token.resource === "string" && token.resource !== ""
    && typeof token.issued_at === "number" && Number.isSafeInteger(token.issued_at)
    && typeof token.expires_at === "number" && Number.isSafeInteger(token.expires_at)
    && token.issued_at >= 0 && token.expires_at > token.issued_at
    && typeof token.revoked === "boolean";
}

function normalizeToken(value: StoredOAuthToken): StoredOAuthToken {
  // Tokens issued before workspace grants existed carry no subject; they belonged to the owner.
  return { ...value, subject: value.subject ?? OAUTH_DEFAULT_SUBJECT };
}

export class OAuthTokenStore {
  private tokens = new Map<string, StoredOAuthToken>();
  private readonly path: string | undefined;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private loaded = true;
  private loadError: string | null = null;

  public constructor(options: number | OAuthTokenStoreOptions = {}) {
    const resolved = typeof options === "number"
      ? { accessTtlSeconds: options }
      : options;
    this.accessTtlSeconds = resolved.accessTtlSeconds ?? OAUTH_ACCESS_TOKEN_TTL_SECONDS;
    this.refreshTtlSeconds = resolved.refreshTtlSeconds ?? OAUTH_REFRESH_TOKEN_TTL_SECONDS;
    this.path = resolved.path === undefined ? undefined : resolve(resolved.path);
    try {
      this.load();
    } catch (error: unknown) {
      // A corrupt token registry is a reauthorization event, not a runtime crash.
      this.tokens.clear();
      this.loaded = false;
      this.loadError = error instanceof Error ? error.message : "OAuth token store is invalid";
      console.warn("OAuth token registry unavailable");
    }
  }

  public issue(resource: string, now?: number): IssuedOAuthToken;
  public issue(resource: string, clientId: string, now?: number): IssuedOAuthToken;
  public issue(resource: string, clientId: string, subject: string, now?: number): IssuedOAuthToken;
  public issue(
    resource: string,
    clientIdOrNow: string | number = OAUTH_DEFAULT_SUBJECT,
    subjectOrNow: string | number = OAUTH_DEFAULT_SUBJECT,
    requestedNow = Date.now(),
  ): IssuedOAuthToken {
    const clientId = typeof clientIdOrNow === "string" ? clientIdOrNow : OAUTH_DEFAULT_SUBJECT;
    const subject = typeof subjectOrNow === "string" ? subjectOrNow : OAUTH_DEFAULT_SUBJECT;
    const now = typeof clientIdOrNow === "number"
      ? clientIdOrNow
      : typeof subjectOrNow === "number"
        ? subjectOrNow
        : requestedNow;
    return this.issuePair(resource, clientId, subject, now);
  }

  private issuePair(
    resource: string,
    clientId: string,
    subject: string,
    now: number,
    replacedRefreshToken?: string,
  ): IssuedOAuthToken {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const next = new Map(this.tokens);
    if (replacedRefreshToken !== undefined) next.delete(replacedRefreshToken);
    next.set(hashToken(accessToken), {
      hash: hashToken(accessToken),
      kind: "access",
      client_id: clientId,
      subject,
      resource,
      issued_at: now,
      expires_at: now + this.accessTtlSeconds * 1000,
      revoked: false,
    });
    next.set(hashToken(refreshToken), {
      hash: hashToken(refreshToken),
      kind: "refresh",
      client_id: clientId,
      subject,
      resource,
      issued_at: now,
      expires_at: now + this.refreshTtlSeconds * 1000,
      revoked: false,
    });
    this.save(now, next);
    return { token: accessToken, refreshToken, expiresIn: this.accessTtlSeconds };
  }

  public validate(token: string | undefined, resource: string, now = Date.now()): boolean {
    return this.authenticate(token, resource, now) !== null;
  }

  public authenticate(
    token: string | undefined,
    resource: string,
    now = Date.now(),
  ): OAuthTokenIdentity | null {
    if (token === undefined) return null;
    const stored = this.tokens.get(hashToken(token));
    if (stored === undefined || stored.kind !== "access" || stored.revoked) return null;
    if (stored.expires_at <= now) {
      const next = new Map(this.tokens);
      next.delete(stored.hash);
      this.save(now, next);
      return null;
    }
    return stored.resource === resource
      ? { subject: stored.subject, clientId: stored.client_id }
      : null;
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
    return this.issuePair(stored.resource, stored.client_id, stored.subject, now, key);
  }

  public status(): {
    readonly loaded: boolean;
    readonly error: string | null;
    readonly token_count: number;
  } {
    return {
      loaded: this.loaded,
      error: this.loadError,
      token_count: this.tokens.size,
    };
  }

  public delete(token: string): void {
    const key = hashToken(token);
    const stored = this.tokens.get(key);
    if (stored === undefined) return;
    const next = new Map(this.tokens);
    next.delete(key);
    this.save(Date.now(), next);
  }

  private load(): void {
    if (this.path === undefined) return;
    try {
      for (const token of readOAuthTokenRecords(this.path)) {
        this.tokens.set(token.hash, token);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private save(now = Date.now(), tokens = this.tokens): void {
    if (this.path === undefined) { this.tokens = tokens; return; }
    try {
      writeOAuthTokenRecords(this.path, tokens.values(), now);
      this.tokens = tokens;
      this.loaded = true;
      this.loadError = null;
    } catch (error: unknown) {
      throw new Error("OAuth token store could not be saved", { cause: error });
    }
  }
}
