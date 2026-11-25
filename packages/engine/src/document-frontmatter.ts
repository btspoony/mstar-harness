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

export type FrontmatterAndBody = { frontmatter: string; body: string; fenced: boolean };

/** Parser behavior profile. `document` (the default, host loaders) is the
 * strict accepted subset below. `flat` is the delivery-compass contract:
 * root scalars, flat flow arrays and `- item` block lists only — a nested
 * map or a `|`/`|-` block scalar refuses with its line, and scalar values
 * keep their source text verbatim (no typing, no quote stripping) because
 * the compass contract never typed them. */
export type FrontmatterProfile = "document" | "flat";

export type FrontmatterEntryKind = "scalar" | "list" | "map" | "block-scalar";

/** One parsed root key: the structured value, the original scalar text after
 * the key's colon (`""` for a bare `key:`), the 1-based document line of the
 * key line and the structural kind. The single-pass companion of
 * `parseDocumentFrontmatter`: adapters read entries instead of rescanning
 * the frontmatter lines a second time. */
export type FrontmatterEntry = {
  value: unknown;
  rawText: string;
  line: number;
  kind: FrontmatterEntryKind;
};

/** Refusal of a frontmatter line outside the accepted subset. `source` is a
 * diagnostic label only (the caller names the document); `line` is the
 * 1-based line in the source document — the opening fence is document
 * line 1, so the first frontmatter text line is line 2 — and `lineText`
 * is the offending raw line. Every refusal carries `fix`, the supported
 * correction: quote the value when it is literal text, or replace an
 * alias/anchor/tag construct with the supported scalar value. */
export class DocumentFrontmatterError extends Error {
  readonly source: string;
  readonly line: number;
  readonly lineText: string;
  readonly fix: string;

  constructor(source: string, line: number, lineText: string, reason: string, fix: string) {
    super(`${source}:${line}: ${reason}: ${JSON.stringify(lineText)} (fix: ${fix})`);
    this.name = "DocumentFrontmatterError";
    this.source = source;
    this.line = line;
    this.lineText = lineText;
    this.fix = fix;
  }
}

/** Split a document into its frontmatter block and body by scanning lines:
 * the closing fence is the first complete `---` line after the opener —
 * never a later one found by backtracking, so an immediately closed empty
 * header never consumes a horizontal rule inside the body. A `---` inside
 * a scalar line never counts. A document with no fence (or an unterminated
 * one) returns the whole content as its body, an empty frontmatter and
 * `fenced: false`; a closed fence — even one wrapping only whitespace —
 * returns `fenced: true`, so a present-but-empty fence is distinguishable
 * from an absent one. CRLF is accepted because the commands doctor
 * classifies SKILL.md files the OpenCode loaders never see, and both must
 * agree on what has a fence. */
