import { describe, expect, test } from "bun:test";
import {
  computePrTally,
  renderReviewMarkdown,
  synthesizeReview,
  validateMstarReviewV1,
} from "./prreview.js";
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

// ---------------------------------------------------------------------------
// renderReviewMarkdown \u2014 one layout owner for both surfaces
// ---------------------------------------------------------------------------

const RENDER_FINDINGS = [
  {
    mergeClass: "should-fix" as const,
    category: "Correctness",
    file_path: "src/a.ts",
    line_start: 12,
    title: "Off-by-one",
    body: "The loop skips the last element.",
  },
  {
    mergeClass: "nit" as const,
    file_path: "src/b.ts",
    title: "Naming",
    body: "Rename the helper.",
  },
];

const NARRATIVE = "Two issues found; both are local to the renderer.";

const SETTLED_REVIEW: MstarReviewV1 = {
  schema: "mstar.review/v1",
  verdict: "needs fixes",
  summary_md: NARRATIVE,
  tally: computePrTally({ findings: RENDER_FINDINGS }),
  findings: RENDER_FINDINGS,
};

describe("renderReviewMarkdown: github-comment surface", () => {
  test("(a) settled review renders verdict, tally line, narrative and findings by class", () => {
    expect(renderReviewMarkdown(SETTLED_REVIEW, { surface: "github-comment" })).toBe(
      [
        "## \u26A0\uFE0F Verdict: `needs fixes` \u00b7 Score 86% (good)",
        "",
        "**Tally:** \u{1F534} must-fix 0 \u00b7 \u{1F7E0} should-fix 1 \u00b7 \u{1F535} nit 1 \u00b7 \u2753 unverified 0",
        "",
        NARRATIVE,
        "",
        "### \u{1F7E0} should-fix",
        "",
        "1. **Off-by-one** (Correctness) \u2014 `src/a.ts:12`",
        "",
        "The loop skips the last element.",
        "",
        "### \u{1F535} nit",
        "",
        "1. **Naming** \u2014 `src/b.ts`",
        "",
        "Rename the helper.",
      ].join("\n"),
    );
  });

  test("(b) no tally and no narrative renders the verdict head only", () => {
    const review: MstarReviewV1 = { schema: "mstar.review/v1", verdict: "ship it", findings: [] };
    const body = renderReviewMarkdown(review, { surface: "github-comment" });
    expect(body).toBe("## \u2705 Verdict: `ship it`");
    expect(body).not.toContain("**Tally:**");
    expect(body).not.toContain("###");
  });

  test("(c) incomplete with an empty unscanned list states cause and `none`, no narrative", () => {
    const review: MstarReviewV1 = {
      schema: "mstar.review/v1",
      verdict: "incomplete",
      findings: [],
      incomplete: { reason: "Seat timed out", unscanned: [] },
    };
    expect(renderReviewMarkdown(review, { surface: "github-comment" })).toBe(
      "## \u23F8\uFE0F Verdict: `incomplete`\n\ncause: Seat timed out\nunscanned: none",
    );
  });
});

describe("renderReviewMarkdown: local-report surface", () => {
  test("(d) settled review renders emoji verdict head, Score/band, tally table, narrative and findings", () => {
    expect(renderReviewMarkdown(SETTLED_REVIEW, { surface: "local-report" })).toBe(
      [
        "## \u26A0\uFE0F Verdict: `needs fixes` \u00b7 Score 86% (good)",
        "",
        "| Findings | Count |",
        "| --- | --- |",
        "| \u{1F534} must-fix | 0 |",
        "| \u{1F7E0} should-fix | 1 |",
        "| \u{1F535} nit | 1 |",
        "| \u2753 unverified | 0 |",
        "",
        "## \u{1F4CB} Review",
        "",
        NARRATIVE,
        "",
        "## Findings",
        "",
        "| Merge class | Finding | Location |",
        "| --- | --- | --- |",
        "| \u{1F7E0} should-fix | Off-by-one | `src/a.ts:12` |",
        "| \u{1F535} nit | Naming | `src/b.ts` |",
        "",
        "#### \u{1F7E0} Off-by-one",
        "",
        "- **Merge class**: should-fix",
        "- **Category**: Correctness",
        "",
        "The loop skips the last element.",
        "",
        "#### \u{1F535} Naming",
        "",
        "- **Merge class**: nit",
        "",
        "Rename the helper.",
      ].join("\n"),
    );
  });

  test("(e) incomplete marks the band partial inside the parens", () => {
    const review: MstarReviewV1 = {
      schema: "mstar.review/v1",
      verdict: "incomplete",
      tally: computePrTally({
        findings: RENDER_FINDINGS,
        incomplete: { reason: "Seat timed out", unscanned: ["src/c.ts"] },
      }),
      findings: RENDER_FINDINGS,
      incomplete: { reason: "Seat timed out", unscanned: ["src/c.ts"] },
    };
    const body = renderReviewMarkdown(review, { surface: "local-report" });
    expect(body.split("\n")[0]).toBe("## \u23F8\uFE0F Verdict: `incomplete` \u00b7 Score 86% (good, partial)");
    expect(body).toContain("cause: Seat timed out\nunscanned: src/c.ts");
    expect(body).not.toContain("## \u{1F4CB} Review");
  });

  test("a band-less legacy tally derives the band from scorePct", () => {
    const body = renderReviewMarkdown(LEGACY_ENVELOPE, { surface: "local-report" });
    expect(body.split("\n")[0]).toBe("## \u26A0\uFE0F Verdict: `needs fixes` \u00b7 Score 86% (good)");
  });

  test("a finding without a path renders `repo-wide` on both surfaces", () => {
    const review: MstarReviewV1 = {
      schema: "mstar.review/v1",
      verdict: "ship it",
      findings: [{ mergeClass: "nit", title: "Scattered TODOs", body: "Three TODO markers across the repo." }],
    };
    const github = renderReviewMarkdown(review, { surface: "github-comment" });
    expect(github).toContain("1. **Scattered TODOs** \u2014 repo-wide");
    const local = renderReviewMarkdown(review, { surface: "local-report" });
    expect(local).toContain("| \u{1F535} nit | Scattered TODOs | repo-wide |");
    expect(local).not.toContain("undefined");
  });
});

