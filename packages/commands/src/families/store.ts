import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  SddScriptError,
  StoreError,
  activateStore,
  activationReceiptFor,
  appliedReceiptFor,
  applyStoreMigration,
  backupStore,
  initializeStore,
  planStoreMigration,
  resolveProcessHarnessDir,
  retireStoreSources,
  upgradeStoreMinimal,
  type ActivationAttestation,
  type MigrationManifest,
  type StoreContext,
} from "@mstar-harness/engine";
import { z } from "zod";
import type { CommandDefinition, CommandEffect, CommandEnvelope, InvocationContext } from "../types.js";
import { commandEnvelopeSchema } from "../definitions.js";
import { refusalEnvelope } from "../envelope.js";

const inputSchema = z.object({
  harness: z.string().optional(),
  apply: z.boolean().optional(),
  manifest: z.string().optional(),
  attestation: z.string().optional(),
  out: z.string().optional(),
  operator: z.string().optional(),
});
type StoreInput = z.infer<typeof inputSchema>;
const verbs = ["init", "upgrade", "migrate", "backup", "activate", "retire"] as const;

function ok(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}
function refused(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : `${id}.internal-error`;
  return error instanceof SddScriptError
    ? refusalEnvelope({ command: id, status: "usage", code: "usage", exitCode: 2, message })
    : refusalEnvelope({ command: id, status: "refused", code, exitCode: 1, message , recovery: id === "store.init"
        ? "Choose an empty harness root or resolve the legacy files that block creation. Run mstar store init."
        : id === "store.upgrade"
          ? "Correct the operator input and legacy-store state named by the upgrade diagnostic. Run mstar store upgrade."
          : id === "store.migrate"
            ? "Correct the legacy source layout or manifest named by the migration diagnostic. Run mstar store migrate."
            : id === "store.backup"
              ? "Choose a writable backup destination and confirm the active store is readable. Run mstar store backup."
              : id === "store.activate"
                ? "Align the migration manifest and activation attestation to the same verified store state. Run mstar store activate."
                : "Resolve the retirement preconditions and recorded activation evidence named by the diagnostic. Run mstar store retire."});
}

