import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgePort, extensionDeliveryReadiness, EXTENSION_PRESENCE_TIMEOUT_MS, startBridge, stopBridge } from "../src/control-plane/bridge.js";
import { startApp } from "../src/app.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { TaskContextService } from "../src/context/service.js";
import { SessionStore } from "../src/context/session-store.js";
import { EventStore } from "../src/control-plane/events/store.js";
import { goalOrchestrationSchema } from "../src/control-plane/goal-orchestration.js";
import {
  createHttpServer,
  LAUNCHER_DOCTOR_PATH,
  LAUNCHER_EXECUTION_CATALOG_PATH,
} from "../src/mcp/http.js";
import { inboundRequestId } from "../src/mcp/inbound.js";
import { StatusQueryService } from "../src/control-plane/status-query.js";
import type { DesktopSyncState } from "../src/desktop-sync/desktop-sync-state.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { EXPECTED_REGISTERED_TOOL_NAMES } from "./fixtures/v01-tools.js";

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

async function listen(server: import("node:http").Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  return address.port;
}

function toolText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || typeof content[0] !== "object" || content[0] === null
    || typeof (content[0] as { text?: unknown }).text !== "string") {
    throw new Error("tool did not return text content");
  }
  return (content[0] as { text: string }).text;
}

function structuredJson(result: unknown): Record<string, unknown> {
  const parsed = JSON.parse(toolText(result)) as Record<string, unknown>;
  expect((result as { structuredContent?: unknown }).structuredContent).toEqual(parsed);
  return parsed;
}

