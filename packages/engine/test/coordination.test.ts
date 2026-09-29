/**
 * Engine scoped-plan coordination — slice A (core, binding and read
 * operations: session envelope, scope resolution, residual provenance).
 *
 * Spec sources (each group cites the section it enforces):
 * - Spec §B — one coordinator session per lifecycle, one plan session per plan;
 *   the session envelope is identity + pointers only, absolute, `0600`, and it
 *   is the durable proof of who holds the session.
 * - Spec §B — `resolvePlanScope`: both address forms (pinned Assignment path,
 *   workflow/plan pair read through the row's `prepared` block) resolve to the
 *   same `ResolvedPlanScope`.
 * - Spec §C — prepared Assignment is hash-pinned (`assignment_sha256`); a
 *   mutated Assignment invalidates the row (`coordination.assignment-stale`).
 * - Spec §C — row `coordination.revision` is the snapshot CAS; the project
 *   register is compare-and-swapped on its **byte version** under the
 *   root→snapshot→register lock order, so a cross-process writer can never
 *   produce a lost update.
 * - Spec §D — residual writes are scoped to `entries[<plan-id>]`: the engine
 *   generates provenance (`source_plan` / `lifecycle_id` / `registered_at`)
 *   and never touches a sibling plan's bucket.
 * - Slice B surface — every spec §D/§E operation is implemented: a plan
 *   session may hand off, and the coordinator verbs (`accept`, `return`,
 *   `integration-start`, `integration-accept`, `complete`, `reconcile`) are
 *   neither advertised to a plan session nor reachable from one.
 * - Spec §C4 `replaceCoordinatedArtifact` — snapshot, status and project
 *   register replacements are byte-version CASed and refuse any document that
 *   carries coordinated ownership (`protected-writers`).
 *
 * Fixture discipline: the temp root is `realpathSync`-ed before any path is
 * derived from it, because the engine compares `realpathSync` worktree roots
 * (git) with lexically-resolved harness paths; every plan id is a safe path
 * component (`assertSafePathComponent`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join, sep } from "node:path";
import {
  EXECUTION_PIN_CONFLICT_CODE,
  amendPrepareWorkflow,
  bindPlanSession,
  setBindPreInterleaveForTest,
  executionInputHash,
  mutatePlanCoordination,
  readCoordinatedArtifact,
  readPlanCoordination,
  recoverPrepareCoordinator,
  replaceCoordinatedArtifact,
  resolvePlanScope,
  setCompleteStandaloneMutateGapForTest,
  setPrepareRecoveryEnvelopeGapForTest,
  showPrepareCoordinatorRecovery,
  showPrepareWorkflow,
  type CatalogExecutionPin,
  type CoordinationResult,
  type PlanCoordinationView,
  type PrepareCoordinatorRecoveryView,
  type PrepareWorkflowPatch,
  type PrepareWorkflowResult,
} from "../src/coordination.js";
import { registerCatalogEntity, updateCatalogEntity } from "../src/catalog.js";
import { initializeExecutionAuthority } from "../src/execution-store.js";
import { initializeStore, openStore, type StoreContext } from "../src/store-db.js";
import {
  CoordinationError,
  artifactVersion,
  readArtifactBytes,
  validateSnapshotCoordination,
  withProtectedWrite,
} from "../src/coordination-write.js";
import { claimLease, withStatusWriteLock } from "../src/lease.js";
import { registerWorkflow } from "../src/status.js";
import { createFsStore, setArtifactStore, type ArtifactDoc, type ArtifactRef, type ArtifactStore } from "../src/store.js";
import {
  closeWorkflow,
  recordWorkflowDelivery,
  stableJson,
  WORKFLOW_SNAPSHOT_FILE,
  writeWorkflowSnapshot,
  type WorkflowSnapshot,
} from "../src/workflow.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  afterEachCleanup();
});

import {
  WORKFLOW_ID, PLAN_ID, PEER_PLAN_ID, PROJECT_ID, FIXTURE_COORDINATOR_ID,
  type Fixture, type GitFixture, type HandoffEvidence,
  git, writeText, writeJson, readJson, planRow, assignmentText, makeFixture, sleep, errorCodeOf,
  ensureCoordinator, preparePlan, bindPlan, resumePlan, headOf,
  gitFixture, snapshotOf, planRowOf, updatePlanRow, claimExecutionLease, handoffFields, leaseHolder,
  handoffEvidenceOf, recordField, digestOf, sha256OfFile, handoffCall, coordinatorCall, acceptedFixture,
  standaloneGitFixture, acceptedStandaloneFixture, wrongSourceLegacyGitFixture, wrongSourceAcceptedFixture,
  storeBacked, sealStoreForReaders, afterEachCleanup,
} from "./support/coordination-fixtures.js";

/**
 * An issue capture entry as the scoped `residual-add` operation now takes it
 * (G2a): the core `CaptureInput` minus `projectId` — the plan scope supplies
 * the project. No disposition is recorded at capture time (contract §6).
 */
function finding(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: `Finding ${id}`,
    kind: "review-obligation",
    severity: "medium",
    impact: "blocks plan approval",
    acceptance: "fixed or explicitly dispositioned",
    owner: "@fullstack-dev",
    sourceIdentity: `qc:report:${id}`,
    rootCauseKey: `root-cause:${id}`,
    acceptanceKey: "fix-verified",
    occurrenceKey: `occ-${id}`,
    sourceKind: "qc-report",
    location: "packages/engine",
    observedBehavior: `finding ${id} observed`,
    evidence: ["review/qc1.md"],
    discoveredAt: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

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

/** The open issues the issue store links to a plan (the authority the gate reads). */
async function linkedOpenIssues(fixture: Fixture, planId: string): Promise<Array<{ id: string; severity: string; disposition: string }>> {
  const handle = await openStore({ harnessDir: fixture.harness }, "read");
  try {
    return handle.db
      .prepare(
        "select issues.id as id, issues.severity as severity, issues.disposition as disposition from issues " +
          "join provenance on provenance.issue_id = issues.id and provenance.kind = 'plan' and provenance.target = ? " +
          "where issues.disposition = 'open' order by issues.id asc",
      )
      .all(planId) as Array<{ id: string; severity: string; disposition: string }>;
  } finally {
    handle.close();
  }
}
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
    ).toBe("coordination.invalid-transition");
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

/**
 * Spec §D0/D1/D2 (fixes #308) — admission cost proportional to contention: the
 * Assignment-addressed bind bootstraps an unclaimed, unprepared row (claim),
 * the row's own claimant may prepare it, and a bind on a prepared row NOBODY
 * holds whose Assignment drifted amends the pin with one appended audit entry
 * instead of stopping. A row somebody else holds keeps every existing refusal.
 */
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
    ).toBe("coordination.invalid-transition");

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
        return error instanceof CoordinationError ? { code: error.code, message: error.message } : null;
      }
    })();

    expect(refused?.code).toBe("coordination.assignment-stale");
    expect(refused?.message).toContain("plan document");
    expect(refused?.message).toContain("changed or is gone");
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
        return error instanceof CoordinationError ? { code: error.code, message: error.message } : null;
      }
    })();

    expect(refused?.code).toBe("coordination.assignment-stale");
    expect(refused?.message).toContain("declares Working branch feature/somewhere-else");
    expect(refused?.message).toContain("feature/plan-a");
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
        return error instanceof CoordinationError ? { code: error.code, message: error.message } : null;
      }
    })();

    expect(refused?.code).toBe("coordination.assignment-stale");
    expect(refused?.message).toContain("declares Main worktree branch trunk");
    expect(refused?.message).toContain("is on main");
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
        return error instanceof CoordinationError ? { code: error.code, message: error.message } : null;
      }
    })();

    expect(assignmentRefusal?.code).toBe("coordination.assignment-stale");
    expect(assignmentRefusal?.message).toContain("Assignment");
    expect(assignmentRefusal?.message).toContain("changed or is gone");
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
    ).toBe("coordination.invalid-transition");
    expect(view.outcome).toBe("prepared");
    expect(selfAmendmentAudit(fixture)).toHaveLength(0);
  });
});

describe("handoff-transitions", () => {
  test("handoff seals the evidence, accept moves the lease to the coordinator, return restores it", { timeout: 60_000 }, async () => {
    const fixture = await gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));

    const evidence = handoffEvidenceOf(fixture, fixture.planSha);
    const planSessionId = readJson(fixture.planSession).session_id;
    const coordinatorSessionId = readJson(fixture.coordinatorSession).session_id;

    // A dirty plan worktree is not a handoff-able state.
    writeText(join(fixture.worktreePath, "scratch.txt"), "wip\n");
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.git-proof");
    rmSync(join(fixture.worktreePath, "scratch.txt"), { force: true });

    // An abbreviated revision is never silently expanded into a pin.
    expect(await errorCodeOf(() => handoffCall(fixture, { ...evidence, source_sha: fixture.planSha.slice(0, 7) }))).toBe(
      "coordination.invalid-input",
    );

    // Evidence must live inside this plan's own plan/SDD area.
    const stray = join(fixture.root, "stray-qc.md");
    writeText(stray, "# qc\n");
    expect(
      await errorCodeOf(() => handoffCall(fixture, { ...evidence, qc: { ...evidence.qc, reports: [stray] } })),
    ).toBe("coordination.path-mismatch");

    // A QA gate the Assignment never pinned is a stale handoff.
    expect(
      await errorCodeOf(() => handoffCall(fixture, { ...evidence, qa: { ...evidence.qa, gate: "pm-acceptance" } })),
    ).toBe("coordination.assignment-stale");

    const handed = await handoffCall(fixture, evidence);
    expect(handed.outcome).toBe("handed-off");
    const handedRow = planRowOf(fixture, PLAN_ID);
    expect(handedRow.status).toBe("InReview");
    expect(leaseHolder(handedRow)).toBe(planSessionId);
    const handoff = handoffFields(handedRow);
    expect(handoff.state).toBe("submitted");
    expect(handoff.attempt).toBe(1);
    expect(handoff.submitted_by).toBe(planSessionId);
    expect(typeof handoff.submitted_at).toBe("string");
    expect(handoff.source_branch).toBe("feature/plan-a");
    expect(handoff.source_sha).toBe(fixture.planSha);
    expect(handoff.review_base).toBe(fixture.baseSha);
    expect(handoff.review_head).toBe(fixture.planSha);
    expect(handoff.worktree_path).toBe(fixture.worktreePath);

    // Evidence is sealed by content, not by reference: the digest is the file's.
    const qc = recordField(handoff, "qc");
    expect(qc.decision).toBe("Approve");
    const reports = qc.reports;
    if (!Array.isArray(reports)) throw new Error("qc.reports is not an array");
    expect(reports).toHaveLength(2);
    expect(reports.map(digestOf)).toEqual([
      sha256OfFile(join(fixture.sddDir, "review", "qc1.md")),
      sha256OfFile(join(fixture.sddDir, "review", "qc2.md")),
    ]);
    const consolidated = recordField(qc, "consolidated");
    expect(consolidated.path).toBe(join(fixture.sddDir, "review", "qc.md"));
    expect(digestOf(consolidated)).toBe(sha256OfFile(join(fixture.sddDir, "review", "qc.md")));
    const qa = recordField(handoff, "qa");
    expect(qa.gate).toBe("mandatory");
    expect(qa.decision).toBe("pass");
    expect(digestOf(recordField(qa, "report"))).toBe(sha256OfFile(join(fixture.sddDir, "qa.md")));

    // The plan session is done until the row comes back; the coordinator can act.
    const planView = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(planView.allowed_operations).toEqual([]);
    const coordinatorView = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect([...coordinatorView.allowed_operations].sort()).toEqual(["accept", "return"]);
    expect(await errorCodeOf(() => handoffCall(fixture, evidence))).toBe("coordination.invalid-transition");

    const accepted = await coordinatorCall(fixture, PLAN_ID, { kind: "accept" });
    expect(accepted.outcome).toBe("accepted");
    const acceptedRow = planRowOf(fixture, PLAN_ID);
    expect(acceptedRow.status).toBe("InReview");
    expect(leaseHolder(acceptedRow)).toBe(coordinatorSessionId);
    const acceptedHandoff = handoffFields(acceptedRow);
    expect(acceptedHandoff.id).toBe(handoff.id);
    expect(acceptedHandoff.state).toBe("accepted");
    expect(acceptedHandoff.accepted_by).toBe(coordinatorSessionId);
    expect(typeof acceptedHandoff.accepted_at).toBe("string");

    // A return needs a reason, and it puts the row back with its own session.
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "return" }))).toBe(
      "coordination.invalid-input",
    );
    const returned = await coordinatorCall(fixture, PLAN_ID, { kind: "return", reason: "review range is stale" });
    expect(returned.outcome).toBe("returned");
    const returnedRow = planRowOf(fixture, PLAN_ID);
    expect(returnedRow.status).toBe("InProgress");
    expect(leaseHolder(returnedRow)).toBe(planSessionId);
    const returnedHandoff = handoffFields(returnedRow);
    expect(returnedHandoff.state).toBe("returned");
    expect(returnedHandoff.return_reason).toBe("review range is stale");
    expect(typeof returnedHandoff.returned_at).toBe("string");

    // Rework is a new commit and a new attempt, never a rewritten record.
    writeText(join(fixture.worktreePath, "slice.txt"), "slice B v2\n");
    git(["add", "-A"], fixture.worktreePath);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix: rework"], fixture.worktreePath);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    const second = await handoffCall(fixture, handoffEvidenceOf(fixture, headOf(fixture.worktreePath)));
    expect(second.outcome).toBe("handed-off");
    const secondHandoff = handoffFields(planRowOf(fixture, PLAN_ID));
    expect(secondHandoff.state).toBe("submitted");
    expect(secondHandoff.attempt).toBe(2);
    expect(secondHandoff.id).not.toBe(returnedHandoff.id);
    expect(secondHandoff.source_sha).toBe(headOf(fixture.worktreePath));
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
    ).toBe("coordination.invalid-transition");
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

