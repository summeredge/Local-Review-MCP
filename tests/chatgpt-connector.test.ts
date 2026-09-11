import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSettings } from "../src/config/settings.js";
import { OAuthTokenStore } from "../src/auth/token.js";
import {
  CONNECTOR_EVIDENCE_TTL_MS,
  ChatGPTConnectorStore,
  chatgptConnectorStateFile,
  confirmChatGPTConnector,
  connectorAction,
  diagnoseChatGPTConnector,
  legacyChatgptConnectorStateFile,
  mcpUrlFromPublic,
  migrateLegacyOAuthState,
  normalizePublicUrl,
  parseConnectorConfirmArgs,
  type WorkspaceOAuthState,
  workspaceOAuthStatePaths,
} from "../src/control-plane/chatgpt-connector.js";
import { createHttpServer } from "../src/mcp/http.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const temporaryDirectories: string[] = [];
const clients: Client[] = [];
const servers: Server[] = [];
const NOW = Date.parse("2026-09-10T04:00:00.000Z");
const CURRENT_URL = "https://host.example/mcp";

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return address.port;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-connector-"));
  temporaryDirectories.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function settings(endpoint = "https://HOST.example/mcp"): ResolvedSettings {
  const identity = { id: "workspace-1", name: "Workspace One", path: "C:\\workspace" };
  return {
    host: "127.0.0.1",
    port: 12080,
    workspace: identity.path,
    workspaceIdentity: identity,
    workspaces: [identity],
    auth: { token: "AUTH_SENTINEL" },
    remote: {
      enabled: true,
      provider: "cloudflare",
      endpoint,
      tunnelName: "review-tunnel",
    },
    supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
  };
}

function healthyOAuthFetch(options: {
  refresh?: boolean;
  challenge?: string | null;
  protected?: Record<string, unknown>;
  authorization?: Record<string, unknown>;
} = {}): typeof fetch {
  const withOverrides = (
    base: Record<string, unknown>,
    overrides: Record<string, unknown> | undefined,
  ): Record<string, unknown> => {
    const merged = { ...base, ...overrides };
    // `null` overrides drop the field so a case can model missing metadata.
    for (const [key, value] of Object.entries(overrides ?? {})) if (value === null) delete merged[key];
    return merged;
  };
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          ...(options.challenge === null
            ? { "www-authenticate": "Bearer" }
            : {
                "www-authenticate": options.challenge
                  ?? "Bearer resource_metadata=\"https://host.example/.well-known/oauth-protected-resource/mcp\"",
              }),
        },
      });
    }
    if (url.includes("oauth-protected-resource")) {
      return Response.json(withOverrides({
        resource: CURRENT_URL,
        authorization_servers: ["https://host.example"],
      }, options.protected));
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return Response.json(withOverrides({
        issuer: "https://host.example",
        authorization_endpoint: "https://host.example/oauth/authorize",
        token_endpoint: "https://host.example/oauth/token",
        registration_endpoint: "https://host.example/oauth/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: options.refresh === false
          ? ["authorization_code"]
          : ["authorization_code", "refresh_token"],
      }, options.authorization));
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

async function prepare(store: ChatGPTConnectorStore, url = CURRENT_URL): Promise<void> {
  await store.prepare({ workspaceName: "Workspace One", currentMcpUrl: url });
}

async function evidence(
  store: ChatGPTConnectorStore,
  requestId: string,
  patch: Partial<Parameters<ChatGPTConnectorStore["recordEvidence"]>[0]> = {},
): Promise<void> {
  await store.recordEvidence({
    request_id: requestId,
    tool_name: "workspace_info",
    workspace_id: "workspace-1",
    mcp_resource: CURRENT_URL,
    authentication: "oauth",
    success: true,
    completed_at: new Date(NOW).toISOString(),
    ...patch,
  });
}

function verifiedBinding(workspaceId = "workspace-1", resource = CURRENT_URL) {
  return {
    workspace_id: workspaceId,
    connector_name: `Local Review MCP · ${workspaceId}`,
    verified_mcp_url: resource,
    pending_mcp_url: null,
    status: "verified",
    last_verified_at: "2026-09-10T03:00:00.000Z",
  } as const;
}

const LEGACY_CLIENT_ID = "legacy-client-id";

function legacyClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: LEGACY_CLIENT_ID,
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    grant_types: ["authorization_code"],
    token_endpoint_auth_method: "none",
    response_types: ["code"],
    created_at: 1,
    ...overrides,
  };
}

function legacyAccessToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: "a".repeat(64),
    kind: "access",
    client_id: LEGACY_CLIENT_ID,
    resource: CURRENT_URL,
    issued_at: NOW - 1_000,
    expires_at: NOW + 60_000,
    revoked: false,
    ...overrides,
  };
}

