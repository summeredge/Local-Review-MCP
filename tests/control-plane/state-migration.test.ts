import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAppContext, startApp } from "../../src/app.js";
import { ActuationAuthorizationStore, ControlledActuationService, controlledActuationStateFile } from "../../src/control-plane/controlled-actuation.js";
import { GoalOrchestrationService, goalOrchestrationStateFile } from "../../src/control-plane/goal-orchestration.js";
import { GoalSubmissionService } from "../../src/control-plane/goal-submission.js";
import { autoIterationSchema, type AutoIteration, type AutoIterationStartInput } from "../../src/control-plane/auto-iteration.js";
import type { ExecutionBackendStartRequest } from "../../src/control-plane/execution-service.js";
import { TaskContextService } from "../../src/context/service.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";
import type { DesktopSyncState } from "../../src/desktop-sync/desktop-sync-state.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const timestamp = "2026-09-10T00:00:00.000Z";
const authorization = {
  authorization_id: "11111111-1111-4111-8111-111111111111", actuation_id: "legacy-actuation",
  workspace_id: "workspace-a", task_id: "legacy-task", execution_id: "legacy-execution",
  instruction: "historical instruction", status: "consumed", created_at: timestamp,
};
const actuation = {
  actuation_id: authorization.actuation_id, authorization_id: authorization.authorization_id,
  workspace_id: authorization.workspace_id, task_id: authorization.task_id, execution_id: authorization.execution_id,
  status: "started", created_at: timestamp, updated_at: timestamp,
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lrm-migration-test-")); roots.push(root);
  await mkdir(join(root, "control-plane")); await mkdir(join(root, "workspace"));
  const registry = new WorkspaceRegistry([{ id: "workspace-a", name: "Test", path: join(root, "workspace") }]);
  const file = controlledActuationStateFile(root);
  const raw = JSON.stringify({ schema_version: 1, authorizations: [authorization], actuations: [actuation] });
  await writeFile(file, raw);
  return { root, registry, file, raw, store: new ActuationAuthorizationStore(root) };
}
const plan = {
  goal_id: "legacy-goal", workspace_id: "workspace-a", conversation_id: "conversation-a",
  phases: [{ phase_id: "phase-a", objective: "Legacy goal", tasks: [{ task_id: "legacy-task", goal: "Check",
    requirements: ["Check"], acceptance_criteria: ["Checked"], max_iterations: 1 }], status: "pending" }],
  status: "pending", created_at: timestamp, updated_at: timestamp,
};

it("backs up exact legacy bytes, preserves identities and status, and migrates only once", async () => {
  const f = await fixture();
  await f.store.restore();
  expect(await f.store.getAuthorization(authorization.authorization_id)).toEqual({ ...authorization, execution_mode: "batch" });
  expect(await f.store.getActuation(actuation.actuation_id)).toEqual(actuation);
  const migrated = await readFile(f.file, "utf8");
  expect(JSON.parse(migrated).schema_version).toBe(2);
  const backups = (await readdir(join(f.root, "control-plane"))).filter((file) => file.endsWith(".bak"));
  expect(backups).toHaveLength(1);
  expect(await readFile(join(f.root, "control-plane", backups[0]), "utf8")).toBe(f.raw);
  await new ActuationAuthorizationStore(f.root).restore();
  expect(await readFile(f.file, "utf8")).toBe(migrated);
  expect((await readdir(join(f.root, "control-plane"))).filter((file) => file.endsWith(".bak"))).toEqual(backups);
  expect((await readdir(join(f.root, "control-plane"))).some((file) => file.endsWith(".tmp"))).toBe(false);
});

