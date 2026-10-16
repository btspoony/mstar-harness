/**
 * compareSemver — prerelease-aware semver 2.0.0 comparison for the CLI's
 * plugin/CLI version-alignment doctor note. Semantics are mirrored from
 * `scripts/release-surfaces.ts` (the semantics source of truth).
 */
import { describe, expect, test } from "bun:test";
import { compareSemver as scriptsCompareSemver } from "../../../scripts/release-surfaces";
import { compareSemver } from "../src/version-compare";

// Comparator spec vectors. None of these is a repository version: the core is
// either zero or the `synthetic` marker, and these strings exist only to fix an
// ordering relationship for the comparator's own unit coverage.
const C0 = "0.0.0-synthetic";
const C1 = "0.0.1-synthetic";
const C2 = "0.1.0-synthetic";
const C3 = "1.0.0-synthetic";
// Semver §11 prerelease chain, zero core.
const RELEASE = "0.0.0";
const ALPHA = "0.0.0-alpha";
const ALPHA_1 = "0.0.0-alpha.1";
const ALPHA_BETA = "0.0.0-alpha.beta";
const BETA = "0.0.0-beta";
const BETA_2 = "0.0.0-beta.2";
const BETA_11 = "0.0.0-beta.11";
const RC_1 = "0.0.0-rc.1";
const NUM_1 = "0.0.0-1";
const NUM_01 = "0.0.0-01";

describe("compareSemver", () => {
  test("equal versions compare 0", () => {
    expect(compareSemver(C0, C0)).toBe(0);
    expect(compareSemver(ALPHA_1, ALPHA_1)).toBe(0);
  });

  test("core fields: major, minor, patch each decide the order", () => {
    expect(compareSemver(C3, C2)).toBeGreaterThan(0);
    expect(compareSemver(C2, C1)).toBeGreaterThan(0);
    expect(compareSemver(C1, C0)).toBeGreaterThan(0);
    expect(compareSemver(C2, C3)).toBeLessThan(0);
    expect(compareSemver(C1, C2)).toBeLessThan(0);
    expect(compareSemver(C0, C1)).toBeLessThan(0);
  });

  test("prerelease precedence (§11): identifiers numeric then alphanumeric", () => {
    expect(compareSemver(ALPHA, ALPHA_1)).toBeLessThan(0);
    expect(compareSemver(ALPHA_1, ALPHA_BETA)).toBeLessThan(0);
    expect(compareSemver(ALPHA_BETA, BETA)).toBeLessThan(0);
    expect(compareSemver(BETA, BETA_2)).toBeLessThan(0);
    expect(compareSemver(BETA_2, BETA_11)).toBeLessThan(0);
    expect(compareSemver(BETA_11, RC_1)).toBeLessThan(0);
    expect(compareSemver(RC_1, RELEASE)).toBeLessThan(0);
  });

  test("release outranks any prerelease of the same core; numeric < alphanumeric", () => {
    expect(compareSemver(RELEASE, C0)).toBeGreaterThan(0);
    expect(compareSemver(C0, RELEASE)).toBeLessThan(0);
    expect(compareSemver(NUM_1, ALPHA)).toBeLessThan(0);
  });

  // F-002 drift guard: version-compare.ts is a deliberate CLI-local mirror of
  // the scripts comparator (scripts/ is not a package export). This fixed
  // vector turns the in-code "keep in sync" comment into an enforced
  // invariant — any semantic divergence between the two implementations
  // fails here. Includes the §11 chain, core-field ordering,
  // release-vs-prerelease, and a leading-zero prerelease numeric (both
  // implementations compare numerics via BigInt, so `01` == `1` deterministically).
  test("agrees with the scripts/release-surfaces.ts comparator on a fixed vector", () => {
    const vectors: Array<[string, string]> = [
      [C0, C0],
      [C3, C2],
      [C2, C1],
      [C1, C0],
      [ALPHA, ALPHA_1],
      [ALPHA_1, ALPHA_BETA],
      [ALPHA_BETA, BETA],
      [BETA_2, BETA_11],
      [BETA_11, RC_1],
      [RC_1, RELEASE],
      [NUM_1, ALPHA],
      [NUM_01, NUM_1],
    ];
    for (const [a, b] of vectors) {
      expect(Math.sign(compareSemver(a, b))).toBe(Math.sign(scriptsCompareSemver(a, b)));
    }
  });
});