describe("protected-writers", () => {
  const STATUS_REF = { kind: "status", key: "root" } as const;

  test("the root status is replaced under an exact byte-version precondition", async () => {
    const fixture = makeFixture();
    const harnessRoot = realpathSync(fixture.harness);
    const statusPath = join(harnessRoot, "status.json");
    const original = readFileSync(statusPath);
    const empty = { version: 2, updated_at: "2026-09-16", workflows: [] };

    // An uncoordinated root is a legitimate target, and the returned version is
    // the version of the bytes just written.
    const replaced = await replaceCoordinatedArtifact({
      harnessRoot,
      ref: STATUS_REF,
      payload: empty,
      expectedVersion: artifactVersion(original),
    });
    expect(replaced.payload).toEqual(empty);
    expect(replaced.version).toBe(artifactVersion(readFileSync(statusPath)));
    expect(await readCoordinatedArtifact(harnessRoot, STATUS_REF)).toEqual({
      payload: empty,
      version: replaced.version,
    });

    // The superseded version is refused, and a failed CAS leaves the file alone.
    const before = readFileSync(statusPath);
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({ harnessRoot, ref: STATUS_REF, payload: empty, expectedVersion: artifactVersion(original) }),
      ),
    ).toBe("coordination.version-conflict");
    expect(readFileSync(statusPath).equals(before)).toBe(true);
  });

  test("a root that registers a coordinated workflow is refused on either side", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    const harnessRoot = realpathSync(fixture.harness);
    const statusPath = join(harnessRoot, "status.json");
    const coordinated = readFileSync(statusPath);
    const registered = (JSON.parse(coordinated.toString("utf8")) as { workflows: unknown[] }).workflows;

    // Current side: the root on disk registers a coordinated workflow.
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({
          harnessRoot,
          ref: STATUS_REF,
          payload: readJson(statusPath),
          expectedVersion: artifactVersion(coordinated),
        }),
      ),
    ).toBe("coordination.scoped-writer-required");
    expect(readFileSync(statusPath).equals(coordinated)).toBe(true);

    // Proposed side: the current root registers nothing coordinated, the
    // replacement would re-register the coordinated workflow.
    const plain = { version: 2, updated_at: "2026-09-17", workflows: [] };
    writeJson(statusPath, plain);
    const uncoordinated = readFileSync(statusPath);
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({
          harnessRoot,
          ref: STATUS_REF,
          payload: { ...plain, workflows: registered },
          expectedVersion: artifactVersion(uncoordinated),
        }),
      ),
    ).toBe("coordination.scoped-writer-required");
    expect(readFileSync(statusPath).equals(uncoordinated)).toBe(true);
  });

  test("issue authority: a project register replacement is retired and refused outright", async () => {
    const fixture = makeFixture();
    await storeBacked(fixture, [PLAN_ID, PEER_PLAN_ID]);
    const harnessRoot = realpathSync(fixture.harness);

    // A register that predates coordination is migration history: the
    // replacement surface refuses the retired kind before any CAS.
    writeJson(fixture.registerPath, { entries: { [PEER_PLAN_ID]: [] } });
    const before = readFileSync(fixture.registerPath);
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({
          harnessRoot,
          ref: { kind: "residuals", key: PROJECT_ID } as never,
          payload: { entries: {} },
          expectedVersion: "absent",
        }),
      ),
    ).toBe("coordination.store");
    expect(readFileSync(fixture.registerPath).equals(before)).toBe(true);

    // The residual-add mutation itself never recreates the register: after
    // the DB cutover a coordinated plan still leaves the legacy file alone.
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [finding("r-scoped")] as never },
    });
    expect(readFileSync(fixture.registerPath).equals(before)).toBe(true);
    expect((await linkedOpenIssues(fixture, PLAN_ID)).map((issue) => issue.id)).toEqual(["I-000001"]);
  });

  test("uncoordinated kinds refuse explicitly and a plan session cannot replace a snapshot", async () => {
    const fixture = makeFixture();
    await preparePlan(fixture, PLAN_ID);
    await ensureCoordinator(fixture);
    const harnessRoot = realpathSync(fixture.harness);

    // Kinds that keep their own writer are refused, never silently no-oped.
    for (const ref of [{ kind: "review", key: PLAN_ID } as const, { kind: "json", key: join(harnessRoot, "loose.json") } as const]) {
      expect(
        await errorCodeOf(() => replaceCoordinatedArtifact({ harnessRoot, ref, payload: {}, expectedVersion: "absent" })),
      ).toBe("coordination.scoped-writer-required");
    }

    // A coordinated snapshot is replaceable by the coordinator only: a plan
    // session is refused before the payload is even considered.
    const snapshotRef = { kind: "snapshot", key: WORKFLOW_ID } as const;
    const snapshotPath = join(harnessRoot, "workflows", WORKFLOW_ID, "snapshot.json");
    const snapshot = readJson(snapshotPath);
    const version = artifactVersion(readFileSync(snapshotPath));
    const planSession = (await bindPlan(fixture, PLAN_ID)).session_file;
    for (const sessionPath of [undefined, planSession]) {
      expect(
        await errorCodeOf(() =>
          replaceCoordinatedArtifact({ harnessRoot, ref: snapshotRef, payload: snapshot, expectedVersion: version, sessionPath }),
        ),
      ).toBe("coordination.session-role");
    }
  });

  test("a json alias through a symlinked parent cannot create a not-yet-existing protected file (PR241-G4)", async () => {
    const root = mkdtempSync(join(tmpdir(), "coordination-alias-parent-"));
    try {
      // The protected ROOT exists (`workflows/`) but the leaf does not, and the
      // alias parent is a symlink onto the canonical root itself. A class
      // decision that falls back to the lexical path lets that alias land
      // outside the protected prefix and create the protected file.
      const canonical = realpathSync(root);
      mkdirSync(join(canonical, "workflows"), { recursive: true });
      symlinkSync(canonical, join(canonical, "alias"), "dir");
      const snapshotPath = join(canonical, "workflows", WORKFLOW_ID, "snapshot.json");
      const snapshotAlias = join(canonical, "alias", "workflows", WORKFLOW_ID, "snapshot.json");
      const statusAlias = join(canonical, "alias", "status.json");
      const store = createFsStore(canonical);

      await expect(store.put({ kind: "json", key: snapshotAlias, payload: { id: WORKFLOW_ID } })).rejects.toMatchObject({
        code: "coordination.direct-write-refused",
      });
      await expect(store.put({ kind: "json", key: statusAlias, payload: { version: 2 } })).rejects.toMatchObject({
        code: "coordination.direct-write-refused",
      });
      // Refuse-before-write: neither protected document nor its directory exists.
      expect(existsSync(snapshotPath)).toBe(false);
      expect(existsSync(join(canonical, "status.json"))).toBe(false);

      // Unprotected aliases still write (the walk must not over-block), and the
      // protected path itself stays writable from the authorized context.
      await store.put({ kind: "json", key: join(canonical, "alias", "notes.json"), payload: { note: "escape hatch" } });
      const notes = await store.get<Record<string, string>>({ kind: "json", key: join(canonical, "alias", "notes.json") });
      expect(notes).toEqual({ note: "escape hatch" });
      await withProtectedWrite(snapshotPath, "put", () => store.put({ kind: "json", key: snapshotAlias, payload: { id: WORKFLOW_ID } }));
      expect(existsSync(snapshotPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** The coordinator merge: a real two-parent merge of the pinned source. */
function mergeFeature(fixture: GitFixture): string {
  git(
    ["-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--no-ff", fixture.planSha, "-m", "Merge plan-a"],
    fixture.integrationPath,
  );
  return headOf(fixture.integrationPath);
}






function snapshotWithoutRepairDelta(snapshot: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  delete copy.updated_at;
  const branch = copy.branch as Record<string, unknown> | undefined;
  if (branch !== undefined) delete branch.source;
  const plans = copy.plans as Array<Record<string, unknown>>;
  const coordination = plans[0]?.coordination as Record<string, unknown> | undefined;
  if (coordination !== undefined) delete coordination.revision;
  return copy;
}


/** A row with the fields the completion delta owns stripped out. */
function retainedRow(fixture: GitFixture): Record<string, unknown> {
  const row = { ...planRowOf(fixture, PLAN_ID) };
  delete row.status;
  delete row.coordination;
  delete row.execution_lease;
  return row;
}

describe("git-reconciliation", () => {
  test("integration start pins the base, accept proves the merge, complete releases both leases", async () => {
    const fixture = await acceptedFixture();
    const coordinatorSessionId = readJson(fixture.coordinatorSession).session_id;

    // An integration checkout that is dirty or on the wrong branch is never
    // merged into: the recorded target is re-checked, not assumed.
    writeText(join(fixture.integrationPath, "scratch.txt"), "wip\n");
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.integration-unresolved",
    );
    rmSync(join(fixture.integrationPath, "scratch.txt"), { force: true });
    git(["checkout", "-q", "-b", "stray-branch"], fixture.integrationPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.integration-diverged",
    );
    git(["checkout", "-q", "integration/plan-a"], fixture.integrationPath);
    expect(headOf(fixture.integrationPath)).toBe(fixture.baseSha);

    const started = await coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" });
    expect(started.outcome).toBe("integrating");
    const startedRow = planRowOf(fixture, PLAN_ID);
    expect(startedRow.status).toBe("InReview");
    expect(leaseHolder(startedRow)).toBe(coordinatorSessionId);
    const attempt = recordField(handoffFields(startedRow), "integration");
    expect(attempt.target_branch).toBe("integration/plan-a");
    expect(attempt.worktree_path).toBe(fixture.integrationPath);
    expect(attempt.base_sha).toBe(fixture.baseSha);
    expect(attempt.result_sha).toBeUndefined();
    expect(typeof attempt.started_at).toBe("string");
    const lease = recordField(snapshotOf(fixture), "integration_merge_lease");
    expect(lease.holder).toBe(coordinatorSessionId);
    expect(lease.plan_id).toBe(PLAN_ID);
    expect(lease.source_branch).toBe("feature/plan-a");
    expect(lease.target_branch).toBe("integration/plan-a");

    // Retrying a started attempt re-verifies and never re-pins the base.
    const pinned = readFileSync(fixture.snapshotPath, "utf8");
    const retry = await coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" });
    expect(retry.outcome).toBe("already-integrating");
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(pinned);

    // Nothing is proven by intent: an unmerged branch is not accepted.
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "integration-accept" }))).toBe(
      "coordination.integration-unresolved",
    );

    const mergeSha = mergeFeature(fixture);
    const accepted = await coordinatorCall(fixture, PLAN_ID, { kind: "integration-accept" });
    expect(accepted.outcome).toBe("merged");
    const mergedRow = planRowOf(fixture, PLAN_ID);
    expect(mergedRow.status).toBe("InReview");
    expect(leaseHolder(mergedRow)).toBe(coordinatorSessionId);
    expect(recordField(snapshotOf(fixture), "integration_merge_lease").holder).toBe(coordinatorSessionId);
    const mergedHandoff = handoffFields(mergedRow);
    expect(mergedHandoff.state).toBe("merged");
    expect(recordField(mergedHandoff, "integration").result_sha).toBe(mergeSha);

    // Complete is the one delta that releases both leases and sets Done.
    updatePlanRow(fixture, PLAN_ID, (row) => {
      const metadata = { ...(row.metadata as Record<string, unknown>), fixture_marker: "preserved" };
      delete metadata.working_branch;
      delete metadata.worktree_path;
      return { ...row, metadata };
    });
    const retainedBefore = retainedRow(fixture);
    const completed = await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
    expect(completed.outcome).toBe("completed");
    const doneRow = planRowOf(fixture, PLAN_ID);
    expect(doneRow.status).toBe("Done");
    expect(doneRow.execution_lease).toBeUndefined();
    expect(snapshotOf(fixture).integration_merge_lease).toBeUndefined();
    const doneHandoff = handoffFields(doneRow);
    expect(doneHandoff.state).toBe("completed");
    expect(recordField(doneHandoff, "integration").result_sha).toBe(mergeSha);
    expect(doneRow.metadata).toMatchObject({
      working_branch: doneHandoff.source_branch,
      worktree_path: doneHandoff.worktree_path,
    });
    expect(typeof doneHandoff.completed_at).toBe("string");
    // Existing metadata survives alongside the newly retained cleanup scope.
    expect(retainedRow(fixture)).toEqual({
      ...retainedBefore,
      metadata: {
        ...(retainedBefore.metadata as Record<string, unknown>),
        working_branch: doneHandoff.source_branch,
        worktree_path: doneHandoff.worktree_path,
      },
    });

    // Replay is read-only: nothing is re-acquired, nothing is rewritten.
    const doneBytes = readFileSync(fixture.snapshotPath, "utf8");
    const replayed = await coordinatorCall(fixture, PLAN_ID, { kind: "reconcile" });
    expect(replayed.outcome).toBe("already-completed");
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(doneBytes);
  }, 30000);

  test("reconcile classifies an interrupted attempt and never merges", async () => {
    // Started, nothing merged, base unmoved: the attempt is abandoned, not repaired.
    const retry = await acceptedFixture();
    await coordinatorCall(retry, PLAN_ID, { kind: "integration-start" });
    const retried = await coordinatorCall(retry, PLAN_ID, { kind: "reconcile" });
    expect(retried.outcome).toBe("retry-ready");
    const retryRow = planRowOf(retry, PLAN_ID);
    expect(retryRow.status).toBe("InReview");
    expect(leaseHolder(retryRow)).toBe(readJson(retry.coordinatorSession).session_id);
    const retryHandoff = handoffFields(retryRow);
    expect(retryHandoff.state).toBe("accepted");
    expect(retryHandoff.integration).toBeUndefined();
    expect(snapshotOf(retry).integration_merge_lease).toBeUndefined();
    expect(await errorCodeOf(() => coordinatorCall(retry, PLAN_ID, { kind: "complete" }))).toBe("coordination.invalid-transition");

    // A restarted attempt that does merge reconciles to the same completion
    // delta, in one write.
    const restarted = await coordinatorCall(retry, PLAN_ID, { kind: "integration-start" });
    expect(restarted.outcome).toBe("integrating");
    const provenSha = mergeFeature(retry);
    const reconciled = await coordinatorCall(retry, PLAN_ID, { kind: "reconcile" });
    expect(reconciled.outcome).toBe("completed");
    const provenRow = planRowOf(retry, PLAN_ID);
    expect(provenRow.status).toBe("Done");
    expect(provenRow.execution_lease).toBeUndefined();
    expect(snapshotOf(retry).integration_merge_lease).toBeUndefined();
    expect(recordField(handoffFields(provenRow), "integration").result_sha).toBe(provenSha);
    expect(provenRow.metadata).toMatchObject({
      working_branch: handoffFields(provenRow).source_branch,
      worktree_path: handoffFields(provenRow).worktree_path,
    });

    // A base that moved without a merge of the pinned source is divergence.
    const diverged = await acceptedFixture();
    await coordinatorCall(diverged, PLAN_ID, { kind: "integration-start" });
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "unrelated"], diverged.integrationPath);
    expect(await errorCodeOf(() => coordinatorCall(diverged, PLAN_ID, { kind: "reconcile" }))).toBe(
      "coordination.integration-diverged",
    );

    // A crash between accept and complete re-proves the *recorded* result.
    const merged = await acceptedFixture();
    await coordinatorCall(merged, PLAN_ID, { kind: "integration-start" });
    const recordedSha = mergeFeature(merged);
    await coordinatorCall(merged, PLAN_ID, { kind: "integration-accept" });
    const afterAccept = await coordinatorCall(merged, PLAN_ID, { kind: "reconcile" });
    expect(afterAccept.outcome).toBe("completed");
    const mergedDoneRow = planRowOf(merged, PLAN_ID);
    expect(mergedDoneRow.status).toBe("Done");
    expect(recordField(handoffFields(mergedDoneRow), "integration").result_sha).toBe(recordedSha);
  }, 30000);

  test("the merge lease is exclusive, the anchors are recorded, and the evidence stays sealed", async () => {
    // A foreign holder owns the merge lease: no takeover, no queueing.
    const leased = await acceptedFixture();
    writeJson(leased.snapshotPath, {
      ...snapshotOf(leased),
      integration_merge_lease: {
        holder: "coordinator-of-another-workflow",
        claimed_at: "2026-09-15T00:00:00Z",
        plan_id: PLAN_ID,
        source_branch: "feature/plan-a",
        target_branch: "integration/plan-a",
      },
    });
    expect(await errorCodeOf(() => coordinatorCall(leased, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.session-mismatch",
    );

    // Without a recorded integration target the call is unresolved, never
    // guessed from the current branch.
    const unanchored = await acceptedFixture();
    const stripped = { ...snapshotOf(unanchored) };
    delete stripped.integration_worktree_path;
    writeJson(unanchored.snapshotPath, stripped);
    expect(await errorCodeOf(() => coordinatorCall(unanchored, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.integration-unresolved",
    );

    // Evidence sealed at handoff is re-verified after the merge: a rewritten
    // report invalidates the attempt instead of being accepted.
    const stale = await acceptedFixture();
    await coordinatorCall(stale, PLAN_ID, { kind: "integration-start" });
    mergeFeature(stale);
    writeText(join(stale.sddDir, "review", "qc1.md"), "# rewritten after handoff\n");
    expect(await errorCodeOf(() => coordinatorCall(stale, PLAN_ID, { kind: "integration-accept" }))).toBe(
      "coordination.evidence-stale",
    );
  }, 30000);

  test("a force-moved integration HEAD voids an already-integrated proof (T1-E-008)", async () => {
    const fixture = await acceptedFixture();

    // The source reaches the integration branch *before* the attempt is pinned,
    // so the recorded base already carries it: the source is its ancestor and
    // the attempt would otherwise prove itself from the pinned objects alone.
    const pinnedBase = mergeFeature(fixture);
    const started = await coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" });
    expect(started.outcome).toBe("integrating");
    expect(recordField(handoffFields(planRowOf(fixture, PLAN_ID)), "integration").base_sha).toBe(pinnedBase);

    // The integration branch is force-moved below the pinned base. That commit
    // is still an object of the repository, but no longer reachable from the
    // current HEAD, so no merge in this checkout belongs to the attempt.
    git(["reset", "-q", "--hard", fixture.baseSha], fixture.integrationPath);
    expect(headOf(fixture.integrationPath)).toBe(fixture.baseSha);

    const before = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "integration-accept" }))).toBe(
      "coordination.integration-diverged",
    );
    // The refusal is non-advancing: no result is recorded and the attempt stays
    // open, so the leases and InReview are kept rather than half-released.
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
    const refused = handoffFields(planRowOf(fixture, PLAN_ID));
    expect(refused.state).toBe("integrating");
    expect(recordField(refused, "integration").result_sha).toBeUndefined();
  }, 30000);

  test("a merged attempt is never completed on a proof the live HEAD stopped reaching (PR241-G2)", async () => {
    const fixture = await acceptedFixture();
    await coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" });
    const mergeSha = mergeFeature(fixture);
    const accepted = await coordinatorCall(fixture, PLAN_ID, { kind: "integration-accept" });
    expect(accepted.outcome).toBe("merged");
    expect(recordField(handoffFields(planRowOf(fixture, PLAN_ID)), "integration").result_sha).toBe(mergeSha);

    // The recorded merge is still an object of the repository, but the
    // integration branch is force-moved below it. `complete` must re-prove the
    // recorded result against the HEAD it reads in its own locked precheck —
    // a final write that only re-reads the recorded bytes would accept it.
    git(["reset", "-q", "--hard", fixture.baseSha], fixture.integrationPath);
    expect(headOf(fixture.integrationPath)).toBe(fixture.baseSha);

    const before = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.integration-diverged",
    );
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    expect(handoffFields(planRowOf(fixture, PLAN_ID)).state).toBe("merged");

    // The replay path carries the same gate: reconcile re-reads the branch HEAD
    // instead of completing from the recorded bytes alone.
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "reconcile" }))).toBe(
      "coordination.integration-diverged",
    );
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
  }, 30000);
});

/**
 * S1 regression — the findings cleanup gate is evaluated **under the project
 * register write lock** (spec §C3, snapshot → register). Handoff is authorized
 * by that read, so an unlocked gate can be invalidated by a residual write that
 * lands between the read and the row commit it authorizes.
 *
 * The wall clock is the subject of this case: the finding has to land inside
 * the window in which the handoff is in flight, which no fake clock can express
 * (the interleave is between two real lock acquisitions). The holder keeps the
 * register lock for a short bounded window and writes the finding before
 * releasing it — the locked gate waits and observes it, while an unlocked gate
 * has already read `absent` and let the handoff through.
 */
describe("standalone-development-completion", () => {
  test("complete succeeds without integration fields and keeps the workflow running", async () => {
    const fixture = await acceptedStandaloneFixture();
    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect(view.allowed_operations).toContain("complete");
    expect(view.allowed_operations).not.toContain("integration-start");

    const completed = await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
    expect(completed.outcome).toBe("completed");
    expect(snapshotOf(fixture).status).toBe("running");
    const doneRow = planRowOf(fixture, PLAN_ID);
    expect(doneRow.status).toBe("Done");
    expect(doneRow.execution_lease).toBeUndefined();
    const doneHandoff = handoffFields(doneRow);
    expect(doneHandoff.state).toBe("completed");
    expect(doneHandoff.integration).toBeUndefined();
    expect(typeof doneHandoff.completed_at).toBe("string");
    expect((doneRow.metadata as Record<string, unknown>).working_branch).toBe("feature/plan-a");
    expect((doneRow.metadata as Record<string, unknown>).worktree_path).toBe(fixture.worktreePath);

    const doneBytes = readFileSync(fixture.snapshotPath, "utf8");
    const replayed = await coordinatorCall(fixture, PLAN_ID, { kind: "reconcile" });
    expect(replayed.outcome).toBe("already-completed");
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(doneBytes);
  }, 30000);

  test("report-only completion accepts matching policy evidence without integration or merge proof", async () => {
    const fixture = await acceptedStandaloneFixture();
    const snapshot = snapshotOf(fixture) as Record<string, unknown>;
    snapshot.delivery_kind = "verification/report-only";
    snapshot.completion_policy = "acceptance report";
    delete snapshot.branch;
    delete snapshot.integration_worktree_path;
    delete snapshot.integration_merge_lease;
    snapshot.delivery = { completion: { policy: "acceptance report", evidence: "report.md" } };
    writeJson(fixture.snapshotPath, snapshot);

    const completed = await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
    expect(completed.outcome).toBe("completed");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("Done");
    expect(planRowOf(fixture, PLAN_ID).execution_lease).toBeUndefined();
    expect(handoffFields(planRowOf(fixture, PLAN_ID)).integration).toBeUndefined();
    const doneBytes = readFileSync(fixture.snapshotPath, "utf8");
    expect((await coordinatorCall(fixture, PLAN_ID, { kind: "reconcile" })).outcome).toBe("already-completed");
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(doneBytes);
  }, 30000);

  test("delivery evidence refuses before Done and succeeds after Done with a full registered tail", async () => {
    const fixture = await acceptedStandaloneFixture();
    const before = readFileSync(fixture.snapshotPath);
    await expect(
      recordWorkflowDelivery(WORKFLOW_ID, fixture.workflowDir, {
        sessionPath: fixture.coordinatorSession,
        evidence: { compound: { outcome: "created" } },
        at: "2026-09-15T01:00:00Z",
      }),
    ).rejects.toThrow(/PHASE6_PLAN_ROW_NOT_DONE/);
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);

    await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
    await recordWorkflowDelivery(WORKFLOW_ID, fixture.workflowDir, {
      sessionPath: fixture.coordinatorSession,
      evidence: {
        compound: { outcome: "created" },
        pr: { repo: "btspoony/mstar-harness", head: "feature/plan-a", target: "main" },
        merge: { provider: "github", evidence: "PR #999 verified merged" },
      },
      at: "2026-09-15T02:00:00Z",
    });
    const closed = await closeWorkflow(WORKFLOW_ID, fixture.workflowDir, {
      sessionPath: fixture.coordinatorSession,
      endedAt: "2026-09-15T03:00:00Z",
    });
    expect(closed.status).toBe("completed");
    expect(closed.delivery?.merge?.provider).toBe("github");
  }, 30000);

  test("integration contamination, missing anchors and dirty checkout refuse without protected-byte changes", async () => {
    const contaminated = await acceptedStandaloneFixture();
    writeJson(contaminated.snapshotPath, {
      ...snapshotOf(contaminated),
      integration_worktree_path: join(contaminated.root, "extra-integration"),
    });
    const beforeContaminated = readFileSync(contaminated.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(contaminated, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readFileSync(contaminated.snapshotPath).equals(beforeContaminated)).toBe(true);

    const unanchored = await acceptedStandaloneFixture();
    writeJson(unanchored.snapshotPath, {
      ...snapshotOf(unanchored),
      branch: { target: "main" },
    });
    const beforeUnanchored = readFileSync(unanchored.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(unanchored, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readFileSync(unanchored.snapshotPath).equals(beforeUnanchored)).toBe(true);

    const dirty = await acceptedStandaloneFixture();
    writeText(join(dirty.worktreePath, "scratch.txt"), "wip\n");
    const beforeDirty = readFileSync(dirty.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(dirty, PLAN_ID, { kind: "complete" }))).toBe("coordination.git-proof");
    expect(readFileSync(dirty.snapshotPath).equals(beforeDirty)).toBe(true);
  }, 30000);

  test("a standalone source checkout moved after precheck never completes with stale git evidence", async () => {
    const fixture = await acceptedStandaloneFixture();
    const before = readFileSync(fixture.snapshotPath);
    setCompleteStandaloneMutateGapForTest(() => {
      git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "advance"], fixture.worktreePath);
    });
    try {
      expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "complete" }))).toBe("coordination.git-proof");
      expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
      expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    } finally {
      setCompleteStandaloneMutateGapForTest(undefined);
    }
  }, 30000);

  test("reconcile refuses malformed standalone completed handoff missing acceptance seals", async () => {
    const fixture = await acceptedStandaloneFixture();
    await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
    const row = planRowOf(fixture, PLAN_ID);
    const handoff = { ...handoffFields(row) };
    delete handoff.accepted_at;
    updatePlanRow(fixture, PLAN_ID, (current) => ({
      ...current,
      coordination: { ...(current.coordination as Record<string, unknown>), handoff },
    }));
    const before = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "reconcile" }))).toBe(
      "coordination.store",
    );
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
  }, 30000);

  test("iteration accepted handoff still refuses complete without integration (no standalone fallback)", async () => {
    const fixture = await acceptedFixture();
    const before = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);

    const unanchored = await acceptedFixture();
    const stripped = { ...snapshotOf(unanchored) };
    delete stripped.integration_worktree_path;
    writeJson(unanchored.snapshotPath, stripped);
    expect(await errorCodeOf(() => coordinatorCall(unanchored, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.integration-unresolved",
    );
  }, 30000);
});


describe("legacy-delivery-source-repair", () => {
  test("repairs only branch.source, row revision and updated_at while preserving PR/merge evidence", async () => {
    const fixture = await wrongSourceAcceptedFixture(true);
    const before = readFileSync(fixture.snapshotPath);
    const beforeView = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    const repaired = await coordinatorCall(fixture, PLAN_ID, { kind: "repair-delivery-source" });
    expect(repaired.outcome).toBe("delivery-source-repaired");
    const after = snapshotOf(fixture);
    expect(after.branch).toEqual({ source: "feature/plan-a", target: "main" });
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
    expect(handoffFields(planRowOf(fixture, PLAN_ID)).state).toBe("accepted");
    expect(after.delivery).toEqual(JSON.parse(before.toString()).delivery);
    expect(snapshotWithoutRepairDelta(after)).toEqual(snapshotWithoutRepairDelta(JSON.parse(before.toString())));
    expect(beforeView.revision + 1).toBe((await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root)).revision);
    expect(typeof after.updated_at).toBe("string");
    expect(after.updated_at).not.toBe(JSON.parse(before.toString()).updated_at);
  }, 30000);

  test("repairs identity on a fixture without PR/merge evidence", async () => {
    const fixture = await wrongSourceAcceptedFixture(false);
    const before = readFileSync(fixture.snapshotPath);
    const repaired = await coordinatorCall(fixture, PLAN_ID, { kind: "repair-delivery-source" });
    expect(repaired.outcome).toBe("delivery-source-repaired");
    expect(snapshotOf(fixture).branch).toEqual({ source: "feature/plan-a", target: "main" });
    expect(snapshotWithoutRepairDelta(snapshotOf(fixture))).toEqual(snapshotWithoutRepairDelta(JSON.parse(before.toString())));
  }, 30000);

  test("fresh-token second application refuses already-aligned without writes", async () => {
    const fixture = await wrongSourceAcceptedFixture(false);
    await coordinatorCall(fixture, PLAN_ID, { kind: "repair-delivery-source" });
    const aligned = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.already-aligned",
    );
    expect(readFileSync(fixture.snapshotPath).equals(aligned)).toBe(true);
  }, 30000);

  test("terminal, paused, unsupported, non-legacy and PR-conflict refusals are mutation-free", async () => {
    const terminal = await wrongSourceAcceptedFixture(false);
    const terminalSnap = snapshotOf(terminal);
    terminalSnap.status = "failed";
    terminalSnap.ended_at = "2026-09-15T01:00:00Z";
    terminalSnap.plans = (terminalSnap.plans as Array<Record<string, unknown>>).map((row) => {
      const { execution_lease, ...rest } = row;
      return rest;
    });
    writeJson(terminal.snapshotPath, terminalSnap);
    const beforeTerminal = readFileSync(terminal.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(terminal, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.terminal",
    );
    expect(readFileSync(terminal.snapshotPath).equals(beforeTerminal)).toBe(true);

    const paused = await wrongSourceAcceptedFixture(false);
    writeJson(paused.snapshotPath, { ...snapshotOf(paused), status: "paused" });
    const beforePaused = readFileSync(paused.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(paused, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readFileSync(paused.snapshotPath).equals(beforePaused)).toBe(true);

    const iteration = await acceptedFixture();
    const beforeIteration = readFileSync(iteration.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(iteration, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.unsupported-workflow",
    );
    expect(readFileSync(iteration.snapshotPath).equals(beforeIteration)).toBe(true);

    const alignedShape = await acceptedStandaloneFixture();
    const beforeAligned = readFileSync(alignedShape.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(alignedShape, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.already-aligned",
    );
    expect(readFileSync(alignedShape.snapshotPath).equals(beforeAligned)).toBe(true);

    const prConflict = await wrongSourceAcceptedFixture(true);
    const conflictSnap = snapshotOf(prConflict);
    conflictSnap.delivery = {
      ...(conflictSnap.delivery as Record<string, unknown>),
      pr: { repo: "btspoony/mstar-harness", head: "main", target: "main" },
    };
    writeJson(prConflict.snapshotPath, conflictSnap);
    const beforeConflict = readFileSync(prConflict.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(prConflict, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.pr-conflict",
    );
    expect(readFileSync(prConflict.snapshotPath).equals(beforeConflict)).toBe(true);
  }, 30000);

  test("stale revision, dirty checkout and missing accepted handoff refuse without protected-byte changes", async () => {
    const fixture = await wrongSourceAcceptedFixture(false);
    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    const before = readFileSync(fixture.snapshotPath);
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.coordinatorSession,
          planId: PLAN_ID,
          expectedRevision: view.revision - 1,
          operation: { kind: "repair-delivery-source", handoffId: view.row?.coordination?.handoff?.id ?? "missing" },
        }),
      ),
    ).toBe("coordination.version-conflict");
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);

    const dirty = await wrongSourceAcceptedFixture(false);
    writeText(join(dirty.worktreePath, "scratch.txt"), "wip\n");
    const beforeDirty = readFileSync(dirty.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(dirty, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.git-proof",
    );
    expect(readFileSync(dirty.snapshotPath).equals(beforeDirty)).toBe(true);

    const noHandoff = await wrongSourceAcceptedFixture(false);
    const staleHandoffId = String(handoffFields(planRowOf(noHandoff, PLAN_ID)).id);
    updatePlanRow(noHandoff, PLAN_ID, (row) => {
      const coordination = { ...(row.coordination as Record<string, unknown>) };
      delete coordination.handoff;
      return { ...row, coordination };
    });
    const beforeNoHandoff = readFileSync(noHandoff.snapshotPath);
    expect(
      await errorCodeOf(() =>
        coordinatorCall(noHandoff, PLAN_ID, { kind: "repair-delivery-source" }, staleHandoffId),
      ),
    ).toBe("coordination.delivery-source-repair.no-accepted-handoff");
    expect(readFileSync(noHandoff.snapshotPath).equals(beforeNoHandoff)).toBe(true);
  }, 30000);

  test("terminal and paused admission precede missing-handoff refusal", async () => {
    const terminal = await wrongSourceAcceptedFixture(false);
    const terminalSnap = snapshotOf(terminal);
    terminalSnap.status = "failed";
    terminalSnap.ended_at = "2026-09-15T01:00:00Z";
    terminalSnap.plans = (terminalSnap.plans as Array<Record<string, unknown>>).map((row) => {
      const { execution_lease, ...rest } = row;
      const coordination = { ...(row.coordination as Record<string, unknown>) };
      delete coordination.handoff;
      return { ...rest, coordination };
    });
    writeJson(terminal.snapshotPath, terminalSnap);
    const beforeTerminal = readFileSync(terminal.snapshotPath);
    expect(
      await errorCodeOf(() =>
        coordinatorCall(terminal, PLAN_ID, { kind: "repair-delivery-source" }, "missing-handoff"),
      ),
    ).toBe("coordination.delivery-source-repair.terminal");
    expect(readFileSync(terminal.snapshotPath).equals(beforeTerminal)).toBe(true);

    const paused = await wrongSourceAcceptedFixture(false);
    const pausedSnap = snapshotOf(paused);
    pausedSnap.status = "paused";
    pausedSnap.plans = (pausedSnap.plans as Array<Record<string, unknown>>).map((row) => {
      const coordination = { ...(row.coordination as Record<string, unknown>) };
      delete coordination.handoff;
      return { ...row, coordination };
    });
    writeJson(paused.snapshotPath, pausedSnap);
    const beforePaused = readFileSync(paused.snapshotPath);
    expect(
      await errorCodeOf(() =>
        coordinatorCall(paused, PLAN_ID, { kind: "repair-delivery-source" }, "missing-handoff"),
      ),
    ).toBe("coordination.invalid-transition");
    expect(readFileSync(paused.snapshotPath).equals(beforePaused)).toBe(true);
  }, 30000);

  test("integration contamination refuses not-legacy-shape for repair", async () => {
    const fixture = await wrongSourceAcceptedFixture(false);
    writeJson(fixture.snapshotPath, {
      ...snapshotOf(fixture),
      integration_worktree_path: join(fixture.root, "extra-integration"),
    });
    const before = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "repair-delivery-source" }))).toBe(
      "coordination.delivery-source-repair.not-legacy-shape",
    );
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
  }, 30000);
});

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

