# MCP tool contract

This document freezes the V0.1 Release Candidate tool surface. Nineteen tools are
read-only, and `submit_goal` is the reviewed Control Plane entry point. The
names and input fields below are the current MCP contract; the runtime does
not expose direct write, exec, shell, commit, or push operations.

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
| `get_session_status` | workspace | read-only |
| `get_execution_status` | workspace | read-only |
| `list_session_events` | workspace | read-only |
| `get_identity_trace` | correlation key | read-only |
| `get_evidence_transport_trace` | correlation key | read-only |
| `submit_goal` | current ChatGPT conversation | Control Plane |

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
- Output: `{ "workspace_id": string, "branch": string|null, "entries": [{ "path": string, "index": string, "worktree": string, "status": "modified"|"added"|"deleted"|"renamed"|"untracked", "original_path"?: string }] }`
- Workspace scope: selected workspace Git repository.
- Permission: authenticated read-only Git status. Git arguments are not
  caller-controlled and no Git mutation is performed.

### `git_diff`

- Purpose: Return a bounded Git diff for an authorized workspace repository.
- Input: `{ "workspace_id"?: string, "path"?: string, "stat"?: boolean }`

  Defaults: `path="."`, `stat=false`.
- Output: `{ "workspace_id": string, "path": string, "stat": boolean, "diff": string, "files": string[], "binary": boolean, "binary_paths"?: string[] }`
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

### `get_session_status`

- Purpose: Return the normalized read-only Session, Thread, model, effort, Goal,
  and current Execution status.
- Input: `{ "session_id"?: "string", "goal_id"?: "string", "workspace_id"?: "string" }`;
  one of `session_id` or `goal_id` is required.
- Permission: authenticated read-only; the requested record must belong to the
  selected registered workspace.

### `get_execution_status`

- Purpose: Return the read-only Execution status and its proven Session/Thread/
  Turn association, including bounded normalized agent output.
- Input: `{ "execution_id": "string", "session_id"?: "string", "goal_id"?: "string", "workspace_id"?: "string" }`.
- Permission: authenticated read-only; identity mismatches fail closed.

### `list_session_events`

- Purpose: Return the bounded, ordered LRM event stream for one Session.
- Input: `{ "session_id": "string", "workspace_id"?: "string", "after_sequence"?: "integer", "limit"?: "integer" }`.
- Output: `{ "session_id": "string", "events": [], "returned": "integer", "has_more": "boolean" }`.
- Permission: authenticated read-only. Only normalized LRM event fields are
  returned; app-server JSON-RPC payloads are never exposed.

### `get_identity_trace`

- Purpose: Read the ordered, hash-only Browser Extension identity trace for one
  `submit_goal` correlation key.
- Input: `{ "correlation_key": "strict UUID v4" }`.
- Output: `{ "events": [] }`; correlation and conversation identities are
  returned only as SHA-256 hashes. The raw key is used only for lookup.
- Permission: authenticated read-only diagnostic access. It never accepts
  message text, tokens, cookies, or Extension payloads.

### `get_evidence_transport_trace`

- Purpose: Read the ordered Browser Extension to LRM evidence transport
  events for one `submit_goal` correlation key.
- Input: `{ "correlation_key": "strict UUID v4" }`.
- Output: `{ "events": [{ "event": "string", "timestamp": "ISO-8601" }] }`.
  The persisted trace uses only correlation and conversation SHA-256 hashes;
  the query returns no identity values or payloads.
- Permission: authenticated read-only diagnostic access. It never changes
  pending identity state or Goal execution.

### `submit_goal`

- Purpose: Reliably accept a Goal submission for asynchronous Control Plane
  startup through the existing `GoalSubmissionService`.
- Input:

  ```json
  {
    "workspace_id"?: "string",
    "correlation_key": "strict UUID v4",
    "title": "string",
    "goal": "string",
    "requirements": ["string"],
    "acceptance_criteria": ["string"],
    "max_iterations"?: "integer, 1..10000"
  }
  ```

  `max_iterations` defaults to `2`. `conversation_id` is not an input field. The
  model must generate a new UUID v4 `correlation_key` for every invocation and
  never reuse one; users do not need to provide it manually. The key is the
  durable pending-submission id.
- Output:

  ```json
  {
    "accepted": true,
    "correlation_key": "strict UUID v4",
    "accepted_at": "RFC3339 timestamp",
    "expires_at": "RFC3339 timestamp"
  }
  ```

  This receipt only means that LRM durably saved the request. It deliberately
  does not return `goal_id`, `phase_id`, `task_id`, or `execution_id`, because
  the canonical conversation may not exist when `submit_goal` returns.
- Workspace scope: the active registered workspace when `workspace_id` is
  omitted; an explicitly supplied ID must resolve through the Workspace
  Registry.
- Permission: authenticated Control Plane operation. The server resolves the
  workspace through `WorkspaceRegistry`, durably stores a
  `PendingGoalSubmission`, and returns without waiting for identity evidence.
  After the Extension proves the exact canonical ChatGPT route, the existing
  `ConversationCorrelationRegistry` triggers asynchronous consumption and
  `GoalSubmissionService.submitGoal()`.

  Only a real `https://chatgpt.com/c/<conversation_id>` or exact one-segment
  Project route, after the existing Fiber, URL, document, and navigation
  authority checks, may supply `conversation_id`. `WEB:*` provisional identity
  is never an authority. Pending identity expires after two minutes; missing
  evidence therefore creates no Goal. The same `correlation_key` with the same
  payload is idempotent, while a different payload is rejected.
