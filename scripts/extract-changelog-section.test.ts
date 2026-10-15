/**
 * scripts/extract-changelog-section.ts — section slicing plus the body-size cap
 * that keeps `Release prep` (PR body: 65536 character limit) and `Release`
 * (Release body: 125000 character limit) inside the platform limits.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSection,
  truncateSection,
  truncationNotice,
  truncationNoticeBytes,
} from "./extract-changelog-section.ts";

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
  /** Smallest cap whose own notice fits inside it — mirrors the CLI's computed floor. */
  function noticeFloor(): number {
    let floor = 1;
    while (floor < truncationNoticeBytes(floor)) floor++;
    return floor;
  }

  test("caps CJK-heavy text inside the byte budget, on a line boundary, without a broken code point", () => {
    const section = Array.from({ length: 200 }, (_value, index) => `- 第${index}条：中文要点`).join("\n");
    const out = truncateSection(section, 400);
    const lines = out.split("\n");

    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(400);
    expect(out).not.toContain("\uFFFD");
    expect(lines.at(-1)).toBe(truncationNotice(400).trim());
    expect(lines.at(-3)).toMatch(/^- 第\d+条：中文要点$/);
  });

  test("a cap equal to the notice floor yields exactly the notice, within the cap", () => {
    const floor = noticeFloor();
    const out = truncateSection("- bullet\n".repeat(50), floor);

    expect(out).toBe(truncationNotice(floor));
    expect(Buffer.byteLength(out)).toBe(floor);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(floor);
  });

  test("every cap from the floor up stays within the cap", () => {
    const section = "x".repeat(5000);
    for (let cap = noticeFloor(); cap <= 300; cap++) {
      expect(Buffer.byteLength(truncateSection(section, cap))).toBeLessThanOrEqual(cap);
    }
  });
});

describe("CLI", () => {
  function runCli(dir: string, args: string[]) {
    return Bun.spawn(["bun", join(import.meta.dir, "extract-changelog-section.ts"), ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("--max-bytes caps stdout, and each invalid cap names its cause and recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-changelog-section-"));

    try {
      const bullets = Array.from({ length: 400 }, (_value, index) => `- bullet ${index}`).join("\n");
      writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n## [9.9.9]\n\n${bullets}\n`);

      const capped = await runCli(dir, ["9.9.9", "--max-bytes", "500"]);
      const out = await new Response(capped.stdout).text();

      expect(await capped.exited).toBe(0);
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(500);
      expect(out).toContain("Full section: `CHANGELOG.md`.");

      const refusals: Array<[string[], string, string]> = [
        [["9.9.9", "--max-bytes", "wide"], `got "wide"`, "pass e.g. --max-bytes 60000"],
        [["9.9.9", "--max-bytes", "0"], `got "0"`, "pass e.g. --max-bytes 60000"],
        [["9.9.9", "--max-bytes"], "no value was given", "pass e.g. --max-bytes 60000"],
        [["9.9.9", "--max-bytes", "1"], "is below the 87-byte truncation notice", "--max-bytes 87 or larger"],
      ];

      for (const [args, cause, recovery] of refusals) {
        const refused = await runCli(dir, args);
        const stderr = await new Response(refused.stderr).text();

        expect(await refused.exited).toBe(1);
        expect(stderr).toContain(cause);
        expect(stderr).toContain(recovery);
        expect(stderr.split("\n")[0]).toBe(
          "Usage: bun run scripts/extract-changelog-section.ts <version> [--max-bytes <n>]",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
