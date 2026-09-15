# Phase 5.6 End-to-End Review Loop

Phase 5.6 validates the existing development loop without changing the Control
Plane or Review Data Plane contracts:

```text
Understand -> Execute -> Observe -> Review -> Approve
```

## Validation scenario

`tests/e2e/review-loop.test.ts` creates a temporary Git workspace with one
committed documentation fixture. The test then:

1. discovers the authorized workspace and reads its clean review context;
2. reads and searches the fixture through `workspace_read_file` and
   `workspace_search`;
3. submits an interactive Goal through the MCP `submit_goal` path;
4. proves the requested `gpt-5.6-luna` / `max` selection is passed to the
   Codex app-server backend;
5. observes the Session, Execution, normalized events, and Launcher summary;
6. reads the resulting Git status, diff, changed file, and search hit again;
7. parses the completed ReviewResult and requires the final verdict to be
   `APPROVE`.

The provider is an in-process app-server test double so the automated test is
deterministic and does not modify this repository or create a commit. The
temporary provider event sequence is:

```text
session_started
turn_started
agent_message_delta
agent_message_completed
turn_completed
```

The resulting status contract is:

```text
Session   = completed
Execution = passed
Review    = APPROVE
```

## Responsibilities and boundaries

Control Plane owns Goal submission, Task/Execution identity, the interactive
Codex Thread/Turn, and lifecycle persistence. `SessionStore`, `EventStore`,
`StatusQueryService`, and the existing `CodexAppServerBackend` keep provider
identity separate from the LRM Execution record.

Review Data Plane owns read-only workspace understanding. It resolves the
explicit `workspace_id` through `WorkspaceRegistry`, then reuses the existing
workspace path policy, text reader, search implementation, and `GitService`.
It exposes context, file reads, search results, and bounded diff data; it does
not expose file writes, shell execution, commits, or pushes.

The Launcher remains observational. Its authenticated session catalog discovers
interactive Sessions, and its status worker reads Session status, Execution
status, and normalized events. It displays the Goal/Task, Session, Thread,
model/effort, and current status without changing the lifecycle.

## Running the validation

Run the focused E2E test:

```powershell
npm test -- tests/e2e/review-loop.test.ts --maxWorkers=1 --minWorkers=1
```

Run the Phase 5.6 release checks:

```powershell
npm run typecheck
npm run build
npm test -- --maxWorkers=1 --minWorkers=1
```

The live connector variant uses the same read-only tools and must submit
`execution_mode="interactive"`, `model="gpt-5.6-luna"`, and
`reasoning_effort="max"`. The live working tree may contain unrelated user
changes; the review must identify those explicitly and return `ITERATE` only
for a real blocking defect, never for an optional optimization.
