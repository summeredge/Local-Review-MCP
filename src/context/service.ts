import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createTaskId,
  defaultTaskContextStorageRoot,
  taskContextFile,
  taskContextsDirectory,
} from "./task.js";
import {
  createTaskContextInputSchema,
  taskContextSchema,
  taskIdSchema,
  updateTaskContextInputSchema,
} from "./schema.js";
import type {
  CreateTaskContextInput,
  TaskContext,
  UpdateTaskContextInput,
} from "./types.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function json(context: TaskContext): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

export class TaskContextService {
  public readonly storageRoot: string;
  public readonly contextsDirectory: string;

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.contextsDirectory = taskContextsDirectory(storageRoot);
    this.storageRoot = resolve(storageRoot);
  }

  public async createTaskContext(input: CreateTaskContextInput): Promise<TaskContext> {
    const parsed = createTaskContextInputSchema.parse({
      ...input,
      task_id: input.task_id ?? createTaskId(),
    });
    const timestamp = new Date().toISOString();
    const context = taskContextSchema.parse({
      task_id: parsed.task_id,
      workspace_id: parsed.workspace_id,
      ...(parsed.conversation_id === undefined ? {} : { conversation_id: parsed.conversation_id }),
      status: parsed.status,
      created_at: timestamp,
      updated_at: timestamp,
    });
    await mkdir(this.contextsDirectory, { recursive: true, mode: 0o700 });
    const file = taskContextFile(this.storageRoot, context.task_id);
    try {
      await writeFile(file, json(context), { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Task context "${context.task_id}" already exists.`, { cause: error });
      }
      throw new Error("Task context could not be saved.", { cause: error });
    }
    return context;
  }

  public async getTaskContext(taskId: string): Promise<TaskContext | null> {
    const file = taskContextFile(this.storageRoot, taskId);
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Task context could not be read.", { cause: error });
    }

    try {
      return taskContextSchema.parse(JSON.parse(contents) as unknown);
    } catch (error: unknown) {
      throw new Error(`Task context "${taskId}" is invalid.`, { cause: error });
    }
  }

  public async updateTaskContext(
    taskId: string,
    patch: UpdateTaskContextInput,
  ): Promise<TaskContext> {
    const current = await this.getTaskContext(taskId);
    if (current === null) throw new Error(`Task context "${taskId}" was not found.`);

    const parsed = updateTaskContextInputSchema.parse(patch);
    const next = taskContextSchema.parse({
      ...current,
      ...(parsed.conversation_id === undefined ? {} : { conversation_id: parsed.conversation_id }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      updated_at: new Date().toISOString(),
    });
    try {
      await writeFile(taskContextFile(this.storageRoot, taskId), json(next), {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error: unknown) {
      throw new Error("Task context could not be saved.", { cause: error });
    }
    return next;
  }

  public async listTaskContexts(): Promise<TaskContext[]> {
    let entries;
    try {
      entries = await readdir(this.contextsDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return [];
      throw new Error("Task contexts could not be listed.", { cause: error });
    }

    const contexts: TaskContext[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const taskId = entry.name.slice(0, -".json".length);
      if (!taskIdSchema.safeParse(taskId).success) continue;
      const context = await this.getTaskContext(taskId);
      if (context !== null) contexts.push(context);
    }
    return contexts.sort((left, right) => left.task_id.localeCompare(right.task_id));
  }
}
