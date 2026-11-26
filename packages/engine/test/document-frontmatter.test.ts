/**
 * Strict shared frontmatter reader — accepted subset and explicit refusal.
 *
 * Spec source: the shared-reader plan brief (accepted line
 * forms: root scalars, indentation nested maps, flat flow arrays, `- item`
 * block lists, `|`/`|-` block scalars, blank/comment lines; refused forms:
 * unknown lines, tabs, misindented children, flow/nested-comma constructs,
 * other block indicators, anchors/aliases/tags, duplicate keys).
 *
 * Diagnostic line numbers are document-relative: the opening `---` fence is
 * document line 1, so frontmatter text line N is document line N + 1 and
 * the expectations below assert those document positions.
 * see docs/knowledge/conventions/plan-frontmatter-declarations.md
 */
import * as fs from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DocumentFrontmatterError,
  extractFrontmatterAndBody,
  parseDocumentFrontmatter,
  parseDocumentFrontmatterEntries,
  parseSimpleFrontmatter,
} from "../src/document-frontmatter.js";
import * as engineIndex from "../src/index.js";

function expectRefusal(frontmatter: string, line: number): DocumentFrontmatterError {
  try {
    parseDocumentFrontmatter(frontmatter, "spec-source");
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentFrontmatterError);
    const typed = error as DocumentFrontmatterError;
    expect(typed.source).toBe("spec-source");
    expect(typed.line).toBe(line);
    expect(typeof typed.lineText).toBe("string");
    expect(typed.lineText).not.toBe("");
    return typed;
  }
  throw new Error(`expected DocumentFrontmatterError at line ${line}, but parsing succeeded`);
}

