import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { isContainedPath, normalizeRemotePath, WorkspacePathError } from "./path.js";
import { containsNullByte } from "./text.js";
import type { ResolvedWorkspacePath, WorkspaceManager } from "./manager.js";
import { globToRegExp } from "./glob.js";

export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SEARCH_VISITED_ENTRIES = 20_000;
export const MAX_PREVIEW_CHARS = 500;
export const MAX_RG_OUTPUT_BYTES = 8 * 1024 * 1024;

const SEARCH_RESULT_BUFFER = 100;
const RG_TIMEOUT_MS = 20_000;

export interface SearchTextOptions {
  readonly query: string;
  readonly path: string;
  readonly glob?: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly limit: number;
}

export interface SearchTextResult {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

export interface SearchResponse {
  readonly query?: string;
  readonly path: string;
  readonly regex: boolean;
  readonly case_sensitive: boolean;
  readonly results: readonly SearchTextResult[];
  readonly returned: number;
  readonly has_more: boolean;
  readonly engine: "ripgrep" | "node";
}

export interface SearchTextDependencies {
  readonly rgPath?: string;
  readonly disableRipgrep?: boolean;
}

interface SearchGlob {
  readonly pattern: string;
  readonly matcher: RegExp;
  readonly hasSlash: boolean;
}

interface RgMatchEvent {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

interface RgProcessOutput {
  readonly output: Buffer;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError?: unknown;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

type MatchFinder = (line: string) => number | undefined;

function invalidSearchInput(): WorkspacePathError {
  return new WorkspacePathError("INVALID_PATH", "Invalid search input.");
}

function invalidGlob(): WorkspacePathError {
  return new WorkspacePathError("INVALID_PATH", "Invalid search glob.");
}

function invalidRegex(): WorkspacePathError {
  return new WorkspacePathError("INVALID_REGEX", "Invalid regular expression.");
}

function searchFailed(): WorkspacePathError {
  return new WorkspacePathError("SEARCH_FAILED", "Search failed.");
}

function validateOptions(options: SearchTextOptions): void {
  if (typeof options.query !== "string"
    || options.query.length === 0
    || options.query.length > 1000
    || options.query.trim() === ""
    || options.query.includes("\0")
    || !Number.isInteger(options.limit)
    || options.limit < 1
    || options.limit > 200) {
    throw invalidSearchInput();
  }
}

function compileSearchGlob(pattern: string | undefined): SearchGlob | undefined {
  if (pattern === undefined) return undefined;

  let normalized: string;
  try {
    normalized = normalizeRemotePath(pattern);
  } catch {
    throw invalidGlob();
  }
  if (normalized === "." || normalized.includes("[") || normalized.includes("]")) {
    throw invalidGlob();
  }

  try {
    return {
      pattern: normalized,
      matcher: globToRegExp(normalized),
      hasSlash: normalized.includes("/"),
    };
  } catch {
    throw invalidGlob();
  }
}

function matchesGlob(glob: SearchGlob | undefined, relativePath: string): boolean {
  if (glob === undefined) return true;
  if (glob.hasSlash) return glob.matcher.test(relativePath);
  return glob.matcher.test(relativePath.slice(relativePath.lastIndexOf("/") + 1));
}

function createMatchFinder(options: SearchTextOptions): MatchFinder {
  if (!options.regex) {
    const query = options.caseSensitive ? options.query : options.query.toLowerCase();
    return (line) => {
      const value = options.caseSensitive ? line : line.toLowerCase();
      const index = value.indexOf(query);
      return index === -1 ? undefined : index;
    };
  }

  let expression: RegExp;
  try {
    expression = new RegExp(options.query, options.caseSensitive ? "u" : "iu");
  } catch {
    throw invalidRegex();
  }
  return (line) => expression.exec(line)?.index;
}

function preview(line: string): string {
  const characters = Array.from(line);
  return characters.length <= MAX_PREVIEW_CHARS
    ? line
    : characters.slice(0, MAX_PREVIEW_CHARS).join("");
}

function stripLineEnding(value: string): string {
  const withoutLf = value.endsWith("\n") ? value.slice(0, -1) : value;
  return withoutLf.endsWith("\r") ? withoutLf.slice(0, -1) : withoutLf;
}

function lineResult(
  path: string,
  line: number,
  text: string,
  findMatch: MatchFinder,
): SearchTextResult | undefined {
  const matchIndex = findMatch(text);
  return matchIndex === undefined
    ? undefined
    : { path, line, column: matchIndex + 1, preview: preview(text) };
}

function searchContents(
  path: string,
  contents: string,
  findMatch: MatchFinder,
  maximumResults: number,
): SearchTextResult[] {
  const results: SearchTextResult[] = [];
  const lines = contents.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = index === 0 ? lines[index].replace(/^\uFEFF/u, "") : lines[index];
    const result = lineResult(path, index + 1, line, findMatch);
    if (result !== undefined) results.push(result);
    if (results.length >= maximumResults) break;
  }
  return results;
}

function compareResults(left: SearchTextResult, right: SearchTextResult): number {
  return left.path < right.path ? -1
    : left.path > right.path ? 1
      : left.line - right.line || left.column - right.column;
}

function response(
  options: SearchTextOptions,
  root: ResolvedWorkspacePath,
  results: SearchTextResult[],
  engine: SearchResponse["engine"],
): SearchResponse {
  results.sort(compareResults);
  const selected = results.slice(0, options.limit);
  return {
    ...(selected.length === 0 ? {} : { query: options.query }),
    path: root.relativePath,
    regex: options.regex,
    case_sensitive: options.caseSensitive,
    results: selected,
    returned: selected.length,
    has_more: results.length > options.limit,
    engine,
  };
}

async function validateSearchFile(
  workspace: WorkspaceManager,
  scopeRoot: ResolvedWorkspacePath,
  relativePath: string,
  resolved?: ResolvedWorkspacePath,
): Promise<ResolvedWorkspacePath | undefined> {
  let candidate: ResolvedWorkspacePath;
  try {
    candidate = resolved ?? workspace.resolveExisting(relativePath);
    if (!isContainedPath(scopeRoot.absolutePath, candidate.absolutePath)) return undefined;
    const stats = await stat(candidate.absolutePath);
    if (!stats.isFile() || stats.size > MAX_SEARCH_FILE_BYTES) return undefined;
    if (await containsNullByte(candidate.absolutePath, candidate.relativePath)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

async function readSearchFile(resolved: ResolvedWorkspacePath): Promise<string | undefined> {
  try {
    const contents = await readFile(resolved.absolutePath);
    if (contents.length > MAX_SEARCH_FILE_BYTES) return undefined;
    return contents.toString("utf8");
  } catch {
    return undefined;
  }
}

async function runNodeSearch(
  workspace: WorkspaceManager,
  root: ResolvedWorkspacePath,
  rootIsFile: boolean,
  options: SearchTextOptions,
  glob: SearchGlob | undefined,
  findMatch: MatchFinder,
): Promise<SearchTextResult[]> {
  const results: SearchTextResult[] = [];
  const maximumResults = options.limit + SEARCH_RESULT_BUFFER;
  const validated = new Map<string, ResolvedWorkspacePath | null>();

  async function searchFile(
    relativePath: string,
    resolved?: ResolvedWorkspacePath,
  ): Promise<void> {
    if (!matchesGlob(glob, relativePath) || results.length >= maximumResults) return;
    const key = resolved?.relativePath ?? relativePath;
    let safeFile = validated.get(key);
    if (safeFile === undefined && !validated.has(key)) {
      safeFile = await validateSearchFile(workspace, root, relativePath, resolved) ?? null;
      validated.set(key, safeFile);
    }
    if (safeFile === null || safeFile === undefined) return;
    const contents = await readSearchFile(safeFile);
    if (contents === undefined) return;
    results.push(...searchContents(safeFile.relativePath, contents, findMatch, maximumResults - results.length));
  }

  if (rootIsFile) {
    await searchFile(root.relativePath, root);
    return results;
  }

  let visitedEntries = 0;
  let capped = false;

  async function visit(directoryPath: string, directory: ResolvedWorkspacePath): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory.absolutePath, { withFileTypes: true });
    } catch {
      if (directoryPath === root.relativePath) {
        throw new WorkspacePathError("PATH_NOT_FOUND", "Workspace directory could not be read.", directoryPath);
      }
      return;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const entry of entries) {
      if (visitedEntries >= MAX_SEARCH_VISITED_ENTRIES) {
        capped = true;
        return;
      }
      visitedEntries += 1;
      const relativePath = directoryPath === "." ? entry.name : `${directoryPath}/${entry.name}`;

      let resolvedChild: ResolvedWorkspacePath;
      try {
        resolvedChild = workspace.resolveExisting(relativePath);
      } catch {
        continue;
      }
      if (entry.isSymbolicLink()) continue;

      let stats;
      try {
        stats = await stat(resolvedChild.absolutePath);
      } catch {
        continue;
      }
      if (stats.isFile()) {
        await searchFile(relativePath, resolvedChild);
        if (results.length >= maximumResults) {
          capped = true;
          return;
        }
      } else if (stats.isDirectory()) {
        await visit(relativePath, resolvedChild);
        if (capped || results.length >= maximumResults) return;
      }
    }
  }

  await visit(root.relativePath, root);
  return results;
}

function isRipgrepUnavailable(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR" || code === "EISDIR";
}

async function runRipgrepProcess(command: string, args: string[], cwd: string): Promise<RgProcessOutput> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, RG_TIMEOUT_MS);

