import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJsonBytes } from "./review-advice.js";

const VIEW_SCHEMA = "mstar.annotator-shard-view/v1";
const CROSSWALK_SCHEMA = "mstar.annotation-projection-crosswalk/v1";
const LEAK_REPORT_SCHEMA = "mstar.annotation-leak-check/v1";
const CONTRACT_REVISION = "phase3a-native-20260924";

const SLOT_PATTERN = /shard-[1-4]\/group-\d{3}/g;
const GROUP_SLOT_PATTERN = /\bgroup-0\d{2}\b/g;

export type EvidenceClass = "component";

type AuthorSourceFile = Readonly<{ text?: string; content?: string; sha256: string }>;
type AuthorCitation = Readonly<{
  sourceRef?: string;
  file?: string;
  path?: string;
  startLine: number;
  endLine: number;
  excerpt: string;
}>;
type AuthorFindingSide = Readonly<{
  id: string;
  claim: string;
  citations?: readonly AuthorCitation[];
  evidence?: readonly AuthorCitation[];
}>;
type AuthorVariant = Readonly<{
  id: string;
  left: AuthorFindingSide;
  right: AuthorFindingSide;
  tags?: unknown;
}>;
type AuthorGroup = Readonly<{
  id: string;
  lineageId: string;
  causalClusterId: string;
  sourceFiles?: Record<string, AuthorSourceFile>;
  files?: Record<string, AuthorSourceFile>;
  findings?: readonly Readonly<{ id: string; claim: string }>[];
  tasks?: readonly Readonly<Record<string, unknown>>[];
  variants: readonly AuthorVariant[];
}>;

export type ProjectedVariant = Readonly<{
  itemId: string;
  sourceSha256: string;
  itemDigest: string;
  left: Readonly<{ id: string; claim: string; citations: readonly Readonly<{ sourceRef: string; startLine: number; endLine: number; excerpt: string }>[] }>;
  right: Readonly<{ id: string; claim: string; citations: readonly Readonly<{ sourceRef: string; startLine: number; endLine: number; excerpt: string }>[] }>;
}>;

export type ProjectedGroup = Readonly<{
  schema: typeof VIEW_SCHEMA;
  contractRevision: typeof CONTRACT_REVISION;
  id: string;
  lineageId: string;
  causalClusterId: string;
  sourceFiles: Record<string, Readonly<{ text: string; sha256: string }>>;
  findings: readonly Readonly<{ id: string; claim: string }>[];
  tasks: readonly Readonly<Record<string, unknown>>[];
  variants: readonly ProjectedVariant[];
}>;

export type CrosswalkEntry = Readonly<{
  slotKey: string;
  shard: number;
  slotIndex: number;
  cohort: "development" | "holdout";
  opaqueGroupId: string;
  opaqueLineageId: string;
  opaqueCausalClusterId: string;
  variants: readonly Readonly<{ authorVariantId: string; opaqueVariantId: string; itemDigest: string }>[];
  authorSourceSha256: string;
}>;

export type AnnotationProjectionInput = Readonly<{
  qualificationRoot: string;
  outputRoot: string;
  shuffleSeed?: Uint8Array;
}>;

export type AnnotationProjectionResult = Readonly<{
  schema: "mstar.annotation-projection-result/v1";
  evidenceClass: EvidenceClass;
  w5: false;
  contractRevision: typeof CONTRACT_REVISION;
  shuffleSeedHex: string;
  seatViewPaths: readonly string[];
  crosswalkPath: string;
  leakReportPath: string;
  groupCount: number;
  variantCount: number;
}>;

export function opaqueId128(used: Set<string>, rng: () => Uint8Array = () => randomBytes(16)): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = createHash("sha256").update(rng()).digest("hex").slice(0, 32);
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
  throw new Error("jev.annotation-opaque-id-collision");
}

function digestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cohortForSlotIndex(slotIndex: number): "development" | "holdout" {
  if (!Number.isInteger(slotIndex) || slotIndex < 1 || slotIndex > 90) throw new Error("jev.annotation-slot-invalid");
  return slotIndex <= 15 ? "development" : "holdout";
}

