/**
 * The install-e2e skip-guard's local-artifact step as one testable unit:
 * `npm pack --json` the workspace package into a throwaway pack root, then
 * probe-install the tarball into a throwaway dsh home. Every failure —
 * non-zero exit, spawn error (a missing `npm` or `dsh` binary throws from
 * `Bun.spawnSync`), or a malformed pack report — returns a named skip
 * reason instead of throwing, and the pack root is removed before any
 * failure return (a skip never leaves it behind; the successful path hands
 * it to the caller, whose own cleanup owns it).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** `ok: true` carries the pack root (caller-owned cleanup) and the tarball
 * path inside it; `ok: false` is the printed skip reason — the pack root
 * was already removed. */
export type PackProbeResult = { ok: true; packRoot: string; tarball: string } | { ok: false; reason: string }

export interface PackProbeArgs {
  /** cwd of the package to pack. */
  packageRoot: string
  /** The workspace version, embedded in the pending-publish note. */
  repoVersion: string
  /** The dsh profile the probe install targets. */
  profile: string
  /** Spawn env for the probe (`DSH_HOME` forced to the throwaway home). */
  env: (probeHome: string) => Record<string, string>
  /** Binary overrides: the regression spec passes names of genuinely
   * missing executables so the spawn-error path is exercised for real. */
  npmBin?: string
  dshBin?: string
}

/** One spawn failure description: `exit <n>` plus the first stderr line for
 * a finished process, the error message for a spawn that never started. */
function spawnDetail(exitCode: number | null | undefined, stderr: string | undefined, error: unknown): string {
  if (error !== undefined) return error instanceof Error ? error.message : String(error)
  const stderrLine = (stderr?.split('\n').find((line) => line.trim() !== '') ?? '').trim()
  return `exit ${exitCode}${stderrLine === '' ? '' : `: ${stderrLine}`}`
}

/** Pack the workspace artifact and probe-install it by `file:`; never
 * throws — a spawn error is the same named skip as a non-zero exit. */
export async function packAndProbe(args: PackProbeArgs): Promise<PackProbeResult> {
  const publishNote = `@mstar-harness/dsh@${args.repoVersion} is not published until the 5.0 release`
  const npmBin = args.npmBin ?? 'npm'
  const dshBin = args.dshBin ?? 'dsh'
  const packRoot = await mkdtemp(join(tmpdir(), 'dsh-e2e-pack-'))
  let handedOff = false
  try {
    let packProc: { exitCode: number | null; stderr: string; stdout: string } | undefined
    let packError: unknown
    try {
      const proc = Bun.spawnSync([npmBin, 'pack', '--json', '--pack-destination', packRoot], {
        cwd: args.packageRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      packProc = { exitCode: proc.exitCode, stderr: proc.stderr.toString(), stdout: proc.stdout.toString() }
    } catch (error) {
      packError = error
    }
    if (packProc === undefined || packProc.exitCode !== 0) {
      return { ok: false, reason: `local artifact pack failed (npm pack --json --pack-destination <dir>, ${spawnDetail(packProc?.exitCode, packProc?.stderr, packError)}) — ${publishNote}` }
    }
    let packFilename: string | undefined
    try {
      const packReport: unknown = JSON.parse(packProc.stdout)
      if (Array.isArray(packReport)) {
        const entry: unknown = packReport[0]
        if (typeof entry === 'object' && entry !== null && 'filename' in entry && typeof entry.filename === 'string') {
          packFilename = entry.filename
        }
      }
    } catch {
      packFilename = undefined
    }
    if (packFilename === undefined) {
      return { ok: false, reason: `local artifact pack failed (npm pack --json --pack-destination <dir>, no filename in the pack report) — ${publishNote}` }
    }
    const tarball = join(packRoot, packFilename)
    const probeHome = await mkdtemp(join(tmpdir(), 'dsh-e2e-probe-home-'))
    try {
      let probe: { exitCode: number | null; stderr: string } | undefined
      let probeError: unknown
      try {
        const proc = Bun.spawnSync([dshBin, 'plugin', '--profile', args.profile, 'add', `file:${tarball}`], {
          env: args.env(probeHome),
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 300_000,
        })
        probe = { exitCode: proc.exitCode, stderr: proc.stderr.toString() }
      } catch (error) {
        probeError = error
      }
      if (probe === undefined || probe.exitCode !== 0) {
        return { ok: false, reason: `local artifact install failed (dsh plugin --profile web add file:<tarball>, ${spawnDetail(probe?.exitCode, probe?.stderr, probeError)}) — ${publishNote}` }
      }
    } finally {
      await rm(probeHome, { recursive: true, force: true })
    }
    handedOff = true
    return { ok: true, packRoot, tarball }
  } finally {
    if (!handedOff) await rm(packRoot, { recursive: true, force: true })
  }
}
