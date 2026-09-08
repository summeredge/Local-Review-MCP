import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexExecutionCompletionService,
  codexExecutionLogPaths,
  parseCodexExecutionJsonl,
  type CodexProcessProbeState,
} from "../../src/control-plane/codex-execution-completion.js";
import { EXECUTION_SUMMARY_MAX_LENGTH } from "../../src/context/schema.js";
import { ExecutionContextService } from "../../src/context/execution-service.js";
import { TaskContextService } from "../../src/context/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function storageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "local-review-mcp-codex-completion-"));
  temporaryDirectories.push(root);
  return root;
}

async function runningExecution(
  root: string,
  input: {
    readonly workspaceId?: string;
    readonly taskId?: string;
    readonly executionId?: string;
    readonly processId?: number;
  } = {},
): Promise<{
  readonly workspaceId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly processId: number;
}> {
  const workspaceId = input.workspaceId ?? "workspace-a";
  const taskId = input.taskId ?? "task-001";
  const executionId = input.executionId ?? "execution-001";
  const processId = input.processId ?? 4101;
  await new TaskContextService(root).createTaskContext({ task_id: taskId, workspace_id: workspaceId });
  await new ExecutionContextService(root).createExecutionContext({
    execution_id: executionId,
    task_id: taskId,
    workspace_id: workspaceId,
    process_id: processId,
  });
  return { workspaceId, taskId, executionId, processId };
}

async function stdout(root: string, execution: Awaited<ReturnType<typeof runningExecution>>, contents: string) {
  const paths = codexExecutionLogPaths(
    root,
    execution.workspaceId,
    execution.taskId,
    execution.executionId,
  );
  await mkdir(dirname(paths.stdout), { recursive: true });
  await writeFile(paths.stdout, contents, "utf8");
  return paths;
}

function identity(execution: Awaited<ReturnType<typeof runningExecution>>) {
  return {
    workspace_id: execution.workspaceId,
    task_id: execution.taskId,
    execution_id: execution.executionId,
  } as const;
}

async function readExecution(root: string, execution: Awaited<ReturnType<typeof runningExecution>>) {
  return new ExecutionContextService(root).getExecutionContext(
    execution.workspaceId,
    execution.taskId,
    execution.executionId,
  );
}

const completed = JSON.stringify({
  type: "item.completed",
  item: { id: "msg-1", type: "agent_message", text: "Task completed" },
}) + "\n"
  + JSON.stringify({ type: "turn.completed" }) + "\n";

