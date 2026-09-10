// Endpoint/name decision logic is adapted from codex-with-chatgpt (MIT).
// See THIRD_PARTY_NOTICES.md.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ResolvedSettings } from "../config/settings.js";
import { defaultTaskContextStorageRoot, workspaceStateRoot } from "../context/task.js";
import { WorkspaceManager } from "../workspace/manager.js";

export const CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins";
export const CHATGPT_CREATE_CONNECTOR_URL =
  "https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins";
export const CONNECTOR_DESCRIPTION =
  "Securely connect ChatGPT to the current Local Review MCP workspace for review.";
export const CONNECTOR_STATE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CONNECTOR_PREFIX = "Local Review MCP";
export const CONNECTOR_EVIDENCE_TTL_MS = 10 * 60 * 1000;
const MAX_CONNECTOR_EVIDENCE = 100;

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

export interface ConnectorVerificationEvidence {
  readonly request_id: string;
  readonly tool_name: string;
  readonly workspace_id: string;
  readonly mcp_resource: string;
  readonly authentication: "oauth" | "static" | "unknown";
  readonly success: boolean;
  readonly completed_at: string;
  readonly consumed_at: string | null;
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

const connectorRequestIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u);

const evidenceSchema = z.object({
  request_id: connectorRequestIdSchema,
  tool_name: z.string().min(1).max(100),
  workspace_id: z.string().min(1).max(128),
  mcp_resource: z.string().url(),
  authentication: z.enum(["oauth", "static", "unknown"]),
  success: z.boolean(),
  completed_at: z.string().datetime({ offset: true }),
  consumed_at: z.string().datetime({ offset: true }).nullable(),
}).strict();

