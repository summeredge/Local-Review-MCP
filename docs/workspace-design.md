# Workspace design

## Scope

The workspace registry is the data-plane boundary for Local Review MCP. It
selects an authorized local workspace for read, search, Git, and review-context
operations. It does not bind a workspace to a conversation or session, and it
does not provide agent-control or execution capabilities.

## Registry

The registry contains only workspaces authorized by the local configuration
owner:

```text
Workspace Registry
    |
    +-- workspace A
    +-- workspace B
```

It is responsible for:

- saving authorized workspaces;
- preserving a stable `workspace_id` for each registered workspace;
- providing the authorized workspace set for Launcher management and MCP
  runtime selection.

The MCP runtime reads this registry. It does not add, remove, or mutate
registry entries.

## Workspace context

The shared context schema is:

```json
{
  "workspace_id": "string",
  "workspace_name": "string"
}
```

`workspace_info` and `review_summary` extend this context with their existing
fields. `git_status` and `git_diff` include the selected `workspace_id`; their
workspace is determined by the same registry selection used by every other
workspace-scoped tool.

## Workspace ID lifecycle

For a configured registry, `workspaces[].id` is the stable workspace identity:

1. The configuration owner generates an ID when a workspace is added.
2. The ID is persisted in the existing `workspaces[].id` field and is loaded
   unchanged on later starts.
3. `WorkspaceRegistry` resolves by that ID. It does not derive the registry ID
   from the workspace path, so changing a registered path does not change the
   ID.
4. Removing a workspace removes that ID from the registry. Adding it again may
   use a newly generated ID; the old ID is not implicitly reused.

LRM V0.1 does not expose a registry mutation tool. Add/remove operations belong
to the local configuration owner; the MCP runtime only validates and reads the
registry. The legacy configuration without `workspaces` remains supported. In
that compatibility path, the single wrapper uses the fixed `legacy-workspace`
identity; use an explicit `workspaces` registry for the persisted multi-
workspace ID contract above.

## Active workspace strategy

`workspace_id` is optional on all workspace-scoped tools in V0.1.

```text
workspace_id present    -> use the matching registered workspace
workspace_id omitted    -> use the registry's active workspace
```

The active workspace is selected from the configured top-level `workspace`
identity when it is present. Older configurations may provide only its path;
that path is matched to a registered entry, otherwise the first registry entry
is the legacy active workspace. A legacy single-workspace configuration is
wrapped as a one-entry registry. An unknown `workspace_id` is rejected and
never treated as a filesystem path.

## Runtime

The active workspace runtime remains part of V0.1. The registry selects it, and
the MCP server performs read-only operations against that selection:

```text
Workspace Registry
    |
    v
Runtime Config identity
    |
    v
MCP Runtime
```

An explicit `workspace_id` selects another registered workspace for one tool
call. Omitting it preserves the existing active-workspace fallback.

At runtime, the active registry identity and the runtime workspace identity are
validated as `{ id, name, path }`. A mismatch fails with
`WORKSPACE_IDENTITY_MISMATCH`; it is never repaired by deriving an ID from a
path or by silently selecting another record.

## Security boundary

The allowed path flow is:

```text
Launcher user selects path
        |
        v
Registry saves authorized workspace
        |
        v
MCP accesses the registered workspace
```

ChatGPT or any MCP caller must not provide an arbitrary local filesystem path
to select a workspace. `workspace_id` resolves only to a registry entry, and
tool path arguments remain workspace-relative and subject to containment and
sensitive-path checks.

## Out of scope

This model intentionally does not include Workspace-to-Conversation or
Workspace-to-ChatGPT-Project binding, C2C session lifecycle/state, or an agent
control plane. It also does not provide file writes, command execution, or Git
mutation.

Future automatic review task flows must carry an explicit `workspace_id` at
each task boundary. They must not rely on the active-workspace fallback.
