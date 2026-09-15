import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createSessionId,
  sessionFile,
  sessionsDirectory,
} from "./session.js";
import {
  createSessionInputSchema,
  sessionIdSchema,
  sessionSchema,
  updateSessionInputSchema,
} from "./schema.js";
import { defaultTaskContextStorageRoot } from "./task.js";
import type {
  CreateSessionInput,
  Session,
  UpdateSessionInput,
} from "./types.js";

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function json(session: Session): string {
  return `${JSON.stringify(session, null, 2)}\n`;
}

async function writeSession(file: string, session: Session): Promise<void> {
  const temporary = join(dirname(file), `.session-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, json(session), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class SessionStore {
  public readonly storageRoot: string;
  public readonly sessionsDirectory: string;

  public constructor(storageRoot = defaultTaskContextStorageRoot()) {
    this.sessionsDirectory = sessionsDirectory(storageRoot);
    this.storageRoot = resolve(storageRoot);
  }

  public async createSession(input: CreateSessionInput): Promise<Session> {
    const parsed = createSessionInputSchema.parse({
      ...input,
      session_id: input.session_id ?? createSessionId(),
    });
    const timestamp = new Date().toISOString();
    const session = sessionSchema.parse({
      session_id: parsed.session_id,
      goal_id: parsed.goal_id,
      task_id: parsed.task_id,
      backend_type: parsed.backend_type,
      status: parsed.status,
      workspace: parsed.workspace,
      ...(parsed.thread_id === undefined ? {} : { thread_id: parsed.thread_id }),
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      ...(parsed.reasoning_effort === undefined ? {} : { reasoning_effort: parsed.reasoning_effort }),
      created_at: timestamp,
      updated_at: timestamp,
    });
    await mkdir(this.sessionsDirectory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(sessionFile(this.storageRoot, session.session_id), json(session), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") {
        throw new Error(`Session "${session.session_id}" already exists.`, { cause: error });
      }
      throw new Error("Session could not be saved.", { cause: error });
    }
    return session;
  }

  public async getSession(sessionId: string): Promise<Session | null> {
    const file = sessionFile(this.storageRoot, sessionId);
    let contents: string;
    try {
      contents = await readFile(file, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw new Error("Session could not be read.", { cause: error });
    }

    try {
      const session = sessionSchema.parse(JSON.parse(contents) as unknown);
      if (session.session_id !== sessionId) {
        throw new Error("Session does not match the requested identity.");
      }
      return session;
    } catch (error: unknown) {
      throw new Error(`Session "${sessionId}" is invalid.`, { cause: error });
    }
  }

  public async updateSession(
    sessionId: string,
    patch: UpdateSessionInput,
  ): Promise<Session> {
    const current = await this.getSession(sessionId);
    if (current === null) throw new Error(`Session "${sessionId}" was not found.`);

    const parsed = updateSessionInputSchema.parse(patch);
    const next = sessionSchema.parse({
      ...current,
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.thread_id === undefined ? {} : { thread_id: parsed.thread_id }),
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      ...(parsed.reasoning_effort === undefined ? {} : { reasoning_effort: parsed.reasoning_effort }),
      updated_at: new Date().toISOString(),
    });
    try {
      await writeSession(sessionFile(this.storageRoot, sessionId), next);
    } catch (error: unknown) {
      throw new Error("Session could not be saved.", { cause: error });
    }
    return next;
  }

  public async listSessions(): Promise<Session[]> {
    let entries;
    try {
      entries = await readdir(this.sessionsDirectory, { withFileTypes: true });
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return [];
      throw new Error("Sessions could not be listed.", { cause: error });
    }

    const sessions: Session[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const sessionId = entry.name.slice(0, -".json".length);
      if (!sessionIdSchema.safeParse(sessionId).success) continue;
      const session = await this.getSession(sessionId);
      if (session !== null) sessions.push(session);
    }
    return sessions.sort((left, right) => left.session_id.localeCompare(right.session_id));
  }
}
