# P5.4.3 SessionStart Production Bootstrap

verdict: code PASS / live acceptance BLOCKED (hook trust + account quota; both external)
scope: production SessionStart hook runner + user-scope install/uninstall; no Desktop change, no pipe scanning
date: 2026-09-21 (Asia/Shanghai)
artifacts: .review/p5-4-3-sessionstart/

## 1. Delivered production code

    scripts/desktop-session-start-handoff.mjs       hook entry: imports the built dist runner (no build per session)
    src/desktop-codex/desktop-session-start-runner.ts
                                                   env gate + bounded handoff; statuses:
                                                   handoff_accepted | pipe_env_unavailable | host_unavailable |
                                                   handoff_rejected | timeout (stderr only)
    src/desktop-codex/desktop-hook-installer.ts     read-modify-write of the hook config, atomic rename, idempotent
    src/cli.ts                                      install-desktop-session-start-hook / uninstall-...
    tests/desktop-session-start-runner.test.ts      7 tests
    tests/desktop-hook-installer.test.ts            7 tests

Reused as-is: sendDesktopToolsPipeHandoff(), validateDesktopToolsPipePath(), loadSettings(), the existing
POST /launcher/desktop-tools-pipe endpoint and the Host handoff owner-binding. No re-implementation of post,
token, or pipe validation. The manual CLI (handoff-desktop-tools-pipe) is unchanged, including its npm script.

## 2. Code verification

    typecheck                                PASS
    build                                    PASS
    new tests (runner + installer)           14 PASS
    desktop-completion-observer              35 PASS
    desktop-first-turn-probe                 13 PASS
    desktop-codex-backend                    34 PASS
    desktop-tools-pipe-handoff (existing)    17 PASS
    git diff --check                         PASS (exit 0, CRLF warnings only)

Full-suite run (106 files) reported 12 files failing under parallel load: every one is
"Test timed out in 5000ms" plus "EBUSY: resource busy or locked, rmdir <temp>". Those same files pass when
run in isolation (git-tools, remote, workspace-tools, e2e/review-loop verified one by one). Pre-existing and
unrelated: tests/extension-identity.test.ts MAIN-world Fiber evidence (3 failures) fails identically in
isolation on unchanged code.

## 3. Hook install (user scope)

    target          C:\Users\shaoy\.codex\hooks.json      (workspace .codex/hooks.json untouched)
    existing hooks  preserved verbatim; deep-equal to the pre-install snapshot after uninstall
    idempotent      2nd install -> action "already_installed", still exactly one SessionStart entry
    uninstall       removed only the LRM entry; file compared deep-equal to hooks.before.json
    matcher         startup|resume|clear|compact
    command         only the runner path and the production config path (verified: no token, no pipe path)
    trust bypass    NOT used; [hooks.state] NOT written

## 4. Runner bounds and statuses (live)

    env present + live Host           handoff_accepted, exit 0, stdout empty
    host unreachable (port 1)         host_unavailable, exit 0, 0.82s
    listener that never answers       timeout, exit 0, 5.68s (runner self-bound 5s; hook config timeout 10s)
    env absent (scrubbed)             pipe_env_unavailable, exit 0, stdout empty, no request attempted
    stdout/stderr                     stdout empty in every case; the status goes to stderr only
    repeated trigger (x4)             4 handoff_accepted, one bounded POST per trigger, no state growth
    /launcher/desktop-interactive     ready:true, reason:null, pipeSource:"handoff"
    /launcher/desktop-tools-pipe/probe connected:true, handoff source, 44 tools, all 5 required tools present

## 5. Live automatic SessionStart: BLOCKED by hook trust

Observed: a real Codex session (codex exec, Desktop-owned shell environment) logged
"hook: SessionStart / hook: SessionStart Completed" - but that came from the already-trusted ponytail plugin
hook, not from the new user-scope entry.

Decisive experiment (no bypass flag): the installed entry was temporarily pointed at the P5.4.2 marker probe
(writes session-start-hook.json), the previous marker was moved aside, and a real Codex session was started.
Result: marker file NOT created -> the user-scope entry did not execute.

