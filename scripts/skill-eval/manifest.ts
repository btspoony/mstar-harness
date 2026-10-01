/**
 * scripts/skill-eval/manifest.ts — immutable manifest builder.
 *
 * `prepare` freezes the skill-eval baseline: it validates the runner-owned
 * config and the frozen 30-case set, resolves an immutable manifest v1,
 * materializes case fixtures and fixed ref/closure/config hashes, and versions
 * held-out integrity hashes BEFORE any candidate tuning.
 *
 * Hard contract (Spec A1):
 * - prepare performs ZERO model calls. The only production subprocess it may
 * run is read-only git (source-tree closure hashing), and every subprocess
 * must go through the injected `exec` seam so tests can spy on it.
 * - exit 0 => immutable resolved manifest + fixture/closure hashes written
 * under the disposable fixture root; exit 2 => invalid config, nothing
 * written anywhere (validation completes before any filesystem write).
 * - Model identity is never invented: an unavailable model is preserved as
 * `null` plus an explicit reason.
 * - All writes stay inside `<repoRoot>/.tmp/skill-eval/` (disposable); the
 * real main/control source roots are never a write target.
 *
 * Stage entry: `prepareManifest` (exported below) — invoked programmatically;
 * there is no CLI dispatcher (skill-eval is fully automated / test-driven).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Schema constants (manifest v1)
// ---------------------------------------------------------------------------

export const MANIFEST_SCHEMA_VERSION = 1;
export const ROUTES = ["pm", "dev", "qc", "audit", "close"] as const;
export type Route = (typeof ROUTES)[number];
/** Split stored on a case record. */
export const CASE_SPLITS = ["dev", "heldout"] as const;
export type CaseSplit = (typeof CASE_SPLITS)[number];
/** Split accepted by the future `run` CLI; `smoke` is derived from dev cases. */
export const RUN_SPLITS = ["smoke", "dev", "heldout"] as const;
export type RunSplit = (typeof RUN_SPLITS)[number];
export const VARIANT_IDS = ["baseline", "candidate", "minimal"] as const;
export type VariantId = (typeof VARIANT_IDS)[number];
export const SANDBOX_MODES = ["read-only", "workspace-write"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** Per-route case counts: every route carries 4 dev + 2 heldout cases. */
export const DEV_CASES_PER_ROUTE = 4;
export const HELDOUT_CASES_PER_ROUTE = 2;
export const TOTAL_CASES = ROUTES.length * (DEV_CASES_PER_ROUTE + HELDOUT_CASES_PER_ROUTE); // 30
export const TOTAL_DEV_CASES = ROUTES.length * DEV_CASES_PER_ROUTE; // 20
export const TOTAL_HELDOUT_CASES = ROUTES.length * HELDOUT_CASES_PER_ROUTE; // 10
/** Smoke = exactly 3 existing dev cases with these three coverage tags. */
export const SMOKE_CASE_COUNT = 3;
export const SMOKE_REQUIRED_TAGS = [
  "smoke-readonly-closure-sentinel",
  "smoke-isolated-relative-write",
  "smoke-explicit-resume",
] as const;

/** Coverage tags that must appear at least once across the frozen set. */
export const REQUIRED_COVERAGE_TAGS = [
  "normal-completion",
  "unauthorized-request",
  "legitimate-repair-or-exception",
  "false-pass-trap",
  "wrong-checkout-trap",
  "first-turn",
  "resume",
  "preset-none",
  "preset-standard",
  "engine-absent",
  "engine-advisory",
  "engine-blocking",
] as const;

export const ASSERTION_KINDS = [
  "final_contains",
  "final_not_contains",
  "tool_read_contains",
  "tool_read_not_contains",
  "diff_paths_within",
  "thread_reused",
  "calls_within",
  "mutation_withheld",
  "grouped_facts_final",
] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

/** Declared bootstrap context for bounded-resolution accounting (never inferred). */
export const RESOLUTION_CONTEXTS = ["warm", "cold"] as const;
export type ResolutionContext = (typeof RESOLUTION_CONTEXTS)[number];

export interface BoundedResolutionContext {
  /**
   * "warm" = bootstrap policy reads are already available to the run;
   * "cold" = the run must causally load them. Declared per case, never
   * inferred from the event stream.
   */
  context: ResolutionContext;
}

export const REPEATS_ALLOWED = [1, 3] as const;

/** Disposable scratch root (gitignored): all prepare writes live under it. */
export const FIXTURE_ROOT_SEGMENT = join(".tmp", "skill-eval");

/**
 * C-W3: the per-arm freeze closure covers the complete reachable
 * skill/reference closure of the pinned ref (Spec A1) — the `skills/` tree
 * PLUS the repo-root contract and command surfaces that skill content
 * load-bearingly references (`AGENTS.md` — proven injected by the real smoke —
 * and `commands/`). Host plugin mirrors (`.cursor-plugin/` etc.) are derived
 * bundles, not load-authority sources, and stay excluded; deep link-graph
 * reachability extraction is Plan 02's `closure.test.ts` scope (Spec A5).
 */
export const CLOSURE_TREE_PATHS = ["AGENTS.md", "commands", "skills"] as const;

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const CASE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SECRET_KEY_RE = /(token|secret|password|passwd|api[-_]?key|authorization|credential)/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixtureFileDef {
 /** Relative path inside the case fixture directory; must not escape it. */
  path: string;
  content: string;
}

export interface FixtureDef {
  files: FixtureFileDef[];
}

export interface CaseAssertion {
  id: string;
  kind: AssertionKind;
 /** string for *_contains kinds, string[] for diff_paths_within, true for thread_reused and mutation_withheld, positive integer for calls_within. */
  value: string | string[] | true | number;
  note?: string;
}

export interface CaseProvenance {
 /** Provenance seed, e.g. "routing-evals.json#small-backend-clean@v27". */
  seed?: string;
  note?: string;
  coverage: string[];
 /** Marks the 3 smoke dev cases (derived `--split smoke` selection). */
  smoke?: boolean;
}

export interface RawCase {
  id: string;
  route: Route;
  split: CaseSplit;
  fixture: FixtureDef;
  prompt: string;
  resumePrompt?: string;
  assertions: CaseAssertion[];
  provenance: CaseProvenance;
 /** Optional per-case override of the global sandbox. */
  sandbox?: SandboxMode;
 /** Optional declared bounded-resolution bootstrap context. */
  boundedResolution?: BoundedResolutionContext;
}

export interface CasesFile {
  schemaVersion: number;
  cases: RawCase[];
}

export interface PreparedManifestCase {
  id: string;
  route: Route;
  split: CaseSplit;
  fixture: {
    hash: string;
    files: { path: string; sha256: string }[];
  };
  prompt: string;
  resumePrompt?: string;
  assertions: CaseAssertion[];
  provenance: CaseProvenance;
  sandbox: SandboxMode;
 /** Declared bounded-resolution bootstrap context (absent = undeclared). */
  boundedResolution?: BoundedResolutionContext;
  integrityHash: string;
}

export interface VariantRecord {
  id: VariantId;
  sourceRef: string;
  closure: { path: string; sha256: string }[];
}

export interface PrepareConfigInput {
  plan: string;
  sourceRefs: { baseline: string; candidate: string };
  cli: { path: string; version: string; helpHash: string };
  requestedModel: string | null;
  requestedModelReason?: string | null;
  observedModel: string | null;
  observedModelReason?: string | null;
  ambient: { status: string; evidence: string };
  sandbox: SandboxMode;
  timeoutMs: number;
  repeats: (typeof REPEATS_ALLOWED)[number];
  interleaveSeed: number;
}

export interface EvalManifest {
  schemaVersion: number;
  plan: string;
  sourceRefs: { baseline: string; candidate: string };
  cli: { path: string; version: string; helpHash: string };
  requestedModel: string | null;
  requestedModelReason: string | null;
  observedModel: string | null;
  observedModelReason: string | null;
  configHash: string;
  casesHash: string;
  ambient: { status: string; evidence: string };
  variants: VariantRecord[];
  cases: PreparedManifestCase[];
  sandbox: SandboxMode;
  timeoutMs: number;
  repeats: number;
  interleaveSeed: number;
 /** sha256 over the sorted heldout (id, integrityHash) pairs — frozen before tuning. */
  heldoutDigest: string;
}

export interface PrepareResult {
  exit: 0 | 2;
  manifest?: EvalManifest;
  manifestPath?: string;
  errors: string[];
}

/** Map path -> sha256 for one source ref tree (skills/ closure scope). */
export type SourceTree = Record<string, string>;
export type SourceTreeReader = (sourceRef: string) => Promise<SourceTree>;
export type ExecArgv = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: Buffer }>;

