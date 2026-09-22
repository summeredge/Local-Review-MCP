# P5.4.4 Manual-PASS vs Automatic-FAIL Differential

verdict: **BLOCKED** (differential fully reproduced; no existing automatic Desktop-owned seam)
scope: differential localisation only; no production code changed; no commit/push
date: 2026-09-21 (Asia/Shanghai)
artifacts: .review/p5-4-4-manual-auto-differential/ (sanitized JSON only; probes deleted)

---

## 0. Deliverable lines

    P5.4.4 MANUAL/AUTO DIFFERENTIAL: BLOCKED

    DIRECT MANUAL PASS reproduced:                 YES
    DIRECT AUTOMATIC/LAUNCHER FAIL reproduced:     YES

    PASS process chain:
      node sender (probe, pid 15336)
        <- pwsh.exe (Desktop-owned Codex task shell, pid 2876)
           <- codex.exe app-server (pid 50868)
              <- ChatGPT.exe Desktop main (pid 51064)
                 <- explorer.exe (pid 13768)

    FAIL process chain (launcher-shaped, this turn):
      node sender (probe, pid 60244)
        <- powershell.exe (pid 19392)
           <- pythonw.exe (pid 47256)
              <- pythonw.exe (pid 22368)
                 <- cmd.exe (pid 42540)
                    <- explorer.exe (pid 59000)

    FAIL process chain (real production Launcher, observed this turn):
      node.exe LRM Host (pid 44916)
        <- node.exe cli.js --config (pid 8928)
           <- cmd.exe (pid 58360)
              <- node.exe npm start (pid 46092)
                 <- powershell.exe start-production.ps1 (pid 52308)
                    <- pythonw.exe launcher.py (pid 42116)
                       <- pythonw.exe local-review-launcher (pid 5372)
                          <- <parent recycled>

    LAST COMMON SEMANTIC STAGE:  interactive user session (explorer.exe-launched top-level
                                 process); both chains are ordinary user processes and share no
                                 capability-bearing ancestor.
    FIRST DIVERGENT STAGE:       ChatGPT.exe Desktop main (pid 51064). It is the injector: it
                                 writes CODEX_APP_TOOLS_PIPE_PATH into its own process.env while
                                 its native app-tools pipe is alive, so every process it spawns
                                 inherits the capability. The FAIL chain never crosses a
                                 ChatGPT.exe ancestor, so no stage in that chain ever holds it.

    Desktop env injection boundary:
      owner:            ChatGPT.exe Desktop main (pid 51064), re-read from the installed app.asar
                        this turn (see section 2)
      manual PASS reason: the sender ran as a descendant of ChatGPT.exe main
                        (ChatGPT.exe -> codex.exe app-server -> pwsh task shell -> node sender),
                        so it inherited the Desktop-injected value. The shell identity is not the
                        reason: the same shell with a forced-new-environment child FAILS
                        (boundary-run-forced-new-environment.json).
      automatic FAIL reason: the Launcher chain is rooted in the user session (pythonw/explorer),
                        never crosses ChatGPT.exe, and the Launcher/start-production/npm path never
                        references or forwards the variable, so the same sender finds no value.

    codex-ipc server owner:                  ChatGPT.exe Desktop main (pid 51064) - the
                                             [IpcRouter] "I am the router" records live in the
                                             Desktop main log file for that pid; the router is
                                             created lazily by the first client that calls
                                             getOrStartRouterEndpoint().
    codex-ipc proven request capability:     initialize (client -> router, exercised by LRM every
                                             run). The router also implements client discovery and
                                             request forwarding, but the installed bundle registers
                                             only thread-owner-discovery / thread-follower-* /
                                             ide-context handlers. No handler accepts or returns a
                                             tools-pipe capability.
    codex-ipc suitable for handoff:          NO

    Desktop main callable seam:              YES as an endpoint (\\.\pipe\codex-ipc, long-lived,
                                             in the capability-holding process, LRM already connects
                                             read-only) - but NO as a handoff seam: its proven
                                             surface cannot deliver the capability.
    app-server/codex_app callable seam:      NO for LRM (stdio child of Desktop; an LRM-side spawn
                                             would need the pipe path first -> CIRCULAR)
    codex-ipc callable seam:                 YES for observation/coordination; NO for handoff

    existing automatic Desktop-owned seam found:  NO

    NO_EXISTING_AUTOMATIC_DESKTOP_SEAM

    minimum missing component:  a Desktop-side bootstrap component whose only job is to hand the
                                capability to LRM through the existing loopback handoff endpoint
                                while it runs inside the Desktop-owned environment.
    why current components cannot bridge the boundary:
      1. ChatGPT.exe main holds the capability but exposes no request surface that returns it
         (setDynamicAppToolsPipePath() is a no-op stub in the installed bundle; the codex-ipc
         request surface reaches only thread-follower/owner-discovery/ide-context handlers).
      2. codex_app server.mjs is a stdio child of Desktop; LRM spawning its own copy still needs
         CODEX_APP_TOOLS_PIPE_PATH to enable it -> CIRCULAR.
      3. The Launcher-side chain has no reference to the variable at all, so no LRM-owned process
         can produce it by inheritance.

    hooks used: NO
    pipe scanning/guessing: NO
    cross-process env read: NO
    Desktop binary modified: NO
    production code changed: NO
    commit/push: NONE

