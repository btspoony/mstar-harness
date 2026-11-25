/**
 * The one mini frontmatter reader every host loader shares.
 *
 * Harness markdown carries a strict flat subset — scalars, indentation
 * nested maps, flat flow arrays, `- item` block lists and `|`/`|-` block
 * scalars — so this is deliberately not YAML: a real parser would answer
 * shapes the frontmatter contract does not define. Any other line form is
 * refused with the source label and the 1-based line, because silent
 * skipping is the defect this reader removes. Two hosts read the same
 * bundled files, so the reader lives here instead of in each host.
 */
export type JsonObject = Record<string, unknown>;

export type FrontmatterAndBody = { frontmatter: string; body: string };

/** Refusal of a frontmatter line outside the accepted subset. `source` is a
 * diagnostic label only (the caller names the document); `line` is the
 * 1-based line in the source document — the opening fence is document
 * line 1, so the first frontmatter text line is line 2 — and `lineText`
 * is the offending raw line. */
export class DocumentFrontmatterError extends Error {
  readonly source: string;
  readonly line: number;
  readonly lineText: string;

  constructor(source: string, line: number, lineText: string, reason: string) {
    super(`${source}:${line}: ${reason}: ${JSON.stringify(lineText)}`);
    this.name = "DocumentFrontmatterError";
    this.source = source;
    this.line = line;
    this.lineText = lineText;
  }
}

/** An opening `---` line through the closing one, optional trailing newline.
 * CRLF is accepted because the commands doctor classifies SKILL.md files the
 * OpenCode loaders never see, and both must agree on what has a fence. */
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Split a document into its frontmatter block and body. A document with no
 * fence (or an unterminated one) returns the whole content as its body and
 * an empty frontmatter. */
export function extractFrontmatterAndBody(content: string): FrontmatterAndBody {
  const match = content.match(FENCE);
  if (!match) return { frontmatter: "", body: content };
  return { frontmatter: match[1], body: match[2] };
}

const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function parseScalar(raw: string): string | number | boolean | null {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return unquote(value);
}

/** Strip one surrounding pair of matching quotes, or return the input. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Assign as an own data property: a plain `target[key] = value` write for
 * the accepted key `__proto__` would invoke the inherited prototype setter
 * instead of storing the key. */
