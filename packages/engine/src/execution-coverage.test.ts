/**
 * execution-coverage.test.ts — proof for the §4.1 coverage substrate.
 *
 * Every case runs the REAL module on synthetic fixtures: manifests, receipts
 * and evidence documents built in memory. No fixture path exists on disk, so a
 * validator that quietly read a file instead of the handed-in bytes could not
 * pass, and an accepted set proves the pure path end to end.
 *
 * Acceptance criteria carried by these cases:
 *
 * - `execution-coverage-*`: the populated valid set of all 18 surfaces (11
 *   root-scoped + 7 workflow-scoped for two workflows) validates; the closed
 *   manifest inventory refuses a dropped root row and a workflow that lost one
 *   of its seven rows; the exact-set equality refuses an omitted sibling
 *   workflow, a duplicate row and an unordered list; the recomputation refuses
 *   an unknown protocol, a stale/foreign epoch or manifest binding, an unpinned
 *   source, changed source bytes, a traversal or absolute witness path, a
 *   fabricated acknowledgement, a borrowed absent result, a hidden-history row
 *   that omits an inventoried session, an injector claiming write capability,
 *   a core discovery that drops a workflow and a digest that does not cover its
 *   receipts.
 * - `execution-coverage-purity-*`: validation mutates neither the manifest, the
 *   coverage set nor the evidence bytes, on the accepted and the refused path.
 *
 * Run with `bun test packages/engine/src/execution-coverage.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  EXECUTION_COVERAGE_SURFACES,
  coverageWitnessKey,
  executionCoverageDigest,
  executionCoverageProtocolFor,
  executionCoverageResultHash,
  executionCoverageSurfaceScope,
  validateExecutionCoverage,
  type CoverageDisposition,
  type CoverageRoot,
  type CoverageWitness,
  type ExecutionCoverageManifest,
  type ExecutionCoverageReceipt,
  type ExecutionCoverageSet,
  type ExecutionSurface,
} from "./execution-coverage.js";
import { ExecutionError } from "./execution-store.js";

const MANIFEST_ID = "coverage-manifest-20260921-core";
const MANIFEST_HASH = "b".repeat(64);
const STORE_ID = "6f5c7d1e-3a44-4b2c-9f7e-51a3b2c4d5e6";
const EPOCH = 4;
const WORKFLOW_A = "wf-alpha";
const WORKFLOW_B = "wf-beta";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A deterministic 64-hex stand-in for record digests the substrate never recomputes itself. */
function fakeHex(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

type RowSource = Readonly<{ root: CoverageRoot; path: string; text: string }>;

function source(root: CoverageRoot, path: string, text: string): RowSource {
  return { root, path, text };
}

function witnessOf(entry: RowSource): CoverageWitness {
  return { root: entry.root, path: entry.path, sha256: sha(entry.text) };
}

function byRootPath(left: CoverageWitness, right: CoverageWitness): number {
  const leftKey = coverageWitnessKey(left.root, left.path);
  const rightKey = coverageWitnessKey(right.root, right.path);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

type Row = {
  surface: ExecutionSurface;
  workflowId: string | null;
  disposition: CoverageDisposition;
  sources: RowSource[];
  facts?: Record<string, unknown>;
  /** The bounded evidence document's own path, absent for an `absent` row. */
  evidence?: Readonly<{ root: CoverageRoot; path: string }>;
  /** Whole-document override: the bytes are hashed as written, so the receipt stays self-consistent. */
  docText?: string;
  docPatch?: Record<string, unknown>;
  /** Whole-receipt override, applied after the fixture built a consistent receipt. */
  receiptPatch?: (receipt: Record<string, unknown>) => Record<string, unknown>;
  resultHash?: string;
  /** A source witness whose bytes are supplied but deliberately NOT pinned by the manifest. */
  extraSources?: RowSource[];
  /** The workflowId the manifest lists for this row, when it must differ from the receipt's. */
  manifestWorkflowId?: string | null;
};

function rootRow(surface: ExecutionSurface): Row {
  if (surface === "core-execution") {
    const status = source("control", "status.json", '{"version":2,"workflows":["wf-alpha","wf-beta"]}');
    const snapshotA = source("control", `workflows/${WORKFLOW_A}/snapshot.json`, '{"workflowId":"wf-alpha"}');
    const snapshotB = source("control", `workflows/${WORKFLOW_B}/snapshot.json`, '{"workflowId":"wf-beta"}');
    return {
      surface,
      workflowId: null,
      disposition: "migrate",
      sources: [status, snapshotA, snapshotB],
      facts: { catalogRevision: 12, workflows: [WORKFLOW_A, WORKFLOW_B] },
      evidence: { root: "control", path: "coverage/core-execution.json" },
    };
  }
  if (surface === "engine-status-snapshot") {
    const file = source("control", "snapshots/engine-status.json", '{"selectedWorkflowId":"wf-alpha"}');
    return {
      surface,
      workflowId: null,
      disposition: "retain",
      sources: [file],
      facts: { file: { path: file.path, sha256: sha(file.text) }, entries: [{ key: "selectedWorkflowId", digest: fakeHex(1) }] },
      evidence: { root: "control", path: "coverage/engine-status-snapshot.json" },
    };
  }
  if (surface === "artifact-store-injectors") {
    const file = source("package", "injectors/fs-store.js", "export const store = {};");
    return {
      surface,
      workflowId: null,
      disposition: "retain",
      sources: [file],
      facts: {
        entries: [
          {
            path: file.path,
            sha256: sha(file.text),
            capability: "body-only",
            entrypoint: file.path,
            runtime: "node",
            generated: null,
          },
        ],
      },
      evidence: { root: "package", path: "coverage/artifact-store-injectors.json" },
    };
  }
  if (surface === "engine-cli-package" || surface === "omp-package") {
    const built = surface === "engine-cli-package" ? "packages/engine/dist/index.js" : "packages/omp/dist/hook.js";
    const file = source("package", `packages/${surface === "engine-cli-package" ? "engine" : "omp"}/src/index.ts`, "export const hook = {};");
    const generated = source("package", built, "// built bundle");
    return {
      surface,
      workflowId: null,
      disposition: "retain",
      sources: [file, generated],
      facts: {
        entries: [
          {
            path: file.path,
            sha256: sha(file.text),
            capability: "writer",
            entrypoint: generated.path,
            runtime: "node",
            generated: { path: generated.path, sha256: sha(generated.text) },
          },
        ],
      },
      evidence: { root: "package", path: `coverage/${surface}.json` },
    };
  }
  if (surface === "copied-instructions") {
    const file = source("package", "skills/mstar-harness-core/SKILL.md", "# Morning Star harness core");
    return {
      surface,
      workflowId: null,
      disposition: "retain",
      sources: [file],
      facts: {
        entries: [
          { path: file.path, sha256: sha(file.text), capability: "read-only", entrypoint: null, runtime: null, generated: null },
        ],
      },
      evidence: { root: "package", path: "coverage/copied-instructions.json" },
    };
  }
  if (surface === "backup-recovery") {
    const file = source("control", "backups/store.db", "sqlite-consistent-backup");
    return {
      surface,
      workflowId: null,
      disposition: "retain",
      sources: [file],
      facts: {
        backup: { path: file.path, sha256: sha(file.text) },
        schemaVersion: 4,
        integrity: "verified",
        coverageDigest: fakeHex(7),
        recoveryGeneration: 2,
      },
      evidence: { root: "control", path: "coverage/backup-recovery.json" },
    };
  }
  if (surface === "cli-writer") {
    const file = source("package", "packages/cli/src/index.ts", "export const cli = {};");
    return {
      surface,
      workflowId: null,
      disposition: "retain",
      sources: [file],
      facts: {
        entries: [
          { path: file.path, sha256: sha(file.text), capability: "writer", entrypoint: file.path, runtime: "node", generated: null },
        ],
      },
      evidence: { root: "package", path: "coverage/cli-writer.json" },
    };
  }
  if (surface === "opencode-plugin") {
    const file = source("package", "packages/opencode/src/mstar.ts", "export const plugin = {};");
    return {
      surface,
      workflowId: null,
      disposition: "retain",
      sources: [file],
      facts: {
        entries: [
          {
            path: file.path,
            sha256: sha(file.text),
            capability: "decision-only",
            entrypoint: file.path,
            runtime: "node",
            generated: null,
          },
        ],
      },
      evidence: { root: "package", path: "coverage/opencode-plugin.json" },
    };
  }
  if (surface === "zcode-hook") {
    const file = source("package", "hooks/src/mstar-write-gate.ts", "export const gate = {};");
    const generated = source("package", "hooks/mstar-write-gate.mjs", "// committed bundle");
    return {
      surface,
      workflowId: null,
      disposition: "retain",
      sources: [file, generated],
      facts: {
        entries: [
          {
            path: file.path,
            sha256: sha(file.text),
            capability: "decision-only",
            entrypoint: generated.path,
            runtime: "node",
            generated: { path: generated.path, sha256: sha(generated.text) },
          },
        ],
      },
      evidence: { root: "package", path: "coverage/zcode-hook.json" },
    };
  }
  if (surface === "dsh-package") {
    // The DSh bundle is not part of this fixture's inventory: an absent row,
    // which is what proves absence needs no bytes at all.
    return { surface, workflowId: null, disposition: "absent", sources: [] };
  }
  throw new Error(`rootRow is not defined for ${surface}`);
}

function workflowRow(surface: ExecutionSurface, workflowId: string): Row {
  const dir = `workflows/${workflowId}`;
  const session = `sess-${workflowId}`;
  if (surface === "workflow-session-envelopes") {
    const file = source("control", `${dir}/sessions/coordinator.json`, `{"session_id":"${session}"}`);
    return {
      surface,
      workflowId,
      disposition: "migrate",
      sources: [file],
      facts: {
        envelopes: [
          {
            path: file.path,
            sha256: sha(file.text),
            role: "coordinator",
            sessionId: session,
            planId: null,
            state: "suspended",
            archive: "pending",
          },
        ],
      },
      evidence: { root: "control", path: `coverage/${workflowId}-session-envelopes.json` },
    };
  }
  if (surface === "workflow-notes-ledger") {
    const file = source("control", `${dir}/notes.jsonl`, `{"kind":"note","text":"${workflowId}"}`);
    return {
      surface,
      workflowId,
      disposition: "retain",
      sources: [file],
      facts: {
        file: { path: file.path, sha256: sha(file.text) },
        records: [{ line: 0, id: `note-${workflowId}`, sha256: fakeHex(20) }],
      },
      evidence: { root: "control", path: `coverage/${workflowId}-notes.json` },
    };
  }
  if (surface === "workflow-agent-flow-ledger") {
    const file = source("control", `${dir}/agent-flow.jsonl`, `{"eventId":"evt-${workflowId}"}`);
    return {
      surface,
      workflowId,
      disposition: "retain",
      sources: [file],
      facts: {
        file: { path: file.path, sha256: sha(file.text) },
        records: [
          {
            index: 0,
            eventId: `evt-${workflowId}`,
            sessionId: session,
            streamId: `stream-${workflowId}`,
            seq: 0,
            sha256: fakeHex(21),
          },
        ],
      },
      evidence: { root: "control", path: `coverage/${workflowId}-agent-flow.json` },
    };
  }
  if (surface === "workflow-ledger-cursors") {
    // One workflow keeps its watermark, the other has none: both are coverage.
    if (workflowId !== WORKFLOW_A) return { surface, workflowId, disposition: "absent", sources: [] };
    const file = source("control", `${dir}/workflow-ledger-cursors.json`, '{"stream-alpha":1}');
    return {
      surface,
      workflowId,
      disposition: "retain",
      sources: [file],
      facts: { file: { path: file.path, sha256: sha(file.text) }, entries: [{ key: `stream-${workflowId}`, digest: fakeHex(22) }] },
      evidence: { root: "control", path: `coverage/${workflowId}-cursors.json` },
    };
  }
  if (surface === "workflow-omp-launch-journal") {
    const file = source("control", `${dir}/omp-launches.json`, `{"launchId":"launch-${workflowId}"}`);
    return {
      surface,
      workflowId,
      disposition: "retain",
      sources: [file],
      facts: {
        file: { path: file.path, sha256: sha(file.text) },
        launches: [{ launchId: `launch-${workflowId}`, workflowId, planId: `plan-${workflowId}`, state: "settled" }],
      },
      evidence: { root: "control", path: `coverage/${workflowId}-launches.json` },
    };
  }
  if (surface === "omp-hidden-entries") {
    return {
      surface,
      workflowId,
      disposition: "retain",
      sources: [],
      facts: {
        inventory: [session],
        sessions: [
          { sessionId: session, entries: [{ entryId: `entry-${workflowId}`, name: "mstar:phase2", sha256: fakeHex(23) }] },
        ],
      },
      evidence: { root: "host", path: `coverage/${workflowId}-omp-hidden.json` },
    };
  }
  if (surface === "sdd-evidence") {
    const file = source("sdd", `${workflowId}/task-1-report.md`, `# ${workflowId} report`);
    return {
      surface,
      workflowId,
      disposition: "retain",
      sources: [file],
      facts: { plans: [{ planId: `plan-${workflowId}`, bodies: [{ path: file.path, sha256: sha(file.text) }] }] },
      evidence: { root: "sdd", path: `coverage/${workflowId}-sdd-evidence.json` },
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

type MaterializeOptions = {
  digest?: string;
  manifestId?: string;
  manifestHash?: string;
  storeId?: string;
  epoch?: number;
  coverageManifestId?: string;
  coverageManifestHash?: string;
  extraManifestSources?: RowSource[];
};

/** A digest for a fixture that deliberately breaks a receipt shape: the shape refusal fires first. */
function safeDigest(receipts: readonly ExecutionCoverageReceipt[]): string {
  try {
    return executionCoverageDigest(receipts);
  } catch {
    return fakeHex(0);
  }
}

function materialize(rows: Row[], options: MaterializeOptions = {}): Fixture {
  const manifestId = options.manifestId ?? MANIFEST_ID;
  const manifestHash = options.manifestHash ?? MANIFEST_HASH;
  const storeId = options.storeId ?? STORE_ID;
  const epoch = options.epoch ?? EPOCH;
  const evidence = new Map<string, Uint8Array>();
  const put = (entry: RowSource): CoverageWitness => {
    const key = coverageWitnessKey(entry.root, entry.path);
    const bytes = new TextEncoder().encode(entry.text);
    const previous = evidence.get(key);
    if (previous !== undefined && new TextDecoder().decode(previous) !== entry.text) {
      throw new Error(`fixture bug: ${key} is declared with two different bodies`);
    }
    evidence.set(key, bytes);
    return witnessOf(entry);
  };

  const receipts: ExecutionCoverageReceipt[] = [];
  const surfaces: Array<{ surface: ExecutionSurface; workflowId: string | null }> = [];
  for (const row of rows) {
    surfaces.push({
      surface: row.surface,
      workflowId: row.manifestWorkflowId !== undefined ? row.manifestWorkflowId : row.workflowId,
    });
    const witnessList = [...row.sources, ...(row.extraSources ?? [])].map(put).sort(byRootPath);
    const receipt: Record<string, unknown> = {
      version: 1,
      surface: row.surface,
      workflowId: row.workflowId,
      manifestId,
      manifestHash,
      storeId,
      epoch,
      disposition: row.disposition,
      protocol: executionCoverageProtocolFor(row.surface),
      sources: witnessList,
      evidence: [],
      resultHash:
        row.resultHash ??
        executionCoverageResultHash({
          surface: row.surface,
          workflowId: row.workflowId,
          disposition: row.disposition,
          ...(row.disposition === "absent" ? {} : { facts: row.facts ?? {} }),
        }),
    };
    if (row.evidence !== undefined) {
      const document: Record<string, unknown> = {
        version: 1,
        protocol: executionCoverageProtocolFor(row.surface),
        surface: row.surface,
        workflowId: row.workflowId,
        manifestId,
        manifestHash,
        storeId,
        epoch,
        disposition: row.disposition,
        sources: witnessList,
        facts: row.facts ?? {},
        ...(row.docPatch ?? {}),
      };
      const text = row.docText ?? JSON.stringify(document);
      const key = coverageWitnessKey(row.evidence.root, row.evidence.path);
      evidence.set(key, new TextEncoder().encode(text));
      receipt.evidence = [{ root: row.evidence.root, path: row.evidence.path, sha256: sha(text) }];
    }
    receipts.push((row.receiptPatch ? row.receiptPatch(receipt) : receipt) as unknown as ExecutionCoverageReceipt);
  }

  const manifestSources = new Map<string, CoverageWitness>();
  for (const row of rows) {
    for (const entry of row.sources) {
      const witness = put(entry);
      manifestSources.set(coverageWitnessKey(witness.root, witness.path), witness);
    }
  }
  for (const entry of options.extraManifestSources ?? []) {
    const witness = put(entry);
    manifestSources.set(coverageWitnessKey(witness.root, witness.path), witness);
  }

  const manifest: ExecutionCoverageManifest = {
    manifestId,
    manifestHash,
    storeId,
    epoch,
    surfaces,
    sources: [...manifestSources.values()].sort(byRootPath),
  };
  const coverage: ExecutionCoverageSet = {
    version: 1,
    manifestId: options.coverageManifestId ?? manifestId,
    manifestHash: options.coverageManifestHash ?? manifestHash,
    receipts,
    digest: options.digest ?? safeDigest(receipts),
  };
  return { manifest, coverage, evidence };
}

function refusalOf(run: () => void): ExecutionError {
  try {
    run();
  } catch (error) {
    return error as ExecutionError;
  }
  throw new Error("expected a coverage refusal, but validation returned normally");
}

function validate(fixture: Fixture): void {
  validateExecutionCoverage(fixture.manifest, fixture.coverage, fixture.evidence);
}

function rowOf(rows: Row[], surface: ExecutionSurface, workflowId: string | null = null): Row {
  const found = rows.find((row) => row.surface === surface && row.workflowId === workflowId);
  if (found === undefined) throw new Error(`fixture bug: no row for ${surface} / ${String(workflowId)}`);
  return found;
}

function evidenceSnapshot(evidence: Map<string, Uint8Array>): string {
  return [...evidence.entries()].map(([key, bytes]) => `${key}=${Buffer.from(bytes).toString("base64")}`).join("\n");
}

describe("execution-coverage", () => {
  test("execution-coverage-closed-inventory-validates", () => {
    const fixture = materialize(buildRows());
    // The fixture really is the closed inventory: 11 root-scoped + 7 × 2.
    expect(fixture.manifest.surfaces.length).toBe(25);
    expect(new Set(fixture.manifest.surfaces.map((row) => row.surface)).size).toBe(18);
    expect(fixture.coverage.receipts.length).toBe(25);
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
    rowOf(scopeViolation, "cli-writer").manifestWorkflowId = WORKFLOW_A;
    const scoped = refusalOf(() => validate(materialize(scopeViolation)));
    expect(scoped.message).toContain("root-scoped surface");
  });

  test("execution-coverage-omitted-sibling-workflow-refuses", () => {
    const rows = buildRows().filter((row) => row.workflowId !== WORKFLOW_B);
    const error = refusalOf(() => validate(materialize(rows)));
    expect(error.code).toBe("execution.coverage-incomplete");
    expect(error.message).toContain(WORKFLOW_B);
    expect(error.message).toContain("inventories");
  });

  test("execution-coverage-duplicate-and-unordered-rows-refuse", () => {
    const rows = buildRows();
    const target = rowOf(rows, "workflow-notes-ledger", WORKFLOW_A);
    rows.splice(rows.indexOf(target) + 1, 0, { ...target, sources: [...target.sources] });
    const duplicate = refusalOf(() => validate(materialize(rows)));
    expect(duplicate.message).toContain("duplicates");

    const reversed = refusalOf(() => validate(materialize([...buildRows()].reverse())));
    expect(reversed.message).toContain("not sorted");
  });

  test("execution-coverage-unknown-protocol-refuses", () => {
    const rows = buildRows();
    rowOf(rows, "workflow-notes-ledger", WORKFLOW_A).receiptPatch = (receipt) => ({ ...receipt, protocol: "notes-v9" });
    const error = refusalOf(() => validate(materialize(rows)));
    expect(error.message).toContain("validator version");
  });

  test("execution-coverage-stale-and-foreign-bindings-refuse", () => {
    const staleEpoch = buildRows();
    rowOf(staleEpoch, "workflow-notes-ledger", WORKFLOW_A).receiptPatch = (receipt) => ({ ...receipt, epoch: EPOCH + 1 });
    const stale = refusalOf(() => validate(materialize(staleEpoch)));
    expect(stale.message).toContain("superseded epoch");

    const foreignManifest = buildRows();
    rowOf(foreignManifest, "backup-recovery").receiptPatch = (receipt) => ({ ...receipt, manifestId: "another-discovery" });
    const foreign = refusalOf(() => validate(materialize(foreignManifest)));
    expect(foreign.message).toContain("stale coverage");

    const foreignDocument = buildRows();
    rowOf(foreignDocument, "workflow-notes-ledger", WORKFLOW_A).docPatch = { manifestHash: fakeHex(99) };
    const document = refusalOf(() => validate(materialize(foreignDocument)));
    expect(document.message).toContain("another manifest");

    const rebindingSet = materialize(buildRows(), { coverageManifestHash: fakeHex(98) });
    const rebinding = refusalOf(() => validate(rebindingSet));
    expect(rebinding.message).toContain("reviewed against another document");
  });

  test("execution-coverage-changed-source-bytes-refuse", () => {
    const fixture = materialize(buildRows());
    const key = coverageWitnessKey("control", `workflows/${WORKFLOW_A}/notes.jsonl`);
    const manifestBefore = JSON.stringify(fixture.manifest);
    const coverageBefore = JSON.stringify(fixture.coverage);
    fixture.evidence.set(key, new TextEncoder().encode('{"kind":"note","text":"rewritten"}'));
    const error = refusalOf(() => validate(fixture));
    expect(error.message).toContain("does not hash to");
    // The refusal itself wrote nothing: the manifest and the receipt set are intact.
    expect(JSON.stringify(fixture.manifest)).toBe(manifestBefore);
    expect(JSON.stringify(fixture.coverage)).toBe(coverageBefore);
  });

  test("execution-coverage-unpinned-and-traversing-witnesses-refuse", () => {
    const unpinned = buildRows();
    rowOf(unpinned, "workflow-notes-ledger", WORKFLOW_A).extraSources = [source("control", "unpinned/extra.json", "{}")];
    const notPinned = refusalOf(() => validate(materialize(unpinned)));
    expect(notPinned.message).toContain("does not pin");

    const traversal = buildRows();
    rowOf(traversal, "workflow-notes-ledger", WORKFLOW_A).sources = [source("control", "../escape.json", "{}")];
    const escaping = refusalOf(() => validate(materialize(traversal)));
    expect(escaping.message).toContain("escapes its configured root");

    const absolute = buildRows();
    rowOf(absolute, "workflow-notes-ledger", WORKFLOW_A).sources = [source("control", "/etc/passwd", "root:x:0:0")];
    const outside = refusalOf(() => validate(materialize(absolute)));
    expect(outside.message).toContain("is absolute");

    const unordered = buildRows();
    rowOf(unordered, "core-execution").receiptPatch = (receipt) => ({
      ...receipt,
      sources: [...(receipt.sources as CoverageWitness[])].reverse(),
    });
    const order = refusalOf(() => validate(materialize(unordered)));
    expect(order.message).toContain("not in canonical order");
  });

  test("execution-coverage-fabricated-acknowledgements-refuse", () => {
    const booleanDocument = buildRows();
    const row = rowOf(booleanDocument, "workflow-notes-ledger", WORKFLOW_A);
    row.docText = JSON.stringify({ version: 1, ok: true, acknowledged: true });
    const fabricated = refusalOf(() => validate(materialize(booleanDocument)));
    expect(fabricated.message).toContain("closed schema");

    const factsShapedAcknowledgement = buildRows();
    rowOf(factsShapedAcknowledgement, "workflow-notes-ledger", WORKFLOW_A).docPatch = {
      facts: { acknowledged: true, complete: true },
    };
    const shaped = refusalOf(() => validate(materialize(factsShapedAcknowledgement)));
    expect(shaped.message).toContain("must carry exactly");

    const changedFacts = buildRows();
    const changed = rowOf(changedFacts, "workflow-notes-ledger", WORKFLOW_A);
    const staleHash = executionCoverageResultHash({
      surface: changed.surface,
      workflowId: changed.workflowId,
      disposition: changed.disposition,
      facts: changed.facts ?? {},
    });
    changed.facts = { ...changed.facts, records: [] };
    changed.receiptPatch = (receipt) => ({ ...receipt, resultHash: staleHash });
    const borrowed = refusalOf(() => validate(materialize(changedFacts)));
    expect(borrowed.message).toContain("is not the digest of the facts recomputed");
  });

  test("execution-coverage-absent-rows-carry-no-result", () => {
    const withSources = buildRows();
    rowOf(withSources, "dsh-package").sources = [source("package", "packages/dsh/package.json", '{"name":"dsh"}')];
    const claiming = refusalOf(() => validate(materialize(withSources)));
    expect(claiming.message).toContain("is absent yet names witnesses");

    const borrowed = buildRows();
    rowOf(borrowed, "dsh-package").resultHash = executionCoverageResultHash({
      surface: "dsh-package",
      workflowId: null,
      disposition: "retain",
      facts: { entries: [] },
    });
    const absent = refusalOf(() => validate(materialize(borrowed)));
    expect(absent.message).toContain("digest of an absent result");
  });

  test("execution-coverage-surface-facts-are-recomputed", () => {
    const hidden = buildRows();
    rowOf(hidden, "omp-hidden-entries", WORKFLOW_A).facts = {
      inventory: ["sess-never-inventoried", `sess-${WORKFLOW_A}`],
      sessions: [{ sessionId: `sess-${WORKFLOW_A}`, entries: [] }],
    };
    const inventory = refusalOf(() => validate(materialize(hidden)));
    expect(inventory.message).toContain("not cover the explicit host inventory");

    const injector = buildRows();
    const injectorRow = rowOf(injector, "artifact-store-injectors");
    const injectorEntries = injectorRow.facts?.entries as Array<Record<string, unknown>>;
    injectorRow.facts = { entries: [{ ...injectorEntries[0], capability: "writer" }] };
    const capability = refusalOf(() => validate(materialize(injector)));
    expect(capability.message).toContain("body-only");

    const envelope = buildRows();
    const envelopeRow = rowOf(envelope, "workflow-session-envelopes", WORKFLOW_A);
    const envelopes = envelopeRow.facts?.envelopes as Array<Record<string, unknown>>;
    envelopeRow.facts = { envelopes: [{ ...envelopes[0], planId: `plan-${WORKFLOW_A}` }] };
    const coordinator = refusalOf(() => validate(materialize(envelope)));
    expect(coordinator.message).toContain("coordinator association carries no plan");

    const core = buildRows();
    rowOf(core, "core-execution").facts = { catalogRevision: 12, workflows: [WORKFLOW_A] };
    const discovery = refusalOf(() => validate(materialize(core)));
    expect(discovery.message).toContain(WORKFLOW_B);
  });

  test("execution-coverage-digest-covers-its-receipts", () => {
    const fixture = materialize(buildRows(), { digest: fakeHex(1) });
    const error = refusalOf(() => validate(fixture));
    expect(error.message).toContain("canonical digest");

    const changed = buildRows();
    const notes = rowOf(changed, "workflow-notes-ledger", WORKFLOW_A);
    const original = materialize(changed);
    notes.facts = { ...notes.facts, records: [{ line: 0, id: "note-wf-alpha", sha256: fakeHex(24) }] };
    const rewritten = materialize(changed);
    expect(rewritten.coverage.digest).not.toBe(original.coverage.digest);

    expect(() => executionCoverageDigest([...original.coverage.receipts].reverse())).toThrow(ExecutionError);
  });

  test("execution-coverage-result-hash-normalizes-facts", () => {
    const first = executionCoverageResultHash({
      surface: "workflow-notes-ledger",
      workflowId: WORKFLOW_A,
      disposition: "retain",
      facts: { file: { path: "workflows/wf-alpha/notes.jsonl", sha256: fakeHex(1) }, records: [] },
    });
    const second = executionCoverageResultHash({
      surface: "workflow-notes-ledger",
      workflowId: WORKFLOW_A,
      disposition: "retain",
      facts: { file: { path: "workflows/wf-alpha/notes.jsonl", sha256: fakeHex(2) }, records: [] },
    });
    expect(first).not.toBe(second);
    expect(() =>
      executionCoverageResultHash({
        surface: "workflow-notes-ledger",
        workflowId: WORKFLOW_A,
        disposition: "absent",
        facts: { records: [] },
      }),
    ).toThrow(ExecutionError);
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
});
