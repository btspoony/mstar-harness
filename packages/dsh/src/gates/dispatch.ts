/**
 * Dispatch gate — subagent delegation gating on `tools/pre-execute` (plan
 * `20260810-dsh-entry-split` §11 extraction).
 *
 * The `tools/pre-execute` listener (`preExecuteListener`, registered by the
 * entry `apply` with `prepend`) runs the engine's SINGLE dispatch-gate
 * composition (shape guard + field gate + anti-recursion + default-branch
 * gate + header-region enforcement — opencode parity) plus the dsh-side
 * additions (worktree L1/L2 checks). The host adapter's `beforeDispatch`
 * hook shares the SAME core (`dispatchGateCore`) and the lease gate joins
 * the exec-bound listener path (`leaseGateViolations`).
 *
 * Module boundary: no barrel — the entry and the adapter import by explicit
 * relative path; public exports (`DispatchGateAdvisory`) are re-exported
 * verbatim by the entry.
 */
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { type Context } from 'cordis'
import {
  applyEnforcement,
  assignmentHeaderRegion,
  composeDispatchGate,
  executionModeToN,
  isReadOnlyAssignmentRole,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseEnforcementFlag,
  readJson,
  resolveCompassEnforcement,
  validateExecutionLease,
  verifyPlanExecutionLease,
} from '@mstar-harness/engine'
import type {
  AssignmentFields,
  GateResult,
  StatusDoc,
  ValidationResult,
  WorktreeTrack,
} from '@mstar-harness/engine'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { STATUS_FILE, asRecord, formatViolation, HarnessResolver } from './_shared.ts'
import type { Config } from './_shared.ts'
// Type-only (erased at runtime — no cycle): the adapter owns the shared
// dispatch-gate core and is constructed by the entry `apply`; the listener
// signatures type their adapter parameter through the adapter module.
import type { DshHostAdapter } from './adapter.ts'
/** Logger label for the dispatch gate (dsh logger naming: `<scope>/<subject>`). */
export const DISPATCH_LOGGER = 'mstar/dispatch-gate'

/** Default delegation tool names the dispatch gate matches (tool-subagent default id). */
const DEFAULT_DISPATCH_TOOLS = ['subagent'] as const

/** `## Assignment` heading marker (opencode parity — shape guard only). */
const ASSIGNMENT_HEADING_RE = /^#{1,6}\s+Assignment\s*$/m

/** Shape-guard match of an Assignment header field (opencode parity). */
const ASSIGNMENT_FIELD_RE =
  /^[ \t]*(?:[-*][ \t]+)?\*{0,2}(Execute as|Delegation|Task category)\*{0,2}[ \t]*:[ \t]*(\S.*)$/gm

/**
 * Advisory emitted on warn-mode dispatch-gate passes (the * `mstar/status-gate` decision reused for the dispatch gate — dsh's
 * `agent/status` lifecycle event stays untouched). Consumers (later tasks,
 * catalogs) observe this event for model-visible/session-log surfacing.
 */
export interface DispatchGateAdvisory {
  /** The matched delegation tool name. */
  tool: string
  /** The Assignment's declared `Execute as` ('' when missing). */
  role: string
  /** The gate verdict (warn-mode: `hardBlocked` is false). */
  result: GateResult
  /** Whether hard enforcement is on (advisory events are warn-mode by construction). */
  hard: boolean
  /** True when the gate errored internally and degraded to allow (structured degraded advisory). */
  degraded?: boolean
}

/**
 * True when the text looks like an Assignment (opencode parity: `## Assignment`
 * heading or at least one core field line). Non-Assignment delegation prompts
 * stay silent — no false-positive warnings. Callers MUST pass the engine
 * `assignmentHeaderRegion` slice: a `## Assignment` heading or
 * field line quoted in the task body must not shape a non-assignment prompt.
 * Exported for the agent-flow ledger's shape guard (qc2 F-2 — the shared
 * `DshHostAdapter.dispatchGate` core applies the SAME guard on both dispatch
 * surfaces, so the exec-less host-hook path records nothing for
 * non-Assignment text either).
 */
