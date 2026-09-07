# Errors

## [ERR-20260905-002] Browser Worker profile path sandbox permission

**Priority**: low
**Status**: resolved
**Area**: tools

### 摘要

Browser Worker 测试和诊断使用默认的本机 Profile 根目录；受限 sandbox 无法创建该目录，导致 Playwright 启动和 mock context 测试分别返回 `spawn EPERM` 与 `mkdir EPERM`。

### 错误信息

```text
browserType.launchPersistentContext: spawn EPERM
EPERM: operation not permitted, mkdir '...\\LocalReviewMCP\\browser-worker\\profiles\\...'
```

### 上下文

- 执行了 `npm test` 与 `npx vitest run tests/conversation-navigator.test.ts`
- 失败只发生在受限 sandbox；允许访问本机 Profile 路径后同一测试通过

### 建议修复

在受限环境中运行 Browser Worker 测试时，为 Profile 根目录提供可写临时目录，或申请最小范围的本机目录访问；不要把 Codex bundled runtime 当作项目运行时。

### 元数据

- Reproducible: yes
- See Also: none

---

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

## [ERR-20260905-001] Current checkout Git ownership during runtime smoke test

**Priority**: low
**Status**: resolved
**Area**: tools

### 摘要

The runtime smoke test against the current checkout was rejected by Git's
`safe.directory` ownership check because the repository owner and the sandbox
process user differ.

### 建议修复

Use a temporary test repository owned by the test process for Git behavior
checks; do not change global Git configuration just for a read-only smoke test.

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

## [ERR-20260907-001] npm diagnostic script name

**Priority**: low
**Status**: resolved
**Area**: tools

### 摘要

误将 package.json 中带冒号的诊断脚本写成了不带冒号的名称，命令在执行前即返回
`Missing script`。

### 错误信息

```text
npm error Missing script: "diagnose-conversation-routing"
npm error Did you mean: npm run diagnose:conversation-routing
```

### 上下文

- 任务验证阶段执行了 `npm run diagnose-conversation-routing`、`npm run diagnose-review-delivery` 和 `npm run diagnose-review-verdict`
- package.json 实际脚本名是 `diagnose:conversation-routing`、`diagnose:review-delivery` 和 `diagnose:review-verdict`

### 建议修复

执行诊断前先从 package.json 或 `npm run` 读取脚本名，保留脚本中的冒号。

### 元数据

- Reproducible: yes
- See Also: none

---

## [ERR-20260907-002] rg Windows glob argument

**Priority**: low
**Status**: resolved
**Area**: tools

### 摘要

在 PowerShell 中把 `extension/*.js` 直接作为 `rg` 路径传入时，`rg` 将其视为
literal path，返回 Windows `os error 123`。

### 错误信息

```text
rg: extension/*.js: 文件名、目录名或卷标语法不正确。 (os error 123)
```

### 上下文

- 最终扩展边界扫描执行了 `rg ... extension/*.js extension/manifest.json`
- 改为从目录扫描并用 `-g '*.js'` 过滤后通过

### 建议修复

Windows 下使用 `rg -g '*.js' <directory>`，不要依赖 shell 展开路径通配符。

### 元数据

- Reproducible: yes
- See Also: none

---
