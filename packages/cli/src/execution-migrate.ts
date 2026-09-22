/**
 * CLI `mstar store execution` — the EXECUTION operator family (phase 2b
 * execution contract §3.2/§6/§7) over C3's real migration APIs and the §8
 * whole-store recovery.
 *
 * Verbs: `preview | apply | activate | retire | abort | restore-preview |
 * restore | export`.
 *
 * This module is a transport and nothing else: it validates the operator's
 * flags, hands the exact reviewed documents to the engine's own functions and
 * reports the engine's receipt or refusal. It carries no migration logic, no
 * fallback and no second authority:
 *
 * - `preview` is read-only discovery (§6 item 1) plus, when asked, §4.2 coverage
 *   collection; it creates no DB row, no receipt and no source byte.
 * - `apply`/`activate`/`retire`/`abort` forward the reviewed manifest identity
 *   (and for `apply`, the reviewed coverage, the verified recovery-point receipt
 *   and the manifest document itself) into `applyExecutionMigration`,
 *   `activateExecutionMigration`, `retireExecutionSources` and
 *   `abortExecutionMigration`. The activation barrier re-reads its recorded
 *   manifest; nothing here ever activates from a caller-supplied document.
 * - `restore-preview`/`restore` forward into `previewExecutionRestore` and
 *   `restoreExecutionBackup`; the restore takes the EXACT approved `lossDigest`
 *   and there is no default yes.
 * - `export` forwards into `exportExecutionState`, whose artifact holds no
 *   session identity and which no writer accepts.
 *
 * Route discipline (§3.2): this family is the EXECUTION route. The issue/catalog
 * activation stays `mstar store activate`, which this module never calls and
 * never aliases — a store activated for issue/catalog is not an activated
 * execution authority, and `store execution activate` is the execution barrier.
 * Creating these verbs is not permission to run them against this control root.
 *
 * Help owns flags. Envelope on stdout with `--json`:
 * `{ok:true,route:"execution",operation,data}` /
 * `{ok:false,route:"execution",operation,code,message}`.
 * Exit 0 committed/read success, 1 domain/runtime/IO refusal, 2 usage.
 */
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  SddScriptError,
  abortExecutionMigration,
  activateExecutionMigration,
  applyExecutionMigration,
  collectExecutionCoverage,
  executionManifestHash,
  exportExecutionState,
  previewExecutionMigration,
  previewExecutionRestore,
  restoreExecutionBackup,
  retireExecutionSources,
  type ActivationAttestation,
  type BackupReceipt,
  type ExecutionCoverageSet,
  type ExecutionManifest,
  type ExecutionManifestDocument,
  type ExecutionRecoveryPreview,
  type StoreContext,
} from "@mstar-harness/engine";
import { requireExecutionRoot, requireFlagValue, requireJsonFile } from "./execution-session";

/** The commander options bag of every verb in this family. */
type ExecutionMigrateOptions = Record<string, string | boolean | undefined>;

/** A usage-class refusal: input shape, never a domain verdict (exit 2). */
function usage(message: string): never {
  throw new SddScriptError(message, 2);
}

/** One `--flag` value from the options bag, or undefined when the flag is absent. */
function stringFlag(options: ExecutionMigrateOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * An OPTIONAL path flag. Every path of this family is absolute; a relative one
 * is refused as usage instead of being silently resolved against the caller's
 * cwd, and the received value never reaches the diagnostic.
 */
function optionalAbsolutePath(raw: string | undefined, flag: string, verb: string, what: string): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!isAbsolute(raw)) {
    usage(`${flag} must be an absolute path (${what}) \u2014 the received value is not absolute and is not echoed in this diagnostic`);
  }
  return raw;
}

/** A REQUIRED path flag: absent, blank and relative are all usage refusals. */
function requiredAbsolutePath(raw: string | undefined, flag: string, verb: string, what: string): string {
  const value = requireFlagValue(raw, flag, verb, what);
  if (!isAbsolute(value)) {
    usage(`${flag} must be an absolute path (${what}) \u2014 the received value is not absolute and is not echoed in this diagnostic`);
  }
  return value;
}

/** The control root this invocation addresses: an absolute `--harness`, or the carrying cwd. */
function executionContextOf(options: ExecutionMigrateOptions, verb: string): StoreContext {
  return { harnessDir: requireExecutionRoot(stringFlag(options, "harness"), verb) };
}

/** Write one JSON artifact an operator reviews next (the path is already validated absolute). */
function writeJsonArtifact(path: string | undefined, value: unknown): string | undefined {
  if (path === undefined) return undefined;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/** Write one text artifact verbatim (the diagnostic export is canonical JSON, not a re-encoding). */
function writeTextArtifact(path: string | undefined, text: string): string | undefined {
  if (path === undefined) return undefined;
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
  return path;
}

function printExecutionData(operation: string, data: unknown, json: boolean, human: readonly string[]): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, route: "execution", operation, data }));
    return;
  }
  for (const line of human) console.log(line);
}

