# LRM Core v1 Contract

Status: frozen baseline for the current Core Consolidation. This document is
the central entry point for the stable LRM Core semantics. It records the
current contract; it does not introduce a migration, protocol negotiation, or
new runtime state machine.

## Scope

Core v1 contains the data models, strict schemas, persistence services, review
decision rules, and transport-neutral delivery interface listed below. It is
not an actuation layer. The existing MCP surface remains a read-only Data
Plane, while browser, extension, dispatcher, and Codex execution work remains
outside this contract.

The implementation names are the current source of truth:

| Contract object | Current implementation | Role |
| --- | --- | --- |
| Workspace | `WorkspaceIdentity`, `WorkspaceManager`, `WorkspaceRegistry` | Authorized local workspace identity and path boundary |
| Task | `TaskContext` / `TaskContextService` | One task in a workspace |
| Execution | `ExecutionContext` / `ExecutionContextService` | One run associated with a task |
| ReviewRequest | `ReviewRequestContext` / `ReviewRequestService` | A request to review one execution |
| ReviewSnapshot | `ReviewSnapshot` / `GitService.snapshot()` | Workspace state captured for the request |
| ReviewResult | `ReviewResult` / `ReviewResultService` | Persisted completion or failure from one delivery |
| ReviewVerdict | `ReviewVerdict` / `ReviewVerdictParser` | Schema-v1 verdict parsed from a completed result |
| LoopDecision | `LoopDecision` / `LoopController` | Derived next-step decision |
| IterationDirective | `IterationDirective` / `IterationDirectiveBuilder` | Derived, validated ITERATE payload |
| ConversationRouting | `ConversationRouting` / `ConversationRoutingService` | Authoritative review conversation target |
| ReviewDelivery | `ReviewDelivery` / `ReviewDeliveryService` | Persisted delivery lifecycle for one routing |
| ReviewDeliveryAdapter | `ReviewDeliveryAdapter` | Transport-neutral delivery boundary |

`ReviewContextProjection` is a read-only derived view over the Core records;
it is not an additional identity in the v1 chain.

## Identity chain

The semantic Core chain is fixed:

```text
Workspace
  ↓
Task
  ↓
Execution
  ↓
ReviewRequest
  ↓
ReviewResult
  ↓
ReviewVerdict
  ↓
LoopDecision
  ↓
IterationDirective
```

The review delivery branch is fixed separately:

```text
ReviewRequest
  ↓
ConversationRouting
  ↓
ReviewDelivery
```

`ReviewResult.delivery_id` must point to the delivered `ReviewDelivery`, so a
result cannot bypass the delivery branch. `ReviewVerdict` is parsed from the
completed `ReviewResult.content`; it is not a separately persisted record.

### Primary and association keys

| Object | Primary identity | Required associations |
| --- | --- | --- |
| Workspace | `id` | Registry-owned; no parent Core record |
| Task | `task_id` | `workspace_id` → Workspace |
| Execution | `(workspace_id, task_id, execution_id)` | `task_id` → Task; exact workspace match |
| ReviewRequest | `(workspace_id, review_request_id)` | `task_id` → Task; `execution_id` → Execution |
| ReviewSnapshot | `(branch, head, diff_sha256)` value attached to a request | Belongs to its `ReviewRequest`; no standalone id |
| ReviewResult | `(workspace_id, result_id)` | `review_request_id` → ReviewRequest; `delivery_id` → ReviewDelivery; exact `task_id` and `workspace_id` |
| ReviewVerdict | No persisted key; `review_request_id` | Parsed only from the matching completed ReviewResult |
| LoopDecision | `decision_id` | `workspace_id`, `task_id`, `execution_id`, `review_request_id`; `review_result_id` is absent only for `WAIT` without a result |
| IterationDirective | `directive_id` | `loop_decision_id`, `review_result_id`, `review_request_id`, `source_execution_id`, `task_id`, `workspace_id` |
| ConversationRouting | `(workspace_id, routing_id)` | `review_request_id` → ReviewRequest; `task_id` and `workspace_id` must match; `execution_id` is optional only for legacy records and is checked against the request execution |
| ReviewDelivery | `(workspace_id, delivery_id)` | `routing_id` → ConversationRouting; `conversation_id`, `task_id`, `review_request_id`, and `workspace_id` must match routing |
| ReviewDeliveryAdapter request | `delivery_id` plus the supplied chain | Carries the persisted routing target; it does not create or resolve identity |

