# P5.2 Legacy Architecture Audit

审查日期：2026-09-19
审查范围：当前 `Local-Review-MCP` 工作树、源码、测试、Launcher、docs，以及当前分支可见的历史提交。
本轮结论：只读审查；没有修改源码、测试、配置或现有文档。本文件是唯一新增文件。

`P5.1` 的连续性证明与本仓库当前的生产 completion/recovery 仍是两件事：前者证明
Desktop-owned thread 可以完成 `create_thread -> send_message_to_thread` 的第二轮，后者
还没有进入 LRM 的 `Session / Execution / Event / terminal listener` 生命周期。因此旧
`CodexAppServerBackend` 继续作为 production fallback。

## 1. Current Production Execution Path

当前正式链路不是 Desktop `codex_app` 路线，而是 `execution_mode: "interactive"`
选择的 LRM 私有 app-server backend：

```text
submit_goal
  -> PendingGoalSubmission.accept()
  -> exact Extension evidence resolves the pending submission
  -> GoalSubmissionService.submitGoal()
  -> GoalOrchestration.createGoal() / startGoal()
  -> GoalOrchestration.driveTask()
  -> ControlledActuation.authorize() / actuate()
  -> ExecutionService
  -> ExecutionBackendRouter
  -> CodexAppServerBackend
  -> one CodexAppServerClient per interactive Session
  -> spawn: codex app-server --listen stdio://
  -> model/list
  -> thread/start
  -> turn/start
  -> provider notifications
  -> CodexEventAdapter
  -> EventStore + SessionStore + ExecutionContextService
  -> terminal listener
  -> ExecutionRoutingService.onExecutionTerminal()
  -> AutoIterationService / Review Request / Review Delivery / Review Result
```

源码证据：

- `submit_goal` 只接受并持久化异步提交，随后由 `PendingGoalSubmission` 在精确
  conversation evidence 到达后调用 `GoalSubmissionService.submitGoal`：
  `src/mcp/server.ts:1082-1119`、`src/control-plane/pending-goal-submission.ts:348-440`。
- Goal 启动后，`GoalOrchestration.driveTask` 先创建授权，再把授权交给
  `ControlledActuation`：`src/control-plane/goal-orchestration.ts:597-745`。
- `ExecutionBackendRouter` 只在解析后的 `execution_mode === "interactive"` 时选择
  `CodexAppServerBackend`；省略字段仍走 batch CLI：
  `src/control-plane/execution-service.ts:24-31,80-91`。
- `createAppContext` 构造的 interactive backend 是
  `CodexAppServerBackend`，并把 `ExecutionService` 的 terminal listener 接到
  `ExecutionRoutingService`：`src/app.ts:124-178`。

### Backend 生命周期事实

`CodexAppServerBackend` 当前确实是“每个 interactive Session 启动一个独立
app-server client”：默认 factory 调用 `CodexAppServerClient.start`，而 client
使用 `spawn(executable, ["app-server", "--listen", "stdio://"])`。

具体生命周期：

| 时机 | 当前行为 |
| --- | --- |
| client 创建后 | 校验 `process_id`，然后以 `session_id -> client` 写入 `clients Map`（`backend.ts:209-216`）。 |
| `listModels` / `thread/start` / `turn/start` 失败 | `startOnce` 的 catch 删除 Map 项、关闭 client，并把已有 Execution/Session 标为失败（`backend.ts:170-227,265-278,392-410`）。 |
| 初始 `turn/start` 返回 `completed` 或 `failed` | 直接调用 `complete` / `fail`，但没有从 Map 删除或关闭 client。 |
| `watch()` 收到 `turn_completed` 或 `execution_failed` | 更新 Execution、Session 并通知 terminal listener；没有关闭 client，也没有从 Map 删除（`backend.ts:311-346`）。 |
| provider 流异常结束 | 调用 `fail`；client 仍留在 Map，除非随后显式 `backend.close()`。 |
| Session 完成/失败 | 只更新持久化状态，不自动关闭 client。 |
| runtime/server 关闭 | `backend.close()` 才统一清空 Map 并关闭所有仍被保留的 client（`backend.ts:161-168`）。 |

因此，`clients Map` 不是 shared daemon registry，而是 LRM 进程内的私有 client
保活表。正常 terminal 之后仍保留 client 是当前事实；本轮不修改。

