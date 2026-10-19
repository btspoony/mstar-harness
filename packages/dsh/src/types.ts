/**
 * `mstar-engine` catalog source + payload: the durable `catalog`-form
 * MessageSource the plugin appends to every composed step at
 * `agent/pre-step`, so the model-visible engine-status row is
 * reconstructable from the session log without re-parsing its prose
 * (model-visible ⟺ logged — dsh packages/AGENTS.md), plus the NON-persisted
 * payload that row is rendered from.
 *
 * The source is the plugin's PRODUCER-OWNED kind, not the retired
 * `{ kind: 'plugin', plugin }` wrapper: dsh session-format V4 refuses that
 * wrapper at message admission, and a source member outside the declared kind
 * is refused by the released format edges. The structured facts live in
 * {@link MstarEngineStatusPayload} instead.
 *
 * @module @mstar-harness/dsh
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { EnforcementFlag } from '@mstar-harness/engine'

/**
 * `MessageSourceMap` is merge-extensible and each producer declares its own
 * `kind` in its own module (dsh-agent's `model-selection` is the shipped
 * precedent). This is the engine-status catalog producer's declaration; the
 * `@persistenceAttribution` promise is that an unknown kind and its JSON
 * metadata stay readable without the producer, and that the kind imposes no
 * validation, replay, or authority requirement on other readers.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Engine-status catalog attribution; readers preserve the content without this producer.
     * @persistenceAttribution
     */
    'mstar-engine': { kind: 'mstar-engine' } & ContextFormed
  }
}

/**
 * The ONE unified engine-status catalog row's `source`: the plugin's
 * producer-owned kind with a CLOSED member set — exactly these two keys,
 * never a third.
 *
 * dsh session-format V4 refuses the retired `{ kind: 'plugin', plugin }`
 * wrapper at message admission, so the kind itself identifies the producer
 * and `form: 'catalog'` declares the row's context form. Everything the row
 * publishes about the workspace lives in
 * {@link MstarEngineStatusPayload}, which never rides `source`.
 *
 * Read compatibility for PERSISTED logs (not a code-compat layer): rows
 * written by released builds carry the old wrapper in their V3 session logs,
 * and the V3→V4 migration lifts them to `{ kind: 'plugin:mstar-engine',
 * form: 'catalog' }` (or `plugin:mstar-engine-status` for the pre-rename
 * identity). The panel's anchor reader accepts both migrated kinds.
 */
export interface MstarEngineStatusSource {
  readonly kind: 'mstar-engine'
  readonly form: 'catalog'
}

/**
 * The engine-status payload the model-facing row is rendered from — the
 * facts the catalog publishes BESIDE the prose (a consumer presenting the row
 * must not re-parse the `<mstar_engine_status>` block, whose framing exists
 * for the model). Deliberately NOT persisted on the message `source`: the
 * source is the closed attribution tuple above, and a released session-format
 * edge refuses extra `source` members.
 */
export interface MstarEngineStatusPayload {
  /**
   * The unified mstar version: the `@mstar-harness/dsh` plugin package
   * version (own manifest). The single-version invariant pins the bundled
   * `@mstar-harness/engine` to the same version, so one field covers both.
   */
  readonly version: string
  /** Resolved `{HARNESS_DIR}` (null when probing found none). */
  readonly harnessDir: string | null
  /** Repo-level hard-enforcement flag from the iteration compass. */
  readonly enforcement: EnforcementFlag
  /**
   * Iteration phase-gate section: present when an ACTIVE workflow and its
   * steering compass resolve (the `mstar iteration gate` tool result shape).
   */
  readonly iteration?: MstarIterationGateView
  /**
   * Workspace-state digest section: the plan registry, open residual
   * counts, branch/policy anchors, active leases, knowledge index digest
   * and the steering compass direction one-liner. Null when the workspace
   * has no harness dir or no readable workspace catalog (the state lines are absent).
   */
  readonly state: MstarHarnessState | null
}

/** JSON projection of one engine `ValidationResult` (lossless — `fix` omitted when absent). */
export interface IterationGateViolationView {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'nit'
  code: string
  message: string
  fix?: string
}

/** JSON projection of one engine gate (`GateResult`). */
export interface IterationGateListView {
  ok: boolean
  violations: IterationGateViolationView[]
}

