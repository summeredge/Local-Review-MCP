# P5.3.0-B Live Completion Contract Probe

run_id: 7b696fc3-3210-4f07-9c54-a0ec4b4cd926
probe_status: completed
failure_class: none
artifact_dir: C:\Users\shaoy\Documents\Local-Review-MCP\.review\p5-3-0-b-contract-probe\7b696fc3-3210-4f07-9c54-a0ec4b4cd926

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
executor_thread_suffix: 15cba62b
target_thread_suffix: c80bcf22

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
- `$.content[0].text (embedded JSON).thread.id` = `"01a0c1c7-90bc-7b61-856b-f21fc80bcf22"`
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"active","activeFlags":[]}`
- `$.content[0].text (embedded JSON).thread.createdAt` = `1789957476`
- `$.content[0].text (embedded JSON).page.nextCursor` = `null`
- `$.content[0].text (embedded JSON).page.hasMore` = `false`
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
- `$.content[0].text (embedded JSON).turns[0].status` = `"inProgress"`
- `$.content[0].text (embedded JSON).turns[0].completedAt` = `null`
- `$.content[0].text (embedded JSON).turns[0].items[0].id` = `"fco_01a0c1c7-9263-7c21-b35c-f10c1b771bde"`
- `$.content[0].text (embedded JSON).turns[0].items[0].output` = `{"text":"<codex_delegation>\n  <source_thread_id>01a0c169-2d53-70b1-ae5a-9fec15cba62b</source_thread_id>\n  <input>Only return LRM_P530B_TURN_A_7b696fc3-3210-4f07-9c54-a0ec4b4cd926. Do not modify files. Do not create commits. Do not push.</input>\n</codex_delegation>","truncated":false}`
- `$.content[0].text (embedded JSON).turns[0].items[1].id` = `"rs_37e747d98dde420ab519b97d24e63e22"`
- `$.content[0].text (embedded JSON).turns[0].items[2].id` = `"msg_53b5ea2223a54890aff27237c0f44f8f"`
turn identity candidates:
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
status candidates:
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"active","activeFlags":[]}`
- `$.content[0].text (embedded JSON).turns[0].status` = `"inProgress"`
TURN_A marker paths: $.content[0].text, $.content[0].text (embedded JSON).turns[0].items[0].output.text, $.content[0].text (embedded JSON).turns[0].items[1].content[0].text, $.content[0].text (embedded JSON).turns[0].items[2].text
TURN_B marker paths: none

### read-immediate-after-send.json
top-level keys: content, isError
candidate fields:
- `$.content[0].text (embedded JSON).thread.id` = `"01a0c1c7-90bc-7b61-856b-f21fc80bcf22"`
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"active","activeFlags":[]}`
- `$.content[0].text (embedded JSON).thread.createdAt` = `1789957476`
- `$.content[0].text (embedded JSON).page.nextCursor` = `null`
- `$.content[0].text (embedded JSON).page.hasMore` = `false`
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
- `$.content[0].text (embedded JSON).turns[0].status` = `"inProgress"`
- `$.content[0].text (embedded JSON).turns[0].completedAt` = `null`
- `$.content[0].text (embedded JSON).turns[0].items[0].id` = `"fco_01a0c1c7-9263-7c21-b35c-f10c1b771bde"`
- `$.content[0].text (embedded JSON).turns[0].items[0].output` = `{"text":"<codex_delegation>\n  <source_thread_id>01a0c169-2d53-70b1-ae5a-9fec15cba62b</source_thread_id>\n  <input>Only return LRM_P530B_TURN_A_7b696fc3-3210-4f07-9c54-a0ec4b4cd926. Do not modify files. Do not create commits. Do not push.</input>\n</codex_delegation>","truncated":false}`
- `$.content[0].text (embedded JSON).turns[0].items[1].id` = `"rs_37e747d98dde420ab519b97d24e63e22"`
- `$.content[0].text (embedded JSON).turns[0].items[2].id` = `"msg_53b5ea2223a54890aff27237c0f44f8f"`
turn identity candidates:
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
status candidates:
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"active","activeFlags":[]}`
- `$.content[0].text (embedded JSON).turns[0].status` = `"inProgress"`
TURN_A marker paths: $.content[0].text, $.content[0].text (embedded JSON).turns[0].items[0].output.text, $.content[0].text (embedded JSON).turns[0].items[1].content[0].text, $.content[0].text (embedded JSON).turns[0].items[2].text
TURN_B marker paths: none

