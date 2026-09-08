import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { defaultTaskContextStorageRoot } from "../context/task.js";
import {
  extensionIdentityEvidenceSchema,
  type ExtensionIdentityEvidence,
} from "./extension-identity.js";

export interface ConversationCorrelation {
  readonly request_id: string;
  readonly conversation_id: string;
  readonly first_observed_at: number;
  readonly last_observed_at: number;
  readonly document_id: string;
  readonly navigation_epoch: number;
}

export type ConversationCorrelationObservation = "stored" | "same" | "refused";

const MAX_CORRELATIONS = 50_000;
const STATE_SCHEMA_VERSION = 1;

const correlationSchema = extensionIdentityEvidenceSchema.extend({
  first_observed_at: z.number().int().nonnegative().refine(Number.isSafeInteger),
  last_observed_at: z.number().int().nonnegative().refine(Number.isSafeInteger),
});

const stateSchema = z.object({
  schema_version: z.literal(STATE_SCHEMA_VERSION),
  entries: z.array(z.unknown()),
}).strict();

function stateFile(storageRoot: string): string {
  return join(resolve(storageRoot), "control-plane", "request-correlations.json");
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

export class ConversationCorrelationRegistry {
  private readonly byRequest = new Map<string, ConversationCorrelation>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly file: string;
  private freshestRequestId: string | null = null;
  private restorePromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.file = stateFile(storageRoot);
  }

  public restore(): Promise<void> {
    this.restorePromise ??= this.restoreOnce();
    return this.restorePromise;
  }

  public async observe(
    evidence: ExtensionIdentityEvidence,
  ): Promise<ConversationCorrelationObservation> {
    const parsed = extensionIdentityEvidenceSchema.parse(evidence);
    const now = Date.now();
    const previous = this.byRequest.get(parsed.request_id);

    if (previous !== undefined && previous.conversation_id !== parsed.conversation_id) {
      return "refused";
    }

    let changed = false;
    let result: ConversationCorrelationObservation;
    if (previous === undefined) {
      this.byRequest.set(parsed.request_id, {
        ...parsed,
        first_observed_at: now,
        last_observed_at: now,
      });
      result = "stored";
      changed = true;
      this.freshestRequestId = parsed.request_id;
      this.wake(parsed.request_id);
    } else {
      changed = previous.last_observed_at !== now
        || previous.document_id !== parsed.document_id
        || previous.navigation_epoch !== parsed.navigation_epoch
        || this.freshestRequestId !== parsed.request_id;
      this.byRequest.delete(parsed.request_id);
      this.byRequest.set(parsed.request_id, {
        ...previous,
        last_observed_at: Math.max(previous.last_observed_at, now),
        document_id: parsed.document_id,
        navigation_epoch: parsed.navigation_epoch,
      });
      result = "same";
      this.freshestRequestId = parsed.request_id;
    }

    this.trim();
    if (changed) await this.persist();
    return result;
  }

  public correlation(requestId: string | null | undefined): ConversationCorrelation | null {
    if (!requestId) return null;
    const correlation = this.byRequest.get(requestId);
    return correlation === undefined ? null : { ...correlation };
  }

  public async awaitCorrelation(
    requestId: string | null | undefined,
    timeoutMs: number,
  ): Promise<ConversationCorrelation | null> {
    if (!requestId) return null;
    const immediate = this.correlation(requestId);
    if (immediate !== null || timeoutMs <= 0) return immediate;

    let timer: NodeJS.Timeout | null = null;
    await new Promise<void>((resolveWait) => {
      const held = this.waiters.get(requestId) ?? new Set<() => void>();
      held.add(resolveWait);
      this.waiters.set(requestId, held);
      timer = setTimeout(() => {
        held.delete(resolveWait);
        if (held.size === 0) this.waiters.delete(requestId);
        resolveWait();
      }, timeoutMs);
      timer.unref?.();
    });
    if (timer !== null) clearTimeout(timer);
    return this.correlation(requestId);
  }

  private async restoreOnce(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") {
        console.warn("Conversation correlation state could not be restored; starting without restored proof");
      }
      return;
    }

    try {
      const state = stateSchema.parse(JSON.parse(raw));
      let invalid = false;
      for (const entry of state.entries.slice(-MAX_CORRELATIONS)) {
        const parsed = correlationSchema.safeParse(entry);
        if (!parsed.success || parsed.data.first_observed_at > parsed.data.last_observed_at) {
          invalid = true;
          continue;
        }
        const previous = this.byRequest.get(parsed.data.request_id);
        if (previous === undefined) {
          this.byRequest.set(parsed.data.request_id, parsed.data);
          this.freshestRequestId = parsed.data.request_id;
        } else if (previous.conversation_id === parsed.data.conversation_id
          && parsed.data.last_observed_at > previous.last_observed_at) {
          this.byRequest.delete(parsed.data.request_id);
          this.byRequest.set(parsed.data.request_id, {
            ...previous,
            last_observed_at: parsed.data.last_observed_at,
            document_id: parsed.data.document_id,
            navigation_epoch: parsed.data.navigation_epoch,
          });
          this.freshestRequestId = parsed.data.request_id;
        }
      }
      this.trim();
      if (invalid) console.warn("Invalid conversation correlation entries were ignored");
    } catch {
      console.warn("Conversation correlation state could not be restored; starting without restored proof");
    }
  }

  private trim(): void {
    while (this.byRequest.size > MAX_CORRELATIONS) {
      const oldest = this.byRequest.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.byRequest.delete(oldest);
    }
  }

  private wake(requestId: string): void {
    const held = this.waiters.get(requestId);
    if (held === undefined) return;
    this.waiters.delete(requestId);
    for (const resolveWait of held) resolveWait();
  }

  private persist(): Promise<void> {
    const snapshot = `${JSON.stringify({
      schema_version: STATE_SCHEMA_VERSION,
      entries: [...this.byRequest.values()],
    }, null, 2)}\n`;
    const write = this.writeQueue.then(() => this.writeSnapshot(snapshot));
    this.writeQueue = write.catch(() => undefined);
    return write.catch(() => {
      console.warn("Conversation correlation state could not be saved; keeping in-memory proof");
    });
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    const directory = dirname(this.file);
    const temporary = join(directory, `.request-correlations-${process.pid}-${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
