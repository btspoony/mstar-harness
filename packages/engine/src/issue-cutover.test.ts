import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeOs from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withProtectedWrite } from "./coordination-write.js";
import { captureIssue, getIssue, listIssues, linkIssue, linkIssueScoped, type CaptureInput } from "./issue.js";
import { assertPlanFindingsCurrent, findingsCleanupGate, observePlanFindings } from "./project.js";
import { createFsStore, resolveArtifactPath, type ArtifactStore } from "./store.js";
import { type StoreContext } from "./store-db.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import {
  initializeCollaborationStore,
  readCollaborationAuthority,
  withCollaborationWrite,
  writeCollaborationBinding,
} from "./collaboration-store.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-issue-cutover-")));
const HOME = join(ROOT, "home");
mkdirSync(HOME);

let homeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

function ctx(name: string): StoreContext {
  const root = realpathSync(mkdtempSync(join(ROOT, `${name}-`)));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "fixture"],
    { cwd: root, stdio: "ignore" },
  );
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${basename(root)}.git`], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["config", `url.${root}.insteadOf`, `https://github.com/acme/${basename(root)}.git`], {
    cwd: root,
    stdio: "ignore",
  });
  writeFileSync(join(root, ".mstarc"), "[collaboration]\nmode=local\n");
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  return { harnessDir, checkoutRoot: root };
}

function laneLocation(context: StoreContext) {
  const location = resolveCollaborationLocation(context);
  if (!location.dbPath.startsWith(`${ROOT}${sep}`)) {
    throw new Error(`fixture: resolved collaboration store ${location.dbPath} is outside the temporary root ${ROOT}`);
  }
  return location;
}

function activate(context: StoreContext): void {
  const location = laneLocation(context);
  const db = new DatabaseSync(location.dbPath);
  let authority: { storeId: string; epoch: number } | null = null;
  try {
    db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(
      new Date().toISOString(),
    );
    const row = db.prepare("select store_id, authority_epoch from collaboration_meta where id = 1").get() as
      | { store_id?: unknown; authority_epoch?: unknown }
      | undefined;
    if (typeof row?.store_id === "string" && typeof row.authority_epoch === "number") {
      authority = { storeId: row.store_id, epoch: row.authority_epoch };
    }
  } finally {
    db.close();
  }
  if (authority === null) throw new Error("fixture: the staged collaboration lane records no store identity");
  writeCollaborationBinding(context, {
    repoKey: location.repoKey,
    mode: location.mode,
    storeId: authority.storeId,
    epoch: authority.epoch,
    binding: "active",
  });
}

async function activeLane(context: StoreContext): Promise<void> {
  await initializeCollaborationStore(laneLocation(context));
  activate(context);
}

/**
 * A capture payload for one finding. Identity is `source + root cause +
 * acceptance outcome` (contract §3), so each fixture finding derives all three
 * from its own occurrence key — distinct findings, not recurrences of one.
 */
