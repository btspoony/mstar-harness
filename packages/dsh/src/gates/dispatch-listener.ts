/**
 * The `tools/pre-execute` LISTENER and the Assignment-shaped branches it
 * dispatches to: the shared Assignment-text gate core (used by both the
 * `subagent` and Agent Teams branches), the Agent Teams carrier branch, the
 * tool-name router (`gateDispatch`) and the listener itself with its
 * degrade-to-allow containment.
 *
 * Module boundary: one responsibility — turn one tool call into a
 * `PreToolDecision` across the waterfall's refusal channel, including the
 * one-way routing between the workflow, Agent Teams and subagent branches.
 *
 * No barrel: importers name this module by explicit relative path.
 */
import { type Context } from '@deepseek-ai/cordis'
import { applyEnforcement, parseAssignmentFields, readAssignmentSource } from '@mstar-harness/engine'
import type { GateResult } from '@mstar-harness/engine'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { asRecord, formatViolation } from './_shared.ts'
import type { Config, HarnessResolver, SessionHintRead } from './_shared.ts'
import type { DshHostAdapter } from './adapter.ts'
import {
  DEFAULT_DISPATCH_TOOLS,
  DISPATCH_LOGGER,
  TEAM_DISPATCH_TOOLS,
  isTeamDispatchTool,
} from './dispatch.ts'
import { isAssignmentShaped, resolveDispatchHard } from './dispatch-assignment.ts'
import { hasTerminalRefusal } from './dispatch-core.ts'
import { gateWorkflow } from './dispatch-workflow-branch.ts'
import { handOffResolvedCarrier } from './role-persona.ts'

/** The hard-mode veto reason: one line per violation + the refusal channel. */
function denyReason(tool: string, verdict: GateResult, cause: string): string {
  return [
    `subagent dispatch (${tool}) blocked by ${cause} — the dispatch gate refused it`,
    ...verdict.violations.map(formatViolation),
    'refusal channel: tools/pre-execute PreToolDecision { kind: \'deny\' }; skill: mstar-dispatch-gates',
  ].join('\n')
}

/**
 * The Assignment gate core shared by the subagent and the Agent Teams
 * branches (`gateDispatch` / {@link gateTeamDispatch}): header-region scoping,
 * the shape guard, ONE hard resolution, the adapter's shared dispatch-gate
 * core (lease + worktree L1/L2 + field + branch + anti-recursion), then the
 * warn advisory or the hard veto. `exec.name` is the ACTUAL carrier tool, so
 * both the deny reason and the advisory name the tool that carried the text
 * rather than assuming `subagent`.
 *
 * `prompt` is the raw carrier text — the header slice is computed here ONCE
 * and never fed back into the core (the adapter re-derives the same slice).
 */
async function gateAssignmentText(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  adapter: DshHostAdapter,
  exec: ToolExecution,
  prompt: string,
  hintReadOf: () => SessionHintRead,
): Promise<PreToolDecision | undefined> {
  const toolName = exec.name
  // Shape guard on the raw carrier text: an inline document is read whole
  // (the front matter scanners fence-scope themselves); a pointer line
  // (`Assignment file: <abs>`, compass D14) is shaped by its own prefix so
  // the source resolution verdict — success OR refusal — is always gated.
  // The D16 legacy body-label shape is assignment-shaped too: the document
  // must reach the gate's legacy-format refusal, never pass silently.
  if (!isAssignmentShaped(prompt) && !/^[ \t]*Assignment file:[ \t]*\S/m.test(prompt)) return undefined
  // compass D14 — the ONE source resolution, BEFORE enforcement and the
  // advisory role are derived: an `Assignment file: <abs>` pointer resolves
  // to the document it names, so `enforcement: hard` inside that document
  // hardens exactly as the inline form does, and the advisory names the
  // document's own Execute as. The resolution RESULT threads into the
  // core/lease/record paths below (`preResolved`), so no downstream stage
  // ever re-reads the source: success feeds every stage the same document;
  // a terminal source refusal stays terminal — the one refusal verdict,
  // never a second read, never a field-violation read of the pointer line,
  // and never a ledger row for the unresolved input.
  const source = readAssignmentSource(prompt, { harnessDir })
  const text = source.ok ? source.text : prompt
  // The adapter owns the shared dispatch-gate core; the exec context is
  // passed so the lease gate (session-id bound — see leaseGateViolations)
  // joins the SAME verdict as the field/branch/anti-recursion checks.
  // `hard` resolves ONCE per dispatch: the adapter's record block and this
  // gate decision share the single resolution instead of each re-reading
  // the compass.
  const hard = resolveDispatchHard(harnessDir, config, text)
  const result = await adapter.dispatchGate(text, exec, hard, hintReadOf(), source)
  const verdict = applyEnforcement(result, { hard })
  // A terminal source refusal is a VETO, decided BEFORE enforcement, the
  // advisory role and the preset channel: the resolver proved there is no
  // document to dispatch on, so no `hard`/`soft` setting may soften it
  // (ordinary violations of a resolved document keep their soft behavior).
  const terminal = hasTerminalRefusal(verdict.violations)
  if (terminal || verdict.hardBlocked) {
    const cause = terminal ? 'a terminal assignment-source refusal' : 'Enforcement: hard'
    ctx.logger(DISPATCH_LOGGER).error(
      `subagent dispatch (${toolName}) vetoed (${cause}):\n${verdict.violations.map(formatViolation).join('\n')}`,
    )
    return { kind: 'deny', reason: denyReason(toolName, verdict, cause) }
  }
  if (!verdict.ok) {
    ctx.logger(DISPATCH_LOGGER).warn(
      `subagent dispatch (${toolName}) (advisory):\n${verdict.violations.map(formatViolation).join('\n')}`,
    )
    const role = parseAssignmentFields(text).executeAs ?? ''
    ctx.emit('mstar/dispatch-gate', { tool: toolName, role, result: verdict, hard })
  }
  // The admitted pointer's resolved document is handed to the native start
  // seam for THIS call (keyed by the tool call id, scoped by the
  // `tools/execute` wrapper), so the child executes the version the gate
  // decided on instead of reading the file a second time.
  if (source.ok) handOffResolvedCarrier(exec.callId, source)
  return undefined
}

