# Goal / Task / Session / Execution / Turn 模型（Phase 0）

状态：冻结设计，文档阶段。Session 是为 Interactive Backend 保留的长期
Control Plane 对象；当前仓库尚未实现 Session record。

## 1. 关系

```text
Goal
  |
  +-- Phase
        |
        +-- Task
              +-- Session              # interactive only; provider context
              |     +-- Execution       # LRM 一次运行/一次行为
              |           <-> Turn      # app-server provider unit
              |
              +-- Execution             # batch only; no Session/Turn
```

更准确地说，`Execution` 和 `Turn` 不是两个独立的 LRM 工作单元：

```text
interactive:  Task -> Session -> Execution <-> provider Turn
batch:        Task -> Execution          (没有持久 Session，也没有 Turn)
```

一个 interactive `Execution` 对应一个 `turn/start` 请求和一个 provider
Turn。Turn 在等待用户输入后可以继续，直到该 Turn 完成或失败；完成后同一
Session 的下一次用户任务必须创建新的 Execution/Turn。

## 2. 四个 LRM 对象的语义

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

长期 provider context，interactive 模式的持久化边界。Session 至少表达：

- LRM `session_id`；
- `workspace_id`、owner `task_id`；
- `backend_kind = codex_app_server`；
- provider `thread_id`（不透明、精确匹配）；
- 创建时的 canonical workspace/cwd；
- 最近一次已确认的 model/effort selection；
- 创建、恢复和最后观察时间；
- 可选的 UI/window metadata。

provider `thread.id` 是外部关联的主要 identity。provider 的 `sessionId`、
app-server connection id、进程 id、浏览器 tab id 和窗口是否可见都不能单独
证明 LRM Session identity。

Session 必须持久化在 LRM application-local state（现有 `.task` state root）
中，并按 `workspace_id` 隔离；不能写入用户 workspace、`.review/`
`execution_output.json` 或 provider 的任意路径。

### Execution

一次 LRM 执行单元：一条 instruction、一次 agent 行为、一次修改过程和一次
最终回复。`execution_id` 是 LRM 的稳定 identity，不因 provider 重连而变化。

Execution 关联：

```text
execution_id
task_id
workspace_id
session_id?          # interactive 时存在
provider_turn_id?    # interactive start 成功后存在
process_id?          # CLI 时存在
execution_mode
```

`session_id` 和 `provider_turn_id` 是未来的 additive metadata；它们不能改变
当前 `(workspace_id, task_id, execution_id)` 的 Execution lookup key。

### Turn

Codex app-server 的 provider-level unit。Turn id 由 app-server 返回，不能由
LRM 通过时间、消息文本或“最近一个 Turn”猜出。Turn 不是 Goal、Task，也不
是 LRM 的替代 Execution record。

CLI 没有对应的 provider Turn；CLI process lifetime 就是 Execution lifetime。

## 3. Cardinality 与 identity 规则

| 关系 | 冻结规则 |
| --- | --- |
| Goal → Phase | 一个 Goal 可有一个或多个 Phase；沿用现有 Goal schema |
| Phase → Task | 一个 Phase 可有一个或多个 Task；沿用现有 checkpoint |
| Task → Session | 一个 Task 至多一个 active Session binding；历史 Session 可保留但不能自动切换 |
| Session → Execution | 一个 Session 可有多个按顺序创建的 Execution |
| Execution → Turn | interactive 为 1:1；batch 为 0:0 |
| Execution → process | batch 通常为 1；interactive 不以 process id 作为 Session identity |
| Session 跨 Task | 默认禁止；必须有显式、经过授权且另行定义的 rebind/fork contract |

所有 cross-record identity 比较均要求精确相等：

```text
Session.workspace_id == Task.workspace_id
Session.task_id      == Task.task_id
Execution.workspace_id == Task.workspace_id
Execution.task_id      == Task.task_id
Execution.session_id   == Session.session_id       # 存在时
Execution.provider_turn_id belongs to Session.thread_id
```

缺失、重复、workspace/task 不匹配或 provider reference 无法证明归属时，
必须停止并报告 failure/needs-user-action；不得选择“最接近”的 Session。

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

Phase 0 不改这个兼容字段。目标生命周期使用 additive 的
`execution_lifecycle_state`（具体 schema 在实现阶段另行落地）表达：

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
不能因为 app-server 增加等待状态就把 `waiting_user` 写进现有 status enum。

Goal/Task 的现有状态也不改：Goal 继续使用 `pending/running/completed/
failed/human_required`，Task 继续使用现有 `TaskStatus`。`waiting_user` 是
Execution runtime state，不是一个新的 Goal terminal state。

## 5. 冻结生命周期

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

## 6. Model/effort 与 Session

model 和 effort 是 Session/Turn 的 provider configuration，不是 Goal 的业务
语义，也不由 LRM 常量默认。Interactive Backend 每次建立连接先刷新
`model/list`，UI 选择有效组合后才写入 Session/Turn request。

Session 只能保存已确认的 selection。若恢复后该 model/effort 已不在新 catalog：

1. 保留原 Session 和历史 Execution；
2. 不自动替换成第一个模型或另一个 effort；
3. 阻止新的 Turn，并要求重新选择有效配置。

## 7. Phase 0 非目标

- 不把 Session metadata 加到当前 `submit_goal` receipt。
- 不把一个 Goal 的 Session 自动共享给另一个 Goal。
- 不把 ChatGPT conversation id、浏览器 tab 或用户可见窗口当作 Codex Thread id 的替代品。
- 不在本阶段决定 Session UI 的具体窗口、路由或展示 API。
- 不把 provider `sessionId` 与 LRM Session 混为同一字段。
