import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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
  resolveProcessHarnessDir,
  type ActivationAttestation,
  type BackupReceipt,
  type ExecutionCoverageSet,
  type ExecutionManifestDocument,
  type ExecutionManifest,
  type ExecutionRecoveryPreview,
  type StoreContext,
} from "@mstar-harness/engine";
import { z } from "zod";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";
import { commandEnvelopeSchema } from "../definitions.js";

const inputSchema = z.object({
  harness: z.string().optional(), operation: z.string().optional(), operator: z.string().optional(), inventory: z.string().optional(),
  out: z.string().optional(), coverageOut: z.string().optional(), manifest: z.string().optional(), coverage: z.string().optional(),
  backup: z.string().optional(), attestation: z.string().optional(), reason: z.string().optional(), preview: z.string().optional(),
  acceptLossDigest: z.string().optional(), authorization: z.string().optional(),
});
type ExecutionInput = z.infer<typeof inputSchema>;
const verbs = ["preview", "apply", "activate", "retire", "abort", "restore-preview", "restore", "export"] as const;
const writeVerbs: Record<string, true> = { apply: true, activate: true, retire: true, abort: true, restore: true };
const lossDigestPattern = /^[0-9a-f]{64}$/;

function ok(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.internal-error`;
  return error instanceof SddScriptError
    ? { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message }
    : { version: 1, command: id, status: "refused", code, exitCode: 1, message };
}
function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") throw new SddScriptError(`${flag} is required`, 2);
  return value.trim();
}
function absolute(value: string | undefined, flag: string, optional = false): string | undefined {
  if (value === undefined || (optional && value.trim() === "")) return undefined;
  if (!path.isAbsolute(value)) throw new SddScriptError(`${flag} must be an absolute path`, 2);
  return value;
}
function readJson(value: string | undefined, flag: string): Record<string, unknown> {
  const file = absolute(required(value, flag), flag)!;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")) as unknown; }
  catch (error) { throw new SddScriptError(`${flag} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`, 2); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new SddScriptError(`${flag} must contain a JSON object`, 2);
  return parsed as Record<string, unknown>;
}
function executionContext(input: ExecutionInput, invocation: InvocationContext, verb: string): StoreContext {
  const harness = absolute(input.harness, "--harness");
  const root = resolveProcessHarnessDir(invocation.cwd, harness);
  if (root === null) throw new SddScriptError(`${verb}: no target harness was resolved; pass --harness <absolute-path>`, 2);
  if (invocation.controlRoot !== null && path.resolve(root) === path.resolve(invocation.controlRoot)) {
    throw new SddScriptError(`${verb}: the control-root store is not an admitted execution target`, 2);
  }
  return { harnessDir: root };
}
function document<T>(value: string | undefined, flag: string): T {
  return readJson(value, flag) as T;
}
function reviewedInventory(manifest: ExecutionManifestDocument, input: ExecutionInput, verb: string): string | undefined {
  const supplied = absolute(input.inventory, "--inventory", true);
  const expected = "inventoryPath" in manifest ? manifest.inventoryPath : null;
  if (expected === null) {
    if (supplied !== undefined) throw new SddScriptError(`${verb}: this reviewed manifest has no explicit inventory`, 2);
    return undefined;
  }
  if (supplied === undefined || supplied !== expected) throw new SddScriptError(`${verb}: --inventory must match the manifest's reviewed discovery scope`, 2);
  return supplied;
}
function coverageSet(input: ExecutionInput, manifest: ExecutionManifestDocument, verb: string): ExecutionCoverageSet {
  const set = document<ExecutionCoverageSet>(input.coverage, "--coverage");
  if (set.version !== 1 || !Array.isArray(set.receipts) || typeof set.digest !== "string" || !lossDigestPattern.test(set.digest)) {
    throw new SddScriptError(`${verb}: --coverage is not a canonical execution coverage set`, 2);
  }
  if (set.manifestId !== manifest.id || set.manifestHash !== executionManifestHash(manifest)) {
    throw new SddScriptError(`${verb}: --coverage belongs to a different reviewed manifest`, 2);
  }
  return set;
}
function requireDigest(input: ExecutionInput): string {
  const digest = required(input.acceptLossDigest, "--accept-loss-digest");
  if (!lossDigestPattern.test(digest)) throw new SddScriptError("--accept-loss-digest must be the exact 64-hex lossDigest", 2);
  return digest;
}