export function isAssignmentShaped(assignmentText: string): boolean {
  return ASSIGNMENT_HEADING_RE.test(assignmentText) || assignmentText.match(ASSIGNMENT_FIELD_RE) !== null
}

/**
 * Resolve the hard-enforcement flag for one dispatch: explicit Config override
 * wins, else the Assignment's OWN `Enforcement: hard` header flag (opencode
 * parity — header region only, a body-quoted example never hardens), else the
 * iteration compass frontmatter, else warn-only.
 */
export function resolveDispatchHard(harnessDir: string | null, config: Config, assignmentText: string): boolean {
  if (config.enforcement === 'hard') return true
  if (config.enforcement === 'soft') return false
  if (parseEnforcementFlag(assignmentHeaderRegion(assignmentText)).hard) return true
  return harnessDir !== null && resolveCompassEnforcement(harnessDir).hard
}

/** The hard-mode veto reason: one line per violation + the refusal channel. */
function denyReason(tool: string, verdict: GateResult): string {
  return [
    `subagent dispatch (${tool}) blocked by Enforcement: hard — the Assignment fails the dispatch gate`,
    ...verdict.violations.map(formatViolation),
    'refusal channel: tools/pre-execute PreToolDecision { kind: \'deny\' }; skill: mstar-dispatch-gates',
  ].join('\n')
}

/**
 * One lease-gate violation line (dsh-side codes live in the `lease.dispatch.*`
 * namespace; the engine emits `lease.verify.*` / `lease.execution-lease.*`).
 */
function leaseViolation(code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity: 'high', code, message, fix }
}

/**
 * Parse one Assignment HEADER-REGION field value with the engine
 * `parseAssignmentFields` semantics: a `**Field**: value` (bold) or
 * `Field: value` (plain) line, optionally list-bulleted, at line start.
 * Returns the trimmed value or undefined when the field is absent/empty.
 *
 * Callers MUST pass the engine `assignmentHeaderRegion(assignmentText)` slice
 * The engine owns the header/body boundary, so
 * body-quoted field examples after a `# Task` / `# Target` / `---` marker
 * never leak into header fields — the same discipline `resolveDispatchHard`
 * already honors for the Enforcement flag. This module keeps no second
 * grammar for the boundary.
 *
 * @param headerRegion - `assignmentHeaderRegion(assignmentText)`, never the raw text.
 * @param label - the header field label to read (e.g. `Plan Path`).
 */
function assignmentHeaderValue(headerRegion: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bold = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?\\*\\*\\s*${escaped}\\s*\\*\\*[ \\t]*:[ \\t]*(.*)$`, 'm')
  const plain = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escaped}[ \\t]*:[ \\t]*(.*)$`, 'm')
  const line = headerRegion.match(bold)?.[1] ?? headerRegion.match(plain)?.[1]
  if (line === undefined) return undefined
  const value = line.trim()
  return value === '' ? undefined : value
}

/** First whitespace-delimited token of a header value (paths in this convention never contain spaces). */
function firstToken(value: string): string | undefined {
  const token = value.split(/\s+/)[0]
  return token === '' ? undefined : token
}

/**
 * ALL header-region values of a repeated Assignment field label (bold or
 * plain, optionally list-bulleted — the same line grammar as the engine
 * `parseAssignmentFields`). Repeated `Worktree path` / `Working branch`
 * lines declare the L2 parallel-track context; empty values are
 * dropped (consistent with {@link assignmentHeaderValue}: an empty line is
 * an absent field, never a malformed track).
 *
 * Callers MUST pass the engine `assignmentHeaderRegion(assignmentText)`
 * slice: body-quoted field examples after a
 * `# Task` / `# Target` / `---` marker never leak into the track
 * declarations — the same header-region discipline the dispatch gate
 * already honors.
 * @param headerRegion - `assignmentHeaderRegion(assignmentText)`, never the raw text.
 * @param label - the header field label to read (e.g. `Worktree path`).
 */
