/**
 * scripts/skill-eval/report.ts — report aggregation
 * (Spec A1 report stage).
 *
 * Aggregates one run directory's scheduler state into JSON + Markdown. The
 * report NEVER reruns a model: it reads only the manifest and the evidence
 * already recorded by the runner. Honesty rules it enforces:
 * - the attempted denominator (requested units) is preserved — infrastructure
 * failures, unverified evidence and pending units all stay counted, never
 * averaged away;
 * - missing usage stays an explicit null with its reason; cost stays null
 * without a recorded price source; loaded bytes are labelled bytes and stay
 * null until a verified event schema exists;
 * - unverified assertions are listed explicitly as "unverified until evidence
 * adjudicated" — they are never folded into passes;
 * - exit conventions mirror the run stage: 0 all-verified passes, 1 completed
 * assertion failures only, 2 infrastructure / unverified / pending.
 */
import { join, resolve } from "node:path";
import { deriveDisposableRepoRoot, disposableRootContainmentErrors, sha256Hex } from "./manifest.ts";
import {
  exitForGrades,
  manifestIntegrityErrors,
  nodeRunnerIo,
  RUNNER_SCHEMA_VERSION,
  selectCases,
  type EvalManifest,
  type RunnerIo,
  type SchedulerState,
  type UnitGrade,
  type UnitRecord,
  type UsageBasis,
} from "./runner.ts";

// ---------------------------------------------------------------------------
// Report document
// ---------------------------------------------------------------------------

export interface ReportTurnRow {
  runId: string;
  turn: number;
  status: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  infrastructureReason: string | null;
  threadId: string | null;
  elapsedMs: number;
  usageEventCount: number;
  usageBasis: UsageBasis;
  usageReason: string | null;
  readEvidence: string;
  invocations: { counted: number; failed: number; unknownOutcome: number; unknownIdentity: number; readShaped: number; bundled: number; bundleUnknown: number; unrecognized: number; conflictingOutcome: number };
  resolutionContext: "warm" | "cold" | null;
}

export interface ReportUnitRow {
  unitId: string;
  caseId: string;
  variant: string;
  repeat: number;
  caseSplit: string;
  grade: UnitGrade | "pending";
  failureReason: string | null;
  turns: ReportTurnRow[];
  failedAssertions: string[];
  unverifiedAssertions: string[];
}

export interface EvalReport {
  schemaVersion: typeof RUNNER_SCHEMA_VERSION;
  generatedAt: string;
  manifest: {
    plan: string;
    sourceRefs: EvalManifest["sourceRefs"];
    cli: EvalManifest["cli"];
    requestedModel: string | null;
    requestedModelReason: string | null;
    observedModel: string | null;
    observedModelReason: string | null;
    configHash: string;
    heldoutDigest: string;
    interleaveSeed: number;
    repeats: number;
    sandbox: string;
  };
  manifestHash: string;
  request: SchedulerState["requested"];
  denominator: { requestedUnits: number; recordedUnits: number; pendingUnits: number };
  grades: Record<UnitGrade | "pending", number>;
  usage: {
    unitsWithObservedUsageEvents: number;
    unitsWithoutUsageEvents: number;
    basisCounts: Record<UsageBasis, number>;
  };
  elapsed: { totalMs: number; unitsCounted: number };
  assertions: { pass: number; fail: number; unverified: number };
  /** Bounded-resolution aggregates: declared contexts plus raw invocation accounting. */
  boundedResolution: {
    unitsDeclaredWarm: number;
    unitsDeclaredCold: number;
    /** RECORDED units whose selected case declares no context (a known absence). */
    unitsUndeclared: number;
    /** Units with no recorded evidence (pending): context unobserved, never "undeclared". */
    unitsContextUnknown: number;
    /**
     * RAW PER-TURN observations summed across turns — NOT the unit-scope
     * deduplicated budget (that is computed by the calls_within assertion).
     * A cross-turn start/completed pair appears once per turn here.
     */
    totalCallsCounted: number;
    totalFailedCalls: number;
    /** Observable constituent lookups bundled inside counted envelopes. */
    totalBundledLookups: number;
    /** Calls with an unobservable internal bundle. */
    totalBundleUnknownCalls: number;
    /** Counted calls whose outcome could not be determined (never a known zero-failure). */
    totalUnknownOutcomeCalls: number;
    /** Calls whose phases reported contradictory outcomes. */
    totalConflictingOutcomeCalls: number;
    /** Raw magnitude of unresolvable accounting (not just a flag). */
    totalUnknownIdentityCalls: number;
    totalUnrecognizedRecords: number;
    unitsWithUnknownIdentityCalls: number;
  };
  units: ReportUnitRow[];
  notes: string[];
}

