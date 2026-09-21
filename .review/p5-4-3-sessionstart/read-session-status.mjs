// P5.4.3 verification-only reader: re-opens a previous diagnostic state root and reports the
// now-final Session/Execution status plus events. Read-only; mutates nothing.
import { resolve } from "node:path";

const stateRoot = process.argv[2];
const sessionId = process.argv[3];
const workspace = resolve(process.cwd());
if (stateRoot === undefined || sessionId === undefined) {
  throw new Error("usage: node read-session-status.mjs <state-root> <session-id>");
}

const { createAppContext } = await import("../../dist/src/app.js");
const { SessionStore } = await import("../../dist/src/context/session-store.js");

const context = createAppContext({
  host: "127.0.0.1",
  port: 12080,
  workspace,
  workspaces: [{ id: "interactive-smoke", name: "Interactive Smoke", path: workspace }],
  auth: { token: "interactive-smoke" },
  remote: { enabled: false },
  supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
}, { ...process.env, LOCALAPPDATA: stateRoot });

const sessions = new SessionStore(context.storageRoot);
const session = await sessions.getSession(sessionId);
const report = {
  storage_root: context.storageRoot,
  session: session === undefined
    ? null
    : {
      session_id: session.session_id,
      status: session.status,
      thread_id: session.thread_id,
      model: session.model,
      reasoning_effort: session.reasoning_effort,
    },
};
try {
  report.execution = (await context.statusQuery.listExecutions?.({ workspace_id: "interactive-smoke" })) ?? null;
} catch {
  report.execution = null;
}
if (session !== undefined) {
  report.events = (await context.statusQuery.listSessionEvents({
    session_id: session.session_id,
    workspace_id: "interactive-smoke",
  })).events.map((event) => event.event_type);
}
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
