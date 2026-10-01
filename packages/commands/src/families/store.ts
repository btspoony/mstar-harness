import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path, { basename } from "node:path";
import {
  SddScriptError,
  StoreActivationError,
  StoreError,
  abortExecutionMigration,
  activateStore,
  activateStoreUpgrade,
  activationReceiptFor,
  appliedReceiptFor,
  applyStoreMigration,
  archiveStoreUpgradeFiles,
  backupStore,
  initializeExecutionAuthority,
  initializeStore,
  planStoreMigration,
  probeStoreUpgradeState,
  resolveProcessHarnessDir,
  retireStoreSources,
  retireExecutionSources,
  stageStoreUpgrade,
  storeDbPath,
  upgradeStore,
  upgradeStoreWithRecoveryPoint,
  validateActivationAttestation,
  executionManifestHash,
  type ActivationAttestation,
  type MigrationManifest,
  type StagedStoreUpgrade,
  type StoreContext,
  type StoreUpgradeState,
} from "@mstar-harness/engine";
import { z } from "zod";
import type { CommandDefinition, CommandEffect, CommandEnvelope, InvocationContext } from "../types.js";
import { commandEnvelopeSchema } from "../definitions.js";

const inputSchema = z.object({
  harness: z.string().optional(),
  apply: z.boolean().optional(),
  manifest: z.string().optional(),
  attestation: z.string().optional(),
  out: z.string().optional(),
  operator: z.string().optional(),
  inventory: z.string().optional(),
});
type StoreInput = z.infer<typeof inputSchema>;
const verbs = ["init", "migrate", "upgrade", "backup", "activate", "retire"] as const;
function hasLegacyExecutionFiles(harnessDir: string): boolean {
  return existsSync(path.join(harnessDir, "status.json")) ||
    (existsSync(path.join(harnessDir, "workflows")) && readdirSync(path.join(harnessDir, "workflows")).length > 0);
}

