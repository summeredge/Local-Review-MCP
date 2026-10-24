import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoctorRunner, probeCodexAppServer } from "../src/diagnostic/doctor.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import type { ResolvedSettings } from "../src/config/settings.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup() {
  const workspacePath = await mkdtemp(join(tmpdir(), "lrm-doctor-"));
  temporaryDirectories.push(workspacePath);
  const registry = new WorkspaceRegistry([{ id: "doctor-workspace", name: "Doctor", path: workspacePath }]);
  const settings: ResolvedSettings = {
    host: "127.0.0.1",
    port: 12080,
    workspace: workspacePath,
    auth: { token: "test-token" },
    remote: { enabled: false, endpoint: "" },
    supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
  };
  return { settings, registry, workspacePath };
}

function runner(
  settings: ResolvedSettings,
  registry: WorkspaceRegistry,
  overrides: Partial<ConstructorParameters<typeof DoctorRunner>[0]> = {},
) {
  const snapshot = {
    workspace_id: "workspace-a",
    execution_id: "execution-1",
    task_id: "task-1",
    actuation_id: null,
    state: "desktop_ready" as const,
    requestedAction: null,
    source: "desktop" as const,
    reason: null,
    actions: [] as const,
    timestamps: {
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
      desktopDeadlineAt: null,
      fallbackDeadlineAt: null,
    },
    error_code: null,
    updatedAt: "2026-09-24T00:00:00.000Z",
  };
  const snapshotReader = vi.fn(() => snapshot);
  const result = new DoctorRunner({
    settings,
    workspace: registry.active,
    desktopState: () => ({ connected: true, currentConversationId: "conversation-1", ownerClientId: "owner-1", followingThreads: new Set() }),
    handoff: { stateFor: () => "active", hasAcceptedCapability: () => true },
    pipeResolver: { resolve: () => ({ pipePath: "\\\\.\\pipe\\codex-ipc", source: "handoff" }) },
    capabilitySnapshot: snapshotReader,
    standaloneBackend: { storageRoot: "doctor-storage" },
    appServerProbe: async () => ({ status: "PASS" }),
    trampolineProbe: () => ({ status: "PASS" }),
    sessionStartProbe: () => ({ installed: true, enabled: true, trustRecorded: true, execution: "observed",
      status: "handoff_accepted", timestamp: "2026-10-24T01:00:00.000Z", pid: 123 }),
    ...overrides,
  });
  return { result, snapshot, snapshotReader };
}

