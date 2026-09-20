# P5.3.0-B Live Completion Contract Probe

run_id: bfe0d277-6415-484d-bab0-ac253eb1fe1e
probe_status: completed
failure_class: none
artifact_dir: C:\Users\shaoy\Documents\Local-Review-MCP\.review\p5-3-0-b-contract-probe\bfe0d277-6415-484d-bab0-ac253eb1fe1e

## 1. Runtime / Tool Versions

```json
{
  "desktopDetected": true,
  "bundleDetected": true,
  "mcpTransport": "stdio",
  "nativeDesktopTransport": "windows_named_pipe",
  "desktopVersion": "26.915.4065.0",
  "codexVersion": "0.155.0-alpha.9.2",
  "codexAppToolsVersion": "0.1.4",
  "pipeDiscovery": "current_environment",
  "discoverySource": "desktop_bundle"
}
```
workspace_path: C:\Users\shaoy\Documents\Local-Review-MCP
executor_thread_suffix: 7e5f3ade
target_thread_suffix: abccf5e6

## 2. Observed wait_threads Tool Contract

### wait_threads
```json
{
  "name": "wait_threads",
  "description": "Wait for the first of up to eight Codex threads to complete or need attention. New user input ends the wait early. Use timeoutMs: 0 for an immediate snapshot. Commentary never wakes the wait. An up-to-date cursor omits previously delivered final text; a timeout includes compact progress for all targets. Per-target failures are returned in errors.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "targets": {
        "type": "array",
        "minItems": 1,
        "maxItems": 8,
        "description": "Threads to wait for. The first target that completes or needs attention wins.",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "threadId": {
              "type": "string",
              "minLength": 1,
              "description": "Thread id to wait for."
            },
            "hostId": {
              "type": "string",
              "minLength": 1,
              "description": "Optional host id returned by create_thread or list_threads."
            },
            "afterCursor": {
              "type": "string",
              "minLength": 1,
              "description": "Optional cursor returned by an earlier wait."
            }
          },
          "required": [
            "threadId"
          ]
        }
      },
      "timeoutMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 120000,
        "description": "Maximum event-wait time in milliseconds. A bounded snapshot fetch for fresh progress may add latency. Defaults to 120000."
      }
    },
    "required": [
      "targets"
    ],
    "additionalProperties": false
  }
}
```

## 3. Observed read_thread Tool Contract

### read_thread
```json
{
  "name": "read_thread",
  "description": "Read recent status and turn summaries for one thread or chat without opening it. Use page cursors from earlier responses to read older turns.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "threadId": {
        "type": "string",
        "description": "Thread id to inspect."
      },
      "hostId": {
        "type": "string",
        "description": "Optional host id returned by create_thread or list_threads."
      },
      "cursor": {
        "type": "string",
        "description": "Optional cursor for older turns."
      },
      "turnLimit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10,
        "description": "Maximum number of turns to return."
      },
      "includeOutputs": {
        "type": "boolean",
        "description": "Whether to include truncated tool or command outputs."
      },
      "maxOutputCharsPerItem": {
        "type": "integer",
        "minimum": 0,
        "maximum": 20000,
        "description": "Maximum characters to keep for each included Codex output or chat message."
      }
    },
    "required": [
      "threadId"
    ],
    "additionalProperties": false
  }
}
```

## 4. Raw Probe Sequence

- 1. tools/list
- 2. DesktopIPCObserver.currentConversationId
- 3. list_projects
- 4. create_thread (TURN_A; one fresh target)
- 5. bounded read_thread polling until TURN_A sequencing marker
- 6. read_thread baseline
- 7. send_message_to_thread (TURN_B; same target)
- 8. immediate read_thread
- 9. wait_threads once (called when schema was safe)
- 10. bounded read_thread polling until TURN_B sequencing marker
- 11. final read_thread

## 5. read_thread Baseline vs Immediate vs Final

