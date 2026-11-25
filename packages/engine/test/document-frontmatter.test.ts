/**
 * Strict shared frontmatter reader — accepted subset and explicit refusal.
 *
 * Spec source: plan `20261125-frontmatter-core` Task 1 brief (accepted line
 * forms: root scalars, indentation nested maps, flat flow arrays, `- item`
 * block lists, `|`/`|-` block scalars, blank/comment lines; refused forms:
 * unknown lines, tabs, misindented children, flow/nested-comma constructs,
 * other block indicators, anchors/aliases/tags, duplicate keys).
 *
 * Diagnostic line numbers are document-relative: the opening `---` fence is
 * document line 1, so frontmatter text line N is document line N + 1 and
 * the expectations below assert those document positions.
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

  test("document positions are reported for frontmatter extracted from a fence", () => {
    const document = `---\nname: x\ninvalid line\n---\nbody`;
    const { frontmatter } = extractFrontmatterAndBody(document);
    // `invalid line` is frontmatter index 1 → document line 3 (`---` is line 1).
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

  test("flat scalars keep their source text verbatim: no typing, no quote stripping", () => {
    const entries = parseDocumentFrontmatterEntries(
      `flag: true\ncount: 42\nnote: {}\nanchor: &value\nfolded: >`,
      "spec-source",
      "flat",
    );
    expect(entries.get("flag")!.value).toBe("true");
    expect(entries.get("count")!.value).toBe("42");
    expect(entries.get("note")).toEqual({ value: "{}", rawText: "{}", line: 4, kind: "scalar" });
    expect(entries.get("anchor")!.value).toBe("&value");
    expect(entries.get("folded")!.value).toBe(">");
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

  test("the document profile still accepts nested maps and block scalars", () => {
    const entries = parseDocumentFrontmatterEntries(`outer:\n  inner: value\nbody: |\n  text`, "spec-source");
    expect(entries.get("outer")!.kind).toBe("map");
    expect(entries.get("body")).toEqual({ value: "text", rawText: "|", line: 4, kind: "block-scalar" });
  });
});

describe("extractFrontmatterAndBody — fence handling", () => {
  test("document without a fence is all body with empty frontmatter", () => {
    expect(extractFrontmatterAndBody(`no fence here`)).toEqual({ frontmatter: "", body: "no fence here" });
  });

  test("fenced document splits frontmatter and body", () => {
    expect(extractFrontmatterAndBody(`---\nname: x\n---\nbody text`)).toEqual({
      frontmatter: "name: x",
      body: "body text",
    });
  });

  test("CRLF fences are tolerated", () => {
    expect(extractFrontmatterAndBody(`---\r\nname: x\r\n---\r\nbody`)).toEqual({
      frontmatter: "name: x",
      body: "body",
    });
  });

  test("an unterminated fence is body, not frontmatter", () => {
    expect(extractFrontmatterAndBody(`---\nname: x`)).toEqual({ frontmatter: "", body: "---\nname: x" });
  });

  test("a complete empty frontmatter block extracts empty frontmatter and the body", () => {
    expect(extractFrontmatterAndBody(`---\n\n---\nbody`)).toEqual({ frontmatter: "", body: "body" });
  });

  test("an unterminated fence never counts as frontmatter", () => {
    expect(extractFrontmatterAndBody(`---\nname: x`)).toEqual({ frontmatter: "", body: "---\nname: x" });
    expect(extractFrontmatterAndBody(`---\n`)).toEqual({ frontmatter: "", body: "---\n" });
  });
});

describe("shipped corpus — every bundled frontmatter parses", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  // A file starting with an opening fence line claims frontmatter; an
  // unterminated fence extracts nothing and must not count as parsed.

  const skillDir = join(repoRoot, "skills");
  const skillFiles = fs
    .readdirSync(skillDir)
    .map((entry) => join(skillDir, entry, "SKILL.md"))
    .filter((file) => fs.existsSync(file));

  const collectMarkdown = (dir: string): string[] => {
    const absolute = join(repoRoot, dir);
    return fs
      .readdirSync(absolute)
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => join(absolute, entry));
  };
  const commandFiles = collectMarkdown("commands");
  const agentFiles = collectMarkdown("agents");
  // `codex/agents` holds no Markdown today — the directory ships `.toml`
  // agent definitions only — so it is not a corpus the guard can assert
  // on; the day it gains `*.md` files they join the sweep below.
  const codexAgentFiles = collectMarkdown("codex/agents");

  test("the skills corpus matches SKILL.md files", () => {
    expect(skillFiles.length).toBeGreaterThan(0);
  });

  test("the commands corpus matches Markdown files", () => {
    expect(commandFiles.length).toBeGreaterThan(0);
  });

  test("the agents corpus matches Markdown files", () => {
    expect(agentFiles.length).toBeGreaterThan(0);
  });

  test("codex/agents currently holds no Markdown — update the sweep when it does", () => {
    expect(codexAgentFiles.length).toBe(0);
  });

  test("every shipped frontmatter parses without refusal", () => {
    const corpusFiles = [...skillFiles, ...commandFiles, ...agentFiles, ...codexAgentFiles];
    const failures: string[] = [];
    for (const file of corpusFiles) {
      const content = fs.readFileSync(file, "utf8");
      const { frontmatter } = extractFrontmatterAndBody(content);
      if (/^---\r?\n/.test(content) && !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(content)) {
        failures.push(`${file}: claims an opening fence but has no complete fence`);
        continue;
      }
      if (frontmatter === "") continue;
      try {
        parseDocumentFrontmatter(frontmatter, file);
      } catch (error) {
        failures.push(`${file}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