### read-final.json
top-level keys: content, isError
candidate fields:
- `$.content[0].text (embedded JSON).thread.id` = `"01a0c1c7-90bc-7b61-856b-f21fc80bcf22"`
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"idle"}`
- `$.content[0].text (embedded JSON).thread.createdAt` = `1789957476`
- `$.content[0].text (embedded JSON).page.nextCursor` = `null`
- `$.content[0].text (embedded JSON).page.hasMore` = `false`
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
- `$.content[0].text (embedded JSON).turns[0].status` = `"completed"`
- `$.content[0].text (embedded JSON).turns[0].completedAt` = `1789957486`
- `$.content[0].text (embedded JSON).turns[0].items[0].id` = `"fco_01a0c1c7-9263-7c21-b35c-f10c1b771bde"`
- `$.content[0].text (embedded JSON).turns[0].items[0].output` = `{"text":"<codex_delegation>\n  <source_thread_id>01a0c169-2d53-70b1-ae5a-9fec15cba62b</source_thread_id>\n  <input>Only return LRM_P530B_TURN_A_7b696fc3-3210-4f07-9c54-a0ec4b4cd926. Do not modify files. Do not create commits. Do not push.</input>\n</codex_delegation>","truncated":false}`
- `$.content[0].text (embedded JSON).turns[0].items[1].id` = `"rs_37e747d98dde420ab519b97d24e63e22"`
- `$.content[0].text (embedded JSON).turns[0].items[2].id` = `"msg_53b5ea2223a54890aff27237c0f44f8f"`
- `$.content[0].text (embedded JSON).turns[0].items[3].id` = `"fco_01a0c1c7-aa61-76b1-a6a1-de9652c2c68d"`
- `$.content[0].text (embedded JSON).turns[0].items[3].output` = `{"text":"<codex_delegation>\n  <source_thread_id>01a0c169-2d53-70b1-ae5a-9fec15cba62b</source_thread_id>\n  <input>Only return LRM_P530B_TURN_B_7b696fc3-3210-4f07-9c54-a0ec4b4cd926. Do not modify files. Do not create commits. Do not push.</input>\n</codex_delegation>","truncated":false}`
- `$.content[0].text (embedded JSON).turns[0].items[4].id` = `"msg_2ddb6086fcc14266b8a57bbdf7ab57d1"`
turn identity candidates:
- `$.content[0].text (embedded JSON).turns[0].id` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
status candidates:
- `$.content[0].text (embedded JSON).thread.status` = `{"type":"idle"}`
- `$.content[0].text (embedded JSON).turns[0].status` = `"completed"`
TURN_A marker paths: $.content[0].text, $.content[0].text (embedded JSON).turns[0].items[0].output.text, $.content[0].text (embedded JSON).turns[0].items[1].content[0].text, $.content[0].text (embedded JSON).turns[0].items[2].text
TURN_B marker paths: $.content[0].text, $.content[0].text (embedded JSON).turns[0].items[3].output.text, $.content[0].text (embedded JSON).turns[0].items[4].text

## 6. Stable Turn Identity

PARTIAL

evidence:
- baseline identity candidates: 1
- immediate identity candidates: 1
- final identity candidates: 1
- stable baseline identities: "01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"
- new turn identity values: none
- stable baseline-to-new identity pattern was not observed

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
- `$.content[0].text (embedded JSON).wake` = `{"reason":"turnCompleted","turnId":"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a","threadId":"01a0c1c7-90bc-7b61-856b-f21fc80bcf22","hostId":"local"}`
- `$.content[0].text (embedded JSON).wake.turnId` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
- `$.content[0].text (embedded JSON).polls[0].cursor` = `"58943834-d55b-460d-8360-985fb6b6806e:2"`
- `$.content[0].text (embedded JSON).polls[0].revision` = `2`
- `$.content[0].text (embedded JSON).polls[0].changed` = `true`
- `$.content[0].text (embedded JSON).polls[0].latestTurn` = `{"id":"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a","status":"completed","error":null,"startedAt":1789957476,"completedAt":1789957486,"durationMs":9346}`
- `$.content[0].text (embedded JSON).polls[0].latestAssistantMessageId` = `"msg_2ddb6086fcc14266b8a57bbdf7ab57d1"`
- `$.content[0].text (embedded JSON).polls[0].latestAssistantMessage` = `{"id":"msg_2ddb6086fcc14266b8a57bbdf7ab57d1","turnId":"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a","phase":"final_answer","text":"LRM_P530B_TURN_B_7b696fc3-3210-4f07-9c54-a0ec4b4cd926"}`
- `$.content[0].text (embedded JSON).polls[0].thread.id` = `"01a0c1c7-90bc-7b61-856b-f21fc80bcf22"`
- `$.content[0].text (embedded JSON).polls[0].thread.status` = `{"type":"idle"}`
- `$.content[0].text (embedded JSON).polls[0].latestTurn.id` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
- `$.content[0].text (embedded JSON).polls[0].latestTurn.status` = `"completed"`
- `$.content[0].text (embedded JSON).polls[0].latestTurn.completedAt` = `1789957486`
- `$.content[0].text (embedded JSON).polls[0].latestAssistantMessage.id` = `"msg_2ddb6086fcc14266b8a57bbdf7ab57d1"`
- `$.content[0].text (embedded JSON).polls[0].latestAssistantMessage.turnId` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
turn identity candidates:
- `$.content[0].text (embedded JSON).wake.turnId` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
- `$.content[0].text (embedded JSON).polls[0].latestTurn.id` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
- `$.content[0].text (embedded JSON).polls[0].latestAssistantMessage.turnId` = `"01a0c1c7-924a-7bb0-ad97-17cd5f9cfb9a"`
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

NOT READY

baseline_new_turn_correlation: PARTIAL

The marker was used only to sequence the diagnostic snapshots; it was not used as completion evidence.

## 11. Recommended P5.3.1 Design

Do not start P5.3.1 production implementation. Keep the Observer gate closed until stable turn identity, new-turn correlation, and terminal status are all proven by structured payload evidence.

## 12. Unproven Assumptions

- send_message_to_thread does not expose a request-to-turn correlation key unless one is present in the saved payload.
- wait_threads evidence is not treated as authoritative for a specific send turn.
- wait_threads.afterCursor and read_thread.cursor are not interchangeable unless a future contract explicitly proves that relationship.
- restart recovery and concurrent writers are outside this single-run probe.

## Artifact Integrity

- Tool objects and successful CallToolResult payloads were saved without completion normalization.
- No existing completionEvidence/completionScan function was used for the report conclusions.
- This probe does not create durable binding state.

