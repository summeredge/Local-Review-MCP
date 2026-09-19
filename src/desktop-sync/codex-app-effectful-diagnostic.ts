import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolRequestParams } from "@modelcontextprotocol/sdk/types.js";
import {
  CodexAppMcpDiagnosticError,
  connectCodexAppMcp,
  discoverCodexAppMcpRuntime,
  parseCodexAppMcpDiagnosticArgs,
  type CodexAppMcpDiagnosticArgs,
  type CodexAppMcpDiagnosticDependencies,
  type CodexAppMcpDiagnosticStage,
  type CodexAppMcpRuntime,
} from "./codex-app-mcp-diagnostic.js";

const CREATE_PROMPT = "Only return LRM_CODEX_APP_P5_1_CREATE_PASS. Do not modify any files, create commits, or push.";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 120_000;
const EXECUTOR_METADATA_KEY = "openai/threadId" as const;
const EXECUTOR_METADATA_ERROR_TEXT = "codex app tools require thread metadata from the executor.";
const NATIVE_REQUEST_ERROR_TEXT = "invalid app tool request";
const EXECUTOR_METADATA_ERROR_FINGERPRINT = "9eb0c658fe43c9440be141bdfba1c400db55308b73a48decbcc8ecdc84f1dca9";
const NATIVE_REQUEST_ERROR_FINGERPRINT = "4ba5282b280ceabcfb431897e91c387578cabc4be5572d19493465f8927a5bd9";
const READ_ONLY_ALLOWLIST = new Set(["list_projects"]);
const EFFECTFUL_ALLOWLIST = new Set(["create_thread"]);

export type CreateThreadFailureClass =
  | "approval_required"
  | "permission_denied"
  | "invalid_project"
  | "invalid_worktree"
  | "invalid_target"
  | "invalid_argument"
  | "caller_not_authorized"
  | "desktop_context_required"
  | "native_bridge_rejected"
  | "writer_conflict"
  | "internal_tool_error"
  | "unknown_tool_error";

export type MetadataGateFailureClass =
  | "executor_metadata_rejected"
  | "native_request_invalid"
  | "list_projects_failed";

export type CodexAppEffectfulFailureClass = CreateThreadFailureClass | MetadataGateFailureClass;

export type CodexAppEffectfulDiagnosticStage =
  | Exclude<CodexAppMcpDiagnosticStage, "ok">
  | "effectful_confirmation_required"
  | "executor_thread_required"
  | "metadata_gate_passed"
  | "create_thread_schema_incompatible"
  | "create_thread_failed"
  | "create_thread_succeeded"
  | "thread_identity_missing"
  | "list_projects_schema_incompatible"
  | "list_projects_failed"
  | "desktop_project_not_found"
  | "desktop_project_ambiguous";

// Kept as the old public name for callers that imported the P5.1 result type.
export type CodexAppEffectfulErrorClass = CreateThreadFailureClass | MetadataGateFailureClass;

export interface CodexAppEffectfulDiagnosticArgs extends CodexAppMcpDiagnosticArgs {
  readonly confirmEffectful: boolean;
  readonly waitAfterFailureMs: number;
  readonly executorThreadId?: string;
}

export interface CodexAppEffectfulDiagnosticDependencies extends CodexAppMcpDiagnosticDependencies {
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly workspacePath?: string;
}

export interface CreateThreadSchemaSummary {
  readonly required: readonly string[];
  readonly properties: readonly string[];
  readonly targetVariants: readonly SchemaVariantSummary[];
  readonly projectTargetRequired: readonly string[];
  readonly environmentVariants: readonly SchemaVariantSummary[];
}

export interface SchemaVariantSummary {
  readonly type?: string;
  readonly typeEnum?: readonly string[];
  readonly required: readonly string[];
}

