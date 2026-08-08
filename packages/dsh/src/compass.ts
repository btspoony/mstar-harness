/**
 * In-app parser for the delivery-compass frontmatter — mirror of
 * `packages/cli/src/compass.ts` (the CLI format shim), text-based so the
 * model-facing tools can parse a compass the app already read.
 *
 * The compass frontmatter is a flat YAML subset (scalar keys plus one
 * `plans:` list-of-scalars — see `skills/mstar-iteration/references/
 * iteration-compass-template.md` Fields guide); the engine's compass schema
 * (`iteration.validateCompassFrontmatter`) validates the parsed doc. The
 * engine deliberately has no YAML dependency, so this format shim lives in
 * the CLI; the dsh plugin needs it in-app and the plan keeps the engine
 * untouched, so this mirror is maintained in sync with the CLI copy (single
 * parser home: `packages/cli/src/compass.ts`).
 *
 * Throws with the source name on structural errors (no fence / unterminated
 * fence / unsupported line) so tool callers can fail with a precise message.
 * @param content - raw delivery-compass.md content.
 * @param source - display name for error messages (the file path).
 * @returns the parsed flat frontmatter doc.
 */
export function parseCompassFrontmatterText(content: string, source: string): Record<string, unknown> {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    throw new Error(`no YAML frontmatter fence in ${source} (expected first line "---")`)
  }
  const end = lines.indexOf('---', 1)
  if (end === -1) {
    throw new Error(`unterminated YAML frontmatter in ${source} (no closing "---")`)
  }
  const doc: Record<string, unknown> = {}
  let listKey: string | null = null
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? ''
    if (!line.trim() || line.trim().startsWith('#')) continue
    // `- item` lines (optionally indented) continue the most recent
    // `key:` list (plans:).
    if (listKey !== null && /^\s*-\s+/.test(line)) {
      const item = line.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '')
      const existing = doc[listKey]
      if (Array.isArray(existing)) {
        existing.push(item)
      } else {
        doc[listKey] = [item]
      }
      continue
    }
    listKey = null
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!kv) {
      throw new Error(`unsupported frontmatter line in ${source}: ${JSON.stringify(line)}`)
    }
    const value = kv[2]!.trim()
    // A flat flow-style array (`plans: []` / `plans: [a, b]`) becomes an
    // array of trimmed string items; anything else stays a scalar (empty
    // value → null, like before).
    doc[kv[1]!] =
      value === '' ? null : /^\[.*\]$/.test(value) ? parseFlowArray(value, source) : value.replace(/^["']|["']$/g, '')
    listKey = value === '' ? kv[1] : null
  }
  return doc
}

function parseFlowArray(raw: string, source: string): string[] {
  const inner = raw.slice(1, -1)
  if (/[[\]]/.test(inner)) {
    throw new Error(
      `nested flow-style array in ${source}: ${JSON.stringify(raw)} — only flat scalar items are supported (e.g. [a, b])`,
    )
  }
  // Quote-aware scan BEFORE the naive split: a comma inside a quoted item
  // (single OR double quotes) must stay part of its item, so `["a, b"]` /
  // `['a, b']` cannot be split unambiguously and are rejected here. A
  // different quote char inside a quoted item is a literal character (YAML
  // parity), not a toggle.
  let quote: string | null = null
  for (const ch of inner) {
    if (ch === '"' || ch === "'") {
      if (quote === null) quote = ch
      else if (quote === ch) quote = null
    } else if (ch === ',' && quote !== null) {
      throw new Error(
        `ambiguous flow-style array in ${source}: ${JSON.stringify(raw)} — quoted item containing comma cannot be split unambiguously (flat scalar items only)`,
      )
    }
  }
  if (quote !== null) {
    throw new Error(`unterminated ${quote} quote in flow-style array in ${source}: ${JSON.stringify(raw)}`)
  }
  const items: string[] = []
  for (const part of inner.split(',')) {
    const item = part.trim().replace(/^["']|["']$/g, '')
    if (item === '') continue
    items.push(item)
  }
  return items
}
