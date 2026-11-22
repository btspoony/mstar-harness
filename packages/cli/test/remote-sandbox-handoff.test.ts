/**
 * Two-sandbox handoff acceptance and the durability limitation.
 *
 * Sandbox A confirms one remote change and pushes one tracked result, then is removed
 * (its workspace, `HOME`, cache and execution store are deleted). Sandbox B is a fresh
 * clone with its own `HOME` and a fresh execution store; it rebuilds the collaboration
 * picture from exactly two durable sources — the provider's confirmed records and pushed
 * Git — never from a cache copy or an end-of-session flush.
 *
 * The handoff verdict asserted here is the HOST report `remote.handoff-unavailable`, not
 * a CLI exit: `missing` names the components the handoff lacks, `recovered` the ones it
 * independently confirmed, and `recoverable` says whether a surviving copy exists (`null`
 * when survival is neither proven nor disproven).
 *
 * B consumes only what a provider traversal and the bare origin carry: the fixture renders
 * the provider's own confirmed records into its snapshots, so nothing A held is passed in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { RemoteSnapshot } from "@mstar-harness/engine";
import {
  FIXTURE_ISSUE_ID,
  REMOTE_PROJECT,
  TRACKED_BRANCH,
  RemoteCollaborationFixture,
  type OutboxIntent,
  type OutboxPermit,
  type ProviderIssueRecord,
  type RemoteSandbox,
  type SandboxCommand,
} from "./support/remote-collaboration-fixture";

const REMOTE = ["store", "collaboration", "remote"] as const;
const OPERATION = "44444444-4444-4444-8444-444444444444";
const HANDOFF_FILE = "handoff-result.md";
const OBSERVED_NATIVE_TITLE = "Observed native issue";

/** note: The handoff's two durable sources; `unknown` is a check that could not decide. */
type SourceState = "present" | "absent" | "unknown";
/** note: Git's extra state — the result survives on a ref B's clone path never reads. */
type GitState = SourceState | "surviving";
type HandoffComponent = "provider" | "git";
type HandoffSources = Readonly<{ provider: SourceState; git: GitState }>;
type HandoffReport = Readonly<{
  code: "remote.handoff-unavailable";
  missing: readonly HandoffComponent[];
  recovered: readonly HandoffComponent[];
  recoverable: boolean | null;
}>;

/** note: What survived A's removal, plus the facts the handoff assertions compare against. */
type HandoffSource = Readonly<{
  fixture: RemoteCollaborationFixture;
  /** note: The provider's own confirmed record — the first durable source, never A's copy. */
  record: ProviderIssueRecord;
  /** note: The bare origin's local transport path, discovered through A's clone. */
  bare: string;
  commit: string;
  aStoreId: string;
  aCache: string;
}>;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function rowCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`select count(*) as n from ${table}`).get();
  return row !== null && typeof row === "object" && "n" in row && typeof row.n === "number" ? row.n : -1;
}

/** note: A's own execution lane fact, so B's absence of it is non-vacuous. */
function seedWorkflow(storePath: string): void {
  const db = new DatabaseSync(storePath);
  const at = "2026-11-21T00:00:00.000Z";
  try {
    db.prepare(
      "insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at) " +
        "values ('wf-sandbox-a', 1, 'session-a', ?, ?, ?)",
    ).run(JSON.stringify({ schema_version: 2, id: "wf-sandbox-a", type: "plan", status: "running" }), at, at);
  } finally {
    db.close();
  }
}

/**
 * The Git component: B's handoff succeeds only when the tracked branch it clones still
 * carries A's pushed commit. A copy any other ref reaches keeps the result recoverable but
 * is not a successful handoff, an unreferenced copy may be pruned and so proves no survival,
 * and an object that is gone is a proven loss. A probe that cannot read the origin decides
 * nothing — a deleted branch and an unreachable server look the same from here.
 */
function gitSource(bare: string, commit: string): GitState {
  try {
    git(process.cwd(), ["-C", bare, "rev-parse", "--git-dir"]);
  } catch {
    return "unknown";
  }
  try {
    git(process.cwd(), ["-C", bare, "cat-file", "-e", commit]);
  } catch (error) {
    const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : null;
    // note: `cat-file -e` answers 1 for an absent object; any other failure is not proof.
    return status === 1 ? "absent" : "unknown";
  }
  const refs = git(process.cwd(), ["-C", bare, "for-each-ref", "--contains", commit, "--format=%(refname)"])
    .split("\n")
    .filter((ref) => ref !== "");
  if (refs.includes(`refs/heads/${TRACKED_BRANCH}`)) return "present";
  return refs.length > 0 ? "surviving" : "unknown";
}