export interface CodexAppEffectfulDiagnosticResult {
  readonly ok: boolean;
  readonly result: "pass" | "fail";
  readonly stage: CodexAppEffectfulDiagnosticStage;
  readonly connected: boolean;
  readonly effectfulConfirmed: boolean;
  readonly executorThreadProvided: boolean;
  readonly executorThreadSuffix?: string;
  readonly executorMetadataKey: typeof EXECUTOR_METADATA_KEY;
  readonly initialized: boolean;
  readonly toolsListed: boolean;
  readonly toolCount: number;
  readonly tools: readonly string[];
  readonly listProjectsCalled: boolean;
  readonly listProjectsSucceeded: boolean;
  readonly projectCount: number;
  readonly metadataGatePassed: boolean | null;
  readonly resolvedProject: boolean;
  readonly projectResolutionSource?: "list_projects";
  readonly resolvedProjectId?: string;
  readonly createThreadCalled: boolean;
  readonly threadCreated: boolean;
  readonly threadIdSuffix?: string;
  readonly hostId?: string;
  readonly sendMessageCalled: false;
  readonly readThreadCalled: false;
  readonly waitThreadsCalled: false;
  readonly sameThread: false;
  readonly writerConflictObserved: boolean;
  readonly targetType?: "project";
  readonly environmentType?: "local" | "worktree";
  readonly targetSchemaValid: boolean;
  readonly createThreadSchema?: CreateThreadSchemaSummary;
  readonly argumentKeys: readonly string[];
  readonly isError?: boolean | null;
  readonly contentItemTypes: readonly string[];
  readonly structuredContentPresent: boolean;
  readonly errorFields: readonly string[];
  readonly errorCode?: string | number;
  readonly errorType?: string;
  readonly errorName?: string;
  readonly sdkErrorClass?: string;
  readonly sdkCauseClass?: string;
  readonly failureClass?: CodexAppEffectfulFailureClass;
  readonly hasErrorText: boolean;
  readonly errorFingerprint?: string;
  readonly waitAfterFailureMs: number;
  readonly desktopApprovalUi: "manual_observation_required" | "not_observed";
  readonly durationMs: number;
  readonly desktopDetected?: boolean;
  readonly bundleDetected?: boolean;
  readonly mcpTransport?: "stdio";
  readonly nativeDesktopTransport?: "windows_named_pipe" | "unknown";
  readonly desktopVersion?: string;
  readonly codexVersion?: string;
  readonly codexAppToolsVersion?: string;
  readonly pipeDiscovery?: "explicit_override" | "current_environment" | "unavailable";
}

type JsonSchema = Readonly<Record<string, unknown>>;
type ToolContract = Readonly<{ name: string; inputSchema: JsonSchema }>;

interface MutableResultState {
  connected: boolean;
  effectfulConfirmed: boolean;
  executorThreadProvided: boolean;
  executorThreadSuffix?: string;
  executorMetadataKey: typeof EXECUTOR_METADATA_KEY;
  initialized: boolean;
  toolsListed: boolean;
  toolCount: number;
  tools: string[];
  listProjectsCalled: boolean;
  listProjectsSucceeded: boolean;
  projectCount: number;
  metadataGatePassed: boolean | null;
  resolvedProject: boolean;
  projectResolutionSource?: "list_projects";
  resolvedProjectId?: string;
  createThreadCalled: boolean;
  threadCreated: boolean;
  threadIdSuffix?: string;
  hostId?: string;
  writerConflictObserved: boolean;
  targetType?: "project";
  environmentType?: "local" | "worktree";
  targetSchemaValid: boolean;
  createThreadSchema?: CreateThreadSchemaSummary;
  argumentKeys: string[];
  isError?: boolean | null;
  contentItemTypes: string[];
  structuredContentPresent: boolean;
  errorFields: string[];
  errorCode?: string | number;
  errorType?: string;
  errorName?: string;
  sdkErrorClass?: string;
  sdkCauseClass?: string;
  failureClass?: CodexAppEffectfulFailureClass;
  hasErrorText: boolean;
  errorFingerprint?: string;
  waitAfterFailureMs: number;
  desktopApprovalUi: "manual_observation_required" | "not_observed";
  durationMs: number;
  desktopDetected?: boolean;
  bundleDetected?: boolean;
  mcpTransport?: "stdio";
  nativeDesktopTransport?: "windows_named_pipe" | "unknown";
  desktopVersion?: string;
  codexVersion?: string;
  codexAppToolsVersion?: string;
  pipeDiscovery?: "explicit_override" | "current_environment" | "unavailable";
}

interface CreateThreadPlan {
  readonly schema: CreateThreadSchemaSummary;
  readonly environmentType: "local" | "worktree";
  readonly build: (prompt: string, projectId: string) => Record<string, unknown>;
}

interface DesktopProject {
  readonly projectId: string;
  readonly path: string;
  readonly projectKind: string;
  readonly hostId: string;
}

