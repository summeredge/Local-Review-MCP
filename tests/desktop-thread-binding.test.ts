import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { desktopThreadBindingFile } from "../src/desktop-codex/desktop-thread-binding.js";
import type { DesktopThreadBinding } from "../src/desktop-codex/desktop-thread-binding.js";
import { DesktopThreadBindingStore } from "../src/desktop-codex/desktop-thread-binding-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function binding(overrides: Partial<DesktopThreadBinding> = {}): DesktopThreadBinding {
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

function store(): DesktopThreadBindingStore {
  const root = mkdtempSync(join(tmpdir(), "desktop-thread-binding-"));
  roots.push(root);
  return new DesktopThreadBindingStore(root);
}

describe("DesktopThreadBindingStore", () => {
  it("creates and loads a binding", async () => {
    const current = store();
    const expected = binding();

    await expect(current.createIfAbsent(expected)).resolves.toEqual(expected);
    await expect(current.load(expected.workspace_id, expected.session_id)).resolves.toEqual(expected);
  });

  it("returns the existing binding idempotently without rewriting it", async () => {
    const current = store();
    const first = binding();
    await current.createIfAbsent(first);
    const file = desktopThreadBindingFile(current.storageRoot, first.workspace_id, first.session_id);
    const before = readFileSync(file, "utf8");

    const second = await current.createIfAbsent(binding({
      created_at: "2026-09-21T00:00:00.000Z",
      updated_at: "2026-09-21T00:00:00.000Z",
    }));

    expect(second).toEqual(first);
    expect(second.created_at).toBe(first.created_at);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(join(current.storageRoot, ".task", "desktop_thread_bindings", first.workspace_id))).toEqual([
      `${first.session_id}.json`,
    ]);
  });

  it("concurrently creates one complete binding for the same identity", async () => {
    const current = store();
    const expected = binding();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => current.createIfAbsent(expected)),
    );
    const file = desktopThreadBindingFile(current.storageRoot, expected.workspace_id, expected.session_id);

    expect(results).toHaveLength(8);
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(expected))).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(expected);
    await expect(current.load(expected.workspace_id, expected.session_id)).resolves.toEqual(expected);
    expect(readdirSync(join(current.storageRoot, ".task", "desktop_thread_bindings", expected.workspace_id))).toEqual([
      `${expected.session_id}.json`,
    ]);
  });

  it.each([
    [
      "target_thread_id",
      binding({ target_thread_id: "target-thread-a" }),
      binding({ target_thread_id: "target-thread-b" }),
    ],
    [
      "host_id",
      binding({ host_id: "host-a" }),
      binding({ host_id: "host-b" }),
    ],
  ])("lets only one concurrent %s binding win", async (_field, left, right) => {
    const current = store();
    const outcomes = await Promise.allSettled([
      current.createIfAbsent(left),
      current.createIfAbsent(right),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<DesktopThreadBinding> => outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    const winner = fulfilled[0]?.value;

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(winner).toBeDefined();
    expect([left.target_thread_id, right.target_thread_id]).toContain(winner!.target_thread_id);
    expect([left.host_id, right.host_id]).toContain(winner!.host_id);
    const loaded = await current.load(left.workspace_id, left.session_id);
    expect(loaded).toEqual(winner);
    expect(JSON.parse(readFileSync(
      desktopThreadBindingFile(current.storageRoot, left.workspace_id, left.session_id),
      "utf8",
    ))).toEqual(winner);
  });

  it.each([
    ["target_thread_id", { target_thread_id: "target-thread-2" }],
    ["host_id", { host_id: "remote-host" }],
  ])("rejects a conflicting %s", async (_field, overrides) => {
    const current = store();
    const first = binding();
    await current.createIfAbsent(first);

    await expect(current.createIfAbsent(binding(overrides))).rejects.toThrow(/conflicts/u);
    await expect(current.load(first.workspace_id, first.session_id)).resolves.toEqual(first);
  });

  it.each([
    ["workspace_id", { workspace_id: "" }],
    ["task_id", { task_id: "" }],
    ["session_id", { session_id: "" }],
    ["target_thread_id", { target_thread_id: "" }],
    ["host_id", { host_id: "" }],
    ["backend_identity", { backend_identity: "codex_app_server" }],
    ["schema_version", { schema_version: 2 }],
  ])("rejects invalid %s", async (_field, overrides) => {
    const current = store();

    await expect(current.createIfAbsent(
      binding(overrides as Partial<DesktopThreadBinding>),
    )).rejects.toThrow();
  });

  it("does not persist executorThreadId", async () => {
    const current = store();
    const created = await current.createIfAbsent(binding());

    expect(created).not.toHaveProperty("executorThreadId");
    expect(JSON.parse(readFileSync(
      desktopThreadBindingFile(current.storageRoot, created.workspace_id, created.session_id),
      "utf8",
    ))).not.toHaveProperty("executorThreadId");
  });
});
