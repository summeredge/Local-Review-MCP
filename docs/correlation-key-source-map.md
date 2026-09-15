# `correlation_key` Source Map

## Scope and conclusion

本次只做代码审查、历史测试审查和现有 hash-only trace 诊断。没有修改
`submit_goal`、Pending、Registry、Bridge、Extension 校验、timeout、Session 或
Execution 业务逻辑；没有新增 MCP tool、API、数据库字段或 trace schema。

结论先行：

1. `submit_goal` 的 `correlation_key` 是 ChatGPT/MCP 调用方放入 tool arguments
   的新 UUID v4。LRM 只校验、原样返回并持久化，不在 LRM 生成这个 key。
2. Extension 有两条会写入同一个 wire 字段 `request_id` 的路径：
   - 直接路径：从 assistant `submit_goal` tool request 的 `args.correlation_key`
     读取；这条路径产生的 `request_id` 应与 `submit_goal.correlation_key` 完全相同。
   - 平台诊断路径：从 Fiber message 的 `metadata.request_id` 读取；它是独立的
     ChatGPT/platform request id，不应当与 `correlation_key` 相等。
3. `fiber.js` 的一次 scan 会把两类值合并到同一个 `{request_id,
   fiber_conversation_id}` evidence 数组；`content.js`、`background.js`、Bridge
   和 LRM 都原样转发这个 `request_id`，没有 source tag，也没有 correlation
   mapping。
4. 因此 `correlation_mismatch` 的直接原因是：LRM pending 保存的是当前调用的
   `correlation_key`，而本次首先到达的 Extension evidence 使用了另一个
   `request_id`。这不是 Bridge 改写，也不是 Session/Execution 生命周期问题。
5. 当前本机 trace 还显示：失败 pending 的三个不同 evidence hash 在该
   `submit_goal` 之前已经出现；与 pending key 相同的 evidence 在 pending
   过期后才出现。它支持“Fiber 扫描到了历史/平台 request ids，direct key 当时
   未及时可见或未及时发布”的判断；仅凭 hash-only trace 不能进一步证明是具体
   哪一种 live Fiber shape 或哪一个浏览器 tab 导致了延迟。

## 1. `submit_goal` path

### Source / Generated at

```text
Source:
  ChatGPT/MCP 调用方的 tool arguments.correlation_key。
  当前 tool description 要求调用方每次生成新的 UUID v4；它不是 MCP HTTP
  x-request-id、JSON-RPC body id、Fiber metadata.request_id，也不是 URL id。

Generated at:
  调用方生成；LRM 没有为 correlation_key 调用 randomUUID()。

file:
  src/mcp/schema/common.ts
function:
  correlationKeySchema

file:
  src/mcp/server.ts
function:
  createMcpServer() 中注册的 submit_goal handler

Input:
  input.correlation_key

Output:
  goalSubmissionAcceptedSchema 的 correlation_key；值与 input.correlation_key
  完全相同。

Stored:
  PendingGoalSubmissionService 的 Map key，以及
  <storage root>/control-plane/pending-goal-submissions.json 中的 record.correlation_key。
```

对应实现位置：

- `src/mcp/schema/common.ts:5-8` 只定义严格 UUID v4 校验。
- `src/control-plane/goal-submission.ts:44-48` 将该 schema 加入 tool input；
  `src/control-plane/goal-submission.ts:60-65` 将它加入 acceptance receipt。
- `src/mcp/server.ts:987-1012` 读取 `input.correlation_key`，记录
  `submit_goal_received`，再原样传给 Pending 的 `accept`。
- `src/control-plane/pending-goal-submission.ts:217-275` 在 schema 校验后以
  `parsed.correlation_key` 建立 pending，先 `persist(next)`，再返回 receipt。

### LRM 生成点排除

