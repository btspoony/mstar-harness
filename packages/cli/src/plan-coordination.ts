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
  bindPlanSession,
  createFsStore,
  mutatePlanCoordination,
  readCoordinatedArtifact,
  readPlanCoordination,
  readSessionEnvelope,
  resolveProcessHarnessDir,
  setArtifactStore,
  type BindPlanSessionInput,
  type CoordinationResult,
  type HandoffEvidence,
  type PlanCoordinationOperation,
  type PlanCoordinationView,
  type ProgressCoordinationRequest,
  type ResidualAddCoordinationRequest,
} from "@mstar-harness/engine";

/** Detail keys the A2 failure shape may carry, in spec order. */
const FAILURE_DETAIL_KEYS = ["holder", "path", "expected", "actual"] as const;

/** JSON payload types owned by the exported engine request shapes. */
type ProgressPayload = ProgressCoordinationRequest["progress"];
type ResidualEntriesPayload = ResidualAddCoordinationRequest["entries"];

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
 * classification keys off the stable prefix instead of `instanceof`.
 */
function coordinationFailureOf(error: unknown): { code: string; details: Record<string, unknown> } | null {
  const record = asRecord(error);
  const code = record?.code;
  if (typeof code !== "string" || !code.startsWith("coordination.")) return null;
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
  for (const key of FAILURE_DETAIL_KEYS) {
    if (details?.[key] !== undefined) payload[key] = details[key];
  }
  return JSON.stringify(payload);
}

/** Every verb this family registers (spec §A2 — no aliases). */
const PLAN_VERBS: Record<string, true> = {
  bind: true,
  show: true,
  prepare: true,
  progress: true,
  "residual-add": true,
  "residual-close": true,
  handoff: true,
  accept: true,
  return: true,
  "integration-start": true,
  "integration-accept": true,
  complete: true,
  reconcile: true,
};

/**
 * A2 usage-failure object for a commander-level error (unknown option, excess
 * argument) raised by this verb family. Commander raises those before any
 * action runs, so the shared parse catch cannot know which operation the argv
 * addressed and recovers it from the argv instead. Returns `null` when the
 * argv is not a `mstar plan` invocation, so unrelated commands never receive a
 * plan-shaped payload.
 */
export function planUsageFailurePayload(argv: readonly string[], message: string): string | null {
  const planIndex = argv.indexOf("plan");
  if (planIndex === -1) return null;
  const verb = argv.slice(planIndex + 1).find((token) => !token.startsWith("-"));
  return JSON.stringify({
    ok: false,
    operation: verb !== undefined && PLAN_VERBS[verb] === true ? verb : "plan",
    code: "usage",
    message,
  });
}

/**
 * Single failure exit for every verb: `SddScriptError` is usage class (its
 * own exit code, 2 for the checks below), a `coordination.*` error is the
 * engine's runtime refusal (exit 1), anything else is an unexpected failure
 * (exit 1) that still keeps machine-readable JSON valid when `--json` is on.
 */
function failPlan(verb: string, error: unknown, json: boolean, context: PlanFailureContext): void {
  if (error instanceof SddScriptError) {
    if (json) console.log(failurePayload(verb, "usage", error.message, context));
    else console.error(pc.red(`plan ${verb}: ${error.message}`));
    process.exitCode = error.exitCode;
    return;
  }
  const coordination = coordinationFailureOf(error);
  const message = error instanceof Error ? error.message : String(error);
  if (coordination !== null) {
    if (json) console.log(failurePayload(verb, coordination.code, message, context, coordination.details));
    else console.error(pc.red(`plan ${verb}: ${message}`));
    process.exitCode = 1;
    return;
  }
  if (json) console.log(failurePayload(verb, "plan.internal-error", message, context));
  else console.error(pc.red(`plan ${verb} failed: ${message}`));
  process.exitCode = 1;
}

/* ------------------------------------------------------------------------ *
 * § Argument shape (exit 2)
 * ------------------------------------------------------------------------ */

