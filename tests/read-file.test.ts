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
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-read-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function callReadFile(workspace: string, arguments_: Record<string, unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "read-file-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([
    createMcpServer({ workspace: new WorkspaceManager(workspace) }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client.callTool({ name: "read_file", arguments: arguments_ });
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

describe("read_file", () => {
  it("reads LF, CRLF, UTF-8, and BOM text with correct line paging", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "mixed.txt"), "\uFEFF第一行\r\nsecond\n第三行");

    const first = resultJson(await callReadFile(workspace, { path: "mixed.txt" }));
    expect(first).toMatchObject({
      path: "mixed.txt",
      start_line: 1,
      end_line: 3,
      has_more: false,
      content: "第一行\nsecond\n第三行",
    });

    const lines = Array.from({ length: 1000 }, (_, index) => `line${index + 1}`).join("\n");
    await writeFile(join(workspace, "lines.txt"), lines);
    const page = resultJson(await callReadFile(workspace, {
      path: "lines.txt",
      start_line: 101,
      max_lines: 10,
    }));
    expect(page).toMatchObject({
      start_line: 101,
      end_line: 110,
      has_more: true,
      content: Array.from({ length: 10 }, (_, index) => `line${index + 101}`).join("\n"),
    });

    const eof = resultJson(await callReadFile(workspace, { path: "lines.txt", start_line: 1001 }));
    expect(eof).toMatchObject({ start_line: 1001, end_line: 1000, has_more: false, content: "" });
  });

  it("enforces line and UTF-8 byte limits", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "text.txt"), "中文\nnext");

    const bytes = resultJson(await callReadFile(workspace, {
      path: "text.txt",
      max_bytes: 4,
    }));
    expect(bytes.content).toBe("中");
    expect(bytes.has_more).toBe(true);
    expect(bytes.truncated).toBe(true);
    expect(Buffer.byteLength(bytes.content as string, "utf8")).toBeLessThanOrEqual(4);

    for (const arguments_ of [
      { path: "text.txt", start_line: 0 },
      { path: "text.txt", max_lines: 0 },
      { path: "text.txt", max_lines: 2001 },
      { path: "text.txt", max_bytes: 1024 * 1024 + 1 },
    ]) {
      const result = await callReadFile(workspace, arguments_);
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain("validation");
    }
  });

  it("rejects binary, sensitive, and escaping paths with stable errors", async ({ skip }) => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, ".env"), "secret");
    await writeFile(join(workspace, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(outside, "secret.txt"), "outside");

    const binary = resultJson(await callReadFile(workspace, { path: "binary.bin" }));
    expect(binary.error).toBe("BINARY_FILE");

    for (const path of [".env", ".git/config", "private.key", ".aws/credentials", ".localreviewignore"]) {
      expect(resultJson(await callReadFile(workspace, { path }))).toMatchObject({ error: "SENSITIVE_PATH" });
    }

    try {
      await symlink(join(workspace, ".env"), join(workspace, "safe-name"), "file");
      await symlink(join(outside, "secret.txt"), join(workspace, "outside-link"), "file");
    } catch (error: unknown) {
      if (process.platform === "win32") {
        skip("symlink creation is unavailable");
        return;
      }
      throw error;
    }
    expect(resultJson(await callReadFile(workspace, { path: "safe-name" }))).toMatchObject({ error: "SENSITIVE_PATH" });
    expect(resultJson(await callReadFile(workspace, { path: "outside-link" }))).toMatchObject({
      error: "PATH_OUTSIDE_WORKSPACE",
    });
  });

  it("returns a controlled error for directories", async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, "src"));
    expect(resultJson(await callReadFile(workspace, { path: "src" }))).toMatchObject({
      error: "PATH_NOT_DIRECTORY",
    });
  });
});
