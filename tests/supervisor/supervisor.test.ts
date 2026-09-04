import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileSupervisorLogger } from "../../src/supervisor/logger.js";
import { Supervisor } from "../../src/supervisor/supervisor.js";
import type {
  HealthMonitorLike,
  RuntimeProcessExitListener,
  RuntimeProcessManager,
  RuntimeProcessStatus,
  SupervisorLogger,
  SupervisorTunnel,
} from "../../src/supervisor/types.js";

class FakeProcessManager implements RuntimeProcessManager {
  public starts = 0;
  public stops = 0;
  public running = false;
  public failNextStart = false;
  private readonly listeners = new Set<RuntimeProcessExitListener>();

  public async start(): Promise<RuntimeProcessStatus> {
    this.starts += 1;
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("process start failed");
    }
    this.running = true;
    return { running: true, pid: 321 };
  }

  public async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }

  public status(): RuntimeProcessStatus {
    return { running: this.running, ...(this.running ? { pid: 321 } : {}) };
  }

  public onExit(listener: RuntimeProcessExitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public exit(): void {
    this.running = false;
    for (const listener of this.listeners) listener({ code: 1, signal: null });
  }
}

class FakeHealthMonitor implements HealthMonitorLike {
  public checks: boolean[] = [true];
  private listener: ((healthy: boolean) => void | Promise<void>) | undefined;

  public async check(): Promise<boolean> {
    return this.checks.shift() ?? true;
  }

  public start(listener: (healthy: boolean) => void | Promise<void>): void {
    this.listener = listener;
  }

  public stop(): void {}

  public async trigger(healthy: boolean): Promise<void> {
    await this.listener?.(healthy);
  }
}

class FakeTunnel implements SupervisorTunnel {
  public state = "LOCAL_ONLY";
  public starts = 0;
  public stops = 0;
  public failNextStart = false;

  public async start(): Promise<void> {
    this.starts += 1;
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("tunnel start failed");
    }
    this.state = "REMOTE_READY";
  }

  public async stop(): Promise<void> {
    this.stops += 1;
    this.state = "STOPPED";
  }

  public async status(): Promise<{ state: string }> {
    return { state: this.state };
  }
}

class MemoryLogger implements SupervisorLogger {
  public readonly events: string[] = [];

  public info(event: "runtime started" | "runtime stopped" | "health failed" | "restart triggered" | "tunnel state changed"): void {
    this.events.push(event);
  }
}

function makeSupervisor(
  processManager = new FakeProcessManager(),
  healthMonitor = new FakeHealthMonitor(),
  tunnel = new FakeTunnel(),
  logger: SupervisorLogger = new MemoryLogger(),
  maxRestartAttempts = 3,
): Supervisor {
  return new Supervisor({
    processManager,
    healthMonitor,
    tunnel,
    logger,
    maxRestartAttempts,
    workspace: "C:\\projects\\review-workspace",
  });
}

