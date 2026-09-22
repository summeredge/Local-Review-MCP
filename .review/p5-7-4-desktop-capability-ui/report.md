# P5.7.4 LRM UI: Desktop handoff capability 状态

verdict: **DONE**
date: 2026-09-22 (Asia/Shanghai)
scope: 只改 launcher 的只读状态读取与显示。本轮 `src/` 零改动：DesktopToolsPipeHandoff、
SessionStart hook、resolver、DesktopCodexBackend、execution flow 全部未动。
artifacts: .review/p5-7-4-desktop-capability-ui/

## 1. 修改文件

    LocalReviewLauncher/status_checker.py
        + LOCAL_DESKTOP_INTERACTIVE_URL
        + @dataclass(frozen=True) DesktopCapabilityStatus(ready: bool, pipe_source: str | None)
        + LauncherStatus.desktop_capability（fail-closed 默认 Unavailable / none）
        + StatusChecker(desktop_capability_url=...) / desktop_capability_status()
    LocalReviewLauncher/status_worker.py
        与 desktop_sync 同一次刷新读取 capability；探测失败即回落到默认值
    LocalReviewLauncher/gui.py
        Desktop Sync 状态区追加 capability 块（三个分支都追加）
    LocalReviewLauncher/test_status_worker.py, LocalReviewLauncher/test_gui.py
        新增 capability 用例；更新两处 Desktop 块的精确文本断言
    docs/launcher-dashboard.md
        "Desktop Capability status" 小节，说明与 Desktop IPC 的区别

## 2. UI 新增字段

`.review/p5-7-4-desktop-capability-ui/ui-render.txt`（真实 worker → checker → render 路径）：

    Connected                     |  Connected
    Mode: Auto                    |  Mode: Auto
    Source: Desktop IPC           |  Source: Desktop IPC
    Conversation: ...             |  Conversation: ...
    Following: Yes                |  Following: Yes
    Owner: ...                    |  Owner: ...
    Last Event: 22:15:39          |  Last Event: 22:15:39
    Association: Unmatched        |  Association: Unmatched
                                  |
    Desktop Capability: Ready     |  Desktop Capability: Unavailable
    Source: handoff               |  Source: none

## 3. 数据来源

    GET /launcher/desktop-interactive   （既有 endpoint，loopback + Bearer token）
        -> ready / reason / pipeSource
        -> DesktopInteractivePreflight -> DesktopToolsPipeResolver -> DesktopToolsPipeHandoff

* 未新增状态存储、未新增 handoff 通道、未触碰 accept 流程与 resolver 逻辑。
* `ready=true` 时只接受 `handoff` 与 `current_environment` 两个既有来源；其余（缺字段、
  类型不符、ready=false 却带来源、未知来源、请求失败）一律 fail closed 为 Unavailable / none。
* 刷新沿用既有 5s 状态 worker（`window.timer.interval() == 5000`），与 Desktop Sync 同一周期。

## 4. 测试结果

    LocalReviewLauncher$ python -m unittest test_status_worker                       31 tests OK
    LocalReviewLauncher$ python -m unittest test_gui.LauncherLogTests                10 tests OK
    LocalReviewLauncher$ python -m unittest test_gui.LauncherDashboardTests           8 tests OK
    （解释器：C:\Users\shaoy\Documents\PythonEnvs\local-review-launcher\Scripts\python.exe，
      PySide6 6.11.2）

新增用例：capability 端点解析 + Bearer + URL、`current_environment` 来源区分、6 类不一致响应
fail closed、worker 仅在 mcp_running 时探测、GUI Ready/handoff 与 Unavailable/none 渲染。

Case 3（不影响执行链）：

    git status  本轮只有 LocalReviewLauncher/** 与 docs/launcher-dashboard.md
    npx vitest run tests/desktop-interactive-preflight.test.ts
                   tests/desktop-tools-pipe-handoff.test.ts
                   tests/desktop-tools-pipe-resolver.test.ts     34 tests passed

未执行 `submit_goal`：本次改动不经过任何 MCP 工具或执行路径，`src/` 无改动即为其证据。

## 5. 备注

* 正在运行的 launcher GUI 进程仍持有旧代码，需要重启 launcher 才会显示新块（LRM runtime 无需重启）。
* 组合运行 `test_status_worker test_gui` 会在退出阶段崩溃（0xC0000409）；用 HEAD 版本复现同样崩溃，
  单个测试类分开运行全部通过，属既有环境问题。
* 运行测试会重新生成已纳入版本库的 `LocalReviewLauncher/__pycache__/*.pyc`。
