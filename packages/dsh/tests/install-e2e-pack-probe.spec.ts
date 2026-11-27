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
import { packAndProbe } from './install-e2e-pack-probe.ts'
import { packageRoot } from '../scripts/bundle-harness-assets.ts'

const NPM_MISSING = 'definitely-missing-npm-binary-4f8c2e'
const DSH_MISSING = 'definitely-missing-dsh-binary-4f8c2e'
const REPO_VERSION = '4.9.0'
const PUBLISH_NOTE = `@mstar-harness/dsh@${REPO_VERSION} is not published until the 5.0 release`

function packRootCount(): number {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-e2e-pack-')).length
}

const envFor = (probeHome: string): Record<string, string> => ({ ...process.env, DSH_HOME: probeHome }) as Record<string, string>

describe('packAndProbe skip reasons', () => {
  test('a missing npm binary throws from spawn — the same named pack skip, pack root removed', async () => {
    const before = packRootCount()
    const result = await packAndProbe({ packageRoot, repoVersion: REPO_VERSION, profile: 'web', env: envFor, npmBin: NPM_MISSING })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('local artifact pack failed (npm pack --json --pack-destination <dir>')
      expect(result.reason).toContain(NPM_MISSING)
      expect(result.reason).toContain(PUBLISH_NOTE)
    }
    // why: the pack root count is compared rather than a named directory —
    // the helper removes it internally before the reason returns.
    expect(packRootCount()).toBe(before)
  })

  test('a missing dsh binary throws from the probe spawn — the same named install skip, pack root removed', async () => {
    const before = packRootCount()
    const result = await packAndProbe({ packageRoot, repoVersion: REPO_VERSION, profile: 'web', env: envFor, dshBin: DSH_MISSING })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('local artifact install failed (dsh plugin --profile web add file:<tarball>')
      expect(result.reason).toContain(DSH_MISSING)
      expect(result.reason).toContain(PUBLISH_NOTE)
    }
    expect(packRootCount()).toBe(before)
  }, { timeout: 120_000 })

  test('the successful path hands the pack root to the caller untouched', async () => {
    if (Bun.which('npm') === null || Bun.which('dsh') === null) {
      console.log('pack-probe: SKIPPED — npm or dsh not on PATH')
      return
    }
    const before = packRootCount()
    const result = await packAndProbe({ packageRoot, repoVersion: REPO_VERSION, profile: 'web', env: envFor })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(existsSync(result.tarball)).toBe(true)
      expect(packRootCount()).toBe(before + 1)
      await rm(result.packRoot, { recursive: true, force: true })
    }
  }, { timeout: 300_000 })
})
