/**
 * Task 1 — installed-deployment e2e (plan `20260817-dsh-roles-e2e`): the
 * REAL user install loop, closed end to end.
 *
 * Pipeline:
 *   1. skip-guard — `dsh` bin on PATH + registry reachability. A missing
 *      prerequisite SKIPS with the reason printed (never a silent green);
 *      a skip is NOT AC-3 evidence.
 *   2. Temp `DSH_HOME`; the REAL CLI (`packages/cli` `init --target dsh`)
 *      installs both plugin rows (`@mstar-harness/dsh` + `dsh-llm-fallbacks`)
 *      through the dsh profile surface (`dsh plugin --profile web add …`).
 *   3. Installed-state probe: `--dump-config` rows + the installed package
 *      layout (node-linker hoisted, `autoInstallPeers: false` — peers are
 *      NOT materialized; the host provides the seam packages, exactly the
 *      production topology this boot mirrors).
 *   4. Single-instance invariant (HARD): the installed artifact's
 *      build-external bare imports (`@deepseek-ai/cordis`,
 *      `@deepseek-ai/dsh-skill-filesystem`, `@deepseek-ai/dsh-llm`,
 *      `@deepseek-ai/dsh-tools`; `dsh-llm-fallbacks` imports
 *      `@deepseek-ai/cordis` via `@deepseek-ai/dsh-settings` /
 *      `@deepseek-ai/dsh-typert-protocol` / `@deepseek-ai/schemastery`)
 *      MUST resolve to the test-process instances — the test process IS
 *      the host. Mechanism: a real-directory copy of the installed
 *      packages under `<repo>/node_modules/.mstar-e2e/<run>/` so the
 *      bare-import walk-up reaches the repo's `node_modules` (the same
 *      physical modules the test process loaded). Symlinks would realpath
 *      back into the pnpm store (a SECOND cordis instance); `Bun.plugin`
 *      onResolve is build-time only (probed 2026-08-17) — the copy is the
 *      runtime-verified redirect.
 *   5. `bootApp` composes the REAL dsh app shape in the profile entry-list
 *      order (mstar row first, fallbacks row second — probed on dsh
 *      0.1.0-rc.6): the seeds inject child arms at mstar apply and fires
 *      when the fallbacks service appears. The `settings` seam (the real
 *      app's `dsh-settings-file` row) is the structural fake — the real
 *      fallbacks seed manager persists materialized roles through it.
 *   6. The HOST config-stack re-composition is modeled (the real app's
 *      HMR/typert path): the fallbacks effective readback reads the row
 *      config captured at apply time, so after the seed write the host
 *      re-applies the row with the settings-derived config; one
 *      `subagent/start` decision point then re-runs the advisory's
 *      merge-preserve re-declare and the effective taxonomy converges.
 *   7. Seeds convergence is awaited (the existing decision-point /
 *      advisory waitFor pattern, polled on the effective readback).
 *   8. Assertions derive the expected id set from the INSTALLED artifact's
 *      `harness-agents` mirror via `subagentRoleIds()` — never a hardcoded
 *      list — and pin the plan's 13-role closure claim as a lower bound.
 *
 * AC-3 evidence: a NON-skip PASS of this spec (recorded in the SDD
 * report); CI runs dsh tests, but this spec SKIPS there — no `dsh` bin
 * on the runner PATH (skip-guard below; the registry probe would pass).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootApp, startInfo, type BootResult, type FakeSettingsRegistry } from './harness.ts'
import { fallbacksService } from '../src/gates/fallbacks-probe.ts'
import { subagentRoleIds } from '../src/gates/agent-personas.ts'
import { packageRoot } from '../scripts/bundle-harness-assets.ts'

/** Repo root (packages/dsh/tests → up three levels). */
const REPO_ROOT = resolve(import.meta.dir, '../../..')
/** The real CLI entry (plan 001 surface) run as a subprocess. */
const CLI_ENTRY = join(REPO_ROOT, 'packages/cli/src/index.ts')
/** The repo's own build mirror (synced by bundle-assets; gitignored). */
const LOCAL_MIRROR = join(packageRoot, 'harness-agents')
/** The profile the dsh CLI fixes for installs (dsh adapter `web`). */
const DSH_PROFILE = 'web'
/** Skip-guard probe: `dsh` bin on PATH + npm registry reachability (the
 * `dsh plugin add` flow forwards to pnpm over the network). Module scope —
 * the describe is skipped when either fails, with the reason printed. */
