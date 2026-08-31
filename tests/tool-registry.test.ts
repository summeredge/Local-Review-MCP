import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { EXPECTED_V01_TOOL_NAMES } from "./fixtures/v01-tools.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("MCP tool registry", () => {
  it("exposes exactly the six V0.1 tools through tools/list", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "registry-test", version: "0.1.0" });
    clients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();

    expect(names).toHaveLength(6);
    expect(names).toEqual([...EXPECTED_V01_TOOL_NAMES].sort());
  });
});