/**
 * Regression cases for the merged-state seam review (fix round 2). Each title
 * carries the finding id it pins, so a reverted fix turns exactly that case red.
 */
describe("seam-regressions", () => {
  /** A prepared plan whose bound session holds the row's execution lease. */
  async function claimedPlan(): Promise<GitFixture> {
    const fixture = await gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
    return fixture;
  }

  /** Drop the execution lease from a row the way a released owner leaves it. */
  function dropLease(fixture: Fixture, planId: string): void {
    updatePlanRow(fixture, planId, (row) => {
      const { execution_lease, ...rest } = row;
      return rest;
    });
  }

  test("prepare refuses a row that still carries an execution lease (T1-D-005)", async () => {
    const fixture = makeFixture();
    await ensureCoordinator(fixture);
    updatePlanRow(fixture, PLAN_ID, (row) => {
      const claimed = claimLease(row as never, "session-held", {
        worktree_path: fixture.worktreePath,
        working_branch: "feature/plan-a",
      });
      if (!claimed.ok) throw new Error("claim failed");
      return claimed.row;
    });

    const before = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => preparePlan(fixture, PLAN_ID))).toBe("coordination.duplicate-holder");
    // The row is still unprepared: the refusal never sealed a second owner.
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.coordination).toBeUndefined();
    expect(leaseHolder(row)).toBe("session-held");
  });

  test("a plan-owned write needs the row lease, while show and resume stay readable (T1-D-007)", async () => {
    const fixture = await claimedPlan();
    dropLease(fixture, PLAN_ID);

    // Reads stay available: a completed row carries no lease yet must report.
    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);
    expect(Array.isArray(view.allowed_operations)).toBe(true);

    const before = readFileSync(fixture.snapshotPath);
    const code = await errorCodeOf(() =>
      mutatePlanCoordination({
        sessionPath: fixture.planSession,
        planId: PLAN_ID,
        expectedRevision: view.revision,
        operation: {
          kind: "residual-add",
          entries: [finding("r-lease")] as never,
        },
      }),
    );
    expect(["coordination.invalid-transition", "coordination.session-mismatch"]).toContain(code);
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
    expect(existsSync(fixture.registerPath)).toBe(false);
  });

  test("accept refuses instead of no-op'ing when the row lease is gone (T1-E-006)", async () => {
    const fixture = await claimedPlan();
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    expect((await handoffCall(fixture, handoffEvidenceOf(fixture, fixture.planSha))).outcome).toBe("handed-off");
    dropLease(fixture, PLAN_ID);

    const before = readFileSync(fixture.snapshotPath);
    const code = await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "accept" }));
    expect(["coordination.invalid-transition", "coordination.session-mismatch"]).toContain(code);
    // The state never advances: still InReview, handoff still merely submitted.
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("InReview");
    expect(handoffFields(row).state).toBe("submitted");
  });

  test("return of a submitted handoff leaves the plan session holding its own lease (T1-D-004)", async () => {
    const fixture = await claimedPlan();
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    const planSessionId = readJson(fixture.planSession).session_id;
    expect((await handoffCall(fixture, handoffEvidenceOf(fixture, fixture.planSha))).outcome).toBe("handed-off");

    // A handoff that was never accepted goes back to the session that sealed it.
    expect((await coordinatorCall(fixture, PLAN_ID, { kind: "return", reason: "rework" })).outcome).toBe("returned");
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("InProgress");
    expect(leaseHolder(row)).toBe(planSessionId);
    expect(handoffFields(row).state).toBe("returned");
  });

  test("a coordinated row addressed only by its legacy plan_id is protected (T1-OWN-003)", async () => {
    const fixture = makeFixture();
    const harnessRoot = realpathSync(fixture.harness);
    await preparePlan(fixture, PLAN_ID);
    updatePlanRow(fixture, PLAN_ID, (row) => {
      const { id, ...rest } = row;
      return { ...rest, plan_id: id };
    });

    // The register kind is retired (issue authority): the replacement surface
    // refuses before any ownership scan, and no register is created.
    expect(
      await errorCodeOf(() =>
        replaceCoordinatedArtifact({
          harnessRoot,
          ref: { kind: "residuals", key: PROJECT_ID } as never,
          payload: { entries: { [PLAN_ID]: [] } },
          expectedVersion: "absent",
        }),
      ),
    ).toBe("coordination.store");
    expect(existsSync(fixture.registerPath)).toBe(false);
  });

  test("issue authority: a register on disk is never a runtime authority for the scoped mutation (T1-C3-009)", async () => {
    const fixture = makeFixture();
    await storeBacked(fixture, [PLAN_ID]);
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
    const view = await readPlanCoordination(fixture.planSession, PLAN_ID, fixture.root);

    // A legacy register (even a valid or malformed one) no longer backs the
    // mutation: residual-add goes to the issue store only and the register
    // bytes stay untouched.
    writeText(fixture.registerPath, "{}\n");
    const corrupted = readFileSync(fixture.registerPath);
    const snapshotBefore = readFileSync(fixture.snapshotPath);
    await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [finding("r-x")] as never },
    });
    expect(readFileSync(fixture.registerPath).equals(corrupted)).toBe(true);
    expect(readFileSync(fixture.snapshotPath).equals(snapshotBefore)).toBe(true);
    expect((await linkedOpenIssues(fixture, PLAN_ID)).map((issue) => issue.id)).toEqual(["I-000001"]);
  });

  test("a replacement that retains an existing uncoordinated workflow is judged, not rejected (T1-C4-011)", async () => {
    const fixture = makeFixture();
    const harnessRoot = realpathSync(fixture.harness);
    const statusPath = join(harnessRoot, "status.json");
    const before = readFileSync(statusPath);

    // Fresh entry objects for the very same workflow the root already names:
    // the guard judges the document set, not the caller's instances.
    const replaced = await replaceCoordinatedArtifact({
      harnessRoot,
      ref: { kind: "status", key: "root" } as const,
      payload: readJson(statusPath),
      expectedVersion: artifactVersion(before),
    });
    expect(replaced.version).toBe(artifactVersion(readFileSync(statusPath)));
    expect(readJson(statusPath).workflows).toEqual([expect.objectContaining({ id: WORKFLOW_ID })]);
  });

  test("handoff evidence must not carry a top-level worktree_path (T1-D-012)", async () => {
    const fixture = await claimedPlan();
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    const evidence = handoffEvidenceOf(fixture, fixture.planSha);

    // The worktree is derived from the scope; a caller-supplied one is refused.
    expect(
      await errorCodeOf(() => handoffCall(fixture, { ...evidence, worktree_path: fixture.worktreePath } as never)),
    ).toBe("coordination.forbidden-field");
    const handed = await handoffCall(fixture, evidence);
    expect(handed.outcome).toBe("handed-off");
    expect(handoffFields(planRowOf(fixture, PLAN_ID)).worktree_path).toBe(fixture.worktreePath);
  });

  test("a foreign merge lease is never reused or released (QC2-S2)", async () => {
    // A plan that has merged while holding the workflow's single merge lease for
    // its own attempt.
    const fixture = await acceptedFixture();
    await coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" });
    const mergeSha = mergeFeature(fixture);
    await coordinatorCall(fixture, PLAN_ID, { kind: "integration-accept" });
    const ownLease = recordField(snapshotOf(fixture), "integration_merge_lease");
    expect(ownLease.plan_id).toBe(PLAN_ID);
    const writeLease = (overrides: Record<string, unknown>): void => {
      writeJson(fixture.snapshotPath, {
        ...snapshotOf(fixture),
        integration_merge_lease: { ...ownLease, ...overrides },
      });
    };

    // The slot is workflow-wide, so a holder match is not ownership: a lease
    // naming another plan is refused, and the foreign claim survives intact.
    writeLease({ plan_id: PEER_PLAN_ID, source_branch: "feature/plan-b" });
    const foreign = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readFileSync(fixture.snapshotPath).equals(foreign)).toBe(true);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");

    // One plan can integrate more than once, so a lease for another source
    // branch of this same plan is not this attempt's claim either.
    writeLease({ source_branch: "feature/plan-a-old" });
    const stale = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "complete" }))).toBe(
      "coordination.invalid-transition",
    );
    expect(readFileSync(fixture.snapshotPath).equals(stale)).toBe(true);
    expect(recordField(snapshotOf(fixture), "integration_merge_lease").source_branch).toBe("feature/plan-a-old");

    // The attempt's own lease is still completable, and completing releases it.
    writeLease({});
    const done = await coordinatorCall(fixture, PLAN_ID, { kind: "complete" });
    expect(done.outcome).toBe("completed");
    expect(recordField(handoffFields(planRowOf(fixture, PLAN_ID)), "integration").result_sha).toBe(mergeSha);
    expect(snapshotOf(fixture).integration_merge_lease).toBeUndefined();
  }, 30000);

  test("a replaced handoff is never transitioned by a command that named the old one (QC1-F-001)", async () => {
    const fixture = await acceptedFixture();
    const replaced = handoffFields(planRowOf(fixture, PLAN_ID)).id;
    expect((await coordinatorCall(fixture, PLAN_ID, { kind: "return", reason: "rework requested" })).outcome).toBe("returned");
    writeText(join(fixture.worktreePath, "slice.txt"), "slice B v2\n");
    git(["add", "-A"], fixture.worktreePath);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix: rework"], fixture.worktreePath);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    await handoffCall(fixture, handoffEvidenceOf(fixture, headOf(fixture.worktreePath)));
    const live = handoffFields(planRowOf(fixture, PLAN_ID));
    expect(live.id).not.toBe(replaced);
    expect(live.attempt).toBe(2);

    // The id the caller read is a precondition of the mutation, not a hint: a
    // coordinator that read the replaced attempt can no longer act on whatever
    // is live when its command finally reaches the lock.
    const before = readFileSync(fixture.snapshotPath);
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "accept" }, replaced))).toBe(
      "coordination.invalid-transition",
    );
    expect(readFileSync(fixture.snapshotPath).equals(before)).toBe(true);
    const row = planRowOf(fixture, PLAN_ID);
    expect(row.status).toBe("InReview");
    expect(handoffFields(row).id).toBe(live.id);
    expect(handoffFields(row).state).toBe("submitted");

    // The named live attempt is the one the command may act on.
    expect((await coordinatorCall(fixture, PLAN_ID, { kind: "accept" })).outcome).toBe("accepted");
  }, 30000);

  test("a git that answers with a failure still reports a repository fact, not an environment fault (QC3-001)", async () => {
    const fixture = await acceptedFixture();
    rmSync(fixture.worktreePath, { recursive: true, force: true });
    // git exits non-zero here: the repository was reachable and said "no such
    // worktree", so the refusal stays a Git-fact refusal (`not-in-git`) — the
    // new environment code must not swallow it.
    expect(await errorCodeOf(() => coordinatorCall(fixture, PLAN_ID, { kind: "integration-start" }))).toBe(
      "coordination.not-in-git",
    );
  }, 30000);
});

/**
 * R2 — `gitRead` subprocess failure classification (spec §D2). A Git read that
 * never answers is unavailable evidence, not a repository answer: only a
 * numeric non-zero exit resolves to `undefined`; a read outliving the 10,000 ms
 * production timeout must surface the distinct public
 * `coordination.git-unavailable` code through an existing public operation.
 *
 * Each case prepares a valid handoff (real Git available) and then submits the
 * public handoff operation from its own child Bun process whose `PATH` holds
 * only that case's fixture directory, so the engine's real `execFileSync`
 * classifies a real subprocess outcome while the runner's PATH never changes.
 * Scope resolution consults Git before the handoff proof runs, so the fixture
 * `git` answers the scope probes by delegating to the real Git binary and
 * fails only the read `gitRead` itself makes — the documented production
 * scenario (a stalled filesystem, a contended lock). The hanging shim
 * exec-replaces into the runner's own Bun binary, so the killed child is the
 * shim itself and the fixture's cleanup reaps it.
 */
describe("gitRead subprocess failure classification", () => {
  /** How long a case child may run before the test kills and reaps it. */
  const CHILD_DEADLINE_MS = 60_000;

  /** What the child prints: the public operation's outcome or error shape. */
  type ChildHandoffReport = { outcome?: string; name?: string; code?: string; message?: string; cause?: string };

  /** A prepared, leased InReview plan with valid handoff evidence on disk. */
  async function handoffReadyFixture(): Promise<GitFixture> {
    const fixture = await gitFixture();
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    claimExecutionLease(fixture, PLAN_ID, fixture.planSession);
    updatePlanRow(fixture, PLAN_ID, (row) => ({ ...row, status: "InReview" }));
    return fixture;
  }

  function writeExecutable(path: string, lines: string[]): void {
    writeText(path, `${lines.join("\n")}\n`);
    chmodSync(path, 0o755);
  }

  /**
   * The fixture `git`: records every invocation, delegates to the real Git
   * binary, and handles only the target read (`git -C <worktree> rev-parse
   * HEAD`, the first read of the handoff proof) with the given body — so the
   * child really resolves `git` through its isolated PATH while the scope
   * probes still answer like the environment they model.
   */
  function writeFixtureGit(
    binDir: string,
    recordPath: string,
    worktreePath: string,
    targetBody: string[],
  ): void {
    // Resolve the real Git binary at fixture-write time (`command -v git`
    // equivalent) — hosts with Git outside /usr/bin keep the delegation
    // working, and a Git-less runner fails here loudly instead of inside
    // the child.
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("fixture delegation shim needs a real git on the runner PATH");
    writeExecutable(join(binDir, "git"), [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(recordPath)}`,
      `if [ "$1" = "-C" ] && [ "$2" = ${JSON.stringify(worktreePath)} ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then`,
      ...targetBody.map((line) => `  ${line}`),
      "fi",
      `exec ${JSON.stringify(realGit)} "$@"`,
    ]);
  }

  /**
   * Resume the prepared plan session in one child process and submit the
   * public handoff with `PATH` pointing only at `binDir`. The child reports
   * the surfaced error shape (code, cause, message) as one JSON line.
   */
  async function handoffInChildWithBinDir(
    fixture: GitFixture,
    evidence: HandoffEvidence,
    binDir: string,
  ): Promise<{ report: ChildHandoffReport; stderr: string; elapsedMs: number }> {
    const evidencePath = join(fixture.root, "handoff-evidence.json");
    writeJson(evidencePath, evidence);
    const scriptPath = join(fixture.root, "child-handoff.ts");
    writeText(scriptPath, [
      `import { readFileSync } from "node:fs";`,
      `import { bindPlanSession, mutatePlanCoordination, readPlanCoordination } from ${JSON.stringify(join(import.meta.dir, "..", "src", "coordination.ts"))};`,
      `import { createFsStore, setArtifactStore } from ${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))};`,
      `const [root, harness, planId, sessionPath, evidencePath] = process.argv.slice(2);`,
      `setArtifactStore(createFsStore(harness));`,
      `const resumed = await bindPlanSession({ resumePath: sessionPath, cwd: root });`,
      `if (resumed.outcome !== "resumed") throw new Error("bad resume: " + String(resumed.outcome));`,
      `const view = await readPlanCoordination(sessionPath, planId, root);`,
      `const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));`,
      `try {`,
      `  const handed = await mutatePlanCoordination({`,
      `    sessionPath,`,
      `    planId,`,
      `    expectedRevision: view.revision,`,
      `    operation: { kind: "handoff", evidence },`,
      `  });`,
      `  console.log(JSON.stringify({ outcome: handed.outcome }));`,
      `} catch (error) {`,
      `  const code = (error as { code?: unknown } | null)?.code;`,
      `  const cause = ((error as { details?: unknown } | null)?.details as { cause?: unknown } | undefined)?.cause;`,
      `  console.log(JSON.stringify({`,
      `    name: error instanceof Error ? error.name : typeof error,`,
      `    code: typeof code === "string" ? code : undefined,`,
      `    message: error instanceof Error ? error.message : String(error),`,
      `    cause: typeof cause === "string" ? cause : undefined,`,
      `  }));`,
      `}`,
      ``,
    ].join("\n"));

    await sealStoreForReaders(fixture);
    const startedAt = Date.now();
    const child = Bun.spawn(
      [process.execPath, scriptPath, fixture.root, fixture.harness, PLAN_ID, fixture.planSession, evidencePath],
      {
        cwd: fixture.root,
        stdout: "pipe",
        stderr: "pipe",
        // The child resolves `git` through this PATH alone; the runner's own
        // PATH is never modified. (A minimal hand-built env makes the child
        // Bun process die of SIGTERM at startup on macOS, so the runner env
        // is carried and only PATH is re-pointed.)
        env: { ...process.env, PATH: binDir },
      },
    );
    const exitedInTime = await Promise.race([
      child.exited.then(() => true),
      sleep(CHILD_DEADLINE_MS).then(() => false),
    ]);
    if (!exitedInTime) child.kill();
    const exitCode = await child.exited;
    const elapsedMs = Date.now() - startedAt;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(exitCode, `child stderr: ${stderr}\nchild stdout: ${stdout}`).toBe(0);
    return { report: JSON.parse(stdout) as ChildHandoffReport, stderr, elapsedMs };
  }

  test("a non-zero git exit stays a repository fact (not-in-git), not git-unavailable", async () => {
    const fixture = await handoffReadyFixture();
    const evidence = handoffEvidenceOf(fixture, fixture.planSha);
    const binDir = join(fixture.root, "bin-nonzero");
    const recordPath = join(fixture.root, "shim-invocations.log");
    mkdirSync(binDir);
    writeFixtureGit(binDir, recordPath, fixture.worktreePath, ["exit 3"]);

    const snapshotBefore = readFileSync(fixture.snapshotPath);
    const { report } = await handoffInChildWithBinDir(fixture, evidence, binDir);

    // The isolated PATH really was in effect: the scope probes went through
    // the fixture git, and the target read reached the handoff proof.
    const shims = readFileSync(recordPath, "utf8");
    expect(shims).toContain("worktree list");
    expect(shims).toContain("-C " + fixture.worktreePath + " rev-parse HEAD");
    // `git` answered the proof's read with a numeric status, so `gitRead`
    // resolves `undefined` and the feature-checkout proof keeps its existing
    // repository-answer code rather than the environment code.
    expect(report.code).toBe("coordination.not-in-git");
    expect(report.code).not.toBe("coordination.git-unavailable");
    expect(report.message).toContain(fixture.worktreePath);
    // The refusal is non-advancing: the InReview row and its lease are intact.
    expect(readFileSync(fixture.snapshotPath).equals(snapshotBefore)).toBe(true);
  }, 90_000);

  test("a git read that outlives the production timeout is refused as git-unavailable", async () => {
    const fixture = await handoffReadyFixture();
    const evidence = handoffEvidenceOf(fixture, fixture.planSha);
    const binDir = join(fixture.root, "bin-hanging");
    const recordPath = join(fixture.root, "shim-invocations.log");
    mkdirSync(binDir);
    // The target read exec-replaces into the runner's own Bun binary: no
    // /usr/bin/env, no PATH-resolved sleep, no recursive git, and the process
    // the production timeout kills is the direct child itself.
    const hangScript = join(fixture.root, "hang-forever.js");
    writeText(hangScript, "setInterval(() => {}, 600000);\n");
    writeFixtureGit(binDir, recordPath, fixture.worktreePath, [
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(hangScript)}`,
    ]);

    const snapshotBefore = readFileSync(fixture.snapshotPath);
    const { report, elapsedMs } = await handoffInChildWithBinDir(fixture, evidence, binDir);

    // The shim really ran, and hung on the handoff proof's read.
    const shims = readFileSync(recordPath, "utf8");
    expect(shims).toContain("worktree list");
    expect(shims).toContain("-C " + fixture.worktreePath + " rev-parse HEAD");
    // The refusal came from the production timeout firing, not an instant
    // failure, and stays inside the child deadline with cleanup margin.
    expect(elapsedMs).toBeGreaterThanOrEqual(9_000);
    expect(elapsedMs).toBeLessThan(CHILD_DEADLINE_MS);
    expect(report.code).toBe("coordination.git-unavailable");
    // The cause is the timed-out read — the distinct unavailable-Git cause.
    expect(report.cause).toContain("git did not answer within 10000ms");
    expect(readFileSync(fixture.snapshotPath).equals(snapshotBefore)).toBe(true);
  }, 90_000);

  test("a missing git executable is refused as git-unavailable at the handoff proof", async () => {
    const fixture = await handoffReadyFixture();
    const evidence = handoffEvidenceOf(fixture, fixture.planSha);
    // An isolated PATH dir with nothing in it: the child's spawn of `git`
    // fails for real (ENOENT) — no shim, no mock, no production helper.
    const binDir = join(fixture.root, "bin-empty");
    mkdirSync(binDir);

    const snapshotBefore = readFileSync(fixture.snapshotPath);
    const { report } = await handoffInChildWithBinDir(fixture, evidence, binDir);

    // The refusal carries the spawn failure, not a repository answer: the
    // proof's read never ran, so nothing can claim a branch fact.
    expect(report.code).toBe("coordination.git-unavailable");
    expect(report.code).not.toBe("coordination.not-in-git");
    expect(report.cause).toContain("ENOENT");
    // The failed read is the handoff proof's own read at the pinned worktree,
    // proving the failure surfaced at the public handoff operation.
    expect(report.message).toContain(fixture.worktreePath);
    expect(report.message).toContain("git rev-parse HEAD");
    // The refusal is non-advancing: the InReview row and its lease are intact.
    expect(readFileSync(fixture.snapshotPath).equals(snapshotBefore)).toBe(true);
  }, 90_000);
});