const skipReason = await (async (): Promise<string | undefined> => {
  // Bun.spawnSync throws ENOENT when the executable is missing — must be
  // caught, or the skip-guard itself crashes the suite (CI has no dsh bin).
  let dshProbe: { exitCode: number } | undefined
  try {
    dshProbe = Bun.spawnSync(['dsh', '--version'], { stdout: 'pipe', stderr: 'pipe' })
  } catch {
    return 'dsh CLI not found on PATH (install @deepseek-ai/dsh first)'
  }
  if (dshProbe.exitCode !== 0) return 'dsh CLI not found on PATH (install @deepseek-ai/dsh first)'
  try {
    const response = await fetch('https://registry.npmjs.org/@mstar-harness%2Fdsh/latest', {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return `npm registry probe failed (HTTP ${response.status})`
  } catch (error) {
    return `npm registry unreachable (${error instanceof Error ? error.message : String(error)})`
  }
  return undefined
})()

/** Spawn env with ambient harness vars pinned out (CLI-test convention)
 * and `DSH_HOME` forced to the temp profile root. */
function dshEnv(dshHome: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'MSTAR_HARNESS_DIR' || key === 'MSTAR_CONTROL_ROOT' || key === 'SDD_DIR' || key === 'MSTAR_WORKING_BRANCH') continue
    if (value !== undefined) env[key] = value
  }
  env.DSH_HOME = dshHome
  return env
}

/** Run one dsh CLI command under the temp home; returns stdout on exit 0. */
function runDsh(dshHome: string, args: string[], timeoutMs = 120_000): string {
  const proc = Bun.spawnSync(['dsh', ...args], {
    env: dshEnv(dshHome),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  })
  const stdout = proc.stdout.toString()
  if (proc.exitCode !== 0) {
    throw new Error(`dsh ${args.join(' ')} failed (${proc.exitCode}): ${stdout}\n${proc.stderr.toString()}`)
  }
  return stdout
}

/** Run the REAL CLI `init --target dsh` (plan 001 surface) as a subprocess. */
function runCliInit(dshHome: string, timeoutMs = 300_000): string {
  const proc = Bun.spawnSync([process.execPath, 'run', CLI_ENTRY, 'init', '--target', 'dsh'], {
    cwd: join(REPO_ROOT, 'packages/cli'),
    env: dshEnv(dshHome),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  })
  const stdout = proc.stdout.toString()
  if (proc.exitCode !== 0) {
    throw new Error(`mstar-harness init --target dsh failed (${proc.exitCode}): ${stdout}\n${proc.stderr.toString()}`)
  }
  return stdout
}

const profileDir = (dshHome: string) => join(dshHome, 'profiles', DSH_PROFILE)
/** The installed package dirs under the hoisted profile node_modules. */
const installedMstarDir = (dshHome: string) => join(profileDir(dshHome), 'node_modules/@mstar-harness/dsh')
const installedFallbacksDir = (dshHome: string) => join(profileDir(dshHome), 'node_modules/dsh-llm-fallbacks')

/** The seeds surface the B4 mechanism ships: the bundled seeds wiring in
 * `dist/index.js` (the gates compile INTO the single-file bundle; the
 * per-file `dist/gates/*.d.ts` stubs carry no runtime code) + the packaged
 * `harness-agents` mirror. The string marker survives the bundle build. */
function hasSeedsSurface(mstarPkgDir: string): boolean {
  const distIndex = join(mstarPkgDir, 'dist/index.js')
  if (!existsSync(distIndex) || !existsSync(join(mstarPkgDir, 'harness-agents'))) return false
  return readFileSync(distIndex, 'utf8').includes('mstar seeds declared')
}

/** Read the `version` field of a package.json (package manifests are
 * outside-controlled data — narrow the parsed shape before access). */