Corroboration: config.toml [hooks.state] tracks trust per hook entry
('...hooks.json:user_prompt_submit:0:0' etc. with trusted_hash and enabled=false); the new
session_start entry has no record, and no record was added by these runs. Hook stdout is unusable as evidence
(a shell redirection variant produced no log, and hook output is not surfaced), which is why the marker
approach was used.

Conclusion: hooks must be reviewed/trusted once in Codex before they run. Per the task, [hooks.state] is not
written by the installer and --dangerously-bypass-hook-trust is not used, so the automatic handoff cannot be
demonstrated until the user completes that one review.

## 6. Live interactive submit_goal: BLOCKED by account quota

Three runs through the real Desktop codex_app route (one via scripts/test_interactive_goal.mjs, two via the
diagnostic in this folder) all reached the same point: LRM submitted the goal, created the Desktop thread and
started the turn, then the Desktop-owned Codex turn ended as failed.

    persisted thread_id  yes (e.g. 01a0c374-29dc-77f3-ae71-ef48171e9fbc)
    persisted turn_id    yes (01a0c374-2afe-7611-acd2-4c4cadf97c2c)
    events               session_started -> turn_started -> execution_failed
    execution summary    "You've hit your usage limit. ... try again at Sep 23rd, 2026 11:13 AM"

So the routing, thread creation, turn start and durable failure projection all work; the model call itself is
stopped by the account usage limit, which is outside this change. Note the model recorded on the Session is
LRM submission metadata: the Desktop backend rejects explicit model/reasoning_effort.

Side effect: four Desktop threads titled "Interactive Codex app-server smoke test" were created by these runs.

## 7. Startup-order limitation (task item 10)

    A  Host running + SessionStart        blocked by hook trust (see section 5); mechanism proven in P5.4.2
    B  Host not running                   PASS: bounded exit in <1s, exit code 0, Codex sessions unaffected
    C  resume/clear/compact retrigger     re-attempts are safe and idempotent (runner test + unchanged Host
                                          accept semantics); live retry blocked by the same trust gate

Documented limitation: the hook only provides the capability while the event fires. If the LRM Host is not up
at SessionStart, nothing is handed over and no later Host start is picked up. Covered recovery is the next
SessionStart (resume/clear/compact or a new session). No pipe scanning, no polling, no cross-process env reads.

## 8. P5.4.3.1 Hook ownership safety

Ownership no longer comes from a substring or from the status message alone. The handler predicate now
requires the exact command shape the installer writes (quoted node, quoted
.../scripts/desktop-session-start-handoff.mjs, --config, quoted config), plus commandWindows, type
command, the LRM status message and the LRM timeout. The entry predicate additionally requires the LRM
matcher and exactly one handler, so a mixed entry is never claimed as a whole.

Discriminating check against the previous rule (fixtures -> old claims / new claims):

    A user "echo desktop-session-start-handoff"    true / false
    B reuse of the status message only             true / false
    C mixed entry, one look-alike handler          true / false
    C2 dedicated shape with matcher "startup"      true / false
    D entry created by this installer              true / true
    E hand-edited LRM command (+ flag)             true / false

Tests: 13 in tests/desktop-hook-installer.test.ts (6 new ownership cases A, B, C, C2, D, E).
Live check on the real user hooks file: the installed entry is still recognized, a re-install reports
already_installed, and the file content is unchanged (same short hash before and after).

## 9. Reported incident

Earlier in this session an accidental "git checkout src/desktop-codex/completion-observer.ts" discarded the
uncommitted P5.4.1 visibility-grace refinements in the working tree. They were restored from the diff captured
before the mistake; the restored file is byte-identical to the original (blob 4ea6da8), and the three tests
that had started failing pass again. The file is back to the user's own state; no other file was affected.

---

## P5.4.3.2 真实 Desktop SessionStart 现场诊断（追加，2026-09-21 19:35-19:44 CST）

