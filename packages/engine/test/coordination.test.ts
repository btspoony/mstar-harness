/**
 * Engine coordinator plan coordination — shared-surface cases.
 *
 * The FILE execution route is retired: the file-route session frames, scope
 * reads and the coordinator-envelope address form are gone. What remains here
 * is the surface the ACTIVE route and the migration tooling still share:
 *
 * - the ONE resolver path's trusted-root/target resolution (S2/E02), including
 *   the candidate-listing and Git-unavailable branches that are pure;
 * - the one canonical plan pointer both registration producers agree on
 *   (E07 fold).
 *
 * The coordinator's ordinary plan operations and their Git proofs are covered
 * by the ACTIVE route's own suites (`execution-coordination.test.ts`); this
 * file no longer drives them.
 *
 * Every case runs against a real temporary harness and the real engine; no case
 * reads or writes this checkout's control store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  resolveIntentRoot,
  resolveIntentTarget,
  resolveProcessHarnessDir,
} from "../src/coordination.js";
import { commitExecutionRegistration } from "../src/execution-registration.js";
import { readExecutionAuthority } from "../src/execution-read.js";
import { initializeStore, openStore } from "../src/store-db.js";
import { createFsStore, setArtifactStore } from "../src/store.js";
import { registerIterationWorkflow } from "../src/workflow.js";
import {
  WORKFLOW_ID, PLAN_ID, PEER_PLAN_ID, FIXTURE_COORDINATOR_ID,
  git, writeText, writeJson, readJson, makeFixture, errorCodeOf, failureCode, failureOf,
  afterEachCleanup,
} from "./support/coordination-fixtures.js";

afterEach(() => {
  afterEachCleanup();
});

/* ------------------------------------------------------------------------ *
 * E07 fold — one canonical plan pointer across both routes
 * ------------------------------------------------------------------------ */

