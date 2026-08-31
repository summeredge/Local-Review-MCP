import type { Server } from "node:http";
import { endpoint, type ResolvedSettings } from "./config/settings.js";
import { isPortInUse, startHttpServer } from "./mcp/http.js";
import { V01_TOOL_NAMES } from "./mcp/server.js";

export async function startApp(settings: ResolvedSettings): Promise<Server> {
  try {
    return await startHttpServer(settings);
  } catch (error: unknown) {
    if (isPortInUse(error)) {
      throw new Error(
        `Local Review MCP cannot start because ${settings.host}:${settings.port} is already in use. `
        + "Choose another port in the Local Review MCP configuration.",
        { cause: error },
      );
    }
    throw error;
  }
}

export function startupMessage(settings: ResolvedSettings): string {
  return [
    "Local Review MCP started",
    `Endpoint: ${endpoint(settings)}`,
    `Tools: ${V01_TOOL_NAMES.length}`,
  ].join("\n");
}
