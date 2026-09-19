/**
 * CLI `mstar store` — the store lifecycle family over C1's engine primitives
 * and the G1a/G1b migration transport (issue contract §2/§7).
 *
 * Verbs: init | upgrade | migrate.
 * - `store init` is the create-only initializer for a GENUINELY EMPTY
 *   workspace. The actual initializer refuses EVERY existing legacy workspace
 *   — legacy residual registers, a maintained iterations index, registered
 *   active workflows, or a prior DB — not merely a nonempty database; an
 *   existing workspace migrates instead.
 * - `store upgrade` applies pending schema migrations over the engine's
 *   atomic batch primitive (backup/quiesce remain the caller's obligation).
 * - `store migrate` defaults to the read-only preview; `--apply --manifest
 *   <path>` is the explicit reviewed apply (staged, one transaction, receipt).
 *
 * Help owns flags. Envelope on stdout with --json: `{ok:true,data}` /
 * `{ok:false,code,message}`. Exit 0 success, 1 domain/runtime/IO refusal,
 * 2 usage.
 */
import { Command } from "commander";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import pc from "picocolors";
import {
  SddScriptError,
  StoreActivationError,
  StoreError,
  StoreMigrationError,
  activateStore,
  activationReceiptFor,
  appliedReceiptFor,
  applyStoreMigration,
  backupStore,
  initializeStore,
  planStoreMigration,
  resolveProcessHarnessDir,
  retireStoreSources,
  upgradeStore,
  type ActivationAttestation,
  type ActivationReceipt,
  type BackupReceipt,
  type MigrationManifest,
  type MigrationReceipt,
  type RetirementReceipt,
  type StoreContext,
} from "@mstar-harness/engine";

type StoreCliOptions = Record<string, string | boolean | undefined>;

function usage(message: string): never {
  throw new SddScriptError(message, 2);
}

function storeContextOf(options: StoreCliOptions): StoreContext {
  const override = typeof options.harness === "string" ? options.harness : undefined;
  const resolved = resolveProcessHarnessDir(process.cwd(), override);
  const harnessDir = resolved ?? (override !== undefined ? resolve(override) : process.cwd());
  return { harnessDir };
}

