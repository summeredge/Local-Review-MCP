import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HOST, DEFAULT_PORT, endpoint, loadSettings, parseCliArgs, resolveSettings } from "../src/config/settings.js";

describe("settings", () => {
  it("requires an explicit workspace", () => {
    expect(() => resolveSettings()).toThrow("workspace is required");
  });

  it("uses the fixed host and default port", () => {
    expect(resolveSettings({ configWorkspace: "workspace" })).toEqual({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      workspace: "workspace",
    });
  });

  it("accepts a custom port", () => {
    expect(resolveSettings({ cliPort: "12081", cliWorkspace: "workspace" })).toEqual({
      host: DEFAULT_HOST,
      port: 12081,
      workspace: "workspace",
    });
    expect(endpoint(resolveSettings({ cliPort: "12081", cliWorkspace: "workspace" })))
      .toBe("http://127.0.0.1:12081/mcp");
  });

  it.each([0, -1, 65536, Number.NaN, 1.5, "", "garbage"])('rejects invalid port %s', (port) => {
    expect(() => resolveSettings({ cliPort: port })).toThrow(/invalid port/);
  });

  it("gives CLI port precedence over the config file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-"));
    const configPath = join(directory, "settings.json");
    await writeFile(configPath, JSON.stringify({ port: 12082, workspace: "config-workspace" }));

    try {
      await expect(loadSettings(["--config", configPath])).resolves.toEqual({
        host: DEFAULT_HOST,
        port: 12082,
        workspace: "config-workspace",
      });
      await expect(loadSettings([
        "--config", configPath,
        "--port", "12081",
        "--workspace", "cli-workspace",
      ])).resolves.toEqual({
        host: DEFAULT_HOST,
        port: 12081,
        workspace: "cli-workspace",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("parses the supported CLI options", () => {
    expect(parseCliArgs([
      "--config", "settings.json",
      "--port", "12081",
      "--workspace", "workspace",
    ])).toEqual({
      configPath: "settings.json",
      port: "12081",
      workspace: "workspace",
    });
  });
});