async function readVersion(pkgJsonPath: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(pkgJsonPath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error(`package.json at ${pkgJsonPath} carries no string version field`)
  }
  return parsed.version
}

/** Poll until `predicate` — the seeds/decision-point waitFor pattern. */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor[${label}] timed out`)
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 25)
    await promise
  }
}

/** The `roles.list` the fallbacks seed manager persisted through the
 * settings seam (the `fallbacks` namespace), narrowed from the seam store.
 * `undefined` until the first seed declaration lands. */
function settingsRolesList(): unknown[] | undefined {
  return settingsRolesPayload()?.list
}

/** The narrowed `{ list, rules }` roles payload from the settings seam. */
function settingsRolesPayload(): { list: unknown[]; rules: unknown[] } | undefined {
  const settings = booted?.ctx.get('settings') as FakeSettingsRegistry | undefined
  if (settings === undefined) return undefined
  const raw = settings.get('fallbacks')
  if (typeof raw !== 'object' || raw === null || !('roles' in raw)) return undefined
  const roles = raw.roles
  if (typeof roles !== 'object' || roles === null || !('list' in roles) || !('rules' in roles)) return undefined
  if (!Array.isArray(roles.list) || !Array.isArray(roles.rules)) return undefined
  return { list: roles.list, rules: roles.rules }
}

let booted: BootResult | undefined
let dshHome: string | undefined
let hostCopyRoot: string | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
  if (dshHome !== undefined) await rm(dshHome, { recursive: true, force: true })
  dshHome = undefined
  if (hostCopyRoot !== undefined) await rm(hostCopyRoot, { recursive: true, force: true })
  hostCopyRoot = undefined
})

describe.skipIf(skipReason !== undefined)('installed-deployment e2e (plan 20260817-dsh-roles-e2e Task 1)', () => {
  test('CLI install → installed-artifact boot → 13 mstar roles seeded (AC-3)', async () => {
    // 1. skip-guard reason (module scope already probed; the describe is
    //    skipped when it failed — printing here keeps the output explicit).
    console.log(`install-e2e: skip-guard probe ok (dsh bin + registry reachable)`)

    // 2. Temp DSH_HOME + the REAL CLI install (user path closure).
    dshHome = await mkdtemp(join(tmpdir(), 'dsh-e2e-home-'))
    const cliOut = runCliInit(dshHome)
    for (const line of cliOut.split('\n').filter((line) => line.trim() !== '')) console.log(`install-e2e: cli | ${line}`)

    // 3. Installed-state probe: dump-config rows + layout facts.
    const dump = runDsh(dshHome, ['--profile', DSH_PROFILE, '--dump-config'], 30_000)
    console.log(`install-e2e: dump-config rows: ${(dump.match(/^  name:/gm) ?? []).length}`)
    expect(dump).toContain(`name: '@mstar-harness/dsh'`)
    expect(dump).toContain('name: dsh-llm-fallbacks')
    // Layout probe: peers NOT materialized (profile pnpm-workspace.yaml
    // sets autoInstallPeers: false) — the host provides the seam packages.
    const peersDir = join(profileDir(dshHome), 'node_modules/@deepseek-ai')
    console.log(`install-e2e: peers materialized under DSH_HOME profile: ${existsSync(peersDir)} (host provides seams)`)

    // 4. Version/surface probe of the DEFAULT install. The dsh CLI pins
    //    `^2.2.0` in the profile manifest; pnpm's minimumReleaseAge gate
    //    excludes fresh publishes (< ~1 day) from RANGE resolution, so the
    //    default add can land on a version without the seeds surface. When
    //    that happens, re-add pinned to the repo's shipped version (the
    //    explicit version bypasses the age gate — the default path
    //    converges once the publish passes the window). Recorded as a
    //    deviation in the SDD report; never a silent skip.
    const installedVersion = await readVersion(join(installedMstarDir(dshHome), 'package.json'))
    if (!hasSeedsSurface(installedMstarDir(dshHome))) {
      const repoVersion = await readVersion(join(packageRoot, 'package.json'))
      console.log(`install-e2e: default add installed @mstar-harness/dsh@${installedVersion} WITHOUT the seeds surface — re-adding pinned @${repoVersion} (pnpm minimumReleaseAge range-resolution gate)`)
      runDsh(dshHome, ['plugin', '--profile', DSH_PROFILE, 'add', `@mstar-harness/dsh@${repoVersion}`], 300_000)
      const pinned = await readVersion(join(installedMstarDir(dshHome), 'package.json'))
      expect(pinned).toBe(repoVersion)
      expect(hasSeedsSurface(installedMstarDir(dshHome))).toBe(true)
      // Post-pin dump probe (fix wave S-002 belt-and-suspenders): the
      // re-add must not duplicate a loader row — exactly one mstar row
      // and one fallbacks row, the production dump shape.
      const pinnedDump = runDsh(dshHome, ['--profile', DSH_PROFILE, '--dump-config'], 30_000)
      expect((pinnedDump.match(/name: '@mstar-harness\/dsh'/g) ?? []).length, 'exactly one mstar loader row after pinned re-add').toBe(1)
      expect((pinnedDump.match(/name: dsh-llm-fallbacks/g) ?? []).length, 'exactly one fallbacks loader row after pinned re-add').toBe(1)
      console.log(`install-e2e: pinned add installed @mstar-harness/dsh@${pinned} with the full seeds surface`)
    } else {
      console.log(`install-e2e: default add installed @mstar-harness/dsh@${installedVersion} WITH the seeds surface — no pin needed`)
    }

    // 5. Single-instance resolution: copy the installed packages into the
    //    host module graph (real dirs, NOT symlinks — see header comment)
    //    so their bare imports resolve to the test-process instances.
    hostCopyRoot = join(REPO_ROOT, 'node_modules/.mstar-e2e', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const mstarCopy = join(hostCopyRoot, 'dsh')
    const fallbacksCopy = join(hostCopyRoot, 'fallbacks')
    await mkdir(mstarCopy, { recursive: true })
    await mkdir(fallbacksCopy, { recursive: true })
    await cp(installedMstarDir(dshHome), mstarCopy, { recursive: true })
    await cp(installedFallbacksDir(dshHome), fallbacksCopy, { recursive: true })
    // Resolution cross-check (the invariant, pinned at the module level):
    // both dists must resolve cordis to the SAME physical file the test
    // process uses.
    const hostCordis = Bun.resolveSync('@deepseek-ai/cordis', import.meta.dir)
    const mstarCordis = Bun.resolveSync('@deepseek-ai/cordis', join(mstarCopy, 'dist/index.js'))
    const fallbacksCordis = Bun.resolveSync('@deepseek-ai/cordis', join(fallbacksCopy, 'dist/index.js'))
    expect(mstarCordis).toBe(hostCordis)
    expect(fallbacksCordis).toBe(hostCordis)
    console.log(`install-e2e: cordis resolved for installed dists: ${basename(hostCordis)} (single instance — ${mstarCordis === hostCordis && fallbacksCordis === hostCordis})`)

    // 6. Boot the INSTALLED artifact composition: mstar row first, then the
    //    fallbacks row — the real profile entry-list order (probed on dsh
    //    0.1.0-rc.6), so the seeds inject child arms at mstar apply and
    //    fires when the fallbacks service appears. Runtime-selected module
    //    specifiers: the installed dist paths are only known after the real
    //    install — static imports cannot name them.
    const pluginModule = await import(pathToFileURL(join(mstarCopy, 'dist/index.js')).href)
    const fallbacksModule = await import(pathToFileURL(join(fallbacksCopy, 'dist/index.js')).href)
    // The real dsh app always composes the `dsh-settings-file` row before
    // the plugin layers — the fallbacks `declareSeeds` writes its seed
    // registry through the `settings` service (without it, `writeRoles`
    // throws `seedsSettingsUnavailable` and no seed can land). The test
    // process is the host, so the settings seam is the structural fake
    // (same philosophy as the loader/jobs/agents/sessions fakes).
    booted = await bootApp({ pluginModule, fallbacksModule, settingsService: 'fake' })
    // The installed plugin resolves its OWN packaged mirror (package-
    // relative from the copied dist) — the runtime source of truth.
    const artifactMirror = join(mstarCopy, 'harness-agents')
    const expectedIds = subagentRoleIds(artifactMirror)
    expect(expectedIds.length).toBeGreaterThanOrEqual(13) // plan closure claim; derived, grows with the mirror
    console.log(`install-e2e: installed mirror yields ${expectedIds.length} subagent role ids (${expectedIds.join(', ')})`)
    if (existsSync(LOCAL_MIRROR)) {
      const localIds = subagentRoleIds(LOCAL_MIRROR)
      console.log(`install-e2e: local build mirror yields ${localIds.length} ids — installed artifact taxonomy ${JSON.stringify([...expectedIds].sort()) === JSON.stringify([...localIds].sort()) ? 'matches' : `DIFFERS (local only: ${localIds.filter((id) => !expectedIds.includes(id)).join(', ')})`}`)
    }

    // 7. Durable seed write: the mstar inject child declares the mirror-
    //    derived batch through the REAL fallbacks seed manager, which
    //    materializes the rows and persists them via the settings seam
    //    (the real app's `dsh-settings-file` namespace).
    await waitFor('seeds-settings', () => {
      const list = settingsRolesList()
      if (list === undefined) return false
      return expectedIds.every((id) => list.some((row) => typeof row === 'object' && row !== null && 'id' in row && row.id === id))
    })
    console.log('install-e2e: seed declaration persisted via the settings seam (all mstar ids)')

    // 8. Host config-stack re-composition (the real dsh app's HMR/typert
    //    config path): the fallbacks effective readback reads the row
    //    config captured at apply time; the real host re-composes the row
    //    from the settings store and re-applies it. Model that: dispose
    //    the fallbacks fiber and re-apply with the settings-derived
    //    config. The mstar inject child re-fires on the re-apply and
    //    re-declares (idempotent).
    const rolesPayload = settingsRolesPayload()
    expect(rolesPayload, 'settings payload carries the materialized roles').toBeDefined()
    await booted.fallbacksFiber!.dispose()
    const composed: Record<string, unknown> = { ...fallbacksModule.defaultFallbacksConfig, roles: rolesPayload }
    await booted.ctx.plugin(fallbacksModule, composed)
    console.log('install-e2e: fallbacks row re-applied with the settings-derived config (host re-composition)')

    // 9. Decision-point convergence: one `subagent/start` emit models a
    //    real dispatch — the advisory one-shot latch (reset by the
    //    fallbacks teardown) re-runs the merge-preserve re-declare, so the
    //    effective taxonomy converges deterministically (the preset ↔
    //    mstar declare race on re-apply is absorbed).
    booted.ctx.events.emit('subagent/start', startInfo('e2e-convergence'))

    // 10. Seeds convergence on the effective readback (the existing
    //     waitFor pattern).
    await waitFor('seeds', () => {
      const service = fallbacksService(booted!.ctx)
      if (service === undefined) return false
      const rows = service.getEffectiveRoles().roles
      return expectedIds.every((id) => rows.some((row) => row.id === id && row.seeded))
    })

    // 11. Effective-taxonomy assertions: every derived id seeded, persona
    //     non-empty (same source as the decoration), defaults not
    //     overridden.
    const readback = fallbacksService(booted!.ctx)!.getEffectiveRoles()
    const byId = new Map(readback.roles.map((row) => [row.id, row]))
    for (const id of expectedIds) {
      const row = byId.get(id)
      expect(row, `effective role row for ${id}`).toBeDefined()
      expect(row!.seeded, `seeded source for ${id}`).toBe(true)
      expect(row!.persona?.trim(), `persona non-empty for ${id}`).not.toBe('')
      expect(row!.seedPersona?.trim(), `seedPersona non-empty for ${id}`).not.toBe('')
      expect(row!.personaOverridden, `default persona for ${id}`).toBe(false)
    }
    console.log(`install-e2e: effective roles PASS — ${expectedIds.length} mstar ids seeded with non-empty personas (total effective rows: ${readback.roles.length})`)
  }, { timeout: 600_000 })
})

// The skip-guard reason (module scope): printed ALWAYS so a skipped run is
// explicit in the output, never a silent green.
if (skipReason !== undefined) {
  console.log(`install-e2e: SKIPPED — ${skipReason}`)
}
