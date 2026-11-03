import { describe, expect, test } from "bun:test";
import {
  computePrTally,
  renderReviewMarkdown,
  synthesizeReview,
  validateMstarReviewV1,
} from "./prreview.js";
import type { MergeClass, MstarReviewTally, MstarReviewV1 } from "./prreview.js";

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
// renderReviewMarkdown — one layout owner for both surfaces
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

describe("renderReviewMarkdown: the template body", () => {
  test("(a) settled review renders the tally table, narrative and one block per finding", () => {
    const expected = [
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
      "### Findings",
      "",
      "#### \u{1F7E0} Off-by-one",
      "",
      "- **Evidence**: The loop skips the last element.",
      "- **Location**: `src/a.ts:12`",
      "- **Category**: Correctness",
      "- **Merge class**: should-fix",
      "",
      "#### \u{1F535} Naming",
      "",
      "- **Evidence**: Rename the helper.",
      "- **Location**: `src/b.ts`",
      "- **Merge class**: nit",
    ].join("\n");
    expect(renderReviewMarkdown(SETTLED_REVIEW, { surface: "github-comment" })).toBe(expected);
  });

  test("(b) no tally, no narrative and no findings renders the verdict head and the Review anchor", () => {
    const review: MstarReviewV1 = { schema: "mstar.review/v1", verdict: "ship it", findings: [] };
    const body = renderReviewMarkdown(review, { surface: "github-comment" });
    expect(body).toBe("## \u2705 Verdict: `ship it`\n\n## \u{1F4CB} Review");
    expect(body).not.toContain("| Findings |");
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
      "## \u23F8\uFE0F Verdict: `incomplete`\n\ncause: Seat timed out\nunscanned: none\n\n## \u{1F4CB} Review",
    );
  });
});

describe("renderReviewMarkdown: surface is layout-neutral", () => {
  test("(d) both surfaces render the identical template body", () => {
    const github = renderReviewMarkdown(SETTLED_REVIEW, { surface: "github-comment" });
    expect(renderReviewMarkdown(SETTLED_REVIEW, { surface: "local-report" })).toBe(github);
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
    // The section is mandated by the template; only the narrative is optional.
    expect(body.split("\n").filter((line) => line === "## \u{1F4CB} Review")).toHaveLength(1);
    expect(body.split("## \u{1F4CB} Review")[1].trimStart().startsWith("### Findings")).toBe(true);
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
    for (const surface of ["github-comment", "local-report"] as const) {
      const body = renderReviewMarkdown(review, { surface });
      expect(body).toContain("- **Location**: repo-wide");
      expect(body).not.toContain("undefined");
    }
  });

  test("(r) Location renders a line range, a single line, or the bare path", () => {
    const findings = [
      { mergeClass: "should-fix" as const, file_path: "src/a.ts", line_start: 3, line_end: 9, title: "Range", body: "x" },
      { mergeClass: "nit" as const, file_path: "src/b.ts", line_start: 7, title: "Single", body: "x" },
      { mergeClass: "nit" as const, file_path: "src/c.ts", line_start: 4, line_end: 4, title: "Degenerate", body: "x" },
      { mergeClass: "nit" as const, file_path: "src/d.ts", title: "Path only", body: "x" },
    ];
    const body = renderReviewMarkdown({ schema: "mstar.review/v1", verdict: "needs fixes", findings }, {});
    expect(body).toContain("- **Location**: `src/a.ts:3-9`");
    expect(body).toContain("- **Location**: `src/b.ts:7`");
    expect(body).toContain("- **Location**: `src/c.ts:4`");
    expect(body).toContain("- **Location**: `src/d.ts`");
  });

  test("(s) a newline-bearing verdict and merge class collapse inside their backticked slots", () => {
    const review = {
      schema: "mstar.review/v1",
      verdict: "needs\nfixes",
      findings: [{ mergeClass: "must\nfix", title: "T", body: "x" }],
    } as unknown as MstarReviewV1;
    const body = renderReviewMarkdown(review, { surface: "github-comment" });
    expect(body.split("\n")[0]).toBe("## \u2022 Verdict: `needs fixes`");
    expect(body).toContain("- **Merge class**: must fix");
    expect(body.split("\n").filter((line) => line.startsWith("## "))).toHaveLength(2); // verdict + Review
  });

  test("(u) a non-string title, body, category or path renders an empty slot instead of throwing", () => {
    const review = {
      schema: "mstar.review/v1",
      verdict: "needs fixes",
      findings: [
        { mergeClass: "nit", title: 42, body: { text: "x" }, category: 7, file_path: ["a.ts"], line_start: 3 },
      ],
    } as unknown as MstarReviewV1;
    const body = renderReviewMarkdown(review, { surface: "github-comment" });
    expect(body).toContain("#### \u{1F535}");
    expect(body).toContain("- **Evidence**: none");
    expect(body).toContain("- **Location**: repo-wide");
    expect(body).not.toContain("- **Category**:");
    expect(body).toContain("- **Merge class**: nit");
  });

  test("(v) a supplied narrative is published verbatim and findings keep document order", () => {
    const findings = [
      { mergeClass: "nit" as const, title: "Second", body: "b" },
      { mergeClass: "must-fix" as const, title: "First", body: "a" },
    ];
    const narrative = "## Verdict: needs fixes\n\nSeat prose kept as written.";
    const body = renderReviewMarkdown({ schema: "mstar.review/v1", verdict: "needs fixes", summary_md: narrative, findings });
    // Nothing inside a supplied narrative is rewritten or stripped.
    expect(body).toContain(narrative);
    expect(body.indexOf("#### \u{1F535} Second")).toBeLessThan(body.indexOf("#### \u{1F534} First"));
  });

  test("(t) the options argument is optional and cannot select a layout", () => {
    const bare = renderReviewMarkdown(SETTLED_REVIEW);
    expect(bare).toBe(renderReviewMarkdown(SETTLED_REVIEW, {}));
    expect(bare).toBe(renderReviewMarkdown(SETTLED_REVIEW, { surface: "local-report" }));
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
    for (const surface of SURFACES) {
      const body = renderReviewMarkdown(review, { surface });
      expect(body).toContain("- **Evidence**: Rename the helper.");
      expect(body).not.toMatch(/\n{3,}/);
      expect(body.endsWith("\n")).toBe(false);
    }
    expect(validateMstarReviewV1(review).ok).toBe(true);
  });
});

