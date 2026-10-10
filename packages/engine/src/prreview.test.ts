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

describe("MstarReviewV1 envelope tally — band is optional (legacy) but accepted when present", () => {
  test("band-less legacy envelope validates", () => {
    expect(validateMstarReviewV1(LEGACY_ENVELOPE).ok).toBe(true);
  });

  test("computed band-carrying tally is assignable and validates", () => {
    expect(COMPUTED_TALLY.band).toBe("good");
    expect(validateMstarReviewV1(BAND_ENVELOPE).ok).toBe(true);
  });
});
