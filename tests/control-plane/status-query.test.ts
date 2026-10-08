import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import { GoalOrchestrationUnavailableError } from "../../src/control-plane/goal-orchestration.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusQueryService, StatusQueryError } from "../../src/control-plane/status-query.js";
import { SessionStore } from "../../src/context/session-store.js";
import { createMcpServer, toToolError } from "../../src/mcp/server.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), "lrm-status-errors-")); roots.push(value); return value; }
function payload(error: unknown) { return JSON.parse(toToolError(error).content[0]!.text); }

describe("status query error classification", () => {
  it.each(["SESSION_NOT_FOUND", "EXECUTION_NOT_FOUND", "RUNTIME_UNAVAILABLE"] as const)("returns %s through the MCP protocol", async code => {
    const storageRoot = await root();
    const registry = new WorkspaceRegistry([{ id: "workspace-1", name: "Test", path: storageRoot }]);
    const server = createMcpServer({ registry, ...(code === "RUNTIME_UNAVAILABLE" ? {} : { statusQuery: new StatusQueryService({ storageRoot }) }) });
    const client = new Client({ name: "status-errors-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: code === "EXECUTION_NOT_FOUND" ? "get_execution_status" : "get_session_status", arguments: code === "EXECUTION_NOT_FOUND" ? { execution_id: "missing" } : { session_id: "missing" } });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ text: string }>;
      expect(JSON.parse(content[0]!.text)).toMatchObject({ error: code });
    } finally { await client.close(); await server.close(); }
  });

  it("classifies a recognized unavailable Goal runtime", async () => {
    const query = new StatusQueryService({ storageRoot: await root(), goals: { getGoal: async () => { throw new GoalOrchestrationUnavailableError("state could not be restored"); } } });
    expect(payload(await query.getSessionStatus({ goal_id: "goal-1" }).catch(error => error))).toMatchObject({ error: "RUNTIME_UNAVAILABLE" });
  });
  it.each(["session", "execution"] as const)("returns a structured missing %s error", async kind => {
    const query = new StatusQueryService({ storageRoot: await root() });
    const request = kind === "session" ? query.getSessionStatus("missing-session") : query.getExecutionStatus("missing-execution");
    const error = await request.catch(error => error);
    expect(error).toBeInstanceOf(StatusQueryError);
    expect(payload(error)).toMatchObject({ error: kind === "session" ? "SESSION_NOT_FOUND" : "EXECUTION_NOT_FOUND", message: expect.stringContaining("was not found") });
  });

  it("distinguishes identity conflict from runtime unavailability", async () => {
    const storageRoot = await root();
    const sessions = new SessionStore(storageRoot);
    await sessions.createSession({ session_id: "session-1", goal_id: "goal-1", task_id: "task-1", backend_type: "codex_app_server", workspace: "C:\\workspace", status: "created" });
    const query = new StatusQueryService({ storageRoot, sessions });
    expect(payload(await query.getSessionStatus({ session_id: "session-1", workspace_id: "wrong-workspace" }).catch(error => error))).toMatchObject({ error: "STATUS_CONFLICT" });
    expect(payload(await query.getSessionStatus({ goal_id: "goal-1" }).catch(error => error))).toMatchObject({ error: "RUNTIME_UNAVAILABLE" });
    const available = new StatusQueryService({ storageRoot, goals: { getGoal: async () => null } });
    expect(payload(await available.getSessionStatus({ goal_id: "missing-goal" }).catch(error => error))).toMatchObject({ error: "GOAL_NOT_FOUND" });
  });

  it("retains unknown failures in server diagnostics without exposing them", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("state JSON is corrupt");
    expect(payload(error)).toEqual({ error: "INTERNAL_ERROR" });
    expect(log).toHaveBeenCalledWith("MCP tool failed:", error);
  });
});
