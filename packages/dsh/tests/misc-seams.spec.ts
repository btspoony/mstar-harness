/**
 * Task 3 — design-md / audit / compound / roles seams (plan
 * 20260808-dsh-seams-bundle): artifact-scoped `fs/write-intent` gates
 * (path patterns per artifact; warn+advisory default; hard-mode repair
 * escape on the content-blind listener — the typed `SeamVetoError` lives
 * on the known-document branch) + the on-demand `mstar_*_validate` tools
 * (CLI `mstar design-md validate` / `mstar compound validate` mirrors).
 *
 * Composition: the app boots through the real Loader with the dsh-tools
 * functional peer stub mounted (same harness as sdd-iteration-tools.spec),
 * so gate listeners and tool registrations exercise the shipping plugin
 * path.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from 'cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { CallId, ToolCallView, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import {
  SeamVetoError,
  lintAuditWrite,
  lintCompoundWrite,
  lintDesignMdWrite,
  lintRolesWrite,
  type SeamLintAdvisory,
} from '../src/index.ts'
import { bootApp, seedHarness, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** FsTarget for a local-backend path. */
const target = (path: string): FsTarget => ({ targetKey: path as FsTarget['targetKey'], displayPath: path })

/** Collect seam-lint advisory emits on the app context. */
function captureAdvisories(ctx: BootResult['ctx'] | Context): SeamLintAdvisory[] {
  const seen: SeamLintAdvisory[] = []
  ctx.on('mstar/seam-lint', (payload) => {
    seen.push(payload)
  })
  return seen
}

/** Seed a file at an absolute path (intermediate dirs created). */
async function seedFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Token-valid DESIGN.md (Level 1 shape: all four required groups concrete). */
const DESIGN_VALID = `---
version: 0.1.0
name: "Fixture Design"
description: "A minimal valid design system fixture for seam tests."
colors:
  background-100: "#ffffff"
  gray-1000: "#171717"
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
spacing:
  base: 4px
  1: 4px
  2: 8px
rounded:
  sm: 6px
---
`

/** Dark twin of {@link DESIGN_VALID} — same key sets, different values. */
const DESIGN_DARK_VALID = DESIGN_VALID
  .replace('name: "Fixture Design"', 'name: "Fixture Design Dark"')
  .replace('"#ffffff"', '"#111111"')
  .replace('"#171717"', '"#f5f5f5"')

/** Broken color value → `design-md.tokens.color-format`. */
const DESIGN_BROKEN = DESIGN_VALID.replace('"#ffffff"', '"not-a-color"')

/** Dark twin missing `gray-1000` → `design-md.parity.missing-dark`. */
const DESIGN_DARK_PARITY_BROKEN = DESIGN_DARK_VALID.replace('  gray-1000: "#f5f5f5"\n', '')

/** Compliant audit plan Status block (engine fixture shape). */
const AUDIT_GOOD = `# Fix N+1 query in order list

## Status
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit \`abc1234\`, 2026-08-08

## Problem
Every order-list render issues 1+N queries.
`

/** Invalid priority → `audit.status.invalid-priority`. */
const AUDIT_BROKEN = AUDIT_GOOD.replace('- **Priority**: P1', '- **Priority**: P9')

/** Valid Status block whose body reproduces a secret value (Hard Rule 4). */
const AUDIT_SECRET = `${AUDIT_GOOD}
const password = "hunter2hunter2hunter2";
`

/** No Status block at all → `audit.status.missing-block`. */
const AUDIT_NO_BLOCK = `# Plan without status

Some body text.
`

/** schema.yaml-compliant bug-track knowledge doc (engine fixture shape). */
const KNOWLEDGE_GOOD = `---
module: dispatch
date: 2026-08-08
problem_type: logic_error
category: logic-errors
severity: high
symptoms:
  - "Assignment parser returned null for a valid header"
root_cause: "The grammar regex required a trailing colon."
resolution_type: code_fix
---
`

/** Missing required field → `compound.schema.missing-field`. */
const KNOWLEDGE_BROKEN = KNOWLEDGE_GOOD.replace('module: dispatch\n', '')

/** Valid doc referencing a present path AND a missing path. */
const KNOWLEDGE_MIXED_REF = `${KNOWLEDGE_GOOD}
See \`src/present.ts\` and \`src/missing.ts\`.
`

