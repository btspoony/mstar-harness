import { readFileSync } from "node:fs";

/**
 * Parse the YAML frontmatter of a delivery-compass.md into a flat doc.
 *
 * The compass frontmatter is a flat YAML subset (scalar keys plus one
 * `plans:` list-of-scalars — see `skills/mstar-iteration/references/
 * iteration-compass-template.md` Fields guide); the engine's compass schema
 * (`iteration.validateCompassFrontmatter`) validates the parsed doc. The
 * engine deliberately has no YAML dependency, so this format shim lives in
 * the CLI.
 *
 * Throws with the file path on structural errors (no fence / unterminated
 * fence / unsupported line) so the CLI can fail with a precise message.
 */
export function parseCompassFrontmatter(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error(`no YAML frontmatter fence in ${filePath} (expected first line "---")`);
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error(`unterminated YAML frontmatter in ${filePath} (no closing "---")`);
  }
  const doc: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) continue;
    // `- item` lines (optionally indented) continue the most recent
    // `key:` list (plans:).
    if (listKey !== null && /^\s*-\s+/.test(line)) {
      const item = line.replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, "");
      if (!Array.isArray(doc[listKey])) doc[listKey] = [];
      (doc[listKey] as string[]).push(item);
      continue;
    }
    listKey = null;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!kv) {
      throw new Error(`unsupported frontmatter line in ${filePath}: ${JSON.stringify(line)}`);
    }
    const value = kv[2]!.trim();
    // A flat flow-style array (`plans: []` / `plans: [a, b]`) becomes an
    // array of trimmed string items; anything else stays a scalar (empty
    // value → null, like before).
    doc[kv[1]!] =
      value === "" ? null : /^\[.*\]$/.test(value) ? parseFlowArray(value, filePath) : value.replace(/^["']|["']$/g, "");
    listKey = value === "" ? kv[1] : null;
  }
  return doc;
}

function parseFlowArray(raw: string, filePath: string): string[] {
  const inner = raw.slice(1, -1);
  if (/[[\]]/.test(inner)) {
    throw new Error(
      `nested flow-style array in ${filePath}: ${JSON.stringify(raw)} — only flat scalar items are supported (e.g. [a, b])`,
    );
  }
  // Quote-aware scan BEFORE the naive split: a comma inside double quotes
  // must stay part of its item, so `["a, b", "c"]` cannot be split
  // unambiguously and is rejected here (a post-split `item.includes(",")`
  // check would be dead — split(",") items can never contain a comma).
  let inQuotes = false;
  for (const ch of inner) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && inQuotes) {
      throw new Error(
        `ambiguous flow-style array in ${filePath}: ${JSON.stringify(raw)} — quoted item containing comma cannot be split unambiguously (flat scalar items only)`,
      );
    }
  }
  if (inQuotes) {
    throw new Error(`unterminated double quote in flow-style array in ${filePath}: ${JSON.stringify(raw)}`);
  }
  const items: string[] = [];
  for (const part of inner.split(",")) {
    const item = part.trim().replace(/^["']|["']$/g, "");
    if (item === "") continue;
    items.push(item);
  }
  return items;
}