function assignmentHeaderValues(headerRegion: string, label: string): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bold = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?\\*\\*\\s*${escaped}\\s*\\*\\*[ \\t]*:[ \\t]*(.*)$`)
  const plain = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escaped}[ \\t]*:[ \\t]*(.*)$`)
  const values: string[] = []
  for (const line of headerRegion.split(/\r?\n/)) {
    const value = (line.match(bold) ?? line.match(plain))?.[1]
    if (value !== undefined && value.trim() !== '') values.push(value.trim())
  }
  return values
}

/** A header value that means "no value" (placeholder conventions). Type guard so callers narrow to `string`. Shared with the agent-flow ledger (qc1 F-003 — one grammar, no copy-paste drift). */
export function isNaValue(value: string | undefined): value is undefined {
  return value === undefined || /^(?:n\/?a|none)$/i.test(value)
}

/**
 * Resolve the target plan id from the Assignment HEADER region: `Plan Path`
 * basename (`.md` stripped), else `SDD dir` basename, else a `plan_id` field.
 * Exported for the agent-flow ledger's dispatch derivation (the ledger
 * records the same plan identity the gate resolved — one grammar).
 * @param headerRegion - `assignmentHeaderRegion(assignmentText)` (
 * only the header is read — a plan path quoted in the task body never
 * resolves a plan id).
 */
export function planIdOf(headerRegion: string): string | undefined {
  const planPath = assignmentHeaderValue(headerRegion, 'Plan Path')
  if (!isNaValue(planPath)) {
    const id = basename(firstToken(planPath) ?? '')
    return id.endsWith('.md') ? id.slice(0, -3) : id
  }
  const sddDir = assignmentHeaderValue(headerRegion, 'SDD dir')
  if (!isNaValue(sddDir)) {
    const id = basename(firstToken(sddDir) ?? '')
    return id === '' ? undefined : id
  }
  const planId = assignmentHeaderValue(headerRegion, 'plan_id')
  return isNaValue(planId) ? undefined : planId
}

/**
 * The dispatching session's stable id, when the seam exposes it (dsh
 * Agent.id). Exported for the agent-flow ledger's dispatch derivation (the
 * ledger records the same agent identity the lease gate compares — one
 * grammar).
 */
export function sessionIdOf(exec: ToolExecution): string | undefined {
  const agent = asRecord(exec.agent)
  const id = agent?.id
  return typeof id === 'string' && id.trim() !== '' ? id : undefined
}

/**
 * Lease gate — ADDITIVE beyond the opencode parity field set:
 * opencode's `validateDispatchAssignment` does NOT run lease checks at
 * dispatch, so every violation emitted here is dsh-only and clearly scoped:
 * the check fires ONLY for WRITABLE dispatches whose Assignment declares
 * `Execution mode: sdd` (engine `executionModeToN` semantics — sdd maps to
 * N=3; the function's violation path is intentionally unused so
 * `dispatch.execution-mode.*` codes stay out of the parity field set) OR
 * whose plan row is `InProgress`.
 *
 * Contract (status-and-residuals.md § Pre-dispatch re-verify): before any
 * writable implement dispatch, reread `{HARNESS_DIR}/status.json` and confirm
 * the session still passes verify-held-lease — `holder`, `worktree_path` and
 * `working_branch` must match the Assignment; mismatch or absent lease →
 * STOP. Engine `verifyPlanExecutionLease` + `validateExecutionLease` carry
 * the presence/shape checks (missing / orphan / dual-write / non-ssot /
 * invalid fields); the dispatch-context comparisons (holder vs the
 * dispatching session, worktree and branch vs the Assignment) are dsh-side.
 *
 * Degrade-allow cases (no false positives): no harness dir, unresolvable plan
 * id, and non-SDD assignments whose plan row is absent or not InProgress.
 * Unverifiable lease states (malformed status.json, MISSING status.json, plan
 * row not registered) are violations ONLY for sdd dispatches (the lease state
 * cannot be confirmed — the status gate already guards the next write);
 * unreadable docs never harden a soft workflow. Missing status.json is NOT a
 * silent fail-open for sdd: the claim-before-InProgress red line
 * needs the plan's execution_lease, and a missing status file cannot confirm
 * it — `lease.dispatch.unverifiable` fires (advisory in warn, deny under hard).
 */