/** No frontmatter at all → `compound.schema.missing-frontmatter`. */
const KNOWLEDGE_NONE = `# Knowledge

Body only.
`

/**
 * Seed a fixture mstar-roles skill dir: SKILL.md (with a valid Load Order
 * section) + the 10 distinct references/<role>.md files the 13-row engine
 * mapping resolves to, plus one sibling `mstar-*` skill for load-order
 * linting.
 * @param root - parent dir; the skill dir lands at `<root>/mstar-roles`.
 * @param options.missing - reference file basenames to omit (mapping break).
 * @param options.loadOrderOk - false → the sibling declares a Load Order
 * section without naming mstar-harness-core.
 */
async function seedRolesDir(
  root: string,
  options: { missing?: string[]; loadOrderOk?: boolean } = {},
): Promise<void> {
  const roles = join(root, 'mstar-roles')
  const references = join(roles, 'references')
  await mkdir(references, { recursive: true })
  const skill = `---
name: mstar-roles
description: Fixture role hub.
---

## Load Order (Required)

1. Read \`mstar-harness-core\` first.
`
  await writeFile(join(roles, 'SKILL.md'), skill)
  const refs = [
    'project-manager.md',
    'product-manager.md',
    'architect.md',
    'fullstack-dev-shared.md',
    'frontend-dev.md',
    'qa-engineer.md',
    'qc-specialist-shared.md',
    'ops-engineer.md',
    'writing-specialist.md',
    'prompt-engineer.md',
  ]
  for (const file of refs) {
    if (options.missing?.includes(file)) continue
    await writeFile(join(references, file), `# ${file}\n`)
  }
  const sibling = join(root, 'mstar-compound')
  await mkdir(sibling, { recursive: true })
  const loadOrder =
    options.loadOrderOk === false
      ? '## Load Order\n\n1. Nothing here.\n'
      : '## Load Order\n\n1. Read `mstar-harness-core` first.\n'
  await writeFile(join(sibling, 'SKILL.md'), `---\nname: mstar-compound\ndescription: Fixture sibling skill.\n---\n\n${loadOrder}`)
}

/** Audit plan path under `<root>/plans/audit-<date>/` (mstar-audit layout). */
function auditPlanPath(root: string, name = '001-fix-n1.md'): string {
  return join(root, 'plans', 'audit-2026-08-08', name)
}

// ---------------------------------------------------------------------------
// Known-document branch — lint*Write + typed SeamVetoError
// ---------------------------------------------------------------------------

