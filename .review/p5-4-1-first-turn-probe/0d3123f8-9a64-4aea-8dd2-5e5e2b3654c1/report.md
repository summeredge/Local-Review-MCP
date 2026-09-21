# P5.4.1-D Create-Thread First-Turn Completion Probe

run_id: 0d3123f8-9a64-4aea-8dd2-5e5e2b3654c1
probe_status: completed
failure_class: none
artifact_dir: C:\Users\shaoy\Documents\Local-Review-MCP\.review\p5-4-1-first-turn-probe\0d3123f8-9a64-4aea-8dd2-5e5e2b3654c1
stage: wait_for_completion

## 1. Runtime

```json
{
  "desktopDetected": true,
  "bundleDetected": true,
  "mcpTransport": "stdio",
  "nativeDesktopTransport": "windows_named_pipe",
  "desktopVersion": "26.915.4065.0",
  "codexVersion": "0.155.0-alpha.9.2",
  "codexAppToolsVersion": "0.1.4",
  "pipeDiscovery": "current_environment"
}
```
workspace_path: C:\Users\shaoy\Documents\Local-Review-MCP
executor_thread_suffix: 15cba62b
target_thread_suffix: 7247c172
host_id: local

## 2. Raw Probe Sequence

1. CodexAppRuntime.connect()
2. tools/list
3. DesktopIPCObserver.currentConversationId (executor thread id)
4. list_projects
5. create_thread(prompt)
6. captureBaseline was NOT called
7. baseline constructed as { targetThreadId, hostId, turnIds: [] }
8. DesktopCompletionObserver.waitForCompletion()

## 3. Observed Tool Contracts

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

## 4. Baseline

```json
{
  "targetThreadId": "01a0c1fd-eb98-78a0-8d40-7d137247c172",
  "hostId": "local",
  "turnIds": []
}
```

## 5. read_thread Calls

- call #3: {"isError":true,"contentItemTypes":["text"],"structuredContentPresent":false}

## 6. wait_threads Calls

- no wait_threads calls were observed

## 7. Observer Result

```json
{
  "status": "unknown",
  "targetThreadId": "01a0c1fd-eb98-78a0-8d40-7d137247c172",
  "hostId": "local",
  "reason": "tool_error"
}
```

## 8. Classification

read_thread_tool_error: true
wait_threads_tool_error: false
turn_error: false
malformed_response: false
timeout: false
completed: false

## 9. Guardrails

- captureBaseline was not called; the baseline was constructed as an empty turnIds list.
- No retry or workaround logic is applied; the Observer decision is reported verbatim.
- No pipe path is recorded or printed in any artifact.

