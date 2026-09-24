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
  completedAt: number | null;
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
  metrics: Readonly<{ childEvents: number; workUnits: number; completedUnits: number; blockedUnits: number; cancelledUnits: number; incompleteUnits: number; elapsedMs: number; childOutputBytes: number }>;
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
  packId: string;
  packSha256: string;
  scopeSha256: string;
  requiredUnitIds: readonly string[];
  originalConsumption: unknown;
  originalSeatOutputs: unknown;
  childOutputBytes?: number;
  failures?: readonly string[];
}>;

const MAX_ARTIFACT_BYTES = 1_048_576;
const digest = (value: unknown): string => createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
function consumedOutputFor(value: unknown, unitId: string): Readonly<{ unitId: string; outputId: string; consumed: true; consumedAt: number }> | undefined {
  if (!value || typeof value !== "object" || !("consumedOutputs" in value) || !Array.isArray(value.consumedOutputs)) return undefined;
  const matches = value.consumedOutputs.filter((output): output is { unitId: string; outputId: string; consumed: true; consumedAt: number } =>
    !!output && typeof output === "object" && "unitId" in output && "outputId" in output && "consumed" in output && "consumedAt" in output &&
    output.unitId === unitId && validId(output.outputId) && output.consumed === true && typeof output.consumedAt === "number" && Number.isFinite(output.consumedAt) && output.consumedAt >= 0);
  return matches.length === 1 ? matches[0] : undefined;
}
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
  const consumption = input.originalConsumption;
  let completedAt: number | null = null;
  if (input.disposition === "completed") {
    if (consumption === null) throw new Error("jev.original-consumption-required");
    if (!consumption || typeof consumption !== "object" || !("unitId" in consumption) || !("consumedAt" in consumption) || consumption.unitId !== input.unitId ||
        typeof consumption.consumedAt !== "number" || consumedOutputFor({ consumedOutputs: [consumption] }, input.unitId) === undefined) throw new Error("jev.original-consumption-invalid");
    completedAt = Date.now();
    if (completedAt < consumption.consumedAt) throw new Error("jev.original-consumption-invalid");
  }
  return Object.freeze({ schema: "mstar.shadow-receipt/v1", runId: input.runId, unitId: input.unitId, packId: input.packId, packSha256: input.packSha256, scopeSha256: input.scopeSha256, model: NATIVE_MODEL, owner: "original", disposition: input.disposition, originalConsumptionSha256: consumption === null ? null : digest(consumption), completedAt, attemptId: input.attemptId ?? null, jevWorkCredit: 0 });
}

