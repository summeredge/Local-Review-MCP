# Goal / Task / Session / Execution / Turn 模型（Phase 2）

状态：Session Model Foundation 已实现。Session 是为长期 Agent context
保留的 Control Plane 对象；本阶段只落地模型、schema 和基础 Store，不接入
真实 app-server 调度。

## 1. 关系

```text
Goal
  |
  +-- Task
        |
        +-- Session
              +-- Execution       # 一次执行生命周期
              +-- Turn            # interactive backend 的一次交互
                    +-- Execution Event  # future provider event projection
```

Goal/Phase 的现有规划层仍然保留；上图省略 Phase 以突出本阶段新增的
Session 层。`Execution` 和 `Turn` 的关系按 backend 定义：

```text
interactive:  Task -> Session -> Turn -> Execution
batch:        Task -> Execution          (当前 CLI 链路不自动创建 Session)
```

本阶段只保存这些关系需要的 Session 字段；interactive 的 `thread/start`、
`turn/start` 和事件关联属于后续 Phase。

## 2. 五个 LRM 对象的语义

### Goal

用户希望 LRM 完成的完整意图。Goal 可以包含多个 Phase 和 Task；Goal 的
拥有者仍是 `GoalOrchestrationService`。

Goal 不保存 provider Thread 的完整 transcript，不保存 app-server 原始事件，
也不以 Session 的状态替代 Goal 的 review/iteration 状态。

### Task

Goal 中可独立执行和验收的工作单元。Task 是 Session 的业务 owner：一个
Session 创建时只绑定一个 `workspace_id` 和一个 Task，其他 Task 不能因为
“同一个 workspace”而自动复用这个 Session。

Task 仍然使用当前 `TaskContext` 的 identity 和兼容字段。尤其是
`TaskContext.conversation_id` 仍是 compatibility metadata，不是 Session
或 review delivery 的权威来源。

### Session

长期 Agent context 的持久化边界。当前模型包含：

- `session_id`、`goal_id`、`task_id`；
- `backend_type`：`cli` 或 `codex_app_server`；
- `status`：`created`、`starting`、`active`、`waiting_input`、`completed`、
  `failed` 或 `terminated`；
- `workspace`：canonical workspace path 或 registered workspace reference；
- `thread_id`：CLI 可以省略，app-server 保存 provider Codex Thread ID；
- `model` 和 `reasoning_effort`：当前 Session 默认配置，可以在 provider
  selection 确认后写入；
- `created_at` 和 `updated_at`。

Session 使用现有 application-local `.task` state root 持久化，文件位置为
`.task/sessions/<session_id>.json`。`thread_id` 是 provider Thread 的不透明
外部 identity；provider `sessionId`、connection id、进程 id、浏览器 tab id
和窗口是否可见都不能单独替代它。

### Execution

一次 LRM 执行单元：一条 instruction、一次 agent 行为、一次修改过程和一次
最终回复。`execution_id` 是 LRM 的稳定 identity，不因 provider 重连而变化。

现有 `ExecutionContext` API 和 lookup key 保持不变。本阶段不添加 `thread_id`
或 `session_id` 到 Execution record；未来如需关联，只能通过明确的 Session/
Turn reference 完成，不能把 Thread ID 直接塞入 Execution。

### Turn

Codex app-server 的 provider-level unit。未来 Turn id 由 app-server 返回，
不能由 LRM 通过时间、消息文本或“最近一个 Turn”猜出。Turn 不是 Goal、Task，
也不是 LRM 的替代 Execution record。本阶段不创建或调度 Turn。

CLI 没有对应的 provider Turn；CLI process lifetime 就是 Execution lifetime。

## 3. Cardinality 与 identity 规则

| 关系 | 冻结规则 |
| --- | --- |
| Goal → Phase | 一个 Goal 可有一个或多个 Phase；沿用现有 Goal schema |
| Phase → Task | 一个 Phase 可有一个或多个 Task；沿用现有 checkpoint |
| Task → Session | 一个 Task 至多一个 active Session binding；历史 Session 可保留但不能自动切换 |
| Session → Execution | 一个 Session 可有多个按顺序创建的 Execution |
| Execution → Turn | future interactive 为 1:1；CLI 为 0:0 |
| Execution → process | batch 通常为 1；interactive 不以 process id 作为 Session identity |
| Session 跨 Task | 默认禁止；必须有显式、经过授权且另行定义的 rebind/fork contract |

所有 cross-record identity 比较均要求精确相等：

```text
Session.goal_id      == owning Goal.goal_id
Session.task_id      == owning Task.task_id
Session.workspace    == canonical workspace reference
Execution.workspace_id == Task.workspace_id
Execution.task_id      == Task.task_id
```

未来建立 Execution/Turn 关联时，必须通过已持久化的 `session_id` 和 provider
返回的 Turn reference 完成；不得把 `thread_id` 复制到 Execution。缺失、重复、
workspace/task 不匹配或 provider reference 无法证明归属时，必须停止并报告
failure/needs-user-action；不得选择“最接近”的 Session。

## 4. 与现有 Core record 的兼容关系

现有仓库的 Core identity 仍然是：

```text
Workspace -> TaskContext -> ExecutionContext -> ReviewRequest
```

Session 是 Execution 的 interactive control-plane association，不取代这条
review chain。ReviewRequest、ReviewResult、ConversationRouting 和 Auto
Iteration 继续使用现有 identity，不读取 provider raw events。

现有 `ExecutionContext.status` 只有：

```text
running | passed | failed
```

