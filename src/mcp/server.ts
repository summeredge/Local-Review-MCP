import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, createReadStream } from "node:fs";
import { readdir, readFile, stat, open } from "node:fs/promises";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitError } from "../git/errors.js";
import { GitService } from "../git/service.js";
import { ModelResolutionError } from "../models/model-resolver.js";
import type { GitDiffResponse, GitStatusResponse } from "../git/types.js";
import { ReviewContextService } from "../review/review-context.js";
import type { ConversationCorrelationRegistry } from "../control-plane/conversation-correlation.js";
import {
  executionEventsOutputSchema,
  executionEventsQueryInputSchema,
  executionStatusQueryInputSchema,
  executionStatusOutputSchema,
  sessionEventsOutputSchema,
  sessionEventsQueryInputSchema,
  sessionStatusOutputSchema,
  sessionStatusQueryInputSchema,
  StatusQueryError,
  type StatusQueryService,
} from "../control-plane/status-query.js";
import {
  goalSubmissionToolInputSchema,
  goalSubmissionAcceptedSchema,
  assertExecutableTaskOnly,
  ExecutionTaskContainsDispatchInstructionError,
  resolveGoalModelFields,
  type GoalSubmissionService,
} from "../control-plane/goal-submission.js";
import {
  identityTraceQueryInputSchema,
  identityTraceOutputSchema,
  type IdentityTraceService,
} from "../control-plane/identity-trace.js";
import {
  evidenceTransportTraceQueryInputSchema,
  evidenceTransportTraceOutputSchema,
  type EvidenceTransportTraceService,
} from "../control-plane/evidence-transport-trace.js";
import {
  PendingGoalSubmissionConflictError,
  BrowserReadinessError,
  type PendingGoalSubmissionService,
} from "../control-plane/pending-goal-submission.js";
import { validateWorkspaceIdentityConsistency } from "../workspace/identity.js";
import { WorkspaceManager, WorkspacePathError } from "../workspace/manager.js";
import type { WorkspaceRegistry, WorkspaceSelection } from "../workspace/registry.js";
import { searchText } from "../workspace/search.js";
import { containsNullByte, readBoundedBytes } from "../workspace/text.js";
import { editWorkspaceFile, editFileInputSchema, editFileOutputSchema } from "../workspace/edit.js";
import { structuredResponse } from "./respond.js";
import { inboundRequestOrigin } from "./inbound.js";
import { correlationKeySchema, ROOT_ALIAS } from "./schema/common.js";
import {
  gitDiffOutputSchema,
  gitStatusOutputSchema,
} from "./schema/git.js";
import {
  executionOutputOutputSchema,
  reviewSummaryOutputSchema,
  workspaceReviewContextOutputSchema,
  workspaceReviewInfoOutputSchema,
  workspaceReviewListFilesOutputSchema,
  workspaceReviewReadFileOutputSchema,
  workspaceReviewSearchOutputSchema,
  type ExecutionOutputOutput,
  type ReviewSummaryOutput,
} from "./schema/review.js";
import {
  listFilesOutputSchema,
  readFileOutputSchema,
  searchTextOutputSchema,
} from "./schema/files.js";
import {
  workspaceInfoOutputSchema,
  workspaceListOutputSchema,
  type WorkspaceInfoOutput,
} from "./schema/workspace.js";

export interface McpRuntimeContext {
  readonly workspace?: WorkspaceManager;
  readonly registry: WorkspaceRegistry;
  readonly correlations?: Pick<ConversationCorrelationRegistry, "correlation" | "awaitCorrelation">;
  readonly goalSubmission?: Pick<GoalSubmissionService, "submitExternalGoal">;
  readonly pendingGoalSubmission?: Pick<PendingGoalSubmissionService, "accept"> & Partial<Pick<PendingGoalSubmissionService, "get">>;
  readonly identityTrace?: Pick<IdentityTraceService, "getIdentityTrace" | "record">;
  readonly evidenceTransportTrace?: Pick<
    EvidenceTransportTraceService,
    "getEvidenceTransportTrace" | "record"
  >;
  readonly statusQuery?: Pick<
    StatusQueryService,
    "getSessionStatus" | "getExecutionStatus" | "listSessionEvents" | "listExecutionEvents"
  >;
  readonly connectorEvidence?: {
    recordEvidence(input: {
      readonly request_id: string;
      readonly tool_name: string;
      readonly workspace_id: string;
      readonly mcp_resource: string;
      readonly authentication: "oauth" | "static" | "unknown";
      readonly success: boolean;
      readonly completed_at: string;
    }): Promise<void>;
  };
}

export const V01_TOOL_NAMES = [
  "workspace_info",
  "list_files",
  "read_file",
  "search_text",
  "git_status",
  "git_diff",
] as const;