/* ------------------------------------------------------------------ *
 * Prepare workflow amendment — the guarded, coordinator-authenticated
 * Prepare-stage amendment contract § Admission and mutation. Every case drives
 * the real engine against a temporary Git repository, a genuine coordinator
 * bind, a real integration worktree and a reviewed compass, and asserts the
 * protected bytes rather than implementation text.
 * ------------------------------------------------------------------ */

const PREPARE_WORKFLOW = "wf-prepare";
const PREPARE_PEER = "wf-peer";
const PREPARE_ROW = "plan-prepare";
const PREPARE_APPEND = "plan-append";
const PREPARE_UNREVIEWED = "plan-unreviewed";
const PREPARE_SPEC = "amendment-contract.md";
const PREPARE_INTEGRATION_BRANCH = "integration/wf-prepare";

type PrepareFixture = {
  root: string;
  harness: string;
  workflowDir: string;
  snapshotPath: string;
  statusPath: string;
  compassPath: string;
  integrationPath: string;
  peerSnapshotPath: string;
  planDir: string;
  specPath: string;
  /** Filled in by the first coordinator bind (the engine picks the path). */
  coordinatorSession: string;
};

/** A plan markdown carrying the headers the amendment cross-checks. */
function preparePlanMarkdown(input: { id: string; workingBranch: string; mainBranch?: string }): string {
  return [
    `# Plan ${input.id}`,
    "",
    `**plan_id:** ${input.id}`,
    "**Status:** Todo",
    `**Main worktree branch:** ${input.mainBranch ?? "main"}`,
    `**Working branch:** ${input.workingBranch}`,
    "",
    "Body.",
    "",
  ].join("\n");
}

/**
 * A Prepare lifecycle that the amendment is meant to serve: one Todo row with
 * no coordination state, `phase-1-prepare`, a reviewed compass declaring two
 * plans, a real distinct integration checkout, and a sibling workflow whose
 * bytes must never move.
 */
function makePrepareFixture(): PrepareFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-prepare-amend-")));
  roots.push(root);
  git(["init", "-q", "-b", "main"], root);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], root);

  const harness = join(root, ".mstar");
  const workflowDir = join(harness, "workflows", PREPARE_WORKFLOW);
  const snapshotPath = join(workflowDir, "snapshot.json");
  const statusPath = join(harness, "status.json");
  const compassPath = join(harness, "iterations", PREPARE_WORKFLOW, "delivery-compass.md");
  const integrationPath = join(root, "wt-integration");
  const peerSnapshotPath = join(harness, "workflows", PREPARE_PEER, "snapshot.json");
  const planDir = join(harness, "plans");
  const specPath = join(harness, "specs", PREPARE_SPEC);

  for (const id of [PREPARE_ROW, PREPARE_APPEND, PREPARE_UNREVIEWED]) {
    writeText(join(planDir, `${id}.md`), preparePlanMarkdown({ id, workingBranch: `feature/${id}` }));
  }
  writeText(specPath, "# primary spec\n");
  writeText(
    compassPath,
    [
      "---",
      `iteration_id: ${PREPARE_WORKFLOW}`,
      "status: locked",
      "iteration_base_branch: main",
      `spec_integration_branch: ${PREPARE_INTEGRATION_BRANCH}`,
      "target_branch: main",
      "plans:",
      `  - ${PREPARE_ROW}`,
      `  - ${PREPARE_APPEND}`,
      "---",
      "",
      "# Compass",
      "",
    ].join("\n"),
  );
  // The reviewed integration checkout: a real, distinct checkout on the
  // workflow's own integration branch.
  git(["worktree", "add", "-q", "-b", PREPARE_INTEGRATION_BRANCH, integrationPath], root);

  writeJson(statusPath, {
    version: 2,
    updated_at: "2026-09-16",
    workflows: [
      {
        id: PREPARE_WORKFLOW,
        status: "running",
        type: "iteration",
        started_at: "2026-09-16",
        dir: `workflows/${PREPARE_WORKFLOW}`,
      },
      {
        id: PREPARE_PEER,
        status: "running",
        type: "iteration",
        started_at: "2026-09-16",
        dir: `workflows/${PREPARE_PEER}`,
      },
    ],
  });
  writeJson(snapshotPath, {
    schema_version: 1,
    id: PREPARE_WORKFLOW,
    type: "iteration",
    status: "running",
    phase: "phase-1-prepare",
    started_at: "2026-09-16",
    updated_at: "2026-09-16",
    compass_ref: `iterations/${PREPARE_WORKFLOW}/delivery-compass.md`,
    branch: { base: "main", integration: PREPARE_INTEGRATION_BRANCH, target: "main" },
    execution_policy: { plan_parallelism: "serial", worktree_mode: "required" },
    plans: [planRow(PREPARE_ROW, PROJECT_ID, `feature/${PREPARE_ROW}`)],
  });
  writeJson(peerSnapshotPath, {
    schema_version: 1,
    id: PREPARE_PEER,
    type: "iteration",
    status: "running",
    phase: "phase-1-prepare",
    started_at: "2026-09-16",
    updated_at: "2026-09-16",
    plans: [planRow("plan-peer", PROJECT_ID)],
  });

  setArtifactStore(createFsStore(harness));
  return {
    root,
    harness,
    workflowDir,
    snapshotPath,
    statusPath,
    compassPath,
    integrationPath,
    peerSnapshotPath,
    planDir,
    specPath,
    coordinatorSession: "",
  };
}

/** The authoritative snapshot document, with its row array narrowed. */
function prepareSnapshotOf(fixture: PrepareFixture): { plans: Array<Record<string, unknown>> } & Record<string, unknown> {
  const doc = readJson(fixture.snapshotPath);
  if (!Array.isArray(doc.plans)) throw new Error("prepare fixture snapshot has no plans array");
  return doc as { plans: Array<Record<string, unknown>> } & Record<string, unknown>;
}

/** Bind the lifecycle coordinator once per fixture with an explicitly acquired id. */
async function ensurePrepareCoordinator(fixture: PrepareFixture): Promise<string> {
  if (fixture.coordinatorSession === "") {
    const bound = await bindPlanSession({
      coordinator: true,
      workflowId: PREPARE_WORKFLOW,
      harnessDir: fixture.harness,
      cwd: fixture.root,
      sessionId: FIXTURE_COORDINATOR_ID,
    });
    expect(bound.ok).toBe(true);
    fixture.coordinatorSession = bound.session_file;
  }
  return fixture.coordinatorSession;
}

/** The workflow-level view (`show-prepare`) through a coordinator envelope. */
function prepareViewOf(fixture: PrepareFixture, sessionPath = fixture.coordinatorSession): Promise<PrepareWorkflowResult> {
  return showPrepareWorkflow({ sessionPath, cwd: fixture.root });
}

/** Amend with the tokens a fresh view reports (the reviewed-token route). */
async function amendPrepare(fixture: PrepareFixture, patch: unknown): Promise<PrepareWorkflowResult> {
  const view = await prepareViewOf(fixture);
  return amendWith(fixture, patch, { snapshotVersion: view.view.snapshotVersion, compassVersion: view.view.compassVersion });
}

/** Amend with the exact tokens the caller already holds. */
function amendWith(
  fixture: PrepareFixture,
  patch: unknown,
  tokens: { snapshotVersion: string; compassVersion: string; sessionPath?: string; cwd?: string },
): Promise<PrepareWorkflowResult> {
  return amendPrepareWorkflow({
    sessionPath: tokens.sessionPath ?? fixture.coordinatorSession,
    cwd: tokens.cwd ?? fixture.root,
    expectedSnapshotVersion: tokens.snapshotVersion,
    expectedCompassVersion: tokens.compassVersion,
    patch: patch as unknown as PrepareWorkflowPatch,
  });
}

/** The refusal code and details of a call that must refuse. */
async function prepareRefusalOf(run: () => Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> {
  const failure = await failureOf(run);
  if (failure instanceof CoordinationError) return { code: failure.code, details: failure.details };
  throw failure;
}

/** The error any failing call throws (`registerWorkflow` throws a plain Error). */
async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the call to fail");
}

/**
 * Activate an instrument through the REAL local store, and return it. Scoped
 * coordination is served only by the store `createFsStore` created: an injected
 * foreign store is wrapped by `guardedInjectedStore` and keeps no `root` claim,
 * so `localStore` refuses it (`coordination.local-store-required`) before the
 * instrument's ports are ever consulted. An instrument that must be reached
 * through the coordination surface therefore installs its ports — and its
 * claimed root, the consultation a window can trigger on — on that same
 * instance, instead of standing in for it. The instrument receives the
 * ORIGINAL ports as its `inner`, so its pass-through calls cannot recurse into
 * itself.
 */
function instrumentLocalStore<T extends ArtifactStore & { root: string }>(
  harness: string,
  build: (inner: ArtifactStore & { root: string }) => T,
): T {
  const local = createFsStore(harness);
  const originalPut = local.put;
  const originalGet = local.get;
  const inner: ArtifactStore & { root: string } = {
    root: local.root,
    put: (doc) => originalPut(doc),
    get: <R>(ref: ArtifactRef) => originalGet<R>(ref),
  };
  const instrument = build(inner);
  local.put = (doc) => instrument.put(doc);
  local.get = <R>(ref: ArtifactRef) => instrument.get<R>(ref);
  Object.defineProperty(local, "root", { configurable: true, get: () => instrument.root });
  setArtifactStore(local);
  return instrument;
}

/**
 * A store double standing in for a harness where a competing writer is active.
 *
 * A competing writer reaches the snapshot the moment the write lock is free, so
 * a version read taken *after* the critical section can name that writer's
 * commit instead of this call's. The double publishes its own valid version of
 * the document this call committed at the engine's next store consultation once
 * the commit is on disk and the lockdir is gone — the earliest point the engine
 * itself hands control back after the commit. `publishCompetitor` drives the
 * same commit explicitly, so a case asserts which commit the returned token
 * names without depending on when the engine consults the store again.
 */
class CompetingCommitStore implements ArtifactStore {
  /** Byte version of the snapshot this call committed. */
  commitVersion = "";
  /** Byte version of the competing commit (empty until it lands). */
  competingVersion = "";
  private committed: Record<string, unknown> | undefined;
  private published = false;

  constructor(
    private readonly inner: ArtifactStore & { root: string },
    private readonly snapshotPath: string,
    private readonly lockDir: string,
    private readonly competitorStamp: string,
  ) {}

  get root(): string {
    this.publish();
    return this.inner.root;
  }

  async put(doc: ArtifactDoc): Promise<void> {
    await this.inner.put(doc);
    if (doc.kind !== "snapshot") return;
    this.committed = doc.payload as Record<string, unknown>;
    this.commitVersion = readArtifactBytes(this.snapshotPath)?.version ?? "";
  }

  async get<T = unknown>(ref: ArtifactRef): Promise<T | undefined> {
    return this.inner.get<T>(ref);
  }

  /** Commit the competitor's version now — the writer that took the free lock. */
  publishCompetitor(): string {
    this.publish();
    return this.competingVersion;
  }

  private publish(): void {
    // The lock is the competitor's only gate: while this call holds it no other
    // writer can commit, so only a free lock is the window.
    if (this.committed === undefined || this.published || existsSync(this.lockDir)) return;
    this.published = true;
    writeFileSync(
      this.snapshotPath,
      `${JSON.stringify({ ...this.committed, updated_at: this.competitorStamp }, null, 2)}\n`,
    );
    this.competingVersion = readArtifactBytes(this.snapshotPath)?.version ?? "";
  }
}

/** Every protected artifact one refused amendment must leave untouched. */
function protectedBytes(fixture: PrepareFixture): Record<string, string> {
  return {
    snapshot: readFileSync(fixture.snapshotPath, "utf8"),
    status: readFileSync(fixture.statusPath, "utf8"),
    compass: readFileSync(fixture.compassPath, "utf8"),
    peer: readFileSync(fixture.peerSnapshotPath, "utf8"),
    session: readFileSync(fixture.coordinatorSession, "utf8"),
  };
}

/** One plan append carrying this workflow's own references. */
function prepareAppendOf(
  fixture: PrepareFixture,
  id: string,
  entry: Record<string, unknown> = {},
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: `Plan ${id}`,
    file: join(fixture.planDir, `${id}.md`),
    metadata: {
      primary_spec: fixture.specPath,
      spec_refs: [fixture.specPath],
      iteration_compass: fixture.compassPath,
      iteration_refs: [fixture.compassPath],
      working_branch: `feature/${id}`,
      spec_integration_branch: PREPARE_INTEGRATION_BRANCH,
      merge_target: PREPARE_INTEGRATION_BRANCH,
      ...metadata,
    },
    ...entry,
  };
}

/**
 * One patch: the approved append plus whatever the case overrides. The base
 * patch is append-only — it names no integration checkout and no policy — so a
 * case that needs either supplies it explicitly and a case that omits them
 * exercises the omission deliberately.
 */
function preparePatchOf(fixture: PrepareFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mainWorktreeBranch: "main",
    appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND)],
    ...overrides,
  };
}

