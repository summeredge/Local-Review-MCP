import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWorker } from "../src/browser-worker/worker.js";

const workers: BrowserWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.restoreAllMocks();
});

describe("Browser Worker", () => {
  it("starts Chromium, serves health and info, and stops cleanly", async () => {
    const worker = new BrowserWorker({ port: 0 });
    workers.push(worker);

    expect(worker.state).toMatchObject({ status: "stopped", browser: "chromium" });
    await expect(worker.start()).resolves.toMatchObject({ status: "ready", browser: "chromium" });

    const health = await fetch(`http://127.0.0.1:${worker.port}/health`);
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      service: "browser-worker",
      version: "0.1",
    });
    const info = await fetch(`http://127.0.0.1:${worker.port}/info`);
    await expect(info.json()).resolves.toEqual({ browser: "chromium", playwright: true });
    const profile = await fetch(`http://127.0.0.1:${worker.port}/profile`);
    await expect(profile.json()).resolves.toEqual({
      profile: "default",
      context: "created",
      authStatus: "UNKNOWN",
    });
    await expect(fetch(`http://127.0.0.1:${worker.port}/delivery`, { method: "POST" }))
      .resolves.toMatchObject({ status: 404 });

    await worker.stop();
    expect(worker.state.status).toBe("stopped");
  }, 30_000);

  it("creates a local Browser Context and Page without visiting a business URL", async () => {
    const worker = new BrowserWorker({ port: 0 });
    workers.push(worker);
    await worker.start();
    const context = worker.contextInstance;
    if (context === undefined) throw new Error("Browser Worker did not expose its persistent context.");

    const page = await context.newPage();
    await page.setContent("<!doctype html><title>local test page</title>");
    await expect(page.title()).resolves.toBe("local test page");
  }, 30_000);

  it("records a startup failure and does not restart automatically", async () => {
    const error = new Error("browser launch failed");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = new BrowserWorker({ launchBrowser: async () => { throw error; } });
    workers.push(worker);

    await expect(worker.start()).rejects.toThrow("browser launch failed");
    expect(worker.state).toMatchObject({ status: "failed", last_error: "browser launch failed" });
    expect(log).toHaveBeenCalledWith("Browser Worker failed");
  });
});