export function leaseGateViolations(
  harnessDir: string | null,
  exec: ToolExecution,
  writable: boolean | undefined,
  prompt: string,
): ValidationResult[] {
  if (harnessDir === null || writable === false) return []
  const header = assignmentHeaderRegion(prompt)
  const mode = assignmentHeaderValue(header, 'Execution mode')
  const sdd = executionModeToN(mode ?? '').n === 3
  const planId = planIdOf(header)
  if (planId === undefined || planId === '') return []
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) {
    if (!sdd) return []
    return [leaseViolation(
      'lease.dispatch.unverifiable',
      `${statusPath} is missing — the plan's execution_lease state is unverifiable; STOP before writable dispatch`,
      'create a valid status.json registering the plan row (first implement dispatch requires a plan row)',
    )]
  }

  let doc: StatusDoc
  try {
    doc = readJson(statusPath) as StatusDoc
  } catch (error) {
    if (!sdd) return []
    return [leaseViolation(
      'lease.dispatch.unreadable',
      `cannot read ${statusPath}: ${(error as Error).message} — the plan's execution_lease state is unverifiable; STOP before writable dispatch`,
      'restore a valid status.json (the status gate refuses invalid writes)',
    )]
  }

  const row = Array.isArray(doc.plans)
    ? doc.plans.map(asRecord).find((r) => r?.id === planId || r?.plan_id === planId)
    : undefined
  if (row === undefined) {
    if (!sdd) return []
    return [leaseViolation(
      'lease.dispatch.plan-not-found',
      `plan ${planId} is not registered in ${STATUS_FILE} — cannot verify its execution_lease before writable dispatch`,
      'register the plan row in status.json (first implement dispatch requires a plan row)',
    )]
  }
  if (!sdd && row.status !== 'InProgress') return []

  const verify = verifyPlanExecutionLease(row, planId)
  const violations = [...verify.violations]
  const lease = asRecord(verify.lease)
  // Dispatch-context comparisons need a structurally valid lease — the shape
  // violations (when present) already surfaced above; skip comparisons so raw
  // fields of a broken lease never produce misleading mismatch noise.
  if (lease !== undefined && validateExecutionLease(lease).ok) {
    const sessionId = sessionIdOf(exec)
    // Holder contract: `lease.holder` must be recorded as the dsh
    // Agent.id this dispatch runs under. The mstar control-side holder
    // convention is `<host>:<stable-session-id>` — a lease claimed under that
    // vocabulary against a bare dsh agent id is a deliberate fail-closed
    // mismatch (no-steal): deployments must record leases with the dsh agent
    // id, not the control-side session id.
    if (sessionId !== undefined && lease.holder !== sessionId) {
      violations.push(leaseViolation(
        'lease.dispatch.holder-mismatch',
        `execution_lease.holder "${String(lease.holder)}" differs from this session "${sessionId}" — the active lease belongs to another agent; no-steal: STOP, do not dispatch`,
        'dispatch only from the lease-holding session (or release/override the lease with user authorization + audit note)',
      ))
    }
    const worktree = assignmentHeaderValue(header, 'Worktree path')
    const wt = worktree === undefined ? undefined : firstToken(worktree)
    if (isNaValue(wt)) {
      violations.push(leaseViolation(
        'lease.dispatch.worktree-mismatch',
        'Assignment declares no Worktree path — cannot confirm this dispatch matches execution_lease.worktree_path',
        'add the absolute Worktree path to the Assignment (must equal the lease worktree_path)',
      ))
    } else if (resolve(wt) !== resolve(String(lease.worktree_path ?? ''))) {
      violations.push(leaseViolation(
        'lease.dispatch.worktree-mismatch',
        `Assignment Worktree path "${wt}" differs from execution_lease.worktree_path "${String(lease.worktree_path)}"`,
        'align the Assignment with the lease worktree path (or update the lease)',
      ))
    }
    const forms = parseAssignmentBranchForms(header)
    const branch = forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch
    if (branch !== undefined && branch !== lease.working_branch) {
      violations.push(leaseViolation(
        'lease.dispatch.branch-mismatch',
        `Assignment Working branch "${branch}" differs from execution_lease.working_branch "${String(lease.working_branch)}"`,
        'align the Assignment with the lease working branch (or update the lease)',
      ))
    }
  }
  return violations
}

