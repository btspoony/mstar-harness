/**
 * Morning Star harness gates for dsh (DeepSeek Harness).
 *
 * Cordis function plugin: named exports only — the dsh Loader discards the plugin's namespace
 * (dropping `inject` metadata) when a default export is present, so this module never
 * default-exports. Registrations happen through `ctx` effects/events in `apply`.
 *
 * @module @mstar-harness/dsh
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from 'cordis'
import {
  apply as applySkillLocal,
  Config as SkillLocalSchema,
  inject as skillLocalInject,
  name as skillLocalName,
} from '@deepseek-ai/dsh-skill-local'
import type { Config as SkillLocalConfig } from '@deepseek-ai/dsh-skill-local'
import {
  applyEnforcement,
  assertIndexRows,
  assertLightDarkParity,
  assignmentHeaderRegion,
  completenessLevel,
  composeDispatchGate,
  evaluatePhaseGate,
  executionModeToN,
  isReadOnlyAssignmentRole,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  lintLoadOrder,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseCompassFrontmatter,
  parseEnforcementFlag,
  readJson,
  redactSecrets,
  referenceExists,
  resolveCompassEnforcement,
  resolveIterationDir,
  scopeGuard,
  sddWorkspace,
  taskBrief,
  validateAuditStatusBlocks,
  validateDesignTokenFrontmatter,
  validateExecutionLease,
  validateIntegrationMergeLease,
  validateRoleMapping,
  validateSchemaYaml,
  verifyPlanExecutionLease,
} from '@mstar-harness/engine'
import type {
  AssignmentFields,
  GateResult,
  HostAdapter,
  IntegrationMergeLease,
  SecretFinding,
  StatusDoc,
  ValidationResult,
  WorktreeTrack,
} from '@mstar-harness/engine'
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: loads the `ctx.commands` cordis augmentation + the command
// handler invocation shape from the (peer-stub / real) dsh-commands seam —
// the runtime registration goes through `ctx.inject(['commands'], …)`.
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { DshMstar } from './service.ts'
import type {
  HarnessLeaseView,
  HarnessPlanView,
  HarnessResidualView,
  IterationGateListView,
  IterationGateViolationView,
  IterationGateView,
  MstarEngineStatusSource,
  MstarHarnessState,
  MstarIterationGateView,
} from './types.ts'
import {
  Config,
  STATUS_FILE,
  asRecord,
  formatViolation,
  packagedSkillsDir,
  resolveSeamHard,
  HarnessResolver,
  sessionCwdOf,
  actorAgentOf,
} from './gates/_shared.ts'
import { writeIntentListener, editIntentListener } from './gates/status.ts'
import { validateStatusValue, validateStatusDoc } from './gates/status.ts'
import type { StatusGateAdvisory } from './gates/status.ts'
import { skillWriteIntentListener } from './gates/skill-lint.ts'
import type { SkillLintAdvisory } from './gates/skill-lint.ts'

// Re-export the service type from the package entry: the cordis
// `Context` augmentation (`ctx.dshMstar`) lives in service.d.ts, so the entry
// must reference it for consumers importing `@mstar-harness/dsh` to see a
// typed `ctx.dshMstar`.
export { DshMstar } from './service.ts'
export type { DshMstarOptions } from './service.ts'
export type { MstarEngineStatusSource, MstarHarnessState, MstarIterationGateView } from './types.ts'
export { Config, HarnessResolver } from './gates/_shared.ts'
export type { StatusGateAdvisory } from './gates/status.ts'
export { SkillLintVetoError, lintSkillDoc, lintSkillWrite } from './gates/skill-lint.ts'
export type { SkillLintAdvisory } from './gates/skill-lint.ts'

/** Cordis function-plugin name registered by the Loader. */
export const name = 'dsh'

/**
 * Services required before this plugin's `apply` fiber starts.
 * Empty for the scaffold: the plan's gates register on events (`fs/write-intent`,
 * `tools/pre-execute`), not on injected services; `inject` grows if a service seam is needed.
 */
export const inject: string[] = []

/** Logger label for the dispatch gate (dsh logger naming: `<scope>/<subject>`). */
const DISPATCH_LOGGER = 'mstar/dispatch-gate'

/** Logger label for the host adapter (dsh logger naming: `<scope>/<subject>`). */
const HOST_LOGGER = 'mstar/host-adapter'

/** Logger label for the engine-status catalog (dsh logger naming: `<scope>/<subject>`). */
const CATALOG_LOGGER = 'mstar/engine-status-catalog'

/** Default catalog cache refresh interval (ms) — see Config `catalogTtlMs`. */
const DEFAULT_CATALOG_TTL_MS = 60_000

/** Catalog cache key for the explicit-`harnessDir` app-wide entry (one entry for every session). */
const EXPLICIT_CACHE_KEY = '\u0000explicit'

/** Residual severity vocabulary (mstar-plan-artifacts severity SSOT order). */
const RESIDUAL_SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit'] as const

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

declare module 'cordis' {
  interface Context {
    /**
     * The plugin's engine `HostAdapter` implementation (`host: 'dsh'`) —
     * provided as a dsh service (constructed in `apply`, same convention as
     * `ctx.dshMstar`) so host hooks and future inject consumers share the
     * one instance.
     */
    dshHostAdapter: DshHostAdapter
  }