Every cross-entity comparison is exact. Missing records, invalid schemas,
file/record identity mismatches, workspace mismatches, and inconsistent
associations fail closed. IDs are never inferred from a path, a conversation,
another task, or a “closest” record.

The one legacy compatibility rule is explicit: historical routing records may
omit `execution_id`; the routing service validates the referenced
`ReviewRequest.execution_id` rather than guessing another execution. New
routing records materialize that request execution. This compatibility rule
does not create a general identity fallback.

## Ownership and authoritative sources

| Record or decision | Owner | Authoritative source |
| --- | --- | --- |
| Workspace | Configuration owner and `WorkspaceRegistry` | Registered `{ id, name, path }`; runtime identity must match it |
| Task | `TaskContextService` | `.task/contexts/<task_id>.json` |
| Execution | `ExecutionContextService` | `.task/executions/<workspace_id>/<task_id>/<execution_id>.json` |
| ReviewRequest | `ReviewRequestService` | `.task/review_requests/<workspace_id>/<review_request_id>.json` |
| ReviewSnapshot | `ReviewRequestSnapshotCoordinator` at creation; `ReviewRequest` thereafter | `ReviewRequest.review_snapshot`; captured from the workspace Git state |
| ReviewResult | `ReviewResultService` | `.task/review_results/<workspace_id>/<result_id>.json` |
| ReviewVerdict | `ReviewVerdictParser` | The final schema-v1 verdict block in the completed ReviewResult content |
| LoopDecision | `LoopController` | The decision returned by `evaluate()` or `decide()` after identity and stale-review checks |
| IterationDirective | `IterationDirectiveBuilder` | The validated output of a legal ITERATE decision/verdict pair |
| ConversationRouting | `ConversationRoutingService` | `.task/conversation_routings/<workspace_id>/<routing_id>.json`; its `conversation_id` is the formal delivery target |
| ReviewDelivery | `ReviewDeliveryService` | `.task/review_deliveries/<workspace_id>/<delivery_id>.json` and its lifecycle transitions |
| ReviewDeliveryAdapter | The injected transport implementation | Adapter result only; Core persists the resulting delivery state |

`TaskContext.conversation_id` and `ReviewRequestContext.conversation_id` are
retained compatibility metadata. They do not own delivery, cannot override
`ConversationRouting.conversation_id`, and are never used to derive routing.

## Fail-closed rules

### Schema and identity validation

Core schemas are strict Zod schemas. Stored records must match both their
schema and the identity requested by their file path. Services preserve the
existing field names, IDs, timestamps, and application-local storage layout.
Workspace runtime identity mismatches remain `WORKSPACE_IDENTITY_MISMATCH`.
Loop facts with invalid or inconsistent Task, Execution, ReviewRequest,
ReviewDelivery, ReviewResult, or snapshot identities remain
`LOOP_IDENTITY_MISMATCH`.

`ConversationRoutingService` validates the Task, Execution, ReviewRequest, and
Workspace links. `ReviewDeliveryService` additionally validates the routing
and requires the delivery conversation to equal the routing conversation.
`ReviewResultService` only creates a result for a delivered delivery and
retains the delivery and request links.

### ReviewSnapshot gate

`ReviewSnapshot` has exactly these fields:

```text
branch
head
diff_sha256
```

