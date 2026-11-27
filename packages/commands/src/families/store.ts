import { activationAttestationDocumentConstraints, activationAttestationDocumentSchema } from "../activation-attestation.js";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  SddScriptError,
  StoreError,
  WORKFLOW_DELIVERY_KINDS,
  activateCollaborationCutover,
  activateStore,
  activationReceiptFor,
  appliedReceiptFor,
  applyCollaborationCutover,
  applyStoreMigration,
  backupRepositoryStores,
  ensureCollaborationAuthority,
  initializeStore,
  planCollaborationCutover,
  planStoreMigration,
  resolveProcessHarnessDir,
  adoptCollaborationBinding,
  restoreCollaborationBackup,
  retireStoreSources,
  upgradeExistingCollaborationStore,
  advanceSchemaWithGeneratedAttestation,
  upgradeStoreMinimal,
  validateActivationAttestation,
  bindRemoteAuthority,
  ingestRemoteObservation,
  prepareRemoteAdoption,
  readRemoteStatus,
  type ActivationAttestation,
  type CutoverManifest,
  type MigrationManifest,
  type RepositoryBackupReceipt,
  type StoreContext,
} from "@mstar-harness/engine";
import { z } from "zod";
import { getStoreRemoteOutboxCommandDefinitions } from "./store-remote-outbox.js";
import {
  remoteAdoptionDocumentSchema,
  remoteBindDocumentSchema,
  remoteObserveDocumentSchema,
} from "../store-remote-documents.js";
import { resolveCliPath } from "../host-health.js";
import type { CommandDefinition, CommandEffect, CommandEnvelope, InvocationContext } from "../types.js";
import { commandEnvelopeSchema } from "../envelope.js";
import { refusalEnvelope } from "../envelope.js";
import { engineErrorFacts } from "./family-refusal.js";

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
  backup: z.string().optional(),
  expectStore: z.string().optional(),
  operator: z.string().optional(),
  ackSkipDsh: z.array(z.string()).optional(),
  ackSkipWorkflow: z.array(z.string()).optional(),
  ackSkipCompass: z.array(z.string()).optional(),
  delivery: z.array(deliveryDeclarationSchema).optional(),
  input: z.string().optional(),
  project: z.string().optional(),
  issue: z.string().optional(),
  operation: z.string().optional(),
});
type StoreInput = z.infer<typeof inputSchema>;
const verbs = ["init", "upgrade", "migrate", "backup", "activate", "retire"] as const;
const collaborationVerbs = ["plan", "apply", "activate", "restore", "adopt"] as const;
const remoteVerbs = ["status", "bind", "observe", "adopt-issue"] as const;

