import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandDefinitions } from "../src/index.js";
import type { CommandEffects, CommandEnvelope, InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "validation-family-"));
  roots.push(root);
  return root;
}
function definition(id: string) {
  const found = getCommandDefinitions().find((item) => item.id === id);
  if (!found) throw new Error(`Missing command definition: ${id}`);
  return found;
}
function context(cwd: string, spawn?: CommandEffects["spawn"]): InvocationContext {
  return {
    cwd, controlRoot: null, versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn(request) { return spawn ? spawn(request) : { exitCode: 127, signal: null, stdout: "", stderr: "command unavailable" }; },
      async startDashboard() { throw new Error("unused"); },
      async openBrowser() { throw new Error("unused"); },
    },
  };
}
function violationsOf(result: CommandEnvelope): { code: string; message: string }[] {
  if (!("details" in result) || !Array.isArray(result.details?.violations)) throw new Error(`Expected semantic violations: type=${typeof result.details?.violations} ctor=${result.details?.violations?.constructor?.name} keys=${JSON.stringify(Object.keys(result.details?.violations ?? {}))}`);
  return result.details.violations as { code: string; message: string }[];
}

describe("validation command family", () => {
  test("registers the ten inventory identities with their effect classes", () => {
    const commands = getCommandDefinitions().filter(({ id }) => [
      "dispatch.validate", "worktree.check", "worktree.qc-alignment", "review.seats", "lint",
      "design-md.validate", "compound.validate", "skill.lint", "roles.validate", "qc.validate-report",
    ].includes(id));
    expect(commands.map(({ id }) => id)).toEqual([
      "dispatch.validate", "worktree.check", "worktree.qc-alignment", "review.seats", "lint",
      "design-md.validate", "compound.validate", "skill.lint", "roles.validate", "qc.validate-report",
    ]);
    expect(commands.map(({ effects }) => effects)).toEqual([
      ["read", "validate"], ["read", "validate", "process"], ["read", "validate"], ["read", "validate"],
      ["read", "validate"], ["read", "validate"], ["read", "validate"], ["read", "validate"],
      ["read", "validate"], ["read", "validate"],
    ]);
  });

  test("invalid Assignment returns its field violations with their engine codes", async () => {
    const cwd = tempRoot();
    const file = path.join(cwd, "assignment.md");
    writeFileSync(file, "# Assignment\n\nNo required fields here.\n");
    const result = await definition("dispatch.validate").execute({ assignmentFile: file }, context(cwd));
    const violations = violationsOf(result);
    expect(violations.length > 0).toBe(true);
    expect(violations[0]!.code).toMatch(/^assignment\./);
    expect(result.code).toBe(violations[0]!.code);
  });

  test("worktree L1 reports a main-checkout branch mismatch", async () => {
    const cwd = tempRoot();
    const harness = path.join(cwd, ".mstar");
    const workflowDir = path.join(harness, "workflows", "wf-checkout");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(path.join(workflowDir, "snapshot.json"), JSON.stringify({
      schema_version: 1, id: "wf-checkout", type: "iteration", status: "running",
      started_at: "2026-09-26", updated_at: "2026-09-26",
      branch: { base: "expected-main", integration: "integration" },
      integration_worktree_path: path.join(cwd, "integration"),
      plans: [{ id: "plan-a", title: "Plan A", file: path.join(cwd, "plan.md"), status: "InProgress", execution_lease: { holder: "dev", claimed_at: "2026-09-26", worktree_path: path.join(cwd, "feature"), working_branch: "feature/plan-a" } }],
    }));
    const result = await definition("worktree.check").execute(
      { planId: "plan-a", workflow: "wf-checkout", harness },
      context(cwd, async ({ argv }) => argv[1] === "worktree"
        ? { exitCode: 0, signal: null, stdout: `worktree ${cwd}\nbranch feature\n`, stderr: "" }
        : { exitCode: 0, signal: null, stdout: "feature", stderr: "" }),
    );
    expect(result).toMatchObject({ status: "refused", exitCode: 1, code: "worktree.main.residency-switched" });
    const violations = violationsOf(result);
    expect(violations.some((item) => item.code.includes("main") || item.message.toLowerCase().includes("main"))).toBe(true);
  });

  test("QC alignment refuses unequal Assignment metadata", async () => {
    const cwd = tempRoot();
    const first = path.join(cwd, "qc.md");
    const second = path.join(cwd, "qa.md");
    writeFileSync(first, "plan_id: plan-a\nReview range: base..head\nDiff basis: base\n");
    writeFileSync(second, "plan_id: plan-a\nReview range: other..head\nDiff basis: base\n");
    const result = await definition("worktree.qc-alignment").execute({ files: [first, second] }, context(cwd));
    expect(result).toMatchObject({ status: "refused", code: "qc.alignment.mismatch", details: { violations: expect.any(Array) } });
  });

  test("invalid QC report preserves the report validator verdict", async () => {
    const cwd = tempRoot();
    const file = path.join(cwd, "qc-report.md");
    writeFileSync(file, "# Not a valid QC report\n");
    const result = await definition("qc.validate-report").execute({ reportFile: file }, context(cwd));
    const violations = violationsOf(result);
    expect(violations.length > 0).toBe(true);
    expect(result.code).toBe(violations[0]!.code);
  });

  test("artifact validators run against small local fixtures", async () => {
    const cwd = tempRoot();
    const lintFile = path.join(cwd, "SKILL.md");
    writeFileSync(lintFile, "---\nname: Bad Name\n---\nBody\n");
    expect((await definition("lint").execute({ target: lintFile }, context(cwd))).status).toBe("refused");

    const skillDir = path.join(cwd, "fixture-skill");
    mkdirSync(skillDir);
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: Bad Name\n---\nBody\n");
    expect((await definition("skill.lint").execute({ skillDir }, context(cwd))).status).toBe("refused");

    const designDir = path.join(cwd, "design");
    mkdirSync(designDir);
    writeFileSync(path.join(designDir, "DESIGN.md"), "# Design\n\nNo tokens.\n");
    expect((await definition("design-md.validate").execute({ dir: designDir }, context(cwd))).status).toBe("refused");

    const compound = path.join(cwd, "knowledge.md");
    writeFileSync(compound, "No frontmatter.\n");
    expect((await definition("compound.validate").execute({ docPath: compound }, context(cwd))).status).toBe("refused");

    const rolesDir = path.join(cwd, "roles");
    mkdirSync(rolesDir);
    expect((await definition("roles.validate").execute({ rolesDir, skillsDir: cwd }, context(cwd))).status).toBe("refused");
  });
});
