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
  StoreError,
  StoreMigrationError,
  applyStoreMigration,
  initializeStore,
  planStoreMigration,
  resolveProcessHarnessDir,
  upgradeStore,
  type MigrationManifest,
  type MigrationReceipt,
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
    return `a store already exists at ${join(harnessDir, "store.db")} — migrate or activate instead of initializing`;
  }
  const projectsDir = join(harnessDir, "projects");
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (existsSync(join(projectsDir, entry.name, "residuals.json"))) {
        return `legacy residual register found at projects/${entry.name}/residuals.json — use the staged migration, not "store init"`;
      }
    }
  }
  // A maintained iterations index is a catalog source of the legacy workspace.
  const iterationsReadme = join(harnessDir, "iterations", "README.md");
  if (existsSync(iterationsReadme)) {
    return `maintained catalog index found at iterations/README.md — use the staged migration, not "store init"`;
  }
  // Registered active workflows are execution authority of an existing workspace.
  const statusPath = join(harnessDir, "status.json");
  if (existsSync(statusPath)) {
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workflows?: unknown };
      if (Array.isArray(status.workflows) && status.workflows.length > 0) {
        return `${status.workflows.length} registered workflow(s) in status.json — this is not a genuinely empty workspace`;
      }
    } catch {
      return `status.json at ${statusPath} is unreadable — this is not a genuinely empty workspace`;
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
    storeRevision: receipt.storeRevision,
    appliedAt: receipt.appliedAt,
  };
  if (json) console.log(JSON.stringify({ ok: true, data }));
  else {
    console.log(`store migrate apply: ${receipt.replayed ? "REPLAY (no writes)" : "applied"} receipt #${receipt.receiptId} ` + `(${receipt.counts.issues} issue(s): ${receipt.counts.open} open / ${receipt.counts.closed} closed, catalog ${receipt.counts.catalogEntities})`);
    for (const entry of receipt.issueIds) {
      console.log(`  ${entry.issueId} <- ${entry.source.project}/${entry.source.bucket}/${entry.source.entryId}`);
    }
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
        "legacy workspace — legacy residual registers, a maintained iterations index, registered workflows, or a prior " +
        "DB — with store.already-exists; an existing workspace migrates instead (store migrate)",
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
      "Staged issue/catalog migration (contract §7). Default: read-only preview producing the reviewable manifest " +
        "(byte digests, source-set digest, mappings, unresolved rows, catalog conflicts, retirement sections) — no DB, " +
        "no receipt. --apply --manifest <path>: the explicit reviewed apply — one issue/catalog/receipt transaction, " +
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
}
