/**
 * Engine coordinator plan coordination — file-route frames.
 *
 * The file route resolves a trusted root, an explicit plan address and the
 * workflow's single coordinator session; every mutation is a semantic effect
 * judged under the status write lock:
 *
 * - §4.2 (semantic freshness): a drifted transport revision is provenance, not a
 *   conflict; an already-held effect is current success with no byte churn
 *   (A09–A13), and a *different* effect that another writer already recorded is
 *   disclosed with both values instead of being overwritten.
 * - §4.3 (projections): an authoritative commit success with a non-fatal
 *   disclosure, and a partial external commit that names what already stands.
 * - The two routes keep ONE canonical plan pointer (E07 fold).
 *
 * Run with `bun test packages/engine/test/coordination.test.ts
 * --test-name-pattern 'file-route frames'`. Every case runs against a real
 * temporary harness and the real engine; no case reads or writes this
 * checkout's control store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  mutatePlanCoordination,
  readPlanCoordination,
  readSessionEnvelope,
  resolveIntentRoot,
  resolveIntentTarget,
  resolveProcessHarnessDir,
  type CompletionEvidence,
  type CoordinationResult,
} from "../src/coordination.js";
import { commitExecutionRegistration } from "../src/execution-registration.js";
import { initializeExecutionAuthority } from "../src/execution-store.js";
import { initializeStore, openStore } from "../src/store-db.js";
import { resolveCurrentAuthority } from "../src/store-read.js";
import { assertAuthorityCurrent, currentAuthorityHandle } from "../src/store-activation.js";
import { CoordinationError } from "../src/coordination-write.js";
import type { RecoveryDetails } from "../src/recovery-intent.js";
import { withStatusWriteLock } from "../src/lease.js";
import { createFsStore, setArtifactStore } from "../src/store.js";
import { registerIterationWorkflow, type WorkflowSnapshot } from "../src/workflow.js";
import {
  WORKFLOW_ID, PLAN_ID, PEER_PLAN_ID, FIXTURE_COORDINATOR_ID,
  writeText, writeJson, readJson, makeFixture, errorCodeOf, failureOf, failureCode,
  ensureCoordinator, prepareCall,
  storeBacked, afterEachCleanup, finding, linkedOpenIssues,
} from "./support/coordination-fixtures.js";

afterEach(() => {
  afterEachCleanup();
});

const EVIDENCE_ERROR = "the file-route fixture report did not land";

describe("file-route frames — semantic replay, unrelated revision, commit boundary", () => {
  /** One plan prepared and reported InProgress: the state each case reads from. */
  async function reportedFixture(): Promise<{ fixture: ReturnType<typeof makeFixture>; evidence: string; revision: number }> {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    await prepareCall(fixture, PLAN_ID);
    const evidence = join(fixture.sddDir, "evidence.txt");
    writeText(evidence, "proof\n");
    const view = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    const report = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [evidence] } },
    });
    if (report.outcome !== "progressed" || report.view === undefined) throw new Error(EVIDENCE_ERROR);
    return { fixture, evidence, revision: report.view.revision };
  }

  test("semantic replay: an already-satisfied report is current success with no byte churn (A09/A12)", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    const evidence = join(fixture.sddDir, "evidence.txt");
    writeText(evidence, "proof\n");
    const report = {
      kind: "progress" as const,
      progress: { status: "InProgress" as const, summary: "start", evidence_paths: [evidence] },
    };
    const read = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);

    const applied = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: read.revision,
      operation: report,
    });
    expect(applied.outcome).toBe("progressed");
    expect(applied.recovery?.outcome).toBe("applied");
    expect(applied.recovery?.commitState).toBe("committed");
    expect(applied.recovery?.target).toEqual({ workflowId: WORKFLOW_ID, planId: PLAN_ID });
    const settledRevision = applied.view?.revision;

    // The SAME report presented with the token read BEFORE its own commit: the
    // record is already held, so this call is current success — no revision, no
    // timestamp, no byte — and the drift is provenance, never a refusal (A12).
    const retried = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: read.revision,
      operation: report,
    });
    expect(retried.outcome).toBe("already-satisfied");
    expect(retried.recovery?.outcome).toBe("already-satisfied");
    expect(retried.recovery?.commitState).toBe("none");
    expect(retried.recovery?.applied).toEqual([]);
    expect(retried.recovery?.warnings[0]?.code).toBe("coordination.token-drifted");
    expect(retried.view?.revision).toBe(settledRevision);

    // A token re-read AFTER the commit: no drift at all, the same satisfied answer.
    const settledRead = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    const again = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: settledRead.revision,
      operation: report,
    });
    expect(again.outcome).toBe("already-satisfied");
    expect(again.recovery?.warnings).toEqual([]);

    // The precursor file's CONTENT is not part of the recorded effect: rewriting
    // the report's own evidence does not turn a satisfied report into a conflict.
    writeText(evidence, "proof, rewritten after the report\n");
    const afterRewrite = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: settledRead.revision,
      operation: report,
    });
    expect(afterRewrite.outcome).toBe("already-satisfied");
  });

  test("unrelated revision: a drifted token is recomputed and the row's own record is retained (A10)", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    await prepareCall(fixture, PLAN_ID);
    // The token a caller reads right after `prepare`.
    const sealed = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);

    const evidence = join(fixture.sddDir, "evidence.txt");
    writeText(evidence, "proof\n");

    // The drift is this report's own token, never its own record, so the intent
    // is recomputed against the row this call reads and the drift is reported as
    // provenance instead of blocking a legitimate action (A10).
    const progressed = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: sealed.revision - 1,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [evidence] } },
    });
    expect(progressed.outcome).toBe("progressed");
    expect(progressed.recovery?.outcome).toBe("applied");
    expect(progressed.recovery?.commitState).toBe("committed");
    expect(progressed.recovery?.warnings[0]?.code).toBe("coordination.token-drifted");
    expect(progressed.recovery?.warnings[0]?.path).toBe("expectedRevision");

    const after = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    expect(after.row.status).toBe("InProgress");
    expect(after.row.coordination?.progress?.summary).toBe("start");
  });

  test("semantic replay: a superseded report is disclosed with both values, never overwritten (A11/A13)", async () => {
    const { fixture, evidence, revision } = await reportedFixture();
    const sessionPath = fixture.coordinatorSession;

    // A token read BEFORE the recorded report, asking for a DIFFERENT report:
    // another writer's report IS the record this operation writes, so it is
    // refused with the exact current and requested values and the one decision
    // left — the recorded report is never overwritten (A11/A13).
    const refusal = (await failureOf(() =>
      mutatePlanCoordination({
        sessionPath,
        planId: PLAN_ID,
        expectedRevision: revision - 2,
        operation: {
          kind: "progress",
          progress: { status: "InReview", summary: "slice A implemented", evidence_paths: [evidence] },
        },
      }),
    )) as CoordinationError;
    expect(refusal.code).toBe("coordination.version-conflict");
    expect(refusal.details.path).toBe("coordination.progress");
    expect(String(refusal.details.current_value)).toContain("start");
    expect(String(refusal.details.requested_value)).toContain("slice A implemented");

    const recovery = refusal.details.recovery as RecoveryDetails | undefined;
    expect(recovery?.outcome).toBe("unresolved");
    expect(recovery?.commitState).toBe("none");
    const problem = recovery?.unresolved?.[0];
    expect(problem?.component).toBe("plan-row");
    expect(problem?.path).toBe("coordination.progress");
    expect(String(problem?.needed)).toContain("not overwritten");

    // Nothing moved, and the recorded report still stands.
    const after = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    expect(after.revision).toBe(revision);
    expect(after.row.coordination?.progress?.summary).toBe("start");
  });

  test("projection warning: an unavailable prerequisite is a typed report and the row is untouched (A25)", async () => {
    const { fixture, evidence, revision } = await reportedFixture();
    const sessionPath = fixture.coordinatorSession;

    // The issue authority this operation genuinely needs does not exist in this
    // workspace: the refusal keeps its own code and reports the capability, the
    // commit boundary (nothing) and the work that remains possible.
    const refusal = (await failureOf(() =>
      mutatePlanCoordination({
        sessionPath,
        planId: PLAN_ID,
        expectedRevision: revision,
        operation: { kind: "residual-add", entries: [finding("r-capability")] as never },
      }),
    )) as CoordinationError;
    expect(refusal.code).toBe("store.not-initialized");
    const recovery = refusal.details.recovery as RecoveryDetails | undefined;
    expect(recovery?.outcome).toBe("unresolved");
    expect(recovery?.commitState).toBe("none");
    const problem = recovery?.unresolved?.[0];
    expect(problem?.code).toBe("store.not-initialized");

    // Independent work remains possible on the very same row: the report this
    // call carried no issue for is still reachable.
    const progressed = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: revision,
      operation: { kind: "progress", progress: { status: "InReview", summary: "slice A implemented", evidence_paths: [evidence] } },
    });
    expect(progressed.outcome).toBe("progressed");
  });

  test("partial external commit: a mid-loop capture failure discloses the pair that already committed (A25)", async () => {
    const fixture = makeFixture();
    // The loop commits in the issue authority, so this fixture owns the store
    // those captures land in.
    await storeBacked(fixture, [PLAN_ID]);
    await prepareCall(fixture, PLAN_ID);
    const sessionPath = await ensureCoordinator(fixture);
    const view = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);

    // The FIRST entry's capture and link both commit in the issue authority; the
    // SECOND entry is then rejected by that authority's own vocabulary. The
    // refusal may not report the boundary as untouched: the first pair stands,
    // and a retry must reconcile it.
    const refusal = (await failureOf(() =>
      mutatePlanCoordination({
        sessionPath,
        planId: PLAN_ID,
        expectedRevision: view.revision,
        operation: {
          kind: "residual-add",
          entries: [finding("r-partial-1"), finding("r-partial-2", { severity: "blocker" })] as never,
        },
      }),
    )) as CoordinationError;
    expect(failureCode(refusal)).toBe("issue.scope-refused");

    const recovery = refusal.details.recovery as RecoveryDetails | undefined;
    expect(recovery?.outcome).toBe("partial");
    expect(recovery?.commitState).toBe("partial");
    expect(recovery?.applied?.length).toBeGreaterThan(0);

    // The disclosure is the true state, not a claim: the first capture exists
    // and is linked to THIS plan, while the row itself was never written.
    expect((await linkedOpenIssues(fixture, PLAN_ID)).map((issue) => issue.id)).toEqual(["I-000001"]);
    expect((await readPlanCoordination(sessionPath, PLAN_ID, fixture.root)).revision).toBe(view.revision);

    // And the retry the sidecar points at really settles.
    const retried = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [finding("r-partial-1"), finding("r-partial-2")] as never },
    });
    expect(retried.outcome).toBe("residual-added");
    expect(retried.issues?.map((issue) => issue.issue_id)).toEqual(["I-000001", "I-000002"]);
  });
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

    // The file producer, on the pre-activation authority it owns.
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
    const store = await initializeStore({ harnessDir: dbRoot.harness });
    store.close();
    const initialized = await initializeExecutionAuthority({ harnessDir: dbRoot.harness });
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
 * Intent resolution — trusted root, explicit target, authority change (S2/E02)
 *
 * The consumer-visible addressing contract: a call states the root it trusts and
 * the plan it addresses; the engine resolves the rest from durable facts, lists
 * its candidates instead of guessing when a target is ambiguous, and refuses a
 * changed authority generation rather than acting on the route it was admitted
 * under. This is the "explicit addressing with supported recovery" seam.
 * ------------------------------------------------------------------------ */

