# Identity Evidence Troubleshooting

Phase 5.6.1 adds an observational trace for the Browser Extension to
`submit_goal` path. It does not change validation, correlation ownership,
pending expiry, Extension evidence generation, Codex execution, or Session
state.

## Lifecycle

```text
submit_goal_received
  -> pending_created
  -> extension_evidence_received
  -> evidence_match_success
  -> goal_started
```

The actual order is the order in which the runtime observes events. A
`submit_goal` request is logged when the MCP handler receives it; the pending
record is logged after its durable save. Evidence can therefore arrive before
the request is received, or after the pending record expires. The trace makes
that ordering visible instead of inferring it.

## Trace fields

Events are written as JSON Lines to:

```text
<storage root>/control-plane/identity-trace.jsonl
```

`correlation_key` and `conversation_id` in the file are SHA-256 hashes, not
the raw values. The query output renames them to
`correlation_key_hash` and `conversation_id_hash`. `workspace_id` is included
for local diagnosis. Goal and Execution identifiers are included only on
`goal_started`; message text, tokens, cookies, and Extension payloads are not
recorded.

The main event fields are:

| Event | Diagnostic fields |
| --- | --- |
| `submit_goal_received` | correlation hash, known conversation hash if already observed, workspace, execution mode |
| `pending_created` | correlation hash, `created_at`, `expires_at`, `timeout_ms`, execution mode |
| `extension_evidence_received` | evidence correlation and conversation hashes, `received_at` |
| `evidence_match_success` | matched correlation and canonical conversation hashes |
| `evidence_match_failed` | `reason` plus expected/observed hashes where available |
| `pending_expired` | creation time, expiry time, timeout duration |
| `goal_started` | goal, phase, task, and execution identifiers |

Failure reasons are:

- `missing_evidence`: resolve ran while no canonical correlation existed.
- `correlation_mismatch`: evidence arrived for a different correlation key than
  an active pending submission; `observed_correlation_key_hash` identifies the
  incoming key without revealing it.
- `conversation_mismatch`: the same correlation key attempted to claim a
  different conversation than its proven owner.
- `expired`: matching evidence was considered after the pending record's
  existing expiry boundary.

## Query

Use the read-only MCP tool:

```json
{
  "name": "get_identity_trace",
  "arguments": {
    "correlation_key": "00000000-0000-4000-8000-000000000001"
  }
}
```

The result contains ordered, hash-only events. The raw correlation key is used
only to compute the lookup hash and is not returned.

For an interactive `goal_started` result, use the existing read-only status
queries with the returned `goal_id` or `execution_id` to collect
`session_id` and `thread_id`:

```text
get_session_status({ "goal_id": "<goal_id>" })
get_execution_status({ "execution_id": "<execution_id>" })
```

## Diagnosis

1. No `pending_created`: the request did not reach durable pending creation.
2. `pending_created` but no `extension_evidence_received`: the Bridge did not
   deliver evidence to the runtime, or the Extension did not send it.
3. Evidence exists with a different correlation hash: classify as
   `correlation_mismatch`.
4. The same correlation hash has two different conversation hashes and a
   `conversation_mismatch` failure: classify as `conversation_mismatch`.
5. `pending_expired` precedes matching evidence or resolve: classify as an
   expiry race/delayed evidence, not as a validation repair.
6. `evidence_match_success` without `goal_started`: inspect the existing Goal
   submission/preflight and execution diagnostics; identity matching itself
   succeeded.

The trace is fail-soft. A trace write or read failure cannot accept evidence,
extend expiry, or otherwise change the business decision.

## Evidence transport trace

`get_evidence_transport_trace` separates the Browser Extension transport from
the identity lifecycle trace:

```json
{
  "name": "get_evidence_transport_trace",
  "arguments": {
    "correlation_key": "00000000-0000-4000-8000-000000000001"
  }
}
```

The expected successful order is:

```text
extension_evidence_created
  -> bridge_evidence_received
  -> bridge_evidence_forwarded
  -> connector_evidence_received
  -> extension_evidence_received
  -> connector_resolve_called
  -> evidence_resolve_attempted
  -> evidence_resolve_success
```

`bridge_evidence_rejected` identifies an authenticated Bridge request that
failed the existing Extension evidence schema. Missing Bridge events after
`extension_evidence_created` localize the loss between the Extension and
Bridge; missing connector or resolver events localize it after Bridge
forwarding. The transport trace is hash-only and read-only.
