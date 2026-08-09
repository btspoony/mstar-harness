/**
 * Dev-time minimal functional stand-in for `@deepseek-ai/dsh-skill-local` —
 * the local filesystem skill provider for the DeepSeek Harness.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface — the full `Config` shape
 * (`customSkillDirs` / `bundledSkillDir` semantics, provider naming, default
 * roots), the `Config` schema, and the `{ name, inject, Config, apply }`
 * plugin module — and implements just enough behavior for real-composition
 * tests: root-ranked discovery of `<root>/<name>/SKILL.md` (or `<name>.md`)
 * entries and frontmatter parsing (name + description). Pinned to dsh-private
 * commit 9451be2 (2026-08-07 snapshot). Keep in sync when the dsh-private
 * baseline moves.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from 'cordis'
import z from 'schemastery'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillInvocationPolicy,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
  SkillSource,
} from '@deepseek-ai/dsh-skill'

/** Cordis plugin name registered by the Loader. */
export const name = 'skill-local'
/** Services required before this plugin's `apply` fiber starts. */
export const inject = ['skills']

const PROJECT_DSH_RANK = 100
const PROJECT_AGENTS_RANK = 200
const CUSTOM_RANK = 300
const USER_DSH_RANK = 400
const USER_AGENTS_RANK = 500
const BUNDLED_RANK = 600
const DEFAULT_WATCH_STABILITY_THRESHOLD_MS = 200
const DEFAULT_WATCH_POLL_INTERVAL_MS = 100
const DEFAULT_WATCH_MAX_PROJECTS = 128

/** Local filesystem skill provider configuration (full contract mirror). */
export interface Config {
  /** Unique provider name. Defaults to `local`. */
  providerName?: string
  /** Whether project and user roots are included around custom roots. */
  includeDefaultRoots?: boolean
  /** DeepSeek Harness config root. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Shared agent config root. Defaults to `$DSH_AGENTS_HOME` or `~/.agents`. */
  agentsHome?: string
  /** Additional skill roots scanned after project roots and before user roots. */
  customSkillDirs?: string[]
  /** Whether host-local skill roots are watched for catalog changes. */
  watch?: boolean
  /** Whether Chokidar uses polling instead of native filesystem events. */
  watchUsePolling?: boolean
  /** Milliseconds a changed skill entry must remain stable before it is observed. */
  watchStabilityThresholdMs?: number
  /** Milliseconds between Chokidar stability or polling probes. */
  watchPollIntervalMs?: number
  /** Maximum distinct project roots whose skill directories remain watched. */
  watchMaxProjects?: number
  /** Whether watched symbolic links follow their target files. */
  watchFollowSymlinks?: boolean
  /** Bundled skill root; defaults to `$DSH_BUNDLED_SKILL_DIR` when default roots are included, otherwise mounts none. */
  bundledSkillDir?: string
}

/** Contract-mirrored configuration schema (what the real skill-local loader validates). */
export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default('local'),
  includeDefaultRoots: z.boolean().default(true),
  dshHome: z.string(),
  agentsHome: z.string(),
  customSkillDirs: z.array(z.string()).default([]),
  watch: z.boolean().default(true),
  watchUsePolling: z.boolean().default(false),
  watchStabilityThresholdMs: z.number().default(DEFAULT_WATCH_STABILITY_THRESHOLD_MS),
  watchPollIntervalMs: z.number().default(DEFAULT_WATCH_POLL_INTERVAL_MS),
  watchMaxProjects: z.number().default(DEFAULT_WATCH_MAX_PROJECTS),
  watchFollowSymlinks: z.boolean().default(true),
  bundledSkillDir: z.string(),
})

interface SkillRoot {
  readonly path: string
  readonly source: SkillSource
  readonly rank: number
}

/**
 * Register the local filesystem skill provider on `ctx.skills` (contract
 * mirror of the real `apply`; watcher wiring is dev-time omitted).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const provider = new LocalSkillProvider(config)
  ctx.skills.registerProvider(() => provider)
  ctx.effect(() => () => { void provider.dispose() }, 'skill-local provider')
}

/** Provider that maps configured skill roots into `ctx.skills` (dev-time minimal). */
export class LocalSkillProvider implements SkillProvider {
  readonly name: string
  private readonly includeDefaultRoots: boolean
  private readonly customSkillDirs: string[]
  private readonly bundledSkillDir: string | undefined