describe("registration route parity — one canonical plan pointer (E07 fold)", () => {
  const ROUTE_PLAN = "plan-route-parity";

  /** The canonical registered plan file of one harness, as §4 resolves it. */
  function canonicalRowPointer(harness: string, planId: string): string {
    return join(harness, "plans", `${planId}.md`);
  }

  /** The row state the DB route sealed for one iteration row. */
  async function storedRowPointer(harness: string, workflowId: string, planId: string): Promise<string> {
    const handle = await openStore({ harnessDir: harness }, "read");
    try {
      const row = handle.db
        .prepare("select state_json from execution_plans where workflow_id = ? and plan_id = ?")
        .get(workflowId, planId) as { state_json?: string } | undefined;
      const state: { file?: string } = JSON.parse(String(row?.state_json));
      return String(state.file);
    } finally {
      handle.close();
    }
  }

  test("the DB registration route stores the same canonical row pointer as the file producer (pointer correction — route parity)", async () => {
    const fileRoot = makeFixture();
    const dbRoot = makeFixture();
    for (const fixture of [fileRoot, dbRoot]) {
      writeText(join(fixture.harness, "plans", `${ROUTE_PLAN}.md`), `# Plan ${ROUTE_PLAN}\n\n**plan_id:** ${ROUTE_PLAN}\n`);
    }
    // The reviewed row pointer, spelled the one way both routes accept.
    const rows = [{ id: ROUTE_PLAN, title: `Plan ${ROUTE_PLAN}`, file: `plans/${ROUTE_PLAN}.md` }];

    // The file producer, on the migration-era authority it owns.
    setArtifactStore(createFsStore(fileRoot.harness));
    await registerIterationWorkflow("iter-route-file", {
      harnessDir: fileRoot.harness,
      compassRef: "iterations/iter-route-file/delivery-compass.md",
      branch: { base: "main", integration: "iteration/iter-route-file", target: "main" },
      rows,
    });
    const fileRoute = readJson(join(fileRoot.harness, "workflows", "iter-route-file", "snapshot.json"));
    const filePlans = fileRoute.plans as Array<{ file: string }>;
    expect(filePlans[0]!.file).toBe(canonicalRowPointer(fileRoot.harness, ROUTE_PLAN));

    // The ACTIVE DB route, on its own control root.
    // This fixture exercises fresh authority initialization, not migration of
    // the unrelated FILE workflow that makeFixture seeds for other cases.
    rmSync(join(dbRoot.harness, "status.json"));
    rmSync(join(dbRoot.harness, "workflows"), { recursive: true });
    const store = await initializeStore({ harnessDir: dbRoot.harness });
    store.close();
    // `store init` activates execution authority together with the schema, so
    // the root token is read (not re-initialized) before the registration CAS.
    const initialized = await readExecutionAuthority({ harnessDir: dbRoot.harness });
    setArtifactStore(createFsStore(dbRoot.harness));
    const iterationId = "iter-route-db";
    const caller = { sessionId: FIXTURE_COORDINATOR_ID, role: "coordinator" as const, workflowId: iterationId };
    await commitExecutionRegistration(
      { harnessDir: dbRoot.harness, caller },
      {
        operationId: "op-route-db",
        actor: "project-manager",
        expectedCatalogRevision: 0,
        workflow: {
          kind: "iteration",
          workflowId: iterationId,
          options: {
            harnessDir: dbRoot.harness,
            compassRef: "iterations/iter-route-db/delivery-compass.md",
            branch: { base: "main", integration: "iteration/iter-route-db", target: "main" },
            rows,
          },
        },
        delta: {
          entities: [
            { kind: "iteration", id: iterationId, title: iterationId, rootKind: "iterations", relativePath: iterationId },
          ],
          binding: { catalogKind: "iteration", catalogId: iterationId },
        },
        expected: initialized.token,
      },
    );
    // Route parity: one canonical form, the same value the file producer stores.
    expect(await storedRowPointer(dbRoot.harness, iterationId, ROUTE_PLAN)).toBe(
      canonicalRowPointer(dbRoot.harness, ROUTE_PLAN),
    );

    // ...and the DB route refuses the spelling the file route refuses, instead
    // of persisting it verbatim — the finding this fold closes.
    const verbatimId = "iter-route-verbatim";
    const refusal = await failureOf(() =>
      commitExecutionRegistration(
        { harnessDir: dbRoot.harness, caller: { ...caller, workflowId: verbatimId } },
        {
          operationId: "op-route-verbatim",
          actor: "project-manager",
          expectedCatalogRevision: 1,
          workflow: {
            kind: "iteration",
            workflowId: verbatimId,
            options: {
              harnessDir: dbRoot.harness,
              compassRef: `iterations/${verbatimId}/delivery-compass.md`,
              branch: { base: "main", integration: `iteration/${verbatimId}`, target: "main" },
              rows: [{ id: ROUTE_PLAN, title: `Plan ${ROUTE_PLAN}`, file: `${ROUTE_PLAN}.md` }],
            },
          },
          delta: {
            entities: [{ kind: "iteration", id: verbatimId, title: verbatimId, rootKind: "iterations", relativePath: verbatimId }],
            binding: { catalogKind: "iteration", catalogId: verbatimId },
          },
          expected: initialized.token,
        },
      ),
    );
    expect(failureCode(refusal)).toBe("plan-path.invalid-pointer");
  }, 60000);
});

/* ------------------------------------------------------------------------ *
 * Intent resolution — trusted root, explicit target (S2/E02)
 *
 * The consumer-visible addressing contract: a call states the root it trusts and
 * the plan it addresses; the engine resolves the rest from durable facts and
 * lists its candidates instead of guessing when a target is ambiguous. The
 * file-route authority-change branch is gone with its mutator.
 * ------------------------------------------------------------------------ */