/**
 * JSON projection of the engine `PhaseGateResult` (snake_case to match the
 * model-facing tool vocabulary of the CLI's `mstar iteration gate` — the
 * tool result shape reused verbatim by the pre-step catalog row).
 */
export interface IterationGateView {
  transition: 'phase-2-execute' | 'phase-3-close' | 'phase-4-pr-delivery'
  all_plans_done: boolean
  ok: boolean
  entry: IterationGateListView
  exit: IterationGateListView
  violations: IterationGateViolationView[]
}

/** The iteration phase-gate section of the unified engine-status row. */
export interface MstarIterationGateView {
  /** Iteration id whose steering compass was evaluated. */
  readonly iterationId: string
  /** The steering `{ITERATION_DIR}/<id>/delivery-compass.md` evaluated. */
  readonly compassPath: string
  /** Cached `evaluatePhaseGate` result (tool result shape). */
  readonly gate: IterationGateView
  /**
   * The steering compass frontmatter `status` (`'active' | 'locked'`), the
   * authoritative signal for whether Phase 1 is still in flight vs. complete
   * (spec panel-f4 §2.3 R9 / §5 D5). Optional and OMITTED when absent or
   * not one of the two steering values (lossless omit-when-absent — the
   * `iteration` key's discipline: `Session.append` rejects undefined-valued
   * properties) — old catalog rows / typed fixtures without the field keep
   * compiling and the projection degrades to the existing transition-driven
   * behavior.
   */
  readonly compassStatus?: 'active' | 'locked'
}

/** One registered plan row of the harness-state digest (id + status + completion date). */
export interface HarnessPlanView {
  readonly id: string
  readonly status: string
  /**
   * The ACTIVE plan row `done_at` (trimmed string). ALWAYS-present
   * nullable scalar: a missing/empty `done_at` projects to `null` (lossless
   * JSON — never an `undefined` property; the omit pattern is reserved for
   * optional fields like `verdict?`).
   */
  readonly doneAt: string | null
  /**
   * The ACTIVE plan row `metadata.iteration_refs` (array of iteration
   * ids the plan is registered under). ALWAYS-present array: a missing/non-array value projects
   * to `[]` — the empty default, never an omitted field (lossless JSON).
   */
  readonly iterationRefs: string[]
}

/**
 * One open issue of the harness-state digest. `id` is the issue authority's own
 * id (`I-000001` — the actionable handle for `mstar issue show`). `planId` stays
 * the display's plan-linkage slot but is EMPTY for store-backed findings: an
 * issue is plan-independent (issue contract §6) and its plan/iteration/PR links
 * are provenance, not a register bucket — the digest never guesses one.
 */
export interface ResidualFindingView {
  readonly planId: string
  /** The issue id (`I-000001`); '' when the source row carries none. */
  readonly id: string
  /** The issue's `severity` (the issue contract vocabulary, verbatim). */
  readonly severity: string
  /** The issue's `title`; '' when the source row carries none. */
  readonly title: string
}

/** Open-issue counts by severity (non-zero severities only). */
export type HarnessResidualSeverity = 'critical' | 'high' | 'medium' | 'low' | 'nit'

/** Open-issue counts by severity (non-zero severities only). */
export interface HarnessResidualView {
  readonly severity: HarnessResidualSeverity
  readonly count: number
}

/**
 * Where the workspace-state digest's open-item facts came from, and whether
 * that read was whole. `kind: 'store'` means the issue rollup AND the knowledge
 * catalog digest were read from `{HARNESS_DIR}/store.db`; `'unavailable'` means
 * the store could not serve them (missing / staged / corrupt / below-floor
 * runtime) and `diagnostic` carries the refusal verbatim — never an empty
 * "no findings" rollup. `projection` is the read envelope's own projection
 * freshness (current | stale | unavailable), so a stale projection is disclosed
 * instead of being sold as current; `null` when no envelope was read.
 *
 * ABSENT when a build ran without a store read (the synchronous
 * `buildCatalogPayload` callers — the `mstar:engine-status` context provider,
 * whose slim summary renders no open-item facts at all).
 */
export interface StoreFactsView {
  readonly kind: 'store' | 'unavailable'
  readonly projection: 'current' | 'stale' | 'unavailable' | null
  readonly storeRevision: number | null
  readonly diagnostic: string | null
}