interface ErrorEvidence {
  readonly isError: boolean | null;
  readonly contentItemTypes: readonly string[];
  readonly structuredContentPresent: boolean;
  readonly errorFields: readonly string[];
  readonly errorCode?: string | number;
  readonly errorType?: string;
  readonly errorName?: string;
  readonly sdkErrorClass?: string;
  readonly sdkCauseClass?: string;
  readonly failureClass: CreateThreadFailureClass;
  readonly normalizedErrorText: string;
  readonly hasErrorText: boolean;
  readonly errorFingerprint?: string;
}

interface ListProjectsFailureClassification {
  readonly failureClass: MetadataGateFailureClass;
  readonly metadataGatePassed: boolean | null;
}

class ToolCallTimeout extends Error {}
class DiagnosticInterrupted extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function schemaRecord(value: unknown): JsonSchema | undefined {
  return isRecord(value) ? value : undefined;
}

function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const result: Record<string, JsonSchema> = {};
  for (const [name, value] of Object.entries(properties)) {
    const property = schemaRecord(value);
    if (property !== undefined) result[name] = property;
  }
  return result;
}

function requiredFields(schema: JsonSchema): readonly string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
}

function requirementsWithin(schema: JsonSchema, allowed: ReadonlySet<string>): boolean {
  return requiredFields(schema).every((field) => allowed.has(field));
}

function schemaBranches(schema: JsonSchema): readonly JsonSchema[] {
  const branches: JsonSchema[] = [schema];
  for (const key of ["anyOf", "oneOf"]) {
    if (!Array.isArray(schema[key])) continue;
    for (const value of schema[key]) {
      const branch = schemaRecord(value);
      if (branch !== undefined) branches.push(...schemaBranches(branch));
    }
  }
  return branches;
}

function schemaType(schema: JsonSchema, expected: string): boolean {
  if (schema.type === expected) return true;
  return Array.isArray(schema.type) && schema.type.includes(expected);
}

function isStringSchema(schema: JsonSchema | undefined): boolean {
  if (schema === undefined) return false;
  if (schemaType(schema, "string")) return true;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.every((value) => typeof value === "string");
  }
  return schemaBranches(schema).some((branch) => branch !== schema && isStringSchema(branch));
}

function acceptsLiteral(schema: JsonSchema | undefined, value: string): boolean {
  if (schema === undefined) return false;
  if (schema.const === value) return true;
  return Array.isArray(schema.enum) && schema.enum.includes(value);
}

function variantForType(schema: JsonSchema | undefined, value: string): JsonSchema | undefined {
  if (schema === undefined) return undefined;
  for (const branch of schemaBranches(schema)) {
    if (acceptsLiteral(schemaProperties(branch).type, value)) return branch;
  }
  return undefined;
}

function toolContracts(value: readonly unknown[]): Map<string, ToolContract> {
  const result = new Map<string, ToolContract>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const name = nonEmpty(candidate.name);
    const inputSchema = schemaRecord(candidate.inputSchema);
    if (name !== undefined && inputSchema !== undefined) result.set(name, { name, inputSchema });
  }
  return result;
}

function validateListProjectsTool(tool: ToolContract | undefined): boolean {
  return tool !== undefined && requiredFields(tool.inputSchema).length === 0;
}