function ok(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.internal-error`;
  if (error instanceof SddScriptError) return { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message };
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message };
}

function findLegacyWorkspaceFact(harnessDir: string): string | null {
  if (existsSync(path.join(harnessDir, "store.db"))) return `a store already exists at ${path.join(harnessDir, "store.db")} — migrate or activate instead of initializing`;
  const projectsDir = path.join(harnessDir, "projects");
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && existsSync(path.join(projectsDir, entry.name, "residuals.json"))) {
        return `legacy residual register found at projects/${entry.name}/residuals.json — use the staged migration, not "store init"`;
      }
    }
  }
  if (existsSync(path.join(harnessDir, "iterations", "README.md"))) return "maintained catalog index found at iterations/README.md — use the staged migration, not \"store init\"";
  const statusPath = path.join(harnessDir, "status.json");
  if (existsSync(statusPath)) {
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as { workflows?: unknown };
      if (Array.isArray(status.workflows) && status.workflows.length > 0) return `${status.workflows.length} registered workflow(s) in status.json — this is not a genuinely empty workspace`;
    } catch {
      return `status.json at ${statusPath} is unreadable — this is not a genuinely empty workspace`;
    }
  }
  return null;
}
function contextOf(input: StoreInput, invocation: InvocationContext): StoreContext {
  const resolved = resolveProcessHarnessDir(invocation.cwd, input.harness);
  const harnessDir = resolved ?? (input.harness === undefined ? invocation.cwd : path.resolve(input.harness));
  if (invocation.controlRoot !== null && path.resolve(harnessDir) === path.resolve(invocation.controlRoot)) {
    throw new SddScriptError("store operations must name a fixture or project harness, never the control-root store", 2);
  }
  return { harnessDir };
}
function absoluteFile(value: string, flag: string): string {
  if (!path.isAbsolute(value)) throw new SddScriptError(`${flag} must be an absolute path`, 2);
  return value;
}
function outputPath(value: string | undefined, cwd: string): string | undefined {
  return value === undefined ? undefined : path.resolve(cwd, value);
}
function jsonFile<T>(value: string, flag: string): T {
  let text: string;
  try { text = readFileSync(absoluteFile(value, flag), "utf8"); }
  catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
    const kind = flag === "--attestation" ? "attestation" : "operator-file";
    const diagnosticCode = code === "ENOENT" ? `store.${kind}-missing` : `store.${kind}-unreadable`;
    throw Object.assign(new SddScriptError(`${flag} could not be read`, 2), { code: diagnosticCode });
  }
  try { return JSON.parse(text) as T; }
  catch { throw Object.assign(new SddScriptError(`${flag} is not valid JSON`, 2), { code: flag === "--attestation" ? "store.attestation-malformed" : "store.operator-file-malformed" }); }
}
function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") throw new SddScriptError(`${flag} is required`, 2);
  return value;
}
function requireInputs(input: StoreInput, fields: readonly (keyof StoreInput)[]): void {
  const missing = fields.filter((field) => {
    const value = input[field];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new SddScriptError(
      `${missing.map((field) => `--${field}`).join(", ")} ${missing.length === 1 ? "is" : "are"} required`,
      2,
    );
  }
}
export function storeUpgradeFailure(id: string, error: unknown): CommandEnvelope<never> {
  const rawCode = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const errorMessage = error !== null && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : "";
  const pendingOperationIds = errorMessage.match(/catalog operation\(s\) are still pending \(([^)]*)\)/)?.[1];
  const isPendingRegistration = rawCode === "execution.migration-conflict" && pendingOperationIds !== undefined;
  const unclassifiedCode = rawCode === undefined
    ? errorMessage.includes("persisted staged migration record is missing or incomplete")
      ? "store.upgrade-staged-record-missing"
      : errorMessage.includes("malformed JSON in the persisted staged manifest or coverage record")
        ? "store.upgrade-staged-record-malformed"
        : errorMessage.includes("persisted manifest or coverage identity is inconsistent")
          ? "store.upgrade-staged-record-inconsistent"
          : errorMessage.includes("retry inventory") && errorMessage.includes("does not match the staged manifest scope")
            ? "store.upgrade-staged-inventory-mismatch"
            : errorMessage.includes("staged execution authority without its matching recorded manifest")
              ? "store.upgrade-staged-manifest-missing"
              : errorMessage.startsWith("store upgrade is blocked:") || errorMessage === "unreachable store upgrade state"
                ? "store.upgrade-state-changed"
                : undefined
    : undefined;
  const errorCode = isPendingRegistration ? "store.upgrade-pending-registration" : rawCode ?? unclassifiedCode;
  const diagnostics: Record<string, { blocker: string; recovery: string }> = {
    "execution.migration-conflict": { blocker: "A legacy source or catalog registration conflicts with the execution migration.", recovery: "Do not abort this catalog operation: its staged snapshot or root registration is protected by the execution guard. Resolve the ownership or evidence conflict through the supported catalog reconciliation flow, then retry `store upgrade --operator <name> --attestation <file>`." },
    "execution.coverage-incomplete": { blocker: "The legacy execution source does not provide complete migration evidence.", recovery: "Restore the missing workflow or stop-session evidence from the operator's backup; provide an inventory only if discovery inventory is the missing item, using `--inventory <inventory-file>`, then run `store upgrade --operator <name> --attestation <file>`." },
    "execution.scope-mismatch": { blocker: "The supplied control root, operator, or inventory does not match the migration scope.", recovery: "Run from the intended control root with a non-empty operator via `--operator <name>`; omit `--inventory` for control-root-only scope or supply the intended inventory with `--inventory <inventory-file>`." },
    "execution.not-active": { blocker: "The store schema does not yet include the execution tables required for migration.", recovery: "Run `store upgrade` to complete the schema upgrade, then retry the execution migration." },
    "store.attestation-missing": { blocker: "The supplied attestation file was not found.", recovery: "Provide an existing readable attestation file and retry `store upgrade --operator <name> --attestation <file>`." },
    "store.attestation-unreadable": { blocker: "The supplied attestation file could not be read.", recovery: "Provide a readable attestation file and retry `store upgrade --operator <name> --attestation <file>`." },
    "store.attestation-malformed": { blocker: "The supplied attestation file is malformed.", recovery: "Provide a readable, valid JSON attestation file and retry `store upgrade --operator <name> --attestation <file>`." },
    "store.attestation-invalid": { blocker: "The supplied activation attestation is invalid.", recovery: "Provide an attestation matching the current upgrade, then retry `store upgrade --operator <name> --attestation <file>`." },
    "store.activation-blocked": { blocker: "A required consumer is not ready or an active session has not stopped.", recovery: "Reload or update the named consumer, stop the active sessions, update the attestation to confirm that state, and retry `store upgrade --operator <name> --attestation <file>`." },
    "store.migration-source-changed": { blocker: "A reviewed legacy source changed or is missing, so migration retirement cannot be verified.", recovery: "Restore the reviewed source bytes from the operator's verified file backup, then run `store upgrade --operator <name> --attestation <file>` to review and apply a fresh attempt. If the reviewed bytes are unavailable, preserve all source and store bytes and provide the refusal, source-change diagnostic, and backup-availability result to the store recovery owner." },
    "store.legacy-write-detected": { blocker: "A legacy consumer wrote to a source during migration retirement.", recovery: "Stop or reload the old consumer, then retry `store upgrade --operator <name>` to resume retirement; the engine verifies the preserved source evidence before continuing." },
    "store.activation-stale": { blocker: "The recovery point or retained-source evidence does not match the current store.", recovery: "Create a fresh attempt with `store upgrade --operator <name> --attestation <file>`; if a verified backup is needed and the live store is readable, inspect it with `store execution restore-preview --backup <backup-file> --out <preview-file>`." },
    "store.stale-epoch": { blocker: "The activation evidence belongs to an older store generation.", recovery: "Run `store upgrade --operator <name> --attestation <file>` to build fresh activation evidence from the current store generation." },
    "store.not-active": { blocker: "The store is not active for the requested authority transition.", recovery: "Run or resume the supported `store upgrade --operator <name> --attestation <file>` workflow before retiring sources." },
    "store.busy": { blocker: "Another store writer currently holds the database.", recovery: "Wait for that writer to finish, then retry the requested upgrade." },
    "store.corrupt": { blocker: "The store database is unreadable or structurally invalid.", recovery: "A restore preview requires inventory of the live database, so `store execution restore-preview` cannot recover an unreadable live store. No online operator restore is available in this state. If no verified backup can be restored through a supported recovery process, rebuild the store with `store init` only after preserving the corrupt database and legacy sources; rebuilding loses SQLite-only catalog/execution data." },
    "store.schema-drift": { blocker: "Applied schema history is inconsistent with this build.", recovery: "Install the harness build that owns this store schema with `npm i -g @mstar-harness/cli@latest` and retry. If the live store remains readable and the schema owner confirms restore is appropriate, run `store execution restore-preview --backup <backup-file> --out <preview-file>`, review its loss inventory, then `store execution restore --preview <preview-file> --accept-loss-digest <loss-digest> --operator <name> --authorization <ref>`." },
    "store.upgrade-staged-record-missing": { blocker: "A staged execution migration is missing its complete saved record.", recovery: "The staged-abandon confirmation applies only when changed evidence is detected and is not reachable for a missing saved record. No operator-executable in-place recovery is available. Preserve the legacy sources; rebuild with `store init` only after preserving the store and source bytes, understanding that SQLite-only catalog/execution data will be lost." },
    "store.upgrade-staged-record-malformed": { blocker: "The saved staged migration manifest or coverage JSON is malformed.", recovery: "Do not edit or delete the live store or workflow files. Preserve the entire harness store before rebuilding; the archive-first recovery path is required to retain the malformed record and all SQLite-only data." },
    "store.upgrade-staged-record-inconsistent": { blocker: "The saved staged migration identity does not verify.", recovery: "The staged-abandon confirmation applies only when changed evidence is detected and cannot repair an inconsistent saved identity. No operator-executable in-place recovery is available. Preserve the legacy sources; rebuild with `store init` only after preserving the store and source bytes, understanding that SQLite-only catalog/execution data will be lost." },
    "store.upgrade-staged-manifest-missing": { blocker: "The staged authority has no matching recorded migration manifest.", recovery: "The staged-abandon confirmation applies only when changed evidence is detected and cannot repair a missing manifest. No operator-executable in-place recovery is available. Preserve the legacy sources; rebuild with `store init` only after preserving the store and source bytes, understanding that SQLite-only catalog/execution data will be lost." },
    "store.schema-unsupported": { blocker: "This build does not support the store schema version.", recovery: "Install the current harness CLI with `npm i -g @mstar-harness/cli@latest`, then rerun `store upgrade` on that build." },
    "store.runtime-unsupported": { blocker: "The current runtime lacks native SQLite support or is below the supported version floor.", recovery: "Run the harness with Bun >=1.4.0 from `https://bun.sh` or Node >=24.18.0 from `https://nodejs.org`, then retry `store upgrade`." },
    "store.upgrade-staged-inventory-mismatch": { blocker: "The retry inventory differs from the staged migration's reviewed scope.", recovery: "Resume with the reviewed inventory, or omit `--inventory` to reuse that saved scope, then rerun `store upgrade`." },
    "store.upgrade-state-changed": { blocker: "The upgrade preconditions changed while the upgrade was being prepared.", recovery: "Read the current store state with the supported `store upgrade` command, correct the named blocking condition, and rerun `store upgrade`." },
  };
  const diagnostic = isPendingRegistration
      ? {
        blocker: `Pending catalog registration ${pendingOperationIds} blocks execution migration.`,
        recovery: "Inspect the operation with `catalog reconcile --operation-id <operation-id>`. For phase `prepared` with no workflow snapshot or root registration, rerun with `--abort`; if a snapshot or root registration exists, abort is refused—complete reconciliation after correcting the reported ownership/evidence conflict, or remove the affected workflow through its supported lifecycle before retrying.",
      }
      : errorCode === undefined ? undefined : diagnostics[errorCode];
  if (["store.attestation-missing", "store.attestation-unreadable", "store.attestation-malformed", "store.attestation-invalid"].includes(errorCode ?? "")) {
    return { version: 1, command: id, status: "usage", code: errorCode!, exitCode: 2, message: `${diagnostic!.blocker} ${diagnostic!.recovery}` };
  }
  if (error instanceof SddScriptError && diagnostic === undefined) return { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message: "The supplied store upgrade options or input format are invalid. Correct the request using `store upgrade --help`." };
  const code = errorCode ?? `${id}.unexpected-failure`;
  if (diagnostic !== undefined) return { version: 1, command: id, status: "refused", code, exitCode: 1, message: `${diagnostic.blocker} ${diagnostic.recovery}` };
  const detailCode = rawCode ?? "no error code";
  const rawMessage = error instanceof Error
    ? error.message
    : error !== null && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message
      : String(error);
  const detailMessage = rawMessage
    .replace(/(?:\/Users\/|\/private\/|\/tmp\/|\/home\/|\/var\/|\/Volumes\/|[A-Za-z]:[\\/])[^\s,;)]+/g, "[path omitted]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[identifier omitted]")
    .replace(/\b(?:rawCode|errorCode|errorMessage|pendingOperationIds|workflowId|operationId|storeDbPath|backupPath|harnessDir|context|snapshotPath|manifestHash|lossDigest|acceptLossDigest|databasePath|filePath)\b/gi, "[internal field omitted]")
    .replace(/\bsession(?:\s+id)?\s+\S+/gi, "session [identifier omitted]");
  return { version: 1, command: id, status: "refused", code, exitCode: 1, message: `The store upgrade command raised an unclassified error (code: ${detailCode}; message: ${detailMessage}). Preserve the legacy sources and store bytes. The refusal was raised while running \`store upgrade\`; use the cause details above to correct the request or state, then rerun \`store upgrade\`. If the cause is not operator-correctable, provide this full diagnostic and the preserved state to the store recovery owner.` };
}

