# Local Review MCP

## Current version

V0.1 Release Candidate / Task 12

## Current capabilities

- MCP Streamable HTTP runtime
- nine read-only tools, including the workspace registry and review context tools
- fixed loopback host
- configurable fixed port
- startup port conflict detection
- Bearer-token authentication for all MCP HTTP requests
- OAuth 2.1-compatible discovery, public-client registration, PKCE, and Bearer tokens
- safe `GET /health` endpoint
- Cloudflare Tunnel provider with managed lifecycle
- a registry of authorized workspaces with legacy single-workspace compatibility
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
  "workspace": {
    "id": "project",
    "name": "Project",
    "path": "C:\\path\\to\\project"
  },
  "workspaces": [
    {
      "id": "project",
      "name": "Project",
      "path": "C:\\path\\to\\project"
    }
  ],
  "auth": { "token": "<token>" },
  "remote": { "enabled": false, "endpoint": "" },
  "supervisor": {
    "enabled": false,
    "healthIntervalSeconds": 30,
    "maxRestartAttempts": 3
  }
}
```

`workspaces` is optional for legacy configurations. When present, its entries
are the only workspaces that MCP can select; the top-level `workspace` identity
selects the active entry and is checked against the registry. A legacy string
`workspace` remains supported for direct single-workspace startup.

Set `supervisor.enabled` to `true` to run the MCP runtime under the Windows
Supervisor. It checks `/health` at the configured interval, performs at most
`maxRestartAttempts` automatic restarts, and exposes Start, Stop, Restart,
Open Log Folder, startup registration, and Exit from the Tray menu. Supervisor
logs are stored under the user's local application data directory and contain
only fixed lifecycle events.

## Production Deployment

The supported deployment path is Windows → Local Review MCP → Cloudflare Tunnel
→ ChatGPT Web custom MCP connector.

### Windows requirements

- Windows PowerShell 5.1 or PowerShell 7.
- Node.js with npm available as `node --version` and `npm --version`.
- `cloudflared` on `PATH` when `remote.enabled` is `true`. Install it from the
  [Cloudflare tunnel documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
- A workspace directory that already exists and is readable. The deployment
  scripts never create it.

From the repository root, install dependencies and build the release runtime:

```powershell
npm install
npm run build
```

Prepare the local production configuration. The example contains no real token,
endpoint, or workspace:

```powershell
Copy-Item .\config.production.example.json .\config.production.json
```

Edit `config.production.json` and set `workspace` to the project directory the
connector may review. Set `remote.tunnelName` to the existing Cloudflare Named
Tunnel name or UUID and `remote.endpoint` to its stable public HTTPS `/mcp`
endpoint. Keep `config.production.json` local; `.gitignore` excludes it.

Set the bearer token in the process environment before starting. It is not
stored in the repository:

```powershell
$env:LOCAL_REVIEW_MCP_TOKEN = "<long-random-review-token>"
```

Make sure `cloudflared` is installed. The production Supervisor runs the
configured Named Tunnel with its local credentials file. If the installation
uses a tunnel token instead, set `CLOUDFLARE_TUNNEL_TOKEN` for that same
configured tunnel. Do not put either token in source control.

Run the standard startup entry point:

```powershell
.\scripts\start-production.ps1 -Config ".\config.production.json"
```

The entry point reads the configuration, runs `preflight-check.ps1`, then
starts the existing Local Review MCP runtime. The runtime starts the Windows
Supervisor when `supervisor.enabled` is `true` and starts the Cloudflare Tunnel
when `remote.enabled` is `true`. It prints the local health endpoint and any
ready remote endpoint without printing credentials.

The preflight check verifies Node/npm, installed dependencies, required config
sections, workspace access, and port availability. A missing `cloudflared` is
fatal only when remote access is enabled. It reports an occupied port and asks
you to change `port`; it never auto-installs dependencies, creates a workspace,
or selects another port.

### Remote verification

After the tunnel reports a public endpoint, verify the deployment from a PowerShell
process that has the remote URL and token:

```powershell
$env:LOCAL_REVIEW_MCP_REMOTE_URL = "https://<public-hostname>/mcp"
$env:LOCAL_REVIEW_MCP_REMOTE_TOKEN = $env:LOCAL_REVIEW_MCP_TOKEN
.\scripts\verify-remote.ps1
```

`verify-remote.ps1` checks that unauthenticated and wrong-token health requests
return HTTP 401, the correct token returns `status=ok`, MCP `initialize` works,
and `tools/list` contains the nine read-only tools:
`workspace_info`, `list_files`, `read_file`, `search_text`, `git_status`, and
`git_diff`, plus `workspace_list`, `review_summary`, and `execution_output`.

## Remote MCP Setup

Remote access is disabled by default. Enable the Cloudflare provider with:

```json
{
  "remote": {
    "enabled": true,
    "provider": "cloudflare",
    "tunnelName": "<tunnel-name-or-uuid>",
    "endpoint": "https://<public-hostname>/mcp"
  }
}
```

Start the local runtime with an explicit workspace and token:

```powershell
$env:LOCAL_REVIEW_MCP_TOKEN = "<long-random-review-token>"
npm start -- --workspace "C:\path\to\project" --config "settings.json"
```

Install `cloudflared` and configure an existing Named Tunnel. `remote.tunnelName`
must contain its name or UUID, and `remote.endpoint` must contain the stable
public HTTPS `/mcp` URL. The Supervisor runs `cloudflared tunnel run` for that
tunnel and never creates a tunnel, changes DNS, or requests a temporary URL.

```powershell
$env:LOCAL_REVIEW_MCP_TOKEN = "<long-random-review-token>"
# Optional when using token-based credentials for the configured Named Tunnel.
$env:CLOUDFLARE_TUNNEL_TOKEN = "<cloudflare-tunnel-token>"
npm start -- --workspace "C:\path\to\project" --config "settings.json"
```

The Cloudflare provider invokes only the installed `cloudflared` executable,
does not upload configuration, and never logs credentials.
The live endpoint is returned by the provider and owned by `TunnelManager`;
`remote.tunnelName` and `remote.endpoint` are configuration inputs. No module
hardcodes a tunnel hostname.

### ChatGPT Web connector

1. In ChatGPT Web, enable the workspace's developer/custom-app capability if
   the plan requires it, then open the Apps/Connectors settings and create a
   custom MCP app.
2. Enter the HTTPS endpoint reported by `TunnelManager` or the authenticated
   `/health` response, using the `/mcp` path.
3. Select the connector's OAuth authentication option. The server publishes
   MCP protected-resource metadata, authorization-server metadata, dynamic
   client registration, and PKCE endpoints under the same public origin.
4. Scan the tools, confirm the nine read-only actions, save the draft app, and
   select it from a new chat. Ask for a code review; ChatGPT should call
   `workspace_list` first, then `review_summary`, `execution_output`,
   `workspace_info`, `git_status`, `git_diff`, `read_file`, and `search_text`
   with a `workspace_id` when selecting a registered workspace.

The exact ChatGPT Web menu labels and availability depend on the workspace
plan. The MCP endpoint itself is `/mcp`; `/health` is an authenticated
readiness check. OpenAI's current [MCP and Connectors guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
describes remote MCP server URLs and tool approval configuration.

At least one workspace is required. With a registry, the first entry is the
legacy active workspace unless the top-level `workspace` matches another
registered path. Without `workspace_id`, tools use that active workspace.

The current tools are `workspace_info`, `list_files`, `read_file`, `search_text`,
`git_status`, `git_diff`, `workspace_list`, `review_summary`, and
`execution_output`. All workspace-scoped tools except `workspace_list` accept
an optional `workspace_id`; an omitted ID preserves the active-workspace
behavior.
Git tools are bound to the selected registered workspace, do not expose Git
command arguments, and never perform write operations. `workspace_list` returns
only each workspace's stable `id` and display `name`, never its local path.
`review_summary` combines workspace metadata with Git status and diff counts.
`execution_output` only reads `.review/execution_output.json` and returns
`{"available":false}` when that file is absent; it never runs the recorded
command or accepts a file path.

The health endpoint requires the configured static `Authorization: Bearer <token>`
even on localhost and through Cloudflare Tunnel. MCP requests accept either that
legacy token or an OAuth access token. The health endpoint is
`http://127.0.0.1:<port>/health`; it returns the status, stable workspace
identifier, version, `remote_status`, `endpoint_status`, and the public endpoint
only when it is ready. It never returns tokens, credentials, local IPs, or
workspace absolute paths.

`search_text` accepts an optional `workspace_id`, `query`, workspace-relative
`path` and `glob`, `regex`, `case_sensitive`, and `limit`. Searches are
restricted to allowed text files up to 2 MiB, with at most 200 returned results
and 500 preview characters per result.

## E2E verification

The remote suite uses the same Streamable HTTP MCP client flow as a remote
connector and covers `initialize`, `tools/list`, workspace registry selection,
ordered workspace review,
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

## Security Notes

Local Review MCP intentionally provides only `read`, `search`, and `review`
capabilities through its nine registered tools. It does not provide:

- `modify` or `write_file` operations;
- `execute` or shell operations;
- `agent` or Codex/ChatGPT automation controls.

Keep `LOCAL_REVIEW_MCP_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`, and
`LOCAL_REVIEW_MCP_REMOTE_TOKEN` in the process environment or another local
secret store. Never commit tokens, `.env` files, Cloudflare credentials,
private keys, or `config.production.json`.