/**
 * The provider component: the complete traversal must still carry the confirmed record —
 * the issue's MStar marker at the exact reference and head. A visible native issue without
 * the marker is not the record, and a traversal that is not complete decides nothing.
 */
function providerSource(fixture: RemoteCollaborationFixture, expected: ProviderIssueRecord): SourceState {
  // note: The fixture builds this document; its snapshot crosses the DTO as opaque JSON.
  const snapshot = fixture.observe(REMOTE_PROJECT, 0).snapshot as RemoteSnapshot | null;
  if (snapshot?.coverage.kind !== "complete") return "unknown";
  const carried = snapshot.issues.some(
    (issue) =>
      issue.mstar !== null &&
      issue.mstar.issueRef === expected.issueRef &&
      issue.mstar.head.includes(expected.head[0] ?? ""),
  );
  return carried ? "present" : "absent";
}

/**
 * The host handoff report. `missing` is every component the handoff lacks, `recovered`
 * the ones it independently confirmed, and `recoverable` says whether a missing component
 * still has a surviving copy: `true` when Git keeps A's result on a ref outside the tracked
 * branch, `false` once every copy is proven gone, and `null` while any survival is undecided.
 */
function handoffReport(sources: HandoffSources): HandoffReport | null {
  const components: readonly HandoffComponent[] = ["provider", "git"];
  const recovered = components.filter((name) => sources[name] === "present");
  if (recovered.length === components.length) return null;
  const undecided = sources.provider === "unknown" || sources.git === "unknown";
  return {
    code: "remote.handoff-unavailable",
    missing: components.filter((name) => sources[name] !== "present"),
    recovered,
    recoverable: undecided ? null : sources.git === "surviving",
  };
}

/** note: The strict adoption document the host submits for A's one remote change. */
function adoptionDocument(operation: string): unknown {
  const at = new Date().toISOString();
  return {
    version: 1,
    kind: "new",
    capture: {
      kind: "bug",
      severity: "high",
      impact: "A confirmed remote change must survive one sandbox's removal.",
      acceptance: "A fresh sandbox reconstructs the exactly reconciled change.",
      sourceIdentity: `review:${operation}`,
      rootCauseKey: "remote.handoff.change",
      acceptanceKey: "remote.handoff.change.reconstructed",
      occurrenceKey: `occurrence-${operation}`,
      sourceKind: "review",
      location: "remote-sandbox-handoff.test.ts",
      observedBehavior: "Sandbox A confirmed one remote issue change.",
      evidence: ["controlled host fixture"],
      discoveredAt: at,
    },
  };
}

/**
 * A's whole side of the handoff: bind, initialize, observe, freeze one adoption, dispatch
 * it, lose the response, settle it by unique exact evidence, push one tracked result and
 * prove both durable copies before it is deleted.
 */
