/**
 * Task 4 — skill-authoring lint on SKILL.md writes (plan
 * ): `fs/write-intent` listener scoped to SKILL.md
 * paths under the configured skill roots runs the engine skill-authoring
 * lints (lintFrontmatter + lintFiveQuestion) on write.
 *
 * Enforcement policy (decided in task-4-report.md — the content-blind slot
 * mirrors the status gate's repair-escape semantics):
 * - The intent waterfall carries only `(target, actor)` — never the incoming
 *   content (dsh-private tool-fs write.ts) — so the listener's lint signal is
 *   the pre-write on-disk document (single-read). Missing file = first create
 *   = pass; clean doc = silent pass.
 * - Warn mode (default): violations → warn log + `mstar/skill-lint` advisory
 *   + `next()` delegation (allow).
 * - Hard mode: an ALREADY-invalid on-disk doc is allowed as a REPAIR ESCAPE
 *   (error-level log + `hard: true, repair: true` advisory) — a hard veto
 *   there would deadlock the very write that repairs the document; a veto
 *   keyed to a valid on-disk doc would deadlock normal authoring (the slot
 *   cannot see the incoming content). The typed hard veto
 *   (`SkillLintVetoError`, code `skill-lint.veto`) lives on the
 *   incoming-document branch — `lintSkillWrite(doc, { hard })` — the brief's
 *   "against the incoming doc when available" entry (a repairing write
 *   carries a VALID incoming doc and passes by construction).
 * - Unexpected internal errors degrade to allow in BOTH modes with a
 *   `degraded: true` advisory (error-containment envelope).
 *
 * Harness approach (status-gate.spec.ts parity): the dsh seam packages
 * resolve from the npm registry, and the waterfall
 * is simulated with the same
 * `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` dispatch
 * the real `@deepseek-ai/dsh-tool-fs` write tool performs.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ValidationResult } from '@mstar-harness/engine'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import * as plugin from '../src/index.ts'
import { lintSkillDoc, lintSkillWrite, SkillLintVetoError, type SkillLintAdvisory } from '../src/index.ts'
import { bootApp, FakeLoaderRegistry, seedHarness, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** A lint-clean skill body answering all five questions. */
const BODY = `# Temp Lint Skill

## Load Order

Load after the harness core skill.

## Workflow

Lint the document, then decide.

## Decision Rules

Never throw except as an intentional veto.

## Evidence

A failing test passes after the fix.

## References

Open the engine skill-authoring module.
`

/** Frontmatter + body that passes both engine lints. */
const VALID_SKILL = `---
name: temp-lint-skill
description: Use when the harness lints skill writes in dev-time composition tests.
---

${BODY}
`

/** Missing `description` (the frontmatter contract's required trigger). */
const NO_DESCRIPTION_SKILL = `---
name: temp-lint-skill
---

${BODY}
`

/** `description` reads as a workflow summary (the trigger-contract bad example). */
const BAD_TRIGGER_SKILL = `---
name: temp-lint-skill
description: Explains how to write plans with steps, tests, commits, and review gates.
---

${BODY}
`

/** No frontmatter at all (hostile input). */
const HOSTILE_SKILL = 'not a skill document at all\nno frontmatter, no sections\n'

/** Ephemeral-citation fixture builder (knowledge conventions/
 * skill-content-porting-discipline.md §3): VALID_SKILL
 * plus one calibration sentence, so an ephemeral finding is the ONLY reason
 * the doc can fail the gate. */
const EPHEMERAL_SKILL = (citation: string) =>
  VALID_SKILL.replace('Lint the document, then decide.', `Lint the document, then decide. Calibrate against ${citation}.`)

/** FsTarget for `<root>/<name>/SKILL.md` (local-backend shape). */
const skillTarget = (root: string, name: string): FsTarget => ({
  targetKey: join(root, name, 'SKILL.md') as FsTarget['targetKey'],
  displayPath: join(root, name, 'SKILL.md'),
})

/** Seed a skill under a root (intermediate dirs created). */
async function seedSkill(root: string, name: string, content: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), content)
}

/** Collect skill-lint advisory emits on the app context. */
function captureAdvisories(ctx: BootResult['ctx'] | Context): SkillLintAdvisory[] {
  const advisories: SkillLintAdvisory[] = []
  ctx.on('mstar/skill-lint', (payload) => { advisories.push(payload) })
  return advisories
}

