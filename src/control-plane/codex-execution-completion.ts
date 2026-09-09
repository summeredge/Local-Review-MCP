import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ExecutionContextService } from "../context/execution-service.js";
import {
  EXECUTION_SUMMARY_MAX_LENGTH,
  executionIdSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "../context/schema.js";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { TaskContextService } from "../context/service.js";
import type { ExecutionContext } from "../context/types.js";

export const CODEX_EXECUTIONS_DIRECTORY = join("control-plane", "codex-executions");

export interface CodexExecutionIdentity {
  readonly workspace_id: string;
  readonly task_id: string;
  readonly execution_id: string;
}

export interface CodexExecutionLogPaths {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: string;
}

export interface CodexExecutionProcessExitObservation extends CodexExecutionIdentity {
  readonly process_id: number;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly observed_at?: string;
}

export type CodexProcessProbeState = "alive" | "absent" | "unknown";
export type CodexProcessProbe = (
  processId: number,
) => CodexProcessProbeState | Promise<CodexProcessProbeState>;

export type CodexExecutionTerminalListener = (
  execution: ExecutionContext,
) => void | Promise<void>;

export interface CodexExecutionCompletionOptions {
  readonly processProbe?: CodexProcessProbe;
  readonly onTerminal?: CodexExecutionTerminalListener;
  readonly onExecutionTerminal?: CodexExecutionTerminalListener;
}

const identitySchema = z.object({
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  execution_id: executionIdSchema,
}).strict();

const processExitObservationSchema = identitySchema.extend({
  process_id: z.number().int().positive(),
  exit_code: z.number().int().nullable(),
  signal: z.string().min(1).max(32).nullable(),
  observed_at: z.string().datetime({ offset: true }).optional(),
}).strict();

const processExitEvidenceSchema = z.object({
  process_id: z.number().int().positive(),
  exit_code: z.number().int().nullable(),
  signal: z.string().min(1).max(32).nullable(),
  observed_at: z.string().datetime({ offset: true }),
}).strict();

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function sameProcessExit(
  left: z.infer<typeof processExitEvidenceSchema>,
  right: z.infer<typeof processExitEvidenceSchema>,
): boolean {
  return left.process_id === right.process_id
    && left.exit_code === right.exit_code
    && left.signal === right.signal;
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
    exit: join(directory, `${safeExecutionId}.exit.json`),
  };
}

export interface CodexJsonlParseResult {
  readonly events: readonly JsonRecord[];
  readonly partial: string;
  readonly malformedLineCount: number;
}

export function parseCodexExecutionJsonl(contents: string): CodexJsonlParseResult {
  const lines = contents.split(/\r?\n/u);
  const hasTrailingNewline = contents.endsWith("\n") || contents.endsWith("\r");
  const partial = hasTrailingNewline ? "" : (lines.pop() ?? "");
  const events: JsonRecord[] = [];
  let malformedLineCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isRecord(value) && typeof value.type === "string") events.push(value);
    } catch {
      malformedLineCount += 1;
    }
  }

  return { events, partial, malformedLineCount };
}

function addCompletedPartialEvent(parsed: CodexJsonlParseResult): {
  readonly events: readonly JsonRecord[];
  readonly malformedLineCount: number;
} {
  const partial = parsed.partial.trim();
  if (partial === "") return parsed;
  try {
    const value: unknown = JSON.parse(partial);
    return isRecord(value) && typeof value.type === "string"
      ? { events: [...parsed.events, value], malformedLineCount: parsed.malformedLineCount }
      : parsed;
  } catch {
    return {
      events: parsed.events,
      malformedLineCount: parsed.malformedLineCount + 1,
    };
  }
}

function messageFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (!isRecord(value) || typeof value.message !== "string" || value.message.trim() === "") return undefined;
  return value.message;
}

interface TerminalEvidence {
  readonly outcome: "passed" | "failed" | "conflict" | null;
  readonly summary?: string;
  readonly agentSummary?: string;
}

function terminalEvidence(events: readonly JsonRecord[]): TerminalEvidence {
  let completed = false;
  let failed = false;
  let turnFailureMessage: string | undefined;
  let topLevelErrorMessage: string | undefined;
  let agentSummary: string | undefined;

  for (const event of events) {
    switch (event.type) {
      case "turn.completed":
        completed = true;
        break;
      case "turn.failed":
        failed = true;
        turnFailureMessage = messageFrom(event.error) ?? turnFailureMessage;
        break;
      case "error":
        failed = true;
        topLevelErrorMessage = messageFrom(event.message) ?? topLevelErrorMessage;
        break;
      case "item.completed": {
        const item = event.item;
        if (isRecord(item) && item.type === "agent_message" && typeof item.text === "string") {
          const text = item.text.trim();
          if (text !== "") agentSummary = text;
        }
        break;
      }
      default:
        break;
    }
  }

  if (completed && failed) return { outcome: "conflict" };
  if (failed) {
    return {
      outcome: "failed",
      summary: turnFailureMessage ?? topLevelErrorMessage,
    };
  }
  if (completed) return { outcome: "passed", agentSummary };
  return { outcome: null };
}

