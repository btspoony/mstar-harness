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
 * Two input forms are accepted — a canonical absolute path, or a normalized
 * path relative to the harness root. There is no fallback search and no second
 * base: the repository-relative spelling `.mstar/plans/<id>.md` resolves
 * against the harness root and therefore refuses naturally, which is the point
 * (a stored relative pointer would otherwise be reinterpreted later against
 * another base).
 *
 * Acceptance is therefore two boundaries, not one: the spelling itself must be
 * normalized (no `.`/`..` segments) and a relative one may not traverse out of
 * the harness root, *and* the resolved real file must equal the canonical
 * configured target. The target equality alone is not sufficient — a `..`
 * spelling can normalize back onto `PLAN_DIR/<id>.md`, and a relative escape
 * can reach an external configured plan root that the contract only admits as
 * absolute input.
 *
 * `{PLAN_DIR}` comes from the existing configured-root resolver
 * (`path.ts#resolvePlanDir`), so a `.mstarc` `[config] plan_dir` declaration
 * and an external plan root both work without a second resolution rule.
 *
 * `planDeclaredHeaders` is the one declaration reader: registration,
 * readiness and the path resolver all read plan declarations through it rather
 * than sitting beside a second parser, and it reads the front matter fence
 * through the shared document-frontmatter reader — the body is never scanned.
 * The refusal is a typed `PlanPathError` carrying a `plan-path.*` code, so a
 * caller reports or maps that code itself.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { canonicalTarget } from "./coordination-write.js";
import { DocumentFrontmatterError, extractFrontmatterAndBody, parseDocumentFrontmatterEntries, type FrontmatterAndBody } from "./document-frontmatter.js";
import { assertSafePathComponent, canonicalizeNearestExisting, resolvePlanDir } from "./path.js";

/** Why a plan pointer was refused; these codes propagate unmapped. */
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
 * The plan front-matter keys the plan contract actually consults, keyed by the
 * lowercased space-separated label the callers read, with values read from the
 * front-matter keys `plan_id`, `main_worktree_branch` and `working_branch`.
 * The body is never scanned: a `**plan_id:**` line outside the front matter is
 * body content, not a declaration.
 */
const PLAN_CONSULTED_KEYS: Record<string, string> = {
  "main worktree branch": "main_worktree_branch",
  plan_id: "plan_id",
  "working branch": "working_branch",
};

/**
 * The consulted headers one plan markdown declares, keyed by lowercased label
 * (`'plan_id'`, `'main worktree branch'`, `'working branch'` — the shapes the
 * consumers read), with each value taken from the shared reader's RAW scalar
 * text so a numeric-looking spelling (`5.0`) survives. A duplicate key or an
 * unsupported line is the shared reader's `DocumentFrontmatterError` naming
 * `file:line`; a present but non-scalar declaration or an unterminated fence is
 * this module's `plan-path.identity-mismatch` refusal — never an absent key.
 *
 * This exported form is what lets registration, readiness and the path resolver
 * share one parser instead of each keeping its own copy.
 */
export function planDeclaredHeaders(planPath: string): Map<string, string> {
  return planDeclaredHeadersFromContent(readFileSync(planPath, "utf8"), planPath);
}

/** An opening front-matter fence with no closing one: the shared reader reports
 * that as an unfenced document, but a plan whose first line is `---` declared
 * an invalid surface rather than no declarations at all. */
function isUnterminatedFence(content: string, extraction: FrontmatterAndBody): boolean {
  return (
    !extraction.fenced &&
    extraction.frontmatter === "" &&
    (content.startsWith("---\n") || content.startsWith("---\r\n"))
  );
}

/** The one refusal for an unterminated plan front matter: invalid, not absent. */
function unterminatedFenceRefusal(planPath: string): PlanPathError {
  return new PlanPathError(
    "plan-path.identity-mismatch",
    `plan markdown ${planPath} opens a front matter fence that is never closed \u2014 the declaration is invalid, not absent; close the fence with a second "---" line`,
  );
}

/**
 * The same consulted-header read over ALREADY-READ plan bytes: the caller
 * hashes and validates one snapshot (a bind adoption pins the digest and
 * checks the declarations of those exact bytes), so the parser must not
 * re-read the path and observe a different file. `planPath` names diagnostics
 * only — it is never read here.
 */