function finding(occurrenceKey: string, overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    projectId: "proj-a",
    title: `Finding ${occurrenceKey}`,
    kind: "review-obligation",
    severity: "medium",
    impact: "blocks plan approval",
    acceptance: "fixed or explicitly dispositioned",
    sourceIdentity: `qc/report/${occurrenceKey}.md`,
    rootCauseKey: `root-cause/${occurrenceKey}`,
    acceptanceKey: `fix-verified/${occurrenceKey}`,
    occurrenceKey,
    sourceKind: "qc-report",
    location: "packages/engine",
    observedBehavior: "observed",
    evidence: ["review/qc1.md"],
    discoveredAt: "2026-09-18T00:00:00Z",
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ *
 * § Retired register persist — no raw write recreates the legacy authority
 * ------------------------------------------------------------------------ */

/** A harness holding a legacy register on disk, as a pre-cutover workspace does. */
function workspaceWithRegister(name: string): { store: ArtifactStore & { root: string }; registerPath: string } {
  const harness = mkdtempSync(join(ROOT, `${name}-`));
  const registerPath = join(harness, "projects", "proj-a", "residuals.json");
  mkdirSync(dirname(registerPath), { recursive: true });
  writeFileSync(registerPath, '{ "entries": {} }\n', "utf8");
  return { store: createFsStore(harness), registerPath };
}

describe("retired register persist \u2014 the raw store cannot recreate a project register", () => {
  test("issue authority: the retired residuals kind refuses every raw port and leaves existing bytes alone", async () => {
    const { store } = workspaceWithRegister("retired-kind");
    // The payload that used to land as `projects/<id>/residuals.json` now has
    // no write path at all: create, delete and list refuse by kind.
    await expect(store.put({ kind: "residuals", key: "proj-a", payload: { entries: {} } } as never)).rejects.toThrow(
      /no longer persists project registers/,
    );
    await expect(store.delete!({ kind: "residuals", key: "proj-a" } as never)).rejects.toThrow(
      /no longer persists project registers/,
    );
    expect(() => store.list!("residuals" as never)).toThrow(/no longer persists project registers/);
    expect(() => resolveArtifactPath(store.root, { kind: "residuals", key: "proj-a" } as never)).toThrow(
      /no longer persists project registers/,
    );
  });

  test("issue authority: a json alias to a project register refuses directly, through a symlink, and inside the protected writer", async () => {
    const { store, registerPath } = workspaceWithRegister("retired-alias");
    // A `json` ref carries an absolute path, so it is the one raw write that
    // could reach a register without naming the kind — the guard classifies it
    // by its CANONICAL target instead.
    await expect(
      store.put({ kind: "json", key: registerPath, payload: { entries: { "plan-a": [] } } }),
    ).rejects.toThrow(/json alias/);

    const linkPath = join(dirname(registerPath), "register-link.json");
    symlinkSync(registerPath, linkPath);
    await expect(store.put({ kind: "json", key: linkPath, payload: { entries: { "plan-a": [] } } })).rejects.toThrow(
      /json alias/,
    );

    // The protected-write context authorizes coordination documents; it never
    // authorizes the retired register, so no authorization context bypasses
    // the guard.
    await expect(
      withProtectedWrite(registerPath, "put", async () =>
        store.put({ kind: "json", key: registerPath, payload: { entries: { "plan-a": [] } } }),
      ),
    ).rejects.toThrow(/json alias/);
    await expect(store.delete!({ kind: "json", key: registerPath })).rejects.toThrow(/json alias/);
  });

  test("issue authority: a json alias to a project register refuses on the read port too", async () => {
    const { store, registerPath } = workspaceWithRegister("retired-read");
    // A read is the same authority channel as a write: `get` runs the same
    // canonical-target guard, so legacy register bytes never reach a consumer
    // that bypasses the findings gate.
    await expect(store.get({ kind: "json", key: registerPath })).rejects.toThrow(/json alias/);

    const linkPath = join(dirname(registerPath), "register-link.json");
    symlinkSync(registerPath, linkPath);
    await expect(store.get({ kind: "json", key: linkPath })).rejects.toThrow(/json alias/);

    await expect(store.get({ kind: "residuals", key: "proj-a" } as never)).rejects.toThrow(
      /no longer persists project registers/,
    );
  });

  test("issue authority: the same file name outside the resolved project dir stays an ordinary json target", async () => {
    const { store } = workspaceWithRegister("retired-alias-control");
    const loosePath = join(store.root, "loose", "residuals.json");
    // The guard keys on the resolved PROJECT dir, not on the file name: an
    // unrelated document with the same name stays readable and writable, so the
    // refusal is a boundary, not a blanket basename ban.
    await store.put({ kind: "json", key: loosePath, payload: { note: "ordinary" } });
    expect(existsSync(loosePath)).toBe(true);
    // Assign first, then assert: a nested `expect(await store.get(...))` lets
    // TS infer the get<T> parameter from the expect overload (never) and
    // narrows the actual to undefined (same discipline as `store.test.ts`).
    const got = await store.get({ kind: "json", key: loosePath });
    expect(got).toEqual({ note: "ordinary" });
  });
});

async function linkPlanRow(context: StoreContext, issueId: string, planId: string): Promise<void> {
  await withCollaborationWrite(context, (handle) => {
    handle.db
      .prepare("insert into provenance(issue_id, kind, target, source_hash) values (?, 'plan', ?, ?)")
      .run(issueId, planId, `fixture:${planId}`);
  });
}

async function setDisposition(context: StoreContext, issueId: string, disposition: string): Promise<void> {
  await withCollaborationWrite(context, (handle) => {
    handle.db.prepare("update issues set disposition = ? where id = ?").run(disposition, issueId);
    handle.db.prepare("update collaboration_meta set revision = revision + 1 where id = 1").run();
  });
}

async function insertForeignIssue(context: StoreContext, issueId: string, planId: string): Promise<void> {
  await withCollaborationWrite(context, (handle) => {
    handle.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, provider, external_id, identity_key, issue_ref) " +
          "values (?, 'proj-a', 'mirrored row', 'bug', 'critical', 'open', 'imported', 'unchanged', ?, ?, 'linear', ?, ?, ?)",
      )
      .run(issueId, "2026-11-21T00:00:00.000Z", "2026-11-21T00:00:00.000Z", `EXT-${issueId}`, `mirror:${issueId}`, `mstar:issue:${crypto.randomUUID()}`);
    handle.db
      .prepare("insert into provenance(issue_id, kind, target, source_hash) values (?, 'plan', ?, ?)")
      .run(issueId, planId, `fixture:${planId}`);
  });
}

