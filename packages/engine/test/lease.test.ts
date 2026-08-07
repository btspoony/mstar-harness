/**
 * Engine lease module — execution_lease / integration_merge_lease state
 * machines + same-host status write lock.
 *
 * Spec sources (each test cites the skill/reference section it enforces):
 * - Lease objects + required fields (holder / claimed_at / worktree_path /
 *   working_branch; integration_merge_lease adds plan_id / source_branch /
 *   target_branch; optional session_label is display-only): `mstar-plan-artifacts`
 *   `references/status-and-residuals.md` § `plans[].execution_lease` +
 *   § Root `metadata.integration_merge_lease` (v1) + maintenance ADR
 *   `.harness/docs/2026-07-22-iteration-worktree-plan-lease.md` (normative
 *   field names; `claimed_at` RFC 3339 UTC with explicit `Z`).
 * - `null` / tombstone lease objects are invalid — writers delete the key on
 *   release, never write `null`: status-and-residuals.md § "Hold, release,
 *   and override" + § Agent prohibitions ("MUST NOT write `null` or tombstone
 *   objects for lease keys — delete the key on release").
 * - Claim-before-InProgress (Todo/Blocked → InProgress + full lease in one
 *   update), same-holder resume (verify-held-lease: worktree_path +
 *   working_branch match), different-holder → Blocked ("no timestamp makes it
 *   stealable"), InProgress-without-lease orphan (STOP, do not invent a
 *   lease): status-and-residuals.md § Claim-before-`InProgress` +
 *   § Orphan recovery; phase-2-worktree-lease.md § Execution lease.
 * - Release deletes `execution_lease` (never null); `Done` deletes it in the
 *   same update **only after** successful integration merge:
 *   status-and-residuals.md § "Hold, release, and override" + § Integration
 *   merge protocol.
 * - Steal override requires explicit current-turn user instruction + audit
 *   `plans[].notes` — agents MUST NOT infer override from age/inactivity:
 *   status-and-residuals.md § "Hold, release, and override" + § Agent
 *   prohibitions.
 * - Same-host exclusive write lock: `flock` on `{HARNESS_DIR}/.status-write.lock`
 *   preferred; atomic `mkdir` on `{HARNESS_DIR}/.status-write.lockdir/`
 *   alternative (success acquires; existing dir → another writer holds the
 *   lock; remove the directory only after success/rollback):
 *   status-and-residuals.md § "Same-host exclusive write lock (control
 *   status.json)" + phase-2-worktree-lease.md § "Same-host exclusive write
 *   lock".
 *
 * `claimed_at` acceptance: normative form is RFC 3339 UTC with explicit `Z`
 * (ADR field table); the repo's local `YYYY-MM-DD` date convention is also
 * accepted — the real control `status.json` execution_lease
 * (`20260808-slice1-engine-foundation`, written by PM 2026-08-08) uses
 * `"claimed_at": "2026-08-08"` and MUST pass `mstar lease verify`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanRow } from "../src/status.js";
import {
  canSteal,
  claimLease,
  releaseLease,
  sameHolderResume,
  validateExecutionLease,
  validateIntegrationMergeLease,
  withStatusWriteLock,
} from "../src/lease.js";

/** RFC 3339 UTC timestamp with explicit Z (normative claimed_at form). */
const RFC3339_Z = "2026-07-22T02:30:00Z";

function validExecutionLease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    holder: "cursor:bc-1234",
    claimed_at: RFC3339_Z,
    worktree_path: "/repo-worktrees/plan-a",
    working_branch: "feature/plan-a",
    ...overrides,
  };
}

function validMergeLease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    holder: "cursor:bc-1234",
    claimed_at: RFC3339_Z,
    plan_id: "plan-a",
    source_branch: "feature/plan-a",
    target_branch: "iteration/2026-07",
    ...overrides,
  };
}

function violationCodes(gate: { violations: { code: string }[] }): string[] {
  return gate.violations.map((v) => v.code);
}

