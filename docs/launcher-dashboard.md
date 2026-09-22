# LocalReviewLauncher Task Dashboard

Phase 5 exposes the existing interactive Session state in the PySide6 launcher.
It does not submit, stop, resume, approve, or otherwise control a Goal,
Execution, Codex Thread, or Turn. Task records can be cleared from the
dedicated task tab; running Sessions are retained.

## Data source

The launcher uses the local MCP runtime's authenticated, loopback-only Session
catalog endpoint to discover interactive Session IDs. It then reads each
record through the existing Status Query tools:

```text
get_session_status
        |
get_execution_status
        |
list_session_events
```

The launcher never reads `.codex`, rollout files, app-server files, provider
JSON-RPC payloads, or Codex transcripts directly. The catalog endpoint is only
for discovering IDs and is not an additional MCP tool, so the MCP tool list and
the existing execution chain remain unchanged.

## Desktop Sync status

The startup overview shows the read-only Desktop Sync status from the local
runtime's `DesktopIPCObserver` through `DesktopSyncManager`. The launcher reads
the authenticated, loopback-only `/launcher/desktop-sync` endpoint; it never
reads the Desktop named pipe itself and does not control Desktop.

`mode` is currently always `auto`:

```text
Desktop IPC Primary
  valid connected + current conversation evidence
  → observes and exactly associates the Desktop conversation/thread

Legacy app-server Fallback
  Desktop disconnected or evidence not established
  → exposes no guessed Desktop identity; existing LRM Session.thread_id remains authoritative

Codex execution
  always uses Codex app-server
```

A connected Desktop conversation whose exact `conversationId` matches no LRM
Session is reported as `Source: Desktop IPC` with `Association: Unmatched`.
Multiple exact Session matches are `Association: Conflict`; neither case is
silently converted into fallback. The Manager is read-only and keeps its
derived state in memory.

## Desktop Capability status

The same overview block shows the Desktop codex_app capability separately, read
from the runtime's existing `/launcher/desktop-interactive` preflight:

```text
Desktop Capability: Ready       |  Desktop Capability: Unavailable
Source: handoff                 |  Source: none
```

It is not the Desktop IPC connection: the observer can be connected while no
tools pipe has ever been handed to the runtime, and only a ready capability
(`handoff`, or the runtime's own `current_environment` fallback) satisfies the
preflight that `desktop_codex_app` execution needs. The block refreshes with the
same five-second status worker as Desktop Sync and is read-only: the launcher
never acquires a capability, posts a handoff, or reads the named pipe.

## Dashboard

The Task Dashboard shows interactive (`codex_app_server`) Sessions with:

- Goal / Task name. The current query contract supplies the stored phase and
  task labels; their stable `goal_id` and `task_id` are used as fallback.
- Session status, backend, model, reasoning effort, Session ID, Thread ID, and
  last update time.

The launcher keeps the persisted model and effort. It does not query a model
catalog or select a provider default. The normal `submit_goal` default remains
`execution_mode: batch`; batch executions are not shown as interactive
Sessions.

When there are no discoverable interactive Sessions, the dashboard shows:

```text
No active sessions
```

## Session Viewer and events

Select a dashboard row to view the Session and its current Execution:

```text
Session: session_id, goal_id, task_id, backend_type, thread_id, model,
         reasoning_effort, status
Execution: execution_id, status, current turn, started_at, finished_at
```

The Event Stream table displays the normalized events from
`list_session_events()` with `HH:mm:ss`, the event type, and bounded content.
The supported types are `session_started`, `turn_started`,
`agent_message_delta`, `agent_message_completed`, `turn_completed`, and
`execution_failed`. A failed Session remains visible with `failed` status and
the failure reason in the event content.

The dashboard refreshes every five seconds using the launcher's existing
background status worker. A manual **刷新状态** performs the same read-only
refresh.

## Task record cleanup

The task tab provides two separate cleanup actions:

- **清理界面缓存** clears the current launcher display without touching
  persisted records. Automatic refreshes keep cleared terminal records hidden,
  while active or new Sessions remain visible; manual **刷新状态** reloads all.
- **清理持久化任务记录** removes completed, failed, or terminated Session,
  Event, Execution, and corresponding Task records for the active Workspace.
  Running Sessions and their records are retained. The action uses the
  existing authenticated loopback launcher endpoint and asks for confirmation.

## Opening a Codex Task

**Open Codex Task** is a locator entry point. This launcher does not automate
Codex Desktop or a browser. When direct opening is unavailable, it displays:

```text
thread_id: ...
session_id: ...
```

Use the Thread ID to locate the Codex Task and the Session ID to correlate it
with the LRM event stream.

## Relationship

```text
LRM Goal / Task
      |
      v
LRM Session  -------- provider Thread ID
      |
      v
LRM Execution -------- provider Turn ID
      |
      v
normalized Event Store
```

Session is the long-lived interactive context. Execution is one run within
that context, and a Turn is the provider-level unit for that run. The launcher
only observes their lifecycle. Cleanup removes terminal dashboard records but
does not change the lifecycle of a running Session.
