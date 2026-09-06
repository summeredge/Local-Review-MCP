import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitService, MAX_DIFF_BYTES } from "../../src/git/service.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import type { ReviewSnapshot } from "../../src/git/types.js";

const runProcess = promisify(execFile);
const clients: Client[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});
describe("GitService review snapshot", () => {
  it("is deterministic for a clean repository", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, { "app.txt": "hello\n" });

    const first = await snapshot(workspace);
    const second = await snapshot(workspace);

    expect(first).toEqual(second);
    expect(first.branch).toBe("main");
    expect(first.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(first.diff_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("changes the fingerprint for unstaged tracked content", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, { "app.txt": "before\n" });
    const clean = await snapshot(workspace);

    await writeFile(join(workspace, "app.txt"), "after\n");

    expect((await snapshot(workspace)).diff_sha256).not.toBe(clean.diff_sha256);
  });

  it("changes the fingerprint for staged tracked content", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, { "app.txt": "before\n" });
    const clean = await snapshot(workspace);

    await writeFile(join(workspace, "app.txt"), "staged\n");
    await git(workspace, "add", "app.txt");

    expect((await snapshot(workspace)).diff_sha256).not.toBe(clean.diff_sha256);
  });

  it("changes the fingerprint when both index and worktree versions change", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, { "app.txt": "before\n" });
    const clean = await snapshot(workspace);

    await writeFile(join(workspace, "app.txt"), "staged\n");
    await git(workspace, "add", "app.txt");
    await writeFile(join(workspace, "app.txt"), "worktree\n");

    const snapshotWithBoth = await snapshot(workspace);
    expect(snapshotWithBoth.diff_sha256).not.toBe(clean.diff_sha256);

    await writeFile(join(workspace, "app.txt"), "worktree-2\n");
    expect((await snapshot(workspace)).diff_sha256).not.toBe(snapshotWithBoth.diff_sha256);
  });

  it("changes the fingerprint for untracked paths and their contents", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, { "tracked.txt": "tracked\n" });
    const clean = await snapshot(workspace);

    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "untracked.txt"), "one\n");
    const added = await snapshot(workspace);
    expect(added.diff_sha256).not.toBe(clean.diff_sha256);

    await writeFile(join(workspace, "src", "untracked.txt"), "two\n");
    expect((await snapshot(workspace)).diff_sha256).not.toBe(added.diff_sha256);
  });

  it("ignores ignored files in the fingerprint", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, {
      "app.txt": "tracked\n",
      ".gitignore": "ignored.txt\n",
    });
    const clean = await snapshot(workspace);

    await writeFile(join(workspace, "ignored.txt"), "ignored content\n");

    expect((await snapshot(workspace)).diff_sha256).toBe(clean.diff_sha256);
  });

  it("changes head and detects branch changes", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, { "app.txt": "first\n" });
    const before = await snapshot(workspace);
    await git(workspace, "checkout", "-b", "feature");
    await writeFile(join(workspace, "app.txt"), "second\n");
    await git(workspace, "add", "app.txt");
    await git(workspace, "commit", "-m", "second");

    const after = await snapshot(workspace);
    expect(after.branch).toBe("feature");
    expect(after.head).not.toBe(before.head);

    await git(workspace, "checkout", "main");
    expect((await snapshot(workspace)).branch).toBe("main");
  });
});

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-git-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(workspace: string, ...args: string[]): Promise<string> {
  const { stdout } = await runProcess("git", args, {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
  return stdout;
}

async function initRepository(workspace: string, files: Record<string, string>): Promise<void> {
  await git(workspace, "init", "-b", "main");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "config", "user.name", "Local Review Test");
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(workspace, path, ".."), { recursive: true });
    await writeFile(join(workspace, path), contents);
  }
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "initial");
}

function snapshotService(workspace: string): GitService {
  return new GitService(new WorkspaceManager(workspace));
}

async function snapshot(workspace: string): Promise<ReviewSnapshot> {
  return snapshotService(workspace).snapshot();
}

function toolText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || typeof content[0] !== "object" || content[0] === null
    || typeof (content[0] as { text?: unknown }).text !== "string") {
    throw new Error("tool did not return text content");
  }
  return (content[0] as { text: string }).text;
}

function toolJson<T>(result: unknown): T {
  const parsed = JSON.parse(toolText(result)) as T;
  expect((result as { structuredContent?: unknown }).structuredContent).toEqual(parsed);
  return parsed;
}

