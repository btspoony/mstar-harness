import { describe, expect, test } from "bun:test";
import { assessShadowRun, freezeBaseline, recordWorkUnitDisposition, type WorkUnitReceipt } from "../src/shadow-receipts.js";

const hash = "a".repeat(64);
const baselineInput = () => ({ runId: "run-1", inventory: [{ id: "unit-1", revision: 1 }], seatOutputs: [{ seat: "reviewer", output: "original" }], originalConsumption: { completedUnitIds: ["unit-1"], consumedOutputIds: ["output-1"] }, finalReport: { status: "complete" } });
const receipt = (disposition: WorkUnitReceipt["disposition"], unitId = "unit-1", scopeSha256 = hash) => recordWorkUnitDisposition({ runId: "run-1", unitId, packId: "pack-1", packSha256: hash, scopeSha256, disposition, originalConsumption: disposition === "completed" ? { outputId: "output-1", consumed: true } : null, attemptId: "attempt-1" });
const validEvents = [
  { type: "baseline-frozen", runId: "run-1", at: 0 },
  { type: "start", runId: "run-1", at: 1 },
  { type: "baseline-frozen", runId: "run-1", at: 2 },
  { type: "request", runId: "run-1", at: 3 },
  { type: "complete", runId: "run-1", at: 4 },
] as const;

describe("shadow baseline and work receipts", () => {
  test("freezes a detached, deeply immutable baseline and detects changed identity", () => {
    const input = baselineInput();
    const frozen = freezeBaseline(input);
    input.inventory[0]!.revision = 2;
    expect(frozen.inventory).toEqual([{ id: "unit-1", revision: 1 }]);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.inventory)).toBe(true);
    expect(Object.isFrozen((frozen.inventory as { revision?: number }[])[0])).toBe(true);
    expect(() => { ((frozen.inventory as { revision: number }[])[0]!).revision = 3; }).toThrow();
    const mutated = { ...frozen, inventory: [{ id: "unit-1", revision: 9 }] };
    expect(() => assessShadowRun({ baseline: mutated, receipts: [], childEvents: validEvents, evidenceClass: "component", elapsedMs: 1 })).toThrow("jev.baseline-tampered");
  });

  test("records completed only with consumed original evidence and retains all dispositions at zero Jev credit", () => {
    expect(() => recordWorkUnitDisposition({ runId: "run-1", unitId: "unit-1", packId: "pack-1", packSha256: hash, scopeSha256: hash, disposition: "completed", originalConsumption: null })).toThrow("jev.original-consumption-required");
    const rows = [receipt("completed"), receipt("blocked", "unit-2"), receipt("cancelled", "unit-3")];
    expect(rows.map((row) => row.disposition)).toEqual(["completed", "blocked", "cancelled"]);
    expect(rows.every((row) => row.owner === "original" && row.jevWorkCredit === 0)).toBe(true);
    expect(rows[0]?.originalConsumptionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]?.attemptId).toBe("attempt-1");
    expect(receipt("completed", "unit-1", "b".repeat(64)).scopeSha256).not.toBe(rows[0]?.scopeSha256);
  });

  test("rejects duplicate callbacks, keeps empty denominator at zero, and never promotes component evidence to W5", () => {
    const baseline = freezeBaseline(baselineInput());
    const duplicate = receipt("completed");
    expect(() => assessShadowRun({ baseline, receipts: [duplicate, duplicate], childEvents: validEvents, evidenceClass: "component", elapsedMs: 1 })).toThrow("jev.receipt-run-mismatch");
    const empty = assessShadowRun({ baseline, receipts: [], childEvents: validEvents, evidenceClass: "component", elapsedMs: 1 });
    expect(empty.metrics).toMatchObject({ completedUnits: 0, blockedUnits: 0, cancelledUnits: 0 });
    expect(empty.receipts).toEqual([]);
    expect(empty.w5).toBe(false);
    expect(empty.qualification).toBe("component-only");
    expect(() => assessShadowRun({ baseline, receipts: [], childEvents: validEvents, evidenceClass: "named-host", elapsedMs: 1 })).toThrow("jev.named-host-authorization-required");
  });

  test("binds receipt identity to pack and scope, and marks cancelled lifecycle as incomplete", () => {
    const baseline = freezeBaseline(baselineInput());
    const oldScope = receipt("blocked", "unit-1", hash);
    const changedScope = receipt("blocked", "unit-1", "b".repeat(64));
    expect(oldScope.scopeSha256).not.toBe(changedScope.scopeSha256);
    const cancelled = assessShadowRun({ baseline, receipts: [receipt("cancelled")], childEvents: [...validEvents.slice(0, 2), { type: "cancelled", runId: "run-1", at: 3 }], evidenceClass: "synthetic-offline", elapsedMs: 3 });
    expect(cancelled.failures).toContain("probe-lifecycle-invalid");
    expect(cancelled.metrics.cancelledUnits).toBe(1);
    expect(cancelled.w5).toBe(false);
  });
  test("preserves completed original baseline work on timeout and cancels the whole audit without Jev credit", () => {
    const baseline = freezeBaseline(baselineInput());
    const timeoutEvents = [...validEvents.slice(0, 4), { type: "error" as const, runId: "run-1", at: 5 }];
    const timedOut = assessShadowRun({ baseline, receipts: [receipt("completed")], childEvents: timeoutEvents, evidenceClass: "component", elapsedMs: 5, failures: ["timeout"] });
    expect(timedOut.metrics.completedUnits).toBe(1);
    expect(timedOut.failures).toContain("timeout");
    expect(timedOut.baselineFrozen).toBe(true);
    const cancellations = ["unit-1", "unit-2", "unit-3"].map((id) => receipt("cancelled", id));
    const cancelled = assessShadowRun({ baseline, receipts: cancellations, childEvents: [...validEvents.slice(0, 2), { type: "cancelled", runId: "run-1", at: 3 }], evidenceClass: "component", elapsedMs: 3 });
    expect(cancelled.metrics.cancelledUnits).toBe(3);
    expect(cancelled.metrics.completedUnits).toBe(0);
    expect(cancelled.receipts.every((row) => row.jevWorkCredit === 0)).toBe(true);
  });
});