function parseJsonText(value: string): unknown {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function projectRecords(value: unknown, output: Record<string, unknown>[] = [], seen = new Set<object>()): readonly Record<string, unknown>[] {
  if (typeof value === "string") {
    const parsed = parseJsonText(value);
    if (parsed !== undefined) projectRecords(parsed, output, seen);
    return output;
  }
  if (!isRecord(value) && !Array.isArray(value)) return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (isRecord(value) && Array.isArray(value.projects)) {
    for (const project of value.projects) if (isRecord(project)) output.push(project);
    return output;
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) projectRecords(nested, output, seen);
  return output;
}

function normalizePathForMatch(value: string): string {
  return resolve(value).replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
}

function resolveDesktopProject(value: unknown, workspacePath: string): readonly DesktopProject[] {
  const expectedPath = normalizePathForMatch(workspacePath);
  return projectRecords(value)
    .map((project) => {
      const projectId = nonEmpty(project.projectId);
      const path = nonEmpty(project.path);
      const projectKind = nonEmpty(project.projectKind);
      const hostId = nonEmpty(project.hostId);
      if (projectId === undefined || path === undefined || projectKind === undefined || hostId === undefined) {
        return undefined;
      }
      return { projectId, path, projectKind, hostId };
    })
    .filter((project): project is DesktopProject => project !== undefined)
    .filter((project) => normalizePathForMatch(project.path) === expectedPath)
    .filter((project) => project.projectKind === "local" && project.hostId === "local");
}

function schemaSummary(schema: JsonSchema): CreateThreadSchemaSummary {
  const properties = schemaProperties(schema);
  const targetSchema = properties.target;
  const targetVariants = unionBranches(targetSchema).map(schemaVariantSummary);
  const projectTarget = variantForType(targetSchema, "project");
  const projectProperties = projectTarget === undefined ? {} : schemaProperties(projectTarget);
  return {
    required: requiredFields(schema),
    properties: Object.keys(properties),
    targetVariants,
    projectTargetRequired: projectTarget === undefined ? [] : [...requiredFields(projectTarget)],
    environmentVariants: unionBranches(projectProperties.environment).map(schemaVariantSummary),
  };
}

function unionBranches(schema: JsonSchema | undefined): readonly JsonSchema[] {
  if (schema === undefined) return [];
  for (const key of ["anyOf", "oneOf"]) {
    if (!Array.isArray(schema[key])) continue;
    const branches = schema[key]
      .map((value) => schemaRecord(value))
      .filter((value): value is JsonSchema => value !== undefined);
    if (branches.length > 0) return branches;
  }
  return [schema];
}

function literalValues(schema: JsonSchema | undefined): readonly string[] {
  if (schema === undefined) return [];
  const values: string[] = [];
  if (typeof schema.const === "string") values.push(schema.const);
  if (Array.isArray(schema.enum)) {
    for (const value of schema.enum) if (typeof value === "string") values.push(value);
  }
  return [...new Set(values)];
}

function schemaVariantSummary(schema: JsonSchema): SchemaVariantSummary {
  const values = literalValues(schemaProperties(schema).type);
  return {
    ...(values[0] === undefined ? {} : { type: values[0] }),
    ...(values.length === 0 ? {} : { typeEnum: values }),
    required: [...requiredFields(schema)],
  };
}

function validateCreateThreadTool(tool: ToolContract | undefined): CreateThreadPlan | undefined {
  if (tool === undefined) return undefined;
  const schema = tool.inputSchema;
  const properties = schemaProperties(schema);
  if (!requirementsWithin(schema, new Set(["prompt", "target"]))) return undefined;
  if (!isStringSchema(properties.prompt)) return undefined;

  const projectTarget = variantForType(properties.target, "project");
  if (projectTarget === undefined) return undefined;
  const targetProperties = schemaProperties(projectTarget);
  if (!requirementsWithin(projectTarget, new Set(["type", "projectId", "environment"]))) return undefined;
  if (!isStringSchema(targetProperties.projectId)) return undefined;

  const localEnvironment = variantForType(targetProperties.environment, "local");
  if (localEnvironment === undefined || !requirementsWithin(localEnvironment, new Set(["type"]))) return undefined;

  return {
    schema: schemaSummary(schema),
    environmentType: "local",
    build: (prompt, projectId) => ({
      prompt,
      target: {
        type: "project",
        projectId,
        environment: { type: "local" },
      },
    }),
  };
}

function safeScalar(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return value;
  return undefined;
}

function safeClass(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_$.-]{1,128}$/.test(value) ? value : undefined;
}

function contentInfo(value: unknown): { types: string[]; texts: string[] } {
  if (!isRecord(value) || !Array.isArray(value.content)) return { types: [], texts: [] };
  const types: string[] = [];
  const texts: string[] = [];
  for (const item of value.content) {
    if (!isRecord(item)) continue;
    if (typeof item.type === "string") types.push(item.type);
    if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
  }
  return { types: [...new Set(types)], texts };
}

function errorSources(value: unknown): readonly Record<string, unknown>[] {
  if (value instanceof Error) {
    const source: Record<string, unknown> = {
      code: (value as Error & { code?: unknown }).code,
      name: value.name,
      message: value.message,
      cause: value.cause,
    };
    return [source, ...(isRecord(value.cause) ? [value.cause] : [])];
  }
  if (!isRecord(value)) return [];
  const sources: Record<string, unknown>[] = [value];
  if (isRecord(value.error)) sources.push(value.error);
  if (isRecord(value.data)) sources.push(value.data);
  if (isRecord(value.structuredContent)) {
    sources.push(value.structuredContent);
    if (isRecord(value.structuredContent.error)) sources.push(value.structuredContent.error);
  }
  return sources;
}

function errorTexts(value: unknown, contentTexts: readonly string[]): readonly string[] {
  const texts = [...contentTexts];
  for (const source of errorSources(value)) {
    if (typeof source.message === "string") texts.push(source.message);
  }
  return texts.filter((text) => text.trim() !== "");
}

