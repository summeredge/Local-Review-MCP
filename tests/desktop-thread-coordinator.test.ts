import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolRequestParams, CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexAppToolContracts } from "../src/desktop-codex/codex-app-contracts.js";
import { desktopThreadBindingFile } from "../src/desktop-codex/desktop-thread-binding.js";
import { DesktopThreadBindingStore } from "../src/desktop-codex/desktop-thread-binding-store.js";
import {
  DesktopThreadCoordinator,
  type CreateOrReuseThreadInput,
  type DesktopThreadBindingResult,
} from "../src/desktop-codex/desktop-thread-coordinator.js";
import { DesktopCodexThreadCommands } from "../src/desktop-codex/thread-commands.js";
import type { DesktopThreadBinding } from "../src/desktop-codex/desktop-thread-binding.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function appTools(): Tool[] {
  return [
    {
      name: "create_thread",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          target: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["project"] },
              projectId: { type: "string" },
              environment: {
                type: "object",
                properties: { type: { type: "string", enum: ["local"] } },
                required: ["type"],
              },
            },
            required: ["type", "projectId", "environment"],
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

function createCommands(
  callTool: (params: CallToolRequestParams) => Promise<CallToolResult>,
): DesktopCodexThreadCommands {
  return new DesktopCodexThreadCommands({
    client: { callTool },
    contracts: createCodexAppToolContracts(appTools()),
  });
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "desktop-thread-coordinator-"));
  roots.push(root);
  return root;
}

function input(overrides: Partial<CreateOrReuseThreadInput> = {}): CreateOrReuseThreadInput {
  return {
    workspace_id: "workspace-1",
    task_id: "task-1",
    session_id: "session-1",
    executorThreadId: "executor-A",
    projectId: "project-1",
    prompt: "create",
    ...overrides,
  };
}