function boundedSummary(value: string | undefined, fallback: string): string {
  const summary = value?.trim().slice(0, EXECUTION_SUMMARY_MAX_LENGTH) ?? "";
  return summary === "" ? fallback : summary;
}

async function stderrTail(path: string, maxBytes = 2000): Promise<string> {
  let file;
  try {
    file = await open(path, "r");
    const size = (await file.stat()).size;
    const length = Math.min(maxBytes, size);
    const buffer = Buffer.alloc(length);
    const start = Math.max(0, size - length);
    const result = await file.read(buffer, 0, length, start);
    return buffer.subarray(0, result.bytesRead).toString("utf8").trim();
  } catch {
    return "";
  } finally {
    await file?.close().catch(() => undefined);
  }
}

type ExitEvidenceRead =
  | { readonly status: "missing" }
  | { readonly status: "valid"; readonly evidence: z.infer<typeof processExitEvidenceSchema> }
  | { readonly status: "invalid" };

async function readExitEvidence(path: string): Promise<ExitEvidenceRead> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { status: "invalid" };
  }
  const parsed = processExitEvidenceSchema.safeParse(value);
  return parsed.success ? { status: "valid", evidence: parsed.data } : { status: "invalid" };
}

type ExitEvidencePersistence =
  | { readonly status: "stored" | "existing"; readonly evidence: z.infer<typeof processExitEvidenceSchema> }
  | { readonly status: "conflict" | "invalid" };

async function persistExitEvidence(
  path: string,
  evidence: z.infer<typeof processExitEvidenceSchema>,
): Promise<ExitEvidencePersistence> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  try {
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(path, 0o600).catch(() => undefined);
    return { status: "stored", evidence };
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = await readExitEvidence(path);
    if (existing.status !== "valid") return { status: "invalid" };
    return sameProcessExit(existing.evidence, evidence)
      ? { status: "existing", evidence: existing.evidence }
      : { status: "conflict" };
  }
}

