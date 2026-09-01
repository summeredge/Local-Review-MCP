import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  OAUTH_AUTHORIZATION_SERVER_PATH,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_PROTECTED_RESOURCE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
  OAuthRequestError,
  OAuthService,
  isValidCodeChallenge,
  redirectUriMatches,
} from "../auth/oauth.js";
import { isAuthenticated } from "../auth/middleware.js";
import {
  APP_VERSION,
  DEFAULT_HOST,
  HEALTH_PATH,
  MCP_PATH,
  type ResolvedSettings,
} from "../config/settings.js";
import type { TunnelProvider, TunnelStatus } from "../tunnel/types.js";
import { createMcpServer, type McpRuntimeContext } from "./server.js";

export const MAX_MCP_REQUEST_BYTES = 1024 * 1024;

type HttpRuntimeContext = McpRuntimeContext & {
  readonly tunnel?: Pick<TunnelProvider, "status">;
};

class RequestBodyTooLargeError extends Error {
  public constructor() {
    super("MCP request body exceeds the maximum allowed size.");
    this.name = "RequestBodyTooLargeError";
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const contentLength = request.headers["content-length"];
  if (typeof contentLength === "string"
    && Number.isFinite(Number(contentLength))
    && Number(contentLength) > MAX_MCP_REQUEST_BYTES) {
    request.resume();
    throw new RequestBodyTooLargeError();
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_MCP_REQUEST_BYTES) {
      request.resume();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function parseBody(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  return body === undefined ? undefined : JSON.parse(body.toString("utf8"));
}

async function parseFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  const body = await readBody(request);
  return new URLSearchParams(body?.toString("utf8") ?? "");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function sendUnauthorized(response: ServerResponse, resourceMetadataUrl?: string): void {
  response.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": resourceMetadataUrl === undefined
      ? "Bearer"
      : `Bearer resource_metadata="${resourceMetadataUrl}"`,
  });
  response.end(JSON.stringify({ error: "unauthorized" }));
}

async function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: HttpRuntimeContext,
): Promise<void> {
  if (request.method !== "GET") {
    request.resume();
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  let tunnel: TunnelStatus = { state: "LOCAL_ONLY" };
  try {
    if (context.tunnel !== undefined) tunnel = await context.tunnel.status();
  } catch {
    tunnel = { state: "REMOTE_ERROR" };
  }
  sendJson(response, 200, {
    status: "ok",
    workspace: context.workspace.workspaceId,
    version: APP_VERSION,
    remote_status: tunnel.state,
    endpoint_status: tunnel.endpoint === undefined
      ? tunnel.state === "REMOTE_ERROR"
        ? "error"
        : tunnel.state === "REMOTE_STARTING"
          ? "starting"
          : "stopped"
      : "ready",
    ...(tunnel.endpoint === undefined ? {} : { endpoint: tunnel.endpoint }),
  });
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: McpRuntimeContext,
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  let body: unknown;
  try {
    body = await parseBody(request);
  } catch (error: unknown) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, { error: "payload_too_large" });
      return;
    }
    sendJson(response, 400, { error: "invalid_json_body" });
    return;
  }
  if (body === undefined || typeof body !== "object" || body === null) {
    sendJson(response, 400, { error: "invalid_json_body" });
    return;
  }

  const server = createMcpServer(context);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => void transport.close());
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}

interface OAuthUrls {
  readonly issuer: URL;
  readonly resource: URL;
  readonly protectedResourceMetadata: URL;
  readonly authorizationEndpoint: URL;
  readonly tokenEndpoint: URL;
  readonly registrationEndpoint: URL;
}

function requestOrigin(settings: ResolvedSettings, request: IncomingMessage): URL {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol = typeof forwardedProtocol === "string"
    ? forwardedProtocol.split(",", 1)[0]?.trim().toLowerCase()
    : "http";
  const scheme = protocol === "https" ? "https" : "http";
  const host = request.headers.host ?? `${settings.host}:${settings.port}`;
  try {
    return new URL(`${scheme}://${host}`);
  } catch {
    return new URL(`http://${DEFAULT_HOST}:${settings.port}`);
  }
}