---

## 1. Evidence set (sanitized)

    file                                   role                                   result
    -------------------------------------  -------------------------------------  ------------------------------
    pass-run-desktop-owned-shell.json      DIRECT manual PASS (1st run)           sender ok, ready:true/handoff
    pass-run-inherited-env.json            DIRECT manual PASS (2nd run)           sender ok, ready:true/handoff
    boundary-run-forced-new-environment.json  same shell, forced-new-env child    desktop_tools_pipe_unavailable
    fail-run-explorer-launched.json        plain user session (explorer-launched) desktop_tools_pipe_unavailable
    fail-run-launcher-shaped.json          Launcher-shaped chain (pythonw->ps->node) desktop_tools_pipe_unavailable
    ipc-contract-census.json               codex-ipc census via LRM protocol code initialize only
    ipc-raw-census.json                    codex-ipc census via raw documented framing initialize only

Recorded per run: timestamp, pid, ppid, executable basename, parent/grandparent basename, cwd,
command role, three environment presence booleans, sender result, Host ownerClientId presence,
Host handoff accepted. Never recorded: pipe path value, bearer token, full environment, prompt,
account data. No cross-process environment/PEB read was performed.

## 2. Desktop env injection boundary (re-read this turn, read-only app.asar)

Installed bundle: C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar
read with a byte scan plus an asar header index (literal pipe values redacted).

    delete process.env[os];
    let ke = await $ce({ callTool: ..., listTools: ... })
      .catch(e => (warning("Failed to start the Codex app tools native pipe", ...), null));
    ke != null && (process.env[os] = ke.pipePath);          // os = "CODEX_APP_TOOLS_PIPE_PATH"

    let Me = je.getWindowContext();
    ke != null && (Me.setDynamicAppToolsPipePath(ke.pipePath),
      I.add(() => { Me.setDynamicAppToolsPipePath(null), delete process.env[os], ke.dispose(); }));

    async function fs({ hostConfig, resourcesPath }) {
      if (!process.env.CODEX_APP_TOOLS_PIPE_PATH) return ps("missing-pipe"); ... }
    async function ls(e) { return e.hostConfig.kind === "local"
      ? ["plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=" + (await fs(e) != null)] : []; }
    function PQ(e) { let t = { ...process.env, ..., WSLENV: ure(process.env.WSLENV,
      [..., "CODEX_APP_TOOLS_PIPE_PATH"]) }; ... }
    function _Q(e,t=[]) { let a = { ...process.env, LOG_FORMAT: "json", ... }; ... }   // local app-server spawn

A. who owns the capability: ChatGPT.exe Desktop main only. It creates the native app-tools pipe at
   startup and writes the path into its own process.env; the same value is deleted in the teardown.
B. who has it because of inheritance: every later child of Desktop main - the codex.exe app-server
   (spawned with { ...process.env, ... }), the Desktop-owned Codex task shell, and the codex_app MCP
   child (a second, deliberate injection through the bundle env_vars whitelist).
C. lifetime: created once per Desktop app start, removed at app teardown; no per-thread or per-turn
   re-injection exists in the installed bundle.
D. manual PASS = inheritance: YES. Proven by the boundary control: a child of the same Desktop-owned
   task shell started with a brand-new environment fails identically to the Launcher chain.

