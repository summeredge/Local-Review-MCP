import type { DesktopSyncState } from "./desktop-sync-state.js";

export const DESKTOP_SYNC_MODE = "auto" as const;

export type DesktopSyncActiveSource = "desktop_ipc" | "legacy_app_server";
export type DesktopSyncAssociationStatus = "matched" | "unmatched" | "unavailable" | "conflict";
export type DesktopSyncFallbackReason = "desktop_disconnected" | "desktop_evidence_unavailable";

export interface DesktopSyncSessionSummary {
  readonly session_id: string;
  readonly goal_id: string;
  readonly task_id: string;
  readonly backend_type: "cli" | "codex_app_server" | "desktop_codex_app";
  readonly thread_id?: string;
  readonly current_execution?: { readonly execution_id: string };
}

export interface DesktopSyncObserverReader {
  getState(): DesktopSyncState;
}

export interface DesktopSyncSessionReader {
  listSessionSummaries(workspaceId?: string): Promise<readonly DesktopSyncSessionSummary[]>;
}

export interface DesktopSyncManagerOptions {
  readonly observer: DesktopSyncObserverReader;
  readonly sessions?: DesktopSyncSessionReader;
  readonly workspaceId?: string;
}

export interface DesktopSyncManagerState {
  readonly mode: typeof DESKTOP_SYNC_MODE;
  readonly activeSource: DesktopSyncActiveSource;
  /** Compatibility field: the Desktop transport connection state. */
  readonly connected: boolean;
  readonly currentConversationId: string | null;
  readonly following: boolean | null;
  readonly followingThreads: readonly string[];
  readonly ownerClientId: string | null;
  readonly lastEventTime: string | null;
  readonly associationStatus: DesktopSyncAssociationStatus;
  readonly associationReason: "ambiguous_thread_mapping" | "session_lookup_unavailable" | null;
  readonly fallbackReason: DesktopSyncFallbackReason | null;
  readonly sessionId: string | null;
  readonly goalId: string | null;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly threadId: string | null;
}

export type DesktopSyncSessionResolutionReason =
  | "invalid_session_id"
  | "session_lookup_unavailable"
  | "session_not_found"
  | "ambiguous_session_mapping"
  | "unsupported_session_backend"
  | "session_thread_unavailable";

export interface DesktopSyncSessionResolution extends Omit<DesktopSyncManagerState, "activeSource"> {
  readonly activeSource: DesktopSyncActiveSource | null;
  readonly resolutionStatus: "resolved" | "unavailable";
  readonly resolutionReason: DesktopSyncSessionResolutionReason | null;
}

type SessionIdentity = Pick<
  DesktopSyncManagerState,
  "sessionId" | "goalId" | "taskId" | "executionId" | "threadId"
>;

function emptyAssociation(): Pick<
  DesktopSyncManagerState,
  "sessionId" | "goalId" | "taskId" | "executionId" | "threadId"
> {
  return {
    sessionId: null,
    goalId: null,
    taskId: null,
    executionId: null,
    threadId: null,
  };
}

function fallbackState(
  connected: boolean,
  fallbackReason: DesktopSyncFallbackReason,
): DesktopSyncManagerState {
  return {
    mode: DESKTOP_SYNC_MODE,
    activeSource: "legacy_app_server",
    connected,
    currentConversationId: null,
    following: null,
    followingThreads: [],
    ownerClientId: null,
    lastEventTime: null,
    associationStatus: "unavailable",
    associationReason: null,
    fallbackReason,
    ...emptyAssociation(),
  };
}

function unavailableSessionResolution(
  reason: DesktopSyncSessionResolutionReason,
  identity: SessionIdentity = emptyAssociation(),
): DesktopSyncSessionResolution {
  return {
    mode: DESKTOP_SYNC_MODE,
    activeSource: null,
    connected: false,
    currentConversationId: null,
    following: null,
    followingThreads: [],
    ownerClientId: null,
    lastEventTime: null,
    associationStatus: "unavailable",
    associationReason: null,
    fallbackReason: null,
    ...identity,
    resolutionStatus: "unavailable",
    resolutionReason: reason,
  };
}

function sessionIdentity(session: DesktopSyncSessionSummary, includeThread = false): SessionIdentity {
  return {
    sessionId: session.session_id,
    goalId: session.goal_id,
    taskId: session.task_id,
    executionId: session.current_execution?.execution_id ?? null,
    threadId: includeThread && session.thread_id !== undefined ? session.thread_id : null,
  };
}

