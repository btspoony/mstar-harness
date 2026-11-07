/**
 * markdown-wrap.ts — Guard 11: paragraph anchoring.
 *
 * One paragraph is one logical block, so a paragraph split across physical
 * lines makes every edit to it a whole-block diff and lets a reader miscount
 * its sentences. This guard reports each `paragraph` node whose `position`
 * spans more than one physical line, so wrapped paragraphs are countable.
 *
 * Only `paragraph` nodes are judged. Lists are skipped (an mdast list item's
 * content is a `paragraph` node too, but a list is never judged), and
 * headings, tables, fenced code and YAML frontmatter produce no reported
 * node. A well-formed frontmatter block is blanked line-preserving before
 * parsing and is never reported; a block that never closes falls back to plain
 * Markdown parsing, so its body can report as a paragraph — that file has a
 * frontmatter defect, and the row still points at the offending lines. Width is
 * not judged: a long single line passes. A hard break (`\` or two trailing
 * spaces) is content, not a paragraph boundary, so a paragraph carrying one
 * still reports as multi-line.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export type ParagraphViolation = {
  file: string;
  startLine: number;
  endLine: number;
};

export type ParagraphAnchoringResult = {
  filesChecked: number;
  violations: ParagraphViolation[];
};

type SyntaxNode = {
  type: string;
  children?: SyntaxNode[];
  position?: { start: { line: number }; end: { line: number } };
};

/**
 * Compare every `file` (repo-relative, read under `root`) and report each
 * paragraph that spans more than one physical line.
 */
export function checkParagraphAnchoring(root: string, files: string[]): ParagraphAnchoringResult {
  const violations: ParagraphViolation[] = [];
  for (const file of files) {
    for (const span of wrappedParagraphs(readFileSync(join(root, file), "utf8"))) {
      violations.push({ file, ...span });
    }
  }
  return { filesChecked: files.length, violations };
}

function wrappedParagraphs(source: string): Array<{ startLine: number; endLine: number }> {
  const tree = fromMarkdown(withoutFrontmatter(source), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as unknown as SyntaxNode;

  const spans: Array<{ startLine: number; endLine: number }> = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === "list") return;
    if (node.type === "paragraph") {
      const startLine = node.position?.start.line;
      const endLine = node.position?.end.line;
      if (startLine !== undefined && endLine !== undefined && endLine > startLine) {
        spans.push({ startLine, endLine });
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return spans;
}

/**
 * Blank a leading frontmatter block while preserving line numbers: mdast
 * reads the block's body as a `paragraph`, which would otherwise be this
 * guard's first false positive. The boundary rule matches the engine's
 * `stripFrontmatter` (first line `---`, next `---` line closes); the block is
 * replaced by empty lines instead of removed so later positions stay true.
 */
function withoutFrontmatter(source: string): string {
  const lines = source.replace(/^\uFEFF/, "").split("\n");
  if (lines[0].trim() !== "---") return source;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close < 0) return source;
  return `${"\n".repeat(close + 1)}${lines.slice(close + 1).join("\n")}`;
}
