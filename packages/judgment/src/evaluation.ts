import type { A05Label } from "./contracts.js";

export type OutcomeReason = "accepted" | "model-abstain" | "policy-abstain" | "transport-failure" | "invalid-response" | "insufficient-input" | "stale" | "budget" | "cancellation";
export type EvaluationOutcome = Readonly<{ bucket: "accepted" | "model-abstain" | "policy-abstain" | "transport-failure" | "invalid-response" | "unissued"; reason: OutcomeReason }>;
export type GoldLabel = A05Label | "unresolved";
export type QualificationRow = Readonly<{
  groupId: string;
  variantId: string;
  primary?: boolean;
  gold: GoldLabel;
  outcome: OutcomeReason;
  accepted: boolean;
  rawLabel?: A05Label;
  arm?: "A" | "B" | "C";
  lineageId?: string;
  causalClusterId?: string;
  language?: string;
  tags?: readonly string[];
  reducedPackSupport?: "sufficient" | "insufficient" | "unresolved";
  attempted?: boolean;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
}>;

const labels: Record<string, true> = { same_cause: true, different_cause: true, insufficient_evidence: true };
const unissued: Partial<Record<OutcomeReason, true>> = { "insufficient-input": true, stale: true, budget: true, cancellation: true };

/** Maps every issued or unissued ledger reason to exactly one protocol outcome bucket. */
export function classifyOutcome(reason: OutcomeReason): EvaluationOutcome {
  if (unissued[reason]) return Object.freeze({ bucket: "unissued", reason });
  if (reason === "accepted") return Object.freeze({ bucket: "accepted", reason });
  if (reason === "model-abstain") return Object.freeze({ bucket: "model-abstain", reason });
  if (reason === "policy-abstain") return Object.freeze({ bucket: "policy-abstain", reason });
  if (reason === "transport-failure") return Object.freeze({ bucket: "transport-failure", reason });
  return Object.freeze({ bucket: "invalid-response", reason });
}

function validateRows(rows: readonly QualificationRow[]): void {
  const variants = new Set<string>();
  let arm: QualificationRow["arm"];
  for (const row of rows) {
    if (!row || typeof row.groupId !== "string" || !row.groupId || typeof row.variantId !== "string" || !row.variantId || !Object.hasOwn(labels, row.gold) && row.gold !== "unresolved" ||
        !["accepted", "model-abstain", "policy-abstain", "transport-failure", "invalid-response", "insufficient-input", "stale", "budget", "cancellation"].includes(row.outcome) ||
        typeof row.accepted !== "boolean") throw new TypeError("qualification.row-invalid");
    if (row.arm !== undefined) {
      if (arm !== undefined && row.arm !== arm) throw new TypeError("qualification.arm-mixing");
      arm = row.arm;
    }
    const key = `${row.groupId}\0${row.variantId}`;
    if (variants.has(key)) throw new TypeError("qualification.duplicate-variant");
    variants.add(key);
    if (row.rawLabel !== undefined && !Object.hasOwn(labels, row.rawLabel)) throw new TypeError("qualification.label-invalid");
    const attributable = row.outcome === "accepted" || row.outcome === "model-abstain" || row.outcome === "policy-abstain";
    if (row.outcome === "accepted" && (!row.rawLabel || row.accepted !== true) ||
        row.outcome !== "accepted" && row.accepted === true ||
        !attributable && row.rawLabel !== undefined) throw new TypeError("qualification.acceptance-invalid");
  }
  const primaryCounts = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  for (const row of rows) {
    groupCounts.set(row.groupId, (groupCounts.get(row.groupId) ?? 0) + 1);
    if (row.primary === true) primaryCounts.set(row.groupId, (primaryCounts.get(row.groupId) ?? 0) + 1);
  }
  for (const group of groupCounts.keys()) {
    if ((primaryCounts.get(group) ?? 0) > 1) throw new TypeError("qualification.primary-duplicate");
    if (primaryCounts.get(group) !== 1) throw new TypeError("qualification.primary-required");
  }
  const groupLineages = new Map<string, string>();
  const groupClusters = new Map<string, string>();
  for (const row of rows) {
    for (const [map, value] of [[groupLineages, row.lineageId], [groupClusters, row.causalClusterId]] as const) {
      if (value === undefined) continue;
      const prior = map.get(value);
      if (prior !== undefined && prior !== row.groupId) throw new TypeError("qualification.group-leakage");
      map.set(value, row.groupId);
    }
  }
}

function ratio(successes: number, total: number): number | null { return total === 0 ? null : successes / total; }

