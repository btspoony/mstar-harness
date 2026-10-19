/**
 * Agent Teams identity resolution for the agent-flow ledger (plan
 * 20261019-dsh-delegation-channels, Task 4).
 *
 * The official Agent Teams packages are EXPERIMENTAL and stay OPTIONAL: this
 * module reads them STRUCTURALLY — no value or type import from
 * `@deepseek-ai/dsh-experimental-agent-team` / `-tool-agent-team` — so the
 * plugin keeps loading (and the ledger keeps recording nothing for team
 * tools) on a composition that mounts no team bundle. Two verified surfaces
 * are consumed:
 *
 * - the service name `agentTeams` (`ctx.get('agentTeams')`), whose
 *   `listMembers(agent)` roster read carries each teammate's child
 *   `SessionId` next to its durable `name`;
 * - the tool result of `spawn_teammate`, which the tool package deliberately
 *   STRIPS of the child `SessionId` (`modelMember` removes `id` and exposes
 *   `target: name`) — so the result names the member, it does not identify
 *   the child. The roster read is what turns that name into the identity
 *   `subagent/end` carries.
 *
 * Nothing here fabricates an identity: an absent service, a roster read that
 * throws, or a name the roster no longer lists all return `undefined`, and the
 * caller records an explicit unresolved continuation instead of a settle.
 */
import { asRecord } from './_shared.ts'
import { TEAM_DISPATCH_TOOLS } from './dispatch.ts'
import type { SettleOutcome } from './agent-flow.ts'

/** The stop reason vocabulary `subagent/end` carries (`SubagentStopReason`). */
export type TeamStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** The structural service surface the ledger needs from `ctx.agentTeams`. */
export interface TeamRosterRead {
  /**
   * List the roster visible to one Team member. Service-level rows carry
   * `id` (the child `SessionId`) and `name` (the model-facing target the
   * spawning tool returned); the tool layer strips `id`, the service row
   * does not.
   */
  listMembers(agent: unknown): unknown
}

/** The minimum context surface needed to resolve the optional service (structural — tests pass a `Context`). */
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
 * Resolve the optional `ctx.agentTeams` service to its roster read. A missing
 * service, a non-object service, or a service without a callable
 * `listMembers` reports `undefined` — the documented "team packages absent"
 * state, never a throw.
 * @param ctx - the registrant/entry context (a structural `get` read).
 */
export function teamRosterOf(ctx: TeamServiceContext): TeamRosterRead | undefined {
  try {
    const service = ctx.get('agentTeams')
    if (typeof service !== 'object' || service === null) return undefined
    const listMembers = asRecord(service)?.listMembers
    if (typeof listMembers !== 'function') return undefined
    return service as unknown as TeamRosterRead
  } catch {
    return undefined
  }
}

/**
 * True when the experimental Agent Teams service is mounted. This is the ONE
 * presence test the ledger uses: while it is false, team tools record nothing
 * at all (no dispatch row, no pairing entry, no catalog slot).
 * @param ctx - the registrant/entry context.
 */
export function teamServicePresent(ctx: TeamServiceContext): boolean {
  return teamRosterOf(ctx) !== undefined
}

/**
 * The model-facing member NAME a successful `spawn_teammate` result names
 * (`{ member: { target } }` — the tool's `modelMember` projection). A missing,
 * non-string, or empty target yields `undefined` (never a fabricated name).
 * @param value - the tool result's `value` payload.
 */
export function memberNameOfSpawnResult(value: unknown): string | undefined {
  const member = asRecord(asRecord(value)?.member)
  const target = member?.target
  return typeof target === 'string' && target.trim() !== '' ? target : undefined
}

/**
 * Whether the `spawn_teammate` result itself proves the member is gone: the
 * upstream tool throws on creation failure and records a durable `failed`
 * row, so a returned `phase: 'failed'` / `status: 'failed'` is the only
 * successful-return shape that does. The name stays permanently consumed
 * upstream; the ledger settles `error` instead of waiting for a turn that can
 * never run.
 * @param value - the tool result's `value` payload.
 */
export function memberFailedOfSpawnResult(value: unknown): boolean {
  const member = asRecord(asRecord(value)?.member)
  return member?.phase === 'failed' || member?.status === 'failed'
}

/**
 * Resolve one teammate NAME to its child `SessionId` through the roster of the
 * carrying (Lead) agent. Contained: an absent service, an unreadable roster,
 * or a missing/duplicate name yields `undefined`. Names are unique per Team
 * upstream; the FIRST exact match is returned (a duplicate would be an
 * upstream contract violation, and never a second guess is made here).
 * @param roster - the resolved optional roster read.
 * @param agent - the exact live agent that carried the team call.
 * @param name - the model-facing member name.
 */
export function memberIdOfName(roster: TeamRosterRead | undefined, agent: unknown, name: string): string | undefined {
  if (roster === undefined || agent === undefined || agent === null || name === '') return undefined
  try {
    const members = roster.listMembers(agent)
    if (!Array.isArray(members)) return undefined
    for (const entry of members) {
      const row = asRecord(entry)
      if (row?.name !== name) continue
      const id = row.id
      return typeof id === 'string' && id !== '' ? id : undefined
    }
  } catch {
    return undefined
  }
  return undefined
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
