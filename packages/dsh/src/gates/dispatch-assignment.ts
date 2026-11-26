/**
 * The Assignment FRONT MATTER grammar every dispatch-side gate reads: the
 * header-field extractor (`assignmentHeaderValue` with the shared code-span
 * and first-token normalization), the placeholder guard (`isNaValue`), the
 * plan-id derivation (`planIdOf`), the shape guard (`isAssignmentShaped` —
 * front matter or the engine's ONE D16 legacy recognition), the ONE
 * hard-enforcement resolution (`resolveDispatchHard`) and the typed-fields →
 * front-matter-text normalizer (`assignmentTextFromFields`).
 *
 * Module boundary: one responsibility — turn Assignment TEXT (or the host's
 * typed fields) into the front matter values a decision is made from. It makes
 * no decision itself: the lease, worktree and dispatch cores consume these
 * values. Callers MUST pass the engine `assignmentHeaderRegion` slice (the
 * fenced front matter fragment); the engine owns the front-matter/body
 * boundary and this module keeps no second grammar for it.
 *
 * No barrel: importers name this module by explicit relative path; it
 * re-exports nothing from a sibling and imports no sibling dispatch module.
 */
import { basename } from 'node:path'
import { extractFrontmatterAndBody, legacyAssignmentShape, parseDocumentFrontmatterEntries, parseEnforcementFlag } from '@mstar-harness/engine'
import type { AssignmentFields, FrontmatterEntry } from '@mstar-harness/engine'
import { resolveSeamHard } from './_shared.ts'
import type { Config } from './_shared.ts'

/** Shape-guard match of one Assignment core front matter key (engine parity:
 * the snake_case key inside the document's own fence declares the shape). */
const ASSIGNMENT_FM_FIELD_RE = /^[ \t]*(?:execute_as|delegation|task_category)\s*:/m

/**
 * True when the document OPENS with a front matter fence that carries a core
 * key (`execute_as` / `delegation` / `task_category` — the engine
 * `composeDispatchGate` shape grammar). An unterminated fence counts, so a
 * malformed document reaches schema validation instead of passing as an
 * ordinary prompt. The key must live in the FENCE: a `execute_as:` line
 * quoted in the body is prose, never shape evidence.
 * @param assignmentText - the carrier text.
 */
function frontmatterCarriesCoreKey(assignmentText: string): boolean {
  if (!assignmentText.startsWith('---\n') && !assignmentText.startsWith('---\r\n')) return false
  const { frontmatter, fenced } = extractFrontmatterAndBody(assignmentText)
  return ASSIGNMENT_FM_FIELD_RE.test(fenced ? frontmatter : assignmentText.slice(assignmentText.indexOf('\n') + 1))
}

/**
 * True when the text is Assignment-shaped for the dispatch gates: front
 * matter carrying a core key ({@link frontmatterCarriesCoreKey}), or the
 * engine's ONE D16 legacy recognition (`legacyAssignmentShape` — the
 * document must reach the gate's legacy-format refusal, never pass silently).
 * A prompt with no front matter is Assignment-shaped ONLY through that
 * legacy pattern: an `## Assignment` heading or a `**Execute as**:` line in
 * ordinary prose (a quoted template, a task body) declares nothing, so it
 * neither records a ledger row nor enters the field gate.
 * @param assignmentText - the carrier text (whole document).
 */
export function isAssignmentShaped(assignmentText: string): boolean {
  return frontmatterCarriesCoreKey(assignmentText) || legacyAssignmentShape(assignmentText)
}

/**
 * Resolve the hard-enforcement flag for one dispatch: explicit Config override
 * wins, else the Assignment's OWN `enforcement: hard` front matter flag
 * (fenced front matter only — a body-quoted example never hardens), else the
 * repo `.mstarc` `[config] enforcement`, else the iteration compass
 * frontmatter, else warn-only.
 */
