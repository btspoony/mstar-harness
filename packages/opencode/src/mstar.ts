/**
 * MorningStarHarness plugin for OpenCode.
 *
 * - Injects one-time harness bootstrap into first user message.
 * - Registers skill paths only inside this package: `harness-skills/` (synced by `bundle-assets` at build time; includes `mstar-host`).
 * - Loads agents from `harness-agents/` only (same sync). Does not use `process.cwd()` so OpenCode project cwd does not matter.
 * - Loads custom commands from `harness-commands/` only (same sync).
 * - Dual-mode harness coordination-document write lint (roadmap §8.5
 *   `beforeStatusWrite`, v3 hard cutover): on structured file-write tools
 *   targeting the v2 root `{HARNESS_DIR}/status.json`, workflow snapshots
 *   (`{HARNESS_DIR}/workflows/<id>/snapshot.json`) or project registers
 *   (`{HARNESS_DIR}/projects/<id>/residuals.json`), runs the matching
 *   engine validator (`status.validateStatus` /
 *   `workflow.validateWorkflowSnapshot` / `project.validateProjectRegister`).
 *   Default (no `Enforcement: hard`):
 *   `warn` lines on violations, never blocks. Hard mode (repo iteration
 *   compass frontmatter `enforcement: hard`, engine
 *   `status.resolveCompassEnforcement`): error-level lines with a skill-text
 *   pointer + a GateResult carrying `hardBlocked: true` (a refusal-capable
 *   caller MUST refuse the write — this hook itself cannot abort the tool).
 *   Never throws raw exceptions in either mode — OpenCode's plugin API
 *   (`@opencode-ai/plugin` 1.4.8) `tool.execute.before` returns
 *   `Promise<void>` with no refusal channel, so hard mode is surfaced as the
 *   error logs + structured result (see `validateStatusWrite`).
 *   Engine-version compat (qc3 F-001 / fix-wave W-B): the snapshot/register
 *   validators (`validateWorkflowSnapshot` / `validateProjectRegister`) are
 *   P1-only exports absent from the published engine floor `^2.0.2` — they
 *   are lazy-loaded (`newValidatorsLoader`); on a stale engine those write
 *   lints are skipped with a one-time warning while the root status.json
 *   lint keeps working, and the plugin module itself always links.
 *   Hook coverage resolves the harness root from the target itself
 *   (fix-wave W-REV-1): the marker probe (`status.json` + `workflows/` +
 *   `projects/` ancestor, correct for the default `.mstar` layout whose
 *   nested `plans/` rung used to shadow the root), falling back to
 *   `resolveHarnessDir` — a repo `.mstarc` `[config] harness_dir`, else
 *   probing (`.mstar/` → `.agents/` → `.plans/`|`plans/`); repos with a
 *   non-probed harness root MUST set `MSTAR_HARNESS_DIR` in the OpenCode
 *   server env or declare `.mstarc` — see package README
 *   "Status write lint (hook coverage)" (qc2 F-006).
 * - Dual-mode `beforeDispatch` dispatch lint (roadmap §8.5): on `task`-tool
 *   executions (subagent dispatch), validates the Assignment header — field
 *   presence (`Execute as` / `Delegation` / `Task category`, backward-compat
 *   `assignment.presence.*` codes), full field validation from the engine
 *   (`dispatch.validateAssignmentFields`: exactly-one Working-branch form,
 *   create-form `<base>`, Branch policy reason), the default-branch gate
 *   (`dispatch.assertDefaultBranchProtected` with the CLI ea010f1
 *   direct-on-exception wiring) and the anti-recursion binding check. The
 *   Assignment's OWN `Enforcement: hard` flag (bold or plain) switches the
 *   hook to hard mode: error-level lines + a GateResult carrying
 *   `hardBlocked: true`; flag absent (or `Enforcement: soft`) stays warn-only.
 *   Never throws raw exceptions in either mode (refusal-channel limitation as
 *   above — see `validateDispatchAssignment`).
 */
import type { Plugin } from "@opencode-ai/plugin";
import {
  applyEnforcement,
  composeDispatchGate,
  isReadOnlyAssignmentRole,
  parseAssignmentFields,
  readJson,
  resolveHarnessDir,
  resolveRepoEnforcement,
  validateStatus,
} from "@mstar-harness/engine";
import type { EnforcementFlag, GateResult, StatusV2Doc } from "@mstar-harness/engine";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonPrimitive = string | number | boolean | null;
type JsonObject = Record<string, unknown>;
type FrontmatterAndBody = {
  frontmatter: string;
  body: string;
};
type MessagePart = { type: string; text?: string };
type ChatMessage = { info: { role: string }; parts: MessagePart[] };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Published layout: `dist/mstar.js` (or `src/mstar.ts`) -> package root is one level up. */
const packageRoot = path.resolve(__dirname, "..");

