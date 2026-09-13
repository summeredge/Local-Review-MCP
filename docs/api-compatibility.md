# API compatibility

This document defines how the frozen V0.1 MCP contract may evolve. The current
tool names, input fields, output fields, workspace scope, and permission model
are the compatibility baseline. The current surface has ten read-only tools
and the reviewed `submit_goal` Control Plane tool.

## Allowed additive changes

The following changes are compatible when existing callers keep working:

- add fields to an existing response;
- add a new read-only Tool;
- add optional input parameters with behavior-preserving defaults.

New tools must use the existing Workspace Registry boundary and must not add
direct write, `apply_patch`, `exec`, `shell`, commit, or push capabilities.
`submit_goal` is the explicit exception for creating a Goal through the
existing controlled execution path; it does not expose a direct file or shell
operation.

## Changes requiring careful review

The following changes are potentially breaking and must not be treated as
ordinary additive updates:

- delete a response field;
- change the meaning of a field;
- change an existing Tool name;
- change the permission model.

Before accepting one of these changes, update the contract documentation,
review client impact, and make the schema/version decision explicit. The
P3.2C-1R correction intentionally removes `conversation_id` from the newly
introduced `prepare_goal_handoff` preparation envelope before its downstream
consumer exists; its schema version remains `1`, while `submit_goal` is
unchanged. See `tool-contract.md` for the current handoff contract.

## Compatibility expectations

Existing clients may continue to call all nine frozen read-only tools and
receive their current response structures. `tools/list` additionally exposes
the read-only `prepare_goal_handoff` tool and the explicitly reviewed
`submit_goal` Control Plane entry point. Workspace selection continues to
resolve only registered `workspace_id` values, never an arbitrary
caller-supplied local path.
