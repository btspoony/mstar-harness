import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import GithubSlugger from "github-slugger";
import { checkMarkdownLinks, readTrackedMarkdown } from "./markdown-links.ts";

function fixture(files: Record<string, string>): { root: string; tracked: Set<string>; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "markdown-links-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean));
  return { root, tracked, close: () => rmSync(root, { recursive: true, force: true }) };
}

describe("markdown-links behavior groups", () => {
  test("markdown-links reports actionable missing files and anchors while accepting good targets", () => {
    const repo = fixture({
      "index.md": "[missing](absent.md)\n[bad](guide.md#nope)\n[good](guide.md#target)\n[wrong case](Guide.md)\n",
      "guide.md": "# Target\n",
    });
    try {
      const result = checkMarkdownLinks(repo.root, repo.tracked);
      expect(result.diagnostics).toEqual([
        { source: "index.md", line: 1, rawTarget: "absent.md", kind: "missing-target" },
        { source: "index.md", line: 2, rawTarget: "guide.md#nope", kind: "missing-anchor" },
        { source: "index.md", line: 4, rawTarget: "Guide.md", kind: "missing-target" },
      ]);
    } finally { repo.close(); }
  });

  test("markdown-links follows canonical slugs for duplicate, colliding, slash and Unicode headings", () => {
    const slugger = new GithubSlugger();
    const expected = [slugger.slug("Foo"), slugger.slug("Foo"), slugger.slug("Foo-1"), slugger.slug("/command"), slugger.slug("你好 café")];
    const repo = fixture({ "index.md": "# Foo\n# Foo\n# Foo-1\n# /command\n# 你好 café\n" });
    try {
      const links = expected.map((anchor) => `[x](#${encodeURIComponent(anchor)})`).join("\n");
      writeFileSync(join(repo.root, "index.md"), `# Foo\n# Foo\n# Foo-1\n# /command\n# 你好 café\n${links}\n`);
      const result = checkMarkdownLinks(repo.root, repo.tracked);
      expect(result.diagnostics).toEqual([]);
      expect(result.anchorsChecked).toBe(expected.length);
    } finally { repo.close(); }
  });

  test("markdown-links resolves directories and encoded paths, and rejects malformed or escaping paths", () => {
    const outside = mkdtempSync(join(tmpdir(), "markdown-links-outside-"));
    const repo = fixture({
      "index.md": "[dir](docs) [slash](docs/) [anchor](docs#readme)\n[space](a%20b.md#café) [hash](hash%23file.md)\n[bad](bad%ZZ.md) [traverse](%2e%2e/outside.md) [escape](escape.md)\n",
      "docs/README.md": "# Readme\n",
      "a b.md": "# café\n",
      "hash#file.md": "local file\n",
      "outside.md": "# Outside\n",
    });
    try {
      writeFileSync(join(outside, "outside.md"), "# Outside\n");
      symlinkSync(join(outside, "outside.md"), join(repo.root, "escape.md"));
      const result = checkMarkdownLinks(repo.root, repo.tracked);
      expect(result.diagnostics).toEqual([
        { source: "index.md", line: 3, rawTarget: "bad%ZZ.md", kind: "invalid-encoding" },
        { source: "index.md", line: 3, rawTarget: "%2e%2e/outside.md", kind: "escapes-root" },
        { source: "index.md", line: 3, rawTarget: "escape.md", kind: "escapes-root" },
      ]);
      expect(result.linksChecked).toBe(5);
    } finally { repo.close(); rmSync(outside, { recursive: true, force: true }); }
  });

  test("markdown-links resolves first reference definitions and HTML links and anchors", () => {
    const repo = fixture({
      "index.md": "[ref][dest]\n\n[dest]: guide.md#heading\n[dest]: missing.md\n<img src=\"guide.md#heading\"><a href=\"guide.md#heading\" name=\"legacy\">x</a>\n<h2 id=\"heading\">A real heading</h2>\n[legacy](#legacy)\n",
      "guide.md": "# heading\n",
    });
    try {
      const result = checkMarkdownLinks(repo.root, repo.tracked);
      expect(result.diagnostics).toEqual([]);
      expect(result.linksChecked).toBe(3);
    } finally { repo.close(); }
  });

  test("markdown-links ignores code, frontmatter, comments and inline examples but reads heading code", () => {
    const repo = fixture({
      "index.md": "---\ntitle: '[bad](missing.md)'\n---\n\n`[bad](missing.md)`\n\n    [bad](missing.md)\n\n<!-- [bad](missing.md) -->\n```md\n[bad](missing.md)\n# Fake\n```\n# `inline`\n[ok](#inline)\n",
    });
    try {
      const result = checkMarkdownLinks(repo.root, repo.tracked);
      expect(result.diagnostics).toEqual([]);
      expect(result.anchorsChecked).toBe(1);
    } finally { repo.close(); }
  });

  test("markdown-links classifies templates and skips external schemes without opening them", () => {
    const repo = fixture({
      "index.md": "[template]({TARGET}) [empty](<>) [real](<guide file.md>) [web](https://example.invalid/a) [skill](skill://topic) [root](/guide%20file.md)\n",
      "guide file.md": "target\n",
    });
    try {
      const result = checkMarkdownLinks(repo.root, repo.tracked);
      expect(result.diagnostics).toEqual([]);
      expect(result.linksChecked).toBe(2);
      expect(result.skipped).toEqual({ template: 2, external: 2 });
    } finally { repo.close(); }
  });

  test("markdown-links uses tracked canonical inputs and rejects unreadable sources and untracked targets", () => {
    const repo = fixture({
      "index.md": "[untracked](generated.md)\n",
      "packages/omp/skills/copy.md": "[missing](missing.md)\n",
      "skills/source.md": "[missing](missing.md)\n",
      "odd name\nwith-ü.md": "# Unicode filename\n",
    });
    try {
      writeFileSync(join(repo.root, "generated.md"), "# Generated\n");
      const parsed = readTrackedMarkdown(repo.root);
      expect(parsed.failures).toEqual([]);
      expect(parsed.tracked.has("packages/omp/skills/copy.md")).toBe(false);
      expect(parsed.tracked.has("odd name\nwith-ü.md")).toBe(true);
      expect(checkMarkdownLinks(repo.root, parsed.tracked).diagnostics).toEqual([
        { source: "index.md", line: 1, rawTarget: "generated.md", kind: "missing-target" },
        { source: "skills/source.md", line: 1, rawTarget: "missing.md", kind: "missing-target" },
      ]);
      const unreadable = fixture({ "unreadable.md": "# hi\n" });
      try {
        rmSync(join(unreadable.root, "unreadable.md"));
        expect(checkMarkdownLinks(unreadable.root, unreadable.tracked).diagnostics[0]?.kind).toBe("unreadable");
      } finally { unreadable.close(); }
      const noGit = outsidePath();
      try { expect(readTrackedMarkdown(noGit).failures[0]?.kind).toBe("unreadable"); }
      finally { rmSync(noGit, { recursive: true, force: true }); }
    } finally { repo.close(); }
  });
});

function outsidePath(): string {
  const path = mkdtempSync(join(tmpdir(), "markdown-links-no-git-"));
  chmodSync(path, 0o700);
  return path;
}