export interface ReportArgs {
  manifestPath: string;
  /**
 * Repository root for the disposable-root write containment check. Defaults to the root derived from the manifest path; a run dir
 * outside any `<repoRoot>/.tmp/skill-eval/` root is refused before any
 * report artifact is written.
 */
  repoRoot?: string;
  io?: RunnerIo;
}

export interface ReportResult {
  exit: 0 | 1 | 2;
  jsonPath: string;
  mdPath: string;
  report: EvalReport;
  errors: string[];
}

const HONESTY_NOTES = [
  "usage counters are per-event observations only; the per-turn vs cumulative basis is 'unknown' until a real smoke verifies attribution, so no totals are summed",
  "missing token counters are null with a reason — they are never reported as zero (AC3)",
  "cost is null unless observed usage and a recorded price source both exist; no price lookup is performed",
  "bytesLoaded is labelled bytes and stays null until a verified event schema allows accounting (AC3)",
  "unverified assertions remain in the attempted denominator and are listed explicitly; they are not passes (AC4/AC5)",
  "invocation calls are deduplicated by invocation identity; a record without any identity stays an unknown (never zero-filled), and failed attempts still count",
  "the warm/cold resolution context is the case's declared bootstrap precondition, never an inference from the event stream; a record whose shape is unrecognized is an unknown, not a zero",
  "invocation outcomes distinguish observed failure, observed success and unknown; an unsupported status/exit encoding stays unknown and is surfaced, never folded into a known-zero failure total",
  "a missing, empty, or unterminated event stream cannot establish accounting completeness, and observable bundled constituent lookups are counted separately from their envelope; an undecomposable internal bundle stays unknown",
  "boundedResolution totals are RAW PER-TURN observations summed across turns — the unit-scope deduplicated budget is what the calls_within assertion grades, so the two numbers are not interchangeable",
  "contradictory phase outcomes (one failed, one succeeded) surface as conflicting/unknown rather than being resolved into either",
  "this report aggregates recorded evidence only — it never reruns a model and never substitutes synthetic results for real ones (AC4)",
];

function requestedUnitIds(state: SchedulerState, manifest: EvalManifest): string[] {
 // :the case selection is the runner's exported SSOT — the
 // report denominator can no longer drift from the executed selection.
  const cases = selectCases(manifest, state.requested.split);
  const ids: string[] = [];
  for (let repeat = 1; repeat <= state.requested.repeats; repeat += 1) {
    for (const c of cases) {
      for (const variant of state.requested.variants) ids.push(`${c.id}/${variant}/${repeat}`);
    }
  }
  return ids;
}

