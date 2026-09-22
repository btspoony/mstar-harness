/**
 * execution-coverage.test.ts — proof for the §4.1/§4.2 coverage substrate.
 *
 * Every case runs the REAL module on synthetic fixtures whose bytes are real
 * documents in the real formats: a v2 root register and workflow snapshots, a
 * legacy-pretty session envelope, JSONL ledgers, JSON selections, a canonical
 * host-history export, producer manifests and a recovery inventory. No fixture
 * path exists on disk, so a validator that quietly read a file instead of the
 * handed-in bytes could not pass, and an accepted set proves the pure path end
 * to end. Receipts in the fixtures are built with `buildExecutionCoverageReceipt`
 * — the same producer entry point C3 uses — so the producer and the validator
 * are proven to agree on one schema.
 *
 * Acceptance criteria carried by these cases:
 *
 * - `execution-coverage-*`: the populated valid set of all 18 surfaces (11
 *   root-scoped + 7 workflow-scoped for two workflows) validates, including
 *   pretty (non-canonical) legacy sources; a fact asserted by the receipt
 *   instead of recomputed from its bytes refuses; a receipt borrowing a
 *   sibling workflow's assigned source refuses, while a source the hashed
 *   manifest assigns to two rows is accepted; embedded workflow identities in
 *   note lines, launch entries and snapshots are bound to the row; a consumer
 *   capability that differs from the surface's required authority refuses; a
 *   hidden-history export with a diagnostic, a foreign workflow, a mismatched
 *   payload digest, a wrong generation or a broken native order refuses; a
 *   produced document that is not canonical (including a duplicated member)
 *   refuses; and the omitted/duplicate/stale/unpinned/absent boundaries refuse.
 * - `execution-coverage-purity-*`: validation mutates neither the manifest, the
 *   coverage set nor the evidence bytes, on the accepted and the refused path.
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

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The §3.1 canonical digest: the same form the module recomputes payload hashes with. */
function digestOf(value: unknown): string {
  return createHash("sha256").update(serializeExecutionValue(value), "utf8").digest("hex");
}

/** A deterministic 64-hex stand-in for digests the fixture itself owns. */
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
      workflows: [
        { id: WORKFLOW_A, type: "plan", started_at: "2026-09-21T00:00:00.000Z", dir: `workflows/${WORKFLOW_A}` },
        { id: WORKFLOW_B, type: "plan", started_at: "2026-09-21T00:00:00.000Z", dir: `workflows/${WORKFLOW_B}` },
      ],
    }),
  );
}

