# P5.7.2 合并 Desktop SessionStart Hook 注册路径

verdict: **DONE**（注册层面已验证；下一次真实 SessionStart 的冷启动观察留给操作者）
date: 2026-09-22 (Asia/Shanghai)
scope: 只合并两套 Desktop SessionStart handoff 注册。未改动 runner / resolver / backend /
binding / observer，未改动 plugin 内容，未使用 `--dangerously-bypass-hook-trust`。
artifacts: .review/p5-7-2-hook-consolidation/

## 1. 唯一保留入口（未修改一个字节）

    plugin/plugins/lrm-desktop-session-start/.codex-plugin/plugin.json   "hooks": "./hooks/hooks.json"
    plugin/plugins/lrm-desktop-session-start/hooks/hooks.json            SessionStart,
        matcher startup|resume|clear|compact, timeout 10,
        command: node "${CLAUDE_PLUGIN_ROOT}/hooks/lrm-session-start-handoff.mjs" "<LRM repo>"
    plugin/plugins/lrm-desktop-session-start/hooks/lrm-session-start-handoff.mjs
        -> runDesktopSessionStartHandoff(["--config", <repo>/config.production.json])
           -> sendDesktopToolsPipeHandoff()

plugin 已经是目标形态（matcher 与 handoff 调用链完全符合要求），因此本阶段没有对 plugin 做任何修改。

## 2. 新增的安全迁移

`src/desktop-codex/desktop-hook-installer.ts`：

    migrateLrmSessionStartHookRegistration({ hooksFilePath?, configPath? })

* hooks.json 半部分复用既有 ownership 判定（`uninstallLrmSessionStartHook`）：只删除
  matcher + 单 handler + statusMessage + timeout + 命令形状全部匹配的专用 entry；
  删除后其余 entry 与 `description` 原样保留，原子写回，不整文件覆盖。
* config.toml 半部分只删除 `[hooks.state.'<该 hooks.json>:session_start:N:N']` 表：逐行编辑，
  其他表、注释、格式保持逐字节不变；写前留 `config.toml.<ts>.lrm-backup`。
* 旧 key 以其它形态出现（例如 `<key> = { ... }` 内联表）时 fail-closed 返回
  `trust_state_not_migrated: unsupported_hooks_state_shape`，不静默留下残留 trust。
* 幂等：第二次运行返回 `already_migrated`，不写文件、不再产生备份。
* CLI：`node dist/src/cli.js migrate-desktop-session-start-hook` / `npm run migrate:desktop-session-start-hook`。

## 3. 实机迁移结果

迁移前 dry-run（`dry-run.mjs`，对真实文件副本执行）与真实执行结果一致：

    {
      "ok": true, "action": "migrated",
      "hooksFilePath": "C:\\Users\\shaoy\\.codex\\hooks.json",
      "configPath":    "C:\\Users\\shaoy\\.codex\\config.toml",
      "removedHookEntries": 1,
      "removedTrustStateKeys": ["C:\\Users\\shaoy\\.codex\\hooks.json:session_start:0:0"],
      "configBackupPath": "C:\\Users\\shaoy\\.codex\\config.toml.1790081915918.lrm-backup"
    }

用户配置迁移结果：

* `~/.codex/hooks.json`：事件只剩 `UserPromptSubmit`、`Stop`（hook_probe），`description` 保留；
  LRM SessionStart entry 已删除。
* `~/.codex/config.toml`：349 -> 345 行，仅删除 4 行（旧 trust 表头、`trusted_hash`、
  `enabled`、空行），无新增行；其余内容逐字节一致（`before/` 副本对照）。

trust 状态变化：

* 删除：`C:\\Users\\shaoy\\.codex\\hooks.json:session_start:0:0`
* 保留：`...hooks.json:user_prompt_submit:0:0`、`...hooks.json:stop:0:0`
* 保留：`lrm-desktop-session-start@lrm-local:hooks/hooks.json:session_start:0:0`（plugin，trusted）
* 未使用 `--dangerously-bypass-hook-trust`。

