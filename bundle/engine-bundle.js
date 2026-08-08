// packages/engine/src/core.ts
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var SEVERITY_ORDER = ["critical", "high", "medium", "low", "nit"];
function applyEnforcement(gate, opts) {
  return { ...gate, hardBlocked: opts.hard && gate.violations.length > 0 };
}
function readJson(filePath) {
  if (!existsSync(filePath))
    return {};
  const content = readFileSync(filePath, "utf8").trim();
  if (!content)
    return {};
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}
function writeJson(filePath, value) {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}
`, "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}
function resolveProjectRoot(startDir = process.cwd()) {
  const start = resolve(startDir);
  let dir = start;
  for (;; ) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, "bun.lock")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir)
      return start;
    dir = parent;
  }
}
function findRootPackageJson(startDir) {
  let dir = startDir;
  for (;; ) {
    const candidate = resolve(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"));
      if (pkg.name === "morning-star")
        return candidate;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}
function harnessVersionFrom(moduleDir) {
  const ownManifest = join(moduleDir, "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(ownManifest, "utf8"));
    if (typeof pkg.version === "string" && pkg.version !== "")
      return pkg.version;
  } catch {}
  const root = findRootPackageJson(moduleDir);
  if (!root)
    return "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(root, "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
function readHarnessVersion() {
  return harnessVersionFrom(dirname(fileURLToPath(import.meta.url)));
}
// packages/engine/src/path.ts
import { mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, statSync } from "node:fs";
import { basename as basename2, dirname as dirname2, isAbsolute, join as join2, relative, resolve as resolve2 } from "node:path";
function resolveHarnessDir(startDir = process.cwd(), opts = {}) {
  const start = resolve2(startDir);
  const explicit = opts.harnessDir ?? process.env.MSTAR_HARNESS_DIR;
  if (explicit)
    return resolve2(start, explicit);
  let dir = start;
  for (;; ) {
    for (const candidate of [join2(dir, ".mstar"), join2(dir, ".agents"), join2(dir, ".plans"), join2(dir, "plans")]) {
      if (isDirectory(candidate))
        return candidate;
    }
    const parent = dirname2(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}
function resolveSpecsDir(harnessDir, opts = {}) {
  const harness = resolve2(harnessDir);
  const repoRoot = dirname2(harness);
  const candidates = [
    join2(harness, "specs"),
    join2(repoRoot, "docs", "specs"),
    join2(repoRoot, "specs"),
    join2(harness, "designs"),
    join2(repoRoot, "designs")
  ];
  for (const candidate of candidates) {
    if (isDirectory(candidate) && hasFiles(candidate))
      return candidate;
  }
  const fallback = join2(harness, "specs");
  if (opts.create !== false)
    mkdirSync2(fallback, { recursive: true });
  return fallback;
}
function resolvePlanDir(harnessDir) {
  const dir = resolve2(harnessDir);
  const name = basename2(dir);
  if (name === ".plans" || name === "plans")
    return dir;
  return join2(dir, "plans");
}
function assertSafePathComponent(value, what) {
  if (value === "" || value === "." || value === ".." || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${what} must be a single safe path component ([A-Za-z0-9._-]+; not "", ".", "..", or containing "/" or "\\") — got ${JSON.stringify(value)}`);
  }
}
function resolveSddDir(harnessDir, planId) {
  assertSafePathComponent(planId, "planId");
  return join2(resolve2(harnessDir), "sdd", planId);
}
function resolveIterationDir(harnessDir) {
  return join2(resolve2(harnessDir), "iterations");
}
var EMPTY_STATUS_TEMPLATE = {
  version: 1,
  updated_at: "1970-01-01",
  plans: [],
  residual_findings: {},
  metadata: {}
};
var SCAFFOLD_DIRS = ["plans", "iterations", "knowledge", "specs", "sdd"];
function scaffoldHarness(root) {
  const harnessDir = join2(resolve2(root), ".mstar");
  for (const dir of SCAFFOLD_DIRS)
    mkdirSync2(join2(harnessDir, dir), { recursive: true });
  const statusPath = join2(harnessDir, "status.json");
  if (Object.keys(readJson(statusPath)).length === 0)
    writeJson(statusPath, EMPTY_STATUS_TEMPLATE);
  return harnessDir;
}
var GITIGNORE_SNIPPET = `# Morning Star harness (.mstar/)
# Principle: process stays local; results are shared with the team.
# Ignored (process / coordination):
.mstar/archived/
.mstar/iterations/
.mstar/plans/
.mstar/sdd/
.mstar/notes.json
.mstar/status.json
# Tracked (results): .mstar/AGENTS.md, .mstar/knowledge/, .mstar/specs/
`;
var GITIGNORE_SNIPPET_AGENTS = `# Morning Star harness (.agents/) — legacy
.agents/archived/
.agents/iterations/
.agents/plans/
.agents/sdd/
.agents/notes.json
.agents/status.json
# Tracked (results): .agents/AGENTS.md, .agents/knowledge/, .agents/specs/
`;
var GITIGNORE_PROCESS_ENTRIES = GITIGNORE_SNIPPET.split(`
`).filter((line) => line.startsWith(".mstar/")).map((line) => line.trim());
var GITIGNORE_PROCESS_ENTRIES_AGENTS = GITIGNORE_SNIPPET_AGENTS.split(`
`).filter((line) => line.startsWith(".agents/")).map((line) => line.trim());
function emitGitignoreSnippet(kind) {
  if (kind === "agents")
    return GITIGNORE_SNIPPET_AGENTS;
  if (kind === "mstar")
    return GITIGNORE_SNIPPET;
  return `${GITIGNORE_SNIPPET}${GITIGNORE_SNIPPET_AGENTS}`;
}
function validateGitignore(root) {
  const gitignorePath = join2(resolve2(root), ".gitignore");
  const kind = detectHarnessKind(resolveHarnessDir(root));
  let content;
  try {
    content = readFileSync2(gitignorePath, "utf8");
  } catch {
    return {
      ok: false,
      severity: "medium",
      code: "gitignore.missing",
      message: `no .gitignore found at ${gitignorePath}`,
      fix: `append the canonical snippet (emitGitignoreSnippet(${kind ? `"${kind}"` : ""})) to ${gitignorePath}`
    };
  }
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0));
  const mstarMissing = GITIGNORE_PROCESS_ENTRIES.filter((entry) => !lines.has(entry));
  const agentsMissing = GITIGNORE_PROCESS_ENTRIES_AGENTS.filter((entry) => !lines.has(entry));
  let missing;
  let label;
  if (kind === "agents") {
    missing = agentsMissing;
    label = ".agents/ set";
  } else if (kind === "mstar") {
    missing = mstarMissing;
    label = ".mstar/ set";
  } else {
    label = "either .mstar/ or .agents/ set";
    missing = mstarMissing.length === 0 || agentsMissing.length === 0 ? [] : mstarMissing.length <= agentsMissing.length ? mstarMissing : agentsMissing;
  }
  if (missing.length > 0) {
    return {
      ok: false,
      severity: "medium",
      code: "gitignore.missing-entries",
      message: `.gitignore at ${gitignorePath} is missing canonical harness ignore entries (${label}): ${missing.join(", ")}`,
      fix: `append the canonical snippet (emitGitignoreSnippet(${kind ? `"${kind}"` : ""})) to ${gitignorePath}`
    };
  }
  return {
    ok: true,
    severity: "low",
    code: "gitignore.ok",
    message: `.gitignore at ${gitignorePath} contains a complete canonical harness process-artifact ignore set (${label})`
  };
}
function detectHarnessKind(harnessDir) {
  if (!harnessDir)
    return null;
  const name = basename2(resolve2(harnessDir));
  if (name === ".mstar")
    return "mstar";
  if (name === ".agents")
    return "agents";
  return null;
}
function assertPlanWritingPath(planPath, harnessDir) {
  const planAbs = resolve2(planPath);
  if (!harnessDir) {
    return {
      ok: false,
      severity: "high",
      code: "plan-path.no-harness",
      message: `persistent plan tracking is not enabled — cannot place plan ${planAbs} under {PLAN_DIR}`,
      fix: "initialize the harness (scaffoldHarness) so plans land in {PLAN_DIR}"
    };
  }
  const planDir = resolvePlanDir(harnessDir);
  const rel = relative(planDir, planAbs);
  const inside = rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
  if (!inside) {
    return {
      ok: false,
      severity: "high",
      code: "plan-path.outside-plan-dir",
      message: `plan file ${planAbs} is outside {PLAN_DIR} (${planDir})`,
      fix: `write the plan under ${planDir}`
    };
  }
  return {
    ok: true,
    severity: "low",
    code: "plan-path.ok",
    message: `plan file ${planAbs} lives under {PLAN_DIR} (${planDir})`
  };
}
function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
function hasFiles(dir) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (hasFiles(join2(dir, entry.name)))
          return true;
      } else if (entry.isFile()) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
// packages/engine/src/status.ts
import { existsSync as existsSync2, readFileSync as readFileSync3, readdirSync as readdirSync2 } from "node:fs";
import { join as join4, resolve as resolve4 } from "node:path";