type UpgradeRecovery = { archivePath?: string; rollback?: () => void };

const SQLITE_FORMAT_MAGIC = "SQLite format 3\u0000";

/**
 * Recover an existing-but-unreadable store.
 *
 * Eligibility is deliberately narrow, because displacing a live store is
 * destructive. `store.corrupt` also covers a symlink, a directory, a device
 * file, an unreadable path, and every non-busy open failure, so the code alone
 * proves nothing. Recovery runs only when all of these hold:
 *
 *   - the path is a regular file reached without following a link;
 *   - its header is *positively* identified as not a SQLite database, which is
 *     what a damaged store image is. A database that merely fails to open for
 *     some other reason is left exactly where it is;
 *   - an operator attestation was supplied, since its stopped-session
 *     declaration is the quiescence basis for the raw capture.
 *
 * The archive is the safety barrier: nothing is moved until its bytes were
 * captured, verified and published. The caller then holds a rollback that puts
 * the originals back and removes the replacement store, so a failure anywhere
 * later in the upgrade leaves the control root as it was found.
 */
async function recoverUnreadableStore(
  context: StoreContext,
  input: StoreInput,
  invocation: InvocationContext,
  failure: unknown,
  recovery: UpgradeRecovery,
): Promise<boolean> {
  if (!(failure instanceof StoreError) || failure.code !== "store.corrupt") return false;
  const attestationInput = input.attestation;
  if (input.operator === undefined || attestationInput === undefined) return false;
  const dbPath = storeDbPath(context);
  const stats = (() => {
    try {
      return lstatSync(dbPath);
    } catch {
      return undefined;
    }
  })();
  if (stats === undefined || !stats.isFile() || stats.isSymbolicLink()) return false;
  const header = (() => {
    try {
      const descriptor = openSync(dbPath, "r");
      try {
        const bytes = Buffer.alloc(16);
        readSync(descriptor, bytes, 0, 16, 0);
        return bytes;
      } finally {
        closeSync(descriptor);
      }
    } catch {
      return undefined;
    }
  })();
  if (header === undefined || header.toString("latin1", 0, 16) === SQLITE_FORMAT_MAGIC) return false;
  const attestation = jsonFile<ActivationAttestation>(path.resolve(invocation.cwd, attestationInput), "--attestation");
  // Validate the shape before reading anything out of it, so a malformed file is
  // an invalid-attestation refusal rather than an unclassified TypeError.
  const validated = validateActivationAttestation(attestation);
  // The accountable operator and the attesting operator are one identity at the
  // barrier; activation refuses a mismatch, so archiving and replacing a store
  // must not accept one either.
  if (validated.operator.actor !== input.operator) {
    throw new StoreActivationError(
      "store.attestation-invalid",
      `the attestation is signed by ${JSON.stringify(validated.operator.actor)} while the upgrade is recorded under ` +
        `${JSON.stringify(input.operator)}; the accountable operator and the attesting operator are one identity. ` +
        "Nothing was archived or replaced.",
    );
  }
  const operationId = randomUUID();
  const archive = await archiveStoreUpgradeFiles(context, operationId, validated);
  const displaced: Array<{ moved: string; original: string }> = [];
  const displacedDir = path.join(archive.archivePath, "displaced");
  let initialized = false;
  const rollback = (): void => {
    if (initialized) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
      initialized = false;
    }
    for (const entry of [...displaced].reverse()) {
      try {
        renameSync(entry.moved, entry.original);
      } catch {
        // The archive still holds these bytes; the primary failure is reported by the caller.
      }
    }
  };
  try {
    // The displaced originals belong with the archive, not beside the live store:
    // leaving them in the control root would put stray files in the way of the
    // discovery the migration performs next.
    mkdirSync(displacedDir, { recursive: true });
    for (const file of archive.files) {
      const moved = path.join(displacedDir, basename(file.sourcePath));
      renameSync(file.sourcePath, moved);
      displaced.push({ moved, original: file.sourcePath });
    }
    await initializeStore(context);
    initialized = true;
  } catch (error) {
    rollback();
    throw error;
  }
  recovery.archivePath = archive.archivePath;
  recovery.rollback = rollback;
  return true;
}

