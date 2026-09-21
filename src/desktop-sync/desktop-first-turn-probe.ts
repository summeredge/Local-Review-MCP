import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CodexAppRuntime,
  CodexAppRuntimeError,
  type CodexAppMcpClient,
  type CodexAppRuntimeMetadata,
} from "../desktop-codex/codex-app-runtime.js";
import { createCodexAppToolContracts } from "../desktop-codex/codex-app-contracts.js";
import {
  DesktopCompletionObserver,
  DesktopCompletionObserverError,
  type DesktopCompletionResult,
  type DesktopCompletionStatus,
  type DesktopCompletionUnknownReason,
} from "../desktop-codex/completion-observer.js";
import { DesktopCodexThreadCommands } from "../desktop-codex/thread-commands.js";
import { resolveDesktopProject } from "../desktop-codex/desktop-project-resolver.js";
import { DesktopIPCObserver } from "./desktop-ipc-observer.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 120_000;
const READ_CALL_TIMEOUT_MS = 10_000;
const PROBE_DIRECTORY = [".review", "p5-4-1-first-turn-probe"] as const;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUIRED_ARTIFACTS = [
  "requests.json",
  "create-result.json",
  "read-results.json",
  "wait-results.json",
  "observer-result.json",
  "tool-read_thread.json",
  "tool-wait_threads.json",
] as const;

type JsonRecord = Record<string, unknown>;

/** Minimal runtime surface used by the probe; CodexAppRuntime is structurally compatible. */
export interface DesktopFirstTurnProbeRuntime {
  readonly info: CodexAppRuntimeMetadata;
  listTools(signal?: AbortSignal): Promise<{ readonly tools: readonly Tool[] }>;
  readonly mcpClient: Pick<CodexAppMcpClient, "callTool">;
  close(): Promise<void>;
}

export interface DesktopFirstTurnProbeArgs {
  readonly confirmEffectful: boolean;
  readonly timeoutMs: number;
  readonly workspacePath: string;
  readonly serverPath?: string;
  readonly pipePath?: string;
}

export interface DesktopFirstTurnProbeDependencies {
  /** Test/embedded seam; production discovery is used when omitted. */
  readonly connectRuntime?: (
    options: { readonly serverPath?: string; readonly pipePath?: string },
  ) => Promise<DesktopFirstTurnProbeRuntime>;
  /** Test seam for the Desktop executor identity; production reads the IPC observer. */
  readonly readExecutorThreadId?: (
    options: { readonly pipePath?: string; readonly timeoutMs: number },
  ) => Promise<string>;
  /** Test seam overriding the resolved workspace root for artifact placement. */
  readonly workspacePath?: string;
}

export type DesktopFirstTurnProbeFailure =
  | "effectful_confirmation_required"
  | "runtime_connect_failed"
  | "tools_list_failed"
  | "executor_identity_unavailable"
  | "project_discovery_failed"
  | "project_not_found"
  | "project_ambiguous"
  | "create_failed"
  | "probe_interrupted"
  | "probe_failed";

export interface DesktopFirstTurnProbeClassification {
  readonly read_thread_tool_error: boolean;
  readonly wait_threads_tool_error: boolean;
  readonly turn_error: boolean;
  readonly malformed_response: boolean;
  readonly timeout: boolean;
  readonly completed: boolean;
}

export interface DesktopFirstTurnProbeResult {
  readonly ok: boolean;
  readonly run_id: string;
  readonly artifact_dir: string;
  readonly report_path: string;
  readonly failure_class?: DesktopFirstTurnProbeFailure;
  readonly observer_status?: DesktopCompletionStatus;
  readonly observer_reason?: DesktopCompletionUnknownReason;
  readonly first_read_is_error: boolean;
  readonly first_wait_is_error: boolean;
  readonly turn_error_observed: boolean;
  readonly target_thread_suffix?: string;
  readonly executor_thread_suffix?: string;
}

interface ProbeFailureShape {
  readonly name: string;
  readonly code?: string;
}

interface RecordedRequest {
  readonly index: number;
  readonly name: string;
  readonly arguments: unknown;
  readonly meta?: unknown;
}

