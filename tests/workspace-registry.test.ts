import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
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

async function makeWorkspace(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `local-review-mcp-${name}-`));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "README.md"), content);
  return directory;
}

async function callTool(
  registry: WorkspaceRegistry,
  name: string,
  arguments_: Record<string, unknown> = {},
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "workspace-registry-test", version: "0.1.0" });
  clients.push(client);
  await Promise.all([
    createMcpServer({ registry }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client.callTool({ name, arguments: arguments_ });
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

describe("Workspace Registry", () => {
  it("lists only safe metadata and routes workspace_id to the selected workspace", async () => {
    const dataProject = await makeWorkspace("data", "data-project\n");
    const pcaBuilder = await makeWorkspace("pca", "pca-builder\n");
    const registry = new WorkspaceRegistry([
      { id: "data-project", name: "DataProject", path: dataProject },
      { id: "pca-builder", name: "PCA_Model_Builder", path: pcaBuilder },
    ]);

    const listed = resultJson(await callTool(registry, "workspace_list"));
    expect(listed).toEqual({
      workspaces: [
        { id: "data-project", name: "DataProject" },
        { id: "pca-builder", name: "PCA_Model_Builder" },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain(dataProject);
    expect(JSON.stringify(listed)).not.toContain(pcaBuilder);

    const read = resultJson(await callTool(registry, "read_file", {
      workspace_id: "data-project",
      path: "README.md",
    }));
    expect(read).toMatchObject({ path: "README.md", content: "data-project" });

    const legacyRead = resultJson(await callTool(registry, "read_file", { path: "README.md" }));
    expect(legacyRead).toMatchObject({ path: "README.md", content: "data-project" });

    const info = resultJson(await callTool(registry, "workspace_info", {
      workspace_id: "pca-builder",
    }));
    expect(info).toMatchObject({
      workspace_id: "pca-builder",
      workspace_name: "PCA_Model_Builder",
    });
  });

  it("rejects unknown ids and absolute paths", async () => {
    const workspace = await makeWorkspace("security", "safe\n");
    const outside = join(tmpdir(), "not-authorized.txt");
    const registry = new WorkspaceRegistry([
      { id: "data-project", name: "DataProject", path: workspace },
    ]);

    const unknown = await callTool(registry, "read_file", {
      workspace_id: "unknown",
      path: "README.md",
    });
    expect(unknown.isError).toBe(true);
    expect(resultJson(unknown)).toEqual({
      error: "UNKNOWN_WORKSPACE_ID",
      message: "Unknown workspace_id",
    });

    const pathAsId = await callTool(registry, "read_file", {
      workspace_id: outside,
      path: "README.md",
    });
    expect(pathAsId.isError).toBe(true);
    expect(resultJson(pathAsId).error).toBe("UNKNOWN_WORKSPACE_ID");

    const absolute = await callTool(registry, "read_file", {
      workspace_id: "data-project",
      path: outside,
    });
    expect(absolute.isError).toBe(true);
    expect(resultJson(absolute)).toEqual({ error: "INVALID_PATH" });
  });

  it("uses the configured id across reloads and allows a new id after re-add", async () => {
    const originalPath = await makeWorkspace("identity-original", "original\n");
    const movedPath = await makeWorkspace("identity-moved", "moved\n");
    const originalEntry = { id: "stable-workspace", name: "Review", path: originalPath };

    const first = new WorkspaceRegistry([originalEntry]);
    const reloaded = new WorkspaceRegistry([{ ...originalEntry, path: movedPath }]);
    expect(first.resolve("stable-workspace").id).toBe("stable-workspace");
    expect(reloaded.resolve("stable-workspace").id).toBe("stable-workspace");

    const readded = new WorkspaceRegistry([{
      id: "new-workspace",
      name: "Review",
      path: movedPath,
    }]);
    expect(() => readded.resolve("stable-workspace")).toThrow();
    expect(readded.resolve("new-workspace").id).toBe("new-workspace");
  });

  it("uses the registry identity instead of deriving an id from the path", async () => {
    const workspace = await makeWorkspace("explicit-identity", "identity\n");
    const registry = new WorkspaceRegistry([{
      id: "launcher-id",
      name: "Launcher Workspace",
      path: workspace,
    }]);

    expect(registry.active.manager.workspaceId).toBe("launcher-id");
    expect(registry.active.manager.identity).toEqual({
      id: "launcher-id",
      name: "Launcher Workspace",
      path: workspace,
    });
    expect(() => new WorkspaceRegistry([{
      id: "launcher-id",
      name: "Launcher Workspace",
      path: workspace,
    }], {
      activeWorkspaceIdentity: {
        id: "launcher-id",
        name: "Other Workspace",
        path: workspace,
      },
    })).toThrow("active workspace identity");
  });
});
