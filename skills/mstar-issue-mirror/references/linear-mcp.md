# The Linear MCP server

Open when the host's Linear tool set must be configured, or a mirror run reports no `mcp__linear__*` tools.

## The standard server

- Endpoint: `https://mcp.linear.app/mcp` over streamable HTTP. Bearer auth: the `Authorization: Bearer <token>` header, where the token is either a Linear API key or an OAuth token the host obtained — both are accepted by the server; which one you supply is the host's credential concern, not mstar's.
- A read-only variant (`/mcp/readonly`) exists for read-only work; the mirror's create/update steps need the read-write endpoint.
- The tool list is NOT versioned upstream: discover tool names and arguments at runtime from the live tool list; never hardcode them. Tools appear as `mcp__linear__<tool>` on MCP hosts.

## DSH specifics

- The `@mstar-harness/dsh` bundle ships a `linear-mcp` row (`id: linear-mcp`, streamable HTTP, `https://mcp.linear.app/mcp`, `expandTemplates: true`, header template `Bearer ${credential:MSTAR_LINEAR_TOKEN}`) with `disabled: true` by default.
- Supported token store: the DSH credentials document `~/.dsh/.credentials.yaml` (the document dsh's settings pages write and the provider watches); a credentials-record update reconnects the row by itself (`credentials/reference-updated`).
- Env fallback: while the credentials document stores no value for the reference, the launch environment and the `.env` layers (invocation cwd's `.env`, then `$DSH_HOME/.env`) are read — a change made there is ambient and needs a host restart.
- dsh 0.2.2-rc.3 has no settings page for this row: enabling it is a profile (or home) patch layer overriding `disabled: false`; the token never belongs in tracked config (a literal `Authorization` value copies a bearer token into it).
- The row carries the provider's tools, never mstar's: disabling or removing it changes nothing about the mstar MCP channel.
