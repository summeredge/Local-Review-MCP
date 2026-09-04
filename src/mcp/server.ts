import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitError } from "../git/errors.js";
import { GitService } from "../git/service.js";
import type { GitDiffResponse, GitStatusResponse } from "../git/types.js";
import { WorkspaceManager, WorkspacePathError } from "../workspace/manager.js";
import { WorkspaceRegistry, type WorkspaceSelection } from "../workspace/registry.js";
import { searchText } from "../workspace/search.js";
import { containsNullByte } from "../workspace/text.js";
import { structuredResponse } from "./respond.js";
import { ROOT_ALIAS } from "./schema/common.js";
import {
  gitDiffOutputSchema,
  gitStatusOutputSchema,
} from "./schema/git.js";
import {
  workspaceInfoOutputSchema,
  type WorkspaceInfoOutput,
} from "./schema/workspace.js";

export interface McpRuntimeContext {
  readonly workspace?: WorkspaceManager;
  readonly registry?: WorkspaceRegistry;
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
export const REGISTERED_TOOL_NAMES = [
  ...V01_TOOL_NAMES,
  ...WORKSPACE_REGISTRY_TOOL_NAMES,
  ...REVIEW_CONTEXT_TOOL_NAMES,
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

const gitDiffInputSchema = {
  ...workspaceIdInputSchema,
  path: z.string().optional().default("."),
  stat: z.boolean().optional().default(false),
};
const EXECUTION_OUTPUT_PATH = ".review/execution_output.json";

interface ListedEntry {
  readonly path: string;
  readonly name: string;
  readonly type: "file" | "directory";
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export function toToolError(error: unknown) {
  const code = error instanceof WorkspacePathError || error instanceof GitError
    ? error.code
    : "INTERNAL_ERROR";
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

  const inputStream = createReadStream(resolved.absolutePath, { encoding: "utf8" });
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

async function reviewSummary(selection: WorkspaceSelection) {
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

async function executionOutput(workspace: WorkspaceManager): Promise<unknown> {
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
  return JSON.parse(await readFile(resolved.absolutePath, "utf8")) as unknown;
}

export function createMcpServer(context: McpRuntimeContext): McpServer {
  const registry = context.registry
    ?? (context.workspace === undefined ? undefined : WorkspaceRegistry.fromManager(context.workspace));
  if (registry === undefined) throw new Error("Workspace registry is required.");
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
      try {
        return structuredResponse(await workspaceInfo(registry.resolve(input.workspace_id)));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "list_files",
    {
      description: "List non-sensitive files and directories within the authorized workspace.",
      inputSchema: listFilesInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return jsonResult(await listFiles(registry.resolve(input.workspace_id).manager, input));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "read_file",
    {
      description: "Read a bounded range of a non-sensitive text file in the authorized workspace.",
      inputSchema: readFileInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return jsonResult(await readFilePage(registry.resolve(input.workspace_id).manager, input));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  server.registerTool(
    "search_text",
    {
      description: "Search non-sensitive text files within the authorized workspace using bounded literal or regular-expression matching.",
      inputSchema: searchTextInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return jsonResult(await searchText(registry.resolve(input.workspace_id).manager, {
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
    "git_status",
    {
      description: "Return the structured Git status of the authorized workspace.",
      inputSchema: workspaceIdInputSchema,
      outputSchema: gitStatusOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return structuredResponse(await new GitService(registry.resolve(input.workspace_id).manager).status());
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
        return structuredResponse(await new GitService(registry.resolve(input.workspace_id).manager).diff({
          path: input.path,
          stat: input.stat,
        }));
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
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => jsonResult({ workspaces: registry.list() }),
  );

  server.registerTool(
    "review_summary",
    {
      description: "Return a read-only Git and workspace summary for review; omitted workspace_id uses the active workspace.",
      inputSchema: workspaceIdInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return jsonResult(await reviewSummary(registry.resolve(input.workspace_id)));
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
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return jsonResult(await executionOutput(registry.resolve(input.workspace_id).manager));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  return server;
}
