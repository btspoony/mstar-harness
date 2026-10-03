// Engine scoped-plan coordination — bind, admission, scope/revisions and issue-authority families
// (including the findings-gate issue-authority cases).
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join, sep } from "node:path";
import {
  EXECUTION_PIN_CONFLICT_CODE,
  bindPlanSession,
  mutatePlanCoordination,
  readCoordinatedArtifact,
  readPlanCoordination,
  readSessionEnvelope,
  recoverPrepareCoordinator,
  replaceCoordinatedArtifact,
  resolvePlanScope,
  showPrepareCoordinatorRecovery,
  type CoordinationResult,
  type PlanCoordinationView,
  type PrepareCoordinatorRecoveryView,
} from "../src/coordination.js";
import { updateCatalogEntity } from "../src/catalog.js";
import type { RecoveryDetails } from "../src/recovery-intent.js";
import { openStore } from "../src/store-db.js";
import {
  CoordinationError,
  readArtifactBytes,
  validateSnapshotCoordination,
} from "../src/coordination-write.js";
import {
  createFsStore,
  setArtifactStore,
  type ArtifactDoc,
  type ArtifactRef,
  type ArtifactStore,
} from "../src/store.js";
import {
  recordWorkflowDelivery,
  stableJson,
  WORKFLOW_SNAPSHOT_FILE,
  writeWorkflowSnapshot,
  type WorkflowSnapshot,
} from "../src/workflow.js";
import {
  WORKFLOW_ID, PLAN_ID, PEER_PLAN_ID, PROJECT_ID, FIXTURE_COORDINATOR_ID,
  type Fixture, git, writeText, writeJson, readJson, makeFixture, errorCodeOf, failureOf,
  ensureCoordinator, preparePlan, bindPlan, resumePlan,
  gitFixture, snapshotOf, planRowOf, updatePlanRow, claimExecutionLease, leaseHolder,
  handoffEvidenceOf, handoffCall, sealStoreForReaders, afterEachCleanup, finding, linkedOpenIssues,
} from "./support/coordination-fixtures.js";

afterEach(() => {
  afterEachCleanup();
});

/** Close one captured issue through the scoped operation (core closure evidence). */
function closeOp(issueId: string, expectedIssueRevision: number, disposition = "resolved"): Record<string, unknown> {
  return {
    kind: "residual-close",
    issueId,
    disposition,
    evidence:
      disposition === "resolved"
        ? { reason: "fixed in session", references: ["review/qc1.md"], alignmentRef: "qa acceptance record" }
        : disposition === "waived"
          ? { reason: "accepted risk", scope: "engine", references: [], alignmentRef: "user alignment" }
          : { reason: `folded into ${issueId}`, references: [], canonicalIssueId: "I-000001" },
    expectedIssueRevision,
  };
}


