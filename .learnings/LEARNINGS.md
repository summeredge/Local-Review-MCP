# Learnings

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
