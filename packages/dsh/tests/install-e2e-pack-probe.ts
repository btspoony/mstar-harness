// see packages/dsh/tests/install-e2e-pack-probe.spec.ts - every spawn/pack failure becomes the printed skip reason, never a throw, and the pack root is removed before any failure return; the success path hands it to the caller's cleanup.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export type PackProbeResult = { ok: true; packRoot: string; tarball: string } | { ok: false; reason: string; packRoot: string }

export interface PackProbeArgs {
  packageRoot: string
  repoVersion: string
  profile: string
  env: (probeHome: string) => Record<string, string>
  npmBin?: string
  spawnTimeoutMs?: number
  dshBin?: string
}

function spawnDetail(exitCode: number | null | undefined, error: unknown): string {
  if (error !== undefined) return error instanceof Error ? error.message : String(error)
  return `exit ${exitCode}`
}

function stderrLineOf(stderr: string | undefined): string {
  return (stderr?.split('\n').find((line) => line.trim() !== '') ?? '').trim()
}

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
        timeout: args.spawnTimeoutMs ?? 300_000,
      })
      packProc = { exitCode: proc.exitCode, stderr: proc.stderr.toString(), stdout: proc.stdout.toString() }
    } catch (error) {
      packError = error
    }
    if (packProc === undefined || packProc.exitCode !== 0) {
      const stderrLine = stderrLineOf(packProc?.stderr)
      const stderrSuffix = stderrLine === '' ? '' : `: ${stderrLine}`
      return { ok: false, reason: `local artifact pack failed (npm pack --json --pack-destination <dir>, ${spawnDetail(packProc?.exitCode, packError)})${stderrSuffix} — ${publishNote}`, packRoot }
    }
    let packFilename: string | undefined
    try {
      const packReport: unknown = JSON.parse(packProc.stdout)
      if (Array.isArray(packReport)) {
        const entry: unknown = packReport[0]
        if (typeof entry === 'object' && entry !== null && 'filename' in entry && typeof entry.filename === 'string' && entry.filename !== '' && basename(entry.filename) === entry.filename && entry.filename !== '.' && entry.filename !== '..') {
          packFilename = entry.filename
        }
      }
    } catch {
      packFilename = undefined
    }
    if (packFilename === undefined) {
      return { ok: false, reason: `local artifact pack failed (npm pack --json --pack-destination <dir>, no filename in the pack report) — ${publishNote}`, packRoot }
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
          timeout: args.spawnTimeoutMs ?? 300_000,
        })
        probe = { exitCode: proc.exitCode, stderr: proc.stderr.toString() }
      } catch (error) {
        probeError = error
      }
      if (probe === undefined || probe.exitCode !== 0) {
        const stderrLine = stderrLineOf(probe?.stderr)
        const stderrSuffix = stderrLine === '' ? '' : `: ${stderrLine}`
        return { ok: false, reason: `local artifact install failed (dsh plugin --profile ${args.profile} add file:<tarball>, ${spawnDetail(probe?.exitCode, probeError)})${stderrSuffix} — ${publishNote}`, packRoot }
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
