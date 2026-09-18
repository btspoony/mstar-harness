/**
 * CLI `mstar plan` — the scoped plan-coordination transport (spec §A2).
 *
 * Thin layer over the engine coordination API (spec §B). This module owns
 * argument shape only: usage-class input (missing/mixed/unknown flags,
 * non-numeric `--expect`, malformed or missing payload files, relative
 * where absolute is required) exits 2. Every scope / ownership / revision /
 * transition / Git / lock / store verdict stays the engine's: its stable
 * `code` and machine-readable `details` pass through unchanged with exit 1.
 *
 * Output contract (spec §A2): JSON goes to stdout with no color or banner
 * (`--json`); human diagnostics go to stderr. Exit 0 = successful or no-op
 * operation, 1 = runtime refusal, 2 = usage/invalid input shape.
 *
 * Identity is never a CLI input: no flag here names a holder, role or
 * coordinator — the engine reads the session envelope named by `--session`
 * and re-checks it against the snapshot inside the lock.
 */
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import pc from "picocolors";
import {
  SddScriptError,
  amendPrepareWorkflow,
  bindPlanSession,
  createFsStore,
  mutatePlanCoordination,
  readCoordinatedArtifact,
  readPlanCoordination,
  readSessionEnvelope,
  resolveProcessHarnessDir,
  setArtifactStore,
  showPrepareWorkflow,
  type BindPlanSessionInput,
  type ClosureEvidence,
  type CoordinationResult,
  type HandoffEvidence,
  type PlanCoordinationOperation,
  type PlanCoordinationView,
  type PrepareWorkflowPatch,
  type PrepareWorkflowResult,
  type ProgressCoordinationRequest,
  type ResidualInput,
  type TerminalDisposition,
} from "@mstar-harness/engine";

/** Detail keys the A2 failure shape may carry, in spec order. */
const FAILURE_DETAIL_KEYS = ["holder", "path", "expected", "actual"] as const;

/**
 * The workflow family additionally forwards the addressed workflow from the
 * engine's own refusal details. The identity comes from the refusal that was
 * actually thrown — an engine error that does not carry one is never decorated
 * with a guessed id — and the plan family's key set is unchanged.
 */
const WORKFLOW_FAILURE_DETAIL_KEYS = [...FAILURE_DETAIL_KEYS, "workflow_id"] as const;

/** JSON payload types owned by the exported engine request shapes. */
type ProgressPayload = ProgressCoordinationRequest["progress"];
/** One finding as `plan issue-add` takes it: the core capture input minus the plan's project. */
type IssueEntryPayload = ResidualInput;

interface PlanFailureContext {
  workflow_id?: string;
  plan_id?: string;
}

type PlanCliOptions = Record<string, string | boolean | undefined>;

/** Narrows an unknown value to a plain record, preserving property access. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The engine's documented consumer contract is the `code` (+ `details`)
 * pair; the error class itself is not part of the CLI's import surface, so
 * classification keys off the stable prefix instead of `instanceof`. The
 * scoped verbs reach four engine refusal families: the coordination surface
 * (`coordination.*`), the frozen-input pin (`catalog.execution-pin-conflict`,
 * contract §1), the store boundary (`store.*`) the pin and catalog reads
 * use, and — since the issue cutover (G2b) — the core issue domain
 * (`issue.*`: the DB mutation's revision/scope refusals). All four are
 * runtime refusals (exit 1), never internal errors.
 */
const ENGINE_REFUSAL_PREFIXES = ["coordination.", "catalog.", "store.", "issue."] as const;

function coordinationFailureOf(error: unknown): { code: string; details: Record<string, unknown> } | null {
  const record = asRecord(error);
  const code = record?.code;
  if (typeof code !== "string" || !ENGINE_REFUSAL_PREFIXES.some((prefix) => code.startsWith(prefix))) return null;
  return { code, details: asRecord(record?.details) ?? {} };
}

/** A2 failure shape. */
function failurePayload(
  verb: string,
  code: string,
  message: string,
  context: PlanFailureContext,
  details?: Record<string, unknown>,
): string {
  const payload: Record<string, unknown> = { ok: false, operation: verb, code, message };
  if (context.workflow_id !== undefined) payload.workflow_id = context.workflow_id;
  if (context.plan_id !== undefined) payload.plan_id = context.plan_id;
  // The caller's own context wins: an engine detail never overwrites the
  // identity this invocation already addressed.
  const detailKeys = familyOf(verb) === "workflow" ? WORKFLOW_FAILURE_DETAIL_KEYS : FAILURE_DETAIL_KEYS;
  for (const key of detailKeys) {
    if (details?.[key] !== undefined && payload[key] === undefined) payload[key] = details[key];
  }
  return JSON.stringify(payload);
}

/** Every verb this family registers (spec §A2 — no aliases). */
const PLAN_VERBS: Record<string, true> = {
  bind: true,
  show: true,
  prepare: true,
  progress: true,
  "issue-add": true,
  "issue-close": true,
  handoff: true,
  accept: true,
  return: true,
  "integration-start": true,
  "integration-accept": true,
  complete: true,
  "repair-delivery-source": true,
  reconcile: true,
};

/**
 * The issue-cutover rename (G2b), as one table used on both sides of the
 * boundary:
 *
 * - the engine's scoped operation kinds are still `residual-*` (G2a's
 *   `coordination.ts` is outside this cutover's files) — the mutation request
 *   and the view's `allowed_operations` go through this map so a reader is
 *   never advertised a verb this family does not register;
 * - the retired CLI verbs are the same tokens, and each one refuses by naming
 *   the `issue-*` verb in this table — no write-through alias exists.
 */
