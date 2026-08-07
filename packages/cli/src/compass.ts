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
    doc[kv[1]!] = value === "" ? null : value.replace(/^["']|["']$/g, "");
    listKey = value === "" ? kv[1] : null;
  }
  return doc;
}
