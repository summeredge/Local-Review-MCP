# P5.7.3 SessionStart Hook 单入口迁移验证

verdict: **HOOK_SINGLE_SOURCE: PASS**
date: 2026-09-22 (Asia/Shanghai)
scope: 只执行迁移与验证。本轮未改动任何源码：DesktopToolsPipeHandoff / resolver / backend /
execution flow / plugin hook 全部保持原样（plugin 文件 mtime 仍为 12:01）。
artifacts: .review/p5-7-3-hook-single-source-verification/

## 1. 迁移执行

    node dist/src/cli.js migrate-desktop-session-start-hook
    { ok: true, action: "already_migrated", removedHookEntries: 0, removedTrustStateKeys: [] }

清理在第 1 轮已完成，本轮为幂等重跑：两个文件 sha256 前后一致，无新备份。

## 2. 用户级 hooks.json

    path                 C:\Users\shaoy\.codex\hooks.json
    events               UserPromptSubmit, Stop
    SessionStart entries 0（LRM owned = 0）
    其他 hook             两个 probe hook 命令逐字保留

## 3. trust state

    user session_start 键   []            （已删除）
    user 其他键             user_prompt_submit:0:0, stop:0:0（保留）
    plugin 键               lrm-desktop-session-start@lrm-local:hooks/hooks.json:session_start:0:0（保留）

## 4. runtime 重启与冷启动

    supervisor.log   14:05:31.040 runtime stopped
                     14:05:31.041 restart triggered
                     14:05:31.077 runtime started
    runtime pid      8908 -> 33200

重启后 5 次采样（14:05:37 - 14:05:46）+ 每次间隔 2s：

    ready=false  reason=desktop_tools_pipe_unavailable  pipeSource=null  desktop connected=true

## 5. 真实 SessionStart

    触发方式   codex exec --json "Reply with exactly: HOOK-TRIGGER-OK"（真实 Codex session 生命周期）
    事件       {"type":"thread.started","thread_id":"01a0c970-01ec-7650-a225-fcda0a74733a"}
               turn.started -> agent_message "HOOK-TRIGGER-OK" -> turn.completed
    rollout    ~/.codex/sessions/2026/09/22/rollout-2026-09-22T22-05-56-01a0c970-....jsonl

未使用 handoff CLI、未手工 POST endpoint、未使用测试探针。

## 6. handoff 来源

    14:06:18  ready=true  pipeSource="handoff"  desktop connected=true
    14:06:42  ready=true  pipeSource="handoff"（稳定性复采样）

唯一性证据链：

* hooks/list（captured after the trigger）：sessionStart 注册只有
  `lrm-desktop-session-start@lrm-local`（trusted / enabled / matcher startup|resume|clear|compact）
  与无关的 `ponytail@ponytail`；user hooks.json 已无 SessionStart 注册。
* `pipeSource="handoff"` 只能由 `POST /launcher/desktop-tools-pipe` 成功受理产生
  （`DesktopToolsPipeHandoff.accept`）；生产端唯一调用者是
  `sendDesktopToolsPipeHandoff()`（hook runner）。
* 冷启动窗口（14:05:46 仍为 null）内唯一发生的事件是新 Codex session（14:05:55-14:06:01）。

## 7. 判断

    HOOK_SINGLE_SOURCE: PASS
