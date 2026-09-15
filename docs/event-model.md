# Interactive Backend 事件模型（Phase 0）

状态：冻结设计，文档阶段。

原则：provider 原始事件只在 Backend 内部存在；LRM Core 接收并持久化的是
带有 LRM identity 的 normalized event。app-server JSON-RPC、CLI JSONL、
approval request 和 provider-specific item shape 不能泄漏到 LRM 的通用事件
接口。

## 1. 事件边界

```text
CliBackend / CodexAppServerBackend
        |
        | provider raw response / notification
        v
ExecutionService
        |
        | identity validation + ordering + normalization
        v
LRM normalized events
        |
        +-- lifecycle persistence
        +-- UI/control-plane subscription
        +-- Goal/Task/Review orchestration hooks
```

MCP Data Plane 不新增 raw-event tool。后续若需要 UI subscription，读取的是
下面的 normalized contract，并且需要单独定义权限、分页和 retention。

## 2. Normalized envelope

每个事件都必须带完整或可验证的 LRM identity：

```json
{
  "schema_version": 1,
  "sequence": 7,
  "occurred_at": "RFC3339 timestamp",
  "type": "execution_status",
  "workspace_id": "workspace-a",
  "task_id": "task-1",
  "execution_id": "execution-1",
  "session_id": "session-1",
  "turn_id": "turn-1",
  "state": "running"
}
```

规则：

- `sequence` 在一个 Execution 内单调递增；重放必须复用同一序号，不能依赖时间排序。
- `session_id`、`turn_id` 只在已证明的 interactive identity 上出现；CLI 不填假值。
- `schema_version` 是 LRM normalized event 的版本，不是 provider app-server 版本。
- provider raw payload 不放入 `content`、`details`、`metadata` 或未约束的 escape hatch。
- event identity 不从另一条 event、Goal 文本、provider 最近记录或 UI 状态推断。

## 3. 最小事件集合

Phase 0 只冻结三个必要事件族；未请求的 tool-progress、reasoning、raw
response 事件不进入第一版通用 contract。

### `execution_status`

```json
{
  "type": "execution_status",
  "state": "creating_session | thread_ready | running | waiting_user | completed | failed",
  "reason": "optional bounded diagnostic code",
  "session_id": "optional",
  "turn_id": "optional"
}
```

`reason` 是有限、可诊断的 LRM code 或短摘要，不是 provider 原始错误对象。
终态必须明确：`completed` 只能来自 provider success evidence，`failed` 只能
来自 provider/infrastructure failure evidence。

### `agent_message`

```json
{
  "type": "agent_message",
  "content": "new text fragment",
  "final": false,
  "item_id": "optional normalized opaque item id"
}
```

`content` 是本事件新增的文本片段，不是每次重复发送的完整 transcript。
`final=true` 标记该 message item 已完成；允许 `content` 为空，仅用于结束
一个已发送过 delta 的 item。若 provider 只提供最终文本，Backend 发送一次
`final=true` 事件即可。

### `user_input_required`

```json
{
  "type": "user_input_required",
  "request_kind": "user_input | approval",
  "prompt": "bounded user-facing prompt",
  "options": [
    { "id": "option-id", "label": "label" }
  ],
  "blocking": true
}
```

该事件与同一 Execution 的 `execution_status(state=waiting_user)` 配对。
用户作答/授权后 Backend 发送 provider response，状态回到 `running`；没有
用户动作时不能自动把等待视为成功或失败。

Approval 的实际权限仍由 LRM Core policy 决定，Backend 只负责将已批准/拒绝
的决定编码回 provider protocol。provider approval payload、command、完整
路径和 token 不进入 normalized event，除非未来 schema 明确定义允许的字段。

## 4. 状态事件与转换

```text
accepted              # submit_goal receipt，不是 runtime event 必需字段
  -> waiting_identity # PendingGoalSubmission identity gate
  -> creating_session
  -> thread_ready     # interactive only
  -> running <-> waiting_user
  -> completed | failed
```

严格规则：

| 当前 | 允许的下一状态 | 说明 |
| --- | --- | --- |
| `creating_session` | `thread_ready`, `running`（CLI 快路径）, `failed` | CLI 没有 Thread ready 阶段 |
| `thread_ready` | `running`, `failed` | 必须已有精确 provider Thread reference |
| `running` | `waiting_user`, `completed`, `failed` | 仅 provider terminal evidence 可结束 |
| `waiting_user` | `running`, `failed` | waiting 是非终态 |
| `completed` | 无 | terminal |
| `failed` | 无 | terminal；重试需新 Execution 或明确恢复规则 |