function unitRow(unit: UnitRecord, grade: UnitGrade | "pending"): ReportUnitRow {
  const turns = Object.values(unit.turns)
    .sort((a, b) => a.turn - b.turn)
    .map((t) => ({
      runId: t.runId,
      turn: t.turn,
      status: t.status,
      exitCode: t.exitCode,
      signal: t.signal,
      timedOut: t.timedOut,
      infrastructureReason: t.infrastructureReason,
      threadId: t.threadId,
      elapsedMs: t.metrics.elapsedMs,
      usageEventCount: t.metrics.usageEvents.length,
      usageBasis: t.metrics.usageBasis,
      usageReason: t.metrics.usage.reason,
      readEvidence: t.metrics.readEvidence,
      invocations: t.metrics.invocations,
      resolutionContext: t.metrics.resolutionContext,
    }));
  const failed = unit.grading?.assertions.filter((a) => a.grade === "fail").map((a) => `${a.assertionId}(${a.kind})`) ?? [];
  const unverified =
    unit.grading?.assertions.filter((a) => a.grade === "unverified").map((a) => `${a.assertionId}(${a.kind})`) ?? [];
  return {
    unitId: unit.unitId,
    caseId: unit.caseId,
    variant: unit.variant,
    repeat: unit.repeat,
    caseSplit: unit.caseSplit,
    grade,
    failureReason: unit.failureReason,
    turns,
    failedAssertions: failed,
    unverifiedAssertions: unverified,
  };
}

function toMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# skill-eval run report`);
  lines.push("");
  lines.push(`- plan: ${report.manifest.plan}`);
  lines.push(`- sourceRefs: baseline ${report.manifest.sourceRefs.baseline} / candidate ${report.manifest.sourceRefs.candidate}`);
  lines.push(`- cli: ${report.manifest.cli.path} (${report.manifest.cli.version})`);
  lines.push(
    `- requestedModel: ${JSON.stringify(report.manifest.requestedModel)}${report.manifest.requestedModelReason ? ` (${report.manifest.requestedModelReason})` : ""}`,
  );
  lines.push(
    `- observedModel: ${JSON.stringify(report.manifest.observedModel)}${report.manifest.observedModelReason ? ` (${report.manifest.observedModelReason})` : ""}`,
  );
  lines.push(`- configHash: ${report.manifest.configHash}`);
  lines.push(`- heldoutDigest: ${report.manifest.heldoutDigest}`);
  lines.push(
    `- request: split=${report.request.split} variants=${report.request.variants.join(",")} repeats=${report.request.repeats} interleaveSeed=${report.manifest.interleaveSeed}`,
  );
  lines.push("");
  lines.push("## Denominator and grades");
  lines.push("");
  lines.push(`- requested units (attempted denominator): ${report.denominator.requestedUnits}`);
  lines.push(`- recorded units: ${report.denominator.recordedUnits}; pending: ${report.denominator.pendingUnits}`);
  lines.push(
    `- grades: pass=${report.grades.pass} fail=${report.grades.fail} unverified=${report.grades.unverified} infrastructure_error=${report.grades.infrastructure_error} pending=${report.grades.pending}`,
  );
  lines.push("");
  lines.push("## Usage honesty (AC3)");
  lines.push("");
  lines.push(
    `- units with observed usage events: ${report.usage.unitsWithObservedUsageEvents}; without: ${report.usage.unitsWithoutUsageEvents}`,
  );
  lines.push(
    `- usage basis counts: per_turn=${report.usage.basisCounts.per_turn} cumulative=${report.usage.basisCounts.cumulative} unknown=${report.usage.basisCounts.unknown}`,
  );
  lines.push(
    `- elapsed: ${report.elapsed.totalMs} ms over ${report.elapsed.unitsCounted} counted turns`,
  );
  lines.push("");
  lines.push("## Bounded-resolution accounting");
  lines.push("");
  lines.push(
    `- declared context: warm=${report.boundedResolution.unitsDeclaredWarm} cold=${report.boundedResolution.unitsDeclaredCold} undeclared=${report.boundedResolution.unitsUndeclared} context-unknown(pending)=${report.boundedResolution.unitsContextUnknown}`,
  );
  lines.push(
    `- raw per-turn invocation observations (unit-scope dedupe is applied by the calls_within assertion): envelopes counted=${report.boundedResolution.totalCallsCounted} bundled-constituent-lookups=${report.boundedResolution.totalBundledLookups} bundle-unknown-calls=${report.boundedResolution.totalBundleUnknownCalls} observed-failures=${report.boundedResolution.totalFailedCalls} unknown-outcomes=${report.boundedResolution.totalUnknownOutcomeCalls} conflicting-outcomes=${report.boundedResolution.totalConflictingOutcomeCalls} unknown-identity=${report.boundedResolution.totalUnknownIdentityCalls} unrecognized-records=${report.boundedResolution.totalUnrecognizedRecords} units with unknown-identity calls=${report.boundedResolution.unitsWithUnknownIdentityCalls}`,
  );
  lines.push("");
  lines.push("## Units");
  lines.push("");
  lines.push("| unit | split | grade | turns (calls/failed/unknown-outcome/unknown-id/read-shaped/bundled) | failure reason |");
  lines.push("|---|---|---|---|---|");
  for (const u of report.units) {
    lines.push(
      `| ${u.unitId} | ${u.caseSplit} | ${u.grade} | ${u.turns.map((t) => `t${t.turn}:${t.status}${t.infrastructureReason ? `(${t.infrastructureReason})` : ""}[c${t.invocations.counted}/f${t.invocations.failed}/o${t.invocations.unknownOutcome}/u${t.invocations.unknownIdentity}/rs${t.invocations.readShaped}/b${t.invocations.bundled}]`).join(" ")} | ${u.failureReason ?? ""} |`,
    );
  }
  const unverified = report.units.flatMap((u) => u.unverifiedAssertions.map((a) => `${u.unitId} ${a}`));
  const failed = report.units.flatMap((u) => u.failedAssertions.map((a) => `${u.unitId} ${a}`));
  if (unverified.length > 0) {
    lines.push("");
    lines.push("## Unverified assertions (unverified until evidence adjudicated)");
    lines.push("");
    for (const item of unverified) lines.push(`- ${item}`);
  }
  if (failed.length > 0) {
    lines.push("");
    lines.push("## Failed assertions");
    lines.push("");
    for (const item of failed) lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  for (const note of report.notes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the report for one run directory (manifest.json's parent). Exit
 * conventions mirror the run stage; missing state or state recorded against
 * different manifest bytes is an exit-2 error — the report never fabricates
 * results for units that never ran and never relabels one run's grades with
 * another manifest's identity.
 */
export function buildReport(args: ReportArgs): ReportResult {
  const io = args.io ?? nodeRunnerIo;
  const manifestPath = resolve(args.manifestPath);
  const runDir = resolve(manifestPath, "..");
  const statePath = join(runDir, "scheduler", "state.json");
  const jsonPath = join(runDir, "report.json");
  const mdPath = join(runDir, "report.md");
  const emptyGrades: Record<UnitGrade | "pending", number> = { pass: 0, fail: 0, unverified: 0, infrastructure_error: 0, pending: 0 };

  const fail = (errors: string[]): ReportResult => ({
    exit: 2,
    jsonPath,
    mdPath,
    report: {
      schemaVersion: RUNNER_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      manifest: {
        plan: "",
        sourceRefs: { baseline: "", candidate: "" },
        cli: { path: "", version: "", helpHash: "" },
        requestedModel: null,
        requestedModelReason: null,
        observedModel: null,
        observedModelReason: null,
        configHash: "",
        heldoutDigest: "",
        interleaveSeed: 0,
        repeats: 0,
        sandbox: "",
      },
      manifestHash: "",
      request: { split: "dev", variants: [], repeats: 0 },
      denominator: { requestedUnits: 0, recordedUnits: 0, pendingUnits: 0 },
      grades: { ...emptyGrades },
      usage: { unitsWithObservedUsageEvents: 0, unitsWithoutUsageEvents: 0, basisCounts: { per_turn: 0, cumulative: 0, unknown: 0 } },
      elapsed: { totalMs: 0, unitsCounted: 0 },
      assertions: { pass: 0, fail: 0, unverified: 0 },
      boundedResolution: {
        unitsDeclaredWarm: 0,
        unitsDeclaredCold: 0,
        unitsUndeclared: 0,
        unitsContextUnknown: 0,
        totalCallsCounted: 0,
        totalFailedCalls: 0,
        totalBundledLookups: 0,
        totalBundleUnknownCalls: 0,
        totalUnknownOutcomeCalls: 0,
    totalConflictingOutcomeCalls: 0,
        totalConflictingOutcomeCalls: 0,
        totalUnknownIdentityCalls: 0,
        totalUnrecognizedRecords: 0,
        unitsWithUnknownIdentityCalls: 0,
      },
      units: [],
      notes: errors,
    },
    errors,
  });

 // Disposable-root write containment : the report writes
 // report.json/report.md next to the manifest; like run/prepare, refuse
 // (exit 2, zero writes) when that dir is not strictly inside the
 // disposable fixture root.
  const containmentRepoRoot = args.repoRoot ?? deriveDisposableRepoRoot(manifestPath);
  const containment =
    containmentRepoRoot === null
      ? {
          errors: [
            `run dir ${runDir} is not inside a disposable <repoRoot>/.tmp/skill-eval/ root; writes must stay in the disposable fixture root (Spec A1)`,
          ],
        }
      : disposableRootContainmentErrors(runDir, containmentRepoRoot, io);
  if (containment.errors.length > 0) return fail(containment.errors);

  let manifest: EvalManifest;
  try {
    manifest = JSON.parse(io.readText(manifestPath)) as EvalManifest;
  } catch (error) {
    return fail([`cannot read manifest ${manifestPath}: ${(error as Error).message}`]);
  }
  const integrity = manifestIntegrityErrors(manifest);
  if (manifest.schemaVersion !== 1) integrity.unshift(`manifest schemaVersion must be 1, got ${String(manifest.schemaVersion)}`);
  if (integrity.length > 0) return fail(integrity);

  if (!io.exists(statePath)) {
    return fail([`no scheduler state at ${statePath}; run the eval first — the report never reruns a model`]);
  }
  let state: SchedulerState;
  try {
    state = JSON.parse(io.readText(statePath)) as SchedulerState;
  } catch (error) {
    return fail([`scheduler state unreadable: ${(error as Error).message}`]);
  }
  if (state.schemaVersion !== RUNNER_SCHEMA_VERSION) {
    return fail([`scheduler state schemaVersion must be ${RUNNER_SCHEMA_VERSION}, got ${String(state.schemaVersion)}`]);
  }
 // Manifest binding (mirrors the runner's state guard): state may only be
 // aggregated against the exact manifest bytes it was recorded with — a
 // post-run manifest swap would otherwise report run A's grades under
 // manifest B. Refusal happens before any artifact write.
  const manifestHash = sha256Hex(io.readText(manifestPath));
  if (state.manifestHash !== manifestHash) {
    return fail(["scheduler state belongs to a different manifest; refusing to report its grades under the current manifest bytes"]);
  }

  const requested = requestedUnitIds(state, manifest);
  const grades: Record<UnitGrade | "pending", number> = { pass: 0, fail: 0, unverified: 0, infrastructure_error: 0, pending: 0 };
  const basisCounts: Record<UsageBasis, number> = { per_turn: 0, cumulative: 0, unknown: 0 };
  const units: ReportUnitRow[] = [];
  let totalMs = 0;
  let elapsedTurns = 0;
  let unitsWithUsage = 0;
  const assertions = { pass: 0, fail: 0, unverified: 0 };
  const bounded = {
    unitsDeclaredWarm: 0,
    unitsDeclaredCold: 0,
    unitsUndeclared: 0,
    unitsContextUnknown: 0,
    totalCallsCounted: 0,
    totalFailedCalls: 0,
    totalBundledLookups: 0,
    totalBundleUnknownCalls: 0,
    totalUnknownOutcomeCalls: 0,
    totalConflictingOutcomeCalls: 0,
    totalUnknownIdentityCalls: 0,
    totalUnrecognizedRecords: 0,
    unitsWithUnknownIdentityCalls: 0,
  };

  for (const unitId of requested) {
    const unit = state.units[unitId];
    const grade: UnitGrade | "pending" = unit?.grade ?? "pending";
    grades[grade] += 1;
    if (!unit) {
      units.push({
        unitId,
        caseId: unitId.split("/")[0],
        variant: unitId.split("/")[1],
        repeat: Number(unitId.split("/")[2]),
        caseSplit: "",
        grade: "pending",
        failureReason: "no recorded unit (never executed or lost state)",
        turns: [],
        failedAssertions: [],
        unverifiedAssertions: [],
      });
      // No recorded evidence: the context was never observed. This is NOT
      // the same fact as a recorded case that declares no context.
      bounded.unitsContextUnknown += 1;
      continue;
    }
    const manifestCase = manifest.cases.find((c) => c.id === unit.caseId);
    if (manifestCase?.boundedResolution?.context === "warm") bounded.unitsDeclaredWarm += 1;
    else if (manifestCase?.boundedResolution?.context === "cold") bounded.unitsDeclaredCold += 1;
    else bounded.unitsUndeclared += 1;
    const row = unitRow(unit, grade);
    units.push(row);
    for (const a of unit.grading?.assertions ?? []) assertions[a.grade] += 1;
    let unitHasUsage = false;
    let unitUnknownIdentity = false;
    for (const t of Object.values(unit.turns)) {
      totalMs += t.metrics.elapsedMs;
      elapsedTurns += 1;
      basisCounts[t.metrics.usageBasis] += 1;
      if (t.metrics.usageEvents.length > 0) unitHasUsage = true;
      bounded.totalCallsCounted += t.metrics.invocations.counted;
      bounded.totalFailedCalls += t.metrics.invocations.failed;
      bounded.totalBundledLookups += t.metrics.invocations.bundled;
      bounded.totalBundleUnknownCalls += t.metrics.invocations.bundleUnknown;
      bounded.totalUnknownOutcomeCalls += t.metrics.invocations.unknownOutcome;
      bounded.totalConflictingOutcomeCalls += t.metrics.invocations.conflictingOutcome;
      bounded.totalUnknownIdentityCalls += t.metrics.invocations.unknownIdentity;
      bounded.totalUnrecognizedRecords += t.metrics.invocations.unrecognized;
      if (t.metrics.invocations.unknownIdentity > 0) unitUnknownIdentity = true;
    }
    if (unitUnknownIdentity) bounded.unitsWithUnknownIdentityCalls += 1;
    if (unitHasUsage) unitsWithUsage += 1;
  }
  const unitsWithoutUsage = requested.length - unitsWithUsage;

  const report: EvalReport = {
    schemaVersion: RUNNER_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),    manifest: {
      plan: manifest.plan,
      sourceRefs: manifest.sourceRefs,
      cli: manifest.cli,
      requestedModel: manifest.requestedModel,
      requestedModelReason: manifest.requestedModelReason,
      observedModel: manifest.observedModel,
      observedModelReason: manifest.observedModelReason,
      configHash: manifest.configHash,
      heldoutDigest: manifest.heldoutDigest,
      interleaveSeed: manifest.interleaveSeed,
      repeats: manifest.repeats,
      sandbox: manifest.sandbox,
    },
    manifestHash,
    request: state.requested,
    denominator: { requestedUnits: requested.length, recordedUnits: requested.length - grades.pending, pendingUnits: grades.pending },
    grades,
    usage: { unitsWithObservedUsageEvents: unitsWithUsage, unitsWithoutUsageEvents: unitsWithoutUsage, basisCounts },
    elapsed: { totalMs, unitsCounted: elapsedTurns },
    assertions,
    boundedResolution: bounded,
    units,
    notes: [...HONESTY_NOTES],
  };

  io.writeText(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  io.writeText(mdPath, toMarkdown(report));
  return { exit: exitForGrades(grades), jsonPath, mdPath, report, errors: [] };
}