const bundledSkillsDir = path.join(packageRoot, "harness-skills");
const bundledAgentsDir = path.join(packageRoot, "harness-agents");
const bundledCommandsDir = path.join(packageRoot, "harness-commands");
const bootstrapAgentsPath = path.join(packageRoot, "AGENTS.md");
const BOOTSTRAP_MARKER = "IMPORTANT_FOR_HARNESS";

function resolveSkillPathCandidates(): string[] {
  if (fs.existsSync(bundledSkillsDir)) return [bundledSkillsDir];
  return [];
}

const extractFrontmatterAndBody = (content: string): FrontmatterAndBody => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: content };
  return { frontmatter: match[1], body: match[2] };
};

const parseScalar = (raw: string): JsonPrimitive => {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "allow" || value === "ask" || value === "deny") return value;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^["']|["']$/g, "");
};

const parseSimpleFrontmatter = (frontmatter: string): JsonObject => {
  const root: JsonObject = {};
  const stack: Array<{ indent: number; target: JsonObject }> = [{ indent: -1, target: root }];
  const lines = frontmatter.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const indent = line.match(/^ */)?.[0]?.length ?? 0;
    const trimmed = line.trim();
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].target;

    if (rawValue === "" || rawValue === "{}") {
      current[key] = {};
      stack.push({ indent, target: current[key] as JsonObject });
      continue;
    }

    if (rawValue === "|-" || rawValue === "|") {
      const blockLines = [];
      const baseIndent = indent;
      for (let j = i + 1; j < lines.length; j += 1) {
        const blockLine = lines[j];
        const blockIndent = blockLine.match(/^ */)?.[0]?.length ?? 0;
        if (blockLine.trim() && blockIndent <= baseIndent) break;
        const normalized = blockLine.startsWith(" ".repeat(baseIndent + 2))
          ? blockLine.slice(baseIndent + 2)
          : blockLine.trim() ? blockLine.trim() : "";
        blockLines.push(normalized);
        i = j;
      }
      current[key] = blockLines.join("\n");
      continue;
    }

    current[key] = parseScalar(rawValue);
  }

  return root;
};

const loadBootstrapContent = (): string | null => {
  if (!fs.existsSync(bootstrapAgentsPath)) return null;
  const content = fs.readFileSync(bootstrapAgentsPath, "utf8").trim();
  if (!content) return null;
  return `<${BOOTSTRAP_MARKER}>
${content}
</${BOOTSTRAP_MARKER}>`;
};

const normalizePath = (inputPath: string | undefined, homeDir: string): string | null => {
  if (!inputPath || typeof inputPath !== "string") return null;
  let normalized = inputPath.trim();
  if (!normalized) return null;
  if (normalized === "~") normalized = homeDir;
  if (normalized.startsWith("~/")) normalized = path.join(homeDir, normalized.slice(2));
  return path.resolve(normalized);
};

const loadAgentsFromDir = (agentsDirPath: string): Record<string, JsonObject> => {
  if (!fs.existsSync(agentsDirPath)) return {};

  const files = fs
    .readdirSync(agentsDirPath)
    .filter((name: string) => name.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));

  const result: Record<string, JsonObject> = {};
  for (const file of files) {
    const filePath = path.join(agentsDirPath, file);
    const content = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = extractFrontmatterAndBody(content);
    const parsed = parseSimpleFrontmatter(frontmatter);
    const parsedName = typeof parsed.name === "string" ? parsed.name : "";
    const id = parsedName || file.replace(/\.md$/, "");

    result[id] = {
      ...parsed,
      prompt: body.trim(),
    };
  }

  return result;
};

const loadBundledAgents = (): Record<string, JsonObject> => loadAgentsFromDir(bundledAgentsDir);

const loadBundledCommands = (): Record<string, JsonObject> => {
  if (!fs.existsSync(bundledCommandsDir)) return {};

  const files = fs
    .readdirSync(bundledCommandsDir)
    .filter((name: string) => /\.(?:md|mdc|markdown|txt)$/.test(name))
    .sort((a, b) => a.localeCompare(b));

  const result: Record<string, JsonObject> = {};
  for (const file of files) {
    const filePath = path.join(bundledCommandsDir, file);
    const content = fs.readFileSync(filePath, "utf8");
    const { frontmatter, body } = extractFrontmatterAndBody(content);
    const parsed = parseSimpleFrontmatter(frontmatter);
    const parsedName = typeof parsed.name === "string" ? parsed.name : file.replace(/\.(?:md|mdc|markdown|txt)$/, "");

    const commandDef: JsonObject = {
      template: body.trim(),
    };
    if (typeof parsed.description === "string") {
      commandDef.description = parsed.description;
    }
    if (typeof parsed.agent === "string") {
      commandDef.agent = parsed.agent;
    }
    if (typeof parsed.model === "string") {
      commandDef.model = parsed.model;
    }

    result[parsedName] = commandDef;
  }

  return result;
};

/**
 * Plugin log channel (roadmap §8.5 `HostAdapter.log`). v1 routes to the
 * console — OpenCode captures plugin stdout/stderr into its server log.
 */
