import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isContainedPath, normalizeRemotePath, WorkspacePathError } from "./path.js";
import { containsNullByte } from "./text.js";
import type { ResolvedWorkspacePath, WorkspaceManager } from "./manager.js";
import { globToRegExp } from "./glob.js";

export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SEARCH_VISITED_ENTRIES = 20_000;
export const MAX_PREVIEW_CHARS = 500;
export const MAX_RG_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_RG_BATCH_FILES = 400;
export const MAX_RG_ARG_BYTES = 24 * 1024;
export const RG_TIMEOUT_MS = 20_000;

const SEARCH_RESULT_BUFFER = 100;

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

export interface SearchCandidate {
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface SearchCandidateEnumeration {
  readonly candidates: readonly SearchCandidate[];
  readonly truncated: boolean;
}

export interface SearchTextDependencies {
  readonly rgPath?: string;
  readonly disableRipgrep?: boolean;
  readonly maxVisitedEntries?: number;
  readonly maxRgBatchFiles?: number;
  readonly maxRgArgBytes?: number;
  readonly runRipgrep?: RipgrepRunner;
}

export interface RipgrepRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface RipgrepResult {
  readonly output: string | Buffer;
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly spawnError?: unknown;
  readonly timedOut?: boolean;
  readonly outputTruncated?: boolean;
}

export type RipgrepRunner = (request: RipgrepRequest) => Promise<RipgrepResult>;

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

interface EngineSearchResult {
  readonly results: SearchTextResult[];
  readonly truncated: boolean;
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

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
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
  engineResult: EngineSearchResult,
  engine: SearchResponse["engine"],
): SearchResponse {
  engineResult.results.sort(compareResults);
  const selected = engineResult.results.slice(0, options.limit);
  return {
    ...(selected.length === 0 ? {} : { query: options.query }),
    path: root.relativePath,
    regex: options.regex,
    case_sensitive: options.caseSensitive,
    results: selected,
    returned: selected.length,
    has_more: engineResult.truncated || engineResult.results.length > options.limit,
    engine,
  };
}

async function safeSearchCandidate(
  workspace: WorkspaceManager,
  scopeRoot: ResolvedWorkspacePath,
  relativePath: string,
  glob: SearchGlob | undefined,
  resolved?: ResolvedWorkspacePath,
  knownStats?: Stats,
): Promise<SearchCandidate | undefined> {
  try {
    const candidate = resolved ?? workspace.resolveExisting(relativePath);
    if (!isContainedPath(scopeRoot.absolutePath, candidate.absolutePath)) return undefined;
    const stats = knownStats ?? await stat(candidate.absolutePath);
    if (!stats.isFile() || stats.size > MAX_SEARCH_FILE_BYTES) return undefined;
    if (await containsNullByte(candidate.absolutePath, candidate.relativePath)) return undefined;
    if (!matchesGlob(glob, candidate.relativePath)) return undefined;
    return {
      relativePath: candidate.relativePath,
      absolutePath: candidate.absolutePath,
    };
  } catch {
    return undefined;
  }
}

export async function enumerateSearchFiles(
  workspace: WorkspaceManager,
  root: ResolvedWorkspacePath,
  rootStats: Stats,
  glob: SearchGlob | undefined,
  maxVisitedEntries = MAX_SEARCH_VISITED_ENTRIES,
): Promise<SearchCandidateEnumeration> {
  const candidates: SearchCandidate[] = [];
  const visitLimit = positiveInteger(maxVisitedEntries, MAX_SEARCH_VISITED_ENTRIES);
  let visitedEntries = 0;
  let truncated = false;

  if (rootStats.isFile()) {
    const resolvedRoot = workspace.resolveExisting(root.relativePath);
    const candidate = await safeSearchCandidate(workspace, root, root.relativePath, glob, resolvedRoot, rootStats);
    if (candidate !== undefined) candidates.push(candidate);
    return { candidates, truncated: false };
  }

  async function visit(directoryPath: string, directory: ResolvedWorkspacePath): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory.absolutePath, { withFileTypes: true });
    } catch {
      if (directoryPath === root.relativePath) {
        throw new WorkspacePathError("PATH_NOT_FOUND", "Workspace directory could not be read.", directoryPath);
      }
      truncated = true;
      return;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const entry of entries) {
      if (visitedEntries >= visitLimit) {
        truncated = true;
        return;
      }
      visitedEntries += 1;
      const relativePath = directoryPath === "." ? entry.name : `${directoryPath}/${entry.name}`;

      let resolvedChild: ResolvedWorkspacePath;
      try {
        resolvedChild = workspace.resolveExisting(relativePath);
      } catch {
        if (visitedEntries >= visitLimit) truncated = true;
        if (truncated) return;
        continue;
      }
      if (entry.isSymbolicLink()) {
        if (visitedEntries >= visitLimit) truncated = true;
        if (truncated) return;
        continue;
      }

      let stats: Stats;
      try {
        stats = await stat(resolvedChild.absolutePath);
      } catch {
        if (visitedEntries >= visitLimit) truncated = true;
        if (truncated) return;
        continue;
      }
      if (stats.isFile()) {
        const candidate = await safeSearchCandidate(
          workspace,
          root,
          relativePath,
          glob,
          resolvedChild,
          stats,
        );
        if (candidate !== undefined) candidates.push(candidate);
      } else if (stats.isDirectory()) {
        await visit(relativePath, resolvedChild);
        if (truncated) return;
      }
      if (visitedEntries >= visitLimit) {
        truncated = true;
        return;
      }
    }
  }

  await visit(root.relativePath, root);
  return { candidates, truncated };
}