## 4. 验收证据

    hooks-list-census.json   codex app-server hooks/list（只读，未执行 hook）

    cwd groups: 1  -> C:\\Users\\shaoy\\Documents\\Local-Review-MCP
      sessionStart hooks: 2
        plugin lrm-desktop-session-start@lrm-local   trusted, enabled, matcher 保留
        plugin ponytail@ponytail                     trusted, enabled（无关激活 hook，未改动）
      statusMessage "LRM Desktop session-start handoff" 的 hook: 仅 lrm-desktop-session-start@lrm-local

* Case 1（单次 handoff）：SessionStart 只有一条 LRM handoff 注册 -> 一次执行。
  真实冷启动观测需要新的 Codex 会话，由操作者在下一次 SessionStart 确认。
* Case 2（唯一可诊断链路）：`hooks/list` 唯一命中 plugin hook + statusMessage；
  runner 的 `statusMessage`/stderr 是执行侧诊断面（runner 未改动）。
* Case 3（其他用户 hook 不受影响）：hooks.json 的 probe hook 与 config.toml 中其他 trust 表均保留；
  `tests/desktop-hook-installer.test.ts` 覆盖该场景。

## 5. 测试

    npx tsc --noEmit -p tsconfig.json          PASS
    npm run build                              PASS
    npx vitest run tests/desktop-hook-installer.test.ts   17 passed (含 4 个迁移用例)
    npx vitest run (全量)                       8 files / 11 tests failed，全部为
                                               5000ms 超时与 Windows EBUSY 临时目录清理，
                                               两次运行失败集合不同；单独运行同一文件全部通过。

## 6. 残留

* 用户目录不再有任何 LRM SessionStart 注册；旧 `lrm-probe` marketplace/plugin 未在 config.toml 中，
  插件缓存只剩 `lrm-local/lrm-desktop-session-start`。
* 仍然存在（未要求删除）：`~/.codex/hooks.json` 的 probe hooks、`config.toml.lrm-backup`
  （P5.7.1 更早的备份）。
* 用户级写入口已删除（见第 7 节）：没有任何生产代码会再向 `~/.codex/hooks.json` 写 SessionStart entry。

## 7. 收尾：安装路径单入口化

`installLrmSessionStartHook()` 不再写 `~/.codex/hooks.json`，改为只读检查并返回状态：

    { ok, action: "plugin_hook_present" | "plugin_hook_missing", hooksFilePath, pluginHooksFilePath,
      pluginHookPresent, migrationRequired, error? }

* `ok` = plugin hook 存在 且 无遗留 user entry（"单入口已满足"）。
* plugin hook 判定：`plugin/plugins/lrm-desktop-session-start/hooks/hooks.json` 内存在 matcher
  `startup|resume|clear|compact` 且 handler 命令指向 `hooks/lrm-session-start-handoff.mjs` 的 entry。
* 命令：`node dist/src/cli.js desktop-session-start-hook-status`（旧名
  `install-desktop-session-start-hook` 保留为别名），npm：`npm run status:desktop-session-start-hook`。
* 迁移能力保留不变：`migrate-desktop-session-start-hook`（hooks.json entry + trust state）。

实机验证（本轮）：

    status                              ok:true plugin_hook_present migrationRequired:false
    hooks.json    (status 前后 sha256)   不变
    config.toml   (status 前后 sha256)   不变
    plugin hooks.json sha256            不变
    migrate 重跑                        already_migrated，无新备份
    hooks/list census                   唯一 handoff 注册 = lrm-desktop-session-start@lrm-local (trusted)

测试：`tests/desktop-hook-installer.test.ts` 18 passed（覆盖 Case 1/2/3）；全量 vitest 的失败仍为
5s 超时与 EBUSY 临时目录，代表文件单独运行 64/64 通过。
