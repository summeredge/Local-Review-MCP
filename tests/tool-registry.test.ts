import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { EXPECTED_REGISTERED_TOOL_NAMES } from "./fixtures/v01-tools.js";

const clients: Client[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MCP tool registry", () => {
  it("exposes all registered read-only tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-registry-"));
    temporaryDirectories.push(workspace);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ workspace: new WorkspaceManager(workspace) });
    const client = new Client({ name: "registry-test", version: "0.1.0" });
    clients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();

    expect(names).toHaveLength(9);
    expect(names).toEqual([...EXPECTED_REGISTERED_TOOL_NAMES].sort());
    expect(result.tools.find((tool) => tool.name === "workspace_info")?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        workspace_id: expect.any(Object),
        workspace_name: expect.any(Object),
        root_alias: expect.any(Object),
        project_types: expect.any(Object),
      },
    });
    expect(result.tools.find((tool) => tool.name === "list_files")?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        path: expect.any(Object),
        entries: expect.any(Object),
        offset: expect.any(Object),
        returned: expect.any(Object),
        has_more: expect.any(Object),
      },
    });
    expect(result.tools.find((tool) => tool.name === "read_file")?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        path: expect.any(Object),
        start_line: expect.any(Object),
        end_line: expect.any(Object),
        has_more: expect.any(Object),
        content: expect.any(Object),
        truncated: expect.any(Object),
      },
    });
    expect(result.tools.find((tool) => tool.name === "search_text")?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        query: expect.any(Object),
        path: expect.any(Object),
        regex: expect.any(Object),
        case_sensitive: expect.any(Object),
        results: expect.any(Object),
        returned: expect.any(Object),
        has_more: expect.any(Object),
        engine: expect.any(Object),
      },
    });
    expect(result.tools.find((tool) => tool.name === "git_status")?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        branch: expect.any(Object),
        entries: expect.any(Object),
      },
    });
    expect(result.tools.find((tool) => tool.name === "git_diff")?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        path: expect.any(Object),
        stat: expect.any(Object),
        diff: expect.any(Object),
        files: expect.any(Object),
        binary: expect.any(Object),
      },
    });
    expect(result.tools.find((tool) => tool.name === "review_summary")?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        workspace_id: expect.any(Object),
        workspace_name: expect.any(Object),
        git_branch: expect.any(Object),
        git_status_summary: expect.any(Object),
        diff_summary: expect.any(Object),
      },
    });
    expect(result.tools.find((tool) => tool.name === "execution_output")?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        available: expect.any(Object),
        timestamp: expect.any(Object),
        command: expect.any(Object),
        status: expect.any(Object),
        summary: expect.any(Object),
      },
    });
  });
});