export function resolveDispatchHard(harnessDir: string | null, config: Config, assignmentText: string): boolean {
  if (config.enforcement === 'hard') return true
  if (config.enforcement === 'soft') return false
  if (parseEnforcementFlag(assignmentText).hard) return true
  return resolveSeamHard(harnessDir, config)
}

/**
 * Convert the legacy display label of one Assignment field to its front
 * matter snake_case key (`Plan Path` → `plan_path`, `SDD dir` → `sdd_dir`,
 * `Task budget (implement / ops rounds)` → `task_budget` — the
 * parenthesized qualifier is the label suffix, never part of the key).
 */
function labelToFrontmatterKey(label: string): string {
  return label.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase().replace(/\s+/g, '_')
}

/**
 * Strip ONE wrapping markdown code span from a header value.
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

/**
 * The front matter entries of one header region, parsed ONCE with the shared
 * engine entries parser (`parseDocumentFrontmatterEntries`, fence-validated
 * via `extractFrontmatterAndBody`): a duplicate key, a nested key under a
 * scalar, or any other malformed line refuses the WHOLE block (null), so the
 * gates never read fields of a document the schema refuses. The region keeps
 * its fences (engine `assignmentHeaderRegion` contract); an unterminated
 * fence yields no block, exactly as `assignmentHeaderRegion` declares.
 */
function frontmatterEntriesOf(headerRegion: string): Map<string, FrontmatterEntry> | null {
  if (headerRegion === '') return null
  const { frontmatter, fenced } = extractFrontmatterAndBody(headerRegion)
  if (!fenced) return null
  try {
    return parseDocumentFrontmatterEntries(frontmatter, 'assignment')
  } catch {
    return null
  }
}

/** One scalar field value of a parsed entry: strings verbatim; a bare scalar
 * (`key:`) is present-but-empty; numbers/booleans read as their string form
 * (the line-shaped contract never typed them — the conversion only narrows
 * the entries API onto it). Lists, maps and block scalars are never a
 * single scalar field. */
function scalarEntryValue(entry: FrontmatterEntry): string | undefined {
  if (entry.kind !== 'scalar' && entry.kind !== 'block-scalar') return undefined
  if (typeof entry.value === 'string') return entry.value
  if (typeof entry.value === 'number' || typeof entry.value === 'boolean') return String(entry.value)
  if (entry.value === null) return ''
  return undefined
}

/**
 * Read one Assignment field from an ALREADY-parsed entry map — the shared
 * scalar read both the header-region and the decision-parse consumers use
 * (one grammar, one interpretation of an empty value).
 * @param entries - the parsed front matter (`null` = unparseable block).
 * @param label - the field label or snake_case key to read (e.g. `Plan Path`).
 */
export function assignmentEntriesValue(entries: Map<string, FrontmatterEntry> | null, label: string): string | undefined {
  const key = /^[a-z0-9_]+$/.test(label) ? label : labelToFrontmatterKey(label)
  const entry = entries?.get(key)
  if (entry === undefined) return undefined
  const scalar = scalarEntryValue(entry)
  if (scalar === undefined) return undefined
  const value = stripWrappingCodeSpan(scalar.trim())
  return value === '' ? undefined : value
}

/**
 * Parse one Assignment front matter field value by its snake_case key
 * (`parseAssignmentFields` semantics: the fenced front matter block is the
 * only field contract). Returns the trimmed value or undefined when the
 * field is absent/empty.
 *
 * Callers MUST pass the engine `assignmentHeaderRegion(assignmentText)`
 * slice, unless they hold the decision's ONE parse and use
 * {@link assignmentEntriesValue} directly.
 *
 * @param headerRegion - `assignmentHeaderRegion(assignmentText)`, never the raw text.
 * @param label - the field label or snake_case key to read (e.g. `Plan Path`).
 */
export function assignmentHeaderValue(headerRegion: string, label: string): string | undefined {
  return assignmentEntriesValue(frontmatterEntriesOf(headerRegion), label)
}

