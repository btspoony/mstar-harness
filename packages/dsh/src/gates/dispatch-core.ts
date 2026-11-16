/**
 * The dispatch gate CORE: the calling session's identity (and the anti-recursion
 * caller derived from it) plus the ONE dispatch-gate composition shared by the
 * `tools/pre-execute` listener and the host adapter's `beforeDispatch` /
 * `dispatchGate`.
 *
 * Module boundary: one responsibility — compose the engine's single dispatch
 * gate (+ the dsh-side worktree checks) into one violation list and report
 * whether the dispatch is writable. It never logs, emits, or maps to a
 * `PreToolDecision`; the listener owns that vocabulary.
 *
 * No barrel: importers name this module by explicit relative path.
 */
import {
  assignmentHeaderRegion,
  composeDispatchGate,
  isReadOnlyAssignmentRole,
  parseAssignmentFields,
} from '@mstar-harness/engine'
import type { ValidationResult } from '@mstar-harness/engine'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { asRecord, liveConfigValue, ROOT_SESSION_DISPATCH_BINDING } from './_shared.ts'
import type { Config } from './_shared.ts'
import { isRootLikeAgent } from './steering.ts'
import type { SessionHint } from './workflow-selection.ts'
import type { ExecutionWorkflowSourceRead } from './workflow-selection.ts'
import { worktreeL1Violations, worktreeL2Violations } from './dispatch-worktree.ts'

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
 * The CALLING session's lineage position, as the execution context exposes it
 * (`session.header` — the same structural surface `sessionCwdOf` /
 * `sessionHintOf` read). `unresolvable` = the context carries no session at
 * all (the exec-less host `beforeDispatch` hook, a bare agent stub) — never
 * silently treated as a root.
 */
function callingSessionOf(agent: unknown): 'root' | 'child' | 'unresolvable' {
  const session = asRecord(asRecord(agent)?.session)
  if (asRecord(session?.header) === undefined) return 'unresolvable'
  return isRootLikeAgent(agent) ? 'root' : 'child'
}

/**
 * The anti-recursion CALLER for one dispatch — DERIVED from the calling
 * session, never invented:
 *
 * 1. a CHILD session (or a session the gate cannot read) → EMPTY, whatever
 *    `dispatchBinding` says, so the engine's
 *    `dispatch.anti-recursion.empty-binding` fails closed. A leaf must not
 *    dispatch, and no configuration may lift that;
 * 2. a ROOT session → an explicit `dispatchBinding` (settings / profile) wins
 *    verbatim, and an explicitly blank value stays blank and fails closed;
 * 3. no explicit value on a ROOT session → the coordinator identity
 *    (`ROOT_SESSION_DISPATCH_BINDING`) — a root session in this harness IS the
 *    coordinating agent, so this is an identity read, not a guess.
 *
 * Consequence: a deployment whose coordinator is NOT the root session cannot be
 * served by this field — the binding is a ROOT-session identity, never
 * inherited by a child.
 */
export function dispatchCallerOf(config: Config, agent: unknown): string {
  if (callingSessionOf(agent) !== 'root') return ''
  const explicit = liveConfigValue(config.dispatchBinding)
  return explicit !== undefined ? explicit : ROOT_SESSION_DISPATCH_BINDING
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
 * @param callerAgent - the CALLING agent (`exec.agent` on the listener path,
 *   `undefined` on the exec-less host hook) — the session the caller identity
 *   is derived from ({@link dispatchCallerOf}).
 * @param hint - the carrying session's selection hint (the adapter derives
 *   it once per dispatch and shares it with the lease gate, the ledger
 *   record and every selection read below).
 */
export async function dispatchGateCore(
  config: Config,
  harnessDir: string | null,
  prompt: string,
  callerAgent: unknown,
  hint?: SessionHint,
  activeSource?: ExecutionWorkflowSourceRead,
): Promise<{ violations: ValidationResult[]; writable: boolean | undefined }> {
  const header = assignmentHeaderRegion(prompt)
  const violations: ValidationResult[] = [...worktreeL2Violations(header), ...await worktreeL1Violations(harnessDir, header, hint, activeSource)]
  // Read-only roles (scout/explore) skip the branch-form gate entirely.
  const writable = isReadOnlyAssignmentRole(parseAssignmentFields(header).executeAs ?? '') ? false : undefined
  // Engine single composition: shape guard + validateAssignmentFields
  // (writable) + antiRecursionPrecheck (caller = the dispatching agent's own
  // role, DERIVED from the calling session — an explicit binding is honoured
  // only for a ROOT session, which otherwise reads as the coordinator; a
  // child/unreadable session is always EMPTY; callerRequired keeps the 3.1.2
  // fail-closed contract: an empty binding emits
  // dispatch.anti-recursion.empty-binding) + default-branch gate (Assignment
  // branch forms, else $MSTAR_WORKING_BRANCH; direct-on exception only when
  // its branch is the one being checked) + header-region enforcement. Never
  // throws. The caller is read LIVE — `dispatchBinding` is volatile (a
  // settings save applies on the next dispatch) — and an explicitly blank
  // value still fails closed.
  violations.push(
    ...composeDispatchGate(header, { caller: dispatchCallerOf(config, callerAgent), callerRequired: true, writable }).violations,
  )
  return { violations, writable }
}