/**
 * One worktree-gate violation line (dsh-side codes live in the
 * `worktree.l2.*` namespace beside the engine's `worktree.l1.*` /
 * `worktree.l2.*` emit).
 */
function worktreeViolation(code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity: 'high', code, message, fix }
}

/**
 * L2 within-plan track isolation (engine `l2PreDispatchCheck`):
 * when the Assignment declares parallel tracks — ≥2 `Worktree path` header
 * entries, or the documented parallel-tracks marker (`Dispatch mode:
 * parallel independent tracks`, mstar-phase-gates 并行标签 /
 * parallel-writable-pre-dispatch.md step 5) — every declared track must
 * carry an absolute, distinct worktree path whose checkout branch matches
 * its Working branch, BEFORE the first concurrent writable dispatch
 * (N parallel invokes ≠ isolation).
 *
 * Track pairing follows the Assignment grammar: one `Working branch` entry
 * per `Worktree path`, OR a single `Working branch` line applying to every
 * track (the same-branch multi-dir topology, mstar-branch-worktree
 * 同分支多目录例外 — git forbids one branch in two linked worktrees, so the
 * second checkout is a clone). Any other count mismatch is a violation.
 *
 * Pure over the header + the filesystem; the engine probes
 * `git -C <path> branch --show-current` per valid track (bounded, fails
 * closed). Header-region scoping: the caller passes the engine
 * `assignmentHeaderRegion` slice only.
 * @param header - `assignmentHeaderRegion(assignmentText)`.
 */
function worktreeL2Violations(header: string): ValidationResult[] {
  const worktreePaths = assignmentHeaderValues(header, 'Worktree path')
  const workingBranches = assignmentHeaderValues(header, 'Working branch')
  const dispatchMode = assignmentHeaderValue(header, 'Dispatch mode')
  // Parallel-track declaration: ≥2 Worktree path entries, or the documented
  // canonical parallel-tracks marker (`Dispatch mode: parallel independent
  // tracks`, mstar-phase-gates 并行标签). A single Worktree path is the
  // serial norm and never triggers the L2 checklist (no track list to verify
  // against). The marker match is exact (P3 T2 review — no substring
  // widening): a Dispatch mode merely CONTAINING "parallel" (e.g. a serial
  // mode with a parallel-flavored name) must not trigger the L2 checklist.
  const isParallelTracksMarker = dispatchMode?.trim().toLowerCase() === 'parallel independent tracks'
  if (worktreePaths.length < 2 && !isParallelTracksMarker) return []

  const violations: ValidationResult[] = []
  const tracks: WorktreeTrack[] = []
  if (worktreePaths.length === 0 || workingBranches.length === worktreePaths.length) {
    for (let i = 0; i < worktreePaths.length; i += 1) {
      tracks.push({ worktreePath: worktreePaths[i]!, workingBranch: workingBranches[i] ?? '' })
    }
  } else if (workingBranches.length === 1) {
    // One Working branch line applies to every track (同分支多目录例外).
    for (const path of worktreePaths) tracks.push({ worktreePath: path, workingBranch: workingBranches[0]! })
  } else {
    violations.push(worktreeViolation(
      'worktree.l2.track-count-mismatch',
      `parallel-track declaration pairs ${worktreePaths.length} Worktree path entr${worktreePaths.length === 1 ? 'y' : 'ies'} with ${workingBranches.length} Working branch entries — every track needs its own absolute Worktree path AND Working branch (or one shared branch for all tracks)`,
      'align the track counts in the Assignment header (one Worktree path + Working branch per track, or a single Working branch for all tracks)',
    ))
    const n = Math.min(worktreePaths.length, workingBranches.length)
    for (let i = 0; i < n; i += 1) {
      tracks.push({ worktreePath: worktreePaths[i]!, workingBranch: workingBranches[i]! })
    }
  }
  violations.push(...l2PreDispatchCheck({ tracks }).violations)
  return violations
}

