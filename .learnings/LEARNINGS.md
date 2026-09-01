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
