/**
 * Steering helpers : the structural lineage and
 * steering-compass reads the planMode bridge consumes via an explicit
 * no-barrel import (no barrel — no bridge imports another, so there is no
 * cycle):
 *
 * - {@link isRootLikeAgent} — the root discriminator (`session.header.
 *   parentSession === undefined` ⇒ root-like; in-process subagent children
 *   stamp it at creation, and conversation forks carry it too → conservatively
 *   excluded).
 * - {@link rootAgentOf} — the `parentSession` walk from a published child to
 *   its delegating ROOT (upstream `subagent/src/continuation.ts:819-831`
 *   precedent) with the `seen`-set cycle guard.
 * - {@link steeringCompass} — the FIRST `{ITERATION_DIR}/<id>/
 *   delivery-compass.md` whose frontmatter `status` is `active` or `locked`
 *   (`resolveCompassEnforcement` parity); completed / status-less / archived
 *   compasses do not steer.
 *
 * Every read is structural (the consumers never trust the runtime shape) and
 * degrades silently: an unresolvable lineage, a missing `{ITERATION_DIR}`, or
 * an unreadable compass returns `undefined` instead of throwing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveIterationDir } from '@mstar-harness/engine'

/* ---------------------------------- structural views ---------------------------------- */

/** The agent surface the helpers read structurally (`session.header` — never trusts the runtime shape). */
interface AgentView {
  session?: {
    header?: {
      /** In-process subagent children stamp the parent session id at creation (`child-agent.ts:112`); forks carry it too (conservatively excluded). */
      parentSession?: unknown
    }
  }
}

/** The `agents` service surface the `subagent/start` root walk reads. */
interface AgentsView {
  get(id: string): unknown
}

/* ---------------------------------- root lineage ---------------------------------- */

/**
 * Root-agent discriminator (the root filter the planMode bridge decides on):
 * `header.parentSession === undefined` ⇒ root-like. Conversation forks also
 * carry `parentSession` (seed lineage) → conservatively excluded (accepted
 * boundary).
 */
export function isRootLikeAgent(agent: unknown): boolean {
  const header = (agent as AgentView | null | undefined)?.session?.header
  return header?.parentSession === undefined
}

/**
 * Resolve the ROOT agent of a published child via the `parentSession` walk
 * (upstream `subagent/src/continuation.ts:819-831` precedent): in-process
 * subagent children stamp `header.parentSession` = the parent SESSION id,
 * which IS the parent agent id (a session per agent); the walk stops at the
 * first root-like ancestor. `undefined` when unresolvable (fork lineage,
 * non-in-process provider, registry gap, or a cycle) — the decision point
 * then silently skips. Cycle guard: a `seen` set over visited session ids
 * (the upstream `liveLineage` guard) breaks on ANY revisited id — a 1-hop self-loop, a 2+ hop cycle
 * (A→B→A), or a longer malformed lineage — instead of spinning forever on
 * the synchronous `subagent/start` decision-point listeners (reachable via
 * HMR remounts, resumed/forked sessions with stale headers, or a future
 * host change). The same `subagent/start` decision-point root walk the
 * planMode bridge consumes.
 */
export function rootAgentOf(agent: unknown, agents: AgentsView): unknown | undefined {
  let current: unknown = agent
  const seen = new Set<string>()
  for (;;) {
    const header = (current as AgentView | null | undefined)?.session?.header
    if (header === undefined) return undefined
    if (header.parentSession === undefined) return current
    if (typeof header.parentSession !== 'string') return undefined
    if (seen.has(header.parentSession)) return undefined // revisited id — cycle, abandon
    seen.add(header.parentSession)
    const parent = agents.get(header.parentSession)
    if (parent === undefined) return undefined // registry gap — abandon
    current = parent
  }
}

/* ---------------------------------- steering compass ---------------------------------- */

/**
 * Locate the steering iteration compass (mirror of the engine's
 * `resolveCompassEnforcement` scan + the catalog's `steeringCompassPath`):
 * the FIRST `{ITERATION_DIR}/<id>/delivery-compass.md` whose frontmatter
 * `status` is `active` or `locked` — the directory name IS the iteration id
 * (plan-conventions `{ITERATION_DIR}/<id>/`). Completed/status-less/archived
 * compasses do not steer. Silent on any read failure (advisory degrade).
 * The same "is an active iteration steering" read the planMode bridge consumes.
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 */
export function steeringCompass(harnessDir: string): { iterationId: string } | undefined {
  const iterationsDir = resolveIterationDir(harnessDir)
  if (!existsSync(iterationsDir)) return undefined
  let entries
  try {
    entries = readdirSync(iterationsDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const compassPath = join(iterationsDir, entry.name, 'delivery-compass.md')
    if (!existsSync(compassPath)) continue
    let content: string
    try {
      content = readFileSync(compassPath, 'utf8')
    } catch {
      continue
    }
    // Frontmatter only: leading `---` fence through the closing fence; only
    // steering compasses count (resolveCompassEnforcement parity).
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (frontmatter === null || !/^status[ \t]*:[ \t]*(?:active|locked)[ \t]*$/m.test(frontmatter[1]!)) continue
    return { iterationId: entry.name }
  }
  return undefined
}
