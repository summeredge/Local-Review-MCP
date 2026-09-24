# Interactive Backend 架构约束（Phase 4）

状态：Phase 4 `submit_goal` interactive 路由已接入 Event Adapter、Session 状态
同步、Event Store 和只读 Status Query；approval、user input、pause/resume 仍未实现。

本阶段在 Phase 2 Session 类型、schema 和 filesystem Store 的基础上增加
interactive backend 路由；默认 batch 执行行为保持不变。

## 1. 当前基线与目标结构

当前仓库的真实调用链是：

```text
MCP submit_goal
  -> PendingGoalSubmissionService       # 公开工具的 durable acceptance / identity gate
  -> GoalSubmissionService              # 组装 Goal plan
  -> GoalOrchestrationService           # Goal / Phase / Task
  -> ControlledActuationService         # authorization / reservation
  -> ExecutionService                   # execution_mode 路由
  -> ExecutionBackendRouter
       -> CliExecutionBackend            # batch
            -> CodexExecutionAdapter
                 -> codex exec --json -
       -> CodexAppServerBackend           # interactive
            -> SessionStore
            -> thread/start -> turn/start
            -> CodexEventAdapter -> LRM EventStore
            -> Session / Execution status projection
```

Session record 的持久化路径是：

```text
SessionStore
  -> .task/sessions/<session_id>.json
```

batch 不创建 Session；interactive 在 Task 已创建并通过 ControlledActuation
授权后创建 Session，并把 provider Thread ID 持久化到该 Session。

CLI 入口直接调用 `GoalSubmissionService`，但仍经过同一套 Goal、Task、
Actuation 和 Execution 持久化逻辑。`ExecutionContextService` 目前只是
Execution record 的读写服务，不是执行器，也不应被改名或改造成 Backend。

冻结后的逻辑结构是：

```text
submit_goal
    |
    v
ExecutionService                    # LRM Control Plane application service
    |
    v
ExecutionBackend                    # provider-neutral port
    |
    +-- CliBackend
    |
    +-- CodexAppServerBackend
```

在现有系统中，`ControlledActuationService` 仍位于
`ExecutionService` 之前，负责授权、一次性 reservation 和重复调用保护；
它不能被绕过。目标路径因此完整表示为：

```text
submit_goal -> Goal / Task -> ControlledActuationService
             -> ExecutionService -> ExecutionBackend
```

## 2. 职责冻结

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| `GoalSubmissionService` | 校验兼容的 Goal 请求、创建/启动 Goal | 解析 provider 协议、选择 Thread、读取模型目录 |
| `GoalOrchestrationService` | Goal、Phase、Task、review/iteration 关系及状态 | 直接 spawn、JSON-RPC、UI 或 provider 事件 |
| `ControlledActuationService` | permission gate、authorization、reservation、重复调用保护 | 解释 CLI 或 app-server 的事件 |
| `ExecutionService` | 选择 Backend、绑定 LRM identity、持久化生命周期、协调规范化事件、恢复和幂等 | 直接依赖某个 provider 的 wire payload |
| `ExecutionBackend` | 启动环境、创建/恢复 Session、发送任务、读取并适配事件、停止/恢复 | 创建 Goal/Task、决定 LRM 权限、写入 LRM record |
| `ExecutionContextService` | 校验并持久化 Execution record | 启动进程、连接 app-server、推断状态 |
| LRM Core | Goal、Task、权限、Workspace、用户请求、状态持久化 | 把 provider 原始事件暴露给 MCP |

Backend 只接收已通过 Workspace Registry 和 permission gate 的请求。工作目录
必须来自 registry 的 canonical root；调用方提供的任意路径不能成为 Backend
权限来源。

本冻结吸收的本地参考结论：C2C 将长期 conversation checkpoint 与单次
execution record 分开；COS 的 model catalog 采用动态 request/observe 状态，
而不是内置一组模型名。LRM 只复用这些边界原则，不引入参考项目的 session、
browser 或 agent 子系统。

## 3. Backend 最小能力

这是协议级能力，不是本阶段要新增的 TypeScript 接口：

