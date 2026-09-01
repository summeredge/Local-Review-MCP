import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../src/app.js";
import { EXPECTED_V01_TOOL_NAMES } from "./fixtures/v01-tools.js";

const runningServers: import("node:http").Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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

function toolText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || typeof content[0] !== "object" || content[0] === null
    || typeof (content[0] as { text?: unknown }).text !== "string") {
    throw new Error("tool did not return text content");
  }
  return (content[0] as { text: string }).text;
}

describe("MCP HTTP runtime", () => {
  it("initializes, lists tools, and serves all workspace tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-http-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "README.md"), "# Review\n");
    await writeFile(join(workspace, "src", "app.ts"), "export const app = true;\n");

    const settings = {
      host: "127.0.0.1" as const,
      port: await getFreePort(),
      workspace,
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
    };
    const server = await startApp(settings);
    runningServers.push(server);
    const client = new Client({ name: "http-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${settings.host}:${settings.port}/mcp`),
      { requestInit: { headers: { authorization: "Bearer test-token" } } },
    );

    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools).toHaveLength(6);
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_V01_TOOL_NAMES].sort());

    const infoCall = await client.callTool({ name: "workspace_info", arguments: {} });
    expect(infoCall.isError).not.toBe(true);
    const info = JSON.parse(toolText(infoCall)) as Record<string, unknown>;
    expect(info).toMatchObject({ root_alias: "workspace:/", workspace_name: basename(workspace) });
    expect(JSON.stringify(info)).not.toContain(workspace);

    const listCall = await client.callTool({ name: "list_files", arguments: {} });
    expect(listCall.isError).not.toBe(true);
    const listing = JSON.parse(toolText(listCall)) as {
      entries: { path: string; type: string }[];
    };
    expect(listing.entries).toEqual([
      { path: "README.md", name: "README.md", type: "file" },
      { path: "src", name: "src", type: "directory" },
    ]);

    const readCall = await client.callTool({ name: "read_file", arguments: { path: "src/app.ts" } });
    expect(readCall.isError).not.toBe(true);
    expect(JSON.parse(toolText(readCall))).toMatchObject({
      path: "src/app.ts",
      content: "export const app = true;",
    });

    const searchCall = await client.callTool({ name: "search_text", arguments: { query: "app" } });
    expect(searchCall.isError).not.toBe(true);
    expect(JSON.parse(toolText(searchCall))).toMatchObject({
      query: "app",
      returned: 1,
      results: [{ path: "src/app.ts", line: 1 }],
    });

    for (const name of ["git_status", "git_diff"]) {
      const gitCall = await client.callTool({ name, arguments: {} });
      expect(gitCall.isError).toBe(true);
      expect(JSON.parse(toolText(gitCall))).toEqual({ error: "NOT_A_REPOSITORY" });
    }

    await client.close();
  });
});