async function writeLegacyOAuthState(
  root: string,
  options: { readonly clients?: readonly unknown[]; readonly tokens?: unknown } = {},
): Promise<void> {
  await writeJson(legacyChatgptConnectorStateFile(root), {
    schema_version: 1,
    bindings: [verifiedBinding()],
  });
  await writeLegacyClients(root, options.clients);
  if (options.tokens !== undefined) {
    await writeJson(join(root, "oauth", "tokens.json"), options.tokens);
  }
}

async function writeLegacyClients(root: string, clients?: readonly unknown[]): Promise<void> {
  await writeJson(join(root, "oauth", "clients.json"), {
    version: 1,
    clients: clients ?? [legacyClient()],
  });
}

function upgradeWith(root: string, singleWorkspace: boolean): Promise<WorkspaceOAuthState> {
  return migrateLegacyOAuthState({
    workspaceId: "workspace-1",
    storageRoot: root,
    singleWorkspace,
    now: NOW,
  });
}

function upgrade(root: string): Promise<WorkspaceOAuthState> {
  return upgradeWith(root, true);
}

async function scopedClientIds(path: string): Promise<string[]> {
  const registry = JSON.parse(await readFile(path, "utf8")) as {
    clients: readonly { client_id: string }[];
  };
  return registry.clients.map((client) => client.client_id);
}

async function scopedTokenHashes(path: string): Promise<string[]> {
  const state = JSON.parse(await readFile(path, "utf8")) as {
    tokens: readonly { hash: string }[];
  };
  return state.tokens.map((token) => token.hash);
}

describe("ChatGPT connector decisions and scoped state", () => {
  it("reuses the C2C URL normalization and create/none/update rules", () => {
    expect(connectorAction(null, "https://host/mcp")).toBe("create");
    expect(connectorAction("https://HOST/mcp", "https://host/mcp/")).toBe("none");
    expect(connectorAction("https://old/mcp", "https://new/mcp")).toBe("update");
    expect(mcpUrlFromPublic("https://HOST/mcp/")).toBe("https://host/mcp");
    expect(mcpUrlFromPublic("https://host")).toBe("https://host/mcp");
    expect(normalizePublicUrl("https://HOST/mcp/")).toBe("https://host/mcp");
  });

  it("isolates parallel workspace writes and keeps a stable connector name", async () => {
    const root = await temporaryRoot();
    const a = new ChatGPTConnectorStore("workspace-a", root);
    const b = new ChatGPTConnectorStore("workspace-b", root);
    await Promise.all([
      a.prepare({ workspaceName: "Workspace A", currentMcpUrl: "https://a.example/mcp" }),
      b.prepare({ workspaceName: "Workspace B", currentMcpUrl: "https://b.example/mcp" }),
    ]);
    await a.prepare({ workspaceName: "Renamed A", currentMcpUrl: "https://a.example/mcp" });

    await expect(a.read()).resolves.toMatchObject({
      connector_name: "Local Review MCP · Workspace A",
      pending_mcp_url: "https://a.example/mcp",
    });
    await expect(b.read()).resolves.toMatchObject({
      connector_name: "Local Review MCP · Workspace B",
      pending_mcp_url: "https://b.example/mcp",
    });
    expect(chatgptConnectorStateFile("workspace-a", root))
      .not.toBe(chatgptConnectorStateFile("workspace-b", root));
    expect(chatgptConnectorStateFile("CON", root)).toContain(`${join("workspaces", "ws-CON")}`);
    expect(() => chatgptConnectorStateFile("../outside", root)).toThrow();
  });

  it("rejects scoped state copied from another workspace", async () => {
    const root = await temporaryRoot();
    const source = new ChatGPTConnectorStore("workspace-a", root);
    await source.prepare({ workspaceName: "Workspace A", currentMcpUrl: "https://a.example/mcp" });
    const targetFile = chatgptConnectorStateFile("workspace-b", root);
    await mkdir(dirname(targetFile), { recursive: true });
    await writeFile(targetFile, await readFile(chatgptConnectorStateFile("workspace-a", root), "utf8"));

    await expect(new ChatGPTConnectorStore("workspace-b", root).read())
      .rejects.toThrow("ChatGPT connector state is invalid");
  });

  it("keeps the old verified URL through interrupted repair and verifies only from evidence", async () => {
    const root = await temporaryRoot();
    const first = new ChatGPTConnectorStore("workspace-1", root);
    await prepare(first, "https://old.example/mcp");
    await evidence(first, "request-old", { mcp_resource: "https://old.example/mcp" });
    await first.confirm("request-old", "https://old.example/mcp", NOW);

    await prepare(first, "https://new.example/mcp");
    await expect(new ChatGPTConnectorStore("workspace-1", root).read()).resolves.toMatchObject({
      verified_mcp_url: "https://old.example/mcp",
      pending_mcp_url: "https://new.example/mcp",
      status: "repair_required",
    });
    await expect(new ChatGPTConnectorStore("workspace-1", root).prepare({
      workspaceName: "Renamed",
      currentMcpUrl: "https://new.example/mcp",
    })).resolves.toMatchObject({ action: "update" });
  });
});

