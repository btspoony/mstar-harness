/**
 * Task 1 — installed-deployment e2e  the
 * REAL user install loop, closed end to end.
 *
 *   1. skip-guard — three prerequisites: `dsh` bin on PATH, registry
 *      reachability for the `init` and `dsh-llm-fallbacks` rows, and a
 *      current local `@mstar-harness/dsh` build that packs and installs
 *      by `file:`. A missing prerequisite SKIPS with the reason printed
 *      (never a silent green); a skip is NOT AC-3 evidence.
 *   2. Temp `DSH_HOME`; the REAL CLI (`packages/cli` `init --target dsh`)
 *      installs both plugin rows (`@mstar-harness/dsh` + `dsh-llm-fallbacks`)
 *      through the dsh profile surface (`dsh plugin --profile web add …`),
 *      then the locally packed tarball overwrites the registry
 *      `@mstar-harness/dsh` row — the deployment under test is the local
 *      build, never the registry build.
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
 *      fallbacks seed manager persists materialized roles through it. The
 *      real app also composes the subagent seam before the plugin layers
 *      (its runtime injects the `agents` service) — mounted here as the
 *      harness's fake `subagents` service, so the shipped-surface
 *      role-preset probe (5b) reads the same `ctx.subagents` value the
 *      artifact's channel intercepts.
 *   5b. Shipped-surface role-preset probe (plan Task 2): from the inject
 *       scope the real tool-subagent reads through, a temporary canary must
 *       dispatch the installed artifact's `internal/get` waterfall AND the
 *       read must resolve to the branded wrapper — the probe contract
 *       (`probeRolePersonaSeam`'s branded-`ok` inputs) proven ON the
 *       installed deployment. The artifact bundle keeps the entry's frozen
 *       export surface (no probe symbol exported), so the pin observes the
 *       probe's contract structurally: canary dispatch + brand stamp +
 *       unchanged wrapper key surface.
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
 *      list; the seed-convergence steps below assert every derived id.
 *
 * AC-3 evidence: a NON-skip PASS of this spec (recorded in the SDD
 * report); CI runs dsh tests, but this spec SKIPS there — no `dsh` bin
 * on the runner PATH (skip-guard below; the registry probe would pass).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load as parseYaml } from 'js-yaml'
import { bootApp, startInfo, type BootResult, type FakeSettingsRegistry } from './harness.ts'
import { fallbacksService } from '../src/gates/fallbacks-probe.ts'
import { subagentRoleIds } from '../src/gates/agent-personas.ts'
import { PERSONA_SEAM_EVENT } from '../src/gates/role-persona.ts'
import { checkHostBuild, HOST_BUILD_RECOVERY } from '../scripts/build-host.ts'
import { packageRoot } from '../scripts/bundle-harness-assets.ts'
import { packAndProbe } from './install-e2e-pack-probe.ts'

/** Repo root (packages/dsh/tests → up three levels). */
const REPO_ROOT = resolve(import.meta.dir, '../../..')
/** The real CLI entry (plan 001 surface) run as a subprocess. */
const CLI_ENTRY = join(REPO_ROOT, 'packages/cli/src/index.ts')
/** why: Neutral cwd for CLI subprocesses: harness resolution must answer from the
 * disposable home, never from the ambient control checkout's own `.mstarc`. The
 * cwd is itself a declared git repo, or the init bootstrap's upward identity
 * probe escapes it and writes a `.mstarc` into `$TMPDIR` itself. */
const cliCwd = mkdtempSync(join(tmpdir(), 'dsh-cli-cwd-'))
execFileSync('git', ['init', '-q', '-b', 'main', cliCwd], { stdio: 'ignore' })
writeFileSync(join(cliCwd, '.mstarc'), `[collaboration]\nmode=local\nrepo_id=dsh-cli-cwd-${cliCwd.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(-110)}\n`)
/** The repo's own build mirror (synced by bundle-assets; gitignored). */
const LOCAL_MIRROR = join(packageRoot, 'harness-agents')
/** The profile the dsh CLI fixes for installs (dsh adapter `web`). */
const DSH_PROFILE = 'web'
// see scripts/ci-packed-manifest-guard.ts — the pack below uses `npm pack`
// because a `workspace:` spec makes `bun pm pack` throw. `packRoot` and
// `localTarball` are declared BEFORE the guard: a `let` beside the
// booted/dshHome state would still be in its TDZ while the awaited guard runs.
let packRoot: string | undefined
let localTarball: string | undefined
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
  const buildCheck = checkHostBuild()
  if (buildCheck.state !== 'current') {
    return `${buildCheck.input} is ${buildCheck.state} for packages/dsh/dist/index.js — run \`${HOST_BUILD_RECOVERY}\` first`
  }
  const repoVersion = await readVersion(join(packageRoot, 'package.json'))
  const result = await packAndProbe({ packageRoot, repoVersion, profile: DSH_PROFILE, env: dshEnv })
  if (!result.ok) return result.reason
  packRoot = result.packRoot
  localTarball = result.tarball
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
    cwd: cliCwd,
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