describe("renderReviewMarkdown: free-form finding bodies and titles", () => {
  test("(k) a title bearing a pipe stays one heading line", () => {
    const findings = [
      { mergeClass: "nit" as const, title: "Pipe | in title", body: "x" },
      { mergeClass: "nit" as const, title: "Second | one", body: "y" },
    ];
    const tally = computePrTally({ findings });
    const review: MstarReviewV1 = { schema: "mstar.review/v1", verdict: tally.verdict, tally, findings };
    const body = renderReviewMarkdown(review, { surface: "github-comment" });
    expect(body).toContain("#### \u{1F535} Pipe | in title");
    expect(body).toContain("#### \u{1F535} Second | one");
  });

  test("(l) a newline inside a title collapses so the heading stays one line", () => {
    const findings = [{ mergeClass: "nit" as const, title: "Two\nlines", body: "x" }];
    const tally = computePrTally({ findings });
    const review: MstarReviewV1 = { schema: "mstar.review/v1", verdict: tally.verdict, tally, findings };
    expect(renderReviewMarkdown(review, { surface: "local-report" })).toContain("#### \u{1F535} Two lines");
  });

  test("(l2) a pipe/newline title and category cannot break the finding block", () => {
    const findings = [
      { mergeClass: "nit" as const, title: "Pipe | and\nbreak", category: "Docs\nsplit", body: "x" },
    ];
    const tally = computePrTally({ findings });
    const review: MstarReviewV1 = { schema: "mstar.review/v1", verdict: tally.verdict, tally, findings };

    for (const surface of ["github-comment", "local-report"] as const) {
      const body = renderReviewMarkdown(review, { surface });
      expect(body).toContain("#### \u{1F535} Pipe | and break");
      expect(body).toContain("- **Category**: Docs split");
      expect(body.split("\n").filter((line) => line.startsWith("#### "))).toHaveLength(1);
    }
  });

  test("(m) a body opening with a fenced block keeps the fence inside the evidence bullet", () => {
    const body = "```ts\nconst a = 1;\n```\n\nAfter the fence.";
    const findings = [{ mergeClass: "should-fix" as const, title: "Fenced evidence", body }];
    const tally = computePrTally({ findings });
    const review: MstarReviewV1 = { schema: "mstar.review/v1", verdict: tally.verdict, tally, findings };
    const rendered = renderReviewMarkdown(review, { surface: "local-report" });
    // The list item's content column is two spaces: anything deeper would turn
    // the body into an indented code block on the real renderer.
    const expected = `- **Evidence**:\n${["```ts", "const a = 1;", "```", "", "After the fence."]
      .map((line) => (line === "" ? "" : `  ${line}`))
      .join("\n")}`;
    expect(rendered).toContain(expected);
    // The body stays inside the list item: the bullets that follow are siblings.
    expect(rendered).toContain(`${expected}\n- **Location**: repo-wide\n- **Merge class**: should-fix`);
    expect(rendered).not.toContain("                ```ts");
  });

  test("(n) Merge class closes the rendered block, so an inserted Confidence lands immediately above it", () => {
    const rendered = renderReviewMarkdown(SETTLED_REVIEW, { surface: "github-comment" });
    // Merge class is the last bullet the renderer emits in the block.
    const block = rendered.slice(rendered.indexOf("\n\n### Findings"));
    const bullets = block.split("\n").filter((line) => line.startsWith("- **"));
    expect(bullets[bullets.length - 1]).toBe("- **Merge class**: nit");

    // Simulate the agent's insertion point: immediately above the trailing
    // Merge class line, the adjacency `validateFindingDoc({ prVariant: true })`
    // requires. The rendered block itself proves the insertion point is the
    // last bullet, so Confidence ends up directly above Merge class.
    const withConfidence = rendered.replace("- **Merge class**: nit", "- **Confidence**: HIGH\n- **Merge class**: nit");
    const lines = withConfidence.split("\n");
    const mergeAt = lines.indexOf("- **Merge class**: nit");
    expect(lines[mergeAt - 1]).toBe("- **Confidence**: HIGH");
    expect(lines.filter((line) => line.startsWith("- **Confidence**:"))).toHaveLength(1);
  });

  test("(o) an off-enum class still renders, in document order", () => {
    const findings = [
      { mergeClass: "blocker" as unknown as MergeClass, title: "Unknown class", body: "still published" },
      { mergeClass: "nit" as const, title: "Known class", body: "x" },
    ];
    const review: MstarReviewV1 = { schema: "mstar.review/v1", verdict: "needs fixes", findings };
    const body = renderReviewMarkdown(review, { surface: "github-comment" });
    expect(body).toContain("#### \u2022 Unknown class");
    expect(body).toContain("- **Merge class**: blocker");
    // Impact ranking lives in the envelope's order; a class re-sort would override it.
    expect(body.indexOf("#### \u2022 Unknown class")).toBeLessThan(body.indexOf("#### \u{1F535} Known class"));
  });

  test("(p) an off-enum verdict and class fall back to the neutral marker, not a prototype member", () => {
    const review = {
      schema: "mstar.review/v1",
      verdict: "constructor",
      findings: [{ mergeClass: "toString", title: "Proto class", body: "x" }],
    } as unknown as MstarReviewV1;
    const body = renderReviewMarkdown(review, { surface: "github-comment" });
    expect(body.split("\n")[0]).toBe("## \u2022 Verdict: `constructor`");
    expect(body).toContain("#### \u2022 Proto class");
    expect(body).not.toContain("function");
  });

  test("(q) a newline-bearing cause or unscanned entry collapses to one line", () => {
    const review: MstarReviewV1 = {
      schema: "mstar.review/v1",
      verdict: "incomplete",
      findings: [],
      incomplete: { reason: "Seat\ntimed out", unscanned: ["src/a.ts\n", "src/b.ts"] },
    };
    const body = renderReviewMarkdown(review, { surface: "github-comment" });
    expect(body).toContain("cause: Seat timed out\nunscanned: src/a.ts, src/b.ts");
    expect(body.split("\n").filter((line) => line.startsWith("cause:") || line.startsWith("unscanned:"))).toHaveLength(2);
  });
});

