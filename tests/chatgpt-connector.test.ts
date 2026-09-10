import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSettings } from "../src/config/settings.js";
import {
  ChatGPTConnectorStore,
  chatgptConnectorStateFile,
  confirmChatGPTConnector,
  connectorAction,
  diagnoseChatGPTConnector,
  mcpUrlFromPublic,
  normalizePublicUrl,
} from "../src/control-plane/chatgpt-connector.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-connector-"));
  temporaryDirectories.push(root);
  return root;
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

function healthyOAuthFetch(options: { refresh?: boolean } = {}): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": "Bearer resource_metadata=\"https://host.example/.well-known/oauth-protected-resource/mcp\"",
        },
      });
    }
    if (url.includes("oauth-protected-resource")) {
      return Response.json({
        resource: "https://host.example/mcp",
        authorization_servers: ["https://host.example"],
      });
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return Response.json({
        registration_endpoint: "https://host.example/oauth/register",
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: options.refresh === false
          ? ["authorization_code"]
          : ["authorization_code", "refresh_token"],
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

describe("ChatGPT connector decisions", () => {
  it("reuses the C2C URL normalization and create/none/update rules", () => {
    expect(connectorAction(null, "https://host/mcp")).toBe("create");
    expect(connectorAction("https://HOST/mcp", "https://host/mcp/")).toBe("none");
    expect(connectorAction("https://old/mcp", "https://new/mcp")).toBe("update");
    expect(mcpUrlFromPublic("https://HOST/mcp/")).toBe("https://host/mcp");
    expect(mcpUrlFromPublic("https://host")).toBe("https://host/mcp");
    expect(normalizePublicUrl("https://HOST/mcp/")).toBe("https://host/mcp");
  });

  it("keeps the verified URL through a failed repair and restart, then confirms the new URL", async () => {
    const root = await temporaryRoot();
    const first = new ChatGPTConnectorStore(root);
    const created = await first.prepare({
      workspaceId: "workspace-1",
      workspaceName: "Original Name",
      currentMcpUrl: "https://old.example/mcp",
    });
    expect(created.action).toBe("create");
    const verified = await first.confirm({
      workspaceId: "workspace-1",
      currentMcpUrl: "https://old.example/mcp",
      verifiedAt: "2026-09-10T00:00:00.000Z",
    });

    const repair = await first.prepare({
      workspaceId: "workspace-1",
      workspaceName: "Renamed Workspace",
      currentMcpUrl: "https://new.example/mcp",
    });
    expect(repair).toMatchObject({
      action: "update",
      binding: {
        connector_name: created.binding.connector_name,
        verified_mcp_url: "https://old.example/mcp",
        pending_mcp_url: "https://new.example/mcp",
        status: "repair_required",
      },
    });
    expect(verified.connector_name).toBe(repair.binding.connector_name);

    const restarted = new ChatGPTConnectorStore(root);
    await expect(restarted.prepare({
      workspaceId: "workspace-1",
      workspaceName: "Renamed Again",
      currentMcpUrl: "https://new.example/mcp",
    })).resolves.toMatchObject({
      action: "update",
      binding: { verified_mcp_url: "https://old.example/mcp" },
    });

    await expect(restarted.confirm({
      workspaceId: "workspace-1",
      currentMcpUrl: "https://old.example/mcp",
    })).rejects.toThrow("pending connector binding");
    await restarted.confirm({
      workspaceId: "workspace-1",
      currentMcpUrl: "https://new.example/mcp",
      verifiedAt: "2026-09-10T01:00:00.000Z",
    });
    await expect(new ChatGPTConnectorStore(root).prepare({
      workspaceId: "workspace-1",
      workspaceName: "Renamed Again",
      currentMcpUrl: "https://NEW.example/mcp/",
    })).resolves.toMatchObject({
      action: "none",
      binding: {
        verified_mcp_url: "https://new.example/mcp",
        pending_mcp_url: null,
        status: "verified",
      },
    });
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
      remote: { ready: true, mcp_url: "https://host.example/mcp" },
      oauth: {
        ready: true,
        pkce_s256: true,
        dynamic_registration: true,
        refresh_token: true,
      },
      connector: {
        name: "Local Review MCP · Workspace One",
        status: "unconfigured",
        action: "create",
        verified_mcp_url: null,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("AUTH_SENTINEL");
    const state = await readFile(chatgptConnectorStateFile(root), "utf8");
    expect(state).not.toContain("AUTH_SENTINEL");
    expect(JSON.parse(state)).toMatchObject({
      schema_version: 1,
      bindings: [{
        verified_mcp_url: null,
        pending_mcp_url: "https://host.example/mcp",
      }],
    });
  });

  it("does not request browser actuation when Remote MCP or OAuth discovery is unavailable", async () => {
    const root = await temporaryRoot();
    const unavailable = await diagnoseChatGPTConnector(settings(), {
      storageRoot: root,
      fetch: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch,
    });
    expect(unavailable).toMatchObject({
      ok: false,
      remote: { ready: false },
      connector: { action: "none" },
    });

    const invalidOAuth = await diagnoseChatGPTConnector(settings(), {
      storageRoot: root,
      fetch: healthyOAuthFetch({ refresh: false }),
    });
    expect(invalidOAuth).toMatchObject({
      ok: false,
      remote: { ready: true },
      oauth: { ready: false, refresh_token: false },
      connector: { action: "none", reason: "oauth_capabilities_incomplete" },
    });
  });

  it("requires matching workspace_info identity and current URL before confirmation", async () => {
    const root = await temporaryRoot();
    const current = settings();
    await diagnoseChatGPTConnector(current, { storageRoot: root, fetch: healthyOAuthFetch() });
    await expect(confirmChatGPTConnector(current, {
      workspaceId: "wrong-workspace",
      mcpUrl: "https://host.example/mcp",
    }, root)).rejects.toThrow("workspace_id");
    await expect(confirmChatGPTConnector(current, {
      workspaceId: "workspace-1",
      mcpUrl: "https://old.example/mcp",
    }, root)).rejects.toThrow("current remote endpoint");
    await expect(confirmChatGPTConnector(current, {
      workspaceId: "workspace-1",
      mcpUrl: "https://host.example/mcp",
    }, root)).resolves.toMatchObject({ status: "verified" });

    await expect(diagnoseChatGPTConnector(current, {
      storageRoot: root,
      fetch: healthyOAuthFetch(),
    })).resolves.toMatchObject({
      ok: true,
      connector: { action: "none", status: "verified" },
    });
  });
});