function storedBinding(overrides: Partial<DesktopThreadBinding> = {}): DesktopThreadBinding {
  return {
    schema_version: 1,
    workspace_id: "workspace-1",
    task_id: "task-1",
    session_id: "session-1",
    backend_identity: "desktop_codex_app",
    target_thread_id: "target-thread-1",
    host_id: "local",
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("DesktopThreadCoordinator", () => {
  it("creates and persists a binding on the first call", async () => {
    const root = createRoot();
    const calls: CallToolRequestParams[] = [];
    const commands = createCommands(async (params) => {
      calls.push(params);
      return toolResult({ threadId: "target-thread-1", hostId: "local" });
    });
    const bindings = new DesktopThreadBindingStore(root);
    const coordinator = new DesktopThreadCoordinator({ commands, bindings });

    const { binding: result, created } = await coordinator.createOrReuseThread(input());

    expect(result.target_thread_id).toBe("target-thread-1");
    expect(result.host_id).toBe("local");
    expect(created).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?._meta?.["openai/threadId"]).toBe("executor-A");
    await expect(bindings.load("workspace-1", "session-1")).resolves.toEqual(result);
  });

  it("reuses an existing binding without calling create_thread", async () => {
    const root = createRoot();
    const bindings = new DesktopThreadBindingStore(root);
    const existing = storedBinding();
    await bindings.createIfAbsent(existing);
    const calls: CallToolRequestParams[] = [];
    const commands = createCommands(async (params) => {
      calls.push(params);
      return toolResult({ threadId: "unexpected", hostId: "local" });
    });
    const coordinator = new DesktopThreadCoordinator({ commands, bindings });

    await expect(coordinator.createOrReuseThread(input({
      executorThreadId: "executor-B",
      prompt: "different prompt",
    }))).resolves.toEqual({ binding: existing, created: false });
    expect(calls).toHaveLength(0);
  });

  it("sends after restart with the new executor and old durable target", async () => {
    const root = createRoot();
    const firstBindings = new DesktopThreadBindingStore(root);
    const firstCalls: CallToolRequestParams[] = [];
    const first = new DesktopThreadCoordinator({
      bindings: firstBindings,
      commands: createCommands(async (params) => {
        firstCalls.push(params);
        return toolResult({ threadId: "target-thread-1", hostId: "local" });
      }),
    });
    const firstCreate = await first.createOrReuseThread(input());
    expect(firstCreate.created).toBe(true);

    const calls: CallToolRequestParams[] = [];
    const restarted = new DesktopThreadCoordinator({
      bindings: new DesktopThreadBindingStore(root),
      commands: createCommands(async (params) => {
        calls.push(params);
        return toolResult({ ok: true });
      }),
    });
    await restarted.sendToBoundThread({
      workspace_id: "workspace-1",
      task_id: "task-1",
      session_id: "session-1",
      executorThreadId: "executor-B",
      prompt: "send",
    });

    expect(firstCalls).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "send_message_to_thread",
      arguments: { threadId: "target-thread-1", hostId: "local", prompt: "send" },
      _meta: { "openai/threadId": "executor-B" },
    });
  });

  it("fails closed when the binding does not exist", async () => {
    const calls: CallToolRequestParams[] = [];
    const coordinator = new DesktopThreadCoordinator({
      bindings: new DesktopThreadBindingStore(createRoot()),
      commands: createCommands(async (params) => {
        calls.push(params);
        return toolResult({ ok: true });
      }),
    });

    await expect(coordinator.sendToBoundThread({
      workspace_id: "workspace-1",
      task_id: "task-1",
      session_id: "session-1",
      executorThreadId: "executor-A",
      prompt: "send",
    })).rejects.toMatchObject({ code: "binding_not_found" });
    expect(calls).toHaveLength(0);
  });

  it("fails closed when the task identity does not match", async () => {
    const root = createRoot();
    const bindings = new DesktopThreadBindingStore(root);
    await bindings.createIfAbsent(storedBinding({ task_id: "task-A" }));
    const calls: CallToolRequestParams[] = [];
    const coordinator = new DesktopThreadCoordinator({
      bindings,
      commands: createCommands(async (params) => {
        calls.push(params);
        return toolResult({ ok: true });
      }),
    });

    await expect(coordinator.sendToBoundThread({
      workspace_id: "workspace-1",
      task_id: "task-B",
      session_id: "session-1",
      executorThreadId: "executor-A",
      prompt: "send",
    })).rejects.toMatchObject({ code: "binding_identity_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("preserves the existing executor-target conflict guard", async () => {
    const root = createRoot();
    const bindings = new DesktopThreadBindingStore(root);
    await bindings.createIfAbsent(storedBinding({ target_thread_id: "executor-A" }));
    const calls: CallToolRequestParams[] = [];
    const coordinator = new DesktopThreadCoordinator({
      bindings,
      commands: createCommands(async (params) => {
        calls.push(params);
        return toolResult({ ok: true });
      }),
    });

    await expect(coordinator.sendToBoundThread({
      workspace_id: "workspace-1",
      task_id: "task-1",
      session_id: "session-1",
      executorThreadId: "executor-A",
      prompt: "send",
    })).rejects.toMatchObject({ code: "thread_identity_conflict" });
    expect(calls).toHaveLength(0);
  });

  it("does not persist a create_thread target equal to the executor", async () => {
    const root = createRoot();
    const bindings = new DesktopThreadBindingStore(root);
    let createIfAbsentCalls = 0;
    const commands = createCommands(async () => toolResult({
      threadId: "executor-A",
      hostId: "local",
    }));
    const coordinator = new DesktopThreadCoordinator({
      commands,
      bindings: {
        load: bindings.load.bind(bindings),
        createIfAbsent: async (binding) => {
          createIfAbsentCalls += 1;
          return bindings.createIfAbsent(binding);
        },
      },
    });

    await expect(coordinator.createOrReuseThread(input()))
      .rejects.toMatchObject({ code: "thread_identity_conflict" });

    expect(createIfAbsentCalls).toBe(0);
    await expect(bindings.load("workspace-1", "session-1")).resolves.toBeUndefined();
    expect(existsSync(desktopThreadBindingFile(root, "workspace-1", "session-1"))).toBe(false);
  });

  it("returns only the durable winner during a create race", async () => {
    const root = createRoot();
    const bindings = new DesktopThreadBindingStore(root);
    const command = (targetThreadId: string) => ({
      createThread: async () => ({ targetThreadId, hostId: "local" }),
      sendMessageToThread: async () => toolResult({ ok: true }),
    });
    const left = new DesktopThreadCoordinator({ commands: command("target-A"), bindings });
    const right = new DesktopThreadCoordinator({ commands: command("target-B"), bindings });

    const outcomes = await Promise.allSettled([
      left.createOrReuseThread(input({ prompt: "left" })),
      right.createOrReuseThread(input({ prompt: "right" })),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<DesktopThreadBindingResult> => outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    const winner = fulfilled[0]?.value.binding;
    const raw = readFileSync(join(root, ".task", "desktop_thread_bindings", "workspace-1", "session-1.json"), "utf8");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "binding_conflict" });
    expect(winner).toBeDefined();
    expect(JSON.parse(raw)).toEqual(winner);
    expect(await bindings.load("workspace-1", "session-1")).toEqual(winner);
  });
});
