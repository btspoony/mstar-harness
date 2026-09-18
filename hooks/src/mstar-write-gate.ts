// Morning Star harness — ZCode PreToolUse(Write|Edit) coordination-write gate.
// Engine-backed Gate 1 for the ZCode host: blocks hard-enforced writes to the
// three v3 harness coordination documents (root status.json, workflow
// snapshots, project registers) through the SAME classification + validation
// path the omp gate uses — the `gates` module of `@mstar-harness/engine`,
// inlined into this file at build (see scripts/build-zcode-hooks.ts).
//
// Issue/catalog authority paths (issue-governance cutover G4b) are decided
// BEFORE the document path and are NOT governed by `enforcement: hard`
// (authority invariant, not document validity — omp/OpenCode refuse the same
// two classes unconditionally): a `{HARNESS_DIR}/store.db` (`-wal`/`-shm`)
// write is refused (`store.direct-write-refused`), and a project register is
// routed through the DB-aware authority check — refused as
// `project.register.retired` while the issue store is the active findings
// authority, refused as `store.authority-unavailable` when that authority
// cannot be read at all (below-floor runtime / missing `node:sqlite`
// capability / corrupt / drifted / busy), and shape-validated only while no
// store or a staged store leaves the register the live authority (issue
// contract §7: before activation new findings still go to the register). The
// runtime floor is read from the ACTUAL runtime (engine `detectStoreRuntime`
// — the Bun global first, never Bun's emulated `process.versions.node`) and
// asserted in-process: this hook is spawned as native `node`, so it needs the
// NODE floor (>=24.18.0) while a Bun-run entrypoint needs the Bun floor —
// never both. Nothing is acquired for a write that is not store-backed: the
// store is only touched from the register route.
//
// Block dialect (contract D4): exit code 2 with the reason on STDERR — ZCode
// parses hook stdout under a strict schema where any extra key silently
// discards the deny (invisible fail-open); the exit-code channel has no
// schema to violate. Stdout stays empty in every case. Pass is exit 0 with
// no output. Soft mode stays a SILENT pass (omp Gate-1 parity).
//
// Fail-open everywhere except deliberate hard-mode blocks (contract D5):
// unparseable stdin, missing fields, unknown tools, unreadable fs, oversized
// content, and any unexpected internal error exit 0 without output. Invalid
// JSON in write content is NOT a silent pass — it is a `status.invalid-json`
// violation that can block under hard enforcement. The whole gate body is
// wrapped in a catch-all so the hook never wedges a session.
//
// Opt out for a session with MSTAR_WRITE_GATE=off (checked first, mirroring
// MSTAR_BRANCH_GUARD=off in git-guard.mjs). Source-side literals stay pure
// ASCII (lint-ascii-literals covers hooks/src) — bun build re-normalizes
// \uXXXX string escapes to raw UTF-8 in the bundle, and the hook executes
// under node, which decodes them correctly (bundle smoke renders the case).

import { readFileSync, statSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  MAX_STATUS_CONTENT_LENGTH,
  assertStoreRuntimeSupported,
  detectStoreRuntime,
  formatStatusWriteBlockReason,
  harnessDocKindOfTarget,
  queryDashboard,
  resolveHarnessDir,
  resolveProjectDir,
  resolveRepoEnforcement,
  resolveWorkflowDir,
  validateStatusWriteDoc,
  violationLine,
  withStoreRead,
} from "@mstar-harness/engine";
import type { StoreRuntimeInfo, ValidationResult } from "@mstar-harness/engine";

const SKILL_POINTER = "skill: mstar-artifacts/references/status-and-residuals.md";
const ENFORCEMENT_LINE =
  "Enforcement: hard \u2014 this repo opts in via .mstarc/compass; disable for this session with MSTAR_WRITE_GATE=off.";
const AUTHORITY_LINE =
  "Authority invariant (not the enforcement flag) \u2014 the issue/catalog authority is not hand-writable; disable for this session with MSTAR_WRITE_GATE=off.";

// ---------------------------------------------------------------------------
// G4b — issue/catalog authority paths (store.db + retired registers)
// ---------------------------------------------------------------------------

/** The authority database and its WAL sidecars, directly at a harness root. */
const STORE_DB_FILE = "store.db";
const STORE_AUTHORITY_FILES: readonly string[] = [STORE_DB_FILE, `${STORE_DB_FILE}-wal`, `${STORE_DB_FILE}-shm`];

/** Default v2 layout dirs of a marker-complete harness root. */
const STATUS_FILE = "status.json";
const WORKFLOW_DIR_NAME = "workflows";
const PROJECT_DIR_NAME = "projects";

/** Refusal codes, in the frozen store / `project.register.*` vocabulary. */
const STORE_DIRECT_WRITE_CODE = "store.direct-write-refused";
const STORE_AUTHORITY_UNAVAILABLE_CODE = "store.authority-unavailable";
const REGISTER_RETIRED_CODE = "project.register.retired";

