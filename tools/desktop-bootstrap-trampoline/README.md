# Desktop Capability Activation Bootstrap (P5.8)

The supported flow is:

```text
Desktop cold start
  -> CODEX_CLI_PATH trampoline captures CODEX_APP_TOOLS_PIPE_PATH
  -> pending handoff
  -> user switches one existing conversation
  -> Desktop IPC owner binding
  -> pending promotion
  -> pipeSource=handoff
```

The trampoline is only the capability capture/forwarding path. It does not create Desktop identity,
change the Desktop IPC protocol, or authorize a pipe from its name. Without a user activation that
provides Desktop owner identity, the handoff remains pending and the capability stays fail-closed.

The handoff does not end at first success. For as long as the spawned `codex.exe` is alive, a low
frequency maintenance loop keeps the capability valid, so a restart of the MCP runtime alone is
enough to recover Desktop tools pipe access. Restarting Codex Desktop, or activating a conversation
again, is never required for that recovery.

## Layout

```text
src/DesktopBootstrapTrampoline.cs   trampoline source (C#, .NET Framework 4.x, in-box csc)
scripts/build.ps1                   builds DesktopBootstrapTrampoline.exe (x64 PE, no new runtime)
DesktopBootstrapTrampoline.exe       generated local build output
trampoline.config.ini               generated local configuration, holds the launcher token
logs/                                generated local trampoline logs
```

## Behaviour

```text
capture environment (pipe path, argv, pids, cwd)
  -> optional handoff POST (background thread, bounded retries, never blocks codex.exe)
  -> exec real bundled codex.exe (argv / stdin / stdout / stderr / cwd / environment preserved)
  -> maintenance: probe every 5s while the child runs, re-POST only when the handoff is gone
```

- The real binary is resolved from Desktop-owned locations only: `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`
  (the registered core Desktop launches) then `%ProgramFiles%\WindowsApps\OpenAI.Codex_*\app\resources\codex.exe`.
  `PATH` is never searched, `CODEX_CLI_PATH` is never re-read, and resolving to the trampoline itself
  fails closed with exit code 78.
- The handoff is best effort: on any failure the trampoline still starts the real codex.exe.
- The token is read from `trampoline.config.ini` only, is never logged, and never appears in argv.

## Maintenance and MCP runtime restart

After the first `accepted` (or `pending`) answer the same worker stops the cold-start burst and
switches to maintenance, for the whole lifetime of the real `codex.exe`:

```text
POST /launcher/desktop-tools-pipe/probe
  -> 200 connected=true + pipeSource=handoff  -> healthy, wait one interval
  -> 409 / 503 / unreachable                  -> re-POST the inherited pipe path
  -> 400 / 401 / 403                          -> fail closed, stop asking
```

Re-offering uses the `CODEX_APP_TOOLS_PIPE_PATH` this process captured at launch. It is never written
to disk, a config file, LRM state, or the log; the trampoline only ever records `pipe_present`. The
decision to accept still belongs to LRM's existing owner binding: a re-POST that arrives before the
Desktop owner identity is back simply returns `202 pending` and follows the existing
`stagePending` -> `owner_bound` -> `promoted` path.

The cold-start deadline (`handoffDeadlineSeconds`) bounds only the first retry burst. Recovery keeps
going for as long as Codex runs, because an MCP runtime restart is not a Desktop restart. Backoff for a
failing recovery grows `5s -> 10s -> 20s -> 30s` and then stays at `30s`.

The maintenance thread is a background thread stopped as soon as the child exits, so it can never
hold the process open, and the trampoline still writes nothing to stdout or stderr.

## Self-check

The lifecycle rules are verified by an assert-based self-check that drives the real supervisor with a
scripted launcher and a fake clock, so it needs no timer, no live LRM, and no Desktop:

```powershell
pwsh -File tools/desktop-bootstrap-trampoline/scripts/build.ps1
$env:LRM_TRAMPOLINE_SELF_CHECK = '1'
& tools/desktop-bootstrap-trampoline/DesktopBootstrapTrampoline.exe   # exit 0 means every rule held
```

It covers: maintenance after the first accept, no re-POST while the probe is healthy, re-POST after an
unreachable runtime and after a 409/unavailable probe, `202 pending` followed by more probes until
healthy, bounded backoff, no retry on 400/401/403, and the pipe path never reaching a log line.

## Build

```powershell
pwsh -File tools/desktop-bootstrap-trampoline/scripts/build.ps1
```

The generated executable, local configuration, and logs are ignored runtime artifacts. The historical
verification report is retained at `.review/p5.8-bootstrap/report.md`; transient probe outputs are not
part of the repository.

## Limits

- Depends on Desktop injecting `CODEX_APP_TOOLS_PIPE_PATH` into the CLI process it spawns. If that stops,
  the trampoline records `pipe_present=false` and LRM stays fail-closed.
- The handoff endpoint binds the capability to LRM's current Desktop owner, so the first POSTs after a cold
  start can return 409 (`desktop_tools_pipe_unavailable`) until LRM reconnects to `\\.\pipe\codex-ipc`.
  The trampoline retries on a bounded schedule for `handoffDeadlineSeconds`.
- The maintenance loop assumes the Desktop that owns this pipe is still running. If Desktop itself
  exits, the child `codex.exe` exits with it and the loop stops instead of re-offering a dead pipe.
- Desktop tears down the app-server process tree on exit, so the trampoline may be killed before it can
  observe the child exit code (verified in P5.7).
