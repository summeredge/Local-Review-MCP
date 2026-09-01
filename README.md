# Local Review MCP

## Current version

V0.1 / Task 6

## Current capabilities

- MCP Streamable HTTP runtime
- exactly six registered read-only tools
- fixed loopback host
- configurable fixed port
- startup port conflict detection
- Bearer-token authentication for all MCP HTTP requests
- safe `GET /health` endpoint
- provider-neutral manual tunnel abstraction
- one explicitly configured active workspace
- bounded workspace metadata, directory listing, and text-file reading
- bounded literal or regular-expression search with ripgrep and Node fallback
- read-only structured Git status and bounded diff review

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
  "remote": { "enabled": false, "endpoint": "" }
}
```

The workspace is required; the runtime does not guess a default directory.

The current tools are `workspace_info`, `list_files`, `read_file`, `search_text`,
`git_status`, and `git_diff`. Git tools are bound to the configured workspace,
do not expose Git command arguments, and never perform write operations.

MCP requests require `Authorization: Bearer <token>` even on localhost. The
health endpoint is `http://127.0.0.1:<port>/health`; it returns only a status,
stable workspace identifier, and version. Remote tunnel services are not
managed by this process; `remote.endpoint` records a manually managed endpoint.

`search_text` accepts `query`, optional workspace-relative `path` and `glob`,
`regex`, `case_sensitive`, and `limit`. Searches are restricted to allowed
text files up to 2 MiB, with at most 200 returned results and 500 preview
characters per result.