describe("findings-gate — issue authority (G2a)", () => {
  test("issue authority: an open critical issue in the store refuses the handoff, closing it releases the gate", async () => {
    const fixture = await gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    const evidence = handoffEvidenceOf(fixture, fixture.planSha);

    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    const added = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [finding("r-crit", { severity: "critical" })] as never },
    });
    const critical = added.issues![0]!;

    // An unresolved critical blocks approval under the plan's cleanup mode —
    // read from the issue store, never from a register.
    const snapshotBefore = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.invalid-transition");
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");

    // The authorized disposition (a separate act, contract §4) releases the gate.
    const closed = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: closeOp(critical.issue_id, critical.revision) as never,
    });
    expect(closed.outcome).toBe("residual-closed");
    const handedOff = await handoffCall(fixture, evidence);
    expect(handedOff.outcome).toBe("handed-off");
  }, 30000);

  test("issue authority: a missing or staged store refuses the handoff instead of passing it as no findings", async () => {
    const fixture = await gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    const evidence = handoffEvidenceOf(fixture, fixture.planSha);
    const sessionId = readJson(fixture.planSession).session_id;

    // A staged store is the pre-activation exclusion window (contract §7): the
    // bytes exist, but the DB is not yet the findings authority, so the step
    // refuses rather than treating "no readable open issues" as "clean".
    const staged = await openStore({ harnessDir: fixture.harness }, "write");
    try {
      staged.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
    } finally {
      staged.close();
    }
    const snapshotBefore = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.store");
    // The refusal is non-advancing: the snapshot document, row status and the
    // lease this session holds are all untouched.
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    expect(leaseHolder(planRowOf(fixture, PLAN_ID))).toBe(sessionId);

    // A missing store is not an empty one either: the same step still refuses.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${join(fixture.harness, "store.db")}${suffix}`, { force: true });
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.store");
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    expect(leaseHolder(planRowOf(fixture, PLAN_ID))).toBe(sessionId);
  }, 30000);
});
describe("binding", () => {
  test("coordinator bind claims the lifecycle with a 0600 envelope and refuses a second holder", async () => {
    const fixture = makeFixture();

    const bound = await bindPlanSession({
      coordinator: true,
      workflowId: WORKFLOW_ID,
      harnessDir: fixture.harness,
      cwd: fixture.root,
      sessionId: FIXTURE_COORDINATOR_ID,
    });
    fixture.coordinatorSession = bound.session_file;

    expect(bound.operation).toBe("bind");
    expect(bound.outcome).toBe("bound");
    expect(bound.session_file).toBe(
      join(fixture.workflowDir, "sessions", `coordinator-${FIXTURE_COORDINATOR_ID}.json`),
    );
    expect(bound.session.role).toBe("coordinator");
    expect(bound.session.plan_id).toBeUndefined();
    expect(existsSync(fixture.coordinatorSession)).toBe(true);
    expect(statSync(fixture.coordinatorSession).mode & 0o777).toBe(0o600);
    const envelope = readJson(fixture.coordinatorSession);
    expect(Object.keys(envelope).sort()).toEqual(["harness_root", "role", "schema_version", "session_id", "workflow_id"]);
    expect(envelope.harness_root).toBe(fixture.harness);

    // The binding is durable in the snapshot, never copied into the envelope.
    const snapshot = readJson(fixture.snapshotPath);
    const coordination = snapshot.coordination as { coordinator?: { session_file?: string } };
    expect(coordination.coordinator?.session_file).toBe(fixture.coordinatorSession);

    // Same session file → read-only resume, no write at all.
    const snapshotBefore = readJson(fixture.snapshotPath);
    const resumed = await bindPlanSession({ resumePath: fixture.coordinatorSession, cwd: fixture.root });
    expect(resumed.outcome).toBe("resumed");
    expect(resumed.session.session_id).toBe(bound.session.session_id);
    expect(resumed.session_file).toBe(fixture.coordinatorSession);
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);

    // A second coordinator identity is refused and the binding is untouched.
    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          coordinator: true,
          workflowId: WORKFLOW_ID,
          harnessDir: fixture.harness,
          cwd: fixture.root,
          sessionId: "second-coordinator",
        }),
      ),
    ).toBe("coordination.duplicate-holder");
    const after = readJson(fixture.snapshotPath) as { coordination?: { coordinator?: { session_file?: string } } };
    expect(after.coordination?.coordinator?.session_file).toBe(fixture.coordinatorSession);
  });

  test("a plan session claims a prepared plan, resumes read-only, and refuses a second identity", async () => {
    const fixture = makeFixture();
    const prepared = await preparePlan(fixture, PLAN_ID);
    expect(prepared.outcome).toBe("prepared");

    const claimed = await bindPlan(fixture, PLAN_ID);
    expect(claimed.outcome).toBe("claimed");
    expect(claimed.session.role).toBe("plan-pm");
    expect(claimed.session.plan_id).toBe(PLAN_ID);

    const snapshot = readJson(fixture.snapshotPath);
    const row = (snapshot.plans as Array<Record<string, unknown>>)[0];
    expect(row.status).toBe("InProgress");
    const lease = row.execution_lease as Record<string, unknown>;
    expect(Object.values(lease)).toContain(claimed.session.session_id);
    expect(lease.worktree_path).toBe(fixture.worktreePath);
    expect(lease.working_branch).toBe("feature/plan-a");

    // Resume validates the persisted binding and re-acquires nothing.
    const snapshotBefore = readJson(fixture.snapshotPath);
    const resumed = await resumePlan(fixture, PLAN_ID);
    expect(resumed.outcome).toBe("resumed");
    expect(resumed.session.session_id).toBe(claimed.session.session_id);
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);

    // A second fresh bind cannot take over a held plan.
    expect(
      await errorCodeOf(() =>
        bindPlanSession({ scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness }, cwd: fixture.root }),
      ),
    ).toBe("coordination.duplicate-holder");

    // An unprepared plan cannot be bound at all.
    expect(await errorCodeOf(() => bindPlan(fixture, PEER_PLAN_ID))).toBe("coordination.not-prepared");
  });

  test("a caller-supplied session id is adopted as the identity and the envelope name on both bind paths", async () => {
    const fixture = makeFixture();
    const coordinatorId = "host-session-coordinator";
    const coordinated = await bindPlanSession({
      coordinator: true,
      workflowId: WORKFLOW_ID,
      harnessDir: fixture.harness,
      cwd: fixture.root,
      sessionId: coordinatorId,
    });
    fixture.coordinatorSession = coordinated.session_file;
    expect(coordinated.session.session_id).toBe(coordinatorId);
    expect(coordinated.session_file).toBe(join(fixture.workflowDir, "sessions", `coordinator-${coordinatorId}.json`));
    expect(readJson(coordinated.session_file).session_id).toBe(coordinatorId);
    const snapshot = readJson(fixture.snapshotPath);
    const coordination = snapshot.coordination as { coordinator?: { session_id?: string } };
    expect(coordination.coordinator?.session_id).toBe(coordinatorId);

    await preparePlan(fixture, PLAN_ID);
    const planSessionId = "host-session-plan";
    const claimed = await bindPlanSession({
      scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
      cwd: fixture.root,
      sessionId: planSessionId,
    });
    expect(claimed.outcome).toBe("claimed");
    expect(claimed.session.session_id).toBe(planSessionId);
    expect(claimed.session_file).toBe(join(fixture.workflowDir, "sessions", `plan-pm-${planSessionId}.json`));
    expect(readJson(claimed.session_file).session_id).toBe(planSessionId);
    // The identity is the one every later call is matched against: the row
    // records it as the binding and as the execution-lease holder.
    const row = planRowOf(fixture, PLAN_ID);
    const rowCoordination = row.coordination as { session?: { session_id?: string } };
    expect(rowCoordination.session?.session_id).toBe(planSessionId);
    expect(leaseHolder(row)).toBe(planSessionId);
  });

  test("one host identity backs both roles of one workflow: role-scoped envelopes, shared session_id, refusals intact", async () => {
    // A host injects one identity per host session, while a workflow still
    // needs two engine sessions (coordinator + plan-pm). The role prefixes the
    // envelope file name and nothing else: a sequential coordinator bind then
    // plan bind under one id both succeed, and each bind still refuses a
    // second holder.
    const fixture = makeFixture();
    const shared = "host-session-shared";
    const coordinated = await bindPlanSession({
      coordinator: true,
      workflowId: WORKFLOW_ID,
      harnessDir: fixture.harness,
      cwd: fixture.root,
      sessionId: shared,
    });
    fixture.coordinatorSession = coordinated.session_file;
    await preparePlan(fixture, PLAN_ID);
    const claimed = await bindPlanSession({
      scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
      cwd: fixture.root,
      sessionId: shared,
    });

    const coordinatorFile = join(fixture.workflowDir, "sessions", `coordinator-${shared}.json`);
    const planFile = join(fixture.workflowDir, "sessions", `plan-pm-${shared}.json`);
    expect(coordinated.outcome).toBe("bound");
    expect(claimed.outcome).toBe("claimed");
    expect(coordinated.session_file).toBe(coordinatorFile);
    expect(claimed.session_file).toBe(planFile);
    expect(coordinated.session_file).not.toBe(claimed.session_file);
    // Only the path is role-scoped; the identity stays the shared one.
    expect(coordinated.session.session_id).toBe(shared);
    expect(claimed.session.session_id).toBe(shared);
    expect(readJson(coordinatorFile)).toMatchObject({ role: "coordinator", session_id: shared });
    expect(readJson(planFile)).toMatchObject({ role: "plan-pm", session_id: shared });

    // The snapshot records each role's own envelope path.
    const snapshot = readJson(fixture.snapshotPath) as {
      coordination?: { coordinator?: { session_file?: string } };
    };
    expect(snapshot.coordination?.coordinator?.session_file).toBe(coordinatorFile);
    const row = planRowOf(fixture, PLAN_ID);
    const rowCoordination = row.coordination as { session?: { session_file?: string } };
    expect(rowCoordination.session?.session_file).toBe(planFile);
    expect(leaseHolder(row)).toBe(shared);

    // Two sessions under one id: neither role binds twice.
    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          coordinator: true,
          workflowId: WORKFLOW_ID,
          harnessDir: fixture.harness,
          cwd: fixture.root,
          sessionId: shared,
        }),
      ),
    ).toBe("coordination.duplicate-holder");
    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
          cwd: fixture.root,
          sessionId: shared,
        }),
      ),
    ).toBe("coordination.duplicate-holder");
  });

  test("an invalid supplied session id refuses before any write", async () => {
    // `../escape` would leave the sessions directory, `''`/`.` are not file
    // names, `a/b` adds a segment and 129 characters exceed the id contract.
    for (const bad of ["../escape", "", "a/b", ".", "a".repeat(129)]) {
      const fixture = makeFixture();
      const snapshotBefore = readJson(fixture.snapshotPath);
      expect(
        await errorCodeOf(() =>
          bindPlanSession({
            coordinator: true,
            workflowId: WORKFLOW_ID,
            harnessDir: fixture.harness,
            cwd: fixture.root,
            sessionId: bad,
          }),
        ),
      ).toBe("coordination.invalid-session-id");
      expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
      expect(existsSync(join(fixture.workflowDir, "sessions"))).toBe(false);
    }

    // The plan path shares the guard: the prepared row stays unclaimed and the
    // sessions directory keeps exactly the envelopes it already had.
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    const sessionsDir = join(fixture.workflowDir, "sessions");
    const envelopes = readdirSync(sessionsDir).sort();
    const snapshotBefore = readJson(fixture.snapshotPath);
    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
          cwd: fixture.root,
          sessionId: "a/b",
        }),
      ),
    ).toBe("coordination.invalid-session-id");
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    expect(readdirSync(sessionsDir).sort()).toEqual(envelopes);
  });

  test("prerequisite identity — an omitted coordinator id writes nothing, and a re-used one never overwrites an envelope", async () => {
    // A fresh coordinator bind never generates an identity: the engine refuses
    // before any write, so the workflow keeps no envelope and no sessions dir.
    const fixture = makeFixture();
    const snapshotBefore = readJson(fixture.snapshotPath);
    expect(
      await errorCodeOf(() =>
        bindPlanSession({ coordinator: true, workflowId: WORKFLOW_ID, harnessDir: fixture.harness, cwd: fixture.root }),
      ),
    ).toBe("coordination.identity-missing");
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    expect(existsSync(join(fixture.workflowDir, "sessions"))).toBe(false);

    // An envelope that already occupies the id's role-scoped path is never
    // replaced: the existing exclusive-create refusal reports it instead of
    // hijacking the identity.
    const fresh = makeFixture();
    const orphan = join(fresh.workflowDir, "sessions", "coordinator-host-session-orphan.json");
    writeText(orphan, '{"stray":true}\n');
    const freshBefore = readJson(fresh.snapshotPath);
    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          coordinator: true,
          workflowId: WORKFLOW_ID,
          harnessDir: fresh.harness,
          cwd: fresh.root,
          sessionId: "host-session-orphan",
        }),
      ),
    ).toBe("coordination.session-mismatch");
    expect(readJson(fresh.snapshotPath)).toEqual(freshBefore);
    // The occupant is untouched too: the refusal hijacks no identity.
    expect(readJson(orphan)).toEqual({ stray: true });
  });

  test("prerequisite identity — an explicit id is adopted, two same-workflow binds retain one owner, and a foreign root never inherits it", async () => {
    const fixture = makeFixture();
    const bound = await bindPlanSession({
      coordinator: true,
      workflowId: WORKFLOW_ID,
      harnessDir: fixture.harness,
      cwd: fixture.root,
      sessionId: "host-session-explicit",
    });
    expect(bound.outcome).toBe("bound");
    expect(bound.session.session_id).toBe("host-session-explicit");
    expect(readJson(fixture.snapshotPath).coordination).toMatchObject({
      coordinator: { session_id: "host-session-explicit" },
    });
    const snapshotBefore = readJson(fixture.snapshotPath);

    // One owner per workflow: a second fresh bind, even naming another id, is
    // refused and mutates nothing.
    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          coordinator: true,
          workflowId: WORKFLOW_ID,
          harnessDir: fixture.harness,
          cwd: fixture.root,
          sessionId: "host-session-other",
        }),
      ),
    ).toBe("coordination.duplicate-holder");
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);

    // A second control harness is isolated: the same session id binds a
    // *different* workflow there and writes nothing into the first root.
    const other = makeFixture();
    const foreign = await bindPlanSession({
      coordinator: true,
      workflowId: WORKFLOW_ID,
      harnessDir: other.harness,
      cwd: other.root,
      sessionId: "host-session-explicit",
    });
    expect(foreign.outcome).toBe("bound");
    expect(readJson(other.snapshotPath).coordination).toMatchObject({
      coordinator: { session_id: "host-session-explicit" },
    });
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
  });

  test("the operation surface is closed, role-scoped and never advertised to the wrong seat", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);

    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    // Coordinator-only mutations are refused from a plan session.
    for (const kind of ["accept", "return", "integration-start", "integration-accept", "complete", "reconcile"]) {
      expect(
        await errorCodeOf(() =>
          mutatePlanCoordination({
            sessionPath: fixture.planSession,
            planId: PLAN_ID,
            expectedRevision: view.revision,
            operation: { kind } as never,
          }),
        ),
      ).toBe("coordination.session-role");
    }
    // The row's own holder reaches the row admission and recognizes the
    // already-recorded semantic intent without another write.
    const holder = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
    });
    expect(holder.outcome).toBe("already-satisfied");
    // A plan-pm envelope that is NOT this row's holder keeps `session-role`.
    const outsider = join(fixture.workflowDir, "sessions", "plan-pm-outsider.json");
    writeJson(outsider, {
      schema_version: 1,
      role: "plan-pm",
      session_id: "outsider",
      workflow_id: WORKFLOW_ID,
      plan_id: PLAN_ID,
      harness_root: fixture.harness,
    });
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: outsider,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
        }),
      ),
    ).toBe("coordination.session-role");
    // `handoff` is implemented: it refuses its own missing evidence, not the slice boundary.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.planSession,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: { kind: "handoff" } as never,
        }),
      ),
    ).toBe("coordination.invalid-input");
    // A precondition on the operation itself is refused: it belongs to the request.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.planSession,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: { kind: "progress", expectedRevision: view.revision } as never,
        }),
      ),
    ).toBe("coordination.invalid-input");
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.planSession,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: { kind: "nonsense" } as never,
        }),
      ),
    ).toBe("coordination.unknown-operation");

    // A coordinator view of an *unprepared* row is where first preparation is reachable.
    const coordinatorView = await readPlanCoordination(fixture.coordinatorSession, PEER_PLAN_ID, fixture.root);
    expect(coordinatorView.allowed_operations).toEqual(["prepare"]);
    expect(coordinatorView.scope).toBeNull();
  });
});
describe("historical coordination snapshots", () => {
  test("accepts stored self-amendment audit history without validating retired digest gates", () => {
    const result = validateSnapshotCoordination({
      coordinator: {
        session_id: "coordinator-1",
        session_file: "/tmp/coordinator.json",
        bound_at: "2026-10-03T00:00:00.000Z",
      },
      self_amendments: [{ old_sha256: "a".repeat(64), new_sha256: "b".repeat(64) }],
    });

    expect(result).toEqual([]);
  });
});
describe("scope-and-revisions", () => {
  test("both address forms resolve to the same pinned scope", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);

    const fromPair = await resolvePlanScope({ workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness }, fixture.root);
    const fromAssignment = await resolvePlanScope({ assignmentPath: fixture.assignmentPath }, fixture.root);

    expect(fromAssignment).toEqual(fromPair);
    expect(fromPair.harnessRoot).toBe(fixture.harness);
    expect(fromPair.workflowId).toBe(WORKFLOW_ID);
    expect(fromPair.planId).toBe(PLAN_ID);
    expect(fromPair.projectId).toBe(PROJECT_ID);
    expect(fromPair.planPath).toBe(fixture.planPath);
    expect(fromPair.worktreePath).toBe(fixture.worktreePath);
    expect(fromPair.workingBranch).toBe("feature/plan-a");
    expect(fromPair.sddDir).toBe(fixture.sddDir);

    // An unscoped Assignment (no `Prepare gate`, no plan pin) is refused.
    const unscoped = join(fixture.root, "unscoped-assignment.md");
    writeText(unscoped, "# Assignment — legacy\n\n**Workflow id**: wf-plana\n");
    expect(await errorCodeOf(() => resolvePlanScope({ assignmentPath: unscoped }, fixture.root))).toBe("coordination.assignment-invalid");
  });

  test("prepare pins the Assignment with its semantic projection, not a byte gate", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);

    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(view.prepared?.assignment_path).toBe(fixture.assignmentPath);
    expect(view.prepared?.qa_gate).toBe("mandatory");
    expect(view.prepared?.findings_cleanup).toBe("zero-residual");
    expect(view.revision).toBe(2); // prepare bumped it to 1, the fresh bind to 2
    expect(view.scope?.planPath).toBe(fixture.planPath);
    // The projection records reviewed intent; document digests remain provenance.
    expect(view.prepared?.assignment_intent).toEqual({
      execution_scope: "plan",
      execute_as: "project-manager",
      delegation: "allowed (plan-local subagents only)",
      control_harness_root: fixture.harness,
      workflow_id: WORKFLOW_ID,
      plan_id: PLAN_ID,
      plan_path: fixture.planPath,
      worktree_path: fixture.worktreePath,
      working_branch: "feature/plan-a",
      sdd_dir: fixture.sddDir,
      qa_gate: "mandatory",
      findings_cleanup: "zero-residual",
      prepare_gate: "go",
    });
  });

  test("a sparse intent omitting the session envelope and the revision reaches the same result (A02)", async () => {
    // § One resolver path (S2/E02): a caller that states neither `sessionPath`
    // nor `expectedRevision` names only its acquired identity, the plan it
    // addresses and the operation. The engine resolves the trusted root, the
    // addressed target and that identity's OWN envelope, and derives the
    // revision from the row — reaching exactly the result the fully specified
    // form reaches, with no invented revision and therefore no drift warning.
    const specified = makeFixture();
    await preparePlan(specified, PLAN_ID);
    await bindPlan(specified, PLAN_ID);
    const specifiedEvidence = join(specified.sddDir, "evidence.txt");
    writeText(specifiedEvidence, "proof\n");
    const specifiedView = await readPlanCoordination(specified.planSession, PLAN_ID, specified.root);
    const specifiedResult = await mutatePlanCoordination({
      sessionPath: specified.planSession,
      planId: PLAN_ID,
      expectedRevision: specifiedView.revision,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [specifiedEvidence] } },
    });

    const sparse = makeFixture();
    await preparePlan(sparse, PLAN_ID);
    await bindPlan(sparse, PLAN_ID);
    const sparseEvidence = join(sparse.sddDir, "evidence.txt");
    writeText(sparseEvidence, "proof\n");
    const envelope = readSessionEnvelope(sparse.planSession);
    const sparseResult = await mutatePlanCoordination({
      cwd: sparse.root,
      identity: {
        source: "local",
        sessionId: envelope.session_id,
        workflowId: envelope.workflow_id,
        role: "plan-pm",
        planId: PLAN_ID,
      },
      planId: PLAN_ID,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [sparseEvidence] } },
    });

    expect(sparseResult.session_file).toBe(sparse.planSession);
    expect(sparseResult.outcome).toBe(specifiedResult.outcome);
    expect(sparseResult.recovery?.outcome).toBe(specifiedResult.recovery?.outcome);
    expect(sparseResult.recovery?.warnings).toEqual([]);
    expect(sparseResult.view?.revision).toBe(specifiedResult.view?.revision);
    expect(sparseResult.view?.row.status).toBe("InProgress");

    // The association is what the engine resolves the session from: with no
    // envelope AND no identity there is nothing to authenticate, so the call
    // refuses with that problem instead of selecting a bound session.
    const unassociated = makeFixture();
    await preparePlan(unassociated, PLAN_ID);
    await bindPlan(unassociated, PLAN_ID);
    const before = await readPlanCoordination(unassociated.planSession, PLAN_ID, unassociated.root);
    const unassociatedFailure = await failureOf(() =>
      mutatePlanCoordination({
        cwd: unassociated.root,
        planId: PLAN_ID,
        operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [] } },
      }),
    );

    // Narrow once, for the assertions below: `failureOf` hands back the thrown value.
    const refusal = unassociatedFailure as CoordinationError;
    expect(refusal).toBeInstanceOf(CoordinationError);
    expect(refusal.code).toBe("coordination.invalid-input");
    const recovery = refusal.details.recovery as RecoveryDetails;
    expect(recovery.unresolved[0]?.needed).toBe("the session this call runs under");
    expect((await readPlanCoordination(unassociated.planSession, PLAN_ID, unassociated.root)).revision).toBe(before.revision);
  });

  test("progress is admission-checked: evidence-scoped and transition-guarded", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);

    const evidence = join(fixture.sddDir, "evidence.txt");
    writeText(evidence, "proof\n");
    const outside = join(fixture.root, "outside.txt");
    writeText(outside, "not mine\n");
    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);

    // Evidence outside the plan's own plan/SDD area is refused.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [outside] }},
    }),
      ),
    ).toBe("coordination.path-mismatch");

    // Missing evidence is refused.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [join(fixture.sddDir, "gone.txt")] }},
    }),
      ),
    ).toBe("coordination.invalid-input");

    const progressed = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: {
        kind: "progress",
        progress: { status: "InReview", summary: "slice A implemented", evidence_paths: [evidence], track_branches: ["feature/plan-a"] } },
    });
    expect(progressed.outcome).toBe("progressed");
    const after = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(after.row.status).toBe("InReview");
    expect(after.revision).toBe(3); // prepare 1, fresh bind 2, progress 3
    const metadata = after.row.metadata as Record<string, unknown>;
    expect(metadata.track_branches).toEqual(["feature/plan-a"]);

    // The track branch may never be a snapshot branch or another plan's branch.
    for (const foreign of ["main", "feature/plan-b"]) {
      expect(
        await errorCodeOf(() =>
          mutatePlanCoordination({
            sessionPath: fixture.planSession,
            planId: PLAN_ID,
            expectedRevision: after.revision,
            operation: {
              kind: "progress",
              progress: { status: "Blocked", summary: "blocked", evidence_paths: [evidence], track_branches: [foreign] },
            },
          }),
        ),
        foreign,
      ).toBe("coordination.invalid-input");
    }

    const blocked = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: after.revision,
      operation: { kind: "progress", progress: { status: "Blocked", summary: "waiting on QC", evidence_paths: [evidence] }},
    });
    expect(blocked.outcome).toBe("progressed");
    const blockedView = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(blockedView.row.status).toBe("Blocked");
    // Blocked → InReview is not an allowed transition (Blocked resumes to InProgress).
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: blockedView.revision,
      operation: { kind: "progress", progress: { status: "InReview", summary: "resume out of order", evidence_paths: [evidence] }},
    }),
      ),
    ).toBe("coordination.progress-transition");
  });

  test("a plan session can only address its own plan", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);

    expect(await errorCodeOf(() => readPlanCoordination(fixture.planSession, PEER_PLAN_ID, fixture.root))).toBe(
      "coordination.session-mismatch",
    );

    // A session file that is not an envelope at all is refused.
    const stray = join(fixture.root, "stray.json");
    writeJson(stray, { hello: "world" });
    expect(await errorCodeOf(() => readPlanCoordination(stray, PLAN_ID, fixture.root))).toBe("coordination.forbidden-field");
  });
});