export const WORKSPACE_REGISTRY_TOOL_NAMES = ["workspace_list"] as const;
export const REVIEW_CONTEXT_TOOL_NAMES = ["review_summary", "execution_output"] as const;
export const WORKSPACE_REVIEW_TOOL_NAMES = [
  "workspace_get_info",
  "workspace_list_files",
  "workspace_read_file",
  "workspace_search",
  "workspace_review_context",
] as const;
export const CONTROL_PLANE_TOOL_NAMES = ["submit_goal"] as const;
export const STATUS_QUERY_TOOL_NAMES = [
  "get_session_status",
  "get_execution_status",
  "list_session_events",
  "list_execution_events",
] as const;
export const DIAGNOSTIC_TOOL_NAMES = ["get_identity_trace", "get_evidence_transport_trace"] as const;
export const REGISTERED_TOOL_NAMES = [
  ...V01_TOOL_NAMES,
  ...WORKSPACE_REGISTRY_TOOL_NAMES,
  ...REVIEW_CONTEXT_TOOL_NAMES,
  ...WORKSPACE_REVIEW_TOOL_NAMES,
  "workspace_edit_file",
  ...CONTROL_PLANE_TOOL_NAMES,
  ...STATUS_QUERY_TOOL_NAMES,
  ...DIAGNOSTIC_TOOL_NAMES,
] as const;

export type V01ToolName = typeof V01_TOOL_NAMES[number];

export function registeredMcpToolsMessage(): string {
  return ["Registered MCP tools:", ...REGISTERED_TOOL_NAMES.map((name) => `- ${name}`)].join("\n");
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
} as const;

const MAX_VISITED_ENTRIES = 10_000;
export const MAX_READ_SCAN_BYTES = 8 * 1024 * 1024;
const workspaceIdInputSchema = {
  workspace_id: z.string().min(1).max(128).optional(),
};

const requiredWorkspaceIdInputSchema = {
  workspace_id: z.string().min(1).max(128),
};

const listFilesInputSchema = {
  ...workspaceIdInputSchema,
  path: z.string().optional().default("."),
  depth: z.number().finite().int().min(1).max(4).optional().default(1),
  offset: z.number().finite().int().min(0).optional().default(0),
  limit: z.number().finite().int().min(1).max(1000).optional().default(200),
};

const readFileInputSchema = {
  ...workspaceIdInputSchema,
  path: z.string(),
  start_line: z.number().finite().int().min(1).optional().default(1),
  max_lines: z.number().finite().int().min(1).max(2000).optional().default(400),
  max_bytes: z.number().finite().int().min(1).max(1024 * 1024).optional().default(256 * 1024),
};

const searchTextInputSchema = {
  ...workspaceIdInputSchema,
  query: z.string()
    .max(1000)
    .refine((value) => value.trim() !== "", "query must not be empty")
    .refine((value) => !value.includes("\0"), "query contains an invalid character"),
  path: z.string().optional().default("."),
  glob: z.string().min(1).max(1000).optional(),
  regex: z.boolean().optional().default(false),
  case_sensitive: z.boolean().optional().default(false),
  limit: z.number().finite().int().min(1).max(200).optional().default(100),
};

const workspaceReviewListFilesInputSchema = {
  ...requiredWorkspaceIdInputSchema,
  path: z.string().optional().default("."),
  depth: z.number().finite().int().min(1).max(4).optional().default(4),
  offset: z.number().finite().int().min(0).optional().default(0),
  limit: z.number().finite().int().min(1).max(1000).optional().default(200),
};

const workspaceReviewReadFileInputSchema = {
  ...requiredWorkspaceIdInputSchema,
  path: z.string(),
  start_line: z.number().finite().int().min(1).optional().default(1),
  end_line: z.number().finite().int().min(1).optional(),
};

const workspaceReviewSearchInputSchema = {
  ...requiredWorkspaceIdInputSchema,
  query: searchTextInputSchema.query,
  path: z.string().optional().default("."),
  limit: z.number().finite().int().min(1).max(200).optional().default(100),
};

const gitDiffInputSchema = {
  ...workspaceIdInputSchema,
  path: z.string().optional().default("."),
  stat: z.boolean().optional().default(false),
};
const EXECUTION_OUTPUT_PATH = ".review/execution_output.json";

type ProbePresence = "present" | "absent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function probePresence(value: unknown): ProbePresence {
  return value === undefined ? "absent" : "present";
}

function probeIdentity(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value) && value.length === 1) return probeIdentity(value[0]);
  return null;
}

function probeHash(value: string | null): string | undefined {
  return value === null ? undefined : createHash("sha256").update(value, "utf8").digest("hex");
}