function requireFlag(raw: string | undefined, flag: string, verb: string, what: string): string {
  if (raw === undefined || raw.trim() === "") {
    throw new SddScriptError(`usage: plan ${verb} requires ${flag} <${what}>`, 2);
  }
  return raw;
}

/** Absolute paths are required where the engine addresses an existing file. */
function requireAbsolutePath(raw: string | undefined, flag: string, verb: string, what: string): string {
  const value = requireFlag(raw, flag, verb, what);
  if (!isAbsolute(value)) {
    throw new SddScriptError(`${flag} must be an absolute path — got ${JSON.stringify(value)}`, 2);
  }
  return value;
}

/** `--expect` is the nonnegative row `coordination.revision` from `show`. */
function parseExpect(raw: string | undefined, verb: string): number {
  if (raw === undefined) {
    throw new SddScriptError(
      `usage: plan ${verb} requires --expect <revision> (the row coordination.revision from \`mstar plan show\`; 0 when the row is not yet coordinated)`,
      2,
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new SddScriptError(`--expect must be a nonnegative integer revision — got ${JSON.stringify(raw)}`, 2);
  }
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision)) {
    throw new SddScriptError(`--expect is out of range — got ${JSON.stringify(raw)}`, 2);
  }
  return revision;
}

/** `absent` or the exact artifact version token, never an alias of either. */
function parseExpectedVersion(raw: string | undefined, flag: string, verb: string): string {
  const value = requireFlag(raw, flag, verb, "version");
  if (value === "absent" || /^sha256:[0-9a-f]{64}$/.test(value)) return value;
  throw new SddScriptError(`${flag} must be "absent" or sha256:<64 lowercase hex> — got ${JSON.stringify(value)}`, 2);
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
  if (result.outcome !== undefined) payload.outcome = result.outcome;
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
  const outcome = result.outcome === undefined ? "" : `; ${result.outcome}`;
  console.error(
    pc.green(`plan ${verb}: ${result.session.role} session ${result.session.session_id} on ${work}${revision}${outcome}`),
  );
  console.error(`plan ${verb}: session file ${result.session_file}`);
  if (payload.state !== undefined) console.error(`plan ${verb}: handoff state ${payload.state}`);
}