`src/control-plane/goal-submission.ts:76-90` 的 `generatedId()` 只生成
`goal_id`、`phase_id`、`task_id`。`GoalSubmissionService.submitGoal()`
(`src/control-plane/goal-submission.ts:109-119`) 接收到的
`GoalSubmissionRequest` 甚至没有 `correlation_key`；Pending 在身份确认后只把
`workspace_id`、`conversation_id` 和 Goal payload 传给它。因此 correlation key
不会进入 Goal domain plan，也不会在 GoalSubmissionService 内被重新生成。

`src/mcp/http.ts:719-724` 的 `x-request-id` 归一化及缺省 `randomUUID()` 是
MCP HTTP transport trace；`src/mcp/inbound.ts:33-38` 也只负责该 transport id。
它们不参与当前 `submit_goal` key 的生成或匹配。

### Pending / identity 生命周期

```text
ChatGPT tool call
  -> submit_goal handler receives input.correlation_key
  -> pending accept parses exact UUID v4
  -> pending record persisted as state=pending_identity
  -> Extension evidence request_id must equal the same key
  -> ConversationCorrelationRegistry.correlation(key) returns canonical owner
  -> pending resolve persists state=starting
  -> GoalSubmissionService.submitGoal({ ..., conversation_id })
  -> state=started / failed / indeterminate
```

`PendingGoalSubmissionService` 的实际时间字段不是用户问题中列出的四个同名
字段，具体对应关系如下：

| 生命周期概念 | 当前实现 | 结论 |
| --- | --- | --- |
| `created_at` | `accepted_at` 在 `accept()` 中由 `nowIso(now)` 生成；`pending_created` trace 将它作为 `created_at` 写出 | 有 pending 接受时间；record 本身字段名是 `accepted_at` |
| `stored_at` | `await this.persist(next)` 后才赋值 `this.submissions = next`；没有 `stored_at` 字段 | 没有单独的存储完成时间；`pending_created.timestamp` 是 trace 写入时间 |
| `matched_at` | `resolve()` 将 record 持久化为 `starting` 后写 `evidence_match_success` | 没有 `matched_at` 字段；该 event 的 `timestamp` 是最近似的匹配时间 |
| `expired_at` | `expires_at = accepted_at + PENDING_GOAL_SUBMISSION_TTL_MS`；过期后写 `resolved_at` 并将状态设为 `failed` | 没有实际 `expired_at` 字段；`expires_at` 是 deadline，`pending_expired.timestamp`/`resolved_at` 才接近实际处理时间 |

关键实现：

- TTL 为 `2 * 60 * 1000`：`src/control-plane/pending-goal-submission.ts:30`。
- `accept()` 先持久化 pending，再发 `pending_created`：
  `src/control-plane/pending-goal-submission.ts:247-265`。
- `resolve()` 只以 exact key 查找 registry，并在 starting 持久化后写
  `evidence_match_success`：`src/control-plane/pending-goal-submission.ts:318-382`。
- `Goal` 成功/失败后的 terminal record 使用 `resolved_at`：
  `src/control-plane/pending-goal-submission.ts:593-637`。
- expiry timer 使用 `expires_at`，并把过期 pending 转成 failed：
  `src/control-plane/pending-goal-submission.ts:691-702`。
- terminal record 的保留窗口为 24 小时，之后由 `prune()` 清理：
  `src/control-plane/pending-goal-submission.ts:34`、`169-181`。

### Registry 生命周期

`ConversationCorrelationRegistry` 实际保存的是 Extension 已提交的 evidence，
并不是一个“根据 conversation_id 反查 pending key”的 mapping：

- `src/control-plane/conversation-correlation.ts:21-24` 的 map entry key 是
  `request_id`，同时保存 `first_observed_at`、`last_observed_at`、
  `document_id`、`navigation_epoch`。
- `src/control-plane/conversation-correlation.ts:41-98` 的 `observe()` 使用
  `parsed.request_id` exact lookup；不同 request id 不会合并，same request id
  但不同 conversation 会被拒绝。
- `src/control-plane/conversation-correlation.ts:102-119` 的 `correlation()`
  也是 exact lookup；不存在按 conversation、URL、document 或时间的 fallback。
