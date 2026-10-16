import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
vi.mock("../src/workspace/edit-directory-lease.js", async (original) => {
  const module = await original<typeof import("../src/workspace/edit-directory-lease.js")>();
  return { ...module, leaseEditDirectory: vi.fn(module.leaseEditDirectory) };
});
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), open: vi.fn((...args: Parameters<typeof import("node:fs/promises").open>) => import("node:fs").then((fs) => fs.promises.open(...args))), rename: vi.fn((...args: Parameters<typeof import("node:fs/promises").rename>) => import("node:fs").then((fs) => fs.promises.rename(...args))) }));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { parseWorkspaces } from "../src/config/settings.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createHttpServer } from "../src/mcp/http.js";
import { editWorkspaceFile, sha256 } from "../src/workspace/edit.js";
import { leaseEditDirectory } from "../src/workspace/edit-directory-lease.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const directories: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  vi.mocked(fs.open).mockImplementation((...args) => import("node:fs").then((fs) => fs.promises.open(...args)));
  vi.mocked(fs.rename).mockImplementation((...args) => import("node:fs").then((fs) => fs.promises.rename(...args)));
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture(bytes = Buffer.from("alpha\r\nbeta\r\ngamma\n")) {
  const root = await mkdtemp(join(tmpdir(), "lrm-edit-"));
  directories.push(root);
  await writeFile(join(root, "file.txt"), bytes);
  const registry = new WorkspaceRegistry([{ id: "edit", name: "Edit", path: root },
    { id: "other", name: "Other", path: await otherRoot() }]);
  const input = { workspace_id: "edit", path: "file.txt", expected_sha256: sha256(bytes),
    edits: [{ old_text: "alpha", new_text: "ALPHA" }] };
  return { root, registry, bytes, input, edit: (value = input) => editWorkspaceFile(registry.resolve(value.workspace_id), value) };
}
async function otherRoot() {
  const root = await mkdtemp(join(tmpdir(), "lrm-edit-other-")); directories.push(root);
  await writeFile(join(root, "file.txt"), "other"); return root;
}
it.each([undefined, true, false, "legacy"])("ignores legacy authorization field %s when loading registered workspaces", async (allow_file_edit) => {
  const f = await fixture();
  const entries = [{ id: "edit", name: "Edit", path: f.root, allow_file_edit }];
  const parsed = parseWorkspaces(entries)!;
  expect(parsed).toEqual([{ id: "edit", name: "Edit", path: f.root }]);
  for (const registry of [new WorkspaceRegistry(entries), new WorkspaceRegistry(parsed)]) {
    await editWorkspaceFile(registry.resolve("edit"), f.input);
    expect(await readFile(join(f.root, "file.txt"), "utf8")).toBe("ALPHA\r\nbeta\r\ngamma\n");
    await writeFile(join(f.root, "file.txt"), f.bytes);
  }
});
it("holds directory identity through publication and releases the native helper", async () => {
  const f = await fixture();
  const directory = join(f.root, "nested-中文");
  await mkdir(directory);
  await writeFile(join(directory, "file.txt"), f.bytes);
  const lease = await leaseEditDirectory(join(directory, "file.txt"));
  try {
    await expect(fs.rename(directory, join(f.root, "moved"))).rejects.toThrow();
    await expect(fs.rename(f.root, f.root + "-moved")).rejects.toThrow();
  } finally { await lease.release(); }
  await expect(lease.commit(join(directory, "orphan.tmp"), Buffer.from("unexpected"))).rejects.toThrow();
  expect(await readdir(directory)).toEqual(["file.txt"]);
  await fs.rename(directory, join(f.root, "moved"));
});
it("preserves BOM, raw bytes and mixed newlines with multiline and multiple replacements", async () => {
  const f = await fixture(Buffer.from("\ufeff汉字\r\nalpha\r\nbeta\r\ngamma\n"));
  const result = await f.edit({ ...f.input, edits: [
    { old_text: "alpha\r\nbeta", new_text: "A\r\nB" }, { old_text: "gamma", new_text: "G" },
  ] });
  const bytes = await readFile(join(f.root, "file.txt"));
  expect(bytes).toEqual(Buffer.from("\ufeff汉字\r\nA\r\nB\r\nG\n"));
  expect(result).toMatchObject({ success: true, edits_applied: 2, before_sha256: sha256(f.bytes), after_sha256: sha256(bytes) });
  expect(await readdir(f.root)).toEqual(["file.txt"]);
});
it.each([
  ["HASH_CONFLICT", { expected_sha256: "0".repeat(64) }],
  ["TEXT_NOT_FOUND", { edits: [{ old_text: "alpha", new_text: "A" }, { old_text: "missing", new_text: "X" }] }],
  ["OVERLAPPING_EDITS", { edits: [{ old_text: "alpha", new_text: "A" }, { old_text: "lpha", new_text: "X" }] }],
  ["TEXT_NOT_UNIQUE", { edits: [{ old_text: "a", new_text: "A" }] }],
  ["INVALID_PATH", { path: "../file.txt" }],
  ["INVALID_PATH", { path: "C:\\file.txt" }],
  ["SENSITIVE_PATH", { path: ".env" }],
  ["PATH_NOT_FOUND", { path: "missing" }],
] as const)("fails atomically for %s", async (code, extra) => {
  const f = await fixture();
  await expect(f.edit({ ...f.input, ...extra, edits: [...(("edits" in extra ? extra.edits : f.input.edits))] })).rejects.toMatchObject({ code });
  expect(await readFile(join(f.root, "file.txt"))).toEqual(f.bytes);
  expect(await readdir(f.root)).toEqual(["file.txt"]);
});
it("rejects mismatched and unknown workspaces and isolates registered roots", async () => {
  const f = await fixture();
  await expect(editWorkspaceFile(f.registry.resolve("other"), f.input)).rejects.toMatchObject({ code: "EDIT_NOT_AUTHORIZED" });
  expect(() => f.edit({ ...f.input, workspace_id: "unknown" })).toThrow(expect.objectContaining({ code: "UNKNOWN_WORKSPACE_ID" }));
  await expect(f.edit({ ...f.input, workspace_id: "other" })).rejects.toMatchObject({ code: "HASH_CONFLICT" });
  expect(await readFile(join(f.root, "file.txt"))).toEqual(f.bytes);
  expect(await readFile(join(f.registry.resolve("other").manager.root, "file.txt"), "utf8")).toBe("other");
  await f.edit({ ...f.input, workspace_id: "other", expected_sha256: sha256(Buffer.from("other")),
    edits: [{ old_text: "other", new_text: "OTHER" }] });
  expect(await readFile(join(f.registry.resolve("other").manager.root, "file.txt"), "utf8")).toBe("OTHER");
  expect(await readFile(join(f.root, "file.txt"))).toEqual(f.bytes);
});
it.each([
  ["INVALID_UTF8", Buffer.from([0xff])], ["BINARY_FILE", Buffer.from([0x61, 0])],
  ["FILE_TOO_LARGE", Buffer.alloc(1024 * 1024 + 1, 0x61)],
] as const)("rejects %s without changing bytes", async (code, bytes) => {
  const f = await fixture(bytes);
  await expect(f.edit()).rejects.toMatchObject({ code });
  expect((await readFile(join(f.root, "file.txt"))).equals(bytes)).toBe(true);
});
it("rejects directories, hard links, Junctions and symlink escapes", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "directory"));
  await expect(f.edit({ ...f.input, path: "directory" })).rejects.toMatchObject({ code: "UNSAFE_EDIT_TARGET" });
  await link(join(f.root, "file.txt"), join(f.root, "hard.txt"));
  await expect(f.edit()).rejects.toMatchObject({ code: "UNSAFE_EDIT_TARGET" });
  await mkdir(join(f.root, "inside")); await writeFile(join(f.root, "inside", "file.txt"), f.bytes);
  await symlink(join(f.root, "inside"), join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");
  await expect(f.edit({ ...f.input, path: "alias/file.txt" })).rejects.toMatchObject({ code: "UNSAFE_EDIT_TARGET" });
  await symlink(f.registry.resolve("other").manager.root, join(f.root, "escape"), process.platform === "win32" ? "junction" : "dir");
  await expect(f.edit({ ...f.input, path: "escape/file.txt" })).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
});
it("serializes competing hashes and cleans temporary files on commit failure", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.edit(), f.edit()]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "HASH_CONFLICT" } });
  await writeFile(join(f.root, "file.txt"), f.bytes);
  const nativeLease = await leaseEditDirectory(join(f.root, "file.txt"));
  vi.mocked(leaseEditDirectory).mockResolvedValueOnce({
    async commit(temporary, contents) {
      await fs.chmod(join(f.root, "file.txt"), 0o444);
      try { await nativeLease.commit(temporary, contents); }
      finally { await fs.chmod(join(f.root, "file.txt"), 0o666); }
    },
    release: nativeLease.release,
  });
  await expect(f.edit()).rejects.toMatchObject({ code: "EDIT_WRITE_FAILED" });
  expect(await readFile(join(f.root, "file.txt"))).toEqual(f.bytes);
  expect(await readdir(f.root)).toEqual(["file.txt"]);
});
it("enforces MCP schema and annotations", async () => {
  const f = await fixture();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "edit-test", version: "1" }); clients.push(client);
  await Promise.all([createMcpServer({ registry: f.registry }).connect(b), client.connect(a)]);
  const tool = (await client.listTools()).tools.find((t) => t.name === "workspace_edit_file");
  expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  for (const extra of [{ workspace_id: undefined }, { edits: [] }, { edits: [{ old_text: "", new_text: "x" }] },
    { edits: [{ old_text: "alpha", new_text: "\ud800" }] }, { expected_sha256: "bad" }]) {
    expect((await client.callTool({ name: "workspace_edit_file", arguments: { ...f.input, ...extra } })).isError).toBe(true);
  }
});
it("returns page and hash from the same snapshot even when disk changes immediately afterwards", async () => {
  const f = await fixture();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "snapshot-test", version: "1" }); clients.push(client);
  await Promise.all([createMcpServer({ registry: f.registry }).connect(b), client.connect(a)]);
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await (await import("node:fs")).promises.open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => { await close(); await writeFile(join(f.root, "file.txt"), "external version\n"); };
    return handle;
  });
  const result = await client.callTool({ name: "workspace_read_file", arguments: { workspace_id: "edit", path: "file.txt", end_line: 1 } });
  expect(result.structuredContent).toMatchObject({ content: "alpha", sha256: sha256(f.bytes) });
  expect(await readFile(join(f.root, "file.txt"), "utf8")).toBe("external version\n");
});
it("rejects an oversized result without publishing any replacement", async () => {
  const f = await fixture();
  await expect(f.edit({ ...f.input, edits: [{ old_text: "alpha", new_text: "x".repeat(1024 * 1024) }] }))
    .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  expect(await readFile(join(f.root, "file.txt"))).toEqual(f.bytes);
});
it("PASS: authenticated isolated HTTP MCP read → edit → read and Git diff", async () => {
  const f = await fixture(Buffer.from("\ufeffalpha\r\nbeta\r\ngamma\n"));
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: f.root });
  await git("init"); await git("-c", "core.autocrlf=false", "add", "file.txt");
  const server = createHttpServer({ host: "127.0.0.1", port: 0, workspace: f.root, auth: { token: "isolated-edit-test" },
    remote: { enabled: false, endpoint: "" }, supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 } }, { registry: f.registry });
  const client = new Client({ name: "edit-http-test", version: "1" });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),
      { requestInit: { headers: { Authorization: "Bearer isolated-edit-test" } } }));
    const read = () => client.callTool({ name: "workspace_read_file", arguments: { workspace_id: "edit", path: "file.txt", end_line: 1 } });
    const before = (await read()).structuredContent as Record<string, unknown>;
    expect(before.sha256).toBe(sha256(f.bytes));
    const edited = await client.callTool({ name: "workspace_edit_file", arguments: { ...f.input, expected_sha256: before.sha256 } });
    expect(edited.isError).not.toBe(true);
    const after = (await read()).structuredContent as Record<string, unknown>;
    expect(after.content).toBe("ALPHA");
    expect(after.sha256).toBe((edited.structuredContent as Record<string, unknown>)?.after_sha256);
    expect((await git("diff", "--", "file.txt")).stdout).toContain("+\ufeffALPHA");
    expect(await readdir(f.root)).toEqual(expect.arrayContaining([".git", "file.txt"]));
    expect((await readdir(f.root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