describe('lintSkillDoc / lintSkillWrite — the lint core (incoming-doc branch)', () => {
  it('valid skill passes in both modes (no throw)', () => {
    expect(lintSkillDoc(VALID_SKILL).ok).toBe(true)
    expect(lintSkillWrite(VALID_SKILL, { target: '/s/SKILL.md', hard: true }).ok).toBe(true)
  })

  it('missing description → warn-mode gate (no throw), hard-mode typed veto', () => {
    const gate = lintSkillWrite(NO_DESCRIPTION_SKILL, { target: '/s/SKILL.md', hard: false })
    expect(gate.ok).toBe(false)
    expect(gate.violations.map((v) => v.code)).toContain('lint.frontmatter.description.missing')

    let veto: unknown
    try {
      lintSkillWrite(NO_DESCRIPTION_SKILL, { target: '/s/SKILL.md', hard: true })
    } catch (error) {
      veto = error
    }
    expect(veto).toBeInstanceOf(SkillLintVetoError)
    const typed = veto as SkillLintVetoError
    expect(typed.code).toBe('skill-lint.veto')
    expect(typed.violations.map((v) => v.code)).toContain('lint.frontmatter.description.missing')
  })

  it('bad trigger contract (workflow-summary description) → warn / veto', () => {
    const gate = lintSkillWrite(BAD_TRIGGER_SKILL, { target: '/s/SKILL.md', hard: false })
    expect(gate.violations.map((v) => v.code)).toContain('lint.frontmatter.description.workflow')
    expect(() => lintSkillWrite(BAD_TRIGGER_SKILL, { target: '/s/SKILL.md', hard: true })).toThrow(SkillLintVetoError)
  })

  it('hostile input (no frontmatter) → frontmatter.missing, never an untyped throw', () => {
    const gate = lintSkillWrite(HOSTILE_SKILL, { target: '/s/SKILL.md', hard: false })
    expect(gate.ok).toBe(false)
    expect(gate.violations.map((v) => v.code)).toContain('lint.frontmatter.missing')
  })

  it('five-question body violations join the frontmatter verdict', () => {
    const noSections = `---
name: temp-lint-skill
description: Use when the harness lints skill writes in dev-time composition tests.
---

# Only a heading
`
    const gate = lintSkillDoc(noSections)
    expect(gate.ok).toBe(false)
    const codes = gate.violations.map((v) => v.code)
    expect(codes).toContain('skill-authoring.five-question.workflow')
    expect(codes).toContain('skill-authoring.five-question.references')
    expect(codes).toContain('skill-authoring.five-question.load-order')
  })
})