/** note: The one flag table both store families publish. */
const optionFlags: Record<keyof StoreInput, string> = {
  harness: "--harness <path>", apply: "--apply", manifest: "--manifest <path>", attestation: "--attestation <absolute-json>", out: "--out <path>",
  backup: "--backup <path>",
  expectStore: "--expect-store <store-id>",
  operator: "--operator <name>",
  ackSkipDsh: "--ack-skip-dsh <selector...>",
  ackSkipWorkflow: "--ack-skip-workflow <id...>",
  ackSkipCompass: "--ack-skip-compass <iteration-id...>",
  delivery: "--delivery <json...>",
  input: "--input <file|->",
  project: "--project <local-project-id>",
  issue: "--issue <provider-issue-id>",
  operation: "--operation <uuid>",
};

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
    // invariant: these branches recover through runtime-selected store verbs, so no single statically provable command covers them.
    // reachability: manual — the repo-identity, cutover-not-quiescent, cutover-unconfirmed and not-initialized branches recover through runtime-selected store verbs, persisted-evidence inspection, or the collaboration-restore route whose required flags directly follow the registered verb name, so the action-word candidate scan cannot parse them; no single statically provable command covers these branches
    : refusalEnvelope({
      command: id,
      status: "refused",
      code,
      exitCode: 1,
      message,
      // invariant: Execution initialization is the one store verb a remote checkout
      // runs AFTER its cache exists, so its recovery names the bootstrap order and
      // never the binding-free `store init` route the generic branches assume.
      // Literal branches only: the repository's refusal-quality lint proves the
      // text statically, so every code the engine can emit carries the family's
      // own words for the exact route instead of a composed variable.
      // invariant: An engine-authored recovery is forwarded verbatim, never restated: it is the
      // single owner of that code's repair route, so this chain only supplies the text for
      // codes the engine does not own.
      recovery: engineErrorFacts(error).recovery ?? (id === "store.init" && (code === "remote.unavailable" || code === "remote.selector-unavailable")
        ? "Store init never creates a remote cache: access to the canonical origin and the protected selector ref is the prerequisite, and the checkout is inspected with mstar path resolve. Then check mstar store collaboration remote status --harness <abs>, have the Host Agent verify the selected scope, complete the reviewed bind with mstar store collaboration remote bind --harness <abs> --input <file|->, and retry mstar store init --harness <abs>."
        // invariant: A stale binding is mode-specific, so the recovery names both modes instead of
        // replacing the local/mirror adoption route with instructions for another checkout.
        : id === "store.init" && code === "collaboration.stale-binding"
        ? "Store init never creates or adopts an authority this checkout is not bound to: inspect the checkout with mstar path resolve and correct its origin or .mstarc mode. A remote checkout whose selector moved or whose binding is stale re-establishes its cache with mstar store collaboration remote bind --harness <abs> --input <file|->, then retries mstar store init --harness <abs>. A local or mirror checkout that holds no finalized binding for its own published authority adopts it with mstar store collaboration adopt --harness <abs> --expect-store <store-id>; a checkout that now resolves to another repository starts a new checkout instead."
        : code === "store.attestation-invalid"
        // The generated-attestation refusal: Bun is never an admissible attested
        // consumer, and the supported route is the installed Node CLI (or an
        // explicit document that overrides the generated one).
        ? "Rerun the same verb through the installed Node CLI: mstar store upgrade --operator <name> --attestation <absolute-json> for an upgrade, or mstar store activate --manifest <path> --operator <name> for an activation."
        : code === "collaboration.repo-identity-unresolved" || code === "collaboration.mode-required" || code === "collaboration.mode-invalid" || code === "collaboration.mode-unavailable"
          // note: Every repository-scoped store verb needs the checkout's collaboration identity and mode.
          ? "Set the repository identity in the checkout's .mstarc — [collaboration] mode=local|mirror, plus repo_id=<lower-case-id> for a genuinely origin-less repository — then rerun the same store verb."
          : code === "collaboration.cutover-required" || code === "collaboration.cutover-conflict"
            // invariant: A combined source or a competing target is settled by the reviewed cutover, never by a guessed merge.
            ? "Run mstar store collaboration plan --harness <abs> --out <abs-manifest>, have the manifest reviewed, then apply and activate it with mstar store collaboration apply --harness <abs> --manifest <abs-manifest> and mstar store collaboration activate --harness <abs> --manifest <abs-manifest>. A source or target another activation owns is preserved, never overwritten."
            : code === "collaboration.cutover-not-quiescent"
              ? "Settle the pending mirror batches or catalog registrations the refusal names with their own verbs, stop the remaining writers, then retry the same reviewed manifest."
              : code === "collaboration.cutover-unconfirmed"
                ? "Do not retry blindly and do not treat the source as unchanged: inspect the persisted fence record, the retained pre-fence image and the source's schema and tables, then recover from that verified evidence."
                : code === "collaboration.backup-incomplete"
                  ? "Take a new verified pair with mstar store backup --out <abs-manifest>; settle any pending composite operation with its own verb first, because one surviving image is not a repository backup."
                  : code === "collaboration.not-active"
                    ? "The collaboration authority is staged, not published: run mstar store collaboration activate --harness <abs> --manifest <abs> --operator <name> --attestation <abs-json> for its reviewed activation."
                    : code === "collaboration.not-initialized"
                      ? "This checkout has no collaboration authority yet: run mstar store init for a fresh scope, mstar store upgrade --operator <name> for file-era execution state, or mstar store collaboration restore --backup <abs-manifest> for a verified pair."
                      : code === "collaboration.unreadable" || code === "collaboration.stale-binding"
                        ? "Resolve the scope again with mstar path resolve and correct the configured origin or .mstarc mode; a checkout that must bind an already published authority uses mstar store collaboration adopt --harness <abs> --expect-store <store-id>, and store init is never the binding route; a bound checkout is never retargeted by editing its mode."
        : code === "remote.selector-unavailable" || code === "remote.unavailable" || code === "collaboration.observation-incomplete" || code === "collaboration.observation-stale"
          ? "Restore Git access to the canonical origin and the protected selector ref, then inspect mstar store collaboration remote status --harness <abs>; the Host Agent refreshes the scope and resubmits mstar store collaboration remote observe --input <file|->. A required read is never answered from local rows."
          : code === "remote.input-invalid" || code === "remote.scope-mismatch" || code === "remote.denied" || code === "remote.revoked" || code === "remote.unsafe-fidelity"
              ? "Correct the document or the host's verified tenant/team/project scope, permissions and field fidelity, then resubmit mstar store collaboration remote bind|observe --input <file|-> for the checked selector commit and generation."
              : code === "store.upgrade-attestation-missing"
          // A held retired claim needs stop evidence at or after the claim instant.
          ? "Rerun the same upgrade with an explicit document whose attestedAt is at or after the claim instant: mstar store upgrade --operator <name> --attestation <absolute-json>."
          : code === "store.runtime-unsupported"
          ? "This command needs a runtime that provides native node:sqlite: install or select Node.js >=24.18.0 on PATH, then rerun the store verb you invoked with the same options — mstar store init, mstar store upgrade --operator <name> --harness <control-root>, mstar store backup --out <path>, mstar store migrate --manifest <path> --apply, mstar store activate --manifest <path> --operator <name>, or mstar store retire --manifest <path>. An existing store is untouched by this refusal, so nothing needs repair first."
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
                            ? "Align the migration manifest and activation state to the same verified store state. Run mstar store activate --manifest <path> --operator <name>."
                            : "Resolve the retirement preconditions and recorded activation evidence named by the diagnostic. Run mstar store retire."),
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
/**
 * invariant: Publish ONE operator report create-only, beside the operation it describes.
 *
 * A report is evidence, never an authority: the destination must be a NEW name,
 * so an operator can never truncate a source, a recovery manifest or a live
 * authority with serialized output — including from the read-only `plan` verb.
 * A failure to publish a report never rewrites the operation's outcome: the
 * caller keeps the committed result and discloses the reporting failure.
 */
function publishReport(
  out: string | undefined,
  value: unknown,
): { out: string | null; reportError: { code: string; message: string } | null } {
  if (out === undefined) return { out: null, reportError: null };
  const target = path.resolve(out);
  // invariant: EVERY step — directory creation, the private write, the create-only link and
  // the cleanup — sits inside this report-only boundary: a committed operation's
  // outcome is never replaced by a report failure, not even by its own cleanup.
  let tmp: string | null = null;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    linkSync(tmp, target);
    return { out: target, reportError: null };
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
    return {
      out: null,
      reportError: {
        code: "store.report-not-published",
        message:
          code === "EEXIST"
            ? `A file already exists at ${target}; a report is create-only and never overwrites an existing file. The operation itself completed as reported.`
            : `The report could not be published at ${target} (${error instanceof Error ? error.message : String(error)}). The operation itself completed as reported.`,
      },
    };
  } finally {
    if (tmp !== null) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // invariant: cleanup is best-effort scratch removal; it never decides the outcome
      }
    }
  }
}

