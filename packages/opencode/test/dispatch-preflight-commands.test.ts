/**
 * OpenCode package fixture test — omp `/iteration-*` commands render the
 * optional `mstar dispatch validate` preflight (Slice 3 Task 4).
 *
 * The omp host has no TS hook surface (roadmap D4): binding is command-layer
 * shell-out. The three iteration commands must carry an OPTIONAL preflight
 * that (a) is skipped silently when the `mstar-harness` bin is absent
 * (`command -v … >/dev/null 2>&1 &&` guard) and (b) does not change the
 * commands' core flow (documented as optional / warn-only).
 *
 * Reads the actual command markdown files (unit test on the rendered
 * command text) and asserts the snippet in the changed sections.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const commandsDir = path.resolve(import.meta.dir, "../../../commands");
// Quoted placeholder (qc2 W-2): agent-substituted paths must not enter the
// shell unquoted — the snippet itself is the documented safe form.
const PREFLIGHT_SNIPPET = 'command -v mstar-harness >/dev/null 2>&1 && mstar-harness dispatch validate "<latest-assignment-file>"';
// Slice 5 (roadmap §8.5 D2): fail-fast variant when the iteration compass
// frontmatter declares `enforcement: hard` — validation failure exits 1,
// but the bin-absent silent-skip guard is preserved.
const FAILFAST_SNIPPET =
  'if command -v mstar-harness >/dev/null 2>&1; then mstar-harness dispatch validate "<latest-assignment-file>" || exit 1; fi';
const iterationCommands = ["iteration-start.md", "iteration-drive.md", "iteration-loop.md"] as const;

describe("omp iteration commands optional dispatch preflight", () => {
  test("all three command files exist in the repo commands dir", () => {
    for (const file of iterationCommands) {
      expect(fs.existsSync(path.join(commandsDir, file))).toBe(true);
    }
  });

  for (const file of iterationCommands) {
    test(`${file} renders the preflight snippet`, () => {
      const content = fs.readFileSync(path.join(commandsDir, file), "utf8");
      expect(content).toContain(PREFLIGHT_SNIPPET);
      expect(content).toContain("mstar-harness dispatch validate");
    });
  }

  for (const file of iterationCommands) {
    test(`${file} documents the preflight as optional with a silent-skip guard`, () => {
      const content = fs.readFileSync(path.join(commandsDir, file), "utf8");
      // Optional marker (Chinese commands are bilingual; accept either).
      expect(content).toMatch(/可选|optional/i);
      // Silent skip when the bin is absent.
      expect(content).toMatch(/静默|silent/i);
      // Default mode stays warn-only, does not alter the core flow.
      expect(content).toMatch(/不阻断|不改变|warn/i);
    });
  }
});

describe("omp iteration commands Slice 5 fail-fast (compass enforcement: hard)", () => {
  // Spec: roadmap §8.5 C4/D2 — when the iteration compass carries
  // `enforcement: hard`, the preflight becomes fail-fast
  // (`mstar-harness dispatch validate "<file>" || exit 1`-style); the
  // documented conditional still skips silently when the bin is absent.
  for (const file of iterationCommands) {
    test(`${file} renders the fail-fast conditional snippet`, () => {
      const content = fs.readFileSync(path.join(commandsDir, file), "utf8");
      expect(content).toContain(FAILFAST_SNIPPET);
      expect(content).toContain("|| exit 1");
    });
  }

  for (const file of iterationCommands) {
    test(`${file} documents the fail-fast as conditional on the compass enforcement flag`, () => {
      const content = fs.readFileSync(path.join(commandsDir, file), "utf8");
      // The trigger: iteration compass frontmatter `enforcement: hard`.
      expect(content).toMatch(/enforcement: hard/);
      expect(content).toMatch(/fail-fast/);
    });
  }

  for (const file of iterationCommands) {
    test(`${file} preserves the bin-absent silent-skip in the fail-fast form`, () => {
      const content = fs.readFileSync(path.join(commandsDir, file), "utf8");
      // The fail-fast snippet keeps the `command -v mstar-harness` guard —
      // bin absent → the whole conditional is skipped (silent, exit 0).
      expect(FAILFAST_SNIPPET).toMatch(/command -v mstar-harness/);
      expect(content).toContain(FAILFAST_SNIPPET);
    });
  }
});
