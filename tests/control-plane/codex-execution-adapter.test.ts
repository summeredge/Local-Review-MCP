import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexExecutionAdapter,
  codexExecutionLogPaths,
  resolveCodexExecutable,
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
      codexExecutable: "codex",
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

    const paths = codexExecutionLogPaths(
      fixture.storageRoot,
      "workspace-a",
      "task-001",
      "execution-007",
    );
    await expect(readFile(paths.stdout, "utf8")).resolves.toContain('{"type":"completed"}');
    await expect(readFile(paths.stderr, "utf8")).resolves.toContain("warning");
    expect(paths.stdout.startsWith(fixture.workspaceRoot)).toBe(false);
    expect(paths.stderr.startsWith(fixture.workspaceRoot)).toBe(false);
  });

  it("records process exit after stream flush and reconciles completion asynchronously", async () => {
    const fixture = await makeFixture();
    const process = new FakeProcess(4106);
    const adapter = new CodexExecutionAdapter(fixture.registry, {
      storageRoot: fixture.storageRoot,
      codexExecutable: "codex",
      processRunner: runnerFor(process, []),
    });

    await adapter.start({
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-close",
      instruction: "complete asynchronously",
    });
    process.stdout.end(`${JSON.stringify({
      type: "item.completed",
      item: { id: "msg-1", type: "agent_message", text: "done" },
    })}\n{"type":"turn.completed"}\n`);
    process.stderr.end();
    process.emit("close", 0, null);

    await vi.waitFor(async () => {
      const completed = await new ExecutionContextService(fixture.storageRoot).getExecutionContext(
        "workspace-a",
        "task-001",
        "execution-close",
      );
      expect(completed).toMatchObject({ status: "passed", summary: "done", process_id: 4106 });
    }, { timeout: 5000 });

    const completed = await new ExecutionContextService(fixture.storageRoot).getExecutionContext(
      "workspace-a",
      "task-001",
      "execution-close",
    );
    expect(completed).toMatchObject({ status: "passed", summary: "done", process_id: 4106 });
    const paths = codexExecutionLogPaths(
      fixture.storageRoot,
      "workspace-a",
      "task-001",
      "execution-close",
    );
    expect(JSON.parse(await readFile(paths.exit, "utf8"))).toMatchObject({
      process_id: 4106,
      exit_code: 0,
      signal: null,
    });
  });

  it("scopes logs by workspace and task even when execution ids repeat", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-codex-log-state-"));
    const workspaceARoot = await mkdtemp(join(tmpdir(), "local-review-mcp-codex-log-a-"));
    const workspaceBRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-codex-log-b-"));
    temporaryDirectories.push(storageRoot, workspaceARoot, workspaceBRoot);
    const workspaces = [
      { id: "workspace-a", name: "Workspace A", path: workspaceARoot },
      { id: "workspace-b", name: "Workspace B", path: workspaceBRoot },
    ];
    const tasks = new TaskContextService(storageRoot);
    await tasks.createTaskContext({ task_id: "task-a", workspace_id: "workspace-a" });
    await tasks.createTaskContext({ task_id: "task-shared", workspace_id: "workspace-a" });
    await tasks.createTaskContext({ task_id: "task-b", workspace_id: "workspace-b" });

    const processes = [new FakeProcess(4201), new FakeProcess(4202), new FakeProcess(4203)];
    const requests: CodexProcessSpawnRequest[] = [];
    let processIndex = 0;
    const adapter = new CodexExecutionAdapter(new WorkspaceRegistry(workspaces), {
      storageRoot,
      codexExecutable: "codex",
      processRunner: (request) => {
        requests.push(request);
        const process = processes[processIndex++];
        if (process === undefined) throw new Error("unexpected process count");
        queueMicrotask(() => process.emit("spawn"));
        return process;
      },
    });

    const [resultA, resultA2, resultB] = await Promise.all([
      adapter.start({
        workspace_id: "workspace-a",
        task_id: "task-a",
        execution_id: "execution-same",
        instruction: "workspace A",
      }),
      adapter.start({
        workspace_id: "workspace-a",
        task_id: "task-shared",
        execution_id: "execution-same",
        instruction: "workspace A task 2",
      }),
      adapter.start({
        workspace_id: "workspace-b",
        task_id: "task-b",
        execution_id: "execution-same",
        instruction: "workspace B",
      }),
    ]);
    const processByPid = new Map(processes.map((process) => [process.pid, process]));
    const processA = processByPid.get(resultA.process_id)!;
    const processA2 = processByPid.get(resultA2.process_id)!;
    const processB = processByPid.get(resultB.process_id)!;
    processA.stdout.end('{"owner":"workspace-a/task-a"}\n');
    processA2.stdout.end('{"owner":"workspace-a/task-shared"}\n');
    processB.stdout.end('{"owner":"workspace-b/task-b"}\n');
    processA.stderr.end("stderr-a\n");
    processA2.stderr.end("stderr-a-task-2\n");
    processB.stderr.end("stderr-b\n");
    await new Promise<void>((resolve) => setImmediate(resolve));

    const pathsA = codexExecutionLogPaths(storageRoot, "workspace-a", "task-a", "execution-same");
    const pathsA2 = codexExecutionLogPaths(storageRoot, "workspace-a", "task-shared", "execution-same");
    const pathsB = codexExecutionLogPaths(storageRoot, "workspace-b", "task-b", "execution-same");
    expect(pathsA.stdout).not.toBe(pathsA2.stdout);
    expect(pathsA.stdout).not.toBe(pathsB.stdout);
    expect(pathsA.stderr).not.toBe(pathsA2.stderr);
    expect(pathsA.stderr).not.toBe(pathsB.stderr);
    await expect(readFile(pathsA.stdout, "utf8")).resolves.toContain("workspace-a/task-a");
    await expect(readFile(pathsA2.stdout, "utf8")).resolves.toContain("workspace-a/task-shared");
    await expect(readFile(pathsB.stdout, "utf8")).resolves.toContain("workspace-b/task-b");
    await expect(readFile(pathsA.stderr, "utf8")).resolves.toContain("stderr-a");
    await expect(readFile(pathsA2.stderr, "utf8")).resolves.toContain("stderr-a-task-2");
    await expect(readFile(pathsB.stderr, "utf8")).resolves.toContain("stderr-b");
    expect(requests).toHaveLength(3);
  });

  it("resolves an explicit executable and the installed Windows native binary", async () => {
    const localAppData = await mkdtemp(join(tmpdir(), "local-review-mcp-codex-install-"));
    temporaryDirectories.push(localAppData);
    const versionDirectory = join(localAppData, "OpenAI", "Codex", "bin", "test-version");
    await mkdir(versionDirectory, { recursive: true });
    const nativeExecutable = join(versionDirectory, "codex.exe");
    const explicitExecutable = join(localAppData, "explicit-codex.exe");
    await writeFile(nativeExecutable, "native");
    await writeFile(explicitExecutable, "explicit");

    expect(resolveCodexExecutable({
      codexExecutable: explicitExecutable,
      platform: "win32",
      environment: { LOCALAPPDATA: localAppData, Path: "" },
    })).toBe(explicitExecutable);
    expect(resolveCodexExecutable({
      platform: "win32",
      environment: { LOCALAPPDATA: localAppData, Path: "" },
    })).toBe(nativeExecutable);
  });

  it("fails clearly when no Windows Codex executable is resolvable", () => {
    expect(() => resolveCodexExecutable({
      platform: "win32",
      environment: {
        LOCALAPPDATA: join(tmpdir(), "local-review-mcp-codex-missing"),
        Path: "",
      },
    })).toThrow(/Codex executable was not found/iu);
  });
});
