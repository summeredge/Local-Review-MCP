import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseCodexAppEffectfulDiagnosticArgs,
  runCodexAppEffectfulDiagnostic,
} from "../src/desktop-sync/codex-app-effectful-diagnostic.js";

type FakeMode =
  | "create-success"
  | "create-result-error"
  | "create-exception"
  | "list-result-error"
  | "metadata-gate-error"
  | "native-request-error";
type ProjectMode = "one" | "zero" | "multiple" | "invalid-kind" | "invalid-host";

const EXECUTOR_THREAD = "019d1c2a-8c46-7b1b-8ab1-123456789abc";
const CREATED_THREAD = "019d1c2a-8c46-7b1b-8ab1-9876543210ab";
const WORKSPACE_PATH = "C:/workspace/Local-Review-MCP";
const CREATE_PROMPT = "Only return LRM_CODEX_APP_P5_1_CREATE_PASS. Do not modify any files, create commits, or push.";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

function createSchema(): Record<string, unknown> {
  return {
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
              anyOf: [
                { type: "object", properties: { type: { type: "string", enum: ["local"] } }, required: ["type"] },
                { type: "object", properties: { type: { type: "string", enum: ["worktree"] } }, required: ["type"] },
              ],
            },
          },
          required: ["type", "projectId", "environment"],
        }],
      },
    },
    required: ["prompt", "target"],
  };
}

function projectsForMode(mode: ProjectMode): Array<Record<string, unknown>> {
  const project = (
    projectId: string,
    projectKind = "local",
    hostId = "local",
  ): Record<string, unknown> => ({
    projectId,
    projectKind,
    label: "Local-Review-MCP",
    path: WORKSPACE_PATH,
    hostId,
    isGitRepository: true,
  });
  if (mode === "zero") return [];
  if (mode === "multiple") return [project("project-one"), project("project-two")];
  if (mode === "invalid-kind") return [project("project-one", "remote")];
  if (mode === "invalid-host") return [project("project-one", "local", "remote-host")];
  return [project("project-one")];
}