本阶段不改这个兼容字段，也不向 `ExecutionContext` 增加 Session 字段。未来
Execution runtime 可以使用独立的 lifecycle state 表达：

```text
creating_session | thread_ready | running | waiting_user | completed | failed
```

兼容不变量：

```text
non-terminal lifecycle state -> ExecutionContext.status = running
completed                -> ExecutionContext.status = passed
failed                   -> ExecutionContext.status = failed
```

旧的 Execution record 没有 lifecycle state 时，可以由现有 status 推导；
不能因为 app-server 增加等待状态就把 `waiting_input` 写进现有 status enum。

Goal/Task 的现有状态也不改：Goal 继续使用 `pending/running/completed/
failed/human_required`，Task 继续使用现有 `TaskStatus`。Session 的
`waiting_input` 只属于 Session lifecycle，不是新的 Goal 或 Execution status。

## 5. Session 生命周期

Session Store 支持以下基础状态：

```text
created
  ↓
starting
  ↓
active
  ↓
waiting_input
  ↓
completed
```

`failed` 和 `terminated` 是异常终态。后续 interactive backend 可以在收到
用户输入后从 `waiting_input` 回到 `active`，但本阶段只定义状态和保存能力，
不实现该调度。Store 校验状态值，不调用 provider，也不替现有 Execution API
推断状态。

## 6. Submission 与 runtime 分层

### Submission 与 runtime 分层

用户要求的统一视图是：

```text
accepted
  -> waiting_identity
  -> creating_session
  -> thread_ready
  -> running
  -> waiting_user <-> running
  -> completed | failed
```

但这些值不放入一个现有 record 的单一 enum：

| 状态 | 所属层 | 说明 |
| --- | --- | --- |
| `accepted` | `submit_goal` receipt | LRM 已 durable save 请求，不代表已创建 Goal/Session |
| `waiting_identity` | `PendingGoalSubmission` | 等待 exact canonical conversation evidence；当前 `pending_identity` 对应此语义 |
| `creating_session` | Execution runtime | Backend 正在启动/连接环境或调用 `thread/start` |
| `thread_ready` | Session/Execution runtime | 已取得 provider Thread identity，可发送 Turn |
| `running` | Execution runtime | Turn/process 正在执行 |
| `waiting_user` | Execution runtime | provider 明确请求 user input 或 approval；不是完成 |
| `completed` | Execution runtime | provider 明确报告本次 Execution 成功结束 |
| `failed` | Execution runtime | provider 或基础设施明确失败；不自动猜测成功 |

### Backend-specific path

```text
CLI:
accepted -> running -> completed | failed

App-server:
accepted -> waiting_identity? -> creating_session -> thread_ready
         -> running <-> waiting_user -> completed | failed
```

CLI 的 `waiting_identity` 只在 Connector pending submission 层可能出现，
不是 CLI process 的 provider state。CLI 也不生成假 Thread id。

### Stop、resume 和 lost ACK

- `stop` 是控制请求；只有 provider 的终止事件/退出证据确认后，Execution 才能进入 terminal state。
- app-server reconnect 后，必须用持久化的 `thread_id` 调用 provider resume/read 能力；不得重新 `thread/start` 造成第二个 Thread。
- `turn/start` 的 response 丢失时，必须先用 provider history 或已持久化 turn reference 证明是否已创建；没有证据时不得盲目重新发送同一 instruction。
- 无法判定 provider outcome 时，Execution 不得标为 `completed`；保留 failure/indeterminate 证据并把后续动作交给用户或已定义的 recovery。
- 同一个 `(workspace_id, task_id, execution_id)` 的重复 start 必须幂等返回已证明的运行对象，或 fail closed；不能产生第二个 process/Turn。

## 7. Model/effort 与 Session

model 和 effort 是 Session/Turn 的 provider configuration，不是 Goal 的业务
语义，也不由 LRM 常量默认。`reasoning_effort` 保存 Session 默认设置，未来
映射到 app-server 的 `turn/start.effort`，不是 Thread 创建参数。本阶段不请求
`model/list`，也不自动选择第一个 model。

Session 只能保存已确认的 selection。若恢复后该 model/effort 已不在新 catalog：

1. 保留原 Session 和历史 Execution；
2. 不自动替换成第一个模型或另一个 effort；
3. 阻止新的 Turn，并要求重新选择有效配置。

## 8. Session Store 与 Phase 2 边界

`SessionStore` 使用现有 application-local filesystem state，不引入数据库：

```text
createSession(input)                  -> Promise<Session>
getSession(session_id)                -> Promise<Session | null>
updateSession(session_id, patch)      -> Promise<Session>
listSessions()                        -> Promise<Session[]>
```

记录保存在 `.task/sessions/<session_id>.json`。创建时缺省生成 `session_id`、
写入 `status = created` 和同一组创建/更新时间；更新只改变可变字段并刷新
`updated_at`；列表按 `session_id` 排序。所有读写均经过现有 Zod 风格的严格
schema 校验。

本阶段的非目标：

- 不把 Session metadata 加到当前 `submit_goal` receipt。
- 不改变 Goal API、Task API、现有 Execution API、MCP tool interface 或 Extension delivery。
- 不把一个 Goal 的 Session 自动共享给另一个 Goal，也不把 ChatGPT conversation
  id、浏览器 tab 或用户可见窗口当作 Codex Thread id。
- 不调用 `thread/start`、`turn/start`，不接入 interactive execution、Desktop UI
  或真实 app-server 调度。
