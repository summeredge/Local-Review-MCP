# P5.7.0 LRM Plugin SessionStart Capability Probe

verdict: **PASS**
scope: plugin-bundled SessionStart hook PoC only; no production code change, no new MCP, no Desktop/asar change
date: 2026-09-22 (Asia/Shanghai)
artifacts: .review/p5-7-0-plugin-sessionstart/

## 0. Deliverable lines

    P5.7.0 PLUGIN SESSIONSTART CAPABILITY PROBE: PASS

    plugin SessionStart executed:      YES
    CODEX_APP_TOOLS_PIPE_PATH visible: YES
    handoff accepted:                  YES
    Host ready after handoff:          YES
    pipeSource:                        handoff
    codex_app tools probe:             PASS
    production code changed:           NO
    third MCP added:                   NO
    commit/push:                       NONE

    next: P5.7.1 cold-start E2E

## 1. Reference plugin used (real, already-executing)

Ponytail 4.10.0, installed and enabled, and the only plugin SessionStart hook proven to run in real
Desktop sessions (it rewrites .ponytail-active on every session start).

    plugin root      C:\Users\shaoy\.codex\plugins\cache\ponytail\ponytail\4.10.0
    manifest         .codex-plugin/plugin.json
    manifest hooks   "hooks": "./hooks/claude-codex-hooks.json"
    hook file        hooks/claude-codex-hooks.json
    event name       "SessionStart"
    matcher          "startup|resume|clear|compact"
    handler          { "type": "command",
                       "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/ponytail-activate.js\"",
                       "timeout": 5,
                       "statusMessage": "Loading ponytail mode..." }

So the currently recognized shape is: .codex-plugin/plugin.json -> hooks -> {"hooks": {"SessionStart":
[{matcher, hooks:[{type:"command", command, timeout, statusMessage}]}]}}, with the plugin root exposed
to the command through the ${CLAUDE_PLUGIN_ROOT} placeholder. The LRM probe is a minimal adaptation of exactly
this shape; nothing about the schema was re-invented.

## 2. LRM probe plugin (actual structure)

    .review/p5-7-0-plugin-sessionstart/lrm-probe/.agents/plugins/marketplace.json   local marketplace "lrm-probe"
    .review/p5-7-0-plugin-sessionstart/lrm-probe/plugins/lrm-desktop-session-start-probe/
      .codex-plugin/plugin.json    name/version/description/author/license + "hooks": "./hooks/hooks.json"
      hooks/hooks.json             SessionStart, matcher startup|resume|clear|compact,
                                   command: node "<CLAUDE_PLUGIN_ROOT>/hooks/lrm-session-start-handoff.mjs" "<LRM repo>"
                                   timeout 10, statusMessage "LRM Desktop session-start capability probe"
      hooks/lrm-session-start-handoff.mjs   the only new logic (see section 3)

Installed with the existing CLI, then removed again at the end:

    codex plugin marketplace add <...>/lrm-probe               -> marketplaceName "lrm-probe"
    codex plugin add lrm-desktop-session-start-probe@lrm-probe -> installed into the plugin cache

The LRM repository root is passed as a hook argument because the installed plugin lives in the Codex
plugin cache; the wrapper never guesses the repository location from its own path.

## 3. Hook implementation (no re-implementation)

hooks/lrm-session-start-handoff.mjs does two things only:

1. writes one minimal marker line before any business logic;
2. await import(<repo>/dist/src/desktop-codex/desktop-session-start-runner.js) and calls
   runDesktopSessionStartHandoff(["--config", <repo>/config.production.json])
   -> existing sendDesktopToolsPipeHandoff().

No pipe validation, bearer request, handoff HTTP call, timeout, or Host capability code was
re-implemented. The wrapper is the smallest possible adapter around the existing chain.

Marker artifact: .review/p5-7-0-plugin-sessionstart/live-marker.jsonl (JSONL, append-only).
Recorded fields are exactly: timestamp, phase (hook_started / hook_finished), pid, ppid, the boolean
"CODEX_APP_TOOLS_PIPE_PATH is non-empty", the final handoff status, and the exit status.
Never recorded: the pipe path value, any token, config contents, other environment variables, prompts,
or user data.

## 4. Real Desktop trigger

Trigger: a real ChatGPT Desktop codex_app create_thread call (Desktop created the thread and started
the turn itself) - not a manual PowerShell run, not codex exec, not a Node script, not a unit test,
not a direct handoff sender.

    thread id     01a0c6d3-7bee-79d2-80a9-f3cb0bc154d4
    title         P5.7.0 LRM plugin SessionStart probe (trusted)
    project       Local-Review-MCP (local environment)

Cross-check that SessionStart really fired in that session: the trusted ponytail plugin hook rewrote
plugins/data/ponytail-ponytail/.ponytail-active at 2026-09-22T01:55:46.213Z, 4 ms before the LRM
marker's hook_started (01:55:46.217Z). Both plugin hooks ran in the same SessionStart.

## 5. Host state before the trigger

The LRM Host was restarted first (Supervisor restarted the runtime at 01:55:11Z) so no handoff
capability from any earlier run could be reused. Then the baseline was read from the existing
read-only launcher endpoints (Bearer token from config.production.json; token and pipe path never
recorded):

    /launcher/desktop-sync        connected:true, ownerClientId present,
                                  currentConversationId:01a0c6a5-883f-7ce0-a056-1c5f794b6814
    /launcher/desktop-interactive ready:false, reason:desktop_tools_pipe_unavailable, pipeSource:null
    probe marker                  absent

