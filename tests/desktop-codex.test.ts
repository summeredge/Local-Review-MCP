import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CallToolRequestParams, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppRuntime,
  type CodexAppMcpTransport,
  type CodexAppMcpClient,
} from "../src/desktop-codex/codex-app-runtime.js";
import { createCodexAppToolContracts } from "../src/desktop-codex/codex-app-contracts.js";
import {
  resolveDesktopProject,
  type DesktopProjectRecord,
} from "../src/desktop-codex/desktop-project-resolver.js";
import { DesktopCodexThreadCommands } from "../src/desktop-codex/thread-commands.js";

const EXECUTOR_THREAD = "executor-thread";
const TARGET_THREAD = "target-thread";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function appTools(): Tool[] {
  return [
    {
      name: "list_projects",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "create_thread",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          target: {
            anyOf: [{
              type: "object",
              properties: {
                type: { type: "string", enum: ["project"] },
                projectId: { type: "string" },
                environment: {
                  anyOf: [{
                    type: "object",
                    properties: { type: { type: "string", enum: ["local"] } },
                    required: ["type"],
                  }],
                },
              },
              required: ["type", "projectId", "environment"],
            }],
          },
        },
        required: ["prompt", "target"],
      },
    },
    {
      name: "send_message_to_thread",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          hostId: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["threadId", "prompt"],
      },
    },
  ];
}

function toolResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function projectResult(projects: readonly DesktopProjectRecord[]): CallToolResult {
  return toolResult({ projects });
}

function project(
  projectId: string,
  path: string,
  projectKind = "local",
  hostId = "local",
): DesktopProjectRecord {
  return { projectId, path, projectKind, hostId };
}

describe("desktop-codex command primitives", () => {
  it("keeps executor metadata separate from the created target thread", async () => {
    const workspacePath = resolve("C:/workspace/Local-Review-MCP");
    const calls: CallToolRequestParams[] = [];
    const callTool: CodexAppMcpClient["callTool"] = async (params) => {
      calls.push(params);
      if (params.name === "list_projects") {
        return projectResult([project("project-one", workspacePath.toUpperCase().replaceAll("\\", "/"))]);
      }
      if (params.name === "create_thread") return toolResult({ threadId: TARGET_THREAD, hostId: "local" });
      return { content: [] };
    };
    const client: Pick<CodexAppMcpClient, "callTool"> = { callTool };
    const commands = new DesktopCodexThreadCommands({
      client,
      contracts: createCodexAppToolContracts(appTools()),
    });

    const projects = await commands.listProjects({ executorThreadId: EXECUTOR_THREAD });
    const selected = resolveDesktopProject(projects, workspacePath);
    const identity = await commands.createThread({
      executorThreadId: EXECUTOR_THREAD,
      projectId: selected.projectId,
      prompt: "create",
    });
    await commands.sendMessageToThread({
      executorThreadId: EXECUTOR_THREAD,
      targetThreadId: identity.targetThreadId,
      hostId: identity.hostId,
      prompt: "send",
    });

    expect(identity).toEqual({ targetThreadId: TARGET_THREAD, hostId: "local" });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call._meta?.["openai/threadId"] === EXECUTOR_THREAD)).toBe(true);
    expect(calls[1]).toMatchObject({
      name: "create_thread",
      arguments: {
        target: { type: "project", projectId: "project-one", environment: { type: "local" } },
      },
    });
    expect(calls[2]).toMatchObject({
      name: "send_message_to_thread",
      arguments: { threadId: TARGET_THREAD, hostId: "local", prompt: "send" },
    });
    expect(calls[2]!.arguments).not.toHaveProperty("executorThreadId");
  });

  it("rejects executor and target identity reuse", async () => {
    const calls: CallToolRequestParams[] = [];
    const callTool: CodexAppMcpClient["callTool"] = async (params) => {
      calls.push(params);
      return { content: [] };
    };
    const commands = new DesktopCodexThreadCommands({
      client: { callTool },
      contracts: createCodexAppToolContracts(appTools()),
    });

    await expect(commands.sendMessageToThread({
      executorThreadId: EXECUTOR_THREAD,
      targetThreadId: EXECUTOR_THREAD,
      hostId: "local",
      prompt: "send",
    })).rejects.toMatchObject({ code: "thread_identity_conflict" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a create_thread result that targets the executor", async () => {
    const calls: CallToolRequestParams[] = [];
    const callTool: CodexAppMcpClient["callTool"] = async (params) => {
      calls.push(params);
      return toolResult({ threadId: EXECUTOR_THREAD, hostId: "local" });
    };
    const commands = new DesktopCodexThreadCommands({
      client: { callTool },
      contracts: createCodexAppToolContracts(appTools()),
    });

    await expect(commands.createThread({
      executorThreadId: EXECUTOR_THREAD,
      projectId: "project-one",
      prompt: "create",
    })).rejects.toMatchObject({ code: "thread_identity_conflict" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("create_thread");
  });
});

describe("desktop-codex runtime", () => {
  it("lists tools and closes the client and transport only once", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-codex-runtime-"));
    temporaryRoots.push(root);
    const serverPath = join(root, "server.mjs");
    writeFileSync(serverPath, "", "utf8");
    let clientCloseCount = 0;
    let transportCloseCount = 0;
    const client: CodexAppMcpClient = {
      connect: async () => undefined,
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => { clientCloseCount += 1; },
    };
    const transport: CodexAppMcpTransport = {
      start: async () => undefined,
      send: async () => undefined,
      close: async () => { transportCloseCount += 1; },
    };
    const runtime = await CodexAppRuntime.connect({
      serverPath,
      createClient: () => client,
      createTransport: () => transport,
    });

    await expect(runtime.listTools()).resolves.toEqual({ tools: [] });
    await runtime.close();
    await runtime.close();
    expect(clientCloseCount).toBe(1);
    expect(transportCloseCount).toBe(1);
  });

  it("cleans up both sides when connect fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-codex-runtime-failure-"));
    temporaryRoots.push(root);
    const serverPath = join(root, "server.mjs");
    writeFileSync(serverPath, "", "utf8");
    let clientCloseCount = 0;
    let transportCloseCount = 0;
    const client: CodexAppMcpClient = {
      connect: async () => { throw new Error("connect failed"); },
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => { clientCloseCount += 1; },
    };
    const transport: CodexAppMcpTransport = {
      start: async () => undefined,
      send: async () => undefined,
      close: async () => { transportCloseCount += 1; },
    };

    await expect(CodexAppRuntime.connect({
      serverPath,
      createClient: () => client,
      createTransport: () => transport,
    })).rejects.toMatchObject({
      code: "transport_failed",
    });
    expect(clientCloseCount).toBe(1);
    expect(transportCloseCount).toBe(1);
  });
});