    const finish = (output: RgProcessOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputTruncated) return;
      const remaining = MAX_RG_OUTPUT_BYTES - outputBytes;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        outputBytes = MAX_RG_OUTPUT_BYTES;
        outputTruncated = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
      outputBytes += chunk.length;
    });
    child.stderr?.resume();
    child.once("error", (error: unknown) => finish({
      output: Buffer.concat(chunks),
      exitCode: null,
      signal: null,
      spawnError: error,
      timedOut,
      outputTruncated,
    }));
    child.once("close", (exitCode, signal) => finish({
      output: Buffer.concat(chunks),
      exitCode,
      signal,
      timedOut,
      outputTruncated,
    }));
  });
}

function parseRgMatch(value: unknown): RgMatchEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Record<string, unknown>;
  if (event.type !== "match" || typeof event.data !== "object" || event.data === null) return undefined;
  const data = event.data as Record<string, unknown>;
  const path = data.path;
  const lines = data.lines;
  if (typeof path !== "object" || path === null || typeof lines !== "object" || lines === null) return undefined;
  const pathText = (path as Record<string, unknown>).text;
  const lineText = (lines as Record<string, unknown>).text;
  const lineNumber = data.line_number;
  if (typeof pathText !== "string" || typeof lineText !== "string"
    || typeof lineNumber !== "number" || !Number.isInteger(lineNumber) || lineNumber < 1) return undefined;
  return {
    path: pathText.replaceAll("\\", "/"),
    line: lineNumber,
    text: stripLineEnding(lineText),
  };
}