  interface Events {
    /**
     * Advisory: a subagent dispatch passed the dispatch gate in warn mode
     * (violations logged, dispatch allowed). Emitted only when the Assignment
     * has violations; clean passes stay silent.
     * @param payload - the gate verdict and dispatch identity.
     * @mode emit
     */
    'mstar/dispatch-gate'(payload: DispatchGateAdvisory): void
    /**
     * Advisory: a `{HARNESS_DIR}/status.json` write/edit intent passed the
     * status gate in warn mode (violations logged, write allowed). Emitted
     * only when the current document has violations; clean passes stay silent.
     * @param payload - the gate verdict and target.
     * @mode emit
     */
    'mstar/status-gate'(payload: StatusGateAdvisory): void
    /**
     * Advisory: a `SKILL.md` write-intent under a configured skill root
     * found skill-authoring lint violations in the pre-write on-disk
     * document (warn mode), was allowed as a hard-mode repair escape, or
     * degraded to allow. Emitted only when the current document has
     * violations; clean passes stay silent.
     * @param payload - the lint verdict and target.
     * @mode emit
     */
    'mstar/skill-lint'(payload: SkillLintAdvisory): void
    /**
     * Advisory: an artifact-scoped write-intent (DESIGN.md / DESIGN.dark.md,
     * audit plan files under `plans/audit-*`, knowledge docs under
     * `{HARNESS_DIR}/knowledge/`, mstar-roles SKILL.md + references) found
     * engine violations in the pre-write on-disk document (warn mode), was
     * allowed as a hard-mode repair escape, or degraded to allow. Emitted
     * only when the current document has violations; clean passes stay
     * silent. The `seam` field discriminates the four gates.
     * @param payload - the gate verdict, seam, and target.
     * @mode emit
     */
    'mstar/seam-lint'(payload: SeamLintAdvisory): void
  }
}

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
function validateDesignDoc(doc: string, path: string): GateResult {
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
function validateAuditDoc(doc: string, path: string): GateResult & { findings: SecretFinding[] } {
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
function validateCompoundDoc(doc: string, _path: string, harnessDir: string | null): GateResult {
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
function validateRolesState(rolesDir: string, skillsRoot: string = dirname(rolesDir)): GateResult {
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
async function seamWriteIntentListener(
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

/**
 * True when the text looks like an Assignment (opencode parity: `## Assignment`
 * heading or at least one core field line). Non-Assignment delegation prompts
 * stay silent — no false-positive warnings. Callers MUST pass the engine
 * `assignmentHeaderRegion` slice: a `## Assignment` heading or
 * field line quoted in the task body must not shape a non-assignment prompt.
 */
function isAssignmentShaped(assignmentText: string): boolean {
  return ASSIGNMENT_HEADING_RE.test(assignmentText) || assignmentText.match(ASSIGNMENT_FIELD_RE) !== null
}

/**
 * Resolve the hard-enforcement flag for one dispatch: explicit Config override
 * wins, else the Assignment's OWN `Enforcement: hard` header flag (opencode
 * parity — header region only, a body-quoted example never hardens), else the
 * iteration compass frontmatter, else warn-only.
 */
function resolveDispatchHard(harnessDir: string | null, config: Config, assignmentText: string): boolean {
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

/** A header value that means "no value" (placeholder conventions). Type guard so callers narrow to `string`. */
function isNaValue(value: string | undefined): value is undefined {
  return value === undefined || /^(?:n\/?a|none)$/i.test(value)
}

/**
 * Resolve the target plan id from the Assignment HEADER region: `Plan Path`
 * basename (`.md` stripped), else `SDD dir` basename, else a `plan_id` field.
 * @param headerRegion - `assignmentHeaderRegion(assignmentText)` (
 * only the header is read — a plan path quoted in the task body never
 * resolves a plan id).
 */
function planIdOf(headerRegion: string): string | undefined {
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

/** The dispatching session's stable id, when the seam exposes it (dsh Agent.id). */
function sessionIdOf(exec: ToolExecution): string | undefined {
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
function leaseGateViolations(
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
function dispatchGateCore(
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
  const result = adapter.dispatchGate(prompt, exec)
  const hard = resolveDispatchHard(harnessDir, config, prompt)
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
async function preExecuteListener(
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
function assignmentTextFromFields(fields: AssignmentFields): string {
  const lines = ['## Assignment', '']
  if (fields.executeAs !== undefined) lines.push(`**Execute as**: ${fields.executeAs}`)
  if (fields.delegation !== undefined) lines.push(`**Delegation**: ${fields.delegation}`)
  if (fields.taskCategory !== undefined) lines.push(`**Task category**: ${fields.taskCategory}`)
  if (fields.workingBranch !== undefined) lines.push(`**Working branch**: ${fields.workingBranch}`)
  if (fields.branchPolicy !== undefined) lines.push(`**Branch policy**: ${fields.branchPolicy}`)
  return lines.join('\n')
}

/**
 * The plugin package's own `harness-commands/` mirror (synced from the repo
 * root by `bundle-assets` at build/postinstall; gitignored). Package-relative
 * like {@link packagedSkillsDir}. Returns undefined when absent.
 */
function packagedCommandsDir(): string | undefined {
  try {
    const dir = fileURLToPath(new URL('../harness-commands', import.meta.url))
    return existsSync(dir) ? dir : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the dsh skill-local registration payload from the plugin Config
 * (single canonical mount). Semantics mirror the skill-local
 * `Config` contract: `skillRoots` → `customSkillDirs` (custom roots),
 * `bundledSkillDir` → `bundledSkillDir` (bundled root). The provider is
 * named `mstar` and default roots are excluded (`includeDefaultRoots: false`
 * — the repository-plugin convention: an isolated provider must see only its
 * explicit roots, so the mstar mount never claims the host app's own skills;
 * without this the app's user/project skills would be re-discovered under
 * the mstar provider). Returns `undefined` when nothing is configured — no
 * registration happens.
 *
 * The bundled default is the package's OWN `harness-skills/` mirror (synced
 * from the repo root by `bundle-assets` at build/postinstall; gitignored),
 * resolved package-relative — NOT cwd-anchored — so a deployment launching
 * from any cwd gets the bundled mount (this resolves the
 * cwd-anchoring limitation for the shipped default; an explicit
 * `bundledSkillDir` still wins).
 * @param config - validated plugin configuration.
 */
export function skillLocalConfig(config: Config): SkillLocalConfig | undefined {
  const customSkillDirs = config.skillRoots?.map((root) => root.trim()).filter((root) => root !== '')
  const bundledSkillDir = config.bundledSkillDir?.trim() ?? packagedSkillsDir()
  if ((customSkillDirs === undefined || customSkillDirs.length === 0) && bundledSkillDir === undefined) {
    return undefined
  }
  return {
    providerName: 'mstar',
    includeDefaultRoots: false,
    ...(customSkillDirs !== undefined && customSkillDirs.length > 0 ? { customSkillDirs } : {}),
    ...(bundledSkillDir !== undefined ? { bundledSkillDir } : {}),
  }
}

/** Options for {@link DshHostAdapter}. */
export interface DshHostAdapterOptions {
  /**
   * The per-workspace `{HARNESS_DIR}` resolver (explicit config wins; the
   * probe never starts from the process cwd). The exec-bound gate paths
   * resolve per the calling session's workspace.
   */
  readonly resolver: HarnessResolver
  /** The plugin Config the gates resolve enforcement + anti-recursion binding from. */
  readonly config: Config
  /**
   * Log sink for `HostAdapter.log`. Defaults to the dsh ctx logger scoped
   * `mstar/host-adapter` (dsh logger naming: `<scope>/<subject>`).
   */
  readonly log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/**
 * The plugin's `HostAdapter` implementation (engine `host.ts` type-only
 * contract) — the HOST-FACING facade over the gate
 * internals: `host: 'dsh'`, `log` → dsh ctx logger, and the optional hooks
 * wired to the SAME code paths the in-plugin gates use, so host hooks and
 * gates share ONE validation path:
 *
 * - `beforeStatusWrite(path, doc)` — validates the incoming document when
 *   the host provides it (the write's content — the opencode consumer
 *   convention for this engine hook), else the current on-disk document at
 *   `path` via the gate's single-read `validateStatusDoc` semantics (missing
 *   file = first create = pass). Both inputs flow through
 *   `validateStatusValue` — the same pipeline the fs-intent gate runs, so
 *   codes match by construction. Returns the FIRST violation: the engine
 *   hook shape is one `ValidationResult`; the gate's full violation list
 *   stays available on the fs-intent slot.
 * - `beforeDispatch(assignment)` — the dispatch gate validation path
 *   (engine `composeDispatchGate` — fields + branch gate + anti-recursion —
 *   plus worktree L1/L2 checks; read-only roles skip the branch gate). The lease gate
 *   stays listener-side: it binds the ToolExecution context (session id)
 *   this hook's contract does not carry. The parsed `AssignmentFields` form
 *   is normalized to the engine's own header grammar (lossless — the
 *   parsers read exactly these labels) and gated through the same text path.
 *   Enforcement is applied like the listener (opencode parity): the
 *   returned GateResult carries `hardBlocked` so a refusal-capable host can
 *   refuse the dispatch.
 * - `beforeMerge(lease)` — thin wrapper over the engine
 *   `validateIntegrationMergeLease` (reserve/validate the integration merge
 *   lease; the reservation WRITE into status.json is a P3 seam).
 */
export class DshHostAdapter extends Service implements HostAdapter {
  /** Engine host identity (`HostId` union). */
  readonly host = 'dsh' as const

  private readonly resolver: HarnessResolver
  private readonly config: Config
  private readonly logSink: (level: 'info' | 'warn' | 'error', msg: string) => void

  constructor(ctx: Context, options: DshHostAdapterOptions) {
    // Provided as a dsh service (`ctx.dshHostAdapter`, same convention as
    // `ctx.dshMstar`): construction self-registers on the fiber.
    super(ctx, 'dshHostAdapter')
    this.resolver = options.resolver
    this.config = options.config
    this.logSink = options.log ?? ((level, msg) => {
      const logger = ctx.logger(HOST_LOGGER)
      if (level === 'warn') logger.warn(msg)
      else if (level === 'error') logger.error(msg)
      else logger.info(msg)
    })
  }

  /**
   * `HostAdapter.log` — the adapter's own reporting channel (the gates keep
   * their scoped loggers; this is the host-facing sink).
   * @param level - log level.
   * @param msg - message.
   */
  log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.logSink(level, msg)
  }

  /**
   * Shared status-gate core (plugin-internal): the fs-intent listeners and
   * the `beforeStatusWrite` on-disk fallback route through this method —
   * ONE validation code path. Missing file = first create = pass (the
   * intent waterfall carries no incoming content, so the vetoable signal is
   * the pre-write on-disk state).
   * @param statusPath - the canonical `{HARNESS_DIR}/status.json` path.
   */
  statusGate(statusPath: string): GateResult {
    if (!existsSync(statusPath)) return { ok: true, violations: [] }
    return validateStatusDoc(statusPath)
  }

  /**
   * Shared dispatch-gate core (plugin-internal): the `tools/pre-execute`
   * listener and `beforeDispatch` route through this method — ONE
   * validation code path (field gate + anti-recursion + branch gate +
   * worktree L1/L2 checks; read-only roles skip the branch gate). The
   * listener passes `exec` so the lease gate (ToolExecution-bound: session
   * id, in-flight call) joins the same verdict; the host hook has no exec
   * context and covers the field/branch/anti-recursion/worktree path.
   * @param prompt - the Assignment text (engine header grammar).
   * @param exec - the in-flight delegation tool call (listener path only).
   */
  dispatchGate(prompt: string, exec?: ToolExecution): GateResult {
    const harnessDir = this.resolver.forAgent(exec?.agent)
    const { violations, writable } = dispatchGateCore(this.config, harnessDir, prompt)
    if (exec !== undefined) {
      violations.push(...leaseGateViolations(harnessDir, exec, writable, prompt))
    }
    return { ok: violations.length === 0, violations }
  }

  /**
   * `HostAdapter.beforeStatusWrite` — see the class doc for the doc-first /
   * on-disk-fallback semantics. Never throws; a failing gate maps to its
   * FIRST violation (severity/code/message/fix/aliases preserved — failing
   * gates always carry ≥1 violation), a passing gate to
   * `host.beforeStatusWrite.ok` (the engine test convention for this hook).
   * @param path - the status.json target path.
   * @param doc - the document about to be written (undefined → validate the
   * on-disk document at `path`).
   */
  async beforeStatusWrite(path: string, doc: unknown): Promise<ValidationResult> {
    const gate = doc !== undefined ? validateStatusValue(doc) : this.statusGate(path)
    if (!gate.ok) {
      const first = gate.violations[0]!
      return { ok: false, severity: first.severity, code: first.code, message: first.message, fix: first.fix, aliases: first.aliases }
    }
    return { ok: true, severity: 'low', code: 'host.beforeStatusWrite.ok', message: `status write to ${path} validated` }
  }

  /**
   * `HostAdapter.beforeDispatch` — the dispatch gate validation path (see
   * the class doc). Accepts the raw Assignment text (full fidelity: the
   * `Enforcement` header flag participates in enforcement resolution) or the
   * parsed `AssignmentFields` (engine-typed hook input; normalized to the
   * engine's header grammar before gating). Returns the enforced GateResult
   * — `hardBlocked` mirrors the `tools/pre-execute` deny decision under the
   * same enforcement resolution.
   * @param assignment - raw Assignment text or parsed header fields.
   */
  async beforeDispatch(assignment: AssignmentFields | string): Promise<GateResult> {
    const prompt = typeof assignment === 'string' ? assignment : assignmentTextFromFields(assignment)
    const gate = this.dispatchGate(prompt)
    // The hook contract carries no exec/session context, so the harness dir
    // resolves to the explicit config or null (never a process-cwd probe) —
    // the exec-bound `tools/pre-execute` listener is the per-workspace path.
    return applyEnforcement(gate, { hard: resolveDispatchHard(this.resolver.forWorkspace(undefined), this.config, prompt) })
  }

  /**
   * `HostAdapter.beforeMerge` — reserve/validate the integration merge
   * lease. Thin wrapper over the engine `validateIntegrationMergeLease`
   * (the engine owns the lease shape; the reservation write into
   * `{HARNESS_DIR}/status.json` is a P3 seam).
   * @param lease - the `metadata.integration_merge_lease` object.
   */
  async beforeMerge(lease: IntegrationMergeLease): Promise<GateResult> {
    return validateIntegrationMergeLease(lease)
  }
}

/** The plugin's own manifest version (single-version invariant; own manifest first). */
function pluginVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * The durable source for the ONE unified engine-status catalog row (the
 * watermark + iteration gate + workspace-state digest). Every field is
 * boot/workspace-resolved — the unified mstar version is a
 * process-immutable manifest read, the compass enforcement resolves like
 * the gates themselves, and the iteration/state sections come from the
 * same per-workspace cached build. With an explicit `harnessDir` config
 * the source is built ONCE at `apply()`; without one it is built on the
 * FIRST pre-step of each workspace. The whole cache entry is then
 * TTL-refreshed (Config `catalogTtlMs`, default 60000 — a mid-session
 * status/compass/residual change lands within one interval). The
 * documented staleness tradeoff keeps synchronous disk I/O off the
 * agent-loop hot path: a timestamp compare + Map lookup per step between
 * refreshes.
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 */
function engineStatusSource(harnessDir: string | null): MstarEngineStatusSource {
  const iteration = harnessDir !== null ? iterationGateSource(harnessDir) : undefined
  return {
    kind: 'mstar-engine-status',
    form: 'catalog',
    version: pluginVersion(),
    harnessDir,
    enforcement: harnessDir !== null ? resolveCompassEnforcement(harnessDir) : { hard: false, source: 'none' },
    // The iteration section is OPTIONAL: when the row cannot be built (no
    // status.json / no steering compass / unreadable docs) the key must be
    // ABSENT, never `iteration: undefined` — the agent loop appends the
    // composed message to the real session, whose `Session.append` rejects
    // event data that is not losslessly JSON-serializable (undefined-valued
    // object properties included) with a hard round failure.
    ...(iteration !== undefined ? { iteration } : {}),
    state: harnessDir !== null ? harnessStateSource(harnessDir) : null,
  }
}

/** One TTL cache entry: the unified source plus the build timestamp. */
interface CatalogCacheEntry {
  sources: MstarEngineStatusSource
  builtAt: number
}

/**
 * Build the unified catalog source for one harness dir (boot for the
 * explicit config, first-use per workspace otherwise, then TTL-refreshed —
 * see `catalogSourcesFor`). Logs the manifest fallback once per build — a
 * '0.0.0' version would watermark every catalog row wrongly, so the
 * fallback is never silent.
 * @param ctx - registrant context (logger for the manifest fallback).
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 */
function buildCatalogSources(ctx: Context, harnessDir: string | null): MstarEngineStatusSource {
  const source = engineStatusSource(harnessDir)
  if (source.version === '0.0.0') {
    ctx.logger(CATALOG_LOGGER).warn('plugin manifest version unavailable — falling back to 0.0.0 for the engine-status catalog watermark')
  }
  return source
}

/**
 * Look up the catalog sources for one cache key with a TTL: within the
 * interval the cached build is reused (the agent-loop hot path is a
 * timestamp compare + Map lookup); after it the sources are rebuilt from
 * disk (one bounded sync re-read per workspace per interval — the
 * mid-session plan/compass/residual staleness window the user opted into;
 * Config `catalogTtlMs`).
 * @param ctx - registrant context (logger for the manifest fallback).
 * @param cache - the per-workspace TTL cache.
 * @param key - cache key (the explicit-config key, else the session cwd).
 * @param harnessDir - the resolved `{HARNESS_DIR}` for this key.
 * @param ttlMs - refresh interval in milliseconds.
 */
function catalogSourcesFor(ctx: Context, cache: Map<string, CatalogCacheEntry>, key: string, harnessDir: string | null, ttlMs: number): MstarEngineStatusSource {
  const entry = cache.get(key)
  if (entry !== undefined && Date.now() - entry.builtAt < ttlMs) return entry.sources
  const sources = buildCatalogSources(ctx, harnessDir)
  cache.set(key, { sources, builtAt: Date.now() })
  return sources
}

/** Model-facing rendering of the unified engine-status catalog (the `<mstar_engine_status>` block). */
function renderEngineStatusCatalog(source: MstarEngineStatusSource): string {
  const enforcement = `${source.enforcement.hard ? 'hard' : 'soft'}${source.enforcement.source === 'none' ? '' : ` (${source.enforcement.source})`}`
  const lines = [
    '<mstar_engine_status>',
    `mstar version: ${source.version}`,
    `harness dir: ${source.harnessDir ?? 'none'}`,
    `enforcement: ${enforcement}`,
  ]
  const iteration = source.iteration
  if (iteration !== undefined) {
    const gate = iteration.gate
    const codes = gate.violations.map((v) => v.code).join(', ')
    lines.push(`iteration: ${iteration.iterationId}`)
    lines.push(`transition: ${gate.transition}`)
    lines.push(`all plans done: ${gate.all_plans_done}`)
    lines.push(`gate: ${gate.ok ? 'PASS' : `FAIL (${codes})`}`)
  }
  const state = source.state
  if (state !== null) {
    lines.push(`plans: ${state.plans.length === 0 ? 'none registered' : state.plans.map((p) => `${p.id}(${p.status})`).join(' ')}`)
    lines.push(`residuals: ${state.residuals.length === 0 ? 'none open' : state.residuals.map((r) => `${r.severity} ${r.count}`).join(', ')}`)
    if (state.iterationBaseBranch !== null && state.targetBranch !== null) {
      const integration = state.specIntegrationBranch !== null ? ` (spec integration: ${state.specIntegrationBranch})` : ''
      lines.push(`branch: ${state.iterationBaseBranch} → ${state.targetBranch}${integration}`)
    }
    const policy = [
      state.pushPolicy !== null ? `push ${state.pushPolicy}` : null,
      state.worktreeMode !== null ? `worktree ${state.worktreeMode}` : null,
      state.controlWorktreePath !== null ? `control ${state.controlWorktreePath}` : null,
    ].filter((part): part is string => part !== null).join('; ')
    if (policy !== '') lines.push(`policy: ${policy}`)
    lines.push(`leases: ${state.leases.length === 0 ? 'none active' : state.leases.map((l) => `${l.planId} → ${l.holder}${l.worktreePath !== null ? ` (${l.worktreePath})` : ''}`).join('; ')}`)
    if (state.knowledge !== null) {
      lines.push(`knowledge: ${state.knowledge.docCount} doc${state.knowledge.docCount === 1 ? '' : 's'} (${state.knowledge.categories.join(', ')})`)
    }
    if (state.direction !== null) lines.push(`direction: ${state.direction}`)
  }
  lines.push('</mstar_engine_status>')
  return lines.join('\n')
}

/**
 * The workspace-state catalog source: the plan registry, open residual
 * counts, branch/policy anchors, active leases, knowledge index digest and
 * the steering compass direction one-liner — the "where are we" facts the
 * model would otherwise have to read status.json / the compass / the
 * knowledge index for. Built from the SAME cached cycle as the sibling
 * rows (one status.json + compass + knowledge-index read per cache
 * refresh). Returns undefined when the workspace has no harness dir or no
 * status.json (the row is absent — advisory degrade, same as the
 * iteration-gate row).
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 */
function harnessStateSource(harnessDir: string | null): MstarHarnessState | null {
  if (harnessDir === null) return null
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) return null
  try {
    const doc = readJson(statusPath) as StatusDoc
    const str = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    const plans: HarnessPlanView[] = []
    const leases: HarnessLeaseView[] = []
    if (Array.isArray(doc.plans)) {
      for (const row of doc.plans.map(asRecord)) {
        if (row === undefined) continue
        const id = typeof row.plan_id === 'string' ? row.plan_id : typeof row.id === 'string' ? row.id : undefined
        if (id === undefined) continue
        plans.push({ id, status: typeof row.status === 'string' ? row.status : '' })
        const lease = asRecord(row.execution_lease)
        if (lease !== undefined && typeof lease.holder === 'string') {
          leases.push({
            planId: id,
            holder: lease.holder,
            worktreePath: str(lease.worktree_path),
          })
        }
      }
    }
    // Open residual findings (root `residual_findings[<plan-id>]` SSOT —
    // mstar-plan-artifacts): count by severity, non-zero severities only.
    const residuals: HarnessResidualView[] = []
    const residualMap = asRecord(doc.residual_findings)
    if (residualMap !== undefined) {
      const counts = new Map<string, number>()
      for (const planId of Object.keys(residualMap)) {
        const findings = residualMap[planId]
        if (!Array.isArray(findings)) continue
        for (const finding of findings) {
          const severity = asRecord(finding)?.severity
          if (typeof severity === 'string' && (RESIDUAL_SEVERITIES as readonly string[]).includes(severity)) {
            counts.set(severity, (counts.get(severity) ?? 0) + 1)
          }
        }
      }
      for (const severity of RESIDUAL_SEVERITIES) {
        const count = counts.get(severity)
        if (count !== undefined && count > 0) residuals.push({ severity, count })
      }
    }
    const metadata = asRecord(doc.metadata)
    const compass = steeringCompassPath(harnessDir)
    let compassFields: Record<string, unknown> | undefined
    if (compass !== undefined) {
      try {
        compassFields = parseCompassFrontmatter(compass.compassPath)
      } catch {
        compassFields = undefined
      }
    }
    return {
      plans,
      residuals,
      iterationBaseBranch: str(metadata?.iteration_base_branch) ?? str(compassFields?.iteration_base_branch) ?? null,
      targetBranch: str(metadata?.target_branch) ?? str(compassFields?.target_branch) ?? null,
      specIntegrationBranch: str(metadata?.spec_integration_branch),
      pushPolicy: str(metadata?.push_policy),
      worktreeMode: str(metadata?.worktree_mode),
      controlWorktreePath: str(metadata?.control_worktree_path),
      leases,
      knowledge: knowledgeDigest(harnessDir),
      direction: compass !== undefined ? compassDirection(compass.compassPath) : null,
    }
  } catch {
    return null // advisory degrade — the state section is absent, never hardening
  }
}

/**
 * Knowledge index digest: `{HARNESS_DIR}/knowledge/README.md` rows →
 * doc count + distinct categories (the first path segment of each row's
 * Document cell). Null when the index is absent or unreadable (advisory).
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 */
function knowledgeDigest(harnessDir: string): { docCount: number; categories: string[] } | null {
  const indexPath = join(harnessDir, 'knowledge', 'README.md')
  if (!existsSync(indexPath)) return null
  try {
    const categories = new Set<string>()
    let docCount = 0
    for (const line of readFileSync(indexPath, 'utf8').split(/\r?\n/)) {
      const row = line.trim().match(/^\|(.+)\|$/)
      if (row === null) continue
      const cells = row[1]!.split('|').map((cell) => cell.trim()).filter((cell) => cell !== '')
      if (cells.length < 4) continue
      const path = cells[0]!.replace(/^`|`$/g, '')
      const category = path.split('/')[0]
      if (category === undefined || category === '' || !path.includes('/')) continue
      categories.add(category)
      docCount += 1
    }
    if (docCount === 0) return null
    return { docCount, categories: [...categories].sort() }
  } catch {
    return null
  }
}

/**
 * Steering compass direction one-liner: the first paragraph under the
 * `## Direction lock` heading (the problem statement bullet), markdown
 * emphasis stripped, truncated to ~160 chars. Null when unavailable.
 * @param compassPath - the steering `delivery-compass.md` path.
 */
function compassDirection(compassPath: string): string | null {
  try {
    const content = readFileSync(compassPath, 'utf8')
    const section = content.match(/^## Direction lock[^\n]*\n+([\s\S]*?)(?=\n## |$)/m)
    if (section === null) return null
    const paragraph = section[1]!
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '')
    if (paragraph === undefined) return null
    const cleaned = paragraph
      .replace(/^[-*]\s+/, '')
      .replace(/\*\*[^*]+:\*\*\s*/, '') // strip a leading `**Label:** ` prefix (e.g. "Problem statement:")
      .replace(/\*\*/g, '')
      .trim()
    if (cleaned === '') return null
    return cleaned.length > 160 ? `${cleaned.slice(0, 157)}…` : cleaned
  } catch {
    return null
  }
}

/**
 * Locate the steering iteration compass (mirror of the engine's
 * `resolveCompassEnforcement` scan): the FIRST `{ITERATION_DIR}/<id>/
 * delivery-compass.md` whose frontmatter `status` is `active` or `locked`.
 * Completed/status-less/archived compasses do not steer the repo — the
 * pre-step gate section reports the iteration that is still in flight.
 * Silent on any read failure (the catalog row is advisory).
 * @param harnessDir - the resolved `{HARNESS_DIR}`.
 */
function steeringCompassPath(harnessDir: string): { iterationId: string; compassPath: string } | undefined {
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
    return { iterationId: entry.name, compassPath }
  }
  return undefined
}

/**
 * The cached iteration-gate catalog row: `evaluatePhaseGate`
 * over the control-path status.json + the steering delivery-compass.md,
 * projected to the tool result shape (`IterationGateView`). Computed
 * ONCE per harness dir — at `apply()` when the explicit `harnessDir`
 * config is set, else on the first pre-step of each workspace root — and
 * reused per pre-step (no disk I/O on the agent-loop hot path). A
 * mid-session status/compass change does NOT re-evaluate until a config
 * reload re-runs `apply` (HMR fiber restart) — the documented staleness
 * tradeoff that keeps the hot path synchronous-I/O-free.
 *
 * Returns undefined when the row cannot be built: no harness dir,
 * missing status.json, no steering compass, or an unreadable/unparseable
 * document (advisory degrade — the engine-status catalog still appends; a
 * later tool call can re-evaluate on demand with explicit probes).
 * @param harnessDir - the resolved `{HARNESS_DIR}` (null when none found).
 */
function iterationGateSource(harnessDir: string | null): MstarIterationGateView | undefined {
  if (harnessDir === null) return undefined
  const statusPath = join(harnessDir, STATUS_FILE)
  if (!existsSync(statusPath)) return undefined
  const compass = steeringCompassPath(harnessDir)
  if (compass === undefined) return undefined
  try {
    const statusDoc = readJson(statusPath)
    const compassDoc = parseCompassFrontmatter(compass.compassPath)
    // No git probes at boot: the row reports what the two control docs
    // prove (the tool remains the explicit-probe surface for branch checks).
    const result = evaluatePhaseGate(statusDoc, compassDoc)
    const gate: IterationGateView = {
      transition: result.transition,
      all_plans_done: result.allPlansDone,
      ok: result.ok,
      entry: iterationGateView(result.entry),
      exit: iterationGateView(result.exit),
      violations: result.violations.map(iterationViolationView),
    }
    return {
      iterationId: compass.iterationId,
      statusPath,
      compassPath: compass.compassPath,
      gate,
    }
  } catch {
    return undefined // degrade — the iteration section is absent, no hardening
  }
}

/**
 * Advisory `agent/pre-step` waterfall listener (agent
 * catalog): delegates through `next()` (never `reject` — that would block the
 * step — and never replaces the delegated messages) and appends the ONE
 * unified `mstar-engine-status` catalog message to the composed step
 * messages, so the durable session log carries it (model-visible ⟺ logged,
 * MessageSource form): the `<mstar_engine_status>` block renders the
 * watermark fields (version, harness dir, enforcement), plus the iteration
 * phase-gate section when a steering compass + status.json resolve, plus
 * the workspace-state digest section when the workspace has a status.json.
 *
 * Digest-gated re-emission (the documented P3 dedup, landed early): per
 * agent+workspace, the row is injected ONCE per turn — later steps of the
 * same turn append it again only when its rendered text CHANGED (a TTL
 * refresh picked up new state). The durable session log therefore carries
 * the row on the first step of every turn plus each change, not on every
 * step; a 20-step turn shows the catalog once, not 20 times.
 *
 * An aborted step publishes nothing: the delegated decision
 * is returned unchanged (tool-skill precedent; a narrowed abort race —
 * an abort after delegation must not surface as a turn failure).
 *
 * Error containment: the append path is wrapped — a failure
 * (e.g. a downstream decider returning a non-iterable `messages` set, or a
 * throwing message factory) logs and returns the delegated decision
 * unchanged; the advisory listener never aborts the very step it observes.
 *
 * simplify: dev-time stub — the digest is in-memory per app (the real
 * dsh-session log is unavailable at dev time; digest state resets on
 * fiber disposal, which is also HMR-correct).
 * @param ctx - registrant context (logger for the containment path).
 * @param resolver - the per-workspace `{HARNESS_DIR}` resolver (the probe
 * never starts from the process cwd).
 * @param explicitKey - the app-wide cache key when an explicit
 * `harnessDir` config is set (undefined → per-session-cwd keys).
 * @param cache - per-workspace TTL catalog sources cache (boot pre-seeded
 * for the explicit-config case; otherwise built on first use of each
 * workspace root and TTL-refreshed — Config `catalogTtlMs`).
 * @param ttlMs - catalog refresh interval in milliseconds.
 * @param digests - per agent+workspace turn digests (last rendered text)
 * for the digest-gated re-emission.
 * @param payload - the proposed step the loop is about to enter.
 * @param next - the remaining pre-step chain; its value is the delegated decision.
 */
async function preStepCatalogListener(
  ctx: Context,
  resolver: HarnessResolver,
  explicitKey: string | undefined,
  cache: Map<string, CatalogCacheEntry>,
  ttlMs: number,
  digests: Map<string, TurnDigest>,
  payload: { agent: unknown; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>,
): Promise<PreStepDecision> {
  const decision = await next()
  if (decision.kind === 'reject' || payload.signal.aborted) return decision
  try {
    // The watermark harness dir resolves from the WORKSPACE of the session
    // whose agent enters the step (the session cwd) — never the process
    // cwd. With an explicit config the whole app shares one cache entry
    // (pre-seeded at boot); without one each workspace root gets its own
    // entry, built on first use and TTL-refreshed (Config `catalogTtlMs` —
    // a mid-session plan/compass/residual change lands within one interval;
    // the hot path is a timestamp compare + Map lookup between refreshes).
    const cwd = sessionCwdOf(payload.agent)
    const harnessDir = resolver.forWorkspace(cwd)
    const key = explicitKey ?? cwd ?? ''
    const sources = catalogSourcesFor(ctx, cache, key, harnessDir, ttlMs)
    const messages = [...decision.messages]
    const text = renderEngineStatusCatalog(sources)
    // Digest gate: inject the ONE unified row on the first step of a turn,
    // or when its rendered text changed since the last injection (a TTL
    // refresh picked up new state). Per agent+workspace, so different
    // sessions/workspaces keep independent digests.
    const digestKey = agentDigestKey(payload.agent, cwd)
    const prior = digests.get(digestKey)
    if (prior === undefined || prior.turn !== payload.turn || prior.text !== text) {
      messages.push(createUserMessage({ source: sources, content: [{ type: 'text', text }] }))
    }
    digests.set(digestKey, { turn: payload.turn, text })
    return { kind: 'enter', messages }
  } catch (error) {
    ctx.logger(CATALOG_LOGGER).error(
      `engine-status catalog append failed (degraded, step delegates unchanged): ${(error as Error).message}`,
    )
    return decision
  }
}

/** Per agent+workspace turn digest: the rendered catalog text as of the last injection. */
interface TurnDigest {
  turn: number
  text: string
}

/** Digest key of one agent: the agent id + its session workspace (dev stubs without an id share the `<unknown>` bucket per workspace). */
function agentDigestKey(agent: unknown, cwd: string | undefined): string {
  const id = (agent as { id?: unknown } | null | undefined)?.id
  return `${typeof id === 'string' ? id : '<unknown>'}\u0000${cwd ?? ''}`
}

/**
 * Map one engine `ValidationResult` to its lossless JSON view (`fix` omitted
 * when absent so `additionalProperties: false` never sees an undefined key).
 * The view interfaces live in `types.ts` (shared with the pre-step
 * iteration-gate catalog row).
 */
function iterationViolationView(v: ValidationResult): IterationGateViolationView {
  return { severity: v.severity, code: v.code, message: v.message, ...(v.fix !== undefined ? { fix: v.fix } : {}) }
}

/** Map one engine gate (`GateResult`) to its JSON view. */
function iterationGateView(gate: GateResult): IterationGateListView {
  return { ok: gate.ok, violations: gate.violations.map(iterationViolationView) }
}

/** Violation item schema shared by the iteration-gate output shape. */
const ITERATION_VIOLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    severity: { type: 'string', required: true, enum: ['critical', 'high', 'medium', 'low', 'nit'] },
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
    fix: { type: 'string' },
  },
} as const

/**
 * Register the v2 seam model-facing tools: `mstar sdd …` / `mstar iteration gate` equivalents operating
 * in-app against control-path artifacts.
 *
 * The registrations are deferred with `ctx.inject(['tools'], …)` — the same
 * optional-unit pattern as dsh-tool-todo — so the plugin boots without the
 * tools service (gates stay active) and registers when the composed dsh app
 * provides `ctx.tools`. The fs-mutating tools declare
 * `isConcurrencySafe: () => false` (exclusive — never overlap with sibling
 * calls, matching the real registry's exclusive default).
 * @param ctx - registrant context carrying the tool registry.
 * @param resolver - the per-workspace `{HARNESS_DIR}` resolver (the tools
 * resolve per the calling session's workspace — never the process cwd;
 * explicit config wins).
 */
function registerSddIterationTools(ctx: Context, resolver: HarnessResolver): void {
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.tools.register(defineTool({
      name: 'mstar_sdd_workspace',
      description:
        'Resolve and ensure the SDD workspace dir for a plan id — {HARNESS_DIR}/sdd/<plan-id>/ ' +
        '(the engine sddWorkspace, mirror of `mstar sdd workspace`). Fails closed when the app ' +
        'runs from a linked feature worktree without control_root (never creates a second SDD ' +
        'tree under a feature checkout).',
      parameters: {
        plan_id: {
          type: 'string',
          required: true,
          description: 'Plan id whose SDD dir is resolved/created ({HARNESS_DIR}/sdd/<plan-id>/).',
        },
        control_root: {
          type: 'string',
          description:
            'Control worktree repo root (CLI 2nd arg / MSTAR_CONTROL_ROOT). Required when the ' +
            'app runs from a linked feature worktree without {HARNESS_DIR}/status.json.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sdd_dir: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `sdd dir: ${value.sdd_dir}` }],
      },
      presentCall: args => ({ card: 'generic', title: 'Resolve SDD workspace', kind: 'other', rawInput: args.plan_id }),
      // The tool creates a directory — exclusive (never parallel with siblings).
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        // The workspace root is the calling session's cwd (never the
        // process cwd); the explicit config wins when set.
        const ws = sessionCwdOf(exec.agent)
        const harnessDir = resolver.forWorkspace(ws)
        const sddDir = sddWorkspace(args.plan_id, {
          ...(ws !== undefined ? { cwd: ws } : {}),
          ...(args.control_root !== undefined ? { controlRoot: args.control_root } : {}),
          ...(harnessDir !== null ? { harnessDir } : {}),
        })
        return { sdd_dir: sddDir }
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'mstar_sdd_task_brief',
      description:
        'Extract the `## Task N` section of a plan file into a brief file (engine taskBrief, ' +
        'mirror of `mstar sdd task-brief`). Fence-aware: headings inside code fences are ignored.',
      parameters: {
        plan_file: {
          type: 'string',
          required: true,
          description: 'Plan markdown file whose `## Task N` section is extracted.',
        },
        task_number: {
          type: 'integer',
          required: true,
          description: '1-based task number whose brief is extracted.',
        },
        out_file: {
          type: 'string',
          description: 'Output file (default: {sdd_dir}/task-N-brief.md when sdd_dir is given).',
        },
        sdd_dir: {
          type: 'string',
          description: 'SDD dir used for the default out file — the in-app mirror of the SDD_DIR env the CLI reads.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            brief_file: { type: 'string', required: true },
            task_number: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `task ${value.task_number} brief: ${value.brief_file}` }],
      },
      presentCall: args => ({ card: 'generic', title: 'Extract SDD task brief', kind: 'other', rawInput: args.plan_file }),
      // The tool writes a file — exclusive (never parallel with siblings).
      isConcurrencySafe: () => false,
      async execute(args) {
        if (args.out_file === undefined && args.sdd_dir === undefined) {
          throw new Error('mstar_sdd_task_brief: pass out_file or sdd_dir (the in-app mirror of the SDD_DIR env the CLI reads)')
        }
        const out = taskBrief(
          args.plan_file,
          args.task_number,
          args.out_file,
          args.sdd_dir !== undefined ? { sddDir: args.sdd_dir } : {},
        )
        return { brief_file: out, task_number: args.task_number }
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'mstar_iteration_gate',
      description:
        'Evaluate the iteration phase-transition gate against a status.json and a delivery-compass.md ' +
        '(engine evaluatePhaseGate, mirror of `mstar iteration gate`): returns the transition ' +
        '(phase-2-execute / phase-3-close / phase-4-pr-delivery), the pass/fail verdict, and the ' +
        '§3.1 entry / §3.5 exit checklists with violation codes.',
      parameters: {
        status_path: {
          type: 'string',
          required: true,
          description: 'Path to {HARNESS_DIR}/status.json.',
        },
        compass_path: {
          type: 'string',
          required: true,
          description: 'Path to the iteration delivery-compass.md.',
        },
        branch: {
          type: 'string',
          description: 'Current branch probe (exit §3.5 item 5 — must equal the spec integration branch).',
        },
        integration: {
          type: 'string',
          description: 'Spec integration branch probe (exit §3.5 item 5).',
        },
        target: {
          type: 'string',
          description: 'PR base branch probe (exit §3.5 item 6 — must equal the compass target_branch).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            transition: {
              type: 'string',
              required: true,
              enum: ['phase-2-execute', 'phase-3-close', 'phase-4-pr-delivery'],
            },
            all_plans_done: { type: 'boolean', required: true },
            ok: { type: 'boolean', required: true },
            entry: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                violations: { type: 'array', required: true, items: ITERATION_VIOLATION_SCHEMA },
              },
            },
            exit: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                violations: { type: 'array', required: true, items: ITERATION_VIOLATION_SCHEMA },
              },
            },
            violations: { type: 'array', required: true, items: ITERATION_VIOLATION_SCHEMA },
          },
        },
        render: (_args, value) => {
          const codes = value.violations.map((v) => v.code).join(', ')
          const text = value.ok
            ? `iteration gate: PASS (transition ${value.transition})`
            : `iteration gate: FAIL (transition ${value.transition}) — ${codes}`
          return [{ type: 'text', text }]
        },
      },
      presentCall: args => ({ card: 'generic', title: 'Evaluate iteration phase gate', kind: 'other', rawInput: args.compass_path }),
      presentResult: (_args, _result) => ({ card: 'generic', title: 'Iteration gate evaluation' }),
      // Read-only evaluation — exclusive anyway (the engine result is a pure function of the docs).
      isConcurrencySafe: () => false,
      async execute(args) {
        if (!existsSync(args.status_path)) throw new Error(`status file not found: ${args.status_path}`)
        if (!existsSync(args.compass_path)) throw new Error(`compass file not found: ${args.compass_path}`)
        const statusDoc = readJson(args.status_path)
        const compassDoc = parseCompassFrontmatter(args.compass_path)
        const result = evaluatePhaseGate(statusDoc, compassDoc, {
          currentBranch: args.branch,
          specIntegrationBranch: args.integration,
          prBaseBranch: args.target,
        })
        const view: IterationGateView = {
          transition: result.transition,
          all_plans_done: result.allPlansDone,
          ok: result.ok,
          entry: iterationGateView(result.entry),
          exit: iterationGateView(result.exit),
          violations: result.violations.map(iterationViolationView),
        }
        return view
      },
    }))
  })
}

/**
 * Register the on-demand seam validation tools (
 * 20260808-dsh-seams-bundle): `mstar design-md validate` / `mstar compound
 * validate` CLI mirrors plus the audit / roles validators — thin wrappers
 * running the engine in-app. The registrations are deferred with
 * `ctx.inject(['tools'], …)` (same optional-unit pattern as the sdd tools),
 * so the plugin boots without the tools service (gates stay active).
 *
 * `mstar_compound_validate` adds one `repo_root` param beyond the CLI
 * (`mstar compound validate` has no reference-existence check) — the
 * compound-refresh Phase 2 check the seam gate runs per write, offered
 * on-demand. All tools are read-only evaluations — exclusive anyway
 * (registry default; the engine results are pure functions of the docs).
 * @param ctx - registrant context carrying the tool registry.
 * @param resolver - the per-workspace `{HARNESS_DIR}` resolver (the
 * compound default root resolves per the calling session's workspace —
 * never the process cwd; explicit config wins).
 */
function registerSeamTools(ctx: Context, resolver: HarnessResolver): void {
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.tools.register(defineTool({
      name: 'mstar_design_md_validate',
      description:
        'Validate a DESIGN.md in <dir> (mirror of `mstar design-md validate`): token frontmatter, ' +
        'light/dark parity when DESIGN.dark.md exists, and the completeness level.',
      parameters: {
        dir: {
          type: 'string',
          required: true,
          description: 'Directory containing DESIGN.md (and optionally DESIGN.dark.md).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            level: { type: 'string', required: true, enum: ['BELOW_MVP', 'MVP', 'Standard', 'Production'] },
            level_missing: { type: 'array', required: true, items: { type: 'string' } },
            body_unverified: { type: 'boolean', required: true },
            violations: { type: 'array', required: true, items: ITERATION_VIOLATION_SCHEMA },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `design-md validate: ${value.ok ? 'PASS' : 'FAIL'} (level ${value.level})` },
        ],
      },
      presentCall: args => ({ card: 'generic', title: 'Validate DESIGN.md', kind: 'other', rawInput: args.dir }),
      // Read-only evaluation — exclusive anyway (registry default).
      isConcurrencySafe: () => false,
      async execute(args) {
        const abs = resolve(args.dir)
        const lightPath = join(abs, 'DESIGN.md')
        if (!existsSync(lightPath)) throw new Error(`design file not found: ${lightPath}`)
        const light = readFileSync(lightPath, 'utf8')
        // Shared gate validator (validateSeamDoc → gateSeamIntent path):
        // token frontmatter + light/dark parity when the sibling exists.
        // The tool layers the completeness level on top.
        const result = validateDesignDoc(light, lightPath)
        const level = completenessLevel(light)
        return {
          ok: result.ok,
          level: level.level,
          level_missing: level.missing,
          body_unverified: level.bodyUnverified,
          violations: result.violations.map(iterationViolationView),
        }
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'mstar_audit_validate',
      description:
        'Validate an audit plan file: Status-block contract (validateAuditStatusBlocks) plus the ' +
        'credential scan of mstar-audit Hard Rule 4 (redactSecrets) — no CLI equivalent, the validator ' +
        'behind `mstar audit scaffold`.',
      parameters: {
        plan_path: {
          type: 'string',
          required: true,
          description: 'Audit plan file (plans/audit-<date>/NNN-*.md).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            violations: { type: 'array', required: true, items: ITERATION_VIOLATION_SCHEMA },
            secrets: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  line: { type: 'integer', required: true },
                  type: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: `audit validate: ${value.ok ? 'PASS' : 'FAIL'} (${value.secrets.length} secret finding${value.secrets.length === 1 ? '' : 's'})` },
        ],
      },
      presentCall: args => ({ card: 'generic', title: 'Validate audit plan', kind: 'other', rawInput: args.plan_path }),
      // Read-only evaluation — exclusive anyway (registry default).
      isConcurrencySafe: () => false,
      async execute(args) {
        const abs = resolve(args.plan_path)
        if (!existsSync(abs)) throw new Error(`plan file not found: ${abs}`)
        const text = readFileSync(abs, 'utf8')
        // Shared gate validator (validateSeamDoc → gateSeamIntent path):
        // Status-block contract + secret scan. The tool layers the findings
        // summary (line + type only — secret values are never reproduced,
        // mstar-audit Hard Rule 4) on top.
        const result = validateAuditDoc(text, abs)
        return { ok: result.ok, violations: result.violations.map(iterationViolationView), secrets: result.findings }
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'mstar_compound_validate',
      description:
        'Validate a knowledge doc (mirror of `mstar compound validate`): schema.yaml frontmatter ' +
        'contract; with knowledge_dir also assert the knowledge README index rows and guard the doc ' +
        'inside the knowledge scope; reference existence checks run against repo_root when given, ' +
        'else against the harness-derived root the seam gate uses (compound-refresh Phase 2 — the ' +
        'knowledge_dir extras beyond the CLI).',
      parameters: {
        doc_path: {
          type: 'string',
          required: true,
          description: 'Knowledge doc (markdown with YAML frontmatter).',
        },
        knowledge_dir: {
          type: 'string',
          description: 'Knowledge directory (enables index-row asserts + scope guard — CLI --knowledge-dir).',
        },
        repo_root: {
          type: 'string',
          description:
            'Repo root for reference existence checks (default: the parent of the resolved {HARNESS_DIR} — the seam gate root; none when no harness dir resolves).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            violations: { type: 'array', required: true, items: ITERATION_VIOLATION_SCHEMA },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `compound validate: ${value.ok ? 'PASS' : 'FAIL'}` }],
      },
      presentCall: args => ({ card: 'generic', title: 'Validate knowledge doc', kind: 'other', rawInput: args.doc_path }),
      // Read-only evaluation — exclusive anyway (registry default).
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const abs = resolve(args.doc_path)
        if (!existsSync(abs)) throw new Error(`knowledge doc not found: ${abs}`)
        const text = readFileSync(abs, 'utf8')
        // Shared gate validator (validateSeamDoc → gateSeamIntent path):
        // schema contract + reference existence against the harness-derived
        // root when the caller gives no explicit repo_root — the tool then
        // defaults to the SAME checks the fs gate enforces. An explicit
        // repo_root replaces the derived root (tool-only contract), and
        // knowledge_dir layers the index/scope asserts on top.
        const base = validateCompoundDoc(text, abs, args.repo_root !== undefined ? null : resolver.forAgent(exec.agent))
        const violations = [...base.violations]
        if (args.repo_root !== undefined) {
          violations.push(...referenceExists(resolve(args.repo_root), text).violations)
        }
        if (args.knowledge_dir !== undefined) {
          const knowledgeDir = resolve(args.knowledge_dir)
          violations.push(...assertIndexRows(knowledgeDir).violations)
          violations.push(...scopeGuard(abs, [knowledgeDir]).violations)
        }
        return { ok: violations.length === 0, violations: violations.map(iterationViolationView) }
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'mstar_roles_validate',
      description:
        'Validate the mstar-roles skill-dir state: role mapping / parameter tables against the on-disk ' +
        'references layout (validateRoleMapping) plus load-order declarations across every sibling ' +
        'mstar-* skill (lintLoadOrder; skills_root defaults to the parent of roles_dir).',
      parameters: {
        roles_dir: {
          type: 'string',
          required: true,
          description: 'The mstar-roles skill directory (contains SKILL.md + references/).',
        },
        skills_root: {
          type: 'string',
          description: 'Directory containing the mstar-* skill dirs for load-order linting (default: parent of roles_dir).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            violations: { type: 'array', required: true, items: ITERATION_VIOLATION_SCHEMA },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `roles validate: ${value.ok ? 'PASS' : 'FAIL'}` }],
      },
      presentCall: args => ({ card: 'generic', title: 'Validate roles mapping', kind: 'other', rawInput: args.roles_dir }),
      // Read-only evaluation — exclusive anyway (registry default).
      isConcurrencySafe: () => false,
      async execute(args) {
        const rolesDir = resolve(args.roles_dir)
        if (!existsSync(join(rolesDir, 'SKILL.md'))) throw new Error(`roles dir not found: ${rolesDir}`)
        // Shared gate validator (validateSeamDoc → gateSeamIntent path): role
        // mapping + load-order lint. The tool only overrides the skills_root
        // the gate derives as the parent of the roles dir.
        const result = validateRolesState(
          rolesDir,
          args.skills_root !== undefined ? resolve(args.skills_root) : undefined,
        )
        return { ok: result.ok, violations: result.violations.map(iterationViolationView) }
      },
    }))
  })
}

/** Frontmatter field value of one command markdown (`name`/`description`/`agent`). */
function commandFrontmatterField(frontmatter: string, label: string): string | undefined {
  const match = new RegExp(`^${label}[ \\t]*:[ \\t]*(.+)$`, 'm').exec(frontmatter)
  return match?.[1]?.trim()
}

/**
 * Parse one bundled mstar command markdown (`harness-commands/<name>.md`):
 * the `---` frontmatter block yields `name` + `description` (registration
 * metadata); the body is the command content the handler steers into the
 * receiving agent. Returns undefined for files without a parseable block.
 */
function parseCommandMarkdown(content: string): { name: string; description: string; body: string } | undefined {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length === 0 || lines[0]!.trim() !== '---') return undefined
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') { end = i; break }
  }
  if (end === -1) return undefined
  const frontmatter = lines.slice(1, end).join('\n')
  const name = commandFrontmatterField(frontmatter, 'name')
  const description = commandFrontmatterField(frontmatter, 'description')
  if (name === undefined || description === undefined) return undefined
  return { name, description, body: lines.slice(end + 1).join('\n').trim() }
}

