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
  "workspace_get_info",
  "workspace_list_files",
  "workspace_read_file",
  "workspace_search",
  "workspace_review_context",
  "workspace_list",
  "review_summary",
  "execution_output",
  "submit_goal",
  "get_session_status",
  "get_execution_status",
  "list_session_events",
  "get_identity_trace",
  "get_evidence_transport_trace",
] as const;
