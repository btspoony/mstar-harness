/**
 * Engine coordinator plan coordination — binding, scope/revisions and issue
 * authority (including the findings-gate issue-authority cases).
 *
 * There is ONE coordinator per workflow and no plan-PM seat: a plan is an
 * explicit operation address, never a session scope. Binding acquires the
 * workflow-wide coordinator identity; `prepare` is ordinary revisable
 * configuration; `residual-add`/`residual-close` are the issue-store authority
 * the findings gate reads.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  bindPlanSession,
  mutatePlanCoordination,
  readPlanCoordination,
  type CoordinationResult,
} from "../src/coordination.js";
import { openStore } from "../src/store-db.js";
import { CoordinationError, validateSnapshotCoordination } from "../src/coordination-write.js";
import {
  WORKFLOW_ID, PLAN_ID, PEER_PLAN_ID, FIXTURE_COORDINATOR_ID,
  git, writeText, writeJson, readJson, makeFixture, errorCodeOf, failureCode,
  ensureCoordinator, coordinatorCall, prepareCall, progressCall,
  gitFixture, snapshotOf, planRowOf,
  completionEvidenceOf, sealStoreForReaders, afterEachCleanup, finding, linkedOpenIssues,
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

/* ------------------------------------------------------------------------ *
 * Binding — one workflow-wide coordinator
 * ------------------------------------------------------------------------ */

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
    // (The concrete refusal code is the core owner's; the observable contract is
    // that the call fails and mutates nothing.)
    const second = await errorCodeOf(() =>
      bindPlanSession({
        coordinator: true,
        workflowId: WORKFLOW_ID,
        harnessDir: fixture.harness,
        cwd: fixture.root,
        sessionId: "second-coordinator",
      }),
    );
    expect(typeof second).toBe("string");
    const after = readJson(fixture.snapshotPath) as { coordination?: { coordinator?: { session_file?: string } } };
    expect(after.coordination?.coordinator?.session_file).toBe(fixture.coordinatorSession);
  });

  test("a caller-supplied session id is adopted as the identity and the envelope name", async () => {
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
    const refused = await errorCodeOf(() =>
      bindPlanSession({
        coordinator: true,
        workflowId: WORKFLOW_ID,
        harnessDir: fresh.harness,
        cwd: fresh.root,
        sessionId: "host-session-orphan",
      }),
    );
    expect(typeof refused).toBe("string");
    expect(readJson(fresh.snapshotPath)).toEqual(freshBefore);
    // The occupant is untouched too: the refusal hijacks no identity.
    expect(readJson(orphan)).toEqual({ stray: true });
  });

  test("an explicit id is adopted, two same-workflow binds retain one owner, and a foreign root never inherits it", async () => {
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
    const second = await errorCodeOf(() =>
      bindPlanSession({
        coordinator: true,
        workflowId: WORKFLOW_ID,
        harnessDir: fixture.harness,
        cwd: fixture.root,
        sessionId: "host-session-other",
      }),
    );
    expect(typeof second).toBe("string");
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

  test("the operation surface is closed and never advertised to a non-coordinator", async () => {
    const fixture = makeFixture();
    await prepareCall(fixture, PLAN_ID);

    // An operation kind the closed union does not carry.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.coordinatorSession,
          planId: PLAN_ID,
          operation: { kind: "publish" } as never,
        }),
      ),
    ).toBe("coordination.unknown-operation");
    // The retired ownership-transfer kinds are gone, not unknown-but-listed.
    for (const kind of ["handoff", "accept", "return", "integration-start", "integration-accept", "reconcile", "release"]) {
      expect(
        await errorCodeOf(() =>
          mutatePlanCoordination({
            sessionPath: fixture.coordinatorSession,
            planId: PLAN_ID,
            operation: { kind } as never,
          }),
        ),
      ).toBe("coordination.unknown-operation");
    }
    // A precondition on the operation itself is refused: it belongs to the request.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.coordinatorSession,
          planId: PLAN_ID,
          operation: { kind: "progress", expectedRevision: 1 } as never,
        }),
      ),
    ).toBe("coordination.invalid-input");

    // A coordinator view of an unprepared row advertises its ordinary operations.
    const unprepared = await readPlanCoordination(fixture.coordinatorSession, PEER_PLAN_ID, fixture.root);
    expect(unprepared.allowed_operations).toContain("prepare");
    expect(unprepared.scope).toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * Issue authority — the store is the findings authority (G2a)
 * ------------------------------------------------------------------------ */

