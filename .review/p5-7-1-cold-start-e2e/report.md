# P5.7.1 Cold-Start E2E (pre-submit gate)

verdict: **READY_FOR_EXTERNAL_SUBMIT**
scope: plugin install + trust, cold-start baseline, no-prewarming proof. No production code change,
no MCP change, no Desktop change, no commit/push. The external `submit_goal` is NOT executed here.
date: 2026-09-22 (Asia/Shanghai)
artifacts: .review/p5-7-1-cold-start-e2e/

## 1. LRM plugin installed and trusted

New local marketplace + plugin (minimal adaptation of the P5.7.0 probe shape):

    plugin/.agents/plugins/marketplace.json                       marketplace name "lrm-local"
    plugin/plugins/lrm-desktop-session-start/.codex-plugin/plugin.json
    plugin/plugins/lrm-desktop-session-start/hooks/hooks.json      SessionStart,
        matcher startup|resume|clear|compact, timeout 10,
        command: node "${CLAUDE_PLUGIN_ROOT}/hooks/lrm-session-start-handoff.mjs" "<LRM repo>"
    plugin/plugins/lrm-desktop-session-start/hooks/lrm-session-start-handoff.mjs
        delegates to runDesktopSessionStartHandoff(["--config", <repo>/config.production.json])

Installed with the existing CLI:

    codex plugin marketplace add <repo>/plugin   -> marketplaceName "lrm-local"
    codex plugin add lrm-desktop-session-start@lrm-local
        -> C:\Users\shaoy\.codex\plugins\cache\lrm-local\lrm-desktop-session-start\0.1.0

Trust (the P5.7.0 precondition, now satisfied explicitly):

    before: trustStatus "untrusted" (hook discovered + enabled, but not executed)
    action: added the exact key/hash from hooks/list to ~/.codex/config.toml [hooks.state]
    after:  trustStatus "trusted"

    key    lrm-desktop-session-start@lrm-local:hooks/hooks.json:session_start:0:0
    hash   sha256:ccb4e3716e9aa587e96a947dde4dbe516e4072b3f36e705d8e5b41b77ab3003f

No `--dangerously-bypass-hook-trust` was used. `codex plugin add` also recorded
`[plugins."lrm-desktop-session-start@lrm-local"] enabled = true` in the same config.
Evidence: hooks-list-census.trusted.json

## 2. Cold-start baseline (ready:false / pipeSource:null)

The LRM runtime process (pid 42948) was terminated; the existing Supervisor restarted it
(pid 54036 at 2026-09-22T04:38:51Z). No Desktop restart, no session restart, no hook re-trigger,
and no handoff was sent.

    /launcher/desktop-interactive   ready:false, reason:desktop_tools_pipe_unavailable, pipeSource:null
    /launcher/desktop-sync          connected:true, currentConversationId 01a0c718-...-4346
    POST /launcher/desktop-tools-pipe/probe   HTTP 409 desktop_tools_pipe_unavailable

The baseline held across six consecutive samples over ~10 s (cold-start-baseline.json) and again
at the end of this phase (cold-start-baseline-final.json). Desktop itself was connected the whole
time, so the blocked state is exactly the missing tools-pipe capability.

## 3. No prewarming

`DesktopToolsPipeResolver` fails closed only when (a) no verified handoff capability is held and
  (b) no CODEX_APP_TOOLS_PIPE_PATH was inherited. With `connected:true` already proven, a
`desktop_tools_pipe_unavailable` result can only come from both conditions being true.

    handoff capability held:  NO  (probe 409, pipeSource null)
    environment pipe value:   NO  (LRM runtime inherited none)
    prewarming:               NONE

Evidence: no-prewarming-evidence.json

## 4. Stop point

    READY_FOR_EXTERNAL_SUBMIT

Steps 1-3 are complete and verified. This task stops here: the single external `submit_goal` is
performed by the operator through the Local MCP Connector, not by this task.

## 5. Footprint

    production code changed:  NO (src/, scripts/, tests/ untouched)
    MCP tools changed:        NO
    Desktop / app.asar:       NO
    new files:                plugin/** (new local marketplace + plugin), .review/p5-7-1-cold-start-e2e/**
    config.toml:              + [marketplaces.lrm-local], + [plugins."lrm-desktop-session-start@lrm-local"],
                              + [hooks.state."lrm-desktop-session-start@lrm-local:..."]
                              (backup kept at ~/.codex/config.toml.lrm-backup)
    commit / push:            NONE