interface RecordedOutcome {
  readonly index: number;
  readonly name: string;
  readonly result?: unknown;
  readonly error?: ProbeFailureShape;
  readonly isError?: boolean;
}

interface ProbeState {
  readonly runId: string;
  readonly artifactDir: string;
  readonly workspacePath: string;
  readonly requests: RecordedRequest[];
  /** Raw outcome for every recorded tool call, including create_thread and list_projects. */
  readonly outcomes: RecordedOutcome[];
  readonly readOutcomes: RecordedOutcome[];
  readonly waitOutcomes: RecordedOutcome[];
  runtime?: JsonRecord;
  tools: readonly Tool[];
  readTool?: Tool;
  waitTool?: Tool;
  executorThreadId?: string;
  targetThreadId?: string;
  hostId?: string;
  baseline?: { readonly targetThreadId: string; readonly hostId: string; readonly turnIds: readonly string[] };
  observerResult?: DesktopCompletionResult;
  observerError?: ProbeFailureShape;
  stage: string;
  failureClass?: DesktopFirstTurnProbeFailure;
}

class ProbeFailure extends Error {
  public constructor(
    public readonly failureClass: DesktopFirstTurnProbeFailure,
    message = failureClass,
  ) {
    super(message);
    this.name = "ProbeFailure";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function safeError(error: unknown): ProbeFailureShape {
  if (error instanceof CodexAppRuntimeError) return { name: error.name, code: error.code };
  if (error instanceof DesktopCompletionObserverError) return { name: error.name, code: error.reason };
  if (error instanceof ProbeFailure) return { name: error.name, code: error.failureClass };
  if (error instanceof Error) return { name: error.name };
  return { name: "UnknownError" };
}

function artifactFile(runDirectory: string, name: string): string {
  return join(runDirectory, name);
}

async function writeJsonArtifact(runDirectory: string, name: string, value: unknown): Promise<void> {
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await writeFile(artifactFile(runDirectory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeDesktopFirstTurnProbeToolArtifact(
  runDirectory: string,
  toolName: string,
  tool: Tool | undefined,
): Promise<void> {
  await writeJsonArtifact(runDirectory, `tool-${toolName}.json`, tool ?? { available: false });
}

export function desktopFirstTurnProbeRunDirectory(workspacePath: string, runId: string): string {
  if (!UUID_PATTERN.test(runId)) throw new Error("run_id must be a UUID.");
  return join(resolve(workspacePath), ...PROBE_DIRECTORY, runId);
}

export function parseDesktopFirstTurnProbeArgs(
  argv: readonly string[] = [],
  cwd = process.cwd(),
): DesktopFirstTurnProbeArgs {
  let confirmEffectful = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let serverPath: string | undefined;
  let pipePath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--confirm-effectful") {
      confirmEffectful = true;
      continue;
    }
    if (argument === "--timeout-ms") {
      const raw = argv[index + 1];
      const value = Number(raw);
      if (raw === undefined || !Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
        throw new Error(`--timeout-ms must be between 1 and ${MAX_TIMEOUT_MS}.`);
      }
      timeoutMs = value;
      index += 1;
      continue;
    }
    if (argument === "--server" || argument === "--pipe") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--") || value.trim() === "") {
        throw new Error(`${argument} requires a value.`);
      }
      if (argument === "--server") serverPath = value;
      else pipePath = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return {
    confirmEffectful,
    timeoutMs,
    workspacePath: resolve(cwd),
    ...(serverPath === undefined ? {} : { serverPath }),
    ...(pipePath === undefined ? {} : { pipePath }),
  };
}

function embeddedPayload(result: unknown): JsonRecord | undefined {
  if (!isRecord(result) || result.isError === true) return undefined;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const first = content[0];
  if (!isRecord(first) || first.type !== "text" || typeof first.text !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(first.text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function outcomeIsError(outcome: RecordedOutcome | undefined): boolean {
  if (outcome === undefined) return false;
  if (outcome.error !== undefined) return true;
  return isRecord(outcome.result) && outcome.result.isError === true;
}

function turnErrorObserved(outcome: RecordedOutcome): boolean {
  const payload = embeddedPayload(outcome.result);
  if (payload === undefined) return false;
  const turns = payload.turns;
  if (!Array.isArray(turns)) return false;
  return turns.some((turn) => isRecord(turn) && turn.error !== null && turn.error !== undefined);
}

function malformedObserved(outcome: RecordedOutcome): boolean {
  if (outcome.result === undefined || outcomeIsError(outcome)) return false;
  return embeddedPayload(outcome.result) === undefined;
}

function makeRecordingClient(
  runtime: DesktopFirstTurnProbeRuntime,
  state: ProbeState,
): Pick<CodexAppMcpClient, "callTool"> {
  return {
    callTool: (...args: Parameters<CodexAppMcpClient["callTool"]>) => {
      const [params] = args;
      const index = state.requests.length + 1;
      state.requests.push({
        index,
        name: params.name,
        arguments: params.arguments ?? {},
        ...(params._meta === undefined ? {} : { meta: params._meta }),
      });
      const record = (outcome: RecordedOutcome): void => {
        state.outcomes.push(outcome);
        if (params.name === "read_thread") state.readOutcomes.push(outcome);
        else if (params.name === "wait_threads") state.waitOutcomes.push(outcome);
      };
      return runtime.mcpClient.callTool(...args).then((result) => {
        record({
          index,
          name: params.name,
          result,
          isError: isRecord(result) && result.isError === true,
        });
        return result;
      }).catch((error: unknown) => {
        record({ index, name: params.name, error: safeError(error) });
        throw error;
      });
    },
  };
}

function lastResult(state: ProbeState, name: string): unknown {
  const matches = state.outcomes
    .filter((outcome) => outcome.name === name && outcome.result !== undefined);
  return matches.at(-1)?.result;
}

/**
 * create-result.json must always come from the real create_thread CallToolResult. When the call
 * never returned a result (runtime error or throw), the recorded error is preserved instead of
 * reconstructing anything from the parsed thread identity.
 */
function createResultValue(state: ProbeState, error?: unknown): unknown {
  const outcome = state.outcomes.filter((entry) => entry.name === "create_thread").at(-1);
  if (outcome?.result !== undefined) return outcome.result;
  if (outcome?.error !== undefined) return { available: false, error: outcome.error };
  if (error !== undefined) return { available: false, error: safeError(error) };
  return { available: false, reason: state.failureClass ?? "not_observed" };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function readExecutorThreadId(
  options: { readonly pipePath?: string; readonly timeoutMs: number },
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
      const identity = nonEmpty(state.currentConversationId);
      if (state.connected && identity !== undefined && IDENTITY_PATTERN.test(identity)) return identity;
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  } finally {
    observer.dispose();
  }
  throw new ProbeFailure("executor_identity_unavailable");
}

function classify(state: ProbeState): DesktopFirstTurnProbeClassification {
  const readToolError = state.readOutcomes.some((outcome) => outcomeIsError(outcome));
  const waitToolError = state.waitOutcomes.some((outcome) => outcomeIsError(outcome));
  const turnError = state.readOutcomes.some((outcome) => turnErrorObserved(outcome));
  const malformed = state.readOutcomes.some((outcome) => malformedObserved(outcome))
    || state.observerResult?.reason === "malformed_response"
    || state.observerError?.code === "malformed_response";
  return {
    read_thread_tool_error: readToolError,
    wait_threads_tool_error: waitToolError,
    turn_error: turnError,
    malformed_response: malformed,
    timeout: state.observerResult?.status === "timed_out",
    completed: state.observerResult?.status === "completed",
  };
}

function firstIsError(outcomes: readonly RecordedOutcome[]): boolean {
  return outcomeIsError(outcomes[0]);
}

function toolContractSection(name: string, tool: Tool | undefined): string {
  if (tool === undefined) return `### ${name}\n\n{ "available": false }`;
  return [`### ${name}`, "```json", JSON.stringify(tool, null, 2), "```"].join("\n");
}

function summarizeResult(result: unknown): JsonRecord {
  if (!isRecord(result)) return { available: false };
  const content = Array.isArray(result.content) ? result.content : [];
  return {
    isError: result.isError === true,
    contentItemTypes: [...new Set(content.filter(isRecord).map((item) => item.type).filter((type) => typeof type === "string"))],
    structuredContentPresent: result.structuredContent !== undefined,
  };
}

function formatReport(state: ProbeState): string {
  const classification = classify(state);
  const readLines = state.readOutcomes.length === 0
    ? ["- no read_thread calls were observed"]
    : state.readOutcomes.map((outcome) => `- call #${outcome.index}: ${JSON.stringify(
      outcome.error === undefined ? summarizeResult(outcome.result) : { error: outcome.error },
    )}`);
  const waitLines = state.waitOutcomes.length === 0
    ? ["- no wait_threads calls were observed"]
    : state.waitOutcomes.map((outcome) => `- call #${outcome.index}: ${JSON.stringify(
      outcome.error === undefined ? summarizeResult(outcome.result) : { error: outcome.error },
    )}`);
  return [
    "# P5.4.1-D Create-Thread First-Turn Completion Probe",
    "",
    `run_id: ${state.runId}`,
    `probe_status: ${state.failureClass === undefined ? "completed" : "failed"}`,
    `failure_class: ${state.failureClass ?? "none"}`,
    `artifact_dir: ${state.artifactDir}`,
    `stage: ${state.stage}`,
    "",
    "## 1. Runtime",
    "",
    "```json",
    JSON.stringify(state.runtime ?? { observed: false }, null, 2),
    "```",
    `workspace_path: ${state.workspacePath}`,
    `executor_thread_suffix: ${state.executorThreadId?.slice(-8) ?? "not observed"}`,
    `target_thread_suffix: ${state.targetThreadId?.slice(-8) ?? "not observed"}`,
    `host_id: ${state.hostId ?? "not observed"}`,
    "",
    "## 2. Raw Probe Sequence",
    "",
    "1. CodexAppRuntime.connect()",
    "2. tools/list",
    "3. DesktopIPCObserver.currentConversationId (executor thread id)",
    "4. list_projects",
    "5. create_thread(prompt)",
    "6. captureBaseline was NOT called",
    "7. baseline constructed as { targetThreadId, hostId, turnIds: [] }",
    "8. DesktopCompletionObserver.waitForCompletion()",
    "",
    "## 3. Observed Tool Contracts",
    "",
    toolContractSection("read_thread", state.readTool),
    "",
    toolContractSection("wait_threads", state.waitTool),
    "",
    "## 4. Baseline",
    "",
    "```json",
    JSON.stringify(state.baseline ?? { available: false }, null, 2),
    "```",
    "",
    "## 5. read_thread Calls",
    "",
    readLines.join("\n"),
    "",
    "## 6. wait_threads Calls",
    "",
    waitLines.join("\n"),
    "",
    "## 7. Observer Result",
    "",
    "```json",
    JSON.stringify(state.observerResult ?? state.observerError ?? { available: false }, null, 2),
    "```",
    "",
    "## 8. Classification",
    "",
    `read_thread_tool_error: ${classification.read_thread_tool_error}`,
    `wait_threads_tool_error: ${classification.wait_threads_tool_error}`,
    `turn_error: ${classification.turn_error}`,
    `malformed_response: ${classification.malformed_response}`,
    `timeout: ${classification.timeout}`,
    `completed: ${classification.completed}`,
    "",
    "## 9. Guardrails",
    "",
    "- captureBaseline was not called; the baseline was constructed as an empty turnIds list.",
    "- No retry or workaround logic is applied; the Observer decision is reported verbatim.",
    "- No pipe path is recorded or printed in any artifact.",
    "",
  ].join("\n");
}

async function ensureArtifactFiles(state: ProbeState): Promise<void> {
  const unavailable = { available: false, reason: state.failureClass ?? "not_observed" };
  const defaults: Record<(typeof REQUIRED_ARTIFACTS)[number], unknown> = {
    "requests.json": state.requests,
    "create-result.json": createResultValue(state),
    "read-results.json": state.readOutcomes,
    "wait-results.json": state.waitOutcomes,
    "observer-result.json": state.observerResult ?? state.observerError ?? unavailable,
    "tool-read_thread.json": state.readTool ?? unavailable,
    "tool-wait_threads.json": state.waitTool ?? unavailable,
  };
  for (const name of REQUIRED_ARTIFACTS) {
    try {
      await readFile(artifactFile(state.artifactDir, name), "utf8");
    } catch {
      await writeJsonArtifact(state.artifactDir, name, defaults[name]);
    }
  }
}

async function runProbe(
  args: DesktopFirstTurnProbeArgs,
  dependencies: DesktopFirstTurnProbeDependencies,
  state: ProbeState,
  signal: AbortSignal,
): Promise<void> {
  if (!args.confirmEffectful) throw new ProbeFailure("effectful_confirmation_required");
  const connectRuntime = dependencies.connectRuntime
    ?? ((options) => CodexAppRuntime.connect(options));
  const readExecutor = dependencies.readExecutorThreadId ?? readExecutorThreadId;
  let runtime: DesktopFirstTurnProbeRuntime | undefined;
  try {
    state.stage = "connect_runtime";
    runtime = await connectRuntime({
      ...(args.serverPath === undefined ? {} : { serverPath: args.serverPath }),
      ...(args.pipePath === undefined ? {} : { pipePath: args.pipePath }),
    });
    state.runtime = {
      desktopDetected: runtime.info.desktopDetected,
      bundleDetected: runtime.info.bundleDetected,
      mcpTransport: runtime.info.mcpTransport,
      nativeDesktopTransport: runtime.info.nativeDesktopTransport,
      desktopVersion: runtime.info.desktopVersion,
      codexVersion: runtime.info.codexVersion,
      codexAppToolsVersion: runtime.info.codexAppToolsVersion,
      pipeDiscovery: runtime.info.pipeDiscovery,
    };

    state.stage = "tools_list";
    let listed: { readonly tools: readonly Tool[] };
    try {
      listed = await runtime.listTools(signal);
    } catch (error: unknown) {
      if (signal.aborted) throw new ProbeFailure("probe_interrupted");
      if (error instanceof CodexAppRuntimeError && error.code === "transport_failed") {
        throw new ProbeFailure("runtime_connect_failed");
      }
      throw new ProbeFailure("tools_list_failed");
    }
    state.tools = listed.tools;
    state.readTool = listed.tools.find((tool) => tool.name === "read_thread");
    state.waitTool = listed.tools.find((tool) => tool.name === "wait_threads");
    await writeDesktopFirstTurnProbeToolArtifact(state.artifactDir, "read_thread", state.readTool);
    await writeDesktopFirstTurnProbeToolArtifact(state.artifactDir, "wait_threads", state.waitTool);

    const contracts = createCodexAppToolContracts(listed.tools);
    contracts.requireListProjects();
    const client = makeRecordingClient(runtime, state);
    const commands = new DesktopCodexThreadCommands({ client, contracts });

    state.stage = "executor_identity";
    try {
      state.executorThreadId = await readExecutor({
        ...(args.pipePath === undefined ? {} : { pipePath: args.pipePath }),
        timeoutMs: args.timeoutMs,
      });
    } catch (error: unknown) {
      if (error instanceof ProbeFailure) throw error;
      throw new ProbeFailure("executor_identity_unavailable");
    }

    state.stage = "list_projects";
    let projectResult: CallToolResult;
    try {
      projectResult = await commands.listProjects({
        executorThreadId: state.executorThreadId,
        signal,
        timeoutMs: Math.min(READ_CALL_TIMEOUT_MS, args.timeoutMs),
      });
      await writeJsonArtifact(state.artifactDir, "list-projects-result.json", projectResult);
    } catch (error: unknown) {
      await writeJsonArtifact(
        state.artifactDir,
        "list-projects-result.json",
        lastResult(state, "list_projects") ?? { available: false, error: safeError(error) },
      );
      if (signal.aborted) throw new ProbeFailure("probe_interrupted");
      throw new ProbeFailure("project_discovery_failed");
    }
    let projectId: string;
    try {
      projectId = resolveDesktopProject(projectResult, state.workspacePath).projectId;
    } catch (error: unknown) {
      if (error instanceof CodexAppRuntimeError && error.code === "project_ambiguous") {
        throw new ProbeFailure("project_ambiguous");
      }
      throw new ProbeFailure("project_not_found");
    }

    const marker = `LRM_P541_FIRST_TURN_${state.runId}`;
    const createPrompt = `Only return ${marker}. Do not modify files. Do not create commits. Do not push.`;
    state.stage = "create_thread";
    let identity: { readonly targetThreadId: string; readonly hostId: string };
    try {
      identity = await commands.createThread({
        executorThreadId: state.executorThreadId,
        projectId,
        prompt: createPrompt,
        signal,
        timeoutMs: Math.min(READ_CALL_TIMEOUT_MS, args.timeoutMs),
      });
    } catch (error: unknown) {
      await writeJsonArtifact(
        state.artifactDir,
        "create-result.json",
        createResultValue(state, error),
      );
      if (signal.aborted) throw new ProbeFailure("probe_interrupted");
      throw new ProbeFailure("create_failed");
    }
    state.targetThreadId = identity.targetThreadId;
    state.hostId = identity.hostId;
    await writeJsonArtifact(
      state.artifactDir,
      "create-result.json",
      createResultValue(state),
    );

    // Production creates the target and immediately observes against an empty baseline.
    state.stage = "wait_for_completion";
    state.baseline = {
      targetThreadId: state.targetThreadId,
      hostId: state.hostId,
      turnIds: [],
    };
    const observer = new DesktopCompletionObserver({ client, contracts });
    try {
      state.observerResult = await observer.waitForCompletion({
        executorThreadId: state.executorThreadId,
        targetThreadId: state.targetThreadId,
        hostId: state.hostId,
        timeoutMs: args.timeoutMs,
        signal,
        baseline: state.baseline,
      });
    } catch (error: unknown) {
      state.observerError = safeError(error);
    }
  } finally {
    await runtime?.close().catch(() => undefined);
  }
}

export async function runDesktopFirstTurnProbe(
  argv: readonly string[] = [],
  dependencies: DesktopFirstTurnProbeDependencies = {},
): Promise<DesktopFirstTurnProbeResult> {
  const args = parseDesktopFirstTurnProbeArgs(argv);
  const workspacePath = resolve(dependencies.workspacePath ?? args.workspacePath);
  const runId = randomUUID();
  const artifactDir = desktopFirstTurnProbeRunDirectory(workspacePath, runId);
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const state: ProbeState = {
    runId,
    artifactDir,
    workspacePath,
    requests: [],
    outcomes: [],
    readOutcomes: [],
    waitOutcomes: [],
    tools: [],
    stage: "preflight",
  };
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    try {
      await runProbe(args, dependencies, state, controller.signal);
    } catch (error: unknown) {
      state.failureClass = error instanceof ProbeFailure
        ? error.failureClass
        : controller.signal.aborted
          ? "probe_interrupted"
          : "probe_failed";
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await writeJsonArtifact(artifactDir, "requests.json", state.requests);
    await writeJsonArtifact(artifactDir, "read-results.json", state.readOutcomes);
    await writeJsonArtifact(artifactDir, "wait-results.json", state.waitOutcomes);
    await writeJsonArtifact(
      artifactDir,
      "observer-result.json",
      state.observerResult ?? state.observerError ?? { available: false },
    );
    await ensureArtifactFiles(state);
    await writeFile(join(artifactDir, "report.md"), `${formatReport(state)}\n`, "utf8");
  }
  const classification = classify(state);
  return {
    ok: state.failureClass === undefined,
    run_id: runId,
    artifact_dir: artifactDir,
    report_path: artifactFile(artifactDir, "report.md"),
    ...(state.failureClass === undefined ? {} : { failure_class: state.failureClass }),
    ...(state.observerResult === undefined ? {} : { observer_status: state.observerResult.status }),
    ...(state.observerResult?.reason === undefined ? {} : { observer_reason: state.observerResult.reason }),
    first_read_is_error: firstIsError(state.readOutcomes),
    first_wait_is_error: firstIsError(state.waitOutcomes),
    turn_error_observed: classification.turn_error,
    ...(state.targetThreadId === undefined ? {} : { target_thread_suffix: state.targetThreadId.slice(-8) }),
    ...(state.executorThreadId === undefined ? {} : { executor_thread_suffix: state.executorThreadId.slice(-8) }),
  };
}
