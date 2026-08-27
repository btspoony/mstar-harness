/**
 * Engine pr-review tally tests — worked-example check-table fixtures plus
 * the score/verdict invariants.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - 9-row worked-example check table: `mstar-audit/references/pr-review.md`
 *   § Worked examples (check table) — each row's input → expected score_pct
 *   + verdict, verbatim. The table is the SSOT; these fixtures mirror it
 *   row-for-row.
 * - Tally/score formula: pr-review.md § Tally and derived score — integer
 *   arithmetic only, floor at 0, no second formula.
 * - Leftover unmet-AC increments: pr-review.md § Tally and derived score —
 *   unsafe-to-ship → must_fix + 1, else should_fix + 1; a tally increment,
 *   not a fourth class, not a second finding.
 * - Override invariant: pr-review.md § Override invariant — score never
 *   overrides verdict.
 * - Display contract: pr-review.md § Display contract (chat output) — the
 *   two-line chat header, verbatim.
 *
 * Report-path tests (`prReviewReportPath`) arrive with Task 3 — this file is
 * tally-only.
 */
import { describe, expect, test } from "bun:test";
import { computePrTally } from "../src/prreview.js";
import type { GateResult } from "../src/core.js";
import type { PrTallyInput, PrTallyResult, PrVerdict } from "../src/prreview.js";

/**
 * The 9-row worked-example check table from pr-review.md § Worked examples,
 * transcribed verbatim. Each row: input (findings / unverified / leftover
 * unmet ACs) → expected score_pct + verdict + display line.
 */
const CHECK_TABLE: Array<{
  row: number;
  label: string;
  input: PrTallyInput;
  expected: {
    scorePct: number;
    verdict: PrVerdict;
    tally: PrTallyResult["tally"];
    display: string;
  };
}> = [
  {
    row: 1,
    label: "0 / 0 / 0 / 0 + 1 leftover unmet AC",
    input: { findings: [], unverifiedCount: 0, unmetAc: [{ unsafeToShip: false }] },
    expected: {
      scorePct: 85,
      verdict: "needs fixes",
      tally: { mustFix: 0, shouldFix: 1, nit: 0, unverified: 0 },
      display: "needs fixes · 85%",
    },
  },
  {
    row: 2,
    label: "0 / 0 / 0 / 0 + 1 leftover unmet AC (unsafe-to-ship)",
    input: { findings: [], unverifiedCount: 0, unmetAc: [{ unsafeToShip: true }] },
    expected: {
      scorePct: 60,
      verdict: "blocked",
      tally: { mustFix: 1, shouldFix: 0, nit: 0, unverified: 0 },
      display: "blocked · 60%",
    },
  },
  {
    row: 3,
    label: "0 / 0 / 2 / 0",
    input: { findings: [{ mergeClass: "nit" }, { mergeClass: "nit" }], unverifiedCount: 0 },
    expected: {
      scorePct: 94,
      verdict: "ship it",
      tally: { mustFix: 0, shouldFix: 0, nit: 2, unverified: 0 },
      display: "ship it · 94%",
    },
  },
  {
    row: 4,
    label: "0 / 0 / 0 / 2",
    input: { findings: [], unverifiedCount: 2 },
    expected: {
      scorePct: 80,
      verdict: "ship it",
      tally: { mustFix: 0, shouldFix: 0, nit: 0, unverified: 2 },
      display: "ship it · 80%",
    },
  },
  {
    row: 5,
    label: "0 / 1 / 0 / 0",
    input: { findings: [{ mergeClass: "should-fix" }], unverifiedCount: 0 },
    expected: {
      scorePct: 85,
      verdict: "needs fixes",
      tally: { mustFix: 0, shouldFix: 1, nit: 0, unverified: 0 },
      display: "needs fixes · 85%",
    },
  },
  {
    row: 6,
    label: "0 / 1 / 1 / 0",
    input: {
      findings: [{ mergeClass: "should-fix" }, { mergeClass: "nit" }],
      unverifiedCount: 0,
    },
    expected: {
      scorePct: 82,
      verdict: "needs fixes",
      tally: { mustFix: 0, shouldFix: 1, nit: 1, unverified: 0 },
      display: "needs fixes · 82%",
    },
  },
  {
    row: 7,
    label: "1 / 0 / 0 / 0",
    input: { findings: [{ mergeClass: "must-fix" }], unverifiedCount: 0 },
    expected: {
      scorePct: 60,
      verdict: "blocked",
      tally: { mustFix: 1, shouldFix: 0, nit: 0, unverified: 0 },
      display: "blocked · 60%",
    },
  },
  {
    row: 8,
    label: "1 / 2 / 1 / 1",
    input: {
      findings: [
        { mergeClass: "must-fix" },
        { mergeClass: "should-fix" },
        { mergeClass: "should-fix" },
        { mergeClass: "nit" },
      ],
      unverifiedCount: 1,
    },
    expected: {
      scorePct: 17,
      verdict: "blocked",
      tally: { mustFix: 1, shouldFix: 2, nit: 1, unverified: 1 },
      display: "blocked · 17%",
    },
  },
  {
    row: 9,
    label: "3 / 0 / 0 / 0",
    input: {
      findings: [
        { mergeClass: "must-fix" },
        { mergeClass: "must-fix" },
        { mergeClass: "must-fix" },
      ],
      unverifiedCount: 0,
    },
    expected: {
      scorePct: 0, // floor — 100 - 120 would be -20
      verdict: "blocked",
      tally: { mustFix: 3, shouldFix: 0, nit: 0, unverified: 0 },
      display: "blocked · 0%",
    },
  },
];

