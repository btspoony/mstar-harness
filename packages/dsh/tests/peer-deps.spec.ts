/**
 * Registry peer contract (rc.3 from npm, no link farm): the private
 * `@deepseek-ai/*` packages are peerDependencies ONLY (never
 * devDependencies / dependencies), resolved from the npm registry at dev
 * time via bun's default peer auto-install + the monorepo-root `.npmrc`
 * auth token — no local link farm. Data-driven over the ACTUAL package.json,
 * so the peer set can grow without this test silently going stale.
 *
 * Bun installs peer dependencies by default (unlike pnpm, which needs the
 * `autoInstallPeers: true` workspace flag), so the registry switch is wired
 * solely by the monorepo-root `.npmrc` (`@deepseek-ai` registry + the
 * `${NPM_TOKEN}` auth token) and the pinned `^0.1.0-rc.3` peer ranges.
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

describe('registry peer contract (rc.3 from npm, no link farm)', () => {
  it('every @deepseek-ai/* entry is a peerDependency and appears in no other dependency field', () => {
    const peers = deepseekKeys(pkg.peerDependencies)
    expect(peers.length).toBeGreaterThan(0)
    for (const name of peers) {
      expect(pkg.dependencies?.[name], `${name} in dependencies`).toBeUndefined()
      expect(pkg.devDependencies?.[name], `${name} in devDependencies`).toBeUndefined()
      expect(pkg.optionalDependencies?.[name], `${name} in optionalDependencies`).toBeUndefined()
    }
  })

  it('every @deepseek-ai/dsh-* peer is pinned to ^0.1.0-rc.3', () => {
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) {
        expect(range, name).toBe('^0.1.0-rc.3')
      }
    }
  })

  it('peers are NOT marked optional (bun must auto-install them from the registry)', () => {
    // `peerDependenciesMeta.optional: true` was the old link-farm workaround
    // (skip unpublished peers). With registry resolution it silently skips
    // the install — the peers must be non-optional so bun installs them.
    for (const name of deepseekKeys(pkg.peerDependencies)) {
      expect(pkg.peerDependenciesMeta?.[name]?.optional, `${name} marked optional`).toBeUndefined()
    }
  })

  it('registry resolution is wired at the monorepo root (no link farm)', () => {
    const npmrc = readFileSync(join(repoRoot, '.npmrc'), 'utf8')
    expect(npmrc).toMatch(/@deepseek-ai:registry=https:\/\/registry\.npmjs\.org\//)
    expect(npmrc).toMatch(/_authToken=\$\{NPM_TOKEN\}/)
  })

  it('prepare is build-only; dsh:link scripts and the link-farm script are gone', () => {
    expect(pkg.scripts.prepare).toBe('bun run build')
    expect(pkg.scripts['dsh:link']).toBeUndefined()
    expect(pkg.scripts['dsh:link:check']).toBeUndefined()
    expect(existsSync(join(pkgDir, 'scripts', 'setup-dsh-links.ts'))).toBe(false)
  })

  it('package is tagged dsh / dsh-plugin for npm discovery', () => {
    expect(pkg.keywords).toContain('dsh')
    expect(pkg.keywords).toContain('dsh-plugin')
  })
})
