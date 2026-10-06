import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindExecutionSession, createExecutionWorkflow, executionContextFor, initializeExecutionAuthority, initializeStore, mutateExecutionPlan, registerCatalogEntity } from "@mstar-harness/engine";
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

  test("worktree conflict preserves the main-checkout branch mismatch", async () => {
    const cwd = tempRoot();
    const harness = path.join(cwd, ".mstar");
    const workflowDir = path.join(harness, "workflows", "wf-checkout");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(path.join(workflowDir, "snapshot.json"), JSON.stringify({
      schema_version: 1, id: "wf-checkout", type: "iteration", status: "running",
      started_at: "2026-09-26", updated_at: "2026-09-26",
      branch: { base: "expected-main", integration: "integration" },
      integration_worktree_path: path.join(cwd, "integration"),
      plans: [{ id: "plan-a", title: "Plan A", file: path.join(cwd, "plan.md"), status: "InProgress", metadata: { worktree_path: path.join(cwd, "feature"), working_branch: "feature/plan-a" } }],
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

  test("ACTIVE worktree check reads registered workflows from the execution graph", async () => {
    const cwd = tempRoot();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "initial"], { cwd });
    const harness = path.join(cwd, ".mstar");
    mkdirSync(harness, { recursive: true });
    const integrationWorktree = path.join(cwd, "integration-worktree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "integration/synthetic", integrationWorktree], { cwd });
    mkdirSync(harness, { recursive: true });
    const storeContext = { harnessDir: harness };
    (await initializeStore(storeContext)).close();
    const initialized = await initializeExecutionAuthority(storeContext);
    await registerCatalogEntity(storeContext, { kind: "plan", id: "plan-synthetic", title: "Synthetic plan", rootKind: "plans", relativePath: "plans/plan-synthetic.md" }, { operationId: "catalog-synthetic", actor: "test" });
    const identity = { source: "local" as const, sessionId: "coordinator-synthetic", role: "coordinator" as const, workflowId: "workflow-synthetic" };
    const execution = executionContextFor(storeContext, identity);
    const created = await createExecutionWorkflow(execution, {
      entry: { id: "workflow-synthetic", type: "plan", status: "running", started_at: "2026-09-26T00:00:00Z", dir: "workflows/workflow-synthetic" },
      snapshot: {
        schema_version: 1, id: "workflow-synthetic", type: "plan", status: "running",
        started_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z",
        branch: { base: "main", source: "feature/synthetic", integration: "integration/synthetic", target: "main" },
        integration_worktree_path: integrationWorktree,
        plans: [{ id: "plan-synthetic", title: "Synthetic plan", file: "plans/plan-synthetic.md", status: "InProgress" }],
        delivery_kind: "development",
      },
      expected: initialized.token,
      operationId: "workflow-synthetic",
    });
    const bound = await bindExecutionSession(execution, {
      workflowId: identity.workflowId, expected: created.data.workflows[0]!.workflowToken,
      operationId: "bind-synthetic",
    });
    const removedWorktree = path.join(cwd, "removed-feature-worktree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature/synthetic", removedWorktree], { cwd });
    mkdirSync(path.join(harness, "plans"), { recursive: true });
    writeFileSync(path.join(harness, "plans", "plan-synthetic.md"), "# Synthetic plan\n");
    await mutateExecutionPlan(execution, {
      session: bound.data, planId: "plan-synthetic", operationId: "prepare-initial-source",
      operation: { kind: "prepare", config: { worktreePath: removedWorktree, workingBranch: "feature/synthetic" } },
    });
    // The recorded checkout was real when prepared; its later removal must
    // refuse dispatch, not turn the missing physical source into a default.
    execFileSync("git", ["worktree", "remove", removedWorktree], { cwd });
    const result = await definition("worktree.check").execute(
      { planId: "plan-synthetic", workflow: "workflow-synthetic", harness, mainBranch: "main" },
      context(cwd, async ({ argv }) => argv[1] === "worktree"
        ? { exitCode: 0, signal: null, stdout: `worktree ${cwd}\nbranch main\n`, stderr: "" }
        : { exitCode: 0, signal: null, stdout: "main", stderr: "" }),
    );
    expect(result.status).toBe("refused");
    expect(violationsOf(result)).toContainEqual(expect.objectContaining({ code: "worktree.l1.feature-missing" }));
    const featureWorktree = path.join(cwd, "feature-worktree");
    execFileSync("git", ["worktree", "add", "-q", featureWorktree, "feature/synthetic"], { cwd });
    await mutateExecutionPlan(execution, {
      session: bound.data, planId: "plan-synthetic", operationId: "prepare-synthetic",
      operation: { kind: "prepare", config: { worktreePath: featureWorktree, workingBranch: "feature/synthetic" } },
    });
    const matching = await definition("worktree.check").execute(
      { planId: "plan-synthetic", workflow: "workflow-synthetic", harness, mainBranch: "main" },
      context(cwd, async ({ argv }) => argv[1] === "worktree"
        ? { exitCode: 0, signal: null, stdout: `worktree ${cwd}\nbranch main\n`, stderr: "" }
        : { exitCode: 0, signal: null, stdout: "main", stderr: "" }),
    );
    expect(matching.status).toBe("ok");
    const missing = await definition("worktree.check").execute(
      { planId: "plan-synthetic", workflow: "workflow-unregistered", harness },
      context(cwd),
    );
    expect(missing).toMatchObject({ status: "refused", code: "worktree.l1.workflow-not-found" });
    expect(missing.message).toContain("active execution authority graph");
  });

  test("derived scope uses the branch declared in the Assignment and preserves explicit conflicts", async () => {
    const cwd = tempRoot();
    const file = path.join(cwd, "assignment.md");
    writeFileSync(file, [
      "## Assignment",
      "**Execute as**: fullstack-dev",
      "**Delegation**: forbidden",
      "**Task category**: logic",
      "**Task budget (implement / ops rounds)**: one round",
      "**Working branch**: main",
    ].join("\n"));
    const derived = await definition("dispatch.validate").execute({ assignmentFile: file }, context(cwd));
    expect(derived).toMatchObject({ status: "refused", code: "dispatch.default-branch.protected" });
    const conflict = await definition("dispatch.validate").execute({ assignmentFile: file, branch: "feature/other" }, context(cwd));
    expect(conflict).toMatchObject({ status: "refused", code: "dispatch.branch.conflict" });
  });

  test("role conflict preserves the invalid SDD reviewer identity", async () => {
    const cwd = tempRoot();
    const assignment = path.join(cwd, "assignment.md");
    writeFileSync(assignment, "**Execution mode**: sdd\n");
    const result = await definition("review.seats").execute(
      { assignmentFile: assignment, mode: "sdd", reviewers: ["qc-specialist", "fullstack-dev", "qc-specialist-3"] },
      context(cwd),
    );
    expect(result).toMatchObject({ status: "refused", code: "dispatch.tri-identity.invalid" });
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
  test("document validation derives a document type for the selected artifact", async () => {
    const cwd = tempRoot();
    const file = path.join(cwd, "SKILL.md");
    writeFileSync(file, "---\nname: valid-skill\ndescription: A fixture skill for validating documents.\n---\nA valid skill.\n");
    const result = await definition("lint").execute({ target: file }, context(cwd));
    expect(result.status).toBe("ok");
  });

  test("unknown optional validator type is classified as usage", async () => {
    const cwd = tempRoot();
    const file = path.join(cwd, "SKILL.md");
    writeFileSync(file, "---\nname: valid-skill\n---\nA valid skill.\n");
    const result = await definition("lint").execute({ target: file, type: "unknown" }, context(cwd));
    expect(result).toMatchObject({ status: "usage", exitCode: 2, code: "usage" });
  });

  test("aggregate diagnostics retain each selected document path", async () => {
    const cwd = tempRoot();
    const first = path.join(cwd, "one", "SKILL.md");
    const second = path.join(cwd, "two", "SKILL.md");
    mkdirSync(path.dirname(first), { recursive: true });
    mkdirSync(path.dirname(second), { recursive: true });
    writeFileSync(first, "---\nname: Bad Name\n---\nBody\n");
    writeFileSync(second, "---\nname: Also Bad\n---\nBody\n");
    const result = await definition("lint").execute({ target: cwd }, context(cwd));
    expect(result).toMatchObject({ status: "refused", details: { results: expect.arrayContaining([
      expect.objectContaining({ file: first, violations: expect.any(Array) }),
      expect.objectContaining({ file: second, violations: expect.any(Array) }),
    ]) } });
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
  test("roles validation scans root-relative directories from a nested invocation and preserves absolute paths", async () => {
    const projectRoot = path.join(tempRoot(), "project");
    const invocationCwd = path.join(projectRoot, "packages", "nested");
    const skillsRoot = path.join(projectRoot, "skills");
    const rolesDir = path.join(skillsRoot, "mstar-roles");
    mkdirSync(invocationCwd, { recursive: true });
    mkdirSync(rolesDir, { recursive: true });
    mkdirSync(path.join(skillsRoot, "mstar-fixture"), { recursive: true });
    mkdirSync(path.join(invocationCwd, "skills", "mstar-wrong"), { recursive: true });
    writeFileSync(path.join(skillsRoot, "mstar-fixture", "SKILL.md"), "---\nname: mstar-fixture\n---\nFixture.\n");
    writeFileSync(path.join(invocationCwd, "skills", "mstar-wrong", "SKILL.md"), "---\nname: mstar-wrong\n---\nWrong tree.\n");

    const result = await definition("roles.validate").execute({
      rolesDir: path.resolve(projectRoot, "skills/mstar-roles"),
      skillsDir: path.resolve(projectRoot, "skills"),
    }, context(invocationCwd));

    const violations = violationsOf(result);
    expect(violations.some(({ code, message }) =>
      code === "roles.mapping.reference.missing" && message.includes(`under ${rolesDir}`),
    )).toBe(true);
    expect(violations.some(({ code, message }) =>
      code === "roles.loadorder.section.missing" && message.includes('"mstar-fixture"'),
    )).toBe(true);
    expect(violations.some(({ message }) => message.includes("mstar-wrong"))).toBe(false);
  });
});