## 2. Current Proven codex_app Path

已验证的 PoC 路线为：

```text
Desktop currentConversationId
  -> codex_app MCP runtime
  -> tools/call with _meta["openai/threadId"] = executor thread
  -> list_projects({})
  -> exact workspace path / local project resolution
  -> create_thread({ prompt, target: project + local environment })
  -> Desktop-owned thread identity (threadId + optional hostId)
  -> wait_threads or read_thread: first turn completion
  -> send_message_to_thread(existing Desktop-owned thread)
  -> same executor metadata on the call
  -> wait_threads or read_thread: second turn completion
```

当前源码把这条路线保留为 diagnostic，而不是 production backend：

- `codex-app-mcp-diagnostic.ts` 从 Desktop bundle 的 `.mcp.json` 发现
  `codex_app` stdio server，读取 `CODEX_APP_TOOLS_PIPE_PATH`，建立
  `StdioClientTransport`，再执行 `initialize` / `tools/list`。
- `codex-app-effectful-diagnostic.ts:22-29,940-979` 固定
  `_meta["openai/threadId"]`，并把 `list_projects`、`create_thread`、
  `wait_threads`、`read_thread`、`send_message_to_thread` 分成明确 allowlist。
- `resolveDesktopProject` 只接受 path 精确匹配、`projectKind === "local"`、
  `hostId === "local"` 的项目：`codex-app-effectful-diagnostic.ts:401-438`。
- `create_thread` 与 `send_message_to_thread` 的输入 schema 会先经过动态
  `tools/list` contract 检查：`codex-app-effectful-diagnostic.ts:486-605`。
- PoC 在 `create_thread` 后保留目标 `threadId`，并在第二次发送前验证
  `sendArgs.threadId === createdThreadId`：`codex-app-effectful-diagnostic.ts:1197-1265`。

这里必须区分两个 identity：

```text
executorThreadId = 当前 Desktop conversation，用于 MCP request _meta
targetThreadId   = create_thread 返回的 Desktop-owned thread，用于后续 send/wait
```

二者不能互相替代。P5.1 的 `writerConflictObserved === false` 和同一个目标 thread
完成两轮，只能证明 Desktop command path 的 continuity；它没有创建 LRM `Session`、
`Execution`、normalized `Event`，也没有触发 `ExecutionRoutingService` 或
`AutoIteration`。

两条链目前在以下层面尚未汇合：

```text
旧生产链：submit_goal -> Goal -> ControlledActuation -> ExecutionBackendRouter
          -> CodexAppServerBackend -> private app-server -> LRM Session/Execution/Event

新 PoC：   Desktop identity -> standalone MCP Client -> codex_app tools ->
          Desktop-owned thread -> second-turn continuity

缺口：new Desktop thread 的 durable Session binding、Execution terminal evidence、
normalized Event、restart/recovery、terminal callback 和 Review/ITERATE 消费。
```

## 3. Legacy / Shared App-Server Inventory

### Private app-server remnants

| 遗留项 | 当前真实角色 | 状态 |
| --- | --- | --- |
| `src/backends/codex_app_server/backend.ts` | interactive production backend；启动私有 app-server、创建新 provider thread、启动首轮 turn | `KEEP AS FALLBACK` |
| `src/backends/codex_app_server/client.ts` + `protocol.ts` + `models.ts` + `events.ts` | 私有 app-server 的 stdio JSON-RPC client、provider event parser 和 child-process close | `KEEP AS FALLBACK`；新 Adapter 不直接复用其 provider protocol |
| `backend.clients: Map<session_id, client>` | LRM 自己拥有的 per-Session client 生命周期 | `KEEP AS FALLBACK`；不是 shared app-server 能力 |
| `CodexEventAdapter` | 把 app-server notifications 转成当前 LRM normalized events | `MIGRATE`；保留 normalized event 边界，provider 解析需要拆开 |
| `Session.backend_type === "codex_app_server"` | 当前唯一 interactive Session discriminator | `MIGRATE`；它把 provider/backend 名称写死在 storage、query、Desktop association 中 |
| `Session.thread_id` | 当前 app-server provider Thread ID；Desktop Sync 以它做 exact match | `MIGRATE`；字段仍是新路线需要的 durable thread identity，但 ownership/来源不能继续隐含为 private app-server |

