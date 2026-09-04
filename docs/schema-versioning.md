# Schema versioning

## V0.1 freeze

The V0.1 Release Candidate keeps the existing tool response shapes unchanged.
There is no `schema_version` field and no `data` wrapper in the current MCP
responses.

Workspace identity remains a flat field in responses that already expose it:

```json
{
  "workspace_id": "xxx"
}
```

The current `workspace_id` meaning, type, and stability are part of the frozen
contract. This task does not add, remove, rename, or move that field.

## Future direction

If a future contract needs an explicit response envelope, the reserved design
direction is:

```json
{
  "schema_version": "1",
  "data": {}
}
```

That envelope is only a future design. Introducing it requires a separately
reviewed compatibility change; it must not be added opportunistically to the
V0.1 tools. Until then, clients consume the existing flat response objects.

## Constraints

- A schema version must describe the response shape, not change the meaning of
  an existing field silently.
- Additive fields remain the preferred evolution path for existing responses.
- Existing tools keep their current response structure until a compatibility
  decision explicitly authorizes a versioned migration.
