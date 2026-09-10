// Endpoint/name decision logic is adapted from codex-with-chatgpt (MIT).
// See THIRD_PARTY_NOTICES.md.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ResolvedSettings } from "../config/settings.js";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { WorkspaceManager } from "../workspace/manager.js";

export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins";
export const CONNECTOR_DESCRIPTION =
  "Securely connect ChatGPT to the current Local Review MCP workspace for review.";
export const CONNECTOR_STATE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CONNECTOR_PREFIX = "Local Review MCP";

export type ConnectorAction = "none" | "create" | "update";
export type ConnectorStatus = "unconfigured" | "repair_required" | "verified";

export interface ChatGPTConnectorBinding {
  readonly workspace_id: string;
  readonly connector_name: string;
  readonly verified_mcp_url: string | null;
  readonly pending_mcp_url: string | null;
  readonly status: ConnectorStatus;
  readonly last_verified_at: string | null;
}

const bindingSchema = z.object({
  workspace_id: z.string().min(1).max(128),
  connector_name: z.string().min(1).max(200),
  verified_mcp_url: z.string().url().nullable(),
  pending_mcp_url: z.string().url().nullable(),
  status: z.enum(["unconfigured", "repair_required", "verified"]),
  last_verified_at: z.string().datetime({ offset: true }).nullable(),
}).strict().superRefine((binding, context) => {
  if (binding.status === "verified"
    && (binding.verified_mcp_url === null
      || binding.pending_mcp_url !== null
      || binding.last_verified_at === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "verified binding is incomplete" });
  }
  if (binding.status === "unconfigured"
    && (binding.verified_mcp_url !== null || binding.pending_mcp_url === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "unconfigured binding is invalid" });
  }
  if (binding.status === "repair_required"
    && (binding.verified_mcp_url === null || binding.pending_mcp_url === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "repair binding is incomplete" });
  }
});

const stateSchema = z.object({
  schema_version: z.literal(CONNECTOR_STATE_SCHEMA_VERSION),
  bindings: z.array(bindingSchema),
}).strict().superRefine((value, context) => {
  const workspaceIds = new Set<string>();
  value.bindings.forEach((binding, index) => {
    if (workspaceIds.has(binding.workspace_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bindings", index, "workspace_id"],
        message: "workspace_id is duplicated",
      });
    }
    workspaceIds.add(binding.workspace_id);
  });
});

export function normalizePublicUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "").toLowerCase();
}

export function mcpUrlFromPublic(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  const base = normalizePublicUrl(publicUrl).replace(/\/mcp$/u, "");
  return `${base}/mcp`;
}

export function connectorAction(
  previousMcpUrl: string | null | undefined,
  nextMcpUrl: string | null | undefined,
): ConnectorAction {
  if (!nextMcpUrl) return "none";
  if (!previousMcpUrl) return "create";
  return normalizePublicUrl(previousMcpUrl) === normalizePublicUrl(nextMcpUrl)
    ? "none"
    : "update";
}

function sanitizeConnectorLabel(name: string, workspaceId: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N}._\- ]+/gu, "").replace(/\s+/gu, " ").trim();
  return cleaned.slice(0, 40) || workspaceId.slice(0, 6);
}

export function connectorNameFor(options: {
  readonly workspaceName: string;
  readonly workspaceId: string;
  readonly previousName?: string | null;
}): string {
  if (options.previousName?.trim()) return options.previousName.trim();
  return `${DEFAULT_CONNECTOR_PREFIX} · ${sanitizeConnectorLabel(options.workspaceName, options.workspaceId)}`;
}

