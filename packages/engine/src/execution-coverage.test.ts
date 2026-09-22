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
  /** A whole-receipt override, applied after the producer built a consistent receipt. */
  patch?: (receipt: Record<string, unknown>) => Record<string, unknown>;
  /** The workflowId the manifest lists for this row, when it must differ from the receipt's. */
  manifestWorkflowId?: string | null;
};

/* ------------------------------------------------------------------ fixtures */

function snapshot(wf: string): Doc {
  return doc("control", `workflows/${wf}/snapshot.json`, legacy({ schema_version: 1, id: wf, type: "plan", status: "running", started_at: "2026-09-21T00:00:00.000Z" }));
}

function rootRegisterDoc(): Doc {
  return doc(
    "control",
    "status.json",
    legacy({
      version: 2,
      updated_at: "2026-09-21T00:00:00.000Z",
      workflows: [WORKFLOW_A, WORKFLOW_B].map((id) => ({ id, type: "plan", started_at: "2026-09-21T00:00:00.000Z", dir: `workflows/${id}` })),
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

/** The released durable workflow-event row and the index line that dedups it. */
function agentFlowDocs(wf: string): Doc[] {
  const sessionId = `sess-${wf}`;
  const stream = wf === WORKFLOW_A ? STREAM_A : `s1-${"b".repeat(32)}`;
  const tailLine = JSON.stringify({ v: 1, ts: 1, kind: "workflow-run", runId: `run-${wf}`, name: `run of ${wf}` });
  const chunkLine = JSON.stringify({ v: 1, ts: 2, kind: "workflow-agent", runId: `run-${wf}`, seq: 1, label: "member", childId: `child-${wf}` });
  const indexLines = [
    JSON.stringify({ id: `wfe1:workflow-run:${sessionId}:${stream}:1`, d: sha(tailLine).slice(0, 32) }),
    JSON.stringify({ id: `wfe1:workflow-agent:${sessionId}:${stream}:2`, d: sha(chunkLine).slice(0, 32) }),
  ];
  return [
    doc("control", `workflows/${wf}/agent-flow.jsonl`, `${tailLine}\n`),
    doc("control", `workflows/${wf}/agent-flow-ids.jsonl`, `${indexLines.join("\n")}\n`),
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

function hostHistoryDoc(wf: string): Doc {
  const payload = { workflowId: wf, state: "pending", operationId: `op-${wf}` };
  return doc(
    "host",
    `host-history/${wf}.json`,
    canonical({
      version: 1,
      document: "execution-host-history",
      records: [
        {
          index: 0,
          entryId: `entry-${wf}`,
          type: "mstar:phase2",
          sessionId: `sess-${wf}`,
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
    }),
  );
}

/** One R1 consumer manifest plus the bytes its closures name. */
function consumerRow(surface: ExecutionSurface, consumer: string, capability: string, copies: boolean): Row {
  const packageRoot = `packages/${consumer === "zcode" ? "" : consumer}`.replace(/\/$/, "") || "hooks";
  const sourcePath = `${packageRoot}/src/index.ts`;
  const configPath = `${packageRoot}/package.json`;
  const generatedPath = `${packageRoot}/dist/index.js`;
  const manifest = {
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
        sources: {
          trees: [{ root: `${packageRoot}/src`, files: 1, sha256: fakeHex(31) }],
          files: [{ path: configPath, sha256: sha("{}") }],
        },
        generated: { trees: [], files: [{ path: generatedPath, sha256: sha("// built") }] },
        copiedInstructions: copies
          ? [{ sourceRoot: "skills", targetRoot: `${packageRoot}/harness-skills`, mode: "copy", files: 3, sha256: fakeHex(32) }]
          : [],
      },
    ],
  };
  return {
    surface,
    workflowId: null,
    disposition: "retain",
    docs: [doc("package", sourcePath, "export const index = {};"), doc("package", configPath, "{}"), doc("package", generatedPath, "// built")],
    evidence: doc("package", `coverage/${surface}.execution-consumer.json`, canonical(manifest)),
  };
}

function rootRow(surface: ExecutionSurface): Row {
  if (surface === "core-execution") {
    return { surface, workflowId: null, disposition: "migrate", docs: [rootRegisterDoc(), snapshot(WORKFLOW_A), snapshot(WORKFLOW_B)] };
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
  // `dsh-package` and `artifact-store-injectors`: nothing discovered in this
  // fixture (the injector surface has no reviewed producer to populate it).
  return { surface, workflowId: null, disposition: "absent", docs: [] };
}

function workflowRow(surface: ExecutionSurface, workflowId: string): Row {
  const dir = `workflows/${workflowId}`;
  if (surface === "workflow-session-envelopes") return { surface, workflowId, disposition: "migrate", docs: [sessionEnvelopeDoc(workflowId)] };
  if (surface === "workflow-notes-ledger") return { surface, workflowId, disposition: "retain", docs: [notesDoc(workflowId)] };
  if (surface === "workflow-agent-flow-ledger") return { surface, workflowId, disposition: "retain", docs: agentFlowDocs(workflowId) };
  if (surface === "workflow-ledger-cursors") {
    if (workflowId !== WORKFLOW_A) return { surface, workflowId, disposition: "absent", docs: [] };
    return { surface, workflowId, disposition: "retain", docs: [cursorDoc(workflowId)] };
  }
  if (surface === "workflow-omp-launch-journal") return { surface, workflowId, disposition: "retain", docs: [launchJournalDoc(workflowId)] };
  // H1's export alone is not complete retain coverage (the H2 wrapper is missing), so a
  // populated row cannot be produced here; the refusal cases populate it explicitly.
  if (surface === "omp-hidden-entries") return { surface, workflowId, disposition: "absent", docs: [] };
  if (surface === "sdd-evidence") return { surface, workflowId, disposition: "retain", docs: [doc("sdd", `${workflowId}/task-1-report.md`, `# ${workflowId} report\n`)] };
  throw new Error(`workflowRow is not defined for ${surface} (${dir})`);
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

function setReceipt(fixture: Fixture, index: number, receipt: ExecutionCoverageReceipt): void {
  const receipts = [...fixture.coverage.receipts];
  receipts[index] = receipt;
  fixture.coverage = { ...fixture.coverage, receipts, digest: safeDigest(receipts) };
}

/** Replace a row's retained sources (as a re-discovery would) and follow it with the manifest assignment. */
function replaceRowDocuments(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null, documents: Doc[]): void {
  const index = rowIndex(fixture, surface, workflowId);
  const witnesses = documents.map((entry) => overrideDoc(fixture.evidence, entry)).sort(byRootPath);
  setReceipt(fixture, index, { ...fixture.coverage.receipts[index], sources: witnesses });
  fixture.manifest = {
    ...fixture.manifest,
    surfaces: fixture.manifest.surfaces.map((row) => (matches(row, surface, workflowId) ? { ...row, sources: witnesses } : row)),
  };
  repin(fixture, witnesses);
}

/** Replace a row's bounded export document, keeping the receipt's shape. */
function replaceRowEvidence(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null, document: Doc): void {
  const index = rowIndex(fixture, surface, workflowId);
  const witness = overrideDoc(fixture.evidence, document);
  setReceipt(fixture, index, { ...fixture.coverage.receipts[index], evidence: [witness] });
  repin(fixture, [witness]);
}

/** Patch the manifest's assignment for one row, leaving the receipt alone. */
function patchAssignment(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null, witnesses: readonly CoverageWitness[]): void {
  fixture.manifest = {
    ...fixture.manifest,
    surfaces: fixture.manifest.surfaces.map((row) => (matches(row, surface, workflowId) ? { ...row, sources: [...witnesses] } : row)),
  };
}

function patchReceipt(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null, patch: (receipt: Record<string, unknown>) => Record<string, unknown>): void {
  const index = rowIndex(fixture, surface, workflowId);
  setReceipt(fixture, index, patch(fixture.coverage.receipts[index] as unknown as Record<string, unknown>) as unknown as ExecutionCoverageReceipt);
}

function witnessesFor(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null): readonly CoverageWitness[] {
  return fixture.coverage.receipts[rowIndex(fixture, surface, workflowId)].sources;
}

function validate(fixture: Fixture): void {
  validateExecutionCoverage(fixture.manifest, fixture.coverage, fixture.evidence);
}

function refusalOf(run: () => void): ExecutionError {
  try {
    run();
  } catch (error) {
    return error as ExecutionError;
  }
  throw new Error("expected a coverage refusal, but validation returned normally");
}

function evidenceSnapshot(evidence: Map<string, Uint8Array>): string {
  return [...evidence.entries()].map(([key, bytes]) => `${key}=${Buffer.from(bytes).toString("base64")}`).join("\n");
}

/** A canonical document with `overrides` applied, for producer-shape mutations. */
function manifestOf(fixture: Fixture, surface: ExecutionSurface): { consumer: Record<string, unknown>; doc: Doc } {
  const index = rowIndex(fixture, surface, null);
  const witness = fixture.coverage.receipts[index].evidence[0];
  const text = new TextDecoder().decode(fixture.evidence.get(coverageWitnessKey(witness.root, witness.path)));
  return { consumer: JSON.parse(text) as Record<string, unknown>, doc: doc(witness.root as Doc["root"], witness.path, text) };
}

describe("execution-coverage", () => {
  test("execution-coverage-released-formats-validate", () => {
    const fixture = materialize(buildRows());
    expect(fixture.manifest.surfaces.length).toBe(25);
    expect(new Set(fixture.manifest.surfaces.map((row) => row.surface)).size).toBe(18);
    expect(fixture.coverage.receipts.length).toBe(25);
    validate(fixture);
  });

  test("execution-coverage-receipt-result-is-recomputed-from-bytes", () => {
    const invented = materialize(buildRows());
    patchReceipt(invented, "workflow-notes-ledger", WORKFLOW_A, (receipt) => ({
      ...receipt,
      resultHash: digestOf({ surface: "workflow-notes-ledger", workflowId: WORKFLOW_A, disposition: "retain", facts: { files: [] } }),
    }));
    expect(refusalOf(() => validate(invented)).message).toContain("recomputed from its bytes");
  });

  test("execution-coverage-generic-shapes-are-not-coverage", () => {
    const envelopeOnly = materialize(buildRows());
    replaceRowDocuments(envelopeOnly, "workflow-session-envelopes", WORKFLOW_A, [
      doc("control", `workflows/${WORKFLOW_A}/sessions/coordinator-${SESSION_A}.json`, legacy({ session_id: SESSION_A })),
    ]);
    expect(refusalOf(() => validate(envelopeOnly)).message).toContain("must carry schema_version, role, session_id, workflow_id, harness_root");

    const emptyNote = materialize(buildRows());
    replaceRowDocuments(emptyNote, "workflow-notes-ledger", WORKFLOW_A, [doc("control", `workflows/${WORKFLOW_A}/notes.jsonl`, "{}\n")]);
    expect(refusalOf(() => validate(emptyNote)).message).toContain("must carry exactly kind, ts, text");

    const arbitraryCursor = materialize(buildRows());
    replaceRowDocuments(arbitraryCursor, "workflow-ledger-cursors", WORKFLOW_A, [
      doc("control", `workflows/${WORKFLOW_A}/workflow-ledger-cursors.json`, legacy({ anything: true })),
    ]);
    expect(refusalOf(() => validate(arbitraryCursor)).message).toContain("must carry exactly v, cursors");

    const arbitraryStatus = materialize(buildRows());
    replaceRowDocuments(arbitraryStatus, "engine-status-snapshot", null, [doc("control", "snapshots/engine-status.json", legacy({ anything: true }))]);
    expect(refusalOf(() => validate(arbitraryStatus)).message).toContain("must carry sv, entries");

    const unknownState = materialize(buildRows());
    const journal = launchJournalDoc(WORKFLOW_A);
    replaceRowDocuments(unknownState, "workflow-omp-launch-journal", WORKFLOW_A, [
      doc("control", journal.path, JSON.stringify({ ...JSON.parse(journal.text), intents: [{ ...JSON.parse(journal.text).intents[0], state: "launched" }] })),
    ]);
    expect(refusalOf(() => validate(unknownState)).message).toContain("state must be one of");

    const unknownLedger = materialize(buildRows());
    replaceRowDocuments(unknownLedger, "workflow-agent-flow-ledger", WORKFLOW_A, [
      ...agentFlowDocs(WORKFLOW_A),
      doc("control", `workflows/${WORKFLOW_A}/agent-flow-other.jsonl`, "{}\n"),
    ]);
    expect(refusalOf(() => validate(unknownLedger)).message).toContain("an unknown companion of the ledger is never coverage");
  });

  test("execution-coverage-agent-flow-index-is-required-authority", () => {
    // A durable row retained without its identity index is not complete coverage.
    const noIndex = materialize(buildRows());
    replaceRowDocuments(noIndex, "workflow-agent-flow-ledger", WORKFLOW_A, agentFlowDocs(WORKFLOW_A).filter((entry) => !entry.path.endsWith("agent-flow-ids.jsonl")));
    expect(refusalOf(() => validate(noIndex)).message).toContain("a missing identity index is");

    const forgedDigest = materialize(buildRows());
    const [tail, index, chunk] = agentFlowDocs(WORKFLOW_A);
    const entries = index.text.trim().split("\n").map((line) => JSON.parse(line) as { id: string; d: string });
    entries[1] = { ...entries[1], d: fakeHex(3).slice(0, 32) };
    replaceRowDocuments(forgedDigest, "workflow-agent-flow-ledger", WORKFLOW_A, [tail, doc("control", index.path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`), chunk]);
    expect(refusalOf(() => validate(forgedDigest)).message).toContain("names no retained durable row");

    const missingRow = materialize(buildRows());
    replaceRowDocuments(missingRow, "workflow-agent-flow-ledger", WORKFLOW_A, [tail, index]);
    expect(refusalOf(() => validate(missingRow)).message).toContain("has no identity-index entry");
  });

  test("execution-coverage-consumer-manifest-is-r1s", () => {
    const wrongCapability = materialize(buildRows());
    const { consumer: cli, doc: cliDoc } = manifestOf(wrongCapability, "cli-writer");
    const consumers = cli.consumers as Array<Record<string, unknown>>;
    consumers[0] = { ...consumers[0], capability: "read-only", capabilityNote: "pretends to be read-only" };
    replaceRowEvidence(wrongCapability, "cli-writer", null, doc("package", cliDoc.path, canonical(cli)));
    expect(refusalOf(() => validate(wrongCapability)).message).toContain("R1 declares writer");

    const foreignConsumer = materialize(buildRows());
    const { consumer: dsh, doc: dshDoc } = manifestOf(foreignConsumer, "cli-writer");
    (dsh.consumers as Array<Record<string, unknown>>)[0] = { ...(dsh.consumers as Array<Record<string, unknown>>)[0], id: "dsh" };
    replaceRowEvidence(foreignConsumer, "cli-writer", null, doc("package", dshDoc.path, canonical(dsh)));
    expect(refusalOf(() => validate(foreignConsumer)).message).toContain("this surface covers cli");

    const inventedShape = materialize(buildRows());
    replaceRowEvidence(
      inventedShape,
      "cli-writer",
      null,
      doc("package", "coverage/cli-writer.execution-consumer.json", canonical({ version: 1, document: "consumer-manifest", surface: "cli-writer", entries: [] })),
    );
    expect(refusalOf(() => validate(inventedShape)).message).toContain("must carry exactly version, protocol, repoRoot, consumers");

    const missingEntrypoint = materialize(buildRows());
    const { consumer: zcode, doc: zcodeDoc } = manifestOf(missingEntrypoint, "zcode-hook");
    const zcodeConsumers = zcode.consumers as Array<Record<string, unknown>>;
    zcodeConsumers[0] = { ...zcodeConsumers[0], generated: { trees: [], files: [] } };
    replaceRowEvidence(missingEntrypoint, "zcode-hook", null, doc("package", zcodeDoc.path, canonical(zcode)));
    expect(refusalOf(() => validate(missingEntrypoint)).message).toContain("which appears in no source or generated file entry");

    const unproducedInjector = materialize(buildRows());
    replaceRowDocuments(unproducedInjector, "artifact-store-injectors", null, [doc("package", "injectors/fs-store.js", "export const store = {};")]);
    expect(refusalOf(() => validate(unproducedInjector)).message).toContain("no reviewed injector-inventory producer exists");
  });

  test("execution-coverage-hidden-entries-need-the-h2-wrapper", () => {
    // H1's export decodes, but complete retain coverage also needs the missing wrapper.
    const fixture = materialize(buildRows());
    replaceRowDocuments(fixture, "omp-hidden-entries", WORKFLOW_A, [hostHistoryDoc(WORKFLOW_A)]);
    expect(refusalOf(() => validate(fixture)).message).toContain("H2's evidence-file wrapper");

    const duplicated = materialize(buildRows());
    const history = hostHistoryDoc(WORKFLOW_A);
    const parsed = JSON.parse(history.text) as { records: unknown[] };
    replaceRowDocuments(duplicated, "omp-hidden-entries", WORKFLOW_A, [
      doc("host", history.path, canonical({ ...parsed, records: [parsed.records[0], { ...(parsed.records[0] as Record<string, unknown>), index: 1 }] })),
    ]);
    expect(refusalOf(() => validate(duplicated)).message).toContain("is recorded twice");
  });

  test("execution-coverage-assignment-binds-sources-to-a-row", () => {
    const borrowed = materialize(buildRows());
    patchReceipt(borrowed, "workflow-notes-ledger", WORKFLOW_B, (receipt) => ({ ...receipt, sources: witnessesFor(borrowed, "workflow-notes-ledger", WORKFLOW_A) }));
    expect(refusalOf(() => validate(borrowed)).message).toContain("the frozen manifest assigns");

    const shared = materialize(buildRows());
    replaceRowDocuments(shared, "sdd-evidence", WORKFLOW_B, [doc("sdd", `${WORKFLOW_A}/task-1-report.md`, `# ${WORKFLOW_A} report\n`)]);
    validate(shared);

    const unassigned = materialize(buildRows());
    patchAssignment(unassigned, "workflow-notes-ledger", WORKFLOW_A, []);
    expect(refusalOf(() => validate(unassigned)).message).toContain("assigns (none)");

    const crossWorkflowEnvelope = materialize(buildRows());
    const envelope = sessionEnvelopeDoc(WORKFLOW_A);
    replaceRowDocuments(crossWorkflowEnvelope, "workflow-session-envelopes", WORKFLOW_A, [
      doc("control", envelope.path, legacy({ schema_version: 1, role: "coordinator", session_id: SESSION_A, workflow_id: WORKFLOW_B, harness_root: "/harness" })),
    ]);
    expect(refusalOf(() => validate(crossWorkflowEnvelope)).message).toContain(`belongs to workflow ${WORKFLOW_B}`);
  });

  test("execution-coverage-core-and-index-boundaries", () => {
    const duplicateRegister = materialize(buildRows());
    replaceRowDocuments(duplicateRegister, "core-execution", null, [
      doc("control", "status.json", legacy({ version: 2, updated_at: "t", workflows: [{ id: WORKFLOW_A, type: "plan", started_at: "t" }, { id: WORKFLOW_A, type: "plan", started_at: "t" }] })),
      snapshot(WORKFLOW_A),
    ]);
    expect(refusalOf(() => validate(duplicateRegister)).message).toContain("names workflow wf-alpha twice");

    const omittedSibling = materialize(buildRows().filter((row) => row.workflowId !== WORKFLOW_B));
    const error = refusalOf(() => validate(omittedSibling));
    expect(error.message).toContain(WORKFLOW_B);
    expect(error.message).toContain("inventories");
  });

  test("execution-coverage-produced-documents-must-be-canonical", () => {
    const duplicated = materialize(buildRows());
    const { doc: cliDoc } = manifestOf(duplicated, "cli-writer");
    replaceRowEvidence(
      duplicated,
      "cli-writer",
      null,
      doc("package", cliDoc.path, '{"version":1,"protocol":"consumer-v1","repoRoot":".","consumers":[],"repoRoot":"."}\n'),
    );
    expect(refusalOf(() => validate(duplicated)).message).toContain("not canonical JSON");
  });

  test("execution-coverage-binding-and-pin-boundaries", () => {
    const unknownProtocol = materialize(buildRows());
    patchReceipt(unknownProtocol, "workflow-notes-ledger", WORKFLOW_A, (receipt) => ({ ...receipt, protocol: "notes-v9" }));
    expect(refusalOf(() => validate(unknownProtocol)).message).toContain("validator versions");

    const staleEpoch = materialize(buildRows());
    patchReceipt(staleEpoch, "workflow-notes-ledger", WORKFLOW_A, (receipt) => ({ ...receipt, epoch: EPOCH + 1 }));
    expect(refusalOf(() => validate(staleEpoch)).message).toContain("superseded epoch");

    const rebindingSet = materialize(buildRows(), { coverageManifestHash: fakeHex(98) });
    expect(refusalOf(() => validate(rebindingSet)).message).toContain("reviewed against another document");

    const unseen: CoverageWitness = { root: "control", path: "unpinned/extra.json", sha256: fakeHex(11) };
    const unpinned = materialize(buildRows());
    patchReceipt(unpinned, "workflow-notes-ledger", WORKFLOW_A, (receipt) => ({
      ...receipt,
      sources: [...(receipt.sources as CoverageWitness[]), unseen].sort(byRootPath),
    }));
    patchAssignment(unpinned, "workflow-notes-ledger", WORKFLOW_A, [...witnessesFor(unpinned, "workflow-notes-ledger", WORKFLOW_A)].sort(byRootPath));
    expect(refusalOf(() => validate(unpinned)).message).toContain("does not pin");

    const traversal = materialize(buildRows());
    patchAssignment(traversal, "workflow-notes-ledger", WORKFLOW_A, [{ root: "control", path: "../escape.json", sha256: fakeHex(12) }]);
    expect(refusalOf(() => validate(traversal)).message).toContain("escapes its configured root");

    const absolute = materialize(buildRows());
    patchAssignment(absolute, "workflow-notes-ledger", WORKFLOW_A, [{ root: "control", path: "/etc/passwd", sha256: fakeHex(13) }]);
    expect(refusalOf(() => validate(absolute)).message).toContain("is absolute");

    const unordered = materialize(buildRows());
    const index = rowIndex(unordered, "core-execution", null);
    const receipts = [...unordered.coverage.receipts];
    receipts[index] = { ...receipts[index], sources: [...receipts[index].sources].reverse() };
    unordered.coverage = { ...unordered.coverage, receipts, digest: safeDigest(receipts) };
    expect(refusalOf(() => validate(unordered)).message).toContain("not in canonical order");

    const duplicate = materialize(buildRows());
    const position = rowIndex(duplicate, "workflow-notes-ledger", WORKFLOW_A);
    const withDuplicate = [...duplicate.coverage.receipts];
    withDuplicate.splice(position + 1, 0, withDuplicate[position]);
    duplicate.coverage = { ...duplicate.coverage, receipts: withDuplicate, digest: safeDigest(withDuplicate) };
    expect(refusalOf(() => validate(duplicate)).message).toContain("duplicates");

    const changed = materialize(buildRows());
    changed.evidence.set(coverageWitnessKey("control", `workflows/${WORKFLOW_A}/notes.jsonl`), new TextEncoder().encode("{}\n"));
    expect(refusalOf(() => validate(changed)).message).toContain("does not hash to");

    const digestFixture = materialize(buildRows(), { digest: fakeHex(1) });
    expect(refusalOf(() => validate(digestFixture)).message).toContain("canonical digest");
  });

  test("execution-coverage-absent-rows-carry-no-result", () => {
    const withSources = materialize(buildRows());
    replaceRowDocuments(withSources, "dsh-package", null, [doc("package", "packages/dsh/package.json", "{}")]);
    expect(refusalOf(() => validate(withSources)).message).toContain("is absent yet names witnesses");

    const borrowing = materialize(buildRows());
    patchReceipt(borrowing, "dsh-package", null, (receipt) => ({ ...receipt, resultHash: fakeHex(21) }));
    expect(refusalOf(() => validate(borrowing)).message).toContain("recomputed from its bytes");
  });

  test("execution-coverage-purity-holds-on-accept-and-refuse", () => {
    const fixture = materialize(buildRows());
    const manifestBefore = JSON.stringify(fixture.manifest);
    const coverageBefore = JSON.stringify(fixture.coverage);
    const evidenceBefore = evidenceSnapshot(fixture.evidence);
    refusalOf(() => validate(fixture));
    expect(JSON.stringify(fixture.manifest)).toBe(manifestBefore);
    expect(JSON.stringify(fixture.coverage)).toBe(coverageBefore);
    expect(evidenceSnapshot(fixture.evidence)).toBe(evidenceBefore);

    const healthy = materialize(buildRows());
    const healthyManifest = JSON.stringify(healthy.manifest);
    const healthyEvidence = evidenceSnapshot(healthy.evidence);
    validate(healthy);
    expect(JSON.stringify(healthy.manifest)).toBe(healthyManifest);
    expect(evidenceSnapshot(healthy.evidence)).toBe(healthyEvidence);
  });

  test("execution-coverage-surface-roles-are-closed", () => {
    expect(executionCoverageSurfaceScope("core-execution")).toBe("root");
    expect(executionCoverageSurfaceScope("cli-writer")).toBe("root");
    expect(executionCoverageSurfaceScope("sdd-evidence")).toBe("workflow");
    expect(executionCoverageSurfaceScope("omp-hidden-entries")).toBe("workflow");
  });
});