describe("DoctorRunner", () => {
  it("does not treat an old accepted receipt as current capability", async () => {
    const { settings, registry } = await setup();
    const { result } = runner(settings, registry, {
      handoff: { stateFor: () => "unavailable", hasAcceptedCapability: () => true },
    });
    const report = await result.run();
    expect(report.checks.find((check) => check.component === "Desktop SessionStart"))
      .toMatchObject({ status: "WARN", reason: "session_start_receipt_historical" });
  });
  it.each([
    [{ installed: false }, "session_start_not_installed"],
    [{ enabled: false }, "session_start_disabled"],
    [{ trustRecorded: false }, "session_start_trust_not_recorded"],
    [{ execution: "not_observed", status: null }, "session_start_not_observed"],
    [{ execution: "invalid", status: null }, "session_start_evidence_invalid"],
    [{ status: "pipe_env_unavailable" }, "pipe_env_unavailable"],
    [{ status: "handoff_pending" }, "handoff_pending"],
    [{ status: "handoff_rejected" }, "handoff_rejected"],
    [{ status: "host_unavailable" }, "host_unavailable"],
    [{ status: "timeout" }, "timeout"],
  ] as const)("reports the SessionStart blocker independently", async (changes, reason) => {
    const { settings, registry } = await setup();
    const { result } = runner(settings, registry, {
      sessionStartProbe: () => ({ installed: true, enabled: true, trustRecorded: true,
        execution: "observed", status: "handoff_accepted", timestamp: "2026-10-24T01:00:00Z", pid: 123, ...changes }),
    });
    const report = await result.run();
    expect(report.checks.find((check) => check.component === "Desktop SessionStart")).toMatchObject({ status: "WARN", reason });
    expect(report.checks.find((check) => check.component === "Desktop Handoff")?.status).toBe("PASS");
  });

  it("returns READY without executing a provider, changing capability, or selecting fallback", async () => {
    const { settings, registry } = await setup();
    const start = vi.fn();
    const { result, snapshot, snapshotReader } = runner(settings, registry, {
      standaloneBackend: { storageRoot: "doctor-storage", start } as unknown as { storageRoot: string },
    });
    const before = JSON.stringify(snapshot);
    const report = await result.run();
    expect(report.status).toBe("READY");
    expect(report.checks.map((check) => check.component)).toEqual([
      "MCP Runtime", "Desktop IPC", "Desktop Handoff", "Desktop SessionStart", "Desktop Trampoline", "Standalone Backend", "Codex App Server",
    ]);
    expect(report.checks.every((check) => check.status === "PASS")).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(snapshotReader).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("refreshes the app-server probe for each report while sharing it within one report", async () => {
    const { settings, registry } = await setup();
    const appServerProbe = vi.fn(async () => ({ status: "PASS" as const }));
    const { result } = runner(settings, registry, { appServerProbe });
    await result.run();
    expect(appServerProbe).toHaveBeenCalledTimes(1);
    await result.run();
    expect(appServerProbe).toHaveBeenCalledTimes(2);
  });

  it("probes app-server protocol without creating a thread or turn", async () => {
    const initialize = vi.fn(async () => ({ user_agent: "codex-cli test" }));
    const listModels = vi.fn(async () => []);
    const close = vi.fn(async () => undefined);
    const start = vi.fn(async (_options: { environment?: NodeJS.ProcessEnv }) => ({
      initialize,
      listModels,
      close,
      processInfo: { transport: "stdio" },
    }));
    const result = await probeCodexAppServer({
      cwd: process.cwd(),
      environment: {
        CODEX_CLI_PATH: "C:\\trampoline\\DesktopBootstrapTrampoline.exe",
        CODEX_APP_TOOLS_PIPE_PATH: "\\\\.\\pipe\\codex-tools-test",
      },
      executable: "codex",
      client: { start },
    });
    expect(result.status).toBe("PASS");
    const environment = start.mock.calls[0]?.[0]?.environment;
    expect(environment?.CODEX_CLI_PATH).toBe("");
    expect(environment?.CODEX_APP_TOOLS_PIPE_PATH).toBe("");
    expect(initialize).toHaveBeenCalledOnce();
    expect(listModels).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not degrade the report when the opt-in trampoline is not configured", async () => {
    const { settings, registry, workspacePath } = await setup();
    const { result } = runner(settings, registry, { trampolineProbe: undefined });
    const report = await result.run();
    expect(report.status).toBe("READY");
    expect(report.checks.find((check) => check.component === "Desktop Trampoline")).toMatchObject({
      status: "PASS",
      details: { cli_path_configured: false, installed: false },
    });
  });

  it("returns DEGRADED when Desktop is unavailable", async () => {
    const { settings, registry } = await setup();
    const { result } = runner(settings, registry, {
      desktopState: () => ({ connected: false, followingThreads: new Set() }),
      handoff: { stateFor: () => "unavailable", hasAcceptedCapability: () => false },
      pipeResolver: { resolve: () => { throw Object.assign(new Error("unavailable"), { code: "desktop_tools_pipe_unavailable" }); } },
    });
    const report = await result.run();
    expect(report.status).toBe("DEGRADED");
    expect(report.checks.find((check) => check.component === "Desktop IPC")).toMatchObject({
      status: "WARN",
      reason: "desktop_disconnected",
    });
  });

  it("keeps a preserved handoff reason and reports standalone health independently", async () => {
    const { settings, registry } = await setup();
    const { result } = runner(settings, registry, {
      handoff: { stateFor: () => "unavailable", hasAcceptedCapability: () => false },
      pipeResolver: { resolve: () => { throw Object.assign(new Error("unavailable"), { code: "desktop_tools_pipe_unavailable" }); } },
    });
    const report = await result.run();
    expect(report.status).toBe("DEGRADED");
    expect(report.checks.find((check) => check.component === "Desktop Handoff")).toMatchObject({
      status: "WARN",
      reason: "desktop_tools_pipe_unavailable",
    });
    expect(report.checks.find((check) => check.component === "Standalone Backend")?.status).toBe("PASS");
  });
});
