import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GitError } from "../git/errors.js";
import { GitService } from "../git/service.js";
import { WorkspaceManager, WorkspacePathError } from "../workspace/manager.js";
import { searchText } from "../workspace/search.js";
import { containsNullByte } from "../workspace/text.js";

export interface McpRuntimeContext {
  readonly workspace: WorkspaceManager;
}

export const V01_TOOL_NAMES = [
  "workspace_info",
  "list_files",
  "read_file",
  "search_text",
  "git_status",
  "git_diff",
] as const;

export type V01ToolName = typeof V01_TOOL_NAMES[number];

export function registeredMcpToolsMessage(): string {
  return ["Registered MCP tools:", ...V01_TOOL_NAMES.map((name) => `- ${name}`)].join("\n");
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
} as const;

const MAX_VISITED_ENTRIES = 10_000;
export const MAX_READ_SCAN_BYTES = 8 * 1024 * 1024;
const ROOT_ALIAS = "workspace:/";

const listFilesInputSchema = {
  path: z.string().optional().default("."),
  depth: z.number().finite().int().min(1).max(4).optional().default(1),
  offset: z.number().finite().int().min(0).optional().default(0),
  limit: z.number().finite().int().min(1).max(1000).optional().default(200),
};

const readFileInputSchema = {
  path: z.string(),
  start_line: z.number().finite().int().min(1).optional().default(1),
  max_lines: z.number().finite().int().min(1).max(2000).optional().default(400),
  max_bytes: z.number().finite().int().min(1).max(1024 * 1024).optional().default(256 * 1024),
};

const searchTextInputSchema = {
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
  path: z.string().optional().default("."),
  stat: z.boolean().optional().default(false),
};

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
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: code }) }],
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

async function workspaceInfo(workspace: WorkspaceManager) {
  return {
    workspace_id: workspace.workspaceId,
    workspace_name: basename(workspace.canonicalRoot),
    root_alias: ROOT_ALIAS,
    project_types: await detectProjectTypes(workspace),
  };
}

export function createMcpServer(context: McpRuntimeContext): McpServer {
  const server = new McpServer({ name: "local-review-mcp", version: "0.1.0" });
  const git = new GitService(context.workspace);

  server.registerTool(
    "workspace_info",
    {
      description: "Return metadata about the currently authorized local workspace.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        return jsonResult(await workspaceInfo(context.workspace));
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
        return jsonResult(await listFiles(context.workspace, input));
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
        return jsonResult(await readFilePage(context.workspace, input));
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
        return jsonResult(await searchText(context.workspace, {
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
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        return jsonResult(await git.status());
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
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return jsonResult(await git.diff({ path: input.path, stat: input.stat }));
      } catch (error: unknown) {
        return toToolError(error);
      }
    },
  );

  return server;
}
