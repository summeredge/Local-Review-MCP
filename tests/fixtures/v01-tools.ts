import {
  REGISTERED_TOOL_NAMES,
  V01_TOOL_NAMES,
} from "../../src/mcp/server.js";

// Derived from the production tool surface so this fixture, verify-remote.ps1,
// and the MCP server can no longer drift apart.
export const EXPECTED_V01_TOOL_NAMES = V01_TOOL_NAMES;
export const EXPECTED_REGISTERED_TOOL_NAMES = REGISTERED_TOOL_NAMES;