describe('lint*Write — known-doc branch (warn gate; hard veto)', () => {
  it('design-md: broken doc → warn gate in soft mode, SeamVetoError in hard mode', () => {
    const gate = lintDesignMdWrite(DESIGN_BROKEN, { target: '/d/DESIGN.md', hard: false })
    expect(gate.ok).toBe(false)
    expect(gate.violations.map((v) => v.code)).toContain('design-md.tokens.color-format')

    let veto: unknown
    try {
      lintDesignMdWrite(DESIGN_BROKEN, { target: '/d/DESIGN.md', hard: true })
    } catch (error) {
      veto = error
    }
    expect(veto).toBeInstanceOf(SeamVetoError)
    const typed = veto as SeamVetoError
    expect(typed.code).toBe('seam.veto')
    expect(typed.seam).toBe('design-md')
    expect(typed.violations.map((v) => v.code)).toContain('design-md.tokens.color-format')
  })

  it('audit: broken Status block → warn / veto (audit.status.invalid-priority)', () => {
    const gate = lintAuditWrite(AUDIT_BROKEN, { target: '/p/001-fix.md', hard: false })
    expect(gate.ok).toBe(false)
    expect(gate.violations.map((v) => v.code)).toContain('audit.status.invalid-priority')
    expect(() => lintAuditWrite(AUDIT_BROKEN, { target: '/p/001-fix.md', hard: true })).toThrow(SeamVetoError)
  })

  it('audit: secret values join the verdict (audit.secrets.found)', () => {
    const gate = lintAuditWrite(AUDIT_SECRET, { target: '/p/001-fix.md', hard: false })
    expect(gate.ok).toBe(false)
    const codes = gate.violations.map((v) => v.code)
    expect(codes).not.toContain('audit.status.missing-block')
    expect(codes).toContain('audit.secrets.found')
  })

  it('compound: broken schema → warn / veto (compound.schema.missing-field)', () => {
    const gate = lintCompoundWrite(KNOWLEDGE_BROKEN, { target: '/k/doc.md', hard: false })
    expect(gate.ok).toBe(false)
    expect(gate.violations.map((v) => v.code)).toContain('compound.schema.missing-field')
    expect(() => lintCompoundWrite(KNOWLEDGE_BROKEN, { target: '/k/doc.md', hard: true })).toThrow(SeamVetoError)
  })

  it('compound: missing referenced path is flagged when a project root is known', async () => {
    // The repo root is the parent of {HARNESS_DIR}; seed a present sibling
    // and reference a missing one.
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-compound-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'present.ts'), 'export const ok = true\n')
    const gate = lintCompoundWrite(KNOWLEDGE_MIXED_REF, {
      target: '/k/doc.md',
      hard: false,
      harnessDir: join(root, 'harness'),
    })
    expect(gate.ok).toBe(false)
    const codes = gate.violations.map((v) => v.code)
    expect(codes).toContain('compound.reference.missing-file')
    expect(gate.violations.some((v) => v.message.includes('src/present.ts'))).toBe(false)
  })

  it('roles: broken mapping → warn / veto (roles.mapping.reference.missing)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-roles-'))
    await seedRolesDir(root, { missing: ['fullstack-dev-shared.md'] })
    const gate = lintRolesWrite('ignored', { target: join(root, 'mstar-roles', 'SKILL.md'), hard: false })
    expect(gate.ok).toBe(false)
    expect(gate.violations.map((v) => v.code)).toContain('roles.mapping.reference.missing')
    expect(() =>
      lintRolesWrite('ignored', { target: join(root, 'mstar-roles', 'SKILL.md'), hard: true }),
    ).toThrow(SeamVetoError)
  })

  it('roles: load-order violation in a sibling skill joins the verdict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-roles-'))
    await seedRolesDir(root, { loadOrderOk: false })
    const gate = lintRolesWrite('ignored', { target: join(root, 'mstar-roles', 'SKILL.md'), hard: false })
    expect(gate.ok).toBe(false)
    expect(gate.violations.map((v) => v.code)).toContain('roles.loadorder.core.missing')
  })
})

// ---------------------------------------------------------------------------
// design-md gate — fs/write-intent listener (content-blind slot)
// ---------------------------------------------------------------------------