function logMcpContextProbe(extra: unknown): void {
  if (process.env.LRM_MCP_CONTEXT_PROBE !== "1") return;
  const context = isRecord(extra) ? extra : {};
  const metadata = isRecord(context._meta) ? context._meta : undefined;
  const requestInfo = isRecord(context.requestInfo) ? context.requestInfo : undefined;
  const headers = isRecord(requestInfo?.headers) ? requestInfo.headers : undefined;
  const header = (name: string) => probeIdentity(headers?.[name]);
  const openaiSession = probeIdentity(metadata?.["openai/session"]);
  const sessionId = probeIdentity(context.sessionId);
  const requestId = probeIdentity(context.requestId);
  const callId = probeIdentity(context.callId)
    ?? probeIdentity(metadata?.["openai/call_id"])
    ?? probeIdentity(metadata?.call_id)
    ?? probeIdentity(metadata?.callId);
  const headerSession = header("x-openai-session") ?? header("openai-session");
  const headerConversation = header("x-openai-conversation-id") ?? header("openai-conversation-id");
  const headerThread = header("x-openai-thread-id") ?? header("openai-thread-id");
  const headerRequestId = header("x-request-id");
  const entry = JSON.stringify({
    probe: "runtime_identity_probe",
    timestamp: new Date().toISOString(),
    field_presence: {
      handler_extra: probePresence(extra) === "present",
      _meta: probePresence(context._meta) === "present",
      "_meta.openai/session": openaiSession !== null,
      sessionId: sessionId !== null,
      requestId: requestId !== null,
      callId: callId !== null,
      requestInfo: requestInfo !== undefined,
      "requestInfo.headers": headers !== undefined,
      "headers.openai_session": headerSession !== null,
      "headers.openai_conversation_id": headerConversation !== null,
      "headers.openai_thread_id": headerThread !== null,
      "headers.x_request_id": headerRequestId !== null,
      authInfo: probePresence(context.authInfo) === "present",
      "authInfo.extra": isRecord(context.authInfo) && probePresence(context.authInfo.extra) === "present",
    },
    identity_hashes: {
      ...(probeHash(openaiSession) === undefined ? {} : { openai_session: probeHash(openaiSession) }),
      ...(probeHash(sessionId) === undefined ? {} : { session_id: probeHash(sessionId) }),
      ...(probeHash(requestId) === undefined ? {} : { request_id: probeHash(requestId) }),
      ...(probeHash(callId) === undefined ? {} : { call_id: probeHash(callId) }),
      ...(probeHash(headerSession) === undefined ? {} : { header_session: probeHash(headerSession) }),
      ...(probeHash(headerConversation) === undefined
        ? {}
        : { header_conversation_id: probeHash(headerConversation) }),
      ...(probeHash(headerThread) === undefined ? {} : { header_thread_id: probeHash(headerThread) }),
      ...(probeHash(headerRequestId) === undefined ? {} : { header_request_id: probeHash(headerRequestId) }),
    },
  });
  const outputPath = process.env.LRM_MCP_CONTEXT_PROBE_PATH?.trim();
  if (outputPath === undefined || outputPath === "") {
    console.warn("MCP runtime identity probe", entry);
    return;
  }
  try {
    appendFileSync(outputPath, `${entry}\n`, "utf8");
  } catch {
    console.warn("MCP runtime identity probe write failed");
  }
}

function authenticatedMcpInvocationProof(extra: unknown): {
  readonly source: "authenticated_mcp_invocation";
} | undefined {
  const origin = inboundRequestOrigin();
  if (origin?.authentication === "oauth") {
    return { source: "authenticated_mcp_invocation" };
  }

  // The SDK's AuthInfo is populated by its authentication middleware, not by tool input. Validate
  // its required shape before using the only non-sensitive fact this path needs.
  const context = isRecord(extra) ? extra : undefined;
  const authInfo = isRecord(context?.authInfo) ? context.authInfo : undefined;
  if (authInfo === undefined
    || typeof authInfo.token !== "string" || authInfo.token.length === 0
    || typeof authInfo.clientId !== "string" || authInfo.clientId.length === 0
    || !Array.isArray(authInfo.scopes)
    || !authInfo.scopes.every((scope) => typeof scope === "string")) {
    return undefined;
  }
  return { source: "authenticated_mcp_invocation" };
}

interface ListedEntry {
  readonly path: string;
  readonly name: string;
  readonly type: "file" | "directory";
}

export function toToolError(error: unknown) {
  if (error instanceof ModelResolutionError) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        error: { ...error.details, message: error.message },
      }) }],
      isError: true as const,
    };
  }
  if (error instanceof BrowserReadinessError) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        error: "BROWSER_IDENTITY_CHANNEL_NOT_READY",
        readiness_state: error.readiness.readiness_state,
        message: error.message,
        reason: error.readiness.reason,
        action: error.readiness.action,
      }) }],
      isError: true as const,
    };
  }
  if (error instanceof ExecutionTaskContainsDispatchInstructionError) {
    return { content: [{ type: "text" as const, text: JSON.stringify({
      error: "DISPATCH_SETTINGS_IN_TASK",
      field: error.field,
      message: error.message,
    }) }], isError: true as const };
  }
  if (error instanceof StatusQueryError) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: error.code, message: error.message }) }], isError: true as const };
  }
  const code = error instanceof PendingGoalSubmissionConflictError
    ? "CONFLICTING_PENDING_GOAL_SUBMISSION"
    : error instanceof WorkspacePathError || error instanceof GitError
    ? error.code
    : "INTERNAL_ERROR";
  if (code === "INTERNAL_ERROR") console.error("MCP tool failed:", error);
  const details = code === "UNKNOWN_WORKSPACE_ID"
    ? { message: "Unknown workspace_id" }
    : {};
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, ...details }) }],
    isError: true as const,
  };
}