async function oauthUrls(
  settings: ResolvedSettings,
  context: HttpRuntimeContext,
  request: IncomingMessage,
): Promise<OAuthUrls> {
  let configuredEndpoint = settings.remote.endpoint?.trim();
  if (configuredEndpoint === "" || configuredEndpoint === undefined) {
    try {
      configuredEndpoint = (await context.tunnel?.status())?.endpoint;
    } catch {
      configuredEndpoint = undefined;
    }
  }

  let base: URL;
  try {
    base = configuredEndpoint === undefined || configuredEndpoint === ""
      ? requestOrigin(settings, request)
      : new URL(configuredEndpoint);
  } catch {
    base = requestOrigin(settings, request);
  }

  const issuer = new URL(base.origin);
  const resource = new URL(MCP_PATH, issuer);
  return {
    issuer,
    resource,
    protectedResourceMetadata: new URL(`${OAUTH_PROTECTED_RESOURCE_PATH}${MCP_PATH}`, issuer),
    authorizationEndpoint: new URL(OAUTH_AUTHORIZE_PATH, issuer),
    tokenEndpoint: new URL(OAUTH_TOKEN_PATH, issuer),
    registrationEndpoint: new URL(OAUTH_REGISTER_PATH, issuer),
  };
}

function oauthMetadata(urls: OAuthUrls): Record<string, unknown> {
  return {
    issuer: urls.issuer.origin,
    authorization_endpoint: urls.authorizationEndpoint.href,
    token_endpoint: urls.tokenEndpoint.href,
    registration_endpoint: urls.registrationEndpoint.href,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function oauthCorsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  };
}

function sendOAuthJson(response: ServerResponse, statusCode: number, body: unknown): void {
  sendJson(response, statusCode, body, oauthCorsHeaders());
}

function sendOAuthError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  description: string,
): void {
  sendOAuthJson(response, statusCode, { error: code, error_description: description });
}

function redirectResponse(
  response: ServerResponse,
  redirectUri: string,
  values: Record<string, string | undefined>,
): void {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) target.searchParams.set(key, value);
  }
  response.writeHead(302, {
    location: target.href,
    "cache-control": "no-store",
  });
  response.end();
}

function sendAuthorizationError(
  response: ServerResponse,
  redirectUri: string,
  state: string | undefined,
  code: string,
  description: string,
): void {
  redirectResponse(response, redirectUri, {
    error: code,
    error_description: description,
    state,
  });
}

function oauthPathMatches(path: string, expected: string): boolean {
  return path === expected || path === `${expected}/`;
}