describe("summary_md is an optional seat narrative", () => {
  test("(f) synthesizeReview emits no summary_md key and the envelope validates", () => {
    const synthesized = synthesizeReview({ findings: [] });
    expect("summary_md" in synthesized).toBe(false);
    expect(validateMstarReviewV1(synthesized).ok).toBe(true);
  });

  test("(g) a present-but-blank summary_md is refused", () => {
    const gate = validateMstarReviewV1({ ...SETTLED_REVIEW, summary_md: "   " });
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain("review.blank-summary");
  });

  test("(g2) a non-string summary_md is refused with the same blank code", () => {
    const gate = validateMstarReviewV1({ ...SETTLED_REVIEW, summary_md: 42 } as unknown as MstarReviewV1);
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain("review.blank-summary");
  });

  test("(g3) a non-string or blank summary_md is a TypeError \u2014 the blank-summary gate stays reachable", () => {
    expect(() =>
      synthesizeReview({ findings: [], summary_md: 42 } as unknown as Parameters<typeof synthesizeReview>[0]),
    ).toThrow(/summary_md must be a non-empty string when present/);
    expect(() => synthesizeReview({ findings: [], summary_md: " \n\t" })).toThrow(TypeError);
    // The validator refuses the same value, so nothing is publishable that the
    // synthesizer let through.
    const gate = validateMstarReviewV1({ ...SETTLED_REVIEW, summary_md: 42 } as unknown as MstarReviewV1);
    expect(gate.violations.map((v) => v.code)).toContain("review.blank-summary");
    // A hand-built envelope handed straight to the renderer still degrades to
    // the empty mandated section instead of throwing.
    const rendered = renderReviewMarkdown(
      { ...SETTLED_REVIEW, summary_md: 42 } as unknown as MstarReviewV1,
      { surface: "github-comment" },
    );
    expect(rendered.split("\n").filter((line) => line === "## \u{1F4CB} Review")).toHaveLength(1);
  });

  test("a blank supplied summary is a TypeError, not a silent drop", () => {
    expect(() => synthesizeReview({ findings: [], summary_md: " \n\t" })).toThrow(TypeError);
    // An absent value stays legal — that is the optional-narrative contract.
    const absent = synthesizeReview({ findings: [] });
    expect("summary_md" in absent).toBe(false);
    expect(validateMstarReviewV1(absent).ok).toBe(true);
    expect(renderReviewMarkdown(absent, { surface: "local-report" }).endsWith("\n\n## \u{1F4CB} Review")).toBe(true);
  });
});
