# Local Review MCP

## Current version

V0.1 Release Candidate / Task 9

## Current capabilities

- MCP Streamable HTTP runtime
- exactly six registered read-only tools
- fixed loopback host
- configurable fixed port
- startup port conflict detection
- Bearer-token authentication for all MCP HTTP requests
- safe `GET /health` endpoint
- Cloudflare Tunnel provider with managed lifecycle
- one explicitly configured active workspace
- bounded workspace metadata, directory listing, and text-file reading
- bounded literal or regular-expression search with ripgrep and Node fallback
- read-only structured Git status and bounded diff review
- optional Windows Supervisor with health monitoring and bounded recovery
- optional Windows Tray status/actions and per-user startup registration
- Remote MCP protocol, authentication, workspace-review, and restart E2E tests

## Default endpoint

`http://127.0.0.1:12080/mcp`

Start the server with:

```text
npm install
npm start -- --workspace <path> --token <token>
```

The port can be overridden with `--port <number>`. The token can also be
provided through `LOCAL_REVIEW_MCP_TOKEN`. Token precedence is CLI, environment,
then config file. A JSON config file can be provided with `--config <path>`:

```json
{
  "port": 12080,
  "workspace": "C:\\path\\to\\project",
  "auth": { "token": "<token>" },
  "remote": { "enabled": false, "endpoint": "" },
  "supervisor": {
    "enabled": false,
    "healthIntervalSeconds": 30,
    "maxRestartAttempts": 3
  }
}
```

Set `supervisor.enabled` to `true` to run the MCP runtime under the Windows
Supervisor. It checks `/health` at the configured interval, performs at most
`maxRestartAttempts` automatic restarts, and exposes Start, Stop, Restart,
Open Log Folder, startup registration, and Exit from the Tray menu. Supervisor
logs are stored under the user's local application data directory and contain
only fixed lifecycle events.

## Remote MCP Setup

Remote access is disabled by default. Enable the Cloudflare provider with:

```json
{
  "remote": {
    "enabled": true,
    "provider": "cloudflare"
  }
}
```

Start the local runtime with an explicit workspace and token:

```powershell
$env:LOCAL_REVIEW_MCP_TOKEN = "<long-random-review-token>"
npm start -- --workspace "C:\path\to\project" --config "settings.json"
```

Install `cloudflared` and choose one of these modes:

- Quick tunnel: omit the Cloudflare tunnel token. `cloudflared` reports a
  temporary public HTTPS URL; use the URL shown by the runtime as the Remote
  MCP endpoint and append `/mcp` when needed. The URL can change after restart.
- Named tunnel: set `CLOUDFLARE_TUNNEL_TOKEN` and configure the stable public
  hostname as `remote.endpoint` or `CLOUDFLARE_TUNNEL_ENDPOINT`, for example
  `https://<public-hostname>/mcp`. A named tunnel is required when the ChatGPT
  app must reconnect after a tunnel restart without changing its endpoint.

Choose one stable endpoint input. If both are supplied, `remote.endpoint` takes
precedence over `CLOUDFLARE_TUNNEL_ENDPOINT`.

```powershell
$env:LOCAL_REVIEW_MCP_TOKEN = "<long-random-review-token>"
$env:CLOUDFLARE_TUNNEL_TOKEN = "<cloudflare-tunnel-token>"
$env:CLOUDFLARE_TUNNEL_ENDPOINT = "https://<public-hostname>/mcp"
npm start -- --workspace "C:\path\to\project" --config "settings.json"
```

The Cloudflare provider invokes only the installed `cloudflared` executable,
does not upload configuration, and never logs credentials.
The live endpoint is returned by the provider and owned by `TunnelManager`;
`remote.endpoint` and `CLOUDFLARE_TUNNEL_ENDPOINT` are only named-tunnel
configuration inputs. No module hardcodes a tunnel hostname.

### ChatGPT Web connector

1. In ChatGPT Web, enable the workspace's developer/custom-app capability if
   the plan requires it, then open the Apps/Connectors settings and create a
   custom MCP app.
2. Enter the HTTPS endpoint reported by `TunnelManager` or the authenticated
   `/health` response, using the `/mcp` path.
3. Select the connector's bearer/API-key authentication option and configure
   the value so ChatGPT sends `Authorization: Bearer <LOCAL_REVIEW_MCP_TOKEN>`.
   Do not put the token in the URL or commit it to the JSON config.
4. Scan the tools, confirm the six read-only actions, save the draft app, and
   select it from a new chat. Ask for a code review; ChatGPT should call
   `workspace_info`, `git_status`, `git_diff`, `read_file`, and `search_text`.

The exact ChatGPT Web menu labels and availability depend on the workspace
plan. The MCP endpoint itself is `/mcp`; `/health` is an authenticated
readiness check. OpenAI's current [MCP and Connectors guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
describes remote MCP server URLs and tool approval configuration.

The workspace is required; the runtime does not guess a default directory.

The current tools are `workspace_info`, `list_files`, `read_file`, `search_text`,
`git_status`, and `git_diff`. Git tools are bound to the configured workspace,
do not expose Git command arguments, and never perform write operations.

MCP and health requests require `Authorization: Bearer <token>` even on
localhost and through Cloudflare Tunnel. The health endpoint is
`http://127.0.0.1:<port>/health`; it returns the status, stable workspace
identifier, version, `remote_status`, `endpoint_status`, and the public endpoint
only when it is ready. It never returns tokens, credentials, local IPs, or
workspace absolute paths.

`search_text` accepts `query`, optional workspace-relative `path` and `glob`,
`regex`, `case_sensitive`, and `limit`. Searches are restricted to allowed
text files up to 2 MiB, with at most 200 returned results and 500 preview
characters per result.

## E2E verification

The remote suite uses the same Streamable HTTP MCP client flow as a remote
connector and covers `initialize`, `tools/list`, ordered workspace review,
Bearer authentication, safe health metadata, sensitive-file denial, traversal/
absolute/drive/symlink path denial, and tunnel stop/restart. It creates a
temporary `sample-project` Git workspace and never commits review changes.

Run the release-candidate checks locally:

```text
npm run typecheck
npm test
npm run build
```

To probe an already deployed HTTPS endpoint with the optional remote test,
provide `LOCAL_REVIEW_MCP_REMOTE_URL` and
`LOCAL_REVIEW_MCP_REMOTE_TOKEN` only in the process environment before running
the remote test. No token or public URL is stored in the repository.

Local Review MCP is intentionally limited to `read`, `search`, and `review`.
It does not provide `modify`, `execute`, or `agent` capabilities.