`src/backends/codex_app_server/README.md:1-8` 仍描述该模块“独立、不接入
`submit_goal` / Goal / Execution”，但 `src/app.ts:129-136` 已经把它接入正式
interactive router。这是文档 drift，不是可据此删除 backend 的证据。

### Shared app-server experiment

本次对当前工作树、测试、docs 和历史提交的语义搜索没有发现仍在运行的
`shared daemon`、`same app-server`、Desktop/LRM 共用 app-server transport、或
跨进程 writer ownership 实现。当前可见的 writer 相关代码只出现在 P5.1 diagnostic
的错误分类（`active writer` / `open in another app` / `writer conflict`），不是生产
协调器。

结论：旧 shared/private 实验中的 **shared app-server** 部分标记为
`SUPERSEDED BY CODEX_APP ROUTE`。不继续实现，也不在本轮删除；它不是永久架构禁令，
只是当前 P5.2 起点不再依赖该路线。

### `legacy_app_server` fallback 的真实含义

审查结果是 **C：两种含义混合**，但不是 execution backend selector：

1. 实际行为更接近 B：`DesktopSyncManager.fallbackState()` 在 Desktop disconnected
   或没有 `currentConversationId` 时返回 `activeSource: "legacy_app_server"`、空的
   Desktop identity 和 `fallbackReason`；它不调用或切换 `CodexAppServerBackend`。
2. 它又带有旧 backend 命名假设：Desktop association 只筛选
   `backend_type === "codex_app_server"`，`resolveSession()` 也把非该 backend 判为
   `unsupported_session_backend`（`desktop-sync-manager.ts:190-224,245-257`）。
3. Launcher 文档把它称为 “Legacy app-server Fallback”，但同时明确说
   “Codex execution always uses Codex app-server”；这说明它是 status/evidence
   fallback，而非 execution routing（`docs/launcher-dashboard.md:26-57`）。

当前应保留这个兼容值，记录为 naming debt；P5.2 不重命名。

## 4. Desktop Sync Inventory

| 组件/字段 | 当前作用 | 原始路线关系 | 分类与未来复用点 |
| --- | --- | --- | --- |
| `DesktopIPCClient` | 连接 `\\.\\pipe\\codex-ipc`、initialize、重连；不发送 Desktop control command | P4 Desktop thread visibility / private app-server thread observation | `KEEP`；作为只读 identity source，不作为 `codex_app` MCP transport |
| `desktop-ipc-protocol.ts` | 解析 initialize、following broadcast、safe identity fields 和 framing | 观察 Desktop 当前 thread/following | `KEEP`；协议解析与 Adapter command transport 分离 |
| `DesktopIPCObserver` | 把 named-pipe 状态喂给 `DesktopSyncStateStore` | 生产只读 Desktop evidence | `KEEP`；`getState().currentConversationId` 是 future executor context source |
| `DesktopSyncState` | 保存 `currentConversationId`、`followingThreads`、`ownerClientId`、连接和时间 | Desktop 可见性/跟随证据 | `KEEP`；`currentConversationId` 可参与 `_meta["openai/threadId"]`，但必须保留连接、来源和 fail-closed 检查 |
| `DesktopSyncManager` | 读取 Desktop 状态，再用 `backend_type + session.thread_id` 做 exact association 和 fallback | 直接承接 “Desktop thread ↔ LRM private app-server Session” | `MIGRATE`；保留状态兼容输出，未来把 identity mapping 泛化为 provider-neutral binding |
| `currentConversationId` | Desktop 当前可见 conversation/thread identity | 旧观察路线的核心证据 | `KEEP`；未来映射为 `executorThreadId`，不是自动等同于 Adapter 的 `targetThreadId` |
| `following` / `followingThreads` | 是否在 Desktop 跟随某个 thread | visibility signal，不是 execution completion 或 authorization | `KEEP`；Adapter 可记录为 context，但不能作为成功条件 |
| `ownerClientId` | Desktop 事件来源/owner 的结构化字段 | 旧 IPC observation | `KEEP`；仅 safe diagnostic/context，当前没有足够证据把它当授权 token |
| `desktop-thread-visibility-diagnostic.ts` | sanitized raw IPC timeline、target match、重连观察；绝不发送 turn/steer/follow | P4 observation-only PoC | `REMOVE LATER`；当前继续保留为 diagnostic，不能迁入 production Adapter |
| `/launcher/desktop-sync` + Launcher parser | 认证 loopback status、兼容 fallback 和 UI 显示 | status compatibility surface | `KEEP AS FALLBACK`；P5.2 不改变字段/枚举 |

