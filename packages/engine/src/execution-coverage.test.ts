/**
 * execution-coverage.test.ts — proof for the §4.1/§4.2/§5 coverage substrate.
 *
 * Every case runs the REAL module on synthetic fixtures whose bytes are the
 * RELEASED producer formats: the v2 root register and workflow snapshots, a
 * session envelope, the legacy/version-1 note records, the agent-flow ledger
 * with its accepted-identity index and a sealed history chunk, the versioned
 * cursor sidecar, the engine-status envelope, the plugin launch journal, H1's
 * canonical host-history export, an R1 consumer manifest, a recovery inventory
 * and retained SDD bodies. No fixture path exists on disk, so a validator that
 * read a file instead of the handed-in bytes could not pass. Receipts are built
 * with `buildExecutionCoverageReceipt` — the producer entry point C3 uses — so
 * the producer and the validator are proven to agree on one schema.
 *
 * Assertion discipline (repo rule): no case pins refusal prose. Each negative
 * case starts from the valid fixture proven in the same test, changes exactly
 * one dimension, and asserts the stable refusal code plus that the inputs were
 * not touched; the positive twins assert that validation returns.
 *
 * Run with `bun test packages/engine/src/execution-coverage.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  EXECUTION_COVERAGE_SURFACES,
  buildExecutionCoverageReceipt,
  coverageWitnessKey,
  executionCoverageDigest,
  executionCoverageSurfaceScope,
  validateExecutionCoverage,
  type CoverageWitness,
  type ExecutionCoverageManifest,
  type ExecutionCoverageReceipt,
  type ExecutionCoverageSet,
  type ExecutionSurface,
} from "./execution-coverage.js";
import { ExecutionError, serializeExecutionValue } from "./execution-store.js";

const MANIFEST_ID = "coverage-manifest-20260921-core";
const MANIFEST_HASH = "b".repeat(64);
const STORE_ID = "6f5c7d1e-3a44-4b2c-9f7e-51a3b2c4d5e6";
const EPOCH = 4;
const WORKFLOW_A = "wf-alpha";
const WORKFLOW_B = "wf-beta";
const SESSION_A = `sess-${WORKFLOW_A}`;
const SESSION_B = `sess-${WORKFLOW_B}`;
const STREAM_A = `s1-${"a".repeat(32)}`;
const STREAM_B = `s1-${"b".repeat(32)}`;
const COVERAGE_CODE = "execution.coverage-incomplete";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(serializeExecutionValue(value), "utf8").digest("hex");
}

function fakeHex(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

/** A harness-produced document must be canonical §3.1 JSON. */
function canonical(value: unknown): string {
  return serializeExecutionValue(value);
}

