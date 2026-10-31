---
packages: engine, dsh, cli
---

- **M0 read-only mirror import.** `mstar issue-sync import --project <id> [--max-pages <n>]` pulls the bound
  Linear project's issues into the store through the existing capture path: rows carry `provider='linear'`,
  `external_id` and `url`, a documented synthetic identity triple, and never merge into a local capture. A second
  run with unchanged remote state imports nothing and writes no row (the cursor makes the re-read a no-op), and a
  remote change to an already-imported item is re-planned once (`replanItem`, the new `applied → pending`
  transition) and applied exactly once. Imported rows are excluded from the local-only findings gate.
- A run advances its resumable cursor **only when the page it processed left nothing stranded**: an item still
  `failed`, or one the adapter could not map, blocks the advance so the next run re-reads that page (the overlap
  window) and the `failed → pending` retry can actually run. An unmappable item fails by identity with its page
  index and lets the rest of the page proceed.
- Probe failures keep their own cause and recovery: `linear.host-unavailable` (the host cannot reach its MCP
  service) and `linear.access-denied` (re-authorize the host) are distinct from the configuration-only
  `linear.provider-disabled`. The ingest path enforces the active-store guard, and remote revisions are compared
  as instants, never as strings.
- The dsh Linear listing adapter maps pages over an injected MCP transport: an embedded `errors` payload, an
  unmappable page or a transport failure refuses `linear.query-failed` instead of looking like an empty project,
  and no credential reaches a message. The tool inventory itself is still pending one authenticated `tools/list`
  (`specs/linear-mcp-tool-surface.md`), so the adapter runs on the documented fixture envelope.