function handoffFromA(fixture: RemoteCollaborationFixture): HandoffSource {
  fixture.publish(1);
  const a = fixture.sandbox("a");
  expect(a.status().data.binding).toMatchObject({ state: "unbound" });
  expect(a.bind(fixture.verify()).exitCode).toBe(0);
  const initialized = a.init();
  expect(initialized.exitCode).toBe(0);
  const aStoreId = String(initialized.data.storeId);
  seedWorkflow(join(a.harness, "store.db"));
  expect(a.observe(fixture.observe(REMOTE_PROJECT, 0)).data).toMatchObject({ revision: 1, completeness: "complete" });

  const adopted = a.runJson([
    ...REMOTE, "adopt-issue", "--harness", a.harness,
    "--project", REMOTE_PROJECT.localProjectId,
    "--issue", FIXTURE_ISSUE_ID,
    "--operation", OPERATION,
    "--input", a.writeJson("adopt", adoptionDocument(OPERATION)),
  ]);
  expect(adopted.data.state).toBe("enqueued");

  // note: The effect lands and the response is lost; nothing but unique exact evidence may
  // settle it, and a replayed dispatch never issues a second send permit.
  const dispatched = a.runJson([...REMOTE, "outbox-dispatch", "--harness", a.harness, "--operation", OPERATION]);
  const permit = dispatched.data.permit as unknown as OutboxPermit;
  const lost = a.runJson([
    ...REMOTE, "outbox-receipt", "--harness", a.harness,
    "--input", a.writeJson("receipt", {
      ...fixture.send(permit),
      observedAt: new Date().toISOString(),
      outcome: { kind: "unconfirmed", reason: "no-response" },
    }),
  ]);
  expect(lost.data).toMatchObject({ state: "unconfirmed", confirmed: null });
  const replay = a.runJson([...REMOTE, "outbox-dispatch", "--harness", a.harness, "--operation", OPERATION]);
  expect(replay.data).toMatchObject({ kind: "state", state: "unconfirmed" });
  expect(replay.data.permit).toBeUndefined();

  const intent = a.runJson([...REMOTE, "outbox-show", "--harness", a.harness, "--operation", OPERATION]);
  const unique = fixture.lookup(intent.data as unknown as OutboxIntent);
  expect(unique.outcome).toMatchObject({ kind: "confirmed" });
  const reconciled = a.runJson([
    ...REMOTE, "outbox-reconcile", "--harness", a.harness,
    "--input", a.writeJson("reconcile", unique),
  ]);
  expect(reconciled.data.state).toBe("confirmed");
  // note: The provider's own record is the handoff's first durable source; the test holds it
  // as the expected subject, never A's frozen event or outbox receipt.
  const record = fixture.confirmedIssue(OPERATION);
  if (record === null) throw new Error("fixture: the provider does not hold the confirmed adoption");

  writeFileSync(join(a.repo, HANDOFF_FILE), "# Handoff result\n\nOne confirmed remote change and one tracked result.\n");
  git(a.repo, ["add", HANDOFF_FILE]);
  git(a.repo, ["commit", "-q", "-m", "record the confirmed handoff"]);
  const commit = git(a.repo, ["rev-parse", "HEAD"]);
  git(a.repo, ["push", "-q", "origin", `HEAD:refs/heads/${TRACKED_BRANCH}`]);
  // note: `get-url` expands the fixture's insteadOf mapping to the bare transport path.
  const bare = git(a.repo, ["remote", "get-url", "origin"]);
  const aCache = fixture.cachePath(a);
  const aStore = new DatabaseSync(join(a.harness, "store.db"));
  try {
    expect(rowCount(aStore, "execution_workflows")).toBe(1);
  } finally {
    aStore.close();
  }

  // invariant: Both durable copies are observable BEFORE removal, so B never depends on an
  // end-of-session flush; then A, its cache and its execution store are gone.
  expect(providerSource(fixture, record)).toBe("present");
  expect(gitSource(bare, commit)).toBe("present");
  rmSync(a.dir, { recursive: true, force: true });
  expect(existsSync(a.dir)).toBe(false);
  expect(existsSync(aCache)).toBe(false);

  return { fixture, record, bare, commit, aStoreId, aCache };
}

/** note: B's independent bootstrap: fresh clone, fresh execution lane, then the confirmed read. */
function reconstruct(source: HandoffSource): Readonly<{ b: RemoteSandbox; shown: SandboxCommand }> {
  const b = source.fixture.sandbox("b");
  expect(git(b.repo, ["rev-parse", "HEAD"])).toBe(source.commit);
  expect(existsSync(join(b.repo, HANDOFF_FILE))).toBe(true);
  expect(b.environment.HOME).toBe(b.home);
  expect(Object.keys(b.environment).sort()).toEqual(["HOME", "PATH", "TMPDIR", "TZ"]);

  expect(b.bind(source.fixture.verify()).exitCode).toBe(0);
  const initialized = b.init();
  expect(initialized.exitCode).toBe(0);
  expect(String(initialized.data.storeId)).not.toBe(source.aStoreId);
  const store = new DatabaseSync(join(b.harness, "store.db"));
  try {
    expect(rowCount(store, "execution_workflows")).toBe(0);
  } finally {
    store.close();
  }
  // invariant: B submits exactly the provider's traversal — the fixture's own snapshot of the
  // records the provider still holds — and the pushed clone; A contributed no document.
  expect(b.observe(source.fixture.observe(REMOTE_PROJECT, 0)).data).toMatchObject({
    projectId: REMOTE_PROJECT.localProjectId,
    revision: 1,
    completeness: "complete",
  });
  expect(source.fixture.cachePath(b)).not.toBe(source.aCache);

  // note: B addresses the issue by the reference its own read produced.
  const listed = b.runJson(["issue", "list", "--harness", b.harness]);
  const items = listed.data.items as Array<Record<string, unknown>>;
  const issueRef = items[0]?.issueRef;
  if (typeof issueRef !== "string") throw new Error(`fixture: B listed no marked issue: ${listed.result.stderr}`);
  return { b, shown: b.runJson(["issue", "show", "--id", issueRef, "--harness", b.harness]) };
}

