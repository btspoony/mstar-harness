/**
 * Skill-authoring lint gate — `SKILL.md` write-intent gating under the
 * configured skill roots (plan `20260810-dsh-entry-split` §9 extraction).
 *
 * The content-blind `fs/write-intent` listener (`skillWriteIntentListener`,
 * registered by the entry `apply` with `prepend`) lints the pre-write
 * on-disk document and applies the status-gate repair-escape policy; the
 * known-document entries (`lintSkillDoc` / `lintSkillWrite`) implement the
 * typed hard veto (`SkillLintVetoError`, fs-policy "veto = throw" channel).
 *
 * Module boundary: no barrel — the entry imports by explicit relative path;
 * public exports are re-exported verbatim by the entry.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import {
  applyEnforcement,
  findEphemeralCitations,
  lintFiveQuestion,
  lintFrontmatter,
  resolveAssetPath,
  resolveSkillRoot,
} from '@mstar-harness/engine'
import type { EphemeralCitation, GateResult, ValidationResult } from '@mstar-harness/engine'
import type { FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { formatViolation, packagedSkillsDir, resolveSeamHard, HarnessResolver, actorAgentOf } from './_shared.ts'
import type { Config } from './_shared.ts'
/** Logger label for the skill lint gate (dsh logger naming: `<scope>/<subject>`). */
const SKILL_LINT_LOGGER = 'mstar/skill-lint'
/**
 * Advisory emitted on skill-lint gate decisions (the `mstar/status-gate`
 * advisory pattern reused for the skill-authoring gate). Emitted
 * when a `SKILL.md` write-intent under a configured skill root finds lint
 * violations in the pre-write on-disk document (warn mode), when hard mode
 * allows an ALREADY-invalid document as a repair escape, and when the gate
 * degrades to allow after an unexpected internal error. Clean passes stay
 * silent.
 *
 * The gate NEVER throws on the listener path (status-gate repair-escape
 * semantics): the intent waterfall carries no incoming content, so the only
 * lint signal is the pre-write on-disk state; the typed hard veto lives on
 * the incoming-document branch (`lintSkillWrite`, `SkillLintVetoError`).
 */
export interface SkillLintAdvisory {
  /** Which intent slot passed the gate (write-intent only — skills have no linted edit slot). */
  operation: 'write'
  /** `displayPath` of the guarded SKILL.md. */
  target: string
  /** Canonical skill-root form of the target (`resolveSkillRoot('dsh', …)` form). */
  canonical: string
  /** The lint verdict (warn-mode: `hardBlocked` false; hard repair escape: `hardBlocked` true). */
  result: GateResult
  /** Resolved enforcement flag: false for warn-mode advisories, true for hard-mode repair escapes. */
  hard: boolean
  /** True when hard mode allowed a write to an ALREADY-invalid document (repair escape). */
  repair?: boolean
  /** True when the gate errored internally and degraded to allow (error-containment envelope). */
  degraded?: boolean
}
/**
 * Typed hard-mode veto for the skill lint gate (the dsh fs-policy veto
 * channel: "veto = throw"; the write tool turns the throw into an isError
 * tool result carrying `{ name, code }`). Thrown ONLY by
 * {@link lintSkillWrite} — the entry that lints a KNOWN incoming document
 * (the brief's "against the incoming doc when available" branch). The
 * content-blind `fs/write-intent` listener never throws: it cannot
 * distinguish a repair from a re-violation, so hard mode degrades to the
 * status-gate repair escape there (see {@link gateSkillIntent}).
 */
export class SkillLintVetoError extends Error {
  /** Stable code for tool-result serialization (the `{ name, code }` convention). */
  readonly code = 'skill-lint.veto' as const
  /** The lint violations that caused the veto. */
  readonly violations: readonly ValidationResult[]

  constructor(target: string, violations: readonly ValidationResult[]) {
    super(
      `SKILL.md write to ${target} vetoed by Enforcement: hard — the incoming document fails the skill-authoring lints:\n${violations.map(formatViolation).join('\n')}`,
    )
    this.name = 'SkillLintVetoError'
    this.violations = violations
  }
}

/**
 * Strip a leading `---`-fenced YAML frontmatter block, returning the body
 * (five-question lint takes the body; the frontmatter lint takes the full
 * doc — CLI `mstar skill lint` parity, same semantics).
 */
function stripFrontmatter(text: string): string {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') return text
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(i + 1).join('\n')
  }
  return text
}

/** Ephemeral-citation violation codes (knowledge
 * conventions/skill-content-porting-discipline.md §3 — "No ephemeral
 * citations in durable skill text": concrete per-task artifacts and SDD
 * deeplinks survive nothing). Severity `medium` — the gate's warn/hard mode
 * mapping is inherited from the caller (see {@link lintSkillWrite}). */
const EPHEMERAL_CODES: Record<EphemeralCitation['kind'], string> = {
  'task-artifact': 'skill.ephemeral.task-artifact',
  'sdd-deeplink': 'skill.ephemeral.sdd-deeplink',
}

