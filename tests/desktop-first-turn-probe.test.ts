import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolRequestParams, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  desktopFirstTurnProbeRunDirectory,
  parseDesktopFirstTurnProbeArgs,
  runDesktopFirstTurnProbe,
  type DesktopFirstTurnProbeRuntime,
} from "../src/desktop-sync/desktop-first-turn-probe.js";

const EXECUTOR_THREAD = "executor-thread";
const TARGET_THREAD = "target-thread";
const HOST_ID = "local";
const A = "turn-A";
const B = "turn-B";

function tool(name: string, inputSchema: Record<string, unknown>): Tool {
  return { name, inputSchema } as unknown as Tool;
}

function appTools(): Tool[] {
  return [
    tool("list_projects", { type: "object", properties: {} }),
    tool("create_thread", {
      type: "object",
      properties: {
        prompt: { type: "string" },
        target: {
          type: "object",
          properties: {
            type: { const: "project" },
            projectId: { type: "string" },
            environment: {
              type: "object",
              properties: { type: { const: "local" } },
              required: ["type"],
            },
          },
          required: ["type", "projectId", "environment"],
        },
      },
      required: ["prompt", "target"],
    }),
    tool("read_thread", {
      type: "object",
      properties: {
        threadId: { type: "string" },
        hostId: { type: "string" },
        cursor: { type: "string" },
        turnLimit: { type: "integer", minimum: 1, maximum: 10 },
        includeOutputs: { type: "boolean" },
      },
      required: ["threadId"],
    }),
    tool("wait_threads", {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              threadId: { type: "string" },
              hostId: { type: "string" },
              afterCursor: { type: "string" },
            },
            required: ["threadId"],
          },
        },
        timeoutMs: { type: "integer", minimum: 0, maximum: 120_000 },
      },
      required: ["targets"],
    }),
  ];
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function rawTextResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(): CallToolResult {
  return { isError: true, content: [{ type: "text", text: "tool failed" }] };
}

function turn(
  id: string,
  status: string,
  values: Partial<Record<"error" | "completedAt", unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "completed" ? 2 : null,
    items: [],
    ...values,
  };
}

function readPayload(turns: readonly Record<string, unknown>[]): CallToolResult {
  return textResult({
    schemaVersion: 1,
    thread: { id: TARGET_THREAD, hostId: HOST_ID, status: { type: "idle" } },
    turns,
  });
}

function waitPayload(values: Record<string, unknown> = {}): CallToolResult {
  return textResult({
    timedOut: false,
    polls: [{ cursor: "wait-cursor-1", thread: { id: TARGET_THREAD, hostId: HOST_ID, status: { type: "idle" } } }],
    ...values,
  });
}

interface FakeRuntime {
  readonly runtime: DesktopFirstTurnProbeRuntime;
  readonly calls: CallToolRequestParams[];
}

function fakeRuntime(
  workspacePath: string,
  reads: readonly CallToolResult[],
  waits: readonly CallToolResult[],
  create: () => Promise<CallToolResult> = async () => textResult({ threadId: TARGET_THREAD, hostId: HOST_ID }),
): FakeRuntime {
  const readQueue = [...reads];
  const waitQueue = [...waits];
  const calls: CallToolRequestParams[] = [];
  let lastRead = reads.at(-1);
  let lastWait = waits.at(-1);
  const callTool: DesktopFirstTurnProbeRuntime["mcpClient"]["callTool"] = async (params) => {
    calls.push(params as CallToolRequestParams);
    if (params.name === "list_projects") {
      return textResult({
        projects: [{ projectId: "project-1", path: workspacePath, projectKind: "local", hostId: HOST_ID }],
      }) as never;
    }
    if (params.name === "create_thread") {
      return await create() as never;
    }
    if (params.name === "read_thread") {
      const next = readQueue.shift() ?? lastRead;
      if (next === undefined) throw new Error("unexpected read_thread call");
      lastRead = next;
      return next as never;
    }
    if (params.name === "wait_threads") {
      const next = waitQueue.shift() ?? lastWait;
      if (next === undefined) throw new Error("unexpected wait_threads call");
      lastWait = next;
      return next as never;
    }
    throw new Error(`unexpected tool: ${params.name}`);
  };
  return {
    calls,
    runtime: {
      info: { desktopDetected: true, bundleDetected: true },
      listTools: async () => ({ tools: appTools() }),
      mcpClient: { callTool },
      close: async () => undefined,
    },
  };
}

