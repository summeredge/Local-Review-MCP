import type { DesktopIPCFollowingEvent } from "./desktop-ipc-protocol.js";

export interface DesktopSyncState {
  connected: boolean;
  currentConversationId?: string;
  followingThreads: Set<string>;
  ownerClientId?: string;
  lastEventTime?: string;
}

export type DesktopSyncStateListener = (state: DesktopSyncState) => void;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(source: Record<string, unknown>, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

export function cloneDesktopSyncState(state: DesktopSyncState): DesktopSyncState {
  return {
    connected: state.connected,
    followingThreads: new Set(state.followingThreads),
    ...(state.currentConversationId === undefined
      ? {}
      : { currentConversationId: state.currentConversationId }),
    ...(state.ownerClientId === undefined ? {} : { ownerClientId: state.ownerClientId }),
    ...(state.lastEventTime === undefined ? {} : { lastEventTime: state.lastEventTime }),
  };
}

export class DesktopSyncStateStore {
  private readonly listeners = new Set<DesktopSyncStateListener>();
  private readonly now: () => string;
  private state: DesktopSyncState = {
    connected: false,
    followingThreads: new Set<string>(),
  };

  public constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  public getState(): DesktopSyncState {
    return cloneDesktopSyncState(this.state);
  }

  public setConnected(connected: boolean): void {
    if (connected) {
      if (this.state.connected) return;
      this.state = {
        connected: true,
        followingThreads: new Set<string>(),
        ...(this.state.lastEventTime === undefined ? {} : { lastEventTime: this.state.lastEventTime }),
      };
      this.notify();
      return;
    }

    if (!this.state.connected
      && this.state.currentConversationId === undefined
      && this.state.ownerClientId === undefined
      && this.state.followingThreads.size === 0) return;
    this.state = {
      connected: false,
      followingThreads: new Set<string>(),
      ...(this.state.lastEventTime === undefined ? {} : { lastEventTime: this.state.lastEventTime }),
    };
    this.notify();
  }

  public applyEvent(event: DesktopIPCFollowingEvent): void {
    const next = { ...this.state, followingThreads: new Set(this.state.followingThreads) };
    const conversationId = event.currentConversationId ?? event.conversationId;
    const followingThreadId = event.threadId ?? event.conversationId;
    if (conversationId !== undefined) next.currentConversationId = conversationId;
    if (event.ownerClientId !== undefined) next.ownerClientId = event.ownerClientId;
    if (followingThreadId !== undefined && event.following !== undefined) {
      if (event.following) next.followingThreads.add(followingThreadId);
      else next.followingThreads.delete(followingThreadId);
    }
    next.lastEventTime = this.now();
    this.state = next;
    this.notify();
  }

  public applyInitializeResult(result: unknown): void {
    const source = record(result);
    if (source === undefined) return;
    const next = { ...this.state, followingThreads: new Set(this.state.followingThreads) };
    let changed = false;
    const currentConversationId = stringField(source, "currentConversationId", "current_conversation_id", "conversationId", "conversation_id");
    if (currentConversationId !== undefined) {
      next.currentConversationId = currentConversationId;
      changed = true;
    }
    const ownerClientId = stringField(source, "ownerClientId", "owner_client_id");
    if (ownerClientId !== undefined) {
      next.ownerClientId = ownerClientId;
      changed = true;
    }
    const followingThreads = source.followingThreads ?? source.following_threads;
    if (Array.isArray(followingThreads)) {
      const valid = followingThreads.filter((value): value is string => typeof value === "string" && value.trim() !== "");
      next.followingThreads = new Set(valid.map((value) => value.trim()));
      changed = true;
    }
    if (changed) {
      this.state = next;
      this.notify();
    }
  }

  public onStateChanged(listener: DesktopSyncStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers must not affect the connection or state cache.
      }
    }
  }
}