function parseSlotKey(slotKey: string): { shard: number; slotIndex: number } {
  const match = /^shard-([1-4])\/group-(\d{3})$/.exec(slotKey);
  if (!match) throw new Error("jev.annotation-slot-key-invalid");
  const shard = Number(match[1]);
  const slotIndex = Number(match[2]);
  if (!Number.isInteger(shard) || !Number.isInteger(slotIndex) || slotIndex < 1 || slotIndex > 90) throw new Error("jev.annotation-slot-key-invalid");
  return { shard, slotIndex };
}


function normalizeAuthorGroup(raw: AuthorGroup): AuthorGroup {
  const sourceFiles = raw.sourceFiles ?? raw.files;
  if (!sourceFiles) throw new Error("jev.annotation-source-files-missing");
  return Object.freeze({ ...raw, sourceFiles });
}

function readAuthorShard(qualificationRoot: string, shard: number): AuthorGroup[] {
  const path = resolve(qualificationRoot, "sources", `shard-${shard}.jsonl`);
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length !== 90) throw new Error(`jev.annotation-shard-count-${shard}`);
  return lines.map((line) => normalizeAuthorGroup(JSON.parse(line) as AuthorGroup));
}

function sourceBundleSha256(sourceFiles: Record<string, Readonly<{ text: string; sha256: string }>>): string {
  const keys = Object.keys(sourceFiles).sort();
  const payload = keys.map((key) => `${key}\n${sourceFiles[key].sha256}\n${sourceFiles[key].text}`).join("\n---\n");
  return digestHex(Buffer.from(payload, "utf8"));
}

function remapCitations(
  citations: readonly AuthorCitation[] | undefined,
  fileMap: Readonly<Record<string, string>>,
): readonly Readonly<{ sourceRef: string; startLine: number; endLine: number; excerpt: string }>[] {
  const list = citations ?? [];
  return list.map((entry) => {
    const authorRef = entry.sourceRef ?? entry.file ?? entry.path;
    if (!authorRef || !fileMap[authorRef]) throw new Error("jev.annotation-citation-ref-missing");
    return Object.freeze({
      sourceRef: fileMap[authorRef],
      startLine: entry.startLine,
      endLine: entry.endLine,
      excerpt: screenSlotLeaks(entry.excerpt),
    });
  });
}

function remapStringId(value: string, idMap: Readonly<Record<string, string>>): string {
  return idMap[value] ?? value;
}

function deepRemapIds(value: unknown, idMap: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") return remapStringId(value, idMap);
  if (Array.isArray(value)) return value.map((item) => deepRemapIds(item, idMap));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) out[key] = deepRemapIds(nested, idMap);
    return out;
  }
  return value;
}

function screenSlotLeaks(text: string): string {
  let next = text.replace(SLOT_PATTERN, "[redacted-slot]");
  next = next.replace(GROUP_SLOT_PATTERN, "[redacted-slot]");
  return next;
}

