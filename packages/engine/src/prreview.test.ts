import { describe, expect, test } from "bun:test";
import { computePrTally, validateMstarReviewV1 } from "./prreview.js";
import type { MstarReviewTally, MstarReviewV1 } from "./prreview.js";

/**
 * Compile-level regression: `MstarReviewV1.tally` keeps `band` OPTIONAL, so a
 * band-less legacy envelope stays assignable (this file is compiled by the
 * engine build's tsc; an annotation error fails `bun run engine:build`).
 */
const LEGACY_ENVELOPE: MstarReviewV1 = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: "legacy envelope without a tally band",
  tally: {
    verdict: "needs fixes",
    scorePct: 86,
    tally: { mustFix: 0, shouldFix: 1, nit: 1, unverified: 0 },
    chatHeader: "needs fixes \u00b7 86% (good)\nmust-fix=0 should-fix=1 nit=1 unverified=0",
  },
  findings: [],
};

/** Computed tallies stay assignable: the envelope tally type must accept a
 * band-carrying `PrTallyResult` (the band-optional envelope shape). */
const COMPUTED_TALLY: MstarReviewTally = computePrTally({
  findings: [{ mergeClass: "should-fix" }, { mergeClass: "nit" }],
});

const BAND_ENVELOPE: MstarReviewV1 = {
  schema: "mstar.review/v1",
  verdict: COMPUTED_TALLY.verdict,
  summary_md: "envelope carrying a computed tally",
  tally: COMPUTED_TALLY,
  findings: [],
};

describe("MstarReviewV1 envelope tally: band is optional (legacy) but accepted when present", () => {
  test("band-less legacy envelope validates", () => {
    expect(validateMstarReviewV1(LEGACY_ENVELOPE).ok).toBe(true);
  });

  test("computed band-carrying tally is assignable and validates", () => {
    expect(COMPUTED_TALLY.band).toBe("good");
    expect(validateMstarReviewV1(BAND_ENVELOPE).ok).toBe(true);
  });
});

describe("MstarReviewV1 envelope shape: keys outside the documented set are refused", () => {
  test("canonical envelope still validates", () => {
    const gate = validateMstarReviewV1(BAND_ENVELOPE);
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test("an unknown top-level key is refused and named", () => {
    const doc = { ...BAND_ENVELOPE, declaredScopes: ["docs"] };
    const gate = validateMstarReviewV1(doc);
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.message).join("\n")).toContain("declaredScopes");
  });

  test("an unknown tally key is refused and named", () => {
    const doc = { ...BAND_ENVELOPE, tally: { ...COMPUTED_TALLY, declaredScopes: ["docs"] } };
    const gate = validateMstarReviewV1(doc);
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.message).join("\n")).toContain("tally.declaredScopes");
  });

  test("every unknown key is named in one refusal, own keys only", () => {
    const doc = { ...BAND_ENVELOPE, declaredScopes: ["docs"], severity: "critical" };
    const gate = validateMstarReviewV1(doc);
    expect(gate.violations).toHaveLength(2);
    const refusal = gate.violations.map((v) => v.message).join("\n");
    expect(refusal).toContain("declaredScopes");
    expect(refusal).toContain("severity");

    // Inherited members are not envelope keys: only own properties are enumerated.
    const inherited = Object.assign(Object.create({ ghost: 1 }), BAND_ENVELOPE);
    expect(validateMstarReviewV1(inherited).ok).toBe(true);
  });
});
