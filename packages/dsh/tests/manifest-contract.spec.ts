/**
 * Manifest contract for the dsh web client module (plan
 * `20260810-dsh-upstream-adapter`, Task 1 — AC anchor AC-8).
 *
 * Root cause: upstream dsh moved client-module discovery from the top-level
 * `dshClient` package.json field to the nested `dsh.client`
 * (`/Users/bibi/.dsh/source/current/packages/client/modules/src/index.ts`
 * `parseDshClient` / `resolveMeta` — read `pkg.dsh.client` only, NO legacy
 * fallback). The old field parsed to `undefined` → the plugin was no longer a
 * web client module → `window.__DSH_BOOT__.entries` lost the
 * `@mstar-harness/dsh` row → the "MStar 工作流" panel vanished.
 *
 * This test freezes the NEW manifest contract so the next upstream field
 * rename fails here FIRST (before any running-app symptom). It lives in its
 * own file rather than `export-surface.spec.ts` — that file is a frozen
 * module-export snapshot (entry-split plan) with an explicit "do not edit
 * without review" contract, and this is a package.json concern, not a module
 * export-surface concern.
 *
 * Assertions:
 * - `dsh.client.platform === 'web'` and `dsh.client.inject` is the exact
 *   string array the boot graph injects as edges;
 * - the legacy top-level `dshClient` key is GONE (upstream has no
 *   compatibility fallback — a resurrected old field would silently
 *   un-discover the plugin);
 * - `dsh.bundle.patch` (cordis patch path) stays untouched — the migration
 *   must not disturb the bundle row;
 * - `exports["./client"]` still resolves to an EXISTING built artifact (we
 *   assert existence, not just path shape, because upstream `resolveMeta`
 *   joins the export path onto the package root and READS it at activation —
 *   a dangling export is a missing boot entry exactly like the root cause).
 *   Trade-off: the test then requires a built bundle; `bun run test` builds
 *   it first via the `pretest` hook (`build-client`), and a direct `bun test`
 *   on a fresh checkout fails with an actionable hint (run `bun run build`
 *   first) instead of a bare false. `dist/` is a gitignored build artifact
 *   (the package's `prepare`/`prepublishOnly` scripts build it), so existence
 *   is the real contract, not a convenience.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, normalize, relative } from 'node:path'

/** Package root of `@mstar-harness/dsh` (same relative resolution as build-client-bundle.spec.ts). */
const PKG_DIR = join(import.meta.dir, '..')
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as Record<string, unknown>

/** The inject faces the boot graph wires as edges — documented contract (plan Task 1). */
const EXPECTED_INJECT = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-locale',
]

describe('manifest contract: dsh.client (upstream client-modules discovery)', () => {
  it('declares dsh.client.platform = "web"', () => {
    const client = (pkg.dsh as Record<string, unknown> | undefined)?.client
    expect(client).toBeDefined()
    expect((client as Record<string, unknown>).platform).toBe('web')
  })

  it('declares dsh.client.inject as the exact string-array inject faces', () => {
    const client = (pkg.dsh as Record<string, unknown>).client as Record<string, unknown>
    expect(Array.isArray(client.inject)).toBe(true)
    expect(client.inject).toEqual(EXPECTED_INJECT)
    // every element a string — upstream parseDshClient throws otherwise
    expect((client.inject as unknown[]).every((i) => typeof i === 'string')).toBe(true)
  })

  it('removed the legacy top-level dshClient key (upstream has no fallback)', () => {
    expect(pkg).not.toHaveProperty('dshClient')
  })

  it('keeps dsh.bundle.patch unchanged', () => {
    const bundle = (pkg.dsh as Record<string, unknown>).bundle as Record<string, unknown>
    expect(bundle.patch).toBe('./bundle/cordis.patch.yml')
  })

  it('exports["./client"] resolves to an existing built artifact', () => {
    const clientExport = (pkg.exports as Record<string, unknown>)['./client'] as
      | Record<string, unknown>
      | string
    expect(clientExport).toBeDefined()
    const defaultPath =
      typeof clientExport === 'string' ? clientExport : (clientExport as Record<string, unknown>).default
    expect(typeof defaultPath).toBe('string')
    const resolved = join(PKG_DIR, defaultPath as string)
    // path-shape sanity on top of existence: must stay inside the package root
    expect(normalize(relative(PKG_DIR, resolved))).not.toMatch(/^\.\./)
    // Existence is the real contract (upstream resolveMeta READS the file at
    // activation — a dangling export is a missing boot entry exactly like the
    // root cause). A missing dist is an actionable setup error, not a contract
    // failure: `bun run test` auto-builds via the `pretest` hook; a direct
    // `bun test` on a fresh checkout gets this hint.
    expect(
      existsSync(resolved),
      `missing built client bundle at ${resolved} — run \`bun run build\` first (build-client + dist), then \`bun test\``,
    ).toBe(true)
  })
})
