#!/usr/bin/env bun
/**
 * Dev-time link farm for the private `@deepseek-ai/dsh-*` packages.
 *
 * Bun port of the dsh-advisor link-farm pattern
 * (`dsh-advisor/scripts/setup-dsh-links.mjs`). `@mstar-harness/dsh` declares
 * the dsh seam packages as peerDependencies only (the dsh host provides them
 * at runtime). For dev-time typecheck / tests / build this package links the
 * REAL packages from a local dsh source tree into the repo-root
 * `node_modules/@deepseek-ai/`, so no `peer-stubs/` copies are needed and
 * every developer resolves against the same tree.
 *
 * Source-tree resolution (same convention as dsh-advisor):
 *   1. `$DSH_SOURCE_DIR` (explicit override)
 *   2. `${DSH_HOME}/source/current`
 *   3. `${HOME}/.dsh/source/current` (the standard DSH_HOME location)
 *
 * The farm is idempotent: every `@deepseek-ai/*` package declared under the
 * two-level `packages` tree (and `vendor`) of the source tree is symlinked by
 * its declared name into `node_modules/@deepseek-ai/` — except packages that
 * declare a `bin` (tool CLIs such as the scaffold commands: linking them into
 * node_modules makes bun try to link their bins into `.bin`, i.e. write into
 * the shared dsh tree; this plugin never imports them). Entries already
 * pointing at the correct target are left untouched.
 *
 * `@deepseek-ai/cordis` is the in-box framework (20260811 snapshot rename;
 * the legacy bare `cordis` name is no longer supported by the vendored
 * snapshot) and is declared as a peerDependency of this package. It is
 * unpublished, so dev-time resolution comes from the cordis SHIM generated
 * whenever a source tree resolves (dsh-advisor pattern): a bin-less shim at
 * `node_modules/@deepseek-ai/cordis` answers the scoped name and points at
 * the tree's vendored files, so the plugin's `import '@deepseek-ai/cordis'`
 * (and its Context/Events augmentations) resolve to the SAME module the real
 * packages type against — with any other copy the augmentations silently
 * fail to merge (build breaks with `ctx.tools`/`ctx.commands`/… missing).
 * The bare `cordis` name is deliberately absent from the whole bundle
 * (package.json, imports, externals): a legacy `node_modules/cordis` from an
 * earlier install is removed in `write` and flagged by `--check`, so no
 * stale bare-cordis resolution can survive. When NO source tree resolves
 * (CI), the farm is skipped and the dsh steps are gated on availability
 * upstream (CI does not run dsh — user-confirmed).
 *
 * Safety (this repo's git-install path): the host profile installs the
 * plugin via git deps, whose prepare/postinstall run INSIDE the profile's
 * pnpm store (`<profile>/node_modules/.pnpm/…`). There the farm must NOT be
 * created — the host resolves `@deepseek-ai/*` from its in-box bundles,
 * never from a staging tree. The script therefore skips (exit 0) when it
 * detects a pnpm store copy or a repo root without `node_modules/` yet.
 *
 * Failure semantics: when the source tree is missing locally (non-CI) the
 * script FAILS with guidance (`set DSH_SOURCE_DIR=...`); when the `CI`
 * environment variable is present it warns and skips (exit 0) — CI does not
 * run dsh (user-confirmed), so dsh steps are gated by availability there.
 *
 * Modes:
 *   (no args)   ensure — create/recreate the farm, fail with guidance when
 *               the source tree is missing or a peer is not linkable.
 *   --check     verify only — no writes; exit non-zero when the farm is
 *               missing, stale, or a peer is unlinkable.
 *
 * Wired into the `prepare` lifecycle (before `bun run build`) and available
 * standalone as `bun run dsh:link` (re-run after changing
 * `$DSH_HOME`/`$DSH_SOURCE_DIR`) and `bun run dsh:link:check`.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** `packages/dsh/scripts` → the `@mstar-harness/dsh` package root. */
const pkgDir = resolve(here, '..')
/** The package root two levels up: the repo root whose `node_modules` hosts the farm. */
const repo = resolve(pkgDir, '..', '..')
const CHECK = process.argv.includes('--check')

// ---------------------------------------------------------------------------
// Safety guard: never run inside a host-profile install (pnpm store copy) or
// an uninstalled checkout — the host resolves @deepseek-ai/* from its in-box
// bundles, never from a staging tree.
// ---------------------------------------------------------------------------
const inStore = repo.includes(`${sep}node_modules${sep}.pnpm${sep}`)
const hasNodeModules = existsSync(join(repo, 'node_modules'))
if (inStore || !hasNodeModules) {
  console.log(`[dsh-links] skip: not a top-level dev install (${inStore ? 'inside the pnpm store (host-profile install path)' : 'repo root has no node_modules/ yet (not installed)'}).`)
  console.log('  @deepseek-ai/* resolve from the dsh in-box bundles at runtime; no link farm is created here.')
  process.exit(0)
}

