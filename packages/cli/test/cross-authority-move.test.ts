import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  appendOccurrence,
  captureIssue,
  closeIssue,
  collaborationLocationOfRepoKey,
  discardMove,
  ensureCollaborationAuthority,
  getIssue,
  initializeStore,
  linkIssue,
  listIssues,
  moveAcrossAuthorities,
  moveIssue,
  openCollaborationStore,
  queryDashboard,
  queryOpenIssueRollup,
  registerCatalogEntity,
  reopenIssue,
  resolveCollaborationLocation,
  withCollaborationWrite,
  withStoreRead,
  type CaptureInput,
  type IssueDetail,
  type MoveRequest,
  type StoreContext,
} from "@mstar-harness/engine";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-cross-authority-move-acceptance-"));
const HOME = join(ROOT, "home");
let homeSpy: { mockRestore(): void } | undefined;
let sequence = 0;

beforeAll(() => {
  mkdirSync(HOME, { recursive: true });
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});

afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

async function checkout(label: string, execution = true): Promise<StoreContext> {
  const dir = join(ROOT, `${label}-${String(sequence++)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(dir, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=${label}-${String(sequence)}\n`);
  const context: StoreContext = { harnessDir: join(dir, ".mstar"), checkoutRoot: dir };
  mkdirSync(context.harnessDir, { recursive: true });
  if (execution) (await initializeStore(context)).close();
  await ensureCollaborationAuthority(context);
  return context;
}

function authorityOf(context: StoreContext): string {
  return resolveCollaborationLocation(context).repoKey;
}

async function registerProject(context: StoreContext, projectId: string): Promise<void> {
  await registerCatalogEntity(
    context,
    { kind: "project", id: projectId, title: projectId, rootKind: "projects", relativePath: `projects/${projectId}` },
    { operationId: `register-${projectId}-${String(sequence)}`, actor: "project-manager" },
  );
}

async function storeRevision(context: StoreContext): Promise<number> {
  const handle = await openCollaborationStore(context, "read");
  try {
    const row = handle.db.prepare("select revision from collaboration_meta where id = 1").get() as { revision: number };
    return row.revision;
  } finally {
    handle.close();
  }
}

function laneFile(context: StoreContext): DatabaseSync {
  return new DatabaseSync(resolveCollaborationLocation(context).dbPath);
}

function laneFileOf(repoKey: string): DatabaseSync {
  return new DatabaseSync(collaborationLocationOfRepoKey(repoKey, "local").dbPath);
}

function triple(title: string): Pick<CaptureInput, "sourceIdentity" | "rootCauseKey" | "acceptanceKey"> {
  return { sourceIdentity: `review/${title}`, rootCauseKey: `root-${title}`, acceptanceKey: `accept-${title}` };
}

async function seededRecord(context: StoreContext, projectId: string, title: string): Promise<string> {
  const receipt = await captureIssue(
    context,
    {
      projectId,
      title,
      kind: "bug",
      severity: "high",
      impact: "impact",
      acceptance: "acceptance",
      ...triple(title),
      occurrenceKey: `occ-1-${title}`,
      sourceKind: "test",
      location: "src/a.ts",
      observedBehavior: "fails",
      evidence: ["repro"],
      discoveredAt: "2026-11-24T00:00:00.000Z",
    },
    { actor: "project-manager", operationId: `capture-${title}-1-${String(sequence)}` },
  );
  await appendOccurrence(
    context,
    receipt.issueId,
    {
      ...triple(title),
      occurrenceKey: `occ-2-${title}`,
      sourceKind: "test",
      location: "src/b.ts",
      observedBehavior: "fails again",
      evidence: [],
      discoveredAt: "2026-11-24T00:00:01.000Z",
    },
    { actor: "project-manager", operationId: `capture-${title}-2-${String(sequence)}` },
  );
  await withCollaborationWrite(context, ({ db }) => {
    db.prepare(
      "insert into issue_sync_state(binding_id, direction, local_id, item_state, revision, updated_at) " +
        "values (?, 'push', ?, 'applied', 1, '2026-11-24T00:00:00.000Z')",
    ).run(`linear:${projectId}`, receipt.issueId);
  });
  return receipt.issueId;
}

async function withTransitions(context: StoreContext, issueId: string, title: string): Promise<void> {
  const opening = await getIssue(context, issueId);
  const closed = await closeIssue(
    context,
    issueId,
    "resolved",
    { reason: "fixed", references: ["qa/evidence.md"], alignmentRef: "QA gate: Approve" },
    { actor: "project-manager", operationId: `close-${title}-${String(sequence)}`, expectedRevision: opening.revision },
  );
  await reopenIssue(
    context,
    issueId,
    { reason: "regressed" },
    { actor: "project-manager", operationId: `reopen-${title}-${String(sequence)}`, expectedRevision: closed.revision },
  );
}

