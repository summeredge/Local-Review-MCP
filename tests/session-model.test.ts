import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/context/session-store.js";
import { sessionFile, sessionsDirectory } from "../src/context/session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeStorageRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-session-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("SessionStore", () => {
  it("generates a session id and starts in created status", async () => {
    const session = await new SessionStore(await makeStorageRoot()).createSession({
      goal_id: "goal-001",
      task_id: "task-001",
      backend_type: "cli",
      workspace: "C:\\workspace",
    });

    expect(session.session_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
    expect(session.status).toBe("created");
    expect(session.thread_id).toBeUndefined();
  });

  it("updates the session lifecycle and can read it back", async () => {
    const store = new SessionStore(await makeStorageRoot());
    const created = await store.createSession({
      session_id: "session-001",
      goal_id: "goal-001",
      task_id: "task-001",
      backend_type: "cli",
      workspace: "C:\\workspace",
    });

    const active = await store.updateSession(created.session_id, { status: "active" });
    const completed = await store.updateSession(created.session_id, { status: "completed" });

    expect(active.status).toBe("active");
    expect(completed.status).toBe("completed");
    expect(await store.getSession(created.session_id)).toEqual(completed);
  });

  it("accepts cli and codex_app_server backends", async () => {
    const store = new SessionStore(await makeStorageRoot());
    const cli = await store.createSession({
      session_id: "session-cli",
      goal_id: "goal-001",
      task_id: "task-001",
      backend_type: "cli",
      workspace: "C:\\workspace",
    });
    const appServer = await store.createSession({
      session_id: "session-app",
      goal_id: "goal-001",
      task_id: "task-001",
      backend_type: "codex_app_server",
      workspace: "C:\\workspace",
      thread_id: "thread-001",
      model_id: "model-a",
      reasoning_effort: "high",
    });

    expect((await store.listSessions()).map(({ backend_type }) => backend_type))
      .toEqual(["codex_app_server", "cli"]);
    expect(cli.backend_type).toBe("cli");
    expect(appServer.backend_type).toBe("codex_app_server");
    expect(appServer.thread_id).toBe("thread-001");
  });

  it("reads legacy session model fields as model_id", async () => {
    const root = await makeStorageRoot();
    await mkdir(sessionsDirectory(root), { recursive: true });
    await writeFile(sessionFile(root, "session-legacy"), JSON.stringify({
      session_id: "session-legacy",
      goal_id: "goal-001",
      task_id: "task-001",
      backend_type: "codex_app_server",
      status: "active",
      workspace: "C:\\workspace",
      model: "gpt-6-luna",
      reasoning_effort: "high",
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
    }));

    await expect(new SessionStore(root).getSession("session-legacy"))
      .resolves.toMatchObject({ model_id: "gpt-6-luna", reasoning_effort: "high" });
  });
});

it("adds an Execution association to legacy Sessions without allowing reassignment", async () => {
  const store = new SessionStore(await makeStorageRoot());
  const session = await store.createSession({ goal_id: "goal-1", task_id: "task-1", backend_type: "codex_app_server", workspace: "C:/workspace" });
  expect((await store.getSession(session.session_id))?.execution_id).toBeUndefined();
  await store.updateSession(session.session_id, { execution_id: "execution-1" });
  expect((await store.getSession(session.session_id))?.execution_id).toBe("execution-1");
  await expect(store.updateSession(session.session_id, { execution_id: "execution-2" })).rejects.toThrow("association cannot be changed");
  expect((await store.getSession(session.session_id))?.execution_id).toBe("execution-1");
});
