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
```

- The real binary is resolved from Desktop-owned locations only: `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`
  (the registered core Desktop launches) then `%ProgramFiles%\WindowsApps\OpenAI.Codex_*\app\resources\codex.exe`.
  `PATH` is never searched, `CODEX_CLI_PATH` is never re-read, and resolving to the trampoline itself
  fails closed with exit code 78.
- The handoff is best effort: on any failure the trampoline still starts the real codex.exe.
- The token is read from `trampoline.config.ini` only, is never logged, and never appears in argv.

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
- Desktop tears down the app-server process tree on exit, so the trampoline may be killed before it can
  observe the child exit code (verified in P5.7).
