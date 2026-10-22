# ADR: DSH native identity and channel constraints

- **Status:** Accepted (records upstream constraints from [issue #529](https://github.com/btspoony/mstar-harness/issues/529)); supersedes the `/mstar-execution` rationale (see below)
- **Date:** 2026-10-19
- **Scope:** `packages/dsh` (the dsh host adapter) and every future contribution that touches identity, tool gating, or command channels on the dsh host
- **Document:** `docs/adr/dsh-native-identity-channels.md` (first ADR in `docs/adr/`)

## Context

The dsh adapter once invented a human command (`/mstar-execution`) where a native
channel would have been the correct design. The upstream constraints that force
the native design are scattered across dsh runtime packages and are easy to
rediscover wrongly. This record fixes them, each with its source, so a future
contribution cannot reintroduce a bypass without confronting them.

## Constraints (upstream facts, with sources)

1. **`Agent.id` IS the session id.** A dsh agent's identity and its session
   identity are the same value; there is no separate, model-choosable identity.
   Source: `@deepseek-ai/dsh-agent` — `Agent.id`.
2. **Every tool execution receives `exec.agent`.** Per-call caller identity is
   available at the tool seam; a tool that needs the caller's identity reads it
   from the execution handle, never from model-supplied arguments.
   Source: `@deepseek-ai/dsh-tools` — tool execution receives `exec.agent`.
3. **`tools/pre-execute` returns `allow | deny | cancel | ask` only.** Hook
   verdicts cannot rewrite arguments, so the omp pattern of injecting a
   `sessionId` into `tool_call` arguments has no dsh equivalent.
   Source: dsh `tools/pre-execute` verdict union; omp counterpart for contrast:
   `packages/omp/src/extensions/mcp-identity.ts` (session-id injection into MCP
   `tool_call` arguments).
4. **The generic `dsh-mcp-client` bridge never forwards caller identity to an
   MCP server.** It opens one connection per scope and `tools/call` carries only
   the raw arguments — there is no identity-forwarding MCP bridge to piggyback
   on. Source: `@deepseek-ai/dsh-mcp-client` — connection-per-scope design,
   `tools/call` argument passthrough.
5. **Agent Teams addressing is not an identity channel.** Agent Teams expose
   `target` and deliberately no member session id; the subagent controls use
   `agent_id`, which is a session id consumed by `ctx.subagents`. Neither is a
   shell/CLI identity channel. Sources: `@deepseek-ai/dsh-agent` — Agent Teams
   `target`; `@deepseek-ai/dsh-tool-subagent` — `agent_id` consumed by
   `ctx.subagents`.
6. **`ctx.shellEnv` contributes only `DSH_*`.** The bash tool builds child
   environment from the registry and never from model arguments, so a model
   cannot mint an execution identity through environment variables.
   Sources: `@deepseek-ai/dsh-shell-env` — `ctx.shellEnv` (DSH_* keys);
   `@deepseek-ai/dsh-tool-bash` — environment built from the registry.

Upstream package/file/symbol spellings are recorded as stated in issue #529;
packages not vendored in this repository (`@deepseek-ai/dsh-shell-env`,
`@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-mcp-client`) live in the dsh
host distribution, not in this checkout.

## Superseded rationale: `/mstar-execution`

`/mstar-execution` was a plugin-owned human command (`ctx.commands` entry, hint
`{operation JSON}`) whose closed `adopt | clear | run` union carried an
execution identity from the carrying native session's header. Its design
reasoning — shell-free native launch, leaf/subagent seats refused before any
parse, no spoof or legacy env keys — was sound as far as it went, but it
invented a command where the native channels above were sufficient: a native
writable tool surface registered over `ctx.tools.register` injects identity
from `exec.agent.id` (constraints 1–2) with no shell, no argument rewriting,
and no bridge. That native path supersedes the command's reason to exist; the
command's rationale is superseded, not silently deleted. The remaining
`packages/dsh` README section describing it is historical context, kept until
the native path's own documentation replaces it.

## Consequences

- **No model-supplied identity.** Identity always comes from the carrying
  native session (`exec.agent.id`); a model argument or environment key can
  never override it.
- **No argument rewriting.** A dsh gate cannot inject a session id into call
  arguments the way omp does; identity must flow through the execution handle.
- **No identity-forwarding MCP bridge.** The generic bridge carries only raw
  arguments and cannot rewrite them, so no plugin can inject a caller's
  identity into an MCP call on the model's behalf.
- **The CONNECTION carries no identity** (supersedes the scoped-mount
  expectation above). The shared MCP connection has no `--identity-env`, no
  declared-identity lock and no connection-wide default session id: whatever a
  call puts on the wire is that call's own fact. The per-agent scoped mount was
  removed because it spawned one full process per agent and never activated
  (its bridge dependency was not on the plugin's resolution chain).
  **A command that needs an identity reads a caller-declared `sessionId` only
  on a connection whose launcher opted in** (`mstar mcp
  --trust-caller-session-id`). A stdio child cannot prove the caller, so the
  flag is the deployment's statement that it owns this connection's trust
  boundary: without it the selector is unpublished and a supplied one is
  refused with `mcp.caller-identity-unavailable`; with it the selector is
  published and the value is a BEARER identity — `executionContextFor` turns it
  into `context.caller` and the engine resolves the caller's OWN coordinator
  binding from it, so knowing a live session id is enough to act as that
  session, while authorization stays that binding row plus the optional
  `--expect` CAS token. The shipped dsh bundle row and omp's `mcp.json` pass
  the flag; a deployment that connects callers it does not trust must remove
  it, and its refusal then names the host-proven routes: the three dsh
  **native tools** (`mstar_plan_bind`, `mstar_audit_validate`,
  `mstar_execution_clear`), where identity is `exec.agent.id` and no argument
  can override it, and the CLI. On an opted-in connection those native tools
  remain the routes that own plugin-local state. The
  shared connection takes its control root as an explicit input (`--harness`,
  `MSTAR_HARNESS_DIR`, or the call's `harness` selector) — never from the launch
  cwd.
- **Agent-teams `target` / `agent_id` addressing is not a shell identity
  channel.** Delegation addressing and shell/CLI identity stay separate.
- **`shellEnv` carries only `DSH_*`.** Child environments are registry-built;
  no model-minted execution identity rides environment variables.
