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
  persisted records. A later refresh can load them again.
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
