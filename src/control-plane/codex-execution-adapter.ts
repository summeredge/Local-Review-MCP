import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { createWriteStream, readdirSync, statSync, type WriteStream } from "node:fs";
import { dirname, join, resolve, win32 as win32Path } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { ExecutionContextService } from "../context/execution-service.js";
import {
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { TaskContextService } from "../context/service.js";
import type { ExecutionContext } from "../context/types.js";
import { WorkspaceRegistry } from "../workspace/registry.js";

const CODEX_ARGS = ["exec", "--json", "-"] as const;
const CODEX_COMMAND = "codex exec --json -";
export const CODEX_EXECUTIONS_DIRECTORY = join("control-plane", "codex-executions");

export interface CodexExecutionStartRequest {
  readonly workspace_id: string;
  readonly task_id: string;
  readonly execution_id: string;
  readonly instruction: string;
}

export interface CodexExecutionStartResult {
  readonly execution_id: string;
  readonly process_id: number;
  readonly started_at: string;
  readonly accepted: "new" | "existing";
}

export interface CodexExecutionLogPaths {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CodexProcess {
  readonly pid?: number;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: unknown) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
}

export interface CodexProcessSpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export type CodexProcessRunner = (request: CodexProcessSpawnRequest) => CodexProcess;

export interface CodexExecutionAdapterOptions {
  readonly storageRoot?: string;
  readonly processRunner?: CodexProcessRunner;
  readonly codexExecutable?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CodexExecutableResolutionOptions {
  readonly codexExecutable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export const codexExecutionStartRequestSchema = z.object({
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  instruction: z.string()
    .min(1)
    .max(1_000_000)
    .refine((value) => value.trim() !== "", "instruction is required")
    .refine((value) => !value.includes("\0"), "instruction contains a null byte"),
}).strict();

function existingExecutable(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function pathLike(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? win32Path.isAbsolute(value) || value.includes("\\") || value.includes("/")
    : value.startsWith("/");
}

function findWindowsCodexExecutable(environment: NodeJS.ProcessEnv): string | undefined {
  const pathValue = environment.Path ?? environment.PATH ?? environment.path;
  const pathEntries = pathValue === undefined ? [] : pathValue.split(win32Path.delimiter);
  for (const directory of pathEntries) {
    const candidate = existingExecutable(win32Path.join(directory, "codex.exe"));
    if (candidate !== undefined) return candidate;
  }

  const localAppData = environment.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.trim() === "") return undefined;
  const binRoot = win32Path.join(localAppData, "OpenAI", "Codex", "bin");
  const direct = existingExecutable(win32Path.join(binRoot, "codex.exe"));
  if (direct !== undefined) return direct;

  let entries;
  try {
    entries = readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const candidate = existingExecutable(win32Path.join(binRoot, entry.name, "codex.exe"));
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

export function resolveCodexExecutable(
  options: CodexExecutableResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const explicit = options.codexExecutable?.trim();
  if (explicit !== undefined && explicit !== "") {
    if (pathLike(explicit, platform) && existingExecutable(explicit) === undefined) {
      throw new Error(`Codex executable override was not found: ${explicit}`);
    }
    return explicit;
  }
  if (platform !== "win32") return "codex";
  const resolved = findWindowsCodexExecutable(environment);
  if (resolved === undefined) {
    throw new Error("Codex executable was not found on Windows.");
  }
  return resolved;
}

export function codexExecutionLogPaths(
  storageRoot: string,
  workspaceId: string,
  taskId: string,
  executionId: string,
): CodexExecutionLogPaths {
  const safeWorkspaceId = workspaceIdSchema.parse(workspaceId);
  const safeTaskId = taskIdSchema.parse(taskId);
  const safeExecutionId = executionIdSchema.parse(executionId);
  const directory = join(
    resolve(storageRoot),
    CODEX_EXECUTIONS_DIRECTORY,
    safeWorkspaceId,
    safeTaskId,
  );
  return {
    stdout: join(directory, `${safeExecutionId}.jsonl`),
    stderr: join(directory, `${safeExecutionId}.stderr.log`),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;
  return "unknown process launch error";
}

function launchFailureSummary(error: unknown): string {
  return `Codex process launch failed: ${errorMessage(error)}`.slice(0, 4000);
}

async function openLogStream(path: string): Promise<WriteStream> {
  const stream = createWriteStream(path, { encoding: "utf8", flags: "a", mode: 0o600 });
  await new Promise<void>((resolveStream, reject) => {
    const onError = (error: Error): void => reject(error);
    stream.once("error", onError);
    stream.once("open", () => {
      stream.removeListener("error", onError);
      stream.on("error", () => undefined);
      resolveStream();
    });
  });
  await chmod(path, 0o600).catch(() => undefined);
  return stream;
}

async function prepareLogStreams(paths: CodexExecutionLogPaths): Promise<{
  readonly stdout: WriteStream;
  readonly stderr: WriteStream;
}> {
  const directory = dirname(paths.stdout);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);

  let stdout: WriteStream | undefined;
  try {
    stdout = await openLogStream(paths.stdout);
    const stderr = await openLogStream(paths.stderr);
    return { stdout, stderr };
  } catch (error: unknown) {
    stdout?.destroy();
    throw new Error("Codex execution logs could not be opened.", { cause: error });
  }
}

function attachLog(stream: Readable | null, log: WriteStream): void {
  if (stream === null) {
    log.end();
    return;
  }
  stream.pipe(log);
}

function waitForSpawn(child: CodexProcess): Promise<number> {
  return new Promise((resolveProcess, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(errorMessage(error)));
    };

    child.once("spawn", () => {
      const processId = child.pid;
      if (typeof processId !== "number" || !Number.isInteger(processId) || processId <= 0) {
        fail(new Error("Codex process started without a valid process id."));
        return;
      }
      settled = true;
      resolveProcess(processId);
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      fail(new Error(
        `Codex process exited before startup confirmation (code=${code ?? "null"}, signal=${signal ?? "none"}).`,
      ));
    });
  });
}

function result(
  execution: ExecutionContext,
  accepted: CodexExecutionStartResult["accepted"],
): CodexExecutionStartResult {
  if (execution.process_id === undefined) {
    throw new Error(`Execution "${execution.execution_id}" has no persisted process identity.`);
  }
  return {
    execution_id: execution.execution_id,
    process_id: execution.process_id,
    started_at: execution.started_at,
    accepted,
  };
}

export class CodexExecutionAdapter {
  private readonly tasks: TaskContextService;
  private readonly executions: ExecutionContextService;
  private readonly processRunner: CodexProcessRunner;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly codexExecutableOverride: string | undefined;
  private readonly inFlight = new Map<string, Promise<CodexExecutionStartResult>>();
  public readonly storageRoot: string;

  public constructor(
    private readonly registry: WorkspaceRegistry,
    options: CodexExecutionAdapterOptions = {},
  ) {
    this.storageRoot = resolve(options.storageRoot ?? defaultTaskContextStorageRoot());
    this.tasks = new TaskContextService(this.storageRoot);
    this.executions = new ExecutionContextService(this.storageRoot);
    this.processRunner = options.processRunner ?? ((request) => spawn(
      request.command,
      [...request.args],
      {
        cwd: request.cwd,
        env: request.environment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ));
    this.environment = { ...process.env, ...(options.environment ?? {}) };
    this.codexExecutableOverride = options.codexExecutable?.trim() || undefined;
  }

  public async start(request: CodexExecutionStartRequest): Promise<CodexExecutionStartResult> {
    const parsed = codexExecutionStartRequestSchema.parse(request);
    const key = `${parsed.workspace_id}\0${parsed.task_id}\0${parsed.execution_id}`;
    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      return pending.then((started) => ({ ...started, accepted: "existing" as const }));
    }

    const operation = this.startOnce(parsed);
    this.inFlight.set(key, operation);
    void operation.finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  private async startOnce(
    request: CodexExecutionStartRequest,
  ): Promise<CodexExecutionStartResult> {
    const workspace = this.registry.resolve(request.workspace_id);
    const task = await this.tasks.getTaskContext(request.task_id);
    if (task === null) {
      throw new Error(`Task context "${request.task_id}" was not found.`);
    }
    if (task.workspace_id !== request.workspace_id) {
      throw new Error("Task context does not belong to the requested workspace.");
    }

    const existing = await this.executions.getExecutionContext(
      request.workspace_id,
      request.task_id,
      request.execution_id,
    );
    if (existing !== null) return this.existing(existing);

    let execution: ExecutionContext;
    try {
      execution = await this.executions.createExecutionContext({
        execution_id: request.execution_id,
        task_id: request.task_id,
        workspace_id: request.workspace_id,
        status: "running",
        command: CODEX_COMMAND,
      });
    } catch (error: unknown) {
      const raced = await this.executions.getExecutionContext(
        request.workspace_id,
        request.task_id,
        request.execution_id,
      );
      if (raced !== null) return this.existing(raced);
      throw error;
    }

    let logStreams: Awaited<ReturnType<typeof prepareLogStreams>> | undefined;
    let child: CodexProcess | undefined;
    try {
      const codexExecutable = resolveCodexExecutable({
        codexExecutable: this.codexExecutableOverride,
        environment: this.environment,
      });
      const logs = codexExecutionLogPaths(
        this.storageRoot,
        request.workspace_id,
        request.task_id,
        request.execution_id,
      );
      logStreams = await prepareLogStreams(logs);
      child = this.processRunner({
        command: codexExecutable,
        args: CODEX_ARGS,
        cwd: workspace.manager.canonicalRoot,
        environment: this.environment,
      });
      attachLog(child.stdout, logStreams.stdout);
      attachLog(child.stderr, logStreams.stderr);
      const processId = await waitForSpawn(child);
      if (child.stdin === null) throw new Error("Codex process has no stdin pipe.");
      child.stdin.end(request.instruction);
      execution = await this.executions.updateExecutionContext(
        request.workspace_id,
        request.task_id,
        request.execution_id,
        { process_id: processId },
      );
      return result(execution, "new");
    } catch (error: unknown) {
      logStreams?.stdout.destroy();
      logStreams?.stderr.destroy();
      if (child?.kill !== undefined) child.kill();
      const summary = launchFailureSummary(error);
      try {
        await this.executions.updateExecutionContext(
          request.workspace_id,
          request.task_id,
          request.execution_id,
          { status: "failed", summary },
        );
      } catch (updateError: unknown) {
        throw new Error(`${summary}; execution failure could not be persisted.`, {
          cause: updateError,
        });
      }
      throw new Error(summary, { cause: error });
    }
  }

  private existing(execution: ExecutionContext): CodexExecutionStartResult {
    if (execution.status !== "running" || execution.process_id === undefined) {
      throw new Error(
        `Execution "${execution.execution_id}" is already recorded without a confirmed running process; refusing to spawn another process.`,
      );
    }
    return result(execution, "existing");
  }
}