- registry 状态持久化为
  `<storage root>/control-plane/request-correlations.json`，没有时间 TTL，最多
  50,000 个 entry：`src/control-plane/conversation-correlation.ts:26`、`161-213`。

## 2. Extension evidence path

### Source / Generated/read at

```text
Source:
  Direct submit_goal source:
    assistant message.content.text JSON -> args.correlation_key

  Separate platform source:
    assistant/tool/page message.metadata.request_id

Generated/read at:
  extension/fiber.js::submitGoalCorrelationKeyOf()
  extension/fiber.js::requestIdsOf()
  extension/fiber.js::scan()

Input:
  React Fiber turn.messages / allMessages

Output:
  { request_id, fiber_conversation_id }
  两条 source 都使用同一个 wire 字段 request_id；没有 source 标记。

Transport:
  fiber.js MAIN world
    -> window.postMessage(lrm-extension-identity-reply)
    -> content.js fiberScan()
    -> content.js publishEvidence()
    -> chrome.runtime.sendMessage({ type: "identity_evidence", ... })
    -> background.js receiveEvidence()/evidenceFromMessage()
    -> background.js postBridge("/identity-evidence", evidence)
    -> Bridge receiveIdentityEvidence()
    -> app.ts onIdentityEvidence()
    -> ConversationCorrelationRegistry.observe(evidence)
    -> PendingGoalSubmissionService.scheduleResolve(evidence.request_id)
```

### Direct `submit_goal` extraction

`extension/fiber.js:412-449` 的 `submitGoalCorrelationKeyOf(message)` 是直接 key
路径：

1. 只接受 `author.role === "assistant"`。
2. 只接受 `recipient === "api_tool.call_tool"`，或当前 Connector 的
   `recipient === "Local_MCP_Connector.submit_goal"`。
3. 只接受 `content_type` 为 `code` 或 `tool_call`，解析 `content.text` JSON。
4. 对 legacy path 要求 `path` 的最后一段是 `submit_goal`；对当前 Connector
   还校验存在的 `name`、`tool`、`tool_name` 都是 `submit_goal`。
5. 要求恰好一个 own `args` 或 `arguments`；字符串 arguments 再解析一次 JSON。
6. 最终只读取 own `args.correlation_key`，并要求严格 UUID v4。

`submitGoalCorrelationKeysOf()` (`extension/fiber.js:451-463`) 对扫描到的全部
message 去重，但没有把 key 限制为“当前最近一次 tool call”。

### Platform `metadata.request_id` extraction

`extension/fiber.js:383-397` 的 `requestIdsOf(messages)` 对传入的整组 messages
逐条读取 `message.metadata.request_id`，只做长度/字符集校验和去重。它不验证：

- 该 id 是否属于当前 `submit_goal`；
- 该 id 是否与 `args.correlation_key` 相等；
- 该 id 是否是本次调用而非历史 message；
- 该 id 是否来自当前 turn。

`extension/fiber.js:485-522` 的 `scan()` 对最近最多 `MAX_TURNS = 100` 个 Fiber
turn 执行：

```text
submitGoalCorrelationKeysOf(messages)
  .concat(requestIdsOf(messages))
  -> byRequest.set(requestId, conversationId)
  -> { request_id: requestId, fiber_conversation_id: conversationId }
```

所以即使 direct key 能被读取，一次 scan 也可以同时产生 direct key 和多个
platform request ids。当前 wire schema 的 `request_id` 允许普通 opaque id，也
允许 UUID-looking id；外观不能证明其来源。

### Fiber conversation id is not correlation key

`extension/fiber.js:30-61` 从 Fiber props 中读取 conversation identity，
`extension/fiber.js:63-73` 读取 `turn.messages` 或 `allMessages`。这些函数只提供
“证据属于哪个 ChatGPT conversation”，不生成 correlation key。

`extension/fiber.js:524-530` 的 URL helper 也只在页面侧读取 route conversation id；
它不会读取或生成 `request_id`。

