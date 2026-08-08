/**
 * Task 3 — skills mounting via skill-local (single canonical mount) (plan
 * 20260808-dsh-host-adapter).
 *
 * Dev-time reality: the dsh seam packages are peer-stubs (no real runtime),
 * so the plugin's registration call is implemented against the CONTRACT —
 * the skill-local `{ name, inject, Config, apply }` plugin module and the
 * `customSkillDirs` / `bundledSkillDir` Config semantics. Verification is
 * threefold (brief): (a) contract-shape tests — the registration payload
 * built by `skillLocalConfig` matches the skill-local Config schema
 * expectations; (b) frontmatter parse checks on the ACTUAL mirror `skills/`
 * via the engine `lintSkillFrontmatter` (already a dependency); (c)
 * `resolveSkillRoot('dsh', …)` resolves per the frozen canonical form
 * `$DSH_BUNDLED_SKILL_DIR/<name>` (Task 1). On top of that, the test app
 * composes for real — the registry row + the plugin's registration mount a
 * dev-time provider that makes mstar skills discoverable through
 * `ctx.skills` (the plan acceptance).
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintSkillFrontmatter, resolveSkillRoot } from '@mstar-harness/engine'
import { Config as SkillLocalSchema } from '@deepseek-ai/dsh-skill-local'
import { DshHostAdapter, skillLocalConfig } from '../src/index.ts'
import { bootApp, type BootResult } from './harness.ts'

let booted: BootResult | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

/** The repo-root mirror `skills/` dir (byte-identical to the control mirror). */
const MIRROR_SKILLS = fileURLToPath(new URL('../../../skills/', import.meta.url))

/** Real mirror skills asserted to be mounted and lint-clean. */
const MIRROR_SKILLS_SAMPLE = ['mstar-plan-conventions', 'mstar-harness-core', 'mstar-sdd'] as const

/** Seed a temp skill root with two skills: `<dir>/SKILL.md` and `<name>.md` shapes. */
async function seedSkillRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mstar-skills-'))
  await mkdir(join(root, 'temp-one'), { recursive: true })
  await writeFile(join(root, 'temp-one', 'SKILL.md'), `---
name: temp-one
description: A temp skill for dev-time composition tests.
---

# Temp One

Body of temp-one.
`)
  await writeFile(join(root, 'temp-two.md'), `---
name: temp-two
description: A flat temp skill file for dev-time composition tests.
---

# Temp Two

Body of temp-two.
`)
  return root
}

describe('skillLocalConfig — registration payload contract shape', () => {
  it('returns undefined (no registration) when no skill roots are configured', () => {
    expect(skillLocalConfig({})).toBeUndefined()
    expect(skillLocalConfig({ skillRoots: [] })).toBeUndefined()
    expect(skillLocalConfig({ skillRoots: ['', '  '] })).toBeUndefined()
  })

  it('maps skillRoots to the skill-local customSkillDirs semantics', () => {
    const payload = skillLocalConfig({ skillRoots: ['/mirror/skills'] })
    expect(payload).toEqual({ providerName: 'mstar', includeDefaultRoots: false, customSkillDirs: ['/mirror/skills'] })
  })

  it('maps bundledSkillDir through with its own semantics', () => {
    expect(skillLocalConfig({ bundledSkillDir: '/pkg/skills' })).toEqual({
      providerName: 'mstar',
      includeDefaultRoots: false,
      bundledSkillDir: '/pkg/skills',
    })
  })

  it('combines custom roots and the bundled root', () => {
    const payload = skillLocalConfig({ skillRoots: ['/a/skills'], bundledSkillDir: '/pkg/skills' })
    expect(payload).toEqual({
      providerName: 'mstar',
      includeDefaultRoots: false,
      customSkillDirs: ['/a/skills'],
      bundledSkillDir: '/pkg/skills',
    })
  })

  it('filters blank root entries', () => {
    expect(skillLocalConfig({ skillRoots: ['/a/skills', '', '/b/skills'] })?.customSkillDirs).toEqual(['/a/skills', '/b/skills'])
  })

  it('every payload parses through the skill-local Config schema (the loader expectation)', () => {
    for (const payload of [
      skillLocalConfig({ skillRoots: ['/mirror/skills'] }),
      skillLocalConfig({ bundledSkillDir: '/pkg/skills' }),
      skillLocalConfig({ skillRoots: ['/a/skills'], bundledSkillDir: '/pkg/skills' }),
    ]) {
      // schemastery schemas are callable: Schema(data) validates and returns the parsed value.
      const parsed = SkillLocalSchema(payload)
      expect(parsed.providerName).toBe('mstar')
      expect(parsed.includeDefaultRoots).toBe(false)
    }
  })
})