// Regularized incomplete beta using a continued fraction; inverse by monotone bisection.
function betaFraction(a: number, b: number, x: number): number {
  const max = 200, epsilon = 3e-14, tiny = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= max; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < epsilon) return h;
  }
  throw new Error("qualification.beta-no-convergence");
}
function logGamma(z: number): number {
  const p = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = 0.9999999999998099;
  for (let i = 0; i < p.length; i++) x += p[i]! / (z + i + 1);
  const t = z + p.length - 0.5;
  return 0.9189385332046727 + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? bt * betaFraction(a, b, x) / a : 1 - bt * betaFraction(b, a, 1 - x) / b;
}
/** Exact one-sided 95% Clopper–Pearson lower confidence limit; null means undefined denominator. */
export function clopperPearsonLower(successes: number, total: number, alpha = 0.05): number | null {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || successes < 0 || total < 0 || successes > total || !(alpha > 0 && alpha < 1)) throw new RangeError("qualification.binomial-invalid");
  if (total === 0) return null;
  if (successes === 0) return 0;
  if (successes === total) return Math.pow(alpha, 1 / total);
  const a = successes, b = total - successes + 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export type QualificationSummary = Readonly<{
  revision: "phase3a-native-20260924";
  totals: Readonly<{ rows: number; groups: number; variants: number; attempts: number }>;
  outcomeCounts: Readonly<Record<EvaluationOutcome["bucket"], number>>;
  unissuedReasons: Readonly<Record<"insufficient-input" | "stale" | "budget" | "cancellation", number>>;
  rawResolvedAccuracy: Readonly<{ correct: number; total: number; value: number | null }>;
  policyUsefulAccuracy: Readonly<{ correct: number; total: number; value: number | null }>;
  confusion: Readonly<Record<string, number>>;
  endpoints: Readonly<{
    precision: Readonly<{ successes: number; total: number; value: number | null; lower95: number | null }>;
    usefulSameRecall: Readonly<{ successes: number; total: number; value: number | null; lower95: number | null }>;
    selectiveAccuracy: Readonly<{ successes: number; total: number; value: number | null; lower95: number | null }>;
  }>;
  bootstrap: Readonly<{
    method: "seeded-causal-cluster-bootstrap/v1";
    seed: number;
    replicates: number;
    clusters: number;
    endpoints: Readonly<Record<"precision" | "usefulSameRecall" | "selectiveAccuracy", Readonly<{ lower95: number | null; upper95: number | null }>>>;
  }>;
  unresolvedGold: number;
  reducedPackInadequacy: number;
  coverageRegression: number | null;
  coverageComplete: boolean;
  bMinusA: Readonly<{ credited: false; value: 0 }>;
}>;

