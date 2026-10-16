import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer, MAX_READ_SCAN_BYTES } from "../../src/mcp/server.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const clients: Client[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeClient(): Promise<{ client: Client; workspace: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "local-review-data-plane-reader-"));
  temporaryDirectories.push(workspace);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "workspace-reader-test", version: "0.1.0" });
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

describe("workspace review reader", () => {
  it("reads the first three lines of a file above the snapshot limit without a hash", async () => {
    const { client, workspace } = await makeClient();
    await writeFile(join(workspace, "large.txt"), "one\ntwo\nthree\n" + "x\n".repeat(MAX_READ_SCAN_BYTES / 2));
    const result = await client.callTool({ name: "workspace_read_file", arguments: {
      workspace_id: "legacy-workspace", path: "large.txt", end_line: 3,
    } });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({ content: "one\ntwo\nthree", end_line: 3, truncated: true, next_start_line: 4 });
    expect(json(result)).not.toHaveProperty("sha256");
  });

  it("keeps the return-byte, line-count and scan limits for streamed large files", async () => {
    const { client, workspace } = await makeClient();
    await writeFile(join(workspace, "large.txt"), ("x".repeat(1024) + "\n").repeat(8193));
    const call = (extra: Record<string, number>) => client.callTool({ name: "workspace_read_file", arguments: {
      workspace_id: "legacy-workspace", path: "large.txt", ...extra,
    } });
    const page = await call({ end_line: 1000 });
    expect(page.isError).not.toBe(true);
    expect(Buffer.byteLength(json(page).content as string)).toBe(256 * 1024);
    expect(json(page)).toMatchObject({ truncated: true });
    expect(json(page)).not.toHaveProperty("sha256");
    expect(json(await call({ end_line: 1001 }))).toEqual({ error: "INVALID_PATH" });
    const beyondScan = await call({ start_line: 8193, end_line: 8193 });
    expect(beyondScan.isError).toBe(true);
    expect(json(beyondScan)).toEqual({ error: "READ_SCAN_LIMIT_EXCEEDED" });
  });

  it("reads pages with a 200-line default and a 1000-line hard limit", async () => {
    const { client, workspace } = await makeClient();
    await writeFile(join(workspace, "large.txt"), Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join("\n"));

    const first = json(await client.callTool({
      name: "workspace_read_file",
      arguments: { workspace_id: "legacy-workspace", path: "large.txt" },
    }));
    expect(first).toMatchObject({
      path: "large.txt",
      start_line: 1,
      end_line: 200,
      truncated: true,
      next_start_line: 201,
    });

    const second = json(await client.callTool({
      name: "workspace_read_file",
      arguments: {
        workspace_id: "legacy-workspace",
        path: "large.txt",
        start_line: 201,
        end_line: 220,
      },
    }));
    expect(second).toMatchObject({ start_line: 201, end_line: 220, truncated: true });

    const oversized = await client.callTool({
      name: "workspace_read_file",
      arguments: {
        workspace_id: "legacy-workspace",
        path: "large.txt",
        start_line: 1,
        end_line: 1001,
      },
    });
    expect(oversized.isError).toBe(true);
    expect(json(oversized)).toEqual({ error: "INVALID_PATH" });
  });

  it("rejects traversal and absolute paths", async () => {
    const { client, workspace } = await makeClient();
    await writeFile(join(workspace, "safe.txt"), "safe\n");

    for (const path of ["../../test", "../package.json", "C:\\Windows\\system32"]) {
      const result = await client.callTool({
        name: "workspace_read_file",
        arguments: { workspace_id: "legacy-workspace", path },
      });
      expect(result.isError).toBe(true);
      expect(["INVALID_PATH", "PATH_OUTSIDE_WORKSPACE"]).toContain(json(result).error);
    }
  });
});
