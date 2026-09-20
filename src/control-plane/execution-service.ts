import { z } from "zod";
import {
  executionIdSchema,
  goalIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import type { ExecutionContext } from "../context/types.js";
import {
  CodexExecutionAdapter,
  type CodexExecutionStartRequest,
} from "./codex-execution-adapter.js";

export const executionModeSchema = z.enum(["batch", "interactive"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

const executionInstructionSchema = z.string()
  .min(1)
  .max(1_000_000)
  .refine((value) => value.trim() !== "", "instruction is required")
  .refine((value) => !value.includes("\0"), "instruction contains a null byte");
const executionModelSchema = z.string().min(1).max(256);
const executionReasoningEffortSchema = z.string().min(1).max(64);

export const executionBackendStartRequestSchema = z.object({
  goal_id: goalIdSchema.optional(),
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  instruction: executionInstructionSchema,
  execution_mode: executionModeSchema.default("batch"),
  model: executionModelSchema.optional(),
  reasoning_effort: executionReasoningEffortSchema.optional(),
}).strict();

export type ExecutionBackendStartRequest = z.input<typeof executionBackendStartRequestSchema>;

export interface ExecutionStartResult {
  readonly execution_id: string;
  /**
   * LRM-owned OS process identity. CLI and private app-server executions provide it;
   * Desktop executions have no LRM-owned process and omit it. Durable launch identity
   * for those backends comes from the Session and DesktopThreadBinding.
   */
  readonly process_id?: number;
  readonly started_at: string;
  readonly accepted: "new" | "existing";
  readonly session_id?: string;
  readonly thread_id?: string;
  readonly turn_id?: string;
}

export type ExecutionTerminalListener = (
  execution: ExecutionContext,
) => void | Promise<void>;

export interface ExecutionBackend {
  start(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult>;
  close?(): Promise<void>;
  setTerminalListener?(listener: ExecutionTerminalListener | undefined): void;
}

export class CliExecutionBackend implements ExecutionBackend {
  public constructor(
    private readonly adapter: Pick<CodexExecutionAdapter, "start">,
  ) {}

  public start(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    const cliRequest: CodexExecutionStartRequest = {
      workspace_id: request.workspace_id,
      task_id: request.task_id,
      execution_id: request.execution_id,
      instruction: request.instruction,
    };
    return this.adapter.start(cliRequest);
  }
}

export interface ExecutionBackendRouterOptions {
  readonly batch: ExecutionBackend;
  readonly interactive: ExecutionBackend;
}

export class ExecutionBackendRouter implements ExecutionBackend {
  private readonly batch: ExecutionBackend;
  private interactive: ExecutionBackend;
  private boundInteractive = false;

  public constructor(options: ExecutionBackendRouterOptions) {
    this.batch = options.batch;
    this.interactive = options.interactive;
  }

  public start(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    const parsed = executionBackendStartRequestSchema.parse(request);
    // Route failures must surface as rejected promises, not synchronous throws, so callers can
    // await every backend identically and fail closed on the same code path.
    return Promise.resolve().then(() =>
      (parsed.execution_mode === "interactive" ? this.interactive : this.batch).start(parsed));
  }

  /**
   * One-time interactive backend binding. The Desktop backend needs the shared Desktop tools-pipe
   * handoff, observer, and runtime factory, which only exist once the HTTP host is constructed.
   * This is a wiring seam, not a runtime backend switch: nothing selects a backend per Execution
   * beyond the fixed execution_mode route, and there is no automatic fallback.
   */
  public bindInteractive(backend: ExecutionBackend, options: { readonly replace?: boolean } = {}): void {
    if (options.replace !== true && this.boundInteractive) {
      throw new Error("The interactive execution backend is already bound.");
    }
    this.interactive = backend;
    this.boundInteractive = true;
  }

  public setTerminalListener(listener: ExecutionTerminalListener | undefined): void {
    this.interactive.setTerminalListener?.(listener);
  }

  public async close(): Promise<void> {
    await Promise.all([
      this.batch.close?.(),
      this.interactive.close?.(),
    ]);
  }
}

export class ExecutionService implements ExecutionBackend {
  public constructor(private readonly router: ExecutionBackendRouter) {}

  public start(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    return Promise.resolve().then(() =>
      this.router.start(executionBackendStartRequestSchema.parse(request)));
  }

  public setTerminalListener(listener: ExecutionTerminalListener | undefined): void {
    this.router.setTerminalListener(listener);
  }

  public bindInteractive(backend: ExecutionBackend, options: { readonly replace?: boolean } = {}): void {
    this.router.bindInteractive(backend, options);
  }

  public close(): Promise<void> {
    return this.router.close();
  }
}
