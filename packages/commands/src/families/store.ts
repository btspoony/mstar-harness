import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  SddScriptError,
  StoreError,
  activateStore,
  activateStoreUpgrade,
  activationReceiptFor,
  appliedReceiptFor,
  applyStoreMigration,
  backupStore,
  initializeStore,
  planStoreMigration,
  probeStoreUpgradeState,
  resolveProcessHarnessDir,
  retireStoreSources,
  stageStoreUpgrade,
  upgradeStore,
  type ActivationAttestation,
  type MigrationManifest,
  type StagedStoreUpgrade,
  type StoreContext,
} from "@mstar-harness/engine";
import { z } from "zod";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";
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
const writeVerbs: Record<string, true> = { init: true, upgrade: true, backup: true, activate: true, retire: true };

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
  catch (error) { throw new SddScriptError(`${flag} could not be read: ${error instanceof Error ? error.message : String(error)}`, 2); }
  try { return JSON.parse(text) as T; }
  catch { throw new SddScriptError(`${flag} is not valid JSON`, 2); }
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
function storeUpgradeFailure(id: string, error: unknown): CommandEnvelope<never> {
  if (error instanceof SddScriptError) return refused(id, error);
  const code =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  const message =
    code === "execution.migration-conflict"
      ? "A saved workflow has a pending change that cannot be safely published. Review or resolve the workspace's pending changes, then run `store upgrade` again."
      : code === "execution.coverage-incomplete"
        ? "The workspace discovery is incomplete. Complete its inventory, then run `store upgrade` again."
        : code === "store.attestation-invalid" || code === "store.activation-blocked"
          ? "The installed consumers or active sessions are not ready for the authority change. Reload or update consumers and stop active sessions, then run `store upgrade` again."
          : "The workspace's saved execution data could not be migrated safely. Resolve the incomplete or conflicting workflow state, then run `store upgrade` again.";
  return { version: 1, command: id, status: "refused", code: "store.upgrade-blocked", exitCode: 1, message };
}

async function unifiedStoreUpgrade(
  id: string,
  input: StoreInput,
  context: StoreContext,
  invocation: InvocationContext,
): Promise<CommandEnvelope> {
  const state = await probeStoreUpgradeState(context);
  if (state.verdict === "up-to-date") {
    return ok(id, { verdict: state.verdict, schemaVersion: state.schemaVersion });
  }
  if (state.verdict === "blocked") {
    return {
      version: 1,
      command: id,
      status: "refused",
      code: "store.upgrade-blocked",
      exitCode: 1,
      message: "No store exists in this workspace. Initialize it with `store init`, then run `store upgrade`.",
    };
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

  try {
    const receipt = await activateStoreUpgrade(staged, attestation);
    return ok(id, {
      verdict: "upgraded",
      schemaVersion: staged.manifest.schemaVersion,
      authorityState: "active",
      sourcesRetired: receipt.phase === "retired",
    });
  } catch (error) {
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
      case "store.upgrade": return unifiedStoreUpgrade(id, input, context, invocation);
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
    description:
      verb === "upgrade"
        ? "Report store readiness; ask once for authority-switch approval and the disposition of any unpublished catalog change, then stage, activate, and retire migrated workflow files."
        : `Store ${verb} operation; engine enforces migration, activation, recovery and mutation barriers.`,
    execute: (input, invocation) => execute(id, input, invocation),
  };
}

export function getStoreCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => cliDefinition(`store.${verb}`));
}