describe("CodexExecutionCompletionService", () => {
  it("marks a completed turn passed and uses the last agent message", async () => {
    const root = await storageRoot();
    const execution = await runningExecution(root);
    await stdout(root, execution, completed);

    const result = await new CodexExecutionCompletionService(root, {
      processProbe: () => "alive",
    }).reconcile(identity(execution));

    expect(result).toMatchObject({ status: "passed", summary: "Task completed", process_id: 4101 });
    expect(result.finished_at).toBeTruthy();
  });

  it("maps turn.failed and top-level error to failed without treating command items as terminal", async () => {
    const root = await storageRoot();
    const turnFailed = await runningExecution(root, { executionId: "execution-turn-failed" });
    await stdout(root, turnFailed, `${JSON.stringify({ type: "turn.failed", error: { message: "turn failed" } })}\n`);
    await expect(new CodexExecutionCompletionService(root, { processProbe: () => "alive" })
      .reconcile(identity(turnFailed))).resolves.toMatchObject({ status: "failed", summary: "turn failed" });

    const topLevelError = await runningExecution(root, {
      taskId: "task-error",
      executionId: "execution-error",
      processId: 4102,
    });
    await stdout(root, topLevelError, `${JSON.stringify({ type: "error", message: "stream failed" })}\n`);
    await expect(new CodexExecutionCompletionService(root, { processProbe: () => "alive" })
      .reconcile(identity(topLevelError))).resolves.toMatchObject({ status: "failed", summary: "stream failed" });
  });

  it("does not fail the turn for a failed command when the turn completes", async () => {
    const root = await storageRoot();
    const execution = await runningExecution(root);
    await stdout(root, execution, [
      JSON.stringify({
        type: "item.completed",
        item: { id: "cmd-1", type: "command_execution", status: "failed", aggregated_output: "nope" },
      }),
      JSON.stringify({ type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "fixed" } }),
      JSON.stringify({ type: "turn.completed" }),
      "",
    ].join("\n"));

    await expect(new CodexExecutionCompletionService(root, { processProbe: () => "alive" })
      .reconcile(identity(execution))).resolves.toMatchObject({ status: "passed", summary: "fixed" });
  });

  it("fails a process exit without terminal evidence even with exit code zero", async () => {
    const root = await storageRoot();
    const execution = await runningExecution(root);
    const service = new CodexExecutionCompletionService(root, { processProbe: () => "alive" });

    const result = await service.observeProcessExit({
      ...identity(execution),
      process_id: execution.processId,
      exit_code: 0,
      signal: null,
    });

    expect(result).toMatchObject({
      status: "failed",
      summary: "Codex process exited without terminal turn evidence.",
    });
    const paths = codexExecutionLogPaths(root, execution.workspaceId, execution.taskId, execution.executionId);
    expect(JSON.parse(await readFile(paths.exit, "utf8"))).toMatchObject({
      process_id: execution.processId,
      exit_code: 0,
      signal: null,
    });
  });

  it("keeps a partial final line running while the process is alive", async () => {
    const root = await storageRoot();
    const execution = await runningExecution(root);
    await stdout(root, execution, '{"type":"turn.completed"');

    await expect(new CodexExecutionCompletionService(root, { processProbe: () => "alive" })
      .reconcile(identity(execution))).resolves.toMatchObject({ status: "running" });
  });

  it("ignores unknown events and malformed complete lines without losing valid completion", async () => {
    const root = await storageRoot();
    const execution = await runningExecution(root);
    const paths = await stdout(root, execution, [
      "not json",
      JSON.stringify({ type: "future.event", foo: "bar" }),
      JSON.stringify({ type: "turn.completed" }),
      "",
    ].join("\n"));

    expect(parseCodexExecutionJsonl(await readFile(paths.stdout, "utf8"))).toMatchObject({
      malformedLineCount: 1,
      partial: "",
    });
    await expect(new CodexExecutionCompletionService(root, { processProbe: () => "alive" })
      .reconcile(identity(execution))).resolves.toMatchObject({ status: "passed" });
  });

  it("fails closed on conflicting terminal evidence", async () => {
    const root = await storageRoot();
    const execution = await runningExecution(root);
    await stdout(root, execution, '{"type":"turn.completed"}\n{"type":"turn.failed","error":{"message":"late failure"}}\n');

    await expect(new CodexExecutionCompletionService(root, { processProbe: () => "alive" })
      .reconcile(identity(execution))).resolves.toMatchObject({
        status: "failed",
        summary: "Codex execution has conflicting structured completion evidence.",
      });
  });

  it("serializes concurrent reconciliation and preserves terminal fields on repeats", async () => {
    const root = await storageRoot();
    const execution = await runningExecution(root);
    await stdout(root, execution, completed);
    const service = new CodexExecutionCompletionService(root, { processProbe: () => "alive" });

    const [first, second] = await Promise.all([
      service.reconcile(identity(execution)),
      service.reconcile(identity(execution)),
    ]);
    const third = await service.reconcile(identity(execution));

    expect(first).toMatchObject({ status: "passed", summary: "Task completed" });
    expect(second).toMatchObject({ status: "passed", summary: "Task completed" });
    expect(third.finished_at).toBe(first.finished_at);
    expect(third.summary).toBe(first.summary);
  });

  it("keeps completion evidence isolated by workspace and task", async () => {
    const root = await storageRoot();
    const left = await runningExecution(root, {
      workspaceId: "workspace-a",
      taskId: "task-left",
      processId: 4101,
    });
    const right = await runningExecution(root, {
      workspaceId: "workspace-b",
      taskId: "task-right",
      processId: 4102,
    });
    await stdout(root, left, `${JSON.stringify({ type: "item.completed", item: {
      type: "agent_message", text: "left",
    } })}\n{"type":"turn.completed"}\n`);
    await stdout(root, right, `${JSON.stringify({ type: "item.completed", item: {
      type: "agent_message", text: "right",
    } })}\n{"type":"turn.completed"}\n`);
    const service = new CodexExecutionCompletionService(root, { processProbe: () => "alive" });

    await Promise.all([service.reconcile(identity(left)), service.reconcile(identity(right))]);
    await expect(readExecution(root, left)).resolves.toMatchObject({ status: "passed", summary: "left" });
    await expect(readExecution(root, right)).resolves.toMatchObject({ status: "passed", summary: "right" });
  });

  it("bounds agent and structured error summaries to the context schema", async () => {
    const root = await storageRoot();
    const success = await runningExecution(root);
    await stdout(root, success, `${JSON.stringify({ type: "item.completed", item: {
      type: "agent_message", text: "x".repeat(EXECUTION_SUMMARY_MAX_LENGTH + 100),
    } })}\n{"type":"turn.completed"}\n`);
    const service = new CodexExecutionCompletionService(root, { processProbe: () => "alive" });
    const passed = await service.reconcile(identity(success));
    expect(passed.summary).toHaveLength(EXECUTION_SUMMARY_MAX_LENGTH);

    const failure = await runningExecution(root, {
      taskId: "task-failure",
      executionId: "execution-failure",
      processId: 4102,
    });
    await stdout(root, failure, `${JSON.stringify({
      type: "turn.failed",
      error: { message: "e".repeat(EXECUTION_SUMMARY_MAX_LENGTH + 100) },
    })}\n`);
    const failed = await service.reconcile(identity(failure));
    expect(failed.summary).toHaveLength(EXECUTION_SUMMARY_MAX_LENGTH);
  });

  it("recovers completed, alive, absent, and unknown running executions without spawning", async () => {
    const root = await storageRoot();
    const done = await runningExecution(root, { taskId: "task-done", processId: 4201 });
    const alive = await runningExecution(root, { taskId: "task-alive", processId: 4202 });
    const absent = await runningExecution(root, { taskId: "task-absent", processId: 4203 });
    const unknown = await runningExecution(root, { taskId: "task-unknown", processId: 4204 });
    await stdout(root, done, completed);
    const states: Record<number, CodexProcessProbeState> = {
      4201: "unknown",
      4202: "alive",
      4203: "absent",
      4204: "unknown",
    };

    await new CodexExecutionCompletionService(root, {
      processProbe: (processId) => states[processId] ?? "unknown",
    }).recoverRunningExecutions();

    await expect(readExecution(root, done)).resolves.toMatchObject({ status: "passed" });
    await expect(readExecution(root, alive)).resolves.toMatchObject({ status: "running" });
    await expect(readExecution(root, absent)).resolves.toMatchObject({
      status: "failed",
      summary: "Codex process exited without terminal turn evidence.",
    });
    await expect(readExecution(root, unknown)).resolves.toMatchObject({ status: "running" });
  });

  it("uses bounded stderr tail when a failure has no structured message", async () => {
    const root = await storageRoot();
    const execution = await runningExecution(root);
    const paths = await stdout(root, execution, '{"type":"turn.failed"}\n');
    await writeFile(paths.stderr, `${"before\n".repeat(1000)}tail diagnostic`, "utf8");

    const result = await new CodexExecutionCompletionService(root, { processProbe: () => "alive" })
      .reconcile(identity(execution));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("tail diagnostic");
    expect(result.summary?.length).toBeLessThanOrEqual(EXECUTION_SUMMARY_MAX_LENGTH);
  });
});
