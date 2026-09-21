/**
 * Registered plan-path resolver — the single place that turns a caller-supplied
 * plan pointer into the canonical `{PLAN_DIR}/<plan-id>.md` file.
 *
 * Contract: `{SPECS_DIR}/prerequisite-identity-path-contract.md` §4 (one
 * plan-path contract). The accepted real file must be exactly the canonical
 * configured `{PLAN_DIR}/<plan-id>.md` with an unambiguous matching declared
 * `plan_id`; a directory, a missing file, an alias/symlink escape, traversal,
 * another plan's basename, a foreign root and a same-basename file in an
 * unrelated directory all refuse.
 *
 * Two input forms are accepted — a canonical absolute path, or a path relative
 * to the harness root. There is no fallback search and no second base: the
 * repository-relative spelling `.mstar/plans/<id>.md` resolves against the
 * harness root and therefore refuses naturally, which is the point (a stored
 * relative pointer would otherwise be reinterpreted later against another
 * base).
 *
 * `{PLAN_DIR}` comes from the existing configured-root resolver
 * (`path.ts#resolvePlanDir`), so a `.mstarc` `[config] plan_dir` declaration
 * and an external plan root both work without a second resolution rule.
 *
 * `planDeclaredHeaders` is the fence-aware declaration reader shared with the
 * amendment path: it replaces the private `planHeadersOf` body rather than
 * sitting beside a second parser (P2b owns that integration). The refusal is a
 * typed `PlanPathError` so the engine can map it onto its existing
 * `coordination.prepare-amendment.invalid-plan` vocabulary.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalTarget } from "./coordination-write.js";
import { assertSafePathComponent, canonicalizeNearestExisting, resolvePlanDir } from "./path.js";

/** Why a plan pointer was refused. P2b maps these onto the engine's refusal vocabulary. */
export type PlanPathRefusalCode =
  | "plan-path.invalid-pointer"
  | "plan-path.not-a-file"
  | "plan-path.unreadable"
  | "plan-path.conflicting-declaration"
  | "plan-path.identity-mismatch";

/** The typed refusal every rejection of this module uses. */
export class PlanPathError extends Error {
  readonly code: PlanPathRefusalCode;
  readonly details: Record<string, unknown>;

  constructor(code: PlanPathRefusalCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PlanPathError";
    this.code = code;
    this.details = details;
  }
}

/** Input of `resolveRegisteredPlanFile` (contract §4, verbatim). */
export type RegisteredPlanFileInput = { harnessRoot: string; planId: string; file: string };

/** Result of `resolveRegisteredPlanFile` (contract §4, verbatim). */
export type RegisteredPlanFile = { planPath: string; planDir: string; declaredPlanId: string };

/**
 * The plan-markdown labels the plan contract actually consults. Every other
 * `Label: value` line is plan-body content, and a real multi-task plan repeats
 * those per task (`**Files:**`, `**Task budget:**`) with a different value each
 * time — so a repeated label outside this set is not a declaration conflict.
 */
const PLAN_CONSULTED_HEADERS: Record<string, true> = {
  plan_id: true,
  "main worktree branch": true,
  "working branch": true,
};

/**
 * The consulted headers one plan markdown declares, keyed by lowercased label —
 * the forms real plan documents use: the colon inside the bold
 * (`**plan_id:** value`, the dominant form in `{PLAN_DIR}`) and the colon after
 * it (`**Main worktree branch**: value`); a plain `Label: value` line is
 * accepted too. Fenced code is skipped so a quoted example is never read as a
 * declaration, and a consulted label twice with different values refuses
 * instead of silently picking one.
 *
 * Behaviourally identical to the amendment path's private `planHeadersOf`; this
 * exported form is what lets registration and the amendment reuse one parser.
 */