/**
 * invariant: The create-only default manifest below the selected harness's recovery folder.
 * The receipt discloses it, so an operator who omitted `--out` still knows
 * exactly which two images and which manifest now exist.
 */
function defaultBackupManifestPath(harnessDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(harnessDir, "archived", "recovery", `repository-${stamp}-${randomUUID().slice(0, 8)}.json`);
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
  if (id.startsWith("store.collaboration.")) return executeCollaboration(id, input, invocation);
  try {
    const context = contextOf(input, invocation);
    switch (id) {
      case "store.init": {
        const fact = findLegacyWorkspaceFact(context.harnessDir);
        if (fact !== null) throw new StoreError("store.already-exists", `${fact}. Nothing was created.`);
        // note: The repository's collaboration authority comes first: a fresh init
        // creates or reuses it WITHOUT clearing it, and only this checkout's
        // execution is initialized here.
        const collaboration = await ensureCollaborationAuthority(context);
        const handle = await initializeStore(context);
        try {
          return ok(id, {
            storeId: handle.storeId,
            epoch: handle.epoch,
            schemaVersion: handle.schemaVersion,
            authorityState: "active",
            collaboration: {
              repoKey: collaboration.repoKey,
              mode: collaboration.mode,
              storeId: collaboration.storeId,
              epoch: collaboration.epoch,
              state: collaboration.state,
            },
          });
        } finally { handle.close(); }
      }
      case "store.upgrade": {
        requireInputs(input, ["operator"]);
        const operator = required(input.operator, "--operator");
        // invariant: Caller-input usage is decided before any lane is touched, so a malformed
        // selector or an unreadable attestation file leaves an existing v1 lane exactly as it was.
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
        // invariant: An existing v1 collaboration lane is advanced by the v2 migration BEFORE
        // current-only admission can refuse it with the very command the operator ran.
        const collaborationUpgrade = await upgradeExistingCollaborationStore(context, operator);
        // invariant: The two owners meet here: this checkout's collaboration authority is
        // established (create/reuse, never cleared) before the execution half
        // can report any imported state. A combined source with collaboration
        // rows refuses with the cutover route, and the import itself refuses a
        // staged lane.
        try {
          await ensureCollaborationAuthority(context);
        } catch (error) {
          // invariant: A combined source must reach this build's schema here, because the
          // reviewed cutover's source floor is the last schema a released build writes: the
          // refusal above otherwise leaves `store collaboration plan` and the terminal
          // lifecycle write unreachable. Only EXECUTION advances; collaboration rows are the
          // cutover's to move.
          if (!(error instanceof StoreError) || error.code !== "collaboration.cutover-required") throw error;
          // note: The SAME provision-and-retry the legacy-import branch uses, so the help's
          // automatic-attestation promise holds here too; it also refuses an open mirror run
          // before the schema passes the released build's ceiling.
          const schemaVersion = await advanceSchemaWithGeneratedAttestation({
            context,
            operator,
            attestation: attestation === undefined ? undefined : validateActivationAttestation(attestation),
          });
          // invariant: The refusal must disclose what it changed: the schema now stands past the
          // last released 4.9.x build's ceiling, and nothing lowers it, so that build refuses
          // this store as `store.schema-unsupported` even after the cutover. The ladder is
          // therefore this newer build's to complete — the original cause stays verbatim.
          throw new StoreError(
            "collaboration.cutover-required",
            `${error.message.replace(/^\[[^\]]+\]\s*/, "")} ` +
              `The execution schema now stands at version ${schemaVersion}, past the last released 4.9.x build's ceiling, ` +
              `and it is never lowered: that build refuses this store as \`store.schema-unsupported\` even after the cutover. ` +
              `Complete the cutover ladder with this newer build.`,
          );
        }
        const upgraded = await upgradeStoreMinimal({
          context,
          operator,
          // invariant: The caller's id seeds the operation, so a clean retry (same options, same
          // source bytes) replays its retained receipt instead of reserving a second operation.
          // The request identity is the operator, the source bytes and the declarations this run
          // consumes (--ack-skip-workflow, --ack-skip-compass, --delivery): a retry that adds one
          // is a different request and conflicts under the old id, so the advertised recovery
          // names those and never claims the same `--operation` still applies — `--operation` is
          // omitted. `--ack-skip-dsh` is host-state import state, NOT request identity: adding it
          // under the same id replays the receipt rather than conflicting.
          operationId: input.operation ?? randomUUID(),
          ...(attestation === undefined ? {} : { attestation }),
          ...(input.ackSkipDsh === undefined ? {} : { acknowledgedSkips: input.ackSkipDsh }),
          ...(input.ackSkipWorkflow === undefined ? {} : { acknowledgedWorkflowSkips: input.ackSkipWorkflow }),
          ...(input.ackSkipCompass === undefined ? {} : { acknowledgedCompassSkips: input.ackSkipCompass }),
          ...(input.delivery === undefined ? {} : { deliveryDeclarations: input.delivery }),
        });
        return ok(id, collaborationUpgrade === null ? upgraded : { ...upgraded, collaboration: collaborationUpgrade });
      }
      case "store.backup": {
        // invariant: A repository backup is the verified PAIR of both domains, never one
        // execution image sold as a full backup.
        const out = outputPath(input.out, invocation.cwd) ?? defaultBackupManifestPath(context.harnessDir);
        const receipt: RepositoryBackupReceipt = await backupRepositoryStores(context, { out: absoluteFile(out, "--out") });
        return ok(id, receipt);
      }
      case "store.migrate": {
        if (input.apply !== true && input.manifest !== undefined) throw new SddScriptError("--manifest is only meaningful with --apply", 2);
        if (input.apply === true) {
          const manifest = jsonFile<MigrationManifest>(required(input.manifest, "--manifest"), "--manifest");
          if (manifest === null || typeof manifest !== "object" || manifest.version === undefined) throw new SddScriptError("--manifest does not carry a MigrationManifest", 2);
          return ok(id, await applyStoreMigration(context, manifest));
        }
        const manifest = await planStoreMigration(context);
        const report = publishReport(outputPath(input.out, invocation.cwd), manifest);
        return ok(id, {
          controlRoot: manifest.controlRoot,
          sourceSetDigest: manifest.sourceSetDigest,
          sources: manifest.sources.map(({ project, relativePath, entryCount, sha256 }) => ({ project, relativePath, entryCount, sha256 })),
          mappings: manifest.mappings.length,
          unresolved: manifest.unresolved.length,
          catalogConflicts: manifest.catalog.conflicts.length,
          blocksApply: manifest.blocksApply,
          manifestFile: report.out,
          reportError: report.reportError,
          nextStep: manifest.blocksApply ? "resolve the unresolved mappings / catalog conflicts in review, then re-preview" : "have the manifest reviewed, then apply with --apply --manifest <path>",
        });
      }
      case "store.activate": {
        // The generated attestation records the invoking operator, so
        // `--operator` is required; `--attestation <absolute-json>` stays an
        // optional 1:1 override of the generated document, never a merge.
        requireInputs(input, ["manifest", "operator"]);
        const manifest = jsonFile<MigrationManifest>(required(input.manifest, "--manifest"), "--manifest");
        const attestation = input.attestation === undefined ? undefined : jsonFile<ActivationAttestation>(input.attestation, "--attestation");
        const applied = await appliedReceiptFor(context, manifest);
        const receipt = await activateStore(context, applied, attestation, {}, { operator: required(input.operator, "--operator") });
        const report = publishReport(outputPath(input.out, invocation.cwd), receipt);
        return ok(id, { ...receipt, out: report.out, reportError: report.reportError });
      }
      case "store.retire": {
        const manifest = jsonFile<MigrationManifest>(required(input.manifest, "--manifest"), "--manifest");
        const activation = await activationReceiptFor(context, manifest);
        const receipt = await retireStoreSources(context, activation);
        const report = publishReport(outputPath(input.out, invocation.cwd), receipt);
        return ok(id, { ...receipt, out: report.out, reportError: report.reportError });
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

/**
 * invariant: The one operator lifecycle of the collaboration authority. `--harness` names
 * an absolute operation TARGET (this checkout's harness), never a discovered
 * root, so every verb here runs against the scope the operator named and no
 * other.
 */
async function executeCollaboration(id: string, input: StoreInput, invocation: InvocationContext): Promise<CommandEnvelope> {
  const verb = id.slice("store.collaboration.".length) as (typeof collaborationVerbs)[number];
  try {
    const target = absoluteFile(required(input.harness, "--harness"), "--harness");
    const context: StoreContext = { harnessDir: path.resolve(target) };
    const out = outputPath(input.out, invocation.cwd) === undefined
      ? undefined
      : absoluteFile(outputPath(input.out, invocation.cwd)!, "--out");
    const writeReceipt = (value: unknown) => publishReport(out, value);
    if (verb === "plan") {
      const manifest = await planCollaborationCutover(context);
      const report = writeReceipt(manifest);
      return ok(id, { ...manifest, manifestFile: report.out, reportError: report.reportError });
    }
    if (verb === "apply") {
      const manifest = jsonFile<CutoverManifest>(required(input.manifest, "--manifest"), "--manifest");
      const receipt = await applyCollaborationCutover(context, manifest);
      const report = writeReceipt(receipt);
      return ok(id, { ...receipt, receiptFile: report.out, reportError: report.reportError });
    }
    if (verb === "activate") {
      requireInputs(input, ["manifest", "operator", "attestation"]);
      const manifest = jsonFile<CutoverManifest>(input.manifest!, "--manifest");
      const attestation = jsonFile<ActivationAttestation>(input.attestation!, "--attestation");
      const receipt = await activateCollaborationCutover(context, manifest, {
        operator: required(input.operator, "--operator"),
        attestation,
      });
      const report = writeReceipt(receipt);
      return ok(id, { ...receipt, receiptFile: report.out, reportError: report.reportError });
    }
    if (verb === "adopt") {
      // note: The explicit adoption verb: binds THIS checkout to an already ACTIVE
      // authority whose recorded lineage proves the exact live generation. It
      // mutates no collaboration data.
      const adoption = await adoptCollaborationBinding(context, {
        ...(input.expectStore === undefined ? {} : { expectStoreId: required(input.expectStore, "--expect-store") }),
      });
      const report = writeReceipt(adoption);
      return ok(id, { ...adoption, receiptFile: report.out, reportError: report.reportError });
    }
    if (verb === "restore") {
      requireInputs(input, ["backup", "operator", "attestation"]);
      const receipt = jsonFile<RepositoryBackupReceipt>(input.backup!, "--backup");
      const attestation = jsonFile<ActivationAttestation>(input.attestation!, "--attestation");
      const authority = await restoreCollaborationBackup(context, receipt, {
        operator: required(input.operator, "--operator"),
        attestation,
        // note: The pair is resolved beside the manifest the OPERATOR supplied, not a
        // recorded absolute path: a moved, intact pair restores from its new home.
        manifestPath: absoluteFile(required(input.backup, "--backup"), "--backup"),
      });
      const report = writeReceipt(authority);
      return ok(id, { authority, manifestPath: receipt.manifestPath, receiptFile: report.out, reportError: report.reportError });
    }
    throw new SddScriptError(`unknown store collaboration verb ${verb}`, 2);
  } catch (error) {
    return refused(id, error);
  }
}

function collaborationDefinition(verb: (typeof collaborationVerbs)[number]): CommandDefinition<StoreInput, unknown> {
  const id = `store.collaboration.${verb}`;
  const optionsByVerb: Record<(typeof collaborationVerbs)[number], (keyof StoreInput)[]> = {
    plan: ["harness", "out"],
    apply: ["harness", "manifest", "out"],
    activate: ["harness", "manifest", "operator", "attestation", "out"],
    restore: ["harness", "backup", "operator", "attestation", "out"],
    adopt: ["harness", "expectStore", "out"],
  };
  const optionKeys = optionsByVerb[verb];
  const shape = Object.fromEntries(optionKeys.map((key) => [key, true])) as { [Key in keyof StoreInput]?: true };
  const optionHelp: Partial<Record<keyof StoreInput, string>> = {
    harness: "absolute path to this checkout's harness (the operation target, never discovered from the working directory)",
    manifest: verb === "apply"
      ? "absolute path to the reviewed cutover manifest `store collaboration plan` wrote"
      : "absolute path to the reviewed cutover manifest this activation addresses",
    backup: "absolute path to the repository backup manifest `store backup` published (both verified images must still match it)",
    operator: "the invoking operator, recorded as the approving actor of this activation or restore",
    attestation: "absolute path to the operator's full ActivationAttestation JSON (a collaboration fence additionally requires its cutover block)",
    out: "optional absolute path for the receipt or manifest this verb writes",
    expectStore: "optional store id this adoption must match (refuses any other live authority)",
  };
  const options = optionKeys.map((key) => ({
    key,
    flags: optionFlags[key],
    required: key === "harness" || (key === "backup" && verb === "restore"),
    ...(optionHelp[key] === undefined ? {} : { help: optionHelp[key] }),
  }));
  const descriptions: Record<(typeof collaborationVerbs)[number], string> = {
    plan: "Inspect the combined source read-only and write a reviewable cutover manifest. Reports unsupported or ambiguous legacy facts; it guesses no adoption.",
    apply: "Stage and verify the reviewed manifest in the canonical collaboration target. An identical staged receipt is reused; a target that progressed past verification is never restaged.",
    activate: "Publish the verified target for this exact manifest after the operator's stop evidence: this resumes its own durable fence or replays its already committed activation, and never republishes another source's authority.",
    restore: "Restore the collaboration image of a verified pair into an ABSENT canonical target, create-only, with a bumped collaboration epoch and a recorded restore receipt. Never overwrites, quarantines or deletes an existing authority.",
    adopt: "Bind THIS checkout to an already published authority whose recorded lineage proves the exact live store and epoch. Mutates no collaboration data; refuses a missing, ambiguous or mismatched lineage and never overwrites a binding.",
  };
  return {
    id,
    cli: { path: ["store", "collaboration", verb], aliases: [], arguments: [], options },
    input: inputSchema.pick(shape),
    // invariant: `harness` names the operation's target, so the connection pin must not rewrite it.
    rootInputs: [],
    output: commandEnvelopeSchema,
    effects: ["read", "write"],
    description: descriptions[verb],
    execute: (input, invocation) => execute(id, input, invocation),
  };
}

/**
 * note: Read a JSON argument for a remote verb: a file path, or `-` for stdin. An
 * unreadable path or a body that is not JSON is a USAGE refusal (exit 2) naming
 * the flag; no store work has happened yet.
 */
async function readRemoteJson(invocation: InvocationContext, value: string | undefined, flag: string): Promise<unknown> {
  if (value === undefined || value.trim() === "") throw new SddScriptError(`${flag} is required`, 2);
  let raw: string;
  if (value === "-") {
    raw = await invocation.effects.readInput();
  } else {
    try {
      raw = readFileSync(value, "utf8");
    } catch (error) {
      throw new SddScriptError(`${flag} ${value} cannot be read: ${error instanceof Error ? error.message : String(error)}`, 2);
    }
  }
  if (raw.trim() === "") throw new SddScriptError(`${flag} received no content; pass a JSON document`, 2);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SddScriptError(`${flag} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
}

/**
 * note: The remote observation lane: `status|bind|observe|adopt-issue` under
 * `store collaboration remote`. `--harness` names this checkout's harness
 * explicitly, exactly like the collaboration cutover family; no provider call,
 * credential or transport exists here.
 */
async function executeRemote(id: string, input: StoreInput, invocation: InvocationContext): Promise<CommandEnvelope> {
  const verb = id.slice("store.collaboration.remote.".length) as (typeof remoteVerbs)[number];
  try {
    const target = absoluteFile(required(input.harness, "--harness"), "--harness");
    const context: StoreContext = { harnessDir: path.resolve(target) };
    if (verb === "status") {
      return ok(id, await readRemoteStatus(context, input.project));
    }
    if (verb === "bind") {
      const batch = await readRemoteJson(invocation, input.input, "--input");
      return ok(id, await bindRemoteAuthority(context, batch));
    }
    if (verb === "observe") {
      const submission = await readRemoteJson(invocation, input.input, "--input");
      return ok(id, await ingestRemoteObservation(context, submission));
    }
    if (verb === "adopt-issue") {
      const adoption = await readRemoteJson(invocation, input.input, "--input");
      return ok(id, await prepareRemoteAdoption(context, {
        projectId: required(input.project, "--project"),
        issueId: required(input.issue, "--issue"),
        operationId: required(input.operation, "--operation"),
        adoption,
      }));
    }
    throw new SddScriptError(`unknown store collaboration remote verb ${verb}`, 2);
  } catch (error) {
    return refused(id, error);
  }
}

/**
 * note: The strict `--input` document each remote verb carries, published through schema
 * discovery (`payloadSchemas.inputDocument`). The descriptor name is deliberately NOT an
 * input field: the CLI value of `--input` stays a file path (or `-` for stdin), so only
 * discovery sees the schema and nothing reshapes the path input.
 */
const remoteInputDocuments: Partial<Record<(typeof remoteVerbs)[number], z.ZodType>> = {
  bind: remoteBindDocumentSchema,
  observe: remoteObserveDocumentSchema,
  "adopt-issue": remoteAdoptionDocumentSchema,
};

function remoteDefinition(verb: (typeof remoteVerbs)[number]): CommandDefinition<StoreInput, unknown> {
  const id = `store.collaboration.remote.${verb}`;
  const optionsByVerb: Record<(typeof remoteVerbs)[number], (keyof StoreInput)[]> = {
    status: ["harness", "project"],
    bind: ["harness", "input"],
    observe: ["harness", "input"],
    "adopt-issue": ["harness", "project", "issue", "operation", "input"],
  };
  const optionKeys = optionsByVerb[verb];
  const shape = Object.fromEntries(optionKeys.map((key) => [key, true])) as { [Key in keyof StoreInput]?: true };
  const optionHelp: Partial<Record<keyof StoreInput, string>> = {
    harness: "absolute path to this checkout's harness (the operation target, never discovered from the working directory)",
    project: "the local project id this cache binds; native issue detail and adoption require it, and it is never guessed",
    issue: "the exact immutable Linear provider issue id (a UUID, never a display id such as ENG-42)",
    operation: "caller-owned UUID for this adoption intent; unique across the repository",
    input: `path to the strict JSON document, or - for stdin; the document shape publishes as payloadSchemas.inputDocument in \`mstar schema --command ${id}\``,
  };
  const descriptions: Record<(typeof remoteVerbs)[number], string> = {
    status:
      "Report the checked selector/phase, this checkout's remote binding, and each bound project's latest revision, completeness, asOf, provider scope and access verdict. Reads and creates nothing; no provider content is printed.",
    bind:
      "Verify one ScopeCheck per selected project and create or advance this checkout's private remote cache lane. Every check must prove the exact selected tenant/team/project and all five capabilities; the lane records the reviewed selector commit/generation.",
    observe:
      "Accept one verification/observation submission and replace one project's cache evidence atomically. A negative check records the invalidation and returns its named refusal; a partial snapshot is stored as partial. It never creates or adopts an issue.",
    "adopt-issue":
      "Validate a strict adoption document against the exact observed, UNMARKED native issue and freeze it as ONE durable outbox intent under --operation. The returned state is the durable fact: an enqueued intent is not an adopted issue. A marked or differently referenced issue refuses, and no title, native status or caller-supplied project adopts.",
  };
  const effects: Record<(typeof remoteVerbs)[number], readonly CommandEffect[]> = {
    status: ["read"],
    bind: ["read", "write"],
    observe: ["read", "write"],
    "adopt-issue": ["read", "write"],
  };
  const options = optionKeys.map((key) => ({
    key,
    flags: optionFlags[key],
    required: key === "harness" || (verb === "adopt-issue" && (key === "project" || key === "issue" || key === "operation" || key === "input")),
    ...(optionHelp[key] === undefined ? {} : { help: optionHelp[key] }),
  }));
  return {
    id,
    cli: { path: ["store", "collaboration", "remote", verb], aliases: [], arguments: [], options },
    input: inputSchema.pick(shape),
    // note: `payloadSchemas.inputDocument` is the strict JSON the --input flag carries;
    // the flag's own value stays a file path, so no admission schema changes.
    ...(remoteInputDocuments[verb] === undefined ? {} : { payloads: { inputDocument: { schema: remoteInputDocuments[verb] } } }),
    // invariant: `harness` names the operation's target, so the connection pin must not rewrite it.
    rootInputs: [],
    output: commandEnvelopeSchema,
    effects: effects[verb],
    description: descriptions[verb],
    execute: (input, invocation) => executeRemote(id, input, invocation),
  };
}

function cliDefinition(id: string): CommandDefinition<StoreInput, unknown> {
  const verb = id.slice("store.".length) as (typeof verbs)[number];
  const optionsByVerb: Record<(typeof verbs)[number], (keyof StoreInput)[]> = {
    init: ["harness"],
    upgrade: ["harness", "operator", "operation", "attestation", "ackSkipDsh", "ackSkipWorkflow", "ackSkipCompass", "delivery"],
    backup: ["harness", "out"],
    migrate: ["harness", "apply", "manifest", "out"],
    activate: ["harness", "manifest", "operator", "attestation", "out"],
    retire: ["harness", "manifest", "out"],
  };
  const optionKeys = optionsByVerb[verb]!;
  const attestationHelp = activationAttestationDocumentConstraints.map(({ path, rule }) => `${path}: ${rule}`).join(" ");
  const optionHelp: Partial<Record<keyof StoreInput, string>> = {
    harness: "project harness directory, including the canonical control root; defaults to discovery from the working directory",
    operator: "the invoking operator, recorded on the generated attestation document (required for store activate; also the upgrade path's recorded operator)",
    operation: "caller-owned operation id for this upgrade. The id is the idempotency key of the EXACT request: reissue a failed upgrade with the SAME value only when every option that shapes the request identity is unchanged. That identity is the operator, the source bytes and the declarations this run consumes \u2014 --ack-skip-workflow, --ack-skip-compass and --delivery \u2014 so adding or changing one of those is a different request and refuses execution.operation-conflict under the old id; omit this option (or pass a new id) for such a retry. --ack-skip-dsh alone is NOT part of that identity: a retry that adds only it under the same id replays the already-committed execution import instead of conflicting. Note that the store.upgrade-dsh-source-refused recovery also names the ids this run committed under --ack-skip-workflow, and THAT is request identity \u2014 so the full advertised retry omits this option. Either way the earlier receipt and its committed rows stay native facts.",
    attestation: verb === "upgrade"
      ? `absolute path to the operator's full ActivationAttestation JSON; optional — when a retired held claim exists and the file is omitted, the verb generates the operator document automatically. Supply it only to override that generated document. ${attestationHelp}`
      : `absolute path to the operator's full ActivationAttestation JSON; optional — when omitted the verb generates the document from live process facts (a Bun-driven run refuses: run the installed Node CLI). Supply it only to override that generated document. ${attestationHelp}`,
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
      ? { payloads: { existingActivationAttestation: { schema: activationAttestationDocumentSchema }, delivery: { schema: z.array(deliveryDeclarationSchema) } } }
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
      : verb === "init"
        ? "Initialize this checkout's execution store create-only with fresh identifiers. A remote checkout initializes execution ONLY, after the reviewed remote bind created and verified its cache under the checked selector generation; it never restores, copies or republishes a prior execution lane."
        : `Store ${verb} operation.`} The canonical control root is a supported project harness.`,
    execute: (input, invocation) => execute(id, input, invocation),
  };
}

export function getStoreCommandDefinitions(): readonly CommandDefinition[] {
  return [
    ...verbs.map((verb) => cliDefinition(`store.${verb}`)),
    ...collaborationVerbs.map((verb) => collaborationDefinition(verb)),
    ...remoteVerbs.map((verb) => remoteDefinition(verb)),
    ...getStoreRemoteOutboxCommandDefinitions(),
  ];
}
