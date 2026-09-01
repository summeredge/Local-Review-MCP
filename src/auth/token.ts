import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;

export interface IssuedOAuthToken {
  readonly token: string;
  readonly expiresIn: number;
}

interface StoredOAuthToken {
  readonly resource: string;
  readonly expiresAt: number;
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

export class OAuthTokenStore {
  private readonly tokens = new Map<string, StoredOAuthToken>();

  public constructor(
    private readonly ttlSeconds = OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  ) {}

  public issue(resource: string, now = Date.now()): IssuedOAuthToken {
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(hashToken(token), {
      resource,
      expiresAt: now + this.ttlSeconds * 1000,
    });
    return { token, expiresIn: this.ttlSeconds };
  }

  public validate(token: string | undefined, resource: string, now = Date.now()): boolean {
    if (token === undefined) return false;
    const key = hashToken(token);
    const stored = this.tokens.get(key);
    if (stored === undefined) return false;
    if (stored.expiresAt <= now) {
      this.tokens.delete(key);
      return false;
    }
    return stored.resource === resource;
  }

  public delete(token: string): void {
    this.tokens.delete(hashToken(token));
  }
}
