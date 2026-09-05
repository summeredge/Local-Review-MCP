import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppContext } from "../src/app.js";
import { createMcpServer } from "../src/mcp/server.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

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

async function makeWorkspace(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `local-review-mcp-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(workspace: string, ...args: string[]): Promise<void> {
  await runProcess("git", args, {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
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

async function callTool(
  registry: WorkspaceRegistry,
  name: string,
  arguments_: Record<string, unknown> = {},
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "review-context-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([
    createMcpServer({ registry }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client.callTool({ name, arguments: arguments_ });
}

function toolText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || typeof content[0] !== "object" || content[0] === null
    || typeof (content[0] as { text?: unknown }).text !== "string") {
    throw new Error("tool did not return text content");
  }
  return (content[0] as { text: string }).text;
}

function resultJson(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const parsed = JSON.parse(toolText(result)) as Record<string, unknown>;
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

describe("Review context tools", () => {
  it("uses the current runtime registry identity across workspace tools", async () => {
    const workspace = await makeWorkspace("runtime-registry");
    await initRepository(workspace, { "README.md": "runtime\n" });
    const runtimeIdentity = {
      id: "0ee5a4a43938",
      name: "Local-Review-MCP",
      path: workspace,
    } as const;
    const context = createAppContext({
      host: "127.0.0.1",
      port: 12080,
      workspace,
      workspaceIdentity: runtimeIdentity,
      workspaces: [runtimeIdentity],
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "runtime-registry-test", version: "0.1.0" });
    clients.push(client);
    await Promise.all([
      createMcpServer(context).connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = resultJson(await client.callTool({ name: "workspace_list", arguments: {} }));
    const info = resultJson(await client.callTool({ name: "workspace_info", arguments: {} }));
    const summary = resultJson(await client.callTool({ name: "review_summary", arguments: {} }));

    expect(info.workspace_id).toBe(summary.workspace_id);
    expect((listed.workspaces as Array<{ id: string }>)[0]?.id).toBe(summary.workspace_id);
    expect(summary.workspace_id).toBe(runtimeIdentity.id);

    const stale = await client.callTool({
      name: "review_summary",
      arguments: { workspace_id: "026e562c5692" },
    });
    expect(stale.isError).toBe(true);
    expect(JSON.parse(toolText(stale))).toEqual({
      error: "UNKNOWN_WORKSPACE_ID",
      message: "Unknown workspace_id",
    });
  });

  it("returns workspace, branch, status, and diff summaries", async () => {
    const workspace = await makeWorkspace("summary");
    await initRepository(workspace, {
      "app.txt": "before\n",
      "deleted.txt": "gone\n",
      "stable.txt": "stable\n",
    });
    await writeFile(join(workspace, "app.txt"), "after\nadded\n");
    await rm(join(workspace, "deleted.txt"));
    await writeFile(join(workspace, "new.txt"), "new\n");

    const registry = new WorkspaceRegistry([
      { id: "data-project", name: "DataProject", path: workspace },
    ]);
    const listed = resultJson(await callTool(registry, "workspace_list"));
    const result = resultJson(await callTool(registry, "review_summary"));

    const info = resultJson(await callTool(registry, "workspace_info"));
    const status = resultJson(await callTool(registry, "git_status"));
    const diff = resultJson(await callTool(registry, "git_diff"));
    expect(listed).toEqual({
      workspaces: [{ id: "data-project", name: "DataProject" }],
    });
    expect(info).toMatchObject({
      workspace_id: result.workspace_id,
      workspace_name: result.workspace_name,
    });
    expect(status.workspace_id).toBe(result.workspace_id);
    expect(diff.workspace_id).toBe(result.workspace_id);

    expect(result).toEqual({
      workspace_id: "data-project",
      workspace_name: "DataProject",
      git_branch: "main",
      git_status_summary: { modified: 1, added: 1, deleted: 1 },
      diff_summary: { files_changed: 2, insertions: 2, deletions: 2 },
    });
  });

  it("routes review summaries to the selected workspace", async () => {
    const dataProject = await makeWorkspace("data-project");
    const pcaBuilder = await makeWorkspace("pca-builder");
    await initRepository(dataProject, { "README.md": "data\n" });
    await initRepository(pcaBuilder, { "README.md": "pca\n" });
    const registry = new WorkspaceRegistry([
      { id: "data-project", name: "DataProject", path: dataProject },
      { id: "pca-builder", name: "PCA_Model_Builder", path: pcaBuilder },
    ]);

    expect(resultJson(await callTool(registry, "review_summary", {
      workspace_id: "pca-builder",
    }))).toMatchObject({
      workspace_id: "pca-builder",
      workspace_name: "PCA_Model_Builder",
      git_branch: "main",
    });
  });

  it("reads the fixed execution output file", async () => {
    const workspace = await makeWorkspace("execution");
    await mkdir(join(workspace, ".review"));
    const output = {
      timestamp: "2026-09-04T10:00:00Z",
      command: "npm test",
      status: "passed",
      summary: "161 tests passed",
    };
    await writeFile(join(workspace, ".review", "execution_output.json"), JSON.stringify(output));
    const registry = new WorkspaceRegistry([
      { id: "data-project", name: "DataProject", path: workspace },
    ]);

    expect(resultJson(await callTool(registry, "execution_output"))).toEqual(output);
  });

  it("returns available false when execution output is absent", async () => {
    const workspace = await makeWorkspace("missing-execution");
    const registry = new WorkspaceRegistry([
      { id: "data-project", name: "DataProject", path: workspace },
    ]);

    expect(resultJson(await callTool(registry, "execution_output"))).toEqual({ available: false });
  });

  it("does not use path-like arguments for execution output", async () => {
    const workspace = await makeWorkspace("fixed-path");
    const outside = await makeWorkspace("outside");
    const outsideFile = join(outside, "result.json");
    await mkdir(join(workspace, ".review"));
    await writeFile(join(workspace, ".review", "execution_output.json"), JSON.stringify({ source: "inside" }));
    await writeFile(outsideFile, JSON.stringify({ source: "outside" }));
    const registry = new WorkspaceRegistry([
      { id: "data-project", name: "DataProject", path: workspace },
    ]);

    const result = await callTool(registry, "execution_output", {
      workspace_id: "data-project",
      path: "../result.json",
    });
    expect(result.isError).not.toBe(true);
    expect(resultJson(result)).toEqual({ source: "inside" });
    expect(JSON.stringify(resultJson(result))).not.toContain("outside");

    const absoluteResult = await callTool(registry, "execution_output", {
      workspace_id: "data-project",
      path: outsideFile,
    });
    expect(absoluteResult.isError).not.toBe(true);
    expect(resultJson(absoluteResult)).toEqual({ source: "inside" });
  });
});