当前接线位置是 `startApp()` 创建 `DesktopIPCObserver` 和
`DesktopSyncManager`，然后只把 Manager 传给 HTTP status endpoint：
`src/app.ts:217-246`、`src/mcp/http.ts:221-267`。它没有进入
`ExecutionBackendRouter`，也没有发送 `codex_app` tools/call。

## 5. Session / Execution / Event Coupling

### Backend-neutral 基础设施

| 基础设施 | 审查结论 |
| --- | --- |
| `Goal` / `Task` / `ReviewRequest` / `ReviewResult` / `ConversationRouting` | `backend-neutral`。它们按 workspace/task/execution/conversation 做 durable identity，不读取 provider raw event。 |
| `SessionStore` 的文件读写、状态持久化 | `backend-neutral` 的 storage 机制，可复用。 |
| `ExecutionContextService` 的 workspace/task/execution 文件存储、`running/passed/failed` 投影 | `backend-neutral` 的 durable record，可复用；但 launch result 的 `process_id` contract 仍是迁移边界。 |
| `EventStore` 的有序 append/list、session 目录隔离 | `backend-neutral` persistence，可复用。 |
| `ExecutionRoutingService.onExecutionTerminal` | `backend-neutral` terminal hook；它只把 terminal Execution 转给 AutoIteration，可复用。 |
| `AutoIterationService` 的 review delivery、verdict、max iteration、terminal decision | 业务流程基本 `backend-neutral`；可继续消费新 Adapter 投影出的 terminal Execution。 |
| Review delivery/completion 和 Launcher read-only query 的 identity checks | `backend-neutral`，不应复制到 Adapter 内部。 |

### 当前 codex_app_server coupling

| 组件/字段 | coupling | P5.2 影响 |
| --- | --- | --- |
| `Session.backend_type` | `SESSION_BACKEND_TYPES` 只有 `cli` 和 `codex_app_server`；Status Query、Desktop Sync、Launcher 都按该枚举筛选 | `MIGRATE`。本轮不改 enum；新 Adapter 是否使用新的 backend discriminator 或 provider-neutral type，要在生命周期证据之后决定。 |
| `Session.thread_id` | 注释和 docs 明确写成 app-server provider Thread ID；当前 `Session` 是一个 Task 的长期 interactive context | `MIGRATE`。字段可复用，但必须保存 Desktop-owned 来源和可恢复绑定，不能把 `currentConversationId` 的观察值直接猜成 Session。 |
| `ExecutionContext.process_id` | record 字段可选，但 `ExecutionStartResult`、`controlledActuationStartResultSchema` 要求正数；旧 interactive backend 把 app-server child PID 持久化 | `MIGRATE` boundary。Desktop MCP child PID、Desktop thread 和 Execution completion 不是同一 identity，不能无证据把它们等同。 |
| `CodexExecutionAdapter` + `CodexExecutionCompletionService` | 读取 `codex exec --json -`、stdout/stderr、process exit evidence，属于 CLI batch path | `KEEP AS FALLBACK`；不作为 Desktop Adapter completion implementation。 |
| `src/control-plane/events/model.ts` | normalized event 结构要求 `thread_id`；当前事件类型和 provider IDs 由 app-server adapter 产生 | `MIGRATE` / `EXTRACT`。保留 normalized event 边界；新 Adapter 需要从 `wait/read` 或 Desktop completion evidence 产生受约束事件，不能写 raw MCP result。 |
| `src/control-plane/events/codex-event-adapter.ts` | 直接 re-export `../../backends/codex_app_server/event-adapter.js` | `MIGRATE`。这是最明确的 event-layer backend coupling。 |
| `StatusQueryService` | `backend_type` schema 固定；`listSessionSummaries` 和 terminal cleanup 只处理 `codex_app_server` Session | `MIGRATE`。查询/cleanup 算法可复用，backend filter 必须在新 Adapter 稳定后扩展。 |
| `DesktopSyncManager` | exact match 写死 `backend_type === "codex_app_server" && session.thread_id === currentConversationId` | `MIGRATE` 为 provider-neutral identity mapping；当前 status contract 先不动。 |
| `ControlledActuationService` / `ExecutionBackendRouter` | adapter boundary 本身可复用，但启动结果依赖 `process_id`，路由依赖 `execution_mode`，没有 target Desktop thread 字段 | `MIGRATE`。P5.2 先做 Adapter-owned primitive，不直接把 PoC 接到 router。 |

