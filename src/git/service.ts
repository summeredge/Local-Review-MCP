import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { GitError } from "./errors.js";
import type {
  GitDiffOptions,
  GitDiffResponse,
  GitStatusEntry,
  GitStatusResponse,
  ReviewSnapshot,
} from "./types.js";
import { isContainedPath, normalizeRemotePath } from "../workspace/path.js";
import type { ResolvedWorkspacePath, WorkspaceManager } from "../workspace/manager.js";

export const MAX_DIFF_BYTES = 4 * 1024 * 1024;
export const MAX_DIFF_FILES = 500;
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

const MAX_STATUS_BYTES = MAX_DIFF_BYTES;
const MAX_REPOSITORY_ROOT_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 20_000;

const BASE_GIT_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
];

export interface GitCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly maxOutputBytes: number;
}

export interface GitCommandResult {
  readonly stdout: string | Buffer;
  readonly exitCode: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly spawnError?: unknown;
  readonly timedOut?: boolean;
  readonly outputTruncated?: boolean;
}

export type GitRunner = (request: GitCommandRequest) => Promise<GitCommandResult>;

export interface GitServiceOptions {
  readonly gitPath?: string;
  readonly runGit?: GitRunner;
}

function isGitUnavailable(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR" || code === "EISDIR";
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
  };
  if (process.platform === "win32" && process.env.SystemRoot !== undefined) {
    environment.SystemRoot = process.env.SystemRoot;
  }
  return environment;
}

function runGitProcess(request: GitCommandRequest): Promise<GitCommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
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
    }, GIT_TIMEOUT_MS);

    const finish = (result: GitCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputTruncated) return;
      const remaining = request.maxOutputBytes - outputBytes;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        outputBytes = request.maxOutputBytes;
        outputTruncated = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
      outputBytes += chunk.length;
    });
    child.stderr?.resume();
    child.once("error", (error: unknown) => finish({
      stdout: Buffer.concat(chunks),
      exitCode: null,
      signal: null,
      spawnError: error,
      timedOut,
      outputTruncated,
    }));
    child.once("close", (exitCode, signal) => finish({
      stdout: Buffer.concat(chunks),
      exitCode,
      signal,
      timedOut,
      outputTruncated,
    }));
  });
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replaceAll("\\", "/");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function literalPath(path: string): string {
  return `:(literal)${path}`;
}

function nulSeparated(value: string | Buffer): string[] {
  return value.toString().split("\0").filter((item) => item !== "");
}

function changeType(index: string, worktree: string): GitStatusEntry["status"] {
  if (index === "?" && worktree === "?") return "untracked";
  if (index === "R" || worktree === "R") return "renamed";
  if (index === "A" || worktree === "A" || index === "C" || worktree === "C") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  return "modified";
}

function hasRenameStatus(index: string, worktree: string): boolean {
  return index === "R" || worktree === "R" || index === "C" || worktree === "C";
}

function binaryMarker(value: string): boolean {
  return /^Binary files .* differ\r?$/mu.test(value) || /\|\s+Bin\s+/u.test(value);
}

function binaryPaths(value: string, files: readonly string[]): string[] {
  const found = files.filter((path) =>
    value.includes(`Binary files a/${path} and b/${path} differ`)
    || value.split(/\r?\n/u).some((line) => line.includes(`${path} | Bin `)),
  );
  return found.length > 0 || !binaryMarker(value) || files.length !== 1 ? found : [files[0]];
}

function removeBinarySections(value: string): string {
  return value
    .split(/(?=^diff --git )/mu)
    .filter((section) => !/^Binary files .* differ\r?$/mu.test(section))
    .join("");
}

function hashRecord(hash: ReturnType<typeof createHash>, label: string, value: Buffer): void {
  hash.update(`${label}\0${value.length}\0`, "utf8");
  hash.update(value);
}

