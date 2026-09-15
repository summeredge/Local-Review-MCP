import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const workspace = resolve(process.env.LRM_INTERACTIVE_WORKSPACE ?? process.cwd());
const stateRoot = await mkdtemp(join(tmpdir(), "local-review-mcp-interactive-smoke-"));
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

const { createAppContext } = await import("../dist/src/app.js");
const { GoalSubmissionService } = await import("../dist/src/control-plane/goal-submission.js");
const { SessionStore } = await import("../dist/src/context/session-store.js");

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

async function waitForTerminal(sessionId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = await sessions.getSession(sessionId);
    if (session?.status === "completed" || session?.status === "failed") return session;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for interactive Session completion.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

try {
  if (smokeModel !== "gpt-5.6-luna" || smokeEffort !== "max") {
    throw new Error("Set CODEX_INTERACTIVE_MODEL=gpt-5.6-luna and CODEX_INTERACTIVE_EFFORT=max for this smoke test.");
  }
  const result = await submission.submitGoal({
    workspace_id: "interactive-smoke",
    conversation_id: "interactive-smoke-conversation",
    title: "Interactive Codex app-server smoke test",
    goal: "请只回复：LRM_PHASE4_EVENT_PASS\n不要修改文件。不要执行命令。",
    requirements: ["Use the interactive Codex app-server backend."],
    acceptance_criteria: ["The Codex Thread is created and the requested reply is returned."],
    execution_mode: "interactive",
    model: smokeModel,
    reasoning_effort: smokeEffort,
  });
  const session = (await sessions.listSessions()).find((candidate) => candidate.goal_id === result.goal_id);
  if (session === undefined || session.thread_id === undefined) {
    throw new Error("Interactive Session or thread_id was not persisted.");
  }
  const terminal = await waitForTerminal(session.session_id);
  if (terminal.status !== "completed") {
    throw new Error(`Interactive Session ended with status=${terminal.status}.`);
  }
  if (statusQuery === undefined) throw new Error("Status query runtime was not created.");
  const sessionStatus = await statusQuery.getSessionStatus({
    session_id: terminal.session_id,
    workspace_id: "interactive-smoke",
  });
  const executionStatus = await statusQuery.getExecutionStatus({
    execution_id: result.execution_id,
    session_id: terminal.session_id,
    workspace_id: "interactive-smoke",
  });
  const eventResult = await statusQuery.listSessionEvents({
    session_id: terminal.session_id,
    workspace_id: "interactive-smoke",
  });
  const eventTypes = eventResult.events.map((event) => event.event_type);
  for (const expected of [
    "session_started",
    "turn_started",
    "agent_message_delta",
    "agent_message_completed",
    "turn_completed",
  ]) {
    if (!eventTypes.includes(expected)) throw new Error(`Normalized event was not recorded: ${expected}.`);
  }
  if (executionStatus.status !== "passed") {
    throw new Error(`Interactive Execution ended with status=${executionStatus.status}.`);
  }
  if (!executionStatus.agent_output?.includes("LRM_PHASE4_EVENT_PASS")) {
    throw new Error("Interactive agent output was not recorded.");
  }
  console.log(JSON.stringify({
    goal_id: result.goal_id,
    task_id: result.task_id,
    execution_id: result.execution_id,
    session: {
      session_id: terminal.session_id,
      backend_type: terminal.backend_type,
      thread_id: terminal.thread_id,
      workspace: terminal.workspace,
      model: terminal.model,
      reasoning_effort: terminal.reasoning_effort,
      status: terminal.status,
    },
    query: {
      session_status: sessionStatus.status,
      execution_status: executionStatus.status,
      event_types: eventTypes,
    },
  }, null, 2));
} finally {
  await context.executionService?.close().catch(() => undefined);
  await rm(stateRoot, { recursive: true, force: true });
}
