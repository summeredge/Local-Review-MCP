# P5.8 Final Status

## Architecture

Desktop Capability Activation Bootstrap

```text
Desktop cold start
    ↓
CODEX_CLI_PATH -> DesktopBootstrapTrampoline
    ↓
CODEX_APP_TOOLS_PIPE_PATH capture
    ↓
pending handoff
    ↓
Desktop IPC activation binding
    ↓
owner promotion
    ↓
pipeSource=handoff
```

## Verified

- `CODEX_CLI_PATH` trampoline
- `CODEX_APP_TOOLS_PIPE_PATH` capture
- pending handoff (`202`, owner not yet bound)
- owner promotion (`pending -> active`)
- activation-assisted bootstrap state machine and launcher diagnostics

## Supported flow

1. Start Desktop.
2. Switch once to an existing ChatGPT conversation.
3. Desktop IPC exposes the owner identity.
4. The pending handoff is promoted and the capability becomes `pipeSource=handoff`.

No new conversation, prompt, or `SessionStart` trigger is required.

## Not implemented

- zero-touch cold-start bootstrap without Desktop activation
- Desktop instance identity
- `client-status-changed` automatic bootstrap
- Desktop IPC protocol modification
- pipe-name ownership inference or cross-process injection

Without conversation activation, owner identity is unavailable. This is expected
behavior, not a failure.

## Launcher status

The launcher now reports these independently:

```text
Desktop IPC: Connected / Disconnected
Desktop Identity: Ready / Waiting for activation
Tools Pipe: Active / Pending / Unavailable
Capability: pipeSource=handoff / Waiting for Desktop activation / Unavailable
```

Only validated state is exposed; no pipe path is returned.

## Test results

### A — trampoline standalone behavior

PASS. Phase A verified bundled `codex.exe` resolution, stdio/argv forwarding,
exit code `0` for `--version`, exit code `2` for an unknown argument, pipe
capture, and an accepted handoff.

### B — activation-assisted bootstrap

PASS for the automated handoff lifecycle and HTTP integration: pending evidence
is not resolvable, Desktop owner observation promotes it, and the final source
is `handoff`. The Phase B script now waits for the user to switch one existing
conversation before requiring `ready=true` and `pipeSource=handoff`.

The live cold-start attempt in this task reached `202 pending`, but no
conversation activation occurred before the pending TTL, so that attempt was
discarded as designed. It is not reported as a promotion failure.

### C — transparency

PASS. Phase C observed the Desktop override, the trampoline parent/real Codex
child chain, app-server initialize/version response, and no trampoline failure
records. Targeted runtime and bridge tests also passed.

### D — rollback

#### D1 Automated rollback

PASS.

- The rollback path uses `Remove-ItemProperty` to delete the user-level
  `CODEX_CLI_PATH` value.
- The empty-string branch does not write an empty environment value.
- `[Environment]::GetEnvironmentVariable("CODEX_CLI_PATH", "User")` is empty.
- No production code residue or uncommitted diff remains after this commit.

#### D2 Desktop restart verification

PASS. Manual restart completed by the user and verified without another
automatic Desktop restart:

- `CODEX_CLI_PATH` is empty;
- no `DesktopBootstrapTrampoline.exe` process exists;
- Desktop logs report `source=copied` for the bundled `codex.exe`;
- `codex.exe` is a direct child of `ChatGPT.exe` and app-server initialize
  completed normally.

## Automated verification

```text
npm run typecheck                         PASS
npm run build                             PASS
P5.8 targeted Vitest tests                90 passed
LocalReviewLauncher Python tests          67 passed
git diff --check                          PASS
D1 rollback implementation                 PASS
D2 Desktop restart                         PASS
```

## Git

```text
branch: feature/p5.8-desktop-bootstrap-trampoline
commit: this commit
merge: no
push: no
```