async function execute(id: string, input: ExecutionInput, invocation: InvocationContext): Promise<CommandEnvelope> {
  try {
    const verb = id.slice("store.execution.".length);
    const context = executionContext(input, invocation, `store execution ${verb}`);
    if (verb === "preview") {
      const operationId = required(input.operation, "--operation");
      const operator = required(input.operator, "--operator");
      const inventoryPath = absolute(input.inventory, "--inventory", true);
      const out = absolute(input.out, "--out", true);
      const coverageOut = absolute(input.coverageOut, "--coverage-out", true);
      if (coverageOut !== undefined && inventoryPath === undefined) throw new SddScriptError("--coverage-out requires --inventory", 2);
      const manifest = await previewExecutionMigration({ context, operationId, operator, ...(inventoryPath === undefined ? {} : { inventoryPath }) });
      if (out !== undefined) writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
      let coverage: ExecutionCoverageSet | undefined;
      if (coverageOut !== undefined && inventoryPath !== undefined) {
        coverage = await collectExecutionCoverage({ context, operationId, operator, inventoryPath, manifest });
        writeFileSync(coverageOut, `${JSON.stringify(coverage, null, 2)}\n`);
      }
      return ok(id, {
        version: manifest.version, manifestId: manifest.id, manifestHash: executionManifestHash(manifest), storeId: manifest.storeId,
        epoch: manifest.epoch, schemaVersion: manifest.schemaVersion, root: manifest.root, inventoryPath: manifest.inventoryPath ?? null,
        sources: manifest.sources.length, surfaces: manifest.surfaces.length, deferred: manifest.deferred.length, manifestFile: out ?? null,
        coverageDigest: coverage?.digest ?? null, coverageFile: coverage === undefined ? null : coverageOut,
      });
    }
    if (verb === "apply") {
      const operationId = required(input.operation, "--operation");
      const operator = required(input.operator, "--operator");
      const reviewed = document<ExecutionManifestDocument>(input.manifest, "--manifest");
      if (reviewed.version !== 2) throw new SddScriptError("apply requires the version 2 execution manifest", 2);
      const manifest = reviewed as ExecutionManifest;
      const inventoryPath = reviewedInventory(manifest, input, verb);
      const coverage = coverageSet(input, manifest, verb);
      const backup = document<BackupReceipt>(input.backup, "--backup");
      if (typeof backup.backupPath !== "string" || backup.backupPath.trim() === "") throw new SddScriptError("--backup must be the recovery-point receipt", 2);
      const manifestHash = executionManifestHash(manifest);
      const receipt = await applyExecutionMigration({ context, operationId, operator, ...(inventoryPath === undefined ? {} : { inventoryPath }), manifest, manifestHash, backup, coverage });
      return ok(id, { ...receipt, manifestHash, coverageDigest: coverage.digest });
    }
    if (verb === "activate") {
      const operationId = required(input.operation, "--operation");
      const operator = required(input.operator, "--operator");
      const manifest = document<ExecutionManifestDocument>(input.manifest, "--manifest");
      const inventoryPath = reviewedInventory(manifest, input, verb);
      const coverage = coverageSet(input, manifest, verb);
      const attestation = document<ActivationAttestation>(input.attestation, "--attestation");
      const manifestHash = executionManifestHash(manifest);
      const receipt = await activateExecutionMigration({ context, operationId, operator, ...(inventoryPath === undefined ? {} : { inventoryPath }), manifestId: manifest.id, manifestHash, expectedEpoch: manifest.epoch, attestation, coverageDigest: coverage.digest });
      return ok(id, { ...receipt, manifestHash, expectedEpoch: manifest.epoch, coverageDigest: coverage.digest });
    }
    if (verb === "retire") {
      const operationId = required(input.operation, "--operation");
      const operator = required(input.operator, "--operator");
      const manifest = document<ExecutionManifestDocument>(input.manifest, "--manifest");
      const inventoryPath = reviewedInventory(manifest, input, verb);
      const manifestHash = executionManifestHash(manifest);
      const receipt = await retireExecutionSources({ context, operationId, operator, ...(inventoryPath === undefined ? {} : { inventoryPath }), manifestId: manifest.id, manifestHash });
      return ok(id, { ...receipt, manifestHash });
    }
    if (verb === "abort") {
      const operationId = required(input.operation, "--operation");
      const operator = required(input.operator, "--operator");
      const reason = required(input.reason, "--reason");
      const manifest = document<ExecutionManifestDocument>(input.manifest, "--manifest");
      const manifestHash = executionManifestHash(manifest);
      const receipt = await abortExecutionMigration({ context, operationId, operator, manifestId: manifest.id, manifestHash, reason });
      return ok(id, { ...receipt, manifestHash });
    }
    if (verb === "restore-preview") {
      const backupPath = absolute(required(input.backup, "--backup"), "--backup")!;
      const preview = await previewExecutionRestore(context, backupPath);
      const out = absolute(input.out, "--out", true);
      if (out !== undefined) writeFileSync(out, `${JSON.stringify(preview, null, 2)}\n`);
      return ok(id, { ...preview, previewFile: out ?? null });
    }
    if (verb === "restore") {
      const operator = required(input.operator, "--operator");
      const authorization = required(input.authorization, "--authorization");
      const preview = document<ExecutionRecoveryPreview>(input.preview, "--preview");
      if (typeof preview.lossDigest !== "string" || !lossDigestPattern.test(preview.lossDigest)) throw new SddScriptError("--preview carries no canonical loss digest", 2);
      const acceptLossDigest = requireDigest(input);
      const receipt = await restoreExecutionBackup(context, { preview, acceptLossDigest, operator, authorization });
      const out = absolute(input.out, "--out", true);
      if (out !== undefined) writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
      return ok(id, { ...receipt, receiptFile: out ?? null });
    }
    if (verb === "export") {
      const artifact = await exportExecutionState(context);
      const out = absolute(input.out, "--out", true);
      if (out !== undefined) writeFileSync(out, artifact.canonicalJson.endsWith("\n") ? artifact.canonicalJson : `${artifact.canonicalJson}\n`);
      return ok(id, { format: artifact.format, sha256: artifact.sha256, out: out ?? null, canonicalJson: artifact.canonicalJson });
    }
    throw new Error(`unsupported store execution command ${id}`);
  } catch (error) { return refused(id, error); }
}

