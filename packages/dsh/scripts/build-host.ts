/**
 * Host bundle build — the owner of `dist/index.js` and of what it was built from.
 *
 * `bun run --cwd packages/dsh build` runs this script in place of a bare
 * `bun build` command line. After a successful build it records the bundle's
 * reachable input set with per-input content fingerprints (`.dist-inputs.json`).
 * `checkHostBuild()` is the same producer's freshness check: it names the input
 * that no longer matches the stamp, and `HOST_BUILD_RECOVERY` is the command that
 * rebuilds both. The packed smoke calls that check instead of walking source
 * mtimes, so "the packed entry is the build of the current sources" is answered
 * by content and by the same traversal the build performed.
 *
 * Reachability comes from the build's own metafile, never from a directory walk:
 * `@mstar-harness/commands` is inlined from its generated `dist` output, so a
 * regenerated-but-identical module stays current and a source file the bundle
 * never loads can never make it stale. `node_modules` is outside the recorded
 * set: dependency changes are the lockfile's provenance, not this bundle's.
 *
 * The fingerprints are internal build provenance. Nothing outside this file may
 * assert one — a test that did would re-pin build bytes, not behavior.
 */
import { build } from 'bun'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const PACKAGE_ROOT = resolve(import.meta.dir, '..')

/** The two host entrypoints (unchanged from the inline build this replaced). */
const ENTRIES = ['src/index.ts', 'src/invariant.ts'] as const

/** The build's external bare imports — the shipped bundle inlines everything else. */
const EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools',
  '@mstar-harness/engine',
] as const

/** The stamp beside `dist/` (not inside it: it is provenance, not a shipped artifact). */
export const STAMP_FILE = '.dist-inputs.json'

/** The one recovery for every stale/missing answer below. */
export const HOST_BUILD_RECOVERY = 'bun run --cwd packages/dsh build'

export interface InputStamp {
  /** The bundle files this build wrote, relative to the package root. */
  outputs: string[]
  /** Content fingerprint of every reachable input, keyed by the same relative path. */
  inputs: Record<string, string>
}

export type HostBuildCheck =
  | { state: 'current' }
  | { state: 'stale'; input: string }
  | { state: 'missing'; input: string }

export function fingerprintFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readInputStamp(root: string): InputStamp | undefined {
  try {
    const stamp: unknown = JSON.parse(readFileSync(join(root, STAMP_FILE), 'utf8'))
    if (typeof stamp !== 'object' || stamp === null) return undefined
    const { outputs, inputs } = stamp as Partial<InputStamp>
    if (!Array.isArray(outputs) || typeof inputs !== 'object' || inputs === null) return undefined
    return { outputs, inputs }
  } catch {
    return undefined
  }
}

/** Write the stamp for one successful build: outputs plus the inputs' current content. */
export function recordInputStamp(root: string, inputs: readonly string[], outputs: readonly string[]): void {
  const stamp: InputStamp = {
    outputs: [...outputs].sort(),
    inputs: Object.fromEntries([...inputs].sort().map((input) => [input, fingerprintFile(join(root, input))])),
  }
  writeFileSync(join(root, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`)
}

/**
 * Is the built bundle still the build of its current sources? `current` means
 * every recorded output exists and every recorded input's content is unchanged.
 * A recorded input that vanished answers `missing` too — the bundle cannot be
 * current without it.
 */
export function checkHostBuild(root: string = PACKAGE_ROOT): HostBuildCheck {
  const stamp = readInputStamp(root)
  if (stamp === undefined) return { state: 'missing', input: STAMP_FILE }
  for (const output of stamp.outputs) {
    if (!existsSync(join(root, output))) return { state: 'missing', input: output }
  }
  for (const [input, recorded] of Object.entries(stamp.inputs)) {
    const path = join(root, input)
    if (!existsSync(path)) return { state: 'missing', input }
    if (fingerprintFile(path) !== recorded) return { state: 'stale', input }
  }
  return { state: 'current' }
}

/**
 * Build the host bundle and record its inputs. A failed build publishes no
 * current stamp: the previous one is removed up front, so a build that dies
 * halfway cannot leave a stamp claiming the leftover `dist` is current.
 *
 * A bundle failure throws (Bun raises an AggregateError carrying the build
 * messages), so the caller's exit status fails exactly as the inline command's
 * did; the stamp is already gone by then.
 */
export async function buildHost(root: string = PACKAGE_ROOT): Promise<void> {
  rmSync(join(root, STAMP_FILE), { force: true })
  const result = await build({
    entrypoints: ENTRIES.map((entry) => join(root, entry)),
    target: 'node',
    outdir: join(root, 'dist'),
    external: [...EXTERNALS],
    metafile: true,
  })
  // Bun throws on a failed bundle; this covers the documented `success: false` shape too.
  if (!result.success) throw new AggregateError(result.logs, 'host bundle build failed')
  // `metafile` types as a JSON string but arrives parsed; keys are build-root
  // relative (the invoking cwd) while the stamp is package-relative. realpath
  // keeps a symlinked root (/var vs /private/var) from producing `../..` keys.
  const buildRoot = realpathSync(root)
  const metafile = result.metafile as unknown as { inputs?: Record<string, unknown> } | undefined
  const reachable = Object.keys(metafile?.inputs ?? {})
    .map((key) => relative(buildRoot, realpathSync(resolve(process.cwd(), key))))
    .filter((input) => !input.split(sep).includes('node_modules'))
  recordInputStamp(root, reachable, result.outputs.map((output) => relative(buildRoot, output.path)))
}

if (import.meta.main) {
  // A failed build throws, so the `build` script chain fails with the compile error.
  await buildHost()
}