describe('lintSkillDoc — ephemeral citation wiring ', () => {
  it('concrete task-artifact citation → skill.ephemeral.task-artifact (medium); warn gate / hard veto via lintSkillWrite', () => {
    const doc = EPHEMERAL_SKILL('task-2-report')
    const gate = lintSkillDoc(doc)
    expect(gate.ok).toBe(false)
    const hit = gate.violations.find((v) => v.code === 'skill.ephemeral.task-artifact')
    expect(hit).toBeDefined()
    expect(hit!.severity).toBe('medium')

    // Warn mode: advisory gate (no throw), inherited through lintSkillWrite.
    expect(lintSkillWrite(doc, { target: '/s/SKILL.md', hard: false }).ok).toBe(false)

    // Hard mode: typed veto carrying the ephemeral violation (inherited).
    let veto: unknown
    try {
      lintSkillWrite(doc, { target: '/s/SKILL.md', hard: true })
    } catch (error) {
      veto = error
    }
    expect(veto).toBeInstanceOf(SkillLintVetoError)
    expect((veto as SkillLintVetoError).violations.map((v) => v.code)).toContain('skill.ephemeral.task-artifact')
  })

  it('concrete sdd-deeplink citation → skill.ephemeral.sdd-deeplink (medium); hard veto inherited', () => {
    const doc = EPHEMERAL_SKILL('.mstar/sdd/00000816-example')
    const gate = lintSkillDoc(doc)
    expect(gate.ok).toBe(false)
    const hit = gate.violations.find((v) => v.code === 'skill.ephemeral.sdd-deeplink')
    expect(hit).toBeDefined()
    expect(hit!.severity).toBe('medium')
    expect(() => lintSkillWrite(doc, { target: '/s/SKILL.md', hard: true })).toThrow(SkillLintVetoError)
  })

  it('both kinds on one line → both violations in source order, all medium', () => {
    const doc = EPHEMERAL_SKILL('.mstar/sdd/00000816-example/review/ cites task-3-report.md')
    const gate = lintSkillDoc(doc)
    const ephemeral = gate.violations.filter((v) => v.code.startsWith('skill.ephemeral.'))
    expect(ephemeral.map((v) => v.code)).toEqual([
      'skill.ephemeral.sdd-deeplink',
      'skill.ephemeral.task-artifact',
    ])
    expect(ephemeral.every((v) => v.severity === 'medium')).toBe(true)
  })

  it('placeholder references (task-N-report, {SDD_DIR}, <plan-id>) pass the ephemeral check', () => {
    const doc = EPHEMERAL_SKILL('task-N-report or {SDD_DIR}/task-N-report.md or <plan-id>')
    const gate = lintSkillDoc(doc)
    expect(gate.ok).toBe(true)
    expect(gate.violations.filter((v) => v.code.startsWith('skill.ephemeral.'))).toEqual([])
  })

  it('real skills/ corpus sample: zero ephemeral violations (wiring adds no false-positive surface)', async () => {
    const skillsDir = fileURLToPath(new URL('../../../skills/', import.meta.url))
    const sample = [
      'mstar-sdd',
      'mstar-harness-core',
      'mstar-roles',
      'mstar-coding-behavior',
      'mstar-skill-authoring',
      'mstar-artifacts',
    ]
    for (const name of sample) {
      const doc = await readFile(join(skillsDir, name, 'SKILL.md'), 'utf8')
      const gate = lintSkillDoc(doc)
      expect(gate.violations.filter((v) => v.code.startsWith('skill.ephemeral.'))).toEqual([])
    }
  })
})