/** One plan row's own recorded writable scope (worktree + branch). */
export interface HarnessRowScopeView {
  readonly planId: string
  readonly workingBranch: string
  readonly worktreePath: string | null
}

/**
 * Whether the store-backed roadmap authority has roadmap content, no roadmap
 * content, or could not be read. Partial coverage is explicit in
 * `absentProjectIds`; `diagnostic` carries an actionable read failure.
 */
export interface RoadmapSourceView {
  readonly kind: 'present' | 'absent' | 'unavailable'
  readonly absentProjectIds: readonly string[]
  readonly diagnostic: string | null
}

/** The additive project rollup, sourced from store authority and open issues. */
export interface MstarHarnessProject {
  /** Roadmap milestones in deterministic catalog-project order, roadmap order within each project. */
  readonly milestones: readonly string[]
  readonly roadmapSource: RoadmapSourceView
  /** Open-issue counts by severity across the harness (non-zero severities only — same rollup as `state.residuals`). */
  readonly openResiduals: readonly HarnessResidualView[]
}

/**
 * The catalog's workflow selection result (compass v3.0.0 § Catalog
 * selection rule): the lifecycle the state section aggregates, resolved by
 * the locked binding order — row scope (a plan row's `metadata.worktree_path`
 * containing the session cwd) → cwd (a
 * `control_worktree_path` containing it) → the session's durable
 * `selectedWorkflowId` → the only active entry. `terminal` = the latest
 * terminal snapshot by mtime (history view; reachable only when the active
 * registry is EMPTY); `error` = a clear selection failure (v1/unmigrated
 * root, no snapshots, or N>1 active lifecycles with no binding — then
 * `activeWorkflowIds` carries the picker rows) — never a root v1 read and
 * never the registry's first entry. Structured and panel-renderable (not
 * only a log line).
 */
export type WorkflowSelectionView =
  | {
      readonly kind: 'active'
      /** The selected active lifecycle id (a root v2 `workflows[]` entry). */
      readonly workflowId: string
      /** Harness-relative workflow dir (e.g. `workflows/<id>`). */
      readonly dir: string
      /** Structured warning attached by a resolver, when it has one. */
      readonly warning?: { readonly code: string; readonly message: string }
    }
  | {
      readonly kind: 'terminal'
      readonly workflowId: string
      readonly dir: string
    }
  | {
      readonly kind: 'error'
      readonly code: string
      readonly message: string
      /**
       * Present on the multi-active-unbound error: the validated active ids,
       * in registry order — the actionable rows of the operator's picker.
       */
      readonly activeWorkflowIds?: readonly string[]
    }

/**
 * The workspace-state digest section of the unified engine-status row: the
 * plan registry, open residual counts, branch/policy anchors, active
 * leases, knowledge index digest and the steering compass direction
 * one-liner. All fields come from the same per-workspace cached build as
 * the rest of the row (one ACTIVE execution graph / compass / knowledge-index read
 * per cache refresh — the TTL-bounded staleness tradeoff documented on
 * `buildCatalogPayload`).
 */
