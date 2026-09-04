# Workspace design

## Scope

The workspace registry is the data-plane boundary for Local Review MCP. It
selects an authorized local workspace for read, search, Git, and review-context
operations. It does not bind a workspace to a conversation or session, and it
does not provide agent-control or execution capabilities.

## Workspace context

The shared context schema is:

```json
{
  "workspace_id": "string",
  "workspace_name": "string"
}
```

`workspace_info` and `review_summary` extend this context with their existing
fields. The existing `git_status` and `git_diff` response shapes remain
unchanged; their selected workspace is determined by the request scope.

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
that compatibility path, the single wrapper uses the existing deterministic
`WorkspaceManager.workspaceId`; use an explicit `workspaces` registry for the
persisted multi-workspace ID contract above.

## Active workspace strategy

`workspace_id` is optional on all workspace-scoped tools in V0.1.

```text
workspace_id present    -> use the matching registered workspace
workspace_id omitted    -> use the registry's active workspace
```

The active workspace is selected from the configured top-level `workspace` path
when it matches a registered entry; otherwise the first registry entry is the
legacy active workspace. A legacy single-workspace configuration is wrapped as
a one-entry registry. An unknown `workspace_id` is rejected and never treated
as a filesystem path.

Future automatic review task flows must carry an explicit `workspace_id` at
each task boundary. They must not rely on the active-workspace fallback.