describe("supervisor", () => {
  it("moves STOPPED through STARTING to RUNNING and stops cleanly", async () => {
    const processManager = new FakeProcessManager();
    const tunnel = new FakeTunnel();
    const logger = new MemoryLogger();
    const supervisor = makeSupervisor(processManager, new FakeHealthMonitor(), tunnel, logger);

    expect(supervisor.state).toBe("STOPPED");
    await expect(supervisor.start()).resolves.toMatchObject({
      state: "RUNNING",
      workspace: "review-workspace",
      pid: 321,
      tunnel: { state: "REMOTE_READY" },
    });
    expect(processManager.starts).toBe(1);
    expect(tunnel.starts).toBe(1);

    await expect(supervisor.stop()).resolves.toMatchObject({ state: "STOPPED" });
    expect(processManager.stops).toBe(1);
    expect(tunnel.stops).toBe(1);
    expect(logger.events).toEqual([
      "runtime started",
      "tunnel state changed",
      "tunnel state changed",
      "runtime stopped",
    ]);
  });

  it("waits for the runtime health endpoint after the child process spawns", async () => {
    const healthMonitor = new FakeHealthMonitor();
    healthMonitor.checks = [false, true];
    const supervisor = makeSupervisor(new FakeProcessManager(), healthMonitor);

    await expect(supervisor.start()).resolves.toMatchObject({ state: "RUNNING" });
    await supervisor.stop();
  });

  it("preserves the startup cause while reporting the supervisor failure", async () => {
    const processManager = new FakeProcessManager();
    processManager.failNextStart = true;
    const supervisor = makeSupervisor(processManager);

    await expect(supervisor.start()).rejects.toMatchObject({
      message: "Supervisor failed to start",
      cause: expect.objectContaining({ message: "Runtime process failed to start" }),
    });
    expect(supervisor.state).toBe("ERROR");
  });

  it("cleans up a tunnel that fails during startup", async () => {
    const tunnel = new FakeTunnel();
    tunnel.failNextStart = true;
    const processManager = new FakeProcessManager();
    const supervisor = makeSupervisor(processManager, new FakeHealthMonitor(), tunnel);

    await expect(supervisor.start()).rejects.toMatchObject({
      message: "Supervisor failed to start",
      cause: expect.objectContaining({ message: "Tunnel failed to start" }),
    });
    expect(tunnel.stops).toBe(1);
    expect(processManager.stops).toBe(1);
  });

  it("recovers when the tunnel connector becomes unhealthy", async () => {
    const tunnel = new FakeTunnel();
    const healthMonitor = new FakeHealthMonitor();
    const supervisor = makeSupervisor(new FakeProcessManager(), healthMonitor, tunnel);
    await supervisor.start();

    tunnel.state = "REMOTE_ERROR";
    await healthMonitor.trigger(true);

    expect(tunnel.starts).toBe(2);
    expect(supervisor.state).toBe("RUNNING");
  });

  it("keeps a live runtime degraded after one health failure without restarting", async () => {
    const processManager = new FakeProcessManager();
    const healthMonitor = new FakeHealthMonitor();
    const logger = new MemoryLogger();
    const supervisor = makeSupervisor(processManager, healthMonitor, new FakeTunnel(), logger);
    await supervisor.start();

    await healthMonitor.trigger(false);

    expect(supervisor.state).toBe("DEGRADED");
    expect(processManager.starts).toBe(1);
    expect(logger.events).not.toContain("restart triggered");
    await expect(supervisor.status()).resolves.toMatchObject({
      restartAttempts: 0,
      healthFailures: 1,
    });
  });

  it("restarts immediately when the runtime process exits", async () => {
    const processManager = new FakeProcessManager();
    const tunnel = new FakeTunnel();
    const supervisor = makeSupervisor(processManager, new FakeHealthMonitor(), tunnel);
    await supervisor.start();

    processManager.exit();

    await vi.waitFor(() => expect(processManager.starts).toBe(2));
    await vi.waitFor(() => expect(supervisor.state).toBe("RUNNING"));
    expect(tunnel.starts).toBe(2);
  });

  it("recovers after three consecutive health failures while the runtime stays alive", async () => {
    const processManager = new FakeProcessManager();
    const tunnel = new FakeTunnel();
    const healthMonitor = new FakeHealthMonitor();
    const supervisor = makeSupervisor(processManager, healthMonitor, tunnel);
    await supervisor.start();

    await healthMonitor.trigger(false);
    await healthMonitor.trigger(false);
    expect(processManager.starts).toBe(1);

    await healthMonitor.trigger(false);

    expect(processManager.starts).toBe(2);
    expect(tunnel.starts).toBe(2);
    await expect(supervisor.status()).resolves.toMatchObject({
      state: "RUNNING",
      restartAttempts: 0,
      healthFailures: 0,
    });
  });

  it("keeps a failed recovery degraded and retries on later observations", async () => {
    const processManager = new FakeProcessManager();
    const healthMonitor = new FakeHealthMonitor();
    const logger = new MemoryLogger();
    const supervisor = makeSupervisor(processManager, healthMonitor, new FakeTunnel(), logger);
    await supervisor.start();
    await healthMonitor.trigger(false);
    await healthMonitor.trigger(false);
    processManager.failNextStart = true;

    await healthMonitor.trigger(false);

    expect(supervisor.state).toBe("DEGRADED");
    expect(logger.events).toContain("health failed");
    expect(logger.events).toContain("restart triggered");
    expect(processManager.starts).toBe(2);

    processManager.failNextStart = true;
    await healthMonitor.trigger(false);
    expect(processManager.starts).toBe(3);
    expect(supervisor.state).toBe("DEGRADED");
  });

  it("enters ERROR after the configured restart limit", async () => {
    const processManager = new FakeProcessManager();
    const healthMonitor = new FakeHealthMonitor();
    const supervisor = makeSupervisor(processManager, healthMonitor, new FakeTunnel(), new MemoryLogger(), 1);
    await supervisor.start();
    processManager.failNextStart = true;

    processManager.exit();
    await vi.waitFor(() => expect(supervisor.state).toBe("ERROR"));

    await expect(supervisor.status()).resolves.toMatchObject({
      state: "ERROR",
      restartAttempts: 1,
      maxRestartAttempts: 1,
    });
  });

  it("writes only fixed, non-sensitive supervisor events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-supervisor-log-"));
    try {
      const logger = new FileSupervisorLogger(directory);
      logger.info("runtime started");
      logger.info("health failed");
      logger.info("restart triggered");
      const content = await readFile(logger.filePath, "utf8");

      expect(content).toContain("runtime started");
      expect(content).toContain("health failed");
      expect(content).not.toContain("token");
      expect(content).not.toContain("credential");
      expect(content).not.toContain("Authorization");
      expect(content).not.toContain(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