export interface MstarHarnessState {
  /**
   * The selected workflow lifecycle (compass v3.0.0 § Catalog selection
   * rule): active `workflows[]` first → latest terminal snapshot by mtime →
   * clear error. The state section aggregates the SELECTED lifecycle only;
   * a selection error carries the operator-visible reason (never a root v1
   * read).
   */
  readonly selection: WorkflowSelectionView
  /**
   * The selected workflow snapshot's top-level `type` (`plan` / `iteration`),
   * projected loose (`string`) like `HarnessPlanView.status`. ALWAYS-present
   * nullable scalar (lossless JSON, never omitted): missing/empty → `null`;
   * `null` on selection error (no snapshot read). Added for the slim
   * `mstar:engine-status` digest.   */
  readonly workflowType: string | null
  /**
   * The selected workflow snapshot's top-level lifecycle `status`
   * (`running` / `paused`; a terminal word for a stale-but-registered entry,
   * decision D3). Same ALWAYS-present nullable discipline as `workflowType`.
   */
  readonly workflowStatus: string | null
  /** Registered plan rows (`plan_id`/`id` + `status`), snapshot plans[] order. */
  readonly plans: readonly HarnessPlanView[]
  /** Open issue counts by severity (non-zero only) — the issue authority's own rollup. */
  readonly residuals: readonly HarnessResidualView[]
  /**
   * The additive project rollup (compass v3.0.0 AC-4 — the panel's fifth
   * zone): store-authoritative roadmap milestones plus open-issue counts.
   * Always-present (lossless), including an explicit roadmap-source verdict.
   */
  readonly project: MstarHarnessProject
  /**
   * Open issue detail (issue id + severity + title), in the issue authority's
   * own order (severity rank desc → last real activity desc → id asc) and
   * capped at 10. Null when the store could not be read (advisory — same null
   * pattern as `knowledge`, and `storeFacts` carries the refusal); `[]` when
   * the authority was read and holds no open issue. Independent of the
   * `residuals` rollup.
   */
  readonly residualFindings: readonly ResidualFindingView[] | null
  /** `metadata.iteration_base_branch` (compass frontmatter fallback), null when absent. */
  readonly iterationBaseBranch: string | null
  /** `metadata.target_branch` (compass frontmatter fallback), null when absent. */
  readonly targetBranch: string | null
  /** `metadata.spec_integration_branch`, null when absent. */
  readonly specIntegrationBranch: string | null
  /** `metadata.push_policy`, null when absent. */
  readonly pushPolicy: string | null
  /** `metadata.worktree_mode`, null when absent. */
  readonly worktreeMode: string | null
  /** `integration_worktree_path`, null when absent. */
  readonly integrationWorktreePath: string | null
  /** Plan rows' own recorded writable scope (worktree + branch). */
  readonly rowScopes: readonly HarnessRowScopeView[]
  /** Knowledge catalog digest (docs count + categories) from the DB catalog, null when the store could not be read. */
  readonly knowledge: { readonly docCount: number; readonly categories: readonly string[] } | null
  /**
   * The open-item authority disclosure: where `residuals` / `residualFindings`
   * / `knowledge` came from and whether that read was whole. ABSENT when the
   * build ran without a store read (see {@link StoreFactsView}).
   */
  readonly storeFacts?: StoreFactsView
  /** Steering compass direction one-liner (problem statement digest), null when unavailable. */
  readonly direction: string | null
  /**
   * Actual subagent flow evidence (the agent-flow ledger read — spec
   * §2.1.3/§2.2): the latest dispatch/settle events (≤50) plus a role ×
   * outcome summary over the same window. Null when the ledger file is
   * missing or unreadable (advisory degrade — the agent-flow line is absent
   * from the model text). Rendered text stays ~1 compact line (only when
   * `events.length > 0`); the event detail lives in this structured source
   * only. Same TTL as the rest of the state section (the catalog cache
   * refreshes the ledger read at most once per `catalogTtlMs`).
   */
  readonly agentFlow: AgentFlowView | null
}

/**
 * One agent-flow ledger event in the catalog view. Optional fields (dispatch/
 * settle + the W-B2 `workflow-*` kinds — plan  ) are OMITTED (never `undefined`-valued properties — `Session.append`
 * rejects non-lossless JSON) using the `iterationViolationView` omit pattern.
 */