export function assessShadowRun(input: FrozenShadowEvidence): ShadowRunAssessment {
  if (input.evidenceClass === "named-host") throw new Error("jev.named-host-authorization-required");
  if (input.evidenceClass !== "component" && input.evidenceClass !== "synthetic-offline") throw new Error("jev.evidence-class-invalid");
  const baseline = input.baseline;
  const expectedBaseline = digest({ schema: baseline.schema, runId: baseline.runId, frozenAt: baseline.frozenAt, inventory: baseline.inventory, inventorySha256: baseline.inventorySha256, seatOutputsSha256: baseline.seatOutputsSha256, originalConsumptionSha256: baseline.originalConsumptionSha256, finalReportSha256: baseline.finalReportSha256 });
  if (baseline.schema !== "mstar.shadow-baseline/v1" || !validId(baseline.runId) || baseline.baselineSha256 !== expectedBaseline) throw new Error("jev.baseline-tampered");
  if (!validId(input.packId) || !/^[a-f0-9]{64}$/.test(input.packSha256) || !/^[a-f0-9]{64}$/.test(input.scopeSha256)) throw new Error("jev.receipt-identity-invalid");
  if (!Array.isArray(baseline.inventory) || baseline.inventory.length > 256) throw new Error("jev.baseline-inventory-invalid");
  const inventoryUnitIds: string[] = [];
  for (const unit of baseline.inventory) {
    if (!unit || typeof unit !== "object" || !("id" in unit) || !validId(unit.id) || inventoryUnitIds.includes(unit.id)) throw new Error("jev.baseline-inventory-invalid");
    inventoryUnitIds.push(unit.id);
  }
  if (!Array.isArray(input.requiredUnitIds) || input.requiredUnitIds.length > 256 || input.requiredUnitIds.some((id) => !validId(id)) || new Set(input.requiredUnitIds).size !== input.requiredUnitIds.length) throw new Error("jev.required-units-invalid");
  if (digest(input.originalConsumption) !== baseline.originalConsumptionSha256 || digest(input.originalSeatOutputs) !== baseline.seatOutputsSha256) throw new Error("jev.original-consumption-baseline-mismatch");
  const consumptionByUnit = new Map<string, Readonly<{ unitId: string; outputId: string; consumed: true; consumedAt: number }>>();
  for (const unitId of inventoryUnitIds) {
    const consumed = consumedOutputFor(input.originalConsumption, unitId);
    const outputExists = Array.isArray(input.originalSeatOutputs) && input.originalSeatOutputs.some((output) =>
      !!output && typeof output === "object" && "unitId" in output && "outputId" in output &&
      output.unitId === unitId && output.outputId === consumed?.outputId);
    if (consumed && outputExists) consumptionByUnit.set(unitId, consumed);
  }
  if (!Array.isArray(input.childEvents) || input.childEvents.length > 257) throw new Error("jev.child-event-limit");
  const eventTypes = ["start", "baseline-frozen", "request", "complete", "cancelled", "error"] as const;
  const childEvents = input.childEvents.map((event) => {
    if (!event || event.runId !== baseline.runId || !eventTypes.includes(event.type) || !Number.isFinite(event.at) || event.at < 0) throw new Error("jev.child-event-invalid");
    return Object.freeze({ type: event.type, runId: event.runId, at: event.at });
  });
  const eventSequence = childEvents.map((event) => event.type);
  const lifecycleInvalid = eventSequence.some((type) => type === "cancelled" || type === "error") || eventSequence.join(",") !== "start,baseline-frozen,request,complete";
  const unitIds = new Set<string>();
  const receipts = input.receipts.map((receipt) => {
    if (!receipt || receipt.schema !== "mstar.shadow-receipt/v1" || receipt.runId !== baseline.runId || !validId(receipt.unitId) || !validId(receipt.packId) ||
        !/^[a-f0-9]{64}$/.test(receipt.packSha256) || !/^[a-f0-9]{64}$/.test(receipt.scopeSha256) || receipt.model !== NATIVE_MODEL ||
        receipt.owner !== "original" || !["completed", "blocked", "cancelled"].includes(receipt.disposition) || receipt.jevWorkCredit !== 0 ||
        receipt.disposition === "completed" && (!/^[a-f0-9]{64}$/.test(receipt.originalConsumptionSha256 ?? "") || !Number.isFinite(receipt.completedAt)) ||
        receipt.disposition !== "completed" && receipt.completedAt !== null ||
        receipt.originalConsumptionSha256 !== null && !/^[a-f0-9]{64}$/.test(receipt.originalConsumptionSha256) ||
        receipt.attemptId !== null && !validId(receipt.attemptId) || unitIds.has(receipt.unitId)) throw new Error("jev.receipt-run-mismatch");
    if (receipt.packId !== input.packId || receipt.packSha256 !== input.packSha256 || receipt.scopeSha256 !== input.scopeSha256) throw new Error("jev.receipt-identity-stale");
    if (!inventoryUnitIds.includes(receipt.unitId) || !input.requiredUnitIds.includes(receipt.unitId)) throw new Error("jev.receipt-unit-unexpected");
    if (receipt.disposition === "completed") {
      const consumed = consumptionByUnit.get(receipt.unitId);
      if (!consumed || receipt.originalConsumptionSha256 !== digest(consumed) || receipt.completedAt! < consumed.consumedAt) throw new Error("jev.original-consumption-mismatch");
    }
    unitIds.add(receipt.unitId);
    return Object.freeze({ schema: receipt.schema, runId: receipt.runId, unitId: receipt.unitId, packId: receipt.packId, packSha256: receipt.packSha256, scopeSha256: receipt.scopeSha256, model: receipt.model, owner: receipt.owner, disposition: receipt.disposition, originalConsumptionSha256: receipt.originalConsumptionSha256, completedAt: receipt.completedAt, attemptId: receipt.attemptId, jevWorkCredit: 0 as const });
  });
  const unaccountedInventory = inventoryUnitIds.some((id) => !unitIds.has(id));
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0 || input.elapsedMs > 86_400_000 || !Number.isSafeInteger(input.childOutputBytes ?? 0) || (input.childOutputBytes ?? 0) < 0 || (input.childOutputBytes ?? 0) > MAX_ARTIFACT_BYTES) throw new Error("jev.assessment-metrics-invalid");
  const completedUnits = receipts.filter((receipt) => receipt.disposition === "completed").length;
  const blockedUnits = receipts.filter((receipt) => receipt.disposition === "blocked").length;
  const cancelledUnits = receipts.filter((receipt) => receipt.disposition === "cancelled").length;
  const incompleteUnits = inventoryUnitIds.length - completedUnits - blockedUnits - cancelledUnits;
  const failures = [...(lifecycleInvalid ? ["probe-lifecycle-invalid"] : []), ...(unaccountedInventory || input.requiredUnitIds.some((id) => !inventoryUnitIds.includes(id)) ? ["jev.receipt-accounting-incomplete"] : []), ...(input.failures ?? [])].slice(0, 32).map((failure) => typeof failure === "string" ? failure.replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 96) : "jev.failure-invalid");
  if (completedUnits + blockedUnits + cancelledUnits + incompleteUnits !== inventoryUnitIds.length) throw new Error("jev.receipt-accounting-invalid");
  return Object.freeze({ schema: "mstar.shadow-assessment/v1", runId: baseline.runId, evidenceClass: input.evidenceClass, qualification: input.evidenceClass === "component" ? "component-only" : "synthetic-offline", w5: false, baselineFrozen: true, childEvents: Object.freeze(childEvents), receipts: Object.freeze(receipts), metrics: Object.freeze({ childEvents: childEvents.length, workUnits: inventoryUnitIds.length, completedUnits, blockedUnits, cancelledUnits, incompleteUnits, elapsedMs: input.elapsedMs, childOutputBytes: input.childOutputBytes ?? 0 }), failures: Object.freeze(failures) });
}
