import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionContextService } from "../src/context/execution-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeStorageRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-execution-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("ExecutionContextService", () => {
  it("creates and persists an execution context", async () => {
    const storageRoot = await makeStorageRoot();
    const service = new ExecutionContextService(storageRoot);

    const execution = await service.createExecutionContext({
      execution_id: "exec-001",
      task_id: "task-001",
      workspace_id: "workspace-a",
    });

    expect(execution).toMatchObject({
      execution_id: "exec-001",
      task_id: "task-001",
      workspace_id: "workspace-a",
      status: "running",
    });
    expect(execution.started_at).toBeTruthy();
    expect(execution.finished_at).toBeUndefined();
    expect(JSON.parse(await readFile(
      join(storageRoot, ".task", "executions", "workspace-a", "task-001", "exec-001.json"),
      "utf8",
    ))).toEqual(execution);
  });

  it("loads a persisted execution after a service restart", async () => {
    const storageRoot = await makeStorageRoot();
    const created = await new ExecutionContextService(storageRoot).createExecutionContext({
      execution_id: "exec-001",
      task_id: "task-001",
      workspace_id: "workspace-a",
      command: "npm test",
    });

    const reloaded = await new ExecutionContextService(storageRoot).getExecutionContext(
      "workspace-a",
      "task-001",
      "exec-001",
    );
    expect(reloaded).toEqual(created);
  });

  it("updates status to passed and records a summary", async () => {
    const service = new ExecutionContextService(await makeStorageRoot());
    const created = await service.createExecutionContext({
      execution_id: "exec-001",
      task_id: "task-001",
      workspace_id: "workspace-a",
      command: "npm test",
    });

    const updated = await service.updateExecutionContext(
      "workspace-a",
      "task-001",
      "exec-001",
      { status: "passed", summary: "170 tests passed" },
    );

    expect(updated).toMatchObject({
      execution_id: "exec-001",
      task_id: "task-001",
      workspace_id: "workspace-a",
      status: "passed",
      command: "npm test",
      summary: "170 tests passed",
      started_at: created.started_at,
    });
    expect(updated.finished_at).toBeTruthy();
  });

  it("allows multiple executions for one task", async () => {
    const service = new ExecutionContextService(await makeStorageRoot());
    await service.createExecutionContext({
      execution_id: "exec-001",
      task_id: "task-001",
      workspace_id: "workspace-a",
    });
    await service.createExecutionContext({
      execution_id: "exec-002",
      task_id: "task-001",
      workspace_id: "workspace-a",
      command: "npm test",
    });

    expect((await service.listExecutions("workspace-a", "task-001"))
      .map(({ execution_id }) => execution_id))
      .toEqual(["exec-001", "exec-002"]);
  });

  it("does not mix executions across workspaces", async () => {
    const service = new ExecutionContextService(await makeStorageRoot());
    await service.createExecutionContext({
      execution_id: "exec-001",
      task_id: "task-001",
      workspace_id: "workspace-a",
    });
    await service.createExecutionContext({
      execution_id: "exec-001",
      task_id: "task-001",
      workspace_id: "workspace-b",
    });

    expect(await service.listExecutions("workspace-a", "task-001")).toHaveLength(1);
    expect(await service.listExecutions("workspace-b", "task-001")).toHaveLength(1);
    expect((await service.getExecutionContext("workspace-a", "task-001", "exec-001"))
      ?.workspace_id).toBe("workspace-a");
    expect((await service.getExecutionContext("workspace-b", "task-001", "exec-001"))
      ?.workspace_id).toBe("workspace-b");
  });
});
