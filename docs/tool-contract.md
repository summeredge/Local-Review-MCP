# MCP tool contract

The runtime registers 22 tools: 20 read-only tools, the `submit_goal` Control Plane entry point, and the explicitly authorized `workspace_edit_file` exception. It exposes no exec, shell, commit, or push operation.

| Tool | Scope | Permission |
| --- | --- | --- |
| `workspace_edit_file` | explicit workspace | opt-in precise replacement |
| `workspace_list` | global | read-only |
| `workspace_info` | workspace | read-only |
| `list_files` | workspace | read-only |
| `read_file` | workspace | read-only |
| `search_text` | workspace | read-only |
| `git_status` | workspace | read-only |
| `git_diff` | workspace | read-only |
| `review_summary` | workspace | read-only |
| `execution_output` | workspace | read-only |
| `workspace_get_info` | explicit workspace | read-only |
| `workspace_list_files` | explicit workspace | read-only |
| `workspace_read_file` | explicit workspace | read-only |
| `workspace_search` | explicit workspace | read-only |
| `workspace_review_context` | explicit workspace | read-only |
| `get_session_status` | workspace | read-only |
| `get_execution_status` | workspace | read-only |
| `list_session_events` | workspace | read-only |
| `list_execution_events` | workspace | read-only |
| `get_identity_trace` | correlation key | read-only |
| `get_evidence_transport_trace` | correlation key | read-only |
| `submit_goal` | current ChatGPT conversation | Control Plane |

## 文件工具选择与兼容审计（任务 B）

公开工具数量保持 **22 → 22**。推荐 `workspace_list_files`、`workspace_read_file`、`workspace_search`；三个旧入口继续注册。已实现选择指引收敛；接口等价合并和撤销注册未实施。

| 接口组 | 已实现与差异 | 决策 |
| --- | --- | --- |
| `list_files` → `workspace_list_files` | 共同复用 server.ts 的 listFiles，都有 path/depth/offset/limit；depth 默认分别为 1、4。旧输出含目录、name/type、offset/returned；标准输出只有文件路径和 has_more。 | 部分等价。目录及类型无标准替代，保留旧入口。 |
| `read_file` → `workspace_read_file` | 共同复用 readFilePage。旧 max_lines 默认 400、最多 2000，max_bytes 默认 256 KiB、最多 1 MiB；标准 start_line/end_line 默认 200 行，最多 1000 行/256 KiB，另有可选 sha256 和 next_start_line。 | 部分等价。自定字节预算和 2000 行单次请求无等价替代，保留旧入口。 |
| `search_text` → `workspace_search` | 共同复用 workspace/search.ts 的 searchText，都有 query/path/limit。标准固定字面量、忽略大小写，返回 path/line/text、truncated；旧接口另有 regex/glob/case_sensitive、column/preview、engine/returned/has_more。 | 部分等价。高级过滤及元数据未补齐，保留旧入口。 |

已验证依赖及兼容阻断：

- `src/mcp/server.ts` 的 V01/REGISTERED_TOOL_NAMES 和注册是公开清单源；`src/app.ts`、`src/cli.ts`、`src/mcp/http.ts` 用清单生成数量或日志。
- `tests/list-files.test.ts`、`read-file.test.ts`、`read-file-resource-limit.test.ts`、`search-text.test.ts`、`search-security.test.ts` 直接调用旧名称，覆盖目录类型、预算、正则/glob/大小写及安全限制。`workspace-registry.test.ts` 覆盖旧接口显式选择和省略 ID 的 active 回退。
- `tests/mcp-http.test.ts`、`tests/remote/remote.test.ts` 有旧名称的 HTTP/远程 MCP Client 调用；`tests/tool-registry.test.ts` 验证旧输出 Schema。这些是兼容场景证据，不代表已证明有生产外部调用者。
- `tests/review/workspace-tools.test.ts`、`workspace-reader.test.ts`、`tests/e2e/review-loop.test.ts` 使用标准接口；`tests/workspace-edit.test.ts` 依赖标准读取的原始字节哈希。任务 A 的读取、编辑实现不变。
- 全仓库按六个精确工具名检索（包含隐藏配置，排除 Git、依赖及构建产物），Extension、Connector 实现和配置中未发现按名调用。Connector 测试中的 tool_name=read_file 是非 workspace_info 的负向样本。动态 MCP 调用及仓库外消费者无法据此排除。
- `docs/api-compatibility.md` 冻结旧名称、字段及工作区行为，`docs/workspace-review-data-plane.md` 明确承诺旧接口兼容。尚无外部消费者迁移完成的证据，不撤销上述契约。
- 两组入口均经过 WorkspaceRegistry/WorkspaceManager/AccessPolicy，保留规范路径隔离、敏感/忽略路径及链接逃逸检查。标准接口强制 workspace_id，旧接口可省略并使用 active；迁移必须明确选择目标工作区。

迁移清单（仅适用于已覆盖能力）：