const linkDir = join(repo, 'node_modules', '@deepseek-ai')
const cordisShimDir = join(repo, 'node_modules', '@deepseek-ai', 'cordis')

/** Resolve the dsh source tree root ($DSH_SOURCE_DIR first, then $DSH_HOME/source/current, then the default home location; Windows has no HOME, so USERPROFILE stands in). */
function resolveSourceRoot(): string | undefined {
  const candidates = [
    process.env.DSH_SOURCE_DIR,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'source', 'current') : undefined,
    join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh', 'source', 'current'),
  ].filter((candidate): candidate is string => candidate !== undefined)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Collect every linkable package under the tree: declared name starts with
 * `@deepseek-ai/` and the package declares no `bin` (bin-declaring packages
 * would make bun link their bins into `.bin`, writing into the shared dsh
 * tree). Two shapes occur under each area: a package dir directly under the
 * area (`area/<name>/package.json`) or grouped (`area/<group>/<name>/package.json`).
 */
function collectDeepseekPackages(sourceRoot: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const area of ['packages', 'vendor']) {
    for (const entry of readdirSafe(join(sourceRoot, area))) {
      const candidates: string[] = []
      if (existsSync(join(sourceRoot, area, entry, 'package.json'))) {
        candidates.push(join(sourceRoot, area, entry))
      }
      for (const leaf of readdirSafe(join(sourceRoot, area, entry))) {
        if (existsSync(join(sourceRoot, area, entry, leaf, 'package.json'))) {
          candidates.push(join(sourceRoot, area, entry, leaf))
        }
      }
      for (const dir of candidates) {
        let manifest: { name?: unknown; bin?: unknown }
        try {
          manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        } catch {
          continue
        }
        const { name, bin } = manifest
        if (typeof name === 'string' && name.startsWith('@deepseek-ai/') && bin === undefined) {
          found.set(name, dir)
        }
      }
    }
  }
  return found
}

/**
 * The `@deepseek-ai/*` peerDependencies of this package that must be
 * linkable from the tree. `@deepseek-ai/cordis` is exempt: the in-box cordis
 * framework is provided by the private shim (node_modules/@deepseek-ai/cordis),
 * not the farm — the vendored package declares a `bin`, so
 * collectDeepseekPackages() excludes it and it would otherwise land in
 * missingPeers.
 */
function requiredPeers(): string[] {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  return Object.keys(manifest.peerDependencies ?? {})
    .filter((name) => name.startsWith('@deepseek-ai/') && name !== '@deepseek-ai/cordis')
    .sort()
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).filter((entry) => !entry.startsWith('.')).sort()
  } catch {
    return []
  }
}

function linkKind(target: string) {
  if (process.platform !== 'win32') return 'dir'
  // Windows link kinds are per-target: junctions are directory-only (and need
  // no privileges); file symlinks need Developer Mode or an admin shell. The
  // cordis shim's file entries (index.js / index.d.ts) must NOT become
  // junctions — a broken junction on a file makes the import fail.
  try {
    return statSync(target).isDirectory() ? 'junction' : 'file'
  } catch {
    return 'file'
  }
}

/**
 * Create (or repair) one symlink. Idempotent: an entry already resolving to
 * the expected target is left untouched. `lstat`-based so broken symlinks
 * (e.g. links to a deleted `peer-stubs/` dir left by an earlier bun install)
 * are replaced instead of colliding with `EEXIST`.
 */
function ensure(linkPath: string, target: string) {
  let current: string | undefined
  try {
    const st = lstatSync(linkPath)
    current = st.isSymbolicLink() ? resolve(linkPath, readlinkSync(linkPath)) : linkPath
  } catch {
    current = undefined // no entry (or unreadable) — create below
  }
  if (current === target) return
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(target, linkPath, linkKind())
}

/**
 * The in-box cordis framework (dsh-advisor pattern): the real packages type
 * and run against the tree's vendored cordis, so dev-time
 * `import '@deepseek-ai/cordis'` must resolve to the SAME files. The vendored
 * package declares a `bin`, and symlinking it into node_modules makes bun
 * link its bin into `.bin` (a chmod write into the shared dsh tree), so
 * instead of a package symlink this writes a small private shim: a directory
 * with a bin-less package.json whose entry files are symlinks to the
 * vendored files. The bundle carries no bare `cordis` anywhere — the legacy
 * `node_modules/cordis` (old shim or npm copy) is removed so no stale
 * bare-cordis resolution survives.
 */