describe("issue-authority — coordinator plan issue operations (G2a)", () => {
  test("issue authority: residual-add captures issues in the store and links the plan; no register is written", async () => {
    const fixture = await gitFixture();
    await prepareCall(fixture, PLAN_ID);
    await prepareCall(fixture, PEER_PLAN_ID);

    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    const added = await mutatePlanCoordination({
      sessionPath: fixture.coordinatorSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [finding("r-1"), finding("r-2")] as never },
    });
    expect(added.outcome).toBe("residual-added");
    // The IDs are DB-allocated, so the writer reports them — the caller cannot
    // guess them the way it supplied the register entry ids.
    expect(added.issues).toEqual([
      { issue_id: "I-000001", revision: 2, created: true },
      { issue_id: "I-000002", revision: 2, created: true },
    ]);

    // The DB is the only mutation target: the issues exist, are linked to THIS
    // plan only, and no legacy register file was created anywhere.
    const open = await linkedOpenIssues(fixture, PLAN_ID);
    expect(open.map((issue) => issue.id)).toEqual(["I-000001", "I-000002"]);
    expect(existsSync(fixture.registerPath)).toBe(false);
    // No register byte version exists any more: the view reports the row's own
    // revision and the snapshot version only.
    const peerView = await readPlanCoordination(fixture.coordinatorSession, PEER_PLAN_ID, fixture.root);
    expect("register_version" in peerView).toBe(false);
    expect(await linkedOpenIssues(fixture, PEER_PLAN_ID)).toEqual([]);
  });

  test("issue authority: two independent processes capturing concurrently both land in the store", async () => {
    const fixture = await gitFixture();
    await prepareCall(fixture, PLAN_ID);
    await prepareCall(fixture, PEER_PLAN_ID);

    const script = join(fixture.root, "child-add.ts");
    writeText(
      script,
      [
        `import { bindPlanSession, mutatePlanCoordination, readPlanCoordination } from ${JSON.stringify(
          join(import.meta.dir, "..", "src", "coordination.ts"),
        )};`,
        `import { createFsStore, setArtifactStore } from ${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))};`,
        "const [root, harness, planId, sessionPath, occurrenceKey] = process.argv.slice(2);",
        "setArtifactStore(createFsStore(harness));",
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
      { planId: PLAN_ID, occurrenceKey: "occ-a" },
      { planId: PEER_PLAN_ID, occurrenceKey: "occ-b" },
    ].map((child) =>
      Bun.spawn([process.execPath, script, fixture.root, fixture.harness, child.planId, fixture.coordinatorSession, child.occurrenceKey], {
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
    await prepareCall(fixture, PLAN_ID);
    await prepareCall(fixture, PEER_PLAN_ID);

    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    const added = await mutatePlanCoordination({
      sessionPath: fixture.coordinatorSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [finding("r-1"), finding("r-2")] as never },
    });
    const second = added.issues![1]!;

    // A stale issue revision is a visible refusal: nothing is closed.
    const staleCode = await errorCodeOf(() =>
      mutatePlanCoordination({
        sessionPath: fixture.coordinatorSession,
        planId: PLAN_ID,
        expectedRevision: view.revision,
        operation: closeOp(second.issue_id, second.revision + 7) as never,
      }),
    );
    expect(staleCode).toBe("issue.revision-conflict");
    expect((await linkedOpenIssues(fixture, PLAN_ID)).map((issue) => issue.id)).toEqual(["I-000001", "I-000002"]);

    // The authorized close uses the issue revision the add reported.
    const closed = await mutatePlanCoordination({
      sessionPath: fixture.coordinatorSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: closeOp(second.issue_id, second.revision) as never,
    });
    expect(closed.outcome).toBe("residual-closed");
    expect(existsSync(fixture.registerPath)).toBe(false);
    const open = await linkedOpenIssues(fixture, PLAN_ID);
    expect(open.map((issue) => issue.id)).toEqual(["I-000001"]);

    // An exact replay of the close is idempotent, not a second transition: the
    // same operation id and input return the same result.
    const replayed = await mutatePlanCoordination({
      sessionPath: fixture.coordinatorSession,
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
          sessionPath: fixture.coordinatorSession,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: closeOp(second.issue_id, second.revision + 1) as never,
        }),
      ),
    ).toBe("store.operation-conflict");

    // A coordinator addressing a foreign plan cannot close an issue linked to
    // another plan: the refusal surfaces the issue contract's stable scope code.
    const peerView = await readPlanCoordination(fixture.coordinatorSession, PEER_PLAN_ID, fixture.root);
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath: fixture.coordinatorSession,
          planId: PEER_PLAN_ID,
          expectedRevision: peerView.revision,
          operation: closeOp("I-000001", 2) as never,
        }),
      ),
    ).toBe("issue.scope-refused");
  });
});

