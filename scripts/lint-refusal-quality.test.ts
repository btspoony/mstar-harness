import { describe, expect, test } from "bun:test";
import { scanSource, normalizeSnippet, signatureFor } from "./lint-refusal-quality";

describe("refusal quality scanner", () => {
  test("finds missing cause codes and non-existent recovery verbs", () => {
    const source = `
      fail("Cannot continue. Recover with execution restore-preview --path <path>.");
      fail("MISSING_STATE: Cannot continue. Recover with workflow --resume.");
    `;
    const findings = scanSource(source, "packages/engine/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    });
    expect(findings.map((finding) => finding.classification)).toEqual([
      "missing-cause-code", "unreachable-recovery",
    ]);
  });

  test("accepts refusal with cause and supported recovery", () => {
    const source = `fail("MISSING_STATE: Cannot continue. Recover with workflow --resume.");`;
    expect(scanSource(source, "packages/engine/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    })).toEqual([]);
  });

  test("normalizes snippet whitespace for stable allowlist signatures", () => {
    expect(normalizeSnippet("  foo(  bar );  ")).toBe("foo( bar );");
    expect(signatureFor("missing-cause-code", "scripts/file.ts", "foo(  bar );"))
      .toBe(signatureFor("missing-cause-code", "scripts/file.ts", " foo( bar ); "));
  });
});
