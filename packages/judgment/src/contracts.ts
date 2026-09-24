export const CONTRACT_REVISION = "phase3a-native-20260924" as const;
export const PACK_SCHEMA = "mstar.review-advice-pack/v1" as const;
export const PILOT_SCHEMA = "mstar.judgment-pilot/v1" as const;
export const NATIVE_MODEL = "jev-1.13.0" as const;
export const NATIVE_ENDPOINT = "https://api.typesafe.ai/v1/systemone" as const;
export const TOKEN_POLICY_METHOD = "provider-context-reservation/v1" as const;
export const TOKEN_RESERVATION_PER_ATTEMPT = 65_536 as const;
export const MAX_RUN_RESERVED_INPUT_TOKENS = 65_536_000 as const;
export const PROTOCOL_NUMERIC_TOLERANCE = 1e-6 as const;

export type A05Label = "same_cause" | "different_cause" | "insufficient_evidence";
export type Profile = "review";
export type ReviewTier = "quick" | "default" | "deep";
export type WorkUnit = Readonly<{ id: string; revision: number }>;
export type ReviewDecisionPack = Readonly<{
  schema: typeof PACK_SCHEMA;
  contractRevision: typeof CONTRACT_REVISION;
  runId: string;
  packId: string;
  concernId: string;
  profile: Profile;
  scope: Readonly<{
    kind: "review";
    reviewId: string;
    snapshotSha256: string;
    diffSha256: string;
    baseRevision?: string;
    headRevision?: string;
    tier: ReviewTier;
  }>;
  recipient: Readonly<{ id: string; phase: "synthesis" }>;
  sources: readonly Readonly<{
    id: string;
    path: string;
    revision?: string;
    startLine: number;
    endLine: number;
    contentSha256: string;
    observedInRunId: string;
    basis: "snapshot" | "author-read" | "seat-observation" | "prior-run";
  }>[];
  state: Readonly<{
    evidence: readonly Readonly<{ id: string; sourceId: string; excerpt: string }>[];
    subjects: readonly Readonly<{
      id: string;
      kind: "finding";
      text: string;
      evidenceIds: readonly string[];
    }>[];
  }>;
  tasks: readonly Readonly<{
    id: string;
    useCase: "JEV-A05";
    subjectIds: readonly [string, string];
    workUnit: WorkUnit;
  }>[];
  rubricVersion: string;
  builderVersion: string;
}>;

export type JudgmentPilot = Readonly<{
  schema: typeof PILOT_SCHEMA;
  contractRevision: typeof CONTRACT_REVISION;
  pilotId: string;
  runId: string;
  profile: Profile;
  scope: Readonly<{
    kind: "review";
    reviewId: string;
    snapshotSha256: string;
    diffSha256: string;
  }>;
  mode: "shadow";
  transport: "native-typesafe";
  endpoint: typeof NATIVE_ENDPOINT;
  model: typeof NATIVE_MODEL;
  useCases: readonly ["JEV-A05"];
  recipients: readonly Readonly<{ id: string; phase: "synthesis" }>[];
  policyVersion: string;
  permission: Readonly<{ ref: string; purpose: string; dataClass: string }>;
  isolation: Readonly<{ ref: string }>;
  packManifest: readonly Readonly<{ packId: string; packSha256: string }>[];
  rubricVersion: string;
  builderVersion: string;
  implementationVersion: string;
  limits: Readonly<{
    timeoutMs: number;
    maxRunElapsedMs: number;
    maxCallsPerRun: number;
    maxConcurrentRequests: number;
    maxTasksPerPack: number;
    maxPacksPerRun: number;
    maxPairs: number;
    maxPackBytes: number;
    maxRequestBytes: number;
    maxResponseBytes: number;
    maxAttempts: 1;
  }>;
  tokenPolicy: Readonly<{
    method: typeof TOKEN_POLICY_METHOD;
    perAttemptReservation: typeof TOKEN_RESERVATION_PER_ATTEMPT;
    maxRunReservedInputTokens: number;
  }>;
  sourcePolicy: Readonly<{ minimization: string; retention: string }>;
  protocolVersion: string;
  splitId: string;
  calibrationId: string;
}>;