/** A retained legacy body: real files are pretty-printed, and that stays supported. */
function legacy(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

type Doc = Readonly<{ root: "control" | "sdd" | "host" | "package"; path: string; text: string }>;

function doc(root: Doc["root"], path: string, text: string): Doc {
  return { root, path, text };
}

function witnessOf(entry: Doc): CoverageWitness {
  return { root: entry.root, path: entry.path, sha256: sha(entry.text) };
}

function byRootPath(left: CoverageWitness, right: CoverageWitness): number {
  const leftKey = coverageWitnessKey(left.root, left.path);
  const rightKey = coverageWitnessKey(right.root, right.path);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

type Disposition = "absent" | "retain" | "migrate" | "retire";

type Row = {
  surface: ExecutionSurface;
  workflowId: string | null;
  disposition: Disposition;
  docs: Doc[];
  evidence?: Doc;
  patch?: (receipt: Record<string, unknown>) => Record<string, unknown>;
  manifestWorkflowId?: string | null;
  /** C3's trusted consumer discovery proof — an independent fixture input. */
  consumerProof?: Record<string, unknown>;
  /** C3's trusted host-session discovery for the host-hidden surface. */
  hostProof?: Record<string, unknown>;
};

/* ------------------------------------------------------------------ fixtures */

function snapshot(wf: string): Doc {
  return doc("control", `workflows/${wf}/snapshot.json`, legacy({ schema_version: 1, id: wf, type: "plan", status: "running", started_at: "2026-09-21T00:00:00.000Z" }));
}

function registerDoc(ids: readonly string[]): Doc {
  return doc(
    "control",
    "status.json",
    legacy({
      version: 2,
      updated_at: "2026-09-21T00:00:00.000Z",
      workflows: ids.map((id) => ({ id, type: "plan", started_at: "2026-09-21T00:00:00.000Z", dir: `workflows/${id}` })),
    }),
  );
}

function sessionEnvelopeDoc(wf: string): Doc {
  const sessionId = `sess-${wf}`;
  return doc(
    "control",
    `workflows/${wf}/sessions/coordinator-${sessionId}.json`,
    legacy({ schema_version: 1, role: "coordinator", session_id: sessionId, workflow_id: wf, harness_root: "/harness" }),
  );
}

function notesDoc(wf: string): Doc {
  const lines = [
    JSON.stringify({ kind: "note", ts: "2026-09-21T00:00:00.000Z", text: `retained note of ${wf}` }),
    JSON.stringify({ version: 1, id: `note-${wf}`, workflowId: wf, sessionId: `sess-${wf}`, kind: "note", ts: "2026-09-21T00:00:01.000Z", text: "recorded" }),
  ];
  return doc("control", `workflows/${wf}/notes.jsonl`, `${lines.join("\n")}\n`);
}

/** One durable ledger line: the released kind fields plus the source tuple whose id it derives. */
function durableLine(wf: string, kind: string, seq: number, extra: Record<string, unknown> = {}): string {
  const sessionId = `sess-${wf}`;
  const stream = wf === WORKFLOW_A ? STREAM_A : STREAM_B;
  const base: Record<string, unknown> = {
    v: 1,
    ts: seq,
    kind,
    runId: `run-${wf}`,
    ...(kind === "workflow-run" ? { name: `run of ${wf}` } : {}),
    ...(kind === "workflow-agent" ? { seq: 1, label: "member", childId: `child-${wf}` } : {}),
    eventId: `wfe1:${kind}:${sessionId}:${stream}:${seq}`,
    source: { sessionId, streamId: stream, seq },
  };
  return JSON.stringify({ ...base, ...extra });
}

/**
 * The released durable workflow rows and the index lines that dedup them. The
 * tail also keeps one LEGACY durable row — written before identities existed,
 * carrying neither `eventId` nor `source` — which is accepted and never indexed.
 */
function agentFlowDocs(wf: string): Doc[] {
  const legacyLine = JSON.stringify({ v: 1, ts: 0, kind: "workflow-run", runId: `legacy-${wf}`, name: `legacy run of ${wf}` });
  const tailLine = durableLine(wf, "workflow-run", 1);
  const chunkLine = durableLine(wf, "workflow-agent", 2);
  return [
    doc("control", `workflows/${wf}/agent-flow.jsonl`, `${legacyLine}\n${tailLine}\n`),
    doc(
      "control",
      `workflows/${wf}/agent-flow-ids.jsonl`,
      `${[
        JSON.stringify({ id: JSON.parse(tailLine).eventId as string, d: sha(tailLine).slice(0, 32) }),
        JSON.stringify({ id: JSON.parse(chunkLine).eventId as string, d: sha(chunkLine).slice(0, 32) }),
      ].join("\n")}\n`,
    ),
    doc("control", `workflows/${wf}/agent-flow-history/chunk-000001.jsonl`, `${chunkLine}\n`),
  ];
}

function cursorDoc(wf: string): Doc {
  return doc("control", `workflows/${wf}/workflow-ledger-cursors.json`, canonical({ v: 2, cursors: { [`sess-${wf}`]: { next: 4, stream: STREAM_A } } }));
}

function engineStatusDoc(): Doc {
  return doc(
    "control",
    "snapshots/engine-status.json",
    canonical({
      sv: 1,
      entries: { [SESSION_A]: [{ rv: 1, cwd: "/proj", at: "2026-09-21T00:00:00.000Z", turn: 3, payload: { ok: true } }] },
      bindings: { [SESSION_A]: { cwd: "/proj", selectedWorkflowId: WORKFLOW_A, excludedBeforeSeq: 2 } },
    }),
  );
}

function launchJournalDoc(wf: string): Doc {
  return doc(
    "control",
    `workflows/${wf}/omp-launches.json`,
    legacy({
      version: 1,
      workflow_id: wf,
      coordinator: { session_id: `sess-${wf}`, session_file: `/harness/workflows/${wf}/sessions/coordinator-sess-${wf}.json` },
      intents: [
        {
          id: `phase2-launch:plan-${wf}:1`,
          workflowId: wf,
          coordinatorSessionId: `sess-${wf}`,
          planId: `plan-${wf}`,
          preparedHash: `hash-${wf}`,
          assignmentPath: `/harness/workflows/${wf}/assignment.md`,
          worktreePath: `/harness/worktrees/${wf}`,
          transport: "herdr",
          state: "reserved",
          evidencePaths: [],
        },
      ],
    }),
  );
}

/**
 * H2's session-inventory envelope plus the attestation it pins. The embedded H1
 * export is hashed over its exact serialization WITHOUT the trailing LF, and the
 * envelope file is the row's only source.
 */
function hostDocs(wf: string): { envelope: Doc; attestation: Doc } {
  const sessionId = `sess-${wf}`;
  const payload = { workflowId: wf, state: "pending", operationId: `op-${wf}` };
  const exported = {
    version: 1,
    document: "execution-host-history",
    records: [
      {
        index: 0,
        entryId: `entry-${wf}`,
        type: "mstar:phase2",
        sessionId,
        payloadHash: digestOf(payload),
        payload,
        view: {
          generation: 1,
          declaredKind: "phase2",
          declaredAction: null,
          declaredState: "pending",
          workflowId: wf,
          checkpointId: null,
          operationId: `op-${wf}`,
          dedupKey: `op-${wf}`,
          cancelled: false,
          provenance: [{ field: "state", path: "payload.state" }],
        },
      },
    ],
    diagnostics: [],
  };
  const serialized = canonical(exported);
  const envelope = doc(
    "host",
    `host-sessions/${wf}.json`,
    canonical({
      version: 1,
      protocol: "host-hidden-inventory-v1",
      workflowId: wf,
      host: "omp",
      hostSessionId: sessionId,
      export: { sha256: sha(serialized.slice(0, -1)), document: exported },
    }),
  );
  const attestation = doc(
    "control",
    `coverage/attestation-${wf}.json`,
    canonical({
      version: 1,
      attestedAt: "2026-09-21T00:00:00.000Z",
      operator: { actor: "operator", authorizationRef: "ref-1" },
      consumers: [
        {
          entryId: `engine-${wf}`,
          kind: "coordinator",
          entrypoint: "packages/engine/dist/engine.js",
          runtime: "node",
          runtimeVersion: "24.18.0",
          version: "3.11.2",
          current: true,
          disposition: "reloaded",
        },
      ],
      stoppedSessions: [{ sessionId, host: "omp", state: "stopped" }],
    }),
  );
  return { envelope, attestation };
}

/** One R1 consumer manifest plus the bytes its closures name. */
function consumerRow(surface: ExecutionSurface, consumer: string, capability: string, copies: boolean): Row {
  const packageRoot = consumer === "zcode" ? "hooks" : `packages/${consumer}`;
  const sourcePath = `${packageRoot}/src/index.ts`;
  const configPath = `${packageRoot}/package.json`;
  const generatedPath = `${packageRoot}/dist/index.js`;
  const sourceFile = doc("package", sourcePath, "export const index = {};");
  const configFile = doc("package", configPath, "{}");
  const generatedFile = doc("package", generatedPath, "// built");
  const copyFile = doc("package", `${packageRoot}/harness-skills/mstar-harness-core/SKILL.md`, "# copied skill\n");
  // C3's proof is a separate input: it is derived from the real bytes/kinds and
  // is never read out of the declaration below.
  const sourceSkill = doc("package", "skills/mstar-harness-core/SKILL.md", "# copied skill\n");
  const proof = {
    trees: [{ consumerId: consumer, kind: "source", root: "package", path: `${packageRoot}/src`, files: 1, sha256: fakeHex(31), witnesses: [witnessOf(sourceFile)] }],
    copies: copies
      ? [
          {
            consumerId: consumer,
            root: "package",
            sourceRoot: "skills",
            targetRoot: `${packageRoot}/harness-skills`,
            mode: "copy",
            files: 1,
            sha256: fakeHex(32),
            sourceWitnesses: [witnessOf(sourceSkill)],
            targetWitnesses: [witnessOf(copyFile)],
          },
        ]
      : [],
  };
  return {
    surface,
    workflowId: null,
    disposition: "retain",
    docs: copies ? [sourceFile, configFile, generatedFile, copyFile, sourceSkill] : [sourceFile, configFile, generatedFile],
    consumerProof: proof,
    evidence: doc(
      "package",
      `coverage/${surface}.execution-consumer.json`,
      canonical({
        version: 1,
        protocol: "consumer-v1",
        repoRoot: ".",
        consumers: [
          {
            id: consumer,
            packageRoot: consumer === "zcode" ? "." : packageRoot,
            capability,
            capabilityNote: capability === "writer" ? null : `${capability} consumer: the write path is refused and recorded as such`,
            entrypoint: generatedPath,
            runtime: { target: "node", floor: ">=24.18.0", declaration: "package-engines" },
            sources: { trees: [{ root: `${packageRoot}/src`, files: 1, sha256: fakeHex(31) }], files: [{ path: configPath, sha256: sha("{}") }] },
            generated: { trees: [], files: [{ path: generatedPath, sha256: sha("// built") }] },
            copiedInstructions: copies
              ? [{ sourceRoot: "skills", targetRoot: `${packageRoot}/harness-skills`, mode: "copy", files: 1, sha256: fakeHex(32) }]
              : [],
          },
        ],
      }),
    ),
  };
}

function rootRow(surface: ExecutionSurface): Row {
  if (surface === "core-execution") {
    return { surface, workflowId: null, disposition: "migrate", docs: [registerDoc([WORKFLOW_A, WORKFLOW_B]), snapshot(WORKFLOW_A), snapshot(WORKFLOW_B)] };
  }
  if (surface === "engine-status-snapshot") return { surface, workflowId: null, disposition: "retain", docs: [engineStatusDoc()] };
  if (surface === "cli-writer") return consumerRow(surface, "cli", "writer", false);
  if (surface === "engine-cli-package") return consumerRow(surface, "engine", "writer", false);
  if (surface === "omp-package") return consumerRow(surface, "omp", "writer", false);
  if (surface === "opencode-plugin") return consumerRow(surface, "opencode", "decision-only", false);
  if (surface === "zcode-hook") return consumerRow(surface, "zcode", "writer", false);
  if (surface === "copied-instructions") return consumerRow(surface, "dsh", "writer", true);
  if (surface === "backup-recovery") {
    const image = doc("control", "backups/store.db", "sqlite-consistent-backup");
    return {
      surface,
      workflowId: null,
      disposition: "retain",
      docs: [image],
      evidence: doc(
        "control",
        "coverage/backup-recovery.inventory.json",
        canonical({
          version: 1,
          document: "recovery-inventory",
          backup: { path: image.path, sha256: sha(image.text) },
          schemaVersion: 4,
          integrity: "verified",
          coverageDigest: fakeHex(7),
          recoveryGeneration: 2,
        }),
      ),
    };
  }
  if (surface === "artifact-store-injectors") {
    // The operator's explicit inventory: one deployed body-only module, whose
    // bytes are the row's assigned source.
    const module = doc("package", "injectors/fs-store.js", "export const store = {};");
    return {
      surface,
      workflowId: null,
      disposition: "retain",
      docs: [module],
      evidence: doc(
        "package",
        "coverage/injector-inventory.json",
        canonical({ version: 1, protocol: "injector-inventory-v1", injectors: [{ module: witnessOf(module), capability: "body-only" }] }),
      ),
    };
  }
  // `dsh-package` has nothing discovered in this fixture; `omp-hidden-entries`
  // has no producer that can populate it, so it stays absent and its row is
  // exercised explicitly in the hidden-history case below.
  return { surface, workflowId: null, disposition: "absent", docs: [] };
}

function workflowRow(surface: ExecutionSurface, workflowId: string): Row {
  if (surface === "workflow-session-envelopes") return { surface, workflowId, disposition: "migrate", docs: [sessionEnvelopeDoc(workflowId)] };
  if (surface === "workflow-notes-ledger") return { surface, workflowId, disposition: "retain", docs: [notesDoc(workflowId)] };
  if (surface === "workflow-agent-flow-ledger") return { surface, workflowId, disposition: "retain", docs: agentFlowDocs(workflowId) };
  if (surface === "workflow-ledger-cursors") {
    if (workflowId !== WORKFLOW_A) return { surface, workflowId, disposition: "absent", docs: [] };
    return { surface, workflowId, disposition: "retain", docs: [cursorDoc(workflowId)] };
  }
  if (surface === "workflow-omp-launch-journal") return { surface, workflowId, disposition: "retain", docs: [launchJournalDoc(workflowId)] };
  if (surface === "omp-hidden-entries") {
    const { envelope, attestation } = hostDocs(workflowId);
    return {
      surface,
      workflowId,
      disposition: "retain",
      docs: [envelope],
      evidence: attestation,
      hostProof: {
        sessions: [{ host: "omp", sessionId: `sess-${workflowId}`, source: witnessOf(envelope) }],
        attestation: witnessOf(attestation),
      },
    };
  }
  if (surface === "sdd-evidence") return { surface, workflowId, disposition: "retain", docs: [doc("sdd", `${workflowId}/task-1-report.md`, `# ${workflowId} report\n`)] };
  throw new Error(`workflowRow is not defined for ${surface}`);
}

function buildRows(): Row[] {
  const rows: Row[] = [];
  for (const surface of EXECUTION_COVERAGE_SURFACES) {
    if (executionCoverageSurfaceScope(surface) === "workflow") {
      rows.push(workflowRow(surface, WORKFLOW_A), workflowRow(surface, WORKFLOW_B));
      continue;
    }
    rows.push(rootRow(surface));
  }
  return rows;
}

/* ------------------------------------------------------------------ harness */

type Fixture = {
  manifest: ExecutionCoverageManifest;
  coverage: ExecutionCoverageSet;
  evidence: Map<string, Uint8Array>;
};

function safeDigest(receipts: readonly ExecutionCoverageReceipt[]): string {
  try {
    return executionCoverageDigest(receipts);
  } catch {
    return fakeHex(0);
  }
}

function register(evidence: Map<string, Uint8Array>, entry: Doc): CoverageWitness {
  const key = coverageWitnessKey(entry.root, entry.path);
  const bytes = new TextEncoder().encode(entry.text);
  const previous = evidence.get(key);
  if (previous !== undefined && new TextDecoder().decode(previous) !== entry.text) {
    throw new Error(`fixture bug: ${key} is declared with two different bodies`);
  }
  evidence.set(key, bytes);
  return witnessOf(entry);
}

function materialize(rows: Row[], options: { digest?: string; coverageManifestHash?: string } = {}): Fixture {
  const evidence = new Map<string, Uint8Array>();
  const receipts: ExecutionCoverageReceipt[] = [];
  const surfaces: Array<{ surface: ExecutionSurface; workflowId: string | null; sources: CoverageWitness[] }> = [];
  const pinned = new Map<string, CoverageWitness>();
  for (const row of rows) {
    const sources = row.docs.map((entry) => register(evidence, entry)).sort(byRootPath);
    const evidenceWitnesses = row.evidence === undefined ? [] : [register(evidence, row.evidence)];
    const receipt = buildExecutionCoverageReceipt(
      {
        surface: row.surface,
        workflowId: row.workflowId,
        disposition: row.disposition,
        manifestId: MANIFEST_ID,
        manifestHash: MANIFEST_HASH,
        storeId: STORE_ID,
        epoch: EPOCH,
        sources,
        evidence: evidenceWitnesses,
      },
      evidence,
    );
    receipts.push((row.patch ? row.patch(receipt as unknown as Record<string, unknown>) : receipt) as unknown as ExecutionCoverageReceipt);
    surfaces.push({
      surface: row.surface,
      workflowId: row.manifestWorkflowId !== undefined ? row.manifestWorkflowId : row.workflowId,
      sources,
      ...(row.consumerProof === undefined ? {} : { consumerProof: row.consumerProof }),
      ...(row.hostProof === undefined ? {} : { hostProof: row.hostProof }),
    });
    for (const witness of [...sources, ...evidenceWitnesses]) pinned.set(coverageWitnessKey(witness.root, witness.path), witness);
  }
  const inventory = doc("host", "inventory.json", legacy({ version: 1, sessions: [SESSION_A, SESSION_B] }));
  pinned.set(coverageWitnessKey(inventory.root, inventory.path), register(evidence, inventory));

  const manifest: ExecutionCoverageManifest = {
    manifestId: MANIFEST_ID,
    manifestHash: MANIFEST_HASH,
    storeId: STORE_ID,
    epoch: EPOCH,
    surfaces,
    sources: [...pinned.values()].sort(byRootPath),
  };
  const coverage: ExecutionCoverageSet = {
    version: 1,
    manifestId: MANIFEST_ID,
    manifestHash: options.coverageManifestHash ?? MANIFEST_HASH,
    receipts,
    digest: options.digest ?? safeDigest(receipts),
  };
  return { manifest, coverage, evidence };
}

function rowIndex(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null): number {
  const key = `${surface}|${workflowId ?? ""}`;
  const index = fixture.coverage.receipts.findIndex((receipt) => `${receipt.surface}|${receipt.workflowId ?? ""}` === key);
  if (index < 0) throw new Error(`fixture bug: no receipt for ${key}`);
  return index;
}

function matches(row: { surface: ExecutionSurface; workflowId: string | null }, surface: ExecutionSurface, workflowId: string | null): boolean {
  return row.surface === surface && row.workflowId === workflowId;
}

function overrideDoc(evidence: Map<string, Uint8Array>, entry: Doc): CoverageWitness {
  evidence.set(coverageWitnessKey(entry.root, entry.path), new TextEncoder().encode(entry.text));
  return witnessOf(entry);
}

function repin(fixture: Fixture, witnesses: readonly CoverageWitness[]): void {
  const pinned = new Map<string, CoverageWitness>();
  for (const witness of fixture.manifest.sources) pinned.set(coverageWitnessKey(witness.root, witness.path), witness);
  for (const witness of witnesses) pinned.set(coverageWitnessKey(witness.root, witness.path), witness);
  fixture.manifest = { ...fixture.manifest, sources: [...pinned.values()].sort(byRootPath) };
}

function assign(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null, witnesses: readonly CoverageWitness[]): void {
  fixture.manifest = {
    ...fixture.manifest,
    surfaces: fixture.manifest.surfaces.map((row) => (matches(row, surface, workflowId) ? { ...row, sources: [...witnesses] } : row)),
  };
  repin(fixture, witnesses);
}

function setReceipt(fixture: Fixture, index: number, receipt: ExecutionCoverageReceipt): void {
  const receipts = [...fixture.coverage.receipts];
  receipts[index] = receipt;
  fixture.coverage = { ...fixture.coverage, receipts, digest: safeDigest(receipts) };
}

/** Replace a row's retained bytes (the manifest assignment follows). */
function replaceRowDocuments(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null, documents: Doc[]): void {
  const index = rowIndex(fixture, surface, workflowId);
  const witnesses = documents.map((entry) => overrideDoc(fixture.evidence, entry)).sort(byRootPath);
  setReceipt(fixture, index, { ...fixture.coverage.receipts[index], sources: witnesses });
  assign(fixture, surface, workflowId, witnesses);
}

function hostProofOf(fixture: Fixture, workflowId: string): Record<string, unknown> {
  const row = fixture.manifest.surfaces.find((candidate) => candidate.surface === "omp-hidden-entries" && candidate.workflowId === workflowId);
  if (row?.hostProof === undefined) throw new Error(`fixture bug: no host proof for ${workflowId}`);
  return row.hostProof as unknown as Record<string, unknown>;
}

function setHostProof(fixture: Fixture, workflowId: string, proof: Record<string, unknown> | undefined): void {
  fixture.manifest = {
    ...fixture.manifest,
    surfaces: fixture.manifest.surfaces.map((row) =>
      matches(row, "omp-hidden-entries", workflowId)
        ? proof === undefined
          ? { surface: row.surface, workflowId: row.workflowId, sources: row.sources }
          : { ...row, hostProof: proof as unknown as ManifestRow["hostProof"] }
        : row,
    ),
  };
}

/** Recompute a row's receipt from its current bytes with the real producer entry point. */
function rebuildRow(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null): void {
  const index = rowIndex(fixture, surface, workflowId);
  const receipt = fixture.coverage.receipts[index];
  setReceipt(
    fixture,
    index,
    buildExecutionCoverageReceipt(
      {
        surface: receipt.surface,
        workflowId: receipt.workflowId,
        disposition: receipt.disposition,
        manifestId: receipt.manifestId,
        manifestHash: receipt.manifestHash,
        storeId: receipt.storeId,
        epoch: receipt.epoch,
        sources: receipt.sources,
        evidence: receipt.evidence,
      },
      fixture.evidence,
    ),
  );
}

function patchReceipt(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null, patch: (receipt: Record<string, unknown>) => Record<string, unknown>): void {
  const index = rowIndex(fixture, surface, workflowId);
  setReceipt(fixture, index, patch(fixture.coverage.receipts[index] as unknown as Record<string, unknown>) as unknown as ExecutionCoverageReceipt);
}

function consumerManifestOf(fixture: Fixture, surface: ExecutionSurface): { manifest: Record<string, unknown>; entry: Doc } {
  const witness = fixture.coverage.receipts[rowIndex(fixture, surface, null)].evidence[0];
  const text = new TextDecoder().decode(fixture.evidence.get(coverageWitnessKey(witness.root, witness.path)));
  return { manifest: JSON.parse(text) as Record<string, unknown>, entry: doc(witness.root as Doc["root"], witness.path, text) };
}

function putManifest(fixture: Fixture, surface: ExecutionSurface, manifest: Record<string, unknown>, entry: Doc): void {
  const index = rowIndex(fixture, surface, null);
  const witness = overrideDoc(fixture.evidence, doc(entry.root, entry.path, canonical(manifest)));
  setReceipt(fixture, index, { ...fixture.coverage.receipts[index], evidence: [witness] });
  repin(fixture, [witness]);
}

function proofOf(fixture: Fixture, surface: ExecutionSurface): Record<string, unknown> {
  const row = fixture.manifest.surfaces.find((candidate) => candidate.surface === surface && candidate.workflowId === null);
  if (row?.consumerProof === undefined) throw new Error(`fixture bug: no consumer proof for ${surface}`);
  return row.consumerProof as unknown as Record<string, unknown>;
}

type ManifestRow = ExecutionCoverageManifest["surfaces"][number];

function setProof(fixture: Fixture, surface: ExecutionSurface, proof: Record<string, unknown> | undefined): void {
  fixture.manifest = {
    ...fixture.manifest,
    surfaces: fixture.manifest.surfaces.map((row) =>
      matches(row, surface, null)
        ? proof === undefined
          ? { surface: row.surface, workflowId: row.workflowId, sources: row.sources }
          : { ...row, consumerProof: proof as unknown as ManifestRow["consumerProof"] }
        : row,
    ),
  };
}

function validate(fixture: Fixture): void {
  validateExecutionCoverage(fixture.manifest, fixture.coverage, fixture.evidence);
}

function refusalOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionError);
    return (error as ExecutionError).code;
  }
  throw new Error("expected a coverage refusal, but validation returned normally");
}