/** Wrap one engine {@link EphemeralCitation} as a ValidationResult violation. */
function ephemeralViolation(citation: EphemeralCitation): ValidationResult {
  return {
    ok: false,
    severity: 'medium',
    code: EPHEMERAL_CODES[citation.kind],
    message: `ephemeral citation \`${citation.match}\` on line ${citation.line} — durable skill text must reference in-repo artifacts only (knowledge conventions/skill-content-porting-discipline.md §3)`,
  }
}

/**
 * Lint one SKILL.md document with the engine skill-authoring lints
 * (`lintFrontmatter` + `lintFiveQuestion` + `findEphemeralCitations` — the
 * CLI `mstar skill lint` combination plus the ephemeral-citation gate;
 * violation codes `lint.frontmatter.*` / `skill-authoring.five-question.*`
 * / `skill.ephemeral.*`). Pure: no enforcement, no I/O.
 * @param doc - the full SKILL.md text.
 */
export function lintSkillDoc(doc: string): GateResult {
  const violations: ValidationResult[] = []
  const frontmatter = lintFrontmatter(doc)
  if (!frontmatter.ok) violations.push(...frontmatter.violations)
  const body = lintFiveQuestion(stripFrontmatter(doc))
  if (!body.ok) violations.push(...body.violations)
  // Ephemeral-citation finder is discovery-only (engine returns an array, not
  // a GateResult) — wrap into violations here. Deliberately the ONLY wiring
  // point: `lintSkillWrite` delegates to this entry (hard veto inherited) and
  // `gateSkillIntent` lints the on-disk doc through the same path (repair
  // escape inherited) — no double counting.
  violations.push(...findEphemeralCitations(doc).map(ephemeralViolation))
  return violations.length === 0 ? { ok: true, violations } : { ok: false, violations }
}

/**
 * Enforce the skill-authoring lints over a KNOWN document (the brief's
 * "incoming doc when available" branch): `Enforcement: hard` + violations →
 * throw the typed {@link SkillLintVetoError} (fs-policy veto channel); warn
 * mode → return the gate for advisory logging. A repairing write carries a
 * VALID incoming document and passes by construction — no repair escape is
 * needed on this branch. The content-blind listener path (where the
 * incoming doc is never visible) routes through {@link gateSkillIntent}
 * instead, which applies the status-gate repair-escape decision.
 * @param doc - the document about to be written (the write's content).
 * @param options - target display path (veto message) + resolved hard flag.
 */
export function lintSkillWrite(doc: string, options: { target: string; hard: boolean }): GateResult {
  const result = lintSkillDoc(doc)
  if (options.hard && !result.ok) {
    throw new SkillLintVetoError(options.target, result.violations)
  }
  return result
}

/**
 * The configured skill roots the lint gate scopes to (Config `skillRoots`
 * custom roots + `bundledSkillDir`, same trim/filter semantics as
 * {@link skillLocalConfig}). Empty when nothing is configured — the gate
 * is inert.
 */
function skillRootsOf(config: Config): string[] {
  const bundled = config.bundledSkillDir?.trim() ?? packagedSkillsDir()
  const roots = [...(config.skillRoots ?? []), ...(bundled !== undefined ? [bundled] : [])]
  return roots.map((root) => root.trim()).filter((root) => root !== '')
}

/**
 * Whether a target is a `SKILL.md` UNDER one of the configured skill roots
 * (resolved-path containment — skill-filesystem shapes `<root>/<name>/SKILL.md`).
 * Matching is by resolved path on `displayPath` (the local backend reports
 * absolute paths; remote/URI backends never resolve under a local root and
 * the gate is inert for them — status-gate discipline).
 *
 * simplify: case-sensitive containment — on case-insensitive
 * filesystems a case-variant path escapes the gate (inert, never a false
 * positive); revisit if case-variant writes become an observed bypass.
 */
function isSkillTarget(roots: readonly string[], target: FsTarget): boolean {
  if (basename(target.displayPath) !== 'SKILL.md') return false
  const resolvedPath = resolve(target.displayPath)
  return roots.some((root) => resolvedPath.startsWith(resolve(root) + sep))
}

/** The skill directory name of a SKILL.md target (the canonical skill id). */
function skillNameOf(target: FsTarget): string {
  return basename(dirname(target.displayPath))
}

/** The canonical skill-root form of a SKILL.md target (frozen
 * `resolveSkillRoot('dsh', …)` form — `$DSH_BUNDLED_SKILL_DIR/<name>/SKILL.md`). */
function skillCanonicalForm(target: FsTarget): string {
  return resolveSkillRoot('dsh', { skill: skillNameOf(target), rel: 'SKILL.md' })
}

