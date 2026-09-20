import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { CallToolRequestParams, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CodexAppRuntime,
  CodexAppRuntimeError,
  type CodexAppMcpClient,
} from "../desktop-codex/codex-app-runtime.js";
import { createCodexAppToolContracts } from "../desktop-codex/codex-app-contracts.js";
import {
  DesktopCompletionObserver,
  type DesktopCompletionResult,
} from "../desktop-codex/completion-observer.js";
import { resolveDesktopProject } from "../desktop-codex/desktop-project-resolver.js";
import { desktopThreadBindingFile } from "../desktop-codex/desktop-thread-binding.js";
import { DesktopThreadBindingStore } from "../desktop-codex/desktop-thread-binding-store.js";
import {
  DesktopThreadCoordinator,
  DesktopThreadCoordinatorError,
} from "../desktop-codex/desktop-thread-coordinator.js";
import { DesktopCodexThreadCommands } from "../desktop-codex/thread-commands.js";
import { DesktopIPCObserver } from "./desktop-ipc-observer.js";
import {
  readAgentMessageMarker,
  waitForAgentMessageMarker,
} from "./diagnostic-marker-sequencing.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { sessionIdSchema, taskIdSchema, workspaceIdSchema } from "../context/schema.js";

const SMOKE_DIRECTORY = [".review", "p5-2-2-c-smoke"] as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IDENTITY_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const EXECUTOR_METADATA_KEY = "openai/threadId" as const;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const FORBIDDEN_BINDING_KEYS = new Set([
  "executorThreadId",
  "executor_thread_id",
  "conversation_id",
  "conversationId",
  "review_conversation_id",
  "reviewConversationId",
  "request_metadata",
  "requestMetadata",
  "mcp_request_metadata",
  "mcpRequestMetadata",
]);

const identitySchema = z.string().min(1).max(256).regex(IDENTITY_PATTERN);

export const desktopThreadDurableSmokeStateSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().uuid(),
  workspace_id: workspaceIdSchema,
  task_id: taskIdSchema,
  session_id: sessionIdSchema,
  workspace_path: z.string().min(1).max(4096),
  project_id: identitySchema,
  phase_a_executor_thread_id: identitySchema,
  target_thread_id: identitySchema,
  host_id: identitySchema,
  storage_root: z.string().min(1).max(4096),
  created_at: z.string().datetime({ offset: true }),
}).strict();

export type DesktopThreadDurableSmokeState = z.infer<typeof desktopThreadDurableSmokeStateSchema>;

export type DesktopThreadDurableSmokePhase = "phase-a" | "phase-b" | "cleanup";

export type DesktopThreadDurableSmokeFailureClass =
  | "desktop_not_running"
  | "runtime_discovery_failed"
  | "mcp_connect_failed"
  | "tools_list_failed"
  | "executor_identity_unavailable"
  | "executor_context_not_changed"
  | "thread_identity_conflict"
  | "project_not_found"
  | "project_ambiguous"
  | "project_discovery_failed"
  | "binding_missing_after_phase_a"
  | "binding_identity_mismatch"
  | "binding_conflict"
  | "duplicate_create_after_restart"
  | "create_failed"
  | "send_failed"
  | "target_changed"
  | "host_changed"
  | "completion_unverifiable"
  | "state_not_found"
  | "state_invalid"
  | "state_persistence_failed"
  | "workspace_invalid";

export interface DesktopThreadDurableSmokeArgs {
  readonly phase: DesktopThreadDurableSmokePhase;
  readonly runId?: string;
  readonly workspacePath: string;
  readonly serverPath?: string;
  readonly pipePath?: string;
  readonly desktopIpcPipePath?: string;
  readonly timeoutMs: number;
  readonly identityTimeoutMs: number;
}

export interface DesktopThreadDurableSmokeDependencies {
  readonly readExecutorThreadId?: (options: {
    readonly pipePath?: string;
    readonly timeoutMs: number;
  }) => Promise<string>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => string;
}

export interface DurableContinuityEvidence {
  readonly executor_changed: boolean;
  readonly binding_survived_process_restart: boolean;
  readonly target_preserved: boolean;
  readonly host_preserved: boolean;
  readonly phase_b_metadata_uses_new_executor: boolean;
  readonly phase_b_arguments_use_old_target: boolean;
  readonly second_turn_dispatch_verified: boolean;
  readonly second_turn_same_target: boolean;
  readonly binding_unchanged: boolean;
  readonly executor_not_persisted: boolean;
  readonly second_turn_content_verified: boolean | "unknown";
  readonly completion_observer_verified: boolean | "unknown";
}

export interface DurableContinuityAggregation extends DurableContinuityEvidence {
  readonly ok: boolean;
  readonly result: "pass" | "fail";
}

