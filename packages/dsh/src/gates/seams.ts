/**
 * Artifact seam gates — design-md / audit / compound / roles (plan
 * `20260810-dsh-entry-split` §10 extraction).
 *
 * Each seam gates `fs/write-intent` on its artifact scope (registered by the
 * entry `apply` with `prepend`): the content-blind listeners lint the
 * pre-write on-disk document with the status-gate repair-escape policy; the
 * known-document entry (`lintSeamWrite` + bound forms) implements the typed
 * hard veto (`SeamVetoError`). The per-seam validators (`validateDesignDoc` /
 * `validateAuditDoc` / `validateCompoundDoc` / `validateRolesState`) are the
 * module's wiring exports for the on-demand validate tools (Task 3).
 *
 * Module boundary: no barrel — the entry and the tools module import by
 * explicit relative path; public exports are re-exported verbatim by the
 * entry.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import {
  applyEnforcement,
  assertLightDarkParity,
  lintLoadOrder,
  referenceExists,
  validateAuditStatusBlocks,
  validateDesignTokenFrontmatter,
  validateRoleMapping,
  validateSchemaYaml,
} from '@mstar-harness/engine'
// `./src/audit` subpath import is PURE-FUNCTION-ONLY: it resolves to the
// separate `dist/audit.js` bundle, a distinct module instance from the
// barrel's `dist/engine.js` (each inlines its own copies of core/lease/
// path/status/workflow). Stateful or lock-bearing engine functions
// (withStatusWriteLock, registerWorkflow, promoteAuditPlans, writeJson,
// …) MUST NOT be imported via this subpath — cross-instance state would
// be duplicated. `redactSecrets` is a pure regex scan (no mutable
// module-level state), so this import is safe.
import { redactSecrets } from '@mstar-harness/engine/src/audit'
import type { GateResult, SecretFinding, ValidationResult } from '@mstar-harness/engine'
import type { FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { formatViolation, resolveSeamHard, HarnessResolver, actorAgentOf } from './_shared.ts'
import type { Config } from './_shared.ts'
// ---------------------------------------------------------------------------
// Artifact seam gates — design-md / audit / compound / roles
// ---------------------------------------------------------------------------

/** Per-seam dsh logger names (dsh logger naming: `<scope>/<subject>`). */
const SEAM_LOGGERS: Record<SeamId, string> = {
  'design-md': 'mstar/design-md-lint',
  audit: 'mstar/audit-lint',
  compound: 'mstar/compound-lint',
  roles: 'mstar/roles-lint',
}
/** The four artifact seams (design-md / audit / compound / roles). */
export type SeamId = 'design-md' | 'audit' | 'compound' | 'roles'
/**
 * Advisory emitted on seam-gate decisions (the `mstar/status-gate` /
 * `mstar/skill-lint` advisory pattern reused for the design-md / audit /
 * compound / roles artifact gates — one event with a `seam` discriminator,
 * consumers filter on it). Emitted when an in-scope artifact write-intent
 * finds violations in the pre-write on-disk document (warn mode), when hard
 * mode allows an ALREADY-invalid document as a repair escape, and when the
 * gate degrades to allow after an unexpected internal error. Clean passes
 * stay silent.
 *
 * The gate NEVER throws on the listener path (status-gate repair-escape
 * semantics): the intent waterfall carries no incoming content, so the only
 * lint signal is the pre-write on-disk state; the typed hard veto lives on
 * the known-document branch (`lintSeamWrite` + friends, `SeamVetoError`).
 */
export interface SeamLintAdvisory {
  /** The artifact seam that decided this intent. */
  seam: SeamId
  /** Which intent slot passed the gate (write-intent only — no linted edit slot). */
  operation: 'write'
  /** `displayPath` of the guarded file. */
  target: string
  /** The gate verdict (warn-mode: `hardBlocked` false; hard repair escape: `hardBlocked` true). */
  result: GateResult
  /** Resolved enforcement flag: false for warn-mode advisories, true for hard-mode repair escapes. */
  hard: boolean
  /** True when hard mode allowed a write to an ALREADY-invalid document (repair escape). */
  repair?: boolean
  /** True when the gate errored internally and degraded to allow (error-containment envelope). */
  degraded?: boolean
}
/** `index.md` / `README.md` are index files, not lintable documents
 * (audit-<date>/ index, knowledge/README.md index) — excluded from every
 * Seam scope so index writes never false-positive a Status-block /
 * frontmatter lint. */
