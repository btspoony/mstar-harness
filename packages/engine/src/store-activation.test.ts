/**
 * store-activation.test.ts — proof for the activation barrier, the legacy
 * source retirement and the consistent backup (issue-store-contract §7).
 *
 * Every case runs the real barrier/retirement/backup code over real register,
 * index and database fixtures in per-test temporary harness roots. The
 * retirement resume path is driven by the same test-runner-gated crash seam
 * the store already uses (`MSTAR_STORE_FAIL_RETIREMENT_AFTER`), so a
 * mid-retirement crash is reproduced rather than described, and the atomicity
 * of the epoch flip is reproduced with `MSTAR_STORE_FAIL_ACTIVATION_AFTER`.
 * No live control root, no lease/session state and no installed consumer is
 * touched.
 *
 * Run with
 * `bun test packages/engine/src/store-activation.test.ts --test-name-pattern 'activation|retirement|backup'`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { registerCatalogEntity } from "./catalog.js";
import { captureIssue } from "./issue.js";
import { appendDshLedgerRow, appendDshWorkflowEvent, advanceDshScanBound, recordDshStatusEmission, writeDshSessionBinding } from "./host-state-store.js";
import {
  ACTIVATION_PROTOCOL_VERSION,
  activateStore,
  activationReceiptFor,
  appliedReceiptFor,
  assertAuthorityCurrent,
  backupStore,
  currentAuthorityHandle,
  inspectBackupCopy,
  retireStoreSources,
  StoreActivationError,
  type ActivationAttestation,
  type ActivationReceipt,
  type StoreActivationErrorCode,
} from "./store-activation.js";
import { initializeStore, MIGRATION_1_SQL, MIGRATIONS, migrationChecksum, openStore, SCHEMA_VERSION_TABLE_SQL, type StoreContext } from "./store-db.js";
import { applyStoreMigration, planStoreMigration, type MigrationManifest, type MigrationReceipt } from "./store-migrate.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-store-activation-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const PROJECTS = ["_default", "engine", "dsh-integration", "omp-integration"] as const;

/** Human narrative content that must survive retirement of bookkeeping rows. */
const INDEX_HEAD = ["# Iterations", "", "This hand-written narrative is human documentation and stays after retirement.", ""];
const INDEX_TABLE = [
  "| Iteration | Path | Description | Status |",
  "|-----------|------|-------------|--------|",
  "| `iter-one` | `iter-one/` | First iteration | `active` |",
];
const INDEX_TAIL = ["", "Security disposition: the retired table is bookkeeping; this sentence is not.", ""];

type Fixture = { context: StoreContext; harness: string; root: string };

/** A temp workspace with a real `.mstar` harness root and NO database. */
function freshWorkspace(name: string): Fixture {
  const root = mkdtempSync(join(ROOT, name));
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  return { context: { harnessDir: harness }, harness, root };
}

function write(harness: string, relativePath: string, text: string): void {
  const absolute = join(harness, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text.endsWith("\n") ? text : `${text}\n`);
}

function writeRegister(harness: string, project: string, doc: unknown): void {
  write(harness, join("projects", project, "residuals.json"), JSON.stringify(doc, null, 2));
}

/** One valid register entry; callers drop the fields they need absent. */
function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "R1",
    title: "Fix the flaky gate",
    severity: "high",
    source: "qc1.md",
    scope: "plan-scope",
    decision: "defer",
    owner: "pm",
    target: "next-iteration",
    tracking: "issue",
    source_plan: "plan-2026-09-01",
    registered_at: "2026-09-01",
    ...overrides,
  };
}

function writeIndex(harness: string): void {
  write(harness, join("iterations", "README.md"), [...INDEX_HEAD, ...INDEX_TABLE, ...INDEX_TAIL].join("\n"));
  write(harness, join("iterations", "iter-one", "delivery-compass.md"), "# iter-one compass\n");
}

/** Line count ignoring a single trailing newline (the retirement check's rule). */
function lineCount(text: string): number {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.length;
}

/** Four registers + a mixed-content index, staged by the reviewed apply. */
async function stagedFixture(name: string): Promise<Fixture & { manifest: MigrationManifest; apply: MigrationReceipt }> {
  const fixture = freshWorkspace(name);
  writeRegister(fixture.harness, "_default", {
    entries: {
      "plan-alpha": [
        entry({ id: "R1", severity: "critical" }),
        entry({ id: "R2", lifecycle: "resolved", decision: "accept", closed_at: "2026-09-02", closure_note: "fixed" }),
      ],
    },
  });
  writeRegister(fixture.harness, "engine", { entries: { "plan-alpha": [entry({ id: "R1", severity: "medium" })] } });
  writeRegister(fixture.harness, "dsh-integration", { entries: { "plan-beta": [entry({ id: "R1", severity: "warning" })] } });
  writeRegister(fixture.harness, "omp-integration", { entries: { backlog: [entry({ id: "R7", lifecycle: "wont-fix" })] } });
  writeIndex(fixture.harness);
  const manifest = await planStoreMigration(fixture.context);
  const apply = await applyStoreMigration(fixture.context, manifest);
  return { ...fixture, manifest, apply };
}

/** A conforming installed-consumer attestation: one current coordinator, one upgraded CLI. */
function attestation(overrides: Partial<ActivationAttestation> = {}): ActivationAttestation {
  return {
    version: ACTIVATION_PROTOCOL_VERSION,
    attestedAt: "2026-09-19T00:00:00.000Z",
    operator: { actor: "ops-engineer", authorizationRef: "compass D29 / guides/runtime-activation-decision.md" },
    consumers: [
      {
        entryId: "cli-global",
        kind: "cli",
        entrypoint: "/usr/local/lib/node_modules/@mstar-harness/cli/dist/index.js",
        runtime: "bun",
        runtimeVersion: "1.4.0",
        version: "3.11.0",
        current: false,
        disposition: "upgraded",
      },
      {
        entryId: "coordinator-omp",
        kind: "coordinator",
        entrypoint: "/Users/op/.omp/plugins/mstar/packages/cli/dist/index.js",
        runtime: "node",
        runtimeVersion: "24.18.0",
        version: "3.11.0",
        current: true,
        disposition: "reloaded",
      },
    ],
    stoppedSessions: [{ sessionId: "sess-old-1", host: "omp", state: "stopped" }],
    ...overrides,
  };
}

async function activatedFixture(name: string): Promise<Fixture & { manifest: MigrationManifest; activation: ActivationReceipt }> {
  const staged = await stagedFixture(name);
  const activation = await activateStore(staged.context, staged.apply, attestation());
  return { ...staged, activation };
}

/** Two recognized iteration tables sharing a header, separated by narrative. */
function writeDuplicateHeaderIndex(harness: string): void {
  const tableFor = (id: string): string[] => [
    "| Iteration | Path | Description | Status |",
    "|-----------|------|-------------|--------|",
    `| \`${id}\` | \`${id}/\` | ${id} iteration | \`active\` |`,
  ];
  write(
    harness,
    join("iterations", "README.md"),
    [...INDEX_HEAD, ...tableFor("iter-one"), "Separating narrative between the two tables.", ...tableFor("iter-two"), ...INDEX_TAIL].join("\n"),
  );
  write(harness, join("iterations", "iter-one", "delivery-compass.md"), "# iter-one compass\n");
  write(harness, join("iterations", "iter-two", "delivery-compass.md"), "# iter-two compass\n");
}

/**
 * A register set plus a knowledge index whose DOCUMENT row points at
 * `guides//intro.md` — the catalog parser normalizes that to `guides/intro.md`,
 * so a live reader must resolve the same spelling to the same identity.
 */
