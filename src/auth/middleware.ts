import type { IncomingMessage } from "node:http";
import { extractBearerToken, OAuthTokenStore, tokensMatch } from "./token.js";

export function isAuthenticated(
  request: IncomingMessage,
  expectedToken: string,
  oauthTokens?: OAuthTokenStore,
  resource?: string,
): boolean {
  const token = extractBearerToken(request.headers.authorization);
  return tokensMatch(expectedToken, token)
    || (oauthTokens !== undefined && resource !== undefined && oauthTokens.validate(token, resource));
}
