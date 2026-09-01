import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  OAuthTokenStore,
  type IssuedOAuthToken,
} from "./token.js";

export const OAUTH_PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const OAUTH_AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
export const OAUTH_REGISTER_PATH = "/oauth/register";
export const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
export const OAUTH_TOKEN_PATH = "/oauth/token";
export const OAUTH_AUTHORIZATION_CODE_TTL_SECONDS = 300;

type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_target"
  | "invalid_client_metadata"
  | "unsupported_grant_type";

export class OAuthRequestError extends Error {
  public constructor(
    public readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OAuthRequestError";
  }
}

export interface OAuthRegisteredClient {
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uris: readonly string[];
  readonly token_endpoint_auth_method: "none";
  readonly grant_types: readonly ["authorization_code"];
  readonly response_types: readonly ["code"];
  readonly client_id_issued_at: number;
}

interface AuthorizationCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly expiresAt: number;
}

interface AuthorizationCodeRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secureEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function assertValidRedirectUri(value: string): void {
  if (value.trim() !== value || /\s/u.test(value)) {
    throw new OAuthRequestError("invalid_client_metadata", "redirect_uris must contain valid URLs");
  }
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new OAuthRequestError("invalid_client_metadata", "redirect_uris must contain valid URLs");
  }

  if (uri.username !== "" || uri.password !== "" || uri.hash !== "") {
    throw new OAuthRequestError(
      "invalid_client_metadata",
      "redirect_uris must not contain credentials or fragments",
    );
  }
  if (uri.protocol === "https:") return;
  if (uri.protocol === "http:" && isLoopbackHost(uri.hostname)) return;
  throw new OAuthRequestError(
    "invalid_client_metadata",
    "redirect_uris must use HTTPS or a loopback HTTP URL",
  );
}

export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;

  let requestedUrl: URL;
  let registeredUrl: URL;
  try {
    requestedUrl = new URL(requested);
    registeredUrl = new URL(registered);
  } catch {
    return false;
  }

  if (!isLoopbackHost(requestedUrl.hostname)
    || !isLoopbackHost(registeredUrl.hostname)
    || requestedUrl.hostname !== registeredUrl.hostname
    || requestedUrl.protocol !== registeredUrl.protocol
    || requestedUrl.pathname !== registeredUrl.pathname
    || requestedUrl.search !== registeredUrl.search
    || requestedUrl.hash !== registeredUrl.hash) {
    return false;
  }
  return true;
}

export function isValidCodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/u.test(value);
}

export function isValidCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/u.test(value);
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function normalizeResource(value: string): string {
  let resource: URL;
  try {
    resource = new URL(value);
  } catch {
    throw new OAuthRequestError("invalid_target", "resource must be an absolute URL");
  }
  if (resource.username !== "" || resource.password !== "" || resource.hash !== "") {
    throw new OAuthRequestError("invalid_target", "resource must not contain credentials or fragments");
  }
  return resource.href;
}

function supportedList(
  value: unknown,
  field: "grant_types" | "response_types",
  expected: string,
  allowAdditional = false,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)
    || value.length === 0
    || value.some((item) => typeof item !== "string")
    || !value.includes(expected)
    || (!allowAdditional && value.length !== 1)) {
    throw new OAuthRequestError(
      "invalid_client_metadata",
      `${field} must ${allowAdditional ? "include" : "contain only"} ${expected}`,
    );
  }
}

export class OAuthService {
  public readonly tokens = new OAuthTokenStore();

  private readonly clients = new Map<string, OAuthRegisteredClient>();
  private readonly authorizationCodes = new Map<string, AuthorizationCode>();

  public registerClient(input: unknown): OAuthRegisteredClient {
    if (!isRecord(input)) {
      throw new OAuthRequestError("invalid_client_metadata", "registration body must be a JSON object");
    }

    const requestedClientName = input.client_name;
    if (requestedClientName !== undefined
      && (typeof requestedClientName !== "string"
        || requestedClientName.trim() === ""
        || requestedClientName.length > 200)) {
      throw new OAuthRequestError("invalid_client_metadata", "client_name must be a non-empty string");
    }
    const clientName = requestedClientName === undefined
      ? "Local Review MCP Client"
      : requestedClientName.trim();

    const redirectUris = input.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 20
      || redirectUris.some((uri) => typeof uri !== "string")) {
      throw new OAuthRequestError(
        "invalid_client_metadata",
        "redirect_uris must contain between one and twenty URLs",
      );
    }
    for (const uri of redirectUris) assertValidRedirectUri(uri);

    if (input.token_endpoint_auth_method !== undefined
      && input.token_endpoint_auth_method !== "none") {
      throw new OAuthRequestError(
        "invalid_client_metadata",
        "only public clients using token_endpoint_auth_method=none are supported",
      );
    }
    supportedList(input.grant_types, "grant_types", "authorization_code", true);
    supportedList(input.response_types, "response_types", "code");

    const client: OAuthRegisteredClient = {
      client_id: randomUUID(),
      client_name: clientName.trim(),
      redirect_uris: [...redirectUris],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(client.client_id, client);
    return client;
  }

  public getClient(clientId: string): OAuthRegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  public createAuthorizationCode(request: AuthorizationCodeRequest): string {
    const client = this.clients.get(request.clientId);
    if (client === undefined) throw new OAuthRequestError("invalid_client", "Invalid client_id");
    if (!client.redirect_uris.some((uri) => redirectUriMatches(request.redirectUri, uri))) {
      throw new OAuthRequestError("invalid_request", "Unregistered redirect_uri");
    }
    if (!isValidCodeChallenge(request.codeChallenge)) {
      throw new OAuthRequestError("invalid_request", "code_challenge is invalid");
    }

    const code = randomBytes(32).toString("base64url");
    this.authorizationCodes.set(hashValue(code), {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: normalizeResource(request.resource),
      expiresAt: Date.now() + OAUTH_AUTHORIZATION_CODE_TTL_SECONDS * 1000,
    });
    return code;
  }

  public exchangeAuthorizationCode(request: {
    readonly clientId: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri?: string;
    readonly resource?: string;
  }): IssuedOAuthToken {
    const key = hashValue(request.code);
    const stored = this.authorizationCodes.get(key);
    if (stored === undefined || stored.expiresAt <= Date.now()) {
      this.authorizationCodes.delete(key);
      throw new OAuthRequestError("invalid_grant", "Authorization code is invalid or expired");
    }

    if (this.clients.get(request.clientId) === undefined || stored.clientId !== request.clientId) {
      throw new OAuthRequestError("invalid_grant", "Authorization code is invalid");
    }
    if (request.redirectUri !== undefined
      && !redirectUriMatches(request.redirectUri, stored.redirectUri)) {
      throw new OAuthRequestError("invalid_grant", "redirect_uri does not match");
    }
    if (request.resource !== undefined
      && normalizeResource(request.resource) !== stored.resource) {
      throw new OAuthRequestError("invalid_grant", "resource does not match");
    }

    this.authorizationCodes.delete(key);
    if (!isValidCodeVerifier(request.codeVerifier)
      || !secureEquals(pkceChallenge(request.codeVerifier), stored.codeChallenge)) {
      throw new OAuthRequestError("invalid_grant", "code_verifier does not match the challenge");
    }

    return this.tokens.issue(stored.resource);
  }

  public validateAccessToken(token: string | undefined, resource: string): boolean {
    try {
      return this.tokens.validate(token, normalizeResource(resource));
    } catch {
      return false;
    }
  }
}