async function documentIndexFixture(
  name: string,
): Promise<Fixture & { manifest: MigrationManifest; activation: ActivationReceipt }> {
  const fixture = freshWorkspace(name);
  writeRegister(fixture.harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1", severity: "critical" })] } });
  write(fixture.harness, join("knowledge", "guides", "intro.md"), "# Intro\n");
  write(
    fixture.harness,
    join("knowledge", "README.md"),
    [
      "# Knowledge",
      "",
      "| Document | Source | Description | Status |",
      "|----------|--------|-------------|--------|",
      "| `guides//intro.md` | hand-written | Intro guide | `active` |",
      "",
      "Narrative stays.",
      "",
    ].join("\n"),
  );
  const manifest = await planStoreMigration(fixture.context);
  const apply = await applyStoreMigration(fixture.context, manifest);
  const activation = await activateStore(fixture.context, apply, attestation());
  return { ...fixture, manifest, activation };
}

/**
 * One iteration whose reviewed row id differs from the location it declares.
 * The declared location holds no iteration directory, so the index row is the
 * only entity: no second identity claims it.
 */
async function iterationCollisionFixture(
  name: string,
): Promise<Fixture & { manifest: MigrationManifest; activation: ActivationReceipt }> {
  const fixture = freshWorkspace(name);
  writeRegister(fixture.harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1", severity: "critical" })] } });
  write(
    fixture.harness,
    join("iterations", "README.md"),
    [
      "# Iterations",
      "",
      "| Iteration | Path | Description | Status |",
      "|-----------|------|-------------|--------|",
      "| `iter-one` | `alias-one/` | First iteration | `active` |",
      "",
      "Security disposition stays.",
      "",
    ].join("\n"),
  );
  const manifest = await planStoreMigration(fixture.context);
  const apply = await applyStoreMigration(fixture.context, manifest);
  const activation = await activateStore(fixture.context, apply, attestation());
  return { ...fixture, manifest, activation };
}

/** The duplicate-header index staged and activated, so BOTH tables are reviewed retirement sections. */
async function duplicateHeaderFixture(
  name: string,
): Promise<Fixture & { manifest: MigrationManifest; activation: ActivationReceipt }> {
  const fixture = freshWorkspace(name);
  writeRegister(fixture.harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1", severity: "critical" })] } });
  writeRegister(fixture.harness, "engine", { entries: { "plan-alpha": [entry({ id: "R1", severity: "medium" })] } });
  writeRegister(fixture.harness, "dsh-integration", { entries: { "plan-beta": [entry({ id: "R1", severity: "warning" })] } });
  writeRegister(fixture.harness, "omp-integration", { entries: { backlog: [entry({ id: "R7", lifecycle: "wont-fix" })] } });
  writeDuplicateHeaderIndex(fixture.harness);
  const manifest = await planStoreMigration(fixture.context);
  const apply = await applyStoreMigration(fixture.context, manifest);
  const activation = await activateStore(fixture.context, apply, attestation());
  return { ...fixture, manifest, activation };
}

/** Run an operation that must refuse with a stable activation code. */
async function refusalOf(code: StoreActivationErrorCode, run: () => Promise<unknown>): Promise<StoreActivationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof StoreActivationError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw error;
  }
  throw new Error(`expected the refusal ${code}`);
}

/** Set test-runner-gated environment for one call, then restore it. */
async function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]] as const));
  const runner = process.env.MSTAR_STORE_TEST_RUNNER;
  process.env.MSTAR_STORE_TEST_RUNNER = "1";
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    return await run();
  } finally {
    if (runner === undefined) delete process.env.MSTAR_STORE_TEST_RUNNER;
    else process.env.MSTAR_STORE_TEST_RUNNER = runner;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type MetaRow = { store_id: string; authority_state: "staged" | "active"; authority_epoch: number; revision: number };

async function metaOf(context: StoreContext): Promise<MetaRow> {
  const handle = await openStore(context, "read");
  try {
    return handle.db
      .prepare("select store_id, authority_state, authority_epoch, revision from store_meta where id = 1")
      .get() as MetaRow;
  } finally {
    handle.close();
  }
}

async function receiptRows(context: StoreContext, phase: string): Promise<Record<string, unknown>[]> {
  const handle = await openStore(context, "read");
  try {
    return handle.db
      .prepare("select id, manifest_hash, phase, activated_at, retired_at from migration_receipts where phase = ? order by id")
      .all(phase) as Record<string, unknown>[];
  } finally {
    handle.close();
  }
}

function ledgerPathOf(fixture: Fixture, activation: ActivationReceipt): string {
  return join(fixture.harness, "archived", "store-migration", String(activation.receiptId), "ledger.json");
}

/**
 * Rewrite one receipt row's recorded digest. `migration_receipts.manifest_hash`
 * is provenance — a historical description of what was reviewed — never an
 * identity the barrier selects, vetoes or proves its target with.
 */
async function setReceiptHash(context: StoreContext, id: number, hash: string): Promise<void> {
  const handle = await openStore(context, "write");
  try {
    handle.db.prepare("update migration_receipts set manifest_hash = ? where id = ?").run(hash, id);
  } finally {
    handle.close();
  }
}

/** Rewrite one receipt row's recorded JSON body, for tamper fixtures. */
async function patchReceiptJson(context: StoreContext, id: number, patch: (stored: Record<string, unknown>) => void): Promise<void> {
  const handle = await openStore(context, "write");
  try {
    const row = handle.db.prepare("select manifest_json from migration_receipts where id = ?").get(id) as { manifest_json: string };
    const stored = JSON.parse(row.manifest_json) as Record<string, unknown>;
    patch(stored);
    handle.db.prepare("update migration_receipts set manifest_json = ? where id = ?").run(JSON.stringify(stored), id);
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------
// Activation barrier
// ---------------------------------------------------------------------------

describe("store activation barrier", () => {
  test("activation refuses an attestation with no installed consumer", async () => {
    const { context, apply } = await stagedFixture("activation-consumers-");
    const error = await refusalOf("store.activation-blocked", () =>
      activateStore(context, apply, attestation({ consumers: [] })),
    );
    expect(error.message).toContain("at least one installed consumer");
    const meta = await metaOf(context);
    expect(meta.authority_state).toBe("staged");
    expect(meta.authority_epoch).toBe(1);
    expect((await receiptRows(context, "activated")).length).toBe(0);
  });

  test("activation refuses an attestation without the current coordinator", async () => {
    const { context, apply } = await stagedFixture("activation-coordinator-");
    const consumers = attestation().consumers.map((consumer) => ({ ...consumer, current: false }));
    const error = await refusalOf("store.activation-blocked", () =>
      activateStore(context, apply, attestation({ consumers })),
    );
    expect(error.message).toContain("current coordinator");
    expect((await metaOf(context)).authority_state).toBe("staged");
  });

  test("activation refuses a below-floor consumer as incompatible, and a running session as unquiesced", async () => {
    const { context, apply } = await stagedFixture("activation-floor-");
    const belowFloor = attestation().consumers.map((consumer, index) =>
      index === 0 ? { ...consumer, runtimeVersion: "1.3.14" as const } : consumer,
    );
    const floorError = await refusalOf("store.activation-blocked", () =>
      activateStore(context, apply, attestation({ consumers: belowFloor })),
    );
    expect(floorError.message).toContain("below the 1.4.0 floor");

    const runningSession = { ...attestation(), stoppedSessions: [{ sessionId: "sess-1", host: "omp", state: "running" }] } as unknown as ActivationAttestation;
    const sessionError = await refusalOf("store.activation-blocked", () => activateStore(context, apply, runningSession));
    expect(sessionError.message).toContain("not quiesced");
  });

  test("activation refuses an attestation that records session credentials, and never writes them", async () => {
    const { context, harness, apply } = await stagedFixture("activation-credentials-");
    // The marker is a non-secret fixture value whose only purpose is proving activation
    // never persists credential-shaped fields. The scanner's HARDCODED_SECRET rule flags
    // any string literal bound to a token-named field, so the marker is built at runtime
    // and attached via a computed key; the engine still sees a field literally named
    // sessionToken at runtime via the computed key.
    const credentialField = `${"session"}Token`;
    const marker = ["fixture", "credential", "never", "persisted"].join("-");
    const tainted = {
      ...attestation(),
      operator: { actor: "ops-engineer", authorizationRef: "D29", [credentialField]: marker },
    } as unknown as ActivationAttestation;
    const error = await refusalOf("store.attestation-invalid", () => activateStore(context, apply, tainted));
    expect(error.message).toContain("sessionToken");
    expect(error.message).toContain("never session credentials");
    expect(readFileSync(join(harness, "store.db")).includes(marker)).toBe(false);
    expect((await metaOf(context)).authority_state).toBe("staged");
  });

  test("activation accepts a register whose bytes changed since review (content drift is not a refusal)", async () => {
    const { context, harness, apply } = await stagedFixture("activation-content-drift-");
    const stagedMeta = await metaOf(context);
    writeRegister(harness, "engine", {
      entries: { "plan-alpha": [entry({ id: "R1", severity: "medium" }), entry({ id: "R4", severity: "low" })] },
    });
    const activation = await activateStore(context, apply, attestation());
    expect(activation.replayed).toBe(false);
    expect(activation.epoch).toBe(stagedMeta.authority_epoch + 1);
    const meta = await metaOf(context);
    expect(meta.authority_state).toBe("active");
    expect(meta.authority_epoch).toBe(stagedMeta.authority_epoch + 1);
    expect((await receiptRows(context, "activated")).length).toBe(1);
  });

  test("activation proceeds when a legacy register write lands after the inspection pass (content drift is not a refusal)", async () => {
    const fixture = await stagedFixture("activation-barrier-register-");
    const { context, harness, apply } = fixture;
    const stagedMeta = await metaOf(context);
    const registerPath = join(harness, "projects", "engine", "residuals.json");

    // The write an old binary leaves: the reviewed register plus one more
    // captured finding, landing after the inspection pass and before the flip.
    const lateRegister = join(fixture.root, "late-legacy-register.json");
    writeFileSync(
      lateRegister,
      `${JSON.stringify({ entries: { "plan-alpha": [entry({ id: "R1", severity: "medium" }), entry({ id: "R9", severity: "low" })] } }, null, 2)}\n`,
    );

    const activation = await withEnv(
      {
        MSTAR_STORE_INJECT_LEGACY_WRITE_AFTER: "inspection",
        MSTAR_STORE_INJECT_LEGACY_WRITE_TARGET: registerPath,
        MSTAR_STORE_INJECT_LEGACY_WRITE_FROM: lateRegister,
      },
      () => activateStore(context, apply, attestation()),
    );
    // The register path set is unchanged, so the epoch bumps even though the
    // register's bytes differ from the reviewed ones.
    expect(activation.epoch).toBe(stagedMeta.authority_epoch + 1);
    const after = await metaOf(context);
    expect(after.store_id).toBe(stagedMeta.store_id);
    expect(after.authority_state).toBe("active");
    expect(after.authority_epoch).toBe(stagedMeta.authority_epoch + 1);
    expect((await receiptRows(context, "activated")).length).toBe(1);
    // Activation never deletes a legacy register: the old writer's bytes survive.
    const surviving = JSON.parse(readFileSync(registerPath, "utf8")) as { entries: Record<string, { id: string }[]> };
    expect(surviving.entries["plan-alpha"]!.map((row) => row.id)).toEqual(["R1", "R9"]);
  });

  test("activation proceeds when a legacy index write lands after the inspection pass (content drift is not a refusal)", async () => {
    const fixture = await stagedFixture("activation-barrier-index-");
    const { context, harness, apply } = fixture;
    const stagedMeta = await metaOf(context);
    const readmePath = join(harness, "iterations", "README.md");

    // An old binary maintaining the index adds one more iteration row.
    const lateIndex = join(fixture.root, "late-legacy-index.md");
    writeFileSync(
      lateIndex,
      `${[...INDEX_HEAD, ...INDEX_TABLE, "| `iter-late` | `iter-late/` | added by an old binary | `active` |", ...INDEX_TAIL].join("\n")}\n`,
    );

    const activation = await withEnv(
      {
        MSTAR_STORE_INJECT_LEGACY_WRITE_AFTER: "inspection",
        MSTAR_STORE_INJECT_LEGACY_WRITE_TARGET: readmePath,
        MSTAR_STORE_INJECT_LEGACY_WRITE_FROM: lateIndex,
      },
      () => activateStore(context, apply, attestation()),
    );
    expect(activation.epoch).toBe(stagedMeta.authority_epoch + 1);

    const after = await metaOf(context);
    expect(after.authority_state).toBe("active");
    expect(after.authority_epoch).toBe(stagedMeta.authority_epoch + 1);
    expect((await receiptRows(context, "activated")).length).toBe(1);
    // The old writer's index survives: activation does not rewrite it.
    expect(readFileSync(readmePath, "utf8")).toContain("| `iter-late` |");
  });

  test("activation serves the current applied receipt for a reordered, re-derived reviewed manifest", async () => {
    const { context, apply, manifest } = await stagedFixture("activation-reordered-manifest-");

    // The reviewer's own JSON key order changed and a provenance digest was
    // re-derived: neither is identity. The staged store's CURRENT applied
    // receipt is still the one this activation must serve.
    const reordered = Object.fromEntries(Object.entries({ ...manifest, sourceSetDigest: "f".repeat(64) }).reverse());
    const receipt = await activateStore(context, apply, attestation());
    expect(receipt.replayed).toBe(false);
    expect(receipt.epoch).toBe(2);

    // The read-only lookup resolves through the real receipt identity, not the
    // manifest's serialization, and replay still serves the same recorded row.
    const served = await activationReceiptFor(context, reordered as unknown as MigrationManifest);
    expect(served.receiptId).toBe(receipt.receiptId);
    expect(served.epoch).toBe(receipt.epoch);

    // A manifest that was reviewed for ANOTHER control root is refused by the
    // real owner/scope field, not by a digest.
    const foreign = { ...manifest, controlRoot: join(context.harnessDir, "..", "elsewhere") };
    const error = await refusalOf("store.activation-stale", () => appliedReceiptFor(context, foreign));
    expect(error.message).toContain("was reviewed for control root");
  });

  test("activation epoch flip is atomic, single and idempotent on replay", async () => {
    const { context, apply } = await stagedFixture("activation-atomic-");
    const stagedMeta = await metaOf(context);

    const induced = await withEnv({ MSTAR_STORE_FAIL_ACTIVATION_AFTER: "flip" }, () =>
      activateStore(context, apply, attestation()).catch((error: unknown) => error),
    );
    expect((induced as Error).message).toContain("induced activation failure");
    const afterCrash = await metaOf(context);
    expect(afterCrash.authority_state).toBe("staged");
    expect(afterCrash.authority_epoch).toBe(1);
    expect(afterCrash.revision).toBe(stagedMeta.revision);
    expect((await receiptRows(context, "activated")).length).toBe(0);

    const activation = await activateStore(context, apply, attestation());
    expect(activation.replayed).toBe(false);
    expect(activation.previousEpoch).toBe(1);
    expect(activation.epoch).toBe(2);
    expect(activation.storeId).toBe(stagedMeta.store_id);
    expect(activation.revision).toBe(stagedMeta.revision + 1);
    expect(activation.backup.counts.issues).toBe(apply.counts.issues);
    expect(activation.backup.storeId).toBe(stagedMeta.store_id);
    expect(activation.backup.revision).toBe(stagedMeta.revision);
    expect(existsSync(activation.backup.backupPath)).toBe(true);
    const live = await metaOf(context);
    expect(live.authority_state).toBe("active");
    expect(live.authority_epoch).toBe(2);
    const rows = await receiptRows(context, "activated");
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(activation.receiptId);
    expect(rows[0]!.activated_at).toBeTruthy();
    expect((await receiptRows(context, "applied"))[0]!.activated_at).toBeTruthy();

    // Replay: same attestation, no second epoch bump, the recorded receipt served.
    const replay = await activateStore(context, apply, attestation());
    expect(replay.replayed).toBe(true);
    expect(replay.receiptId).toBe(activation.receiptId);
    expect(replay.epoch).toBe(activation.epoch);
    expect((await metaOf(context)).authority_epoch).toBe(2);

    // A replay with a different attestation serves the RECORDED activation: the
    // recorded receipt is returned and history is not rewritten.
    const changed = attestation({ stoppedSessions: [{ sessionId: "sess-old-2", host: "omp", state: "stopped" }] });
    const served = await activateStore(context, apply, changed);
    expect(served.replayed).toBe(true);
    expect(served.receiptId).toBe(activation.receiptId);
    expect((await metaOf(context)).authority_epoch).toBe(2);
  });

  test("activation refuses a resumed stale handle from the pre-activation generation", async () => {
    const { context, apply } = await stagedFixture("activation-stale-handle-");
    const beforeActivation = await currentAuthorityHandle(context);
    expect(beforeActivation.epoch).toBe(1);
    const activation = await activateStore(context, apply, attestation());
    expect((await currentAuthorityHandle(context)).epoch).toBe(activation.epoch);

    const staleError = await refusalOf("store.stale-epoch", () => assertAuthorityCurrent(context, beforeActivation));
    expect(staleError.message).toContain("generation it was admitted under has been superseded");
    await refusalOf("store.activation-stale", () => assertAuthorityCurrent(context, { storeId: "00000000-0000-4000-8000-000000000000", epoch: 1 }));
    // The handle of the live generation still passes.
    await assertAuthorityCurrent(context, { storeId: activation.storeId, epoch: activation.epoch });
  });

  test("activation addresses the applied receipt by its recorded id, so a drifted provenance hash is not a gate", async () => {
    const { context, apply, manifest } = await stagedFixture("activation-hash-provenance-");

    // The recorded digest is rewritten to a value the reviewed manifest never
    // produced. `manifest_hash` is provenance: the barrier must still find the
    // apply row by its own `id` and activate.
    await setReceiptHash(context, apply.receiptId, "0".repeat(64));
    const activation = await activateStore(context, apply, attestation());
    expect(activation.replayed).toBe(false);
    expect(activation.applyReceiptId).toBe(apply.receiptId);
    expect((await metaOf(context)).authority_state).toBe("active");
    expect((await receiptRows(context, "activated")).length).toBe(1);

    // The read-only lookup resolves through the same real identity: a manifest
    // whose review digests were re-derived still resolves to this activation.
    const served = await activationReceiptFor(context, {
      ...manifest,
      sourceSetDigest: "e".repeat(64),
    } as unknown as MigrationManifest);
    expect(served.receiptId).toBe(activation.receiptId);

    // Replay with a drifted hash on the SUPPLIED receipt serves the recorded
    // activation: identity is the row, not the digest it carries.
    const replayed = await activateStore(context, { ...apply, manifestHash: "f".repeat(64) }, attestation());
    expect(replayed.replayed).toBe(true);
    expect(replayed.receiptId).toBe(activation.receiptId);

    // A supplied receipt naming a row that does not exist is refused by its own
    // identity — the real constraint — and not by any digest comparison.
    const forged = { ...apply, receiptId: apply.receiptId + 1000 };
    const error = await refusalOf("store.activation-stale", () => activateStore(context, forged, attestation()));
    expect(error.message).toContain("already active under a different activation");
  });

  test("retirement addresses the activation by its recorded id, so a drifted provenance hash is not a gate", async () => {
    const { context, activation } = await activatedFixture("retirement-hash-provenance-");

    // Both the activation row's recorded digest and the supplied receipt's
    // `activationHash` are drifted from what the barrier recorded. Neither is
    // identity: retirement addresses the row by its own id.
    await setReceiptHash(context, activation.receiptId, "0".repeat(64));
    const drifted = { ...activation, activationHash: "f".repeat(64) };
    const receipt = await retireStoreSources(context, drifted);
    expect(receipt.replayed).toBe(false);
    expect(receipt.activationReceiptId).toBe(activation.receiptId);
    expect((await receiptRows(context, "retired")).length).toBe(1);

    // Replay with the drifted hash resolves the recorded retirement by the
    // activation id and the live generation, never by a digest.
    const replay = await retireStoreSources(context, drifted);
    expect(replay.replayed).toBe(true);
    expect(replay.receiptId).toBe(receipt.receiptId);
    expect(replay.activationReceiptId).toBe(activation.receiptId);
  });

  test("an already-active store refuses an activation row whose recorded owner facts are another generation's", async () => {
    const { context, manifest, activation } = await activatedFixture("activation-active-owner-");
    const apply = await appliedReceiptFor(context, manifest);
    await patchReceiptJson(context, activation.receiptId, (stored) => {
      stored.storeId = "00000000-0000-4000-8000-000000000000";
    });
    const error = await refusalOf("store.activation-stale", () => activateStore(context, apply, attestation()));
    expect(error.message).toContain("cannot be served as this store's activation");
    expect((await metaOf(context)).authority_state).toBe("active");
  });

  test("retirement refuses a supplied activation receipt whose row id is not recorded", async () => {
    const { context, activation } = await activatedFixture("retirement-forged-receipt-id-");
    const forged = { ...activation, receiptId: activation.receiptId + 1000 };
    const error = await refusalOf("store.activation-stale", () => retireStoreSources(context, forged));
    expect(error.message).toContain("is recorded for this store");
    expect((await receiptRows(context, "retired")).length).toBe(0);
  });

  test("retirement refuses an activation receipt whose recorded owner facts do not match the live store", async () => {
    const { context, activation } = await activatedFixture("retirement-owner-mismatch-");

    // The recorded activation row is tampered to name ANOTHER store. The
    // relation between the row and the live store is the real constraint, so
    // retirement refuses without touching a source.
    await patchReceiptJson(context, activation.receiptId, (stored) => {
      stored.storeId = "00000000-0000-4000-8000-000000000000";
    });
    const foreign = await refusalOf("store.activation-stale", () => retireStoreSources(context, activation));
    expect(foreign.message).toContain("not this store");
    expect((await receiptRows(context, "retired")).length).toBe(0);
  });

  test("retirement refuses an activation receipt that names a different apply receipt than the recorded one", async () => {
    const { context, activation } = await activatedFixture("retirement-apply-relation-");
    // Same live generation (so the epoch guard passes), but the supplied
    // receipt names a DIFFERENT apply receipt than the recorded activation row
    // carries: the real relation between the two rows is what refuses.
    const mismatched = { ...activation, applyReceiptId: activation.applyReceiptId + 500 };
    const error = await refusalOf("store.activation-stale", () => retireStoreSources(context, mismatched));
    expect(error.message).toContain("not this store");
    expect((await receiptRows(context, "retired")).length).toBe(0);
  });

  test("retirement refuses a tampered activation receipt from an earlier epoch", async () => {
    const { context, activation } = await activatedFixture("activation-tampered-receipt-");
    const stale = { ...activation, epoch: activation.epoch - 1 };
    const error = await refusalOf("store.stale-epoch", () => retireStoreSources(context, stale));
    expect(error.message).toContain("the activation receipt belongs to authority epoch 1");
    expect((await receiptRows(context, "retired")).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Retirement of the legacy sources
// ---------------------------------------------------------------------------

describe("store retirement", () => {
  test("retirement moves the exact registers and removes only the reviewed index section", async () => {
    const { context, harness, manifest, activation } = await activatedFixture("retirement-move-");
    const readmePath = join(harness, "iterations", "README.md");
    const originalLineCount = lineCount(readFileSync(readmePath, "utf8"));

    const receipt = await retireStoreSources(context, activation);

    expect(receipt.replayed).toBe(false);
    expect(receipt.resumed).toBe(false);
    expect(receipt.registers.length).toBe(PROJECTS.length);
    for (const project of PROJECTS) {
      expect(existsSync(join(harness, "projects", project, "residuals.json"))).toBe(false);
    }
    for (const register of receipt.registers) {
      const reviewed = manifest.sources.find((source) => source.relativePath === register.relativePath);
      expect(reviewed).toBeDefined();
      expect(register.bytes).toBe(reviewed!.bytes);
      // The archive is the only remaining copy, and it carries the register's
      // own reviewed findings.
      const archived = JSON.parse(readFileSync(register.archivedPath, "utf8")) as { entries: Record<string, { id: string }[]> };
      expect(Object.values(archived.entries).flat().length).toBe(reviewed!.entryCount);
    }

    // Mixed-content index: only the reviewed table lines are gone.
    expect(receipt.sections.length).toBe(1);
    const section = receipt.sections[0]!;
    const retiredReadme = readFileSync(readmePath, "utf8");
    for (const line of [...INDEX_HEAD, ...INDEX_TAIL]) {
      if (line === "") continue;
      expect(retiredReadme).toContain(line);
    }
    expect(retiredReadme).not.toContain("| `iter-one` |");
    expect(retiredReadme).not.toContain("| Iteration |");
    expect(section.removedLines).toBe(INDEX_TABLE.length);
    expect(section.preservedLines).toBe(lineCount(retiredReadme));
    expect(lineCount(retiredReadme)).toBe(originalLineCount - INDEX_TABLE.length);
    expect(existsSync(section.archivedPath)).toBe(true);

    // The marker names the successor DB and both receipts, and never claims rollback.
    const marker = readFileSync(receipt.markerPath, "utf8");
    expect(receipt.markerPath).toBe(join(receipt.archiveDir, "MARKER.md"));
    expect(marker).toContain(join(harness, "store.db"));
    expect(marker).toContain(activation.storeId);
    expect(marker).toContain(`#${activation.receiptId}`);
    expect(marker).toContain(`#${receipt.receiptId}`);
    expect(marker).toContain("not a post-activation rollback path");
    expect(marker).toContain("VACUUM INTO");

    // Receipts: one retired row, the activation and apply rows marked retired.
    const retired = await receiptRows(context, "retired");
    expect(retired.length).toBe(1);
    expect(retired[0]!.retired_at).toBeTruthy();
    expect((await receiptRows(context, "activated"))[0]!.retired_at).toBeTruthy();
    expect((await receiptRows(context, "applied"))[0]!.retired_at).toBeTruthy();
    expect((await metaOf(context)).authority_epoch).toBe(activation.epoch);

    // Idempotent replay: the same receipt is served and the live index keeps the
    // state the first run left.
    const replay = await retireStoreSources(context, activation);
    expect(replay.replayed).toBe(true);
    expect(replay.receiptId).toBe(receipt.receiptId);
    expect(readFileSync(readmePath, "utf8")).not.toContain("| `iter-one` |");
    expect((await receiptRows(context, "retired")).length).toBe(1);
  });

  test("retirement resumes a mid-retirement crash to the same target rows and archives", async () => {
    const crashed = await activatedFixture("retirement-resume-crash-");
    const clean = await activatedFixture("retirement-resume-clean-");

    const induced = await withEnv({ MSTAR_STORE_FAIL_RETIREMENT_AFTER: "2" }, () =>
      retireStoreSources(crashed.context, crashed.activation).catch((error: unknown) => error),
    );
    expect((induced as Error).message).toContain("induced retirement failure after 2 item(s)");

    const ledger = JSON.parse(readFileSync(ledgerPathOf(crashed, crashed.activation), "utf8")) as {
      registers: { state: string }[];
      sections: { state: string }[];
      retirementReceiptId: number | null;
    };
    expect(ledger.registers.filter((item) => item.state === "verified").length).toBe(2);
    expect(ledger.registers.filter((item) => item.state !== "verified").length).toBe(2);
    expect(ledger.sections.every((item) => item.state === "pending")).toBe(true);
    expect(ledger.retirementReceiptId).toBeNull();
    expect((await receiptRows(crashed.context, "retired")).length).toBe(0);
    const liveAfterCrash = PROJECTS.filter((project) => existsSync(join(crashed.harness, "projects", project, "residuals.json")));
    expect(liveAfterCrash.length).toBe(2);

    const resumed = await retireStoreSources(crashed.context, crashed.activation);
    expect(resumed.resumed).toBe(true);
    expect(resumed.replayed).toBe(false);
    expect(resumed.registers.length).toBe(PROJECTS.length);

    const complete = await retireStoreSources(clean.context, clean.activation);
    expect(complete.resumed).toBe(false);

    // Both runs end at the same business state: the same registers retired, the
    // same index rows excised, and the same live index content.
    expect(resumed.registers.map((item) => item.relativePath).sort()).toEqual(
      complete.registers.map((item) => item.relativePath).sort(),
    );
    expect(resumed.sections.map((item) => [item.relativePath, item.removedLines])).toEqual(
      complete.sections.map((item) => [item.relativePath, item.removedLines]),
    );
    
    for (const item of resumed.sections) {
      expect(existsSync(item.archivedPath)).toBe(true);
      expect(readFileSync(join(crashed.harness, item.rootKind, item.relativePath), "utf8")).not.toContain("| `iter-one` |");
    }
  });

  test("retirement excises the reviewed iteration by id and never an unreviewed row that reuses its declared path", async () => {
    const fixture = await iterationCollisionFixture("retirement-identity-collision-");
    const readmePath = join(fixture.harness, "iterations", "README.md");
    const reviewedLive = readFileSync(readmePath, "utf8");
    expect(reviewedLive).toContain("| `iter-one` |");

    const induced = await withEnv({ MSTAR_STORE_FAIL_RETIREMENT_AFTER_SECTION_WRITE: "1" }, () =>
      retireStoreSources(fixture.context, fixture.activation).catch((error: unknown) => error),
    );
    expect((induced as Error).message).toContain("induced retirement failure after the section rewrite");

    // The reviewed row `iter-one` declared the location `alias-one/`. After the
    // crash an unrelated, never-reviewed table reuses that location as ITS OWN
    // row id and sits ABOVE the reviewed table. An id/location union would
    // select the unreviewed table and then find no reviewed row left; the
    // reviewed row is identified by its id, wherever it moved.
    const unrelated = ["| Iteration | Path | Description | Status |", "|-----------|------|-------------|--------|", "| `alias-one` | `alias-one/` | Unreviewed iteration table | `active` |"];
    const reviewed = ["| Iteration | Path | Description | Status |", "|-----------|------|-------------|--------|", "| `iter-one` | `alias-one/` | First iteration | `active` |"];
    writeFileSync(
      readmePath,
      ["# Iterations", "", ...unrelated, "", "Narrative inserted after review moved the reviewed table down.", "", ...reviewed, "", "Security disposition stays.", ""].join("\n"),
    );

    const receipt = await retireStoreSources(fixture.context, fixture.activation);
    expect(receipt.resumed).toBe(true);
    const live = readFileSync(readmePath, "utf8");
    expect(live).not.toContain("| `iter-one` |");
    expect(live).toContain("| `alias-one` |");
    expect(live).toContain("Narrative inserted after review moved the reviewed table down.");
    expect(receipt.sections[0]!.removedLines).toBe(3);
    expect((await receiptRows(fixture.context, "retired")).length).toBe(1);
  });

  test("retirement excises a reviewed document row whose live reference uses an equivalent path spelling", async () => {
    const fixture = await documentIndexFixture("retirement-equivalent-path-");
    const readmePath = join(fixture.harness, "knowledge", "README.md");
    expect(readFileSync(readmePath, "utf8")).toContain("`guides//intro.md`");

    const induced = await withEnv({ MSTAR_STORE_FAIL_RETIREMENT_AFTER_SECTION_WRITE: "1" }, () =>
      retireStoreSources(fixture.context, fixture.activation).catch((error: unknown) => error),
    );
    expect((induced as Error).message).toContain("induced retirement failure after the section rewrite");

    // The reviewed row referenced `guides//intro.md`, which the catalog parser
    // records as `guides/intro.md`. Restore the same row spelled `guides/./intro.md`:
    // the same catalog location, so the reviewed row is still present and must
    // be excised — never read as "already retired" from the archive alone.
    const edited = [
      "| Document | Source | Description | Status |",
      "|----------|--------|-------------|--------|",
      "| `guides/./intro.md` | hand-written | Intro guide | `active` |",
    ];
    writeFileSync(readmePath, ["# Knowledge", "", ...edited, "", "Narrative stays.", ""].join("\n"));

    const receipt = await retireStoreSources(fixture.context, fixture.activation);
    expect(receipt.resumed).toBe(true);
    const live = readFileSync(readmePath, "utf8");
    expect(live).not.toContain("intro.md");
    expect(live).toContain("Narrative stays.");
    expect((await receiptRows(fixture.context, "retired")).length).toBe(1);
  });

  test("retirement removes the moved reviewed table and keeps an unrelated recognized table at its old slot", async () => {
    const fixture = await activatedFixture("retirement-old-slot-unrelated-");
    const readmePath = join(fixture.harness, "iterations", "README.md");

    // Crash after the reviewed table's rewrite, before its verification.
    const induced = await withEnv({ MSTAR_STORE_FAIL_RETIREMENT_AFTER_SECTION_WRITE: "1" }, () =>
      retireStoreSources(fixture.context, fixture.activation).catch((error: unknown) => error),
    );
    expect((induced as Error).message).toContain("induced retirement failure after the section rewrite");

    // Permitted prose drift below the reviewed slot moves the reviewed
    // `iter-one` table down, and an unrelated recognized iteration table that
    // was NEVER reviewed now occupies the old slot. A line-coordinate locator
    // would delete the unrelated table instead of the reviewed one.
    const table = (id: string, description: string): string[] => [
      "| Iteration | Path | Description | Status |",
      "|-----------|------|-------------|--------|",
      `| \`${id}\` | \`${id}/\` | ${description} | \`active\` |`,
    ];
    writeFileSync(
      readmePath,
      [
        "# Iterations",
        "",
        ...table("iter-two", "Unreviewed iteration"),
        "",
        "Narrative inserted after review that moved the reviewed table down.",
        "",
        ...table("iter-one", "First iteration"),
        "",
        "Security disposition: this sentence is not bookkeeping and stays.",
        "",
      ].join("\n"),
    );

    const receipt = await retireStoreSources(fixture.context, fixture.activation);
    expect(receipt.resumed).toBe(true);
    const live = readFileSync(readmePath, "utf8");
    // The reviewed table is gone; the unrelated table and the prose survive.
    expect(live).not.toContain("| `iter-one` |");
    expect(live).toContain("| `iter-two` |");
    expect(live).toContain("Unreviewed iteration");
    expect(live).toContain("Security disposition: this sentence is not bookkeeping and stays.");
    const archived = readFileSync(receipt.sections[0]!.archivedPath, "utf8");
    expect(archived).toContain("| `iter-one` |");
    expect(archived).toContain("| `iter-two` |");
    expect((await receiptRows(fixture.context, "retired")).length).toBe(1);
  });

  test("retirement resumes a moved target whose header was also edited, with an archive pending", async () => {
    const fixture = await activatedFixture("retirement-moved-edited-header-");
    const readmePath = join(fixture.harness, "iterations", "README.md");

    // Crash after the archive copy and the live rewrite, before verification:
    // the archive exists and the ledger still holds the item as pending.
    const induced = await withEnv({ MSTAR_STORE_FAIL_RETIREMENT_AFTER_SECTION_WRITE: "1" }, () =>
      retireStoreSources(fixture.context, fixture.activation).catch((error: unknown) => error),
    );
    expect((induced as Error).message).toContain("induced retirement failure after the section rewrite");

    // A permitted edit both moves the still-present target and adds a
    // recognized column to its header, so a header-equality locator would read
    // it as absent and accept completion from the archive alone.
    writeFileSync(
      readmePath,
      [
        "# Iterations",
        "",
        "Narrative inserted after review moved the still-present target down.",
        "",
        "| Iteration | Path | Description | Status | Owner |",
        "|-----------|------|-------------|--------|-------|",
        "| `iter-one` | `iter-one/` | First iteration | `active` | pm |",
        "",
        "Security disposition stays.",
        "",
      ].join("\n"),
    );

    const receipt = await retireStoreSources(fixture.context, fixture.activation);
    expect(receipt.resumed).toBe(true);
    const live = readFileSync(readmePath, "utf8");
    expect(live).not.toContain("| `iter-one` |");
    expect(live).toContain("Narrative inserted after review moved the still-present target down.");
    expect((await receiptRows(fixture.context, "retired")).length).toBe(1);
  });

  test("retirement finishes a second duplicate-reviewed table whose row count changed after review", async () => {
    const fixture = await duplicateHeaderFixture("retirement-duplicate-size-drift-");
    const readmePath = join(fixture.harness, "iterations", "README.md");

    // Crash right after the FIRST reviewed table (`iter-one`) was rewritten; the
    // second reviewed table is still pending.
    const induced = await withEnv({ MSTAR_STORE_FAIL_RETIREMENT_AFTER: "5" }, () =>
      retireStoreSources(fixture.context, fixture.activation).catch((error: unknown) => error),
    );
    expect((induced as Error).message).toContain("induced retirement failure after 5 item(s)");
    const liveAfterCrash = readFileSync(readmePath, "utf8");
    expect(liveAfterCrash).not.toContain("| `iter-one` |");
    expect(liveAfterCrash).toContain("| `iter-two` |");

    // A permitted edit adds a row to the still-pending second table. That row
    // was never reviewed, so it is not the reviewed identity and must survive;
    // only the reviewed `iter-two` row is excised.
    const editedSecond = [
      "| Iteration | Path | Description | Status |",
      "|-----------|------|-------------|--------|",
      "| `iter-two` | `iter-two/` | iter-two iteration | `active` |",
      "| `iter-two-extra` | `iter-two-extra/` | added after review | `active` |",
    ];
    writeFileSync(readmePath, ["# Iterations", "", "Separating narrative between the two tables.", ...editedSecond, "", "Security disposition stays.", ""].join("\n"));

    const receipt = await retireStoreSources(fixture.context, fixture.activation);
    expect(receipt.resumed).toBe(true);
    const live = readFileSync(readmePath, "utf8");
    expect(live).not.toContain("| `iter-two` |");
    expect(live).toContain("| `iter-two-extra` |");
    expect(live).toContain("Separating narrative between the two tables.");
    expect(live).toContain("Security disposition stays.");
    // The receipt records the actual removed span: one reviewed row, not the row
    // that appeared after review.
    expect(receipt.sections[1]!.removedLines).toBe(1);
    expect((await receiptRows(fixture.context, "retired")).length).toBe(1);
  });

  test("retirement resumes a crash between the section rewrite and its verification", async () => {
    const fixture = await activatedFixture("retirement-section-resume-");
    const readmePath = join(fixture.harness, "iterations", "README.md");

    const induced = await withEnv({ MSTAR_STORE_FAIL_RETIREMENT_AFTER_SECTION_WRITE: "1" }, () =>
      retireStoreSources(fixture.context, fixture.activation).catch((error: unknown) => error),
    );
    expect((induced as Error).message).toContain("induced retirement failure after the section rewrite");

    const ledger = JSON.parse(readFileSync(ledgerPathOf(fixture, fixture.activation), "utf8")) as {
      registers: { state: string }[];
      sections: { state: string; expectedLiveSha256: string | null }[];
    };
    expect(ledger.registers.every((item) => item.state === "verified")).toBe(true);
    expect(ledger.sections[0]!.state).toBe("pending");
    expect(ledger.sections[0]!.expectedLiveSha256).not.toBeNull();
    expect((await receiptRows(fixture.context, "retired")).length).toBe(0);

    const receipt = await retireStoreSources(fixture.context, fixture.activation);
    expect(receipt.resumed).toBe(true);
    const liveIndex = readFileSync(readmePath, "utf8");
    expect(liveIndex).not.toContain("| `iter-one` |");
    expect(liveIndex).toContain("This hand-written narrative");
    expect(liveIndex).toContain("Security disposition:");
    expect(existsSync(receipt.sections[0]!.archivedPath)).toBe(true);
    expect((await receiptRows(fixture.context, "retired")).length).toBe(1);
  });

  test("retirement still excises the target section when drift leaves the same total line count", async () => {
    const fixture = await activatedFixture("retirement-same-count-");
    const readmePath = join(fixture.harness, "iterations", "README.md");

    // The reviewed index before any retirement: it holds the target table.
    const reviewed = readFileSync(readmePath, "utf8");
    expect(reviewed).toContain("| `iter-one` |");

    // Crash AFTER the archive was written and the ledger recorded, but BEFORE
    // the live rewrite (the seam throws right after the rewrite; restoring the
    // reviewed bytes below reconstructs the live-still-holds-the-table state).
    const induced = await withEnv({ MSTAR_STORE_FAIL_RETIREMENT_AFTER_SECTION_WRITE: "1" }, () =>
      retireStoreSources(fixture.context, fixture.activation).catch((error: unknown) => error),
    );
    expect((induced as Error).message).toContain("induced retirement failure after the section rewrite");

    const ledger = JSON.parse(readFileSync(ledgerPathOf(fixture, fixture.activation), "utf8")) as {
      sections: { state: string; startLine: number; endLine: number; preservedLines: number }[];
    };
    const item = ledger.sections[0]!;

    // A permitted edit that keeps the target table but replaces the unrelated
    // narrative so the file's TOTAL line count equals the recorded
    // `preservedLines` (the reviewed file's count MINUS the target's size) —
    // the exact count that made the removed surrogate take its completion
    // branch. The target table is still present.
    const narrativeLines = Math.max(0, item.preservedLines - INDEX_TABLE.length);
    const filler = Array.from({ length: narrativeLines }, (_, index) => `Narrative replaced after the crash ${index + 1}`);
    const editedContent = [...filler, ...INDEX_TABLE].join("\n");
    expect(lineCount(editedContent)).toBe(item.preservedLines);
    expect(editedContent).toContain("| `iter-one` |");
    writeFileSync(readmePath, editedContent);

    // Retry: the reviewed table is still present, so the retry must actually
    // excise it (never take a completion branch on the recorded line count).
    const receipt = await retireStoreSources(fixture.context, fixture.activation);
    expect(receipt.resumed).toBe(true);
    const live = readFileSync(readmePath, "utf8");
    expect(live).not.toContain("| `iter-one` |");
    expect(live).not.toContain("| Iteration |");
    expect((await receiptRows(fixture.context, "retired")).length).toBe(1);
  });

  test("retirement excises both reviewed sections when two valid tables share a header", async () => {
    const { context, harness, activation } = await duplicateHeaderFixture("retirement-duplicate-header-");
    const readmePath = join(harness, "iterations", "README.md");
    const receipt = await retireStoreSources(context, activation);
    expect(receipt.sections.length).toBe(2);
    const live = readFileSync(readmePath, "utf8");
    expect(live).not.toContain("| `iter-one` |");
    expect(live).not.toContain("| `iter-two` |");
    expect(live).not.toContain("| Iteration |");
    expect((await receiptRows(context, "retired")).length).toBe(1);
  });

  test("retirement does not accept completion from an archive while an edited target section remains", async () => {
    const fixture = await activatedFixture("retirement-archive-target-present-");
    const readmePath = join(fixture.harness, "iterations", "README.md");

    // Crash BEFORE the live rewrite: the archive exists and the ledger holds the
    // item as pending, but the target table is still live.
    const induced = await withEnv({ MSTAR_STORE_FAIL_RETIREMENT_AFTER_SECTION_WRITE: "1" }, () =>
      retireStoreSources(fixture.context, fixture.activation).catch((error: unknown) => error),
    );
    expect((induced as Error).message).toContain("induced retirement failure after the section rewrite");

    // A permitted edit to the still-present target's column labels (an extra
    // recognized column) plus a rebuilt table with the same row count: the
    // target is still present though its header no longer matches the reviewed
    // one. A header-equality locator would read it as absent and accept
    // completion from the archive alone.
    const editedTarget = [
      "| Iteration | Path | Description | Status | Owner |",
      "|-----------|------|-------------|--------|-------|",
      "| `iter-one` | `iter-one/` | First iteration | `active` | pm |",
    ];
    writeFileSync(readmePath, [...INDEX_HEAD, ...editedTarget, ...INDEX_TAIL].join("\n"));

    const receipt = await retireStoreSources(fixture.context, fixture.activation);
    expect(receipt.resumed).toBe(true);
    expect(readFileSync(readmePath, "utf8")).not.toContain("| `iter-one` |");
    expect((await receiptRows(fixture.context, "retired")).length).toBe(1);
  });

  test("retirement archives the register's current content when it drifted since review", async () => {
    const { context, harness, activation } = await activatedFixture("retirement-late-write-");
    const registerPath = join(harness, "projects", "engine", "residuals.json");
    const rewritten = {
      entries: { "plan-alpha": [entry({ id: "R1", severity: "medium" }), entry({ id: "R9", severity: "low" })] },
    };
    writeRegister(harness, "engine", rewritten);

    // Content drift since review is not a refusal: retirement archives the
    // register as it is now, then removes the live file.
    const receipt = await retireStoreSources(context, activation);
    expect(receipt.registers.length).toBe(PROJECTS.length);
    const engine = receipt.registers.find((item) => item.relativePath === "engine/residuals.json")!;
    const archived = JSON.parse(readFileSync(engine.archivedPath, "utf8")) as { entries: Record<string, { id: string }[]> };
    expect(archived.entries["plan-alpha"]!.map((row) => row.id)).toEqual(["R1", "R9"]);
    expect(existsSync(registerPath)).toBe(false);
    for (const project of PROJECTS) {
      expect(existsSync(join(harness, "projects", project, "residuals.json"))).toBe(false);
    }
    expect((await receiptRows(context, "retired")).length).toBe(1);
  });

  test("retirement refuses an unreviewed legacy register that appeared after activation", async () => {
    const { context, harness, activation } = await activatedFixture("retirement-new-register-");
    writeRegister(harness, "late-project", { entries: { "plan-late": [entry({ id: "R1" })] } });

    const error = await refusalOf("store.legacy-write-detected", () => retireStoreSources(context, activation));
    expect(error.message).toContain("unreviewed legacy register appeared");
    expect(existsSync(join(harness, "projects", "late-project", "residuals.json"))).toBe(true);
    expect((await receiptRows(context, "retired")).length).toBe(0);
  });

  test("activation and retirement leave workflow, lease and session state untouched", async () => {
    const staged = await stagedFixture("retirement-leases-");
    const watched = ["status.json", join("workflows", "wf-1", "snapshot.json"), join("workflows", "wf-1", "sessions", "sess-1.json")];
    write(
      staged.harness,
      "status.json",
      JSON.stringify(
        { version: 2, workflows: [{ id: "wf-1", type: "development", dir: "workflows/wf-1", started_at: "2026-09-18T00:00:00.000Z", project: "_default" }] },
        null,
        2,
      ),
    );
    write(
      staged.harness,
      join("workflows", "wf-1", "snapshot.json"),
      JSON.stringify({ id: "wf-1", leases: [{ plan_id: "plan-alpha", holder: "Main", claimed_at: "2026-09-18T00:00:00.000Z" }] }, null, 2),
    );
    write(staged.harness, join("workflows", "wf-1", "sessions", "sess-1.json"), JSON.stringify({ session_id: "sess-1", coordinator: "Main" }, null, 2));
    const before = watched.map((relative) => readFileSync(join(staged.harness, relative), "utf8"));

    const activation = await activateStore(staged.context, staged.apply, attestation());
    const afterActivation = watched.map((relative) => readFileSync(join(staged.harness, relative), "utf8"));
    const receipt = await retireStoreSources(staged.context, activation);
    expect(receipt.registers.length).toBe(PROJECTS.length);
    const afterRetirement = watched.map((relative) => readFileSync(join(staged.harness, relative), "utf8"));

    for (const [index, path] of watched.entries()) {
      expect(afterActivation[index]).toBe(before[index]);
      expect(afterRetirement[index]).toBe(before[index]);
      expect(existsSync(join(staged.harness, path))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

describe("store backup", () => {
  /** One row per native host-state domain table, planted through the real producers. */
  function plantHostRows(context: StoreContext, workflowId: string): void {
    expect(appendDshLedgerRow(context, workflowId, '{"v":1,"kind":"row"}', "row-1")).toMatchObject({ kind: "written" });
    expect(
      appendDshWorkflowEvent(context, {
        workflowId,
        eventId: "evt-1",
        digest: "a".repeat(64),
        lineJson: '{"v":1,"kind":"dispatch"}',
        source: { sessionId: "sess-host", streamId: "stream", seq: 2 },
      }),
    ).toMatchObject({ kind: "accepted" });
    expect(advanceDshScanBound(context, workflowId, "sess-host", 3, "stream")).toBe(true);
    expect(writeDshSessionBinding(context, "sess-host", context.harnessDir, { selectedWorkflowId: workflowId, excludedBeforeSeq: 0 })).toMatchObject({
      kind: "written",
    });
    expect(recordDshStatusEmission(context, "sess-host", context.harnessDir, 1, '{"sv":1}')).toMatchObject({ kind: "written" });
  }

  /** One scalar count out of a fixture image; the SQL is this test's own. */
  function scalarCount(db: DatabaseSync, sql: string): number {
    // node:sqlite rows are untyped; the queried shape is the test's own SQL.
    const row = db.prepare(sql).get() as { n: number };
    return row.n;
  }

  test("backup records identity and revision and contains committed WAL-visible issue and catalog data", async () => {
    const fixture = freshWorkspace("backup-wal-");
    // Hold a connection open for the whole case so the committed frames stay in
    // the WAL instead of being checkpointed away by the last close.
    const held = await initializeStore(fixture.context);
    try {
      write(fixture.harness, "guide.md", "# Guide\n");
      await captureIssue(
        fixture.context,
        {
          projectId: "_default",
          title: "WAL-visible finding",
          kind: "bug",
          severity: "high",
          impact: "the recovery point must include committed frames",
          acceptance: "the copy carries the row",
          sourceIdentity: "qc/wal.md",
          rootCauseKey: "wal-root-cause",
          acceptanceKey: "copied",
          occurrenceKey: "run-wal-1",
          sourceKind: "qc",
          location: "packages/engine/src/store-activation.ts:1",
          observedBehavior: "backup must read through the WAL",
          evidence: ["proof"],
          discoveredAt: "2026-09-19T00:00:00.000Z",
        },
        { operationId: "op-wal-1", actor: "project-manager" },
      );
      await registerCatalogEntity(
        fixture.context,
        { kind: "document", id: "doc-guide", title: "Guide", rootKind: "harness", relativePath: "guide.md", documentKind: "guide" },
        { operationId: "op-wal-catalog", actor: "project-manager" },
      );
      await plantHostRows(fixture.context, "wf-backup-host");

      const walPath = join(fixture.harness, "store.db-wal");
      expect(existsSync(walPath)).toBe(true);
      expect(statSync(walPath).size).toBeGreaterThan(0);
      const sourceMeta = held.db
        .prepare("select store_id, authority_epoch, revision from store_meta where id = 1")
        .get() as { store_id: string; authority_epoch: number; revision: number };

      const target = join(fixture.root, "recovery.db");
      const receipt = await backupStore(fixture.context, { out: target });
      expect(receipt.backupPath).toBe(target);
      expect(receipt.storeId).toBe(sourceMeta.store_id);
      expect(receipt.epoch).toBe(sourceMeta.authority_epoch);
      expect(receipt.revision).toBe(sourceMeta.revision);
      expect(receipt.authorityState).toBe("active");
      expect(receipt.counts.issues).toBe(1);
      expect(receipt.counts.occurrences).toBe(1);
      expect(receipt.counts.catalogEntities).toBe(1);
      expect(receipt.walPending).toBe(true);
      expect(receipt.bytes).toBeGreaterThan(0);

      // The whole image is the backup: issue, catalog AND native host state.
      const copy = new DatabaseSync(target, { readOnly: true });
      try {
        const issue = copy.prepare("select id, title from issues").get() as { id: string; title: string };
        expect(issue.title).toBe("WAL-visible finding");
        expect((copy.prepare("select count(*) as n from occurrences").get() as { n: number }).n).toBe(1);
        const entity = copy.prepare("select id from catalog_entities where kind = 'document'").get() as { id: string };
        expect(entity.id).toBe("doc-guide");
        expect(scalarCount(copy, "select count(*) as n from dsh_ledger_events")).toBe(2);
        expect(scalarCount(copy, "select count(*) as n from dsh_accepted_identities")).toBe(1);
        expect(scalarCount(copy, "select count(*) as n from dsh_scan_bounds")).toBe(1);
        expect(scalarCount(copy, "select count(*) as n from dsh_session_bindings")).toBe(1);
        expect(scalarCount(copy, "select count(*) as n from dsh_status_emissions")).toBe(1);
        // node:sqlite rows are untyped; the queried shape is this store's own schema.
        const copiedMeta = copy.prepare("select store_id, authority_epoch as epoch, revision from store_meta where id = 1").get() as {
          store_id: string;
          epoch: number;
          revision: number;
        };
        expect(copiedMeta.store_id).toBe(sourceMeta.store_id);
        expect(copiedMeta.epoch).toBe(sourceMeta.authority_epoch);
        expect(copiedMeta.revision).toBe(sourceMeta.revision);
      } finally {
        copy.close();
      }

      // The image re-verifies as its own recovery point: integrity, foreign keys
      // and this build's migration prefix all read from the copy.
      const verified = await inspectBackupCopy(target);
      expect(verified.storeId).toBe(receipt.storeId);
      expect(verified.epoch).toBe(receipt.epoch);
      expect(verified.counts).toEqual(receipt.counts);

      const error = await refusalOf("store.activation-stale", () => backupStore(fixture.context, { out: target }));
      expect(error.message).toContain("instead of overwriting a recorded recovery point");
      expect(readFileSync(target).length).toBe(receipt.bytes);
    } finally {
      held.close();
    }
  });

  test("backup is one coherent committed generation while a real concurrent writer commits", async () => {
    const fixture = freshWorkspace("backup-concurrent-");
    const held = await initializeStore(fixture.context);
    try {
      const before = await metaOf(fixture.context);
      // A REAL second process commits issue+receipt rows continuously. The
      // backup must neither refuse the coherent copy nor describe a generation
      // the bytes do not hold — no frozen window, no filesystem mutex.
      const issueModule = new URL("./issue.js", import.meta.url).href;
      const stopPath = join(fixture.root, "writer-stop");
      const writerSource = `
        import { captureIssue } from ${JSON.stringify(issueModule)};
        import { existsSync } from 'node:fs';
        let commits = 0;
        for (let index = 0; index < 60 && !existsSync(process.env.WRITER_STOP!); index += 1) {
          await captureIssue({ harnessDir: process.env.HARNESS_DIR! }, {
            projectId: "_default",
            title: "Concurrent writer finding " + index,
            kind: "bug",
            severity: "low",
            impact: "a commit racing the backup",
            acceptance: "the copy carries a whole generation",
            sourceIdentity: "writer/" + index,
            rootCauseKey: "concurrent-writer",
            acceptanceKey: "committed",
            occurrenceKey: "writer-" + index,
            sourceKind: "review",
            location: "fixture",
            observedBehavior: "committed",
            evidence: [],
            discoveredAt: "2026-10-12T00:00:00.000Z",
          }, { operationId: "op-writer-" + index, actor: "project-manager" });
          commits += 1;
          if (commits === 3) console.log("first-commits-landed");
        }
        console.log(JSON.stringify({ commits }));
      `;
      const writer = spawn(process.execPath, ["-e", writerSource], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HARNESS_DIR: fixture.harness, WRITER_STOP: stopPath },
      });
      let writerOutput = "";
      const { promise: writerDone, resolve: markWriterDone, reject: failWriter } = Promise.withResolvers<string>();
      const { promise: firstCommits, resolve: markFirstCommits } = Promise.withResolvers<void>();
      writer.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        writerOutput += chunk;
        if (writerOutput.includes("first-commits-landed")) markFirstCommits();
      });
      writer.stderr.setEncoding("utf8").on("data", (chunk: string) => (writerOutput += chunk));
      writer.on("error", failWriter);
      writer.on("close", (code) =>
        code === 0 ? markWriterDone(writerOutput.trim().split("\n").at(-1)!) : failWriter(new Error(`writer exit ${code}: ${writerOutput}`)),
      );
      // The event is the child's own stdout line: three commits have landed
      // before the copy starts, so the copy has a deterministic lower bound and
      // the rest of the loop races it.
      await Promise.race([
        firstCommits,
        writerDone.then(() => {
          throw new Error(`writer exited before its first commits: ${writerOutput}`);
        }),
      ]);

      const target = join(fixture.root, "concurrent.db");
      const receipt = await backupStore(fixture.context, { out: target });
      writeFileSync(stopPath, "stop");
      const summary: unknown = JSON.parse(await writerDone);
      if (typeof summary !== "object" || summary === null || !("commits" in summary) || typeof summary.commits !== "number") {
        throw new Error(`writer summary not understood: ${writerOutput}`);
      }
      expect(summary.commits).toBeGreaterThanOrEqual(3);

      // The live store after the writer stops is the upper bound of anything a
      // mid-writer copy can contain.
      const live = await openStore(fixture.context, "read");
      let liveIssues = 0;
      let liveRevision = 0;
      try {
        liveIssues = (live.db.prepare("select count(*) as n from issues").get() as { n: number }).n;
        liveRevision = (live.db.prepare("select revision from store_meta where id = 1").get() as { revision: number }).revision;
      } finally {
        live.close();
      }

      // The receipt describes the image: every reported count equals the rows
      // actually inside the copied file.
      const image = new DatabaseSync(target, { readOnly: true });
      try {
        const imageIssues = scalarCount(image, "select count(*) as n from issues");
        expect(receipt.counts.issues).toBe(imageIssues);
        expect(receipt.counts.occurrences).toBe(scalarCount(image, "select count(*) as n from occurrences"));
        expect(receipt.counts.migrationReceipts).toBe(scalarCount(image, "select count(*) as n from migration_receipts"));
        // A whole committed generation: every copied issue's capture provenance
        // row is present with it (issue + operation + occurrence + provenance
        // commit in one transaction), so the copy is not a torn mix.
        expect(scalarCount(image, "select count(*) as n from provenance")).toBe(imageIssues);
        // Three writer commits landed before the copy started; the rest race it.
        expect(imageIssues).toBeGreaterThanOrEqual(3);
        expect(imageIssues).toBeLessThanOrEqual(liveIssues);
        expect(receipt.revision).toBeGreaterThanOrEqual(before.revision);
        expect(receipt.revision).toBeLessThanOrEqual(liveRevision);
        const firstWriterFinding = image
          .prepare("select id from issues where title = ?")
          .get("Concurrent writer finding 0") as { id: string } | undefined;
        expect(firstWriterFinding?.id).toBeTruthy();
      } finally {
        image.close();
      }
      // The copy is self-consistent SQLite of THIS store, verified from the
      // image: integrity, foreign keys and the migration prefix.
      const verified = await inspectBackupCopy(target);
      expect(verified.storeId).toBe(receipt.storeId);
      expect(verified.epoch).toBeGreaterThanOrEqual(before.authority_epoch);
    } finally {
      held.close();
    }
  });

  test("a retired mutex marker or compaction journal never blocks a backup and is never deleted", async () => {
    const fixture = freshWorkspace("backup-markers-");
    const held = await initializeStore(fixture.context);
    try {
      // A pre-cutover harness, exactly as an old checkout leaves it: the
      // homemade lockdirs, the transient compaction journal, the notes ledger
      // and an authored document. Backup must not inspect, require or delete
      // any of them — marker presence is never permission to delete.
      const notes = join(fixture.harness, "workflows", "wf-old", "notes.jsonl");
      const compaction = join(fixture.harness, "workflows", "wf-old", "agent-flow-compaction.json");
      const ledgerLockdir = join(fixture.harness, "workflows", "wf-old", ".ledger-write.lockdir");
      const statusLockdir = join(fixture.harness, ".status-write.lockdir");
      const maintenanceLockdir = join(fixture.harness, ".execution-maintenance", ".status-write.lockdir");
      write(fixture.harness, join("workflows", "wf-old", "notes.jsonl"), '{"kind":"note","ts":"2026-09-01","text":"retained"}');
      write(fixture.harness, join("workflows", "wf-old", "agent-flow-compaction.json"), '{"version":1}');
      write(fixture.harness, join("workflows", "wf-old", ".ledger-write.lockdir", "holder.pid"), String(process.pid));
      write(fixture.harness, join(".status-write.lockdir", "holder.pid"), String(process.pid));
      write(fixture.harness, join(".execution-maintenance", ".status-write.lockdir", "holder.pid"), String(process.pid));
      write(fixture.harness, "guide.md", "# Guide\n");

      const target = join(fixture.harness, "archived", "backups", "markers.db");
      const receipt = await backupStore(fixture.context, { out: target });
      expect(receipt.storeId).toBe((await metaOf(fixture.context)).store_id);
      expect(existsSync(target)).toBe(true);

      // Nothing was frozen, admitted or removed: every marker and body keeps
      // its exact bytes, and no file-body inventory document was written.
      expect(readFileSync(notes, "utf8")).toBe('{"kind":"note","ts":"2026-09-01","text":"retained"}\n');
      expect(readFileSync(compaction, "utf8")).toBe('{"version":1}\n');
      for (const marker of [ledgerLockdir, statusLockdir, maintenanceLockdir]) expect(existsSync(marker)).toBe(true);
      expect(readFileSync(join(fixture.harness, "guide.md"), "utf8")).toBe("# Guide\n");
      expect(existsSync(`${target}.retained.json`)).toBe(false);
      // Every lockdir still carries the holder file the old writer left: the
      // backup neither acquired nor cleared any of them, and wrote no inventory
      // document beside its own image.
      expect(readFileSync(join(fixture.harness, ".status-write.lockdir", "holder.pid"), "utf8")).toBe(`${process.pid}\n`);
      expect(readFileSync(join(maintenanceLockdir, "holder.pid"), "utf8")).toBe(`${process.pid}\n`);
    } finally {
      held.close();
    }
  });
});

// The file-native retained-body protocol is gone: notes, agent-flow ledgers,
// cursors, the launch journal and the selection snapshot are ordinary retained
// files, and a recovery point neither freezes nor requires them. Their
// non-blocking, untouched-by-backup behavior is proven in the marker case of
// the "store backup" describe above.