it("uses matching Goal evidence and safely blocks contradictory execution evidence", async () => {
  const f = await fixture();
  await writeFile(f.file, JSON.stringify({ schema_version: 1,
    authorizations: [{ ...authorization, goal_id: plan.goal_id }], actuations: [actuation] }));
  await writeFile(goalOrchestrationStateFile(f.root), JSON.stringify({ schema_version: 1,
    goals: [{ ...plan, execution_mode: "interactive" }] }));
  await f.store.restore();
  expect(await f.store.getAuthorization(authorization.authorization_id)).toMatchObject({ execution_mode: "interactive" });
  await writeFile(f.file, f.raw);
  // Bind the legacy Goal through its actuation checkpoint for this recovery case.
  await writeFile(goalOrchestrationStateFile(f.root), JSON.stringify({ schema_version: 1,
    goals: [{ ...plan, execution_mode: "interactive", actuation_id: authorization.actuation_id }] }));
  await new ExecutionContextService(f.root).createExecutionContext({ workspace_id: authorization.workspace_id,
    task_id: authorization.task_id, execution_id: authorization.execution_id, command: "codex exec --json -" });
  const conflicted = new ActuationAuthorizationStore(f.root);
  await conflicted.restore();
  const restored = await conflicted.getAuthorization(authorization.authorization_id);
  expect(restored).toMatchObject({ status: "consumed", replay_blocked_reason: "Legacy Goal and execution modes disagree" });
  const start = vi.fn();
  const service = new ControlledActuationService(f.registry, { storageRoot: f.root, authorizationStore: conflicted, adapter: { start } });
  await expect(service.actuate({ actuation_id: actuation.actuation_id, authorization_id: authorization.authorization_id })).rejects.toThrow("cannot be replayed");
  await expect(conflicted.reserveActuation({ actuation_id: actuation.actuation_id, authorization_id: authorization.authorization_id })).rejects.toThrow("cannot be replayed");
  expect(start).not.toHaveBeenCalled();
  expect(await conflicted.getActuation(actuation.actuation_id)).toEqual(actuation);
});

it("infers an interactive historical execution and blocks an unknown backend without dropping records", async () => {
  for (const command of ["desktop codex_app", "unrecognized backend"]) {
    const f = await fixture();
    await new ExecutionContextService(f.root).createExecutionContext({ workspace_id: authorization.workspace_id,
      task_id: authorization.task_id, execution_id: authorization.execution_id, command });
    await f.store.restore();
    expect(await f.store.getAuthorization(authorization.authorization_id)).toMatchObject(command === "desktop codex_app"
      ? { execution_mode: "interactive", status: "consumed" }
      : { replay_blocked_reason: "Legacy execution backend is unknown", status: "consumed" });
  }
});

it("reports exact corrupt fields without rewriting and retries restore after the file is repaired", async () => {
  const f = await fixture();
  const corrupt = JSON.stringify({ schema_version: 1, authorizations: [{ ...authorization, execution_mode: "invalid" }], actuations: [actuation] });
  await writeFile(f.file, corrupt);
  await expect(f.store.restore()).rejects.toThrow(/authorizations\.0\.execution_mode/);
  expect(await readFile(f.file, "utf8")).toBe(corrupt);
  expect((await readdir(join(f.root, "control-plane"))).filter((file) => file.endsWith(".bak"))).toEqual([]);
  await writeFile(f.file, f.raw);
  await expect(f.store.restore()).resolves.toBeUndefined();
  const migrated = JSON.parse(await readFile(f.file, "utf8"));
  delete migrated.authorizations[0].execution_mode;
  await writeFile(f.file, JSON.stringify(migrated));
  await expect(new ActuationAuthorizationStore(f.root).restore()).rejects.toThrow(/authorizations\.0\.execution_mode/);
  await expect(f.store.createAuthorization({ ...authorization, actuation_id: "new-actuation" } as never)).rejects.toThrow();
});

it("migrates missing legacy Goal modes, backs up before writing, and rejects corrupt v2 Goals", async () => {
  const f = await fixture(); const file = goalOrchestrationStateFile(f.root);
  const raw = JSON.stringify({ schema_version: 1, goals: [plan] }); await writeFile(file, raw);
  const service = new GoalOrchestrationService(f.registry, { storageRoot: f.root });
  await service.restore();
  expect(await service.getGoal(plan.goal_id)).toEqual({ ...plan, execution_mode: "batch" });
  const migrated = await readFile(file, "utf8");
  await new GoalOrchestrationService(f.registry, { storageRoot: f.root }).restore();
  expect(await readFile(file, "utf8")).toBe(migrated);
  const backups = (await readdir(join(f.root, "control-plane"))).filter((name) => name.startsWith("goal-orchestrations.json.v1-"));
  expect(backups).toHaveLength(1); expect(await readFile(join(f.root, "control-plane", backups[0]), "utf8")).toBe(raw);
  await writeFile(file, JSON.stringify({ schema_version: 2, goals: [plan] }));
  await expect(new GoalOrchestrationService(f.registry, { storageRoot: f.root }).restore()).rejects.toThrow("goals.0.execution_mode");
});

