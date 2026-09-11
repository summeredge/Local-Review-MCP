import { createHash } from "node:crypto";
import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppContext, startApp } from "../../src/app.js";
import { OAuthService } from "../../src/auth/oauth.js";
import { OAuthTokenStore } from "../../src/auth/token.js";
import {
  legacyChatgptConnectorStateFile,
  workspaceOAuthStatePaths,
} from "../../src/control-plane/chatgpt-connector.js";
import { defaultTaskContextStorageRoot } from "../../src/context/task.js";

const runningServers: Server[] = [];
const temporaryDirectories: string[] = [];
const TOKEN = "test-auth-token";

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeServer(options: {
  readonly workspace?: string;
  readonly registryPath?: string;
  readonly port?: number;
} = {}): Promise<{
  port: number;
  server: Server;
  workspace: string;
  registryPath: string;
}> {
  const workspace = options.workspace ?? await mkdtemp(join(tmpdir(), "local-review-mcp-auth-"));
  if (options.workspace === undefined) temporaryDirectories.push(workspace);
  const registryPath = options.registryPath ?? join(workspace, "oauth", "clients.json");
  const server = await startApp({
    host: "127.0.0.1",
    port: options.port ?? 0,
    workspace,
    auth: { token: TOKEN },
    remote: { enabled: false, endpoint: "" },
    supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
  }, undefined, { oauthClientRegistryPath: registryPath });
  runningServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return { port: address.port, server, workspace, registryPath };
}

async function stopServer(server: Server): Promise<void> {
  const index = runningServers.indexOf(server);
  if (index !== -1) runningServers.splice(index, 1);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "auth-test", version: "0.1.0" },
    },
  });
}

async function postMcp(
  port: number,
  authorization?: string,
): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  const body = Buffer.from(initializeBody(), "utf8");
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": body.byteLength,
        ...(authorization === undefined ? {} : { authorization }),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        text,
        headers: response.headers,
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function requestText(
  port: number,
  path: string,
  method: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: IncomingHttpHeaders }> {
  const payload = body === undefined ? undefined : Buffer.from(body, "utf8");
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...(payload === undefined ? {} : { "content-length": payload.byteLength }),
        ...headers,
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        text,
        headers: response.headers,
      }));
    });
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function authorizeAndExchange(
  port: number,
  clientId: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const verifier = "v".repeat(43);
  const resource = `http://127.0.0.1:${port}/mcp`;
  const authorization = await requestText(
    port,
    `/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource,
    }).toString()}`,
    "GET",
  );
  const code = new URL(authorization.headers.location ?? redirectUri).searchParams.get("code");
  const response = await requestText(
    port,
    "/oauth/token",
    "POST",
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: code ?? "",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource,
    }).toString(),
    { "content-type": "application/x-www-form-urlencoded" },
  );
  expect(response.status).toBe(200);
  return JSON.parse(response.text) as { access_token: string; refresh_token: string };
}