/** The engine's stable refusal namespaces: a coded error of these is a domain refusal (exit 1). */
const REFUSAL_PREFIXES = ["execution.", "store.", "coordination.", "catalog.", "issue."] as const;

/** The stable code of an engine refusal, read from an untyped thrown value without trusting a shape. */
function refusalCodeOf(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" && code.trim() !== "" ? code : null;
}

/**
 * One failure exit for this family: usage 2 (`SddScriptError`), engine refusal
 * 1 (the stable code is preserved verbatim), anything else internal 1. The
 * operation name travels so a `--json` caller can attribute the refusal without
 * scraping the text.
 */
function failExecutionMigrate(operation: string, error: unknown, json: boolean): void {
  const label = `store execution ${operation}`;
  if (error instanceof SddScriptError) {
    if (json) console.log(JSON.stringify({ ok: false, route: "execution", operation, code: "usage", message: error.message }));
    else console.error(pc.red(`${label}: ${error.message}`));
    process.exitCode = error.exitCode;
    return;
  }
  const code = refusalCodeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code !== null && REFUSAL_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    if (json) console.log(JSON.stringify({ ok: false, route: "execution", operation, code, message }));
    else console.error(pc.red(`${label}: ${message}`));
    process.exitCode = 1;
    return;
  }
  if (json) console.log(JSON.stringify({ ok: false, route: "execution", operation, code: "execution.internal-error", message }));
  else console.error(pc.red(`${label} failed: ${message}`));
  process.exitCode = 1;
}

/** The eight verbs of this family, for the commander-level usage payload below. */
const EXECUTION_MIGRATION_VERBS: Record<string, true> = {
  preview: true,
  apply: true,
  activate: true,
  retire: true,
  abort: true,
  "restore-preview": true,
  restore: true,
  export: true,
};

/**
 * The `--json` failure object for a COMMANDER-level usage error of this family
 * (an unknown flag, a missing option value, an excess argument): those never
 * reach a verb's own action, so the shared tail handler asks this matcher for
 * the same A2 shape every other family emits. `argv` is the whole invocation
 * argv, `message` commander's own text.
 */
export function executionMigrationUsageFailurePayload(argv: readonly string[], message: string): string | null {
  if (argv[2] !== "store" || argv[3] !== "execution") return null;
  const verb = argv.slice(4).find((token) => !token.startsWith("-"));
  return JSON.stringify({
    ok: false,
    route: "execution",
    operation: verb !== undefined && EXECUTION_MIGRATION_VERBS[verb] === true ? verb : "store execution",
    code: "usage",
    message,
  });
}

/* ------------------------------------------------------------------------ *
 * § The reviewed artifacts (every one is an operator input, none is inferred)
 * ------------------------------------------------------------------------ */

/**
 * One operator-supplied JSON document as an untyped field bag. The bag is the
 * only thing this transport trusts: every field it acts on is narrowed by
 * `typeof` below, and the engine owns every deeper verdict. Returning
 * `Record<string, unknown>` keeps each read `unknown` rather than a fabricated
 * shape.
 */
function requireJsonObject(raw: string | undefined, flag: string, verb: string, what: string, hint: string): Record<string, unknown> {
  const parsed = requireJsonFile(raw, flag, verb, what);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    usage(`${verb}: ${flag} must carry one JSON object \u2014 ${hint}`);
  }
  return parsed as Record<string, unknown>;
}

type ReviewedManifest = {
  /** The reviewed document, exactly as the operator approved it. */
  document: ExecutionManifestDocument;
  id: string;
  /** The reviewed content hash, recomputed from the document with the engine's own public function. */
  hash: string;
  /** The store epoch the manifest was reviewed at (the barrier's CAS witness). */
  epoch: number;
  /** §4.2 the discovery scope the manifest records: an absolute inventory path, or null. */
  inventoryPath: string | null;
};

/** The identity fields every manifest verb needs; the engine owns the rest of the document's rules. */
function readManifestDocument(options: ExecutionMigrateOptions, verb: string): ReviewedManifest {
  const document = requireJsonObject(
    stringFlag(options, "manifest"),
    "--manifest",
    verb,
    "reviewed-manifest-json-path",
    "the preview writes that document",
  );
  const version = document["version"];
  if (version !== 1 && version !== 2) {
    usage(
      `${verb}: --manifest carries version ${JSON.stringify(version ?? null)}; only a recorded execution manifest generation is addressable`,
    );
  }
  const id = document["id"];
  if (typeof id !== "string" || id.trim() === "") {
    usage(`${verb}: --manifest carries no manifest identity; the reviewed manifest is addressed by identity, never by a path`);
  }
  const epoch = document["epoch"];
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch <= 0) {
    usage(`${verb}: --manifest carries epoch ${JSON.stringify(epoch ?? null)}, not the positive store epoch it was reviewed at`);
  }
  const inventory = document["inventoryPath"];
  // The document is an operator-reviewed engine artifact whose fields above are
  // now checked; its deeper shape is the engine's own `requireReviewedManifest` /
  // `requireMigrationRecord` verdict, never this transport's.
  const typed = document as unknown as ExecutionManifestDocument;
  return {
    document: typed,
    id: id.trim(),
    hash: executionManifestHash(typed),
    epoch,
    inventoryPath: typeof inventory === "string" && inventory.trim() !== "" ? inventory : null,
  };
}

