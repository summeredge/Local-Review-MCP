import type { IncomingMessage } from "node:http";
import { extractBearerToken, tokensMatch } from "./token.js";

export function isAuthenticated(request: IncomingMessage, expectedToken: string): boolean {
  return tokensMatch(expectedToken, extractBearerToken(request.headers.authorization));
}
