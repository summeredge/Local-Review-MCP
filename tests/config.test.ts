import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_HEALTH_INTERVAL_SECONDS,
  DEFAULT_HOST,
  DEFAULT_MAX_RESTART_ATTEMPTS,
  DEFAULT_PORT,
  endpoint,
  loadSettings,
  parseCliArgs,
  parseWorkspaces,
  resolveSettings,
} from "../src/config/settings.js";

describe("settings", () => {
  it("uses the first registered workspace as the legacy active workspace", () => {
    const workspaces = [
      { id: "data-project", name: "DataProject", path: "C:\\data" },
      { id: "pca-builder", name: "PCA_Model_Builder", path: "C:\\pca" },
    ];
    expect(resolveSettings({ configWorkspaces: workspaces, configToken: "token" })).toMatchObject({
      workspace: "C:\\data",
      workspaces,
    });
    expect(parseWorkspaces(workspaces)).toEqual(workspaces);
  });

  it("rejects malformed workspace registry entries", () => {
    expect(() => parseWorkspaces([])).toThrow("at least one workspace");
    expect(() => parseWorkspaces([{ id: "C:\\outside", name: "Outside", path: "C:\\outside" }]))
      .toThrow("valid id");
  });

  it("requires an explicit workspace", () => {
    expect(() => resolveSettings()).toThrow("workspace is required");
  });

  it("uses the fixed host and default port", () => {
    expect(resolveSettings({ configWorkspace: "workspace", configToken: "config-token" })).toEqual({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      workspace: "workspace",
      auth: { token: "config-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: {
        enabled: false,
        healthIntervalSeconds: DEFAULT_HEALTH_INTERVAL_SECONDS,
        maxRestartAttempts: DEFAULT_MAX_RESTART_ATTEMPTS,
      },
    });
  });

  it("accepts a custom port", () => {
    expect(resolveSettings({
      cliPort: "12081",
      cliWorkspace: "workspace",
      cliToken: "cli-token",
    })).toEqual({
      host: DEFAULT_HOST,
      port: 12081,
      workspace: "workspace",
      auth: { token: "cli-token" },
      remote: { enabled: false, endpoint: "" },
      supervisor: {
        enabled: false,
        healthIntervalSeconds: DEFAULT_HEALTH_INTERVAL_SECONDS,
        maxRestartAttempts: DEFAULT_MAX_RESTART_ATTEMPTS,
      },
    });
    expect(endpoint(resolveSettings({
      cliPort: "12081",
      cliWorkspace: "workspace",
      cliToken: "cli-token",
    })))
      .toBe("http://127.0.0.1:12081/mcp");
  });

  it.each([0, -1, 65536, Number.NaN, 1.5, "", "garbage"])('rejects invalid port %s', (port) => {
    expect(() => resolveSettings({ cliPort: port })).toThrow(/invalid port/);
  });

  it("gives CLI port precedence over the config file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-"));
    const configPath = join(directory, "settings.json");
    await writeFile(configPath, JSON.stringify({
      port: 12082,
      workspace: "config-workspace",
      auth: { token: "config-token" },
    }));

    try {
      await expect(loadSettings(["--config", configPath], {})).resolves.toEqual({
        host: DEFAULT_HOST,
        port: 12082,
        workspace: "config-workspace",
        auth: { token: "config-token" },
        remote: { enabled: false, endpoint: "" },
        supervisor: {
          enabled: false,
          healthIntervalSeconds: DEFAULT_HEALTH_INTERVAL_SECONDS,
          maxRestartAttempts: DEFAULT_MAX_RESTART_ATTEMPTS,
        },
      });
      await expect(loadSettings(["--config", configPath], {
        LOCAL_REVIEW_MCP_TOKEN: "env-token",
      })).resolves.toMatchObject({ auth: { token: "env-token" } });
      await expect(loadSettings([
        "--config", configPath,
        "--port", "12081",
        "--workspace", "cli-workspace",
        "--token", "cli-token",
      ], {})).resolves.toEqual({
        host: DEFAULT_HOST,
        port: 12081,
        workspace: "cli-workspace",
        auth: { token: "cli-token" },
        remote: { enabled: false, endpoint: "" },
        supervisor: {
          enabled: false,
          healthIntervalSeconds: DEFAULT_HEALTH_INTERVAL_SECONDS,
          maxRestartAttempts: DEFAULT_MAX_RESTART_ATTEMPTS,
        },
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
      "--token", "token",
    ])).toEqual({
      configPath: "settings.json",
      port: "12081",
      workspace: "workspace",
      token: "token",
    });
  });

  it("resolves the token in CLI, environment, then config order", () => {
    const common = { configWorkspace: "workspace", configToken: "config-token", envToken: "env-token" };
    expect(resolveSettings(common).auth.token).toBe("env-token");
    expect(resolveSettings({ ...common, cliToken: "cli-token" }).auth.token).toBe("cli-token");
  });

  it("requires stable Named Tunnel configuration for Cloudflare", () => {
    expect(resolveSettings({ configWorkspace: "workspace", configToken: "token" }).remote)
      .toEqual({ enabled: false, endpoint: "" });
    expect(() => resolveSettings({
      configWorkspace: "workspace",
      configToken: "token",
      configRemote: { enabled: true, provider: "cloudflare" },
    })).toThrow("remote.endpoint");
    expect(() => resolveSettings({
      configWorkspace: "workspace",
      configToken: "token",
      configRemote: { enabled: true, provider: "cloudflare", endpoint: "https://review.example/mcp" },
    })).toThrow("remote.tunnelName");
    expect(resolveSettings({
      configWorkspace: "workspace",
      configToken: "token",
      configRemote: {
        enabled: true,
        provider: "cloudflare",
        tunnelName: "review-tunnel",
        endpoint: "https://review.example/mcp",
      },
    }).remote).toEqual({
      enabled: true,
      provider: "cloudflare",
      tunnelName: "review-tunnel",
      endpoint: "https://review.example/mcp",
    });
    expect(resolveSettings({
      configWorkspace: "workspace",
      configToken: "token",
      configRemote: { enabled: true, provider: "cloudflare", tunnelName: "review-tunnel" },
      envRemoteEndpoint: "https://review.example/mcp",
    }).remote).toEqual({
      enabled: true,
      provider: "cloudflare",
      tunnelName: "review-tunnel",
      endpoint: "https://review.example/mcp",
    });
  });

  it("defaults the supervisor off and accepts bounded recovery settings", () => {
    expect(resolveSettings({ configWorkspace: "workspace", configToken: "token" }))
      .toMatchObject({
        supervisor: {
          enabled: false,
          healthIntervalSeconds: DEFAULT_HEALTH_INTERVAL_SECONDS,
          maxRestartAttempts: DEFAULT_MAX_RESTART_ATTEMPTS,
        },
      });
    expect(resolveSettings({
      configWorkspace: "workspace",
      configToken: "token",
      configSupervisor: {
        enabled: true,
        healthIntervalSeconds: 10,
        maxRestartAttempts: 2,
      },
    })).toMatchObject({
      supervisor: {
        enabled: true,
        healthIntervalSeconds: 10,
        maxRestartAttempts: 2,
      },
    });
  });

  it("rejects invalid supervisor settings", () => {
    const common = { configWorkspace: "workspace", configToken: "token" };
    expect(() => resolveSettings({ ...common, configSupervisor: { enabled: "yes" } }))
      .toThrow("supervisor.enabled");
    expect(() => resolveSettings({ ...common, configSupervisor: { healthIntervalSeconds: 0 } }))
      .toThrow("healthIntervalSeconds");
    expect(() => resolveSettings({ ...common, configSupervisor: { maxRestartAttempts: -1 } }))
      .toThrow("maxRestartAttempts");
  });

  it("rejects invalid authentication and remote configuration", () => {
    expect(() => resolveSettings({ configWorkspace: "workspace", configToken: "" }))
      .toThrow("auth.token");
    expect(() => resolveSettings({
      configWorkspace: "workspace",
      configToken: "token",
      configRemote: { enabled: true },
    })).toThrow("remote.provider");
    expect(() => resolveSettings({
      configWorkspace: "workspace",
      configToken: "token",
      configRemote: { enabled: "yes", provider: "cloudflare" },
    })).toThrow("remote.enabled");
    expect(() => resolveSettings({
      configWorkspace: "workspace",
      configToken: "token",
      configRemote: { enabled: true, provider: "unsupported" },
    })).toThrow("remote.provider");
    expect(() => resolveSettings({
      configWorkspace: "workspace",
      configToken: "token",
      configRemote: {
        enabled: true,
        provider: "cloudflare",
        tunnelName: "bad name",
        endpoint: "https://review.example/mcp",
      },
    })).toThrow("remote.tunnelName");
    expect(() => resolveSettings({
      configWorkspace: "workspace",
      configToken: "token",
      configRemoteEndpoint: "not-a-url",
    })).toThrow("remote.endpoint");
  });
});
