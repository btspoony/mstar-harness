/**
 * Task 3 — design-md / audit / compound / roles seams: artifact-scoped
 * `fs/write-intent` gates (path patterns per artifact; warn+advisory default;
 * hard-mode repair escape on the content-blind listener — the typed
 * `SeamVetoError` lives on the known-document branch).
 *
 * Three of the four on-demand `mstar_*_validate` tool mirrors this file used to
 * drive were duplicates of the MCP tools (`mstar_design_md` / `mstar_compound`
 * / `mstar_roles`), so they went away with the rest of the native command
 * surface; the seam VALIDATORS they wrapped are the same ones the gates below
 * exercise, which is where their coverage lives now. `mstar_audit_validate`
 * survives (the `mstar_audit` family publishes no report validator), so its
 * tool arm is driven at the end of this file.
 *
 * Composition: the app boots the REAL-composition harness with the dsh-tools
 * registry installed from the npm registry, so gate listeners exercise the
 * shipping plugin path.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import * as plugin from '../src/index.ts'
import {
  SeamVetoError,
  lintAuditWrite,
  lintCompoundWrite,
  lintDesignMdWrite,
  lintRolesWrite,
  type SeamLintAdvisory,
} from '../src/index.ts'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { bootApp, FakeLoaderRegistry, seedHarness, valueOf, type BootResult } from './harness.ts'

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

/** A review report body (the run README shape) with no plan Status block. */
const AUDIT_REPORT = `# Codebase audit — standard round 1

## Findings
Every order-list render issues 1+N queries.
`

/** Valid report whose body reproduces a secret value (Hard Rule 4). */
const auditFixturePassword = randomBytes(24).toString('hex')
const AUDIT_SECRET = `${AUDIT_REPORT}
const password = "${auditFixturePassword}";
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
 * section incl. the hub bootstrap decision matrix) + the 11 distinct
 * references/<role>.md files the 14-row engine mapping resolves to, plus one
 * sibling `mstar-*` skill for load-order linting.
 * @param root - parent dir; the skill dir lands at `<root>/mstar-roles`.
 * @param options.missing - reference file basenames to omit (mapping break).
 * @param options.loadOrderOk - false → the sibling declares a Load Order
 * section without naming mstar-harness-core.
 * @param options.legacyReference - when set, seeds the engine-absent archive
 * skill (`mstar-engine-legacy/SKILL.md` + one reference file with this body)
 * so the inbound-only rule has a reference-file text face to lint.
 */
async function seedRolesDir(
  root: string,
  options: { missing?: string[]; loadOrderOk?: boolean; legacyReference?: string } = {},
): Promise<void> {
  const roles = join(root, 'mstar-roles')
  const references = join(roles, 'references')
  await mkdir(references, { recursive: true })
  const skill = `---
name: mstar-roles
description: Fixture role hub.
---

## Load Order (Required)

1. Read \`mstar-harness-core\` first (global entry; conflict authority).
2. Read \`references/<role>.md\` **identity-first** — mission and NEVER rules before any skill list.
3. Apply the Assignment \`Skill presets:\` decision: explicit \`none\` ⇒ identity only; omitted on a substantive round ⇒ \`standard\` preset; **role-owned** methods load regardless of preset; **unknown preset** ⇒ Needs Context / Blocked.
`
  await writeFile(join(roles, 'SKILL.md'), skill)
  const refs = [
    'project-manager.md',
    'product-manager.md',
    'architect.md',
    'code-reviewer.md',
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
  if (options.legacyReference !== undefined) {
    const archive = join(root, 'mstar-engine-legacy')
    await mkdir(join(archive, 'references'), { recursive: true })
    await writeFile(
      join(archive, 'SKILL.md'),
      `---\nname: mstar-engine-legacy\ndescription: Fixture engine-absent archive.\n---\n\n## Load Order\n\nFollow the host-selected lifecycle authority first.\n`,
    )
    await writeFile(join(archive, 'references', 'field-history.md'), options.legacyReference)
  }
}

