import { execFile } from "node:child_process";
import type { DesktopSyncState } from "../desktop-sync/desktop-sync-state.js";
import type { DesktopThreadBindingStore } from "./desktop-thread-binding-store.js";
import { desktopThreadBindingSchema } from "./desktop-thread-binding.js";
import type { DesktopToolsPipeHandoff } from "./desktop-tools-pipe-handoff.js";

export function openDesktopThread(url: string): Promise<void> {
  if (process.platform !== "win32") return Promise.reject(new Error("仅支持 Windows Desktop 激活"));
  return new Promise((resolve, reject) => {
    execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url],
      { windowsHide: true, timeout: 10_000 }, (error) => error ? reject(error) : resolve());
  });
}

/** Navigation is a one-shot hint. Only the existing handoff may establish capability. */
export class DesktopThreadActivator {
  private generation = 0;
  private attempted = false;
  private disposed = false;

  public constructor(
    private readonly workspaceId: string,
    private readonly bindings: Pick<DesktopThreadBindingStore, "latest">,
    private readonly handoff: DesktopToolsPipeHandoff,
    private readonly state: () => DesktopSyncState,
    private readonly open: (url: string) => Promise<void> = openDesktopThread,
    private readonly report: (state: "requested" | "failed" | "no_binding") => void = () => undefined,
  ) {}

  public async observe(): Promise<void> {
    if (this.disposed) return;
    const state = this.state();
    if (!state.connected) {
      this.generation++;
      this.attempted = false;
      return;
    }
    if (state.ownerClientId?.trim()) {
      this.attempted = true;
      this.generation++; // Owner evidence ends bootstrap for this connection lifecycle.
      return;
    }
    if (this.attempted || this.handoff.stateFor(state) !== "pending") return;
    this.attempted = true;
    const generation = this.generation;
    try {
      const candidate = await this.bindings.latest(this.workspaceId);
      if (this.disposed || generation !== this.generation) return;
      if (candidate === undefined) { this.report("no_binding"); return; }
      const binding = desktopThreadBindingSchema.parse(candidate);
      if (binding.workspace_id !== this.workspaceId) return;
      if (["new", ".", ".."].includes(binding.target_thread_id.toLowerCase())) return;
      const current = this.state();
      if (!current.connected || current.ownerClientId?.trim()
        || this.handoff.stateFor(current) !== "pending") return;
      await this.open(`codex://threads/${encodeURIComponent(binding.target_thread_id)}`);
      this.report("requested");
    } catch {
      this.report("failed");
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.generation++;
  }
}
