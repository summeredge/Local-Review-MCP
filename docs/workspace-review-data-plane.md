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
- Read/Review tools remain read-only. The only write exception is `workspace_edit_file`, authorized by manual Workspace registration and requiring an explicit registered `workspace_id` and original-byte hash on every call; no command execution, commit, push, or browser capability is exposed.
- File reads default to 200 lines and reject ranges above 1000 lines. Search, file listing, file bytes, Git output, and traversal are bounded by the existing services.

## Tools

- `workspace_edit_file`: opt-in precise single-file replacement; see [tool contract](tool-contract.md#workspace_edit_file).

- `workspace_get_info`: branch and clean/dirty state for an authorized workspace.
- `workspace_list_files`: bounded workspace-relative file listing below a directory.
- `workspace_read_file`：文件不超过 8 MiB 时，分页内容和完整原始字节 `sha256` 来自同一快照；超过上限时使用原有有界流式分页并省略 `sha256`。保留 `truncated`、`next_start_line`、1000 行/256 KiB 返回限制及 8 MiB 扫描限制。
- `workspace_search`: bounded literal text search returning relative path, line, and text.
- `workspace_review_context`: Git status, staged and unstaged diffs, changed files, summary counts, and review candidates.

Existing `workspace_info`, `list_files`, `read_file`, `search_text`, `git_status`, and `git_diff` remain compatible.

新调用推荐显式选择工作区的 `workspace_list_files`、`workspace_read_file`、`workspace_search`。三个旧文件接口保留目录类型、可调读取预算及高级搜索等差异能力，公开工具仍为 22 个；具体依赖证据和迁移限制见[文件工具兼容审计](tool-contract.md#文件工具选择与兼容审计任务-b)。