### `content.js` path

`extension/content.js:151-196` 的 `fiberScan()` 只验证 MAIN-world reply 的
nonce、version、shape、`request_id`、`fiber_conversation_id`，不会改写 id。

`extension/content.js:346-375` 的 `publishEvidence()`：

- 从当前 URL 取得 `conversationId`；
- 要求 `entry.fiber_conversation_id === conversationId`；
- 以 `epoch + conversation + entry.request_id` 组成内存 dedup key；
- 通过 `chrome.runtime.sendMessage` 原样发送 `request_id: entry.request_id`。

因此 URL 只过滤 conversation owner，不能把 metadata request id 转成
correlation key。

### `background.js` path

`extension/background.js:517-528` 的 `receiveEvidence()` 先使用
`sender.documentId` 与 `navigation_epoch` 调用 `authorizeDocument()`，再调用
`evidenceFromMessage()`。

`extension/background.js:365-378` 的 `evidenceFromMessage()` 从消息中读取
`raw.request_id` 和 `raw.conversation_id`，然后返回：

```text
request_id       = raw.request_id        // 原样
conversation_id  = raw.conversation_id   // 原样
document_id      = sender.documentId     // 不信任 body 的 document_id
navigation_epoch = authorized epoch
```

`extension/background.js:507-511` 的 `postEvidence()` 把这个 object 原样传给
`postBridge()`。`postBridge()` (`extension/background.js:465-505`) 只添加
protocol/auth headers，不生成或替换 request id。

## 3. Cache / navigation / document lifecycle

### Extension 是否持久化 correlation key

没有。

`extension/background.js:143-147` 的 `chrome.storage.local` 读取项包括
`port`、`token`、`tabDocuments`、`tabEpochs`、`tabConversations`、
`retiredDocuments` 以及 delivery/completion 状态；没有 `request_id` 或
`correlation_key`。`persistState()` (`extension/background.js:243-250`) 也只写
这些 document/epoch/conversation 状态。

存在的短生命周期状态：

- `content.js:18-31`：`navigationEpoch`、`registeredDocumentId`、`sent` Set；
  `sent` 只用于避免重复发送，不是 key mapping。
- `content.js:393-405`：URL 变化时递增 `navigationEpoch` 并清空 `sent`。
- `background.js:299-363`：以 `sender.documentId`、tab epoch、route conversation
  验证当前页面 authority。
- `background.js:140-225`：document/epoch/conversation 和 Bridge credential
  可在 service-worker suspension/reload 后恢复；request id 不在其中。

### LRM 是否持久化 Extension evidence

是，但这是收到 evidence 后的 server-side registry，不是 Extension cache：

```text
<storage root>/control-plane/request-correlations.json
```

它按 Extension 送来的 exact `request_id` 保存 owner。若 Extension 送来的是
平台 `metadata.request_id`，LRM 就会把那个平台 id 当成一个独立 registry key；
LRM 不知道它原本来自 metadata。

## 4. Bridge / LRM continuation

### Bridge

`src/control-plane/bridge.ts:281-335` 的 `receiveIdentityEvidence()`：

1. 从 body 读取 request/conversation 字段用于 hash-only transport trace；
2. 用 `extensionIdentityEvidenceSchema` 校验四个字段；
3. 用 `parsed.data.request_id` 原样记录并调用 `onIdentityEvidence(parsed.data)`；
4. 返回 HTTP 202。

Bridge 没有 `correlation_key` 字段，也没有 pending lookup 或 mapping 逻辑。
`src/control-plane/bridge.ts:537-565` 只负责 origin、protocol、pairing、bearer
authorization 和 route dispatch。

### App callback / pending matching

`src/app.ts:264-301` 的 production `onIdentityEvidence` 做如下事情：

```text
evidence.request_id
  -> identity/transport trace
  -> correlations.observe(evidence)
  -> pendingGoalSubmission.diagnoseEvidence(evidence, activeWorkspace)
  -> pendingGoalSubmission.scheduleResolve(evidence.request_id)
```

