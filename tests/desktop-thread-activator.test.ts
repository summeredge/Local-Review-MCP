import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopThreadActivator } from "../src/desktop-codex/desktop-thread-activator.js";
import { DesktopToolsPipeHandoff } from "../src/desktop-codex/desktop-tools-pipe-handoff.js";
import { DesktopInteractivePreflight } from "../src/desktop-codex/desktop-interactive-preflight.js";
import type { DesktopThreadBinding } from "../src/desktop-codex/desktop-thread-binding.js";
import type { DesktopSyncState } from "../src/desktop-sync/desktop-sync-state.js";

const binding: DesktopThreadBinding = {
  schema_version: 1, workspace_id: "workspace-1", task_id: "task-1", session_id: "session-1",
  backend_identity: "desktop_codex_app", target_thread_id: "thread/#? name", host_id: "local",
  created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z",
};
const handoffs: DesktopToolsPipeHandoff[] = [];
afterEach(() => handoffs.splice(0).forEach((handoff) => handoff.clear()));

function setup(candidate: DesktopThreadBinding | undefined = binding) {
  let state: DesktopSyncState = { connected: true, followingThreads: new Set() };
  const handoff = new DesktopToolsPipeHandoff();
  handoffs.push(handoff);
  const latest = vi.fn(async (): Promise<DesktopThreadBinding | undefined> => candidate);
  const open = vi.fn(async (_url: string) => undefined);
  const report = vi.fn();
  const activator = new DesktopThreadActivator("workspace-1", { latest }, handoff, () => state, open, report);
  const preflight = new DesktopInteractivePreflight(handoff, () => state, { environment: {} });
  return { handoff, latest, open, report, activator, preflight,
    setState(next: DesktopSyncState, notify = true) {
      state = next;
      if (!notify) return Promise.resolve();
      handoff.observeDesktopState(state);
      return activator.observe();
    },
    status: () => handoff.stateFor(state),
  };
}

describe("Desktop activation bootstrap", () => {
  it.each([undefined, "", " "])("activates with an early conversation id and no owner (%j)", async (ownerClientId) => {
    const s = setup();
    await s.setState({ connected: true, currentConversationId: "early-conversation", ownerClientId, followingThreads: new Set() });
    expect(s.latest).not.toHaveBeenCalled(); // No pending capability yet.
    expect(s.preflight.check().ready).toBe(false);
    s.handoff.stagePending("\\\\.\\pipe\\bootstrap");
    await s.activator.observe();
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.status()).toBe("pending");
    expect(s.preflight.check().ready).toBe(false);
  });

  it.each([true, false])("handles either notification order (pending first: %s) and only promotes on IPC evidence", async (pendingFirst) => {
    const s = setup();
    if (!pendingFirst) await s.activator.observe();
    s.handoff.stagePending("\\\\.\\pipe\\bootstrap");
    await Promise.all([s.activator.observe(), s.activator.observe()]);
    expect(s.open).toHaveBeenCalledExactlyOnceWith("codex://threads/thread%2F%23%3F%20name");
    expect(s.status()).toBe("pending");
    expect(s.preflight.check().ready).toBe(false);
    await s.setState({ connected: true, currentConversationId: "selected", ownerClientId: "owner", followingThreads: new Set() });
    expect(s.preflight.check()).toEqual({ ready: true, pipeSource: "handoff" });
    expect(s.open).toHaveBeenCalledTimes(1);
  });

  it("keeps failures and missing bindings fail-closed without repeated navigation", async () => {
    const s = setup();
    s.handoff.stagePending("\\\\.\\pipe\\bootstrap");
    s.open.mockRejectedValueOnce(new Error("open failed"));
    await s.activator.observe();
    await s.activator.observe();
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.report).toHaveBeenCalledWith("failed");
    expect(s.status()).toBe("pending");
    expect(s.preflight.check().ready).toBe(false);
    await s.setState({ connected: false, followingThreads: new Set() });
    s.latest.mockResolvedValueOnce(undefined);
    s.handoff.stagePending("\\\\.\\pipe\\bootstrap2");
    await s.setState({ connected: true, followingThreads: new Set() });
    expect(s.report).toHaveBeenCalledWith("no_binding");
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.status()).toBe("pending");
    expect(s.preflight.check().ready).toBe(false);
  });

  it.each(["owner", "owner_without_notification", "disconnect", "clear", "dispose"])("cancels an asynchronous read after %s", async (change) => {
    const s = setup();
    let resolve!: (value: DesktopThreadBinding) => void;
    s.latest.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    s.handoff.stagePending("\\\\.\\pipe\\bootstrap");
    const pending = s.activator.observe();
    if (change.startsWith("owner")) await s.setState({ connected: true, ownerClientId: "owner", followingThreads: new Set() }, change === "owner");
    if (change === "disconnect") await s.setState({ connected: false, followingThreads: new Set() });
    if (change === "clear") s.handoff.clear();
    if (change === "dispose") s.activator.dispose();
    resolve(binding);
    await pending;
    expect(s.open).not.toHaveBeenCalled();
  });

  it.each([
    { workspace_id: "another-workspace" }, { backend_identity: "standalone" }, { target_thread_id: "" },
    { target_thread_id: "new" }, { target_thread_id: ".." },
  ])("rejects invalid binding %j", async (overrides) => {
    const s = setup({ ...binding, ...overrides } as DesktopThreadBinding);
    s.handoff.stagePending("\\\\.\\pipe\\bootstrap");
    await s.activator.observe();
    expect(s.open).not.toHaveBeenCalled();
  });

  it("does not navigate after owner identity is established, even if it is later lost", async () => {
    const s = setup();
    await s.setState({ connected: true, ownerClientId: "owner", followingThreads: new Set() });
    s.handoff.stagePending("\\\\.\\pipe\\bootstrap");
    await s.activator.observe();
    expect(s.open).not.toHaveBeenCalled();
    await s.setState({ connected: true, followingThreads: new Set() });
    s.handoff.stagePending("\\\\.\\pipe\\bootstrap");
    await s.activator.observe();
    expect(s.open).not.toHaveBeenCalled();
  });

  it("navigates at most once per connected lifecycle and can retry after disconnect", async () => {
    const s = setup();
    s.handoff.stagePending("\\\\.\\pipe\\bootstrap");
    await s.activator.observe();
    s.handoff.stagePending("\\\\.\\pipe\\different");
    await s.activator.observe();
    expect(s.open).toHaveBeenCalledTimes(1);
    await s.setState({ connected: false, followingThreads: new Set() });
    await s.setState({ connected: true, followingThreads: new Set() });
    s.handoff.stagePending("\\\\.\\pipe\\bootstrap");
    await s.activator.observe();
    s.handoff.stagePending("\\\\.\\pipe\\different");
    await s.activator.observe();
    expect(s.open).toHaveBeenCalledTimes(2);
  });
});
