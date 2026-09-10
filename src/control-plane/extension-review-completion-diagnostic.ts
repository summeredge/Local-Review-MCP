import { randomUUID } from "node:crypto";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import { loadSettings, type ResolvedSettings } from "../config/settings.js";
import { startBridge, stopBridge } from "./bridge.js";
import {
  ExtensionDeliveryService,
  type ExtensionDeliveryReceipt,
} from "./extension-delivery.js";
import {
  ExtensionReviewCompletionService,
  type ExtensionReviewCompletionReceipt,
} from "./extension-review-completion.js";
import { WorkspaceManager } from "../workspace/manager.js";

const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ExtensionReviewCompletionDiagnosticArgs {
  readonly settingsArgs: readonly string[];
  readonly conversationId: string;
  readonly timeoutMs: number;
}

export interface ExtensionReviewCompletionDiagnosticSummary {
  readonly ok: boolean;
  readonly conversation_id: string;
  readonly extension_delivery_id: string | null;
  readonly extension_delivery_status: string | null;
  readonly expected_user_message_id: string | null;
  readonly completion_id: string | null;
  readonly completion_status: string;
  readonly assistant_message_id: string | null;
  readonly content_present: boolean;
  readonly error?: string;
}

function valueAfter(argv: readonly string[], index: number, argument: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
  return value;
}

export function parseExtensionReviewCompletionDiagnosticArgs(
  argv: readonly string[],
): ExtensionReviewCompletionDiagnosticArgs {
  const settingsArgs: string[] = [];
  let conversationId: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--conversation-id") {
      conversationId = valueAfter(argv, index, argument);
      index += 1;
    } else if (argument === "--timeout-ms") {
      const raw = valueAfter(argv, index, argument);
      timeoutMs = Number(raw);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      index += 1;
    } else {
      settingsArgs.push(argument);
      if (argument === "--config" || argument === "--workspace" || argument === "--token" || argument === "--port") {
        settingsArgs.push(valueAfter(argv, index, argument));
        index += 1;
      } else if (argument === "--runtime") {
        continue;
      } else {
        throw new Error(`unknown argument: ${argument}`);
      }
    }
  }
  if (conversationId === undefined || !CONVERSATION_ID.test(conversationId)) {
    throw new Error("--conversation-id must be a valid ChatGPT conversation id");
  }
  return { settingsArgs, conversationId, timeoutMs };
}

function workspaceId(settings: ResolvedSettings): string {
  return settings.workspaceIdentity?.id
    ?? settings.workspaces?.find((entry) => entry.path === settings.workspace)?.id
    ?? new WorkspaceManager(settings.workspace).identity.id;
}

function summary(
  conversationId: string,
  delivery: { id: string; receipt: ExtensionDeliveryReceipt | null },
  completionId: string | null,
  receipt: ExtensionReviewCompletionReceipt | null,
  error?: string,
): ExtensionReviewCompletionDiagnosticSummary {
  const completed = receipt?.status === "completed";
  const deliveryReceipt = delivery.receipt;
  return {
    ok: completed,
    conversation_id: conversationId,
    extension_delivery_id: delivery.id,
    extension_delivery_status: delivery.receipt?.status ?? null,
    expected_user_message_id: deliveryReceipt?.status === "delivered"
      && typeof deliveryReceipt.message_id === "string"
      ? deliveryReceipt.message_id
      : null,
    completion_id: completionId,
    completion_status: receipt?.status ?? "pending",
    assistant_message_id: receipt?.assistant_message_id ?? null,
    content_present: completed && Boolean(receipt.content),
    ...(error === undefined ? {} : { error }),
  };
}

export async function runExtensionReviewCompletionDiagnostic(
  args: ExtensionReviewCompletionDiagnosticArgs,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ExtensionReviewCompletionDiagnosticSummary> {
  const settings = await loadSettings(args.settingsArgs, environment);
  const storageRoot = defaultTaskContextStorageRoot(environment);
  const deliveries = new ExtensionDeliveryService(storageRoot);
  const completions = new ExtensionReviewCompletionService(storageRoot);
  await deliveries.restore();
  await completions.restore();

  const suffix = randomUUID().replaceAll("-", "");
  const delivery = await deliveries.enqueue(
    args.conversationId,
    `Reply with a short ordinary answer containing this marker: LRM_COMPLETION_PROBE_${suffix}`,
    `diagnostic-completion-${suffix}`,
  );
  let bridgeStarted = false;
  try {
    const port = await startBridge({
      claimExtensionDelivery: (claim) => deliveries.claim(claim),
      ackExtensionDelivery: (ack) => deliveries.acknowledge(ack),
      claimExtensionReviewCompletion: (claim) => completions.claim(claim),
      ackExtensionReviewCompletion: (ack) => completions.acknowledge(ack),
    });
    bridgeStarted = port !== null;
    if (!bridgeStarted) {
      return summary(args.conversationId, { id: delivery.delivery_id, receipt: null }, null, null, "local control bridge unavailable");
    }

    const deliveryReceipt = await deliveries.awaitResult(delivery.delivery_id, args.timeoutMs);
    if (deliveryReceipt?.status !== "delivered" || typeof deliveryReceipt.message_id !== "string") {
      return summary(args.conversationId, { id: delivery.delivery_id, receipt: deliveryReceipt }, null, null);
    }

    const completion = await completions.enqueue({
      workspace_id: workspaceId(settings),
      task_id: `diagnostic-task-${suffix}`,
      review_request_id: `diagnostic-review-${suffix}`,
      review_delivery_id: delivery.delivery_id,
      conversation_id: args.conversationId,
      expected_user_message_id: deliveryReceipt.message_id,
    });
    const completionReceipt = await completions.awaitResult(completion.completion_id, args.timeoutMs);
    return summary(
      args.conversationId,
      { id: delivery.delivery_id, receipt: deliveryReceipt },
      completion.completion_id,
      completionReceipt,
    );
  } finally {
    if (bridgeStarted) await stopBridge();
  }
}