现有 `Session` / `Execution` / `Event` 三层的可复用形状是：Session 保存长期
thread context，Execution 保存一次运行，EventStore 保存按 Session 的 normalized
事件。`docs/session-model.md` 还明确禁止把 `thread_id` 或 `session_id` 直接塞进
Execution record；P5.2 应遵守这个边界，而不是通过复制字段绕开 binding。

## 6. Review → ITERATE Coupling

当前 `ITERATE` 的实际第二轮路径是：

```text
ReviewVerdict = ITERATE
  -> AutoIteration.advanceVerdict()
  -> new execution_id + new actuation_id + pending_iteration
  -> AutoIteration.advanceActuation()
  -> ControlledActuation.authorize() / actuate()
  -> ControlledActuation.startReserved()
  -> ExecutionBackendStartRequest
  -> ExecutionBackendRouter
  -> default batch route
  -> CliExecutionBackend
  -> CodexExecutionAdapter
  -> spawn codex exec --json -
  -> new ExecutionContext
  -> CodexExecutionCompletionService process-exit/JSONL evidence
```

关键证据：

- `advanceVerdict` 生成下一轮 `execution_id`，清除旧 review artifacts，进入
  `actuation`：`src/control-plane/auto-iteration.ts:834-898`。
- `advanceActuation` 只用 iteration instruction 创建授权并调用 actuation；它没有
  传 `goal_id`、`execution_mode`、`model`、`reasoning_effort`：
  `src/control-plane/auto-iteration.ts:904-982`。
- `ControlledActuation.startReserved` 只在 authorization 中存在时转发
  `execution_mode`；缺失时 `ExecutionBackendStartRequest` schema 的 default 是
  `batch`：`src/control-plane/controlled-actuation.ts:549-567`、
  `src/control-plane/execution-service.ts:24-31`。

所以即使第一轮 Goal 是 `execution_mode: "interactive"`，当前 production
Review → `ITERATE` 也不会复用第一轮 Session/thread，也不会调用
`CodexAppServerBackend` 的 `send_message_to_thread`（该 backend 根本没有这个
operation）。它启动的是一个新的 CLI Execution。现有 Auto Iteration 测试证明了
“一条 ITERATE 产生一个新的 actuation/Execution”这一业务行为，但 fixture 使用
自定义 adapter，没有证明真实 router 的 Desktop/interactive continuity。

### 依赖与冲突

| 依赖 | 当前所在位置 | 与 Desktop-owned thread continuity 的冲突 |
| --- | --- | --- |
| `backend_type` | `Session` / Status Query / Desktop Sync | AutoIteration loop 不携带 backend/session binding；新轮无法知道应发送给哪个 Desktop executor/target。 |
| `session_id` | SessionStore、StatusQuery 间接查找 | ReviewRequest、AutoIteration、ExecutionContext 不持久化 session_id；不能仅凭 execution_id 安全恢复 Desktop Session。 |
| `thread_id` | Session 和 normalized Events | 新轮没有 target thread；当前 app-server backend 会 `thread/start`，而不是发送到既有 Desktop-owned thread。 |
| `turn_id` | Event/Status Query 的 provider-level current execution | `ITERATE` 没有既有 Desktop turn reference，也没有基于 `read_thread`/`wait_threads` 的 durable turn completion mapping。 |
| `process_id` | Execution record、start result、CLI/app-server recovery | Desktop thread completion 不等于 LRM-owned process exit；把 MCP server PID 当 Execution outcome 需要另行定义证据。 |
| `clients Map` | `CodexAppServerBackend` 的 session-to-private-client map | 只管理 LRM 自己 spawn 的 app-server client，不能定位或控制 Desktop-owned thread。 |
| Execution status | terminal listener 驱动 AutoIteration | 新 Adapter 必须先 durable 写入 `passed/failed` 和 normalized evidence，再触发现有 terminal hook；P5.1 尚未证明这一步。 |

