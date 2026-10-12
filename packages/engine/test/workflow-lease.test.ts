/**
 * Workflow integration merge mutex validation — the workflow-wide serial
 * integration merge lease shape.
 *
 * The per-plan `execution_lease` and its claim/release/transfer state machine
 * were removed with the plan-PM seat: ordinary coordinator plan writes are
 * serialized by the store's CAS token, `BEGIN IMMEDIATE` transactions and
 * operation receipts, and a row's worktree/branch facts live in its own
 * `metadata`. What remains here is the exclusion that protects an actual
 * serial Git integration (`integration_merge_lease`).
 *
 * Spec sources (each test cites the reference section it enforces):
 * - `integration_merge_lease` (holder / claimed_at / plan_id / source_branch /
 *   target_branch; optional session_label display-only): `mstar-artifacts`
 *   `references/status-and-residuals.md` § Snapshot top-level
 *   `integration_merge_lease` (v3). `null` / tombstone objects are invalid —
 *   writers delete the key on release, never write `null`
 *   (§ "Hold, release, and override" + § Agent prohibitions).
 *
 * `claimed_at` acceptance: the normative form is RFC 3339 UTC with explicit
 * `Z` (ADR field table).
 */
import { describe, expect, test } from "bun:test";
import { validateIntegrationMergeLease } from "../src/workflow.js";

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

