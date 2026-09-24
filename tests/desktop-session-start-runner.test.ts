import { describe, expect, it, vi } from "vitest";
import {
  runDesktopSessionStartHandoff,
  type DesktopSessionStartHandoffStatus,
} from "../src/desktop-codex/desktop-session-start-runner.js";
import {
  DesktopToolsPipeHandoffError,
} from "../src/desktop-codex/desktop-tools-pipe-handoff.js";

const VALID_PIPE = "\\\\.\\pipe\\codex-tools-test";

describe("Desktop SessionStart Runner", () => {
  it("exits with pipe_env_unavailable when CODEX_APP_TOOLS_PIPE_PATH is not in environment", async () => {
    const logged: DesktopSessionStartHandoffStatus[] = [];
    const status = await runDesktopSessionStartHandoff([], {
      environment: {},
      logStatus: (s) => logged.push(s),
    });
    expect(status).toBe("pipe_env_unavailable");
    expect(logged).toEqual(["pipe_env_unavailable"]);
  });

  it("exits with host_unavailable when settings cannot be loaded or host is unreachable", async () => {
    const logged: DesktopSessionStartHandoffStatus[] = [];
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:12080"));
    const status = await runDesktopSessionStartHandoff(["--config", "nonexistent.json"], {
      environment: { CODEX_APP_TOOLS_PIPE_PATH: VALID_PIPE },
      fetch: fetchMock,
      logStatus: (s) => logged.push(s),
    });
    expect(status).toBe("host_unavailable");
    expect(logged).toEqual(["host_unavailable"]);
  });

  it("succeeds with handoff_accepted when host accepts the handoff", async () => {
    const logged: DesktopSessionStartHandoffStatus[] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        accepted: true,
        source: "desktop_environment",
        received_at: "2026-09-21T01:00:00.000Z",
        desktop_owner_bound: true,
      }),
    });
    const status = await runDesktopSessionStartHandoff(["--config", "config.production.json"], {
      environment: { CODEX_APP_TOOLS_PIPE_PATH: VALID_PIPE },
      fetch: fetchMock,
      logStatus: (s) => logged.push(s),
    });
    expect(status).toBe("handoff_accepted");
    expect(logged).toEqual(["handoff_accepted"]);
  });

  it("reports handoff_pending when the host stores the pipe before owner binding", async () => {
    const logged: DesktopSessionStartHandoffStatus[] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({
        accepted: false,
        pending: true,
        source: "desktop_environment",
        received_at: "2026-09-21T01:00:00.000Z",
        desktop_owner_bound: false,
      }),
    });
    const status = await runDesktopSessionStartHandoff(["--config", "config.production.json"], {
      environment: { CODEX_APP_TOOLS_PIPE_PATH: VALID_PIPE },
      fetch: fetchMock,
      logStatus: (s) => logged.push(s),
    });
    expect(status).toBe("handoff_pending");
    expect(logged).toEqual(["handoff_pending"]);
  });

  it("exits with handoff_rejected when host responds with non-ok error", async () => {
    const logged: DesktopSessionStartHandoffStatus[] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "desktop_tools_pipe_invalid" }),
    });
    const status = await runDesktopSessionStartHandoff(["--config", "config.production.json"], {
      environment: { CODEX_APP_TOOLS_PIPE_PATH: VALID_PIPE },
      fetch: fetchMock,
      logStatus: (s) => logged.push(s),
    });
    expect(status).toBe("handoff_rejected");
    expect(logged).toEqual(["handoff_rejected"]);
  });

  it("bounds execution and exits with timeout when request hangs", async () => {
    const logged: DesktopSessionStartHandoffStatus[] = [];
    const fetchMock = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });
    const status = await runDesktopSessionStartHandoff(["--config", "config.production.json"], {
      environment: { CODEX_APP_TOOLS_PIPE_PATH: VALID_PIPE },
      fetch: fetchMock,
      timeoutMs: 50,
      logStatus: (s) => logged.push(s),
    });
    expect(status).toBe("timeout");
    expect(logged).toEqual(["timeout"]);
  });

  it("does not log or persist auth token or pipe path", async () => {
    const logged: string[] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        accepted: true,
        source: "desktop_environment",
        received_at: "2026-09-21T01:00:00.000Z",
        desktop_owner_bound: true,
      }),
    });
    await runDesktopSessionStartHandoff(["--config", "config.production.json"], {
      environment: { CODEX_APP_TOOLS_PIPE_PATH: VALID_PIPE },
      fetch: fetchMock,
      logStatus: (s) => logged.push(s),
    });
    const combined = logged.join(" ");
    expect(combined).not.toContain(VALID_PIPE);
    expect(combined).not.toContain("d7e1d19e503a463f96f57d5cbe7dea94");
    expect(combined).toBe("handoff_accepted");
  });

  it("is safe to run repeatedly for startup/resume/clear/compact SessionStart repeats", async () => {
    const logged: DesktopSessionStartHandoffStatus[] = [];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        accepted: true,
        source: "desktop_environment",
        received_at: "2026-09-21T01:00:00.000Z",
        desktop_owner_bound: true,
      }),
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await runDesktopSessionStartHandoff(["--config", "config.production.json"], {
        environment: { CODEX_APP_TOOLS_PIPE_PATH: VALID_PIPE },
        fetch: fetchMock,
        logStatus: (s) => logged.push(s),
      });
    }
    expect(logged).toEqual([
      "handoff_accepted",
      "handoff_accepted",
      "handoff_accepted",
      "handoff_accepted",
    ]);
    // One bounded POST per trigger, with no retry storm and no accumulated state.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
