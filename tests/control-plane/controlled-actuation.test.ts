import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActuationAuthorizationStore,
  ControlledActuationService,
  controlledActuationStateFile,
  type ControlledActuationRequest,
} from "../../src/control-plane/controlled-actuation.js";
import {
  CodexExecutionAdapter,
  type CodexProcess,
  type CodexProcessSpawnRequest,
} from "../../src/control-plane/codex-execution-adapter.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { TaskContextService } from "../../src/context/service.js";
import { WorkspaceRegistry } from "../../src/workspace/registry.js";

const temporaryDirectories: string[] = [];
const fakeProcesses: FakeProcess[] = [];

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

async function fixture(): Promise<{
  readonly storageRoot: string;
  readonly workspaceRoot: string;
  readonly registry: WorkspaceRegistry;
}> {
  const storageRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-actuation-state-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-actuation-workspace-"));
  temporaryDirectories.push(storageRoot, workspaceRoot);
  const workspace = { id: "workspace-a", name: "Workspace A", path: workspaceRoot };
  await new TaskContextService(storageRoot).createTaskContext({
    task_id: "task-001",
    workspace_id: workspace.id,
  });
  return { storageRoot, workspaceRoot, registry: new WorkspaceRegistry([workspace]) };
}

function adapterFor(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  process: FakeProcess,
  requests: CodexProcessSpawnRequest[],
): CodexExecutionAdapter {
  return new CodexExecutionAdapter(fixtureValue.registry, {
    storageRoot: fixtureValue.storageRoot,
    codexExecutable: "codex",
    processRunner: (request) => {
      requests.push(request);
      queueMicrotask(() => process.emit("spawn"));
      return process;
    },
  });
}

function authorizationInput(executionId = "execution-001") {
  return {
    actuation_id: "actuation-001",
    workspace_id: "workspace-a",
    task_id: "task-001",
    execution_id: executionId,
    instruction: "inspect the task",
  } as const;
}