## 3. First divergent stage

    PASS  explorer.exe(13768) -> ChatGPT.exe main(51064) -> codex.exe app-server(50868)
          -> pwsh task shell(2876) -> node sender(15336)   [capability present]
    FAIL  explorer.exe(59000) -> cmd.exe(42540) -> pythonw(22368) -> pythonw(47256)
          -> powershell(19392) -> node sender(60244)        [capability absent]

The first stage whose environment differs is ChatGPT.exe main: it is the only process that writes
the variable, so the divergence is created at the Desktop-main spawn boundary, not at the shell.
Everything below ChatGPT.exe main inherits; the FAIL chain contains no such ancestor.

## 4. codex-ipc survey (read-only)

    who creates/listens: the Desktop main process (pid 51064). Router creation is lazy
      (getOrStartRouterEndpoint()); on Windows it always binds \\.\pipe\codex-ipc and treats
      EADDRINUSE as "another router is active".
    which process: ChatGPT.exe main, i.e. inside the Desktop-owned environment tree, and it is the
      same process that owns CODEX_APP_TOOLS_PIPE_PATH.
    real requests supported: initialize (registerClient), broadcast fan-out, client-discovery
      request/response, and generic request forwarding to a client that answers canHandle.
    registered handlers in the installed bundle: thread-owner-discovery, thread-follower-*
      (start-turn, load-complete-history, compact-thread, steer-turn, interrupt-turn,
      update-thread-settings, edit-last-user-turn, command-approval-decision,
      file-approval-decision, permissions-request-approval-response, submit-user-input,
      submit-mcp-server-elicitation-response, set-queued-follow-ups-state), ide-context.
    bidirectional seam: yes, the router forwards requests both ways, but no registered handler
      carries the tools-pipe capability, and none may be invented.
    census (2 independent clients, 12 s and 25 s): outbound = initialize only; inbound = one
      thread-stream-following-changed broadcast; no client types observed.

    => codex-ipc = observation-only for the current proven contract.

## 5. The three long-lived Desktop-owned candidates

    candidate                    lifetime covers  proven to hold  existing callable  LRM can call  can invoke  circular
                                 Desktop life?    pipe env?        entry for LRM?     w/o pipe?     sender?     dep?
    ---------------------------  ---------------  ---------------  -----------------  ------------  ----------  --------
    A ChatGPT Desktop main       YES              YES (injector)   YES (codex-ipc)    YES           NO          -
    B codex.exe app-server /     YES (app life)   YES (inherited)  NO (stdio child)   NO            NO          YES
      codex_app MCP child
    C codex-ipc server/client    YES (app life)   YES (in A)       YES (codex-ipc)    YES           NO          -

CIRCULAR: LRM -> needs the tools pipe -> to connect codex_app -> to have codex_app hand the tools
pipe back. B cannot break the boundary, so it is not a usable seam.

## 6. Prohibitions honoured

    named-pipe enumeration / pipe name guessing   not used
    reading other process env / PEB                not used (own-process booleans only)
    Desktop binary modification                    not used (app.asar and codex.exe read-only)
    private backend fallback                       not used (both FAIL runs fail closed)
    polling / background loops                     not used (bounded probes only)
    hooks (SessionStart/repo/plugin/trust)         not used
    modifications to DesktopCodexBackend / CompletionObserver / ToolsPipeResolver /
      ToolsPipeHandoff protocol / Goal/Session/Execution / review loop / AutoIteration
                                                   none
    commit / push                                  none
    cleanup                                        all probe scripts and helper launchers deleted; the
                                                   sanitized JSON evidence and this report remain;
                                                   the pre-existing untracked "%SystemDrive%"
                                                   directory was left untouched (not created by
                                                   this task)

## 7. Residual unknowns (declared, not guessed)

1. The codex-ipc request-forwarding path was not exercised (only proven methods were sent), so
   "which Desktop client would answer an arbitrary method" remains unmeasured by design.
2. Whether a future Desktop build exposes the capability through codex-ipc is unknown; this report
   covers the installed bundle (Desktop 26.915.4065.0, codex 0.155.0-alpha.9.2, codex-app-tools 0.1.4).
3. The Launcher root process of the live chain records a parent pid that has since been recycled,
   so its ancestry cannot be resolved from the process table; it is irrelevant here because the
   Launcher chain has no reference to the variable at all (grep over LocalReviewLauncher, scripts,
   src: no hits).
