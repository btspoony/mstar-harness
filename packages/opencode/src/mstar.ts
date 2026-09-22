/**
 * MorningStarHarness plugin for OpenCode.
 *
 * - Injects one-time harness bootstrap into first user message.
 * - Registers skill paths only inside this package: `harness-skills/` (synced by `bundle-assets` at build time; includes `mstar-host`).
 * - Loads agents from `harness-agents/` only (same sync). Does not use `process.cwd()` so OpenCode project cwd does not matter.
 * - Loads custom commands from `harness-commands/` only (same sync).
 * - Dual-mode harness coordination-document write lint (roadmap §8.5
 * `beforeStatusWrite`, v3 hard cutover): on structured file-write tools
 * targeting the v2 root `{HARNESS_DIR}/status.json`, workflow snapshots
 * (`{HARNESS_DIR}/workflows/<id>/snapshot.json`) or project registers
 * (`{HARNESS_DIR}/projects/<id>/residuals.json`), runs the matching
 * engine validator (`status.validateStatus` /
 * `workflow.validateWorkflowSnapshot` / `project.validateProjectRegister`).
 * Default (no `Enforcement: hard`):
 * `warn` lines on violations, never blocks. Hard mode (repo iteration
 * compass frontmatter `enforcement: hard`, engine
 * `status.resolveCompassEnforcement`): error-level lines with a skill-text
 * pointer + a GateResult carrying `hardBlocked: true` (a refusal-capable
 * caller MUST refuse the write — this hook itself cannot abort the tool).
 * G4b authority protection: a write to `{HARNESS_DIR}/store.db` (`-wal`/`-shm`)
 * and a write to a project register of a store-backed workspace are refused
 * UNCONDITIONALLY (authority invariant, not the enforcement axis) —
 * `store.direct-write-refused`, `project.register.retired`,
 * `store.authority-unavailable`; a register keeps its document validator only
 * while no store / a staged store leaves it the live authority. Plan S4 adds
 * the EXECUTION authority's retired persistence route: a root `status.json` /
 * `workflows/<id>/snapshot.json` write is refused
 * `execution.direct-write-refused` while that authority is ACTIVE (fail-closed
 * when it exists and cannot be read) — canonical and symlinked targets alike.
 * This host has no refusal channel, so every one of those verdicts is a
 * decision record + error log, never an OS/tool fence.
 * Never throws raw exceptions in either mode — OpenCode's plugin API
 * (`@opencode-ai/plugin` 1.4.8) `tool.execute.before` returns
 * `Promise<void>` with no refusal channel, so hard mode is surfaced as the
 * error logs + structured result (see `validateStatusWrite`).
 * Engine-version compat : the snapshot/register
 * validators (`validateWorkflowSnapshot` / `validateProjectRegister`) are
 * P1-only exports absent from the published engine floor `^2.0.2` — they
 * are lazy-loaded (`newValidatorsLoader`); on a stale engine those write
 * lints are skipped with a one-time warning while the root status.json
 * lint keeps working, and the plugin module itself always links.
 * Hook coverage resolves the harness root from the target itself
 * ( the marker probe (`status.json` + `workflows/` +
 * `projects/` ancestor, correct for the default `.mstar` layout whose
 * nested `plans/` rung used to shadow the root), falling back to
 * `resolveHarnessDir` — a repo `.mstarc` `[config] harness_dir`, else
 * probing (`.mstar/` → `.agents/` → `.plans/`|`plans/`); repos with a
 * non-probed harness root MUST set `MSTAR_HARNESS_DIR` in the OpenCode
 * server env or declare `.mstarc` — see package README
 * "Status write lint (hook coverage)". * - Dual-mode `beforeDispatch` dispatch lint (roadmap §8.5): on `task`-tool
 * executions (subagent dispatch), validates the Assignment header — field
 * presence (`Execute as` / `Delegation` / `Task category`, backward-compat
 * `assignment.presence.*` codes), full field validation from the engine
 * (`dispatch.validateAssignmentFields`: exactly-one Working-branch form,
 * create-form `<base>`, Branch policy reason), the default-branch gate
 * (`dispatch.assertDefaultBranchProtected` with the CLI ea010f1
 * direct-on-exception wiring) and the anti-recursion binding check. The
 * Assignment's OWN `Enforcement: hard` flag (bold or plain) switches the
 * hook to hard mode: error-level lines + a GateResult carrying
 * `hardBlocked: true`; flag absent (or `Enforcement: soft`) stays warn-only.
 * Never throws raw exceptions in either mode (refusal-channel limitation as
 * above — see `validateDispatchAssignment`).
 */