export interface DesktopThreadDurableSmokeResult {
  readonly ok: boolean;
  readonly phase: DesktopThreadDurableSmokePhase;
  readonly result: "pass" | "fail";
  readonly failure_class?: DesktopThreadDurableSmokeFailureClass;
  readonly run_id?: string;
  readonly session_id?: string;
  readonly state_path?: string;
  readonly target_thread_suffix?: string;
  readonly executor_thread_suffix?: string;
  readonly host_id?: string;
  readonly phase_a_create_thread_count?: number;
  readonly phase_b_create_thread_count?: number;
  readonly binding_persisted?: boolean;
  readonly binding_survived_process_restart?: boolean;
  readonly target_reuse_verified?: boolean;
  readonly target_preserved?: boolean;
  readonly host_preserved?: boolean;
  readonly executor_changed?: boolean;
  readonly phase_b_metadata_uses_new_executor?: boolean;
  readonly phase_b_arguments_use_old_target?: boolean;
  readonly second_turn_dispatch_verified?: boolean;
  readonly second_turn_same_target?: boolean;
  readonly second_turn_content_verified?: boolean | "unknown";
  readonly completion_observer_verified?: boolean | "unknown";
  readonly binding_unchanged?: boolean;
  readonly executor_not_persisted?: boolean;
  readonly first_turn_content_verified?: boolean | "unknown";
  readonly message?: string;
}

interface RequestEvidence {
  readonly tool: string;
  readonly executorThreadId?: string;
  readonly targetThreadId?: string;
  readonly hostId?: string;
}

