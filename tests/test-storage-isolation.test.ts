import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppContext, startApp } from "../src/app.js";
import { defaultTaskContextStorageRoot } from "../src/context/task.js";
import { ExecutionContextService } from "../src/context/execution-service.js";
import { SessionStore } from "../src/context/session-store.js";
import { TaskContextService } from "../src/context/service.js";
import type { ResolvedSettings } from "../src/config/settings.js";

const temporaryDirectories: string[] = [];
const runningServers: Server[] = [];
// reconcileOrphanedExecutions() only terminates a running Execution recorded with this exact
// command, so the seeded orphan must carry it. Spelled literally, as the isolated orphan tests do.
const APP_SERVER_COMMAND = "codex app-server --listen stdio://";

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * A storage root holding the exact state the incident left behind: a production Codex app-server
 * Execution still running, and the Session that owns it still mid-turn.
 */
async function seedRunningProductionExecution(root: string): Promise<{
  readonly workspaceId: string;
  readonly sessionId: string;
}> {
  const workspaceId = "production-workspace";
  const taskId = "production-task";
  await new TaskContextService(root).createTaskContext({ task_id: taskId, workspace_id: workspaceId });
  const session = await new SessionStore(root).createSession({
    goal_id: "production-goal",
    task_id: taskId,
    backend_type: "codex_app_server",
    status: "active",
    workspace: root,
    thread_id: "production-thread",
  });
  await new SessionStore(root).updateSession(session.session_id, { status: "running_turn" });
  await new ExecutionContextService(root).createExecutionContext({
    execution_id: "production-execution",
    task_id: taskId,
    workspace_id: workspaceId,
    status: "running",
    process_id: 4242,
    command: APP_SERVER_COMMAND,
  });
  return { workspaceId, sessionId: session.session_id };
}

function settings(workspace: string): ResolvedSettings {
  return {
    host: "127.0.0.1",
    port: 0,
    workspace,
    auth: { token: "test-token" },
    remote: { enabled: false, endpoint: "" },
    supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
  };
}

describe("test runtime storage isolation", () => {
  it("keeps startup reconciliation away from another storage root's running Execution", async () => {
    const productionRoot = await makeDirectory("lrm-production-storage-");
    const seeded = await seedRunningProductionExecution(productionRoot);
    const workspace = await makeDirectory("lrm-test-runtime-workspace-");

    // No environment is passed: the test runtime must resolve its own storage root on its own,
    // which is exactly the path that previously inherited the real %LOCALAPPDATA%\LocalReviewMCP.
    const server = await startApp(settings(workspace), undefined, {
      bridgePorts: [],
      silent: true,
    });
    runningServers.push(server);

    // startApp() has already run reconcileOrphanedExecutions() by the time it resolves.
    const execution = await new ExecutionContextService(productionRoot)
      .getExecutionContext(seeded.workspaceId, "production-task", "production-execution");
    expect(execution).toMatchObject({ status: "running", process_id: 4242 });
    await expect(new SessionStore(productionRoot).getSession(seeded.sessionId))
      .resolves.toMatchObject({ status: "running_turn" });
    // The production storage received no failure summary and no new Event or Task record.
    expect(execution?.summary).toBeUndefined();
    await expect(readdir(join(productionRoot, ".task", "contexts")))
      .resolves.toHaveLength(1);
    await expect(readdir(join(productionRoot, ".task", "events")).catch(() => []))
      .resolves.toHaveLength(0);
    await expect(new ExecutionContextService(productionRoot)
      .listExecutions(seeded.workspaceId, "production-task")).resolves.toHaveLength(1);
  });

  it("resolves a test-local storage root that is not the production directory", async () => {
    const storageRoot = defaultTaskContextStorageRoot();
    const workspace = await makeDirectory("lrm-test-runtime-workspace-");
    const simulatedProductionRoot = await makeDirectory("lrm-production-storage-");

    // The runtime started by these tests resolves the default root itself, and that root is the
    // setup-provided temporary directory on every platform rather than a user's real storage.
    const context = createAppContext(settings(workspace));
    const server = await startApp(settings(workspace), context, { bridgePorts: [], silent: true });
    runningServers.push(server);

    expect(storageRoot).toContain("lrm-test-storage-");
    expect(context.storageRoot).toBe(storageRoot);
    // The isolation signature is the setup's own temp base, not any hardcoded per-platform path.
    expect(storageRoot.startsWith(join(tmpdir(), "lrm-test-storage-"))).toBe(true);
    // The test runtime and a simulated production root are two different storage locations.
    expect(storageRoot).not.toBe(simulatedProductionRoot);
    expect(context.storageRoot).not.toBe(simulatedProductionRoot);
    // The runtime really persisted into that root, so it is a live directory, not a bare string.
    await new TaskContextService(storageRoot)
      .createTaskContext({ task_id: "task-1", workspace_id: "workspace-1" });
    await expect(stat(join(storageRoot, ".task", "contexts"))).resolves.toBeDefined();
  });

  it("still reconciles orphans inside its own storage root", async () => {
    // Proves the fix is real filesystem isolation, not a mock that disables reconciliation: the
    // untouched reconcileOrphanedExecutions() still fails an orphan this runtime does own.
    const storageRoot = defaultTaskContextStorageRoot();
    const workspace = await makeDirectory("lrm-test-runtime-own-orphan-");
    const seeded = await seedRunningProductionExecution(storageRoot);

    const server = await startApp(settings(workspace), undefined, { bridgePorts: [], silent: true });
    runningServers.push(server);

    // The seeded orphan lives in this runtime's own root, so it is reconciled, which also proves
    // the runtime really does read and write that root rather than skipping persistence entirely.
    const reconciled = await new ExecutionContextService(storageRoot)
      .getExecutionContext(seeded.workspaceId, "production-task", "production-execution");
    expect(reconciled?.status).not.toBe("running");
  });
});
