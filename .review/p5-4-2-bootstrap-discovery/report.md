# P5.4.2 Desktop-owned Bootstrap Mechanism Discovery

verdict: PASS (supported automatic trigger found and PoC-proven, with a stated precondition)
scope: mechanism discovery only; no production hook implemented; no commit/push
date: 2026-09-21 (Asia/Shanghai)
artifacts: .review/p5-4-2-bootstrap-discovery/

## 0. Deliverable lines

    P5.4.2 BOOTSTRAP DISCOVERY: PASS
    env injection owner: ChatGPT Desktop main process (ChatGPT.exe) - written into its own
      process.env before the Codex app-server child is spawned; the same value is passed
      explicitly to the codex_app MCP child through the bundle env_vars whitelist.
    LRM host inherits env: NO (documented production position: P5.4.1 BLOCKED_DESKTOP_PIPE_CAPABILITY;
      Launcher chain has no forwarding contract. Residual UNPROVEN noted in section 7.)
    automatic supported trigger: Codex hook event SessionStart (supported framework, automatic,
      no Desktop modification) firing inside a Desktop-owned Codex session.
    PoC handoff: PASS - hook run A automatically invoked the existing CLI
      sendDesktopToolsPipeHandoff -> POST /launcher/desktop-tools-pipe -> accepted:true,
      desktop_owner_bound:true, received_at inside the trigger window.
    Desktop modification required: NO
    pipe scanning/guessing: NO
    production code implemented: NO
    commit/push: NONE

## 1. Three environments, kept strictly apart

    environment                                  holds CODEX_APP_TOOLS_PIPE_PATH   evidence
    -------------------------------------------  --------------------------------  -------------------------------------------
    Desktop main (ChatGPT.exe 33604)             YES (it is the injector)          app.asar code, section 2
    Desktop codex_app MCP child                  YES (explicit env_vars whitelist) cmd 46240 -> node 49008 server.mjs
      (cmd 46240 -> node 49008 server.mjs)                                         + bundle .mcp.json
    Desktop-owned Codex task shell               YES (measured)                    EVIDENCE 1 below
    LocalReviewLauncher-started LRM Host         NO (no supported source)          process chain, section 7

EVIDENCE 1 - boolean probe executed in this Desktop task shell (value never printed):

    this_shell_pipe_env_present=True
    this_shell_thread_env_present=True

Process tree (Win32_Process, fresh snapshot this turn):

    ChatGPT.exe 33604 (Desktop main, parent explorer 13768, created 08:37:50)
      +- codex.exe 38636  app-server ... -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true
      |    +- cmd.exe 46240  /d /s /c call ./scripts/launch_codex_app_tools_mcp.cmd ./server.mjs
      |    |    +- node.exe 49008  ./server.mjs                      <- codex_app MCP child (owns the pipe env)
      |    +- pwsh.exe 29988                                       <- this Codex task shell
      +- ChatGPT.exe renderer/gpu/utility children (Electron)

    Launcher chain (independent of the tree above):
      pythonw.exe 26940 (PythonEnvs/local-review-launcher/Scripts/pythonw.exe, 08:39:13)
        +- pythonw.exe 42092 (Python311 pythonw, launcher.py)
             +- powershell.exe 4828 (scripts/start-production.ps1)
                  +- node.exe 45464 (npm start -- --config %TEMP%/local-review-launcher-*.json)
                       +- cmd.exe 35604 -> node.exe 35184 (dist/src/cli.js --config ...)
                            +- node.exe 32088 (dist/src/cli.js --runtime --config ...)   <- LRM Host

## 2. Injection owner and boundary (app.asar, installed Desktop bundle, re-read this turn)

Scanned C:\Program Files\WindowsApps\OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0\app\resources\app.asar
(361 MB) with a read-only byte scan (.review/p5-4-2-bootstrap-discovery/scan-asar-pipe-env.mjs).
Literal pipe values are redacted by the scanner.

    var os = "CODEX_APP_TOOLS_PIPE_PATH"

    delete process.env[os];
    let ke = await $ce({ callTool: ..., listTools: ... })
      .catch(e => (warning("Failed to start the Codex app tools native pipe", ...), null));
    ke != null && (process.env[os] = ke.pipePath);

    let Me = je.getWindowContext();
    ke != null && (Me.setDynamicAppToolsPipePath(ke.pipePath),
      I.add(() => { Me.setDynamicAppToolsPipePath(null), delete process.env[os], ke.dispose(); }));

    async function fs({ hostConfig, resourcesPath }) {
      if (!process.env.CODEX_APP_TOOLS_PIPE_PATH) return ps("missing-pipe");
      ... }                                   // gates the codex_app MCP server enable flag

    async function ls(e) { return e.hostConfig.kind === "local"
      ? ["plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=" + (await fs(e) != null)]
      : []; }

    function PQ(e) { let t = { ...process.env, CODEX_HOME: ..., LOG_FORMAT: ..., RUST_LOG: ...
      WSLENV: ure(process.env.WSLENV, [..., "CODEX_APP_TOOLS_PIPE_PATH"]) }; ... }