async function runRipgrepSearch(
  workspace: WorkspaceManager,
  root: ResolvedWorkspacePath,
  options: SearchTextOptions,
  glob: SearchGlob | undefined,
  findMatch: MatchFinder,
  dependencies: SearchTextDependencies,
): Promise<SearchTextResult[] | undefined> {
  const command = dependencies.rgPath ?? process.env.LOCAL_REVIEW_RG_PATH ?? "rg";
  const args = [
    "--json",
    "--line-number",
    "--column",
    "--hidden",
    "--no-ignore",
    "--max-filesize",
    `${MAX_SEARCH_FILE_BYTES / (1024 * 1024)}M`,
    ...(options.regex ? [] : ["--fixed-strings"]),
    ...(options.caseSensitive ? [] : ["--ignore-case"]),
    ...(glob === undefined ? [] : ["--glob", glob.pattern]),
    "--",
    options.query,
    root.relativePath,
  ];
  const processOutput = await runRipgrepProcess(command, args, workspace.canonicalRoot);
  if (processOutput.spawnError !== undefined) {
    if (isRipgrepUnavailable(processOutput.spawnError)) return undefined;
    throw searchFailed();
  }
  if (processOutput.timedOut || (processOutput.signal !== null && !processOutput.outputTruncated)) {
    throw searchFailed();
  }
  if (processOutput.exitCode !== 0 && processOutput.exitCode !== 1 && !processOutput.outputTruncated) {
    throw searchFailed();
  }

  const results: SearchTextResult[] = [];
  const validated = new Map<string, ResolvedWorkspacePath | null>();
  const maximumResults = options.limit + SEARCH_RESULT_BUFFER;
  for (const line of processOutput.output.toString("utf8").split(/\r?\n/u)) {
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      if (!processOutput.outputTruncated) throw searchFailed();
      continue;
    }
    const match = parseRgMatch(parsed);
    if (match === undefined) continue;

    let safeFile = validated.get(match.path);
    if (safeFile === undefined && !validated.has(match.path)) {
      safeFile = await validateSearchFile(workspace, root, match.path) ?? null;
      validated.set(match.path, safeFile);
    }
    if (safeFile === null || safeFile === undefined) continue;
    if (!matchesGlob(glob, match.path)) continue;

    const text = match.line === 1 ? match.text.replace(/^\uFEFF/u, "") : match.text;
    const result = lineResult(safeFile.relativePath, match.line, text, findMatch);
    if (result !== undefined) results.push(result);
    if (results.length >= maximumResults) break;
  }
  return results;
}

export async function searchText(
  workspace: WorkspaceManager,
  options: SearchTextOptions,
  dependencies: SearchTextDependencies = {},
): Promise<SearchResponse> {
  validateOptions(options);
  const root = workspace.resolveExisting(options.path);
  let rootStats;
  try {
    rootStats = await stat(root.absolutePath);
  } catch {
    throw new WorkspacePathError("PATH_NOT_FOUND", "Workspace path was not found.", root.relativePath);
  }
  if (!rootStats.isFile() && !rootStats.isDirectory()) {
    throw new WorkspacePathError("PATH_NOT_DIRECTORY", "Workspace path is not searchable.", root.relativePath);
  }

  const glob = compileSearchGlob(options.glob);
  const findMatch = createMatchFinder(options);
  const ripgrepResults = dependencies.disableRipgrep
    ? undefined
    : await runRipgrepSearch(workspace, root, options, glob, findMatch, dependencies);
  if (ripgrepResults !== undefined) return response(options, root, ripgrepResults, "ripgrep");

  const nodeResults = await runNodeSearch(
    workspace,
    root,
    rootStats.isFile(),
    options,
    glob,
    findMatch,
  );
  return response(options, root, nodeResults, "node");
}