当前 `CodexAppServerBackend.findSession()` 还只允许同一 Goal/Task 找到一个
`codex_app_server` Session；若直接把下一轮重新路由到该 backend，现有 stale
Session 检查会阻止再启动。这进一步说明“把 P5.1 send 原样塞进旧 backend”不是
最小兼容修复。

## 7. Reusable P5 Diagnostic Components

| Diagnostic capability | 结论 | 说明 |
| --- | --- | --- |
| Desktop bundle discovery、`.mcp.json` / `.codex-plugin/plugin.json` contract discovery | `EXTRACT` | 复用当前 bundle 文件存在性、版本和 `codex_app` server contract 检查；生产路径不应继承 diagnostic-only 的宽松 explicit server override。 |
| `CODEX_APP_TOOLS_PIPE_PATH` explicit/inherited discovery | `EXTRACT / REUSE` | 只接受显式 override 或当前环境；继续 fail closed，不猜 pipe 名称。 |
| `MCP Client + StdioClientTransport` 建连/关闭 | `EXTRACT` | 提取为由 Adapter 拥有的 runtime，保留 abort、timeout、close 和 child lifecycle；不要直接调用 diagnostic runner。 |
| `tools/list` schema inspection | `EXTRACT` | 作为启动 contract gate，至少严格检查所需 tool 的 input schema；schema 不兼容停止。 |
| `_meta["openai/threadId"]` | `REUSE AS-IS`（wire shape） | 这是当前 codex-app-tools 的 executor metadata key；每个 `tools/call` 都要使用同一已验证 executor identity。 |
| explicit tool allowlists | `EXTRACT / REUSE` | `list_projects` read-only、`create_thread` effectful、continuity tools 分开；生产仍需最小 allowlist。 |
| `list_projects({})` | `EXTRACT / REUSE` | 保留无参数调用，结果必须由 strict project resolver 消费。 |
| workspace path → project exact match | `EXTRACT` | 提取为 `DesktopProjectResolver`；必须保留 path、`projectKind=local`、`hostId=local` 和 zero/one/many fail-closed 语义。 |
| `create_thread` argument builder | `EXTRACT` | 提取 project target + local environment 的最小 builder；不要复制整段 diagnostic schema summary。 |
| `create_thread` returned `threadId` / `hostId` parsing | `EXTRACT` | 生产需要严格 identity schema；当前 diagnostic 的递归 `identityOf()` 只能作为调查兼容，不应作为最终 durable binding 规则。 |
| `send_message_to_thread` | `EXTRACT` | 生产 primitive 必须验证 `targetThreadId` 等于已持久化的 Desktop-owned thread。 |
| `wait_threads` / `read_thread` | `EXTRACT` | 可作为 completion observation primitive；当前 marker/status heuristic 不能直接成为成功判定。 |
| `executorThreadId` 与 `targetThreadId` 分离 | `REUSE AS-IS`（identity rule） | PoC 已经把 executor metadata 和 created target thread 分开；P5.2 必须保留这两个 namespace。 |
| safe identity projection / bounded error classification | `EXTRACT` | 复用 fail-closed、bounded、结构化字段原则；不把 diagnostic 递归扫描或任意 error text 直接带入生产状态。 |
| markers、`completionEvidence`、`writerConflictObserved`、`desktopApprovalUi`、`--wait-after-failure-ms`、SIGINT runner | `DIAGNOSTIC-ONLY` | 它们用于 PoC 验收和人工观察，不替代 production terminal/recovery evidence。 |
| `runCodexAppMcpDiagnostic` / `runCodexAppEffectfulDiagnostic` | `DIAGNOSTIC-ONLY` | 生产 Adapter 应调用抽出的 primitives，而不是复用带有 diagnostic result/stage 的顶层 runner。 |

## 8. Classification Matrix