describe('design-md gate — fs/write-intent listener', () => {
  it('broken DESIGN.md on disk → warn advisory, intent proceeds (default mode)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-designmd-'))
    booted = await bootApp()
    await seedFile(join(root, 'DESIGN.md'), DESIGN_BROKEN)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.seam).toBe('design-md')
    expect(advisories[0]!.operation).toBe('write')
    expect(advisories[0]!.hard).toBe(false)
    expect(advisories[0]!.result.hardBlocked).toBe(false)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('design-md.tokens.color-format')
  })

  it('valid DESIGN.md → silent pass (no advisory, no veto)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-designmd-'))
    booted = await bootApp()
    await seedFile(join(root, 'DESIGN.md'), DESIGN_VALID)
    await seedFile(join(root, 'DESIGN.dark.md'), DESIGN_DARK_VALID)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('parity violation (dark missing a key) is flagged on a DESIGN.md write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-designmd-'))
    booted = await bootApp()
    await seedFile(join(root, 'DESIGN.md'), DESIGN_VALID)
    await seedFile(join(root, 'DESIGN.dark.md'), DESIGN_DARK_PARITY_BROKEN)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('design-md.parity.missing-dark')
  })

  it('DESIGN.dark.md targets are scoped too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-designmd-'))
    booted = await bootApp()
    await seedFile(join(root, 'DESIGN.md'), DESIGN_VALID)
    await seedFile(join(root, 'DESIGN.dark.md'), DESIGN_BROKEN)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.dark.md')), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('design-md.tokens.color-format')
  })

  it('hard mode + broken on-disk → repair escape (allow, hard+repair advisory)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-designmd-'))
    booted = await bootApp({ enforcement: 'hard' })
    await seedFile(join(root, 'DESIGN.md'), DESIGN_BROKEN)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.hardBlocked).toBe(true)
  })

  it('hard via compass frontmatter (no Config override) → repair-escape advisory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-designmd-'))
    booted = await bootApp()
    await seedHarness(booted.harnessDir, {
      'iterations/v2.1.0/delivery-compass.md': '---\nstatus: active\nenforcement: hard\n---\n',
    })
    await seedFile(join(root, 'DESIGN.md'), DESIGN_BROKEN)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.hardBlocked).toBe(true)
  })

  it('missing DESIGN.md (first create) → pass without linting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-designmd-'))
    booted = await bootApp()
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('path-scoping: non-DESIGN files are untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-designmd-'))
    booted = await bootApp()
    await seedFile(join(root, 'design-notes.md'), DESIGN_BROKEN)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', target(join(root, 'design-notes.md')), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('hostile on-disk content → advisory (missing-frontmatter), no crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-designmd-'))
    booted = await bootApp()
    await seedFile(join(root, 'DESIGN.md'), 'no frontmatter at all\n')
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('design-md.tokens.missing-frontmatter')
  })

  it('unreadable target (directory named DESIGN.md) → degrade to allow with a degraded advisory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-designmd-'))
    booted = await bootApp()
    await mkdir(join(root, 'DESIGN.md'), { recursive: true })
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.degraded).toBe(true)
    expect(advisories[0]!.hard).toBe(false)
    expect(advisories[0]!.repair).toBeUndefined()
    expect(advisories[0]!.result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// audit gate — plans/audit-* scope
// ---------------------------------------------------------------------------

describe('audit gate — fs/write-intent listener (plans/audit-* scope)', () => {
  it('broken Status block → warn advisory, intent proceeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp()
    await seedFile(auditPlanPath(root), AUDIT_BROKEN)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', target(auditPlanPath(root)), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.seam).toBe('audit')
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('audit.status.invalid-priority')
  })

  it('valid plan → silent pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp()
    await seedFile(auditPlanPath(root), AUDIT_GOOD)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(auditPlanPath(root)), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })

  it('secret values in the on-disk plan → advisory (audit.secrets.found)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp()
    await seedFile(auditPlanPath(root), AUDIT_SECRET)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(auditPlanPath(root)), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    const codes = advisories[0]!.result.violations.map((v) => v.code)
    expect(codes).not.toContain('audit.status.missing-block')
    expect(codes).toContain('audit.secrets.found')
  })

  it('hard mode + broken → repair escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp({ enforcement: 'hard' })
    await seedFile(auditPlanPath(root), AUDIT_BROKEN)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(auditPlanPath(root)), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.hardBlocked).toBe(true)
  })

  it('path-scoping: plans/NNN-*.md outside an audit-* dir is untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp()
    await seedFile(join(root, 'plans', '001-fix-n1.md'), AUDIT_BROKEN)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(join(root, 'plans', '001-fix-n1.md')), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })

  it('path-scoping: the audit-* README.md index is untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp()
    await seedFile(auditPlanPath(root, 'README.md'), '# Index\n\nNo status block here.\n')
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(auditPlanPath(root, 'README.md')), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })

  it('hostile (no Status block) → advisory audit.status.missing-block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp()
    await seedFile(auditPlanPath(root), AUDIT_NO_BLOCK)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(auditPlanPath(root)), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('audit.status.missing-block')
  })
})

// ---------------------------------------------------------------------------
// compound gate — {HARNESS_DIR}/knowledge scope
// ---------------------------------------------------------------------------

