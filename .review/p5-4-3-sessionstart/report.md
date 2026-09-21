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