/** see packages/dsh/src/gates/role-persona.ts - the warn marker here is a
 * verbatim prefix of `SEAM_WARN`; rewording `SEAM_WARN` breaks this match,
 * so change both strings (and the f9/f10 warn pins in
 * `tests/persona-seam-probe.spec.ts`) in the same edit. */
function hasSeamProbeSurface(mstarPkgDir: string): boolean {
  const distIndex = join(mstarPkgDir, 'dist/index.js')
  if (!existsSync(distIndex)) return false
  const dist = readFileSync(distIndex, 'utf8')
  return dist.includes('role persona channel not installed') && dist.includes('startActivation')
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
 * settings seam (the `llm-fallbacks` profile-entry namespace — the
 * `SettingsForms` mutate target), narrowed from the seam store.
 * `undefined` until the first seed declaration lands. */
function settingsRolesList(): unknown[] | undefined {
  return settingsRolesPayload()?.list
}

/** The narrowed `{ list }` roles payload from the settings seam (0.8.x persists only the list). */
function settingsRolesPayload(): { list: unknown[] } | undefined {
  const settings = booted?.ctx.get('settings') as FakeSettingsRegistry | undefined
  if (settings === undefined) return undefined
  const raw = settings.get('llm-fallbacks')
  if (typeof raw !== 'object' || raw === null || !('roles' in raw)) return undefined
  const roles = raw.roles
  if (typeof roles !== 'object' || roles === null || !('list' in roles)) return undefined
  if (!Array.isArray(roles.list)) return undefined
  return { list: roles.list }
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
  if (packRoot !== undefined) await rm(packRoot, { recursive: true, force: true })
  packRoot = undefined
})