/**
 * The manifest `apply` stages: the version-2 document the preview produces. A
 * version-1 manifest is history — it carries no surface discovery and therefore
 * no coverage — so staging it is refused here rather than reinterpreted; the
 * recorded v1 staging it may have left is aborted and re-previewed explicitly.
 */
function requireApplyManifest(options: ExecutionMigrateOptions, verb: string): ReviewedManifest & { document: ExecutionManifest } {
  const manifest = readManifestDocument(options, verb);
  if (manifest.document.version !== 2) {
    usage(
      `${verb}: apply requires the version 2 manifest the preview produces; version 1 carries no surface discovery and no coverage, so it is ` +
        "never staged in place \u2014 abort the recorded v1 staging explicitly and re-preview",
    );
  }
  // The version check above is the only narrowing apply needs: the staged
  // document is the version-2 generation the engine's apply declares.
  const document = manifest.document as ExecutionManifest;
  return { ...manifest, document };
}

/**
 * §4.2 the explicit discovery scope. When the reviewed manifest records an
 * inventory, the boundary re-runs that discovery before it writes, so the SAME
 * path is a real parameter: absent or different is refused, never guessed.
 */
function requireReviewedInventory(options: ExecutionMigrateOptions, verb: string, manifest: ReviewedManifest): string | undefined {
  const supplied = optionalAbsolutePath(stringFlag(options, "inventory"), "--inventory", verb, "explicit-operator-inventory");
  if (manifest.inventoryPath === null) {
    if (supplied !== undefined) {
      usage(`${verb}: the reviewed manifest records a control-root-only discovery scope (no inventory), so --inventory does not belong to it`);
    }
    return undefined;
  }
  if (supplied === undefined) {
    usage(
      `${verb} requires --inventory <absolute-path>: this manifest was discovered under the explicit inventory it records, and the boundary ` +
        "re-runs that discovery before it writes \u2014 a different scope is not the reviewed manifest",
    );
  }
  if (supplied !== manifest.inventoryPath) {
    usage(
      `${verb}: --inventory must be the reviewed discovery scope of this manifest \u2014 the received path is not that path and is not echoed ` +
        "in this diagnostic",
    );
  }
  return supplied;
}

/** §4.1 the coverage set that belongs to exactly this manifest. */
function requireCoverageSet(options: ExecutionMigrateOptions, verb: string, manifest: ReviewedManifest): ExecutionCoverageSet {
  const set = requireJsonObject(
    stringFlag(options, "coverage"),
    "--coverage",
    verb,
    "coverage-set-json-path",
    "`preview --coverage-out` writes that set",
  );
  const digest = set["digest"];
  if (set["version"] !== 1 || !Array.isArray(set["receipts"]) || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    usage(`${verb}: --coverage is not an execution coverage set of this protocol version with a canonical digest`);
  }
  const manifestId = set["manifestId"];
  const manifestHash = set["manifestHash"];
  if (manifestId !== manifest.id || manifestHash !== manifest.hash) {
    usage(
      `${verb}: --coverage belongs to manifest ${JSON.stringify(manifestId ?? null)}, not to the reviewed manifest ` +
        `${JSON.stringify(manifest.id)}; coverage is collected for one frozen manifest, so a set for another document is never applied or ` +
        "activated under it",
    );
  }
  // The version, the digest and the manifest binding above are this transport's
  // checks; the receipts themselves are recomputed and closed by the engine.
  return set as unknown as ExecutionCoverageSet;
}

/** The verified recovery-point receipt `apply` stages against (never the image path). */
function requireBackupReceipt(options: ExecutionMigrateOptions, verb: string): BackupReceipt {
  const receipt = requireJsonObject(
    stringFlag(options, "backup"),
    "--backup",
    verb,
    "recovery-point-receipt-json-path",
    "the `data` object of `mstar store backup --json` is that receipt, not the image path and not a hand-written claim",
  );
  if (typeof receipt["backupPath"] !== "string" || receipt["backupPath"].trim() === "") {
    usage(
      `${verb}: --backup must carry the recovery-point RECEIPT document (the \`data\` object of \`mstar store backup --json\`), not the image ` +
        "path and not a hand-written claim; the engine re-verifies the copy behind it before any byte is written",
    );
  }
  // The engine's `assertBackupDescribesStore` is the receipt's shape and byte
  // authority; this transport only insists that a receipt (with its path) was
  // handed over instead of an image path.
  return receipt as unknown as BackupReceipt;
}

/** The operator attestation: its shape authority is the engine's `validateActivationAttestation`. */
function requireAttestation(options: ExecutionMigrateOptions, verb: string): ActivationAttestation {
  const attestation = requireJsonObject(
    stringFlag(options, "attestation"),
    "--attestation",
    verb,
    "attestation-json-path",
    "one ActivationAttestation document is required",
  );
  return attestation as unknown as ActivationAttestation;
}