Boundary facts:

1. Owner = the Desktop main process. The value is written into its own process.env while its
   native app-tools pipe server is alive, and deleted again in the shutdown teardown.
2. Everything Desktop main spawns afterwards inherits it (the app-server codex.exe is spawned with
   { ...process.env, ... } in PQ, so inheritance is explicit in the bundle code).
3. The codex_app MCP child is a separate, deliberate injection: the bundle .mcp.json lists
   CODEX_APP_TOOLS_PIPE_PATH in env_vars, and Desktop enables that MCP server exactly when the
   value exists (missing-pipe gate above).
4. Consumer side (installed bundle + cache copy) never enumerates pipes: server.mjs reads only
   process.env[PIPE_PATH_ENV_VAR] and connects with net.createConnection(this.pipePath).
5. Lifetime: created once per Desktop app start, removed at app teardown; no per-thread or
   per-turn re-injection exists in the bundle code.

## 3. Why the historical probes reported pipeDiscovery = current_environment

The only producer of that string is codex-app-runtime.ts:262-263:

    const inherited = nonEmpty(environment[CODEX_APP_TOOLS_PIPE_ENV]);
    return inherited === undefined ? {} : { path: inherited, source: "current_environment" };

i.e. it is read from the process environment of the LRM process itself. LRM never writes that
variable into its own process (it only forwards a resolved path into spawned MCP children).
Therefore any artifact recording current_environment was produced by an LRM process launched from
an execution context that already carried the Desktop-injected value - a Desktop-owned Codex
execution context (measured: section 1 EVIDENCE 1), not an independently Launcher-started Host.
The historical reports do not record their own command line, so the exact shell of those runs is
inferred; the environment semantics above are proven.

## 4. Candidate mechanism evidence matrix

    mechanism                     owner process        pipe env  loopback  auto   lifecycle  needs    verdict
                                                                       start  available  Desktop
    ----------------------------  -------------------  --------  --------  -----  ---------  -------  ---------------------
    Desktop main native pipe srv  ChatGPT.exe          YES       no code   YES    YES        YES      unsupported
    codex_app MCP child           cmd->node server.mjs YES       no token  YES    per app    YES      unsupported
    Desktop-owned Codex shell     Codex session shell  YES       YES       per    per task   NO       unstable (not a
                                                                           turn                        bootstrap trigger)
    Codex SessionStart hook       Codex session        YES       YES       YES    session    NO       SUPPORTED (chosen)
      (Desktop-owned session)                                                  scoped
    Launcher/PowerShell wrapper   LRM own processes    NO        YES       YES    YES        NO       unsupported (no pipe)
    overwrite Desktop MCP config  Desktop itself       n/a       n/a       n/a    n/a        YES      unsupported

The SessionStart hook is the only candidate that is supported (documented hook framework),
automatic, needs no Desktop binary modification, and runs in an environment that provably holds
the injected value.

Official support basis (learn.chatgpt.com/docs/hooks, verified): hooks are a supported framework;
SessionStart fires on startup|resume|clear|compact; hook locations include ~/.codex/hooks.json,
~/.codex/config.toml [hooks], <repo>/.codex/hooks.json, <repo>/.codex/config.toml and plugin
hooks/hooks.json; command hooks run with the session cwd and inherit the Codex process
environment; non-managed hooks require a one-time review/trust (hash recorded in [hooks.state]);
codex exec accepts --dangerously-bypass-hook-trust for pre-vetted automation.
Local corroboration: the ponytail plugin SessionStart hook (ponytail-activate.js, the only writer
of .ponytail-active) rewrote .ponytail-active in the ponytail plugin data directory at
2026-09-21 12:55:13 local, three seconds after this Desktop task session_meta (04:55:10.179Z) -
SessionStart hooks do run inside a Desktop-owned Codex task, before any codex exec run existed.

## 5. Minimal non-destructive PoC

Mechanism under test: repo-scoped .codex/hooks.json with one SessionStart command hook calling a
temporary probe script; the script records environment presence as booleans only and invokes the
existing CLI instead of any new code path.

    hook file:   .codex/hooks.json                      (created for the PoC, deleted afterwards)
    hook script: .review/p5-4-2-bootstrap-discovery/session-start-hook.mjs
    trigger:     codex exec -C <repo> --dangerously-bypass-hook-trust --skip-git-repo-check
                   --ephemeral "Reply with exactly: P542_HOOK_POC_OK"