function writeCordisShim(sourceRoot: string) {
  const vendorCordis = join(sourceRoot, 'vendor', 'cordis')
  const manifestPath = join(vendorCordis, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`vendored cordis not found at ${vendorCordis} — the source tree must provide the in-box cordis framework`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // The vendored snapshot answers only the scoped name (20260811 rename);
  // the legacy bare `cordis` snapshot is no longer supported.
  if (manifest.name !== '@deepseek-ai/cordis') {
    throw new Error(`vendored cordis at ${vendorCordis} declares name "${manifest.name}" — expected "@deepseek-ai/cordis" (only the 20260811 snapshot rename is accepted; the legacy "cordis" name is no longer supported)`)
  }
  // Migration cleanup: remove the legacy bare-name entry (safe for both a
  // plain-dir shim and an npm-published copy) so no stale `import 'cordis'`
  // resolution survives.
  rmSync(join(repo, 'node_modules', 'cordis'), { recursive: true, force: true })
  rmSync(cordisShimDir, { recursive: true, force: true })
  mkdirSync(cordisShimDir, { recursive: true })
  ensure(join(cordisShimDir, 'index.js'), join(vendorCordis, 'lib', 'index.js'))
  ensure(join(cordisShimDir, 'index.d.ts'), join(vendorCordis, 'lib', 'types', 'index.d.ts'))
  if (existsSync(join(vendorCordis, 'src'))) {
    ensure(join(cordisShimDir, 'src'), join(vendorCordis, 'src'))
  }
  const exportsMap: Record<string, unknown> = { '.': { types: './index.d.ts', default: './index.js' }, './package.json': './package.json' }
  if (manifest.exports?.['./src/*'] !== undefined) {
    exportsMap['./src/*'] = './src/*'
  }
  writeFileSync(
    join(cordisShimDir, 'package.json'),
    JSON.stringify(
      {
        name: '@deepseek-ai/cordis',
        version: manifest.version,
        private: true,
        // Marker distinguishing this generated shim from an npm-published copy.
        dshLinkFarmShim: true,
        type: 'module',
        main: './index.js',
        types: './index.d.ts',
        exports: exportsMap,
      },
      null,
      2,
    ) + '\n',
  )
  return vendorCordis
}

/** True when `node_modules/@deepseek-ai/cordis` is a link-farm generated shim (vs anything else). */
function isCordisShim(): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(cordisShimDir, 'package.json'), 'utf8'))
    return manifest.dshLinkFarmShim === true
  } catch {
    return false
  }
}

/**
 * Remove farm entries that no longer map to a tree package. Only symlinks
 * whose target resolves OUTSIDE this repo are ours (bun-managed entries
 * point into this repo's own node_modules and are never touched) — a stale
 * farm entry such as a bin-declaring package makes bun try to link its bin
 * into `.bin`, i.e. write into the shared dsh tree.
 * @param dryRun - report without removing (used by --check).
 * @returns list of stale entry names.
 */
function pruneStale(managed: Set<string>, dryRun: boolean): string[] {
  const stale: string[] = []
  for (const entry of readdirSafe(linkDir)) {
    // Managed keys are package names ('@deepseek-ai/x'); the scanned paths
    // are node_modules-relative ('node_modules/@deepseek-ai/x').
    const key = `@deepseek-ai/${entry}`
    if (managed.has(key)) continue
    const linkPath = join(linkDir, entry)
    let target: string
    try {
      target = resolve(linkPath, readlinkSync(linkPath))
    } catch {
      continue // not a symlink — never ours, never touched
    }
    if (target.startsWith(repo + sep)) {
      // Points INSIDE this repo: a bun/workspace-managed entry (target
      // exists) is never touched; a BROKEN link into the repo (target gone,
      // e.g. the deleted peer-stubs/) is stale and pruned.
      if (existsSync(target)) continue
    }
    if (!dryRun) rmSync(linkPath, { recursive: true, force: true })
    stale.push(key)
  }
  return stale
}

/** Verify one link: exists, is a symlink, and resolves to the expected target. */
function checkLink(name: string, linkPath: string, target: string): string | undefined {
  let current: string | undefined
  try {
    const st = lstatSync(linkPath)
    if (!st.isSymbolicLink()) return `${name}: not a symlink (re-run \`bun run dsh:link\`)`
    current = resolve(linkPath, readlinkSync(linkPath))
  } catch {
    return `${name}: missing (run \`bun run dsh:link\`)`
  }
  if (current !== target) {
    return `${name}: points at ${current} (expected ${target}) — re-run \`bun run dsh:link\``
  }
  return undefined
}

