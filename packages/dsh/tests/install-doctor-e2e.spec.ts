/**
 * Task 2 — capability three-state closure e2e (plan `20260817-dsh-roles-e2e`):
 * the REAL CLI install/doctor loop across the three install-surface states —
 * `uninstalled` / `disabled` / `mounted` — plus the dsh-plugin degradation
 * semantics per cell. Reuses the Task 1 patterns: skip-guard, temp
 * `DSH_HOME`, real CLI subprocesses, the `--no-fallbacks` install form, the
 * `--dump-config` probe, the single-instance host copy, and
 * installed-artifact boots.
 *
 * The two three-state vocabularies are deliberately NOT conflated:
 *   - CLI doctor (install surface): uninstalled / disabled / mounted
 *   - dsh plugin advisory (runtime): missing / seeded / overridden
 * This spec closes the first end to end; the second is pinned by the
 * src-level specs (fallbacks-advisory.spec.ts (f)/(f2),
 * role-persona.spec.ts (c)) and Task 1's installed-deployment e2e
 * (13 mstar roles seeded — the cell-3 runtime half, cited here).
 *
 * Matrix:
 *   Cell 1 (uninstalled): `init --target dsh --no-fallbacks` → doctor exit 1
 *     `dsh-llm-fallbacks: uninstalled`; dsh side — installed artifact boots
 *     WITHOUT the fallbacks row: fallbacksMounted false, advisory not
 *     invoked (false, zero logs), the native persona channel still merges
 *     the persona from Config (degradation path does not crash).
 *   Cell 2 (disabled): fallbacks row added, disabled via the REAL
 *     `cordis.patch.yml` mechanism → doctor exit 1 `dsh-llm-fallbacks:
 *     disabled`; dsh side — loader entry present (dump carries the disabled
 *     row) but capability off: fallbacksMounted false, advisory false.
 *   Cell 3 (mounted): patch reverted → doctor exit 0, both rows `mounted`,
 *     healthy; runtime seeds = Task 1 e2e (13 roles, cited).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FakeSubagentProvider, bootApp, startViaNativeChannel, type BootResult, type FakeLoaderRegistry } from './harness.ts'
import { FALLBACKS_ENTRY_NAME, fallbacksMounted } from '../src/gates/fallbacks-probe.ts'
import { setAdvisoryLogger, runFallbacksAdvisory, type AdvisoryLogLevel } from '../src/gates/fallbacks-advisory.ts'
import type { SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { packageRoot } from '../scripts/bundle-harness-assets.ts'

/** Repo root (packages/dsh/tests → up three levels). */
const REPO_ROOT = resolve(import.meta.dir, '../../..')
/** The real CLI entry (plan 001 surface) run as a subprocess. */
const CLI_ENTRY = join(REPO_ROOT, 'packages/cli/src/index.ts')
/** The profile the dsh CLI fixes for installs (dsh adapter `web`). */
const DSH_PROFILE = 'web'
/** The mstar plugin spec (doctor capability words). */
const MSTAR_SPEC = '@mstar-harness/dsh'
/** The fallbacks plugin spec (doctor capability words). */
const FALLBACKS_SPEC = 'dsh-llm-fallbacks'

/** Skip-guard probe (Task 1 pattern): `dsh` bin on PATH + registry
 * reachability. A missing prerequisite SKIPS with the reason printed —
 * never a silent green; a skip is not three-state evidence. */
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

/** Spawn env with ambient harness env vars pinned out (CLI-test convention)
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
function runCliInit(dshHome: string, extraArgs: string[] = [], timeoutMs = 300_000): string {
  const proc = Bun.spawnSync([process.execPath, 'run', CLI_ENTRY, 'init', '--target', 'dsh', ...extraArgs], {
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

/** Run the REAL CLI `doctor --target dsh` as a subprocess; returns the exit
 * code AND stdout (issue states exit 1 — the code is part of the evidence).
 * `timeoutMs` bounds the child so a hung CLI surfaces as a kill instead of
 * relying on the outer per-test timeout alone. */
function runCliDoctor(dshHome: string, timeoutMs = 300_000): { exitCode: number | null; stdout: string } {
  const proc = Bun.spawnSync([process.execPath, 'run', CLI_ENTRY, 'doctor', '--target', 'dsh'], {
    cwd: join(REPO_ROOT, 'packages/cli'),
    env: dshEnv(dshHome),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  })
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString() }
}