describe("ControlledActuationService", () => {
  it("authorizes durably and starts through the Adapter using only the authorization record", async () => {
    const value = await fixture();
    const process = new FakeProcess(5101);
    const requests: CodexProcessSpawnRequest[] = [];
    const service = new ControlledActuationService(value.registry, {
      storageRoot: value.storageRoot,
      adapter: adapterFor(value, process, requests),
    });

    const authorization = await service.authorize(authorizationInput());
    expect(authorization.authorization_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect((await readFile(controlledActuationStateFile(value.storageRoot), "utf8"))).toContain("actuation-001");

    const result = await service.actuate({
      actuation_id: authorization.actuation_id,
      authorization_id: authorization.authorization_id,
    });
    expect(result).toMatchObject({
      execution_id: "execution-001",
      process_id: 5101,
      accepted: "new",
      actuation: { status: "started" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: "codex",
      args: ["exec", "--json", "-"],
      cwd: value.workspaceRoot,
    });
    expect(process.stdin.read()?.toString()).toBe("inspect the task");

    const state = JSON.parse(await readFile(controlledActuationStateFile(value.storageRoot), "utf8")) as {
      authorizations: Array<Record<string, unknown>>;
      actuations: Array<Record<string, unknown>>;
    };
    expect(state.authorizations[0]).toMatchObject({ status: "consumed", instruction: "inspect the task" });
    expect(state.actuations[0]).toMatchObject({
      status: "started",
      workspace_id: "workspace-a",
      task_id: "task-001",
      execution_id: "execution-001",
    });
    expect(state.actuations[0]).not.toHaveProperty("instruction");
    await expect(new ExecutionContextService(value.storageRoot).getExecutionContext(
      "workspace-a",
      "task-001",
      "execution-001",
    )).resolves.toMatchObject({ status: "running", process_id: 5101 });
  });

  it("rejects caller-supplied execution fields and isolates authorization identity", async () => {
    const value = await fixture();
    const start = vi.fn(async () => ({
      execution_id: "execution-001",
      process_id: 5102,
      started_at: new Date().toISOString(),
      accepted: "new" as const,
    }));
    const service = new ControlledActuationService(value.registry, {
      storageRoot: value.storageRoot,
      adapter: { start },
    });
    await expect(service.authorize({
      ...authorizationInput(),
      authorization_id: "11111111-1111-4111-8111-111111111111",
    } as never)).rejects.toThrow(/unrecognized key/iu);
    const authorization = await service.authorize(authorizationInput());
    (authorization as { instruction: string }).instruction = "caller mutation";

    await expect(service.actuate({
      actuation_id: "actuation-001",
      authorization_id: authorization.authorization_id,
      workspace_id: "workspace-b",
      task_id: "task-other",
      execution_id: "execution-other",
      instruction: "override",
      cwd: value.workspaceRoot,
    } as never)).rejects.toThrow(/unrecognized key/iu);
    await expect(service.actuate({
      actuation_id: "actuation-002",
      authorization_id: authorization.authorization_id,
    })).rejects.toThrow(/another actuation/iu);
    expect(start).not.toHaveBeenCalled();
    expect((await service.getAuthorization(authorization.authorization_id))?.instruction)
      .toBe("inspect the task");
  });

  it("coalesces concurrent and restarted duplicate requests without a second start", async () => {
    const value = await fixture();
    const process = new FakeProcess(5103);
    const requests: CodexProcessSpawnRequest[] = [];
    const adapter = adapterFor(value, process, requests);
    const service = new ControlledActuationService(value.registry, {
      storageRoot: value.storageRoot,
      adapter,
    });
    const authorization = await service.authorize(authorizationInput());
    const request: ControlledActuationRequest = {
      actuation_id: authorization.actuation_id,
      authorization_id: authorization.authorization_id,
    };

    const [first, second] = await Promise.all([service.actuate(request), service.actuate(request)]);
    expect(first.accepted).toBe("new");
    expect(second.accepted).toBe("existing");
    expect(requests).toHaveLength(1);

    const restarted = new ControlledActuationService(value.registry, {
      storageRoot: value.storageRoot,
      adapter: { start: vi.fn(async () => { throw new Error("must not start"); }) },
    });
    await expect(restarted.actuate(request)).resolves.toMatchObject({
      accepted: "existing",
      execution_id: "execution-001",
      process_id: 5103,
      actuation: { status: "started" },
    });
  });

  it("rejects terminal and ambiguous execution reuse before the Adapter", async () => {
    const value = await fixture();
    const start = vi.fn(async () => ({
      execution_id: "execution-001",
      process_id: 5104,
      started_at: new Date().toISOString(),
      accepted: "new" as const,
    }));
    const service = new ControlledActuationService(value.registry, {
      storageRoot: value.storageRoot,
      adapter: { start },
    });

    await new ExecutionContextService(value.storageRoot).createExecutionContext({
      execution_id: "execution-terminal",
      task_id: "task-001",
      workspace_id: "workspace-a",
      status: "passed",
    });
    await expect(service.authorize(authorizationInput("execution-terminal")))
      .rejects.toThrow(/terminal/iu);

    const authorization = await service.authorize(authorizationInput("execution-ambiguous"));
    await new ExecutionContextService(value.storageRoot).createExecutionContext({
      execution_id: "execution-ambiguous",
      task_id: "task-001",
      workspace_id: "workspace-a",
    });
    await expect(service.actuate({
      actuation_id: authorization.actuation_id,
      authorization_id: authorization.authorization_id,
    })).rejects.toThrow(/ambiguous/iu);
    expect(start).not.toHaveBeenCalled();
  });

  it("fails closed for corrupt durable state and prevents cross-authorization reuse", async () => {
    const value = await fixture();
    await mkdir(join(value.storageRoot, "control-plane"), { recursive: true });
    await writeFile(controlledActuationStateFile(value.storageRoot), "{broken", "utf8");
    const start = vi.fn(async () => ({
      execution_id: "execution-001",
      process_id: 5105,
      started_at: new Date().toISOString(),
      accepted: "new" as const,
    }));
    const service = new ControlledActuationService(value.registry, {
      storageRoot: value.storageRoot,
      authorizationStore: new ActuationAuthorizationStore(value.storageRoot),
      adapter: { start },
    });

    await expect(service.actuate({
      actuation_id: "actuation-001",
      authorization_id: "11111111-1111-4111-8111-111111111111",
    })).rejects.toThrow(/could not be restored/iu);
    expect(start).not.toHaveBeenCalled();
  });
});
