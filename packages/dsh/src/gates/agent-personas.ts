/**
 * Role-persona defaults from the packaged `harness-agents/` mirror (plan
 * `20260815-dsh-fallbacks-personas` Task 3) — the subagent decoration's
 * single lookup surface.
 *
 * Lookup chain: `Config.rolePersonas[roleId]` wins; a mirror shell whose
 * file stem equals the role id (`<agentsDir>/<roleId>.md`) supplies the
 * default persona from its frontmatter `description` block scalar; nothing
 * else → undefined (decoration skips). A shell is eligible when its
 * frontmatter `mode` is absent or `subagent` — a `primary` shell (e.g.
 * `project-manager`) is never offered as a subagent persona default.
 *
 * Extraction is limited to the constrained frontmatter the repo owns (the
 * mirror is synced from repo-root `agents/` by `bundle-assets`): the
 * leading `---` block, the `description:` block scalar (`|`/`|-`/`|+`,
 * indented continuation lines until the next top-level key) or plain
 * scalar, and the plain-scalar `mode:` field. No general YAML parser, no
 * new dependencies.
 *
 * The interpolation hazard (dsh system-prompt STRICT `{{...}}` rendering)
 * applies to extracted defaults exactly like Config personas: a default
 * whose description carries a `{{` paired with a later `}}` is WARNED +
 * skipped at extraction (never a boot throw — the Config schema rejects
 * configured values at mount, but the mirror is read at decision points).
 *
 * Reads are cached per (shell path, mtime) — a decision-point `statSync`
 * is the hot-path cost, and an in-place edit (mtime bump) re-extracts on
 * the next lookup, so the cache never serves stale defaults.
 *
 * Module boundary: no barrel — the decoration imports this module by
 * explicit relative path; the entry does not re-export it (the decoration
 * is the only consumer; its public surface is `personaFor`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PERSONA_INTERPOLATION_HAZARD } from './_shared.ts'

/**
 * The role-id shape the mirror lookup accepts — upstream `ROLE_ID_PATTERN`
 * semantics (`/^[a-z0-9-]{1,32}$/`, dsh-llm-fallbacks `src/config.ts`),
 * implemented locally (no import-shape assumptions). The role id flows from
 * the child's Assignment header (`Execute as`) into a filesystem path, so
 * it is constrained to this shape BEFORE any path join: no `..`, no path
 * separators, no absolute roots, bounded length. All 14 mirror stems comply.
 */
export const ROLE_ID_PATTERN = /^[a-z0-9-]{1,32}$/

/** One resolved persona: the text and its source. */
export interface PersonaResult {
  text: string
  source: 'config' | 'default'
}

/** The lookup surface {@link personaFor} consumes. */
export interface PersonaLookup {
  /** Config-sourced persona map (`rolePersonas`) — wins over the mirror default. */
  rolePersonas?: Record<string, string> | null
  /** The mirror root (`harness-agents/`); absent → mirror defaults are skipped. */
  agentsDir?: string
}

/** Warn sink for extraction-time hazards (bound by the decoration to its warn channel). */
export type PersonaWarnSink = (message: string) => void

/** One shell default-cache entry: the file mtime the extraction is valid for. */
interface DefaultCacheEntry {
  mtimeMs: number
  text: string | undefined
}

/**
 * Per-(shell path, mtime) cache. Keyed by the absolute shell path (which
 * embeds the mirror root — distinct mirrors never collide), re-extracted on
 * an mtime change (no staleness). Unbounded by design: the mirror holds 14
 * shells, and each entry is one small string.
 */
const defaultCache = new Map<string, DefaultCacheEntry>()

/**
 * The decoration's single persona lookup: `rolePersonas[roleId]` → mirror
 * default → undefined. Pure — the mirror root is passed explicitly (the
 * decoration supplies the apply-bound packaged root; tests supply fixtures).
 *
 * @param roleId - the mstar role id (Assignment `Execute as`).
 * @param lookup - the config override map and the mirror root.
 * @param warn - optional extraction-time warn sink (hazard defaults).
 */
