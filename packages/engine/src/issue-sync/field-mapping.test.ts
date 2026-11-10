/**
 * field-mapping.test.ts -- the ONE correspondence between local issue fields
 * and Linear's, used by import and push through two directional function sets.
 * Run with `bun test packages/engine/src/issue-sync/field-mapping.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { ISSUE_DISPOSITIONS, type Disposition, type Severity } from "../issue.js";
import type { LinearFacetMapping } from "../mstarc.js";
import { SyncError } from "../issue-sync.js";
import type { ProviderItem } from "./provider.js";
import {
  kindOfItem,
  labelOfKind,
  defaultStateOfDisposition,
  priorityOfSeverity,
  providerPayloadFields,
  severityOfPriority,
  stateOfDisposition,
} from "./field-mapping.js";
import * as mapping from "./field-mapping.js";

function facets(overrides: Partial<LinearFacetMapping> = {}): LinearFacetMapping {
  return { disposition: {}, kind: {}, severity: {}, ...overrides };
}

function item(overrides: Partial<ProviderItem> = {}): ProviderItem {
  return {
    externalId: "LIN-1",
    title: "Remote title",
    description: "Remote description",
    state: "Todo",
    priority: "high",
    labels: ["bug"],
    updatedAt: "2026-10-31T00:00:00.000Z",
    url: "https://linear.app/acme/issue/LIN-1",
    ...overrides,
  };
}

describe("push direction: severity -> priority (D7)", () => {
  test("low and nit both collapse to priority 4, and the module exposes no inverse", () => {
    expect(priorityOfSeverity("low")).toBe(4);
    expect(priorityOfSeverity("nit")).toBe(4);
    expect(priorityOfSeverity("critical")).toBe(1);
    expect(priorityOfSeverity("high")).toBe(2);
    expect(priorityOfSeverity("medium")).toBe(3);

    // The collapse is the reason no inverse exists: priority 4 cannot name a
    // single local severity. Nothing in the module is a `from*` converter.
    expect(severityOfPriority("4")).toBe("low");
    expect((Object.keys(mapping) as string[]).filter((name) => /^from/i.test(name))).toEqual([]);
  });

  test("an unknown severity is refused rather than defaulted", () => {
    expect(() => priorityOfSeverity("blocker" as Severity)).toThrow(SyncError);
    try {
      priorityOfSeverity("blocker" as Severity);
    } catch (error) {
      expect((error as SyncError).code).toBe("sync.invalid-input");
      expect((error as Error).message).toContain("blocker");
    }
  });

  test("a [linear.mapping] severity override retargets the pushed priority", () => {
    // The key is the band the default produced, so the same table entry never
    // means two different things in the two directions.
    expect(priorityOfSeverity("high", facets({ severity: { 2: "1" } }))).toBe(1);
    expect(priorityOfSeverity("low", facets({ severity: { 4: "3" } }))).toBe(3);
    // An import-side key is inert here: import's keys are LOCAL values.
    expect(priorityOfSeverity("high", facets({ severity: { high: "critical" } }))).toBe(2);
    // A target that is not a Linear priority band is refused by name.
    expect(() => priorityOfSeverity("high", facets({ severity: { 2: "5" } }))).toThrow(/not a recognised value/);
    expect(() => priorityOfSeverity("high", facets({ severity: { 2: "urgent" } }))).toThrow(SyncError);
  });
});

describe("push direction: disposition -> workflow state (D7)", () => {
  test("every retired disposition maps to Canceled; resolved is Done; open is Todo", () => {
    for (const retired of ["waived", "duplicate", "superseded", "obsolete"] as const) {
      expect(stateOfDisposition(retired)).toBe("Canceled");
    }
    expect(stateOfDisposition("resolved")).toBe("Done");
    expect(stateOfDisposition("open")).toBe("Todo");
  });

  test("the mapping covers every declared disposition, so a new one cannot ship unmapped", () => {
    // An unmapped local disposition would throw at push time; derive the check
    // from the one vocabulary instead of a second list of names.
    for (const disposition of ISSUE_DISPOSITIONS) {
      expect(() => stateOfDisposition(disposition)).not.toThrow();
      expect(["Todo", "Done", "Canceled"]).toContain(stateOfDisposition(disposition));
    }
    // Retirement is never completion, `obsolete` included.
    expect(defaultStateOfDisposition("obsolete")).not.toBe(defaultStateOfDisposition("resolved"));
  });

  test("an unknown disposition is refused rather than defaulted", () => {
    expect(() => stateOfDisposition("archived" as Disposition)).toThrow(SyncError);
  });

  test("a [linear.mapping] disposition override retargets the pushed state name", () => {
    expect(stateOfDisposition("open", facets({ disposition: { Todo: "Backlog" } }))).toBe("Backlog");
    expect(stateOfDisposition("waived", facets({ disposition: { Canceled: "Cancelled" } }))).toBe("Cancelled");
    // Retired never reads as Done, overridden or not.
    expect(stateOfDisposition("waived", facets({ disposition: { Done: "Shipped" } }))).toBe("Canceled");
  });
});

describe("kind label", () => {
  test("defaults to the identity label name and a kind.<kind> override retargets it", () => {
    expect(labelOfKind("bug")).toBe("bug");
    expect(labelOfKind("review-obligation")).toBe("review-obligation");
    expect(labelOfKind("bug", facets({ kind: { bug: "defect" } }))).toBe("defect");
    // The target is a label name, not a local enum value: existence is resolved
    // against the discovered workspace label set at push time, never guessed.
    expect(labelOfKind("risk", facets({ kind: { risk: "tech-debt" } }))).toBe("tech-debt");
    expect(() => labelOfKind("regression" as never)).toThrow(SyncError);
  });
});

describe("import direction keeps its behaviour", () => {
  test("a label naming a local kind selects it, otherwise the lossy request fallback", () => {
    expect(kindOfItem(item({ labels: ["Bug"] }))).toBe("bug");
    expect(kindOfItem(item({ labels: ["enhancement", "risk"] }))).toBe("risk");
    expect(kindOfItem(item({ labels: [] }))).toBe("request");
    expect(kindOfItem(item({ labels: ["unrelated"] }))).toBe("request");
  });

  test("priority maps onto the local severity, with a missing or unrecognised one landing on medium", () => {
    expect(severityOfPriority("urgent")).toBe("critical");
    expect(severityOfPriority("1")).toBe("critical");
    expect(severityOfPriority("High")).toBe("high");
    expect(severityOfPriority("2")).toBe("high");
    expect(severityOfPriority("3")).toBe("medium");
    expect(severityOfPriority("low")).toBe("low");
    expect(severityOfPriority("4")).toBe("low");
    expect(severityOfPriority(null)).toBe("medium");
    expect(severityOfPriority("none")).toBe("medium");
  });

  test("[linear.mapping] retargets the captured kind and severity, and an illegal target is refused", () => {
    expect(kindOfItem(item(), facets({ kind: { bug: "risk" } }))).toBe("risk");
    expect(severityOfPriority("high", facets({ severity: { high: "critical" } }))).toBe("critical");
    expect(() => kindOfItem(item(), facets({ kind: { bug: "defect" } }))).toThrow(/not a recognised value/);
    expect(() => severityOfPriority("low", facets({ severity: { low: "nonexistent" } }))).toThrow(SyncError);
  });
});

describe("providerPayloadFields", () => {
  test("composes the three mapped fields the push payload needs", () => {
    expect(providerPayloadFields({ kind: "bug", severity: "high", disposition: "open" })).toEqual({
      priority: 2,
      state: "Todo",
      label: "bug",
    });
    expect(
      providerPayloadFields(
        { kind: "risk", severity: "nit", disposition: "superseded" },
        facets({ kind: { risk: "tech-debt" }, severity: { 4: "2" }, disposition: { Canceled: "Cancelled" } }),
      ),
    ).toEqual({ priority: 2, state: "Cancelled", label: "tech-debt" });
  });
});
