import { activationAttestationDocumentConstraints, activationAttestationDocumentSchema } from "../activation-attestation.js";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  SddScriptError,
  StoreError,
  WORKFLOW_DELIVERY_KINDS,
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
import { resolveCliPath } from "../host-health.js";
import type { CommandDefinition, CommandEffect, CommandEnvelope, InvocationContext } from "../types.js";
import { commandEnvelopeSchema } from "../definitions.js";
import { refusalEnvelope } from "../envelope.js";

/**
 * One per-lift delivery declaration for `store upgrade --delivery <json>...`
 * (the former `migrate` declaration contract). Transport shape only — the
 * per-kind coherence rule stays with the engine's shared registration rule, so
 * the CLI never maintains a second copy. The kind is the declared enum so an
 * off-enum value is a nested usage diagnostic naming the accepted values.
 */
const deliveryDeclarationSchema = z.object({
  workflow: z.string().min(1),
  deliveryKind: z.enum(WORKFLOW_DELIVERY_KINDS),
  branchSource: z.string().min(1).optional(),
  branchTarget: z.string().min(1).optional(),
  completionPolicy: z.string().min(1).optional(),
}).strict();

const inputSchema = z.object({
  harness: z.string().optional(),
  apply: z.boolean().optional(),
  manifest: z.string().optional(),
  attestation: z.string().optional(),
  out: z.string().optional(),
  operator: z.string().optional(),
  ackSkipDsh: z.array(z.string()).optional(),
  ackSkipWorkflow: z.array(z.string()).optional(),
  ackSkipCompass: z.array(z.string()).optional(),
  delivery: z.array(deliveryDeclarationSchema).optional(),
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
  if (id === "store.upgrade" && (code === "store.upgrade-dsh-ack-unmatched" || code === "execution.delivery-declaration-required" || code === "execution.workflow-skip-unmatched" || code === "execution.compass-skip-unmatched")) {
    return refusalEnvelope({ command: id, status: "usage", code, exitCode: 2, message });
  }
  return error instanceof SddScriptError
    ? refusalEnvelope({ command: id, status: "usage", code: "usage", exitCode: 2, message })
    : refusalEnvelope({
      command: id,
      status: "refused",
      code,
      exitCode: 1,
      message,
      recovery: code === "store.runtime-unsupported"
        ? "This command needs a runtime that provides native node:sqlite: install or select Node.js >=24.18.0 on PATH, then rerun the store verb you invoked with the same options — mstar store init, mstar store upgrade --operator <name> --harness <control-root>, mstar store backup --out <path>, mstar store migrate --manifest <path> --apply, mstar store activate --manifest <path> --attestation <absolute-json>, or mstar store retire --manifest <path>. An existing store is untouched by this refusal, so nothing needs repair first."
        : id === "store.init" && (message.includes("legacy execution state exists at ") || message.includes("legacy catalog data exists at "))
        ? "For a fresh workspace, run mstar harness scaffold then mstar store init; to preserve historical files, run mstar store upgrade --operator <name> --harness <control-root>."
        : code === "store.already-exists"
          ? id === "store.upgrade"
            // An upgrade that loses the create-only publication race did not
            // finish its import: the supported continuation is the same command,
            // not the "do not migrate" instruction meant for init.
            ? "Another process already published this control root's store, so nothing was created here and its legacy import may be unfinished. Rerun mstar store upgrade --harness <same-control-root> --operator <name> to continue it, then inspect the result with mstar status validate; initialization is create-only."
            : "Inspect the existing execution authority with mstar status validate; do not initialize or migrate an existing store."
          : code === "store.created-handle-failed"
            ? "The named store is created, active and retained. Once the named condition clears, inspect it with mstar status validate; initialization is create-only. For an interrupted upgrade, run mstar store upgrade --harness <same-control-root> --operator <name>."
            : code === "store.publication-barrier-failed"
              ? "The named store is published and retained, but this call could not synchronize its directory entry. Resolve the named platform/filesystem condition, then rerun mstar store upgrade --harness <same-control-root> --operator <name> to retry the barrier and finish any remaining import or activation; initialization is create-only."
            : code === "store.publication-failed"
              ? "No store was created at the named path. Resolve the named filesystem condition (permissions, space or hard-link support). For a fresh harness, run mstar store init --harness <control-root>; for existing legacy sources, run mstar store upgrade --operator <name> --harness <control-root>. Select a hard-link-capable filesystem before either attempt."
              : id === "store.init"
                ? "Choose an empty harness root and run mstar store init."
                : code === "store.upgrade-dsh-source-refused"
                  ? "Rerun mstar store upgrade --operator <name> --ack-skip-dsh <selector> for EVERY selector the refusal names in that same retry, because its list is the union of the selectors this invocation already acknowledged (an acknowledgement is not persisted, so the unchanged root refuses them again) and the selectors this refusal names, so leaving one out refuses that source again; pass --ack-skip-workflow <id> for the ids the refusal names in that same retry: it lists the union of the ids this invocation committed (which its own retained receipt now proves were imported from these exact bytes, so repeating them is accepted and reported as unnecessary) and the original acknowledgements this unchanged root still requires, such as a duplicated v1 plan id, and omitting the latter refuses that source again before the legacy Dsh phase; repeat that invocation's --delivery <json> declarations and --ack-skip-compass <iteration-id> acknowledgements when the source is a v1 root, because the unchanged root still needs one delivery declaration per active standalone plan lift and still refuses that non-regular compass; the message names every value to repeat. Ordinary retry remains available."
                  : id === "store.upgrade"
                    ? "Correct the operator input and legacy-store state named by the upgrade diagnostic, then run mstar store upgrade --operator <name>."
                    : id === "store.migrate"
                      ? "Correct the legacy source layout or manifest named by the migration diagnostic. Run mstar store migrate."
                      : id === "store.backup"
                        ? "Choose a writable backup destination and confirm the active store is readable. Run mstar store backup."
                        : id === "store.activate"
                          ? "Align the migration manifest and activation attestation to the same verified store state. Run mstar store activate."
                          : "Resolve the retirement preconditions and recorded activation evidence named by the diagnostic. Run mstar store retire.",
    });
}

function findLegacyWorkspaceFact(harnessDir: string): string | null {
  const storePath = path.join(harnessDir, "store.db");
  if (existsSync(storePath)) return `a store already exists at ${storePath} — inspect it with mstar status validate instead of initializing`;
  const projectsDir = path.join(harnessDir, "projects");
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const residualsPath = path.join(projectsDir, entry.name, "residuals.json");
        if (existsSync(residualsPath)) return `legacy catalog data exists at ${residualsPath} and prevents store initialization`;
      }
    }
  }
  const statusPath = path.join(harnessDir, "status.json");
  if (existsSync(statusPath)) return `legacy execution state exists at ${statusPath} and prevents store initialization. For a fresh workspace, run "mstar harness scaffold" then "mstar store init"; to preserve historical file state, run "mstar store upgrade --operator <name> --harness <control-root>"`;
  const workflowsDir = path.join(harnessDir, "workflows");
  if (existsSync(workflowsDir)) {
    for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const snapshotPath = path.join(workflowsDir, entry.name, "snapshot.json");
        if (existsSync(snapshotPath)) return `legacy execution state exists at ${snapshotPath} and prevents store initialization. For a fresh workspace, run "mstar harness scaffold" then "mstar store init"; to preserve historical file state, run "mstar store upgrade --operator <name> --harness <control-root>"`;
      }
    }
  }
  const iterationsIndex = path.join(harnessDir, "iterations", "README.md");
  if (existsSync(iterationsIndex)) {
    return `legacy catalog data exists at ${iterationsIndex} and prevents store initialization`;
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
  return value === undefined ? undefined : resolveCliPath(value, cwd);
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
        const invalidAck = input.ackSkipDsh?.filter((selector) => {
          if (selector === "dsh-status" || selector === "dsh-workflows") return false;
          const match = /^dsh-(?:ledger|bounds):(.+)$/.exec(selector);
          return !match || match[1] === "." || match[1] === ".." || match[1]!.includes("/");
        }) ?? [];
        if (invalidAck.length) {
          throw Object.assign(new SddScriptError(`invalid --ack-skip-dsh selector: ${invalidAck.join(", ")}`, 2), {
            code: "store.upgrade-dsh-ack-unmatched",
          });
        }
        return ok(id, await upgradeStoreMinimal({
          context,
          operator: required(input.operator, "--operator"),
          operationId: randomUUID(),
          ...(attestation === undefined ? {} : { attestation }),
          ...(input.ackSkipDsh === undefined ? {} : { acknowledgedSkips: input.ackSkipDsh }),
          ...(input.ackSkipWorkflow === undefined ? {} : { acknowledgedWorkflowSkips: input.ackSkipWorkflow }),
          ...(input.ackSkipCompass === undefined ? {} : { acknowledgedCompassSkips: input.ackSkipCompass }),
          ...(input.delivery === undefined ? {} : { deliveryDeclarations: input.delivery }),
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
 * The engine validates the full operator attestation. Its published schema and
 * semantic constraints are shared with terminal adoption; the option remains
 * a file path and is never an inline JSON input.
 */

function cliDefinition(id: string): CommandDefinition<StoreInput, unknown> {
  const verb = id.slice("store.".length) as (typeof verbs)[number];
  const optionFlags: Record<keyof StoreInput, string> = {
    harness: "--harness <path>", apply: "--apply", manifest: "--manifest <path>", attestation: "--attestation <absolute-json>", out: "--out <path>",
    operator: "--operator <name>",
    ackSkipDsh: "--ack-skip-dsh <selector...>",
    ackSkipWorkflow: "--ack-skip-workflow <id...>",
    ackSkipCompass: "--ack-skip-compass <iteration-id...>",
    delivery: "--delivery <json...>",
  };
  const optionsByVerb: Record<(typeof verbs)[number], (keyof StoreInput)[]> = {
    init: ["harness"],
    upgrade: ["harness", "operator", "attestation", "ackSkipDsh", "ackSkipWorkflow", "ackSkipCompass", "delivery"],
    backup: ["harness", "out"],
    migrate: ["harness", "apply", "manifest", "out"],
    activate: ["harness", "manifest", "attestation", "out"],
    retire: ["harness", "manifest", "out"],
  };
  const optionKeys = optionsByVerb[verb]!;
  const attestationHelp = activationAttestationDocumentConstraints.map(({ path, rule }) => `${path}: ${rule}`).join(" ");
  const optionHelp: Partial<Record<keyof StoreInput, string>> = {
    harness: "project harness directory, including the canonical control root; defaults to discovery from the working directory",
    attestation: `absolute path to the operator's full ActivationAttestation JSON; optional when no retired held claim exists, required when one does — retry with the same \`mstar store upgrade --operator <name> --attestation <absolute-json>\` call. ${attestationHelp}`,
    ackSkipDsh: "Explicitly drop legacy DSH host-state facts this run refused. Selectors: dsh-ledger:<workflowId>, dsh-bounds:<workflowId>, dsh-status, or dsh-workflows (a symlinked workflows tree). The refusal lists exact facts; importable facts still import. The commit report states the exact loss. Default never skips. Source bytes remain unchanged and ordinary upgrade remains retryable.",
    ackSkipWorkflow: "Explicitly skip IMPORTING the named registered workflows whose legacy execution source this run refuses. A registered source is refused when its whole `workflows/` root or per-workflow path is not a real in-root directory \u2014 a symlink (never followed) or a non-directory path \u2014 or when a recognized legacy source's id already exists in the native execution authority WITHOUT a retained import receipt for this run's exact source bytes (an upgrade never overwrites, deletes or silently omits an existing native workflow). Pass the exact original workflow ids (repeat or space-separate; a repeated id is harmless). Either way the native rows and the source bytes stay in place, no execution row is imported or fabricated for the named id, and the report records the skipped import with its loss. A collision this store's OWN retained import receipt already proves was imported from these exact source bytes is a PROVEN REPLAY: it needs no acknowledgement, is reported in dispositions as already current and already held by the native authority, and acknowledging it anyway is accepted but reported as unnecessary. Source bytes alone prove a replay only for a run carrying no --delivery/--ack-skip-compass input; a run that carries either needs the receipt to record the same input, because an earlier import of these bytes may have converted them from a different declaration set, so a receipt without that record leaves the id an unproven collision (the refusal says so, and the native row keeps its original shape). Skipping a source this run does NOT refuse is rejected, because that would silently drop a trusted source. Separate from --ack-skip-dsh, which can never discard a registered execution source. Default never skips.",
    delivery: `Declare the delivery kind of one active standalone v1 plan this upgrade lifts; repeat once per such lift (an active standalone v1 plan fixes its delivery kind at registration and cannot be closed without one, so the upgrade refuses before registering any of them until each is declared). Each value is one JSON object {"workflow": <lifted id>, "deliveryKind": "${WORKFLOW_DELIVERY_KINDS.join('" | "')}", plus "branchSource"/"branchTarget" for development or "completionPolicy" for verification/report-only}. Completed v1 rows, already-declared v2 snapshots and iterations need none; an entry addressing no active standalone lift is refused, never ignored.`,
    ackSkipCompass: "Acknowledge dropping a v1 iteration's grouping when its canonical `iterations/<iteration-id>/delivery-compass.md` is not a regular in-root file (a link, FIFO, socket or device is never read). Pass the iteration DIRECTORY name the refusal names (repeat or space-separate; a repeated id is harmless): the compass is not read, that iteration produces no lifecycle, and the plans it registered convert as standalone plan rows instead \u2014 an active standalone lift then needs its own --delivery declaration, and the receipt names the skipped iteration and that loss. An id that names no compass this run refuses is rejected, because that would silently spend an acknowledgement on nothing. Default never skips.",
  };
  const shape = Object.fromEntries(optionKeys.map((key) => [key, true])) as { [Key in keyof StoreInput]?: true };
  const options = optionKeys.map((key) => ({
    key,
    flags: optionFlags[key],
    required: false,
    variadic: key === "ackSkipDsh" || key === "ackSkipWorkflow" || key === "ackSkipCompass" || key === "delivery",
    ...(optionHelp[key] === undefined ? {} : { help: optionHelp[key] }),
  }));
  return {
    id,
    cli: { path: ["store", verb], aliases: [], arguments: [], options },
    input: inputSchema.pick(shape),
    ...(verb === "upgrade"
      ? { payloads: { existingActivationAttestation: { schema: activationAttestationDocumentSchema }, delivery: { schema: z.array(deliveryDeclarationSchema), help: optionHelp.delivery } } }
      : {}),
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
      ? "Open or create the issue store, import recognizable execution state, activate the authority, and report skipped items. The optional --ack-skip-workflow <id>... explicitly skips importing named workflows whose legacy source this run refuses: a registered source that is not a real in-root directory (a linked or non-directory path), a registered source whose nested bytes cannot be read as a workflow (a linked entry, a non-regular snapshot, a session path that is not a real directory, a plan row that is missing, duplicated or unconvertible), a converted v1 lifecycle whose converted plan rows cannot be imported, or a recognized legacy id the native authority already holds with NO retained import receipt for this run's exact source bytes. A collision this store's own retained import receipt already records as imported from these exact bytes is a proven replay: it needs no acknowledgement and reports verdict \"nothing-to-import\" with the id named in dispositions. Because source bytes cannot prove which --delivery/--ack-skip-compass input an earlier import consumed, a run that carries neither relies on those bytes alone (so an older receipt still proves the replay), while a run that carries either needs the receipt to record the same input or its colliding id stays unproven. A duplicated v1 plan id is that id's own refused, skippable source: the first row in stable order (plan id, owning lifecycle id, row ordinal) survives and --ack-skip-workflow <plan id> acknowledges losing exactly the later duplicate rows. The separate --ack-skip-compass <iteration-id>... answers a non-regular v1 iteration compass: the compass is not read, that iteration produces no lifecycle, and the plans it registered convert as standalone plan rows. Every skip is reported with its loss."
      : `Store ${verb} operation.`} The canonical control root is a supported project harness.`,
    execute: (input, invocation) => execute(id, input, invocation),
  };
}

export function getStoreCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => cliDefinition(`store.${verb}`));
}