async function readSearchFile(candidate: SearchCandidate): Promise<string | undefined> {
  try {
    const contents = await readFile(candidate.absolutePath);
    if (contents.length > MAX_SEARCH_FILE_BYTES) return undefined;
    return contents.toString("utf8");
  } catch {
    return undefined;
  }
}

async function runNodeSearch(
  enumeration: SearchCandidateEnumeration,
  options: SearchTextOptions,
  findMatch: MatchFinder,
): Promise<EngineSearchResult> {
  const results: SearchTextResult[] = [];
  const maximumResults = options.limit + SEARCH_RESULT_BUFFER;
  let truncated = enumeration.truncated;

  for (const candidate of enumeration.candidates) {
    if (results.length >= maximumResults) {
      truncated = true;
      break;
    }
    const contents = await readSearchFile(candidate);
    if (contents === undefined) continue;
    results.push(...searchContents(
      candidate.relativePath,
      contents,
      findMatch,
      maximumResults - results.length,
    ));
    if (results.length >= maximumResults) {
      truncated = true;
      break;
    }
  }
  return { results, truncated };
}

function isRipgrepUnavailable(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR" || code === "EISDIR";
}

const defaultRipgrepRunner: RipgrepRunner = (request) => runRipgrepProcess(request);

async function runRipgrepProcess(request: RipgrepRequest): Promise<RipgrepResult> {
  return new Promise((resolve) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
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

    const finish = (result: RipgrepResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
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

function argBytes(args: readonly string[]): number {
  return args.reduce((total, argument) => total + Buffer.byteLength(argument, "utf8") + 1, 0);
}

function ripgrepBaseArgs(options: SearchTextOptions): string[] {
  return [
    "--json",
    "--line-number",
    "--column",
    "--max-filesize",
    `${MAX_SEARCH_FILE_BYTES / (1024 * 1024)}M`,
    ...(options.regex ? [] : ["--fixed-strings"]),
    ...(options.caseSensitive ? [] : ["--ignore-case"]),
  ];
}

function makeCandidateBatches(
  candidates: readonly SearchCandidate[],
  options: SearchTextOptions,
  maxFiles: number,
  maxBytes: number,
): SearchCandidate[][] {
  const baseArgs = [...ripgrepBaseArgs(options), "--", options.query];
  const fixedBytes = argBytes(baseArgs);
  const batches: SearchCandidate[][] = [];
  let current: SearchCandidate[] = [];
  let currentBytes = fixedBytes;

  for (const candidate of candidates) {
    const candidateBytes = Buffer.byteLength(candidate.relativePath, "utf8") + 1;
    const wouldExceedFiles = current.length >= maxFiles;
    const wouldExceedBytes = current.length > 0 && currentBytes + candidateBytes > maxBytes;
    if (current.length > 0 && (wouldExceedFiles || wouldExceedBytes)) {
      batches.push(current);
      current = [];
      currentBytes = fixedBytes;
    }
    current.push(candidate);
    currentBytes += candidateBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function boundedOutput(output: string | Buffer): { buffer: Buffer; truncated: boolean } {
  const buffer = typeof output === "string" ? Buffer.from(output, "utf8") : output;
  return buffer.length <= MAX_RG_OUTPUT_BYTES
    ? { buffer, truncated: false }
    : { buffer: buffer.subarray(0, MAX_RG_OUTPUT_BYTES), truncated: true };
}

function parseRgOutput(
  output: Buffer,
  candidates: readonly SearchCandidate[],
  findMatch: MatchFinder,
  maximumResults: number,
  outputTruncated: boolean,
): { results: SearchTextResult[]; truncated: boolean } {
  const candidateByPath = new Map(candidates.map((candidate) => [candidate.relativePath, candidate]));
  const results: SearchTextResult[] = [];
  let truncated = outputTruncated;

  for (const line of output.toString("utf8").split(/\r?\n/u)) {
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      if (!outputTruncated) throw searchFailed();
      continue;
    }
    const match = parseRgMatch(parsed);
    if (match === undefined) continue;

    let normalizedPath: string;
    try {
      normalizedPath = normalizeRemotePath(match.path);
    } catch {
      continue;
    }
    const candidate = candidateByPath.get(normalizedPath);
    if (candidate === undefined) continue;
    const text = match.line === 1 ? match.text.replace(/^\uFEFF/u, "") : match.text;
    const result = lineResult(candidate.relativePath, match.line, text, findMatch);
    if (result !== undefined) results.push(result);
    if (results.length >= maximumResults) {
      truncated = true;
      break;
    }
  }
  return { results, truncated };
}

async function runRipgrepSearch(
  workspace: WorkspaceManager,
  options: SearchTextOptions,
  enumeration: SearchCandidateEnumeration,
  findMatch: MatchFinder,
  dependencies: SearchTextDependencies,
): Promise<EngineSearchResult | undefined> {
  const maximumResults = options.limit + SEARCH_RESULT_BUFFER;
  const batches = makeCandidateBatches(
    enumeration.candidates,
    options,
    positiveInteger(dependencies.maxRgBatchFiles, MAX_RG_BATCH_FILES),
    positiveInteger(dependencies.maxRgArgBytes, MAX_RG_ARG_BYTES),
  );
  const runner = dependencies.runRipgrep ?? defaultRipgrepRunner;
  const command = dependencies.rgPath ?? process.env.LOCAL_REVIEW_RG_PATH ?? "rg";
  const results: SearchTextResult[] = [];
  let truncated = enumeration.truncated;

  for (const batch of batches) {
    const request: RipgrepRequest = {
      command,
      args: [...ripgrepBaseArgs(options), "--", options.query, ...batch.map((candidate) => candidate.relativePath)],
      cwd: workspace.canonicalRoot,
    };
    let processResult: RipgrepResult;
    try {
      processResult = await runner(request);
    } catch (error: unknown) {
      if (isRipgrepUnavailable(error)) return undefined;
      throw searchFailed();
    }

    if (processResult.spawnError !== undefined) {
      if (isRipgrepUnavailable(processResult.spawnError)) return undefined;
      throw searchFailed();
    }
    if (processResult.timedOut === true) throw searchFailed();
    const output = boundedOutput(processResult.output);
    const outputWasTruncated = processResult.outputTruncated === true || output.truncated;
    if (processResult.signal !== undefined && processResult.signal !== null && !outputWasTruncated) {
      throw searchFailed();
    }
    if (processResult.exitCode !== 0 && processResult.exitCode !== 1 && !outputWasTruncated) {
      throw searchFailed();
    }

    const parsed = parseRgOutput(
      output.buffer,
      batch,
      findMatch,
      maximumResults - results.length,
      outputWasTruncated,
    );
    results.push(...parsed.results);
    truncated ||= parsed.truncated;
    if (parsed.truncated || results.length >= maximumResults) {
      truncated = true;
      break;
    }
  }

  return { results, truncated };
}

export async function searchText(
  workspace: WorkspaceManager,
  options: SearchTextOptions,
  dependencies: SearchTextDependencies = {},
): Promise<SearchResponse> {
  validateOptions(options);
  const root = workspace.resolveExisting(options.path);
  let rootStats: Stats;
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
  const enumeration = await enumerateSearchFiles(
    workspace,
    root,
    rootStats,
    glob,
    dependencies.maxVisitedEntries ?? MAX_SEARCH_VISITED_ENTRIES,
  );

  if (!dependencies.disableRipgrep) {
    const ripgrepResult = await runRipgrepSearch(workspace, options, enumeration, findMatch, dependencies);
    if (ripgrepResult !== undefined) return response(options, root, ripgrepResult, "ripgrep");
  }

  const nodeResult = await runNodeSearch(enumeration, options, findMatch);
  return response(options, root, nodeResult, "node");
}