`diagnoseEvidence()` (`src/control-plane/pending-goal-submission.ts:452-493`) 对同
workspace 的 pending record 做 exact string comparison：

```text
pending.correlation_key === evidence.request_id
```

不相等时记录 `reason = "correlation_mismatch"`，并将 observed key hash 写入
`observed_correlation_key_hash`。相等时不会产生 mismatch；如果 record 已过期，
则记录 `expired`。

`scheduleResolve()` 和 `resolve()` (`src/control-plane/pending-goal-submission.ts:300-377`)
也只使用传入的 exact key。故 generic platform evidence 不会“唤醒”另一个
pending key；它最多在 registry 中建立自己的独立 owner。

## 5. Comparison table

| 项目 | `submit_goal` | Extension evidence |
| --- | --- | --- |
| 来源 | ChatGPT/MCP tool caller 的 `arguments.correlation_key` | direct: Fiber assistant tool args；另有 platform: `message.metadata.request_id` |
| 生成位置 | 调用方；LRM 不生成 correlation key | ChatGPT 页面已有 message/Fiber 值；Extension 只读取、筛选、转发 |
| 字段名 | 输入/receipt/pending：`correlation_key` | wire/evidence：`request_id`；direct path 将其赋为 `args.correlation_key` |
| 生命周期 | input → `pending_identity` → `starting` → terminal；pending TTL 2 分钟，terminal 保留 24 小时 | Fiber/page message → content 内存 dedup → background/Bridge；Extension 不持久化 request id，LRM registry 最多 50,000 条且无 TTL |
| 传输路径 | ChatGPT tool call → MCP server → Pending | Fiber → `window.postMessage` → content → `chrome.runtime` → background → Bridge → app callback → registry/pending |
| 是否持久化 | 是：`pending-goal-submissions.json` | Extension 侧否；LRM 收到后按 evidence `request_id` 是：`request-correlations.json` |
| 是否应相等 | 必须与 direct submit evidence 的 `request_id` 相等 | 只有 direct `args.correlation_key` 分支应相等；metadata 分支不应相等 |

## 6. Historical successful paths

### 6.1 当前 pending / MCP tests：same-key by construction

这些测试成功的共同条件是：测试 helper 使用同一个常量作为两边的 key。

| 测试 | 做法 | 为什么匹配 |
| --- | --- | --- |
| `tests/control-plane/pending-goal-submission.test.ts:23-49, 135-147` | `input()` 默认 `CORRELATION_A`，`evidence()` 默认也为 `CORRELATION_A`，然后 `observe()` + `resolve(CORRELATION_A)` | pending map key、registry key、resolve 参数完全相同 |
| `tests/control-plane/submit-goal-tool.test.ts:40-57, 153-160` | MCP 调用使用 `goalArguments()` 的 `CORRELATION_A`，测试随后手动 `evidence(CORRELATION_A)` | 没有浏览器 scan；测试直接注入同 key evidence |
| `tests/control-plane/identity-trace.test.ts:103-119` | tool call 使用 `KEY_A`；测试手动构造 `evidence(KEY_A, ...)`，再调用 `scheduleResolve(KEY_A)` | 这是 trace/Control Plane 集成测试，不是 live Extension 观测 |
| `tests/control-plane/evidence-transport-trace.test.ts:124-174` | 测试 HTTP POST body 直接写 `KEY_A`；Bridge 只转发 | 证明 Bridge 保留输入值，不证明 Extension 从何处得到值 |

### 6.2 Extension parser test：synthetic Fiber shape

`tests/submit-goal-correlation.test.ts:65-78` 构造的 current Connector request
明确包含：

```text
recipient = Local_MCP_Connector.submit_goal
content.text = { name: "submit_goal", arguments: "{ correlation_key: KEY_A }" }
metadata.request_id = PLATFORM_REQUEST_ID
```

