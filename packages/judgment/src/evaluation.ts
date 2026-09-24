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
export type CalibrationBand = Readonly<{ id: string; same: readonly [number, number]; different: readonly [number, number]; insufficient: readonly [number, number] }>;
export type CalibrationObservation = Readonly<{
  groupId: string;
  gold: GoldLabel;
  choice: A05Label | null;
  topProbability: number | null;
  confidence: number | null;
}>;
/** Provider-visible pair IDs must be opaque, never cohort/run/shard labels. */
export function developmentPairId(variantId: string): string {
  if (!/^[a-f0-9]{32}$/.test(variantId)) throw new TypeError("qualification.variant-identity-invalid");
  return `pair-${variantId}`;
}

/** The frozen development-only rule; no unobserved response can count toward an accepted decision. */
export function selectDevelopmentBand(
  observations: readonly CalibrationObservation[],
  candidates: readonly CalibrationBand[],
  minimumCorrectSame = 15,
): Readonly<{ band: CalibrationBand | null; candidates: readonly Readonly<{ id: string; acceptedCorrectSame: number; dangerousFalsePositives: number; acceptedDecisions: number; admissible: boolean }>[] }> {
  const groups = new Set<string>();
  for (const row of observations) {
    if (groups.has(row.groupId) || !row.groupId || !["same_cause", "different_cause", "insufficient_evidence", "unresolved"].includes(row.gold) ||
        row.choice !== null && !["same_cause", "different_cause", "insufficient_evidence"].includes(row.choice) ||
        row.choice !== null && (row.topProbability === null || row.confidence === null ||
          !Number.isFinite(row.topProbability) || !Number.isFinite(row.confidence) ||
          row.topProbability < 0 || row.topProbability > 1 || row.confidence < 0 || row.confidence > 1)) {
      throw new TypeError("qualification.calibration-observation-invalid");
    }
    groups.add(row.groupId);
  }
  let selected: CalibrationBand | null = null;
  let maximum = -1;
  const results = candidates.map((candidate) => {
    let acceptedCorrectSame = 0, dangerousFalsePositives = 0, acceptedDecisions = 0;
    for (const row of observations) {
      if (row.choice === null || row.topProbability === null || row.confidence === null || row.gold === "unresolved") continue;
      const thresholds = row.choice === "same_cause" ? candidate.same : row.choice === "different_cause" ? candidate.different : candidate.insufficient;
      if (row.topProbability < thresholds[0] || row.confidence < thresholds[1]) continue;
      if (row.choice === "same_cause") {
        if (row.gold === "same_cause") acceptedCorrectSame++;
        else dangerousFalsePositives++;
      }
      if (row.choice !== "insufficient_evidence") acceptedDecisions++;
    }
    const admissible = dangerousFalsePositives === 0 && acceptedCorrectSame >= minimumCorrectSame;
    if (admissible && acceptedDecisions >= maximum) {
      maximum = acceptedDecisions;
      selected = candidate; // Frozen candidates are ordered b0..b4; a tie takes the stricter band.
    }
    return { id: candidate.id, acceptedCorrectSame, dangerousFalsePositives, acceptedDecisions, admissible };
  });
  return { band: selected, candidates: results };
}

export type FreezeCorpusGroup = Readonly<{
  id: string;
  split: string;
  lineageId: string;
  causalClusterId: string;
  eligible?: boolean;
  quarantined?: boolean;
  quarantineReason?: string;
  variants: readonly Readonly<{ id: string; primary?: boolean }>[];
}>;