describe('compound gate — fs/write-intent listener ({HARNESS_DIR}/knowledge scope)', () => {
  it('broken knowledge doc → warn advisory (compound.schema.missing-field)', async () => {
    booted = await bootApp()
    await seedHarness(booted.harnessDir, { 'knowledge/logic-errors/broken.md': KNOWLEDGE_BROKEN })
    const advisories = captureAdvisories(booted.ctx)
    const doc = join(booted.harnessDir, 'knowledge', 'logic-errors', 'broken.md')

    const intent = await booted.ctx.waterfall('fs/write-intent', target(doc), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.seam).toBe('compound')
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('compound.schema.missing-field')
  })

  it('valid doc → silent pass', async () => {
    booted = await bootApp()
    await seedHarness(booted.harnessDir, { 'knowledge/logic-errors/good.md': KNOWLEDGE_GOOD })
    const advisories = captureAdvisories(booted.ctx)
    const doc = join(booted.harnessDir, 'knowledge', 'logic-errors', 'good.md')

    await booted.ctx.waterfall('fs/write-intent', target(doc), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })

  it('missing referenced path → advisory (compound.reference.missing-file)', async () => {
    booted = await bootApp()
    // The gate resolves the repo root as the parent of {HARNESS_DIR}; the
    // fixture references a present sibling and a missing one.
    await seedFile(join(booted.root, 'src', 'present.ts'), 'export const ok = true\n')
    await seedHarness(booted.harnessDir, { 'knowledge/logic-errors/refs.md': KNOWLEDGE_MIXED_REF })
    const advisories = captureAdvisories(booted.ctx)
    const doc = join(booted.harnessDir, 'knowledge', 'logic-errors', 'refs.md')

    await booted.ctx.waterfall('fs/write-intent', target(doc), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    const codes = advisories[0]!.result.violations.map((v) => v.code)
    expect(codes).toContain('compound.reference.missing-file')
    expect(advisories[0]!.result.violations.some((v) => v.message.includes('src/present.ts'))).toBe(false)
  })

  it('hard mode + broken → repair escape', async () => {
    booted = await bootApp({ enforcement: 'hard' })
    await seedHarness(booted.harnessDir, { 'knowledge/logic-errors/broken.md': KNOWLEDGE_BROKEN })
    const advisories = captureAdvisories(booted.ctx)
    const doc = join(booted.harnessDir, 'knowledge', 'logic-errors', 'broken.md')

    await booted.ctx.waterfall('fs/write-intent', target(doc), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.hardBlocked).toBe(true)
  })

  it('path-scoping: markdown outside the knowledge dir is untouched', async () => {
    booted = await bootApp()
    await seedHarness(booted.harnessDir, { 'plans/001-fix.md': KNOWLEDGE_BROKEN })
    const advisories = captureAdvisories(booted.ctx)
    const doc = join(booted.harnessDir, 'plans', '001-fix.md')

    await booted.ctx.waterfall('fs/write-intent', target(doc), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })

  it('path-scoping: knowledge README.md index is untouched', async () => {
    booted = await bootApp()
    await seedHarness(booted.harnessDir, { 'knowledge/README.md': '# Knowledge index\n' })
    const advisories = captureAdvisories(booted.ctx)
    const doc = join(booted.harnessDir, 'knowledge', 'README.md')

    await booted.ctx.waterfall('fs/write-intent', target(doc), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })

  it('hostile (no frontmatter) → advisory compound.schema.missing-frontmatter', async () => {
    booted = await bootApp()
    await seedHarness(booted.harnessDir, { 'knowledge/logic-errors/none.md': KNOWLEDGE_NONE })
    const advisories = captureAdvisories(booted.ctx)
    const doc = join(booted.harnessDir, 'knowledge', 'logic-errors', 'none.md')

    await booted.ctx.waterfall('fs/write-intent', target(doc), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('compound.schema.missing-frontmatter')
  })
})

// ---------------------------------------------------------------------------
// roles gate — mstar-roles scope
// ---------------------------------------------------------------------------

describe('roles gate — fs/write-intent listener (mstar-roles scope)', () => {
  it('broken mapping → warn advisory (roles.mapping.reference.missing)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-roles-'))
    await seedRolesDir(root, { missing: ['fullstack-dev-shared.md'] })
    booted = await bootApp()
    const advisories = captureAdvisories(booted.ctx)
    const skill = join(root, 'mstar-roles', 'SKILL.md')

    const intent = await booted.ctx.waterfall('fs/write-intent', target(skill), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.seam).toBe('roles')
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('roles.mapping.reference.missing')
  })

  it('complete roles dir → silent pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-roles-'))
    await seedRolesDir(root)
    booted = await bootApp()
    const advisories = captureAdvisories(booted.ctx)
    const skill = join(root, 'mstar-roles', 'SKILL.md')

    await booted.ctx.waterfall('fs/write-intent', target(skill), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })

  it('load-order violation in a sibling skill → advisory (roles.loadorder.core.missing)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-roles-'))
    await seedRolesDir(root, { loadOrderOk: false })
    booted = await bootApp()
    const advisories = captureAdvisories(booted.ctx)
    const skill = join(root, 'mstar-roles', 'SKILL.md')

    await booted.ctx.waterfall('fs/write-intent', target(skill), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('roles.loadorder.core.missing')
  })

  it('references/*.md targets are scoped too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-roles-'))
    // The TARGET exists on disk; a DIFFERENT mapped reference is missing so
    // the gate still flags the dir state.
    await seedRolesDir(root, { missing: ['architect.md'] })
    await seedFile(join(root, 'mstar-roles', 'references', 'project-manager.md'), '# project-manager.md\n')
    booted = await bootApp()
    const advisories = captureAdvisories(booted.ctx)
    const ref = join(root, 'mstar-roles', 'references', 'project-manager.md')

    await booted.ctx.waterfall('fs/write-intent', target(ref), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('roles.mapping.reference.missing')
  })

  it('hard mode + broken → repair escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-roles-'))
    await seedRolesDir(root, { missing: ['fullstack-dev-shared.md'] })
    booted = await bootApp({ enforcement: 'hard' })
    const advisories = captureAdvisories(booted.ctx)
    const skill = join(root, 'mstar-roles', 'SKILL.md')

    await booted.ctx.waterfall('fs/write-intent', target(skill), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.hardBlocked).toBe(true)
  })

  it('path-scoping: non-role files (not SKILL.md, not references/) are untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-roles-'))
    await seedRolesDir(root, { missing: ['fullstack-dev-shared.md'] })
    booted = await bootApp()
    const advisories = captureAdvisories(booted.ctx)
    const notes = join(root, 'mstar-roles', 'notes.md')

    await booted.ctx.waterfall('fs/write-intent', target(notes), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })

  it('first create (no SKILL.md on disk yet) → pass without linting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-roles-'))
    await mkdir(join(root, 'mstar-roles'), { recursive: true })
    booted = await bootApp()
    const advisories = captureAdvisories(booted.ctx)
    const skill = join(root, 'mstar-roles', 'SKILL.md')

    const intent = await booted.ctx.waterfall('fs/write-intent', target(skill), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Shared envelope — delegation, HMR
// ---------------------------------------------------------------------------

describe('shared envelope', () => {
  it('delegates to later deciders (single-slot waterfall composition)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-seams-'))
    booted = await bootApp()
    await seedFile(join(root, 'DESIGN.md'), DESIGN_BROKEN)
    let secondRan = false
    booted.ctx.on('fs/write-intent', () => {
      secondRan = true
      return Promise.resolve({ kind: 'createIfAbsent' } as const)
    })

    const intent = await booted.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(intent).toEqual({ kind: 'createIfAbsent' })
    expect(secondRan).toBe(true)
  })

  it('a throwing advisory consumer is contained by the envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-seams-'))
    booted = await bootApp()
    await seedFile(join(root, 'DESIGN.md'), DESIGN_BROKEN)
    booted.ctx.on('mstar/seam-lint', () => { throw new Error('consumer boom') })

    const intent = await booted.ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)

    expect(intent).toBeUndefined()
  })

  it('HMR disposal: fiber.dispose unwinds all four listeners; a reloaded fiber restores them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-seams-hmr-'))
    const ctx = new Context()
    const advisories = captureAdvisories(ctx)
    try {
      const harnessDir = join(root, 'harness')
      await mkdir(harnessDir, { recursive: true })
      const audit = auditPlanPath(root)
      await seedFile(join(root, 'DESIGN.md'), DESIGN_BROKEN)
      await seedFile(audit, AUDIT_BROKEN)

      // Mount 1 — all four listeners are live on the new fiber.
      const fiber = await ctx.plugin(plugin, { harnessDir })
      await ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)
      await ctx.waterfall('fs/write-intent', target(audit), {}, () => undefined)
      expect(advisories).toHaveLength(2)

      // Dispose — the listeners are unwound: no advisory, no throw.
      await fiber.dispose()
      const before = advisories.length
      const after = await ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)
      expect(after).toBeUndefined()
      expect(advisories.length).toBe(before)

      // HMR reload — a fresh fiber restores the gates.
      const reloaded = await ctx.plugin(plugin, { harnessDir })
      await ctx.waterfall('fs/write-intent', target(join(root, 'DESIGN.md')), {}, () => undefined)
      await ctx.waterfall('fs/write-intent', target(audit), {}, () => undefined)
      expect(advisories.length).toBe(before + 2)
      await reloaded.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
    }
  })
})

