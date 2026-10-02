# LocalReviewLauncher Execution Dashboard

The PySide6 launcher shows one row per Execution: batch Executions and
interactive Executions appear in the same table. It does not submit, stop,
resume, approve, or otherwise control a Goal, Execution, Codex Thread, or Turn.
Task records can be cleared from the dedicated task tab; running Sessions are
retained.

## Data source

The launcher uses the local MCP runtime's authenticated, loopback-only
Execution catalog endpoint (`/launcher/executions`) as the dashboard data
source:

```text
Execution catalog (execution_id, task_id, goal_id, name, execution_mode,
                   backend, status, started_at, finished_at, summary,
                   and the optional Session extension)
        |
list_session_events          (interactive Executions with a Session only)
```

The catalog is built from the durable Execution records, so an Execution is
listed whether or not it owns a Session. Goal and Session links are optional
enrichment: a missing or damaged link degrades that one row (the launcher
renders `—`) and never fails the whole dashboard query. A workspace that is not
registered on the runtime can never appear in the catalog, and the endpoint
adds no MCP tool, so the MCP tool list and the existing execution chain remain
unchanged.

The launcher never reads `.codex`, rollout files, app-server files, provider
JSON-RPC payloads, or Codex transcripts directly. Batch Execution routing and
interactive routing are untouched: an interactive Execution is created by
desktop_codex_app or codex_app_server, and a batch Execution is created by the
CLI backend and creates no Session.

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
  uses the Desktop capability first, then the standalone app-server fallback
```

A connected Desktop conversation whose exact `conversationId` matches no LRM
Session is reported as `Source: Desktop IPC` with `Association: Unmatched`.
Multiple exact Session matches are `Association: Conflict`; neither case is
silently converted into fallback. The Manager is read-only and keeps its
derived state in memory.

## Desktop Capability status

The same overview block shows the Desktop IPC transport, Desktop identity, and
codex_app tools pipe separately. They are read from the runtime's existing
authenticated status endpoints. P5.9 also exposes the negotiated execution
capability and user actions:

```text
Desktop IPC: Connected          |  Desktop IPC: Disconnected
Desktop Identity: Ready         |  Desktop Identity: Waiting for activation
Tools Pipe: Active              |  Tools Pipe: Pending / Unavailable
Capability: pipeSource=handoff  |  Capability: Waiting for Desktop activation
```

Desktop IPC is the loopback socket transport. Desktop Identity is ready only
when the observer has a non-empty `ownerClientId`. Tools Pipe is the handoff
lifecycle (`Active`, `Pending`, or `Unavailable`), without exposing a pipe path.
Only a ready capability (`handoff`, or the runtime's own `current_environment`
fallback) satisfies the preflight that `desktop_codex_app` execution needs. The
block refreshes with the same five-second status worker as Desktop Sync and is
read-only with respect to the Desktop pipe: the launcher never reads the named
pipe or posts a handoff. When the capability state is `desktop_failed`, the
launcher can request `recheck` for that execution or select the standalone
app-server fallback. Recheck only reads the existing Desktop capability again;
it never posts a new handoff or triggers SessionStart.
During `desktop_pending` it shows `Desktop: Pending / Waiting for handoff`.
After a failure it shows the failure reason and `error_code`, keeps **Retry
Desktop** and **Use Standalone** available, and displays the remaining
automatic-fallback countdown. An automatic selection is shown as
`Fallback activated`, `Provider: Standalone`, with `Desktop handoff timeout`
as its reason. The expandable Capability Timeline shows the same decision path,
including `fallback_waiting` and `fallback_selected`.

## Capability Doctor

The same overview exposes **Run Doctor**, which calls the authenticated,
loopback-only `/launcher/doctor` endpoint. The report is intentionally an
observation layer: it reads the current MCP runtime, Desktop observer, handoff
lifecycle, trampoline configuration, standalone backend configuration, and
Codex app-server protocol health without creating an Execution or changing the
capability snapshot. The Codex app-server probe performs only `initialize` and
`model/list`, then closes its diagnostic client; it never starts a Thread or a
Turn. The most recent report is shown in memory with its total status, check
items, and preserved failure reasons.

## Dashboard

The Execution Dashboard shows one row per Execution with:

- Name. The Goal phase objective and the planned Task goal are used when the
  Goal link resolves; the stable `task_id` and `execution_id` are the fallback.
- Mode (`interactive` or `batch`) and backend. The mode comes from the persisted
  Goal `execution_mode`; the backend keeps the internal identity
  (`desktop_codex_app`, `codex_app_server`, `cli`) and is displayed as Desktop,
  AppServer, or CLI Batch.
- Status, Workspace, start time, and finish time. The status is the stored
  Execution status: Running, Passed, or Failed, colored with the launcher's
  existing green / amber / red status colors.

The launcher keeps the persisted model and effort. It does not query a model
catalog or select a provider default. The normal `submit_goal` default remains
`execution_mode: batch`, and a batch Execution is shown as a first-class row
without creating a Session for it.

When no Execution is discoverable, the dashboard shows:

```text
暂无执行记录
```

## Execution details and events

Select a dashboard row to view its Execution, and its Session when one exists:

```text
Execution: execution_id, Goal / Task, Workspace, mode, backend, status,
           started_at, finished_at, summary
Session:   session_id, thread_id, backend_type, model, reasoning_effort,
           updated_at
```

A batch Execution has no Session and no event stream, which is a normal state:

```text
Session：—
Thread：—
Batch Execution 无 Session 事件流
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
  persisted records. Automatic refreshes keep cleared terminal Executions hidden,
  while active or new Executions remain visible; manual **刷新状态** reloads all.
- **清理持久化任务记录** removes `passed` / `failed` / `terminated` Executions for all registered
  Workspace, including batch Executions that have no Session. It also removes
  Events and completed, failed, or terminated Sessions linked to those terminal
  interactive Executions. Running Executions and Sessions are retained; a Task
  is removed only when no Execution or Session still needs it. The existing
  authenticated loopback endpoint reports each deleted record count and asks
  for confirmation.

## Opening a Codex Task

**线程信息** is a locator entry point. This launcher does not automate Codex
Desktop or a browser. It is enabled only for an interactive Execution that is
backed by `desktop_codex_app` and has a Thread ID; an AppServer Session, a
batch Execution, or a missing Thread ID keeps it disabled. When it is
available, it displays:

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
LRM Execution --------------- provider Turn ID / status / summary
      |
      +-- optional LRM Session  -- provider Thread ID (interactive only)
      |
      v
normalized Event Store (interactive Executions)
```

The Execution is the primary object the launcher observes: every batch and
interactive run is one row. A Session is the long-lived interactive context of
one Execution, and a Turn is the provider-level unit for that run. The launcher
only observes their lifecycle, and it never creates a Session for a batch
Execution. Cleanup removes terminal dashboard records but does not change the
lifecycle of a running Session.