it("starts a new default interactive Goal in the presence of legacy authorizations", async () => {
  const f = await fixture(); const tasks = new TaskContextService(f.root); const executions = new ExecutionContextService(f.root);
  const start = vi.fn(async (input: ExecutionBackendStartRequest) => {
    const execution = await executions.createExecutionContext({ workspace_id: input.workspace_id, task_id: input.task_id,
      execution_id: input.execution_id, process_id: 8100 });
    return { execution_id: execution.execution_id, process_id: 8100, started_at: execution.started_at, accepted: "new" as const };
  });
  const controlled = new ControlledActuationService(f.registry, { storageRoot: f.root, authorizationStore: f.store, adapter: { start } });
  const loops = new Map<string, AutoIteration>();
  const auto = { getLoop: async (id: string) => loops.get(id) ?? null, advance: async (id: string) => loops.get(id)!,
    start: async (input: AutoIterationStartInput) => {
      const loop = autoIterationSchema.parse({ ...input, initial_execution_id: input.execution_id, iteration: 1, stage: "execution", created_at: timestamp, updated_at: timestamp });
      loops.set(input.loop_id, loop); return loop;
    } };
  const orchestration = new GoalOrchestrationService(f.registry, { storageRoot: f.root, authorizationStore: f.store, controlledActuation: controlled, autoIteration: auto });
  const submit = new GoalSubmissionService(orchestration, { checkGoalPreflight: async () => ({ ready: true } as never) });
  const result = await submit.submitExternalGoal({ workspace_id: "workspace-a", conversation_id: "conversation-a",
    title: "New goal", goal: "Check migration", requirements: ["Keep history"], acceptance_criteria: ["Start"], max_iterations: 1 });
  expect(result).toMatchObject({ status: "running", start_confirmed: true });
  expect(start).toHaveBeenCalledOnce(); expect(start.mock.calls[0][0].execution_mode).toBe("interactive");
  expect(await tasks.getTaskContext(result.task_id)).not.toBeNull();
  expect(await f.store.getAuthorizationByExecution("workspace-a", result.task_id, result.execution_id)).toMatchObject({ execution_mode: "interactive", status: "consumed" });
  expect(await f.store.getAuthorization(authorization.authorization_id)).toMatchObject({ execution_mode: "batch", status: "consumed" });
});

it("keeps runtime preflight blocked and skips Goal recovery when a critical store is corrupt", async () => {
  const f = await fixture();
  const settings = { host: "127.0.0.1" as const, port: 0, workspace: join(f.root, "workspace"),
    auth: { token: "test-token" }, remote: { enabled: false }, supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 } };
  const app = createAppContext(settings, { ...process.env, LOCALAPPDATA: f.root, XDG_STATE_HOME: f.root });
  await mkdir(join(app.storageRoot!, "control-plane"), { recursive: true });
  await writeFile(controlledActuationStateFile(app.storageRoot!), "{broken");
  const recover = vi.spyOn(app.goalOrchestration!, "recover");
  const observer = { start: vi.fn(), stop: vi.fn(), dispose: vi.fn(), getState: (): DesktopSyncState => ({ connected: false, followingThreads: new Set() }) };
  const server = await startApp(settings, app, { bridgePorts: [], desktopSyncObserver: observer, silent: true });
  try {
    const result = await app.goalPreflight!.checkGoalPreflight({ workspace_id: app.registry.active.id, conversation_id: "conversation-a", execution_mode: "interactive" });
    expect(result).toMatchObject({ ready: false, failure_stage: "runtime", failure_reason: expect.stringContaining("invalid JSON") });
    expect(recover).not.toHaveBeenCalled();
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
