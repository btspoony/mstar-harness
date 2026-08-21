/**
 * Registry peer contract (npm, no link farm): `@deepseek-ai/*` packages are
 * peerDependencies ONLY (never devDependencies / dependencies), resolved
 * from the public registry at dev time via bun's default peer auto-install
 * — no local link farm, no scoped-registry `.npmrc`. Data-driven over the
 * ACTUAL package.json so the peer set and the shared caret range can move
 * without this file hard-coding a version.
 *
 * Bun installs peer dependencies by default (unlike pnpm, which needs the
 * `autoInstallPeers: true` workspace flag).
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(here, '..')
// The monorepo root owns the registry/auth `.npmrc` (bun workspaces share it).
const repoRoot = resolve(here, '..', '..', '..')

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  keywords?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const deepseekKeys = (field: Record<string, string> | undefined): string[] =>
  Object.keys(field ?? {}).filter((name) => name.startsWith('@deepseek-ai/')).sort()

describe('registry peer contract (npm, no link farm)', () => {
  it('every @deepseek-ai/* entry is a peerDependency and appears in no other dependency field', () => {
    const peers = deepseekKeys(pkg.peerDependencies)
    expect(peers.length).toBeGreaterThan(0)
    for (const name of peers) {
      expect(pkg.dependencies?.[name], `${name} in dependencies`).toBeUndefined()
      expect(pkg.devDependencies?.[name], `${name} in devDependencies`).toBeUndefined()
      expect(pkg.optionalDependencies?.[name], `${name} in optionalDependencies`).toBeUndefined()
    }
  })

  it('every @deepseek-ai/dsh-* peer shares one caret range from package.json', () => {
    const dshPeers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) =>
      name.startsWith('@deepseek-ai/dsh-'),
    )
    expect(dshPeers.length).toBeGreaterThan(0)
    const canonical = dshPeers[0]![1]
    expect(canonical.length).toBeGreaterThan(0)
    for (const [name, range] of dshPeers) {
      expect(range, name).toBe(canonical)
    }
  })

  it('the resolved @deepseek-ai/dsh-* graph is a single line (one version, no dsh-client-web-react)', () => {
    // Lock-wide complement of the manifest pin: bun.lock is the ground truth
    // of what actually resolves. Caret peer ranges alone do not guarantee a
    // single line — a conflicting peer can leave nested prerelease copies
    // behind while the manifest still reads one range. ANY dsh-* entry off
    // the unique resolved version fails here.
    const lock = readFileSync(join(repoRoot, 'bun.lock'), 'utf8')
    const resolvedNames = new Set<string>()
    const resolvedVersions = new Set<string>()
    for (const match of lock.matchAll(/(@deepseek-ai\/dsh-[^@"]+)@([0-9]+\.[0-9]+\.[0-9][^"]*)/g)) {
      resolvedNames.add(match[1])
      resolvedVersions.add(match[2])
    }
    for (const name of deepseekKeys(pkg.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) {
        expect(resolvedNames.has(name), `${name} missing from bun.lock resolution graph`).toBe(true)
      }
    }
    expect(resolvedVersions.size, `split dsh-* graph: ${[...resolvedVersions].join(', ')}`).toBe(1)
    expect(resolvedNames.has('@deepseek-ai/dsh-client-web-react')).toBe(false)
  })

  it('peers are NOT marked optional (bun must auto-install them from the registry)', () => {
    // `peerDependenciesMeta.optional: true` was the old link-farm workaround
    // (skip unpublished peers). With registry resolution it silently skips
    // the install — the peers must be non-optional so bun installs them.
    for (const name of deepseekKeys(pkg.peerDependencies)) {
      expect(pkg.peerDependenciesMeta?.[name]?.optional, `${name} marked optional`).toBeUndefined()
    }
  })

  it('registry resolution needs no root .npmrc (public npm registry, no link farm)', () => {
    // The 0c884d47 npmrc cleanup removed the root `.npmrc` auth token —
    // `@deepseek-ai` is public on registry.npmjs.org and bun auto-installs
    // peers from the default registry. No scoped-registry mapping may come
    // back (that was the link-farm era wiring).
    const npmrcPath = join(repoRoot, '.npmrc')
    if (existsSync(npmrcPath)) {
      const npmrc = readFileSync(npmrcPath, 'utf8')
      expect(npmrc).not.toMatch(/@deepseek-ai\s*:/)
    }
    // Behavioral half: the dev-time seam must resolve from the registry.
    expect(
      JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-llm/package.json'), 'utf8')).version,
    ).toEqual(expect.any(String))
  })

  it('no install-time side effects; prepare, dsh:link scripts and the link-farm script are gone', () => {
    // 787957b deliberately dropped the prepare script: the monorepo builds
    // packages explicitly (no build on install), matching cli/opencode.
    expect(pkg.scripts.prepare).toBeUndefined()
    expect(pkg.scripts['dsh:link']).toBeUndefined()
    expect(pkg.scripts['dsh:link:check']).toBeUndefined()
    expect(existsSync(join(pkgDir, 'scripts', 'setup-dsh-links.ts'))).toBe(false)
  })

  it('package is tagged dsh / dsh-plugin for npm discovery', () => {
    expect(pkg.keywords).toContain('dsh')
    expect(pkg.keywords).toContain('dsh-plugin')
  })
})