function stateOf(fixture: Fixture): string {
  return JSON.stringify({ manifest: fixture.manifest, coverage: fixture.coverage, evidence: [...fixture.evidence.entries()].map(([key, bytes]) => `${key}:${Buffer.from(bytes).toString("base64")}`) });
}

/** Every negative case runs this: refusal code asserted, inputs proven untouched. */
function refuseLeavingState(fixture: Fixture): void {
  const before = stateOf(fixture);
  expect(refusalOf(() => validate(fixture))).toBe(COVERAGE_CODE);
  expect(stateOf(fixture)).toBe(before);
}

describe("execution-coverage", () => {
  test("execution-coverage-released-formats-validate", () => {
    const fixture = materialize(buildRows());
    expect(fixture.manifest.surfaces.length).toBe(25);
    expect(new Set(fixture.manifest.surfaces.map((row) => row.surface)).size).toBe(18);
    expect(fixture.coverage.receipts.length).toBe(25);
    // The fixture's agent-flow tail also holds a legacy durable row (no eventId,
    // no source): it is accepted, never indexed and never re-identified.
    const tailText = new TextDecoder().decode(fixture.evidence.get(coverageWitnessKey("control", `workflows/${WORKFLOW_A}/agent-flow.jsonl`)));
    expect(tailText.split("\n").filter((line) => line.trim() !== "").length).toBe(2);
    const legacyTail = JSON.parse(tailText.split("\n")[0]) as Record<string, unknown>;
    expect(legacyTail.eventId).toBeUndefined();
    expect(legacyTail.source).toBeUndefined();
    validate(fixture);
  });

  test("execution-coverage-result-is-recomputed-from-bytes", () => {
    const fixture = materialize(buildRows());
    validate(fixture);
    const untouched = stateOf(fixture);
    patchReceipt(fixture, "workflow-notes-ledger", WORKFLOW_A, (receipt) => ({
      ...receipt,
      resultHash: digestOf({ surface: "workflow-notes-ledger", workflowId: WORKFLOW_A, disposition: "retain", facts: { files: [] } }),
    }));
    // The mutation is the only difference from the valid twin above.
    expect(stateOf(fixture)).not.toBe(untouched);
    refusalOf(() => validate(fixture));
  });

  test("execution-coverage-generic-shapes-are-not-coverage", () => {
    const valid = materialize(buildRows());
    validate(valid);

    const envelopeOnly = materialize(buildRows());
    replaceRowDocuments(envelopeOnly, "workflow-session-envelopes", WORKFLOW_A, [
      doc("control", `workflows/${WORKFLOW_A}/sessions/coordinator-${SESSION_A}.json`, legacy({ session_id: SESSION_A })),
    ]);
    refuseLeavingState(envelopeOnly);

    const emptyNote = materialize(buildRows());
    replaceRowDocuments(emptyNote, "workflow-notes-ledger", WORKFLOW_A, [doc("control", `workflows/${WORKFLOW_A}/notes.jsonl`, "{}\n")]);
    refuseLeavingState(emptyNote);

    const arbitraryCursor = materialize(buildRows());
    replaceRowDocuments(arbitraryCursor, "workflow-ledger-cursors", WORKFLOW_A, [
      doc("control", `workflows/${WORKFLOW_A}/workflow-ledger-cursors.json`, legacy({ anything: true })),
    ]);
    refuseLeavingState(arbitraryCursor);

    const arbitraryStatus = materialize(buildRows());
    replaceRowDocuments(arbitraryStatus, "engine-status-snapshot", null, [doc("control", "snapshots/engine-status.json", legacy({ anything: true }))]);
    refuseLeavingState(arbitraryStatus);

    const unknownState = materialize(buildRows());
    const journal = launchJournalDoc(WORKFLOW_A);
    const parsed = JSON.parse(journal.text) as { intents: Array<Record<string, unknown>> };
    replaceRowDocuments(unknownState, "workflow-omp-launch-journal", WORKFLOW_A, [
      doc("control", journal.path, JSON.stringify({ ...(JSON.parse(journal.text) as Record<string, unknown>), intents: [{ ...parsed.intents[0], state: "launched" }] })),
    ]);
    refuseLeavingState(unknownState);

    const unknownLedger = materialize(buildRows());
    replaceRowDocuments(unknownLedger, "workflow-agent-flow-ledger", WORKFLOW_A, [
      ...agentFlowDocs(WORKFLOW_A),
      doc("control", `workflows/${WORKFLOW_A}/agent-flow-other.jsonl`, "{}\n"),
    ]);
    refuseLeavingState(unknownLedger);
  });

  test("execution-coverage-agent-flow-index-authority", () => {
    const valid = materialize(buildRows());
    validate(valid);

    // The archived durable row is retained but its index entry is missing.
    const missingEntry = materialize(buildRows());
    const [tail, index, chunk] = agentFlowDocs(WORKFLOW_A);
    replaceRowDocuments(missingEntry, "workflow-agent-flow-ledger", WORKFLOW_A, [tail, doc("control", index.path, `${index.text.trim().split("\n")[0]}\n`), chunk]);
    refuseLeavingState(missingEntry);

    // The index entry is retained but its row is gone.
    const missingRow = materialize(buildRows());
    replaceRowDocuments(missingRow, "workflow-agent-flow-ledger", WORKFLOW_A, [tail, index]);
    refuseLeavingState(missingRow);

    // The recorded digest no longer describes the row that owns that id.
    const forgedDigest = materialize(buildRows());
    const entries = index.text.trim().split("\n").map((line) => JSON.parse(line) as { id: string; d: string });
    entries[1] = { ...entries[1], d: fakeHex(3).slice(0, 32) };
    replaceRowDocuments(forgedDigest, "workflow-agent-flow-ledger", WORKFLOW_A, [tail, doc("control", index.path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`), chunk]);
    refuseLeavingState(forgedDigest);

    // The id no longer matches the bytes of the row it names (a mis-bound entry).
    const misBound = materialize(buildRows());
    const swapped = [
      { ...entries[0], d: entries[1].d },
      { ...entries[1], d: entries[0].d },
    ];
    replaceRowDocuments(misBound, "workflow-agent-flow-ledger", WORKFLOW_A, [tail, doc("control", index.path, `${swapped.map((entry) => JSON.stringify(entry)).join("\n")}\n`), chunk]);
    refuseLeavingState(misBound);

    // The durable source tuple changed while the carried id stayed put.
    const tupleDrift = materialize(buildRows());
    replaceRowDocuments(tupleDrift, "workflow-agent-flow-ledger", WORKFLOW_A, [
      doc("control", tail.path, `${durableLine(WORKFLOW_A, "workflow-run", 1, { source: { sessionId: SESSION_A, streamId: STREAM_A, seq: 3 } })}\n`),
      index,
      chunk,
    ]);
    refuseLeavingState(tupleDrift);

    // Only one of the two identity fields: neither a legacy row nor an identified one.
    const partialId = materialize(buildRows());
    replaceRowDocuments(partialId, "workflow-agent-flow-ledger", WORKFLOW_A, [
      doc("control", tail.path, `${durableLine(WORKFLOW_A, "workflow-run", 1, { source: undefined })}\n`),
      index,
      chunk,
    ]);
    refuseLeavingState(partialId);

    const partialSource = materialize(buildRows());
    replaceRowDocuments(partialSource, "workflow-agent-flow-ledger", WORKFLOW_A, [
      doc("control", tail.path, `${durableLine(WORKFLOW_A, "workflow-run", 1, { eventId: undefined })}\n`),
      index,
      chunk,
    ]);
    refuseLeavingState(partialSource);

    // F2's durable position bound: seq is an integer in [0, 2^31).
    const beyondBound = materialize(buildRows());
    replaceRowDocuments(beyondBound, "workflow-agent-flow-ledger", WORKFLOW_A, [
      doc("control", tail.path, `${durableLine(WORKFLOW_A, "workflow-run", 2 ** 31)}\n`),
      index,
      chunk,
    ]);
    refuseLeavingState(beyondBound);

    // Companions of two workflow dirs are not one retained ledger.
    const foreignDir = materialize(buildRows());
    const foreignDocs = agentFlowDocs(WORKFLOW_B);
    replaceRowDocuments(foreignDir, "workflow-agent-flow-ledger", WORKFLOW_A, [tail, foreignDocs[1], chunk]);
    refuseLeavingState(foreignDir);
  });

  test("execution-coverage-consumer-manifest-is-r1s", () => {
    const valid = materialize(buildRows());
    validate(valid);

    const wrongCapability = materialize(buildRows());
    const cli = consumerManifestOf(wrongCapability, "cli-writer");
    const consumers = cli.manifest.consumers as Array<Record<string, unknown>>;
    putManifest(wrongCapability, "cli-writer", { ...cli.manifest, consumers: [{ ...consumers[0], capability: "read-only", capabilityNote: "pretends otherwise" }] }, cli.entry);
    refuseLeavingState(wrongCapability);

    const foreignConsumer = materialize(buildRows());
    const foreign = consumerManifestOf(foreignConsumer, "cli-writer");
    const foreignEntries = foreign.manifest.consumers as Array<Record<string, unknown>>;
    putManifest(foreignConsumer, "cli-writer", { ...foreign.manifest, consumers: [{ ...foreignEntries[0], id: "zcode" }] }, foreign.entry);
    refuseLeavingState(foreignConsumer);

    const inventedShape = materialize(buildRows());
    const invented = consumerManifestOf(inventedShape, "cli-writer");
    putManifest(inventedShape, "cli-writer", { version: 1, document: "consumer-manifest", surface: "cli-writer", entries: [] }, invented.entry);
    refuseLeavingState(inventedShape);

    const missingEntrypoint = materialize(buildRows());
    const zcode = consumerManifestOf(missingEntrypoint, "zcode-hook");
    const zcodeEntries = zcode.manifest.consumers as Array<Record<string, unknown>>;
    putManifest(missingEntrypoint, "zcode-hook", { ...zcode.manifest, consumers: [{ ...zcodeEntries[0], generated: { trees: [], files: [] } }] }, zcode.entry);
    refuseLeavingState(missingEntrypoint);

    // A populated consumer row without C3's proof is never self-certified.
    const noProof = materialize(buildRows());
    setProof(noProof, "cli-writer", undefined);
    refuseLeavingState(noProof);

    // The declaration was tampered with AND its receipt rebuilt from those bytes,
    // so only the unchanged C3 proof can refuse it.
    const tampered = materialize(buildRows());
    const tamperEntry = consumerManifestOf(tampered, "cli-writer");
    const tamperConsumers = tamperEntry.manifest.consumers as Array<Record<string, unknown>>;
    const tamperSources = tamperConsumers[0].sources as { trees: Array<Record<string, unknown>>; files: unknown[] };
    putManifest(
      tampered,
      "cli-writer",
      { ...tamperEntry.manifest, consumers: [{ ...tamperConsumers[0], sources: { ...tamperSources, trees: [{ ...tamperSources.trees[0], sha256: fakeHex(99) }] } }] },
      tamperEntry.entry,
    );
    rebuildRow(tampered, "cli-writer", null);
    refuseLeavingState(tampered);

    // source and generated kinds are never interchangeable.
    const swappedKind = materialize(buildRows());
    const kindProof = proofOf(swappedKind, "cli-writer");
    setProof(swappedKind, "cli-writer", { ...kindProof, trees: [{ ...(kindProof.trees as Array<Record<string, unknown>>)[0], kind: "generated" }] });
    refuseLeavingState(swappedKind);

    // A proof tree the declaration does not describe.
    const extraTree = materialize(buildRows());
    const extraProof = proofOf(extraTree, "cli-writer");
    setProof(extraTree, "cli-writer", {
      ...extraProof,
      trees: [...(extraProof.trees as unknown[]), { consumerId: "cli", kind: "generated", root: "package", path: "packages/cli/dist", files: 1, sha256: fakeHex(77), witnesses: [] }],
    });
    refuseLeavingState(extraTree);

    // A proof entry for another consumer id.
    const foreignId = materialize(buildRows());
    const foreignProof = proofOf(foreignId, "cli-writer");
    setProof(foreignId, "cli-writer", { ...foreignProof, trees: [{ ...(foreignProof.trees as Array<Record<string, unknown>>)[0], consumerId: "omp" }] });
    refuseLeavingState(foreignId);

    // A tree witness count that does not match the recorded entry count.
    const wrongCount = materialize(buildRows());
    const countProof = proofOf(wrongCount, "cli-writer");
    setProof(wrongCount, "cli-writer", {
      ...countProof,
      trees: [{ ...(countProof.trees as Array<Record<string, unknown>>)[0], files: 2 }],
    });
    refuseLeavingState(wrongCount);

    // A tree witness taken from another root.
    const foreignRoot = materialize(buildRows());
    const rootProof = proofOf(foreignRoot, "cli-writer");
    setProof(foreignRoot, "cli-writer", {
      ...rootProof,
      trees: [{ ...(rootProof.trees as Array<Record<string, unknown>>)[0], root: "control" }],
    });
    refuseLeavingState(foreignRoot);

    // A tree witness outside the tree's own root path.
    const outsideTree = materialize(buildRows());
    const outsideProof = proofOf(outsideTree, "cli-writer");
    setProof(outsideTree, "cli-writer", {
      ...outsideProof,
      trees: [{ ...(outsideProof.trees as Array<Record<string, unknown>>)[0], path: "packages/cli/other" }],
    });
    refuseLeavingState(outsideTree);

    // Copy parity: the target side renames one entry, so a suffix has no pair.
    const copyMismatch = materialize(buildRows());
    const copyProof = proofOf(copyMismatch, "copied-instructions");
    const copyEntry = (copyProof.copies as Array<Record<string, unknown>>)[0];
    setProof(copyMismatch, "copied-instructions", {
      ...copyProof,
      copies: [
        {
          ...copyEntry,
          targetWitnesses: [{ root: "package", path: "packages/dsh/harness-skills/mstar-harness-core/RENAMED.md", sha256: sha("# copied skill\n") }],
        },
      ],
    });
    refuseLeavingState(copyMismatch);

    // Copy parity: the two sides pair the same suffix with different bytes.
    const copyBytes = materialize(buildRows());
    const copyBytesProof = proofOf(copyBytes, "copied-instructions");
    const copyBytesEntry = (copyBytesProof.copies as Array<Record<string, unknown>>)[0];
    setProof(copyBytes, "copied-instructions", {
      ...copyBytesProof,
      copies: [
        {
          ...copyBytesEntry,
          targetWitnesses: [{ root: "package", path: "packages/dsh/harness-skills/mstar-harness-core/SKILL.md", sha256: fakeHex(55) }],
        },
      ],
    });
    refuseLeavingState(copyBytes);

    // Copy parity: an extra target entry no source entry pairs with.
    const copyExtra = materialize(buildRows());
    const copyExtraProof = proofOf(copyExtra, "copied-instructions");
    const copyExtraEntry = (copyExtraProof.copies as Array<Record<string, unknown>>)[0];
    setProof(copyExtra, "copied-instructions", {
      ...copyExtraProof,
      copies: [
        {
          ...copyExtraEntry,
          targetWitnesses: [
            ...(copyExtraEntry.targetWitnesses as unknown[]),
            { root: "package", path: "packages/dsh/harness-skills/mstar-harness-core/EXTRA.md", sha256: fakeHex(56) },
          ],
        },
      ],
    });
    refuseLeavingState(copyExtra);

    // An assigned file under a declared tree root that neither the declaration
    // nor the proof lists: a prefix never excuses an unlisted file.
    const unlisted = materialize(buildRows());
    replaceRowDocuments(unlisted, "cli-writer", null, [
      doc("package", "packages/cli/src/index.ts", "export const index = {};"),
      doc("package", "packages/cli/src/extra.ts", "export const extra = {};"),
      doc("package", "packages/cli/package.json", "{}"),
      doc("package", "packages/cli/dist/index.js", "// built"),
    ]);
    refuseLeavingState(unlisted);
  });

  test("execution-coverage-injector-inventory-is-exact", () => {
    const valid = materialize(buildRows());
    validate(valid);

    // The listed module bytes changed since the inventory was written.
    const changed = materialize(buildRows());
    changed.evidence.set(coverageWitnessKey("package", "injectors/fs-store.js"), new TextEncoder().encode("export const store = { changed: true };"));
    refuseLeavingState(changed);

    const listed = { module: witnessOf(doc("package", "injectors/fs-store.js", "export const store = {};")), capability: "body-only" };

    const unknownCapability = materialize(buildRows());
    const capabilityEntry = consumerManifestOf(unknownCapability, "artifact-store-injectors");
    putManifest(unknownCapability, "artifact-store-injectors", { version: 1, protocol: "injector-inventory-v1", injectors: [{ ...listed, capability: "writer" }] }, capabilityEntry.entry);
    refuseLeavingState(unknownCapability);

    const duplicateModule = materialize(buildRows());
    const duplicateEntry = consumerManifestOf(duplicateModule, "artifact-store-injectors");
    putManifest(duplicateModule, "artifact-store-injectors", { version: 1, protocol: "injector-inventory-v1", injectors: [listed, listed] }, duplicateEntry.entry);
    refuseLeavingState(duplicateModule);

    // An unlisted module assigned beside the listed one (surplus source).
    const surplus = materialize(buildRows());
    replaceRowDocuments(surplus, "artifact-store-injectors", null, [
      doc("package", "injectors/fs-store.js", "export const store = {};"),
      doc("package", "injectors/other-store.js", "export const other = {};"),
    ]);
    refuseLeavingState(surplus);

    // A listed module that is not assigned at all.
    const unassigned = materialize(buildRows());
    const unassignedEntry = consumerManifestOf(unassigned, "artifact-store-injectors");
    putManifest(unassigned, "artifact-store-injectors", { version: 1, protocol: "injector-inventory-v1", injectors: [{ module: { root: "package", path: "injectors/missing.js", sha256: fakeHex(41) }, capability: "body-only" }] }, unassignedEntry.entry);
    refuseLeavingState(unassigned);

    // An empty inventory is discovery-absent evidence, not a retained row.
    const empty = materialize(buildRows());
    const emptyEntry = consumerManifestOf(empty, "artifact-store-injectors");
    putManifest(empty, "artifact-store-injectors", { version: 1, protocol: "injector-inventory-v1", injectors: [] }, emptyEntry.entry);
    refuseLeavingState(empty);
  });

  test("execution-coverage-host-inventory-is-proved", () => {
    // The baseline row IS the positive: a real H2 envelope plus the pinned attestation.
    const valid = materialize(buildRows());
    validate(valid);

    // No proof: a receipt never chooses its own session set.
    const noProof = materialize(buildRows());
    setHostProof(noProof, WORKFLOW_A, undefined);
    refuseLeavingState(noProof);

    // A proof entry the row does not assign as a session envelope.
    const extraSession = materialize(buildRows());
    const proof = hostProofOf(extraSession, WORKFLOW_A);
    setHostProof(extraSession, WORKFLOW_A, {
      ...proof,
      sessions: [
        ...(proof.sessions as unknown[]),
        { host: "omp", sessionId: SESSION_B, source: { root: "host", path: `host-sessions/${WORKFLOW_B}.json`, sha256: fakeHex(61) } },
      ],
    });
    refuseLeavingState(extraSession);

    // The envelope carries a different host session than the proof claims.
    const foreignSession = materialize(buildRows());
    const foreignProof = hostProofOf(foreignSession, WORKFLOW_A);
    setHostProof(foreignSession, WORKFLOW_A, {
      ...foreignProof,
      sessions: [{ host: "omp", sessionId: SESSION_B, source: (foreignProof.sessions as Array<Record<string, unknown>>)[0].source }],
    });
    refuseLeavingState(foreignSession);

    const { envelope, attestation } = hostDocs(WORKFLOW_A);

    // The pinned attestation does not quiesce this session.
    const unquiesced = materialize(buildRows());
    const parsed = JSON.parse(attestation.text) as Record<string, unknown>;
    const unquiescedDoc = doc("control", attestation.path, canonical({ ...parsed, stoppedSessions: [] }));
    const unquiescedIndex = rowIndex(unquiesced, "omp-hidden-entries", WORKFLOW_A);
    const unquiescedWitness = overrideDoc(unquiesced.evidence, unquiescedDoc);
    setReceipt(unquiesced, unquiescedIndex, { ...unquiesced.coverage.receipts[unquiescedIndex], evidence: [unquiescedWitness] });
    repin(unquiesced, [unquiescedWitness]);
    setHostProof(unquiesced, WORKFLOW_A, {
      sessions: [{ host: "omp", sessionId: SESSION_A, source: witnessOf(envelope) }],
      attestation: unquiescedWitness,
    });
    refuseLeavingState(unquiesced);

    // An attestation the existing contract rejects outright.
    const invalidAttestation = materialize(buildRows());
    const invalid = JSON.parse(attestation.text) as Record<string, unknown>;
    const invalidDoc = doc("control", attestation.path, canonical({ ...invalid, stoppedSessions: [{ sessionId: SESSION_A, host: "omp", state: "running" }] }));
    const invalidIndex = rowIndex(invalidAttestation, "omp-hidden-entries", WORKFLOW_A);
    const invalidWitness = overrideDoc(invalidAttestation.evidence, invalidDoc);
    setReceipt(invalidAttestation, invalidIndex, { ...invalidAttestation.coverage.receipts[invalidIndex], evidence: [invalidWitness] });
    repin(invalidAttestation, [invalidWitness]);
    setHostProof(invalidAttestation, WORKFLOW_A, {
      sessions: [{ host: "omp", sessionId: SESSION_A, source: witnessOf(envelope) }],
      attestation: invalidWitness,
    });
    refuseLeavingState(invalidAttestation);

    // An absent row may not carry a populated proof.
    const absentWithProof = materialize(buildRows());
    assign(absentWithProof, "omp-hidden-entries", WORKFLOW_A, []);
    patchReceipt(absentWithProof, "omp-hidden-entries", WORKFLOW_A, (receipt) => ({ ...receipt, disposition: "absent", sources: [], evidence: [] }));
    refuseLeavingState(absentWithProof);
  });

  test("execution-coverage-assignment-binds-sources-to-a-row", () => {
    const valid = materialize(buildRows());
    validate(valid);

    const borrowed = materialize(buildRows());
    const alphaNotes = valid.coverage.receipts[rowIndex(valid, "workflow-notes-ledger", WORKFLOW_A)].sources;
    patchReceipt(borrowed, "workflow-notes-ledger", WORKFLOW_B, (receipt) => ({ ...receipt, sources: alphaNotes }));
    refuseLeavingState(borrowed);

    // A source the hashed manifest assigns to two rows is legitimate.
    const shared = materialize(buildRows());
    const alphaBody = doc("sdd", `${WORKFLOW_A}/task-1-report.md`, `# ${WORKFLOW_A} report\n`);
    replaceRowDocuments(shared, "sdd-evidence", WORKFLOW_B, [alphaBody]);
    rebuildRow(shared, "sdd-evidence", WORKFLOW_B);
    validate(shared);

    const unassigned = materialize(buildRows());
    assign(unassigned, "workflow-notes-ledger", WORKFLOW_A, []);
    refuseLeavingState(unassigned);

    const foreignEnvelope = materialize(buildRows());
    replaceRowDocuments(foreignEnvelope, "workflow-session-envelopes", WORKFLOW_A, [
      doc("control", `workflows/${WORKFLOW_A}/sessions/coordinator-${SESSION_A}.json`, legacy({ schema_version: 1, role: "coordinator", session_id: SESSION_A, workflow_id: WORKFLOW_B, harness_root: "/harness" })),
    ]);
    refuseLeavingState(foreignEnvelope);
  });

  test("execution-coverage-core-and-workflow-set-boundaries", () => {
    const valid = materialize(buildRows());
    validate(valid);

    const duplicateRegister = materialize(buildRows());
    replaceRowDocuments(duplicateRegister, "core-execution", null, [registerDoc([WORKFLOW_A, WORKFLOW_A]), snapshot(WORKFLOW_A)]);
    refuseLeavingState(duplicateRegister);

    const omittedSibling = materialize(buildRows().filter((row) => row.workflowId !== WORKFLOW_B));
    refuseLeavingState(omittedSibling);
  });

  test("execution-coverage-produced-documents-must-be-canonical", () => {
    const valid = materialize(buildRows());
    validate(valid);

    const duplicated = materialize(buildRows());
    const cli = consumerManifestOf(duplicated, "cli-writer");
    const index = rowIndex(duplicated, "cli-writer", null);
    const witness = overrideDoc(duplicated.evidence, doc(cli.entry.root, cli.entry.path, '{"version":1,"protocol":"consumer-v1","repoRoot":".","consumers":[],"repoRoot":"."}\n'));
    setReceipt(duplicated, index, { ...duplicated.coverage.receipts[index], evidence: [witness] });
    repin(duplicated, [witness]);
    refuseLeavingState(duplicated);
  });

  test("execution-coverage-binding-identity-and-pin-boundaries", () => {
    const valid = materialize(buildRows());
    validate(valid);

    const unknownProtocol = materialize(buildRows());
    patchReceipt(unknownProtocol, "workflow-notes-ledger", WORKFLOW_A, (receipt) => ({ ...receipt, protocol: "notes-v9" }));
    refuseLeavingState(unknownProtocol);

    const staleEpoch = materialize(buildRows());
    patchReceipt(staleEpoch, "workflow-notes-ledger", WORKFLOW_A, (receipt) => ({ ...receipt, epoch: EPOCH + 1 }));
    refuseLeavingState(staleEpoch);

    const rebinding = materialize(buildRows(), { coverageManifestHash: fakeHex(98) });
    refuseLeavingState(rebinding);

    const duplicateRows = materialize(buildRows());
    const position = rowIndex(duplicateRows, "workflow-notes-ledger", WORKFLOW_A);
    const receipts = [...duplicateRows.coverage.receipts];
    receipts.splice(position + 1, 0, receipts[position]);
    duplicateRows.coverage = { ...duplicateRows.coverage, receipts, digest: safeDigest(receipts) };
    refuseLeavingState(duplicateRows);

    const unordered = materialize(buildRows());
    const coreIndex = rowIndex(unordered, "core-execution", null);
    const reordered = [...unordered.coverage.receipts];
    reordered[coreIndex] = { ...reordered[coreIndex], sources: [...reordered[coreIndex].sources].reverse() };
    unordered.coverage = { ...unordered.coverage, receipts: reordered, digest: safeDigest(reordered) };
    refuseLeavingState(unordered);

    const unseen: CoverageWitness = { root: "control", path: "unpinned/extra.json", sha256: fakeHex(11) };
    const unpinned = materialize(buildRows());
    const notesIndex = rowIndex(unpinned, "workflow-notes-ledger", WORKFLOW_A);
    const withExtra = [...unpinned.coverage.receipts[notesIndex].sources, unseen].sort(byRootPath);
    setReceipt(unpinned, notesIndex, { ...unpinned.coverage.receipts[notesIndex], sources: withExtra });
    assign(unpinned, "workflow-notes-ledger", WORKFLOW_A, withExtra);
    refuseLeavingState(unpinned);

    const traversal = materialize(buildRows());
    assign(traversal, "workflow-notes-ledger", WORKFLOW_A, [{ root: "control", path: "../escape.json", sha256: fakeHex(12) }]);
    refuseLeavingState(traversal);

    const absolute = materialize(buildRows());
    assign(absolute, "workflow-notes-ledger", WORKFLOW_A, [{ root: "control", path: "/etc/passwd", sha256: fakeHex(13) }]);
    refuseLeavingState(absolute);

    const changedBytes = materialize(buildRows());
    changedBytes.evidence.set(coverageWitnessKey("control", `workflows/${WORKFLOW_A}/notes.jsonl`), new TextEncoder().encode("{}\n"));
    const before = JSON.stringify(changedBytes.manifest);
    refusalOf(() => validate(changedBytes));
    expect(JSON.stringify(changedBytes.manifest)).toBe(before);

    const digestMismatch = materialize(buildRows(), { digest: fakeHex(1) });
    refusalOf(() => validate(digestMismatch));
  });

  test("execution-coverage-absent-rows-carry-no-result", () => {
    const valid = materialize(buildRows());
    validate(valid);

    const withSources = materialize(buildRows());
    replaceRowDocuments(withSources, "dsh-package", null, [doc("package", "packages/dsh/package.json", "{}")]);
    refuseLeavingState(withSources);

    const borrowedResult = materialize(buildRows());
    patchReceipt(borrowedResult, "dsh-package", null, (receipt) => ({ ...receipt, resultHash: fakeHex(21) }));
    refusalOf(() => validate(borrowedResult));
  });

  test("execution-coverage-purity-holds-on-accept-and-refuse", () => {
    const valid = materialize(buildRows());
    const before = stateOf(valid);
    validate(valid);
    expect(stateOf(valid)).toBe(before);

    const broken = materialize(buildRows());
    broken.evidence.set(coverageWitnessKey("control", `workflows/${WORKFLOW_A}/notes.jsonl`), new TextEncoder().encode("{}\n"));
    const brokenBefore = stateOf(broken);
    expect(refusalOf(() => validate(broken))).toBe(COVERAGE_CODE);
    expect(stateOf(broken)).toBe(brokenBefore);
  });

  test("execution-coverage-surface-roles-are-closed", () => {
    expect(executionCoverageSurfaceScope("core-execution")).toBe("root");
    expect(executionCoverageSurfaceScope("cli-writer")).toBe("root");
    expect(executionCoverageSurfaceScope("copied-instructions")).toBe("root");
    expect(executionCoverageSurfaceScope("sdd-evidence")).toBe("workflow");
    expect(executionCoverageSurfaceScope("omp-hidden-entries")).toBe("workflow");
    expect(executionCoverageSurfaceScope("workflow-agent-flow-ledger")).toBe("workflow");
  });
});
