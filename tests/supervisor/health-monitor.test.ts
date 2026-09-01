import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthMonitor } from "../../src/supervisor/health-monitor.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("health monitor", () => {
  it("checks periodically and stops scheduling checks", async () => {
    vi.useFakeTimers();
    let checks = 0;
    const results: boolean[] = [];
    const monitor = new HealthMonitor({
      healthUrl: "http://127.0.0.1:12080/health",
      intervalSeconds: 1,
      check: async () => {
        checks += 1;
        return checks === 1;
      },
    });

    monitor.start((healthy) => { results.push(healthy); });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(3000);

    expect(checks).toBe(2);
    expect(results).toEqual([true, false]);
    expect(monitor.running).toBe(false);
  });
});
