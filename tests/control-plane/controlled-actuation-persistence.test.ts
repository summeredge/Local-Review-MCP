import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActuationAuthorizationStore, ControlledActuationService, controlledActuationStateFile } from "../../src/control-plane/controlled-actuation.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { TaskContextService } from "../../src/context/service.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const directories: string[] = [];
const input = { actuation_id: "actuation-001", workspace_id: "workspace-a", task_id: "task-001",
  execution_id: "execution-001", instruction: "inspect the task", execution_mode: "batch" } as const;
const ioError = (code: string) => Object.assign(new Error("publish failed"), { code });
const platform = (value: string) => Object.defineProperty(process, "platform", { ...platformDescriptor, value });

beforeEach(() => { vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename); });
afterEach(async () => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  await Promise.all(directories.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "lrm-actuation-publish-"));
  directories.push(root);
  await new TaskContextService(root).createTaskContext({ task_id: input.task_id, workspace_id: input.workspace_id });
  const executions = new ExecutionContextService(root);
  const start = vi.fn(async () => {
    const state = JSON.parse(await fs.readFile(controlledActuationStateFile(root), "utf8"));
    expect(state.actuations[0].status).toBe("starting");
    expect(state.authorizations[0].status).toBe("consumed");
    const execution = await executions.createExecutionContext({ execution_id: input.execution_id,
      task_id: input.task_id, workspace_id: input.workspace_id, status: "running", process_id: 5101 });
    return { execution_id: input.execution_id, process_id: 5101, started_at: execution.started_at, accepted: "new" as const };
  });
  const service = new ControlledActuationService(new WorkspaceRegistry([{ id: input.workspace_id, name: "Test", path: root }]),
    { storageRoot: root, adapter: { start } });
  const authorization = await service.authorize(input);
  return { root, service, start, file: controlledActuationStateFile(root),
    request: { actuation_id: input.actuation_id, authorization_id: authorization.authorization_id } };
}

describe("Controlled actuation atomic publication", () => {
  it("waits for transient Windows publish failures before starting exactly once", async () => {
    platform("win32");
    const f = await fixture();
    const original = await fs.readFile(f.file, "utf8");
    const failures = ["EPERM", "EACCES", "EBUSY"];
    vi.mocked(fs.rename).mockClear().mockImplementation(async (from, to) => {
      if (to === f.file && failures.length) {
        expect(await fs.readFile(f.file, "utf8")).toBe(original);
        throw ioError(failures.shift()!);
      }
      return actual.rename(from, to);
    });
    await expect(f.service.actuate(f.request)).resolves.toMatchObject({ accepted: "new", actuation: { status: "started" } });
    await expect(f.service.actuate(f.request)).resolves.toMatchObject({ accepted: "existing" });
    expect(f.start).toHaveBeenCalledOnce();
    expect(failures).toEqual([]);
    const attempts = vi.mocked(fs.rename).mock.calls.filter(([, to]) => to === f.file).slice(0, 4);
    expect(new Set(attempts.map(([from]) => from)).size).toBe(1);
    expect((await fs.readdir(join(f.root, "control-plane"))).filter(name => name.endsWith(".tmp"))).toEqual([]);
    expect(await new ActuationAuthorizationStore(f.root).getActuation(input.actuation_id)).toMatchObject({ status: "started" });
  });

  it.each(["EPERM", "EACCES", "EBUSY"])("bounds persistent Windows %s without launching or consuming authorization", async code => {
    platform("win32");
    const f = await fixture();
    const original = await fs.readFile(f.file, "utf8");
    const error = ioError(code);
    vi.mocked(fs.rename).mockClear().mockRejectedValue(error);
    await expect(f.service.actuate(f.request)).rejects.toBe(error);
    expect(fs.rename).toHaveBeenCalledTimes(6);
    expect(f.start).not.toHaveBeenCalled();
    expect(await fs.readFile(f.file, "utf8")).toBe(original);
    expect(await f.service.getAuthorization(f.request.authorization_id)).toMatchObject({ status: "authorized" });
    expect(await f.service.getActuation(input.actuation_id)).toBeNull();
    expect((await fs.readdir(join(f.root, "control-plane"))).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each([["win32", "ENOSPC"], ["linux", "EPERM"], ["darwin", "EACCES"]])("does not retry %s %s", async (os, code) => {
    platform(os);
    const f = await fixture();
    const error = ioError(code);
    vi.mocked(fs.rename).mockClear().mockRejectedValue(error);
    await expect(f.service.actuate(f.request)).rejects.toBe(error);
    expect(fs.rename).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
  });
});