// packages/engine/src/lease.ts
import { mkdirSync as mkdirSync3, rmdirSync, statSync as statSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname3, isAbsolute as isAbsolute2, join as join3, resolve as resolve3 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function violation(severity, code, message, fix) {
  return { ok: false, severity, code, message, fix };
}
function validateNonEmptyString(violations, value, field, missingCode, invalidCode) {
  if (value === undefined) {
    violations.push(violation("high", missingCode, `missing required field: ${field}`));
  } else if (typeof value !== "string" || value.trim() === "") {
    violations.push(violation("medium", invalidCode, `${field} must be a non-empty string`));
  }
}
var DATE_PART = String.raw`\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])`;
var RFC3339_Z_RE = new RegExp(String.raw`^${DATE_PART}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`);
var DATE_ONLY_RE = new RegExp(String.raw`^${DATE_PART}$`);
function isValidClaimedAt(value) {
  return typeof value === "string" && (RFC3339_Z_RE.test(value) || DATE_ONLY_RE.test(value));
}
function validateExecutionLease(lease) {
  const violations = [];
  if (!isPlainObject(lease)) {
    return {
      ok: false,
      violations: [
        violation("high", "lease.execution-lease.invalid", "execution_lease must be an object — null and tombstone objects are invalid; writers delete the key on release")
      ]
    };
  }
  validateNonEmptyString(violations, lease.holder, "holder", "lease.execution-lease.missing-holder", "lease.execution-lease.invalid-holder");
  if (lease.claimed_at === undefined) {
    violations.push(violation("high", "lease.execution-lease.missing-claimed-at", "missing required field: claimed_at"));
  } else if (!isValidClaimedAt(lease.claimed_at)) {
    violations.push(violation("medium", "lease.execution-lease.invalid-claimed-at", "claimed_at must be an RFC 3339 UTC timestamp with explicit Z (e.g. 2026-07-22T02:30:00Z) or a YYYY-MM-DD date"));
  }
  if (lease.worktree_path === undefined) {
    violations.push(violation("high", "lease.execution-lease.missing-worktree-path", "missing required field: worktree_path"));
  } else if (typeof lease.worktree_path !== "string" || lease.worktree_path.trim() === "") {
    violations.push(violation("medium", "lease.execution-lease.invalid-worktree-path", "worktree_path must be a non-empty string"));
  } else if (!isAbsolute2(lease.worktree_path)) {
    violations.push(violation("medium", "lease.execution-lease.invalid-worktree-path", "worktree_path must be an absolute path — it identifies the dedicated feature-worktree root (and MUST differ from metadata.control_worktree_path)"));
  }
  validateNonEmptyString(violations, lease.working_branch, "working_branch", "lease.execution-lease.missing-working-branch", "lease.execution-lease.invalid-working-branch");
  if (lease.session_label !== undefined && typeof lease.session_label !== "string") {
    violations.push(violation("medium", "lease.execution-lease.invalid-session-label", "session_label must be a string (display only — never used for ownership comparison)"));
  }
  return { ok: violations.length === 0, violations };
}
function validateIntegrationMergeLease(lease) {
  const violations = [];
  if (!isPlainObject(lease)) {
    return {
      ok: false,
      violations: [
        violation("high", "lease.merge-lease.invalid", "integration_merge_lease must be an object — absent means unclaimed; null and tombstone objects are invalid; writers delete the key on release")
      ]
    };
  }
  validateNonEmptyString(violations, lease.holder, "holder", "lease.merge-lease.missing-holder", "lease.merge-lease.invalid-holder");
  if (lease.claimed_at === undefined) {
    violations.push(violation("high", "lease.merge-lease.missing-claimed-at", "missing required field: claimed_at"));
  } else if (!isValidClaimedAt(lease.claimed_at)) {
    violations.push(violation("medium", "lease.merge-lease.invalid-claimed-at", "claimed_at must be an RFC 3339 UTC timestamp with explicit Z (e.g. 2026-07-22T04:00:00Z) or a YYYY-MM-DD date"));
  }
  validateNonEmptyString(violations, lease.plan_id, "plan_id", "lease.merge-lease.missing-plan-id", "lease.merge-lease.invalid-plan-id");
  validateNonEmptyString(violations, lease.source_branch, "source_branch", "lease.merge-lease.missing-source-branch", "lease.merge-lease.invalid-source-branch");
  validateNonEmptyString(violations, lease.target_branch, "target_branch", "lease.merge-lease.missing-target-branch", "lease.merge-lease.invalid-target-branch");
  if (lease.session_label !== undefined && typeof lease.session_label !== "string") {
    violations.push(violation("medium", "lease.merge-lease.invalid-session-label", "session_label must be a string (display only — never used for ownership comparison)"));
  }
  return { ok: violations.length === 0, violations };
}
function claimLease(row, holder, fields) {
  const lease = row.execution_lease;
  if (lease !== undefined) {
    if (!isPlainObject(lease)) {
      return {
        ok: false,
        row,
        violations: [
          violation("high", "lease.claim.tombstone", "execution_lease must be an object — null and tombstone objects are invalid; resolve the corrupt state before claiming")
        ]
      };
    }
    if (lease.holder !== holder) {
      return {
        ok: false,
        row,
        violations: [
          violation("high", "lease.claim.other-holder", `execution_lease held by ${JSON.stringify(lease.holder)} — no timestamp makes it stealable; Blocked unless the current-turn user explicitly overrides (then audit plans[].notes)`)
        ]
      };
    }
    if (lease.worktree_path !== fields.worktree_path || lease.working_branch !== fields.working_branch) {
      return {
        ok: false,
        row,
        violations: [
          violation("high", "lease.claim.verify-held-lease", `same holder but lease ${lease.worktree_path} @ ${lease.working_branch} does not match the Assignment ${fields.worktree_path} @ ${fields.working_branch} — verify-held-lease failed`)
        ]
      };
    }
    return { ok: true, row, outcome: "resumed", violations: [] };
  }
  if (row.status === "InProgress") {
    return {
      ok: false,
      row,
      violations: [
        violation("high", "lease.claim.orphan", "plan is InProgress without an execution_lease — orphan: STOP, no writable dispatch until recovery (status-and-residuals.md § Orphan recovery); do not invent a lease")
      ]
    };
  }
  if (row.status !== "Todo" && row.status !== "Blocked") {
    return {
      ok: false,
      row,
      violations: [
        violation("high", "lease.claim.status", `claim requires status Todo or Blocked (got ${JSON.stringify(row.status)}) — claim-before-InProgress contract`)
      ]
    };
  }
  const claimed = {
    holder,
    claimed_at: new Date().toISOString(),
    worktree_path: fields.worktree_path,
    working_branch: fields.working_branch,
    ...fields.session_label !== undefined ? { session_label: fields.session_label } : {}
  };
  const gate = validateExecutionLease(claimed);
  if (!gate.ok) {
    return { ok: false, row, violations: gate.violations };
  }
  return { ok: true, row: { ...row, status: "InProgress", execution_lease: claimed }, outcome: "claimed", violations: [] };
}
function releaseLease(row, holder) {
  if (row.execution_lease === undefined) {
    return { ok: true, row, outcome: "released", violations: [] };
  }
  if (!isPlainObject(row.execution_lease)) {
    return {
      ok: false,
      row,
      violations: [
        violation("high", "lease.release.tombstone", "execution_lease must be an object — null and tombstone objects are invalid; resolve the corrupt state before releasing")
      ]
    };
  }
  if (row.execution_lease.holder !== holder) {
    return {
      ok: false,
      row,
      violations: [
        violation("high", "lease.release.other-holder", `execution_lease held by ${JSON.stringify(row.execution_lease.holder)} — release requires the same-session holder; a different holder must Blocked (no timestamp makes it stealable)`)
      ]
    };
  }
  const { execution_lease: _dropped, ...rest } = row;
  return { ok: true, row: rest, outcome: "released", violations: [] };
}
function sameHolderResume(lease, holder) {
  return isPlainObject(lease) && lease.holder === holder;
}
function canSteal(lease, holder, opts = {}) {
  if (!isPlainObject(lease) || lease.holder === holder)
    return false;
  return opts.userOverride === true;
}
function planExecutionLeaseLocations(row) {
  const meta = row.metadata;
  const metadataLease = meta && typeof meta === "object" && !Array.isArray(meta) ? meta.execution_lease : undefined;
  return { row: row.execution_lease, metadata: metadataLease };
}
function verifyPlanExecutionLease(row, planId) {
  const { row: rowLease, metadata: metadataLease } = planExecutionLeaseLocations(row);
  const lease = rowLease !== undefined ? rowLease : metadataLease;
  if (lease === undefined) {
    if (row.status === "InProgress") {
      return {
        ok: false,
        violations: [
          violation("high", "lease.verify.orphan", "plan is InProgress without an execution_lease — orphan: STOP, no writable dispatch until recovery (status-and-residuals.md § Orphan recovery)")
        ]
      };
    }
    return {
      ok: false,
      violations: [
        violation("high", "lease.verify.missing", `plan ${planId} has no execution_lease (neither plans[].execution_lease nor legacy plans[].metadata.execution_lease)`)
      ]
    };
  }
  const violations = [];
  if (rowLease !== undefined && metadataLease !== undefined) {
    violations.push(violation("high", "lease.verify.dual-write", "execution_lease present in BOTH plans[].execution_lease (SSOT) and plans[].metadata.execution_lease — the row-level lease wins; delete the metadata copy to remove the dual write"));
  } else if (rowLease === undefined) {
    violations.push(violation("high", "lease.verify.non-ssot-location", "execution_lease found only under plans[].metadata.execution_lease — the SSOT location is plans[].execution_lease; the metadata location is a legacy/hand-written read-compat fallback, not equivalent to SSOT success (migrate the lease to the plan row)"));
  }
  violations.push(...validateExecutionLease(lease).violations);
  return { ok: violations.length === 0, violations, lease };
}
var STATUS_WRITE_LOCKDIR = ".status-write.lockdir";
var LOCKDIR_HOLDER_PID = "holder.pid";
var heldLockDirs = new AsyncLocalStorage;
async function withStatusWriteLock(statusPath, fn, opts = {}) {
  const lockDir = join3(dirname3(resolve3(statusPath)), STATUS_WRITE_LOCKDIR);
  const held = heldLockDirs.getStore();
  if (held !== undefined && held.has(lockDir)) {
    throw new Error(`${lockDir} is already held by this process in this async context — withStatusWriteLock is not reentrant; a nested acquisition on the same status.json is a bug`);
  }
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pollMs = opts.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let acquired = null;
  for (;; ) {
    try {
      mkdirSync3(lockDir);
      const st = statSync2(lockDir);
      acquired = { dev: st.dev, ino: st.ino };
      break;
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      if (Date.now() >= deadline) {
        throw new Error(`${lockDir} already exists — another writer holds the status write lock; Blocked (same-host exclusive lock; status-and-residuals.md § Same-host exclusive write lock). ` + `Recovery: remove ${lockDir} if no writer is alive (holder.pid inside names the acquiring process)`);
      }
      await sleep(pollMs);
    }
  }
  try {
    writeFileSync2(join3(lockDir, LOCKDIR_HOLDER_PID), String(process.pid), "utf8");
  } catch {}
  const owns = held ?? new Set;
  owns.add(lockDir);
  try {
    return await heldLockDirs.run(owns, fn);
  } finally {
    owns.delete(lockDir);
    try {
      const current = statSync2(lockDir);
      if (acquired !== null && current.dev === acquired.dev && current.ino === acquired.ino) {
        try {
          unlinkSync2(join3(lockDir, LOCKDIR_HOLDER_PID));
        } catch {}
        rmdirSync(lockDir);
      }
    } catch {}
  }
}

// packages/engine/src/dispatch.ts
var BRANCH_FORMS_HINT = '"Working branch: <existing>" | "Working branch: create <new> from <base>" | "Branch policy: direct on <branch> — <reason>"';
var REQUIRED_FIELDS = [
  { key: "executeAs", label: "Execute as", code: "execute-as" },
  { key: "delegation", label: "Delegation", code: "delegation" },
  { key: "taskCategory", label: "Task category", code: "task-category" }
];
function violation2(severity, code, message, fix) {
  return { ok: false, severity, code, message, fix };
}
function parseAssignmentFields(assignmentText) {
  const fields = {};
  for (const line of assignmentText.split(/\r?\n/)) {
    const match = line.match(/^[ \t]*(?:[-*][ \t]+)?\*\*\s*([^*:]+?)\s*\*\*\s*:\s*(.*)$/) ?? line.match(/^[ \t]*(?:[-*][ \t]+)?([A-Za-z][A-Za-z -]*?)\s*:\s*(.*)$/);
    if (!match)
      continue;
    const label = match[1].trim();
    const value = match[2].trim();
    const known = REQUIRED_FIELDS.find((f) => f.label === label);
    if (known) {
      fields[known.key] = value;
      continue;
    }
    if (label === "Working branch")
      fields.workingBranch = value;
    else if (label === "Branch policy")
      fields.branchPolicy = value;
  }
  return fields;
}
var ASSIGNMENT_ENFORCEMENT_BOLD_RE = /^[ \t]*(?:[-*][ \t]+)?\*\*\s*Enforcement\s*\*\*\s*:\s*(.*)$/m;
var ASSIGNMENT_ENFORCEMENT_PLAIN_RE = /^[ \t]*(?:[-*][ \t]+)?Enforcement\s*:\s*(.*)$/m;
var COMPASS_ENFORCEMENT_RE = /^enforcement\s*:\s*(.*)$/m;
function enforcementValue(raw) {
  const value = raw.trim();
  const unquoted = value.replace(/^(['"])(.*)\1$/, "$2");
  return unquoted.trim().toLowerCase();
}
var ASSIGNMENT_BODY_START_RE = /^(?:#{1,6}[ \t]+Task\b|-{3,}[ \t]*$|#[ \t])/m;
function assignmentHeaderRegion(assignmentText) {
  const marker = assignmentText.match(ASSIGNMENT_BODY_START_RE);
  return marker !== null ? assignmentText.slice(0, marker.index) : assignmentText;
}
function parseEnforcementFlag(text) {
  const bold = text.match(ASSIGNMENT_ENFORCEMENT_BOLD_RE);
  if (bold !== null)
    return { hard: enforcementValue(bold[1]) === "hard", source: "assignment" };
  const plain = text.match(ASSIGNMENT_ENFORCEMENT_PLAIN_RE);
  if (plain !== null)
    return { hard: enforcementValue(plain[1]) === "hard", source: "assignment" };
  const compass = text.match(COMPASS_ENFORCEMENT_RE);
  if (compass !== null)
    return { hard: enforcementValue(compass[1]) === "hard", source: "compass" };
  return { hard: false, source: "none" };
}
function requireField(violations, value, label, code) {
  if (value === undefined) {
    const v = violation2("high", `assignment.field.missing-${code}`, `missing required Assignment field: ${label}`, `add "**${label}**: <value>" to the Assignment`);
    v.aliases = [`assignment.presence.missing-${code}`];
    violations.push(v);
  } else if (value === "") {
    const v = violation2("high", `assignment.field.invalid-${code}`, `${label} must be non-empty`, `fill in "**${label}**: <value>"`);
    v.aliases = [`assignment.presence.missing-${code}`];
    violations.push(v);
  }
}
function parseWorkingBranchValue(value) {
  if (value === "")
    return {};
  const create = value.match(/^create\s+(\S+)(?:\s+from\s+(\S+))?$/i);
  if (create)
    return { createForm: { name: create[1], base: create[2] } };
  const danglingFrom = value.match(/^create\s+(\S+)\s+from$/i);
  if (danglingFrom)
    return { createForm: { name: danglingFrom[1], base: "" } };
  const missingName = value.match(/^create\s+from\s+(\S+)$/i);
  if (missingName)
    return { createForm: { name: "", base: missingName[1] } };
  return { workingBranch: value.split(/\s+/)[0] };
}
function parseAssignmentBranchForms(assignmentText) {
  const fields = parseAssignmentFields(assignmentText);
  const forms = {};
  if (fields.workingBranch !== undefined && fields.workingBranch !== "") {
    const parsed = parseWorkingBranchValue(fields.workingBranch);
    if (parsed.createForm !== undefined)
      forms.createForm = parsed.createForm;
    else
      forms.workingBranch = parsed.workingBranch;
  }
  if (fields.branchPolicy !== undefined && fields.branchPolicy !== "") {
    const direct = fields.branchPolicy.match(/^direct\s+on\s+(\S+)/i);
    if (direct) {
      const strict = fields.branchPolicy.match(/^direct\s+on\s+(\S+)(?:\s*(?:[—–]|--|-)\s*(.+))?$/);
      forms.directOn = { branch: direct[1].trim(), reason: strict ? (strict[2] ?? "").trim() : "" };
    }
  }
  return forms;
}
function parseBranchPolicyDirectOnBranch(assignmentText) {
  const directOn = parseAssignmentBranchForms(assignmentText).directOn;
  return directOn !== undefined && directOn.reason !== "" ? directOn.branch : undefined;
}
function isReadOnlyAssignmentRole(roleId) {
  const role = roleId.trim().toLowerCase();
  return role === "scout" || role === "explore";
}
function validateAssignmentFields(assignmentText, opts = {}) {
  const violations = [];
  const fields = parseAssignmentFields(assignmentText);
  const writable = opts.writable !== false;
  for (const { key, label, code } of REQUIRED_FIELDS) {
    requireField(violations, fields[key], label, code);
  }
  if (writable) {
    const workingPresent = fields.workingBranch !== undefined && fields.workingBranch !== "";
    const policyPresent = fields.branchPolicy !== undefined && fields.branchPolicy !== "";
    const formCount = Number(workingPresent) + Number(policyPresent);
    const forms = parseAssignmentBranchForms(assignmentText);
    if (formCount === 0) {
      violations.push(violation2("high", "assignment.field.branch-missing", "writable assignment must contain exactly one branch form", `add exactly one of: ${BRANCH_FORMS_HINT}`));
    } else if (formCount > 1) {
      violations.push(violation2("high", "assignment.field.branch-multiple", `writable assignment contains ${formCount} branch forms (Working branch + Branch policy) — exactly one required`, `keep exactly one of: ${BRANCH_FORMS_HINT}`));
    } else if (workingPresent) {
      const create = forms.createForm;
      if (create !== undefined && (create.base === undefined || create.base.trim() === "" || create.name.trim() === "")) {
        violations.push(violation2("high", "assignment.field.branch-missing-base", `create-form Working branch is incomplete: "${fields.workingBranch}" (expected "create <new-branch> from <base>")`, "write both the new branch name and the ancestor branch after `from` (main / existing feature branch / remote-tracking branch / `current`)"));
      }
    } else if (policyPresent) {
      const direct = forms.directOn;
      if (direct === undefined) {
        violations.push(violation2("high", "assignment.field.branch-policy-missing-branch", `unparseable Branch policy: "${fields.branchPolicy}" (expected "direct on <branch> — <reason>")`, "start the field with `direct on <branch>`"));
      } else if (direct.reason === "") {
        violations.push(violation2("high", "assignment.field.branch-policy-missing-reason", `Branch policy "direct on ${direct.branch}" is missing the reason`, 'append "— <reason>" after the branch name'));
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
function assertDefaultBranchProtected(branch, opts = {}) {
  const defaultBranches = opts.defaultBranches ?? ["main", "master"];
  const violations = [];
  const normalized = branch.trim();
  if (normalized !== "" && defaultBranches.includes(normalized) && opts.directOnException !== true) {
    violations.push(violation2("high", "dispatch.default-branch.protected", `writable work on default protected branch "${normalized}" requires an explicit direct-on exception`, `add "Branch policy: direct on ${normalized} — <reason>" to the Assignment, or use a feature branch`));
  }
  return { ok: violations.length === 0, violations };
}
function executionModeToN(executionMode, opts = {}) {
  const violations = [];
  const mode = executionMode.trim().toLowerCase().split(/\s+/)[0] ?? "";
  let n;
  if (mode === "") {
    violations.push(violation2("high", "dispatch.execution-mode.missing", "missing required Assignment field: Execution mode", 'add "**Execution mode**: sdd | inline | targeted"'));
  } else if (mode === "sdd") {
    n = 3;
  } else if (mode === "inline") {
    n = 1;
  } else if (mode === "targeted") {
    const seats = [...new Set((opts.seats ?? []).map((s) => s.trim()).filter((s) => s !== ""))];
    if (seats.length === 0) {
      violations.push(violation2("high", "dispatch.execution-mode.missing-seats", 'execution mode "targeted" requires listed reviewer seats', 'add "QC re-review: targeted — reviewers: <role-id>, …" to the Assignment and pass the seats'));
    } else if (seats.length > 3) {
      violations.push(violation2("high", "dispatch.execution-mode.too-many-seats", `execution mode "targeted" lists ${seats.length} reviewer seats — at most 3 (targeted re-review seats are the tri seats, N = 1–3)`, "list at most three reviewer seats for the targeted re-review"));
    } else {
      n = seats.length;
    }
  } else {
    violations.push(violation2("high", "dispatch.execution-mode.unknown", `unknown execution mode "${executionMode.trim()}" (expected sdd | inline | targeted)`, "fix the Execution mode field"));
  }
  return n === undefined ? { ok: false, violations } : { ok: true, violations, n };
}
function assertTriIdentity(reviewerRoles) {
  const tri = ["qc-specialist", "qc-specialist-2", "qc-specialist-3"];
  const roles = reviewerRoles.map((r) => r.trim().toLowerCase()).filter((r) => r !== "");
  const valid = roles.length === tri.length && new Set(roles).size === tri.length && roles.every((r) => tri.includes(r));
  if (valid)
    return { ok: true, violations: [] };
  const got = roles.length > 0 ? roles.join(", ") : "(none)";
  return {
    ok: false,
    violations: [
      violation2("high", "dispatch.tri-identity.invalid", `tri-review initial wave must be exactly qc-specialist / qc-specialist-2 / qc-specialist-3, got: ${got}`, "dispatch qc-specialist, qc-specialist-2 and qc-specialist-3 for the initial wave")
    ]
  };
}
function antiRecursionPrecheck(subagentType, executeAs) {
  const binding = subagentType.trim().toLowerCase();
  const role = executeAs.trim().toLowerCase();
  if (binding !== "" && binding === role) {
    return {
      ok: false,
      violations: [
        violation2("critical", "dispatch.anti-recursion.self-type", `recursive dispatch refused: role binding "${subagentType}" equals Execute as "${executeAs}" (leaf executors must not re-invoke their own role)`, "complete the work in this session, or return Blocked to project-manager")
      ]
    };
  }
  return { ok: true, violations: [] };
}

// packages/engine/src/status.ts
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var PLAN_STATUSES = ["Todo", "InProgress", "InReview", "Blocked", "Done"];
var RESIDUAL_DECISIONS = ["defer", "accept", "risk-accepted"];
var RESIDUAL_LIFECYCLES = ["open", "resolved", "waived", "superseded", "duplicate"];
var ROLLUP_FIELDS = ["total_open", "by_severity", "by_target", "by_plan"];
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function violation3(severity, code, message, fix) {
  return { ok: false, severity, code, message, fix };
}
function todayString() {
  const now = new Date;
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
function normalizeSeverity(value) {
  if (value === "warning")
    return "low";
  if (value === null || value === "")
    return "medium";
  return value;
}
function isOpenResidual(entry) {
  const lifecycle = entry.lifecycle;
  const effective = lifecycle === false || lifecycle === null || lifecycle === undefined ? "open" : lifecycle;
  return effective === "open";
}
function validateNonEmptyString2(violations, value, field, missingCode, invalidCode) {
  if (value === undefined) {
    violations.push(violation3("high", missingCode, `missing required field: ${field}`));
  } else if (typeof value !== "string" || value.trim() === "") {
    violations.push(violation3("medium", invalidCode, `${field} must be a non-empty string`));
  }
}
function validatePlanRow(row) {
  const violations = [];
  if (!isPlainObject2(row)) {
    return { ok: false, violations: [violation3("high", "status.plan-row.invalid", "plan row must be an object")] };
  }
  const { id, plan_id: planId, title, file, status, metadata, execution_lease } = row;
  if (id === undefined && planId === undefined) {
    violations.push(violation3("high", "status.plan-row.missing-id", "missing required field: id (or legacy plan_id)"));
  } else {
    if (id !== undefined) {
      validateNonEmptyString2(violations, id, "id", "status.plan-row.missing-id", "status.plan-row.invalid-id");
    }
    if (planId !== undefined) {
      validateNonEmptyString2(violations, planId, "plan_id", "status.plan-row.missing-plan-id", "status.plan-row.invalid-plan-id");
    }
    if (id !== undefined && planId !== undefined && id !== planId) {
      violations.push(violation3("medium", "status.plan-row.dual-id", "row has both id and plan_id with different values — write one canonical key (prefer id)"));
    }
  }
  validateNonEmptyString2(violations, title, "title", "status.plan-row.missing-title", "status.plan-row.invalid-title");
  validateNonEmptyString2(violations, file, "file", "status.plan-row.missing-file", "status.plan-row.invalid-file");
  if (status === undefined) {
    violations.push(violation3("high", "status.plan-row.missing-status", "missing required field: status"));
  } else if (typeof status !== "string" || !PLAN_STATUSES.includes(status)) {
    violations.push(violation3("medium", "status.plan-row.invalid-status", `status must be one of ${PLAN_STATUSES.join(" | ")} — got ${JSON.stringify(status)}`));
  }
  if (metadata !== undefined && !isPlainObject2(metadata)) {
    violations.push(violation3("medium", "status.plan-row.invalid-metadata", "metadata must be an object"));
  }
  if (execution_lease !== undefined && !isPlainObject2(execution_lease)) {
    violations.push(violation3("medium", "status.plan-row.invalid-execution-lease", "execution_lease must be an object"));
  }
  if (status === "Done" && execution_lease !== undefined) {
    violations.push(violation3("medium", "status.plan-row.done-with-lease", 'plan status Done must not carry an execution_lease — the Done authority deletes the lease in the same complete-file update as status: "Done" (status-and-residuals.md § Hold, release, and override)', 'delete plans[].execution_lease in the same update that sets status: "Done"'));
  }
  return { ok: violations.length === 0, violations };
}
function validateResidual(entry) {
  const violations = [];
  if (!isPlainObject2(entry)) {
    return { ok: false, violations: [violation3("high", "status.residual.invalid", "residual entry must be an object")] };
  }
  const { id, title, severity, source, scope, decision, owner, target, tracking, detail_doc, lifecycle, closed_at } = entry;
  validateNonEmptyString2(violations, id, "id", "status.residual.missing-id", "status.residual.invalid-id");
  validateNonEmptyString2(violations, title, "title", "status.residual.missing-title", "status.residual.invalid-title");
  validateNonEmptyString2(violations, source, "source", "status.residual.missing-source", "status.residual.invalid-source");
  validateNonEmptyString2(violations, scope, "scope", "status.residual.missing-scope", "status.residual.invalid-scope");
  validateNonEmptyString2(violations, owner, "owner", "status.residual.missing-owner", "status.residual.invalid-owner");
  if (severity === undefined) {
    violations.push(violation3("high", "status.residual.missing-severity", "missing required field: severity"));
  } else if (typeof severity !== "string" || !SEVERITY_ORDER.includes(severity) && severity !== "warning") {
    violations.push(violation3("medium", "status.residual.invalid-severity", `severity must be one of ${SEVERITY_ORDER.join(" | ")} — got ${JSON.stringify(severity)}`));
  } else if (severity === "warning") {
    violations.push(violation3("low", "status.residual.legacy-warning", `severity "warning" is legacy — forbidden on new entries; read paths normalize it to "low"`, `use "low" (normalizeSeverity maps 'warning' → 'low')`));
  }
  if (decision === undefined) {
    violations.push(violation3("high", "status.residual.missing-decision", "missing required field: decision"));
  } else if (typeof decision !== "string" || !RESIDUAL_DECISIONS.includes(decision)) {
    violations.push(violation3("medium", "status.residual.invalid-decision", `decision must be one of ${RESIDUAL_DECISIONS.join(" | ")} — got ${JSON.stringify(decision)}`));
  }
  if (target === undefined) {
    violations.push(violation3("high", "status.residual.missing-target", "missing required field: target"));
  } else if (typeof target !== "string" && target !== null) {
    violations.push(violation3("medium", "status.residual.invalid-target", "target must be a string or null"));
  }
  if (tracking === undefined) {
    violations.push(violation3("high", "status.residual.missing-tracking", "missing required field: tracking"));
  } else if (typeof tracking !== "string" && tracking !== null) {
    violations.push(violation3("medium", "status.residual.invalid-tracking", "tracking must be a string or null"));
  }
  if (detail_doc !== undefined && typeof detail_doc !== "string" && detail_doc !== null) {
    violations.push(violation3("medium", "status.residual.invalid-detail-doc", "detail_doc must be a string or null"));
  }
  if (closed_at !== undefined && (typeof closed_at !== "string" || !DATE_RE.test(closed_at))) {
    violations.push(violation3("medium", "status.residual.invalid-closed-at", "closed_at must be YYYY-MM-DD"));
  }
  if (lifecycle !== undefined) {
    if (typeof lifecycle !== "string" || !RESIDUAL_LIFECYCLES.includes(lifecycle)) {
      violations.push(violation3("medium", "status.residual.invalid-lifecycle", `lifecycle must be one of ${RESIDUAL_LIFECYCLES.join(" | ")} — got ${JSON.stringify(lifecycle)}`));
    } else if (lifecycle !== "open") {
      if (closed_at === undefined) {
        violations.push(violation3("high", "status.residual.closed-missing-closed-at", `lifecycle "${lifecycle}" requires closed_at (YYYY-MM-DD)`, 'set closed_at (e.g. "2026-08-08")'));
      }
      if (entry.closure_note === undefined) {
        violations.push(violation3("medium", "status.residual.closed-missing-closure-note", `lifecycle "${lifecycle}" requires closure_note (what changed; how verified)`, "add closure_note explaining the close"));
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
function validateStatus(docOrPath) {
  let doc;
  if (typeof docOrPath === "string") {
    try {
      doc = readJson(docOrPath);
    } catch (error) {
      return {
        ok: false,
        violations: [violation3("high", "status.invalid-json", error.message)]
      };
    }
  } else {
    doc = docOrPath;
  }
  const violations = [];
  const { version, updated_at, plans, residual_findings, metadata } = doc;
  if (version === undefined) {
    violations.push(violation3("high", "status.missing-version", "missing required field: version"));
  } else if (typeof version !== "number" || !Number.isInteger(version)) {
    violations.push(violation3("high", "status.invalid-version", "version must be an integer"));
  } else if (version !== 1) {
    violations.push(violation3("medium", "status.unsupported-version", `unsupported status.json schema version ${version} — expected 1`));
  }
  if (updated_at === undefined) {
    violations.push(violation3("high", "status.missing-updated-at", "missing required field: updated_at"));
  } else if (typeof updated_at !== "string" || !DATE_RE.test(updated_at)) {
    violations.push(violation3("medium", "status.invalid-updated-at", "updated_at must be YYYY-MM-DD"));
  }
  if (plans === undefined) {
    violations.push(violation3("high", "status.missing-plans", "missing required field: plans"));
  } else if (!Array.isArray(plans)) {
    violations.push(violation3("high", "status.invalid-plans", "plans must be an array"));
  } else {
    for (const row of plans) {
      violations.push(...validatePlanRow(row).violations);
    }
  }
  if (residual_findings === undefined) {
    violations.push(violation3("high", "status.missing-residual-findings", "missing required field: residual_findings (root-only canonical)"));
  } else if (!isPlainObject2(residual_findings)) {
    violations.push(violation3("high", "status.invalid-residual-findings", "residual_findings must be an object at root"));
  } else {
    for (const [planId, list] of Object.entries(residual_findings)) {
      if (!Array.isArray(list)) {
        violations.push(violation3("high", "status.residual.invalid-list", `residual_findings["${planId}"] must be an array`));
      } else if (list.length === 0) {
        violations.push(violation3("low", "status.residual.empty-key", `residual_findings["${planId}"] is empty — delete the key (no "plan-id": [])`));
      } else {
        for (const entry of list) {
          violations.push(...validateResidual(entry).violations);
        }
      }
    }
  }
  if (metadata === undefined) {
    violations.push(violation3("high", "status.missing-metadata", "missing required field: metadata"));
  } else if (!isPlainObject2(metadata)) {
    violations.push(violation3("high", "status.invalid-metadata", "metadata must be an object"));
  } else if (Object.prototype.hasOwnProperty.call(metadata, "residual_findings")) {
    violations.push(violation3("medium", "status.dual-write-residuals", "residual_findings must be root-only — metadata.residual_findings is legacy read-only; remove it (no dual-write)", "move entries to root residual_findings and delete metadata.residual_findings"));
  }
  return { ok: violations.length === 0, violations };
}
async function archiveResiduals(planId, harnessDir) {
  const dir = harnessDir !== undefined ? resolve4(harnessDir) : resolveHarnessDir();
  if (dir === null) {
    throw new Error(`harness dir not found from ${process.cwd()} — pass harnessDir or set MSTAR_HARNESS_DIR`);
  }
  assertSafePathComponent(planId, "planId");
  const statusPath = join4(dir, "status.json");
  if (!existsSync2(statusPath)) {
    throw new Error(`status file not found: ${statusPath}`);
  }
  return withStatusWriteLock(statusPath, () => {
    const doc = readJson(statusPath);
    if (!isPlainObject2(doc.residual_findings)) {
      throw new Error(`status.json residual_findings must be an object: ${statusPath}`);
    }
    const open = doc.residual_findings[planId];
    const archivePath = join4(dir, "archived", "residuals", `${planId}.json`);
    if (!Array.isArray(open) || open.length === 0) {
      return { planId, archived: 0, archivePath };
    }
    const archive = readJson(archivePath);
    const existing = Array.isArray(archive.entries) ? archive.entries : [];
    const existingIds = new Set(existing.map((e) => isPlainObject2(e) && typeof e.id === "string" ? e.id : undefined).filter((id) => id !== undefined));
    const today = todayString();
    const moved = open.filter((entry) => {
      if (!isPlainObject2(entry) || typeof entry.id !== "string")
        return true;
      return !existingIds.has(entry.id);
    }).map((entry) => ({ ...entry, archived_at: today }));
    if (moved.length > 0) {
      writeJson(archivePath, { plan_id: planId, schema_version: 1, entries: [...existing, ...moved] });
    }
    delete doc.residual_findings[planId];
    doc.updated_at = today;
    writeJson(statusPath, doc);
    return { planId, archived: moved.length, archivePath };
  });
}
function planFindingsCleanup(doc, planId) {
  if (!Array.isArray(doc.plans))
    return;
  for (const row of doc.plans) {
    if (!isPlainObject2(row))
      continue;
    const rowId = row.id ?? row.plan_id;
    if (rowId !== planId)
      continue;
    if (!isPlainObject2(row.metadata))
      return;
    const mode = row.metadata.findings_cleanup;
    if (mode === "zero-residual" || mode === "allow-residual")
      return mode;
    return;
  }
  return;
}
function openResidualsOf(doc, planId) {
  if (!isPlainObject2(doc.residual_findings))
    return [];
  const list = doc.residual_findings[planId];
  if (!Array.isArray(list))
    return [];
  return list.filter((entry) => isPlainObject2(entry) && isOpenResidual(entry));
}
function findingsCleanupGate(doc, planId, opts) {
  const mode = opts?.mode ?? planFindingsCleanup(doc, planId) ?? "allow-residual";
  const violations = [];
  const residuals = openResidualsOf(doc, planId);
  for (const entry of residuals) {
    const id = typeof entry.id === "string" ? entry.id : "<unnamed>";
    const label = `R#${id}`;
    if (mode === "zero-residual") {
      if (entry.severity === "nit") {
        violations.push(violation3("medium", "findings.zero-residual-nit", `${label}: style-only nits must be fixed in-session or dropped — never left open under zero-residual`));
      } else if (entry.decision === "risk-accepted" || entry.lifecycle === "waived") {
        violations.push(violation3("medium", "findings.zero-residual-risk-accepted", `${label}: waived/risk-accepted findings must be closed/archived, not left open under zero-residual`));
      } else if (entry.decision === "defer") {
        if (typeof entry.target !== "string" || entry.target.trim() === "") {
          violations.push(violation3("medium", "findings.zero-residual-defer-no-target", `${label}: blocker-defer requires a target (next iteration/milestone) under zero-residual`));
        }
      } else {
        violations.push(violation3("medium", "findings.zero-residual-open-fixable", `${label}: fixable finding must not remain open under zero-residual — fix now or convert to a blocker-defer`));
      }
    } else if (normalizeSeverity(entry.severity) === "critical") {
      violations.push(violation3("high", "findings.allow-residual-critical", `${label}: unresolved critical blocks Approve with residuals`));
    }
  }
  return { ok: violations.length === 0, violations };
}
function resolveCompassEnforcement(harnessDir) {
  const iterationsDir = resolveIterationDir(harnessDir);
  if (!existsSync2(iterationsDir))
    return { hard: false, source: "none" };
  let entries;
  try {
    entries = readdirSync2(iterationsDir, { withFileTypes: true });
  } catch {
    return { hard: false, source: "none" };
  }
  for (const entry of entries) {
    if (!entry.isDirectory())
      continue;
    const compassPath = join4(iterationsDir, entry.name, "delivery-compass.md");
    if (!existsSync2(compassPath))
      continue;
    let content;
    try {
      content = readFileSync3(compassPath, "utf8");
    } catch {
      continue;
    }
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const fm = frontmatter !== null ? frontmatter[1] : "";
    if (!/^status[ \t]*:[ \t]*(?:active|locked)[ \t]*$/m.test(fm))
      continue;
    const flag = parseEnforcementFlag(fm);
    if (flag.hard)
      return flag;
  }
  return { hard: false, source: "none" };
}
function groupCount(values) {
  const counts = new Map;
  for (const value of values) {
    const key = typeof value === "string" ? value : String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
function techDebtRollup(docOrPath) {
  const doc = typeof docOrPath === "string" ? readJson(docOrPath) : docOrPath;
  const canonical = isPlainObject2(doc.residual_findings) ? doc.residual_findings : {};
  const metadata = isPlainObject2(doc.metadata) ? doc.metadata : {};
  const legacy = isPlainObject2(metadata.residual_findings) ? metadata.residual_findings : {};
  const merged = { ...canonical, ...legacy };
  const items = [];
  for (const [plan, list] of Object.entries(merged)) {
    if (!Array.isArray(list))
      continue;
    for (const value of list) {
      if (!isPlainObject2(value) || !isOpenResidual(value))
        continue;
      items.push({ plan, entry: value });
    }
  }
  const bySeverity = {};
  for (const severity of SEVERITY_ORDER) {
    bySeverity[severity] = items.filter(({ entry }) => normalizeSeverity(entry.severity) === severity).length;
  }
  const computed = {
    total_open: items.length,
    by_severity: bySeverity,
    by_target: groupCount(items.map(({ entry }) => entry.target ?? "unspecified")),
    by_plan: groupCount(items.map(({ plan }) => plan))
  };
  const storedRaw = metadata.tech_debt_summary ?? null;
  const stored = storedRaw === null ? null : storedRaw;
  const checks = ROLLUP_FIELDS.map((field) => {
    const computedField = computed[field];
    if (stored === null)
      return { field, status: "DRIFT" };
    const storedField = stored[field];
    const storedCompared = storedField === false ? null : storedField ?? null;
    const status = JSON.stringify(computedField) === JSON.stringify(storedCompared) ? "PASS" : "DRIFT";
    return { field, status };
  });
  const overall = checks.every((check) => check.status === "PASS") ? "PASS" : "DRIFT";
  return { computed, stored, checks, overall };
}
// packages/engine/src/worktree.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync3 } from "node:fs";
import { isAbsolute as isAbsolute3, resolve as resolve5 } from "node:path";
var DEFAULT_PROBE_TIMEOUT_MS = 1e4;
function probeTimeoutMs() {
  const raw = process.env.MSTAR_GIT_PROBE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROBE_TIMEOUT_MS;
}
function violation4(severity, code, message, fix) {
  return { ok: false, severity, code, message, fix };
}
function gate(violations) {
  return { ok: violations.length === 0, violations };
}
function probeBranch(worktreePath, opts) {
  const precomputed = opts.branchOf?.(worktreePath);
  if (precomputed !== undefined)
    return { branch: precomputed };
  const timeout = opts.timeoutMs ?? probeTimeoutMs();
  try {
    const stdout = execFileSync(opts.gitPath ?? "git", ["-C", worktreePath, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout
    });
    const branch = stdout.trim();
    if (branch === "")
      return { error: `no branch checked out (detached HEAD?) at "${worktreePath}"` };
    return { branch };
  } catch (err) {
    const e = err;
    if (e.killed === true || e.signal !== undefined) {
      return { error: `git probe timed out after ${timeout}ms (killed by ${e.signal ?? "SIGTERM"})` };
    }
    const detail = (e.stderr !== undefined ? e.stderr.toString().trim() : "") || e.message || "git probe failed";
    return { error: detail };
  }
}
function l1PreDispatchCheck(input, opts = {}) {
  const violations = [];
  const { controlWorktreePath, leaseWorktreePath, leaseWorkingBranch, planId } = input;
  if (controlWorktreePath.trim() === "") {
    violations.push(violation4("high", "worktree.l1.control-missing", "metadata.control_worktree_path is not recorded — the L1 control worktree (integration-branch checkout) must be recorded in status.json before writable dispatch", "record the control worktree path in status.json metadata.control_worktree_path"));
  }
  if (leaseWorktreePath.trim() === "") {
    violations.push(violation4("high", "worktree.l1.lease-missing", `execution_lease.worktree_path is empty for plan "${planId}" — no verified execution_lease to dispatch against`, "claim the execution_lease with an absolute feature worktree path before dispatch"));
  }
  if (leaseWorkingBranch.trim() === "") {
    violations.push(violation4("high", "worktree.l1.lease-branch-missing", `execution_lease.working_branch is empty for plan "${planId}"`, "record the lease working_branch before dispatch"));
  }
  if (controlWorktreePath !== "" && leaseWorktreePath !== "" && resolve5(controlWorktreePath) === resolve5(leaseWorktreePath)) {
    violations.push(violation4("critical", "worktree.l1.lease-equals-control", `execution_lease.worktree_path "${leaseWorktreePath}" equals metadata.control_worktree_path — the feature worktree MUST differ from the control worktree (L1 isolation; product edits never land in the control checkout)`, "use a distinct feature worktree for the plan (git worktree add <path> <branch>) and update the lease"));
  }
  if (leaseWorktreePath !== "" && !existsSync3(leaseWorktreePath)) {
    violations.push(violation4("high", "worktree.l1.feature-missing", `feature worktree directory "${leaseWorktreePath}" does not exist for plan "${planId}"`, `create it before dispatch: git worktree add ${leaseWorktreePath} <working-branch>`));
  } else if (leaseWorktreePath !== "" && leaseWorkingBranch !== "") {
    const probe = probeBranch(leaseWorktreePath, opts);
    if ("error" in probe) {
      violations.push(violation4("high", "worktree.l1.branch-probe-failed", `cannot probe branch at "${leaseWorktreePath}" for plan "${planId}": ${probe.error}`, "verify the path is a git worktree checkout on the lease working branch (not detached)"));
    } else if (probe.branch !== leaseWorkingBranch) {
      violations.push(violation4("high", "worktree.l1.branch-mismatch", `feature worktree "${leaseWorktreePath}" is on branch "${probe.branch}", expected execution_lease.working_branch "${leaseWorkingBranch}" (plan "${planId}")`, `checkout ${leaseWorkingBranch} in the feature worktree`));
    }
  }
  return gate(violations);
}
function l2PreDispatchCheck(input, opts = {}) {
  const violations = [];
  const tracks = input.tracks ?? [];
  const seenPaths = new Set;
  if (tracks.length < 1) {
    violations.push(violation4("high", "worktree.l2.no-tracks", "no parallel writable tracks — the L2 pre-dispatch checklist requires at least one track with an absolute worktreePath and Working branch", "pass each track's absolute Worktree path and PM-approved Working branch"));
  }
  tracks.forEach((track, index) => {
    if (track.worktreePath.trim() === "" || track.workingBranch.trim() === "") {
      violations.push(violation4("high", "worktree.l2.track-invalid", `track ${index + 1} is missing worktreePath and/or workingBranch`, "fill both fields for every track"));
      return;
    }
    if (!isAbsolute3(track.worktreePath)) {
      violations.push(violation4("high", "worktree.l2.track-path-relative", `track ${index + 1} worktreePath "${track.worktreePath}" is not an absolute path — L2 tracks MUST use absolute worktree checkout paths (consistent with the lease validator's absolute worktree_path enforcement)`, `use an absolute path for track ${index + 1} (e.g. /Users/<you>/worktrees/<branch>)`));
      return;
    }
    const normalized = resolve5(track.worktreePath);
    if (seenPaths.has(normalized)) {
      violations.push(violation4("high", "worktree.l2.track-path-collision", `duplicate worktreePath "${track.worktreePath}" across parallel tracks — L2 parallel-writable isolation requires a distinct absolute Worktree path per track (N parallel invokes ≠ isolation)`, "give every parallel track its own git worktree checkout"));
      return;
    }
    seenPaths.add(normalized);
    if (!existsSync3(track.worktreePath)) {
      violations.push(violation4("high", "worktree.l2.track-missing", `track worktree directory "${track.worktreePath}" does not exist`, `create it before dispatch: git worktree add ${track.worktreePath} ${track.workingBranch}`));
      return;
    }
    const probe = probeBranch(track.worktreePath, opts);
    if ("error" in probe) {
      violations.push(violation4("high", "worktree.l2.branch-probe-failed", `cannot probe branch at "${track.worktreePath}": ${probe.error}`, "verify the path is a git worktree checkout on its Working branch (not detached)"));
    } else if (probe.branch !== track.workingBranch) {
      violations.push(violation4("high", "worktree.l2.branch-mismatch", `track worktree "${track.worktreePath}" is on branch "${probe.branch}", expected Working branch "${track.workingBranch}"`, `checkout ${track.workingBranch} in that worktree`));
    }
  });
  return gate(violations);
}
function assertControlVsFeaturePath(controlWorktreePath, featureWorktreePath) {
  const violations = [];
  const samePath = controlWorktreePath === "" && featureWorktreePath === "" || controlWorktreePath !== "" && featureWorktreePath !== "" && resolve5(controlWorktreePath) === resolve5(featureWorktreePath);
  if (samePath) {
    violations.push(violation4("critical", "worktree.control-feature.same", `control worktree path equals feature/lease worktree path "${controlWorktreePath}" — execution_lease.worktree_path MUST differ from metadata.control_worktree_path`, "use a distinct feature worktree for the plan's product edits"));
  }
  return gate(violations);
}
function assertBranchAlignment(worktreePath, expectedBranch, opts = {}) {
  const violations = [];
  const probe = probeBranch(worktreePath, opts);
  if ("error" in probe) {
    violations.push(violation4("high", "worktree.branch-probe-failed", `cannot probe branch at "${worktreePath}": ${probe.error}`, "verify the path is a git worktree checkout on the expected branch (not detached)"));
  } else if (probe.branch !== expectedBranch) {
    violations.push(violation4("high", "worktree.branch-mismatch", `worktree "${worktreePath}" is on branch "${probe.branch}", expected "${expectedBranch}" (Assignment Working branch)`, `checkout ${expectedBranch} in that worktree`));
  }
  return gate(violations);
}
var QC_ALIGNMENT_FIELDS = [
  { key: "planId", label: "plan_id" },
  { key: "reviewRange", label: "Review range" },
  { key: "diffBasis", label: "Diff basis" }
];
function assertQcAlignment(assignments) {
  const violations = [];
  const list = assignments ?? [];
  for (const { key, label } of QC_ALIGNMENT_FIELDS) {
    const distinct = [...new Set(list.map((a) => a[key]))];
    if (distinct.length > 1) {
      violations.push(violation4("high", "qc.alignment.mismatch", `QC/QA alignment field "${label}" is not byte-identical across ${list.length} assignments: ${distinct.map((v) => `"${v}"`).join(" vs ")}`, `copy the same ${label} value verbatim into every QC tri and QA Assignment`));
    }
  }
  return gate(violations);
}
function singleReviewSnapshot(assignments) {
  const violations = [];
  const list = assignments ?? [];
  list.forEach((a, index) => {
    if ((a.head ?? "").trim() === "") {
      violations.push(violation4("high", "qc.alignment.snapshot-missing", `review head not provided for assignment ${index + 1} (plan_id "${a.planId}") — cannot confirm the single review snapshot precondition`, "precompute and pass the review HEAD (full SHA) for every assignment"));
    }
  });
  const distinct = [...new Set(list.map((a) => a.head ?? "").filter((h) => h.trim() !== ""))];
  if (distinct.length > 1) {
    violations.push(violation4("high", "qc.alignment.single-snapshot", `assignments cover ${distinct.length} different review heads (${distinct.join(", ")}) — all reviewable commits must sit on ONE Working branch HEAD before QC tri + QA`, "merge the parallel tracks to a single Working branch HEAD, then re-derive the heads"));
  }
  return gate(violations);
}
// packages/engine/src/sdd.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { mkdirSync as mkdirSync4, readFileSync as readFileSync4, realpathSync, statSync as statSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { basename as basename3, dirname as dirname4, isAbsolute as isAbsolute4, join as join5, resolve as resolve6 } from "node:path";
class SddScriptError extends Error {
  exitCode;
  constructor(message, exitCode) {
    super(message);
    this.name = "SddScriptError";
    this.exitCode = exitCode;
  }
}
function isDirectory2(dir) {
  try {
    return statSync3(dir).isDirectory();
  } catch {
    return false;
  }
}
function isFile(file) {
  try {
    return statSync3(file).isFile();
  } catch {
    return false;
  }
}
var GIT_CAPTURE_MAX_BYTES = 64 * 1024 * 1024;
function gitOut(cwd, args) {
  try {
    return execFileSync2("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_CAPTURE_MAX_BYTES
    }).trim();
  } catch {
    return null;
  }
}
function probeHarnessWithStatus(root) {
  if (isFile(join5(root, ".mstar", "status.json")))
    return join5(root, ".mstar");
  if (isFile(join5(root, ".agents", "status.json")))
    return join5(root, ".agents");
  return null;
}
function isLinkedWorktree(root) {
  const gitDirRaw = gitOut(root, ["rev-parse", "--git-dir"]);
  const commonRaw = gitOut(root, ["rev-parse", "--git-common-dir"]);
  if (gitDirRaw === null || commonRaw === null)
    return false;
  const gitDir = isAbsolute4(gitDirRaw) ? gitDirRaw : join5(root, gitDirRaw);
  const common = isAbsolute4(commonRaw) ? commonRaw : join5(root, commonRaw);
  if (gitDir.includes("/.git/worktrees/") || gitDir.includes("/worktrees/"))
    return true;
  try {
    const gdParent = realpathSync(dirname4(gitDir));
    const cmAbs = realpathSync(common);
    return join5(gdParent, basename3(gitDir)) !== cmAbs && gitDir !== cmAbs;
  } catch {
    return false;
  }
}
function sddWorkspace(planId, opts = {}) {
  if (!planId) {
    throw new SddScriptError(`usage: mstar sdd workspace PLAN_ID [CONTROL_ROOT]
` + "  Set MSTAR_CONTROL_ROOT=<control_worktree_path> when running from a feature worktree.", 2);
  }
  const cwd = opts.cwd ?? process.cwd();
  const controlRoot = opts.controlRoot ?? (process.env.MSTAR_CONTROL_ROOT || undefined);
  let root;
  if (controlRoot) {
    if (!isDirectory2(controlRoot)) {
      throw new SddScriptError(`mstar sdd workspace: CONTROL_ROOT / MSTAR_CONTROL_ROOT is not a directory: ${controlRoot}`, 1);
    }
    root = realpathSync(controlRoot);
  } else {
    const topLevel = gitOut(cwd, ["rev-parse", "--show-toplevel"]);
    root = realpathSync(topLevel ?? cwd);
  }
  if (!controlRoot && isLinkedWorktree(root)) {
    throw new SddScriptError(`mstar sdd workspace: linked worktree at ${root} has no {HARNESS_DIR}/status.json (default gitignore).
` + `  Refusing to create a second SDD tree under the feature checkout.
` + `  Re-run with MSTAR_CONTROL_ROOT=<control_worktree_path> or: mstar sdd workspace ${planId} <control_worktree_path>
` + `  See mstar-branch-worktree «Harness path SSOT under default gitignore».`, 1);
  }
  const harnessOverride = opts.harnessDir ?? (process.env.MSTAR_HARNESS_DIR || undefined);
  let harnessDir;
  if (harnessOverride) {
    harnessDir = resolve6(root, harnessOverride);
  } else {
    const probed = probeHarnessWithStatus(root);
    if (probed) {
      harnessDir = probed;
    } else if (isDirectory2(join5(root, ".mstar"))) {
      harnessDir = join5(root, ".mstar");
    } else if (isDirectory2(join5(root, ".agents"))) {
      harnessDir = join5(root, ".agents");
    } else {
      harnessDir = join5(root, ".mstar");
    }
  }
  const sddDir = resolveSddDir(harnessDir, planId);
  mkdirSync4(sddDir, { recursive: true });
  writeFileSync3(join5(sddDir, ".gitignore"), `*
`);
  return realpathSync(sddDir);
}
function taskBrief(planFile, taskN, outFile, opts = {}) {
  if (!planFile || !Number.isInteger(taskN) || taskN < 1) {
    throw new SddScriptError("usage: mstar sdd task-brief PLAN_FILE TASK_NUMBER [OUTFILE]", 2);
  }
  let content;
  try {
    content = readFileSync4(planFile, "utf8");
  } catch {
    throw new SddScriptError(`no such plan file: ${planFile}`, 2);
  }
  let out;
  if (outFile) {
    out = outFile;
  } else {
    const sddDir = opts.sddDir ?? process.env.SDD_DIR;
    if (!sddDir) {
      throw new SddScriptError("mstar sdd task-brief: set SDD_DIR or pass OUTFILE (run mstar sdd workspace PLAN_ID first)", 2);
    }
    mkdirSync4(sddDir, { recursive: true });
    out = join5(sddDir, `task-${taskN}-brief.md`);
  }
  const records = content.endsWith(`
`) ? content.split(`
`).slice(0, -1) : content.split(`
`);
  const headingRe = /^#+[ \t]+Task[ \t]+[0-9]+/;
  const targetRe = new RegExp(`^#+[ 	]+Task[ 	]+${taskN}([^0-9]|$)`);
  let infence = false;
  let intask = false;
  const printed = [];
  for (const line of records) {
    if (/^```/.test(line))
      infence = !infence;
    if (!infence && headingRe.test(line))
      intask = targetRe.test(line);
    if (intask)
      printed.push(line);
  }
  const output = printed.length > 0 ? `${printed.join(`
`)}
` : "";
  writeFileSync3(out, output);
  if (printed.length === 0) {
    throw new SddScriptError(`task ${taskN} not found in ${planFile} (no heading matching Task ${taskN})`, 3);
  }
  return out;
}
function reviewPackage(base, head, outFile, opts = {}) {
  if (!base || !head) {
    throw new SddScriptError("usage: mstar sdd review-package BASE HEAD [OUTFILE]", 2);
  }
  const cwd = opts.cwd ?? process.cwd();
  const verifyRef = (ref, what) => {
    try {
      execFileSync2("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      throw new SddScriptError(`bad ${what}: ${ref}`, 2);
    }
  };
  verifyRef(base, "BASE");
  verifyRef(head, "HEAD");
  let out;
  if (outFile) {
    out = outFile;
  } else {
    const sddDir = opts.sddDir ?? process.env.SDD_DIR;
    if (!sddDir) {
      throw new SddScriptError("mstar sdd review-package: set SDD_DIR or pass OUTFILE", 2);
    }
    mkdirSync4(sddDir, { recursive: true });
    const shortBase = gitOut(cwd, ["rev-parse", "--short", base]) ?? base;
    const shortHead = gitOut(cwd, ["rev-parse", "--short", head]) ?? head;
    out = join5(sddDir, `review-${shortBase}..${shortHead}.diff`);
  }
  const run = (args) => execFileSync2("git", args, { cwd, maxBuffer: GIT_CAPTURE_MAX_BYTES });
  const parts = [
    Buffer.from(`# Review package: ${base}..${head}

## Commits
`),
    run(["log", "--oneline", `${base}..${head}`]),
    Buffer.from(`
## Files changed
`),
    run(["diff", "--stat", `${base}..${head}`]),
    Buffer.from(`
## Diff
`),
    run(["diff", "-U10", `${base}..${head}`])
  ];
  writeFileSync3(out, Buffer.concat(parts));
  return out;
}
function assertBaseSha(ref, opts = {}) {
  if (typeof ref !== "string" || !/^[0-9a-f]{4,40}$/i.test(ref)) {
    throw new SddScriptError(`assertBaseSha: BASE must be a commit SHA (full or prefix); got ${JSON.stringify(ref)}. ` + "Never use HEAD~1 as review BASE (multi-commit tasks truncate).", 2);
  }
  try {
    execFileSync2("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    throw new SddScriptError(`assertBaseSha: commit not found: ${ref}`, 2);
  }
}
function taskReportExists(sddDir, taskN) {
  try {
    const st = statSync3(join5(sddDir, `task-${taskN}-report.md`));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}
function readProgressLedger(sddDir) {
  let content;
  try {
    content = readFileSync4(join5(sddDir, "progress.md"), "utf8");
  } catch {
    return [];
  }
  return content.split(`
`).map((line) => line.trim()).filter((line) => line.length > 0);
}
function implementerSessionStickyRules(input) {
  const { session, nextTask, microBatchTasks = 1 } = input;
  if (session.session_mode !== "sticky") {
    return { resume: false, reason: `session_mode is '${session.session_mode}'; sticky resume requires 'sticky'` };
  }
  if (typeof session.host_agent_id !== "string" || session.host_agent_id.length === 0) {
    return {
      resume: false,
      reason: "host_agent_id is missing from implementer-session.json; fall back to fresh for this task " + "(mstar-sdd SKILL.md red flag: resume implementer without host_agent_id)"
    };
  }
  if (nextTask <= session.last_task) {
    return {
      resume: false,
      reason: `nextTask ${nextTask} <= last_task ${session.last_task}; task already completed in this session`
    };
  }
  if (microBatchTasks < 1 || microBatchTasks > 3) {
    return {
      resume: false,
      reason: `micro-batch of ${microBatchTasks} tasks is outside 1..3 (max 3 without user override, ` + "sticky-implementer-session.md § Micro-batch fallback)"
    };
  }
  return { resume: true, reason: `sticky resume OK: host_agent_id ${session.host_agent_id}, next task ${nextTask}` };
}
// packages/engine/src/iteration.ts
import { existsSync as existsSync4, readdirSync as readdirSync3, readFileSync as readFileSync5 } from "node:fs";
import { join as join6 } from "node:path";
var COMPASS_STATUSES = ["active", "locked", "completed"];
var DATE_RE2 = /^\d{4}-\d{2}-\d{2}$/;
var PLAN_STATUS_DONE = "Done";
var COMPASS_FILE = "delivery-compass.md";
var INDEX_README = "README.md";
var INDEX_HEADER = "| Iteration | Path | Description | Status |";
function typeName(value) {
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return "array";
  return typeof value;
}
function validateCompassShape(doc) {
  const issues = [];
  const expectString = (key, opts = {}) => {
    const value = doc[key];
    if (typeof value !== "string") {
      issues.push({ path: [key], message: `expected string, received ${typeName(value)}` });
      return;
    }
    if (opts.min !== undefined && value.length < opts.min) {
      issues.push({ path: [key], message: `string must contain at least ${opts.min} character(s)` });
      return;
    }
    if (opts.regex !== undefined && !opts.regex.test(value)) {
      issues.push({ path: [key], message: `string must match ${opts.regex}` });
    }
  };
  expectString("iteration_id", { min: 1 });
  expectString("start_date", { regex: DATE_RE2 });
  const status = doc.status;
  if (typeof status !== "string" || !COMPASS_STATUSES.includes(status)) {
    issues.push({
      path: ["status"],
      message: `expected one of ${COMPASS_STATUSES.map((s) => `'${s}'`).join(" | ")}, received ${typeName(status)}`
    });
  }
  expectString("iteration_base_branch", { min: 1 });
  expectString("target_branch", { min: 1 });
  const plans = doc.plans;
  if (plans !== undefined) {
    if (!Array.isArray(plans)) {
      issues.push({ path: ["plans"], message: `expected array, received ${typeName(plans)}` });
    } else {
      plans.forEach((entry, index) => {
        if (typeof entry !== "string") {
          issues.push({ path: ["plans", index], message: `expected string, received ${typeName(entry)}` });
        } else if (entry.length < 1) {
          issues.push({ path: ["plans", index], message: "string must contain at least 1 character(s)" });
        }
      });
    }
  }
  const end_date = doc.end_date;
  if (end_date !== undefined) {
    if (typeof end_date !== "string") {
      issues.push({ path: ["end_date"], message: `expected string, received ${typeName(end_date)}` });
    } else if (!DATE_RE2.test(end_date)) {
      issues.push({ path: ["end_date"], message: `string must match ${DATE_RE2}` });
    }
  }
  if (issues.length > 0)
    return { ok: false, issues };
  return {
    ok: true,
    data: {
      iteration_id: doc.iteration_id,
      start_date: doc.start_date,
      status,
      iteration_base_branch: doc.iteration_base_branch,
      target_branch: doc.target_branch,
      ...plans !== undefined ? { plans } : {},
      ...end_date !== undefined ? { end_date } : {}
    }
  };
}
function violation5(severity, code, message, fix) {
  return { ok: false, severity, code, message, fix };
}
function isPlainObject3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validateCompassFrontmatter(doc) {
  if (!isPlainObject3(doc)) {
    return {
      ok: false,
      violations: [
        violation5("medium", "COMPASS_INVALID_FIELD", "Compass frontmatter must be a YAML object with iteration_id / start_date / status / iteration_base_branch / target_branch (template: mstar-iteration §1.3)", "Fix the frontmatter of {ITERATION_DIR}/<iteration-id>/delivery-compass.md")
      ]
    };
  }
  const parsed = validateCompassShape(doc);
  if (!parsed.ok) {
    return {
      ok: false,
      violations: parsed.issues.map((issue) => {
        const field = issue.path.join(".") || "(root)";
        return violation5("medium", "COMPASS_INVALID_FIELD", `Compass frontmatter field '${field}' is invalid: ${issue.message}`, `Fix '${field}' in {ITERATION_DIR}/<iteration-id>/delivery-compass.md frontmatter (template: mstar-iteration §1.3)`);
      })
    };
  }
  const violations = [];
  const { status, end_date } = parsed.data;
  if (status === "completed" && end_date === undefined) {
    violations.push(violation5("high", "COMPASS_END_DATE_REQUIRED", "Compass frontmatter status is 'completed' but end_date is missing — end_date is required at iteration-close (mstar-iteration §3.4, template Fields guide)", "Add `end_date: YYYY-MM-DD` to the frontmatter"));
  }
  if (status !== "completed" && end_date !== undefined) {
    violations.push(violation5("medium", "COMPASS_END_DATE_NOT_ALLOWED", `Compass frontmatter sets end_date while status is '${status}' — end_date is only written at iteration-close (mstar-iteration §3.4)`, "Remove end_date until iteration-close"));
  }
  return { ok: violations.length === 0, violations };
}
function registeredPlanIds(compassDoc) {
  if (!Array.isArray(compassDoc.plans))
    return [];
  return compassDoc.plans.filter((plan) => typeof plan === "string" && plan.length > 0);
}
function findPlanRow(statusDoc, planId) {
  if (!Array.isArray(statusDoc.plans))
    return null;
  for (const row of statusDoc.plans) {
    if (!isPlainObject3(row))
      continue;
    const rowId = typeof row.id === "string" ? row.id : typeof row.plan_id === "string" ? row.plan_id : null;
    if (rowId === planId)
      return row;
  }
  return null;
}
function entryPlansAllDone(statusDoc, registered) {
  const violations = [];
  if (registered.length === 0) {
    violations.push(violation5("medium", "COMPASS_NO_PLANS", "Compass frontmatter registers no plans — the all-plans-Done transition cannot be verified (mstar-iteration §1.3 / Phase transition gates)", "List the iteration's plan ids in the compass frontmatter `plans`"));
    return violations;
  }
  for (const planId of registered) {
    const row = findPlanRow(statusDoc, planId);
    if (row === null) {
      violations.push(violation5("high", "PLAN_NOT_IN_STATUS", `Plan '${planId}' is registered in the compass frontmatter but has no row in status.json plans[] (mstar-iteration §3.1 entry item 1)`, "Add the plan row to {HARNESS_DIR}/status.json"));
      continue;
    }
    if (row.status !== PLAN_STATUS_DONE) {
      violations.push(violation5("high", "PLAN_NOT_DONE", `Plan '${planId}' status is ${JSON.stringify(row.status)} in status.json — all compass-registered plans must be 'Done' before iteration-close (mstar-iteration §3.1 entry item 1)`));
    }
  }
  return violations;
}
function entryResidualsOpen(statusDoc, planId) {
  const violations = [];
  const residualRoot = statusDoc.residual_findings;
  if (residualRoot === undefined || residualRoot === null)
    return violations;
  if (!isPlainObject3(residualRoot)) {
    violations.push(violation5("medium", "RESIDUAL_MALFORMED", "status.json residual_findings must be a plan-id → entries object (mstar-iteration §3.1 entry item 2)"));
    return violations;
  }
  const entries = residualRoot[planId];
  if (entries === undefined)
    return violations;
  if (!Array.isArray(entries)) {
    violations.push(violation5("medium", "RESIDUAL_MALFORMED", `status.json residual_findings['${planId}'] must be an array of residual entries (mstar-iteration §3.1 entry item 2)`));
    return violations;
  }
  const openIds = [];
  for (const entry of entries) {
    if (!isPlainObject3(entry) || !isOpenResidual(entry))
      continue;
    const isBlockerDefer = entry.decision === "defer" && typeof entry.target === "string" && entry.target.trim() !== "";
    if (isBlockerDefer)
      continue;
    openIds.push(typeof entry.id === "string" ? entry.id : "<unnamed>");
  }
  if (openIds.length > 0) {
    violations.push(violation5("high", "OPEN_RESIDUALS", `Plan '${planId}' has ${openIds.length} open residual finding(s) not exempted as blocker-defers (${openIds.join(", ")}) — residuals must be closed/archived before iteration-close; only zero-residual blocker-defers (decision: defer + target) may stay open (mstar-iteration §3.1 entry item 2)`, "Close or archive the open residuals, or convert them into blocker-defers (decision: defer + non-empty target) per mstar-plan-artifacts Findings cleanup modes"));
  }
  return violations;
}
function entryFrontmatterComplete(compassDoc) {
  return validateCompassFrontmatter(compassDoc).violations;
}
function exitFrontmatterClosed(compassDoc) {
  const violations = [];
  if (compassDoc.status !== "completed") {
    violations.push(violation5("high", "EXIT_STATUS_NOT_COMPLETED", `Compass frontmatter status must be 'completed' at close exit — current: ${JSON.stringify(compassDoc.status)} (mstar-iteration §3.4 / §3.5 exit item 4)`));
  }
  const endDate = compassDoc.end_date;
  if (typeof endDate !== "string" || !DATE_RE2.test(endDate)) {
    violations.push(violation5("high", "EXIT_END_DATE_REQUIRED", "Compass frontmatter end_date (YYYY-MM-DD) is required when closing (mstar-iteration §3.4 / §3.5 exit item 4)"));
  }
  return violations;
}
function exitBranchCheck(opts) {
  const violations = [];
  const { currentBranch, specIntegrationBranch } = opts;
  if (currentBranch === undefined || specIntegrationBranch === undefined) {
    violations.push(violation5("medium", "EXIT_BRANCH_UNVERIFIABLE", "Cannot verify the current branch is spec_integration_branch — missing currentBranch / specIntegrationBranch probe inputs (mstar-iteration §3.5 exit item 5)"));
  } else if (currentBranch !== specIntegrationBranch) {
    violations.push(violation5("high", "EXIT_BRANCH_MISMATCH", `Current branch '${currentBranch}' is not the spec_integration_branch '${specIntegrationBranch}' (mstar-iteration §3.5 exit item 5)`));
  }
  return violations;
}
function exitPrBaseCheck(compassDoc, opts) {
  const violations = [];
  const target = compassDoc.target_branch;
  const { prBaseBranch } = opts;
  if (prBaseBranch === undefined) {
    violations.push(violation5("medium", "EXIT_PR_BASE_UNVERIFIABLE", "Cannot verify the PR base — missing prBaseBranch probe input (mstar-iteration §3.5 exit item 6)"));
  } else if (typeof target !== "string" || prBaseBranch !== target) {
    violations.push(violation5("high", "EXIT_PR_BASE_MISMATCH", `PR base '${prBaseBranch}' must equal the compass target_branch '${String(target)}' — not an undocumented branch (mstar-iteration §3.5 exit item 6)`));
  }
  return violations;
}
function evaluatePhaseGate(statusDoc, compassDoc, opts = {}) {
  const registered = registeredPlanIds(compassDoc);
  const entryViolations = [
    ...entryPlansAllDone(statusDoc, registered),
    ...registered.flatMap((planId) => entryResidualsOpen(statusDoc, planId)),
    ...entryFrontmatterComplete(compassDoc)
  ];
  const exitViolations = [
    ...exitFrontmatterClosed(compassDoc),
    ...exitBranchCheck(opts),
    ...exitPrBaseCheck(compassDoc, opts)
  ];
  const allPlansDone = registered.length > 0 && registered.every((planId) => {
    const row = findPlanRow(statusDoc, planId);
    return row !== null && row.status === PLAN_STATUS_DONE;
  });
  const entry = { ok: entryViolations.length === 0, violations: entryViolations };
  const exit = { ok: exitViolations.length === 0, violations: exitViolations };
  let transition;
  if (!allPlansDone)
    transition = "phase-2-execute";
  else if (entry.ok && exit.ok)
    transition = "phase-4-pr-delivery";
  else
    transition = "phase-3-close";
  const gateBlocking = allPlansDone ? [...entryViolations, ...exitViolations] : [];
  return {
    transition,
    allPlansDone,
    entry,
    exit,
    ok: gateBlocking.length === 0,
    violations: gateBlocking
  };
}
function pushCadenceProbe(ciRunning, reviewWaveActive) {
  const violations = [];
  if (ciRunning) {
    violations.push(violation5("high", "PUSH_BLOCKED_CI", "CI checks are still queued/in_progress on the current head — do not push until the wave completes (mstar-iteration §5.1a push gate 1)", "Wait for CI to settle, then push once with the whole local batch"));
  }
  if (reviewWaveActive) {
    violations.push(violation5("high", "PUSH_BLOCKED_REVIEW_WAVE", "An AI/bot review wave is still running on the current head — do not push until it settles (mstar-iteration §5.1a push gate 2)", "Wait for the review wave, then push once"));
  }
  return { ok: violations.length === 0, violations };
}
function assertIndexRowObligations(iterationsDir) {
  if (!existsSync4(iterationsDir)) {
    return {
      ok: false,
      violations: [
        violation5("high", "INDEX_ITERATIONS_DIR_MISSING", `{ITERATION_DIR} '${iterationsDir}' does not exist (mstar-iteration §1.4)`, "Create the iterations directory (path.resolveIterationDir)")
      ]
    };
  }
  const iterationIds = readdirSync3(iterationsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).filter((entry) => existsSync4(join6(iterationsDir, entry.name, COMPASS_FILE))).map((entry) => entry.name).sort();
  const readmePath = join6(iterationsDir, INDEX_README);
  if (!existsSync4(readmePath)) {
    return {
      ok: false,
      violations: [
        violation5("high", "INDEX_README_MISSING", `{ITERATION_DIR}/README.md does not exist — one row per iteration is required (mstar-iteration §1.4)`, `Create {ITERATION_DIR}/README.md with the header '${INDEX_HEADER}' and one row per iteration`)
      ]
    };
  }
  const violations = [];
  const lines = readFileSync5(readmePath, "utf8").split(/\r?\n/);
  if (!lines.some((line) => line.includes(INDEX_HEADER))) {
    violations.push(violation5("medium", "INDEX_HEADER_MISSING", `{ITERATION_DIR}/README.md lacks the table header '${INDEX_HEADER}' (mstar-iteration §1.4)`, "Add the header row on first creation"));
  }
  const indexed = new Set;
  for (const line of lines) {
    const match = line.match(/^\s*\|\s*`([^`]+)`\s*\|/);
    if (match)
      indexed.add(match[1].trim());
  }
  for (const id of iterationIds) {
    if (!indexed.has(id)) {
      violations.push(violation5("medium", "INDEX_ROW_MISSING", `Iteration '${id}' has a delivery-compass.md but no index row in {ITERATION_DIR}/README.md — one row per iteration (mstar-iteration §1.4)`, `Add | \`${id}\` | [\`${id}/\`](${id}/) | <description> | <status> |`));
    }
  }
  return { ok: violations.length === 0, violations };
}
// packages/engine/src/design-md.ts
function violation6(severity, code, message, fix) {
  return { ok: false, severity, code, message, fix };
}
var RAW_GROUP = "__raw";
var isMap = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function parseScalar(raw) {
  const trimmed = raw.trim();
  const quoted = /^"([^"]*)"$/.exec(trimmed) ?? /^'([^']*)'$/.exec(trimmed);
  if (quoted)
    return quoted[1];
  const cut = trimmed.split(/\s+#/)[0].trim();
  if (/^-?\d+(?:\.\d+)?$/.test(cut))
    return Number(cut);
  if (/^(?:true|false)$/.test(cut))
    return cut === "true";
  return cut;
}
function parseMapBlock(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const match = /^([^:]+):(.*)$/.exec(lines[i].text);
    if (match === null) {
      i++;
      continue;
    }
    const key = parseScalar(match[1].trim()).toString();
    const rest = match[2].trim();
    if (rest === "") {
      const nested = i + 1 < lines.length && lines[i + 1].indent > indent;
      if (nested) {
        const child = parseBlock(lines, i + 1, lines[i + 1].indent);
        map[key] = child.value;
        i = child.next;
      } else {
        map[key] = "";
        i++;
      }
    } else {
      map[key] = parseScalar(rest);
      i++;
    }
  }
  return { value: map, next: i };
}
function parseListBlock(lines, start, indent) {
  const list = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("-")) {
    const rest = lines[i].text.slice(1).trim();
    const match = /^([^:]+):(.*)$/.exec(rest);
    if (match !== null && match[2].trim() === "" && i + 1 < lines.length && lines[i + 1].indent > indent) {
      const child = parseBlock(lines, i + 1, lines[i + 1].indent);
      list.push({ [parseScalar(match[1].trim()).toString()]: child.value });
      i = child.next;
    } else if (match !== null) {
      list.push({ [parseScalar(match[1].trim()).toString()]: parseScalar(match[2].trim()) });
      i++;
    } else {
      list.push(parseScalar(rest));
      i++;
    }
  }
  return { value: list, next: i };
}
function parseBlock(lines, start, indent) {
  if (lines[start] !== undefined && lines[start].text.startsWith("-"))
    return parseListBlock(lines, start, indent);
  return parseMapBlock(lines, start, indent);
}
function parseDesignFrontmatter(frontmatterText) {
  const body = frontmatterText.replace(/^\uFEFF/, "");
  const lines = body.split(/\r?\n/);
  if (lines.length === 0 || !lines[0].trim().startsWith("---"))
    return null;
  const inner = [];
  for (let i = 1;i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---")
      break;
    if (trimmed === "" || trimmed.startsWith("#"))
      continue;
    const indent = lines[i].match(/^ */)[0].length;
    inner.push({ indent, text: lines[i].slice(indent) });
  }
  if (inner.length === 0)
    return null;
  const top = parseBlock(inner, 0, inner[0].indent);
  if (!isMap(top.value))
    return null;
  const fm = { colors: {}, typography: {}, spacing: {}, rounded: {}, components: {} };
  for (const [key, value] of Object.entries(top.value)) {
    if (key === "version" || key === "name" || key === "description") {
      if (typeof value === "string")
        fm[key] = value;
    } else if (key === "colors" || key === "typography" || key === "spacing" || key === "rounded" || key === "components") {
      fm[key] = isMap(value) ? value : { [RAW_GROUP]: value };
    }
  }
  return fm;
}
var HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
var OKLCH_RE = /^oklch\([^)]*\)$/i;
var PX_RE = /^-?\d+(?:\.\d+)?px$/;
var PLACEHOLDER_RE = /^\[.*\]$/;
var TYPOGRAPHY_PROPS = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"];
var REF_RE = /^\{([a-z]+)\.([^}]+)\}$/;
var REF_GROUPS = ["colors", "typography", "rounded"];
var isPlaceholder = (value) => PLACEHOLDER_RE.test(value);
function validateDesignTokenFrontmatter(frontmatterText) {
  const violations = [];
  const fm = parseDesignFrontmatter(frontmatterText);
  if (fm === null) {
    violations.push(violation6("medium", "design-md.tokens.missing-frontmatter", "no `---` YAML frontmatter block found — DESIGN.md must open with a fenced frontmatter holding the token SSOT (design-md-spec §1.5)", "add a `---` fenced frontmatter with version, name, description, and the colors/typography/spacing/rounded groups"));
    return { ok: false, violations };
  }
  const groupEntries = (group) => {
    const value = fm[group];
    if (!isMap(value) || RAW_GROUP in value)
      return [];
    return Object.entries(value);
  };
  const groupIsMap = (group) => {
    const value = fm[group];
    return isMap(value) && !(RAW_GROUP in value);
  };
  for (const group of ["colors", "typography", "spacing", "rounded"]) {
    if (!isMap(fm[group])) {
      violations.push(violation6("medium", "design-md.tokens.group-not-map", `token group "${group}" must be a YAML map, not a scalar (design-md-spec §1.5)`, `rewrite \`${group}\` as a nested map`));
    } else if (!groupIsMap(group)) {
      violations.push(violation6("medium", "design-md.tokens.group-not-map", `token group "${group}" must be a YAML map, not a scalar (design-md-spec §1.5)`, `rewrite \`${group}\` as a nested map`));
    } else if (groupEntries(group).length === 0) {
      violations.push(violation6("medium", "design-md.tokens.missing-group", `missing required token group "${group}" — colors/typography/spacing/rounded are required by the frontmatter SSOT (design-md-spec §1.5)`, `add an active \`${group}:\` block with concrete token values`));
    }
  }
  if (!isMap(fm.components) || !groupIsMap("components")) {
    violations.push(violation6("medium", "design-md.tokens.group-not-map", `token group "components" must be a YAML map, not a scalar (design-md-spec §1.5)`, `rewrite \`components\` as a nested map`));
  }
  const placeholder = (group, name, value) => violations.push(violation6("low", "design-md.tokens.placeholder", `token "${group}.${name}" uses a "[...]" template value — placeholders never count as concrete tokens (completeness-checklist § How to use item 5)`, `replace \`${value}\` with a concrete value`));
  for (const [name, value] of groupEntries("colors")) {
    if (typeof value !== "string") {
      violations.push(violation6("medium", "design-md.tokens.color-format", `color "${name}" must be a string value (design-md-spec §2.2)`, "quote the color value"));
      continue;
    }
    if (isPlaceholder(value)) {
      placeholder("colors", name, value);
    } else if (!HEX_RE.test(value) && !OKLCH_RE.test(value)) {
      violations.push(violation6("medium", "design-md.tokens.color-format", `color "${name}" = "${value}" is not a hex (\`#rrggbb\`/\`#rrggbbaa\`) or oklch() value (design-md-spec §2.2)`, "use an sRGB hex value, optionally with a `-p3` oklch() twin"));
    }
  }
  for (const [name, value] of groupEntries("typography")) {
    if (!isMap(value)) {
      violations.push(violation6("medium", "design-md.tokens.typography-shape", `typography token "${name}" must be a map of the five properties (design-md-spec §1.5)`, "give it fontFamily/fontSize/fontWeight/lineHeight/letterSpacing"));
      continue;
    }
    const keys = Object.keys(value);
    const missing = TYPOGRAPHY_PROPS.filter((p) => !keys.includes(p));
    const extra = keys.filter((k) => !TYPOGRAPHY_PROPS.includes(k));
    if (missing.length > 0 || extra.length > 0) {
      violations.push(violation6("medium", "design-md.tokens.typography-shape", `typography token "${name}" must have exactly the five properties fontFamily/fontSize/fontWeight/lineHeight/letterSpacing (design-md-spec §1.5)${missing.length > 0 ? ` — missing: ${missing.join(", ")}` : ""}${extra.length > 0 ? ` — extra: ${extra.join(", ")}` : ""}`, "align the token with the five-property shape"));
    }
    for (const prop of ["fontFamily", "fontSize"]) {
      const v = value[prop];
      if (typeof v === "string" && isPlaceholder(v))
        placeholder("typography", name, v);
      else if (typeof v !== "string" || v.trim() === "") {
        violations.push(violation6("medium", "design-md.tokens.typography-shape", `typography token "${name}" has an empty \`${prop}\` (design-md-spec §1.5)`, `fill \`${prop}\` with a concrete value`));
      }
    }
  }
  if (groupIsMap("spacing")) {
    const spacing = fm.spacing;
    if (!Object.prototype.hasOwnProperty.call(spacing, "base")) {
      violations.push(violation6("medium", "design-md.tokens.spacing-base", "spacing must declare the base unit as `base` (design-md-spec §2.4)", "add `base: 4px` (or 8px) to the spacing group"));
    }
    for (const [name, value] of Object.entries(spacing)) {
      if (name !== "base" && name !== RAW_GROUP && !/^\d+$/.test(name)) {
        violations.push(violation6("medium", "design-md.tokens.spacing-key", `spacing key "${name}" must be \`base\` or a numeric multiplier (design-md-spec §1.5)`, "use numeric scale-step keys or `base`"));
      }
      if (typeof value === "string" && isPlaceholder(value)) {
        placeholder("spacing", name, value);
      } else if (typeof value !== "string" || !PX_RE.test(value)) {
        violations.push(violation6("medium", "design-md.tokens.spacing-format", `spacing value "${name}" = "${String(value)}" is not a px length (design-md-spec §1.5)`, "use a pixel value like `4px`"));
      }
    }
  }
  for (const [name, value] of groupEntries("rounded")) {
    if (typeof value === "string" && isPlaceholder(value)) {
      placeholder("rounded", name, value);
    } else if (typeof value !== "string" || !PX_RE.test(value)) {
      violations.push(violation6("medium", "design-md.tokens.rounded-format", `rounded value "${name}" = "${String(value)}" is not a px length (design-md-spec §1.5)`, "use a pixel value like `6px`"));
    }
  }
  for (const [name, value] of groupEntries("components")) {
    if (!isMap(value)) {
      violations.push(violation6("medium", "design-md.tokens.components-shape", `component token "${name}" must be a map of properties (design-md-spec §2.8)`, "give it backgroundColor/textColor/typography/rounded/padding/height"));
      continue;
    }
    for (const [prop, v] of Object.entries(value)) {
      if (typeof v !== "string")
        continue;
      if (isPlaceholder(v)) {
        placeholder("components", `${name}.${prop}`, v);
        continue;
      }
      const ref = REF_RE.exec(v);
      if (ref === null)
        continue;
      const [, refGroup, refKey] = ref;
      const resolves = REF_GROUPS.includes(refGroup) && groupIsMap(refGroup) && Object.prototype.hasOwnProperty.call(fm[refGroup], refKey);
      if (!resolves) {
        violations.push(violation6("medium", "design-md.tokens.ref-unresolved", `component "${name}" references "${v}" which does not resolve to an active token in this frontmatter (design-md-spec §6 — {path} refs MUST trace back to a key)`, `add the referenced token or use a literal value`));
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
var PARITY_GROUPS = ["colors", "typography", "spacing", "rounded", "components"];
function assertLightDarkParity(lightFm, darkFm) {
  const violations = [];
  const light = parseDesignFrontmatter(lightFm);
  const dark = parseDesignFrontmatter(darkFm);
  if (light === null || dark === null) {
    violations.push(violation6("medium", "design-md.parity.missing-frontmatter", `light/dark parity needs a YAML frontmatter in both files — ${light === null ? "DESIGN.md" : "DESIGN.dark.md"} has none (design-md-spec §4 rules 1–2)`, "add the fenced frontmatter to both theme files"));
    return { ok: false, violations };
  }
  const activeKeys = (fm) => {
    const keys = new Set;
    for (const group of PARITY_GROUPS) {
      const value = fm[group];
      if (!isMap(value) || RAW_GROUP in value)
        continue;
      for (const key of Object.keys(value))
        keys.add(`${group}.${key}`);
    }
    return keys;
  };
  const lightKeys = activeKeys(light);
  const darkKeys = activeKeys(dark);
  for (const key of lightKeys) {
    if (!darkKeys.has(key)) {
      violations.push(violation6("medium", "design-md.parity.missing-dark", `token "${key}" is active in DESIGN.md but missing from DESIGN.dark.md — both files must define the same token set (design-md-spec §4 rule 3)`, "add the token to DESIGN.dark.md with a dark-appropriate value"));
    }
  }
  for (const key of darkKeys) {
    if (!lightKeys.has(key)) {
      violations.push(violation6("medium", "design-md.parity.missing-light", `token "${key}" is active in DESIGN.dark.md but missing from DESIGN.md — DESIGN.md is the SSOT for token names (design-md-spec §4 rules 3–4)`, "add the token to DESIGN.md, or remove it from the dark file"));
    }
  }
  return { ok: violations.length === 0, violations };
}
var GRAY_STEPS = ["100", "200", "300", "400", "500", "600", "700", "800", "900", "1000"];
var ALPHA_STEPS = ["100", "200", "300", "400", "500", "600"];
var ACCENT_SCALES = ["blue", "red", "amber", "green", "teal", "purple", "pink"];
var L3_BODY_ITEM_IDS = [
  "dark-exists",
  "dark-parity",
  "elevation-shadows",
  "motion-easing",
  "motion-durations",
  "motion-reduced",
  "voice-content"
];
function isConcrete(value) {
  if (typeof value === "number")
    return true;
  return typeof value === "string" && value !== "" && !isPlaceholder(value);
}
function groupHasConcrete(fm, group, key) {
  if (fm === null)
    return false;
  const value = fm[group];
  if (!isMap(value) || RAW_GROUP in value)
    return false;
  const entry = value[key];
  return entry !== undefined && isConcrete(entry);
}
function typographyTokenComplete(fm, key) {
  if (fm === null)
    return false;
  const group = fm.typography;
  if (!isMap(group) || RAW_GROUP in group)
    return false;
  const entry = group[key];
  if (!isMap(entry))
    return false;
  return TYPOGRAPHY_PROPS.every((p) => Object.prototype.hasOwnProperty.call(entry, p) && isConcrete(entry[p]));
}
function countRoleTokens(fm, role) {
  if (fm === null)
    return 0;
  const group = fm.typography;
  if (!isMap(group) || RAW_GROUP in group)
    return 0;
  return Object.keys(group).filter((k) => k.startsWith(`${role}-`) && typographyTokenComplete(fm, k)).length;
}
function countNumericSpacingSteps(fm) {
  if (fm === null)
    return 0;
  const group = fm.spacing;
  if (!isMap(group) || RAW_GROUP in group)
    return 0;
  return Object.keys(group).filter((k) => k !== "base" && k !== RAW_GROUP && /^\d+$/.test(k)).length;
}
function hasComponent(fm, name) {
  if (fm === null)
    return false;
  const group = fm.components;
  if (!isMap(group) || RAW_GROUP in group)
    return false;
  return isMap(group[name]);
}
var LEVEL_RANK = { BELOW_MVP: 0, MVP: 1, Standard: 2, Production: 3 };
function completenessLevel(frontmatterText, checklist) {
  const fm = parseDesignFrontmatter(frontmatterText);
  const bodyUnverified = checklist === undefined;
  const bodyOk = (id) => (checklist ?? []).includes(id);
  const items = [];
  const add = (id, level2, source, ok) => {
    items.push({ id, level: level2, ok, source });
  };
  add("fm-exists", 1, "frontmatter", fm !== null);
  add("version", 1, "frontmatter", fm !== null && typeof fm.version === "string" && isConcrete(fm.version));
  add("name-description", 1, "frontmatter", fm !== null && typeof fm.name === "string" && isConcrete(fm.name) && typeof fm.description === "string" && isConcrete(fm.description));
  add("colors-background", 1, "frontmatter", groupHasConcrete(fm, "colors", "background-100"));
  add("colors-text", 1, "frontmatter", groupHasConcrete(fm, "colors", "gray-1000") && groupHasConcrete(fm, "colors", "gray-900"));
  add("colors-accent", 1, "frontmatter", ACCENT_SCALES.some((a) => groupHasConcrete(fm, "colors", `${a}-700`)));
  add("colors-semantic", 1, "frontmatter", groupHasConcrete(fm, "colors", "red-700") && groupHasConcrete(fm, "colors", "amber-700"));
  add("type-copy", 1, "frontmatter", countRoleTokens(fm, "copy") >= 1);
  add("type-heading", 1, "frontmatter", countRoleTokens(fm, "heading") >= 1);
  add("spacing-scale", 1, "frontmatter", groupHasConcrete(fm, "spacing", "base") && countNumericSpacingSteps(fm) >= 5);
  add("rounded-sm", 1, "frontmatter", groupHasConcrete(fm, "rounded", "sm"));
  add("breakpoints-2", 1, "body", bodyOk("breakpoints-2"));
  add("colors-background-scale", 2, "frontmatter", ["background-100", "background-200", "background-300"].every((k) => groupHasConcrete(fm, "colors", k)));
  add("colors-gray-scale", 2, "frontmatter", GRAY_STEPS.every((s) => groupHasConcrete(fm, "colors", `gray-${s}`)));
  add("colors-alpha-scale", 2, "frontmatter", ALPHA_STEPS.every((s) => groupHasConcrete(fm, "colors", `gray-alpha-${s}`)));
  add("colors-accent-scales", 2, "frontmatter", ACCENT_SCALES.every((a) => ["700", "800", "900", "1000"].every((s) => groupHasConcrete(fm, "colors", `${a}-${s}`))));
  add("type-headings-3", 2, "frontmatter", countRoleTokens(fm, "heading") >= 3);
  add("type-label", 2, "frontmatter", countRoleTokens(fm, "label") >= 1);
  add("type-button", 2, "frontmatter", countRoleTokens(fm, "button") >= 1);
  add("spacing-full", 2, "frontmatter", countNumericSpacingSteps(fm) >= 9);
  add("rounded-full", 2, "frontmatter", ["sm", "md", "lg", "full"].every((k) => groupHasConcrete(fm, "rounded", k)));
  add("components-button", 2, "frontmatter", hasComponent(fm, "button-primary") && hasComponent(fm, "button-secondary") && hasComponent(fm, "button-small"));
  add("components-input", 2, "frontmatter", hasComponent(fm, "input"));
  add("breakpoints-4", 2, "body", bodyOk("breakpoints-4"));
  add("components-button-states", 2, "body", bodyOk("components-button-states"));
  add("components-input-states", 2, "body", bodyOk("components-input-states"));
  add("spacing-rhythm", 2, "body", bodyOk("spacing-rhythm"));
  const componentNames = [];
  if (fm !== null && isMap(fm.components)) {
    for (const key of Object.keys(fm.components)) {
      if (key !== RAW_GROUP && isMap(fm.components[key]))
        componentNames.push(key);
    }
  }
  const namesJoined = componentNames.join(" ");
  add("components-library", 3, "frontmatter", componentNames.length >= 4 && /card/i.test(namesJoined) && /modal/i.test(namesJoined) && /tooltip/i.test(namesJoined) && /menu|dropdown/i.test(namesJoined));
  add("dark-exists", 3, "body", bodyOk("dark-exists"));
  add("dark-parity", 3, "body", bodyOk("dark-parity"));
  add("elevation-shadows", 3, "body", bodyOk("elevation-shadows"));
  add("motion-easing", 3, "body", bodyOk("motion-easing"));
  add("motion-durations", 3, "body", bodyOk("motion-durations"));
  add("motion-reduced", 3, "body", bodyOk("motion-reduced"));
  add("voice-content", 3, "body", bodyOk("voice-content"));
  const participating = items.filter((it) => it.source === "frontmatter" || !bodyUnverified);
  const failing = (level2) => participating.filter((it) => it.level === level2 && !it.ok).map((it) => it.id);
  const fail1 = failing(1);
  const fail2 = failing(2);
  const fail3 = failing(3);
  let level;
  let missing;
  if (fail1.length > 0) {
    level = "BELOW_MVP";
    missing = fail1;
  } else if (fail2.length > 0) {
    level = "MVP";
    missing = fail2;
  } else if (fail3.length > 0) {
    level = "Standard";
    missing = fail3;
  } else {
    level = "Production";
    missing = [];
  }
  if (level === "Production" && bodyUnverified) {
    level = "Standard";
    missing = [...L3_BODY_ITEM_IDS];
  }
  const placeholders = [];
  frontmatterText.split(/\r?\n/).forEach((line, index) => {
    const m = /\b(LEVEL([23])_PLACEHOLDER)\b/.exec(line);
    if (m !== null)
      placeholders.push({ level: Number(m[2]), marker: m[1], line: index + 1 });
  });
  const rank = LEVEL_RANK[level];
  const candidate = placeholders.map((p) => p.level).filter((l) => l > rank).sort((a, b) => b - a)[0];
  const upgradeTo = candidate === undefined ? null : candidate;
  return { level, items, missing, placeholders, upgradeTo, bodyUnverified };
}
// packages/engine/src/audit.ts
import { mkdirSync as mkdirSync5, readdirSync as readdirSync4, readFileSync as readFileSync6, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join7, resolve as resolve7 } from "node:path";
function violation7(severity, code, message, fix) {
  return { ok: false, severity, code, message, fix };
}
var AUDIT_PRIORITIES = ["P1", "P2", "P3"];
var AUDIT_EFFORTS = ["XS", "S", "M", "L", "XL"];
var AUDIT_RISKS = ["LOW", "MED", "HIGH"];
var AUDIT_CATEGORIES = [
  "bug",
  "security",
  "perf",
  "tests",
  "tech-debt",
  "migration",
  "dx",
  "docs",
  "direction"
];
var AUDIT_STATUS_FIELDS = ["Priority", "Effort", "Risk", "Depends on", "Category", "Planned at"];
function parseStatusBlocks(planText) {
  const blocks = [];
  let current = null;
  for (const line of planText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "## Status") {
      current = new Map;
      blocks.push({ fields: current });
      continue;
    }
    if (current === null)
      continue;
    if (trimmed.startsWith("#")) {
      current = null;
      continue;
    }
    const match = /^-\s*\*\*([^*]+)\*\*:\s*(.*)$/.exec(trimmed);
    if (match !== null)
      current.set(match[1].trim(), match[2].trim());
  }
  return blocks;
}
function validateAuditStatusBlocks(planText) {
  const violations = [];
  const blocks = parseStatusBlocks(planText);
  if (blocks.length === 0) {
    violations.push(violation7("medium", "audit.status.missing-block", "no `## Status` block found — audit plan files carry the Status block fields (mstar-audit SKILL § Plan files)", "add a `## Status` block with Priority, Effort, Risk, Depends on, Category, Planned at"));
    return { ok: false, violations };
  }
  blocks.forEach((block, index) => {
    const label = blocks.length > 1 ? ` #${index + 1}` : "";
    for (const field of AUDIT_STATUS_FIELDS) {
      if (!block.fields.has(field)) {
        violations.push(violation7("medium", "audit.status.missing-field", `Status block${label} missing required field "${field}" (mstar-audit SKILL § Plan files)`, `add \`- **${field}**: <value>\` to the Status block`));
      }
    }
    const check = (field, pattern, code, expected) => {
      const value = block.fields.get(field);
      if (value === undefined)
        return;
      if (!pattern.test(value)) {
        violations.push(violation7("medium", code, `Status block${label} "${field}" = "${value}" — expected ${expected} (mstar-audit SKILL § Plan files)`, `fix \`- **${field}**:\` to one of: ${expected}`));
      }
    };
    check("Priority", /^P[123]$/, "audit.status.invalid-priority", "P1 | P2 | P3");
    check("Effort", /^(?:XS|S|M|L|XL)$/, "audit.status.invalid-effort", "XS | S | M | L | XL");
    check("Risk", /^(?:LOW|MED|HIGH)$/, "audit.status.invalid-risk", "LOW | MED | HIGH");
    check("Category", /^(?:bug|security|perf|tests|tech-debt|migration|dx|docs|direction)$/, "audit.status.invalid-category", "bug | security | perf | tests | tech-debt | migration | dx | docs | direction");
    check("Depends on", /^(?:none|plans\/\d{3}-[\w.*-]+\.md)$/i, "audit.status.invalid-depends-on", "none or plans/NNN-*.md");
    check("Planned at", /^commit \`?(?:[0-9a-f]{7,40}|unknown)\`?, \d{4}-\d{2}-\d{2}$/, "audit.status.invalid-planned-at", "commit <short SHA>, <YYYY-MM-DD> (or `commit unknown` outside a git repo)");
  });
  return { ok: violations.length === 0, violations };
}
var WHOLE_MATCH_PATTERNS = [
  { type: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { type: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10,1024}\b/g },
  { type: "api-secret-key", re: /\bsk-[A-Za-z0-9-]{20,}\b/g }
];
var VALUE_PATTERNS = [
  {
    typeOf: (key) => key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[_-]+/g, "-"),
    re: /(["']?)\b(password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|secret|token)\b(["']?)(\s*[:=]\s*)("[^"\n]{8,}"|'[^'\n]{8,}'|[A-Za-z0-9_./+\-=]{16,})/gi
  }
];
function buildLineStarts(text) {
  const starts = [0];
  for (let i = 0;i < text.length; i++) {
    if (text[i] === `
`)
      starts.push(i + 1);
  }
  return starts;
}
function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = lo + hi + 1 >> 1;
    if (starts[mid] <= index)
      lo = mid;
    else
      hi = mid - 1;
  }
  return lo + 1;
}
function redactSecrets(text, filePath) {
  const starts = buildLineStarts(text);
  const marker = (type, index) => `[REDACTED ${type}@${lineAt(starts, index)}${filePath === undefined ? "" : ` in ${filePath}`}]`;
  const replacements = [];
  const findings = [];
  for (const pattern of WHOLE_MATCH_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      if (match.index === undefined)
        continue;
      replacements.push({ index: match.index, length: match[0].length, text: marker(pattern.type, match.index) });
      findings.push({ line: lineAt(starts, match.index), type: pattern.type });
    }
  }
  for (const pattern of VALUE_PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      if (match.index === undefined)
        continue;
      const type = pattern.typeOf(match[2]);
      const replacement = `${match[1]}${match[2]}${match[3]}${match[4]}${marker(type, match.index)}`;
      replacements.push({ index: match.index, length: match[0].length, text: replacement });
      findings.push({ line: lineAt(starts, match.index), type });
    }
  }
  replacements.sort((a, b) => b.index - a.index);
  let out = text;
  for (const r of replacements)
    out = out.slice(0, r.index) + r.text + out.slice(r.index + r.length);
  const deduped = new Map;
  for (const f of findings)
    deduped.set(`${f.line}:${f.type}`, f);
  const sorted = [...deduped.values()].sort((a, b) => a.line - b.line || a.type.localeCompare(b.type));
  return { text: out, findings: sorted };
}
function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
var escapeCell = (value) => value.replace(/\|/g, "\\|");
var truncate = (value, max) => value.length > max ? `${value.slice(0, max)}…` : value;
function renderPlanFile(finding, plannedAt) {
  const sections = [
    `# ${finding.title}`,
    "",
    "## Status",
    `- **Priority**: ${finding.priority}`,
    `- **Effort**: ${finding.effort}`,
    `- **Risk**: ${finding.risk}`,
    `- **Depends on**: ${finding.dependsOn ?? "none"}`,
    `- **Category**: ${finding.category}`,
    `- **Planned at**: commit \`${plannedAt.commit}\`, ${plannedAt.date}`,
    "",
    "## Impact",
    finding.impact
  ];
  if (finding.evidence.length > 0) {
    sections.push("", "## Evidence", ...finding.evidence.map((e) => `- ${e}`));
  }
  if (finding.fixSketch !== undefined) {
    sections.push("", "## Fix sketch", finding.fixSketch);
  }
  if (finding.verification !== undefined) {
    sections.push("", "## Verification", finding.verification);
  }
  return `${sections.join(`
`)}
`;
}
function readPlanFileSummary(filePath) {
  const text = readFileSync6(filePath, "utf8");
  const title = (text.match(/^# (.+)$/m) ?? [])[1] ?? filePath;
  const blocks = parseStatusBlocks(text);
  return { title: title.trim(), fields: blocks.length > 0 ? blocks[0].fields : new Map };
}
function renderIndex(params) {
  const { date, repoName, repoShortSha, rows, rejected } = params;
  const findingsRows = rows.map((r) => `| ${r.num} | ${escapeCell(r.title)} | ${r.category} | ${escapeCell(truncate(r.impact, 80))} | ${r.effort} | ${r.risk} | ${r.confidence} | ${escapeCell(truncate(r.evidence, 80))} |`).join(`
`);
  const directionRows = rows.filter((r) => r.category === "direction").map((r) => `- ${escapeCell(r.title)} — ${escapeCell(truncate(r.impact, 120))}`).join(`
`);
  const executionRows = rows.map((r) => `| ${r.num} | ${escapeCell(r.title)} | ${r.priority} | ${r.effort} | ${r.dependsOn} | TODO |`).join(`
`);
  const rejectedRows = rejected.map((r) => `- ${escapeCell(r.title)}: ${escapeCell(r.reason)}`).join(`
`);
  const sections = [
    `# Audit Report — ${repoName} @ ${repoShortSha} (${date})`,
    "",
    "## Findings",
    "",
    "| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence |",
    "|---|---------|----------|--------|--------|------|------------|----------|",
    findingsRows
  ];
  if (directionRows !== "") {
    sections.push("", "## Direction", "", directionRows);
  }
  sections.push("", "## Execution order & status", "", "| Plan | Title | Priority | Effort | Depends on | Status |", "|------|-------|----------|--------|------------|--------|", executionRows);
  if (rejectedRows !== "") {
    sections.push("", "## Findings considered and rejected", "", rejectedRows);
  }
  return `${sections.join(`
`)}
`;
}
function scaffoldAuditPlan(outDir, findings, options = {}) {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const plannedAt = options.plannedAt ?? { commit: options.repoShortSha ?? "unknown", date };
  mkdirSync5(outDir, { recursive: true });
  const existing = readdirSync4(outDir).filter((f) => /^\d{3}-.*\.md$/.test(f));
  let next = existing.reduce((max, f) => Math.max(max, Number(f.slice(0, 3))), 0) + 1;
  const written = [];
  const usedSlugs = new Set;
  for (const finding of findings) {
    const num = String(next).padStart(3, "0");
    let slug = slugify(finding.title);
    if (usedSlugs.has(slug)) {
      let n = 2;
      while (usedSlugs.has(`${slug}-${n}`))
        n++;
      slug = `${slug}-${n}`;
    }
    usedSlugs.add(slug);
    const file = `${num}-${slug}.md`;
    writeFileSync4(join7(outDir, file), renderPlanFile(finding, plannedAt));
    written.push(file);
    next++;
  }
  const all = [...existing, ...written].sort();
  const rows = all.map((file) => {
    const summary = readPlanFileSummary(join7(outDir, file));
    const fields = summary.fields;
    return {
      num: file.slice(0, 3),
      title: summary.title,
      category: fields.get("Category") ?? "—",
      impact: "see plan file",
      effort: fields.get("Effort") ?? "—",
      risk: fields.get("Risk") ?? "—",
      confidence: "—",
      evidence: fields.get("Evidence") ?? "—",
      priority: fields.get("Priority") ?? "—",
      dependsOn: fields.get("Depends on") ?? "—"
    };
  });
  const byNum = new Map(rows.map((r) => [r.num, r]));
  written.forEach((file, i) => {
    const finding = findings[i];
    if (finding === undefined)
      return;
    const row = byNum.get(file.slice(0, 3));
    if (row !== undefined) {
      row.category = finding.category;
      row.impact = finding.impact;
      row.effort = finding.effort;
      row.risk = finding.risk;
      row.confidence = finding.confidence;
      row.evidence = finding.evidence[0] ?? "";
      row.priority = finding.priority;
      row.dependsOn = finding.dependsOn ?? "none";
    }
  });
  writeFileSync4(join7(outDir, "README.md"), renderIndex({
    date,
    repoName: options.repoName ?? "repo",
    repoShortSha: options.repoShortSha ?? "unknown",
    rows,
    rejected: options.rejected ?? []
  }));
  return { outDir: resolve7(outDir), date, files: written, nextNumber: next };
}
// packages/engine/src/compound.ts
import { existsSync as existsSync5, readdirSync as readdirSync5, readFileSync as readFileSync7 } from "node:fs";
import { basename as basename4, isAbsolute as isAbsolute5, join as join8, relative as relative2, resolve as resolve8, sep } from "node:path";
function violation8(severity, code, message, fix) {
  return { ok: false, severity, code, message, fix };
}
var KNOWLEDGE_REQUIRED_FIELDS = ["module", "date", "problem_type", "category", "severity"];
var KNOWLEDGE_PROBLEM_TYPES = [
  "build_error",
  "test_failure",
  "runtime_error",
  "performance_issue",
  "database_issue",
  "security_issue",
  "ui_bug",
  "integration_issue",
  "logic_error",
  "config_error",
  "developer_experience",
  "workflow_issue",
  "best_practice",
  "documentation_gap",
  "architecture_pattern",
  "design_pattern",
  "tooling_decision",
  "convention",
  "api_design",
  "testing_pattern"
];
var KNOWLEDGE_BUG_PROBLEM_TYPES = [
  "build_error",
  "test_failure",
  "runtime_error",
  "performance_issue",
  "database_issue",
  "security_issue",
  "ui_bug",
  "integration_issue",
  "logic_error",
  "config_error"
];
var KNOWLEDGE_KNOWLEDGE_PROBLEM_TYPES = [
  "developer_experience",
  "workflow_issue",
  "best_practice",
  "documentation_gap",
  "architecture_pattern",
  "design_pattern",
  "tooling_decision",
  "convention",
  "api_design",
  "testing_pattern"
];
var KNOWLEDGE_SEVERITIES = ["critical", "high", "medium", "low"];
var KNOWLEDGE_RESOLUTION_TYPES = [
  "code_fix",
  "migration",
  "config_change",
  "test_fix",
  "dependency_update",
  "environment_setup",
  "workflow_improvement",
  "documentation_update",
  "tooling_addition"
];
var KNOWLEDGE_CATEGORY_MAP = {
  build_error: "build-errors",
  test_failure: "test-failures",
  runtime_error: "runtime-errors",
  performance_issue: "performance-issues",
  database_issue: "database-issues",
  security_issue: "security-issues",
  ui_bug: "ui-bugs",
  integration_issue: "integration-issues",
  logic_error: "logic-errors",
  config_error: "config-errors",
  best_practice: "best-practices",
  convention: "conventions",
  architecture_pattern: "architecture-patterns",
  design_pattern: "design-patterns",
  tooling_decision: "tooling-decisions",
  testing_pattern: "testing-patterns",
  api_design: "api-design",
  workflow_issue: "workflow-patterns",
  developer_experience: "developer-experience",
  documentation_gap: "documentation"
};
var DATE_RE3 = /^\d{4}-\d{2}-\d{2}$/;
var isMap2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function parseScalar2(raw) {
  const trimmed = raw.trim();
  const quoted = /^"([^"]*)"$/.exec(trimmed) ?? /^'([^']*)'$/.exec(trimmed);
  if (quoted)
    return quoted[1];
  const cut = trimmed.split(/\s+#/)[0].trim();
  if (/^-?\d+(?:\.\d+)?$/.test(cut))
    return Number(cut);
  if (/^(?:true|false)$/.test(cut))
    return cut === "true";
  return cut;
}
function parseMapBlock2(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const match = /^([^:]+):(.*)$/.exec(lines[i].text);
    if (match === null) {
      i++;
      continue;
    }
    const key = parseScalar2(match[1].trim()).toString();
    const rest = match[2].trim();
    if (rest === "") {
      const nested = i + 1 < lines.length && lines[i + 1].indent > indent;
      if (nested) {
        const child = parseBlock2(lines, i + 1, lines[i + 1].indent);
        map[key] = child.value;
        i = child.next;
      } else {
        map[key] = "";
        i++;
      }
    } else {
      map[key] = parseScalar2(rest);
      i++;
    }
  }
  return { value: map, next: i };
}
function parseListBlock2(lines, start, indent) {
  const list = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("-")) {
    const rest = lines[i].text.slice(1).trim();
    const match = /^([^:]+):(.*)$/.exec(rest);
    if (match !== null && match[2].trim() === "" && i + 1 < lines.length && lines[i + 1].indent > indent) {
      const child = parseBlock2(lines, i + 1, lines[i + 1].indent);
      list.push({ [parseScalar2(match[1].trim()).toString()]: child.value });
      i = child.next;
    } else if (match !== null) {
      list.push({ [parseScalar2(match[1].trim()).toString()]: parseScalar2(match[2].trim()) });
      i++;
    } else {
      list.push(parseScalar2(rest));
      i++;
    }
  }
  return { value: list, next: i };
}
function parseBlock2(lines, start, indent) {
  if (lines[start] !== undefined && lines[start].text.startsWith("-"))
    return parseListBlock2(lines, start, indent);
  return parseMapBlock2(lines, start, indent);
}
function parseYamlLite(text) {
  const body = text.replace(/^\uFEFF/, "");
  const lines = body.split(/\r?\n/);
  if (lines.length === 0 || !lines[0].trim().startsWith("---"))
    return null;
  const inner = [];
  for (let i = 1;i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---")
      break;
    if (trimmed === "" || trimmed.startsWith("#"))
      continue;
    const indent = lines[i].match(/^ */)[0].length;
    inner.push({ indent, text: lines[i].slice(indent) });
  }
  if (inner.length === 0)
    return null;
  const top = parseBlock2(inner, 0, inner[0].indent);
  if (!isMap2(top.value))
    return null;
  return top.value;
}
function validateSchemaYaml(frontmatterText) {
  const violations = [];
  const doc = parseYamlLite(frontmatterText);
  if (doc === null) {
    violations.push(violation8("medium", "compound.schema.missing-frontmatter", "no `---` YAML frontmatter block found — knowledge docs must open with the schema.yaml contract (mstar-compound/references/schema.yaml)", "add the fenced frontmatter with module, date, problem_type, category, severity"));
    return { ok: false, violations };
  }
  const isStr = (v) => typeof v === "string";
  const missing = (field) => violations.push(violation8("medium", "compound.schema.missing-field", `missing required frontmatter field "${field}" (schema.yaml required_fields)`, `add \`${field}: <value>\` to the frontmatter`));
  for (const field of KNOWLEDGE_REQUIRED_FIELDS) {
    if (!(field in doc) || doc[field] === "")
      missing(field);
  }
  if (doc.date !== undefined && (!isStr(doc.date) || !DATE_RE3.test(doc.date))) {
    violations.push(violation8("medium", "compound.schema.invalid-date", `date "${String(doc.date)}" must be a YYYY-MM-DD string (schema.yaml required_fields.date)`, "use `YYYY-MM-DD`"));
  }
  const problemType = doc.problem_type;
  if (problemType !== undefined && !isStr(problemType)) {
    violations.push(violation8("medium", "compound.schema.invalid-problem-type", `problem_type "${String(problemType)}" must be a string — one of the schema.yaml enum values (bug: build_error…config_error; knowledge: developer_experience…testing_pattern)`, "pick the narrowest applicable problem_type from schema.yaml"));
  }
  const problemTypeValid = isStr(problemType) && KNOWLEDGE_PROBLEM_TYPES.includes(problemType);
  if (isStr(problemType) && !problemTypeValid) {
    violations.push(violation8("medium", "compound.schema.invalid-problem-type", `problem_type "${problemType}" is not one of the schema.yaml enum values (bug: build_error…config_error; knowledge: developer_experience…testing_pattern)`, "pick the narrowest applicable problem_type from schema.yaml"));
  }
  if (doc.severity !== undefined && !isStr(doc.severity)) {
    violations.push(violation8("medium", "compound.schema.invalid-severity", `severity "${String(doc.severity)}" must be a string — critical | high | medium | low (schema.yaml required_fields.severity)`, "use one of the four severity values"));
  }
  if (isStr(doc.severity) && !KNOWLEDGE_SEVERITIES.includes(doc.severity)) {
    violations.push(violation8("medium", "compound.schema.invalid-severity", `severity "${doc.severity}" must be critical | high | medium | low (schema.yaml required_fields.severity)`, "use one of the four severity values"));
  }
  if (problemTypeValid && isStr(doc.category)) {
    const expected = KNOWLEDGE_CATEGORY_MAP[problemType];
    if (doc.category !== expected) {
      violations.push(violation8("medium", "compound.schema.category-mismatch", `category "${doc.category}" does not match problem_type "${problemType}" — category-mapping.md rule 1 maps it to "${expected}"`, `set \`category: ${expected}\` (the directory name under {KNOWLEDGE_DIR})`));
    }
  }
  if (problemTypeValid) {
    const isBug = KNOWLEDGE_BUG_PROBLEM_TYPES.includes(problemType);
    if (isBug) {
      for (const field of ["symptoms", "root_cause", "resolution_type"]) {
        if (!(field in doc)) {
          violations.push(violation8("medium", "compound.schema.missing-track-field", `bug-track doc missing required field "${field}" (schema.yaml track_rules.bug)`, `add \`${field}:\` to the frontmatter`));
        }
      }
      if (doc.symptoms !== undefined && !Array.isArray(doc.symptoms)) {
        violations.push(violation8("medium", "compound.schema.invalid-symptoms", "bug-track `symptoms` must be a YAML list (schema.yaml track_rules.bug)", "list the observable symptoms under `symptoms:`"));
      }
      if (doc.root_cause !== undefined && !isStr(doc.root_cause)) {
        violations.push(violation8("medium", "compound.schema.invalid-root-cause", "bug-track `root_cause` must be a string (schema.yaml track_rules.bug)", "write the fundamental technical cause as a string"));
      }
      if (isStr(doc.resolution_type) && !KNOWLEDGE_RESOLUTION_TYPES.includes(doc.resolution_type)) {
        violations.push(violation8("medium", "compound.schema.invalid-resolution-type", `resolution_type "${doc.resolution_type}" is not one of the schema.yaml track_rules.bug enum values`, "use code_fix | migration | config_change | test_fix | dependency_update | environment_setup | workflow_improvement | documentation_update | tooling_addition"));
      }
    } else if (doc.applies_when !== undefined && !Array.isArray(doc.applies_when)) {
      violations.push(violation8("low", "compound.schema.invalid-applies-when", "knowledge-track `applies_when` must be a YAML list when present (schema.yaml track_rules.knowledge)", "list the conditions under `applies_when:`"));
    }
  }
  if (doc.plan_id !== undefined && !isStr(doc.plan_id)) {
    violations.push(violation8("low", "compound.schema.invalid-plan-id", "optional `plan_id` must be a string (schema.yaml optional_fields.plan_id)", "reference the status.json plan id as a string"));
  }
  if (doc.tags !== undefined) {
    if (!Array.isArray(doc.tags)) {
      violations.push(violation8("low", "compound.schema.invalid-tags", "optional `tags` must be a YAML list (schema.yaml optional_fields.tags)", "list lowercase, hyphen-separated keywords"));
    } else if (doc.tags.length > 8) {
      violations.push(violation8("low", "compound.schema.tags-too-many", `tags has ${doc.tags.length} entries — max 8 (schema.yaml optional_fields.tags.max_items)`, "trim the tag list to at most 8 keywords"));
    }
  }
  if (doc.last_updated !== undefined && (!isStr(doc.last_updated) || !DATE_RE3.test(doc.last_updated))) {
    violations.push(violation8("low", "compound.schema.invalid-last-updated", `last_updated "${String(doc.last_updated)}" must be YYYY-MM-DD (schema.yaml optional_fields.last_updated)`, "use `YYYY-MM-DD`"));
  }
  if (doc.related_components !== undefined && !Array.isArray(doc.related_components)) {
    violations.push(violation8("low", "compound.schema.invalid-related-components", "optional `related_components` must be a YAML list (schema.yaml optional_fields.related_components)", "list the other components involved"));
  }
  return { ok: violations.length === 0, violations };
}
var REF_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|md|markdown|json|jsonc|yaml|yml|toml|ini|cfg|sh|bash|zsh|py|go|rs|rb|java|kt|c|cpp|h|hpp|css|scss|sass|less|html|htm|vue|svelte|sql|graphql|env|example|gitignore|npmrc|lock|txt|svg|png|jpg|jpeg|webp|ico)$/i;
var SYMBOL_REF_RE = /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/;
var SCHEME_RE = /^[a-zA-Z][\w+.-]*:\/\//;
var LINE_SUFFIX_RE = /:\d+(?:-\d+)?$/;
var ANCHOR_RE = /#[\w.-]+$/;
var WALK_SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
var MAX_WALK_FILES = 5000;
function referenceExists(repoRoot, docText) {
  const violations = [];
  let checked = 0;
  const seen = new Set;
  const moduleNames = new Set;
  const refs = [];
  for (const match of docText.matchAll(/`([^`\n]+)`/g)) {
    const ref = match[1].trim();
    if (ref === "" || seen.has(ref))
      continue;
    seen.add(ref);
    if (SCHEME_RE.test(ref) || ref.startsWith("{") || ref.startsWith("#") || ref.includes("*") || ref.includes("?") || ref.startsWith("~") || isAbsolute5(ref)) {
      continue;
    }
    if (ref.includes("/") || REF_EXT_RE.test(ref)) {
      refs.push({ ref, isSymbol: false });
    } else if (SYMBOL_REF_RE.test(ref)) {
      const module = ref.split(".")[0];
      moduleNames.add(module);
      refs.push({ ref, isSymbol: true, module });
    }
  }
  const foundModules = new Set;
  if (moduleNames.size > 0) {
    let walked = 0;
    const stack = [repoRoot];
    while (stack.length > 0 && walked < MAX_WALK_FILES) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync5(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (++walked > MAX_WALK_FILES)
          break;
        if (entry.isDirectory()) {
          if (!WALK_SKIP_DIRS.has(entry.name))
            stack.push(join8(dir, entry.name));
        } else if (!entry.isSymbolicLink()) {
          const base = entry.name.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
          if (moduleNames.has(base))
            foundModules.add(base);
        }
      }
    }
  }
  for (const { ref, isSymbol, module } of refs) {
    if (!isSymbol || module === undefined) {
      const candidate = ref.replace(LINE_SUFFIX_RE, "").replace(ANCHOR_RE, "");
      if (existsSync5(resolve8(repoRoot, candidate))) {
        checked++;
      } else {
        violations.push(violation8("medium", "compound.reference.missing-file", `referenced path \`${ref}\` does not exist under ${repoRoot} (compound-refresh Phase 2: referenced code still exists?)`, "update the doc to reference an existing path, or delete the stale reference"));
      }
    } else if (foundModules.has(module)) {
      checked++;
    } else {
      violations.push(violation8("low", "compound.reference.module-missing", `symbol ref \`${ref}\` — heuristic: no ${module}.ts|tsx|js|jsx|mjs|cjs module file found under ${repoRoot} (compound-refresh Phase 2)`, "verify the module file exists, or update the reference"));
    }
  }
  return { ok: violations.length === 0, violations, checked };
}
function collectKnowledgeDocs(dir) {
  const docs = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync5(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink())
        continue;
      const full = join8(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith(".md") && entry.name !== "README.md" && entry.name !== "index.md") {
        docs.push(relative2(dir, full).split(sep).join("/"));
      }
    }
  }
  return docs.sort();
}
function normalizeIndexRef(cell) {
  const link = /\[[^\]]*\]\(([^)]+)\)/.exec(cell);
  let value = link !== null ? link[1] : cell;
  value = value.replace(/`/g, "").replace(/^\.\//, "");
  if (value.startsWith("knowledge/"))
    value = value.slice("knowledge/".length);
  return value.trim();
}
function assertIndexRows(knowledgeDir) {
  const violations = [];
  const readmePath = join8(knowledgeDir, "README.md");
  if (!existsSync5(readmePath)) {
    violations.push(violation8("medium", "compound.index.missing-readme", `missing ${readmePath} — the knowledge index is required (mstar-compound Phase 6: every doc gets a README.md row)`, "create knowledge/README.md with a Document / Source Plan / Description / Status table"));
    return { ok: false, violations };
  }
  const docs = collectKnowledgeDocs(knowledgeDir);
  const rows = new Set;
  for (const line of readFileSync7(readmePath, "utf8").split(/\r?\n/)) {
    if (!line.trim().startsWith("|"))
      continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 2)
      continue;
    const normalized = normalizeIndexRef(cells[1]);
    if (normalized !== "")
      rows.add(normalized);
  }
  for (const doc of docs) {
    if (!rows.has(doc)) {
      violations.push(violation8("medium", "compound.index.missing-row", `knowledge doc "${doc}" has no row in knowledge/README.md index (mstar-compound Phase 6 index obligations)`, `add a row \`| [<title>](${doc}) | <source plan> | <description> | <status> |\` to knowledge/README.md`));
    }
  }
  return { ok: violations.length === 0, violations };
}
function compoundRefreshScope(harnessDir, projectRoot) {
  return [
    join8(harnessDir, "knowledge"),
    join8(harnessDir, "knowledge", "README.md"),
    join8(projectRoot, "CONCEPTS.md"),
    join8(harnessDir, "status.json")
  ];
}
function isFileLikeRoot(root) {
  return /^[^.]*\.[A-Za-z0-9]{1,10}$/.test(basename4(root));
}
function scopeGuard(path, allowedRoots) {
  const resolved = resolve8(path);
  for (const root of allowedRoots) {
    const r = resolve8(root);
    if (isFileLikeRoot(r)) {
      if (resolved === r)
        return { ok: true, violations: [] };
    } else if (resolved === r || resolved.startsWith(r + sep)) {
      return { ok: true, violations: [] };
    }
  }
  return {
    ok: false,
    violations: [
      violation8("medium", "compound.scope.outside", `path "${path}" is outside the compound-refresh scope (allowed: ${allowedRoots.join(", ")}) — compound-refresh operates only on {HARNESS_DIR}/knowledge/**, {HARNESS_DIR}/knowledge/README.md, <repo-root>/CONCEPTS.md, {HARNESS_DIR}/status.json (mstar-compound-refresh SKILL.md § 产物与操作路径)`, "point the operation at one of the allowed paths")
    ]
  };
}
// packages/engine/src/lint.ts
function violation9(severity, code, message, fix) {
  return { ok: false, severity, code, message, fix };
}
var COMMENT_INTRODUCER = "(?:\\/\\/|\\/\\*|#|;|--|\\s\\*)";
function findSimplifyMarkers(fileText) {
  const markers = [];
  const re = new RegExp(`${COMMENT_INTRODUCER}\\s*simplify\\s*:`, "i");
  const lines = fileText.split(/\r?\n/);
  for (let i = 0;i < lines.length; i++) {
    if (re.test(lines[i]))
      markers.push({ line: i + 1, text: lines[i].trim() });
  }
  return markers;
}
var REMOVAL_PATH_PATTERNS = [
  /status\.json/i,
  /R#\d+/i,
  /\bresiduals?\b/i,
  /plans?\/[\w./-]+/i,
  /\bplans?\s+20\d{6}[-.\w]*/i,
  /\b(?:tracked|recorded|logged|scheduled|listed|noted)\s+in\s+[\w./-]+/i,
  /removal\s+path\s*[:=]\s*["'`]?[\w./-]+/i
];
function findTemporaryMarkers(fileText) {
  const markers = [];
  const violations = [];
  const re = new RegExp(`${COMMENT_INTRODUCER}\\s*temporary\\b`, "i");
  const lines = fileText.split(/\r?\n/);
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (!re.test(line))
      continue;
    const text = line.trim();
    let removalPath = null;
    for (const pattern of REMOVAL_PATH_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        removalPath = match[0];
        break;
      }
    }
    markers.push({ line: i + 1, text, removalPath });
    if (removalPath === null) {
      violations.push(violation9("medium", "lint.temporary.no-removal-path", `temporary marker at line ${i + 1} records no removal path (plan/status artifact reference) — record one before claiming the task complete (mstar-coding-behavior § Simplification markers)`, 'add a plan/status reference to the marker, e.g. "removal tracked in status.json" or "plan 20260808-slice2 removes this"'));
    }
  }
  return { ok: violations.length === 0, violations, markers };
}
var TEST_FILE_PATH_RE = /[\w./-]+\.(?:test|spec)\.[a-z0-9]+/i;
var TEST_FILE_PHRASE_RE = /\btest files?\b/i;
var COMMAND_PROMPT_RE = /^\s*[$>]\s*\S/;
var RUNNER_RE = /\b(?:bun|pnpm|npm|yarn|npx|bunx)\s+(?:test|run|exec)\b|\b(?:npx|bunx)\s+[\w./-]+\b|\b(?:tsc|vitest|jest|mocha|pytest)\b|\bgo\s+test\b|\bcargo\s+test\b/i;
var OUTPUT_TOKEN_RE = /[✓✔✗✘]|\b(?:PASS|FAIL)\b|\b\d+\s+(?:pass(?:es|ed)?|fail(?:s|ed|ing)?|skipped|tests?|ok)\b|\bok\s+\d+\b|\ball\s+ok\b|exit(?:ed)?\s+(?:with\s+)?(?:code\s+)?\d+/i;
function assertSddTddTriple(reportText) {
  const violations = [];
  const lines = reportText.split(/\r?\n/);
  let hasTests = false;
  let hasCommand = false;
  let hasOutput = false;
  for (const line of lines) {
    if (!hasTests && (TEST_FILE_PATH_RE.test(line) || TEST_FILE_PHRASE_RE.test(line)))
      hasTests = true;
    if (!hasCommand && (COMMAND_PROMPT_RE.test(line) || RUNNER_RE.test(line)))
      hasCommand = true;
    if (!hasOutput && OUTPUT_TOKEN_RE.test(line))
      hasOutput = true;
    if (hasTests && hasCommand && hasOutput)
      break;
  }
  if (!hasTests) {
    violations.push(violation9("medium", "lint.sdd-tdd.missing-tests", "task report carries no test file reference — the TDD triple needs covering test file(s) (mstar-coding-behavior § Integration Notes; mstar-sdd/references/file-handoffs.md)", 'add a "Covering test file(s): <path>.test.ts" line or a `.test.<ext>` path to the report'));
  }
  if (!hasCommand) {
    violations.push(violation9("medium", "lint.sdd-tdd.missing-command", "task report carries no command — the TDD triple needs the exact command run (mstar-coding-behavior § Integration Notes; mstar-sdd/references/file-handoffs.md)", 'add a "Command run: `bun test <file>`" line to the report'));
  }
  if (!hasOutput) {
    violations.push(violation9("medium", "lint.sdd-tdd.missing-output", "task report carries no output evidence — the TDD triple needs the run output (pass/fail counts or exit code) (mstar-coding-behavior § Integration Notes; mstar-sdd/references/file-handoffs.md)", 'paste the test-run output (e.g. "12 pass / 0 fail") into the report'));
  }
  return { ok: violations.length === 0, violations };
}
var PLACEHOLDER_TOKEN_RE = /\b(TBDs?|TODOs?|TBAs?)\b/gi;
var ELLIPSIS_RE = /\.\.\./;
var NEGATION_RE = /\b(?:no|not|without|none)\b/i;
function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, " ");
}
function planQualityBar(planText) {
  const findings = [];
  const violations = [];
  const lines = planText.split(/\r?\n/);
  let inFence = false;
  for (let i = 0;i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^```/.test(trimmed) || /^~~~/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence)
      continue;
    const stripped = stripInlineCode(lines[i]);
    const segmentStartBefore = (index) => Math.max(stripped.lastIndexOf("(", index - 1), stripped.lastIndexOf("[", index - 1), stripped.lastIndexOf("{", index - 1), stripped.lastIndexOf(".", index - 1), stripped.lastIndexOf(";", index - 1), stripped.lastIndexOf(",", index - 1));
    let token = null;
    for (const wordMatch of stripped.matchAll(PLACEHOLDER_TOKEN_RE)) {
      if (wordMatch.index === undefined)
        continue;
      const negated = NEGATION_RE.test(stripped.slice(segmentStartBefore(wordMatch.index) + 1, wordMatch.index));
      if (!negated) {
        token = wordMatch[0].replace(/s$/i, "").toUpperCase();
        break;
      }
    }
    if (token === null && ELLIPSIS_RE.test(stripped)) {
      token = "...";
    }
    if (token !== null) {
      const text = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
      findings.push({ token, line: i + 1, text });
      violations.push(violation9("medium", "lint.plan-quality.placeholder", `placeholder token "${token}" at line ${i + 1}: "${text}"`, "replace the placeholder with concrete content before locking the plan (mstar-plan-artifacts/references/plan-quality-bar.md; templates/plan.main.md placeholder scan)"));
    }
  }
  return { ok: violations.length === 0, violations, findings };
}
var WORKFLOW_VERB_START_RE = /^(?:explains?|describes?|covers?|provides?|walks?|guides?|shows?|lists?|details?|demonstrates?|outlines?|teaches?|summarizes?)\b/i;
var PRONOUN_RE = /\bI\b(?!\/)|\b(?:we|you|my|our|your|us)\b/gi;
var DESCRIPTION_MAX_WORDS = 120;
function lintSkillFrontmatter(frontmatterText) {
  const violations = [];
  const fm = parseFrontmatter(frontmatterText);
  if (fm === null) {
    violations.push(violation9("medium", "lint.frontmatter.missing", "no YAML frontmatter block found — a skill file must open with a `---` fenced frontmatter (mstar-skill-authoring § Frontmatter Contract)", "add a frontmatter block with `name` and `description` at the top of the file"));
    return { ok: false, violations };
  }
  const name = fm.name ?? "";
  if (name === "") {
    violations.push(violation9("medium", "lint.frontmatter.name.missing", "frontmatter `name` is missing — required (mstar-skill-authoring § Frontmatter Contract)", "add `name: <lowercase-hyphen-id>` to the frontmatter"));
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    violations.push(violation9("medium", "lint.frontmatter.name.format", `frontmatter \`name\` must be lowercase-hyphen ("${name}") — e.g. example-skill (mstar-skill-authoring § Frontmatter Contract)`, "rename to a stable lowercase-hyphen id, e.g. `name: example-skill`"));
  }
  const description = fm.description ?? "";
  if (description === "") {
    violations.push(violation9("medium", "lint.frontmatter.description.missing", "frontmatter `description` is missing — the trigger contract is required (mstar-skill-authoring § Frontmatter Contract)", "add a `description:` that states when the skill loads (symptoms, context, roles, exclusions)"));
  } else {
    const stripped = description.replace(/`[^`]*`/g, " ").replace(/'[^']*'/g, " ").replace(/"[^"]*"/g, " ");
    let pronoun = null;
    for (const m of stripped.matchAll(PRONOUN_RE)) {
      if (m[0] === "US")
        continue;
      pronoun = m;
      break;
    }
    if (pronoun !== null) {
      violations.push(violation9("low", "lint.frontmatter.description.person", `description uses first/second-person pronoun "${pronoun[0]}" — keep the trigger contract third person (mstar-skill-authoring § Frontmatter Contract)`, 'rewrite without I/we/you/my/our/your/us, e.g. "Use when the user asks …"'));
    }
    const start = description.trim().replace(/^[*_#>]+/, "").replace(/^["'`]+/, "").trim();
    if (WORKFLOW_VERB_START_RE.test(start)) {
      violations.push(violation9("low", "lint.frontmatter.description.workflow", 'description reads as a workflow summary ("Explains/Describes/Covers …") — the description is the trigger contract, not a summary of steps (mstar-skill-authoring § Frontmatter Contract)', "describe when to load the skill (symptoms, context, roles, exclusions) instead of summarizing its steps"));
    } else {
      const words = description.trim().split(/\s+/).filter(Boolean).length;
      if (words > DESCRIPTION_MAX_WORDS) {
        violations.push(violation9("low", "lint.frontmatter.description.workflow", `description is ${words} words — paragraph-length summaries bury the trigger contract (threshold ${DESCRIPTION_MAX_WORDS}, above the longest corpus description at 114 words, mstar-design-md; mstar-skill-authoring § Frontmatter Contract)`, "trim the description to a scannable trigger contract and move detail into the body"));
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
function parseFrontmatter(text) {
  const body = text.replace(/^\uFEFF/, "").replace(/^\s*/, "");
  const lines = body.split(/\r?\n/);
  const fields = {};
  let inBlock = body.startsWith("---");
  for (let i = inBlock ? 1 : 0;i < lines.length; i++) {
    const line = lines[i];
    if (inBlock && line.trim() === "---")
      break;
    const keyMatch = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (keyMatch) {
      fields[keyMatch[1].toLowerCase()] = keyMatch[2].trim().replace(/^["']|["']$/g, "");
    } else if (inBlock && fields.description !== undefined) {
      fields.description = `${fields.description} ${line.trim()}`.trim();
    } else if (!inBlock && i >= 10) {
      break;
    }
  }
  if (Object.keys(fields).length === 0)
    return null;
  return fields;
}
var REQUIRED_STRATEGY_SECTIONS = [
  "Vision",
  "What we build",
  "What we don't build",
  "Guiding Principles",
  "Technology Direction",
  "Decision Log"
];
function lintStrategySections(docText) {
  const violations = [];
  const headings = new Set;
  for (const line of docText.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (!match)
      continue;
    headings.add(match[1].replace(/[*_`]/g, "").trim().toLowerCase());
  }
  for (const required of REQUIRED_STRATEGY_SECTIONS) {
    if (!headings.has(required.toLowerCase())) {
      violations.push(violation9("medium", "lint.strategy.missing-section", `missing required section "${required}" (mstar-strategy § STRATEGY.md structure)`, "add a `## <Section>` heading; required: Vision, What we build, What we don't build, Guiding Principles, Technology Direction, Decision Log"));
    }
  }
  return { ok: violations.length === 0, violations };
}
// packages/engine/src/roles.ts
import { existsSync as existsSync6 } from "node:fs";
import { join as join9 } from "node:path";
function violation10(severity, code, message, fix) {
  return { ok: false, severity, code, message, fix };
}
var ROLE_MAPPING = [
  { agentId: "project-manager", reference: "references/project-manager.md" },
  { agentId: "product-manager", reference: "references/product-manager.md" },
  { agentId: "architect", reference: "references/architect.md" },
  { agentId: "fullstack-dev", reference: "references/fullstack-dev-shared.md" },
  { agentId: "fullstack-dev-2", reference: "references/fullstack-dev-shared.md" },
  { agentId: "frontend-dev", reference: "references/frontend-dev.md" },
  { agentId: "qa-engineer", reference: "references/qa-engineer.md" },
  { agentId: "qc-specialist", reference: "references/qc-specialist-shared.md" },
  { agentId: "qc-specialist-2", reference: "references/qc-specialist-shared.md" },
  { agentId: "qc-specialist-3", reference: "references/qc-specialist-shared.md" },
  { agentId: "ops-engineer", reference: "references/ops-engineer.md" },
  { agentId: "writing-specialist", reference: "references/writing-specialist.md" },
  { agentId: "prompt-engineer", reference: "references/prompt-engineer.md" }
];
var SHARED_FAMILIES = [
  { family: "fullstack-dev", memberIds: ["fullstack-dev", "fullstack-dev-2"] },
  { family: "qc-specialist", memberIds: ["qc-specialist", "qc-specialist-2", "qc-specialist-3"] }
];
var DEV_TRACK_PARAMS = [
  { roleId: "fullstack-dev", track: "primary" },
  { roleId: "fullstack-dev-2", track: "parallel_secondary" }
];
var QC_REVIEWER_PARAMS = [
  {
    roleId: "qc-specialist",
    reviewerIndex: 1,
    focus: "Architecture coherence and maintainability risk",
    reportSuffix: "qc1"
  },
  {
    roleId: "qc-specialist-2",
    reviewerIndex: 2,
    focus: "Security and correctness risk",
    reportSuffix: "qc2"
  },
  {
    roleId: "qc-specialist-3",
    reviewerIndex: 3,
    focus: "Performance and reliability risk",
    reportSuffix: "qc3"
  }
];
function validateRoleMapping(rolesDir, options = {}) {
  const mapping = options.mapping ?? ROLE_MAPPING;
  const families = options.families ?? SHARED_FAMILIES;
  const devTrack = options.devTrack ?? DEV_TRACK_PARAMS;
  const qcReviewers = options.qcReviewers ?? QC_REVIEWER_PARAMS;
  const violations = [];
  const referenceById = new Map(mapping.map((m) => [m.agentId, m.reference]));
  for (const { agentId, reference } of mapping) {
    if (!existsSync6(join9(rolesDir, reference))) {
      violations.push(violation10("medium", "roles.mapping.reference.missing", `role "${agentId}" maps to ${reference} which does not exist under ${rolesDir} (mstar-roles § Role Reference Mapping)`, `create ${join9(rolesDir, reference)} or fix the mapping row`));
    }
  }
  for (const { family, memberIds } of families) {
    const absent = memberIds.filter((id) => !referenceById.has(id));
    for (const id of absent) {
      violations.push(violation10("medium", "roles.mapping.family.member.missing", `shared family "${family}" member "${id}" is absent from the role mapping (mstar-roles § Role Reference Mapping)`, `add "${id}" to the mapping`));
    }
    if (absent.length === 0) {
      const refs = new Set(memberIds.map((id) => referenceById.get(id)));
      if (refs.size !== 1) {
        violations.push(violation10("medium", "roles.mapping.family.shared", `shared family "${family}" (${memberIds.join(", ")}) must resolve to ONE shared reference file — got ${[...refs].join(", ")} (mstar-roles § Maintenance Rules: "Keep shared-family roles on one shared reference file")`, `point every "${family}" member at the same references/<role>-shared.md`));
      }
    }
  }
  const tableByRole = new Map;
  const checkParamRoles = (rows, table) => {
    for (const row of rows) {
      const existing = tableByRole.get(row.roleId);
      if (existing !== undefined) {
        violations.push(violation10("medium", "roles.param.role.duplicate", `role "${row.roleId}" appears in both the ${existing} and ${table} parameter rows (mstar-roles § Parameter Table (SSOT))`, "remove the duplicate row"));
      } else {
        tableByRole.set(row.roleId, table);
      }
      if (!referenceById.has(row.roleId)) {
        violations.push(violation10("medium", "roles.param.role.missing", `${table} parameter row references unknown role "${row.roleId}" (mstar-roles § Parameter Table (SSOT))`, `add "${row.roleId}" to the role mapping or drop the row`));
      }
    }
  };
  checkParamRoles(devTrack, "dev track");
  checkParamRoles(qcReviewers, "QC reviewer");
  for (const row of devTrack) {
    if (row.track !== "primary" && row.track !== "parallel_secondary") {
      violations.push(violation10("medium", "roles.param.track", `dev track for "${row.roleId}" is "${String(row.track)}" — must be primary or parallel_secondary (mstar-roles § Parameter Table (SSOT))`, 'set track to "primary" or "parallel_secondary"'));
    }
  }
  const indices = qcReviewers.map((r) => r.reviewerIndex).sort((a, b) => a - b);
  const unique = new Set(indices);
  if (indices.length !== 3 || unique.size !== 3 || indices[0] !== 1 || indices[1] !== 2 || indices[2] !== 3) {
    violations.push(violation10("high", "roles.param.qc.index.set", `QC reviewer_index must be exactly {1, 2, 3} across the three qc-specialist* seats — got [${indices.join(", ")}] (mstar-roles § Parameter Table (SSOT))`, "assign reviewer_index 1/2/3 to qc-specialist / qc-specialist-2 / qc-specialist-3"));
  }
  for (const row of qcReviewers) {
    if (row.focus.trim() === "") {
      violations.push(violation10("medium", "roles.param.qc.focus.missing", `QC seat "${row.roleId}" (reviewer_index ${row.reviewerIndex}) has an empty focus (mstar-roles § Parameter Table (SSOT))`, "add the review focus"));
    }
    if (row.reportSuffix !== `qc${row.reviewerIndex}`) {
      violations.push(violation10("medium", "roles.param.qc.suffix", `QC seat "${row.roleId}" report_suffix "${row.reportSuffix}" must equal qc${row.reviewerIndex} — tri reports land at {SDD_DIR}/review/qc1.md…qc3.md (mstar-roles § Parameter Table (SSOT))`, `set report_suffix to qc${row.reviewerIndex}`));
    }
  }
  return { ok: violations.length === 0, violations };
}
var LOAD_ORDER_HEADING_RE = /^#{1,6}\s+[^\r\n]*\b(?:load[\s-]*order|first\s+action)\b[^\r\n]*$/i;
function extractLoadOrderSection(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let i = 0;i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m === null)
      continue;
    if (LOAD_ORDER_HEADING_RE.test(lines[i])) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start === -1)
    return null;
  const section = [lines[start]];
  for (let i = start + 1;i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m !== null && m[1].length <= level)
      break;
    section.push(lines[i]);
  }
  return section.join(`
`);
}
function lintLoadOrder(skillTexts) {
  const violations = [];
  for (const [name, text] of Object.entries(skillTexts)) {
    if (!name.startsWith("mstar-") || name === "mstar-harness-core")
      continue;
    const section = extractLoadOrderSection(text);
    if (section === null) {
      violations.push(violation10("medium", "roles.loadorder.section.missing", `skill "${name}" has no Load Order / First action section — every mstar-* topic skill must declare its first read (mstar-harness-core § 加载约定; mstar-roles § Load Order (Required))`, `add a "## Load Order" section naming mstar-harness-core as the first read`));
      continue;
    }
    if (!section.includes("mstar-harness-core")) {
      violations.push(violation10("medium", "roles.loadorder.core.missing", `skill "${name}" Load Order section does not declare mstar-harness-core as its first dependency (mstar-harness-core § 加载约定: 凡 mstar-*（name ≠ mstar-harness-core）假定读者已 Read 本 skill)`, "name mstar-harness-core first in the Load Order section"));
    }
  }
  return { ok: violations.length === 0, violations };
}
// packages/engine/src/host.ts
function detectHost(signals) {
  const s = new Set(signals);
  if (s.has("subagent_type"))
    return "cursor";
  if (s.has("question") || s.has("task_subagent"))
    return "opencode";
  if (s.has("task_agent_batch") || s.has("ask") || s.has("hub"))
    return "omp";
  if (s.has("AgentSwarm"))
    return "kimi";
  if (s.has("Agent") || s.has("AskUserQuestion") || s.has("EnterPlanMode") || s.has("TodoWrite"))
    return "zcode";
  if (s.has("plan_slash") || s.has("goal") || s.has("functions.*") || s.has("tool_search"))
    return "codex";
  return "ambiguous";
}
function resolveSkillRoot(host, paths) {
  const { skill, rel } = paths;
  const suffix = rel === undefined || rel === "" ? "" : `/${rel}`;
  switch (host) {
    case "omp":
      return `skill://${skill}${suffix}`;
    case "cursor":
      return `~/.cursor/plugins/local/morning-star-harness/skills/${skill}${suffix}`;
    case "codex":
      return `skills/${skill}${suffix}`;
    case "opencode":
      return `harness-skills/${skill}${suffix}`;
    case "kimi":
    case "zcode":
      return `./skills/${skill}${suffix}`;
    case "pi":
    case "dsh":
      return `deferred: ${host} has no plugin API in v1 — skill-root resolution lands with its adapter (roadmap §8.4)`;
  }
}
// packages/engine/src/skill-authoring.ts
function violation11(severity, code, message, fix) {
  return { ok: false, severity, code, message, fix };
}
var FIVE_QUESTION_SECTIONS = [
  { key: "load-order", label: "Load Order", question: "when to load the skill (triggers / exclusions)" },
  { key: "workflow", label: "Workflow", question: "the order of execution and key decision points" },
  { key: "decision-rules", label: "Decision Rules", question: "constraints / invariants that must never be violated" },
  { key: "evidence", label: "Evidence", question: "what a correct result looks like (success criteria / evidence)" },
  { key: "references", label: "References", question: "additional resources to open when the main path is not enough" }
];
var HEADING_RE = /^#{1,6}\s+[^\r\n]+$/;
function lintFiveQuestion(bodyText) {
  const headings = bodyText.split(/\r?\n/).filter((line) => HEADING_RE.test(line)).map((line) => line.replace(/^#{1,6}\s+/, "").trim().toLowerCase());
  const violations = [];
  for (const section of FIVE_QUESTION_SECTIONS) {
    const label = section.label.toLowerCase();
    const covered = headings.some((heading) => heading.includes(label));
    if (!covered) {
      violations.push(violation11("low", `skill-authoring.five-question.${section.key}`, `body does not answer "${section.question}" — no "${section.label}" section (mstar-skill-authoring § Body 必须回答的 5 问 / § 默认 Body 结构)`, `add a "## ${section.label}" section covering ${section.question}`));
    }
  }
  return { ok: violations.length === 0, violations };
}
function resolveAssetPath(skillName, relPath, host) {
  return `skill \`${skillName}\` → ${relPath} (${resolveSkillRoot(host, { skill: skillName, rel: relPath })})`;
}
export {
  writeJson,
  withStatusWriteLock,
  verifyPlanExecutionLease,
  validateStatus,
  validateSchemaYaml,
  validateRoleMapping,
  validateResidual,
  validatePlanRow,
  validateIntegrationMergeLease,
  validateGitignore,
  validateExecutionLease,
  validateDesignTokenFrontmatter,
  validateCompassFrontmatter,
  validateAuditStatusBlocks,
  validateAssignmentFields,
  techDebtRollup,
  taskReportExists,
  taskBrief,
  singleReviewSnapshot,
  sddWorkspace,
  scopeGuard,
  scaffoldHarness,
  scaffoldAuditPlan,
  sameHolderResume,
  reviewPackage,
  resolveSpecsDir,
  resolveSkillRoot,
  resolveSddDir,
  resolveProjectRoot,
  resolvePlanDir,
  resolveIterationDir,
  resolveHarnessDir,
  resolveCompassEnforcement,
  resolveAssetPath,
  releaseLease,
  referenceExists,
  redactSecrets,
  readProgressLedger,
  readJson,
  readHarnessVersion,
  pushCadenceProbe,
  planQualityBar,
  planExecutionLeaseLocations,
  parseEnforcementFlag,
  parseDesignFrontmatter,
  parseBranchPolicyDirectOnBranch,
  parseAssignmentFields,
  parseAssignmentBranchForms,
  normalizeSeverity,
  lintStrategySections,
  lintSkillFrontmatter,
  lintLoadOrder,
  lintSkillFrontmatter as lintFrontmatter,
  lintFiveQuestion,
  l2PreDispatchCheck,
  l1PreDispatchCheck,
  isReadOnlyAssignmentRole,
  implementerSessionStickyRules,
  findingsCleanupGate,
  findTemporaryMarkers,
  findSimplifyMarkers,
  executionModeToN,
  evaluatePhaseGate,
  emitGitignoreSnippet,
  detectHost,
  compoundRefreshScope,
  completenessLevel,
  claimLease,
  canSteal,
  assignmentHeaderRegion,
  assertTriIdentity,
  assertSddTddTriple,
  assertQcAlignment,
  assertPlanWritingPath,
  assertLightDarkParity,
  assertIndexRows,
  assertIndexRowObligations,
  assertDefaultBranchProtected,
  assertControlVsFeaturePath,
  assertBranchAlignment,
  assertBaseSha,
  archiveResiduals,
  applyEnforcement,
  antiRecursionPrecheck,
  SddScriptError,
  SHARED_FAMILIES,
  SEVERITY_ORDER,
  ROLE_MAPPING,
  QC_REVIEWER_PARAMS,
  KNOWLEDGE_SEVERITIES,
  KNOWLEDGE_RESOLUTION_TYPES,
  KNOWLEDGE_REQUIRED_FIELDS,
  KNOWLEDGE_PROBLEM_TYPES,
  KNOWLEDGE_KNOWLEDGE_PROBLEM_TYPES,
  KNOWLEDGE_CATEGORY_MAP,
  KNOWLEDGE_BUG_PROBLEM_TYPES,
  FIVE_QUESTION_SECTIONS,
  DEV_TRACK_PARAMS,
  AUDIT_RISKS,
  AUDIT_PRIORITIES,
  AUDIT_EFFORTS,
  AUDIT_CATEGORIES
};