describe("desktop project resolver", () => {
  const workspacePath = resolve("C:/workspace/Local-Review-MCP");

  it("matches an exact local path after case and separator normalization", () => {
    const result = projectResult([project(
      "project-one",
      workspacePath.toUpperCase().replaceAll("\\", "/"),
    )]);
    expect(resolveDesktopProject(result, workspacePath)).toEqual({
      projectId: "project-one",
      hostId: "local",
      path: resolve(workspacePath.toUpperCase().replaceAll("\\", "/")),
    });
  });

  it.each([
    ["not_found", [project("project-one", resolve("C:/other"))]],
    ["remote_kind", [project("project-one", workspacePath, "remote")]],
    ["wrong_host", [project("project-one", workspacePath, "local", "remote-host")]],
  ] as const)("fails closed for %s", (_label, projects) => {
    expect(() => resolveDesktopProject(projectResult(projects), workspacePath))
      .toThrowError(expect.objectContaining({ code: "project_not_found" }));
  });

  it("rejects ambiguous exact local matches", () => {
    expect(() => resolveDesktopProject(projectResult([
      project("project-one", workspacePath),
      project("project-two", workspacePath),
    ]), workspacePath)).toThrowError(expect.objectContaining({ code: "project_ambiguous" }));
  });

  it("ignores ChatGPT project records without local path fields", () => {
    expect(resolveDesktopProject(projectResult([
      project("project-one", workspacePath),
      { projectId: "g-p-project", projectKind: "chatgpt" } as unknown as DesktopProjectRecord,
    ]), workspacePath)).toMatchObject({
      projectId: "project-one",
      hostId: "local",
    });
  });

  it("rejects malformed project records", () => {
    expect(() => resolveDesktopProject(projectResult([
      { projectId: "project-one", path: "relative", projectKind: "local", hostId: "local" },
    ]), workspacePath)).toThrowError(expect.objectContaining({ code: "invalid_project_result" }));
  });
});

describe("desktop codex contracts", () => {
  it("fails closed when the required command contract is missing", () => {
    const contracts = createCodexAppToolContracts(appTools().filter((tool) => tool.name !== "create_thread"));
    expect(() => contracts.createThreadArguments("create", "project-one"))
      .toThrowError(expect.objectContaining({ code: "tool_contract_incompatible" }));
  });
});