function isIndexFile(path: string): boolean {
  const base = basename(path)
  return base === 'README.md' || base === 'index.md'
}

/** A `.md` document that is not an index file. */
function isMarkdownDoc(path: string): boolean {
  return path.endsWith('.md') && !isIndexFile(path)
}

/** Audit seam scope: `.md` plan files under a `plans/audit-*` directory
 * (mstar-audit § Phase 4 `{PLAN_DIR}/audit-<date>/` layout; `{PLAN_DIR}`
 * resolves under any `plans` segment). */
function isAuditPlanTarget(path: string): boolean {
  if (!isMarkdownDoc(path)) return false
  const segments = resolve(path).split(sep)
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] !== 'plans') continue
    const next = segments[i + 1]
    if (next !== undefined && next.startsWith('audit-')) return true
  }
  return false
}

/** Roles seam scope: `mstar-roles/SKILL.md` or any `.md` under
 * `mstar-roles/references/` (any depth — the skill dir may live at any
 * install location). */
function isRolesTarget(path: string): boolean {
  const segments = resolve(path).split(sep)
  const idx = segments.indexOf('mstar-roles')
  if (idx === -1) return false
  const rest = segments.slice(idx + 1)
  if (rest.length === 0) return false
  return rest[0] === 'SKILL.md' || (rest[0] === 'references' && rest[rest.length - 1].endsWith('.md'))
}

/** The mstar-roles skill dir of a target the roles matcher accepted
 * (unreachable `-1` falls back to the parent dir defensively). The split
 * of an absolute path starts with an empty segment, so the rebuild must
 * re-anchor at the root (path.join would drop the leading separator). */
function rolesDirOf(path: string): string {
  const segments = resolve(path).split(sep)
  const idx = segments.indexOf('mstar-roles')
  if (idx === -1) return dirname(path)
  return idx === 0 ? sep : join(sep, ...segments.slice(1, idx + 1))
}

/** Whether a target is in the seam's artifact scope. Design-md matches by
 * basename (the artifact is the file itself, wherever the design lives);
 * audit matches the `plans/audit-*` layout; compound matches
 * `{HARNESS_DIR}/knowledge/**` (inert without a harness dir); roles
 * matches the mstar-roles skill layout. */
function isSeamTarget(seam: SeamId, harnessDir: string | null, target: FsTarget): boolean {
  const path = resolve(target.displayPath)
  switch (seam) {
    case 'design-md': {
      const base = basename(path)
      return base === 'DESIGN.md' || base === 'DESIGN.dark.md'
    }
    case 'audit':
      return isAuditPlanTarget(path)
    case 'compound': {
      if (harnessDir === null) return false
      return path.startsWith(resolve(join(harnessDir, 'knowledge')) + sep) && isMarkdownDoc(path)
    }
    case 'roles':
      return isRolesTarget(path)
  }
}

/** One audit secret finding mapped to a gate violation (mstar-audit Hard
 * Rule 4: never reproduce secret values — reference file:line and type). */
function auditSecretsViolations(findings: readonly { line: number; type: string }[], file: string): ValidationResult[] {
  return findings.map((f) => ({
    ok: false,
    severity: 'high' as const,
    code: 'audit.secrets.found',
    message: `credential pattern "${f.type}" found on line ${f.line} in ${file} — audit plan files must never reproduce secret values (mstar-audit Hard Rule 4)`,
    fix: 'redact the value; reference the file:line and credential type only',
  }))
}

/**
 * Validate a DESIGN.md / DESIGN.dark.md document: token frontmatter plus
 * light/dark parity against the on-disk sibling when it exists (parity is
 * inherently cross-file — the sibling is read at validation time; a dark
 * write with no light sibling skips parity). Shared by the content-blind
 * listener and the known-document branch.
 */
