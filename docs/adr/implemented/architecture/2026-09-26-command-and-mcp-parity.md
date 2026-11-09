# ADR: One command definition generates both the CLI and the bundled MCP surface

Status: implemented — CLI and MCP register from the same definitions and execute through one shared boundary, with a plugin-bundled in-process server.

Date: 2026-09-26

Scope: `packages/commands` (definitions, envelopes, domain handlers), `packages/cli` (CLI adapter and `src/mcp` server), and every host plugin that exposes the MCP entry.

## Problem

The MCP surface exposed only a handful of validator tools and required a globally installed `mstar` binary. A second handwritten MCP table drift away from the CLI, a read-only subset would not let an agent do ordinary work, and spawning the CLI per request retained process-exit and stdin collisions. Long-running, subprocess and stdin commands had no defined transport outcome, so an omission could look like a capability that simply did not exist.

## Decision

`packages/commands/src/definitions.ts` is the canonical command definition source. A definition owns the CLI spelling, typed input schema, declared effects, output envelope and handler. CLI registration and MCP registration both consume `getCommandDefinitions()`; every call enters `executeCommand(id, input, context)`. A transport may not append a private command.

The MCP server is bundled with the plugin, uses stdio, imports the packaged engine in-process, and never spawns a global `mstar`. The implementation lives in `packages/cli/src/mcp`; there is no separate MCP package. `init` stays CLI-only because it is the installer. Every other agent command, including dashboard, `sdd exec`, stdin effects and long-running services, is in coverage. A capability the transport cannot provide refuses with a stable effect-unavailable code naming the missing capability; silent omission is forbidden.

Both transports return the same structured envelope: success, refusal, usage or error, each with a stable code and exit class. MCP emits it as `structuredContent` plus a JSON text block, with `isError` true unless the status is `ok`.

`host` is context selection and `sessionId` is the user's main conversation session. Neither is a role, an authority upgrade, or a caller class. Shared handlers keep every existing parameter, workflow-ownership, path, transition and CAS check. No native per-call host/leaf attestation channel is a prerequisite for ordinary MCP calls; a deployment that trusts a caller-declared session id must opt in explicitly.

Seven host targets are in scope: codex, cursor, dsh, kimi, omp, opencode and zcode. Each has plugin-owned wiring and a package-level loading check. omp and opencode wiring is executable package behavior, not a documentation note. A target without loadable wiring is an open delivery gap.

`report` is one canonical command. It builds an offline issue draft: no network request, no issue creation, no file, environment, credential, shell-history or transcript read, and no execution of the reported command. Versions and host facts come only from the running surface or the caller; a missing fact is the literal `unknown`, and a caller-supplied override stays separately labeled. A finite documented redaction set is applied, the result reports field names and counts only, and the draft always asks the user to review it. Redaction is not claimed to be a guaranteed secret-free result.

## Alternatives considered

- **Child-process CLI per MCP request.** Rejected: it keeps process exits and stdin collisions and still requires an independently installed binary.
- **A read-only subset or privileged refusal on named hosts.** Rejected: it shrinks the product contract and makes ordinary work host-dependent.
- **The existing six-tool validator surface.** Rejected: it is a curated list, not the command definition.
- **A second handwritten MCP command table.** Rejected: two tables drift and falsify parity.
- **A native per-call identity bridge or broker.** Rejected: the shared handler checks are the authority, and a stdio child cannot prove its caller. The dsh identity constraints remain recorded separately in `2026-10-19-dsh-native-identity-channels.md`.
- **Requiring installed-host, browser, device or live-service runs as development acceptance.** Rejected: those are separately authorized operational checks, not development gates.

## Consequences

- The CLI remains the installer, maintainer and CI transport; the MCP surface is a peer for agent work, not a replacement.
- Definition drift is a test failure, not a documentation problem. Generated help and tool inventory are the discoverable surface.
- Adding a command reaches both transports through one definition; adding a transport means registering the same definitions.
- Host packages own loading and their native callsites, not a second authorization layer. Node or Bun with native `node:sqlite` is a documented runtime prerequisite.
- Report cannot guarantee arbitrary-secret detection. Its contract is finite redaction plus mandatory user review.
- Version alignment and doctor must cover the plugin, the engine used by the server, and the host target.