export function chatgptConnectorStateFile(storageRoot = defaultTaskContextStorageRoot()): string {
  return join(resolve(storageRoot), "control-plane", "chatgpt-connectors.json");
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

export class ChatGPTConnectorStore {
  private readonly file: string;

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.file = chatgptConnectorStateFile(storageRoot);
  }

  public async read(workspaceId: string): Promise<ChatGPTConnectorBinding | null> {
    const state = await this.readState();
    return state.bindings.find((binding) => binding.workspace_id === workspaceId) ?? null;
  }

  public async prepare(input: {
    readonly workspaceId: string;
    readonly workspaceName: string;
    readonly currentMcpUrl: string;
  }): Promise<{ binding: ChatGPTConnectorBinding; action: ConnectorAction }> {
    const state = await this.readState();
    const previous = state.bindings.find((binding) => binding.workspace_id === input.workspaceId);
    const currentMcpUrl = mcpUrlFromPublic(input.currentMcpUrl);
    if (currentMcpUrl === null) throw new Error("Current MCP URL is required");
    const action = connectorAction(previous?.verified_mcp_url, currentMcpUrl);
    const connectorName = connectorNameFor({
      workspaceName: input.workspaceName,
      workspaceId: input.workspaceId,
      previousName: previous?.connector_name,
    });
    const binding: ChatGPTConnectorBinding = action === "none"
      ? {
          workspace_id: input.workspaceId,
          connector_name: connectorName,
          verified_mcp_url: currentMcpUrl,
          pending_mcp_url: null,
          status: "verified",
          last_verified_at: previous?.last_verified_at ?? null,
        }
      : {
          workspace_id: input.workspaceId,
          connector_name: connectorName,
          verified_mcp_url: previous?.verified_mcp_url ?? null,
          pending_mcp_url: currentMcpUrl,
          status: action === "create" ? "unconfigured" : "repair_required",
          last_verified_at: previous?.last_verified_at ?? null,
        };
    await this.writeState(this.replace(state.bindings, binding));
    return { binding, action };
  }

  public async confirm(input: {
    readonly workspaceId: string;
    readonly currentMcpUrl: string;
    readonly verifiedAt?: string;
  }): Promise<ChatGPTConnectorBinding> {
    const state = await this.readState();
    const previous = state.bindings.find((binding) => binding.workspace_id === input.workspaceId);
    if (previous === undefined) throw new Error("ChatGPT connector binding is not configured");
    const currentMcpUrl = mcpUrlFromPublic(input.currentMcpUrl);
    if (currentMcpUrl === null) throw new Error("Current MCP URL is required");
    const pendingMatches = previous.pending_mcp_url !== null
      && normalizePublicUrl(previous.pending_mcp_url) === normalizePublicUrl(currentMcpUrl);
    const verifiedMatches = previous.pending_mcp_url === null
      && previous.verified_mcp_url !== null
      && normalizePublicUrl(previous.verified_mcp_url) === normalizePublicUrl(currentMcpUrl);
    if (!pendingMatches && !verifiedMatches) {
      throw new Error("Current MCP URL does not match the pending connector binding");
    }
    const binding: ChatGPTConnectorBinding = {
      ...previous,
      verified_mcp_url: currentMcpUrl,
      pending_mcp_url: null,
      status: "verified",
      last_verified_at: input.verifiedAt ?? new Date().toISOString(),
    };
    await this.writeState(this.replace(state.bindings, binding));
    return binding;
  }

  private replace(
    bindings: readonly ChatGPTConnectorBinding[],
    replacement: ChatGPTConnectorBinding,
  ): ChatGPTConnectorBinding[] {
    return [
      ...bindings.filter((binding) => binding.workspace_id !== replacement.workspace_id),
      replacement,
    ];
  }

  private async readState(): Promise<{ schema_version: 1; bindings: ChatGPTConnectorBinding[] }> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
        return { schema_version: CONNECTOR_STATE_SCHEMA_VERSION, bindings: [] };
      }
      throw new Error("ChatGPT connector state could not be loaded", { cause: error });
    }
    try {
      return stateSchema.parse(JSON.parse(raw));
    } catch (error: unknown) {
      throw new Error("ChatGPT connector state is invalid", { cause: error });
    }
  }

  private async writeState(bindings: readonly ChatGPTConnectorBinding[]): Promise<void> {
    const directory = dirname(this.file);
    const temporary = join(directory, `.chatgpt-connectors-${process.pid}-${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      await writeFile(temporary, `${JSON.stringify({
        schema_version: CONNECTOR_STATE_SCHEMA_VERSION,
        bindings,
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
      await chmod(this.file, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export interface ChatGPTConnectorDiagnostic {
  ok: boolean;
  workspace_id: string;
  workspace_name: string;
  remote: {
    ready: boolean;
    mcp_url: string | null;
  };
  oauth: {
    ready: boolean;
    pkce_s256: boolean;
    dynamic_registration: boolean;
    refresh_token: boolean;
  };
  connector: {
    name: string;
    status: ConnectorStatus;
    action: ConnectorAction;
    mcp_url: string | null;
    verified_mcp_url: string | null;
    reason: string;
  };
  pages: {
    plugins: string;
    create_connector: string;
  };
}

function activeWorkspace(settings: ResolvedSettings): { id: string; name: string } {
  const configured = settings.workspaceIdentity
    ?? settings.workspaces?.find((workspace) => workspace.path === settings.workspace);
  const identity = configured ?? new WorkspaceManager(settings.workspace).identity;
  return { id: identity.id, name: identity.name };
}

function metadataUrl(header: string | null, mcpUrl: string): string | null {
  const match = header?.match(/resource_metadata\s*=\s*(?:"([^"]+)"|([^,\s]+))/iu);
  const value = match?.[1] ?? match?.[2];
  if (value === undefined) return null;
  try {
    return new URL(value, mcpUrl).href;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function validHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function resultBase(
  workspace: { id: string; name: string },
  binding: ChatGPTConnectorBinding | null,
  currentMcpUrl: string | null,
): ChatGPTConnectorDiagnostic {
  return {
    ok: false,
    workspace_id: workspace.id,
    workspace_name: workspace.name,
    remote: { ready: false, mcp_url: currentMcpUrl },
    oauth: {
      ready: false,
      pkce_s256: false,
      dynamic_registration: false,
      refresh_token: false,
    },
    connector: {
      name: connectorNameFor({
        workspaceName: workspace.name,
        workspaceId: workspace.id,
        previousName: binding?.connector_name,
      }),
      status: binding?.status ?? "unconfigured",
      action: "none",
      mcp_url: currentMcpUrl,
      verified_mcp_url: binding?.verified_mcp_url ?? null,
      reason: "remote_mcp_unavailable",
    },
    pages: {
      plugins: CHATGPT_PLUGINS_URL,
      create_connector: CHATGPT_CREATE_CONNECTOR_URL,
    },
  };
}

export async function diagnoseChatGPTConnector(
  settings: ResolvedSettings,
  dependencies: {
    readonly fetch?: typeof fetch;
    readonly storageRoot?: string;
  } = {},
): Promise<ChatGPTConnectorDiagnostic> {
  const workspace = activeWorkspace(settings);
  const store = new ChatGPTConnectorStore(dependencies.storageRoot);
  const existing = await store.read(workspace.id);
  const currentMcpUrl = settings.remote.enabled
    ? mcpUrlFromPublic(settings.remote.endpoint)
    : null;
  const result = resultBase(workspace, existing, currentMcpUrl);
  if (currentMcpUrl === null) return result;

  const fetchImpl = dependencies.fetch ?? fetch;
  try {
    const response = await fetchImpl(currentMcpUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status !== 401) return result;
    result.remote.ready = true;

    const protectedUrl = metadataUrl(response.headers.get("www-authenticate"), currentMcpUrl);
    if (protectedUrl === null) {
      result.connector.reason = "oauth_protected_resource_metadata_missing";
      return result;
    }
    const protectedResponse = await fetchImpl(protectedUrl, { signal: AbortSignal.timeout(8_000) });
    if (!protectedResponse.ok) {
      result.connector.reason = "oauth_protected_resource_metadata_unavailable";
      return result;
    }
    const protectedMetadata = record(await protectedResponse.json());
    if (protectedMetadata === null
      || !validHttpUrl(protectedMetadata.resource)
      || normalizePublicUrl(protectedMetadata.resource) !== normalizePublicUrl(currentMcpUrl)) {
      result.connector.reason = "oauth_protected_resource_metadata_invalid";
      return result;
    }
    const authorizationServer = stringList(protectedMetadata.authorization_servers)[0];
    if (!validHttpUrl(authorizationServer)) {
      result.connector.reason = "oauth_authorization_server_metadata_missing";
      return result;
    }
    const authorizationMetadataUrl = new URL(
      "/.well-known/oauth-authorization-server",
      authorizationServer,
    );
    const authorizationResponse = await fetchImpl(authorizationMetadataUrl, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!authorizationResponse.ok) {
      result.connector.reason = "oauth_authorization_server_metadata_unavailable";
      return result;
    }
    const authorizationMetadata = record(await authorizationResponse.json());
    if (authorizationMetadata === null) {
      result.connector.reason = "oauth_authorization_server_metadata_invalid";
      return result;
    }
    result.oauth.pkce_s256 = stringList(
      authorizationMetadata.code_challenge_methods_supported,
    ).includes("S256");
    result.oauth.dynamic_registration = validHttpUrl(authorizationMetadata.registration_endpoint);
    result.oauth.refresh_token = stringList(
      authorizationMetadata.grant_types_supported,
    ).includes("refresh_token");
    result.oauth.ready = result.oauth.pkce_s256
      && result.oauth.dynamic_registration
      && result.oauth.refresh_token;
    if (!result.oauth.ready) {
      result.connector.reason = "oauth_capabilities_incomplete";
      return result;
    }

    const prepared = await store.prepare({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      currentMcpUrl,
    });
    result.ok = true;
    result.connector.name = prepared.binding.connector_name;
    result.connector.status = prepared.binding.status;
    result.connector.action = prepared.action;
    result.connector.verified_mcp_url = prepared.binding.verified_mcp_url;
    result.connector.reason = prepared.action === "create"
      ? "first_connection"
      : prepared.action === "update"
        ? "endpoint_changed"
        : "verified_endpoint_matches";
    return result;
  } catch {
    return result;
  }
}

export async function confirmChatGPTConnector(
  settings: ResolvedSettings,
  proof: { readonly workspaceId: string; readonly mcpUrl: string },
  storageRoot?: string,
): Promise<ChatGPTConnectorBinding> {
  const workspace = activeWorkspace(settings);
  if (proof.workspaceId !== workspace.id) {
    throw new Error("workspace_info workspace_id does not match the active workspace");
  }
  const currentMcpUrl = settings.remote.enabled
    ? mcpUrlFromPublic(settings.remote.endpoint)
    : null;
  if (currentMcpUrl === null
    || normalizePublicUrl(proof.mcpUrl) !== normalizePublicUrl(currentMcpUrl)) {
    throw new Error("workspace_info MCP URL does not match the current remote endpoint");
  }
  return new ChatGPTConnectorStore(storageRoot).confirm({
    workspaceId: workspace.id,
    currentMcpUrl,
  });
}