export function validateDesignDoc(doc: string, path: string): GateResult {
  const violations = [...validateDesignTokenFrontmatter(doc).violations]
  const isDark = basename(path) === 'DESIGN.dark.md'
  const sibling = join(dirname(path), isDark ? 'DESIGN.md' : 'DESIGN.dark.md')
  if (existsSync(sibling)) {
    const light = isDark ? readFileSync(sibling, 'utf8') : doc
    const dark = isDark ? doc : readFileSync(sibling, 'utf8')
    violations.push(...assertLightDarkParity(light, dark).violations)
  }
  return violations.length === 0 ? { ok: true, violations } : { ok: false, violations }
}

/**
 * Validate an audit plan document: Status-block contract + secret scan.
 * The findings summary (line + type only — mstar-audit Hard Rule 4 never
 * reproduces secret values) rides along for the validate tool's `secrets`
 * output field; the gate path reads only `ok`/`violations`.
 */
export function validateAuditDoc(doc: string, path: string): GateResult & { findings: SecretFinding[] } {
  const redacted = redactSecrets(doc, path)
  const violations = [...validateAuditStatusBlocks(doc).violations]
  violations.push(...auditSecretsViolations(redacted.findings, path))
  return { ok: violations.length === 0, violations, findings: redacted.findings }
}

/**
 * Validate a knowledge doc: schema.yaml frontmatter contract + referenced
 * path/module existence. The repo root for `referenceExists` is derived as
 * the parent of `{HARNESS_DIR}` — the plan-conventions discovery layout
 * always places the harness dir directly under the repo root
 * (`<repo>/.mstar`, `<repo>/.agents`, `<repo>/plans`).
 * simplify: single-level harness layout — revisit if a nested harness root
 * becomes an observed deployment.
 */
export function validateCompoundDoc(doc: string, _path: string, harnessDir: string | null): GateResult {
  const violations = [...validateSchemaYaml(doc).violations]
  if (harnessDir !== null) {
    violations.push(...referenceExists(dirname(harnessDir), doc).violations)
  }
  return violations.length === 0 ? { ok: true, violations } : { ok: false, violations }
}

/**
 * Validate the mstar-roles skill-dir state: role mapping / parameter tables
 * against the on-disk references layout, plus load-order declarations
 * across every sibling `mstar-*` skill (unreadable sibling SKILL.md files
 * are skipped — best-effort reads for a lint that must never take the gate
 * down). The `skillsRoot` override exists for the validate tool (its
 * explicit `skills_root` parameter); the gate path keeps the default
 * (the parent of the roles dir).
 * @param rolesDir - the mstar-roles skill directory.
 * @param skillsRoot - directory scanned for sibling `mstar-*` skills
 * (default: `dirname(rolesDir)`).
 */
export function validateRolesState(rolesDir: string, skillsRoot: string = dirname(rolesDir)): GateResult {
  const violations = [...validateRoleMapping(rolesDir).violations]
  const skillTexts: Record<string, string> = {}
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('mstar-')) continue
    const skillFile = join(skillsRoot, entry.name, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    try {
      skillTexts[entry.name] = readFileSync(skillFile, 'utf8')
    } catch {
      // skip unreadable sibling — the mapping checks still stand
    }
  }
  violations.push(...lintLoadOrder(skillTexts).violations)
  return violations.length === 0 ? { ok: true, violations } : { ok: false, violations }
}

/** Run one seam's validator over a KNOWN document (or dir state for roles). */
function validateSeamDoc(seam: SeamId, doc: string, path: string, harnessDir: string | null): GateResult {
  switch (seam) {
    case 'design-md':
      return validateDesignDoc(doc, path)
    case 'audit':
      return validateAuditDoc(doc, path)
    case 'compound':
      return validateCompoundDoc(doc, path, harnessDir)
    case 'roles':
      return validateRolesState(rolesDirOf(path))
  }
}