describe("Worked-example check table — pr-review.md § Worked examples", () => {
  for (const row of CHECK_TABLE) {
    test(`row ${row.row} (${row.label}) → ${row.expected.verdict} · ${row.expected.scorePct}%`, () => {
      const result = computePrTally(row.input);
      expect(result.scorePct).toBe(row.expected.scorePct);
      expect(result.verdict).toBe(row.expected.verdict);
      expect(result.tally).toEqual(row.expected.tally);
    });
  }
});

describe("Display contract — pr-review.md § Display contract (chat output)", () => {
  // The two-line chat header is verbatim: "{verdict} · {score_pct}%\n
  // must-fix=<n> should-fix=<n> nit=<n> unverified=<n>". Assert the full
  // string for every check-table row (≥ 3 cases).
  for (const row of CHECK_TABLE) {
    test(`row ${row.row} chatHeader is the verbatim two-line display`, () => {
      const result = computePrTally(row.input);
      const { tally } = result;
      expect(result.chatHeader).toBe(
        `${row.expected.display}\n` +
          `must-fix=${tally.mustFix} should-fix=${tally.shouldFix} nit=${tally.nit} unverified=${tally.unverified}`,
      );
    });
  }

  test("chatHeader first line carries the verdict token and score, second line the four-class tally", () => {
    const result = computePrTally({
      findings: [{ mergeClass: "must-fix" }, { mergeClass: "nit" }],
      unverifiedCount: 3,
    });
    expect(result.chatHeader).toBe(
      "blocked · 27%\nmust-fix=1 should-fix=0 nit=1 unverified=3",
    );
  });
});

describe("Floor at 0 — pr-review.md § Tally and derived score", () => {
  test("huge unverified count floors scorePct at 0, never negative", () => {
    const result = computePrTally({ findings: [], unverifiedCount: 100 });
    expect(result.scorePct).toBe(0);
    expect(result.scorePct).toBeGreaterThanOrEqual(0);
  });

  test("verdict stays precedence-driven at the floor: no must/should-fix → ship it even at 0%", () => {
    const result = computePrTally({ findings: [], unverifiedCount: 100 });
    expect(result.scorePct).toBe(0);
    expect(result.verdict).toBe("ship it");
  });

  test("verdict stays precedence-driven at the floor: a must-fix still blocks at 0%", () => {
    const result = computePrTally({
      findings: [{ mergeClass: "must-fix" }],
      unverifiedCount: 100,
    });
    expect(result.scorePct).toBe(0);
    expect(result.verdict).toBe("blocked");
  });
});

describe("Leftover unmet-AC increments — pr-review.md § Tally and derived score", () => {
  test("unsafe-to-ship leftover AC increments must_fix (→ blocked)", () => {
    const result = computePrTally({
      findings: [],
      unmetAc: [{ unsafeToShip: true }],
    });
    expect(result.tally.mustFix).toBe(1);
    expect(result.tally.shouldFix).toBe(0);
    expect(result.verdict).toBe("blocked");
    expect(result.scorePct).toBe(60);
  });

  test("ship-safe leftover AC increments should_fix (→ needs fixes)", () => {
    const result = computePrTally({
      findings: [],
      unmetAc: [{ unsafeToShip: false }],
    });
    expect(result.tally.shouldFix).toBe(1);
    expect(result.tally.mustFix).toBe(0);
    expect(result.verdict).toBe("needs fixes");
    expect(result.scorePct).toBe(85);
  });

  test("mixed leftover ACs increment both branches", () => {
    const result = computePrTally({
      findings: [],
      unmetAc: [{ unsafeToShip: true }, { unsafeToShip: false }],
    });
    expect(result.tally).toEqual({ mustFix: 1, shouldFix: 1, nit: 0, unverified: 0 });
    expect(result.verdict).toBe("blocked");
    expect(result.scorePct).toBe(45);
  });

  test("AC increments are additive to accepted findings, not a replacement", () => {
    const result = computePrTally({
      findings: [{ mergeClass: "nit" }],
      unmetAc: [{ unsafeToShip: false }],
    });
    expect(result.tally).toEqual({ mustFix: 0, shouldFix: 1, nit: 1, unverified: 0 });
    expect(result.verdict).toBe("needs fixes");
    expect(result.scorePct).toBe(82);
  });
});

describe("Score never overrides verdict — pr-review.md § Override invariant", () => {
  test("blocked + highest possible score (60%) is still blocked", () => {
    const result = computePrTally({ findings: [{ mergeClass: "must-fix" }] });
    expect(result.scorePct).toBe(60);
    expect(result.verdict).toBe("blocked");
  });

  test("ship it + score < 100 is allowed (nits deducted)", () => {
    const result = computePrTally({
      findings: [{ mergeClass: "nit" }, { mergeClass: "nit" }],
    });
    expect(result.scorePct).toBe(94);
    expect(result.verdict).toBe("ship it");
  });

  test("ship it + score 0 is allowed (unverified deducted) — score never demotes", () => {
    const result = computePrTally({ findings: [], unverifiedCount: 100 });
    expect(result.scorePct).toBe(0);
    expect(result.verdict).toBe("ship it");
  });

  test("needs fixes + 85% still means address findings before merge", () => {
    const result = computePrTally({ findings: [{ mergeClass: "should-fix" }] });
    expect(result.scorePct).toBe(85);
    expect(result.verdict).toBe("needs fixes");
  });
});