async function handleOAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  urls: OAuthUrls,
  oauth: OAuthService,
): Promise<boolean> {
  const protectedResourcePath = `${OAUTH_PROTECTED_RESOURCE_PATH}${MCP_PATH}`;
  if (path === OAUTH_PROTECTED_RESOURCE_PATH || path === protectedResourcePath) {
    if (request.method !== "GET") {
      request.resume();
      sendOAuthJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    sendOAuthJson(response, 200, {
      resource: urls.resource.href,
      authorization_servers: [urls.issuer.origin],
      bearer_methods_supported: ["header"],
    });
    return true;
  }

  if (path === OAUTH_AUTHORIZATION_SERVER_PATH || path === `${OAUTH_AUTHORIZATION_SERVER_PATH}/mcp`) {
    if (request.method !== "GET") {
      request.resume();
      sendOAuthJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    sendOAuthJson(response, 200, oauthMetadata(urls));
    return true;
  }

  if (oauthPathMatches(path, OAUTH_REGISTER_PATH)) {
    if (request.method !== "POST") {
      request.resume();
      sendOAuthJson(response, 405, { error: "method_not_allowed" });
      return true;
    }
    let body: unknown;
    try {
      body = await parseBody(request);
    } catch (error: unknown) {
      sendOAuthError(
        response,
        error instanceof RequestBodyTooLargeError ? 413 : 400,
        "invalid_client_metadata",
        error instanceof RequestBodyTooLargeError ? "registration body is too large" : "registration body is invalid",
      );
      return true;
    }
    try {
      sendOAuthJson(response, 201, oauth.registerClient(body));
    } catch (error: unknown) {
      if (error instanceof OAuthRequestError) {
        sendOAuthError(response, 400, error.code, error.message);
      } else {
        sendOAuthError(response, 500, "server_error", "OAuth server error");
      }
    }
    return true;
  }

  if (oauthPathMatches(path, OAUTH_AUTHORIZE_PATH)) {
    if (request.method !== "GET" && request.method !== "POST") {
      request.resume();
      sendOAuthJson(response, 405, { error: "method_not_allowed" });
      return true;
    }

    let params: URLSearchParams;
    try {
      params = request.method === "GET"
        ? new URL(request.url ?? "/", urls.issuer).searchParams
        : await parseFormBody(request);
    } catch (error: unknown) {
      sendOAuthError(
        response,
        error instanceof RequestBodyTooLargeError ? 413 : 400,
        "invalid_request",
        error instanceof RequestBodyTooLargeError ? "authorization request is too large" : "authorization request is invalid",
      );
      return true;
    }

    const clientId = params.get("client_id");
    const client = clientId === null ? undefined : oauth.getClient(clientId);
    if (clientId === null || client === undefined) {
      sendOAuthError(response, 400, "invalid_client", "Invalid client_id");
      return true;
    }

    const requestedRedirectUri = params.get("redirect_uri");
    const redirectUri = requestedRedirectUri
      ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (redirectUri === undefined
      || !client.redirect_uris.some((registered) => redirectUriMatches(redirectUri, registered))) {
      sendOAuthError(response, 400, "invalid_request", "Unregistered redirect_uri");
      return true;
    }

    const state = params.get("state") ?? undefined;
    const fail = (code: string, description: string): void => {
      sendAuthorizationError(response, redirectUri, state, code, description);
    };
    if (params.get("response_type") !== "code") {
      fail("unsupported_response_type", "Only response_type=code is supported");
      return true;
    }
    const codeChallenge = params.get("code_challenge");
    if (params.get("code_challenge_method") !== "S256"
      || codeChallenge === null
      || !isValidCodeChallenge(codeChallenge)) {
      fail("invalid_request", "PKCE S256 code_challenge is required");
      return true;
    }

    let resource = urls.resource.href;
    const requestedResource = params.get("resource");
    if (requestedResource !== null) {
      try {
        resource = new URL(requestedResource).href;
      } catch {
        fail("invalid_target", "resource must be an absolute URL");
        return true;
      }
      if (resource !== urls.resource.href) {
        fail("invalid_target", "resource does not identify this MCP server");
        return true;
      }
    }

    // ponytail: single-owner auto-approval; add consent/user policy before multi-user exposure.
    try {
      const code = oauth.createAuthorizationCode({
        clientId,
        redirectUri,
        codeChallenge,
        resource,
      });
      redirectResponse(response, redirectUri, { code, state });
    } catch (error: unknown) {
      if (error instanceof OAuthRequestError) {
        fail(error.code, error.message);
      } else {
        fail("server_error", "OAuth server error");
      }
    }
    return true;
  }

  if (oauthPathMatches(path, OAUTH_TOKEN_PATH)) {
    if (request.method !== "POST") {
      request.resume();
      sendOAuthJson(response, 405, { error: "method_not_allowed" });
      return true;
    }

    let params: URLSearchParams;
    try {
      params = await parseFormBody(request);
    } catch (error: unknown) {
      sendOAuthError(
        response,
        error instanceof RequestBodyTooLargeError ? 413 : 400,
        "invalid_request",
        error instanceof RequestBodyTooLargeError ? "token request is too large" : "token request is invalid",
      );
      return true;
    }

    if (params.get("grant_type") !== "authorization_code") {
      sendOAuthError(response, 400, "unsupported_grant_type", "Only authorization_code is supported");
      return true;
    }
    const clientId = params.get("client_id");
    const code = params.get("code");
    const codeVerifier = params.get("code_verifier");
    if (clientId === null || code === null || codeVerifier === null) {
      sendOAuthError(response, 400, "invalid_request", "client_id, code, and code_verifier are required");
      return true;
    }
    const client = oauth.getClient(clientId);
    if (client === undefined) {
      sendOAuthError(response, 400, "invalid_client", "Invalid client_id");
      return true;
    }

    try {
      const token = oauth.exchangeAuthorizationCode({
        clientId: client.client_id,
        code,
        codeVerifier,
        ...(params.get("redirect_uri") === null ? {} : { redirectUri: params.get("redirect_uri") ?? undefined }),
        ...(params.get("resource") === null ? {} : { resource: params.get("resource") ?? undefined }),
      });
      sendOAuthJson(response, 200, {
        access_token: token.token,
        token_type: "Bearer",
        expires_in: token.expiresIn,
      });
    } catch (error: unknown) {
      if (error instanceof OAuthRequestError) {
        sendOAuthError(response, 400, error.code, error.message);
      } else {
        sendOAuthError(response, 500, "server_error", "OAuth server error");
      }
    }
    return true;
  }

  return false;
}

export function createHttpServer(settings: ResolvedSettings, context: HttpRuntimeContext): Server {
  const oauth = new OAuthService();
  return createServer((request, response) => {
    void (async () => {
      const path = request.url === undefined
        ? "/"
        : request.url.split("?", 1)[0] ?? "/";

      if (path === HEALTH_PATH) {
        if (!isAuthenticated(request, settings.auth.token)) {
          request.resume();
          console.warn("Auth failed");
          sendUnauthorized(response);
          return;
        }
        await handleHealthRequest(request, response, context);
        return;
      }

      if (path === MCP_PATH) {
        if (!isAuthenticated(request, settings.auth.token)) {
          const urls = await oauthUrls(settings, context, request);
          if (!isAuthenticated(request, settings.auth.token, oauth.tokens, urls.resource.href)) {
            request.resume();
            console.warn("Auth failed");
            sendUnauthorized(response, urls.protectedResourceMetadata.href);
            return;
          }
        }
        await handleMcpRequest(request, response, context);
        return;
      }

      if (path.startsWith(OAUTH_PROTECTED_RESOURCE_PATH)
        || path.startsWith(OAUTH_AUTHORIZATION_SERVER_PATH)
        || path.startsWith("/oauth/")) {
        const urls = await oauthUrls(settings, context, request);
        if (await handleOAuthRequest(request, response, path, urls, oauth)) return;
      }

      request.resume();
      sendJson(response, 404, { error: "not_found" });
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(response, 500, { error: "internal_server_error" });
    });
  });
}

function assertLoopbackHost(settings: ResolvedSettings): void {
  if (settings.host !== DEFAULT_HOST) {
    throw new Error(
      `Local Review MCP refuses to bind to "${String(settings.host)}"; `
      + `only "${DEFAULT_HOST}" is allowed.`,
    );
  }
}

export async function checkPort(settings: ResolvedSettings): Promise<void> {
  assertLoopbackHost(settings);
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      probe.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      probe.removeListener("error", onError);
      probe.close((closeError) => closeError ? reject(closeError) : resolve());
    };
    probe.once("error", onError);
    probe.once("listening", onListening);
    probe.listen(settings.port, settings.host);
  });
}

export async function startHttpServer(
  settings: ResolvedSettings,
  context: HttpRuntimeContext,
): Promise<Server> {
  assertLoopbackHost(settings);
  await checkPort(settings);
  const server = createHttpServer(settings, context);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    assertLoopbackHost(settings);
    server.listen(settings.port, settings.host);
  });
  return server;
}

export function isPortInUse(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}