测试 `:167-217` 同时断言：

- direct entry 的 `request_id === KEY_A`；
- metadata entry 的 `request_id === PLATFORM_REQUEST_ID`；
- content path 会把两者都送出；
- metadata id 不被当作 direct submit key。

这组测试已经明确写出了当前设计的“双 source / 同 wire field”行为，但它只
运行人工构造的 Fiber message，不确认当前生产 ChatGPT Fiber 是否正好具有该
shape、当前 message 是否已 hydration、或用户实际加载的 unpacked extension 是否
为当前 `extension/` 源码。

### 6.3 Phase 5.6 E2E is not a browser correlation proof

`tests/e2e/review-loop.test.ts:402-437` 的 E2E：

1. 测试进程用 `crypto.randomUUID()` 生成 `correlationKey`；
2. MCP tool 使用该 key；
3. 测试直接执行 `correlations.observe({ request_id: correlationKey, ... })`；
4. 测试直接调用 `pending.scheduleResolve(correlationKey)`。

它没有运行 Fiber、content、background 或 Bridge，因此它验证的是 Control Plane
在“evidence 已经被正确构造为同 key”时可以成功，不是 Interactive Smoke 的
browser-to-LRM correlation proof。

同样，`scripts/test_interactive_goal.mjs:52-62` 直接调用
`GoalSubmissionService.submitGoal()`，不经过 MCP `submit_goal`、Pending 或
Extension evidence；它验证 Interactive Codex backend，不验证 correlation。

### 6.4 Historical semantic change

历史提交 `52f99df` 将 `submit_goal` 从 inbound transport request correlation
改为显式的 caller-supplied UUID v4 `correlation_key`。在旧路径中，MCP server 使用
`currentInboundCorrelation()`/`awaitCurrentInboundCorrelation()`，因此测试可以用
transport request id 让两边自然相等。新路径改为：

```text
correlations.correlation(input.correlation_key)
```

并由 Pending 保存 exact caller key。

历史提交 `783372d` 又为当前 `Local_MCP_Connector.submit_goal` request shape
增加了 `submitGoalCorrelationKeyOf()` 支持和 synthetic tests。它证明“代码设计
支持 direct path”，但不等于完成了一次当前生产 Fiber capture。

## 7. Current hash-only trace verification

以下只记录 hash 前缀，不记录 raw UUID、conversation id、token 或 message content。
时间来自本机 `C:/Users/shaoy/AppData/Local/LocalReviewMCP/control-plane/` 下的
现有 trace 文件；它是诊断快照，不改变代码结论。

### Failed attempt

```text
pending key P = fa8110820621…

14:16:32  submit_goal_received       P
14:16:33  pending_created            P

14:17:48  extension_evidence_received  E1=3960c3c53db9…
14:17:48  evidence_match_failed        P, reason=correlation_mismatch, observed=E1
14:17:48  extension_evidence_received  E2=ec9c325a12c8…
14:17:48  evidence_match_failed        P, reason=correlation_mismatch, observed=E2
14:17:48  extension_evidence_received  E3=1c027b6a5941…
14:17:48  evidence_match_failed        P, reason=correlation_mismatch, observed=E3

14:18:33  pending_expired             P
```

同一 E1/E2/E3 三个 hash 在本次 `submit_goal_received` 之前已经出现在
`extension_evidence_received` trace 中。这说明它们不是由 LRM 在本次 tool call
中生成的 P；它们更符合 page Fiber 历史 message 中已有的 platform/direct ids
被再次扫描的表现。由于平台 request id 也可以是 UUID v4-looking，不能只靠格式
给它们命名；但它们与 P 的 exact equality 已被排除。

### Late evidence with the pending key

```text
14:23:42  extension_evidence_received  P
14:23:42  evidence_match_failed        P, reason=expired
```

transport trace 显示这个 evidence 依次经过：