describe("findingsCleanupGate \u2014 authoritative linked open issues (G2a)", () => {
  test("issue authority: only the plan's own open issues count, and an open critical blocks both modes", async () => {
    const context = ctx("gate-modes");
    await activeLane(context);
    const medium = await captureIssue(context, finding("occ-medium"), {
      operationId: "cap-medium",
      actor: "project-manager",
    });
    const critical = await captureIssue(context, finding("occ-critical", { severity: "critical" }), {
      operationId: "cap-critical",
      actor: "project-manager",
    });
    const unlinked = await captureIssue(context, finding("occ-unlinked"), {
      operationId: "cap-unlinked",
      actor: "project-manager",
    });
    await linkPlanRow(context, medium.issueId, "plan-a");
    await linkPlanRow(context, critical.issueId, "plan-a");
    await linkPlanRow(context, unlinked.issueId, "plan-z");

    const allow = await findingsCleanupGate(context, "plan-a", { mode: "allow-residual" });
    expect(allow.violations.map((violation) => violation.code)).toEqual(["findings.allow-residual-critical"]);
    expect(allow.collaboration.completeness).toBe("complete");

    const zero = await findingsCleanupGate(context, "plan-a", { mode: "zero-residual" });
    expect(zero.violations.map((violation) => violation.code).sort()).toEqual([
      "findings.zero-residual-critical",
      "findings.zero-residual-open-issue",
    ]);

    const peer = await findingsCleanupGate(context, "plan-z", { mode: "zero-residual" });
    expect(peer.violations.map((violation) => violation.code)).toEqual(["findings.zero-residual-open-issue"]);
    const nobody = await findingsCleanupGate(context, "plan-b", { mode: "zero-residual" });
    expect(nobody.ok).toBe(true);
    expect(nobody.violations).toEqual([]);
    expect(nobody.collaboration.open).toEqual([]);
  });

  test("actor-only plan labels do not become findings, while legacy rows remain plan-scoped", async () => {
    const context = ctx("gate-origin");
    await activeLane(context);
    const captured = await captureIssue(context, finding("unscoped-label"), {
      operationId: "cap-unscoped-label",
      actor: "project-manager",
    });
    await linkIssue(context, captured.issueId, { kind: "plan", target: "plan-a" }, {
      operationId: "unscoped-link", actor: "project-manager", expectedRevision: captured.revision,
    });
    expect((await findingsCleanupGate(context, "plan-a", { mode: "zero-residual" })).ok).toBe(true);

    const scoped = await captureIssue(context, finding("scoped-link"), {
      operationId: "cap-scoped-link",
      actor: "project-manager",
    });
    await linkIssueScoped(context, scoped.issueId, { kind: "plan", target: "plan-b" }, {
      operationId: "scoped-link", actor: "project-manager", expectedRevision: scoped.revision,
    });
    expect((await findingsCleanupGate(context, "plan-b", { mode: "zero-residual" })).violations).toHaveLength(1);

    const historical = await captureIssue(context, finding("historical-link"), {
      operationId: "cap-historical-link",
      actor: "project-manager",
    });
    await linkPlanRow(context, historical.issueId, "plan-a");
    expect((await findingsCleanupGate(context, "plan-a", { mode: "zero-residual" })).violations).toHaveLength(1);
  });

  test("issue authority: only OPEN issues gate, so a closed one leaves the plan clean", async () => {
    const context = ctx("gate-closed");
    await activeLane(context);
    const captured = await captureIssue(context, finding("occ-closed"), {
      operationId: "cap-closed",
      actor: "project-manager",
    });
    await linkPlanRow(context, captured.issueId, "plan-a");
    expect((await findingsCleanupGate(context, "plan-a", { mode: "zero-residual" })).ok).toBe(false);

    await setDisposition(context, captured.issueId, "resolved");
    expect((await findingsCleanupGate(context, "plan-a", { mode: "zero-residual" })).ok).toBe(true);
  });

  test("issue authority: a missing, corrupt or staged lane refuses instead of reading as no findings", async () => {
    const missing = ctx("gate-missing");
    await expect(findingsCleanupGate(missing, "plan-a")).rejects.toThrow(/collaboration\.not-initialized/);

    const corrupt = ctx("gate-corrupt");
    await activeLane(corrupt);
    writeFileSync(laneLocation(corrupt).dbPath, "not a sqlite database\n", "utf8");
    await expect(findingsCleanupGate(corrupt, "plan-a")).rejects.toThrow(/collaboration\.unreadable/);

    const staged = ctx("gate-staged");
    await initializeCollaborationStore(laneLocation(staged));
    await expect(findingsCleanupGate(staged, "plan-a")).rejects.toThrow(/collaboration\.not-active/);
  });
});

