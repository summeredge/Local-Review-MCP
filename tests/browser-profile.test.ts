import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import {
  defaultBrowserProfileRoot,
  resolveBrowserProfileConfig,
} from "../src/browser-worker/config.js";
import { BrowserProfileManager } from "../src/browser-worker/profile/manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Browser Profile Manager", () => {
  it("resolves profiles below the managed directory and rejects traversal", () => {
    const environment = { LOCALAPPDATA: "C:\\BrowserWorkerTest" };
    const config = resolveBrowserProfileConfig({ profileName: "test-profile" }, environment);

    expect(relative(defaultBrowserProfileRoot(environment), config.profilePath)).toBe("test-profile");
    expect(() => resolveBrowserProfileConfig({ profileName: "../outside" })).toThrow("profileName");
  });

  it("creates one persistent context and closes it before its browser", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-review-mcp-browser-profile-"));
    temporaryDirectories.push(root);
    const events: string[] = [];
    const browser = {
      close: vi.fn(async () => { events.push("browser"); }),
    } as unknown as Browser;
    const context = {
      browser: () => browser,
      close: vi.fn(async () => { events.push("context"); }),
    } as unknown as BrowserContext;
    const config = { profileName: "test", profilePath: join(root, "test") };
    const launch = vi.fn(async (userDataDir: string): Promise<BrowserContext> => {
      events.push(`launch:${userDataDir}`);
      return context;
    });
    const manager = new BrowserProfileManager(config, launch);

    await expect(manager.initialize()).resolves.toBe(context);
    await expect(manager.initialize()).resolves.toBe(context);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(manager.state).toEqual({ profile: "test", context: "created", authStatus: "UNKNOWN" });

    await manager.close();
    expect(events).toEqual([`launch:${config.profilePath}`, "context", "browser"]);
    expect(manager.state).toEqual({ profile: "test", context: "not_created", authStatus: "UNKNOWN" });
  });
});