### read-baseline.json
top-level keys: content, isError
candidate fields:
- `$.content[0].text (embedded JSON).thread.id` = `"01a0bd36-ce7c-7da0-b9d5-f374abccf5e6"`
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"active","activeFlags":[]}`
- `$.content[0].text (embedded JSON).thread.createdAt` = `1789880880`
- `$.content[0].text (embedded JSON).page.nextCursor` = `null`
- `$.content[0].text (embedded JSON).page.hasMore` = `false`
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
- `$.content[0].text (embedded JSON).turns[0].status` = `"inProgress"`
- `$.content[0].text (embedded JSON).turns[0].completedAt` = `null`
- `$.content[0].text (embedded JSON).turns[0].items[0].id` = `"fco_01a0bd36-d002-7b10-bd39-c2bf1ee1f323"`
- `$.content[0].text (embedded JSON).turns[0].items[0].output` = `{"text":"<codex_delegation>\n  <source_thread_id>01a0bd16-3893-7721-9c92-77bc7e5f3ade</source_thread_id>\n  <input>Only return LRM_P530B_TURN_A_bfe0d277-6415-484d-bab0-ac253eb1fe1e. Do not modify files. Do not create commits. Do not push.</input>\n</codex_delegation>","truncated":false}`
turn identity candidates:
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
- `$.content[0].text (embedded JSON).turns[0].items[0].id` = `"fco_01a0bd36-d002-7b10-bd39-c2bf1ee1f323"`
status candidates:
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"active","activeFlags":[]}`
- `$.content[0].text (embedded JSON).turns[0].status` = `"inProgress"`
TURN_A marker paths: $.content[0].text, $.content[0].text (embedded JSON).turns[0].items[0].output.text
TURN_B marker paths: none

### read-immediate-after-send.json
top-level keys: content, isError
candidate fields:
- `$.content[0].text (embedded JSON).thread.id` = `"01a0bd36-ce7c-7da0-b9d5-f374abccf5e6"`
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"active","activeFlags":[]}`
- `$.content[0].text (embedded JSON).thread.createdAt` = `1789880880`
- `$.content[0].text (embedded JSON).page.nextCursor` = `null`
- `$.content[0].text (embedded JSON).page.hasMore` = `false`
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
- `$.content[0].text (embedded JSON).turns[0].status` = `"inProgress"`
- `$.content[0].text (embedded JSON).turns[0].completedAt` = `null`
- `$.content[0].text (embedded JSON).turns[0].items[0].id` = `"fco_01a0bd36-d002-7b10-bd39-c2bf1ee1f323"`
- `$.content[0].text (embedded JSON).turns[0].items[0].output` = `{"text":"<codex_delegation>\n  <source_thread_id>01a0bd16-3893-7721-9c92-77bc7e5f3ade</source_thread_id>\n  <input>Only return LRM_P530B_TURN_A_bfe0d277-6415-484d-bab0-ac253eb1fe1e. Do not modify files. Do not create commits. Do not push.</input>\n</codex_delegation>","truncated":false}`
turn identity candidates:
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
- `$.content[0].text (embedded JSON).turns[0].items[0].id` = `"fco_01a0bd36-d002-7b10-bd39-c2bf1ee1f323"`
status candidates:
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"active","activeFlags":[]}`
- `$.content[0].text (embedded JSON).turns[0].status` = `"inProgress"`
TURN_A marker paths: $.content[0].text, $.content[0].text (embedded JSON).turns[0].items[0].output.text
TURN_B marker paths: none

