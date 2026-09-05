import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer, MAX_READ_SCAN_BYTES } from "../src/mcp/server.js";
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
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-read-limit-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function callReadFile(workspace: string, arguments_: Record<string, unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "read-file-limit-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([
    createMcpServer({ registry: WorkspaceRegistry.fromManager(new WorkspaceManager(workspace)) }).connect(serverTransport),
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

describe("read_file scan resource limit", () => {
  it("returns READ_SCAN_LIMIT_EXCEEDED instead of scanning without a bound", async () => {
    const workspace = await makeWorkspace();
    const line = "x".repeat(1024);
    const lineCount = Math.floor(MAX_READ_SCAN_BYTES / (line.length + 1)) + 2;
    await writeFile(join(workspace, "large.txt"), Array(lineCount).fill(line).join("\n"));

    const result = await callReadFile(workspace, {
      path: "large.txt",
      start_line: Number.MAX_SAFE_INTEGER,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(toolText(result))).toMatchObject({ error: "READ_SCAN_LIMIT_EXCEEDED" });
  });
});
