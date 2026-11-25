/**
 * Strict shared frontmatter reader — accepted subset and explicit refusal.
 *
 * Spec source: plan `20261125-frontmatter-core` Task 1 brief (accepted line
 * forms: root scalars, indentation nested maps, flat flow arrays, `- item`
 * block lists, `|`/`|-` block scalars, blank/comment lines; refused forms:
 * unknown lines, tabs, misindented children, flow/nested-comma constructs,
 * other block indicators, anchors/aliases/tags, duplicate keys).
 */
import * as fs from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DocumentFrontmatterError,
  extractFrontmatterAndBody,
  parseDocumentFrontmatter,
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
    expectRefusal(`outer:\n  a: 1\n   b: 2`, 3);
  });

  test("key: {} is an empty map", () => {
    expect(parseSimpleFrontmatter(`empty: {}`)).toEqual({ empty: {} });
  });

  test("bare key with nothing indented under it is an empty map", () => {
    expect(parseSimpleFrontmatter(`empty:\nnext: 1`)).toEqual({ empty: {}, next: 1 });
  });

  test("the same key twice in one map refuses", () => {
    expectRefusal(`name: a\nname: b`, 2);
    expectRefusal(`outer:\n  x: 1\n  x: 2`, 3);
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
    expectRefusal(`plans: ["a, b"]`, 1);
  });

  test("nested flow array refuses", () => {
    expectRefusal(`plans: [[a], [b]]`, 1);
  });

  test("flow array value that does not close on the same line refuses", () => {
    expectRefusal(`plans: [a, b`, 1);
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
});

describe("parseDocumentFrontmatter — refused line forms", () => {
  test("indented scalar child under a scalar refuses naming the line", () => {
    expectRefusal(`description: flat value\n  continued here`, 2);
  });

  test("a tab in the indentation refuses naming the line", () => {
    expectRefusal(`outer:\n\tinner: 1`, 2);
  });

  test("inline flow map value refuses naming the line", () => {
    expectRefusal(`config: {a: b}`, 1);
  });

  test("a nonblank non-key line refuses naming the line", () => {
    expectRefusal(`name: x\nthis is not a key line`, 2);
  });

  test("block indicators other than | and |- refuse", () => {
    expectRefusal(`description: >`, 1);
    expectRefusal(`description: |2`, 1);
    expectRefusal(`description: |+`, 1);
  });

  test("anchor, alias and tag values refuse", () => {
    expectRefusal(`name: &anchor value`, 1);
    expectRefusal(`name: *alias`, 1);
    expectRefusal(`name: !tag value`, 1);
    expectRefusal(`name: !!str value`, 1);
  });

  test("refusal carries source, line and lineText", () => {
    const error = expectRefusal(`a: 1\n{b: c}`, 2);
    expect(error.source).toBe("spec-source");
    expect(error.line).toBe(2);
    expect(error.lineText).toBe("{b: c}");
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
});

describe("shipped corpus — every bundled frontmatter parses", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const corpusDirs = ["skills", "commands", "agents", "codex/agents"];
  const corpusFiles: string[] = [];
  for (const dir of corpusDirs) {
    const absolute = join(repoRoot, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute)) {
      if (entry.endsWith(".md") || entry === "SKILL.md") {
        corpusFiles.push(join(absolute, entry));
      }
    }
    if (dir === "skills") {
      for (const entry of fs.readdirSync(absolute)) {
        const skillFile = join(absolute, entry, "SKILL.md");
        if (fs.existsSync(skillFile)) corpusFiles.push(skillFile);
      }
    }
  }

  test("corpus glob is non-empty", () => {
    expect(corpusFiles.length).toBeGreaterThan(0);
  });

  test("every shipped frontmatter parses without refusal", () => {
    const failures: string[] = [];
    for (const file of corpusFiles) {
      const content = fs.readFileSync(file, "utf8");
      const { frontmatter } = extractFrontmatterAndBody(content);
      try {
        parseDocumentFrontmatter(frontmatter, file);
      } catch (error) {
        failures.push(`${file}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