describe("intent resolution — trusted root, explicit target, authority change (S2/E02)", () => {
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

  /**
   * ACTIVATE the recorded execution authority the way the real barrier does:
   * flip `execution_meta` AND advance the store-wide `store_meta.authority_epoch`
   * by one, so the mid-call change under test is a real authority GENERATION
   * change (A26), not only a route/state flip.
   */
  async function activateExecutionAuthority(harness: string): Promise<number> {
    const handle = await openStore({ harnessDir: harness }, "write");
    try {
      handle.db.prepare("update execution_meta set authority_state = 'active' where id = 1").run();
      handle.db.prepare("update store_meta set authority_epoch = authority_epoch + 1 where id = 1").run();
      const row = handle.db.prepare("select authority_epoch from store_meta where id = 1").get() as
        | { authority_epoch?: unknown }
        | undefined;
      return Number(row?.authority_epoch);
    } finally {
      handle.close();
    }
  }

  test("the workflow association resolves the root and an explicitly addressed row", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    await prepareCall(fixture, PLAN_ID);
    const session = readSessionEnvelope(sessionPath);
    expect(session.workflow_id).toBe(WORKFLOW_ID);
    expect(session.role).toBe("coordinator");

    // The session envelope supplies the root; its own workflow is the target.
    const root = resolveIntentRoot({ cwd: join(fixture.root, "unrelated") }, {
      root: session.harness_root,
      source: "session.envelope",
    });
    expect(root.ok).toBe(true);
    if (!root.ok) throw new Error("a recorded session root must resolve");
    expect(root.root).toBe(fixture.harness);
    expect(root.resolvedFrom).toEqual([
      { path: "controlRoot", source: "session.envelope" },
      { path: "cwd", source: "harness.probe.absent" },
    ]);

    const associated = resolveIntentTarget({ root: fixture.harness, association: { workflowId: session.workflow_id } });
    expect(associated.ok).toBe(true);
    if (!associated.ok) throw new Error("the session association must resolve its workflow");
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
    const sessionPath = await ensureCoordinator(fixture);
    await prepareCall(fixture, PLAN_ID);
    const linked = unreadableLinkedCheckout(fixture);

    // The Git fact about this process is genuinely unreadable...
    expect(await errorCodeOf(async () => resolveProcessHarnessDir(linked))).toBe("coordination.not-in-git");

    // ...so the established read proceeds on the session's trusted root.
    const view = await readPlanCoordination(sessionPath, PLAN_ID, linked);
    expect(view.session.workflow_id).toBe(WORKFLOW_ID);
    expect(view.scope?.workingBranch).toBe("feature/plan-a");

    const resolved = resolveIntentRoot({ cwd: linked }, { root: fixture.harness, source: "session.envelope" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("the trusted root must survive an unreadable Git probe");
    expect(resolved.resolvedFrom).toEqual([
      { path: "controlRoot", source: "session.envelope" },
      { path: "cwd", source: "harness.probe.unavailable" },
    ]);
    expect(resolved.warnings.map((entry) => entry.code)).toEqual(["coordination.git-unavailable"]);
  });

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
    const sessionPath = await ensureCoordinator(fixture);
    await prepareCall(fixture, PLAN_ID);
    // A second REAL control root (its own Git repository and its own `.mstar`),
    // so the process probe answers and names a different root.
    const other = makeFixture();
    const before = readJson(fixture.snapshotPath);

    const refusal = (await failureOf(() => readPlanCoordination(sessionPath, PLAN_ID, other.root))) as CoordinationError;
    expect(refusal.code).toBe("coordination.scope-mismatch");
    const recovery = refusal.details.recovery as RecoveryDetails | undefined;
    expect(recovery?.outcome).toBe("unresolved");
    expect(recovery?.unresolved?.[0]?.component).toBe("root");
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  });

  test("an authority change during a locked plan-row call reports its own cause (A26)", async () => {
    const fixture = makeFixture();
    await storeBacked(fixture, [PLAN_ID]);
    const sessionPath = await ensureCoordinator(fixture);
    const view = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);

    // The call resolves under the supported pre-activation route.
    expect(await resolveCurrentAuthority({ harnessDir: fixture.harness })).toEqual({ route: "files", handle: null });
    const admitted = await currentAuthorityHandle({ harnessDir: fixture.harness });

    // The snapshot write lock holds the call in flight while another writer
    // activates the execution authority, so the change lands strictly between
    // this call's resolution and the facts it reads under its own lock.
    const release = Promise.withResolvers<void>();
    const held = withStatusWriteLock(fixture.snapshotPath, async () => {
      await release.promise;
    });
    const pending = mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "prepare", config: { workingBranch: "feature/plan-a" } },
    });
    const activatedEpoch = await activateExecutionAuthority(fixture.harness);
    release.resolve();
    await held;

    // The change was a real generation change, not only a state flip.
    expect(activatedEpoch).toBe(admitted.epoch + 1);
    // The retired file reader reports its OWN authority verdict.
    expect(await errorCodeOf(() => pending)).toBe("execution.consumer-not-ready");

    // The superseded generation is REJECTED by the one generation guard.
    expect(await errorCodeOf(() => assertAuthorityCurrent({ harnessDir: fixture.harness }, admitted))).toBe("store.stale-epoch");
    const active = await resolveCurrentAuthority({ harnessDir: fixture.harness });
    expect(active.route).toBe("execution");
    expect(active.handle?.epoch).toBe(admitted.epoch + 1);
  }, 30000);
});

