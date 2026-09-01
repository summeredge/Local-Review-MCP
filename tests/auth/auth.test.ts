import { createHash } from "node:crypto";
import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp } from "../../src/app.js";
import { OAuthTokenStore } from "../../src/auth/token.js";

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

async function makeServer(): Promise<{ port: number; server: Server }> {
  const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-auth-"));
  temporaryDirectories.push(workspace);
  const server = await startApp({
    host: "127.0.0.1",
    port: 0,
    workspace,
    auth: { token: TOKEN },
    remote: { enabled: false, endpoint: "" },
    supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
  });
  runningServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return { port: address.port, server };
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
  it("stores only hash-backed tokens and handles expiry and deletion", () => {
    const store = new OAuthTokenStore(10);
    const issued = store.issue("https://review.example/mcp", 1_000);

    expect(store.validate(issued.token, "https://review.example/mcp", 1_001)).toBe(true);
    expect(store.validate(issued.token, "https://other.example/mcp", 1_001)).toBe(false);
    expect(store.validate(issued.token, "https://review.example/mcp", 11_000)).toBe(false);

    const second = store.issue("https://review.example/mcp");
    store.delete(second.token);
    expect(store.validate(second.token, "https://review.example/mcp")).toBe(false);
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
      grant_types_supported: ["authorization_code"],
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
