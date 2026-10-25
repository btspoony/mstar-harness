/**
 * Two navigation controls that must agree with the route contract, and did not.
 *
 * Both are cheap to state as behaviour because the route module already owns the
 * rule: the breadcrumb and Escape are one move from two places, and Escape means
 * "one step out" only where there is a step out.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { escapeTarget, parentAddress, parseRoute } from "./route";

const mainSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "main.tsx"), "utf8");

describe("F4: the breadcrumb and Escape are the same move", () => {
  test("from a non-default feature both answer the project's Roadmap", () => {
    // `onBack` hardcoded the `projects` destination while Escape walked `parentOf`,
    // so the two controls disagreed: the breadcrumb left the project entirely.
    const address = parseRoute("#project/engine/issues");
    const escape = escapeTarget(address);
    const breadcrumb = parentAddress(address);
    expect(escape).not.toBeNull();
    expect(escape).toEqual(breadcrumb);
    expect(escape?.route).toEqual({ name: "project", id: "engine", feature: "roadmap" });
  });

  test("the project detail's back handler uses that same function", () => {
    // The behaviour test above passes even if the component keeps its own hardcoded
    // target; this is the half that fails when it does.
    expect(mainSource).not.toContain('navigate({ name: "projects" }, "", "push")');
    expect(mainSource).toContain("const parent = parentAddress(props.address)");
  });
});

describe("F5: Escape means one step out, only where there is a step out", () => {
  test("on a detail it navigates to the parent with the query preserved", () => {
    const target = escapeTarget(parseRoute("#issue/I-1?severity=high"));
    expect(target?.route).toEqual({ name: "issues" });
    expect(target?.query).toBe("severity=high");
  });

  test("in a list's search box it does nothing", () => {
    // The reader's intent there is to clear the input. Navigating discarded the
    // filters they were typing.
    expect(escapeTarget(parseRoute("#issues?q=tone"))).toBeNull();
    expect(escapeTarget(parseRoute("#workflows"))).toBeNull();
    expect(escapeTarget(parseRoute("#overview"))).toBeNull();
  });

  test("the shell's handler only navigates when a target exists", () => {
    expect(mainSource).toContain("const target = escapeTarget(address)");
  });
});