/**
 * L1 cross-plan isolation (engine `l1PreDispatchCheck`): when the
 * Assignment resolves a plan id AND status.json carries the L1 metadata —
 * `metadata.control_worktree_path` plus the plan row's `execution_lease`
 * (worktree_path + working_branch) — verify the control-vs-feature
 * topology: control path recorded, lease worktree exists, lease worktree
 * MUST differ from the control worktree, and the checked-out branch matches
 * the lease Working branch.
 *
 * Fires ONLY when the metadata is present (the brief's "L1 checks (control
 * vs feature path) when metadata present"): no harness dir, unresolvable
 * plan id, missing status.json, absent control path, or a lease without the
 * two path/branch fields all degrade to silence — the exec-bound lease gate
 * owns lease SHAPE errors (sdd unverifiable/unreadable/plan-not-found) on
 * the same verdict. The engine probe of the lease worktree is subprocess-
 * based and fails closed.
 * @param harnessDir - the plugin's resolved `{HARNESS_DIR}` (null when none).
 * @param header - `assignmentHeaderRegion(assignmentText)`.
 */
function worktreeL1Violations(harnessDir: string | null, header: string): ValidationResult[] {
  if (harnessDir === null) return []
  const planId = planIdOf(header)
  if (planId === undefined || planId === '') return []
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) return []
  let doc: StatusDoc
  try {
    doc = readJson(statusPath) as StatusDoc
  } catch {
    return [] // unreadable status is the lease gate's report (sdd dispatches)
  }
  const metadata = asRecord(doc.metadata)
  const controlWorktreePath = typeof metadata?.control_worktree_path === 'string' ? metadata.control_worktree_path : undefined
  if (controlWorktreePath === undefined || controlWorktreePath.trim() === '') return []
  const row = Array.isArray(doc.plans)
    ? doc.plans.map(asRecord).find((r) => r?.id === planId || r?.plan_id === planId)
    : undefined
  const lease = asRecord(row?.execution_lease)
  const leaseWorktreePath = typeof lease?.worktree_path === 'string' ? lease.worktree_path : undefined
  const leaseWorkingBranch = typeof lease?.working_branch === 'string' ? lease.working_branch : undefined
  if (
    leaseWorktreePath === undefined || leaseWorktreePath.trim() === '' ||
    leaseWorkingBranch === undefined || leaseWorkingBranch.trim() === ''
  ) {
    return [] // no lease metadata to compare — nothing to verify
  }
  return l1PreDispatchCheck({ controlWorktreePath, leaseWorktreePath, leaseWorkingBranch, planId }).violations
}