/** Best-effort advisory emit: a throwing consumer must not take the gate
 * down with it (the error log is the durable signal). */
function emitSeamAdvisory(
  ctx: Context,
  seam: SeamId,
  target: string,
  result: GateResult,
  hard: boolean,
  extra: { repair?: boolean; degraded?: boolean } = {},
): void {
  try {
    ctx.emit('mstar/seam-lint', { seam, operation: 'write', target, result, hard, ...extra })
  } catch (emitError) {
    ctx.logger(SEAM_LOGGERS[seam]).error(`seam lint degraded advisory emit failed: ${(emitError as Error).message}`)
  }
}

/**
 * Gate one fs write-intent on a gated artifact. The slot is content-blind
 * (the intent waterfall carries only `(target, actor)` — never the incoming
 * content), so the lint signal is the pre-write on-disk document
 * (single-read). Enforcement policy (skill-lint gate mirror; documented in
 * task-3-report.md):
 *
 * - missing file → pass (first create has no document to lint);
 * - clean on-disk doc → silent pass (blocking valid writes would deadlock
 *   normal authoring — the slot cannot see the incoming content);
 * - violations + warn mode (default) → warn log + advisory + delegate;
 * - violations + hard mode → REPAIR ESCAPE: the on-disk doc is ALREADY
 *   invalid, so this write may BE the repair — allow with an error-level
 *   log + repair advisory (`hard: true, repair: true`). A hard veto there
 *   would deadlock the repairing write; the typed hard veto lives on the
 *   known-document branch (`lintSeamWrite`, `SeamVetoError`) where the
 *   document is known.
 *
 * The gate never throws; unexpected internal errors degrade to allow in
 * BOTH modes with a loud log + `degraded: true` advisory (error-containment
 * envelope — an untyped throw from the gate would spuriously block
 * legitimate writes).
 */
function gateSeamIntent(ctx: Context, harnessDir: string | null, config: Config, seam: SeamId, target: FsTarget): void {
  const logger = ctx.logger(SEAM_LOGGERS[seam])
  try {
    if (!isSeamTarget(seam, harnessDir, target)) return
    const path = resolve(target.displayPath)
    if (!existsSync(path)) return // first create — nothing to lint yet
    let doc: string
    try {
      doc = readFileSync(path, 'utf8')
    } catch (error) {
      logger.error(`seam lint degraded to allow (cannot read ${path}): ${(error as Error).message}`)
      emitSeamAdvisory(ctx, seam, target.displayPath, { ok: true, violations: [] }, false, { degraded: true })
      return
    }
    const result = validateSeamDoc(seam, doc, path, harnessDir)
    if (result.ok) return
    const hard = resolveSeamHard(harnessDir, config)
    const verdict = applyEnforcement(result, { hard })
    if (verdict.hardBlocked) {
      // Repair escape: the current document is already invalid; this write
      // may BE the repair — allow, but make the degraded control loud.
      logger.error(
        `${basename(path)} write to ${target.displayPath} ALLOWED as repair (Enforcement: hard; the current on-disk document is already invalid — the intent carries no incoming content, so the vetoable signal is only the pre-write state):\n${verdict.violations.map(formatViolation).join('\n')}`,
      )
      emitSeamAdvisory(ctx, seam, target.displayPath, verdict, hard, { repair: true })
    } else {
      logger.warn(`${basename(path)} write to ${target.displayPath} (advisory):\n${verdict.violations.map(formatViolation).join('\n')}`)
      emitSeamAdvisory(ctx, seam, target.displayPath, verdict, hard)
    }
  } catch (error) {
    logger.error(`seam lint gate degraded to allow: ${(error as Error).message}`)
    emitSeamAdvisory(ctx, seam, target.displayPath, { ok: true, violations: [] }, false, { degraded: true })
  }
}

/**
 * `fs/write-intent` listener for one seam gate. Registered with `prepend`
 * for the same reachability reason as the status gate: the slot is
 * first-wins by registration order (dsh-fs-policy README), so without
 * prepend a policy plugin mounted earlier would make this gate unreachable.
 * Every gate decision (warn advisory, repair escape, degraded allow) calls
 * `next()` — the seam gates never own the intent decision and must not
 * terminate the chain (fs-policy's observed-state CAS stays live in
 * composed deployments).
 */