function recordImage(context: StoreContext, issueId: string): unknown {
  const db = laneFile(context);
  try {
    const one = (sql: string): unknown[] => db.prepare(sql).all(issueId);
    return {
      issue: one("select * from issues where id = ?"),
      occurrences: one("select * from occurrences where issue_id = ? order by id"),
      transitions: one("select * from issue_transitions where issue_id = ? order by id"),
      provenance: one("select * from provenance where issue_id = ? order by id"),
      projectMoves: one("select * from issue_project_moves where issue_id = ? order by id"),
      relations: one("select * from relations where from_issue = ? order by relation"),
      sync: one("select * from issue_sync_state where local_id = ? order by binding_id"),
    };
  } finally {
    db.close();
  }
}

async function historyCounts(context: StoreContext, issueId: string): Promise<Record<string, number>> {
  const detail = await getIssue(context, issueId);
  return {
    occurrences: detail.occurrences.length,
    transitions: detail.transitions.length,
    provenance: detail.provenance.length,
    relations: detail.relations.length,
  };
}

async function issueRefOf(context: StoreContext, issueId: string): Promise<string> {
  const detail = await getIssue(context, issueId);
  const issueRef = detail.issueRef;
  if (typeof issueRef !== "string") throw new Error(`${issueId} carries no issueRef through the detail read`);
  return issueRef;
}

async function refusalOf(action: Promise<unknown>): Promise<{ code?: string; details?: Record<string, unknown>; message: string }> {
  try {
    await action;
  } catch (error) {
    const refusal = error as { code?: string; details?: Record<string, unknown>; message: string };
    return { code: refusal.code, details: refusal.details, message: refusal.message };
  }
  throw new Error("expected a refusal, and the verb succeeded");
}

function stagedRequest(operationId: string, issueId: string, destination: StoreContext, project = "p-dest"): MoveRequest {
  return {
    operationId,
    actor: "project-manager",
    sourceIssueId: issueId,
    destinationAuthority: authorityOf(destination),
    destinationProject: project,
    reason: "belongs to the other authority",
  };
}

function blockedOccurrence(title: string, key: string) {
  return {
    ...triple(title),
    occurrenceKey: key,
    sourceKind: "test",
    location: "src/blocked.ts",
    observedBehavior: "blocked",
    evidence: [],
    discoveredAt: "2026-11-24T00:00:09.000Z",
  };
}