function validThreadId(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export class DesktopSyncManager {
  private readonly observer: DesktopSyncObserverReader;
  private readonly sessions: DesktopSyncSessionReader | undefined;
  private readonly workspaceId: string | undefined;

  public constructor(options: DesktopSyncManagerOptions) {
    this.observer = options.observer;
    this.sessions = options.sessions;
    this.workspaceId = options.workspaceId;
  }

  public async getState(): Promise<DesktopSyncManagerState> {
    const desktop = this.readDesktopState();

    const conversationId = desktop.connected
      && typeof desktop.currentConversationId === "string"
      && desktop.currentConversationId.trim() !== ""
      ? desktop.currentConversationId
      : undefined;
    if (conversationId === undefined) {
      return fallbackState(
        desktop.connected,
        desktop.connected ? "desktop_evidence_unavailable" : "desktop_disconnected",
      );
    }

    const primary = {
      mode: DESKTOP_SYNC_MODE,
      activeSource: "desktop_ipc" as const,
      connected: true,
      currentConversationId: conversationId,
      following: desktop.followingThreads.has(conversationId),
      followingThreads: [...desktop.followingThreads].sort(),
      ownerClientId: desktop.ownerClientId ?? null,
      lastEventTime: desktop.lastEventTime ?? null,
      fallbackReason: null,
    };

    if (this.sessions === undefined) {
      return {
        ...primary,
        associationStatus: "unavailable",
        associationReason: "session_lookup_unavailable",
        ...emptyAssociation(),
      };
    }

    let sessions: readonly DesktopSyncSessionSummary[];
    try {
      sessions = await this.sessions.listSessionSummaries(this.workspaceId);
    } catch {
      return {
        ...primary,
        associationStatus: "unavailable",
        associationReason: "session_lookup_unavailable",
        ...emptyAssociation(),
      };
    }

    const matches = sessions.filter((session) =>
      session.backend_type === "codex_app_server" && session.thread_id === conversationId,
    );
    if (matches.length === 0) {
      return {
        ...primary,
        associationStatus: "unmatched",
        associationReason: null,
        ...emptyAssociation(),
      };
    }
    if (matches.length > 1) {
      return {
        ...primary,
        associationStatus: "conflict",
        associationReason: "ambiguous_thread_mapping",
        ...emptyAssociation(),
      };
    }

    const session = matches[0]!;
    return {
      ...primary,
      associationStatus: "matched",
      associationReason: null,
      sessionId: session.session_id,
      goalId: session.goal_id,
      taskId: session.task_id,
      executionId: session.current_execution?.execution_id ?? null,
      threadId: conversationId,
    };
  }

  public async resolveSession(sessionId: string): Promise<DesktopSyncSessionResolution> {
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      return unavailableSessionResolution("invalid_session_id");
    }
    if (this.sessions === undefined) {
      return unavailableSessionResolution("session_lookup_unavailable");
    }

    let sessions: readonly DesktopSyncSessionSummary[];
    try {
      sessions = await this.sessions.listSessionSummaries(this.workspaceId);
    } catch {
      return unavailableSessionResolution("session_lookup_unavailable");
    }

    const matches = sessions.filter((session) => session.session_id === sessionId);
    if (matches.length === 0) return unavailableSessionResolution("session_not_found");
    if (matches.length > 1) return unavailableSessionResolution("ambiguous_session_mapping");

    const session = matches[0]!;
    const identity = sessionIdentity(session);
    if (session.backend_type !== "codex_app_server") {
      return unavailableSessionResolution("unsupported_session_backend", identity);
    }
    if (!validThreadId(session.thread_id)) {
      return unavailableSessionResolution("session_thread_unavailable", identity);
    }

    const desktop = this.readDesktopState();
    const conversationId = desktop.connected
      && validThreadId(desktop.currentConversationId)
      ? desktop.currentConversationId
      : undefined;
    if (conversationId === undefined) {
      return {
        ...fallbackState(
          desktop.connected,
          desktop.connected ? "desktop_evidence_unavailable" : "desktop_disconnected",
        ),
        ...sessionIdentity(session, true),
        resolutionStatus: "resolved",
        resolutionReason: null,
      };
    }

    return {
      mode: DESKTOP_SYNC_MODE,
      activeSource: "desktop_ipc",
      connected: true,
      currentConversationId: conversationId,
      following: desktop.followingThreads.has(conversationId),
      followingThreads: [...desktop.followingThreads].sort(),
      ownerClientId: desktop.ownerClientId ?? null,
      lastEventTime: desktop.lastEventTime ?? null,
      associationStatus: conversationId === session.thread_id ? "matched" : "unmatched",
      associationReason: null,
      fallbackReason: null,
      ...sessionIdentity(session, true),
      resolutionStatus: "resolved",
      resolutionReason: null,
    };
  }

  private readDesktopState(): DesktopSyncState {
    try {
      return this.observer.getState();
    } catch {
      return { connected: false, followingThreads: new Set() };
    }
  }
}
