import type { ExecutionContext, Session } from "./types.js";
import type { SessionStore } from "./session-store.js";
import type { EventStore } from "../control-plane/events/store.js";

/** Prefer explicit identity, then durable events; only unambiguous legacy records use task evidence. */
export async function sessionForExecution(
  sessions: readonly Session[], execution: ExecutionContext,
  executions: readonly ExecutionContext[], events: Pick<EventStore, "listEvents">,
): Promise<Session | undefined> {
  const matches: Session[] = [];
  for (const session of sessions) {
    if (session.task_id !== execution.task_id) continue;
    const ids = session.execution_id === undefined
      ? [...new Set((await events.listEvents(session.session_id)).map(event => event.execution_id))]
      : [session.execution_id];
    if (ids.length === 1 && ids[0] === execution.execution_id) matches.push(session);
    else if (ids.length === 0 && executions.length === 1 && sessions.length === 1) matches.push(session);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Session failures must not suppress a durable Execution's terminal notification. */
export async function syncTerminalSession(
  sessions: SessionStore, sessionId: string | undefined, execution: ExecutionContext,
): Promise<void> {
  if (sessionId === undefined || execution.status === "running") return;
  const status = execution.status === "passed" ? "completed" : "failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const current = await sessions.getSession(sessionId);
      if (current?.status !== status || current?.execution_id === undefined) {
        await sessions.updateSession(sessionId, { status, execution_id: execution.execution_id });
      }
      return;
    } catch (error: unknown) {
      if (attempt === 1) console.warn("Terminal Session synchronization failed; startup reconciliation will retry", error);
    }
  }
}
