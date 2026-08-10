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
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from 'cordis'
import {
  apply as applySkillLocal,
  Config as SkillLocalSchema,
  inject as skillLocalInject,
  name as skillLocalName,
} from '@deepseek-ai/dsh-skill-local'
import {
  applyEnforcement,
  assertIndexRows,
  completenessLevel,
  evaluatePhaseGate,
  parseCompassFrontmatter,
  readJson,
  referenceExists,
  resolveCompassEnforcement,
  scopeGuard,
  sddWorkspace,
  taskBrief,
  validateIntegrationMergeLease,
} from '@mstar-harness/engine'
import type {
  AssignmentFields,
  GateResult,
  HostAdapter,
  IntegrationMergeLease,
  StatusDoc,
  ValidationResult,
} from '@mstar-harness/engine'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: loads the `ctx.commands` cordis augmentation + the command
// handler invocation shape from the (peer-stub / real) dsh-commands seam —
// the runtime registration goes through `ctx.inject(['commands'], …)`.
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DshMstar } from './service.ts'
import type { IterationGateView } from './types.ts'
import {
  Config,
  HarnessResolver,
  sessionCwdOf,
  iterationViolationView,
  iterationGateView,
  skillLocalConfig,
} from './gates/_shared.ts'
import {
  preStepCatalogListener,
  buildCatalogSources,
  DEFAULT_CATALOG_TTL_MS,
  EXPLICIT_CACHE_KEY,
} from './gates/catalog.ts'
import type { CatalogCacheEntry, TurnDigest } from './gates/catalog.ts'
import { writeIntentListener, editIntentListener } from './gates/status.ts'
import { validateStatusValue, validateStatusDoc } from './gates/status.ts'
import type { StatusGateAdvisory } from './gates/status.ts'
import { skillWriteIntentListener } from './gates/skill-lint.ts'
import type { SkillLintAdvisory } from './gates/skill-lint.ts'
import { seamWriteIntentListener } from './gates/seams.ts'
import { validateDesignDoc, validateAuditDoc, validateCompoundDoc, validateRolesState } from './gates/seams.ts'
import type { SeamId, SeamLintAdvisory } from './gates/seams.ts'
import {
  preExecuteListener,
  DISPATCH_LOGGER,
  dispatchGateCore,
  leaseGateViolations,
  assignmentTextFromFields,
  resolveDispatchHard,
} from './gates/dispatch.ts'
import type { DispatchGateAdvisory } from './gates/dispatch.ts'

// Re-export the service type from the package entry: the cordis
// `Context` augmentation (`ctx.dshMstar`) lives in service.d.ts, so the entry
// must reference it for consumers importing `@mstar-harness/dsh` to see a
// typed `ctx.dshMstar`.
export { DshMstar } from './service.ts'
export type { DshMstarOptions } from './service.ts'
export type { MstarEngineStatusSource, MstarHarnessState, MstarIterationGateView } from './types.ts'
export { Config, HarnessResolver, skillLocalConfig } from './gates/_shared.ts'
export type { StatusGateAdvisory } from './gates/status.ts'
export { SkillLintVetoError, lintSkillDoc, lintSkillWrite } from './gates/skill-lint.ts'
export type { SkillLintAdvisory } from './gates/skill-lint.ts'
export { SeamVetoError, lintSeamWrite, lintDesignMdWrite, lintAuditWrite, lintCompoundWrite, lintRolesWrite } from './gates/seams.ts'
export type { SeamId, SeamLintAdvisory } from './gates/seams.ts'
export type { DispatchGateAdvisory } from './gates/dispatch.ts'

/** Cordis function-plugin name registered by the Loader. */
export const name = 'dsh'

/**
 * Services required before this plugin's `apply` fiber starts.
 * Empty for the scaffold: the plan's gates register on events (`fs/write-intent`,
 * `tools/pre-execute`), not on injected services; `inject` grows if a service seam is needed.
 */
export const inject: string[] = []


/** Logger label for the host adapter (dsh logger naming: `<scope>/<subject>`). */
const HOST_LOGGER = 'mstar/host-adapter'




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