describe("workspace_info verification evidence", () => {
  it("records a successful OAuth-authenticated workspace_info call before confirmation", async () => {
    const storageRoot = await temporaryRoot();
    const workspace = await temporaryRoot();
    const identity = { id: "workspace-1", name: "Workspace One", path: workspace };
    const current = { ...settings(), workspace, workspaceIdentity: identity, workspaces: [identity] };
    const store = new ChatGPTConnectorStore(identity.id, storageRoot);
    await prepare(store);
    const oauthPaths = workspaceOAuthStatePaths(identity.id, storageRoot);
    const issued = new OAuthTokenStore({ path: oauthPaths.tokenStorePath }).issue(CURRENT_URL, "client-1");
    const server = createHttpServer(current, {
      registry: new WorkspaceRegistry([identity]),
      connectorEvidence: store,
    }, {
      oauthClientRegistryPath: oauthPaths.clientRegistryPath,
      oauthTokenStorePath: oauthPaths.tokenStorePath,
    });
    servers.push(server);
    const port = await listen(server);
    const client = new Client({ name: "connector-evidence-test", version: "0.1.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: {
        authorization: `Bearer ${issued.token}`,
        "x-request-id": "connector-proof-1",
      } } },
    ));

    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      request_id: "connector-proof-1",
      workspace_id: identity.id,
      workspace_name: identity.name,
    });
    await expect(confirmChatGPTConnector(current, "connector-proof-1", storageRoot))
      .resolves.toMatchObject({ status: "verified", verified_mcp_url: CURRENT_URL });
  });

  it("rejects missing, wrong-tool, failed, wrong-workspace, old-resource, expired, and static evidence", async () => {
    const root = await temporaryRoot();
    const store = new ChatGPTConnectorStore("workspace-1", root);
    await prepare(store);
    await expect(store.confirm("missing", CURRENT_URL, NOW)).rejects.toThrow("not found");

    const cases = [
      ["ordinary", { tool_name: "read_file" }, "not for workspace_info"],
      ["failed", { success: false }, "not successful"],
      ["old", { mcp_resource: "https://old.example/mcp" }, "current MCP resource"],
      ["expired", {
        completed_at: new Date(NOW - CONNECTOR_EVIDENCE_TTL_MS - 1).toISOString(),
      }, "expired"],
      ["static", { authentication: "static" as const }, "not OAuth-authenticated"],
    ] as const;
    for (const [requestId, patch, message] of cases) {
      await evidence(store, requestId, patch);
      await expect(store.confirm(requestId, CURRENT_URL, NOW)).rejects.toThrow(message);
    }
    await expect(evidence(store, "other", { workspace_id: "workspace-2" }))
      .rejects.toThrow("another workspace");
  });

  it("consumes successful current OAuth workspace_info evidence and survives restart", async () => {
    const root = await temporaryRoot();
    const store = new ChatGPTConnectorStore("workspace-1", root);
    await prepare(store);
    await evidence(store, "request-current");
    await expect(store.confirm("request-current", CURRENT_URL, NOW)).resolves.toMatchObject({
      verified_mcp_url: CURRENT_URL,
      pending_mcp_url: null,
      status: "verified",
      last_verified_at: new Date(NOW).toISOString(),
    });
    await expect(store.confirm("request-current", CURRENT_URL, NOW + 1))
      .rejects.toThrow("already consumed");
    await expect(new ChatGPTConnectorStore("workspace-1", root).prepare({
      workspaceName: "Renamed Workspace",
      currentMcpUrl: "https://HOST.example/mcp/",
    })).resolves.toMatchObject({ action: "none", binding: { status: "verified" } });
  });

  it("does not accept caller-supplied workspace and URL without durable evidence", async () => {
    const root = await temporaryRoot();
    const current = settings();
    await diagnoseChatGPTConnector(current, { storageRoot: root, fetch: healthyOAuthFetch() });
    await expect(confirmChatGPTConnector(current, "caller-claim", root)).rejects.toThrow("not found");
    expect(() => parseConnectorConfirmArgs([
      "--config", "settings.json",
      "--workspace-id", "workspace-1",
      "--mcp-url", CURRENT_URL,
    ])).toThrow("unknown argument: --workspace-id");
    expect(parseConnectorConfirmArgs([
      "--config", "settings.json",
      "--request-id", "request-current",
    ])).toEqual({ settingsArgs: ["--config", "settings.json"], requestId: "request-current" });
  });
});

