/**
 * Regression for the install-e2e skip-guard failure paths: a machine that
 * lacks `npm` or `dsh` makes `Bun.spawnSync` THROW, which previously aborted
 * module evaluation after `packRoot` was created — neither the named skip
 * nor the cleanup ran. `packAndProbe` must instead return the named skip
 * (command, failure detail, pending-5.0 publish note) and leave no pack root
 * behind. The missing executables below are genuinely absent names, so the
 * spawn error is real, not mocked.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packAndProbe } from './install-e2e-pack-probe.ts'
import { packageRoot } from '../scripts/bundle-harness-assets.ts'

const NPM_MISSING = 'definitely-missing-npm-binary-4f8c2e'
const DSH_MISSING = 'definitely-missing-dsh-binary-4f8c2e'
const REPO_VERSION = '4.9.0'
const PUBLISH_NOTE = `@mstar-harness/dsh@${REPO_VERSION} is not published until the 5.0 release`

// why: the test-owned roots are the `dsh-e2e-pack-*` entries that did not
// exist before this process ran — a shared global count would false-fail or
// mask a leak whenever another run overlaps. Entries missing at cleanup are
// already gone; entries still present after the test are leaks.
const preexistingRoots = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-e2e-pack-')))

async function expectNoNewPackRoots(): Promise<void> {
  const leaked = readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-e2e-pack-') && !preexistingRoots.has(name))
  // cleanup is registered before the assertion so a failed run never leaks
  for (const name of leaked) await rm(join(tmpdir(), name), { recursive: true, force: true })
  expect(leaked).toEqual([])
}

const envFor = (probeHome: string): Record<string, string> => ({ ...process.env, DSH_HOME: probeHome }) as Record<string, string>

describe('packAndProbe skip reasons', () => {
  test('a missing npm binary throws from spawn — the same named pack skip, pack root removed', async () => {
    const result = await packAndProbe({ packageRoot, repoVersion: REPO_VERSION, profile: 'web', env: envFor, npmBin: NPM_MISSING })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('local artifact pack failed (npm pack --json --pack-destination <dir>')
      expect(result.reason).toContain(NPM_MISSING)
      expect(result.reason).toContain(PUBLISH_NOTE)
    }
    await expectNoNewPackRoots()
  })

  test('a missing dsh binary throws from the probe spawn — the same named install skip, pack root removed', async () => {
    const result = await packAndProbe({ packageRoot, repoVersion: REPO_VERSION, profile: 'web', env: envFor, dshBin: DSH_MISSING })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('local artifact install failed (dsh plugin --profile web add file:<tarball>')
      expect(result.reason).toContain(DSH_MISSING)
      expect(result.reason).toContain(PUBLISH_NOTE)
    }
    await expectNoNewPackRoots()
  }, { timeout: 120_000 })

  test('the successful path hands the pack root to the caller untouched', async () => {
    if (Bun.which('npm') === null || Bun.which('dsh') === null) {
      console.log('pack-probe: SKIPPED — npm or dsh not on PATH')
      return
    }
    const result = await packAndProbe({ packageRoot, repoVersion: REPO_VERSION, profile: 'web', env: envFor })
    if (!result.ok) {
      // why: nothing was handed off on a failure — the helper already removed
      // its own pack root, so only the reason shape is asserted here.
      expect(result.reason).toContain(PUBLISH_NOTE)
      throw new Error(`expected a successful probe on this host, got skip: ${result.reason}`)
    }
    const packRoot = result.packRoot
    try {
      expect(existsSync(result.tarball)).toBe(true)
      expect(existsSync(packRoot)).toBe(true)
    } finally {
      // why: the pack root is caller-owned on success — cleanup is registered
      // ahead of the assertions above so a failing assertion cannot leak it.
      await rm(packRoot, { recursive: true, force: true })
    }
    expect(existsSync(packRoot)).toBe(false)
  }, { timeout: 300_000 })
})