describe("issue-authority — scoped plan issue operations (G2a)", () => {
  test("issue authority: residual-add captures issues in the store and links the plan; no register is written", async () => {
    const fixture = await gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await preparePlan(fixture, PEER_PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    await bindPlan(fixture, PEER_PLAN_ID);

    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    const added = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [finding("r-1"), finding("r-2")] as never },
    });
    expect(added.outcome).toBe("residual-added");
    // The IDs are DB-allocated, so the writer reports them (`created: true`) —
    // the caller cannot guess them the way it supplied the register entry ids.
    expect(added.issues).toEqual([
      { issue_id: "I-000001", revision: 2, created: true },
      { issue_id: "I-000002", revision: 2, created: true },
    ]);

    // The DB is the only mutation target: the issues exist, are linked to THIS
    // plan only, and no legacy register file was created anywhere.
    const open = await linkedOpenIssues(fixture, PLAN_ID);
    expect(open.map((issue) => issue.id)).toEqual(["I-000001", "I-000002"]);
    expect(existsSync(fixture.registerPath)).toBe(false);
    const peerView = await readPlanCoordination(fixture.peerSession, PEER_PLAN_ID, fixture.root);
    // No register byte version exists any more: the view reports the row's own
    // revision and the snapshot version only.
    expect("register_version" in peerView).toBe(false);
    expect(await linkedOpenIssues(fixture, PEER_PLAN_ID)).toEqual([]);
  });

  test("issue authority: two independent processes capturing concurrently both land in the store", async () => {
    const fixture = await gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await preparePlan(fixture, PEER_PLAN_ID);
    const sessionA = (await bindPlan(fixture, PLAN_ID)).session_file;
    const sessionB = (await bindPlan(fixture, PEER_PLAN_ID)).session_file;

    const script = join(fixture.root, "child-add.ts");
    writeText(
      script,
      [
        `import { bindPlanSession, mutatePlanCoordination, readPlanCoordination } from ${JSON.stringify(
          join(import.meta.dir, "..", "src", "coordination.ts"),
        )};`,
        "const [root, planId, sessionPath, occurrenceKey] = process.argv.slice(2);",
        "const resumed = await bindPlanSession({ resumePath: sessionPath, cwd: root });",
        "if (resumed.outcome !== \"resumed\") throw new Error(`bad resume: ${resumed.outcome}`);",
        "for (let attempt = 0; attempt < 8; attempt += 1) {",
        "  const view = await readPlanCoordination(sessionPath, planId, root);",
        "  try {",
        "    await mutatePlanCoordination({",
        "      sessionPath,",
        "      planId,",
        "      expectedRevision: view.revision,",
        "      operation: {",
        "        kind: \"residual-add\",",
        "        entries: [{ title: occurrenceKey, kind: \"review-obligation\", severity: \"low\", impact: \"i\", acceptance: \"a\", sourceIdentity: `qc:${occurrenceKey}`, rootCauseKey: `rc:${occurrenceKey}`, acceptanceKey: \"fix\", occurrenceKey, sourceKind: \"qc-report\", location: \"engine\", observedBehavior: \"observed\", evidence: [], discoveredAt: \"2026-09-18T00:00:00Z\" }] as never,",
        "      },",
        "    });",
        "    console.log(`added ${occurrenceKey}`);",
        "    process.exit(0);",
        "  } catch (error) {",
        "    if (error && (error.code === \"store.busy\" || error.code === \"coordination.version-conflict\")) continue;",
        "    console.error(error);",
        "    process.exit(2);",
        "  }",
        "}",
        "console.error(\"exhausted retries\");",
        "process.exit(3);",
        "",
      ].join("\n"),
    );

    await sealStoreForReaders(fixture);
    const children = [
      { planId: PLAN_ID, sessionPath: sessionA, occurrenceKey: "occ-a" },
      { planId: PEER_PLAN_ID, sessionPath: sessionB, occurrenceKey: "occ-b" },
    ].map((child) =>
      Bun.spawn([process.execPath, script, fixture.root, child.planId, child.sessionPath, child.occurrenceKey], {
        cwd: fixture.root,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    const exits = await Promise.all(children.map((child) => child.exited));
    for (const child of children) {
      const message = await new Response(child.stderr).text();
      if (child.exitCode !== 0) console.error(`child ${String(child.pid)}: ${message}`);
      expect(child.exitCode, message).toBe(0);
    }

    // SQLite serialized the two writers: both captures survive with no lost
    // update, exactly one issue per plan (ids may land in either order).
    const planIssues = await linkedOpenIssues(fixture, PLAN_ID);
    const peerIssues = await linkedOpenIssues(fixture, PEER_PLAN_ID);
    expect(planIssues).toHaveLength(1);
    expect(peerIssues).toHaveLength(1);
    expect([planIssues[0]!.id, peerIssues[0]!.id].sort()).toEqual(["I-000001", "I-000002"]);
    expect(existsSync(fixture.registerPath)).toBe(false);
  });

  test("issue authority: residual-close mutates the DB under the issue revision; stale or foreign scope refuses", async () => {
    const fixture = await gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await preparePlan(fixture, PEER_PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    await bindPlan(fixture, PEER_PLAN_ID);

    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    const added = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [finding("r-1"), finding("r-2")] as never },
    });
    const second = added.issues![1]!;

    // A stale issue revision is a visible refusal: nothing is closed.
    const staleCode = await errorCodeOf(() =>
      mutatePlanCoordination({
        sessionPath: fixture.planSession,
        planId: PLAN_ID,
        expectedRevision: view.revision,
        operation: closeOp(second.issue_id, second.revision + 7) as never,
      }),
    );
    expect(staleCode).toBe("issue.revision-conflict");
    expect((await linkedOpenIssues(fixture, PLAN_ID)).map((issue) => issue.id)).toEqual(["I-000001", "I-000002"]);

    // The authorized close uses the issue revision the add reported.
    const closed = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: closeOp(second.issue_id, second.revision) as never,
    });
    expect(closed.outcome).toBe("residual-closed");
    expect(existsSync(fixture.registerPath)).toBe(false);
    const open = await linkedOpenIssues(fixture, PLAN_ID);
    expect(open.map((issue) => issue.id)).toEqual(["I-000001"]);

    // An exact replay of the close is idempotent, not a second transition
    // (contract §4): the same operation id and input return the same result.
    const replayed = await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: closeOp(second.issue_id, second.revision) as never,
    });
    expect(replayed.outcome).toBe("residual-closed");
    expect((await linkedOpenIssues(fixture, PLAN_ID)).map((issue) => issue.id)).toEqual(["I-000001"]);

    // A different terminal attempt for the same issue reuses the deterministic
    // operation id with different input, so the core refuses the operation
    // instead of re-dispositioning an already-closed issue.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.planSession,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: closeOp(second.issue_id, second.revision + 1) as never,
        }),
      ),
    ).toBe("store.operation-conflict");

    // A plan session cannot close an issue linked to another plan: the refusal
    // surfaces the issue contract's stable scope code, not a coordination code.
    const peerView = await readPlanCoordination(fixture.peerSession, PEER_PLAN_ID, fixture.root);
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.peerSession,
          planId: PEER_PLAN_ID,
          expectedRevision: peerView.revision,
          operation: closeOp("I-000001", 2) as never,
        }),
      ),
    ).toBe("issue.scope-refused");
  });
});