import type { Plugin } from "@opencode-ai/plugin";
import {
  applyEnforcement,
  composeDispatchGate,
  decodeExecutionSessionRef,
  executionContextFor,
  isReadOnlyAssignmentRole,
  parseAssignmentFields,
  readJson,
  resolveHarnessDir,
  resolveRepoEnforcement,
  resumeExecutionSession,
  validateExecutionIdentity,
  validateStatus,
} from "@mstar-harness/engine";
import type {
  EnforcementFlag,
  ExecutionContext,
  ExecutionIdentity,
  ExecutionSessionRef,
  GateResult,
  StatusV2Doc,
  StoreContext,
  StoreRuntimeInfo,
} from "@mstar-harness/engine";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonPrimitive = string | number | boolean | null;
type JsonObject = Record<string, unknown>;
type FrontmatterAndBody = {
  frontmatter: string;
  body: string;
};
type MessagePart = { type: string; text?: string };

/** The only native identity OpenCode exposes to a tool hook. */
export type OpenCodeHookSession = Readonly<{ sessionID?: unknown }>;
/** Native OpenCode has no workflow/role binding channel for tool hooks. */
export type OpenCodeSessionAssociationDecision =
  | { kind: "unsupported"; capability: "decision-only"; sessionId: string }
  | { kind: "unavailable"; capability: "decision-only"; reason: string };

export function openCodeNativeAssociationDecision(input: OpenCodeHookSession): OpenCodeSessionAssociationDecision {
  const sessionId = input?.sessionID;
  if (typeof sessionId === "string" && sessionId.trim() !== "") {
    return { kind: "unsupported", capability: "decision-only", sessionId };
  }
  return {
    kind: "unavailable",
    capability: "decision-only",
    reason: "OpenCode did not provide a native sessionID; writer association is unsupported",
  };
}

/**
 * Build the engine identity from OpenCode's native per-call session fact.
 * The spawn target (`subagent`) and model-supplied arguments are deliberately
 * absent from this path. Missing/unsafe native identity is a refusal, never a
 * generated or cached substitute.
 */
export function openCodeExecutionIdentity(
  input: OpenCodeHookSession,
  scope: Pick<ExecutionIdentity, "workflowId" | "role" | "planId">,
): ExecutionIdentity {
  const sessionId = input?.sessionID;
  const identity = {
    source: "host" as const,
    sessionId: typeof sessionId === "string" ? sessionId : "",
    ...scope,
  };
  validateExecutionIdentity(identity, scope);
  return identity;
}

/**
 * Decode and resume an OpenCode-bound reference using the native hook session.
 * The engine re-reads authority, store identity, epoch and active row; this
 * helper never treats a cached reference or boolean flag as admission.
 */
export async function resumeOpenCodeExecutionSession(
  context: StoreContext,
  input: OpenCodeHookSession,
  scope: Pick<ExecutionIdentity, "workflowId" | "role" | "planId">,
  reference: string | ExecutionSessionRef,
) {
  const identity = openCodeExecutionIdentity(input, scope);
  const executionContext: ExecutionContext = executionContextFor(context, identity);
  const session = typeof reference === "string" ? decodeExecutionSessionRef(reference) : reference;
  return resumeExecutionSession(executionContext, session);
}
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

/** Join a readdir-derived entry name under the bundled directory it was
 * listed from; refuses a result that resolves outside that directory. A base
 * at a filesystem root ("/", "C:\") already ends with the separator, so the
 * appended-separator prefix would miss its own children — accept the bare
 * base prefix in that case. */
const joinBundledEntry = (dir: string, name: string): string => {
  const base = path.resolve(dir);
  const resolved = path.resolve(base, name);
  const withinEntry =
    resolved === base ||
    resolved.startsWith(base + path.sep) ||
    (base.endsWith(path.sep) && resolved.startsWith(base));
  if (!withinEntry) {
    throw new Error(`bundled entry escapes ${base}: ${name}`);
  }
  return resolved;
};