describe("collaboration findings observation \u2014 complete scoped evidence", () => {
  test("collaboration findings observation: a missing or staged authority refuses with its own named code", async () => {
    const missing = ctx("observe-missing");
    await expect(observePlanFindings(missing, "plan-a")).rejects.toThrow(/collaboration\.not-initialized/);

    const staged = ctx("observe-staged");
    await initializeCollaborationStore(laneLocation(staged));
    await expect(observePlanFindings(staged, "plan-a")).rejects.toThrow(/collaboration\.not-active/);
  });

  test("collaboration findings observation: a foreign mirror link is not a finding, a legacy scoped row is", async () => {
    const context = ctx("observe-foreign");
    await activeLane(context);
    await insertForeignIssue(context, "EXT-critical", "plan-a");
    const foreign = await observePlanFindings(context, "plan-a");
    expect(foreign.completeness).toBe("complete");
    expect(foreign.open).toEqual([]);
    expect((await findingsCleanupGate(context, "plan-a", { mode: "zero-residual" })).ok).toBe(true);

    const local = await captureIssue(context, finding("legacy-provenance", { severity: "critical" }), {
      operationId: "cap-legacy-provenance",
      actor: "project-manager",
    });
    await linkPlanRow(context, local.issueId, "plan-a");
    const legacy = await observePlanFindings(context, "plan-a");
    expect(legacy.open).toEqual([{ id: local.issueId, severity: "critical" }]);
  });

  test("collaboration findings observation: a legitimate zero is complete, an open critical blocks both modes", async () => {
    const context = ctx("observe-zero");
    await activeLane(context);
    const zero = await findingsCleanupGate(context, "plan-empty", { mode: "zero-residual" });
    expect(zero.ok).toBe(true);
    expect(zero.collaboration.completeness).toBe("complete");

    const critical = await captureIssue(context, finding("observe-critical", { severity: "critical" }), {
      operationId: "cap-observe-critical",
      actor: "project-manager",
    });
    await linkIssueScoped(context, critical.issueId, { kind: "plan", target: "plan-a" }, {
      operationId: "link-observe-critical", actor: "project-manager", expectedRevision: critical.revision,
    });
    expect((await findingsCleanupGate(context, "plan-a", { mode: "allow-residual" })).violations.map((violation) => violation.code))
      .toEqual(["findings.allow-residual-critical"]);
    expect((await findingsCleanupGate(context, "plan-a", { mode: "zero-residual" })).violations.map((violation) => violation.code))
      .toEqual(["findings.zero-residual-critical"]);
  });

  test("collaboration findings observation: scope, snapshot time, authority stamp and revision name one snapshot", async () => {
    const context = ctx("observe-snapshot");
    await activeLane(context);
    const first = await observePlanFindings(context, "plan-a");
    expect(first.scope).toEqual({ kind: "plan", key: "plan-a" });
    expect(first.completeness).toBe("complete");
    expect(first.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.authority.storeId).toBe((await readCollaborationAuthority(context)).storeId);
    expect(Number.isInteger(first.revision)).toBe(true);
    expect(Number.isInteger(first.catalogRevision)).toBe(true);

    const issue = await captureIssue(context, finding("observe-later"), {
      operationId: "cap-observe-later",
      actor: "project-manager",
    });
    await linkIssueScoped(context, issue.issueId, { kind: "plan", target: "plan-a" }, {
      operationId: "link-observe-later", actor: "project-manager", expectedRevision: issue.revision,
    });
    const second = await observePlanFindings(context, "plan-a");
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.open).toEqual([{ id: issue.issueId, severity: "medium" }]);
    expect(second.authority).toEqual(first.authority);
  });
});

