import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  SddScriptError,
  StoreError,
  abortExecutionMigration,
  activateStore,
  activateStoreUpgrade,
  activationReceiptFor,
  appliedReceiptFor,
  applyStoreMigration,
  backupStore,
  initializeExecutionAuthority,
  initializeStore,
  planStoreMigration,
  probeStoreUpgradeState,
  resolveProcessHarnessDir,
  retireStoreSources,
  retireExecutionSources,
  stageStoreUpgrade,
  upgradeStore,
  upgradeStoreWithRecoveryPoint,
  executionManifestHash,
  type ActivationAttestation,
  type MigrationManifest,
  type StagedStoreUpgrade,
  type StoreContext,
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
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  const diagnostics: Record<string, { blocker: string; recovery: string }> = {
    "execution.migration-conflict": {
      blocker: "The staged migration conflicts with current workspace state; its reviewed evidence may no longer match.",
      recovery: "Do not rerun this staged attempt. `store upgrade` will ask you to confirm abandoning it, then create and review a fresh migration.",
    },
    "execution.coverage-incomplete": {
      blocker: "The legacy execution source is missing required completeness evidence.",
      recovery: "Complete the missing source or stop-session evidence; provide an inventory only if discovery inventory is the missing item, then rerun `store upgrade`.",
    },
    "store.attestation-invalid": {
      blocker: "The activation attestation is invalid or contradictory.",
      recovery: "Correct the operator-supplied attestation and rerun `store upgrade`.",
    },
    "store.activation-blocked": {
      blocker: "A required installed-consumer or stopped-session readiness condition is unmet.",
      recovery: "Reload or update the affected consumer and confirm active sessions are stopped in the attestation, then rerun `store upgrade`.",
    },
    "store.attestation-missing": {
      blocker: "The activation attestation file was not found.",
      recovery: "Provide an existing readable attestation file and rerun `store upgrade`.",
    },
    "store.attestation-unreadable": {
      blocker: "The activation attestation file could not be read.",
      recovery: "Provide a readable attestation file and rerun `store upgrade`.",
    },
    "store.attestation-malformed": {
      blocker: "The activation attestation file is malformed.",
      recovery: "Provide a readable, valid JSON attestation file and rerun `store upgrade`.",
    },
    "store.operator-file-missing": {
      blocker: "The operator-supplied file was not found.",
      recovery: "Provide an existing readable file and rerun the command.",
    },
    "store.operator-file-unreadable": {
      blocker: "The operator-supplied file could not be read.",
      recovery: "Provide a readable file and rerun the command.",
    },
    "store.operator-file-malformed": {
      blocker: "The operator-supplied file is malformed.",
      recovery: "Provide a readable, valid JSON file and rerun the command.",
    },
  };
  const diagnostic = diagnostics[code];
  if (error instanceof SddScriptError && diagnostic !== undefined) {
    return { version: 1, command: id, status: "usage", code: "usage", exitCode: 2, message: `${diagnostic.blocker} ${diagnostic.recovery}` };
  }
  if (error instanceof SddScriptError) return refused(id, error);
  const refusal = diagnostic ?? {
    blocker: "The execution migration could not establish a safe upgrade.",
    recovery: "Resolve the underlying execution-source or readiness gap, then rerun `store upgrade`.",
  };
  return { version: 1, command: id, status: "refused", code: "store.upgrade-blocked", exitCode: 1, message: `${refusal.blocker} ${refusal.recovery}` };
}

async function unifiedStoreUpgrade(
  id: string,
  input: StoreInput,
  context: StoreContext,
  invocation: InvocationContext,
): Promise<CommandEnvelope> {
  let state = await probeStoreUpgradeState(context);
  if (state.verdict === "blocked") {
    return {
      version: 1,
      command: id,
      status: "refused",
      code: "store.upgrade-blocked",
      exitCode: 1,
      message: hasLegacyExecutionFiles(context.harnessDir)
        ? "No store exists, but legacy execution files are present. Preserve those files and use the supported staged migration; `store init` is not appropriate."
        : "No store exists in this empty workspace. Initialize it with `store init`, then run `store upgrade`.",
    };
  }
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

  try {
    const receipt = await activateStoreUpgrade(staged, attestation);
    return ok(id, {
      verdict: "upgraded",
      schemaVersion: staged.manifest.schemaVersion,
      authorityState: "active",
      sourcesRetired: receipt.phase === "retired",
    });
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "execution.migration-conflict") {
      invocation.effects.writeStderr?.(
        "Changed evidence means this staged migration cannot be activated. Abandon this staged migration and its staged execution rows to return to legacy authority? Type `abandon staged migration` to confirm; anything else cancels. ",
      );
      const confirmation = await invocation.effects.readInput();
      if (confirmation.trim() === "abandon staged migration") {
        await abortExecutionMigration({
          context,
          operationId: randomUUID(),
          operator,
          manifestId: staged.manifest.id,
          manifestHash: executionManifestHash(staged.manifest),
          reason: "Changed evidence; operator confirmed abandonment through store upgrade",
        });
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