class SmokeFailure extends Error {
  public constructor(public readonly failureClass: DesktopThreadDurableSmokeFailureClass) {
    super(failureClass);
    this.name = "SmokeFailure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[field];
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : undefined;
}

function threadSuffix(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= 8 ? value : value.slice(-8);
}

function safeRunId(runId: string): string {
  if (!desktopThreadDurableSmokeStateSchema.shape.run_id.safeParse(runId).success) {
    throw new Error("run_id must be a UUID.");
  }
  return runId;
}

function smokeRoot(workspacePath: string): string {
  return join(resolve(workspacePath), ...SMOKE_DIRECTORY);
}

export function smokeRunDirectory(workspacePath: string, runId: string): string {
  return join(smokeRoot(workspacePath), safeRunId(runId));
}

export function smokeStateFile(workspacePath: string, runId: string): string {
  return join(smokeRunDirectory(workspacePath, runId), "smoke-state.json");
}

export async function writeSmokeState(state: DesktopThreadDurableSmokeState): Promise<void> {
  const parsed = desktopThreadDurableSmokeStateSchema.parse(state);
  await mkdir(parsed.storage_root, { recursive: true, mode: 0o700 });
  const file = join(parsed.storage_root, "smoke-state.json");
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readSmokeState(runDirectory: string): Promise<DesktopThreadDurableSmokeState> {
  const contents = await readFile(join(resolve(runDirectory), "smoke-state.json"), "utf8");
  return desktopThreadDurableSmokeStateSchema.parse(JSON.parse(contents) as unknown);
}

export async function cleanupSmokeRun(workspacePath: string, runId: string): Promise<void> {
  const root = smokeRoot(workspacePath);
  const target = smokeRunDirectory(workspacePath, runId);
  if (dirname(target) !== root) throw new Error("Invalid smoke cleanup target.");
  await rm(target, { recursive: true, force: true });
}

export function checkPhaseBExecutorIdentity(
  phaseAExecutorThreadId: string,
  phaseBExecutorThreadId: string,
  targetThreadId: string,
): { readonly ok: boolean; readonly executor_changed: boolean; readonly failure_class?: DesktopThreadDurableSmokeFailureClass } {
  if (phaseBExecutorThreadId === phaseAExecutorThreadId) {
    return { ok: false, executor_changed: false, failure_class: "executor_context_not_changed" };
  }
  if (phaseBExecutorThreadId === targetThreadId) {
    return { ok: false, executor_changed: true, failure_class: "thread_identity_conflict" };
  }
  return { ok: true, executor_changed: true };
}

export function checkTargetPreserved(
  expectedTargetThreadId: string,
  actualTargetThreadId: string,
): { readonly ok: boolean; readonly failure_class?: "target_changed" } {
  return expectedTargetThreadId === actualTargetThreadId
    ? { ok: true }
    : { ok: false, failure_class: "target_changed" };
}

export function checkCreateThreadCount(
  actualCount: number,
  expectedCount: number,
): { readonly ok: boolean; readonly failure_class?: DesktopThreadDurableSmokeFailureClass } {
  return actualCount === expectedCount
    ? { ok: true }
    : { ok: false, failure_class: expectedCount === 0 ? "duplicate_create_after_restart" : "create_failed" };
}

function failureClassForEvidence(
  evidence: DurableContinuityAggregation,
): DesktopThreadDurableSmokeFailureClass | undefined {
  if (evidence.ok) return undefined;
  if (evidence.binding_survived_process_restart === false) return "binding_missing_after_phase_a";
  if (evidence.target_preserved === false) return "target_changed";
  if (evidence.host_preserved === false) return "host_changed";
  if (evidence.phase_b_metadata_uses_new_executor === false
    || evidence.phase_b_arguments_use_old_target === false) return "thread_identity_conflict";
  if (evidence.second_turn_dispatch_verified === false) return "send_failed";
  if (evidence.second_turn_same_target === false) return "target_changed";
  if (evidence.binding_unchanged === false || evidence.executor_not_persisted === false) {
    return "binding_conflict";
  }
  return "completion_unverifiable";
}

export function aggregateDurableContinuityEvidence(
  evidence: DurableContinuityEvidence,
): DurableContinuityAggregation {
  const structuralPass = evidence.executor_changed
    && evidence.binding_survived_process_restart
    && evidence.target_preserved
    && evidence.host_preserved
    && evidence.phase_b_metadata_uses_new_executor
    && evidence.phase_b_arguments_use_old_target
    && evidence.second_turn_dispatch_verified
    && evidence.second_turn_same_target
    && evidence.binding_unchanged
    && evidence.executor_not_persisted;
  return {
    ...evidence,
    ok: structuralPass,
    result: structuralPass ? "pass" : "fail",
  };
}

export function finalizeDurableContinuityEvidence(
  evidence: DurableContinuityEvidence,
): DurableContinuityAggregation {
  const structural = aggregateDurableContinuityEvidence(evidence);
  const diagnosticPass = structural.ok
    && evidence.second_turn_content_verified === true
    && evidence.completion_observer_verified === true;
  return {
    ...structural,
    ok: diagnosticPass,
    result: diagnosticPass ? "pass" : "fail",
  };
}

function parsePositiveTimeout(value: string, argument: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${argument} requires a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TIMEOUT_MS) {
    throw new Error(`${argument} must be between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  return parsed;
}

function optionValue(argv: readonly string[], index: number, argument: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--") || value.trim() === "") {
    throw new Error(`${argument} requires a value.`);
  }
  return value;
}

export function parseDesktopThreadDurableSmokeArgs(
  argv: readonly string[] = [],
): DesktopThreadDurableSmokeArgs {
  const phase = argv[0] as DesktopThreadDurableSmokePhase | undefined;
  if (phase !== "phase-a" && phase !== "phase-b" && phase !== "cleanup") {
    throw new Error("usage: phase-a | phase-b --run-id <uuid> | cleanup --run-id <uuid>");
  }

  let runId: string | undefined;
  let workspacePath = process.cwd();
  let serverPath: string | undefined;
  let pipePath: string | undefined;
  let desktopIpcPipePath: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let identityTimeoutMs = DEFAULT_IDENTITY_TIMEOUT_MS;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--run-id") {
      runId = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--workspace") {
      workspacePath = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--server") {
      serverPath = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--pipe") {
      pipePath = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--desktop-ipc-pipe") {
      desktopIpcPipePath = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--timeout-ms") {
      timeoutMs = parsePositiveTimeout(optionValue(argv, index, argument), argument);
      index += 1;
    } else if (argument === "--identity-timeout-ms") {
      identityTimeoutMs = parsePositiveTimeout(optionValue(argv, index, argument), argument);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (phase !== "phase-a" && runId === undefined) throw new Error(`${phase} requires --run-id.`);
  if (runId !== undefined) safeRunId(runId);
  return {
    phase,
    ...(runId === undefined ? {} : { runId }),
    workspacePath,
    ...(serverPath === undefined ? {} : { serverPath }),
    ...(pipePath === undefined ? {} : { pipePath }),
    ...(desktopIpcPipePath === undefined ? {} : { desktopIpcPipePath }),
    timeoutMs,
    identityTimeoutMs,
  };
}

function runtimeFailure(error: unknown, connecting: boolean): DesktopThreadDurableSmokeFailureClass {
  if (!connecting) return "tools_list_failed";
  if (error instanceof CodexAppRuntimeError) {
    if (error.code === "runtime_unavailable") return "desktop_not_running";
    if (error.code === "bundle_not_found"
      || error.code === "runtime_contract_incompatible"
      || error.code === "pipe_unavailable") return "runtime_discovery_failed";
    if (error.code === "transport_failed") return "mcp_connect_failed";
  }
  return "mcp_connect_failed";
}

function smokeFailure(error: unknown, fallback: DesktopThreadDurableSmokeFailureClass): SmokeFailure {
  if (error instanceof SmokeFailure) return error;
  return new SmokeFailure(fallback);
}

interface LiveRuntime {
  readonly runtime: CodexAppRuntime;
  readonly contracts: ReturnType<typeof createCodexAppToolContracts>;
  readonly client: Pick<CodexAppMcpClient, "callTool">;
  readonly requests: RequestEvidence[];
}

async function openRuntime(args: DesktopThreadDurableSmokeArgs): Promise<LiveRuntime> {
  let runtime: CodexAppRuntime | undefined;
  try {
    runtime = await CodexAppRuntime.connect({
      ...(args.serverPath === undefined ? {} : { serverPath: args.serverPath }),
      ...(args.pipePath === undefined ? {} : { pipePath: args.pipePath }),
    });
  } catch (error: unknown) {
    throw smokeFailure(error, runtimeFailure(error, true));
  }

  try {
    const listed = await runtime.listTools();
    const tools = listed.tools;
    const requests: RequestEvidence[] = [];
    const callTool: CodexAppMcpClient["callTool"] = (params, resultSchema, options) => {
      const metadata = isRecord(params._meta) ? params._meta : undefined;
      const argumentsValue = params.arguments;
      requests.push({
        tool: params.name,
        executorThreadId: stringField(metadata, EXECUTOR_METADATA_KEY),
        targetThreadId: stringField(argumentsValue, "threadId"),
        hostId: stringField(argumentsValue, "hostId"),
      });
      return runtime!.mcpClient.callTool(params, resultSchema, options);
    };
    return {
      runtime,
      contracts: createCodexAppToolContracts(tools),
      client: { callTool },
      requests,
    };
  } catch (error: unknown) {
    await runtime.close();
    throw smokeFailure(error, runtimeFailure(error, false));
  }
}

async function readDesktopExecutorThreadId(
  options: { readonly pipePath?: string; readonly timeoutMs: number },
  sleep: (milliseconds: number) => Promise<void>,
): Promise<string> {
  const observer = new DesktopIPCObserver({
    clientOptions: options.pipePath === undefined ? undefined : { pipePath: options.pipePath },
    logger: {},
  });
  const deadline = Date.now() + options.timeoutMs;
  observer.start();
  try {
    while (Date.now() < deadline) {
      const state = observer.getState();
      const identity = state.currentConversationId;
      if (state.connected && identity !== undefined && IDENTITY_PATTERN.test(identity)) return identity;
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  } finally {
    observer.dispose();
  }
  throw new SmokeFailure("executor_identity_unavailable");
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => resolve(value).replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function sameBinding(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return [
    "schema_version",
    "workspace_id",
    "task_id",
    "session_id",
    "backend_identity",
    "target_thread_id",
    "host_id",
    "created_at",
    "updated_at",
  ].every((field) => left[field] === right[field]);
}

function containsForbiddenBindingKey(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 8 || (!isRecord(value) && !Array.isArray(value))) return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_BINDING_KEYS.has(key) || containsForbiddenBindingKey(nested, seen, depth + 1)) return true;
    }
    return false;
  }
  return value.some((nested) => containsForbiddenBindingKey(nested, seen, depth + 1));
}

export function bindingExecutorNotPersisted(rawBinding: unknown): boolean {
  return !containsForbiddenBindingKey(rawBinding);
}

async function bindingEvidence(
  store: DesktopThreadBindingStore,
  workspaceId: string,
  sessionId: string,
): Promise<{ readonly binding: Awaited<ReturnType<DesktopThreadBindingStore["load"]>>; readonly executorNotPersisted: boolean }> {
  const binding = await store.load(workspaceId, sessionId);
  if (binding === undefined) return { binding, executorNotPersisted: false };
  const raw = await readFile(desktopThreadBindingFile(store.storageRoot, workspaceId, sessionId), "utf8");
  return {
    binding,
    executorNotPersisted: bindingExecutorNotPersisted(JSON.parse(raw) as unknown),
  };
}

function bindingIdentityMatches(
  binding: Awaited<ReturnType<DesktopThreadBindingStore["load"]>>,
  state: Pick<DesktopThreadDurableSmokeState, "workspace_id" | "task_id" | "session_id">,
): boolean {
  return binding !== undefined
    && binding.workspace_id === state.workspace_id
    && binding.task_id === state.task_id
    && binding.session_id === state.session_id
    && binding.backend_identity === "desktop_codex_app";
}

function failureResult(
  phase: DesktopThreadDurableSmokePhase,
  failureClass: DesktopThreadDurableSmokeFailureClass,
  values: Partial<DesktopThreadDurableSmokeResult> = {},
): DesktopThreadDurableSmokeResult {
  return {
    ok: false,
    phase,
    result: "fail",
    failure_class: failureClass,
    ...values,
  };
}

function executorReadFailure(
  phase: DesktopThreadDurableSmokePhase,
  error: unknown,
  values: Partial<DesktopThreadDurableSmokeResult> = {},
): DesktopThreadDurableSmokeResult {
  return failureResult(
    phase,
    error instanceof SmokeFailure ? error.failureClass : "executor_identity_unavailable",
    values,
  );
}

async function runPhaseA(
  args: DesktopThreadDurableSmokeArgs,
  dependencies: DesktopThreadDurableSmokeDependencies,
): Promise<DesktopThreadDurableSmokeResult> {
  const runId = randomUUID();
  let workspace: WorkspaceManager;
  try {
    workspace = new WorkspaceManager(args.workspacePath);
  } catch {
    return failureResult("phase-a", "workspace_invalid", { run_id: runId });
  }
  const workspacePath = workspace.canonicalRoot;
  const workspaceId = workspace.identity.id;
  const taskId = randomUUID();
  const sessionId = randomUUID();
  const storageRoot = smokeRunDirectory(workspacePath, runId);
  let live: LiveRuntime | undefined;
  try {
    live = await openRuntime(args);
    const readExecutor = dependencies.readExecutorThreadId ?? ((options) => readDesktopExecutorThreadId(
      options,
      dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
    ));
    let executorThreadId: string;
    try {
      executorThreadId = await readExecutor({ pipePath: args.desktopIpcPipePath, timeoutMs: args.identityTimeoutMs });
    } catch (error: unknown) {
      return executorReadFailure("phase-a", error, { run_id: runId });
    }

    const bindings = new DesktopThreadBindingStore(storageRoot);
    await mkdir(storageRoot, { recursive: true, mode: 0o700 });
    if (await bindings.load(workspaceId, sessionId) !== undefined) {
      return failureResult("phase-a", "binding_conflict", { run_id: runId });
    }

    const commands = new DesktopCodexThreadCommands({ client: live.client, contracts: live.contracts });
    let projectResult: CallToolResult;
    try {
      projectResult = await commands.listProjects({ executorThreadId, timeoutMs: args.timeoutMs });
    } catch {
      return failureResult("phase-a", "project_discovery_failed", { run_id: runId });
    }
    let project: ReturnType<typeof resolveDesktopProject>;
    try {
      project = resolveDesktopProject(projectResult, workspacePath);
    } catch (error: unknown) {
      const failureClass = error instanceof CodexAppRuntimeError && error.code === "project_ambiguous"
        ? "project_ambiguous"
        : "project_not_found";
      return failureResult("phase-a", failureClass, { run_id: runId });
    }

    const coordinator = new DesktopThreadCoordinator({ commands, bindings });
    let created;
    try {
      created = await coordinator.createOrReuseThread({
        workspace_id: workspaceId,
        task_id: taskId,
        session_id: sessionId,
        executorThreadId,
        projectId: project.projectId,
        prompt: `Only return LRM_P522C_CREATE_${runId}. Do not modify any files. Do not create commits. Do not push.`,
        timeoutMs: args.timeoutMs,
      });
    } catch (error: unknown) {
      const failureClass = error instanceof CodexAppRuntimeError && error.code === "thread_identity_conflict"
        ? "thread_identity_conflict"
        : error instanceof DesktopThreadCoordinatorError && error.code === "binding_conflict"
          ? "binding_conflict"
          : "create_failed";
      return failureResult("phase-a", failureClass, {
        run_id: runId,
        phase_a_create_thread_count: live.requests.filter((request) => request.tool === "create_thread").length,
      });
    }

    const createCount = live.requests.filter((request) => request.tool === "create_thread").length;
    if (!checkCreateThreadCount(createCount, 1).ok) {
      return failureResult("phase-a", "create_failed", { run_id: runId, phase_a_create_thread_count: createCount });
    }
    const persistedStore = new DesktopThreadBindingStore(storageRoot);
    let persisted: Awaited<ReturnType<DesktopThreadBindingStore["load"]>>;
    let executorNotPersisted: boolean;
    try {
      ({ binding: persisted, executorNotPersisted } = await bindingEvidence(
        persistedStore,
        workspaceId,
        sessionId,
      ));
    } catch {
      return failureResult("phase-a", "binding_conflict", { run_id: runId, phase_a_create_thread_count: createCount });
    }
    if (persisted === undefined) {
      return failureResult("phase-a", "binding_missing_after_phase_a", { run_id: runId, phase_a_create_thread_count: createCount });
    }
    if (!bindingIdentityMatches(persisted, { workspace_id: workspaceId, task_id: taskId, session_id: sessionId })
      || persisted.target_thread_id !== created.target_thread_id
      || persisted.host_id !== created.host_id) {
      return failureResult("phase-a", "binding_identity_mismatch", { run_id: runId, phase_a_create_thread_count: createCount });
    }
    if (!executorNotPersisted) {
      return failureResult("phase-a", "binding_conflict", { run_id: runId, phase_a_create_thread_count: createCount });
    }

    let firstMarkerObserved: boolean;
    try {
      firstMarkerObserved = await waitForAgentMessageMarker({
        client: live.client,
        contracts: live.contracts,
        executorThreadId,
        targetThreadId: created.target_thread_id,
        hostId: created.host_id,
        marker: `LRM_P522C_CREATE_${runId}`,
        timeoutMs: args.timeoutMs,
      });
    } catch {
      return failureResult("phase-a", "completion_unverifiable", {
        run_id: runId,
        phase_a_create_thread_count: createCount,
        binding_persisted: true,
        first_turn_content_verified: "unknown",
        completion_observer_verified: "unknown",
      });
    }
    if (!firstMarkerObserved) {
      return failureResult("phase-a", "completion_unverifiable", {
        run_id: runId,
        phase_a_create_thread_count: createCount,
        binding_persisted: true,
        first_turn_content_verified: "unknown",
        completion_observer_verified: "unknown",
      });
    }
    const state = desktopThreadDurableSmokeStateSchema.parse({
      schema_version: 1,
      run_id: runId,
      workspace_id: workspaceId,
      task_id: taskId,
      session_id: sessionId,
      workspace_path: workspacePath,
      project_id: project.projectId,
      phase_a_executor_thread_id: executorThreadId,
      target_thread_id: created.target_thread_id,
      host_id: created.host_id,
      storage_root: storageRoot,
      created_at: dependencies.now?.() ?? new Date().toISOString(),
    });
    try {
      await writeSmokeState(state);
    } catch {
      return failureResult("phase-a", "state_persistence_failed", {
        run_id: runId,
        phase_a_create_thread_count: createCount,
        binding_persisted: true,
      });
    }
    return {
      ok: true,
      phase: "phase-a",
      result: "pass",
      run_id: runId,
      session_id: sessionId,
      state_path: smokeStateFile(workspacePath, runId),
      target_thread_suffix: threadSuffix(created.target_thread_id),
      executor_thread_suffix: threadSuffix(executorThreadId),
      host_id: created.host_id,
      phase_a_create_thread_count: createCount,
      binding_persisted: true,
      first_turn_content_verified: true,
      completion_observer_verified: "unknown",
    };
  } catch (error: unknown) {
    const failure = smokeFailure(error, "state_persistence_failed");
    return failureResult("phase-a", failure.failureClass, { run_id: runId });
  } finally {
    await live?.runtime.close();
  }
}

async function stateForPhaseB(
  args: DesktopThreadDurableSmokeArgs,
  workspace: WorkspaceManager,
): Promise<{ readonly state: DesktopThreadDurableSmokeState; readonly runDirectory: string } | SmokeFailure> {
  const runId = args.runId!;
  const runDirectory = smokeRunDirectory(workspace.canonicalRoot, runId);
  let state: DesktopThreadDurableSmokeState;
  try {
    state = await readSmokeState(runDirectory);
  } catch (error: unknown) {
    const code = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "state_not_found"
      : "state_invalid";
    return new SmokeFailure(code);
  }
  if (state.run_id !== runId
    || !samePath(state.workspace_path, workspace.canonicalRoot)
    || !samePath(state.storage_root, runDirectory)
    || state.workspace_id !== workspace.identity.id) {
    return new SmokeFailure("state_invalid");
  }
  return { state, runDirectory };
}

async function runPhaseB(
  args: DesktopThreadDurableSmokeArgs,
  dependencies: DesktopThreadDurableSmokeDependencies,
): Promise<DesktopThreadDurableSmokeResult> {
  let workspace: WorkspaceManager;
  try {
    workspace = new WorkspaceManager(args.workspacePath);
  } catch {
    return failureResult("phase-b", "workspace_invalid", { run_id: args.runId });
  }
  const loaded = await stateForPhaseB(args, workspace);
  if (loaded instanceof SmokeFailure) return failureResult("phase-b", loaded.failureClass, { run_id: args.runId });
  const { state } = loaded;
  const bindings = new DesktopThreadBindingStore(state.storage_root);
  let before: Awaited<ReturnType<DesktopThreadBindingStore["load"]>>;
  let beforeExecutorNotPersisted: boolean;
  try {
    ({ binding: before, executorNotPersisted: beforeExecutorNotPersisted } = await bindingEvidence(
      bindings,
      state.workspace_id,
      state.session_id,
    ));
  } catch {
    return failureResult("phase-b", "binding_conflict", { run_id: state.run_id });
  }
  if (before === undefined) return failureResult("phase-b", "binding_missing_after_phase_a", { run_id: state.run_id });
  if (!bindingIdentityMatches(before, state)) {
    return failureResult("phase-b", "binding_identity_mismatch", { run_id: state.run_id });
  }
  const targetCheck = checkTargetPreserved(state.target_thread_id, before.target_thread_id);
  if (!targetCheck.ok) return failureResult("phase-b", "target_changed", { run_id: state.run_id });
  if (before.host_id !== state.host_id) return failureResult("phase-b", "host_changed", { run_id: state.run_id });
  if (!beforeExecutorNotPersisted) return failureResult("phase-b", "binding_conflict", { run_id: state.run_id });

  let live: LiveRuntime | undefined;
  try {
    live = await openRuntime(args);
    const readExecutor = dependencies.readExecutorThreadId ?? ((options) => readDesktopExecutorThreadId(
      options,
      dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
    ));
    let executorThreadId: string;
    try {
      executorThreadId = await readExecutor({ pipePath: args.desktopIpcPipePath, timeoutMs: args.identityTimeoutMs });
    } catch (error: unknown) {
      return executorReadFailure("phase-b", error, { run_id: state.run_id });
    }
    const executorCheck = checkPhaseBExecutorIdentity(
      state.phase_a_executor_thread_id,
      executorThreadId,
      state.target_thread_id,
    );
    if (!executorCheck.ok) {
      return failureResult("phase-b", executorCheck.failure_class!, {
        run_id: state.run_id,
        executor_changed: executorCheck.executor_changed,
        phase_b_create_thread_count: live.requests.filter((request) => request.tool === "create_thread").length,
      });
    }

    const commands = new DesktopCodexThreadCommands({ client: live.client, contracts: live.contracts });
    const coordinator = new DesktopThreadCoordinator({ commands, bindings });
    let reused;
    try {
      reused = await coordinator.createOrReuseThread({
        workspace_id: state.workspace_id,
        task_id: state.task_id,
        session_id: state.session_id,
        executorThreadId,
        projectId: state.project_id,
        prompt: `Only return LRM_P522C_REUSE_${state.run_id}. Do not modify any files. Do not create commits. Do not push.`,
        timeoutMs: args.timeoutMs,
      });
    } catch (error: unknown) {
      const createCount = live.requests.filter((request) => request.tool === "create_thread").length;
      if (createCount > 0) return failureResult("phase-b", "duplicate_create_after_restart", {
        run_id: state.run_id,
        phase_b_create_thread_count: createCount,
      });
      const failureClass = error instanceof DesktopThreadCoordinatorError && error.code === "binding_not_found"
        ? "binding_missing_after_phase_a"
        : error instanceof DesktopThreadCoordinatorError && error.code === "binding_identity_mismatch"
          ? "binding_identity_mismatch"
          : error instanceof DesktopThreadCoordinatorError && error.code === "binding_conflict"
            ? "binding_conflict"
            : "create_failed";
      return failureResult("phase-b", failureClass, {
        run_id: state.run_id,
        phase_b_create_thread_count: createCount,
      });
    }
    const createCount = live.requests.filter((request) => request.tool === "create_thread").length;
    if (!checkCreateThreadCount(createCount, 0).ok) {
      return failureResult("phase-b", "duplicate_create_after_restart", {
        run_id: state.run_id,
        phase_b_create_thread_count: createCount,
      });
    }
    const targetPreserved = reused.target_thread_id === state.target_thread_id;
    const hostPreserved = reused.host_id === state.host_id;
    if (!targetPreserved) return failureResult("phase-b", "target_changed", { run_id: state.run_id, phase_b_create_thread_count: createCount });
    if (!hostPreserved) return failureResult("phase-b", "host_changed", { run_id: state.run_id, phase_b_create_thread_count: createCount });

    const observer = new DesktopCompletionObserver({
      client: live.client,
      contracts: live.contracts,
    });
    let baseline: Awaited<ReturnType<DesktopCompletionObserver["captureBaseline"]>>;
    try {
      baseline = await observer.captureBaseline({
        executorThreadId,
        targetThreadId: state.target_thread_id,
        hostId: state.host_id,
        timeoutMs: args.timeoutMs,
      });
    } catch {
      return failureResult("phase-b", "completion_unverifiable", {
        run_id: state.run_id,
        phase_b_create_thread_count: createCount,
        executor_changed: true,
        target_reuse_verified: true,
      });
    }

    try {
      await coordinator.sendToBoundThread({
        workspace_id: state.workspace_id,
        task_id: state.task_id,
        session_id: state.session_id,
        executorThreadId,
        prompt: `Only return LRM_P522C_RESUME_${state.run_id}. Do not modify any files. Do not create commits. Do not push.`,
        timeoutMs: args.timeoutMs,
      });
    } catch {
      return failureResult("phase-b", "send_failed", {
        run_id: state.run_id,
        phase_b_create_thread_count: createCount,
        executor_changed: true,
        target_reuse_verified: true,
      });
    }
    const sendRequest = [...live.requests].reverse().find((request) => request.tool === "send_message_to_thread");
    const phaseBMetadataUsesNewExecutor = sendRequest?.executorThreadId === executorThreadId;
    const phaseBArgumentsUseOldTarget = sendRequest?.targetThreadId === state.target_thread_id
      && sendRequest.hostId === state.host_id;
    const secondTurnDispatchVerified = sendRequest !== undefined;
    const secondTurnSameTarget = phaseBArgumentsUseOldTarget;
    let completion: DesktopCompletionResult;
    try {
      completion = await observer.waitForCompletion({
        executorThreadId,
        targetThreadId: state.target_thread_id,
        hostId: state.host_id,
        timeoutMs: args.timeoutMs,
        baseline,
      });
    } catch {
      return failureResult("phase-b", "completion_unverifiable", {
        run_id: state.run_id,
        phase_b_create_thread_count: createCount,
        executor_changed: true,
        target_reuse_verified: true,
        phase_b_metadata_uses_new_executor: phaseBMetadataUsesNewExecutor,
        phase_b_arguments_use_old_target: phaseBArgumentsUseOldTarget,
        second_turn_dispatch_verified: secondTurnDispatchVerified,
        second_turn_same_target: secondTurnSameTarget,
        completion_observer_verified: "unknown",
      });
    }
    if (completion.status !== "completed") {
      return failureResult("phase-b", "completion_unverifiable", {
        run_id: state.run_id,
        phase_b_create_thread_count: createCount,
        executor_changed: true,
        target_reuse_verified: true,
        phase_b_metadata_uses_new_executor: phaseBMetadataUsesNewExecutor,
        phase_b_arguments_use_old_target: phaseBArgumentsUseOldTarget,
        second_turn_dispatch_verified: secondTurnDispatchVerified,
        second_turn_same_target: secondTurnSameTarget,
        second_turn_content_verified: "unknown",
        completion_observer_verified: "unknown",
      });
    }

    let secondMarkerObserved: boolean;
    try {
      secondMarkerObserved = await readAgentMessageMarker({
        client: live.client,
        contracts: live.contracts,
        executorThreadId,
        targetThreadId: state.target_thread_id,
        hostId: state.host_id,
        marker: `LRM_P522C_RESUME_${state.run_id}`,
        timeoutMs: args.timeoutMs,
      });
    } catch {
      secondMarkerObserved = false;
    }

    let after: Awaited<ReturnType<DesktopThreadBindingStore["load"]>>;
    let afterExecutorNotPersisted: boolean;
    try {
      ({ binding: after, executorNotPersisted: afterExecutorNotPersisted } = await bindingEvidence(
        new DesktopThreadBindingStore(state.storage_root),
        state.workspace_id,
        state.session_id,
      ));
    } catch {
      return failureResult("phase-b", "binding_conflict", { run_id: state.run_id, phase_b_create_thread_count: createCount });
    }
    const bindingUnchanged = after !== undefined
      && before !== undefined
      && sameBinding(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
    const executorNotPersisted = beforeExecutorNotPersisted && afterExecutorNotPersisted;
    const evidence = finalizeDurableContinuityEvidence({
      executor_changed: true,
      binding_survived_process_restart: after !== undefined,
      target_preserved: targetPreserved,
      host_preserved: hostPreserved,
      phase_b_metadata_uses_new_executor: phaseBMetadataUsesNewExecutor,
      phase_b_arguments_use_old_target: phaseBArgumentsUseOldTarget,
      second_turn_dispatch_verified: secondTurnDispatchVerified,
      second_turn_same_target: secondTurnSameTarget,
      binding_unchanged: bindingUnchanged,
      executor_not_persisted: executorNotPersisted,
      second_turn_content_verified: secondMarkerObserved ? true : "unknown",
      completion_observer_verified: true,
    });
    return {
      ...evidence,
      phase: "phase-b",
      run_id: state.run_id,
      failure_class: evidence.ok ? undefined : failureClassForEvidence(evidence),
      target_thread_suffix: threadSuffix(state.target_thread_id),
      executor_thread_suffix: threadSuffix(executorThreadId),
      host_id: state.host_id,
      phase_a_create_thread_count: 1,
      phase_b_create_thread_count: createCount,
      target_reuse_verified: true,
    };
  } catch (error: unknown) {
    const failure = smokeFailure(error, "send_failed");
    return failureResult("phase-b", failure.failureClass, { run_id: state.run_id });
  } finally {
    await live?.runtime.close();
  }
}

export async function runDesktopThreadDurableSmoke(
  argv: readonly string[] = [],
  dependencies: DesktopThreadDurableSmokeDependencies = {},
): Promise<DesktopThreadDurableSmokeResult> {
  const args = parseDesktopThreadDurableSmokeArgs(argv);
  if (args.phase === "cleanup") {
    await cleanupSmokeRun(args.workspacePath, args.runId!);
    return { ok: true, phase: "cleanup", result: "pass", run_id: args.runId };
  }
  return args.phase === "phase-a" ? runPhaseA(args, dependencies) : runPhaseB(args, dependencies);
}

function valueLine(name: string, value: unknown): string | undefined {
  return value === undefined ? undefined : `${name}: ${String(value)}`;
}

export function formatDesktopThreadDurableSmokeResult(
  result: DesktopThreadDurableSmokeResult,
): string {
  if (result.phase === "cleanup") {
    return [
      `P5.2.2-C CLEANUP: ${result.ok ? "PASS" : "FAIL"}`,
      valueLine("run_id", result.run_id),
    ].filter((line): line is string => line !== undefined).join("\n");
  }
  if (result.phase === "phase-a") {
    const lines = [
      `P5.2.2-C PHASE A: ${result.ok ? "PASS" : "FAIL"}`,
      valueLine("run_id", result.run_id),
      valueLine("session_id", result.session_id),
      valueLine("target_thread_suffix", result.target_thread_suffix),
      valueLine("executor_thread_suffix", result.executor_thread_suffix),
      valueLine("host_id", result.host_id),
      valueLine("create_thread_count", result.phase_a_create_thread_count),
      valueLine("binding_persisted", result.binding_persisted),
      valueLine("first_turn_content_verified", result.first_turn_content_verified),
      valueLine("completion_observer_verified", result.completion_observer_verified),
      valueLine("state_path", result.state_path),
      valueLine("reason", result.failure_class),
    ].filter((line): line is string => line !== undefined);
    if (result.ok) {
      lines.push("NEXT ACTION:");
      lines.push("在 ChatGPT Desktop 中新建一个新的普通对话，使 executor context 发生变化。");
      lines.push(`完成后运行：npm run diagnostic:p522c -- phase-b --run-id ${result.run_id}`);
    }
    return lines.join("\n");
  }
  return [
    `P5.2.2-C RESULT: ${result.ok ? "PASS" : "FAIL"}`,
    valueLine("phase_a_create_thread_count", result.phase_a_create_thread_count),
    valueLine("phase_b_create_thread_count", result.phase_b_create_thread_count),
    valueLine("executor_changed", result.executor_changed),
    valueLine("binding_survived_process_restart", result.binding_survived_process_restart),
    valueLine("target_preserved", result.target_preserved),
    valueLine("host_preserved", result.host_preserved),
    valueLine("phase_b_metadata_uses_new_executor", result.phase_b_metadata_uses_new_executor),
    valueLine("phase_b_arguments_use_old_target", result.phase_b_arguments_use_old_target),
    valueLine("second_turn_dispatch_verified", result.second_turn_dispatch_verified),
    valueLine("second_turn_same_target", result.second_turn_same_target),
    valueLine("second_turn_content_verified", result.second_turn_content_verified),
    valueLine("completion_observer_verified", result.completion_observer_verified),
    valueLine("binding_unchanged", result.binding_unchanged),
    valueLine("executor_not_persisted", result.executor_not_persisted),
    valueLine("reason", result.failure_class),
  ].filter((line): line is string => line !== undefined).join("\n");
}
