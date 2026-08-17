/**
 * Manifest contract — the `bin` map must declare BOTH executable names:
 * `mstar-harness` (canonical, exists in every released version) and the
 * `mstar` short alias, pointing at the SAME dist entry. Skill text cites
 * `` `mstar <cmd>` `` verbatim (59×), so the alias must be a real second
 * bin — not a doc-only mention. `commands/` keeps the long name because the
 * short alias only exists from the release that ships it (version-proof).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MANIFEST = join(resolve(import.meta.dir, ".."), "package.json");

describe("@mstar-harness/cli manifest — bin aliases", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    bin?: Record<string, string>;
  };

  test("declares both `mstar-harness` and the `mstar` alias", () => {
    expect(Object.keys(manifest.bin ?? {})).toEqual(
      expect.arrayContaining(["mstar-harness", "mstar"]),
    );
  });

  test("`mstar` points at the same dist entry as `mstar-harness`", () => {
    const long = manifest.bin?.["mstar-harness"];
    const short = manifest.bin?.["mstar"];
    expect(long).toBeDefined();
    expect(short).toBe(long);
    expect(short).toMatch(/^dist\//);
  });
});
