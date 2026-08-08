/**
 * Task 4 — profile bundle layer (plan 20260808-dsh-seams-bundle): the
 * `@mstar-harness/dsh` package doubles as a dsh profile bundle per the
 * dsh-bundle contract (manifest `dsh.bundle.patch` + a `cordis.patch.yml`
 * patch list; `- insert:` op; id-targeted patches replace a row's WHOLE
 * `config` — no deep merge; layer over dsh-base).
 *
 * The tests read the shipped manifest and patch file (the exact files the
 * dsh profile loader composes at boot — `loadProfile` resolves
 * `join(packageDir, dsh.bundle.patch)`), assert the row's neutral defaults
 * (Enforcement OFF by construction: absent → the iteration compass decides,
 * warn-only when nothing hardens — never a global always-on hard gate), and
 * round-trip whole-config replacement with a minimal mirror of the include's
 * patch algorithm (`insert` append + id-targeted `config` replacement).
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'
import * as plugin from '../src/index.ts'

/** Package root of `@mstar-harness/dsh` (the bundle package). */
const PKG_DIR = join(import.meta.dir, '..')

/** Row shape of a cordis entry list (the dsh-bundle patch row contract). */
interface EntryRow {
  id?: string
  name?: string
  config?: unknown
  disabled?: boolean | null
}

/** One patch op: `- insert:` lists or an id-targeted override. */
interface PatchOp {
  id?: string
  insert?: EntryRow[]
  config?: unknown
}

/**
 * Minimal mirror of `@cordisjs/plugin-include` `applyEntryPatches` for the
 * two ops the dsh-bundle contract uses: `insert` appends rows; an id-targeted
 * `config` patch replaces the target row's WHOLE config (no deep merge).
 * @param entries - the composed entry list (e.g. the dsh-base layer).
 * @param patches - patch ops in application order (later wins).
 * @returns the composed entry list.
 */
function applyPatch(entries: EntryRow[], patches: PatchOp[]): EntryRow[] {
  const out = entries.map((row) => ({ ...row }))
  for (const patch of patches) {
    if (patch.insert !== undefined) {
      out.push(...patch.insert.map((row) => ({ ...row })))
      continue
    }
    const target = out.find((row) => row.id === patch.id)
    if (target === undefined) continue // the Loader warns; the row stays absent
    if (patch.config !== undefined) target.config = structuredClone(patch.config)
  }
  return out
}

/** The bundle's patch file path exactly as `loadProfile` resolves it. */
const patchPath = (pkg: { dsh?: { bundle?: { patch?: string } } }): string =>
  join(PKG_DIR, pkg.dsh?.bundle?.patch ?? '')

/** Parse the shipped `bundle/cordis.patch.yml` as a patch-op list. */
function loadBundlePatch(): PatchOp[] {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
  expect(pkg.dsh?.bundle?.patch).toBe('./bundle/cordis.patch.yml')
  const parsed = load(readFileSync(patchPath(pkg), 'utf8'))
  expect(Array.isArray(parsed)).toBe(true)
  return parsed as PatchOp[]
}

/** The single `mstar` row the bundle inserts. */
function mstarRow(): EntryRow {
  const patches = loadBundlePatch()
  expect(patches).toHaveLength(1)
  const rows = patches[0]?.insert
  expect(rows).toHaveLength(1)
  const row = rows?.[0]
  expect(row).toBeDefined()
  return row!
}

describe('profile bundle layer (Task 4)', () => {
  it('declares dsh.bundle.patch in the manifest and ships the patch file', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
    expect(pkg.dsh?.bundle?.patch).toBe('./bundle/cordis.patch.yml')
    expect(existsSync(patchPath(pkg))).toBe(true)
    // The manifest travels in the published package (bundle dir whitelisted).
    expect(pkg.files).toContain('bundle')
  })

  it('parses as a dsh-bundle patch: one `- insert:` op mounting the mstar plugin row', () => {
    const row = mstarRow()
    expect(row.id).toBe('mstar')
    expect(row.name).toBe('@mstar-harness/dsh')
  })

  it('defaults Enforcement OFF and ships no deployment-owned config keys', () => {
    const config = mstarRow().config as Record<string, unknown>
    expect(config).toBeDefined()
    // Default-off by construction: absent → the iteration compass decides,
    // warn-only when no compass hardens (never a global always-on hard gate).
    expect(config.enforcement).toBeUndefined()
    // Deployment-owned / dev-time fields stay unset for the user's layer.
    expect(config.harnessDir).toBeUndefined()
    expect(config.dispatchTools).toBeUndefined()
    expect(config.dispatchBinding).toBeUndefined()
    expect(config.skillRoots).toBeUndefined()
    // The packaged skill mount points at the Task 5 copy target.
    expect(config.bundledSkillDir).toBe('./skills')
  })

  it('accepts the shipped row config through the plugin Config schema', () => {
    const config = mstarRow().config
    expect(() => plugin.Config(config as never)).not.toThrow()
  })

  it('round-trips whole-config replacement over a dsh-base layer (no deep merge)', () => {
    // dsh-base-like composed tree WITHOUT the mstar row (the layer this
    // bundle patches over).
    const base: EntryRow[] = [
      { id: 'llm', name: '@deepseek-ai/dsh-llm' },
      { id: 'skill', name: '@deepseek-ai/dsh-skill' },
    ]
    // 1. The bundle layer inserts the mstar row with its shipped config.
    const afterBundle = applyPatch(base, loadBundlePatch())
    const row = afterBundle.find((entry) => entry.id === 'mstar')
    expect(row?.name).toBe('@mstar-harness/dsh')
    expect(row?.config).toEqual({ bundledSkillDir: './skills' })
    // 2. A user-level id-targeted patch replaces the WHOLE config: the
    // shipped key is gone — replacement, not merge.
    const afterUser = applyPatch(afterBundle, [{ id: 'mstar', config: { enforcement: 'soft' } }])
    const finalRow = afterUser.find((entry) => entry.id === 'mstar')
    expect(finalRow?.config).toEqual({ enforcement: 'soft' })
    expect((finalRow?.config as Record<string, unknown>).bundledSkillDir).toBeUndefined()
  })
})