1. 列表：显式 workspace_id，保持旧默认需 depth=1；仅文件的 entries[].path 可换成 files。offset/limit 在过滤目录之前生效，空 files 且 has_more=true 仍需翻页，不能按 files.length 推进 offset。目录、类型及 returned/offset 消费者继续使用旧接口。
2. 读取：max_lines=n 映射 end_line=start_line+n-1（n≤1000）；旧默认需 n=400。has_more 映射标准 truncated；旧 truncated 专指字节截断，不能按同名字段迁移。next_start_line 沿用按行推进，不提供超长行字节续读；自定 max_bytes 或更大单次预算继续使用旧接口。≤8 MiB 保留完整原始字节同快照 sha256，>8 MiB 保留流式分页并省略哈希；1000 行/256 KiB 返回和 8 MiB 扫描限制不变。
3. 搜索：仅 regex=false、无 glob、case_sensitive=false 且不消费 column/engine 等元数据时迁移 query/path/limit、preview→text、has_more→truncated、returned→results.length。其他场景继续使用 search_text，不能将正则静默当字面量。

缺失能力未通过新参数或兼容层补齐：当前没有已确认需要迁移的生产消费者，旧入口继续提供必要功能。撤销前需确认外部消费者、补齐必要差异、迁移调用方并明确批准冻结契约变更。本次无需手动迁移，不修改 workspace_info/workspace_get_info、Git/Review、状态、事件、诊断或 Control Plane。

## workspace_edit_file

- 工作区配置：`workspaces: [{ "id": "project", "name": "Project", "path": "C:/work/project" }]`。手动注册 Workspace 即授权受控编辑；每次必须明确 `workspace_id` 和原始字节哈希。旧配置遗留授权字段加载时忽略。生产服务需由用户后续 build/restart 才能使本次变更生效；本任务不构建或重启生产服务。
- 必填输入：`workspace_id`、工作区相对 `path`、原始文件完整字节的 `expected_sha256`（64 位小写十六进制）、1–5 项 `edits: [{old_text,new_text}]`。不继承 active/default 工作区。
- 仅编辑一个已存在、可写、无硬链接的常规 UTF-8 文件；输入文件和结果均不超过 1 MiB。拒绝无效 UTF-8、NUL 二进制、敏感/忽略路径、目录、符号链接/Junction、绝对路径和越界路径。`old_text` 非空；每项在同一原始快照中恰好匹配一次；重复、重叠或缺失使整次失败。替换按原始字节定位，保留 BOM；跨行匹配需显式使用原文件的 `\r\n` 或 `\n`，不会自动归一化换行。替换字符串拒绝 NUL 和孤立 surrogate。
- 输出：`{workspace_id,path,success:true,edits_applied,before_sha256,after_sha256,metadata_note}`；仅在同目录独占临时文件写入、fsync、原子 rename 完成后返回成功；失败清理临时文件。annotations 为 `readOnlyHint:false, destructiveHint:true`。
- 进程内复用按规范目标路径串行队列，读取、哈希检查和提交均在临界区内。不保证对外部不协作写入者的原子 CAS：外部原地修改仍可能被覆盖；编辑期间应避免其他程序写同一文件。
- 当前安全写入实现支持 Windows：固定 PowerShell 原生目录句柄辅助进程锁定所有父目录，禁止删除共享，阻止提交期间的目录重定向；目录句柄、独占临时文件写入、Flush(true) 和原子 MoveFileEx 提交均由同一辅助进程持有并执行，辅助进程退出后 Node 不执行磁盘写入；路径仅作为 stdin JSON 数据传递，不执行用户命令。PowerShell 不可用、目录租约失败或其他平台均拒绝写入。现有读取工具不依赖此辅助进程。
- mode bits 保留；非 Windows 当前不开放写入。原子替换产生新 inode；自定义 ACL、xattrs、Windows ADS 和原时间戳不保留，Windows 使用父目录 ACL 继承；成功结果附带此说明。需要保留这些元数据的文件不应使用本工具。
- 错误通过现有 MCP `isError:true` 返回：`EDIT_NOT_AUTHORIZED`、`UNKNOWN_WORKSPACE_ID`、`HASH_CONFLICT`、`TEXT_NOT_FOUND`、`TEXT_NOT_UNIQUE`、`OVERLAPPING_EDITS`、`INVALID_UTF8`、`BINARY_FILE`、`FILE_TOO_LARGE`、`UNSAFE_EDIT_TARGET`、`EDIT_WRITE_FAILED`，以及原有 `INVALID_PATH`、`SENSITIVE_PATH`、`PATH_OUTSIDE_WORKSPACE`、`PATH_NOT_FOUND`；输入 Schema 错误由 MCP SDK 拒绝。
- 文件不超过 8 MiB 时，`workspace_read_file.sha256` 对完整原始字节快照计算，与分页、BOM 去除及换行归一化后的 `content` 同源。超过快照上限时恢复有界流式分页，省略 `sha256`；仍限制每次最多 1000 行、返回内容最多 256 KiB、扫描量最多 8 MiB，扫描超限返回 `READ_SCAN_LIMIT_EXCEEDED`。旧 `read_file` 分页工具保持原行为。

调用示例（先通过 `workspace_read_file` 获取哈希）：

```json
{"workspace_id":"project","path":"src/example.ts","expected_sha256":"<workspace_read_file.sha256>","edits":[{"old_text":"const enabled = false;","new_text":"const enabled = true;"}]}
```

## Common rules

- The HTTP endpoint requires the configured Bearer token or a valid local OAuth
  access token. In-process tests use the same handlers without HTTP auth.
- `workspace_edit_file` and `workspace_*` review data-plane tools require explicit `workspace_id`; they never inherit active/default workspace. Legacy tools retain the following behavior.
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
- Workspace scope: an omitted `workspace_id` may be inferred only when exactly
  one workspace is registered; with multiple workspaces, specify the intended
  ID. An explicit ID must resolve through the Workspace Registry.
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