const ISSUE_VERB_NAMES: Record<string, string> = {
  "residual-add": "issue-add",
  "residual-close": "issue-close",
};

/**
 * The CLI outcome tokens for the engine's scoped issue outcomes. The CLI's
 * success envelope is its own contract (spec §A2) and this family no longer
 * registers a `residual-*` verb, so the envelope reports the issue vocabulary
 * while the engine keeps its operation kinds.
 */
const OPERATION_OUTCOME_NAMES: Record<string, string> = {
  "residual-added": "issue-added",
  "residual-closed": "issue-closed",
};

/** Every verb of the workflow Prepare family (spec § New API and CLI — no aliases). */
const WORKFLOW_VERBS: Record<string, true> = {
  "show-prepare": true,
  "amend-prepare": true,
};

/** The scoped coordination families this module registers, with their verbs. */
const SCOPED_VERB_FAMILIES: ReadonlyArray<{ family: string; verbs: Record<string, true> }> = [
  { family: "plan", verbs: PLAN_VERBS },
  { family: "workflow", verbs: WORKFLOW_VERBS },
];

/**
 * The command family one scoped verb belongs to. The `workflow` Prepare verbs
 * are the only ones outside the `plan` row family, so a failure line names the
 * command the caller actually ran.
 */
function familyOf(verb: string): string {
  return WORKFLOW_VERBS[verb] === true ? "workflow" : "plan";
}

/** The command token's position in `process.argv` (program, script, command). */
const COMMAND_POSITION = 2;

/**
 * Usage-failure object for a commander-level error (unknown option, excess
 * argument) raised by the scoped families this module registers — the `plan`
 * row verbs and the `workflow` Prepare verbs. Commander raises those before
 * any action runs, so the shared parse catch cannot know which operation the
 * argv addressed and recovers the family from the command position instead:
 * only the command slot decides, never a token found anywhere in the argv, so
 * a flag value equal to another family's token (`--session plan`, a relative
 * path that is itself the usage error) cannot make the payload claim it.
 * Returns `null` when the command position is not one of those families, so
 * unrelated invocations never receive a coordination-shaped payload.
 */
export function planUsageFailurePayload(argv: readonly string[], message: string): string | null {
  const matched = SCOPED_VERB_FAMILIES.find((entry) => entry.family === argv[COMMAND_POSITION]);
  if (matched === undefined) return null;
  const verb = argv.slice(COMMAND_POSITION + 1).find((token) => !token.startsWith("-"));
  return JSON.stringify({
    ok: false,
    operation: verb !== undefined && matched.verbs[verb] === true ? verb : matched.family,
    code: "usage",
    message,
  });
}

/**
 * Single failure exit for every verb: `SddScriptError` is usage class (its
 * own exit code, 2 for the checks below), a `coordination.*` error is the
 * engine's runtime refusal (exit 1), anything else is an unexpected failure
 * (exit 1) that still keeps machine-readable JSON valid when `--json` is on.
 * Every line names the family the caller actually ran — this one included, so
 * a workflow-verb failure never reports a `plan.*` code.
 */
function failPlan(verb: string, error: unknown, json: boolean, context: PlanFailureContext): void {
  const family = familyOf(verb);
  if (error instanceof SddScriptError) {
    if (json) console.log(failurePayload(verb, "usage", error.message, context));
    else console.error(pc.red(`${family} ${verb}: ${error.message}`));
    process.exitCode = error.exitCode;
    return;
  }
  const coordination = coordinationFailureOf(error);
  const message = error instanceof Error ? error.message : String(error);
  if (coordination !== null) {
    if (json) console.log(failurePayload(verb, coordination.code, message, context, coordination.details));
    else console.error(pc.red(`${family} ${verb}: ${message}`));
    process.exitCode = 1;
    return;
  }
  if (json) console.log(failurePayload(verb, `${family}.internal-error`, message, context));
  else console.error(pc.red(`${family} ${verb} failed: ${message}`));
  process.exitCode = 1;
}

/* ------------------------------------------------------------------------ *
 * § Argument shape (exit 2)
 * ------------------------------------------------------------------------ */

function requireFlag(raw: string | undefined, flag: string, verb: string, what: string): string {
  if (raw === undefined || raw.trim() === "") {
    throw new SddScriptError(`usage: ${familyOf(verb)} ${verb} requires ${flag} <${what}>`, 2);
  }
  return raw;
}

/** Absolute paths are required where the engine addresses an existing file. */
function requireAbsolutePath(raw: string | undefined, flag: string, verb: string, what: string): string {
  const value = requireFlag(raw, flag, verb, what);
  if (!isAbsolute(value)) {
    throw new SddScriptError(`${flag} must be an absolute path \u2014 got ${JSON.stringify(value)}`, 2);
  }
  return value;
}

/**
 * A revision precondition flag (`--expect` for the row, `--expect-issue` for
 * the issue the DB mutation guards) is a nonnegative integer, never a token
 * that would silently degrade into a different precondition.
 */
function parseExpect(raw: string | undefined, flag: string, verb: string): number {
  if (raw === undefined) {
    throw new SddScriptError(
      `usage: plan ${verb} requires ${flag} <revision> (the row coordination.revision from \`mstar plan show\`; 0 when the row is not yet coordinated)`,
      2,
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new SddScriptError(`${flag} must be a nonnegative integer revision \u2014 got ${JSON.stringify(raw)}`, 2);
  }
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision)) {
    throw new SddScriptError(`${flag} is out of range \u2014 got ${JSON.stringify(raw)}`, 2);
  }
  return revision;
}