  constructor(config: Config = {}) {
    this.name = config.providerName ?? 'local'
    this.includeDefaultRoots = config.includeDefaultRoots ?? true
    this.customSkillDirs = (config.customSkillDirs ?? []).map((root) => join(root))
    const bundledSkillDir = config.bundledSkillDir
      ?? (this.includeDefaultRoots ? process.env.DSH_BUNDLED_SKILL_DIR : undefined)
    this.bundledSkillDir = bundledSkillDir === undefined ? undefined : join(bundledSkillDir)
  }

  /**
   * Discover local skill summaries for the configured roots.
   * @returns provider candidates ordered by root rank.
   */
  async list(_options: SkillLookupOptions): Promise<SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    for (const root of await this.roots()) {
      for (const candidate of await discoverRoot(root, this.name)) {
        candidates.push(candidate)
      }
    }
    return candidates
  }

  /**
   * Load a complete local skill body from the candidate's file locator.
   * @param candidate - the winning candidate returned by this provider.
   * @returns the full local skill, or `undefined` if the file disappeared.
   */
  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as LocalLocator
    const parsed = await parseSkillFile(locator.path)
    if (parsed === undefined) return undefined
    return {
      name: parsed.name,
      description: parsed.description,
      invocation: parsed.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
      content: parsed.content,
    }
  }

  /** Close host watchers (dev-time: none — kept for contract symmetry). */
  dispose(): Promise<void> {
    return Promise.resolve()
  }

  private async roots(): Promise<SkillRoot[]> {
    const roots: SkillRoot[] = []
    if (this.includeDefaultRoots) {
      roots.push(
        { path: join(process.env.DSH_HOME ?? '~/.dsh', 'skills'), source: 'user-dsh', rank: USER_DSH_RANK },
        { path: join(process.env.DSH_AGENTS_HOME ?? '~/.agents', 'skills'), source: 'user-agents', rank: USER_AGENTS_RANK },
      )
    }
    roots.push(...this.customSkillDirs.map((path) => ({ path, source: 'custom' as const, rank: CUSTOM_RANK })))
    if (this.bundledSkillDir !== undefined) {
      roots.push({ path: this.bundledSkillDir, source: 'bundled', rank: BUNDLED_RANK })
    }
    return roots
  }
}

interface LocalLocator {
  readonly path: string
  readonly directory: string
}

interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly invocation: SkillInvocationPolicy
  readonly content: string
}

/** Discover one root: `<name>/SKILL.md` directories and `<name>.md` files. */
async function discoverRoot(root: SkillRoot, provider: string): Promise<SkillCandidate[]> {
  const skills: SkillCandidate[] = []
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    // simplify: dev-time stub — ENOENT roots are empty (real provider rethrows non-absence failures).
    if (isAbsentPathError(error)) return []
    throw error
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const locator = entry.isDirectory()
      ? { path: join(root.path, entry.name, 'SKILL.md'), directory: join(root.path, entry.name) }
      : entry.isFile() && entry.name.endsWith('.md')
        ? { path: join(root.path, entry.name), directory: root.path }
        : undefined
    if (locator === undefined) continue
    const parsed = await parseSkillFile(locator.path)
    if (parsed === undefined) continue
    skills.push({
      name: parsed.name,
      description: parsed.description,
      invocation: parsed.invocation,
      provider,
      source: root.source,
      rank: root.rank,
      locator,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
    })
  }
  return skills
}

/** Parse a skill file's frontmatter for the routing contract (name + description). */
async function parseSkillFile(path: string): Promise<ParsedSkill | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isAbsentPathError(error)) return undefined
    throw error
  }
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) return undefined
  return {
    name: parsed.name,
    description: parsed.description,
    invocation: { modelInvocable: true, userInvocable: true },
    content: parsed.body.trim(),
  }
}

/**
 * Extract `name` and `description` from the YAML frontmatter block.
 * `simplify:` dev-time line-scrape — scalar top-level keys only; the real
 * skill-local parses full YAML (quoted values, nested metadata). Swap the
 * seam package at P3 e2e for the production parser.
 */
function parseFrontmatter(raw: string): { name: string; description: string; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  const block = raw.slice(start, closing.start)
  const name = frontmatterField(block, 'name')
  const description = frontmatterField(block, 'description')
  if (name === undefined || description === undefined) return undefined
  return { name, description, body: raw.slice(closing.bodyStart) }
}

/** Find the closing `---` fence; returns the fence start and the body start. */
function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

/** First `key: value` line value (scalar top-level fields only — see parseFrontmatter simplify note). */
function frontmatterField(block: string, key: string): string | undefined {
  for (const line of block.split('\n')) {
    const match = line.match(new RegExp(`^${key}:\\s*(.*)$`))
    if (match !== null) return match[1]!.trim()
  }
  return undefined
}

function isAbsentPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
