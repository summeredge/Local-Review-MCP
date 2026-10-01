import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { extensionIdentityEvidenceSchema, type ExtensionIdentityEvidence } from "./extension-identity.js";

export const IDENTITY_EVIDENCE_TTL_MS = 5 * 60 * 1000;
export const MAX_IDENTITY_EVIDENCE = 1000;
export const identityEvidenceAck = { accepted: true, durable: true } as const;
export type IdentityEvidenceAck = typeof identityEvidenceAck;
export class IdentityEvidenceConflictError extends Error {}

const entrySchema = extensionIdentityEvidenceSchema.extend({
  received_at: z.number().int().nonnegative().refine(Number.isSafeInteger),
  expires_at: z.number().int().nonnegative().refine(Number.isSafeInteger),
}).strict().refine((entry) => entry.expires_at - entry.received_at === IDENTITY_EVIDENCE_TTL_MS);
const stateSchema = z.object({ schema_version: z.literal(1), entries: z.array(entrySchema).max(MAX_IDENTITY_EVIDENCE) }).strict();
type Entry = z.infer<typeof entrySchema>;

export class IdentityEvidenceInbox {
  public readonly file: string;
  private entries = new Map<string, Entry>();
  private restored: Promise<void> | undefined;
  // ponytail: one runtime owns this state root; use an inter-process lock if that changes.
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  public constructor(storageRoot: string, private readonly now: () => number = Date.now) {
    this.file = join(resolve(storageRoot), "control-plane", "identity-evidence-inbox.json");
  }

  public restore(): Promise<void> {
    this.restored ??= this.exclusive(async () => {
      let raw: string;
      try { raw = await readFile(this.file, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const state = stateSchema.parse(JSON.parse(raw));
      const entries = new Map(state.entries.map((entry) => [entry.request_id, entry]));
      if (entries.size !== state.entries.length) throw new Error("duplicate identity evidence keys");
      this.entries = entries;
      await this.prune();
      this.scheduleExpiry();
    });
    return this.restored;
  }

  public async put(evidence: ExtensionIdentityEvidence): Promise<void> {
    const parsed = extensionIdentityEvidenceSchema.parse(evidence);
    await this.restore();
    await this.exclusive(async () => {
      await this.prune();
      const previous = this.entries.get(parsed.request_id);
      if (previous !== undefined) {
        if (previous.conversation_id !== parsed.conversation_id) {
          throw new IdentityEvidenceConflictError("correlation_key already targets a different conversation");
        }
        return; // Retries neither replace proof nor extend its TTL.
      }
      if (this.entries.size >= MAX_IDENTITY_EVIDENCE) throw new Error("identity evidence inbox is full");
      const now = this.now();
      const entry = entrySchema.parse({ ...parsed, received_at: now, expires_at: now + IDENTITY_EVIDENCE_TTL_MS });
      const next = new Map(this.entries).set(parsed.request_id, entry);
      await this.persist(next);
      this.entries = next;
      this.scheduleExpiry();
    });
  }

  public async get(key: string): Promise<ExtensionIdentityEvidence | null> {
    await this.restore();
    return this.exclusive(async () => {
      await this.prune();
      const entry = this.entries.get(key);
      if (entry === undefined) return null;
      const { received_at, expires_at, ...evidence } = entry;
      return evidence;
    });
  }

  public async expire(): Promise<void> {
    await this.restore();
    await this.exclusive(async () => { await this.prune(); this.scheduleExpiry(); });
  }

  private async prune(): Promise<void> {
    const now = this.now();
    const next = new Map([...this.entries].filter(([, entry]) => entry.expires_at > now));
    if (next.size === this.entries.size) return;
    await this.persist(next);
    this.entries = next;
  }

  private scheduleExpiry(): void {
    clearTimeout(this.timer);
    if (this.entries.size === 0) return;
    const expires = Math.min(...[...this.entries.values()].map((entry) => entry.expires_at));
    this.timer = setTimeout(() => {
      void this.expire().catch(() => {
        this.timer = setTimeout(() => this.scheduleExpiry(), 1000);
        this.timer.unref();
      });
    }, Math.max(0, expires - this.now()));
    this.timer.unref();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.then(operation, operation);
    this.queue = work.then(() => undefined, () => undefined);
    return work;
  }

  private async persist(entries: Map<string, Entry>): Promise<void> {
    const directory = dirname(this.file);
    const temporary = join(directory, `.identity-evidence-${process.pid}-${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify({ schema_version: 1, entries: [...entries.values()] })}\n`,
        { encoding: "utf8", mode: 0o600, flush: true });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
