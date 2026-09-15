import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer, WORKSPACE_REVIEW_TOOL_NAMES } from "../../src/mcp/server.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const run = promisify(execFile);
const clients: Client[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function git(workspace: string, ...args: string[]): Promise<void> {
  await run("git", args, {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
}

async function setup(): Promise<{ client: Client; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "local-review-data-plane-tools-"));
  temporaryDirectories.push(workspace);
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "status-query.ts"), "// header\nexport class StatusQueryService {}\n");
  await writeFile(join(workspace, "src", "staged.ts"), "before staged\n");
  await git(workspace, "init", "-b", "main");
  await git(workspace, "config", "user.email", "test@example.invalid");
  await git(workspace, "config", "user.name", "Local Review Test");
  await git(workspace, "add", ".");
  await git(workspace, "commit", "-m", "initial");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "workspace-tools-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([
    createMcpServer({
      registry: WorkspaceRegistry.fromManager(new WorkspaceManager(workspace)),
    }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, workspace };
}

function json(result: unknown): Record<string, unknown> {
  const content = (result as { content: { text: string }[] }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("workspace review MCP tools", () => {
  it("discovers the five read-only data-plane tools", async () => {
    const { client } = await setup();
    const tools = await client.listTools();
    for (const name of WORKSPACE_REVIEW_TOOL_NAMES) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("lists files and returns a search match with the correct line", async () => {
    const { client } = await setup();
    const listed = json(await client.callTool({
      name: "workspace_list_files",
      arguments: { workspace_id: "legacy-workspace", path: "src" },
    }));
    expect(listed.files).toEqual(["src/staged.ts", "src/status-query.ts"]);

    const searched = json(await client.callTool({
      name: "workspace_search",
      arguments: {
        workspace_id: "legacy-workspace",
        query: "StatusQueryService",
        path: "src",
      },
    }));
    expect(searched.results).toEqual([{
      path: "src/status-query.ts",
      line: 2,
      text: "export class StatusQueryService {}",
    }]);
  });

  it("returns workspace info, Git diffs, changed files, and review candidates", async () => {
    const { client, workspace } = await setup();
    await writeFile(join(workspace, "src", "status-query.ts"), "// header\nexport class StatusQueryService { readonly dirty = true; }\n");
    await writeFile(join(workspace, "src", "staged.ts"), "after staged\n");
    await git(workspace, "add", "src/staged.ts");
    await writeFile(join(workspace, "src", "untracked.ts"), "untracked\n");

    const info = json(await client.callTool({
      name: "workspace_get_info",
      arguments: { workspace_id: "legacy-workspace" },
    }));
    expect(info).toMatchObject({
      workspace_id: "legacy-workspace",
      root: "workspace:/",
      branch: "main",
      status: "dirty",
    });

    const context = json(await client.callTool({
      name: "workspace_review_context",
      arguments: { workspace_id: "legacy-workspace" },
    }));
    expect(context.changed_files).toEqual([
      "src/staged.ts",
      "src/status-query.ts",
      "src/untracked.ts",
    ]);
    expect(context).toMatchObject({
      git_status: { branch: "main", status: "dirty" },
      diff_summary: { files_changed: 3, insertions: 2, deletions: 2 },
    });
    expect((context.diff as { staged: string }).staged).toContain("+after staged");
    expect((context.diff as { unstaged: string }).unstaged).toContain("+export class StatusQueryService");
    expect((context.review_candidates as { path: string }[]).map(({ path }) => path)).toEqual([
      "src/staged.ts",
      "src/status-query.ts",
      "src/untracked.ts",
    ]);
  });

  it("requires a registered workspace_id", async () => {
    const { client } = await setup();
    const missing = await client.callTool({ name: "workspace_search", arguments: { query: "x" } });
    expect(missing.isError).toBe(true);
    const unknown = await client.callTool({
      name: "workspace_search",
      arguments: { workspace_id: "unknown", query: "x" },
    });
    expect(unknown.isError).toBe(true);
    expect(json(unknown)).toEqual({ error: "UNKNOWN_WORKSPACE_ID", message: "Unknown workspace_id" });
  });
});