function childPath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

function comparePaths(left: ListedEntry, right: ListedEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

async function listFiles(
  workspace: WorkspaceManager,
  input: z.infer<z.ZodObject<typeof listFilesInputSchema>>,
) {
  const root = workspace.resolveExistingDirectory(input.path);
  const entries: ListedEntry[] = [];
  let visitedEntries = 0;
  let truncated = false;

  async function visit(directoryPath: string, currentDepth: number): Promise<void> {
    const resolvedDirectory = directoryPath === root.relativePath
      ? root
      : workspace.resolveExistingDirectory(directoryPath);
    const names = await readdir(resolvedDirectory.absolutePath);
    names.sort();

    for (const name of names) {
      if (visitedEntries >= MAX_VISITED_ENTRIES) {
        truncated = true;
        return;
      }
      visitedEntries += 1;
      const relativePath = childPath(directoryPath, name);

      let resolvedChild;
      try {
        resolvedChild = workspace.resolveExisting(relativePath);
      } catch (error: unknown) {
        if (error instanceof WorkspacePathError) continue;
        continue;
      }

      let type: ListedEntry["type"];
      try {
        const stats = await stat(resolvedChild.absolutePath);
        if (stats.isDirectory()) type = "directory";
        else if (stats.isFile()) type = "file";
        else continue;
      } catch {
        continue;
      }

      entries.push({ path: relativePath, name, type });
      if (type === "directory" && currentDepth < input.depth) {
        try {
          await visit(relativePath, currentDepth + 1);
        } catch (error: unknown) {
          if (!(error instanceof WorkspacePathError)) continue;
        }
        if (truncated) return;
      }
    }
  }

  try {
    await visit(root.relativePath, 1);
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) throw error;
    throw new WorkspacePathError("PATH_NOT_FOUND", "Workspace directory could not be read.", root.relativePath);
  }

  entries.sort(comparePaths);
  const selected = entries.slice(input.offset, input.offset + input.limit);
  return {
    path: root.relativePath,
    entries: selected,
    offset: input.offset,
    returned: selected.length,
    has_more: truncated || input.offset + selected.length < entries.length,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

async function readFilePage(
  workspace: WorkspaceManager,
  input: z.infer<z.ZodObject<typeof readFileInputSchema>>,
  snapshot?: Buffer,
) {
  const resolved = workspace.resolveExisting(input.path);
  let stats;
  try {
    stats = await stat(resolved.absolutePath);
  } catch {
    throw new WorkspacePathError("PATH_NOT_FOUND", "Workspace file was not found.", resolved.relativePath);
  }
  if (!stats.isFile()) {
    throw new WorkspacePathError(
      "PATH_NOT_DIRECTORY",
      "Workspace path requires a regular file.",
      resolved.relativePath,
    );
  }

  if (await containsNullByte(resolved.absolutePath, resolved.relativePath)) {
    throw new WorkspacePathError("BINARY_FILE", "Binary files are not supported.", resolved.relativePath);
  }

  const inputStream = snapshot === undefined
    ? createReadStream(resolved.absolutePath, { encoding: "utf8" })
    : Readable.from([snapshot.toString("utf8")]);
  const lines = createInterface({ input: inputStream, crlfDelay: Infinity });
  const output: string[] = [];
  let currentLine = 0;
  let scannedBytes = 0;
  let contentBytes = 0;
  let hasMore = false;
  let truncated = false;

  try {
    for await (const rawLine of lines) {
      currentLine += 1;
      scannedBytes += Buffer.byteLength(rawLine, "utf8") + 1;
      if (scannedBytes > MAX_READ_SCAN_BYTES) {
        throw new WorkspacePathError(
          "READ_SCAN_LIMIT_EXCEEDED",
          "Workspace file scan limit was exceeded.",
          resolved.relativePath,
        );
      }
      let line = rawLine;
      if (currentLine === 1) line = line.replace(/^\uFEFF/u, "");
      if (currentLine < input.start_line) continue;
      if (output.length >= input.max_lines) {
        hasMore = true;
        break;
      }

      const separatorBytes = output.length === 0 ? 0 : 1;
      const availableBytes = input.max_bytes - contentBytes - separatorBytes;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (lineBytes <= availableBytes) {
        output.push(line);
        contentBytes += separatorBytes + lineBytes;
        continue;
      }

      if (availableBytes > 0) {
        const partial = truncateUtf8(line, availableBytes);
        if (partial !== "" || line === "") {
          output.push(partial);
          contentBytes += separatorBytes + Buffer.byteLength(partial, "utf8");
        }
      }
      truncated = true;
      hasMore = true;
      break;
    }
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError) throw error;
    throw new WorkspacePathError("PATH_NOT_FOUND", "Workspace file could not be read.", resolved.relativePath);
  } finally {
    lines.close();
    inputStream.destroy();
  }

  return {
    path: resolved.relativePath,
    start_line: input.start_line,
    end_line: output.length === 0 ? input.start_line - 1 : input.start_line + output.length - 1,
    has_more: hasMore,
    content: output.join("\n"),
    ...(truncated ? { truncated: true } : {}),
  };
}

async function hasRegularFile(workspace: WorkspaceManager, path: string): Promise<boolean> {
  try {
    const resolved = workspace.resolveExisting(path);
    const stats = await stat(resolved.absolutePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function detectProjectTypes(workspace: WorkspaceManager): Promise<string[]> {
  const types = new Set<string>();
  const markers: readonly [string, string][] = [
    ["package.json", "node"],
    ["tsconfig.json", "typescript"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
  ];

  for (const [path, type] of markers) {
    if (await hasRegularFile(workspace, path)) types.add(type);
  }

  let names: string[];
  try {
    names = workspace.readDirectory(".");
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!/\.(?:sln|csproj)$/iu.test(name)) continue;
    if (await hasRegularFile(workspace, name)) types.add("dotnet");
  }

  return [...types].sort();
}

async function workspaceInfo(selection: WorkspaceSelection): Promise<WorkspaceInfoOutput> {
  return {
    request_id: inboundRequestOrigin()?.requestId ?? randomUUID(),
    workspace_id: selection.id,
    workspace_name: selection.name,
    root_alias: ROOT_ALIAS,
    project_types: await detectProjectTypes(selection.manager),
  };
}

function summarizeGitStatus(status: GitStatusResponse) {
  const summary = { modified: 0, added: 0, deleted: 0 };
  for (const entry of status.entries) {
    if (entry.status === "deleted") summary.deleted += 1;
    else if (entry.status === "added" || entry.status === "untracked") summary.added += 1;
    else summary.modified += 1;
  }
  return summary;
}

function statCount(value: string, noun: "insertion" | "deletion"): number {
  const match = value.match(new RegExp(`\\b(\\d+)\\s+${noun}s?\\s*\\([+-]\\)`, "u"));
  return match === null ? 0 : Number(match[1]);
}

function summarizeDiff(diff: GitDiffResponse) {
  const statLine = diff.diff.split(/\r?\n/u).find((line) => /^\s*\d+\s+files? changed\b/u.test(line)) ?? "";
  return {
    files_changed: diff.files.length,
    insertions: statCount(statLine, "insertion"),
    deletions: statCount(statLine, "deletion"),
  };
}

async function reviewSummary(selection: WorkspaceSelection): Promise<ReviewSummaryOutput> {
  const git = new GitService(selection.manager);
  const [status, diff] = await Promise.all([
    git.status(),
    git.diff({ stat: true }),
  ]);
  return {
    workspace_id: selection.id,
    workspace_name: selection.name,
    git_branch: status.branch,
    git_status_summary: summarizeGitStatus(status),
    diff_summary: summarizeDiff(diff),
  };
}

async function executionOutput(workspace: WorkspaceManager): Promise<ExecutionOutputOutput> {
  let resolved;
  try {
    resolved = workspace.resolveExisting(EXECUTION_OUTPUT_PATH);
  } catch (error: unknown) {
    if (error instanceof WorkspacePathError && error.code === "PATH_NOT_FOUND") {
      return { available: false };
    }
    throw error;
  }

  let stats;
  try {
    stats = await stat(resolved.absolutePath);
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { available: false };
    }
    throw error;
  }
  if (!stats.isFile()) return { available: false };
  const output = JSON.parse(await readFile(resolved.absolutePath, "utf8")) as unknown;
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new Error("Execution output must be a JSON object.");
  }
  return output as ExecutionOutputOutput;
}

export function createMcpServer(context: McpRuntimeContext): McpServer {
  const registry = context.registry;
  if (registry === undefined) throw new Error("Workspace registry is required.");
  if (context.workspace !== undefined) {
    validateWorkspaceIdentityConsistency(registry.active, context.workspace.identity);
  }
  const server = new McpServer({ name: "local-review-mcp", version: "0.1.0" });

  server.registerTool(
    "workspace_info",
    {
      description: "Return metadata about an authorized local workspace; omitted workspace_id uses the active workspace.",
      inputSchema: workspaceIdInputSchema,
      outputSchema: workspaceInfoOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      const origin = inboundRequestOrigin();
      let workspaceId = input.workspace_id;
      try {
        const selection = registry.resolve(input.workspace_id);
        workspaceId = selection.id;
        const output = await workspaceInfo(selection);
        if (origin !== null && origin.mcpResource !== null && context.connectorEvidence !== undefined) {
          await context.connectorEvidence.recordEvidence({
            request_id: output.request_id,
            tool_name: "workspace_info",
            workspace_id: output.workspace_id,
            mcp_resource: origin.mcpResource,
            authentication: origin.authentication,
            success: true,
            completed_at: new Date().toISOString(),
          });
        }
        return structuredResponse(workspaceInfoOutputSchema, output);
      } catch (error: unknown) {
        if (origin !== null && origin.mcpResource !== null && context.connectorEvidence !== undefined) {
          await context.connectorEvidence.recordEvidence({
            request_id: origin.requestId,
            tool_name: "workspace_info",
            workspace_id: workspaceId ?? registry.active.id,
            mcp_resource: origin.mcpResource,
            authentication: origin.authentication,
            success: false,
            completed_at: new Date().toISOString(),
          }).catch(() => undefined);
        }
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "list_files",
    {
      description: "Compatibility interface for typed file/directory entries and entry pagination; prefer workspace_list_files for file paths with explicit workspace_id. Omitted workspace_id uses the active workspace.",
      inputSchema: listFilesInputSchema,
      outputSchema: listFilesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return structuredResponse(listFilesOutputSchema, await listFiles(registry.resolve(input.workspace_id).manager, input));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "read_file",
    {
      description: "Compatibility interface for max_lines/max_bytes budgets; prefer workspace_read_file for explicit workspace_id, line ranges and optional original-byte SHA-256. Omitted workspace_id uses the active workspace.",
      inputSchema: readFileInputSchema,
      outputSchema: readFileOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return structuredResponse(readFileOutputSchema, await readFilePage(registry.resolve(input.workspace_id).manager, input));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "search_text",
    {
      description: "Compatibility interface for regex, glob, case_sensitive, match columns and engine metadata; prefer workspace_search for literal case-insensitive search with explicit workspace_id. Omitted workspace_id uses the active workspace.",
      inputSchema: searchTextInputSchema,
      outputSchema: searchTextOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return structuredResponse(searchTextOutputSchema, await searchText(registry.resolve(input.workspace_id).manager, {
          query: input.query,
          path: input.path,
          glob: input.glob,
          regex: input.regex,
          caseSensitive: input.case_sensitive,
          limit: input.limit,
        }));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "workspace_get_info",
    {
      description: "Return the read-only Git state of one explicitly authorized workspace.",
      inputSchema: requiredWorkspaceIdInputSchema,
      outputSchema: workspaceReviewInfoOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return structuredResponse(
          workspaceReviewInfoOutputSchema,
          await new ReviewContextService(registry.resolve(input.workspace_id)).info(),
        );
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "workspace_list_files",
    {
      description: "Recommended file-path listing in one explicitly authorized workspace. Defaults to depth 4; offset/limit count file and directory entries before filtering to files. Use list_files when typed directory entries are needed.",
      inputSchema: workspaceReviewListFilesInputSchema,
      outputSchema: workspaceReviewListFilesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        const selection = registry.resolve(input.workspace_id);
        const output = await listFiles(selection.manager, input);
        return structuredResponse(workspaceReviewListFilesOutputSchema, {
          workspace_id: selection.id,
          path: output.path,
          files: output.entries.filter((entry) => entry.type === "file").map((entry) => entry.path),
          has_more: output.has_more,
        });
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "workspace_read_file",
    {
      description: "Recommended text reading with explicit workspace_id: 200 lines by default, at most 1000 lines/256 KiB per call and 8 MiB scanned. Files <=8 MiB include same-snapshot original-byte sha256; larger files use bounded streaming without sha256. Continue via next_start_line.",
      inputSchema: workspaceReviewReadFileInputSchema,
      outputSchema: workspaceReviewReadFileOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        const endLine = input.end_line ?? input.start_line + 199;
        const maxLines = endLine - input.start_line + 1;
        if (maxLines < 1 || maxLines > 1000) {
          throw new WorkspacePathError("INVALID_PATH", "Requested line range must contain between 1 and 1000 lines.");
        }
        const selection = registry.resolve(input.workspace_id);
        const resolved = selection.manager.resolveExisting(input.path);
        const stats = await stat(resolved.absolutePath);
        if (!stats.isFile()) throw new WorkspacePathError("UNSAFE_EDIT_TARGET", "Expected a regular file.");
        let snapshot: Buffer | undefined;
        if (stats.size <= MAX_READ_SCAN_BYTES) {
          const handle = await open(resolved.absolutePath, "r");
          try { snapshot = await readBoundedBytes(handle, MAX_READ_SCAN_BYTES); } finally { await handle.close(); }
          if (snapshot.length > MAX_READ_SCAN_BYTES) snapshot = undefined;
        }
        if (snapshot?.includes(0)) throw new WorkspacePathError("BINARY_FILE", "Binary file.");
        const output = await readFilePage(selection.manager, {
          workspace_id: input.workspace_id,
          path: input.path,
          start_line: input.start_line,
          max_lines: maxLines,
          max_bytes: 256 * 1024,
        }, snapshot);
        return structuredResponse(workspaceReviewReadFileOutputSchema, {
          workspace_id: selection.id,
          path: output.path,
          content: output.content,
          ...(snapshot === undefined ? {} : { sha256: createHash("sha256").update(snapshot).digest("hex") }),
          start_line: output.start_line,
          end_line: output.end_line,
          truncated: output.has_more,
          ...(output.has_more ? { next_start_line: output.end_line + 1 } : {}),
        });
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool("workspace_edit_file", {
    description: "Precisely replace 1–5 unique non-overlapping text matches in one existing UTF-8 file (<=1 MiB). Manual workspace registration authorizes controlled editing. Requires explicit registered workspace_id and original-byte expected_sha256. No cross-process CAS guarantee.",
    inputSchema: editFileInputSchema.shape,
    outputSchema: editFileOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (input) => {
    try {
      return structuredResponse(editFileOutputSchema, await editWorkspaceFile(registry.resolve(input.workspace_id), input));
    } catch (error: unknown) { return toToolError(error); }
  });

  server.registerTool(
    "workspace_search",
    {
      description: "Recommended bounded literal, case-insensitive text search with explicit workspace_id, optional path and limit. Returns path, line, text and truncated; use search_text for regex, glob, case-sensitive search or match columns.",
      inputSchema: workspaceReviewSearchInputSchema,
      outputSchema: workspaceReviewSearchOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        const selection = registry.resolve(input.workspace_id);
        const output = await searchText(selection.manager, {
          query: input.query,
          path: input.path,
          regex: false,
          caseSensitive: false,
          limit: input.limit,
        });
        return structuredResponse(workspaceReviewSearchOutputSchema, {
          workspace_id: selection.id,
          results: output.results.map(({ path, line, preview }) => ({ path, line, text: preview })),
          truncated: output.has_more,
        });
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "workspace_review_context",
    {
      description: "Return bounded staged and unstaged Git context plus review candidates for one explicitly authorized workspace.",
      inputSchema: requiredWorkspaceIdInputSchema,
      outputSchema: workspaceReviewContextOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return structuredResponse(
          workspaceReviewContextOutputSchema,
          await new ReviewContextService(registry.resolve(input.workspace_id)).context(),
        );
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "git_status",
    {
      description: "Return the structured Git status of the authorized workspace.",
      inputSchema: workspaceIdInputSchema,
      outputSchema: gitStatusOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        const selection = registry.resolve(input.workspace_id);
        return structuredResponse(gitStatusOutputSchema, {
          workspace_id: selection.id,
          ...(await new GitService(selection.manager).status()),
        });
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "git_diff",
    {
      description: "Return a bounded Git diff for the authorized workspace or one relative path.",
      inputSchema: gitDiffInputSchema,
      outputSchema: gitDiffOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        const selection = registry.resolve(input.workspace_id);
        return structuredResponse(gitDiffOutputSchema, {
          workspace_id: selection.id,
          ...(await new GitService(selection.manager).diff({
            path: input.path,
            stat: input.stat,
          })),
        });
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "workspace_list",
    {
      description: "List the authorized workspaces without exposing local filesystem paths.",
      inputSchema: {},
      outputSchema: workspaceListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        return structuredResponse(workspaceListOutputSchema, { workspaces: [...registry.list()] });
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "review_summary",
    {
      description: "Return a read-only Git and workspace summary for review; omitted workspace_id uses the active workspace.",
      inputSchema: workspaceIdInputSchema,
      outputSchema: reviewSummaryOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return structuredResponse(reviewSummaryOutputSchema, await reviewSummary(registry.resolve(input.workspace_id)));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "execution_output",
    {
      description: "Read the fixed .review/execution_output.json result for the authorized workspace; omitted workspace_id uses the active workspace.",
      inputSchema: workspaceIdInputSchema,
      outputSchema: executionOutputOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return structuredResponse(executionOutputOutputSchema, await executionOutput(registry.resolve(input.workspace_id).manager));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "get_session_status",
    {
      description: "Return the read-only status of an interactive Session by session_id or goal_id.",
      inputSchema: sessionStatusQueryInputSchema,
      outputSchema: sessionStatusOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        if (context.statusQuery === undefined) {
          return toToolError(new StatusQueryError("RUNTIME_UNAVAILABLE", "Status query runtime is unavailable."));
        }
        const selection = registry.resolve(input.workspace_id);
        return structuredResponse(sessionStatusOutputSchema, await context.statusQuery.getSessionStatus({
          ...input,
          workspace_id: selection.id,
        }));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "get_execution_status",
    {
      description: "Return the read-only status of an Execution by execution_id.",
      inputSchema: executionStatusQueryInputSchema,
      outputSchema: executionStatusOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        if (context.statusQuery === undefined) {
          return toToolError(new Error("Status query runtime is unavailable."));
        }
        const selection = registry.resolve(input.workspace_id);
        return structuredResponse(executionStatusOutputSchema, await context.statusQuery.getExecutionStatus({
          ...input,
          workspace_id: selection.id,
        }));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "list_session_events",
    {
      description: "List bounded normalized LRM events for an interactive Session.",
      inputSchema: sessionEventsQueryInputSchema,
      outputSchema: sessionEventsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        if (context.statusQuery === undefined) {
          return toToolError(new Error("Status query runtime is unavailable."));
        }
        const selection = registry.resolve(input.workspace_id);
        return structuredResponse(sessionEventsOutputSchema, await context.statusQuery.listSessionEvents({
          ...input,
          workspace_id: selection.id,
        }));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "list_execution_events",
    {
      description: "List bounded read-only Codex JSONL events for a CLI batch Execution.",
      inputSchema: executionEventsQueryInputSchema,
      outputSchema: executionEventsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        if (context.statusQuery === undefined) {
          return toToolError(new Error("Status query runtime is unavailable."));
        }
        const selection = registry.resolve(input.workspace_id);
        return structuredResponse(executionEventsOutputSchema, await context.statusQuery.listExecutionEvents({
          ...input,
          workspace_id: selection.id,
        }));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "get_identity_trace",
    {
      description: "Read identity evidence events and the durable submission state for exactly one submit_goal correlation_key. A pending_identity_expired failure applies only to this request, never to other Goals or Codex Sessions. For a started submission, use its execution_id with get_execution_status to read the associated Session and thread. Do not retry or resubmit automatically.",
      inputSchema: identityTraceQueryInputSchema,
      outputSchema: identityTraceOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        if (context.identityTrace === undefined) {
          return toToolError(new Error("Identity trace runtime is unavailable."));
        }
        const trace = await context.identityTrace.getIdentityTrace(input);
        const record = await context.pendingGoalSubmission?.get?.(input.correlation_key);
        const result = record?.state === "started" ? record
          : record?.state === "failed" || record?.state === "indeterminate" ? record.result : undefined;
        return structuredResponse(identityTraceOutputSchema, {
          ...trace,
          ...(record == null ? {} : { submission: {
            correlation_key: record.correlation_key,
            state: record.state,
            ...("error" in record ? { error: record.error } : {}),
            ...(result === undefined ? {} : {
              goal_id: result.goal_id, task_id: result.task_id, execution_id: result.execution_id,
            }),
            message: "本状态仅适用于此 correlation_key；pending_identity 表示等待网页身份证据，starting 表示身份已匹配，started 表示 Goal 启动已确认。身份超时不代表其他 Codex 会话未启动；不要自动重试或重新派发。",
          } }),
        });
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "get_evidence_transport_trace",
    {
      description: "Read the hash-only evidence transport trace for one submit_goal correlation key. Omit correlation_key to read recent browser diagnostics, including uncorrelated rows; these observations cannot bind a Goal. Optional limit: 1–200 (default 100 for recent diagnostics).",
      inputSchema: evidenceTransportTraceQueryInputSchema,
      outputSchema: evidenceTransportTraceOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        if (context.evidenceTransportTrace === undefined) {
          return toToolError(new Error("Evidence transport trace runtime is unavailable."));
        }
        return structuredResponse(
          evidenceTransportTraceOutputSchema,
          await context.evidenceTransportTrace.getEvidenceTransportTrace(input),
        );
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "submit_goal",
    {
      description: "Submit a Goal for the current web conversation in a registered workspace. accepted=true acknowledges receipt, not execution startup; query get_identity_trace with the same correlation_key for progress. Write concrete project changes, tests and verification outcomes in goal, requirements and acceptance_criteria. Provide workspace_id, execution_mode, model and reasoning_effort as separate tool arguments. Resolve workspace_id from the explicitly requested project or the project associated with this conversation using workspace_list; when no unique workspace is identifiable, request clarification instead of selecting a default. execution_mode defaults to interactive; batch explicitly selects the CLI. Generate a fresh UUID v4 correlation_key for each new submission. The Goal starts asynchronously after matching browser identity evidence; authentication or online presence alone is insufficient. Errors belong to their correlation_key; inspect status before any new submission.",
      inputSchema: goalSubmissionToolInputSchema,
      outputSchema: goalSubmissionAcceptedSchema,
    },
    async (input, extra) => {
      logMcpContextProbe(extra);
      const connectorProvenance = authenticatedMcpInvocationProof(extra);
      const pendingGoalSubmission = context.pendingGoalSubmission;
      if (pendingGoalSubmission === undefined) {
        return toToolError(new Error("Goal submission runtime is unavailable."));
      }

      try {
        assertExecutableTaskOnly(input);
        const selection = registry.resolveForSubmission(input.workspace_id);
        const correlation = context.correlations?.correlation(input.correlation_key);
        context.identityTrace?.record({
          event: "submit_goal_received",
          correlation_key: input.correlation_key,
          ...(correlation === null || correlation === undefined
            ? {}
            : { conversation_id: correlation.conversation_id }),
          workspace_id: selection.id,
          ...(input.execution_mode === undefined ? {} : { execution_mode: input.execution_mode }),
        });
        const pendingInput = {
          correlation_key: input.correlation_key,
          workspace_id: selection.id,
          title: input.title,
          goal: input.goal,
          requirements: input.requirements,
          acceptance_criteria: input.acceptance_criteria,
          max_iterations: input.max_iterations,
          ...(input.execution_mode === undefined ? {} : { execution_mode: input.execution_mode }),
          ...resolveGoalModelFields(input.model, input.reasoning_effort),
        };
        const accepted = connectorProvenance === undefined
          ? await pendingGoalSubmission.accept(pendingInput)
          : await pendingGoalSubmission.accept(pendingInput, connectorProvenance);
        return structuredResponse(goalSubmissionAcceptedSchema, accepted);
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  return server;
}
