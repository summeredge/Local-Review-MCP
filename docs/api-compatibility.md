# API compatibility

This document defines how the frozen V0.1 MCP contract may evolve. The current
tool names, input fields, output fields, workspace scope, and read-only
permission model are the compatibility baseline.

## Allowed additive changes

The following changes are compatible when existing callers keep working:

- add fields to an existing response;
- add a new read-only Tool;
- add optional input parameters with behavior-preserving defaults.

New tools must use the existing Workspace Registry boundary and must not add
write, `apply_patch`, `exec`, `shell`, commit, or push capabilities.

## Changes requiring careful review

The following changes are potentially breaking and must not be treated as
ordinary additive updates:

- delete a response field;
- change the meaning of a field;
- change an existing Tool name;
- change the permission model.

Before accepting one of these changes, update the contract documentation,
review client impact, and make the schema/version decision explicit. This V0.1
freeze does not make any of these changes.

## Compatibility expectations

Existing clients may continue to call all nine frozen tools and receive their
current response structures. `tools/list` therefore remains the same nine-tool
surface until an explicitly reviewed API change says otherwise. Workspace
selection continues to resolve only registered `workspace_id` values, never an
arbitrary caller-supplied local path.
