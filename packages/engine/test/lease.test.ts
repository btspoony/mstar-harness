/**
 * Engine lease module — the workflow-wide serial integration merge lease and
 * the same-host status write lock.
 *
 * The per-plan `execution_lease` and its claim/release/transfer state machine
 * were removed with the plan-PM seat: ordinary coordinator plan writes are
 * serialized by the store's CAS token, `BEGIN IMMEDIATE` transactions and
 * operation receipts, and a row's worktree/branch facts live in its own
 * `metadata`. What remains here is the exclusion that protects an actual
 * serial Git integration (`integration_merge_lease`) and the same-host lock
 * that guards the coordination documents.
 *
 * Spec sources (each test cites the reference section it enforces):
 * - `integration_merge_lease` (holder / claimed_at / plan_id / source_branch /
 *   target_branch; optional session_label display-only): `mstar-artifacts`
 *   `references/status-and-residuals.md` § Snapshot top-level
 *   `integration_merge_lease` (v3). `null` / tombstone objects are invalid —
 *   writers delete the key on release, never write `null`
 *   (§ "Hold, release, and override" + § Agent prohibitions).
 * - Same-host exclusive write lock: atomic `mkdir` on
 *   `{HARNESS_DIR}/.status-write.lockdir/` (success acquires; existing dir →
 *   another writer holds the lock; remove the directory only after
 *   success/rollback): status-and-residuals.md § "Same-host exclusive write
 *   lock (control status.json)". The lock guards all coordination writes — the
 *   root `status.json` AND `workflows/<id>/snapshot.json`.
 * - Crash diagnosis (#447): the Blocked refusal names the lockdir, the holder
 *   pid, the lock age and the verified recovery per state — a live holder pid
 *   (`process.kill(pid, 0)` success or `EPERM`) to wait for or stop; a holder
 *   pid proven gone (`ESRCH`), or an absent pid file, removable only after
 *   confirming no `mstar` writer runs (`pgrep -fl mstar`). No waiter ever
 *   reclaims a lockdir it did not acquire.
 *
 * `claimed_at` acceptance: the normative form is RFC 3339 UTC with explicit
 * `Z` (ADR field table).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateIntegrationMergeLease, withStatusWriteLock } from "../src/lease.js";

/** RFC 3339 UTC timestamp with explicit Z (normative claimed_at form). */
const RFC3339_Z = "2026-07-22T02:30:00Z";

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

/**
 * A pid no live process owns (`process.kill(pid, 0)` → `ESRCH`) — the
 * stand-in for a crashed lock holder (#447). Scanned rather than
 * spawn-then-exit so the value cannot be a recycled live pid.
 */