| Component | Current Role | Coupling | Classification | P5.2 Action |
| --- | --- | --- | --- | --- |
| `CodexAppServerBackend` | interactive production backend | private app-server | `KEEP AS FALLBACK` | 暂不修改；继续承担现有 interactive fallback。 |
| `CodexAppServerClient` / protocol / provider events | LRM-owned app-server process and RPC | private app-server process | `KEEP AS FALLBACK` | 新 Adapter 不共用其 client；全链路稳定后再评估删除。 |
| `backend.clients` Map | per-Session private client ownership | LRM process lifecycle | `KEEP AS FALLBACK` | 只服务旧 backend；不扩展成 Desktop client registry。 |
| `CodexEventAdapter` | provider event → normalized LRM event | codex_app_server event shape | `MIGRATE` | 抽出 normalized event contract，另做 Desktop completion/event adapter。 |
| `DesktopIPCClient` | named-pipe observer transport | low; read-only Desktop IPC | `KEEP` | 复用为 identity observation source。 |
| `DesktopIPCProtocol` | framing/initialize/following parser | Desktop IPC protocol | `KEEP` | 与 codex_app MCP stdio/native route 分离。 |
| `DesktopIPCObserver` | current Desktop identity observer | low | `KEEP` | `currentConversationId` 作为已验证 executor context source。 |
| `DesktopSyncState` | current/following/owner state cache | low | `KEEP` | 保留当前字段和 fail-closed reconnect semantics。 |
| `currentConversationId` / `followingThreads` / `ownerClientId` | Desktop evidence | observation, not authorization | `KEEP` | 仅把 current ID 映射到 executor context；following/owner 不作为成功条件。 |
| `DesktopSyncManager` | Desktop ↔ LRM Session association/status | `codex_app_server` + `Session.thread_id` | `MIGRATE` | 泛化 identity mapping；P5.2 第一轮不改现有 status contract。 |
| `legacy_app_server` / `activeSource` | Launcher compatibility fallback label | naming + old backend assumption | `KEEP AS FALLBACK` | 保留枚举和 UI；记录 naming debt，稳定后再改名。 |
| `DesktopThreadVisibilityDiagnostic` | sanitized observation-only raw IPC probe | diagnostic | `REMOVE LATER` | 当前保留调查工具；不接生产 Adapter。 |
| `codex-app-mcp-diagnostic` | Desktop bundle/runtime/tools-list probe | diagnostic | `EXTRACT / REUSE` | 抽 runtime discovery、transport、schema gate。 |
| `codex-app-effectful-diagnostic` | P5.1 create/continuity PoC | diagnostic + effectful tools | `EXTRACT / REUSE` | 抽 project resolver、MCP command primitives、metadata envelope 和 strict identity checks。 |
| `SessionStore` / Session storage | durable long-lived context | backend enum/comment | `MIGRATE` | 保留 store；在新 adapter lifecycle 证据之后扩展 backend/ownership semantics。 |
| `ExecutionContextService` | durable one-run status | mostly neutral; process-centric launch boundary | `KEEP` with migration boundary | 复用 storage/status；不要把 Desktop thread 复制进 Execution。 |
| `EventStore` | ordered normalized event persistence | neutral storage | `KEEP` | 复用 append/list 和 identity validation。 |
| `StatusQueryService` | read-only Session/Execution/Event projection | backend enum and app-server filters | `MIGRATE` | 新 binding 稳定后扩展 filters/cleanup；不先改查询契约。 |
| `ExecutionRoutingService` / terminal listener | terminal → AutoIteration routing | backend-neutral | `KEEP` | 新 Adapter 最终只需提供同一 terminal projection。 |
| `AutoIterationService` / Review Loop | Review → verdict → next Execution | current next actuation defaults batch | `KEEP` | 本轮不修改；P5.2 后段再接新 backend continuity。 |
| `ControlledActuationService` / `ExecutionBackendRouter` | authorization and backend dispatch | `process_id`, `execution_mode`, no target thread | `MIGRATE` | 先保持 router；adapter contract 证明后再决定最小扩展。 |
| `CodexExecutionAdapter` / completion service | batch `codex exec --json -` | CLI process/JSONL | `KEEP AS FALLBACK` | 保留 batch/ITERATE 当前兼容行为。 |
| historical shared app-server / same-daemon route | old experiment concept; no current executable implementation found | superseded topology | `SUPERSEDED` | 标记为 superseded；不继续实现、不在本轮删除。 |

## 9. P5.2 Migration Boundaries

### First modules to add/extract

最小边界应停在 Desktop Adapter 的 runtime primitives，不改现有生产路由：

