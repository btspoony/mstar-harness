import { describe, expect, test } from "bun:test";
import { assessShadowRun, freezeBaseline, recordWorkUnitDisposition, type FrozenBaseline, type WorkUnitReceipt } from "../src/shadow-receipts.js";

const hash = "a".repeat(64);
const baselineInput = () => ({ runId: "run-1", inventory: [{ id: "unit-1", revision: 1 }], seatOutputs: [{ unitId: "unit-1", outputId: "output-1" }], originalConsumption: { consumedOutputs: [{ unitId: "unit-1", outputId: "output-1", consumed: true, consumedAt: 1 }] }, finalReport: { status: "complete" } });
const consumed = { unitId: "unit-1", outputId: "output-1", consumed: true, consumedAt: 1 };
const receipt = (disposition: WorkUnitReceipt["disposition"], unitId = "unit-1", scopeSha256 = hash, packSha256 = hash, originalConsumption: unknown | null = disposition === "completed" ? consumed : null) => recordWorkUnitDisposition({ runId: "run-1", unitId, packId: "pack-1", packSha256, scopeSha256, disposition, originalConsumption, attemptId: "attempt-1" });
const validEvents = [
  { type: "start", runId: "run-1", at: 1 },
  { type: "baseline-frozen", runId: "run-1", at: 2 },
  { type: "request", runId: "run-1", at: 3 },
  { type: "complete", runId: "run-1", at: 4 },
] as const;
const assess = (baseline: FrozenBaseline, receipts: readonly WorkUnitReceipt[], requiredUnitIds = ["unit-1"], originalConsumption = baselineInput().originalConsumption, scopeSha256 = hash, packSha256 = hash, originalSeatOutputs = baselineInput().seatOutputs) => assessShadowRun({ baseline, receipts, childEvents: validEvents, evidenceClass: "component", elapsedMs: 1, packId: "pack-1", packSha256, scopeSha256, requiredUnitIds, originalConsumption, originalSeatOutputs });

