import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_RUN_RESERVED_INPUT_TOKENS, TOKEN_POLICY_METHOD, TOKEN_RESERVATION_PER_ATTEMPT, validatePack, validatePilot, type A05Label, type JudgmentPilot, type ReviewDecisionPack } from "../src/contracts.js";
import { buildA05Request, canonicalJsonBytes } from "../src/review-advice.js";
import { sendNativeRequest } from "../src/typesafe.js";
import { runShadowSupervisor, type ShadowRunInput } from "../src/shadow-supervisor.js";
import {
  validateFreezeGroups,
  validateFreezeLabels,
  validateFreezeQuarantine,
  summarizeQualification,
  selectDevelopmentBand,
  developmentPairId,
  type CalibrationBand,
  type CalibrationObservation,
  type FreezeEligibleDenominators,
  type FreezeQuarantine,
  type QualificationRow,
} from "../src/evaluation.js";

const actions: Record<string, true> = { "check-protocol": true, "check-corpus": true, "check-annotations": true, "check-freeze": true, "calibrate-preflight": true, calibrate: true, holdout: true, report: true };
const REVISION = "phase3a-native-20260924";
const CALIBRATION_RUNTIME = "/mnt/source/.runtime";
export const calibrationCliInvocation = Object.freeze([
  "/usr/local/bin/node", `${CALIBRATION_RUNTIME}/mstar-harness.js`, "judgment", "review-advice",
  "--file", `${CALIBRATION_RUNTIME}/pack.json`, "--pilot", `${CALIBRATION_RUNTIME}/pilot.json`,
  "--workspace", "/mnt/source", "--json",
]);
function fail(message: string): never { throw new Error(message); }
function args(argv: readonly string[]): { action: string; root: string; shard?: string; seat?: string } {
  const [action, ...tail] = argv;
  if (!action || !Object.hasOwn(actions, action)) return fail("Usage: evaluate.ts <check-protocol|check-corpus|check-annotations|check-freeze|calibrate-preflight|calibrate|holdout|report> --root <authorized-view>");
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
type Corpus = { groups: Array<{ id: string; split: string; sourceSlot?: string; lineageId: string; causalClusterId: string; eligible?: boolean; quarantined?: boolean; quarantineReason?: string; variants: Array<{ id: string; sourceVariant?: string; itemDigest?: string; sourceSha256?: string; primary?: boolean }> }> };
type Gold = Array<{ itemId: string; groupId: string; label: string; eligible?: boolean; quarantined?: boolean }>;
type Annotation = {
  itemId: string; groupId?: string; label: string; reducedPackSupport: unknown;
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
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const support = value as Record<string, unknown>;
  const status = support.status;
  const label = support.label;
  if (status !== undefined && label !== undefined && status !== label) return undefined;
  const normalized = status ?? label;
  if (typeof normalized !== "string" ||
      (support.explanation !== undefined &&
        (typeof support.explanation !== "string" || !support.explanation.trim()))) return undefined;
  return normalized;
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
  if (!["sufficient", "insufficient", "unresolved"].includes(reducedPackSupport ?? "")) {
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
function providerContextDeclaration(value: unknown): { totalContext: number; stateContext: number; model: string; localTokenizerEstimate: false; localPreflightContextFitClaim: false } {
  if (typeof value !== "string") fail("Frozen provider-context declaration must be a string");
  const match = /^(\d+)k total context and (\d+)k state plus longest question per documented (jev-[\d.]+) accepted request; provider enforces context, no local tokenizer\/preflight context-fit claim$/.exec(value);
  if (!match) fail("Frozen provider-context declaration is missing or contradictory");
  const declaration = {
    totalContext: Number(match[1]) * 1_024,
    stateContext: Number(match[2]) * 1_024,
    model: match[3]!,
    localTokenizerEstimate: false as const,
    localPreflightContextFitClaim: false as const,
  };
  if (declaration.totalContext !== 65_536 || declaration.stateContext !== 32_768 || declaration.model !== "jev-1.13.0") {
    fail("Frozen provider-context capacity or model mismatch");
  }
  return declaration;
}
type DevelopmentVariant = { id: string; sourceVariant: string; primary: boolean; itemDigest: string; sourceSha256: string };
type DevelopmentGroup = { id: string; sourceSlot: string; lineageId: string; causalClusterId: string; variants: DevelopmentVariant[] };
type SyntheticCitation = { sourceRef: string; startLine: number; endLine: number; excerpt: string };
type SyntheticSide = { id: string; claim: string; citations?: Array<SyntheticCitation | { path: string; startLine: number; endLine: number; excerpt: string }>; evidence?: Array<{ file: string; startLine: number; endLine: number; excerpt: string }> };
type SyntheticFile = { sha256: string; text?: string; content?: string };
type SyntheticGroup = { id: string; sourceFiles?: Record<string, SyntheticFile>; files?: Record<string, SyntheticFile>; variants: Array<{ id: string; left: SyntheticSide; right: SyntheticSide }> };

function developmentCitations(side: SyntheticSide, files: Record<string, SyntheticFile>): SyntheticCitation[] | null {
  if (side.citations && side.evidence) return null;
  const raw = side.citations ?? side.evidence;
  const items = raw?.map((item) => ({
    sourceRef: "sourceRef" in item ? item.sourceRef : "file" in item ? item.file : item.path,
    startLine: item.startLine, endLine: item.endLine, excerpt: item.excerpt,
  }));
  if (!Array.isArray(items) || !items.length ||
      items.some((item) => !files[item.sourceRef] || !Number.isInteger(item.startLine) ||
        !Number.isInteger(item.endLine) || item.startLine < 1 || item.endLine < item.startLine ||
        typeof item.excerpt !== "string" || !item.excerpt ||
        !(files[item.sourceRef]!.text ?? files[item.sourceRef]!.content)?.includes(item.excerpt))) return null;
  return items;
}

export const calibrationBaselineInventory = (unitId: string) => [{ id: unitId, synthetic: true }];

export function stageCalibrationSources(
  sourceDir: string,
  sources: ReviewDecisionPack["sources"],
  files: Readonly<Record<string, { text?: string; content?: string }>>,
): void {
  const root = resolve(sourceDir);
  const staged = sources.map((source) => {
    const content = files[source.path]?.text ?? files[source.path]?.content;
    if (content === undefined) fail("Development source content missing");
    const destination = resolve(root, source.path);
    const relativeDestination = relative(root, destination);
    if (relativeDestination === ".." || relativeDestination.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativeDestination)) {
      fail("jev.calibration-source-path-outside-root");
    }
    return { destination, content };
  });
  for (const { destination, content } of staged) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, content, { flag: "wx", mode: 0o400 });
  }
}

