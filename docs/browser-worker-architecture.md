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

The diagnostic `POST /conversation/navigate` endpoint accepts
`{ conversationId }` and returns the serializable `NavigationResult` from
`ConversationNavigator`.

The Review Delivery `POST /conversation/deliver` endpoint accepts
`{ conversationId, message }`. It navigates once, keeps the resulting Page open
for the Interaction Layer, fills and submits the message, confirms that the
page accepted it, then closes the Page. Its result is `SUBMITTED`,
`AUTH_REQUIRED`, `CONVERSATION_NOT_FOUND`, `COMPOSER_NOT_FOUND`, or
`SUBMIT_FAILED`.

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

The submission-only diagnostic uses a mock Page and exercises
`/conversation/deliver` without a ChatGPT account:

```powershell
npm run diagnose:review-submission
```

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

## Interaction and authentication

`src/browser-worker/interaction/` owns the concentrated Composer selectors and
ChatGPT page operations. It uses semantic attributes such as `data-testid`,
ARIA labels, `textarea`, and `contenteditable`; it does not expose page text,
cookies, or tokens. A successful submit clears the Composer or adds a new user
message node. A login URL or visible login control returns `AUTH_REQUIRED`.

`authStatus` remains `UNKNOWN` until an interaction observes a known state;
successful submission sets it to `READY`, and a known login page sets it to
`AUTH_REQUIRED`. The worker never fills credentials, imports cookies, or
creates a Session model. Review reply collection and completion remain outside
this task.
