// see packages/dsh/tests/install-e2e.spec.ts - the skip-guard failure paths must return the named skip with the pack root already removed; fixture binaries stand in for npm/dsh so no registry or real npm/dsh is needed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packAndProbe } from './install-e2e-pack-probe.ts'

const REPO_VERSION = '4.9.0'
const PUBLISH_NOTE = `@mstar-harness/dsh@${REPO_VERSION} is not published until the 5.0 release`

let fixtureRoot = ''
let npmFixture = ''
let dshFixture = ''

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-probe-fixture-'))
  npmFixture = join(fixtureRoot, 'npm-fixture.js')
  await writeFile(npmFixture, `#!/usr/bin/env bun
const { writeFileSync } = await import('node:fs')
const dest = process.argv[process.argv.length - 1]
const filename = 'mstar-harness-dsh-4.9.0.tgz'
writeFileSync(dest + '/' + filename, 'fixture')
console.log(JSON.stringify([{ filename }]))
`)
  dshFixture = join(fixtureRoot, 'dsh-fixture.js')
  await writeFile(dshFixture, `#!/usr/bin/env bun
process.exit(0)
`)
  for (const f of [npmFixture, dshFixture]) await chmod(f, 0o755)
})

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true })
})

const envFor = (probeHome: string): Record<string, string> => ({ ...process.env, DSH_HOME: probeHome }) as Record<string, string>
const baseArgs = () => ({ repoVersion: REPO_VERSION, profile: 'web', env: envFor, packageRoot: fixtureRoot })

describe('packAndProbe skip reasons', () => {
  test('a missing npm binary throws from spawn — the same named pack skip, pack root removed', async () => {
    const result = await packAndProbe({ ...baseArgs(), npmBin: 'definitely-missing-npm-binary-4f8c2e' })
    try {
      expect(result.ok).toBe(false)
      expect(existsSync(result.packRoot)).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain('local artifact pack failed (npm pack --json --pack-destination <dir>')
        expect(result.reason).toContain('definitely-missing-npm-binary-4f8c2e')
        expect(result.reason).toContain(PUBLISH_NOTE)
      }
    } finally {
      await rm(result.packRoot, { recursive: true, force: true })
    }
  })

  test('a missing dsh binary throws from the probe spawn — the same named install skip, pack root removed', async () => {
    const result = await packAndProbe({ ...baseArgs(), npmBin: npmFixture, dshBin: 'definitely-missing-dsh-binary-4f8c2e' })
    try {
      expect(result.ok).toBe(false)
      expect(existsSync(result.packRoot)).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain('local artifact install failed (dsh plugin --profile web add file:<tarball>')
        expect(result.reason).toContain('definitely-missing-dsh-binary-4f8c2e')
        expect(result.reason).toContain(PUBLISH_NOTE)
      }
    } finally {
      await rm(result.packRoot, { recursive: true, force: true })
    }
  })

  test('a hung npm returns the named pack skip within the spawn timeout, pack root removed', async () => {
    const hungNpm = join(fixtureRoot, 'npm-hung.js')
    await writeFile(hungNpm, `#!/usr/bin/env bun
await new Promise(() => {})
`)
    await chmod(hungNpm, 0o755)
    const result = await packAndProbe({ ...baseArgs(), npmBin: hungNpm, spawnTimeoutMs: 500 })
    try {
      expect(result.ok).toBe(false)
      expect(existsSync(result.packRoot)).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain('local artifact pack failed')
        expect(result.reason).toContain(PUBLISH_NOTE)
      }
    } finally {
      await rm(result.packRoot, { recursive: true, force: true })
    }
  }, { timeout: 15_000 })

  test('a pack report naming a path outside the pack root is rejected as a malformed report', async () => {
    const traversalNpm = join(fixtureRoot, 'npm-traversal.js')
    await writeFile(traversalNpm, `#!/usr/bin/env bun
console.log(JSON.stringify([{ filename: '../../evil.tgz' }]))
`)
    await chmod(traversalNpm, 0o755)
    const result = await packAndProbe({ ...baseArgs(), npmBin: traversalNpm })
    try {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('no filename in the pack report')
    } finally {
      await rm(result.packRoot, { recursive: true, force: true })
    }
  })

  test('a pack report naming the bare parent .. is rejected as a malformed report', async () => {
    const dotdotNpm = join(fixtureRoot, 'npm-dotdot.js')
    await writeFile(dotdotNpm, `#!/usr/bin/env bun
console.log(JSON.stringify([{ filename: '..' }]))
`)
    await chmod(dotdotNpm, 0o755)
    const result = await packAndProbe({ ...baseArgs(), npmBin: dotdotNpm })
    try {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain('no filename in the pack report')
    } finally {
      await rm(result.packRoot, { recursive: true, force: true })
    }
  })

  test('the successful path hands the pack root to the caller untouched', async () => {
    const result = await packAndProbe({ ...baseArgs(), npmBin: npmFixture, dshBin: dshFixture })
    if (!result.ok) throw new Error(`expected a successful probe with fixture binaries, got skip: ${result.reason}`)
    const packRoot = result.packRoot
    try {
      expect(existsSync(result.tarball)).toBe(true)
      expect(existsSync(packRoot)).toBe(true)
    } finally {
      await rm(packRoot, { recursive: true, force: true })
    }
    expect(existsSync(packRoot)).toBe(false)
  })
})
