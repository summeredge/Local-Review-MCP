import type { IncomingMessage } from "node:http";
import { extractBearerToken, OAUTH_DEFAULT_SUBJECT, OAuthTokenStore, tokensMatch } from "./token.js";

export type AuthenticationSource = "static" | "oauth" | null;

export interface AuthenticatedRequest {
  readonly source: Exclude<AuthenticationSource, null>;
  readonly subject: string;
}

export function authenticateRequest(
  request: IncomingMessage,
  expectedToken: string,
  oauthTokens?: OAuthTokenStore,
  resource?: string,
): AuthenticatedRequest | null {
  const token = extractBearerToken(request.headers.authorization);
  if (tokensMatch(expectedToken, token)) return { source: "static", subject: OAUTH_DEFAULT_SUBJECT };
  if (oauthTokens === undefined || resource === undefined) return null;
  let identity: { readonly subject: string; readonly clientId: string } | null;
  try {
    identity = oauthTokens.authenticate(token, resource);
  } catch {
    return null;
  }
  return identity === null ? null : { source: "oauth", subject: identity.subject };
}

export function authenticationSource(
  request: IncomingMessage,
  expectedToken: string,
  oauthTokens?: OAuthTokenStore,
  resource?: string,
): AuthenticationSource {
  return authenticateRequest(request, expectedToken, oauthTokens, resource)?.source ?? null;
}

export function isAuthenticated(
  request: IncomingMessage,
  expectedToken: string,
  oauthTokens?: OAuthTokenStore,
  resource?: string,
): boolean {
  return authenticationSource(request, expectedToken, oauthTokens, resource) !== null;
}
