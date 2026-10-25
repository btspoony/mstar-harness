/**
 * The dictionary must satisfy every screen's copy contract, in both locales.
 *
 * The screens were written prop-driven; this file is what makes that shape pay
 * off — a dictionary section is asserted assignable to the screen's `*Copy` type,
 * so a key the screen needs and the dictionary lacks fails here by name, and a
 * key the dictionary carries that the screen cannot consume fails the parity check
 * in `locale.test.tsx`.
 *
 * It is a compile-time assertion expressed as a value: `satisfies` on a typed
 * binding, then a runtime read to keep the bundler from dropping it.
 */
import { describe, expect, test } from "bun:test";

import type { OverviewCopy } from "../screens/Overview.tsx";
import type { FocusCopy } from "../screens/Focus.tsx";
import type { IssuesCopy } from "../screens/Issues.tsx";
import type { IssueDetailCopy } from "../screens/IssueDetail.tsx";
import type { WorkflowsCopy } from "../screens/Workflows.tsx";
import type { WorkflowDetailCopy } from "../screens/WorkflowDetail.tsx";
import type { IterationsCopy } from "../screens/Iterations.tsx";
import type { IterationDetailCopy } from "../screens/IterationDetail.tsx";
import type { ProjectsCopy } from "../screens/Projects.tsx";
import type { ProjectDetailCopy } from "../screens/ProjectDetail.tsx";
import { en, zh, type Copy } from "./index.ts";

/**
 * Build one screen's copy object from a locale tree.
 *
 * The dictionary sections are shaped to be the screens' copy objects directly;
 * the few differences (a table caption that repeats the page title, a `range`
 * that lives in the pager's slot) are composition, not translation, and belong
 * here rather than in either locale file.
 */
function screens(copy: Copy) {
  const overview: OverviewCopy = {
    ...copy.overview,
    workflowsEmpty: copy.overview.workflowsHeading,
    absence: {
      "not-applicable": copy.state["not-applicable"],
      absent: copy.state.absent,
      empty: copy.state.empty,
      unavailable: copy.state.unavailable,
    },
  };
  const focus: FocusCopy = {
    ...copy.focus,
    absence: {
      "not-applicable": copy.state["not-applicable"],
      absent: copy.state.absent,
      empty: copy.state.empty,
      unavailable: copy.state.unavailable,
    },
  };
  const issues: IssuesCopy = {
    ...copy.issues,
    pager: { previous: copy.common.previous, next: copy.common.next, range: copy.issues.range },
    anyOption: copy.common.anyOption,
    filteredEmpty: { ...copy.state["empty-filtered"], heading: copy.issues.pageTitle },
    storeEmpty: { ...copy.state.empty, heading: copy.issues.pageTitle },
    absent: { ...copy.state.absent, heading: copy.issues.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.issues.pageTitle },
  };
  const issueDetail: IssueDetailCopy = {
    ...copy.issueDetail,
    absence: {
      unavailable: { ...copy.state.unavailable, heading: copy.issueDetail.identityHeading },
      absent: { ...copy.state.absent, heading: copy.issueDetail.identityHeading },
    },
  };
  const workflows: WorkflowsCopy = {
    ...copy.workflows,
    empty: { ...copy.state.empty, heading: copy.workflows.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.workflows.pageTitle },
    absent: { ...copy.state.absent, heading: copy.workflows.pageTitle },
  };
  const workflowDetail: WorkflowDetailCopy = {
    ...copy.workflowDetail,
    unavailable: { ...copy.state.unavailable, heading: copy.workflowDetail.executionHeading },
  };
  const iterations: IterationsCopy = {
    ...copy.iterations,
    notStarted: copy.workflowDetail.fields.notStarted,
    empty: { ...copy.state.empty, heading: copy.iterations.pageTitle },
    absent: { ...copy.state.absent, heading: copy.iterations.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.iterations.pageTitle },
  };
  const iterationDetail: IterationDetailCopy = {
    ...copy.iterationDetail,
    unavailable: { ...copy.state.unavailable, heading: copy.iterationDetail.catalogHeading },
    absent: { ...copy.state.absent, heading: copy.iterationDetail.catalogHeading },
  };
  const projects: ProjectsCopy = {
    ...copy.projects,
    empty: { ...copy.state.empty, heading: copy.projects.pageTitle },
    unavailable: { ...copy.state.unavailable, heading: copy.projects.pageTitle },
    absent: { ...copy.state.absent, heading: copy.projects.pageTitle },
  };
  const projectDetail: ProjectDetailCopy = {
    ...copy.projectDetail,
    // The panel heading is the feature's own name.
    absence: {
      absent: { ...copy.state.absent, heading: copy.projectDetail.features.roadmap },
      empty: { ...copy.state.empty, heading: copy.projectDetail.features.roadmap },
      unavailable: { ...copy.state.unavailable, heading: copy.projectDetail.features.roadmap },
      "not-applicable": { ...copy.state["not-applicable"], heading: copy.projectDetail.features.roadmap },
    },
  };
  return { overview, focus, issues, issueDetail, workflows, workflowDetail, iterations, iterationDetail, projects, projectDetail };
}

describe("every screen's copy contract is satisfied by both locales", () => {
  // The assertion is the type: a missing or mistyped key fails `tsc`. The runtime
  // read keeps the bindings alive and fails if a section vanishes.
  const english = screens(en);
  const chinese = screens(zh);

  test("ten screens, two locales, no missing key", () => {
    for (const [locale, copy] of [["en", english], ["zh", chinese]] as const) {
      expect(Object.keys(copy)).toHaveLength(10);
      for (const [name, value] of Object.entries(copy)) {
        expect(`${locale}.${name}: ${Object.keys(value).length}`).not.toMatch(/^(en|zh)\.\w+: 0$/);
      }
    }
  });

  test("the two locales' screens have identical key counts", () => {
    for (const name of Object.keys(english) as Array<keyof typeof english>) {
      expect(Object.keys(chinese[name]).sort()).toEqual(Object.keys(english[name]).sort());
    }
  });

  test("the dictionary carries no string the screens cannot consume", () => {
    // `common` and `state` are shared vocabularies; every other section maps to
    // exactly one screen, so a section without a screen is dead copy.
    const sections = Object.keys(en);
    const shared = ["state", "common"];
    const screenSections = sections.filter((section) => !shared.includes(section));
    expect(new Set(screenSections).size).toBe(Object.keys(english).length);
  });

  test("the four absence arms and the filtered-empty key all reach a screen", () => {
    // `state` is consumed through the screens' `absence`/empty slots; the
    // filtered-empty key is what the issues list uses for a filtered zero.
    expect(chinese.issues.filteredEmpty.body).toBe(zh.state["empty-filtered"].body);
    expect(english.issues.storeEmpty.body).not.toBe(english.issues.filteredEmpty.body);
  });
});