describe('lintSkillDoc — classified profile, canonical fixture corpus (spec A4)', () => {
  /** The canonical fixture table produced by plan Task 1 — the SAME rows the
   * CLI suite (packages/cli/test/skill-lint-cli.test.ts) and the Guard5
   * suite (scripts/drift-lint.test.ts) consume, so per-row assertions here
   * prove cross-consumer decision equivalence with the fixture as pivot. */
  type FixtureRow = {
    id: string
    skillId: string | null
    doc: string
    expectedKind: 'core' | 'runtime' | 'authoring'
    expectedMode: 'runtime' | 'authoring' | null
    expectedFiveQuestionCodes: string[] | null
    expectedFrontmatterCodes: string[]
  }
  const FIXTURES = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../engine/test/fixtures/skill-lint-profiles.json', import.meta.url)),
      'utf8',
    ),
  ) as { schemaVersion: number; rows: FixtureRow[] }

  const fiveQ = (gate: { violations: ValidationResult[] }) =>
    gate.violations.map((v) => v.code).filter((c) => c.startsWith('skill-authoring.five-question.'))
  const frontmatter = (gate: { violations: ValidationResult[] }) =>
    gate.violations.map((v) => v.code).filter((c) => c.startsWith('lint.frontmatter.'))

  it('every fixture row yields the canonical five-question + frontmatter decision for its skillId', () => {
    for (const row of FIXTURES.rows) {
      const gate = lintSkillDoc(row.doc, { skillId: row.skillId ?? undefined })
      // Five-question decision: classified mode — core row (mode null)
      // yields NO codes (check skipped); others exact-code equality.
      expect(fiveQ(gate)).toEqual(row.expectedFiveQuestionCodes ?? [])
      // Frontmatter stays active in every profile, exact codes.
      expect(frontmatter(gate)).toEqual(row.expectedFrontmatterCodes)
      // Ephemeral stays wired and clean on the fixture corpus.
      expect(gate.violations.filter((v) => v.code.startsWith('skill.ephemeral.'))).toEqual([])
    }
  })

  it('fence-quoted heading parity: a fenced five-question heading never covers, same decision as mstar skill lint', () => {
    // Focused regression pin for the roadmap parity observation, in two
    // halves (both rows are materialized and asserted per-decision by the
    // CLI suite, packages/cli/test/skill-lint-cli.test.ts, through the real
    // `mstar skill lint` — the fixture table is the parity pivot):
    // 1. fence row — the code-fenced `# Workflow` heading does not satisfy
    //    coverage and the classified runtime profile does not rescue it:
    //    FAIL with exactly the workflow code (CLI parity, same doc + id).
    // 2. alias row — under the same classified runtime profile, alias
    //    headings DO cover: PASS with zero codes. This half is what fails
    //    if the gate stops applying the classified runtime mode for
    //    `mstar-*` ids (the parity regression this pin guards).
    const fence = FIXTURES.rows.find((r) => r.id === 'fence-only-headings-fail')!
    const fenceGate = lintSkillDoc(fence.doc, { skillId: fence.skillId! })
    expect(fenceGate.ok).toBe(false)
    expect(fiveQ(fenceGate)).toEqual(['skill-authoring.five-question.workflow'])

    const alias = FIXTURES.rows.find((r) => r.id === 'runtime-alias-pass')!
    const aliasGate = lintSkillDoc(alias.doc, { skillId: alias.skillId! })
    expect(aliasGate.ok).toBe(true)
    expect(fiveQ(aliasGate)).toEqual([])
  })

  it('core row skip is the exemption at work: the same body fails under a non-mstar identity (contrast)', () => {
    const core = FIXTURES.rows.find((r) => r.id === 'core-exempt-frontmatter-stays')!
    const contrast = lintSkillDoc(core.doc, { skillId: 'third-party-contrast' })
    expect(fiveQ(contrast).length).toBeGreaterThan(0)
    expect(lintSkillDoc(core.doc, { skillId: 'mstar-harness-core' }).violations.filter((v) =>
      v.code.startsWith('skill-authoring.five-question.'),
    )).toEqual([])
  })

  it('doc-only calls stay strict authoring (no skillId = never loosened)', () => {
    for (const row of FIXTURES.rows) {
      const docOnly = lintSkillDoc(row.doc)
      expect(docOnly).toEqual(lintSkillDoc(row.doc, { skillId: undefined }))
    }
    // The alias-body runtime row passes ONLY under its runtime identity —
    // doc-only it fails strict with the uncovered-question codes (the
    // classify-then-lint-with-classified-mode seam, exercised consumer-side).
    const aliasRow = FIXTURES.rows.find((r) => r.id === 'runtime-alias-pass')!
    const docOnly = lintSkillDoc(aliasRow.doc)
    expect(docOnly.ok).toBe(false)
    expect(fiveQ(docOnly)).toEqual([
      'skill-authoring.five-question.workflow',
      'skill-authoring.five-question.decision-rules',
      'skill-authoring.five-question.evidence',
      'skill-authoring.five-question.references',
    ])
    expect(lintSkillDoc(aliasRow.doc, { skillId: aliasRow.skillId! }).violations).toEqual([])
  })

  it('lintSkillWrite derives the profile from the trusted resolved target basename', () => {
    const aliasRow = FIXTURES.rows.find((r) => r.id === 'runtime-alias-pass')!
    // Incoming valid doc under a runtime target: hard mode passes (no veto).
    expect(
      lintSkillWrite(aliasRow.doc, { target: '/skills/mstar-alias-body/SKILL.md', hard: true }).ok,
    ).toBe(true)
    // Same doc against an authoring-named target stays strict: hard veto.
    expect(() => lintSkillWrite(aliasRow.doc, { target: '/s/SKILL.md', hard: true })).toThrow(
      SkillLintVetoError,
    )
  })

  it('blind slot lints with the classified mode: runtime alias body on disk is a silent pass (warn mode)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ skillRoots: [root] })
    const aliasRow = FIXTURES.rows.find((r) => r.id === 'runtime-alias-pass')!
    await seedSkill(root, 'mstar-alias-body', aliasRow.doc)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'mstar-alias-body'), {}, () => undefined)

    // Pre-classification this doc failed authoring strict and warned; with
    // the classified runtime profile it is clean — silent pass.
    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('content-blind hard intent keeps the repair escape on a classified-runtime doc (no fake incoming validation)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ enforcement: 'hard', skillRoots: [root] })
    // Runtime identity whose body fails even in runtime mode (Workflow only
    // inside a code fence) — the fence row, classified runtime.
    const fenceRow = FIXTURES.rows.find((r) => r.id === 'fence-only-headings-fail')!
    await seedSkill(root, 'mstar-fence-skill', fenceRow.doc)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'mstar-fence-skill'), {}, () => undefined)

    // Repair escape retained: the intent carries no incoming content, so the
    // gate never pretends to validate it — the ALREADY-invalid doc allows
    // the write as a repair with a loud advisory.
    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain(
      'skill-authoring.five-question.workflow',
    )
  })
})