/** A store whose absence positively identifies the PRE-activation state
 * (legacy register authority in force, issue contract §7): missing
 * (`store.not-initialized`) or staged (`store.not-active`). Every other
 * refusal leaves the authority state UNKNOWN and is refused (dsh G4a
 * `catalogRegistrationRefusal` exclusion list, mirrored). */
const PRE_ACTIVATION_CODES: readonly string[] = ["store.not-initialized", "store.not-active"];

/**
 * Actual-runtime probe seam (test-injectable): the default reads the ACTUAL
 * runtime through the engine — the Bun global first, so a Bun process is
 * never judged by Bun's EMULATED `process.versions.node` (Bun 1.4.0 reports
 * "26.3.0" there, which would pass a naive Node-floor check while the store's
 * floor is Bun >=1.4.0). Native `node` therefore gets the Node floor and a
 * Bun-run hook bundle the Bun floor — the invoked entrypoint's own runtime.
 */
export const storeRuntimeProbe: { info: () => StoreRuntimeInfo } = { info: detectStoreRuntime };

/** Stable code + message of a thrown refusal (engine `StoreError` /
 * `StoreReadError` carry `code`; anything else is reported as itself). */
function refusalOf(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  return { code: code === "" ? "store.authority-unreadable" : code, message };
}

/** What the issue store says about a register target (G4b): `retired` =
 * active store (the register is migration history), `legacy` = no store /
 * staged store (pre-activation, the register is still the live authority),
 * `unavailable` = the authority could not be read and the write fails closed.
 * One read envelope (`withStoreRead` + the `issues` view: no projection
 * refresh, no source I/O) is the whole probe. */
type AuthorityRoute =
  | { kind: "legacy" }
  | { kind: "retired"; storeRevision: number }
  | { kind: "unavailable"; code: string; message: string };

async function readAuthorityRoute(harnessDir: string): Promise<AuthorityRoute> {
  try {
    assertStoreRuntimeSupported(storeRuntimeProbe.info());
  } catch (error) {
    return { kind: "unavailable", ...refusalOf(error) };
  }
  try {
    const envelope = await withStoreRead({ harnessDir }, queryDashboard("issues", { limit: 1 }));
    return { kind: "retired", storeRevision: envelope.storeRevision };
  } catch (error) {
    const refusal = refusalOf(error);
    return PRE_ACTIVATION_CODES.includes(refusal.code)
      ? { kind: "legacy" }
      : { kind: "unavailable", ...refusal };
  }
}

/** Directory/entry check (never throws — a missing or unreadable path is
 * simply not a marker). */
