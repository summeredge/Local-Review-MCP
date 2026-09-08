import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexExecutionAdapter,
  codexExecutionLogPaths,
  type CodexProcess,
  type CodexProcessSpawnRequest,
} from "../../src/control-plane/codex-execution-adapter.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { TaskContextService } from "../../src/context/service.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const temporaryDirectories: string[] = [];
const fakeProcesses: FakeProcess[] = [];

afterEach(async () => {
  for (const process of fakeProcesses.splice(0)) {
    process.stdin.end();
    process.stdout.end();
    process.stderr.end();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

class FakeProcess extends EventEmitter implements CodexProcess {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();

  public constructor(public readonly pid: number) {
    super();
    fakeProcesses.push(this);
  }

  public kill(): boolean {
    return true;
  }
}

async function makeFixture(): Promise<{
  readonly storageRoot: string;
  readonly workspaceRoot: string;
  readonly registry: WorkspaceRegistry;
}> {
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-codex-adapter-state-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-codex-adapter-workspace-"));
  temporaryDirectories.push(storageRoot, workspaceRoot);
  const workspace = { id: "workspace-a", name: "Workspace A", path: workspaceRoot };
  await new TaskContextService(storageRoot).createTaskContext({
    task_id: "task-001",
    workspace_id: workspace.id,
  });
  return { storageRoot, workspaceRoot, registry: new WorkspaceRegistry([workspace]) };
}

function runnerFor(process: FakeProcess, requests: CodexProcessSpawnRequest[]) {
  return (request: CodexProcessSpawnRequest): CodexProcess => {
    requests.push(request);
    queueMicrotask(() => process.emit("spawn"));
    return process;
  };
}

describe("CodexExecutionAdapter", () => {
  it("starts once in the registry workspace and persists process identity", async () => {
    const fixture = await makeFixture();
    const process = new FakeProcess(4101);
    const requests: CodexProcessSpawnRequest[] = [];
    const adapter = new CodexExecutionAdapter(fixture.registry, {
      storageRoot: fixture.storageRoot,
      processRunner: runnerFor(process, requests),
    });

    const started = await adapter.start({
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-001",
      instruction: "inspect the task",
    });

    expect(started).toMatchObject({
      execution_id: "execution-001",
      process_id: 4101,
      accepted: "new",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: "codex",
      args: ["exec", "--json", "-"],
      cwd: fixture.workspaceRoot,
    });
    expect(process.stdin.read()?.toString()).toBe("inspect the task");
    await expect(new ExecutionContextService(fixture.storageRoot).getExecutionContext(
      "workspace-a",
      "task-001",
      "execution-001",
    )).resolves.toMatchObject({ status: "running", process_id: 4101 });
  });

  it("coalesces duplicate starts and survives service reconstruction", async () => {
    const fixture = await makeFixture();
    const process = new FakeProcess(4102);
    const requests: CodexProcessSpawnRequest[] = [];
    let releaseSpawn!: () => void;
    const spawnReady = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    const adapter = new CodexExecutionAdapter(fixture.registry, {
      storageRoot: fixture.storageRoot,
      processRunner: (request) => {
        requests.push(request);
        spawnReady.then(() => process.emit("spawn"));
        return process;
      },
    });

    const first = adapter.start({
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-002",
      instruction: "run once",
    });
    const second = adapter.start({
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-002",
      instruction: "run once",
    });
    releaseSpawn();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({
      execution_id: "execution-002",
      process_id: 4102,
      accepted: "new",
    });
    expect(secondResult).toMatchObject({
      execution_id: "execution-002",
      process_id: 4102,
      accepted: "existing",
    });
    expect(requests).toHaveLength(1);

    const restarted = new CodexExecutionAdapter(fixture.registry, {
      storageRoot: fixture.storageRoot,
      processRunner: () => { throw new Error("must not spawn"); },
    });
    await expect(restarted.start({
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-002",
      instruction: "run once",
    })).resolves.toMatchObject({ accepted: "existing", process_id: 4102 });
  });

  it("marks a pre-start failure failed without a process id or retry", async () => {
    const fixture = await makeFixture();
    let spawnCount = 0;
    const adapter = new CodexExecutionAdapter(fixture.registry, {
      storageRoot: fixture.storageRoot,
      processRunner: () => {
        spawnCount += 1;
        throw new Error("ENOENT");
      },
    });

    const request = {
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-003",
      instruction: "fail safely",
    };
    await expect(adapter.start(request)).rejects.toThrow(/ENOENT/iu);
    const failed = await new ExecutionContextService(fixture.storageRoot).getExecutionContext(
      "workspace-a",
      "task-001",
      "execution-003",
    );
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed?.process_id).toBeUndefined();
    await expect(adapter.start(request)).rejects.toThrow(/refusing to spawn/iu);
    expect(spawnCount).toBe(1);
  });

  it("rejects unknown and mismatched task identity before spawning", async () => {
    const fixture = await makeFixture();
    await new TaskContextService(fixture.storageRoot).createTaskContext({
      task_id: "task-other",
      workspace_id: "workspace-b",
    });
    let spawnCount = 0;
    const adapter = new CodexExecutionAdapter(fixture.registry, {
      storageRoot: fixture.storageRoot,
      processRunner: () => {
        spawnCount += 1;
        throw new Error("must not spawn");
      },
    });

    await expect(adapter.start({
      workspace_id: "unknown-workspace",
      task_id: "task-001",
      execution_id: "execution-004",
      instruction: "reject",
    })).rejects.toThrow(/Unknown workspace_id/iu);
    await expect(adapter.start({
      workspace_id: "workspace-a",
      task_id: "task-other",
      execution_id: "execution-005",
      instruction: "reject",
    })).rejects.toThrow(/does not belong/iu);
    expect(spawnCount).toBe(0);
  });

  it("rejects an existing ambiguous launch state", async () => {
    const fixture = await makeFixture();
    await new ExecutionContextService(fixture.storageRoot).createExecutionContext({
      execution_id: "execution-006",
      task_id: "task-001",
      workspace_id: "workspace-a",
    });
    let spawnCount = 0;
    const adapter = new CodexExecutionAdapter(fixture.registry, {
      storageRoot: fixture.storageRoot,
      processRunner: () => {
        spawnCount += 1;
        throw new Error("must not spawn");
      },
    });

    await expect(adapter.start({
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-006",
      instruction: "do not duplicate",
    })).rejects.toThrow(/refusing to spawn/iu);
    expect(spawnCount).toBe(0);
  });

  it("keeps structured stdout and stderr outside the workspace", async () => {
    const fixture = await makeFixture();
    const process = new FakeProcess(4105);
    const adapter = new CodexExecutionAdapter(fixture.registry, {
      storageRoot: fixture.storageRoot,
      processRunner: runnerFor(process, []),
    });

    await adapter.start({
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-007",
      instruction: "write evidence",
    });
    process.stdout.end('{"type":"completed"}\n');
    process.stderr.end("warning\n");
    await new Promise<void>((resolve) => setImmediate(resolve));

    const paths = codexExecutionLogPaths(fixture.storageRoot, "execution-007");
    await expect(readFile(paths.stdout, "utf8")).resolves.toContain('{"type":"completed"}');
    await expect(readFile(paths.stderr, "utf8")).resolves.toContain("warning");
    expect(paths.stdout.startsWith(fixture.workspaceRoot)).toBe(false);
    expect(paths.stderr.startsWith(fixture.workspaceRoot)).toBe(false);
  });
});