The snapshot is captured when a ReviewRequest is created through the snapshot
coordinator and is immutable through ReviewRequest updates. For a completed
review, `LoopController` keeps the existing stale-review gate:

```text
snapshot missing       → RETRY_REVIEW / REVIEW_SNAPSHOT_MISSING
current snapshot absent → RETRY_REVIEW / REVIEW_SNAPSHOT_UNAVAILABLE
snapshot differs       → RETRY_REVIEW / STALE_REVIEW
```

None of these cases can produce `COMPLETE` or `ITERATE`.

### Verdict and iteration gate

`ReviewVerdict` must be schema version `1`, belong to the same
`review_request_id` as the `ReviewResult`, and be parsed from a completed
result. An `IterationDirective` is produced only when all of the following are
true:

```text
LoopDecision.action = ITERATE
LoopDecision.reason_code = REVIEW_REQUIRES_ITERATION
ReviewVerdict.decision = ITERATE
ReviewVerdict.iteration is valid and non-empty
identity chain is valid
```

Non-ITERATE decisions, invalid or missing payloads, mismatched request IDs,
missing result IDs, invalid snapshots, and stale chains are rejected or mapped
to a retry/human/wait decision. No automatic iteration is started.

`CodexHandoffRenderer` only renders the existing three sections:

```text
# 修改目标
# 修改要求
# 验收标准
```

It does not start Codex, invoke a process, send a message, or perform a Git
mutation.

## Persistence compatibility boundary

Core v1 preserves the current JSON files and external behavior:

```text
<application-local state root>/.task/
├── contexts/<task_id>.json
├── executions/<workspace_id>/<task_id>/<execution_id>.json
├── review_requests/<workspace_id>/<review_request_id>.json
├── review_results/<workspace_id>/<result_id>.json
├── conversation_routings/<workspace_id>/<routing_id>.json
└── review_deliveries/<workspace_id>/<delivery_id>.json
```

Existing compatibility fields are not removed or migrated. In particular:

- optional Task and ReviewRequest `conversation_id` fields remain stored;
- optional legacy ConversationRouting `execution_id` remains readable;
- optional historical ReviewRequest `review_snapshot` remains readable;
- existing status values, filenames, and response shapes remain unchanged.

Creates continue to use the existing exclusive JSON-file behavior and
restrictive directory/file modes. Derived ReviewVerdict, LoopDecision, and
IterationDirective values are not added as a new persistence system. Core v1
does not add a schema registry, migration engine, feature flags, or protocol
negotiation. The existing verdict payload's `schema_version: 1` remains its
local format marker; no global version constant is required.

## Transport and plane boundary

Core v1 and the neutral `ReviewDeliveryAdapter` contract must not import or
own any of the following:

- Playwright `Page`, Browser Context, DOM selectors, or browser-worker modules;
- Chrome Extension state, requestId correlation runtime, or Local Control
  Bridge state;
- Dispatcher or Dispatch Command state;
- Codex process, session, or thread execution;
- arbitrary shell, write-file, commit, push, or Git mutation behavior.

The adapter interface carries typed delivery input and result data only. A
browser-specific adapter may implement it outside Core v1; the interface does
not define browser behavior. MCP remains the read-only Data Plane and does not
gain a mutation or execution tool from this contract.

The following are explicitly future Control Plane work and are not part of
Core v1:

```text
MCP Request Origin Capture
x-request-id
AsyncLocalStorage request provenance
Local Control Bridge
Chrome Extension
requestId → conversationId
Reliable Extension Delivery
Dispatch Command Broker
CodexExecutionAdapter
Controlled Actuation
Auto Iterate
Goal → Phase → Task
```

## Change rule

Later work may add capabilities around this contract, but it must not silently
change v1 identity, ownership, routing authority, stale-review behavior,
iteration eligibility, persistence fields, or the Data Plane / Control Plane
boundary. A semantic change requires a separately reviewed contract and
compatibility decision.
