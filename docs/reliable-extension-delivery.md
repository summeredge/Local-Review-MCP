# Reliable Extension Delivery

Reliable Extension Delivery is an independent Local Control Plane transport. It does not replace
the existing Playwright `BrowserDeliveryAdapter` or add an MCP tool. The Control Plane
`DispatchCommandBroker` composes it with `ReviewDelivery` through an injected adapter.

The related identities have separate owners:

- Conversation Correlation proves which ChatGPT conversation owns an MCP request.
- Reliable Extension Delivery safely sends one physical command to that exact open conversation.
- ReviewDelivery remains the logical review-delivery record.
- Browser Transport Gate remains the future choice between Extension and Playwright transports.

## Durable command and lease

`ExtensionDeliveryService.enqueue(conversationId, message, logicalDeliveryId?)` stores a versioned command in
`<LocalReviewMCP state root>/control-plane/extension-deliveries.json`. Writes are serialized and
use a mode-`0600` temporary file followed by atomic rename; the containing directory is mode
`0700`. State is bounded to 1,000 commands and never enters `.task/`.

When supplied, `logicalDeliveryId` is the stable `ReviewDelivery.delivery_id`. A repeated enqueue
with the same logical ID and exact target/message returns the original durable command; a changed
target or message is rejected. Keyed terminal commands are retained when the bounded queue evicts
legacy unkeyed commands, so a logical delivery cannot be remapped to a second physical command.

An open content document pulls work through `POST /delivery/claim`. The background worker binds
the claim to its stable `client_id`, Chrome's authoritative `MessageSender.documentId`, the exact
sender URL conversation, and the document's `navigation_epoch`. The service persists the lease
before returning the message body. A second tab cannot claim the same `delivery_id`.

LRM restart restores `queued` and `leased` commands as stored. A live lease stays owned until its
original deadline. An expired pre-submit lease can be claimed again; delivered, failed, and
ambiguous commands are terminal and are never returned again.

## Composer and receipt gate

Selectors live in `extension/chatgpt-dom.js`. Content claims only when the exact document is still
on the target conversation, the composer exists and is empty, there are no attachments, and
ChatGPT is not generating. Existing drafts are never cleared, overwritten, appended to, or sent.

After inserting the exact command text, content asks background to durably record the
`submitting` boundary before clicking Send. Every await is fenced by conversation, URL, and
navigation epoch, so A to B to A cannot revive an old operation.

A click is not delivery. `sent` requires a newly rendered ChatGPT user message whose normalized
text exactly matches the command and whose stable `data-message-id` was not present before the
click. The resulting durable receipt binds `delivery_id`, `conversation_id`, and `message_id`.
If submit occurred without that proof, the result is `ambiguous` and is never retried.

## Durable ACK recovery

The MV3 background worker stores only transport metadata in `chrome.storage.local`: stable
`client_id`, in-flight identity/stage, and the ACK outbox. It never stores the command message.

The order is:

```text
ChatGPT message receipt
  -> save ACK outbox
  -> POST /delivery/ack
  -> LRM atomically commits receipt and retires lease
  -> remove ACK outbox entry
```

After suspension or browser restart, pending ACKs are flushed before new work is claimed. A lost
HTTP ACK response therefore retries only the identical ACK. Repeated identical ACKs return the
existing receipt; changed status, conversation, owner, epoch, or message ID returns `409`.

Crash windows fail closed:

- claim before submit: the stored pre-submit lease may safely expire and retry;
- confirmed ChatGPT message before HTTP success: the durable ACK outbox retries ACK only;
- submit without a stable receipt: the durable `submitting` marker becomes terminal ambiguous,
  never a second send.

## Repeatable Goal E2E diagnostic

### 目标 conversation 页面自动恢复

生产 Review Delivery 使用 `conversationDeliveryReadiness(conversationId)`，以该会话最近成功通过验证的
claim 为依据。其它页面或后台 heartbeat 在线不代表目标会话 ready。原有全局
`extensionDeliveryReadiness()` 保留给 Goal preflight，避免把 composer 可发送条件误用于正在执行的工具调用。

目标不可领取时，Broker 仍先持久化同一 logical delivery 的 command。Extension 后台通过经过
Origin、protocol、bearer 和 strict schema 校验的 `POST /delivery/recovery-targets` 读取未领取的
Review command 的 `delivery_id` / `conversation_id`，不取得消息正文或 lease。后台先清空 durable
ACK outbox，再用 `chrome.tabs` 复用相同会话的已有或正在导航的标签页；不存在时打开固定
`https://chatgpt.com/c/<conversation_id>`。恢复操作串行去重，每次检查真实 tabs，因此后台或 Runtime
重启后也复用已有页面。discarded 页面会重新加载。content script 保持原有 claim、发送和 ACK 路径。

后台启动、现有 claim 流量和每分钟一次的 MV3 alarm 都会触发恢复；即使没有 ChatGPT 标签页，alarm
仍可唤醒后台。选择这个入口是因为现有 Browser Worker 是独立的 headless profile，未加载 Extension，
无法直接恢复用户浏览器的已登录 conversation 和 content script。