describe("HTTP Bearer authentication", () => {
  it("rejects missing and incorrect tokens with the same generic response", async () => {
    const { port } = await makeServer();

    const missing = await postMcp(port);
    const wrong = await postMcp(port, "Bearer wrong-token");

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.text).toBe(JSON.stringify({ error: "unauthorized" }));
    expect(wrong.text).toBe(missing.text);
    expect(missing.text).not.toContain(TOKEN);
    expect(missing.headers["www-authenticate"]).toBe(
      `Bearer resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("allows a correctly authenticated MCP request", async () => {
    const { port } = await makeServer();
    await expect(postMcp(port, `Bearer ${TOKEN}`)).resolves.toMatchObject({ status: 200 });
  });

  it("logs only a safe authentication event", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { port } = await makeServer();
      await postMcp(port, `Bearer ${TOKEN}`);
      await postMcp(port, "Bearer wrong-token");

      const logs = warning.mock.calls.flat().join(" ");
      expect(logs).toContain("Auth failed");
      expect(logs).not.toContain(TOKEN);
      expect(logs).not.toContain(`Bearer ${TOKEN}`);
    } finally {
      warning.mockRestore();
    }
  });
});

describe("MCP OAuth compatibility", () => {
  it("keeps OAuth clients and tokens isolated by workspace state root", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-oauth-isolation-"));
    temporaryDirectories.push(root);
    const pathsA = workspaceOAuthStatePaths("workspace-a", root);
    const pathsB = workspaceOAuthStatePaths("workspace-b", root);
    const serviceA = new OAuthService({
      clientRegistryPath: pathsA.clientRegistryPath,
      tokenStorePath: pathsA.tokenStorePath,
    });
    const serviceB = new OAuthService({
      clientRegistryPath: pathsB.clientRegistryPath,
      tokenStorePath: pathsB.tokenStorePath,
    });
    const clientA = serviceA.registerClient({
      client_name: "Workspace A",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    });
    const tokenA = serviceA.tokens.issue("https://a.example/mcp", clientA.client_id);

    expect(pathsA.clientRegistryPath).not.toBe(pathsB.clientRegistryPath);
    expect(serviceB.getClient(clientA.client_id)).toBeUndefined();
    expect(serviceB.validateAccessToken(tokenA.token, "https://a.example/mcp")).toBe(false);
  });

  it("injects the active workspace OAuth paths through the app HTTP construction", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-oauth-app-workspace-"));
    const stateBase = await mkdtemp(join(tmpdir(), "local-review-mcp-oauth-app-state-"));
    temporaryDirectories.push(workspace, stateBase);
    const identity = { id: "workspace-app", name: "Workspace App", path: workspace };
    const appSettings = {
      host: "127.0.0.1" as const,
      port: 0,
      workspace,
      workspaceIdentity: identity,
      workspaces: [identity],
      auth: { token: TOKEN },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    };
    const context = createAppContext(appSettings, {
      ...process.env,
      LOCALAPPDATA: stateBase,
      XDG_STATE_HOME: stateBase,
    });
    const server = await startApp(appSettings, context);
    runningServers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const registration = await requestText(
      address.port,
      "/oauth/register",
      "POST",
      JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirectUri] }),
      { "content-type": "application/json" },
    );
    const client = JSON.parse(registration.text) as { client_id: string };
    await authorizeAndExchange(address.port, client.client_id, redirectUri);

    const paths = workspaceOAuthStatePaths(identity.id, context.storageRoot);
    await expect(readFile(paths.clientRegistryPath, "utf8")).resolves.toContain(client.client_id);
    await expect(readFile(paths.tokenStorePath, "utf8")).resolves.toContain('"kind": "refresh"');
    await expect(readFile(join(context.storageRoot!, "oauth", "clients.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a migrated legacy client_id usable across a runtime restart", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-legacy-oauth-workspace-"));
    const stateBase = await mkdtemp(join(tmpdir(), "local-review-mcp-legacy-oauth-state-"));
    temporaryDirectories.push(workspace, stateBase);
    const identity = { id: "workspace-legacy", name: "Workspace Legacy", path: workspace };
    const appSettings = {
      host: "127.0.0.1" as const,
      port: 0,
      workspace,
      workspaceIdentity: identity,
      workspaces: [identity],
      auth: { token: TOKEN },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    };
    const environment = { ...process.env, LOCALAPPDATA: stateBase, XDG_STATE_HOME: stateBase };
    const storageRoot = defaultTaskContextStorageRoot(environment);
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const legacyClientId = "legacy-client-id";
    // The pre-migration runtime persisted clients and kept tokens in memory, so no tokens.json exists.
    await writeJsonFile(join(storageRoot, "oauth", "clients.json"), {
      version: 1,
      clients: [{
        client_id: legacyClientId,
        client_name: "Local MCP Connector",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "none",
        response_types: ["code"],
        created_at: 1,
      }],
    });
    await writeJsonFile(legacyChatgptConnectorStateFile(storageRoot), {
      schema_version: 1,
      bindings: [{
        workspace_id: identity.id,
        connector_name: "Local MCP Connector",
        verified_mcp_url: "https://legacy.example/mcp",
        pending_mcp_url: null,
        status: "verified",
        last_verified_at: "2026-09-10T03:00:00.000Z",
      }],
    });

    const portOf = (server: Server): number => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("test server has no port");
      return address.port;
    };
    const authorize = (port: number) => requestText(
      port,
      `/oauth/authorize?${new URLSearchParams({
        client_id: legacyClientId,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: pkceChallenge("v".repeat(43)),
        code_challenge_method: "S256",
        resource: `http://127.0.0.1:${port}/mcp`,
      }).toString()}`,
      "GET",
    );

    const firstServer = await startApp(appSettings, createAppContext(appSettings, environment));
    runningServers.push(firstServer);
    const firstAuthorize = await authorize(portOf(firstServer));
    expect(firstAuthorize.text).not.toContain("invalid_client");
    expect(firstAuthorize.status).toBe(302);
    await authorizeAndExchange(portOf(firstServer), legacyClientId, redirectUri);
    await stopServer(firstServer);

    const paths = workspaceOAuthStatePaths(identity.id, storageRoot);
    await expect(readFile(paths.clientRegistryPath, "utf8")).resolves.toContain(legacyClientId);

    const restarted = await startApp(appSettings, createAppContext(appSettings, environment));
    runningServers.push(restarted);
    const restartedAuthorize = await authorize(portOf(restarted));
    expect(restartedAuthorize.text).not.toContain("invalid_client");
    expect(restartedAuthorize.status).toBe(302);
    expect(new URL(restartedAuthorize.headers.location ?? redirectUri).searchParams.get("code")).toBeTruthy();
    await authorizeAndExchange(portOf(restarted), legacyClientId, redirectUri);
  });

  it("stores only hash-backed tokens and handles expiry and deletion", () => {
    const store = new OAuthTokenStore(10);
    const issued = store.issue("https://review.example/mcp", 1_000);

    expect(store.validate(issued.token, "https://review.example/mcp", 1_001)).toBe(true);
    expect(store.validate(issued.token, "https://other.example/mcp", 1_001)).toBe(false);
    expect(store.validate(issued.token, "https://review.example/mcp", 11_000)).toBe(false);

    const second = store.issue("https://review.example/mcp");
    store.delete(second.token);
    expect(store.validate(second.token, "https://review.example/mcp")).toBe(false);

    const expiring = new OAuthTokenStore({ accessTtlSeconds: 10, refreshTtlSeconds: 10 });
    const pair = expiring.issue("https://review.example/mcp", "client-1", 1_000);
    expect(expiring.rotate(pair.refreshToken, "client-1", undefined, 11_000)).toBeNull();
  });

  it("serves protected-resource and authorization-server discovery metadata", async () => {
    const { port } = await makeServer();
    const protectedResource = await requestText(
      port,
      "/.well-known/oauth-protected-resource/mcp",
      "GET",
    );
    const authorizationServer = await requestText(
      port,
      "/.well-known/oauth-authorization-server",
      "GET",
    );
    const protectedResourceAlias = await requestText(
      port,
      "/.well-known/oauth-protected-resource",
      "GET",
    );
    const authorizationServerAlias = await requestText(
      port,
      "/.well-known/oauth-authorization-server/mcp",
      "GET",
    );

    expect(protectedResource.status).toBe(200);
    expect(protectedResourceAlias.status).toBe(200);
    expect(JSON.parse(protectedResource.text)).toEqual({
      resource: `http://127.0.0.1:${port}/mcp`,
      authorization_servers: [`http://127.0.0.1:${port}`],
      bearer_methods_supported: ["header"],
    });
    expect(protectedResourceAlias.text).toBe(protectedResource.text);
    expect(authorizationServer.status).toBe(200);
    expect(authorizationServerAlias.status).toBe(200);
    expect(JSON.parse(authorizationServer.text)).toEqual({
      issuer: `http://127.0.0.1:${port}`,
      authorization_endpoint: `http://127.0.0.1:${port}/oauth/authorize`,
      token_endpoint: `http://127.0.0.1:${port}/oauth/token`,
      registration_endpoint: `http://127.0.0.1:${port}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect(authorizationServerAlias.text).toBe(authorizationServer.text);

    const discovered = await discoverOAuthServerInfo(`http://127.0.0.1:${port}/mcp`);
    expect(discovered.authorizationServerMetadata).toMatchObject({
      issuer: `http://127.0.0.1:${port}`,
      authorization_endpoint: `http://127.0.0.1:${port}/oauth/authorize`,
    });
  });

  it("accepts ChatGPT Connector DCR metadata with refresh-token support", async () => {
    const { port } = await makeServer();
    const registration = await requestText(
      port,
      "/oauth/register",
      "POST",
      JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "openid profile",
        client_uri: "https://chatgpt.com/",
        logo_uri: "https://chatgpt.com/favicon.ico",
        contacts: ["support@example.com"],
        software_id: "chatgpt-connector",
        software_version: "1.0",
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      }),
      { "content-type": "application/json" },
    );
    const client = JSON.parse(registration.text) as {
      client_id: string;
      grant_types: string[];
      client_secret?: string;
    };

    expect(registration.status).toBe(201);
    expect(client.client_id).toEqual(expect.any(String));
    expect(client.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(client.client_secret).toBeUndefined();
  });

  it("accepts fixed and safe dynamic ChatGPT connector redirects only", async () => {
    const { port } = await makeServer();
    const registeredRedirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const registration = await requestText(
      port,
      "/oauth/register",
      "POST",
      JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [registeredRedirectUri],
        token_endpoint_auth_method: "none",
      }),
      { "content-type": "application/json" },
    );
    const client = JSON.parse(registration.text) as { client_id: string };
    expect(registration.status).toBe(201);

    const authorize = (redirectUri: string) => requestText(
      port,
      `/oauth/authorize?${new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: "c".repeat(43),
        code_challenge_method: "S256",
        resource: `http://127.0.0.1:${port}/mcp`,
      }).toString()}`,
      "GET",
    );

    const fixed = await authorize(registeredRedirectUri);
    const dynamic = await authorize("https://chatgpt.com/connector/oauth/test123");
    const evil = await authorize("https://evil.com/connector/oauth/test");
    const queryInjection = await authorize("https://chatgpt.com/connector/oauth/test123?next=https://evil.com");

    expect(fixed.status).toBe(302);
    expect(dynamic.status).toBe(302);
    expect(evil.status).toBe(400);
    expect(queryInjection.status).toBe(400);
    expect(JSON.parse(evil.text)).toMatchObject({ error: "invalid_request" });
    expect(JSON.parse(queryInjection.text)).toMatchObject({ error: "invalid_request" });
  });

  it("persists clients and restores them after a runtime restart", async () => {
    const first = await makeServer();
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const body = JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const [registration, concurrentRegistration] = await Promise.all([
      requestText(first.port, "/oauth/register", "POST", body, { "content-type": "application/json" }),
      requestText(first.port, "/oauth/register", "POST", body, { "content-type": "application/json" }),
    ]);
    const client = JSON.parse(registration.text) as { client_id: string };

    expect(registration.status).toBe(201);
    expect(concurrentRegistration.status).toBe(201);
    const registry = JSON.parse(await readFile(first.registryPath, "utf8")) as {
      version: number;
      clients: Array<Record<string, unknown>>;
    };
    expect(registry.version).toBe(1);
    expect(registry.clients).toHaveLength(2);
    expect(registry.clients[0]).toMatchObject({
      client_id: expect.any(String),
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      created_at: expect.any(Number),
    });

    await stopServer(first.server);
    const second = await makeServer({
      workspace: first.workspace,
      registryPath: first.registryPath,
    });
    const verifier = "v".repeat(43);
    const resource = `http://127.0.0.1:${second.port}/mcp`;
    const authorization = await requestText(
      second.port,
      `/oauth/authorize?${new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        resource,
      }).toString()}`,
      "GET",
    );
    const location = authorization.headers.location;
    expect(authorization.status).toBe(302);
    expect(location).toBeDefined();

    const code = new URL(location ?? redirectUri).searchParams.get("code");
    const token = await requestText(
      second.port,
      "/oauth/token",
      "POST",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: code ?? "",
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    const tokenBody = JSON.parse(token.text) as { access_token: string };
    expect(token.status).toBe(200);
    await expect(postMcp(second.port, `Bearer ${tokenBody.access_token}`))
      .resolves.toMatchObject({ status: 200 });
  });

  it("completes public-client registration, PKCE code exchange, and MCP access", async () => {
    const { port } = await makeServer();
    const redirectUri = "https://client.example/callback";
    const registration = await requestText(
      port,
      "/oauth/register",
      "POST",
      JSON.stringify({
        client_name: "ChatGPT Connector",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
      { "content-type": "application/json" },
    );
    const client = JSON.parse(registration.text) as {
      client_id: string;
      client_secret?: string;
    };

    expect(registration.status).toBe(201);
    expect(client.client_id).toEqual(expect.any(String));
    expect(client.client_secret).toBeUndefined();

    const verifier = "v".repeat(43);
    const resource = `http://127.0.0.1:${port}/mcp`;
    const authorizeParams = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      resource,
      state: "oauth-state",
    });
    const authorization = await requestText(
      port,
      `/oauth/authorize?${authorizeParams.toString()}`,
      "GET",
    );
    const location = authorization.headers.location;
    if (authorization.status !== 302 || typeof location !== "string") {
      throw new Error(`authorization failed: ${authorization.status} ${authorization.text}`);
    }
    const callback = new URL(location);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("oauth-state");
    const code = callback.searchParams.get("code");
    expect(code).toEqual(expect.any(String));

    const token = await requestText(
      port,
      "/oauth/token",
      "POST",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: code ?? "",
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    const tokenBody = JSON.parse(token.text) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };

    expect(token.status).toBe(200);
    expect(tokenBody).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(tokenBody.access_token).toEqual(expect.any(String));
    await expect(postMcp(port, `Bearer ${tokenBody.access_token}`)).resolves.toMatchObject({ status: 200 });

    const replay = await requestText(
      port,
      "/oauth/token",
      "POST",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: code ?? "",
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    expect(replay.status).toBe(400);
    expect(JSON.parse(replay.text)).toMatchObject({ error: "invalid_grant" });
  });

  it("persists access and refresh tokens, rotates refresh tokens, and binds client and resource", async () => {
    const first = await makeServer();
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const registration = await requestText(
      first.port,
      "/oauth/register",
      "POST",
      JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      { "content-type": "application/json" },
    );
    const client = JSON.parse(registration.text) as { client_id: string };
    const original = await authorizeAndExchange(first.port, client.client_id, redirectUri);
    expect(original).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
    });
    const tokenStorePath = join(first.workspace, "oauth", "tokens.json");
    const persisted = await readFile(tokenStorePath, "utf8");
    expect(persisted).not.toContain(original.access_token);
    expect(persisted).not.toContain(original.refresh_token);
    expect(JSON.parse(persisted)).toMatchObject({
      schema_version: 1,
      tokens: expect.arrayContaining([
        expect.objectContaining({
          hash: expect.any(String),
          kind: "access",
          client_id: client.client_id,
          resource: `http://127.0.0.1:${first.port}/mcp`,
          issued_at: expect.any(Number),
          expires_at: expect.any(Number),
          revoked: false,
        }),
        expect.objectContaining({
          hash: expect.any(String),
          kind: "refresh",
          client_id: client.client_id,
          resource: `http://127.0.0.1:${first.port}/mcp`,
          issued_at: expect.any(Number),
          expires_at: expect.any(Number),
          revoked: false,
        }),
      ]),
    });

    const stablePort = first.port;
    await stopServer(first.server);
    const second = await makeServer({
      workspace: first.workspace,
      registryPath: first.registryPath,
      port: stablePort,
    });
    await expect(postMcp(second.port, `Bearer ${original.access_token}`))
      .resolves.toMatchObject({ status: 200 });

    const unknownClient = await requestText(
      second.port,
      "/oauth/token",
      "POST",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "wrong-client",
        refresh_token: original.refresh_token,
      }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    expect(JSON.parse(unknownClient.text)).toMatchObject({ error: "invalid_client" });

    const wrongResource = await requestText(
      second.port,
      "/oauth/token",
      "POST",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: original.refresh_token,
        resource: "https://other.example/mcp",
      }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    expect(JSON.parse(wrongResource.text)).toMatchObject({ error: "invalid_grant" });

    const refreshed = await requestText(
      second.port,
      "/oauth/token",
      "POST",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: original.refresh_token,
        resource: `http://127.0.0.1:${second.port}/mcp`,
      }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    const rotated = JSON.parse(refreshed.text) as { access_token: string; refresh_token: string };
    expect(refreshed.status).toBe(200);
    expect(rotated.access_token).not.toBe(original.access_token);
    expect(rotated.refresh_token).not.toBe(original.refresh_token);
    const afterRotation = JSON.parse(await readFile(tokenStorePath, "utf8")) as {
      tokens: Array<{ hash: string; kind: string; revoked: boolean }>;
    };
    expect(afterRotation.tokens).not.toContainEqual(expect.objectContaining({
      hash: createHash("sha256").update(original.refresh_token, "utf8").digest("hex"),
    }));
    expect(afterRotation.tokens.every((record) => !record.revoked)).toBe(true);
    expect(afterRotation.tokens).toContainEqual(expect.objectContaining({
      kind: "refresh",
      revoked: false,
    }));
    await expect(postMcp(second.port, `Bearer ${rotated.access_token}`))
      .resolves.toMatchObject({ status: 200 });

    const replay = await requestText(
      second.port,
      "/oauth/token",
      "POST",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: original.refresh_token,
      }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    expect(JSON.parse(replay.text)).toMatchObject({ error: "invalid_grant" });

    await stopServer(second.server);
    const third = await makeServer({
      workspace: first.workspace,
      registryPath: first.registryPath,
      port: stablePort,
    });
    const afterRestart = await requestText(
      third.port,
      "/oauth/token",
      "POST",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: rotated.refresh_token,
      }).toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    expect(afterRestart.status).toBe(200);
    expect(JSON.parse(afterRestart.text)).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
    });
  });

  it("rejects non-loopback HTTP redirects and plain PKCE", async () => {
    const { port } = await makeServer();
    const rejectedRegistration = await requestText(
      port,
      "/oauth/register",
      "POST",
      JSON.stringify({ client_name: "bad-client", redirect_uris: ["http://evil.example/callback"] }),
      { "content-type": "application/json" },
    );
    expect(rejectedRegistration.status).toBe(400);

    const registration = await requestText(
      port,
      "/oauth/register",
      "POST",
      JSON.stringify({ client_name: "loopback-client", redirect_uris: ["http://localhost/callback"] }),
      { "content-type": "application/json" },
    );
    const client = JSON.parse(registration.text) as { client_id: string };
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "http://localhost:1234/callback",
      response_type: "code",
      code_challenge: "c".repeat(43),
      code_challenge_method: "plain",
    });
    const authorization = await requestText(
      port,
      "/oauth/authorize",
      "POST",
      params.toString(),
      { "content-type": "application/x-www-form-urlencoded" },
    );
    expect(authorization.status).toBe(302);
    expect(new URL(authorization.headers.location ?? "").searchParams.get("error")).toBe("invalid_request");
  });
});