export function personaFor(roleId: string, lookup: PersonaLookup, warn?: PersonaWarnSink): PersonaResult | undefined {
  const configured = lookup.rolePersonas?.[roleId]
  // `''` parity with the decoration's pre-task config check: an empty
  // configured persona is treated as absent (falls through to the default).
  if (configured !== undefined && configured !== '') return { text: configured, source: 'config' }
  if (lookup.agentsDir === undefined) return undefined
  const text = defaultFromMirror(lookup.agentsDir, roleId, warn)
  if (text === undefined || text.trim() === '') return undefined
  return { text, source: 'default' }
}

/**
 * The mstar role-id set for one mirror: the file stems of the shells
 * eligible as subagent role defaults (`mode` absent-or-`subagent` — a
 * `primary` shell like `project-manager` is excluded), sorted for
 * deterministic warn listings. The adoption advisory (plan
 * `20260815-dsh-fallbacks-personas` Task 4) derives its taxonomy reference
 * from here — never hardcoded. Reads the mirror directory + each shell's
 * frontmatter once per call (the advisory invokes it once per apply — no
 * cache needed). Returns `[]` for an unreadable/absent mirror directory.
 */
export function subagentRoleIds(agentsDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(agentsDir)
  } catch {
    return []
  }
  const ids: string[] = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const roleId = name.slice(0, -3)
    let content: string
    try {
      content = readFileSync(join(agentsDir, name), 'utf8')
    } catch {
      continue
    }
    const mode = parseShellFrontmatter(content).mode
    // S-001 mode-gate strictness: absent-or-`subagent` only.
    if (mode === undefined || mode === 'subagent') ids.push(roleId)
  }
  return ids.sort()
}

/**
 * Resolve the mirror default for one role: read `<agentsDir>/<roleId>.md`,
 * extract its frontmatter `description` block scalar, and return it when the
 * shell is eligible (`mode` absent-or-`subagent`) and the text is free of
 * the interpolation hazard. Cached per (path, mtime) — the cache holds the
 * final eligibility decision, so a skipped hazard is not re-warned until the
 * shell changes.
 */
function defaultFromMirror(agentsDir: string, roleId: string, warn: PersonaWarnSink | undefined): string | undefined {
  // F-001: the role id is attacker-influenced (the child's Assignment header)
  // and flows into a filesystem path — reject any id outside the upstream
  // ROLE_ID_PATTERN shape before the join. A hostile id is a SILENT skip
  // (mirror-present misses stay silent like an absent shell) — never a
  // throw, never a warn, never fs access outside the mirror root.
  if (!ROLE_ID_PATTERN.test(roleId)) return undefined
  const root = resolve(agentsDir)
  const file = resolve(agentsDir, `${roleId}.md`)
  // Defense-in-depth containment: the resolved path must stay under the
  // mirror root. The format check already forbids traversal; this pins the
  // boundary even if the join inputs ever change shape.
  if (!file.startsWith(root + sep)) return undefined
  let stat
  try {
    stat = statSync(file)
  } catch {
    return undefined // no shell for this role
  }
  if (!stat.isFile()) return undefined
  const hit = defaultCache.get(file)
  if (hit !== undefined && hit.mtimeMs === stat.mtimeMs) return hit.text
  // S-004: the read is individually guarded (stat is only the cache key) — a
  // delete/perm race between stat and read degrades THIS file to undefined
  // instead of aborting the whole decoration for the emit.
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const text = extractShellPersona(content, roleId, warn)
  defaultCache.set(file, { mtimeMs: stat.mtimeMs, text })
  return text
}

/**
 * Extract the eligible persona from one shell file: frontmatter `description`
 * (block scalar or plain scalar), `mode` eligibility, interpolation-hazard
 * rejection. Returns undefined when the shell carries no usable default.
 */
