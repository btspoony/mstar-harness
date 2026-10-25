/**
 * The parity guard for both dictionaries.
 *
 * Five things it holds, and the last one is the reason the task exists: a
 * translation pass must not be able to resurrect a surface D30 removed by adding a
 * string. The blacklist is IA §8.1's removed-fact list, so the check is derived
 * from the spec rather than from taste.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

import { en, zh, copyFor, isLocale, LOCALES, absenceCopy } from "./index.ts";
import { LocaleProvider, useCopy } from "./LocaleProvider.tsx";

/** Every leaf of a copy tree as `path -> string`, functions included as markers. */
function leaves(tree: unknown, prefix = ""): Record<string, string> {
  if (typeof tree === "string") return { [prefix]: tree };
  if (typeof tree === "function") return { [prefix]: "[function]" };
  if (tree === null || typeof tree !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    Object.assign(out, leaves(value, prefix === "" ? key : `${prefix}.${key}`));
  }
  return out;
}

const enLeaves = leaves(en);
const zhLeaves = leaves(zh);

describe("the two dictionaries declare the same key set", () => {
  test("key sets are equal, both ways", () => {
    const enKeys = Object.keys(enLeaves).sort();
    const zhKeys = Object.keys(zhLeaves).sort();
    expect(zhKeys.filter((key) => !enKeys.includes(key))).toEqual([]);
    expect(enKeys.filter((key) => !zhKeys.includes(key))).toEqual([]);
    expect(zhKeys).toEqual(enKeys);
  });

  test("no value is missing or blank in either locale", () => {
    for (const [locale, tree] of [["en", enLeaves], ["zh", zhLeaves]] as const) {
      const blank = Object.entries(tree)
        .filter(([, value]) => value !== "[function]" && value.trim() === "")
        .map(([key]) => `${locale}.${key}`);
      expect(blank).toEqual([]);
    }
  });

  test("every template function produces copy, not an empty string", () => {
    // A function leaf cannot be checked by reading it; it is called with
    // representative arguments instead. This is the only place the test knows a
    // signature, and it uses the narrowest argument every template accepts.
    const probes: Array<[string, () => string]> = [
      ["overview.plansProgress", () => en.overview.plansProgress(2, 5)],
      ["overview.gateStep", () => en.overview.gateStep(2, 5)],
      ["overview.milestonesSummary", () => en.overview.milestonesSummary(3, 4)],
      ["focus.bindingBound", () => en.focus.bindingBound("w")],
      ["focus.groupHeading", () => en.focus.groupHeading("InProgress", 2)],
      ["focus.deliveryLine", () => en.focus.deliveryLine("iter", 2, 5)],
      ["issues.resultSummary", () => en.issues.resultSummary(26)],
      ["issues.range", () => en.issues.range(1, 50, 120)],
      ["issueDetail.occurrenceCount", () => en.issueDetail.occurrenceCount(2)],
      ["workflows.truncated", () => en.workflows.truncated(1, 50)],
      ["iterations.attribution", () => en.iterations.attribution("absent")],
      ["projectDetail.roadmap.unassigned", () => en.projectDetail.roadmap.unassigned(3)],
      ["projectDetail.scope.label", () => en.projectDetail.scope.label("engine")],
    ];
    for (const [name, probe] of probes) expect(`${name}: ${probe()}`.length).toBeGreaterThan(name.length + 3);
    for (const [name, probe] of [
      ["zh.overview.plansProgress", () => zh.overview.plansProgress(2, 5)],
      ["zh.focus.deliveryLine", () => zh.focus.deliveryLine("iter", 2, 5)],
      ["zh.issues.range", () => zh.issues.range(1, 50, 120)],
      ["zh.iterations.attribution", () => zh.iterations.attribution("present")],
    ] as Array<[string, () => string]>) {
      expect(`${name}: ${probe()}`.length).toBeGreaterThan(name.length + 3);
    }
  });

  test("a locale that is not shipped falls back to English", () => {
    expect(copyFor("zh")).toBe(zh);
    expect(copyFor("en")).toBe(en);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale("zh")).toBe(true);
    expect(LOCALES).toEqual(["en", "zh"]);
  });
});