function deadPid(): number {
  for (let pid = 50_000; pid < 50_100; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no unowned pid found in the 50000-50099 scan range");
}

describe("validateIntegrationMergeLease", () => {
  test("valid serial merge lease passes", () => {
// Spec: status-and-residuals.md § Snapshot top-level
// integration_merge_lease (v3) — required holder / claimed_at / plan_id /
// source_branch / target_branch (resolved spec_integration_branch);
// optional session_label.
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
// Spec: § Snapshot top-level integration_merge_lease — absent means
// unclaimed; writers delete the key on release, never write null or
// tombstone.
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

  test("session_label must be a string when present (display only)", () => {
    const gate = validateIntegrationMergeLease(validMergeLease({ session_label: true }));
    expect(gate.ok).toBe(false);
    expect(violationCodes(gate)).toContain("lease.merge-lease.invalid-session-label");
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
// writers on the same coordination file (root status.json or a workflow
// snapshot).
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
      expect(Number(readFileSync(counterPath, "utf8"))).toBe(2);
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

  test("a dead holder pid is diagnosed as stale and never reclaimed; the refusal names the verified recovery (#447)", async () => {
// Spec: § Crash diagnosis (#447) — ESRCH proves the holder gone, so the
// refusal reports a stale lockdir and its manual recovery; it is never
// removed by a waiter (no auto takeover).
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      const lockDir = join(dir, ".status-write.lockdir");
      const dead = deadPid();
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "holder.pid"), String(dead));
      const error = await withStatusWriteLock(statusPath, () => "never", { timeoutMs: 120 }).catch(
        (thrown: unknown) => thrown as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(lockDir);
      expect(error.message).toContain(`holder pid ${dead} no longer exists`);
      expect(error.message).toContain("the lockdir is stale");
      expect(error.message).toContain("pgrep -fl mstar");
      expect(error.message).toContain("unblocks writers");
      expect(error.message).toContain("It is not removed automatically.");
// NOT reclaimed: the stale lockdir and its holder file survive the timeout.
      expect(existsSync(lockDir)).toBe(true);
      expect(readFileSync(join(lockDir, "holder.pid"), "utf8")).toBe(String(dead));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a live holder pid keeps the waiter waiting; the refusal names the holder and its recovery (#447)", async () => {
// Spec: § Crash diagnosis (#447) — a live holder (success or EPERM on the
// probe) keeps the original wait/timeout behavior and its lockdir untouched.
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      const lockDir = join(dir, ".status-write.lockdir");
      const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
      try {
        mkdirSync(lockDir);
        writeFileSync(join(lockDir, "holder.pid"), String(sleeper.pid));
        const started = Date.now();
        const error = await withStatusWriteLock(statusPath, () => "never", { timeoutMs: 150 }).catch(
          (thrown: unknown) => thrown as Error,
        );
        expect(error).toBeInstanceOf(Error);
// It waited the full budget instead of touching a live lock.
        expect(Date.now() - started).toBeGreaterThanOrEqual(150);
        expect(error.message).toContain(lockDir);
        expect(error.message).toContain(`holder pid ${sleeper.pid} is alive`);
        expect(error.message).toMatch(/lock age \d+ms/);
        expect(error.message).toContain(`kill ${sleeper.pid}`);
// A live holder's lockdir is not removed.
        expect(existsSync(lockDir)).toBe(true);
        expect(readFileSync(join(lockDir, "holder.pid"), "utf8")).toBe(String(sleeper.pid));
      } finally {
        sleeper.kill();
        await sleeper.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lockdir without a holder pid is diagnosed as the mkdir-to-pid-write crash window (#447)", async () => {
// Spec: § Crash diagnosis (#447) — the pid-less narrow crash window is not
// evidence of death; the refusal names the verification the operator runs.
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      const lockDir = join(dir, ".status-write.lockdir");
      mkdirSync(lockDir);
      const error = await withStatusWriteLock(statusPath, () => "never", { timeoutMs: 120 }).catch(
        (thrown: unknown) => thrown as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(lockDir);
      expect(error.message).toContain("records no holder.pid");
      expect(error.message).toContain("crash between mkdir and pid write");
      expect(error.message).toContain("pgrep -fl mstar");
      expect(error.message).toContain("It is not removed automatically.");
// Untouched: no reclaim without a recorded pid.
      expect(existsSync(lockDir)).toBe(true);
      expect(existsSync(join(lockDir, "holder.pid"))).toBe(false);
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

  test("double-unlock guard: a late finally never removes a second writer's lockdir", async () => {
// Spec: — writer A's fn removes the lockdir (rollback); writer B
// acquires a fresh lockdir; A's finally must detect the changed (dev, ino)
// and skip rmdir, so B's lock is not destroyed.
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      const lockDir = join(dir, ".status-write.lockdir");
      let aRemovedOwn = false;
      let bInside = false;
      const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();

      const a = withStatusWriteLock(statusPath, async () => {
// A's fn rolls back by removing its own lockdir (holder.pid first —
// rmdir fails on a non-empty directory).
        unlinkSync(join(lockDir, "holder.pid"));
        rmdirSync(lockDir);
        aRemovedOwn = true;
        await gate; // hold A inside fn until B has acquired
      });

      const b = withStatusWriteLock(statusPath, async () => {
        bInside = true;
        return "b";
      });

// Real-timer exception: this interleaving is driven by real filesystem
// state (mkdir/rmdir/stat) across two concurrent async tasks — fake
// timers cannot advance real FS I/O, so the poll waits on observable
// state rather than a fixed delay (same rationale as the suite's
// "serializes two concurrent writers" yield comment).
      const start = Date.now();
      while (!(aRemovedOwn && bInside) && Date.now() - start < 5_000) {
        await Bun.sleep(2);
      }
      openGate(); // always release A after the wait window — a must never dangle
      expect(aRemovedOwn).toBe(true);
      expect(bInside).toBe(true); // B acquired the lockdir A removed
      await expect(a).resolves.toBeUndefined();
      expect(await b).toBe("b");
// B's own finally removed B's lockdir; A's finally skipped it.
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fn removing the lockdir on failure leaves nothing to clean (skip, no throw)", async () => {
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      const lockDir = join(dir, ".status-write.lockdir");
      await expect(
        withStatusWriteLock(statusPath, async () => {
// rollback removes the lockdir (holder.pid first) before the throw
          unlinkSync(join(lockDir, "holder.pid"));
          rmdirSync(lockDir);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(existsSync(lockDir)).toBe(false);
// A subsequent writer can acquire normally.
      expect(await withStatusWriteLock(statusPath, () => "ok")).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reentrancy: nested acquisition on the same status.json throws immediately", async () => {
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      await expect(
        withStatusWriteLock(statusPath, async () => {
// Nested call on the SAME lockdir — must throw fast, not wait 30s.
          return withStatusWriteLock(statusPath, () => "nested");
        }),
      ).rejects.toThrow(/not reentrant/i);
// The outer lock was still released cleanly.
      expect(existsSync(join(dir, ".status-write.lockdir"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reentrancy is scoped per async context: sequential locks on the same path are fine", async () => {
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      const first = await withStatusWriteLock(statusPath, () => "one");
      const second = await withStatusWriteLock(statusPath, () => "two");
      expect(first).toBe("one");
      expect(second).toBe("two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("holder.pid file is written inside the lockdir and removed on release", async () => {
    const dir = makeDir();
    try {
      const statusPath = join(dir, "status.json");
      const lockDir = join(dir, ".status-write.lockdir");
      const seen: number[] = [];
      await withStatusWriteLock(statusPath, async () => {
        const pidPath = join(lockDir, "holder.pid");
        expect(existsSync(pidPath)).toBe(true);
        seen.push(Number(readFileSync(pidPath, "utf8")));
      });
      expect(seen).toEqual([process.pid]);
      expect(existsSync(join(lockDir, "holder.pid"))).toBe(false);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