/** Validates the assignment denominator and reports only explicitly quarantined cross-cohort clusters. */
export type FreezeClusterCollision = Readonly<{ kind: "lineage" | "causal"; clusterId: string; groupIds: readonly string[] }>;
export function validateFreezeGroups(
  groups: readonly FreezeCorpusGroup[],
  assignments: Readonly<Record<string, unknown>>,
  quarantinedGroupIds: ReadonlySet<string> = new Set(),
): FreezeClusterCollision[] {
  const groupIds = new Set<string>();
  const lineages = new Map<string, Array<{ id: string; cohort: string }>>();
  const causalClusters = new Map<string, Array<{ id: string; cohort: string }>>();
  for (const group of groups) {
    if (!group || typeof group.id !== "string" || !group.id || groupIds.has(group.id) ||
        typeof group.lineageId !== "string" || !group.lineageId ||
        typeof group.causalClusterId !== "string" || !group.causalClusterId) {
      throw new TypeError("Freeze corpus group integrity failure");
    }
    groupIds.add(group.id);
    const cohort = assignments[group.id];
    if (cohort !== "development" && cohort !== "holdout" && cohort !== "temporal") {
      throw new TypeError("Freeze cohort assignment missing or invalid");
    }
    if (group.split !== cohort) throw new TypeError("Freeze corpus/split cohort mismatch");
    for (const [clusters, id] of [[lineages, group.lineageId], [causalClusters, group.causalClusterId]] as const) {
      const members = clusters.get(id) ?? [];
      members.push({ id: group.id, cohort });
      clusters.set(id, members);
    }
  }
  if (groups.length === 0 || Object.keys(assignments).length !== groupIds.size ||
      Object.keys(assignments).some((id) => !groupIds.has(id))) {
    throw new TypeError("Freeze group denominator incomplete or duplicated");
  }
  const quarantinedCollisions: FreezeClusterCollision[] = [];
  for (const [kind, clusters] of [["lineage", lineages], ["causal", causalClusters]] as const) {
    for (const [clusterId, members] of clusters) {
      if (new Set(members.map((member) => member.cohort)).size > 1) {
        if (members.some((member) => !quarantinedGroupIds.has(member.id))) {
          throw new TypeError("Freeze lineage/causal cluster crosses cohorts");
        }
        quarantinedCollisions.push({ kind, clusterId, groupIds: members.map((member) => member.id) });
      }
    }
  }
  return quarantinedCollisions;
}

export type FreezeQuarantine = Readonly<{
  excludedGroupIds?: readonly string[];
  collisions?: readonly Readonly<{
    kind?: string;
    groupIds?: readonly string[];
    sourceSlots?: readonly string[];
    rawLineageId?: string;
    rawCausalClusterId?: string;
    lineageId?: string;
    causalClusterId?: string;
    assignedCohorts?: Readonly<Record<string, unknown>>;
    reason?: string;
  }>[];
}>;

export type FreezeEligibleDenominators = Readonly<{
  developmentGroups?: number;
  holdoutGroups?: number;
  totalGroups?: number;
  developmentPrimaryCases?: number;
  holdoutPrimaryCases?: number;
  totalPrimaryCases?: number;
}>;