describe("Prepare workflow amendment", () => {
  test("show-prepare reports the raw-byte versions and the admission view of a Prepare workflow", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);

    const view = await prepareViewOf(fixture);

    expect(view.ok).toBe(true);
    expect(view.operation).toBe("show-prepare");
    expect(view.session.role).toBe("coordinator");
    expect(view.session_file).toBe(fixture.coordinatorSession);
    expect(view.view.workflowId).toBe(PREPARE_WORKFLOW);
    expect(view.view.planIds).toEqual([PREPARE_ROW]);
    expect(view.view.allowed).toBe(true);
    expect(view.view.blockers).toEqual([]);
    // The tokens are the bytes on disk, computed independently here.
    expect(view.view.snapshotVersion).toBe(`sha256:${sha256OfFile(fixture.snapshotPath)}`);
    expect(view.view.compassVersion).toBe(`sha256:${sha256OfFile(fixture.compassPath)}`);
    // A read writes nothing.
    expect(protectedBytes(fixture)).toEqual(before);
  });

  test("amend-prepare appends the approved row and records the integration checkout and parallelism, preserving every prior value", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);
    const beforeSnapshot = prepareSnapshotOf(fixture);
    const oldRow = beforeSnapshot.plans[0]!;
    const beforeView = await prepareViewOf(fixture);

    const amended = await amendPrepare(
      fixture,
      preparePatchOf(fixture, { integrationWorktreePath: fixture.integrationPath, planParallelism: "parallel" }),
    );

    expect(amended.ok).toBe(true);
    expect(amended.operation).toBe("amend-prepare");
    expect(amended.outcome).toBe("amended");
    expect(amended.view.allowed).toBe(true);
    expect(amended.view.blockers).toEqual([]);
    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(amended.view.compassVersion).toBe(beforeView.view.compassVersion);
    expect(amended.view.snapshotVersion).not.toBe(beforeView.view.snapshotVersion);
    expect(amended.view.snapshotVersion).toBe(`sha256:${sha256OfFile(fixture.snapshotPath)}`);

    const after = prepareSnapshotOf(fixture);
    // The prior row is preserved by value and by position; nothing is rewritten.
    expect(after.plans[0]).toEqual(oldRow);
    expect(after.plans).toHaveLength(2);
    const appended = after.plans[1]!;
    expect(appended.id).toBe(PREPARE_APPEND);
    expect(appended.plan_id).toBeUndefined();
    expect(appended.title).toBe(`Plan ${PREPARE_APPEND}`);
    expect(appended.file).toBe(join(fixture.planDir, `${PREPARE_APPEND}.md`));
    expect(appended.status).toBe("Todo");
    expect(appended.owner).toBe("project-manager");
    expect(appended.progress).toBe(0);
    expect(appended.execution_lease).toBeUndefined();
    expect(appended.coordination).toBeUndefined();
    expect(typeof appended.created_at).toBe("string");
    expect(appended.metadata).toEqual({
      primary_spec: fixture.specPath,
      spec_refs: [fixture.specPath],
      iteration_compass: fixture.compassPath,
      iteration_refs: [fixture.compassPath],
      working_branch: `feature/${PREPARE_APPEND}`,
      spec_integration_branch: PREPARE_INTEGRATION_BRANCH,
      merge_target: PREPARE_INTEGRATION_BRANCH,
    });
    // Only the whitelisted projections and `updated_at` moved; the lifecycle
    // anchors, the coordinator binding and the sibling workflow did not.
    expect(after.integration_worktree_path).toBe(fixture.integrationPath);
    expect(after.execution_policy).toEqual({ plan_parallelism: "parallel", worktree_mode: "required" });
    expect(after.branch).toEqual({ base: "main", integration: PREPARE_INTEGRATION_BRANCH, target: "main" });
    expect(after.compass_ref).toBe(`iterations/${PREPARE_WORKFLOW}/delivery-compass.md`);
    expect(after.coordination).toEqual(beforeSnapshot.coordination);
    expect(after.started_at).toBe("2026-09-16");
    expect(after.phase).toBe("phase-1-prepare");
    expect(after.status).toBe("running");
    expect(readFileSync(fixture.statusPath, "utf8")).toBe(before.status);
    expect(readFileSync(fixture.compassPath, "utf8")).toBe(before.compass);
    expect(readFileSync(fixture.peerSnapshotPath, "utf8")).toBe(before.peer);
    expect(readFileSync(fixture.coordinatorSession, "utf8")).toBe(before.session);

    // A second show reports exactly the committed bytes.
    const afterView = await prepareViewOf(fixture);
    expect(afterView.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(afterView.view.snapshotVersion).toBe(amended.view.snapshotVersion);
    expect(afterView.view.allowed).toBe(true);
  });

  test("both real plan-header forms are read by value: `**Label:** v` and `**Label**: v`", async () => {
    // Every other case writes the dominant form (the colon inside the bold).
    // The bootstrap plan's own header block writes the colon after the bold,
    // and its branch fields must read the same. A real reviewed plan also
    // carries the descriptive `**Working branch policy:**` line beside its
    // `**Working branch:**` declaration; the policy is prose about the branch,
    // never the branch value.
    const colonAfterBold = makePrepareFixture();
    await ensurePrepareCoordinator(colonAfterBold);
    writeText(
      join(colonAfterBold.planDir, `${PREPARE_APPEND}.md`),
      [
        `# Plan ${PREPARE_APPEND}`,
        "",
        `**plan_id:** ${PREPARE_APPEND}`,
        "**Status:** Todo",
        "**Main worktree branch**: main",
        `**Working branch:** feature/${PREPARE_APPEND}`,
        "**Working branch policy:** Feature worktree from the integration branch; merge back into that integration branch.",
        "",
        "Body.",
        "",
      ].join("\n"),
    );

    const amended = await amendPrepare(colonAfterBold, preparePatchOf(colonAfterBold));

    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    const acceptedRows = prepareSnapshotOf(colonAfterBold).plans;
    expect(acceptedRows).toHaveLength(2);
    // The accepted row carries the branch the `Working branch` header declares,
    // not the policy sentence beside it.
    expect(acceptedRows[1]!.metadata).toMatchObject({ working_branch: `feature/${PREPARE_APPEND}` });

    // The same form declaring another branch refuses: the parsed value is
    // compared, never swallowed into the markup.
    const mismatch = makePrepareFixture();
    await ensurePrepareCoordinator(mismatch);
    writeText(
      join(mismatch.planDir, `${PREPARE_APPEND}.md`),
      [
        `# Plan ${PREPARE_APPEND}`,
        "",
        `**plan_id:** ${PREPARE_APPEND}`,
        "**Main worktree branch**: trunk",
        `**Working branch**: feature/${PREPARE_APPEND}`,
        "",
        "Body.",
        "",
      ].join("\n"),
    );

    const refusal = await prepareRefusalOf(() => amendPrepare(mismatch, preparePatchOf(mismatch)));
    expect(refusal.code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(refusal.details.expected).toBe("trunk");
    expect(refusal.details.actual).toBe("main");
  });

  test("only the consulted headers refuse a conflict, and a fence closes only on its own marker", async () => {
    // A real multi-task plan repeats its body labels — `**Files:**`,
    // `**Interfaces:**`, `**Task budget:**` — with a different value per task.
    // Only the labels this verb consults are declarations, so the repeat is
    // plan content and the document stays appendable.
    const multiTask = makePrepareFixture();
    await ensurePrepareCoordinator(multiTask);
    writeText(
      join(multiTask.planDir, `${PREPARE_APPEND}.md`),
      [
        `# Plan ${PREPARE_APPEND}`,
        "",
        `**plan_id:** ${PREPARE_APPEND}`,
        "**Status:** Todo",
        "**Main worktree branch:** main",
        `**Working branch:** feature/${PREPARE_APPEND}`,
        "",
        "## Task 1",
        "",
        "**Files:** packages/engine/src/coordination.ts",
        "**Task budget:** 60k",
        "",
        "## Task 2",
        "",
        "**Files:** packages/cli/src/plan-coordination.ts",
        "**Task budget:** 20k",
        "",
      ].join("\n"),
    );

    const amended = await amendPrepare(multiTask, preparePatchOf(multiTask));

    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);

    // A consulted label repeated with a different value is still a conflict.
    const conflicting = makePrepareFixture();
    await ensurePrepareCoordinator(conflicting);
    writeText(
      join(conflicting.planDir, `${PREPARE_APPEND}.md`),
      [
        `# Plan ${PREPARE_APPEND}`,
        "",
        `**plan_id:** ${PREPARE_APPEND}`,
        "**plan_id:** plan-other",
        "**Status:** Todo",
        "**Main worktree branch:** main",
        `**Working branch:** feature/${PREPARE_APPEND}`,
        "",
        "Body.",
        "",
      ].join("\n"),
    );

    const conflict = await prepareRefusalOf(() => amendPrepare(conflicting, preparePatchOf(conflicting)));

    expect(conflict.code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(conflict.details.header).toBe("plan_id");

    // A fenced example is never a declaration, whatever marker opened the
    // block: a `~~~` block is not read at all, and a shorter backtick run
    // inside a longer fence does not close it early.
    const fenceCases: ReadonlyArray<{ name: string; lines: readonly string[] }> = [
      { name: "tilde-fence", lines: ["~~~md", "**plan_id:** plan-example", "~~~"] },
      { name: "shorter-run-inside-longer-fence", lines: ["````md", "```", "**plan_id:** plan-example", "```", "````"] },
    ];

    for (const fenceCase of fenceCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      writeText(
        join(fixture.planDir, `${PREPARE_APPEND}.md`),
        [
          `# Plan ${PREPARE_APPEND}`,
          "",
          `**plan_id:** ${PREPARE_APPEND}`,
          "**Status:** Todo",
          "**Main worktree branch:** main",
          `**Working branch:** feature/${PREPARE_APPEND}`,
          "",
          ...fenceCase.lines,
          "",
          "Body.",
          "",
        ].join("\n"),
      );

      const fenced = await amendPrepare(fixture, preparePatchOf(fixture));

      expect(`${fenceCase.name}: ${fenced.view.planIds.join()}`).toBe(
        `${fenceCase.name}: ${[PREPARE_ROW, PREPARE_APPEND].join()}`,
      );
    }
  }, 30000);

  test("both reviewed branch headers are required on an appended plan", async () => {
    // The plan document is the reviewed authority for the branch metadata: an
    // absent header is never treated as agreement with the branches the append
    // itself claims, and the descriptive `Working branch policy` line beside it
    // is prose — it cannot stand in for the `Working branch` declaration.
    const planCases: ReadonlyArray<{
      name: string;
      lines: readonly string[];
      /** The declaration the refusal must name as missing. */
      field: string;
      header: string;
    }> = [
      {
        name: "working-branch-policy-only",
        lines: [
          `**plan_id:** ${PREPARE_APPEND}`,
          "**Status:** Todo",
          "**Main worktree branch:** main",
          "**Working branch policy:** Feature worktree from the integration branch; merge back into that integration branch.",
        ],
        field: "metadata.working_branch",
        header: "Working branch",
      },
      {
        name: "missing-main-worktree-branch",
        lines: [`**plan_id:** ${PREPARE_APPEND}`, "**Status:** Todo", `**Working branch:** feature/${PREPARE_APPEND}`],
        field: "mainWorktreeBranch",
        header: "Main worktree branch",
      },
    ];

    for (const planCase of planCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const planPath = join(fixture.planDir, `${PREPARE_APPEND}.md`);
      writeText(planPath, [`# Plan ${PREPARE_APPEND}`, "", ...planCase.lines, "", "Body.", ""].join("\n"));
      const before = protectedBytes(fixture);

      const failure = await failureOf(() => amendPrepare(fixture, preparePatchOf(fixture)));
      if (!(failure instanceof CoordinationError)) throw failure;

      const label = `${planCase.name}: `;
      expect(`${label}${failure.code}`).toBe(`${label}coordination.prepare-amendment.invalid-plan`);
      // The refusal names the missing declaration, the row and the reviewed
      // file as facts, so it stays actionable without pinning one sentence.
      expect(failure.message).toContain(planCase.header);
      expect(failure.message).toContain(planPath);
      expect(failure.details).toMatchObject({ plan_id: PREPARE_APPEND, field: planCase.field, path: planPath });
      // It refuses before mutation: every protected byte is unchanged.
      expect(protectedBytes(fixture)).toEqual(before);
    }
  });

  test("two amendments presenting the same tokens race under the lock: exactly one commits, the loser is stale", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const view = await prepareViewOf(fixture);
    const patch = preparePatchOf(fixture, { planParallelism: "parallel" });
    const tokens = { snapshotVersion: view.view.snapshotVersion, compassVersion: view.view.compassVersion };

    const results = await Promise.allSettled([
      amendWith(fixture, patch, tokens),
      amendWith(fixture, patch, tokens),
    ]);

    const fulfilled = results.filter((entry) => entry.status === "fulfilled");
    const rejected = results.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as CoordinationError).code).toBe("coordination.prepare-amendment.stale");

    // Exactly one delta landed: the rows are the winner's, and the snapshot on
    // disk is the version the winner returned.
    const winner = fulfilled[0] as PromiseFulfilledResult<PrepareWorkflowResult>;
    expect(prepareSnapshotOf(fixture).plans.map((row) => row.id)).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(winner.value.view.snapshotVersion).toBe(`sha256:${sha256OfFile(fixture.snapshotPath)}`);
  });

  test("a stale snapshot or compass token refuses as stale and leaves every protected byte untouched", async () => {
    for (const staleToken of ["snapshot", "compass"] as const) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const view = await prepareViewOf(fixture);
      const before = protectedBytes(fixture);
      const stale = `sha256:${"0".repeat(64)}`;

      const refusal = await prepareRefusalOf(() =>
        amendWith(fixture, preparePatchOf(fixture), {
          snapshotVersion: staleToken === "snapshot" ? stale : view.view.snapshotVersion,
          compassVersion: staleToken === "compass" ? stale : view.view.compassVersion,
        }),
      );

      expect(refusal.code).toBe("coordination.prepare-amendment.stale");
      expect(refusal.details.expected).toBe(stale);
      expect(protectedBytes(fixture)).toEqual(before);
    }
  });

  test("a plan-pm, forged, relocated or foreign-root envelope refuses with the existing auth errors", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const view = await prepareViewOf(fixture);
    const sessionDir = dirname(fixture.coordinatorSession);
    const envelope = (overrides: Record<string, unknown>): string => {
      const path = join(sessionDir, `${String(overrides.session_id)}.json`);
      writeJson(path, {
        schema_version: 1,
        role: "coordinator",
        session_id: "11111111-1111-1111-1111-111111111111",
        workflow_id: PREPARE_WORKFLOW,
        harness_root: fixture.harness,
        ...overrides,
      });
      return path;
    };

    // A real envelope of the wrong role.
    const planPm = envelope({ role: "plan-pm", session_id: "plan-pm-envelope", plan_id: PREPARE_ROW });
    expect((await prepareRefusalOf(() => prepareViewOf(fixture, planPm))).code).toBe("coordination.session-role");

    // A forged coordinator envelope: a session id the snapshot never bound.
    const forged = envelope({ session_id: "22222222-2222-2222-2222-222222222222" });
    expect(
      (
        await prepareRefusalOf(() =>
          amendWith(fixture, preparePatchOf(fixture), {
            snapshotVersion: view.view.snapshotVersion,
            compassVersion: view.view.compassVersion,
            sessionPath: forged,
          }),
        )
      ).code,
    ).toBe("coordination.session-mismatch");

    // The bound session at another path: identity is the canonical file, never a copy.
    const relocated = join(fixture.root, "relocated-envelope.json");
    writeText(relocated, readFileSync(fixture.coordinatorSession, "utf8"));
    expect((await prepareRefusalOf(() => prepareViewOf(fixture, relocated))).code).toBe("coordination.session-mismatch");

    // An envelope claiming another harness root: the active store is the control root.
    const foreign = envelope({ session_id: "33333333-3333-3333-3333-333333333333", harness_root: join(fixture.root, "other-harness") });
    expect((await prepareRefusalOf(() => prepareViewOf(fixture, foreign))).code).toBe("coordination.path-mismatch");
  });

  test("an unregistered workflow refuses before the read or the amendment can proceed", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const view = await prepareViewOf(fixture);
    const root = readJson(fixture.statusPath);
    root.workflows = (root.workflows as Array<Record<string, unknown>>).filter((entry) => entry.id !== PREPARE_WORKFLOW);
    writeJson(fixture.statusPath, root);
    const before = protectedBytes(fixture);

    expect((await prepareRefusalOf(() => prepareViewOf(fixture))).code).toBe("coordination.workflow-not-found");
    expect(
      (
        await prepareRefusalOf(() =>
          amendWith(fixture, preparePatchOf(fixture), {
            snapshotVersion: view.view.snapshotVersion,
            compassVersion: view.view.compassVersion,
          }),
        )
      ).code,
    ).toBe("coordination.workflow-not-found");
    expect(protectedBytes(fixture).snapshot).toBe(before.snapshot);
  });

  test("a non-Prepare phase, a terminal lifecycle, a progressed row or any lease/handoff state refuses without mutation", async () => {
    const admissionCases: ReadonlyArray<{
      name: string;
      code: string;
      patchSnapshot: (doc: { plans: Array<Record<string, unknown>> } & Record<string, unknown>, fixture: PrepareFixture) => void;
    }> = [
      {
        name: "phase-2",
        code: "coordination.prepare-amendment.not-prepare",
        patchSnapshot: (doc) => {
          doc.phase = "phase-2-execute";
        },
      },
      {
        name: "terminal",
        code: "coordination.prepare-amendment.not-prepare",
        patchSnapshot: (doc) => {
          doc.status = "completed";
          doc.ended_at = "2026-09-16";
        },
      },
      {
        name: "row-in-progress",
        code: "coordination.prepare-amendment.execution-started",
        patchSnapshot: (doc) => {
          doc.plans[0]!.status = "InProgress";
        },
      },
      {
        name: "row-progress",
        code: "coordination.prepare-amendment.execution-started",
        patchSnapshot: (doc) => {
          doc.plans[0]!.progress = 40;
        },
      },
      {
        name: "row-execution-lease",
        code: "coordination.prepare-amendment.execution-started",
        patchSnapshot: (doc, fixture) => {
          doc.plans[0]!.execution_lease = {
            holder: "11111111-1111-1111-1111-111111111111",
            claimed_at: "2026-09-16T00:00:00Z",
            worktree_path: join(fixture.root, "wt-row"),
            working_branch: "feature/plan-prepare",
          };
        },
      },
      {
        name: "row-coordination",
        code: "coordination.prepare-amendment.execution-started",
        patchSnapshot: (doc) => {
          doc.plans[0]!.coordination = { revision: 1 };
        },
      },
      {
        name: "integration-merge-lease",
        code: "coordination.prepare-amendment.execution-started",
        patchSnapshot: (doc) => {
          doc.integration_merge_lease = {
            holder: "11111111-1111-1111-1111-111111111111",
            claimed_at: "2026-09-16T00:00:00Z",
            plan_id: PREPARE_ROW,
            source_branch: "feature/plan-prepare",
            target_branch: PREPARE_INTEGRATION_BRANCH,
          };
        },
      },
    ];

    for (const admissionCase of admissionCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const view = await prepareViewOf(fixture);
      const doc = prepareSnapshotOf(fixture);
      admissionCase.patchSnapshot(doc, fixture);
      writeJson(fixture.snapshotPath, doc);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() =>
        amendWith(fixture, preparePatchOf(fixture), {
          snapshotVersion: `sha256:${sha256OfFile(fixture.snapshotPath)}`,
          compassVersion: view.view.compassVersion,
        }),
      );

      // The case name names the state; the code names the refusal reason.
      expect(`${admissionCase.name}: ${refusal.code}`).toBe(`${admissionCase.name}: ${admissionCase.code}`);
      expect(protectedBytes(fixture)).toEqual(before);

      // The read reports the same state as a blocker instead of a refusal.
      const readOnly = await prepareViewOf(fixture);
      expect(readOnly.view.allowed).toBe(false);
      expect(readOnly.view.blockers).toHaveLength(1);
    }
  }, 30000);

  test("duplicate plan ids refuse: an existing row id and a repetition inside one patch", async () => {
    const existing = makePrepareFixture();
    await ensurePrepareCoordinator(existing);
    const existingRefusal = await prepareRefusalOf(() =>
      amendPrepare(existing, preparePatchOf(existing, { appendPlans: [prepareAppendOf(existing, PREPARE_ROW)] })),
    );
    expect(existingRefusal.code).toBe("coordination.prepare-amendment.duplicate-plan");
    expect(existingRefusal.details.plan_id).toBe(PREPARE_ROW);

    const repeated = makePrepareFixture();
    await ensurePrepareCoordinator(repeated);
    const repeatedRefusal = await prepareRefusalOf(() =>
      amendPrepare(
        repeated,
        preparePatchOf(repeated, {
          appendPlans: [prepareAppendOf(repeated, PREPARE_APPEND), prepareAppendOf(repeated, PREPARE_APPEND)],
        }),
      ),
    );
    expect(repeatedRefusal.code).toBe("coordination.prepare-amendment.duplicate-plan");
  });

  test("plan appends refuse unsafe ids, wrong plan files, mismatched headers and escaping or missing references", async () => {
    const invalidPlanCases: ReadonlyArray<{
      name: string;
      prepare?: (fixture: PrepareFixture) => void;
      patch: (fixture: PrepareFixture) => Record<string, unknown>;
    }> = [
      {
        name: "unsafe-id",
        patch: (fixture) =>
          preparePatchOf(fixture, { appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, { id: ".." })] }),
      },
      {
        name: "file-outside-plan-dir",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, { file: join(fixture.root, "elsewhere.md") })],
          }),
      },
      {
        name: "file-not-the-plan-id",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [
              prepareAppendOf(fixture, PREPARE_APPEND, { file: join(fixture.planDir, `${PREPARE_UNREVIEWED}.md`) }),
            ],
          }),
      },
      {
        // Missing / non-string pointers are shape violations this boundary owns:
        // the shared resolver names the pointer form with `path.isAbsolute(file)`
        // before its own type check, so reaching it with these would surface a
        // native `TypeError` instead of the refusal vocabulary.
        name: "file-missing",
        patch: (fixture) =>
          preparePatchOf(fixture, { appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, { file: undefined })] }),
      },
      {
        name: "file-null",
        patch: (fixture) => preparePatchOf(fixture, { appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, { file: null })] }),
      },
      {
        name: "file-not-a-string",
        patch: (fixture) => preparePatchOf(fixture, { appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, { file: 42 })] }),
      },
      {
        name: "header-id-mismatch",
        prepare: (fixture) => {
          writeText(join(fixture.planDir, `${PREPARE_APPEND}.md`), preparePlanMarkdown({ id: "plan-other", workingBranch: `feature/${PREPARE_APPEND}` }));
        },
        patch: (fixture) => preparePatchOf(fixture),
      },
      {
        name: "metadata-unexpected-key",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, {}, { execution_mode: "sdd" })],
          }),
      },
      {
        name: "working-branch-mismatch",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, {}, { working_branch: "feature/somewhere-else" })],
          }),
      },
      {
        name: "main-branch-header-mismatch",
        prepare: (fixture) => {
          writeText(join(fixture.planDir, `${PREPARE_APPEND}.md`), preparePlanMarkdown({ id: PREPARE_APPEND, workingBranch: `feature/${PREPARE_APPEND}`, mainBranch: "trunk" }));
        },
        patch: (fixture) => preparePatchOf(fixture),
      },
      {
        name: "spec-outside-harness",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [
              prepareAppendOf(fixture, PREPARE_APPEND, {}, { primary_spec: join(fixture.root, "outside-spec.md") }),
            ],
          }),
      },
      {
        name: "spec-missing",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [
              prepareAppendOf(fixture, PREPARE_APPEND, {}, { spec_refs: [join(fixture.harness, "specs", "missing.md")] }),
            ],
          }),
      },
      {
        name: "integration-branch-mismatch",
        patch: (fixture) =>
          preparePatchOf(fixture, {
            appendPlans: [prepareAppendOf(fixture, PREPARE_APPEND, {}, { merge_target: "main" })],
          }),
      },
    ];

    for (const invalidCase of invalidPlanCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      invalidCase.prepare?.(fixture);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() => amendPrepare(fixture, invalidCase.patch(fixture)));

      expect(`${invalidCase.name}: ${refusal.code}`).toBe(
        `${invalidCase.name}: coordination.prepare-amendment.invalid-plan`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }
  }, 60000);

  test("the proposal must match the reviewed compass exactly", async () => {
    const undeclared = makePrepareFixture();
    await ensurePrepareCoordinator(undeclared);
    const undeclaredRefusal = await prepareRefusalOf(() =>
      amendPrepare(undeclared, preparePatchOf(undeclared, { appendPlans: [prepareAppendOf(undeclared, PREPARE_UNREVIEWED)] })),
    );
    expect(undeclaredRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(undeclaredRefusal.details.undeclared).toEqual([PREPARE_UNREVIEWED]);

    // The compass declares a plan this patch leaves unregistered.
    const incomplete = makePrepareFixture();
    await ensurePrepareCoordinator(incomplete);
    writeText(
      incomplete.compassPath,
      readFileSync(incomplete.compassPath, "utf8").replace(`  - ${PREPARE_APPEND}\n`, `  - ${PREPARE_APPEND}\n  - ${PREPARE_UNREVIEWED}\n`),
    );
    const incompleteRefusal = await prepareRefusalOf(() => amendPrepare(incomplete, preparePatchOf(incomplete)));
    expect(incompleteRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(incompleteRefusal.details.missing).toEqual([PREPARE_UNREVIEWED]);

    // Another lifecycle's compass: the ref itself is refused, not silently used.
    const borrowed = makePrepareFixture();
    await ensurePrepareCoordinator(borrowed);
    const otherCompass = join(borrowed.harness, "iterations", "iter-other", "delivery-compass.md");
    writeText(otherCompass, readFileSync(borrowed.compassPath, "utf8").replace(`iteration_id: ${PREPARE_WORKFLOW}`, "iteration_id: iter-other"));
    const borrowedRefusal = await prepareRefusalOf(() =>
      amendPrepare(borrowed, preparePatchOf(borrowed, { appendPlans: [prepareAppendOf(borrowed, PREPARE_APPEND, {}, { iteration_compass: otherCompass })] })),
    );
    expect(borrowedRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");

    // A missing compass cannot approve anything.
    const missing = makePrepareFixture();
    await ensurePrepareCoordinator(missing);
    rmSync(missing.compassPath);
    const missingRefusal = await prepareRefusalOf(() => amendPrepare(missing, preparePatchOf(missing)));
    expect(missingRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");

    // A compass that declares no plan ids.
    const declaredNone = makePrepareFixture();
    await ensurePrepareCoordinator(declaredNone);
    writeText(declaredNone.compassPath, `---\niteration_id: ${PREPARE_WORKFLOW}\nstatus: locked\n---\n`);
    const declaredNoneRefusal = await prepareRefusalOf(() => amendPrepare(declaredNone, preparePatchOf(declaredNone)));
    expect(declaredNoneRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
  }, 30000);

  test("the reviewed compass must declare its lifecycle identity and a clean plan list", async () => {
    // A compass that is not bound to this lifecycle, or whose `plans` list is
    // malformed, or whose branch / checkout declaration is present without a
    // usable value, cannot authorize a structural delta: the declaration is
    // either read exactly as written or refused, never filtered, deduplicated
    // or silently dropped into a declaration it does not make.
    const compassCases: ReadonlyArray<{ name: string; frontmatter: readonly string[] }> = [
      {
        name: "missing-iteration-id",
        frontmatter: [
          "status: locked",
          `spec_integration_branch: ${PREPARE_INTEGRATION_BRANCH}`,
          "target_branch: main",
          "plans:",
          `  - ${PREPARE_ROW}`,
          `  - ${PREPARE_APPEND}`,
        ],
      },
      {
        name: "duplicate-plan-entry",
        frontmatter: [
          `iteration_id: ${PREPARE_WORKFLOW}`,
          "status: locked",
          "plans:",
          `  - ${PREPARE_ROW}`,
          `  - ${PREPARE_APPEND}`,
          `  - ${PREPARE_APPEND}`,
        ],
      },
      {
        name: "empty-plan-entry",
        frontmatter: [
          `iteration_id: ${PREPARE_WORKFLOW}`,
          "status: locked",
          "plans:",
          `  - ${PREPARE_ROW}`,
          `  - ${PREPARE_APPEND}`,
          '  - ""',
        ],
      },
      {
        name: "malformed-integration-branch",
        frontmatter: [
          `iteration_id: ${PREPARE_WORKFLOW}`,
          "status: locked",
          "spec_integration_branch:",
          `  - ${PREPARE_INTEGRATION_BRANCH}`,
          "  - integration/second",
          "plans:",
          `  - ${PREPARE_ROW}`,
          `  - ${PREPARE_APPEND}`,
        ],
      },
      {
        name: "malformed-integration-worktree-path",
        frontmatter: [
          `iteration_id: ${PREPARE_WORKFLOW}`,
          "status: locked",
          `spec_integration_branch: ${PREPARE_INTEGRATION_BRANCH}`,
          "integration_worktree_path:",
          "  - /tmp/wt-one",
          "plans:",
          `  - ${PREPARE_ROW}`,
          `  - ${PREPARE_APPEND}`,
        ],
      },
    ];

    for (const compassCase of compassCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      writeText(fixture.compassPath, ["---", ...compassCase.frontmatter, "---", ""].join("\n"));
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() => amendPrepare(fixture, preparePatchOf(fixture)));

      expect(`${compassCase.name}: ${refusal.code}`).toBe(
        `${compassCase.name}: coordination.prepare-amendment.compass-mismatch`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }
  });

  test("a compass-declared integration checkout is compared even when the patch omits the path", async () => {
    const withDeclaredPath = (path: string): string =>
      [
        "---",
        `iteration_id: ${PREPARE_WORKFLOW}`,
        "status: locked",
        `spec_integration_branch: ${PREPARE_INTEGRATION_BRANCH}`,
        "target_branch: main",
        `integration_worktree_path: ${path}`,
        "plans:",
        `  - ${PREPARE_ROW}`,
        `  - ${PREPARE_APPEND}`,
        "---",
        "",
      ].join("\n");

    // A workflow whose recorded checkout disagrees with its reviewed compass
    // refuses the append even though the patch never names a path.
    const conflicting = makePrepareFixture();
    await ensurePrepareCoordinator(conflicting);
    const reviewedPath = join(conflicting.root, "wt-integration-reviewed");
    git(["worktree", "add", "-q", "-b", "integration/wf-prepare-reviewed", reviewedPath], conflicting.root);
    const olderPath = join(conflicting.root, "wt-integration-old");
    git(["worktree", "add", "-q", "-b", "integration/wf-prepare-old", olderPath], conflicting.root);
    writeText(conflicting.compassPath, withDeclaredPath(reviewedPath));
    const recorded = prepareSnapshotOf(conflicting);
    recorded.integration_worktree_path = olderPath;
    writeJson(conflicting.snapshotPath, recorded);
    // The helper's base patch is append-only (it names no path and no policy),
    // so these cases exercise the omission the finding is about.
    const conflictingBefore = protectedBytes(conflicting);
    const refusal = await prepareRefusalOf(() => amendPrepare(conflicting, preparePatchOf(conflicting)));

    expect(refusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(protectedBytes(conflicting)).toEqual(conflictingBefore);

    // The declaration is the reviewed state, so a workflow that has not
    // recorded the reviewed checkout yet refuses the same way.
    const unrecorded = makePrepareFixture();
    await ensurePrepareCoordinator(unrecorded);
    writeText(unrecorded.compassPath, withDeclaredPath(unrecorded.integrationPath));
    const unrecordedBefore = protectedBytes(unrecorded);

    const unrecordedRefusal = await prepareRefusalOf(() => amendPrepare(unrecorded, preparePatchOf(unrecorded)));

    expect(unrecordedRefusal.code).toBe("coordination.prepare-amendment.compass-mismatch");
    expect(protectedBytes(unrecorded)).toEqual(unrecordedBefore);

    // Control: the same path-omitting append is admitted once the recorded
    // checkout IS the reviewed one.
    const aligned = makePrepareFixture();
    await ensurePrepareCoordinator(aligned);
    writeText(aligned.compassPath, withDeclaredPath(aligned.integrationPath));
    const alignedDoc = prepareSnapshotOf(aligned);
    alignedDoc.integration_worktree_path = aligned.integrationPath;
    writeJson(aligned.snapshotPath, alignedDoc);

    const amended = await amendPrepare(aligned, preparePatchOf(aligned));

    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);

    // Control: the check targets the path this commit would leave, so naming
    // the reviewed checkout in the patch is a lawful correction of a stale
    // recording — the old recorded value is replaced, not compared.
    const corrected = makePrepareFixture();
    await ensurePrepareCoordinator(corrected);
    writeText(corrected.compassPath, withDeclaredPath(corrected.integrationPath));
    const staleDoc = prepareSnapshotOf(corrected);
    staleDoc.integration_worktree_path = join(corrected.root, "wt-integration-old");
    writeJson(corrected.snapshotPath, staleDoc);

    const correctedResult = await amendPrepare(
      corrected,
      preparePatchOf(corrected, { integrationWorktreePath: corrected.integrationPath }),
    );

    expect(correctedResult.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(prepareSnapshotOf(corrected).integration_worktree_path).toBe(corrected.integrationPath);
  }, 30000);

  test("a compass integration branch that disagrees with the workflow's recorded branch refuses a patch that appends nothing", async () => {
    // The declaration is compared where every patch is validated, so an
    // amendment that only records the policy or the checkout cannot commit a
    // workflow whose recorded integration branch contradicts it.
    const declaredBranch = "integration/declared-elsewhere";
    const patchCases: ReadonlyArray<{ name: string; patch: (fixture: PrepareFixture) => Record<string, unknown> }> = [
      {
        name: "policy-only",
        patch: (fixture) => preparePatchOf(fixture, { appendPlans: [], planParallelism: "parallel" }),
      },
      {
        name: "checkout-only",
        patch: (fixture) => preparePatchOf(fixture, { appendPlans: [], integrationWorktreePath: fixture.integrationPath }),
      },
    ];

    for (const patchCase of patchCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      // The compass declares only the already-registered plan, so the patch
      // below changes exactly one thing: the policy or the recorded checkout.
      writeText(
        fixture.compassPath,
        readFileSync(fixture.compassPath, "utf8")
          .replace(`  - ${PREPARE_APPEND}\n`, "")
          .replace(`spec_integration_branch: ${PREPARE_INTEGRATION_BRANCH}`, `spec_integration_branch: ${declaredBranch}`),
      );
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() => amendPrepare(fixture, patchCase.patch(fixture)));

      expect(`${patchCase.name}: ${refusal.code}`).toBe(
        `${patchCase.name}: coordination.prepare-amendment.compass-mismatch`,
      );
      expect(`${patchCase.name}: ${String(refusal.details.expected)}`).toBe(`${patchCase.name}: ${declaredBranch}`);
      expect(`${patchCase.name}: ${String(refusal.details.actual)}`).toBe(
        `${patchCase.name}: ${PREPARE_INTEGRATION_BRANCH}`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }
  }, 30000);

  test("the integration checkout must be a distinct real checkout of this repository on branch.integration", async () => {
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), "mstar-prepare-other-")));
    roots.push(otherRoot);
    git(["init", "-q", "-b", "main"], otherRoot);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], otherRoot);
    const otherWorktree = join(otherRoot, "wt-other");
    git(["worktree", "add", "-q", "-b", PREPARE_INTEGRATION_BRANCH, otherWorktree], otherRoot);

    const worktreeCases: ReadonlyArray<{ name: string; path: (fixture: PrepareFixture) => string }> = [
      { name: "missing-path", path: (fixture) => join(fixture.root, "no-such-checkout") },
      { name: "main-checkout", path: (fixture) => fixture.root },
      { name: "control-root", path: (fixture) => fixture.harness },
      {
        name: "same-checkout-alias",
        path: (fixture) => {
          mkdirSync(join(fixture.root, "subdir"));
          return join(fixture.root, "subdir");
        },
      },
      {
        name: "wrong-branch",
        path: (fixture) => {
          const path = join(fixture.root, "wt-elsewhere");
          git(["worktree", "add", "-q", "-b", "feature/elsewhere", path], fixture.root);
          return path;
        },
      },
      { name: "other-repository", path: () => otherWorktree },
    ];

    for (const worktreeCase of worktreeCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const candidate = worktreeCase.path(fixture);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() =>
        amendPrepare(fixture, preparePatchOf(fixture, { integrationWorktreePath: candidate })),
      );

      expect(`${worktreeCase.name}: ${refusal.code}`).toBe(
        `${worktreeCase.name}: coordination.prepare-amendment.invalid-worktree`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }
  }, 30000);

  test("the recorded checkout is proven against the repository owning the control harness root, never the caller's clone", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);

    // A second clone of the same project: its own repository, its own `main`
    // and its own real checkout on the workflow's recorded branch.integration —
    // the checkout the caller's clone could otherwise record as this
    // lifecycle's integration worktree.
    const clonePath = realpathSync(mkdtempSync(join(tmpdir(), "mstar-prepare-clone-")));
    rmSync(clonePath, { recursive: true, force: true });
    git(["clone", "-q", fixture.root, clonePath], tmpdir());
    const clone = realpathSync(clonePath);
    roots.push(clone);
    const cloneCheckout = join(clone, "wt-integration");
    git(["worktree", "add", "-q", "-b", PREPARE_INTEGRATION_BRANCH, cloneCheckout], clone);

    const view = await prepareViewOf(fixture);
    const before = protectedBytes(fixture);

    const refusal = await prepareRefusalOf(() =>
      amendWith(fixture, preparePatchOf(fixture, { integrationWorktreePath: cloneCheckout }), {
        snapshotVersion: view.view.snapshotVersion,
        compassVersion: view.view.compassVersion,
        cwd: clone,
      }),
    );

    expect(refusal.code).toBe("coordination.prepare-amendment.invalid-worktree");
    expect(protectedBytes(fixture)).toEqual(before);
    expect(prepareSnapshotOf(fixture).integration_worktree_path).toBeUndefined();

    // The legitimate call from the control root's own repository still records
    // that repository's reviewed checkout.
    const amended = await amendPrepare(fixture, preparePatchOf(fixture, { integrationWorktreePath: fixture.integrationPath }));
    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    expect(prepareSnapshotOf(fixture).integration_worktree_path).toBe(fixture.integrationPath);
  }, 30000);

  test("the returned snapshot version names the commit this call made, never a competing commit", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const view = await prepareViewOf(fixture);
    const lockDir = join(dirname(fixture.snapshotPath), ".status-write.lockdir");
    const store = instrumentLocalStore(
      fixture.harness,
      (inner) => new CompetingCommitStore(inner, fixture.snapshotPath, lockDir, "2099-01-01T00:00:00.000Z"),
    );

    const amended = await amendWith(fixture, preparePatchOf(fixture), {
      snapshotVersion: view.view.snapshotVersion,
      compassVersion: view.view.compassVersion,
    });

    // The returned token is the byte version of this call's own commit, not the
    // state the snapshot was left in afterwards.
    expect(amended.view.snapshotVersion).toBe(store.commitVersion);
    const competitor = store.publishCompetitor();
    expect(competitor).not.toBe("");
    expect(competitor).not.toBe(store.commitVersion);
    expect(amended.view.snapshotVersion).toBe(store.commitVersion);
    expect(readArtifactBytes(fixture.snapshotPath)?.version).toBe(competitor);
  }, 30000);

  test("unknown patch keys, malformed values and a no-op patch refuse as invalid-patch", async () => {
    const cases: ReadonlyArray<{ name: string; patch: (fixture: PrepareFixture) => Record<string, unknown> }> = [
      { name: "unknown-key", patch: (fixture) => preparePatchOf(fixture, { replacePlans: [] }) },
      { name: "missing-main-branch", patch: (fixture) => preparePatchOf(fixture, { mainWorktreeBranch: undefined }) },
      { name: "appends-not-an-array", patch: (fixture) => preparePatchOf(fixture, { appendPlans: "plan-append" }) },
      { name: "bad-parallelism", patch: (fixture) => preparePatchOf(fixture, { planParallelism: "maybe" }) },
      { name: "empty-patch", patch: (fixture) => preparePatchOf(fixture, { appendPlans: [] }) },
    ];

    for (const patchCase of cases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() => amendPrepare(fixture, patchCase.patch(fixture)));

      expect(`${patchCase.name}: ${refusal.code}`).toBe(
        `${patchCase.name}: coordination.prepare-amendment.invalid-patch`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }

    // A patch that re-states the recorded path and policy changes nothing. The
    // compass declares only the already-registered row, so the path can be
    // recorded on its own before the no-op is attempted.
    const noop = makePrepareFixture();
    await ensurePrepareCoordinator(noop);
    writeText(
      noop.compassPath,
      readFileSync(noop.compassPath, "utf8").replace(`  - ${PREPARE_APPEND}\n`, ""),
    );
    await amendPrepare(noop, preparePatchOf(noop, { appendPlans: [], integrationWorktreePath: noop.integrationPath }));
    const before = protectedBytes(noop);
    const noopRefusal = await prepareRefusalOf(() =>
      amendPrepare(
        noop,
        preparePatchOf(noop, { appendPlans: [], integrationWorktreePath: noop.integrationPath, planParallelism: "serial" }),
      ),
    );
    expect(noopRefusal.code).toBe("coordination.prepare-amendment.invalid-patch");
    expect(protectedBytes(noop)).toEqual(before);
  }, 30000);

  test("the caller's main worktree branch is verified from Git, not from the snapshot's branch.base", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);

    const refusal = await prepareRefusalOf(() =>
      amendPrepare(fixture, preparePatchOf(fixture, { mainWorktreeBranch: "release" })),
    );

    expect(refusal.code).toBe("coordination.scope-mismatch");
    expect(refusal.details.expected).toBe("release");
    expect(refusal.details.actual).toBe("main");
    expect(protectedBytes(fixture)).toEqual(before);
  });

  test("the generic snapshot writers still refuse the same row delta", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const current = prepareSnapshotOf(fixture);
    const before = protectedBytes(fixture);
    const version = `sha256:${sha256OfFile(fixture.snapshotPath)}`;
    const proposed = {
      ...current,
      updated_at: "2026-09-16T12:00:00.000Z",
      plans: [...current.plans, { id: "plan-smuggled", title: "Smuggled", file: "plans/plan-smuggled.md", status: "Todo" }],
    } as unknown as WorkflowSnapshot;

    const generic = await prepareRefusalOf(() =>
      writeWorkflowSnapshot(proposed, fixture.workflowDir, { expectedVersion: version, sessionPath: fixture.coordinatorSession }),
    );
    expect(generic.code).toBe("coordination.direct-write-refused");
    expect(protectedBytes(fixture)).toEqual(before);

    const replacement = await prepareRefusalOf(() =>
      replaceCoordinatedArtifact({
        harnessRoot: fixture.harness,
        ref: { kind: "snapshot", key: PREPARE_WORKFLOW },
        payload: proposed,
        expectedVersion: version,
        sessionPath: fixture.coordinatorSession,
      }),
    );
    expect(replacement.code).toBe("coordination.direct-write-refused");
    expect(protectedBytes(fixture)).toEqual(before);
  });

  test("the create-only + register bootstrap route stops on registration failure and never executes the unregistered orphan", async () => {
    const fixture = makePrepareFixture();
    const orphanId = "wf-orphan";
    const orphanDir = join(fixture.harness, "workflows", orphanId);
    const orphanSnapshotPath = join(orphanDir, "snapshot.json");
    const orphan: WorkflowSnapshot = {
      schema_version: 1,
      id: orphanId,
      type: "iteration",
      status: "running",
      phase: "phase-1-prepare",
      started_at: "2026-09-16",
      updated_at: "2026-09-16",
      plans: [planRow("plan-orphan", PROJECT_ID)],
    };
    // Creation succeeds …
    await writeWorkflowSnapshot(orphan, orphanDir, { createOnly: true });
    const createdBytes = readFileSync(orphanSnapshotPath, "utf8");
    // … and registration fails on a root document that cannot be written (a
    // duplicate workflow id), leaving the created snapshot unregistered.
    const root = readJson(fixture.statusPath);
    const workflows = root.workflows as Array<Record<string, unknown>>;
    root.workflows = [...workflows, workflows[1]!];
    writeJson(fixture.statusPath, root);
    const statusBytes = readFileSync(fixture.statusPath, "utf8");

    const registerFailure = await failureOf(() =>
      registerWorkflow(fixture.statusPath, {
        id: orphanId,
        type: "iteration",
        started_at: "2026-09-16",
        dir: `workflows/${orphanId}`,
      }),
    );
    expect(registerFailure.message).toContain("status.json");
    // The failed registration wrote nothing, and the orphan grants nothing: no
    // execution path admits a workflow the root never registered.
    expect(readFileSync(fixture.statusPath, "utf8")).toBe(statusBytes);
    const bindRefusal = await prepareRefusalOf(() =>
      bindPlanSession({
        coordinator: true,
        workflowId: orphanId,
        harnessDir: fixture.harness,
        cwd: fixture.root,
        sessionId: FIXTURE_COORDINATOR_ID,
      }),
    );
    expect(bindRefusal.code).toBe("coordination.workflow-not-found");

    // Retrying creation never overwrites the created bytes.
    const recreate = await prepareRefusalOf(() => writeWorkflowSnapshot(orphan, orphanDir, { createOnly: true }));
    expect(recreate.code).toBe("coordination.version-conflict");
    expect(readFileSync(orphanSnapshotPath, "utf8")).toBe(createdBytes);
  });

  test("a plan-file correction repairs a malformed repository-relative pointer and preserves every other row field", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = prepareSnapshotOf(fixture);
    const oldRow = before.plans[0]!;
    const correctedPath = join(fixture.planDir, `${PREPARE_ROW}.md`);
    // The fixture row holds the repository-relative pointer rows registered
    // before the resolver landed; the correction names that same plan's
    // canonical file and the exact pointer it replaces.
    expect(oldRow.file).toBe(`.mstar/plans/${PREPARE_ROW}.md`);

    const amended = await amendPrepare(
      fixture,
      preparePatchOf(fixture, {
        correctPlanFiles: [
          { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: correctedPath },
        ],
      }),
    );

    expect(amended.ok).toBe(true);
    expect(amended.view.allowed).toBe(true);
    expect(amended.view.planIds).toEqual([PREPARE_ROW, PREPARE_APPEND]);
    const after = prepareSnapshotOf(fixture);
    // Only the pointer moved: the row keeps its identity, title, status,
    // metadata and position, and the appended row still lands after it.
    expect(after.plans[0]).toEqual({ ...oldRow, file: correctedPath });
    expect(after.plans[0]!.metadata).toEqual(oldRow.metadata);
    expect(after.plans[1]!.file).toBe(join(fixture.planDir, `${PREPARE_APPEND}.md`));
    expect(after.plans).toHaveLength(2);

    // A correction is a delta on its own: with the compass declaring only the
    // registered row it is admitted with an empty append array.
    const only = makePrepareFixture();
    await ensurePrepareCoordinator(only);
    writeText(only.compassPath, readFileSync(only.compassPath, "utf8").replace(`  - ${PREPARE_APPEND}\n`, ""));
    const onlyRow = prepareSnapshotOf(only).plans[0]!;
    const onlyPath = join(only.planDir, `${PREPARE_ROW}.md`);

    const correctedOnly = await amendPrepare(
      only,
      preparePatchOf(only, {
        appendPlans: [],
        correctPlanFiles: [
          { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: onlyPath },
        ],
      }),
    );

    expect(correctedOnly.view.planIds).toEqual([PREPARE_ROW]);
    expect(prepareSnapshotOf(only).plans).toEqual([{ ...onlyRow, file: onlyPath }]);

    // The declared harness-relative spelling is an accepted OLD form too — the
    // resolver reads it, and the correction canonicalizes it.
    const declared = makePrepareFixture();
    await ensurePrepareCoordinator(declared);
    writeText(declared.compassPath, readFileSync(declared.compassPath, "utf8").replace(`  - ${PREPARE_APPEND}\n`, ""));
    const declaredRow = prepareSnapshotOf(declared).plans[0]!;
    const declaredDoc = prepareSnapshotOf(declared);
    declaredDoc.plans[0]!.file = `plans/${PREPARE_ROW}.md`;
    writeJson(declared.snapshotPath, declaredDoc);

    const declaredAmended = await amendPrepare(
      declared,
      preparePatchOf(declared, {
        appendPlans: [],
        correctPlanFiles: [
          { id: PREPARE_ROW, expectedFile: `plans/${PREPARE_ROW}.md`, file: join(declared.planDir, `${PREPARE_ROW}.md`) },
        ],
      }),
    );

    expect(declaredAmended.view.planIds).toEqual([PREPARE_ROW]);
    expect(prepareSnapshotOf(declared).plans).toEqual([
      { ...declaredRow, file: join(declared.planDir, `${PREPARE_ROW}.md`) },
    ]);
  }, 30000);

  test("a plan-file correction refuses an unbindable old or new pointer without writing anything", async () => {
    const cases: ReadonlyArray<{
      name: string;
      prepare?: (fixture: PrepareFixture) => void;
      correction: (fixture: PrepareFixture) => unknown;
    }> = [
      { name: "entry-not-an-object", correction: () => "plan-prepare" },
      {
        name: "unexpected-key",
        correction: (fixture) => ({
          id: PREPARE_ROW,
          expectedFile: `.mstar/plans/${PREPARE_ROW}.md`,
          file: join(fixture.planDir, `${PREPARE_ROW}.md`),
          status: "Todo",
        }),
      },
      { name: "missing-id", correction: (fixture) => ({ expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }) },
      {
        name: "unsafe-id",
        correction: (fixture) => ({ id: "../plan-prepare", expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "unknown-row",
        correction: (fixture) => ({
          id: PREPARE_UNREVIEWED,
          expectedFile: `.mstar/plans/${PREPARE_UNREVIEWED}.md`,
          file: join(fixture.planDir, `${PREPARE_UNREVIEWED}.md`),
        }),
      },
      { name: "expected-file-missing", correction: (fixture) => ({ id: PREPARE_ROW, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }) },
      {
        // The exact value is required: a canonical absolute spelling of the
        // same pointer is not what the row holds, so the observation is stale.
        name: "expected-file-form-mismatch",
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: join(fixture.planDir, `${PREPARE_ROW}.md`), file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "expected-file-other-value",
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_APPEND}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "new-file-foreign",
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.root, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "new-file-another-plan",
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_APPEND}.md`) }),
      },
      {
        name: "new-file-traversal",
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: `../plans/${PREPARE_ROW}.md` }),
      },
      {
        name: "new-file-missing",
        prepare: (fixture) => rmSync(join(fixture.planDir, `${PREPARE_ROW}.md`)),
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "new-file-header-mismatch",
        prepare: (fixture) =>
          writeText(join(fixture.planDir, `${PREPARE_ROW}.md`), preparePlanMarkdown({ id: "plan-other", workingBranch: "feature/plan-other" })),
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        // The row's pointer names another plan: a correction repairs a
        // malformed pointer of the SAME plan, it never rebinds a row.
        name: "old-pointer-names-another-plan",
        prepare: (fixture) => {
          const doc = prepareSnapshotOf(fixture);
          doc.plans[0]!.file = `.mstar/plans/${PREPARE_APPEND}.md`;
          writeJson(fixture.snapshotPath, doc);
        },
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_APPEND}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "old-pointer-same-basename-elsewhere",
        prepare: (fixture) => {
          const doc = prepareSnapshotOf(fixture);
          doc.plans[0]!.file = `.mstar/plans/archive/${PREPARE_ROW}.md`;
          writeJson(fixture.snapshotPath, doc);
        },
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/archive/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        name: "old-pointer-foreign-absolute",
        prepare: (fixture) => {
          const doc = prepareSnapshotOf(fixture);
          doc.plans[0]!.file = join(fixture.root, `${PREPARE_ROW}.md`);
          writeJson(fixture.snapshotPath, doc);
        },
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: join(fixture.root, `${PREPARE_ROW}.md`), file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
      {
        // A copied plan document with a matching header, under an unrelated
        // directory: neither its spelling nor its target is this plan's file.
        name: "old-pointer-copied-document-with-matching-header",
        prepare: (fixture) => {
          const copyDir = join(fixture.planDir, "copy");
          mkdirSync(copyDir, { recursive: true });
          writeText(join(copyDir, `${PREPARE_ROW}.md`), preparePlanMarkdown({ id: PREPARE_ROW, workingBranch: `feature/${PREPARE_ROW}` }));
          const doc = prepareSnapshotOf(fixture);
          doc.plans[0]!.file = `.mstar/plans/copy/${PREPARE_ROW}.md`;
          writeJson(fixture.snapshotPath, doc);
        },
        correction: (fixture) => ({ id: PREPARE_ROW, expectedFile: `.mstar/plans/copy/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) }),
      },
    ];

    for (const correctionCase of cases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      correctionCase.prepare?.(fixture);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() =>
        amendPrepare(fixture, preparePatchOf(fixture, { correctPlanFiles: [correctionCase.correction(fixture)] })),
      );

      expect(`${correctionCase.name}: ${refusal.code}`).toBe(
        `${correctionCase.name}: coordination.prepare-amendment.invalid-plan`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }

    // A correction that would not move the pointer is not a correction: the
    // already-canonical row refuses as a no-op.
    const noop = makePrepareFixture();
    await ensurePrepareCoordinator(noop);
    const canonical = join(noop.planDir, `${PREPARE_ROW}.md`);
    const noopDoc = prepareSnapshotOf(noop);
    noopDoc.plans[0]!.file = canonical;
    writeJson(noop.snapshotPath, noopDoc);
    const noopBefore = protectedBytes(noop);

    const noopRefusal = await prepareRefusalOf(() =>
      amendPrepare(
        noop,
        preparePatchOf(noop, {
          correctPlanFiles: [{ id: PREPARE_ROW, expectedFile: canonical, file: canonical }],
        }),
      ),
    );

    expect(noopRefusal.code).toBe("coordination.prepare-amendment.invalid-plan");
    expect(protectedBytes(noop)).toEqual(noopBefore);
  }, 30000);

  test("a plan-file correction is gated by the collision, CAS and whole-workflow admission rules", async () => {
    // `correctPlanFiles` is validated as an array like every other patch key.
    const malformed = makePrepareFixture();
    await ensurePrepareCoordinator(malformed);
    const malformedBefore = protectedBytes(malformed);
    const malformedRefusal = await prepareRefusalOf(() =>
      amendPrepare(malformed, preparePatchOf(malformed, { correctPlanFiles: "plan-prepare" })),
    );
    expect(malformedRefusal.code).toBe("coordination.prepare-amendment.invalid-patch");
    expect(protectedBytes(malformed)).toEqual(malformedBefore);

    // The same id cannot be appended and corrected in one patch.
    const overlap = makePrepareFixture();
    await ensurePrepareCoordinator(overlap);
    const overlapBefore = protectedBytes(overlap);
    const overlapRefusal = await prepareRefusalOf(() =>
      amendPrepare(
        overlap,
        preparePatchOf(overlap, {
          correctPlanFiles: [
            {
              id: PREPARE_APPEND,
              expectedFile: `.mstar/plans/${PREPARE_APPEND}.md`,
              file: join(overlap.planDir, `${PREPARE_APPEND}.md`),
            },
          ],
        }),
      ),
    );
    expect(overlapRefusal.code).toBe("coordination.prepare-amendment.duplicate-plan");
    expect(protectedBytes(overlap)).toEqual(overlapBefore);

    // …and never twice in one correction list.
    const duplicate = makePrepareFixture();
    await ensurePrepareCoordinator(duplicate);
    const duplicateBefore = protectedBytes(duplicate);
    const duplicateRefusal = await prepareRefusalOf(() =>
      amendPrepare(
        duplicate,
        preparePatchOf(duplicate, {
          correctPlanFiles: [
            { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(duplicate.planDir, `${PREPARE_ROW}.md`) },
            { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(duplicate.planDir, `${PREPARE_ROW}.md`) },
          ],
        }),
      ),
    );
    expect(duplicateRefusal.code).toBe("coordination.prepare-amendment.duplicate-plan");
    expect(protectedBytes(duplicate)).toEqual(duplicateBefore);

    // A stale byte token refuses before any pointer moves.
    const stale = makePrepareFixture();
    await ensurePrepareCoordinator(stale);
    const staleView = await prepareViewOf(stale);
    const staleBefore = protectedBytes(stale);
    const staleRefusal = await prepareRefusalOf(() =>
      amendWith(
        stale,
        preparePatchOf(stale, {
          correctPlanFiles: [
            { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(stale.planDir, `${PREPARE_ROW}.md`) },
          ],
        }),
        { snapshotVersion: `sha256:${"0".repeat(64)}`, compassVersion: staleView.view.compassVersion },
      ),
    );
    expect(staleRefusal.code).toBe("coordination.prepare-amendment.stale");
    expect(protectedBytes(stale)).toEqual(staleBefore);

    // A prepared/sealed row is never repointed: the whole-workflow admission
    // refuses before the patch is even read, with the state named.
    const admissionCases: ReadonlyArray<{
      name: string;
      patch: (
        doc: { plans: Array<Record<string, unknown>> } & Record<string, unknown>,
        fixture: PrepareFixture,
      ) => void;
    }> = [
      { name: "prepared-row", patch: (doc) => { doc.plans[0]!.coordination = { revision: 1 }; } },
      {
        name: "sealed-row-lease",
        patch: (doc, fixture) => {
          doc.plans[0]!.execution_lease = {
            holder: "11111111-1111-1111-1111-111111111111",
            claimed_at: "2026-09-16T00:00:00Z",
            worktree_path: join(fixture.root, "wt-row"),
            working_branch: `feature/${PREPARE_ROW}`,
          };
        },
      },
    ];

    for (const admissionCase of admissionCases) {
      const fixture = makePrepareFixture();
      await ensurePrepareCoordinator(fixture);
      const doc = prepareSnapshotOf(fixture);
      admissionCase.patch(doc, fixture);
      writeJson(fixture.snapshotPath, doc);
      const before = protectedBytes(fixture);

      const refusal = await prepareRefusalOf(() =>
        amendPrepare(
          fixture,
          preparePatchOf(fixture, {
            appendPlans: [],
            correctPlanFiles: [
              { id: PREPARE_ROW, expectedFile: `.mstar/plans/${PREPARE_ROW}.md`, file: join(fixture.planDir, `${PREPARE_ROW}.md`) },
            ],
          }),
        ),
      );

      expect(`${admissionCase.name}: ${refusal.code}`).toBe(
        `${admissionCase.name}: coordination.prepare-amendment.execution-started`,
      );
      expect(protectedBytes(fixture)).toEqual(before);
    }
  }, 30000);
});

