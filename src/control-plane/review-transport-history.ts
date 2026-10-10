import { atomicWriteRecord, serializeRecord } from "../context/record-store.js";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { ZodError, type ZodType } from "zod";
import { ReviewDeliveryService } from "../context/review-delivery-service.js";
import { REVIEW_DELIVERIES_DIRECTORY, type ReviewDelivery } from "../context/review-delivery.js";
import { ExecutionContextService } from "../context/execution-service.js";
import { TASK_EXECUTIONS_DIRECTORY } from "../context/execution.js";
import { executionContextSchema } from "../context/schema.js";
import type { ExecutionContext } from "../context/types.js";

async function entries(directory: string) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function findReviewDelivery(storageRoot: string, deliveryId: string): Promise<ReviewDelivery | null> {
  const service = new ReviewDeliveryService(storageRoot);
  let found: ReviewDelivery | null = null;
  for (const workspace of await entries(join(storageRoot, REVIEW_DELIVERIES_DIRECTORY))) {
    if (!workspace.isDirectory()) continue;
    const delivery = await service.getDelivery(workspace.name, deliveryId);
    if (delivery === null) continue;
    if (found !== null) throw new Error("Multiple historical Review deliveries match the identity.");
    found = delivery;
  }
  return found;
}

export async function findExecutionFailure(storageRoot: string, logicalId: string) {
  if (!/^auto-failure-notification-[a-f0-9]{32}$/u.test(logicalId)) return null;
  // Load lazily: AutoIteration itself depends on the Delivery service.
  const { autoIterationStateFile, autoIterationStateSchema, executionFailureNotificationId } = await import("./auto-iteration.js");
  let raw: string;
  try { raw = await readFile(autoIterationStateFile(storageRoot), "utf8"); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const loop = autoIterationStateSchema.parse(JSON.parse(raw)).loops.find(candidate =>
    candidate.stage === "failed" && candidate.terminal_reason === "EXECUTION_FAILED"
    && executionFailureNotificationId(candidate) === logicalId);
  if (!loop) return null;
  const execution = await new ExecutionContextService(storageRoot).getExecutionContext(loop.workspace_id, loop.task_id, loop.execution_id);
  return execution?.status === "failed" ? { loop, execution } : null;
}

export async function findExecutionTransport(storageRoot: string, matches: (execution: ExecutionContext) => boolean, transportId?: string): Promise<ExecutionContext | null> {
  const directory = join(storageRoot, TASK_EXECUTIONS_DIRECTORY);
  let found: ExecutionContext | null = null;
  for (const workspace of await entries(directory)) {
    if (!workspace.isDirectory()) continue;
    const execution = await findReviewTransport(join(directory, workspace.name), executionContextSchema, matches, undefined, transportId);
    if (execution === null) continue;
    if (found !== null) throw new Error("Multiple historical Executions match the transport identity.");
    found = execution;
  }
  return found;
}

export async function findReviewTransport<T extends { extension_transport?: unknown }>(
  directory: string, schema: ZodType<T>, matches: (record: T) => boolean, workspaceId?: string, targetId?: string,
): Promise<T | null> {
  let found: T | null = null;
  for (const workspace of await entries(directory)) {
    if (!workspace.isDirectory() || (workspaceId !== undefined && workspace.name !== workspaceId)) continue;
    for (const file of await entries(join(directory, workspace.name))) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const path = join(directory, workspace.name, file.name);
      const contents = await readFile(path, "utf8");
      let raw: T;
      try { raw = JSON.parse(contents) as T; }
      catch (error: unknown) {
        if (!(error instanceof SyntaxError) || (targetId !== undefined && new RegExp('"(?:review_request_id|completion_id|delivery_id)"\\s*:\\s*' + JSON.stringify(targetId).replaceAll(".", "\\.")).test(contents))) throw error;
        console.warn("Invalid historical Review JSON skipped", path);
        continue;
      }
      const target = raw !== null && typeof raw === "object" && matches(raw);
      let record: T;
      try { record = schema.parse(raw); }
      catch (error: unknown) {
        if (target || !(error instanceof ZodError)) throw error;
        console.warn("Invalid historical Review schema skipped", path);
        continue;
      }
      if (!target || record.extension_transport === undefined) continue;
      const identity = record as T & { result_id?: string; delivery_id?: string; execution_id?: string; workspace_id?: string; task_id?: string };
      const id = identity.result_id ?? identity.delivery_id ?? identity.execution_id;
      const expectedWorkspace = identity.execution_id === undefined ? workspace.name : basename(directory);
      if (id !== file.name.slice(0, -5) || identity.workspace_id !== expectedWorkspace
        || (identity.execution_id !== undefined && identity.task_id !== workspace.name)) {
        throw new Error("Historical Review record does not match its file identity.");
      }
      if (found !== null) throw new Error("Multiple historical Review records match the transport identity.");
      found = record;
    }
  }
  return found;
}

// Publish the receipt in the authoritative Review record before removing it from the queue.
export async function saveReviewTransport(file: string, record: object, transport: unknown): Promise<void> {
  await serializeRecord(file, async () => {
    const current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const expected = record as Record<string, unknown>;
    for (const key of ["workspace_id", "task_id", "result_id", "delivery_id", "execution_id", "review_request_id", "status", "content"]) {
      if (key in expected && current[key] !== expected[key]) throw new Error("Review transport publication conflicts with the authoritative record.");
    }
    await atomicWriteRecord(file, JSON.stringify({ ...current, extension_transport: transport }, null, 2) + "\n");
  });
}