describe("MCP HTTP runtime", () => {
  it("serves the authenticated read-only Doctor report", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-launcher-doctor-"));
    temporaryDirectories.push(workspace);
    const registry = new WorkspaceRegistry([{ id: "doctor-http", name: "Doctor HTTP", path: workspace }]);
    const report = {
      status: "READY" as const,
      checks: [{ component: "MCP Runtime", status: "PASS" as const, timestamp: "2026-09-24T00:00:00.000Z" }],
      generatedAt: "2026-09-24T00:00:00.000Z",
    };
    const server = createHttpServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    }, { registry, doctorRunner: { run: vi.fn(async () => report) } });
    runningServers.push(server);
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}${LAUNCHER_DOCTOR_PATH}`;
    const headers = { authorization: "Bearer test-token" };
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers })).status).toBe(405);
    expect((await fetch(url, { headers: { ...headers, "x-forwarded-for": "127.0.0.1" } })).status).toBe(404);
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(report);
  });

  it.each(["/launcher/sessions", LAUNCHER_EXECUTION_CATALOG_PATH])("clears persisted Executions through %s without adding an MCP tool", async (cleanupPath) => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-launcher-catalog-"));
    temporaryDirectories.push(workspace);
    const secondary = join(workspace, "secondary");
    await mkdir(secondary);
    const registry = new WorkspaceRegistry([{
      id: "catalog-workspace",
      name: "Catalog Workspace",
      path: workspace,
    }, {
      id: "secondary-workspace", name: "Secondary", path: secondary,
    }]);
    const tasks = new TaskContextService(workspace);
    const executions = new ExecutionContextService(workspace);
    await tasks.createTaskContext({
      task_id: "task-cleanup",
      workspace_id: "catalog-workspace",
    });
    await executions.createExecutionContext({
      execution_id: "execution-cleanup",
      task_id: "task-cleanup",
      workspace_id: "catalog-workspace",
    });
    await executions.updateExecutionContext("catalog-workspace", "task-cleanup", "execution-cleanup", {
      status: "passed",
    });
    await tasks.createTaskContext({ task_id: "task-interactive", workspace_id: "catalog-workspace" });
    await executions.createExecutionContext({
      execution_id: "execution-interactive", task_id: "task-interactive", workspace_id: "catalog-workspace", status: "passed",
    });
    const goal = goalOrchestrationSchema.parse({
      goal_id: "goal-interactive", workspace_id: "catalog-workspace", conversation_id: "conversation-1",
      execution_mode: "interactive", status: "completed", current_task_id: "task-interactive",
      current_phase_id: "phase-1", actuation_id: "actuation-1", loop_id: "loop-1",
      execution_id: "execution-interactive", phases: [{
        phase_id: "phase-1", objective: "Cleanup", status: "completed", tasks: [{
          task_id: "task-interactive", goal: "Cleanup", requirements: ["Cleanup"],
          acceptance_criteria: ["Cleanup"], max_iterations: 1,
        }],
      }], created_at: "2026-09-15T00:00:00.000Z", updated_at: "2026-09-15T00:00:00.000Z",
    });
    const sessions = new SessionStore(workspace);
    await sessions.createSession({
      session_id: "session-interactive", goal_id: goal.goal_id, task_id: "task-interactive",
      backend_type: "desktop_codex_app", status: "completed", workspace,
      thread_id: "thread-interactive",
    });
    const events = new EventStore(workspace);
    await events.appendEvent({
      session_id: "session-interactive", execution_id: "execution-interactive", event_type: "session_started",
      thread_id: "thread-interactive",
      timestamp: "2026-09-15T00:00:00.000Z", payload: {},
    });
    await tasks.createTaskContext({
      task_id: "task-other-workspace",
      workspace_id: "other-workspace",
    });
    await executions.createExecutionContext({
      execution_id: "execution-other-workspace",
      task_id: "task-other-workspace",
      workspace_id: "other-workspace",
    });
    await executions.updateExecutionContext(
      "other-workspace", "task-other-workspace", "execution-other-workspace", { status: "failed" },
    );
    await tasks.createTaskContext({ task_id: "task-secondary", workspace_id: "secondary-workspace" });
    await executions.createExecutionContext({
      execution_id: "execution-secondary", task_id: "task-secondary", workspace_id: "secondary-workspace", status: "failed",
    });
    await executions.createExecutionContext({
      execution_id: "execution-running", task_id: "task-secondary", workspace_id: "secondary-workspace",
    });
    const server = createHttpServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    }, {
      registry,
      statusQuery: new StatusQueryService({
        storageRoot: workspace,
        goals: { getGoal: async (id) => id === goal.goal_id ? goal : null, listGoals: async () => [goal] },
      }),
      browserReadiness: extensionDeliveryReadiness,
    });
    runningServers.push(server);
    const port = await listen(server);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/launcher/sessions`);
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`http://127.0.0.1:${port}/launcher/sessions`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sessions: [] });
    const beforeCleanup = await fetch(`http://127.0.0.1:${port}${LAUNCHER_EXECUTION_CATALOG_PATH}`, {
      headers: { authorization: "Bearer test-token" },
    });
    expect((await beforeCleanup.json()).executions).toHaveLength(4);

    const readinessUrl = `http://127.0.0.1:${port}/launcher/readiness`;
    const headers = { authorization: "Bearer test-token" };
    expect((await fetch(readinessUrl)).status).toBe(401);
    expect((await fetch(readinessUrl, { method: "POST", headers })).status).toBe(405);
    expect((await fetch(readinessUrl, { headers: { ...headers, "x-forwarded-for": "127.0.0.1" } })).status).toBe(404);
    expect((await fetch(readinessUrl, { headers: { ...headers, "cf-connecting-ip": "127.0.0.1" } })).status).toBe(404);
    const readiness = async () => {
      const response = await fetch(readinessUrl, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return response.json();
    };
    try {
      await stopBridge();
      expect(await readiness()).toMatchObject({ ready: false, readiness_state: "bridge_unavailable",
        bridge_available: false, extension_paired: false, extension_present: false, last_seen_at: null });
      await startBridge({ ports: [0] });
      expect(await readiness()).toMatchObject({ ready: false, readiness_state: "extension_not_paired",
        reason: "Extension is not paired.", action: expect.stringContaining("刷新 ChatGPT 页面") });
      const pair = await fetch(`http://127.0.0.1:${bridgePort()}/pair`, {
        method: "POST", headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
          "x-lrm-bridge-protocol": "3" }, body: "{}",
      });
      expect(pair.status).toBe(200);
      const ready = await readiness();
      expect(ready).toEqual({ ready: true, readiness_state: "ready", bridge_available: true,
        extension_paired: true, extension_present: true, last_seen_at: expect.any(Number), reason: null, action: null });
      vi.spyOn(Date, "now").mockReturnValue(ready.last_seen_at + EXTENSION_PRESENCE_TIMEOUT_MS);
      expect(await readiness()).toMatchObject({ ready: false, readiness_state: "extension_not_present",
        extension_paired: true, extension_present: false, reason: "Extension is not connected." });
    } finally {
      vi.restoreAllMocks();
      await stopBridge();
    }

    const cleanupUrl = `http://127.0.0.1:${port}${cleanupPath}`;
    expect((await fetch(cleanupUrl, { method: "DELETE" })).status).toBe(401);
    expect((await fetch(cleanupUrl, {
      method: "DELETE", headers: { authorization: "Bearer test-token", "x-forwarded-for": "127.0.0.1" },
    })).status).toBe(404);
    const cleanup = await fetch(cleanupUrl, {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    });
    expect(cleanup.status).toBe(200);
    await expect(cleanup.json()).resolves.toEqual({
      deleted: true,
      deleted_executions: cleanupPath === LAUNCHER_EXECUTION_CATALOG_PATH ? 3 : 2,
      deleted_sessions: 1,
      deleted_events: 1,
      deleted_tasks: 2,
    });
    const dashboard = await fetch(`http://127.0.0.1:${port}${LAUNCHER_EXECUTION_CATALOG_PATH}`, {
      headers: { authorization: "Bearer test-token" },
    });
    const remaining = (await dashboard.json()).executions;
    expect(remaining.map((execution: { execution_id: string }) => execution.execution_id).sort()).toEqual(
      cleanupPath === LAUNCHER_EXECUTION_CATALOG_PATH
        ? ["execution-running"] : ["execution-running", "execution-secondary"],
    );
    await expect(executions.getExecutionContext(
      "secondary-workspace", "task-secondary", "execution-running",
    )).resolves.toMatchObject({ status: "running" });
    await expect(tasks.getTaskContext("task-secondary")).resolves.not.toBeNull();
    await expect(sessions.getSession("session-interactive")).resolves.toBeNull();
    await expect(events.listEvents("session-interactive")).resolves.toEqual([]);
    await expect(tasks.getTaskContext("task-interactive")).resolves.toBeNull();
    await expect(executions.getExecutionContext(
      "other-workspace", "task-other-workspace", "execution-other-workspace",
    )).resolves.toMatchObject({ status: "failed" });
  });

  it("serves the authenticated loopback launcher Execution catalog inside the Workspace scope", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-launcher-executions-"));
    temporaryDirectories.push(workspace);
    const registry = new WorkspaceRegistry([{
      id: "catalog-workspace",
      name: "Catalog Workspace",
      path: workspace,
    }]);
    const executions = new ExecutionContextService(workspace);
    await executions.createExecutionContext({
      execution_id: "execution-1",
      task_id: "task-1",
      workspace_id: "catalog-workspace",
      command: "codex exec --json -",
    });
    // A stale record from a workspace this runtime does not serve must stay out of the catalog.
    await executions.createExecutionContext({
      execution_id: "execution-2",
      task_id: "task-2",
      workspace_id: "unregistered-workspace",
    });
    const server = createHttpServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    }, {
      registry,
      statusQuery: new StatusQueryService({ storageRoot: workspace }),
    });
    runningServers.push(server);
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}${LAUNCHER_EXECUTION_CATALOG_PATH}`;
    const headers = { authorization: "Bearer test-token" };

    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers })).status).toBe(405);
    expect((await fetch(url, { headers: { ...headers, "x-forwarded-for": "127.0.0.1" } })).status).toBe(404);
    expect((await fetch(url, { headers: { ...headers, "cf-connecting-ip": "127.0.0.1" } })).status).toBe(404);

    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const catalog = await response.json() as { executions: Array<Record<string, unknown>> };
    expect(catalog.executions.map((execution) => execution.execution_id)).toEqual(["execution-1"]);
    expect(catalog.executions[0]).toEqual({
      execution_id: "execution-1",
      execution_mode: "batch",
      backend: "cli",
      workspace_id: "catalog-workspace",
      task_id: "task-1",
      name: "task-1",
      task_name: "task-1",
      status: "running",
      started_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it("serves the authenticated loopback Desktop Sync status without exposing the Set", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-launcher-desktop-sync-"));
    temporaryDirectories.push(workspace);
    const registry = new WorkspaceRegistry([{
      id: "desktop-sync-workspace",
      name: "Desktop Sync Workspace",
      path: workspace,
    }]);
    let state: DesktopSyncState = { connected: false, followingThreads: new Set() };
    const server = createHttpServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    }, {
      registry,
      desktopSyncObserver: { getState: () => state },
    });
    runningServers.push(server);
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/launcher/desktop-sync`;
    const headers = { authorization: "Bearer test-token" };

    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers })).status).toBe(405);
    expect((await fetch(url, { headers: { ...headers, "x-forwarded-for": "127.0.0.1" } })).status).toBe(404);

    state = {
      connected: true,
      currentConversationId: "conversation-1",
      followingThreads: new Set(["thread-2", "conversation-1"]),
      ownerClientId: "desktop-1",
      lastEventTime: "2026-09-19T01:09:59.933Z",
    };
    const connected = await fetch(url, { headers });
    expect(connected.status).toBe(200);
    expect(connected.headers.get("cache-control")).toBe("no-store");
    await expect(connected.json()).resolves.toEqual({
      connected: true,
      currentConversationId: "conversation-1",
      following: true,
      followingThreads: ["conversation-1", "thread-2"],
      ownerClientId: "desktop-1",
      lastEventTime: "2026-09-19T01:09:59.933Z",
    });

    state = {
      connected: false,
      followingThreads: new Set(),
      lastEventTime: "2026-09-19T01:09:59.933Z",
    };
    await expect((await fetch(url, { headers })).json()).resolves.toEqual({
      connected: false,
      currentConversationId: null,
      following: null,
      followingThreads: [],
      ownerClientId: null,
      lastEventTime: "2026-09-19T01:09:59.933Z",
    });
  });

  it("serves the DesktopSyncManager state while preserving loopback auth and no-store", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-launcher-desktop-manager-"));
    temporaryDirectories.push(workspace);
    const registry = new WorkspaceRegistry([{
      id: "desktop-manager-workspace",
      name: "Desktop Manager Workspace",
      path: workspace,
    }]);
    const server = createHttpServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    }, {
      registry,
      desktopSyncManager: {
        getState: async () => ({
          mode: "auto" as const,
          activeSource: "desktop_ipc" as const,
          connected: true,
          currentConversationId: "thread-A",
          following: true,
          followingThreads: ["thread-A"],
          ownerClientId: "desktop-1",
          lastEventTime: "2026-09-19T01:09:59.933Z",
          associationStatus: "unmatched" as const,
          associationReason: null,
          fallbackReason: null,
          sessionId: null,
          goalId: null,
          taskId: null,
          executionId: null,
          threadId: null,
        }),
      },
    });
    runningServers.push(server);
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/launcher/desktop-sync`;
    const response = await fetch(url, { headers: { authorization: "Bearer test-token" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      mode: "auto",
      activeSource: "desktop_ipc",
      associationStatus: "unmatched",
      fallbackReason: null,
    });
  });

  it("starts and disposes the Desktop IPC observer with the runtime lifecycle", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-desktop-sync-lifecycle-"));
    temporaryDirectories.push(workspace);
    const settings = {
      host: "127.0.0.1" as const,
      port: await getFreePort(),
      workspace,
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    };
    const observer = {
      start: vi.fn(),
      stop: vi.fn(),
      dispose: vi.fn(),
      getState: vi.fn((): DesktopSyncState => ({ connected: false, followingThreads: new Set() })),
    };
    const server = await startApp(settings, undefined, { bridgePorts: [], desktopSyncObserver: observer, silent: true });
    expect(observer.start).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const index = runningServers.indexOf(server);
    if (index >= 0) runningServers.splice(index, 1);
    expect(observer.dispose).toHaveBeenCalledTimes(1);
  });

  it("propagates the normalized request id into an MCP tool call", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-inbound-http-"));
    temporaryDirectories.push(workspace);
    const baseRegistry = new WorkspaceRegistry([{
      id: "inbound-workspace",
      name: "Inbound Workspace",
      path: workspace,
    }]);
    const seen: Array<string | null> = [];
    const registry = new Proxy(baseRegistry, {
      get(target, property, receiver) {
        if (property !== "resolve") return Reflect.get(target, property, receiver);
        return (workspaceId?: string) => {
          seen.push(inboundRequestId());
          return target.resolve(workspaceId);
        };
      },
    }) as WorkspaceRegistry;
    const server = createHttpServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    }, { registry });
    runningServers.push(server);
    const port = await listen(server);
    const client = new Client({ name: "inbound-http-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      {
        requestInit: {
          headers: {
            authorization: "Bearer test-token",
            "x-request-id": "wfr_ingress/relay-hop",
          },
        },
      },
    );

    await client.connect(transport);
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ request_id: "wfr_ingress" });
    expect(seen).toEqual(["wfr_ingress"]);
    await client.close();
    expect(inboundRequestId()).toBeNull();
  });

  it("initializes, lists tools, and serves all workspace tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-http-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "README.md"), "# Review\n");
    await writeFile(join(workspace, "src", "app.ts"), "export const app = true;\n");

    const workspaceIdentity = {
      id: "runtime-workspace",
      name: "Runtime Workspace",
      path: workspace,
    } as const;
    const settings = {
      host: "127.0.0.1" as const,
      port: await getFreePort(),
      workspace,
      workspaceIdentity,
      workspaces: [workspaceIdentity],
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
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
    expect(result.tools).toHaveLength(21);
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_REGISTERED_TOOL_NAMES].sort());

    const infoCall = await client.callTool({ name: "workspace_info", arguments: {} });
    expect(infoCall.isError).not.toBe(true);
    const info = JSON.parse(toolText(infoCall)) as Record<string, unknown>;
    expect(info).toMatchObject({
      root_alias: "workspace:/",
      workspace_id: workspaceIdentity.id,
      workspace_name: workspaceIdentity.name,
    });
    expect(JSON.stringify(info)).not.toContain(workspace);

    const listCall = await client.callTool({ name: "list_files", arguments: {} });
    expect(listCall.isError).not.toBe(true);
    const listing = structuredJson(listCall) as {
      entries: { path: string; type: string }[];
    };
    expect(listing.entries).toEqual([
      { path: "README.md", name: "README.md", type: "file" },
      { path: "src", name: "src", type: "directory" },
    ]);

    const readCall = await client.callTool({ name: "read_file", arguments: { path: "src/app.ts" } });
    expect(readCall.isError).not.toBe(true);
    expect(structuredJson(readCall)).toMatchObject({
      path: "src/app.ts",
      content: "export const app = true;",
    });

    const searchCall = await client.callTool({ name: "search_text", arguments: { query: "app" } });
    expect(searchCall.isError).not.toBe(true);
    expect(structuredJson(searchCall)).toMatchObject({
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
