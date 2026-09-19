import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseCodexAppEffectfulDiagnosticArgs,
  runCodexAppEffectfulDiagnostic,
} from "../src/desktop-sync/codex-app-effectful-diagnostic.js";

type FakeMode =
  | "success"
  | "first-unverifiable"
  | "send-result-error"
  | "send-exception"
  | "first-wait-timeout"
  | "second-wait-timeout"
  | "send-schema-incompatible"
  | "no-completion-tools"
  | "read-fallback"
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
const SECOND_PROMPT = "Only return LRM_CODEX_APP_P5_1_SECOND_PASS. Do not modify any files, create commits, or push.";
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

function sendSchema(incompatible: boolean): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ...(incompatible ? {} : { threadId: { type: "string" } }),
      prompt: { type: "string" },
      hostId: { type: "string" },
    },
    required: incompatible ? ["prompt"] : ["threadId", "prompt"],
    additionalProperties: false,
  };
}

function waitSchema(incompatible: boolean): Record<string, unknown> {
  return incompatible
    ? { type: "object", properties: {}, required: ["unsupported"], additionalProperties: false }
    : {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              threadId: { type: "string", minLength: 1 },
              hostId: { type: "string", minLength: 1 },
              afterCursor: { type: "string", minLength: 1 },
            },
            required: ["threadId"],
            additionalProperties: false,
          },
        },
        timeoutMs: { type: "integer", minimum: 0, maximum: 120000 },
      },
      required: ["targets"],
      additionalProperties: false,
    };
}

function readSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      threadId: { type: "string" },
      hostId: { type: "string" },
      cursor: { type: "string" },
      turnLimit: { type: "integer", minimum: 1, maximum: 10 },
      includeOutputs: { type: "boolean" },
      maxOutputCharsPerItem: { type: "integer", minimum: 0, maximum: 20000 },
    },
    required: ["threadId"],
    additionalProperties: false,
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
  const root = temporaryRoot("codex-app-effectful-p5-1-6");
  const server = join(root, "server.mjs");
  const log = join(root, "requests.log");
  const includeCompletionTools = mode !== "no-completion-tools";
  const useReadFallback = mode === "read-fallback";
  writeFileSync(server, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = ${JSON.stringify(mode)};
const errorText = ${JSON.stringify(errorText)};
const log = ${JSON.stringify(log)};
const projects = ${JSON.stringify(projectsForMode(projectMode))};
const createSchema = ${JSON.stringify(createSchema())};
const sendSchema = ${JSON.stringify(sendSchema(mode === "send-schema-incompatible"))};
const waitSchema = ${JSON.stringify(waitSchema(useReadFallback))};
const readSchema = ${JSON.stringify(readSchema())};
let completionCalls = 0;

function reply(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function record(value) {
  appendFileSync(log, JSON.stringify(value) + "\\n");
}
  function completionResult(marker, status = "completed") {
    return {
      content: [{ type: "text", text: JSON.stringify({
      threads: [{
        threadId: ${JSON.stringify(CREATED_THREAD)},
        turnCompleted: status === "completed",
        latestAssistantMessage: marker,
        errors: [],
      }],
      }) }],
    };
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
    const tools = [
      { name: "list_projects", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "create_thread", inputSchema: createSchema },
      { name: "send_message_to_thread", inputSchema: sendSchema },
      ...(${includeCompletionTools} ? [
        { name: "wait_threads", inputSchema: waitSchema },
        { name: "read_thread", inputSchema: readSchema },
      ] : []),
    ];
    reply({ jsonrpc: "2.0", id: request.id, result: { tools } });
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
    } else if (name === "send_message_to_thread") {
      if (mode === "send-exception") {
        reply({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: errorText } });
      } else if (mode === "send-result-error") {
        reply({ jsonrpc: "2.0", id: request.id, result: {
          isError: true,
          content: [{ type: "text", text: errorText }],
        } });
      } else {
        reply({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
      }
    } else if (name === "wait_threads" || name === "read_thread") {
      completionCalls += 1;
      if ((mode === "first-wait-timeout" && completionCalls === 1)
        || (mode === "second-wait-timeout" && completionCalls === 2)) {
        return;
      }
      const marker = completionCalls === 1
        ? "LRM_CODEX_APP_P5_1_CREATE_PASS"
        : "LRM_CODEX_APP_P5_1_SECOND_PASS";
      const status = mode === "first-unverifiable" && completionCalls === 1 ? "running" : "completed";
      reply({ jsonrpc: "2.0", id: request.id, result: completionResult(marker, status) });
    } else {
      reply({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
    }
  }
});
input.on("close", () => process.exit(0));
setInterval(() => {}, 1000);
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

function runDependencies(timeoutMs?: number): { environment: NodeJS.ProcessEnv; workspacePath: string; timeoutMs?: number } {
  return { environment: {}, workspacePath: WORKSPACE_PATH, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

describe("codex app P5.1.6 send_message_to_thread continuity diagnostic", () => {
  it("fails closed without an executor thread and performs zero tools/call requests", async () => {
    const fake = fakeServer("success");
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

  it("waits, sends to the created target thread, waits again, and reuses executor metadata", async () => {
    const fake = fakeServer("success");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: true,
      stage: "continuity_succeeded",
      metadataGatePassed: true,
      listProjectsSucceeded: true,
      resolvedProject: true,
      targetSchemaValid: true,
      environmentType: "local",
      createThreadCalled: true,
      threadCreated: true,
      createdThreadSuffix: CREATED_THREAD.slice(-8),
      threadIdSuffix: CREATED_THREAD.slice(-8),
      hostId: "local",
      firstTurnCompleted: true,
      firstMarkerObserved: true,
      sendMessageCalled: true,
      sendTargetMatchesCreatedThread: true,
      secondTurnCompleted: true,
      secondMarkerObserved: true,
      sameThread: true,
      writerConflictObserved: false,
      readThreadCalled: false,
      waitThreadsCalled: true,
    });
    expect(JSON.stringify(result)).not.toContain(CREATED_THREAD);

    const requests = calls(fake.log);
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
    ]);
    expect(toolCalls(fake.log).map((call) => (call.params as Record<string, unknown>).name)).toEqual([
      "list_projects",
      "create_thread",
      "wait_threads",
      "send_message_to_thread",
      "wait_threads",
    ]);
    expect(toolCalls(fake.log)).toHaveLength(5);
    for (const call of toolCalls(fake.log)) {
      expect((call.params as Record<string, unknown>)._meta).toEqual({ "openai/threadId": EXECUTOR_THREAD });
    }

    expect(toolCallParams(fake.log, 0)).toMatchObject({ name: "list_projects", arguments: {} });
    expect(toolCallParams(fake.log, 1)).toMatchObject({
      name: "create_thread",
      arguments: {
        prompt: CREATE_PROMPT,
        target: { type: "project", projectId: "project-one", environment: { type: "local" } },
      },
    });
    expect(toolCallParams(fake.log, 2)).toMatchObject({
      name: "wait_threads",
      arguments: { targets: [{ threadId: CREATED_THREAD, hostId: "local" }] },
    });
    expect(toolCallParams(fake.log, 3)).toMatchObject({
      name: "send_message_to_thread",
      arguments: { threadId: CREATED_THREAD, hostId: "local", prompt: SECOND_PROMPT },
    });
    expect(toolCallParams(fake.log, 4)).toMatchObject({
      name: "wait_threads",
      arguments: { targets: [{ threadId: CREATED_THREAD, hostId: "local" }] },
    });
    expect(toolCallParams(fake.log, 3).arguments).not.toHaveProperty("executorThreadId");
  });

  it.each([
    ["zero matches", "zero", "desktop_project_not_found"],
    ["multiple matches", "multiple", "desktop_project_ambiguous"],
    ["non-local project kind", "invalid-kind", "desktop_project_not_found"],
    ["non-local project host", "invalid-host", "desktop_project_not_found"],
  ] as const)("fails closed for %s before create_thread", async (_label, projectMode, stage) => {
    const fake = fakeServer("success", projectMode);
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage,
      metadataGatePassed: true,
      listProjectsSucceeded: true,
      resolvedProject: false,
      createThreadCalled: false,
      sendMessageCalled: false,
    });
    expect(toolCalls(fake.log)).toHaveLength(1);
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
      resolvedProject: true,
      createThreadCalled: true,
      threadCreated: false,
      failureClass,
      sendMessageCalled: false,
      firstTurnCompleted: false,
    });
    expect(toolCalls(fake.log).map((call) => (call.params as Record<string, unknown>).name))
      .toEqual(["list_projects", "create_thread"]);
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
    });
    expect(toolCalls(fake.log)).toHaveLength(2);
  });

  it("fails closed when first-turn completion cannot be verified", async () => {
    const fake = fakeServer("first-unverifiable");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage: "first_turn_completion_unverifiable",
      metadataGatePassed: true,
      threadCreated: true,
      firstTurnCompleted: false,
      sendMessageCalled: false,
      waitThreadsCalled: true,
    });
    expect(toolCalls(fake.log).map((call) => (call.params as Record<string, unknown>).name))
      .toEqual(["list_projects", "create_thread", "wait_threads"]);
  });

  it("classifies a first-turn wait timeout without sending", async () => {
    const fake = fakeServer("first-wait-timeout");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies(5));

    expect(result).toMatchObject({
      ok: false,
      stage: "first_turn_timeout",
      failureClass: "first_turn_timeout",
      threadCreated: true,
      firstTurnCompleted: false,
      sendMessageCalled: false,
    });
    expect(toolCalls(fake.log).map((call) => (call.params as Record<string, unknown>).name))
      .toEqual(["list_projects", "create_thread", "wait_threads"]);
  });

  it("does not send when the dynamic send schema is incompatible", async () => {
    const fake = fakeServer("send-schema-incompatible");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage: "send_message_schema_incompatible",
      firstTurnCompleted: true,
      sendMessageCalled: false,
      secondTurnCompleted: false,
    });
    expect(toolCalls(fake.log).map((call) => (call.params as Record<string, unknown>).name))
      .toEqual(["list_projects", "create_thread", "wait_threads"]);
  });

  it("classifies the active-turn steer race without retry", async () => {
    const fake = fakeServer("send-result-error", "one", "Cannot steer conversation because its active turn already ended");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage: "steer_race",
      failureClass: "steer_race",
      firstTurnCompleted: true,
      sendMessageCalled: true,
      sendTargetMatchesCreatedThread: true,
      secondTurnCompleted: false,
    });
    expect(toolCalls(fake.log).map((call) => (call.params as Record<string, unknown>).name))
      .toEqual(["list_projects", "create_thread", "wait_threads", "send_message_to_thread"]);
  });

  it("classifies a send exception and never retries", async () => {
    const fake = fakeServer("send-exception", "one", "permission denied by native bridge");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage: "send_message_failed",
      failureClass: "permission_denied",
      firstTurnCompleted: true,
      sendMessageCalled: true,
      secondTurnCompleted: false,
    });
    expect(toolCalls(fake.log)).toHaveLength(4);
  });

  it("classifies a second-turn timeout without retry", async () => {
    const fake = fakeServer("second-wait-timeout");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies(5));

    expect(result).toMatchObject({
      ok: false,
      stage: "second_turn_timeout",
      failureClass: "second_turn_timeout",
      firstTurnCompleted: true,
      sendMessageCalled: true,
      sendTargetMatchesCreatedThread: true,
      secondTurnCompleted: false,
      sameThread: false,
    });
    expect(toolCalls(fake.log).map((call) => (call.params as Record<string, unknown>).name))
      .toEqual(["list_projects", "create_thread", "wait_threads", "send_message_to_thread", "wait_threads"]);
  });

  it("uses read_thread only when wait_threads schema is incompatible", async () => {
    const fake = fakeServer("read-fallback");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: true,
      stage: "continuity_succeeded",
      firstTurnCompleted: true,
      secondTurnCompleted: true,
      firstMarkerObserved: true,
      secondMarkerObserved: true,
      readThreadCalled: true,
      waitThreadsCalled: false,
      sameThread: true,
    });
    expect(toolCalls(fake.log).map((call) => (call.params as Record<string, unknown>).name))
      .toEqual(["list_projects", "create_thread", "read_thread", "send_message_to_thread", "read_thread"]);
  });

  it("fails closed when neither wait_threads nor read_thread is available", async () => {
    const fake = fakeServer("no-completion-tools");
    const result = await runCodexAppEffectfulDiagnostic(runArgs(fake), runDependencies());

    expect(result).toMatchObject({
      ok: false,
      stage: "first_turn_completion_unverifiable",
      threadCreated: true,
      sendMessageCalled: false,
      firstTurnCompleted: false,
      waitThreadsCalled: false,
      readThreadCalled: false,
    });
    expect(toolCalls(fake.log).map((call) => (call.params as Record<string, unknown>).name))
      .toEqual(["list_projects", "create_thread"]);
  });

  it("classifies the original and downstream list_projects -32602 errors without create_thread", async () => {
    const metadataGate = fakeServer("metadata-gate-error");
    const metadataResult = await runCodexAppEffectfulDiagnostic(runArgs(metadataGate), runDependencies());
    expect(metadataResult).toMatchObject({
      stage: "list_projects_failed",
      errorCode: -32602,
      failureClass: "executor_metadata_rejected",
      metadataGatePassed: false,
      createThreadCalled: false,
    });

    const native = fakeServer("native-request-error");
    const nativeResult = await runCodexAppEffectfulDiagnostic(runArgs(native), runDependencies());
    expect(nativeResult).toMatchObject({
      stage: "list_projects_failed",
      errorCode: -32602,
      failureClass: "native_request_invalid",
      metadataGatePassed: true,
      createThreadCalled: false,
    });
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