/**
 * The dispatch-gate validation core — the engine's SINGLE dispatch-gate
 * composition (`dispatch.composeDispatchGate`, opencode/omp/CLI parity — the
 * SAME composition, so violation codes are identical by construction): shape
 * guard + field gate (read-only roles skip the branch gate) +
 * anti-recursion precheck (Config binding) + default-branch gate +
 * header-region enforcement. The dsh-side additions layer ON TOP: the
 * worktree L1/L2 checks (additive beyond opencode parity; the
 * lease gate is exec-bound and joins via {@link DshHostAdapter.dispatchGate}).
 * Extracted from `gateDispatch` so the `tools/pre-execute` listener and the
 * host adapter's `beforeDispatch` share ONE code path.
 *
 * Header-region scoping: the engine `assignmentHeaderRegion`
 * slice is computed ONCE and feeds the composition AND the worktree parsers
 * (fields, branch forms, direct-on exception, worktree tracks) — body-quoted
 * field examples after a `# Task` / `# Target` / `---` marker never leak
 * into the header fields the gate validates (the same discipline
 * enforcement / plan-id / lease already honor). Well-formed assignments
 * (fields in the header) slice to the full text, so their verdicts are
 * unchanged. The composition never throws: unexpected failures degrade to
 * the silent non-shaped result.
 *
 * @returns the violations plus the writable flag (false for read-only
 * roles — the listener feeds it to the lease gate).
 */
export function dispatchGateCore(
  config: Config,
  harnessDir: string | null,
  prompt: string,
): { violations: ValidationResult[]; writable: boolean | undefined } {
  const header = assignmentHeaderRegion(prompt)
  // Worktree L2 (declared parallel tracks) + L1 (control vs feature path
  // when the plan metadata is present) — both run on the header
  // region slice, the engine parsers' single boundary.
  const violations: ValidationResult[] = [...worktreeL2Violations(header), ...worktreeL1Violations(harnessDir, header)]
  // Read-only roles (scout/explore) skip the branch-form gate entirely.
  const writable = isReadOnlyAssignmentRole(parseAssignmentFields(header).executeAs ?? '') ? false : undefined
  // Engine single composition: shape guard + validateAssignmentFields
  // (writable) + antiRecursionPrecheck (agent = the dispatching agent's own
  // type, Config-declared — dsh exposes no agent role on the execution
  // context) + default-branch gate (Assignment branch forms, else
  // $MSTAR_WORKING_BRANCH; direct-on exception only when its branch is the
  // one being checked) + header-region enforcement. Never throws.
  violations.push(...composeDispatchGate(header, { agent: config.dispatchBinding ?? '', writable }).violations)
  return { violations, writable }
}

/**
 * Run the dispatch gate over one delegation tool call (opencode
 * `validateDispatchAssignment` parity — the SAME engine fns, so violation
 * codes are identical). Returns the veto decision in hard mode, undefined
 * otherwise (warn mode: log + advisory emit; the caller delegates via `next()`).
 * Non-subagent tools, non-Assignment prompts and malformed payloads are pure
 * pass-through (undefined).
 */
