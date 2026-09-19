# P4.0 Desktop Thread Visibility Protocol PoC

This diagnostic is observation-only. It creates a second client for
`\\.\pipe\codex-ipc`, performs the existing `initialize` handshake, and
records sanitized JSONL. It never sends `start-turn`, `steer`, `interrupt`,
approval, user-input, open, navigate, or follow commands. The production
`DesktopIPCObserver`, app-server execution, and Desktop sync selection are
unchanged.

The current review of the two read-only reference projects
(`codex-with-chatgpt` and `chat-on-steroids`) found no directly reusable
implementation for Desktop IPC raw tracing, thread visibility, or following.

## Run

Build and start a one-second diagnostic:

```powershell
npm run diagnose:desktop-thread-visibility
```

Keep it running until Ctrl+C:

```powershell
npm run diagnose:desktop-thread-visibility -- --watch
```

Mark a target LRM `Session.thread_id` without sending anything for it:

```powershell
npm run diagnose:desktop-thread-visibility -- --watch --thread <Session.thread_id>
```

Use `--wait-ms <0..60000>` for a bounded run. `--pipe <path>` is available
for a test pipe. Each line is JSONL and contains a timestamp. Lifecycle lines
use `event` values `connected`, `reconnected`, `initialized`, or
`disconnected`. IPC lines use `recordType: "ipc-message"`; known broadcast
events also use their protocol event name in `event`.

Unknown messages are retained only as structural metadata: safe key names,
value types, array lengths, and object nesting. Prompt/text/content/message
payloads, authorization material, cookies, credentials, OAuth tokens, and
other sensitive values are omitted. A supplied `--thread` adds
`targetThreadMatch` when a safe conversation/thread identity is present.

## Experiment 1: ordinary Desktop conversation switching

1. Start ChatGPT Desktop.
2. Start the diagnostic with `--watch` and save stdout as JSONL.
3. Switch Desktop conversation A → B → A.
4. Keep the full timeline, including `connected`, outbound `initialize`, its
   response, `initialized`, and every inbound message.

## Experiment 2: an LRM thread

1. Run a normal LRM execution and record its `Session.thread_id`.
2. Start the diagnostic with `--watch --thread <Session.thread_id>`.
3. In Desktop, find and open that thread manually.
4. Record the timeline immediately before opening, at the opening moment, when
   `following=true` appears, after leaving the thread, and when
   `following=false` appears.

## Experiment 3: Desktop restart

1. Keep the diagnostic running.
2. Close Desktop and wait for the diagnostic's disconnect/reconnect markers.
3. Restart Desktop and manually reopen the target thread.
4. Preserve the complete new session handshake and following timeline.

## P4.0 report template

Fill this only from captured JSONL and manual timestamps; the implementation
alone is not proof of Desktop behavior.

### Observed

- Exact inbound/outbound message types, methods, event names, and safe identity
  fields.
- Exact lifecycle order around connection, initialize, Desktop switching,
  following changes, disconnect, and reconnect.

### Inferred

- Meaning suggested by the ordering, explicitly marked as inference rather
  than protocol fact.

### Unknown

- Any unobserved discovery, display, ownership, or follow behavior.

### Conclusion

Choose exactly one:

- **A.** Stable visibility/follow protocol exists and is worth further
  validation.
- **B.** A suspected protocol was observed, but evidence is insufficient;
  continue observation-only PoC work.
- **C.** No usable protocol was found; remain observation-only.

Even conclusion A does not authorize a control adapter in P4.0.