/**
 * Register the bundled mstar commands (`harness-commands/*.md`, synced from
 * the repo root by `bundle-assets`; gitignored) on `ctx.commands` — the
 * omp/opencode slash-command parity surface (`/iteration-start`,
 * `/iteration-drive`, `/iteration-loop`, `/codebase-audit`). Each command
 * handler steers the command body into the receiving agent as a user message
 * (the dsh-commands "explicitly schedule model-visible work through the
 * receiving Agent" path), returning a success result. The registration is
 * deferred with `ctx.inject(['commands'], …)` — the same optional-unit
 * pattern as the tools — so the plugin boots without the commands service.
 * Absent mirror (no `bundle-assets` run) → no registrations.
 * @param ctx - registrant context carrying the commands service.
 */
function registerMstarCommands(ctx: Context): void {
  const dir = packagedCommandsDir()
  if (dir === undefined) return
  ctx.inject(['commands'], (commandsCtx) => {
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.md')) continue
      const parsed = parseCommandMarkdown(readFileSync(join(dir, file), 'utf8'))
      if (parsed === undefined) continue
      commandsCtx.commands.register({
        name: parsed.name,
        description: parsed.description,
        handler: (invocation: CommandInvocation) => {
          // The command body is delivered to the model as a USER message —
          // the dsh-plan-mode /permission command precedent (`source:
          // { kind: 'user' }`). A plugin-source message reads as injected
          // context (trajectory UI labels it "Plugin · …"), and the model
          // treats it as system-provided context rather than a task to
          // execute; a user-source message is what makes the model act on
          // the mstar command body.
          const message = createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: parsed.body }],
          })
          invocation.agent.steer(message)
          return { kind: 'success', text: `mstar ${parsed.name} started` }
        },
      })
    }
  })
}