function normalizedErrorText(texts: readonly string[]): string {
  return texts.map((text) => text.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean).join(" | ");
}

function classifyCreateFailure(text: string, code?: string | number): CreateThreadFailureClass {
  if (/active writer|open in another app|writer conflict/.test(text)) return "writer_conflict";
  if (/approval|approv(e|al)|confirmation required|confirm this/.test(text)) return "approval_required";
  if (/caller|client/.test(text) && /unauthor|not authorized|not allowed/.test(text)) return "caller_not_authorized";
  if (/permission denied|access denied|forbidden/.test(text)) return "permission_denied";
  if (/worktree|work tree|checkout/.test(text)) return "invalid_worktree";
  if (/environment|target/.test(text) && /invalid|missing|not found|failed|error/.test(text)) return "invalid_target";
  if (/projectid|project id|project|not found|does not exist/.test(text)) return "invalid_project";
  if (/invalid argument|invalid parameter|missing required|unknown argument|schema/.test(text)) return "invalid_argument";
  if (/desktop context|desktop ui|desktop is required|requires desktop/.test(text)) return "desktop_context_required";
  if (/native bridge|named pipe|pipe|connection/.test(text) && /reject|denied|failed|closed|unavailable/.test(text)) {
    return "native_bridge_rejected";
  }
  if (/internal error|unexpected error|exception/.test(text)) return "internal_tool_error";
  if (code === -32602 || code === "INVALID_PARAMS" || code === "INVALID_ARGUMENT") return "invalid_argument";
  return "unknown_tool_error";
}

function createFailureEvidence(value: unknown): ErrorEvidence {
  const content = contentInfo(value);
  const texts = errorTexts(value, content.texts);
  const normalized = normalizedErrorText(texts);
  const sources = errorSources(value);
  const fields = new Set<string>();
  for (const source of sources) {
    for (const field of ["error", "code", "type", "name"]) {
      if (Object.prototype.hasOwnProperty.call(source, field)) fields.add(field);
    }
  }
  const first = sources[0] ?? {};
  const errorSource = sources.find((source) => isRecord(source.error))?.error;
  const error = isRecord(errorSource) ? errorSource : undefined;
  const code = safeScalar(first.code) ?? safeScalar(error?.code);
  const type = safeClass(first.type) ?? safeClass(error?.type);
  const name = safeClass(first.name) ?? safeClass(error?.name);
  const sdkErrorClass = value instanceof Error ? safeClass(value.constructor.name) : undefined;
  const cause = value instanceof Error ? value.cause : undefined;
  const sdkCauseClass = cause instanceof Error ? safeClass(cause.constructor.name) : undefined;
  const isError = isRecord(value) && typeof value.isError === "boolean" ? value.isError : null;
  return {
    isError,
    contentItemTypes: content.types,
    structuredContentPresent: isRecord(value) && Object.prototype.hasOwnProperty.call(value, "structuredContent"),
    errorFields: [...fields].sort(),
    ...(code === undefined ? {} : { errorCode: code }),
    ...(type === undefined ? {} : { errorType: type }),
    ...(name === undefined ? {} : { errorName: name }),
    ...(sdkErrorClass === undefined ? {} : { sdkErrorClass }),
    ...(sdkCauseClass === undefined ? {} : { sdkCauseClass }),
    failureClass: classifyCreateFailure(normalized, code),
    normalizedErrorText: normalized,
    hasErrorText: texts.length > 0,
    ...(normalized === "" ? {} : { errorFingerprint: createHash("sha256").update(normalized, "utf8").digest("hex") }),
  };
}

function classifyListProjectsFailure(
  evidence: ErrorEvidence,
  requestReturned: boolean,
): ListProjectsFailureClassification {
  if (evidence.errorFingerprint === EXECUTOR_METADATA_ERROR_FINGERPRINT
    || evidence.normalizedErrorText.includes(EXECUTOR_METADATA_ERROR_TEXT)) {
    return { failureClass: "executor_metadata_rejected", metadataGatePassed: false };
  }
  if (evidence.errorFingerprint === NATIVE_REQUEST_ERROR_FINGERPRINT
    || evidence.normalizedErrorText.includes(NATIVE_REQUEST_ERROR_TEXT)) {
    return { failureClass: "native_request_invalid", metadataGatePassed: true };
  }
  return {
    failureClass: "list_projects_failed",
    metadataGatePassed: requestReturned ? true : null,
  };
}

