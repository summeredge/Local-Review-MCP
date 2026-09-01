# Errors

## [ERR-20260901-001] PowerShell deployment script binding

**Priority**: medium
**Status**: resolved
**Area**: tools

### 摘要

PowerShell 变量名不区分大小写。将脚本参数 `$Config` 复用为 JSON 对象变量
`$config` 使对象被参数的 `[string]` 类型强制转换，随后属性检查只看到了
`Length`。另外，将 `$null` 绑定到 `[string]$Body` 会得到空字符串；给 GET
请求设置空内容会触发 HttpClient 的谓词错误。

### 建议修复

脚本参数和解析后的对象使用不同名称，例如 `$configDocument`；只有在 body
非空时才设置 `HttpRequestMessage.Content`。部署脚本测试覆盖这两条路径。

### 元数据

- Reproducible: yes
- See Also: none

---

## [ERR-20260901-002] agent-reach Windows console encoding

**Priority**: low
**Status**: resolved
**Area**: tools

### 摘要

`agent-reach doctor --json` is unsupported by the installed CLI, and the
fallback `agent-reach doctor` failed under the default GBK PowerShell console
when its report contained Unicode characters.

### 建议修复

Use the installed command's supported syntax and set
`PYTHONIOENCODING=utf-8` for Windows CLI invocations that emit Unicode.

### 元数据

- Reproducible: yes
- See Also: none

---
