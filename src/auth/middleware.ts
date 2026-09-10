import type { IncomingMessage } from "node:http";
import { extractBearerToken, OAuthTokenStore, tokensMatch } from "./token.js";

export type AuthenticationSource = "static" | "oauth" | null;

export function authenticationSource(
  request: IncomingMessage,
  expectedToken: string,
  oauthTokens?: OAuthTokenStore,
  resource?: string,
): AuthenticationSource {
  const token = extractBearerToken(request.headers.authorization);
  if (tokensMatch(expectedToken, token)) return "static";
  return oauthTokens !== undefined && resource !== undefined && oauthTokens.validate(token, resource)
    ? "oauth"
    : null;
}

export function isAuthenticated(
  request: IncomingMessage,
  expectedToken: string,
  oauthTokens?: OAuthTokenStore,
  resource?: string,
): boolean {
  return authenticationSource(request, expectedToken, oauthTokens, resource) !== null;
}
