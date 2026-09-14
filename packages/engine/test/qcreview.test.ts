/**
 * Engine `qcreview` — the QC seat-report contract (`mstar-review-qc` SKILL.md
 * § 席位预算与截断 / report-template.md § Frontmatter / § Findings).
 *
 * One case per violation code plus the valid-report baseline: rules 1-2
 * (frontmatter fence present and closed), rules 3-8 (required fields +
 * verdict agreement), rule 9 (Summary/Findings count parity), rule 10
 * (verdict vs counts), rule 11 (truncation vs verdict), and the
 * in-place revalidation contract (one refreshed tally; last verdict line wins).
 */
import { describe, expect, test } from "bun:test";
import { QC_VERDICTS, validateQcReport } from "../src/qcreview.js";

const PLAN_ID = "20990101-synthetic";

/** A report that satisfies all eleven rules (frontmatter + body + counts). */
const VALID_REPORT = `---
report_kind: "qc"
reviewer: "qc-specialist"
reviewer_index: 1
plan_id: "${PLAN_ID}"
verdict: "Approve"
generated_at: "2099-01-01"
---
# QC Report \u2014 synthetic plan

**Verdict**: Approve. Nothing survived the review.

## Summary

| Severity | Count |
| --- | --- |
| \ud83d\udd34 Critical | 0 |
| \ud83d\udfe1 Warning | 0 |
| \ud83d\udfe2 Suggestion | 0 |
| \u26aa Unconfirmed | 0 |

## Findings

### \ud83d\udd34 Critical

None.

### \ud83d\udfe1 Warning

None.

### \ud83d\udfe2 Suggestion

None.

### \u26aa Unconfirmed

None.

## Verdict rationale

Nothing to fix.
`;

const BODY_VERDICT_LINE = "**Verdict**: Approve. Nothing survived the review.";

/** Violation codes emitted for `text`, in order. */
function codes(text: string): string[] {
  return validateQcReport(text).violations.map((v) => v.code);
}