export async function seamWriteIntentListener(
  ctx: Context,
  resolver: HarnessResolver,
  config: Config,
  seam: SeamId,
  target: FsTarget,
  actor: object | undefined,
  next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>,
): Promise<FsWriteIntent | undefined> {
  gateSeamIntent(ctx, resolver.forAgent(actorAgentOf(actor)), config, seam, target)
  return await next()
}

/**
 * Typed hard-mode veto for the seam gates (the dsh fs-policy veto channel:
 * "veto = throw"; the write tool turns the throw into an isError tool
 * result carrying `{ name, code }`). Thrown ONLY by {@link lintSeamWrite} —
 * the entry that lints a KNOWN incoming document (the brief's "hard veto
 * via throw where the slot semantics allow" branch). The content-blind
 * `fs/write-intent` listeners never throw: they cannot distinguish a repair
 * from a re-violation, so hard mode degrades to the repair escape there
 * (see {@link gateSeamIntent}).
 */
export class SeamVetoError extends Error {
  /** Stable code for tool-result serialization (the `{ name, code }` convention). */
  readonly code = 'seam.veto' as const
  /** The seam whose gate vetoed the write. */
  readonly seam: SeamId
  /** The violations that caused the veto. */
  readonly violations: readonly ValidationResult[]

  constructor(seam: SeamId, target: string, violations: readonly ValidationResult[]) {
    super(
      `${target} write vetoed by Enforcement: hard — the incoming document fails the ${seam} seam lints:\n${violations.map(formatViolation).join('\n')}`,
    )
    this.name = 'SeamVetoError'
    this.seam = seam
    this.violations = violations
  }
}

/**
 * Enforce one seam's lints over a KNOWN document (the brief's "incoming
 * doc when available" branch): `Enforcement: hard` + violations → throw the
 * typed {@link SeamVetoError} (fs-policy veto channel); warn mode → return
 * the gate for advisory logging. A repairing write carries a VALID incoming
 * document and passes by construction — no repair escape is needed on this
 * branch. The content-blind listener paths (where the incoming doc is never
 * visible) route through {@link gateSeamIntent} instead, which applies the
 * repair-escape decision.
 * @param seam - the artifact seam whose validator runs.
 * @param doc - the document about to be written (roles: ignored — the
 * validator checks the whole mstar-roles dir state).
 * @param options - target display path (veto message) + resolved hard flag
 * + the plugin harness dir (compound reference checks; null-tolerant).
 */
export function lintSeamWrite(
  seam: SeamId,
  doc: string,
  options: { target: string; hard: boolean; harnessDir?: string | null },
): GateResult {
  const result = validateSeamDoc(seam, doc, options.target, options.harnessDir ?? null)
  if (options.hard && !result.ok) {
    throw new SeamVetoError(seam, options.target, result.violations)
  }
  return result
}

/** {@link lintSeamWrite} bound to the design-md seam. */
export function lintDesignMdWrite(
  doc: string,
  options: { target: string; hard: boolean; harnessDir?: string | null },
): GateResult {
  return lintSeamWrite('design-md', doc, options)
}

/** {@link lintSeamWrite} bound to the audit seam. */
export function lintAuditWrite(
  doc: string,
  options: { target: string; hard: boolean; harnessDir?: string | null },
): GateResult {
  return lintSeamWrite('audit', doc, options)
}

/** {@link lintSeamWrite} bound to the compound seam. */
export function lintCompoundWrite(
  doc: string,
  options: { target: string; hard: boolean; harnessDir?: string | null },
): GateResult {
  return lintSeamWrite('compound', doc, options)
}

/** {@link lintSeamWrite} bound to the roles seam. */
export function lintRolesWrite(
  doc: string,
  options: { target: string; hard: boolean; harnessDir?: string | null },
): GateResult {
  return lintSeamWrite('roles', doc, options)
}