/** Summarizes opportunity-preserving rows; primary metrics count one preselected variant per group. */
export function summarizeQualification(rows: readonly QualificationRow[], options: { originalUnitIds?: readonly string[]; aCoverage?: readonly string[]; bCoverage?: readonly string[]; cCoverage?: readonly string[] } = {}): QualificationSummary {
  validateRows(rows);
  const groups = new Set(rows.map((r) => r.groupId));
  const outcomeCounts: Record<EvaluationOutcome["bucket"], number> = { accepted: 0, "model-abstain": 0, "policy-abstain": 0, "transport-failure": 0, "invalid-response": 0, unissued: 0 };
  const unissuedReasons = { "insufficient-input": 0, stale: 0, budget: 0, cancellation: 0 };
  const confusion: Record<string, number> = {};
  let rawCorrect = 0, rawTotal = 0, precisionSuccess = 0, precisionTotal = 0, recallSuccess = 0, recallTotal = 0, selectiveSuccess = 0, selectiveTotal = 0;
  const primaryByGroup = new Map<string, QualificationRow>();
  for (const row of rows) if (row.primary === true) primaryByGroup.set(row.groupId, row);
  for (const row of rows) {
    const bucket = classifyOutcome(row.outcome);
    outcomeCounts[bucket.bucket]++;
    if (bucket.bucket === "unissued") unissuedReasons[row.outcome as keyof typeof unissuedReasons]++;
    if (row.gold !== "unresolved" && row.rawLabel !== undefined) {
      rawTotal++;
      if (row.rawLabel === row.gold) rawCorrect++;
      const key = `${row.gold}->${row.rawLabel}`;
      confusion[key] = (confusion[key] ?? 0) + 1;
    }
  }
  for (const row of primaryByGroup.values()) {
    if (row.gold === "unresolved") continue;
    if (row.gold === "same_cause") { recallTotal++; }
    if (row.outcome === "accepted" && row.accepted && row.rawLabel === "same_cause") {
      precisionTotal++;
      if (row.gold === "same_cause") { precisionSuccess++; recallSuccess++; }
    }
    if (row.outcome === "accepted" && row.accepted && (row.rawLabel === "same_cause" || row.rawLabel === "different_cause")) {
      selectiveTotal++;
      if (row.rawLabel === row.gold) selectiveSuccess++;
    }
  }

  let policyCorrect = 0, policyTotal = 0;
  for (const row of primaryByGroup.values()) if (row.gold !== "unresolved" && row.outcome === "accepted" && row.accepted && row.rawLabel !== undefined) {
    policyTotal++; if (row.rawLabel === row.gold) policyCorrect++;
  }
  const coverageComplete = options.originalUnitIds !== undefined && options.originalUnitIds.length > 0 && options.aCoverage !== undefined && options.bCoverage !== undefined && options.cCoverage !== undefined;
  let coverageRegression: number | null = null;
  if (coverageComplete) {
    const original = new Set(options.originalUnitIds);
    const missing = new Set<string>();
    for (const armCoverage of [options.aCoverage, options.bCoverage, options.cCoverage]) {
      const present = new Set(armCoverage);
      for (const id of original) if (!present.has(id)) missing.add(id);
    }
    coverageRegression = missing.size;
  }
  const seed = 0x51f15e, replicates = 2000;
  const clusterMap = new Map<string, QualificationRow[]>();
  for (const row of primaryByGroup.values()) {
    const cluster = row.causalClusterId ?? row.groupId;
    const members = clusterMap.get(cluster) ?? [];
    members.push(row);
    clusterMap.set(cluster, members);
  }
  const clusters = [...clusterMap.values()];
  let randomState = seed;
  const random = (): number => {
    randomState = (randomState + 0x6d2b79f5) | 0;
    let t = randomState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const bootstrapValues: Record<"precision" | "usefulSameRecall" | "selectiveAccuracy", number[]> = { precision: [], usefulSameRecall: [], selectiveAccuracy: [] };
  for (let i = 0; i < replicates && clusters.length > 0; i++) {
    let pS = 0, pN = 0, rS = 0, rN = 0, sS = 0, sN = 0;
    for (let j = 0; j < clusters.length; j++) for (const row of clusters[Math.floor(random() * clusters.length)]) {
      if (row.gold === "unresolved") continue;
      if (row.gold === "same_cause") rN++;
      if (row.outcome === "accepted" && row.accepted && row.rawLabel === "same_cause") {
        pN++; if (row.gold === "same_cause") { pS++; rS++; }
      }
      if (row.outcome === "accepted" && row.accepted && (row.rawLabel === "same_cause" || row.rawLabel === "different_cause")) {
        sN++; if (row.rawLabel === row.gold) sS++;
      }
    }
    const values = { precision: ratio(pS, pN), usefulSameRecall: ratio(rS, rN), selectiveAccuracy: ratio(sS, sN) };
    for (const key of Object.keys(values) as Array<keyof typeof values>) if (values[key] !== null) bootstrapValues[key].push(values[key]!);
  }
  const interval = (values: number[]) => {
    if (!values.length) return Object.freeze({ lower95: null, upper95: null });
    values.sort((a, b) => a - b);
    return Object.freeze({ lower95: values[Math.floor((values.length - 1) * 0.025)], upper95: values[Math.ceil((values.length - 1) * 0.975)] });
  };
  return Object.freeze({
    revision: "phase3a-native-20260924", totals: Object.freeze({ rows: rows.length, groups: groups.size, variants: rows.length, attempts: rows.filter((r) => r.attempted ?? ["accepted", "model-abstain", "policy-abstain", "transport-failure", "invalid-response"].includes(r.outcome)).length }),
    outcomeCounts: Object.freeze(outcomeCounts), unissuedReasons: Object.freeze(unissuedReasons),
    rawResolvedAccuracy: Object.freeze({ correct: rawCorrect, total: rawTotal, value: ratio(rawCorrect, rawTotal) }),
    policyUsefulAccuracy: Object.freeze({ correct: policyCorrect, total: policyTotal, value: ratio(policyCorrect, policyTotal) }),
    confusion: Object.freeze(confusion), endpoints: Object.freeze({
      precision: Object.freeze({ successes: precisionSuccess, total: precisionTotal, value: ratio(precisionSuccess, precisionTotal), lower95: clopperPearsonLower(precisionSuccess, precisionTotal) }),
      usefulSameRecall: Object.freeze({ successes: recallSuccess, total: recallTotal, value: ratio(recallSuccess, recallTotal), lower95: clopperPearsonLower(recallSuccess, recallTotal) }),
      selectiveAccuracy: Object.freeze({ successes: selectiveSuccess, total: selectiveTotal, value: ratio(selectiveSuccess, selectiveTotal), lower95: clopperPearsonLower(selectiveSuccess, selectiveTotal) }),
    }),
    bootstrap: Object.freeze({ method: "seeded-causal-cluster-bootstrap/v1", seed, replicates, clusters: clusters.length, endpoints: Object.freeze({ precision: interval(bootstrapValues.precision), usefulSameRecall: interval(bootstrapValues.usefulSameRecall), selectiveAccuracy: interval(bootstrapValues.selectiveAccuracy) }) }),
    unresolvedGold: rows.filter((r) => r.gold === "unresolved").length,
    reducedPackInadequacy: rows.filter((r) => r.reducedPackSupport === "insufficient").length,
    coverageRegression, coverageComplete, bMinusA: Object.freeze({ credited: false, value: 0 as const }),
  });
}