结论分类：**A — production SessionStart 没有执行 LRM hook**

```text
P5.4.3.2 REAL SESSIONSTART DIAGNOSTIC: BLOCKED

hook actually executed:                 NO
pipe env present in real hook process:  NO（不适用：hook 进程从未创建，无可测量对象）
runner status:                          无（runDesktopSessionStartHandoff() 从未被调用）
handoff reached Host:                   NO
desktop-interactive after trigger:      ready:false, reason:desktop_tools_pipe_unavailable, pipeSource:null
root cause:                             用户级 C:\Users\shaoy\.codex\hooks.json 的 SessionStart entry
                                        在真实 Desktop 会话中未被 Codex 执行；同一批会话中插件 SessionStart
                                        hook 正常执行，说明 SessionStart 事件本身已触发
production fix applied:                 NO（按任务第 7 条，A 类根因不实施 hack）
temporary instrumentation removed:      YES
pipe/token persisted:                   NO
trust state changed:                    NO
Desktop modified:                       NO
commit/push:                            NONE
```

### 1. 实验设计（只改 wrapper 内容，command 不变）

`scripts/desktop-session-start-handoff.mjs` 临时插桩，只记录 timestamp / hook_started / hook_finished /
pid / ppid / cwd / 三个存在性布尔值 / 最终状态，append 到 `.review/p5-4-3-sessionstart/live-hook-marker.jsonl`。
不记录 pipe path、token、config.production.json 内容、prompt 或其它环境变量值。
hook command、matcher、timeout、statusMessage、hooks.json 内容与 `[hooks.state]` 均未修改，未使用
`--dangerously-bypass-hook-trust`，未重装 hook。

插桩版本 2（19:42 前生效）：先写 `hook_started` 再动态 import dist runner，即使模块加载失败也会留下 marker
行——排除“hook 执行了但 import 失败导致无记录”的盲区。

### 2. 实验前基线（GET 127.0.0.1:12080，Bearer 取自 config.production.json，未记录 token）

```text
19:35:18Z  /launcher/desktop-sync        connected:true, currentConversationId:01a0c3be-4ca8-7ba1-a80f-25aefe640ea8,
                                         ownerClientId 存在, fallbackReason:null, lastEventTime:11:33:46Z
19:35:18Z  /launcher/desktop-interactive ready:false, reason:desktop_tools_pipe_unavailable, pipeSource:null
```

旧 `live-hook-marker.jsonl` 不存在，无需删除（本轮为首次写入该 artifact）。

### 3. 触发（真实 Desktop session，非 PowerShell 直跑、非 codex exec）

三个真实 Desktop 会话均由 Desktop 自身创建，rollout 文件时间与触发时间对齐：

```text
触发  触发方式                        会话 thread / rollout                           结果
  -   本任务会话（对照）              01a0c3be-4ca8-7ba1-a80f-25aefe640ea8 / 19:33:43  ponytail 插件 SessionStart 已执行；
                                                                                      LRM 当时尚未插桩，不计入
  1   Desktop API 新建任务(worktree)  01a0c3c0-42c7-7553-b9ed-f3c15d5e2fbe / 19:35:52  marker 缺失
  2   Desktop API 新建任务            01a0c3c3-6820-7aa3-9733-ba8a028079d0 / 19:39:18  marker 缺失
  3   Desktop API 新建任务            01a0c3c5-efb4-7f63-b20c-772cf9ead7d5 / 19:42:04  marker 缺失（插桩版本 2）
```

`.ponytail-active` 重写时间 19:39:23 / 19:42:09，即 SessionStart 事件确实触发并执行了插件 hook。
19:42:33 检查 `.review/p5-4-3-sessionstart/live-hook-marker.jsonl`：**不存在**（不是存在但字段为空）。

### 4. 排除项（为什么是 A，而不是 B/C/D）