/**
 * The Agent Teams gate branch: resolve the carrier field for the fixed team
 * tools and route its text through the SAME core as `subagent`
 * ({@link gateAssignmentText}). A tool outside the fixed map, a missing or
 * non-string carrier (`team_task_update` status-only updates), or
 * non-Assignment text is a pure pass-through (undefined) — ordinary team
 * coordination text is never a false positive.
 *
 * The caller invokes this ONLY for a name {@link isTeamDispatchTool} owns, and
 * treats its result — `undefined` included — as TERMINAL for that name, so a
 * team name that also appears in `Config.dispatchTools` is never re-gated by
 * the subagent branch (one decision, one ledger record per call).
 */
async function gateTeamDispatch(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  adapter: DshHostAdapter,
  exec: ToolExecution,
  hintReadOf: () => SessionHintRead,
): Promise<PreToolDecision | undefined> {
  if (!isTeamDispatchTool(exec.name)) return undefined
  const carrier = TEAM_DISPATCH_TOOLS[exec.name]
  const text = asRecord(exec.arguments)?.[carrier]
  if (typeof text !== 'string') return undefined
  return gateAssignmentText(ctx, harnessDir, config, adapter, exec, text, hintReadOf)
}

/**
 * Run the dispatch gate over one delegation tool call (opencode
 * `validateDispatchAssignment` parity — the SAME engine fns, so violation
 * codes are identical). Returns the veto decision in hard mode, undefined
 * otherwise (warn mode: log + advisory emit; the caller delegates via `next()`).
 * Non-subagent tools, non-Assignment prompts and malformed payloads are pure
 * pass-through (undefined).
 */
async function gateDispatch(
  ctx: Context,
  harnessDir: string | null,
  config: Config,
  adapter: DshHostAdapter,
  exec: ToolExecution,
  readHint?: () => SessionHintRead,
): Promise<PreToolDecision | undefined> {
  const toolName = exec.name
  // The carrying session's hint — derived ONCE per tool call through the
  // adapter (the plugin's only owner of the durable binding store) and shared
  // by the workflow branch, the dispatch branch's selection reads and the
  // ledger record below. `dispatch-workflow-branch.ts` therefore stays free of a runtime
  // agent-flow / engine-status-store dependency (the adapter is the acyclic
  // junction).
  //
  // LAZY on purpose: `tools/pre-execute` fires for EVERY tool call, and most
  // calls are neither a workflow tool nor a dispatch tool — deriving eagerly
  // would charge every one of them a binding-store read for a hint no branch
  // reads. The thunk below memoizes the one derivation a gated call needs.
  let derived: SessionHintRead | undefined
  // The caller may own the memo (the listener shares ONE derivation with its
  // catalog-registration veto — the D4 "derived only where the gate reads it,
  // once per call" contract); otherwise this branch memoizes its own.
  const hintReadOf: () => SessionHintRead = readHint ?? (() => (derived ??= adapter.sessionHintFor(exec.agent)))
  // WORKFLOW/RALPH BRANCH — BEFORE the subagent prompt branch: `workflow`/`ralph` carry no
  // `args.prompt`, so the prompt guard below would pass them through even
  // if the names were added to the dispatch-tool match list (W4 double
  // no-op). Keyed on the FIXED tool names — the workflow tools are gated
  // by their own branch, never by `DEFAULT_DISPATCH_TOOLS` addition.
  const workflowDecision = await gateWorkflow(ctx, harnessDir, config, adapter, exec, hintReadOf)
  if (workflowDecision !== undefined) return workflowDecision
  // AGENT TEAMS BRANCH — BEFORE and TERMINAL FOR the names it owns (the
  // workflow branch above demonstrates the same placement): the team tools
  // carry the Assignment text in a different argument field per tool and are
  // gated by their own fixed-name branch, never by addition to
  // `DEFAULT_DISPATCH_TOOLS`. Returning the branch result UNCONDITIONALLY —
  // `undefined` included — is what makes the ownership terminal: a team name
  // a caller also added to `Config.dispatchTools` can no longer fall through
  // into the subagent match below and be gated (and ledger-recorded) twice.
  if (isTeamDispatchTool(exec.name)) {
    return gateTeamDispatch(ctx, harnessDir, config, adapter, exec, hintReadOf)
  }
  if (!(config.dispatchTools ?? [...DEFAULT_DISPATCH_TOOLS]).includes(toolName)) return undefined
  const args = asRecord(exec.arguments)
  const prompt = typeof args?.prompt === 'string' ? args.prompt : undefined
  if (prompt === undefined) return undefined
  return gateAssignmentText(ctx, harnessDir, config, adapter, exec, prompt, hintReadOf)
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
    const harnessDir = resolver.forAgent(exec.agent)
    // One session-hint derivation for the gate reads in this call.
    let hintRead: SessionHintRead | undefined
    const readHint = (): SessionHintRead => (hintRead ??= adapter.sessionHintFor(exec.agent))
    veto = await gateDispatch(ctx, harnessDir, config, adapter, exec, readHint)
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