async function unifiedStoreUpgrade(
  id: string,
  input: StoreInput,
  context: StoreContext,
  invocation: InvocationContext,
): Promise<CommandEnvelope> {
  const recovery: UpgradeRecovery = {};
  let envelope: CommandEnvelope;
  try {
    envelope = await runStoreUpgrade(id, input, context, invocation, recovery);
  } catch (error) {
    recovery.rollback?.();
    throw error;
  }
  if (envelope.status !== "ok") {
    // A refusal or a declined confirmation must not leave the original displaced.
    recovery.rollback?.();
    return envelope;
  }
  const archivePath = recovery.archivePath;
  const data = envelope.data;
  if (archivePath === undefined || typeof data !== "object" || data === null) return envelope;
  return { ...envelope, data: { ...data, archivedStore: archivePath } };
}

async function runStoreUpgrade(
  id: string,
  input: StoreInput,
  context: StoreContext,
  invocation: InvocationContext,
  recovery: UpgradeRecovery,
): Promise<CommandEnvelope> {
  let state: StoreUpgradeState;
  try {
    state = await probeStoreUpgradeState(context);
  } catch (failure) {
    if (!(await recoverUnreadableStore(context, input, invocation, failure, recovery))) throw failure;
    state = await probeStoreUpgradeState(context);
  }
  if (state.verdict === "blocked") { const hasLegacy = hasLegacyExecutionFiles(context.harnessDir); return { version: 1, command: id, status: "refused", code: hasLegacy ? "store.upgrade-legacy-source-only" : "store.upgrade-empty-store", exitCode: 1, message: hasLegacy ? "Legacy execution files exist without an issue store. Run `store init` to create the issue store without modifying `status.json` or workflow files, then run `store upgrade --operator <name> --attestation <file>` to review, migrate, activate, and retire those execution files; do not run `store migrate`, which does not import the execution workflow authority." : "No store or legacy execution sources exist. Run `store init` to create the empty store, then run `store upgrade`." }; }
  const noLegacyExecutionFiles = !hasLegacyExecutionFiles(context.harnessDir);
  if (
    state.reasons.includes("schema-upgrade-pending")
    && (
      noLegacyExecutionFiles
      || (state.executionAuthorityState === "active" && state.executionMigrationPhase === "retired")
    )
  ) {
    const upgraded = await upgradeStoreWithRecoveryPoint(context, randomUUID());
    state = await probeStoreUpgradeState(context);
    const authority = noLegacyExecutionFiles && state.executionAuthorityState === "legacy"
      ? await initializeExecutionAuthority(context)
      : undefined;
    state = await probeStoreUpgradeState(context);
    if (state.executionAuthorityState === "active" && state.executionMigrationPhase === "retired") {
      return ok(id, { verdict: "upgraded", schemaVersion: upgraded.schemaVersion, executionMigration: "not-needed" });
    }
    if (noLegacyExecutionFiles) {
      return ok(id, {
        verdict: "upgraded",
        schemaVersion: upgraded.schemaVersion,
        executionMigration: "not-needed",
        ...(authority === undefined ? {} : { authorityState: "active" }),
      });
    }
  }
  if (state.verdict === "up-to-date") {
    return ok(id, { verdict: state.verdict, schemaVersion: state.schemaVersion });
  }
  if (state.executionAuthorityState === "active" && state.executionMigrationPhase === "active") {
    requireInputs(input, ["operator"]);
    const receipt = await retireExecutionSources({
      context,
      operator: required(input.operator, "--operator"),
      operationId: randomUUID(),
      manifestId: state.manifestId!,
      manifestHash: state.executionManifestHash!,
    });
    return ok(id, { verdict: "upgraded", schemaVersion: state.schemaVersion, authorityState: "active", sourcesRetired: receipt.phase === "retired" });
  }
  if (state.verdict === "blocked") {
    throw new Error("unreachable store upgrade state");
  }

  if (!hasLegacyExecutionFiles(context.harnessDir)) {
    const upgraded = await upgradeStoreWithRecoveryPoint(context, randomUUID());
    state = await probeStoreUpgradeState(context);
    const authority = state.executionAuthorityState === "legacy"
      ? await initializeExecutionAuthority(context)
      : undefined;
    return ok(id, {
      verdict: "upgraded",
      schemaVersion: upgraded.schemaVersion,
      executionMigration: "not-needed",
      ...(authority === undefined ? {} : { authorityState: "active" }),
    });
  }
  requireInputs(input, ["operator", "attestation"]);
  const operator = required(input.operator, "--operator");
  const attestationPath = path.resolve(invocation.cwd, required(input.attestation, "--attestation"));
  const attestation = jsonFile<ActivationAttestation>(attestationPath, "--attestation");
  const inventoryPath = input.inventory === undefined ? undefined : path.resolve(invocation.cwd, input.inventory);
  invocation.effects.writeStderr?.(
    "This will move execution authority from the legacy workflow files to SQLite and retire those files. Any unpublished catalog change will be preserved for later review, not applied or discarded. Type `preserve for later review` to confirm; anything else cancels. ",
  );
  const catalogDeltaDisposition = await invocation.effects.readInput();
  if (catalogDeltaDisposition.trim() !== "preserve for later review") {
    return {
      version: 1,
      command: id,
      status: "refused",
      code: "store.upgrade-not-confirmed",
      exitCode: 1,
      message: "The authority switch was not confirmed. The workflow files remain authoritative; rerun `store upgrade` and enter `preserve for later review` to continue.",
    };
  }

  let staged: StagedStoreUpgrade;
  try {
    staged = await stageStoreUpgrade({
      context,
      operator,
      operationId: randomUUID(),
      catalogDeltaDisposition,
      ...(inventoryPath === undefined ? {} : { inventoryPath }),
    });
  } catch (error) {
    return storeUpgradeFailure(id, error);
  }

  // Staging succeeded, so the authority switch is under way: retirement can now
  // move legacy files into its own archive, and restoring the unreadable
  // original while deleting the replacement would leave the workspace with
  // neither a usable database nor the file authority. The published archive,
  // not a rollback, is the recovery basis from here on.
  recovery.rollback = undefined;

  try {
    const receipt = await activateStoreUpgrade(staged, attestation);
    return ok(id, {
      verdict: "upgraded",
      schemaVersion: staged.manifest.schemaVersion,
      authorityState: "active",
      sourcesRetired: receipt.phase === "retired",
      exclusions: staged.manifest.exclusions,
      normalizations: staged.manifest.normalizations,
    });
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "execution.migration-conflict") {
      let latestState: StoreUpgradeState | undefined;
      try {
        latestState = await probeStoreUpgradeState(context);
      } catch {
        // Preserve the activation/retirement failure if state cannot be reprobed.
      }
      if (latestState?.executionAuthorityState === "active" && latestState.executionMigrationPhase === "active") return storeUpgradeFailure(id, error);
      if (latestState?.executionAuthorityState === "staged") {
        invocation.effects.writeStderr?.(
          "Changed evidence means this staged migration cannot be activated. Abandon this staged migration and its staged execution rows to return to legacy authority? Type `abandon staged migration` to confirm; anything else cancels. ",
        );
        const confirmation = await invocation.effects.readInput();
        if (confirmation.trim() === "abandon staged migration") {
          try {
            await abortExecutionMigration({
              context,
              operationId: randomUUID(),
              operator,
              manifestId: staged.manifest.id,
              manifestHash: executionManifestHash(staged.manifest),
              reason: "Changed evidence; operator confirmed abandonment through store upgrade",
            });
          } catch {
            // The activation failure remains the primary error.
          }
        }
      }
    }
    return storeUpgradeFailure(id, error);
  }
}

