# Local Review MCP

## Current version

V0.1 / Task 8

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

Remote access is disabled by default. Enable the Cloudflare provider with:

```json
{
  "remote": {
    "enabled": true,
    "provider": "cloudflare",
    "endpoint": "https://review.example/mcp"
  }
}
```

For a stable named tunnel, set `CLOUDFLARE_TUNNEL_TOKEN` and configure the
public hostname as `remote.endpoint` or `CLOUDFLARE_TUNNEL_ENDPOINT`. The
provider invokes the installed `cloudflared` executable without uploading
configuration or logging credentials. Without a token, it uses a temporary
Cloudflare URL reported by `cloudflared`.

The workspace is required; the runtime does not guess a default directory.

The current tools are `workspace_info`, `list_files`, `read_file`, `search_text`,
`git_status`, and `git_diff`. Git tools are bound to the configured workspace,
do not expose Git command arguments, and never perform write operations.

MCP requests require `Authorization: Bearer <token>` even on localhost and
through Cloudflare Tunnel. The health endpoint is
`http://127.0.0.1:<port>/health`; it returns the status, stable workspace
identifier, version, `remote_status`, `endpoint_status`, and the public endpoint
only when it is ready. It never returns tokens, credentials, local IPs, or
workspace absolute paths.

`search_text` accepts `query`, optional workspace-relative `path` and `glob`,
`regex`, `case_sensitive`, and `limit`. Searches are restricted to allowed
text files up to 2 MiB, with at most 200 returned results and 500 preview
characters per result.
