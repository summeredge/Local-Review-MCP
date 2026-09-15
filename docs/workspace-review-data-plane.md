# Workspace Review Data Plane

## Architecture

```text
ChatGPT
   |
  MCP
   |
Review Data Plane
   |
Authorized Workspace
```

The data plane reuses the existing `WorkspaceRegistry`, `WorkspaceManager`, text search, and `GitService`. It does not enter the Goal, Session, Execution, launcher, browser, or Codex execution paths.

## Security model

- Every new tool requires an explicit `workspace_id` and resolves it through `WorkspaceRegistry`.
- Every supplied path is normalized, resolved against the registry-owned canonical root, checked for canonical containment, and filtered by `AccessPolicy` before reading.
- Traversal, absolute paths, symlink or Junction escapes, sensitive files, and binary reads are rejected.
- The reported root is the safe `workspace:/` alias, not a local absolute path.
- Tools are read-only and expose no file write, command execution, commit, push, or browser capability.
- File reads default to 200 lines and reject ranges above 1000 lines. Search, file listing, file bytes, Git output, and traversal are bounded by the existing services.

## Tools

- `workspace_get_info`: branch and clean/dirty state for an authorized workspace.
- `workspace_list_files`: bounded workspace-relative file listing below a directory.
- `workspace_read_file`: line-ranged text reading with `truncated` and `next_start_line`.
- `workspace_search`: bounded literal text search returning relative path, line, and text.
- `workspace_review_context`: Git status, staged and unstaged diffs, changed files, summary counts, and review candidates.

Existing `workspace_info`, `list_files`, `read_file`, `search_text`, `git_status`, and `git_diff` remain compatible.