新增的 `tabs` 权限用于读取目标和登录跳转 URL，`webRequest` 只观察已授权 ChatGPT host 的主文档及
conversation API 请求失败，不拦截请求。明确 404 / 401 / 403 或登录跳转分别记录
`TARGET_CONVERSATION_NOT_FOUND` / `TARGET_CONVERSATION_AUTH_REQUIRED`，进入 human_required。
导航失败和 Extension 注册超时可以重试。恢复错误经 `POST /delivery/recovery-failure` 严格匹配
未领取的 delivery 和 conversation；已领取及已有 receipt 的 command 不会被该接口改变。

恢复和等待 ACK 共用现有 90 秒投递上限，最多 10 次投递尝试，间隔 30 秒；耗尽后进入
human_required，保留明确原因。未领取的超时 command 安全退休；已有 lease 的未知发送结果沿用现有
ambiguous / late ACK 规则。导航成功不算 delivery 成功，只有原有 sent receipt 能推进 Review Completion。

当前 ChatGPT timeline 会同时保留隐藏和可见的 composer。共享 DOM helper 只选有布局矩形的编辑器，
避免恢复后误用隐藏副本而返回 `composer refused exact message`，同时保留可见编辑器的草稿保护。

部署时需重新加载 Extension 并重启 Runtime。真实验收应在 interactive Goal 启动后关闭目标标签页，
确认无需手工重开即可恢复、仅出现一次 Review 请求，并继续取得匹配身份的 Review Result/verdict。

#### canonical identity 与 document recovery

Identity Evidence、Delivery 和 Review Completion 共用 Fiber 模型的 canonical conversation identity。
即使当前没有 `submit_goal` tool turn，MAIN helper 也会返回当前渲染模型的 `conversation_id`；
`WEB:*` 仍只通过同一模型的 `serverId$()` 解析。未知、不可读或冲突模型返回 null，不能退回 URL 猜测。
URL 有具体 conversation 时必须一致；URL 尚未分配 ID 的聊天首页/Project 首页必须有有效 Fiber identity。
分享、登录及其它非聊天路由不能投递。content 在 claim 和点击前重新验证模型；URL 或 canonical identity
变化会使 navigation epoch 和旧发送 fence 失效。worker 使用当前 `sender.tab.url` 作路由交叉校验，避免
SPA 后仍使用初始 `sender.url`；document、epoch、lease owner 和 ACK 校验保持有效。

Recovery 用 `delivery_probe` 探测实际 content document 和 canonical identity，不能仅凭 URL 判定已恢复。
已有目标 URL 但没有有效 document 的 complete/discarded tab 会 reload；缺少目标 tab 才 create。
complete tab 的重复 reload 至少间隔一分钟，时间戳和恢复目标映射持久化于 `chrome.storage.local`。
MV3 worker 重启后先恢复映射，再处理登录跳转/HTTP 失败。target 查询异常及失败报告拒绝会记录 warning。
过期 leased command 也能成为 recovery target；worker 必须先处理 submitting 的 ambiguous 回执和 ACK outbox，
才允许恢复页面领取，防止未知发送结果重发。

2026-10-02 两次任务的运行证据、修复文件及验收映射见 [修复报告](review-delivery-submit-goal-fix.md)。

Run the existing diagnostic against one concrete Chat conversation:

```powershell
npm run diagnose:goal-e2e -- --config config.production.json --conversation-id <conversation_id>
```

The command starts one Runtime, verifies the existing Connector, and waits up to 60 seconds for
Bridge pairing plus live Extension presence before it creates a Goal. A Bridge restart therefore
cannot create a false failed delivery while the Extension is still recovering. The target
Chat page can close after the Goal starts; background recovery restores it without changing OAuth,
Connector binding, workspace identity, or the delivery state machine.

Each run uses its `goal_id` as the `run_id` and marker, prints an `E2E Pre-run Snapshot`, then ends
with an `E2E Run Summary`. The summary reports runtime, Connector, readiness, delivery, completion,
verdict, Goal, failure stage, and safe lifecycle timestamps. It never prints the delivery message,
assistant response, OAuth tokens, or Connector credentials.

Delivery claim and broker timeouts share a 90-second bound so Chromium background timer throttling
does not consume the entire lease. If an ACK arrives after a local timeout, it is accepted only from
the original owner to drain the durable outbox; the saved `ambiguous` outcome is never promoted to
`delivered`.

Diagnostic state is retained. Control Plane arrays and `.task` records contain shared production
and test relationships, so the command does not guess which historical records are safe to delete.

## Protocol and manual gate

Bridge protocol `2` adds `POST /delivery/claim` and `POST /delivery/ack`. Both retain Extension
Origin validation, protocol validation, bearer authentication, strict schemas, and the 64 KiB
request cap. `GET /hello` remains plain discovery. Protocol-1 identity-only extensions and bridges
are incompatible and receive/observe the existing fail-closed `426` behavior.

Automated tests cover state, claim ownership, receipt idempotency, restarts, composer protection,
epoch fencing, ACK loss, and ambiguous submit. Final acceptance still requires one real Edge gate:

1. Keep only the target ChatGPT conversation open and enqueue one test command.
2. Confirm exactly one new user message, capture its `message_id`, and verify the local receipt is
   `delivered` with the same `delivery_id`, `conversation_id`, and `message_id`.
3. Simulate ACK transport failure or restart LRM, then confirm the page still contains exactly one
   copy of that test message.