/** First whitespace-delimited token of a header value (paths in this convention never contain spaces). */
export function firstToken(value: string): string | undefined {
  const token = value.split(/\s+/)[0]
  return token === '' ? undefined : token
}

/** A header value that means "no value" (placeholder conventions). Type guard so callers narrow to `string`. Shared with the agent-flow ledger  (one grammar, no copy-paste drift). */
export function isNaValue(value: string | undefined): value is undefined {
  return value === undefined || /^(?:n\/?a|none)$/i.test(value)
}

/**
 * Resolve the target plan id from the Assignment front matter: `plan_path`
 * basename (`.md` stripped), else `sdd_dir` basename, else a `plan_id` key.
 * Exported for the agent-flow ledger's dispatch derivation (the ledger
 * records the same plan identity the gate resolved — one grammar).
 * @param headerRegion - `assignmentHeaderRegion(assignmentText)` (
 * only the front matter is read — a plan path quoted in the task body never
 * resolves a plan id).
 */
export function planIdOf(headerRegion: string): string | undefined {
  return planIdOfEntries(frontmatterEntriesOf(headerRegion))
}

/**
 * {@link planIdOf} over an already-parsed entry map: a caller that hoisted the
 * decision's ONE parse (the host adapter) reads the plan id without parsing
 * the document again.
 * @param entries - the decision's front matter parse (`null` = unparseable).
 */
export function planIdOfEntries(entries: Map<string, FrontmatterEntry> | null): string | undefined {
  const planPath = assignmentEntriesValue(entries, 'plan_path')
  if (!isNaValue(planPath)) {
    const id = basename(firstToken(planPath) ?? '')
    return id.endsWith('.md') ? id.slice(0, -3) : id
  }
  const sddDir = assignmentEntriesValue(entries, 'sdd_dir')
  if (!isNaValue(sddDir)) {
    const id = basename(firstToken(sddDir) ?? '')
    return id === '' ? undefined : id
  }
  const planId = assignmentEntriesValue(entries, 'plan_id')
  return isNaValue(planId) ? undefined : planId
}

/**
 * Rebuild the canonical Assignment front matter text from parsed fields (the
 * engine's OWN snake_case grammar — `parseAssignmentFields` reads exactly
 * these keys — so the engine parsers round-trip losslessly). Every typed
 * `AssignmentFields` slot is emitted under its canonical front matter key:
 * the implement/ops `task_budget` (capacity contract spec § A1) after
 * `task_category`, and the review-seat `budget` / `return_shape` round
 * bounds after the branch forms — dropping any of them would false-fire the
 * corresponding `assignment.field.*-missing` gate on a host that passed the
 * typed form. The host hook's engine-typed input is `AssignmentFields`; the
 * shared gate core validates assignment TEXT, so the fields form is
 * normalized to text before gating.
 */
export function assignmentTextFromFields(fields: AssignmentFields): string {
  const lines = ['---']
  if (fields.executeAs !== undefined) lines.push(`execute_as: ${fields.executeAs}`)
  if (fields.delegation !== undefined) lines.push(`delegation: ${fields.delegation}`)
  if (fields.taskCategory !== undefined) lines.push(`task_category: ${fields.taskCategory}`)
  if (fields.taskBudget !== undefined) lines.push(`task_budget: ${fields.taskBudget}`)
  if (fields.workingBranch !== undefined) lines.push(`working_branch: ${fields.workingBranch}`)
  if (fields.branchPolicy !== undefined) lines.push(`branch_policy: ${fields.branchPolicy}`)
  if (fields.budget !== undefined) lines.push(`budget: ${fields.budget}`)
  if (fields.returnShape !== undefined) lines.push(`return_shape: ${fields.returnShape}`)
  lines.push('---', '', '## Assignment', '')
  return lines.join('\n')
}