describe("validateExecutionLease", () => {
  test("valid lease with RFC 3339 UTC claimed_at passes", () => {
    // Spec: status-and-residuals.md § plans[].execution_lease — required
    // holder / claimed_at (RFC 3339 UTC, Z) / worktree_path / working_branch;
    // optional session_label display-only.
    const gate = validateExecutionLease(validExecutionLease());
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test("valid lease with repo date-only claimed_at passes (real control data)", () => {
    // Spec: ADR field table claims RFC 3339 UTC with Z; the repo's local
    // `YYYY-MM-DD` date convention is accepted too — the real control
    // `.harness/status.json` execution_lease for
    // 20260808-slice1-engine-foundation uses `"claimed_at": "2026-08-08"`
    // and `mstar lease verify` must pass on it.
    const gate = validateExecutionLease(validExecutionLease({ claimed_at: "2026-08-08" }));
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test("missing required fields are flagged (holder, claimed_at, worktree_path, working_branch)", () => {
    // Spec: § plans[].execution_lease — all four fields Required: Yes.
    const gate = validateExecutionLease({ session_label: "Plan A implementation" });
    expect(gate.ok).toBe(false);
    expect(violationCodes(gate)).toEqual(
      expect.arrayContaining([
        "lease.execution-lease.missing-holder",
        "lease.execution-lease.missing-claimed-at",
        "lease.execution-lease.missing-worktree-path",
        "lease.execution-lease.missing-working-branch",
      ]),
    );
  });

  test("null and tombstone objects are rejected", () => {
    // Spec: § Hold/release + § Agent prohibitions — `null` and tombstone
    // objects are invalid; writers delete the key, never write null.
    for (const tombstone of [null, "tombstone", 42, []]) {
      const gate = validateExecutionLease(tombstone);
      expect(gate.ok).toBe(false);
      expect(violationCodes(gate)).toContain("lease.execution-lease.invalid");
      expect(gate.violations[0].message).toMatch(/object/i);
    }
  });

  test("non-string / empty holder and working_branch are flagged", () => {
    const gate = validateExecutionLease(validExecutionLease({ holder: "", working_branch: 7 }));
    expect(gate.ok).toBe(false);
    expect(violationCodes(gate)).toEqual(
      expect.arrayContaining(["lease.execution-lease.invalid-holder", "lease.execution-lease.invalid-working-branch"]),
    );
  });

  test("worktree_path must be an absolute path", () => {
    // Spec: § plans[].execution_lease — worktree_path is an absolute path
    // string; MUST differ from metadata.control_worktree_path.
    const gate = validateExecutionLease(validExecutionLease({ worktree_path: "relative/worktree" }));
    expect(gate.ok).toBe(false);
    expect(violationCodes(gate)).toContain("lease.execution-lease.invalid-worktree-path");
    expect(gate.violations[0].message).toMatch(/absolute/);
  });

  test("invalid claimed_at formats are flagged", () => {
    // Spec: ADR — RFC 3339 UTC timestamp with explicit Z offset (audit only).
    for (const bad of ["tomorrow", "2026-13-99", "2026-07-22T02:30:00", "2026-07-22 02:30:00Z", 1700000000]) {
      const gate = validateExecutionLease(validExecutionLease({ claimed_at: bad }));
      expect(gate.ok).toBe(false);
      expect(violationCodes(gate)).toContain("lease.execution-lease.invalid-claimed-at");
    }
  });

  test("session_label must be a string when present (display only)", () => {
    // Spec: § plans[].execution_lease — session_label: string, No; display
    // only, MUST NOT authorize or compare ownership.
    const gate = validateExecutionLease(validExecutionLease({ session_label: 123 }));
    expect(gate.ok).toBe(false);
    expect(violationCodes(gate)).toContain("lease.execution-lease.invalid-session-label");
  });

  test("unknown extra fields are allowed (real data carries base_sha)", () => {
    // The real control execution_lease carries `base_sha`; the SSOT field set
    // is the required minimum — extra fields must not be flagged.
    const gate = validateExecutionLease(validExecutionLease({ base_sha: "471db08" }));
    expect(gate.ok).toBe(true);
  });
});

describe("validateIntegrationMergeLease", () => {
  test("valid serial merge lease passes", () => {
    // Spec: status-and-residuals.md § Root metadata.integration_merge_lease
    // (v1) — required holder / claimed_at / plan_id / source_branch /
    // target_branch (resolved spec_integration_branch); optional session_label.
    const gate = validateIntegrationMergeLease(validMergeLease());
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test("missing required fields are flagged", () => {
    const gate = validateIntegrationMergeLease({ session_label: "Integrate plan A" });
    expect(gate.ok).toBe(false);
    expect(violationCodes(gate)).toEqual(
      expect.arrayContaining([
        "lease.merge-lease.missing-holder",
        "lease.merge-lease.missing-claimed-at",
        "lease.merge-lease.missing-plan-id",
        "lease.merge-lease.missing-source-branch",
        "lease.merge-lease.missing-target-branch",
      ]),
    );
  });

  test("null and tombstone objects are rejected (absent = unclaimed; never null)", () => {
    // Spec: § Root metadata.integration_merge_lease — absent means unclaimed;
    // writers delete the key on release, never write null or tombstone.
    for (const tombstone of [null, [], "stale"]) {
      const gate = validateIntegrationMergeLease(tombstone);
      expect(gate.ok).toBe(false);
      expect(violationCodes(gate)).toContain("lease.merge-lease.invalid");
    }
  });

  test("invalid claimed_at and non-string branches are flagged", () => {
    const gate = validateIntegrationMergeLease(
      validMergeLease({ claimed_at: "yesterday", source_branch: "", target_branch: 9 }),
    );
    expect(gate.ok).toBe(false);
    expect(violationCodes(gate)).toEqual(
      expect.arrayContaining([
        "lease.merge-lease.invalid-claimed-at",
        "lease.merge-lease.invalid-source-branch",
        "lease.merge-lease.invalid-target-branch",
      ]),
    );
  });

  test("session_label must be a string when present", () => {
    const gate = validateIntegrationMergeLease(validMergeLease({ session_label: true }));
    expect(gate.ok).toBe(false);
    expect(violationCodes(gate)).toContain("lease.merge-lease.invalid-session-label");
  });
});

describe("claimLease", () => {
  function row(overrides: Partial<PlanRow> = {}): PlanRow {
    return { id: "plan-a", title: "Plan A", file: ".mstar/plans/plan-a.md", status: "Todo", ...overrides };
  }

  const FIELDS = { worktree_path: "/repo-worktrees/plan-a", working_branch: "feature/plan-a" };

  test("claim-before-InProgress: Todo → InProgress with full execution_lease", () => {
    // Spec: § Claim-before-InProgress — set status InProgress AND write the
    // full execution_lease (holder / claimed_at / worktree_path /
    // working_branch) in one update, before any writable dispatch.
    const result = claimLease(row(), "cursor:bc-1234", FIELDS);
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("claimed");
    const lease = result.row.execution_lease as Record<string, unknown>;
    expect(result.row.status).toBe("InProgress");
    expect(lease.holder).toBe("cursor:bc-1234");
    expect(lease.worktree_path).toBe("/repo-worktrees/plan-a");
    expect(lease.working_branch).toBe("feature/plan-a");
    expect(lease.claimed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    // claimed_at is now (RFC 3339 UTC with Z), not a stale/fixed value.
    const claimed = Date.parse(String(lease.claimed_at));
    expect(Math.abs(Date.now() - claimed)).toBeLessThan(60_000);
  });

  test("Blocked → InProgress with lease (claim path also covers Blocked)", () => {
    // Spec: § Claim-before-InProgress — claim from Todo or Blocked.
    const result = claimLease(row({ status: "Blocked" }), "cursor:bc-1234", FIELDS);
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("claimed");
    expect(result.row.status).toBe("InProgress");
    expect((result.row.execution_lease as Record<string, unknown>).holder).toBe("cursor:bc-1234");
  });

  test("session_label passes through on claim (display only)", () => {
    const result = claimLease(row(), "cursor:bc-1234", { ...FIELDS, session_label: "Plan A implementation" });
    expect(result.ok).toBe(true);
    expect((result.row.execution_lease as Record<string, unknown>).session_label).toBe("Plan A implementation");
  });

  test("same-holder resume: lease kept, no new claim, verify-held-lease fields match", () => {
    // Spec: § Claim-before-InProgress #2 — same holder → resume: confirm
    // worktree_path and working_branch match the Assignment; continue (not
    // steal/block, not a new claim).
    const prior = row({
      status: "InProgress",
      execution_lease: { holder: "cursor:bc-1234", claimed_at: RFC3339_Z, ...FIELDS },
    });
    const result = claimLease(prior, "cursor:bc-1234", FIELDS);
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("resumed");
    // The existing lease is preserved verbatim — claimed_at is not rewritten.
    expect(result.row.execution_lease).toEqual({ holder: "cursor:bc-1234", claimed_at: RFC3339_Z, ...FIELDS });
    expect(result.row.status).toBe("InProgress");
  });

  test("same-holder resume with mismatched worktree_path is refused (verify-held-lease)", () => {
    // Spec: § Claim-before-InProgress #2 — verify-held-lease requires
    // worktree_path and working_branch to match the Assignment.
    const prior = row({
      status: "InProgress",
      execution_lease: { holder: "cursor:bc-1234", claimed_at: RFC3339_Z, ...FIELDS },
    });
    const result = claimLease(prior, "cursor:bc-1234", { ...FIELDS, worktree_path: "/elsewhere" });
    expect(result.ok).toBe(false);
    expect(violationCodes(result)).toContain("lease.claim.verify-held-lease");
    expect(result.row).toEqual(prior);
  });

  test("same-holder resume with mismatched working_branch is refused (verify-held-lease)", () => {
    const prior = row({
      status: "InProgress",
      execution_lease: { holder: "cursor:bc-1234", claimed_at: RFC3339_Z, ...FIELDS },
    });
    const result = claimLease(prior, "cursor:bc-1234", { ...FIELDS, working_branch: "feature/other" });
    expect(result.ok).toBe(false);
    expect(violationCodes(result)).toContain("lease.claim.verify-held-lease");
    expect(result.row).toEqual(prior);
  });

  test("different-holder claim is refused — no timestamp makes it stealable", () => {
    // Spec: § Claim-before-InProgress #3 — different holder → Blocked; no
    // timestamp, TTL, or inactivity makes it stealable.
    const prior = row({
      status: "InProgress",
      execution_lease: { holder: "cursor:bc-1234", claimed_at: RFC3339_Z, ...FIELDS },
    });
    const result = claimLease(prior, "other:session-99", FIELDS);
    expect(result.ok).toBe(false);
    expect(violationCodes(result)).toContain("lease.claim.other-holder");
    expect(result.row.execution_lease).toEqual(prior.execution_lease); // never overwritten
  });

  test("InProgress without execution_lease is flagged as orphan — no lease invented", () => {
    // Spec: § Claim-before-InProgress #4 + § Orphan recovery — InProgress
    // without lease → STOP; do not writable-dispatch or invent a lease.
    const prior = row({ status: "InProgress" });
    const result = claimLease(prior, "cursor:bc-1234", FIELDS);
    expect(result.ok).toBe(false);
    expect(violationCodes(result)).toContain("lease.claim.orphan");
    expect(result.row).toEqual(prior);
    expect(result.row.execution_lease).toBeUndefined();
  });

  test("claim from a non-Todo/Blocked status without lease is refused", () => {
    // Spec: § Claim-before-InProgress — claim transitions are
    // Todo/Blocked → InProgress; other statuses are not claimable.
    for (const status of ["InReview", "Done"]) {
      const result = claimLease(row({ status }), "cursor:bc-1234", FIELDS);
      expect(result.ok).toBe(false);
      expect(violationCodes(result)).toContain("lease.claim.status");
    }
  });

  test("null/tombstone execution_lease on the row is rejected, not silently replaced", () => {
    // Spec: § Agent prohibitions — null/tombstone lease keys are invalid
    // writes; a corrupt stored value must be surfaced, not overwritten.
    const prior = row({ status: "InProgress", execution_lease: null });
    const result = claimLease(prior, "cursor:bc-1234", FIELDS);
    expect(result.ok).toBe(false);
    expect(violationCodes(result)).toContain("lease.claim.tombstone");
    expect(result.row.execution_lease).toBeNull();
  });
});

describe("releaseLease", () => {
  function leasedRow(): PlanRow {
    return {
      id: "plan-a",
      title: "Plan A",
      file: ".mstar/plans/plan-a.md",
      status: "InReview",
      execution_lease: { holder: "cursor:bc-1234", claimed_at: RFC3339_Z, worktree_path: "/wt", working_branch: "feature/plan-a" },
    };
  }

  test("release deletes execution_lease entirely (never writes null)", () => {
    // Spec: § Hold, release, and override — delete execution_lease in the
    // same complete-file update — never `null`; § Agent prohibitions.
    const result = releaseLease(leasedRow());
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("released");
    expect("execution_lease" in result.row).toBe(false);
    expect(result.row.execution_lease).toBeUndefined();
  });

  test("release preserves the rest of the plan row", () => {
    // Spec: § Agent prohibitions — writers MUST preserve unrelated plan rows
    // and fields on every lease mutation.
    const prior = leasedRow();
    const result = releaseLease(prior);
    expect(result.row.id).toBe("plan-a");
    expect(result.row.title).toBe("Plan A");
    expect(result.row.status).toBe("InReview");
    expect(result.row.file).toBe(".mstar/plans/plan-a.md");
  });

  test("release is idempotent when no lease is present", () => {
    const prior = leasedRow();
    delete prior.execution_lease;
    const result = releaseLease(prior);
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("released");
    expect(result.row).toEqual(prior);
  });

  test("tombstone lease is rejected, row unchanged", () => {
    const prior = leasedRow();
    prior.execution_lease = null;
    const result = releaseLease(prior);
    expect(result.ok).toBe(false);
    expect(violationCodes(result)).toContain("lease.release.tombstone");
    expect(result.row.execution_lease).toBeNull();
  });
});

describe("sameHolderResume", () => {
  test("true iff lease holder matches the session holder", () => {
    // Spec: § Claim-before-InProgress #2 — resume is authorized only when
    // holder equals this session.
    const lease = { holder: "cursor:bc-1234", claimed_at: RFC3339_Z, worktree_path: "/wt", working_branch: "feature/plan-a" };
    expect(sameHolderResume(lease, "cursor:bc-1234")).toBe(true);
    expect(sameHolderResume(lease, "other:session")).toBe(false);
  });

  test("false for null / tombstone / undefined leases", () => {
    expect(sameHolderResume(null, "cursor:bc-1234")).toBe(false);
    expect(sameHolderResume(undefined, "cursor:bc-1234")).toBe(false);
    expect(sameHolderResume("stale", "cursor:bc-1234")).toBe(false);
  });
});

describe("canSteal", () => {
  const lease = { holder: "cursor:bc-1234", claimed_at: RFC3339_Z, worktree_path: "/wt", working_branch: "feature/plan-a" };

  test("always false without an explicit user override", () => {
    // Spec: § Agent prohibitions — MUST NOT steal an active lease; no TTL,
    // age, or inactivity authority in v1.
    expect(canSteal(lease, "other:session")).toBe(false);
    expect(canSteal(lease, "other:session", {})).toBe(false);
  });

  test("true only with an explicit current-turn user override for a different holder", () => {
    // Spec: § Hold, release, and override — the ONLY exception is an explicit
    // user instruction in the current turn; the caller must still append an
    // audit entry to plans[].notes (timestamp, prior holder, new holder,
    // user authorized).
    expect(canSteal(lease, "other:session", { userOverride: true })).toBe(true);
  });

  test("same holder is never a steal (resume path instead)", () => {
    expect(canSteal(lease, "cursor:bc-1234", { userOverride: true })).toBe(false);
  });

  test("false for null / tombstone leases even with override", () => {
    expect(canSteal(null, "other:session", { userOverride: true })).toBe(false);
  });
});

describe("withStatusWriteLock", () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), "lease-lock-"));
  }

  test("serializes two concurrent writers (read-increment-write, no lost update)", async () => {
    // Spec: § Same-host exclusive write lock — lease/status mutations run
    // inside a same-host exclusive write lock for the full
    // read-check-replace-verify sequence; the lock serializes concurrent
    // writers on the same coordination status.json.
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      const counterPath = join(dir, "counter.txt");
      writeFileSync(counterPath, "0");

      const writer = async (id: string) =>
        withStatusWriteLock(statusPath, async () => {
          // Read-check-replace: a lockless interleaving would read the same
          // value twice and lose one increment. The `await Promise.resolve()`
          // yield is the race window — no wall-clock delay needed: writer B
          // starts (and reads) while writer A is suspended at this point, so
          // a non-exclusive lock would drop one increment deterministically.
          // Fake timers cannot drive this: the lock acquisition itself is
          // real filesystem I/O (mkdir + poll).
          const current = Number(readFileSync(counterPath, "utf8"));
          await Promise.resolve();
          writeFileSync(counterPath, String(current + 1));
          return id;
        });

      const [a, b] = await Promise.all([writer("a"), writer("b")]);
      expect(a).toBe("a");
      expect(b).toBe("b");
      expect(readFileSync(counterPath, "utf8")).toBe("2");
      // Lock directory removed after the critical section (all exit paths).
      expect(existsSync(join(dir, ".status-write.lockdir"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes the lock directory when fn throws", async () => {
    // Spec: release on all exit paths (success or failure).
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      await expect(
        withStatusWriteLock(statusPath, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(existsSync(join(dir, ".status-write.lockdir"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("existing lockdir blocks a second writer until timeout (another writer holds the lock)", async () => {
    // Spec: § Same-host exclusive write lock (alternative) — existing
    // lockdir → another writer holds the lock; Blocked, no silent bypass.
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      mkdirSync(join(dir, ".status-write.lockdir"));
      await expect(withStatusWriteLock(statusPath, () => "never", { timeoutMs: 120 })).rejects.toThrow(
        /another writer holds/i,
      );
      // The other writer's lockdir is not removed by the blocked waiter.
      expect(existsSync(join(dir, ".status-write.lockdir"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("supports synchronous fn and returns its value", () => {
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      const value = withStatusWriteLock(statusPath, () => 42);
      expect(value).resolves.toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
