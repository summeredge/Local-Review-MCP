# Browser Worker Architecture

The Browser Worker is a separate automation-layer process. Local Review MCP
continues to own only data and review context; it does not launch Playwright
or manage the worker lifecycle.

```text
MCP Runtime (data layer)
        |
Review Delivery Adapter
        |
Browser Worker Client
        |
localhost HTTP API
        |
Browser Worker (automation layer)
        |
Browser Profile Manager
        |
Playwright Persistent Browser Context
        |
Chromium
```

## Current service

The worker is implemented under `src/browser-worker/` and can be run as its
own Node process:

```powershell
npm run start:browser-worker
```

Its independent configuration defaults to `127.0.0.1:12081` in
`src/browser-worker/config.ts`. `--host` and `--port` may override the worker
process values; the host remains restricted to loopback. This configuration is
not part of `config.production.json`, and it does not change Tunnel,
Workspace Identity, or MCP settings.

The worker profile defaults to `default`. Its path is resolved below the
Browser Worker-managed directory `%LOCALAPPDATA%\LocalReviewMCP\browser-worker\profiles`
on Windows, with the platform-equivalent LocalReviewMCP application-state
directory on macOS and Linux. `--profile` may select another validated profile
name; callers cannot provide an arbitrary profile path.

The worker starts in this order:

```text
stopped -> starting -> initialize profile -> create persistent context -> ready
                              \
                               -> failed
```

`GET /health` returns `status: "ok"`, the service name, and the worker
version only when the worker is ready. `GET /info` reports Chromium and
Playwright availability. `GET /profile` reports the profile name, whether its
persistent context is created, and the current authentication status:

```json
{
  "profile": "default",
  "context": "created",
  "authStatus": "UNKNOWN"
}
```

The `POST /conversation/navigate` endpoint accepts `{ conversationId }` and
returns the `NavigationResult` from `ConversationNavigator`. Review Delivery
uses this endpoint through `BrowserWorkerClient`; it does not send Review
content.

The worker launches headless Chromium through
`chromium.launchPersistentContext()` but does not open a Conversation until a
navigation request arrives. The profile directory is owned by the Browser
Worker and may contain browser managed state; this task does not inspect,
import, or process cookies, tokens, or login information. An explicit stop
closes the persistent context, then its browser, then the HTTP server. A failed
start records `last_error` and is not automatically retried.

## Diagnostic command

```powershell
npm run diagnose:browser-worker
```

The command starts the compiled worker in a child process using the managed
`diagnostic` profile, probes `/health`, `/info`, and `/profile` over loopback,
prints the ready result, and stops the child in a `finally` block. It does not
use the production configuration or access an external website.

## C2C reference review

Before implementing this skeleton, the local C2C checkout at
`C:\Users\shaoy\Documents\Codex\codex-with-chatgpt` was inspected without
network access. There is no reusable Playwright Worker implementation there.
The useful patterns were:

* `src/process/daemon.ts` starts a detached child with `shell: false`, hidden
  Windows windows, and a dedicated append-only log file, then waits for a
  health probe before reporting success.
* `src/bridge/server.ts` binds to loopback, exposes a small public health
  response, and provides an idempotent explicit shutdown path.
* `src/bridge/runtime.ts` distinguishes a healthy process, a stopped process,
  and an uncertain health probe instead of blindly restarting.

This task applies those process and health boundaries only. It does not import
C2C Session, Agent, Conversation, Project, or state-machine concepts.

## Deliberate exclusions

This task does not implement ChatGPT login, Conversation content operations,
message sending, DOM automation, or any Session concept. `authStatus` is
currently always `UNKNOWN`; login and authentication detection belong to later
tasks and must not be inferred from a healthy worker response.
