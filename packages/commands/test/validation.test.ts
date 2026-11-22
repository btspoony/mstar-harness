import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindExecutionSession, createExecutionWorkflow, executionContextFor, initializeStore, mutateExecutionPlan, readExecutionAuthority, registerCatalogEntity } from "@mstar-harness/engine";
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
/** see skills/mstar-coding-behavior/references/comments.md § Ratchet — the
 * lint gate reads git through the effect seam, so a diff-base case runs the
 * real command. */
const realSpawn: CommandEffects["spawn"] = async ({ argv, cwd }) => {
  try {
    const stdout = execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { exitCode: 0, signal: null, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return { exitCode: failure.status ?? 1, signal: null, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

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
      ["read", "validate", "process"], ["read", "validate"], ["read", "validate"], ["read", "validate"],
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

  test("worktree check refuses legacy snapshot data without an ACTIVE authority", async () => {
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
    expect(result).toMatchObject({ status: "refused", exitCode: 1, code: "store.not-initialized" });
    expect(result.message).toContain("pre-activation file route is retired");
  });

  test("ACTIVE worktree entry check admits standalone plans with registered source/target anchors", async () => {
    const cwd = tempRoot();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "initial"], { cwd });
    const harness = path.join(cwd, ".mstar");
    mkdirSync(harness, { recursive: true });
    const storeContext = { harnessDir: harness };
    (await initializeStore(storeContext)).close();
    const initialized = await readExecutionAuthority(storeContext);
    await registerCatalogEntity(storeContext, { kind: "plan", id: "plan-synthetic-secondary", title: "Synthetic secondary plan", rootKind: "plans", relativePath: "plans/plan-synthetic-secondary.md" }, { operationId: "catalog-synthetic-secondary", actor: "test" });
    const identity = { source: "local" as const, sessionId: "coordinator-synthetic", role: "coordinator" as const, workflowId: "workflow-synthetic" };
    const execution = executionContextFor(storeContext, identity);
    const created = await createExecutionWorkflow(execution, {
      entry: { id: "workflow-synthetic", type: "plan", status: "running", started_at: "2026-09-26T00:00:00Z", dir: "workflows/workflow-synthetic" },
      snapshot: {
        schema_version: 1, id: "workflow-synthetic", type: "plan", status: "running",
        started_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z",
        branch: { source: "feature/synthetic", target: "main" },
        plans: [
          { id: "plan-synthetic", title: "Synthetic plan", file: "plans/plan-synthetic.md", status: "InProgress" },
          { id: "plan-synthetic-secondary", title: "Synthetic secondary plan", file: "plans/plan-synthetic-secondary.md", status: "Todo" },
        ],
        delivery_kind: "development",
      },
      expected: initialized.token,
      operationId: "workflow-synthetic",
    });
    const entryCheck = await definition("worktree.check").execute(
      { workflow: "workflow-synthetic", harness, entry: true },
      context(cwd, async ({ argv }) => argv[1] === "worktree"
        ? { exitCode: 0, signal: null, stdout: `worktree ${cwd}\nbranch main\n`, stderr: "" }
        : { exitCode: 0, signal: null, stdout: "main", stderr: "" }),
    );
    expect(entryCheck.status).toBe("ok");
    const bound = await bindExecutionSession(execution, {
      workflowId: identity.workflowId, expected: created.data.workflows[0]!.workflowToken,
      operationId: "bind-synthetic",
    });
    const removedWorktree = path.join(cwd, "removed-feature-worktree");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feature/synthetic", removedWorktree], { cwd });
    mkdirSync(path.join(harness, "plans"), { recursive: true });
    writeFileSync(path.join(harness, "plans", "plan-synthetic.md"), "# Synthetic plan\n");
    writeFileSync(path.join(harness, "plans", "plan-synthetic-secondary.md"), "# Synthetic secondary plan\n");
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
    const selectedByOption = await definition("worktree.check").execute(
      { plan: "plan-synthetic", workflow: "workflow-synthetic", harness, mainBranch: "main" },
      context(cwd, async ({ argv }) => argv[1] === "worktree"
        ? { exitCode: 0, signal: null, stdout: `worktree ${cwd}\nbranch main\n`, stderr: "" }
        : { exitCode: 0, signal: null, stdout: "main", stderr: "" }),
    );
    expect(selectedByOption.status).toBe("ok");
    const unknownPlan = await definition("worktree.check").execute(
      { plan: "plan-missing", workflow: "workflow-synthetic", harness, mainBranch: "main" },
      context(cwd),
    );
    expect(unknownPlan).toMatchObject({ status: "refused", code: "worktree.l1.plan-not-found" });
    expect(unknownPlan.message).toContain("plan-missing");
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

  test("--control-clean refuses a control root with committable changes and passes a clean one", async () => {
    const dirty = tempRoot();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dirty });
    // why: the harness is process state, so ignoring it keeps only real work in the verdict.
    writeFileSync(path.join(dirty, ".gitignore"), ".mstar/\n");
    writeFileSync(path.join(dirty, "README.md"), "fixture\n");
    execFileSync("git", ["add", "-A"], { cwd: dirty });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "initial"], { cwd: dirty });
    mkdirSync(path.join(dirty, ".mstar"), { recursive: true });
    const harness = path.join(dirty, ".mstar");
    const cleanRoot = await definition("worktree.check").execute({ controlClean: true, harness }, context(dirty));
    expect(cleanRoot).toMatchObject({ status: "ok" });
    writeFileSync(path.join(dirty, "README.md"), "fixture edited\n");
    const refused = await definition("worktree.check").execute({ controlClean: true, harness }, context(dirty));
    expect(refused).toMatchObject({ status: "refused", exitCode: 1, code: "worktree.main.tracked-changes" });
    expect(refused.message).toContain("README.md");
    const refusedDetails = (refused as { details?: { recovery?: string } }).details ?? {};
    expect(refusedDetails.recovery).toContain("checkout that carries the target branch");
    // invariant: a repository with no harness has no control-root contract, so the check skips.
    const plain = tempRoot();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: plain });
    writeFileSync(path.join(plain, "README.md"), "fixture\n");
    const skipped = await definition("worktree.check").execute({ controlClean: true }, context(plain));
    expect(skipped).toMatchObject({ status: "ok" });
  });

  test("--control-clean refuses an invocation shared with the L1/L2 selectors", async () => {
    const cwd = tempRoot();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
    writeFileSync(path.join(cwd, ".gitignore"), ".mstar/\n");
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "initial"], { cwd });
    mkdirSync(path.join(cwd, ".mstar"), { recursive: true });
    // why: a clean control root must not turn the combination into a silent success.
    const withL2 = await definition("worktree.check").execute({ controlClean: true, l2: true }, context(cwd));
    expect(withL2).toMatchObject({ status: "usage", exitCode: 2 });
    expect(withL2.message).toContain("--l2");
    expect(withL2.message).toContain("separate");
    const withTracks = await definition("worktree.check").execute({ controlClean: true, tracks: [{ worktreePath: cwd, workingBranch: "main" }] }, context(cwd));
    expect(withTracks).toMatchObject({ status: "usage", exitCode: 2 });
    expect(withTracks.message).toContain("--tracks");
    const withEntry = await definition("worktree.check").execute({ controlClean: true, entry: true }, context(cwd));
    expect(withEntry).toMatchObject({ status: "usage", exitCode: 2 });
    expect(withEntry.message).toContain("--entry");
    const withIntegration = await definition("worktree.check").execute({ controlClean: true, integration: cwd }, context(cwd));
    expect(withIntegration).toMatchObject({ status: "usage", exitCode: 2 });
    expect(withIntegration.message).toContain("--integration");
  });
  test("--control-clean reads the fixed .mstar root and a named --harness anchor", async () => {
    // invariant: the fixed `.mstar` root declares a harness, so the check runs
    // instead of skipping; the retired `.agents/` candidate never does.
    const cwd = tempRoot();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
    writeFileSync(path.join(cwd, ".gitignore"), "state/\n.mstar/\n");
    mkdirSync(path.join(cwd, ".mstar"), { recursive: true });
    mkdirSync(path.join(cwd, ".agents", "specs"), { recursive: true });
    writeFileSync(path.join(cwd, ".agents", "specs", "spec.md"), "spec\n");
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "initial"], { cwd });
    writeFileSync(path.join(cwd, ".agents", "specs", "spec.md"), "spec edited\n");
    const fixed = await definition("worktree.check").execute({ controlClean: true }, context(cwd));
    expect(fixed).toMatchObject({ status: "refused", exitCode: 1, code: "worktree.main.tracked-changes" });

    // invariant: a relative anchor resolves from the invocation workspace, and
    // the fixed root it names is the harness the chain resolves, so a dirty
    // checkout is refused rather than skipped.
    expect(await definition("worktree.check").execute({ controlClean: true, harness: ".mstar" }, context(cwd))).toMatchObject({ status: "refused", code: "worktree.main.tracked-changes" });

    // invariant: an existing directory the chain does not resolve as a harness
    // is not one, so the check skips even on a dirty checkout - the path
    // existing is not a control-root contract.
    const plain = tempRoot();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: plain });
    writeFileSync(path.join(plain, ".gitignore"), "state/\n");
    writeFileSync(path.join(plain, "README.md"), "fixture\n");
    execFileSync("git", ["add", "-A"], { cwd: plain });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "initial"], { cwd: plain });
    mkdirSync(path.join(plain, "state", ".mstar"), { recursive: true });
    writeFileSync(path.join(plain, "README.md"), "fixture edited\n");
    expect(await definition("worktree.check").execute({ controlClean: true, harness: "state/.mstar" }, context(plain))).toMatchObject({ status: "ok" });
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

  test("a forced type narrows a directory walk to that type's extensions", async () => {
    const cwd = tempRoot();
    const dir = path.join(cwd, "pkg");
    mkdirSync(dir, { recursive: true });
    // why: an unbounded marker is a violation only under the code rules, so
    // this file fails when the walk hands it to `--type code` and passes when
    // the walk keeps it out.
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: valid-skill\ndescription: A fixture skill for validating documents.\n---\n// shortcut: one queue\n");
    writeFileSync(path.join(dir, "scan.ts"), "// why: the fixture carries no code\n");
    expect((await definition("lint").execute({ target: dir, type: "code" }, context(cwd))).status).toBe("ok");
    expect((await definition("lint").execute({ target: dir, type: "provenance" }, context(cwd))).status).toBe("ok");
  });

  test("a changed line with a forged path pointer is refused", async () => {
    const cwd = tempRoot();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
    const file = path.join(cwd, "scan.ts");
    writeFileSync(file, "const a = 1;\n");
    execFileSync("git", ["add", "scan.ts"], { cwd });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "base"], { cwd });
    writeFileSync(file, "const a = 1;\n// see docs/absent-pointer.md\n");
    const advisory = await definition("lint").execute({ target: file }, context(cwd));
    expect(advisory).toMatchObject({ status: "ok", exitCode: 0 });
    const result = await definition("lint").execute({ target: file, diffBase: "HEAD" }, context(cwd, realSpawn));
    expect(result).toMatchObject({
      status: "refused",
      code: "lint.comment.pointer-unresolved",
      details: { results: [{ violations: [expect.objectContaining({ code: "lint.comment.pointer-unresolved", message: expect.stringContaining("does not resolve") })] }] },
    });
    mkdirSync(path.join(cwd, "docs", "adr", "implemented", "testing"), { recursive: true });
    writeFileSync(path.join(cwd, "docs", "adr", "implemented", "testing", "2026-01-01-release.md"), "Status: implemented\n\nVersion 9 fixed a bug.\n");
    writeFileSync(file, "const a = 1;\n// ADR-9 owns the write order\n");
    const adr = await definition("lint").execute({ target: file, diffBase: "HEAD" }, context(cwd, realSpawn));
    expect(adr.code).toBe("lint.comment.pointer-unresolved");
  });

  test("a pointer that resolves at HEAD passes, path or ADR", async () => {
    const cwd = tempRoot();
    mkdirSync(path.join(cwd, "skills", "mstar-coding-behavior", "references"), { recursive: true });
    writeFileSync(path.join(cwd, "skills", "mstar-coding-behavior", "references", "comments.md"), "# Comments\n");
    mkdirSync(path.join(cwd, "docs", "adr", "implemented", "testing"), { recursive: true });
    writeFileSync(path.join(cwd, "docs", "adr", "implemented", "testing", "0007-lock.md"), "Status: implemented\n");
    writeFileSync(path.join(cwd, "docs", "adr", "implemented", "testing", "2026-01-01-release.md"), "Status: implemented\n\nADR-0008 records the release order.\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
    const file = path.join(cwd, "scan.ts");
    writeFileSync(file, "const a = 1;\n");
    execFileSync("git", ["add", "scan.ts"], { cwd });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "base"], { cwd });
    writeFileSync(file, [
      "const a = 1;",
      "// see skills/mstar-coding-behavior/references/comments.md",
      "// ADR-0007 owns the write order",
      "// ADR-8 records the release order",
      "// see https://example.com/wire-format",
      "",
    ].join("\n"));
    const result = await definition("lint").execute({ target: file, diffBase: "HEAD" }, context(cwd, realSpawn));
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
  test("roles validation lints the engine-absent archive's reference files and tolerates a missing refs dir", async () => {
    const skillsRoot = path.join(tempRoot(), "skills");
    const rolesDir = path.join(skillsRoot, "mstar-roles");
    mkdirSync(rolesDir, { recursive: true });
    mkdirSync(path.join(skillsRoot, "mstar-fixture"), { recursive: true });
    writeFileSync(
      path.join(skillsRoot, "mstar-fixture", "SKILL.md"),
      "---\nname: mstar-fixture\n---\n\n## Load Order\n\nRead `mstar-harness-core` first.\n",
    );
    const archive = path.join(skillsRoot, "mstar-engine-legacy");
    mkdirSync(path.join(archive, "references"), { recursive: true });
    writeFileSync(
      path.join(archive, "SKILL.md"),
      "---\nname: mstar-engine-legacy\n---\n\n## Load Order\n\nFollow the host-selected lifecycle authority first.\n",
    );
    writeFileSync(path.join(archive, "references", "field-history.md"), "Engine-present fields → `mstar-fixture`.\n");

    const input = { rolesDir, skillsDir: skillsRoot };
    const result = await definition("roles.validate").execute(input, context(skillsRoot));
    expect(
      violationsOf(result).some(
        ({ code, message }) =>
          code === "roles.loadorder.legacy.archive.reference" && message.includes("mstar-fixture"),
      ),
    ).toBe(true);

    // S-1: the references dir is read best-effort — its absence is not a crash
    // and reports no archive-reference row.
    rmSync(path.join(archive, "references"), { recursive: true, force: true });
    const withoutRefs = await definition("roles.validate").execute(input, context(skillsRoot));
    expect(violationsOf(withoutRefs).some(({ code }) => code === "roles.loadorder.legacy.archive.reference")).toBe(false);
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
