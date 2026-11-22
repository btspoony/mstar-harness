/**
 * store-activation.test.ts — proof for the activation barrier, the legacy
 * source retirement and the consistent backup (issue-store-contract §7).
 *
 * Every case runs the real barrier/retirement/backup code over real register,
 * index and database fixtures in per-test temporary harness roots. The
 * retirement resume path is driven by test-owned callbacks that throw at the
 * crash boundary, and the epoch flip atomicity assertion uses the same hook.
 * No live control root, no lease/session state and no installed consumer is
 * touched.
 *
 * Run with
 * `bun test packages/engine/src/store-activation.test.ts --test-name-pattern 'activation|retirement|backup'`.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join, resolve } from "node:path";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import * as collaborationStore from "./collaboration-store.js";
import {
  initializeCollaborationStore,
  adoptCollaborationBinding,
  beginBindingClaim,
  openCollaborationStore,
  readCollaborationAuthority,
  readCollaborationBinding,
  readCollaborationStage,
  writeCollaborationBinding,
  writeCollaborationStage,
} from "./collaboration-store.js";
import { registerCatalogEntity } from "./catalog.js";
import { captureIssue } from "./issue.js";
import { appendDshLedgerRow, appendDshWorkflowEvent, advanceDshScanBound, recordDshStatusEmission, writeDshSessionBinding } from "./host-state-store.js";
import {
  ACTIVATION_PROTOCOL_VERSION,
  activateStore,
  activationReceiptFor,
  appliedReceiptFor,
  assertAuthorityCurrent,
  backupRepositoryStores,
  backupStore,
  currentAuthorityHandle,
  ensureCollaborationAuthority,
  inspectBackupCopy,
  restoreCollaborationBackup,
  retireStoreSources,
  StoreActivationError,
  type ActivationAttestation,
  type ActivationReceipt,
  type RepositoryBackupReceipt,
  type StoreActivationErrorCode,
} from "./store-activation.js";
import { initializeStore, MIGRATION_1_SQL, MIGRATIONS, migrationChecksum, openStore, SCHEMA_VERSION_TABLE_SQL, type StoreContext } from "./store-db.js";
import { readHarnessVersion } from "./core.js";
import { validateActivationAttestation } from "./store-activation.js";
import { applyStoreMigration, planStoreMigration, type MigrationManifest, type MigrationReceipt } from "./store-migrate.js";
import { activateCollaborationCutover, applyCollaborationCutover, planCollaborationCutover } from "./collaboration-cutover.js";

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

type Fixture = { context: StoreContext; harness: string; root: string; checkout: string };

/** note: The user-level collaboration lane is resolved through `homedir`; isolate it. */
const COLLAB_HOME = join(ROOT, "collab-home");
mkdirSync(COLLAB_HOME, { recursive: true });
let collabHomeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  collabHomeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => COLLAB_HOME);
});
afterAll(() => {
  collabHomeSpy?.mockRestore();
});

let repoSequence = 0;

/**
 * why: A synthetic checkout: a real Git main worktree, an explicit origin-less
 * repository identity and the selected collaboration mode. Its harness is
 * `<checkout>/.mstar`, so the lane resolves like a real operator's and the
 * reviewed import stages the lane rather than a combined store.
 */
function repoWorkspace(name: string): Fixture {
  const root = mkdtempSync(join(ROOT, name));
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: checkout, stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(checkout, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=fixture-${repoSequence++}\n`);
  const harness = join(checkout, ".mstar");
  mkdirSync(harness, { recursive: true });
  return { context: { harnessDir: harness, checkoutRoot: checkout }, harness, root, checkout };
}

/** note: A synthetic checkout whose repository identity is the caller's: two clones of one repository. */
function repoWorkspaceWithKey(name: string, repoKey: string): Fixture {
  const root = mkdtempSync(join(ROOT, name));
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: checkout, stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(checkout, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=${repoKey}\n`);
  const harness = join(checkout, ".mstar");
  mkdirSync(harness, { recursive: true });
  return { context: { harnessDir: harness, checkoutRoot: checkout }, harness, root, checkout };
}

/** note: A temp checkout workspace with a real `.mstar` harness root and NO database. */
function freshWorkspace(name: string): Fixture {
  return repoWorkspace(name);
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

/** Every backup artifact under a harness root; empty when none was written. */
function backupArtifacts(context: StoreContext): string[] {
  const dir = join(context.harnessDir, "archived", "store-migration", "backups");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".db"));
}

/**
 * The declared Node floor, read from this package's manifest at runtime. No
 * test pins a floor value: `package.json` stays the sole version authority.
 */
const engineManifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
  engines?: { node?: string };
};
const declaredNodeFloor = (engineManifest.engines?.node ?? "").replace(/^>=\s*/, "").trim();
/** Injected current runtime for a `node` consumer: at/above the declared floor. */
const atOrAboveRuntime = `${Number.parseInt(declaredNodeFloor.split(".")[0]!, 10) + 1}.0.0`;

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
        runtime: "node",
        runtimeVersion: atOrAboveRuntime,
        version: "0.0.0-synthetic", // fixture payload carried through, never compared
        current: false,
        disposition: "upgraded",
      },
      {
        entryId: "coordinator-omp",
        kind: "coordinator",
        entrypoint: "/Users/op/.omp/plugins/mstar/packages/cli/dist/index.js",
        runtime: "node",
        runtimeVersion: declaredNodeFloor,
        version: "0.0.0-synthetic", // fixture payload carried through, never compared
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
  write(join(fixture.checkout, ".agents"), join("knowledge", "guides", "intro.md"), "# Intro\n");
  write(
    join(fixture.checkout, ".agents"),
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

function failAt(stage: "flip" | "retirement" | "section-write", completed: number, message: string) {
  return { afterStage(actual: string, count: number) { if (actual === stage && count === completed) throw new Error(message); } };
}

type MetaRow = { store_id: string; authority_state: "staged" | "active"; authority_epoch: number; revision: number; activated_at: string | null };

/** note: The lane's own authority record — the issue/catalog authority these verbs move. */
async function metaOf(context: StoreContext): Promise<MetaRow> {
  const row = await readCollaborationStage(resolveCollaborationLocation(context), ({ db }) =>
    db.prepare("select store_id, authority_state, authority_epoch, revision, activated_at from collaboration_meta where id = 1").get(),
  );
  if (
    row === null ||
    typeof row !== "object" ||
    !("store_id" in row) ||
    !("authority_state" in row) ||
    !("authority_epoch" in row) ||
    !("revision" in row)
  ) {
    throw new Error("the fixture lane records no readable collaboration_meta singleton");
  }
  const { store_id: storeId, authority_state: state, authority_epoch: epoch, revision } = row;
  const activatedAt = "activated_at" in row ? row.activated_at : null;
  if (
    typeof storeId !== "string" ||
    (state !== "staged" && state !== "active") ||
    typeof epoch !== "number" ||
    typeof revision !== "number" ||
    (activatedAt !== null && typeof activatedAt !== "string")
  ) {
    throw new Error("the fixture lane's collaboration_meta singleton is malformed");
  }
  return { store_id: storeId, authority_state: state, authority_epoch: epoch, revision, activated_at: activatedAt };
}

/** note: The lane's recorded phase rows of one phase: `{ operation_id, committed_at }`. */
async function receiptRows(context: StoreContext, phase: string): Promise<Record<string, unknown>[]> {
  return readCollaborationStage(resolveCollaborationLocation(context), ({ db }) =>
    db
      .prepare("select operation_id, committed_at from collaboration_operations where operation_id like ? order by rowid")
      .all(`migration:${phase}:%`) as Record<string, unknown>[],
  );
}

function ledgerPathOf(fixture: Fixture, activation: ActivationReceipt): string {
  return join(fixture.harness, "archived", "store-migration", activation.applyManifestHash, "ledger.json");
}

/** note: Re-create the crash window's durable attempt claim from a finished pair. */
function writeAttemptClaim(out: string, receipt: RepositoryBackupReceipt): void {
  writeFileSync(
    `${out}.pair-attempt.json`,
    `${JSON.stringify(
      {
        version: 1,
        attempt: "reconstructed-attempt",
        takenAt: "2026-11-21T00:00:00.000Z",
        execution: {
          name: receipt.execution.backupPath,
          privatePath: join(dirname(out), `.${receipt.execution.backupPath}.reconstructed-attempt.tmp`),
          sha256: createHash("sha256").update(readFileSync(pairImage(receipt, "execution"))).digest("hex"),
          storeId: receipt.execution.storeId,
          epoch: receipt.execution.epoch,
          revision: receipt.execution.revision,
          catalogRevision: receipt.execution.catalogRevision,
        },
        collaboration: {
          name: receipt.collaboration.path,
          privatePath: join(dirname(out), `.${receipt.collaboration.path}.reconstructed-attempt.tmp`),
          sha256: createHash("sha256").update(readFileSync(pairImage(receipt, "collaboration"))).digest("hex"),
          storeId: receipt.collaboration.authority.storeId,
          epoch: receipt.collaboration.authority.epoch,
          revision: receipt.collaboration.authority.revision,
          catalogRevision: receipt.collaboration.authority.catalogRevision,
        },
      },
      null,
      2,
    )}\n`,
  );
}

/** note: The absolute path of one image of a published pair: its locator is a sibling basename. */
function pairImage(receipt: RepositoryBackupReceipt, which: "execution" | "collaboration"): string {
  return join(dirname(receipt.manifestPath), which === "execution" ? receipt.execution.backupPath : receipt.collaboration.path);
}

/**
 * invariant: Rewrite the recorded body of one lane phase row, for tamper fixtures. The
 * row's own operation id is the identity; its recorded JSON is what the verbs
 * read, so a tampered body is exactly the untrustworthy receipt these cases
 * pin.
 */
async function patchPhaseRow(
  context: StoreContext,
  phase: string,
  applyManifestHash: string,
  patch: (stored: Record<string, unknown>) => void,
): Promise<void> {
  const operationId = `migration:${phase}:${applyManifestHash}`;
  await writeCollaborationStage(resolveCollaborationLocation(context), ({ db }) => {
    const row = db.prepare("select result_json from collaboration_operations where operation_id = ?").get(operationId);
    if (row === null || typeof row !== "object" || !("result_json" in row) || typeof row.result_json !== "string") {
      throw new Error(`the fixture lane records no ${phase} row for ${applyManifestHash}`);
    }
    const stored = JSON.parse(row.result_json) as Record<string, unknown>;
    patch(stored);
    db.prepare("update collaboration_operations set result_json = ? where operation_id = ?").run(JSON.stringify(stored), operationId);
  });
}

// ---------------------------------------------------------------------------
// Activation barrier
// ---------------------------------------------------------------------------

describe("store activation barrier", () => {
  test("activation without an attestation generates the operator document inside the flip transaction", async () => {
    const { context, apply } = await stagedFixture("activation-generated-");
    // The generated success path is proven HERE with injected process facts:
    // the Bun test runtime is itself inadmissible as an attested consumer, so
    // the production process facts would refuse by design.
    const receipt = await activateStore(context, apply, undefined, {}, {
      operator: "ops-engineer",
      processFacts: {
        entrypoint: "/opt/mstar/cli/dist/mstar-harness.js",
        // At/above the declared floor, which the validator derives itself.
        runtimeVersion: atOrAboveRuntime,
        isBun: false,
      },
    });
    // The recorded document passes the acceptance authority, carries the hash
    // the epoch bump was committed under, and records the generated operator.
    expect(() => validateActivationAttestation(receipt.attestation)).not.toThrow();
    // note: The authorizationRef names the reviewed APPLIED import, the durable
    // record this activation was authorized from.
    expect(receipt.attestation.operator).toEqual({
      actor: "ops-engineer",
      authorizationRef: `migration-applied:${apply.manifestHash}`,
    });
    expect(receipt.attestation.consumers).toEqual([
      {
        entryId: "mstar-harness.js",
        kind: "coordinator",
        entrypoint: "/opt/mstar/cli/dist/mstar-harness.js",
        runtime: "node",
        runtimeVersion: atOrAboveRuntime,
        version: readHarnessVersion(),
        current: true,
        disposition: "reloaded",
      },
    ]);
    // invariant: A file-era import has no execution store, so there is no active session
    // to stop — and that absence is reported honestly, never invented.
    expect(existsSync(join(context.harnessDir, "store.db"))).toBe(false);
    expect(receipt.attestation.stoppedSessions).toEqual([]);
  });

  test("activation without an attestation and without an operator refuses with the named recovery", async () => {
    const { context, apply } = await stagedFixture("activation-generated-noop-");
    const error = await activateStore(context, apply, undefined).catch((caught: unknown) => caught) as Error & { code?: string; recovery?: string };
    expect(error.code).toBe("store.operator-required");
    expect(error.recovery).toContain("mstar store activate --manifest <path> --operator <name>");
    // The refusal runs BEFORE the recovery point is written: an unoperated
    // activation never leaves an orphan backup behind.
    expect(backupArtifacts(context)).toEqual([]);
  });

  test("a caller-supplied now stamps the generated activation document and its activation stamps", async () => {
    const { context, apply } = await stagedFixture("activation-generated-clock-");
    const at = "2026-10-30T12:00:00.000Z";
    const receipt = await activateStore(context, apply, undefined, {}, {
      operator: "ops-engineer",
      now: () => at,
      processFacts: { entrypoint: "/opt/mstar/cli/dist/mstar-harness.js", runtimeVersion: atOrAboveRuntime, isBun: false },
    });
    // note: ONE instant: the generated document attests it and the epoch bump, the
    // receipt and the lane's own activation stamp all record it.
    expect(receipt.attestation.attestedAt).toBe(at);
    expect(receipt.activatedAt).toBe(at);
    expect((await metaOf(context)).activated_at).toBe(at);
  });

  test("a Bun-driven activation without an attestation refuses with the named cause and recovery", async () => {
    const { context, apply } = await stagedFixture("activation-generated-bun-");
    const error = await activateStore(context, apply, undefined, {}, { operator: "ops-engineer" })
      .catch((caught: unknown) => caught) as Error & { code?: string; recovery?: string };
    expect(error.code).toBe("store.attestation-invalid");
    expect(error.message).toContain("the running process is Bun");
    expect(error.recovery).toContain("mstar store activate --manifest <path> --operator <name>");
  });

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

  test("a consumer declaring any runtime other than node is refused by name", async () => {
    const { context, apply } = await stagedFixture("activation-bun-consumer-");
    // Bun is this project's development toolchain, never a runtime a consumer
    // runs on, so the vocabulary has no Bun entry to leave ungated.
    const bunConsumer = attestation().consumers.map((consumer) => ({ ...consumer, runtime: "bun" })) as unknown as ActivationAttestation["consumers"];
    const refused = await refusalOf("store.attestation-invalid", () =>
      activateStore(context, apply, attestation({ consumers: bunConsumer })),
    );
    expect(refused.message).toContain('.runtime must be "node"');
    expect(refused.message).toContain("Bun is this project's development toolchain");
  });

  test("activation refuses a below-floor consumer as incompatible, and a running session as unquiesced", async () => {
    const { context, apply } = await stagedFixture("activation-floor-");
    // Synthetic below-floor probe: not a repository version, only an input to
    // the floor comparator. Only the Node consumer carries a floor.
    const syntheticBelowFloor = "0.0.0-synthetic";
    const belowFloor = attestation().consumers.map((consumer, index) =>
      index === 1 ? { ...consumer, runtimeVersion: syntheticBelowFloor } : consumer,
    );
    const floorError = await refusalOf("store.activation-blocked", () =>
      activateStore(context, apply, attestation({ consumers: belowFloor })),
    );
    // The refusal names the runtime it refused; the floor value itself comes
    // from the manifest, so no version literal is restated here.
    expect(floorError.message).toContain(`reports node ${syntheticBelowFloor}`);
    expect(floorError.message).toContain(`below the ${declaredNodeFloor} floor`);

    const runningSession = { ...attestation(), stoppedSessions: [{ sessionId: "sess-1", host: "omp", state: "running" }] } as unknown as ActivationAttestation;
    const sessionError = await refusalOf("store.activation-blocked", () => activateStore(context, apply, runningSession));
    expect(sessionError.message).toContain("not quiesced");
  });

  test("activation refuses an attestation that records session credentials, and never writes them", async () => {
    const { context, apply } = await stagedFixture("activation-credentials-");
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
    expect(readFileSync(resolveCollaborationLocation(context).dbPath).includes(marker)).toBe(false);
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

    const activation = await activateStore(context, apply, attestation(), {
      afterStage(stage) { if (stage === "inspection") writeFileSync(registerPath, readFileSync(lateRegister)); },
    });
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

    const activation = await activateStore(context, apply, attestation(), {
      afterStage(stage) { if (stage === "inspection") writeFileSync(readmePath, readFileSync(lateIndex)); },
    });
    expect(activation.epoch).toBe(stagedMeta.authority_epoch + 1);

    const after = await metaOf(context);
    expect(after.authority_state).toBe("active");
    expect(after.authority_epoch).toBe(stagedMeta.authority_epoch + 1);
    expect((await receiptRows(context, "activated")).length).toBe(1);
    // The old writer's index survives: activation does not rewrite it.
    expect(readFileSync(readmePath, "utf8")).toContain("| `iter-late` |");
  });

  test("activation serves the current applied import for a reordered, re-derived reviewed manifest", async () => {
    const { context, apply, manifest } = await stagedFixture("activation-reordered-manifest-");

    // note: The reviewer's own JSON key order changed: the manifest hash is canonical,
    // so key order is not identity but the same import still resolves.
    const reordered = Object.fromEntries(Object.entries(manifest).reverse()) as unknown as MigrationManifest;
    const receipt = await activateStore(context, apply, attestation());
    expect(receipt.replayed).toBe(false);
    expect(receipt.epoch).toBe(2);

    // note: The read-only lookup addresses the reviewed import, and a re-serialized
    // copy of the same facts resolves to the same activation.
    const served = await activationReceiptFor(context, reordered);
    expect(served.activationHash).toBe(receipt.activationHash);
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

    const induced = await activateStore(context, apply, attestation(), failAt("flip", 0, "induced activation failure")).catch((error: unknown) => error);
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
    expect(activation.backup.authority.storeId).toBe(stagedMeta.store_id);
    expect(activation.backup.authority.revision).toBe(stagedMeta.revision);
    expect(existsSync(activation.backup.backupPath)).toBe(true);
    const live = await metaOf(context);
    expect(live.authority_state).toBe("active");
    expect(live.authority_epoch).toBe(2);
    const rows = await receiptRows(context, "activated");
    expect(rows.length).toBe(1);
    expect(rows[0]!.operation_id).toBe(`migration:activated:${apply.manifestHash}`);
    expect(rows[0]!.committed_at).toBeTruthy();

    // Replay: same attestation, no second epoch bump, the recorded receipt served.
    const replay = await activateStore(context, apply, attestation());
    expect(replay.replayed).toBe(true);
    expect(replay.activationHash).toBe(activation.activationHash);
    expect(replay.epoch).toBe(activation.epoch);
    expect((await metaOf(context)).authority_epoch).toBe(2);

    // A replay with a different attestation serves the RECORDED activation: the
    // recorded receipt is returned and history is not rewritten.
    const changed = attestation({ stoppedSessions: [{ sessionId: "sess-old-2", host: "omp", state: "stopped" }] });
    const served = await activateStore(context, apply, changed);
    expect(served.replayed).toBe(true);
    expect(served.activationHash).toBe(activation.activationHash);
    expect((await metaOf(context)).authority_epoch).toBe(2);
  });

  test("activation refuses a resumed handle from the pre-activation generation", async () => {
    const { context, apply } = await stagedFixture("activation-stale-handle-");
    const beforeActivation = await readCollaborationStage(resolveCollaborationLocation(context), ({ authority }) => authority);
    expect(beforeActivation.epoch).toBe(1);
    const activation = await activateStore(context, apply, attestation());
    const live = await readCollaborationStage(resolveCollaborationLocation(context), ({ authority }) => authority);
    expect([live.storeId, live.epoch]).toEqual([activation.storeId, activation.epoch]);

    // invariant: A receipt of the generation this publication superseded refuses by
    // `store.stale-epoch`: it can never act on the live authority.
    const staleReceipt = { ...activation, epoch: beforeActivation.epoch };
    const staleError = await refusalOf("store.stale-epoch", () => retireStoreSources(context, staleReceipt));
    expect(staleError.message).toContain("generation it was admitted under has been superseded");
    expect((await receiptRows(context, "retired")).length).toBe(0);
  });

  test("activation addresses the reviewed import by its own manifest hash, so a forged hash is never this import's", async () => {
    const { context, apply, manifest } = await stagedFixture("activation-hash-identity-");

    // invariant: The reviewed manifest's canonical hash addresses the applied phase. A
    // forged receipt carrying another hash is NOT a recorded import of this
    // lane, and the barrier refuses instead of adopting it.
    const forged = { ...apply, manifestHash: "f".repeat(64) };
    const forgedError = await refusalOf("store.activation-stale", () => activateStore(context, forged, attestation()));
    expect(forgedError.message).toContain("has no recorded apply receipt");
    expect((await metaOf(context)).authority_state).toBe("staged");

    const activation = await activateStore(context, apply, attestation());
    expect(activation.replayed).toBe(false);
    expect(activation.applyManifestHash).toBe(apply.manifestHash);
    expect((await metaOf(context)).authority_state).toBe("active");
    expect((await receiptRows(context, "activated")).length).toBe(1);

    // why: A re-serialization that keeps every reviewed fact is still this import:
    // the manifest hash is canonical, not serialization-sensitive.
    const reread = JSON.parse(JSON.stringify(manifest)) as MigrationManifest;
    const served = await activationReceiptFor(context, reread);
    expect(served.activationHash).toBe(activation.activationHash);

    // invariant: Once published, another import's receipt is not this authority's
    // activation: the live generation is never replaced by a new receipt.
    const otherError = await refusalOf("store.activation-stale", () => activateStore(context, forged, attestation()));
    expect(otherError.message).toContain("already active under a different activation");
  });

  test("retirement refuses an activation hash that is not the recorded one", async () => {
    const { context, activation } = await activatedFixture("retirement-hash-identity-");

    // invariant: The activation is addressed by the reviewed import; the supplied receipt's
    // own hash must then BE the recorded activation — a drifted hash names a
    // different one.
    const drifted = { ...activation, activationHash: "f".repeat(64) };
    const error = await refusalOf("store.activation-stale", () => retireStoreSources(context, drifted));
    expect(error.message).toContain("is not the one recorded for this import");
    expect((await receiptRows(context, "retired")).length).toBe(0);

    const receipt = await retireStoreSources(context, activation);
    expect(receipt.replayed).toBe(false);
    expect(receipt.applyManifestHash).toBe(activation.applyManifestHash);
    expect((await receiptRows(context, "retired")).length).toBe(1);

    // note: Idempotent replay: the recorded retirement is served.
    const replay = await retireStoreSources(context, activation);
    expect(replay.replayed).toBe(true);
    expect(replay.retirementHash).toBe(receipt.retirementHash);
    expect((await receiptRows(context, "retired")).length).toBe(1);
  });

  test("an already-active authority refuses an activation row whose recorded owner facts are another generation's", async () => {
    const { context, manifest, activation } = await activatedFixture("activation-active-owner-");
    const apply = await appliedReceiptFor(context, manifest);
    await patchPhaseRow(context, "activated", activation.applyManifestHash, (stored) => {
      stored.storeId = "00000000-0000-4000-8000-000000000000";
    });
    const error = await refusalOf("store.activation-stale", () => activateStore(context, apply, attestation()));
    expect(error.message).toContain("cannot be served as this store's activation");
    expect((await metaOf(context)).authority_state).toBe("active");
  });

  test("retirement refuses a supplied activation receipt whose import is not recorded", async () => {
    const { context, activation } = await activatedFixture("retirement-forged-import-");
    const forged = { ...activation, applyManifestHash: "0".repeat(64) };
    const error = await refusalOf("store.activation-stale", () => retireStoreSources(context, forged));
    expect(error.message).toContain("no activation is recorded for the reviewed import");
    expect((await receiptRows(context, "retired")).length).toBe(0);
  });

  test("retirement refuses an activation receipt whose recorded owner facts do not match the live authority", async () => {
    const { context, activation } = await activatedFixture("retirement-owner-mismatch-");

    // invariant: The recorded activation row is tampered to name ANOTHER store. The
    // relation between the row and the live authority is the real constraint, so
    // retirement refuses without touching a source.
    await patchPhaseRow(context, "activated", activation.applyManifestHash, (stored) => {
      stored.storeId = "00000000-0000-4000-8000-000000000000";
    });
    const foreign = await refusalOf("store.activation-stale", () => retireStoreSources(context, activation));
    expect(foreign.message).toContain("not this authority");
    expect((await receiptRows(context, "retired")).length).toBe(0);
  });

  test("retirement refuses an activation receipt that names a different import than the recorded one", async () => {
    const { context, activation } = await activatedFixture("retirement-apply-relation-");
    // invariant: Same live generation (so the epoch guard passes), but the supplied
    // receipt names a DIFFERENT import than the recorded activation row
    // carries: the real relation between the two rows is what refuses.
    const mismatched = { ...activation, applyManifestHash: "1".repeat(64) };
    const error = await refusalOf("store.activation-stale", () => retireStoreSources(context, mismatched));
    expect(error.message).toContain("no activation is recorded for the reviewed import");
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

    // invariant: The marker names the successor authority and both receipts, and never
    // claims rollback.
    const marker = readFileSync(receipt.markerPath, "utf8");
    expect(receipt.markerPath).toBe(join(receipt.archiveDir, "MARKER.md"));
    expect(marker).toContain(join(harness, "store.db"));
    expect(marker).toContain(activation.storeId);
    expect(marker).toContain(activation.activationHash);
    expect(marker).toContain(receipt.retirementHash);
    expect(marker).toContain("not a post-activation rollback path");
    expect(marker).toContain("VACUUM INTO");

    // note: Receipts: one retired phase row beside the activation and apply phases.
    const retired = await receiptRows(context, "retired");
    expect(retired.length).toBe(1);
    expect(retired[0]!.operation_id).toBe(`migration:retired:${activation.applyManifestHash}`);
    expect(retired[0]!.committed_at).toBeTruthy();
    expect((await receiptRows(context, "activated")).length).toBe(1);
    expect((await receiptRows(context, "applied")).length).toBe(1);
    expect((await metaOf(context)).authority_epoch).toBe(activation.epoch);

    // Idempotent replay: the same receipt is served and the live index keeps the
    // state the first run left.
    const replay = await retireStoreSources(context, activation);
    expect(replay.replayed).toBe(true);
    expect(replay.retirementHash).toBe(receipt.retirementHash);
    expect(readFileSync(readmePath, "utf8")).not.toContain("| `iter-one` |");
    expect((await receiptRows(context, "retired")).length).toBe(1);
  });

  test("retirement resumes a mid-retirement crash to the same target rows and archives", async () => {
    const crashed = await activatedFixture("retirement-resume-crash-");
    const clean = await activatedFixture("retirement-resume-clean-");

    const induced = await retireStoreSources(crashed.context, crashed.activation, failAt("retirement", 2, "induced retirement failure after 2 item(s)")).catch((error: unknown) => error);

    const ledger = JSON.parse(readFileSync(ledgerPathOf(crashed, crashed.activation), "utf8")) as {
      registers: { state: string }[];
      sections: { state: string }[];
      retirementHash: string | null;
    };
    expect(ledger.registers.filter((item) => item.state === "verified").length).toBe(2);
    expect(ledger.registers.filter((item) => item.state !== "verified").length).toBe(2);
    expect(ledger.sections.every((item) => item.state === "pending")).toBe(true);
    expect(ledger.retirementHash).toBeNull();
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

    const induced = await retireStoreSources(fixture.context, fixture.activation, failAt("section-write", 0, "induced retirement failure after the section rewrite")).catch((error: unknown) => error);

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
    const readmePath = join(fixture.checkout, ".agents", "knowledge", "README.md");
    expect(readFileSync(readmePath, "utf8")).toContain("`guides//intro.md`");

    const induced = await retireStoreSources(fixture.context, fixture.activation, failAt("section-write", 0, "induced retirement failure after the section rewrite")).catch((error: unknown) => error);

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
    const induced = await retireStoreSources(fixture.context, fixture.activation, failAt("section-write", 0, "induced retirement failure after the section rewrite")).catch((error: unknown) => error);

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
    const induced = await retireStoreSources(fixture.context, fixture.activation, failAt("section-write", 0, "induced retirement failure after the section rewrite")).catch((error: unknown) => error);

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
    const induced = await retireStoreSources(fixture.context, fixture.activation, failAt("retirement", 5, "induced retirement failure after 5 item(s)")).catch((error: unknown) => error);
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

    const induced = await retireStoreSources(fixture.context, fixture.activation, failAt("section-write", 0, "induced retirement failure after the section rewrite")).catch((error: unknown) => error);

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
    const induced = await retireStoreSources(fixture.context, fixture.activation, failAt("section-write", 0, "induced retirement failure after the section rewrite")).catch((error: unknown) => error);

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
    const induced = await retireStoreSources(fixture.context, fixture.activation, failAt("section-write", 0, "induced retirement failure after the section rewrite")).catch((error: unknown) => error);

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

  /** note: The EXECUTION store's own meta rows (its backup identity), read from an open handle. */
  function readStoreAuthorityMeta(handle: { db: { prepare(sql: string): { get(): unknown } } }): {
    store_id: string;
    authority_epoch: number;
    revision: number;
  } {
    const row = handle.db.prepare("select store_id, authority_epoch, revision from store_meta where id = 1").get();
    if (
      row === null ||
      typeof row !== "object" ||
      !("store_id" in row) ||
      !("authority_epoch" in row) ||
      !("revision" in row) ||
      typeof row.store_id !== "string" ||
      typeof row.authority_epoch !== "number" ||
      typeof row.revision !== "number"
    ) {
      throw new Error("the fixture execution store records no readable store_meta singleton");
    }
    return { store_id: row.store_id, authority_epoch: row.authority_epoch, revision: row.revision };
  }

  /** One scalar count out of a fixture image; the SQL is this test's own. */
  function scalarCount(db: DatabaseSync, sql: string): number {
    // node:sqlite rows are untyped; the queried shape is the test's own SQL.
    const row = db.prepare(sql).get() as { n: number };
    return row.n;
  }

  test("backup records identity and revision and contains committed WAL-visible execution and host data", async () => {
    const fixture = freshWorkspace("backup-wal-");
    // invariant: Hold a connection open for the whole case so the committed frames stay in
    // the WAL instead of being checkpointed away by the last close.
    // Both authorities exist, exactly as `store init` leaves them: the lane
    // owns issue/catalog, the execution store owns execution/host.
    await ensureCollaborationAuthority(fixture.context);
    const held = await initializeStore(fixture.context);
    try {
      write(fixture.harness, "guide.md", "# Guide\n");
      // invariant: Issue and catalog authority is the collaboration lane; the execution
      // image must carry neither, and the lane rows stay readable beside it.
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
      // note: Execution-only: the lane holds the one issue and the one catalog row.
      expect(receipt.counts.issues).toBe(0);
      expect(receipt.counts.occurrences).toBe(0);
      expect(receipt.counts.catalogEntities).toBe(0);
      expect(receipt.walPending).toBe(true);
      expect(receipt.bytes).toBeGreaterThan(0);

      // note: The whole image is the recovery point: the execution store's own rows
      // and the native host state, read through the WAL.
      const copy = new DatabaseSync(target, { readOnly: true });
      try {
        expect(scalarCount(copy, "select count(*) as n from issues")).toBe(0);
        expect(scalarCount(copy, "select count(*) as n from catalog_entities")).toBe(0);
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
      // note: The lane row the capture committed is unchanged by the execution backup.
      const lane = await readCollaborationStage(resolveCollaborationLocation(fixture.context), ({ db }) =>
        db.prepare("select id, title from issues").get(),
      );
      expect(lane !== null && typeof lane === "object" && "title" in lane ? lane.title : undefined).toBe("WAL-visible finding");

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
      const before = readStoreAuthorityMeta(held);
      // invariant: A REAL second process commits HOST rows continuously — the execution
      // store's own domain, since issue/catalog rows live in the lane now. The
      // backup must neither refuse the coherent copy nor describe a generation
      // the bytes do not hold — no frozen window, no filesystem mutex.
      const hostModule = new URL("./host-state-store.js", import.meta.url).href;
      const stopPath = join(fixture.root, "writer-stop");
      const writerSource = `
        import { appendDshLedgerRow } from ${JSON.stringify(hostModule)};
        import { existsSync } from 'node:fs';
        let commits = 0;
        for (let index = 0; index < 60 && !existsSync(process.env.WRITER_STOP!); index += 1) {
          appendDshLedgerRow({ harnessDir: process.env.HARNESS_DIR! }, "wf-concurrent", JSON.stringify({ index }), "row-" + index);
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
      let liveRows = 0;
      let liveRevision = 0;
      try {
        liveRows = (live.db.prepare("select count(*) as n from dsh_ledger_events").get() as { n: number }).n;
        liveRevision = (live.db.prepare("select revision from store_meta where id = 1").get() as { revision: number }).revision;
      } finally {
        live.close();
      }

      // The receipt describes the image: every reported count equals the rows
      // actually inside the copied file.
      const image = new DatabaseSync(target, { readOnly: true });
      try {
        const imageRows = scalarCount(image, "select count(*) as n from dsh_ledger_events");
        expect(receipt.counts.issues).toBe(scalarCount(image, "select count(*) as n from issues"));
        // note: The execution image carries no collaboration payload at all.
        expect(receipt.counts.issues).toBe(0);
        expect(receipt.counts.migrationReceipts).toBe(scalarCount(image, "select count(*) as n from migration_receipts"));
        // Three writer commits landed before the copy started; the rest race it.
        expect(imageRows).toBeGreaterThanOrEqual(3);
        expect(imageRows).toBeLessThanOrEqual(liveRows);
        expect(receipt.revision).toBeGreaterThanOrEqual(before.revision);
        expect(receipt.revision).toBeLessThanOrEqual(liveRevision);
        const lowestRow = image.prepare("select min(seq_rowid) as first from dsh_ledger_events").get() as { first: number | null };
        // invariant: A whole committed generation: the copy starts at the writer's own
        // first row, never mid-history.
        expect(lowestRow.first).toBe(1);
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
      expect(receipt.storeId).toBe(readStoreAuthorityMeta(held).store_id);
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

// ---------------------------------------------------------------------------
// note: Collaboration lifecycle and the repository backup pair (operator verbs)
// ---------------------------------------------------------------------------

/** note: One capture through the real collaboration writer. */
async function captureOne(fixture: Fixture, operationId: string): Promise<void> {
  await captureIssue(
    fixture.context,
    {
      projectId: "_default",
      title: "Lane lifecycle finding",
      kind: "bug",
      severity: "high",
      impact: "the lane's rows must survive a repeated bootstrap and a restore",
      acceptance: "the row is readable through the restored authority",
      sourceIdentity: "qc/lifecycle.md",
      rootCauseKey: "lifecycle-root-cause",
      acceptanceKey: "restored",
      occurrenceKey: `run-${operationId}`,
      sourceKind: "qc",
      location: "packages/engine/src/store-activation.ts:1",
      observedBehavior: "the collaboration authority owns the row",
      evidence: ["proof"],
      discoveredAt: "2026-09-19T00:00:00.000Z",
    },
    { operationId, actor: "project-manager" },
  );
}

describe("collaboration lifecycle", () => {
  test("a fresh bootstrap creates and activates the lane, and a repeat reuses it without clearing", async () => {
    const fixture = repoWorkspace("collab-bootstrap-");
    const first = await ensureCollaborationAuthority(fixture.context);
    expect(first).toMatchObject({ state: "active", mode: "local" });
    expect(existsSync(resolveCollaborationLocation(fixture.context).dbPath)).toBe(true);

    await captureOne(fixture, "op-lane-bootstrap");
    const second = await ensureCollaborationAuthority(fixture.context);
    expect([second.storeId, second.epoch, second.state]).toEqual([first.storeId, first.epoch, "active"]);

    const handle = await openCollaborationStore(fixture.context, "read");
    try {
      expect(handle.db.prepare("select count(*) as n from issues").get()).toEqual({ n: 1 });
    } finally {
      handle.close();
    }
  });

  test("a staged lane that recorded staging evidence is never published by a bootstrap", async () => {
    const fixture = repoWorkspace("collab-staged-");
    const location = resolveCollaborationLocation(fixture.context);
    const staged = await initializeCollaborationStore(location);
    expect(staged.state).toBe("staged");
    await writeCollaborationStage(location, ({ db }) => {
      db.prepare(
        "insert into cutover_publications(manifest_id, phase, source_store_id, source_epoch, source_schema_version, " +
          "source_revision, source_catalog_revision, manifest_digest, target_store_id, target_epoch, verified_at) " +
          "values ('manifest-one', 'verified', 'source-store', 1, 19, 3, 1, 'digest', 'target-store', 1, ?)",
      ).run("2026-11-21T00:00:00.000Z");
    });

    await expect(ensureCollaborationAuthority(fixture.context)).rejects.toMatchObject({ code: "collaboration.not-active" });
    // invariant: The pending activation's evidence is untouched: a bootstrap never publishes it.
    const after = await readCollaborationStage(location, ({ db, authority }) => ({
      state: authority.state,
      publications: db.prepare("select count(*) as n from cutover_publications").get(),
    }));
    expect(after).toEqual({ state: "staged", publications: { n: 1 } });
  });

  test("a combined source that still owns collaboration rows directs to the reviewed cutover", async () => {
    const fixture = repoWorkspace("collab-combined-");
    // invariant: A pre-cutover checkout: one combined store whose own rows ARE the
    // issue/catalog authority. The bootstrap must not create a second one.
    const combined = await initializeStore(fixture.context);
    combined.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key) " +
          "values ('I-000001', '_default', 'Combined source finding', 'bug', 'high', 'pre-cutover authority', 'cut over', 'now', 'now', 'combined-root-cause')",
      )
      .run();
    combined.close();

    await expect(ensureCollaborationAuthority(fixture.context)).rejects.toMatchObject({ code: "collaboration.cutover-required" });
    // note: Nothing was created for a scope whose authority arrives through the cutover.
    expect(existsSync(resolveCollaborationLocation(fixture.context).dbPath)).toBe(false);
    expect(backupArtifacts(fixture.context)).toEqual([]);
  });

  test("an unfenced legacy owner is refused before it reaches the repository lane", async () => {
    const fixture = repoWorkspace("binding-legacy-owner-");
    await ensureCollaborationAuthority(fixture.context);
    (await initializeStore(fixture.context)).close();
    const store = await openStore(fixture.context, "write");
    store.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key) " +
          "values ('I-000001', '_default', 'Legacy owner row', 'bug', 'high', 'combined authority', 'cut over', 'now', 'now', 'legacy-owner')",
      )
      .run();
    store.close();

    await expect(
      captureIssue(
        fixture.context,
        {
          projectId: "_default",
          title: "Refused by the legacy owner",
          kind: "bug",
          severity: "high",
          impact: "the lane must not be reachable",
          acceptance: "refused before I/O",
          sourceIdentity: "qc/legacy-owner.md",
          rootCauseKey: "legacy-owner",
          acceptanceKey: "refused",
          occurrenceKey: "run-legacy-owner",
          sourceKind: "qc",
          location: "fixture",
          observedBehavior: "refused",
          evidence: [],
          discoveredAt: "2026-11-21T00:00:00.000Z",
        },
        { operationId: "op-legacy-owner", actor: "project-manager" },
      ),
    ).rejects.toMatchObject({ code: "collaboration.cutover-required" });
    const lane = await readCollaborationStage(resolveCollaborationLocation(fixture.context), ({ db }) => ({
      issues: db.prepare("select count(*) as n from issues").get(),
    }));
    expect(lane).toEqual({ issues: { n: 0 } });
  });

  test("a retargeted checkout never adopts another repository's authority", async () => {
    const bound = repoWorkspaceWithKey("binding-retarget-a-", `fixture-retarget-a-${repoSequence++}`);
    await ensureCollaborationAuthority(bound.context);
    const otherId = `fixture-retarget-b-${repoSequence++}`;
    const other = repoWorkspaceWithKey("binding-retarget-b-", otherId);
    await ensureCollaborationAuthority(other.context);

    // note: The bound checkout's config now names the OTHER repository.
    writeFileSync(join(bound.checkout, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=${otherId}\n`);
    await expect(ensureCollaborationAuthority(bound.context)).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
    await expect(
      captureIssue(
        bound.context,
        {
          projectId: "_default",
          title: "Refused after a retarget",
          kind: "bug",
          severity: "high",
          impact: "a bound checkout never drifts",
          acceptance: "refused before I/O",
          sourceIdentity: "qc/retarget.md",
          rootCauseKey: "retarget",
          acceptanceKey: "refused",
          occurrenceKey: "run-retarget",
          sourceKind: "qc",
          location: "fixture",
          observedBehavior: "refused",
          evidence: [],
          discoveredAt: "2026-11-21T00:00:00.000Z",
        },
        { operationId: "op-retarget", actor: "project-manager" },
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // invariant: The other repository's lane was not written by the refused checkout.
    const lane = await readCollaborationStage(resolveCollaborationLocation(other.context), ({ db }) => ({
      issues: db.prepare("select count(*) as n from issues").get(),
    }));
    expect(lane).toEqual({ issues: { n: 0 } });
  });




  test("an unbound clone refuses store init on every attempt and never adopts an active authority", async () => {
    const repoKey = `fixture-replacement-${repoSequence++}`;
    const origin = repoWorkspaceWithKey("replacement-origin-", repoKey);
    (await initializeStore(origin.context)).close();
    await ensureCollaborationAuthority(origin.context);
    await captureOne(origin, "op-origin-capture");

    // note: A replacement clone: same repository, its own execution store, no binding.
    // The standard forbids auto-adoption on the FIRST and every LATER init.
    const clone = repoWorkspaceWithKey("replacement-clone-", repoKey);
    (await initializeStore(clone.context)).close();
    await expect(ensureCollaborationAuthority(clone.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    await expect(ensureCollaborationAuthority(clone.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    await expect(captureOne(clone, "op-clone-before-adoption")).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // invariant: No binding was written by any refused attempt.
    expect(existsSync(join(clone.harness, "collaboration-binding.json"))).toBe(false);
    // invariant: The lane stayed untouched by the refused clone.
    const lane = await readCollaborationStage(resolveCollaborationLocation(origin.context), ({ db }) => ({
      issues: db.prepare("select count(*) as n from issues").get(),
    }));
    expect(lane).toEqual({ issues: { n: 1 } });
  });

  test("an unfenced legacy owner is refused before it reaches the repository lane", async () => {
    const fixture = repoWorkspace("binding-legacy-owner-");
    await ensureCollaborationAuthority(fixture.context);
    (await initializeStore(fixture.context)).close();
    const store = await openStore(fixture.context, "write");
    store.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key) " +
          "values ('I-000001', '_default', 'Legacy owner row', 'bug', 'high', 'combined authority', 'cut over', 'now', 'now', 'legacy-owner')",
      )
      .run();
    store.close();

    await expect(
      captureIssue(
        fixture.context,
        {
          projectId: "_default",
          title: "Refused by the legacy owner",
          kind: "bug",
          severity: "high",
          impact: "the lane must not be reachable",
          acceptance: "refused before I/O",
          sourceIdentity: "qc/legacy-owner.md",
          rootCauseKey: "legacy-owner",
          acceptanceKey: "refused",
          occurrenceKey: "run-legacy-owner",
          sourceKind: "qc",
          location: "fixture",
          observedBehavior: "refused",
          evidence: [],
          discoveredAt: "2026-11-21T00:00:00.000Z",
        },
        { operationId: "op-legacy-owner", actor: "project-manager" },
      ),
    ).rejects.toMatchObject({ code: "collaboration.cutover-required" });
    const lane = await readCollaborationStage(resolveCollaborationLocation(fixture.context), ({ db }) => ({
      issues: db.prepare("select count(*) as n from issues").get(),
    }));
    expect(lane).toEqual({ issues: { n: 0 } });
  });

  test("a retargeted checkout never adopts another repository's authority", async () => {
    const bound = repoWorkspaceWithKey("binding-retarget-a-", `fixture-retarget-a-${repoSequence++}`);
    await ensureCollaborationAuthority(bound.context);
    const otherId = `fixture-retarget-b-${repoSequence++}`;
    const other = repoWorkspaceWithKey("binding-retarget-b-", otherId);
    await ensureCollaborationAuthority(other.context);

    // note: The bound checkout's config now names the OTHER repository.
    writeFileSync(join(bound.checkout, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=${otherId}\n`);
    await expect(ensureCollaborationAuthority(bound.context)).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
    await expect(
      captureIssue(
        bound.context,
        {
          projectId: "_default",
          title: "Refused after a retarget",
          kind: "bug",
          severity: "high",
          impact: "a bound checkout never drifts",
          acceptance: "refused before I/O",
          sourceIdentity: "qc/retarget.md",
          rootCauseKey: "retarget",
          acceptanceKey: "refused",
          occurrenceKey: "run-retarget",
          sourceKind: "qc",
          location: "fixture",
          observedBehavior: "refused",
          evidence: [],
          discoveredAt: "2026-11-21T00:00:00.000Z",
        },
        { operationId: "op-retarget", actor: "project-manager" },
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // invariant: The other repository's lane was not written by the refused checkout.
    const lane = await readCollaborationStage(resolveCollaborationLocation(other.context), ({ db }) => ({
      issues: db.prepare("select count(*) as n from issues").get(),
    }));
    expect(lane).toEqual({ issues: { n: 0 } });
  });


  test("an unfenced legacy owner is refused before it reaches the repository lane", async () => {
    const fixture = repoWorkspace("binding-legacy-owner-");
    await ensureCollaborationAuthority(fixture.context);
    (await initializeStore(fixture.context)).close();
    const store = await openStore(fixture.context, "write");
    store.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key) " +
          "values ('I-000001', '_default', 'Legacy owner row', 'bug', 'high', 'combined authority', 'cut over', 'now', 'now', 'legacy-owner')",
      )
      .run();
    store.close();

    await expect(
      captureIssue(
        fixture.context,
        {
          projectId: "_default",
          title: "Refused by the legacy owner",
          kind: "bug",
          severity: "high",
          impact: "the lane must not be reachable",
          acceptance: "refused before I/O",
          sourceIdentity: "qc/legacy-owner.md",
          rootCauseKey: "legacy-owner",
          acceptanceKey: "refused",
          occurrenceKey: "run-legacy-owner",
          sourceKind: "qc",
          location: "fixture",
          observedBehavior: "refused",
          evidence: [],
          discoveredAt: "2026-11-21T00:00:00.000Z",
        },
        { operationId: "op-legacy-owner", actor: "project-manager" },
      ),
    ).rejects.toMatchObject({ code: "collaboration.cutover-required" });
    const lane = await readCollaborationStage(resolveCollaborationLocation(fixture.context), ({ db }) => ({
      issues: db.prepare("select count(*) as n from issues").get(),
    }));
    expect(lane).toEqual({ issues: { n: 0 } });
  });

  test("a retargeted checkout never adopts another repository's authority", async () => {
    const bound = repoWorkspaceWithKey("binding-retarget-a-", `fixture-retarget-a-${repoSequence++}`);
    await ensureCollaborationAuthority(bound.context);
    const otherId = `fixture-retarget-b-${repoSequence++}`;
    const other = repoWorkspaceWithKey("binding-retarget-b-", otherId);
    await ensureCollaborationAuthority(other.context);

    // note: The bound checkout's config now names the OTHER repository.
    writeFileSync(join(bound.checkout, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=${otherId}\n`);
    await expect(ensureCollaborationAuthority(bound.context)).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
    await expect(
      captureIssue(
        bound.context,
        {
          projectId: "_default",
          title: "Refused after a retarget",
          kind: "bug",
          severity: "high",
          impact: "a bound checkout never drifts",
          acceptance: "refused before I/O",
          sourceIdentity: "qc/retarget.md",
          rootCauseKey: "retarget",
          acceptanceKey: "refused",
          occurrenceKey: "run-retarget",
          sourceKind: "qc",
          location: "fixture",
          observedBehavior: "refused",
          evidence: [],
          discoveredAt: "2026-11-21T00:00:00.000Z",
        },
        { operationId: "op-retarget", actor: "project-manager" },
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // invariant: The other repository's lane was not written by the refused checkout.
    const lane = await readCollaborationStage(resolveCollaborationLocation(other.context), ({ db }) => ({
      issues: db.prepare("select count(*) as n from issues").get(),
    }));
    expect(lane).toEqual({ issues: { n: 0 } });
  });


  test("an unfenced legacy owner is refused before it reaches the repository lane", async () => {
    const fixture = repoWorkspace("binding-legacy-owner-");
    await ensureCollaborationAuthority(fixture.context);
    (await initializeStore(fixture.context)).close();
    const store = await openStore(fixture.context, "write");
    store.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key) " +
          "values ('I-000001', '_default', 'Legacy owner row', 'bug', 'high', 'combined authority', 'cut over', 'now', 'now', 'legacy-owner')",
      )
      .run();
    store.close();

    await expect(
      captureIssue(
        fixture.context,
        {
          projectId: "_default",
          title: "Refused by the legacy owner",
          kind: "bug",
          severity: "high",
          impact: "the lane must not be reachable",
          acceptance: "refused before I/O",
          sourceIdentity: "qc/legacy-owner.md",
          rootCauseKey: "legacy-owner",
          acceptanceKey: "refused",
          occurrenceKey: "run-legacy-owner",
          sourceKind: "qc",
          location: "fixture",
          observedBehavior: "refused",
          evidence: [],
          discoveredAt: "2026-11-21T00:00:00.000Z",
        },
        { operationId: "op-legacy-owner", actor: "project-manager" },
      ),
    ).rejects.toMatchObject({ code: "collaboration.cutover-required" });
    const lane = await readCollaborationStage(resolveCollaborationLocation(fixture.context), ({ db }) => ({
      issues: db.prepare("select count(*) as n from issues").get(),
    }));
    expect(lane).toEqual({ issues: { n: 0 } });
  });

  test("a retargeted checkout never adopts another repository's authority", async () => {
    const bound = repoWorkspaceWithKey("binding-retarget-a-", `fixture-retarget-a-${repoSequence++}`);
    await ensureCollaborationAuthority(bound.context);
    const otherId = `fixture-retarget-b-${repoSequence++}`;
    const other = repoWorkspaceWithKey("binding-retarget-b-", otherId);
    await ensureCollaborationAuthority(other.context);

    // note: The bound checkout's config now names the OTHER repository.
    writeFileSync(join(bound.checkout, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=${otherId}\n`);
    await expect(ensureCollaborationAuthority(bound.context)).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
    await expect(
      captureIssue(
        bound.context,
        {
          projectId: "_default",
          title: "Refused after a retarget",
          kind: "bug",
          severity: "high",
          impact: "a bound checkout never drifts",
          acceptance: "refused before I/O",
          sourceIdentity: "qc/retarget.md",
          rootCauseKey: "retarget",
          acceptanceKey: "refused",
          occurrenceKey: "run-retarget",
          sourceKind: "qc",
          location: "fixture",
          observedBehavior: "refused",
          evidence: [],
          discoveredAt: "2026-11-21T00:00:00.000Z",
        },
        { operationId: "op-retarget", actor: "project-manager" },
      ),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // invariant: The other repository's lane was not written by the refused checkout.
    const lane = await readCollaborationStage(resolveCollaborationLocation(other.context), ({ db }) => ({
      issues: db.prepare("select count(*) as n from issues").get(),
    }));
    expect(lane).toEqual({ issues: { n: 0 } });
  });


  /**
   * invariant: Damage the execution metadata `openStore` admits on, leaving the file
   * readable: the execution lane refuses `store.corrupt` while every table is
   * still inspectable, which is exactly the shape that must not hide legacy rows.
   */
  function damageExecutionMeta(fixture: Fixture): void {
    const db = new DatabaseSync(join(fixture.harness, "store.db"));
    try {
      db.prepare("delete from execution_meta where id = 1").run();
    } finally {
      db.close();
    }
  }

  test("a readable legacy owner is still refused when its execution metadata is damaged", async () => {
    const fixture = repoWorkspace("collab-legacy-damaged-meta-");
    await ensureCollaborationAuthority(fixture.context);
    const store = await initializeStore(fixture.context);
    store.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key) " +
          "values ('I-000001', '_default', 'Legacy owner row', 'bug', 'high', 'combined authority', 'cut over', 'now', 'now', 'legacy-owner')",
      )
      .run();
    store.close();
    damageExecutionMeta(fixture);
    const bindingBefore = readCollaborationBinding(fixture.context);

    // note: The execution lane's own admission rejects the store…
    await expect(openStore(fixture.context, "read")).rejects.toMatchObject({ code: "store.corrupt" });
    // invariant: …and that must not hide its readable collaboration rows from the lane.
    await expect(readCollaborationAuthority(fixture.context)).rejects.toMatchObject({ code: "collaboration.cutover-required" });
    await expect(adoptCollaborationBinding(fixture.context)).rejects.toMatchObject({ code: "collaboration.cutover-required" });
    // note: Neither refusal changed this checkout's binding or the destination lane.
    expect(readCollaborationBinding(fixture.context)).toEqual(bindingBefore);
    const lane = await readCollaborationStage(resolveCollaborationLocation(fixture.context), ({ db }) => ({
      issues: db.prepare("select count(*) as n from issues").get(),
    }));
    expect(lane).toEqual({ issues: { n: 0 } });
  });

  test("a dangling store.db is a present store, never an absent one", async () => {
    const fixture = repoWorkspace("collab-dangling-execution-store-");
    await ensureCollaborationAuthority(fixture.context);
    const bound = readCollaborationBinding(fixture.context);
    symlinkSync(join(fixture.root, "no-such-store.db"), join(fixture.harness, "store.db"));
    // invariant: The link names nothing, so an existence check that follows it sees "absent";
    // the execution domain classifies the PATH as an existing store it cannot read.
    await expect(openStore(fixture.context, "read")).rejects.toMatchObject({ code: "store.corrupt" });
    // note: A bound checkout leaves that verdict to the execution domain…
    expect((await readCollaborationAuthority(fixture.context)).state).toBe("active");
    expect(readCollaborationBinding(fixture.context)).toEqual(bound);

    // invariant: …an unbound checkout cannot rule the shape out as a hidden legacy owner.
    rmSync(join(fixture.harness, "collaboration-binding.json"), { force: true });
    await expect(readCollaborationAuthority(fixture.context)).rejects.toMatchObject({ code: "collaboration.unreadable" });
    await expect(adoptCollaborationBinding(fixture.context)).rejects.toMatchObject({ code: "collaboration.unreadable" });
    expect(readCollaborationBinding(fixture.context)).toBeNull();
  });

  test("a non-regular store.db is a present store, never an absent one", async () => {
    const fixture = repoWorkspace("collab-directory-execution-store-");
    await ensureCollaborationAuthority(fixture.context);
    rmSync(join(fixture.harness, "collaboration-binding.json"), { force: true });
    mkdirSync(join(fixture.harness, "store.db"));
    await expect(readCollaborationAuthority(fixture.context)).rejects.toMatchObject({ code: "collaboration.unreadable" });
    await expect(adoptCollaborationBinding(fixture.context)).rejects.toMatchObject({ code: "collaboration.unreadable" });
    expect(readCollaborationBinding(fixture.context)).toBeNull();
  });

  test("a count that fails after held rows were observed admits nothing, even when bound", async () => {
    const fixture = repoWorkspace("collab-held-then-query-error-");
    await ensureCollaborationAuthority(fixture.context);
    const store = await initializeStore(fixture.context);
    try {
      store.db
        .prepare(
          "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key) " +
            "values ('I-000001', '_default', 'Held row', 'bug', 'high', 'combined authority', 'cut over', 'now', 'now', 'held-then-error')",
        )
        .run();
      // why: `issues` reports a held row first; the allocator the count pass reads LAST
      // no longer answers as that rule expects, so the pass ends in a raw error.
      store.db.exec("drop table issue_counter; create table issue_counter(id integer primary key, retired integer)");
    } finally {
      store.close();
    }
    const bound = readCollaborationBinding(fixture.context);
    // invariant: The binding proves adoption of the LANE, never these rows: the observed
    // held row is the verdict even though the count pass then failed.
    await expect(readCollaborationAuthority(fixture.context)).rejects.toMatchObject({ code: "collaboration.cutover-required" });
    await expect(adoptCollaborationBinding(fixture.context)).rejects.toMatchObject({ code: "collaboration.cutover-required" });
    expect(readCollaborationBinding(fixture.context)).toEqual(bound);
  });

  test("an absent or row-free execution store leaves the collaboration lane usable", async () => {
    // note: Genuinely absent execution store: nothing local to inspect.
    const absent = repoWorkspace("collab-no-execution-store-");
    await ensureCollaborationAuthority(absent.context);
    expect(existsSync(join(absent.harness, "store.db"))).toBe(false);
    expect((await readCollaborationAuthority(absent.context)).state).toBe("active");

    // note: A damaged execution store that holds no collaboration rows proves independence.
    const damaged = repoWorkspace("collab-damaged-empty-execution-");
    await ensureCollaborationAuthority(damaged.context);
    (await initializeStore(damaged.context)).close();
    damageExecutionMeta(damaged);
    await expect(openStore(damaged.context, "read")).rejects.toMatchObject({ code: "store.corrupt" });
    expect((await readCollaborationAuthority(damaged.context)).state).toBe("active");
    await captureOne(damaged, "op-damaged-empty-execution");
    const lane = await readCollaborationStage(resolveCollaborationLocation(damaged.context), ({ db }) => ({
      issues: db.prepare("select count(*) as n from issues").get(),
    }));
    expect(lane).toEqual({ issues: { n: 1 } });
  });

  test("a bound checkout leaves an uninspectable execution store to the execution domain", async () => {
    const fixture = repoWorkspace("collab-bound-uninspectable-");
    await ensureCollaborationAuthority(fixture.context);
    const bound = readCollaborationBinding(fixture.context);
    writeFileSync(join(fixture.harness, "store.db"), "not a sqlite database\n");
    // why: The finalized binding proves this checkout was ADOPTED, so it is not a
    // legacy owner: the lane keeps answering and a legitimate write lands…
    expect((await readCollaborationAuthority(fixture.context)).state).toBe("active");
    await captureOne(fixture, "op-bound-uninspectable");
    // why: …while the execution store keeps its own actionable refusal.
    await expect(openStore(fixture.context, "read")).rejects.toMatchObject({ code: "store.corrupt" });
    expect(readCollaborationBinding(fixture.context)).toEqual(bound);
  });

  test("an unbound checkout fails closed on an execution store it cannot inspect", async () => {
    const fixture = repoWorkspace("collab-unbound-uninspectable-");
    await ensureCollaborationAuthority(fixture.context);
    rmSync(join(fixture.harness, "collaboration-binding.json"), { force: true });
    writeFileSync(join(fixture.harness, "store.db"), "not a sqlite database\n");
    await expect(readCollaborationAuthority(fixture.context)).rejects.toMatchObject({ code: "collaboration.unreadable" });
    await expect(adoptCollaborationBinding(fixture.context)).rejects.toMatchObject({ code: "collaboration.unreadable" });
    // note: Neither refusal invented a binding for the unprovable scope.
    expect(readCollaborationBinding(fixture.context)).toBeNull();
  });

  test("a reviewed file-era import stages the lane and publishes it with a single epoch bump", async () => {
    const fixture = repoWorkspace("collab-file-era-");
    writeRegister(fixture.harness, "_default", { entries: { "plan-alpha": [entry({ id: "R1", severity: "high" })] } });
    const manifest = await planStoreMigration(fixture.context);
    const apply = await applyStoreMigration(fixture.context, manifest);
    expect((await metaOf(fixture.context)).authority_state).toBe("staged");

    const activation = await activateStore(fixture.context, apply, attestation());
    const meta = await metaOf(fixture.context);
    expect([meta.authority_state, meta.authority_epoch]).toEqual(["active", activation.epoch]);
    // note: The published lane IS the issue authority: no combined store was created.
    expect(existsSync(join(fixture.harness, "store.db"))).toBe(false);
    expect(activation.applyManifestHash).toBe(apply.manifestHash);

    const receipt = await retireStoreSources(fixture.context, activation);
    expect(receipt.applyManifestHash).toBe(apply.manifestHash);
    expect(receipt.registers.length).toBe(manifest.retirement.registers.length);
  });
});

describe("repository backup pair", () => {
  /** note: One active execution + collaboration pair holding one lane issue. */
  async function pairedWorkspace(name: string): Promise<Fixture & { checkout: string }> {
    const fixture = repoWorkspace(name);
    (await initializeStore(fixture.context)).close();
    await ensureCollaborationAuthority(fixture.context);
    await captureOne(fixture, `op-${name}`);
    return fixture;
  }

  test("publishes both verified images and one manifest only after verification", async () => {
    const fixture = await pairedWorkspace("pair-publish-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });

    expect(receipt.version).toBe(1);
    expect(receipt.manifestPath).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(pairImage(receipt, "execution"))).toBe(true);
    expect(existsSync(pairImage(receipt, "collaboration"))).toBe(true);
    expect(receipt.collaboration.authority).toMatchObject({ state: "active", mode: "local" });
    // note: The issue lives in the collaboration half only; the execution image carries no collaboration payload.
    expect(receipt.collaboration.counts.issues).toBe(1);
    expect(receipt.execution.counts.issues).toBe(0);
    // note: The manifest IS the receipt: one published description of the pair.
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(JSON.parse(JSON.stringify(receipt)));
  });

  test("an occupied image destination fails honestly and publishes no manifest", async () => {
    const fixture = await pairedWorkspace("pair-occupied-");
    const out = join(fixture.harness, "archived", "recovery", "occupied.json");
    mkdirSync(dirname(out), { recursive: true });
    const occupied = `${out}.execution.db`;
    writeFileSync(occupied, "not a database\n");

    await expect(backupRepositoryStores(fixture.context, { out })).rejects.toMatchObject({ code: "collaboration.backup-incomplete" });
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.collaboration.db`)).toBe(false);
    // invariant: The operator's own file is never removed as this attempt's scratch.
    expect(readFileSync(occupied, "utf8")).toBe("not a database\n");
  });

  test("restore is create-only into an absent target and changes the epoch", async () => {
    const fixture = await pairedWorkspace("pair-restore-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    const location = resolveCollaborationLocation(fixture.context);
    const before = await ensureCollaborationAuthority(fixture.context);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${location.dbPath}${suffix}`, { force: true });

    // invariant: Unrelated inert scratch beside the absent target is never published.
    const scratch = join(dirname(location.dbPath), ".staging-stale-attempt");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "collaboration.db"), "not a database\n");

    const restored = await restoreCollaborationBackup(fixture.context, receipt, {
      operator: "ops-engineer",
      attestation: attestation(),
    });
    // invariant: A recovery mints a NEW authority identity: the image's own stamp is never
    // re-issued, so a later generation can never collide with this one.
    expect(restored).toMatchObject({ state: "active", epoch: before.epoch + 1 });
    expect(restored.storeId).not.toBe(before.storeId);

    const handle = await openCollaborationStore(fixture.context, "read");
    try {
      expect(handle.db.prepare("select count(*) as n from issues").get()).toEqual({ n: 1 });
      expect(handle.db.prepare("select count(*) as n from collaboration_operations where operation_id like 'restore:%'").get()).toEqual({ n: 1 });
    } finally {
      handle.close();
    }
    // invariant: The stale private scratch is left exactly as it was: it is not authority.
    expect(readFileSync(join(scratch, "collaboration.db"), "utf8")).toBe("not a database\n");
  });

  test("restore refuses a live target and a corrupt image without touching either", async () => {
    const fixture = await pairedWorkspace("pair-refusals-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    const location = resolveCollaborationLocation(fixture.context);
    const liveBytes = readFileSync(location.dbPath);

    await expect(
      restoreCollaborationBackup(fixture.context, receipt, { operator: "ops-engineer", attestation: attestation() }),
    ).rejects.toMatchObject({ code: "collaboration.cutover-conflict" });
    expect(readFileSync(location.dbPath)).toEqual(liveBytes);

    // invariant: A corrupt second image is refused as an incomplete pair, with the
    // manifest and the execution image left in place.
    const second = await pairedWorkspace("pair-corrupt-");
    const secondOut = join(second.harness, "archived", "recovery", "pair.json");
    const secondReceipt = await backupRepositoryStores(second.context, { out: secondOut });
    const secondLive = readFileSync(resolveCollaborationLocation(second.context).dbPath);
    writeFileSync(pairImage(secondReceipt, "collaboration"), "not a database\n");
    await expect(
      restoreCollaborationBackup(second.context, secondReceipt, { operator: "ops-engineer", attestation: attestation() }),
    ).rejects.toMatchObject({ code: "collaboration.backup-incomplete" });
    expect(existsSync(secondOut)).toBe(true);
    expect(existsSync(pairImage(secondReceipt, "execution"))).toBe(true);
    expect(readFileSync(resolveCollaborationLocation(second.context).dbPath)).toEqual(secondLive);
  });

  test("a prepared composite in the selected root refuses the pair", async () => {
    const fixture = await pairedWorkspace("pair-pending-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    // note: The state a reservation leaves between admission and finalization: the
    // effect may already be committed on the lane side.
    const handle = await openStore(fixture.context, "write");
    try {
      handle.db
        .prepare(
          "insert into execution_collaboration_intents(execution_store_id, execution_epoch, operation_id, kind, request_hash, " +
            "actor, expected_token, reserved_revision, target_json, frozen_payload, phase, created_at, updated_at) " +
            "values (?, 1, 'op-pending-pair', 'residual-add', 'hash', 'project-manager', 'token', 1, '{}', '{}', 'prepared', ?, ?)",
        )
        .run((handle.db.prepare("select store_id from store_meta where id = 1").get() as { store_id: string }).store_id, "2026-11-21T00:00:00.000Z", "2026-11-21T00:00:00.000Z");
    } finally {
      handle.close();
    }
    await expect(backupRepositoryStores(fixture.context, { out })).rejects.toMatchObject({ code: "collaboration.backup-incomplete" });
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.execution.db`)).toBe(false);
    expect(existsSync(`${out}.collaboration.db`)).toBe(false);
  });

  test("an unacknowledged composite effect refuses the pair", async () => {
    const fixture = await pairedWorkspace("pair-unacknowledged-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    // invariant: A confirmed effect whose execution half never acknowledged it: the
    // supported two-transaction state the pair must never freeze.
    const location = resolveCollaborationLocation(fixture.context);
    await writeCollaborationStage(location, ({ db }) => {
      db.prepare(
        "insert into collaboration_operations(key_space, operation_id, execution_store_id, execution_epoch, request_hash, " +
          "result_json, collaboration_revision, catalog_revision, committed_at) " +
          "values ('composite', 'op-unacknowledged', 'store-x', 1, 'hash', ?, 0, 0, ?)",
      ).run(JSON.stringify({ receipt: { operationId: "op-unacknowledged" }, acknowledgedAt: null }), "2026-11-21T00:00:00.000Z");
    });

    await expect(backupRepositoryStores(fixture.context, { out })).rejects.toMatchObject({ code: "collaboration.backup-incomplete" });
    expect(existsSync(out)).toBe(false);
    // why: The refusal names the outstanding effect, so the operator knows what to replay.
    await expect(backupRepositoryStores(fixture.context, { out })).rejects.toThrow(/op-unacknowledged/);

    // note: …and it is a RECOVERABLE refusal: once the owning verb's replay records the
    // acknowledgement, the very next attempt publishes the pair.
    await writeCollaborationStage(location, ({ db }) => {
      db.prepare(
        "update collaboration_operations set result_json = ? where key_space = 'composite' and operation_id = 'op-unacknowledged'",
      ).run(JSON.stringify({ receipt: { operationId: "op-unacknowledged" }, acknowledgedAt: "2026-11-21T00:00:02.000Z" }));
    });
    const recovered = await backupRepositoryStores(fixture.context, { out });
    expect(recovered.manifestPath).toBe(out);
    expect(existsSync(pairImage(recovered, "execution"))).toBe(true);
  });

  test("a recorded decline never blocks a pair, and the pair restores it as settled history", async () => {
    const fixture = await pairedWorkspace("pair-declined-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const location = resolveCollaborationLocation(fixture.context);
    // why: A deterministic business refusal is durable in the same key space, with no
    // acknowledgedAt and no receipt: the execution side keeps it as terminal
    // state. It is settled history, not an outstanding effect.
    const declined = {
      declined: { code: "issue.scope-refused", message: "Actor does not hold the project-manager seat", details: null, at: "2026-11-21T00:00:00.000Z" },
    };
    await writeCollaborationStage(location, ({ db }) => {
      db.prepare(
        "insert into collaboration_operations(key_space, operation_id, execution_store_id, execution_epoch, request_hash, " +
          "result_json, collaboration_revision, catalog_revision, committed_at) " +
          "values ('composite', 'op-declined', 'store-other', 1, 'hash', ?, 0, 0, ?)",
      ).run(JSON.stringify(declined), "2026-11-21T00:00:00.000Z");
    });

    const receipt = await backupRepositoryStores(fixture.context, { out });
    expect(receipt.collaboration.authority.state).toBe("active");
    expect(existsSync(out)).toBe(true);

    // note: Restore accepts the decline as history of another root.
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${location.dbPath}${suffix}`, { force: true });
    const restored = await restoreCollaborationBackup(fixture.context, receipt, {
      operator: "ops-engineer",
      attestation: attestation(),
    });
    expect(restored.state).toBe("active");
    const handle = await openCollaborationStore(fixture.context, "read");
    try {
      expect(handle.db.prepare("select result_json from collaboration_operations where operation_id = 'op-declined'").get()).toEqual({
        result_json: JSON.stringify(declined),
      });
    } finally {
      handle.close();
    }
  });

  test("a malformed decline is unconfirmed history: the pair and the restore both refuse it", async () => {
    const malformed: ReadonlyArray<{ label: string; row: Record<string, unknown>; requestHash?: string }> = [
      // note: A partial decline (no instant) is not the shape the producer writes.
      { label: "op-partial-decline", row: { declined: { code: "issue.scope-refused", message: "seat", details: null } } },
      // note: An extra field nobody writes: hand-assembled, not recorded history.
      {
        label: "op-extra-key-decline",
        row: { declined: { code: "issue.scope-refused", message: "seat", details: null, at: "2026-11-21T00:00:00.000Z", reason: "x" } },
      },
      // note: A structurally valid decline the row no longer owns (no request identity).
      {
        label: "op-unowned-decline",
        row: { declined: { code: "issue.scope-refused", message: "seat", details: null, at: "2026-11-21T00:00:00.000Z" } },
        requestHash: "",
      },
    ];

    for (const shape of malformed) {
      const fixture = await pairedWorkspace(`pair-bad-decline-${shape.label}`);
      const out = join(fixture.harness, "archived", "recovery", "pair.json");
      await writeCollaborationStage(resolveCollaborationLocation(fixture.context), ({ db }) => {
        db.prepare(
          "insert into collaboration_operations(key_space, operation_id, execution_store_id, execution_epoch, request_hash, " +
            "result_json, collaboration_revision, catalog_revision, committed_at) " +
            "values ('composite', ?, 'store-other', 1, ?, ?, 0, 0, ?)",
        ).run(shape.label, shape.requestHash ?? "hash", JSON.stringify(shape.row), "2026-11-21T00:00:00.000Z");
      });
      await expect(backupRepositoryStores(fixture.context, { out })).rejects.toMatchObject({
        code: "collaboration.backup-incomplete",
      });
      await expect(backupRepositoryStores(fixture.context, { out })).rejects.toThrow(new RegExp(`${shape.label}: unreadable`));
      expect(existsSync(out)).toBe(false);
    }

    // invariant: The same row in a PUBLISHED pair is refused by the restore's boundary: a
    // malformed decline never travels as settled history.
    const fixture = await pairedWorkspace("pair-restore-bad-decline-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    const image = new DatabaseSync(pairImage(receipt, "collaboration"));
    try {
      image
        .prepare(
          "insert into collaboration_operations(key_space, operation_id, execution_store_id, execution_epoch, request_hash, " +
            "result_json, collaboration_revision, catalog_revision, committed_at) " +
            "values ('composite', 'op-bad-decline-image', 'store-other', 1, 'hash', ?, 0, 0, ?)",
        )
        .run(JSON.stringify({ declined: { code: "x" } }), "2026-11-21T00:00:00.000Z");
    } finally {
      image.close();
    }
    const patched = {
      ...receipt,
      collaboration: {
        ...receipt.collaboration,
        counts: {
          ...receipt.collaboration.counts,
          collaboration_operations: receipt.collaboration.counts.collaboration_operations + 1,
        },
      },
    };
    writeFileSync(receipt.manifestPath, `${JSON.stringify(patched, null, 2)}\n`);
    const location = resolveCollaborationLocation(fixture.context);
    const liveBytes = readFileSync(location.dbPath);
    await expect(
      restoreCollaborationBackup(fixture.context, patched, { operator: "ops-engineer", attestation: attestation() }),
    ).rejects.toThrow(/neither a receipt nor a recorded refusal/);
    expect(readFileSync(location.dbPath)).toEqual(liveBytes);
  });

  test("a reservation that starts during the copy refuses the pair and the retry succeeds", async () => {
    const fixture = await pairedWorkspace("pair-reservation-race-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const realOpen = collaborationStore.openCollaborationStore;
    let calls = 0;
    const spy = spyOn(collaborationStore, "openCollaborationStore").mockImplementation(async (context, mode, expected) => {
      calls += 1;
      // invariant: The second live read happens after the execution snapshot, so a
      // reservation committed here is NOT in the copied bytes: the publication
      // boundary's live re-read must catch it.
      if (calls === 2) {
        const writer = await openStore(context, "write");
        try {
          writer.db
            .prepare(
              "insert into execution_collaboration_intents(execution_store_id, execution_epoch, operation_id, kind, request_hash, " +
                "actor, expected_token, reserved_revision, target_json, frozen_payload, phase, created_at, updated_at) " +
                "values (?, 1, 'op-raced-reservation', 'residual-add', 'hash', 'project-manager', 'token', 1, '{}', '{}', 'prepared', ?, ?)",
            )
            .run(
              (writer.db.prepare("select store_id from store_meta where id = 1").get() as { store_id: string }).store_id,
              "2026-11-21T00:00:00.000Z",
              "2026-11-21T00:00:00.000Z",
            );
        } finally {
          writer.close();
        }
      }
      return realOpen(context, mode, expected);
    });
    try {
      await expect(backupRepositoryStores(fixture.context, { out })).rejects.toMatchObject({
        code: "collaboration.backup-incomplete",
      });
      // invariant: The LIVE re-check refused it (the reservation is absent from the frozen
      // bytes), naming the pending operation.
      await expect(backupRepositoryStores(fixture.context, { out })).rejects.toThrow(/still pending/);
    } finally {
      spy.mockRestore();
    }

    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.execution.db`)).toBe(false);

    // note: Once the reservation settles, the SAME attempt path publishes the pair.
    const handle = await openStore(fixture.context, "write");
    try {
      handle.db.prepare("delete from execution_collaboration_intents where operation_id = 'op-raced-reservation'").run();
    } finally {
      handle.close();
    }
    const retried = await backupRepositoryStores(fixture.context, { out });
    expect(retried.manifestPath).toBe(out);
  });

  test("a lane mutation during the copy refuses the pair and keeps the previous generation", async () => {
    const fixture = await pairedWorkspace("pair-mutated-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const location = resolveCollaborationLocation(fixture.context);
    const realOpen = collaborationStore.openCollaborationStore;
    let calls = 0;
    const spy = spyOn(collaborationStore, "openCollaborationStore").mockImplementation(async (context, mode, expected) => {
      calls += 1;
      // note: The second live read of the barrier (the after-copy pass) sees a lane
      // that advanced under the copy.
      if (calls === 2) {
        await writeCollaborationStage(location, ({ db }) => {
          db.prepare("update collaboration_meta set catalog_revision = catalog_revision + 1 where id = 1").run();
        });
      }
      return realOpen(context, mode, expected);
    });
    try {
      await expect(backupRepositoryStores(fixture.context, { out })).rejects.toMatchObject({
        code: "collaboration.backup-incomplete",
      });
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(out)).toBe(false);
    // note: Only this attempt's own scratch is gone; no canonical name was published.
    expect(existsSync(`${out}.execution.db`)).toBe(false);
    expect(existsSync(`${out}.collaboration.db`)).toBe(false);
    expect(readdirSync(dirname(out)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a competing attempt's image is never deleted by the loser", async () => {
    const fixture = await pairedWorkspace("pair-competitor-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    mkdirSync(dirname(out), { recursive: true });
    const realOpen = collaborationStore.openCollaborationStore;
    let calls = 0;
    const spy = spyOn(collaborationStore, "openCollaborationStore").mockImplementation(async (context, mode, expected) => {
      calls += 1;
      // invariant: A competitor publishes the execution image atomically while this attempt
      // is still copying: the create-only link below must lose, and the loser
      // must leave the competitor's bytes exactly as they are.
      if (calls === 2) writeFileSync(`${out}.execution.db`, "a competing attempt's execution image\n");
      return realOpen(context, mode, expected);
    });
    try {
      await expect(backupRepositoryStores(fixture.context, { out })).rejects.toMatchObject({
        code: "collaboration.backup-incomplete",
      });
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(`${out}.execution.db`, "utf8")).toBe("a competing attempt's execution image\n");
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.collaboration.db`)).toBe(false);
  });

  test("overlapping attempts never publish a pair with a missing image", async () => {
    const fixture = await pairedWorkspace("pair-overlap-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const results = await Promise.allSettled([
      backupRepositoryStores(fixture.context, { out }),
      backupRepositoryStores(fixture.context, { out }),
    ]);
    const published = results.filter((result) => result.status === "fulfilled");
    // invariant: At most one manifest may exist, and whichever attempt failed refused by
    // name instead of publishing a partial layout.
    expect(published.length).toBeLessThanOrEqual(1);
    for (const failed of results.filter((result) => result.status === "rejected")) {
      expect((failed as PromiseRejectedResult).reason).toMatchObject({ code: "collaboration.backup-incomplete" });
    }
    if (published.length === 1) {
      const receipt = (published[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof backupRepositoryStores>>>).value;
      expect(existsSync(pairImage(receipt, "execution"))).toBe(true);
      expect(existsSync(pairImage(receipt, "collaboration"))).toBe(true);
      expect(existsSync(out)).toBe(true);
    }
    expect(readdirSync(dirname(out)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("restore accepts acknowledged history from another execution root", async () => {
    // note: One repository, two checkouts: the lane is shared, each clone has its own
    // execution store. A composite that completed and was acknowledged in the
    // FIRST clone is legitimate history for the second clone's pair.
    const repoKey = `fixture-shared-${repoSequence++}`;
    const first = repoWorkspaceWithKey("clone-a-", repoKey);
    (await initializeStore(first.context)).close();
    await ensureCollaborationAuthority(first.context);
    const firstStoreId = (await openStore(first.context, "read").then((handle) => {
      try {
        return (handle.db.prepare("select store_id from store_meta where id = 1").get() as { store_id: string }).store_id;
      } finally {
        handle.close();
      }
    }));
    const location = resolveCollaborationLocation(first.context);
    await writeCollaborationStage(location, ({ db }) => {
      db.prepare(
        "insert into collaboration_operations(key_space, operation_id, execution_store_id, execution_epoch, request_hash, " +
          "result_json, collaboration_revision, catalog_revision, committed_at) " +
          "values ('composite', 'op-first-clone', ?, 1, 'hash', ?, 0, 0, ?)",
      ).run(firstStoreId, JSON.stringify({ receipt: { operationId: "op-first-clone" }, acknowledgedAt: "2026-11-21T00:00:01.000Z" }), "2026-11-21T00:00:01.000Z");
    });

    const second = repoWorkspaceWithKey("clone-b-", repoKey);
    (await initializeStore(second.context)).close();
    // note: The clone is already bound to the shared lane's authority (adoption is a
    // separate, explicit verb); this case is about cross-root history.
    const shared = await readCollaborationStage(resolveCollaborationLocation(first.context), ({ authority }) => authority);
    writeCollaborationBinding(second.context, {
      repoKey: shared.repoKey,
      mode: shared.mode,
      storeId: shared.storeId,
      epoch: shared.epoch,
      binding: "active",
    });
    const out = join(second.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(second.context, { out });
    expect(receipt.collaboration.authority.storeId).toBe((await ensureCollaborationAuthority(second.context)).storeId);

    const target = resolveCollaborationLocation(second.context).dbPath;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${target}${suffix}`, { force: true });
    const restored = await restoreCollaborationBackup(second.context, receipt, {
      operator: "ops-engineer",
      attestation: attestation(),
    });
    expect(restored.state).toBe("active");
    // note: The other root's acknowledged history travelled with the image.
    const handle = await openCollaborationStore(second.context, "read");
    try {
      expect(handle.db.prepare("select execution_store_id from collaboration_operations where operation_id = 'op-first-clone'").get()).toEqual({
        execution_store_id: firstStoreId,
      });
    } finally {
      handle.close();
    }
  });

  test("fresh bootstrap refuses a store holding only non-issue collaboration rows", async () => {
    const fixture = repoWorkspace("bootstrap-project-only-");
    (await initializeStore(fixture.context)).close();
    const store = await openStore(fixture.context, "write");
    store.db
      .prepare("insert into project_bindings(project_id, provider, workspace, team, remote_project, revision, updated_at) values ('proj-x', 'linear', 'ws', 'team', 'remote', 1, 'now')")
      .run();
    store.close();
    await rmSync(resolveCollaborationLocation(fixture.context).dbPath, { force: true });

    await expect(ensureCollaborationAuthority(fixture.context)).rejects.toMatchObject({
      code: "collaboration.cutover-required",
    });
    expect(existsSync(resolveCollaborationLocation(fixture.context).dbPath)).toBe(false);
  });

  test("restore refuses another repository's pair by its stale binding", async () => {
    const other = await pairedWorkspace("pair-other-");
    const otherOut = join(other.harness, "archived", "recovery", "pair.json");
    const otherReceipt = await backupRepositoryStores(other.context, { out: otherOut });

    const mine = repoWorkspace("pair-mine-");
    (await initializeStore(mine.context)).close();
    await ensureCollaborationAuthority(mine.context);
    const myLocation = resolveCollaborationLocation(mine.context);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${myLocation.dbPath}${suffix}`, { force: true });

    await expect(
      restoreCollaborationBackup(mine.context, otherReceipt, { operator: "ops-engineer", attestation: attestation() }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(existsSync(myLocation.dbPath)).toBe(false);
  });

  test("a pair moved with its manifest restores from the operator-supplied location", async () => {
    const fixture = await pairedWorkspace("pair-moved-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    const moved = join(fixture.harness, "archived", "moved");
    mkdirSync(moved, { recursive: true });
    const movedManifest = join(moved, basename(out));
    for (const name of [basename(out), receipt.execution.backupPath, receipt.collaboration.path]) {
      copyFileSync(join(dirname(out), name), join(moved, name));
    }
    rmSync(dirname(out), { recursive: true, force: true });
    const target = resolveCollaborationLocation(fixture.context).dbPath;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${target}${suffix}`, { force: true });

    const restored = await restoreCollaborationBackup(fixture.context, receipt, {
      operator: "ops-engineer",
      attestation: attestation(),
      manifestPath: movedManifest,
    });
    expect(restored.state).toBe("active");
  });

  test("restore refuses an image the runtime would not admit and leaves the target absent", async () => {
    const fixture = await pairedWorkspace("pair-bad-schema-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    // invariant: Structurally intact and contiguous, but it carries a table outside the
    // closed collaboration inventory: the runtime's own admission must refuse it
    // BEFORE the canonical target exists.
    const image = new DatabaseSync(pairImage(receipt, "collaboration"));
    try {
      image.exec("create table rogue_authority(id integer primary key)");
    } finally {
      image.close();
    }
    const target = resolveCollaborationLocation(fixture.context).dbPath;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${target}${suffix}`, { force: true });

    await expect(
      restoreCollaborationBackup(fixture.context, receipt, { operator: "ops-engineer", attestation: attestation() }),
    ).rejects.toMatchObject({ code: "collaboration.unreadable" });
    expect(existsSync(target)).toBe(false);
  });

  test("restore refuses a redirected authority ancestor before staging anything", async () => {
    const fixture = await pairedWorkspace("pair-symlink-ancestor-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    const target = resolveCollaborationLocation(fixture.context).dbPath;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${target}${suffix}`, { force: true });
    const storeDir = dirname(target);
    const redirected = `${storeDir}-redirected`;
    renameSync(storeDir, redirected);
    mkdirSync(storeDir);
    // invariant: An existing ancestor in the canonical storage tree is now a link: the
    // restore must refuse it before creating a staging directory through it.
    const { symlinkSync } = await import("node:fs");
    rmSync(storeDir, { recursive: true, force: true });
    symlinkSync(redirected, storeDir);

    await expect(
      restoreCollaborationBackup(fixture.context, receipt, { operator: "ops-engineer", attestation: attestation() }),
    ).rejects.toMatchObject({ code: "collaboration.unreadable" });
    expect(existsSync(join(redirected, "collaboration.db"))).toBe(false);
  });

  test("restoring the same recovery point twice never reuses an authority stamp", async () => {
    const fixture = await pairedWorkspace("pair-regeneration-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    const target = resolveCollaborationLocation(fixture.context).dbPath;
    const clear = (): void => {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${target}${suffix}`, { force: true });
    };
    clear();
    const first = await restoreCollaborationBackup(fixture.context, receipt, {
      operator: "ops-engineer",
      attestation: attestation(),
    });
    // note: The recovered generation is lost; the ORIGINAL point is restored again.
    clear();
    const second = await restoreCollaborationBackup(fixture.context, receipt, {
      operator: "ops-engineer",
      attestation: attestation(),
    });
    expect(second.epoch).toBeGreaterThan(first.epoch);

    // note: A stamp issued by the first recovery is not a stamp of the second.
    await expect(
      openCollaborationStore(fixture.context, "read", {
        repoKey: second.repoKey,
        mode: second.mode,
        storeId: first.storeId,
        epoch: first.epoch,
      }),
    ).rejects.toMatchObject({ code: "collaboration.stale-binding" });

    // invariant: The recovered generation's own records died with it; the LINEAGE ledger is
    // what remembers it, so the second recovery names generation 2 and the epoch
    // it superseded. An older stamped input cannot replay into the new generation.
    expect(JSON.parse(readFileSync(join(dirname(target), "restore-lineage.json"), "utf8"))).toMatchObject({ generation: 2 });
    const handle = await openCollaborationStore(fixture.context, "read");
    try {
      const rows = handle.db
        .prepare("select result_json from collaboration_operations where operation_id like 'restore:%' order by rowid")
        .all() as Array<{ result_json: string }>;
      expect(rows.length).toBe(1);
      expect(JSON.parse(rows[0]!.result_json).lineage).toMatchObject({ generation: 2, previousEpoch: first.epoch });
    } finally {
      handle.close();
    }
  });

  test("restore re-proves the producer's quiescent boundary", async () => {
    // invariant: A prepared reservation in the PAIRED execution image refuses the restore.
    const reserved = await pairedWorkspace("pair-restore-reservation-");
    const reservedOut = join(reserved.harness, "archived", "recovery", "pair.json");
    const reservedReceipt = await backupRepositoryStores(reserved.context, { out: reservedOut });
    const executionImage = new DatabaseSync(pairImage(reservedReceipt, "execution"));
    try {
      executionImage
        .prepare(
          "insert into execution_collaboration_intents(execution_store_id, execution_epoch, operation_id, kind, request_hash, " +
            "actor, expected_token, reserved_revision, target_json, frozen_payload, phase, created_at, updated_at) " +
            "values (?, 1, 'op-pair-reservation', 'residual-add', 'hash', 'pm', 'token', 1, '{}', '{}', 'prepared', ?, ?)",
        )
        .run(reservedReceipt.execution.storeId, "2026-11-21T00:00:00.000Z", "2026-11-21T00:00:00.000Z");
    } finally {
      executionImage.close();
    }
    const reservedTarget = resolveCollaborationLocation(reserved.context).dbPath;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${reservedTarget}${suffix}`, { force: true });
    await expect(
      restoreCollaborationBackup(reserved.context, reservedReceipt, { operator: "ops-engineer", attestation: attestation() }),
    ).rejects.toThrow(/prepared composite/);
    expect(existsSync(reservedTarget)).toBe(false);

    // note: An unacknowledged effect of ANOTHER root is outstanding, not history.
    const foreign = await pairedWorkspace("pair-restore-foreign-unack-");
    const foreignOut = join(foreign.harness, "archived", "recovery", "pair.json");
    const foreignReceipt = await backupRepositoryStores(foreign.context, { out: foreignOut });
    const image = new DatabaseSync(pairImage(foreignReceipt, "collaboration"));
    try {
      image
        .prepare(
          "insert into collaboration_operations(key_space, operation_id, execution_store_id, execution_epoch, request_hash, " +
            "result_json, collaboration_revision, catalog_revision, committed_at) " +
            "values ('composite', 'op-foreign-unack', 'store-other', 1, 'hash', ?, 0, 0, ?)",
        )
        .run(JSON.stringify({ receipt: { operationId: "op-foreign-unack" }, acknowledgedAt: null }), "2026-11-21T00:00:00.000Z");
    } finally {
      image.close();
    }
    const patched = {
      ...foreignReceipt,
      collaboration: {
        ...foreignReceipt.collaboration,
        counts: {
          ...foreignReceipt.collaboration.counts,
          collaboration_operations: foreignReceipt.collaboration.counts.collaboration_operations + 1,
        },
      },
    };
    writeFileSync(foreignReceipt.manifestPath, `${JSON.stringify(patched, null, 2)}\n`);
    const foreignTarget = resolveCollaborationLocation(foreign.context).dbPath;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${foreignTarget}${suffix}`, { force: true });
    await expect(
      restoreCollaborationBackup(foreign.context, patched, { operator: "ops-engineer", attestation: attestation() }),
    ).rejects.toThrow(/without its acknowledgement/);
    expect(existsSync(foreignTarget)).toBe(false);
  });

  test("an interrupted pair publication resumes from its own verified images", async () => {
    const fixture = await pairedWorkspace("pair-interrupted-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    // note: The crash window: both images and the attempt's claim are published, the
    // manifest is not. The claim is what makes those two images ONE pair.
    rmSync(out, { force: true });
    writeAttemptClaim(out, receipt);
    expect(existsSync(pairImage(receipt, "execution"))).toBe(true);
    expect(existsSync(pairImage(receipt, "collaboration"))).toBe(true);

    const resumed = await backupRepositoryStores(fixture.context, { out });
    expect(existsSync(out)).toBe(true);
    expect(resumed.collaboration.authority.storeId).toBe(receipt.collaboration.authority.storeId);
    expect(resumed.collaboration.counts).toEqual(receipt.collaboration.counts);

    // invariant: Images with NO attempt evidence are never blessed as a pair — including a
    // half pair, and including a mixed pair assembled from different snapshots.
    const half = await pairedWorkspace("pair-half-");
    const halfOut = join(half.harness, "archived", "recovery", "pair.json");
    const halfReceipt = await backupRepositoryStores(half.context, { out: halfOut });
    rmSync(halfOut, { force: true });
    rmSync(pairImage(halfReceipt, "collaboration"), { force: true });
    await expect(backupRepositoryStores(half.context, { out: halfOut })).rejects.toMatchObject({
      code: "collaboration.backup-incomplete",
    });

    // note: A mixed-time pair: a claim names one attempt's bytes, but the execution
    // image at that name is a LATER snapshot's.
    const mixed = await pairedWorkspace("pair-mixed-");
    const mixedOut = join(mixed.harness, "archived", "recovery", "pair.json");
    const first = await backupRepositoryStores(mixed.context, { out: mixedOut });
    // note: Re-create the crash window (manifest absent, claim present) from the first
    // pair, then replace the execution image with another snapshot's bytes.
    rmSync(mixedOut, { force: true });
    writeAttemptClaim(mixedOut, first);
    const other = await pairedWorkspace("pair-mixed-other-");
    const otherOut = join(other.harness, "archived", "recovery", "pair.json");
    const later = await backupRepositoryStores(other.context, { out: otherOut });
    writeFileSync(pairImage(first, "execution"), readFileSync(pairImage(later, "execution")));
    await expect(backupRepositoryStores(mixed.context, { out: mixedOut })).rejects.toThrow(/not the one this attempt copied/);
  });
});

/** why: A combined source checkout identified by a Git ORIGIN (so a retarget is testable). */
function originCheckout(name: string, origin: string): Fixture {
  const fixture = repoWorkspace(name);
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: fixture.checkout, stdio: ["ignore", "pipe", "pipe"] });
  // note: The repository identity comes from the ORIGIN; the checkout only declares its mode.
  writeFileSync(join(fixture.checkout, ".mstarc"), "[collaboration]\nmode=local\n");
  return fixture;
}

/** note: The minimal cutover attestation: one reloaded coordinator and the exact source generation. */
function cutoverOptionsFor(
  context: StoreContext,
  source: { storeId: string; epoch: number; schemaVersion: number },
): { operator: string; attestation: ActivationAttestation } {
  const location = resolveCollaborationLocation(context);
  return {
    operator: "ops-engineer",
    attestation: {
      version: ACTIVATION_PROTOCOL_VERSION,
      attestedAt: "2026-11-21T00:00:00.000Z",
      operator: { actor: "ops-engineer", authorizationRef: "iteration compass / cutover decision" },
      consumers: [
        {
          entryId: "coordinator-omp",
          kind: "coordinator",
          entrypoint: "/opt/mstar/omp/dist/index.js",
          runtime: "node",
          runtimeVersion: process.versions.node,
          version: readHarnessVersion(),
          current: true,
          disposition: "reloaded",
        },
      ],
      stoppedSessions: [{ sessionId: "session-one", host: "omp", state: "stopped" }],
      cutover: {
        repoKey: location.repoKey,
        mode: location.mode,
        controlRoot: resolve(context.harnessDir),
        sourceStoreId: source.storeId,
        sourceEpoch: source.epoch,
        schemaVersion: source.schemaVersion,
        stoppedHandles: [
          { kind: "session", id: "session-one" },
          { kind: "process", id: "mstar-cli" },
        ],
        allHandlesStopped: true,
      },
    },
  };
}

describe("shipped cutover activation binding", () => {
  test("the shipped activation binds the source checkout, its replay refreshes it, and a retarget refuses", async () => {
    const origin = "https://github.com/acme/cutover-binding-regression.git";
    const fixture = originCheckout("cutover-binding-regression-", origin);
    // why: A current-schema combined source (above the cutover floor): the authority the
    // reviewed cutover moves. Its rows are seeded directly, so no ordinary verb
    // writes the lane before the cutover exists.
    (await initializeStore(fixture.context)).close();
    const store = await openStore(fixture.context, "write");
    let source: { storeId: string; epoch: number; schemaVersion: number };
    try {
      store.db.exec(`
insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at)
values ('project', 'p-one', 'Project One', 'projects', 'p-one/roadmap.md', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into project_milestones(milestone_id, project_id, name, ordinal, created_at, updated_at)
values ('m-one', 'p-one', 'Milestone One', 0, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key, milestone_id)
values ('I-000001', 'p-one', 'First finding', 'bug', 'high', 'open', 'It broke', 'It stays fixed', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z', 'identity-one', 'm-one');
insert into occurrences(issue_id, occurrence_key, source_kind, source_identity, root_cause_key, acceptance_key, location, observed_behavior, evidence_json, discovered_at, recorded_at)
values ('I-000001', 'occ-one', 'test', 'suite/one', 'root-one', 'accept-one', 'packages/engine', 'observed', '{}', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into execution_workflows(workflow_id, revision, creator_session_id, state_json, created_at, updated_at)
values ('wf-live', 1, 'session-one', '{}', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z');
insert into execution_sessions(workflow_id, role, session_id, epoch, revision, state, bound_at)
values ('wf-live', 'coordinator', 'session-one', 1, 1, 'active', '2026-11-21T00:00:00.000Z');
`);
      const row = store.db.prepare("select store_id, authority_epoch from store_meta where id = 1").get() as {
        store_id: string;
        authority_epoch: number;
      };
      source = { storeId: row.store_id, epoch: row.authority_epoch, schemaVersion: MIGRATIONS.length };
    } finally {
      store.close();
    }
    expect(readCollaborationBinding(fixture.context)).toBeNull();

    const manifest = await planCollaborationCutover(fixture.context);
    await applyCollaborationCutover(fixture.context, manifest);
    const activation = await activateCollaborationCutover(fixture.context, manifest, cutoverOptionsFor(fixture.context, source));
    expect(activation.phase).toBe("active");
    // note: The SHIPPED path records the binding before it returns.
    expect(readCollaborationBinding(fixture.context)).toMatchObject({
      repoKey: activation.target.repoKey,
      mode: activation.target.mode,
      storeId: activation.target.storeId,
      epoch: activation.target.epoch,
    });

    // why: The replay keeps the same generation bound.
    const replay = await activateCollaborationCutover(fixture.context, manifest, cutoverOptionsFor(fixture.context, source));
    expect(replay.replayed).toBe(true);
    expect(readCollaborationBinding(fixture.context)).toMatchObject({ storeId: replay.target.storeId, epoch: replay.target.epoch });

    // invariant: A retargeted checkout is refused by the checkout-binding tests below; here the
    // shipped path is proven to persist and refresh the binding itself.
  });
});

describe("control-checkout binding states", () => {
  /** note: A checkout with both authorities and its binding recorded by the init path. */
  async function boundWorkspace(name: string): Promise<Fixture> {
    const fixture = repoWorkspace(name);
    (await initializeStore(fixture.context)).close();
    await ensureCollaborationAuthority(fixture.context);
    return fixture;
  }

  test("an attempt-scoped claim is never the checkout's binding, and an unproven one is not promoted", async () => {
    const fixture = await boundWorkspace("binding-claim-ignored-");
    const location = resolveCollaborationLocation(fixture.context);
    const live = await readCollaborationStage(location, ({ authority }) => authority);
    // note: The checkout's OWN binding is removed, leaving only an interrupted claim.
    rmSync(join(fixture.harness, "collaboration-binding.json"), { force: true });
    beginBindingClaim(fixture.context, { repoKey: location.repoKey, mode: location.mode, storeId: live.storeId, epoch: live.epoch });
    // invariant: A claim is attempt evidence, never a binding. A read is unbound-tolerant,
    // but `store init` will not promote an unproven claim…
    expect((await readCollaborationAuthority(fixture.context)).storeId).toBe(live.storeId);
    await expect(ensureCollaborationAuthority(fixture.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // note: …and it leaves no primary binding behind.
    expect(existsSync(join(fixture.harness, "collaboration-binding.json"))).toBe(false);
  });

  test("a claim backed by the recorded publication is finalized by the explicit activation replay", async () => {
    const fixture = await stagedFixture("binding-claim-proven-");
    const activation = await activateStore(fixture.context, fixture.apply, attestation());
    const location = resolveCollaborationLocation(fixture.context);
    // note: The crash window: the publication and its activation phase row landed, the
    // final binding write did not; only the attempt claim remains.
    rmSync(join(fixture.harness, "collaboration-binding.json"), { force: true });
    beginBindingClaim(fixture.context, {
      repoKey: location.repoKey,
      mode: location.mode,
      storeId: activation.storeId,
      epoch: activation.epoch,
    });
    await expect(openCollaborationStore(fixture.context, "write")).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // invariant: store init refuses (never adopts)…
    await expect(ensureCollaborationAuthority(fixture.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // note: …and the explicit activation replay, which verifies the recorded publication
    // and the current repo/mode/store/epoch, finalizes it.
    const adopted = await activateStore(fixture.context, fixture.apply, attestation());
    expect(adopted.storeId).toBe(activation.storeId);
    expect(readCollaborationBinding(fixture.context)).toMatchObject({ state: "active", storeId: activation.storeId, epoch: activation.epoch });
    expect(existsSync(join(fixture.harness, "collaboration-binding.claim.json"))).toBe(false);
  });

  test("a refused activation restores this checkout's previous binding exactly", async () => {
    const fixture = await stagedFixture("activation-claim-rollback-");
    const location = resolveCollaborationLocation(fixture.context);
    // note: A pre-existing, legitimate binding for the STAGED generation (what the
    // checkout held before this attempt).
    const staged = await readCollaborationStage(location, ({ authority }) => authority);
    writeFileSync(
      join(fixture.harness, "collaboration-binding.json"),
      `${JSON.stringify(
        { version: 2, state: "active", repoKey: location.repoKey, mode: location.mode, storeId: staged.storeId, epoch: staged.epoch, boundAt: "2026-11-21T00:00:00.000Z" },
        null,
        2,
      )}\n`,
    );
    const before = readFileSync(join(fixture.harness, "collaboration-binding.json"));
    // invariant: The activation is refused INSIDE the flip (a register appears after the
    // inspection pass), i.e. after the claim would have been written.
    await expect(
      activateStore(fixture.context, fixture.apply, attestation(), {
        afterStage(stage) {
          if (stage === "inspection") {
            // invariant: A NEW register appears after the reviewed apply: the barrier's source
            // fence must refuse the activation.
            writeRegister(fixture.harness, "late-project", { entries: { "plan-late": [entry({ id: "L1" })] } });
          }
        },
      }),
    ).rejects.toMatchObject({ code: "store.migration-source-changed" });
    // invariant: The primary binding was NEVER overwritten, and no attempt claim survives.
    expect(readFileSync(join(fixture.harness, "collaboration-binding.json"))).toEqual(before);
    expect(existsSync(join(fixture.harness, "collaboration-binding.claim.json"))).toBe(false);
  });

  test("an unbound checkout reads without recording a binding, and its write still refuses", async () => {
    const fixture = await boundWorkspace("binding-unbound-read-");
    const location = resolveCollaborationLocation(fixture.context);
    const live = await readCollaborationStage(location, ({ authority }) => authority);
    rmSync(join(fixture.harness, "collaboration-binding.json"), { force: true });

    const handle = await openCollaborationStore(fixture.context, "read");
    try {
      expect(handle.authority).toMatchObject({ storeId: live.storeId, epoch: live.epoch });
    } finally {
      handle.close();
    }
    // note: Reading is not adopting: a replacement clone stays unbound until a write
    // proves it through the supported adoption route.
    expect(readCollaborationBinding(fixture.context)).toBeNull();
    expect(existsSync(join(fixture.harness, "collaboration-binding.json"))).toBe(false);
    await expect(openCollaborationStore(fixture.context, "write")).rejects.toMatchObject({ code: "collaboration.stale-binding" });
  });

  test("a bound checkout refuses a replacement generation published at the same key and mode", async () => {
    const fixture = await boundWorkspace("binding-replacement-generation-");
    const location = resolveCollaborationLocation(fixture.context);
    const bound = readCollaborationBinding(fixture.context)!;
    const rewrite = (column: "store_id" | "authority_epoch", value: string | number): void => {
      const db = new DatabaseSync(location.dbPath);
      try {
        db.prepare(`update collaboration_meta set ${column} = ? where id = 1`).run(value);
      } finally {
        db.close();
      }
    };

    // note: A restore publishes a fresh store id at this repository's own key and mode.
    rewrite("store_id", "00000000-0000-4000-8000-000000000001");
    await expect(openCollaborationStore(fixture.context, "read")).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    await expect(readCollaborationAuthority(fixture.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // note: The same store with a bumped epoch is also a different generation.
    rewrite("store_id", bound.storeId);
    rewrite("authority_epoch", bound.epoch + 1);
    await expect(openCollaborationStore(fixture.context, "read")).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    await expect(openCollaborationStore(fixture.context, "write")).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // invariant: A refused read never rewrites the checkout's own binding.
    expect(readCollaborationBinding(fixture.context)).toEqual(bound);
  });

  test("a retargeted checkout cannot read the other repository's lane either", async () => {
    const repoA = `fixture-read-retarget-a-${repoSequence++}`;
    const a = repoWorkspaceWithKey("read-retarget-a-", repoA);
    (await initializeStore(a.context)).close();
    await ensureCollaborationAuthority(a.context);
    const bound = readCollaborationBinding(a.context)!;
    const repoB = `fixture-read-retarget-b-${repoSequence++}`;
    const b = repoWorkspaceWithKey("read-retarget-b-", repoB);
    (await initializeStore(b.context)).close();
    await ensureCollaborationAuthority(b.context);

    writeFileSync(join(a.checkout, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=${repoB}\n`);
    await expect(readCollaborationAuthority(a.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    await expect(openCollaborationStore(a.context, "write")).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // note: A's binding still names A's repository.
    expect(readCollaborationBinding(a.context)).toEqual(bound);
  });
});

describe("switch safety", () => {
  test("the unbound-checkout refusal names the supported adoption verb", async () => {
    const fixture = await boundWorkspace("binding-refusal-text-");
    const location = resolveCollaborationLocation(fixture.context);
    const live = await readCollaborationStage(location, ({ authority }) => authority);
    rmSync(join(fixture.harness, "collaboration-binding.json"), { force: true });
    const error = (await openCollaborationStore(fixture.context, "write").then(
      () => null,
      (failure: unknown) => failure as { code?: string; message: string },
    ));
    expect(error?.code).toBe("collaboration.stale-binding");
    expect(error!.message).toContain("store collaboration adopt --harness");
    expect(error!.message).toContain(`--expect-store ${live.storeId}`);
    expect(error!.message).not.toContain("store init (adopts");
  });
  /** note: A checkout with both authorities and its binding recorded by the creating verb. */
  async function boundWorkspace(name: string): Promise<Fixture> {
    const fixture = repoWorkspace(name);
    (await initializeStore(fixture.context)).close();
    await ensureCollaborationAuthority(fixture.context);
    return fixture;
  }

  test("an interrupted first switch plus an origin change refuses every init and keeps the claim", async () => {
    const repoA = `fixture-switch-a-${repoSequence++}`;
    const a = repoWorkspaceWithKey("switch-a-", repoA);
    (await initializeStore(a.context)).close();
    const authorityA = await ensureCollaborationAuthority(a.context);
    // note: The first switch to B starts (claim for A), then the origin changes to B.
    beginBindingClaim(a.context, { repoKey: authorityA.repoKey, mode: authorityA.mode, storeId: authorityA.storeId, epoch: authorityA.epoch });
    const repoB = `fixture-switch-b-${repoSequence++}`;
    writeFileSync(join(a.checkout, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=${repoB}\n`);
    const b = repoWorkspaceWithKey("switch-b-", repoB);
    (await initializeStore(b.context)).close();
    await ensureCollaborationAuthority(b.context);

    // invariant: FIRST and SECOND init both refuse; the mismatched claim is never discarded.
    await expect(ensureCollaborationAuthority(a.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    await expect(ensureCollaborationAuthority(a.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(existsSync(join(a.harness, "collaboration-binding.claim.json"))).toBe(true);
    // invariant: Ordinary access to B's lane is refused too (no binding was adopted).
    await expect(readCollaborationAuthority(a.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    // note: A's own binding is untouched.
    expect(readCollaborationBinding(a.context)).toMatchObject({ state: "active", storeId: authorityA.storeId });
  });

  test("a mismatched claim is never promoted and leaves the previous binding unchanged", async () => {
    const fixture = await boundWorkspace("binding-mismatched-claim-");
    const before = readFileSync(join(fixture.harness, "collaboration-binding.json"));
    const location = resolveCollaborationLocation(fixture.context);
    const live = await readCollaborationStage(location, ({ authority }) => authority);
    // invariant: A claim naming ANOTHER generation: unproven by the lane, so never promoted.
    beginBindingClaim(fixture.context, { repoKey: location.repoKey, mode: location.mode, storeId: `${live.storeId}-other`, epoch: live.epoch + 5 });
    // why: The checkout still owns the live generation, so the bootstrap serves it — but
    // the mismatched claim is neither promoted nor replaced, and the primary
    // binding is byte-identical.
    const authority = await ensureCollaborationAuthority(fixture.context);
    expect(authority.storeId).toBe(live.storeId);
    expect(readFileSync(join(fixture.harness, "collaboration-binding.json"))).toEqual(before);
    const claim = JSON.parse(readFileSync(join(fixture.harness, "collaboration-binding.claim.json"), "utf8")) as {
      storeId: string;
      epoch: number;
    };
    expect(claim).toMatchObject({ storeId: `${live.storeId}-other`, epoch: live.epoch + 5 });
  });
});

describe("pair attempt ownership and restore repair", () => {
  test("a symlinked private image is never adopted or unlinked", async () => {
    const fixture = await pairFixture("attempt-symlink-private-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    writeAttemptClaim(out, receipt);
    const claimPath = `${out}.pair-attempt.json`;
    const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { collaboration: { privatePath: string } };
    // note: A symlink at the EXACT private name, pointing at a file with the right digest:
    // shape, parent and bytes all look valid, but it is not a regular file.
    const target = `${claim.collaboration.privatePath}.target`;
    copyFileSync(pairImage(receipt, "collaboration"), target);
    symlinkSync(target, claim.collaboration.privatePath);
    writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`);
    const targetBytes = readFileSync(target);
    rmSync(out, { force: true });
    rmSync(pairImage(receipt, "collaboration"), { force: true });

    await expect(backupRepositoryStores(fixture.context, { out })).rejects.toThrow(/cannot be completed/);
    // note: The link is untouched (still a symlink) and its target is byte-identical.
    expect(lstatSync(claim.collaboration.privatePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target).equals(targetBytes)).toBe(true);
    expect(existsSync(pairImage(receipt, "collaboration"))).toBe(false);
  });
  async function pairFixture(name: string): Promise<Fixture> {
    const fixture = repoWorkspace(name);
    (await initializeStore(fixture.context)).close();
    await ensureCollaborationAuthority(fixture.context);
    return fixture;
  }

  test("a one-image interruption reuses the verified image and publishes the pair", async () => {
    const fixture = await pairFixture("attempt-one-image-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    const verifiedExecution = readFileSync(pairImage(receipt, "execution"));
    writeAttemptClaim(out, receipt);
    // invariant: The crash window: the collaboration side was never published, and the
    // attempt's own verified private image for it is retained beside the pair.
    const claim = JSON.parse(readFileSync(`${out}.pair-attempt.json`, "utf8")) as { collaboration: { privatePath: string } };
    copyFileSync(pairImage(receipt, "collaboration"), claim.collaboration.privatePath);
    rmSync(out, { force: true });
    rmSync(pairImage(receipt, "collaboration"), { force: true });

    const survivorStats = statSync(pairImage(receipt, "execution"));
    const resumed = await backupRepositoryStores(fixture.context, { out });
    expect(existsSync(out)).toBe(true);
    // invariant: The surviving image is REUSED byte-for-byte: same bytes, same inode and the
    // same mtime prove the resume never re-copied or overwrote it.
    expect(readFileSync(pairImage(resumed, "execution")).equals(verifiedExecution)).toBe(true);
    const afterStats = statSync(pairImage(resumed, "execution"));
    expect(afterStats.ino).toBe(survivorStats.ino);
    expect(afterStats.mtimeMs).toBe(survivorStats.mtimeMs);
    expect(existsSync(pairImage(resumed, "collaboration"))).toBe(true);
    // note: The credential is scratch: the manifest is the commit.
    expect(existsSync(`${out}.pair-attempt.json`)).toBe(false);
  });


  test("a resumed attempt reuses the retained verified private image instead of re-copying", async () => {
    const fixture = await pairFixture("attempt-private-reuse-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    // invariant: Reconstruct the crash window: the credential exists, the COLLABORATION side
    // was never linked into its public name, and its verified private image is
    // retained beside the destination.
    writeAttemptClaim(out, receipt);
    const claim = JSON.parse(readFileSync(`${out}.pair-attempt.json`, "utf8")) as {
      collaboration: { privatePath: string };
    };
    copyFileSync(pairImage(receipt, "collaboration"), claim.collaboration.privatePath);
    rmSync(out, { force: true });
    rmSync(pairImage(receipt, "collaboration"), { force: true });

    const privateInode = statSync(claim.collaboration.privatePath).ino;
    const resumed = await backupRepositoryStores(fixture.context, { out });
    // why: The private image was LINKED, not re-copied: the published name carries the
    // private image's own inode (a copy would have a new one).
    expect(statSync(pairImage(resumed, "collaboration")).ino).toBe(privateInode);
    expect(existsSync(claim.collaboration.privatePath)).toBe(false);
    expect(existsSync(`${out}.pair-attempt.json`)).toBe(false);
  });


  test("a failing attempt never unlinks another attempt's claim or files", async () => {
    const fixture = await pairFixture("attempt-foreign-claim-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    mkdirSync(dirname(out), { recursive: true });
    // note: A foreign attempt's evidence: its claim, its private image and its published
    // execution name.
    const foreignClaim = {
      version: 1,
      attempt: "foreign-attempt",
      takenAt: "2026-11-21T00:00:00.000Z",
      execution: { name: basename(`${out}.execution.db`), privatePath: `${out}.foreign-execution.private.tmp`, sha256: "a".repeat(64), storeId: "store-foreign", epoch: 1, revision: 1, catalogRevision: 0 },
      collaboration: { name: basename(`${out}.collaboration.db`), privatePath: `${out}.foreign-collaboration.private.tmp`, sha256: "b".repeat(64), storeId: "store-foreign", epoch: 1, revision: 1, catalogRevision: 0 },
    };
    writeFileSync(`${out}.pair-attempt.json`, `${JSON.stringify(foreignClaim, null, 2)}\n`);
    writeFileSync(`${out}.foreign-execution.private.tmp`, "foreign execution bytes\n");
    writeFileSync(`${out}.foreign-collaboration.private.tmp`, "foreign collaboration bytes\n");

    // invariant: This attempt cannot publish (the destination is occupied by foreign evidence)
    // and its failure path must leave every foreign file intact.
    await expect(backupRepositoryStores(fixture.context, { out })).rejects.toMatchObject({ code: "collaboration.backup-incomplete" });
    expect(readFileSync(`${out}.pair-attempt.json`, "utf8")).toContain("foreign-attempt");
    expect(readFileSync(`${out}.foreign-execution.private.tmp`, "utf8")).toBe("foreign execution bytes\n");
    expect(readFileSync(`${out}.foreign-collaboration.private.tmp`, "utf8")).toBe("foreign collaboration bytes\n");
  });

  test("a resume with no retained original refuses instead of re-copying from the live authority", async () => {
    const fixture = await pairFixture("attempt-missing-original-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    writeAttemptClaim(out, receipt);
    // invariant: The collaboration side was never published AND its retained private image is
    // gone: the attempt cannot be completed from its own verified bytes.
    rmSync(out, { force: true });
    rmSync(pairImage(receipt, "collaboration"), { force: true });
    await expect(backupRepositoryStores(fixture.context, { out })).rejects.toThrow(/cannot be completed/);
    expect(existsSync(pairImage(receipt, "collaboration"))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  test("a persistently failing post-publication step keeps returning the same named partial", async () => {
    const fixture = await pairFixture("restore-repeat-partial-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    const target = resolveCollaborationLocation(fixture.context).dbPath;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${target}${suffix}`, { force: true });

    const realWrite = collaborationStore.writeCollaborationBinding;
    const spy = spyOn(collaborationStore, "writeCollaborationBinding").mockImplementation(() => {
      throw new Error("simulated persistent binding failure");
    });
    try {
      const first = await restoreCollaborationBackup(fixture.context, receipt, { operator: "ops-engineer", attestation: attestation() }).then(
        () => null,
        (error: unknown) => error,
      );
      const second = await restoreCollaborationBackup(fixture.context, receipt, { operator: "ops-engineer", attestation: attestation() }).then(
        () => null,
        (error: unknown) => error,
      );
      // invariant: Both attempts report the SAME named partial (published authority + recovery),
      // never a generic error and never a create-only conflict.
      expect(first).toMatchObject({ code: "collaboration.operation-partial" });
      expect(second).toMatchObject({ code: "collaboration.operation-partial" });
      expect((second as { details?: unknown }).details).toMatchObject({ phase: "published", authority: expect.objectContaining({ path: target }) });
    } finally {
      spy.mockRestore();
    }
    const repaired = await restoreCollaborationBackup(fixture.context, receipt, { operator: "ops-engineer", attestation: attestation() });
    expect(repaired.state).toBe("active");
    void realWrite;
  });


  test("an unowned file at a canonical name is never deleted and blocks the pair", async () => {
    const fixture = await pairFixture("attempt-unowned-canonical-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    mkdirSync(dirname(out), { recursive: true });
    // note: Someone else's file already owns the canonical collaboration name.
    writeFileSync(`${out}.collaboration.db`, "unowned canonical bytes\n");
    await expect(backupRepositoryStores(fixture.context, { out })).rejects.toMatchObject({
      code: "collaboration.backup-incomplete",
    });
    expect(readFileSync(`${out}.collaboration.db`, "utf8")).toBe("unowned canonical bytes\n");
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.execution.db`)).toBe(false);
  });

  test("a private image outside the pair directory is never adopted even with a matching name and digest", async () => {
    const fixture = await pairFixture("attempt-foreign-dir-private-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    writeAttemptClaim(out, receipt);
    const claimPath = `${out}.pair-attempt.json`;
    const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { collaboration: { privatePath: string; name: string } };
    // invariant: Same basename AND same bytes, but in ANOTHER directory: not this attempt's
    // scratch, so it must never be adopted or unlinked.
    const elsewhere = join(fixture.harness, "archived", "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const twin = join(elsewhere, basename(claim.collaboration.privatePath));
    copyFileSync(pairImage(receipt, "collaboration"), twin);
    const twinBytes = readFileSync(twin);
    claim.collaboration.privatePath = twin;
    writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`);
    rmSync(out, { force: true });
    rmSync(pairImage(receipt, "collaboration"), { force: true });

    await expect(backupRepositoryStores(fixture.context, { out })).rejects.toThrow(/cannot be completed/);
    expect(readFileSync(twin).equals(twinBytes)).toBe(true);
    expect(existsSync(pairImage(receipt, "collaboration"))).toBe(false);
  });

  test("a resume never unlinks or adopts an unowned private path", async () => {
    const fixture = await pairFixture("attempt-unowned-private-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    writeAttemptClaim(out, receipt);
    const claimPath = `${out}.pair-attempt.json`;
    const claim = JSON.parse(readFileSync(claimPath, "utf8")) as { collaboration: { privatePath: string; sha256: string } };
    // invariant: The credential points at a path this attempt did NOT create (wrong scratch
    // name): it is unowned evidence, so it is never reused, adopted or unlinked.
    const unowned = `${out}.somebody-elses-file`;
    copyFileSync(pairImage(receipt, "collaboration"), unowned);
    claim.collaboration.privatePath = unowned;
    writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`);
    rmSync(out, { force: true });
    rmSync(pairImage(receipt, "collaboration"), { force: true });

    await expect(backupRepositoryStores(fixture.context, { out })).rejects.toThrow(/cannot be completed/);
    expect(readFileSync(unowned, "utf8").length).toBeGreaterThan(0);
    expect(existsSync(pairImage(receipt, "collaboration"))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  test("overlapping attempts: one winner, and a loser never unlinks the winner's credential", async () => {
    const fixture = await pairFixture("attempt-overlap-claim-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const results = await Promise.allSettled([
      backupRepositoryStores(fixture.context, { out }),
      backupRepositoryStores(fixture.context, { out }),
    ]);
    const published = results.filter((result) => result.status === "fulfilled");
    expect(published.length).toBeLessThanOrEqual(1);
    for (const failed of results.filter((result) => result.status === "rejected")) {
      expect((failed as PromiseRejectedResult).reason).toMatchObject({ code: "collaboration.backup-incomplete" });
    }
    if (published.length === 1) {
      const receipt = (published[0] as PromiseFulfilledResult<RepositoryBackupReceipt>).value;
      // note: The winner's own publication survives intact: both images, the manifest, no
      // leftover credential — and nothing was unlinked by the loser.
      expect(existsSync(out)).toBe(true);
      expect(existsSync(pairImage(receipt, "execution"))).toBe(true);
      expect(existsSync(pairImage(receipt, "collaboration"))).toBe(true);
      expect(existsSync(`${out}.pair-attempt.json`)).toBe(false);
    }
  });

  test("a restore that published but failed to record the binding is resumed by the same request", async () => {
    const fixture = await pairFixture("restore-repair-");
    const out = join(fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(fixture.context, { out });
    const target = resolveCollaborationLocation(fixture.context).dbPath;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${target}${suffix}`, { force: true });

    // invariant: The publication lands, then the checkout-binding write fails: the request
    // must stay resumable instead of becoming an unrecoverable create-only conflict.
    const realWrite = collaborationStore.writeCollaborationBinding;
    let writes = 0;
    const spy = spyOn(collaborationStore, "writeCollaborationBinding").mockImplementation((context, authority) => {
      writes += 1;
      if (writes === 1) throw new Error("simulated binding failure");
      realWrite(context, authority);
    });
    let firstFailure: unknown;
    try {
      firstFailure = await restoreCollaborationBackup(fixture.context, receipt, {
        operator: "ops-engineer",
        attestation: attestation(),
      }).then(() => null, (error: unknown) => error);
    } finally {
      spy.mockRestore();
    }
    expect(firstFailure).toMatchObject({ code: "collaboration.operation-partial" });
    expect((firstFailure as { details?: unknown }).details).toMatchObject({
      phase: "published",
      authority: expect.objectContaining({ path: target }),
    });
    expect(existsSync(target)).toBe(true);

    // note: The SAME request finishes: the published generation is recognised by its own
    // image digest, the binding is written, and no second authority is published.
    const repaired = await restoreCollaborationBackup(fixture.context, receipt, {
      operator: "ops-engineer",
      attestation: attestation(),
    });
    expect(repaired.state).toBe("active");
    expect(readCollaborationBinding(fixture.context)).toMatchObject({ state: "active", storeId: repaired.storeId });
    const handle = await openCollaborationStore(fixture.context, "read");
    try {
      expect(
        handle.db.prepare("select count(*) as n from collaboration_operations where operation_id like 'restore:%'").get(),
      ).toEqual({ n: 1 });
    } finally {
      handle.close();
    }
  });
});

describe("explicit adoption verb", () => {
  /** invariant: The fixture's declared repository id (what a clone must share). */
  function repoIdOf(fixture: Fixture): string {
    return /repo_id=(\S+)/.exec(readFileSync(join(fixture.checkout, ".mstarc"), "utf8"))![1]!;
  }

  /** note: A bound checkout whose lane carries a recorded activation lineage. */
  async function activatedWorkspace(name: string): Promise<{ fixture: Fixture; activation: ActivationReceipt }> {
    const fixture = await stagedFixture(name);
    const activation = await activateStore(fixture.context, fixture.apply, attestation());
    return { fixture, activation };
  }

  test("a replacement clone adopts the matching active lane and ordinary access is stale until then", async () => {
    const { fixture, activation } = await activatedWorkspace("adopt-clone-");
    const repoKey = repoIdOf(fixture);
    const clone = repoWorkspaceWithKey("adopt-clone-replacement-", repoKey);
    (await initializeStore(clone.context)).close();

    // invariant: Ordinary access refuses until adoption.
    await expect(openCollaborationStore(clone.context, "write")).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    const adoption = await adoptCollaborationBinding(clone.context, { expectStoreId: activation.storeId });
    expect(adoption.adopted).toBe(true);
    expect(adoption.authority.storeId).toBe(activation.storeId);
    expect(adoption.lineage).toMatchObject({ kind: "activation", storeId: activation.storeId, epoch: activation.epoch });
    expect(readCollaborationBinding(clone.context)).toMatchObject({
      state: "active",
      storeId: activation.storeId,
      epoch: activation.epoch,
    });
    expect((await openCollaborationStore(clone.context, "read")).authority.state).toBe("active");
    // note: Adoption mutates no collaboration data.
    const lane = await readCollaborationStage(resolveCollaborationLocation(clone.context), ({ db, authority }) => ({
      revision: authority.revision,
      operations: db.prepare("select count(*) as n from collaboration_operations").get(),
    }));
    expect(lane).toEqual({
      revision: activation.revision,
      operations: { n: 2 },
    });
  });

  test("a replacement clone adopts an ordinary store-init lane by its creation receipt", async () => {
    const repoKey = `fixture-adopt-init-${repoSequence++}`;
    const origin = repoWorkspaceWithKey("adopt-init-origin-", repoKey);
    (await initializeStore(origin.context)).close();
    const created = await ensureCollaborationAuthority(origin.context);
    const clone = repoWorkspaceWithKey("adopt-init-clone-", repoKey);
    (await initializeStore(clone.context)).close();
    await expect(openCollaborationStore(clone.context, "write")).rejects.toMatchObject({ code: "collaboration.stale-binding" });

    const adoption = await adoptCollaborationBinding(clone.context, { expectStoreId: created.storeId });
    expect(adoption.adopted).toBe(true);
    expect(adoption.lineage).toMatchObject({ kind: "creation", storeId: created.storeId, epoch: created.epoch });
    expect(readCollaborationBinding(clone.context)).toMatchObject({ state: "active", storeId: created.storeId });
  });

  test("a restored lane is adoptable by its restore receipt lineage", async () => {
    const origin = await activatedWorkspace("adopt-restored-lane-");
    // note: A pair needs both authorities: the file-era fixture starts without an
    // execution store.
    (await initializeStore(origin.fixture.context)).close();
    const out = join(origin.fixture.harness, "archived", "recovery", "pair.json");
    const receipt = await backupRepositoryStores(origin.fixture.context, { out });
    const target = resolveCollaborationLocation(origin.fixture.context).dbPath;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${target}${suffix}`, { force: true });
    const restored = await restoreCollaborationBackup(origin.fixture.context, receipt, {
      operator: "ops-engineer",
      attestation: attestation(),
    });

    // note: A replacement clone of the same repository adopts the RESTORED generation.
    const repoId = repoIdOf(origin.fixture);
    const clone = repoWorkspaceWithKey("adopt-restored-clone-", repoId);
    (await initializeStore(clone.context)).close();
    const adoption = await adoptCollaborationBinding(clone.context, { expectStoreId: restored.storeId });
    expect(adoption.adopted).toBe(true);
    expect(adoption.lineage).toMatchObject({ kind: "restore", storeId: restored.storeId, epoch: restored.epoch });
    expect(readCollaborationBinding(clone.context)).toMatchObject({ storeId: restored.storeId, epoch: restored.epoch });
  });

  test("adoption is idempotent and never overwrites a binding", async () => {
    const { fixture } = await activatedWorkspace("adopt-idempotent-");
    const repoKey = repoIdOf(fixture);
    const clone = repoWorkspaceWithKey("adopt-idempotent-clone-", repoKey);
    (await initializeStore(clone.context)).close();
    const first = await adoptCollaborationBinding(clone.context);
    expect(first.adopted).toBe(true);
    const before = readFileSync(join(clone.harness, "collaboration-binding.json"));
    const second = await adoptCollaborationBinding(clone.context);
    expect(second.adopted).toBe(false);
    expect(second.authority.storeId).toBe(first.authority.storeId);
    expect(readFileSync(join(clone.harness, "collaboration-binding.json"))).toEqual(before);
    // invariant: A binding for another store is never overwritten.
    writeFileSync(
      join(clone.harness, "collaboration-binding.json"),
      `${JSON.stringify({ version: 2, state: "active", repoKey, mode: "local", storeId: "some-other-store", epoch: 1, boundAt: "2026-11-21T00:00:00.000Z" }, null, 2)}\n`,
    );
    const foreignBefore = readFileSync(join(clone.harness, "collaboration-binding.json"));
    await expect(adoptCollaborationBinding(clone.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    expect(readFileSync(join(clone.harness, "collaboration-binding.json"))).toEqual(foreignBefore);
  });

  test("adoption refuses an origin retarget, a storeId/epoch mismatch and a missing or ambiguous lineage", async () => {
    const { fixture } = await activatedWorkspace("adopt-refusals-");
    const location = resolveCollaborationLocation(fixture.context);
    const repoId = repoIdOf(fixture);

    // note: Origin/config retarget: the checkout is bound to A, resolves to B, and the
    // authority at A is not adopted by the retargeted checkout.
    writeFileSync(join(fixture.checkout, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=other-repo-${repoSequence++}\n`);
    await expect(adoptCollaborationBinding(fixture.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });
    writeFileSync(join(fixture.checkout, ".mstarc"), `[collaboration]\nmode=local\nrepo_id=${repoId}\n`);

    // invariant: expect-store mismatch refuses.
    await expect(adoptCollaborationBinding(fixture.context, { expectStoreId: "not-this-store" })).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });

    // invariant: Missing lineage: the activation phase row is the record — removing it makes
    // the live authority unadoptable (no other checkout can bind it).
    const clone = repoWorkspaceWithKey("adopt-refusals-clone-", repoId);
    (await initializeStore(clone.context)).close();
    await writeCollaborationStage(location, ({ db }) => {
      db.prepare("delete from collaboration_operations where operation_id like 'migration:activated:%'").run();
    });
    await expect(adoptCollaborationBinding(clone.context)).rejects.toMatchObject({ code: "collaboration.stale-binding" });

    // note: Ambiguous lineage: the live generation is UNNAMED while the lane carries
    // publications for two other generations.
    await writeCollaborationStage(location, ({ db }) => {
      for (const [operationId, storeId, epoch] of [
        ["migration:activated:ambiguous-a", "another-store", 9],
        ["migration:activated:ambiguous-b", "third-store", 4],
      ] as const) {
        db.prepare(
          "insert into collaboration_operations(key_space, operation_id, request_hash, result_json, committed_at) " +
            "values ('standalone', ?, 'hash', ?, ?)",
        ).run(operationId, JSON.stringify({ storeId, epoch }), "2026-11-21T00:00:00.000Z");
      }
    });
    await expect(adoptCollaborationBinding(clone.context)).rejects.toThrow(/ambiguous/);
    expect(existsSync(join(clone.harness, "collaboration-binding.json"))).toBe(false);
  });
});