describe("criterion 7 — cross-authority move", () => {
  test("Stage → verify → switch, preserving `IssueRef` and history", async () => {
    const source = await checkout("preserve-source");
    const destination = await checkout("preserve-destination", false);
    await registerProject(source, "p-source");
    await registerProject(destination, "p-dest");

    const moved = await seededRecord(source, "p-source", "moves-with-history");
    await withTransitions(source, moved, "moves-with-history");
    const staysBehind = await seededRecord(source, "p-source", "stays-behind");
    await linkIssue(
      source,
      moved,
      { relation: "blocks", issueId: staysBehind },
      { actor: "project-manager", operationId: `link-${String(sequence)}`, expectedRevision: (await getIssue(source, moved)).revision },
    );
    const sourceRef = await issueRefOf(source, moved);
    const countsBefore = await historyCounts(source, moved);
    expect(countsBefore).toEqual({ occurrences: 2, transitions: 2, provenance: 1, relations: 1 });

    const operationId = `move-preserve-${String(sequence)}`;
    const receipt = await moveIssue(
      source,
      moved,
      { projectId: "p-dest", reason: "belongs to the other authority", toAuthority: authorityOf(destination) },
      { actor: "project-manager", operationId, expectedStoreRevision: await storeRevision(source) },
    );
    expect(receipt).toMatchObject({ phase: "published", destinationProject: "p-dest" });
    const landed = receipt.destinationIssueId;
    if (typeof landed !== "string") throw new Error("a published move names the destination record it admitted");

    expect(await issueRefOf(destination, landed)).toBe(sourceRef);
    expect(await historyCounts(destination, landed)).toEqual(countsBefore);
    expect(await getIssue(destination, landed)).toMatchObject({ projectId: "p-dest", milestoneId: null, provider: "local" });
    const sourceLane = laneFile(source);
    try {
      expect(sourceLane.prepare("select count(*) as n from issues where id = ?").get(moved)).toEqual({ n: 0 });
      expect(sourceLane.prepare("select count(*) as n from occurrences where issue_id = ?").get(moved)).toEqual({ n: 0 });
      expect(sourceLane.prepare("select phase from issue_moves where operation_id = ? and role = 'source'").get(operationId)).toEqual({
        phase: "published",
      });
    } finally {
      sourceLane.close();
    }

    const arrived = (await getIssue(destination, landed)).relations;
    expect(arrived).toHaveLength(1);
    expect(arrived[0]).toMatchObject({ relation: "blocks", toIssue: null, title: null });
    expect(typeof arrived[0]?.toRef).toBe("string");

    const secondId = `move-preserve-related-${String(sequence)}`;
    const second = await moveIssue(
      source,
      staysBehind,
      { projectId: "p-dest", reason: "follows its relation", toAuthority: authorityOf(destination) },
      { actor: "project-manager", operationId: secondId, expectedStoreRevision: await storeRevision(source) },
    );
    const relatedLanded = second.destinationIssueId;
    if (typeof relatedLanded !== "string") throw new Error("the second move admitted no destination record");
    expect((await getIssue(destination, landed)).relations).toEqual([
      { fromIssue: landed, relation: "blocks", toIssue: relatedLanded, toRef: null, title: "stays-behind" },
    ]);
  }, 120_000);

  test("Interrupt after staging, before switch", async () => {
    const source = await checkout("staged-source");
    const destination = await checkout("staged-destination", false);
    await registerProject(source, "p-source");
    await registerProject(destination, "p-dest");
    const issueId = await seededRecord(source, "p-source", "stops-while-staged");
    const before = recordImage(source, issueId);
    const request = stagedRequest(`move-staged-${String(sequence)}`, issueId, destination);

    await moveAcrossAuthorities(source, request, "staged");

    const stillServed = await getIssue(source, issueId);
    expect(stillServed).toMatchObject({ id: issueId });
    expect(stillServed.occurrences).toHaveLength(2);
    const fenced = await refusalOf(
      appendOccurrence(source, issueId, blockedOccurrence("stops-while-staged", `occ-blocked-${String(sequence)}`), {
        actor: "project-manager",
        operationId: `occ-blocked-${String(sequence)}`,
      }),
    );
    expect(fenced.code).toBe("collaboration.operation-partial");
    expect(fenced.details).toMatchObject({ cause: "issue.move-in-progress" });
    expect(String(fenced.details?.recovery ?? fenced.message)).toContain(request.operationId);

    const discarded = await discardMove(source, request);
    expect(discarded.phase).toBe("discarded");
    expect(recordImage(source, issueId)).toEqual(before);
    const destinationLane = laneFileOf(request.destinationAuthority);
    try {
      expect(destinationLane.prepare("select count(*) as n from issue_moves").get()).toEqual({ n: 0 });
    } finally {
      destinationLane.close();
    }
    await appendOccurrence(source, issueId, blockedOccurrence("stops-while-staged", `occ-after-discard-${String(sequence)}`), {
      actor: "project-manager",
      operationId: `occ-after-discard-${String(sequence)}`,
    });
    expect((await getIssue(source, issueId)).occurrences).toHaveLength(3);

    const resumedId = `move-staged-resume-${String(sequence)}`;
    const resumed = await moveIssue(
      source,
      issueId,
      { projectId: "p-dest", reason: request.reason, toAuthority: request.destinationAuthority },
      { actor: "project-manager", operationId: resumedId, expectedStoreRevision: await storeRevision(source) },
    );
    expect(resumed).toMatchObject({ phase: "published" });
    const landed = resumed.destinationIssueId;
    if (typeof landed !== "string") throw new Error("the resumed move admitted no destination record");
    expect((await getIssue(destination, landed)).occurrences).toHaveLength(3);
  }, 120_000);

  test("Interrupt after switch, before publication", async () => {
    const source = await checkout("switched-source");
    const destination = await checkout("switched-destination", false);
    await registerProject(source, "p-source");
    await registerProject(destination, "p-dest");
    const issueId = await seededRecord(source, "p-source", "stops_after_switch");
    const request = stagedRequest(`move-switched-${String(sequence)}`, issueId, destination);
    await moveAcrossAuthorities(source, request, "switched");

    const admittedLane = laneFileOf(request.destinationAuthority);
    const admitted = admittedLane.prepare("select id, issue_ref from issues").all() as Array<{ id: string; issue_ref: string }>;
    admittedLane.close();
    expect(admitted).toHaveLength(1);
    const landed = admitted[0];
    if (landed === undefined) throw new Error("the switched move admitted no destination record");
    expect(await issueRefOf(destination, landed.id)).toBe(landed.issue_ref);

    const notPresented = await refusalOf(getIssue(source, issueId));
    expect(notPresented.code).toBe("collaboration.operation-partial");
    expect(String(notPresented.details?.recovery ?? notPresented.message)).toContain(request.operationId);
    const listed = await listIssues(source, { disposition: "open" });
    expect(listed.items.map((item) => item.id)).not.toContain(issueId);
    expect(listed.total).toBe(0);
    const rollup = await withStoreRead(source, queryOpenIssueRollup());
    expect(rollup.data.totalOpen).toBe(0);
    expect(rollup.data.recent.map((item) => item.id)).not.toContain(issueId);
    const fenced = await refusalOf(
      appendOccurrence(source, issueId, blockedOccurrence("stops_after_switch", `occ-after-switch-${String(sequence)}`), {
        actor: "project-manager",
        operationId: `occ-after-switch-${String(sequence)}`,
      }),
    );
    expect(fenced.code).toBe("collaboration.operation-partial");
    const rawSource = laneFile(source);
    try {
      expect(() => rawSource.prepare("update issues set title = 'edited' where id = ?").run(issueId)).toThrow(/issue\.move-in-progress/);
    } finally {
      rawSource.close();
    }

    expect((await moveAcrossAuthorities(source, request))).toMatchObject({ phase: "published" });
    expect((await moveAcrossAuthorities(source, request))).toMatchObject({ phase: "published", resumedFrom: "published" });
    const after = laneFileOf(request.destinationAuthority);
    try {
      expect(after.prepare("select count(*) as n from issues").get()).toEqual({ n: 1 });
      expect(after.prepare("select count(*) as n from issue_project_moves").get()).toEqual({ n: 1 });
    } finally {
      after.close();
    }
    const sourceLane = laneFile(source);
    try {
      expect(sourceLane.prepare("select count(*) as n from issue_moves where phase = 'published'").get()).toEqual({ n: 1 });
      expect(sourceLane.prepare("select count(*) as n from issues where id = ?").get(issueId)).toEqual({ n: 0 });
    } finally {
      sourceLane.close();
    }
  }, 120_000);

  test("Failed verification", async () => {
    const source = await checkout("verify-source");
    const destination = await checkout("verify-destination", false);
    await registerProject(source, "p-source");
    await registerProject(destination, "p-dest");
    const issueId = await seededRecord(source, "p-source", "fails_verification");
    const before = recordImage(source, issueId);
    const request = stagedRequest(`move-verify-${String(sequence)}`, issueId, destination);
    await moveAcrossAuthorities(source, request, "staged");

    const destinationLane = laneFileOf(request.destinationAuthority);
    try {
      destinationLane
        .prepare("update issue_moves set staged_counts = ? where role = 'destination'")
        .run(JSON.stringify({ occurrences: 2, issueTransitions: 2, provenance: 2, relations: 0, issueProjectMoves: 0, relationsLeftBehind: 0 }));
    } finally {
      destinationLane.close();
    }

    const refused = await refusalOf(moveAcrossAuthorities(source, request));
    expect(refused.code).toBe("collaboration.operation-partial");
    expect(refused.details).toMatchObject({ phase: "discarded" });
    expect(String(refused.details?.mismatch ?? "").length).toBeGreaterThan(0);
    expect(recordImage(source, issueId)).toEqual(before);
    const sourceLane = laneFile(source);
    try {
      expect(sourceLane.prepare("select phase from issue_moves where operation_id = ? and role = 'source'").get(request.operationId)).toEqual({
        phase: "discarded",
      });
      expect(
        sourceLane.prepare("select count(*) as n from issue_moves where role = 'source' and phase in ('staged','verified','switched')").get(),
      ).toEqual({ n: 0 });
    } finally {
      sourceLane.close();
    }
    const clearedLane = laneFileOf(request.destinationAuthority);
    try {
      expect(clearedLane.prepare("select count(*) as n from issue_moves").get()).toEqual({ n: 0 });
      expect(clearedLane.prepare("select count(*) as n from issues").get()).toEqual({ n: 0 });
    } finally {
      clearedLane.close();
    }
    await appendOccurrence(source, issueId, blockedOccurrence("fails_verification", `occ-after-refusal-${String(sequence)}`), {
      actor: "project-manager",
      operationId: `occ-after-refusal-${String(sequence)}`,
    });
  }, 120_000);

  test("Writes stopped and in-flight reconciled", async () => {
    const source = await checkout("inflight-source");
    const destination = await checkout("inflight-destination", false);
    await registerProject(source, "p-source");
    await registerProject(destination, "p-dest");

    const pendingIssue = await seededRecord(source, "p-source", "pending_mirror");
    const pendingKey = `move-pending-${String(sequence)}`;
    await withCollaborationWrite(source, ({ db }) => {
      db.prepare(
        "insert into issue_sync_state(binding_id, direction, local_id, item_state, revision, updated_at) " +
          "values (?, 'push', ?, 'pending', 1, '2026-11-24T00:00:00.000Z')",
      ).run(`linear:pending-${String(sequence)}`, pendingIssue);
    });
    const before = recordImage(source, pendingIssue);
    const blocked = await refusalOf(
      moveIssue(
        source,
        pendingIssue,
        { projectId: "p-dest", reason: "belongs to the other authority", toAuthority: authorityOf(destination) },
        { actor: "project-manager", operationId: pendingKey, expectedStoreRevision: await storeRevision(source) },
      ),
    );
    expect(blocked.code).toBe("collaboration.cutover-not-quiescent");
    expect(String(blocked.details?.recovery ?? blocked.message)).toContain("issue-sync pending");
    expect(recordImage(source, pendingIssue)).toEqual(before);
    for (const lane of [laneFile(source), laneFileOf(authorityOf(destination))]) {
      try {
        expect(lane.prepare("select count(*) as n from issue_moves where operation_id = ?").get(pendingKey)).toEqual({ n: 0 });
      } finally {
        lane.close();
      }
    }

    await withCollaborationWrite(source, ({ db }) => {
      db.prepare("update issue_sync_state set item_state = 'applied' where local_id = ? and item_state = 'pending'").run(pendingIssue);
    });
    const request = stagedRequest(`move-inflight-${String(sequence)}`, pendingIssue, destination);
    await moveAcrossAuthorities(source, request, "switched");
    const fenced = await refusalOf(
      appendOccurrence(source, pendingIssue, blockedOccurrence("pending_mirror", `occ-after-switch-${String(sequence)}`), {
        actor: "project-manager",
        operationId: `occ-after-switch-${String(sequence)}`,
      }),
    );
    expect(fenced.code).toBe("collaboration.operation-partial");
    expect(fenced.details).toMatchObject({ cause: "issue.move-in-progress" });

    await moveAcrossAuthorities(source, request);
    const settled = laneFile(source);
    try {
      expect(settled.prepare("select removed_sync_rows from issue_moves where operation_id = ? and role = 'source'").get(request.operationId)).toEqual({
        removed_sync_rows: 2,
      });
      expect(settled.prepare("select count(*) as n from issue_sync_state where local_id = ?").get(pendingIssue)).toEqual({ n: 0 });
    } finally {
      settled.close();
    }
  }, 120_000);

  test("Unresolved relation visible", async () => {
    const source = await checkout("unresolved-source");
    const destination = await checkout("unresolved-destination", false);
    await registerProject(source, "p-source");
    await registerProject(destination, "p-dest");
    const holder = await seededRecord(source, "p-source", "edge_holder");
    const leaving = await seededRecord(source, "p-source", "edge_leaves");
    await linkIssue(
      source,
      holder,
      { relation: "blocks", issueId: leaving },
      { actor: "project-manager", operationId: `link-unresolved-${String(sequence)}`, expectedRevision: (await getIssue(source, holder)).revision },
    );
    const leavingRef = await issueRefOf(source, leaving);
    expect((await getIssue(source, holder)).relations).toEqual([
      { fromIssue: holder, relation: "blocks", toIssue: leaving, toRef: null, title: "edge_leaves" },
    ]);

    const operationId = `move-unresolved-${String(sequence)}`;
    await moveIssue(
      source,
      leaving,
      { projectId: "p-dest", reason: "belongs to the other authority", toAuthority: authorityOf(destination) },
      { actor: "project-manager", operationId, expectedStoreRevision: await storeRevision(source) },
    );

    const unresolved = { fromIssue: holder, relation: "blocks", toIssue: null, toRef: leavingRef, title: null };
    expect((await getIssue(source, holder)).relations).toEqual([unresolved]);
    const envelope = await withStoreRead(source, queryDashboard("issue-detail", { id: holder }));
    expect((envelope.data as IssueDetail).relations).toEqual([unresolved]);
    expect(envelope.collaboration?.completeness).toBe("complete");
    expect((await getIssue(source, holder)).id).toBe(holder);
  }, 120_000);
});