/**
 * `show` prints the view itself (spec §A2: selected row, scoped paths,
 * allowed operations and both byte versions — never an editable snapshot).
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
      register_version: view.register_version,
      session_file: view.session_file,
      session_id: view.session.session_id,
      role: view.session.role,
      scope: view.scope,
      row: { id: view.row.id, status: view.row.status },
      allowed_operations: view.allowed_operations,
    };
    if (view.session.plan_id !== undefined) payload.plan_id = view.session.plan_id;
    if (liveHandoff !== undefined) payload.handoff_id = liveHandoff;
    if (state !== undefined) payload.state = state;
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
  console.error(`plan ${verb}: snapshot ${view.snapshot_version}, register ${view.register_version}`);
  if (state !== undefined) console.error(`plan ${verb}: handoff state ${state}`);
  if (liveHandoff !== undefined) console.error(`plan ${verb}: handoff id ${liveHandoff}`);
  if (scope === null) {
    console.error(
      `plan ${verb}: this row is not prepared yet — run \`mstar plan prepare --session ${view.session_file} --plan <id> --assignment <absolute-md> --expect ${view.revision}\``,
    );
  } else {
    console.error(`plan ${verb}: worktree ${scope.worktreePath} (branch ${scope.workingBranch})`);
    console.error(`plan ${verb}: sdd ${scope.sddDir}`);
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
  const expectedRevision = parseExpect(options.expect as string | undefined, verb);
  const handoffId = options.handoff as string | undefined;
  const concrete = operation(options);
  if (handoffId !== undefined && planId !== undefined) {
    const live = handoffIdOf(await readPlanCoordination(sessionPath, planId));
    if (live !== undefined && live !== handoffId) throw handoffMismatch(verb, planId, live, handoffId);
  }
  pinSessionRoot(sessionPath);
  const result = await mutatePlanCoordination({
    sessionPath,
    ...(planId !== undefined ? { planId } : {}),
    expectedRevision,
    operation: concrete,
  });
  await printSuccess(verb, result, json);
}

/** The coordinator transition verbs registered by one shared flag surface. */
type TransitionKind = "accept" | "return" | "integration-start" | "integration-accept" | "complete" | "reconcile";

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
    `plan ${verb}: row ${planId} carries handoff ${live} — refusing the --handoff ${named} this call names`,
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
    throw new SddScriptError(`--harness must be an absolute path — got ${JSON.stringify(harness)}`, 2);
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
      "Bind the scoped session for one plan — fresh `--workflow/--plan` or `--assignment` claim (both addresses resolve " +
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
          pinProcessRoot("harnessDir" in input ? input.harnessDir : undefined);
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
    .command("residual-add")
    .description("Append residuals to this plan's own register bucket (active plan session)")
    .option("--session <path>", "Absolute plan session JSON envelope path")
    .option("--file <path>", "Absolute path of the residual entries JSON payload (array)")
    .option("--expect <revision>", "Row coordination.revision from `mstar plan show`")
    .option("--expect-register <version>", 'Register byte version from `show` ("absent" or sha256:<64 hex>)')
    .option("--json", "Machine-readable JSON on stdout")
    .action(async (options: PlanCliOptions) =>
      runVerb("residual-add", options, {}, (json) =>
        mutate("residual-add", options, json, false, (opts) => {
          // Every flag is validated before any file I/O: a malformed
          // `--expect-register` must reject as usage without reading --file.
          const expectedRegisterVersion = parseExpectedVersion(
            opts.expectRegister as string | undefined,
            "--expect-register",
            "residual-add",
          );
          const entries = readJsonPayload(opts.file as string | undefined, "--file", "residual-add") as ResidualEntriesPayload;
          return { kind: "residual-add", entries, expectedRegisterVersion };
        }),
      ),
    );

  plan
    .command("residual-close")
    .description("Close one residual in this plan's own bucket with an evidence-bearing note (active plan session)")
    .option("--session <path>", "Absolute plan session JSON envelope path")
    .option("--entry <id>", "Residual entry id")
    .option("--note <text>", "Closure note carrying the evidence")
    .option("--expect <revision>", "Row coordination.revision from `mstar plan show`")
    .option("--expect-register <version>", 'Register byte version from `show` ("absent" or sha256:<64 hex>)')
    .option("--json", "Machine-readable JSON on stdout")
    .action(async (options: PlanCliOptions) =>
      runVerb("residual-close", options, {}, (json) =>
        mutate("residual-close", options, json, false, (opts) => ({
          kind: "residual-close",
          entryId: requireFlag(opts.entry as string | undefined, "--entry", "residual-close", "entry-id"),
          note: requireFlag(opts.note as string | undefined, "--note", "residual-close", "text"),
          expectedRegisterVersion: parseExpectedVersion(
            opts.expectRegister as string | undefined,
            "--expect-register",
            "residual-close",
          ),
        })),
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

  // The six coordinator transitions share one flag surface; `return` alone
  // carries a reason.
  for (const [kind, description] of [
    ["accept", "Accept a submitted handoff: execution ownership transfers to the coordinator, no merge yet"],
    ["return", "Return a submitted/accepted handoff to the plan owner and restore its execution holder"],
    ["integration-start", "Record the integration attempt and pin its base before any Git merge (Git stays the operator's action)"],
    ["integration-accept", "Verify the pinned Git result of the started integration attempt (never runs a merge)"],
    ["complete", "Record Done atomically and release both leases after verified Git proof"],
    ["reconcile", "Observe Git after a crash and finish the attempt without a second merge, or refuse and keep state"],
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

  // Usage-class commander errors (unknown option, excess argument) exit 2 for
  // this verb family instead of commander's default exit 1; the shared
  // CommanderError mapping lives with the top-level parse call.
  for (const command of [plan, ...plan.commands]) command.exitOverride();
}
