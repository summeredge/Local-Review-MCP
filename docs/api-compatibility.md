# API compatibility

This document defines how the frozen V0.1 MCP contract may evolve. Existing
tool names, input/output fields, workspace selection, and permissions remain
the compatibility baseline. The nine established read-only contracts remain
supported: the six names in
`V01_TOOL_NAMES` plus `workspace_list`, `review_summary`, and
`execution_output`. The current runtime registers 22 tools: 20 read-only tools,
the existing `submit_goal` Control Plane tool, and `workspace_edit_file`, the
single-file write exception authorized by manual Workspace registration; every
call requires an explicit registered `workspace_id` and original-byte hash.

## Allowed additive changes

The following changes are compatible when existing callers keep working:

- add fields to an existing response only after an explicit compatibility and
  schema decision confirms existing callers remain compatible;
- add a new read-only Tool;
- add optional input parameters with behavior-preserving defaults.

New read-only tools must use the existing Workspace Registry boundary.
`workspace_edit_file` is the only file-write exception: it requires an explicit
registered `workspace_id` and original-byte `expected_sha256` and performs
only the reviewed precise replacement described in `tool-contract.md`. This
does not add arbitrary file writing, `apply_patch`, `exec`, `shell`, commit, or
push capabilities. `submit_goal` remains the existing Control Plane path for
Goal submission; it does not expose a direct file or shell operation.

## Changes requiring careful review

The following changes are potentially breaking and must not be treated as
ordinary additive updates:

- delete a response field;
- change the meaning of a field;
- change an existing Tool name;
- change the permission model.

Before accepting one of these changes, update the contract documentation,
review client impact, and make the schema/version decision explicit.
`submit_goal` requires a new strict UUID v4 `correlation_key` per invocation
and currently returns an asynchronous durable acceptance receipt, as specified
in `tool-contract.md`.

## Compatibility expectations

Existing clients may continue to call the nine established read-only tools
(`workspace_info`, `list_files`, `read_file`, `search_text`, `git_status`,
`git_diff`, `workspace_list`, `review_summary`, and `execution_output`) and
receive their existing response structures. These legacy workspace-scoped
tools retain their optional `workspace_id` behavior and active registered
workspace fallback, but an OAuth caller only sees and resolves workspaces it has
been granted; `workspace_list` returns that authorized subset. New workspace-scoped
`workspace_*` read/review tools require an explicit registered `workspace_id`
and never inherit the active workspace. `workspace_edit_file` also requires
explicit registered `workspace_id` and original-byte `expected_sha256`; manual
Workspace registration authorizes controlled editing. Workspace resolution never treats a caller-supplied local
path as an identity.

`tools/list` also exposes the existing `submit_goal` Control Plane entry point;
it is not a file or shell operation. Its workspace resolution remains part of
the Control Plane contract and uses the Workspace Registry. An omitted
`workspace_id` is inferred only when exactly one workspace is registered;
otherwise the caller must provide an explicit registered ID.

`submit_goal` accepts and durably stores the Goal payload before returning
`{accepted, correlation_key, accepted_at, expires_at}`. This is its current
contract, not a pending compatibility change. The canonical
`conversation_id` may be established later by Extension identity evidence;
`WEB:*` provisional identity is not authority, and Goal startup happens only
after the existing canonical Fiber/URL/document/navigation checks succeed.
