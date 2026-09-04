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
  it("exposes the six V0.1 tools and the workspace registry tool", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-registry-"));
    temporaryDirectories.push(workspace);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ workspace: new WorkspaceManager(workspace) });
    const client = new Client({ name: "registry-test", version: "0.1.0" });
    clients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();

    expect(names).toHaveLength(7);
    expect(names).toEqual([...EXPECTED_REGISTERED_TOOL_NAMES].sort());
  });
});