export function planDeclaredHeadersFromContent(content: string, planPath: string): Map<string, string> {
  const extraction = extractFrontmatterAndBody(content);
  if (isUnterminatedFence(content, extraction)) throw unterminatedFenceRefusal(planPath);
  const entries = parseDocumentFrontmatterEntries(extraction.frontmatter, planPath);
  const headers = new Map<string, string>();
  for (const [label, key] of Object.entries(PLAN_CONSULTED_KEYS)) {
    const entry = entries.get(key);
    if (entry === undefined) continue;
    // The raw lexeme after the colon is the declaration — never the typed
    // scalar: `main_worktree_branch: 5.0` is the branch spelling "5.0", and a
    // numeric-looking plan id keeps its written form. One surrounding pair of
    // matching quotes still strips (the quotes are the spelling's syntax, not
    // the branch's text).
    if (entry.kind === "scalar") {
      const raw = entry.rawText;
      const value =
        raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0]
          ? raw.slice(1, -1)
          : raw;
      headers.set(label, value);
      continue;
    }
    // A present but non-scalar declaration (a list, a nested map, a block
    // scalar) is invalid — never dropped to an absent key, because the absent
    // key is exactly what the consumer's snapshot fallback reads. An EMPTY
    // list or map carries no content at all and counts as absent exactly as
    // the schema validator's usable-content rule reads it.
    const emptyShape =
      (entry.kind === "list" && Array.isArray(entry.value) && entry.value.length === 0) ||
      (entry.kind === "map" && typeof entry.value === "object" && entry.value !== null && Object.keys(entry.value as object).length === 0);
    if (emptyShape) continue;
    throw new PlanPathError(
      "plan-path.identity-mismatch",
      `plan markdown ${planPath}:${entry.line} declares an invalid ${key} \u2014 accepted value: a single scalar, not a ${entry.kind}; rewrite the declaration as ${key}: <branch>`,
      { key, kind: entry.kind, line: entry.line },
    );
  }
  return headers;
}

/** The received form of one pointer; named in every diagnostic. */
type PointerForm = "canonical-absolute" | "harness-relative";

