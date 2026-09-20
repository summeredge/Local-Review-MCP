import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import {
  desktopThreadBindingFile,
  desktopThreadBindingsDirectory,
  desktopThreadBindingSchema,
  type DesktopThreadBinding,
} from "./desktop-thread-binding.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function json(binding: DesktopThreadBinding): string {
  return `${JSON.stringify(binding, null, 2)}\n`;
}

export class DesktopThreadBindingConflictError extends Error {
  public readonly code = "binding_conflict" as const;

  public constructor(message: string) {
    super(message);
    this.name = "DesktopThreadBindingConflictError";
  }
}

async function publishIfAbsent(
  file: string,
  binding: DesktopThreadBinding,
): Promise<void> {
  const temporary = join(
    dirname(file),
    `.desktop-thread-binding-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, json(binding), { encoding: "utf8", mode: 0o600 });
    // A hard link publishes the fully written file and fails with EEXIST without replacing a destination.
    await link(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sameIdentity(
  left: DesktopThreadBinding,
  right: DesktopThreadBinding,
): boolean {
  return left.workspace_id === right.workspace_id
    && left.task_id === right.task_id
    && left.session_id === right.session_id
    && left.backend_identity === right.backend_identity
    && left.target_thread_id === right.target_thread_id
    && left.host_id === right.host_id;
}

export class DesktopThreadBindingStore {
  public readonly storageRoot: string;

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.storageRoot = resolve(storageRoot);
  }

  public async load(
    workspaceId: string,
    sessionId: string,
  ): Promise<DesktopThreadBinding | undefined> {
    const file = desktopThreadBindingFile(this.storageRoot, workspaceId, sessionId);
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw new Error("Desktop thread binding could not be read.", { cause: error });
    }

    try {
      const binding = desktopThreadBindingSchema.parse(JSON.parse(contents) as unknown);
      if (binding.workspace_id !== workspaceId || binding.session_id !== sessionId) {
        throw new Error("Desktop thread binding does not match the requested identity.");
      }
      return binding;
    } catch (error: unknown) {
      throw new Error(
        `Desktop thread binding for Session "${sessionId}" is invalid.`,
        { cause: error },
      );
    }
  }

  public async createIfAbsent(binding: DesktopThreadBinding): Promise<DesktopThreadBinding> {
    const parsed = desktopThreadBindingSchema.parse(binding);
    const file = desktopThreadBindingFile(
      this.storageRoot,
      parsed.workspace_id,
      parsed.session_id,
    );
    const existing = await this.load(parsed.workspace_id, parsed.session_id);
    if (existing !== undefined) return this.requireSameIdentity(existing, parsed);

    await mkdir(desktopThreadBindingsDirectory(this.storageRoot, parsed.workspace_id), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await publishIfAbsent(file, parsed);
      return parsed;
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") {
        throw new Error("Desktop thread binding could not be saved.", { cause: error });
      }

      const raced = await this.load(parsed.workspace_id, parsed.session_id);
      if (raced === undefined) {
        throw new Error("Desktop thread binding creation could not be resolved.");
      }
      return this.requireSameIdentity(raced, parsed);
    }
  }

  private requireSameIdentity(
    existing: DesktopThreadBinding,
    requested: DesktopThreadBinding,
  ): DesktopThreadBinding {
    if (!sameIdentity(existing, requested)) {
      throw new DesktopThreadBindingConflictError(
        `Desktop thread binding for Session "${requested.session_id}" conflicts with the existing target.`,
      );
    }
    return existing;
  }
}
