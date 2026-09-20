import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  callCodexAppTool,
  CodexAppRuntime,
  CodexAppRuntimeError,
  type CodexAppMcpClient,
} from "../desktop-codex/codex-app-runtime.js";
import { createCodexAppToolContracts } from "../desktop-codex/codex-app-contracts.js";
import { DesktopCodexThreadCommands } from "../desktop-codex/thread-commands.js";
import { resolveDesktopProject } from "../desktop-codex/desktop-project-resolver.js";
import { DesktopIPCObserver } from "./desktop-ipc-observer.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 120_000;
const READ_CALL_TIMEOUT_MS = 10_000;
const WAIT_CALL_TIMEOUT_MS = 30_000;
const POLL_DELAY_MS = 500;
const PROBE_DIRECTORY = [".review", "p5-3-0-b-contract-probe"] as const;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CANDIDATE_FIELDS = new Set([
  "turnId",
  "turn_id",
  "id",
  "sequence",
  "turnIndex",
  "cursor",
  "nextCursor",
  "hasMore",
  "revision",
  "changed",
  "timedOut",
  "wake",
  "latestTurn",
  "latestAssistantMessageId",
  "status",
  "state",
  "turnStatus",
  "turn_status",
  "turnCompleted",
  "createdAt",
  "completedAt",
  "role",
  "message",
  "output",
  "latestAssistantMessage",
  "errors",
]);

type JsonRecord = Record<string, unknown>;
type JsonSchema = Readonly<Record<string, unknown>>;

export interface DesktopCompletionContractProbeArgs {
  readonly confirmEffectful: boolean;
  readonly timeoutMs: number;
  readonly workspacePath: string;
  readonly serverPath?: string;
  readonly pipePath?: string;
}

export type DesktopCompletionContractProbeFailure =
  | "effectful_confirmation_required"
  | "executor_identity_unavailable"
  | "tools_list_failed"
  | "completion_tool_unavailable"
  | "completion_tool_schema_incompatible"
  | "project_discovery_failed"
  | "project_not_found"
  | "project_ambiguous"
  | "create_failed"
  | "first_turn_not_readable"
  | "send_failed"
  | "second_turn_not_readable"
  | "probe_interrupted"
  | "probe_failed";

export interface DesktopCompletionContractProbeResult {
  readonly ok: boolean;
  readonly run_id: string;
  readonly artifact_dir: string;
  readonly report_path: string;
  readonly failure_class?: DesktopCompletionContractProbeFailure;
  readonly target_thread_suffix?: string;
  readonly executor_thread_suffix?: string;
}

interface ToolPlan {
  readonly name: "wait_threads" | "read_thread";
  readonly build: (targetThreadId: string, hostId: string, timeoutMs: number) => Record<string, unknown>;
}

interface ProbeFailureShape {
  readonly name: string;
  readonly code?: string;
}

class ProbeFailure extends Error {
  public constructor(
    public readonly failureClass: DesktopCompletionContractProbeFailure,
    message = failureClass,
  ) {
    super(message);
    this.name = "ProbeFailure";
  }
}

interface ToolResponseRecord {
  readonly name: string;
  readonly result?: unknown;
  readonly error?: ProbeFailureShape;
}

interface ProbeState {
  readonly runId: string;
  readonly artifactDir: string;
  readonly workspacePath: string;
  readonly requests: unknown[];
  readonly responses: ToolResponseRecord[];
  readonly snapshots: {
    baseline?: unknown;
    immediate?: unknown;
    wait?: unknown;
    final?: unknown;
  };
  runtime?: Record<string, unknown>;
  tools?: readonly Tool[];
  waitTool?: Tool;
  readTool?: Tool;
  executorThreadId?: string;
  targetThreadId?: string;
  hostId?: string;
  firstMarkerPaths: string[];
  secondMarkerPaths: string[];
  stage: string;
  failureClass?: DesktopCompletionContractProbeFailure;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaRecord(value: unknown): JsonSchema | undefined {
  return isRecord(value) ? value : undefined;
}

function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  const source = isRecord(schema.properties) ? schema.properties : {};
  const result: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(source)) {
    const property = schemaRecord(value);
    if (property !== undefined) result[key] = property;
  }
  return result;
}

function requiredFields(schema: JsonSchema): readonly string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
}