describe("enum values, ids, paths and timestamps stay literal", () => {
  // The product renders these verbatim so they can be copied into the CLI. A
  // translated `open` would be a defect, and so would a translated id.
  const LITERALS = [
    "open",
    "resolved",
    "waived",
    "duplicate",
    "superseded",
    "critical",
    "high",
    "medium",
    "low",
    "nit",
    "InProgress",
    "InReview",
    "Blocked",
    "Done",
    "running",
    "paused",
    "active",
    "archived",
    "not-applicable",
    "merge-ready",
    "pr-delivery",
  ];

  test("no dictionary value is exactly an enum literal", () => {
    for (const [locale, tree] of [["en", enLeaves], ["zh", zhLeaves]] as const) {
      const offenders = Object.entries(tree)
        .filter(([, value]) => LITERALS.includes(value.trim()))
        .map(([key, value]) => `${locale}.${key} = ${value}`);
      expect(offenders).toEqual([]);
    }
  });

  test("no dictionary value embeds a path, an id or a timestamp", () => {
    const suspicious = /(?:^|\s)(?:[\w-]+\/[\w-\/]+\.\w+|I-\d{6}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/;
    for (const [locale, tree] of [["en", enLeaves], ["zh", zhLeaves]] as const) {
      const offenders = Object.entries(tree)
        .filter(([, value]) => suspicious.test(value))
        .map(([key, value]) => `${locale}.${key} = ${value}`);
      expect(offenders).toEqual([]);
    }
  });
});

describe("the four absence states own four key families", () => {
  test("each arm has its own family and no generic 'no data' key exists", () => {
    const arms = ["not-applicable", "absent", "empty", "unavailable"] as const;
    for (const arm of arms) {
      expect(en.state[arm]).toBeDefined();
      expect(zh.state[arm]).toBeDefined();
    }
    // Four label words, four distinct words: the label is what keeps the arms
    // apart in greyscale and under forced colors.
    expect(new Set(arms.map((arm) => en.state[arm].labelWord)).size).toBe(4);
    expect(new Set(arms.map((arm) => zh.state[arm].labelWord)).size).toBe(4);
    const keys = Object.keys(en.state);
    const generic = keys.filter((key) => /^(no-?data|nothing|none|empty-state|placeholder)$/i.test(key));
    expect(generic).toEqual([]);
  });

  test("filtered-empty is a key inside the empty family, not a fifth state", () => {
    // Same state ("the read succeeded and there is nothing"), reached under
    // filters. It owns a distinct string so a translation cannot flatten the two.
    expect(en.state["empty-filtered"].body).not.toBe(en.state.empty.body);
    expect(zh.state["empty-filtered"].body).not.toBe(zh.state.empty.body);
    expect(absenceCopy(en, "empty-filtered").labelWord).toBe(en.state.empty.labelWord);
  });

  test("the four arms' copy is distinct within each locale", () => {
    for (const copy of [en, zh]) {
      const bodies = (["not-applicable", "absent", "empty", "unavailable"] as const).map((arm) => copy.state[arm].body);
      expect(new Set(bodies).size).toBe(4);
    }
  });
});

describe("no key exists for a fact IA §8 marks not-rendered", () => {
  // The blacklist is §8.1's removed-fact list. A key family in any of these
  // spellings is how a surface comes back: someone adds the string, then a screen
  // mounts it. This test fails first.
  const REMOVED_FAMILIES = [
    "occurrence",
    "transition",
    "history",
    "provenance",
    "relation",
    "lease",
    "adoption",
    "document",
    "revision",
    "counter",
    "trend",
    "flow",
    "chart",
    "identity-line",
    "knowledge",
    "rollup",
    "pin",
    "external",
    "provider-link",
  ];

  /**
   * The keys whose *name* contains a removed-surface word but whose *fact* §8.2
   * keeps. Listing them is the difference between a guard and a nuisance: the
   * blacklist targets rows, logs, inventories and counters, and these three are
   * a count, a count's label, and a catalog identity field.
   */
  const KEPT_DESPITE_THE_WORD = new Set([
    // §8.2 keeps "the occurrence count as one integer"; the occurrence ROWS are
    // the log that was removed.
    "issueDetail.fields.occurrences",
    "issueDetail.occurrenceCount",
    // §8.2 lists the catalog identity on the workflow detail; `documentKind` is
    // one of its fields, not a document inventory.
    "workflowDetail.fields.documentKind",
  ]);

  test("the kept-exception list contains only keys that exist", () => {
    // A stale exception would silently re-open the blacklist for that name.
    for (const key of KEPT_DESPITE_THE_WORD) expect(enLeaves[key]).toBeDefined();
  });

  test("no key name in either dictionary names a removed surface", () => {
    for (const [locale, tree] of [["en", enLeaves], ["zh", zhLeaves]] as const) {
      // Compared per key SEGMENT, not per substring: `includes("flow")` matches
      // `workflows`, which is a live screen, not a removed trend.
      const offenders = Object.keys(tree).filter((key) =>
        key
          .toLowerCase()
          .split(".")
          .some((segment) => REMOVED_FAMILIES.some((family) => segment === family || segment.startsWith(family))),
      ).filter((key) => !KEPT_DESPITE_THE_WORD.has(key));
      expect(offenders.map((key) => `${locale}.${key}`)).toEqual([]);
    }
  });

  test("the copy itself never promises a surface that does not exist", () => {
    // Two phrasings the read model forbids: a checklist step the store does not
    // carry (D26), and an issue-flow series (D30).
    for (const [locale, tree] of [["en", enLeaves], ["zh", zhLeaves]] as const) {
      const forbidden = locale === "en" ? [/first uncompleted/i, /next step/i, /trend/i, /chart/i] : [/未完成的第/, /趋势图/, /折线/];
      const offenders = Object.entries(tree)
        .filter(([, value]) => forbidden.some((pattern) => pattern.test(value)))
        .map(([key]) => `${locale}.${key}`);
      expect(offenders).toEqual([]);
    }
  });
});

describe("the copy the read model fixes", () => {
  test("the plan line is the RECORDED progress, and the blocked line its reason", () => {
    // D26: the store carries no checklist, so the copy must not promise a step.
    expect(en.focus.progressLabel.toLowerCase()).toContain("recorded");
    expect(en.focus.blockedLabel.toLowerCase()).toContain("recorded");
    expect(zh.focus.progressLabel).toContain("已记录");
    expect(zh.focus.blockedLabel).toContain("已记录");
  });

  test("all five gate steps are named; the read marks only the first four", () => {
    expect(Object.keys(en.iterationDetail.gateStepLabels)).toEqual([
      "start",
      "execute",
      "close",
      "pr-delivery",
      "merge-ready",
    ]);
    expect(Object.keys(zh.iterationDetail.gateStepLabels)).toHaveLength(5);
    for (const label of Object.values(zh.iterationDetail.gateStepLabels)) {
      expect(label.trim()).not.toBe("");
    }
  });
});

describe("the provider", () => {
  function Probe(): ReactNode {
    const copy = useCopy();
    return <span>{copy.overview.pageTitle}</span>;
  }

  test("a screen reads its copy from the provider", () => {
    expect(renderToStaticMarkup(<LocaleProvider locale="zh"><Probe /></LocaleProvider>)).toContain("总览");
    expect(renderToStaticMarkup(<LocaleProvider locale="en"><Probe /></LocaleProvider>)).toContain("Overview");
  });

  test("an unknown locale falls back to English rather than rendering nothing", () => {
    expect(renderToStaticMarkup(<LocaleProvider locale="fr"><Probe /></LocaleProvider>)).toContain("Overview");
  });

  test("using the hook outside a provider is a wiring error, not silent English", () => {
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(/LocaleProvider/);
  });
});