/** The loss preview `restore` acts on, verbatim as `restore-preview --out` wrote it. */
function requireRecoveryPreview(options: ExecutionMigrateOptions, verb: string): ExecutionRecoveryPreview {
  const preview = requireJsonObject(
    stringFlag(options, "preview"),
    "--preview",
    verb,
    "loss-preview-json-path",
    "`restore-preview --out` writes that preview",
  );
  const lossDigest = preview["lossDigest"];
  if (typeof lossDigest !== "string" || lossDigest.trim() === "") {
    usage(`${verb}: --preview carries no loss digest; it is not the document \`restore-preview\` produced`);
  }
  return preview as unknown as ExecutionRecoveryPreview;
}

/** §7/§8 the loss the operator accepted: the exact digest, with no default yes. */
function requireLossDigest(options: ExecutionMigrateOptions, verb: string): string {
  const value = requireFlagValue(stringFlag(options, "acceptLossDigest"), "--accept-loss-digest", verb, "approved-loss-digest");
  if (!/^[0-9a-f]{64}$/.test(value)) {
    usage(
      `${verb}: --accept-loss-digest must be the exact 64-hex lossDigest of the preview the operator read; a prefix, a hash of something else ` +
        "and a plain acknowledgement are none of them an approval",
    );
  }
  return value;
}

/* ------------------------------------------------------------------------ *
 * § The verb runners
 * ------------------------------------------------------------------------ */

async function runExecutionPreview(options: ExecutionMigrateOptions, json: boolean): Promise<void> {
  const verb = "store execution preview";
  const context = executionContextOf(options, verb);
  const operationId = requireFlagValue(stringFlag(options, "operation"), "--operation", verb, "operation-id");
  const operator = requireFlagValue(stringFlag(options, "operator"), "--operator", verb, "operator-name");
  const inventoryPath = optionalAbsolutePath(stringFlag(options, "inventory"), "--inventory", verb, "explicit-operator-inventory");
  const out = optionalAbsolutePath(stringFlag(options, "out"), "--out", verb, "manifest-json-path");
  const coverageOut = optionalAbsolutePath(stringFlag(options, "coverageOut"), "--coverage-out", verb, "coverage-set-json-path");
  if (coverageOut !== undefined && inventoryPath === undefined) {
    usage(
      `${verb}: --coverage-out requires --inventory \u2014 a manifest discovered under a control-root-only scope has no non-control evidence ` +
        "to collect, so it can never be covered or activated",
    );
  }
  const coverageInventory = coverageOut === undefined ? undefined : inventoryPath;

  const manifest = await previewExecutionMigration({
    context,
    operationId,
    operator,
    ...(inventoryPath === undefined ? {} : { inventoryPath }),
  });
  const manifestFile = writeJsonArtifact(out, manifest);
  let coverage: ExecutionCoverageSet | undefined;
  if (coverageOut !== undefined && coverageInventory !== undefined) {
    coverage = await collectExecutionCoverage({ context, operationId, operator, inventoryPath: coverageInventory, manifest });
    writeJsonArtifact(coverageOut, coverage);
  }

  const data = {
    version: manifest.version,
    manifestId: manifest.id,
    manifestHash: executionManifestHash(manifest),
    storeId: manifest.storeId,
    epoch: manifest.epoch,
    schemaVersion: manifest.schemaVersion,
    root: manifest.root,
    inventoryPath: manifest.inventoryPath ?? null,
    sources: manifest.sources.length,
    surfaces: manifest.surfaces.length,
    deferred: manifest.deferred.length,
    manifestFile: manifestFile ?? null,
    coverageDigest: coverage?.digest ?? null,
    coverageFile: coverage === undefined ? null : coverageOut,
  };
  printExecutionData("preview", data, json, [
    `store execution preview: manifest ${data.manifestId} (${data.surfaces} surface row(s), ${data.deferred} deferred diagnostic(s))`,
    `  store ${data.storeId} epoch ${data.epoch} schema ${data.schemaVersion}; discovery scope ${data.inventoryPath ?? "(control root only)"}`,
    `  manifest hash ${data.manifestHash}`,
    ...(manifestFile === undefined ? [] : [`  manifest written to ${manifestFile} \u2014 review it before apply`]),
    ...(coverage === undefined
      ? ["  next: re-run with --inventory <path> --coverage-out <path> to collect the coverage set apply requires"]
      : [`  coverage digest ${data.coverageDigest}`, `  coverage written to ${data.coverageFile}`]),
  ]);
}