/** The terminal dispositions `issue-close` may name (issue contract §4). */
const TERMINAL_DISPOSITIONS: Record<string, TerminalDisposition> = {
  resolved: "resolved",
  waived: "waived",
  duplicate: "duplicate",
  superseded: "superseded",
};

function parseDisposition(raw: string | undefined, verb: string): TerminalDisposition {
  const value = requireFlag(raw, "--disposition", verb, "disposition");
  const disposition = TERMINAL_DISPOSITIONS[value];
  if (disposition === undefined) {
    throw new SddScriptError(
      `--disposition must be resolved | waived | duplicate | superseded \u2014 got ${JSON.stringify(value)}`,
      2,
    );
  }
  return disposition;
}

/** JSON payload input is strict: absolute, present, parseable. */
function readJsonPayload(raw: string | undefined, flag: string, verb: string): unknown {
  const file = requireAbsolutePath(raw, flag, verb, "json-path");
  if (!existsSync(file)) {
    throw new SddScriptError(`${flag} payload file not found: ${file}`, 2);
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new SddScriptError(`${flag} payload file is unreadable: ${(error as Error).message}`, 2);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SddScriptError(`${flag} payload is not valid JSON: ${(error as Error).message}`, 2);
  }
}

/* ------------------------------------------------------------------------ *
 * § Active store pinning
 * ------------------------------------------------------------------------ */

/**
 * The engine authenticates every scoped call against the harness root it
 * resolved (process root at bind time, the session envelope's own
 * `harness_root` afterwards) and refuses when the active ArtifactStore
 * resolves elsewhere (`coordination.path-mismatch`). The default store
 * derives its root from the cwd, so a process sitting in a linked feature
 * checkout would inject that checkout's `.mstar` — pin the resolved root
 * before each call.
 */
function pinArtifactStoreRoot(root: string | null): void {
  if (root !== null) setArtifactStore(createFsStore(root));
}

function pinProcessRoot(harnessDir: string | undefined): void {
  pinArtifactStoreRoot(resolveProcessHarnessDir(process.cwd(), harnessDir));
}

function pinSessionRoot(sessionPath: string): void {
  pinArtifactStoreRoot(readSessionEnvelope(sessionPath).harness_root);
}

/* ------------------------------------------------------------------------ *
 * § Result shape (spec §A2)
 * ------------------------------------------------------------------------ */

/** `state` of the row's handoff, when the operation produced a view. */
function handoffStateOf(view: PlanCoordinationView | undefined): string | undefined {
  const coordination = asRecord(asRecord(view?.row)?.coordination);
  const state = asRecord(coordination?.handoff)?.state;
  return typeof state === "string" ? state : undefined;
}

/**
 * `id` of the row's live handoff, when the operation produced a view. This is
 * the engine's own id — the one a coordinator passes to `--handoff` — and the
 * only place the CLI surfaces it: `plan handoff --json` mints it, `show`
 * keeps reporting the row's status/state (spec §A2).
 */
