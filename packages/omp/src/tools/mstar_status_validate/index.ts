/**
 * mstar_status_validate — validate a Morning Star harness v2 status.json
 * root, a workflow snapshot (`workflows/<id>/snapshot.json`) or a project
 * register (`projects/<id>/residuals.json`) via the engine's
 * `validateStatus` / `validateWorkflowSnapshot` / `validateProjectRegister`
 * gates.
 *
 * Defaults to `{harness}/status.json` resolved from the session cwd
 * (`resolveHarnessDir(pi.cwd)`); pass `path` to target another file.
 * Classification follows the Gate 1 layout rules (fix-wave W-C, parity
 * with `harnessDocKindOfTarget` in ../hooks/pre/mstar-gates.ts and
 * packages/opencode/src/mstar.ts): a document is only validated when its
 * harness-relative location is canonical — `status.json` at the harness
 * root, `snapshot.json` under `workflows/<id>/`, `residuals.json` under
 * `projects/<id>/`. Anything else is an explicit error, never a basename-
 * only validator dispatch (a stray `/tmp/evil/snapshot.json` must not run
 * the snapshot validator).
 *
 * The snapshot/register validators are P1-only engine exports absent from
 * the published floor `^2.0.2` — they come from a DYNAMIC engine import so
 * a stale engine yields an explicit upgrade error instead of a
 * module-link failure that silently drops the tool (qc3 F-001 /
 * fix-wave W-B). No local rule logic — the engine is the single validator;
 * this module only locates the file and formats output.
 */
import { statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readJson, resolveHarnessDir, validateStatus } from "@mstar-harness/engine";
import type { ValidationResult } from "@mstar-harness/engine";
import type { AgentToolResult, CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent";

const STATUS_FILE = "status.json";
const SNAPSHOT_FILE = "snapshot.json";
const REGISTER_FILE = "residuals.json";

type DocKind = "status" | "snapshot" | "register";

type Params = { path?: string };

function violationLines(violations: readonly ValidationResult[]): string {
  return violations
    .map((v) => `[${v.severity}] ${v.code}: ${v.message}${v.fix ? ` (fix: ${v.fix})` : ""}`)
    .join("\n");
}

function result(text: string, details: unknown, isError: boolean): AgentToolResult {
  const out: AgentToolResult = { content: [{ type: "text", text }], details };
  if (isError) out.isError = true;
  return out;
}

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
 * Default-layout fast path: the `workflows/` + `projects/` names (fix-wave
 * W-REV-1). Phase-5 F1: with the lazily-loaded engine dir resolvers, a
 * `.mstarc` custom `workflow_dir` / `project_dir` layout is recognized via
 * the resolved absolute dirs (stale engine -> resolvers null -> default
 * names only). Never throws — a missing/unreadable path is not a marker.
 */
function hasHarnessRootMarkers(dir: string): boolean {
  if (!hasEntry(dir, STATUS_FILE)) return false;
  if (hasEntry(dir, "workflows") && hasEntry(dir, "projects")) return true;
  const resolvers = classifyDirResolvers;
  if (resolvers === null) return false;
  try {
    return (
      hasEntry(resolvers.resolveWorkflowDir(dir, { harnessDir: dir }), "") &&
      hasEntry(resolvers.resolveProjectDir(dir, { harnessDir: dir }), "")
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the harness root containing `startDir` by marker probe (fix-wave
 * W-REV-1): the nearest ancestor holding the v2 coordination-document
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
 * document (Gate 1 layout parity, fix-wave W-C / W-REV-1, Phase-5 F1):
 * basename is `status.json` at the harness root, `snapshot.json` under
 * `{WORKFLOW_DIR}/<id>/`, or `residuals.json` under `{PROJECT_DIR}/<id>/`
 * (harness-relative, one path component each), AND the harness root
 * resolves — marker probe first, `resolveHarnessDir` as the declared-root
 * fallback. The snapshot/register rel is computed against the RESOLVED
 * layout dirs (`.mstarc` `workflow_dir`/`project_dir` honored, defaults
 * `workflows`/`projects`), so a custom layout classifies at the same
 * location the runtime writes; on a stale engine (no dir resolvers) the
 * default names apply. Returns the harness dir + doc kind when canonical,
 * `null` otherwise.
 */
function harnessDocKindOfTarget(targetPath: string): { harnessDir: string; kind: DocKind } | null {
  const resolved = resolve(targetPath);
  const name = basename(resolved);
  if (name !== STATUS_FILE && name !== SNAPSHOT_FILE && name !== REGISTER_FILE) return null;
  const classify = (harnessDir: string): { harnessDir: string; kind: DocKind } | null => {
    const rel = relative(harnessDir, resolved);
    if (name === STATUS_FILE && rel === STATUS_FILE) return { harnessDir, kind: "status" };
    let workflowDir: string;
    let projectDir: string;
    const resolvers = classifyDirResolvers;
    if (resolvers !== null) {
      try {
        workflowDir = resolvers.resolveWorkflowDir(harnessDir, { harnessDir });
        projectDir = resolvers.resolveProjectDir(harnessDir, { harnessDir });
      } catch {
        workflowDir = join(harnessDir, "workflows");
        projectDir = join(harnessDir, "projects");
      }
    } else {
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

/** Dynamic engine import guard for the P1-only snapshot/register validators
 * (qc3 F-001 / fix-wave W-B): missing → explicit upgrade error. */
async function loadNewValidators(): Promise<
  | { ok: true; validateWorkflowSnapshot: (doc: unknown) => { ok: boolean; violations: ValidationResult[] }; validateProjectRegister: (doc: unknown) => { ok: boolean; violations: ValidationResult[] } }
  | { ok: false; error: AgentToolResult }
> {
  // Dynamic import (fix-wave W-B): static named imports of these exports
  // would fail at module link on published engines (^2.0.2 floor) and
  // silently drop the tool from /extensions.
  const engine = await import("@mstar-harness/engine");
  if (typeof engine.validateWorkflowSnapshot !== "function" || typeof engine.validateProjectRegister !== "function") {
    return {
      ok: false,
      error: result(
        "installed @mstar-harness/engine lacks validateWorkflowSnapshot/validateProjectRegister — upgrade the engine (next release); CLI fallback: mstar status validate",
        { ok: false },
        true,
      ),
    };
  }
  return { ok: true, validateWorkflowSnapshot: engine.validateWorkflowSnapshot, validateProjectRegister: engine.validateProjectRegister };
}

/** The P1-only v3 layout-dir resolvers (custom `.mstarc` `workflow_dir` /
 * `project_dir` support, Phase-5 F1) — same stale-engine rationale as the
 * validators above: dynamic import, `null` on missing exports / import
 * failure (classification falls back to the DEFAULT layout names). */
type DirResolvers = {
  resolveWorkflowDir: (startDir: string, opts?: { harnessDir?: string }) => string;
  resolveProjectDir: (startDir: string, opts?: { harnessDir?: string }) => string;
};

let cachedDirResolvers: Promise<DirResolvers | null> | null = null;

async function loadDirResolvers(): Promise<DirResolvers | null> {
  cachedDirResolvers ??= import("@mstar-harness/engine")
    .then((mod) =>
      typeof mod.resolveWorkflowDir === "function" && typeof mod.resolveProjectDir === "function"
        ? { resolveWorkflowDir: mod.resolveWorkflowDir, resolveProjectDir: mod.resolveProjectDir }
        : null,
    )
    .catch(() => null);
  return cachedDirResolvers;
}

/** Test seam (smoke scripts): replace `load` to simulate an engine build
 * without the P1 dir resolvers (null — default-layout classification). */
export const dirResolversLoader: { load: () => Promise<DirResolvers | null> } = {
  load: loadDirResolvers,
};

/** Sync slot for the loaded resolvers; `execute` awaits the loader before
 * classifying, so the slot is populated on that path. */
let classifyDirResolvers: DirResolvers | null = null;

export default function mstarStatusValidate(pi: CustomToolAPI): CustomTool {
  return {
    name: "mstar_status_validate",
    label: "Validate harness status.json / workflow snapshot / project register",
    description:
      "Validate a Morning Star harness v2 coordination document: the root status.json (version 2 + workflows[] with per-entry snapshot invariants) via the engine validateStatus gate, a workflow snapshot (schema_version 1 + plan rows + lease shapes) via validateWorkflowSnapshot, or a project register (entries keyed by plan id) via validateProjectRegister. " +
      "The target must be a canonical harness location: {HARNESS_DIR}/status.json, {HARNESS_DIR}/workflows/<id>/snapshot.json, or {HARNESS_DIR}/projects/<id>/residuals.json (Gate 1 layout parity — non-canonical paths are rejected). " +
      "Defaults to {HARNESS_DIR}/status.json discovered from the session cwd; pass `path` to check another file. " +
      "Use after editing status.json / workflows/<id>/snapshot.json / projects/<id>/residuals.json, before writable dispatch, or when workflow/plan state edits are reviewed. " +
      "Returns one line per violation as [severity] code: message (fix: …).",
    parameters: pi.zod.object({ path: pi.zod.string().optional() }).optional(),
    async execute(_toolCallId: string, params: Params, _onUpdate, _ctx, _signal): Promise<AgentToolResult> {
      try {
        let statusPath: string;
        let kind: DocKind;
        if (params?.path) {
          statusPath = resolve(pi.cwd, params.path);
          // Phase-5 F1: ensure the custom-layout dir resolvers are loaded
          // before classifying (stale engine -> null -> default names).
          classifyDirResolvers = await dirResolversLoader.load();
          const target = harnessDocKindOfTarget(statusPath);
          if (target === null) {
            return result(
              `mstar_status_validate: ${statusPath} is not a canonical harness coordination document — expected {HARNESS_DIR}/status.json, {HARNESS_DIR}/workflows/<id>/snapshot.json, or {HARNESS_DIR}/projects/<id>/residuals.json`,
              { path: statusPath, ok: false },
              true,
            );
          }
          kind = target.kind;
        } else {
          const harnessDir = resolveHarnessDir(pi.cwd);
          if (harnessDir === null) {
            return result(
              `no harness directory found from "${pi.cwd}" (looked for .mstar/ / .agents/ / .plans/ / plans/ walking up) — pass an explicit path`,
              { cwd: pi.cwd },
              true,
            );
          }
          statusPath = join(harnessDir, STATUS_FILE);
          kind = "status";
        }

        let gate: { ok: boolean; violations: ValidationResult[] };
        if (kind === "status") {
          gate = validateStatus(statusPath);
        } else {
          const validators = await loadNewValidators();
          if (!validators.ok) return validators.error;
          let doc: unknown;
          try {
            doc = readJson(statusPath);
          } catch (error) {
            return result(`mstar_status_validate failed: ${(error as Error).message}`, { path: statusPath }, true);
          }
          gate =
            kind === "snapshot" ? validators.validateWorkflowSnapshot(doc) : validators.validateProjectRegister(doc);
        }
        // Row/workflow counts only when the gate passed: the validators
        // already proved the file parses, so the re-read cannot throw.
        let planCount: number | null = null;
        let workflowCount: number | null = null;
        let entryCount: number | null = null;
        if (gate.ok) {
          const doc = readJson(statusPath) as { plans?: unknown; workflows?: unknown; entries?: unknown };
          if (kind === "snapshot") {
            planCount = Array.isArray(doc.plans) ? doc.plans.length : 0;
          } else if (kind === "register") {
            entryCount = doc.entries !== null && typeof doc.entries === "object" && !Array.isArray(doc.entries)
              ? Object.keys(doc.entries).length
              : 0;
          } else {
            workflowCount = Array.isArray(doc.workflows) ? doc.workflows.length : 0;
          }
        }
        const label = kind === "snapshot" ? "snapshot" : kind === "register" ? "register" : "status.json";
        return result(
          gate.ok
            ? `${label} valid${planCount !== null ? ` (${planCount} plans)` : ""}${workflowCount !== null ? ` (${workflowCount} active workflows)` : ""}${entryCount !== null ? ` (${entryCount} plans with entries)` : ""}`
            : violationLines(gate.violations),
          { path: statusPath, kind, plan_count: planCount, workflow_count: workflowCount, entry_count: entryCount, ok: gate.ok, violations: gate.violations },
          !gate.ok,
        );
      } catch (error) {
        return result(`mstar_status_validate failed: ${(error as Error).message}`, {}, true);
      }
    },
  };
}