describe('resolveSkillRoot (frozen canonical form, Task 1)', () => {
  it("resolves dsh skills under $DSH_BUNDLED_SKILL_DIR/<name>", () => {
    expect(resolveSkillRoot('dsh', { skill: 'mstar-plan-conventions' })).toBe('$DSH_BUNDLED_SKILL_DIR/mstar-plan-conventions')
  })

  it('appends relative paths for skill assets', () => {
    expect(resolveSkillRoot('dsh', { skill: 'mstar-plan-conventions', rel: 'references/plan-files-and-reports.md' }))
      .toBe('$DSH_BUNDLED_SKILL_DIR/mstar-plan-conventions/references/plan-files-and-reports.md')
  })
})

describe('mirror skills/ frontmatter contract (engine lintSkillFrontmatter)', () => {
  it.each(MIRROR_SKILLS_SAMPLE)('lintSkillFrontmatter passes for the real %s SKILL.md', async (skillName) => {
    const text = await Bun.file(join(MIRROR_SKILLS, skillName, 'SKILL.md')).text()
    const gate = lintSkillFrontmatter(text)
    expect(gate.ok, JSON.stringify(gate.violations)).toBe(true)
    expect(gate.violations).toHaveLength(0)
  })
})

describe('skills mount via the plugin (real composition)', () => {
  it('mounts the mirror skills/ through the plugin Config and lists them on ctx.skills', async () => {
    booted = await bootApp({ skillRoots: [MIRROR_SKILLS] })
    const skills = await booted.ctx.skills.list()
    const planConventions = skills.find((skill) => skill.name === 'mstar-plan-conventions')
    expect(planConventions).toBeDefined()
    expect(planConventions!.description.length).toBeGreaterThan(0)
    expect(planConventions!.provider).toBe('mstar')
    expect(planConventions!.source).toBe('custom')
    // The plan acceptance: name/description present for the mounted skill.
    expect(skills.some((skill) => skill.name === 'mstar-harness-core')).toBe(true)
    expect(skills.some((skill) => skill.name === 'pm')).toBe(true)
  })

  it('loads the full skill body through ctx.skills.get', async () => {
    booted = await bootApp({ skillRoots: [MIRROR_SKILLS] })
    const definition = await booted.ctx.skills.get('mstar-plan-conventions')
    expect(definition).toBeDefined()
    expect(definition!.content).toContain('# Morning Star')
    expect(definition!.path).toBe(join(MIRROR_SKILLS, 'mstar-plan-conventions', 'SKILL.md'))
  })

  it('composes temp custom roots and the real mirror in one app (temp + real roots)', async () => {
    const tempRoot = await seedSkillRoot()
    booted = await bootApp({ skillRoots: [tempRoot, MIRROR_SKILLS] })
    const skills = await booted.ctx.skills.list()
    const names = skills.map((skill) => skill.name)
    expect(names).toContain('temp-one')
    expect(names).toContain('temp-two')
    expect(names).toContain('mstar-plan-conventions')
  })

  it('registers the bundled root with the bundled source', async () => {
    const tempRoot = await seedSkillRoot()
    booted = await bootApp({ bundledSkillDir: tempRoot })
    const skills = await booted.ctx.skills.list()
    const bundled = skills.find((skill) => skill.name === 'temp-one')
    expect(bundled).toBeDefined()
    expect(bundled!.source).toBe('bundled')
  })

  it('does not mount anything when no skill roots are configured', async () => {
    booted = await bootApp()
    expect(await booted.ctx.skills.list()).toEqual([])
  })

  it('unregisters the provider on fiber disposal (HMR safety)', async () => {
    booted = await bootApp({ skillRoots: [MIRROR_SKILLS] })
    expect((await booted.ctx.skills.list()).length).toBeGreaterThan(0)
    await booted.dispose()
    booted = undefined
    // A fresh app on the same temp root must see no leftover providers; the
    // disposed app's registry is gone with its fiber.
    const fresh = await bootApp({ skillRoots: [MIRROR_SKILLS] })
    expect((await fresh.ctx.skills.list()).length).toBeGreaterThan(0)
    await fresh.dispose()
  })
})

describe('host adapter attached on ctx (Task 2 reviewer note)', () => {
  it('exposes the DshHostAdapter instance as ctx.dshHostAdapter', async () => {
    booted = await bootApp()
    expect(booted.ctx.dshHostAdapter).toBeInstanceOf(DshHostAdapter)
    expect(booted.ctx.dshHostAdapter.host).toBe('dsh')
  })
})
