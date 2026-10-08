import { describe, expect, test } from "bun:test";
import { scanSource } from "./lint-hash-gates";

const gate = (marker = "") => `${marker}\nif (expectedDigest !== observedDigest) throw new Error("mismatch");`;

describe("hash-gate scope and authorization", () => {
  test("does not report test-file assertions or gates", () => {
    expect(scanSource("packages/engine/src/hash.test.ts", gate())).toEqual([]);
    expect(scanSource("packages/engine/test/hash.ts", gate())).toEqual([]);
  });

  test("accepts and reports a non-empty authorized marker", () => {
    const findings = scanSource("packages/engine/src/hash.ts", gate("// hash-gate: authorized — preserve identity"));
    expect(findings.map(({ classification }) => classification)).toEqual(["authorized-gate"]);
    expect(findings[0]?.reason).toBe("preserve identity");
  });

  test("reports an empty authorized reason as a violation", () => {
    const findings = scanSource("packages/engine/src/hash.ts", gate("// hash-gate: authorized —   "));
    expect(findings.map(({ classification }) => classification)).toEqual(["invalid-authorized-marker"]);
    expect(findings[0]?.reason).toBe("authorized marker requires a non-empty reason");
  });

  test("keeps unmarked gates as violations", () => {
    expect(scanSource("packages/engine/src/hash.ts", gate()).map(({ classification }) => classification)).toEqual(["hash-gate"]);
  });
});
