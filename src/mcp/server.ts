import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const V01_TOOL_NAMES = [
  "workspace_info",
  "list_files",
  "read_file",
  "search_text",
  "git_status",
  "git_diff",
] as const;

export type V01ToolName = typeof V01_TOOL_NAMES[number];

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "local-review-mcp", version: "0.1.0" });

  for (const name of V01_TOOL_NAMES) {
    server.registerTool(
      name,
      {
        description: `Local Review MCP read-only tool ${name}; not implemented in V0.1.`,
        inputSchema: {},
      },
      async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ status: "not_implemented", tool: name }),
          },
        ],
      }),
    );
  }

  return server;
}