function readJsonFile(path: string, what: string): unknown {
  if (!isAbsolute(path)) usage(`--manifest must be an absolute path`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    usage(`--manifest could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    usage(`--manifest is not valid JSON (${what})`);
  }
}

/**
 * The legacy-workspace guard for `store init` (contract §2: a genuinely empty
 * workspace holds no legacy registers, maintained catalog indexes, active
 * workflows or prior DB). Returns the first refusing fact, or null.
 */
export function findLegacyWorkspaceFact(harnessDir: string): string | null {
  if (existsSync(join(harnessDir, "store.db"))) {
    return `a store already exists at ${join(harnessDir, "store.db")} \u2014 migrate or activate instead of initializing`;
  }
  const projectsDir = join(harnessDir, "projects");
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (existsSync(join(projectsDir, entry.name, "residuals.json"))) {
        return `legacy residual register found at projects/${entry.name}/residuals.json \u2014 use the staged migration, not "store init"`;
      }
    }
  }
  // A maintained iterations index is a catalog source of the legacy workspace.
  const iterationsReadme = join(harnessDir, "iterations", "README.md");
  if (existsSync(iterationsReadme)) {
    return `maintained catalog index found at iterations/README.md \u2014 use the staged migration, not "store init"`;
  }
  // Registered active workflows are execution authority of an existing workspace.
  const statusPath = join(harnessDir, "status.json");
  if (existsSync(statusPath)) {
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workflows?: unknown };
      if (Array.isArray(status.workflows) && status.workflows.length > 0) {
        return `${status.workflows.length} registered workflow(s) in status.json \u2014 this is not a genuinely empty workspace`;
      }
    } catch {
      return `status.json at ${statusPath} is unreadable \u2014 this is not a genuinely empty workspace`;
    }
  }
  return null;
}

function printEnvelope(json: boolean, payload: Record<string, unknown>): void {
  console.log(JSON.stringify(json ? payload : payload.data, null, json ? undefined : 2));
}

function failStore(operation: string, error: unknown, json: boolean): void {
  if (error instanceof SddScriptError) {
    if (json) console.log(JSON.stringify({ ok: false, code: "usage", message: error.message, details: { operation } }));
    else console.error(pc.red(`store ${operation}: ${error.message}`));
    process.exitCode = error.exitCode;
    return;
  }
  if (error instanceof StoreActivationError) {
    if (json) console.log(JSON.stringify({ ok: false, code: error.code, message: error.message, details: { operation } }));
    else console.error(pc.red(`store ${operation}: ${error.message}`));
    process.exitCode = 1;
    return;
  }
  if (error instanceof StoreMigrationError || error instanceof StoreError) {
    if (json) console.log(JSON.stringify({ ok: false, code: error.code, message: error.message, details: { operation } }));
    else console.error(pc.red(`store ${operation}: ${error.message}`));
    process.exitCode = 1;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ ok: false, code: "store.internal-error", message, details: { operation } }));
  else console.error(pc.red(`store ${operation} failed: ${message}`));
  process.exitCode = 1;
}

async function runInit(options: StoreCliOptions, json: boolean): Promise<void> {
  const context = storeContextOf(options);
  const fact = findLegacyWorkspaceFact(context.harnessDir);
  if (fact !== null) {
    throw new StoreError("store.already-exists", `${fact}. Nothing was created.`);
  }
  const handle = await initializeStore(context);
  try {
    const data = { storeId: handle.storeId, epoch: handle.epoch, schemaVersion: handle.schemaVersion, authorityState: "active" };
    if (json) console.log(JSON.stringify({ ok: true, data }));
    else console.log(`store init: created an active empty store at ${join(context.harnessDir, "store.db")} (schema ${handle.schemaVersion}, epoch ${handle.epoch})`);
  } finally {
    handle.close();
  }
}

async function runUpgrade(options: StoreCliOptions, json: boolean): Promise<void> {
  const context = storeContextOf(options);
  const result = await upgradeStore(context);
  if (json) console.log(JSON.stringify({ ok: true, data: result }));
  else console.log(`store upgrade: schema version ${result.schemaVersion} (nothing left to apply)`);
}

async function runMigrate(options: StoreCliOptions, json: boolean): Promise<void> {
  const context = storeContextOf(options);
  const apply = options.apply === true;
  const manifestPath = typeof options.manifest === "string" ? options.manifest : undefined;
  if (apply && manifestPath === undefined) {
    usage("the reviewed apply requires the reviewed manifest: --apply --manifest <path>");
  }
  if (!apply && manifestPath !== undefined) {
    usage("--manifest is only meaningful with --apply");
  }
  if (!apply) {
    // Default: the read-only preview. Creates no DB and no receipt (§7).
    const manifest = await planStoreMigration(context);
    const out = typeof options.out === "string" ? options.out : undefined;
    if (out !== undefined) {
      const target = isAbsolute(out) ? out : resolve(process.cwd(), out);
      writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const summary = {
      controlRoot: manifest.controlRoot,
      sourceSetDigest: manifest.sourceSetDigest,
      sources: manifest.sources.map((source) => ({ project: source.project, relativePath: source.relativePath, entryCount: source.entryCount, sha256: source.sha256 })),
      mappings: manifest.mappings.length,
      unresolved: manifest.unresolved.length,
      catalogConflicts: manifest.catalog.conflicts.length,
      blocksApply: manifest.blocksApply,
      manifestFile: out !== undefined ? (isAbsolute(out) ? out : resolve(process.cwd(), out)) : undefined,
      nextStep: manifest.blocksApply
        ? "resolve the unresolved mappings / catalog conflicts in review, then re-preview"
        : "have the manifest reviewed, then apply with: store migrate --apply --manifest <path>",
    };
    if (json) console.log(JSON.stringify({ ok: true, data: summary }));
    else {
      console.log(`store migrate preview: ${summary.mappings} mapped row(s) across ${summary.sources.length} register(s), ` + `${summary.unresolved} unresolved, ${summary.catalogConflicts} catalog conflict(s)`);
      for (const source of summary.sources) {
        console.log(`  ${source.project} ${source.relativePath}: ${source.entryCount} entr(ies) ${source.sha256.slice(0, 12)}`);
      }
      console.log(summary.nextStep);
    }
    return;
  }

  // Explicit reviewed apply: the reviewed manifest file is the confirmation.
  const parsed = readJsonFile(manifestPath!, "MigrationManifest") as MigrationManifest;
  if (parsed === null || typeof parsed !== "object" || parsed.version === undefined) {
    usage("--manifest does not carry a MigrationManifest (run the preview and review it first)");
  }
  const receipt: MigrationReceipt = await applyStoreMigration(context, parsed);
  const data = {
    receiptId: receipt.receiptId,
    manifestHash: receipt.manifestHash,
    phase: receipt.phase,
    replayed: receipt.replayed,
    counts: receipt.counts,
    issueIds: receipt.issueIds,
    historyRows: receipt.historyRows,
    storeRevision: receipt.storeRevision,
    appliedAt: receipt.appliedAt,
  };
  if (json) console.log(JSON.stringify({ ok: true, data }));
  else {
    console.log(`store migrate apply: ${receipt.replayed ? "REPLAY (no writes)" : "applied"} receipt #${receipt.receiptId} ` + `(${receipt.counts.issues} issue(s): ${receipt.counts.open} open / ${receipt.counts.closed} closed, catalog ${receipt.counts.catalogEntities})`);
    for (const entry of receipt.issueIds) {
      console.log(`  ${entry.issueId} <- ${entry.source.project}/${entry.source.bucket}/${entry.source.entryId}`);
    }
    if (receipt.historyRows.length > 0) {
      console.log(`  + ${receipt.historyRows.length} history/excluded row(s) carried on the receipt without an issue (reviewed rationale on each)`);
      for (const row of receipt.historyRows) {
        console.log(`  ~ ${row.classification} ${row.source.project}/${row.source.bucket}/${row.source.entryId}: ${row.rationale}`);
      }
    }
  }
}

function writeJsonOut(out: string | undefined, value: unknown): string | undefined {
  if (out === undefined) return undefined;
  const target = isAbsolute(out) ? out : resolve(process.cwd(), out);
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

/** The reviewed manifest JSON for the barrier verbs (the confirmation artifact, as with --apply). */
function reviewedManifest(options: StoreCliOptions): MigrationManifest {
  const path = typeof options.manifest === "string" ? options.manifest : undefined;
  if (path === undefined) usage("this verb operates on the reviewed manifest: --manifest <path>");
  const parsed = readJsonFile(path, "MigrationManifest") as MigrationManifest;
  if (parsed === null || typeof parsed !== "object" || parsed.version === undefined) {
    usage("--manifest does not carry a MigrationManifest (run the preview and review it first)");
  }
  return parsed;
}

async function runBackup(options: StoreCliOptions, json: boolean): Promise<void> {
  const context = storeContextOf(options);
  const out = typeof options.out === "string" ? options.out : undefined;
  const receipt: BackupReceipt = await backupStore(context, out === undefined ? {} : { out });
  const data = { ...receipt, out };
  if (json) console.log(JSON.stringify({ ok: true, data }));
  else {
    console.log(
      `store backup: ${receipt.backupPath} (store_id ${receipt.storeId}, epoch ${receipt.epoch}, revision ${receipt.revision}, ` +
        `${receipt.counts.issues} issue(s), ${receipt.counts.catalogEntities} catalog entit(ies)` +
        `${receipt.walPending ? ", committed WAL frames included" : ""})`,
    );
  }
}

async function runActivate(options: StoreCliOptions, json: boolean): Promise<void> {
  const context = storeContextOf(options);
  const manifest = reviewedManifest(options);
  const attestationPath = typeof options.attestation === "string" ? options.attestation : undefined;
  if (attestationPath === undefined) {
    usage("the activation barrier requires the operator attestation: --attestation <path> (attestedAt, operator, consumers, stoppedSessions)");
  }
  const attestation = readJsonFile(attestationPath, "ActivationAttestation") as ActivationAttestation;
  const applyReceipt: MigrationReceipt = await appliedReceiptFor(context, manifest);
  const receipt: ActivationReceipt = await activateStore(context, applyReceipt, attestation);
  const out = writeJsonOut(typeof options.out === "string" ? options.out : undefined, receipt);
  const data = { ...receipt, out };
  if (json) console.log(JSON.stringify({ ok: true, data }));
  else {
    console.log(
      `store activate: ${receipt.replayed ? "ALREADY ACTIVE (no epoch bump)" : "activated"} receipt #${receipt.receiptId} ` +
        `(authority epoch ${receipt.previousEpoch} -> ${receipt.epoch}, ${receipt.attestation.consumers.length} consumer(s), ` +
        `${receipt.attestation.stoppedSessions.length} stopped session(s), backup ${receipt.backup.backupPath})`,
    );
    console.log("The store is now the sole issue/catalog authority; the legacy registers are superseded history.");
  }
}

async function runRetire(options: StoreCliOptions, json: boolean): Promise<void> {
  const context = storeContextOf(options);
  const manifest = reviewedManifest(options);
  const activation: ActivationReceipt = await activationReceiptFor(context, manifest);
  const receipt: RetirementReceipt = await retireStoreSources(context, activation);
  const out = writeJsonOut(typeof options.out === "string" ? options.out : undefined, receipt);
  const data = { ...receipt, out };
  if (json) console.log(JSON.stringify({ ok: true, data }));
  else {
    console.log(
      `store retire: ${receipt.replayed ? "ALREADY RETIRED (no file changes)" : "retired"} receipt #${receipt.receiptId} ` +
        `(${receipt.registers.length} register(s), ${receipt.sections.length} index section(s)` +
        `${receipt.resumed ? ", resumed from the recorded ledger" : ""})`,
    );
    console.log(`  archive: ${receipt.archiveDir}`);
    console.log(`  marker:  ${receipt.markerPath} (historical migration input, not a rollback path)`);
  }
}

export function registerStoreCommands(program: Command): void {
  const store = program
    .command("store")
    .description(
      "Issue-store lifecycle (engine-backed): create-only init for a genuinely empty workspace, atomic schema upgrade, " +
        "and the staged issue/catalog migration (preview by default, explicit reviewed --apply). " +
        "Exit 0 success, 1 domain/runtime/IO refusal, 2 usage",
    );

  store
    .command("init")
    .description(
      "Create-only initializer for a GENUINELY EMPTY workspace (active empty store, epoch 1). Refuses every existing " +
        "legacy workspace \u2014 legacy residual registers, a maintained iterations index, registered workflows, or a prior " +
        "DB \u2014 with store.already-exists; an existing workspace migrates instead (store migrate)",
    )
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (options: StoreCliOptions) => {
      const json = options.json === true;
      try {
        await runInit(options, json);
      } catch (error) {
        failStore("init", error, json);
      }
    });

  store
    .command("upgrade")
    .description(
      "Apply pending schema migrations to an existing store in one atomic batch (idempotent when current). A " +
        "SQLite-consistent backup and quiesced consumers remain the operator's obligation",
    )
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (options: StoreCliOptions) => {
      const json = options.json === true;
      try {
        await runUpgrade(options, json);
      } catch (error) {
        failStore("upgrade", error, json);
      }
    });

  store
    .command("migrate")
    .description(
      "Staged issue/catalog migration (contract \u00a77). Default: read-only preview producing the reviewable manifest " +
        "(byte digests, source-set digest, mappings, unresolved rows, catalog conflicts, retirement sections) \u2014 no DB, " +
        "no receipt. --apply --manifest <path>: the explicit reviewed apply \u2014 one issue/catalog/receipt transaction, " +
        "persistent ID mapping, source-drift refusal, staged store (ordinary mutations stay refused until activation)",
    )
    .option("--apply", "Explicit reviewed apply using the reviewed --manifest file")
    .option("--manifest <path>", "Absolute path of the reviewed MigrationManifest JSON (required with --apply)")
    .option("--out <path>", "Preview only: write the full manifest JSON to this path for review")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (options: StoreCliOptions) => {
      const json = options.json === true;
      try {
        await runMigrate(options, json);
      } catch (error) {
        failStore("migrate", error, json);
      }
    });

  store
    .command("backup")
    .description(
      "Write a quiesced, SQLite-consistent VACUUM INTO recovery point and verify the copy by reopening it read-only. The " +
        "receipt records the store identity (store_id, epoch, revision, catalog revision, authority state, schema version) " +
        "and the row counts verified in the copy; committed WAL frames are included. Refuses to overwrite an existing target",
    )
    .option("--out <path>", "Backup target (default: <harness>/archived/store-migration/backups/<store>-e<epoch>-r<revision>.db)")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (options: StoreCliOptions) => {
      const json = options.json === true;
      try {
        await runBackup(options, json);
      } catch (error) {
        failStore("backup", error, json);
      }
    });

  store
    .command("activate")
    .description(
      "The activation barrier (contract \u00a77, D19): make the migrated store the sole issue/catalog authority. Requires the " +
        "reviewed --manifest applied receipt to be the FINAL one (unchanged register bytes and catalog digests, no " +
        "post-apply store change), the current-coordinator + installed-consumer --attestation (entrypoints, versions, " +
        "quiesced sessions, approving operator; never session credentials), and takes a verified VACUUM INTO backup. The " +
        "state flip, the epoch increment and the receipt commit in one transaction. Ordinary mutations work only afterwards",
    )
    .option("--manifest <path>", "Absolute path of the reviewed MigrationManifest JSON that was applied (required)")
    .option("--attestation <path>", "Absolute path of the operator attestation JSON (required)")
    .option("--out <path>", "Write the activation receipt JSON to this path")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (options: StoreCliOptions) => {
      const json = options.json === true;
      try {
        await runActivate(options, json);
      } catch (error) {
        failStore("activate", error, json);
      }
    });

  store
    .command("retire")
    .description(
      "Retire the exact reviewed legacy registers and index sections of an activated store (contract \u00a77). Moves the bytes " +
        "into <harness>/archived/store-migration/<activation-receipt-id>/ under a resumable per-item ledger plus a marker " +
        "naming the successor DB and receipt; mixed-content index files lose only their reviewed section lines. Revalidates " +
        "the active identity, epoch, exact source hashes and catalog digests first; a late old-format write refuses " +
        "store.legacy-write-detected and is never deleted. A crash resumes from the ledger to the recorded bytes/sections",
    )
    .option("--manifest <path>", "Absolute path of the reviewed MigrationManifest JSON that was activated (required)")
    .option("--out <path>", "Write the retirement receipt JSON to this path")
    .option("--harness <path>", "Harness dir override")
    .option("--json", "Machine-readable envelope on stdout")
    .action(async (options: StoreCliOptions) => {
      const json = options.json === true;
      try {
        await runRetire(options, json);
      } catch (error) {
        failStore("retire", error, json);
      }
    });
}