function gateDispatch(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  adapter: DshHostAdapter,
  exec: ToolExecution,
): PreToolDecision | undefined {
  const toolName = exec.name
  if (!(config.dispatchTools ?? [...DEFAULT_DISPATCH_TOOLS]).includes(toolName)) return undefined
  const args = asRecord(exec.arguments)
  const prompt = typeof args?.prompt === 'string' ? args.prompt : undefined
  if (prompt === undefined) return undefined
  // Shape guard + advisory role read run on the header region:
  // a `## Assignment` heading or field line quoted in the task body cannot
  // shape a non-assignment prompt or leak into the advisory role.
  const header = assignmentHeaderRegion(prompt)
  if (!isAssignmentShaped(header)) return undefined

  // The adapter owns the shared dispatch-gate core; the exec context is
  // passed so the lease gate (session-id bound — see leaseGateViolations)
  // joins the SAME verdict as the field/branch/anti-recursion checks.
  // `hard` resolves ONCE per dispatch (qc1 F-002 / qc2 F-3 / qc3 F-002 —
  // fix-wave): the adapter's record block and this gate decision share the
  // single resolution instead of each re-reading the compass.
  const hard = resolveDispatchHard(harnessDir, config, prompt)
  const result = adapter.dispatchGate(prompt, exec, hard)
  const verdict = applyEnforcement(result, { hard })
  if (verdict.hardBlocked) {
    ctx.logger(DISPATCH_LOGGER).error(
      `subagent dispatch (${toolName}) vetoed (Enforcement: hard):\n${verdict.violations.map(formatViolation).join('\n')}`,
    )
    return { kind: 'deny', reason: denyReason(toolName, verdict) }
  }
  if (!verdict.ok) {
    ctx.logger(DISPATCH_LOGGER).warn(
      `subagent dispatch (${toolName}) (advisory):\n${verdict.violations.map(formatViolation).join('\n')}`,
    )
    const role = parseAssignmentFields(header).executeAs ?? ''
    ctx.emit('mstar/dispatch-gate', { tool: toolName, role, result: verdict, hard })
  }
  return undefined
}

/**
 * `tools/pre-execute` listener. The waterfall refusal channel is the returned
 * decision: a deny is returned WITHOUT calling `next()` (short-circuits the
 * chain — downstream listeners and the registry default never run); every
 * other path calls `next()` to delegate (the registry's default is
 * `{ kind: 'allow' }`). Engine failures degrade to allow in BOTH modes (hard
 * gates are opt-in — an engine failure must not harden a workflow that was
 * soft; opencode parity) but the degrade is NEVER silent: the
 * catch path emits the plugin-owned `mstar/dispatch-gate` advisory with
 * `degraded: true` + an error log, so a hard deployment can detect a dead
 * control instead of only finding it in logs. `next()` itself is invoked
 * outside the guard so a downstream rejection propagates untouched.
 */
export async function preExecuteListener(
  ctx: Context,
  resolver: HarnessResolver,
  config: Config,
  adapter: DshHostAdapter,
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision> {
  let veto: PreToolDecision | undefined
  try {
    veto = gateDispatch(ctx, resolver.forAgent(exec.agent), config, adapter, exec)
  } catch (error) {
    ctx.logger(DISPATCH_LOGGER).error(`dispatch gate aborted (degraded, dispatch allowed): ${(error as Error).message}`)
    try {
      ctx.emit('mstar/dispatch-gate', { tool: exec.name, role: '', result: { ok: true, violations: [] }, hard: false, degraded: true })
    } catch (emitError) {
      // Best-effort observability: a throwing advisory consumer must not take
      // the gate down with it (the error log above is the durable signal).
      ctx.logger(DISPATCH_LOGGER).error(`dispatch gate degraded advisory emit failed: ${(emitError as Error).message}`)
    }
  }
  return veto ?? await next()
}

/**
 * Rebuild the canonical Assignment HEADER text from parsed fields (the
 * engine's OWN header grammar — `parseAssignmentFields` reads exactly these
 * labels — so the engine parsers round-trip losslessly). The host hook's
 * engine-typed input is `AssignmentFields`; the shared gate core validates
 * assignment TEXT, so the fields form is normalized to text before gating.
 */
export function assignmentTextFromFields(fields: AssignmentFields): string {
  const lines = ['## Assignment', '']
  if (fields.executeAs !== undefined) lines.push(`**Execute as**: ${fields.executeAs}`)
  if (fields.delegation !== undefined) lines.push(`**Delegation**: ${fields.delegation}`)
  if (fields.taskCategory !== undefined) lines.push(`**Task category**: ${fields.taskCategory}`)
  if (fields.workingBranch !== undefined) lines.push(`**Working branch**: ${fields.workingBranch}`)
  if (fields.branchPolicy !== undefined) lines.push(`**Branch policy**: ${fields.branchPolicy}`)
  return lines.join('\n')
}
