# Local Review MCP

## Current version

V0.1 bootstrap / Task 1

## Current capabilities

- MCP Streamable HTTP runtime
- exactly six registered read-only tools
- fixed loopback host
- configurable fixed port
- startup port conflict detection

## Default endpoint

`http://127.0.0.1:12080/mcp`

Start the server with:

```text
npm install
npm start
```

The port can be overridden with `--port <number>`. A JSON config file can be
provided with `--config <path>`; CLI options take precedence over the file.

Workspace access, search, Git reading, authentication and Tunnel integration
will be implemented in subsequent tasks.