// ---------------------------------------------------------------------------
// On-demand tools — mstar_*_validate (CLI mirrors)
// ---------------------------------------------------------------------------

/** Branded call identity for registry executes. */
const callId = 'misc-seams.spec' as CallId
/** Test signal (never aborted). */
const signal = new AbortController().signal

/** Run one tool call through the composed registry. */
function run(ctx: BootResult['ctx'], name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ callId, name, arguments: args, signal })
}

/** Assert the generic-card presentCall contract (title / kind / rawInput). */
function expectGenericCall(view: ToolCallView | undefined, rawInput: unknown): void {
  expect(view).toBeDefined()
  expect(view!.card).toBe('generic')
  expect(typeof view!.title).toBe('string')
  expect(view!.title!.length).toBeGreaterThan(0)
  expect(view!.kind).toBe('other')
  expect(view!.rawInput).toEqual(rawInput)
}

describe('seam tool registration — real composition', () => {
  it('registers the four mstar_*_validate tools on ctx.tools', async () => {
    const app = booted = await bootApp()
    const names = ['mstar_design_md_validate', 'mstar_audit_validate', 'mstar_compound_validate', 'mstar_roles_validate']
    const seen = new Set<string>()
    for (const name of names) {
      const tool = app.ctx.tools.lookup(name)
      expect(tool).toBeDefined()
      expect(tool!.description.length).toBeGreaterThan(0)
      expect(seen.has(name)).toBe(false)
      seen.add(name)
    }
  })

  it('presentCall renders a generic card with the primary path', async () => {
    const app = booted = await bootApp()
    expectGenericCall(app.ctx.tools.lookup('mstar_design_md_validate')!.presentCall?.({ dir: '/d' }), '/d')
    expectGenericCall(app.ctx.tools.lookup('mstar_audit_validate')!.presentCall?.({ plan_path: '/p.md' }), '/p.md')
    expectGenericCall(app.ctx.tools.lookup('mstar_compound_validate')!.presentCall?.({ doc_path: '/k.md' }), '/k.md')
    expectGenericCall(app.ctx.tools.lookup('mstar_roles_validate')!.presentCall?.({ roles_dir: '/roles' }), '/roles')
  })
})

