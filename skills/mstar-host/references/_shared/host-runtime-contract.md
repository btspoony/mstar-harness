# Host runtime contract (shared)

Facts that hold **identically** on every host whose reference points here: the Node floor, MCP launch and doctor semantics, the seat-less coordination transport, and the upgrade-readiness act. This file names no host, config filename, tool field or refusal code — `references/<host>.md` owns every host difference and wins on any conflict.

## Node floor

- **One floor for every Node entrypoint: Node >=24.18.0 with native `node:sqlite`.** A harness CLI invoked from a host session runs through the installed binary's own Node entrypoint, and the explicit `node <bundle>` form is the same floor — never a second one.
- **The floor belongs to whatever executes.** A host whose own plugin code mounts as text (skills, commands, rules, agents) ships no bundled store-backed entrypoint, so it neither declares nor relaxes the floor; a host that ships or invokes Node code under its own runtime inherits it directly. A host reference that declares a Bun-hosted runtime is **not** version-gated by this floor — its Node entrypoints still are, and `engines.bun` declares its development toolchain.
- **A below-floor or missing-capability refusal is actionable and names the repair.** There is no transport or JSON fallback: a store-backed check never degrades into a weaker one to get past the runtime.

## MCP delivery

- **Launch**: the MCP server is the public CLI's `mcp` subcommand, launched as `npx @mstar-harness/cli mcp` over stdio. A CLI release containing `mcp` must be published before a launch config can resolve it; the host reference names the config file that carries the launch.
- **Context boundary**: optional `host` selects validated host context, not a role or authority; `sessionId` is the main conversation session. Per-call child-agent attribution is neither required nor performed. Shared workflow ownership, path, state-transition and CAS checks remain authoritative and decide admission.
- **Doctor and evidence**: `mstar-harness doctor --target <host-id>` reports aligned / mismatch / unavailable from the MCP launch config, checks the Node floor, and never opens `store.db`. An aligned config is not an installed-host run: load and execution evidence is separate authorized work.

## Coordination transport (no host-native seat)

- **Every coordinated write goes through the shared CLI under an independently acquired execution identity** — the ACTIVE route (`--session-ref` + the addressed scope's full execution token as `--expect` + `--operation`). There is no host-side session file, no per-call identity injection and nothing to pass down to a child: a session reference is a **lookup, not a bearer credential**, and the engine compares the acquired caller inside its own transaction (→ `mstar-use-cli/references/plan-and-workflow.md`).
- **A restart is not a re-issue.** Restarting the host or opening a new session does not re-issue an identity: a launcher that mints a local identity mints a **new** one, and a copied id is never claimed.
- **A stopped or unreachable coordinator is replaced only by the explicit recovery verb that owns the current authority** (`mstar session recover`) — never by restarting a process, re-running a command, or editing a document.

## Readiness, not an action

Refreshing an *installed* copy is a bounded, authorized ops act — an authority flip first quiesces, then reloads/upgrades (or explicitly excludes) every installed reader/writer and attests the versions it saw. Editing harness docs or source performs none of it. If this host cannot reload safely, stop at the exact manual-restart step, have the user restart, then re-verify entrypoint/runtime/version/session identity read-only before the flip.