describe('skill lint gate — fs/write-intent listener (content-blind slot)', () => {
  it('invalid on-disk SKILL.md (missing description) → warn advisory, intent proceeds (default mode)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ skillRoots: [root] })
    await seedSkill(root, 'broken-skill', NO_DESCRIPTION_SKILL)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'broken-skill'), {}, () => undefined)

    expect(intent).toBeUndefined() // no veto, no guard → unconditional write proceeds
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.operation).toBe('write')
    expect(advisories[0]!.target).toBe(join(root, 'broken-skill', 'SKILL.md'))
    expect(advisories[0]!.canonical).toBe('$DSH_BUNDLED_SKILL_DIR/broken-skill/SKILL.md')
    expect(advisories[0]!.hard).toBe(false)
    expect(advisories[0]!.result.hardBlocked).toBe(false)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('lint.frontmatter.description.missing')
  })

  it('bad trigger contract on disk → advisory with description.workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ skillRoots: [root] })
    await seedSkill(root, 'bad-trigger', BAD_TRIGGER_SKILL)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'bad-trigger'), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('lint.frontmatter.description.workflow')
  })

  it('valid skill on disk → silent pass (no advisory, no veto)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ skillRoots: [root] })
    await seedSkill(root, 'good-skill', VALID_SKILL)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'good-skill'), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('missing SKILL.md (first create) → pass without linting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ skillRoots: [root] })
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'new-skill'), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('hostile on-disk content → advisory (frontmatter.missing), no crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ skillRoots: [root] })
    await seedSkill(root, 'hostile', HOSTILE_SKILL)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'hostile'), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('lint.frontmatter.missing')
  })

  it('hard mode + invalid on-disk → repair escape (allow, hard+repair advisory)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ enforcement: 'hard', skillRoots: [root] })
    await seedSkill(root, 'broken-skill', NO_DESCRIPTION_SKILL)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'broken-skill'), {}, () => undefined)

    // Repair escape: the on-disk document is ALREADY invalid, so this write
    // may BE the repair — hard mode allows it with a loud advisory. The
    // advisory carries the ENFORCED verdict (status-gate shape): `hardBlocked`
    // true — the write would have been blocked, and is allowed as a repair.
    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.hardBlocked).toBe(true)
    expect(advisories[0]!.result.violations.map((v) => v.code)).toContain('lint.frontmatter.description.missing')
  })

  it('hard mode + valid on-disk → silent pass (authoring is never blocked by the blind slot)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ enforcement: 'hard', skillRoots: [root] })
    await seedSkill(root, 'good-skill', VALID_SKILL)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'good-skill'), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('hard via compass frontmatter (no Config override) → repair-escape advisory with hardBlocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ skillRoots: [root] })
    await seedHarness(booted.harnessDir, {
      'iterations/v2.1.0/delivery-compass.md': '---\nstatus: active\nenforcement: hard\n---\n',
    })
    await seedSkill(root, 'broken-skill', NO_DESCRIPTION_SKILL)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'broken-skill'), {}, () => undefined)

    // `resolveSeamHard` (the resolver the status gate also calls): the
    // iteration compass hardens the skill lint gate with no Config override.
    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.hard).toBe(true)
    expect(advisories[0]!.repair).toBe(true)
    expect(advisories[0]!.result.hardBlocked).toBe(true)
  })

  it('path-scoping: SKILL.md outside the configured roots is untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-outside-'))
    booted = await bootApp({ skillRoots: [root] })
    await seedSkill(outside, 'unmanaged', NO_DESCRIPTION_SKILL)
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(outside, 'unmanaged'), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('path-scoping: non-SKILL.md files under a configured root are untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ skillRoots: [root] })
    await mkdir(join(root, 'some-skill'), { recursive: true })
    await writeFile(join(root, 'some-skill', 'notes.md'), 'no frontmatter here')
    const advisories = captureAdvisories(booted.ctx)
    const notesTarget: FsTarget = {
      targetKey: join(root, 'some-skill', 'notes.md') as FsTarget['targetKey'],
      displayPath: join(root, 'some-skill', 'notes.md'),
    }

    const intent = await booted.ctx.waterfall('fs/write-intent', notesTarget, {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('bundledSkillDir roots are scoped too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ bundledSkillDir: root })
    await seedSkill(root, 'broken-skill', NO_DESCRIPTION_SKILL)
    const advisories = captureAdvisories(booted.ctx)

    await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'broken-skill'), {}, () => undefined)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.canonical).toBe('$DSH_BUNDLED_SKILL_DIR/broken-skill/SKILL.md')
  })

  it('no skill roots configured → gate inert (no advisory)', async () => {
    booted = await bootApp()
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(booted.root, 'unconfigured'), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(0)
  })

  it('delegates to later deciders (single-slot waterfall composition)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ skillRoots: [root] })
    await seedSkill(root, 'broken-skill', NO_DESCRIPTION_SKILL)
    let secondRan = false
    booted.ctx.on('fs/write-intent', () => {
      secondRan = true
      return Promise.resolve({ kind: 'createIfAbsent' } as const)
    })

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'broken-skill'), {}, () => undefined)

    // Every gate decision (warn advisory, repair escape) calls next() — the
    // later decider still owns the intent decision (fs-policy CAS parity).
    expect(intent).toEqual({ kind: 'createIfAbsent' })
    expect(secondRan).toBe(true)
  })

  it('unreadable on-disk document → degrade to allow with a degraded advisory (read-failure envelope)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ skillRoots: [root] })
    // A DIRECTORY named SKILL.md passes existsSync but fails readFileSync
    // (EISDIR) — the single-read contract degrades to allow with a loud
    // advisory (status-gate envelope parity), never an untyped throw.
    await mkdir(join(root, 'weird-skill', 'SKILL.md'), { recursive: true })
    const advisories = captureAdvisories(booted.ctx)

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'weird-skill'), {}, () => undefined)

    expect(intent).toBeUndefined()
    expect(advisories).toHaveLength(1)
    expect(advisories[0]!.degraded).toBe(true)
    expect(advisories[0]!.hard).toBe(false)
    expect(advisories[0]!.repair).toBeUndefined()
    expect(advisories[0]!.result.ok).toBe(true)
    expect(advisories[0]!.canonical).toBe('$DSH_BUNDLED_SKILL_DIR/weird-skill/SKILL.md')
  })

  it('a throwing advisory consumer is contained by the envelope (emit failure cannot block the write)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    booted = await bootApp({ skillRoots: [root] })
    await seedSkill(root, 'broken-skill', NO_DESCRIPTION_SKILL)
    booted.ctx.on('mstar/skill-lint', () => { throw new Error('consumer boom') })

    const intent = await booted.ctx.waterfall('fs/write-intent', skillTarget(root, 'broken-skill'), {}, () => undefined)

    // The warn advisory emit fails → outer envelope degrades to allow (error
    // log + degraded advisory attempt) → the degraded emit fails too (same
    // consumer) → emit-error containment logs. Never a throw from the gate.
    expect(intent).toBeUndefined()
  })

  it('HMR disposal: fiber.dispose unwinds the listener; a reloaded fiber restores it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skilllint-'))
    const ctx = new Context()
    // The plugin's top-level `inject: ['loader']` (Task 1) must resolve
    // before apply — same loader-guarantee the real dsh app provides.
    new FakeLoaderRegistry(ctx)
    const advisories = captureAdvisories(ctx)
    try {
      await seedSkill(root, 'broken-skill', NO_DESCRIPTION_SKILL)

      // Mount 1 — the listener is live on the new fiber.
      const fiber = await ctx.plugin(plugin, { skillRoots: [root] })
      await ctx.waterfall('fs/write-intent', skillTarget(root, 'broken-skill'), {}, () => undefined)
      expect(advisories).toHaveLength(1)

      // Dispose — the listener is unwound: no advisory, no throw.
      await fiber.dispose()
      const before = advisories.length
      const after = await ctx.waterfall('fs/write-intent', skillTarget(root, 'broken-skill'), {}, () => undefined)
      expect(after).toBeUndefined()
      expect(advisories.length).toBe(before)

      // HMR reload — a fresh fiber restores the gate.
      const reloaded = await ctx.plugin(plugin, { skillRoots: [root] })
      await ctx.waterfall('fs/write-intent', skillTarget(root, 'broken-skill'), {}, () => undefined)
      expect(advisories.length).toBe(before + 1)
      await reloaded.dispose()
    } finally {
      await ctx.fiber.dispose().catch(() => {})
    }
  })
})
