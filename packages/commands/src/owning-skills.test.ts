import { describe, expect, test } from "bun:test";
import { getCommandDefinitions } from "./definitions.js";
import { owningSkillFor } from "./owning-skills.js";

// Families whose commands have no single owning skill: either multiple owners
// per the skill table, or surfaces with no documented owner. A new family must
// be named here or given a table entry — never an invented default.
const NO_SINGLE_OWNER_FAMILIES = [
  "dashboard",
  "doctor",
  "issue-sync",
  "linear",
  "lint",
  "migrate",
  "plugin",
  "session",
  "workflow-note",
] as const;

describe("owning-skill table", () => {
  test("every command family is mapped or explicitly allowlisted", () => {
    const families = [...new Set(getCommandDefinitions().map((definition) => definition.id.split(".")[0]!))].sort();
    const unmapped = families.filter((family) =>
      getCommandDefinitions()
        .filter((definition) => definition.id.split(".")[0] === family)
        .every((definition) => owningSkillFor(definition.id) === undefined),
    );
    expect(unmapped.sort()).toEqual([...NO_SINGLE_OWNER_FAMILIES].sort());
  });

  test("command override beats family default", () => {
    // plan family has no default; plan.show / plan.bind are overridden.
    expect(owningSkillFor("plan.show")).toBe("mstar-artifacts");
    expect(owningSkillFor("plan.bind")).toBe("mstar-iteration");
    // store family default is mstar-conventions; execution commands override.
    expect(owningSkillFor("store.init")).toBe("mstar-conventions");
    expect(owningSkillFor("store.execution.restore")).toBe("mstar-artifacts");
  });

  test("unknown id returns undefined without throwing", () => {
    expect(owningSkillFor("nope.verb")).toBeUndefined();
    expect(owningSkillFor("")).toBeUndefined();
  });

  test("every table value matches mstar-<slug>", () => {
    for (const definition of getCommandDefinitions()) {
      const skill = owningSkillFor(definition.id);
      if (skill !== undefined) expect(skill).toMatch(/^mstar-[a-z0-9-]+$/);
    }
  });
});