function fail(path: string, reason: string): never {
  throw new TypeError(`Invalid judgment contract at ${path}: ${reason}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "expected object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string, optional: readonly string[] = []): void {
  const allowed = new Set([...keys, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
  for (const key of keys) if (!(key in value)) fail(`${path}.${key}`, "required field missing");
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) return fail(path, "expected non-empty string");
  return value;
}

function optionalString(value: Record<string, unknown>, key: string, path: string): void {
  if (key in value && (typeof value[key] !== "string" || value[key] === "")) fail(`${path}.${key}`, "expected non-empty string");
}

function integer(value: unknown, path: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    return fail(path, `expected safe integer >= ${minimum}`);
  }
  return value;
}

function digest(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^[a-f0-9]{64}$/.test(result)) return fail(path, "expected lowercase SHA-256 hex digest");
  return result;
}

function array(value: unknown, path: string, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum) return fail(path, `expected array with at least ${minimum} item(s)`);
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) fail(`${path}[${i}]`, "arrays must not contain holes");
  }
  return value;
}

function uniqueId(id: string, seen: Set<string>, path: string): void {
  if (seen.has(id)) fail(path, `duplicate ID ${id}`);
  seen.add(id);
}

function validateIdentity(value: Record<string, unknown>, schema: string, path: string): void {
  if (value.schema !== schema) fail(`${path}.schema`, `expected ${schema}`);
  if (value.contractRevision !== CONTRACT_REVISION) fail(`${path}.contractRevision`, `unsupported revision; expected ${CONTRACT_REVISION}`);
}

export function validatePack(value: unknown): ReviewDecisionPack {
  const p = record(value, "pack");
  exactKeys(p, ["schema", "contractRevision", "runId", "packId", "concernId", "profile", "scope", "recipient", "sources", "state", "tasks", "rubricVersion", "builderVersion"], "pack");
  validateIdentity(p, PACK_SCHEMA, "pack");
  for (const key of ["runId", "packId", "concernId", "rubricVersion", "builderVersion"]) string(p[key], `pack.${key}`);
  if (p.profile !== "review") fail("pack.profile", "only review profile is enabled");

  const scope = record(p.scope, "pack.scope");
  exactKeys(scope, ["kind", "reviewId", "snapshotSha256", "diffSha256", "tier"], "pack.scope", ["baseRevision", "headRevision"]);
  // Optional revisions are allowed by the wire schema and stay local.
  optionalString(scope, "baseRevision", "pack.scope");
  optionalString(scope, "headRevision", "pack.scope");
  if (scope.kind !== "review") fail("pack.scope.kind", "only review scope is enabled");
  string(scope.reviewId, "pack.scope.reviewId");
  digest(scope.snapshotSha256, "pack.scope.snapshotSha256");
  digest(scope.diffSha256, "pack.scope.diffSha256");
  if (!["quick", "default", "deep"].includes(scope.tier as string)) fail("pack.scope.tier", "unsupported review tier");

  const recipient = record(p.recipient, "pack.recipient");
  exactKeys(recipient, ["id", "phase"], "pack.recipient");
  string(recipient.id, "pack.recipient.id");
  if (recipient.phase !== "synthesis") fail("pack.recipient.phase", "only synthesis is enabled");

  const ids = new Set<string>();
  const sources = array(p.sources, "pack.sources", 1).map((item, i) => {
    const path = `pack.sources[${i}]`;
    const source = record(item, path);
    exactKeys(source, ["id", "path", "startLine", "endLine", "contentSha256", "observedInRunId", "basis"], path, ["revision"]);
    uniqueId(string(source.id, `${path}.id`), ids, `${path}.id`);
    string(source.path, `${path}.path`);
    optionalString(source, "revision", path);
    const startLine = integer(source.startLine, `${path}.startLine`);
    const endLine = integer(source.endLine, `${path}.endLine`);
    if (endLine < startLine) fail(`${path}.endLine`, "must be >= startLine");
    digest(source.contentSha256, `${path}.contentSha256`);
    string(source.observedInRunId, `${path}.observedInRunId`);
    if (!(["snapshot", "author-read", "seat-observation", "prior-run"] as unknown[]).includes(source.basis)) fail(`${path}.basis`, "unsupported source basis");
    if (source.observedInRunId !== p.runId && source.basis !== "prior-run") fail(`${path}.observedInRunId`, "only prior-run sources may bind another run");
    return source;
  });

  const state = record(p.state, "pack.state");
  exactKeys(state, ["evidence", "subjects"], "pack.state");
  const evidenceIds = new Set<string>();
  const evidence = array(state.evidence, "pack.state.evidence", 1).map((item, i) => {
    const path = `pack.state.evidence[${i}]`;
    const entry = record(item, path);
    exactKeys(entry, ["id", "sourceId", "excerpt"], path);
    uniqueId(string(entry.id, `${path}.id`), evidenceIds, `${path}.id`);
    string(entry.sourceId, `${path}.sourceId`);
    if (!ids.has(entry.sourceId as string)) fail(`${path}.sourceId`, "dangling source ID");
    string(entry.excerpt, `${path}.excerpt`);
    return entry;
  });
  const subjectIds = new Set<string>();
  const subjects: { id: string }[] = array(state.subjects, "pack.state.subjects", 2).map((item, i) => {
    const path = `pack.state.subjects[${i}]`;
    const subject = record(item, path);
    exactKeys(subject, ["id", "kind", "text", "evidenceIds"], path);
    const id = string(subject.id, `${path}.id`);
    uniqueId(id, subjectIds, `${path}.id`);
    if (subject.kind !== "finding") fail(`${path}.kind`, "A05 requires finding subjects");
    const text = string(subject.text, `${path}.text`);
    const refs = array(subject.evidenceIds, `${path}.evidenceIds`, 1).map((ref, j) => {
      const evidenceId = string(ref, `${path}.evidenceIds[${j}]`);
      if (!evidenceIds.has(evidenceId)) fail(`${path}.evidenceIds[${j}]`, "dangling evidence ID");
      return evidenceId;
    });
    return { id, kind: "finding" as const, text, evidenceIds: refs };
  });
  if (subjects.length !== 2) fail("pack.state.subjects", "A05 requires exactly two ordered subjects");

  const taskIds = new Set<string>();
  const tasks = array(p.tasks, "pack.tasks", 1).map((item, i) => {
    const path = `pack.tasks[${i}]`;
    const task = record(item, path);
    exactKeys(task, ["id", "useCase", "subjectIds", "workUnit"], path);
    uniqueId(string(task.id, `${path}.id`), taskIds, `${path}.id`);
    if (task.useCase !== "JEV-A05") fail(`${path}.useCase`, "only JEV-A05 is enabled");
    const refs = array(task.subjectIds, `${path}.subjectIds`, 2);
    if (refs.length !== 2 || refs.some((ref, j) => ref !== subjects[j]?.id)) fail(`${path}.subjectIds`, "must bind both ordered pack subjects exactly");
    const unit = record(task.workUnit, `${path}.workUnit`);
    exactKeys(unit, ["id", "revision"], `${path}.workUnit`);
    string(unit.id, `${path}.workUnit.id`);
    integer(unit.revision, `${path}.workUnit.revision`, 0);
    return task;
  });
  return value as ReviewDecisionPack;
}

export function validatePilot(value: unknown): JudgmentPilot {
  const p = record(value, "pilot");
  exactKeys(p, ["schema", "contractRevision", "pilotId", "runId", "profile", "scope", "mode", "transport", "endpoint", "model", "useCases", "recipients", "policyVersion", "permission", "isolation", "packManifest", "rubricVersion", "builderVersion", "implementationVersion", "limits", "tokenPolicy", "sourcePolicy", "protocolVersion", "splitId", "calibrationId"], "pilot");
  validateIdentity(p, PILOT_SCHEMA, "pilot");
  for (const key of ["pilotId", "runId", "policyVersion", "rubricVersion", "builderVersion", "implementationVersion", "protocolVersion", "splitId", "calibrationId"]) string(p[key], `pilot.${key}`);
  if (p.profile !== "review") fail("pilot.profile", "only review profile is enabled");
  if (p.mode !== "shadow") fail("pilot.mode", "assist is not qualified");
  if (p.transport !== "native-typesafe") fail("pilot.transport", "only native-typesafe transport is enabled");
  if (p.endpoint !== NATIVE_ENDPOINT) fail("pilot.endpoint", "endpoint must be the fixed native endpoint");
  if (p.model !== NATIVE_MODEL) fail("pilot.model", "pilot must pin the qualified model exactly");

  const scope = record(p.scope, "pilot.scope");
  exactKeys(scope, ["kind", "reviewId", "snapshotSha256", "diffSha256"], "pilot.scope");
  if (scope.kind !== "review") fail("pilot.scope.kind", "only review scope is enabled");
  string(scope.reviewId, "pilot.scope.reviewId");
  digest(scope.snapshotSha256, "pilot.scope.snapshotSha256");
  digest(scope.diffSha256, "pilot.scope.diffSha256");

  const useCases = array(p.useCases, "pilot.useCases", 1);
  if (useCases.length !== 1 || useCases[0] !== "JEV-A05") fail("pilot.useCases", "only JEV-A05 is enabled");
  const recipients = array(p.recipients, "pilot.recipients", 1).map((item, i) => {
    const path = `pilot.recipients[${i}]`;
    const recipient = record(item, path);
    exactKeys(recipient, ["id", "phase"], path);
    string(recipient.id, `${path}.id`);
    if (recipient.phase !== "synthesis") fail(`${path}.phase`, "only synthesis is enabled");
    return recipient;
  });

  const permission = record(p.permission, "pilot.permission");
  exactKeys(permission, ["ref", "purpose", "dataClass"], "pilot.permission");
  for (const key of ["ref", "purpose", "dataClass"]) string(permission[key], `pilot.permission.${key}`);
  const isolation = record(p.isolation, "pilot.isolation");
  exactKeys(isolation, ["ref"], "pilot.isolation");
  string(isolation.ref, "pilot.isolation.ref");
  const manifest = array(p.packManifest, "pilot.packManifest", 1).map((item, i) => {
    const path = `pilot.packManifest[${i}]`;
    const row = record(item, path);
    exactKeys(row, ["packId", "packSha256"], path);
    string(row.packId, `${path}.packId`);
    digest(row.packSha256, `${path}.packSha256`);
    return row;
  });
  if (new Set(manifest.map((row) => row.packId)).size !== manifest.length) fail("pilot.packManifest", "duplicate pack ID");
  const limits = record(p.limits, "pilot.limits");
  exactKeys(limits, ["timeoutMs", "maxRunElapsedMs", "maxCallsPerRun", "maxConcurrentRequests", "maxTasksPerPack", "maxPacksPerRun", "maxPairs", "maxPackBytes", "maxRequestBytes", "maxResponseBytes", "maxAttempts"], "pilot.limits");
  const timeoutMs = integer(limits.timeoutMs, "pilot.limits.timeoutMs");
  const maxRunElapsedMs = integer(limits.maxRunElapsedMs, "pilot.limits.maxRunElapsedMs");
  const maxCallsPerRun = integer(limits.maxCallsPerRun, "pilot.limits.maxCallsPerRun");
  const maxConcurrentRequests = integer(limits.maxConcurrentRequests, "pilot.limits.maxConcurrentRequests");
  const maxTasksPerPack = integer(limits.maxTasksPerPack, "pilot.limits.maxTasksPerPack");
  const maxPacksPerRun = integer(limits.maxPacksPerRun, "pilot.limits.maxPacksPerRun");
  const maxPairs = integer(limits.maxPairs, "pilot.limits.maxPairs");
  const maxPackBytes = integer(limits.maxPackBytes, "pilot.limits.maxPackBytes");
  const maxRequestBytes = integer(limits.maxRequestBytes, "pilot.limits.maxRequestBytes");
  const maxResponseBytes = integer(limits.maxResponseBytes, "pilot.limits.maxResponseBytes");
  const maxAttempts = integer(limits.maxAttempts, "pilot.limits.maxAttempts");
  if (maxCallsPerRun > 1_000 || maxPacksPerRun > 1_000 || maxConcurrentRequests !== 1 || maxTasksPerPack > 4 || maxPairs > 4 || timeoutMs > 10_000 || maxRunElapsedMs > 10_000_000 || maxPackBytes > 65_536 || maxRequestBytes > 32_768 || maxResponseBytes > 65_536 || maxAttempts !== 1) {
    fail("pilot.limits", "exceeds the frozen finite native policy");
  }

  const tokenPolicy = record(p.tokenPolicy, "pilot.tokenPolicy");
  exactKeys(tokenPolicy, ["method", "perAttemptReservation", "maxRunReservedInputTokens"], "pilot.tokenPolicy");
  if (tokenPolicy.method !== TOKEN_POLICY_METHOD) fail("pilot.tokenPolicy.method", "unsupported token reservation method");
  if (tokenPolicy.perAttemptReservation !== TOKEN_RESERVATION_PER_ATTEMPT) fail("pilot.tokenPolicy.perAttemptReservation", "must reserve 65,536 tokens per attempt");
  integer(tokenPolicy.maxRunReservedInputTokens, "pilot.tokenPolicy.maxRunReservedInputTokens");
  if ((tokenPolicy.maxRunReservedInputTokens as number) > MAX_RUN_RESERVED_INPUT_TOKENS || (tokenPolicy.maxRunReservedInputTokens as number) < ((limits.maxCallsPerRun as number) * TOKEN_RESERVATION_PER_ATTEMPT)) {
    fail("pilot.tokenPolicy.maxRunReservedInputTokens", "must cover every permitted attempt without exceeding the frozen run cap");
  }

  const sourcePolicy = record(p.sourcePolicy, "pilot.sourcePolicy");
  exactKeys(sourcePolicy, ["minimization", "retention"], "pilot.sourcePolicy");
  string(sourcePolicy.minimization, "pilot.sourcePolicy.minimization");
  string(sourcePolicy.retention, "pilot.sourcePolicy.retention");
  return value as JudgmentPilot;
}