1. B/C/D 都要求 hook 进程存在；marker 文件自体不存在，该目录内没有任何本阶段新增行。
2. “Desktop hook 环境没有 node”被排除：ponytail 插件 SessionStart hook 的命令形式同样是裸 `node "<script>"`
   （`plugins/cache/ponytail/ponytail/4.10.0/hooks/claude-codex-hooks.json`），且在上述同一批会话中执行成功。
3. “SessionStart 事件没触发 / Desktop 完全不执行 hook”被排除：同一批会话中插件 SessionStart hook 正常执行。
4. 触发后 Host 状态未变：`/launcher/desktop-interactive` 仍 ready:false、reason:desktop_tools_pipe_unavailable、
   pipeSource:null（19:42:42Z），说明没有 handoff 到达 Host，也不存在“handoff accepted 后 capability 被清空”的 C 类路径。

### 5. 观察到的异常（根因线索，未取得确证）

```text
[hooks.state.'C:\Users\shaoy\.codex\hooks.json:user_prompt_submit:0:0']  trusted_hash + enabled = true
[hooks.state.'C:\Users\shaoy\.codex\hooks.json:stop:0:0']                trusted_hash + enabled = true
[hooks.state.'C:\Users\shaoy\.codex\hooks.json:session_start:0:0']       trusted_hash，缺少 enabled = true
```

同一文件另两个 entry 的 `hook_probe.py` 探针自 2026-08-30 起没有任何新输出（该 hooks.json 的整体执行状态可疑）；
`hooks.json` 最后一次写入 18:06:48。Desktop 侧 codex 为 0.155.0-alpha.9.2，PATH 上的 npm codex CLI 为 0.151.0，
两者 `[hooks.state]` 的写入方/语义可能不同——这一点本轮没有取得证据。

另外尝试复现 `trusted_hash` 计算方式（对两个已知 entry 做候选序列化哈希比对）失败，因此“trust hash 是否因后续
编辑而失效”本轮**没有证据**，不作为结论。

### 6. 遵守的禁止项

```text
named pipe enumeration / pipe name guessing      未使用
读取其它进程环境 / PEB                           未使用
修改 Desktop binary                              未使用
private backend fallback                         未使用
后台永久 polling                                 未使用
修改 hooks.json / command / matcher / timeout    未使用（只在 wrapper 内插桩，随后完全还原）
写 [hooks.state] / 重装 hook / trust bypass      未使用
interactive submit_goal 作为通过条件              未执行
commit / push                                    无
```

### 7. 本轮新增文件与副作用

```text
新增只读诊断脚本  .review/p5-4-3-sessionstart/live-check.mjs       launcher 状态读取（--probe 可选）
                  .review/p5-4-3-sessionstart/read-codex-logs.mjs  Codex 日志库只读检索
未保留的临时脚本   hook-trust-hash-probe.mjs, inspect-global-state.mjs（结论为阴性，已删除）
wrapper            scripts/desktop-session-start-handoff.mjs 已还原为 HEAD 原内容（git status 干净）
副作用            本次为触发真实会话创建了 3 个 Desktop 任务（用户可见，可自行归档）：
                  "P5.4.3.2 SessionStart trigger"（worktree，C:\Users\shaoy\.codex\worktrees\27a5\Local-Review-MCP）
                  "P5.4.3.2 SessionStart trigger"（projectless，01a0c3c3-6820-7aa3-9733-ba8a028079d0）
                  "P5.4.3.2 SessionStart trigger 2"（projectless，01a0c3c5-efb4-7f63-b20c-772cf9ead7d5）
```

### 8. 下一步（外部动作，非本轮 hack）

A 类根因意味着修复点在 Codex 的 hook 信任/启用状态，而不是 LRM 代码：需要确认该 SessionStart entry 在 Codex 中的
实际启用状态（`[hooks.state]` 记录是否与同文件其它 entry 一致），再重新触发真实 SessionStart 并复查
`/launcher/desktop-interactive` 是否为 ready:true / pipeSource:handoff。LRM 侧不需要、也不应为此增加任何 pipe 发现、
轮询或 fallback 机制。
