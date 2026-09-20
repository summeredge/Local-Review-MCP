import type {
  DesktopCodexCommandOptions,
  DesktopCodexThreadCommands,
} from "./thread-commands.js";
import {
  DesktopThreadBindingConflictError,
  type DesktopThreadBindingStore,
} from "./desktop-thread-binding-store.js";
import type { DesktopThreadBinding } from "./desktop-thread-binding.js";

export type DesktopThreadCoordinatorErrorCode =
  | "binding_not_found"
  | "binding_conflict"
  | "binding_identity_mismatch";

export class DesktopThreadCoordinatorError extends Error {
  public constructor(
    public readonly code: DesktopThreadCoordinatorErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DesktopThreadCoordinatorError";
  }
}

export interface DesktopThreadCoordinatorOptions {
  readonly commands: Pick<DesktopCodexThreadCommands, "createThread" | "sendMessageToThread">;
  readonly bindings: Pick<DesktopThreadBindingStore, "load" | "createIfAbsent">;
}

export interface CreateOrReuseThreadInput extends DesktopCodexCommandOptions {
  readonly workspace_id: string;
  readonly task_id: string;
  readonly session_id: string;
  readonly projectId: string;
  readonly prompt: string;
}

export interface SendToBoundThreadInput extends DesktopCodexCommandOptions {
  readonly workspace_id: string;
  readonly task_id: string;
  readonly session_id: string;
  readonly prompt: string;
}

function commandOptions(input: DesktopCodexCommandOptions): DesktopCodexCommandOptions {
  return {
    executorThreadId: input.executorThreadId,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

export class DesktopThreadCoordinator {
  private readonly commands: DesktopThreadCoordinatorOptions["commands"];
  private readonly bindings: DesktopThreadCoordinatorOptions["bindings"];

  public constructor(options: DesktopThreadCoordinatorOptions) {
    this.commands = options.commands;
    this.bindings = options.bindings;
  }

  public async createOrReuseThread(
    input: CreateOrReuseThreadInput,
  ): Promise<DesktopThreadBinding> {
    const existing = await this.bindings.load(input.workspace_id, input.session_id);
    if (existing !== undefined) {
      this.assertOwnership(existing, input);
      return existing;
    }

    const created = await this.commands.createThread({
      ...commandOptions(input),
      projectId: input.projectId,
      prompt: input.prompt,
    });
    const now = new Date().toISOString();
    try {
      const durable = await this.bindings.createIfAbsent({
        schema_version: 1,
        workspace_id: input.workspace_id,
        task_id: input.task_id,
        session_id: input.session_id,
        backend_identity: "desktop_codex_app",
        target_thread_id: created.targetThreadId,
        host_id: created.hostId,
        created_at: now,
        updated_at: now,
      });
      this.assertOwnership(durable, input);
      if (durable.target_thread_id !== created.targetThreadId
        || durable.host_id !== created.hostId) {
        throw new DesktopThreadCoordinatorError(
          "binding_conflict",
          "Desktop thread binding target differs from the created target.",
        );
      }
      return durable;
    } catch (error: unknown) {
      if (error instanceof DesktopThreadBindingConflictError) {
        throw new DesktopThreadCoordinatorError("binding_conflict", error.message, error);
      }
      throw error;
    }
  }

  public async sendToBoundThread(input: SendToBoundThreadInput) {
    const binding = await this.bindings.load(input.workspace_id, input.session_id);
    if (binding === undefined) {
      throw new DesktopThreadCoordinatorError(
        "binding_not_found",
        `Desktop thread binding for Session "${input.session_id}" was not found.`,
      );
    }
    this.assertOwnership(binding, input);
    return this.commands.sendMessageToThread({
      ...commandOptions(input),
      targetThreadId: binding.target_thread_id,
      hostId: binding.host_id,
      prompt: input.prompt,
    });
  }

  private assertOwnership(
    binding: DesktopThreadBinding,
    input: Pick<CreateOrReuseThreadInput, "workspace_id" | "task_id" | "session_id">,
  ): void {
    if (binding.workspace_id !== input.workspace_id
      || binding.task_id !== input.task_id
      || binding.session_id !== input.session_id
      || binding.backend_identity !== "desktop_codex_app") {
      throw new DesktopThreadCoordinatorError(
        "binding_identity_mismatch",
        "Desktop thread binding does not belong to the requested LRM identity.",
      );
    }
  }
}
