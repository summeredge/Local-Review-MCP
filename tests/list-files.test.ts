import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { WorkspaceManager } from "../src/workspace/manager.js";

const clients: Client[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-list-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function callListFiles(workspace: string, arguments_: Record<string, unknown> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "list-files-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([
    createMcpServer({ workspace: new WorkspaceManager(workspace) }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client.callTool({ name: "list_files", arguments: arguments_ });
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
  return JSON.parse(toolText(result)) as Record<string, unknown>;
}

describe("list_files", () => {
  it("supports depth, pagination, and deterministic path sorting", async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, "src", "nested"), { recursive: true });
    await mkdir(join(workspace, "docs"));
    await Promise.all([
      writeFile(join(workspace, "README.md"), ""),
      writeFile(join(workspace, "src", "app.ts"), ""),
      writeFile(join(workspace, "src", "nested", "a.ts"), ""),
      writeFile(join(workspace, "docs", "x.md"), ""),
    ]);

    const depthOne = resultJson(await callListFiles(workspace));
    expect(depthOne).toMatchObject({ path: ".", offset: 0, returned: 3, has_more: false });
    expect(depthOne.entries).toEqual([
      { path: "README.md", name: "README.md", type: "file" },
      { path: "docs", name: "docs", type: "directory" },
      { path: "src", name: "src", type: "directory" },
    ]);

    const depthTwo = resultJson(await callListFiles(workspace, { depth: 2 }));
    expect((depthTwo.entries as unknown[]).map((entry) => (entry as { path: string }).path)).toEqual([
      "README.md",
      "docs",
      "docs/x.md",
      "src",
      "src/app.ts",
      "src/nested",
    ]);

    const normalizedPath = resultJson(await callListFiles(workspace, {
      path: "workspace:/src\\",
      depth: 1,
    }));
    expect(normalizedPath).toMatchObject({ path: "src", returned: 2, has_more: false });
    expect(normalizedPath.entries).toEqual([
      { path: "src/app.ts", name: "app.ts", type: "file" },
      { path: "src/nested", name: "nested", type: "directory" },
    ]);

    const page = resultJson(await callListFiles(workspace, { depth: 2, offset: 1, limit: 2 }));
    expect(page.entries).toEqual([
      { path: "docs", name: "docs", type: "directory" },
      { path: "docs/x.md", name: "x.md", type: "file" },
    ]);
    expect(page).toMatchObject({ offset: 1, returned: 2, has_more: true });
  });

  it("hides sensitive entries and custom ignored entries without metadata leaks", async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, ".ssh"));
    await mkdir(join(workspace, "private"));
    await writeFile(join(workspace, ".localreviewignore"), "private/**\n*.secret\n");
    await Promise.all([
      writeFile(join(workspace, ".env"), "secret"),
      writeFile(join(workspace, ".git", "config"), "secret"),
      writeFile(join(workspace, ".ssh", "id_rsa"), "secret"),
      writeFile(join(workspace, "private", "a.txt"), "secret"),
      writeFile(join(workspace, "foo.secret"), "secret"),
      writeFile(join(workspace, "public.txt"), "public"),
    ]);

    const result = resultJson(await callListFiles(workspace, { depth: 3 }));
    expect((result.entries as unknown[]).map((entry) => (entry as { path: string }).path)).toEqual(["public.txt"]);
    const serialized = JSON.stringify(result);
    for (const hidden of [".env", ".git", ".ssh", ".localreviewignore", "private", "foo.secret"]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it("returns controlled errors for invalid input and non-directories", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "README.md"), "");

    const invalid = await callListFiles(workspace, { depth: 0 });
    expect(invalid.isError).toBe(true);
    expect((invalid as unknown as { content: unknown[] }).content[0]).toMatchObject({
      type: "text",
    });

    const file = resultJson(await callListFiles(workspace, { path: "README.md" }));
    expect(file.error).toBe("PATH_NOT_DIRECTORY");
  });

  it("does not expose a symlink that resolves outside the workspace", async ({ skip }) => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(join(outside, "outside-secret.txt"), "secret");
    try {
      await symlink(outside, join(workspace, "outside-link"), "junction");
    } catch (error: unknown) {
      if (process.platform === "win32") {
        skip("symlink creation is unavailable");
        return;
      }
      throw error;
    }

    const result = resultJson(await callListFiles(workspace, { depth: 3 }));
    expect(JSON.stringify(result)).not.toContain("outside-link");
    expect(JSON.stringify(result)).not.toContain("outside-secret");
  });
});
