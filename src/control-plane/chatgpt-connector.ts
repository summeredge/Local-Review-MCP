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

/**
 * An adopted name is operator-supplied metadata: `workspace_info` evidence proves the workspace and
 * MCP resource, never the ChatGPT UI display name. It is validated against the binding schema rule
 * (1..200 after trimming) and never silently truncated.
 */
function normalizeConnectorName(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error("Connector name must not be blank");
  if (trimmed.length > 200) throw new Error("Connector name must be at most 200 characters");
  return trimmed;
}

/**
 * A Windows shell can leave escape residue around an operator-supplied name: `^` escaping a space,
 * or escaping a quote the shell consumed (`^Local^ MCP^ Connector^`). That residue is never part of
 * the name, but a caret escaping a letter is (`Plant ^A Connector`).
 */
function stripWindowsShellEscapeResidue(value: string): string {
  return value.replace(/^\^+|\^+(?=\s)|\^+$/g, "");
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
    connectorName?: string,
  ): Promise<ChatGPTConnectorBinding> {
    return this.exclusive(async () => {
      const safeRequestId = connectorRequestIdSchema.parse(requestId);
      const requestedName = connectorName === undefined ? null : normalizeConnectorName(connectorName);
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
      // Adoption stays behind the evidence gate above and only ever fills a binding that still has
      // to be verified; an existing verified binding must not be renamed through this path. A name
      // that only differs by recorded shell escape residue is the same connector, so it is stored
      // in its artifact-free spelling instead of counting as a rename.
      const recordedName = stripWindowsShellEscapeResidue(previous.connector_name);
      const sameConnector = requestedName === null
        || requestedName === previous.connector_name
        || requestedName === recordedName;
      if (!sameConnector && previous.status === "verified") {
        throw new Error("Verified ChatGPT connector binding cannot be renamed");
      }
      const binding: ChatGPTConnectorBinding = {
        ...previous,
        connector_name: requestedName ?? previous.connector_name,
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

type PersistedOAuthClient = z.infer<typeof persistedOAuthClientSchema>;
type PersistedOAuthToken = z.infer<typeof persistedOAuthTokenSchema>;

interface LegacyOAuthFiles {
  readonly clients: unknown;
  readonly tokens: unknown;
  readonly connector: unknown;
}

async function readLegacyOAuthFiles(storageRoot: string): Promise<LegacyOAuthFiles | null> {
  try {
    const oauthRoot = join(storageRoot, "oauth");
    const [clients, connector] = await Promise.all([
      readOptionalJson(join(oauthRoot, "clients.json")),
      readOptionalJson(legacyChatgptConnectorStateFile(storageRoot)),
    ]);
    // ponytail: token files are read separately because only the client registry decides migration.
    const tokens = await readOptionalJson(join(oauthRoot, "tokens.json")).catch(() => null);
    return { clients, tokens, connector };
  } catch {
    return null;
  }
}

/**
 * The pre-upgrade runtime shared one global OAuth registry and one legacy connector state file
 * across every workspace, so the legacy state only belongs to a workspace when it names that
 * workspace in exactly one binding. Anything else stays unproven and must not be migrated.
 */
function legacyWorkspaceBinding(
  connector: unknown,
  workspaceId: string,
): ChatGPTConnectorBinding | null {
  const connectors = legacyStateSchema.safeParse(connector);
  if (!connectors.success || connectors.data.bindings.length !== 1) return null;
  const binding = connectors.data.bindings[0];
  return binding?.workspace_id === workspaceId ? binding : null;
}

function legacyTokenResources(connector: unknown, workspaceId: string): ReadonlySet<string> | null {
  const binding = legacyWorkspaceBinding(connector, workspaceId);
  if (binding === null) return null;
  return new Set(
    [binding.verified_mcp_url, binding.pending_mcp_url]
      .filter((resource): resource is string => resource !== null)
      .map(normalizePublicUrl),
  );
}

function activeLegacyTokens(
  tokens: unknown,
  clientIds: ReadonlySet<string>,
  resources: ReadonlySet<string>,
  now: number,
): readonly PersistedOAuthToken[] {
  const parsed = oauthTokenStateSchema.safeParse(tokens);
  if (!parsed.success) return [];
  return parsed.data.tokens.filter((token) =>
    !token.revoked
    && token.expires_at > now
    && clientIds.has(token.client_id)
    && resources.has(normalizePublicUrl(token.resource)));
}

function sameClientRegistration(left: PersistedOAuthClient, right: PersistedOAuthClient): boolean {
  return left.client_id === right.client_id
    && left.client_secret === right.client_secret
    && left.client_name === right.client_name
    && left.created_at === right.created_at
    && left.grant_types.length === right.grant_types.length
    && left.grant_types.every((value, index) => value === right.grant_types[index])
    && left.response_types.length === right.response_types.length
    && left.response_types.every((value, index) => value === right.response_types[index])
    && left.redirect_uris.length === right.redirect_uris.length
    && left.redirect_uris.every((value, index) => value === right.redirect_uris[index]);
}

export async function migrateLegacyOAuthState(options: {
  readonly workspaceId: string;
  readonly storageRoot?: string;
  readonly singleWorkspace: boolean;
  readonly now?: number;
}): Promise<WorkspaceOAuthState> {
  const storageRoot = resolve(options.storageRoot ?? defaultTaskContextStorageRoot());
  const paths = workspaceOAuthStatePaths(options.workspaceId, storageRoot);
  const [scopedClientsRaw, scopedTokensRaw, legacy] = await Promise.all([
    readOptionalJson(paths.clientRegistryPath),
    readOptionalJson(paths.tokenStorePath),
    readLegacyOAuthFiles(storageRoot),
  ]);
  const parsedScoped = scopedClientsRaw === null
    ? null
    : oauthClientStateSchema.safeParse(scopedClientsRaw);
  if (parsedScoped !== null && !parsedScoped.success) {
    return { ...paths, migration: "reauthorization_required" };
  }
  const scopedClients = parsedScoped !== null && parsedScoped.success ? parsedScoped.data : null;
  if (legacy === null) {
    return {
      ...paths,
      migration: scopedClients === null ? "reauthorization_required" : "not_needed",
    };
  }
  if (legacy.clients === null && legacy.tokens === null) {
    return { ...paths, migration: "not_needed" };
  }

  const parsedLegacyClients = legacy.clients === null
    ? null
    : oauthClientStateSchema.safeParse(legacy.clients);
  // Importing the global legacy registry needs proven workspace ownership: one configured
  // workspace whose legacy connector state names it in a single valid binding. A missing, invalid,
  // foreign, or ambiguous legacy binding never proves ownership.
  const ownershipProven = options.singleWorkspace
    && legacyWorkspaceBinding(legacy.connector, options.workspaceId) !== null;
  const tokenResources = legacyTokenResources(legacy.connector, options.workspaceId);

  // Client registration migration and token migration stay independent: a missing, empty, or
  // stale legacy token set must never stop the legacy client_id from reaching the scoped registry.
  if (scopedClients === null) {
    if (!ownershipProven || parsedLegacyClients === null || !parsedLegacyClients.success) {
      return { ...paths, migration: "reauthorization_required" };
    }
    const clientIds = new Set(parsedLegacyClients.data.clients.map((client) => client.client_id));
    const tokens = tokenResources === null
      ? []
      : activeLegacyTokens(legacy.tokens, clientIds, tokenResources, options.now ?? Date.now());
    if (scopedTokensRaw === null) {
      await writeAtomicJson(paths.tokenStorePath, { schema_version: 1, tokens });
    }
    await writeAtomicJson(paths.clientRegistryPath, parsedLegacyClients.data);
    return { ...paths, migration: "migrated" };
  }

  // Idempotent reconcile: a scoped registry that already holds the exact legacy clients needs
  // nothing from the legacy global state, so it neither re-imports nor depends on the proof.
  if (parsedLegacyClients === null) return { ...paths, migration: "not_needed" };
  if (!parsedLegacyClients.success) return { ...paths, migration: "reauthorization_required" };
  const scopedById = new Map(
    scopedClients.clients.map((client) => [client.client_id, client] as const),
  );
  const unresolved = parsedLegacyClients.data.clients.some((client) => {
    const scopedClient = scopedById.get(client.client_id);
    return scopedClient === undefined || !sameClientRegistration(scopedClient, client);
  });
  if (!unresolved) return { ...paths, migration: "not_needed" };
  if (!ownershipProven) return { ...paths, migration: "reauthorization_required" };
  const merged = [...scopedClients.clients];
  for (const client of parsedLegacyClients.data.clients) {
    const scopedClient = scopedById.get(client.client_id);
    if (scopedClient === undefined) {
      merged.push(client);
      continue;
    }
    if (!sameClientRegistration(scopedClient, client)) {
      return { ...paths, migration: "reauthorization_required" };
    }
  }
  if (merged.length === scopedClients.clients.length) {
    return { ...paths, migration: "not_needed" };
  }
  await writeAtomicJson(paths.clientRegistryPath, { version: 1, clients: merged });
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

/**
 * OAuth readiness keeps one reason per missing capability so `diagnose:chatgpt-connector` names the
 * exact layer that blocks ChatGPT instead of a single merged failure.
 */
function oauthCapabilityFailure(metadata: Record<string, unknown>): string | null {
  if (!validHttpUrl(metadata.issuer)) return "oauth_issuer_invalid";
  if (!validHttpUrl(metadata.authorization_endpoint)) return "oauth_authorization_endpoint_missing";
  if (!validHttpUrl(metadata.token_endpoint)) return "oauth_token_endpoint_missing";
  if (!validHttpUrl(metadata.registration_endpoint)) return "oauth_registration_not_supported";
  if (!stringList(metadata.response_types_supported).includes("code")
    || !stringList(metadata.grant_types_supported).includes("authorization_code")) {
    return "oauth_authorization_code_not_supported";
  }
  if (!stringList(metadata.grant_types_supported).includes("refresh_token")) {
    return "oauth_refresh_token_not_supported";
  }
  if (!stringList(metadata.code_challenge_methods_supported).includes("S256")) {
    return "oauth_pkce_s256_not_supported";
  }
  return null;
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
    if (protectedMetadata === null || !validHttpUrl(protectedMetadata.resource)) {
      result.connector.reason = "oauth_protected_resource_metadata_invalid";
      return result;
    }
    if (normalizePublicUrl(protectedMetadata.resource) !== normalizePublicUrl(currentMcpUrl)) {
      result.connector.reason = "oauth_resource_mismatch";
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
    // `/health` only proves network reachability; OAuth readiness needs the full metadata document.
    const capabilityFailure = oauthCapabilityFailure(authorizationMetadata);
    result.oauth.ready = capabilityFailure === null;
    if (capabilityFailure !== null) {
      result.connector.reason = capabilityFailure;
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
  connectorName?: string,
): Promise<ChatGPTConnectorBinding> {
  const workspace = activeWorkspace(settings);
  const currentMcpUrl = settings.remote.enabled
    ? mcpUrlFromPublic(settings.remote.endpoint)
    : null;
  if (currentMcpUrl === null) throw new Error("Current remote MCP URL is unavailable");
  return new ChatGPTConnectorStore(workspace.id, storageRoot)
    .confirm(requestId, currentMcpUrl, Date.now(), connectorName);
}

export function parseConnectorConfirmArgs(argv: readonly string[]): {
  readonly settingsArgs: string[];
  readonly requestId: string;
  readonly connectorName?: string;
} {
  const settingsArgs: string[] = [];
  let requestId: string | undefined;
  let connectorName: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (argument === "--request-id") requestId = value;
    else if (argument === "--connector-name") connectorName = value;
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
  return {
    settingsArgs,
    requestId: parsedRequestId.data,
    // The CLI is the shell boundary: escape residue is dropped here and never reaches storage.
    connectorName: connectorName === undefined
      ? undefined
      : normalizeConnectorName(stripWindowsShellEscapeResidue(connectorName)),
  };
}