function hasEntry(dir: string, name: string): boolean {
  try {
    statSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/** True when `dir` itself is a harness root: the v2 coordination-document
 * markers the gates classify with (`status.json` + the layout dirs, custom
 * `.mstarc` dirs honored), or the root the engine resolves from the
 * directory's PARENT (default `.mstar`-style and `.mstarc harness_dir`
 * roots — `resolveHarnessDir(dir)` probes *inside* a directory, so it never
 * answers for the root itself). */
function isHarnessRootDir(dir: string): boolean {
  if (hasEntry(dir, STATUS_FILE)) {
    if (hasEntry(dir, WORKFLOW_DIR_NAME) && hasEntry(dir, PROJECT_DIR_NAME)) return true;
    try {
      if (
        hasEntry(resolveWorkflowDir(dir, { harnessDir: dir }), "") &&
        hasEntry(resolveProjectDir(dir, { harnessDir: dir }), "")
      ) {
        return true;
      }
    } catch {
      // unreadable layout config — fall through to the parent resolution
    }
  }
  const parentResolved = resolveHarnessDir(dirname(dir));
  return parentResolved !== null && resolve(parentResolved) === dir;
}

/** True when the target IS the authority database (or a WAL sidecar) sitting
 * directly at a harness root: the runtime's own store location for a harness
 * root is `<harness root>/store.db`, and hand-writing those bytes is never a
 * supported operation — hard vs soft, staged vs active, all the same. */
function isStoreAuthorityTarget(rawPath: string): boolean {
  const resolved = resolve(rawPath);
  if (!STORE_AUTHORITY_FILES.includes(basename(resolved))) return false;
  return isHarnessRootDir(dirname(resolved));
}

/** One authority refusal as the contract's violation line (same
 * `[severity] code: message (fix: …)` + skill-pointer dialect as the engine
 * violations — only the third stderr line differs, naming the authority
 * invariant instead of `enforcement: hard`). */
function authorityViolation(code: string, message: string): ValidationResult {
  return { ok: false, severity: "high", code, message };
}

function storeDirectWriteRefusal(targetPath: string): ValidationResult {
  return authorityViolation(
    STORE_DIRECT_WRITE_CODE,
    `${targetPath} is the issue/catalog authority database and is owned by the runtime \u2014 a direct hand write ` +
      "is refused (the schema and its WAL are managed in-process). Schema changes go through `mstar store " +
      "init|upgrade|migrate`, findings through `mstar issue add|close`, catalog rows through `mstar catalog " +
      "register|update`",
  );
}

function registerRetiredRefusal(storeRevision: number): ValidationResult {
  return authorityViolation(
    REGISTER_RETIRED_CODE,
    "project registers are retired migration history \u2014 the issue store ({HARNESS_DIR}/store.db, revision " +
      `${storeRevision}) is the only findings authority; capture and close through \`mstar plan ` +
      "issue-add|issue-close` (plan-scoped) or `mstar issue add|close` (unscoped). This write is refused",
  );
}

function authorityUnavailableRefusal(route: { code: string; message: string }): ValidationResult {
  return authorityViolation(
    STORE_AUTHORITY_UNAVAILABLE_CODE,
    `the issue authority could not be read ([${route.code}] ${route.message}) \u2014 the register write is refused ` +
      "rather than applied against an unreadable authority; no older-runtime or JSON fallback exists",
  );
}

/** Exit 2 with the contract's stderr shape: block header, violation lines,
 * and the authority line. `writeSync` on fd 2 keeps the reason intact across
 * `process.exit` (async buffering loses it on some platforms). */
function blockAuthorityWrite(toolName: string, display: string, violations: ValidationResult[]): never {
  writeSync(2, `[Morning Star write gate] blocked ${toolName} to ${display}\n`);
  for (const violation of violations) writeSync(2, `${violationLine(violation)} (${SKILL_POINTER})\n`);
  writeSync(2, `${AUTHORITY_LINE}\n`);
  process.exit(2);
}

// Bounds (failure matrix row 7): per-target cost is bounded by local reads +
// the 2 MB guards; the target COUNT is bounded here — a hostile envelope
// carrying a huge paths[] skips the overflow silently (fail-open) instead of
// accumulating fs probes toward the 10 s hook timeout.
const MAX_GATED_TARGETS = 32;

/** Display-safe path text: control characters (which the engine's `[^/]+`
 * canonical-rel patterns admit) are hex-escaped so the stderr block header
 * stays one line and cannot forge violation-looking lines. */
function displaySafe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** The block header's target text: harness-relative when the target sits
 * inside its harness root, otherwise the absolute path (display-safe). */
function displayTarget(targetPath: string, harnessDir: string): string {
  const rel = relative(harnessDir, targetPath);
  return displaySafe(rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : targetPath);
}

function readStdinJson(): Record<string, unknown> {
  try {
    // Tolerant stdin read (house style, git-guard.mjs): empty or
    // unparseable stdin is an empty envelope; a closed fd 0 throws and is
    // treated the same way.
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Target paths from a ZCode Write/Edit `tool_input` (contract D3 union):
 * non-empty string `file_path`, non-empty string `path`, and each
 * non-empty string element of `paths[]`. Unknown extra keys are ignored and
 * never manufacture targets; nothing here can throw. The result is capped
 * at MAX_GATED_TARGETS — overflow targets skip gating silently (fail-open).
 */
function writeTargetPaths(toolInput: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim() !== "") paths.push(value);
  };
  push(toolInput.file_path);
  push(toolInput.path);
  if (Array.isArray(toolInput.paths)) {
    for (const value of toolInput.paths) push(value);
  }
  return paths.slice(0, MAX_GATED_TARGETS);
}

/**
 * Deterministic post-edit reconstruction: an Edit payload with non-empty
 * `old_string` + `new_string` (and no `content`) is validated against the
 * RECONSTRUCTED result instead of the pre-edit on-disk state — a corrupting
 * deterministic edit can no longer pass hard enforcement. Deterministic =
 * `old_string` occurs exactly once (replace that occurrence), or
 * `replace_all: true` with >= 1 occurrence (replace all). Anything else —
 * missing/empty pieces, 0 matches, >1 match without `replace_all`, an
 * oversized target (fallback keeps the read budget bounded), read/replace
 * errors — returns undefined and the gate falls back to the pre-edit
 * validation. Best-effort by contract: never throws, never widens the gate.
 */
function reconstructEditContent(tool: Record<string, unknown>, targetPath: string): string | undefined {
  try {
    if (tool.content !== undefined) return undefined; // content-bearing payloads take the content path upstream
    const oldString = tool.old_string;
    const newString = tool.new_string;
    if (typeof oldString !== "string" || oldString === "") return undefined;
    if (typeof newString !== "string" || newString === "") return undefined;
    if (statSync(targetPath).size > MAX_STATUS_CONTENT_LENGTH) return undefined; // oversized: bounded fallback (violates there when opted in)
    const current = readFileSync(targetPath, "utf8");
    const first = current.indexOf(oldString);
    if (first === -1) return undefined; // 0 matches — not deterministic
    const replaceAll = tool.replace_all === true;
    if (!replaceAll && current.indexOf(oldString, first + 1) !== -1) return undefined; // ambiguous
    if (replaceAll) return current.split(oldString).join(newString);
    return current.slice(0, first) + newString + current.slice(first + oldString.length);
  } catch {
    return undefined; // any error — pre-edit fallback path (fail-open)
  }
}

const input = readStdinJson();
try {
  if (process.env.MSTAR_WRITE_GATE === "off") process.exit(0);

  // `hook_event_name` is intentionally unkeyed: the hooks.json matcher
  // already scopes the event to PreToolUse; this re-check is defense-in-depth.
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (toolName !== "Write" && toolName !== "Edit") process.exit(0);

  const toolInput = input.tool_input;
  if (typeof toolInput !== "object" || toolInput === null) process.exit(0);
  const tool = toolInput as Record<string, unknown>;

  // Relative targets resolve against the event cwd, falling back to the
  // hook process cwd (git-guard.mjs:153 precedent — the hook process cwd is
  // not necessarily the workspace).
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();

  // Known limitations (beyond the failure-matrix rows): classification is
  // textual — a symlink alias whose textual path sits outside the harness
  // tree bypasses the gate (no target realpath; omp parity). Edits validate
  // the reconstructed post-edit content when the payload is deterministic
  // (unique old_string match, or replace_all), otherwise the PRE-edit
  // on-disk state — a non-deterministic corrupting edit surfaces on the
  // next write, and repairing an already-invalid gated doc requires a
  // deterministic edit or a full-content Write. Oversized gated docs (past
  // the 2 MiB budget) violate on this host — repair out of band or for
  // this session with MSTAR_WRITE_GATE=off.
  for (const rawPath of writeTargetPaths(tool)) {
    const targetPath = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);

    // G4b — authority paths first: the store database is never hand-writable,
    // and a register target is decided by the DB-aware authority route rather
    // than by its document shape. Both refuse unconditionally (the enforcement
    // flag governs document validity, not the authority invariant).
    if (isStoreAuthorityTarget(targetPath)) {
      blockAuthorityWrite(toolName, displayTarget(targetPath, dirname(targetPath)), [
        storeDirectWriteRefusal(targetPath),
      ]);
    }

    const target = harnessDocKindOfTarget(targetPath);
    if (target === null) continue; // not a gated coordination write — silent pass

    if (target.kind === "register") {
      const route = await readAuthorityRoute(target.harnessDir);
      if (route.kind === "retired") {
        blockAuthorityWrite(toolName, displayTarget(targetPath, target.harnessDir), [
          registerRetiredRefusal(route.storeRevision),
        ]);
      }
      if (route.kind === "unavailable") {
        blockAuthorityWrite(toolName, displayTarget(targetPath, target.harnessDir), [
          authorityUnavailableRefusal(route),
        ]);
      }
      // `legacy`: pre-activation (no store / staged store) — the register is
      // still the live authority, so its document validator decides below.
    }

    // `content` as a string is the new document; anything else (including
    // new_string/old_string edits and ApplyPatch shapes) validates the
    // on-disk file — a nonexistent target passes (fresh-scaffold parity).
    // Deterministic edits (unique old_string match, or replace_all) validate
    // the RECONSTRUCTED post-edit content; ambiguous or erroring
    // reconstruction falls back to the pre-edit on-disk state.
    const content = typeof tool.content === "string" ? tool.content : reconstructEditContent(tool, targetPath) ?? tool.content;
    // Oversized writes are a violation on this host (exit-2 under hard,
    // silent under soft) instead of a permission — omp keeps the default
    // silent pass.
    const violations = validateStatusWriteDoc(content, targetPath, target.kind, { oversized: "violate" });
    if (violations.length === 0) continue;

    const enforcement = resolveRepoEnforcement(target.harnessDir);
    if (!enforcement.hard) continue; // soft mode — silent pass (omp Gate-1 parity)

    const display = displayTarget(targetPath, target.harnessDir);
    // writeSync on fd 2: the block reason MUST survive process.exit —
    // process.stderr.write buffers asynchronously on some platforms.
    writeSync(2, `[Morning Star write gate] blocked ${toolName} to ${display}\n`);
    writeSync(2, `${formatStatusWriteBlockReason(violations, SKILL_POINTER)}\n`);
    writeSync(2, `${ENFORCEMENT_LINE}\n`);
    process.exit(2);
  }
} catch {
  // internal error — pass silently; the gate never manufactures a block
  // from data it could not read, and never wedges the session
}
process.exit(0);