function fakeServer(
  mode: FakeMode,
  projectMode: ProjectMode = "one",
  errorText = "approval required",
): { server: string; log: string } {
  const root = temporaryRoot("codex-app-effectful-p5-1-5");
  const server = join(root, "server.mjs");
  const log = join(root, "requests.log");
  writeFileSync(server, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = ${JSON.stringify(mode)};
const errorText = ${JSON.stringify(errorText)};
const log = ${JSON.stringify(log)};
const projects = ${JSON.stringify(projectsForMode(projectMode))};
const createSchema = ${JSON.stringify(createSchema())};

function reply(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function record(value) {
  appendFileSync(log, JSON.stringify(value) + "\\n");
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  record(request);
  if (request.method === "initialize") {
    reply({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-codex-app", version: "1.0.0" },
      },
    });
  } else if (request.method === "tools/list") {
    reply({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: ["list_projects", "create_thread", "send_message_to_thread"].map((name) => ({
          name,
          inputSchema: name === "create_thread"
            ? createSchema
            : { type: "object", properties: {}, required: [] },
        })),
      },
    });
  } else if (request.method === "tools/call") {
    const name = request.params?.name;
    if (name === "list_projects") {
      if (mode === "metadata-gate-error") {
        reply({ jsonrpc: "2.0", id: request.id, error: {
          code: -32602,
          message: "Codex app tools require thread metadata from the executor.",
        } });
      } else if (mode === "native-request-error") {
        reply({ jsonrpc: "2.0", id: request.id, error: {
          code: -32602,
          message: "Invalid app tool request",
        } });
      } else if (mode === "list-result-error") {
        reply({ jsonrpc: "2.0", id: request.id, result: {
          isError: true,
          content: [{ type: "text", text: "project discovery failed" }],
        } });
      } else {
        reply({ jsonrpc: "2.0", id: request.id, result: {
          content: [{ type: "text", text: JSON.stringify({ projects }) }],
        } });
      }
    } else if (name === "create_thread") {
      if (mode === "create-exception") {
        reply({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: errorText } });
      } else if (mode === "create-result-error") {
        reply({ jsonrpc: "2.0", id: request.id, result: {
          isError: true,
          content: [{ type: "text", text: errorText }],
        } });
      } else {
        reply({ jsonrpc: "2.0", id: request.id, result: {
          content: [{ type: "text", text: JSON.stringify({ threadId: ${JSON.stringify(CREATED_THREAD)}, hostId: "local" }) }],
        } });
      }
    } else {
      reply({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
    }
  }
});
`, "utf8");
  return { server, log };
}

function calls(log: string): Array<Record<string, unknown>> {
  return readFileSync(log, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function toolCalls(log: string): Array<Record<string, unknown>> {
  return calls(log).filter((call) => call.method === "tools/call");
}

function toolCallParams(log: string, index: number): Record<string, unknown> {
  return toolCalls(log)[index]!.params as Record<string, unknown>;
}

function runArgs(fake: { server: string }, ...extra: string[]): string[] {
  return ["--confirm-effectful", "--executor-thread", EXECUTOR_THREAD, "--server", fake.server, ...extra];
}

function runDependencies(): { environment: NodeJS.ProcessEnv; workspacePath: string } {
  return { environment: {}, workspacePath: WORKSPACE_PATH };
}

describe("codex app P5.1.5 Desktop-owned create_thread diagnostic", () => {
  it("fails closed without an executor thread and performs zero tools/call requests", async () => {
    const fake = fakeServer("create-success");
    const result = await runCodexAppEffectfulDiagnostic(
      ["--confirm-effectful", "--server", fake.server],
      runDependencies(),
    );

    expect(result).toMatchObject({
      ok: false,
      stage: "executor_thread_required",
      executorThreadProvided: false,
      executorMetadataKey: "openai/threadId",
      listProjectsCalled: false,
      createThreadCalled: false,
      sendMessageCalled: false,
    });
    expect(() => readFileSync(fake.log, "utf8")).toThrow();
  });

  it("parses the executor thread argument", () => {
    expect(parseCodexAppEffectfulDiagnosticArgs([
      "--confirm-effectful",
      "--executor-thread",
      EXECUTOR_THREAD,
      "--wait-after-failure-ms",
      "5",
      "--server",
      "C:/server.mjs",
    ])).toEqual({
      confirmEffectful: true,
      executorThreadId: EXECUTOR_THREAD,
      waitAfterFailureMs: 5,
      serverPath: "C:/server.mjs",
    });
  });

  it("uses the same request-level executor metadata for list_projects and create_thread", async () => {
    const fake = fakeServer("create-success");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: true,
      stage: "create_thread_succeeded",
      metadataGatePassed: true,
      listProjectsSucceeded: true,
      resolvedProject: true,
      projectResolutionSource: "list_projects",
      resolvedProjectId: "project-one",
      targetSchemaValid: true,
      environmentType: "local",
      createThreadCalled: true,
      threadCreated: true,
      threadIdSuffix: CREATED_THREAD.slice(-8),
      hostId: "local",
      sendMessageCalled: false,
      readThreadCalled: false,
      waitThreadsCalled: false,
    });
    expect(JSON.stringify(result)).not.toContain(CREATED_THREAD);

    const requests = calls(fake.log);
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "tools/call",
    ]);
    expect(toolCalls(fake.log)).toHaveLength(2);
    expect(toolCallParams(fake.log, 0)._meta).toEqual({ "openai/threadId": EXECUTOR_THREAD });
    expect(toolCallParams(fake.log, 1)._meta).toEqual({ "openai/threadId": EXECUTOR_THREAD });

    expect(toolCallParams(fake.log, 0)).toMatchObject({ name: "list_projects", arguments: {} });
    const createParams = toolCallParams(fake.log, 1);
    expect(createParams.name).toBe("create_thread");
    expect(createParams.arguments).toMatchObject({
      prompt: CREATE_PROMPT,
      target: {
        type: "project",
        projectId: "project-one",
        environment: { type: "local" },
      },
    });
    expect(createParams.arguments).not.toHaveProperty("threadId");
    expect(createParams.arguments).not.toHaveProperty("thread_id");
  });

  it.each([
    ["zero matches", "zero", "desktop_project_not_found"],
    ["multiple matches", "multiple", "desktop_project_ambiguous"],
    ["non-local project kind", "invalid-kind", "desktop_project_not_found"],
    ["non-local project host", "invalid-host", "desktop_project_not_found"],
  ] as const)("fails closed for %s before create_thread", async (_label, projectMode, stage) => {
    const fake = fakeServer("create-success", projectMode);
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage,
      metadataGatePassed: true,
      listProjectsSucceeded: true,
      resolvedProject: false,
      createThreadCalled: false,
      threadCreated: false,
    });
    expect(toolCalls(fake.log)).toHaveLength(1);
    expect(toolCallParams(fake.log, 0).name).toBe("list_projects");
  });

  it.each([
    ["approval required", "approval_required"],
    ["already has an active writer", "writer_conflict"],
    ["invalid target environment", "invalid_target"],
    ["project not found", "invalid_project"],
    ["native bridge failed", "native_bridge_rejected"],
  ] as const)("classifies create_thread %s and never retries", async (errorText, failureClass) => {
    const fake = fakeServer("create-result-error", "one", errorText);
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage: "create_thread_failed",
      metadataGatePassed: true,
      listProjectsSucceeded: true,
      resolvedProject: true,
      createThreadCalled: true,
      threadCreated: false,
      failureClass,
      sendMessageCalled: false,
      readThreadCalled: false,
      waitThreadsCalled: false,
    });
    expect(toolCalls(fake.log)).toHaveLength(2);
    expect(toolCallParams(fake.log, 0).name).toBe("list_projects");
    expect(toolCallParams(fake.log, 1).name).toBe("create_thread");
  });

  it("stops after a create_thread exception without retry", async () => {
    const fake = fakeServer("create-exception", "one", "permission denied");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage: "create_thread_failed",
      errorCode: -32001,
      failureClass: "permission_denied",
      createThreadCalled: true,
      threadCreated: false,
      sendMessageCalled: false,
      readThreadCalled: false,
      waitThreadsCalled: false,
    });
    expect(toolCalls(fake.log)).toHaveLength(2);
  });

  it("classifies the original list_projects metadata rejection without entering create_thread", async () => {
    const fake = fakeServer("metadata-gate-error");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage: "list_projects_failed",
      errorCode: -32602,
      failureClass: "executor_metadata_rejected",
      metadataGatePassed: false,
      listProjectsCalled: true,
      createThreadCalled: false,
    });
    expect(toolCalls(fake.log)).toHaveLength(1);
  });

  it("classifies a downstream native list_projects error without retry", async () => {
    const fake = fakeServer("native-request-error");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage: "list_projects_failed",
      errorCode: -32602,
      failureClass: "native_request_invalid",
      metadataGatePassed: true,
      createThreadCalled: false,
    });
    expect(toolCalls(fake.log)).toHaveLength(1);
  });

  it("stops after a list_projects result failure without retry", async () => {
    const fake = fakeServer("list-result-error");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage: "list_projects_failed",
      failureClass: "list_projects_failed",
      metadataGatePassed: true,
      listProjectsCalled: true,
      createThreadCalled: false,
      sendMessageCalled: false,
    });
    expect(toolCalls(fake.log)).toHaveLength(1);
  });
});