describe("shadow baseline and work receipts", () => {
  test("requires child start, baseline, request, and genuine completion in order", () => {
    const baseline = freezeBaseline(baselineInput());
    const input = { baseline, receipts: [receipt("blocked")], evidenceClass: "component" as const,
      elapsedMs: 1, packId: "pack-1", packSha256: hash, scopeSha256: hash, requiredUnitIds: ["unit-1"],
      originalConsumption: baselineInput().originalConsumption, originalSeatOutputs: baselineInput().seatOutputs };
    expect(assessShadowRun({ ...input, childEvents: validEvents }).failures).toEqual([]);
    expect(assessShadowRun({ ...input, childEvents: [validEvents[0]!, validEvents[2]!, validEvents[1]!, validEvents[3]!] }).failures).toContain("probe-lifecycle-invalid");
    expect(assessShadowRun({ ...input, childEvents: [...validEvents.slice(0, 3), { type: "error", runId: "run-1", at: 4 }] }).failures).toContain("probe-lifecycle-invalid");
  });
  test("freezes a detached, deeply immutable baseline and detects tampering", () => {
    const input = baselineInput();
    const frozen = freezeBaseline(input);
    input.inventory[0]!.revision = 2;
    expect(frozen.inventory).toEqual([{ id: "unit-1", revision: 1 }]);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.inventory)).toBe(true);
    expect(Object.isFrozen((frozen.inventory as { revision?: number }[])[0])).toBe(true);
    expect(() => { ((frozen.inventory as { revision: number }[])[0]!).revision = 3; }).toThrow();
    const mutated = { ...frozen, inventory: [{ id: "unit-1", revision: 9 }] };
    expect(() => assess(mutated, [])).toThrow("jev.baseline-tampered");
  });

  test("requires structured per-unit consumption evidence for completion", () => {
    expect(() => recordWorkUnitDisposition({ runId: "run-1", unitId: "unit-1", packId: "pack-1", packSha256: hash, scopeSha256: hash, disposition: "completed", originalConsumption: null })).toThrow("jev.original-consumption-required");
    expect(() => receipt("completed", "unit-1", hash, hash, { outputId: "output-1", consumed: true })).toThrow("jev.original-consumption-invalid");
    const rows = [receipt("completed"), receipt("blocked", "unit-2"), receipt("cancelled", "unit-3")];
    expect(rows.map((row) => row.disposition)).toEqual(["completed", "blocked", "cancelled"]);
    expect(rows.every((row) => row.owner === "original" && row.jevWorkCredit === 0)).toBe(true);
    expect(rows[0]?.originalConsumptionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]?.attemptId).toBe("attempt-1");
  });

  test("rejects duplicate and missing required receipts but accounts for the zero-work case", () => {
    const baseline = freezeBaseline(baselineInput());
    const duplicate = receipt("completed");
    expect(() => assess(baseline, [duplicate, duplicate])).toThrow("jev.receipt-run-mismatch");
    expect(() => assess(baseline, [])).toThrow("jev.receipt-accounting-incomplete");
    const empty = assess(baseline, [], []);
    expect(empty.metrics).toMatchObject({ workUnits: 0, completedUnits: 0, blockedUnits: 0, cancelledUnits: 0, incompleteUnits: 0 });
    expect(empty.receipts).toEqual([]);
    expect(empty.w5).toBe(false);
    expect(empty.qualification).toBe("component-only");
    expect(() => assessShadowRun({ baseline, receipts: [], childEvents: validEvents, evidenceClass: "named-host", elapsedMs: 1, packId: "pack-1", packSha256: hash, scopeSha256: hash, requiredUnitIds: [], originalConsumption: baselineInput().originalConsumption, originalSeatOutputs: baselineInput().seatOutputs })).toThrow("jev.named-host-authorization-required");
  });

  test("rejects receipts from a prior pack or scope", () => {
    const baseline = freezeBaseline(baselineInput());
    expect(() => assess(baseline, [receipt("completed")], ["unit-1"], baselineInput().originalConsumption, "b".repeat(64))).toThrow("jev.receipt-identity-stale");
    expect(() => assess(baseline, [receipt("completed")], ["unit-1"], baselineInput().originalConsumption, hash, "b".repeat(64))).toThrow("jev.receipt-identity-stale");
  });

  test("credits completion only when its evidence matches the frozen per-unit consumption", () => {
    const baseline = freezeBaseline(baselineInput());
    const forged = receipt("completed", "unit-1", hash, hash, { unitId: "unit-1", outputId: "other-output", consumed: true, consumedAt: 1 });
    expect(() => assess(baseline, [forged])).toThrow("jev.original-consumption-mismatch");
    expect(assess(baseline, [receipt("completed")]).metrics.completedUnits).toBe(1);
    const missingSource = freezeBaseline({ ...baselineInput(), seatOutputs: [] });
    expect(() => assess(missingSource, [receipt("completed")], ["unit-1"], baselineInput().originalConsumption, hash, hash, [])).toThrow("jev.original-consumption-mismatch");
  });

  test("preserves cancellation and timeout dispositions without Jev credit", () => {
    const baseline = freezeBaseline(baselineInput());
    const cancelled = assessShadowRun({ baseline, receipts: [receipt("cancelled")], childEvents: [...validEvents.slice(0, 2), { type: "cancelled", runId: "run-1", at: 3 }], evidenceClass: "synthetic-offline", elapsedMs: 3, packId: "pack-1", packSha256: hash, scopeSha256: hash, requiredUnitIds: ["unit-1"], originalConsumption: baselineInput().originalConsumption, originalSeatOutputs: baselineInput().seatOutputs });
    expect(cancelled.failures).toContain("probe-lifecycle-invalid");
    expect(cancelled.metrics.cancelledUnits).toBe(1);
    expect(cancelled.w5).toBe(false);
    const timeoutEvents = [...validEvents.slice(0, 4), { type: "error" as const, runId: "run-1", at: 5 }];
    const timedOut = assessShadowRun({ baseline, receipts: [receipt("completed")], childEvents: timeoutEvents, evidenceClass: "component", elapsedMs: 5, failures: ["timeout"], packId: "pack-1", packSha256: hash, scopeSha256: hash, requiredUnitIds: ["unit-1"], originalConsumption: baselineInput().originalConsumption, originalSeatOutputs: baselineInput().seatOutputs });
    expect(timedOut.metrics.completedUnits).toBe(1);
    expect(timedOut.failures).toContain("timeout");
    expect(timedOut.baselineFrozen).toBe(true);
    const cancellations = ["unit-1", "unit-2", "unit-3"].map((id) => receipt("cancelled", id));
    const wholeAudit = assessShadowRun({ baseline, receipts: cancellations, childEvents: [...validEvents.slice(0, 2), { type: "cancelled", runId: "run-1", at: 3 }], evidenceClass: "component", elapsedMs: 3, packId: "pack-1", packSha256: hash, scopeSha256: hash, requiredUnitIds: ["unit-1", "unit-2", "unit-3"], originalConsumption: baselineInput().originalConsumption, originalSeatOutputs: baselineInput().seatOutputs });
    expect(wholeAudit.metrics.cancelledUnits).toBe(3);
    expect(wholeAudit.metrics.completedUnits).toBe(0);
    expect(wholeAudit.receipts.every((row) => row.jevWorkCredit === 0)).toBe(true);
  });
});
