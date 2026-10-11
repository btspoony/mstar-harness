/**
 * `gates` — host-neutral coordination-write gate core (Gate 1).
 *
 * Extracted verbatim from the omp hook glue (`packages/omp/src/hooks/pre/
 * mstar-gates.ts`, cross-host hooks contract D1) so omp,
 * ZCode, and any future host share ONE classification + validation path
 * instead of per-host hand copies (the opencode copy already drifted).
 * The engine was already the home of every rule check (validateStatus,
 * validateWorkflowSnapshot, validateProjectRegister, the layout resolvers)
 * — this module moves the deterministic glue around them in-tree: target
 * classification (marker probe -> declared-root fallback -> W-REV-3
 * double-harness re-classification), content-vs-edit validation dispatch
 * with the 2 MB size guards, and block-reason formatting. Because the glue
 * lives inside the engine, the validators and dir resolvers are same-tree
 * static imports — the host-side lazy loaders for those exports are
 * obsolete (the engine is inlined into every host bundle at build; a stale
 * engine dist now fails the build instead of silently degrading).
 *
 * Never throws: fs probes catch their own errors and a missing/unreadable
 * path is simply not a marker / a silent pass. Enforcement decisions
 * (hard vs soft) stay with the host — this module classifies and
 * validates only.
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readJson, type ValidationResult } from "./core.js";
import { resolveHarnessDir, resolveProjectDir, resolveWorkflowDir } from "./path.js";
import { validateStatus, type StatusV2Doc } from "./status.js";
import { validateWorkflowSnapshot } from "./workflow.js";
import { validateProjectRegister } from "./project.js";

const STATUS_FILE = "status.json";
const SNAPSHOT_FILE = "snapshot.json";
const REGISTER_FILE = "residuals.json";

/** Target paths from a write/edit event: `input.path` (string) plus `input.paths` (array). */
export function eventTargetPaths(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim() !== "") paths.push(value);
  };
  push(record.path);
  if (Array.isArray(record.paths)) {
    for (const value of record.paths) push(value);
  }
  return paths;
}

/** Gated harness coordination documents in v3 (compass ruling 7 — hard
 * cutover): the root `status.json` (v2), workflow snapshots
 * (`workflows/<id>/snapshot.json`) and project registers
 * (`projects/<id>/residuals.json`). Each kind maps to its engine
 * validator; everything else is not a gated coordination write. */
export type HarnessDocKind = "status" | "snapshot" | "register";

/**
 * Directory/entry check (never throws — a missing or unreadable path is
 * simply not a marker).
 */
