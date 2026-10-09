import { randomUUID } from "node:crypto";
import { chmod, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ZodType } from "zod";
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
  for (const workspace of await entries(join(storageRoot, REVIEW_DELIVERIES_DIRECTORY))) {
    if (!workspace.isDirectory()) continue;
    const delivery = await service.getDelivery(workspace.name, deliveryId);
    if (delivery !== null) return delivery;
  }
  return null;
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

export async function findExecutionTransport(storageRoot: string, matches: (execution: ExecutionContext) => boolean): Promise<ExecutionContext | null> {
  const directory = join(storageRoot, TASK_EXECUTIONS_DIRECTORY);
  for (const workspace of await entries(directory)) {
    if (!workspace.isDirectory()) continue;
    const execution = await findReviewTransport(join(directory, workspace.name), executionContextSchema, matches);
    if (execution) return execution;
  }
  return null;
}

export async function findReviewTransport<T extends { extension_transport?: unknown }>(
  directory: string, schema: ZodType<T>, matches: (record: T) => boolean,
): Promise<T | null> {
  for (const workspace of await entries(directory)) {
    if (!workspace.isDirectory()) continue;
    for (const file of await entries(join(directory, workspace.name))) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const record = schema.parse(JSON.parse(await readFile(join(directory, workspace.name, file.name), "utf8")));
      if (record.extension_transport !== undefined && matches(record)) return record;
    }
  }
  return null;
}

// Publish the receipt in the authoritative Review record before removing it from the queue.
export async function saveReviewTransport(file: string, record: object, transport: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ ...record, extension_transport: transport }, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
