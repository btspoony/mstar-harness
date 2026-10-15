/**
 * scripts/extract-changelog-section.ts — section slicing plus the body-size cap
 * that keeps `Release prep` (PR body: 65536 characters) and `Release` (Release
 * body: 125000 characters) inside the platform limits.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSection, truncateSection } from "./extract-changelog-section.ts";

const CHANGELOG = `# Changelog

## [2.0.0] - 2026-01-01

### Changed

- new bullet

## [1.0.0] - 2025-01-01

- old bullet
`;

describe("extractSection", () => {
  test("returns the requested section only, stopping at the next heading", () => {
    expect(extractSection(CHANGELOG, "2.0.0")).toBe("- 2026-01-01\n\n### Changed\n\n- new bullet");
  });

  test("an unknown version is undefined, never a neighbouring section", () => {
    expect(extractSection(CHANGELOG, "3.0.0")).toBeUndefined();
  });
});

describe("truncateSection", () => {
  test("caps CJK-heavy text inside the byte budget, on a line boundary, without a broken code point", () => {
    const section = Array.from({ length: 200 }, (_value, index) => `- 第${index}条：中文要点`).join("\n");
    const out = truncateSection(section, 400);
    const lines = out.split("\n");

    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(400);
    expect(out).not.toContain("\uFFFD");
    expect(lines.at(-1)).toBe("> Truncated at 400 bytes to fit the platform body limit. Full section: `CHANGELOG.md`.");
    expect(lines.at(-3)).toMatch(/^- 第\d+条：中文要点$/);
  });
});

describe("CLI", () => {
  test("--max-bytes caps stdout and a non-numeric cap refuses with usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-changelog-section-"));
    const script = join(import.meta.dir, "extract-changelog-section.ts");

    try {
      const bullets = Array.from({ length: 400 }, (_value, index) => `- bullet ${index}`).join("\n");
      writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n## [9.9.9]\n\n${bullets}\n`);

      const capped = Bun.spawn(["bun", script, "9.9.9", "--max-bytes", "500"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(capped.stdout).text();

      expect(await capped.exited).toBe(0);
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(500);
      expect(out).toContain("Full section: `CHANGELOG.md`.");

      const refused = Bun.spawn(["bun", script, "9.9.9", "--max-bytes", "wide"], {
        cwd: dir,
        stdout: "ignore",
        stderr: "pipe",
      });

      expect(await refused.exited).toBe(1);
      expect(await new Response(refused.stderr).text()).toContain("--max-bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