function applyFailureEvidence(state: MutableResultState, evidence: ErrorEvidence): void {
  state.isError = evidence.isError;
  state.contentItemTypes = [...evidence.contentItemTypes];
  state.structuredContentPresent = evidence.structuredContentPresent;
  state.errorFields = [...evidence.errorFields];
  state.errorCode = evidence.errorCode;
  state.errorType = evidence.errorType;
  state.errorName = evidence.errorName;
  state.sdkErrorClass = evidence.sdkErrorClass;
  state.sdkCauseClass = evidence.sdkCauseClass;
  state.failureClass = evidence.failureClass;
  state.hasErrorText = evidence.hasErrorText;
  state.errorFingerprint = evidence.errorFingerprint;
  state.writerConflictObserved = evidence.failureClass === "writer_conflict";
}

function identityOf(value: unknown): { threadId?: string; hostId?: string } {
  if (typeof value === "string") {
    const parsed = parseJsonText(value);
    return parsed === undefined ? {} : identityOf(parsed);
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      const identity = identityOf(nested);
      if (identity.threadId !== undefined) return identity;
    }
    return {};
  }
  if (!isRecord(value)) return {};
  const threadId = nonEmpty(value.threadId);
  const hostId = nonEmpty(value.hostId);
  if (threadId !== undefined) return { threadId, ...(hostId === undefined ? {} : { hostId }) };
  for (const nested of Object.values(value)) {
    const identity = identityOf(nested);
    if (identity.threadId !== undefined) return identity;
  }
  return {};
}

function safeIdentity(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ? value : undefined;
}

function copyRuntimeState(state: MutableResultState, runtime: CodexAppMcpRuntime): void {
  state.desktopDetected = runtime.desktopDetected;
  state.bundleDetected = runtime.bundleDetected;
  state.mcpTransport = runtime.mcpTransport;
  state.nativeDesktopTransport = runtime.nativeDesktopTransport;
  state.desktopVersion = runtime.desktopVersion;
  state.codexVersion = runtime.codexVersion;
  state.codexAppToolsVersion = runtime.codexAppToolsVersion;
  state.pipeDiscovery = runtime.pipeDiscovery;
}

function copyDiagnosticErrorState(state: MutableResultState, error: CodexAppMcpDiagnosticError): void {
  const diagnostic = error.state;
  state.desktopDetected = diagnostic.desktopDetected;
  state.bundleDetected = diagnostic.bundleDetected;
  state.mcpTransport = diagnostic.mcpTransport;
  state.nativeDesktopTransport = diagnostic.nativeDesktopTransport;
  state.desktopVersion = diagnostic.desktopVersion;
  state.codexVersion = diagnostic.codexVersion;
  state.codexAppToolsVersion = diagnostic.codexAppToolsVersion;
  state.pipeDiscovery = diagnostic.pipeDiscovery;
}

function executorThreadSuffix(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= 8) return undefined;
  return value.slice(-8);
}

function initialState(
  effectfulConfirmed: boolean,
  waitAfterFailureMs: number,
  executorThreadId: string | undefined,
  now: () => number,
): MutableResultState {
  return {
    connected: false,
    effectfulConfirmed,
    executorThreadProvided: executorThreadId !== undefined,
    ...(executorThreadSuffix(executorThreadId) === undefined
      ? {}
      : { executorThreadSuffix: executorThreadSuffix(executorThreadId) }),
    executorMetadataKey: EXECUTOR_METADATA_KEY,
    initialized: false,
    toolsListed: false,
    toolCount: 0,
    tools: [],
    listProjectsCalled: false,
    listProjectsSucceeded: false,
    projectCount: 0,
    metadataGatePassed: false,
    resolvedProject: false,
    createThreadCalled: false,
    threadCreated: false,
    writerConflictObserved: false,
    targetSchemaValid: false,
    argumentKeys: [],
    contentItemTypes: [],
    structuredContentPresent: false,
    errorFields: [],
    hasErrorText: false,
    waitAfterFailureMs,
    desktopApprovalUi: "not_observed",
    durationMs: now(),
  };
}

function finish(
  state: MutableResultState,
  stage: CodexAppEffectfulDiagnosticStage,
  startedAt: number,
  now: () => number,
): CodexAppEffectfulDiagnosticResult {
  const passed = stage === "metadata_gate_passed" || stage === "create_thread_succeeded";
  return {
    ...state,
    sendMessageCalled: false,
    readThreadCalled: false,
    waitThreadsCalled: false,
    sameThread: false,
    ok: passed,
    result: passed ? "pass" : "fail",
    stage,
    durationMs: Math.max(0, now() - startedAt),
  };
}