/** Minimal filesystem seam so validation can run fully in memory in tests. */
export interface Io {
  readText(path: string): string;
  writeText(path: string, content: string): void;
  ensureDir(path: string): void;
  exists(path: string): boolean;
  realpath(path: string): string;
}

export const nodeIo: Io = {
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, content) => writeFileSync(path, content, "utf8"),
  ensureDir: (path) => mkdirSync(path, { recursive: true }),
  exists: (path) => existsSync(path),
  realpath: (path) => realpathSync(path),
};

// ---------------------------------------------------------------------------
// Hashing / canonical JSON helpers
// ---------------------------------------------------------------------------

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON with recursively sorted object keys (for hashing).
 * Keys are ordered by an in-place insertion sort (stable, UTF-16 code-unit
 * order) so the serialization of untrusted documents never depends on the
 * input's own ordering. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = objectKeysInCodeUnitOrder(obj);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Insertion-sorted key list: identical order to a comparator sort of
 * `Object.keys` (stable, code-unit ascending), without relying on the
 * array sort method. */
function objectKeysInCodeUnitOrder(obj: Record<string, unknown>): string[] {
  const keys = Object.keys(obj);
  for (let i = 1; i < keys.length; i += 1) {
    const key = keys[i]!;
    let j = i - 1;
    while (j >= 0 && keys[j]! > key) {
      keys[j + 1] = keys[j]!;
      j -= 1;
    }
    keys[j + 1] = key;
  }
  return keys;
}

/**
 * Canonical run ID: `case/variant/repeat/turn`.
 * Turn 1 = first turn; turn >= 2 = resume turns.
 */
export function canonicalRunId(
  caseId: string,
  variantId: string,
  repeat: number,
  turn: number,
): string {
  if (!caseId || !CASE_ID_RE.test(caseId)) {
    throw new Error(`canonicalRunId: invalid case id ${JSON.stringify(caseId)}`);
  }
  if (!variantId || (VARIANT_IDS as readonly string[]).includes(variantId) === false) {
    throw new Error(`canonicalRunId: invalid variant id ${JSON.stringify(variantId)}`);
  }
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error(`canonicalRunId: repeat must be an integer >= 1, got ${repeat}`);
  }
  if (!Number.isInteger(turn) || turn < 1) {
    throw new Error(`canonicalRunId: turn must be an integer >= 1, got ${turn}`);
  }
  return `${caseId}/${variantId}/${repeat}/${turn}`;
}

/** Split accepted by the future run CLI; unknown splits are rejected. */
export function validateRunSplit(split: string): string[] {
  return (RUN_SPLITS as readonly string[]).includes(split)
    ? []
    : [`unknown split: ${JSON.stringify(split)} (expected one of ${RUN_SPLITS.join("|")})`];
}

// ---------------------------------------------------------------------------
// Source-tree reader (the ONLY production subprocess: read-only git argv)
// ---------------------------------------------------------------------------

export const defaultExecArgv: ExecArgv = (file, args) =>
  new Promise((res, rej) => {
 // argv array only — no shell, no string interpolation.
    execFile(file, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) rej(error);
      else res({ stdout: stdout as Buffer });
    });
  });

interface LsTreeEntry {
  type: string;
  blobSha: string;
  path: string;
}

function parseLsTreeZ(stdout: Buffer): LsTreeEntry[] {
  const entries: LsTreeEntry[] = [];
  for (const record of stdout.toString("utf8").split("\0")) {
    if (record === "") continue;
    const tabIndex = record.indexOf("\t");
    if (tabIndex < 0) throw new Error(`malformed git ls-tree record: ${JSON.stringify(record)}`);
    const meta = record.slice(0, tabIndex).split(" ");
    const path = record.slice(tabIndex + 1);
    if (meta.length !== 3) {
      throw new Error(`malformed git ls-tree metadata: ${JSON.stringify(record)}`);
    }
    entries.push({ type: meta[1], blobSha: meta[2], path });
  }
  return entries;
}