export function planDeclaredHeaders(planPath: string): Map<string, string> {
  const headers = new Map<string, string>();
  // The fence is tracked by its marker character and run length: it is closed
  // only by a run of the same character at least as long, so a `~~~` example is
  // never read as a declaration and a shorter backtick run inside a longer
  // fence cannot close it early.
  let marker: string | undefined;
  let markerLength = 0;
  for (const raw of readFileSync(planPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const fence = /^(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      const run = fence[1]!;
      if (marker === undefined) {
        marker = run.charAt(0);
        markerLength = run.length;
      } else if (run.charAt(0) === marker && run.length >= markerLength) {
        marker = undefined;
      }
      continue;
    }
    if (marker !== undefined) continue;
    // `**Label:** value` / `**Label**: value` / `Label: value`: the label may
    // not contain `:` or `*` (those are the markup), and the value starts at
    // the first non-space character after the closing markup and colon.
    const match = /^\*{0,2}([^:*]+?)\*{0,2}:\*{0,2}\s*(\S.*)$/.exec(line);
    if (match === null) continue;
    const label = match[1]!.trim();
    const key = label.toLowerCase();
    if (PLAN_CONSULTED_HEADERS[key] !== true) continue;
    const value = match[2]!.trim();
    const prior = headers.get(key);
    if (prior !== undefined && prior !== value) {
      throw new PlanPathError(
        "plan-path.conflicting-declaration",
        `plan markdown ${planPath} declares conflicting "${label}" headers (${prior} vs ${value})`,
        { path: planPath, header: label, prior, value },
      );
    }
    headers.set(key, value);
  }
  return headers;
}

/** The received form of one pointer; named in every diagnostic. */
type PointerForm = "canonical-absolute" | "harness-relative";

/**
 * Resolve a caller-supplied plan pointer to the one registered plan file.
 *
 * Accepts a canonical absolute path or a harness-root-relative path. The
 * resolved real file must be exactly `{PLAN_DIR}/<planId>.md` and must declare
 * that same `plan_id`; anything else refuses with the received form, the base it
 * was resolved against, the expected canonical target and the permitted forms.
 */
export function resolveRegisteredPlanFile(input: RegisteredPlanFileInput): RegisteredPlanFile {
  const { harnessRoot, planId, file } = input;
  // The base a harness-relative spelling resolves against, and the configured
  // plan root, both canonical: a symlinked ancestor can therefore never make an
  // alias pass the equality check below.
  const base = canonicalizeNearestExisting(harnessRoot);
  const planDir = canonicalizeNearestExisting(resolvePlanDir(harnessRoot));
  const expected = join(planDir, `${planId}.md`);
  const form: PointerForm = isAbsolute(file) ? "canonical-absolute" : "harness-relative";
  const permitted = [`canonical absolute path ${expected}`, `harness-relative path resolved against ${base}`];
  const refusal = (code: PlanPathRefusalCode, message: string, extra: Record<string, unknown> = {}): PlanPathError =>
    new PlanPathError(code, message, { received: file, form, base, expected, permitted, ...extra });

  if (typeof planId !== "string" || typeof file !== "string") {
    throw refusal("plan-path.invalid-pointer", `a plan pointer needs a plan id and a file path as strings`, {
      plan_id: typeof planId === "string" ? planId : null,
    });
  }
  try {
    assertSafePathComponent(planId, "plan id");
  } catch (error) {
    throw refusal("plan-path.invalid-pointer", `plan id ${JSON.stringify(planId)} is not a single safe path component`, {
      plan_id: planId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (file.trim() === "") {
    throw refusal("plan-path.invalid-pointer", `plan ${planId} file must not be empty`);
  }

  // One resolution, no fallback: an absolute spelling is canonicalized as
  // given, a relative one against the harness root only. `canonicalTarget`
  // collapses `..` and resolves symlinked ancestors, so traversal and an alias
  // escape both land outside `expected` and refuse on the equality check.
  const candidate = canonicalTarget(form === "canonical-absolute" ? file : join(base, file));
  if (candidate !== expected) {
    throw refusal(
      "plan-path.invalid-pointer",
      `plan ${planId} file ${JSON.stringify(file)} resolves to ${candidate}, not the registered plan file ${expected}`,
      { plan_id: planId, actual: candidate },
    );
  }

  let isFile = false;
  try {
    isFile = existsSync(expected) && statSync(expected).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    throw refusal(
      "plan-path.not-a-file",
      `plan ${planId} markdown is not a readable file: ${expected}`,
      { plan_id: planId },
    );
  }

  let headers: Map<string, string>;
  try {
    headers = planDeclaredHeaders(expected);
  } catch (error) {
    if (error instanceof PlanPathError) {
      // Re-emit with the pointer diagnostic attached: the reader knows the file,
      // only this caller knows which spelling asked for it.
      throw refusal(error.code, error.message, { plan_id: planId, ...error.details });
    }
    throw refusal("plan-path.unreadable", `plan ${planId} markdown ${expected} could not be read`, {
      plan_id: planId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const declaredPlanId = headers.get("plan_id");
  if (declaredPlanId === undefined) {
    throw refusal(
      "plan-path.identity-mismatch",
      `plan ${planId} markdown ${expected} declares no plan_id header — the pointer cannot be traced to its reviewed plan`,
      { plan_id: planId },
    );
  }
  if (declaredPlanId !== planId) {
    throw refusal(
      "plan-path.identity-mismatch",
      `plan ${planId} pointer does not match the plan markdown header plan_id ${declaredPlanId} (${expected})`,
      { plan_id: planId, actual: declaredPlanId },
    );
  }
  return { planPath: expected, planDir, declaredPlanId };
}