/**
 * Gate one fs write-intent on a `SKILL.md` under a configured skill root.
 * The slot is content-blind (the intent waterfall carries only
 * `(target, actor)` — never the incoming content, dsh-private tool-fs
 * write.ts), so the lint signal is the pre-write on-disk document
 * (single-read). Enforcement policy (decided here, documented in
 * status-gate repair-escape mirror):
 *
 * - missing file → pass (first create has no document to lint);
 * - clean on-disk doc → silent pass (blocking valid-skill writes would
 *   deadlock normal authoring — the slot cannot see the incoming content);
 * - violations + warn mode (default) → warn log + advisory + delegate;
 * - violations + hard mode → REPAIR ESCAPE: the on-disk doc is ALREADY
 *   invalid, so this write may BE the repair — allow with an error-level
 *   log + repair advisory (`hard: true, repair: true`). A hard veto there
 *   would deadlock the repairing write; the typed hard veto lives on the
 *   incoming-doc branch ({@link lintSkillWrite}) where the document is
 *   known.
 *
 * The gate never throws (except the intentional {@link lintSkillWrite}
 * veto on the other branch); unexpected internal errors degrade to allow
 * in BOTH modes with a loud log + `degraded: true` advisory
 * (error-containment envelope — an untyped throw from the gate would
 * spuriously block legitimate writes).
 */
function gateSkillIntent(ctx: Context, harnessDir: string | null, config: Config, target: FsTarget): void {
  try {
    const roots = skillRootsOf(config)
    if (roots.length === 0) return
    if (!isSkillTarget(roots, target)) return
    const skillPath = resolve(target.displayPath)
    if (!existsSync(skillPath)) return // first create — nothing to lint yet
    let doc: string
    try {
      doc = readFileSync(skillPath, 'utf8')
    } catch (error) {
      // Single-read contract: an unreadable on-disk doc is an unexpected
      // error — degrade to allow with a degraded advisory (never a throw).
      ctx.logger(SKILL_LINT_LOGGER).error(`skill lint degraded to allow (cannot read ${skillPath}): ${(error as Error).message}`)
      ctx.emit('mstar/skill-lint', {
        operation: 'write',
        target: target.displayPath,
        canonical: skillCanonicalForm(target),
        result: { ok: true, violations: [] },
        hard: false,
        degraded: true,
      })
      return
    }
    const result = lintSkillDoc(doc)
    if (result.ok) return
    const hard = resolveSeamHard(harnessDir, config)
    // The advisory carries the ENFORCED verdict (status-gate shape:
    // `hardBlocked` true on the hard repair escape — the write would have
    // been blocked, and is allowed as a repair).
    const verdict = applyEnforcement(result, { hard })
    // resolveAssetPath renders the canonical skill-relative asset form
    // (mstar-skill-authoring § Skill-relative script and asset paths) — the
    // fix instruction for the violating file in the log line below.
    const fixHint = resolveAssetPath(skillNameOf(target), 'SKILL.md', 'dsh')
    if (hard) {
      // Repair escape: the current document is already invalid; this write
      // may BE the repair — allow, but make the degraded control loud
      // (error-level log + repair advisory, `hard: true`).
      ctx.logger(SKILL_LINT_LOGGER).error(
        `SKILL.md write to ${target.displayPath} ALLOWED as repair (Enforcement: hard; the current on-disk document is already invalid — the intent carries no incoming content, so the vetoable signal is only the pre-write state):\n${verdict.violations.map(formatViolation).join('\n')}\n${fixHint}`,
      )
      ctx.emit('mstar/skill-lint', { operation: 'write', target: target.displayPath, canonical: skillCanonicalForm(target), result: verdict, hard, repair: true })
    } else {
      ctx.logger(SKILL_LINT_LOGGER).warn(
        `SKILL.md write to ${target.displayPath} (advisory):\n${verdict.violations.map(formatViolation).join('\n')}\n${fixHint}`,
      )
      ctx.emit('mstar/skill-lint', { operation: 'write', target: target.displayPath, canonical: skillCanonicalForm(target), result: verdict, hard })
    }
  } catch (error) {
    ctx.logger(SKILL_LINT_LOGGER).error(`skill lint gate degraded to allow: ${(error as Error).message}`)
    try {
      ctx.emit('mstar/skill-lint', { operation: 'write', target: target.displayPath, canonical: skillCanonicalForm(target), result: { ok: true, violations: [] }, hard: false, degraded: true })
    } catch (emitError) {
      // Best-effort observability: a throwing advisory consumer must not
      // take the gate down with it (the error log above is the durable
      // signal).
      ctx.logger(SKILL_LINT_LOGGER).error(`skill lint degraded advisory emit failed: ${(emitError as Error).message}`)
    }
  }
}

/**
 * `fs/write-intent` listener for the skill lint gate. Registered with
 * `prepend` for the same reachability reason as the status gate: the slot
 * is first-wins by registration order (dsh-fs-policy README), so without
 * prepend a policy plugin mounted earlier would make this gate unreachable.
 * Every gate decision (warn advisory, repair escape, degraded allow) calls
 * `next()` — the skill lint gate never owns the intent decision and must
 * not terminate the chain (fs-policy's observed-state CAS on skill files
 * stays live in composed deployments).
 */
export async function skillWriteIntentListener(
  ctx: Context,
  resolver: HarnessResolver,
  config: Config,
  target: FsTarget,
  actor: object | undefined,
  next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>,
): Promise<FsWriteIntent | undefined> {
  gateSkillIntent(ctx, resolver.forAgent(actorAgentOf(actor)), config, target)
  return await next()
}