function handoffIdOf(view: PlanCoordinationView | undefined): string | undefined {
  const coordination = asRecord(asRecord(view?.row)?.coordination);
  const id = asRecord(coordination?.handoff)?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * The A2 success payload. `snapshot_version` is mandatory on every success:
 * when the operation produced a plan-row view it comes from that view, and
 * when it did not — a fresh or resumed coordinator bind has no selected row —
 * it comes from the engine's own artifact read of the workflow snapshot the
 * call just wrote. Both are the engine's version of the exact bytes; nothing
 * is synthesized here.
 */
async function successPayload(verb: string, result: CoordinationResult): Promise<Record<string, unknown>> {
  const view = result.view;
  const payload: Record<string, unknown> = {
    ok: true,
    operation: verb,
    workflow_id: result.session.workflow_id,
    session_file: result.session_file,
    session_id: result.session.session_id,
    role: result.session.role,
  };
  if (result.session.plan_id !== undefined) payload.plan_id = result.session.plan_id;
  if (view !== undefined) payload.revision = view.revision;
  payload.snapshot_version =
    view !== undefined
      ? view.snapshot_version
      : (
          await readCoordinatedArtifact(result.session.harness_root, {
            kind: "snapshot",
            key: result.session.workflow_id,
          })
        ).version;
  const handoffId = handoffIdOf(view);
  if (handoffId !== undefined) payload.handoff_id = handoffId;
  const state = handoffStateOf(view);
  if (state !== undefined) payload.state = state;
  if (result.outcome !== undefined) payload.outcome = OPERATION_OUTCOME_NAMES[result.outcome] ?? result.outcome;
  // The scoped issue operations learn their DB-allocated ids here: `issue-add`
  // reports what it captured (`revision` is the value `issue-close` must echo
  // back as `--expect-issue`), and `issue-close` reports the closed issue.
  if (result.issues !== undefined) payload.issues = result.issues;
  return payload;
}

async function printSuccess(verb: string, result: CoordinationResult, json: boolean): Promise<void> {
  const payload = await successPayload(verb, result);
  if (json) {
    console.log(JSON.stringify(payload));
    return;
  }
  // Human mode keeps stdout machine-only: the readable summary is diagnostic.
  const work =
    typeof payload.plan_id === "string" ? `${payload.workflow_id}/${payload.plan_id}` : String(payload.workflow_id);
  const revision = payload.revision === undefined ? "" : `; revision ${payload.revision}`;
  const outcome = payload.outcome === undefined ? "" : `; ${String(payload.outcome)}`;
  console.error(
    pc.green(`plan ${verb}: ${result.session.role} session ${result.session.session_id} on ${work}${revision}${outcome}`),
  );
  console.error(`plan ${verb}: session file ${result.session_file}`);
  if (payload.state !== undefined) console.error(`plan ${verb}: handoff state ${payload.state}`);
  for (const issue of result.issues ?? []) {
    console.error(
      `plan ${verb}: issue ${issue.issue_id} (revision ${issue.revision}${issue.created ? ", captured" : ", existing"})`,
    );
  }
}

/**
 * `show` prints the view itself (spec §A2: selected row, scoped paths, allowed
 * operations and the snapshot byte version — never an editable snapshot). The
 * engine's operation kinds keep their `residual-*` names; the advertised verbs
 * are the CLI's own, so a reader is never told to run a verb that would refuse.
 */
function printView(verb: string, view: PlanCoordinationView, json: boolean): void {
  const state = handoffStateOf(view);
  const liveHandoff = handoffIdOf(view);
  if (json) {
    const payload: Record<string, unknown> = {
      ok: true,
      operation: verb,
      workflow_id: view.session.workflow_id,
      revision: view.revision,
      snapshot_version: view.snapshot_version,
      session_file: view.session_file,
      session_id: view.session.session_id,
      role: view.session.role,
      scope: view.scope,
      row: { id: view.row.id, status: view.row.status },
      allowed_operations: view.allowed_operations.map((operation) => ISSUE_VERB_NAMES[operation] ?? operation),
    };
    if (view.session.plan_id !== undefined) payload.plan_id = view.session.plan_id;
    if (liveHandoff !== undefined) payload.handoff_id = liveHandoff;
    if (state !== undefined) payload.state = state;
    // The frozen-input pin state (contract §1) is disclosed verbatim: a caller
    // observes that the catalog moved, that a plan is unpinned, or that the
    // pinned input and the frozen row disagree — the engine never repairs a
    // discrepancy here, and neither may the reader.
    if (view.catalog_pin !== undefined) payload.catalog_pin = view.catalog_pin;
    console.log(JSON.stringify(payload));
    return;
  }
  const scope = view.scope;
  console.error(
    pc.green(
      `plan ${verb}: ${view.session.role} session ${view.session.session_id} (workflow ${view.session.workflow_id})`,
    ),
  );
  console.error(`plan ${verb}: session file ${view.session_file}`);
  console.error(`plan ${verb}: row ${String(view.row.id)} status ${String(view.row.status)}, revision ${view.revision}`);
  console.error(`plan ${verb}: snapshot ${view.snapshot_version}`);
  if (state !== undefined) console.error(`plan ${verb}: handoff state ${state}`);
  if (liveHandoff !== undefined) console.error(`plan ${verb}: handoff id ${liveHandoff}`);
  if (scope === null) {
    console.error(
      `plan ${verb}: this row is not prepared yet \u2014 run \`mstar plan prepare --session ${view.session_file} --plan <id> --assignment <absolute-md> --expect ${view.revision}\``,
    );
  } else {
    console.error(`plan ${verb}: worktree ${scope.worktreePath} (branch ${scope.workingBranch})`);
    console.error(`plan ${verb}: sdd ${scope.sddDir}`);
  }
  const pin = view.catalog_pin;
  if (pin !== undefined && pin.conflict !== null) {
    console.error(pc.red(`plan ${verb}: catalog pin conflict \u2014 ${pin.conflict}`));
  } else if (pin?.pin != null) {
    console.error(
      `plan ${verb}: catalog pin ${pin.source} (revision ${pin.pin.entity_revision}${pin.catalog_moved ? ", catalog moved" : ""})`,
    );
  } else if (pin !== undefined) {
    console.error(`plan ${verb}: catalog pin ${pin.absence ?? "unbound"}`);
  }
  console.error(`plan ${verb}: allowed operations: ${view.allowed_operations.join(", ") || "(none)"}`);
}

/* ------------------------------------------------------------------------ *
 * § Verbs (spec §A2 — no aliases)
 * ------------------------------------------------------------------------ */

/** Run one verb body with the shared failure exit. */
async function runVerb(
  verb: string,
  options: PlanCliOptions,
  context: PlanFailureContext,
  body: (json: boolean) => Promise<void>,
): Promise<void> {
  const json = options.json === true;
  try {
    await body(json);
  } catch (error) {
    failPlan(verb, error, json, context);
  }
}

/**
 * One row mutation: the request carries the session file, the selected plan
 * (coordinator sessions only), the caller's revision precondition and the
 * discriminated operation — never a snapshot, row or arbitrary field.
 */
async function mutate(
  verb: string,
  options: PlanCliOptions,
  json: boolean,
  coordinator: boolean,
  operation: (options: PlanCliOptions) => PlanCoordinationOperation,
): Promise<void> {
  // Argument shape is decided before any I/O (exit 2), so a malformed flag
  // never surfaces as a store/session refusal (exit 1).
  const sessionPath = requireAbsolutePath(options.session as string | undefined, "--session", verb, "session-json-path");
  const planId = coordinator ? requireFlag(options.plan as string | undefined, "--plan", verb, "plan-id") : undefined;
  const expectedRevision = parseExpect(options.expect as string | undefined, "--expect", verb);
  const handoffId = options.handoff as string | undefined;
  const concrete = operation(options);
  // The store pin comes first: the pre-check below reads the row through the
  // ArtifactStore, so an unpinned read resolves the cwd-derived root and
  // refuses a linked checkout whose session envelope names the control root.
  pinSessionRoot(sessionPath);
  if (handoffId !== undefined && planId !== undefined) {
    const live = handoffIdOf(await readPlanCoordination(sessionPath, planId));
    if (live !== undefined && live !== handoffId) throw handoffMismatch(verb, planId, live, handoffId);
  }
  const result = await mutatePlanCoordination({
    sessionPath,
    ...(planId !== undefined ? { planId } : {}),
    expectedRevision,
    operation: concrete,
  });
  await printSuccess(verb, result, json);
}

/** The coordinator transition verbs registered by one shared flag surface. */
type TransitionKind = "accept" | "return" | "integration-start" | "integration-accept" | "complete" | "repair-delivery-source" | "reconcile";

/**
 * The coordinator transition operation. `--handoff <id>` is mandatory (spec
 * §A2) and travels with the operation, so the engine re-checks the named id
 * against the row *inside* its own lock: the read below is only an early,
 * friendlier refusal for a stale flag, never the assertion (a concurrent
 * `return` plus a fresh handoff cannot be transitioned by this command).
 */
function handoffOperation(options: PlanCliOptions, kind: TransitionKind): PlanCoordinationOperation {
  const handoffId = requireFlag(options.handoff as string | undefined, "--handoff", kind, "handoff-id");
  if (kind !== "return") return { kind, handoffId } as PlanCoordinationOperation;
  const reason = requireFlag(options.reason as string | undefined, "--reason", kind, "text");
  return { kind, handoffId, reason } as PlanCoordinationOperation;
}

/**
 * The `--handoff <id>` assertion (spec §A2: the coordinator names the handoff
 * it is acting on). A flag that names a different live handoff is refused —
 * a re-handoff bumps `attempt`, so acting on a replaced one would complete
 * the wrong attempt. A row that carries no handoff at all is left to the
 * engine's `coordination.invalid-transition`, whose message is the accurate
 * one for that state.
 */
function handoffMismatch(verb: string, planId: string, live: string, named: string): Error {
  const error = new Error(
    `plan ${verb}: row ${planId} carries handoff ${live} \u2014 refusing the --handoff ${named} this call names`,
  );
  return Object.assign(error, {
    code: "coordination.handoff-mismatch",
    details: { plan_id: planId, expected: live, actual: named },
  });
}

/**
 * The four `bind` addressing forms (spec §A2); exactly one family may be
 * given, and each form rejects the flags that belong to another.
 */
function bindInputOf(options: PlanCliOptions): BindPlanSessionInput {
  const coordinator = options.coordinator === true;
  const workflow = options.workflow as string | undefined;
  const plan = options.plan as string | undefined;
  const assignment = options.assignment as string | undefined;
  const resume = options.resume as string | undefined;
  const harness = options.harness as string | undefined;
  if (harness !== undefined && !isAbsolute(harness)) {
    throw new SddScriptError(`--harness must be an absolute path \u2014 got ${JSON.stringify(harness)}`, 2);
  }
  const families = [
    coordinator,
    !coordinator && (workflow !== undefined || plan !== undefined),
    assignment !== undefined,
    resume !== undefined,
  ].filter(Boolean).length;
  if (families !== 1) {
    throw new SddScriptError(
      "usage: plan bind --coordinator --workflow <id> [--harness <absolute-path>] [--json]\n" +
        "       plan bind --assignment <absolute-md-path> [--json]\n" +
        "       plan bind --workflow <id> --plan <id> [--harness <absolute-path>] [--json]\n" +
        "       plan bind --resume <absolute-session-json-path> [--json]",
      2,
    );
  }
  const cwd = process.cwd();
  if (coordinator) {
    if (plan !== undefined || assignment !== undefined || resume !== undefined) {
      throw new SddScriptError("plan bind --coordinator accepts only --workflow (plus optional --harness)", 2);
    }
    return {
      coordinator: true,
      workflowId: requireFlag(workflow, "--workflow", "bind", "workflow-id"),
      ...(harness !== undefined ? { harnessDir: harness } : {}),
      cwd,
    };
  }
  if (assignment !== undefined) {
    if (workflow !== undefined || plan !== undefined || harness !== undefined) {
      throw new SddScriptError(
        "plan bind --assignment accepts no --workflow/--plan/--harness (the Assignment pins the workflow and harness)",
        2,
      );
    }
    return { scope: { assignmentPath: requireAbsolutePath(assignment, "--assignment", "bind", "md-path") }, cwd };
  }
  if (resume !== undefined) {
    if (harness !== undefined) {
      throw new SddScriptError(
        "plan bind --resume accepts no --harness (the session envelope pins the harness root)",
        2,
      );
    }
    return { resumePath: requireAbsolutePath(resume, "--resume", "bind", "session-json-path"), cwd };
  }
  if (workflow === undefined || plan === undefined) {
    throw new SddScriptError("plan bind --workflow requires --plan <id> (the workflow+plan address form)", 2);
  }
  return {
    scope: {
      workflowId: requireFlag(workflow, "--workflow", "bind", "workflow-id"),
      planId: requireFlag(plan, "--plan", "bind", "plan-id"),
      ...(harness !== undefined ? { harnessDir: harness } : {}),
    },
    cwd,
  };
}

/**
 * The harness override one address form declared (spec §A2): the top-level key
 * for `--coordinator`, `scope.harnessDir` for the `--workflow/--plan` form, and
 * none for `--assignment`/`--resume` (the pinned Assignment and the session
 * envelope carry those roots themselves). The store must be pinned to the root
 * the engine resolves — the cwd-derived default is correct only when the form
 * declared no override, and `--harness` otherwise addresses a root the process
 * root check never sees.
 */
function harnessOverrideOf(input: BindPlanSessionInput): string | undefined {
  if ("scope" in input) return "harnessDir" in input.scope ? input.scope.harnessDir : undefined;
  if ("coordinator" in input) return input.harnessDir;
  return undefined;
}

export function registerPlanCommands(program: Command): void {
  const plan = program
    .command("plan")
    .description(
      "Scoped plan coordination: bind a plan or coordinator session, read its view, and run the row transitions " +
        "(engine-backed; JSON on stdout with --json, diagnostics on stderr; exit 0 ok/no-op, 1 scope/ownership/" +
        "revision/state/Git refusal, 2 usage)",
    )
    .exitOverride();

  plan
    .command("bind")
    .description(
      "Bind the scoped session for one plan \u2014 fresh `--workflow/--plan` or `--assignment` claim (both addresses resolve " +
        "the same prepared row), fresh `--coordinator` bootstrap, or explicit `--resume` of an existing session file " +
        "(read-only: no ownership change, no takeover)",
    )
    .option("--coordinator", "Trusted local coordinator bootstrap (requires --workflow; one per workflow)")
    .option("--workflow <id>", "Workflow id")
    .option("--plan <id>", "Plan id (workflow+plan address form)")
    .option("--assignment <path>", "Absolute path of the pinned prepared Assignment")
    .option("--resume <path>", "Absolute path of an existing session JSON envelope")
    .option("--harness <path>", "Absolute harness dir override (default: resolved control root)")
    .option("--json", "Machine-readable JSON on stdout")
    .action(async (options: PlanCliOptions) =>
      runVerb(
        "bind",
        options,
        { workflow_id: options.workflow as string | undefined, plan_id: options.plan as string | undefined },
        async (json) => {
          const input = bindInputOf(options);
          pinProcessRoot(harnessOverrideOf(input));
          await printSuccess("bind", await bindPlanSession(input), json);
        },
      ),
    );

  plan
    .command("show")
    .description(
      "Read the selected row's coordination view: revision, both byte versions, scoped paths and the operations this " +
        "session may run now (plan sessions accept no --plan; a coordinator session requires one)",
    )
    .option("--session <path>", "Absolute session JSON envelope path")
    .option("--plan <id>", "Plan id (required for a coordinator session)")
    .option("--json", "Machine-readable JSON on stdout")
    .action(async (options: PlanCliOptions) =>
      runVerb("show", options, { plan_id: options.plan as string | undefined }, async (json) => {
        const sessionPath = requireAbsolutePath(options.session as string | undefined, "--session", "show", "session-json-path");
        pinSessionRoot(sessionPath);
        printView("show", await readPlanCoordination(sessionPath, options.plan as string | undefined), json);
      }),
    );

  plan
    .command("prepare")
    .description("Register the reviewed Assignment for one plan and release its dependencies (coordinator session)")
    .option("--session <path>", "Absolute coordinator session JSON envelope path")
    .option("--plan <id>", "Plan id")
    .option("--assignment <path>", "Absolute path of the prepared Assignment markdown")
    .option("--expect <revision>", "Row coordination.revision from `mstar plan show`")
    .option("--json", "Machine-readable JSON on stdout")
    .action(async (options: PlanCliOptions) =>
      runVerb("prepare", options, { plan_id: options.plan as string | undefined }, (json) =>
        mutate("prepare", options, json, true, (opts) => ({
          kind: "prepare",
          assignmentPath: requireAbsolutePath(opts.assignment as string | undefined, "--assignment", "prepare", "md-path"),
        })),
      ),
    );

  plan
    .command("progress")
    .description("Replace this plan's progress summary and status (active plan session)")
    .option("--session <path>", "Absolute plan session JSON envelope path")
    .option("--file <path>", "Absolute path of the PlanProgress JSON payload")
    .option("--expect <revision>", "Row coordination.revision from `mstar plan show`")
    .option("--json", "Machine-readable JSON on stdout")
    .action(async (options: PlanCliOptions) =>
      runVerb("progress", options, {}, (json) =>
        mutate("progress", options, json, false, (opts) => ({
          kind: "progress",
          progress: readJsonPayload(opts.file as string | undefined, "--file", "progress") as ProgressPayload,
        })),
      ),
    );

  plan
    .command("issue-add")
    .description(
      "Capture findings on this plan as issues in {HARNESS_DIR}/store.db and link them to the plan (active plan session). " +
        "Each entry is a capture input without projectId; the report names the DB-assigned issue ids and revisions",
    )
    .option("--session <path>", "Absolute plan session JSON envelope path")
    .option("--file <path>", "Absolute path of the issue entries JSON payload (array)")
    .option("--expect <revision>", "Row coordination.revision from `mstar plan show`")
    .option("--json", "Machine-readable JSON on stdout")
    .action(async (options: PlanCliOptions) =>
      runVerb("issue-add", options, {}, (json) =>
        mutate("issue-add", options, json, false, (opts) => ({
          kind: "residual-add",
          entries: readJsonPayload(opts.file as string | undefined, "--file", "issue-add") as IssueEntryPayload[],
        })),
      ),
    );

  plan
    .command("issue-close")
    .description(
      "Close one issue linked to this plan with the named disposition and its closure evidence (active plan session). " +
        "`--expect-issue` is the issue revision from `plan issue-add` or `mstar issue show`",
    )
    .option("--session <path>", "Absolute plan session JSON envelope path")
    .option("--issue <id>", "Issue id linked to this plan")
    .option("--disposition <disposition>", "Terminal disposition: resolved | waived | duplicate | superseded")
    .option("--file <path>", "Absolute path of the ClosureEvidence JSON payload")
    .option("--expect-issue <revision>", "Current issue revision (the DB mutation's CAS value)")
    .option("--expect <revision>", "Row coordination.revision from `mstar plan show`")
    .option("--json", "Machine-readable JSON on stdout")
    .action(async (options: PlanCliOptions) =>
      runVerb("issue-close", options, {}, (json) =>
        mutate("issue-close", options, json, false, (opts) => {
          // Every flag is validated before any file I/O: a malformed
          // `--expect-issue`/`--disposition` must reject as usage without
          // reading --file.
          const issueId = requireFlag(opts.issue as string | undefined, "--issue", "issue-close", "issue-id");
          const disposition = parseDisposition(opts.disposition as string | undefined, "issue-close");
          const expectedIssueRevision = parseExpect(
            opts.expectIssue as string | undefined,
            "--expect-issue",
            "issue-close",
          );
          const evidence = readJsonPayload(opts.file as string | undefined, "--file", "issue-close") as ClosureEvidence;
          return { kind: "residual-close", issueId, disposition, evidence, expectedIssueRevision };
        }),
      ),
    );

  plan
    .command("handoff")
    .description("Submit the immutable, pinned handoff for this plan and keep it InReview (plan session)")
    .option("--session <path>", "Absolute plan session JSON envelope path")
    .option("--file <path>", "Absolute path of the HandoffEvidence JSON payload")
    .option("--expect <revision>", "Row coordination.revision from `mstar plan show`")
    .option("--json", "Machine-readable JSON on stdout")
    .action(async (options: PlanCliOptions) =>
      runVerb("handoff", options, {}, (json) =>
        mutate("handoff", options, json, false, (opts) => ({
          kind: "handoff",
          evidence: readJsonPayload(opts.file as string | undefined, "--file", "handoff") as HandoffEvidence,
        })),
      ),
    );

  // The seven coordinator transitions share one flag surface; `return` alone
  // carries a reason.
  for (const [kind, description] of [
    ["accept", "Accept a submitted handoff: execution ownership transfers to the coordinator, no merge yet"],
    ["return", "Return a submitted/accepted handoff to the plan owner and restore its execution holder"],
    [
      "integration-start",
      "Iteration route only: record the integration attempt and pin its base before any Git merge (Git stays the operator's action)",
    ],
    [
      "integration-accept",
      "Iteration route only: verify the pinned Git result of the started integration attempt (never runs a merge)",
    ],
    [
      "complete",
      "Record row Done after verified Git proof \u2014 iteration route releases both leases after a merged handoff; standalone development completes from the accepted handoff without integration and releases only the row lease (workflow stays running)",
    ],
    [
      "repair-delivery-source",
      "Legacy-only: replace a wrong registered delivery source (source === target) from the accepted handoff pin \u2014 never Done, delivery evidence, or a user-supplied branch; not a normal lifecycle step",
    ],
    [
      "reconcile",
      "Crash recovery: iteration route observes the merge checkout and finishes or abandons the attempt; standalone development only replays an already-completed row as a no-write already-completed",
    ],
  ] as const) {
    const command = plan
      .command(kind)
      .description(`${description} (coordinator session)`)
      .option("--session <path>", "Absolute coordinator session JSON envelope path")
      .option("--plan <id>", "Plan id")
      .option("--handoff <id>", "Handoff id this call acts on (must be the row's live handoff; `plan show --json` reports it)");
    if (kind === "return") command.option("--reason <text>", "Return reason");
    command
      .option("--expect <revision>", "Row coordination.revision from `mstar plan show`")
      .option("--json", "Machine-readable JSON on stdout")
      .action(async (options: PlanCliOptions) =>
        runVerb(kind, options, { plan_id: options.plan as string | undefined }, (json) =>
          mutate(kind, options, json, true, (opts) => handoffOperation(opts, kind)),
        ),
      );
  }

  // The retired issue verbs are registered so the old names refuse with the
  // migration path. They accept any flag shape (a caller's old invocation must
  // reach the guidance, not a commander unknown-option error) and write
  // nothing — there is no alias that performs the old register write.
  for (const [verb, replacement] of Object.entries(ISSUE_VERB_NAMES)) {
    plan
      .command(verb)
      .description(`Retired \u2014 ${replacement} replaces it; this verb refuses and writes nothing`)
      .allowUnknownOption()
      .allowExcessArguments()
      .option("--json", "Machine-readable JSON on stdout")
      .action((options: PlanCliOptions) => {
        const message =
          `plan ${verb}: retired \u2014 the scoped findings operations are \`mstar plan ${replacement}\` ` +
          "(issues in {HARNESS_DIR}/store.db); this verb writes nothing";
        if (options.json === true) {
          console.log(JSON.stringify({ ok: false, operation: verb, code: "plan.verb-retired", message }));
        } else {
          console.error(pc.red(message));
        }
        process.exitCode = 1;
      });
  }

  // Usage-class commander errors (unknown option, excess argument) exit 2 for
  // this verb family instead of commander's default exit 1; the shared
  // CommanderError mapping lives with the top-level parse call.
  for (const command of [plan, ...plan.commands]) command.exitOverride();
}

/* ------------------------------------------------------------------------ *
 * § mstar workflow — the Prepare amendment transport
 * ------------------------------------------------------------------------ */

/** The raw-byte version token one workflow-verb flag carries. */
function parsePrepareVersion(raw: string | undefined, flag: string, verb: string): string {
  const value = requireFlag(raw, flag, verb, "sha256-version");
  const bare = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (!/^[0-9a-f]{64}$/.test(bare)) {
    throw new SddScriptError(
      `${flag} must be a raw-byte sha256 version ("sha256:<64 lowercase hex>" or "<64 lowercase hex>") \u2014 got ${JSON.stringify(value)}`,
      2,
    );
  }
  return value;
}

/**
 * The workflow-view success payload (spec § New API and CLI): the view a
 * coordinator acts on — both byte versions, the current plan ids and the
 * admission verdict. This is deliberately not the row-only success renderer:
 * the result carries a workflow view and no plan row.
 */
function printWorkflowView(verb: string, result: PrepareWorkflowResult, json: boolean): void {
  const view = result.view;
  if (json) {
    const payload: Record<string, unknown> = {
      ok: true,
      operation: verb,
      workflow_id: view.workflowId,
      session_file: result.session_file,
      session_id: result.session.session_id,
      role: result.session.role,
      snapshot_version: view.snapshotVersion,
      compass_version: view.compassVersion,
      plan_ids: view.planIds,
      allowed: view.allowed,
      blockers: view.blockers,
    };
    if (result.outcome !== undefined) payload.outcome = result.outcome;
    console.log(JSON.stringify(payload));
    return;
  }
  // Human mode keeps stdout machine-only: the readable summary is diagnostic.
  console.error(
    pc.green(
      `workflow ${verb}: ${result.session.role} session ${result.session.session_id} (workflow ${view.workflowId})`,
    ),
  );
  console.error(`workflow ${verb}: session file ${result.session_file}`);
  console.error(`workflow ${verb}: snapshot ${view.snapshotVersion}, compass ${view.compassVersion}`);
  console.error(`workflow ${verb}: plans ${view.planIds.join(", ") || "(none)"}`);
  console.error(
    `workflow ${verb}: ${view.allowed ? "amendment admissible" : `blocked \u2014 ${view.blockers.join("; ")}`}`,
  );
  if (result.outcome !== undefined) console.error(`workflow ${verb}: ${result.outcome}`);
}

/**
 * `mstar workflow` — the workflow-level Prepare amendment verbs (spec § New API
 * and CLI). They live in this module because they are the same scoped
 * coordination transport: one coordinator envelope, one engine call, the same
 * argument/failure protocol (success exit 0, refusal exit 1 with the JSON
 * failure object, usage exit 2). There is no force/replace/init/fallback flag.
 */
export function registerWorkflowCommands(program: Command): void {
  const workflow = program
    .command("workflow")
    .description(
      "Workflow-level Prepare amendment: read the current snapshot/compass byte versions and the admission view " +
        "(`show-prepare`), then apply one approved structural delta (`amend-prepare`) (engine-backed; JSON on stdout " +
        "with --json, diagnostics on stderr; exit 0 ok, 1 refusal, 2 usage)",
    )
    .exitOverride();

  workflow
    .command("show-prepare")
    .description(
      "Read the Prepare amendment view of one coordinator-bound workflow: both byte versions, the current plan ids " +
        "and whether an amendment is admissible (read-only: no lock, no write)",
    )
    .option("--session <path>", "Absolute coordinator session JSON envelope path")
    .option("--json", "Machine-readable JSON on stdout")
    .action(async (options: PlanCliOptions) =>
      runVerb("show-prepare", options, {}, async (json) => {
        const sessionPath = requireAbsolutePath(
          options.session as string | undefined,
          "--session",
          "show-prepare",
          "session-json-path",
        );
        pinSessionRoot(sessionPath);
        printWorkflowView("show-prepare", await showPrepareWorkflow({ sessionPath, cwd: process.cwd() }), json);
      }),
    );

  workflow
    .command("amend-prepare")
    .description(
      "Append approved Todo plan rows, record the reviewed integration checkout and the approved plan parallelism " +
        "(coordinator session; both byte versions from `workflow show-prepare` are required)",
    )
    .option("--session <path>", "Absolute coordinator session JSON envelope path")
    .option("--expect-snapshot <sha256>", "Current snapshot byte version from `workflow show-prepare`")
    .option("--expect-compass <sha256>", "Current compass byte version from `workflow show-prepare`")
    .option("--input <path>", "Absolute path of the PrepareWorkflowPatch JSON payload")
    .option("--json", "Machine-readable JSON on stdout")
    .action(async (options: PlanCliOptions) =>
      runVerb("amend-prepare", options, {}, async (json) => {
        // Every flag is validated before any engine I/O (exit 2): a malformed
        // token or payload path must never surface as a store refusal (exit 1).
        const sessionPath = requireAbsolutePath(
          options.session as string | undefined,
          "--session",
          "amend-prepare",
          "session-json-path",
        );
        const expectedSnapshotVersion = parsePrepareVersion(
          options.expectSnapshot as string | undefined,
          "--expect-snapshot",
          "amend-prepare",
        );
        const expectedCompassVersion = parsePrepareVersion(
          options.expectCompass as string | undefined,
          "--expect-compass",
          "amend-prepare",
        );
        const patch = readJsonPayload(options.input as string | undefined, "--input", "amend-prepare") as PrepareWorkflowPatch;
        pinSessionRoot(sessionPath);
        printWorkflowView(
          "amend-prepare",
          await amendPrepareWorkflow({
            sessionPath,
            cwd: process.cwd(),
            expectedSnapshotVersion,
            expectedCompassVersion,
            patch,
          }),
          json,
        );
      }),
    );

  for (const command of [workflow, ...workflow.commands]) command.exitOverride();
}