/** Verify the cordis shim resolves to the vendored entry files (the shim is required whenever a source tree resolves). */
function checkCordisShim(sourceRoot: string): string | undefined {
  if (!isCordisShim()) {
    return existsSync(join(cordisShimDir, 'package.json'))
      ? `cordis shim missing: the plugin's Context/Events augmentations merge only against the tree's vendored cordis (run \`bun run dsh:link\`)`
      : `cordis missing: neither node_modules/@deepseek-ai/cordis nor the tree shim exists (run \`bun run dsh:link\`)`
  }
  const vendorCordis = join(sourceRoot, 'vendor', 'cordis')
  const problems: string[] = []
  const probe = (file: string, expected: string) => {
    const linkPath = join(cordisShimDir, file)
    if (!existsSync(linkPath)) {
      problems.push(`cordis shim: ${file} missing (run \`bun run dsh:link\`)`)
      return
    }
    let current: string
    try {
      current = resolve(linkPath, readlinkSync(linkPath))
    } catch {
      problems.push(`cordis shim: ${file} not a symlink (re-run \`bun run dsh:link\`)`)
      return
    }
    if (current !== expected) {
      problems.push(`cordis shim: ${file} points at ${current} (expected ${expected}) — re-run \`bun run dsh:link\``)
    }
  }
  probe('index.d.ts', join(vendorCordis, 'lib', 'types', 'index.d.ts'))
  probe('index.js', join(vendorCordis, 'lib', 'index.js'))
  // Migration leftover: the bare-name entry must be gone — the bundle
  // answers only the scoped name.
  if (existsSync(join(repo, 'node_modules', 'cordis'))) {
    problems.push('legacy node_modules/cordis present (re-run `bun run dsh:link`)')
  }
  return problems.length > 0 ? problems.join('; ') : undefined
}

function main() {
  const sourceRoot = resolveSourceRoot()
  if (sourceRoot === undefined) {
    const message =
      'no dsh source tree found — set DSH_SOURCE_DIR (or DSH_HOME pointing at a dsh home with source/current) so every developer resolves the same tree.\n'
      + `  tried:\n    ${process.env.DSH_SOURCE_DIR ?? '(DSH_SOURCE_DIR unset)'}\n`
      + `    ${process.env.DSH_HOME ? join(process.env.DSH_HOME, 'source', 'current') : '(DSH_HOME unset)'}\n`
      + `    ${join(process.env.HOME ?? '', '.dsh', 'source', 'current')}`
    if (process.env.CI !== undefined) {
      process.stderr.write(`dsh link farm: skipped (CI, no dsh source tree): ${message}\n`)
      return
    }
    throw new Error(message)
  }

  const tree = collectDeepseekPackages(sourceRoot)
  const peers = requiredPeers()
  const missingPeers = peers.filter((name) => !tree.has(name))
  if (missingPeers.length > 0) {
    throw new Error(
      `source tree ${sourceRoot} does not provide the peer packages: ${missingPeers.join(', ')}\n`
      + 'point DSH_SOURCE_DIR at a dsh source tree containing these packages (e.g. the same tree the host runs from).',
    )
  }

  const managed = new Map(tree)
  const problems: string[] = []
  if (CHECK) {
    for (const [name, target] of managed) {
      const problem = checkLink(name, join(linkDir, name.replace('@deepseek-ai/', '')), target)
      if (problem !== undefined) problems.push(problem)
    }
    const cordisProblem = checkCordisShim(sourceRoot)
    if (cordisProblem !== undefined) problems.push(cordisProblem)
    for (const stale of pruneStale(new Set(managed.keys()), true)) {
      problems.push(`${stale}: stale farm entry (re-run \`bun run dsh:link\` to prune)`)
    }
    if (problems.length > 0) {
      process.stderr.write(`dsh link farm check failed (source ${sourceRoot}):\n  ${problems.join('\n  ')}\n`)
      process.exit(1)
    }
    console.log(`dsh link farm ok: ${managed.size} entries linked from ${sourceRoot}`)
    return
  }

  mkdirSync(linkDir, { recursive: true })
  for (const [name, target] of managed) {
    ensure(join(linkDir, name.replace('@deepseek-ai/', '')), target)
  }
  // ALWAYS write the cordis shim when a source tree resolves — the real
  // packages' `declare module '@deepseek-ai/cordis'` Context/Events
  // augmentations merge only against the tree's vendored cordis (module
  // identity; any other copy is a different physical module and the merges
  // silently fail).
  writeCordisShim(sourceRoot)
  const removed = pruneStale(new Set(managed.keys()), false)
  console.log(
    `dsh link farm: ${managed.size} entries linked from ${sourceRoot}`
    + (removed.length > 0 ? ` (pruned stale: ${removed.join(', ')})` : ''),
  )
}

try {
  main()
} catch (error) {
  process.stderr.write(`dsh link farm: ${(error as Error).message}\n`)
  process.exit(1)
}