/**
 * Apply the plugin to the registrant context: resolve `{HARNESS_DIR}` via the
 * engine (per-workspace — the probe never starts from the process cwd),
 * expose the engine surface as `ctx.dshMstar`, construct the host
 * adapter (the gates route through it — one code path with the host hooks),
 * and register the status gate on the fs intent waterfalls + the dispatch
 * gate on `tools/pre-execute`.
 *
 * Layering: the gates are co-located engine wrappers in this
 * module importing `@mstar-harness/engine` directly (same plugin, engine
 * bundled at build time); `ctx.dshMstar` is the composition/test façade for
 * future inject consumers (catalogs) — see the README Service section; the
 * adapter is the host-facing facade. The engine is the single grammar for
 * both paths.
 * @param ctx - Cordis context of the composed app.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Per-workspace `{HARNESS_DIR}` resolution: the probe NEVER starts from
  // the process cwd — it starts from the WORKSPACE root of the session
  // whose agent drives each event (the session cwd). At boot there is no
  // session yet, so the boot value is the explicit config or null; every
  // event path (fs intents, tools/pre-execute, agent/pre-step, tool
  // executes) resolves per its own session workspace, memoized per
  // workspace root. Repos whose harness root is not a probed name
  // (`.mstar/` → `.agents/` → `.plans/`/`plans/` — e.g. this repo's
  // `.harness/`) declare `config.harnessDir`, which wins outright.
  const resolver = new HarnessResolver(config.harnessDir)
  const bootHarnessDir = resolver.forWorkspace(undefined)
  // The Service constructor registers itself on the fiber via reflect.provide,
  // so construction alone exposes `ctx.dshMstar` (dsh service convention).
  new DshMstar(ctx, { harnessDir: bootHarnessDir })
  // The host-facing HostAdapter facade — the fs-intent / pre-execute gates
  // route through it (host hooks and in-plugin gates share ONE code path).
  // Constructed as a dsh service: `ctx.dshHostAdapter` is available to
  // inject consumers and host hooks after boot.
  const adapter = new DshHostAdapter(ctx, { resolver, config })

  // Bundled mstar commands — the omp/opencode slash-command parity surface
  // (iteration-start / iteration-drive / iteration-loop / codebase-audit),
  // registered from `harness-commands/` when the commands service exists.
  registerMstarCommands(ctx)

  // Skills mount — single canonical mount: register configured
  // skill roots with the dsh skill-local provider contract. The object form
  // mirrors the module shape the dsh Loader composes for the real
  // `@deepseek-ai/dsh-skill-local` package (`{ name, inject, Config, apply }`),
  // so `inject: ['skills']` defers the child fiber until `ctx.skills` exists
  // regardless of mount order. Dev-time the seam package is a peer stub (no
  // real runtime) — this call is the contract-typed registration; real-runtime
  // composition is verified at P3 e2e (README Known Limitations).
  const skillConfig = skillLocalConfig(config)
  if (skillConfig !== undefined) {
    ctx.plugin(
      { name: skillLocalName, inject: skillLocalInject, Config: SkillLocalSchema, apply: applySkillLocal },
      skillConfig,
    )
  }

  // Deploy-time observability: when enforcement resolves hard but
  // no dispatchBinding is declared, the anti-recursion red line is off by
  // construction — surface the absence instead of only documenting it.
  // (Boot-time the only known enforcement source is the explicit Config
  // override — compass hard is per-workspace and resolves at event time.)
  const effectiveHard = config.enforcement === 'hard' || (bootHarnessDir !== null && resolveCompassEnforcement(bootHarnessDir).hard)
  if (effectiveHard && (config.dispatchBinding ?? '').trim() === '') {
    ctx.logger(DISPATCH_LOGGER).warn(
      'Enforcement: hard is active but dispatchBinding is unset — the anti-recursion precheck is skipped (an Assignment whose Execute as equals the dispatching agent cannot be detected)',
    )
  }
  // Deploy-time observability: a renamed dsh subagent tool
  // (toolName) with dispatchTools unset silently disables BOTH the dispatch
  // gate and host detection — mirror the dispatchBinding warn so the absence
  // is surfaced instead of only documented.
  if (effectiveHard && config.dispatchTools === undefined) {
    ctx.logger(DISPATCH_LOGGER).warn(
      'Enforcement: hard is active but dispatchTools is unset — the dispatch gate matches the default tool name "subagent"; a deployment renaming the dsh subagent tool (toolName) without declaring dispatchTools silently disables the gate',
    )
  }

  // Status gate — fs intent slot (single-slot waterfall; prepend so this
  // decider runs before dsh-fs-policy regardless of mount order).
  ctx.on('fs/write-intent', (target, actor, next) => writeIntentListener(ctx, resolver, config, adapter, target, actor, next), { prepend: true })
  ctx.on('fs/edit-intent', (target, actor, next) => editIntentListener(ctx, resolver, config, adapter, target, actor, next), { prepend: true })

  // Skill-authoring lint gate — fs/write-intent slot scoped to SKILL.md
  // under the configured skill roots (same single-slot waterfall +
  // prepend + next() delegation contract as the status gate — this gate
  // also never throws except the intentional incoming-doc veto in
  // `lintSkillWrite`).
  ctx.on('fs/write-intent', (target, actor, next) => skillWriteIntentListener(ctx, resolver, config, target, actor, next), { prepend: true })

  // Artifact seam gates — fs/write-intent slots scoped per artifact
  // (design-md / audit / compound / roles; same envelope: warn advisory
  // default, hard-mode repair escape on the content-blind listener, typed
  // `SeamVetoError` on the known-document branch, degrade-to-allow). The
  // scopes are disjoint, so the four listeners never double-decide one
  // target.
  const seams: SeamId[] = ['design-md', 'audit', 'compound', 'roles']
  for (const seam of seams) {
    ctx.on('fs/write-intent', (target, actor, next) => seamWriteIntentListener(ctx, resolver, config, seam, target, actor, next), { prepend: true })
  }

  // Dispatch gate — tools/pre-execute waterfall (refusal channel:
  // PreToolDecision.deny returned without next()). Registered prepend for the
  // same reachability reason as the fs slots: an earlier-mounted
  // listener that returns a decision without next() would short-circuit the
  // chain and make this security gate unreachable — "a deny short-circuits
  // regardless of order" holds only once the listener is reached.
  ctx.on('tools/pre-execute', (exec, next) => preExecuteListener(ctx, resolver, config, adapter, exec, next), { prepend: true })

  // Engine-status catalog — advisory `agent/pre-step` waterfall listener
  // (agent catalog): calls `next()` (never vetoes or
  // replaces the delegated messages) and appends the ONE unified
  // `mstar-engine-status` catalog message to the composed step messages,
  // so the session log carries the engine status + iteration phase gate +
  // workspace-state digest (model-visible ⟺ logged).
  //
  // Watermark resolution: with an explicit `harnessDir` config one
  // app-wide cache entry is built ONCE at boot (the unified mstar version
  // is a process-immutable manifest read, compass enforcement is
  // boot-resolved like the gates, and the iteration gate is
  // boot-evaluated); without the config each workspace root gets its own
  // entry, built on its first pre-step. Every entry is then TTL-refreshed
  // (Config `catalogTtlMs`, default 60000): the pre-step hot path is a
  // timestamp compare + Map lookup between refreshes, and a mid-session
  // status/compass/residual change lands within one interval (see
  // catalogSourcesFor / buildCatalogSources).
  //
  // Digest-gated re-emission: per agent+workspace the row is injected once
  // per turn and re-injected only when its rendered text changed (a
  // 20-step turn shows the catalog once, not 20 times — see
  // preStepCatalogListener / agentDigestKey).
  const ttlMs = config.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS
  const explicitKey = bootHarnessDir !== null ? EXPLICIT_CACHE_KEY : undefined
  const catalogCache = new Map<string, CatalogCacheEntry>()
  if (explicitKey !== undefined) {
    catalogCache.set(explicitKey, { sources: buildCatalogSources(ctx, bootHarnessDir), builtAt: Date.now() })
  }
  // Per agent+workspace turn digests for the digest-gated re-emission
  // (inject once per turn; re-inject only when the row changed).
  const catalogDigests = new Map<string, TurnDigest>()
  ctx.on('agent/pre-step', (payload, next) =>
    preStepCatalogListener(ctx, resolver, explicitKey, catalogCache, ttlMs, catalogDigests, payload, next))

  // v2 seams — sdd + iteration model-facing tools: `mstar sdd …` / `mstar iteration gate` equivalents on `ctx.tools`.
  registerSddIterationTools(ctx, resolver)

  // Seam tools — on-demand `mstar_*_validate` equivalents
  // (design-md / audit / compound / roles).
  registerSeamTools(ctx, resolver)
}