/**
 * Reader that resolves the freeze closure of a pinned full-SHA ref via
 * `git ls-tree -r -z <ref> -- <CLOSURE_TREE_PATHS>` + `git cat-file blob
 * <ref>:<path>` (C-W3: complete reachable skill/reference closure — skills/
 * tree plus AGENTS.md and commands/). Read-only git argv calls; never touches
 * the working tree of any checkout. The git invocation is pinned to an
 * immutable commit id: the ref is accepted only as a 40-hex full SHA, and the
 * `ref:path` blob spec is assembled by plain concatenation of the validated
 * ref and the git-reported path.
 */
export function makeGitSourceTreeReader(
  repoRoot: string,
  invoke: ExecArgv = defaultExecArgv,
): SourceTreeReader {
  return async (sourceRef) => {
    if (!FULL_SHA_RE.test(sourceRef)) {
      throw new Error(`source ref must be a 40-hex full SHA, got ${JSON.stringify(sourceRef)}`);
    }
    const ls = await invoke("git", [
      "-C",
      repoRoot,
      "ls-tree",
      "-r",
      "-z",
      sourceRef,
      "--",
      ...CLOSURE_TREE_PATHS,
    ]);
    const tree: SourceTree = {};
    for (const entry of parseLsTreeZ(ls.stdout)) {
      if (entry.type !== "blob") continue;
      const blobSpec = sourceRef + ":" + entry.path;
      const cat = await invoke("git", ["-C", repoRoot, "cat-file", "blob", blobSpec]);
      tree[entry.path] = sha256Hex(cat.stdout);
    }
    return tree;
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isSafeFixtureRelPath(path: string): boolean {
  if (path === "" || path.includes("\0") || path.endsWith("/")) return false;
  if (isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

function assertType(value: unknown, expected: "string" | "number" | "boolean" | "object", label: string, errors: string[]): void {
  if (expected === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${label} must be an object`);
    }
    return;
  }
  if (typeof value !== expected) errors.push(`${label} must be a ${expected}`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

export function validateConfig(raw: unknown): { config?: PrepareConfigInput; errors: string[] } {
  const errors: string[] = [];
  assertType(raw, "object", "config", errors);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors };

 // Runner-owned NONSECRET configuration only — reject secret-looking keys up front.
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(key)) {
      errors.push(`config key ${JSON.stringify(key)} looks like a secret; configHash covers runner-owned nonsecret configuration only`);
    }
  }

  const cfg = raw as Record<string, unknown>;

  if (!nonEmptyString(cfg.plan)) errors.push("config.plan must be a non-empty string");

  const sourceRefs = cfg.sourceRefs;
  assertType(sourceRefs, "object", "config.sourceRefs", errors);
  if (sourceRefs && typeof sourceRefs === "object" && !Array.isArray(sourceRefs)) {
    const sr = sourceRefs as Record<string, unknown>;
    for (const arm of ["baseline", "candidate"] as const) {
      const ref = sr[arm];
      if (typeof ref !== "string" || !FULL_SHA_RE.test(ref)) {
 // Mutable refs (branch names, HEAD, short SHAs) are rejected: the
 // manifest must pin immutable full SHAs.
        errors.push(
          `config.sourceRefs.${arm} is a mutable or non-full ref: ${JSON.stringify(ref ?? null)} (require 40-hex full SHA)`,
        );
      }
    }
  }

  const cli = cfg.cli;
  assertType(cli, "object", "config.cli", errors);
  if (cli && typeof cli === "object" && !Array.isArray(cli)) {
    const c = cli as Record<string, unknown>;
    if (typeof c.path !== "string" || !isAbsolute(c.path)) {
      errors.push(`config.cli.path must be an absolute path, got ${JSON.stringify(c.path ?? null)}`);
    }
    if (!nonEmptyString(c.version)) errors.push("config.cli.version must be a non-empty string");
    if (typeof c.helpHash !== "string" || !HEX_64_RE.test(c.helpHash)) {
      errors.push("config.cli.helpHash must be a 64-hex sha256 of the recorded help output");
    }
  }

  for (const field of ["requestedModel", "observedModel"] as const) {
    const value = cfg[field];
    const reasonField = field === "requestedModel" ? "requestedModelReason" : "observedModelReason";
    if (value === null) {
 // Missing model identity is preserved as null + explicit reason.
      if (!nonEmptyString(cfg[reasonField])) {
        errors.push(`config.${field} is null and requires a non-empty config.${reasonField}`);
      }
    } else if (!nonEmptyString(value)) {
      errors.push(`config.${field} must be null or a non-empty string`);
    }
  }

  const ambient = cfg.ambient;
  assertType(ambient, "object", "config.ambient", errors);
  if (ambient && typeof ambient === "object" && !Array.isArray(ambient)) {
    const a = ambient as Record<string, unknown>;
    if (!nonEmptyString(a.status)) errors.push("config.ambient.status must be a non-empty string");
    if (!nonEmptyString(a.evidence)) errors.push("config.ambient.evidence must be a non-empty string");
  }

  if (!(SANDBOX_MODES as readonly string[]).includes(cfg.sandbox as string)) {
    errors.push(`config.sandbox must be one of ${SANDBOX_MODES.join("|")}, got ${JSON.stringify(cfg.sandbox ?? null)}`);
  }
  if (typeof cfg.timeoutMs !== "number" || !Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs <= 0) {
    errors.push("config.timeoutMs must be a positive integer");
  }
  if (!(REPEATS_ALLOWED as readonly number[]).includes(cfg.repeats as 1 | 3)) {
    errors.push(`config.repeats must be one of ${REPEATS_ALLOWED.join("|")}, got ${JSON.stringify(cfg.repeats ?? null)}`);
  }
  if (typeof cfg.interleaveSeed !== "number" || !Number.isInteger(cfg.interleaveSeed) || cfg.interleaveSeed <= 0) {
    errors.push("config.interleaveSeed must be a positive integer");
  }

  if (errors.length > 0) return { errors };
  return {
    config: {
      plan: cfg.plan as string,
      sourceRefs: cfg.sourceRefs as { baseline: string; candidate: string },
      cli: cfg.cli as PrepareConfigInput["cli"],
      requestedModel: (cfg.requestedModel ?? null) as string | null,
      requestedModelReason: (cfg.requestedModelReason ?? null) as string | null,
      observedModel: (cfg.observedModel ?? null) as string | null,
      observedModelReason: (cfg.observedModelReason ?? null) as string | null,
      ambient: cfg.ambient as PrepareConfigInput["ambient"],
      sandbox: cfg.sandbox as SandboxMode,
      timeoutMs: cfg.timeoutMs as number,
      repeats: cfg.repeats as 1 | 3,
      interleaveSeed: cfg.interleaveSeed as number,
    },
    errors,
  };
}

function configHashFields(cfg: PrepareConfigInput) {
  return {
    plan: cfg.plan,
    sourceRefs: cfg.sourceRefs,
    cli: cfg.cli,
    requestedModel: cfg.requestedModel,
    requestedModelReason: cfg.requestedModelReason ?? null,
    observedModel: cfg.observedModel,
    observedModelReason: cfg.observedModelReason ?? null,
    ambient: cfg.ambient,
    sandbox: cfg.sandbox,
    timeoutMs: cfg.timeoutMs,
    repeats: cfg.repeats,
    interleaveSeed: cfg.interleaveSeed,
  };
}

/** sha256 over the runner-owned nonsecret configuration fields only. */
export function computeConfigHash(cfg: PrepareConfigInput): string {
  return sha256Hex(canonicalJson(configHashFields(cfg)));
}

// ---------------------------------------------------------------------------
// Case-set validation
// ---------------------------------------------------------------------------

export function validateCases(
  raw: unknown,
  opts?: { globalSandbox?: SandboxMode },
): { cases?: RawCase[]; errors: string[] } {
  const errors: string[] = [];
  assertType(raw, "object", "cases file", errors);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors };

  const file = raw as Record<string, unknown>;
  if (file.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`cases schemaVersion must be ${MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(file.schemaVersion ?? null)}`);
  }
  if (!Array.isArray(file.cases)) {
    errors.push("cases.cases must be an array");
    return { errors };
  }

  const cases = file.cases as Record<string, unknown>[];
  if (cases.length !== TOTAL_CASES) {
    errors.push(`expected exactly ${TOTAL_CASES} cases, got ${cases.length}`);
  }

  const seenIds = new Set<string>();
  const perRoute = new Map<Route, { dev: number; heldout: number }>();
  const coverageSeen = new Set<string>();
  const smokeTagSeen = new Set<string>();
  let smokeCount = 0;

  cases.forEach((c, index) => {
    const label = `cases[${index}]`;
    assertType(c, "object", label, errors);
    if (!c || typeof c !== "object" || Array.isArray(c)) return;

    const id = c.id;
    if (typeof id !== "string" || !CASE_ID_RE.test(id)) {
      errors.push(`${label}.id must be lowercase kebab-case, got ${JSON.stringify(id ?? null)}`);
    } else if (seenIds.has(id)) {
      errors.push(`duplicate case id: ${id}`);
    } else {
      seenIds.add(id);
    }

    if (!(ROUTES as readonly string[]).includes(c.route as string)) {
      errors.push(`${label}.route unknown: ${JSON.stringify(c.route ?? null)} (expected one of ${ROUTES.join("|")})`);
    }
 // Unknown split rejection (case records carry dev|heldout; smoke is derived).
    if (!(CASE_SPLITS as readonly string[]).includes(c.split as string)) {
      errors.push(`${label}.split unknown: ${JSON.stringify(c.split ?? null)} (expected one of ${CASE_SPLITS.join("|")})`);
    }
    if (c.sandbox !== undefined && !(SANDBOX_MODES as readonly string[]).includes(c.sandbox as string)) {
      errors.push(`${label}.sandbox must be one of ${SANDBOX_MODES.join("|")}, got ${JSON.stringify(c.sandbox ?? null)}`);
    }
    if (!nonEmptyString(c.prompt)) errors.push(`${label}.prompt must be a non-empty string`);
    if (c.resumePrompt !== undefined && !nonEmptyString(c.resumePrompt)) {
      errors.push(`${label}.resumePrompt must be a non-empty string when present`);
    }

    const fixture = c.fixture;
    assertType(fixture, "object", `${label}.fixture`, errors);
    if (fixture && typeof fixture === "object" && !Array.isArray(fixture)) {
      const files = (fixture as Record<string, unknown>).files;
      if (!Array.isArray(files) || files.length === 0) {
        errors.push(`${label}.fixture.files must be a non-empty array`);
      } else {
        files.forEach((f, fi) => {
          const flabel = `${label}.fixture.files[${fi}]`;
          assertType(f, "object", flabel, errors);
          if (!f || typeof f !== "object" || Array.isArray(f)) return;
          const rec = f as Record<string, unknown>;
          if (typeof rec.path !== "string" || !isSafeFixtureRelPath(rec.path)) {
            errors.push(
              `${flabel}.path escapes the fixture root or is not a safe relative path: ${JSON.stringify(rec.path ?? null)}`,
            );
          }
          if (typeof rec.content !== "string") errors.push(`${flabel}.content must be a string`);
        });
      }
    }

    const assertions = c.assertions;
    if (!Array.isArray(assertions) || assertions.length === 0) {
      errors.push(`${label}.assertions must be a non-empty array`);
    } else {
      const assertionIds = new Set<string>();
      let hasWritePaths = false;
      let hasThreadReused = false;
      assertions.forEach((a, ai) => {
        const alabel = `${label}.assertions[${ai}]`;
        assertType(a, "object", alabel, errors);
        if (!a || typeof a !== "object" || Array.isArray(a)) return;
        const rec = a as Record<string, unknown>;
        if (typeof rec.id !== "string" || rec.id === "") errors.push(`${alabel}.id must be a non-empty string`);
        else if (assertionIds.has(rec.id)) errors.push(`${label} duplicate assertion id: ${rec.id}`);
        else assertionIds.add(rec.id);
        if (!(ASSERTION_KINDS as readonly string[]).includes(rec.kind as string)) {
          errors.push(`${alabel}.kind unknown: ${JSON.stringify(rec.kind ?? null)} (expected one of ${ASSERTION_KINDS.join("|")})`);
          return;
        }
        const kind = rec.kind as AssertionKind;
        if (kind === "diff_paths_within") {
          if (
            !Array.isArray(rec.value) ||
            rec.value.some((v) => typeof v !== "string") ||
            (rec.value as unknown[]).some((v) => !isSafeFixtureRelPath(v as string))
          ) {
            errors.push(`${alabel}.value must be an array of safe relative allowed paths`);
          }
 // Only a non-empty allowed-paths set means the case intends writes;
 // an empty set asserts "nothing written" and is valid read-only.
          if (Array.isArray(rec.value) && rec.value.length > 0) hasWritePaths = true;
        } else if (kind === "thread_reused") {
          hasThreadReused = true;
          if (rec.value !== true) errors.push(`${alabel}.value must be true`);
        } else if (kind === "calls_within") {
          if (typeof rec.value !== "number" || !Number.isInteger(rec.value) || rec.value <= 0) {
            errors.push(`${alabel}.value must be a positive integer call limit`);
          }
        } else if (kind === "mutation_withheld") {
          if (rec.value !== true) errors.push(`${alabel}.value must be true`);
        } else if (typeof rec.value !== "string" || rec.value === "") {
          errors.push(`${alabel}.value must be a non-empty string for kind ${kind}`);
        }
      });
      const bounded = (c as Record<string, unknown>).boundedResolution;
      if (bounded !== undefined) {
        if (bounded === null || typeof bounded !== "object" || Array.isArray(bounded)) {
          errors.push(`${label}.boundedResolution must be an object`);
        } else {
          const context = (bounded as Record<string, unknown>).context;
          if (!(RESOLUTION_CONTEXTS as readonly string[]).includes(context as string)) {
            errors.push(`${label}.boundedResolution.context must be one of ${RESOLUTION_CONTEXTS.join("|")}`);
          }
        }
      }
      if (c.resumePrompt !== undefined && !hasThreadReused) {
        errors.push(`${label} has resumePrompt but no thread_reused assertion`);
      }
      if (!c.resumePrompt && hasThreadReused) {
        errors.push(`${label} has thread_reused assertion but no resumePrompt`);
      }
      if (hasWritePaths && (c.sandbox ?? opts?.globalSandbox ?? "read-only") !== "workspace-write") {
        errors.push(
          `${label} asserts writes (diff_paths_within) so its effective sandbox must be workspace-write (case override: ${String(c.sandbox ?? "none")}, global default: read-only)`,
        );
      }
    }

    const provenance = c.provenance;
    assertType(provenance, "object", `${label}.provenance`, errors);
    if (provenance && typeof provenance === "object" && !Array.isArray(provenance)) {
      const p = provenance as Record<string, unknown>;
      if (!nonEmptyString(p.seed) && !nonEmptyString(p.note)) {
        errors.push(`${label}.provenance requires a non-empty seed or note`);
      }
      if (!Array.isArray(p.coverage)) {
        errors.push(`${label}.provenance.coverage must be an array of tags`);
      } else {
        for (const tag of p.coverage as unknown[]) {
          if (typeof tag !== "string") errors.push(`${label}.provenance.coverage tags must be strings`);
          else coverageSeen.add(tag);
        }
      }
      if (p.smoke === true) {
        smokeCount += 1;
        if (c.split !== "dev") errors.push(`${label} is marked smoke but smoke cases must have split "dev"`);
        if (Array.isArray(p.coverage)) {
          for (const tag of SMOKE_REQUIRED_TAGS) {
            if ((p.coverage as string[]).includes(tag)) smokeTagSeen.add(tag);
          }
        }
      }
    }

    if (typeof c.route === "string" && (ROUTES as readonly string[]).includes(c.route)) {
      const bucket = perRoute.get(c.route as Route) ?? { dev: 0, heldout: 0 };
      if (c.split === "dev") bucket.dev += 1;
      else if (c.split === "heldout") bucket.heldout += 1;
      perRoute.set(c.route as Route, bucket);
    }
  });

  if (perRoute.size !== ROUTES.length) {
    errors.push(`expected ${ROUTES.length} routes, saw ${perRoute.size}`);
  }
  for (const route of ROUTES) {
    const bucket = perRoute.get(route);
    if (!bucket) continue;
    if (bucket.dev !== DEV_CASES_PER_ROUTE || bucket.heldout !== HELDOUT_CASES_PER_ROUTE) {
      errors.push(
        `route ${route} must have ${DEV_CASES_PER_ROUTE} dev + ${HELDOUT_CASES_PER_ROUTE} heldout cases, got ${bucket.dev} + ${bucket.heldout}`,
      );
    }
  }
  for (const tag of REQUIRED_COVERAGE_TAGS) {
    if (!coverageSeen.has(tag)) errors.push(`coverage tag ${JSON.stringify(tag)} missing from the frozen case set`);
  }
  if (smokeCount !== SMOKE_CASE_COUNT) {
    errors.push(`expected exactly ${SMOKE_CASE_COUNT} smoke-marked dev cases, got ${smokeCount}`);
  }
  for (const tag of SMOKE_REQUIRED_TAGS) {
    if (!smokeTagSeen.has(tag)) errors.push(`smoke coverage tag ${JSON.stringify(tag)} missing`);
  }

  if (errors.length > 0) return { errors };
  return { cases: cases as unknown as RawCase[], errors: [] };
}

// ---------------------------------------------------------------------------
// Fixture hashing (computed from definitions — no filesystem needed)
// ---------------------------------------------------------------------------

export function computeFixtureHash(caseRaw: RawCase): {
  hash: string;
  files: { path: string; sha256: string }[];
} {
  const files = caseRaw.fixture.files.map((f) => ({ path: f.path, sha256: sha256Hex(f.content) }));
  return { hash: sha256Hex(canonicalJson(files)), files };
}

function preparedCaseIntegrityFields(c: RawCase, fixtureHash: string) {
  return {
    id: c.id,
    route: c.route,
    split: c.split,
    sandbox: c.sandbox ?? null,
    fixtureHash,
    prompt: c.prompt,
    resumePrompt: c.resumePrompt ?? null,
    assertions: c.assertions,
    provenance: c.provenance,
    ...(c.boundedResolution !== undefined ? { boundedResolution: c.boundedResolution } : {}),
  };
}

// ---------------------------------------------------------------------------
// Resolved-manifest validation (structural + closure + heldout digest)
// ---------------------------------------------------------------------------

export async function validateResolvedManifest(
  manifest: EvalManifest,
  readSourceTree: SourceTreeReader,
): Promise<string[]> {
  const errors: string[] = [];

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`manifest schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (!nonEmptyString(manifest.plan)) errors.push("manifest.plan must be a non-empty string");

  for (const arm of ["baseline", "candidate"] as const) {
    const ref = manifest.sourceRefs?.[arm];
    if (typeof ref !== "string" || !FULL_SHA_RE.test(ref)) {
      errors.push(`manifest.sourceRefs.${arm} is a mutable or non-full ref: ${JSON.stringify(ref ?? null)}`);
    }
  }

  const cli = manifest.cli;
  if (!cli || typeof cli !== "object" || !isAbsolute(cli.path ?? "") || !nonEmptyString(cli.version) || !HEX_64_RE.test(cli.helpHash ?? "")) {
    errors.push("manifest.cli must carry {absolute path, version, 64-hex helpHash}");
  }

  for (const field of ["requestedModel", "observedModel"] as const) {
    const reasonField = field === "requestedModel" ? "requestedModelReason" : "observedModelReason";
    if (manifest[field] === null && !nonEmptyString(manifest[reasonField])) {
      errors.push(`manifest.${field} is null and requires a non-empty ${reasonField}`);
    }
    if (manifest[field] !== null && !nonEmptyString(manifest[field])) {
      errors.push(`manifest.${field} must be null or a non-empty string`);
    }
  }

 // configHash is recomputed from manifest fields — tampering with any
 // runner-owned config field breaks the recorded hash.
  const recomputedConfigHash = computeConfigHash({
    plan: manifest.plan,
    sourceRefs: manifest.sourceRefs,
    cli: manifest.cli,
    requestedModel: manifest.requestedModel,
    requestedModelReason: manifest.requestedModelReason,
    observedModel: manifest.observedModel,
    observedModelReason: manifest.observedModelReason,
    ambient: manifest.ambient,
    sandbox: manifest.sandbox,
    timeoutMs: manifest.timeoutMs,
    repeats: manifest.repeats as 1 | 3,
    interleaveSeed: manifest.interleaveSeed,
  });
  if (manifest.configHash !== recomputedConfigHash) {
    errors.push("manifest.configHash does not match the resolved config fields");
  }

 // Variants: fixed ids, closure validated per arm (cross-arm edges rejected).
  const variantIds = manifest.variants?.map((v) => v.id) ?? [];
  const idSet = new Set(variantIds);
  if (variantIds.length !== VARIANT_IDS.length || !VARIANT_IDS.every((id) => idSet.has(id))) {
    errors.push(`manifest.variants must be exactly ${VARIANT_IDS.join("|")}`);
  }

  let baselineTree: SourceTree | undefined;
  let candidateTree: SourceTree | undefined;
  const trees = new Map<string, SourceTree>();
  const refSet = new Set<string>();
  for (const variant of manifest.variants ?? []) {
    if (typeof variant.sourceRef !== "string" || !FULL_SHA_RE.test(variant.sourceRef)) {
      errors.push(`variant ${variant.id} sourceRef is a mutable or non-full ref: ${JSON.stringify(variant.sourceRef ?? null)}`);
      continue;
    }
    refSet.add(variant.sourceRef);
  }
  if (refSet.size > 0 && errors.length === 0) {
    for (const ref of refSet) {
      try {
        trees.set(ref, await readSourceTree(ref));
      } catch (error) {
        errors.push(`failed to read source tree for ${ref}: ${(error as Error).message}`);
      }
    }
  }
  if (manifest.variants) {
    const byId = new Map(manifest.variants.map((v) => [v.id, v]));
    const baseline = byId.get("baseline");
    const candidate = byId.get("candidate");
    const minimal = byId.get("minimal");
    if (baseline && candidate) {
      baselineTree = trees.get(baseline.sourceRef);
      candidateTree = trees.get(candidate.sourceRef);
    }
    if (baseline && candidate && minimal && minimal.sourceRef !== candidate.sourceRef) {
      errors.push("variant minimal must derive from the candidate sourceRef");
    }
    for (const variant of manifest.variants) {
      const closurePaths = new Set<string>();
      let lastPath = "";
      for (const entry of variant.closure ?? []) {
        if (closurePaths.has(entry.path)) errors.push(`variant ${variant.id} duplicate closure path: ${entry.path}`);
        closurePaths.add(entry.path);
        if (entry.path <= lastPath) {
          errors.push(`variant ${variant.id} closure must be sorted by path (violated at ${entry.path})`);
        }
        lastPath = entry.path;
      }
      if (variant.id === "minimal") {
        if ((variant.closure ?? []).length !== 0) {
          errors.push("variant minimal must have an empty closure (shared ambient harness only)");
        }
        continue;
      }
      if (!baselineTree || !candidateTree) continue;
      const own = variant.id === "baseline" ? baselineTree : candidateTree;
      const other = variant.id === "baseline" ? candidateTree : baselineTree;
      const otherId = variant.id === "baseline" ? "candidate" : "baseline";
      for (const entry of variant.closure ?? []) {
        const ownHash = own[entry.path];
        const otherHash = other[entry.path];
        if (ownHash === undefined) {
          if (otherHash === entry.sha256) {
            errors.push(
              `variant ${variant.id} closure cross-arm closure edge: ${entry.path} is resolved from the ${otherId} arm`,
            );
          } else {
            errors.push(`variant ${variant.id} closure path not present in its own source ref: ${entry.path}`);
          }
        } else if (ownHash !== entry.sha256) {
          if (otherHash === entry.sha256) {
            errors.push(
              `variant ${variant.id} closure cross-arm closure edge: hash for ${entry.path} belongs to the ${otherId} arm`,
            );
          } else {
            errors.push(`variant ${variant.id} closure stale hash for ${entry.path}`);
          }
        }
      }
    }
  }

 // Case records: distribution and per-case integrity structure.
  const cases = manifest.cases ?? [];
  if (cases.length !== TOTAL_CASES) errors.push(`manifest.cases must contain ${TOTAL_CASES} cases, got ${cases.length}`);
  const perRoute = new Map<Route, { dev: number; heldout: number }>();
  let smokeCount = 0;
  for (const c of cases) {
    if (!(CASE_SPLITS as readonly string[]).includes(c.split)) {
      errors.push(`case ${c.id} split unknown: ${JSON.stringify(c.split)}`);
      continue;
    }
    const bucket = perRoute.get(c.route) ?? { dev: 0, heldout: 0 };
    if (c.split === "dev") bucket.dev += 1;
    else bucket.heldout += 1;
    perRoute.set(c.route, bucket);
    if (c.provenance?.smoke === true) smokeCount += 1;
    if (!HEX_64_RE.test(c.integrityHash ?? "")) errors.push(`case ${c.id} integrityHash must be 64-hex`);
    if (!HEX_64_RE.test(c.fixture?.hash ?? "")) errors.push(`case ${c.id} fixture.hash must be 64-hex`);
  }
  for (const route of ROUTES) {
    const bucket = perRoute.get(route);
    if (bucket && (bucket.dev !== DEV_CASES_PER_ROUTE || bucket.heldout !== HELDOUT_CASES_PER_ROUTE)) {
      errors.push(`route ${route} distribution must be ${DEV_CASES_PER_ROUTE} dev + ${HELDOUT_CASES_PER_ROUTE} heldout`);
    }
  }
  if (smokeCount !== SMOKE_CASE_COUNT) errors.push(`manifest must carry exactly ${SMOKE_CASE_COUNT} smoke cases, got ${smokeCount}`);

 // Heldout digest is recomputed from manifest fields — versioned before tuning.
  const heldoutPairs = cases
    .filter((c) => c.split === "heldout")
    .map((c) => ({ id: c.id, integrityHash: c.integrityHash }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const recomputedHeldoutDigest = sha256Hex(canonicalJson(heldoutPairs));
  if (manifest.heldoutDigest !== recomputedHeldoutDigest) {
    errors.push("manifest.heldoutDigest does not match the heldout case integrity hashes");
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Output-dir safety (all writes must stay inside the disposable fixture root)
// ---------------------------------------------------------------------------

export function validateOutDirShape(outDir: string, repoRoot: string): { resolved?: string; fixtureRoot: string; errors: string[] } {
  const errors: string[] = [];
  const fixtureRoot = resolve(repoRoot, FIXTURE_ROOT_SEGMENT);
  const resolvedOut = resolve(repoRoot, outDir);
  const rel = relative(fixtureRoot, resolvedOut);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    errors.push(
      `unsafe output target ${resolvedOut}: writes must stay strictly inside the disposable fixture root ${fixtureRoot} (${FIXTURE_ROOT_SEGMENT}) and never inside a real checkout`,
    );
  }
  return { resolved: errors.length === 0 ? resolvedOut : undefined, fixtureRoot, errors };
}

function assertRealpathInside(outDir: string, fixtureRoot: string, io: Io): string[] {
  const errors: string[] = [];
 // Walk both target and fixture root up to their nearest existing ancestor,
 // then resolve symlinks; a symlinked ancestor escaping the fixture root is
 // rejected. Walking (instead of requiring existence) lets every stage run
 // this check BEFORE creating anything, so a rejected request writes nothing.
  const ancestor = nearestExistingAncestor(outDir, io);
  const fixtureAncestor = nearestExistingAncestor(fixtureRoot, io);
  if (ancestor === null || fixtureAncestor === null) {
    errors.push(`cannot resolve fixture root containment for ${outDir}`);
    return errors;
  }
  let realAncestor: string;
  let realFixtureRoot: string;
  try {
    realAncestor = io.realpath(ancestor);
    realFixtureRoot = io.realpath(fixtureAncestor);
  } catch (error) {
    errors.push(`realpath failed while checking output containment: ${(error as Error).message}`);
    return errors;
  }
  const rel = relative(realFixtureRoot, realAncestor);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    errors.push(
      `symlink escape rejected: ${outDir} resolves to ${realAncestor}, outside the disposable fixture root ${realFixtureRoot}`,
    );
  }
  return errors;
}

/** Nearest existing ancestor of a path (the filesystem root counts as existing). */
function nearestExistingAncestor(target: string, io: Io): string | null {
  let current = resolve(target);
  for (;;) {
    const parent = resolve(current, "..");
    if (parent === current) return current; // filesystem root
    if (io.exists(current)) return current;
    current = parent;
  }
}

/**
 * C-W2: shared disposable-root write containment for EVERY stage
 * that writes under a run dir (prepare / run / report). The target must be
 * strictly inside `<repoRoot>/.tmp/skill-eval/` (shape check) with no symlink
 * ancestor escaping it (realpath check). Performs no filesystem writes, so a
 * rejection leaves the tree untouched.
 */
export function disposableRootContainmentErrors(
  targetDir: string,
  repoRoot: string,
  io: Io,
): { fixtureRoot: string; resolved: string | undefined; errors: string[] } {
  const shape = validateOutDirShape(targetDir, repoRoot);
  if (shape.errors.length > 0 || shape.resolved === undefined) {
    return { fixtureRoot: shape.fixtureRoot, resolved: undefined, errors: shape.errors };
  }
  return {
    fixtureRoot: shape.fixtureRoot,
    resolved: shape.resolved,
    errors: assertRealpathInside(shape.resolved, shape.fixtureRoot, io),
  };
}

/**
 * Derive the repo root for a path that must live under a disposable
 * `<repoRoot>/.tmp/skill-eval/` root (run/report stages receive only a
 * manifest path). Returns null when no such ancestor segment exists.
 */
export function deriveDisposableRepoRoot(descendantPath: string): string | null {
  let dir = resolve(descendantPath);
  for (;;) {
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
    if (basename(dir) === "skill-eval" && basename(resolve(dir, "..")) === ".tmp") {
      return resolve(dir, "..", "..");
    }
  }
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

export interface PrepareArgs {
  configPath: string;
  casesPath: string;
  outDir: string;
  repoRoot: string;
  io?: Io;
  readSourceTree?: SourceTreeReader;
 /** Every subprocess (including read-only git) must flow through this seam. */
  exec?: ExecArgv;
}

/**
 * prepare: validate config + frozen case set, resolve the immutable manifest,
 * materialize fixtures — zero model calls. Exit 0 on success; exit 2 with
 * nothing written on any validation failure.
 */
export async function prepareManifest(args: PrepareArgs): Promise<PrepareResult> {
  const io = args.io ?? nodeIo;
  const readSourceTree =
    args.readSourceTree ?? makeGitSourceTreeReader(args.repoRoot, args.exec ?? defaultExecArgv);

  const fail = (errors: string[]): PrepareResult => ({ exit: 2 as const, errors });

 // -- Phase A: read + validate inputs (no writes) -------------------------
  let configRaw: unknown;
  try {
    configRaw = JSON.parse(io.readText(args.configPath));
  } catch (error) {
    return fail([`cannot read config ${args.configPath}: ${(error as Error).message}`]);
  }
  const { config, errors: configErrors } = validateConfig(configRaw);

  let casesRaw: unknown;
  let casesText = "";
  try {
    casesText = io.readText(args.casesPath);
    casesRaw = JSON.parse(casesText);
  } catch (error) {
    return fail(configErrors.concat([`cannot read cases ${args.casesPath}: ${(error as Error).message}`]));
  }
  const { cases, errors: caseErrors } = validateCases(casesRaw, { globalSandbox: config?.sandbox });

  const earlyErrors = configErrors.concat(caseErrors);
  if (earlyErrors.length > 0 || !config || !cases) return fail(earlyErrors);

 // -- Phase B: resolve trees + build manifest (no writes) -----------------
  const trees = new Map<string, SourceTree>();
  for (const arm of ["baseline", "candidate"] as const) {
    try {
      trees.set(config.sourceRefs[arm], await readSourceTree(config.sourceRefs[arm]));
    } catch (error) {
      return fail([`prepare could not read ${arm} source tree at ${config.sourceRefs[arm]}: ${(error as Error).message}`]);
    }
  }
  const baselineTree = trees.get(config.sourceRefs.baseline)!;
  const candidateTree = trees.get(config.sourceRefs.candidate)!;
  const toClosure = (tree: SourceTree) =>
    Object.keys(tree)
      .sort()
      .map((path) => ({ path, sha256: tree[path] }));

  const preparedCases: PreparedManifestCase[] = cases.map((c) => {
    const fixture = computeFixtureHash(c);
    const sandbox = c.sandbox ?? config.sandbox;
    const integrityHash = sha256Hex(
      canonicalJson(preparedCaseIntegrityFields({ ...c, sandbox }, fixture.hash)),
    );
    return {
      id: c.id,
      route: c.route,
      split: c.split,
      fixture,
      prompt: c.prompt,
      ...(c.resumePrompt !== undefined ? { resumePrompt: c.resumePrompt } : {}),
      assertions: c.assertions,
      provenance: c.provenance,
      sandbox,
      ...(c.boundedResolution !== undefined ? { boundedResolution: c.boundedResolution } : {}),
      integrityHash,
    };
  });

  const manifest: EvalManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    plan: config.plan,
    sourceRefs: config.sourceRefs,
    cli: config.cli,
    requestedModel: config.requestedModel,
    requestedModelReason: config.requestedModelReason ?? null,
    observedModel: config.observedModel,
    observedModelReason: config.observedModelReason ?? null,
    configHash: computeConfigHash(config),
    casesHash: sha256Hex(casesText),
    ambient: config.ambient,
    variants: [
      { id: "baseline", sourceRef: config.sourceRefs.baseline, closure: toClosure(baselineTree) },
      { id: "candidate", sourceRef: config.sourceRefs.candidate, closure: toClosure(candidateTree) },
      { id: "minimal", sourceRef: config.sourceRefs.candidate, closure: [] },
    ],
    cases: preparedCases,
    sandbox: config.sandbox,
    timeoutMs: config.timeoutMs,
    repeats: config.repeats,
    interleaveSeed: config.interleaveSeed,
    heldoutDigest: sha256Hex(
      canonicalJson(
        preparedCases
          .filter((c) => c.split === "heldout")
          .map((c) => ({ id: c.id, integrityHash: c.integrityHash }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      ),
    ),
  };

  const resolvedErrors = await validateResolvedManifest(manifest, readSourceTree);
  if (resolvedErrors.length > 0) return fail(resolvedErrors);

 // -- Phase C: output safety, then (only now) writes ----------------------
 // Containment (shape + realpath/symlink walk) completes BEFORE any mkdir:
 // a rejected prepare creates nothing, not even the gitignored fixture root
 // (the previous ensureDir-before-check ordering could create the
 // disposable root directory on rejection).
  const { resolved, fixtureRoot, errors: outErrors } = validateOutDirShape(args.outDir, args.repoRoot);
  if (outErrors.length > 0 || resolved === undefined) return fail(outErrors);

  const containmentErrors = assertRealpathInside(resolved, fixtureRoot, io);
  if (containmentErrors.length > 0) return fail(containmentErrors);

  io.ensureDir(fixtureRoot);
  io.ensureDir(resolved);
  for (const c of preparedCases) {
    const caseDir = join(resolved, "fixtures", c.id);
    for (const file of c.fixture.files) {
      const target = join(caseDir, file.path);
 // Re-check every materialized path against the case fixture directory.
      const rel = relative(caseDir, target);
      if (rel.startsWith("..") || isAbsolute(rel) || !isSafeFixtureRelPath(file.path)) {
        return fail([`case ${c.id}: fixture path ${JSON.stringify(file.path)} escapes the fixture directory`]);
      }
      io.ensureDir(resolve(target, ".."));
      io.writeText(target, cases.find((raw) => raw.id === c.id)!.fixture.files.find((f) => f.path === file.path)!.content);
    }
  }

  const manifestPath = join(resolved, "manifest.json");
  io.writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { exit: 0, manifest, manifestPath, errors: [] };
}