describe("parseDocumentFrontmatter — accepted scalar forms", () => {
  test("scalar with quotes keeps one surrounding pair removed", () => {
    expect(parseSimpleFrontmatter(`name: "hello"`)).toEqual({ name: "hello" });
    expect(parseSimpleFrontmatter(`name: 'hello'`)).toEqual({ name: "hello" });
    expect(parseSimpleFrontmatter(`name: ""`)).toEqual({ name: "" });
  });

  test("true/false/null type as booleans and null", () => {
    expect(parseSimpleFrontmatter(`a: true\nb: false\nc: null`)).toEqual({ a: true, b: false, c: null });
  });

  test("integer and decimal type as numbers", () => {
    expect(parseSimpleFrontmatter(`count: 42\nratio: -1.5`)).toEqual({ count: 42, ratio: -1.5 });
  });

  test("plain scalar stays a verbatim string (no inline-comment stripping)", () => {
    expect(parseSimpleFrontmatter(`description: keeps the # hash verbatim`)).toEqual({
      description: "keeps the # hash verbatim",
    });
  });

  test("comment and blank lines are skipped", () => {
    expect(parseSimpleFrontmatter(`# leading comment\n\nname: x\n  # indented comment\nother: y`)).toEqual({
      name: "x",
      other: "y",
    });
  });

  test("quoted key keeps its bare name", () => {
    expect(parseSimpleFrontmatter(`"*": allow`)).toEqual({ "*": "allow" });
  });

  test("quoted key containing a colon parses as the colon-bearing bare key", () => {
    expect(parseSimpleFrontmatter(`"a:b": value`)).toEqual({ "a:b": "value" });
    expect(parseSimpleFrontmatter(`'c:d': 1`)).toEqual({ "c:d": 1 });
  });

  test("__proto__ scalar is stored as an own data property", () => {
    const parsed = parseSimpleFrontmatter(`__proto__: value`);
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect((parsed as Record<string, unknown>).__proto__).toBe("value");
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

describe("parseDocumentFrontmatter — nested maps", () => {
  test("one nested map level", () => {
    expect(parseSimpleFrontmatter(`outer:\n  inner: value`)).toEqual({ outer: { inner: "value" } });
  });

  test("two-level permission/bash shape parses", () => {
    const parsed = parseSimpleFrontmatter(
      `permission:\n  bash:\n    "*": allow\n    "git diff*": deny\n  edit:\n    "*": deny`,
    );
    expect(parsed).toEqual({
      permission: {
        bash: { "*": "allow", "git diff*": "deny" },
        edit: { "*": "deny" },
      },
    });
  });

  test("siblings must repeat the first child indent", () => {
    expect(parseSimpleFrontmatter(`outer:\n  a: 1\n  b: 2`)).toEqual({ outer: { a: 1, b: 2 } });
    expectRefusal(`outer:\n  a: 1\n   b: 2`, 4);
  });

  test("key: {} is an empty map", () => {
    expect(parseSimpleFrontmatter(`empty: {}`)).toEqual({ empty: {} });
  });

  test("bare key with nothing indented under it is an empty map", () => {
    expect(parseSimpleFrontmatter(`empty:\nnext: 1`)).toEqual({ empty: {}, next: 1 });
  });

  test("the same key twice in one map refuses", () => {
    expectRefusal(`name: a\nname: b`, 3);
    expectRefusal(`outer:\n  x: 1\n  x: 2`, 4);
  });

  test("duplicate __proto__ key refuses instead of being absorbed by the prototype setter", () => {
    expectRefusal(`__proto__: a\n__proto__: b`, 3);
  });

  test("nested __proto__ map key does not change the result prototype", () => {
    const parsed = parseSimpleFrontmatter(`outer:\n  __proto__: 1`);
    const outer = parsed.outer as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(outer, "__proto__")).toBe(true);
    expect(outer.__proto__).toBe(1);
    expect(Object.getPrototypeOf(outer)).toBe(Object.prototype);
  });

  test("the same key in different maps does not collide", () => {
    expect(parseSimpleFrontmatter(`a:\n  x: 1\nb:\n  x: 2`)).toEqual({ a: { x: 1 }, b: { x: 2 } });
  });
});

describe("parseDocumentFrontmatter — flow arrays", () => {
  test("flat flow array of plain items becomes string[]", () => {
    expect(parseSimpleFrontmatter(`plans: [a, b]`)).toEqual({ plans: ["a", "b"] });
  });

  test("empty flow array becomes []", () => {
    expect(parseSimpleFrontmatter(`plans: []`)).toEqual({ plans: [] });
  });

  test("quoted flow array item with comma refuses", () => {
    expectRefusal(`plans: ["a, b"]`, 2);
  });

  test("nested flow array refuses", () => {
    expectRefusal(`plans: [[a], [b]]`, 2);
  });

  test("flow array value that does not close on the same line refuses", () => {
    expectRefusal(`plans: [a, b`, 2);
  });

  test("flow-array items starting with a YAML structural prefix refuse like scalars and block-list items", () => {
    for (const item of ["&a", "*a", "!a", "{a}", "[a]"]) {
      expectRefusal(`plans: [${item}, b]`, 2);
    }
  });

  test("a trailing separator in a document-profile flow array refuses", () => {
    expectRefusal(`plans: [a,]`, 2);
  });
});

describe("parseDocumentFrontmatter — block lists", () => {
  test("dash items under a key become string[]", () => {
    expect(parseSimpleFrontmatter(`plans:\n- one\n- two`)).toEqual({ plans: ["one", "two"] });
  });

  test("indented dash items are accepted", () => {
    expect(parseSimpleFrontmatter(`plans:\n  - one\n  - two`)).toEqual({ plans: ["one", "two"] });
  });

  test("list ends when a key at the parent indent appears", () => {
    expect(parseSimpleFrontmatter(`plans:\n- one\nother: x`)).toEqual({ plans: ["one"], other: "x" });
  });

  test("a deeper-indented second item is not a sibling of the open list", () => {
    expectRefusal(`plans:\n  - one\n    - two`, 4);
  });

  test("sibling items must repeat the first item's indent", () => {
    expectRefusal(`plans:\n  - one\n   - two`, 4);
    expect(parseSimpleFrontmatter(`plans:\n- one\n- two`)).toEqual({ plans: ["one", "two"] });
  });

  test("a dash dedent that matches no open level refuses", () => {
    expectRefusal(`outer:\n  plans:\n    - one\n - two`, 5);
  });

  test("a dash item dedented to a sibling key's indent starts that key's own list", () => {
    expect(parseSimpleFrontmatter(`outer:\n  plans:\n    - one\n  more:\n  - two`)).toEqual({
      outer: { plans: ["one"], more: ["two"] },
    });
  });
});

describe("parseDocumentFrontmatter — block scalars", () => {
  test("| joins deeper-indented lines with newlines", () => {
    expect(parseSimpleFrontmatter(`description: |\n  first line\n  second line`)).toEqual({
      description: "first line\nsecond line",
    });
  });

  test("|- behaves like | for the shipped corpus", () => {
    expect(parseSimpleFrontmatter(`description: |-\n  only line`)).toEqual({ description: "only line" });
  });

  test("block scalar ends at a line indented at or below the key", () => {
    expect(parseSimpleFrontmatter(`description: |\n  body\nnext: 1`)).toEqual({
      description: "body",
      next: 1,
    });
  });

  test("a tab in a consumed block-scalar line's indentation refuses", () => {
    expectRefusal(`description: |\n  \ttext`, 3);
    const error = expectRefusal(`description: |\n\tdeeper`, 3);
    expect(error.lineText).toBe("\tdeeper");
  });

  test("a whitespace-only tab line consumed into a block scalar refuses", () => {
    const error = expectRefusal(`description: |\n  \t\n  text`, 3);
    expect(error.lineText).toBe("  \t");
  });
});

describe("parseDocumentFrontmatter — refused line forms", () => {
  test("indented scalar child under a scalar refuses naming the line", () => {
    expectRefusal(`description: flat value\n  continued here`, 3);
  });

  test("a tab in the indentation refuses naming the line", () => {
    expectRefusal(`outer:\n\tinner: 1`, 3);
  });

  test("inline flow map value refuses naming the line", () => {
    expectRefusal(`config: {a: b}`, 2);
  });

  test("a nonblank non-key line refuses naming the line", () => {
    expectRefusal(`name: x\nthis is not a key line`, 3);
  });

  test("block indicators other than | and |- refuse", () => {
    expectRefusal(`description: >`, 2);
    expectRefusal(`description: |2`, 2);
    expectRefusal(`description: |+`, 2);
  });

  test("anchor, alias and tag values refuse", () => {
    expectRefusal(`name: &anchor value`, 2);
    expectRefusal(`name: *alias`, 2);
    expectRefusal(`name: !tag value`, 2);
    expectRefusal(`name: !!str value`, 2);
  });

  test("refusal carries source, document-relative line and lineText", () => {
    const error = expectRefusal(`a: 1\n{b: c}`, 3);
    expect(error.source).toBe("spec-source");
    expect(error.line).toBe(3);
    expect(error.lineText).toBe("{b: c}");
  });

  test("every refusal carries a fix naming the supported correction", () => {
    for (const fm of [
      `name: *alias`,
      `name: &anchor value`,
      `name: !tag value`,
      `config: {a: b}`,
      `description: >`,
      `plans: [a,]`,
      `plans:\n  - [a]`,
      `name: a\nname: b`,
      `outer:\n\tinner: 1`,
      `name: x\nthis is not a key line`,
    ]) {
      let error: DocumentFrontmatterError | null = null;
      try {
        parseDocumentFrontmatter(fm, "spec-source");
      } catch (caught) {
        error = caught as DocumentFrontmatterError;
      }
      expect(error).toBeInstanceOf(DocumentFrontmatterError);
      expect(typeof error!.fix).toBe("string");
      expect(error!.fix.length).toBeGreaterThan(0);
      expect(error!.message).toContain(error!.fix);
    }
    const alias = expectRefusal(`name: *alias`, 2);
    expect(alias.fix).toContain("quote");
    expect(alias.fix).toContain("supported scalar");
    const duplicate = expectRefusal(`name: a\nname: b`, 3);
    expect(duplicate.fix).toContain("remove");
    expect(duplicate.fix).toContain("rename");
    const tab = expectRefusal(`outer:\n\tinner: 1`, 3);
    expect(tab.fix).toContain("spaces");
    const misaligned = expectRefusal(`plans:\n  - a\n    - b`, 4);
    expect(misaligned.fix).toContain("align the item's dash with the dash of the first item");
    const childUnderScalar = expectRefusal(`name: x\n  orphan: y`, 3);
    expect(childUnderScalar.fix).toContain("key: line");
  });

  test("a flat-profile nested-map refusal names the accepted flat root shapes", () => {
    let error: DocumentFrontmatterError | null = null;
    try {
      parseDocumentFrontmatter(`plans:\n  unexpected: value`, "spec-source", "flat");
    } catch (caught) {
      error = caught as DocumentFrontmatterError;
    }
    expect(error).toBeInstanceOf(DocumentFrontmatterError);
    expect(error!.fix).toContain("flat root shapes");
    expect(error!.fix).not.toContain("nested-map form");
  });

  test("parseSimpleFrontmatter accepts a source label so a host loader names its file", () => {
    let error: DocumentFrontmatterError | null = null;
    try {
      parseSimpleFrontmatter(`name: *alias`, "agents/reviewer.md");
    } catch (caught) {
      error = caught as DocumentFrontmatterError;
    }
    expect(error).toBeInstanceOf(DocumentFrontmatterError);
    expect(error!.source).toBe("agents/reviewer.md");
    expect(error!.message).toContain("agents/reviewer.md:2");
  });

  test("document positions are reported for frontmatter extracted from a fence", () => {
    const document = `---\nname: x\ninvalid line\n---\nbody`;
    const { frontmatter } = extractFrontmatterAndBody(document);
    // `invalid line` is frontmatter index 1 → document line 3 (`---` is line 1).
    // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
    const error = expectRefusal(frontmatter, 3);
    expect(error.lineText).toBe("invalid line");
  });

  test("key:value without a space after the colon parses in both profiles", () => {
    expect(parseSimpleFrontmatter(`target_branch:main`)).toEqual({ target_branch: "main" });
    const flat = parseDocumentFrontmatterEntries(`target_branch:main`, "spec-source", "flat");
    expect(flat.get("target_branch")).toEqual({ value: "main", rawText: "main", line: 2, kind: "scalar" });
  });
});

describe("parseDocumentFrontmatterEntries — entry-level flat profile", () => {
  test("entries carry value, original scalar text, document line and kind", () => {
    const entries = parseDocumentFrontmatterEntries(`name: x\nplans: [a, b]\nnote:`, "spec-source");
    expect(entries.get("name")).toEqual({ value: "x", rawText: "x", line: 2, kind: "scalar" });
    expect(entries.get("plans")).toEqual({ value: ["a", "b"], rawText: "[a, b]", line: 3, kind: "list" });
    expect(entries.get("note")).toEqual({ value: {}, rawText: "", line: 4, kind: "map" });
  });

  test("a bare key that becomes a block list reports the list kind", () => {
    const entries = parseDocumentFrontmatterEntries(`plans:\n- one\n- two`, "spec-source", "flat");
    expect(entries.get("plans")).toEqual({ value: ["one", "two"], rawText: "", line: 2, kind: "list" });
  });

  test("flat scalars decode their declaration text but never type it", () => {
    const entries = parseDocumentFrontmatterEntries(
      `flag: true\ncount: 42\nnote: {}\nanchor: &value\nfolded: >\nstatus: "active"\nname: 'locked'`,
      "spec-source",
      "flat",
    );
    expect(entries.get("flag")!.value).toBe("true");
    expect(entries.get("count")!.value).toBe("42");
    expect(entries.get("note")).toEqual({ value: "{}", rawText: "{}", line: 4, kind: "scalar" });
    expect(entries.get("anchor")!.value).toBe("&value");
    expect(entries.get("folded")!.value).toBe(">");
    // One boundary quote pair strips so a consumer compares the written
    // declaration; `rawText` keeps the source lexeme.
    // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
    expect(entries.get("status")).toEqual({ value: "active", rawText: '"active"', line: 7, kind: "scalar" });
    expect(entries.get("name")).toEqual({ value: "locked", rawText: "'locked'", line: 8, kind: "scalar" });
  });

  test("a one-sided or mismatched boundary quote is literal text, never a stripped pair", () => {
    // Only a matching PAIR is syntax: stripping one side would decode
    // `enforcement: hard'` to `hard` and activate hard enforcement on a typo.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    const entries = parseDocumentFrontmatterEntries(
      [`a: hard'`, `b: 'hard`, `c: "hard'`, `d: 'hard"`, `e: '"hard'`].join("\n"),
      "spec-source",
      "flat",
    );
    expect(entries.get("a")!.value).toBe("hard'");
    expect(entries.get("b")!.value).toBe("'hard");
    expect(entries.get("c")!.value).toBe(`"hard'`);
    expect(entries.get("d")!.value).toBe(`'hard"`);
    // A mismatched pair whose outer quotes still match is stripped: the inner
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    // quote is the value's own text.
    expect(entries.get("e")!.value).toBe(`"hard`);
  });

  test("a double-quoted flat scalar decodes the JSON escape set, an invalid escape stays literal", () => {
    // The roadmap export writes values with `JSON.stringify`, so every escape
    // it can emit must decode back to the written character; an escape JSON
    // does not accept is not syntax and keeps the whole scalar's literal text.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    const entries = parseDocumentFrontmatterEntries(
      [
        `n: "a\\nb"`,
        `t: "a\\tb"`,
        `r: "a\\rb"`,
        `quote: "a\\"b"`,
        `backslash: "a\\\\b"`,
        `slash: "a\\/b"`,
        `backspace: "a\\bb"`,
        `formfeed: "a\\fb"`,
        `unicode: "caf\\u00e9"`,
        `invalid: "a\\qb"`,
      ].join("\n"),
      "spec-source",
      "flat",
    );
    expect(entries.get("n")!.value).toBe("a\nb");
    expect(entries.get("t")!.value).toBe("a\tb");
    expect(entries.get("r")!.value).toBe("a\rb");
    expect(entries.get("quote")!.value).toBe(`a"b`);
    expect(entries.get("backslash")!.value).toBe("a\\b");
    expect(entries.get("slash")!.value).toBe("a/b");
    expect(entries.get("backspace")!.value).toBe("a\bb");
    expect(entries.get("formfeed")!.value).toBe("a\fb");
    expect(entries.get("unicode")!.value).toBe("café");
    expect(entries.get("invalid")!.value).toBe("a\\qb");
  });

  test("a nested map refuses in the flat profile with source, line and line text", () => {
    let error: DocumentFrontmatterError | null = null;
    try {
      parseDocumentFrontmatterEntries(`plans:\n  unexpected: value`, "spec-source", "flat");
    } catch (caught) {
      error = caught as DocumentFrontmatterError;
    }
    expect(error).toBeInstanceOf(DocumentFrontmatterError);
    expect(error!.source).toBe("spec-source");
    expect(error!.line).toBe(3);
    expect(error!.lineText).toBe("  unexpected: value");
    expect(error!.message).toContain("nested map in flat frontmatter");
  });

  test("a block scalar refuses in the flat profile with source, line and line text", () => {
    let error: DocumentFrontmatterError | null = null;
    try {
      parseDocumentFrontmatterEntries(`description: |\n  body`, "spec-source", "flat");
    } catch (caught) {
      error = caught as DocumentFrontmatterError;
    }
    expect(error).toBeInstanceOf(DocumentFrontmatterError);
    expect(error!.line).toBe(2);
    expect(error!.lineText).toBe("description: |");
    expect(error!.message).toContain("block scalar in flat frontmatter");
  });

  test("the document profile still refuses YAML structural prefixes as block-list items", () => {
    for (const item of ["&value", "*x", "!x", "{a}", "[a]"]) {
      expect(() => parseDocumentFrontmatterEntries(`plans:\n  - ${item}`, "spec-source")).toThrow(/unsupported list item/);
    }
    const flat = parseDocumentFrontmatterEntries(`plans:\n  - &value\n  - [a]`, "spec-source", "flat");
    expect(flat.get("plans")!.value).toEqual(["&value", "[a]"]);
  });

  test("the flat profile skips a trailing separator and refuses interior brackets in flow lists", () => {
    const trailing = parseDocumentFrontmatterEntries(`plans: [p1,]`, "spec-source", "flat");
    expect(trailing.get("plans")!.value).toEqual(["p1"]);
    expect(() => parseDocumentFrontmatterEntries(`plans: [p1[0]]`, "spec-source", "flat")).toThrow(/unsupported flow array/);
  });

  test("the flat profile keeps flow-list items with structural prefixes as plain strings", () => {
    const entries = parseDocumentFrontmatterEntries(`plans: [&a, *x]`, "spec-source", "flat");
    expect(entries.get("plans")!.value).toEqual(["&a", "*x"]);
  });

  test("the document profile still accepts nested maps and block scalars", () => {
    const entries = parseDocumentFrontmatterEntries(`outer:\n  inner: value\nbody: |\n  text`, "spec-source");
    expect(entries.get("outer")!.kind).toBe("map");
    expect(entries.get("body")).toEqual({ value: "text", rawText: "|", line: 4, kind: "block-scalar" });
  });
});

describe("extractFrontmatterAndBody — fence handling", () => {
  test("document without a fence is all body with empty frontmatter", () => {
    expect(extractFrontmatterAndBody(`no fence here`)).toEqual({ frontmatter: "", body: "no fence here", fenced: false });
  });

  test("fenced document splits frontmatter and body", () => {
    expect(extractFrontmatterAndBody(`---\nname: x\n---\nbody text`)).toEqual({
      frontmatter: "name: x",
      body: "body text",
      fenced: true,
    });
  });

  test("CRLF fences are tolerated", () => {
    expect(extractFrontmatterAndBody(`---\r\nname: x\r\n---\r\nbody`)).toEqual({
      frontmatter: "name: x",
      body: "body",
      fenced: true,
    });
  });

  test("an unterminated fence is body, not frontmatter", () => {
    expect(extractFrontmatterAndBody(`---\nname: x`)).toEqual({ frontmatter: "", body: "---\nname: x", fenced: false });
  });

  test("a complete empty frontmatter block extracts empty frontmatter and the body", () => {
    expect(extractFrontmatterAndBody(`---\n\n---\nbody`)).toEqual({ frontmatter: "", body: "body", fenced: true });
  });

  test("an unterminated fence never counts as frontmatter", () => {
    expect(extractFrontmatterAndBody(`---\nname: x`)).toEqual({ frontmatter: "", body: "---\nname: x", fenced: false });
    expect(extractFrontmatterAndBody(`---\n`)).toEqual({ frontmatter: "", body: "---\n", fenced: false });
  });

  test("a scalar containing --- inside a line does not close an unterminated document", () => {
    expect(extractFrontmatterAndBody(`---\nname: a---b`)).toEqual({ frontmatter: "", body: "---\nname: a---b", fenced: false });
    expect(extractFrontmatterAndBody(`---\nname: a---b\nnotes: more`)).toEqual({ frontmatter: "", body: "---\nname: a---b\nnotes: more", fenced: false });
  });

  test("a scalar containing --- inside a line is not truncated in a fenced document", () => {
    expect(extractFrontmatterAndBody(`---\nname: a---b\nnotes: x\n---\nbody`)).toEqual({
      frontmatter: "name: a---b\nnotes: x",
      body: "body",
      fenced: true,
    });
  });

  test("a closing fence at end of input without a trailing newline still closes", () => {
    expect(extractFrontmatterAndBody(`---\nname: x\n---`)).toEqual({ frontmatter: "name: x", body: "", fenced: true });
  });

  test("an immediately closed empty block stays valid", () => {
    expect(extractFrontmatterAndBody(`---\n---\nbody`)).toEqual({ frontmatter: "", body: "body", fenced: true });
    expect(extractFrontmatterAndBody(`---\n---`)).toEqual({ frontmatter: "", body: "", fenced: true });
  });

  test("a closing fence at end of input accepts LF, CRLF and exact EOF but not a bare CR", () => {
    // The exact-EOF close was always valid; LF and CRLF close through their
    // `\n`. A lone `\r` is not a line ending — `---\r` stays content.
    // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
    expect(extractFrontmatterAndBody(`---\nname: x\n---\n`)).toEqual({ frontmatter: "name: x", body: "", fenced: true });
    expect(extractFrontmatterAndBody(`---\r\nname: x\r\n---\r\n`)).toEqual({ frontmatter: "name: x", body: "", fenced: true });
    expect(extractFrontmatterAndBody(`---\nname: x\n---`)).toEqual({ frontmatter: "name: x", body: "", fenced: true });
    expect(extractFrontmatterAndBody(`---\nname: x\n---\r`)).toEqual({ frontmatter: "", body: `---\nname: x\n---\r`, fenced: false });
  });

  test("an immediately closed header never consumes a later horizontal rule in the body", () => {
    expect(extractFrontmatterAndBody(`---\n---\n# Heading\n\n---\nRest`)).toEqual({
      frontmatter: "",
      body: "# Heading\n\n---\nRest",
      fenced: true,
    });
    expect(extractFrontmatterAndBody(`---\r\n---\r\n# Heading\r\n\r\n---\r\nRest`)).toEqual({
      frontmatter: "",
      body: "# Heading\r\n\r\n---\r\nRest",
      fenced: true,
    });
  });

  test("a non-empty header never extends past its first closing line to a later rule", () => {
    expect(extractFrontmatterAndBody(`---\nname: x\n---\n# Heading\n\n---\nRest`)).toEqual({
      frontmatter: "name: x",
      body: "# Heading\n\n---\nRest",
      fenced: true,
    });
  });
});

describe("shipped corpus — every bundled frontmatter parses", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  // Corpus rule: a file whose first line opens a fence claims frontmatter.
  // The extractor's `fenced` bit — after confirming that opening fence —
  // is the single arbiter of whether frontmatter exists; no second fence
  // grammar lives here. The sweep itself must find files, or the guard
  // proves nothing (an empty sweep is a failure, not a green pass).
  // see docs/knowledge/conventions/brief-acceptance-declarations.md

  const skillDir = join(repoRoot, "skills");
  const skillFiles = fs
    .readdirSync(skillDir)
    .map((entry) => join(skillDir, entry, "SKILL.md"))
    .filter((file) => fs.existsSync(file));

  const collectMarkdown = (dir: string): string[] => {
    const absolute = join(repoRoot, dir);
    if (!fs.existsSync(absolute)) return [];
    return fs
      .readdirSync(absolute)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join(absolute, entry));
  };
  const commandFiles = collectMarkdown("commands");
  const agentFiles = collectMarkdown("agents");
  const codexAgentFiles = collectMarkdown("codex/agents");
  const corpusFiles = [...skillFiles, ...commandFiles, ...agentFiles, ...codexAgentFiles];

  test("the sweep finds corpus files — an empty sweep proves nothing", () => {
    expect(corpusFiles.length).toBeGreaterThan(0);
    expect(skillFiles.length).toBeGreaterThan(0);
    expect(commandFiles.length).toBeGreaterThan(0);
    expect(agentFiles.length).toBeGreaterThan(0);
  });

  test("every shipped frontmatter parses without refusal", () => {
    const failures: string[] = [];
    for (const file of corpusFiles) {
      const content = fs.readFileSync(file, "utf8");
      const { frontmatter, fenced } = extractFrontmatterAndBody(content);
      if (/^---\r?\n/.test(content) && !fenced) {
        failures.push(`${file}: claims an opening fence but has no complete fence`);
        continue;
      }
      if (!fenced || frontmatter === "") continue;
      try {
        parseDocumentFrontmatter(frontmatter, file);
      } catch (error) {
        failures.push(`${file}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("engine entry point — the strict reader and its error are package-root exports", () => {
  test("parseDocumentFrontmatter and DocumentFrontmatterError resolve from src/index", () => {
    expect(typeof engineIndex.parseDocumentFrontmatter).toBe("function");
    expect(engineIndex.DocumentFrontmatterError).toBe(DocumentFrontmatterError);
    expect(engineIndex.parseDocumentFrontmatter).toBe(parseDocumentFrontmatter);
    expect(typeof engineIndex.parseSimpleFrontmatter).toBe("function");
    expect(engineIndex.extractFrontmatterAndBody).toBe(extractFrontmatterAndBody);
  });
});