describe('mstar_design_md_validate', () => {
  it('valid dir → ok true + completeness level', async () => {
    const app = booted = await bootApp()
    const dir = join(app.root, 'design')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'DESIGN.md'), DESIGN_VALID)
    await writeFile(join(dir, 'DESIGN.dark.md'), DESIGN_DARK_VALID)

    const result = await run(app.ctx, 'mstar_design_md_validate', { dir })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.ok).toBe(true)
    expect(result.value.violations).toEqual([])
    expect(['BELOW_MVP', 'MVP', 'Standard', 'Production']).toContain(result.value.level)
    expect(Array.isArray(result.value.level_missing)).toBe(true)
    expect(result.content[0]!.text).toContain('design-md validate:')
  })

  it('broken design → ok false + violations', async () => {
    const app = booted = await bootApp()
    const dir = join(app.root, 'design')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'DESIGN.md'), DESIGN_BROKEN)

    const result = await run(app.ctx, 'mstar_design_md_validate', { dir })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.ok).toBe(false)
    expect(result.value.violations.map((v: { code: string }) => v.code)).toContain('design-md.tokens.color-format')
  })

  it('missing DESIGN.md → error result', async () => {
    const app = booted = await bootApp()
    const dir = join(app.root, 'empty')

    const result = await run(app.ctx, 'mstar_design_md_validate', { dir })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('design file not found')
  })
})

describe('mstar_audit_validate', () => {
  it('valid plan → ok true', async () => {
    const app = booted = await bootApp()
    const plan = join(app.root, 'plans', 'audit-2026-08-08', '001-fix.md')
    await seedFile(plan, AUDIT_GOOD)

    const result = await run(app.ctx, 'mstar_audit_validate', { plan_path: plan })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.ok).toBe(true)
    expect(result.value.violations).toEqual([])
    expect(result.value.secrets).toEqual([])
  })

  it('broken plan with a secret → violations + secrets findings', async () => {
    const app = booted = await bootApp()
    const plan = join(app.root, 'plans', 'audit-2026-08-08', '001-fix.md')
    await seedFile(plan, AUDIT_SECRET)

    const result = await run(app.ctx, 'mstar_audit_validate', { plan_path: plan })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.ok).toBe(false)
    const codes = result.value.violations.map((v: { code: string }) => v.code)
    expect(codes).not.toContain('audit.status.missing-block')
    expect(codes).toContain('audit.secrets.found')
    expect(result.value.secrets.some((s: { type: string }) => s.type === 'password')).toBe(true)
  })

  it('missing plan file → error result', async () => {
    const app = booted = await bootApp()

    const result = await run(app.ctx, 'mstar_audit_validate', { plan_path: join(app.root, 'nope.md') })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('plan file not found')
  })
})