export type StatusLogger = (level: "info" | "warn" | "error", message: string) => void;

const defaultStatusLogger: StatusLogger = (level, message) => {
  const line = `[mstar-harness] ${message}`;
  if (level === "warn") console.warn(line);
  else if (level === "error") console.error(line);
  else console.log(line);
};

const STATUS_FILE = "status.json";
const SNAPSHOT_FILE = "snapshot.json";
const REGISTER_FILE = "residuals.json";

/**
 * Engine-version compat (qc3 F-001 / fix-wave W-B): `validateWorkflowSnapshot`
 * and `validateProjectRegister` postdate the published engine floor
 * (`^2.0.2` lacks them) — a static named import would fail at module link
 * on older engines and drop the whole plugin. They are loaded LAZILY
 * (module-level cached dynamic import, same pattern as the omp hook's
 * `newValidatorsLoader`). When either export is missing, snapshot/register
 * writes are skipped (warn once, `null` result) while the root
 * `status.json` lint (static `validateStatus`) keeps working.
 */
type NewValidators = {
  validateWorkflowSnapshot: (doc: unknown) => GateResult;
  validateProjectRegister: (doc: unknown) => GateResult;
};

type NewValidatorsLoad =
  | { status: "ok"; validators: NewValidators }
  | { status: "missing" }
  | { status: "error"; error: unknown };

let cachedNewValidators: Promise<NewValidatorsLoad> | null = null;

export function loadNewValidators(): Promise<NewValidatorsLoad> {
  cachedNewValidators ??= import("@mstar-harness/engine")
    .then((mod) =>
      typeof mod.validateWorkflowSnapshot === "function" && typeof mod.validateProjectRegister === "function"
        ? ({
            status: "ok",
            validators: {
              validateWorkflowSnapshot: mod.validateWorkflowSnapshot,
              validateProjectRegister: mod.validateProjectRegister,
            },
          } as const)
        : ({ status: "missing" } as const),
    )
    .catch((error: unknown) => ({ status: "error", error } as const));
  return cachedNewValidators;
}

/** Test seam (smoke scripts): replace `load` to simulate an engine build
 * without the P1 validators (missing) or a broken engine import (error). */
export const newValidatorsLoader: { load: () => Promise<NewValidatorsLoad> } = {
  load: loadNewValidators,
};

/**
 * The P1-only v3 layout-dir resolvers (custom `.mstarc` `workflow_dir` /
 * `project_dir` support, Phase-5 F1). Same stale-engine rationale as
 * `newValidatorsLoader`: the exports postdate the published engine floor
 * (`^2.0.2` lacks them) — a static named import would fail at module link
 * on older engines and drop the WHOLE plugin, so they are loaded lazily
 * and cached. `null` (missing exports / import failure) means the
 * classification falls back to the DEFAULT layout names (the pre-F1
 * behavior) — a stale engine keeps working, only custom layouts stay
 * unclassified.
 */
type DirResolvers = {
  resolveWorkflowDir: (startDir: string, opts?: { harnessDir?: string }) => string;
  resolveProjectDir: (startDir: string, opts?: { harnessDir?: string }) => string;
};

let cachedDirResolvers: Promise<DirResolvers | null> | null = null;

export function loadDirResolvers(): Promise<DirResolvers | null> {
  cachedDirResolvers ??= import("@mstar-harness/engine")
    .then((mod) =>
      typeof mod.resolveWorkflowDir === "function" && typeof mod.resolveProjectDir === "function"
        ? { resolveWorkflowDir: mod.resolveWorkflowDir, resolveProjectDir: mod.resolveProjectDir }
        : null,
    )
    .catch(() => null);
  return cachedDirResolvers;
}

/** Test seam: replace `load` to simulate an engine build without the P1
 * dir resolvers (null — default-layout classification). */
export const dirResolversLoader: { load: () => Promise<DirResolvers | null> } = {
  load: loadDirResolvers,
};

/** Sync slot for the loaded resolvers; `validateStatusWrite` awaits the
 * loader before classifying, so the slot is populated on that path. */
let classifyDirResolvers: DirResolvers | null = null;

/** One-time degradation warnings (module-level flags; degrade path must
 * never throw — optional chaining + local try/catch). */
let newValidatorsWarned = false;
let newValidatorsImportErrorWarned = false;

function warnNewValidatorsDegraded(log: StatusLogger, reason: "missing" | "error", error?: unknown): void {
  if (reason === "missing") {
    if (newValidatorsWarned) return;
    newValidatorsWarned = true;
  } else {
    if (newValidatorsImportErrorWarned) return;
    newValidatorsImportErrorWarned = true;
  }
  const message =
    reason === "missing"
      ? "mstar: installed engine lacks validateWorkflowSnapshot/validateProjectRegister — snapshot/register write lint skipped; status.json lint unaffected; upgrade the engine (next release)"
      : `mstar: snapshot/register write lint skipped: engine import failed — ${error instanceof Error ? error.message : String(error)}; status.json lint unaffected`;
  try {
    log("warn", message);
  } catch {
    // degrade path must never throw
  }
}

