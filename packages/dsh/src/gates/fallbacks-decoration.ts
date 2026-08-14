/**
 * Role-based subagent decoration at the `subagent/start` seam (plan
 * `20260814-dsh-fallbacks-integration` Task 2).
 *
 * Decoration rides the `subagent/start` EMIT — NOT `tools/pre-execute`:
 * tool args are deep-frozen snapshots and persona/`agentOptions` come from
 * the tool-subagent's own Config, never call args. The listener is
 * SYNCHRONOUS (the section must register before the child's first LLM call)
 * and resolves the published child via `ctx.get('agents')?.get(info.id)` —
 * documented in the `@deepseek-ai/dsh-subagent` event contract ("For
 * in-process providers, `ctx.agents.get(info.id)` resolves during this
 * notification"). The registered section is agent-scoped on `Agent.ctx`
 * (contributions are agent-local and unwind on disposal — the
 * hooks-claude-code precedent).
 *
 * Role identity uses the engine Assignment header grammar — the SAME
 * parsers the dispatch gate uses (`assignmentHeaderRegion` +
 * `parseAssignmentFields`) — over the child's seeded task prompt (the
 * child session's first `user/message`). Persona lookup is
 * `rolePersonas[executeAs]` DIRECTLY — never gated on `roleMap` or on the
 * fallbacks mounted state: unmounted fallbacks degrades to the same
 * Config-sourced injection with exactly one debug log (probe at the
 * decision point, no cache). `roleMap` is a taxonomy bridge for logging +
 * future rule-driven interop only.
 *
 * Degradation (the listener never throws — contained like the dispatch
 * gate's degrade path): `agents` service absent → skip + one debug log
 * (documented Known Limitation for compositions without dsh-agent);
 * child unresolved / non-Assignment / role-unmatched → silent no-op. A
 * throwing log sink is contained inside the log helper itself (plan QC
 * F-002) — the sink must not escape the listener either.
 *
 * Persona text is rendered by dsh system-prompt's STRICT `{{...}}`
 * interpolation, so persona values MUST NOT contain `{{` paired with a
 * later `}}` — the Config schema rejects such values at plugin mount (see
 * `_shared.ts` `rolePersonas` / `PERSONA_INTERPOLATION_HAZARD`).
 *
 * Module boundary: no barrel — the entry imports this module by explicit
 * relative path and re-exports the public names verbatim.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assignmentHeaderRegion, parseAssignmentFields } from '@mstar-harness/engine'
import type { Config } from './_shared.ts'
import { fallbacksMounted, fallbacksService } from './fallbacks-probe.ts'

/** Logger label for the subagent decoration (dsh logger naming: `<scope>/<subject>`). */
export const DECORATION_LOGGER = 'mstar/subagent-decoration'

/** The decoration's system-prompt section name (agent-scoped on `Agent.ctx`). */
export const PERSONA_SECTION_NAME = 'mstar:role-persona'

/** Prompt order of the persona section — renders right after the deployment persona slot (order 0). */
export const PERSONA_SECTION_ORDER = 1

/**
 * Structural view of the `subagent/start` emit payload the decoration
 * consumes (`@deepseek-ai/dsh-subagent` `SubagentRunInfo` — the plugin
 * carries no dsh-subagent dependency; same pattern as the probe's
 * `LoaderEntryView` and agent-flow's `TaskDoneSnapshot`). Only `id` is
 * consumed; the rest keeps the view faithful to the published contract.
 */
export interface SubagentRunInfoView {
  /** Unique identity shared with the paired terminal event. */
  readonly runId: unknown
  /** Provider name recorded when the child was first created. */
  readonly provider: string
  /** The child agent's id. */
  readonly id: string
  /** Snapshot of whether the run's local agent was present when start fulfilled. */
  readonly local: boolean
}

/** Decoration log levels the module sink understands. */
export type DecorationLogLevel = 'debug' | 'info' | 'warn'

/** Module-level decoration log sink — bound by `apply` to `ctx.logger(DECORATION_LOGGER)` (agent-flow ledger precedent). */
export type DecorationLogSink = (level: DecorationLogLevel, message: string) => void

let decorationLogSink: DecorationLogSink = () => {}

/**
 * Bind the decoration log sink (the entry `apply` binds it to
 * `ctx.logger(DECORATION_LOGGER)`). Returns the PRIOR sink so a caller can
 * restore it (test pattern: agent-flow `setAgentFlowLogger`).
 */
export function setDecorationLogger(sink: DecorationLogSink): DecorationLogSink {
  const prior = decorationLogSink
  decorationLogSink = sink
  return prior
}

/**
 * Minimal structural view of the `agents` service the decoration reads
 * (`@deepseek-ai/dsh-agent` `AgentRegistry` contract — the runtime read is
 * `ctx.get('agents')` without the inject requirement, narrowed onto the ONE
 * consumed surface, same pattern as the probe's loader view; the registry's
 * `get` takes a branded `SessionId` while the emit carries a plain string
 * id, so the structural surface types the read the decoration performs).
 */