/* ------------------------------------------------------------------------ *
 * JSON Prepare coordinator recovery (prerequisite contract §3.3)
 * ------------------------------------------------------------------------ */

/** The replacement coordinator identity every single-recovery case acquires. */
const RECOVERED_COORDINATOR_ID = "recovered-coordinator";
/** A second, distinct replacement identity (the supersede/concurrency cases). */
const RECOVERED_COORDINATOR_ID_2 = "recovered-coordinator-2";

/** The recovery view of the fixture's workflow, read without any session envelope. */
function recoveryViewOf(fixture: PrepareFixture): Promise<PrepareCoordinatorRecoveryView> {
  return showPrepareCoordinatorRecovery({
    cwd: fixture.root,
    harnessDir: fixture.harness,
    workflowId: PREPARE_WORKFLOW,
  });
}

/** One recovery request carrying this workflow's own reviewed tokens. */
function recoveryInputOf(
  fixture: PrepareFixture,
  tokens: { snapshot: string; compass: string },
  overrides: Record<string, unknown> = {},
): Parameters<typeof recoverPrepareCoordinator>[0] {
  return {
    cwd: fixture.root,
    harnessDir: fixture.harness,
    identity: {
      source: "local",
      sessionId: RECOVERED_COORDINATOR_ID,
      workflowId: PREPARE_WORKFLOW,
      role: "coordinator",
      planId: null,
    },
    priorSessionPath: fixture.coordinatorSession,
    priorSessionId: FIXTURE_COORDINATOR_ID,
    expectedSnapshotVersion: tokens.snapshot,
    expectedCompassVersion: tokens.compass,
    operationId: "op-recover-1",
    reason: "the prior host session was cancelled and cannot authenticate",
    authorizationRef: "PM-authorization-20260921",
    stoppedSessionIds: [FIXTURE_COORDINATOR_ID],
    ...overrides,
  } as Parameters<typeof recoverPrepareCoordinator>[0];
}

