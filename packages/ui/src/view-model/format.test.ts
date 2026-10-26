/**
 * Formatting helpers: the honesty rules that must survive the dashboard move,
 * and the projection state that replaces the removed counters.
 */
import { describe, expect, test } from "bun:test";

import {
  NOT_KNOWN,
  UNKNOWN_DATE,
  countText,
  formatShortDate,
  formatDate,
  longText,
  progressText,
  projectionState,
  textOr,
} from "./format.ts";

describe("dates are shown as stored", () => {
  test("one timestamp form for every line that shows a timestamp", () => {
    // `design-v1.html:1444` prints a detail timestamp as `2026-10-23 09:14`: the
    // stored instant with the prototype's separator and precision, never the raw
    // ISO lexeme. The cell drops the year and the seconds (`formatShortDate`).
    expect(formatDate("2026-10-25T13:58:04.000Z")).toBe("2026-10-25 13:58");
    expect(formatDate("2026-10-25 13:58")).toBe("2026-10-25 13:58");
    expect(formatDate("2026-10-25")).toBe("2026-10-25");
    // A value that is not a timestamp is not re-shaped into one.
    expect(formatDate("yesterday")).toBe("yesterday");
  });

  test("an absent date says so instead of borrowing the read time", () => {
    expect(formatDate(null)).toBe(UNKNOWN_DATE);
    expect(formatDate(undefined)).toBe(UNKNOWN_DATE);
    expect(formatDate("   ")).toBe(UNKNOWN_DATE);
  });

  test("an undetermined value has its own copy, distinct from an absent date", () => {
    expect(NOT_KNOWN).not.toBe(UNKNOWN_DATE);
    expect(textOr(null, NOT_KNOWN)).toBe(NOT_KNOWN);
    expect(textOr("frontend-dev", NOT_KNOWN)).toBe("frontend-dev");
  });
});

describe("long text", () => {
  test("empty text is null so the caller renders its own absence arm", () => {
    expect(longText(null)).toBeNull();
    expect(longText("  \n ")).toBeNull();
  });

  test("stored text is returned unwrapped, keeping its line breaks", () => {
    expect(longText("line one\nline two")).toBe("line one\nline two");
  });
});

describe("counts and progress", () => {
  test("progress prints as done/total, or not at all", () => {
    expect(progressText({ done: 3, total: 6 })).toBe("3/6");
    expect(progressText(null)).toBeNull();
  });

  test("counts are pluralized", () => {
    expect(countText(1, "issue")).toBe("1 issue");
    expect(countText(0, "issue")).toBe("0 issues");
    expect(countText(1, "open issue")).toBe("1 open issue");
  });
});

describe("the projection state replaces the removed counters", () => {
  const base = {
    generation: 4,
    freshness: "current" as const,
    builtAt: "2026-10-25T05:00:00.000Z",
    checkedAt: "2026-10-25T05:01:00.000Z",
    diagnostics: [] as Array<{ sourceKey: string; reason: string; message: string }>,
  };

  test("current carries nothing else", () => {
    expect(projectionState(base)).toEqual({ kind: "current" });
  });

  test("stale and unavailable carry their reasons verbatim", () => {
    const diagnosed = {
      ...base,
      freshness: "stale" as const,
      diagnostics: [{ sourceKey: "compass", reason: "unreadable", message: "compass could not be parsed" }],
    };
    expect(projectionState(diagnosed)).toEqual({ kind: "stale", reasons: ["compass: compass could not be parsed"] });
    expect(projectionState({ ...diagnosed, freshness: "unavailable" }).kind).toBe("unavailable");
  });

  test("NEGATIVE: no timestamp or counter rides along (IA §8.1)", () => {
    const state = projectionState({ ...base, freshness: "stale" });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("2026-10-25T05:00:00.000Z");
    expect(serialized).not.toContain("builtAt");
    expect(serialized).not.toContain("checkedAt");
    expect(serialized).not.toContain("generation");
  });

  test("no generation means no projected rows — asserted through the resolver that owns it", () => {
    // `projectionUnavailable` was deleted: it duplicated the resolver's failure
    // arm and had no production caller. The rule is asserted in state.test.ts.
    expect(projectionState({ ...base, generation: null, freshness: "unavailable" }).kind).toBe("unavailable");
  });
});

describe("formatShortDate — the list cell's own form", () => {
  test("a timestamp loses its year and keeps month, day and time", () => {
    // `design-v1.html:1215`: the prototype's list cells print `10-25 13:58`.
    expect(formatShortDate("2026-10-24T09:06:22.000Z")).toBe("10-24 09:06");
    expect(formatShortDate("2026-10-25 13:58")).toBe("10-25 13:58");
  });

  test("a date with no time keeps the two-part form", () => {
    expect(formatShortDate("2026-10-25")).toBe("10-25");
  });

  test("an absent or non-date value keeps the honest copy, never NaN", () => {
    expect(formatShortDate(null)).toBe(UNKNOWN_DATE);
    expect(formatShortDate("yesterday")).toBe("yesterday");
  });
});