const loadAgentsFromDir = (agentsDirPath: string): Record<string, JsonObject> => {
  if (!fs.existsSync(agentsDirPath)) return {};

  const files = fs
    .readdirSync(agentsDirPath)
    .filter((name: string) => name.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b));

  const result: Record<string, JsonObject> = {};
  for (const file of files) {
    const filePath = joinBundledEntry(agentsDirPath, file);
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
    const filePath = joinBundledEntry(bundledCommandsDir, file);
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
 * Engine-version compat : `validateWorkflowSnapshot`
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
 * Default-layout fast path: the `workflows/` + `projects/` names). With the lazily-loaded engine dir resolvers, with the lazily-loaded engine dir resolvers, a
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
 * Resolve the harness root containing `startDir` by marker probe (): the nearest ancestor holding the v2 coordination-document
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
 * the harness root resolves — marker probe first (
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
 * Issue/catalog authority paths (G4b) — the store database plus the retired
 * register route. Mirrors the omp write gate
 * (`packages/omp/src/hooks/pre/mstar-gates.ts` `readAuthorityRoute`) and the
 * ZCode gate (`hooks/src/mstar-write-gate.ts`) in this host's GateResult
 * dialect: the CLASSIFICATION is the engine's single path; the refusal
 * channel differs per host.
 */

/** The authority database and its WAL sidecars, directly at a harness root. */
const STORE_DB_FILE = "store.db";
const STORE_AUTHORITY_FILES: readonly string[] = [STORE_DB_FILE, `${STORE_DB_FILE}-wal`, `${STORE_DB_FILE}-shm`];

/** Case-folded authority-name matching (qc2-F-004, dsh/omp/ZCode parity): the
 * match never hinges on byte case. This host cannot enforce (the decision is
 * the error-log / `hardBlocked` audit trail only), so a case-variant alias
 * (`Store.db`) must not skip even that. */
const STORE_AUTHORITY_NAMES: readonly string[] = STORE_AUTHORITY_FILES.map((file) => file.toLowerCase());

/** Refusal codes, in the frozen store / `project.register.*` vocabulary. */
const STORE_DIRECT_WRITE_CODE = "store.direct-write-refused";
const STORE_AUTHORITY_UNAVAILABLE_CODE = "store.authority-unavailable";
const REGISTER_RETIRED_CODE = "project.register.retired";
/** §4.3/§5: a write to a coordination document the EXECUTION authority
 * retired as a persistence route (plan S4). */
const EXECUTION_DIRECT_WRITE_CODE = "execution.direct-write-refused";

/** A store whose absence positively identifies the PRE-activation state
 * (legacy register authority in force, issue contract §7): missing
 * (`store.not-initialized`) or staged (`store.not-active`). Every other
 * refusal leaves the authority state UNKNOWN and is refused (dsh G4a
 * `catalogRegistrationRefusal` exclusion list, mirrored). */
const PRE_ACTIVATION_CODES: readonly string[] = ["store.not-initialized", "store.not-active"];

/**
 * Issue-store engine API (G4b). Like the P1 validators above, these exports
 * postdate the published engine floor — a static named import would fail at
 * module link against an older (or stubbed) installed engine and drop the
 * WHOLE plugin, so they load through the same lazy holder pattern. `null`
 * (missing exports / import failure) means the authority cannot be consulted:
 * the register path then refuses fail-closed with the upgrade guidance while
 * every unrelated document lint keeps working.
 */
type StoreApi = {
  detectStoreRuntime: () => StoreRuntimeInfo;
  assertStoreRuntimeSupported: (info: StoreRuntimeInfo) => void;
  /** One read envelope over the authority: resolves the active store revision. */
  readAuthority: (harnessDir: string) => Promise<number>;
  /**
   * §5 (plan S4) the ONE execution-source route decision, when the installed
   * engine carries it. OPTIONAL on purpose: an engine that predates the
   * execution authority has no route to resolve AND no harness can carry an
   * ACTIVE execution authority, so the retired documents keep their unchanged
   * document lint instead of a refusal class that cannot be true. An engine
   * that HAS the authority always exports it.
   */
  resolveExecutionRoute?: (harnessDir: string) => Promise<"execution" | "files">;
};

let cachedStoreApi: Promise<StoreApi | null> | null = null;

export function loadStoreApi(): Promise<StoreApi | null> {
  cachedStoreApi ??= import("@mstar-harness/engine")
    .then((mod) =>
      typeof mod.detectStoreRuntime === "function" &&
      typeof mod.assertStoreRuntimeSupported === "function" &&
      typeof mod.withStoreRead === "function" &&
      typeof mod.queryDashboard === "function"
        ? ({
            detectStoreRuntime: mod.detectStoreRuntime,
            assertStoreRuntimeSupported: mod.assertStoreRuntimeSupported,
            readAuthority: async (harnessDir: string) => {
              const envelope = await mod.withStoreRead(
                { harnessDir },
                mod.queryDashboard("issues", { limit: 1 }),
              );
              return envelope.storeRevision;
            },
            ...(typeof mod.resolveExecutionReadRoute === "function"
              ? {
                  resolveExecutionRoute: (harnessDir: string) =>
                    mod.resolveExecutionReadRoute({ harnessDir }),
                }
              : {}),
          } as const)
        : null,
    )
    .catch(() => null);
  return cachedStoreApi;
}

/** Test seam (same holder pattern as `newValidatorsLoader`): replace `load` to
 * simulate an engine build without the issue-store API, or to observe when the
 * store-backed route is entered. */
export const storeApiLoader: { load: () => Promise<StoreApi | null> } = { load: loadStoreApi };

/**
 * Actual-runtime probe override (test-injectable): when unset — the shipped
 * default — the route reads the ACTUAL runtime through the engine's
 * `detectStoreRuntime` (the Bun global first, so a Bun process is never judged
 * by Bun's EMULATED `process.versions.node`, which reports "26.3.0" on Bun
 * 1.4.0). Bun-run OpenCode gets the Bun floor; a native Node runner of this
 * plugin gets the Node floor — the invoked entrypoint's own runtime, never
 * both.
 */
export const storeRuntimeOverride: { info: (() => StoreRuntimeInfo) | null } = { info: null };

/** Stable code + message of a thrown refusal. */
function refusalOf(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  return { code: code === "" ? "store.authority-unreadable" : code, message };
}

/** What the issue store says about a register target. */
type AuthorityRoute =
  | { kind: "legacy" }
  | { kind: "retired"; storeRevision: number }
  | { kind: "unavailable"; code: string; message: string };

async function readAuthorityRoute(harnessDir: string): Promise<AuthorityRoute> {
  const api = await storeApiLoader.load();
  if (api === null) {
    return {
      kind: "unavailable",
      code: "engine-store-api-missing",
      message:
        "the installed @mstar-harness/engine exposes no issue-store API (detectStoreRuntime / " +
        "assertStoreRuntimeSupported / withStoreRead / queryDashboard), so the register path cannot be " +
        "answered; upgrade the engine (next release)",
    };
  }
  try {
    api.assertStoreRuntimeSupported(storeRuntimeOverride.info?.() ?? api.detectStoreRuntime());
  } catch (error) {
    return { kind: "unavailable", ...refusalOf(error) };
  }
  try {
    return { kind: "retired", storeRevision: await api.readAuthority(harnessDir) };
  } catch (error) {
    const refusal = refusalOf(error);
    return PRE_ACTIVATION_CODES.includes(refusal.code)
      ? { kind: "legacy" }
      : { kind: "unavailable", ...refusal };
  }
}

/** True when `dir` itself is a harness root: the v2 markers this plugin
 * classifies documents with (`status.json` + layout dirs), or the root the
 * engine resolves from the directory's PARENT (default `.mstar`-style and
 * `.mstarc harness_dir` roots — `resolveHarnessDir(dir)` probes *inside* a
 * directory, so it never answers for the root itself). */
function isHarnessRootDir(dir: string): boolean {
  if (hasHarnessRootMarkers(dir)) return true;
  const parentResolved = resolveHarnessDir(path.dirname(dir));
  return parentResolved !== null && path.resolve(parentResolved) === dir;
}

/** The path a write to `resolved` really lands on (S-G4b-03): authority
 * classification runs on the caller's own path first and on this one when the
 * target is an alias — a symlink outside the harness tree resolving to a
 * harness-root `store.db` / retired `residuals.json` IS that authority file.
 * A dangling symlink resolves to its would-be target: the file a write
 * through the link creates. A fresh (absent) target canonicalizes through its
 * nearest EXISTING ancestor: an ancestor directory symlinked into a harness
 * tree lands the write at the protected destination even though no marker is
 * visible on the textual path, so the classification follows the filesystem
 * there too. One canonicalization per checked target (the document lint keeps
 * the caller's path), mirrored in the omp entries, the dsh authority gate and
 * the ZCode write gate. */
function landedPathOf(resolved: string): string {
  try {
    return fs.realpathSync(resolved);
  } catch {
    try {
      return path.resolve(path.dirname(resolved), fs.readlinkSync(resolved));
    } catch {
      // The target does not exist yet and is not itself a dangling link — but
      // a missing FINAL component can still sit under a symlinked ANCESTOR,
      // and the filesystem lands the write at the canonical destination
      // through that alias. Canonicalize the nearest EXISTING ancestor and
      // rejoin the missing suffix; only a path with no existing ancestor at
      // all keeps the caller's path (a plain fresh file — the path itself
      // decides).
      let dir = path.dirname(resolved);
      for (;;) {
        try {
          return path.join(fs.realpathSync(dir), path.relative(dir, resolved));
        } catch {
          const parent = path.dirname(dir);
          if (parent === dir) return resolved;
          dir = parent;
        }
      }
    }
  }
}

/** True when `target` (absolute) IS the authority database (or a WAL sidecar)
 * sitting directly at a harness root: the runtime's own store location for a
 * harness root is `<harness root>/store.db`, and hand-writing those bytes is
 * never a supported operation — hard vs soft, staged vs active, alias or not,
 * all the same. The name match is case-insensitive (qc2-F-004, dsh/omp/ZCode
 * parity): on a case-insensitive volume (Darwin/APFS) a case-variant basename
 * (`Store.db`) lands on the same authority bytes, so the warn-only audit
 * trail must not hinge on byte case either. */
function isStoreAuthorityTarget(target: string): boolean {
  if (!STORE_AUTHORITY_NAMES.includes(path.basename(target).toLowerCase())) return false;
  return isHarnessRootDir(path.dirname(target));
}

/** The register file's basename, matched case-insensitively (qc2-F-004). */
const REGISTER_BASENAME = /residuals\.json/i;
/** The canonical register shape under the resolved project dir — one project
 * component + the register file — with the file name folded (qc2-F-004). */
const REGISTER_SHAPE = /^[^/]+\/residuals\.json$/i;

/** The harness root of a register target the exact-case classifiers MISS
 * because its basename is a case variant (`RESIDUALS.json`, qc2-F-004): the
 * canonical register shape (one project component + the register file under
 * the resolved project dir) is matched case-insensitively from the nearest
 * harness root up the tree — the same walk the engine's marker probe runs for
 * exact-case names, so a case-variant register is authority-classified like
 * the file itself and keeps its document validator on the pre-activation
 * fall-through (dsh/omp/ZCode parity). `null` when the basename is not a
 * register name or no ancestor root holds the shape. */
function caseFoldedRegisterRoot(candidate: string): string | null {
  const target = path.resolve(candidate);
  if (!REGISTER_BASENAME.test(path.basename(target))) return null;
  let dir = path.dirname(target);
  for (;;) {
    if (isHarnessRootDir(dir)) {
      let projectDir: string;
      const resolvers = classifyDirResolvers;
      if (resolvers !== null) {
        try {
          projectDir = resolvers.resolveProjectDir(dir, { harnessDir: dir });
        } catch {
          projectDir = path.join(dir, "projects");
        }
      } else {
        projectDir = path.join(dir, "projects");
      }
      if (REGISTER_SHAPE.test(path.relative(projectDir, target))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The harness root of a project register this write reaches ONLY through a
 * symlink alias (`landed` differs from the caller's own `resolved` path): the
 * register is an authority document, so its route is decided on the path the
 * write really lands on. `null` when the target is not an alias, or does not
 * land on a register (S-G4b-03). */
function aliasedRegisterDir(resolved: string, landed: string): string | null {
  if (landed === resolved) return null;
  const aliased = harnessDocKindOfTarget(path.resolve(landed));
  return aliased?.kind === "register" ? aliased.harnessDir : null;
}

/** One authority refusal as a refusal-capable GateResult: `hardBlocked` is
 * set unconditionally (no enforcement flag involved) so a caller with a
 * refusal channel must refuse the write. */
function authorityRefusal(code: string, message: string, log: StatusLogger): GateResult {
  log(
    "error",
    `${code}: ${message} — blocked by decision only: this host's \`tool.execute.before\` has no refusal ` +
      "channel, so the write is NOT stopped — authority protection is warn-only here (skill: " +
      "mstar-artifacts/references/status-and-residuals.md)",
  );
  return { ok: false, violations: [{ ok: false, severity: "high", code, message }], hardBlocked: true };
}

function storeDirectWriteRefusal(targetPath: string, log: StatusLogger): GateResult {
  return authorityRefusal(
    STORE_DIRECT_WRITE_CODE,
    `${targetPath} is the issue/catalog authority database and is owned by the runtime — a direct hand write ` +
      "is refused (the schema and its WAL are managed in-process). Schema changes go through `mstar store " +
      "init|upgrade|migrate`, findings through `mstar issue add|close`, catalog rows through `mstar catalog " +
      "register|update`",
    log,
  );
}

function registerRetiredRefusal(storeRevision: number, log: StatusLogger): GateResult {
  return authorityRefusal(
    REGISTER_RETIRED_CODE,
    "project registers are retired migration history — the issue store ({HARNESS_DIR}/store.db, revision " +
      `${storeRevision}) is the only findings authority; capture and close through \`mstar plan ` +
      "issue-add|issue-close` (plan-scoped) or `mstar issue add|close` (unscoped). This write is refused",
    log,
  );
}

/**
 * §4.3 the EXECUTION authority's retired coordination documents (plan S4):
 * root `status.json` and `workflows/<id>/snapshot.json` are no longer a
 * persistence route while that authority is ACTIVE, so persisting them would
 * create a second authority — refused regardless of the compass enforcement
 * flag and regardless of whether the bytes would validate.
 *
 * This host's channel is honest about what it is: `tool.execute.before`
 * returns void here (no refusal channel), so this result is a DECISION plus an
 * error-log record, never an OS/tool fence. `authorityRefusal` states exactly
 * that; nothing in this path may claim the write was stopped.
 */
function executionDirectWriteRefusal(targetPath: string, log: StatusLogger): GateResult {
  return authorityRefusal(
    EXECUTION_DIRECT_WRITE_CODE,
    `${targetPath} is retired as a persistence route while the control harness's execution authority is ACTIVE — ` +
      "the root status and the workflow snapshots live in the execution store ({HARNESS_DIR}/store.db, owned by " +
      "the runtime). Use the execution DB route (the coordination verbs), not a file writer. This write is refused",
    log,
  );
}

function authorityUnavailableRefusal(
  route: { code: string; message: string },
  log: StatusLogger,
  authority = "the issue authority",
  write = "register write",
): GateResult {
  return authorityRefusal(
    STORE_AUTHORITY_UNAVAILABLE_CODE,
    `${authority} could not be read ([${route.code}] ${route.message}) — the ${write} is refused ` +
      "rather than applied against an unreadable authority; no older-runtime or JSON fallback exists",
    log,
  );
}

/**
 * §5 (plan S4) what the control harness's EXECUTION authority says about a
 * coordination-document write in this host's dialect. `resolveExecutionReadRoute`
 * (through the lazy store holder) is the ONE place a consumer decides between
 * the DB authority and the file route; a store that EXISTS and cannot be read
 * is `unavailable` (fail-closed, never a fall-through to the file route) and a
 * harness with no store keeps the file route (§2.1: absence is not an
 * authority verdict). An installed engine without the route export is the
 * pre-execution engine: there is no authority to classify, so the documents
 * keep their unchanged document lint.
 */
type ExecutionWriteRoute =
  | { kind: "files" }
  | { kind: "active" }
  | { kind: "unavailable"; code: string; message: string };

async function readExecutionWriteRoute(harnessDir: string): Promise<ExecutionWriteRoute> {
  const api = await storeApiLoader.load();
  const resolve = api?.resolveExecutionRoute;
  if (resolve === undefined) return { kind: "files" };
  try {
    return (await resolve(harnessDir)) === "execution" ? { kind: "active" } : { kind: "files" };
  } catch (error) {
    return { kind: "unavailable", ...refusalOf(error) };
  }
}

/**
 * `status.json` / workflow snapshot / project register write lint (roadmap
 * §8.5 `beforeStatusWrite`, v3 hard cutover).
 *
 * Given the target path of a file write, resolves `{HARNESS_DIR}` from the
 * target (marker probe first — W-REV-1 — with the engine
 * `path.resolveHarnessDir` declared-root fallback) and runs
 * the matching engine validator on the document about to be written
 * (`opts.doc`) or on the current file: `status.validateStatus` for the v2
 * root, `workflow.validateWorkflowSnapshot` for
 * `workflows/<id>/snapshot.json`, `project.validateProjectRegister` for
 * `projects/<id>/residuals.json` (the v1 root `residual_findings` surface
 * is gone — the residual write gate moved to the register path).
 *
 * Authority paths (G4b + plan S4) are decided before the document path and
 * are NOT governed by the enforcement flag (an authority invariant, not
 * document validity — the ZCode/omp write gates refuse the same classes
 * unconditionally): a `{HARNESS_DIR}/store.db` (`-wal`/`-shm`) write is
 * refused outright, a root `status.json` / `workflows/<id>/snapshot.json`
 * write is refused while the control harness's EXECUTION authority is ACTIVE
 * (`execution.direct-write-refused` — the retired persistence route), and a
 * project register is routed through the DB-aware authority check — refused as
 * `project.register.retired` while the issue store is the active findings
 * authority, refused as `store.authority-unavailable` when that authority
 * cannot be read at all, and shape-validated only while no store / a staged
 * store leaves the register the live authority (issue contract §7). These
 * refusal classes are decided on the path a target really LANDS on
 * (S-G4b-03): a symlink alias that resolves to a harness-root `store.db` or to
 * a project register is refused and routed exactly like the file itself, while
 * everything else keeps the caller's path and behaviour. The runtime floor is
 * read from the ACTUAL runtime (engine `detectStoreRuntime` — the Bun global
 * first, never Bun's emulated `process.versions.node`) and asserted
 * in-process before the store is touched.
 *
 * Enforcement (roadmap §8.5 C4/D2, Slice 5):
 * - **Warn mode (default)** — flag absent: violations are surfaced as `warn`
 *   through the plugin log channel; `hardBlocked` is false.
 * - **Hard mode** — the write context carries `Enforcement: hard` via
 *   `opts.enforcement`, or (when omitted) the repo's iteration compass
 *   frontmatter declares `enforcement: hard` (engine
 *   `status.resolveCompassEnforcement`): violations are surfaced as `error`
 *   lines with a skill-text pointer and the returned GateResult carries
 *   `hardBlocked: true` — a refusal-capable caller MUST refuse the write.
 * Never throws a raw exception: hard mode is the structured result +
 * error log channel.
 *
 * Blocking channel note (documented behavior): OpenCode's plugin API
 * (`@opencode-ai/plugin` 1.4.8) `tool.execute.before` returns
 * `Promise<void>` — there is no error/refusal return channel on this host.
 * The plugin therefore surfaces hard mode — the authority classes included —
 * as error-level log lines (captured into the OpenCode server log) + the
 * structured `hardBlocked` result; host bindings with a refusal channel
 * (pi/dsh when their APIs land) must refuse the write when
 * `hardBlocked === true`. This host does NOT enforce: an authority refusal
 * here is a decision record, never an OS/tool fence.
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
 // S-G4b-03: the AUTHORITY decision runs on the path the target really lands
 // on — a symlink alias of the store database or of a project register IS
 // that authority file. Nothing else is canonicalized.
    const landed = landedPathOf(resolved);
    const storeTarget = isStoreAuthorityTarget(resolved) ? resolved : isStoreAuthorityTarget(landed) ? landed : null;
 // Phase-5 F1: ensure the custom-layout dir resolvers are loaded before
 // classifying — the sync slot feeds `harnessDocKindOfTarget` AND the
 // authority-target marker probe (stale engine -> null -> default-layout
 // names, the pre-F1 behavior).
    classifyDirResolvers = await dirResolversLoader.load();
// G4b authority paths first: the store database is never writable by hand,
// and a register target is decided by the DB-aware authority route rather
// than by its document shape (both refuse unconditionally).
    if (storeTarget !== null) return storeDirectWriteRefusal(storeTarget, log);
    const classified = harnessDocKindOfTarget(resolved);
    // §4.3/§5 (plan S4) the EXECUTION authority's retired documents come
    // next: root status and workflow snapshots are refused while that
    // authority is ACTIVE, and refused fail-closed when it exists and cannot
    // be read. The classification covers the caller's own path AND the path
    // the write really lands on (S-G4b-03) — and it covers BOTH harness roots:
    // a status/snapshot symlinked into ANOTHER harness's tree lands on THAT
    // harness's document, so EITHER root's verdict (ACTIVE or UNAVAILABLE)
    // refuses the write. A single-root probe would let a pre-activation
    // harness's alias bypass the authority the bytes really belong to (an
    // identical landed root costs no second probe). The old protected artifact
    // paths keep their canonical target checks even though the new authority
    // refuses writing them. This is an authority invariant, not the compass
    // axis.
    const landedAlias = landed === resolved ? null : harnessDocKindOfTarget(landed);
    const executionDirs: string[] = [];
    if (classified !== null && classified.kind !== "register") executionDirs.push(classified.harnessDir);
    if (
      landedAlias !== null &&
      landedAlias.kind !== "register" &&
      !executionDirs.includes(landedAlias.harnessDir)
    ) {
      executionDirs.push(landedAlias.harnessDir);
    }
    for (const executionDir of executionDirs) {
      const executionRoute = await readExecutionWriteRoute(executionDir);
      if (executionRoute.kind === "active") return executionDirectWriteRefusal(resolved, log);
      if (executionRoute.kind === "unavailable") {
        return authorityUnavailableRefusal(
          executionRoute,
          log,
          "the harness's execution authority",
          "coordination-document write",
        );
      }
    }
    // A project register is an authority document too — reached through an
    // alias it takes the same route (status/snapshot aliases are handled
    // above). A case-variant register basename (qc2-F-004) bypasses both
    // exact-case classifications and is classified by the folded shape walk
    // instead, so the warn-only audit trail fires for it too (dsh/omp/ZCode
    // parity).
    const registerDir =
      classified?.kind === "register"
        ? classified.harnessDir
        : (landedAlias?.kind === "register"
            ? landedAlias.harnessDir
            : (aliasedRegisterDir(resolved, landed) ??
              caseFoldedRegisterRoot(resolved) ??
              (landed !== resolved ? caseFoldedRegisterRoot(landed) : null)));
    const target = classified ?? (registerDir === null ? null : { harnessDir: registerDir, kind: "register" as const });
    if (!target) return null;

    let result: GateResult | null;
    if (registerDir !== null) {
      const route = await readAuthorityRoute(registerDir);
      if (route.kind === "retired") return registerRetiredRefusal(route.storeRevision, log);
      if (route.kind === "unavailable") return authorityUnavailableRefusal(route, log);
// `legacy` (no store / staged store): pre-activation, the register is
// still the findings authority, so its own validator decides below.
    }

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
 * `dispatch.composeDispatchGate` (no local composition
 * left in the host adapter):
 * (1) Shape guard — `## Assignment` heading or a core field line
 * (`Execute as` / `Delegation` / `Task category`); non-Assignment prompts
 * stay silent (no false positives).
 * (2) `validateAssignmentFields` — required fields, exactly-one
 * Working-branch form, create-form `<base>`, Branch policy reason; the
 * legacy `assignment.presence.*` codes are engine ALIASES on the three
 * core-field violations (single parser — no local presence parser). Read-only roles (scout/explore) pass `writable: false` so no
 * spurious `branch-missing` fires.
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
 * `warn` line per violation through the `[mstar-harness]` channel;
 * `hardBlocked` is false. Unchanged v1 behavior.
 * - **Hard mode** — the Assignment header carries `Enforcement: hard`
 * (bold or plain): one `error` line per violation with a skill-text
 * pointer and the returned GateResult carries `hardBlocked: true` — a
 * refusal-capable caller MUST refuse the dispatch (this hook itself
 * cannot abort the tool; see the blocking-channel note). Never throws a
 * raw exception: hard mode is the structured result + error log channel.
 * `Enforcement: soft` (explicit non-hard) stays warn-only; rollback =
 * unset the flag. The flag is read from the Assignment HEADER region
 * only — an example `**Enforcement**: hard` line in the task body does
 * not harden. *
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
 // function` regression guard —).
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
  return {
    config: async (config: JsonObject) => {
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
      const nativeAssociation = openCodeNativeAssociationDecision(input);
      if (
        nativeAssociation.kind === "unavailable" &&
        (input.tool === "write" || input.tool === "edit")
      ) {
        defaultStatusLogger("warn", nativeAssociation.reason);
      }

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
 // Classify the target FIRST : the dir-resolvers loader is
 // cached, so the kind check is cheap — the synchronous file read +
 // split/join + parse below only runs for canonical coordination
 // docs. Non-coordination targets (source files, configs, prose —
 // the overwhelming majority of edits) skip the read/parse entirely.
        classifyDirResolvers = await dirResolversLoader.load();
        if (harnessDocKindOfTarget(filePath) === null && !isStoreAuthorityTarget(filePath)) return;
 // Patched-doc linting: when the OpenCode `edit` args carry a
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
 // and misreport `status.migration-required` . The
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
