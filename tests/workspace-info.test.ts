import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
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
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-info-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function callWorkspaceInfo(workspace: string, arguments_: Record<string, unknown> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "workspace-info-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([
    createMcpServer({ registry: WorkspaceRegistry.fromManager(new WorkspaceManager(workspace)) }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client.callTool({ name: "workspace_info", arguments: arguments_ });
}

function toolText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || typeof content[0] !== "object" || content[0] === null
    || typeof (content[0] as { text?: unknown }).text !== "string") {
    throw new Error("tool did not return text content");
  }
  return (content[0] as { text: string }).text;
}

describe("workspace_info", () => {
  it("returns stable safe metadata and detects lightweight project types", async () => {
    const workspace = await makeWorkspace();
    await Promise.all([
      writeFile(join(workspace, "package.json"), "{}"),
      writeFile(join(workspace, "tsconfig.json"), "{}"),
      writeFile(join(workspace, "pyproject.toml"), ""),
      writeFile(join(workspace, "requirements.txt"), ""),
      writeFile(join(workspace, "Cargo.toml"), ""),
      writeFile(join(workspace, "go.mod"), "module example"),
      writeFile(join(workspace, "Example.csproj"), ""),
    ]);

    const result = await callWorkspaceInfo(workspace);
    expect(result.isError).not.toBe(true);
    const info = JSON.parse(toolText(result)) as Record<string, unknown>;
    expect(result.structuredContent).toEqual(info);

    expect(info.workspace_id).toBe("legacy-workspace");
    expect(info.workspace_name).toBe(basename(workspace));
    expect(info.root_alias).toBe("workspace:/");
    expect(info.project_types).toEqual(["dotnet", "go", "node", "python", "rust", "typescript"]);

    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain(process.cwd());
    expect(serialized).not.toContain(process.env.USERPROFILE ?? "__missing_userprofile__");
  });

  it("keeps the active workspace fixed when remote arguments try to replace it", async () => {
    const workspace = await makeWorkspace();
    const result = await callWorkspaceInfo(workspace, { workspace: "C:\\outside" });
    const info = JSON.parse(toolText(result)) as { workspace_name: string };

    expect(info.workspace_name).toBe(basename(workspace));
  });
});
