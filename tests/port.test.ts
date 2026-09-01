import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../src/app.js";
import { checkPort } from "../src/mcp/http.js";

const openSockets: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(openSockets.splice(0).map((socket) => new Promise<void>((resolve) => socket.close(() => resolve()))));
});

async function getFreePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", () => resolve()));
  const address = socket.address();
  if (address === null || typeof address === "string") throw new Error("test socket has no port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

describe("port checks", () => {
  it("reports an available port by completing successfully", async () => {
    await expect(checkPort({
      host: "127.0.0.1",
      port: await getFreePort(),
      workspace: process.cwd(),
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
    })).resolves.toBeUndefined();
  });

  it("rejects an occupied port without choosing another one", async () => {
    const socket = createServer();
    openSockets.push(socket);
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", () => resolve()));
    const address = socket.address();
    if (address === null || typeof address === "string") throw new Error("test socket has no port");

    await expect(checkPort({
      host: "127.0.0.1",
      port: address.port,
      workspace: process.cwd(),
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
    })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("fails runtime startup with the occupied address and port", async () => {
    const socket = createServer();
    openSockets.push(socket);
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", () => resolve()));
    const address = socket.address();
    if (address === null || typeof address === "string") throw new Error("test socket has no port");

    await expect(startApp({
      host: "127.0.0.1",
      port: address.port,
      workspace: process.cwd(),
      auth: { token: "test-token" },
      remote: { enabled: false, endpoint: "" },
    })).rejects.toThrow(
      `127.0.0.1:${address.port} is already in use`,
    );
  });
});