/* ------------------------------------------------------------------------ *
 * Findings gate — the issue store refuses approval while a critical finding is open
 * ------------------------------------------------------------------------ */

describe("findings-gate — issue authority (G2a)", () => {
  test("issue authority: an open critical issue refuses completion, closing it releases the gate", async () => {
    const fixture = await gitFixture();
    await prepareCall(fixture, PLAN_ID);
    await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "start", evidence_paths: [] });
    await progressCall(fixture, PLAN_ID, { status: "InReview", summary: "review", evidence_paths: [] });
    const view = await readPlanCoordination(fixture.coordinatorSession, PLAN_ID, fixture.root);
    const added = await mutatePlanCoordination({
      sessionPath: fixture.coordinatorSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "residual-add", entries: [finding("r-crit", { severity: "critical" })] as never },
    });
    const critical = added.issues![0]!;

    // An unresolved critical blocks approval under the plan's cleanup mode —
    // read from the issue store, never from a register.
    const snapshotBefore = readJson(fixture.snapshotPath);
    expect(
      await errorCodeOf(() =>
        coordinatorCall(fixture, PLAN_ID, { kind: "complete", evidence: completionEvidenceOf(fixture, fixture.planSha) }),
      ),
    ).toBe("coordination.findings-open");
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");

    // The authorized disposition (a separate act) releases the gate.
    const closed = await mutatePlanCoordination({
      sessionPath: fixture.coordinatorSession,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: closeOp(critical.issue_id, critical.revision) as never,
    });
    expect(closed.outcome).toBe("residual-closed");

    // With the finding disposed, the real merge completes the row.
    const mergeSha = headOf(fixture.integrationPath);
    git(
      ["-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--no-ff", fixture.planSha, "-m", "Merge plan-a"],
      fixture.integrationPath,
    );
    const completed = await coordinatorCall(
      fixture,
      PLAN_ID,
      {
        kind: "complete",
        evidence: completionEvidenceOf(fixture, fixture.planSha),
        integration: { base_sha: mergeSha, result_sha: headOf(fixture.integrationPath) },
      },
    );
    expect(completed.outcome).toBe("completed");
    expect(planRowOf(fixture, PLAN_ID).status).toBe("Done");
  }, 30000);

  test("issue authority: a missing or staged store refuses completion instead of passing it as no findings", async () => {
    const fixture = await gitFixture();
    await prepareCall(fixture, PLAN_ID);
    await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "start", evidence_paths: [] });
    await progressCall(fixture, PLAN_ID, { status: "InReview", summary: "review", evidence_paths: [] });
    const complete = () =>
      coordinatorCall(fixture, PLAN_ID, { kind: "complete", evidence: completionEvidenceOf(fixture, fixture.planSha) });

    // A staged store is the pre-activation exclusion window: the bytes exist, but
    // the DB is not yet the findings authority, so the step refuses rather than
    // treating "no readable open issues" as "clean".
    const staged = await openStore({ harnessDir: fixture.harness }, "write");
    try {
      staged.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
    } finally {
      staged.close();
    }
    const snapshotBefore = readJson(fixture.snapshotPath);
    expect(await errorCodeOf(complete)).toBe("coordination.store");
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");

    // A missing store is not an empty one either: the same step still refuses.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${join(fixture.harness, "store.db")}${suffix}`, { force: true });
    expect(await errorCodeOf(complete)).toBe("coordination.store");
    expect(readJson(fixture.snapshotPath)).toEqual(snapshotBefore);
    expect(planRowOf(fixture, PLAN_ID).status).toBe("InReview");
  }, 30000);
});

