# Local Review MCP

## Current version

V0.1 / Task 4

## Current capabilities

- MCP Streamable HTTP runtime
- exactly six registered read-only tools
- fixed loopback host
- configurable fixed port
- startup port conflict detection
- one explicitly configured active workspace
- bounded workspace metadata, directory listing, and text-file reading
- bounded literal or regular-expression search with ripgrep and Node fallback

## Default endpoint

`http://127.0.0.1:12080/mcp`

Start the server with:

```text
npm install
npm start -- --workspace <path>
```

The port can be overridden with `--port <number>`. A JSON config file can be
provided with `--config <path>`; CLI options take precedence over the file:

```json
{
  "port": 12080,
  "workspace": "C:\\path\\to\\project"
}
```

The workspace is required; the runtime does not guess a default directory.

The current tools are `workspace_info`, `list_files`, `read_file`, and
`search_text`. `git_status` and `git_diff` remain controlled
`not_implemented` placeholders.

`search_text` accepts `query`, optional workspace-relative `path` and `glob`,
`regex`, `case_sensitive`, and `limit`. Searches are restricted to allowed
text files up to 2 MiB, with at most 200 returned results and 500 preview
characters per result.