So before the trigger the Host genuinely had no Desktop tools-pipe capability.
(artifact: host-state-before-trigger.json)

## 6. Hook execution evidence

live-marker.jsonl after the trigger:

    {"timestamp":"2026-09-22T01:55:46.217Z","phase":"hook_started","pid":48772,"ppid":51588,"pipe_env_present":true}
    {"timestamp":"2026-09-22T01:55:46.558Z","phase":"hook_finished","pid":48772,"ppid":51588,"pipe_env_present":true,
     "handoff_status":"handoff_accepted","exit_status":0}

    plugin SessionStart executed:      YES (hook_started present, from a Desktop-created session)
    CODEX_APP_TOOLS_PIPE_PATH visible: YES (pipe_env_present true; the value itself was never recorded)
    handoff status:                    handoff_accepted
    exit status:                       0

## 7. Host state after the trigger

    /launcher/desktop-interactive ready:true, reason:null, pipeSource:"handoff"
    /launcher/desktop-sync        connected:true, currentConversationId:01a0c6d3-7bee-79d2-80a9-f3cb0bc154d4

    POST /launcher/desktop-tools-pipe/probe
      connected:true, pipeSource:"handoff", toolCount:44,
      codexAppToolsVersion:0.1.4, mcpTransport:stdio, nativeDesktopTransport:windows_named_pipe,
      desktopDetected:true, bundleDetected:true,
      requiredToolsPresent: list_projects/create_thread/send_message_to_thread/read_thread/wait_threads = all true

Only the tools/list-level probe was run; no production submit_goal was executed in P5.7.0.
(artifact: host-state-after-trigger.json)

## 8. Trust gate finding (important for P5.7.1)

The first real Desktop trigger (01:47:37Z, thread 01a0c6cc-...) produced **no** marker while the trusted
ponytail hook in the same session ran normally. A read-only hooks/list census against a fresh
app-server explains it exactly (artifact: hooks-list-census.json):

    key      lrm-desktop-session-start-probe@lrm-probe:hooks/hooks.json:session_start:0:0
    source   plugin        enabled true      trustStatus **untrusted**
    key      ponytail@ponytail:hooks/claude-codex-hooks.json:session_start:0:0
    source   plugin        enabled true      trustStatus trusted

i.e. a plugin-bundled SessionStart hook is discovered and enabled, but it does **not** bypass Codex's
one-time hook trust: an untrusted plugin hook is simply not executed, and no failure is surfaced in the
session. This is the same class of gate P5.4.3.2 saw for the user-scope entry, and it is the first thing
P5.7.1 must account for: a freshly installed LRM plugin hook is untrusted until it is approved once
(interactive /hooks review, or an already-trusted hash in [hooks.state]).

For this PoC, after that finding the operator explicitly approved writing the trust entry (option C);
the exact key and currentHash from hooks/list were added to ~/.codex/config.toml [hooks.state], and the
trigger was repeated: the hook then executed and the handoff succeeded (sections 5-7).
--dangerously-bypass-hook-trust was used only as a read-only diagnostic on a throwaway codex exec
session and was never persisted.

## 9. Result classification

    PASS

    plugin SessionStart executed:      YES
    CODEX_APP_TOOLS_PIPE_PATH visible: YES
    handoff accepted:                  YES
    Host ready after handoff:          YES
    pipeSource:                        handoff
    codex_app tools probe:             PASS

No FAIL_A/B/C/D branch applies once the plugin hook is trusted.

## 10. Production code / footprint

    production code changed:   NO  (src/, scripts/, tests/ untouched; git status shows only the untracked .review dir)
    new MCP added:             NO
    Desktop / app.asar changed: NO
    user-scope ~/.codex/hooks.json changed: NO
    third-party plugin changed: NO
    pipe scanning / guessing:   NO
    cross-process env read:     NO
    commit / push:              NONE

Cleanup:

    probe plugin removed            codex plugin remove lrm-desktop-session-start-probe@lrm-probe
    probe marketplace removed       codex plugin marketplace remove lrm-probe
    plugin cache deleted            ~/.codex/plugins/cache/lrm-probe
    [hooks.state] trust entry       removed; config.toml has no lrm-probe reference left
    .review evidence                kept

## 11. Residual notes

1. The trust entry written for the PoC was removed again, so a future LRM plugin hook will start
   untrusted. P5.7.1 must treat "first-run hook approval" as an explicit precondition, not an
   implementation detail.
2. A short-lived codex exec --dangerously-bypass-hook-trust session was used purely as a diagnostic to
   confirm the wrapper itself works; its marker is kept separately as bypass-diagnostic-marker.jsonl and
   manual-diagnostic-marker.jsonl and is not part of the PASS evidence.
3. The real triggers created extra Desktop threads (P5.7.0 trigger/probe titles). They are ordinary
   user-visible tasks and can be archived.
4. The LRM Host still holds the handoff capability accepted during the final trigger, exactly as it did
   before this task; no state was forged to keep it.
5. Only the tools/list-level probe was used; no production goal was submitted.