| 能力 | 语义 |
| --- | --- |
| `startEnvironment` | 启动或连接执行环境；可复用长期 app-server 进程 |
| `createSession` | 创建 provider context，并返回不透明的 Session reference |
| `resumeSession` | 用已持久化的 reference 恢复 context；不能用猜测的 URL、窗口或最近一次运行替代 |
| `startExecution` | 在指定 Task/Session 中发送一次任务，返回 provider execution reference |
| `events` | 返回有序 provider 事件；由 `ExecutionService` 转换为 LRM 事件 |
| `stopExecution` | 请求停止当前 Execution；停止确认不是成功完成 |
| `listModels` | App-server 的 capability discovery；返回当前可用模型和 reasoning efforts |

`CliBackend` 可以把 `startEnvironment`、`createSession` 和
`startExecution` 合并为一次进程启动，但语义上仍返回同一套 neutral result。
不支持的 `resumeSession` 必须明确返回 unsupported，不能伪造一个长期 Session。

`CodexAppServerBackend` 必须把连接、Thread、Turn 三种对象分开，并把 provider
event 交给 `CodexEventAdapter`：

```text
app-server process / JSON-RPC connection  !=  LRM Session
provider thread                          ==  LRM interactive Session reference
provider turn                            ==  one interactive Execution unit
```

当前 Phase 3 的映射关系：

```text
LRM Session
    |
    +-- Codex app-server Thread
          |
          +-- Turn
                |
                +-- Execution Event
```

`Session` 是长期上下文，`Turn` 是一次 interactive 交互，`Execution Event`
是该次交互的事件投影；Phase 4 创建一个 Thread 和一个首 Turn，将 event 转换
后写入 EventStore，并同步基础 Session/Execution 生命周期。

provider 返回的 `sessionId`、transport connection id 或 UI/window reference
都是 provider metadata；只有经明确绑定的 provider `thread.id` 才能作为
LRM Session 的外部 identity。窗口是否可见不能证明 Session 所属关系。

## 4. CLI 与 App-server 的生命周期

| 维度 | `CliBackend` | `CodexAppServerBackend` |
| --- | --- | --- |
| 环境 | 一个 `codex exec --json -` 进程 | 长期 app-server 进程/连接，可承载多个 Thread |
| LRM Session | 当前 CLI 链路不自动创建；显式保存时 `thread_id` 可为空 | 持久 Session，绑定一个 provider Thread |
| 一次执行 | 进程 lifetime 是一个 Execution | 一个 `turn/start` 是一个 Execution |
| 输入 | 通过 stdin 发送完整 instruction | 通过 `turn/start` 发送 input |
| 事件 | CLI JSONL stdout/stderr，经现有 completion observer 解析 | JSON-RPC response/notification，经 Backend 转换 |
| 停止 | 终止进程并观察退出 | `turn/interrupt` 或当前版本对应的停止方法 |
| 恢复 | 不支持无证据恢复；沿用 process identity / exit evidence | 重连后 `thread/resume`，再按 provider history/event cursor 恢复 |
| 用户等待 | 当前 batch contract 不进入交互等待 | approval/user-input request 映射为 `waiting_user` |

因此不能把 `Execution` 改成 Thread：CLI 的进程结束即结束一次运行，而
app-server 的 Thread 仍然保存上下文，后续可拥有多个 Turn/Execution。

## 5. `submit_goal` 兼容性冻结

以下是 Phase 3 interactive backend 的兼容边界。当前 `submit_goal` receipt
和 CLI execution 行为保持不变。

现有公开工具 contract 继续保持：

```json
{
  "workspace_id": "optional registered workspace id",
  "correlation_key": "strict UUID v4",
  "title": "string",
  "goal": "string",
  "requirements": ["string"],
  "acceptance_criteria": ["string"],
  "max_iterations": 2,
  "execution_mode": "batch" | "interactive",
  "model": "optional provider model id",
  "reasoning_effort": "optional provider effort id"
}
```

返回值仍然是 durable acceptance receipt：

```json
{
  "accepted": true,
  "correlation_key": "strict UUID v4",
  "accepted_at": "RFC3339 timestamp",
  "expires_at": "RFC3339 timestamp"
}
```