/** The received type of one malformed pointer value — the type, never the value. */
function describePointerValue(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/** One pointer whose spelling, containment and canonical target were accepted. */
type PlanPointerContext = {
  planId: string;
  file: string;
  base: string;
  planDir: string;
  expected: string;
  form: PointerForm;
  permitted: string[];
};

/** The typed refusal of one pointer, naming the received form and both accepted ones. */
function planPointerRefusal(
  context: PlanPointerContext,
): (code: PlanPathRefusalCode, message: string, extra?: Record<string, unknown>) => PlanPathError {
  return (code, message, extra = {}) =>
    new PlanPathError(code, message, {
      received: context.file,
      form: context.form,
      base: context.base,
      expected: context.expected,
      permitted: context.permitted,
      ...extra,
    });
}

/**
 * Settle one pointer's spelling, containment and canonical target: every check
 * that is a fact about the POINTER. The document itself is not read, so the
 * target stays decidable after the file was removed — the file proof is
 * `resolveRegisteredPlanFile`'s own second half.
 */
function planPointerContext(input: RegisteredPlanFileInput): PlanPointerContext {
  const { harnessRoot, planId, file } = input;
  // The shared exported contract (§4), so the pointer SHAPE is settled before
  // any path API sees a value: a JavaScript caller or a decoded payload can
  // supply `null`, a number, an object or no `file` at all, and `isAbsolute`
  // would then raise a raw Node `TypeError` instead of the typed refusal this
  // resolver promises and its callers map onto their own domain error. The
  // rejected value itself is never echoed — only the received type is named.
  if (typeof planId !== "string" || typeof file !== "string") {
    throw new PlanPathError(
      "plan-path.invalid-pointer",
      "a plan pointer needs a plan id and a file path as strings; received " +
        `${describePointerValue(planId)} as the plan id and ${describePointerValue(file)} as the file`,
      { plan_id: typeof planId === "string" ? planId : null, form: null },
    );
  }
  // The base a harness-relative spelling resolves against, and the configured
  // plan root, both canonical: a symlinked ancestor can therefore never make an
  // alias pass the equality check below.
  const base = canonicalizeNearestExisting(harnessRoot);
  const planDir = canonicalizeNearestExisting(resolvePlanDir(harnessRoot));
  const expected = join(planDir, `${planId}.md`);
  const form: PointerForm = isAbsolute(file) ? "canonical-absolute" : "harness-relative";
  const permitted = [
    `canonical absolute path ${expected}`,
    `normalized harness-relative path resolved against ${base}`,
  ];
  const refusal = planPointerRefusal({ planId, file, base, planDir, expected, form, permitted });

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
  // collapses `..` and resolves symlinked ancestors, so the equality check
  // below is what refuses an alias escape or a traversal that lands anywhere
  // other than `expected`.
  const candidate = canonicalTarget(form === "canonical-absolute" ? file : join(base, file));

  // Target equality alone is not acceptance, though: a `..` spelling can come
  // back onto `expected` (`plans/../plans/<id>.md`), and a relative escape can
  // reach an external configured plan root that §4 only admits as absolute
  // input. So the accepted spelling must itself be normalized, and a relative
  // one must stay inside the harness root — checked before the equality so no
  // traversal can pass merely by landing on the right file.
  const normalized = normalize(file);
  if (normalized !== file) {
    throw refusal(
      "plan-path.invalid-pointer",
      `plan ${planId} file ${JSON.stringify(file)} is not a normalized ${form === "canonical-absolute" ? "absolute" : "harness-relative"} spelling (${JSON.stringify(normalized)}); permitted forms are ${permitted.join(" or ")}`,
      { plan_id: planId, actual: candidate, normalized },
    );
  }
  if (form === "harness-relative" && (normalized === ".." || normalized.startsWith(`..${sep}`))) {
    throw refusal(
      "plan-path.invalid-pointer",
      `plan ${planId} file ${JSON.stringify(file)} traverses out of the harness root ${base}; permitted forms are ${permitted.join(" or ")}`,
      { plan_id: planId, actual: candidate, normalized },
    );
  }
  if (candidate !== expected) {
    throw refusal(
      "plan-path.invalid-pointer",
      `plan ${planId} file ${JSON.stringify(file)} resolves to ${candidate}, not the registered plan file ${expected}; permitted forms are ${permitted.join(" or ")}`,
      { plan_id: planId, actual: candidate },
    );
  }
  return { planId, file, base, planDir, expected, form, permitted };
}

/**
 * The canonical `{PLAN_DIR}/<planId>.md` one accepted pointer names, without
 * reading the document. Registration canonicalizes the pointer this way before
 * the operation replay, so the stored pointer and the request fingerprint are
 * decided by path facts alone and a removed or edited document cannot move
 * them; the document proof is `resolveRegisteredPlanFile`.
 */
export function canonicalRegisteredPlanPath(input: RegisteredPlanFileInput): { planPath: string; planDir: string } {
  const { planDir, expected } = planPointerContext(input);
  return { planPath: expected, planDir };
}

/**
 * Resolve a caller-supplied plan pointer to the one registered plan file.
 *
 * Accepts a canonical (normalized) absolute path or a normalized
 * harness-root-relative path. The spelling must be normalized and a relative
 * one must stay inside the harness root; the resolved real file must then be
 * exactly `{PLAN_DIR}/<planId>.md` and must declare that same `plan_id`.
 * Anything else refuses with the received form, the base it was resolved
 * against, the expected canonical target and the permitted forms.
 */
export function resolveRegisteredPlanFile(input: RegisteredPlanFileInput): RegisteredPlanFile {
  const context = planPointerContext(input);
  const { planId, expected, planDir } = context;
  const refusal = planPointerRefusal(context);

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
    // The shared front-matter reader's diagnostic is the caller's contract:
    // propagate it unchanged so the caller keeps the file:line it names.
    if (error instanceof DocumentFrontmatterError) {
      throw error;
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
      `plan ${planId} markdown ${expected} declares no plan_id in its front matter \u2014 the pointer cannot be traced to its reviewed plan; add a plan_id: line inside the front matter fence`,
      { plan_id: planId },
    );
  }
  if (declaredPlanId !== planId) {
    throw refusal(
      "plan-path.identity-mismatch",
      `plan ${planId} pointer does not match the plan markdown front matter plan_id ${declaredPlanId} (${expected})`,
      { plan_id: planId, actual: declaredPlanId },
    );
  }
  return { planPath: expected, planDir, declaredPlanId };
}
