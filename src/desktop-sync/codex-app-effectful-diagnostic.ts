import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
import {
  callCodexAppTool,
  CodexAppRuntimeError,
  type CodexAppMcpClient,
} from "../desktop-codex/codex-app-runtime.js";
import { createCodexAppToolContracts } from "../desktop-codex/codex-app-contracts.js";
import {
  parseDesktopProjects,
  resolveDesktopProject,
} from "../desktop-codex/desktop-project-resolver.js";
import { DesktopCodexThreadCommands } from "../desktop-codex/thread-commands.js";

const CREATE_PROMPT = "Only return LRM_CODEX_APP_P5_1_CREATE_PASS. Do not modify any files, create commits, or push.";
const SECOND_PROMPT = "Only return LRM_CODEX_APP_P5_1_SECOND_PASS. Do not modify any files, create commits, or push.";
const FIRST_MARKER = "LRM_CODEX_APP_P5_1_CREATE_PASS";
const SECOND_MARKER = "LRM_CODEX_APP_P5_1_SECOND_PASS";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 120_000;
const EXECUTOR_METADATA_KEY = "openai/threadId" as const;
const EXECUTOR_METADATA_ERROR_TEXT = "codex app tools require thread metadata from the executor.";
const NATIVE_REQUEST_ERROR_TEXT = "invalid app tool request";
const EXECUTOR_METADATA_ERROR_FINGERPRINT = "9eb0c658fe43c9440be141bdfba1c400db55308b73a48decbcc8ecdc84f1dca9";
const NATIVE_REQUEST_ERROR_FINGERPRINT = "4ba5282b280ceabcfb431897e91c387578cabc4be5572d19493465f8927a5bd9";
const CONTINUITY_ALLOWLIST = new Set(["wait_threads", "read_thread", "send_message_to_thread"]);

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

export type ContinuityFailureClass =
  | "first_turn_timeout"
  | "first_turn_completion_unverifiable"
  | "send_message_schema_incompatible"
  | "send_message_failed"
  | "second_turn_timeout"
  | "second_turn_completion_unverifiable"
  | "thread_identity_mismatch"
  | "steer_race";

export type CodexAppEffectfulFailureClass =
  | CreateThreadFailureClass
  | MetadataGateFailureClass
  | ContinuityFailureClass;

export type CodexAppEffectfulDiagnosticStage =
  | Exclude<CodexAppMcpDiagnosticStage, "ok">
  | "effectful_confirmation_required"
  | "executor_thread_required"
  | "metadata_gate_passed"
  | "create_thread_schema_incompatible"
  | "create_thread_failed"
  | "create_thread_succeeded"
  | "continuity_succeeded"
  | "thread_identity_missing"
  | "list_projects_schema_incompatible"
  | "list_projects_failed"
  | "desktop_project_not_found"
  | "desktop_project_ambiguous"
  | "first_turn_timeout"
  | "first_turn_completion_unverifiable"
  | "send_message_schema_incompatible"
  | "send_message_failed"
  | "second_turn_timeout"
  | "second_turn_completion_unverifiable"
  | "thread_identity_mismatch"
  | "steer_race";

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
  readonly createdThreadSuffix?: string;
  /** Compatibility alias retained for the P5.1.5 diagnostic result. */
  readonly threadIdSuffix?: string;
  readonly hostId?: string;
  readonly firstTurnCompleted: boolean;
  readonly firstMarkerObserved: boolean | "unknown";
  readonly sendMessageCalled: boolean;
  readonly sendTargetMatchesCreatedThread: boolean;
  readonly secondTurnCompleted: boolean;
  readonly secondMarkerObserved: boolean | "unknown";
  readonly readThreadCalled: boolean;
  readonly waitThreadsCalled: boolean;
  readonly sameThread: boolean;
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
  createdThreadSuffix?: string;
  threadIdSuffix?: string;
  hostId?: string;
  firstTurnCompleted: boolean;
  firstMarkerObserved: boolean | "unknown";
  sendMessageCalled: boolean;
  sendTargetMatchesCreatedThread: boolean;
  secondTurnCompleted: boolean;
  secondMarkerObserved: boolean | "unknown";
  readThreadCalled: boolean;
  waitThreadsCalled: boolean;
  sameThread: boolean;
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