describe("Empty input", () => {
  test("no findings, no unverified, no leftover ACs → ship it 100%", () => {
    const result = computePrTally({ findings: [] });
    expect(result.verdict).toBe("ship it");
    expect(result.scorePct).toBe(100);
    expect(result.tally).toEqual({ mustFix: 0, shouldFix: 0, nit: 0, unverified: 0 });
  });

  test("omitted unverifiedCount defaults to 0", () => {
    const result = computePrTally({ findings: [] });
    expect(result.tally.unverified).toBe(0);
    expect(result.scorePct).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// prReviewReportPath — pr-review.md § Local report archive (Filename bullet)
// ---------------------------------------------------------------------------
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "bun:test";
import { prReviewReportPath, validatePrReviewReport } from "../src/prreview.js";
import type { PrReportTarget } from "../src/prreview.js";

describe("computePrTally — engine boundary guard (plan-QC F-005)", () => {
  test("negative unverifiedCount throws TypeError instead of minting score_pct > 100", () => {
    // Before the guard: 100 - 10 * (-1) = 110 — out of range.
    expect(() => computePrTally({ findings: [], unverifiedCount: -1 })).toThrow(TypeError);
    expect(() => computePrTally({ findings: [], unverifiedCount: -1 })).toThrow(/unverifiedCount must be a non-negative integer/);
  });

  test.each([0.5, -0.25])("fractional unverifiedCount %p is rejected", (n) => {
    expect(() => computePrTally({ findings: [], unverifiedCount: n })).toThrow(TypeError);
  });

  test("NaN unverifiedCount is rejected (non-integer)", () => {
    expect(() => computePrTally({ findings: [], unverifiedCount: Number.NaN })).toThrow(TypeError);
  });
});

describe("prReviewReportPath — target forms (pr-review.md § Local report archive, Filename)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-prreview-path-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const reportsDir = (name: string): string => {
    const dir = join(tmp, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  test("pr target → <date>-pr<N>.md", () => {
    const dir = reportsDir("pr");
    expect(prReviewReportPath({ reportsDir: dir, date: "2026-08-24", target: { kind: "pr", n: 134 } })).toBe(
      join(dir, "2026-08-24-pr134.md"),
    );
  });

  test("branch target → <date>-<branch-slug>.md", () => {
    const dir = reportsDir("branch");
    expect(prReviewReportPath({ reportsDir: dir, date: "2026-08-24", target: { kind: "branch", slug: "feat-x" } })).toBe(
      join(dir, "2026-08-24-feat-x.md"),
    );
  });

  test("diff target with head SHA → <date>-diff-<short-sha>.md (sha shortened to 7)", () => {
    const dir = reportsDir("diff-sha");
    expect(
      prReviewReportPath({
        reportsDir: dir,
        date: "2026-08-24",
        target: { kind: "diff", headSha: "abc1234def5678" },
      }),
    ).toBe(join(dir, "2026-08-24-diff-abc1234.md"));
  });

  test("diff target without head SHA → bare <date>-diff.md — never fabricates a sha", () => {
    const dir = reportsDir("diff-nosha");
    const resolved = prReviewReportPath({ reportsDir: dir, date: "2026-08-24", target: { kind: "diff" } });
    expect(resolved).toBe(join(dir, "2026-08-24-diff.md"));
    // Pure resolution: nothing is ever written, so nothing — least of all
    // an invented hex segment — appears in the directory.
    expect(readdirSync(dir)).toEqual([]);
  });

  test("date defaults to today when omitted; non-YYYY-MM-DD dates are rejected", () => {
    const dir = reportsDir("dates");
    const today = new Date();
    const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(prReviewReportPath({ reportsDir: dir, target: { kind: "pr", n: 1 } }).endsWith(`${local}-pr1.md`)).toBe(true);
    expect(() => prReviewReportPath({ reportsDir: dir, date: "20260824", target: { kind: "pr", n: 1 } })).toThrow(/YYYY-MM-DD/);
  });

  test("diff target with EMPTY-string headSha → bare <date>-diff.md too (empty = absent, never fabricates)", () => {
    const dir = reportsDir("diff-nosha-empty");
    const resolved = prReviewReportPath({ reportsDir: dir, date: "2026-08-24", target: { kind: "diff", headSha: "" } });
    expect(resolved).toBe(join(dir, "2026-08-24-diff.md"));
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("prReviewReportPath — collision escalation -r2/-r3 across report AND stage files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-prreview-collide-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  let dir: string;

  const seed = (name: string): void => writeFileSync(join(dir, name), "x\n");

  test("first resolve returns the plain name; second same-day resolve returns -r2 without touching r1", () => {
    dir = join(tmp, "escalate");
    mkdirSync(dir, { recursive: true });
    const first = prReviewReportPath({ reportsDir: dir, date: "2026-08-24", target: { kind: "pr", n: 7 } });
    expect(first).toBe(join(dir, "2026-08-24-pr7.md"));
    writeFileSync(first, "report v1\n");
    const second = prReviewReportPath({ reportsDir: dir, date: "2026-08-24", target: { kind: "pr", n: 7 } });
    expect(second).toBe(join(dir, "2026-08-24-pr7-r2.md"));
    // The resolver never writes/overwrites: only r1 (written by the caller)
    // exists; r2 exists solely as the NEXT path handed back.
    expect(readdirSync(dir)).toEqual(["2026-08-24-pr7.md"]);
    expect(readFileSync(join(dir, "2026-08-24-pr7.md"), "utf8")).toBe("report v1\n");
  });

  test("-r3 follows an existing -r2 (never reuses or overwrites any prior revision)", () => {
    seed("2026-08-25-pr8-r2.md");
    const third = prReviewReportPath({ reportsDir: dir, date: "2026-08-25", target: { kind: "pr", n: 8 } });
    expect(third.endsWith("2026-08-25-pr8-r3.md")).toBe(true);
    writeFileSync(third, "v3\n");
    const fourth = prReviewReportPath({ reportsDir: dir, date: "2026-08-25", target: { kind: "pr", n: 8 } });
    expect(fourth.endsWith("2026-08-25-pr8-r4.md")).toBe(true);
    // Never overwrite: every prior file survived byte-for-byte.
    expect(readFileSync(join(dir, "2026-08-25-pr8-r2.md"), "utf8")).toBe("x\n");
    expect(readFileSync(join(dir, "2026-08-25-pr8-r3.md"), "utf8")).toBe("v3\n");
  });

  test("collision scan covers stage evidence files too (-stage1/-stage2 escalate on their own stems)", () => {
    seed("2026-08-26-pr9-stage1-api-seat.md");
    const stage1Again = prReviewReportPath({
      reportsDir: dir,
      date: "2026-08-26",
      target: { kind: "pr", n: 9 },
      stage: 1,
      slug: "api-seat",
    });
    expect(stage1Again.endsWith("2026-08-26-pr9-stage1-api-seat-r2.md")).toBe(true);
    // The stage-1 collision must not bleed into the stage-2 stem.
    const stage2 = prReviewReportPath({
      reportsDir: dir,
      date: "2026-08-26",
      target: { kind: "pr", n: 9 },
      stage: 2,
      slug: "api-seat",
    });
    expect(stage2.endsWith("2026-08-26-pr9-stage2-api-seat.md")).toBe(true);
    // And a report re-review does NOT collide with an unrelated evidence file.
    const reportAgain = prReviewReportPath({ reportsDir: dir, date: "2026-08-26", target: { kind: "pr", n: 9 } });
    expect(reportAgain.endsWith("2026-08-26-pr9.md")).toBe(true);
  });

  test("same-day re-review never returns an already-existing path (plan Task 2 contract item 6)", () => {
    for (let i = 0; i < 5; i++) {
      const next = prReviewReportPath({ reportsDir: dir, date: "2026-08-27", target: { kind: "branch", slug: "topic-a" } });
      writeFileSync(next, `gen ${i}\n`);
      expect(readdirSync(dir).filter((f) => f.startsWith("2026-08-27-topic-a"))).toHaveLength(i + 1);
    }
    const names = readdirSync(dir).filter((f) => f.startsWith("2026-08-27-topic-a"));
    expect(new Set(names).size).toBe(5);
  });

  test("a same-stem DIRECTORY occupies the name — non-file dirents count as taken (plan-QC F-002)", () => {
    dir = join(tmp, "occupied-dir");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "2026-08-28-pr10.md"));
    const resolved = prReviewReportPath({ reportsDir: dir, date: "2026-08-28", target: { kind: "pr", n: 10 } });
    expect(resolved.endsWith("2026-08-28-pr10-r2.md")).toBe(true);
  });

  test("a same-stem SYMLINK occupies the name — resolver never hands back a symlink-following path (plan-QC F-002)", () => {
    dir = join(tmp, "occupied-symlink");
    mkdirSync(dir, { recursive: true });
    const escapeDir = mkdtempSync(join(tmpdir(), "engine-prreview-outside-"));
    symlinkSync(join(escapeDir, "target.md"), join(dir, "2026-08-28-pr11.md"));
    try {
      const resolved = prReviewReportPath({ reportsDir: dir, date: "2026-08-28", target: { kind: "pr", n: 11 } });
      // Without name-based occupancy the resolver would return the link path
      // itself and a caller write would follow it out of reportsDir.
      expect(resolved.endsWith("2026-08-28-pr11-r2.md")).toBe(true);
      expect(resolved.startsWith(dir)).toBe(true);
    } finally {
      rmSync(join(dir, "2026-08-28-pr11.md"));
      rmSync(escapeDir, { recursive: true, force: true });
    }
  });
});

describe("prReviewReportPath — argument contract errors", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-prreview-args-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("missing --slug with --stage throws (slug <domain>-<seat> is required whenever stage is given)", () => {
    expect(() =>
      // @ts-expect-error — slug deliberately omitted alongside stage to prove runtime enforcement
      prReviewReportPath({ reportsDir: tmp, date: "2026-08-24", target: { kind: "pr", n: 3 }, stage: 1 }),
    ).toThrow(/slug/);
    expect(() =>
      // @ts-expect-error — symmetric case: slug without stage is also rejected
      prReviewReportPath({ reportsDir: tmp, date: "2026-08-24", target: { kind: "pr", n: 3 }, slug: "api-seat" }),
    ).toThrow(/stage and slug go together/);
  });

  test("reportsDir that does not exist yet resolves from an empty scan (no crash, plain name)", () => {
    const missing = join(tmp, "not-created-yet");
    expect(prReviewReportPath({ reportsDir: missing, date: "2026-08-24", target: { kind: "pr", n: 5 } })).toBe(
      join(missing, "2026-08-24-pr5.md"),
    );
  });
});

// ---------------------------------------------------------------------------
// validatePrReviewReport — § Output shape / § Local report archive Frontmatter
// ---------------------------------------------------------------------------

/** Minimal valid report fixture, parameterized so each test can corrupt
 * exactly one facet. Tally {1 should-fix, 2 nit} ⇒ 100-15-6=79, needs fixes. */
function report(frontmatter: string): string {
  return `---
type: pr-review
pr: 134
head: abc1234567890abcdef
base: main
verdict: needs fixes
score_pct: 79
tally: { must-fix: 0, should-fix: 1, nit: 2, unverified: 0 }
comments: posted
review_url: https://github.com/example/repo/pull/134#pullrequestreview-1
generated_at: 2026-08-24
${frontmatter}---

- findings: none material
`;
}

const VALID_MINIMAL = report("");

function codes(result: GateResult): string[] {
  return result.violations.map((v) => v.code);
}

describe("validatePrReviewReport — valid reports pass", () => {
  test("minimal valid report (no tier) passes", () => {
    const gate = validatePrReviewReport(VALID_MINIMAL);
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test.each(["tier: quick", "tier: default", "tier: deep"] as const)(
    "optional tier accepted: %s",
    (line) => {
      expect(validatePrReviewReport(report(`${line}\n`)).ok).toBe(true);
    },
  );
  test("report shaped exactly like the pr-review.md § Local report archive frontmatter template passes (plan-QC F-001)", () => {
    // Template keys, in template order — no fixture-only extras. The
    // optional `tier` and `pipeline` lines are left out (template marks
    // them optional); `comments` must NOT trip missing-comments anymore.
    const fromTemplate = `---
type: pr-review
pr: 134
url: https://github.com/example/repo/pull/134
head: abc1234567890abcdef
base: main
verdict: needs fixes
score_pct: 79
tally: { must-fix: 0, should-fix: 1, nit: 2, unverified: 0 }
comments: posted
review_url: https://github.com/example/repo/pull/134#pullrequestreview-1
generated_at: 2026-08-24
---

- findings: none material
`;
    const gate = validatePrReviewReport(fromTemplate);
    expect(gate.ok).toBe(true);
    expect(codes(gate)).toEqual([]);
  });
});

describe("validatePrReviewReport — arithmetic drift flags", () => {
  test("score_pct contradicting computePrTally recompute is flagged", () => {
    const bad = report("").replace("score_pct: 79", "score_pct: 90");
    const gate = validatePrReviewReport(bad);
    expect(gate.ok).toBe(false);
    expect(codes(gate)).toContain("prreview.report.score-mismatch");
  });

  test("verdict chosen against the tally derivation is flagged (score never overrides verdict either way)", () => {
    const bad = report("").replace("verdict: needs fixes", "verdict: ship it");
    const gate = validatePrReviewReport(bad);
    expect(gate.ok).toBe(false);
    expect(codes(gate)).toContain("prreview.report.verdict-mismatch");
  });

  test("must-fix tally with ship-it verdict is flagged even at matching score", () => {
    const blockedTally = report("")
      .replace("tally: { must-fix: 0, should-fix: 1, nit: 2, unverified: 0 }", "tally: { must-fix: 1, should-fix: 0, nit: 0, unverified: 0 }")
      .replace("score_pct: 79", "score_pct: 60")
      .replace("verdict: needs fixes", "verdict: ship it");
    const gate = validatePrReviewReport(blockedTally);
    expect(gate.ok).toBe(false);
    expect(codes(gate)).toContain("prreview.report.verdict-mismatch");
    expect(codes(gate)).not.toContain("prreview.report.score-mismatch"); // score itself is arithmetically right
  });
});

describe("validatePrReviewReport — comments tri-state (failed ≠ n/a-no-pr)", () => {
  test("comments: failed with failed: summary review_url passes as its own state", () => {
    const failed = report("")
      .replace("comments: posted", "comments: failed")
      .replace(
        "review_url: https://github.com/example/repo/pull/134#pullrequestreview-1",
        "review_url: failed: gh: HTTP 502 submitting review",
      );
    expect(validatePrReviewReport(failed).ok).toBe(true);
  });

  test("collapsed failure — review_url failed: but comments n/a-no-pr — is flagged (never collapse failed into n/a-no-pr)", () => {
    const collapsed = report("")
      .replace("comments: posted", "comments: n/a-no-pr")
      .replace(
        "review_url: https://github.com/example/repo/pull/134#pullrequestreview-1",
        "review_url: failed: gh: HTTP 502 submitting review",
      );
    const gate = validatePrReviewReport(collapsed);
    expect(gate.ok).toBe(false);
    expect(codes(gate)).toContain("prreview.report.failed-comments-collapsed");
  });

  test("n/a-no-pr pairs with review_url n/a; unknown comments token rejected", () => {
    const na = report("")
      .replace("comments: posted", "comments: n/a-no-pr")
      .replace("review_url: https://github.com/example/repo/pull/134#pullrequestreview-1", "review_url: n/a");
    expect(validatePrReviewReport(na).ok).toBe(true);

    const gibberish = report("").replace("comments: posted", "comments: probably-fine");
    const gate = validatePrReviewReport(gibberish);
    expect(gate.ok).toBe(false);
    expect(codes(gate)).toContain("prreview.report.invalid-comments");
  });
});

describe("validatePrReviewReport — structure checks", () => {
  test("missing frontmatter fence → fail with missing-frontmatter", () => {
    const gate = validatePrReviewReport("# just markdown, no yaml\n\ntext\n");
    expect(gate.ok).toBe(false);
    expect(codes(gate)).toEqual(["prreview.report.missing-frontmatter"]);
  });

  test("bad generated_at flagged; wrong type flagged; invalid tier value flagged", () => {
    const badDate = report("").replace("generated_at: 2026-08-24", "generated_at: Aug 24 2026");
    expect(codes(validatePrReviewReport(badDate))).toContain("prreview.report.invalid-generated-at");

    const badType = report("").replace("type: pr-review", "type: code-review");
    expect(codes(validatePrReviewReport(badType))).toContain("prreview.report.invalid-type");

    const badTier = report("tier: turbo\n");
    expect(codes(validatePrReviewReport(badTier))).toContain("prreview.report.invalid-tier");
  });

  test("required fields enforced: dropping generated_at and comments is two violations", () => {
    const stripped = report("").replace("comments: posted\n", "").replace("generated_at: 2026-08-24\n", "");
    const gateCodes = codes(validatePrReviewReport(stripped));
    expect(gateCodes).toContain("prreview.report.missing-generated_at");
    expect(gateCodes).toContain("prreview.report.missing-comments");
  });
});

import { prReviewSeatPrompt, validateFindingDoc } from "../src/prreview.js";

/**
 * Fix-round-2 regressions (plan 20260826-prreview-execution task 1):
 *
 * - `validateFindingDoc` Confidence accepts the LEADING enum token out of
 *   `AUDIT_CONFIDENCES` (HIGH | MED | LOW) with `MEDIUM` tolerated as the
 *   MED alias; free-text gloss after a separator is allowed (review I-3:
 *   the round-1 regex lost `LOW`). Bogus tokens stay flagged.
 * - `prReviewSeatPrompt` collect-wave gating (review I-2 doc/code match):
 *   SSOT pr-review.md § Review depth — `default` folds collection into
 *   the two domain seats ("collection folded in = seat reuse"), only
 *   `deep` fans Stage 1 collect seats as one wave (§ Cuttable vs never-cut:
 *   "stage-as-wave"). So the stage-as-wave line is DEEP-ONLY in prompts.
 */

function findingWithConfidence(confidence: string): string {
  return [
    "### [BUG-1] sample finding",
    "- **Evidence**: `src/x.ts:123` - observation",
    "- **Impact**: minor",
    "- **Effort**: S",
    "- **Risk**: LOW",
    `- **Confidence**: ${confidence}`,
  ].join("\n");
}

describe("validateFindingDoc — Confidence leading token incl. LOW (fix round 2, I-3)", () => {
  test("exact `Confidence: LOW` is accepted (regression: round-1 regex dropped LOW)", () => {
    expect(validateFindingDoc(findingWithConfidence("LOW")).ok).toBe(true);
  });

  test("`Confidence: LOW <em dash> judgment call` gloss is accepted (leading-token-only read)", () => {
    expect(validateFindingDoc(findingWithConfidence("LOW \u2014 judgment call")).ok).toBe(true);
  });

  test("`Confidence: MEDIUM alias` is tolerated via the MED alias", () => {
    expect(validateFindingDoc(findingWithConfidence("MEDIUM alias")).ok).toBe(true);
  });

  test("bogus confidence token stays flagged as invalid-confidence", () => {
    const gate = validateFindingDoc(findingWithConfidence("SURE"));
    expect(gate.ok).toBe(false);
    expect(codes(gate)).toContain("prreview.finding.invalid-confidence");
  });
});

describe("prReviewSeatPrompt — collect-wave is deep-only, tiers differ (fix round 2, I-2)", () => {
  const waveLine = "fan out in one wave";
  const securitySeatLine = "independent cross-domain security seat";
  const base = {
    stage: 1 as const,
    domain: "backend",
    seat: "api",
    skillRoot: "/tmp/engine-seat-skill",
    worktreePath: "/tmp/engine-seat-worktree",
    reconFacts: [],
  };

  test("omitted tier (SSOT no-flag landing = default) has NO stage-as-wave collect-wave line", () => {
    expect(prReviewSeatPrompt(base)).not.toContain(waveLine);
  });

  test("explicit default tier behaves identically to the omitted tier on collect-wave", () => {
    expect(prReviewSeatPrompt({ ...base, tier: "default" })).not.toContain(waveLine);
  });

  test("deep tier KEEPS the collect-wave line", () => {
    expect(prReviewSeatPrompt({ ...base, tier: "deep" })).toContain(waveLine);
  });

  test("tier ingredient difference set: quick omits collect-wave AND the independent-security block", () => {
    const quick = prReviewSeatPrompt({ ...base, tier: "quick" });
    expect(quick).not.toContain(waveLine);
    expect(quick).not.toContain(securitySeatLine);
  });

  test("default omits the independent-security block while deep keeps it", () => {
    expect(prReviewSeatPrompt({ ...base, tier: "default" })).not.toContain(securitySeatLine);
    expect(prReviewSeatPrompt({ ...base, tier: "deep" })).toContain(securitySeatLine);
  });
});

// ---------------------------------------------------------------------------
// validateMstarReviewV1 — mstar.review/v1 envelope (SP3 review-json-kind)
// ---------------------------------------------------------------------------
import { validateMstarReviewV1 } from "../src/prreview.js";

/** Minimal valid `mstar.review/v1` fixture; each test corrupts one facet.
 * Tally {1 should-fix, 1 nit} ⇒ 100-15-3=82, needs fixes — consistent. */
function reviewDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "mstar.review/v1",
    verdict: "needs fixes",
    summary_md: "2 findings: 1 should-fix, 1 nit.",
    findings: [
      {
        mergeClass: "should-fix",
        category: "correctness",
        file_path: "src/foo.ts",
        line_start: 10,
        line_end: 12,
        title: "Unhandled null deref",
        body: "foo() can return null before the call site dereferences it.",
        fingerprint_hint: "abc123",
      },
      {
        mergeClass: "nit",
        title: "Typo in comment",
        body: "s/recieve/receive/",
      },
    ],
    tally: {
      verdict: "needs fixes",
      scorePct: 82,
      tally: { mustFix: 0, shouldFix: 1, nit: 1, unverified: 0 },
      chatHeader: "needs fixes \u00b7 82%\nmust-fix=0 should-fix=1 nit=1 unverified=0",
    },
    target: { owner: "example", repo: "repo", pr: 134, head_sha: "abc123" },
    ...overrides,
  };
}

describe("validateMstarReviewV1 — mstar.review/v1 envelope (SP3 review-json-kind)", () => {
  test("valid envelope with harness vocab passes (SP3-AC1)", () => {
    const gate = validateMstarReviewV1(reviewDoc());
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test("missing schema and wrong schema id fail-loud (SP3-AC3)", () => {
    const missing = reviewDoc();
    delete missing.schema;
    expect(codes(validateMstarReviewV1(missing))).toContain("review.missing-schema");

    const wrong = reviewDoc({ schema: "mstar.review/v2" });
    expect(codes(validateMstarReviewV1(wrong))).toContain("review.invalid-schema");
  });

  test("unknown verdict rejected (SP3-AC3)", () => {
    const gate = validateMstarReviewV1(reviewDoc({ verdict: "maybe" }));
    expect(gate.ok).toBe(false);
    expect(codes(gate)).toContain("review.invalid-verdict");
  });

  test("inspector M1 verdict vocab rejected with review.inspector-vocab (SP3-AC2)", () => {
    for (const verdict of ["comment", "request_changes", "approve"]) {
      const gate = validateMstarReviewV1(reviewDoc({ verdict }));
      expect(gate.ok).toBe(false);
      expect(codes(gate)).toContain("review.inspector-vocab");
    }
  });

  test("inspector M1 severity vocab in mergeClass rejected with review.inspector-vocab (SP3-AC2)", () => {
    for (const mergeClass of ["critical", "warning", "suggestion", "info"]) {
      const doc = reviewDoc();
      (doc.findings as Record<string, unknown>[])[0].mergeClass = mergeClass;
      const gate = validateMstarReviewV1(doc);
      expect(gate.ok).toBe(false);
      expect(codes(gate)).toContain("review.inspector-vocab");
    }
  });

  test("stray inspector M1 severity key on a finding rejected with review.inspector-vocab (SP3-AC2)", () => {
    const doc = reviewDoc();
    (doc.findings as Record<string, unknown>[])[0].severity = "critical";
    const gate = validateMstarReviewV1(doc);
    expect(gate.ok).toBe(false);
    expect(codes(gate)).toContain("review.inspector-vocab");
  });

  test("missing or empty title/body rejected (SP3-AC3)", () => {
    const missingTitle = reviewDoc();
    delete (missingTitle.findings as Record<string, unknown>[])[0].title;
    expect(codes(validateMstarReviewV1(missingTitle))).toContain("review.empty-title");

    const emptyTitle = reviewDoc();
    (emptyTitle.findings as Record<string, unknown>[])[0].title = "   ";
    expect(codes(validateMstarReviewV1(emptyTitle))).toContain("review.empty-title");

    const emptyBody = reviewDoc();
    (emptyBody.findings as Record<string, unknown>[])[0].body = "";
    expect(codes(validateMstarReviewV1(emptyBody))).toContain("review.empty-body");
  });

  test("non-array findings rejected (SP3-AC3)", () => {
    const gate = validateMstarReviewV1(reviewDoc({ findings: "none" }));
    expect(gate.ok).toBe(false);
    expect(codes(gate)).toContain("review.findings-not-array");
  });

  test("tally verdict disagreeing with top-level verdict rejected (consistency rule)", () => {
    const doc = reviewDoc();
    (doc.tally as Record<string, unknown>).verdict = "ship it";
    const gate = validateMstarReviewV1(doc);
    expect(gate.ok).toBe(false);
    expect(codes(gate)).toContain("review.verdict-tally-mismatch");
  });
});

// ---------------------------------------------------------------------------
// synthesizeReview — mstar.review/v1 envelope (SP3 review-json-kind)
// ---------------------------------------------------------------------------
import { synthesizeReview } from "../src/prreview.js";
import type { MstarReviewFinding } from "../src/prreview.js";

/** CHECK_TABLE findings carry only mergeClass; synthesizeReview needs full
 * findings (title/body required) — map each row's classes to full findings
 * so the 9-row table drives the envelope verdict/score assertions. */
function fullFindings(findings: PrTallyInput["findings"]): MstarReviewFinding[] {
  return findings.map((finding, index) => ({
    mergeClass: finding.mergeClass,
    title: `Finding ${index + 1}`,
    body: `Body for finding ${index + 1}.`,
  }));
}

/** The locked deterministic summary template (SP3-AC4) — exact bytes for
 * {1 should-fix, 1 nit} ⇒ 82, needs fixes. */
const LOCKED_SUMMARY = `## Verdict: needs fixes \u00b7 82%

must-fix=0 should-fix=1 nit=1 unverified=0

- should-fix: Unhandled null deref
- nit: Typo in comment`;

describe("synthesizeReview — mstar.review/v1 envelope (SP3 review-json-kind)", () => {
  test("9-row check table: same verdict/score/tally as computePrTally (SP3-AC4)", () => {
    for (const row of CHECK_TABLE) {
      const synthesized = synthesizeReview({
        findings: fullFindings(row.input.findings),
        unverifiedCount: row.input.unverifiedCount,
        unmetAc: row.input.unmetAc,
      });
      const direct = computePrTally(row.input);
      expect(synthesized.verdict).toBe(direct.verdict);
      expect(synthesized.tally).toEqual(direct);
      expect(synthesized.verdict).toBe(row.expected.verdict);
      expect(synthesized.tally?.scorePct).toBe(row.expected.scorePct);
      expect(synthesized.tally?.tally).toEqual(row.expected.tally);
      // The synthesized envelope is a valid mstar.review/v1 document.
      expect(validateMstarReviewV1(synthesized).ok).toBe(true);
    }
  });

  test("omitted summary_md uses the locked deterministic template (SP3-AC4)", () => {
    const findings: MstarReviewFinding[] = [
      {
        mergeClass: "should-fix",
        category: "correctness",
        file_path: "src/foo.ts",
        line_start: 10,
        line_end: 12,
        title: "Unhandled null deref",
        body: "foo() can return null before the call site dereferences it.",
        fingerprint_hint: "abc123",
      },
      {
        mergeClass: "nit",
        title: "Typo in comment",
        body: "s/recieve/receive/",
      },
    ];
    const synthesized = synthesizeReview({ findings });
    expect(synthesized.summary_md).toBe(LOCKED_SUMMARY);
  });

  test("empty findings lock the no-findings summary form", () => {
    const synthesized = synthesizeReview({ findings: [] });
    expect(synthesized.summary_md).toBe(`## Verdict: ship it \u00b7 100%

must-fix=0 should-fix=0 nit=0 unverified=0`);
  });

  test("explicit summary_md is preserved verbatim", () => {
    const summary_md = "Custom prose summary from the main agent.";
    const synthesized = synthesizeReview({ findings: [], summary_md });
    expect(synthesized.summary_md).toBe(summary_md);
  });

  test("findings pass through untouched (SP3-AC4)", () => {
    const findings: MstarReviewFinding[] = [
      { mergeClass: "must-fix", title: "Auth bypass", body: "Token check is skipped on the retry path." },
      { mergeClass: "nit", title: "Typo", body: "s/recieve/receive/", file_path: "src/a.ts", line_start: 3, line_end: 3 },
    ];
    const synthesized = synthesizeReview({ findings });
    expect(synthesized.findings).toBe(findings);
    expect(synthesized.findings).toEqual(findings);
  });

  test("target is carried through when provided, omitted otherwise", () => {
    const target = { owner: "example", repo: "repo", pr: 134, head_sha: "abc123" };
    expect(synthesizeReview({ findings: [], target }).target).toEqual(target);
    expect(synthesizeReview({ findings: [] }).target).toBeUndefined();
  });

  test("synchronous and deterministic — same input, same envelope (SP3-AC5)", () => {
    const findings = fullFindings([{ mergeClass: "must-fix" }, { mergeClass: "nit" }]);
    const first = synthesizeReview({ findings });
    const second = synthesizeReview({ findings });
    expect(first).not.toBeInstanceOf(Promise);
    expect(second).toEqual(first);
  });
});
