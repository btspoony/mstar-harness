/**
 * On-demand model-facing tools — the v2 seam + sdd/iteration registrations
 * (plan `20260810-dsh-entry-split` §15 extraction).
 *
 * `registerSddIterationTools` (mstar_sdd_workspace / mstar_sdd_task_brief /
 * mstar_iteration_gate) and `registerSeamTools` (mstar_design_md_validate /
 * mstar_audit_validate / mstar_compound_validate / mstar_roles_validate) are
 * both deferred with `ctx.inject(['tools'], …)` (the optional-unit pattern),
 * so the plugin boots without the tools service and registers when the
 * composed dsh app provides `ctx.tools`. The tools reuse the seam gate
 * validators (`validateDesignDoc` / `validateAuditDoc` /
 * `validateCompoundDoc` / `validateRolesState`) — the SAME validation paths
 * the fs-intent seams run.
 *
 * Module boundary: no barrel — the entry imports by explicit relative path;
 * the seam validators come from `./seams.ts` by explicit relative import.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Context } from '@deepseek-ai/cordis'
import {
  assertIndexRows,
  completenessLevel,
  evaluatePhaseGate,
  parseCompassFrontmatter,
  readJson,
  referenceExists,
  scopeGuard,
  sddWorkspace,
  taskBrief,
} from '@mstar-harness/engine'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { validateDesignDoc, validateAuditDoc, validateCompoundDoc, validateRolesState } from './seams.ts'
import { sessionCwdOf, iterationViolationView, iterationGateView, HarnessResolver } from './_shared.ts'
import type { IterationGateView } from '../types.ts'

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
export function registerSddIterationTools(ctx: Context, resolver: HarnessResolver): void {
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
        'Evaluate the iteration phase-transition gate against a workflow snapshot and a delivery-compass.md ' +
        '(engine evaluatePhaseGate, mirror of `mstar iteration gate --workflow <id>`): returns the transition ' +
        '(phase-2-execute / phase-3-close / phase-4-pr-delivery), the pass/fail verdict, and the ' +
        '§3.1 entry / §3.5 exit checklists with violation codes.',
      parameters: {
        snapshot_path: {
          type: 'string',
          required: true,
          description: 'Path to {HARNESS_DIR}/workflows/<id>/snapshot.json (the selected workflow snapshot — v3 input, mirrors the CLI `iteration gate --workflow <id>`).',
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
        if (!existsSync(args.snapshot_path)) throw new Error(`workflow snapshot not found: ${args.snapshot_path}`)
        if (!existsSync(args.compass_path)) throw new Error(`compass file not found: ${args.compass_path}`)
        const snapshotDoc = readJson(args.snapshot_path)
        const compassDoc = parseCompassFrontmatter(args.compass_path)
        const result = evaluatePhaseGate(snapshotDoc, compassDoc, {
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
export function registerSeamTools(ctx: Context, resolver: HarnessResolver): void {
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
