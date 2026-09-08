# Errors

## [ERR-20260908-005] 异步 execution context 直接覆盖造成截断 JSON

**Priority**: medium
**Status**: resolved
**Area**: tools

### 摘要

Completion close 回调更新 `ExecutionContext` 时，直接覆盖现有 JSON 文件会让并发读取短暂看到不完整内容。

### 错误信息

```text
Error: Execution context "execution-close" is invalid.
Caused by: SyntaxError: Unexpected end of JSON input
```

### 上下文

- Codex execution completion close 集成测试
- completion service 异步写入 terminal `ExecutionContext`

### 建议修复

更新 durable execution context 时先写同目录临时文件，再使用原子 `rename` 替换目标文件。

### 元数据

- Reproducible: yes
- See Also: none

---

## [ERR-20260908-004] Restarted receipt comparison used JSON property order

**Priority**: medium
**Status**: resolved
**Area**: tools

### 摘要

重启后 Zod 恢复会按 schema 顺序重建 receipt；使用 `JSON.stringify` 比较
同一 ACK 会把字段顺序变化误判为冲突，阻断 lost-ACK replay。

### 错误信息

```text
Error: conflicting delivery receipt
```

### 上下文

- Dispatch Command Broker 的 lost-ACK 重启回归测试
- 第一次 ACK 已持久化，重启后的相同 ACK 被拒绝

### 建议修复

对 durable receipt 比较稳定字段和值，不比较 JSON 属性顺序。

### 元数据

- Reproducible: yes
- See Also: none

---

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

## [ERR-20260908-001] 技能路径拼接错误

**Priority**: low
**Status**: resolved
**Area**: tools

### 摘要

把两个技能根目录用 `..` 手工拼接，导致 `karpathy-guidelines/SKILL.md` 路径不存在。

### 错误信息

```text
Get-Content: Cannot find path '...\agents\skills\karpathy-guidelines\SKILL.md'
```

### 建议修复

直接使用技能目录表给出的根路径，不跨技能根目录拼接相对路径。

### 元数据

- Reproducible: yes
- See Also: ERR-20260907-003

---

## [ERR-20260908-002] ZodEffects 不支持 pick

**Priority**: low
**Status**: resolved
**Area**: tools

### 摘要

对经过 `superRefine()` 的 Zod schema 调用 `pick()` 导致 TypeScript 类型检查失败。

### 错误信息

```text
Property 'pick' does not exist on type 'ZodEffects<ZodObject<...>>'.
```

### 建议修复

需要选取字段时在 `superRefine()` 前保留基础 object schema，或为独立输入声明最小 schema。

### 元数据

- Reproducible: yes
- See Also: none

---

## [ERR-20260908-003] Windows 全套 Vitest 并发导致超时和 EBUSY

**Priority**: low
**Status**: resolved
**Area**: tools

### 摘要

全套 Vitest 默认并发时，多个 Git/临时目录测试超过 5 秒并在清理时返回 EBUSY；同一批失败文件以单 worker 重跑全部通过。

### 错误信息

```text
Test timed out in 5000ms
EBUSY: resource busy or locked, rmdir '...\AppData\Local\Temp\local-review-mcp-...'
```

### 建议修复

先用 `--maxWorkers=1` 原样重跑失败文件区分 Windows 并发资源争用与代码回归，不要直接修改测试超时。

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

## [ERR-20260907-003] computer-use 参考文档路径猜测

**Priority**: low
**Status**: resolved
**Area**: tools

### 摘要

按记忆猜测 computer-use skill 的 `confirmations.md` 位于 skill 根目录，实际路径不存在；本任务不需要继续读取该文件。

### 错误信息

```text
Get-Content: Cannot find path '...\\computer-use\\confirmations.md'
```

### 建议修复

需要读取 skill 参考文档时先列出 skill 目录或使用已确认的引用路径，不要猜测文件位置。

### 元数据

- Reproducible: no
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
