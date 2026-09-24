import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { MAX_RUN_RESERVED_INPUT_TOKENS, TOKEN_POLICY_METHOD, TOKEN_RESERVATION_PER_ATTEMPT } from "../src/contracts.js";
import { runShadowSupervisor, type ShadowRunInput } from "../src/shadow-supervisor.js";
import {
  validateFreezeGroups,
  validateFreezeLabels,
  validateFreezeQuarantine,
  summarizeQualification,
  type FreezeEligibleDenominators,
  type FreezeQuarantine,
  type QualificationRow,
} from "../src/evaluation.js";

const actions: Record<string, true> = { "check-protocol": true, "check-corpus": true, "check-annotations": true, "check-freeze": true, calibrate: true, holdout: true, report: true };
const REVISION = "phase3a-native-20260924";
function fail(message: string): never { throw new Error(message); }
function args(argv: readonly string[]): { action: string; root: string; shard?: string; seat?: string } {
  const [action, ...tail] = argv;
  if (!action || !Object.hasOwn(actions, action)) return fail("Usage: evaluate.ts <check-protocol|check-corpus|check-annotations|check-freeze|calibrate|holdout|report> --root <authorized-view> [--shard <id>] [--seat <A|B>]");
  let root: string | undefined, shard: string | undefined, seat: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const flag = tail[i], value = tail[++i];
    if (!value) return fail("Missing flag value");
    if (flag === "--root" && root === undefined) root = value;
    else if (flag === "--shard" && shard === undefined && action.startsWith("check-")) shard = value;
    else if (flag === "--seat" && seat === undefined && action === "check-annotations" && ["A", "B"].includes(value)) seat = value;
    else return fail("Invalid command arguments");
  }
  if (!root || !isAbsolute(root)) return fail("--root must be an explicit absolute authorized-view path");
  return { action, root: realpathSync(root), ...(shard ? { shard } : {}), ...(seat ? { seat } : {}) };
}
function readJson<T>(root: string, rel: string): T {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return fail("Invalid artifact path");
  const path = resolve(root, rel), canonical = realpathSync(path);
  const relPath = relative(root, canonical);
  if (relPath === ".." || relPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || !statSync(canonical).isFile() || statSync(canonical).size > 16_777_216) return fail("Artifact outside authorized root or exceeds limit");
  return JSON.parse(readFileSync(canonical, "utf8")) as T;
}
function readJsonLines<T>(root: string, rel: string): T[] {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return fail("Invalid artifact path");
  const path = resolve(root, rel), canonical = realpathSync(path), relPath = relative(root, canonical);
  if (relPath === ".." || relPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || !statSync(canonical).isFile() || statSync(canonical).size > 16_777_216) return fail("Artifact outside authorized root or exceeds limit");
  return readFileSync(canonical, "utf8").split(/\r?\n/).filter((line) => line.length > 0).map((line) => JSON.parse(line) as T);
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function fileDigest(root: string, rel: string): string {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return fail("Manifest path invalid");
  const path = resolve(root, rel), canonical = realpathSync(path), relPath = relative(root, canonical);
  if (relPath === ".." || relPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || !statSync(canonical).isFile()) return fail("Manifest path escapes authorized root");
  return digest(readFileSync(canonical));
}
type Manifest = { schema: string; contractRevision: string; files?: Array<{ path: string; sha256: string }> };
type Corpus = { groups: Array<{ id: string; split: string; sourceSlot?: string; lineageId: string; causalClusterId: string; eligible?: boolean; quarantined?: boolean; quarantineReason?: string; variants: Array<{ id: string; itemDigest?: string; sourceSha256?: string; primary?: boolean }> }> };
type Gold = Array<{ itemId: string; groupId: string; label: string; eligible?: boolean; quarantined?: boolean }>;
type Annotation = {
  itemId: string; groupId?: string; label: string; reducedPackSupport: { label: string; explanation?: string };
  sourceSha256: string; itemDigest: string; seat?: string; shard?: string | number; sessionId?: string; model?: string; assistance?: unknown;
  rationale: string; anchors?: readonly unknown[]; citations?: readonly unknown[];
};
type CorpusVariantRef = { groupId: string; itemDigest?: string; sourceSha256?: string };
type ValidatedAnnotation = Annotation & { groupId: string; seat: "A" | "B" };
function indexCorpusVariants(corpus: Corpus): Map<string, CorpusVariantRef> {
  if (!Array.isArray(corpus.groups)) fail("Freeze corpus groups missing");
  const variants = new Map<string, CorpusVariantRef>();
  for (const group of corpus.groups) {
    if (!group.id || !Array.isArray(group.variants)) fail("Freeze corpus variant integrity failure");
    for (const variant of group.variants) {
      if (!variant.id || variants.has(variant.id)) fail("Freeze corpus variant integrity failure");
      variants.set(variant.id, { groupId: group.id, itemDigest: variant.itemDigest, sourceSha256: variant.sourceSha256 });
    }
  }
  return variants;
}
function supportStatus(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "label" in value && typeof value.label === "string"
    ? value.label
    : undefined;
}
function validateAnnotationRow(
  row: Annotation,
  variants: ReadonlyMap<string, CorpusVariantRef>,
  seat: "A" | "B",
  shardIndex: number,
): ValidatedAnnotation {
  if (!row || typeof row.itemId !== "string" || !row.itemId ||
      !["same_cause", "different_cause", "insufficient_evidence"].includes(row.label) ||
      !/^[a-f0-9]{64}$/.test(row.itemDigest) || !/^[a-f0-9]{64}$/.test(row.sourceSha256) ||
      typeof row.rationale !== "string" || !row.rationale.trim()) fail("Annotation integrity failure: missing core field");
  const reducedPackSupport = supportStatus(row.reducedPackSupport);
  if (!["sufficient", "insufficient", "unresolved"].includes(reducedPackSupport ?? "") ||
      ("explanation" in row.reducedPackSupport &&
        (typeof row.reducedPackSupport.explanation !== "string" || !row.reducedPackSupport.explanation.trim()))) {
    fail("Annotation reduced-pack support missing or invalid");
  }
  const evidence = row.anchors ?? row.citations;
  if (!Array.isArray(evidence) || evidence.length === 0) fail("Annotation evidence anchors missing");
  const variant = variants.get(row.itemId);
  if (!variant) fail(`Annotation itemId missing from corpus: ${row.itemId}`);
  if (row.groupId !== undefined && row.groupId !== variant.groupId) fail(`Annotation group/corpus mismatch: ${row.itemId}`);
  if ((variant.itemDigest && variant.itemDigest !== row.itemDigest) ||
      (variant.sourceSha256 && variant.sourceSha256 !== row.sourceSha256)) fail(`Annotation digest/corpus mismatch: ${row.itemId}`);
  if (row.seat !== undefined) {
    const declaredSeat = /^(A|B)(?:\/([1-4]))?$/.exec(row.seat);
    if (!declaredSeat || declaredSeat[1] !== seat ||
        (declaredSeat[2] !== undefined && Number(declaredSeat[2]) !== shardIndex)) fail(`Annotation seat mismatch: ${row.itemId}`);
  }
  if (row.shard !== undefined) {
    const declaredShard = typeof row.shard === "number"
      ? (Number.isInteger(row.shard) ? row.shard : NaN)
      : /^[1-4]$/.test(row.shard) ? Number(row.shard) : NaN;
    if (declaredShard !== shardIndex) fail(`Annotation shard mismatch: ${row.itemId}`);
  }
  return { ...row, groupId: variant.groupId, seat };
}
function verifyFiles(root: string, manifest: Manifest): void {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("Manifest file commitments missing");
  const paths = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry.path || !/^[a-f0-9]{64}$/.test(entry.sha256) || paths.has(entry.path) || fileDigest(root, entry.path) !== entry.sha256) fail(`Artifact digest mismatch: ${entry.path}`);
    paths.add(entry.path);
  }
}
function assertRevision(value: { contractRevision?: string }): void { if (value.contractRevision !== REVISION) fail("Frozen revision mismatch"); }
export async function runEvaluationCommand(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { action, root, shard, seat } = args(argv);
    const protocol = readJson<Record<string, unknown>>(root, "protocol.json");
    if (action === "check-protocol") {
      if (protocol.schema !== "mstar.qualification-protocol/v1" || protocol.contractRevision !== REVISION || protocol.mode !== "shadow" || protocol.transport !== "native-typesafe") fail("Protocol contract mismatch");
      const budget = readJson<Record<string, unknown>>(root, "budget.json");
      assertRevision(budget as { contractRevision?: string });
      if (budget.attemptPolicy === undefined || budget.tokenPolicy === undefined) fail("Frozen budget policy missing");
      const permission = readJson<Record<string, unknown>>(root, "permission.json");
      assertRevision(permission as { contractRevision?: string });
      if (permission.status !== "synthetic-only-policy-declaration; not a self-authorizing pilot") fail("Permission declaration mismatch");
      const tokenPolicy = budget.tokenPolicy as Record<string, unknown> | null;
      const providerContextPolicy = tokenPolicy?.providerContextPolicy as Record<string, unknown> | null;
      if (!tokenPolicy || typeof tokenPolicy !== "object" || tokenPolicy.method !== TOKEN_POLICY_METHOD ||
          tokenPolicy.perAttemptReservation !== TOKEN_RESERVATION_PER_ATTEMPT || tokenPolicy.maxRunReservedInputTokens !== MAX_RUN_RESERVED_INPUT_TOKENS ||
          !providerContextPolicy || typeof providerContextPolicy !== "object" || Array.isArray(providerContextPolicy) ||
          Object.keys(providerContextPolicy).length !== 2 ||
          providerContextPolicy.localTokenizerEstimate !== false || providerContextPolicy.localPreflightContextFitClaim !== false) fail("Frozen provider-context reservation mismatch");
      const allocation = budget.requestAllocation as Record<string, unknown> | null;
      if (!allocation || allocation.developmentVariantCallsMax !== 120 || allocation.holdoutVariantCallsMax !== 600 ||
          allocation.temporalVariantCallsMax !== 48 || allocation.variantCallsMax !== 768 || allocation.selectedControlCallsMax !== 32 ||
          allocation.allocatedCallsMax !== 800 || allocation.unallocatedSafetyHeadroomNotRetries !== 200 || allocation.allRequestsMax !== 1_000 ||
          budget.maxPacksPerRun !== 1_000 || budget.maxTasksPerPack !== 4 || budget.maxPairsPerPack !== 4 ||
          budget.maxAttemptsPerRequest !== 1 || budget.maxConcurrentRequests !== 1 || budget.timeoutMsPerOperation !== 10_000 ||
          budget.maxRunOptionalElapsedMs !== 10_000_000 || budget.maxPackBytes !== 65_536 ||
          budget.maxOutboundRequestBytes !== 32_768 || budget.maxResponseBytes !== 65_536 ||
          typeof budget.attemptPolicy !== "string" || !budget.attemptPolicy.includes("No SDK retry")) fail("Frozen attempt caps mismatch");
      process.stdout.write(`${JSON.stringify({ action, status: "valid", revision: REVISION })}\n`);
      return 0;
    }
    const manifest = readJson<Manifest>(root, "manifest.json");
    if (manifest.schema !== "mstar.qualification-manifest/v1") fail("Qualification manifest schema mismatch");
    assertRevision(manifest);
    verifyFiles(root, manifest);
    if (action === "check-corpus") {
      const corpus = readJson<Corpus>(root, "corpus.json");
      const assignments = readJson<{ assignments: Record<string, unknown>; quarantine?: FreezeQuarantine; eligibleDenominators?: FreezeEligibleDenominators }>(root, "split-manifest.json");
      const excluded = validateFreezeQuarantine(corpus.groups, assignments.assignments, assignments.quarantine, assignments.eligibleDenominators);
      const collisions = validateFreezeGroups(corpus.groups, assignments.assignments, excluded);
      const groups = shard
        ? corpus.groups.filter((group) => group.sourceSlot?.startsWith(`shard-${shard}/`))
        : corpus.groups;
      if (shard && groups.length === 0) fail(`Corpus shard scope cannot be determined from corpus sourceSlot for shard ${shard}`);
      const assignmentCounts = {
        developmentGroups: Object.values(assignments.assignments).filter((cohort) => cohort === "development").length,
        holdoutGroups: Object.values(assignments.assignments).filter((cohort) => cohort === "holdout").length,
        totalGroups: Object.keys(assignments.assignments).length,
      };
      process.stdout.write(`${JSON.stringify({
        action,
        status: collisions.length ? "quarantined-collision" : "valid",
        scope: shard ? "shard" : "global",
        shard: shard ?? null,
        groups: groups.length,
        globalClosureChecked: true,
        assignmentCounts,
        eligibleDenominators: assignments.eligibleDenominators,
        quarantinedCollisions: collisions.map((collision) => ({
          ...collision,
          excludedGroupIds: assignments.quarantine?.excludedGroupIds,
          reason: assignments.quarantine?.collisions?.[0]?.reason,
          excludedFromEligibleDenominators: true,
          eligible: false,
        })),
      })}\n`);
      return 0;
    }
    if (action === "check-annotations") {
      const selectedSeat = seat ?? "A";
      if (selectedSeat !== "A" && selectedSeat !== "B") fail(`Invalid annotation seat: ${selectedSeat}`);
      const selectedShard = Number(shard ?? "1");
      const rows = readJsonLines<Annotation>(root, `annotations/${selectedSeat}-${selectedShard}.jsonl`);
      if (rows.length === 0) fail("Annotation shard is empty");
      const variants = indexCorpusVariants(readJson<Corpus>(root, "corpus.json"));
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.itemId)) fail(`Annotation duplicate itemId: ${row.itemId}`);
        seen.add(row.itemId);
        validateAnnotationRow(row, variants, selectedSeat, selectedShard);
      }
      const metadata = Object.fromEntries((["seat", "shard", "sessionId", "model", "assistance"] as const).map((key) => {
        const declared = rows.filter((row) => row[key] !== undefined).length;
        return [key, {
          status: declared === 0 ? "undeclared" : declared === rows.length ? "declared" : "mixed",
          declared,
          undeclared: rows.length - declared,
        }];
      }));
      process.stdout.write(`${JSON.stringify({ action, status: "valid", seat: selectedSeat, shard: selectedShard, annotations: rows.length, identityMetadata: metadata })}\n`);
      return 0;
    }
    if (action === "check-freeze") {
      const splitPath = "split-manifest.json";
      const goldPath = "gold/adjudicated.jsonl";
      const split = readJson<{
        schema?: string; contractRevision?: string; freezeId?: string; frozenAt?: string; assignments?: unknown; assignmentSha256?: string;
        goldSha256?: string; goldCount?: number; quarantine?: FreezeQuarantine; eligibleDenominators?: FreezeEligibleDenominators;
      }>(root, splitPath);
      assertRevision(split);
      if (split.schema !== "mstar.qualification-split-manifest/v1" ||
          typeof split.freezeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(split.freezeId) ||
          typeof split.frozenAt !== "string" || !Number.isFinite(Date.parse(split.frozenAt)) || new Date(split.frozenAt).toISOString() !== split.frozenAt ||
          split.assignments === null || typeof split.assignments !== "object" || Array.isArray(split.assignments) ||
          Object.keys(split.assignments as object).length === 0 ||
          !/^[a-f0-9]{64}$/.test(split.assignmentSha256 ?? "") || digest(Buffer.from(JSON.stringify(split.assignments))) !== split.assignmentSha256) fail("Split freeze commitment invalid");
      const corpus = readJson<Corpus>(root, "corpus.json");
      if (!Array.isArray(corpus.groups)) fail("Freeze corpus groups missing");
      const assignments = split.assignments as Record<string, unknown>;
      const excludedGroupIds = validateFreezeQuarantine(corpus.groups, assignments, split.quarantine, split.eligibleDenominators);
      validateFreezeGroups(corpus.groups, assignments, excludedGroupIds);
      const corpusVariants = indexCorpusVariants(corpus);
      const corpusGroups = new Map(corpus.groups.map((group) => [group.id, group]));
      const gold = readJsonLines<Gold[number]>(root, goldPath);
      const assignmentIds = new Set(Object.keys(split.assignments as Record<string, unknown>));
      const goldIds = new Set<string>();
      if (gold.length === 0 || split.goldCount !== gold.length || !/^[a-f0-9]{64}$/.test(split.goldSha256 ?? "") || fileDigest(root, goldPath) !== split.goldSha256) fail("Gold freeze commitment invalid");
      for (const row of gold) {
        const quarantined = excludedGroupIds.has(row.groupId);
        if (!row.itemId || !row.groupId || goldIds.has(row.itemId) || !assignmentIds.has(row.groupId) ||
            corpusVariants.get(row.itemId)?.groupId !== row.groupId ||
            !["same_cause", "different_cause", "insufficient_evidence", "unresolved"].includes(row.label) ||
            (quarantined && (row.eligible !== false || row.quarantined !== true)) ||
            (!quarantined && (row.eligible === false || row.quarantined === true))) fail("Gold freeze commitment invalid");
        goldIds.add(row.itemId);
      }
      const annotations: ValidatedAnnotation[] = [];
      for (const seat of ["A", "B"] as const) {
        for (let shardIndex = 1; shardIndex <= 4; shardIndex++) {
          const rows = readJsonLines<Annotation>(root, `annotations/${seat}-${shardIndex}.jsonl`);
          const seen = new Set<string>();
          for (const row of rows) {
            if (seen.has(row.itemId)) fail(`Annotation duplicate itemId: ${row.itemId}`);
            seen.add(row.itemId);
            annotations.push(validateAnnotationRow(row, corpusVariants, seat, shardIndex));
          }
        }
      }
      validateFreezeLabels(gold, annotations.filter((row) => goldIds.has(row.itemId)));
      const manifestPaths = new Set(manifest.files?.map((entry) => entry.path));
      const requiredPaths = [
        splitPath, goldPath, "corpus.json", "adjudication.jsonl",
        ...["A", "B"].flatMap((seat) => [1, 2, 3, 4].map((shardIndex) => `annotations/${seat}-${shardIndex}.jsonl`)),
        ...[1, 2, 3, 4].map((shardIndex) => `authoring/shard-${shardIndex}-provenance.json`),
      ];
      for (const requiredPath of requiredPaths) {
        if (!manifestPaths.has(requiredPath)) fail(`Freeze artifact digest missing: ${requiredPath}`);
      }
      const freeze = readJson<{
        manifestSha256?: string; sourceManifestSha256?: string; corpusSha256?: string; splitSha256?: string;
        goldSha256?: string; adjudicationSha256?: string; annotationSha256?: string;
      }>(root, "freeze.json");
      const manifestSha256 = fileDigest(root, "manifest.json");
      if (freeze.manifestSha256 !== manifestSha256 || freeze.sourceManifestSha256 !== manifestSha256) fail("Freeze manifest digest mismatch");
      if (freeze.corpusSha256 !== fileDigest(root, "corpus.json")) fail("Freeze corpus digest mismatch");
      if (freeze.splitSha256 !== fileDigest(root, splitPath)) fail("Freeze split digest mismatch");
      if (freeze.goldSha256 !== fileDigest(root, goldPath)) fail("Freeze gold digest mismatch");
      if (freeze.adjudicationSha256 !== fileDigest(root, "adjudication.jsonl")) fail("Freeze adjudication digest mismatch");
      const annotationCommitments = manifest.files
        ?.filter((entry) => /^annotations\/[AB]-[1-4]\.jsonl$/.test(entry.path))
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(({ path, sha256 }) => ({ path, sha256 }));
      if (!annotationCommitments || annotationCommitments.length !== 8 ||
          freeze.annotationSha256 !== digest(Buffer.from(JSON.stringify(annotationCommitments)))) fail("Freeze annotation digest mismatch");
      const annotationsByItem = new Map<string, Map<"A" | "B", ValidatedAnnotation>>();
      for (const annotation of annotations) {
        const seats = annotationsByItem.get(annotation.itemId) ?? new Map<"A" | "B", ValidatedAnnotation>();
        seats.set(annotation.seat, annotation);
        annotationsByItem.set(annotation.itemId, seats);
        if (!/^[a-f0-9]{64}$/.test(annotation.sourceSha256) || !/^[a-f0-9]{64}$/.test(annotation.itemDigest)) fail("Freeze annotation digest missing or invalid");
      }
      const adjudicationRows = readJsonLines<{
        itemId: string; groupId: string; labelA: string; labelB: string; sourceSha256: string; itemDigest: string;
        disposition: string; resolvedLabel: string; rationale: string; sourceEvidence: unknown[];
        eligible?: boolean; quarantined?: boolean;
      }>(root, "adjudication.jsonl");
      const adjudications = new Map<string, (typeof adjudicationRows)[number]>();
      for (const row of adjudicationRows) {
        if (!row.itemId || !row.groupId || adjudications.has(row.itemId) ||
            !["same_cause", "different_cause", "insufficient_evidence"].includes(row.labelA) ||
            !["same_cause", "different_cause", "insufficient_evidence"].includes(row.labelB) ||
            !/^[a-f0-9]{64}$/.test(row.sourceSha256) || !/^[a-f0-9]{64}$/.test(row.itemDigest) ||
            typeof row.rationale !== "string" || !row.rationale.trim() || !Array.isArray(row.sourceEvidence) || row.sourceEvidence.length === 0) fail("Freeze adjudication integrity failure");
        if (typeof row.disposition !== "string" || !row.disposition.trim()) fail("Freeze third-read disposition missing");
        if (!["resolved_gold", "resolved_insufficiency", "preserved_disagreement"].includes(row.disposition) ||
            !["same_cause", "different_cause", "insufficient_evidence", "unresolved"].includes(row.resolvedLabel)) fail("Freeze third-read disposition invalid");
        const quarantined = excludedGroupIds.has(row.groupId);
        if (quarantined ? row.eligible !== false || row.quarantined !== true : row.eligible === false || row.quarantined === true) {
          fail("Freeze adjudication quarantine flags inconsistent");
        }
        const seats = annotationsByItem.get(row.itemId);
        const annotationA = seats?.get("A"), annotationB = seats?.get("B");
        if (!annotationA || !annotationB || annotationA.groupId !== row.groupId || annotationB.groupId !== row.groupId ||
            annotationA.label !== row.labelA || annotationB.label !== row.labelB ||
            annotationA.sourceSha256 !== row.sourceSha256 || annotationB.sourceSha256 !== row.sourceSha256 ||
            annotationA.itemDigest !== row.itemDigest || annotationB.itemDigest !== row.itemDigest) fail("Freeze adjudication label or digest join mismatch");
        const dispositionMatches = row.disposition === "resolved_gold"
          ? row.resolvedLabel === "same_cause" || row.resolvedLabel === "different_cause"
          : row.disposition === "resolved_insufficiency"
            ? row.resolvedLabel === "insufficient_evidence"
            : row.resolvedLabel === "unresolved";
        if (!dispositionMatches) fail("Freeze third-read disposition conflicts with resolved label");
        const goldRow = gold.find((entry) => entry.itemId === row.itemId);
        if (!goldRow || goldRow.groupId !== row.groupId || goldRow.label !== row.resolvedLabel) fail("Freeze adjudication does not match gold");
        adjudications.set(row.itemId, row);
      }
      for (const row of gold) {
        const seats = annotationsByItem.get(row.itemId)!;
        const annotationA = seats.get("A")!, annotationB = seats.get("B")!;
        const needsAdjudication = excludedGroupIds.has(row.groupId) || annotationA.label !== annotationB.label ||
          supportStatus(annotationA.reducedPackSupport) !== "sufficient" || supportStatus(annotationB.reducedPackSupport) !== "sufficient";
        if (needsAdjudication && !adjudications.has(row.itemId)) fail(`Freeze third-read disposition missing: ${row.itemId}`);
      }
      for (const shardIndex of [1, 2, 3, 4]) {
        const origin = readJson<{ origin?: string }>(root, `authoring/shard-${shardIndex}-provenance.json`).origin ?? "";
        if (!/\bsynthetic\b/i.test(origin) ||
            !/\b(newly authored|written in this author session|source families written)\b/i.test(origin) ||
            !/\b(no|not|without|never)\b.{0,80}\b(old|explor(?:ed|atory)|historical)\s+fixtures?\b/i.test(origin)) {
          fail(`Cannot verify no old-fixture provenance: authoring/shard-${shardIndex}-provenance.json origin declaration missing`);
        }
      }
      process.stdout.write(`${JSON.stringify({ action, status: "valid", freezeId: split.freezeId, splitSha256: fileDigest(root, splitPath), goldSha256: split.goldSha256 })}\n`);
      return 0;
    }
    if (action === "calibrate" || action === "holdout") {
      const job = readJson<ShadowRunInput>(root, `${action}-run.json`);
      if (job.evidenceClass !== "synthetic-offline" || job.pilot.contractRevision !== REVISION) fail("Live evaluator requires a synthetic-only frozen runtime input");
      const result = await runShadowSupervisor(job);
      process.stdout.write(`${JSON.stringify({ action, status: result.failures.length ? "unavailable" : "recorded", w5: false, failures: result.failures.length })}\n`);
      return result.failures.length ? 1 : 0;
    }
    const ledger = readJson<QualificationRow[]>(root, "evaluation-rows.json");
    const summary = summarizeQualification(ledger);
    process.stdout.write(`${JSON.stringify({ action, summary })}\n`); return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "qualification evaluation failed"}\n`);
    return 2;
  }
}
if (import.meta.main) process.exitCode = await runEvaluationCommand();
