import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../../src/app.js";
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

async function getHealth(port: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/health", method: "GET" }, (response) => {
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
  it("returns safe health metadata without requiring the MCP token", async () => {
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

    const response = await getHealth(address.port);
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
  });
});