function hasEntry(dir: string, name: string): boolean {
  try {
    statSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `dir` carries the v2 coordination-document markers that make
 * it a harness root: a `status.json` root file plus BOTH layout dirs.
 * Default-layout fast path: the `workflows/` + `projects/` names. A
 * `.mstarc` custom `workflow_dir` / `project_dir` layout is recognized via
 * the resolved absolute dirs. Never throws — a missing/unreadable path is
 * not a marker.
 */
function hasHarnessRootMarkers(dir: string): boolean {
  if (!hasEntry(dir, STATUS_FILE)) return false;
  if (hasEntry(dir, "workflows") && hasEntry(dir, "projects")) return true;
  try {
    return (
      hasEntry(resolveWorkflowDir(dir, { harnessDir: dir }), "") &&
      hasEntry(resolveProjectDir(dir, { harnessDir: dir }), "")
    );
  } catch {
    return false;
  }
}

/**
 * True when `dir` ITSELF is a harness root: the v2 coordination-document
 * markers above, or the root `resolveHarnessDir` answers from the
 * directory's PARENT (a declared `.mstarc harness_dir` / `MSTAR_HARNESS_DIR`
 * root is never answered by a probe INSIDE the root). The authority gates
 * ask this of a candidate's parent directory — "does this file sit directly
 * at a harness root?" — which the doc-kind probe above cannot answer.
 */
export function isHarnessRootDir(dir: string): boolean {
  if (hasHarnessRootMarkers(dir)) return true;
  const parentResolved = resolveHarnessDir(dirname(dir));
  return parentResolved !== null && resolve(parentResolved) === dir;
}

/**
 * Resolve the harness root containing `startDir` by marker probe: the nearest ancestor holding the v2 coordination-document
 * markers — a `status.json` root file plus the layout directories — IS the
 * harness root. Unlike `resolveHarnessDir`'s rung-3 `plans/` probe, this
 * never mistakes the NESTED `{HARNESS_DIR}/plans` subdir of the default
 * `.mstar` layout for the root, so coordination docs inside a
 * default-layout root stay gated. Returns `null` when no ancestor carries
 * the markers — callers fall back to `resolveHarnessDir` for declared
 * roots (`.mstarc` `harness_dir` / `MSTAR_HARNESS_DIR`) that are not yet
 * populated with all three markers.
 */
function resolveHarnessRootOf(target: string): string | null {
  let dir = resolve(target);
  for (;;) {
    if (hasHarnessRootMarkers(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Classify `targetPath` as a canonical `{HARNESS_DIR}` coordination
 * document: basename is `status.json` at the harness root, `snapshot.json`
 * under `{WORKFLOW_DIR}/<id>/`, or `residuals.json` under
 * `{PROJECT_DIR}/<id>/` (harness-relative, one path component each), AND
 * the harness root resolves — marker probe first (custom-layout-aware
 * Phase-5 F1), `resolveHarnessDir` as the declared-root fallback. The
 * snapshot/register rel is computed against the RESOLVED layout dirs
 * (`.mstarc` `workflow_dir`/`project_dir` honored, defaults
 * `workflows`/`projects`), so a custom layout classifies at the same
 * location the runtime writes. Everything else is not a gated write.
 * Returns the harness dir + doc kind when gated.
 */
export function harnessDocKindOfTarget(targetPath: string): { harnessDir: string; kind: HarnessDocKind } | null {
  if (typeof targetPath !== "string" || targetPath.trim() === "") return null;
  const resolved = resolve(targetPath);
  const name = basename(resolved);
  if (name !== STATUS_FILE && name !== SNAPSHOT_FILE && name !== REGISTER_FILE) return null;
  const classify = (harnessDir: string): { harnessDir: string; kind: HarnessDocKind } | null => {
    const rel = relative(harnessDir, resolved);
    if (name === STATUS_FILE && rel === STATUS_FILE) return { harnessDir, kind: "status" };
    let workflowDir: string;
    let projectDir: string;
    try {
      workflowDir = resolveWorkflowDir(harnessDir, { harnessDir });
      projectDir = resolveProjectDir(harnessDir, { harnessDir });
    } catch {
      workflowDir = join(harnessDir, "workflows");
      projectDir = join(harnessDir, "projects");
    }
    if (name === SNAPSHOT_FILE && /^[^/]+\/snapshot\.json$/.test(relative(workflowDir, resolved))) {
      return { harnessDir, kind: "snapshot" };
    }
    if (name === REGISTER_FILE && /^[^/]+\/residuals\.json$/.test(relative(projectDir, resolved))) {
      return { harnessDir, kind: "register" };
    }
    return null;
  };
  const probeRoot = resolveHarnessRootOf(dirname(resolved));
  const harnessDir = probeRoot ?? resolveHarnessDir(dirname(resolved));
  if (harnessDir === null) return null;
  const classified = classify(harnessDir);
  if (classified !== null) return classified;
  // W-REV-3: probe root hit but rel non-canonical — pathological double
  // harness (a nested sparse harness below a full-marker ancestor). Rebuild
  // rel against the declared-root resolution before giving up.
  if (probeRoot === null) return null;
  const fallbackDir = resolveHarnessDir(dirname(resolved));
  if (fallbackDir === null || fallbackDir === probeRoot) return null;
  return classify(fallbackDir);
}

// ---------------------------------------------------------------------------
// Violation formatting
// ---------------------------------------------------------------------------

export function violationLine(violation: ValidationResult): string {
  return `[${violation.severity}] ${violation.code}: ${violation.message}${
    violation.fix ? ` (fix: ${violation.fix})` : ""
  }`;
}

/**
 * Size guard: content strings beyond ~2MB are skipped without
 * parsing — a pathologically large write must not approach a host's
 * handler timeout (which fails CLOSED even in soft mode). The oversized
 * write passes silently; documented in the host gate contract.
 */
export const MAX_STATUS_CONTENT_LENGTH = 2 * 1024 * 1024;

/**
 * Options for {@link validateStatusWriteDoc}.
 */
export interface ValidateStatusWriteDocOptions {
  /**
   * Behavior when the content (string form) or the on-disk gated document
   * (edit form) exceeds `MAX_STATUS_CONTENT_LENGTH`. `"pass"` (default)
   * keeps the documented silent-pass degradation; `"violate"` reports a
   * `status.oversized` violation instead — for hosts whose block dialect
   * makes the oversized write an enforceable refusal rather than a
   * permission (the size check stays O(1), before any parse).
   */
  oversized?: "pass" | "violate";
}

/** The `status.oversized` violation: names the 2 MiB budget + the session
 * escape hatch of the enforcing host. */
function oversizedViolation(filePath: string): ValidationResult {
  return {
    ok: false,
    severity: "high",
    code: "status.oversized",
    message: `${basename(filePath)} exceeds the ${MAX_STATUS_CONTENT_LENGTH}-byte (2 MiB) coordination-document validation budget \u2014 repair out of band or disable for this session with MSTAR_WRITE_GATE=off`,
  };
}

/**
 * Validate the document being written to a gated harness coordination
 * document. `content` as a string is the new document: JSON.parse it
 * and run the matching engine validator on the parsed doc — a parse failure
 * is a violation (`status.invalid-json`, the same code/message shape the
 * engine emits for an unparseable file). Parsed `null` / non-object / array
 * content is a `status.invalid-json` violation too (the JSON
 * literal `null` would otherwise slip through `validateStatus`'s
 * destructuring into the outer catch's silent pass). Without a content
 * string (edit-style events) the on-disk file is validated — unless it does
 * not exist yet (fresh scaffold/init write): nothing to validate, silent
 * pass. Never throws (the validators catch their own read errors).
 */
export function validateStatusWriteDoc(
  content: unknown,
  filePath: string,
  kind: HarnessDocKind,
  options: ValidateStatusWriteDocOptions = {},
): ValidationResult[] {
  const oversized = options.oversized ?? "pass";
  if (typeof content === "string") {
    if (content.length > MAX_STATUS_CONTENT_LENGTH) {
      return oversized === "violate" ? [oversizedViolation(filePath)] : []; // size guard — silent pass by default
    }
    let doc: unknown;
    try {
      doc = JSON.parse(content);
    } catch (error) {
      return [
        {
          ok: false,
          severity: "high",
          code: "status.invalid-json",
          message: (error as Error).message,
        },
      ];
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      return [
        {
          ok: false,
          severity: "high",
          code: "status.invalid-json",
          message: `${basename(filePath)} content must be a JSON object`,
        },
      ];
    }
    return validateDocByKind(doc, kind);
  }
  if (!existsSync(filePath)) return []; // fresh scaffold/init write — nothing to validate
  // Size guard on the ON-DISK edit path: edit events carry no content
  // string, so the guard above never ran — stat the target and apply the
  // same 2MB skip before read+parse+validate (a pathologically large gated
  // doc must not approach the host handler timeout; oversized edits pass
  // silently by default, or violate under the `oversized: "violate"` opt-in).
  try {
    if (statSync(filePath).size > MAX_STATUS_CONTENT_LENGTH) {
      return oversized === "violate" ? [oversizedViolation(filePath)] : [];
    }
  } catch {
    return []; // unreadable target — silent pass (degrade path must never throw)
  }
  if (kind === "status") return validateStatus(filePath).violations; // path form handles invalid JSON itself
  let doc: unknown;
  try {
    doc = readJson(filePath);
  } catch (error) {
    // Mirror the engine's unparseable-file violation for snapshot/register
    // targets (their validators take a doc, not a path).
    return [
      {
        ok: false,
        severity: "high",
        code: "status.invalid-json",
        message: (error as Error).message,
      },
    ];
  }
  return validateDocByKind(doc, kind);
}

/** Run the validator matching the gated doc kind (v3 hard cutover). */
function validateDocByKind(doc: unknown, kind: HarnessDocKind): ValidationResult[] {
  if (kind === "snapshot") return validateWorkflowSnapshot(doc).violations;
  if (kind === "register") return validateProjectRegister(doc).violations;
  return validateStatus(doc as StatusV2Doc).violations;
}

/**
 * Format the gate block reason: one `violationLine` per violation, each
 * suffixed with the host's skill pointer (omp/ZCode parity: both hosts
 * pass `skill: mstar-artifacts/references/status-and-residuals.md`),
 * joined with newlines.
 */
export function formatStatusWriteBlockReason(violations: ValidationResult[], skillPointer: string): string {
  return violations.map((v) => `${violationLine(v)} (${skillPointer})`).join("\n");
}