```text
extension_evidence_created
  -> bridge_evidence_received
  -> bridge_evidence_forwarded
  -> connector_evidence_received
  -> extension_evidence_received
  -> connector_resolve_called
  -> evidence_resolve_attempted
  -> evidence_resolve_failed
```

这证明 Bridge 没有把 P 改成别的值；与 pending 相同的 key 后来确实到达过，但已经
超过 `expires_at`，所以不会产生 `evidence_match_success`。

### What the trace proves / does not prove

已证明：

- `submit_goal` pending 保存的 P 与第一批 Extension evidence E1/E2/E3 不同；
- `correlation_mismatch` 发生在 Pending exact comparison，而不是 Bridge transport；
- P 后来曾以 Extension evidence `request_id` 到达，但过期；
- 失败不是由 Session、Execution 或 Goal domain 重新生成 key 导致。

尚未证明：

- E1/E2/E3 在生产 Fiber 中的精确字段来源是否全部为 `metadata.request_id`，
  还是其中包含历史 direct submit request；
- 第一次 scan 时 current Connector message 是否已经可读；
- 当前浏览器 tab/document 是否在 scan 期间发生了 route/navigation 切换；
- 用户实际加载的 Extension 文件是否与当前 checkout 的 `extension/fiber.js`
  完全一致。

这些问题需要一次不输出正文的 live Fiber capture；不应靠猜测放宽匹配规则。

## 8. Hypothesis verification

### Hypothesis A: submit key and Extension request id should be the same

结论：**条件成立，整体不成立。**

- 对 direct path，设计和代码都要求：
  `submit_goal.arguments.correlation_key === assistant args.correlation_key === evidence.request_id`。
- 对 `metadata.request_id` path，设计明确把它视为 platform/transport id；它不应
  替代 direct key。
- 本次第一批 E1/E2/E3 与 P 不同，所以它们不是成功所需的 direct equality。

因此“生成链路断开”只适用于 direct key 在第一次 scan 没有及时被读取/发布的
情况；不能把 metadata request id 当成同一 key 后再追查 LRM 生成规则。

### Hypothesis B: the two fields are intentionally different

结论：**对当前收到的 generic evidence 成立；没有 mapping 是当前设计的一部分。**

`correlation_key` 是 MCP input 的业务关联 key；Extension evidence 的 wire schema
只有 `request_id`。direct path 通过赋值让它们相等，metadata path 则把另一种
platform id 放进同一字段。Bridge/LRM 没有 source discriminator 或 mapping table。

所以当前 `correlation_mismatch` 的最小解释是：Extension 发的是 B 类 platform
request id，LRM 等待的是 caller-supplied correlation key；identity mapping 不
存在，但也不应通过“按 conversation/时间猜一个 key”来补上。

### Hypothesis C: browser cached old identity

结论：**部分支持“历史页面证据/时序”现象，不能仅据此认定为 document cache bug。**

- 没有 `request_id`/`correlation_key` 的 `chrome.storage` cache。
- `sent` 是 content 内存 dedup Set；navigation change 会清空它。
- documentId、navigation epoch、route conversation 只做 authority/freshness gate，
  不会将一个 request id 转成另一个。
- `fiber.js` scan 会遍历最近最多 100 个 turn 的全部 messages，因此 page model
  中的旧 `metadata.request_id` 可以再次进入 evidence。
- 本机 trace 中 E1/E2/E3 早于 P 已被观察，且 P 在过期后才再次到达；这支持历史
  evidence + matching evidence 延迟的组合，但还不能区分旧 message、hydration timing、
  tab 切换或旧 extension bundle。

## 9. Recommended minimal repair point

本任务不实施修复。若下一步确认需要修复，最小归属应按以下顺序：

1. 先对当前实际生产 Fiber request 做一次 fresh capture，确认
   `recipient`、`content_type`、`content.text`、`args/arguments` 和
   `correlation_key` 的结构；同时确认浏览器加载的是当前 `extension/` 目录，
   记录 documentId/navigation epoch/route 的结构性信息。