function hostHistory(wf: string): Doc {
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

/** A canonical producer manifest plus the package files it describes. */
function consumerRow(
  surface: ExecutionSurface,
  required: string,
  source: { path: string; text: string },
  generated?: { path: string; text: string },
): Row {
  const entry = {
    path: source.path,
    sha256: sha(source.text),
    capability: required,
    entrypoint: generated?.path ?? source.path,
    runtime: "node",
    generated: generated === undefined ? null : { path: generated.path, sha256: sha(generated.text) },
  };
  return {
    surface,
    workflowId: null,
    disposition: "retain",
    docs: generated === undefined ? [doc("package", source.path, source.text)] : [doc("package", source.path, source.text), doc("package", generated.path, generated.text)],
    evidence: doc(
      "package",
      `coverage/${surface}.manifest.json`,
      canonical({ version: 1, document: "consumer-manifest", surface, entries: [entry] }),
    ),
  };
}

function rootRow(surface: ExecutionSurface): Row {
  if (surface === "core-execution") {
    return { surface, workflowId: null, disposition: "migrate", docs: [rootRegisterDoc(), snapshot(WORKFLOW_A), snapshot(WORKFLOW_B)] };
  }
  if (surface === "engine-status-snapshot") {
    return {
      surface,
      workflowId: null,
      disposition: "retain",
      docs: [doc("control", "snapshots/engine-status.json", legacy({ selectedWorkflowId: WORKFLOW_A, excludedBeforeSeq: 3 }))],
    };
  }
  if (surface === "artifact-store-injectors") {
    return consumerRow(surface, "body-only", { path: "injectors/fs-store.js", text: "export const store = {};" });
  }
  if (surface === "cli-writer") {
    return consumerRow(surface, "writer", { path: "packages/cli/src/index.ts", text: "export const cli = {};" });
  }
  if (surface === "engine-cli-package") {
    return consumerRow(surface, "writer", { path: "packages/engine/src/index.ts", text: "export const engine = {};" }, { path: "packages/engine/dist/index.js", text: "// built engine bundle" });
  }
  if (surface === "omp-package") {
    return consumerRow(surface, "writer", { path: "packages/omp/src/hook.ts", text: "export const hook = {};" }, { path: "packages/omp/dist/hook.js", text: "// built hook bundle" });
  }
  if (surface === "opencode-plugin") {
    return consumerRow(surface, "decision-only", { path: "packages/opencode/src/mstar.ts", text: "export const plugin = {};" });
  }
  if (surface === "zcode-hook") {
    return consumerRow(surface, "decision-only", { path: "hooks/src/mstar-write-gate.ts", text: "export const gate = {};" }, { path: "hooks/mstar-write-gate.mjs", text: "// committed hook bundle" });
  }
  if (surface === "copied-instructions") {
    return consumerRow(surface, "read-only", { path: "skills/mstar-harness-core/SKILL.md", text: "# Morning Star harness core" });
  }
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
  if (surface === "dsh-package") {
    // The DSh bundle is not part of this fixture's inventory: an absent row,
    // which is what proves absence needs no bytes at all.
    return { surface, workflowId: null, disposition: "absent", docs: [] };
  }
  throw new Error(`rootRow is not defined for ${surface}`);
}

function workflowRow(surface: ExecutionSurface, workflowId: string): Row {
  const dir = `workflows/${workflowId}`;
  const session = `sess-${workflowId}`;
  if (surface === "workflow-session-envelopes") {
    return {
      surface,
      workflowId,
      disposition: "migrate",
      docs: [doc("control", `${dir}/sessions/coordinator.json`, legacy({ session_id: session, session_file: `${dir}/sessions/coordinator.json`, bound_at: "2026-09-21T00:00:00.000Z" }))],
    };
  }
  if (surface === "workflow-notes-ledger") {
    return {
      surface,
      workflowId,
      disposition: "retain",
      docs: [
        doc(
          "control",
          `${dir}/notes.jsonl`,
          [
            JSON.stringify({ kind: "note", ts: "2026-09-21T00:00:00.000Z", text: `retained note of ${workflowId}` }),
            JSON.stringify({ version: 1, id: `note-${workflowId}`, workflowId, sessionId: session, kind: "note", ts: "2026-09-21T00:00:01.000Z", text: "recorded note" }),
          ].join("\n") + "\n",
        ),
      ],
    };
  }
  if (surface === "workflow-agent-flow-ledger") {
    return {
      surface,
      workflowId,
      disposition: "retain",
      docs: [
        doc(
          "control",
          `${dir}/agent-flow.jsonl`,
          JSON.stringify({ eventId: `evt-${workflowId}`, sessionId: session, streamId: `stream-${workflowId}`, seq: 0, workflowId }) + "\n",
        ),
      ],
    };
  }
  if (surface === "workflow-ledger-cursors") {
    if (workflowId !== WORKFLOW_A) return { surface, workflowId, disposition: "absent", docs: [] };
    return { surface, workflowId, disposition: "retain", docs: [doc("control", `${dir}/workflow-ledger-cursors.json`, legacy({ [`stream-${workflowId}`]: 3 }))] };
  }
  if (surface === "workflow-omp-launch-journal") {
    return {
      surface,
      workflowId,
      disposition: "retain",
      docs: [
        doc(
          "control",
          `${dir}/omp-launches.json`,
          legacy({ launches: [{ launchId: `launch-${workflowId}`, workflowId, planId: `plan-${workflowId}`, state: "settled" }] }),
        ),
      ],
    };
  }
  if (surface === "omp-hidden-entries") {
    return { surface, workflowId, disposition: "retain", docs: [hostHistory(workflowId)] };
  }
  if (surface === "sdd-evidence") {
    return {
      surface,
      workflowId,
      disposition: "retain",
      docs: [doc("sdd", `${workflowId}/task-1-report.md`, `# ${workflowId} report\n`)],
    };
  }
  throw new Error(`workflowRow is not defined for ${surface}`);
}

/**
 * The complete, populated inventory in canonical order: surfaces in the closed
 * union's order, each workflow-scoped surface repeated for both workflows.
 */
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

type Fixture = {
  manifest: ExecutionCoverageManifest;
  coverage: ExecutionCoverageSet;
  evidence: Map<string, Uint8Array>;
};

/** A digest for a fixture whose receipt shape is deliberately broken: that refusal fires first. */
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

function materialize(rows: Row[], options: { digest?: string; manifestHash?: string; coverageManifestHash?: string } = {}): Fixture {
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
        manifestHash: options.manifestHash ?? MANIFEST_HASH,
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
  // One inventory witness no receipt references: the manifest pins more than the receipts consume.
  const inventory = doc("host", "inventory.json", legacy({ version: 1, sessions: [`sess-${WORKFLOW_A}`, `sess-${WORKFLOW_B}`] }));
  pinned.set(coverageWitnessKey(inventory.root, inventory.path), register(evidence, inventory));

  const manifest: ExecutionCoverageManifest = {
    manifestId: MANIFEST_ID,
    manifestHash: options.manifestHash ?? MANIFEST_HASH,
    storeId: STORE_ID,
    epoch: EPOCH,
    surfaces,
    sources: [...pinned.values()].sort(byRootPath),
  };
  const coverage: ExecutionCoverageSet = {
    version: 1,
    manifestId: MANIFEST_ID,
    manifestHash: options.coverageManifestHash ?? options.manifestHash ?? MANIFEST_HASH,
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

function setReceipt(fixture: Fixture, index: number, receipt: ExecutionCoverageReceipt): void {
  const receipts = [...fixture.coverage.receipts];
  receipts[index] = receipt;
  fixture.coverage = { ...fixture.coverage, receipts, digest: safeDigest(receipts) };
}

function matches(row: { surface: ExecutionSurface; workflowId: string | null }, surface: ExecutionSurface, workflowId: string | null): boolean {
  return row.surface === surface && row.workflowId === workflowId;
}

function repin(fixture: Fixture, witnesses: readonly CoverageWitness[]): void {
  const pinned = new Map<string, CoverageWitness>();
  for (const witness of fixture.manifest.sources) pinned.set(coverageWitnessKey(witness.root, witness.path), witness);
  for (const witness of witnesses) pinned.set(coverageWitnessKey(witness.root, witness.path), witness);
  fixture.manifest = { ...fixture.manifest, sources: [...pinned.values()].sort(byRootPath) };
}

/** Replace a witness's bytes outright — the mutation helpers change retained bytes on purpose. */
function overrideDoc(evidence: Map<string, Uint8Array>, entry: Doc): CoverageWitness {
  evidence.set(coverageWitnessKey(entry.root, entry.path), new TextEncoder().encode(entry.text));
  return witnessOf(entry);
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

/** Replace a row's bounded export document, keeping the receipt's shape. */
function replaceRowEvidence(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null, document: Doc): void {
  const index = rowIndex(fixture, surface, workflowId);
  const witness = overrideDoc(fixture.evidence, document);
  setReceipt(fixture, index, { ...fixture.coverage.receipts[index], evidence: [witness] });
  repin(fixture, [witness]);
}

function patchReceipt(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null, patch: (receipt: Record<string, unknown>) => Record<string, unknown>): void {
  const index = rowIndex(fixture, surface, workflowId);
  const receipt = fixture.coverage.receipts[index];
  setReceipt(fixture, index, patch(receipt as unknown as Record<string, unknown>) as unknown as ExecutionCoverageReceipt);
}

/** Change only the manifest's assignment for one row, leaving the receipt alone. */
function patchAssignment(fixture: Fixture, surface: ExecutionSurface, workflowId: string | null, witnesses: readonly CoverageWitness[]): void {
  fixture.manifest = {
    ...fixture.manifest,
    surfaces: fixture.manifest.surfaces.map((row) => (matches(row, surface, workflowId) ? { ...row, sources: [...witnesses] } : row)),
  };
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

describe("execution-coverage", () => {
  test("execution-coverage-closed-inventory-validates", () => {
    const fixture = materialize(buildRows());
    expect(fixture.manifest.surfaces.length).toBe(25);
    expect(new Set(fixture.manifest.surfaces.map((row) => row.surface)).size).toBe(18);
    expect(fixture.coverage.receipts.length).toBe(25);
    // Legacy pretty-printed sources and canonical produced documents coexist.
    expect(fixture.evidence.get(coverageWitnessKey("control", "status.json"))).toBeDefined();
    validate(fixture);
  });

  test("execution-coverage-manifest-inventory-is-closed", () => {
    const droppedRoot = refusalOf(() => validate(materialize(buildRows().filter((row) => row.surface !== "backup-recovery"))));
    expect(droppedRoot.code).toBe("execution.coverage-incomplete");
    expect(droppedRoot.message).toContain("backup-recovery");

    const droppedSiblingRow = refusalOf(() =>
      validate(materialize(buildRows().filter((row) => !(row.surface === "sdd-evidence" && row.workflowId === WORKFLOW_B)))),
    );
    expect(droppedSiblingRow.message).toContain("sibling workflow is never omitted");

    const scopeViolation = buildRows();
    const cliWriter = scopeViolation.find((row) => row.surface === "cli-writer");
    if (cliWriter === undefined) throw new Error("fixture bug: no cli-writer row");
    cliWriter.manifestWorkflowId = WORKFLOW_A;
    const scoped = refusalOf(() => validate(materialize(scopeViolation)));
    expect(scoped.message).toContain("root-scoped surface");
  });

  test("execution-coverage-omitted-sibling-workflow-refuses", () => {
    const rows = buildRows().filter((row) => row.workflowId !== WORKFLOW_B);
    const error = refusalOf(() => validate(materialize(rows)));
    expect(error.message).toContain(WORKFLOW_B);
    expect(error.message).toContain("inventories");
  });

  test("execution-coverage-duplicate-and-unordered-rows-refuse", () => {
    const duplicate = materialize(buildRows());
    const index = rowIndex(duplicate, "workflow-notes-ledger", WORKFLOW_A);
    const receipts = [...duplicate.coverage.receipts];
    receipts.splice(index + 1, 0, receipts[index]);
    duplicate.coverage = { ...duplicate.coverage, receipts, digest: safeDigest(receipts) };
    expect(refusalOf(() => validate(duplicate)).message).toContain("duplicates");

    const reversed = materialize(buildRows());
    const ordered = [...reversed.coverage.receipts].reverse();
    reversed.coverage = { ...reversed.coverage, receipts: ordered, digest: safeDigest(ordered) };
    expect(refusalOf(() => validate(reversed)).message).toContain("not sorted");
  });

  test("execution-coverage-receipt-result-is-recomputed-from-bytes", () => {
    // A producer that invents a result: the hash covers facts nothing in the
    // bytes could produce, and the validator recomputes instead of trusting it.
    const invented = materialize(buildRows());
    patchReceipt(invented, "workflow-notes-ledger", WORKFLOW_A, (receipt) => ({
      ...receipt,
      resultHash: digestOf({
        surface: "workflow-notes-ledger",
        workflowId: WORKFLOW_A,
        disposition: "retain",
        facts: { sources: [], format: "jsonl", files: [] },
      }),
    }));
    const asserted = refusalOf(() => validate(invented));
    expect(asserted.message).toContain("recomputed from its bytes");

    // The same row over changed bytes yields a different result, so the result
    // tracks the bytes rather than the row identity.
    const before = materialize(buildRows());
    const beforeHash = before.coverage.receipts[rowIndex(before, "workflow-notes-ledger", WORKFLOW_A)].resultHash;
    const after = materialize(buildRows());
    replaceRowDocuments(after, "workflow-notes-ledger", WORKFLOW_A, [
      doc("control", `workflows/${WORKFLOW_A}/notes.jsonl`, JSON.stringify({ kind: "note", ts: "2026-09-21T00:00:00.000Z", text: "rewritten" }) + "\n"),
    ]);
    const afterReceipt = buildExecutionCoverageReceipt(
      {
        surface: "workflow-notes-ledger",
        workflowId: WORKFLOW_A,
        disposition: "retain",
        manifestId: MANIFEST_ID,
        manifestHash: MANIFEST_HASH,
        storeId: STORE_ID,
        epoch: EPOCH,
        sources: after.coverage.receipts[rowIndex(after, "workflow-notes-ledger", WORKFLOW_A)].sources,
      },
      after.evidence,
    );
    expect(afterReceipt.resultHash).not.toBe(beforeHash);
  });

  test("execution-coverage-changed-source-bytes-refuse", () => {
    const fixture = materialize(buildRows());
    const manifestBefore = JSON.stringify(fixture.manifest);
    const coverageBefore = JSON.stringify(fixture.coverage);
    fixture.evidence.set(coverageWitnessKey("control", `workflows/${WORKFLOW_A}/notes.jsonl`), new TextEncoder().encode(legacy({ kind: "note", text: "rewritten" })));
    const error = refusalOf(() => validate(fixture));
    expect(error.message).toContain("does not hash to");
    expect(JSON.stringify(fixture.manifest)).toBe(manifestBefore);
    expect(JSON.stringify(fixture.coverage)).toBe(coverageBefore);
  });

  test("execution-coverage-assignment-binds-sources-to-a-row", () => {
    // Borrowing a sibling workflow's assigned source refuses.
    const borrowed = materialize(buildRows());
    patchReceipt(borrowed, "workflow-notes-ledger", WORKFLOW_B, (receipt) => ({
      ...receipt,
      sources: witnessesFor(borrowed, "workflow-notes-ledger", WORKFLOW_A),
    }));
    const borrowing = refusalOf(() => validate(borrowed));
    expect(borrowing.message).toContain("the frozen manifest assigns");

    // A source the hashed manifest explicitly assigns to two rows is legal.
    const shared = materialize(buildRows());
    const alphaBody = doc("sdd", `${WORKFLOW_A}/task-1-report.md`, `# ${WORKFLOW_A} report\n`);
    replaceRowDocuments(shared, "sdd-evidence", WORKFLOW_B, [alphaBody]);
    rebuildRow(shared, "sdd-evidence", WORKFLOW_B);
    validate(shared);

    // An embedded workflow identity must match the row it is inventoried under.
    const foreign = materialize(buildRows());
    replaceRowDocuments(foreign, "workflow-notes-ledger", WORKFLOW_A, [
      doc("control", `workflows/${WORKFLOW_A}/notes.jsonl`, JSON.stringify({ version: 1, id: "note-x", workflowId: WORKFLOW_B, kind: "note", ts: "t", text: "x" }) + "\n"),
    ]);
    expect(refusalOf(() => validate(foreign)).message).toContain(`names workflow ${WORKFLOW_B}`);

    const foreignLaunch = materialize(buildRows());
    replaceRowDocuments(foreignLaunch, "workflow-omp-launch-journal", WORKFLOW_A, [
      doc("control", `workflows/${WORKFLOW_A}/omp-launches.json`, legacy({ launches: [{ launchId: "launch-x", workflowId: WORKFLOW_B, planId: "p", state: "settled" }] })),
    ]);
    expect(refusalOf(() => validate(foreignLaunch)).message).toContain(`launches.workflowId`);

    // A populated row the manifest assigns no source is refused.
    const unassigned = materialize(buildRows());
    patchAssignment(unassigned, "workflow-notes-ledger", WORKFLOW_A, []);
    expect(refusalOf(() => validate(unassigned)).message).toContain("assigns (none)");
  });

  test("execution-coverage-consumer-capability-is-fixed-per-surface", () => {
    const mislabelled = materialize(buildRows());
    replaceRowEvidence(
      mislabelled,
      "cli-writer",
      null,
      doc(
        "package",
        "coverage/cli-writer.manifest.json",
        canonical({
          version: 1,
          document: "consumer-manifest",
          surface: "cli-writer",
          entries: [{ path: "packages/cli/src/index.ts", sha256: sha("export const cli = {};"), capability: "read-only", entrypoint: "packages/cli/src/index.ts", runtime: "node", generated: null }],
        }),
      ),
    );
    const capability = refusalOf(() => validate(mislabelled));
    expect(capability.message).toContain("required to expose writer");

    const hookWriter = materialize(buildRows());
    replaceRowEvidence(
      hookWriter,
      "zcode-hook",
      null,
      doc(
        "package",
        "coverage/zcode-hook.manifest.json",
        canonical({
          version: 1,
          document: "consumer-manifest",
          surface: "zcode-hook",
          entries: [{ path: "hooks/src/mstar-write-gate.ts", sha256: sha("export const gate = {};"), capability: "writer", entrypoint: "hooks/mstar-write-gate.ts", runtime: "node", generated: null }],
        }),
      ),
    );
    expect(refusalOf(() => validate(hookWriter)).message).toContain("required to expose decision-only");

    // A manifest digest that does not describe the supplied bytes refuses.
    const wrongDigest = materialize(buildRows());
    replaceRowEvidence(
      wrongDigest,
      "cli-writer",
      null,
      doc(
        "package",
        "coverage/cli-writer.manifest.json",
        canonical({
          version: 1,
          document: "consumer-manifest",
          surface: "cli-writer",
          entries: [{ path: "packages/cli/src/index.ts", sha256: fakeHex(9), capability: "writer", entrypoint: "packages/cli/src/index.ts", runtime: "node", generated: null }],
        }),
      ),
    );
    expect(refusalOf(() => validate(wrongDigest)).message).toContain("is not a source witness of this receipt");
  });

  test("execution-coverage-host-history-is-decoded-not-trusted", () => {
    const record = (wf: string, overrides: Record<string, unknown> = {}): unknown => {
      const payload = { workflowId: wf, state: "pending", operationId: `op-${wf}` };
      return {
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
          provenance: [],
        },
        ...overrides,
      };
    };
    const exportDoc = (wf: string, body: Record<string, unknown>): Doc =>
      doc("host", `host-history/${wf}.json`, canonical({ version: 1, document: "execution-host-history", records: [], diagnostics: [], ...body }));

    const diagnosed = materialize(buildRows());
    replaceRowDocuments(diagnosed, "omp-hidden-entries", WORKFLOW_A, [
      exportDoc(WORKFLOW_A, { records: [record(WORKFLOW_A)], diagnostics: [{ index: 0, type: "mstar:phase2", entryId: null, code: "payload-not-object", message: "undecodable" }] }),
    ]);
    expect(refusalOf(() => validate(diagnosed)).message).toContain("diagnostic(s)");

    const foreign = materialize(buildRows());
    replaceRowDocuments(foreign, "omp-hidden-entries", WORKFLOW_A, [
      exportDoc(WORKFLOW_A, {
        records: [
          record(WORKFLOW_A, {
            view: {
              generation: 1,
              declaredKind: "phase2",
              declaredAction: null,
              declaredState: "pending",
              workflowId: WORKFLOW_B,
              checkpointId: null,
              operationId: `op-${WORKFLOW_A}`,
              dedupKey: `op-${WORKFLOW_A}`,
              cancelled: false,
              provenance: [],
            },
          }),
        ],
      }),
    ]);
    expect(refusalOf(() => validate(foreign)).message).toContain(`belongs to workflow ${WORKFLOW_B}`);

    const forgedPayload = materialize(buildRows());
    replaceRowDocuments(forgedPayload, "omp-hidden-entries", WORKFLOW_A, [
      exportDoc(WORKFLOW_A, { records: [record(WORKFLOW_A, { payloadHash: fakeHex(3) })] }),
    ]);
    expect(refusalOf(() => validate(forgedPayload)).message).toContain("does not hash the payload it publishes");

    const wrongGeneration = materialize(buildRows());
    replaceRowDocuments(wrongGeneration, "omp-hidden-entries", WORKFLOW_A, [
      exportDoc(WORKFLOW_A, {
        records: [
          record(WORKFLOW_A, {
            view: {
              generation: 2,
              declaredKind: "phase2",
              declaredAction: null,
              declaredState: "pending",
              workflowId: WORKFLOW_A,
              checkpointId: null,
              operationId: `op-${WORKFLOW_A}`,
              dedupKey: `op-${WORKFLOW_A}`,
              cancelled: false,
              provenance: [],
            },
          }),
        ],
      }),
    ]);
    expect(refusalOf(() => validate(wrongGeneration)).message).toContain("generation must be 1");

    const reordered = materialize(buildRows());
    replaceRowDocuments(reordered, "omp-hidden-entries", WORKFLOW_A, [
      exportDoc(WORKFLOW_A, { records: [record(WORKFLOW_A, { index: 1 })] }),
    ]);
    expect(refusalOf(() => validate(reordered)).message).toContain("native ledger order");
  });

  test("execution-coverage-produced-documents-must-be-canonical", () => {
    const pretty = materialize(buildRows());
    replaceRowEvidence(
      pretty,
      "cli-writer",
      null,
      doc(
        "package",
        "coverage/cli-writer.manifest.json",
        JSON.stringify({ version: 1, document: "consumer-manifest", surface: "cli-writer", entries: [] }, null, 2),
      ),
    );
    expect(refusalOf(() => validate(pretty)).message).toContain("not canonical JSON");

    // A duplicated member is rejected by the canonical round trip, not resolved by the parser.
    const duplicated = materialize(buildRows());
    replaceRowEvidence(
      duplicated,
      "cli-writer",
      null,
      doc(
        "package",
        "coverage/cli-writer.manifest.json",
        '{"version":1,"document":"consumer-manifest","surface":"cli-writer","entries":[],"surface":"copied-instructions"}\n',
      ),
    );
    expect(refusalOf(() => validate(duplicated)).message).toContain("not canonical JSON");
  });

  test("execution-coverage-unknown-protocol-and-stale-bindings-refuse", () => {
    const unknownProtocol = materialize(buildRows());
    patchReceipt(unknownProtocol, "workflow-notes-ledger", WORKFLOW_A, (receipt) => ({ ...receipt, protocol: "notes-v9" }));
    expect(refusalOf(() => validate(unknownProtocol)).message).toContain("validator versions");

    const staleEpoch = materialize(buildRows());
    patchReceipt(staleEpoch, "workflow-notes-ledger", WORKFLOW_A, (receipt) => ({ ...receipt, epoch: EPOCH + 1 }));
    expect(refusalOf(() => validate(staleEpoch)).message).toContain("superseded epoch");

    const foreignManifest = materialize(buildRows());
    patchReceipt(foreignManifest, "backup-recovery", null, (receipt) => ({ ...receipt, manifestId: "another-discovery" }));
    expect(refusalOf(() => validate(foreignManifest)).message).toContain("stale coverage");

    const rebindingSet = materialize(buildRows(), { coverageManifestHash: fakeHex(98) });
    expect(refusalOf(() => validate(rebindingSet)).message).toContain("reviewed against another document");

    const reusedManifest = materialize(buildRows());
    replaceRowEvidence(
      reusedManifest,
      "cli-writer",
      null,
      doc(
        "package",
        "coverage/cli-writer.manifest.json",
        canonical({ version: 1, document: "consumer-manifest", surface: "copied-instructions", entries: [] }),
      ),
    );
    expect(refusalOf(() => validate(reusedManifest)).message).toContain("never reused for another surface");
  });

  test("execution-coverage-unpinned-traversing-and-unordered-witnesses-refuse", () => {
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
    const core = unordered.coverage.receipts[index];
    const receipts = [...unordered.coverage.receipts];
    receipts[index] = { ...core, sources: [...core.sources].reverse() };
    unordered.coverage = { ...unordered.coverage, receipts, digest: safeDigest(receipts) };
    expect(refusalOf(() => validate(unordered)).message).toContain("not in canonical order");
  });

  test("execution-coverage-absent-rows-carry-no-result", () => {
    const withSources = materialize(buildRows());
    replaceRowDocuments(withSources, "dsh-package", null, [doc("package", "packages/dsh/package.json", '{"name":"dsh"}')]);
    expect(refusalOf(() => validate(withSources)).message).toContain("is absent yet names witnesses");

    const borrowed = materialize(buildRows());
    patchReceipt(borrowed, "dsh-package", null, (receipt) => ({ ...receipt, resultHash: fakeHex(21) }));
    expect(refusalOf(() => validate(borrowed)).message).toContain("recomputed from its bytes");
  });

  test("execution-coverage-populated-rows-need-a-source", () => {
    const withoutSources = materialize(buildRows());
    replaceRowDocuments(withoutSources, "workflow-notes-ledger", WORKFLOW_A, []);
    const error = refusalOf(() => validate(withoutSources));
    expect(error.message).toContain("names no source witness");
  });

  test("execution-coverage-digest-covers-its-receipts", () => {
    const fixture = materialize(buildRows(), { digest: fakeHex(1) });
    expect(refusalOf(() => validate(fixture)).message).toContain("canonical digest");

    const changed = materialize(buildRows());
    const before = changed.coverage.digest;
    replaceRowDocuments(changed, "workflow-notes-ledger", WORKFLOW_A, [
      doc("control", `workflows/${WORKFLOW_A}/notes.jsonl`, JSON.stringify({ kind: "note", text: "different body" }) + "\n"),
    ]);
    rebuildRow(changed, "workflow-notes-ledger", WORKFLOW_A);
    expect(changed.coverage.digest).not.toBe(before);

    expect(() => executionCoverageDigest([...materialize(buildRows()).coverage.receipts].reverse())).toThrow(ExecutionError);
  });

  test("execution-coverage-core-discovery-binds-the-workflow-set", () => {
    const withoutSnapshots = materialize(buildRows());
    replaceRowDocuments(withoutSnapshots, "core-execution", null, [rootRegisterDoc()]);
    expect(refusalOf(() => validate(withoutSnapshots)).message).toContain("no workflow snapshot");

    // The register names wf-beta, which no snapshot witnesses.
    const unregistered = materialize(buildRows());
    replaceRowDocuments(unregistered, "core-execution", null, [rootRegisterDoc(), snapshot(WORKFLOW_A)]);
    expect(refusalOf(() => validate(unregistered)).message).toContain("no snapshot witness");
  });

  test("execution-coverage-purity-holds-on-accept-and-refuse", () => {
    const fixture = materialize(buildRows());
    const manifestBefore = JSON.stringify(fixture.manifest);
    const coverageBefore = JSON.stringify(fixture.coverage);
    const evidenceBefore = evidenceSnapshot(fixture.evidence);
    validate(fixture);
    expect(JSON.stringify(fixture.manifest)).toBe(manifestBefore);
    expect(JSON.stringify(fixture.coverage)).toBe(coverageBefore);
    expect(evidenceSnapshot(fixture.evidence)).toBe(evidenceBefore);

    const broken = materialize(buildRows());
    broken.evidence.set(coverageWitnessKey("control", "backups/store.db"), new TextEncoder().encode("tampered"));
    const manifestBroken = JSON.stringify(broken.manifest);
    const coverageBroken = JSON.stringify(broken.coverage);
    const evidenceBroken = evidenceSnapshot(broken.evidence);
    refusalOf(() => validate(broken));
    expect(JSON.stringify(broken.manifest)).toBe(manifestBroken);
    expect(JSON.stringify(broken.coverage)).toBe(coverageBroken);
    expect(evidenceSnapshot(broken.evidence)).toBe(evidenceBroken);
  });

  test("execution-coverage-surface-roles-are-closed", () => {
    expect(executionCoverageSurfaceScope("core-execution")).toBe("root");
    expect(executionCoverageSurfaceScope("cli-writer")).toBe("root");
    expect(executionCoverageSurfaceScope("sdd-evidence")).toBe("workflow");
    expect(executionCoverageSurfaceScope("omp-hidden-entries")).toBe("workflow");
  });
});