const profileDir = (dshHome: string) => join(dshHome, 'profiles', DSH_PROFILE)
/** The installed mstar package dir under the hoisted profile node_modules. */
const installedMstarDir = (dshHome: string) => join(profileDir(dshHome), 'node_modules/@mstar-harness/dsh')

/** The seeds surface marker (Task 1 pattern): the bundled seeds wiring in
 * `dist/index.js` + the packaged `harness-agents` mirror. The doctor itself
 * reads only loader rows, but the dsh-side boots exercise the bundled
 * probe/advisory/persona-channel gates — pin the FULL shipped surface so the
 * boot evidence never runs against a seeds-less stale version. */
function hasSeedsSurface(mstarPkgDir: string): boolean {
  const distIndex = join(mstarPkgDir, 'dist/index.js')
  if (!existsSync(distIndex) || !existsSync(join(mstarPkgDir, 'harness-agents'))) return false
  return readFileSync(distIndex, 'utf8').includes('mstar seeds declared')
}

/** Read the `version` field of a package.json (Task 1 pattern). */
async function readVersion(pkgJsonPath: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(pkgJsonPath, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error(`package.json at ${pkgJsonPath} carries no string version field`)
  }
  return parsed.version
}

/** Single-instance host copy of the INSTALLED mstar artifact (Task 1
 * pattern): a real-directory copy under `<repo>/node_modules/.mstar-e2e/` so
 * the dist's bare imports walk up to the repo `node_modules` — the same
 * physical instances the test process loaded. The cordis cross-check pins
 * the invariant for THIS copy. Returns the copy root (parent of `dsh/`). */