```text
新增/抽取：
- DesktopCodexAdapter
  - owns codex_app MCP client/transport lifecycle
  - keeps executorThreadId and targetThreadId separate
- CodexAppMcpRuntime / transport abstraction
  - bundle contract, stdio transport, CODEX_APP_TOOLS_PIPE_PATH
  - request timeout, abort, close, fail-closed errors
- DesktopProjectResolver
  - list_projects result -> exact local workspace project
- DesktopThreadCommand primitives
  - list_projects
  - create_thread
  - wait_threads/read_thread completion observation
  - send_message_to_thread(existing targetThreadId)
- Desktop execution completion/binding adapter
  - durable Session/Execution identity
  - normalized event projection
  - terminal notification only after persisted terminal evidence
```

### Reuse directly

```text
复用：
- DesktopIPCObserver / DesktopSyncState / currentConversationId
- SessionStore、ExecutionContextService、EventStore 的 storage/identity 机制
- existing StatusQuery / ExecutionRouting interfaces where backend-neutral
- existing Goal / Task / Review / AutoIteration durable records
- P5.1 metadata key and strict two-identity rule
```

`DesktopSyncManager` 不应作为 Adapter 的 command executor；它目前是 status
association layer，必须先保留其 Launcher-compatible output，再单独抽出
provider-neutral identity mapping。

### Completely do not touch in the first P5.2 slice

```text
暂时不动：
- CodexAppServerBackend、CodexAppServerClient、旧 app-server event path
- submit_goal、PendingGoalSubmission、GoalPreflight 和 Browser identity gate
- production ExecutionBackendRouter / interactive selection
- Review Loop / AutoIteration / Review delivery semantics
- existing Session schema/backend_type enum
- Launcher status field names and legacy_app_server compatibility value
- any shared app-server or shared daemon implementation
```

P5.2 第一批的验证重点应是：fake MCP transport 下每个 tools/call 都带正确
executor metadata；project 只接受 exact match；`create_thread` 返回 identity
可持久化；后续 `send_message_to_thread` 只能命中同一 target；completion、restart
和 lost-ACK 都能 fail closed。只有这些证据进入 Session/Execution/Event 并能稳定
触发 terminal listener 后，才有理由进入 router、Status Query 和 Review/ITERATE
接线。

## 10. Recommended P5.2 Starting Point

推荐起点是一个与现有 backend 并列、但尚未成为 production default 的
`DesktopCodexAdapter` vertical slice：

1. 从 diagnostic 中抽出 MCP runtime、project resolver、metadata envelope 和
   thread command primitives；不复制 diagnostic runner、marker heuristic 或
   writer-error classification。
2. 用 `DesktopIPCObserver.currentConversationId` 提供 executor context，但仅在
   connected、identity 合法、来源仍有效时使用；它不直接等于新建的 target thread。
3. 完成一个 Desktop-owned thread 的 durable binding，再完成首轮
   `wait/read -> terminal` 投影到现有 Session/Execution/Event 基础设施。
4. 在 fake transport 和重启/重复调用测试中证明：同一 target thread、单次
   terminal transition、lost-ACK 不重复发送、不能把未证实结果标为 passed。
5. 第二阶段才验证同一 Desktop-owned thread 的 `send_message_to_thread` 第二轮、
   completion/recovery 和现有 `ExecutionRoutingService` terminal hook。
6. 最后才考虑扩展 `backend_type`、Status Query/Launcher filter、production
   router 和 Review → `ITERATE`。旧 `CodexAppServerBackend` 在此之前保持可用。

最终边界判断：

```text
现在可以直接复用：Desktop identity observation、durable core storage、
normalized event/terminal boundary、P5.1 的 MCP metadata/command contract。

现在必须迁移：backend_type/thread ownership、DesktopSyncManager association、
StatusQuery backend filters、process-centric start result、app-server-specific
event adapter，以及 Review → ITERATE 的 execution/session continuity binding。

现在必须保留：CodexAppServerBackend 旧生产 fallback、CLI batch path、Launcher
legacy_app_server status compatibility。

未来可以删除：P4 raw visibility diagnostic、旧 private app-server backend/client
和所有 superseded shared-app-server experiment，但仅在新 Adapter 的 completion、
recovery、Review/ITERATE 全链路稳定之后。
```

本轮不执行上述删除或 P5.2 接线。