function findLegacyWorkspaceFact(harnessDir: string): string | null {
  const storePath = path.join(harnessDir, "store.db");
  if (existsSync(storePath)) return `a store already exists at ${storePath} — migrate or activate instead of initializing`;
  const projectsDir = path.join(harnessDir, "projects");
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && existsSync(path.join(projectsDir, entry.name, "residuals.json"))) {
        return "legacy project residual registers require the staged catalog migration; use the staged migration, not store init";
      }
    }
  }
  if (existsSync(path.join(harnessDir, "iterations", "README.md"))) {
    return "the maintained iterations catalog index requires the staged catalog migration; use the staged migration, not store init";
  }
  return null;
}
function contextOf(input: StoreInput, invocation: InvocationContext): StoreContext {
  const resolved = resolveProcessHarnessDir(invocation.cwd, input.harness);
  const harnessDir = resolved ?? (input.harness === undefined ? invocation.cwd : path.resolve(input.harness));
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
  // The absolute-path boundary is decided BEFORE the read: a relative value is
  // caller input, and its own diagnostic must not be masked by the I/O error
  // handling below.
  const absolute = absoluteFile(value, flag);
  let text: string;
  try { text = readFileSync(absolute, "utf8"); }
  catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
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
  const missing = fields.filter((field) => typeof input[field] !== "string" || input[field]!.trim() === "");
  if (missing.length > 0) {
    throw new SddScriptError(`${missing.map((field) => `--${field}`).join(", ")} ${missing.length === 1 ? "is" : "are"} required`, 2);
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
      case "store.upgrade": {
        requireInputs(input, ["operator"]);
        // The schema cutover's safety disposal needs the existing operator/stop
        // attestation when a retired plan-PM claim is present. The engine's own
        // validator is the authority; the CLI reads the absolute JSON file and
        // hands the parsed document through unchanged. Omitting it is valid when
        // no retired claim exists.
        const attestation = input.attestation === undefined
          ? undefined
          : jsonFile<ActivationAttestation>(input.attestation, "--attestation");
        return ok(id, await upgradeStoreMinimal({
          context,
          operator: required(input.operator, "--operator"),
          operationId: randomUUID(),
          ...(attestation === undefined ? {} : { attestation }),
        }));
      }
      case "store.backup": {
        const out = outputPath(input.out, invocation.cwd);
        const receipt = await backupStore(context, out === undefined ? {} : { out });
        return ok(id, { ...receipt, out: out ?? null });
      }
      case "store.migrate": {
        if (input.apply !== true && input.manifest !== undefined) throw new SddScriptError("--manifest is only meaningful with --apply", 2);
        if (input.apply === true) {
          const manifest = jsonFile<MigrationManifest>(required(input.manifest, "--manifest"), "--manifest");
          if (manifest === null || typeof manifest !== "object" || manifest.version === undefined) throw new SddScriptError("--manifest does not carry a MigrationManifest", 2);
          return ok(id, await applyStoreMigration(context, manifest));
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
    return refused(id, error);
  }
}

/**
 * The operator stop attestation `store upgrade --attestation <absolute-json>`
 * reads: the full `ActivationAttestation` the engine validates before any
 * schema change. Published under its own document-contract key — the
 * `--attestation` option stays a plain path string, never an inline JSON
 * field.
 */
const attestationDocumentSchema = z.object({
  version: z.literal(1),
  attestedAt: z.string().min(1),
  operator: z.object({ actor: z.string().min(1), authorizationRef: z.string().min(1) }),
  consumers: z.array(z.object({
    entryId: z.string().min(1),
    kind: z.enum(["cli", "host-plugin", "hook", "coordinator"]),
    entrypoint: z.string().min(1),
    runtime: z.enum(["bun", "node"]),
    runtimeVersion: z.string().min(1),
    version: z.string().min(1),
    current: z.boolean(),
    disposition: z.enum(["reloaded", "upgraded", "excluded:not-this-control-root", "excluded:no-store-access", "excluded:superseded-binary"]),
  })).min(1),
  stoppedSessions: z.array(z.object({
    sessionId: z.string().min(1),
    host: z.string().min(1),
    state: z.enum(["stopped", "reloaded"]),
  })),
});

function cliDefinition(id: string): CommandDefinition<StoreInput, unknown> {
  const verb = id.slice("store.".length) as (typeof verbs)[number];
  const optionFlags: Record<keyof StoreInput, string> = {
    harness: "--harness <path>", apply: "--apply", manifest: "--manifest <path>", attestation: "--attestation <absolute-json>", out: "--out <path>",
    operator: "--operator <name>",
  };
  const optionsByVerb: Record<(typeof verbs)[number], (keyof StoreInput)[]> = {
    init: ["harness"],
    upgrade: ["harness", "operator", "attestation"],
    migrate: ["harness", "apply", "manifest", "out"],
    backup: ["harness", "out"],
    activate: ["harness", "manifest", "attestation", "out"],
    retire: ["harness", "manifest", "out"],
  };
  const optionHelp: Partial<Record<keyof StoreInput, string>> = {
    harness: "project harness directory, including the canonical control root; defaults to discovery from the working directory",
    attestation: "absolute path to the operator's full ActivationAttestation JSON; optional when no retired held claim exists, required when one does \u2014 the same `mstar store upgrade --operator <name> --attestation <absolute-json>` call retries after a refusal",
  };
  const optionKeys = optionsByVerb[verb];
  const shape = Object.fromEntries(optionKeys.map((key) => [key, true])) as { [Key in keyof StoreInput]?: true };
  const options = optionKeys.map((key) => ({
    key,
    flags: optionFlags[key],
    required: false,
    ...(optionHelp[key] === undefined ? {} : { help: optionHelp[key] }),
  }));
  return {
    id,
    cli: { path: ["store", verb], aliases: [], arguments: [], options },
    input: inputSchema.pick(shape),
    ...(verb === "upgrade" ? { payloads: { existingActivationAttestation: { schema: attestationDocumentSchema } } } : {}),
    output: commandEnvelopeSchema,
    effects: ({
      init: ["read", "write"],
      upgrade: ["read", "write"],
      migrate: ["read", "write"],
      backup: ["read", "write"],
      activate: ["read", "write"],
      retire: ["read", "write"],
    } satisfies Record<(typeof verbs)[number], readonly CommandEffect[]>)[verb],
    description: `${verb === "upgrade"
      ? "Open or create the issue store, import recognizable execution state, activate the authority, and report skipped items."
      : `Store ${verb} operation.`} The canonical control root is a supported project harness.`,
    execute: (input, invocation) => execute(id, input, invocation),
  };
}

export function getStoreCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => cliDefinition(`store.${verb}`));
}