async function calibrateDevelopment(root: string, protocol: Record<string, unknown>, preflightOnly = false): Promise<{ status: string; attempted: number; succeeded: number; failed: number; runId?: string; checked?: number }> {
  const previousManifest = readJson<{ runId: string; plannedVariants: number; identity: { cliSha256: string }; protocolSha256: string; splitSha256: string; goldSha256: string }>(root, "runs/development/run-manifest.json");
  const previousOutcomes = readJson<{ outcomes: Array<{ runId: string; requestSha256: string | null }> }>(root, "development-run.json").outcomes;
  const spentIds = new Set(previousOutcomes.map((outcome) => outcome.runId));
  const spentRequests = new Set(previousOutcomes.map((outcome) => outcome.requestSha256).filter((hash): hash is string => hash !== null));
  const runIdentity = `q-${randomUUID()}`;
  const evidence = resolve(root, "runs/development", runIdentity);
  if (existsSync(evidence)) fail("Development run identity already exists; no replay");
  if (await runEvaluationCommand(["check-protocol", "--root", root]) !== 0 ||
      await runEvaluationCommand(["check-freeze", "--root", root]) !== 0) fail("Development admission checks failed");
  const permission = readJson<Record<string, unknown>>(root, "permission.json");
  const budget = readJson<Record<string, any>>(root, "budget.json");
  const freeze = readJson<Record<string, unknown>>(root, "freeze.json");
  if (permission.status !== "synthetic-only-policy-declaration; not a self-authorizing pilot" ||
      permission.dataClass !== "newly authored synthetic source claims and bounded literal evidence excerpts only" ||
      permission.endpoint !== protocol.providerEndpoint || permission.model !== protocol.requestedModel ||
      permission.mode !== "shadow" || permission.transport !== "native-typesafe" ||
      !permission.authorizedBy || !permission.permissionRef || !permission.isolation) fail("Synthetic run permission cannot be bound");
  const split = readJson<{ freezeId: string; assignments: Record<string, string>; quarantine: FreezeQuarantine }>(root, "split-manifest.json");
  const corpus = readJson<Corpus>(root, "corpus.json");
  const excluded = new Set(split.quarantine.excludedGroupIds);
  const development = corpus.groups.filter((group) => split.assignments[group.id] === "development");
  if (development.length !== 60 || development.filter((group) => !excluded.has(group.id)).length !== 59) fail("Development denominator is not frozen");
  const groups: DevelopmentGroup[] = development.filter((group) => !excluded.has(group.id)).map((group) => {
    if (!group.sourceSlot || !group.variants.every((variant) => variant.sourceVariant && variant.itemDigest && variant.sourceSha256 && typeof variant.primary === "boolean")) fail("Development projection lacks frozen variant identity");
    return { id: group.id, sourceSlot: group.sourceSlot, lineageId: group.lineageId,
      causalClusterId: group.causalClusterId, variants: group.variants as DevelopmentVariant[] };
  });
  const variantIds = new Set(groups.flatMap((group) => group.variants.map((variant) => variant.id)));
  const gold = new Map<string, { groupId: string; label: string }>();
  // Filter by opaque development item ID before parsing gold; no holdout label enters the tuner view.
  for (const line of readFileSync(resolve(root, "gold/adjudicated.jsonl"), "utf8").split(/\r?\n/)) {
    const item = /^{"itemId":"([^"]+)"/.exec(line)?.[1];
    if (item && variantIds.has(item)) gold.set(item, JSON.parse(line));
  }
  if (gold.size !== variantIds.size) fail("Development gold projection incomplete");
  const sourceSlots = new Set(groups.map((group) => group.sourceSlot));
  const sources = new Map<string, SyntheticGroup>();
  for (let shard = 1; shard <= 4; shard++) {
    for (const line of readFileSync(resolve(root, `sources/shard-${shard}.jsonl`), "utf8").split(/\r?\n/)) {
      const slot = /^{"id":"([^"]+)"/.exec(line)?.[1];
      if (slot && sourceSlots.has(slot)) sources.set(slot, JSON.parse(line));
    }
  }
  if (sources.size !== sourceSlots.size || groups.some((group) => group.variants.some((variant) => gold.get(variant.id)?.groupId !== group.id))) fail("Development source/gold join invalid");
  const planned = groups.flatMap((group) => group.variants.map((variant) => ({ group, variant, original: sources.get(group.sourceSlot)?.variants.find((entry) => entry.id === variant.sourceVariant) })));
  if (planned.length > budget.requestAllocation.developmentVariantCallsMax || planned.some((entry) => !entry.original)) fail("Development requests exceed reservation or lack frozen source");

  const checkout = resolve(fileURLToPath(import.meta.url), "../../../..");
  const cliPath = resolve(checkout, "packages/cli/dist/mstar-harness.js");
  const packagePath = resolve(checkout, "packages/cli/package.json");
  if (!existsSync(cliPath) || !statSync(cliPath).isFile()) fail("Packaged native CLI is absent; build packages/cli first");
  const cliSha256 = digest(readFileSync(cliPath));
  const packageVersion = JSON.parse(readFileSync(packagePath, "utf8")).version as string;
  const cliVersion = execFileSync(process.execPath, [cliPath, "--version"], { encoding: "utf8" }).trim();
  if (typeof process.env.TYPESAFE_API_KEY !== "string" || !process.env.TYPESAFE_API_KEY) fail("jev.credential-unavailable");
  const dockerPath = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
  const baseImageTag = "jev-shadow-reviewer:iter-20260924-jev-3a";
  const baseImage = execFileSync(dockerPath, ["image", "inspect", baseImageTag, "--format", "{{.Id}}"], { encoding: "utf8" }).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(baseImage)) fail("Pinned sandbox base image unavailable");
  const imageDigest = execFileSync(dockerPath, ["build", "--pull=false", "--network=none", "-q", "-"], {
    input: `FROM ${baseImageTag}\nENTRYPOINT []\n`, encoding: "utf8",
  }).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest) ||
      execFileSync(dockerPath, ["image", "inspect", baseImageTag, "--format", "{{.Id}}"], { encoding: "utf8" }).trim() !== baseImage) {
    fail("Approved CLI sandbox image changed during build");
  }

  const candidates = (protocol.calibration as { candidates: CalibrationBand[]; selection: string }).candidates;
  if (!Array.isArray(candidates) || candidates.length !== 5 || candidates.some((candidate, index) => candidate.id !== `b${index}`)) fail("Frozen calibration candidates invalid");
  if (!preflightOnly) mkdirSync(evidence, { mode: 0o700 });
  const identity = { cliPath, cliVersion, packageVersion, cliSha256, builderSha256: cliSha256, imageDigest, model: protocol.requestedModel, revision: REVISION };
  const manifest = {
    schema: "mstar.qualification-development-manifest/v1", runId: runIdentity, identity,
    protocolSha256: fileDigest(root, "protocol.json"), permissionSha256: fileDigest(root, "permission.json"),
    budgetSha256: fileDigest(root, "budget.json"), freezeSha256: fileDigest(root, "freeze.json"),
    splitSha256: freeze.splitSha256, goldSha256: freeze.goldSha256,
    cohort: "development", assignedGroups: 60, eligibleGroups: 59, plannedVariants: planned.length,
    maxCalls: budget.requestAllocation.developmentVariantCallsMax, maxAttemptsPerRequest: 1,
    tokenReservationPerAttempt: budget.tokenPolicy.perAttemptReservation,
    knownHoldoutLimitation: "missing-caller-or-branch: 6 eligible groups versus frozen floor 14; Q7 endpoint inconclusive",
    previousRunId: previousManifest?.runId ?? null,
    previousBuildSha256: previousManifest?.identity.cliSha256 ?? null,
  };
  if (previousManifest.plannedVariants !== planned.length ||
      previousManifest.protocolSha256 !== manifest.protocolSha256 ||
      previousManifest.splitSha256 !== manifest.splitSha256 ||
      previousManifest.goldSha256 !== manifest.goldSha256) fail("Development freeze identity changed");
  if (!preflightOnly) writeFileSync(resolve(evidence, "run-manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
  const observations = new Map<string, CalibrationObservation>();
  const outcomes: Array<Record<string, unknown>> = [];
  let attempted = 0, succeeded = 0, failed = 0, cliSubmissions = 0, shadowFailures = 0;
  const worker = `import { spawnSync } from "node:child_process";
const runId=process.argv[2], start=Date.now(), runtime="${CALIBRATION_RUNTIME}";
process.chdir(runtime);
const event=type=>process.stdout.write(JSON.stringify({type,runId,at:Date.now()-start})+"\\n");
event("start"); event("baseline-frozen"); event("request");
const child=spawnSync("/usr/local/bin/node",[runtime+"/mstar-harness.js","judgment","review-advice","--file",runtime+"/pack.json","--pilot",runtime+"/pilot.json","--workspace","/mnt/source","--json"],{encoding:"utf8",timeout:9500,maxBuffer:8192,env:process.env});
let status; try { status=JSON.parse(child.stdout).status; } catch {}
event(status==="recorded"?"complete":"error");
process.exit(status==="recorded"&&child.status===0?0:1);
`;
  let checked = 0;
  for (let index = 0; index < planned.length; index++) {
    const { group, variant, original } = planned[index]!;
    const runId = `q-${randomUUID()}`;
    if (spentIds.has(runId)) fail("Previous request identity cannot be replayed");
    const itemRoot = resolve(evidence, runId);
    const oldOutcomePath = resolve(itemRoot, "outcome.json");
    const sourceDir = resolve(itemRoot, "source");
    const outputDir = resolve(itemRoot, "ordinary-output");
    const requestDir = resolve(itemRoot, "requests");
    const scratchDir = resolve(itemRoot, "scratch");
    const evaluatorDir = resolve(itemRoot, "evaluator");
    const statusPath = resolve(itemRoot, "status.json");
    const source = sources.get(group.sourceSlot)!;
    const files = source.sourceFiles ?? source.files;
    if (!files || source.sourceFiles && source.files) fail("Development source file inventory ambiguous");
    const leftCitations = original && developmentCitations(original.left, files);
    const rightCitations = original && developmentCitations(original.right, files);
    if (!leftCitations || !rightCitations) {
      const unissued = { groupId: group.id, variantId: variant.id, primary: variant.primary, runId,
        status: "unissued", reason: "insufficient-input", requestSha256: null, responseSha256: null };
      observations.set(variant.id, { groupId: group.id, gold: gold.get(variant.id)!.label as CalibrationObservation["gold"],
        choice: null, topProbability: null, confidence: null });
      outcomes.push(unissued);
      if (!preflightOnly) {
        mkdirSync(itemRoot, { recursive: true, mode: 0o700 });
        writeFileSync(oldOutcomePath, JSON.stringify(unissued), { flag: "wx", mode: 0o600 });
      }
      continue;
    }
    const pair = original!;
    const citations = [...leftCitations, ...rightCitations];
    const packSources = [...new Set(citations.map((citation) => citation.sourceRef))].map((path, i) => ({
      id: `s${i}`, path, startLine: 1, endLine: (files[path]!.text ?? files[path]!.content)!.split("\n").length,
      contentSha256: files[path]!.sha256, observedInRunId: runId, basis: "snapshot" as const,
    }));
    const sourceIdByPath = new Map(packSources.map((entry) => [entry.path, entry.id]));
    const evidenceItems = citations.map((citation, i) => ({ id: `e${i}`, sourceId: sourceIdByPath.get(citation.sourceRef)!, excerpt: citation.excerpt }));
    const leftIds = leftCitations.map((_, i) => `e${i}`);
    const rightIds = rightCitations.map((_, i) => `e${leftIds.length + i}`);
    const scope = { kind: "review" as const, reviewId: runId, snapshotSha256: variant.sourceSha256!, diffSha256: variant.itemDigest! };
    const rubricVersion = (protocol.rubric as { questionCanonicalJsonSha256: string }).questionCanonicalJsonSha256;
    const taskId = developmentPairId(variant.id);
    const leftId = `left-${variant.id}`, rightId = `right-${variant.id}`;
    const pack: ReviewDecisionPack = validatePack({
      schema: "mstar.review-advice-pack/v1", contractRevision: REVISION, runId, packId: `pack-${runId}`,
      concernId: group.id, profile: "review", scope: { ...scope, tier: "default" }, recipient: { id: "synthesis", phase: "synthesis" },
      sources: packSources, state: { evidence: evidenceItems, subjects: [
        { id: leftId, kind: "finding", text: pair.left.claim, evidenceIds: leftIds },
        { id: rightId, kind: "finding", text: pair.right.claim, evidenceIds: rightIds },
      ] }, tasks: [{ id: taskId, useCase: "JEV-A05", subjectIds: [leftId, rightId], workUnit: { id: `unit-${runId}`, revision: 0 } }],
      rubricVersion, builderVersion: cliSha256,
    });
    const packSha256 = digest(canonicalJsonBytes(pack));
    const pilot: JudgmentPilot = validatePilot({
      schema: "mstar.judgment-pilot/v1", contractRevision: REVISION, pilotId: `pilot-${runId}`, runId, profile: "review", scope,
      mode: "shadow", transport: "native-typesafe", endpoint: protocol.providerEndpoint, model: protocol.requestedModel,
      useCases: ["JEV-A05"], recipients: [{ id: "synthesis", phase: "synthesis" }],
      policyVersion: (protocol.identities as { policy: { id: string } }).policy.id,
      permission: { ref: "permission.json", purpose: permission.purpose, dataClass: "synthetic-only" },
      isolation: { ref: "run-manifest.json#docker-mount-plan" }, packManifest: [{ packId: pack.packId, packSha256 }],
      rubricVersion, builderVersion: cliSha256, implementationVersion: `${packageVersion}:${cliSha256}`,
      limits: { timeoutMs: budget.timeoutMsPerOperation, maxRunElapsedMs: budget.maxRunOptionalElapsedMs,
        maxCallsPerRun: 1, maxConcurrentRequests: 1, maxTasksPerPack: 1, maxPacksPerRun: 1, maxPairs: 1,
        maxPackBytes: budget.maxPackBytes, maxRequestBytes: budget.maxOutboundRequestBytes,
        maxResponseBytes: budget.maxResponseBytes, maxAttempts: 1 },
      tokenPolicy: { method: TOKEN_POLICY_METHOD, perAttemptReservation: TOKEN_RESERVATION_PER_ATTEMPT,
        maxRunReservedInputTokens: TOKEN_RESERVATION_PER_ATTEMPT },
      sourcePolicy: { minimization: "bounded synthetic pair claims and cited excerpts only", retention: String(permission.retention) },
      protocolVersion: REVISION, splitId: split.freezeId, calibrationId: runIdentity,
    });
    const prepared = buildA05Request(pack, pilot);
    if (prepared.bytes.byteLength > budget.maxOutboundRequestBytes) fail("Development request exceeds frozen byte limit");
    const marker = /\b(?:dev|holdout|shard|slot)[-_][a-z0-9-]+/i.exec(new TextDecoder().decode(prepared.bytes));
    if (marker) {
      const locate = (value: unknown, path: string): string | null => {
        if (typeof value === "string") return value.includes(marker[0]) ? path : null;
        if (Array.isArray(value)) return value.map((item, index) => locate(item, `${path}[${index}]`)).find(Boolean) ?? null;
        if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => locate(item, `${path}.${key}`)).find(Boolean) ?? null;
        return null;
      };
      fail(`Development request contains a cohort or slot marker at ${locate(JSON.parse(new TextDecoder().decode(prepared.bytes)), "$")}`);
    }
    if (spentRequests.has(prepared.requestSha256)) fail("Previously issued request cannot be replayed");
    checked++;
    if (preflightOnly) continue;
    for (const dir of [sourceDir, outputDir, requestDir, scratchDir, evaluatorDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    stageCalibrationSources(sourceDir, packSources, files);
    const runtimeAssets = resolve(itemRoot, "runtime-assets");
    mkdirSync(runtimeAssets, { mode: 0o700 });
    const mountedCliPath = resolve(runtimeAssets, "mstar-harness.js");
    copyFileSync(cliPath, mountedCliPath);
    if (digest(readFileSync(mountedCliPath)) !== cliSha256) fail("Packaged CLI changed before sandbox invocation");
    writeFileSync(resolve(runtimeAssets, "worker.mjs"), worker, { mode: 0o400 });
    writeFileSync(resolve(runtimeAssets, ".mstarc"), "[config]\njev_mode=shadow\njev_transport=typesafe\n", { mode: 0o400 });
    writeFileSync(resolve(runtimeAssets, "pack.json"), canonicalJsonBytes(pack), { mode: 0o400 });
    writeFileSync(resolve(runtimeAssets, "pilot.json"), canonicalJsonBytes(pilot), { mode: 0o400 });
    writeFileSync(resolve(statusPath), JSON.stringify({ schema: "mstar.judgment-status/v1", runId, status: "idle" }), { mode: 0o600 });
    writeFileSync(resolve(evaluatorDir, "request.json"), prepared.bytes, { mode: 0o600 });
    const mountPlan = { syntheticSource: sourceDir, runtimeAssets, ordinaryOutput: outputDir, requests: requestDir, publicStatus: statusPath,
      scratch: scratchDir, evaluatorData: [evaluatorDir], evaluatorCredentialEnv: [],
      readOnlyRoot: true, nonRoot: true, dropCapabilities: true, hostPid: false, dockerSocket: false } as const;
    const child = { id: `child-${runId}`, executable: resolve(runtimeAssets, "worker.mjs"),
      sha256: digest(readFileSync(resolve(runtimeAssets, "worker.mjs"))), runtimePath: dockerPath, runtimeSha256: digest(readFileSync(dockerPath)),
      imageDigest, containerExecutable: "/usr/local/bin/node", uid: process.getuid!(), gid: process.getgid!(),
      argv: ["/mnt/source/.runtime/worker.mjs"], maxElapsedMs: budget.timeoutMsPerOperation, maxOutputBytes: budget.maxResponseBytes };
    let transportAttempted = false;
    const input: ShadowRunInput = { runRoot: itemRoot, runId, pack, pilot, evidenceClass: "synthetic-offline",
      child, mountPlan, baseline: { inventory: calibrationBaselineInventory(pack.tasks[0]!.workUnit.id),
        seatOutputs: [], originalConsumption: { consumedOutputs: [] }, finalReport: { status: "original-work-unconsumed" } },
      sendRequest: async (request) => {
        transportAttempted = true;
        const response = await sendNativeRequest(request);
        writeFileSync(resolve(evaluatorDir, "response.bin"), response.responseBytes, { flag: "wx", mode: 0o600 });
        return response;
      } };
    cliSubmissions++;
    let failure: string | null = null, responseSha256: string | null = null;
    try {
      const assessment = await runShadowSupervisor(input);
      if (assessment.failures.length) failure = assessment.failures.join(",");
    } catch (error) { failure = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9.-]/g, "-").slice(0, 96) : "jev.supervisor-failed"; }
    if (transportAttempted) attempted++;
    const responsePath = resolve(evaluatorDir, "response.bin");
    if (existsSync(responsePath)) responseSha256 = digest(readFileSync(responsePath));
    const resultDirectory = resolve(evaluatorDir, "results");
    const resultFiles = existsSync(resultDirectory) ? readdirSync(resultDirectory) : [];
    let answer: { type: "choice"; choice: A05Label; probabilities: Record<string, number>; confidence: number } | null = null;
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    const recordedPath = resolve(evaluatorDir, "evidence", runId, "reservations", `recorded-${prepared.requestSha256}.json`);
    const providerRecorded = resultFiles.length === 1 && !!responseSha256 && existsSync(recordedPath);
    if (providerRecorded) {
      const result = JSON.parse(readFileSync(resolve(resultDirectory, resultFiles[0]!), "utf8"));
      const normalized = result.response;
      usage = normalized?.usage ?? null;
      const questionId = `a05_${taskId}`;
      answer = result.requestSha256 === prepared.requestSha256 && result.model === protocol.requestedModel &&
        normalized?.model === protocol.requestedModel ? normalized.answers?.[questionId] ?? null : null;
      if (!answer || answer.type !== "choice") fail("Recorded provider answer has invalid sealed identity");
      succeeded++;
    } else if (resultFiles.length > 1) failure = "jev.duplicate-result";
    else if (!failure) failure = "jev.result-unavailable";
    if (!providerRecorded && transportAttempted) failed++;
    if (failure) shadowFailures++;
    observations.set(variant.id, { groupId: group.id, gold: gold.get(variant.id)!.label as CalibrationObservation["gold"],
      choice: answer?.choice ?? null,
      topProbability: answer ? answer.probabilities[answer.choice]! : null,
      confidence: answer?.confidence ?? null });
    outcomes.push({ groupId: group.id, variantId: variant.id, primary: variant.primary, runId,
      cliInvocation: calibrationCliInvocation,
      cliVersion, cliSha256, requestSha256: prepared.requestSha256, responseSha256, transportAttempted,
      usage, costUsd: null, // The frozen pricing declaration covers input only, not the complete bill.
      providerStatus: providerRecorded ? "recorded" : transportAttempted ? "failed" : "unissued",
      status: failure ? providerRecorded ? "recorded-shadow-invalid" : "unavailable" : "recorded",
      shadowFailure: failure, resultPath: resultFiles.length === 1 ? resolve(resultDirectory, resultFiles[0]!) : null });
    writeFileSync(resolve(itemRoot, "outcome.json"), JSON.stringify(outcomes.at(-1)), { flag: "wx", mode: 0o600 });
    if (failure === "jev.response-invalid" || failure?.includes("usage-exceeds") || failure?.includes("early-reveal")) break;
  }
  if (preflightOnly) return { status: "marker-free", attempted: 0, succeeded: 0, failed: 0, checked };
  const primary = groups.map((group) => observations.get(group.variants.find((variant) => variant.primary)!.id) ??
    { groupId: group.id, gold: gold.get(group.variants.find((variant) => variant.primary)!.id)!.label as CalibrationObservation["gold"],
      choice: null, topProbability: null, confidence: null });
  const selected = selectDevelopmentBand(primary, candidates);
  const recordedUsage = outcomes.reduce<{ input: number; output: number }>((tokens, outcome) => {
    const usage = outcome.usage as { inputTokens: number; outputTokens: number } | null | undefined;
    if (outcome.providerStatus === "recorded" && usage) {
      tokens.input += usage.inputTokens;
      tokens.output += usage.outputTokens;
    }
    return tokens;
  }, { input: 0, output: 0 });
  const counts = { providerAvailable: succeeded, providerUnavailable: failed,
    preProviderUnavailable: cliSubmissions - attempted, cliSubmissions, providerAttempts: attempted,
    unissued: planned.length - cliSubmissions, shadowLifecycleInvalid: shadowFailures,
    knownInputTokens: recordedUsage.input, knownOutputTokens: recordedUsage.output,
    estimatedInputUsd: recordedUsage.input * budget.pricingEstimate.usdPerMillionInputTokens / 1_000_000,
    actualCostUsd: null,
    modelAbstain: 0, policyAbstain: 0, acceptedSame: 0, acceptedDifferent: 0 };
  for (const row of observations.values()) {
    if (!row.choice) continue;
    if (row.choice === "insufficient_evidence") { counts.modelAbstain++; continue; }
    const threshold = row.choice === "same_cause" ? selected.band?.same : selected.band?.different;
    if (!threshold || row.topProbability! < threshold[0] || row.confidence! < threshold[1]) counts.policyAbstain++;
    else if (row.choice === "same_cause") counts.acceptedSame++;
    else counts.acceptedDifferent++;
  }
  const bandRecord = { schema: "mstar.qualification-bands/v1", runId: runIdentity,
    status: selected.band ? "selected" : "unqualified", selectedBand: selected.band,
    dimensions: { same: selected.band?.same ?? null, different: selected.band?.different ?? null,
      insufficient: selected.band?.insufficient ?? null }, candidates: selected.candidates,
    qualification: selected.band && attempted === planned.length && failed === 0 && shadowFailures === 0 ? "development-only" : "unqualified",
    policy: selected.band && attempted === planned.length && failed === 0 && shadowFailures === 0 ? "frozen-band-shadow-only" : "all-abstain-no-completed-units-no-visible-advice" };
  const runRecord = { schema: "mstar.qualification-development-run/v1", manifest,
    attempted, succeeded, failed, cliSubmissions, preProviderCliFailures: cliSubmissions - attempted,
    shadowLifecycleFailures: shadowFailures, counts, outcomes };
  const assessment = { schema: "mstar.qualification-development-assessment/v1", status: bandRecord.qualification,
    reason: selected.band ? failed || attempted !== planned.length || shadowFailures ? "incomplete-or-invalid-shadow-run" : null : "no-admissible-development-band",
    selectedBand: selected.band?.id ?? null, counts, knownLimitation: manifest.knownHoldoutLimitation,
    w5: false, holdoutUsed: false };
  for (const [name, value] of [["development-run.json", runRecord], ["bands.json", bandRecord], ["development-assessment.json", assessment]] as const) {
    writeFileSync(resolve(evidence, name), JSON.stringify(value), { flag: "wx", mode: 0o600 });
  }
  return { status: assessment.status, attempted, succeeded, failed, runId: runIdentity };
}
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
      const providerContextPolicy = providerContextDeclaration(tokenPolicy?.providerContextPolicy);
      if (!tokenPolicy || typeof tokenPolicy !== "object" || tokenPolicy.method !== TOKEN_POLICY_METHOD ||
          tokenPolicy.perAttemptReservation !== TOKEN_RESERVATION_PER_ATTEMPT || tokenPolicy.maxRunReservedInputTokens !== MAX_RUN_RESERVED_INPUT_TOKENS ||
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
    if (action === "calibrate" || action === "calibrate-preflight") {
      const result = await calibrateDevelopment(root, protocol, action === "calibrate-preflight");
      process.stdout.write(`${JSON.stringify({ action, ...result, w5: false })}\n`);
      return action === "calibrate-preflight" || result.status === "development-only" ? 0 : 1;
    }
    if (action === "holdout") {
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