describe("intent resolution — trusted root, explicit target", () => {
  /**
   * A directory that looks like a linked checkout (its `.git` is a FILE) whose
   * Git fact cannot be read: `git` answers non-zero for it, so the process root
   * is genuinely unavailable there — the A24 situation, not a stub.
   */
  function unreadableLinkedCheckout(fixture: ReturnType<typeof makeFixture>): string {
    const linked = join(fixture.root, "linked-checkout");
    writeText(join(linked, ".git"), `gitdir: ${join(fixture.root, "no-such-main", ".git", "worktrees", "linked")}\n`);
    return linked;
  }

  test("the workflow association resolves the root and an explicitly addressed row", async () => {
    const fixture = makeFixture();

    // The durable association supplies the root; its own workflow is the target.
    const root = resolveIntentRoot({ cwd: join(fixture.root, "unrelated") }, {
      root: fixture.harness,
      source: "session.envelope",
    });
    expect(root.ok).toBe(true);
    if (!root.ok) throw new Error("a recorded root association must resolve");
    expect(root.root).toBe(fixture.harness);

    const associated = resolveIntentTarget({ root: fixture.harness, association: { workflowId: WORKFLOW_ID } });
    expect(associated.ok).toBe(true);
    if (!associated.ok) throw new Error("the association must resolve its workflow");
    expect(associated.workflowId).toBe(WORKFLOW_ID);

    // An explicit selection wins over the association, with its own provenance.
    const explicit = resolveIntentTarget({
      root: fixture.harness,
      selection: { workflowId: WORKFLOW_ID, planId: PEER_PLAN_ID },
      association: { workflowId: "wf-somewhere-else" },
    });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) throw new Error("the explicit selection must resolve the peer row");
    expect(explicit.planId).toBe(PEER_PLAN_ID);
    expect(explicit.resolvedFrom).toEqual([
      { path: "workflowId", source: "intent.explicit" },
      { path: "planId", source: "intent.explicit" },
    ]);
  });

  test("an unassociated target lists its candidates instead of picking one (A22)", async () => {
    const fixture = makeFixture();
    const peerWorkflow = "wf-planb";
    writeJson(join(fixture.harness, "workflows", peerWorkflow, "snapshot.json"), {
      ...readJson(fixture.snapshotPath),
      id: peerWorkflow,
    });

    const ambiguous = resolveIntentTarget({ root: fixture.harness });
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) throw new Error("an unassociated root must not select a workflow");
    expect(ambiguous.problem.code).toBe("coordination.invalid-input");
    expect(ambiguous.problem.currentFacts).toEqual([
      `workflow ${WORKFLOW_ID} exists at ${fixture.harness}`,
      `workflow ${peerWorkflow} exists at ${fixture.harness}`,
    ]);
    expect(ambiguous.problem.availableWork).toEqual([
      `address workflow ${WORKFLOW_ID} explicitly`,
      `address workflow ${peerWorkflow} explicitly`,
    ]);

    // A selector the root does not hold is refused — never substituted.
    const missing = resolveIntentTarget({ root: fixture.harness, selection: { workflowId: "wf-absent" } });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("an absent selector must not be substituted");
    expect(missing.problem.code).toBe("coordination.workflow-not-found");

    // A sole candidate is still only a LISTED candidate.
    rmSync(join(fixture.harness, "workflows", peerWorkflow), { recursive: true, force: true });
    const sole = resolveIntentTarget({ root: fixture.harness });
    expect(sole.ok).toBe(false);
    if (sole.ok) throw new Error("a sole candidate is not a selection");
    expect(sole.problem.availableWork).toEqual([`address workflow ${WORKFLOW_ID} explicitly`]);

    // A plan id that is not a row of the addressed workflow is refused too.
    const wrongPlan = resolveIntentTarget({ root: fixture.harness, selection: { workflowId: WORKFLOW_ID, planId: "plan-absent" } });
    expect(wrongPlan.ok).toBe(false);
    if (wrongPlan.ok) throw new Error("an absent plan row must not be substituted");
    expect(wrongPlan.problem.code).toBe("coordination.plan-not-found");
  });

  test("a trusted root survives a Git fact the process probe cannot read (A24)", async () => {
    const fixture = makeFixture();
    const linked = unreadableLinkedCheckout(fixture);

    // The Git fact about this process is genuinely unreadable...
    expect(await errorCodeOf(async () => resolveProcessHarnessDir(linked))).toBe("coordination.not-in-git");

    // ...so the established read proceeds on the trusted root alone.
    const resolved = resolveIntentRoot({ cwd: linked }, { root: fixture.harness, source: "session.envelope" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("the trusted root must survive an unreadable Git probe");
    expect(resolved.resolvedFrom).toEqual([
      { path: "controlRoot", source: "session.envelope" },
      { path: "cwd", source: "harness.probe.unavailable" },
    ]);
    expect(resolved.warnings.map((entry) => entry.code)).toEqual(["coordination.git-unavailable"]);
  });

  test("process root without Git stops at a nested independent repository and refuses unresolved linked checkout boundaries at every depth", async () => {
    const fixture = makeFixture();
    const independent = join(fixture.worktreePath, "independent");
    mkdirSync(independent);
    git(["init", "-q", "-b", "main"], independent);
    const independentHarness = join(independent, ".mstar");
    mkdirSync(independentHarness);
    const independentChild = join(independent, "child");
    const independentGrandchild = join(independentChild, "child");
    mkdirSync(independentGrandchild, { recursive: true });
    const linkedChild = join(fixture.peerWorktreePath, "child");
    const linkedGrandchild = join(linkedChild, "child");
    mkdirSync(linkedGrandchild, { recursive: true });
    // With Git available, the linked checkout still resolves its main control
    // root; the independent repository resolves only its own bounded layout.
    expect(resolveProcessHarnessDir(linkedGrandchild)).toBe(fixture.harness);
    expect(resolveProcessHarnessDir(independentGrandchild)).toBe(independentHarness);
    const binDir = join(fixture.root, "no-git");
    mkdirSync(binDir);
    const script = join(fixture.root, "resolve-roots.ts");
    writeText(script, [
      `import { resolveProcessHarnessDir } from ${JSON.stringify(join(import.meta.dir, "..", "src", "coordination.ts"))};`,
      `const results = process.argv.slice(2).map((cwd) => {`,
      `  try { return { root: resolveProcessHarnessDir(cwd) }; }`,
      `  catch (error) {`,
      `    if (error === null || typeof error !== "object" || !("code" in error)) throw error;`,
      `    return { code: error.code };`,
      `  }`,
      `});`,
      `console.log(JSON.stringify(results));`,
      "",
    ].join("\n"));
    const before = readFileSync(fixture.snapshotPath, "utf8");
    const child = Bun.spawn([
      process.execPath, script,
      independent, independentChild, independentGrandchild,
      fixture.peerWorktreePath, linkedChild, linkedGrandchild,
    ], {
      // Import-time process root discovery is part of the observed CLI failure.
      cwd: independentGrandchild,
      env: { ...process.env, PATH: binDir, MSTAR_HARNESS_DIR: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      { root: independentHarness }, { root: independentHarness }, { root: independentHarness },
      { code: "coordination.not-in-git" }, { code: "coordination.not-in-git" }, { code: "coordination.not-in-git" },
    ]);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before);
  }, 30000);

  test("an unresolvable trusted root is a typed report, never a guessed root (A25)", async () => {
    const fixture = makeFixture();
    const linked = unreadableLinkedCheckout(fixture);
    const bare = join(fixture.root, "no-harness");
    writeText(join(bare, "placeholder.txt"), "x\n");

    const unreadable = resolveIntentRoot({ cwd: linked });
    expect(unreadable.ok).toBe(false);
    if (unreadable.ok) throw new Error("an unreadable probe must not produce a root");
    expect(unreadable.problem.code).toBe("coordination.harness-not-found");
    expect(unreadable.problem.sourcesTried).toEqual(["cwd (harness probe)"]);
    expect(unreadable.problem.availableWork).toEqual([
      "pass the trusted control root explicitly (IntentContext.controlRoot)",
      "run the call from inside the control harness's own main worktree",
    ]);

    const explicit = resolveIntentRoot({ cwd: linked, controlRoot: fixture.harness });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) throw new Error("an explicit trusted root is authoritative");
    expect(explicit.resolvedFrom).toEqual([{ path: "controlRoot", source: "intent.explicit" }]);
    expect(explicit.warnings).toEqual([]);
  });

  test("a process root that disagrees with the trusted root is refused without writes", async () => {
    const fixture = makeFixture();
    // A second REAL control root (its own Git repository and its own `.mstar`),
    // so the process probe answers and names a different root.
    const other = makeFixture();
    const before = readJson(fixture.snapshotPath);

    const refusal = resolveIntentRoot({ cwd: other.root }, { root: fixture.harness, source: "session.envelope" });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error("two durable root statements must not be silently reconciled");
    expect(refusal.problem.code).toBe("coordination.scope-mismatch");
    expect(refusal.problem.component).toBe("root");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  });
});