interface AgentsView {
  get(id: string): Agent | undefined
}

/** One consumed prompt-section registration (`@deepseek-ai/dsh-system-prompt` `PromptSection` contract). */
interface PromptSectionInput {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** The child-scoped context surface the decoration registers through (`Agent.ctx.systemPrompt`). */
interface ChildContextView {
  systemPrompt: {
    section(section: PromptSectionInput): unknown
  }
}

/**
 * The seeded task prompt of a one-shot subagent: the child session's FIRST
 * `user/message` (the tool-subagent seeds the task as the opening user-role
 * message; at `subagent/start` emit time no turn has run yet, so the log
 * carries the seed). Read structurally from the event log — the same log
 * surface a real child carries at emit time. Undefined when the session has
 * no user message yet (seam-timing falsification — the caller degrades).
 */
function seededTaskPrompt(child: Agent): string | undefined {
  for (const event of child.session.events) {
    if (event.type !== 'user/message') continue
    const text = event.data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (text.trim().length > 0) return text
  }
  return undefined
}

/**
 * Decorate one `subagent/start` emit: resolve the child, extract its seeded
 * task prompt, and — when the prompt is Assignment-shaped and
 * `rolePersonas[executeAs]` is configured — register the persona as the
 * child's `mstar:role-persona` system-prompt section (agent-scoped on
 * `Agent.ctx`, unwinds on child disposal). Synchronous by design: the
 * section must register before the child's first LLM call.
 *
 * Never throws — every failure mode degrades (skip + one log line at most),
 * matching the dispatch gate's contained degrade path; the dispatch itself
 * is never affected.
 *
 * @param ctx - the plugin's registrant context (the app composition root).
 * @param config - validated plugin configuration (`rolePersonas` is the only
 *   payload source; `roleMap` is never consulted for injection).
 * @param info - the `subagent/start` emit payload.
 */
export function decorateSubagentStart(ctx: Context, config: Config, info: SubagentRunInfoView): void {
  try {
    // Perf guard (plan QC F-001): with `rolePersonas` unset (or empty) there
    // is nothing to decorate — skip the agents lookup and the Assignment
    // header parse entirely. The `agents`-absent debug log is intentionally
    // suppressed on this path (no persona payload exists to inject).
    const personas = config.rolePersonas
    // `== null` covers both `undefined` and `null`: schemastery's `isNullable`
    // passes `null` through the Config transform unvalidated, so the runtime
    // value can be `null` despite the TS type (QC re-review N-002).
    if (personas == null || Object.keys(personas).length === 0) return
    // The `agents` service is absent in compositions without dsh-agent —
    // skip + one debug log (documented Known Limitation), never crash.
    const agents = ctx.get('agents') as AgentsView | undefined
    if (agents === undefined) {
      log('debug', 'agents service absent — mstar:role-persona decoration skipped (composition without dsh-agent)')
      return
    }
    // Child unresolvable at emit time (e.g. non-in-process providers) →
    // silent no-op: the event contract only guarantees in-process children.
    const child = agents.get(info.id)
    if (child === undefined) return

    const taskPrompt = seededTaskPrompt(child)
    if (taskPrompt === undefined) return

    // The SAME engine Assignment grammar the dispatch gate uses: the header
    // region only, so a body-quoted field line cannot shape a decoration.
    const executeAs = parseAssignmentFields(assignmentHeaderRegion(taskPrompt)).executeAs
    if (executeAs === undefined) return

    const persona = config.rolePersonas?.[executeAs]
    if (persona === undefined || persona === '') return

    // Register the agent-scoped section on the child's own context —
    // contributions are agent-local and unwind on disposal (Agent.ctx
    // contract; hooks-claude-code precedent).
    ;(child.ctx as unknown as ChildContextView).systemPrompt.section({
      name: PERSONA_SECTION_NAME,
      order: PERSONA_SECTION_ORDER,
      text: persona,
    })

    // Decision-point probe (no cache — loader mounts entries concurrently):
    // mounted → one info-level interop log carrying the service version;
    // unmounted → same injection from Config + exactly one debug log.
    if (fallbacksMounted(ctx)) {
      log('info', `dsh-llm-fallbacks mounted (v${fallbacksService(ctx)?.version ?? 'unknown'}) — mstar:role-persona injected for role '${executeAs}'`)
    } else {
      log('debug', `dsh-llm-fallbacks unmounted — mstar:role-persona injected from mstar Config for role '${executeAs}' (decoration channel unchanged)`)
    }
  } catch (error) {
    // Contained like the gate's degrade path: skip decoration, never crash
    // the dispatch.
    log('warn', `mstar:role-persona decoration aborted (degraded — subagent dispatch unaffected): ${(error as Error).message}`)
  }
}

function log(level: DecorationLogLevel, message: string): void {
  try {
    decorationLogSink(level, message)
  } catch {
    // Never-throws invariant (plan QC F-002): a throwing log sink must not
    // escape the decoration listener — the dispatch is never affected.
  }
}