describe("validateQcReport \u2014 baseline", () => {
  test("verbatim verdict vocabulary is the published four-member enum", () => {
    expect(QC_VERDICTS).toEqual(["Approve", "Request Changes", "Needs Discussion", "Unconfirmed"]);
  });

  test("a conforming report is clean", () => {
    const gate = validateQcReport(VALID_REPORT);
    expect(gate.violations).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  test("every violation carries an actionable fix", () => {
    const gate = validateQcReport(VALID_REPORT.replace(BODY_VERDICT_LINE, ""));
    expect(gate.violations.length).toBeGreaterThan(0);
    for (const violation of gate.violations) {
      expect(violation.fix.length).toBeGreaterThan(0);
      expect(violation.code.startsWith("qcreview.report.")).toBe(true);
    }
  });
});

describe("validateQcReport \u2014 report rules", () => {
  test("rule 1: frontmatter fence required", () => {
    const gate = validateQcReport("# QC Report\n\n**Verdict**: Approve\n");
    expect(gate.violations).toEqual([
      {
        ok: false,
        severity: "high",
        code: "qcreview.report.missing-frontmatter",
        message: expect.stringContaining("frontmatter"),
        fix: expect.stringContaining("report_kind: qc"),
      },
    ]);
    expect(gate.ok).toBe(false);
  });

  test("rule 2: an unclosed frontmatter fence is not a document", () => {
// Without the closing `---` every later line is read as frontmatter and the
// body/ frontmatter boundary disappears, so the structural rules cannot
// judge anything — the gate reports the missing fence instead of passing.
    const text = VALID_REPORT.replace("\n---\n# QC Report", "\n# QC Report");
    expect(codes(text)).toEqual(["qcreview.report.unclosed-frontmatter"]);
    const gate = validateQcReport(text);
    expect(gate.ok).toBe(false);
    expect(gate.violations[0]!.severity).toBe("high");
    expect(gate.violations[0]!.fix).toContain("closing `---`");
  });

  test("rule 3: each missing or empty required field is reported", () => {
    expect(codes(VALID_REPORT.replace('reviewer_index: 1\n', ""))).toEqual(["qcreview.report.missing-reviewer_index"]);
    expect(codes(VALID_REPORT.replace("reviewer_index: 1", 'reviewer_index: ""'))).toEqual([
      "qcreview.report.missing-reviewer_index",
    ]);
  });

  test("rule 4: report_kind must be qc", () => {
    expect(codes(VALID_REPORT.replace('report_kind: "qc"', 'report_kind: "pr-review"'))).toEqual([
      "qcreview.report.invalid-report-kind",
    ]);
  });

  test("rule 5: frontmatter verdict must be the verbatim vocabulary", () => {
    expect(codes(VALID_REPORT.replace('verdict: "Approve"', 'verdict: "ship it"'))).toEqual([
      "qcreview.report.invalid-verdict",
    ]);
  });

  test("rule 6: generated_at must be YYYY-MM-DD", () => {
    expect(codes(VALID_REPORT.replace('generated_at: "2099-01-01"', 'generated_at: "01/01/2099"'))).toEqual([
      "qcreview.report.invalid-generated-at",
    ]);
  });

  test("rule 7: the body must carry a verdict line", () => {
    expect(codes(VALID_REPORT.replace(BODY_VERDICT_LINE, "Summary only, no verdict stated."))).toEqual([
      "qcreview.report.missing-body-verdict",
    ]);
  });

  test("rule 8: body verdict must match the frontmatter verdict", () => {
    expect(codes(VALID_REPORT.replace(BODY_VERDICT_LINE, "**Verdict**: Request Changes. One fix pending."))).toEqual([
      "qcreview.report.verdict-mismatch",
    ]);
  });

  test("rule 8: an out-of-vocabulary body verdict is itself a violation", () => {
    expect(codes(VALID_REPORT.replace(BODY_VERDICT_LINE, "**Verdict**: Needs work. See notes."))).toEqual([
      "qcreview.report.verdict-mismatch",
    ]);
  });

  test("rule 8: trailing prose and the historical 'Approve with residuals' shape stay clean", () => {
    const gate = validateQcReport(
      VALID_REPORT.replace(BODY_VERDICT_LINE, "## Verdict: **Approve with residuals** \u2014 W-1 deferred by the PM."),
    );
    expect(gate.violations).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  test("rule 9: Summary count must equal the Findings section entry count", () => {
    const text = VALID_REPORT.replace("| \ud83d\udfe2 Suggestion | 0 |", "| \ud83d\udfe2 Suggestion | 2 |");
    expect(codes(text)).toEqual(["qcreview.report.summary-count-mismatch"]);
  });

  test("rule 9: ordered-list findings count (and a matching count stays silent)", () => {
    const matching = VALID_REPORT.replace("| \ud83d\udfe2 Suggestion | 0 |", "| \ud83d\udfe2 Suggestion | 2 |").replace(
      "### \ud83d\udfe2 Suggestion\n\nNone.",
      "### \ud83d\udfe2 Suggestion\n\n1. **S-1** first entry.\n2. **S-2** second entry.",
    );
    expect(codes(matching)).toEqual([]);

    const stale = matching.replace("| \ud83d\udfe2 Suggestion | 2 |", "| \ud83d\udfe2 Suggestion | 1 |");
    expect(codes(stale)).toEqual(["qcreview.report.summary-count-mismatch"]);
  });

  test("rule 9: indented detail lines are not separate findings", () => {
    const text = VALID_REPORT.replace("| \ud83d\udfe2 Suggestion | 0 |", "| \ud83d\udfe2 Suggestion | 1 |").replace(
      "### \ud83d\udfe2 Suggestion\n\nNone.",
      "### \ud83d\udfe2 Suggestion\n\n- **S-1** summary line.\n  - Verification: ran the repro.\n  - Fix sketch: guard the call.",
    );
    expect(codes(text)).toEqual([]);
  });

  test("rule 9: an absent Findings section is undecidable and stays silent", () => {
    const text = VALID_REPORT.replace("| \ud83d\udfe2 Suggestion | 0 |", "| \ud83d\udfe2 Suggestion | 3 |").replace(
      "## Findings",
      "## Notes",
    );
    expect(codes(text)).toEqual([]);
  });

  test("rule 10: Approve with open Critical/Warning findings is rejected", () => {
    const text = VALID_REPORT.replace("| \ud83d\udfe1 Warning | 0 |", "| \ud83d\udfe1 Warning | 2 |").replace(
      "### \ud83d\udfe1 Warning\n\nNone.",
      "### \ud83d\udfe1 Warning\n\n- **W-1** first.\n- **W-2** second.",
    );
    expect(codes(text)).toEqual(["qcreview.report.verdict-contradicts-counts"]);
  });

  test("rule 10: Unconfirmed findings force the Unconfirmed verdict", () => {
    const text = VALID_REPORT.replace("| \u26aa Unconfirmed | 0 |", "| \u26aa Unconfirmed | 1 |").replace(
      "### \u26aa Unconfirmed\n\nNone.",
      "### \u26aa Unconfirmed\n\n- **U-1** source-review evidence channel failed.",
    );
    expect(codes(text)).toEqual(["qcreview.report.verdict-contradicts-counts"]);
  });

  test("rule 11: a truncated-coverage report cannot claim Unconfirmed", () => {
    const text = VALID_REPORT.replace('verdict: "Approve"', 'verdict: "Unconfirmed"')
      .replace(BODY_VERDICT_LINE, "**Verdict**: Unconfirmed. Sample only.")
      .replace("## Verdict rationale", "Truncated coverage: 3 of 40 files sampled." + "\n\n## Verdict rationale");
    expect(codes(text)).toEqual(["qcreview.report.truncation-verdict"]);
  });

  test("rule 11: an inline mention of truncated coverage is not a declaration", () => {
    const text = VALID_REPORT.replace('verdict: "Approve"', 'verdict: "Unconfirmed"')
      .replace(BODY_VERDICT_LINE, "**Verdict**: Unconfirmed. Sample only.")
      .replace("Nothing to fix.", "- The report carries no `Truncated coverage:` line.");
    expect(codes(text)).toEqual([]);
  });
});

describe("validateQcReport \u2014 in-place revalidation (one current state)", () => {
  /**
   * Targeted re-review per `qc-specialist-shared.md` § Targeted re-review: the
   * SAME file gains `## Revalidation`, the first-round verdict line stays as
   * narrative, `## Summary` + `## Findings` are refreshed to the post-fix
   * state, and the revalidation appends the final verdict line (last wins).
   */
  const REVALIDATED = VALID_REPORT.replace(
    BODY_VERDICT_LINE,
    "**Verdict**: Request Changes. W-1 open on the first round.",
  ).replace(
    "## Verdict rationale",
    [
      "## Revalidation",
      "",
      "- Re-checked the fix delta for the assigned range; W-1 (`guard the call`) is closed.",
      "- Per-finding disposition: W-1 closed; S-1 kept as a Suggestion.",
      "",
      "**Verdict**: Approve. No Critical/Warning findings remain.",
      "",
      "## Verdict rationale",
    ].join("\n"),
  );

  test("refreshed Summary + Revalidation section + final verdict line are clean", () => {
    const gate = validateQcReport(REVALIDATED);
    expect(gate.violations).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  test("a stale Summary behind a refreshed verdict is still caught", () => {
    const text = REVALIDATED.replace("| \ud83d\udfe1 Warning | 0 |", "| \ud83d\udfe1 Warning | 1 |")
      .replace("### \ud83d\udfe1 Warning\n\nNone.", "### \ud83d\udfe1 Warning\n\n- **W-1** guard the call.")
      // A tally written under `## Revalidation` is prose about the process —
      // the engine reads `## Summary` only, so this stays outside the count.
      .replace(
        "## Verdict rationale",
        "| Severity | Count |\n| --- | --- |\n| \ud83d\udfe1 Warning | 1 (open) |\n\n## Verdict rationale",
      );
    expect(codes(text)).toEqual(["qcreview.report.verdict-contradicts-counts"]);
  });
});
