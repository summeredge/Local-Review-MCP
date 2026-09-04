# MCP tool contract

This document freezes the V0.1 Release Candidate tool surface. All nine tools
are read-only. The names and input fields below are the current MCP contract;
the runtime does not add write, exec, shell, commit, or push operations.

| Tool | Scope | Permission |
| --- | --- | --- |
| `workspace_list` | global | read-only |
| `workspace_info` | workspace | read-only |
| `list_files` | workspace | read-only |
| `read_file` | workspace | read-only |
| `search_text` | workspace | read-only |
| `git_status` | workspace | read-only |
| `git_diff` | workspace | read-only |
| `review_summary` | workspace | read-only |
| `execution_output` | workspace | read-only |

## Common rules

- The HTTP endpoint requires the configured Bearer token or a valid local OAuth
  access token. In-process tests use the same handlers without HTTP auth.
- `workspace_id` is an optional string of 1..128 characters on
  workspace-scoped tools. When present it selects a registered workspace; when
  omitted the active workspace is used. `workspace_list` is registry-scoped
  and has no `workspace_id` input.
- Workspace paths are relative to the selected workspace and pass the existing
  containment and sensitive-path policy. Absolute paths and path traversal are
  rejected.
- Tool failures return JSON error objects with `isError: true`; successful
  structured tools keep their existing text JSON and `structuredContent`
  representation.

## Tools

### `workspace_info`

- Purpose: Return metadata about one authorized workspace.
- Input: `{ "workspace_id"?: string }`
- Output:

  ```json
  {
    "workspace_id": "string",
    "workspace_name": "string",
    "root_alias": "workspace:/",
    "project_types": ["string"]
  }
  ```

- Workspace scope: selected registry workspace, or active workspace when the
  ID is omitted.
- Permission: authenticated read-only; project detection checks only bounded
  workspace entries.

### `workspace_list`

- Purpose: List authorized workspaces without exposing local paths.
- Input: `{}`
- Output: `{ "workspaces": [{ "id": "string", "name": "string" }] }`
- Workspace scope: authorized registry; no single workspace is selected.
- Permission: authenticated read-only registry metadata. Local filesystem
  paths are not returned.

### `list_files`

- Purpose: List authorized files and directories within a workspace.
- Input:

  ```json
  {
    "workspace_id"?: "string",
    "path"?: "string",
    "depth"?: "integer, 1..4",
    "offset"?: "integer, >= 0",
    "limit"?: "integer, 1..1000"
  }
  ```

  Defaults: `path="."`, `depth=1`, `offset=0`, `limit=200`.
- Output: `{ "path": string, "entries": [{ "path": string, "name": string, "type": "file"|"directory" }], "offset": integer, "returned": integer, "has_more": boolean }`
- Workspace scope: selected workspace directory.
- Permission: authenticated read-only listing subject to workspace containment
  and sensitive-path policy; bounded traversal and pagination apply.

### `read_file`

- Purpose: Read a bounded range of an authorized text file.
- Input:

  ```json
  {
    "workspace_id"?: "string",
    "path": "string",
    "start_line"?: "integer, >= 1",
    "max_lines"?: "integer, 1..2000",
    "max_bytes"?: "integer, 1..1048576"
  }
  ```

  Defaults: `start_line=1`, `max_lines=400`, `max_bytes=262144`.
- Output: `{ "path": string, "start_line": integer, "end_line": integer, "has_more": boolean, "content": string, "truncated"?: boolean }`
- Workspace scope: selected workspace file.
- Permission: authenticated read-only text-file access. The file must be a
  regular, non-sensitive, non-binary file and the read remains bounded.

### `search_text`

- Purpose: Search authorized non-sensitive text files with bounded matching.
- Input:

  ```json
  {
    "workspace_id"?: "string",
    "query": "string, 1..1000 characters, non-empty, no NUL",
    "path"?: "string",
    "glob"?: "string, 1..1000 characters",
    "regex"?: boolean,
    "case_sensitive"?: boolean,
    "limit"?: "integer, 1..200"
  }
  ```

  Defaults: `path="."`, `regex=false`, `case_sensitive=false`, `limit=100`.
- Output: `{ "query"?: string, "path": string, "regex": boolean, "case_sensitive": boolean, "results": [{ "path": string, "line": integer, "column": integer, "preview": string }], "returned": integer, "has_more": boolean, "engine": "ripgrep"|"node" }`
- Workspace scope: selected workspace and its approved search candidates.
- Permission: authenticated read-only search. Sensitive, ignored, binary,
  oversized, and escaping paths are excluded before either search engine runs.

### `git_status`

- Purpose: Return the Git status for an authorized workspace repository.
- Input: `{ "workspace_id"?: string }`
- Output: `{ "branch": string|null, "entries": [{ "path": string, "index": string, "worktree": string, "status": "modified"|"added"|"deleted"|"renamed"|"untracked", "original_path"?: string }] }`
- Workspace scope: selected workspace Git repository.
- Permission: authenticated read-only Git status. Git arguments are not
  caller-controlled and no Git mutation is performed.

### `git_diff`

- Purpose: Return a bounded Git diff for an authorized workspace repository.
- Input: `{ "workspace_id"?: string, "path"?: string, "stat"?: boolean }`

  Defaults: `path="."`, `stat=false`.
- Output: `{ "path": string, "stat": boolean, "diff": string, "files": string[], "binary": boolean, "binary_paths"?: string[] }`
- Workspace scope: selected workspace repository and optional relative path.
- Permission: authenticated read-only bounded Git diff. The existing Git
  service validates repository and path containment and performs no mutation.

### `review_summary`

- Purpose: Return the read-only Git and workspace summary used by review.
- Input: `{ "workspace_id"?: string }`
- Output:

  ```json
  {
    "workspace_id": "string",
    "workspace_name": "string",
    "git_branch": "string or null",
    "git_status_summary": { "modified": integer, "added": integer, "deleted": integer },
    "diff_summary": { "files_changed": integer, "insertions": integer, "deletions": integer }
  }
  ```

- Workspace scope: selected workspace, or active workspace when the ID is
  omitted.
- Permission: authenticated read-only review context; combines the existing
  Git status and diff readers.

### `execution_output`

- Purpose: Read the fixed review execution result for an authorized workspace.
- Input: `{ "workspace_id"?: string }`
- Output: the JSON object stored at `.review/execution_output.json`; when the
  file is absent, `{ "available": false }` is returned. Existing optional
  fields such as `timestamp`, `command`, `status`, and `summary` are preserved,
  and additional object fields remain compatible.
- Workspace scope: selected workspace fixed path `.review/execution_output.json`.
- Permission: authenticated read-only result access. It never accepts a path,
  runs a command, or exposes an execution capability.
