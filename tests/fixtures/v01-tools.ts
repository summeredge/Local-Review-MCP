export const EXPECTED_V01_TOOL_NAMES = [
  "workspace_info",
  "list_files",
  "read_file",
  "search_text",
  "git_status",
  "git_diff",
] as const;

export const EXPECTED_REGISTERED_TOOL_NAMES = [
  ...EXPECTED_V01_TOOL_NAMES,
  "workspace_list",
] as const;