describe("renderReviewMarkdown: boundary line breaks in free-form Markdown", () => {
  const SURFACES = ["github-comment", "local-report"] as const;

  test("(h) narrative boundary newlines before findings do not add blank lines", () => {
    const noisy: MstarReviewV1 = { ...SETTLED_REVIEW, summary_md: `\r\n${NARRATIVE}\n\n` };
    for (const surface of SURFACES) {
      const body = renderReviewMarkdown(noisy, { surface });
      expect(body).toBe(renderReviewMarkdown(SETTLED_REVIEW, { surface }));
      expect(body).not.toMatch(/\n{3,}/);
      expect(body.endsWith("\n")).toBe(false);
    }
  });

  test("(i) a narrative as the last section leaves no trailing newline", () => {
    const review: MstarReviewV1 = { ...SETTLED_REVIEW, findings: [], summary_md: `${NARRATIVE}\n` };
    for (const surface of SURFACES) {
      const body = renderReviewMarkdown(review, { surface });
      expect(body.split(NARRATIVE).length).toBe(2);
      expect(body.endsWith(NARRATIVE)).toBe(true);
      expect(body).not.toMatch(/\n{3,}/);
    }
  });

  test("(j) a final finding body ending in a newline keeps the section boundary clean", () => {
    const findings = [{ ...RENDER_FINDINGS[1], body: "Rename the helper.\n" }];
    const tally = computePrTally({ findings });
    const review: MstarReviewV1 = { ...SETTLED_REVIEW, verdict: tally.verdict, tally, findings };
    const github = renderReviewMarkdown(review, { surface: "github-comment" });
    expect(github.endsWith("Rename the helper.")).toBe(true);
    expect(github).not.toMatch(/\n{3,}/);

    const local = renderReviewMarkdown(review, { surface: "local-report" });
    expect(local.endsWith("Rename the helper.")).toBe(true);
    expect(local).not.toMatch(/\n{3,}/);
    expect(validateMstarReviewV1(review).ok).toBe(true);
  });
});

describe("renderReviewMarkdown: free-form finding bodies and titles", () => {
  test("(k) a title bearing a pipe stays in the Finding column \u2014 three columns, no split", () => {
    const findings = [
      { mergeClass: "nit" as const, title: "Pipe | in title", body: "x" },
      { mergeClass: "nit" as const, title: "Second | one", body: "y" },
    ];
    const tally = computePrTally({ findings });
    const review: MstarReviewV1 = { schema: "mstar.review/v1", verdict: tally.verdict, tally, findings };
    const local = renderReviewMarkdown(review, { surface: "local-report" });

    const findingsTable = local.slice(local.indexOf("## Findings"));
    const rows = findingsTable.split("\n").filter((line) => line.startsWith("| \u{1F535}"));
    expect(rows).toHaveLength(2);
    // Split on unescaped pipes only: the outer edges bracket exactly 3 cells.
    for (const row of rows) expect(row.split(/(?<!\\)\|/).length - 2).toBe(3);
    expect(local).toContain("| \u{1F535} nit | Pipe \\| in title | repo-wide |");
  });

  test("(l) a newline inside a title collapses so the row stays one line", () => {
    const findings = [{ mergeClass: "nit" as const, title: "Two\nlines", body: "x" }];
    const tally = computePrTally({ findings });
    const review: MstarReviewV1 = { schema: "mstar.review/v1", verdict: tally.verdict, tally, findings };
    expect(renderReviewMarkdown(review, { surface: "local-report" })).toContain("| \u{1F535} nit | Two lines | repo-wide |");
  });

  test("(m) a body opening with a fenced block keeps the fence and its own structure", () => {
    const body = "```ts\nconst a = 1;\n```\n\nAfter the fence.";
    const findings = [{ mergeClass: "should-fix" as const, title: "Fenced evidence", body }];
    const tally = computePrTally({ findings });
    const review: MstarReviewV1 = { schema: "mstar.review/v1", verdict: tally.verdict, tally, findings };
    const local = renderReviewMarkdown(review, { surface: "local-report" });
    expect(local).toContain(`- **Merge class**: should-fix\n\n${body}`);
    expect(local).not.toContain("- **Evidence**");
  });
});

describe("summary_md is an optional seat narrative", () => {
  test("(f) synthesizeReview emits no summary_md key and the envelope validates", () => {
    const synthesized = synthesizeReview({ findings: [] });
    expect("summary_md" in synthesized).toBe(false);
    expect(validateMstarReviewV1(synthesized).ok).toBe(true);
  });

  test("(g) a present-but-blank summary_md is still refused", () => {
    const gate = validateMstarReviewV1({ ...SETTLED_REVIEW, summary_md: "   " });
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain("review.missing-summary");
  });

  test("synthesizeReview turns a blank supplied summary into no narrative at all", () => {
    const synthesized = synthesizeReview({ findings: [], summary_md: " \n\t" });
    expect("summary_md" in synthesized).toBe(false);
    expect(validateMstarReviewV1(synthesized).ok).toBe(true);
    expect(renderReviewMarkdown(synthesized, { surface: "local-report" })).not.toContain("\u{1F4CB} Review");
  });
});