describe('mstar_compound_validate', () => {
  it('valid doc → ok true', async () => {
    const app = booted = await bootApp()
    const doc = join(app.root, 'knowledge', 'good.md')
    await seedFile(doc, KNOWLEDGE_GOOD)

    const result = await run(app.ctx, 'mstar_compound_validate', { doc_path: doc })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.ok).toBe(true)
    expect(result.value.violations).toEqual([])
  })

  it('broken doc → schema violations', async () => {
    const app = booted = await bootApp()
    const doc = join(app.root, 'knowledge', 'broken.md')
    await seedFile(doc, KNOWLEDGE_BROKEN)

    const result = await run(app.ctx, 'mstar_compound_validate', { doc_path: doc })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.ok).toBe(false)
    expect(result.value.violations.map((v: { code: string }) => v.code)).toContain('compound.schema.missing-field')
  })

  it('with knowledge_dir → index + scope checks (CLI --knowledge-dir mirror)', async () => {
    const app = booted = await bootApp()
    const knowledgeDir = join(app.root, 'knowledge')
    await mkdir(knowledgeDir, { recursive: true })
    await writeFile(join(knowledgeDir, 'good.md'), KNOWLEDGE_GOOD)
    // The doc under validation lives OUTSIDE the knowledge dir.
    const outside = join(app.root, 'stray.md')
    await writeFile(outside, KNOWLEDGE_GOOD)

    const result = await run(app.ctx, 'mstar_compound_validate', { doc_path: outside, knowledge_dir: knowledgeDir })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.ok).toBe(false)
    const codes = result.value.violations.map((v: { code: string }) => v.code)
    expect(codes).toContain('compound.scope.outside')
    // The index has no README.md → compound.index.missing-readme.
    expect(codes).toContain('compound.index.missing-readme')
  })

  it('with repo_root → reference existence checks (compound-refresh Phase 2)', async () => {
    const app = booted = await bootApp()
    const doc = join(app.root, 'knowledge', 'refs.md')
    await seedFile(doc, KNOWLEDGE_MIXED_REF)
    await seedFile(join(app.root, 'src', 'present.ts'), 'export const ok = true\n')

    const result = await run(app.ctx, 'mstar_compound_validate', { doc_path: doc, repo_root: app.root })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.ok).toBe(false)
    expect(result.value.violations.map((v: { code: string }) => v.code)).toContain('compound.reference.missing-file')
  })

  it('missing doc → error result', async () => {
    const app = booted = await bootApp()

    const result = await run(app.ctx, 'mstar_compound_validate', { doc_path: join(app.root, 'nope.md') })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('knowledge doc not found')
  })
})

describe('mstar_roles_validate', () => {
  it('complete roles dir → ok true', async () => {
    const app = booted = await bootApp()
    const root = join(app.root, 'skills')
    await seedRolesDir(root)

    const result = await run(app.ctx, 'mstar_roles_validate', { roles_dir: join(root, 'mstar-roles') })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.ok).toBe(true)
    expect(result.value.violations).toEqual([])
  })

  it('broken roles dir → violations', async () => {
    const app = booted = await bootApp()
    const root = join(app.root, 'skills')
    await seedRolesDir(root, { missing: ['fullstack-dev-shared.md'] })

    const result = await run(app.ctx, 'mstar_roles_validate', { roles_dir: join(root, 'mstar-roles') })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.ok).toBe(false)
    expect(result.value.violations.map((v: { code: string }) => v.code)).toContain('roles.mapping.reference.missing')
  })

  it('load-order lint via skills_root (defaults to the sibling dir)', async () => {
    const app = booted = await bootApp()
    const root = join(app.root, 'skills')
    await seedRolesDir(root, { loadOrderOk: false })

    const result = await run(app.ctx, 'mstar_roles_validate', { roles_dir: join(root, 'mstar-roles') })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value.ok).toBe(false)
    expect(result.value.violations.map((v: { code: string }) => v.code)).toContain('roles.loadorder.core.missing')
  })

  it('missing roles dir → error result', async () => {
    const app = booted = await bootApp()

    const result = await run(app.ctx, 'mstar_roles_validate', { roles_dir: join(app.root, 'nope') })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('roles dir not found')
  })
})