async function hostCopyInstalledMstar(dshHome: string): Promise<string> {
  const root = join(REPO_ROOT, 'node_modules/.mstar-e2e', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const copy = join(root, 'dsh')
  await mkdir(copy, { recursive: true })
  await cp(installedMstarDir(dshHome), copy, { recursive: true })
  const hostCordis = Bun.resolveSync('@deepseek-ai/cordis', import.meta.dir)
  const mstarCordis = Bun.resolveSync('@deepseek-ai/cordis', join(copy, 'dist/index.js'))
  expect(mstarCordis).toBe(hostCordis)
  return root
}

/** One mstar-style Assignment prompt (persona-channel fixture pattern). */
const ASSIGNMENT_PROMPT = [
  '**Execute as**: fullstack-dev',
  '**Delegation**: forbidden',
  '**Task category**: logic',
  '',
  'Implement the assigned work.',
].join('\n')

/** The configured persona for `fullstack-dev` (Config source). */
const PERSONA = 'You are a fullstack-dev executor for the Morning Star harness.'

/** A real start request whose prompt text carries `text` (role-persona.spec pattern). */
function startRequest(text: string): SubagentStartRequest {
  return {
    prompt: [{ type: 'text', text }],
    parent: { id: 'parent-fake', session: { id: 'parent-fake' } },
    signal: new AbortController().signal,
  } as unknown as SubagentStartRequest
}

/** A DISABLED fallbacks loader entry (the real profile's loader view for a
 * patched-out row: entry present, `disabled: true`, no service). */
const disabledFallbacksEntry = {
  options: { name: FALLBACKS_ENTRY_NAME, config: {} },
  disabled: true,
  fiber: {},
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

describe.skipIf(skipReason !== undefined)('install-surface doctor three-state e2e (plan 20260817-dsh-roles-e2e Task 2)', () => {
  test('real CLI doctor: uninstalled (--no-fallbacks) / disabled (cordis.patch.yml) / mounted + dsh-side degradation', async () => {
    console.log('install-doctor-e2e: skip-guard probe ok (dsh bin + registry reachable)')

    // --- Setup: temp DSH_HOME; CELL-1 install form: `--no-fallbacks`
    // (the mstar row only — the fallbacks row is uninstalled). ---
    dshHome = await mkdtemp(join(tmpdir(), 'dsh-doctor-home-'))
    const initNoFallbacks = runCliInit(dshHome, ['--no-fallbacks'])
    for (const line of initNoFallbacks.split('\n').filter((line) => line.trim() !== '')) console.log(`install-doctor-e2e: cli(no-fallbacks) | ${line}`)

    // Version/surface pin (Task 1 deviation, reused): the dsh CLI writes the
    // profile dependency as `^2.2.0`; pnpm's minimumReleaseAge gate can land
    // the default add on a seeds-less version. The doctor reads loader rows
    // only, but the dsh-side boots exercise the bundled gates — pin the
    // repo-shipped version when the surface is missing.
    if (!hasSeedsSurface(installedMstarDir(dshHome))) {
      const repoVersion = await readVersion(join(packageRoot, 'package.json'))
      console.log(`install-doctor-e2e: default add lacks the seeds surface — re-adding pinned @${repoVersion} (Task 1 deviation)`)
      runDsh(dshHome, ['plugin', '--profile', DSH_PROFILE, 'add', `${MSTAR_SPEC}@${repoVersion}`], 300_000)
      // Post-pin dump probe (fix wave S-002 belt-and-suspenders): the
      // re-add must not duplicate the mstar loader row (the --no-fallbacks
      // shape keeps exactly one row).
      const pinnedDump = runDsh(dshHome, ['--profile', DSH_PROFILE, '--dump-config'], 30_000)
      expect((pinnedDump.match(/name: '@mstar-harness\/dsh'/g) ?? []).length, 'exactly one mstar loader row after pinned re-add').toBe(1)
    }

    // --- CELL 1: fallbacks uninstalled ---
    {
      const dump = runDsh(dshHome, ['--profile', DSH_PROFILE, '--dump-config'], 30_000)
      expect(dump).toContain(`name: '${MSTAR_SPEC}'`)
      expect(dump).not.toContain('name: dsh-llm-fallbacks')
      const doctor = runCliDoctor(dshHome)
      console.log(`install-doctor-e2e: cell1(uninstalled) doctor exit ${doctor.exitCode}`)
      for (const line of doctor.stdout.split('\n').filter((line) => line.trim() !== '')) console.log(`install-doctor-e2e: cell1 doctor | ${line}`)
      expect(doctor.exitCode).toBe(1)
      expect(doctor.stdout).toContain(`${MSTAR_SPEC}: mounted`)
      expect(doctor.stdout).toContain(`${FALLBACKS_SPEC}: uninstalled`)
      expect(doctor.stdout).toContain(`${FALLBACKS_SPEC} is uninstalled`)

      // dsh side — the `--no-fallbacks` deployment boots WITHOUT the
      // fallbacks row: fallbacksMounted false, the advisory is NOT invoked
      // (false, zero logs), and the native persona channel still merges the
      // persona from the Config source (degradation path never crashes).
      hostCopyRoot = await hostCopyInstalledMstar(dshHome)
      // Dynamic import exception (runtime-selected specifier): the installed
      // dist path is only known after the REAL install — static imports
      // cannot name it (Task 1 pattern).
      const pluginModule = await import(pathToFileURL(join(hostCopyRoot, 'dsh/dist/index.js')).href)
      booted = await bootApp({ pluginModule, agentsService: 'fake', subagents: 'real', rolePersonas: { 'fullstack-dev': PERSONA } })
      const app = booted
      expect(fallbacksMounted(app.ctx)).toBe(false)
      const advisoryLogs: Array<[AdvisoryLogLevel, string]> = []
      const priorAdvisory = setAdvisoryLogger((level, message) => { advisoryLogs.push([level, message]) })
      try {
        expect(await runFallbacksAdvisory(app.ctx, join(hostCopyRoot, 'dsh/harness-agents'))).toBe(false)
        expect(advisoryLogs).toEqual([]) // unmounted → not invoked, no logs
      } finally {
        setAdvisoryLogger(priorAdvisory)
      }
      // Native persona channel: the installed dist registers the
      // `internal/get` wrapper — a role-matched start through a plugin-fiber
      // context merges the persona into the request's `persona` slot.
      const provider = new FakeSubagentProvider('fake-spawn', { personaCapability: true })
      ;(app.ctx.subagents as unknown as SubagentRuntime).registerProvider(provider as never)
      await startViaNativeChannel(app, 'fake-spawn', startRequest(ASSIGNMENT_PROMPT))
      expect(provider.starts[0]!.request.persona).toBe(PERSONA)
      console.log('install-doctor-e2e: cell1 dsh-side — fallbacksMounted false, advisory false (0 logs), persona merged via the native channel (no crash)')
      await app.dispose()
      booted = undefined
      await rm(hostCopyRoot, { recursive: true, force: true })
      hostCopyRoot = undefined
    }

    // --- CELL 2: fallbacks installed then DISABLED via the REAL patch
    // mechanism (cordis.patch.yml — the shape plan 001 probe-pinned). ---
    {
      const initFull = runCliInit(dshHome)
      for (const line of initFull.split('\n').filter((line) => line.trim() !== '')) console.log(`install-doctor-e2e: cli(full) | ${line}`)
      await writeFile(join(profileDir(dshHome), 'cordis.patch.yml'), `- id: llm-fallbacks\n  disabled: true\n`)
      const dump = runDsh(dshHome, ['--profile', DSH_PROFILE, '--dump-config'], 30_000)
      // The loader entry is PRESENT in the composed tree — disabled.
      expect(dump).toContain('name: dsh-llm-fallbacks')
      expect(dump).toContain('  disabled: true')
      const doctor = runCliDoctor(dshHome)
      console.log(`install-doctor-e2e: cell2(disabled) doctor exit ${doctor.exitCode}`)
      for (const line of doctor.stdout.split('\n').filter((line) => line.trim() !== '')) console.log(`install-doctor-e2e: cell2 doctor | ${line}`)
      expect(doctor.exitCode).toBe(1)
      expect(doctor.stdout).toContain(`${MSTAR_SPEC}: mounted`)
      expect(doctor.stdout).toContain(`${FALLBACKS_SPEC}: disabled`)
      expect(doctor.stdout).toContain(`${FALLBACKS_SPEC} is disabled`)

      // dsh side — loader entry present (the dump row above) but the
      // capability is OFF: the probe skips the disabled entry (service
      // absent), so fallbacksMounted is false and the advisory is not
      // invoked. Same semantic the src probe spec pins (c)/(f2) — here
      // against the INSTALLED artifact.
      hostCopyRoot = await hostCopyInstalledMstar(dshHome)
      // Dynamic import exception (runtime-selected specifier): the installed
      // dist path is only known after the REAL install — static imports
      // cannot name it (Task 1 pattern).
      const pluginModule = await import(pathToFileURL(join(hostCopyRoot, 'dsh/dist/index.js')).href)
      booted = await bootApp({ pluginModule, agentsService: 'fake', rolePersonas: { 'fullstack-dev': PERSONA } })
      ;(booted.ctx.get('loader') as FakeLoaderRegistry).entriesList = [disabledFallbacksEntry]
      expect(fallbacksMounted(booted.ctx)).toBe(false)
      const advisoryLogs: Array<[AdvisoryLogLevel, string]> = []
      const priorAdvisory = setAdvisoryLogger((level, message) => { advisoryLogs.push([level, message]) })
      try {
        expect(await runFallbacksAdvisory(booted.ctx, join(hostCopyRoot, 'dsh/harness-agents'))).toBe(false)
        expect(advisoryLogs).toEqual([]) // disabled entry → not invoked, no logs
      } finally {
        setAdvisoryLogger(priorAdvisory)
      }
      console.log('install-doctor-e2e: cell2 dsh-side — loader entry present, capability off (fallbacksMounted false, advisory false)')
      await booted.dispose()
      booted = undefined
      await rm(hostCopyRoot, { recursive: true, force: true })
      hostCopyRoot = undefined
    }

    // --- CELL 3: both rows mounted (patch reverted) ---
    {
      await writeFile(join(profileDir(dshHome), 'cordis.patch.yml'), '[]')
      const dump = runDsh(dshHome, ['--profile', DSH_PROFILE, '--dump-config'], 30_000)
      expect(dump).toContain(`name: '${MSTAR_SPEC}'`)
      expect(dump).toContain('name: dsh-llm-fallbacks')
      const doctor = runCliDoctor(dshHome)
      console.log(`install-doctor-e2e: cell3(mounted) doctor exit ${doctor.exitCode}`)
      for (const line of doctor.stdout.split('\n').filter((line) => line.trim() !== '')) console.log(`install-doctor-e2e: cell3 doctor | ${line}`)
      expect(doctor.exitCode).toBe(0)
      expect(doctor.stdout).toContain(`${MSTAR_SPEC}: mounted`)
      expect(doctor.stdout).toContain(`${FALLBACKS_SPEC}: mounted`)
      expect(doctor.stdout).toContain('Doctor result: healthy')
      // Runtime half of cell 3 (roles seeded) = Task 1 installed-deployment
      // e2e (non-skip PASS: 13 mstar ids seeded, personas non-empty) — cited.
      console.log('install-doctor-e2e: cell3 runtime seeded evidence = Task 1 install-e2e (13 roles seeded, cited)')
    }
  }, { timeout: 600_000 })
})

// The skip-guard reason (module scope): printed ALWAYS so a skipped run is
// explicit in the output, never a silent green.
if (skipReason !== undefined) {
  console.log(`install-doctor-e2e: SKIPPED — ${skipReason}`)
}