Run A - trigger started from the Desktop-owned task shell (environment carries the value):

    run window           2026-09-21T06:55:47Z .. 06:56:00Z
    hook fired           hook: SessionStart (codex exec log, plus SessionStart Completed)
    hook_event_name      SessionStart / source startup / session 01a0c2bf-d68a-7ab1-9f85-4b0a67b03a2c
    env presence         CODEX_APP_TOOLS_PIPE_PATH: true; CODEX_SESSION_ID: true; CODEX_THREAD_ID: true
    CLI exit code        0
    CLI stdout           { ok: true, accepted: true, source: "desktop_environment",
                           received_at: "2026-09-21T06:55:50.625Z", desktop_owner_bound: true }
    artifact             run-a-desktop-env-present.json

Run B - control, same hook, trigger shell with the variable removed (simulates a non-Desktop context):

    run window           2026-09-21T06:56:48Z .. 06:57:06Z
    hook fired           hook: SessionStart (same automatic path)
    env presence         CODEX_APP_TOOLS_PIPE_PATH: false
    CLI exit code        1
    CLI stdout           { ok: false, error: "desktop_tools_pipe_unavailable" }
    artifact             run-b-desktop-env-absent.json

Host observation around the PoC (GET /launcher/desktop-interactive and POST /launcher/desktop-tools-pipe/probe
against 127.0.0.1:12080 with the configured bearer token; the pipe path is never returned):

    before 06:55:17Z   ready:true reason:null pipeSource:handoff | connected:true desktopDetected:true
                       bundleDetected:true mcpTransport:stdio nativeDesktopTransport:windows_named_pipe
                       codexAppToolsVersion:0.1.4 toolCount:44
    after  06:57:26Z   ready:true reason:null pipeSource:handoff | connected:true ... toolCount:44

Interpretation: the supported trigger performed a real, owner-bound handoff to the running LRM
Host with no manual step, and fails closed when the Desktop-owned environment is absent - no
enumeration, no guessing, no fallback to a private backend.

Artifacts: run-a-desktop-env-present.json, run-b-desktop-env-absent.json, session-start-hook.mjs,
scan-asar-pipe-env.mjs.

## 6. What the mechanism does and does not cover

Covered: every time a Codex session starts in a Desktop-owned context (new task, resume, clear,
compact), the SessionStart hook runs automatically in an environment that holds the Desktop value
and can hand the capability to an already-running LRM Host loopback endpoint. The Host binds it to
the verified Desktop owner, and the resolver prefers it over the inherited value.

Not covered: a Desktop app that is running with no Codex session at all. There is no supported
startup seam in the Desktop main process that LRM may use, and no launcher-side seam that can
obtain the value. In that state the Host keeps failing closed, as documented in
docs/execution-backend-design.md (P5.4.1 BLOCKED_DESKTOP_PIPE_CAPABILITY).
Deployment precondition: the hook source must be trusted once (interactive /hooks review, or a
managed/plugin hook whose hash is already trusted in [hooks.state]); --dangerously-bypass-hook-trust
was used only to keep this PoC honest and was not persisted anywhere (config.toml mtime unchanged
at 08:38 local, no new [hooks.state] entry).

## 7. Residual unknowns (declared, not guessed)

1. LRM host environment: this turn proved the Desktop-owned Codex side, not the Host side. The
   Host runs inside the Launcher chain, which never references CODEX_APP_TOOLS_PIPE_PATH anywhere
   (rg over LocalReviewLauncher, scripts, src: no hits) and does not forward an explicit child
   environment (subprocess.Popen with creationflags only). One direct measurement remains open:
   start the Host with no accepted handoff and read GET /launcher/desktop-interactive -
   ready:true with pipeSource:current_environment would prove inheritance; desktop_tools_pipe_unavailable
   would prove absence. It was not performed because it requires restarting the live Host (out of
   this non-destructive scope), and reading another process environment is prohibited.
2. The live Launcher chain root (pythonw 26940) records parent PID 21028, which has since been
   recycled by an unrelated Desktop renderer, so the ancestry of the Launcher bootstrap cannot be
   resolved from the current process table. A transitive inheritance through a Desktop-owned
   ancestor therefore cannot be excluded by process-table evidence alone; this is the same open
   question as item 1 and is resolved by the same single measurement.
3. The historical current_environment artifacts do not record their launching command line, so the
   exact shell of those runs is an inference (see section 3).

## 8. Compliance with the prohibitions

    named-pipe enumeration             not used (scanner reads only app.asar bytes and bundle files)
    pipe name guessing                 not used
    reading other process env / PEB    not used (only booleans from own process environment)
    Desktop binary modification        not used (app.asar read only, never written)
    silent fallback to private backend not used (run B proves fail-closed)
    persisting the pipe path           not used (no artifact contains the value)
    commit / push                      none (git status shows only pre-existing user changes)
    cleanup                            .codex/hooks.json deleted and the empty .codex directory
                                       removed (the repo had no .codex directory before this task);
                                       hook script and evidence JSON files remain under .review

