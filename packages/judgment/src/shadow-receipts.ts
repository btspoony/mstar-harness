import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "./review-advice.js";
import { NATIVE_MODEL } from "./contracts.js";

export type EvidenceClass = "component" | "synthetic-offline" | "named-host";
export type FrozenBaseline = Readonly<{
  schema: "mstar.shadow-baseline/v1";
  runId: string;
  frozenAt: string;
  inventory: unknown;
  inventorySha256: string;
  seatOutputsSha256: string;
  originalConsumptionSha256: string;
  finalReportSha256: string;
  baselineSha256: string;
}>;
export type WorkUnitReceipt = Readonly<{
  schema: "mstar.shadow-receipt/v1";
  runId: string;
  unitId: string;
  packId: string;
  packSha256: string;
  scopeSha256: string;
  model: typeof NATIVE_MODEL;
  owner: "original";
  disposition: "completed" | "blocked" | "cancelled";
  originalConsumptionSha256: string | null;
  attemptId: string | null;
  jevWorkCredit: 0;
}>;
export type ProbeEvent = Readonly<{ type: "start" | "baseline-frozen" | "request" | "complete" | "cancelled" | "error"; at: number; runId: string }>;
export type ShadowRunAssessment = Readonly<{
  schema: "mstar.shadow-assessment/v1";
  runId: string;
  evidenceClass: EvidenceClass;
  qualification: "component-only" | "synthetic-offline";
  w5: false;
  baselineFrozen: boolean;
  childEvents: readonly ProbeEvent[];
  receipts: readonly WorkUnitReceipt[];
  metrics: Readonly<{ childEvents: number; completedUnits: number; blockedUnits: number; cancelledUnits: number; elapsedMs: number; childOutputBytes: number }>;
  failures: readonly string[];
}>;
export type BaselineFreezeInput = Readonly<{ runId: string; inventory: unknown; seatOutputs: unknown; originalConsumption: unknown; finalReport: unknown }>;
export type WorkUnitDispositionInput = Readonly<{
  runId: string;
  unitId: string;
  packId: string;
  packSha256: string;
  scopeSha256: string;
  disposition: WorkUnitReceipt["disposition"];
  originalConsumption: unknown | null;
  attemptId?: string | null;
}>;
export type FrozenShadowEvidence = Readonly<{
  baseline: FrozenBaseline;
  receipts: readonly WorkUnitReceipt[];
  childEvents: readonly ProbeEvent[];
  evidenceClass: EvidenceClass;
  elapsedMs: number;
  childOutputBytes?: number;
  failures?: readonly string[];
}>;

const MAX_ARTIFACT_BYTES = 1_048_576;
const digest = (value: unknown): string => createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Takes a detached, deeply immutable snapshot of the original baseline before shadow evaluation. */
export function freezeBaseline(input: BaselineFreezeInput): FrozenBaseline {
  if (!validId(input.runId)) throw new Error("jev.baseline-run-invalid");
  const inventory = deepFreeze(structuredClone(input.inventory));
  const baseline = {
    schema: "mstar.shadow-baseline/v1" as const,
    runId: input.runId,
    frozenAt: new Date().toISOString(),
    inventory,
    inventorySha256: digest(input.inventory),
    seatOutputsSha256: digest(input.seatOutputs),
    originalConsumptionSha256: digest(input.originalConsumption),
    finalReportSha256: digest(input.finalReport),
  };
  return Object.freeze({ ...baseline, baselineSha256: digest(baseline) });
}

/** Records original-owner disposition; completed credit requires evidence that original output was consumed. */
export function recordWorkUnitDisposition(input: WorkUnitDispositionInput): WorkUnitReceipt {
  if (!validId(input.runId) || !validId(input.unitId) || !validId(input.packId) || !/^[a-f0-9]{64}$/.test(input.packSha256) || !/^[a-f0-9]{64}$/.test(input.scopeSha256)) throw new Error("jev.receipt-identity-invalid");
  if (input.disposition === "completed" && input.originalConsumption === null) throw new Error("jev.original-consumption-required");

  return Object.freeze({ schema: "mstar.shadow-receipt/v1", runId: input.runId, unitId: input.unitId, packId: input.packId, packSha256: input.packSha256, scopeSha256: input.scopeSha256, model: NATIVE_MODEL, owner: "original", disposition: input.disposition, originalConsumptionSha256: input.originalConsumption === null ? null : digest(input.originalConsumption), attemptId: input.attemptId ?? null, jevWorkCredit: 0 });
}