async function runExecutionApply(options: ExecutionMigrateOptions, json: boolean): Promise<void> {
  const verb = "store execution apply";
  const context = executionContextOf(options, verb);
  const operationId = requireFlagValue(stringFlag(options, "operation"), "--operation", verb, "operation-id");
  const operator = requireFlagValue(stringFlag(options, "operator"), "--operator", verb, "operator-name");
  const manifest = requireApplyManifest(options, verb);
  const inventoryPath = requireReviewedInventory(options, verb, manifest);
  const coverage = requireCoverageSet(options, verb, manifest);
  const backup = requireBackupReceipt(options, verb);

  const receipt = await applyExecutionMigration({
    context,
    operationId,
    operator,
    ...(inventoryPath === undefined ? {} : { inventoryPath }),
    manifest: manifest.document,
    manifestHash: manifest.hash,
    backup,
    coverage,
  });
  const data = { ...receipt, manifestHash: manifest.hash, coverageDigest: coverage.digest };
  printExecutionData("apply", data, json, [
    `store execution apply: ${receipt.replayed ? "REPLAY (no writes)" : "staged"} manifest ${receipt.manifestId}`,
    `  coverage digest ${coverage.digest}`,
    "  the store now holds the staged import; ordinary mutations stay refused until `store execution activate`",
  ]);
}

async function runExecutionActivate(options: ExecutionMigrateOptions, json: boolean): Promise<void> {
  const verb = "store execution activate";
  const context = executionContextOf(options, verb);
  const operationId = requireFlagValue(stringFlag(options, "operation"), "--operation", verb, "operation-id");
  const operator = requireFlagValue(stringFlag(options, "operator"), "--operator", verb, "operator-name");
  const manifest = readManifestDocument(options, verb);
  const inventoryPath = requireReviewedInventory(options, verb, manifest);
  const coverage = requireCoverageSet(options, verb, manifest);
  const attestation = requireAttestation(options, verb);

  const receipt = await activateExecutionMigration({
    context,
    operationId,
    operator,
    ...(inventoryPath === undefined ? {} : { inventoryPath }),
    manifestId: manifest.id,
    manifestHash: manifest.hash,
    expectedEpoch: manifest.epoch,
    attestation,
    coverageDigest: coverage.digest,
  });
  const data = { ...receipt, manifestHash: manifest.hash, expectedEpoch: manifest.epoch, coverageDigest: coverage.digest };
  printExecutionData("activate", data, json, [
    `store execution activate: ${receipt.replayed ? "ALREADY ACTIVE (no epoch bump)" : "activated"} manifest ${receipt.manifestId}`,
    `  expected epoch ${manifest.epoch}, coverage digest ${coverage.digest}`,
    "  the imported sessions are revoked and imported held ownership stays represented at its own epoch. Before a consumer reads the",
    "  migrated workflow, recover its coordinator with `mstar session recover` (naming the recorded prior holder) and rebind its",
    "  plans; a suspended or restored lease is reconciled explicitly and is never adopted by this barrier (R7 is not selected).",
  ]);
}

async function runExecutionRetire(options: ExecutionMigrateOptions, json: boolean): Promise<void> {
  const verb = "store execution retire";
  const context = executionContextOf(options, verb);
  const operationId = requireFlagValue(stringFlag(options, "operation"), "--operation", verb, "operation-id");
  const operator = requireFlagValue(stringFlag(options, "operator"), "--operator", verb, "operator-name");
  const manifest = readManifestDocument(options, verb);
  const inventoryPath = requireReviewedInventory(options, verb, manifest);

  const receipt = await retireExecutionSources({
    context,
    operationId,
    operator,
    ...(inventoryPath === undefined ? {} : { inventoryPath }),
    manifestId: manifest.id,
    manifestHash: manifest.hash,
  });
  const data = { ...receipt, manifestHash: manifest.hash };
  printExecutionData("retire", data, json, [
    `store execution retire: ${receipt.replayed ? "ALREADY RETIRED (no file changes)" : "retired"} manifest ${receipt.manifestId}`,
    "  the reviewed core sources moved into manifest-addressed history under a resumable ledger; retained surfaces were not touched",
  ]);
}

async function runExecutionAbort(options: ExecutionMigrateOptions, json: boolean): Promise<void> {
  const verb = "store execution abort";
  const context = executionContextOf(options, verb);
  const operationId = requireFlagValue(stringFlag(options, "operation"), "--operation", verb, "operation-id");
  const operator = requireFlagValue(stringFlag(options, "operator"), "--operator", verb, "operator-name");
  const reason = requireFlagValue(stringFlag(options, "reason"), "--reason", verb, "text");
  const manifest = readManifestDocument(options, verb);

  const receipt = await abortExecutionMigration({
    context,
    operationId,
    operator,
    manifestId: manifest.id,
    manifestHash: manifest.hash,
    reason,
  });
  const data = { ...receipt, manifestHash: manifest.hash };
  printExecutionData("abort", data, json, [
    `store execution abort: ${receipt.replayed ? "ALREADY ABORTED (no writes)" : "aborted"} manifest ${receipt.manifestId}`,
    "  the staged rows are gone, the epoch is unmoved and every source byte and issue/catalog row is preserved;",
    "  an aborted manifest is never re-staged \u2014 re-preview under a fresh manifest",
  ]);
}