### read-final.json
top-level keys: content, isError
candidate fields:
- `$.content[0].text (embedded JSON).thread.id` = `"01a0bd36-ce7c-7da0-b9d5-f374abccf5e6"`
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"idle"}`
- `$.content[0].text (embedded JSON).thread.createdAt` = `1789880880`
- `$.content[0].text (embedded JSON).page.nextCursor` = `null`
- `$.content[0].text (embedded JSON).page.hasMore` = `false`
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
- `$.content[0].text (embedded JSON).turns[0].status` = `"completed"`
- `$.content[0].text (embedded JSON).turns[0].completedAt` = `1789880893`
- `$.content[0].text (embedded JSON).turns[0].items[0].id` = `"fco_01a0bd36-d002-7b10-bd39-c2bf1ee1f323"`
- `$.content[0].text (embedded JSON).turns[0].items[0].output` = `{"text":"<codex_delegation>\n  <source_thread_id>01a0bd16-3893-7721-9c92-77bc7e5f3ade</source_thread_id>\n  <input>Only return LRM_P530B_TURN_A_bfe0d277-6415-484d-bab0-ac253eb1fe1e. Do not modify files. Do not create commits. Do not push.</input>\n</codex_delegation>","truncated":false}`
- `$.content[0].text (embedded JSON).turns[0].items[1].id` = `"rs_004db0c354dfb505016aaf6a38d14887d099ad3be8bf16f818"`
- `$.content[0].text (embedded JSON).turns[0].items[2].id` = `"msg_004db0c354dfb505016aaf6a3a526487d09bf121d3ef9f733f"`
- `$.content[0].text (embedded JSON).turns[0].items[3].id` = `"fco_01a0bd36-dbf3-7dc0-a3fb-c2ecfd15e101"`
- `$.content[0].text (embedded JSON).turns[0].items[3].output` = `{"text":"<codex_delegation>\n  <source_thread_id>01a0bd16-3893-7721-9c92-77bc7e5f3ade</source_thread_id>\n  <input>Only return LRM_P530B_TURN_B_bfe0d277-6415-484d-bab0-ac253eb1fe1e. Do not modify files. Do not create commits. Do not push.</input>\n</codex_delegation>","truncated":false}`
- `$.content[0].text (embedded JSON).turns[0].items[4].id` = `"msg_09225af4ff79f529016aaf6a3d931c87d084267c6ffc091a44"`
turn identity candidates:
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
- `$.content[0].text (embedded JSON).turns[0].items[0].id` = `"fco_01a0bd36-d002-7b10-bd39-c2bf1ee1f323"`
- `$.content[0].text (embedded JSON).turns[0].items[1].id` = `"rs_004db0c354dfb505016aaf6a38d14887d099ad3be8bf16f818"`
- `$.content[0].text (embedded JSON).turns[0].items[2].id` = `"msg_004db0c354dfb505016aaf6a3a526487d09bf121d3ef9f733f"`
- `$.content[0].text (embedded JSON).turns[0].items[3].id` = `"fco_01a0bd36-dbf3-7dc0-a3fb-c2ecfd15e101"`
- `$.content[0].text (embedded JSON).turns[0].items[4].id` = `"msg_09225af4ff79f529016aaf6a3d931c87d084267c6ffc091a44"`
status candidates:
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"idle"}`
- `$.content[0].text (embedded JSON).turns[0].status` = `"completed"`
TURN_A marker paths: $.content[0].text, $.content[0].text (embedded JSON).turns[0].items[0].output.text, $.content[0].text (embedded JSON).turns[0].items[2].text
TURN_B marker paths: $.content[0].text, $.content[0].text (embedded JSON).turns[0].items[3].output.text, $.content[0].text (embedded JSON).turns[0].items[4].text

## 6. Stable Turn Identity

PROVEN

evidence:
- baseline identities: "01a0bd36-cfed-7891-b5cd-d42677cc01b0", "fco_01a0bd36-d002-7b10-bd39-c2bf1ee1f323"
- final identities: "01a0bd36-cfed-7891-b5cd-d42677cc01b0", "fco_01a0bd36-d002-7b10-bd39-c2bf1ee1f323", "rs_004db0c354dfb505016aaf6a38d14887d099ad3be8bf16f818", "msg_004db0c354dfb505016aaf6a3a526487d09bf121d3ef9f733f", "fco_01a0bd36-dbf3-7dc0-a3fb-c2ecfd15e101", "msg_09225af4ff79f529016aaf6a3d931c87d084267c6ffc091a44"
- new identity values: "rs_004db0c354dfb505016aaf6a38d14887d099ad3be8bf16f818", "msg_004db0c354dfb505016aaf6a3a526487d09bf121d3ef9f733f", "fco_01a0bd36-dbf3-7dc0-a3fb-c2ecfd15e101", "msg_09225af4ff79f529016aaf6a3d931c87d084267c6ffc091a44"
- immediate identities: "01a0bd36-cfed-7891-b5cd-d42677cc01b0", "fco_01a0bd36-d002-7b10-bd39-c2bf1ee1f323"

## 7. Terminal Turn Status

PROVEN

evidence:
- observed status fields: $.content[0].text (embedded JSON).thread.status={"type":"active","activeFlags":[]}, $.content[0].text (embedded JSON).turns[0].status="inProgress", $.content[0].text (embedded JSON).thread.status={"type":"active","activeFlags":[]}, $.content[0].text (embedded JSON).turns[0].status="inProgress", $.content[0].text (embedded JSON).thread.status={"type":"idle"}, $.content[0].text (embedded JSON).turns[0].status="completed"
- an explicit terminal-looking status/value was observed

## 8. wait_threads Evidence