async function withProbe(
  reads: readonly CallToolResult[],
  waits: readonly CallToolResult[],
  extraArgs: readonly string[] = [],
  create: () => Promise<CallToolResult> = async () => textResult({ threadId: TARGET_THREAD, hostId: HOST_ID }),
): Promise<{
  readonly result: Awaited<ReturnType<typeof runDesktopFirstTurnProbe>>;
  readonly calls: CallToolRequestParams[];
  readonly artifactDir: string;
  readonly cleanup: () => Promise<void>;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "p541-first-turn-"));
  const fake = fakeRuntime(workspace, reads, waits, create);
  const result = await runDesktopFirstTurnProbe(["--confirm-effectful", ...extraArgs], {
    workspacePath: workspace,
    connectRuntime: async () => fake.runtime,
    readExecutorThreadId: async () => EXECUTOR_THREAD,
  });
  return {
    result,
    calls: fake.calls,
    artifactDir: result.artifact_dir,
    cleanup: async () => { await rm(workspace, { recursive: true, force: true }); },
  };
}

describe("P5.4.1-D first-turn probe plumbing", () => {
  it("parses bounded effectful probe arguments", () => {
    expect(parseDesktopFirstTurnProbeArgs(
      ["--confirm-effectful", "--timeout-ms", "5000"],
      "C:/workspace/Local-Review-MCP",
    )).toEqual({
      confirmEffectful: true,
      timeoutMs: 5000,
      workspacePath: "C:\\workspace\\Local-Review-MCP",
    });
    expect(() => parseDesktopFirstTurnProbeArgs(["--timeout-ms", "0"])).toThrow();
  });

  it("isolates artifacts under a UUID run directory", () => {
    const runId = "019d1c2a-8c46-7b1b-8ab1-123456789abc";
    expect(desktopFirstTurnProbeRunDirectory("C:/ws", runId))
      .toBe(join("C:\\ws", ".review", "p5-4-1-first-turn-probe", runId));
    expect(() => desktopFirstTurnProbeRunDirectory("C:/ws", "..\\escape")).toThrow();
  });

  it("requires effectful confirmation before any runtime work", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "p541-confirm-"));
    try {
      const fake = fakeRuntime(workspace, [], []);
      const result = await runDesktopFirstTurnProbe([], {
        workspacePath: workspace,
        connectRuntime: async () => fake.runtime,
        readExecutorThreadId: async () => EXECUTOR_THREAD,
      });
      expect(result.ok).toBe(false);
      expect(result.failure_class).toBe("effectful_confirmation_required");
      expect(fake.calls).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("P5.4.1-D create_thread -> empty baseline -> waitForCompletion", () => {
  it("never captures a baseline and completes against an empty baseline", async () => {
    const { result, calls, artifactDir, cleanup } = await withProbe(
      [readPayload([turn(B, "completed")])],
      [],
    );
    try {
      expect(result.ok).toBe(true);
      expect(result.observer_status).toBe("completed");
      expect(result.first_read_is_error).toBe(false);
      expect(result.first_wait_is_error).toBe(false);
      expect(result.turn_error_observed).toBe(false);

      const toolNames = calls.map((call) => call.name);
      expect(toolNames[0]).toBe("list_projects");
      expect(toolNames[1]).toBe("create_thread");
      expect(toolNames.slice(2).every((name) => name === "read_thread")).toBe(true);
      expect(toolNames).not.toContain("wait_threads");
      expect(calls.every((call) => call._meta?.["openai/threadId"] === EXECUTOR_THREAD)).toBe(true);

      const readResults = JSON.parse(await readFile(join(artifactDir, "read-results.json"), "utf8")) as unknown[];
      expect(readResults).toHaveLength(1);
      const observerResult = JSON.parse(await readFile(join(artifactDir, "observer-result.json"), "utf8")) as Record<string, unknown>;
      expect(observerResult).toMatchObject({ status: "completed", turnId: B });
      const report = await readFile(join(artifactDir, "report.md"), "utf8");
      expect(report).toContain("captureBaseline was NOT called");
      expect(report).toContain("completed: true");
    } finally {
      await cleanup();
    }
  });

  it("writes every required artifact even when the observer fails", async () => {
    const { result, artifactDir, cleanup } = await withProbe([errorResult()], []);
    try {
      expect(result.ok).toBe(true);
      for (const name of [
        "report.md",
        "requests.json",
        "create-result.json",
        "read-results.json",
        "wait-results.json",
        "observer-result.json",
        "tool-read_thread.json",
        "tool-wait_threads.json",
      ]) {
        await expect(readFile(join(artifactDir, name), "utf8")).resolves.toBeTypeOf("string");
      }
    } finally {
      await cleanup();
    }
  });
});

describe("P5.4.1-D failure classification", () => {
  it("distinguishes a read_thread tool error", async () => {
    const { result, artifactDir, cleanup } = await withProbe([errorResult()], []);
    try {
      expect(result.observer_status).toBe("unknown");
      expect(result.observer_reason).toBe("tool_error");
      expect(result.first_read_is_error).toBe(true);
      expect(result.first_wait_is_error).toBe(false);
      const report = await readFile(join(artifactDir, "report.md"), "utf8");
      expect(report).toContain("read_thread_tool_error: true");
      expect(report).toContain("wait_threads_tool_error: false");
    } finally {
      await cleanup();
    }
  });

  it("distinguishes a wait_threads tool error", async () => {
    const { result, artifactDir, cleanup } = await withProbe(
      [readPayload([turn(B, "inProgress")])],
      [errorResult()],
    );
    try {
      expect(result.observer_status).toBe("unknown");
      expect(result.observer_reason).toBe("tool_error");
      expect(result.first_read_is_error).toBe(false);
      expect(result.first_wait_is_error).toBe(true);
      const report = await readFile(join(artifactDir, "report.md"), "utf8");
      expect(report).toContain("wait_threads_tool_error: true");
    } finally {
      await cleanup();
    }
  });

  it("distinguishes a turn-level error", async () => {
    const { result, artifactDir, cleanup } = await withProbe(
      [readPayload([turn(B, "completed", { error: { code: "failed" } })])],
      [],
    );
    try {
      expect(result.observer_reason).toBe("tool_error");
      expect(result.turn_error_observed).toBe(true);
      const report = await readFile(join(artifactDir, "report.md"), "utf8");
      expect(report).toContain("turn_error: true");
    } finally {
      await cleanup();
    }
  });

  it("distinguishes a malformed response", async () => {
    const { result, artifactDir, cleanup } = await withProbe([rawTextResult("{not-json")], []);
    try {
      expect(result.observer_reason).toBe("malformed_response");
      const report = await readFile(join(artifactDir, "report.md"), "utf8");
      expect(report).toContain("malformed_response: true");
    } finally {
      await cleanup();
    }
  });

  it("distinguishes a timeout", async () => {
    const { result, artifactDir, cleanup } = await withProbe(
      [readPayload([turn(B, "inProgress")])],
      [waitPayload({ polls: [] })],
      ["--timeout-ms", "40"],
    );
    try {
      expect(result.observer_status).toBe("timed_out");
      const report = await readFile(join(artifactDir, "report.md"), "utf8");
      expect(report).toContain("timeout: true");
      expect(report).toContain("completed: false");
    } finally {
      await cleanup();
    }
  });
});

describe("P5.4.1-D create_thread raw result", () => {
  it("stores the real create_thread CallToolResult verbatim", async () => {
    const createResult = textResult({
      threadId: TARGET_THREAD,
      hostId: HOST_ID,
      status: { type: "inProgress" },
    });
    const { result, artifactDir, cleanup } = await withProbe(
      [readPayload([turn(B, "completed")])],
      [],
      [],
      async () => createResult,
    );
    try {
      expect(result.ok).toBe(true);
      const stored = JSON.parse(await readFile(join(artifactDir, "create-result.json"), "utf8")) as unknown;
      expect(stored).toEqual(createResult);
    } finally {
      await cleanup();
    }
  });

  it("stores the create_thread isError CallToolResult verbatim", async () => {
    const createError = errorResult();
    const { result, artifactDir, cleanup } = await withProbe([], [], [], async () => createError);
    try {
      expect(result.ok).toBe(false);
      expect(result.failure_class).toBe("create_failed");
      const stored = JSON.parse(await readFile(join(artifactDir, "create-result.json"), "utf8")) as unknown;
      expect(stored).toEqual(createError);
      expect(stored).not.toEqual({ available: false });
    } finally {
      await cleanup();
    }
  });

  it("records a create_thread throw as diagnosable evidence", async () => {
    const { result, artifactDir, cleanup } = await withProbe([], [], [], async () => {
      throw new Error("create_thread transport exploded");
    });
    try {
      expect(result.ok).toBe(false);
      expect(result.failure_class).toBe("create_failed");
      const stored = JSON.parse(await readFile(join(artifactDir, "create-result.json"), "utf8")) as Record<string, unknown>;
      expect(stored).toMatchObject({ available: false, error: { name: "Error" } });
      const requests = JSON.parse(await readFile(join(artifactDir, "requests.json"), "utf8")) as readonly Record<string, unknown>[];
      expect(requests.some((request) => request.name === "create_thread")).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
