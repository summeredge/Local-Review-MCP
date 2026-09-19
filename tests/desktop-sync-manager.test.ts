import { describe, expect, it } from "vitest";
import {
  DesktopSyncManager,
  type DesktopSyncSessionSummary,
} from "../src/desktop-sync/desktop-sync-manager.js";
import type { DesktopSyncState } from "../src/desktop-sync/desktop-sync-state.js";

function manager(
  state: DesktopSyncState,
  sessions: readonly DesktopSyncSessionSummary[] = [],
): DesktopSyncManager {
  return new DesktopSyncManager({
    observer: { getState: () => state },
    sessions: { listSessionSummaries: async () => sessions },
    workspaceId: "workspace-1",
  });
}

describe("DesktopSyncManager", () => {
  it("falls back without retaining disconnected or pre-evidence Desktop state", async () => {
    await expect(manager({
      connected: false,
      currentConversationId: "stale-thread",
      followingThreads: new Set(["stale-thread"]),
      ownerClientId: "stale-owner",
      lastEventTime: "2026-09-19T00:00:00.000Z",
    }).getState()).resolves.toMatchObject({
      mode: "auto",
      activeSource: "legacy_app_server",
      connected: false,
      currentConversationId: null,
      following: null,
      followingThreads: [],
      ownerClientId: null,
      lastEventTime: null,
      associationStatus: "unavailable",
      fallbackReason: "desktop_disconnected",
    });

    await expect(manager({
      connected: true,
      currentConversationId: undefined,
      followingThreads: new Set(["old-thread"]),
      ownerClientId: "old-owner",
      lastEventTime: "2026-09-19T00:00:00.000Z",
    }).getState()).resolves.toMatchObject({
      activeSource: "legacy_app_server",
      connected: true,
      currentConversationId: null,
      followingThreads: [],
      ownerClientId: null,
      lastEventTime: null,
      fallbackReason: "desktop_evidence_unavailable",
    });
  });

  it("uses Desktop as primary and only associates exact thread identities", async () => {
    const state: DesktopSyncState = {
      connected: true,
      currentConversationId: "thread-A",
      followingThreads: new Set(["thread-A", "thread-other"]),
      ownerClientId: "desktop-1",
      lastEventTime: "2026-09-19T00:00:00.000Z",
    };
    const sessions: DesktopSyncSessionSummary[] = [
      { session_id: "cli-session", goal_id: "goal-1", task_id: "task-1", backend_type: "cli", thread_id: "thread-A" },
      {
        session_id: "session-other",
        goal_id: "goal-1",
        task_id: "task-1",
        backend_type: "codex_app_server",
        thread_id: "thread-AB",
      },
    ];
    await expect(manager(state, sessions).getState()).resolves.toMatchObject({
      activeSource: "desktop_ipc",
      connected: true,
      currentConversationId: "thread-A",
      following: true,
      associationStatus: "unmatched",
      fallbackReason: null,
      sessionId: null,
      threadId: null,
    });
  });

  it("returns matched identity, conflict, and reconnect transitions without fallback masking", async () => {
    const state: DesktopSyncState = {
      connected: true,
      currentConversationId: "thread-A",
      followingThreads: new Set(["thread-A"]),
    };
    const matched = {
      session_id: "session-1",
      goal_id: "goal-1",
      task_id: "task-1",
      backend_type: "codex_app_server" as const,
      thread_id: "thread-A",
      current_execution: { execution_id: "execution-1" },
    };
    await expect(manager(state, [matched]).getState()).resolves.toMatchObject({
      activeSource: "desktop_ipc",
      associationStatus: "matched",
      sessionId: "session-1",
      goalId: "goal-1",
      taskId: "task-1",
      executionId: "execution-1",
      threadId: "thread-A",
    });
    await expect(manager(state, [matched, { ...matched, session_id: "session-2" }]).getState()).resolves.toMatchObject({
      activeSource: "desktop_ipc",
      associationStatus: "conflict",
      associationReason: "ambiguous_thread_mapping",
      fallbackReason: null,
      sessionId: null,
      threadId: null,
    });

    state.connected = false;
    state.currentConversationId = undefined;
    state.followingThreads.clear();
    await expect(manager(state, [matched]).getState()).resolves.toMatchObject({
      activeSource: "legacy_app_server",
      associationStatus: "unavailable",
      fallbackReason: "desktop_disconnected",
    });

    state.connected = true;
    await expect(manager(state, [matched]).getState()).resolves.toMatchObject({
      activeSource: "legacy_app_server",
      fallbackReason: "desktop_evidence_unavailable",
    });
    state.currentConversationId = "thread-A";
    state.followingThreads.add("thread-A");
    await expect(manager(state, [matched]).getState()).resolves.toMatchObject({
      activeSource: "desktop_ipc",
      associationStatus: "matched",
    });
  });

  it("resolves only an explicitly requested Session without guessing", async () => {
    const disconnected: DesktopSyncState = { connected: false, followingThreads: new Set() };
    const session = {
      session_id: "session-1",
      goal_id: "goal-1",
      task_id: "task-1",
      backend_type: "codex_app_server" as const,
      thread_id: "thread-A",
      current_execution: { execution_id: "execution-1" },
    };
    const reader = { listSessionSummaries: async () => [session] };
    const scoped = new DesktopSyncManager({ observer: { getState: () => disconnected }, sessions: reader });
    await expect(scoped.resolveSession("session-1")).resolves.toMatchObject({
      resolutionStatus: "resolved",
      activeSource: "legacy_app_server",
      fallbackReason: "desktop_disconnected",
      sessionId: "session-1",
      goalId: "goal-1",
      taskId: "task-1",
      executionId: "execution-1",
      threadId: "thread-A",
    });

    disconnected.connected = true;
    await expect(scoped.resolveSession("session-1")).resolves.toMatchObject({
      resolutionStatus: "resolved",
      activeSource: "legacy_app_server",
      fallbackReason: "desktop_evidence_unavailable",
      threadId: "thread-A",
    });

    disconnected.currentConversationId = "thread-A";
    disconnected.followingThreads.add("thread-A");
    await expect(scoped.resolveSession("session-1")).resolves.toMatchObject({
      activeSource: "desktop_ipc",
      associationStatus: "matched",
      fallbackReason: null,
      threadId: "thread-A",
    });

    disconnected.currentConversationId = "thread-B";
    await expect(scoped.resolveSession("session-1")).resolves.toMatchObject({
      activeSource: "desktop_ipc",
      associationStatus: "unmatched",
      fallbackReason: null,
      threadId: "thread-A",
    });
  });

  it("fails closed for unknown, non-app-server, and threadless Sessions", async () => {
    const sessions: DesktopSyncSessionSummary[] = [
      {
        session_id: "cli-session",
        goal_id: "goal-1",
        task_id: "task-1",
        backend_type: "cli",
        thread_id: "cli-thread",
      },
      {
        session_id: "threadless-session",
        goal_id: "goal-1",
        task_id: "task-1",
        backend_type: "codex_app_server",
      },
    ];
    const scoped = new DesktopSyncManager({
      observer: { getState: () => ({ connected: true, followingThreads: new Set() }) },
      sessions: { listSessionSummaries: async () => sessions },
    });
    await expect(scoped.resolveSession("missing")).resolves.toMatchObject({
      resolutionStatus: "unavailable",
      resolutionReason: "session_not_found",
      activeSource: null,
    });
    await expect(scoped.resolveSession("cli-session")).resolves.toMatchObject({
      resolutionStatus: "unavailable",
      resolutionReason: "unsupported_session_backend",
      sessionId: "cli-session",
      threadId: null,
    });
    await expect(scoped.resolveSession("threadless-session")).resolves.toMatchObject({
      resolutionStatus: "unavailable",
      resolutionReason: "session_thread_unavailable",
      sessionId: "threadless-session",
      threadId: null,
    });
  });
});