async function execute(id: string, input: StoreInput, invocation: InvocationContext): Promise<CommandEnvelope> {
  try {
    const context = contextOf(input, invocation);
    switch (id) {
      case "store.init": {
        const fact = findLegacyWorkspaceFact(context.harnessDir);
        if (fact !== null) throw new StoreError("store.already-exists", `${fact}. Nothing was created.`);
        const handle = await initializeStore(context);
        try { return ok(id, { storeId: handle.storeId, epoch: handle.epoch, schemaVersion: handle.schemaVersion, authorityState: "active" }); }
        finally { handle.close(); }
      }
      case "store.upgrade": return await unifiedStoreUpgrade(id, input, context, invocation);
      case "store.backup": {
        const out = outputPath(input.out, invocation.cwd);
        const receipt = await backupStore(context, out === undefined ? {} : { out });
        return ok(id, { ...receipt, out: out ?? null });
      }
      case "store.migrate": {
        if (input.apply !== true && input.manifest !== undefined) throw new SddScriptError("--manifest is only meaningful with --apply", 2);
        if (input.apply === true) {
          const manifest = required(input.manifest, "--manifest");
          const document = jsonFile<MigrationManifest>(manifest, "--manifest");
          if (document === null || typeof document !== "object" || document.version === undefined) throw new SddScriptError("--manifest does not carry a MigrationManifest", 2);
          return ok(id, await applyStoreMigration(context, document));
        }
        const manifest = await planStoreMigration(context);
        const out = outputPath(input.out, invocation.cwd);
        if (out !== undefined) writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
        return ok(id, {
          controlRoot: manifest.controlRoot,
          sourceSetDigest: manifest.sourceSetDigest,
          sources: manifest.sources.map(({ project, relativePath, entryCount, sha256 }) => ({ project, relativePath, entryCount, sha256 })),
          mappings: manifest.mappings.length,
          unresolved: manifest.unresolved.length,
          catalogConflicts: manifest.catalog.conflicts.length,
          blocksApply: manifest.blocksApply,
          manifestFile: out ?? null,
          nextStep: manifest.blocksApply ? "resolve the unresolved mappings / catalog conflicts in review, then re-preview" : "have the manifest reviewed, then apply with --apply --manifest <path>",
        });
      }
      case "store.activate": {
        requireInputs(input, ["manifest", "attestation"]);
        const manifest = jsonFile<MigrationManifest>(required(input.manifest, "--manifest"), "--manifest");
        const attestation = jsonFile<ActivationAttestation>(required(input.attestation, "--attestation"), "--attestation");
        const applied = await appliedReceiptFor(context, manifest);
        const receipt = await activateStore(context, applied, attestation);
        const out = outputPath(input.out, invocation.cwd);
        if (out !== undefined) writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
        return ok(id, { ...receipt, out: out ?? null });
      }
      case "store.retire": {
        const manifest = jsonFile<MigrationManifest>(required(input.manifest, "--manifest"), "--manifest");
        const activation = await activationReceiptFor(context, manifest);
        const receipt = await retireStoreSources(context, activation);
        const out = outputPath(input.out, invocation.cwd);
        if (out !== undefined) writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
        return ok(id, { ...receipt, out: out ?? null });
      }
      default: throw new Error(`unsupported store command ${id}`);
    }
  } catch (error) {
    return id === "store.upgrade" ? storeUpgradeFailure(id, error) : refused(id, error);
  }
}