const legacyStateSchema = z.object({
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

const stateSchema = z.object({
  schema_version: z.literal(CONNECTOR_STATE_SCHEMA_VERSION),
  binding: bindingSchema.nullable(),
  evidence: z.array(evidenceSchema).max(MAX_CONNECTOR_EVIDENCE),
}).strict();

interface ConnectorState {
  readonly schema_version: 1;
  readonly binding: ChatGPTConnectorBinding | null;
  readonly evidence: readonly ConnectorVerificationEvidence[];
}

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

export function legacyChatgptConnectorStateFile(storageRoot = defaultTaskContextStorageRoot()): string {
  return join(resolve(storageRoot), "control-plane", "chatgpt-connectors.json");
}

export function chatgptConnectorStateFile(
  workspaceId: string,
  storageRoot = defaultTaskContextStorageRoot(),
): string {
  return join(workspaceStateRoot(storageRoot, workspaceId), "control-plane", "chatgpt-connector.json");
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

export class ChatGPTConnectorStore {
  private readonly file: string;
  private readonly legacyFile: string;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(
    public readonly workspaceId: string,
    storageRoot = defaultTaskContextStorageRoot(),
  ) {
    this.file = chatgptConnectorStateFile(workspaceId, storageRoot);
    this.legacyFile = legacyChatgptConnectorStateFile(storageRoot);
  }

  public read(): Promise<ChatGPTConnectorBinding | null> {
    return this.operationQueue.then(async () => (await this.readState()).binding);
  }

  public async prepare(input: {
    readonly workspaceName: string;
    readonly currentMcpUrl: string;
  }): Promise<{ binding: ChatGPTConnectorBinding; action: ConnectorAction }> {
    return this.exclusive(async () => {
      const state = await this.readState();
      const previous = state.binding;
      const currentMcpUrl = mcpUrlFromPublic(input.currentMcpUrl);
      if (currentMcpUrl === null) throw new Error("Current MCP URL is required");
      const action = connectorAction(previous?.verified_mcp_url, currentMcpUrl);
      const connectorName = connectorNameFor({
        workspaceName: input.workspaceName,
        workspaceId: this.workspaceId,
        previousName: previous?.connector_name,
      });
      const binding: ChatGPTConnectorBinding = action === "none"
        ? {
            workspace_id: this.workspaceId,
            connector_name: connectorName,
            verified_mcp_url: currentMcpUrl,
            pending_mcp_url: null,
            status: "verified",
            last_verified_at: previous?.last_verified_at ?? null,
          }
        : {
            workspace_id: this.workspaceId,
            connector_name: connectorName,
            verified_mcp_url: previous?.verified_mcp_url ?? null,
            pending_mcp_url: currentMcpUrl,
            status: action === "create" ? "unconfigured" : "repair_required",
            last_verified_at: previous?.last_verified_at ?? null,
          };
      await this.writeState({ ...state, binding });
      return { binding, action };
    });
  }

  public async recordEvidence(input: Omit<ConnectorVerificationEvidence, "consumed_at">): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.readState();
      const evidence = evidenceSchema.parse({ ...input, consumed_at: null });
      if (evidence.workspace_id !== this.workspaceId) {
        throw new Error("workspace_info evidence belongs to another workspace");
      }
      const previous = state.evidence.find((entry) => entry.request_id === evidence.request_id);
      if (previous !== undefined) {
        if (JSON.stringify({ ...previous, consumed_at: null }) === JSON.stringify(evidence)) return;
        throw new Error("MCP request evidence id already identifies different evidence");
      }
      await this.writeState({
        ...state,
        evidence: [...state.evidence, evidence].slice(-MAX_CONNECTOR_EVIDENCE),
      });
    });
  }

  public async confirm(
    requestId: string,
    currentMcpUrl: string,
    now = Date.now(),
  ): Promise<ChatGPTConnectorBinding> {
    return this.exclusive(async () => {
      const safeRequestId = connectorRequestIdSchema.parse(requestId);
      const state = await this.readState();
      const previous = state.binding;
      if (previous === null) throw new Error("ChatGPT connector binding is not configured");
      const evidence = state.evidence.find((entry) => entry.request_id === safeRequestId);
      if (evidence === undefined) throw new Error("workspace_info evidence was not found");
      if (evidence.consumed_at !== null) throw new Error("workspace_info evidence was already consumed");
      if (evidence.tool_name !== "workspace_info") throw new Error("MCP evidence is not for workspace_info");
      if (!evidence.success) throw new Error("workspace_info evidence is not successful");
      if (evidence.authentication !== "oauth") throw new Error("workspace_info evidence is not OAuth-authenticated");
      if (evidence.workspace_id !== this.workspaceId) throw new Error("workspace_info evidence belongs to another workspace");
      const completedAt = Date.parse(evidence.completed_at);
      if (!Number.isFinite(completedAt) || completedAt > now || now - completedAt > CONNECTOR_EVIDENCE_TTL_MS) {
        throw new Error("workspace_info evidence is expired");
      }
      const normalizedCurrent = mcpUrlFromPublic(currentMcpUrl);
      if (normalizedCurrent === null
        || normalizePublicUrl(evidence.mcp_resource) !== normalizePublicUrl(normalizedCurrent)) {
        throw new Error("workspace_info evidence does not match the current MCP resource");
      }
      const pendingMatches = previous.pending_mcp_url !== null
        && normalizePublicUrl(previous.pending_mcp_url) === normalizePublicUrl(normalizedCurrent);
      const verifiedMatches = previous.pending_mcp_url === null
        && previous.verified_mcp_url !== null
        && normalizePublicUrl(previous.verified_mcp_url) === normalizePublicUrl(normalizedCurrent);
      if (!pendingMatches && !verifiedMatches) {
        throw new Error("Current MCP URL does not match the pending connector binding");
      }
      const binding: ChatGPTConnectorBinding = {
        ...previous,
        verified_mcp_url: normalizedCurrent,
        pending_mcp_url: null,
        status: "verified",
        last_verified_at: evidence.completed_at,
      };
      await this.writeState({
        ...state,
        binding,
        evidence: state.evidence.map((entry) => entry.request_id === safeRequestId
          ? { ...entry, consumed_at: new Date(now).toISOString() }
          : entry),
      });
      return binding;
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readState(): Promise<ConnectorState> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
        return this.migrateLegacyState();
      }
      throw new Error("ChatGPT connector state could not be loaded", { cause: error });
    }
    try {
      const state = stateSchema.parse(JSON.parse(raw));
      if (state.binding?.workspace_id !== undefined && state.binding.workspace_id !== this.workspaceId) {
        throw new Error("ChatGPT connector state belongs to another workspace");
      }
      if (state.evidence.some((entry) => entry.workspace_id !== this.workspaceId)) {
        throw new Error("ChatGPT connector evidence belongs to another workspace");
      }
      return state;
    } catch (error: unknown) {
      throw new Error("ChatGPT connector state is invalid", { cause: error });
    }
  }

  private async migrateLegacyState(): Promise<ConnectorState> {
    let raw: string;
    try {
      raw = await readFile(this.legacyFile, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
        return { schema_version: CONNECTOR_STATE_SCHEMA_VERSION, binding: null, evidence: [] };
      }
      throw new Error("Legacy ChatGPT connector state could not be loaded", { cause: error });
    }
    let legacy: z.infer<typeof legacyStateSchema>;
    try {
      legacy = legacyStateSchema.parse(JSON.parse(raw));
    } catch (error: unknown) {
      throw new Error("Legacy ChatGPT connector state is invalid", { cause: error });
    }
    const state: ConnectorState = {
      schema_version: CONNECTOR_STATE_SCHEMA_VERSION,
      binding: legacy.bindings.find((binding) => binding.workspace_id === this.workspaceId) ?? null,
      evidence: [],
    };
    if (state.binding !== null) await this.writeState(state);
    return state;
  }

  private async writeState(state: ConnectorState): Promise<void> {
    const directory = dirname(this.file);
    const temporary = join(directory, `.chatgpt-connector-${process.pid}-${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try {
      await writeFile(temporary, `${JSON.stringify(stateSchema.parse(state), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.file);
      await chmod(this.file, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

const persistedOAuthClientSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  client_name: z.string().min(1).max(200),
  redirect_uris: z.array(z.string().url()).min(1).max(20),
  grant_types: z.array(z.string()).min(1).max(2),
  token_endpoint_auth_method: z.literal("none"),
  response_types: z.array(z.string()).min(1),
  created_at: z.number().int().nonnegative(),
}).strict();

const oauthClientStateSchema = z.object({
  version: z.literal(1),
  clients: z.array(persistedOAuthClientSchema),
}).strict();

const persistedOAuthTokenSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.enum(["access", "refresh"]),
  client_id: z.string().min(1),
  resource: z.string().url(),
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().positive(),
  revoked: z.boolean(),
}).strict();

const oauthTokenStateSchema = z.object({
  schema_version: z.literal(1),
  tokens: z.array(persistedOAuthTokenSchema),
}).strict();

export type OAuthLegacyMigrationStatus = "not_needed" | "migrated" | "reauthorization_required";

export interface WorkspaceOAuthState {
  readonly clientRegistryPath: string;
  readonly tokenStorePath: string;
  readonly migration: OAuthLegacyMigrationStatus;
}

export function workspaceOAuthStatePaths(
  workspaceId: string,
  storageRoot = defaultTaskContextStorageRoot(),
): Omit<WorkspaceOAuthState, "migration"> {
  const oauthRoot = join(workspaceStateRoot(storageRoot, workspaceId), "oauth");
  return {
    clientRegistryPath: join(oauthRoot, "clients.json"),
    tokenStorePath: join(oauthRoot, "tokens.json"),
  };
}

async function readOptionalJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.migration-${process.pid}-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function migrateLegacyOAuthState(options: {
  readonly workspaceId: string;
  readonly storageRoot?: string;
  readonly singleWorkspace: boolean;
  readonly now?: number;
}): Promise<WorkspaceOAuthState> {
  const storageRoot = resolve(options.storageRoot ?? defaultTaskContextStorageRoot());
  const paths = workspaceOAuthStatePaths(options.workspaceId, storageRoot);
  const [scopedClients, scopedTokens] = await Promise.all([
    readOptionalJson(paths.clientRegistryPath),
    readOptionalJson(paths.tokenStorePath),
  ]);
  if (scopedClients !== null) return { ...paths, migration: "not_needed" };

  const legacyOAuthRoot = join(storageRoot, "oauth");
  let legacyClientsRaw: unknown | null;
  let legacyTokensRaw: unknown | null;
  let legacyConnectorRaw: unknown | null;
  try {
    [legacyClientsRaw, legacyTokensRaw, legacyConnectorRaw] = await Promise.all([
      readOptionalJson(join(legacyOAuthRoot, "clients.json")),
      readOptionalJson(join(legacyOAuthRoot, "tokens.json")),
      readOptionalJson(legacyChatgptConnectorStateFile(storageRoot)),
    ]);
  } catch {
    return { ...paths, migration: "reauthorization_required" };
  }
  if (legacyClientsRaw === null && legacyTokensRaw === null) {
    return { ...paths, migration: "not_needed" };
  }

  const clients = oauthClientStateSchema.safeParse(legacyClientsRaw);
  const tokens = oauthTokenStateSchema.safeParse(legacyTokensRaw);
  const connectors = legacyStateSchema.safeParse(legacyConnectorRaw);
  if (!clients.success || !tokens.success || !connectors.success
    || !options.singleWorkspace || connectors.data.bindings.length !== 1) {
    return { ...paths, migration: "reauthorization_required" };
  }
  const binding = connectors.data.bindings[0];
  if (binding?.workspace_id !== options.workspaceId) {
    return { ...paths, migration: "reauthorization_required" };
  }
  const resources = new Set(
    [binding.verified_mcp_url, binding.pending_mcp_url]
      .filter((resource): resource is string => resource !== null)
      .map(normalizePublicUrl),
  );
  const clientIds = new Set(clients.data.clients.map((client) => client.client_id));
  const activeTokens = tokens.data.tokens.filter((token) =>
    !token.revoked && token.expires_at > (options.now ?? Date.now()));
  if (activeTokens.some((token) =>
    !resources.has(normalizePublicUrl(token.resource)) || !clientIds.has(token.client_id))) {
    return { ...paths, migration: "reauthorization_required" };
  }

  if (scopedTokens === null) {
    await writeAtomicJson(paths.tokenStorePath, { schema_version: 1, tokens: activeTokens });
  }
  await writeAtomicJson(paths.clientRegistryPath, clients.data);
  return { ...paths, migration: "migrated" };
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
    migration: OAuthLegacyMigrationStatus;
    reauthorization_required: boolean;
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
  migration: OAuthLegacyMigrationStatus,
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
      migration,
      reauthorization_required: migration === "reauthorization_required",
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
  const storageRoot = dependencies.storageRoot ?? defaultTaskContextStorageRoot();
  const store = new ChatGPTConnectorStore(workspace.id, storageRoot);
  const existing = await store.read();
  const oauthState = await migrateLegacyOAuthState({
    workspaceId: workspace.id,
    storageRoot,
    singleWorkspace: (settings.workspaces?.length ?? 1) === 1,
  });
  const currentMcpUrl = settings.remote.enabled
    ? mcpUrlFromPublic(settings.remote.endpoint)
    : null;
  const result = resultBase(workspace, existing, currentMcpUrl, oauthState.migration);
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
      workspaceName: workspace.name,
      currentMcpUrl,
    });
    result.ok = true;
    result.connector.name = prepared.binding.connector_name;
    result.connector.status = prepared.binding.status;
    result.connector.action = prepared.action;
    result.connector.verified_mcp_url = prepared.binding.verified_mcp_url;
    result.connector.reason = oauthState.migration === "reauthorization_required"
      ? "legacy_oauth_reauthorization_required"
      : prepared.action === "create"
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
  requestId: string,
  storageRoot?: string,
): Promise<ChatGPTConnectorBinding> {
  const workspace = activeWorkspace(settings);
  const currentMcpUrl = settings.remote.enabled
    ? mcpUrlFromPublic(settings.remote.endpoint)
    : null;
  if (currentMcpUrl === null) throw new Error("Current remote MCP URL is unavailable");
  return new ChatGPTConnectorStore(workspace.id, storageRoot).confirm(requestId, currentMcpUrl);
}

export function parseConnectorConfirmArgs(argv: readonly string[]): {
  readonly settingsArgs: string[];
  readonly requestId: string;
} {
  const settingsArgs: string[] = [];
  let requestId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--request-id") requestId = value;
    else if (["--config", "--port", "--workspace", "--token"].includes(argument)) {
      settingsArgs.push(argument, value);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
    index += 1;
  }
  if (!requestId) throw new Error("--request-id is required");
  const parsedRequestId = connectorRequestIdSchema.safeParse(requestId);
  if (!parsedRequestId.success) throw new Error("--request-id is invalid");
  return { settingsArgs, requestId: parsedRequestId.data };
}
