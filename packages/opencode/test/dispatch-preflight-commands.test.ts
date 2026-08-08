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
const PREFLIGHT_SNIPPET = "command -v mstar-harness >/dev/null 2>&1 && mstar-harness dispatch validate";
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
      // Warn-only, does not alter the core flow.
      expect(content).toMatch(/不阻断|不改变|warn/i);
    });
  }
});