async function runExecutionRestorePreview(options: ExecutionMigrateOptions, json: boolean): Promise<void> {
  const verb = "store execution restore-preview";
  const context = executionContextOf(options, verb);
  const backupPath = requiredAbsolutePath(stringFlag(options, "backup"), "--backup", verb, "recovery-point-image-path");
  const out = optionalAbsolutePath(stringFlag(options, "out"), "--out", verb, "loss-preview-json-path");

  const preview = await previewExecutionRestore(context, backupPath);
  const previewFile = writeJsonArtifact(out, preview);
  const data = { ...preview, previewFile: previewFile ?? null };
  printExecutionData("restore-preview", data, json, [
    `store execution restore-preview: ${preview.backupPath}`,
    `  live store ${preview.liveStoreId} epoch ${preview.liveEpoch} \u2192 point epoch ${preview.backupEpoch}`,
    `  ${preview.lostOperationIds.length} committed operation(s) and ${preview.authorityDifferences.length} authority row(s) would be replaced`,
    `  loss digest ${preview.lossDigest}`,
    ...(previewFile === undefined
      ? ["  nothing was replaced; save this preview (--out <path>) to pass it to `restore`"]
      : [`  preview written to ${previewFile}`]),
  ]);
}

async function runExecutionRestore(options: ExecutionMigrateOptions, json: boolean): Promise<void> {
  const verb = "store execution restore";
  const context = executionContextOf(options, verb);
  const operator = requireFlagValue(stringFlag(options, "operator"), "--operator", verb, "operator-name");
  const authorization = requireFlagValue(stringFlag(options, "authorization"), "--authorization", verb, "audit-reference");
  const preview = requireRecoveryPreview(options, verb);
  const acceptLossDigest = requireLossDigest(options, verb);
  const out = optionalAbsolutePath(stringFlag(options, "out"), "--out", verb, "restore-receipt-json-path");

  const receipt = await restoreExecutionBackup(context, { preview, acceptLossDigest, operator, authorization });
  const receiptFile = writeJsonArtifact(out, receipt);
  const data = { ...receipt, receiptFile: receiptFile ?? null };
  printExecutionData("restore", data, json, [
    `store execution restore: replaced the live store from ${receipt.restoredFromSha256.slice(0, 12)} (store ${receipt.storeId} epoch ${receipt.epoch})`,
    `  pre-restore recovery point ${receipt.preRestoreBackup.backupPath}`,
    `  durable recovery receipt ${receipt.recoveryReceiptPath}`,
    "  every pre-restore reference is now invalid: recover each workflow's coordinator with `mstar session recover` and rebind its",
    "  plans; a restored held lease keeps its old owner epoch and is reconciled explicitly \u2014 it is never adopted by this verb.",
  ]);
}

async function runExecutionExport(options: ExecutionMigrateOptions, json: boolean): Promise<void> {
  const verb = "store execution export";
  const context = executionContextOf(options, verb);
  const out = optionalAbsolutePath(stringFlag(options, "out"), "--out", verb, "diagnostic-export-path");

  const artifact = await exportExecutionState(context);
  const outFile = writeTextArtifact(out, artifact.canonicalJson);
  const data = { format: artifact.format, sha256: artifact.sha256, out: outFile ?? null, canonicalJson: artifact.canonicalJson };
  if (json) {
    console.log(JSON.stringify({ ok: true, route: "execution", operation: "export", data }));
    return;
  }
  console.log(`store execution export: ${artifact.format} sha256 ${artifact.sha256}`);
  if (outFile !== undefined) console.log(`  written to ${outFile} (no writer accepts this artifact)`);
  else console.log(artifact.canonicalJson);
}

/* ------------------------------------------------------------------------ *
 * § Registration
 * ------------------------------------------------------------------------ */

/**
 * `mstar store execution` — attached to the EXISTING `store` group (its owning
 * module is outside this round's file set, and commander aborts the whole CLI on
 * a duplicate command name). Every verb opts into `exitOverride`, so an unknown
 * flag, a missing option value or an excess argument reaches the shared
 * `CommanderError` → exit 2 handler while `--help` stays exit 0.
 */