/** Review report path under the boot `{REVIEW_DIR}` (`<harness>/reviews`). */
function reviewReportPath(root: string, name = 'README.md'): string {
  return join(root, 'harness', 'reviews', '2026-08-08-codebase-standard-1', name)
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

  it('audit: a report reproducing a secret → warn gate, SeamVetoError in hard mode (audit.secrets.found)', () => {
    const gate = lintAuditWrite(AUDIT_SECRET, { target: '/r/README.md', hard: false })
    expect(gate.ok).toBe(false)
    expect(gate.violations.map((v) => v.code)).toContain('audit.secrets.found')
    expect(() => lintAuditWrite(AUDIT_SECRET, { target: '/r/README.md', hard: true })).toThrow(SeamVetoError)
  })

  it('audit: a clean report passes — the validator is the credential scan only', () => {
    const gate = lintAuditWrite(AUDIT_REPORT, { target: '/r/README.md', hard: true })
    expect(gate.ok).toBe(true)
    expect(gate.violations).toEqual([])
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

  it('roles: archive reference-file cross-reference joins the verdict (roles.loadorder.legacy.archive.reference)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-roles-'))
    await seedRolesDir(root, { legacyReference: 'Engine-present fields → `mstar-compound`.\n' })
    const gate = lintRolesWrite('ignored', { target: join(root, 'mstar-roles', 'SKILL.md'), hard: false })
    expect(gate.ok).toBe(false)
    expect(gate.violations.map((v) => v.code)).toContain('roles.loadorder.legacy.archive.reference')
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
// audit gate — {REVIEW_DIR} scope
// ---------------------------------------------------------------------------

describe('audit gate — fs/write-intent listener ({REVIEW_DIR} scope)', () => {
  it('secret values in the on-disk report → warn advisory, intent proceeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp({ root })
    await seedFile(reviewReportPath(root), AUDIT_SECRET)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', target(reviewReportPath(root)), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.seam).toBe('audit')
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('audit.secrets.found')
  })

  it('clean report → silent pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp({ root })
    await seedFile(reviewReportPath(root), AUDIT_REPORT)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(reviewReportPath(root)), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })

  it('path-scoping: a non-markdown file in the run dir is untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp({ root })
    const sidecar = reviewReportPath(root, 'findings.json')
    await seedFile(sidecar, AUDIT_SECRET)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(sidecar), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })

  it('hard mode + secret → repair escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp({ root, enforcement: 'hard' })
    await seedFile(reviewReportPath(root), AUDIT_SECRET)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(reviewReportPath(root)), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.hardBlocked).toBe(true)
  })

  it('path-scoping: a plan-shaped `.md` outside {REVIEW_DIR} is untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp({ root })
    const plan = join(root, 'plans', '001-fix-n1.md')
    await seedFile(plan, AUDIT_SECRET)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(plan), {}, () => undefined)

    expect(advisories).toHaveLength(0)
  })

  it('path-scoping: the run README.md IS in scope (it is the report)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp({ root })
    await seedFile(reviewReportPath(root, 'README.md'), AUDIT_SECRET)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(reviewReportPath(root, 'README.md')), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('audit.secrets.found')
  })

  it('no harness dir → the `reviews` path segment still scopes the seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-audit-'))
    booted = await bootApp({ root, harnessDir: null })
    const report = join(root, 'reviews', '2026-08-08-pr134', 'report.md')
    await seedFile(report, AUDIT_SECRET)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', target(report), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.seam).toBe('audit')
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('audit.secrets.found')
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
    // The plugin's top-level `inject: ['loader']` (Task 1) must resolve
    // before apply — same loader-guarantee the real dsh app provides.
    new FakeLoaderRegistry(ctx)
    const advisories = captureAdvisories(ctx)
    try {
      const harnessDir = join(root, 'harness')
      await mkdir(harnessDir, { recursive: true })
      const audit = reviewReportPath(root)
      await seedFile(join(root, 'DESIGN.md'), DESIGN_BROKEN)
      await seedFile(audit, AUDIT_SECRET)

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
// mstar_audit_validate — the surviving native validator (no MCP twin)
// ---------------------------------------------------------------------------

/** Branded call identity for registry executes. */
const callId = 'misc-seams.spec' as ToolCallId
/** Test signal (never aborted). */
const signal = new AbortController().signal

/** Run one tool call through the composed registry. */
function run(ctx: BootResult['ctx'], name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ callId, name, arguments: args, signal })
}

describe('mstar_audit_validate', () => {
  it('clean report → ok true', async () => {
    const app = booted = await bootApp()
    const report = reviewReportPath(app.root)
    await seedFile(report, AUDIT_REPORT)

    const result = await run(app.ctx, 'mstar_audit_validate', { report_path: report })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(valueOf(result).ok).toBe(true)
    expect(valueOf(result).violations).toEqual([])
    expect(valueOf(result).secrets).toEqual([])
  })

  it('report reproducing a secret → violations + secrets findings', async () => {
    const app = booted = await bootApp()
    const report = reviewReportPath(app.root)
    await seedFile(report, AUDIT_SECRET)

    const result = await run(app.ctx, 'mstar_audit_validate', { report_path: report })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(valueOf(result).ok).toBe(false)
    expect(valueOf(result).violations.map((v: { code: string }) => v.code)).toContain('audit.secrets.found')
    expect(valueOf(result).secrets!.some((s: { type: string }) => s.type === 'password')).toBe(true)
  })

  it('missing report file → error result', async () => {
    const app = booted = await bootApp()

    const result = await run(app.ctx, 'mstar_audit_validate', { report_path: join(app.root, 'nope.md') })

    expect(result.isError).toBe(true)
    if (!result.isError) return
    expect(result.error.message).toContain('report file not found')
  })
})