function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export class GitService {
  private readonly workspace: WorkspaceManager;
  private readonly gitPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runner: GitRunner;

  public constructor(workspace: WorkspaceManager, options: GitServiceOptions = {}) {
    this.workspace = workspace;
    this.gitPath = options.gitPath ?? "git";
    this.environment = gitEnvironment();
    this.runner = options.runGit ?? runGitProcess;
  }

  private async execute(args: readonly string[], maxOutputBytes: number): Promise<GitCommandResult> {
    try {
      return await this.runner({
        command: this.gitPath,
        args,
        cwd: this.workspace.canonicalRoot,
        env: this.environment,
        maxOutputBytes,
      });
    } catch (error: unknown) {
      if (isGitUnavailable(error)) {
        throw new GitError("GIT_NOT_FOUND");
      }
      throw new GitError("GIT_COMMAND_FAILED");
    }
  }

  private async run(
    args: readonly string[],
    maxOutputBytes: number,
    failureCode: GitError["code"] = "GIT_COMMAND_FAILED",
  ): Promise<Buffer> {
    const result = await this.execute(args, maxOutputBytes);
    if (result.spawnError !== undefined) {
      if (isGitUnavailable(result.spawnError)) throw new GitError("GIT_NOT_FOUND");
      throw new GitError("GIT_COMMAND_FAILED");
    }
    if (result.timedOut === true) throw new GitError("GIT_COMMAND_FAILED");
    if (result.outputTruncated === true) throw new GitError(failureCode);
    if (result.signal !== undefined && result.signal !== null) throw new GitError(failureCode);
    if (result.exitCode !== 0) throw new GitError(failureCode);
    const output = typeof result.stdout === "string" ? Buffer.from(result.stdout, "utf8") : result.stdout;
    if (output.length > maxOutputBytes) throw new GitError(failureCode);
    return output;
  }

  private async assertRepository(): Promise<void> {
    const output = await this.run(
      [...BASE_GIT_ARGS, "rev-parse", "--show-toplevel"],
      MAX_REPOSITORY_ROOT_BYTES,
      "NOT_A_REPOSITORY",
    );
    const reportedRoot = output.toString("utf8").trim();
    if (reportedRoot === "" || !isAbsolute(reportedRoot)) throw new GitError("NOT_A_REPOSITORY");

    let canonicalReportedRoot: string;
    try {
      canonicalReportedRoot = realpathSync.native(reportedRoot);
      if (!statSync(canonicalReportedRoot).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new GitError("NOT_A_REPOSITORY");
    }
    if (!samePath(canonicalReportedRoot, this.workspace.canonicalRoot)) {
      throw new GitError("NOT_A_REPOSITORY");
    }
  }

  private safeGitPath(rawPath: string, scope: ResolvedWorkspacePath): string | undefined {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRemotePath(rawPath);
    } catch {
      return undefined;
    }

    try {
      const resolved = this.workspace.resolvePath(normalizedPath);
      if (!isContainedPath(scope.absolutePath, resolved.absolutePath)) return undefined;
      return resolved.relativePath;
    } catch {
      return undefined;
    }
  }

  private async changedFiles(
    scope: ResolvedWorkspacePath,
    cached = false,
  ): Promise<string[]> {
    const scopeArgs = scope.relativePath === "." ? [] : [literalPath(scope.relativePath)];
    const output = await this.run([
      ...BASE_GIT_ARGS,
      "diff",
      ...(cached ? ["--cached"] : []),
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      ...scopeArgs,
    ], MAX_DIFF_BYTES, "DIFF_TOO_LARGE");
    const files: string[] = [];
    const seen = new Set<string>();
    for (const rawPath of nulSeparated(output)) {
      const safePath = this.safeGitPath(rawPath, scope);
      if (safePath === undefined || seen.has(safePath)) continue;
      seen.add(safePath);
      files.push(safePath);
      if (files.length > MAX_DIFF_FILES) throw new GitError("DIFF_TOO_LARGE");
    }
    return files;
  }

  private async branch(): Promise<string | null> {
    const output = await this.run([...BASE_GIT_ARGS, "branch", "--show-current"], 4096);
    const value = output.toString("utf8").trim();
    return value === "" ? null : value;
  }

  private async head(): Promise<string> {
    const output = await this.run([...BASE_GIT_ARGS, "rev-parse", "--verify", "HEAD"], 4096);
    const value = output.toString("utf8").trim();
    if (!/^[0-9a-f]+$/u.test(value)) throw new GitError("GIT_COMMAND_FAILED");
    return value;
  }

  private async snapshotDiff(cached: boolean, paths: readonly string[]): Promise<Buffer> {
    if (paths.length === 0) return Buffer.alloc(0);
    return this.run([
      ...BASE_GIT_ARGS,
      "diff",
      ...(cached ? ["--cached"] : []),
      "--binary",
      "--full-index",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--",
      ...paths.map(literalPath),
    ], MAX_DIFF_BYTES, "SNAPSHOT_TOO_LARGE");
  }

  private async untrackedFiles(): Promise<string[]> {
    const output = await this.run([
      ...BASE_GIT_ARGS,
      "ls-files",
      "--others",
      "--exclude-standard",
      "--full-name",
      "-z",
      "--",
    ], MAX_SNAPSHOT_BYTES, "SNAPSHOT_TOO_LARGE");
    const files = new Set<string>();
    for (const rawPath of nulSeparated(output)) {
      const safePath = this.safeGitPath(rawPath, {
        absolutePath: this.workspace.canonicalRoot,
        relativePath: ".",
      });
      if (safePath !== undefined) files.add(safePath);
      if (files.size > MAX_DIFF_FILES) throw new GitError("SNAPSHOT_TOO_LARGE");
    }
    return [...files].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  }

  private async hashUntracked(
    hash: ReturnType<typeof createHash>,
    paths: readonly string[],
  ): Promise<void> {
    let bytes = 0;
    for (const path of paths) {
      let contents: Buffer;
      try {
        const resolved = this.workspace.resolveExisting(path);
        const details = await stat(resolved.absolutePath);
        if (!details.isFile() || details.size > MAX_DIFF_BYTES) {
          throw new GitError("SNAPSHOT_TOO_LARGE");
        }
        contents = await readFile(resolved.absolutePath);
      } catch (error: unknown) {
        if (error instanceof GitError) throw error;
        throw new GitError("GIT_COMMAND_FAILED");
      }
      bytes += Buffer.byteLength(path, "utf8") + contents.length;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new GitError("SNAPSHOT_TOO_LARGE");
      hashRecord(hash, "untracked-path", Buffer.from(path, "utf8"));
      hashRecord(hash, "untracked-content", contents);
    }
  }

  private parseStatus(output: Buffer): GitStatusEntry[] {
    const entries: GitStatusEntry[] = [];
    const records = nulSeparated(output);
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.length < 4 || record[2] !== " ") continue;
      const statusIndex = record[0];
      const statusWorktree = record[1];
      const path = this.safeGitPath(record.slice(3), {
        absolutePath: this.workspace.canonicalRoot,
        relativePath: ".",
      });
      const rename = hasRenameStatus(statusIndex, statusWorktree);
      const originalPath = rename ? this.safeGitPath(records[index + 1] ?? "", {
        absolutePath: this.workspace.canonicalRoot,
        relativePath: ".",
      }) : undefined;
      if (rename) index += 1;
      if (path === undefined || (rename && originalPath === undefined)) continue;
      entries.push({
        path,
        index: statusIndex,
        worktree: statusWorktree,
        status: changeType(statusIndex, statusWorktree),
        ...(originalPath === undefined ? {} : { original_path: originalPath }),
      });
    }
    return entries;
  }

  public async status(): Promise<GitStatusResponse> {
    await this.assertRepository();
    const [branch, output] = await Promise.all([
      this.branch(),
      this.run([...BASE_GIT_ARGS, "status", "--short", "-z", "--untracked-files=all"], MAX_STATUS_BYTES),
    ]);
    return { branch, entries: this.parseStatus(output) };
  }

  public async diff(options: GitDiffOptions = {}): Promise<GitDiffResponse> {
    const scope = this.workspace.resolvePath(options.path ?? ".");
    const stat = options.stat ?? false;
    if (typeof stat !== "boolean") throw new GitError("GIT_COMMAND_FAILED");
    await this.assertRepository();

    const files = await this.changedFiles(scope);
    if (files.length === 0) {
      return { path: scope.relativePath, stat, diff: "", files, binary: false };
    }

    const output = await this.run([
      ...BASE_GIT_ARGS,
      "diff",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      ...(stat ? ["--stat"] : []),
      "--",
      ...files.map(literalPath),
    ], MAX_DIFF_BYTES, "DIFF_TOO_LARGE");
    const value = output.toString("utf8");
    const binary = binaryPaths(value, files);
    return {
      path: scope.relativePath,
      stat,
      diff: stat ? value : removeBinarySections(value),
      files,
      binary: binary.length > 0,
      ...(binary.length === 0 ? {} : { binary_paths: binary }),
    };
  }

  public async snapshot(): Promise<ReviewSnapshot> {
    await this.assertRepository();
    const scope = this.workspace.resolvePath(".");
    const [branch, head, stagedPaths, unstagedPaths, untracked] = await Promise.all([
      this.branch(),
      this.head(),
      this.changedFiles(scope, true),
      this.changedFiles(scope, false),
      this.untrackedFiles(),
    ]);
    const orderedStagedPaths = sortPaths(stagedPaths);
    const orderedUnstagedPaths = sortPaths(unstagedPaths);
    if (orderedStagedPaths.length + orderedUnstagedPaths.length + untracked.length > MAX_DIFF_FILES) {
      throw new GitError("SNAPSHOT_TOO_LARGE");
    }
    const [staged, unstaged] = await Promise.all([
      this.snapshotDiff(true, orderedStagedPaths),
      this.snapshotDiff(false, orderedUnstagedPaths),
    ]);
    const hash = createHash("sha256");
    hashRecord(hash, "staged", staged);
    hashRecord(hash, "unstaged", unstaged);
    await this.hashUntracked(hash, untracked);
    return {
      branch,
      head,
      diff_sha256: hash.digest("hex"),
    };
  }
}
