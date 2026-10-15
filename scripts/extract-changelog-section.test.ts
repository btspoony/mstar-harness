/**
 * scripts/extract-changelog-section.ts — section slicing plus the body-size cap
 * that keeps `Release prep` (PR body: 65536 character limit) and `Release`
 * (Release body: 125000 character limit) inside the platform limits.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  test("a present-but-empty heading is an empty string, distinct from absent", () => {
    const empty = "# Changelog\n\n## [9.9.9]\n\n## [1.0.0]\n\n- old bullet\n";
    expect(extractSection(empty, "9.9.9")).toBe("");
    expect(extractSection(empty, "8.8.8")).toBeUndefined();
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
    // The refusal cases must not inherit a RELEASE_VERSION from the test runner.
    const env = { ...process.env };
    delete env.RELEASE_VERSION;
    return Bun.spawn(["bun", join(import.meta.dir, "extract-changelog-section.ts"), ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  }

  function scratchDir(changelog?: string): string {
    // realpath so the child's process.cwd() matches (macOS /var -> /private/var).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mstar-changelog-section-")));
    if (changelog !== undefined) writeFileSync(join(dir, "CHANGELOG.md"), changelog);
    return dir;
  }

  function withDir<T>(changelog: string | undefined, body: (dir: string) => Promise<T>): Promise<T> {
    const dir = scratchDir(changelog);
    return body(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  test("--max-bytes caps stdout, and each invalid cap names its cause and recovery", async () => {
    const bullets = Array.from({ length: 400 }, (_value, index) => `- bullet ${index}`).join("\n");

    await withDir(`# Changelog\n\n## [9.9.9]\n\n${bullets}\n`, async (dir) => {
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
    });
  });

  test("every refusal names its own cause and recovery", async () => {
    const absent = "# Changelog\n\n## [1.0.0]\n\n- old bullet\n";

    // No version: refused before the cap check and before CHANGELOG.md is read.
    await withDir(undefined, async (dir) => {
      for (const args of [[], ["--max-bytes", "60000"]]) {
        const refused = await runCli(dir, args);
        const stderr = await new Response(refused.stderr).text();

        expect(await refused.exited).toBe(1);
        expect(await new Response(refused.stdout).text()).toBe("");
        expect(stderr).toContain("A release version is required");
        expect(stderr).toContain("RELEASE_VERSION");
        expect(stderr).not.toContain("[undefined]");
      }
    });

    // Heading absent: the version is named with the recovery that fixes it.
    await withDir(absent, async (dir) => {
      const refused = await runCli(dir, ["9.9.8"]);
      const stderr = await new Response(refused.stderr).text();

      expect(await refused.exited).toBe(1);
      expect(stderr).toContain("No CHANGELOG section found for ## [9.9.8] in CHANGELOG.md");
      expect(stderr).toContain("check the version against an existing `## [x.y.z]` heading in CHANGELOG.md");
      // The positional argument wins over RELEASE_VERSION, so the env-var
      // recovery only works once the positional is dropped.
      expect(stderr).toContain("drop the positional argument and set RELEASE_VERSION instead");
    });

    // Heading present but empty: distinct from absent, matching the pre-refactor cause.
    await withDir("# Changelog\n\n## [9.9.9]\n\n## [1.0.0]\n\n- old bullet\n", async (dir) => {
      const refused = await runCli(dir, ["9.9.9"]);
      const stderr = await new Response(refused.stderr).text();

      expect(await refused.exited).toBe(1);
      expect(stderr).toContain("CHANGELOG section for 9.9.9 is empty in CHANGELOG.md");
      expect(stderr).not.toContain("No CHANGELOG section found");
      // Recovery must point at the fragment workflow, never at hand-editing
      // the assembled changelog.
      expect(stderr).toContain("add the matching fragment under .changes/unreleased/");
      expect(stderr).toContain("bun run release:prepare -- 9.9.9");
      expect(stderr).not.toContain("add its bullets");
    });

    // No readable CHANGELOG.md: cause + recovery, never a raw errno or stack frame.
    await withDir(undefined, async (dir) => {
      const refused = await runCli(dir, ["9.9.9"]);
      const stderr = await new Response(refused.stderr).text();

      expect(await refused.exited).toBe(1);
      expect(stderr).toContain(`CHANGELOG.md is not readable in ${dir}`);
      expect(stderr).toContain("run this from the repository root that holds CHANGELOG.md");
      expect(stderr).not.toMatch(/ENOENT|EPERM|EACCES/);
      expect(stderr).not.toMatch(/^\s+at /m);
    });

    // CHANGELOG.md present but unreadable: the repository-root advice would
    // name the wrong cause, so the recovery must address the read failure.
    // A directory is used (not chmod) so the case holds under root, where
    // permission bits do not deny reads.
    const dirAsFile = scratchDir();
    try {
      mkdirSync(join(dirAsFile, "CHANGELOG.md"));
      const refused = await runCli(dirAsFile, ["9.9.9"]);
      const stderr = await new Response(refused.stderr).text();

      expect(await refused.exited).toBe(1);
      expect(await new Response(refused.stdout).text()).toBe("");
      expect(stderr).toContain(`CHANGELOG.md is not readable in ${dirAsFile}`);
      expect(stderr).toContain("check read permissions on the file or use a checkout you can read");
      expect(stderr).not.toContain("run this from the repository root");
      expect(stderr).not.toMatch(/^\s+at /m);
    } finally {
      rmSync(dirAsFile, { recursive: true, force: true });
    }
  });
});