function seededShuffle<T>(items: readonly T[], seed: Uint8Array): T[] {
  const copy = [...items];
  let state = createHash("sha256").update(seed).update("shuffle").digest();
  const rand = (): number => {
    state = createHash("sha256").update(state).digest();
    return state.readUInt32BE(0) / 0x1_0000_0000;
  };
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(rand() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function projectGroup(group: AuthorGroup, usedIds: Set<string>): { projected: ProjectedGroup; crosswalk: CrosswalkEntry } {
  const { shard, slotIndex } = parseSlotKey(group.id);
  const opaqueGroupId = opaqueId128(usedIds);
  const opaqueLineageId = opaqueId128(usedIds);
  const opaqueCausalClusterId = opaqueId128(usedIds);
  const fileMap: Record<string, string> = {};
  const projectedFiles: Record<string, Readonly<{ text: string; sha256: string }>> = {};
  const sourceFiles = group.sourceFiles!;
  for (const authorPath of Object.keys(sourceFiles).sort()) {
    const opaquePath = opaqueId128(usedIds);
    fileMap[authorPath] = opaquePath;
    const file = sourceFiles[authorPath];
    const text = screenSlotLeaks(file.text ?? file.content ?? "");
    if (!text || !file.sha256) throw new Error("jev.annotation-source-file-invalid");
    projectedFiles[opaquePath] = Object.freeze({ text, sha256: file.sha256 });
  }
  const authorSourceSha256 = sourceBundleSha256(projectedFiles);
  const idMap: Record<string, string> = {
    [group.id]: opaqueGroupId,
    [group.lineageId]: opaqueLineageId,
    [group.causalClusterId]: opaqueCausalClusterId,
  };
  for (const finding of group.findings ?? []) idMap[finding.id] = opaqueId128(usedIds);
  for (const variant of group.variants) {
    idMap[variant.id] = opaqueId128(usedIds);
    idMap[variant.left.id] = idMap[variant.left.id] ?? opaqueId128(usedIds);
    idMap[variant.right.id] = idMap[variant.right.id] ?? opaqueId128(usedIds);
  }
  for (const authorPath of Object.keys(fileMap)) idMap[authorPath] = fileMap[authorPath];
  const findings = (group.findings ?? []).map((finding) =>
    Object.freeze({ id: idMap[finding.id], claim: screenSlotLeaks(finding.claim) }),
  );
  const tasks = (group.tasks ?? []).map((task) => deepRemapIds(task, idMap) as Record<string, unknown>);
  const variants: ProjectedVariant[] = [];
  const crosswalkVariants: CrosswalkEntry["variants"][number][] = [];
  const sortedVariants = [...group.variants].sort((left, right) => left.id.localeCompare(right.id));
  for (const variant of sortedVariants) {
    if (!idMap[variant.left.id]) idMap[variant.left.id] = opaqueId128(usedIds);
    if (!idMap[variant.right.id]) idMap[variant.right.id] = opaqueId128(usedIds);
    const opaqueVariantId = opaqueId128(usedIds);
    const itemDigest = digestHex(
      canonicalJsonBytes({
        groupId: opaqueGroupId,
        variantId: opaqueVariantId,
        left: { id: idMap[variant.left.id], claim: variant.left.claim },
        right: { id: idMap[variant.right.id], claim: variant.right.claim },
      }),
    );
    variants.push(
      Object.freeze({
        itemId: opaqueVariantId,
        sourceSha256: authorSourceSha256,
        itemDigest,
        left: Object.freeze({
          id: idMap[variant.left.id],
          claim: screenSlotLeaks(variant.left.claim),
          citations: remapCitations(variant.left.citations ?? variant.left.evidence, fileMap),
        }),
        right: Object.freeze({
          id: idMap[variant.right.id],
          claim: screenSlotLeaks(variant.right.claim),
          citations: remapCitations(variant.right.citations ?? variant.right.evidence, fileMap),
        }),
      }),
    );
    crosswalkVariants.push(Object.freeze({ authorVariantId: variant.id, opaqueVariantId, itemDigest }));
  }
  const projected: ProjectedGroup = Object.freeze({
    schema: VIEW_SCHEMA,
    contractRevision: CONTRACT_REVISION,
    id: opaqueGroupId,
    lineageId: opaqueLineageId,
    causalClusterId: opaqueCausalClusterId,
    sourceFiles: projectedFiles,
    findings,
    tasks,
    variants,
  });
  const crosswalk: CrosswalkEntry = Object.freeze({
    slotKey: group.id,
    shard,
    slotIndex,
    cohort: cohortForSlotIndex(slotIndex),
    opaqueGroupId,
    opaqueLineageId,
    opaqueCausalClusterId,
    variants: crosswalkVariants,
    authorSourceSha256,
  });
  return { projected, crosswalk };
}

export type LeakCheckDimension = Readonly<{
  dimension: string;
  inspected: readonly string[];
  passed: boolean;
  findings: readonly string[];
}>;

export type LeakCheckReport = Readonly<{
  schema: typeof LEAK_REPORT_SCHEMA;
  evidenceClass: EvidenceClass;
  w5: false;
  contractRevision: typeof CONTRACT_REVISION;
  verdict: "pass" | "fail";
  dimensions: readonly LeakCheckDimension[];
}>;

export function runLeakCheck(seatViewPaths: readonly string[], crosswalkPath: string): LeakCheckReport {
  const inspectedSeatBytes: string[] = [];
  const seatBlob = seatViewPaths.flatMap((seatPath) => {
    inspectedSeatBytes.push(seatPath);
    const bytes = readFileSync(seatPath);
    return [bytes.toString("utf8"), bytes.toString("hex")];
  });
  const crosswalk = JSON.parse(readFileSync(crosswalkPath, "utf8")) as { entries: CrosswalkEntry[] };
  const forbiddenStrings = new Set<string>();
  for (const entry of crosswalk.entries) {
    forbiddenStrings.add(entry.slotKey);
    forbiddenStrings.add(entry.cohort);
    forbiddenStrings.add(`group-${String(entry.slotIndex).padStart(3, "0")}`);
    forbiddenStrings.add(`shard-${entry.shard}/group-${String(entry.slotIndex).padStart(3, "0")}`);
  }
  const identifierFindings: string[] = [];
  for (const needle of forbiddenStrings) {
    if (needle.length < 6) continue;
    for (const blob of seatBlob) {
      if (blob.includes(needle)) identifierFindings.push(`seat-visible bytes contain forbidden token: ${needle}`);
    }
  }
  for (const blob of seatBlob) {
    if (SLOT_PATTERN.test(blob) || GROUP_SLOT_PATTERN.test(blob)) identifierFindings.push("seat-visible bytes contain slot pattern");
    SLOT_PATTERN.lastIndex = 0;
    GROUP_SLOT_PATTERN.lastIndex = 0;
  }
  const opaqueIds = new Set<string>();
  let duplicateOpaque = false;
  for (const entry of crosswalk.entries) {
    for (const id of [entry.opaqueGroupId, entry.opaqueLineageId, entry.opaqueCausalClusterId, ...entry.variants.map((v) => v.opaqueVariantId)]) {
      if (opaqueIds.has(id)) duplicateOpaque = true;
      opaqueIds.add(id);
      if (!/^[a-f0-9]{32}$/.test(id)) identifierFindings.push(`opaque id format invalid: ${id}`);
    }
  }
  if (duplicateOpaque) identifierFindings.push("opaque id collision detected in crosswalk");
  const crosswalkInSeat = seatBlob.some((blob) => blob.includes("slotKey") || blob.includes("authorVariantId") || blob.includes("mstar.annotation-projection-crosswalk"));
  if (crosswalkInSeat) identifierFindings.push("crosswalk material present in seat-visible bytes");
  const orderFindings: string[] = [];
  const slotIndexes: number[] = [];
  const presentationIndexes: number[] = [];
  for (const seatPath of seatViewPaths) {
    const lines = readFileSync(seatPath, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    lines.forEach((line, index) => {
      const group = JSON.parse(line) as ProjectedGroup;
      const entry = crosswalk.entries.find((candidate) => candidate.opaqueGroupId === group.id);
      if (!entry) return;
      slotIndexes.push(entry.slotIndex);
      presentationIndexes.push(index + 1);
    });
  }
  if (slotIndexes.length > 2) {
    const n = slotIndexes.length;
    const meanSlot = slotIndexes.reduce((sum, value) => sum + value, 0) / n;
    const meanPos = presentationIndexes.reduce((sum, value) => sum + value, 0) / n;
    let num = 0;
    let denSlot = 0;
    let denPos = 0;
    for (let index = 0; index < n; index++) {
      num += (slotIndexes[index] - meanSlot) * (presentationIndexes[index] - meanPos);
      denSlot += (slotIndexes[index] - meanSlot) ** 2;
      denPos += (presentationIndexes[index] - meanPos) ** 2;
    }
    const corr = denSlot === 0 || denPos === 0 ? 0 : num / Math.sqrt(denSlot * denPos);
    if (Math.abs(corr) > 0.35) orderFindings.push(`presentation order correlates with slot index (r=${corr.toFixed(3)})`);
  }
  const metadataFindings: string[] = [];
  for (const seatPath of seatViewPaths) {
    const lines = readFileSync(seatPath, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    for (const line of lines) {
      if (line.includes("\"tags\"")) metadataFindings.push(`author tags leaked in ${seatPath}`);
      if (/\bshard-[1-4]\//.test(line)) metadataFindings.push(`shard marker leaked in ${seatPath}`);
      if (line.includes("\"development\"") || line.includes("\"holdout\"")) metadataFindings.push(`cohort marker leaked in ${seatPath}`);
    }
  }
  const dimensions: LeakCheckDimension[] = [
    {
      dimension: "identifier-opacity-and-collision-freedom",
      inspected: [...inspectedSeatBytes, crosswalkPath],
      passed: identifierFindings.length === 0,
      findings: identifierFindings,
    },
    {
      dimension: "order-independence-from-slot",
      inspected: seatViewPaths,
      passed: orderFindings.length === 0,
      findings: orderFindings,
    },
    {
      dimension: "metadata-stripping",
      inspected: seatViewPaths,
      passed: metadataFindings.length === 0,
      findings: metadataFindings,
    },
    {
      dimension: "crosswalk-absent-from-seat-views",
      inspected: [...inspectedSeatBytes, crosswalkPath],
      passed: !crosswalkInSeat,
      findings: crosswalkInSeat ? ["crosswalk schema tokens found in seat-visible bytes"] : [],
    },
  ];
  const verdict = dimensions.every((dimension) => dimension.passed) ? "pass" : "fail";
  return Object.freeze({
    schema: LEAK_REPORT_SCHEMA,
    evidenceClass: "component",
    w5: false,
    contractRevision: CONTRACT_REVISION,
    verdict,
    dimensions,
  });
}

export function runAnnotationProjection(input: AnnotationProjectionInput): AnnotationProjectionResult {
  const qualificationRoot = input.qualificationRoot;
  const outputRoot = input.outputRoot;
  const shuffleSeed = input.shuffleSeed ?? randomBytes(32);
  const usedIds = new Set<string>();
  const crosswalkEntries: CrosswalkEntry[] = [];
  const seatViewPaths: string[] = [];
  mkdirSync(resolve(outputRoot, "seats", "A"), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(outputRoot, "seats", "B"), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(outputRoot, "supervisor-only"), { recursive: true, mode: 0o700 });
  const brief = readFileSync(resolve(qualificationRoot, "annotation-brief.md"));
  for (const seat of ["A", "B"] as const) {
    writeFileSync(resolve(outputRoot, "seats", seat, "annotation-brief.md"), brief, { mode: 0o600 });
  }
  let variantCount = 0;
  for (let shard = 1; shard <= 4; shard++) {
    const groups = readAuthorShard(qualificationRoot, shard);
    const projected: ProjectedGroup[] = [];
    for (const group of groups) {
      const result = projectGroup(group, usedIds);
      projected.push(result.projected);
      crosswalkEntries.push(result.crosswalk);
      variantCount += result.projected.variants.length;
    }
    const shuffled = seededShuffle(projected, Buffer.concat([shuffleSeed, Buffer.from(`shard-${shard}`)]));
    for (const seat of ["A", "B"] as const) {
      const seatPath = resolve(outputRoot, "seats", seat, `shard-${shard}.jsonl`);
      writeFileSync(seatPath, `${shuffled.map((group) => JSON.stringify(group)).join("\n")}\n`, { mode: 0o600 });
      seatViewPaths.push(seatPath);
    }
  }
  const crosswalkPath = resolve(outputRoot, "supervisor-only", "crosswalk.json");
  const crosswalkBody = {
    schema: CROSSWALK_SCHEMA,
    evidenceClass: "component" as const,
    w5: false,
    contractRevision: CONTRACT_REVISION,
    shuffleSeedHex: Buffer.from(shuffleSeed).toString("hex"),
    entries: crosswalkEntries.sort((left, right) => left.slotKey.localeCompare(right.slotKey)),
  };
  writeFileSync(crosswalkPath, `${JSON.stringify(crosswalkBody, null, 2)}\n`, { mode: 0o600 });
  chmodSync(resolve(outputRoot, "supervisor-only"), 0o700);
  const leakReportPath = resolve(outputRoot, "leak-check-report.json");
  const leakReport = runLeakCheck(seatViewPaths, crosswalkPath);
  writeFileSync(leakReportPath, `${JSON.stringify(leakReport, null, 2)}\n`, { mode: 0o600 });
  if (leakReport.verdict !== "pass") throw new Error("jev.annotation-leak-check-failed");
  const manifestPath = resolve(outputRoot, "manifest.json");
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        schema: "mstar.annotation-view-evidence/v1",
        evidenceClass: "component",
        w5: false,
        contractRevision: CONTRACT_REVISION,
        seatViewPaths: seatViewPaths.map((path) => path.slice(outputRoot.length + 1)),
        leakReportPath: "leak-check-report.json",
        crosswalkPath: "supervisor-only/crosswalk.json",
        groupCount: crosswalkEntries.length,
        variantCount,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return Object.freeze({
    schema: "mstar.annotation-projection-result/v1",
    evidenceClass: "component",
    w5: false,
    contractRevision: CONTRACT_REVISION,
    shuffleSeedHex: Buffer.from(shuffleSeed).toString("hex"),
    seatViewPaths,
    crosswalkPath,
    leakReportPath,
    groupCount: crosswalkEntries.length,
    variantCount,
  });
}