/** Verifies the frozen baseline and stable, unique original-work receipts before summarizing a run. */
export function assessShadowRun(input: FrozenShadowEvidence): ShadowRunAssessment {
  if (input.evidenceClass === "named-host") throw new Error("jev.named-host-authorization-required");
  if (input.evidenceClass !== "component" && input.evidenceClass !== "synthetic-offline") throw new Error("jev.evidence-class-invalid");
  const baseline = input.baseline;
  const expectedBaseline = digest({ schema: baseline.schema, runId: baseline.runId, frozenAt: baseline.frozenAt, inventory: baseline.inventory, inventorySha256: baseline.inventorySha256, seatOutputsSha256: baseline.seatOutputsSha256, originalConsumptionSha256: baseline.originalConsumptionSha256, finalReportSha256: baseline.finalReportSha256 });
  if (baseline.schema !== "mstar.shadow-baseline/v1" || !validId(baseline.runId) || baseline.baselineSha256 !== expectedBaseline) throw new Error("jev.baseline-tampered");
  if (!Array.isArray(input.childEvents) || input.childEvents.length > 257) throw new Error("jev.child-event-limit");
  const eventTypes = ["start", "baseline-frozen", "request", "complete", "cancelled", "error"] as const;
  const childEvents = input.childEvents.map((event) => {
    if (!event || event.runId !== baseline.runId || !eventTypes.includes(event.type) || !Number.isFinite(event.at) || event.at < 0) throw new Error("jev.child-event-invalid");
    return Object.freeze({ type: event.type, runId: event.runId, at: event.at });
  });
  const eventSequence = childEvents.map((event) => event.type);
  const lifecycleInvalid = eventSequence.some((type) => type === "cancelled" || type === "error") || eventSequence.join(",") !== "baseline-frozen,start,baseline-frozen,request,complete";
  if (!Array.isArray(input.receipts) || input.receipts.length > 256) throw new Error("jev.receipt-limit");
  const unitIds = new Set<string>();
  const receipts = input.receipts.map((receipt) => {
    if (!receipt || receipt.schema !== "mstar.shadow-receipt/v1" || receipt.runId !== baseline.runId || !validId(receipt.unitId) || !validId(receipt.packId) ||
        !/^[a-f0-9]{64}$/.test(receipt.packSha256) || !/^[a-f0-9]{64}$/.test(receipt.scopeSha256) || receipt.model !== NATIVE_MODEL ||
        receipt.owner !== "original" || !["completed", "blocked", "cancelled"].includes(receipt.disposition) || receipt.jevWorkCredit !== 0 ||
        receipt.disposition === "completed" && !/^[a-f0-9]{64}$/.test(receipt.originalConsumptionSha256 ?? "") ||
        receipt.originalConsumptionSha256 !== null && !/^[a-f0-9]{64}$/.test(receipt.originalConsumptionSha256) ||
        receipt.attemptId !== null && !validId(receipt.attemptId) || unitIds.has(receipt.unitId)) throw new Error("jev.receipt-run-mismatch");
    unitIds.add(receipt.unitId);
    return Object.freeze({ schema: receipt.schema, runId: receipt.runId, unitId: receipt.unitId, packId: receipt.packId, packSha256: receipt.packSha256, scopeSha256: receipt.scopeSha256, model: receipt.model, owner: receipt.owner, disposition: receipt.disposition, originalConsumptionSha256: receipt.originalConsumptionSha256, attemptId: receipt.attemptId, jevWorkCredit: 0 as const });
  });
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0 || input.elapsedMs > 86_400_000 || !Number.isSafeInteger(input.childOutputBytes ?? 0) || (input.childOutputBytes ?? 0) < 0 || (input.childOutputBytes ?? 0) > MAX_ARTIFACT_BYTES) throw new Error("jev.assessment-metrics-invalid");
  const failures = [...(lifecycleInvalid ? ["probe-lifecycle-invalid"] : []), ...(input.failures ?? [])].slice(0, 32).map((failure) => typeof failure === "string" ? failure.replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 96) : "jev.failure-invalid");
  return Object.freeze({ schema: "mstar.shadow-assessment/v1", runId: baseline.runId, evidenceClass: input.evidenceClass, qualification: input.evidenceClass === "component" ? "component-only" : "synthetic-offline", w5: false, baselineFrozen: true, childEvents: Object.freeze(childEvents), receipts: Object.freeze(receipts), metrics: Object.freeze({ childEvents: childEvents.length, completedUnits: receipts.filter((receipt) => receipt.disposition === "completed").length, blockedUnits: receipts.filter((receipt) => receipt.disposition === "blocked").length, cancelledUnits: receipts.filter((receipt) => receipt.disposition === "cancelled").length, elapsedMs: input.elapsedMs, childOutputBytes: input.childOutputBytes ?? 0 }), failures: Object.freeze(failures) });
}
