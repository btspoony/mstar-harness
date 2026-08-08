/**
 * Compass frontmatter parser parity — sync guard for the dsh in-app mirror
 * (qc1 F-002 of plan 20260808-dsh-seams-bundle).
 *
 * THIS module (`src/compass.ts`) is the single parser home; the dsh plugin
 * mirrors it in `packages/dsh/src/compass.ts`. Both sides assert the SAME
 * shared fixtures + golden vectors (lives in `packages/dsh/tests/fixtures/
 * compass/` — referenced by relative path, so a contract change updates one
 * fixture set and both suites re-verify). A drift on either side fails that
 * side's package suite.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCompassFrontmatter } from "../src/compass.ts";

/** Shared compass fixtures/golden asserted by BOTH the CLI and dsh suites. */
const FIXTURES = resolve(import.meta.dir, "../../dsh/tests/fixtures/compass");

function goldenFor(fixture: string): Record<string, unknown> {
  const golden = JSON.parse(readFileSync(join(FIXTURES, "golden.json"), "utf8")) as Record<string, Record<string, unknown>>;
  return golden[fixture]!;
}

describe("parseCompassFrontmatter — shared golden vectors (parity with packages/dsh)", () => {
  for (const fixture of ["delivery-compass.md", "flow-plans.md", "empty-plans.md"]) {
    test(`${fixture} → the shared golden doc`, () => {
      expect(parseCompassFrontmatter(join(FIXTURES, fixture))).toEqual(goldenFor(fixture));
    });
  }
});

describe("parseCompassFrontmatter — structural errors carry the file path", () => {
  test("unsupported line → throws with the file path and line", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-compass-"));
    const file = join(dir, "broken.md");
    writeFileSync(file, "---\niteration_id: v1\n- dangling\n---\n");
    try {
      expect(() => parseCompassFrontmatter(file)).toThrow(/unsupported frontmatter line in .*broken\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unterminated fence → throws with the file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-compass-"));
    const file = join(dir, "broken.md");
    writeFileSync(file, "---\niteration_id: v1\n");
    try {
      expect(() => parseCompassFrontmatter(file)).toThrow(/unterminated YAML frontmatter in .*broken\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
