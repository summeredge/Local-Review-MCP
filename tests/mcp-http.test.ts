import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../src/app.js";
import { V01_TOOL_NAMES } from "../src/mcp/server.js";

const runningServers: import("node:http").Server[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:http");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", () => resolve()));
  const address = socket.address();
  if (address === null || typeof address === "string") throw new Error("test socket has no port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

describe("MCP HTTP runtime", () => {
  it("initializes, lists tools, and returns a controlled placeholder response", async () => {
    const settings = { host: "127.0.0.1" as const, port: await getFreePort() };
    const server = await startApp(settings);
    runningServers.push(server);
    const client = new Client({ name: "http-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://${settings.host}:${settings.port}/mcp`));

    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([...V01_TOOL_NAMES].sort());

    const call = await client.callTool({ name: "workspace_info", arguments: {} });
    expect(call.isError).not.toBe(true);
    expect(call.content).toEqual([
      { type: "text", text: JSON.stringify({ status: "not_implemented", tool: "workspace_info" }) },
    ]);

    await client.close();
  });
});