/* ------------------------------------------------------------------------ *
 * Revision / CAS and the write-lease seam
 * ------------------------------------------------------------------------ */

describe("scope-and-revisions", () => {
  test("a sparse intent omitting the session envelope and the revision reaches the same result (A02)", async () => {
    // § One resolver path (S2/E02): a caller that states neither `sessionPath`
    // nor `expectedRevision` names only its acquired identity, the plan it
    // addresses and the operation. The engine resolves the trusted root, the
    // addressed target and that identity's OWN envelope, and derives the
    // revision from the row — reaching exactly the result the fully specified
    // form reaches, with no invented revision and therefore no drift warning.
    const specified = makeFixture();
    const specifiedSession = await ensureCoordinator(specified);
    const specifiedEvidence = join(specified.sddDir, "evidence.txt");
    writeText(specifiedEvidence, "proof\n");
    const specifiedView = await readPlanCoordination(specifiedSession, PLAN_ID, specified.root);
    const specifiedResult = await mutatePlanCoordination({
      sessionPath: specifiedSession,
      planId: PLAN_ID,
      expectedRevision: specifiedView.revision,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [specifiedEvidence] } },
    });

    const sparse = makeFixture();
    await ensureCoordinator(sparse);
    const sparseEvidence = join(sparse.sddDir, "evidence.txt");
    writeText(sparseEvidence, "proof\n");
    const sparseResult = await mutatePlanCoordination({
      cwd: sparse.root,
      controlRoot: sparse.harness,
      identity: { source: "local", sessionId: FIXTURE_COORDINATOR_ID, workflowId: WORKFLOW_ID, role: "coordinator" },
      planId: PLAN_ID,
      operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [sparseEvidence] } },
    });

    expect(sparseResult.session_file).toBe(sparse.coordinatorSession);
    expect(sparseResult.outcome).toBe(specifiedResult.outcome);
    expect(sparseResult.recovery?.outcome).toBe(specifiedResult.recovery?.outcome);
    expect(sparseResult.recovery?.warnings).toEqual([]);
    expect(sparseResult.view?.revision).toBe(specifiedResult.view?.revision);
    expect(sparseResult.view?.row.status).toBe("InProgress");

    // The association is what the engine resolves the session from: with no
    // envelope AND no identity there is nothing to authenticate.
    const unassociated = makeFixture();
    await ensureCoordinator(unassociated);
    const before = await readPlanCoordination(unassociated.coordinatorSession, PLAN_ID, unassociated.root);
    const refusal = await errorCodeOf(() =>
      mutatePlanCoordination({
        cwd: unassociated.root,
        planId: PLAN_ID,
        operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [] } },
      }),
    );
    expect(typeof refusal).toBe("string");
    expect((await readPlanCoordination(unassociated.coordinatorSession, PLAN_ID, unassociated.root)).revision).toBe(before.revision);
  });

  test("a drifted revision token is a disclosed retry, not a conflict", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    const evidence = join(fixture.sddDir, "evidence.txt");
    writeText(evidence, "proof\n");
    const view = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);

    // A first progress report moves the row; the stale token of the earlier read
    // is transport freshness, so the second report is judged on its own effect.
    await progressCall(fixture, PLAN_ID, { status: "InProgress", summary: "one", evidence_paths: [evidence] });
    const second = await mutatePlanCoordination({
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: view.revision,
      operation: { kind: "progress", progress: { status: "InReview", summary: "two", evidence_paths: [evidence] } },
    });
    expect(second.outcome).toBe("progressed");
    expect(second.recovery?.warnings?.map((entry) => entry.code)).toContain("coordination.token-drifted");
    expect(second.view?.row.status).toBe("InReview");
  });

  test("progress is admission-checked: evidence-scoped and transition-guarded", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);
    const evidence = join(fixture.sddDir, "evidence.txt");
    writeText(evidence, "proof\n");
    const outside = join(fixture.root, "outside.txt");
    writeText(outside, "not mine\n");
    const view = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);

    // Evidence outside the plan's own plan/SDD area is refused.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [outside] } },
        }),
      ),
    ).toBe("coordination.path-mismatch");

    // Missing evidence is refused.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath,
          planId: PLAN_ID,
          expectedRevision: view.revision,
          operation: { kind: "progress", progress: { status: "InProgress", summary: "start", evidence_paths: [join(fixture.sddDir, "gone.txt")] } },
        }),
      ),
    ).toBe("coordination.invalid-input");

    const progressed = await progressCall(fixture, PLAN_ID, {
      status: "InReview",
      summary: "slice A implemented",
      evidence_paths: [evidence],
      track_branches: ["feature/plan-a"],
    });
    expect(progressed.outcome).toBe("progressed");
    const after = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    expect(after.row.status).toBe("InReview");
    const metadata = after.row.metadata as Record<string, unknown>;
    expect(metadata.track_branches).toEqual(["feature/plan-a"]);

    // The track branch may never be a snapshot branch or another plan's branch.
    for (const foreign of ["main", "feature/plan-b"]) {
      expect(
        await errorCodeOf(() =>
          mutatePlanCoordination({
            sessionPath,
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
      sessionPath,
      planId: PLAN_ID,
      expectedRevision: after.revision,
      operation: { kind: "progress", progress: { status: "Blocked", summary: "waiting on QC", evidence_paths: [evidence] } },
    });
    expect(blocked.outcome).toBe("progressed");
    const blockedView = await readPlanCoordination(sessionPath, PLAN_ID, fixture.root);
    expect(blockedView.row.status).toBe("Blocked");
    // Blocked → InReview is not an allowed transition (Blocked resumes to InProgress).
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath,
          planId: PLAN_ID,
          expectedRevision: blockedView.revision,
          operation: { kind: "progress", progress: { status: "InReview", summary: "resume out of order", evidence_paths: [evidence] } },
        }),
      ),
    ).toBe("coordination.progress-transition");
  });

  test("a coordinator addresses each row explicitly, and a missing planId is refused", async () => {
    const fixture = makeFixture();
    const sessionPath = await ensureCoordinator(fixture);

    // Every operation must address a row: there is no scope from a secondary seat.
    expect(
      await errorCodeOf(() =>
        mutatePlanCoordination({
          sessionPath,
          operation: { kind: "progress", progress: { status: "InProgress", summary: "x", evidence_paths: [] } },
        }),
      ),
    ).toBe("coordination.invalid-input");

    // A session file that is not an envelope at all is refused.
    const stray = join(fixture.root, "stray.json");
    writeJson(stray, { hello: "world" });
    expect(await errorCodeOf(() => readPlanCoordination(stray, PLAN_ID, fixture.root))).toBe("coordination.forbidden-field");
  });
});