export function registerExecutionMigrationCommands(target: Command): void {
  const store = target.commands.find((command) => command.name() === "store");
  if (store === undefined) {
    throw new Error("registerExecutionMigrationCommands: the `store` command group must be registered first");
  }

  const execution = store
    .command("execution")
    .description(
      "The EXECUTION operator family (phase 2b execution contract \u00a73.2/\u00a76/\u00a77) over the engine's migration and recovery " +
        "APIs: the staged execution migration (preview | apply | activate | retire | abort), the whole-store recovery " +
        "(restore-preview | restore) and the redacted diagnostic export. `store activate` stays the ISSUE/CATALOG barrier; " +
        "`store execution activate` is the execution barrier. Activation and restore are operational: every mutating verb " +
        "takes the reviewed artifact of the boundary it crosses (manifest, coverage, recovery-point receipt, attestation, " +
        "approved loss digest) and fails closed when one is missing (exit 0 ok, 1 refusal, 2 usage)",
    )
    .exitOverride();

  execution
    .command("preview")
    .description(
      "Read-only \u00a76 item 1 discovery (+ \u00a74.2 coverage collection with --coverage-out): validate every register entry, " +
        "snapshot, referenced session identity, catalog pin and deferred surface against the store's own identity and " +
        "return the version 2 manifest. --inventory names the explicit operator inventory (host/package/injector/session " +
        "evidence); without it the discovery scope is the CONTROL ROOT ALONE and that manifest can never be covered or " +
        "activated. Creates no DB row, no receipt and no source byte",
    )
    .option("--operation <id>", "Caller-supplied id of this operation (the replay key)")
    .option("--operator <name>", "Accountable operator this migration is recorded under")
    .option("--inventory <path>", "Absolute path of the explicit operator inventory JSON (host/package/injector/session evidence)")
    .option("--out <path>", "Write the full reviewed manifest JSON to this absolute path for review")
    .option("--coverage-out <path>", "With --inventory: write the ExecutionCoverageSet JSON of this same frozen manifest")
    .option("--harness <path>", "Absolute control-harness override (default: resolved root)")
    .option("--json", "Machine-readable envelope on stdout")
    .exitOverride()
    .action(async (options: ExecutionMigrateOptions) => {
      try {
        await runExecutionPreview(options, options.json === true);
      } catch (error) {
        failExecutionMigrate("preview", error, options.json === true);
      }
    });

  execution
    .command("apply")
    .description(
      "Stage the reviewed execution import (\u00a76 item 2): one transaction that writes the core rows, the historical/" +
        "suspended session association, the coverage record and the migration receipt behind a verified recovery point. " +
        "Requires the reviewed --manifest (version 2), its --coverage set, the recovery-point RECEIPT document from " +
        "`mstar store backup --json` as --backup, and the reviewed --inventory when the manifest records one. It never " +
        "activates: the staged store refuses ordinary mutations until `store execution activate`",
    )
    .option("--manifest <path>", "Absolute path of the reviewed version 2 manifest JSON (required)")
    .option("--coverage <path>", "Absolute path of the reviewed ExecutionCoverageSet JSON of that manifest (required)")
    .option("--backup <path>", "Absolute path of the recovery-point receipt JSON (the `data` object of `mstar store backup --json`) (required)")
    .option("--inventory <path>", "Absolute path of the reviewed explicit inventory (required when the manifest records one)")
    .option("--operation <id>", "Caller-supplied id of this one apply operation (the replay key)")
    .option("--operator <name>", "Accountable operator this migration is recorded under")
    .option("--harness <path>", "Absolute control-harness override (default: resolved root)")
    .option("--json", "Machine-readable envelope on stdout")
    .exitOverride()
    .action(async (options: ExecutionMigrateOptions) => {
      try {
        await runExecutionApply(options, options.json === true);
      } catch (error) {
        failExecutionMigrate("apply", error, options.json === true);
      }
    });

  execution
    .command("activate")
    .description(
      "OPERATIONAL. The EXECUTION activation barrier (\u00a76 item 3, the execution route \u2014 NOT the issue/catalog `store " +
        "activate`): re-read the recorded staged manifest, recheck every witness byte, recompute the coverage of every " +
        "discovered surface through the pure validator, take the operator --attestation (each imported owner named " +
        "stopped/reloaded), CAS on the reviewed epoch and advance the store-wide epoch ONCE. Requires --manifest, " +
        "--coverage (of that same manifest) and --attestation. Imported sessions are revoked and imported held ownership " +
        "stays represented; no lease is transferred",
    )
    .option("--manifest <path>", "Absolute path of the reviewed manifest JSON that was staged (required)")
    .option("--coverage <path>", "Absolute path of its reviewed ExecutionCoverageSet JSON (required; its digest is the approval)")
    .option("--attestation <path>", "Absolute path of the operator ActivationAttestation JSON naming every imported owner stopped (required)")
    .option("--inventory <path>", "Absolute path of the reviewed explicit inventory (required when the manifest records one)")
    .option("--operation <id>", "Caller-supplied id of this one activation operation (the replay key)")
    .option("--operator <name>", "Accountable operator; must equal the attestation's own actor")
    .option("--harness <path>", "Absolute control-harness override (default: resolved root)")
    .option("--json", "Machine-readable envelope on stdout")
    .exitOverride()
    .action(async (options: ExecutionMigrateOptions) => {
      try {
        await runExecutionActivate(options, options.json === true);
      } catch (error) {
        failExecutionMigrate("activate", error, options.json === true);
      }
    });

  execution
    .command("retire")
    .description(
      "Retire the exact reviewed core sources of an ACTIVATED manifest (\u00a76 item 4): revalidate the recorded coverage " +
        "digest against the activation receipt, verify every item's bytes and archive destination BEFORE the first rename, " +
        "then move the root register and the registered snapshots into manifest-addressed history under a resumable ledger. " +
        "Retained surfaces (notes, flow, cursors, host exports, SDD evidence) are not touched. Requires --manifest",
    )
    .option("--manifest <path>", "Absolute path of the reviewed manifest JSON that was activated (required)")
    .option("--inventory <path>", "Absolute path of the reviewed explicit inventory (required when the manifest records one)")
    .option("--operation <id>", "Caller-supplied id of this one retirement operation (the replay key)")
    .option("--operator <name>", "Accountable operator this retirement is recorded under")
    .option("--harness <path>", "Absolute control-harness override (default: resolved root)")
    .option("--json", "Machine-readable envelope on stdout")
    .exitOverride()
    .action(async (options: ExecutionMigrateOptions) => {
      try {
        await runExecutionRetire(options, options.json === true);
      } catch (error) {
        failExecutionMigrate("retire", error, options.json === true);
      }
    });

  execution
    .command("abort")
    .description(
      "Return a STAGED manifest to legacy (\u00a76 item 5): the staged rows and receipt go, the epoch stays unmoved and " +
        "every source byte, issue row and catalog row is preserved. An active or retired manifest refuses, and an aborted " +
        "manifest is never re-staged \u2014 changed legacy input applies anew under a fresh preview. Requires --manifest and " +
        "the recorded --reason",
    )
    .option("--manifest <path>", "Absolute path of the reviewed manifest JSON that is staged (required)")
    .option("--reason <text>", "Why this staging is abandoned (recorded on the manifest's receipt) (required)")
    .option("--operation <id>", "Caller-supplied id of this one abort operation (the replay key)")
    .option("--operator <name>", "Accountable operator this abort is recorded under")
    .option("--harness <path>", "Absolute control-harness override (default: resolved root)")
    .option("--json", "Machine-readable envelope on stdout")
    .exitOverride()
    .action(async (options: ExecutionMigrateOptions) => {
      try {
        await runExecutionAbort(options, options.json === true);
      } catch (error) {
        failExecutionMigrate("abort", error, options.json === true);
      }
    });

  execution
    .command("restore-preview")
    .description(
      "Read-only \u00a78 loss preview of one recovery point (--backup <image path>): verify the point, inventory the whole " +
        "store and return the canonical lossDigest of what restoring it would cost \u2014 the digest an operator approves. " +
        "Mutates nothing and leaves both stores exactly where they are",
    )
    .option("--backup <path>", "Absolute path of the recovery-point IMAGE (its `backupPath`) to inventory (required)")
    .option("--out <path>", "Write the loss preview JSON to this absolute path for review")
    .option("--harness <path>", "Absolute control-harness override (default: resolved root)")
    .option("--json", "Machine-readable envelope on stdout")
    .exitOverride()
    .action(async (options: ExecutionMigrateOptions) => {
      try {
        await runExecutionRestorePreview(options, options.json === true);
      } catch (error) {
        failExecutionMigrate("restore-preview", error, options.json === true);
      }
    });

  execution
    .command("restore")
    .description(
      "OPERATIONAL. \u00a78 whole-store replacement from one recovery point: recompute the loss inventory under the " +
        "maintenance lock, refuse anything but the EXACT approved --accept-loss-digest, take a fresh pre-restore " +
        "recovery point, install a verified same-filesystem sibling whose epoch is above both generations and record the " +
        "durable receipt. Requires --preview (the preview document), --accept-loss-digest, --operator and " +
        "--authorization. It never falls back to files and never converts DB state back to JSON",
    )
    .option("--preview <path>", "Absolute path of the loss preview JSON `restore-preview --out` wrote (required)")
    .option("--accept-loss-digest <hex>", "The exact 64-hex lossDigest of that preview the operator approved (required)")
    .option("--operator <name>", "Accountable operator of this restore (required)")
    .option("--authorization <ref>", "Audit reference of who accepted the disclosed loss (required; never a bypass)")
    .option("--out <path>", "Write the restore receipt JSON to this absolute path")
    .option("--harness <path>", "Absolute control-harness override (default: resolved root)")
    .option("--json", "Machine-readable envelope on stdout")
    .exitOverride()
    .action(async (options: ExecutionMigrateOptions) => {
      try {
        await runExecutionRestore(options, options.json === true);
      } catch (error) {
        failExecutionMigrate("restore", error, options.json === true);
      }
    });

  execution
    .command("export")
    .description(
      "Canonical, sorted diagnostic view of the execution authority (\u00a78): store identity, recorded migrations with " +
        "their source status, workflow/plan/lease/frozen-input state and session ROWS without identities \u2014 every session " +
        "identity, CAS token and credential path is dropped and the dropped key names are reported in `redactedKeys`. " +
        "There is no import verb: this artifact can describe an authority, never reconstitute one",
    )
    .option("--out <path>", "Write the canonical diagnostic JSON to this absolute path")
    .option("--harness <path>", "Absolute control-harness override (default: resolved root)")
    .option("--json", "Machine-readable envelope on stdout")
    .exitOverride()
    .action(async (options: ExecutionMigrateOptions) => {
      try {
        await runExecutionExport(options, options.json === true);
      } catch (error) {
        failExecutionMigrate("export", error, options.json === true);
      }
    });
}
