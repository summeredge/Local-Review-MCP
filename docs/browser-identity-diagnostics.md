# Browser identity evidence: persistent diagnostics

## Current conclusion (2026-09-17)

The successful hash `b6ecc5921bd445b4e5f3994b3da05b5300a811dbaf90987ee32bbc18d7d22919`
has Bridge reception at 05:01:20Z, pending acceptance at 05:01:22Z, resolution success,
and Goal start at 05:01:24Z. The failed hash
`bafc5a0a7e1df7fd3d3b19bbb0fc26995cfca34b02bed57339548235cc508ca1`
has only submit/pending/expiry events (05:10:39Z to 05:12:39Z), no transport events.
The first historical divergence inside the extension cannot be reconstructed from these logs.
Even `extension_evidence_created` was recorded at the Bridge, after authentication, not locally
at creation. Its absence does not distinguish no send from pre-handler transport/auth failure.
The same-model `WEB:` -> `serverId$()` fix remains unchanged. No second root cause is claimed.

## One normal retest, no DevTools

1. Restart the launcher to load the rebuilt backend, reload the extension, **refresh the ChatGPT page**
   (reloading the extension alone does not replace scripts already injected into the page).
2. Make one normal `submit_goal` call with a fresh correlation key; retain its key and UTC time.
3. Read `C:\Users\shaoy\AppData\Local\LocalReviewMCP\control-plane\evidence-transport-trace.jsonl`.
   New rows have `event=browser_identity_diagnostic`, with details under `diagnostic`.
   Read `identity-trace.jsonl` and `pending-goal-submissions.json` in the same directory for the outcome.

Filter by SHA-256 of the exact correlation key. Also inspect the surrounding document/epoch/time
observations: before a key can be extracted, `correlation_key_hash` is empty; those rows cannot be
attributed definitively to a Goal. They must never be used to bind a pending Goal.

The read-only `get_evidence_transport_trace` result now includes the same
allowlisted `diagnostic` object for `browser_identity_diagnostic` rows, so the
scan branch can be inspected without reading the local JSONL directly.

Fields: `observed_at` (worker observation time), outer `timestamp` (local receipt),
`document_id_hash` (browser sender document), `conversation_id_hash` (sender route observation only),
`navigation_epoch`, `scan_id` (content scan counter; background stages use 0), `stage`, `flags`,
`assistant_tool_calls_found`, `fiber_evidence_count`. Group content scans by document/epoch/scan_id.
State changes emit immediately, unchanged stage snapshots at most once every 30 seconds,
so missing stages within one scan alone do not prove loss; consult the preceding snapshot too.

| Last observation / fields | Meaning |
| --- | --- |
| `scan_started`, route present=false | Not on an exact supported conversation route |
| `scan_busy`, scan_in_flight=true repeatedly | Previous scan is still awaiting registration/Fiber/worker; preceding stage narrows the await |
| `document_registered`, register_document_ok=false | Document registration failed; no Fiber scan is attempted |
| `fiber_scanned`, fiber_reply_received=false | MAIN-world reply timed out or postMessage failed |
| `fiber_scanned`, evidence_generated=false | Fiber replied but no validated identity evidence was produced |
| fiber_root_detected=false / messages_found=false | Current turn root / message collection unavailable |
| assistant_tool_calls_found=0 | No recognized assistant tool request in selected current turn |
| submit_goal_found=false / correlation_key_found=false | No recognized valid submit_goal candidate / no strict direct key in this turn |
| correlation_key_found=true but current_key_found=false | Earlier candidate exists in this turn but current/latest tool does not yield a key; no historical fallback |
| current_key_found=true, conversation_id_found=false | Direct key found, trusted Fiber identity absent; inspect conflict/unreadable flags |
| navigation_epoch_unchanged=false | Navigation or URL changed while scanning; evidence fenced |
| `route_checked`, fiber_route_match=false | Route and trusted Fiber conversation disagree; evidence fenced |
| `deduplicated` | This exact epoch/conversation/key was previously acknowledged |
| `worker_send_attempted` without `background_received` | Runtime messaging boundary or diagnostic delivery loss; do not infer Fiber loss |
| `background_received`, sender_source_valid=false | Browser sender document/tab identity unavailable |
| `document_authorized`, document_authorized=false | Background document/epoch ownership gate rejected evidence |
| `bridge_send_attempted` | Background entered postEvidence (includes credential discovery before HTTP); not proof of HTTP reception |
| `bridge_send_finished`, bridge_reply_ok=false | Existing Bridge delivery returned failure (discovery/auth/network/HTTP); compare normal transport traces |
| `worker_send_finished`, worker_reply_ok=false | Content received a negative/no worker reply; preceding background stages narrow cause |
| Normal `bridge_evidence_received` | Evidence reached the authenticated Bridge identity handler; continue with identity trace |

## Safety and limits

Only allowlisted booleans, bounded counters, timestamps and SHA-256 hashes are stored.
No prompts, tool payloads, cookies, bearer tokens or full Fiber props enter diagnostics.
The endpoint uses existing origin/protocol/token checks and strict schema validation. It cannot
resolve identity, refresh presence, or change Goal Preflight. Diagnostics do not pair or discover
Bridge endpoints: they use existing credentials independently of business delivery.

Worker observations first enter `chrome.storage.local.identityDiagnosticOutbox` (newest 1000 rows).
Failed diagnostic HTTP delivery retains them; a later sample retries, including after worker restart.
After Bridge connectivity/credentials recover they appear in the same local JSONL automatically.
Loss of an ACK can duplicate rows; compare stage/document/epoch/scan/time, not row count.
An outage longer than the ring capacity can evict older rows. The JSONL uses existing append-only
trace retention; this patch adds no rotation or new logging subsystem.

If the content runtime channel is completely dead, or storage fails / the worker terminates before
its asynchronous observation is persisted, that boundary cannot report through itself. Absence of
all telemetry is an instrumentation/channel gap, not evidence that Fiber found no root. The next
test requires a working heartbeat to distinguish individual upstream branches. A normal test that
succeeds also cannot prove the intermittent fault is resolved.