describe("connector binding adoption", () => {
  it("adopts an existing connector name once the evidence gate passes", async () => {
    const root = await temporaryRoot();
    const store = new ChatGPTConnectorStore("workspace-1", root);
    await prepare(store);
    await evidence(store, "request-adopt");
    await expect(store.confirm("request-adopt", CURRENT_URL, NOW, "  Local MCP Connector  "))
      .resolves.toMatchObject({
        connector_name: "Local MCP Connector",
        status: "verified",
        verified_mcp_url: CURRENT_URL,
        pending_mcp_url: null,
        last_verified_at: new Date(NOW).toISOString(),
      });
    await expect(new ChatGPTConnectorStore("workspace-1", root).read()).resolves.toMatchObject({
      connector_name: "Local MCP Connector",
      status: "verified",
    });
    await expect(store.confirm("request-adopt", CURRENT_URL, NOW, "Local MCP Connector"))
      .rejects.toThrow("already consumed");

    await evidence(store, "request-cli", { completed_at: new Date().toISOString() });
    await expect(confirmChatGPTConnector(settings(), "request-cli", root, "Local MCP Connector"))
      .resolves.toMatchObject({ connector_name: "Local MCP Connector", status: "verified" });
  });

  it("adopts a name while repairing a changed endpoint", async () => {
    const root = await temporaryRoot();
    const store = new ChatGPTConnectorStore("workspace-1", root);
    await prepare(store);
    await evidence(store, "request-first");
    await store.confirm("request-first", CURRENT_URL, NOW);

    await prepare(store, "https://new.example/mcp");
    await expect(store.read()).resolves.toMatchObject({ status: "repair_required" });
    await evidence(store, "request-repair", { mcp_resource: "https://new.example/mcp" });
    await expect(store.confirm("request-repair", "https://new.example/mcp", NOW, "Local MCP Connector"))
      .resolves.toMatchObject({
        connector_name: "Local MCP Connector",
        status: "verified",
        verified_mcp_url: "https://new.example/mcp",
        pending_mcp_url: null,
      });
  });

  it("keeps the generated name when no connector name is supplied", async () => {
    const root = await temporaryRoot();
    const store = new ChatGPTConnectorStore("workspace-1", root);
    await prepare(store);
    await evidence(store, "request-compat");
    await expect(store.confirm("request-compat", CURRENT_URL, NOW)).resolves.toMatchObject({
      connector_name: "Local Review MCP · Workspace One",
      status: "verified",
    });
  });

  it("never adopts a name when the evidence gate fails", async () => {
    const root = await temporaryRoot();
    const store = new ChatGPTConnectorStore("workspace-1", root);
    await prepare(store);

    await expect(store.confirm("missing", CURRENT_URL, NOW, "Local MCP Connector"))
      .rejects.toThrow("not found");
    const cases = [
      ["ordinary", { tool_name: "read_file" }, "not for workspace_info"],
      ["failed", { success: false }, "not successful"],
      ["old", { mcp_resource: "https://old.example/mcp" }, "current MCP resource"],
      ["expired", {
        completed_at: new Date(NOW - CONNECTOR_EVIDENCE_TTL_MS - 1).toISOString(),
      }, "expired"],
      ["static", { authentication: "static" as const }, "not OAuth-authenticated"],
    ] as const;
    for (const [requestId, patch, message] of cases) {
      await evidence(store, requestId, patch);
      await expect(store.confirm(requestId, CURRENT_URL, NOW, "Local MCP Connector"))
        .rejects.toThrow(message);
    }
    await evidence(store, "wrong-endpoint");
    await expect(store.confirm("wrong-endpoint", "https://other.example/mcp", NOW, "Local MCP Connector"))
      .rejects.toThrow("does not match the current MCP resource");
    await evidence(store, "other-endpoint", { mcp_resource: "https://other.example/mcp" });
    await expect(store.confirm("other-endpoint", "https://other.example/mcp", NOW, "Local MCP Connector"))
      .rejects.toThrow("pending connector binding");
    await expect(evidence(store, "other-workspace", { workspace_id: "workspace-2" }))
      .rejects.toThrow("another workspace");

    await expect(new ChatGPTConnectorStore("workspace-1", root).read()).resolves.toMatchObject({
      connector_name: "Local Review MCP · Workspace One",
      status: "unconfigured",
      pending_mcp_url: CURRENT_URL,
    });
    // A rejected attempt must not consume evidence either.
    await expect(store.confirm("wrong-endpoint", CURRENT_URL, NOW, "Local MCP Connector"))
      .resolves.toMatchObject({ connector_name: "Local MCP Connector", status: "verified" });
  });

  it("refuses to rename a binding that is already verified", async () => {
    const root = await temporaryRoot();
    const store = new ChatGPTConnectorStore("workspace-1", root);
    await prepare(store);
    await evidence(store, "request-first");
    await store.confirm("request-first", CURRENT_URL, NOW);
    await evidence(store, "request-second");

    await expect(store.confirm("request-second", CURRENT_URL, NOW, "Local MCP Connector"))
      .rejects.toThrow("cannot be renamed");
    await expect(store.read()).resolves.toMatchObject({
      connector_name: "Local Review MCP · Workspace One",
      status: "verified",
    });
    await expect(store.confirm("request-second", CURRENT_URL, NOW + 1)).resolves.toMatchObject({
      connector_name: "Local Review MCP · Workspace One",
    });
  });

  it("treats an identical name on a verified binding as idempotent", async () => {
    const root = await temporaryRoot();
    const store = new ChatGPTConnectorStore("workspace-1", root);
    await prepare(store);
    await evidence(store, "request-same");
    await expect(store.confirm("request-same", CURRENT_URL, NOW, "Local Review MCP · Workspace One"))
      .resolves.toMatchObject({
        connector_name: "Local Review MCP · Workspace One",
        status: "verified",
      });
  });

  it("validates --connector-name without changing the existing CLI shape", () => {
    expect(parseConnectorConfirmArgs([
      "--config", "settings.json",
      "--request-id", "request-current",
      "--connector-name", "Local MCP Connector",
    ])).toEqual({
      settingsArgs: ["--config", "settings.json"],
      requestId: "request-current",
      connectorName: "Local MCP Connector",
    });
    expect(parseConnectorConfirmArgs([
      "--config", "settings.json",
      "--request-id", "request-current",
    ])).toEqual({ settingsArgs: ["--config", "settings.json"], requestId: "request-current" });
    expect(() => parseConnectorConfirmArgs([
      "--request-id", "request-current",
      "--connector-name", "",
    ])).toThrow("blank");
    expect(() => parseConnectorConfirmArgs([
      "--request-id", "request-current",
      "--connector-name", "   ",
    ])).toThrow("blank");
    expect(() => parseConnectorConfirmArgs([
      "--request-id", "request-current",
      "--connector-name", "x".repeat(201),
    ])).toThrow("200 characters");
    expect(() => parseConnectorConfirmArgs([
      "--request-id", "request-current",
      "--connector-name",
    ])).toThrow("requires a value");
  });
});