describe("collaboration gate evidence", () => {
  test("collaboration gate evidence: the decision names one complete plan-scoped observation", async () => {
    const context = ctx("gate-evidence");
    await activeLane(context);
    const medium = await captureIssue(context, finding("gate-evidence-medium"), {
      operationId: "cap-gate-evidence-medium",
      actor: "project-manager",
    });
    const critical = await captureIssue(context, finding("gate-evidence-critical", { severity: "critical" }), {
      operationId: "cap-gate-evidence-critical",
      actor: "project-manager",
    });
    await linkIssueScoped(context, medium.issueId, { kind: "plan", target: "plan-a" }, {
      operationId: "link-gate-evidence-medium", actor: "project-manager", expectedRevision: medium.revision,
    });
    await linkIssueScoped(context, critical.issueId, { kind: "plan", target: "plan-a" }, {
      operationId: "link-gate-evidence-critical", actor: "project-manager", expectedRevision: critical.revision,
    });

    const allow = await findingsCleanupGate(context, "plan-a", { mode: "allow-residual" });
    expect(allow.collaboration.scope).toEqual({ kind: "plan", key: "plan-a" });
    expect(allow.collaboration.completeness).toBe("complete");
    expect(allow.collaboration.open.map((row) => row.id).sort()).toEqual([medium.issueId, critical.issueId].sort());
    expect(allow.collaboration.authority.storeId).toBe((await readCollaborationAuthority(context)).storeId);
    expect(allow.violations.map((violation) => violation.code)).toEqual(["findings.allow-residual-critical"]);

    const zero = await findingsCleanupGate(context, "plan-a", { mode: "zero-residual" });
    expect(zero.violations.map((violation) => violation.code).sort()).toEqual([
      "findings.zero-residual-critical",
      "findings.zero-residual-open-issue",
    ]);
    const peer = await findingsCleanupGate(context, "plan-peer", { mode: "zero-residual" });
    expect(peer.ok).toBe(true);
    expect(peer.collaboration.open).toEqual([]);

    await assertPlanFindingsCurrent(context, allow.collaboration);
  });

  test("collaboration gate evidence: unprovable scope is incomplete and a moved lane is stale", async () => {
    const context = ctx("gate-evidence-drift");
    await activeLane(context);
    const observed = await observePlanFindings(context, "plan-a");

    await expect(assertPlanFindingsCurrent(context, { ...observed, scope: { kind: "project", key: "plan-a" } }))
      .rejects.toMatchObject({ code: "collaboration.observation-incomplete" });

    const issue = await captureIssue(context, finding("gate-evidence-drift"), {
      operationId: "cap-gate-evidence-drift",
      actor: "project-manager",
    });
    await linkIssueScoped(context, issue.issueId, { kind: "plan", target: "plan-a" }, {
      operationId: "link-gate-evidence-drift", actor: "project-manager", expectedRevision: issue.revision,
    });
    await expect(assertPlanFindingsCurrent(context, observed)).rejects.toMatchObject({
      code: "collaboration.observation-stale",
      details: { plan_id: "plan-a", observed: { revision: observed.revision } },
    });
    expect(observed.open).toEqual([]);
  });
});

describe("listIssues / getIssue \u2014 a staged lane is not queryable as read authority (FW-6)", () => {
  test("both read verbs refuse collaboration.not-active even when staged rows exist", async () => {
    const context = ctx("read-staged");
    await activeLane(context);
    const captured = await captureIssue(context, finding("occ-staged-read"), {
      operationId: "cap-staged-read",
      actor: "project-manager",
    });
    await withCollaborationWrite(context, (handle) => {
      handle.db.prepare("update collaboration_meta set authority_state = 'staged' where id = 1").run();
    });

    await expect(listIssues(context, {})).rejects.toThrow(/collaboration\.not-active/);
    await expect(getIssue(context, captured.issueId)).rejects.toThrow(/collaboration\.not-active/);
  });
});
