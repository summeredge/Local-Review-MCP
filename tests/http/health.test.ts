import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../../src/app.js";
import { HealthMonitor } from "../../src/supervisor/health-monitor.js";
import { WorkspaceManager } from "../../src/workspace/manager.js";

const runningServers: Server[] = [];
const temporaryDirectories: string[] = [];
const TOKEN = "health-secret-token";

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function getHealth(port: number, authorization?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/health",
      method: "GET",
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("health endpoint", () => {
  it("requires the MCP token and returns safe health metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-review-mcp-health-"));
    temporaryDirectories.push(workspace);
    const server = await startApp({
      host: "127.0.0.1",
      port: 0,
      workspace,
      auth: { token: TOKEN },
      remote: { enabled: false, endpoint: "" },
      supervisor: { enabled: false, healthIntervalSeconds: 30, maxRestartAttempts: 3 },
    });
    runningServers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no port");

    await expect(getHealth(address.port)).resolves.toMatchObject({ status: 401 });
    await expect(getHealth(address.port, "Bearer wrong-token")).resolves.toMatchObject({ status: 401 });
    const response = await getHealth(address.port, `Bearer ${TOKEN}`);
    const health = JSON.parse(response.text) as Record<string, unknown>;
    const workspaceId = new WorkspaceManager(workspace).workspaceId;

    expect(response.status).toBe(200);
    expect(health).toEqual({
      status: "ok",
      workspace: workspaceId,
      version: "0.1",
      remote_status: "LOCAL_ONLY",
      endpoint_status: "stopped",
    });
    expect(response.text).not.toContain(workspace);
    expect(response.text).not.toContain(TOKEN);
    expect(response.text).not.toContain(process.env.USERNAME ?? "__missing_username__");
    await expect(new HealthMonitor({
      healthUrl: `http://127.0.0.1:${address.port}/health`,
      authToken: TOKEN,
    }).check()).resolves.toBe(true);
  });
});