async function waitAfterFailure(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    const finishWait = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finishWait);
      resolve();
    };
    const timer = setTimeout(finishWait, milliseconds);
    signal.addEventListener("abort", finishWait, { once: true });
  });
}

async function callAllowedTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  executorThreadId: string,
  timeoutMs: number,
  signal: AbortSignal,
  allowlist: ReadonlySet<string>,
): Promise<unknown> {
  if (!allowlist.has(name)) throw new Error("disallowed diagnostic tool");
  if (signal.aborted) throw new DiagnosticInterrupted();
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  try {
    const params: CallToolRequestParams = {
      name,
      arguments: args,
      _meta: { [EXECUTOR_METADATA_KEY]: executorThreadId },
    };
    const request = client.callTool(params, undefined, { signal: controller.signal });
    const interrupted = new Promise<never>((_, reject) => {
      abortHandler = (): void => {
        controller.abort();
        reject(new DiagnosticInterrupted());
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    });
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new ToolCallTimeout());
      }, Math.max(1, timeoutMs));
    });
    return await Promise.race([request, interrupted, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (abortHandler !== undefined) signal.removeEventListener("abort", abortHandler);
  }
}

function parseArgs(argv: readonly string[]): CodexAppEffectfulDiagnosticArgs {
  let confirmEffectful = false;
  let waitAfterFailureMs = 0;
  let executorThreadId: string | undefined;
  const connectionArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--confirm-effectful") {
      confirmEffectful = true;
    } else if (argument === "--executor-thread") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") {
        throw new Error(`${argument} requires a value.`);
      }
      executorThreadId = value.trim();
      index += 1;
    } else if (argument === "--wait-after-failure-ms") {
      const value = argv[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${argument} requires a non-negative integer.`);
      waitAfterFailureMs = Math.min(MAX_TIMEOUT_MS, Number(value));
      index += 1;
    } else {
      connectionArgs.push(argument);
    }
  }
  return {
    confirmEffectful,
    waitAfterFailureMs,
    ...(executorThreadId === undefined ? {} : { executorThreadId }),
    ...parseCodexAppMcpDiagnosticArgs(connectionArgs),
  };
}

export function parseCodexAppEffectfulDiagnosticArgs(
  argv: readonly string[] = [],
): CodexAppEffectfulDiagnosticArgs {
  return parseArgs(argv);
}

export async function runCodexAppEffectfulDiagnostic(
  argv: readonly string[] = [],
  dependencies: CodexAppEffectfulDiagnosticDependencies = {},
): Promise<CodexAppEffectfulDiagnosticResult> {
  const args = parseArgs(argv);
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const executorThreadId = args.executorThreadId;
  const state = initialState(args.confirmEffectful, args.waitAfterFailureMs, executorThreadId, now);
  if (!args.confirmEffectful) return finish(state, "effectful_confirmation_required", startedAt, now);
  if (executorThreadId === undefined) return finish(state, "executor_thread_required", startedAt, now);

  const timeoutMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
  const abortController = new AbortController();
  let interrupted = false;
  const stop = (): void => {
    interrupted = true;
    abortController.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let client: Client | undefined;
  let transport: { close(): Promise<void> } | undefined;
  try {
    let runtime: CodexAppMcpRuntime;
    try {
      runtime = await discoverCodexAppMcpRuntime({
        ...dependencies,
        serverPath: args.serverPath ?? dependencies.serverPath,
        pipePath: args.pipePath ?? dependencies.pipePath,
      });
      copyRuntimeState(state, runtime);
    } catch (error: unknown) {
      if (error instanceof CodexAppMcpDiagnosticError) copyDiagnosticErrorState(state, error);
      return finish(
        state,
        error instanceof CodexAppMcpDiagnosticError ? error.stage : "runtime_contract_unknown",
        startedAt,
        now,
      );
    }

    try {
      const connected = await connectCodexAppMcp(runtime, { ...dependencies, signal: abortController.signal });
      client = connected.client;
      transport = connected.transport;
      state.connected = true;
      state.initialized = true;
    } catch {
      return finish(state, interrupted ? "diagnostic_interrupted" : "mcp_initialize_failed", startedAt, now);
    }

    let listed: Awaited<ReturnType<Client["listTools"]>>;
    try {
      listed = await client.listTools(undefined, { signal: abortController.signal });
      state.toolsListed = true;
      state.toolCount = listed.tools.length;
      state.tools = listed.tools.map((tool) => tool.name);
    } catch {
      return finish(state, interrupted ? "diagnostic_interrupted" : "tools_list_failed", startedAt, now);
    }

    const contracts = toolContracts(listed.tools);
    const listProjectsTool = contracts.get("list_projects");
    if (!validateListProjectsTool(listProjectsTool)) {
      return finish(state, "list_projects_schema_incompatible", startedAt, now);
    }

    state.listProjectsCalled = true;
    let projectsResult: unknown;
    try {
      projectsResult = await callAllowedTool(
        client,
        "list_projects",
        {},
        executorThreadId,
        timeoutMs,
        abortController.signal,
        READ_ONLY_ALLOWLIST,
      );
    } catch (error: unknown) {
      const evidence = createFailureEvidence(error);
      applyFailureEvidence(state, evidence);
      const classification = classifyListProjectsFailure(evidence, false);
      state.failureClass = classification.failureClass;
      state.metadataGatePassed = classification.metadataGatePassed;
      return finish(state, interrupted ? "diagnostic_interrupted" : "list_projects_failed", startedAt, now);
    }
    if (isRecord(projectsResult) && projectsResult.isError === true) {
      const evidence = createFailureEvidence(projectsResult);
      applyFailureEvidence(state, evidence);
      const classification = classifyListProjectsFailure(evidence, true);
      state.failureClass = classification.failureClass;
      state.metadataGatePassed = classification.metadataGatePassed;
      return finish(state, "list_projects_failed", startedAt, now);
    }

    state.metadataGatePassed = true;
    state.listProjectsSucceeded = true;
    state.projectCount = projectRecords(projectsResult).length;

    state.projectResolutionSource = "list_projects";
    const projects = resolveDesktopProject(projectsResult, dependencies.workspacePath ?? process.cwd());
    if (projects.length === 0) return finish(state, "desktop_project_not_found", startedAt, now);
    if (projects.length > 1) return finish(state, "desktop_project_ambiguous", startedAt, now);
    state.resolvedProject = true;
    state.resolvedProjectId = safeIdentity(projects[0]!.projectId);

    const createPlan = validateCreateThreadTool(contracts.get("create_thread"));
    if (createPlan === undefined) return finish(state, "create_thread_schema_incompatible", startedAt, now);
    state.createThreadSchema = createPlan.schema;
    state.targetType = "project";
    state.environmentType = createPlan.environmentType;
    state.targetSchemaValid = true;
    state.createThreadCalled = true;
    const createArgs = createPlan.build(CREATE_PROMPT, projects[0]!.projectId);
    state.argumentKeys = Object.keys(createArgs);

    let createResult: unknown;
    try {
      createResult = await callAllowedTool(
        client,
        "create_thread",
        createArgs,
        executorThreadId,
        timeoutMs,
        abortController.signal,
        EFFECTFUL_ALLOWLIST,
      );
    } catch (error: unknown) {
      applyFailureEvidence(state, createFailureEvidence(error));
      state.desktopApprovalUi = args.waitAfterFailureMs > 0 ? "manual_observation_required" : "not_observed";
      await waitAfterFailure(args.waitAfterFailureMs, abortController.signal);
      return finish(state, error instanceof DiagnosticInterrupted ? "diagnostic_interrupted" : "create_thread_failed", startedAt, now);
    }

    if (isRecord(createResult) && createResult.isError === true) {
      applyFailureEvidence(state, createFailureEvidence(createResult));
      state.desktopApprovalUi = args.waitAfterFailureMs > 0 ? "manual_observation_required" : "not_observed";
      await waitAfterFailure(args.waitAfterFailureMs, abortController.signal);
      return finish(state, "create_thread_failed", startedAt, now);
    }

    const identity = identityOf(createResult);
    if (identity.threadId === undefined) {
      state.failureClass = "unknown_tool_error";
      return finish(state, "thread_identity_missing", startedAt, now);
    }
    const threadId = safeIdentity(identity.threadId);
    if (threadId === undefined) {
      state.failureClass = "unknown_tool_error";
      return finish(state, "thread_identity_missing", startedAt, now);
    }
    state.threadCreated = true;
    state.threadIdSuffix = executorThreadSuffix(threadId);
    state.hostId = safeIdentity(identity.hostId);
    return finish(state, "create_thread_succeeded", startedAt, now);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  }
}