/** Gated harness coordination documents in v3 (compass ruling 7 — hard
 * cutover): the root `status.json` (v2), workflow snapshots and project
 * registers. Each kind maps to its engine validator. */
type HarnessDocKind = "status" | "snapshot" | "register";

/** Directory/entry check (never throws — a missing or unreadable path is
 * simply not a marker). */
function hasEntry(dir: string, name: string): boolean {
  try {
    fs.statSync(path.join(dir, name));
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
  let dir = path.resolve(target);
  for (;;) {
    if (hasHarnessRootMarkers(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Classify `targetPath` as a canonical `{HARNESS_DIR}` coordination
 * document: basename is `status.json` at the harness root, `snapshot.json`
 * under `{WORKFLOW_DIR}/<id>/`, or `residuals.json` under
 * `{PROJECT_DIR}/<id>/` (harness-relative, one path component each), AND
 * the harness root resolves — marker probe first (fix-wave W-REV-1,
 * custom-layout-aware Phase-5 F1), `resolveHarnessDir` as the declared-root
 * fallback. The snapshot/register rel is computed against the RESOLVED
 * layout dirs (`.mstarc` `workflow_dir`/`project_dir` honored, defaults
 * `workflows`/`projects`), so a custom layout classifies at the same
 * location the runtime writes; on a stale engine (no dir resolvers) the
 * default names apply. Returns the harness dir + doc kind when gated,
 * `null` otherwise.
 */
function harnessDocKindOfTarget(targetPath: string): { harnessDir: string; kind: HarnessDocKind } | null {
  const resolved = path.resolve(targetPath);
  const name = path.basename(resolved);
  if (name !== STATUS_FILE && name !== SNAPSHOT_FILE && name !== REGISTER_FILE) return null;
  const classify = (harnessDir: string): { harnessDir: string; kind: HarnessDocKind } | null => {
    const rel = path.relative(harnessDir, resolved);
    if (name === STATUS_FILE && rel === STATUS_FILE) return { harnessDir, kind: "status" };
    let workflowDir: string;
    let projectDir: string;
    const resolvers = classifyDirResolvers;
    if (resolvers !== null) {
      try {
        workflowDir = resolvers.resolveWorkflowDir(harnessDir, { harnessDir });
        projectDir = resolvers.resolveProjectDir(harnessDir, { harnessDir });
      } catch {
        workflowDir = path.join(harnessDir, "workflows");
        projectDir = path.join(harnessDir, "projects");
      }
    } else {
      workflowDir = path.join(harnessDir, "workflows");
      projectDir = path.join(harnessDir, "projects");
    }
    if (name === SNAPSHOT_FILE && /^[^/]+\/snapshot\.json$/.test(path.relative(workflowDir, resolved))) {
      return { harnessDir, kind: "snapshot" };
    }
    if (name === REGISTER_FILE && /^[^/]+\/residuals\.json$/.test(path.relative(projectDir, resolved))) {
      return { harnessDir, kind: "register" };
    }
    return null;
  };
  const probeRoot = resolveHarnessRootOf(path.dirname(resolved));
  const harnessDir = probeRoot ?? resolveHarnessDir(path.dirname(resolved));
  if (!harnessDir) return null;
  const classified = classify(harnessDir);
  if (classified !== null) return classified;
  // W-REV-3: probe root hit but rel non-canonical — pathological double
  // harness (a nested sparse harness below a full-marker ancestor). Rebuild
  // rel against the declared-root resolution before giving up.
  if (probeRoot === null) return null;
  const fallbackDir = resolveHarnessDir(path.dirname(resolved));
  if (fallbackDir === null || fallbackDir === probeRoot) return null;
  return classify(fallbackDir);
}

/**
 * `status.json` / workflow snapshot / project register write lint (roadmap
 * §8.5 `beforeStatusWrite`, v3 hard cutover).
 *
 * Given the target path of a file write, resolves `{HARNESS_DIR}` from the
 * target (marker probe first — fix-wave W-REV-1 — with the engine
 * `path.resolveHarnessDir` declared-root fallback) and runs
 * the matching engine validator on the document about to be written
 * (`opts.doc`) or on the current file: `status.validateStatus` for the v2
 * root, `workflow.validateWorkflowSnapshot` for
 * `workflows/<id>/snapshot.json`, `project.validateProjectRegister` for
 * `projects/<id>/residuals.json` (the v1 root `residual_findings` surface
 * is gone — the residual write gate moved to the register path).
 *
 * Enforcement (roadmap §8.5 C4/D2, Slice 5):
 * - **Warn mode (default)** — flag absent: violations are surfaced as `warn`
 *   through the plugin log channel; `hardBlocked` is false.
 * - **Hard mode** — the write context carries `Enforcement: hard` via
 *   `opts.enforcement`, or (when omitted) the repo's iteration compass
 *   frontmatter declares `enforcement: hard` (engine
 *   `status.resolveCompassEnforcement`): violations are surfaced as `error`
 *   lines with a skill-text pointer and the returned GateResult carries
 *   `hardBlocked: true` — a refusal-capable caller MUST refuse the write
 *   (this hook itself cannot abort the tool; see the blocking-channel note).
 *   Never throws a raw exception: hard mode is the structured result +
 *   error log channel.
 *
 * Blocking channel note (documented behavior): OpenCode's plugin API
 * (`@opencode-ai/plugin` 1.4.8) `tool.execute.before` returns `Promise<void>`
 * — there is no error/refusal return channel on this host. The plugin
 * therefore surfaces hard mode as error-level log lines (captured into the
 * OpenCode server log) + the structured `hardBlocked` result; host bindings
 * with a refusal channel (pi/dsh when their APIs land) must refuse the write
 * when `hardBlocked === true`.
 *
 * Returns the engine gate result when the target is a canonical harness
 * coordination document and something could be validated; `null` otherwise
 * (not a harness write, file does not exist yet, or validation aborted).
 */
export async function validateStatusWrite(
  targetPath: string,
  opts: { doc?: unknown; log?: StatusLogger; enforcement?: EnforcementFlag } = {},
): Promise<GateResult | null> {
  const log = opts.log ?? defaultStatusLogger;
  try {
    // Host tool args are `any` — refuse non-string paths before path.resolve
    // (Bun: `The "paths[0]" property must be of type string, got object`).
    if (typeof targetPath !== "string" || targetPath.trim() === "") return null;

    const resolved = path.resolve(targetPath);
    // Phase-5 F1: ensure the custom-layout dir resolvers are loaded before
    // classifying — the sync slot feeds `harnessDocKindOfTarget` (stale
    // engine -> null -> default-layout names, the pre-F1 behavior).
    classifyDirResolvers = await dirResolversLoader.load();
    const target = harnessDocKindOfTarget(resolved);
    if (!target) return null;

    let result: GateResult | null;
    if (opts.doc !== undefined) {
      if (target.kind === "status") {
        result = validateDocByKind(opts.doc, target.kind, null);
      } else {
        // Snapshot/register validators are P1-only engine exports — lazy
        // load; a stale engine skips this write with a one-time warning
        // (never a module-link crash, never a throw).
        const load = await newValidatorsLoader.load();
        if (load.status !== "ok") {
          warnNewValidatorsDegraded(log, load.status, load.status === "error" ? load.error : undefined);
          return null;
        }
        result = validateDocByKind(opts.doc, target.kind, load.validators);
      }
    } else if (!fs.existsSync(resolved)) {
      result = null;
    } else if (target.kind === "status") {
      // The path form handles unparseable files itself (invalid-json result).
      result = validateStatus(resolved);
    } else {
      // Snapshot/register validators take a doc — mirror the engine's
      // unparseable-file violation instead of degrading to an abort.
      const load = await newValidatorsLoader.load();
      if (load.status !== "ok") {
        warnNewValidatorsDegraded(log, load.status, load.status === "error" ? load.error : undefined);
        return null;
      }
      try {
        result = validateDocByKind(readJson(resolved), target.kind, load.validators);
      } catch (error) {
        result = {
          ok: false,
          violations: [
            { ok: false, severity: "high", code: "status.invalid-json", message: (error as Error).message },
          ],
        };
      }
    }
    if (!result) return null;

    const enforcement: EnforcementFlag = opts.enforcement ?? resolveRepoEnforcement(target.harnessDir);
    if (!result.ok) {
      for (const violation of result.violations) {
        const fix = violation.fix ? ` (fix: ${violation.fix})` : "";
        if (enforcement.hard) {
          log(
            "error",
            `${path.basename(resolved)} validation (hard gate): [${violation.severity}] ${violation.code}: ${violation.message}${fix} — hardBlocked per Enforcement: hard; refusal requires a host refusal channel (skill: mstar-artifacts/references/status-and-residuals.md)`,
          );
        } else {
          log(
            "warn",
            `${path.basename(resolved)} validation: [${violation.severity}] ${violation.code}: ${violation.message}${fix}`,
          );
        }
      }
    }
    return applyEnforcement(result, { hard: enforcement.hard });
  } catch (error) {
    // Never throw, never block unexpectedly: unexpected errors degrade to a
    // single `error` log and a `null` return in BOTH modes (hard gates are
    // opt-in — an engine failure must not harden a workflow that was soft).
    log("error", `status.json validation aborted: ${(error as Error).message}`);
    return null;
  }
}

/** Run the validator matching the gated doc kind (v3 hard cutover). The
 * snapshot/register validators are P1-only engine exports — callers pass
 * the lazily-loaded set; `null` (stale engine) can never be reached for
 * those kinds because `validateStatusWrite` skips them first. */
function validateDocByKind(doc: unknown, kind: HarnessDocKind, newValidators: NewValidators | null): GateResult {
  if (kind === "snapshot") return newValidators!.validateWorkflowSnapshot(doc);
  if (kind === "register") return newValidators!.validateProjectRegister(doc);
  return validateStatus(doc as StatusV2Doc);
}

/**
 * Dispatch-side Assignment validation (roadmap §8.5 `beforeDispatch`).
 *
 * Delegates the entire composition to the engine's single shared
 * `dispatch.composeDispatchGate` (qc1 F-001/F-006 — no local composition
 * left in the host adapter):
 * (1) Shape guard — `## Assignment` heading or a core field line
 * (`Execute as` / `Delegation` / `Task category`); non-Assignment prompts
 * stay silent (no false positives).
 * (2) `validateAssignmentFields` — required fields, exactly-one
 * Working-branch form, create-form `<base>`, Branch policy reason; the
 * legacy `assignment.presence.*` codes are engine ALIASES on the three
 * core-field violations (single parser — no local presence parser, qc1
 * F-002). Read-only roles (scout/explore) pass `writable: false` so no
 * spurious `branch-missing` fires (qc3 F-1 / qc2 S-5).
 * (3) Anti-recursion NEVER red line — CALLER-scoped (issue #156): the
 * engine precheck compares the DISPATCHING agent's own role against
 * `Execute as`, and OpenCode's `tool.execute.before` event cannot report
 * the dispatching agent's identity, so this host SKIPS the leg (the
 * pre-#156 wiring compared the spawn-TARGET `args.subagent` /
 * `args.subagent_type` against `Execute as` — equality is the documented
 * compliant pattern, so every correct dispatch self-flagged). The red
 * line stays prompt-level here (mstar-dispatch-gates).
 * (4) The default-branch gate — the checked branch comes from the
 * Assignment's own branch forms (create-form name / Working branch /
 * Branch policy branch), else `$MSTAR_WORKING_BRANCH`; a well-formed
 * `Branch policy: direct on <branch> — <reason>` exception is honored only
 * when its branch is the one being checked. Skipped entirely for read-only
 * roles (no writable work on a branch).
 *
 * Enforcement (roadmap §8.5 C4/D2, Slice 5) — the Assignment's OWN header
 * flag (engine `dispatch.parseEnforcementFlag` via `composeDispatchGate`)
 * or the repo-level setting (`.mstarc` → compass, engine
 * `status.resolveRepoEnforcement` — dsh `resolveDispatchHard` and the
 * omp/status-write gates parity) decides:
 * - **Warn mode (default)** — no `Enforcement: hard` on the Assignment: one
 *   `warn` line per violation through the `[mstar-harness]` channel;
 *   `hardBlocked` is false. Unchanged v1 behavior.
 * - **Hard mode** — the Assignment header carries `Enforcement: hard`
 *   (bold or plain): one `error` line per violation with a skill-text
 *   pointer and the returned GateResult carries `hardBlocked: true` — a
 *   refusal-capable caller MUST refuse the dispatch (this hook itself
 *   cannot abort the tool; see the blocking-channel note). Never throws a
 *   raw exception: hard mode is the structured result + error log channel.
 *   `Enforcement: soft` (explicit non-hard) stays warn-only; rollback =
 *   unset the flag. The flag is read from the Assignment HEADER region
 *   only — an example `**Enforcement**: hard` line in the task body does
 *   not harden (qc1 F-003 / qc2 F-003).
 *
 * Blocking channel note (documented behavior): OpenCode's plugin API
 * (`@opencode-ai/plugin` 1.4.8) `tool.execute.before` returns `Promise<void>`
 * — no error/refusal return channel on this host. The plugin therefore
 * surfaces hard mode as error-level log lines (captured into the OpenCode
 * server log) + the structured `hardBlocked` result; host bindings with a
 * refusal channel (pi/dsh when their APIs land) must refuse the dispatch
 * when `hardBlocked === true`.
 *
 * Returns the gate result for Assignment-shaped text, an ok result for
 * text that is not an Assignment, and `null` only when the check aborted.
 */
export function validateDispatchAssignment(
  assignmentText: string,
  opts: { log?: StatusLogger } = {},
): GateResult | null {
  const log = opts.log ?? defaultStatusLogger;
  try {
    // Non-string host args (typed string here, but tool args are `any`) stay
    // silent with the exact v1 result shape (`assignmentText.match is not a
    // function` regression guard — qc1 F-004).
    if (typeof assignmentText !== "string") {
      return { ok: true, violations: [] };
    }
    // Read-only roles (scout/explore) skip the branch-form/default-branch
    // gates — the engine composition's `writable` flag.
    const writable = isReadOnlyAssignmentRole(parseAssignmentFields(assignmentText).executeAs ?? "") ? false : undefined;
    const composed = composeDispatchGate(assignmentText, { writable });
    // Header flag, else repo-level hard (`.mstarc` → compass) — the same
    // precedence the status-write gate and dsh dispatches honor.
    const harnessDir = resolveHarnessDir();
    const hard = composed.enforcement.hard || (harnessDir !== null && resolveRepoEnforcement(harnessDir).hard);
    const gated: GateResult = applyEnforcement(composed, { hard });

    if (!gated.ok) {
      for (const violation of gated.violations) {
        const fix = violation.fix ? ` (fix: ${violation.fix})` : "";
        if (hard) {
          log(
            "error",
            `assignment validation (hard gate): [${violation.severity}] ${violation.code}: ${violation.message}${fix} — hardBlocked per Enforcement: hard; refusal requires a host refusal channel (skill: mstar-dispatch-gates)`,
          );
        } else {
          log(
            "warn",
            `assignment validation: [${violation.severity}] ${violation.code}: ${violation.message}${fix}`,
          );
        }
      }
    }
    return gated;
  } catch (error) {
    // Never throw, never block unexpectedly: unexpected errors degrade to a
    // single `error` log and a `null` return in BOTH modes (hard gates are
    // opt-in — an engine failure must not harden a workflow that was soft).
    log("error", `assignment validation aborted: ${(error as Error).message}`);
    return null;
  }
}

export const MorningStarHarnessPlugin: Plugin = async () => {
  const homeDir = os.homedir();
  const envConfigDir = normalizePath(process.env.OPENCODE_CONFIG_DIR, homeDir);
  const configDir = envConfigDir || path.join(homeDir, ".config/opencode");
  const isEnabledForProject = !!configDir;

  return {
    config: async (config: JsonObject) => {
      if (!isEnabledForProject) return;

      const runtimeConfig = config as JsonObject & {
        skills?: { paths?: string[] };
        agent?: Record<string, JsonObject>;
        command?: Record<string, JsonObject>;
      };
      runtimeConfig.skills = runtimeConfig.skills || {};
      runtimeConfig.skills.paths = runtimeConfig.skills.paths || [];
      for (const skillPath of resolveSkillPathCandidates()) {
        if (fs.existsSync(skillPath) && !runtimeConfig.skills.paths.includes(skillPath)) {
          runtimeConfig.skills.paths.push(skillPath);
        }
      }

      const markdownAgents = loadBundledAgents();
      runtimeConfig.agent = runtimeConfig.agent || {};
      for (const [agentId, definition] of Object.entries(markdownAgents)) {
        runtimeConfig.agent[agentId] = {
          ...(runtimeConfig.agent[agentId] || {}),
          ...definition,
        };
      }

      const markdownCommands = loadBundledCommands();
      runtimeConfig.command = runtimeConfig.command || {};
      for (const [commandId, definition] of Object.entries(markdownCommands)) {
        runtimeConfig.command[commandId] = {
          ...(runtimeConfig.command[commandId] || {}),
          ...definition,
        };
      }
    },

    "tool.execute.before": async (input, output) => {
      // Snapshot once: host `args` may be getter/Proxy-backed; re-reading
      // `args.prompt` / `args.filePath` between a typeof check and the call
      // can observe a different type (then `.match` / `path.resolve` throw
      // into the abort log channel).
      const args = (output?.args ?? {}) as Record<string, unknown>;
      const prompt = args.prompt;
      const rawFilePath = args.filePath;
      const rawPath = args.path;
      const filePath =
        typeof rawFilePath === "string" ? rawFilePath : typeof rawPath === "string" ? rawPath : undefined;

      // beforeDispatch-equivalent (Slice 5, dual-mode): Assignment
      // validation on subagent dispatch. OpenCode's `task` tool carries the
      // subagent prompt — the harness Assignment markdown — in `args.prompt`;
      // missing core fields (Execute as / Delegation / Task category),
      // branch-form violations and default-protected-branch work surface per
      // the Assignment's own enforcement flag (or the repo-level setting):
      // warn lines by default, error lines + `hardBlocked` result under
      // `Enforcement: hard`. The anti-recursion leg is caller-scoped and
      // this host cannot observe the dispatching agent (issue #156), so it
      // does not run here. Never modifies args and never throws in either
      // mode; `tool.execute.before` returns void on this host
      // (`@opencode-ai/plugin` 1.4.8 — no refusal channel), so a hard gate
      // degrades to the explicit refusal-channel log below.
      if (input.tool === "task" && typeof prompt === "string") {
        const gate = validateDispatchAssignment(prompt);
        if (gate?.hardBlocked) {
          defaultStatusLogger(
            "error",
            "hard-gate blocked (hardBlocked=true) — refusal requires a host refusal channel",
          );
        }
        return;
      }

      // Harness coordination-document write lint (Slice 5, dual-mode):
      // warn-only by default; hard mode (repo compass `enforcement: hard`)
      // logs error-level lines + a `hardBlocked` result. Never modifies
      // args and never throws in either mode. Structured file-write tools
      // (`write`/`edit`) carry the target path in `args.filePath` (fallback
      // `args.path`); bash-heredoc writes are out of scope. Tool
      // implementations may call `validateStatusWrite` directly.
      if (typeof filePath !== "string") return;

      if (input.tool === "write") {
        // Validate the document about to be written when it is already an
        // object or parses as JSON; otherwise fall back to on-disk state.
        const rawContent = args.content;
        let doc: unknown;
        if (typeof rawContent === "string") {
          try {
            doc = JSON.parse(rawContent);
          } catch {
            doc = undefined;
          }
        } else if (rawContent !== null && typeof rawContent === "object") {
          doc = rawContent;
        }
        const gate = await validateStatusWrite(filePath, { doc });
        if (gate?.hardBlocked) {
          defaultStatusLogger(
            "error",
            "hard-gate blocked (hardBlocked=true) — refusal requires a host refusal channel",
          );
        }
      } else if (input.tool === "edit") {
        // Classify the target FIRST (qc3 S-1): the dir-resolvers loader is
        // cached, so the kind check is cheap — the synchronous file read +
        // split/join + parse below only runs for canonical coordination
        // docs. Non-coordination targets (source files, configs, prose —
        // the overwhelming majority of edits) skip the read/parse entirely.
        classifyDirResolvers = await dirResolversLoader.load();
        if (harnessDocKindOfTarget(filePath) === null) return;
        // f8 (audit-20260821-f8): when the OpenCode `edit` args carry a
        // literal `oldString` -> `newString` pair (one pair per tool call —
        // no replacements array, no regex), synthesize the PATCHED text and
        // lint the patched coordination doc, so an edit that turns a valid
        // file invalid is caught at this hook instead of by the next write.
        // Only literal, uniquely-present replacements are composable here:
        // the host's fuzzy matchers (LineTrimmed / BlockAnchor /
        // WhitespaceNormalized) are NOT re-implemented — a fuzzy edit may
        // patch a different span than a guessed synthesis. Fallback to the
        // pre-edit lint when the shape is not composable: missing or empty
        // `oldString`, missing `newString`, `replaceAll` not a boolean,
        // literal not uniquely present (unless `replaceAll === true`), or
        // the file cannot be read.
        const oldString = args.oldString;
        const newString = args.newString;
        const replaceAll = args.replaceAll;
        let patchedDoc: unknown;
        if (
          typeof oldString === "string" &&
          oldString.length > 0 &&
          typeof newString === "string" &&
          (replaceAll === undefined || typeof replaceAll === "boolean")
        ) {
          try {
            const text = fs.readFileSync(filePath, "utf8");
            const hits = text.split(oldString).length - 1;
            if (replaceAll === true || hits === 1) {
              const patched = text.split(oldString).join(newString);
              try {
                patchedDoc = JSON.parse(patched);
              } catch {
                // Patched JSON would not parse — surface the invalid state
                // with an explicit non-object marker (`null`): the validators
                // report status.invalid-doc / workflow.snapshot.invalid /
                // project.register.invalid. Passing the raw string instead
                // would hit the status validator's STRING-as-PATH overload
                // and misreport `status.migration-required` (qc3 S-2). The
                // gate still fires — never a silent pass.
                patchedDoc = null;
              }
            }
          } catch {
            // Read failure (missing/unreadable file) -> pre-edit lint below.
          }
        }
        const gate =
          patchedDoc !== undefined
            ? await validateStatusWrite(filePath, { doc: patchedDoc })
            : await validateStatusWrite(filePath);
        if (gate?.hardBlocked) {
          defaultStatusLogger(
            "error",
            "hard-gate blocked (hardBlocked=true) — refusal requires a host refusal channel",
          );
        }
      }
    },

    "experimental.chat.messages.transform": async (
      _input: unknown,
      output: { messages: ChatMessage[] },
    ) => {
      const bootstrap = loadBootstrapContent();
      if (!bootstrap || !output.messages.length) return;

      const firstUser = output.messages.find((message: ChatMessage) => message.info.role === "user");
      if (!firstUser || !firstUser.parts.length) return;

      const injected = firstUser.parts.some(
        (part: MessagePart) =>
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.includes(`<${BOOTSTRAP_MARKER}>`),
      );
      if (injected) return;

      const ref = firstUser.parts[0];
      firstUser.parts.unshift({
        ...ref,
        type: "text",
        text: bootstrap,
      });
    },
  };
};

/**
 * OpenCode plugin entry (v1 PluginModule).
 *
 * OpenCode's legacy loader treats **every function export** on the package
 * entry as a plugin (`getLegacyPlugins` → `Object.values(mod)`). Our named
 * helpers (`validateStatusWrite` / `validateDispatchAssignment`) are also
 * functions — when invoked with `PluginInput` they return `null` / a
 * GateResult, which then gets pushed into the hooks list and blows up as
 * `plugin config hook failed: null is not an object (evaluating 'N.config')`.
 *
 * Default-exporting `{ server }` makes `readV1Plugin` win and skip the legacy
 * scan, so only `MorningStarHarnessPlugin` is registered. Named helper
 * exports stay available for tests and direct callers.
 */
export default {
  server: MorningStarHarnessPlugin,
};
