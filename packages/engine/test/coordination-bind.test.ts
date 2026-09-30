// Engine scoped-plan coordination — bind, admission, scope/revisions and issue-authority families
// (including the findings-gate issue-authority cases).
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join, sep } from "node:path";
import {
  EXECUTION_PIN_CONFLICT_CODE,
  bindPlanSession,
  setBindPreInterleaveForTest,
  mutatePlanCoordination,
  readCoordinatedArtifact,
  readPlanCoordination,
  recoverPrepareCoordinator,
  replaceCoordinatedArtifact,
  resolvePlanScope,
  showPrepareCoordinatorRecovery,
  type CoordinationResult,
  type PlanCoordinationView,
  type PrepareCoordinatorRecoveryView,
} from "../src/coordination.js";
import { updateCatalogEntity } from "../src/catalog.js";
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
  type Fixture, git, writeText, writeJson, readJson, makeFixture, errorCodeOf,
  ensureCoordinator, preparePlan, bindPlan, resumePlan,
  gitFixture, snapshotOf, planRowOf, updatePlanRow, claimExecutionLease, leaseHolder,
  handoffEvidenceOf, sha256OfFile, handoffCall, sealStoreForReaders, afterEachCleanup, finding, linkedOpenIssues,
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
    const before = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.invalid-transition");
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
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
    const before = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.store");
    // The refusal is non-advancing: snapshot bytes, row status and the lease
    // this session holds are all untouched.
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    expect(leaseHolder(planRowOf(fixture, PLAN_ID))).toBe(sessionId);

    // A missing store is not an empty one either: the same step still refuses.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${join(fixture.harness, "store.db")}${suffix}`, { force: true });
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.store");
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
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
    const bytesBefore = readFileSync(fixture.snapshotPath, "utf8");
    const resumed = await bindPlanSession({ resumePath: fixture.coordinatorSession, cwd: fixture.root });
    expect(resumed.outcome).toBe("resumed");
    expect(resumed.session.session_id).toBe(bound.session.session_id);
    expect(resumed.session_file).toBe(fixture.coordinatorSession);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(bytesBefore);

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
    const bytesBefore = readFileSync(fixture.snapshotPath, "utf8");
    const resumed = await resumePlan(fixture, PLAN_ID);
    expect(resumed.outcome).toBe("resumed");
    expect(resumed.session.session_id).toBe(claimed.session.session_id);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(bytesBefore);

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
      const before = readFileSync(fixture.snapshotPath, "utf8");
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
      expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before);
      expect(existsSync(join(fixture.workflowDir, "sessions"))).toBe(false);
    }

    // The plan path shares the guard: the prepared row stays unclaimed and the
    // sessions directory keeps exactly the envelopes it already had.
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    const sessionsDir = join(fixture.workflowDir, "sessions");
    const envelopes = readdirSync(sessionsDir).sort();
    const before = readFileSync(fixture.snapshotPath, "utf8");
    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
          cwd: fixture.root,
          sessionId: "a/b",
        }),
      ),
    ).toBe("coordination.invalid-session-id");
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before);
    expect(readdirSync(sessionsDir).sort()).toEqual(envelopes);
  });

  test("prerequisite identity — an omitted coordinator id writes nothing, and a re-used one never overwrites an envelope", async () => {
    // A fresh coordinator bind never generates an identity: the engine refuses
    // before any write, so the workflow keeps no envelope and no sessions dir.
    const fixture = makeFixture();
    const before = readFileSync(fixture.snapshotPath, "utf8");
    expect(
      await errorCodeOf(() =>
        bindPlanSession({ coordinator: true, workflowId: WORKFLOW_ID, harnessDir: fixture.harness, cwd: fixture.root }),
      ),
    ).toBe("coordination.identity-missing");
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before);
    expect(existsSync(join(fixture.workflowDir, "sessions"))).toBe(false);

    // An envelope that already occupies the id's role-scoped path is never
    // replaced: the existing exclusive-create refusal reports it instead of
    // hijacking the identity.
    const fresh = makeFixture();
    const orphan = join(fresh.workflowDir, "sessions", "coordinator-host-session-orphan.json");
    writeText(orphan, '{"stray":true}\n');
    const freshBefore = readFileSync(fresh.snapshotPath, "utf8");
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
    expect(readFileSync(orphan, "utf8")).toBe('{"stray":true}\n');
    expect(readFileSync(fresh.snapshotPath, "utf8")).toBe(freshBefore);
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
    const bytesBefore = readFileSync(fixture.snapshotPath, "utf8");

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
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(bytesBefore);

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
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(bytesBefore);
  });

  test("the operation surface is closed, role-scoped and never advertised to the wrong seat", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);

    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect([...view.allowed_operations].sort()).toEqual(["handoff", "progress", "residual-add", "residual-close"]);
    // Every coordinator verb exists now; none is reachable — or advertised —
    // from a plan session. `prepare` is the one verb with a plan-session seat
    // (the session the addressed ROW is bound to, fixes #308), and that seat is
    // decided against the row inside the lock: on this already-prepared row no
    // plan-pm envelope may re-prepare it, and a session that is not the row's
    // holder keeps the seat refusal.
    for (const kind of ["accept", "return", "integration-start", "integration-accept", "complete", "reconcile"]) {
      expect(view.allowed_operations).not.toContain(kind);
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
    expect(view.allowed_operations).not.toContain("prepare");
    // The row's own holder reaches the row admission, which refuses the seal
    // it already has — never a second prepare, and never a seat refusal now
    // that the seat is lawful (spec §D3).
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.planSession,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
        }),
      ),
    ).toBe("coordination.prepare-already-prepared");
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
describe("admission self-claim and orphan adoption", () => {
  /** The plan row's own `coordination` block, or `{}` when it carries none. */
  function planCoordinationOf(fixture: Fixture, planId: string): Record<string, unknown> {
    const row = planRowOf(fixture, planId);
    return (row.coordination ?? {}) as Record<string, unknown>;
  }

  /** The snapshot-level self-amendment audit the coordinator reads post hoc. */
  function selfAmendmentAudit(fixture: Fixture): Array<Record<string, unknown>> {
    const coordination = snapshotOf(fixture).coordination as { self_amendments?: Array<Record<string, unknown>> } | undefined;
    return coordination?.self_amendments ?? [];
  }

  /** Append a marker to the plan's Assignment, changing its bytes and its hash. */
  function editAssignment(fixture: Fixture, marker: string): void {
    writeText(fixture.assignmentPath, `${readFileSync(fixture.assignmentPath, "utf8")}\n${marker}\n`);
  }

  test("an orphan prepared row with a drifted Assignment is adopted at bind, with one audited amendment", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    const pinned = String((planCoordinationOf(fixture, PLAN_ID).prepared as Record<string, unknown>).assignment_sha256);
    editAssignment(fixture, "Slice A, revised by the operator.");
    const current = sha256OfFile(fixture.assignmentPath);

    const bound = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "orphan-adopter",
    });

    expect(bound.outcome).toBe("claimed");
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("InProgress");
    expect((row.execution_lease as Record<string, unknown>).holder).toBe("orphan-adopter");
    // The pin moved to the bytes the bind actually accepted.
    expect((planCoordinationOf(fixture, PLAN_ID).prepared as Record<string, unknown>).assignment_sha256).toBe(current);

    const audit = selfAmendmentAudit(fixture);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      session_id: "orphan-adopter",
      old_sha256: pinned,
      new_sha256: current,
      prepared_by_matches: false,
    });
    expect(typeof audit[0].at).toBe("string");
    expect(audit[0].operation_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a self re-bind takes the same stale-adopt exit, annotated with the matching preparer", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    editAssignment(fixture, "Slice A, self-edited.");
    const current = sha256OfFile(fixture.assignmentPath);

    // The host identity that prepared is the one that binds: one session id may
    // back both role-scoped envelopes of a workflow.
    const bound = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: FIXTURE_COORDINATOR_ID,
    });

    expect(bound.outcome).toBe("claimed");
    const audit = selfAmendmentAudit(fixture);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      session_id: FIXTURE_COORDINATOR_ID,
      new_sha256: current,
      prepared_by_matches: true,
    });
  });

  test("a prepared row somebody holds keeps the terminal refusal when its Assignment drifts", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    const before = planRowOf(fixture, PLAN_ID);
    const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");
    editAssignment(fixture, "held-edit.");

    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          scope: { assignmentPath: fixture.assignmentPath },
          cwd: fixture.root,
          sessionId: "second-adopter",
        }),
      ),
    ).toBe("coordination.assignment-stale");

    // Terminal means terminal: the pin, the row and the audit are untouched.
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID)).toEqual(before);
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
  });

  test("a fresh orphan binds without any amendment (regression)", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);

    const bound = await bindPlanSession({
      scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
      cwd: fixture.root,
    });

    expect(bound.outcome).toBe("claimed");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InProgress");
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
  });

  test("the locator-addressed bind claims an unprepared row with no lease and no coordinator seat", async () => {
    const fixture = makeFixture();

    const bound = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });

    expect(bound.outcome).toBe("claim-bootstrapped");
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("Todo");
    expect(row.execution_lease).toBeUndefined();
    expect(planCoordinationOf(fixture, PLAN_ID).session).toMatchObject({ session_id: "claimant" });
    expect(existsSync(bound.session_file)).toBe(true);
    expect(readJson(bound.session_file).session_id).toBe("claimant");
    // The view is the unprepared-row shape `show` returns: revision, no scope.
    expect(bound.view?.scope).toBeNull();
    expect(bound.view?.revision).toBe(1);
  });

  test("an addressed Assignment that does not exist refuses before any write", async () => {
    const fixture = makeFixture();
    const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");

    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          scope: { assignmentPath: join(fixture.root, "no-such-assignment.md") },
          cwd: fixture.root,
          sessionId: "claimant",
        }),
      ),
    ).toBe("coordination.assignment-invalid");

    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("Todo");
  });

  test("a second claim on the claimed row is a duplicate holder", async () => {
    const fixture = makeFixture();
    await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });

    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          scope: { assignmentPath: fixture.assignmentPath },
          cwd: fixture.root,
          sessionId: "second-claimant",
        }),
      ),
    ).toBe("coordination.duplicate-holder");
  });

  test("the row's bound claimant prepares it, then the same session binds to claim the lease", async () => {
    const fixture = makeFixture();
    const claim = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });

    // The claimant's own read: the row is its to prepare, and nothing else yet.
    const claimView = await readPlanCoordination(claim.session_file, PLAN_ID, fixture.root);
    expect(claimView.scope).toBeNull();
    expect(claimView.allowed_operations).toEqual(["prepare"]);

    const prepared = await mutatePlanCoordination({
      sessionPath: claim.session_file,
      planId: PLAN_ID,
      expectedRevision: claimView.revision,
      operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
    });
    expect(prepared.outcome).toBe("prepared");
    expect((planCoordinationOf(fixture, PLAN_ID).prepared as Record<string, unknown>).prepared_by).toBe("claimant");

    // §D3: the same claimant cannot seal the row a second time.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: claim.session_file,
          planId: PLAN_ID,
          expectedRevision: prepared.view?.revision ?? claimView.revision,
          operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
        }),
      ),
    ).toBe("coordination.prepare-already-prepared");

    // §D/§D4 the prepared-but-unleased window advertises NO lease-gated
    // operation: identity is not ownership, and the mutation guards require the
    // execution lease the claim deliberately does not hold yet.
    const unleased = await readPlanCoordination(claim.session_file, PLAN_ID, fixture.root);
    expect(unleased.scope).not.toBeNull();
    expect(unleased.allowed_operations).toEqual([]);

    // §D0/D4 the claim's own continuation: same session, same envelope, lease.
    const bound = await bindPlanSession({
      scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
      cwd: fixture.root,
      sessionId: "claimant",
    });
    expect(bound.outcome).toBe("claimed");
    expect(bound.session_file).toBe(claim.session_file);
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("InProgress");
    expect((row.execution_lease as Record<string, unknown>).holder).toBe("claimant");
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
  });

  test("a foreign plan session cannot prepare the claimed row", async () => {
    const fixture = makeFixture();
    const coordinator = await ensureCoordinator(fixture);
    await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });
    // A plan-pm envelope that addresses the same plan under a different session
    // id: not the row's holder, so the coordinator-only refusal stands.
    const foreign = join(fixture.workflowDir, "sessions", "plan-pm-foreign-session.json");
    writeJson(foreign, {
      schema_version: 1,
      role: "plan-pm",
      session_id: "foreign-session",
      workflow_id: WORKFLOW_ID,
      plan_id: PLAN_ID,
      harness_root: fixture.harness,
    });
    const revision = (await readPlanCoordination(coordinator, PLAN_ID, fixture.root)).revision;

    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: foreign,
          planId: PLAN_ID,
          expectedRevision: revision,
          operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
        }),
      ),
    ).toBe("coordination.session-role");
    expect(planCoordinationOf(fixture, PLAN_ID).prepared).toBeUndefined();
  });

  test("the amendment validator refuses a record that describes no move", () => {
    const entry = {
      at: "2026-09-29T00:00:00Z",
      session_id: "adopter",
      old_sha256: "a".repeat(64),
      new_sha256: "b".repeat(64),
      operation_id: "c".repeat(64),
    };
    const coordination = { coordinator: { session_id: "s", session_file: "/tmp/s.json", bound_at: "2026-09-29T00:00:00Z" } };
    expect(validateSnapshotCoordination({ ...coordination, self_amendments: [entry] })).toEqual([]);
    const sameDigests = validateSnapshotCoordination({
      ...coordination,
      self_amendments: [{ ...entry, new_sha256: entry.old_sha256 }],
    });
    expect(sameDigests.map((violation) => violation.code)).toContain("coordination.amendment.hash");
  });

  test("the amendment validator accepts the optional plan-half pair only as a pair that records a move", () => {
    const entry = {
      at: "2026-09-29T00:00:00Z",
      session_id: "adopter",
      old_sha256: "a".repeat(64),
      new_sha256: "b".repeat(64),
      operation_id: "c".repeat(64),
    };
    const coordination = { coordinator: { session_id: "s", session_file: "/tmp/s.json", bound_at: "2026-09-29T00:00:00Z" } };
    const withPlan = (entry: Record<string, unknown>, plan: Record<string, unknown>) =>
      validateSnapshotCoordination({ ...coordination, self_amendments: [{ ...entry, ...plan }] });

    // A complete pair of differing digests: the two-half adoption.
    expect(withPlan(entry, { plan_old_sha256: "d".repeat(64), plan_new_sha256: "e".repeat(64) })).toEqual([]);
    // Half a pair, a non-hex half and a pair that records no move are each malformed.
    for (const plan of [
      { plan_old_sha256: "d".repeat(64) },
      { plan_new_sha256: "e".repeat(64) },
      { plan_old_sha256: "D".repeat(64), plan_new_sha256: "e".repeat(64) },
      { plan_old_sha256: "d".repeat(63), plan_new_sha256: "e".repeat(64) },
      { plan_old_sha256: "d".repeat(64), plan_new_sha256: "d".repeat(64) },
    ]) {
      expect({ plan, codes: withPlan(entry, plan).map((violation) => violation.code) }).toEqual({
        plan,
        codes: ["coordination.amendment.hash"],
      });
    }
  });

  test("a bind addressing a divergent Assignment copy is refused by the prepared-path resolver", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    await preparePlan(fixture, PLAN_ID);
    // A second copy of the same contract with different bytes, addressed
    // directly. The refusal is the PREPARED-PATH RESOLVER's (`scopeFromAssignment`
    // refuses a prepared row addressed by another path, for both bind forms) —
    // it is pinned here because it is the user-visible boundary that keeps one
    // path and one hash; the adopt helper itself is path-blind by design.
    const copy = join(fixture.root, "assignment-copy.md");
    writeText(copy, `${readFileSync(fixture.assignmentPath, "utf8")}\ndivergent copy.\n`);
    const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");

    expect(
      await errorCodeOf(() => bindPlanSession({ scope: { assignmentPath: copy }, cwd: fixture.root, sessionId: "copy-adopter" })),
    ).toBe("coordination.scope-mismatch");

    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
  });

  test("a drift that keeps the gates is adopted; one that changes a gate is terminal", async () => {
    // Byte-level drift with identical gates: adopted (PR #309-1's accepted half).
    const comment = makeFixture();
    await ensureCoordinator(comment);
    await preparePlan(comment, PLAN_ID);
    editAssignment(comment, "<!-- reviewed: still the same contract -->");
    const adopted = await bindPlanSession({
      scope: { assignmentPath: comment.assignmentPath },
      cwd: comment.root,
      sessionId: "comment-adopter",
    });
    expect(adopted.outcome).toBe("claimed");
    expect(selfAmendmentAudit(comment)).toHaveLength(1);

    // The same drift PLUS a changed contract header: terminal, nothing written.
    const changed = makeFixture();
    await ensureCoordinator(changed);
    await preparePlan(changed, PLAN_ID);
    writeText(
      changed.assignmentPath,
      readFileSync(changed.assignmentPath, "utf8").replace("**QA gate**: mandatory", "**QA gate**: pm-acceptance"),
    );
    const before = planRowOf(changed, PLAN_ID);
    const snapshotBefore = readFileSync(changed.snapshotPath, "utf8");
    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          scope: { assignmentPath: changed.assignmentPath },
          cwd: changed.root,
          sessionId: "gate-adopter",
        }),
      ),
    ).toBe("coordination.assignment-stale");
    expect(readFileSync(changed.snapshotPath, "utf8")).toBe(snapshotBefore);
    expect(planRowOf(changed, PLAN_ID)).toEqual(before);
    expect(selfAmendmentAudit(changed)).toHaveLength(0);
  });

  test("a continuing bind restores a missing recorded envelope instead of binding a gone file", async () => {
    const fixture = makeFixture();
    const claim = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });
    // The claimant prepared the row it claimed (the state the continuing bind
    // completes), and THEN its envelope is lost — a crash between prepare and
    // the bind that claims the lease.
    const claimView = await readPlanCoordination(claim.session_file, PLAN_ID, fixture.root);
    await mutatePlanCoordination({
      sessionPath: claim.session_file,
      planId: PLAN_ID,
      expectedRevision: claimView.revision,
      operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
    });
    rmSync(claim.session_file, { force: true });
    expect(existsSync(claim.session_file)).toBe(false);

    const bound = await bindPlanSession({
      scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
      cwd: fixture.root,
      sessionId: "claimant",
    });

    expect(bound.outcome).toBe("claimed");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InProgress");
    // The row records a file that EXISTS and holds the recorded session.
    expect(existsSync(bound.session_file)).toBe(true);
    expect(readJson(bound.session_file).session_id).toBe("claimant");
    const binding = planCoordinationOf(fixture, PLAN_ID).session as Record<string, unknown>;
    expect(existsSync(String(binding.session_file))).toBe(true);
    expect(binding.session_id).toBe("claimant");
  });

  test("a claim is idempotent for the recorded holder and refuses any other id", async () => {
    const fixture = makeFixture();
    const claim = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });
    const before = planRowOf(fixture, PLAN_ID);
    const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");

    // The recorded id re-claims: the binding stands, nothing advances.
    const again = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });
    expect(again.outcome).toBe("claim-bootstrapped");
    expect(again.session_file).toBe(claim.session_file);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID)).toEqual(before);

    // Any other identity is still a duplicate holder.
    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          scope: { assignmentPath: fixture.assignmentPath },
          cwd: fixture.root,
          sessionId: "intruder",
        }),
      ),
    ).toBe("coordination.duplicate-holder");
  });

  test("the documented abandoned-claim recovery works end to end", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    const claim = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });

    // The claimant dies between its claim and its prepare: its envelope is the
    // only thing the row has, and it is gone.
    rmSync(claim.session_file, { force: true });

    // The documented recovery: re-present the recorded id on the same locator.
    const recovered = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });
    expect(recovered.outcome).toBe("claim-bootstrapped");
    expect(existsSync(recovered.session_file)).toBe(true);

    const view = await readPlanCoordination(recovered.session_file, PLAN_ID, fixture.root);
    expect(view.allowed_operations).toEqual(["prepare"]);
    const prepared = await mutatePlanCoordination({
      sessionPath: recovered.session_file,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
    });
    expect(prepared.outcome).toBe("prepared");

    const bound = await bindPlanSession({
      scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
      cwd: fixture.root,
      sessionId: "claimant",
    });
    expect(bound.outcome).toBe("claimed");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InProgress");
    expect((planRowOf(fixture, PLAN_ID).execution_lease as Record<string, unknown>).holder).toBe("claimant");
  });

  test("a gate edited after the pre-lock read is still refused as a contract change", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    await preparePlan(fixture, PLAN_ID);
    const before = planRowOf(fixture, PLAN_ID);
    const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");

    // The TOCTOU the reviewers found: the edit lands AFTER the bind has already
    // parsed the Assignment pre-lock, so only a same-read decision inside the
    // lock can see it. The hook fires exactly in that window.
    setBindPreInterleaveForTest(() => {
      setBindPreInterleaveForTest(undefined);
      writeText(
        fixture.assignmentPath,
        readFileSync(fixture.assignmentPath, "utf8").replace("**QA gate**: mandatory", "**QA gate**: pm-acceptance"),
      );
    });

    try {
      expect(
        await errorCodeOf(() =>
          bindPlanSession({
            scope: { assignmentPath: fixture.assignmentPath },
            cwd: fixture.root,
            sessionId: "late-gate-adopter",
          }),
        ),
      ).toBe("coordination.assignment-stale");
    } finally {
      setBindPreInterleaveForTest(undefined);
    }

    // Nothing written: no pin refresh, no audit entry, no lease.
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID)).toEqual(before);
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
  });

  test("an identity or scope header edited inside the interleave window is refused", async () => {
    // Every header class the locked decision depends on, each edited AFTER the
    // pre-lock read: the bind must refuse as a scope/contract change with nothing
    // written. `plan id` is the identity half, `worktree path` the lease-driving
    // half (the resolver returns it unvalidated), `sdd dir` the resolver's own
    // check, and `qa gate` the executed contract.
    const headerEdits: Array<{ header: string; from: string; to: string; what: string }> = [
      { header: "Plan id", from: `**Plan id**: ${PLAN_ID}`, to: "**Plan id**: plan-elsewhere", what: "identity" },
      { header: "Workflow id", from: `**Workflow id**: ${WORKFLOW_ID}`, to: "**Workflow id**: wf-elsewhere", what: "identity" },
      { header: "Worktree Path", from: "**Worktree Path**: ", to: "**Worktree Path**: /tmp/window-lease", what: "lease" },
      { header: "Working branch", from: "**Working branch**: feature/plan-a", to: "**Working branch**: feature/other", what: "lease" },
      { header: "SDD dir", from: "**SDD dir**: ", to: "**SDD dir**: /tmp/window-sdd", what: "scope" },
      { header: "QA gate", from: "**QA gate**: mandatory", to: "**QA gate**: pm-acceptance", what: "contract" },
    ];

    for (const edit of headerEdits) {
      const fixture = makeFixture();
      await ensureCoordinator(fixture);
      await preparePlan(fixture, PLAN_ID);
      const rowBefore = planRowOf(fixture, PLAN_ID);
      const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");

      setBindPreInterleaveForTest(() => {
        setBindPreInterleaveForTest(undefined);
        const text = readFileSync(fixture.assignmentPath, "utf8");
        expect(text).toContain(edit.from);
        writeText(fixture.assignmentPath, text.replace(edit.from, edit.to));
      });

      try {
        expect({
          what: edit.what,
          code: await errorCodeOf(() =>
            bindPlanSession({
              scope: { assignmentPath: fixture.assignmentPath },
              cwd: fixture.root,
              sessionId: "window-adopter",
            }),
          ),
        }).toEqual({ what: edit.what, code: "coordination.assignment-stale" });
      } finally {
        setBindPreInterleaveForTest(undefined);
      }

      // Fail-closed means nothing written: no pin refresh, no lease, no audit.
      expect({ what: edit.what, bytes: readFileSync(fixture.snapshotPath, "utf8") }).toEqual({
        what: edit.what,
        bytes: snapshotBefore,
      });
      expect({ what: edit.what, row: planRowOf(fixture, PLAN_ID) }).toEqual({ what: edit.what, row: rowBefore });
      expect({ what: edit.what, audit: selfAmendmentAudit(fixture).length }).toEqual({ what: edit.what, audit: 0 });
    }
  });

  test("a plan document moved inside the interleave window is adopted with the Assignment drift", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    await preparePlan(fixture, PLAN_ID);
    const pinned = planCoordinationOf(fixture, PLAN_ID).prepared as Record<string, unknown>;
    const planPinned = String(pinned.plan_sha256);

    setBindPreInterleaveForTest(() => {
      setBindPreInterleaveForTest(undefined);
      // Both halves move: the Assignment drifts byte-level (which is what makes
      // this bind an adoption at all) AND the plan document it was sealed with.
      writeText(fixture.assignmentPath, `${readFileSync(fixture.assignmentPath, "utf8")}\ncomment-only drift.\n`);
      writeText(fixture.planPath, `${readFileSync(fixture.planPath, "utf8")}\nplan edited after prepare.\n`);
    });

    try {
      const bound = await bindPlanSession({
        scope: { assignmentPath: fixture.assignmentPath },
        cwd: fixture.root,
        sessionId: "plan-edit-adopter",
      });
      expect(bound.outcome).toBe("claimed");
    } finally {
      setBindPreInterleaveForTest(undefined);
    }

    // Both halves of the sealed pair are re-pinned to the bytes this bind acted
    // under (spec §D2), and one audit entry records the two moves.
    const prepared = planCoordinationOf(fixture, PLAN_ID).prepared as Record<string, unknown>;
    expect(prepared.assignment_sha256).toBe(sha256OfFile(fixture.assignmentPath));
    expect(prepared.plan_sha256).toBe(sha256OfFile(fixture.planPath));
    expect(prepared.plan_sha256).not.toBe(planPinned);

    const audit = selfAmendmentAudit(fixture);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      session_id: "plan-edit-adopter",
      old_sha256: pinned.assignment_sha256,
      new_sha256: prepared.assignment_sha256,
      plan_old_sha256: planPinned,
      plan_new_sha256: prepared.plan_sha256,
      prepared_by_matches: false,
    });
  });

  test("an adoption whose plan half did not move records no plan-half pair", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    await preparePlan(fixture, PLAN_ID);
    const planPinned = String((planCoordinationOf(fixture, PLAN_ID).prepared as Record<string, unknown>).plan_sha256);
    editAssignment(fixture, "Assignment only, plan untouched.");

    const bound = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "assignment-only-adopter",
    });
    expect(bound.outcome).toBe("claimed");

    // A matching plan half is an absent pair, never a pair of equal digests —
    // the row keeps its plan pin and the entry records one move.
    const prepared = planCoordinationOf(fixture, PLAN_ID).prepared as Record<string, unknown>;
    expect(prepared.plan_sha256).toBe(planPinned);
    const audit = selfAmendmentAudit(fixture);
    expect(audit).toHaveLength(1);
    expect(audit[0].plan_old_sha256).toBeUndefined();
    expect(audit[0].plan_new_sha256).toBeUndefined();
  });

  test("a deleted plan document refuses as a sealed-input staleness, never a filesystem error", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    await preparePlan(fixture, PLAN_ID);
    const rowBefore = planRowOf(fixture, PLAN_ID);
    const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");

    // The Assignment drifts (so this bind is an adoption) and the plan half of
    // the sealed pair is gone: the refusal must be the structured one.
    editAssignment(fixture, "comment-only drift, plan removed.");
    rmSync(fixture.planPath, { force: true });

    const refused = await (async () => {
      try {
        await bindPlanSession({
          scope: { assignmentPath: fixture.assignmentPath },
          cwd: fixture.root,
          sessionId: "plan-gone-adopter",
        });
        throw new Error("expected the bind to refuse");
      } catch (error) {
        return error instanceof CoordinationError ? { code: error.code, message: error.message, details: error.details } : null;
      }
    })();

    expect(refused?.code).toBe("coordination.assignment-stale");
    expect(refused?.details).toMatchObject({ path: fixture.planPath });
    expect(refused?.message).not.toMatch(/ENOENT|EISDIR/);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID)).toEqual(rowBefore);
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
  });

  test("a moved plan that redirects its Working branch declaration refuses instead of being adopted", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    await preparePlan(fixture, PLAN_ID);
    const rowBefore = planRowOf(fixture, PLAN_ID);
    const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");

    // The Assignment drifts (adoption attempt) and the moved plan declares a
    // different Working branch than the one this bind would claim: the seal
    // must not describe a plan pointing the work somewhere else.
    editAssignment(fixture, "comment-only drift, plan branch redirected.");
    writeText(fixture.planPath, "# plan a\n\n**Working branch:** feature/somewhere-else\n\nBody.\n");

    const refused = await (async () => {
      try {
        await bindPlanSession({
          scope: { assignmentPath: fixture.assignmentPath },
          cwd: fixture.root,
          sessionId: "branch-redirect-adopter",
        });
        throw new Error("expected the bind to refuse");
      } catch (error) {
        return error instanceof CoordinationError ? { code: error.code, message: error.message, details: error.details } : null;
      }
    })();

    expect(refused?.code).toBe("coordination.assignment-stale");
    expect(refused?.details).toMatchObject({ path: fixture.planPath, expected: "feature/plan-a", actual: "feature/somewhere-else" });
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID)).toEqual(rowBefore);
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
  });

  test("a moved plan whose Working branch declaration still names the bind's branch is adopted", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    await preparePlan(fixture, PLAN_ID);
    editAssignment(fixture, "comment-only drift, plan body edited.");

    // The declared branches match the scope this bind acts under and the real
    // main checkout (`git init -b main` above), so the move is a plain §D2
    // re-pin: the declarations are not a second refusal surface.
    writeText(
      fixture.planPath,
      "# plan a\n\n**Main worktree branch:** main\n**Working branch:** feature/plan-a\n\nplan edited after prepare.\n",
    );

    const bound = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "matching-declaration-adopter",
    });
    expect(bound.outcome).toBe("claimed");

    const prepared = planCoordinationOf(fixture, PLAN_ID).prepared as Record<string, unknown>;
    expect(prepared.plan_sha256).toBe(sha256OfFile(fixture.planPath));
    const audit = selfAmendmentAudit(fixture);
    expect(audit).toHaveLength(1);
    expect(audit[0].plan_new_sha256).toBe(prepared.plan_sha256);
  });

  test("a moved plan whose Main worktree branch declaration contradicts the main checkout refuses", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    await preparePlan(fixture, PLAN_ID);
    const rowBefore = planRowOf(fixture, PLAN_ID);
    const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");

    // The Working branch declaration still matches the bind's scope, but the
    // moved plan points the main-residency expectation at a branch the main
    // checkout is not on: the SDD path reads this header live, so the adoption
    // re-proves the equality prepare proved instead of sealing the lie.
    editAssignment(fixture, "comment-only drift, plan main header moved.");
    writeText(
      fixture.planPath,
      "# plan a\n\n**Main worktree branch:** trunk\n**Working branch:** feature/plan-a\n\nplan edited after prepare.\n",
    );

    const refused = await (async () => {
      try {
        await bindPlanSession({
          scope: { assignmentPath: fixture.assignmentPath },
          cwd: fixture.root,
          sessionId: "main-redirect-adopter",
        });
        throw new Error("expected the bind to refuse");
      } catch (error) {
        return error instanceof CoordinationError ? { code: error.code, message: error.message, details: error.details } : null;
      }
    })();

    expect(refused?.code).toBe("coordination.assignment-stale");
    expect(refused?.details).toMatchObject({ path: fixture.planPath, expected: "trunk", actual: "main" });
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID)).toEqual(rowBefore);
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
  });

  test("a sealed input that is gone refuses structurally, and an unreadable one is a read error", async () => {
    // Framing, stated precisely: this case exercises the GONE path (and the
    // read-error normalization for a non-ENOENT failure). It does NOT reproduce
    // the delete-between-check-and-read race — that race is closed structurally
    // by removing the pre-check, so there is no check left to lose, and the
    // assertions here cannot (and are not meant to) prove the race absent.
    const planHalf = makeFixture();
    await ensureCoordinator(planHalf);
    await preparePlan(planHalf, PLAN_ID);
    const planRowBefore = planRowOf(planHalf, PLAN_ID);
    const planSnapshotBefore = readFileSync(planHalf.snapshotPath, "utf8");
    editAssignment(planHalf, "comment-only drift, plan half made unreadable.");
    rmSync(planHalf.planPath, { force: true });
    mkdirSync(planHalf.planPath, { recursive: true });

    const planRefusal = await (async () => {
      try {
        await bindPlanSession({
          scope: { assignmentPath: planHalf.assignmentPath },
          cwd: planHalf.root,
          sessionId: "unreadable-plan-adopter",
        });
        throw new Error("expected the bind to refuse");
      } catch (error) {
        return error as { code?: string; message?: string };
      }
    })();

    // A directory in place of the file is NOT "gone": the read fails for another
    // reason and is reported as itself (the driver's EISDIR), never dressed up
    // as a stale sealed input.
    expect(planRefusal?.code).toBe("EISDIR");
    expect(planRefusal?.code).not.toBe("coordination.assignment-stale");
    // Nothing written either way: the bind refused before any commit.
    expect(readFileSync(planHalf.snapshotPath, "utf8")).toBe(planSnapshotBefore);
    expect(planRowOf(planHalf, PLAN_ID)).toEqual(planRowBefore);
    expect(selfAmendmentAudit(planHalf)).toHaveLength(0);

    // The GONE case for the Assignment half: the row is bound to a plan session
    // first (so the mutation is a plan-session operation and reaches the
    // freshness check), and its revision is read BEFORE the file is removed.
    const assignmentHalf = makeFixture();
    await ensureCoordinator(assignmentHalf);
    await preparePlan(assignmentHalf, PLAN_ID);
    const bound = await bindPlanSession({
      scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: assignmentHalf.harness },
      cwd: assignmentHalf.root,
      sessionId: "unreadable-assignment-holder",
    });
    const assignmentSnapshotBefore = readFileSync(assignmentHalf.snapshotPath, "utf8");
    const revision = (await readPlanCoordination(bound.session_file, PLAN_ID, assignmentHalf.root)).revision;
    rmSync(assignmentHalf.assignmentPath, { force: true });

    const assignmentRefusal = await (async () => {
      try {
        await mutatePlanCoordination({
          sessionPath: bound.session_file,
          planId: PLAN_ID,
          expectedRevision: revision,
          operation: { kind: "progress", progress: { status: "InProgress", summary: "x", evidence_paths: [] } },
        });
        throw new Error("expected the mutation to refuse");
      } catch (error) {
        return error instanceof CoordinationError ? { code: error.code, message: error.message, details: error.details } : null;
      }
    })();

    expect(assignmentRefusal?.code).toBe("coordination.assignment-stale");
    expect(assignmentRefusal?.details).toMatchObject({ path: assignmentHalf.assignmentPath });
    expect(assignmentRefusal?.message).not.toMatch(/ENOENT/);
    expect(readFileSync(assignmentHalf.snapshotPath, "utf8")).toBe(assignmentSnapshotBefore);
  });

  test("a leaf or unknown seat keeps the existing session-role refusal", async () => {
    const fixture = makeFixture();
    const leaf = join(fixture.workflowDir, "sessions", "leaf.json");
    writeJson(leaf, {
      schema_version: 1,
      role: "leaf",
      session_id: "leaf",
      workflow_id: WORKFLOW_ID,
      harness_root: fixture.harness,
    });

    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: leaf,
          expectedRevision: 0,
          operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
        }),
      ),
    ).toBe("coordination.session-role");
  });

  test("a claimed row whose Assignment drifts before its bind is adopted by its own claimant", async () => {
    const fixture = makeFixture();
    // The workflow has its coordinator seat (the snapshot block the amendment
    // audit rides on); the ROW is claimed and prepared by its own session.
    await ensureCoordinator(fixture);
    const claim = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });
    const claimView = await readPlanCoordination(claim.session_file, PLAN_ID, fixture.root);
    await mutatePlanCoordination({
      sessionPath: claim.session_file,
      planId: PLAN_ID,
      expectedRevision: claimView.revision,
      operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
    });
    const pinned = String((planCoordinationOf(fixture, PLAN_ID).prepared as Record<string, unknown>).assignment_sha256);
    editAssignment(fixture, "the claimant's own late edit.");
    const current = sha256OfFile(fixture.assignmentPath);

    // The row is bound to THIS session (the claim), so its own drift is the
    // claimant's to amend — the same audited exit an orphan takes.
    const bound = await bindPlanSession({
      scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
      cwd: fixture.root,
      sessionId: "claimant",
    });

    expect(bound.outcome).toBe("claimed");
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("InProgress");
    expect((row.execution_lease as Record<string, unknown>).holder).toBe("claimant");
    expect((planCoordinationOf(fixture, PLAN_ID).prepared as Record<string, unknown>).assignment_sha256).toBe(current);
    const audit = selfAmendmentAudit(fixture);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      session_id: "claimant",
      old_sha256: pinned,
      new_sha256: current,
      prepared_by_matches: true,
    });
  });

  test("the same claimed row keeps the terminal refusal for a different identity", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    const claim = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });
    const claimView = await readPlanCoordination(claim.session_file, PLAN_ID, fixture.root);
    await mutatePlanCoordination({
      sessionPath: claim.session_file,
      planId: PLAN_ID,
      expectedRevision: claimView.revision,
      operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
    });
    const before = planRowOf(fixture, PLAN_ID);
    const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");
    editAssignment(fixture, "held by its claimant.");

    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
          cwd: fixture.root,
          sessionId: "intruder",
        }),
      ),
    ).toBe("coordination.assignment-stale");

    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID)).toEqual(before);
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
  });

  test("an orphaning interleave after the fail-fast read is settled by the locked re-decision", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    // The addressed row is prepared (by the coordinator) and HELD by another
    // session: the unlocked fail-fast measurement sees a holder, and only the
    // locked re-decision may adopt it.
    await preparePlan(fixture, PEER_PLAN_ID);
    await bindPlan(fixture, PEER_PLAN_ID);
    // The drift the locked re-decision must adopt is in the ADDRESSED (peer)
    // Assignment, not in the plan-A one.
    writeText(fixture.peerAssignmentPath, `${readFileSync(fixture.peerAssignmentPath, "utf8")}\npeer edit.\n`);

    // Interleave: between the fail-fast read and the locked decision the row
    // loses its holder, so an unlocked refusal here would be a false one.
    setBindPreInterleaveForTest(() => {
      setBindPreInterleaveForTest(undefined);
      updatePlanRow(fixture, PEER_PLAN_ID, (row) => {
        const { execution_lease: _released, ...rest } = row;
        const coordination = { ...((rest.coordination ?? {}) as Record<string, unknown>) };
        delete coordination.session;
        return { ...rest, status: "Todo", coordination };
      });
    });

    try {
      const bound = await bindPlanSession({
        scope: { assignmentPath: fixture.peerAssignmentPath },
        cwd: fixture.root,
        sessionId: "late-adopter",
      });
      expect(bound.outcome).toBe("claimed");
      expect(planRowOf(fixture, PEER_PLAN_ID).status).toBe("InProgress");
      expect(selfAmendmentAudit(fixture)).toHaveLength(1);
    } finally {
      setBindPreInterleaveForTest(undefined);
    }
  });

  test("with no coordination block to record it, a drifted claimed row refuses instead of adopting", async () => {
    const fixture = makeFixture();
    const claim = await bindPlanSession({
      scope: { assignmentPath: fixture.assignmentPath },
      cwd: fixture.root,
      sessionId: "claimant",
    });
    const claimView = await readPlanCoordination(claim.session_file, PLAN_ID, fixture.root);
    await mutatePlanCoordination({
      sessionPath: claim.session_file,
      planId: PLAN_ID,
      expectedRevision: claimView.revision,
      operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
    });
    const before = planRowOf(fixture, PLAN_ID);
    const snapshotBefore = readFileSync(fixture.snapshotPath, "utf8");
    editAssignment(fixture, "no audit host for this adoption.");

    // The claim bootstrap needs no coordinator seat, so this row can exist on a
    // workflow whose snapshot carries no coordination block — and an amendment
    // that cannot be recorded is not made. Fail closed, bytes untouched.
    expect(
      await errorCodeOf(() =>
        bindPlanSession({
          scope: { workflowId: WORKFLOW_ID, planId: PLAN_ID, harnessDir: fixture.harness },
          cwd: fixture.root,
          sessionId: "claimant",
        }),
      ),
    ).toBe("coordination.assignment-stale");
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID)).toEqual(before);
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
  });

  test("a hash-fresh prepared row refuses a second prepare (the coordinator keeps it)", async () => {
    const fixture = makeFixture();
    const coordinator = await ensureCoordinator(fixture);
    const view = await preparePlan(fixture, PLAN_ID);
    const fresh = await readPlanCoordination(coordinator, PLAN_ID, fixture.root);

    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: coordinator,
          planId: PLAN_ID,
          expectedRevision: fresh.revision,
          operation: { kind: "prepare", assignmentPath: fixture.assignmentPath },
        }),
      ),
    ).toBe("coordination.prepare-already-prepared");
    expect(view.outcome).toBe("prepared");
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
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

  test("prepare pins the Assignment hash; a mutated Assignment invalidates the row", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);

    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(view.prepared?.assignment_path).toBe(fixture.assignmentPath);
    expect(view.prepared?.qa_gate).toBe("mandatory");
    expect(view.prepared?.findings_cleanup).toBe("zero-residual");
    expect(view.prepared?.assignment_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(view.revision).toBe(2); // prepare bumped it to 1, the fresh bind to 2
    expect(view.scope?.planPath).toBe(fixture.planPath);

    // The Assignment is the row's pin: editing it invalidates every later call.
    writeText(
      fixture.assignmentPath,
      `${readFileSync(fixture.assignmentPath, "utf8")}\nRewritten after prepare.\n`,
    );
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [] }},
    }),
      ),
    ).toBe("coordination.assignment-stale");
  });

  test("progress is revision-guarded, evidence-scoped and transition-checked", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);

    const evidence = join(fixture.sddDir, "evidence.txt");
    writeText(evidence, "proof\n");
    const outside = join(fixture.root, "outside.txt");
    writeText(outside, "not mine\n");
    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);

    // Stale revision: the row moved to revision 1 during prepare.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: 0,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [evidence] }},
    }),
      ),
    ).toBe("coordination.version-conflict");

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
    ).toBe("coordination.evidence-stale");

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
