import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../src/app.js";
import { checkPort } from "../src/mcp/http.js";
import type { ResolvedSettings } from "../src/config/settings.js";

const runningServers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

async function makeWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-review-mcp-host-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function getFreePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", () => resolve()));
  const address = socket.address();
  if (address === null || typeof address === "string") throw new Error("test socket has no port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

function settings(host: string, workspace: string, port: number): ResolvedSettings {
  return {
    host,
    workspace,
    port,
    auth: { token: "test-token" },
    remote: { enabled: false, endpoint: "" },
  } as unknown as ResolvedSettings;
}

describe("HTTP runtime host security", () => {
  it("starts successfully on the fixed loopback host", async () => {
    const workspace = await makeWorkspace();
    const server = await startApp(settings("127.0.0.1", workspace, await getFreePort()));
    runningServers.push(server);
    expect(server.listening).toBe(true);
  });

  it.each(["0.0.0.0", "::", "192.168.1.10"])(
    "rejects non-loopback host %s before binding",
    async (host) => {
      const workspace = await makeWorkspace();
      const port = await getFreePort();

      await expect(startApp(settings(host, workspace, port))).rejects.toThrow(
        'only "127.0.0.1" is allowed',
      );
      await expect(checkPort(settings("127.0.0.1", workspace, port))).resolves.toBeUndefined();
    },
  );
});