/** One replacement identity for the multi-recovery cases. */
function recoveredIdentity(sessionId: string): Record<string, unknown> {
  return { source: "local", sessionId, workflowId: PREPARE_WORKFLOW, role: "coordinator", planId: null };
}

/** Where the engine keeps one coordinator envelope (the session-path contract). */
function coordinatorEnvelopeOf(fixture: PrepareFixture, sessionId: string): string {
  return join(fixture.harness, "workflows", PREPARE_WORKFLOW, "sessions", `coordinator-${sessionId}.json`);
}

/**
 * The stored top-level `coordination` block, narrowed by `typeof` before any
 * member is read (the snapshot JSON is `unknown` at this boundary).
 */
function coordinationBlockOf(fixture: PrepareFixture): Record<string, unknown> {
  const coordination = (prepareSnapshotOf(fixture) as Record<string, unknown>).coordination;
  // Narrowed above; the block is a plain object when present.
  return typeof coordination === "object" && coordination !== null && !Array.isArray(coordination)
    ? (coordination as Record<string, unknown>)
    : {};
}

/** The stored recovery audit of the fixture's workflow. */
function recoveryAuditOf(fixture: PrepareFixture): Array<Record<string, unknown>> {
  const recoveries = coordinationBlockOf(fixture).identity_recoveries;
  // Narrowed above; the audit is an array when present.
  return Array.isArray(recoveries) ? (recoveries as Array<Record<string, unknown>>) : [];
}

/** The stored coordinator binding of the fixture's workflow. */
function recordedCoordinatorOf(fixture: PrepareFixture): Record<string, unknown> {
  const coordinator = coordinationBlockOf(fixture).coordinator;
  // Narrowed above; the binding is a plain object when present.
  return typeof coordinator === "object" && coordinator !== null && !Array.isArray(coordinator)
    ? (coordinator as Record<string, unknown>)
    : {};
}

/**
 * A store that fails the next SNAPSHOT put once: the exact envelope-before-
 * snapshot window §3.3 requires an injectable proof for. Everything else (the
 * envelope file creation, which does not go through the store) proceeds.
 */
class FailOnceSnapshotStore implements ArtifactStore {
  readonly root: string;
  private failing = true;

  constructor(private readonly inner: ArtifactStore & { root: string }) {
    this.root = inner.root;
  }

  async put(doc: ArtifactDoc): Promise<void> {
    if (doc.kind === "snapshot" && this.failing) {
      this.failing = false;
      throw new Error("injected store failure between the envelope and the snapshot commit");
    }
    await this.inner.put(doc);
  }

  async get<T = unknown>(ref: ArtifactRef): Promise<T | undefined> {
    return this.inner.get<T>(ref);
  }
}

/**
 * A store that fails the next snapshot put once AND replaces the recovery's
 * newly created envelope with an unrelated session file first — the exact
 * "path replaced between exclusive creation and cleanup" window. Cleanup must
 * prove ownership by bytes before it unlinks anything.
 */
class ReplaceEnvelopeOnFailureStore implements ArtifactStore {
  readonly root: string;
  private failing = true;

  constructor(
    private readonly inner: ArtifactStore & { root: string },
    private readonly envelopePath: string,
    private readonly replacement: string,
  ) {
    this.root = inner.root;
  }

  async put(doc: ArtifactDoc): Promise<void> {
    if (doc.kind === "snapshot" && this.failing) {
      this.failing = false;
      writeText(this.envelopePath, this.replacement);
      throw new Error("injected store failure between the envelope and the snapshot commit");
    }
    await this.inner.put(doc);
  }

  async get<T = unknown>(ref: ArtifactRef): Promise<T | undefined> {
    return this.inner.get<T>(ref);
  }
}