### wait-after-send.json
top-level keys: content, isError
candidate fields:
- `$.content[0].text (embedded JSON).timedOut` = `false`
- `$.content[0].text (embedded JSON).wake` = `{"reason":"turnCompleted","turnId":"01a0bd36-cfed-7891-b5cd-d42677cc01b0","threadId":"01a0bd36-ce7c-7da0-b9d5-f374abccf5e6","hostId":"local"}`
- `$.content[0].text (embedded JSON).wake.turnId` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
- `$.content[0].text (embedded JSON).polls[0].cursor` = `"264c6cea-a933-43eb-8519-132cb439a71b:2"`
- `$.content[0].text (embedded JSON).polls[0].revision` = `2`
- `$.content[0].text (embedded JSON).polls[0].changed` = `true`
- `$.content[0].text (embedded JSON).polls[0].latestTurn` = `{"id":"01a0bd36-cfed-7891-b5cd-d42677cc01b0","status":"completed","error":null,"startedAt":1789880881,"completedAt":1789880893,"durationMs":12674}`
- `$.content[0].text (embedded JSON).polls[0].latestAssistantMessageId` = `"msg_09225af4ff79f529016aaf6a3d931c87d084267c6ffc091a44"`
- `$.content[0].text (embedded JSON).polls[0].latestAssistantMessage` = `{"id":"msg_09225af4ff79f529016aaf6a3d931c87d084267c6ffc091a44","turnId":"01a0bd36-cfed-7891-b5cd-d42677cc01b0","phase":"final_answer","text":"LRM_P530B_TURN_B_bfe0d277-6415-484d-bab0-ac253eb1fe1e"}`
- `$.content[0].text (embedded JSON).polls[0].thread.id` = `"01a0bd36-ce7c-7da0-b9d5-f374abccf5e6"`
- `$.content[0].text (embedded JSON).polls[0].thread.status` = `{"type":"idle"}`
- `$.content[0].text (embedded JSON).polls[0].latestTurn.id` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
- `$.content[0].text (embedded JSON).polls[0].latestTurn.status` = `"completed"`
- `$.content[0].text (embedded JSON).polls[0].latestTurn.completedAt` = `1789880893`
- `$.content[0].text (embedded JSON).polls[0].latestAssistantMessage.id` = `"msg_09225af4ff79f529016aaf6a3d931c87d084267c6ffc091a44"`
- `$.content[0].text (embedded JSON).polls[0].latestAssistantMessage.turnId` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
turn identity candidates:
- `$.content[0].text (embedded JSON).wake.turnId` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
- `$.content[0].text (embedded JSON).polls[0].latestTurn.id` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
- `$.content[0].text (embedded JSON).polls[0].latestAssistantMessage.turnId` = `"01a0bd36-cfed-7891-b5cd-d42677cc01b0"`
status candidates:
- `$.content[0].text (embedded JSON).polls[0].thread.status` = `{"type":"idle"}`
- `$.content[0].text (embedded JSON).polls[0].latestTurn.status` = `"completed"`
TURN_A marker paths: none
TURN_B marker paths: $.content[0].text, $.content[0].text (embedded JSON).polls[0].latestAssistantMessage.text

## 9. Cursor Semantics

PARTIAL

- wait_threads afterCursor in inputSchema: true
- wait_threads description says returned-by-earlier-wait: true
- read_thread cursor in inputSchema: true
- read_thread description says older-turn pagination: true
- same cursor domain/interchangeability: not proven

## 10. Production Completion Feasibility

READY

baseline_new_turn_correlation: PROVEN

The marker was used only to sequence the diagnostic snapshots; it was not used as completion evidence.

## 11. Recommended P5.3.1 Design

Use read_thread baseline/new-turn comparison as authority, with wait_threads only as an optional wake primitive. Keep marker/content validation outside the formal Observer.

## 12. Unproven Assumptions

- send_message_to_thread does not expose a request-to-turn correlation key unless one is present in the saved payload.
- wait_threads evidence is not treated as authoritative for a specific send turn.
- wait_threads.afterCursor and read_thread.cursor are not interchangeable unless a future contract explicitly proves that relationship.
- restart recovery and concurrent writers are outside this single-run probe.

## Artifact Integrity

- Tool objects and successful CallToolResult payloads were saved without completion normalization.
- No existing completionEvidence/completionScan function was used for the report conclusions.
- This probe does not create durable binding state.