export interface AgentFlowEventView {
  readonly ts: number
  readonly kind: 'dispatch' | 'settle' | 'subagent-link' | 'workflow-run' | 'workflow-agent' | 'workflow-run-end' | 'workflow-verdict'
  /** The session's stable id; null when the event carried none. */
  readonly agent: string | null
  /** Assignment `Execute as` ('' for settle rows without a paired identity). */
  readonly role: string
  readonly planId: string | null
  readonly taskId: string | null
  readonly taskCategory: string | null
  /** Gate verdict (dispatch + workflow-verdict events only; `ask` is the workflow-verdict pending-decision member). */
  readonly verdict?: 'ok' | 'advisory' | 'denied' | 'ask'
  /** resolveDispatchHard result (dispatch events only). */
  readonly hard?: boolean
  /** Settle outcome (settle events only). */
  readonly outcome?: 'ok' | 'error' | 'denied'
  /** Settle duration in ms (settle events only, when recorded). */
  readonly durationMs?: number | null
  /**
   * Settle rows only : true when
   * the settle carries the PAIRED dispatch's identity (`role`/`planId`/
   * `taskId` — same fields + semantics as the dispatch event) — the client
   * pairs exactly on that identity. ABSENT on unpaired (legacy) settles →
   * they stay unpaired (honest, no owner+time guessing).
   */
  readonly paired?: boolean
  /** Workflow run identity (workflow events only). */
  readonly runId?: string
  /** Workflow run display name (workflow-run events only). */
  readonly name?: string
  /** Run-member 1-based sequence within the run (workflow-agent events only). */
  readonly seq?: number
  /** Run-member display label (workflow-agent events), or the delegation label a `subagent-link` correlated (link events). */
  readonly label?: string
  /** Run-member phase — workflow-agent events only, when carried. */
  readonly phase?: string
  /**
   * The child session identity the row carries, when its source supplied one:
   * workflow-agent rows — the published member's child; settle rows — the
   * returned foreground `runId`, or a background child id the catalog join
   * supplied (OMITTED when the completion knew none); `subagent-link` rows —
   * the required catalog child id. Never a registry job id (that is
   * `taskRef`) and never fabricated.
   */
  readonly childId?: string
  /**
   * Settle + `subagent-link` rows: the registry background-job id the row
   * carries (`jobs.events` settled notification → `recordJobSettle`; the
   * post-execute background branch for a link). A jobs-registry key
   * (`<kind>-N`), never a child session id or Assignment `Task N` tag. A
   * continuable link omits it (that path starts no registry job).
   */
  readonly taskRef?: string
  /** Terminal workflow run reason (workflow-run-end events only). */
  readonly stopReason?: 'completed' | 'cancelled' | 'error'
  /** The matched workflow/ralph tool name (workflow-verdict events only). */
  readonly tool?: 'workflow' | 'ralph'
  /** The workflow `meta.name` (workflow-verdict events only). */
  readonly workflow?: string
  /** The ralph `objective` (workflow-verdict events only). */
  readonly objective?: string
  /** The effective `workflowGate` mode at decision time (workflow-verdict events only). */
  readonly mode?: 'off' | 'warn' | 'ask' | 'hard'
  /** The policy violation code (workflow-verdict events only, non-ok verdicts). */
  readonly code?: string
  /**
   * The live tool-call id the row's own seam observed (dispatch and settle
   * rows only): the call-scoped pairing identity that keeps two concurrent
   * same-identity dispatches distinct. Absent when the seam supplied none —
   * never fabricated.
   */
  readonly callId?: string
}

/**
 * The projected catalog view of the explicit unresolved-continuation marker
 * (the unresolved-continuation projection): a NONTERMINAL `continuation` row —
 * NOT a settle. A member of {@link AgentFlowView}'s event window ADDITIVELY:
 * every existing event view keeps its shape, and the client projection guards
 * each field read, so the added kind is a data member of the wire — not a
 * union break.
 */
export interface AgentFlowContinuationEventView {
  readonly ts: number
  readonly kind: 'continuation'
  /** The dispatching session's stable id; null when the row carried none. */
  readonly agent: string | null
  /** The paired dispatch's Assignment `Execute as` ('' allowed — the dispatch row's grammar). */
  readonly role: string
  readonly planId: string | null
  readonly taskId: string | null
  /** Always null — the identity is the DISPATCH's (the same seat every identity-bearing row keeps). */
  readonly taskCategory: null
  /** The live tool-call id of the dispatch this continuation names; null when the row carried none. */
  readonly callId: string | null
  /** The continuation state — `unresolved` is the ONLY value. */
  readonly state: 'unresolved'
  /** Bounded display reason (why the continuation could not be paired). */
  readonly reason: string
}

/** One role × outcome count of the agent-flow summary (count desc). */
export interface AgentFlowSummaryRow {
  readonly role: string
  readonly outcome: string
  readonly count: number
}

/** The catalog's agent-flow evidence: latest events first (≤ limit) + summary. The event element is the FULL projected union — dispatch/settle/workflow/link rows AND the nonterminal `continuation` rows the runtime emits (a typed consumer narrows per kind; no cast, no unsafe reads). */
export interface AgentFlowView {
  readonly events: readonly (AgentFlowEventView | AgentFlowContinuationEventView)[]
  readonly summary: readonly AgentFlowSummaryRow[]
}