describe("prepare coordinator recovery", () => {
  test("prepare coordinator recovery view reports the recorded owner and both versions without envelope bytes", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);

    const view = await recoveryViewOf(fixture);

    expect(view.workflowId).toBe(PREPARE_WORKFLOW);
    expect(view.priorSessionId).toBe(FIXTURE_COORDINATOR_ID);
    expect(view.snapshotVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(view.compassVersion).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(view.allowed).toBe(true);
    expect(view.blockers).toEqual([]);
    // The read is owner-neutral: no envelope path, body or credential in it.
    expect(Object.keys(view).sort()).toEqual([
      "allowed",
      "blockers",
      "compassVersion",
      "priorSessionId",
      "snapshotVersion",
      "workflowId",
    ]);
    expect(JSON.stringify(view)).not.toContain(`sessions${sep}`);
    // Read-only: nothing moved.
    expect(protectedBytes(fixture)).toEqual(before);
  }, 30000);

  test("prepare coordinator recovery replaces the binding under explicit authorization and the old reference refuses", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);
    const tokens = await recoveryViewOf(fixture);
    const planRows = stableJson(prepareSnapshotOf(fixture).plans);
    const branch = stableJson(prepareSnapshotOf(fixture).branch);

    const result = await recoverPrepareCoordinator(
      recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion }),
    );

    expect(result.ok).toBe(true);
    expect(result.operation).toBe("recover-coordinator");
    expect(result.recovery.replay).toBe(false);
    expect(result.recovery.priorSessionId).toBe(FIXTURE_COORDINATOR_ID);
    expect(result.recovery.sessionId).toBe(RECOVERED_COORDINATOR_ID);
    expect(result.session.session_id).toBe(RECOVERED_COORDINATOR_ID);
    // The new envelope is role-scoped and exclusive; the old one stays as history.
    const newEnvelope = coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID);
    expect(result.session_file).toBe(newEnvelope);
    expect(readJson(newEnvelope)).toMatchObject({
      schema_version: 1,
      role: "coordinator",
      session_id: RECOVERED_COORDINATOR_ID,
      workflow_id: PREPARE_WORKFLOW,
    });
    expect(existsSync(fixture.coordinatorSession)).toBe(true);
    expect(recordedCoordinatorOf(fixture)).toMatchObject({
      session_id: RECOVERED_COORDINATOR_ID,
      session_file: newEnvelope,
    });

    // The immutable audit record carries exactly the contract's required fields.
    const audit = recoveryAuditOf(fixture);
    expect(audit).toHaveLength(1);
    expect(Object.keys(audit[0]!).sort()).toEqual([
      "authorization_ref",
      "compass_version",
      "operation_id",
      "prior_session_id",
      "reason",
      "recovered_at",
      "request_hash",
      "session_id",
      "snapshot_version_before",
      "stopped_session_ids",
      "workflow_id",
    ]);
    expect(audit[0]).toMatchObject({
      operation_id: "op-recover-1",
      workflow_id: PREPARE_WORKFLOW,
      prior_session_id: FIXTURE_COORDINATOR_ID,
      session_id: RECOVERED_COORDINATOR_ID,
      authorization_ref: "PM-authorization-20260921",
      reason: "the prior host session was cancelled and cannot authenticate",
      stopped_session_ids: [FIXTURE_COORDINATOR_ID],
      compass_version: tokens.compassVersion,
      snapshot_version_before: tokens.snapshotVersion,
    });
    expect(audit[0]!.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(audit[0]!.recovered_at).toBe(result.recovery.recoveredAt);

    // Every row, branch anchor and the sibling workflow survive byte-for-byte;
    // the prior envelope file is retained (never deleted, never rewritten).
    expect(stableJson(prepareSnapshotOf(fixture).plans)).toBe(planRows);
    expect(stableJson(prepareSnapshotOf(fixture).branch)).toBe(branch);
    expect(readFileSync(fixture.statusPath, "utf8")).toBe(before.status);
    expect(readFileSync(fixture.compassPath, "utf8")).toBe(before.compass);
    expect(readFileSync(fixture.peerSnapshotPath, "utf8")).toBe(before.peer);
    expect(readFileSync(fixture.coordinatorSession, "utf8")).toBe(before.session);

    // The old reference is historical: its envelope still names the old owner,
    // and every Prepare verb now refuses it because the BINDING moved.
    const oldUse = await prepareRefusalOf(() => prepareViewOf(fixture, fixture.coordinatorSession));
    expect(oldUse.code).toBe("coordination.session-mismatch");
    // The replacement session is the live coordinator.
    const live = await prepareViewOf(fixture, newEnvelope);
    expect(live.view.allowed).toBe(true);
    expect(live.session.session_id).toBe(RECOVERED_COORDINATOR_ID);
  }, 30000);

  test("prepare coordinator recovery refuses foreign, unauthorized, stale and executed requests without mutating", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const before = protectedBytes(fixture);
    const tokens = await recoveryViewOf(fixture);
    // A second coordinator envelope that exists but is NOT the recorded binding:
    // a valid file the caller could point at, which still proves nothing.
    const impostorEnvelope = coordinatorEnvelopeOf(fixture, "impostor-session");
    writeJson(impostorEnvelope, {
      schema_version: 1,
      role: "coordinator",
      session_id: "impostor-session",
      workflow_id: PREPARE_WORKFLOW,
      harness_root: fixture.harness,
    });

    const cases: ReadonlyArray<{ name: string; overrides: Record<string, unknown>; code: string }> = [
      {
        name: "a prior session id the workflow does not record",
        overrides: { priorSessionId: "someone-else" },
        code: "coordination.identity-recovery.foreign-owner",
      },
      {
        name: "a prior envelope that is not the recorded binding",
        overrides: { priorSessionPath: impostorEnvelope, priorSessionId: "impostor-session" },
        code: "coordination.identity-recovery.foreign-owner",
      },
      {
        name: "a stop assertion that does not name the recorded holder",
        overrides: { stoppedSessionIds: ["some-other-session"] },
        code: "coordination.identity-recovery.unauthorized",
      },
      {
        name: "no stop assertion at all",
        overrides: { stoppedSessionIds: [] },
        code: "coordination.identity-recovery.unauthorized",
      },
      {
        name: "no authorization reference",
        overrides: { authorizationRef: "" },
        code: "coordination.identity-recovery.invalid-request",
      },
      { name: "no reason", overrides: { reason: "" }, code: "coordination.identity-recovery.invalid-request" },
      { name: "no operation id", overrides: { operationId: "" }, code: "coordination.identity-recovery.invalid-request" },
      {
        name: "a stale snapshot token",
        overrides: { expectedSnapshotVersion: `sha256:${"0".repeat(64)}` },
        code: "coordination.identity-recovery.stale",
      },
      {
        name: "a stale compass token",
        overrides: { expectedCompassVersion: `sha256:${"0".repeat(64)}` },
        code: "coordination.identity-recovery.stale",
      },
      {
        name: "an identity addressing a workflow that records no coordinator binding",
        overrides: {
          identity: { source: "local", sessionId: RECOVERED_COORDINATOR_ID, workflowId: PREPARE_PEER, role: "coordinator", planId: null },
        },
        code: "coordination.identity-recovery.not-prepare",
      },
      {
        name: "a plan-scoped identity",
        overrides: {
          identity: { source: "local", sessionId: RECOVERED_COORDINATOR_ID, workflowId: PREPARE_WORKFLOW, role: "coordinator", planId: "plan-a" },
        },
        code: "coordination.identity-mismatch",
      },
      {
        name: "the recorded owner itself",
        overrides: { identity: recoveredIdentity(FIXTURE_COORDINATOR_ID) },
        code: "coordination.identity-recovery.invalid-request",
      },
      {
        name: "an unknown input field",
        overrides: { force: true },
        code: "coordination.forbidden-field",
      },
    ];
    for (const recoveryCase of cases) {
      const failure = await failureOf(() =>
        recoverPrepareCoordinator(
          recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion }, recoveryCase.overrides),
        ),
      );
      const refusal = failure instanceof CoordinationError ? failure : undefined;
      expect(`${recoveryCase.name}: ${refusal?.code}`).toBe(`${recoveryCase.name}: ${recoveryCase.code}`);
      // §3.3/§5: a recovery refusal repeats neither a rejected value nor an
      // envelope path — it carries the code, the already-public ids and the
      // canonical base. The two foreign-owner cases below are the ones that once
      // interpolated both envelope paths; the invariant is pinned over every case.
      const projected = `${failure.message} ${JSON.stringify(refusal?.details ?? {})}`;
      expect(`${recoveryCase.name}: ${projected.includes(impostorEnvelope)}`).toBe(`${recoveryCase.name}: false`);
      expect(`${recoveryCase.name}: ${projected.includes(fixture.coordinatorSession)}`).toBe(`${recoveryCase.name}: false`);
      // The rejected prior session id of the first foreign-owner case is a value
      // the caller named, not a public record: it is never echoed back either.
      expect(`${recoveryCase.name}: ${projected.includes("someone-else")}`).toBe(`${recoveryCase.name}: false`);
      expect(protectedBytes(fixture)).toEqual(before);
      expect(existsSync(coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID))).toBe(false);
    }

    // An executed row (any row coordination block) is never recovered: the
    // ORIGINAL all-row admission decides, and nothing is written.
    const snapshot = prepareSnapshotOf(fixture);
    (snapshot.plans[0] as Record<string, unknown>).coordination = { revision: 1 };
    writeJson(fixture.snapshotPath, snapshot);
    const executed = protectedBytes(fixture);
    const activeRefusal = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(fixture, {
          snapshot: readArtifactBytes(fixture.snapshotPath)!.version,
          compass: tokens.compassVersion,
        }),
      ),
    );
    expect(activeRefusal.code).toBe("coordination.identity-recovery.execution-started");
    expect(protectedBytes(fixture)).toEqual(executed);
  }, 60000);

  test("prepare coordinator recovery refuses a concurrent second attempt and a replayed different request", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);

    const [first, second] = await Promise.allSettled([
      recoverPrepareCoordinator(recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion })),
      recoverPrepareCoordinator(
        recoveryInputOf(
          fixture,
          { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
          { operationId: "op-recover-2", identity: recoveredIdentity(RECOVERED_COORDINATOR_ID_2) },
        ),
      ),
    ]);

    expect([first, second].filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = [first, second].find((entry) => entry.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("expected exactly one refused concurrent recovery");
    // The loser reviewed the pre-recovery bytes, so it is refused as stale (the
    // same optimistic-concurrency verdict the amendment reports) and writes
    // nothing at all.
    expect((rejected.reason as CoordinationError).code).toBe("coordination.identity-recovery.stale");
    // Exactly one owner and exactly one audit entry: the loser wrote nothing.
    const audit = recoveryAuditOf(fixture);
    expect(audit).toHaveLength(1);
    expect(recordedCoordinatorOf(fixture).session_id).toBe(audit[0]!.session_id);
    const loserId = audit[0]!.session_id === RECOVERED_COORDINATOR_ID ? RECOVERED_COORDINATOR_ID_2 : RECOVERED_COORDINATOR_ID;
    expect(existsSync(coordinatorEnvelopeOf(fixture, loserId))).toBe(false);

    // A replayed operation id with a DIFFERENT request is not the same
    // operation: it refuses without moving anything.
    const boundBytes = readFileSync(fixture.snapshotPath, "utf8");
    const boundFile = recordedCoordinatorOf(fixture).session_file;
    const replayDifferent = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(
          fixture,
          { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
          {
            operationId: audit[0]!.operation_id as string,
            reason: "a different reason entirely",
            priorSessionId: audit[0]!.prior_session_id as string,
          },
        ),
      ),
    );
    expect(replayDifferent.code).toBe("coordination.identity-recovery.operation-conflict");
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(boundBytes);
    expect(recordedCoordinatorOf(fixture).session_file).toBe(boundFile);
  }, 60000);

  test("prepare coordinator recovery returns the recorded receipt on an exact retry without revision churn", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const request = recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion });

    const first = await recoverPrepareCoordinator(request);
    const committedBytes = readFileSync(fixture.snapshotPath, "utf8");
    const committedVersion = readArtifactBytes(fixture.snapshotPath)!.version;
    const firstEntry = recoveryAuditOf(fixture)[0]!;

    // The SAME request again — with the tokens it was authorized against, which
    // its own commit has since superseded.
    const retry = await recoverPrepareCoordinator(request);

    expect(retry.ok).toBe(true);
    expect(retry.recovery.replay).toBe(true);
    expect(retry.recovery.operationId).toBe(first.recovery.operationId);
    expect(retry.recovery.requestHash).toBe(first.recovery.requestHash);
    expect(retry.recovery.sessionId).toBe(RECOVERED_COORDINATOR_ID);
    expect(retry.session_file).toBe(first.session_file);
    // No revision churn: the snapshot bytes are still the winner's.
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(committedBytes);
    expect(readArtifactBytes(fixture.snapshotPath)!.version).toBe(committedVersion);
    expect(recoveryAuditOf(fixture)).toHaveLength(1);

    // A second, distinct recovery appends EXACTLY one entry and preserves the
    // whole previous prefix by value.
    const second = await recoverPrepareCoordinator(
      recoveryInputOf(
        fixture,
        { snapshot: committedVersion, compass: tokens.compassVersion },
        {
          operationId: "op-recover-3",
          identity: recoveredIdentity(RECOVERED_COORDINATOR_ID_2),
          priorSessionId: RECOVERED_COORDINATOR_ID,
          priorSessionPath: first.session_file,
          stoppedSessionIds: [RECOVERED_COORDINATOR_ID],
        },
      ),
    );
    expect(second.recovery.replay).toBe(false);
    expect(second.recovery.sessionId).toBe(RECOVERED_COORDINATOR_ID_2);
    const audit = recoveryAuditOf(fixture);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toEqual(firstEntry);

    // The first operation's replay is no longer this workflow's state.
    const superseded = await prepareRefusalOf(() => recoverPrepareCoordinator(request));
    expect(superseded.code).toBe("coordination.identity-recovery.operation-conflict");
  }, 60000);

  test("prepare coordinator recovery reclaims only its own envelope after an envelope-before-snapshot failure", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const newEnvelope = coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID);
    const before = protectedBytes(fixture);
    const request = recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion });

    // An IO failure between the exclusive envelope creation and the snapshot
    // commit is NOT a semantic refusal: the call reports failure, never a
    // success receipt, and reclaims exactly the envelope it created.
    instrumentLocalStore(fixture.harness, (inner) => new FailOnceSnapshotStore(inner));
    await expect(recoverPrepareCoordinator(request)).rejects.toThrow(/injected store failure/);
    expect(existsSync(newEnvelope)).toBe(false);
    expect(protectedBytes(fixture)).toEqual(before);
    expect(recoveryAuditOf(fixture)).toEqual([]);

    // The retry is lawful: nothing was left behind, and the reviewed tokens
    // still describe the same authorized request.
    setArtifactStore(createFsStore(fixture.harness));
    const retry = await recoverPrepareCoordinator(request);
    expect(retry.recovery.replay).toBe(false);
    expect(recoveryAuditOf(fixture)).toHaveLength(1);

    // A leftover envelope is reclaimed ONLY when its bytes are exactly the ones
    // this call would write. Those bytes are the session JSON, so they prove the
    // same TARGET SESSION — not the same operation.
    const crashed = makePrepareFixture();
    await ensurePrepareCoordinator(crashed);
    const crashedTokens = await recoveryViewOf(crashed);
    writeText(
      coordinatorEnvelopeOf(crashed, RECOVERED_COORDINATOR_ID),
      `${JSON.stringify(
        {
          schema_version: 1,
          role: "coordinator",
          session_id: RECOVERED_COORDINATOR_ID,
          workflow_id: PREPARE_WORKFLOW,
          harness_root: crashed.harness,
        },
        null,
        2,
      )}\n`,
    );
    const reclaimed = await recoverPrepareCoordinator(
      recoveryInputOf(crashed, { snapshot: crashedTokens.snapshotVersion, compass: crashedTokens.compassVersion }),
    );
    expect(reclaimed.recovery.replay).toBe(false);
    expect(recoveryAuditOf(crashed)).toHaveLength(1);

    // A file that is NOT this operation's envelope is never overwritten.
    const alien = makePrepareFixture();
    await ensurePrepareCoordinator(alien);
    const alienTokens = await recoveryViewOf(alien);
    const alienEnvelope = coordinatorEnvelopeOf(alien, RECOVERED_COORDINATOR_ID);
    writeText(alienEnvelope, `${JSON.stringify({ schema_version: 1, role: "coordinator", session_id: "someone-else" })}\n`);
    const alienBytes = readFileSync(alienEnvelope, "utf8");
    const refusal = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(alien, { snapshot: alienTokens.snapshotVersion, compass: alienTokens.compassVersion }),
      ),
    );
    expect(refusal.code).toBe("coordination.identity-recovery.invalid-request");
    expect(readFileSync(alienEnvelope, "utf8")).toBe(alienBytes);
    expect(recoveryAuditOf(alien)).toEqual([]);
  }, 60000);

  test("prepare coordinator recovery re-checks the reviewed compass before committing and reclaims only its own envelope", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const before = protectedBytes(fixture);
    const newEnvelope = coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID);

    // A concurrent compass edit lands in the window between this recovery's
    // exclusive envelope creation and its commit CAS. The snapshot write lock
    // does not lock the compass file, so without the final recheck the recovery
    // would commit and record a `compass_version` that was no longer current.
    setPrepareRecoveryEnvelopeGapForTest(() => {
      writeText(fixture.compassPath, `${readFileSync(fixture.compassPath, "utf8")}\n`);
    });
    let refusal: { code: string; details: Record<string, unknown> };
    try {
      refusal = await prepareRefusalOf(() =>
        recoverPrepareCoordinator(
          recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion }),
        ),
      );
    } finally {
      setPrepareRecoveryEnvelopeGapForTest(undefined);
    }

    expect(refusal.code).toBe("coordination.identity-recovery.stale");
    // No snapshot mutation, no audit entry, and only THIS operation's envelope
    // reclaimed; the prior envelope stays as history.
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before.snapshot);
    expect(readFileSync(fixture.coordinatorSession, "utf8")).toBe(before.session);
    expect(recoveryAuditOf(fixture)).toEqual([]);
    expect(existsSync(newEnvelope)).toBe(false);
    expect(readdirSync(join(fixture.workflowDir, "sessions"))).toEqual([basename(fixture.coordinatorSession)]);

    // The refusal wrote nothing, so a re-reviewed recovery is lawful.
    const fresh = await recoveryViewOf(fixture);
    const retry = await recoverPrepareCoordinator(
      recoveryInputOf(fixture, { snapshot: fresh.snapshotVersion, compass: fresh.compassVersion }),
    );
    expect(retry.recovery.replay).toBe(false);
    expect(recoveryAuditOf(fixture)).toHaveLength(1);
  }, 60000);

  test("prepare coordinator recovery never unlinks an envelope that was replaced after its exclusive creation", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const before = protectedBytes(fixture);
    const newEnvelope = coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID);
    const alien = `${JSON.stringify({ schema_version: 1, role: "plan-pm", session_id: "somebody-else" })}\n`;

    // The snapshot commit fails AND the path this call created exclusively has
    // since been replaced by an unrelated session file: `created` is only a
    // historical boolean, so cleanup must compare the CURRENT bytes before it
    // unlinks anything, and leave the replacement untouched.
    instrumentLocalStore(
      fixture.harness,
      (inner) => new ReplaceEnvelopeOnFailureStore(inner, newEnvelope, alien),
    );
    await expect(
      recoverPrepareCoordinator(recoveryInputOf(fixture, { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion })),
    ).rejects.toThrow(/injected store failure/);
    setArtifactStore(createFsStore(fixture.harness));

    expect(readFileSync(newEnvelope, "utf8")).toBe(alien);
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(before.snapshot);
    expect(readFileSync(fixture.coordinatorSession, "utf8")).toBe(before.session);
    expect(recoveryAuditOf(fixture)).toEqual([]);
  }, 60000);

  test("prepare coordinator recovery refuses a malformed stop-list entry before hashing, storing or echoing it", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const before = protectedBytes(fixture);

    // A stop entry is hashed into the request digest and persisted in the
    // immutable audit: only public session ids are acceptable, never an
    // arbitrary string (path-like or credential-like). The refusal is itself a
    // PUBLIC diagnostic (§5), so it must not repeat the rejected value — the
    // caller learns the rule and the entry's position/length instead.
    const rejected = ["a/b", "../creds/secret.json", `ghp_${"a".repeat(140)}`, "with space"];
    for (const entry of rejected) {
      const failure = await failureOf(() =>
        recoverPrepareCoordinator(
          recoveryInputOf(
            fixture,
            { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
            { stoppedSessionIds: [FIXTURE_COORDINATOR_ID, entry] },
          ),
        ),
      );
      if (!(failure instanceof CoordinationError)) throw failure;
      const label = `${JSON.stringify(entry).slice(0, 12)}:`;
      expect(`${label} ${failure.code}`).toBe(`${label} coordination.identity-recovery.invalid-request`);
      expect(failure.message).toContain("public session id");
      expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toContain(entry);
      expect(failure.details).toMatchObject({ index: 1, length: entry.length });
      expect(protectedBytes(fixture)).toEqual(before);
      expect(existsSync(coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID))).toBe(false);
    }

    // An empty entry is refused by the same field rule (it is not a session id
    // at all), and a non-array stop assertion reports its SHAPE rather than the
    // value it was given.
    const blank = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(
          fixture,
          { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
          { stoppedSessionIds: [FIXTURE_COORDINATOR_ID, ""] },
        ),
      ),
    );
    expect(blank.code).toBe("coordination.identity-recovery.invalid-request");
    const notAList = await prepareRefusalOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(
          fixture,
          { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
          { stoppedSessionIds: "credential-like-secret" },
        ),
      ),
    );
    expect(notAList.code).toBe("coordination.identity-recovery.unauthorized");
    expect(JSON.stringify(notAList.details)).not.toContain("credential-like-secret");
    expect(protectedBytes(fixture)).toEqual(before);
  }, 60000);

  test("prepare coordinator recovery never runs the JSON writer under an active execution authority", async () => {
    const fixture = makePrepareFixture();
    await ensurePrepareCoordinator(fixture);
    const tokens = await recoveryViewOf(fixture);
    const before = protectedBytes(fixture);

    // A REAL active execution authority on a genuinely separate control root
    // (its own Git repo and its own `.mstar`, so the store probe addresses it and
    // not this fixture's root): the create-only empty-execution initializer needs
    // an empty execution workspace, which is exactly what such a root is. The
    // authority veto decides before any payload, token or path is inspected, so
    // the fixture's reviewed tokens and recorded binding are never reached.
    const activeRoot = realpathSync(mkdtempSync(join(tmpdir(), "mstar-recovery-active-")));
    roots.push(activeRoot);
    git(["init", "-q", "-b", "main"], activeRoot);
    const activeHarness = join(activeRoot, ".mstar");
    mkdirSync(activeHarness, { recursive: true });
    const handle = await initializeStore({ harnessDir: activeHarness });
    handle.close();
    await initializeExecutionAuthority({ harnessDir: activeHarness });

    const failure = await failureOf(() =>
      recoverPrepareCoordinator(
        recoveryInputOf(
          fixture,
          { snapshot: tokens.snapshotVersion, compass: tokens.compassVersion },
          { cwd: activeRoot, harnessDir: activeHarness },
        ),
      ),
    );
    expect("code" in failure && typeof failure.code === "string" ? failure.code : "").toBe("execution.direct-write-refused");
    // ... and it points at the existing DB recovery verb instead of aliasing it.
    expect(failure.message).toContain("session recover");
    expect(existsSync(coordinatorEnvelopeOf(fixture, RECOVERED_COORDINATOR_ID))).toBe(false);
    expect(protectedBytes(fixture)).toEqual(before);
  }, 60000);
});

/* ------------------------------------------------------------------------ *
 * Catalog execution pin (state-projection contract §1)
 * ------------------------------------------------------------------------ */

/**
 * The refusal of a call expected to hit the frozen-input pin. The pin conflict
 * is its own documented code (`catalog.execution-pin-conflict`, contract §1),
 * not a coordination-surface error, so this narrows on the stable `code` field
 * exactly as a CLI consumer does.
 */
async function pinConflictOf(run: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await run();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ...(typeof code === "string" ? { code } : {}), message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error("expected the coordination call to fail");
}

/** The plan row as stored on disk (the frozen execution input). */
function storedRow(fixture: Fixture, planId: string): Record<string, unknown> {
  const snapshot = readJson(fixture.snapshotPath) as { plans: Array<Record<string, unknown>> };
  return snapshot.plans.find((row) => row.id === planId || row.plan_id === planId)!;
}

function pinOf(row: Record<string, unknown>): CatalogExecutionPin {
  return (row.metadata as Record<string, unknown>).catalog_pin as CatalogExecutionPin;
}

describe("catalog pin — frozen prepare inputs (state-projection contract §1)", () => {
  test("catalog pin: prepare records the pin, and a later catalog move leaves the prepared execution stable", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture);
    await preparePlan(fixture, PLAN_ID);

    const row = storedRow(fixture, PLAN_ID);
    const pin = pinOf(row);
    const handle = await openStore(context, "read");
    const storeId = handle.storeId;
    handle.close();
    expect(pin.store_id).toBe(storeId);
    expect(pin.entity_revision).toBe(1);
    expect(pin.document_hash).toBe(executionInputHash(row, PLAN_ID));

    // The current catalog moves (a renamed title bumps the entity revision).
    await updateCatalogEntity(context, { kind: "plan", id: PLAN_ID }, { title: "Renamed" }, 1, {
      operationId: "upd-title",
      actor: "project-manager",
    });

    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect(view.catalog_pin?.pin).toEqual(pin);
    expect(view.catalog_pin?.catalog_moved).toBe(true);
    expect(view.catalog_pin?.current_revision).toBe(2);
    expect(view.catalog_pin?.conflict).toBeNull();
    // The frozen row itself never follows the catalog.
    const after = storedRow(fixture, PLAN_ID);
    expect(after.file).toBe(row.file);
    expect(pinOf(after)).toEqual(pin);
    // Execution may start on the pinned input.
    const bound = await bindPlan(fixture, PLAN_ID);
    expect(bound.outcome).toBe("claimed");
  });

  test("catalog pin: an authorized prepare records the new catalog revision, while the earlier pin stays frozen", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture, [PLAN_ID, PEER_PLAN_ID]);
    await preparePlan(fixture, PLAN_ID);
    const first = pinOf(storedRow(fixture, PLAN_ID));
    // Both plan entities move on: their revisions (the pin's selection pointer)
    // are now 2.
    await updateCatalogEntity(context, { kind: "plan", id: PLAN_ID }, { title: "Renamed" }, 1, {
      operationId: "upd-title-a",
      actor: "project-manager",
    });
    await updateCatalogEntity(context, { kind: "plan", id: PEER_PLAN_ID }, { title: "Renamed" }, 1, {
      operationId: "upd-title-b",
      actor: "project-manager",
    });

    // The authorized prepare is the pin writer: a later prepare (another plan
    // row of the same workflow) selects the CURRENT catalog revision.
    await preparePlan(fixture, PEER_PLAN_ID);
    const second = pinOf(storedRow(fixture, PEER_PLAN_ID));
    expect(second.entity_revision).toBe(2);
    expect(second.store_id).toBe(first.store_id);
    expect(second.entity_revision).not.toBe(first.entity_revision);

    // The already-prepared row keeps its own pin: a re-prepare of that row is
    // refused (the frozen input is immutable), so the move cannot be applied
    // retroactively.
    const refused = await errorCodeOf(() => preparePlan(fixture, PLAN_ID));
    expect(refused).toBe("coordination.invalid-transition");
    expect(pinOf(storedRow(fixture, PLAN_ID))).toEqual(first);
    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect(view.catalog_pin?.pin).toEqual(first);
    expect(view.catalog_pin?.catalog_moved).toBe(true);
    expect(view.catalog_pin?.conflict).toBeNull();
  });

  test("catalog pin: a frozen input edited after preparation refuses and is never overwritten", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture);
    await preparePlan(fixture, PLAN_ID);
    const pinned = pinOf(storedRow(fixture, PLAN_ID));

    // A generic snapshot metadata update (NOT an authorized prepare) re-points
    // the row's document: the pin and the frozen input now disagree.
    const snapshot = readJson(fixture.snapshotPath) as { plans: Array<Record<string, unknown>> };
    snapshot.plans = snapshot.plans.map((row) =>
      row.id === PLAN_ID || row.plan_id === PLAN_ID ? { ...row, file: `.mstar/plans/elsewhere.md` } : row,
    );
    writeJson(fixture.snapshotPath, snapshot);
    const tamperedBytes = readFileSync(fixture.snapshotPath, "utf8");

    const refusal = await pinConflictOf(() => bindPlan(fixture, PLAN_ID));
    expect(refusal.code).toBe(EXECUTION_PIN_CONFLICT_CODE);
    // Neither side is overwritten: the row keeps its edited bytes and the
    // catalog keeps its own revision.
    expect(readFileSync(fixture.snapshotPath, "utf8")).toBe(tamperedBytes);
    const handle = await openStore(context, "read");
    const catalogRevision = handle.db.prepare("select catalog_revision from store_meta where id = 1").get() as {
      catalog_revision: number;
    };
    handle.close();
    expect(catalogRevision.catalog_revision).toBe(1);
    expect(pinned.entity_revision).toBe(1);

    // The view discloses the conflict instead of hiding it.
    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    expect(view.catalog_pin?.conflict).not.toBeNull();
    expect(view.catalog_pin?.pin).toEqual(pinned);
  });

  test("catalog pin: progress reporting does not invalidate the pin", async () => {
    const fixture = makeFixture();
    await storeBacked(fixture);
    await preparePlan(fixture, PLAN_ID);
    await bindPlan(fixture, PLAN_ID);
    const pinned = pinOf(storedRow(fixture, PLAN_ID));

    const view = await readPlanCoordination(fixture.planSession, undefined, fixture.root);
    await mutatePlanCoordination({
      sessionPath: fixture.planSession,
      expectedRevision: view.revision,
      operation: {
        kind: "progress",
        progress: { status: "InProgress", summary: "executing", evidence_paths: [] },
      },
    });

    const after = await readPlanCoordination(fixture.planSession, undefined, fixture.root);
    expect(after.catalog_pin?.conflict).toBeNull();
    expect(after.catalog_pin?.pin).toEqual(pinned);
    expect(pinOf(storedRow(fixture, PLAN_ID))).toEqual(pinned);
  });
});

describe("catalog registration gate — prepare/bind/selection refuse a pending workflow (state-projection contract §3)", () => {
  /**
   * Reconstructs the crash state a dispatch reader must refuse: a journal row
   * for the fixture's root-visible workflow that is NOT committed. The gate
   * only reads the pending row's workflow id, so a minimal delta suffices.
   */
  async function seedPendingRegistration(fixture: Fixture, context: StoreContext, phase: "prepared" | "execution-written"): Promise<void> {
    const handle = await openStore(context, "write");
    const at = new Date().toISOString();
    handle.db
      .prepare(
        "insert into catalog_operations(operation_id, request_hash, phase, catalog_delta_json, before_versions_json, after_versions_json, result_json, created_at, updated_at) " +
          "values ('op-pending-gate', 'gate-fixture', ?, ?, '{}', '{}', null, ?, ?)",
      )
      .run(phase, JSON.stringify({ workflow: { workflowId: WORKFLOW_ID } }), at, at);
    handle.close();
  }

  test("bind refuses a root-visible workflow whose registration is pending (prepared phase)", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture);
    await seedPendingRegistration(fixture, context, "prepared");
    const refusal = await pinConflictOf(() =>
      bindPlanSession({
        coordinator: true,
        workflowId: WORKFLOW_ID,
        harnessDir: fixture.harness,
        cwd: fixture.root,
        sessionId: FIXTURE_COORDINATOR_ID,
      }),
    );
    expect(refusal.code).toBe("catalog.registration-pending");
    // The refusal is not a repair: nothing moved.
    expect(existsSync(join(fixture.harness, "workflows", WORKFLOW_ID, "session-"))).toBe(false);
  });

  test("prepare refuses a root-visible workflow whose registration is pending (execution-written phase)", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture);
    // The coordinator binds BEFORE the pending operation exists — the gate is
    // evaluated per reader call, not amortized into a one-time check.
    await ensureCoordinator(fixture);
    await seedPendingRegistration(fixture, context, "execution-written");
    const refusal = await pinConflictOf(() => preparePlan(fixture, PLAN_ID));
    expect(refusal.code).toBe("catalog.registration-pending");
    // No prepared block was written.
    const view = readJson(fixture.snapshotPath);
    const row = (view.plans as Array<Record<string, unknown>>).find((r) => r.id === PLAN_ID)!;
    expect(row.coordination).toBeUndefined();
  });

  test("the selection view refuses the same pending workflow", async () => {
    const fixture = makeFixture();
    const context = await storeBacked(fixture);
    await ensureCoordinator(fixture);
    await seedPendingRegistration(fixture, context, "execution-written");
    const refusal = await pinConflictOf(() => readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root));
    expect(refusal.code).toBe("catalog.registration-pending");
  });

  test("a root-visible workflow with NO journal row keeps the pass-through", async () => {
    const fixture = makeFixture();
    await storeBacked(fixture);
    // Active store, root-visible workflow, no catalog_operations row at all:
    // prepare and bind succeed unchanged (pre-activation/registered-excluded
    // workspaces are never retro-refused).
    await preparePlan(fixture, PLAN_ID);
    const bound = await bindPlan(fixture, PLAN_ID);
    expect(bound.outcome).toBe("claimed");
  });
});