/** Checks the one protocol-declared collision and computes eligible counts separately from assignment counts. */
export function validateFreezeQuarantine(
  groups: readonly FreezeCorpusGroup[],
  assignments: Readonly<Record<string, unknown>>,
  quarantine: FreezeQuarantine | undefined,
  eligibleDenominators: FreezeEligibleDenominators | undefined,
): Set<string> {
  if (!quarantine || !Array.isArray(quarantine.excludedGroupIds) || quarantine.excludedGroupIds.length !== 2 ||
      new Set(quarantine.excludedGroupIds).size !== 2 || !Array.isArray(quarantine.collisions) || quarantine.collisions.length !== 1) {
    throw new TypeError("Freeze quarantine record missing or invalid");
  }
  const excluded = new Set(quarantine.excludedGroupIds);
  const collision = quarantine.collisions[0]!;
  if (collision.kind !== "lineage-and-causal" ||
      !Array.isArray(collision.groupIds) || collision.groupIds.length !== 2 ||
      new Set(collision.groupIds).size !== 2 || collision.groupIds.some((id: string) => !excluded.has(id)) ||
      !Array.isArray(collision.sourceSlots) ||
      collision.sourceSlots.length !== 2 ||
      !collision.sourceSlots.includes("shard-3/group-010") ||
      !collision.sourceSlots.includes("shard-4/group-025") ||
      collision.rawLineageId !== "lineage-library-reservation" ||
      collision.rawCausalClusterId !== "cluster-library-reservation" ||
      typeof collision.reason !== "string" || !collision.reason.trim()) {
    throw new TypeError("Freeze quarantine collision record invalid");
  }
  const byId = new Map(groups.map((group) => [group.id, group]));
  const cohortCounts = { development: 0, holdout: 0 };
  const eligibleGroups = { development: 0, holdout: 0 };
  const primaryCases = { development: 0, holdout: 0 };
  for (const [id, cohort] of Object.entries(assignments)) {
    if (cohort === "development" || cohort === "holdout") cohortCounts[cohort]++;
    const group = byId.get(id)!;
    const shouldBeExcluded = excluded.has(id);
    const invalidEligibility = shouldBeExcluded
      ? group.eligible !== false || group.quarantined !== true || group.quarantineReason !== collision.reason
      : group.eligible === false || group.quarantined === true || Boolean(group.quarantineReason);
    if (!Array.isArray(group.variants) || group.variants.length < 1 || group.variants.length > 2 ||
        group.variants.filter((variant) => variant.primary).length !== 1 || invalidEligibility) {
      throw new TypeError("Freeze quarantine corpus flags inconsistent");
    }
    if (shouldBeExcluded && cohort !== collision.assignedCohorts?.[id]) throw new TypeError("Freeze quarantine cohort changed");
    if (!shouldBeExcluded && group.quarantineReason) throw new TypeError("Freeze non-quarantine group has quarantine reason");
    if (!shouldBeExcluded && (cohort === "development" || cohort === "holdout")) {
      eligibleGroups[cohort]++;
      primaryCases[cohort] += group.variants.filter((variant) => variant.primary).length;
    }
  }
  const collisionGroups = collision.groupIds.map((id: string) => byId.get(id));
  if (excluded.size !== collision.groupIds.length || collisionGroups.some((group: FreezeCorpusGroup | undefined) => !group) ||
      collisionGroups.some((group: FreezeCorpusGroup | undefined) => !group || group.lineageId !== collision.lineageId || group.causalClusterId !== collision.causalClusterId) ||
      collisionGroups[0]!.split === collisionGroups[1]!.split ||
      !["development", "holdout"].includes(collision.assignedCohorts?.[collision.groupIds[0]!] as string) ||
      !["development", "holdout"].includes(collision.assignedCohorts?.[collision.groupIds[1]!] as string) ||
      Object.keys(collision.assignedCohorts ?? {}).length !== 2 ||
      cohortCounts.development !== 60 || cohortCounts.holdout !== 300 ||
      eligibleGroups.development !== 59 || eligibleGroups.holdout !== 299 ||
      primaryCases.development !== 59 || primaryCases.holdout !== 299) {
    throw new TypeError("Freeze assignment or eligible denominator mismatch");
  }
  if (!eligibleDenominators || eligibleDenominators.developmentGroups !== 59 ||
      eligibleDenominators.holdoutGroups !== 299 || eligibleDenominators.totalGroups !== 358 ||
      eligibleDenominators.developmentPrimaryCases !== 59 ||
      eligibleDenominators.holdoutPrimaryCases !== 299 || eligibleDenominators.totalPrimaryCases !== 358) {
    throw new TypeError("Freeze eligible denominator commitment mismatch");
  }
  return excluded;
}

/** Ensures each frozen gold case has one independent label from each seat. */
export function validateFreezeLabels(
  gold: readonly Readonly<{ itemId: string; groupId: string }>[],
  annotations: readonly Readonly<{ itemId: string; groupId: string; label: string; seat: "A" | "B" }>[],
): void {
  const goldByItem = new Map<string, string>();
  for (const row of gold) goldByItem.set(row.itemId, row.groupId);
  const labelsByItem = new Map<string, Set<string>>();
  for (const row of annotations) {
    if (!row || typeof row.itemId !== "string" || typeof row.groupId !== "string" ||
        !["same_cause", "different_cause", "insufficient_evidence"].includes(row.label) ||
        (row.seat !== "A" && row.seat !== "B") || goldByItem.get(row.itemId) !== row.groupId) {
      throw new TypeError("Freeze annotation integrity failure");
    }
    const seats = labelsByItem.get(row.itemId) ?? new Set<string>();
    if (seats.has(row.seat)) throw new TypeError("Freeze duplicate seat label");
    seats.add(row.seat);
    labelsByItem.set(row.itemId, seats);
  }
  if (gold.some((row) => labelsByItem.get(row.itemId)?.size !== 2)) {
    throw new TypeError("Freeze requires two seat labels per case");
  }
}

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
    if (row.outcome === "accepted" && (!row.rawLabel || row.rawLabel === "insufficient_evidence" || row.accepted !== true) ||
        row.outcome === "model-abstain" && row.rawLabel === "insufficient_evidence" && row.accepted ||
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
