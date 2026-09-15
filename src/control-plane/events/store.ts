import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sessionIdSchema } from "../../context/schema.js";
import { defaultTaskContextStorageRoot } from "../../context/task.js";
import {
  lrmEventInputSchema,
  lrmEventSchema,
  type LrmEvent,
  type StoredLrmEvent,
} from "./model.js";

export const EVENTS_DIRECTORY = join(".task", "events");

export function eventsDirectory(storageRoot: string): string {
  return join(resolve(storageRoot), EVENTS_DIRECTORY);
}

export function eventsFile(storageRoot: string, sessionId: string): string {
  return join(eventsDirectory(storageRoot), `${sessionIdSchema.parse(sessionId)}.json`);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function json(events: readonly StoredLrmEvent[]): string {
  return `${JSON.stringify(events, null, 2)}\n`;
}

async function writeEvents(file: string, events: readonly StoredLrmEvent[]): Promise<void> {
  const temporary = join(dirname(file), `.events-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, json(events), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class EventStore {
  public readonly storageRoot: string;
  public readonly eventsDirectory: string;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.storageRoot = resolve(storageRoot);
    this.eventsDirectory = eventsDirectory(this.storageRoot);
  }

  public appendEvent(event: LrmEvent): Promise<StoredLrmEvent> {
    const parsed = lrmEventInputSchema.parse(event);
    return this.exclusive(async () => {
      const current = await this.read(parsed.session_id);
      const next = lrmEventSchema.parse({
        ...parsed,
        sequence: current.length + 1,
      });
      await mkdir(this.eventsDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.eventsDirectory, 0o700).catch(() => undefined);
      try {
        await writeEvents(eventsFile(this.storageRoot, parsed.session_id), [...current, next]);
      } catch (error: unknown) {
        throw new Error("Events could not be saved.", { cause: error });
      }
      return next;
    });
  }

  public async listEvents(sessionId: string): Promise<StoredLrmEvent[]> {
    const parsedId = sessionIdSchema.parse(sessionId);
    return this.read(parsedId);
  }

  private async read(sessionId: string): Promise<StoredLrmEvent[]> {
    let contents: string;
    try {
      contents = await readFile(eventsFile(this.storageRoot, sessionId), "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return [];
      throw new Error("Events could not be read.", { cause: error });
    }

    let value: unknown;
    try {
      value = JSON.parse(contents) as unknown;
    } catch (error: unknown) {
      throw new Error(`Events for Session "${sessionId}" are invalid.`, { cause: error });
    }
    if (!Array.isArray(value)) throw new Error(`Events for Session "${sessionId}" are invalid.`);
    try {
      const events = value.map((entry) => lrmEventSchema.parse(entry));
      if (events.some((event) => event.session_id !== sessionId)) {
        throw new Error("Event Session identity does not match the requested Session.");
      }
      events.sort((left, right) => left.sequence - right.sequence);
      if (events.some((event, index) => event.sequence !== index + 1)) {
        throw new Error("Event sequence is not contiguous.");
      }
      return events;
    } catch (error: unknown) {
      throw new Error(`Events for Session "${sessionId}" are invalid.`, { cause: error });
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