不得因为 Interactive Backend 已存在而提前返回 `goal_id`、`task_id`、
`execution_id` 或 provider Thread id；公开工具返回时 canonical conversation
可能尚未建立。

当前 additive API 字段是：

```json
{
  "execution_mode": "batch" | "interactive"
}
```

规则：

1. 字段可省略，默认值为 `"batch"`。
2. 省略该字段的历史调用继续走 `CliBackend`，行为等价于当前
   `codex exec --json -`。
3. `"interactive"` 才允许选择 `CodexAppServerBackend`。
4. 字段从 MCP input 贯穿 pending submission、GoalSubmission、Goal checkpoint
   和 ExecutionService；不能只改入口 schema。
5. `execution_mode` 不是 `session_id`、model name 或 reasoning effort；这些
   provider/runtime 细节不加入本阶段的 `submit_goal` 必填输入。
6. `correlation_key` 仍是一次调用的直接关联 key。不得使用 assistant 文本、
   result content、`metadata.request_id` 或 provider Thread id 替代它。

CLI 现有直接调用和 Connector 现有异步 identity gate 都必须保留。添加字段
不能改变 `accepted` 的含义：它只表示请求已被 LRM durable save。

## 6. 模型配置来源冻结

模型名和 reasoning effort 不得在 LRM 中硬编码，也不得以静态常量替代
provider catalog。

Interactive Backend 启动/初始化时必须：

1. 完成当前 app-server 版本要求的 `initialize` handshake；
2. 调用 `model/list`，按 `nextCursor` 继续读取分页；
3. 校验 provider response，再投影给 UI；
4. 只允许 UI 或明确 provider default 产生实际 selection；不能静默选列表第一个；
5. catalog 不可用、model 不存在或 effort 不受支持时停止创建/发送，返回
   可诊断的失败，不降级到写死的模型名。

LRM 给 UI 的最小投影为：

```json
{
  "model": "provider selection id",
  "label": "provider display name",
  "efforts": ["provider reasoning effort ids"]
}
```

provider 当前 schema 可能同时提供 `id`、`model`、`displayName`、
`supportedReasoningEfforts` 和 `defaultReasoningEffort`；Backend 负责版本化
解析，LRM 只消费上面的最小投影。

模型目录不是 `submit_goal` 的返回值，也不是 MCP Data Plane 的任意执行接口。
后续 UI/control-plane 读接口另行定义权限和范围。

## 7. 协议版本策略

本地验证快照（2026-09-15）：`codex-cli 0.151.0`，安装版生成 schema 包含
`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`、`model/list`
以及相应的 `thread/started`、`turn/started`、`turn/completed`、
`item/*` notifications。

该快照不是永久兼容承诺。实现阶段必须以实际启动的 Codex executable 生成的
TypeScript/JSON Schema 为准，例如：

```text
codex app-server generate-json-schema --out <temporary-directory>
```

Schema、handshake 或必需方法不匹配时，Backend 必须 fail closed；不得通过
字段猜测、未识别事件或 provider-specific fallback 继续执行。

## 8. Phase 4 实现内容与非目标

本阶段已经实现：

- `submit_goal.execution_mode`，省略时默认 `batch`；
- `ExecutionService`、`ExecutionBackendRouter`、`CliExecutionBackend` 和
  `CodexAppServerBackend`；
- interactive 的 `model/list` capability discovery、provider default/model
  选择、`thread/start` 和 `turn/start`；
- interactive Session 的 `created -> starting -> active -> running_turn ->
  completed|failed` 同步，以及 provider Thread ID 持久化；
- `.task/sessions/<session_id>.json` 的 Session 绑定。
- app-server provider event 到 LRM event 的转换和
  `.task/events/<session_id>.json` 文件事件存储；
- `get_session_status`、`get_execution_status` 和 `list_session_events` 只读查询。

人工真实 smoke 入口为 `npm run test:interactive-goal`。为避免测试新建
Codex Thread 时使用其他模型，运行前必须设置：

```powershell
$env:CODEX_INTERACTIVE_MODEL = "gpt-5.6-luna"
$env:CODEX_INTERACTIVE_EFFORT = "max"
npm run test:interactive-goal
```

