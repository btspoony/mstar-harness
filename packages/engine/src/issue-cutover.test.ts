/**
 * issue-cutover.test.ts — proof: the engine's issue authority cutover.
 *
 * Spec sources:
 * - the issue-store contract §2/§5/§7 (the store is the only findings
 *   authority; `apply ≠ activate`: a staged store is never an authority, and a
 *   missing or corrupt one is never an empty one) and §6 (capture duty).
 * - The cutover's global constraints (the scoped residual writers and the
 *   `ArtifactStore` residual persist must cut over BEFORE activation) plus the
 *   hard invariants this file proves.
 *
 * What this file proves, and what its neighbours own:
 * - HERE: no RAW write path can recreate a legacy register (the retired kind,
 *   and `json` aliases — direct, symlinked, or inside the protected writer's
 *   authorizing context), the artifact path table has no register mapping, and
 *   `findingsCleanupGate` fails closed instead of reading a missing, corrupt or
 *   staged store as "no findings".
 * - `test/coordination.test.ts`: the scoped lifecycle — residual-add/close
 *   against the store, the handoff gate, and a lifecycle step refusing while
 *   the store is unavailable.
 * - `test/project.test.ts`: `validateProjectRegister` as the migration-only
 *   register validator. `test/status.test.ts`: the legacy rollup aggregation
 *   the CLI cutover converts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withProtectedWrite } from "./coordination-write.js";
import { captureIssue, getIssue, listIssues, type CaptureInput } from "./issue.js";
import { findingsCleanupGate } from "./project.js";
import { createFsStore, resolveArtifactPath, type ArtifactStore } from "./store.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-issue-cutover-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** A fresh harness dir under this file's scratch root. */
function ctx(name: string): StoreContext {
  return { harnessDir: mkdtempSync(join(ROOT, `${name}-`)) };
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

describe("retired register persist — the raw store cannot recreate a project register", () => {
  test("issue authority: the retired residuals kind refuses every raw port and leaves existing bytes alone", async () => {
    const { store, registerPath } = workspaceWithRegister("retired-kind");
    const before = readFileSync(registerPath);
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
    expect(readFileSync(registerPath).equals(before)).toBe(true);
  });

  test("issue authority: a json alias to a project register refuses directly, through a symlink, and inside the protected writer", async () => {
    const { store, registerPath } = workspaceWithRegister("retired-alias");
    const before = readFileSync(registerPath);
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
    expect(readFileSync(registerPath).equals(before)).toBe(true);
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

/* ------------------------------------------------------------------------ *
 * § Findings gate — the store is the authority; a broken store fails closed
 * ------------------------------------------------------------------------ */

/**
 * Link an issue to a plan exactly as the scoped writer does. The provenance
 * row is seeded directly because the core verb re-verifies a live engine-issued
 * session envelope (contract §4): this file proves the READ gate's semantics,
 * and the verb's authorization is proven in `test/coordination.test.ts`
 * through a real bound plan session.
 */
async function linkPlanRow(context: StoreContext, issueId: string, planId: string): Promise<void> {
  const handle = await openStore(context, "write");
  try {
    handle.db
      .prepare("insert into provenance(issue_id, kind, target, source_hash) values (?, 'plan', ?, ?)")
      .run(issueId, planId, `fixture:${planId}`);
  } finally {
    handle.close();
  }
}

describe("findingsCleanupGate — authoritative linked open issues (G2a)", () => {
  test("issue authority: only the plan's own open issues count, and an open critical blocks both modes", async () => {
    const context = ctx("gate-modes");
    await initializeStore(context).then((handle) => handle.close());
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

    const zero = await findingsCleanupGate(context, "plan-a", { mode: "zero-residual" });
    expect(zero.violations.map((violation) => violation.code).sort()).toEqual([
      "findings.zero-residual-critical",
      "findings.zero-residual-open-issue",
    ]);

    // A plan is gated only by its OWN links: `plan-z` holds the third issue and
    // flags it, while `plan-b`, which links nothing, stays clean even though
    // open issues exist in the store.
    const peer = await findingsCleanupGate(context, "plan-z", { mode: "zero-residual" });
    expect(peer.violations.map((violation) => violation.code)).toEqual(["findings.zero-residual-open-issue"]);
    const nobody = await findingsCleanupGate(context, "plan-b", { mode: "zero-residual" });
    expect(nobody.ok).toBe(true);
    expect(nobody.violations).toEqual([]);
  });

  test("issue authority: only OPEN issues gate, so a closed one leaves the plan clean", async () => {
    const context = ctx("gate-closed");
    await initializeStore(context).then((handle) => handle.close());
    const captured = await captureIssue(context, finding("occ-closed"), {
      operationId: "cap-closed",
      actor: "project-manager",
    });
    await linkPlanRow(context, captured.issueId, "plan-a");
    expect((await findingsCleanupGate(context, "plan-a", { mode: "zero-residual" })).ok).toBe(false);

    // The disposition flip is seeded here for the same reason as the link
    // above: the read gate's input is the issue row's disposition.
    const handle = await openStore(context, "write");
    try {
      handle.db.prepare("update issues set disposition = 'resolved' where id = ?").run(captured.issueId);
    } finally {
      handle.close();
    }
    expect((await findingsCleanupGate(context, "plan-a", { mode: "zero-residual" })).ok).toBe(true);
  });

  test("issue authority: a missing, corrupt or staged store refuses instead of reading as no findings", async () => {
    const missing = ctx("gate-missing");
    await expect(findingsCleanupGate(missing, "plan-a")).rejects.toThrow(/store\.not-initialized/);

    const corrupt = ctx("gate-corrupt");
    writeFileSync(join(corrupt.harnessDir, "store.db"), "not a sqlite database\n", "utf8");
    await expect(findingsCleanupGate(corrupt, "plan-a")).rejects.toThrow(/store\.corrupt/);

    // Pre-activation window (contract §7): the staged store is not an
    // authority, so the gate must refuse rather than report an empty plan.
    const staged = ctx("gate-staged");
    await initializeStore(staged).then((handle) => handle.close());
    const handle = await openStore(staged, "write");
    try {
      handle.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
    } finally {
      handle.close();
    }
    await expect(findingsCleanupGate(staged, "plan-a")).rejects.toThrow(/store\.not-active/);
  });
});

/* ------------------------------------------------------------------------ *
 * § Domain read verbs vs a staged store (plan QC fix wave FW-6)
 * ------------------------------------------------------------------------ */

describe("listIssues / getIssue — a staged store is not queryable as read authority (FW-6)", () => {
  test("both read verbs refuse store.not-active even when staged rows exist", async () => {
    const context = ctx("read-staged");
    await initializeStore(context).then((handle) => handle.close());
    // Seed a real row through the domain verb while the store is active, THEN
    // demote: the refusal must hold with data present, not only on an empty
    // staged store (the staged-import inspection case from QC seat 1 F-003).
    const captured = await captureIssue(context, finding("occ-staged-read"), {
      operationId: "cap-staged-read",
      actor: "project-manager",
    });
    const handle = await openStore(context, "write");
    try {
      handle.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
    } finally {
      handle.close();
    }

    // Pre-activation window (contract §7): a staged DB refuses ordinary
    // domain verbs — reads included. Staged data stays inspectable through
    // the migration surface (manifest/receipt), never as queryable issues.
    await expect(listIssues(context, {})).rejects.toThrow(/store\.not-active/);
    await expect(getIssue(context, captured.issueId)).rejects.toThrow(/store\.not-active/);
  });
});
