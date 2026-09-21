// P5.4.3 verification-only diagnostic: mirrors scripts/test_interactive_goal.mjs but reports the
// failing Session/Execution/event detail instead of throwing away the states it needs to explain.
// Not production code; deletes nothing so the evidence survives the run.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workspace = resolve(process.env.LRM_INTERACTIVE_WORKSPACE ?? process.cwd());
const stateRoot = await mkdtemp(join(tmpdir(), "lrm-p543-interactive-diag-"));
const environment = { ...process.env, LOCALAPPDATA: stateRoot };
const settings = {
  host: "127.0.0.1",
  port: 12080,
  workspace,
  workspaces: [{ id: "interactive-smoke", name: "Interactive Smoke", path: workspace }],
  auth: { token: "interactive-smoke" },
  remote: { enabled: false },
  supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
};

const { createAppContext } = await import("../../dist/src/app.js");
const { GoalSubmissionService } = await import("../../dist/src/control-plane/goal-submission.js");
const { SessionStore } = await import("../../dist/src/context/session-store.js");

const context = createAppContext(settings, environment);
const submission = new GoalSubmissionService(context.goalOrchestration, {
  checkGoalPreflight: async (input) => ({
    ready: true,
    runtime: { ready: true },
    connector: { ready: true, status: "verified", action: "none" },
    extension: { ready: true },
    workspace: { valid: true, workspace_id: input.workspace_id },
    conversation: { valid: true, conversation_id: input.conversation_id },
  }),
});
const sessions = new SessionStore(context.storageRoot);
const statusQuery = context.statusQuery;
const smokeModel = process.env.CODEX_INTERACTIVE_MODEL?.trim();
const smokeEffort = process.env.CODEX_INTERACTIVE_EFFORT?.trim();

async function waitForTerminal(sessionId, timeoutMs = Number(process.env.LRM_DIAG_WAIT_MS ?? 120_000)) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = await sessions.getSession(sessionId);
    if (session?.status === "completed" || session?.status === "failed") return session;
    if (Date.now() >= deadline) return session;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

const report = { state_root: stateRoot, workspace, model: smokeModel, reasoning_effort: smokeEffort };
try {
  const submitted = await submission.submitGoal({
    workspace_id: "interactive-smoke",
    conversation_id: "interactive-smoke-conversation",
    title: "Interactive Codex app-server smoke test",
    goal: "Reply with exactly: LRM_PHASE4_EVENT_PASS",
    requirements: ["Use the interactive Codex app-server backend."],
    acceptance_criteria: ["The Codex Thread is created and the requested reply is returned."],
    execution_mode: "interactive",
    model: smokeModel,
    reasoning_effort: smokeEffort,
  });
  report.submit_goal = { goal_id: submitted.goal_id, task_id: submitted.task_id, execution_id: submitted.execution_id };
  const session = (await sessions.listSessions()).find((candidate) => candidate.goal_id === submitted.goal_id);
  report.session_record = session === undefined
    ? null
    : {
      session_id: session.session_id,
      status: session.status,
      backend_type: session.backend_type,
      thread_id: session.thread_id,
      workspace: session.workspace,
      model: session.model,
      reasoning_effort: session.reasoning_effort,
    };
  if (session !== undefined) {
    const terminal = await waitForTerminal(session.session_id);
    report.session_terminal = { status: terminal?.status, reason: terminal?.failure_reason ?? terminal?.last_error ?? null };
    try {
      report.execution_status = await statusQuery.getExecutionStatus({
        execution_id: submitted.execution_id,
        session_id: session.session_id,
        workspace_id: "interactive-smoke",
      });
    } catch (error) {
      report.execution_status_error = String(error);
    }
    try {
      const events = await statusQuery.listSessionEvents({
        session_id: session.session_id,
        workspace_id: "interactive-smoke",
      });
      report.events = events.events.map((event) => ({
        type: event.event_type,
        summary: typeof event.summary === "string" ? event.summary.slice(0, 400) : event.summary,
      }));
    } catch (error) {
      report.events_error = String(error);
    }
  }
} catch (error) {
  report.submit_goal_error = error instanceof Error ? error.message : String(error);
} finally {
  await context.executionService?.close().catch(() => undefined);
}

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