export function extractFrontmatterAndBody(content: string): FrontmatterAndBody {
  const notFenced: FrontmatterAndBody = { frontmatter: "", body: content, fenced: false };
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return notFenced;
  }
  const contentStart = content.indexOf("\n") + 1;
  let lineStart = contentStart;
  while (lineStart < content.length) {
    const newlineAt = content.indexOf("\n", lineStart);
    const lineEnd = newlineAt === -1 ? content.length : newlineAt;
    const textEnd = content[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    if (content.slice(lineStart, textEnd) === "---") {
      // The closing fence never consumes the line ending that precedes
      // it, so the frontmatter block of `---\nfoo\n---` is `foo`.
      let frontmatterEnd = lineStart;
      if (content[frontmatterEnd - 1] === "\n") {
        frontmatterEnd -= 1;
        if (content[frontmatterEnd - 1] === "\r") frontmatterEnd -= 1;
      }
      const frontmatter = content.slice(contentStart, frontmatterEnd);
      const body = newlineAt === -1 ? "" : content.slice(newlineAt + 1);
      return { frontmatter, body, fenced: true };
    }
    if (newlineAt === -1) break;
    lineStart = newlineAt + 1;
  }
  return notFenced;
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
 * instead of storing the key. Shared with the compass adapter, which faces
 * the same accepted-key contract. */
export function setOwn(target: JsonObject, key: string, value: unknown): void {
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
  entry?: FrontmatterEntry;
}

/** Parse a flat flow array (`[a, b]`, `[]`) into trimmed string items. A
 * comma inside a quoted item is ambiguous after a naive split, so quoted
 * items containing commas refuse outright in both profiles. Prefix rules
 * are per profile: the strict `document` profile refuses empty items,
 * bracket starts and the YAML structural prefixes (`&`, `*`, `!`); the
 * `flat` compass profile keeps its old contract — empty parts (a trailing
 * separator) are skipped, any interior `[`/`]` bracket refuses, and no
 * item prefix rules apply. */
function parseFlowArray(raw: string, profile: FrontmatterProfile, fail: () => never): string[] {
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
    if (item === "") {
      // A trailing separator yields an empty part, which the flat compass
      // contract always discarded; the strict document profile refuses it.
      if (profile === "flat") continue;
      fail();
    }
    if (profile === "flat") {
      if (item.includes("[") || item.includes("]")) {
        fail();
      }
      items.push(item);
      continue;
    }
    if (
      item.startsWith("[") ||
      item.startsWith("]") ||
      item.startsWith("{") ||
      item.startsWith("&") ||
      item.startsWith("*") ||
      item.startsWith("!")
    ) {
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

/** One structural pass over the accepted frontmatter subset. Returns the
 * parsed root object and, for every root key, its entry with the original
 * scalar text — the single interpretation adapters consume instead of
 * rescanning lines. Any other line form throws `DocumentFrontmatterError`
 * with the source label, the 1-based line in the document the frontmatter
 * was extracted from and the offending raw line. */
function parseFrontmatterStructure(
  frontmatter: string,
  source: string,
  profile: FrontmatterProfile,
  collectEntries: boolean,
): { root: JsonObject; entries: Map<string, FrontmatterEntry> | null } {
  const lines = frontmatter.split(/\r?\n/);
  const fail = (lineIndex: number, lineText: string, reason: string, fix?: string): never => {
    // `+ 2` because the diagnostic contract is document-relative: the
    // opening `---` fence is document line 1, frontmatter line 0 is line 2.
    throw new DocumentFrontmatterError(
      source,
      lineIndex + 2,
      lineText,
      reason,
      fix ?? "rewrite the line as a supported key: scalar, list or nested-map form",
    );
  };

  const root: JsonObject = {};
  const entries = collectEntries ? new Map<string, FrontmatterEntry>() : null;
  const rootLevel: Level = { indent: -1, kind: "map", target: root, childIndent: null };
  const stack: Level[] = [rootLevel];
  /** Record the entry when a root-level key gains its value. */
  const assign = (
    target: JsonObject,
    key: string,
    value: unknown,
    lineIndex: number,
    rawText: string,
    kind: FrontmatterEntryKind,
  ): FrontmatterEntry | undefined => {
    setOwn(target, key, value);
    if (target !== root || entries === null) return undefined;
    const entry: FrontmatterEntry = { value, rawText, line: lineIndex + 2, kind };
    entries.set(key, entry);
    return entry;
  };

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
        if (top.entry) {
          top.entry.value = list;
          top.entry.kind = "list";
        }
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
      // An empty item is refused in both profiles. The document profile
      // additionally refuses YAML structural prefixes — they would resolve
      // to shapes outside the accepted subset — while the flat compass
      // profile keeps the old compass contract: `- &value`, `- *x`,
      // `- !x`, `- {a}`, `- [a]` are accepted as plain strings.
      if (
        item === "" ||
        (profile === "document" &&
          (item.startsWith("[") ||
            item.startsWith("{") ||
            item.startsWith("&") ||
            item.startsWith("*") ||
            item.startsWith("!")))
      ) {
        fail(
          i,
          raw,
          "unsupported list item",
          "quote the item when it is literal text, or replace the alias, anchor, tag or flow construct with a supported scalar value",
        );
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
      // The first child of a bare `key:` is a key line: it is a nested map,
      // which the compass flat profile refuses instead of silently dropping.
      if (profile === "flat") {
        fail(i, raw, "nested map in flat frontmatter");
      }
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
    const keyRaw = trimmed.slice(0, separator).trim();
    // NOTE: compute the key without `let` — a `let` captured by the
    // `assign` closure would lose TypeScript's definite-assignment narrowing.
    const key: string = BARE_KEY.test(keyRaw)
      ? keyRaw
      : keyRaw.length >= 2 &&
          (keyRaw[0] === '"' || keyRaw[0] === "'") &&
          keyRaw[keyRaw.length - 1] === keyRaw[0]
        ? keyRaw.slice(1, -1)
        : fail(i, raw, "unsupported key");
    const rawValue = trimmed.slice(separator + 1).trim();

    const target = container.target as JsonObject;
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      fail(i, raw, `duplicate key ${JSON.stringify(key)}`);
    }

    if (rawValue === "") {
      // Bare `key:` opens either a nested map or a `- item` list; until the
      // first child line decides, it is the host's empty-map result.
      const child: JsonObject = {};
      const entry = assign(target, key, child, i, rawValue, "map");
      stack.push({ indent, kind: "pending", target: child, key, parent: target, childIndent: null, entry });
      continue;
    }
    if (rawValue === "{}" && profile === "document") {
      assign(target, key, {}, i, rawValue, "map");
      stack.push({ indent, kind: "leaf", target: {}, childIndent: null });
      continue;
    }
    if ((rawValue === "|" || rawValue === "|-") && profile === "flat") {
      // The flat compass contract never had block scalars: the content
      // lines under the key would be silently swallowed, so refuse at the
      // key line instead.
      fail(i, raw, "block scalar in flat frontmatter");
    }
    if (rawValue === "|" || rawValue === "|-") {
      // Block scalar: deeper-indented lines join with `\n`; blank lines
      // inside the block stay empty, the block ends at the first nonblank
      // line indented at or below the key. Every consumed line gets the
      // same tab-in-indentation refusal as any other frontmatter line.
      const keyLineIndex = i;
      const blockLines: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const blockLine = lines[j];
        const blockLeading = blockLine.match(/^[ \t]*/)?.[0] ?? "";
        if (blockLeading.includes("\t")) {
          fail(j, blockLine, "tab in indentation");
        }
        const blockIndent = blockLeading.length;
        if (blockLine.trim() && blockIndent <= indent) break;
        // The tab refusal above guarantees the measured indentation is
        // spaces, so comparing the indent directly decides the slice.
        const normalized =
          blockIndent >= indent + 2
            ? blockLine.slice(indent + 2)
            : blockLine.trim()
              ? blockLine.trim()
              : "";
        blockLines.push(normalized);
        i = j;
      }
      assign(target, key, blockLines.join("\n"), keyLineIndex, rawValue, "block-scalar");
      stack.push({ indent, kind: "leaf", target: {}, childIndent: null });
      continue;
    }
    if (profile === "document") {
      if (rawValue.startsWith("|") || rawValue.startsWith(">")) {
        fail(i, raw, "unsupported block indicator");
      }
      if (rawValue.startsWith("&") || rawValue.startsWith("*") || rawValue.startsWith("!")) {
        fail(
          i,
          raw,
          "anchor, alias or tag value",
          "quote the value when it is literal text, or replace the anchor, alias or tag with the supported scalar value",
        );
      }
      if (rawValue.startsWith("{")) {
        fail(
          i,
          raw,
          "inline flow map",
          "write the map as indented key: lines under the key, or quote the value when it is literal text",
        );
      }
    }
    if (rawValue.startsWith("[") && (profile === "document" || /^\[.*\]$/.test(rawValue))) {
      assign(
        target,
        key,
        parseFlowArray(rawValue, profile, () =>
          fail(
            i,
            raw,
            "unsupported flow array",
            "write the list as indented `- item` lines, or rewrite it as a flat array of plain scalar items: [a, b]",
          ),
        ),
        i,
        rawValue,
        "list",
      );
      stack.push({ indent, kind: "leaf", target: {}, childIndent: null });
      continue;
    }

    // In the flat profile a scalar keeps its source text verbatim — the
    // compass contract never typed `true`/numbers/`null` and never stripped
    // quotes in the shared reader's sense, so adapters decode what they need.
    assign(target, key, profile === "flat" ? rawValue : parseScalar(rawValue), i, rawValue, "scalar");
    stack.push({ indent, kind: "leaf", target: {}, childIndent: null });
  }

  return { root, entries };
}

/** Parse the strict accepted subset of harness frontmatter. Any other line
 * form throws `DocumentFrontmatterError` with the source label, the 1-based
 * line in the document the frontmatter was extracted from and the offending
 * raw line. The host object path never allocates the entry map — adapters
 * that need per-key metadata use the entry API instead. */
export function parseDocumentFrontmatter(
  frontmatter: string,
  source: string,
  profile: FrontmatterProfile = "document",
): JsonObject {
  return parseFrontmatterStructure(frontmatter, source, profile, false).root;
}

/** Entry-level companion of `parseDocumentFrontmatter` from the same single
 * structural pass: per root key, the value, original scalar text, 1-based
 * document line and kind. Adapters consuming entries never rescan lines. */
export function parseDocumentFrontmatterEntries(
  frontmatter: string,
  source: string,
  profile: FrontmatterProfile = "document",
): Map<string, FrontmatterEntry> {
  return parseFrontmatterStructure(frontmatter, source, profile, true).entries!;
}

/** Parse frontmatter with an optional diagnostic label: a host loader passes
 * the file it is reading so a refusal names the offending document; with no
 * label the source reads `frontmatter`. */
export function parseSimpleFrontmatter(frontmatter: string, source = "frontmatter"): JsonObject {
  return parseDocumentFrontmatter(frontmatter, source);
}