describe("historical coordination snapshots", () => {
  test("accepts stored identity-recovery audit history without validating retired digest gates", () => {
    const result = validateSnapshotCoordination({
      coordinator: {
        session_id: "coordinator-1",
        session_file: "/tmp/coordinator.json",
        bound_at: "2026-10-03T00:00:00.000Z",
      },
      identity_recoveries: [
        {
          operation_id: "op-1",
          request_hash: "a".repeat(64),
          workflow_id: WORKFLOW_ID,
          prior_session_id: "prior",
          session_id: "coordinator-1",
          authorization_ref: "auth",
          reason: "stopped",
          stopped_session_ids: ["prior"],
          snapshot_version_before: "b".repeat(64),
          compass_version: "c".repeat(64),
          recovered_at: "2026-10-03T00:00:00.000Z",
        },
      ],
    });

    expect(result).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * Rehearsed failure shapes
 * ------------------------------------------------------------------------ */

describe("failure shapes", () => {
  test("a refusal carries a typed error, never a bare string", async () => {
    const fixture = makeFixture();
    const error = await (async () => {
      try {
        await readPlanCoordination(join(fixture.root, "absent.json"), PLAN_ID, fixture.root);
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(CoordinationError);
    expect(failureCode(error)).toBeDefined();
  });

  test("a replay of an identical prepare is already satisfied and writes nothing", async () => {
    const fixture = makeFixture();
    const result: CoordinationResult = await coordinatorCall(fixture, PLAN_ID, {
      kind: "prepare",
      config: { worktreePath: fixture.worktreePath, workingBranch: "feature/plan-a" },
    });
    expect(result.outcome).toBe("prepared");
    expect(result.issues).toBeUndefined();
  });
});
