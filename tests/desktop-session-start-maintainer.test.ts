import { describe, expect, it, vi } from "vitest";
import { maintainDesktopSessionStartHandoff } from "../src/desktop-codex/desktop-session-start-maintainer.js";

describe("Desktop-owned handoff maintenance", () => {
  it("reoffers after LRM restarts, then releases resources when Desktop closes", async () => {
    const closed = new Error("Desktop closed");
    const checkPipe = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined).mockRejectedValueOnce(closed);
    const handoff = vi.fn().mockResolvedValueOnce("handoff_accepted")
      .mockResolvedValueOnce("host_unavailable").mockResolvedValueOnce("handoff_pending");
    await expect(maintainDesktopSessionStartHandoff({
      checkPipe, handoff, wait: async () => {},
    })).rejects.toBe(closed);
    expect(handoff).toHaveBeenCalledTimes(3);
    expect(checkPipe).toHaveBeenCalledTimes(4);
  });

  it("stops on authorization rejection instead of retrying forever", async () => {
    const wait = vi.fn();
    await maintainDesktopSessionStartHandoff({
      checkPipe: async () => {}, handoff: async () => "handoff_rejected", wait,
    });
    expect(wait).not.toHaveBeenCalled();
  });
});