function cliDefinition(id: string): CommandDefinition<StoreInput, unknown> {
  const verb = id.slice("store.".length) as (typeof verbs)[number];
  const optionFlags: Record<keyof StoreInput, string> = {
    harness: "--harness <path>", apply: "--apply", manifest: "--manifest <path>", attestation: "--attestation <path>", out: "--out <path>",
    operator: "--operator <name>", inventory: "--inventory <path>",
  };
  const optionsByVerb: Record<(typeof verbs)[number], (keyof StoreInput)[]> = {
    init: ["harness"],
    migrate: ["harness", "apply", "manifest", "out"],
    upgrade: ["harness", "operator", "attestation", "inventory"],
    backup: ["harness", "out"],
    activate: ["harness", "manifest", "attestation", "out"],
    retire: ["harness", "manifest", "out"],
  };
  const optionKeys = optionsByVerb[verb];
  const shape = Object.fromEntries(optionKeys.map((key) => [key, true])) as { [Key in keyof StoreInput]?: true };
  const options = optionKeys.map((key) => ({ key, flags: optionFlags[key], required: false }));
  const definitionInput = inputSchema.pick(shape);
  return {
    id,
    cli: { path: ["store", verb], aliases: [], arguments: [], options },
    input: definitionInput,
    output: commandEnvelopeSchema,
    effects: ({
      init: ["read", "write"],
      migrate: ["read", "write"],
      upgrade: ["read", "write", "stdin"],
      backup: ["read", "write"],
      activate: ["read", "write"],
      retire: ["read", "write"],
    } satisfies Record<(typeof verbs)[number], readonly CommandEffect[]>)[verb],
    description: verb === "upgrade"
      ? "Report readiness; upgrade the schema, and when legacy execution files exist confirm before migrating authority."
      : `Store ${verb} operation; engine enforces migration, activation, recovery and mutation barriers.`,
    execute: (input, invocation) => execute(id, input, invocation),
  };
}

export function getStoreCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => cliDefinition(`store.${verb}`));
}