function extractShellPersona(content: string, roleId: string, warn: PersonaWarnSink | undefined): string | undefined {
  const parsed = parseShellFrontmatter(content)
  const description = parsed.description
  if (description === undefined || description.trim() === '') return undefined
  // S-001 mode-gate strictness (plan Task 3 case (f)): eligible ONLY when
  // `mode` is absent or exactly `subagent` — a `primary` shell or any
  // other/typo'd value is never offered as a subagent persona default.
  // Excluded silently (no hazard warn).
  if (parsed.mode !== undefined && parsed.mode !== 'subagent') return undefined
  if (PERSONA_INTERPOLATION_HAZARD.test(description)) {
    warn?.(`harness-agents default skipped for role '${roleId}' — description contains a "{{" paired with a later "}}" (dsh system-prompt strict interpolation renders persona text and throws on unknown or malformed references — use single braces or reword)`)
    return undefined
  }
  return description
}

/** The extracted constrained frontmatter fields the persona default consumes. */
interface ShellFrontmatter {
  description?: string
  mode?: string
}

/**
 * Slice the leading `---` frontmatter block and pull the `description` and
 * `mode` fields with the constrained repo-owned YAML shapes: `description`
 * is a block scalar (`|`, `|-`, `|+`, optional explicit indent like `|2-`)
 * with indented continuation lines until the next top-level key, or a plain
 * scalar; `mode` is a plain scalar (possibly quoted). Non-target keys are
 * skipped; indented lines (block content, nested keys) never match a
 * top-level key line.
 */
function parseShellFrontmatter(content: string): ShellFrontmatter {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length === 0 || lines[0]!.trim() !== '---') return {}
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return {}
  const frontmatter = lines.slice(1, end)
  const result: ShellFrontmatter = {}
  for (let i = 0; i < frontmatter.length; i++) {
    const line = frontmatter[i]!
    const key = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (key === null) continue // block-scalar continuation or blank line
    const label = key[1]!
    const rest = key[2]!
    if (label === 'description') {
      const block = /^\|[+-]?(?<indent>\d*)[ \t]*$/.exec(rest)
      result.description = block !== null
        ? extractBlockScalar(frontmatter, i + 1, block.groups?.indent)
        : unquote(rest.trim())
    } else if (label === 'mode') {
      result.mode = unquote(rest.trim())
    }
  }
  return result
}

/**
 * Extract a YAML literal block scalar body: the indented lines starting at
 * `start` (blank lines included) until the next line with no leading
 * whitespace ends the block. The block's indentation is the explicit
 * indicator (`|2-`) when present, else the first non-empty line's leading
 * whitespace (the repo-owned shape uses 2 spaces); trailing newlines are
 * trimmed (the mirror's `|-` chomping).
 */
function extractBlockScalar(frontmatter: string[], start: number, explicitIndent: string | undefined): string {
  const blockLines: string[] = []
  for (let i = start; i < frontmatter.length; i++) {
    const line = frontmatter[i]!
    if (line.trim() === '') {
      blockLines.push('')
      continue
    }
    if (/^[ \t]/.test(line)) {
      blockLines.push(line)
      continue
    }
    break
  }
  let indent = explicitIndent !== undefined && explicitIndent !== '' ? Number(explicitIndent) : undefined
  if (indent === undefined) {
    const first = blockLines.find((line) => line.trim() !== '')
    indent = first !== undefined ? (/^[ \t]*/.exec(first)![0]!.length) : 0
  }
  return blockLines
    .map((line) => (line.trim() === '' ? '' : line.slice(Math.min(indent, line.length))))
    .join('\n')
    .replace(/\n+$/, '')
}

/**
 * Strip one pair of surrounding double quotes (frontmatter authors quote
 * values so YAML treats them as scalars — command-frontmatter precedent).
 */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}