function defaultProcessProbe(processId: number): CodexProcessProbeState {
  try {
    process.kill(processId, 0);
    return "alive";
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "ESRCH") return "absent";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

const reconciliationFlights = new Map<string, Promise<ExecutionContext>>();

export class CodexExecutionCompletionService {
  private readonly tasks: TaskContextService;
  private readonly executions: ExecutionContextService;
  private readonly processProbe: CodexProcessProbe;
  private terminalListener?: CodexExecutionTerminalListener;
  public readonly storageRoot: string;

  public constructor(
    storageRoot = defaultTaskContextStorageRoot(),
    options: CodexExecutionCompletionOptions = {},
  ) {
    this.storageRoot = resolve(storageRoot);
    this.tasks = new TaskContextService(this.storageRoot);
    this.executions = new ExecutionContextService(this.storageRoot);
    this.processProbe = options.processProbe ?? defaultProcessProbe;
    this.terminalListener = options.onTerminal ?? options.onExecutionTerminal;
  }

  public setTerminalListener(listener: CodexExecutionTerminalListener | undefined): void {
    this.terminalListener = listener;
  }

  public async reconcile(input: CodexExecutionIdentity): Promise<ExecutionContext> {
    const identity = identitySchema.parse(input);
    return this.serial(identity, () => this.reconcileOnce(identity));
  }

  public async observeProcessExit(
    input: CodexExecutionProcessExitObservation,
  ): Promise<ExecutionContext> {
    const parsed = processExitObservationSchema.parse(input);
    const identity: CodexExecutionIdentity = {
      workspace_id: parsed.workspace_id,
      task_id: parsed.task_id,
      execution_id: parsed.execution_id,
    };
    return this.serial(identity, async () => {
      const current = await this.executions.getExecutionContext(
        identity.workspace_id,
        identity.task_id,
        identity.execution_id,
      );
      if (current === null) throw new Error(`Execution context "${identity.execution_id}" was not found.`);
      if (current.process_id === undefined || current.process_id !== parsed.process_id) {
        return current.status === "running"
          ? this.fail(current, "Codex process-exit evidence does not match persisted process identity.")
          : current;
      }

      const paths = codexExecutionLogPaths(
        this.storageRoot,
        identity.workspace_id,
        identity.task_id,
        identity.execution_id,
      );
      const evidence = processExitEvidenceSchema.parse({
        process_id: parsed.process_id,
        exit_code: parsed.exit_code,
        signal: parsed.signal,
        observed_at: parsed.observed_at ?? new Date().toISOString(),
      });
      const persisted = await persistExitEvidence(paths.exit, evidence);
      if (persisted.status === "conflict") {
        return current.status === "running"
          ? this.fail(current, "Conflicting Codex process-exit evidence was observed.")
          : current;
      }
      if (persisted.status === "invalid") {
        console.warn("Codex process-exit evidence is corrupt; keeping execution state unchanged");
        return current;
      }
      if (current.status !== "running") return current;
      return this.reconcileOnce(identity);
    });
  }

  public recordProcessExit(
    input: CodexExecutionProcessExitObservation,
  ): Promise<ExecutionContext> {
    return this.observeProcessExit(input);
  }

  public async recoverRunningExecutions(): Promise<void> {
    const tasks = await this.tasks.listTaskContexts();
    for (const task of tasks) {
      let executions: ExecutionContext[];
      try {
        executions = await this.executions.listExecutions(task.workspace_id, task.task_id);
      } catch {
        console.warn("Codex execution completion recovery could not list executions; keeping state unchanged");
        continue;
      }
      for (const execution of executions) {
        if (execution.status !== "running" || execution.process_id === undefined) continue;
        try {
          await this.reconcile({
            workspace_id: execution.workspace_id,
            task_id: execution.task_id,
            execution_id: execution.execution_id,
          });
        } catch {
          console.warn("Codex execution completion recovery failed; keeping execution state unchanged");
        }
      }
    }
  }

  private serial(
    identity: CodexExecutionIdentity,
    operation: () => Promise<ExecutionContext>,
  ): Promise<ExecutionContext> {
    const key = `${this.storageRoot}\0${identity.workspace_id}\0${identity.task_id}\0${identity.execution_id}`;
    const previous = reconciliationFlights.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    reconciliationFlights.set(key, current);
    void current.finally(() => {
      if (reconciliationFlights.get(key) === current) reconciliationFlights.delete(key);
    }).catch(() => undefined);
    return current;
  }

  private async reconcileOnce(identity: CodexExecutionIdentity): Promise<ExecutionContext> {
    const current = await this.executions.getExecutionContext(
      identity.workspace_id,
      identity.task_id,
      identity.execution_id,
    );
    if (current === null) throw new Error(`Execution context "${identity.execution_id}" was not found.`);
    if (current.status !== "running" || current.process_id === undefined) return current;

    const paths = codexExecutionLogPaths(
      this.storageRoot,
      identity.workspace_id,
      identity.task_id,
      identity.execution_id,
    );
    const exit = await readExitEvidence(paths.exit);
    if (exit.status === "invalid") {
      console.warn("Codex process-exit evidence is corrupt; keeping execution state unchanged");
      return current;
    }
    if (exit.status === "valid" && exit.evidence.process_id !== current.process_id) {
      return this.fail(current, "Codex process-exit evidence does not match persisted process identity.");
    }

    let processState: CodexProcessProbeState = exit.status === "valid" ? "absent" : "unknown";
    if (exit.status === "missing") {
      try {
        const probed = await this.processProbe(current.process_id);
        processState = probed === "alive" || probed === "absent" || probed === "unknown"
          ? probed
          : "unknown";
      } catch {
        console.warn("Codex process state could not be determined; keeping execution state unchanged");
        processState = "unknown";
      }
    }

    let stdout: string;
    try {
      stdout = await readFile(paths.stdout, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") stdout = "";
      else {
        console.warn("Codex stdout evidence could not be read; keeping execution state unchanged");
        return current;
      }
    }

    const parsed = parseCodexExecutionJsonl(stdout);
    const completed = processState === "absent" || exit.status === "valid"
      ? addCompletedPartialEvent(parsed)
      : parsed;
    if (completed.malformedLineCount > 0) {
      console.warn("Malformed Codex JSONL evidence was ignored");
    }
    const terminal = terminalEvidence(completed.events);

    if (terminal.outcome === "conflict") {
      return this.fail(current, "Codex execution has conflicting structured completion evidence.");
    }
    if (terminal.outcome === "failed") {
      const diagnostic = terminal.summary ?? await stderrTail(paths.stderr);
      return this.fail(current, boundedSummary(diagnostic, "Codex execution failed."));
    }
    if (terminal.outcome === "passed") {
      return this.pass(current, boundedSummary(
        terminal.agentSummary,
        "Codex execution completed successfully.",
      ));
    }
    if (processState === "absent" || exit.status === "valid") {
      return this.fail(current, "Codex process exited without terminal turn evidence.");
    }
    return current;
  }

  private async pass(current: ExecutionContext, summary: string): Promise<ExecutionContext> {
    if (current.status !== "running") return current;
    const next = await this.executions.updateExecutionContext(
      current.workspace_id,
      current.task_id,
      current.execution_id,
      { status: "passed", summary },
    );
    await this.notifyTerminal(next);
    return next;
  }

  private async fail(current: ExecutionContext, summary: string): Promise<ExecutionContext> {
    if (current.status !== "running") return current;
    const next = await this.executions.updateExecutionContext(
      current.workspace_id,
      current.task_id,
      current.execution_id,
      { status: "failed", summary: boundedSummary(summary, "Codex execution failed.") },
    );
    await this.notifyTerminal(next);
    return next;
  }

  private async notifyTerminal(execution: ExecutionContext): Promise<void> {
    if (this.terminalListener === undefined) return;
    try {
      await this.terminalListener(execution);
    } catch (error: unknown) {
      console.warn(
        "Codex execution terminal notification failed; execution state is already persisted",
        error,
      );
    }
  }
}

export { CodexExecutionCompletionService as ExecutionCompletionService };