interface CompletionPlan {
  readonly tool: "wait_threads" | "read_thread";
  readonly build: (threadId: string, hostId: string | undefined, timeoutMs: number) => Record<string, unknown> | undefined;
}

interface CompletionEvidence {
  readonly completed: boolean;
  readonly markerObserved: boolean;
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
class ContinuityToolFailure extends Error {
  public constructor(readonly evidence: ErrorEvidence) {
    super("continuity tool failed");
  }
}

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
  return schema.const === value || (Array.isArray(schema.enum) && schema.enum.includes(value));
}

function variantForType(schema: JsonSchema | undefined, value: string): JsonSchema | undefined {
  if (schema === undefined) return undefined;
  for (const branch of schemaBranches(schema)) {
    if (acceptsLiteral(schemaProperties(branch).type, value)) return branch;
  }
  return undefined;
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

function schemaVariantSummary(schema: JsonSchema): SchemaVariantSummary {
  const typeSchema = schemaProperties(schema).type;
  const values = typeSchema === undefined
    ? []
    : [
      ...(typeof typeSchema.const === "string" ? [typeSchema.const] : []),
      ...(Array.isArray(typeSchema.enum)
        ? typeSchema.enum.filter((value): value is string => typeof value === "string")
        : []),
    ];
  const uniqueValues = [...new Set(values)];
  return {
    ...(uniqueValues[0] === undefined ? {} : { type: uniqueValues[0] }),
    ...(uniqueValues.length === 0 ? {} : { typeEnum: uniqueValues }),
    required: [...requiredFields(schema)],
  };
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

function parseJsonText(value: string): unknown {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function isIntegerSchema(schema: JsonSchema | undefined): boolean {
  return schema !== undefined && (schemaType(schema, "integer") || schemaType(schema, "number"));
}

function isBooleanSchema(schema: JsonSchema | undefined): boolean {
  return schema !== undefined && schemaType(schema, "boolean");
}

function validateWaitThreadsTool(tool: ToolContract | undefined): CompletionPlan | undefined {
  if (tool === undefined) return undefined;
  const schema = tool.inputSchema;
  const properties = schemaProperties(schema);
  if (!requirementsWithin(schema, new Set(["targets", "timeoutMs"]))) return undefined;
  const targetsSchema = properties.targets;
  if (targetsSchema === undefined || !schemaType(targetsSchema, "array")) return undefined;
  const targetSchema = schemaRecord(targetsSchema.items);
  if (targetSchema === undefined) return undefined;
  const targetProperties = schemaProperties(targetSchema);
  if (!requirementsWithin(targetSchema, new Set(["threadId", "hostId", "afterCursor"]))) return undefined;
  if (!isStringSchema(targetProperties.threadId)) return undefined;
  const hostRequired = requiredFields(targetSchema).includes("hostId");
  if (hostRequired && !isStringSchema(targetProperties.hostId)) return undefined;
  if (properties.timeoutMs !== undefined && !isIntegerSchema(properties.timeoutMs)) return undefined;
  if (requiredFields(schema).includes("timeoutMs") && properties.timeoutMs === undefined) return undefined;
  return {
    tool: "wait_threads",
    build: (threadId, hostId, timeoutMs) => {
      if (hostRequired && hostId === undefined) return undefined;
      const target = {
        threadId,
        ...(isStringSchema(targetProperties.hostId) && hostId !== undefined ? { hostId } : {}),
      };
      return {
        targets: [target],
        ...(properties.timeoutMs === undefined ? {} : { timeoutMs }),
      };
    },
  };
}

function validateReadThreadTool(tool: ToolContract | undefined): CompletionPlan | undefined {
  if (tool === undefined) return undefined;
  const schema = tool.inputSchema;
  const properties = schemaProperties(schema);
  if (!requirementsWithin(schema, new Set(["threadId", "hostId", "turnLimit", "includeOutputs", "maxOutputCharsPerItem"]))) {
    return undefined;
  }
  if (!isStringSchema(properties.threadId)) return undefined;
  const hostRequired = requiredFields(schema).includes("hostId");
  if (hostRequired && !isStringSchema(properties.hostId)) return undefined;
  if (properties.turnLimit !== undefined && !isIntegerSchema(properties.turnLimit)) return undefined;
  if (properties.includeOutputs !== undefined && !isBooleanSchema(properties.includeOutputs)) return undefined;
  if (properties.maxOutputCharsPerItem !== undefined && !isIntegerSchema(properties.maxOutputCharsPerItem)) return undefined;
  return {
    tool: "read_thread",
    build: (threadId, hostId) => {
      if (hostRequired && hostId === undefined) return undefined;
      return {
        threadId,
        ...(isStringSchema(properties.hostId) && hostId !== undefined ? { hostId } : {}),
        ...(isIntegerSchema(properties.turnLimit) ? { turnLimit: 10 } : {}),
        ...(isBooleanSchema(properties.includeOutputs) ? { includeOutputs: false } : {}),
        ...(isIntegerSchema(properties.maxOutputCharsPerItem) ? { maxOutputCharsPerItem: 2_000 } : {}),
      };
    },
  };
}

function completionPlan(contracts: ReadonlyMap<string, ToolContract>): CompletionPlan | undefined {
  return validateWaitThreadsTool(contracts.get("wait_threads"))
    ?? validateReadThreadTool(contracts.get("read_thread"));
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
    const cause = value.cause;
    const source: Record<string, unknown> = {
      code: (value as Error & { code?: unknown }).code,
      name: value.name,
      message: value.message,
      cause,
    };
    const causeRecord = cause instanceof Error
      ? {
        code: (cause as Error & { code?: unknown }).code,
        name: cause.name,
        message: cause.message,
        cause: cause.cause,
      }
      : undefined;
    return [
      source,
      ...(isRecord(cause) ? [cause] : []),
      ...(causeRecord === undefined ? [] : [causeRecord]),
    ];
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
    texts.push(...contentInfo(source).texts);
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
  const codes = sources
    .map((source) => safeScalar(source.code))
    .filter((value): value is string | number => value !== undefined);
  const code = codes.find((value): value is number => typeof value === "number")
    ?? codes.find((value) => value !== "tool_call_failed")
    ?? safeScalar(first.code)
    ?? safeScalar(error?.code);
  const type = safeClass(first.type) ?? safeClass(error?.type);
  const name = safeClass(first.name) ?? safeClass(error?.name);
  const sdkErrorClass = value instanceof Error ? safeClass(value.constructor.name) : undefined;
  const cause = value instanceof Error ? value.cause : undefined;
  const sdkCauseClass = cause instanceof Error ? safeClass(cause.constructor.name) : undefined;
  const isError = isRecord(value) && typeof value.isError === "boolean"
    ? value.isError
    : sources.find((source) => typeof source.isError === "boolean")?.isError as boolean | undefined ?? null;
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

function completionEvidence(value: unknown, marker: string): CompletionEvidence {
  const statuses = new Set<string>();
  const seen = new Set<object>();
  let markerObserved = false;
  let turnCompleted: boolean | undefined;
  let hasErrors = false;
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      markerObserved ||= candidate.includes(marker);
      const parsed = parseJsonText(candidate);
      if (parsed !== undefined) visit(parsed);
      return;
    }
    if (!isRecord(candidate) && !Array.isArray(candidate)) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (isRecord(candidate)) {
      if (typeof candidate.turnCompleted === "boolean") {
        turnCompleted = turnCompleted === false ? false : candidate.turnCompleted;
      }
      const errors = candidate.errors;
      hasErrors ||= (Array.isArray(errors) && errors.length > 0)
        || (typeof errors === "string" && errors.trim() !== "")
        || (isRecord(errors) && Object.keys(errors).length > 0);
      for (const key of ["status", "state", "turnStatus", "turn_status"]) {
        const status = candidate[key];
        if (typeof status === "string") statuses.add(status.trim().toLowerCase());
      }
      for (const nested of Object.values(candidate)) visit(nested);
      return;
    }
    for (const nested of candidate) visit(nested);
  };
  visit(value);
  const completed = [...statuses].some((status) => ["complete", "completed", "success", "succeeded", "idle"].includes(status));
  const failed = [...statuses].some((status) => ["failed", "failure", "error", "interrupted", "cancelled", "canceled"].includes(status));
  return { completed: (turnCompleted ?? completed) && !failed && !hasErrors, markerObserved };
}

function classifyContinuityFailure(evidence: ErrorEvidence): CodexAppEffectfulFailureClass {
  if (/steerturninactiveerror|noactiveturn|cannot steer conversation .*active turn already ended/.test(evidence.normalizedErrorText)) {
    return "steer_race";
  }
  return evidence.failureClass;
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
    firstTurnCompleted: false,
    firstMarkerObserved: "unknown",
    sendMessageCalled: false,
    sendTargetMatchesCreatedThread: false,
    secondTurnCompleted: false,
    secondMarkerObserved: "unknown",
    readThreadCalled: false,
    waitThreadsCalled: false,
    sameThread: false,
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
  const passed = stage === "metadata_gate_passed"
    || stage === "create_thread_succeeded"
    || stage === "continuity_succeeded";
  return {
    ...state,
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
  client: CodexAppMcpClient,
  name: string,
  args: Record<string, unknown>,
  executorThreadId: string,
  timeoutMs: number,
  signal: AbortSignal,
  allowlist: ReadonlySet<string>,
): Promise<CallToolResult> {
  if (!allowlist.has(name)) throw new Error("disallowed diagnostic tool");
  try {
    return await callCodexAppTool({
      client,
      tool: name,
      arguments: args,
      executorThreadId,
      timeoutMs,
      signal,
    });
  } catch (error: unknown) {
    if (error instanceof CodexAppRuntimeError) {
      if (error.code === "tool_call_timeout") throw new ToolCallTimeout();
      if (error.code === "tool_call_aborted") throw new DiagnosticInterrupted();
    }
    throw error;
  }
}

async function waitForThread(
  client: CodexAppMcpClient,
  plan: CompletionPlan,
  threadId: string,
  hostId: string | undefined,
  marker: string,
  executorThreadId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CompletionEvidence> {
  const args = plan.build(threadId, hostId, timeoutMs);
  if (args === undefined) throw new ContinuityToolFailure({
    isError: null,
    contentItemTypes: [],
    structuredContentPresent: false,
    errorFields: [],
    failureClass: "unknown_tool_error",
    normalizedErrorText: "",
    hasErrorText: false,
  });
  const result = await callAllowedTool(
    client,
    plan.tool,
    args,
    executorThreadId,
    timeoutMs,
    signal,
    CONTINUITY_ALLOWLIST,
  );
  if (isRecord(result) && result.isError === true) throw new ContinuityToolFailure(createFailureEvidence(result));
  return completionEvidence(result, marker);
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

  let client: CodexAppMcpClient | undefined;
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

    let listed: Awaited<ReturnType<CodexAppMcpClient["listTools"]>>;
    try {
      listed = await client!.listTools(undefined, { signal: abortController.signal });
      state.toolsListed = true;
      state.toolCount = listed.tools.length;
      state.tools = listed.tools.map((tool) => tool.name);
    } catch {
      return finish(state, interrupted ? "diagnostic_interrupted" : "tools_list_failed", startedAt, now);
    }

    const diagnosticContracts = toolContracts(listed.tools);
    let formalContracts: ReturnType<typeof createCodexAppToolContracts>;
    try {
      formalContracts = createCodexAppToolContracts(listed.tools);
      formalContracts.requireListProjects();
    } catch {
      return finish(state, "list_projects_schema_incompatible", startedAt, now);
    }
    const commands = new DesktopCodexThreadCommands({ client: client!, contracts: formalContracts });

    state.listProjectsCalled = true;
    let projectsResult: CallToolResult;
    try {
      projectsResult = await commands.listProjects({
        executorThreadId,
        timeoutMs,
        signal: abortController.signal,
      });
    } catch (error: unknown) {
      const evidence = createFailureEvidence(error);
      applyFailureEvidence(state, evidence);
      const classification = classifyListProjectsFailure(evidence, evidence.isError === true);
      state.failureClass = classification.failureClass;
      state.metadataGatePassed = classification.metadataGatePassed;
      return finish(state, interrupted ? "diagnostic_interrupted" : "list_projects_failed", startedAt, now);
    }

    state.metadataGatePassed = true;
    state.listProjectsSucceeded = true;
    state.projectResolutionSource = "list_projects";
    let project;
    try {
      state.projectCount = parseDesktopProjects(projectsResult).length;
      project = resolveDesktopProject(projectsResult, dependencies.workspacePath ?? process.cwd());
    } catch (error: unknown) {
      if (error instanceof CodexAppRuntimeError && error.code === "project_not_found") {
        return finish(state, "desktop_project_not_found", startedAt, now);
      }
      if (error instanceof CodexAppRuntimeError && error.code === "project_ambiguous") {
        return finish(state, "desktop_project_ambiguous", startedAt, now);
      }
      state.failureClass = "unknown_tool_error";
      return finish(state, "list_projects_failed", startedAt, now);
    }
    state.resolvedProject = true;
    state.resolvedProjectId = project.projectId;

    let createArgs: Record<string, unknown>;
    try {
      const createTool = diagnosticContracts.get("create_thread");
      if (createTool !== undefined) state.createThreadSchema = schemaSummary(createTool.inputSchema);
      createArgs = formalContracts.createThreadArguments(CREATE_PROMPT, project.projectId);
    } catch {
      return finish(state, "create_thread_schema_incompatible", startedAt, now);
    }
    state.targetType = "project";
    state.environmentType = "local";
    state.targetSchemaValid = true;
    state.createThreadCalled = true;
    state.argumentKeys = Object.keys(createArgs);

    let identity: { readonly targetThreadId: string; readonly hostId: string };
    try {
      identity = await commands.createThread({
        executorThreadId,
        projectId: project.projectId,
        prompt: CREATE_PROMPT,
        timeoutMs,
        signal: abortController.signal,
      });
    } catch (error: unknown) {
      if (error instanceof CodexAppRuntimeError && error.code === "thread_identity_missing") {
        state.failureClass = "unknown_tool_error";
        return finish(state, "thread_identity_missing", startedAt, now);
      }
      applyFailureEvidence(state, createFailureEvidence(error));
      state.desktopApprovalUi = args.waitAfterFailureMs > 0 ? "manual_observation_required" : "not_observed";
      await waitAfterFailure(args.waitAfterFailureMs, abortController.signal);
      return finish(state, error instanceof DiagnosticInterrupted ? "diagnostic_interrupted" : "create_thread_failed", startedAt, now);
    }

    const threadId = identity.targetThreadId;
    state.threadCreated = true;
    state.createdThreadSuffix = executorThreadSuffix(threadId);
    state.threadIdSuffix = state.createdThreadSuffix;
    state.hostId = identity.hostId;

    const completion = completionPlan(diagnosticContracts);
    if (completion === undefined) {
      state.failureClass = "first_turn_completion_unverifiable";
      return finish(state, "first_turn_completion_unverifiable", startedAt, now);
    }

    let firstCompletion: CompletionEvidence;
    try {
      if (completion.tool === "wait_threads") state.waitThreadsCalled = true;
      else state.readThreadCalled = true;
      firstCompletion = await waitForThread(
        client!,
        completion,
        threadId,
        state.hostId,
        FIRST_MARKER,
        executorThreadId,
        timeoutMs,
        abortController.signal,
      );
    } catch (error: unknown) {
      if (error instanceof ContinuityToolFailure) applyFailureEvidence(state, error.evidence);
      if (error instanceof DiagnosticInterrupted || interrupted) return finish(state, "diagnostic_interrupted", startedAt, now);
      if (error instanceof ToolCallTimeout) {
        state.failureClass = "first_turn_timeout";
        return finish(state, "first_turn_timeout", startedAt, now);
      }
      state.failureClass = "first_turn_completion_unverifiable";
      return finish(state, "first_turn_completion_unverifiable", startedAt, now);
    }
    if (!firstCompletion.completed) {
      state.failureClass = "first_turn_completion_unverifiable";
      return finish(state, "first_turn_completion_unverifiable", startedAt, now);
    }
    state.firstTurnCompleted = true;
    state.firstMarkerObserved = firstCompletion.markerObserved ? true : "unknown";

    try {
      formalContracts.sendMessageToThreadArguments(threadId, state.hostId!, SECOND_PROMPT);
    } catch {
      state.failureClass = "send_message_schema_incompatible";
      return finish(state, "send_message_schema_incompatible", startedAt, now);
    }
    state.sendTargetMatchesCreatedThread = true;
    state.sendMessageCalled = true;

    try {
      await commands.sendMessageToThread({
        executorThreadId,
        targetThreadId: threadId,
        hostId: state.hostId!,
        prompt: SECOND_PROMPT,
        timeoutMs,
        signal: abortController.signal,
      });
    } catch (error: unknown) {
      if (error instanceof DiagnosticInterrupted || interrupted) return finish(state, "diagnostic_interrupted", startedAt, now);
      const evidence = createFailureEvidence(error);
      applyFailureEvidence(state, evidence);
      const failureClass = classifyContinuityFailure(evidence);
      state.failureClass = failureClass;
      return finish(state, failureClass === "steer_race" ? "steer_race" : "send_message_failed", startedAt, now);
    }

    let secondCompletion: CompletionEvidence;
    try {
      if (completion.tool === "wait_threads") state.waitThreadsCalled = true;
      else state.readThreadCalled = true;
      secondCompletion = await waitForThread(
        client!,
        completion,
        threadId,
        state.hostId,
        SECOND_MARKER,
        executorThreadId,
        timeoutMs,
        abortController.signal,
      );
    } catch (error: unknown) {
      if (error instanceof ContinuityToolFailure) applyFailureEvidence(state, error.evidence);
      if (error instanceof DiagnosticInterrupted || interrupted) return finish(state, "diagnostic_interrupted", startedAt, now);
      if (error instanceof ToolCallTimeout) {
        state.failureClass = "second_turn_timeout";
        return finish(state, "second_turn_timeout", startedAt, now);
      }
      state.failureClass = "second_turn_completion_unverifiable";
      return finish(state, "second_turn_completion_unverifiable", startedAt, now);
    }
    if (!secondCompletion.completed) {
      state.failureClass = "second_turn_completion_unverifiable";
      return finish(state, "second_turn_completion_unverifiable", startedAt, now);
    }
    state.secondTurnCompleted = true;
    state.secondMarkerObserved = secondCompletion.markerObserved ? true : "unknown";
    state.sameThread = state.sendTargetMatchesCreatedThread && state.secondTurnCompleted;
    return finish(state, "continuity_succeeded", startedAt, now);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
  }
}