describe.skipIf(skipReason !== undefined)('installed-deployment e2e ', () => {
  test('CLI install → installed-artifact boot → the mstar roles seeded (AC-3)', async () => {
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

    runDsh(dshHome, ['plugin', '--profile', DSH_PROFILE, 'add', `file:${localTarball}`], 300_000)
    const installedVersion = await readVersion(join(installedMstarDir(dshHome), 'package.json'))
    const repoVersion = await readVersion(join(packageRoot, 'package.json'))
    expect(installedVersion).toBe(repoVersion)
    expect(hasSeedsSurface(installedMstarDir(dshHome))).toBe(true)
    const profileManifest: unknown = JSON.parse(readFileSync(join(profileDir(dshHome), 'package.json'), 'utf8'))
    let mstarSpec: string | undefined
    if (typeof profileManifest === 'object' && profileManifest !== null && 'dependencies' in profileManifest) {
      const deps = profileManifest.dependencies
      if (typeof deps === 'object' && deps !== null && '@mstar-harness/dsh' in deps && typeof deps['@mstar-harness/dsh'] === 'string') {
        mstarSpec = deps["@mstar-harness/dsh"]
      }
    }
    expect(mstarSpec, 'profile manifest carries a string @mstar-harness/dsh spec').toBeDefined()
    expect(resolve(mstarSpec!.replace(/^file:/, '')), 'the installed row resolves to this invocation’s tarball').toBe(resolve(localTarball!))
    const lockText = readFileSync(join(profileDir(dshHome), 'pnpm-lock.yaml'), 'utf8')
    expect(lockText.includes(`specifier: file:${localTarball}`), 'the lockfile records this invocation’s tarball as the mstar specifier').toBe(true)
    const lockParsed: unknown = parseYaml(lockText)
    let lockVersion: string | undefined
    if (typeof lockParsed === 'object' && lockParsed !== null && 'importers' in lockParsed && typeof lockParsed.importers === 'object' && lockParsed.importers !== null && '.' in lockParsed.importers) {
      const rootImporter: unknown = lockParsed.importers['.']
      if (typeof rootImporter === 'object' && rootImporter !== null && 'dependencies' in rootImporter && typeof rootImporter.dependencies === 'object' && rootImporter.dependencies !== null && '@mstar-harness/dsh' in rootImporter.dependencies) {
        const mstarEntry: unknown = rootImporter.dependencies['@mstar-harness/dsh']
        if (typeof mstarEntry === 'object' && mstarEntry !== null && 'version' in mstarEntry && typeof mstarEntry.version === 'string') {
          lockVersion = mstarEntry.version
        }
      }
    }
    expect(lockVersion, 'the lockfile records a resolved mstar version').toBeDefined()
    expect(resolve(profileDir(dshHome), lockVersion!.replace(/^file:/, '')), 'the lockfile resolution points at this invocation’s tarball').toBe(resolve(localTarball!))
    const pinnedDump = runDsh(dshHome, ['--profile', DSH_PROFILE, '--dump-config'], 30_000)
    expect((pinnedDump.match(/name: '@mstar-harness\/dsh'/g) ?? []).length, 'exactly one mstar loader row after the local overwrite').toBe(1)
    expect((pinnedDump.match(/name: dsh-llm-fallbacks/g) ?? []).length, 'exactly one fallbacks loader row after the local overwrite').toBe(1)

    const probeSurfaceArmed = hasSeamProbeSurface(installedMstarDir(dshHome))
    expect(probeSurfaceArmed, 'the locally packed artifact carries the role-preset channel surface').toBe(true)
    console.log('install-e2e: role-preset channel surface PRESENT on the locally packed artifact — 5b assertion armed')

    // 5. Single-instance resolution: copy the installed packages into the
    //    host module graph (real dirs, NOT symlinks — see header comment)
    //    so their bare imports resolve to the test-process instances.
    hostCopyRoot = join(packageRoot, 'node_modules/.mstar-e2e', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
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
    // (same philosophy as the loader/jobs/agents/sessions fakes). The real
    // dsh app also composes the subagent seam before the plugin layers (its
    // runtime injects the `agents` service) — mounted here as the harness's
    // fake `subagents` service so the shipped-surface role-preset probe
    // below observes the artifact's channel intercept on the `subagents`
    // reads.
    booted = await bootApp({ pluginModule, fallbacksModule, settingsService: 'fake', agentsService: 'fake', subagents: 'fake' })
    // The installed plugin resolves its OWN packaged mirror (package-
    // relative from the copied dist) — the runtime source of truth.
    const artifactMirror = join(mstarCopy, 'harness-agents')
    const expectedIds = subagentRoleIds(artifactMirror)
    console.log(`install-e2e: installed mirror yields ${expectedIds.length} subagent role ids (${expectedIds.join(', ')})`)
    if (existsSync(LOCAL_MIRROR)) {
      const localIds = subagentRoleIds(LOCAL_MIRROR)
      console.log(`install-e2e: local build mirror yields ${localIds.length} ids — installed artifact taxonomy ${JSON.stringify([...expectedIds].sort()) === JSON.stringify([...localIds].sort()) ? 'matches' : `DIFFERS (local only: ${localIds.filter((id) => !expectedIds.includes(id)).join(', ')})`}`)
    }

    // 5b. Shipped-surface seam probe (armed by 4b): the INSTALLED
    //     artifact's role-preset channel intercepts `subagents` reads on the
    //     booted host composition — the branded-`ok` inputs of
    //     `probeRolePersonaSeam` (canary dispatch + branded wrapper),
    //     exercised from the same inject scope the real tool-subagent reads
    //     through. The artifact bundle keeps the entry's frozen export
    //     surface (no probe symbol is re-exported), so the pin observes the
    //     contract structurally; the canary registers on the exported
    //     PERSONA_SEAM_EVENT constant, so a seam-constant drift silences
    //     the canary and fails here.
    if (probeSurfaceArmed) {
      const probed = Promise.withResolvers<{ dispatched: boolean; wrapper: unknown }>()
      void booted!.ctx.inject(['subagents'], (sctx) => {
        // Guarded: the inject callback is fire-and-forget (`void`), so a
        // throw here would leave `probed` unsettled and the await below
        // would time out instead of failing as an assertion — the body
        // computes first, resolves once complete, rejects on any throw
        // (the canary disposer still runs via its own finally).
        try {
          let dispatched = false
          const disposeCanary = sctx.on(PERSONA_SEAM_EVENT, (_readCtx, _name, _error, next) => {
            dispatched = true
            return next()
          })
          let wrapper: unknown
          try {
            wrapper = (sctx as unknown as { subagents?: unknown }).subagents
          } finally {
            disposeCanary()
          }
          probed.resolve({ dispatched, wrapper })
        } catch (error) {
          probed.reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
      const { dispatched, wrapper } = await probed.promise
      expect(dispatched, 'internal/get waterfall dispatches on the installed composition').toBe(true)
      expect(wrapper, 'the controlled read resolves a value').toBeDefined()
      const brand = Object.getOwnPropertySymbols(wrapper as object)
      expect(brand, 'the artifact wrapper carries exactly one brand symbol').toHaveLength(1)
      expect((wrapper as Record<symbol, unknown>)[brand[0]!], 'brand value').toBe(true)
      expect(Object.getOwnPropertyDescriptor(wrapper as object, brand[0]!)?.enumerable, 'brand non-enumerable').toBe(false)
      expect(Object.keys(wrapper as object).sort(), 'wrapper key surface unchanged').toEqual(['startActivation'])
      console.log('install-e2e: shipped-surface seam probe PASS — canary dispatched, artifact wrapper branded (role-preset channel intercepts reads)')
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
    //     non-empty (the mirror's persona rows), defaults not overridden.
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

if (skipReason !== undefined) {
  console.log(`install-e2e: SKIPPED — ${skipReason}`)
  if (packRoot !== undefined) await rm(packRoot, { recursive: true, force: true })
  packRoot = undefined
}