describe("legacy migration", () => {
  it("copies one exact legacy connector binding without deleting the legacy file", async () => {
    const root = await temporaryRoot();
    const legacyFile = legacyChatgptConnectorStateFile(root);
    await writeJson(legacyFile, {
      schema_version: 1,
      bindings: [verifiedBinding()],
    });
    const store = new ChatGPTConnectorStore("workspace-1", root);
    await expect(store.read()).resolves.toMatchObject({ workspace_id: "workspace-1", status: "verified" });
    expect(JSON.parse(await readFile(chatgptConnectorStateFile("workspace-1", root), "utf8")))
      .toMatchObject({ schema_version: 1, binding: { workspace_id: "workspace-1" }, evidence: [] });
    await expect(new ChatGPTConnectorStore("workspace-1", root).read())
      .resolves.toMatchObject({ workspace_id: "workspace-1" });
    await expect(readFile(legacyFile, "utf8")).resolves.toContain("workspace-1");
  });

  it("migrates uniquely owned OAuth state once and omits revoked tokens", async () => {
    const root = await temporaryRoot();
    await writeJson(legacyChatgptConnectorStateFile(root), {
      schema_version: 1,
      bindings: [verifiedBinding()],
    });
    await writeJson(join(root, "oauth", "clients.json"), {
      version: 1,
      clients: [{
        client_id: "client-1",
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        response_types: ["code"],
        created_at: 1,
      }],
    });
    await writeJson(join(root, "oauth", "tokens.json"), {
      schema_version: 1,
      tokens: [
        {
          hash: "a".repeat(64), kind: "access", client_id: "client-1", resource: CURRENT_URL,
          issued_at: NOW - 1_000, expires_at: NOW + 60_000, revoked: false,
        },
        {
          hash: "b".repeat(64), kind: "refresh", client_id: "client-1", resource: CURRENT_URL,
          issued_at: NOW - 1_000, expires_at: NOW + 60_000, revoked: true,
        },
      ],
    });

    const migrated = await migrateLegacyOAuthState({
      workspaceId: "workspace-1",
      storageRoot: root,
      singleWorkspace: true,
      now: NOW,
    });
    expect(migrated.migration).toBe("migrated");
    expect(JSON.parse(await readFile(migrated.tokenStorePath, "utf8")))
      .toMatchObject({ tokens: [{ hash: "a".repeat(64), revoked: false }] });
    await expect(migrateLegacyOAuthState({
      workspaceId: "workspace-1",
      storageRoot: root,
      singleWorkspace: true,
      now: NOW,
    })).resolves.toMatchObject({ migration: "not_needed" });
    await expect(readFile(join(root, "oauth", "tokens.json"), "utf8")).resolves.toContain("b".repeat(64));
  });

  it("refuses ambiguous multi-workspace OAuth migration without writing scoped state", async () => {
    const root = await temporaryRoot();
    await writeJson(legacyChatgptConnectorStateFile(root), {
      schema_version: 1,
      bindings: [
        verifiedBinding("workspace-1", CURRENT_URL),
        verifiedBinding("workspace-2", "https://two.example/mcp"),
      ],
    });
    await writeJson(join(root, "oauth", "clients.json"), { version: 1, clients: [] });
    await writeJson(join(root, "oauth", "tokens.json"), { schema_version: 1, tokens: [] });

    await expect(migrateLegacyOAuthState({
      workspaceId: "workspace-1",
      storageRoot: root,
      singleWorkspace: false,
    })).resolves.toMatchObject({ migration: "reauthorization_required" });
    const paths = workspaceOAuthStatePaths("workspace-1", root);
    await expect(readFile(paths.clientRegistryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.tokenStorePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("legacy OAuth upgrade regression", () => {
  it("A: keeps the legacy client_id when the legacy token file is missing", async () => {
    const root = await temporaryRoot();
    await writeLegacyOAuthState(root);

    const migrated = await upgrade(root);
    expect(migrated.migration).toBe("migrated");
    await expect(scopedClientIds(migrated.clientRegistryPath)).resolves.toEqual([LEGACY_CLIENT_ID]);
    await expect(scopedTokenHashes(migrated.tokenStorePath)).resolves.toEqual([]);
    await expect(upgrade(root)).resolves.toMatchObject({ migration: "not_needed" });
    await expect(diagnoseChatGPTConnector(settings(), {
      storageRoot: root,
      fetch: healthyOAuthFetch(),
    })).resolves.toMatchObject({
      oauth: { migration: "not_needed", reauthorization_required: false },
    });
  });

  it("B: migrates an empty legacy token set", async () => {
    const root = await temporaryRoot();
    await writeLegacyOAuthState(root, { tokens: { schema_version: 1, tokens: [] } });

    const migrated = await upgrade(root);
    expect(migrated.migration).toBe("migrated");
    await expect(scopedClientIds(migrated.clientRegistryPath)).resolves.toEqual([LEGACY_CLIENT_ID]);
    await expect(scopedTokenHashes(migrated.tokenStorePath)).resolves.toEqual([]);
  });

  it("A2: fails closed when the legacy connector state is missing", async () => {
    const root = await temporaryRoot();
    await writeLegacyClients(root);

    await expect(upgrade(root)).resolves.toMatchObject({ migration: "reauthorization_required" });
    const paths = workspaceOAuthStatePaths("workspace-1", root);
    await expect(readFile(paths.clientRegistryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.tokenStorePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("A3: fails closed when the only legacy binding belongs to another workspace", async () => {
    const root = await temporaryRoot();
    await writeJson(legacyChatgptConnectorStateFile(root), {
      schema_version: 1,
      bindings: [verifiedBinding("workspace-2", "https://two.example/mcp")],
    });
    await writeLegacyClients(root);

    await expect(upgrade(root)).resolves.toMatchObject({ migration: "reauthorization_required" });
    const paths = workspaceOAuthStatePaths("workspace-1", root);
    await expect(readFile(paths.clientRegistryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("A4: fails closed on legacy bindings that cannot be resolved uniquely", async () => {
    const root = await temporaryRoot();
    await writeJson(legacyChatgptConnectorStateFile(root), {
      schema_version: 1,
      bindings: [
        verifiedBinding("workspace-1", CURRENT_URL),
        verifiedBinding("workspace-2", "https://two.example/mcp"),
      ],
    });
    await writeLegacyClients(root);

    await expect(upgrade(root)).resolves.toMatchObject({ migration: "reauthorization_required" });
    const paths = workspaceOAuthStatePaths("workspace-1", root);
    await expect(readFile(paths.clientRegistryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("A5: fails closed on an invalid legacy connector state", async () => {
    const root = await temporaryRoot();
    await writeJson(legacyChatgptConnectorStateFile(root), {
      schema_version: 1,
      bindings: [{ ...verifiedBinding(), verified_mcp_url: null }],
    });
    await writeLegacyClients(root);

    await expect(upgrade(root)).resolves.toMatchObject({ migration: "reauthorization_required" });
    const paths = workspaceOAuthStatePaths("workspace-1", root);
    await expect(readFile(paths.clientRegistryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("A6: keeps an already scoped exact client without the legacy ownership proof", async () => {
    const root = await temporaryRoot();
    await writeLegacyClients(root);
    const paths = workspaceOAuthStatePaths("workspace-1", root);
    await writeJson(paths.clientRegistryPath, { version: 1, clients: [legacyClient()] });
    const before = await readFile(paths.clientRegistryPath, "utf8");

    await expect(upgrade(root)).resolves.toMatchObject({ migration: "not_needed" });
    await expect(readFile(paths.clientRegistryPath, "utf8")).resolves.toBe(before);
  });

  it("C: keeps the legacy client while omitting an expired token", async () => {
    const root = await temporaryRoot();
    await writeLegacyOAuthState(root, {
      tokens: { schema_version: 1, tokens: [legacyAccessToken({ expires_at: NOW - 1 })] },
    });

    const migrated = await upgrade(root);
    expect(migrated.migration).toBe("migrated");
    await expect(scopedClientIds(migrated.clientRegistryPath)).resolves.toEqual([LEGACY_CLIENT_ID]);
    await expect(scopedTokenHashes(migrated.tokenStorePath)).resolves.toEqual([]);
  });

  it("D: keeps the legacy client while omitting mismatched and unknown-client tokens", async () => {
    const root = await temporaryRoot();
    await writeLegacyOAuthState(root, {
      tokens: {
        schema_version: 1,
        tokens: [
          legacyAccessToken({ hash: "b".repeat(64), resource: "https://other.example/mcp" }),
          legacyAccessToken({ hash: "c".repeat(64), client_id: "unknown-client" }),
        ],
      },
    });

    const migrated = await upgrade(root);
    expect(migrated.migration).toBe("migrated");
    await expect(scopedClientIds(migrated.clientRegistryPath)).resolves.toEqual([LEGACY_CLIENT_ID]);
    await expect(scopedTokenHashes(migrated.tokenStorePath)).resolves.toEqual([]);
  });

  it("E: merges a missing compatible legacy client into existing scoped state", async () => {
    const root = await temporaryRoot();
    await writeLegacyOAuthState(root);
    const paths = workspaceOAuthStatePaths("workspace-1", root);
    await writeJson(paths.clientRegistryPath, {
      version: 1,
      clients: [legacyClient({ client_id: "scoped-client-id" })],
    });

    await expect(upgrade(root)).resolves.toMatchObject({ migration: "migrated" });
    await expect(scopedClientIds(paths.clientRegistryPath))
      .resolves.toEqual(["scoped-client-id", LEGACY_CLIENT_ID]);
  });

  it("F: treats an exact duplicate legacy client as idempotent", async () => {
    const root = await temporaryRoot();
    await writeLegacyOAuthState(root);
    const paths = workspaceOAuthStatePaths("workspace-1", root);
    await writeJson(paths.clientRegistryPath, { version: 1, clients: [legacyClient()] });
    const before = await readFile(paths.clientRegistryPath, "utf8");

    await expect(upgrade(root)).resolves.toMatchObject({ migration: "not_needed" });
    await expect(readFile(paths.clientRegistryPath, "utf8")).resolves.toBe(before);
  });

  it("G: fails closed on conflicting registration for the same client_id", async () => {
    const root = await temporaryRoot();
    await writeLegacyOAuthState(root);
    const paths = workspaceOAuthStatePaths("workspace-1", root);
    await writeJson(paths.clientRegistryPath, {
      version: 1,
      clients: [legacyClient({ redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect/other"] })],
    });
    const scopedBefore = await readFile(paths.clientRegistryPath, "utf8");
    const legacyBefore = await readFile(join(root, "oauth", "clients.json"), "utf8");

    await expect(upgrade(root)).resolves.toMatchObject({ migration: "reauthorization_required" });
    await expect(readFile(paths.clientRegistryPath, "utf8")).resolves.toBe(scopedBefore);
    await expect(readFile(join(root, "oauth", "clients.json"), "utf8")).resolves.toBe(legacyBefore);
  });

  it("H: keeps ambiguous multi-workspace ownership failing closed", async () => {
    const root = await temporaryRoot();
    await writeLegacyOAuthState(root);
    const paths = workspaceOAuthStatePaths("workspace-1", root);

    await expect(upgradeWith(root, false)).resolves.toMatchObject({ migration: "reauthorization_required" });
    await expect(readFile(paths.clientRegistryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await writeJson(paths.clientRegistryPath, {
      version: 1,
      clients: [legacyClient({ client_id: "scoped-client-id" })],
    });
    await expect(upgradeWith(root, false)).resolves.toMatchObject({ migration: "reauthorization_required" });
    await expect(scopedClientIds(paths.clientRegistryPath)).resolves.toEqual(["scoped-client-id"]);

    await writeJson(paths.clientRegistryPath, { version: 1, clients: [legacyClient()] });
    await expect(upgradeWith(root, false)).resolves.toMatchObject({ migration: "not_needed" });
  });
});

describe("diagnose-chatgpt-connector", () => {
  it("reports create, persists only a pending URL, and contains no configured secrets", async () => {
    const root = await temporaryRoot();
    const result = await diagnoseChatGPTConnector(settings(), {
      storageRoot: root,
      fetch: healthyOAuthFetch(),
    });
    expect(result).toMatchObject({
      ok: true,
      workspace_id: "workspace-1",
      remote: { ready: true, mcp_url: CURRENT_URL },
      oauth: {
        ready: true,
        pkce_s256: true,
        dynamic_registration: true,
        refresh_token: true,
        migration: "not_needed",
        reauthorization_required: false,
      },
      connector: {
        name: "Local Review MCP · Workspace One",
        status: "unconfigured",
        action: "create",
        verified_mcp_url: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain("AUTH_SENTINEL");
    expect(JSON.parse(await readFile(chatgptConnectorStateFile("workspace-1", root), "utf8")))
      .toMatchObject({
        schema_version: 1,
        binding: { verified_mcp_url: null, pending_mcp_url: CURRENT_URL },
        evidence: [],
      });
  });

  it("does not request browser actuation when Remote MCP or OAuth discovery is unavailable", async () => {
    const root = await temporaryRoot();
    await expect(diagnoseChatGPTConnector(settings(), {
      storageRoot: root,
      fetch: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch,
    })).resolves.toMatchObject({
      ok: false,
      remote: { ready: false },
      connector: { action: "none" },
    });
    await expect(diagnoseChatGPTConnector(settings(), {
      storageRoot: root,
      fetch: healthyOAuthFetch({ refresh: false }),
    })).resolves.toMatchObject({
      ok: false,
      remote: { ready: true },
      oauth: { ready: false, refresh_token: false },
      connector: { action: "none", reason: "oauth_refresh_token_not_supported" },
    });
  });

  it("names the exact OAuth layer that blocks readiness", async () => {
    const cases: readonly [string, () => typeof fetch][] = [
      ["oauth_protected_resource_metadata_missing", () => healthyOAuthFetch({ challenge: null })],
      [
        "oauth_resource_mismatch",
        () => healthyOAuthFetch({ protected: { resource: "https://other.example/mcp" } }),
      ],
      [
        "oauth_authorization_server_metadata_missing",
        () => healthyOAuthFetch({ protected: { authorization_servers: null } }),
      ],
      ["oauth_issuer_invalid", () => healthyOAuthFetch({ authorization: { issuer: null } })],
      [
        "oauth_authorization_endpoint_missing",
        () => healthyOAuthFetch({ authorization: { authorization_endpoint: null } }),
      ],
      [
        "oauth_token_endpoint_missing",
        () => healthyOAuthFetch({ authorization: { token_endpoint: "not-a-url" } }),
      ],
      [
        "oauth_registration_not_supported",
        () => healthyOAuthFetch({ authorization: { registration_endpoint: null } }),
      ],
      [
        "oauth_authorization_code_not_supported",
        () => healthyOAuthFetch({ authorization: { response_types_supported: ["token"] } }),
      ],
      ["oauth_refresh_token_not_supported", () => healthyOAuthFetch({ refresh: false })],
      [
        "oauth_pkce_s256_not_supported",
        () => healthyOAuthFetch({ authorization: { code_challenge_methods_supported: ["plain"] } }),
      ],
    ];

    for (const [reason, createFetch] of cases) {
      const root = await temporaryRoot();
      const result = await diagnoseChatGPTConnector(settings(), {
        storageRoot: root,
        fetch: createFetch(),
      });
      expect({
        ok: result.ok,
        ready: result.oauth.ready,
        action: result.connector.action,
        reason: result.connector.reason,
      }).toEqual({ ok: false, ready: false, action: "none", reason });
      // A blocked readiness proof never binds the connector.
      await expect(readFile(chatgptConnectorStateFile("workspace-1", root), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("reports ambiguous legacy OAuth ownership as requiring reauthorization", async () => {
    const root = await temporaryRoot();
    await writeJson(legacyChatgptConnectorStateFile(root), {
      schema_version: 1,
      bindings: [
        verifiedBinding("workspace-1", CURRENT_URL),
        verifiedBinding("workspace-2", "https://two.example/mcp"),
      ],
    });
    await writeJson(join(root, "oauth", "clients.json"), { version: 1, clients: [] });
    await writeJson(join(root, "oauth", "tokens.json"), { schema_version: 1, tokens: [] });
    const current = settings();
    const identity2 = { id: "workspace-2", name: "Workspace Two", path: "C:\\workspace-two" };
    current.workspaces = [...(current.workspaces ?? []), identity2];

    await expect(diagnoseChatGPTConnector(current, {
      storageRoot: root,
      fetch: healthyOAuthFetch(),
    })).resolves.toMatchObject({
      ok: true,
      oauth: { migration: "reauthorization_required", reauthorization_required: true },
      connector: { reason: "legacy_oauth_reauthorization_required" },
    });
  });

  it("keeps remote health separate from OAuth readiness", async () => {
    const root = await temporaryRoot();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate":
              "Bearer resource_metadata=\"https://host.example/.well-known/oauth-protected-resource/mcp\"",
          },
        });
      }
      if (url.endsWith("/health")) return Response.json({ status: "ok" });
      if (url.includes("oauth-protected-resource")) {
        return Response.json({ resource: CURRENT_URL, authorization_servers: ["https://host.example"] });
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          issuer: "https://host.example",
          authorization_endpoint: "https://host.example/oauth/authorize",
          token_endpoint: "https://host.example/oauth/token",
          registration_endpoint: "https://host.example/oauth/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await expect(diagnoseChatGPTConnector(settings(), { storageRoot: root, fetch: fetchImpl }))
      .resolves.toMatchObject({
        ok: false,
        remote: { ready: true },
        oauth: { ready: false, refresh_token: false },
        connector: { action: "none", reason: "oauth_refresh_token_not_supported" },
      });
  });
});