function cliDefinition(id: string): CommandDefinition<ExecutionInput, unknown> {
  const verb = id.slice("store.execution.".length);
  const flags: Record<keyof ExecutionInput, string> = {
    harness: "--harness <path>", operation: "--operation <id>", operator: "--operator <name>", inventory: "--inventory <path>",
    out: "--out <path>", coverageOut: "--coverage-out <path>", manifest: "--manifest <path>", coverage: "--coverage <path>",
    backup: "--backup <path>", attestation: "--attestation <path>", reason: "--reason <text>", preview: "--preview <path>",
    acceptLossDigest: "--accept-loss-digest <hex>", authorization: "--authorization <ref>",
  };
  const options = Object.keys(inputSchema.shape).map((key) => ({ key, flags: flags[key as keyof ExecutionInput]!, required: false }));
  return {
    id, cli: { path: ["store", "execution", verb], aliases: [], arguments: [], options }, input: inputSchema,
    output: commandEnvelopeSchema, effects: writeVerbs[verb] === true ? ["read", "write"] : verb === "preview" ? ["read", "write"] : ["read"],
    description: `Store execution ${verb} operation; engine enforces reviewed migration and recovery barriers.`,
    execute: (input, invocation) => execute(id, input, invocation),
  };
}

export function getExecutionCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => cliDefinition(`store.execution.${verb}`));
}
