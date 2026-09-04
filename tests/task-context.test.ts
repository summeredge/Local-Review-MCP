import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskContextService } from "../src/context/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeStorageRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-task-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("TaskContextService", () => {
  it("creates and persists a task context", async () => {
    const storageRoot = await makeStorageRoot();
    const service = new TaskContextService(storageRoot);

    const context = await service.createTaskContext({
      task_id: "a",
      workspace_id: "workspace-a",
    });

    expect(context).toMatchObject({
      task_id: "a",
      workspace_id: "workspace-a",
      status: "pending",
    });
    expect(context.conversation_id).toBeUndefined();
    expect(JSON.parse(await readFile(join(storageRoot, ".task", "contexts", "a.json"), "utf8")))
      .toEqual(context);
  });

  it("loads persisted context after a service restart", async () => {
    const storageRoot = await makeStorageRoot();
    const created = await new TaskContextService(storageRoot).createTaskContext({
      task_id: "restartable-task",
      workspace_id: "workspace-a",
      status: "reviewing",
    });

    const reloaded = await new TaskContextService(storageRoot).getTaskContext("restartable-task");
    expect(reloaded).toEqual(created);
  });

  it("allows multiple tasks per workspace without a workspace conversation binding", async () => {
    const service = new TaskContextService(await makeStorageRoot());
    const first = await service.createTaskContext({
      task_id: "task-1",
      workspace_id: "workspace-a",
    });
    const second = await service.createTaskContext({
      task_id: "task-2",
      workspace_id: "workspace-a",
      conversation_id: "conversation-a",
    });
    const third = await service.createTaskContext({
      task_id: "task-3",
      workspace_id: "workspace-a",
      conversation_id: "conversation-b",
    });

    expect((await service.listTaskContexts()).map(({ task_id }) => task_id))
      .toEqual(["task-1", "task-2", "task-3"]);
    expect(first.conversation_id).toBeUndefined();
    expect(second.conversation_id).toBe("conversation-a");
    expect(third.conversation_id).toBe("conversation-b");
    expect((await service.getTaskContext("task-1"))?.workspace_id).toBe("workspace-a");
    expect((await service.getTaskContext("task-2"))?.workspace_id).toBe("workspace-a");
  });

  it("updates only lightweight task fields and preserves identity", async () => {
    const service = new TaskContextService(await makeStorageRoot());
    const created = await service.createTaskContext({
      task_id: "task-1",
      workspace_id: "workspace-a",
    });

    const updated = await service.updateTaskContext("task-1", {
      status: "completed",
      conversation_id: "conversation-a",
    });

    expect(updated).toMatchObject({
      task_id: created.task_id,
      workspace_id: created.workspace_id,
      conversation_id: "conversation-a",
      status: "completed",
      created_at: created.created_at,
    });
  });
});
