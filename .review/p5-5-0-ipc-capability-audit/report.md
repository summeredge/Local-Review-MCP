# P5.5.0 IPC Capability Handoff Feasibility Audit

verdict: **NOT_FEASIBLE** (with the existing Desktop build; no Desktop modification permitted)
scope: read-only architecture review of the existing `\\.\pipe\codex-ipc` channel; no production code,
no Desktop modification, no handler added, no bridge added, no commit/push
date: 2026-09-21 (Asia/Shanghai)
artifacts: .review/p5-5-0-ipc-capability-audit/

---

## Executive Summary

结论：

    NOT_FEASIBLE

    The codex-ipc channel is a real bidirectional broker with client-side handler registration, and
    LRM already holds a working connection to it. But it cannot carry a Desktop -> LRM capability
    handoff today, for three independent reasons:

    1. No handler exists that carries the capability. The Desktop build registers exactly
       thread-owner-discovery and the 13 thread-follower-* methods. Nothing returns or accepts
       CODEX_APP_TOOLS_PIPE_PATH.
    2. Handler registration is in-process only. addRequestHandler() is a method on the IpcClient
       class inside the Desktop bundle; there is no external registration path, and the Desktop main
       process (which owns the capability) is the router, not a request target that can be extended
       from outside.
    3. The LRM side is not a request-capable client yet. The LRM client writes exactly one frame in
       its entire lifetime (initialize) and has no request API, no response correlation beyond that
       single handshake, and no reply path for inbound requests.

    Adding a handoff method would require changing Desktop code (a new handler plus a trigger that
    runs inside the Desktop-owned environment), which this task forbids. Therefore the correct
    outcome is REQUIRE_DESKTOP_BRIDGE, not IMPLEMENT_IPC_HANDOFF.

## Current IPC Capability

LRM client:

    role:      client on the shared router pipe (\\.\pipe\codex-ipc)
    init:      connect -> write one framed initialize request -> read its response -> observer applies
               currentConversationId / ownerClientId / followingThreads from the result
    requests:  initialize ONLY. src/desktop-sync/desktop-ipc-client.ts contains exactly one
               socket.write() call in the whole file (line 155, the initialize frame).
    correlation: single-slot. initializeRequestId holds one id; any response with a different id is
               discarded (line 199). There is no pending-request map.
    timeouts:  connectTimeoutMs (default 5000), reconnectDelayMs (default 1000), both bounded and
               covered; protocol errors and initialize errors are reported through onError.
    inbound:   the protocol layer parses type:"request" (desktop-ipc-protocol.ts), but the observer
               handles only "broadcast" and "response"; inbound requests are never answered.

    LRM -> Desktop request capability:
    NO
    evidence: desktop-ipc-client.ts has no sendRequest(); the only outbound frame is initialize;
              there is no request/response correlation map; observer.ts has no "request" branch.

Desktop server:

    owner:     ChatGPT.exe Desktop main (pid 51064). Router creation is lazy
               (IpcRouterManager.getOrStartRouterEndpoint); on Windows it always binds
               \\.\pipe\codex-ipc and treats EADDRINUSE as "another router is active".
               Evidence: [IpcRouter] "I am the router" is logged in the Desktop main log for pid
               51064, and new lines appear exactly when LRM connects (13:32:09 / 13:42:40 /
               13:43:08 / 13:43:44 / 13:44:08 during this audit).
    dispatch:  yes - IpcRouter.handleRequest -> findClientForRequest -> forwardRequest, with a
               client-discovery-request/response handshake ({"canHandle": bool}) and a 10 s
               request timeout (m9 = 1e4) before the router answers "request-timeout".
    registry:  per-client Map. IpcClient.addRequestHandler(method, canHandle, handler) is the only
               registration primitive in the whole bundle (3 occurrences, all inside b9()).
    methods:   thread-owner-discovery, thread-follower-start-turn, thread-follower-load-complete-history,
               thread-follower-compact-thread, thread-follower-steer-turn, thread-follower-interrupt-turn,
               thread-follower-update-thread-settings, thread-follower-edit-last-user-turn,
               thread-follower-command-approval-decision, thread-follower-file-approval-decision,
               thread-follower-permissions-request-approval-response, thread-follower-submit-user-input,
               thread-follower-submit-mcp-server-elicitation-response,
               thread-follower-set-queued-follow-ups-state
    unknown method: router replies resultType:"error" with "no-client-found" (no client answered
               canHandle); a client that claimed canHandle but lost the handler replies
               "no-handler-for-request".
    note:      "ide-context" is a method the Desktop side SENDS (webview client-coordination ->
               view service -> ipcClient.sendRequest("ide-context", {workspaceRoot}, {targetClientId}))
               and expects a peer IDE client to answer. No Desktop-side registration of an
               ide-context handler exists in the installed bundle. The P5.4.4 report listed it as a
               registered handler; that was an inference from the sender call site and is corrected here.