Backend 本身仍通过 `model/list` 校验实际 catalog，不硬编码模型选择。

本阶段非目标：

- 不修改 App-server client 的现有协议代码，不把原始 JSON-RPC 事件传给 MCP caller。
- 不迁移既有 `.task` record，不改 `ExecutionContextService` 的现有字段含义，
  不把 `thread_id` 直接塞入 Execution。
- 不实现 Launcher UI、approval、user input、pause/resume 或多 Agent。
- 不增加自动重试、自动选模、隐式 Thread 复用或浏览器窗口推断。
- 不把 `ReviewRequest`、`ConversationRouting` 或现有 Auto Iteration 逻辑搬进 Backend。

状态和事件的具体冻结规则分别见：

- [`session-model.md`](session-model.md)
- [`event-model.md`](event-model.md)

## 9. Phase 4 Event Flow 与 Status Query

```text
Codex app-server
  -> turn/started, item/agentMessage/delta, item/completed, turn/completed
  -> CodexEventAdapter
  -> LRM Event
  -> EventStore + Session/Execution status
  -> StatusQueryService
```

`CodexEventAdapter` 的输出只使用 LRM 字段：`event_type`、`session_id`、
`execution_id`、`timestamp`、已验证的 `thread_id`/`turn_id`/`item_id` 和受约束
的 `payload`。`turn/started` 使 Session 进入 `running_turn`；成功的
`turn/completed` 写入 `turn_completed` 并把旧 `ExecutionContext.status` 写为
`passed`；失败事件写入 `execution_failed` 并写为 `failed`。事件存储通过
`appendEvent()` 和 `listEvents(session_id)` 提供有序的 JSON 文件记录，不引入
数据库。

只读接口返回当前 Session 的 Thread、model、reasoning effort 和
`current_execution`，以及当前 Execution 的状态、Session/Turn 关联和已记录的
agent output。它们不改变 `submit_goal` receipt，也不改变默认 `execution_mode=batch`
或 CLI `codex exec --json -` 路径。

## 10. P5.4.1 Desktop codex_app interactive route

The production interactive route is now the Desktop codex_app backend:

```text
submit_goal(execution_mode="interactive")
        -> Goal / Task / ControlledActuation
        -> ExecutionService (ExecutionBackendRouter)
        -> CapabilityNegotiator (Desktop first)
        -> DesktopCapabilityProvider
        -> DesktopThreadCoordinator (DesktopThreadBindingStore)
        -> DesktopCodexThreadCommands -> create_thread
        -> DesktopCompletionObserver
        -> Session / Execution terminal projection
        -> EventStore (turn_completed)
        -> terminal listener -> ExecutionRoutingService

On capability failure, the same negotiator waits for a recheck/standalone action or
starts `StandaloneCapabilityProvider` with the existing private app-server.
```

`CodexAppServerBackend` is retained but is no longer selected for the normal production
interactive route. P5.9 keeps Desktop as the first provider and negotiates the existing private
app-server backend as a bounded, user-selectable or automatic fallback.

### Backend identity

`SESSION_BACKEND_TYPES` adds `desktop_codex_app` alongside `cli` and `codex_app_server`.
Desktop Sessions persist `backend_type = "desktop_codex_app"` and `thread_id = targetThreadId`,
which is the Desktop-owned Codex thread, never the Desktop executor conversation.

### Executor and target stay separate

`executorThreadId` is the Desktop `currentConversationId` captured once per Execution and passed
only through the `openai/threadId` tool metadata. It is never written to Session,
DesktopThreadBinding, Execution, or any other durable record. The durable target identity is
`DesktopThreadBinding.target_thread_id`, mirrored into `Session.thread_id`, and the two must
differ.

### Process identity

Desktop executions own no LRM OS process, so `ExecutionStartResult.process_id` and
`controlledActuationStartResultSchema.process_id` are now optional. CLI and private app-server
executions still always provide one. `ControlledActuationService` accepts a missing `process_id`
only when the complete durable Desktop evidence is present: a matching goal/task Session with a
non-empty `thread_id` whose `desktop_codex_app` DesktopThreadBinding matches the same
workspace/task/session and target thread. Anything else still fails closed as an ambiguous launch
state.

