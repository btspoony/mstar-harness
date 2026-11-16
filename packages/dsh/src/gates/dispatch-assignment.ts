/**
 * The Assignment HEADER grammar every dispatch-side gate reads: the header-field
 * extractors (`assignmentHeaderValue` / `assignmentHeaderValues` with the shared
 * code-span and first-token normalization), the placeholder guard (`isNaValue`),
 * the plan-id derivation (`planIdOf`), the shape guard (`isAssignmentShaped`),
 * the ONE hard-enforcement resolution (`resolveDispatchHard`) and the typed-
 * fields → header-text normalizer (`assignmentTextFromFields`).
 *
 * Module boundary: one responsibility — turn Assignment TEXT (or the host's
 * typed fields) into the header values a decision is made from. It makes no
 * decision itself: the lease, worktree and dispatch cores consume these values.
 * Callers MUST pass the engine `assignmentHeaderRegion` slice; the engine owns
 * the header/body boundary and this module keeps no second grammar for it.
 *
 * No barrel: importers name this module by explicit relative path; it
 * re-exports nothing from a sibling and imports no sibling dispatch module.
 */
import { basename } from 'node:path'
import { assignmentHeaderRegion, parseEnforcementFlag } from '@mstar-harness/engine'
import type { AssignmentFields } from '@mstar-harness/engine'
import { resolveSeamHard } from './_shared.ts'
import type { Config } from './_shared.ts'

/** `## Assignment` heading marker (opencode parity — shape guard only). */
const ASSIGNMENT_HEADING_RE = /^#{1,6}\s+Assignment\s*$/m

/** Shape-guard match of an Assignment header field (opencode parity). */
const ASSIGNMENT_FIELD_RE =
  /^[ \t]*(?:[-*][ \t]+)?\*{0,2}(Execute as|Delegation|Task category)\*{0,2}[ \t]*:[ \t]*(\S.*)$/gm

/**
 * True when the text looks like an Assignment (opencode parity: `## Assignment`
 * heading or at least one core field line). Non-Assignment delegation prompts
 * stay silent — no false-positive warnings. Callers MUST pass the engine
 * `assignmentHeaderRegion` slice: a `## Assignment` heading or
 * field line quoted in the task body must not shape a non-assignment prompt.
 * Exported for the agent-flow ledger's shape guard — the shared
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
 * repo `.mstarc` `[config] enforcement`, else the iteration compass
 * frontmatter, else warn-only.
 */
export function resolveDispatchHard(harnessDir: string | null, config: Config, assignmentText: string): boolean {
  if (config.enforcement === 'hard') return true
  if (config.enforcement === 'soft') return false
  if (parseEnforcementFlag(assignmentHeaderRegion(assignmentText)).hard) return true
  return resolveSeamHard(harnessDir, config)
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
export function assignmentHeaderValue(headerRegion: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bold = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?\\*\\*\\s*${escaped}\\s*\\*\\*[ \\t]*:[ \\t]*(.*)$`, 'm')
  const plain = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escaped}[ \\t]*:[ \\t]*(.*)$`, 'm')
  const line = headerRegion.match(bold)?.[1] ?? headerRegion.match(plain)?.[1]
  if (line === undefined) return undefined
  const value = stripWrappingCodeSpan(line.trim())
  return value === '' ? undefined : value
}

/**
 * Strip ONE wrapping markdown code span from a header value.
 *
 * Assignment prose routinely writes header values as code spans —
 * ``**Plan Path**: `/x/plan.md` `` — and the extractor used to keep the
 * backticks. That failed **silently**: `planIdOf` keys off a literal `.md`
 * suffix, so `` plan.md` `` was not recognised as a plan file and the id was
 * carried into the agent-flow ledger *with* its trailing backtick, matching no
 * registered plan (and, under an iteration lease gate, producing a spurious
 * "plan is not registered" violation).
 *
 * Only a single clean pair is stripped: a value that wraps several spans
 * (`` `/a`, `/b` ``) has backticks inside and is left untouched, so no other
 * reading of the line changes.
 * @param value - the trimmed header value.
 * @returns the value without one wrapping pair of backticks.
 */
function stripWrappingCodeSpan(value: string): string {
  if (value.length < 2 || !value.startsWith('`') || !value.endsWith('`')) return value
  const inner = value.slice(1, -1)
  return inner.includes('`') ? value : inner.trim()
}

/** First whitespace-delimited token of a header value (paths in this convention never contain spaces). */
export function firstToken(value: string): string | undefined {
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
export function assignmentHeaderValues(headerRegion: string, label: string): string[] {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bold = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?\\*\\*\\s*${escaped}\\s*\\*\\*[ \\t]*:[ \\t]*(.*)$`)
  const plain = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escaped}[ \\t]*:[ \\t]*(.*)$`)
  const values: string[] = []
  for (const line of headerRegion.split(/\r?\n/)) {
    const raw = (line.match(bold) ?? line.match(plain))?.[1]
    const value = raw === undefined ? undefined : stripWrappingCodeSpan(raw.trim())
    if (value !== undefined && value !== '') values.push(value)
  }
  return values
}

/** A header value that means "no value" (placeholder conventions). Type guard so callers narrow to `string`. Shared with the agent-flow ledger  (one grammar, no copy-paste drift). */
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
 * Rebuild the canonical Assignment HEADER text from parsed fields (the
 * engine's OWN header grammar — `parseAssignmentFields` reads exactly these
 * labels — so the engine parsers round-trip losslessly). Every typed
 * `AssignmentFields` slot is emitted under its canonical header label: the
 * implement/ops `Task budget` (capacity contract spec § A1) after
 * `Task category`, and the review-seat `Budget` / `Return shape` round
 * bounds after the branch forms — dropping any of them would false-fire the
 * corresponding `assignment.field.*-missing` gate on a host that passed the
 * typed form. The host hook's engine-typed input is `AssignmentFields`; the
 * shared gate core validates assignment TEXT, so the fields form is
 * normalized to text before gating.
 */
export function assignmentTextFromFields(fields: AssignmentFields): string {
  const lines = ['## Assignment', '']
  if (fields.executeAs !== undefined) lines.push(`**Execute as**: ${fields.executeAs}`)
  if (fields.delegation !== undefined) lines.push(`**Delegation**: ${fields.delegation}`)
  if (fields.taskCategory !== undefined) lines.push(`**Task category**: ${fields.taskCategory}`)
  if (fields.taskBudget !== undefined) lines.push(`**Task budget (implement / ops rounds)**: ${fields.taskBudget}`)
  if (fields.workingBranch !== undefined) lines.push(`**Working branch**: ${fields.workingBranch}`)
  if (fields.branchPolicy !== undefined) lines.push(`**Branch policy**: ${fields.branchPolicy}`)
  if (fields.budget !== undefined) lines.push(`**Budget (review / QC seats)**: ${fields.budget}`)
  if (fields.returnShape !== undefined) lines.push(`**Return shape (review / QC seats)**: ${fields.returnShape}`)
  return lines.join('\n')
}