describe("remote handoff", () => {
  const hosts: RemoteCollaborationFixture[] = [];

  function host(name: string): RemoteCollaborationFixture {
    const created = new RemoteCollaborationFixture(`remote-handoff-${name}`);
    hosts.push(created);
    return created;
  }

  afterEach(() => {
    for (const created of hosts.splice(0)) created.dispose();
  });

  test("remote handoff: B reconstructs the confirmed change and pushed Git after A is removed", () => {
    const fixture = host("two-sandbox");
    const source = handoffFromA(fixture);
    const { b, shown } = reconstruct(source);

    const fields = source.record.subject.fields as Record<string, unknown>;
    expect(shown.exitCode).toBe(0);
    // invariant: The exact subject the provider's own record carries, under the same IssueRef.
    expect(shown.data).toMatchObject({
      id: source.record.issueRef,
      issueRef: source.record.issueRef,
      projectId: REMOTE_PROJECT.localProjectId,
      title: OBSERVED_NATIVE_TITLE,
      kind: fields.kind,
      severity: fields.severity,
      disposition: "open",
      impact: fields.impact,
      acceptance: fields.acceptance,
      revision: 1,
      registeredAt: fields.registeredAt,
      nativeTitle: OBSERVED_NATIVE_TITLE,
      nativeStatus: "Todo",
    });
    const occurrences = shown.data.occurrences as Array<Record<string, unknown>>;
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({
      occurrenceKey: `occurrence-${OPERATION}`,
      sourceIdentity: `review:${OPERATION}`,
      observedBehavior: "Sandbox A confirmed one remote issue change.",
    });

    const listed = b.runJson(["issue", "list", "--harness", b.harness]);
    expect(listed.data).toMatchObject({ total: 1 });
    expect(listed.data.providerIssues).toBeUndefined();
    expect((listed.data.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      issueRef: source.record.issueRef,
      title: OBSERVED_NATIVE_TITLE,
    });

    // invariant: Nothing was flushed at the end of A's session - both copies are probed
    // AFTER A's removal, and the handoff is complete rather than unavailable.
    expect(
      handoffReport({ provider: providerSource(fixture, source.record), git: gitSource(source.bare, source.commit) }),
    ).toBeNull();

    // invariant: A later descendant push still reaches A's result from the tracked branch, so
    // survival follows that history rather than the branch tip.
    writeFileSync(join(b.repo, "later-work.md"), "later\n");
    git(b.repo, ["add", "later-work.md"]);
    git(b.repo, ["commit", "-q", "-m", "later work on the tracked branch"]);
    git(b.repo, ["push", "-q", "origin", `HEAD:refs/heads/${TRACKED_BRANCH}`]);
    expect(gitSource(source.bare, source.commit)).toBe("present");
  }, 90_000);

  test("remote handoff: a lost provider copy is named while the pushed Git result survives", () => {
    const fixture = host("provider-loss");
    const source = handoffFromA(fixture);
    // note: The provider loses the record itself; the native issue stays readable and
    // unmarked, and the fixture is the only provider copy, so nothing can restore it.
    fixture.discardEffects(OPERATION);
    const traversal = fixture.observe(REMOTE_PROJECT, 0).snapshot as RemoteSnapshot;
    expect(traversal.issues.map((issue) => issue.identity.issueId)).toContain(FIXTURE_ISSUE_ID);
    expect(traversal.issues.every((issue) => issue.mstar === null)).toBe(true);
    expect(providerSource(fixture, source.record)).toBe("absent");
    expect(
      handoffReport({ provider: providerSource(fixture, source.record), git: gitSource(source.bare, source.commit) }),
    ).toEqual({ code: "remote.handoff-unavailable", missing: ["provider"], recovered: ["git"], recoverable: false });

    const b = fixture.sandbox("b");
    expect(git(b.repo, ["rev-parse", "HEAD"])).toBe(source.commit);
    expect(existsSync(join(b.repo, HANDOFF_FILE))).toBe(true);
    expect(b.bind(fixture.verify()).exitCode).toBe(0);
    expect(b.init().exitCode).toBe(0);
    expect(b.observe(fixture.observe(REMOTE_PROJECT, 0)).data).toMatchObject({ revision: 1, completeness: "complete" });

    // invariant: The missing change is reported, never guessed into a create or a success.
    // The native issue stays visible as provider-only content, never as an MStar record.
    const shown = b.runJson(["issue", "show", "--id", source.record.issueRef, "--harness", b.harness]);
    expect(shown.exitCode).toBe(1);
    expect(shown.code).toBe("issue.not-found");
    const listed = b.runJson(["issue", "list", "--harness", b.harness]);
    expect(listed.data).toMatchObject({ total: 0 });
    expect(listed.data.providerIssues).toEqual([
      expect.objectContaining({ kind: "provider-only", issueRef: null, title: OBSERVED_NATIVE_TITLE }),
    ]);
  }, 90_000);

  test("remote handoff: a lost Git copy is named while the provider record survives", () => {
    const fixture = host("git-loss");
    const source = handoffFromA(fixture);
    // note: The tracked branch is deleted and its unreachable objects are pruned, so the
    // origin holds no surviving copy; the provider record is untouched.
    git(source.bare, ["update-ref", "-d", `refs/heads/${TRACKED_BRANCH}`]);
    git(source.bare, ["prune", "--expire=now"]);
    expect(providerSource(fixture, source.record)).toBe("present");
    expect(gitSource(source.bare, source.commit)).toBe("absent");
    expect(
      handoffReport({ provider: providerSource(fixture, source.record), git: gitSource(source.bare, source.commit) }),
    ).toEqual({ code: "remote.handoff-unavailable", missing: ["git"], recovered: ["provider"], recoverable: false });
    // invariant: No clone can stand in for the lost tracked result.
    expect(() => fixture.sandbox("b")).toThrow();
  }, 90_000);

  test("remote handoff: a deleted branch whose objects survive keeps Git survival unknown", () => {
    const fixture = host("git-dangling");
    const source = handoffFromA(fixture);
    // note: Deleting the branch leaves the commit's objects in the origin with no ref holding
    // them, so the loss is unproven: a `false` verdict here would be a false claim.
    git(source.bare, ["update-ref", "-d", `refs/heads/${TRACKED_BRANCH}`]);
    expect(gitSource(source.bare, source.commit)).toBe("unknown");
    expect(providerSource(fixture, source.record)).toBe("present");
    expect(
      handoffReport({ provider: providerSource(fixture, source.record), git: gitSource(source.bare, source.commit) }),
    ).toEqual({ code: "remote.handoff-unavailable", missing: ["git"], recovered: ["provider"], recoverable: null });
  }, 90_000);

  test("remote handoff: a result kept only on another ref is not a tracked-branch handoff", () => {
    const fixture = host("git-unrelated-ref");
    const source = handoffFromA(fixture);
    // note: Another branch keeps the commit alive after the tracked branch is gone, so the
    // result is recoverable by an operator - but B clones the tracked branch and cannot obtain
    // it. The old any-ref probe called this a successful handoff.
    git(source.bare, ["update-ref", "refs/heads/kept-result", source.commit]);
    git(source.bare, ["update-ref", "-d", `refs/heads/${TRACKED_BRANCH}`]);
    expect(providerSource(fixture, source.record)).toBe("present");
    expect(gitSource(source.bare, source.commit)).toBe("surviving");
    expect(
      handoffReport({ provider: providerSource(fixture, source.record), git: gitSource(source.bare, source.commit) }),
    ).toEqual({ code: "remote.handoff-unavailable", missing: ["git"], recovered: ["provider"], recoverable: true });
    // invariant: the tracked branch is the only bootstrap path; a surviving side branch is not it.
    expect(() => fixture.sandbox("b")).toThrow();
  }, 90_000);

  test("remote handoff: losing both durable copies is irrecoverable", () => {
    const fixture = host("both-loss");
    const source = handoffFromA(fixture);
    fixture.discardEffects(OPERATION);
    git(source.bare, ["update-ref", "-d", `refs/heads/${TRACKED_BRANCH}`]);
    git(source.bare, ["prune", "--expire=now"]);
    const report = handoffReport({
      provider: providerSource(fixture, source.record),
      git: gitSource(source.bare, source.commit),
    });
    expect(report).toEqual({
      code: "remote.handoff-unavailable",
      missing: ["provider", "git"],
      recovered: [],
      recoverable: false,
    });
    expect(() => fixture.sandbox("b")).toThrow();
  }, 90_000);

  test("remote handoff: an unreachable Git source reports unknown survival, never a proven loss", () => {
    const fixture = host("git-unknown");
    const source = handoffFromA(fixture);
    // note: The transport disappears, so the host cannot tell a deleted branch from an
    // unreachable server; a guessed boolean would be a false claim either way.
    rmSync(source.bare, { recursive: true, force: true });
    expect(providerSource(fixture, source.record)).toBe("present");
    expect(gitSource(source.bare, source.commit)).toBe("unknown");
    expect(
      handoffReport({ provider: providerSource(fixture, source.record), git: gitSource(source.bare, source.commit) }),
    ).toEqual({ code: "remote.handoff-unavailable", missing: ["git"], recovered: ["provider"], recoverable: null });
  }, 90_000);
});