2. 如果 direct key 在生产 shape 中未被识别，只改
   `extension/fiber.js::submitGoalCorrelationKeyOf()`，并补对应的
   `tests/submit-goal-correlation.test.ts` synthetic probe。现有 strict recipient、
   exact tool、own args/arguments、strict UUID v4 门禁必须保留。
3. 如果 direct key 已在第一次 Fiber scan 中出现，但没有在 TTL 内送达，则继续查
   `extension/fiber.js::scan()`、`extension/content.js::publishEvidence()` 的
   scan timing/route epoch；不要修改 LRM pending/Bridge 去接受 metadata request id。
4. 只有产品明确要把 platform `metadata.request_id` 与 caller key 做 join 时，
   才需要另行设计 identity mapping；这会改变当前 strict direct-correlation
   contract，不属于本次最小修复，也不能用 conversation、时间或 UUID 外观猜测。

## 10. Acceptance output

### 1. 未修改文件列表

本次没有修改任何生产逻辑、测试文件、配置、MCP tool、API、数据库字段或 trace
schema。以下核心文件仅被读取：

```text
src/mcp/schema/common.ts
src/mcp/server.ts
src/mcp/http.ts
src/mcp/inbound.ts
src/control-plane/goal-submission.ts
src/control-plane/pending-goal-submission.ts
src/control-plane/conversation-correlation.ts
src/control-plane/request-correlation-integration.ts
src/control-plane/bridge.ts
src/control-plane/bridge-protocol.ts
src/app.ts
extension/manifest.json
extension/fiber.js
extension/content.js
extension/background.js
tests/control-plane/pending-goal-submission.test.ts
tests/control-plane/submit-goal-tool.test.ts
tests/control-plane/identity-trace.test.ts
tests/control-plane/evidence-transport-trace.test.ts
tests/submit-goal-correlation.test.ts
tests/e2e/review-loop.test.ts
scripts/test_interactive_goal.mjs
```

工作开始前已经存在的其他 dirty/untracked 文件属于用户已有改动；本次没有
覆盖、回滚或重写它们。新增的唯一文件是本文档本身：
`docs/correlation-key-source-map.md`。

### 2. `submit_goal` correlation 生成链路

```text
ChatGPT/MCP caller generates UUID v4
  -> submit_goal input.correlation_key
  -> schema validation
  -> pending record exact key
  -> pending-goal-submissions.json
  -> exact registry lookup after evidence
  -> GoalSubmissionService receives only proven conversation_id/payload
```

### 3. Extension evidence correlation 生成链路

```text
Fiber turn.messages
  -> direct args.correlation_key OR metadata.request_id
  -> same wire request_id
  -> content route/epoch filter
  -> background sender document authority
  -> Bridge exact forward
  -> LRM registry exact request_id key
```

### 4. Correlation source map

见本文 `## 1`、`## 2`、`## 5`。

### 5. 两者不一致原因

失败批次先到达的是与 pending P 不同的 Extension request ids；代码会把这些值
原样送入 registry 和 pending resolver。当前实现不按 conversation、URL、
metadata、document 或时间将它们映射为 P。与 P 相同的 evidence 后到达时已过期。

### 6. 历史成功路径分析

历史成功主要来自同 key 的人工注入/synthetic Fiber 测试；Phase 5.6 E2E 和
`test_interactive_goal.mjs` 都不是完整 Browser Extension correlation proof。
旧 transport-correlation 语义也曾让测试中的 transport id 与 evidence id 自然相等；
`52f99df` 后，caller-supplied UUID v4 才是 authoritative key。

### 7. 推荐最小修复点

先 fresh capture；若是 production Fiber shape 未被识别，最小修复点为
`extension/fiber.js::submitGoalCorrelationKeyOf()` 及其 focused test。不要在
Pending、Registry 或 Bridge 接受不相等的 metadata request id。

### 8. 是否需要修改代码

**NO。** 本诊断尚未获得足以安全修改代码的 fresh production Fiber shape 证据；
本任务只新增诊断文档。