function schemaType(schema: JsonSchema | undefined, type: string): boolean {
  if (schema === undefined) return false;
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function stringSchema(schema: JsonSchema | undefined): boolean {
  if (schema === undefined) return false;
  if (schemaType(schema, "string")) return true;
  return Array.isArray(schema.enum) && schema.enum.length > 0
    && schema.enum.every((value) => typeof value === "string");
}

function numberSchema(schema: JsonSchema | undefined): boolean {
  return schemaType(schema, "integer") || schemaType(schema, "number");
}

function booleanSchema(schema: JsonSchema | undefined): boolean {
  return schemaType(schema, "boolean");
}

function boundedSchemaNumber(schema: JsonSchema, fallback: number): number {
  const minimum = typeof schema.minimum === "number" && Number.isFinite(schema.minimum)
    ? Math.ceil(schema.minimum)
    : 1;
  const maximum = typeof schema.maximum === "number" && Number.isFinite(schema.maximum)
    ? Math.floor(schema.maximum)
    : Number.MAX_SAFE_INTEGER;
  return Math.max(minimum, Math.min(maximum, fallback));
}

function safeIdentity(value: unknown): string | undefined {
  return typeof value === "string" && IDENTITY_PATTERN.test(value.trim()) ? value.trim() : undefined;
}

function safeError(error: unknown): ProbeFailureShape {
  if (error instanceof CodexAppRuntimeError) return { name: error.name, code: error.code };
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

export async function writeDesktopCompletionContractProbeToolArtifact(
  runDirectory: string,
  toolName: string,
  tool: Tool | undefined,
): Promise<void> {
  await writeJsonArtifact(runDirectory, `tool-${toolName}.json`, tool ?? { available: false });
}

export function desktopCompletionContractProbeRunDirectory(
  workspacePath: string,
  runId: string,
): string {
  if (!UUID_PATTERN.test(runId)) throw new Error("run_id must be a UUID.");
  return join(resolve(workspacePath), ...PROBE_DIRECTORY, runId);
}

export async function cleanupDesktopCompletionContractProbeRun(
  workspacePath: string,
  runId: string,
): Promise<void> {
  const root = join(resolve(workspacePath), ...PROBE_DIRECTORY);
  const target = desktopCompletionContractProbeRunDirectory(workspacePath, runId);
  if (dirname(target) !== root) throw new Error("Invalid contract probe cleanup target.");
  await rm(target, { recursive: true, force: true });
}

export function parseDesktopCompletionContractProbeArgs(
  argv: readonly string[] = [],
  cwd = process.cwd(),
): DesktopCompletionContractProbeArgs {
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

function readPlan(tool: Tool | undefined): ToolPlan | undefined {
  if (tool === undefined) return undefined;
  const schema = schemaRecord(tool.inputSchema);
  if (schema === undefined) return undefined;
  const properties = schemaProperties(schema);
  const allowed = new Set(["threadId", "hostId", "cursor", "turnLimit", "includeOutputs", "maxOutputCharsPerItem"]);
  if (requiredFields(schema).some((field) => !allowed.has(field))) return undefined;
  if (!stringSchema(properties.threadId)) return undefined;
  if (requiredFields(schema).includes("hostId") && !stringSchema(properties.hostId)) return undefined;
  if (requiredFields(schema).includes("cursor")) return undefined;
  if (properties.hostId !== undefined && !stringSchema(properties.hostId)) return undefined;
  if (properties.turnLimit !== undefined && !numberSchema(properties.turnLimit)) return undefined;
  if (properties.includeOutputs !== undefined && !booleanSchema(properties.includeOutputs)) return undefined;
  if (properties.maxOutputCharsPerItem !== undefined && !numberSchema(properties.maxOutputCharsPerItem)) return undefined;
  return {
    name: "read_thread",
    build: (targetThreadId, hostId) => ({
      threadId: targetThreadId,
      ...(properties.hostId === undefined ? {} : { hostId }),
      ...(properties.turnLimit === undefined ? {} : { turnLimit: boundedSchemaNumber(properties.turnLimit, 10) }),
      ...(properties.includeOutputs === undefined ? {} : { includeOutputs: true }),
      ...(properties.maxOutputCharsPerItem === undefined
        ? {}
        : { maxOutputCharsPerItem: boundedSchemaNumber(properties.maxOutputCharsPerItem, 20_000) }),
    }),
  };
}

function waitPlan(tool: Tool | undefined): ToolPlan | undefined {
  if (tool === undefined) return undefined;
  const schema = schemaRecord(tool.inputSchema);
  if (schema === undefined) return undefined;
  const properties = schemaProperties(schema);
  const allowed = new Set(["targets", "timeoutMs"]);
  if (requiredFields(schema).some((field) => !allowed.has(field))) return undefined;
  const targets = schemaRecord(properties.targets);
  const item = targets === undefined ? undefined : schemaRecord(targets.items);
  if (!schemaType(targets, "array") || item === undefined) return undefined;
  const itemProperties = schemaProperties(item);
  const targetAllowed = new Set(["threadId", "hostId", "afterCursor"]);
  if (requiredFields(item).some((field) => !targetAllowed.has(field))) return undefined;
  if (!stringSchema(itemProperties.threadId)) return undefined;
  if (requiredFields(item).includes("hostId") && !stringSchema(itemProperties.hostId)) return undefined;
  if (itemProperties.hostId !== undefined && !stringSchema(itemProperties.hostId)) return undefined;
  if (requiredFields(item).includes("afterCursor")) return undefined;
  if (properties.timeoutMs !== undefined && !numberSchema(properties.timeoutMs)) return undefined;
  if (requiredFields(schema).includes("timeoutMs") && properties.timeoutMs === undefined) return undefined;
  return {
    name: "wait_threads",
    build: (targetThreadId, hostId, timeoutMs) => ({
      targets: [{
        threadId: targetThreadId,
        ...(itemProperties.hostId === undefined ? {} : { hostId }),
        // afterCursor is deliberately omitted for the first contract probe.
      }],
      ...(properties.timeoutMs === undefined
        ? {}
        : { timeoutMs: boundedSchemaNumber(properties.timeoutMs, timeoutMs) }),
    }),
  };
}

function pathFor(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function embeddedJson(value: string): unknown {
  const text = value.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

interface MarkerPath {
  readonly path: string;
  readonly assistantLike: boolean;
  readonly inputLike: boolean;
}

function markerPaths(
  value: unknown,
  marker: string,
  parent = "$",
  assistantLike = false,
  inputLike = false,
  toolLike = false,
  seen = new Set<object>(),
): MarkerPath[] {
  if (typeof value === "string") {
    const direct = value.includes(marker) ? [{ path: parent, assistantLike, inputLike }] : [];
    const parsed = embeddedJson(value);
    if (parsed === undefined) return direct;
    return direct.concat(markerPaths(
      parsed,
      marker,
      `${parent} (embedded JSON)`,
      assistantLike,
      inputLike,
      toolLike,
      seen,
    ));
  }
  if (!isRecord(value) && !Array.isArray(value)) return [];
  if (seen.has(value as object)) return [];
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.flatMap((nested, index) => markerPaths(
      nested,
      marker,
      pathFor(parent, index),
      assistantLike,
      inputLike,
      toolLike,
      seen,
    ));
  }
  const role = typeof value.role === "string" ? value.role.toLowerCase() : "";
  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  const nextTool = toolLike || type.includes("functioncall") || type.includes("tool");
  const nextAssistant = assistantLike
    || ["assistant", "model", "codex"].includes(role)
    || type.includes("agentmessage");
  const nextInput = inputLike
    || ["user", "human"].includes(role)
    || type.includes("functioncall")
    || type.includes("user");
  return Object.entries(value).flatMap(([key, nested]) => {
    const lower = key.toLowerCase();
    return markerPaths(
      nested,
      marker,
      pathFor(parent, key),
      nextAssistant || (!nextTool && /(assistant|output|response|model|final)/u.test(lower)),
      nextInput || /(prompt|input|request|user)/u.test(lower),
      nextTool,
      seen,
    );
  });
}

function sequencingMarkerPaths(value: unknown, marker: string): MarkerPath[] {
  const paths = markerPaths(value, marker);
  // Marker sequencing must never accept the delegated input echo at
  // $.content[0].text or functionCallOutput.output.text.
  return paths.filter((entry) => entry.assistantLike && !entry.inputLike);
}

function markerPathStrings(value: unknown, marker: string): string[] {
  return markerPaths(value, marker).map((entry) => entry.path);
}

function isErrorResult(value: unknown): boolean {
  return isRecord(value) && value.isError === true;
}

function responseFor(responses: readonly ToolResponseRecord[], name: string): unknown {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = responses[index]!;
    if (response.name === name && response.result !== undefined) return response.result;
  }
  return undefined;
}

function makeRecordingClient(
  runtime: CodexAppRuntime,
  state: ProbeState,
): Pick<CodexAppMcpClient, "callTool"> {
  return {
    callTool: (...args: Parameters<CodexAppMcpClient["callTool"]>) => {
      const [params] = args;
      state.requests.push({
        name: params.name,
        arguments: params.arguments ?? {},
        ...(params._meta === undefined ? {} : { _meta: params._meta }),
      });
      return runtime.mcpClient.callTool(...args).then((result) => {
        state.responses.push({ name: params.name, result });
        return result;
      }).catch((error: unknown) => {
        state.responses.push({ name: params.name, error: safeError(error) });
        throw error;
      });
    },
  };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function readExecutorThreadId(
  observer: DesktopIPCObserver,
  deadline: number,
  signal: AbortSignal,
): Promise<string> {
  observer.start();
  while (Date.now() < deadline) {
    if (signal.aborted) throw new ProbeFailure("probe_interrupted");
    const state = observer.getState();
    const identity = safeIdentity(state.currentConversationId);
    if (state.connected && identity !== undefined) return identity;
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw new ProbeFailure("executor_identity_unavailable");
}

async function callRead(
  client: Pick<CodexAppMcpClient, "callTool">,
  plan: ToolPlan,
  executorThreadId: string,
  targetThreadId: string,
  hostId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CallToolResult> {
  return callCodexAppTool({
    client,
    tool: plan.name,
    arguments: plan.build(targetThreadId, hostId, timeoutMs),
    executorThreadId,
    timeoutMs,
    signal,
  });
}

async function callWait(
  client: Pick<CodexAppMcpClient, "callTool">,
  plan: ToolPlan,
  executorThreadId: string,
  targetThreadId: string,
  hostId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CallToolResult> {
  return callCodexAppTool({
    client,
    tool: plan.name,
    arguments: plan.build(targetThreadId, hostId, timeoutMs),
    executorThreadId,
    timeoutMs,
    signal,
  });
}

async function pollForMarker(
  client: Pick<CodexAppMcpClient, "callTool">,
  plan: ToolPlan,
  executorThreadId: string,
  targetThreadId: string,
  hostId: string,
  marker: string,
  deadline: number,
  signal: AbortSignal,
): Promise<{ readonly result: CallToolResult; readonly markerPaths: readonly string[] }> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new ProbeFailure("probe_interrupted");
    try {
      const result = await callRead(
        client,
        plan,
        executorThreadId,
        targetThreadId,
        hostId,
        Math.min(READ_CALL_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        signal,
      );
      const accepted = isErrorResult(result) ? [] : sequencingMarkerPaths(result, marker);
      if (accepted.length > 0) {
        return { result, markerPaths: markerPathStrings(result, marker) };
      }
    } catch (error: unknown) {
      lastError = error;
    }
    await sleep(Math.min(POLL_DELAY_MS, Math.max(1, deadline - Date.now())));
  }
  if (lastError instanceof ProbeFailure) throw lastError;
  throw new ProbeFailure("first_turn_not_readable");
}

interface FieldObservation {
  readonly path: string;
  readonly key: string;
  readonly value: unknown;
}

function fieldObservations(
  value: unknown,
  parent = "$",
  seen = new Set<object>(),
): FieldObservation[] {
  if (typeof value === "string") {
    const parsed = embeddedJson(value);
    return parsed === undefined
      ? []
      : fieldObservations(parsed, `${parent} (embedded JSON)`, seen);
  }
  if (!isRecord(value) && !Array.isArray(value)) return [];
  if (seen.has(value as object)) return [];
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.flatMap((nested, index) => fieldObservations(nested, pathFor(parent, index), seen));
  }
  const direct = Object.entries(value)
    .filter(([key]) => CANDIDATE_FIELDS.has(key))
    .map(([key, nested]) => ({ path: pathFor(parent, key), key, value: nested }));
  return direct.concat(Object.entries(value).flatMap(([key, nested]) => fieldObservations(nested, pathFor(parent, key), seen)));
}

function jsonValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "undefined" : serialized;
  } catch {
    return "<unserializable>";
  }
}

function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/gu, "[]");
}

function turnIdentityObservations(value: unknown): FieldObservation[] {
  return fieldObservations(value).filter((entry) => {
    if (entry.key === "turnId" || entry.key === "turn_id") return typeof entry.value === "string";
    if (entry.key === "sequence" || entry.key === "turnIndex") {
      return /(?:\.turns\[\d+\]|\.latestTurn)\.(?:sequence|turnIndex)$/iu.test(entry.path)
        && (typeof entry.value === "string" || typeof entry.value === "number");
    }
    if (entry.key === "id") {
      return /(?:\.turns\[\d+\]|\.latestTurn)\.id$/iu.test(entry.path)
        && typeof entry.value === "string";
    }
    return false;
  });
}

function statusObservations(value: unknown): FieldObservation[] {
  return fieldObservations(value).filter((entry) =>
    ["status", "state", "turnStatus", "turn_status", "turnCompleted"].includes(entry.key));
}

interface SnapshotAnalysis {
  readonly name: string;
  readonly topLevelKeys: readonly string[];
  readonly fields: readonly FieldObservation[];
  readonly identities: readonly FieldObservation[];
  readonly statuses: readonly FieldObservation[];
  readonly markerAPaths: readonly string[];
  readonly markerBPaths: readonly string[];
}

function analyzeSnapshot(name: string, value: unknown, markerA: string, markerB: string): SnapshotAnalysis {
  return {
    name,
    topLevelKeys: isRecord(value) ? Object.keys(value) : [],
    fields: fieldObservations(value),
    identities: turnIdentityObservations(value),
    statuses: statusObservations(value),
    markerAPaths: markerPathStrings(value, markerA),
    markerBPaths: markerPathStrings(value, markerB),
  };
}

function fieldLines(entries: readonly FieldObservation[]): string {
  if (entries.length === 0) return "- none observed";
  return entries.slice(0, 100).map((entry) => `- \`${entry.path}\` = \`${jsonValue(entry.value)}\``).join("\n");
}

function snapshotSection(analysis: SnapshotAnalysis | undefined): string {
  if (analysis === undefined) return "not observed";
  return [
    `### ${analysis.name}`,
    `top-level keys: ${analysis.topLevelKeys.length === 0 ? "none/non-object" : analysis.topLevelKeys.join(", ")}`,
    "candidate fields:",
    fieldLines(analysis.fields),
    "turn identity candidates:",
    fieldLines(analysis.identities),
    "status candidates:",
    fieldLines(analysis.statuses),
    `TURN_A marker paths: ${analysis.markerAPaths.length === 0 ? "none" : analysis.markerAPaths.join(", ")}`,
    `TURN_B marker paths: ${analysis.markerBPaths.length === 0 ? "none" : analysis.markerBPaths.join(", ")}`,
  ].join("\n");
}

function identityConclusion(
  baseline: SnapshotAnalysis | undefined,
  immediate: SnapshotAnalysis | undefined,
  final: SnapshotAnalysis | undefined,
): { readonly status: "PROVEN" | "PARTIAL" | "NOT PROVEN"; readonly evidence: string[] } {
  const baselineValues = new Set((baseline?.identities ?? []).map((entry) => jsonValue(entry.value)));
  const finalValues = new Set((final?.identities ?? []).map((entry) => jsonValue(entry.value)));
  const immediateValues = new Set((immediate?.identities ?? []).map((entry) => jsonValue(entry.value)));
  const newValues = [...finalValues].filter((value) => !baselineValues.has(value));
  const stable = [...baselineValues].filter((value) => finalValues.has(value));
  if (stable.length > 0 && newValues.length > 0) {
    return {
      status: "PROVEN",
      evidence: [
        `baseline identities: ${[...baselineValues].join(", ")}`,
        `final identities: ${[...finalValues].join(", ")}`,
        `new identity values: ${newValues.join(", ")}`,
        `immediate identities: ${[...immediateValues].join(", ") || "none"}`,
      ],
    };
  }
  if ((baseline?.identities.length ?? 0) > 0 || (final?.identities.length ?? 0) > 0) {
    return {
      status: "PARTIAL",
      evidence: [
        `baseline identity candidates: ${baseline?.identities.length ?? 0}`,
        `immediate identity candidates: ${immediate?.identities.length ?? 0}`,
        `final identity candidates: ${final?.identities.length ?? 0}`,
        `stable baseline identities: ${stable.join(", ") || "none"}`,
        `new turn identity values: ${newValues.join(", ") || "none"}`,
        "stable baseline-to-new identity pattern was not observed",
      ],
    };
  }
  return { status: "NOT PROVEN", evidence: ["no structured turn identity candidate was observed"] };
}

function statusConclusion(
  baseline: SnapshotAnalysis | undefined,
  immediate: SnapshotAnalysis | undefined,
  final: SnapshotAnalysis | undefined,
): { readonly status: "PROVEN" | "PARTIAL" | "NOT PROVEN"; readonly evidence: string[] } {
  const entries = [...(baseline?.statuses ?? []), ...(immediate?.statuses ?? []), ...(final?.statuses ?? [])];
  if (entries.length === 0) return { status: "NOT PROVEN", evidence: ["no turn-level status field was observed"] };
  const terminalValues = entries.filter((entry) =>
    (typeof entry.value === "string" && ["complete", "completed", "failed", "failure", "error", "interrupted", "cancelled", "canceled"].includes(entry.value.toLowerCase()))
    || (entry.key === "turnCompleted" && typeof entry.value === "boolean"));
  return {
    status: terminalValues.length > 0 ? "PROVEN" : "PARTIAL",
    evidence: [
      `observed status fields: ${entries.map((entry) => `${entry.path}=${jsonValue(entry.value)}`).join(", ")}`,
      terminalValues.length > 0 ? "an explicit terminal-looking status/value was observed" : "status fields were observed but no terminal value was observed",
    ],
  };
}

function cursorConclusion(waitTool: Tool | undefined, readTool: Tool | undefined): {
  readonly status: "PROVEN" | "PARTIAL" | "NOT PROVEN";
  readonly evidence: string[];
} {
  const waitSchema = schemaRecord(waitTool?.inputSchema);
  const readSchema = schemaRecord(readTool?.inputSchema);
  const waitProperties = waitSchema === undefined ? {} : schemaProperties(waitSchema);
  const readProperties = readSchema === undefined ? {} : schemaProperties(readSchema);
  const waitDescription = waitTool?.description ?? "";
  const readDescription = readTool?.description ?? "";
  const waitAfterCursor = schemaRecord(waitProperties.targets) !== undefined
    && JSON.stringify(waitProperties.targets).includes("afterCursor");
  const readCursor = readProperties.cursor !== undefined;
  const waitDescriptionEvidence = /cursor returned by an earlier wait/iu.test(waitDescription)
    || /cursor returned by an earlier wait/iu.test(JSON.stringify(waitSchema ?? {}));
  const readDescriptionEvidence = /older turns/iu.test(readDescription);
  const evidence = [
    `wait_threads afterCursor in inputSchema: ${waitAfterCursor}`,
    `wait_threads description says returned-by-earlier-wait: ${waitDescriptionEvidence}`,
    `read_thread cursor in inputSchema: ${readCursor}`,
    `read_thread description says older-turn pagination: ${readDescriptionEvidence}`,
    "same cursor domain/interchangeability: not proven",
  ];
  if (!waitAfterCursor && !readCursor) return { status: "NOT PROVEN", evidence };
  if (waitDescriptionEvidence && readDescriptionEvidence) return { status: "PARTIAL", evidence };
  return { status: "PARTIAL", evidence };
}

function toolContractSection(name: string, tool: Tool | undefined): string {
  if (tool === undefined) return `### ${name}\n\n{ "available": false }`;
  return [
    `### ${name}`,
    "```json",
    JSON.stringify(tool, null, 2),
    "```",
  ].join("\n");
}

function formatReport(state: ProbeState): string {
  const markerA = `LRM_P530B_TURN_A_${state.runId}`;
  const markerB = `LRM_P530B_TURN_B_${state.runId}`;
  const baseline = state.snapshots.baseline === undefined
    ? undefined
    : analyzeSnapshot("read-baseline.json", state.snapshots.baseline, markerA, markerB);
  const immediate = state.snapshots.immediate === undefined
    ? undefined
    : analyzeSnapshot("read-immediate-after-send.json", state.snapshots.immediate, markerA, markerB);
  const final = state.snapshots.final === undefined
    ? undefined
    : analyzeSnapshot("read-final.json", state.snapshots.final, markerA, markerB);
  const identity = identityConclusion(baseline, immediate, final);
  const terminal = statusConclusion(baseline, immediate, final);
  const baselineCorrelation = identity.status === "PROVEN" && final !== undefined
    ? "PROVEN"
    : identity.status === "NOT PROVEN" ? "NOT PROVEN" : "PARTIAL";
  const cursor = cursorConclusion(state.waitTool, state.readTool);
  const productionReady = identity.status === "PROVEN"
    && terminal.status === "PROVEN"
    && baselineCorrelation === "PROVEN";
  const rawSequence = [
    "1. tools/list",
    "2. DesktopIPCObserver.currentConversationId",
    "3. list_projects",
    "4. create_thread (TURN_A; one fresh target)",
    "5. bounded read_thread polling until TURN_A sequencing marker",
    "6. read_thread baseline",
    "7. send_message_to_thread (TURN_B; same target)",
    "8. immediate read_thread",
    `9. wait_threads once (${state.waitTool === undefined ? "not called" : "called when schema was safe"})`,
    "10. bounded read_thread polling until TURN_B sequencing marker",
    "11. final read_thread",
  ];
  return [
    "# P5.3.0-B Live Completion Contract Probe",
    "",
    `run_id: ${state.runId}`,
    `probe_status: ${state.failureClass === undefined ? "completed" : "failed"}`,
    `failure_class: ${state.failureClass ?? "none"}`,
    `artifact_dir: ${state.artifactDir}`,
    "",
    "## 1. Runtime / Tool Versions",
    "",
    "```json",
    JSON.stringify(state.runtime ?? { observed: false }, null, 2),
    "```",
    `workspace_path: ${state.workspacePath}`,
    `executor_thread_suffix: ${state.executorThreadId?.slice(-8) ?? "not observed"}`,
    `target_thread_suffix: ${state.targetThreadId?.slice(-8) ?? "not observed"}`,
    "",
    "## 2. Observed wait_threads Tool Contract",
    "",
    toolContractSection("wait_threads", state.waitTool),
    "",
    "## 3. Observed read_thread Tool Contract",
    "",
    toolContractSection("read_thread", state.readTool),
    "",
    "## 4. Raw Probe Sequence",
    "",
    rawSequence.map((line) => `- ${line}`).join("\n"),
    "",
    "## 5. read_thread Baseline vs Immediate vs Final",
    "",
    snapshotSection(baseline),
    "",
    snapshotSection(immediate),
    "",
    snapshotSection(final),
    "",
    "## 6. Stable Turn Identity",
    "",
    identity.status,
    "",
    "evidence:",
    identity.evidence.map((line) => `- ${line}`).join("\n"),
    "",
    "## 7. Terminal Turn Status",
    "",
    terminal.status,
    "",
    "evidence:",
    terminal.evidence.map((line) => `- ${line}`).join("\n"),
    "",
    "## 8. wait_threads Evidence",
    "",
    state.snapshots.wait === undefined
      ? "wait-after-send.json was not observed."
      : snapshotSection(analyzeSnapshot("wait-after-send.json", state.snapshots.wait, markerA, markerB)),
    "",
    "## 9. Cursor Semantics",
    "",
    cursor.status,
    "",
    cursor.evidence.map((line) => `- ${line}`).join("\n"),
    "",
    "## 10. Production Completion Feasibility",
    "",
    productionReady ? "READY" : "NOT READY",
    "",
    `baseline_new_turn_correlation: ${baselineCorrelation}`,
    "",
    "The marker was used only to sequence the diagnostic snapshots; it was not used as completion evidence.",
    "",
    "## 11. Recommended P5.3.1 Design",
    "",
    productionReady
      ? "Use read_thread baseline/new-turn comparison as authority, with wait_threads only as an optional wake primitive. Keep marker/content validation outside the formal Observer."
      : "Do not start P5.3.1 production implementation. Keep the Observer gate closed until stable turn identity, new-turn correlation, and terminal status are all proven by structured payload evidence.",
    "",
    "## 12. Unproven Assumptions",
    "",
    "- send_message_to_thread does not expose a request-to-turn correlation key unless one is present in the saved payload.",
    "- wait_threads evidence is not treated as authoritative for a specific send turn.",
    "- wait_threads.afterCursor and read_thread.cursor are not interchangeable unless a future contract explicitly proves that relationship.",
    "- restart recovery and concurrent writers are outside this single-run probe.",
    "",
    "## Artifact Integrity",
    "",
    "- Tool objects and successful CallToolResult payloads were saved without completion normalization.",
    "- No existing completionEvidence/completionScan function was used for the report conclusions.",
    "- This probe does not create durable binding state.",
    "",
  ].join("\n");
}

async function ensureArtifactFiles(state: ProbeState): Promise<void> {
  const unavailable = { available: false, reason: state.failureClass ?? "not_observed" };
  const names = [
    "tool-wait_threads.json",
    "tool-read_thread.json",
    "create-result.json",
    "read-baseline.json",
    "send-result.json",
    "read-immediate-after-send.json",
    "wait-after-send.json",
    "read-final.json",
    "requests.json",
  ];
  for (const name of names) {
    const path = artifactFile(state.artifactDir, name);
    try {
      await readFile(path, "utf8");
    } catch {
      await writeJsonArtifact(state.artifactDir, name, name === "requests.json" ? state.requests : unavailable);
    }
  }
}

async function runProbe(
  args: DesktopCompletionContractProbeArgs,
  state: ProbeState,
  signal: AbortSignal,
): Promise<void> {
  if (!args.confirmEffectful) throw new ProbeFailure("effectful_confirmation_required");
  const deadline = Date.now() + args.timeoutMs;
  const observer = new DesktopIPCObserver({ logger: {} });
  let runtime: CodexAppRuntime | undefined;
  try {
    state.stage = "connect_runtime";
    runtime = await CodexAppRuntime.connect({
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
      discoverySource: runtime.info.discoverySource,
    };

    state.stage = "tools_list";
    const listed = await runtime.listTools(signal);
    state.tools = listed.tools;
    state.waitTool = listed.tools.find((tool) => tool.name === "wait_threads");
    state.readTool = listed.tools.find((tool) => tool.name === "read_thread");
    await writeDesktopCompletionContractProbeToolArtifact(state.artifactDir, "wait_threads", state.waitTool);
    await writeDesktopCompletionContractProbeToolArtifact(state.artifactDir, "read_thread", state.readTool);

    const read = readPlan(state.readTool);
    if (state.readTool === undefined) throw new ProbeFailure("completion_tool_unavailable");
    if (read === undefined) throw new ProbeFailure("completion_tool_schema_incompatible");
    const wait = waitPlan(state.waitTool);
    const contracts = createCodexAppToolContracts(listed.tools);
    contracts.requireListProjects();
    const client = makeRecordingClient(runtime, state);
    const commands = new DesktopCodexThreadCommands({ client, contracts });

    state.stage = "executor_identity";
    state.executorThreadId = await readExecutorThreadId(observer, deadline, signal);

    state.stage = "list_projects";
    let projectResult: CallToolResult;
    try {
      projectResult = await commands.listProjects({ executorThreadId: state.executorThreadId, signal, timeoutMs: Math.min(READ_CALL_TIMEOUT_MS, args.timeoutMs) });
      await writeJsonArtifact(state.artifactDir, "list-projects-result.json", projectResult);
    } catch {
      const raw = responseFor(state.responses, "list_projects");
      await writeJsonArtifact(state.artifactDir, "list-projects-result.json", raw ?? { available: false });
      throw new ProbeFailure("project_discovery_failed");
    }
    let project;
    try {
      project = resolveDesktopProject(projectResult, args.workspacePath);
    } catch (error: unknown) {
      if (error instanceof CodexAppRuntimeError && error.code === "project_ambiguous") {
        throw new ProbeFailure("project_ambiguous");
      }
      throw new ProbeFailure("project_not_found");
    }

    const markerA = `LRM_P530B_TURN_A_${state.runId}`;
    const markerB = `LRM_P530B_TURN_B_${state.runId}`;
    state.stage = "create_thread";
    const createPrompt = `Only return ${markerA}. Do not modify files. Do not create commits. Do not push.`;
    let identity: { readonly targetThreadId: string; readonly hostId: string };
    try {
      identity = await commands.createThread({
        executorThreadId: state.executorThreadId,
        projectId: project.projectId,
        prompt: createPrompt,
        signal,
        timeoutMs: Math.min(READ_CALL_TIMEOUT_MS, args.timeoutMs),
      });
    } catch {
      await writeJsonArtifact(state.artifactDir, "create-result.json", responseFor(state.responses, "create_thread") ?? { available: false });
      throw new ProbeFailure("create_failed");
    }
    state.targetThreadId = identity.targetThreadId;
    state.hostId = identity.hostId;
    await writeJsonArtifact(state.artifactDir, "create-result.json", responseFor(state.responses, "create_thread") ?? { available: false });
    if (state.targetThreadId === state.executorThreadId) throw new ProbeFailure("create_failed");

    state.stage = "first_turn_read";
    const firstReady = await pollForMarker(
      client,
      read,
      state.executorThreadId,
      state.targetThreadId,
      state.hostId,
      markerA,
      deadline,
      signal,
    );
    state.firstMarkerPaths = [...firstReady.markerPaths];

    state.stage = "read_baseline";
    const baseline = await callRead(
      client,
      read,
      state.executorThreadId,
      state.targetThreadId,
      state.hostId,
      Math.min(READ_CALL_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
      signal,
    );
    state.snapshots.baseline = baseline;
    await writeJsonArtifact(state.artifactDir, "read-baseline.json", baseline);

    state.stage = "send_message";
    const sendPrompt = `Only return ${markerB}. Do not modify files. Do not create commits. Do not push.`;
    try {
      await commands.sendMessageToThread({
        executorThreadId: state.executorThreadId,
        targetThreadId: state.targetThreadId,
        hostId: state.hostId,
        prompt: sendPrompt,
        signal,
        timeoutMs: Math.min(READ_CALL_TIMEOUT_MS, args.timeoutMs),
      });
    } catch {
      await writeJsonArtifact(state.artifactDir, "send-result.json", responseFor(state.responses, "send_message_to_thread") ?? { available: false });
      throw new ProbeFailure("send_failed");
    }
    await writeJsonArtifact(state.artifactDir, "send-result.json", responseFor(state.responses, "send_message_to_thread") ?? { available: false });

    state.stage = "read_immediate_after_send";
    let immediate: CallToolResult | undefined;
    try {
      immediate = await callRead(
        client,
        read,
        state.executorThreadId,
        state.targetThreadId,
        state.hostId,
        Math.min(READ_CALL_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        signal,
      );
      state.snapshots.immediate = immediate;
      await writeJsonArtifact(state.artifactDir, "read-immediate-after-send.json", immediate);
    } catch (error: unknown) {
      await writeJsonArtifact(state.artifactDir, "read-immediate-after-send.json", { available: false, error: safeError(error) });
    }

    state.stage = "wait_after_send";
    if (wait !== undefined) {
      try {
        const waitResult = await callWait(
          client,
          wait,
          state.executorThreadId,
          state.targetThreadId,
          state.hostId,
          Math.min(WAIT_CALL_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
          signal,
        );
        state.snapshots.wait = waitResult;
        await writeJsonArtifact(state.artifactDir, "wait-after-send.json", waitResult);
      } catch (error: unknown) {
        await writeJsonArtifact(state.artifactDir, "wait-after-send.json", { available: false, error: safeError(error) });
      }
    } else {
      await writeJsonArtifact(state.artifactDir, "wait-after-send.json", { available: false, reason: "tool_missing_or_schema_incompatible" });
    }

    state.stage = "second_turn_read";
    let finalReady: CallToolResult | undefined;
    if (immediate !== undefined && !isErrorResult(immediate)
      && sequencingMarkerPaths(immediate, markerB).length > 0) {
      finalReady = immediate;
      state.secondMarkerPaths = markerPathStrings(immediate, markerB);
    } else {
      const ready = await pollForMarker(
        client,
        read,
        state.executorThreadId,
        state.targetThreadId,
        state.hostId,
        markerB,
        deadline,
        signal,
      );
      finalReady = ready.result;
      state.secondMarkerPaths = [...ready.markerPaths];
    }
    if (finalReady === undefined) throw new ProbeFailure("second_turn_not_readable");

    state.stage = "read_final";
    const final = await callRead(
      client,
      read,
      state.executorThreadId,
      state.targetThreadId,
      state.hostId,
      Math.min(READ_CALL_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
      signal,
    );
    state.snapshots.final = final;
    await writeJsonArtifact(state.artifactDir, "read-final.json", final);
  } finally {
    observer.dispose();
    await runtime?.close();
  }
}

export async function runDesktopCompletionContractProbe(
  argv: readonly string[] = [],
): Promise<DesktopCompletionContractProbeResult> {
  const args = parseDesktopCompletionContractProbeArgs(argv);
  const runId = randomUUID();
  const artifactDir = desktopCompletionContractProbeRunDirectory(args.workspacePath, runId);
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const state: ProbeState = {
    runId,
    artifactDir,
    workspacePath: args.workspacePath,
    requests: [],
    responses: [],
    snapshots: {},
    firstMarkerPaths: [],
    secondMarkerPaths: [],
    stage: "preflight",
  };
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    try {
      await runProbe(args, state, controller.signal);
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
    await ensureArtifactFiles(state);
    await writeFile(join(artifactDir, "report.md"), `${formatReport(state)}\n`, "utf8");
  }
  return {
    ok: state.failureClass === undefined,
    run_id: runId,
    artifact_dir: artifactDir,
    report_path: artifactFile(artifactDir, "report.md"),
    ...(state.failureClass === undefined ? {} : { failure_class: state.failureClass }),
    ...(state.targetThreadId === undefined ? {} : { target_thread_suffix: state.targetThreadId.slice(-8) }),
    ...(state.executorThreadId === undefined ? {} : { executor_thread_suffix: state.executorThreadId.slice(-8) }),
  };
}
