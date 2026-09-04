# Errors

## [ERR-20260904-002] Vitest unsupported Jest parallel flag

**Priority**: low
**Status**: resolved
**Area**: tools

### 摘要

本项目通过 Vitest 执行测试；误传 Jest 的 `--runInBand` 参数会被 Vitest
拒绝，导致测试命令在收集测试前退出。

### 错误信息

```text
CACError: Unknown option `--runInBand`
```

### 上下文

- 执行了 `npm test -- --runInBand`
- 改用任务要求的 `npm test` 后完整测试通过

### 建议修复

遵循 `package.json` 中的 Vitest 脚本；需要调度选项时先查看当前 Vitest
版本支持的参数，不要套用 Jest CLI 参数。

### 元数据

- Reproducible: yes
- See Also: none

---

## [ERR-20260904-001] Launcher project venv execution permission

**Priority**: medium
**Status**: resolved
**Area**: tools

### 摘要

Launcher 的项目 venv 和其 `pyvenv.cfg` 中声明的 Python 3.11 基解释器都存在，
但直接执行时被 Windows 拒绝访问，导致测试进程无法创建。

### 建议修复

先验证 `sys.executable` 和版本；确认不是代码错误后，用同一个
`C:\Users\shaoy\Documents\PythonEnvs\local-review-launcher` 解释器在必要时提升权限重试，
不要改用 Codex bundled Python。

### 元数据

- Reproducible: yes
- See Also: none

---

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
