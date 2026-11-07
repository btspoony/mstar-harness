/**
 * scripts/markdown-wrap.ts — Guard 11 semantics. Pins the paragraph-anchoring
 * contract: a paragraph split across physical lines is reported with its
 * `startLine`/`endLine`; width is not judged (a long single line passes);
 * lists, tables, fenced code and YAML frontmatter are never reported; and a
 * hard break is content, so the paragraph around it still reports as
 * multi-line.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { checkParagraphAnchoring } from "./markdown-wrap.ts";

const FILE = "skills/sample/SKILL.md";

function check(content: string) {
  const root = mkdtempSync(join(tmpdir(), "markdown-wrap-"));
  try {
    const target = join(root, FILE);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return checkParagraphAnchoring(root, [FILE]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("paragraph anchoring", () => {
  test("a paragraph split across two physical lines fails with its line span", () => {
    const result = check(
      ["# Title", "", "A paragraph that", "continues on the next line.", ""].join("\n"),
    );
    expect(result.filesChecked).toBe(1);
    expect(result.violations).toEqual([{ file: FILE, startLine: 3, endLine: 4 }]);
  });

  test("a single-line paragraph wider than 200 characters passes", () => {
    const longLine = "word ".repeat(60).trim();
    expect(longLine.length).toBeGreaterThan(200);
    const result = check(["# Title", "", longLine, ""].join("\n"));
    expect(result.violations).toEqual([]);
  });

  test("lists, tables, fenced code and frontmatter are never reported", () => {
    const result = check(
      [
        "---",
        "name: sample",
        "description: >",
        "  a wrapped scalar",
        "  spanning three lines",
        "---",
        "",
        "# Title",
        "",
        "- a list item that",
        "  continues on a second line",
        "",
        "| a | b |",
        "|---|---|",
        "| one | two |",
        "| three | four |",
        "",
        "```text",
        "fenced code",
        "continues here",
        "```",
        "",
      ].join("\n"),
    );
    expect(result.violations).toEqual([]);
  });

  test("a hard break does not split the paragraph: it still reports as multi-line", () => {
    const result = check(
      [
        "# Title",
        "",
        "A paragraph broken with two trailing spaces  ",
        "and continuing here.",
        "",
        "Another paragraph broken with a backslash\\",
        "and continuing here.",
        "",
      ].join("\n"),
    );
    expect(result.violations).toEqual([
      { file: FILE, startLine: 3, endLine: 4 },
      { file: FILE, startLine: 6, endLine: 7 },
    ]);
  });
});
