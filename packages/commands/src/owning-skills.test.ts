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
  "migrate",
  "plugin",
  "workflow-note",
] as const;

// Command-level completeness: every unmapped id is named here with a reason.
// A new command id must either resolve through owningSkillFor or be added to
// this list — silence is always a decision, never an oversight.
const NO_OWNER_COMMANDS: Readonly<Record<string, string>> = {
  // no documented owner
  dashboard: "read-only loopback surface; its help owns the flags",
  doctor: "host environment probe; no topical skill owns its output",
  "issue-sync.import": "external issue sync; no documented owner",
  "linear.auth": "third-party connector; no documented owner",
  migrate: "standalone file-staging migrate is retired; use store upgrade",
  "plugin.validate": "packaging validation; no documented owner",
  "workflow-note.append": "note ledger write; owner spread across lifecycle skills",
  "workflow-note.coverage": "note ledger read; owner spread across lifecycle skills",
  // retired verb: never publishes a pointer
  "status.archive-residuals": "retired verb",
  "status.backlog-register": "retired verb",
  "status.backlog-close": "retired verb",
};

describe("owning-skill table", () => {
  test("every command id is mapped or explicitly named as ownerless", () => {
    const ids = getCommandDefinitions().map((definition) => definition.id);
    const unmapped = ids.filter((id) => owningSkillFor(id) === undefined).sort();
    expect(
      unmapped.filter((id) => !(id in NO_OWNER_COMMANDS)),
      "commands resolving to no owning skill and missing from NO_OWNER_COMMANDS",
    ).toEqual([]);
    // The list itself stays minimal: no entry that actually resolves.
    const stale = Object.keys(NO_OWNER_COMMANDS).filter((id) => owningSkillFor(id) !== undefined);
    expect(stale, "NO_OWNER_COMMANDS entries that now resolve").toEqual([]);
  });

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
    // plan family has no default; each verb is overridden from its former owner row.
    expect(owningSkillFor("plan.show")).toBe("mstar-artifacts");
    expect(owningSkillFor("plan.bind")).toBe("mstar-iteration");
    expect(owningSkillFor("plan.complete")).toBe("mstar-artifacts");
    expect(owningSkillFor("plan.progress")).toBe("mstar-sdd");
    expect(owningSkillFor("status.tech-debt")).toBe("mstar-project-governance");
    // store family default is mstar-conventions; execution commands override.
    expect(owningSkillFor("store.init")).toBe("mstar-conventions");
    expect(owningSkillFor("store.execution.restore")).toBe("mstar-artifacts");
    // A family default still covers a verb without its own override.
    expect(owningSkillFor("lint")).toBe("mstar-skill-authoring");
  });

  test("retired verbs publish no owning skill", () => {
    for (const id of ["status.archive-residuals", "status.backlog-register", "status.backlog-close"]) {
      expect(owningSkillFor(id)).toBeUndefined();
    }
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