async function callTool(
  workspace: string,
  name: "git_status" | "git_diff",
  arguments_: Record<string, unknown>,
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "git-tools-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([
    createMcpServer({ registry: WorkspaceRegistry.fromManager(new WorkspaceManager(workspace)) }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client.callTool({ name, arguments: arguments_ });
}

describe("Git readonly review tools", () => {
  it("returns modified, added, deleted, renamed, and untracked status entries", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, {
      "modified.txt": "before\n",
      "deleted.txt": "gone\n",
      "rename.txt": "rename me\n",
      "stable.txt": "stable\n",
    });
    await writeFile(join(workspace, "modified.txt"), "after\n");
    await rm(join(workspace, "deleted.txt"));
    await git(workspace, "mv", "rename.txt", "renamed.txt");
    await writeFile(join(workspace, "added.txt"), "added\n");
    await git(workspace, "add", "added.txt");
    await writeFile(join(workspace, "untracked.txt"), "untracked\n");

    const result = toolJson<{
      branch: string;
      entries: { path: string; original_path?: string; status: string; index: string; worktree: string }[];
    }>(await callTool(workspace, "git_status", {}));
    expect(result.branch).toBe("main");
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "added.txt",
      "deleted.txt",
      "modified.txt",
      "renamed.txt",
      "untracked.txt",
    ]);
    expect(result.entries.map((entry) => entry.status)).toEqual([
      "added",
      "deleted",
      "modified",
      "renamed",
      "untracked",
    ]);
    expect(result.entries.find((entry) => entry.path === "renamed.txt")).toMatchObject({
      original_path: "rename.txt",
      index: "R",
    });
  });

  it("returns bounded diff content and supports a relative path", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, { "src/app.txt": "hello\n" });
    await writeFile(join(workspace, "src/app.txt"), "hello world\n");

    const result = toolJson<{
      diff: string;
      files: string[];
      binary: boolean;
    }>(await callTool(workspace, "git_diff", {}));
    expect(result.diff).toContain("-hello");
    expect(result.diff).toContain("+hello world");
    expect(result.files).toEqual(["src/app.txt"]);
    expect(result.binary).toBe(false);

    const pathResult = toolJson<{ path: string; diff: string }>(await callTool(workspace, "git_diff", {
      path: "src/app.txt",
    }));
    expect(pathResult.path).toBe("src/app.txt");
    expect(pathResult.diff).toContain("+hello world");

    const statResult = toolJson<{ stat: boolean; diff: string }>(await callTool(workspace, "git_diff", {
      stat: true,
    }));
    expect(statResult.stat).toBe(true);
    expect(statResult.diff).toContain("app.txt");
  });

  it("rejects paths outside the authorized workspace", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, { "app.txt": "hello\n" });

    const result = await callTool(workspace, "git_diff", { path: "../outside.txt" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(toolText(result))).toEqual({ error: "INVALID_PATH" });
  });

  it("filters sensitive status and diff paths through AccessPolicy", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, {
      ".localreviewignore": "secret.txt\n",
      ".env": "before-env\n",
      "secret.txt": "before-secret\n",
      "public.txt": "before-public\n",
    });
    await writeFile(join(workspace, ".env"), "after-env\n");
    await writeFile(join(workspace, "secret.txt"), "after-secret\n");
    await writeFile(join(workspace, "public.txt"), "after-public\n");

    const status = toolJson<{ entries: { path: string }[] }>(await callTool(workspace, "git_status", {}));
    const diff = toolJson<{
      diff: string;
      files: string[];
    }>(await callTool(workspace, "git_diff", {}));
    expect(status.entries.map((entry) => entry.path)).toEqual(["public.txt"]);
    expect(diff.files).toEqual(["public.txt"]);
    expect(diff.diff).toContain("after-public");
    expect(diff.diff).not.toContain("after-env");
    expect(diff.diff).not.toContain("after-secret");
  });

  it("returns binary metadata without binary contents", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, { "image.png": "not really binary\n" });
    await writeFile(join(workspace, "image.png"), Buffer.from([0, 1, 2, 3, 4]));

    const result = toolJson<{
      binary: boolean;
      binary_paths: string[];
      diff: string;
    }>(await callTool(workspace, "git_diff", {}));
    expect(result.binary).toBe(true);
    expect(result.binary_paths).toEqual(["image.png"]);
    expect(result.diff).not.toContain("\u0000");
  });

  it("returns DIFF_TOO_LARGE instead of a partial patch", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, { "large.txt": "initial\n" });
    const lines = Array.from({ length: Math.ceil((MAX_DIFF_BYTES + 1024) / 32) }, (_, index) =>
      `line-${String(index).padStart(8, "0")}-xxxxxxxxxxxxxxxx\n`).join("");
    await writeFile(join(workspace, "large.txt"), lines);

    const result = await callTool(workspace, "git_diff", {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(toolText(result))).toEqual({ error: "DIFF_TOO_LARGE" });
  });

  it("does not execute diff.external", async () => {
    const workspace = await makeWorkspace();
    await initRepository(workspace, { "app.txt": "before\n" });
    const marker = join(workspace, "external-marker.txt");
    const external = process.platform === "win32"
      ? join(workspace, "external-diff.cmd")
      : join(workspace, "external-diff.sh");
    const script = process.platform === "win32"
      ? `@echo off\r\necho invoked>${marker}\r\n`
      : `#!/bin/sh\nprintf invoked > '${marker}'\n`;
    await writeFile(external, script);
    if (process.platform !== "win32") await chmod(external, 0o755);
    await git(workspace, "config", "diff.external", external);
    await writeFile(join(workspace, "app.txt"), "after\n");

    const result = await callTool(workspace, "git_diff", {});
    expect(result.isError).not.toBe(true);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