`accepted` 和 `waiting_identity` 属于 submission lifecycle：
`PendingGoalSubmission.state=pending_identity` 是当前实现的对应记录。它们
不能被塞入现有 `ExecutionContext.status`。

## 5. Provider event mapping

Backend 必须按当前实际 provider schema 解析；下表是语义映射，不是允许把
原始 method name 传播出去。

| Provider observation | Normalized event |
| --- | --- |
| app-server `thread/start` response 或 `thread/started` | `execution_status(thread_ready)`，附已验证 `session_id` |
| app-server `turn/start` response 或 `turn/started` | `execution_status(running)`，附 `turn_id` |
| app-server `item/agentMessage/delta` | `agent_message(final=false, content=delta)` |
| app-server agent-message `item/completed` | `agent_message(final=true)` 或只发送未发出的 final suffix，不能重复文本 |
| app-server `item/tool/requestUserInput` | `user_input_required(user_input)` + `execution_status(waiting_user)` |
| app-server approval request | `user_input_required(approval)` + `execution_status(waiting_user)` |
| app-server `turn/completed` with success | `execution_status(completed)` |
| app-server `turn/completed` with failed/interrupted status | `execution_status(failed, reason=...)` |
| app-server `thread/status/changed` with waiting flag | `waiting_user`；没有 turn terminal evidence 时不结束 |
| CLI JSONL `turn.completed` | `execution_status(completed)`，仍需通过 CLI completion identity gate |
| CLI JSONL `turn.failed` / confirmed process failure | `execution_status(failed)` |
| provider retryable error (`willRetry=true`) | 不产生终态；等待后续 provider event |
| schema/identity/protocol mismatch | `execution_status(failed)`，不猜测成功 |

`item.started`、`item.completed`、command output、reasoning summary 等只在
Backend 内部用于组合上面的最小事件。第一版不定义通用 `tool_activity` 或
`reasoning` 事件；需要时另行扩展 schema。

## 6. Event ordering、重复与恢复

1. `ExecutionService` 先验证 event 的 `workspace_id/task_id/execution_id`，再允许它改变状态。
2. Session/Turn reference 必须与已持久化的 Session 绑定；缺失或冲突直接 fail closed。
3. 同一 provider notification 的重试/重放不能产生第二份 message content 或第二次 terminal transition。
4. `agent_message` delta 以 provider item/turn identity 去重；完成事件不能覆盖已发送的 delta。
5. terminal `completed` 与 terminal `failed` 同时出现时视为冲突，不能选择较新的时间戳冒充结果。
6. app-server reconnect 后从已知 Thread/Turn 的 provider history 或受支持 cursor 重建 normalized sequence；不能重新创建 Thread。
7. 丢失 response/ACK 时，只有能证明 provider turn identity 和当前状态，才允许恢复；否则停在 failure/indeterminate，并要求显式后续动作。
8. 事件落盘必须使用现有 app-local state boundary 和 workspace partition；不写入 workspace 的 `.review` 文件。

## 7. 与现有 ExecutionContext 的投影

现有 `ExecutionContext.status` 保持兼容：

```text
execution_status(creating_session/thread_ready/running/waiting_user)
    -> ExecutionContext.status = running

execution_status(completed)
    -> ExecutionContext.status = passed

execution_status(failed)
    -> ExecutionContext.status = failed
```

`GoalOrchestrationService` 仍通过现有 Goal/Task/Auto Iteration 流程消费
terminal Execution。normalized events 不直接创建 ReviewRequest，也不改变
ConversationRouting 的 authority。

## 8. UI 与外部接口

UI 只消费：

- `execution_status`：展示创建、ready、running、waiting user、terminal；
- `agent_message`：按 sequence 拼接文本片段；
- `user_input_required`：展示受约束的输入/approval 控件。

UI 不消费：

- app-server JSON-RPC envelope；
- CLI stdout/stderr 原文；
- provider reasoning、完整 command payload、token 或任意 raw error object；
- 未经 LRM identity 验证的 Thread/Turn id。

事件流不是 `submit_goal` 的同步返回值。`submit_goal` 继续只返回兼容的
acceptance receipt；后续 event subscription/status read contract 另行定义。

## 9. Phase 0 验收清单

- [x] CLI 与 app-server 使用同一个 provider-neutral Backend boundary。
- [x] Session（长期 Thread context）与 Execution（一次运行）分离。
- [x] interactive Execution 与 provider Turn 1:1；CLI 不伪造 Thread/Turn。
- [x] `submit_goal` 只增加可选 `execution_mode`，默认 batch。
- [x] LRM normalized events 不携带 provider raw event shape。
- [x] `waiting_user` 是非终态，`completed/failed` 只由明确证据产生。
- [x] model/effort 通过 `model/list` 动态发现，不硬编码。
