import { z } from "zod";
import {
  executionIdSchema,
  goalIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import type { ExecutionContext } from "../context/types.js";
import { reasoningEffortValueSchema } from "../models/model-catalog.js";
import {
  CodexExecutionAdapter,
  type CodexExecutionStartRequest,
} from "./codex-execution-adapter.js";

export class ExecutionLaunchIndeterminateError extends Error {
  public readonly code?: string;
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    const cause = options?.cause;
    this.code = cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  }
}

export const executionModeSchema = z.enum(["batch", "interactive"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

const executionInstructionSchema = z.string()
  .min(1)
  .max(1_000_000)
  .refine((value) => value.trim() !== "", "instruction is required")
  .refine((value) => !value.includes("\0"), "instruction contains a null byte");
const executionModelIdSchema = z.string().min(1).max(256);

export const executionBackendStartRequestSchema = z.object({
  goal_id: goalIdSchema.optional(),
  actuation_id: z.string().min(1).max(128).optional(),
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
  instruction: executionInstructionSchema,
  execution_mode: executionModeSchema,
  model_id: executionModelIdSchema.optional(),
  reasoning_effort: reasoningEffortValueSchema.optional(),
  /** Set only for continuation; backend selection is then fixed instead of renegotiated. */
  backend: z.enum(["desktop_codex_app", "codex_app_server"]).optional(),
  thread_id: z.string().min(1).max(256).optional(),
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
   * beyond the fixed execution_mode route. Interactive capability selection is handled by the
   * bound CapabilityNegotiator.
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

// Exact legacy prefix retained only for historical authorization compatibility.
const LEGACY_EXECUTION_CONTEXT = "你当前处于 Local Review MCP 已派发的 Codex 执行会话，任务派发已经完成。直接读取指定 Workspace 和 AGENTS.md，执行代码修改与必要验证并报告结果。不要调用 Local MCP Connector 或 submit_goal 再次派发任务。下文有关通过 LRM、submit_goal 或 interactive 模式启动任务的要求属于已完成的来源端派发上下文；保留并完成其业务目标、要求和验收标准。任务状态管理与后续 Review 由 LRM 控制端负责。";

export function withLegacyExecutionContext(instruction: string): string {
  return instruction.startsWith(`${LEGACY_EXECUTION_CONTEXT}\n\n`)
    ? instruction : `${LEGACY_EXECUTION_CONTEXT}\n\n${instruction}`;
}

export function stripLegacyExecutionContext(instruction: string): string {
  const prefix = `${LEGACY_EXECUTION_CONTEXT}\n\n`;
  return instruction.startsWith(prefix) ? instruction.slice(prefix.length) : instruction;
}

export class ExecutionService implements ExecutionBackend {
  public constructor(private readonly router: ExecutionBackendRouter) {}

  public start(request: ExecutionBackendStartRequest): Promise<ExecutionStartResult> {
    return Promise.resolve().then(() => {
      const parsed = executionBackendStartRequestSchema.parse(request);
      // Keep persisted authorization bytes unchanged; omit the obsolete prefix at execution.
      return this.router.start({ ...parsed, instruction: stripLegacyExecutionContext(parsed.instruction) });
    });
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
