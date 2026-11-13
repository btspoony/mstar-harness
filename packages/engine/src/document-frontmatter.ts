/**
 * The one mini frontmatter reader every host loader shares.
 *
 * Harness agent/command markdown carries only scalar and single-level map
 * shapes, so this is deliberately not YAML: a real parser would answer shapes
 * the frontmatter contract does not define. Two hosts read the same bundled
 * files, so the reader lives here instead of in each host.
 */
export type JsonObject = Record<string, unknown>;

export type FrontmatterAndBody = { frontmatter: string; body: string };

/** An opening `---` line through the closing one, optional trailing newline.
 * CRLF is accepted because the commands doctor classifies SKILL.md files the
 * OpenCode loaders never see, and both must agree on what has a fence. */
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Split a document into its frontmatter block and body. A document with no
 * fence returns the whole content as its body and an empty frontmatter. */
export function extractFrontmatterAndBody(content: string): FrontmatterAndBody {
  const match = content.match(FENCE);
  if (!match) return { frontmatter: "", body: content };
  return { frontmatter: match[1], body: match[2] };
}

function parseScalar(raw: string): string | number | boolean | null {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "allow" || value === "ask" || value === "deny") return value;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^["']|["']$/g, "");
}

/** Parse the nested-map frontmatter shape the harness markdown uses: scalars,
 * one level of nested maps, and `|`/`|-` block scalars. A quoted key keeps its
 * bare name, so `"*": deny` yields the `*` key on both hosts. */
export function parseSimpleFrontmatter(frontmatter: string): JsonObject {
  const root: JsonObject = {};
  const stack: Array<{ indent: number; target: JsonObject }> = [{ indent: -1, target: root }];
  const lines = frontmatter.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.match(/^ */)?.[0]?.length ?? 0;
    const trimmed = line.trim();
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim().replace(/^["']|["']$/g, "");
    const rawValue = trimmed.slice(separator + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].target;

    if (rawValue === "" || rawValue === "{}") {
      current[key] = {};
      stack.push({ indent, target: current[key] as JsonObject });
      continue;
    }

    if (rawValue === "|-" || rawValue === "|") {
      const blockLines: string[] = [];
      const baseIndent = indent;
      for (let j = i + 1; j < lines.length; j += 1) {
        const blockLine = lines[j];
        const blockIndent = blockLine.match(/^ */)?.[0]?.length ?? 0;
        if (blockLine.trim() && blockIndent <= baseIndent) break;
        const normalized = blockLine.startsWith(" ".repeat(baseIndent + 2))
          ? blockLine.slice(baseIndent + 2)
          : blockLine.trim()
            ? blockLine.trim()
            : "";
        blockLines.push(normalized);
        i = j;
      }
      current[key] = blockLines.join("\n");
      continue;
    }

    current[key] = parseScalar(rawValue);
  }

  return root;
}