### First-turn completion

`create_thread` already carries the prompt, so it dispatches the first turn. For a target the
current operation just created, the baseline is exactly
`{ targetThreadId, hostId, turnIds: [] }` because no earlier turn can exist. The
`DesktopCompletionObserver` then requires exactly one first-seen turn: zero is pending, one locks
the candidate, and more than one is `ambiguous_new_turn` and fails closed. Completion evidence is
the observer alone; no marker text, thread title, message matching, or fixed sleep is used.

### Status queries

`get_session_status` and `get_execution_status` accept and return
`backend_type = "desktop_codex_app"` with `thread_id = targetThreadId` and the observed Desktop
`turn_id`. `agent_output` remains empty in this phase because Desktop agent message deltas are
not projected yet.

### Desktop tools pipe resolution

`DesktopToolsPipeResolver` is the single place that turns Desktop evidence into a pipe path. The
resolution order is fixed and exhaustive:

1. a verified `DesktopToolsPipeHandoff` capability, already bound to the current Desktop owner;
2. `CODEX_APP_TOOLS_PIPE_PATH` **already inherited by this LRM process**, trusted only while
   the existing Desktop connection constraint (`state.connected`) holds;
3. otherwise fail closed with `desktop_tools_pipe_unavailable`.

Pipe enumeration and pipe name guessing are never used, and the handoff lifecycle, owner binding,
and invalidation rules are unchanged. A handoff that was accepted and later invalidated (Desktop
disconnect or owner change) is stale evidence rather than missing evidence, so it is never silently
downgraded to the weaker `current_environment` source. `DesktopCodexRuntimeFactory` and the
launcher probe both consume this resolver, and the probe reports the source it actually connected
with as `pipeSource` (`"handoff"` or `"current_environment"`) without echoing the pipe path.

#### The two sources are not equivalent

The two accepted sources have different production meanings and must not be conflated:

- **trusted handoff** is the formal seam by which a standalone production LRM Host obtains a
  Desktop-owned tools pipe capability. It is the only source a Launcher-started LRM Host can be
  expected to acquire on its own, and it is bound to a verified Desktop owner.
- **current_environment** is a compatibility path only. It is valid **only when the current LRM
  process already holds** `CODEX_APP_TOOLS_PIPE_PATH` because some Desktop/Codex-owned execution
  context exported it. It is **not** an automatic Desktop pipe acquisition for a
  LocalReviewLauncher-started LRM Host, and it is never presented or tested as a production
  fallback for that case.

Historical success artifacts that recorded `pipeDiscovery = current_environment` came from a
Desktop/Codex-owned execution context, not from an independent Launcher-started LRM Host. That is
why a Launcher-started Host without an accepted handoff and without an inherited
`CODEX_APP_TOOLS_PIPE_PATH` fails closed: there is no production pipe capability source yet.

#### Interactive preflight observability

Because that failure would otherwise only appear after a Goal already started, the interactive
Desktop route is checked **before** any Goal, Task, or Execution is created. The preflight runs the
same three conditions the Desktop backend enforces, in the same order:

1. Desktop IPC connected;
2. executor conversation identity available;
3. the resolver can currently resolve a pipe.

If the pipe is unavailable, the Goal submission fails closed with the existing
`desktop_tools_pipe_unavailable` reason and no Session, Task, or Execution is created. The result
is durable and queryable rather than a binary `failed`:

- `goalPreflightResultSchema.desktop` carries `{ ready, reason, pipe_source }`, and
  `failure_stage = "desktop"` identifies the blocked stage;
- the reason is hashed into the identity trace with `failure_stage = "desktop"` on
  `goal_start_failed`, and the preflight result is persisted on the pending Goal submission;
- the read-only loopback endpoint `/launcher/desktop-interactive` reports
  `{ ready, reason, pipeSource, pipeState }` for the current evidence without ever returning a pipe path.

Current live status is **P5.4.1 BLOCKED_DESKTOP_PIPE_CAPABILITY**: there is no real production pipe
capability source for an independently started LRM Host yet, so P5.4.1 is not claimed as PASS.
