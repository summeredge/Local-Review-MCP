import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { searchText } from "../src/workspace/search.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

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
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-search-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function callSearch(workspace: string, arguments_: Record<string, unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "search-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([
    createMcpServer({ registry: WorkspaceRegistry.fromManager(new WorkspaceManager(workspace)) }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client.callTool({ name: "search_text", arguments: arguments_ });
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

describe("search_text", () => {
  it("supports literal, regex, case, path, and glob searches", async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "tests"));
    await writeFile(join(workspace, "src", "a.ts"), "Hello\na.b\nacb\n");
    await writeFile(join(workspace, "tests", "a.ts"), "hello\n");
    await writeFile(join(workspace, "README.md"), "hello\n");

    const literal = resultJson(await callSearch(workspace, { query: "a.b" }));
    expect(literal).toMatchObject({
      query: "a.b",
      path: ".",
      regex: false,
      case_sensitive: false,
      returned: 1,
      has_more: false,
    });
    expect(literal.results).toEqual([
      { path: "src/a.ts", line: 2, column: 1, preview: "a.b" },
    ]);

    const regex = resultJson(await callSearch(workspace, { query: "a.b", regex: true }));
    expect((regex.results as { path: string; line: number }[]).map((item) => [item.path, item.line])).toEqual([
      ["src/a.ts", 2],
      ["src/a.ts", 3],
    ]);

    const sensitive = resultJson(await callSearch(workspace, { query: "Hello", case_sensitive: true }));
    expect((sensitive.results as { path: string; line: number }[]).map((item) => [item.path, item.line])).toEqual([
      ["src/a.ts", 1],
    ]);

    const scoped = resultJson(await callSearch(workspace, { query: "hello", path: "src" }));
    expect((scoped.results as { path: string }[]).map((item) => item.path)).toEqual(["src/a.ts"]);

    const file = resultJson(await callSearch(workspace, { query: "hello", path: "src/a.ts" }));
    expect((file.results as { path: string }[]).map((item) => item.path)).toEqual(["src/a.ts"]);

    const glob = resultJson(await callSearch(workspace, { query: "hello", glob: "**/*.ts" }));
    expect((glob.results as { path: string }[]).map((item) => item.path)).toEqual(["src/a.ts", "tests/a.ts"]);
  });

  it("falls back to Node when ripgrep is unavailable", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "app.ts"), "first\nneedle\n");

    const result = await searchText(new WorkspaceManager(workspace), {
      query: "needle",
      path: ".",
      regex: false,
      caseSensitive: false,
      limit: 100,
    }, { rgPath: join(workspace, "missing-rg") });

    expect(result.engine).toBe("node");
    expect(result.results).toEqual([
      { path: "app.ts", line: 2, column: 1, preview: "needle" },
    ]);
  });

  it("returns controlled errors for invalid regex and invalid input", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "app.ts"), "content\n");

    const invalidRegex = await callSearch(workspace, { query: "[", regex: true });
    expect(invalidRegex.isError).toBe(true);
    expect(resultJson(invalidRegex)).toEqual({ error: "INVALID_REGEX" });

    for (const arguments_ of [
      { query: "" },
      { query: "   " },
      { query: "content", limit: 201 },
      { query: "content", glob: "../*.ts" },
    ]) {
      const result = await callSearch(workspace, arguments_);
      expect(result.isError).toBe(true);
    }
  });
});