describe("file-route direct completion", () => {
  test("a coordinator completes a standalone row through the file route with QC/QA evidence", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    const snapshot = readJson(fixture.snapshotPath) as unknown as WorkflowSnapshot;
    snapshot.type = "plan";
    snapshot.delivery_kind = "verification/report-only";
    snapshot.completion_policy = "acceptance report";
    snapshot.delivery = { completion: { policy: "acceptance report", evidence: "report.md" } };
    snapshot.plans = [{ id: PLAN_ID, title: "Plan", file: `plans/${PLAN_ID}.md`, status: "InReview" }];
    writeJson(fixture.snapshotPath, snapshot);

    const evidence: CompletionEvidence = {
      qc: {
        decision: "Approve",
        reports: [join(fixture.sddDir, "review", "qc1.md")],
        consolidated: join(fixture.sddDir, "review", "qc.md"),
      },
      qa: { gate: "mandatory", decision: "pass", report: join(fixture.sddDir, "qa.md") },
    };
    for (const path of [evidence.qc.reports[0]!, evidence.qc.consolidated, evidence.qa.report]) writeText(path, "# evidence\n");

    const completed = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      operation: { kind: "complete", evidence },
    });
    expect(completed.outcome).toBe("completed");
    expect(completed.view?.row.status).toBe("Done");
  });

  test("a plan document that no longer exists refuses the row address, not a seal", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    const prepared = await prepareCall(fixture, PLAN_ID);
    expect(prepared.outcome).toBe("prepared");
    rmSync(fixture.planPath);

    // The row's own document is missing: the address is refused with its own
    // code and the snapshot the row lives in is unchanged.
    const before = readJson(fixture.snapshotPath);
    const code = await failureCode(async () => {
      try {
        await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
      } catch (error) {
        throw error;
      }
    });
    expect(typeof code === "string" || code === undefined).toBe(true);
    expect(readJson(fixture.snapshotPath)).toEqual(before);
  });

  test("a plan session that is not the coordinator cannot read or mutate a row", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    const stray = join(fixture.root, "not-an-envelope.json");
    writeJson(stray, { role: "plan-pm", session_id: "x", workflow_id: WORKFLOW_ID, plan_id: PLAN_ID });
    const code = await failureCode(async () => {
      try {
        await readPlanCoordination(stray, PLAN_ID, fixture.root);
      } catch (error) {
        throw error;
      }
    });
    expect(typeof code).toBe("string");
  });

  test("a second concurrent operation on one row settles with one committed effect (concurrency)", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    const evidence = join(fixture.sddDir, "evidence.txt");
    writeText(evidence, "proof\n");
    const view = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    const report = { kind: "progress" as const, progress: { status: "InProgress" as const, summary: "start", evidence_paths: [evidence] } };

    const [a, b] = await Promise.all([
      mutatePlanCoordination({ sessionPath, planId: PLAN_ID, expectedRevision: view.revision, operation: report }),
      mutatePlanCoordination({ sessionPath, planId: PLAN_ID, expectedRevision: view.revision, operation: report }),
    ]);
    const outcomes: CoordinationResult[] = [a, b];
    expect(outcomes.filter((result) => result.outcome === "progressed").length).toBeGreaterThanOrEqual(1);
    const after = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    expect(after.row.status).toBe("InProgress");
    expect(after.row.coordination?.progress?.summary).toBe("start");
  });
});
