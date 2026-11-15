/**
 * Agent Teams identity resolution for the agent-flow ledger.
 *
 * The Agent Teams packages stay OPTIONAL: this module reads the live dsh
 * services STRUCTURALLY — no value or type import from them — so the plugin
 * keeps loading (and the ledger keeps recording nothing for team tools) on a
 * composition that mounts no team bundle. Two surfaces are consumed:
 *
 * - the service name `agentTeams` (`ctx.get('agentTeams')`). Its presence is
 *   the Team-layer probe; on dsh 0.2.2-rc.3 it exposes the task board only —
 *   there is no member or roster read.
 * - the subagent surface (`ctx.get('subagents')`): `namesOf(agent).self`
 *   names a live agent, `resolveName(caller, name, signal)` turns a
 *   model-facing member name into the child `SessionId` that
 *   `subagent/end` carries, and `listDescendants(rootSessionId, signal?)`
 *   walks the subagent tree. A teammate IS a continuable `subagent` /
 *   `subagent_fork` child, so the subagent catalog owns member identity.
 *
 * Nothing here fabricates an identity: an absent service, a read that throws,
 * or an unresolvable name all return `undefined`, and the caller records an
 * explicit unresolved continuation instead of a settle.
 */
import { asRecord } from './_shared.ts'
import { TEAM_DISPATCH_TOOLS } from './dispatch.ts'
import type { SettleOutcome } from './agent-flow.ts'

/** The stop reason vocabulary `subagent/end` carries (`SubagentStopReason`). */
export type TeamStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** The structural subagent service surface the ledger needs from `ctx.subagents`. */
export interface SubagentSurface {
  /** `{ self, parent, ... }` for one live agent: `self` is its slash path from the root. */
  namesOf(agent: unknown): unknown
  /** Resolve one member name visible to `caller` to that child's `SessionId`. */
  resolveName(caller: unknown, name: string, signal?: AbortSignal): unknown
  /** Every descendant of `rootSessionId` (the subagent tree read). */
  listDescendants(rootSessionId: string, signal?: AbortSignal): unknown
}

/** The minimum context surface needed to resolve the optional services (structural — tests pass a `Context`). */
export interface TeamServiceContext {
  get(name: string): unknown
}

/**
 * True when `name` is one of the fixed Agent Teams carriers the dispatch gate
 * owns ({@link TEAM_DISPATCH_TOOLS}). The ledger uses the SAME map as the gate,
 * so the two channels cannot drift.
 * @param name - the tool name of the in-flight call.
 */
export function isTeamDispatchToolName(name: string): boolean {
  return Object.hasOwn(TEAM_DISPATCH_TOOLS, name)
}

/**
 * True when the Agent Teams service is mounted. This is the ONE presence test
 * the ledger uses: while it is false, team tools record nothing at all (no
 * dispatch row, no pairing entry, no catalog slot).
 * @param ctx - the registrant/entry context.
 */
export function teamServicePresent(ctx: TeamServiceContext): boolean {
  try {
    const service = ctx.get('agentTeams')
    return typeof service === 'object' && service !== null
  } catch {
    return false
  }
}

/**
 * Resolve the optional `ctx.subagents` service to its structural surface. A
 * missing service, a non-object service, or a service missing any of the three
 * reads the ledger needs reports `undefined` — the documented "subagent tools
 * absent" state, never a throw.
 * @param ctx - the registrant/entry context (a structural `get` read).
 */
export function subagentSurfaceOf(ctx: TeamServiceContext): SubagentSurface | undefined {
  try {
    const service = ctx.get('subagents')
    if (typeof service !== 'object' || service === null) return undefined
    const rec = asRecord(service)
    if (typeof rec?.namesOf !== 'function' || typeof rec.resolveName !== 'function' || typeof rec.listDescendants !== 'function') return undefined
    return service as unknown as SubagentSurface
  } catch {
    return undefined
  }
}

/**
 * The live agent's own subagent-tree NAME (`namesOf(agent).self`). A missing
 * surface, a throwing read, a non-string, or an empty name yields `undefined`
 * — never a fabricated name.
 * @param surface - the resolved optional subagent surface.
 * @param agent - the live agent to name.
 */
export function agentNameOf(surface: SubagentSurface | undefined, agent: unknown): string | undefined {
  if (surface === undefined) return undefined
  try {
    const self = asRecord(surface.namesOf(agent))?.self
    return typeof self === 'string' && self !== '' ? self : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve one member NAME to its child `SessionId` through the subagent
 * surface of the carrying agent. Contained: an absent surface, a throwing
 * resolve, a missing/non-string/empty id all yield `undefined`.
 * @param surface - the resolved optional subagent surface.
 * @param caller - the exact live agent that carried the team call.
 * @param name - the model-facing member name.
 * @param signal - the call's abort signal, when the seam carries one.
 */
export async function resolveMemberId(
  surface: SubagentSurface | undefined,
  caller: unknown,
  name: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (surface === undefined || name === '') return undefined
  try {
    const id = await surface.resolveName(caller, name, signal)
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Map one `subagent/end` stop reason to the ledger's settle outcome. `aborted`
 * is an interruption (the member was stopped) and `refusal` a declined task —
 * both are `denied`, matching the jobs mapping (`killed → denied`); `error`
 * and a token-ceiling stop are `error`; only `completed` is `ok`. An
 * unrecognized reason yields `undefined` — the caller records an explicit
 * unresolved continuation rather than guessing an outcome.
 * @param stopReason - the terminal reason carried by the child settlement.
 */
export function settleOutcomeOfStopReason(stopReason: unknown): SettleOutcome | undefined {
  if (stopReason === 'completed') return 'ok'
  if (stopReason === 'aborted' || stopReason === 'refusal') return 'denied'
  if (stopReason === 'error' || stopReason === 'max-tokens') return 'error'
  return undefined
}
