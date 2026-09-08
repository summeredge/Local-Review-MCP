# Learnings

## [LRN-20260907-002] 真实 ChatGPT Fiber 的会话身份位于 turn 同级 conversation

**Priority**: high
**Status**: resolved
**Area**: tools

### 内容

真实 ChatGPT conversation-turn 的 section Fiber 需要沿 `return` 链到 turn-level
model 才能读取 `turn.messages`；当前页面的会话身份位于同一 props 的
`conversation.id`，而 flat/thread identity 字段可能不存在。

### 建议修复

沿 COS 的 bounded turn traversal 提取消息与全部可见 identity 字段，并在字段
矛盾时 fail closed；不要从 DOM 或 tool row 推测 conversation/request identity。

### 元数据

- Source: task_review
- See Also: none

---

## [LRN-20260905-001] Browser Worker 导航测试应 mock 页面但保留 Profile 边界

**Priority**: low
**Status**: resolved
**Area**: infra

### 内容

Conversation Navigator 可以通过注入 `PersistentContextLauncher` 使用 mock `BrowserContext` 和 `Page`，从而验证 URL、`page.goto()` 和失败状态而不访问 ChatGPT；但 `BrowserProfileManager` 仍会先创建受控 Profile 目录，这是生命周期契约的一部分。受限 sandbox 无法写默认本机目录时，应在验证层提升该目录访问，而不是为测试绕过 Profile Manager。

### 建议修复

保持生产调用链为 `BrowserWorker → BrowserProfileManager → Persistent Browser Context → ConversationNavigator → Page.goto()`；诊断和单元测试只替换 launcher/page，并单独确认 Profile 路径权限。

### 元数据

- Source: task_review
- See Also: none

---

## [LRN-20260904-001] Task Context 保持独立于 Workspace 与 MCP

**Priority**: medium
**Status**: resolved
**Area**: infra

### 内容

在只读 Review Data Plane 中加入未来任务元数据时，最小安全边界是把
Task Context 作为独立内部数据层：使用用户级应用状态目录持久化，保存
`task_id`、`workspace_id` 和可选 `conversation_id`，不接入 MCP 注册、
Workspace Registry 变更或 C2C Session 状态机。这样同一 workspace 可以有
多个 task，conversation 也不会被 workspace 固定绑定。

### 建议修复

后续 Execution Context 扩展应沿用该边界；只有明确的读取场景、权限和
兼容性契约都确定后，才评估增加只读 MCP 投影。

### 元数据

- Source: task_review
- See Also: none

---

## [LRN-20260901-001] MCP OAuth discovery compatibility

**Priority**: medium
**Status**: resolved
**Area**: tools

### 内容

MCP clients derive protected-resource metadata from the configured `/mcp`
endpoint, so both the path-specific metadata URL and the root compatibility
alias should be served. A 401 response must also point to the path-specific
metadata URL through `WWW-Authenticate: Bearer resource_metadata=...`.

### 建议修复

When adding OAuth to a raw Node HTTP server, keep the resource identifier bound
to the exact MCP path, advertise only the supported public-client flow, and
validate the completed flow with the installed MCP SDK discovery parser.

### 元数据

- Source: task_review
- See Also: none

---

## [LRN-20260901-002] OAuth DCR grant compatibility

**Priority**: medium
**Status**: resolved
**Area**: tools

### 内容

ChatGPT Connector 的 DCR 请求可能同时声明 `authorization_code` 和
`refresh_token`。兼容请求 metadata 不等于启用额外授权流；服务端应确认请求
包含自身支持的 grant，并在注册结果和 token endpoint 继续只暴露
`authorization_code` + PKCE。

### 建议修复

对 DCR metadata 允许兼容客户端声明的额外 grant，但把注册客户端能力归一化
为服务端实际实现的授权流，并用真实 connector payload 覆盖回归测试。

### 元数据

- Source: task_review
- See Also: LRN-20260901-001

---

## [LRN-20260907-001] Bridge hello discovery must stay preflight-free

**Priority**: medium
**Status**: resolved
**Area**: tools

### 内容

LRM 的 `GET /hello` 是 protocol exception：它返回 protocol 用于 discovery，但不要求
`x-lrm-bridge-protocol` 请求头。给这个 GET 添加自定义 header 会触发浏览器 CORS
preflight，而当前 `/hello` 不处理 `OPTIONS`，导致真实扩展无法完成 discovery。

### 建议修复

扩展 discovery 对 `/hello` 只发送无自定义 header 的 GET，并严格检查响应中的
`service` 与 `protocol`；`/pair` 和已认证 POST 再发送 protocol header。

### 元数据

- Source: task_review
- See Also: none

---

## [LRN-20260908-001] Exact waiter tests must prove unrelated evidence does not resolve

**Priority**: medium
**Status**: resolved
**Area**: infra

### 内容

测试 request-scoped late-evidence waiter 时，如果依次发送 R2、R1 后才断言 R1 的最终
结果，即使 R2 错误地唤醒了 R1，随后写入的 R1 owner 也可能让最终 lookup 看起来正确，
形成假阳性。

### 建议修复

在发送目标 R1 evidence 前，用 `Promise.race` 明确断言 R2 evidence 后 R1 waiter 仍为
pending；再发送 R1 并断言返回 exact owner。

### 元数据

- Source: task_review
- See Also: none

---
