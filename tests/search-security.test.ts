import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import {
  MAX_PREVIEW_CHARS,
  MAX_SEARCH_FILE_BYTES,
  searchText,
} from "../src/workspace/search.js";
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
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-search-security-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function callSearch(workspace: string, arguments_: Record<string, unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "search-security-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([
    createMcpServer({ workspace: new WorkspaceManager(workspace) }).connect(serverTransport),
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

describe("search_text security and bounds", () => {
  it("filters sensitive, ignored, binary, and oversized files", async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, ".aws"));
    await mkdir(join(workspace, "private"));
    await writeFile(join(workspace, ".localreviewignore"), "private/**\n*.secret\n");
    await writeFile(join(workspace, ".env"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, ".git", "config"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, ".aws", "credentials"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, "private", "a.txt"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, "ignored.secret"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, "binary.bin"), Buffer.from("abc\0TOP_SECRET_MATCH", "utf8"));
    await writeFile(join(workspace, ".env.example"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, "public.ts"), "TOP_SECRET_MATCH\n");
    await writeFile(join(workspace, "large.txt"), Buffer.concat([
      Buffer.alloc(MAX_SEARCH_FILE_BYTES, 0x78),
      Buffer.from("TOP_SECRET_MATCH\n", "utf8"),
    ]));

    const result = resultJson(await callSearch(workspace, { query: "TOP_SECRET_MATCH" }));
    expect((result.results as { path: string }[]).map((item) => item.path)).toEqual([
      ".env.example",
      "public.ts",
    ]);
    expect(result.returned).toBe(2);
    const serialized = JSON.stringify(result);
    for (const hidden of [
      ".env\n",
      ".git",
      ".aws",
      "private",
      "ignored.secret",
      "binary.bin",
      "large.txt",
      "TOP_SECRET_MATCH",
    ]) {
      if (hidden === "TOP_SECRET_MATCH") continue;
      expect(serialized).not.toContain(hidden);
    }
  });

  it("bounds result count and preview size", async () => {
    const workspace = await makeWorkspace();
    await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(
      join(workspace, `match-${String(index).padStart(3, "0")}.txt`),
      `MATCH_ME ${index}\n`,
    )));
    await writeFile(join(workspace, "long.txt"), `${"x".repeat(MAX_PREVIEW_CHARS + 100)}MATCH_ME\n`);

    const result = resultJson(await callSearch(workspace, { query: "MATCH_ME", limit: 20 }));
    expect(result.returned).toBe(20);
    expect(result.has_more).toBe(true);
    expect((result.results as { preview: string }[]).every((item) => item.preview.length <= MAX_PREVIEW_CHARS)).toBe(true);
  });

  it("rejects an external ordinary symlink", async ({ skip }) => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(join(outside, "secret.txt"), "SYMLINK_SECRET\n");
    try {
      await symlink(outside, join(workspace, "outside-link"), "dir");
    } catch (error: unknown) {
      if (process.platform === "win32") {
        skip("symlink creation is unavailable");
        return;
      }
      throw error;
    }

    const result = resultJson(await callSearch(workspace, { query: "SYMLINK_SECRET" }));
    expect(result.results).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("outside-link");
    expect(JSON.stringify(result)).not.toContain("secret.txt");
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("rejects a Windows Junction escape", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await writeFile(join(outside, "secret.txt"), "JUNCTION_SECRET\n");
    await symlink(outside, join(workspace, "outside-junction"), "junction");

    const result = resultJson(await callSearch(workspace, { query: "JUNCTION_SECRET" }));
    expect(result.results).toEqual([]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("outside-junction");
    expect(serialized).not.toContain("secret.txt");
    expect(serialized).not.toContain("JUNCTION_SECRET");
    expect(serialized).not.toContain(outside);
  });

  it("keeps the Node fallback on the same security boundary", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, ".env"), "FALLBACK_SECRET\n");
    await writeFile(join(workspace, "public.txt"), "FALLBACK_SECRET\n");

    const result = await searchText(new WorkspaceManager(workspace), {
      query: "FALLBACK_SECRET",
      path: ".",
      regex: false,
      caseSensitive: false,
      limit: 100,
    }, { disableRipgrep: true });

    expect(result.engine).toBe("node");
    expect(result.results.map((item) => item.path)).toEqual(["public.txt"]);
  });
});