function setOwn(target: JsonObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

interface Level {
  indent: number;
  kind: "map" | "leaf" | "pending" | "list";
  target: JsonObject | string[];
  key?: string;
  parent?: JsonObject;
  childIndent: number | null;
}

/** Parse a flat flow array (`[a, b]`, `[]`) into trimmed string items. A
 * comma inside a quoted item is ambiguous after a naive split, so quoted
 * items containing commas refuse outright; nested `[`/`{` items refuse too. */
function parseFlowArray(raw: string, fail: () => never): string[] {
  if (!raw.endsWith("]")) {
    fail();
  }
  const inner = raw.slice(1, -1);
  if (inner.trim() === "") return [];
  let quote: string | null = null;
  for (const ch of inner) {
    if (ch === '"' || ch === "'") {
      if (quote === null) quote = ch;
      else if (quote === ch) quote = null;
    } else if (ch === "," && quote !== null) {
      fail();
    }
  }
  if (quote !== null) {
    fail();
  }
  const items: string[] = [];
  for (const part of inner.split(",")) {
    const item = part.trim();
    if (item === "" || item.startsWith("[") || item.startsWith("]") || item.startsWith("{")) {
      fail();
    }
    const first = item[0]!;
    if (first === '"' || first === "'") {
      if (item.length < 2 || item[item.length - 1] !== first) {
        fail();
      }
      items.push(item.slice(1, -1));
      continue;
    }
    if (item.includes('"') || item.includes("'")) {
      fail();
    }
    items.push(item);
  }
  return items;
}

/** Parse the strict accepted subset of harness frontmatter. Any other line
 * form throws `DocumentFrontmatterError` with the source label, the 1-based
 * line in the document the frontmatter was extracted from and the offending
 * raw line. */
export function parseDocumentFrontmatter(frontmatter: string, source: string): JsonObject {
  const lines = frontmatter.split(/\r?\n/);
  const fail = (lineIndex: number, lineText: string, reason: string): never => {
    // `+ 2` because the diagnostic contract is document-relative: the
    // opening `---` fence is document line 1, frontmatter line 0 is line 2.
    throw new DocumentFrontmatterError(source, lineIndex + 2, lineText, reason);
  };

  const root: JsonObject = {};
  const rootLevel: Level = { indent: -1, kind: "map", target: root, childIndent: null };
  const stack: Level[] = [rootLevel];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    const leadingWhitespace = raw.match(/^[ \t]*/)?.[0] ?? "";
    if (leadingWhitespace.includes("\t")) {
      fail(i, raw, "tab in indentation");
    }
    const indent = leadingWhitespace.length;
    const trimmed = raw.trim();

    if (/^-\s+/.test(trimmed) || trimmed === "-") {
      // `- item` lines (optionally indented) continue the innermost open
      // `key:` list; items at the list key's own indent are accepted.
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) {
        stack.pop();
      }
      const top = stack[stack.length - 1];
      if (top.kind === "pending") {
        // The first child of a bare `key:` is a dash item: the key is a
        // block list, not the tentative empty map.
        const list: string[] = [];
        setOwn(top.parent!, top.key!, list);
        top.kind = "list";
        top.target = list;
      }
      if (top.kind !== "list") {
        fail(i, raw, "list item outside a list key");
      }
      // The first item's indent is the sibling indent for the whole list;
      // a deeper or inconsistent indent is not a sibling of the open list.
      if (top.childIndent === null) {
        top.childIndent = indent;
      } else if (indent !== top.childIndent) {
        fail(i, raw, "list item indent does not match the first item of its list");
      }
      const item = trimmed.replace(/^-\s*/, "").trim();
      if (
        item === "" ||
        item.startsWith("[") ||
        item.startsWith("{") ||
        item.startsWith("&") ||
        item.startsWith("*") ||
        item.startsWith("!")
      ) {
        fail(i, raw, "unsupported list item");
      }
      (top.target as string[]).push(unquote(item));
      continue;
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const container = stack[stack.length - 1];
    if (container.kind === "leaf") {
      fail(i, raw, "indented child under a scalar, flow-array or block-scalar key");
    }
    if (container.kind === "list") {
      fail(i, raw, "key line inside a list");
    }
    if (container.kind === "pending") {
      // The first child of a bare `key:` is a key line: it is a nested map.
      container.kind = "map";
    }
    if (container.childIndent === null) {
      if (indent <= container.indent) {
        fail(i, raw, "indent is not deeper than the parent key");
      }
      container.childIndent = indent;
    } else if (indent !== container.childIndent) {
      fail(i, raw, "indent is not the child indent of the open map level");
    }

    // The separator colon terminates the key; for a quoted key it is the
    // colon after the closing quote, so a colon inside the quotes stays
    // part of the key.
    let separator: number;
    const firstChar = trimmed[0]!;
    if (firstChar === '"' || firstChar === "'") {
      const closingQuote = trimmed.indexOf(firstChar, 1);
      if (closingQuote < 0) {
        fail(i, raw, "unsupported key");
      }
      separator = closingQuote + 1;
      while (separator < trimmed.length && trimmed[separator] === " ") {
        separator += 1;
      }
      if (separator >= trimmed.length || trimmed[separator] !== ":") {
        fail(i, raw, "line is not a key: line");
      }
    } else {
      separator = trimmed.indexOf(":");
    }
    if (separator <= 0) {
      fail(i, raw, "line is not a key: line");
    }
    if (separator + 1 < trimmed.length && trimmed[separator + 1] !== " ") {
      fail(i, raw, "a key: line needs a space after the colon");
    }
    const keyRaw = trimmed.slice(0, separator).trim();
    let key: string;
    if (BARE_KEY.test(keyRaw)) {
      key = keyRaw;
    } else if (
      keyRaw.length >= 2 &&
      (keyRaw[0] === '"' || keyRaw[0] === "'") &&
      keyRaw[keyRaw.length - 1] === keyRaw[0]
    ) {
      key = keyRaw.slice(1, -1);
    } else {
      fail(i, raw, "unsupported key");
    }
    const rawValue = trimmed.slice(separator + 1).trim();

    const target = container.target as JsonObject;
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      fail(i, raw, `duplicate key ${JSON.stringify(key)}`);
    }

    if (rawValue === "") {
      // Bare `key:` opens either a nested map or a `- item` list; until the
      // first child line decides, it is the host's empty-map result.
      const child: JsonObject = {};
      setOwn(target, key, child);
      stack.push({ indent, kind: "pending", target: child, key, parent: target, childIndent: null });
      continue;
    }
    if (rawValue === "{}") {
      setOwn(target, key, {});
      stack.push({ indent, kind: "leaf", target: {}, childIndent: null });
      continue;
    }
    if (rawValue === "|" || rawValue === "|-") {
      // Block scalar: deeper-indented lines join with `\n`; blank lines
      // inside the block stay empty, the block ends at the first nonblank
      // line indented at or below the key. Every consumed line gets the
      // same tab-in-indentation refusal as any other frontmatter line.
      const blockLines: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const blockLine = lines[j];
        const blockLeading = blockLine.match(/^[ \t]*/)?.[0] ?? "";
        if (blockLeading.includes("\t")) {
          fail(j, blockLine, "tab in indentation");
        }
        const blockIndent = blockLeading.length;
        if (blockLine.trim() && blockIndent <= indent) break;
        const normalized = blockLine.startsWith(" ".repeat(indent + 2))
          ? blockLine.slice(indent + 2)
          : blockLine.trim()
            ? blockLine.trim()
            : "";
        blockLines.push(normalized);
        i = j;
      }
      setOwn(target, key, blockLines.join("\n"));
      stack.push({ indent, kind: "leaf", target: {}, childIndent: null });
      continue;
    }
    if (rawValue.startsWith("|") || rawValue.startsWith(">")) {
      fail(i, raw, "unsupported block indicator");
    }
    if (rawValue.startsWith("&") || rawValue.startsWith("*") || rawValue.startsWith("!")) {
      fail(i, raw, "anchor, alias or tag value");
    }
    if (rawValue.startsWith("{")) {
      fail(i, raw, "inline flow map");
    }
    if (rawValue.startsWith("[")) {
      setOwn(target, key, parseFlowArray(rawValue, () => fail(i, raw, "unsupported flow array")));
      stack.push({ indent, kind: "leaf", target: {}, childIndent: null });
      continue;
    }

    setOwn(target, key, parseScalar(rawValue));
    stack.push({ indent, kind: "leaf", target: {}, childIndent: null });
  }

  return root;
}

/** Parse frontmatter without a diagnostic label. Kept as the host-facing
 * entry point: the import sites stay unchanged while the internals become
 * the strict shared parser. */
export function parseSimpleFrontmatter(frontmatter: string): JsonObject {
  return parseDocumentFrontmatter(frontmatter, "frontmatter");
}
