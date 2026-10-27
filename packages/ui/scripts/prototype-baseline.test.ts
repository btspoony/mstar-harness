import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrototype } from "./prototype-baseline.ts";

describe("the prototype baseline loader", () => {
  test("a readable baseline is returned as-is", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-prototype-"));
    try {
      const file = join(dir, "prototype.html");
      const markup = '<style>.tone-running .dot { background: var(--ms-accent); }</style>';
      writeFileSync(file, markup);
      expect(loadPrototype(file)).toBe(markup);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing baseline throws, naming the path", () => {
    // The regression this pins: a future edit that turns the four checks back into
    // "warn and exit 0" has to delete this throw, and this test reddens first.
    const missing = join(tmpdir(), "mstar-prototype-absent", "prototype.html");
    expect(() => loadPrototype(missing)).toThrow(missing);
    expect(() => loadPrototype(missing)).toThrow(/is unreadable/);
  });
});