## Request/Response Capability

    bidirectional RPC:  YES (transport level)
      evidence: the router forwards requests in both directions between connected clients, answers
                with resultType success/error, and correlates by requestId; LRM's own protocol parser
                already understands type:"request" and type:"response".

    handler extension:  NO (external, without modifying Desktop)
      evidence: addRequestHandler is an instance method of the bundle's IpcClient class. Only bundle
                code calls it (b9). There is no plugin, config, or protocol message that registers a
                handler into Desktop's client. A third-party process can connect as a client and
                ANSWER requests, but it cannot make Desktop main answer a new method.

## Desktop Main Ownership

    owns pipe:           YES
      evidence: app.asar (installed bundle, read-only byte scan + asar header index this turn):
                delete process.env[os]; ke = await $ce({...}) ...; ke != null && (process.env[os] =
                ke.pipePath);  with os = "CODEX_APP_TOOLS_PIPE_PATH". Desktop main creates the native
                app-tools pipe server and writes its path into its own process.env, then removes it
                in the teardown disposer.

    can perform handoff: NO (not today)
      sub-facts:
        Desktop main capability ownership:      YES
        Desktop main can call LRM loopback:     UNKNOWN
          - transport: main requires node:http and uses fetch/net.fetch, so an HTTP client exists.
          - endpoint:  no LRM reference exists anywhere in the bundle ("local-review-mcp", "12080",
                       "launcher/desktop-tools-pipe", "LocalReviewLauncher": zero hits). No configured
                       URL, no bearer token, no port.
        Desktop main has lifecycle trigger:     YES internally / NO externally
          - internal: the pipe path is created at app start and removed in a disposer registered with
            the same I().add(...) teardown list.
          - external: no supported way for LRM to make Desktop main run code at that moment.
        setDynamicAppToolsPipePath():           a no-op stub in the installed bundle
          evidence: setDynamicAppToolsPipePath(e){} - the call site passes the path, but the
          implementation body is empty, so no Desktop-owned surface even exposes the value to the
          renderer/webview side.

## Candidate Evaluation

| 方案 | 结果 | 原因 |
|-|-|-|
| IPC extension | NOT_FEASIBLE | Transport and dispatch support a new method, but (a) no handler carries the capability, (b) handler registration is in-process bundle code with no external path, and (c) LRM cannot even send a request today. Adding a handoff method plus an in-Desktop trigger requires Desktop code changes -> prohibited. |
| app-server / codex_app | CIRCULAR | codex_app is a stdio child of Desktop's app-server and reads CODEX_APP_TOOLS_PIPE_PATH to connect the native pipe. LRM cannot attach to that stdio; LRM spawning its own copy still needs the pipe path first. Dependency: LRM -> needs codex_app -> needs pipe -> needs handoff -> needs Desktop. process lifetime = Desktop app lifetime; has pipe = YES (inherited); callable from LRM = NO. |
| Desktop bridge | required: YES | Only a component running inside the Desktop-owned environment can both (a) observe the pipe path and (b) reach the LRM loopback endpoint. Neither existing long-lived component (Desktop main, codex_app) exposes a callable path that carries the capability. |

## Final Recommendation

    REQUIRE_DESKTOP_BRIDGE

    Rationale: the differential from P5.4.4 shows the capability exists only inside the ChatGPT.exe
    process tree, and this audit shows the existing codex-ipc channel cannot transport it out of that
    tree without Desktop-side code changes. The minimal missing component is a Desktop-side bootstrap
    component whose only job is to hand the capability to LRM through the existing loopback handoff
    endpoint while it runs inside the Desktop-owned environment.

    Do NOT implement: an IPC handoff method, a private backend fallback, pipe enumeration, or a
    Launcher-side workaround. None of them can create the capability in a non-Desktop process.

    Next step is a decision about the Desktop-side component (scope, ownership, distribution), not
    further exploration of codex-ipc.

## Constraints Check

    hooks used: NO
    pipe scanning: NO
    pipe guessing: NO
    cross-process env read: NO
    Desktop modified: NO
    app.asar modified: NO
    production code changed: NO
    commit/push: NONE

## Method and Evidence

    read-only sources used this turn:
      - installed app.asar (byte scan + asar header file index), read only
      - installed bundle plugin files (codex-app-tools .mcp.json / server.mjs)
      - Desktop main logs under the packaged LocalCache Logs tree (read only)
      - LRM sources: src/desktop-sync/*.ts, src/mcp/http.ts, src/desktop-codex/desktop-tools-pipe-handoff.ts
      - P5.4.4 artifacts (pass/fail differential, IPC census)
    probes: one temporary raw IPC census script was drafted and then deleted WITHOUT executing it,
      because sending an unproven method would violate the P5.4.4 discipline. All dispatch and
      handler facts above come from bundle code and logs, not from guessed RPC.

## Acceptance Answers

    1. Can the existing Desktop IPC carry the handoff?
       NO. The channel is a working broker, but it has no capability-carrying method, no external
       handler registration, and no request-capable LRM client.
    2. If not, what is missing?
       A method that returns the capability, a client that registers it inside the Desktop-owned
       environment, a trigger that fires there, and an LRM-side request capability.
    3. Is a Desktop-side component required?
       YES.
    4. What should be implemented next?
       Decide and scope the Desktop-side bootstrap component. Stop exploring codex-ipc, hooks, pipe
       discovery, and Launcher-side workarounds.
