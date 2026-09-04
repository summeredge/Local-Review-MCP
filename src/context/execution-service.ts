import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createExecutionId, executionFile, taskExecutionsDirectory } from "./execution.js";
import {
  createExecutionContextInputSchema,
  executionContextSchema,
  executionIdSchema,
  updateExecutionContextInputSchema,
} from "./schema.js";
import { defaultTaskContextStorageRoot } from "./task.js";
import type {
  CreateExecutionContextInput,
  ExecutionContext,
  UpdateExecutionContextInput,
} from "./types.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function json(context: ExecutionContext): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

export class ExecutionContextService {
  public readonly storageRoot: string;

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.storageRoot = resolve(storageRoot);
  }

  public async createExecutionContext(
    input: CreateExecutionContextInput,
  ): Promise<ExecutionContext> {
    const parsed = createExecutionContextInputSchema.parse({
      ...input,
      execution_id: input.execution_id ?? createExecutionId(),
    });
    const timestamp = new Date().toISOString();
    const context = executionContextSchema.parse({
      execution_id: parsed.execution_id,
      task_id: parsed.task_id,
      workspace_id: parsed.workspace_id,
      status: parsed.status,
      ...(parsed.command === undefined ? {} : { command: parsed.command }),
      started_at: timestamp,
      ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
    });
    const directory = taskExecutionsDirectory(
      this.storageRoot,
      context.workspace_id,
      context.task_id,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = executionFile(
      this.storageRoot,
      context.workspace_id,
      context.task_id,
      context.execution_id,
    );
    try {
      await writeFile(file, json(context), { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Execution context "${context.execution_id}" already exists.`, { cause: error });
      }
      throw new Error("Execution context could not be saved.", { cause: error });
    }
    return context;
  }

  public async getExecutionContext(
    workspaceId: string,
    taskId: string,
    executionId: string,
  ): Promise<ExecutionContext | null> {
    const file = executionFile(this.storageRoot, workspaceId, taskId, executionId);
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Execution context could not be read.", { cause: error });
    }

    try {
      return executionContextSchema.parse(JSON.parse(contents) as unknown);
    } catch (error: unknown) {
      throw new Error(`Execution context "${executionId}" is invalid.`, { cause: error });
    }
  }

  public async updateExecutionContext(
    workspaceId: string,
    taskId: string,
    executionId: string,
    patch: UpdateExecutionContextInput,
  ): Promise<ExecutionContext> {
    const current = await this.getExecutionContext(workspaceId, taskId, executionId);
    if (current === null) {
      throw new Error(`Execution context "${executionId}" was not found.`);
    }

    const parsed = updateExecutionContextInputSchema.parse(patch);
    const next = executionContextSchema.parse({
      ...current,
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.command === undefined ? {} : { command: parsed.command }),
      ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
      ...(parsed.status !== undefined && parsed.status !== "running"
        ? { finished_at: new Date().toISOString() }
        : {}),
    });
    try {
      await writeFile(executionFile(this.storageRoot, workspaceId, taskId, executionId), json(next), {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error: unknown) {
      throw new Error("Execution context could not be saved.", { cause: error });
    }
    return next;
  }

  public async listExecutions(workspaceId: string, taskId: string): Promise<ExecutionContext[]> {
    const directory = taskExecutionsDirectory(this.storageRoot, workspaceId, taskId);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return [];
      throw new Error("Executions could not be listed.", { cause: error });
    }

    const executions: ExecutionContext[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const executionId = entry.name.slice(0, -".json".length);
      if (!executionIdSchema.safeParse(executionId).success) continue;
      const execution = await this.getExecutionContext(workspaceId, taskId, executionId);
      if (execution !== null) executions.push(execution);
    }
    return executions.sort((left, right) => left.execution_id.localeCompare(right.execution_id));
  }
}
