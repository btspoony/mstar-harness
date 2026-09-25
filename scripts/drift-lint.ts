#!/usr/bin/env bun
/**
 * drift-lint.ts — roadmap §8.7 item 4 (guards risk R1): pointer callouts in
 * skills/ must reference real engine exports, real CLI subcommands, and a
 * declared CLI bin name, and engine spec-citation comments must resolve to
 * real skill files.
 *
 * Guards added by the mechanical-verification pass:
 * 1. docs audit enum — `/codebase-audit` category tokens in
 * skills/mstar-use-cli/references/checks-and-lints.md (the `<category>`
 * keyword-table row) and README.md / README_CN.md (the category-focus
 * list) must be real AUDIT_CATEGORIES members; the checks-and-lints row
 * must enumerate the full nine (fabrications like `deps` and omissions
 * like a missing `bug` / `direction` both fail). Guard 1 forward also
 * scans skills/mstar-use-cli/** markdown for declared-bin prefixes and
 * real CLI paths (Engine-check callout bodies elsewhere are unchanged).
 * 2. README bilingual pairing — README.md and README_CN.md must change
 * together over the committed range merge-base(origin/main, HEAD)..HEAD
 * (AGENTS.md bilingual rule); skipped silently when git has no range
 * (local non-commit runs), but a missing range under GITHUB_ACTIONS
 * fails loudly — the drift-lint CI job checks out with fetch-depth: 0
 * so origin/main exists and PR runs are the enforcement surface.
 * 3. skills corpus — no ephemeral citations anywhere in the skills/
 * markdown tree (engine findEphemeralCitations over the full corpus),
 * turning the manual corpus smoke into a permanent CI guard.
 * 4. roles/load-order corpus ( * every `skills/mstar-*` SKILL.md must declare
 * `mstar-harness-core` in a Load Order / First action section (engine
 * `lintLoadOrder`) and the mstar-roles mapping / parameter tables
 * must resolve against the on-disk `references/<role>.md` layout
 * (engine `validateRoleMapping` on `skills/mstar-roles`).
 * 5. skills corpus — five-question runtime smoke (audit finding 5;
 * classifier wiring per the shared lint-classifier):
 * every shipped `skills/mstar-*` SKILL.md selected as `runtime` by the
 * shared Engine classifier (`classifySkillLint`; the
 * `mstar-harness-core` hub and the standard-bearing
 * `mstar-skill-authoring` are not runtime corpus) must pass engine
 * `lintFiveQuestion` in its classified runtime mode, so the corpus
 * cannot drift out of five-question alignment without failing CI.
 * Guard numbers are per-plan locked, not positional.
 * 6. skills corpus — Engine-check callout dedup: the same normalized
 * `**Engine check (when available):**` callout body must not appear
 * in more than one file (bilingual variant `或 import` → `or import`
 * counts as identical), so a re-vendored canonical callout fails CI
 * before it drifts.
 * 7. repo text face — dated plan/iteration ids and dated harness deep
 * paths on the tracked text face fail (engine findProvenanceCitations
 * over the repo tree, intersected with `git ls-files -z` so untracked local
 * files never fail the guard): `.md` files are scanned full text, `.ts`
 * files at comment lines only (leading comment lines plus trailing `//`
 * comments; `://` URL sequences are not comment fragments);
 * `.changes/archive` and the assembled `CHANGELOG`
 * release surfaces are exempt (historical release record, not new
 * prose). One failure row per citation, named `file:line`, turning the
 * repo AGENTS.md provenance rule (no local plan/iteration ids or harness
 * deep paths in tracked text; synthetic forms only) into a CI guard.
 * Face note: `.mstar|agents/sdd/…` deeplinks stay attributed to the
 * ephemeral check (item 3, skills corpus) by the finder contract, so
 * that subclass is policed there, not on the repo face.
 * 8. tracked Markdown links and anchors resolve within the checkout using
 * the canonical tracked-file set; each real diagnostic is reported as a
 * drift row.
 *
 * The forward callout citation check also validates the **binary prefix**
 * of every backticked CLI
 * citation in Engine-check callouts against the declared `bin` names read
 * from packages/cli/package.json — the manifest is SSOT, never a hardcoded
 * list — closing the blind spot where prose could cite a nonexistent
 * executable while every subcommand path still validated.
 *
 * Engine symbols are imported from the source entry (../packages/engine/
 * src/index.ts), NOT the "@mstar-harness/engine" package specifier:
 * its package export resolves to the gitignored dist build, which is not
 * available in a fresh checkout until dependencies are installed and
 * built. The engine source is loaded directly.
 *
 * Usage: bun run scripts/drift-lint.ts
 * Exit 0 = no drift; exit 1 = drift found (one line per violation).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { commentMask } from "./ascii-literal-utils.ts";
import { checkMarkdownLinks } from "./markdown-links.ts";
import {
  AUDIT_CATEGORIES,
  classifySkillLint,
  findEphemeralCitations,
  findProvenanceCitations,
  lintFiveQuestion,
  lintLoadOrder,
  stripFrontmatter,
  validateRoleMapping,
} from "../packages/engine/src/index.ts";

const root = process.cwd();
const failures: string[] = [];
let calloutsChecked = 0;
let cliCitationsChecked = 0;

function fail(message: string): void {
  failures.push(message);
}

/** Recursively collect files under `dir` matching `ext`. */
function collectFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(join(dir, entry.name), ext));
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function exists(rel: string): boolean {
  try {
    return statSync(join(root, rel)).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Guard 2 helpers: README bilingual pairing (AGENTS.md) */
/* ------------------------------------------------------------------ */

/**
 * Changed files over the committed range merge-base(origin/main, HEAD)..HEAD
 * (the push range in CI), or null when git cannot produce a range (no repo,
 * no origin/main, empty diff). A null result skips the pairing guard — it
 * must not block non-commit scenarios such as a plain local run while
 * editing.
 */
function changedFilesSinceMergeBase(): string[] | null {
  let base: string;
  try {
    base = execFileSync("git", ["merge-base", "origin/main", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  if (!base) return null;
  try {
    const out = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { encoding: "utf8" });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Per-file diff sizes (added/deleted line counts) over the same
 * merge-base(origin/main, HEAD)..HEAD range, or null when git cannot
 * produce the range. Drives the bilingual content-parity check (S-f):
 * README.md and README_CN.md must mirror not only presence but the size of
 * the change set (`--numstat`; binary entries report "-" and count as 0).
 */
function changedFileStatsSinceMergeBase(): Array<{ file: string; added: number; deleted: number }> | null {
  let base: string;
  try {
    base = execFileSync("git", ["merge-base", "origin/main", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  if (!base) return null;
  try {
    const out = execFileSync("git", ["diff", "--numstat", base, "HEAD"], { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [added, deleted, file] = line.split("\t");
        return {
          file,
          added: added === "-" ? 0 : Number(added) || 0,
          deleted: deleted === "-" ? 0 : Number(deleted) || 0,
        };
      });
  } catch {
    return null;
  }
}

/**
 * Pure pairing check — AGENTS.md ("README = developer consumer docs"):
 * README.md and README_CN.md must change together. Both changed or both
 * unchanged passes; exactly one changed fails. Returns failure lines
 * ([] = pass) so callers can test it with plain file-name lists.
 * Exported as a test seam — the script's own main block uses it for guard 2.
 */
export function checkBilingualPairing(changedFiles: string[]): string[] {
  const changed = new Set(changedFiles);
  const enChanged = changed.has("README.md");
  const cnChanged = changed.has("README_CN.md");
  if (enChanged === cnChanged) return [];
  const updated = enChanged ? "README.md" : "README_CN.md";
  const missing = enChanged ? "README_CN.md" : "README.md";
  return [
    `${updated} changed but ${missing} did not — update the paired README in the same change set (AGENTS.md bilingual rule)`,
  ];
}

/**
 * Bilingual content-parity check (S-f): when both READMEs changed, the
 * change sets must mirror each other — same added/deleted line counts
 * (per-file `--numstat` over the push range). Presence-only pairing passed
 * a change touching both files while updating only one semantically; a
 * mismatched change-set size fails loudly with the observed numbers.
 */
export function checkBilingualContentParity(
  stats: Array<{ file: string; added: number; deleted: number }>,
): string[] {
  const en = stats.find((s) => s.file === "README.md");
  const cn = stats.find((s) => s.file === "README_CN.md");
  if (!en || !cn) return [];
  if (en.added === cn.added && en.deleted === cn.deleted) return [];
  return [
    `README.md/README_CN.md changed-set size mismatch — README.md +${en.added}/-${en.deleted} vs README_CN.md +${cn.added}/-${cn.deleted}; mirror the same change set in both files (AGENTS.md bilingual rule)`,
  ];
}

export function isGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

export type BilingualGuardResult =
  | { status: "checked"; failures: string[] }
  | { status: "skipped"; reason: string }
  | { status: "failed"; failures: string[] };

/**
 * Guard 2 decision given the git range result and CI context:
 * - `changedFiles === null` — git could not resolve the range (no repo /
 * no origin/main). Locally this is a legitimate non-commit run and skips
 * silently; under GITHUB_ACTIONS it is a wiring failure (the drift-lint
 * job must checkout with fetch-depth: 0 so origin/main exists) and fails
 * loudly instead of silently skipping.
 * - `changedFiles === []` — range resolved but empty (direct-to-main push
 * where origin/main == HEAD). Uncovered by design; PR runs are the
 * enforcement surface, so this skips in CI too.
 * - non-empty — run the pairing check.
 * Exported as a test seam; `opts.ci` defaults to the GITHUB_ACTIONS env var
 * (the main block passes nothing, tests inject the env explicitly).
 */
export function evaluateBilingualGuard(
  changedFiles: string[] | null,
  opts: { ci?: boolean } = {},
): BilingualGuardResult {
  const ci = opts.ci ?? isGitHubActions();
  if (changedFiles === null) {
    if (ci) {
      return {
        status: "failed",
        failures: [
          "README bilingual pairing guard: no git range in CI (merge-base failed or origin/main missing) — the drift-lint job must checkout with fetch-depth: 0 so the pairing check can run (PR runs are the enforcement surface)",
        ],
      };
    }
    return { status: "skipped", reason: "no git range (non-CI run)" };
  }
  if (changedFiles.length === 0) {
    return { status: "skipped", reason: "empty range (direct-to-main push)" };
  }
  return { status: "checked", failures: checkBilingualPairing(changedFiles) };
}

/**
 * Category tokens from the `<category>` keyword-table row: the backticked
 * cell values after the keyword cell, filtered to lowercase-kebab codes
 * (`^[a-z][a-z-]*$`). The filter drops the `<category>` placeholder cell and
 * the plan-field reference "plan `Category` field values" (capitalized) —
 * neither is a category code. Exported as a test seam for guard 1.
 */
export function extractCategoryRowTokens(row: string): string[] {
  return [...row.split("|").slice(2).join("|").matchAll(/`([^`]+)`/g)]
    .map((mm) => mm[1])
    .filter((t) => /^[a-z][a-z-]*$/.test(t));
}

/** True when the bare token at `index` is itself the file name of a
 * knowledge-conventions citation — the citation path starts with
 * `conventions/` ("conventions/<file>" / "knowledge \`conventions/<file>\`").
 * Such docs resolve under `{KNOWLEDGE_DIR}/conventions/` (gitignored), so
 * existence is not verifiable in CI. The exemption is
 * anchored to the cited token itself: `conventions/` must immediately
 * precede it and start a path segment (`x-conventions/<file>` and
 * `sub/conventions/<file>` are NOT exempt), so nearby unrelated citations
 * are still existence-checked. */
export function citesKnowledgeConventions(text: string, index: number): boolean {
  return /(?:^|[^\w./-])conventions\/$/.test(text.slice(Math.max(0, index - 200), index));
}

/* ------------------------------------------------------------------ */
/* Guard 4 helpers: roles/load-order corpus (plan audit-003 Task 2) */
/* ------------------------------------------------------------------ */

/** Guard 4 result: mstar-* skill texts linted for their load-order
 * declarations plus the role-mapping verdict over `rolesDir`, with one
 * failure row per violation. */
export type RolesCorpusResult = {
 /** `skills/mstar-*` SKILL.md texts fed to lintLoadOrder (mstar-harness-core is exempt inside the engine) */
  skillsChecked: number;
 /** violations reported by lintLoadOrder on the collected skill texts */
  loadOrderViolations: number;
 /** violations reported by validateRoleMapping on `rolesDir` */
  mappingViolations: number;
  failures: string[];
};

/** Guard 4 — roles/load-order corpus smoke over the shipped `mstar-*`
 * corpus: every `skills/mstar-*` SKILL.md text must declare
 * `mstar-harness-core` in a Load Order / First action section
 * (`lintLoadOrder`; core itself is exempt by design) and the mstar-roles
 * mapping / parameter tables must resolve against the on-disk
 * `references/*.md` layout (`validateRoleMapping` on `rolesDir`).
 * Load-bearing: deleting a Load Order heading or a mapped reference file
 * fails drift-lint (regression-pinned by scripts/drift-lint.test.ts). */
export function checkRolesCorpus(
  files: Array<{ rel: string; text: string }>,
  rolesDir: string,
): RolesCorpusResult {
  const failures: string[] = [];
  const skillTexts: Record<string, string> = {};
  for (const { rel, text } of files) {
    const m = rel.match(/^skills\/(mstar-[\w-]+)\/SKILL\.md$/);
    if (!m) continue;
    skillTexts[m[1]] = text;
  }
  const loadOrder = lintLoadOrder(skillTexts);
  for (const v of loadOrder.violations) {
    failures.push(`roles: load-order ${v.code} - ${v.message}`);
  }
  const mapping = validateRoleMapping(rolesDir);
  for (const v of mapping.violations) {
    failures.push(`roles: mapping ${v.code} - ${v.message}`);
  }
  return {
    skillsChecked: Object.keys(skillTexts).filter((name) => name !== "mstar-harness-core").length,
    loadOrderViolations: loadOrder.violations.length,
    mappingViolations: mapping.violations.length,
    failures,
  };
}

/** Guard 4 corpus read — guard-or-clear-error (engine corpus test
 * pattern): every skill `SKILL.md` under `skills/mstar-*` is read with a
 * try/catch so an unreadable file (EISDIR/EPERM) becomes an explicit
 * `roles: read` failure row instead of crashing drift-lint with a raw
 * stack. The dsh seam and CLI skip unreadable siblings best-effort; the CI
 * guard must fail loudly with a clear row, never die mid-scan. */
export function readRolesCorpus(
  files: string[],
  root: string,
): { entries: Array<{ rel: string; text: string }>; readFailures: string[] } {
  const entries: Array<{ rel: string; text: string }> = [];
  const readFailures: string[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    try {
      entries.push({ rel, text: readFileSync(file, "utf8") });
    } catch (error) {
      readFailures.push(`roles: read ${rel} - ${(error as Error).message}`);
    }
  }
  return { entries, readFailures };
}

/* ------------------------------------------------------------------ */
/* Guard 5 helpers: five-question runtime corpus smoke */
/* ------------------------------------------------------------------ */

/** Guard 5 result: runtime skills checked (classifier-selected runtime
 * profiles) plus one failure row per uncovered question. */
export type FiveQuestionCorpusResult = { checked: number; failures: string[] };

/** Guard 5 — five-question runtime smoke over the shipped `mstar-*`
 * corpus: the shared Engine classifier (spec A4, `classifySkillLint` on the
 * resolved skill-directory basename) selects the runtime corpus — the
 * `mstar-harness-core` hub is five-question-exempt by design and the
 * standard-bearing `mstar-skill-authoring` stays in its own strict
 * authoring suite — and each selected skill must pass `lintFiveQuestion`
 * in its classified runtime mode. No local exempt-name set is forked here.
 * Load-bearing: deleting a Step-3 aligned heading or losing runtime alias
 * coverage fails drift-lint (regression-pinned by scripts/drift-lint.test.ts). */
export function checkFiveQuestionCorpus(files: Array<{ rel: string; text: string }>): FiveQuestionCorpusResult {
  const failures: string[] = [];
  let checked = 0;
  for (const { rel, text } of files) {
    const m = rel.match(/^skills\/(mstar-[\w-]+)\/SKILL\.md$/);
    if (!m) continue;
    const profile = classifySkillLint(m[1]);
 // Runtime-corpus scope only: mode null = core exemption; authoring = the
 // standard's own suite. (`mode !== "runtime"` covers both by policy.)
    if (profile.mode !== "runtime") continue;
    checked++;
    const result = lintFiveQuestion(stripFrontmatter(text), profile.mode);
    for (const v of result.violations) {
      failures.push(`${rel}: five-question runtime smoke ${v.code} - ${v.message}`);
    }
  }
  return { checked, failures };
}

/* ------------------------------------------------------------------ */
/* Guard 1 forward helpers: Engine-check callouts (bin-prefix guard) */
/* ------------------------------------------------------------------ */

export type EngineCalloutResult = {
  calloutsChecked: number;
  cliCitationsChecked: number;
  failures: string[];
};

/** Engine export names from `packages/engine/src/index.ts` — every
 * `export { … } from "…"` re-export name (strip `type` / `as` modifiers). */
export function buildEngineExportNames(engineIndex: string): Set<string> {
  const engineExports = new Set<string>();
  const exportRe = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  let m: RegExpExecArray | null;
  while ((m = exportRe.exec(engineIndex))) {
    for (let name of m[1].split(",")) {
      name = name.trim().split(/\s+as\s+/)[0].trim();
      if (name) engineExports.add(name);
    }
  }
  return engineExports;
}

/** CLI command inventory from `packages/cli/src/index.ts` — every
 * `.command("name")` path (single tokens plus `parent child` composites)
 * and every enumerated `.argument("<name>", "tok1 | tok2 | ...")` token as a
 * `parent tok` composite (e.g. `persist review` from `persist <kind>` with
 * kind = "status | snapshot | residuals | review | json").
 *
 * Declaration forms recognized as a command var:
 * - `const X = program.command("p")` — the eager group/subcommand form;
 * - `const X = new Command("p")` — the DETACHED group form, used when the
 *   group must not be created eagerly (`program.command("p")` aborts the
 *   whole CLI with commander's duplicate-command error when another
 *   registrar owns the same group name). A detached group counts only when
 *   the same source attaches it (`addCommand(X)`), so an orphan declaration
 *   never inflates the citation table.
 */
export function buildCliCommandInventory(cliSrc: string): {
  cliCommands: Set<string>;
  failures: string[];
} {
  const cliCommands = new Set<string>();
  const varPaths = new Map<string, string>();
  const failures: string[] = [];
  // Detached groups first (pre-pass): their verb chains appear BEFORE the
  // attach statement, so the parent lookup below must already know the path.
  const attachedVars = new Set<string>();
  for (const attach of cliSrc.matchAll(/addCommand\(\s*(\w+)\s*\)/g)) attachedVars.add(attach[1]!);
  for (const detached of cliSrc.matchAll(/const\s+(\w+)\s*=\s*new\s+Command\(\s*"([a-z-]+)"\s*\)/g)) {
    if (!attachedVars.has(detached[1]!)) continue;
    varPaths.set(detached[1]!, detached[2]!);
    cliCommands.add(detached[2]!);
  }
  // Group-lookup bindings (pre-pass): `const X = <target>.commands.find(
  // (command) => command.name() === "p")` resolves the group `p` at call time
  // and throws when it is absent, so the var aliases a group that exists —
  // verbs chained on `X` register under `p` (index.ts joins `catalog
  // reconcile` to the group another module owns this way).
  for (const lookup of cliSrc.matchAll(
    /const\s+(\w+)\s*=\s*\w+\.commands\.find\(\s*\(\s*\w+\s*\)\s*=>\s*\w+\.name\(\)\s*===\s*"([a-z-]+)"\s*\)/g,
  )) {
    varPaths.set(lookup[1]!, lookup[2]!);
    cliCommands.add(lookup[2]!);
  }
  // Chained group bindings (pre-pass): `const X = <boundVar>.command("p")`
  // binds X to the path of a command that hangs off an already-bound var —
  // verbs chained on `X` register under `p` (execution-migrate.ts joins `store
  // execution` to the group store-migrate.ts owns this way). A receiver whose
  // own binding is unknown is left unbound: the chain pass then reports it as
  // an unknown command var rather than inventing a path.
  for (const chained of cliSrc.matchAll(
    /const\s+(\w+)\s*=\s*(\w+)\s*\.\s*command\(\s*"([a-z-]+)"\s*\)/g,
  )) {
    const parent = varPaths.get(chained[2]!);
    if (parent === undefined) continue;
    const path = `${parent} ${chained[3]!}`;
    varPaths.set(chained[1]!, path);
    cliCommands.add(path);
  }
  // Dynamic verb factories (pre-pass): a local function whose first parameter
  // is a string-literal union (`(verb: "close" | "waive", …) => …`) registers
  // one subcommand per literal through `.command(param)`. Bind the parameter
  // to its literal set so the chain pass can expand that call shape.
  const literalUnionVars = new Map<string, string[]>();
  for (const union of cliSrc.matchAll(/\(\s*(\w+)\s*:\s*((?:"[a-z-]+"\s*\|\s*)+"[a-z-]+")\s*[,)]/g)) {
    literalUnionVars.set(union[1]!, [...union[2]!.matchAll(/"([a-z-]+)"/g)].map((v) => v[1]!));
  }
  // Loop-bound verb sets (pre-pass): the two shapes that iterate a literal verb
  // set instead of taking a literal-union parameter. Both bind the loop's key
  // into the SAME map, so the chain pass expands their `.command(<key>)` calls
  // through the shape it already knows — no second path builder in this file.
  //  - `for (const [verb, …] of Object.entries(TABLE))` over a module-local
  //    `Record<string, …>` whose keys are the verbs: plan-coordination.ts
  //    ISSUE_VERB_NAMES (retired verbs → `plan residual-add | residual-close`)
  //    and index.ts RETIRED_BACKLOG_COMMANDS (`status backlog-register |
  //    backlog-close`).
  //  - `for (const { verb, … } of factory())` over a local helper that returns
  //    its verb records: execution-workflow.ts `workflowTransitions()` (the
  //    active `workflow phase | lifecycle | execution-policy |
  //    integration-worktree`).
  // A set that cannot be read leaves its key unbound and stays silent: these
  // shapes were invisible before this pass, and a missed verb is still loud at
  // the citation site (an unknown-command failure), never silently accepted.
  const loopVerbSets: Array<readonly [string, string[]]> = [];
  for (const loop of cliSrc.matchAll(
    /for\s*\(\s*const\s*\[\s*(\w+)\s*,[^\]]*\]\s+of\s+Object\.entries\(\s*(\w+)\s*\)\s*\)/g,
  )) {
    const body = new RegExp(`const\\s+${loop[2]!}\\s*:\\s*Record<[^>]+>\\s*=\\s*\\{([^}]*)\\}`).exec(cliSrc)?.[1];
    if (body === undefined) continue;
    const keys = stripLineCommentsFromVerbTableBody(body);
    loopVerbSets.push([loop[1]!, [...keys.matchAll(/(?:"([^"]+)"|([a-z][a-z0-9-]*))\s*:/g)].map((m) => m[1] ?? m[2]!)]);
  }
  for (const loop of cliSrc.matchAll(/for\s*\(\s*const\s*\{\s*(\w+)[^}]*\}\s+of\s+(\w+)\s*\(\s*\)\s*\)/g)) {
    // The helper's text runs to the closing brace alone on its line: its
    // signature may open a braced return type whose own last line starts with
    // `}` too (`(): ReadonlyArray<{ … }> {`), so the column-0 `}` alone on the
    // line is the end of the declaration.
    const factory = new RegExp(`function\\s+${loop[2]!}\\s*\\([\\s\\S]*?^}[ \\t]*$`, "m").exec(cliSrc)?.[0];
    if (factory === undefined) continue;
    const verbs = [...factory.matchAll(new RegExp(`${loop[1]!}\\s*:\\s*"([a-z][a-z0-9-]*)"`, "g"))].map((m) => m[1]!);
    loopVerbSets.push([loop[1]!, verbs]);
  }
  for (const [key, verbs] of loopVerbSets) {
    if (verbs.length === 0) continue;
    literalUnionVars.set(key, [...new Set([...(literalUnionVars.get(key) ?? []), ...verbs])]);
  }
 // One pass keeps document order: `.command` advances the current chain
 // path (`const X = program.command("p")` or `X.command("sub")`), a
 // receiver-less `.command`/`.argument` hangs off that chain, and `.action`
 // closes it (a fresh statement re-resolves parents from varPaths).
  const chainRe =
    /(?:const\s+(\w+)\s*=\s*program\s*|(\w+)\s*)?\.(?:command\(\s*"([a-z-]+)"\s*\)|command\(\s*(\w+)\s*\)|argument\(\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\)|action\(\s*(?:async\s*)?)/g;
 // Enumerated argument descriptions: an all-lowercase `a-z-`-token list.
  const enumRe = /^[a-z-]+(?:\s*\|\s*[a-z-]+)+$/;
 // Current chain: the command path a receiver-less call hangs off.
  let chainVar: string | null = null;
  let chainPath: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = chainRe.exec(cliSrc))) {
    const declared = m[1];
    const receiver = m[2];
    const commandName = m[3];
    const commandVar = m[4];
    const argName = m[5];
    const argDesc = m[6];
    const parent = parentPathOf(receiver, chainVar, chainPath, varPaths);
    if (commandVar !== undefined) {
      // Dynamic verb registration: expand `<group>.command(param)` to one
      // subcommand per literal. An unknown parent chain or an unresolvable
      // parameter (a loop-bound verb, e.g. `Object.entries(...)`) contributes
      // nothing and is not a failure — this call shape was invisible to the
      // parser before the dynamic pass, so it must stay silent, never loud.
      const verbs = literalUnionVars.get(commandVar);
      if (parent != null && verbs !== undefined) {
        for (const verb of verbs) cliCommands.add(`${parent} ${verb}`);
      }
      continue;
    }
    if (commandName !== undefined) {
      if (declared) {
        varPaths.set(declared, commandName);
        cliCommands.add(commandName);
        chainVar = declared;
        chainPath = commandName;
        continue;
      }
      if (receiver === "program") {
        cliCommands.add(commandName);
        chainVar = "program";
        chainPath = commandName;
        continue;
      }
      if (parent === undefined) {
        failures.push(
          receiver === undefined
            ? `CLI subcommand "${commandName}" is not attached to a known command chain`
            : `CLI parent of "${receiver}.command("${commandName}")" is not a known command var`,
        );
        continue;
      }
      const path = parent ? `${parent} ${commandName}` : commandName;
      cliCommands.add(path);
      if (receiver !== undefined) chainVar = receiver;
      chainPath = path;
    } else if (argName !== undefined) {
      if (parent === undefined) {
        failures.push(
          receiver !== undefined
            ? `CLI parent of "${receiver}.argument("${argName}")" is not a known command var`
            : `CLI argument "${argName}" is not attached to a known command chain`,
        );
        continue;
      }
      const desc = argDesc.trim();
      if (!enumRe.test(desc)) continue;
      for (const token of desc.split("|").map((t) => t.trim())) {
        cliCommands.add(`${parent} ${token}`);
      }
    } else {
 // `.action(...)` — the command chain ends here.
      chainVar = null;
      chainPath = null;
    }
  }
  return { cliCommands, failures };
}

/** Parent command path for a `.command(...)` / `.argument(...)` receiver: the
 * current chain path when the receiver continues the chain, else the
 * receiver's declared path. `null` = a top-level command, `undefined` = an
 * unknown receiver (the caller decides whether that is a failure). */
function parentPathOf(
  receiver: string | undefined,
  chainVar: string | null,
  chainPath: string | null,
  varPaths: Map<string, string>,
): string | null | undefined {
  if (receiver === undefined) return chainPath;
  if (chainVar === receiver && chainPath !== null) return chainPath;
  return varPaths.get(receiver);
}

/** Audit `<category>` keyword-table row — owned by the `mstar-use-cli` skill. */
export const AUDIT_CATEGORY_DOC = "skills/mstar-use-cli/references/checks-and-lints.md";

/** Markdown tree scanned by Guard 1 forward beyond Engine-check callouts. */
export const USE_CLI_SKILL_DIR = "skills/mstar-use-cli";

/**
 * Strip `//` whole-line and end-of-line comments from verb-table object text.
 * PLAN_VERBS / WORKFLOW_VERBS use only `"name": true` or bare `name: true` entries —
 * no string values embed `//`, so line-based stripping cannot truncate a real verb key.
 */
function stripLineCommentsFromVerbTableBody(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => {
      const slash = line.indexOf("//");
      return slash === -1 ? line : line.slice(0, slash);
    })
    .join("\n");
}

/** Direct subcommand tokens registered under `prefix` in `cliCommands`. */
function directChildVerbs(cliCommands: Set<string>, prefix: string): Set<string> {
  const children = new Set<string>();
  const needle = `${prefix} `;
  for (const entry of cliCommands) {
    if (!entry.startsWith(needle)) continue;
    const rest = entry.slice(needle.length);
    if (!rest) continue;
    children.add(rest.split(" ")[0]!);
  }
  return children;
}

/**
 * Depth-aware CLI path validation for backticked citations. Walks token-by-token:
 * when the current prefix has child commands in the inventory, the next token
 * must match one of them; when it has no children, further tokens are argument
 * values (e.g. `persist get snapshot` where `snapshot` is a `--key` value, not a
 * subcommand). Extends to arbitrary depth without hard-coding layer counts.
 */
function longestInventoryPrefix(cliCommands: Set<string>, tokens: string[]): string | null {
  for (let len = tokens.length; len >= 1; len--) {
    const candidate = tokens.slice(0, len).join(" ");
    if (cliCommands.has(candidate)) return candidate;
  }
  return null;
}

function validateCliCommandTokens(cliCommands: Set<string>, tokens: string[]): string | null {
  if (tokens.length === 0) return "";
  const matched = longestInventoryPrefix(cliCommands, tokens);
  if (matched === null) return tokens.join(" ");
  const consumed = matched.split(" ").length;
  let path = matched;
  for (let i = consumed; i < tokens.length; i++) {
    const children = directChildVerbs(cliCommands, path);
    if (children.size === 0) break;
    const next = tokens[i]!;
    if (!children.has(next)) return `${path} ${next}`;
    path = `${path} ${next}`;
    if (!cliCommands.has(path)) return path;
  }
  return null;
}

/**
 * CLI modules whose top-level group registrars register commands outside
 * `packages/cli/src/index.ts` (`index.ts` calls each one). Parsed with the same
 * command-chain builder used for index.ts; the scoped verb tables in
 * plan-coordination.ts are read separately below.
 */
export const CLI_INVENTORY_REGISTRAR_MODULES = [
  "packages/cli/src/plan-coordination.ts",
  "packages/cli/src/execution-session.ts",
  "packages/cli/src/execution-workflow.ts",
  "packages/cli/src/execution-migrate.ts",
  "packages/cli/src/store-migrate.ts",
  "packages/cli/src/issue.ts",
  "packages/cli/src/catalog.ts",
  "packages/cli/src/roadmap.ts",
] as const;

/**
 * Supplement the index.ts inventory with commands registered outside that
 * file: PLAN_VERBS / WORKFLOW_VERBS tables in plan-coordination.ts (SSOT
 * for scoped verbs), the `sdd evidence` subtree in sdd-evidence.ts
 * (parsed from registerSddEvidenceCommands `.command(...)` calls), and every
 * registrar in `CLI_INVENTORY_REGISTRAR_MODULES` — each a group registrar that
 * index.ts calls and that is parsed here with the same command-chain builder
 * used for index.ts.
 */
export function supplementCliCommandInventory(
  cliCommands: Set<string>,
  repoRoot: string,
): { failures: string[] } {
  const failures: string[] = [];
  const planCoordPath = join(repoRoot, "packages/cli/src/plan-coordination.ts");
  let planCoordSrc: string;
  try {
    planCoordSrc = readFileSync(planCoordPath, "utf8");
  } catch {
    failures.push(
      "drift: could not read packages/cli/src/plan-coordination.ts for scoped verb-table inventory",
    );
    return { failures };
  }
  for (const { table, family } of [
    { table: "PLAN_VERBS", family: "plan" },
    { table: "WORKFLOW_VERBS", family: "workflow" },
  ] as const) {
    const re = new RegExp(`const\\s+${table}:\\s*Record<[^>]+>\\s*=\\s*\\{([^}]*)\\}`);
    const m = planCoordSrc.match(re);
    if (!m) {
      failures.push(`drift: could not parse ${table} in plan-coordination.ts`);
      continue;
    }
    const tableBody = stripLineCommentsFromVerbTableBody(m[1]);
    for (const vm of tableBody.matchAll(/(?:"([^"]+)"|([a-z][a-z0-9-]*))\s*:\s*true/g)) {
      cliCommands.add(`${family} ${vm[1] ?? vm[2]}`);
    }
  }

  for (const module of CLI_INVENTORY_REGISTRAR_MODULES) {
    let moduleSrc: string;
    try {
      moduleSrc = readFileSync(join(repoRoot, module), "utf8");
    } catch {
      failures.push(`drift: could not read ${module} for CLI command inventory`);
      continue;
    }
    const moduleInventory = buildCliCommandInventory(moduleSrc);
    for (const name of moduleInventory.cliCommands) cliCommands.add(name);
    for (const row of moduleInventory.failures) failures.push(`${module}: ${row}`);
  }

  const sddPath = join(repoRoot, "packages/cli/src/sdd-evidence.ts");
  let sddSrc: string;
  try {
    sddSrc = readFileSync(sddPath, "utf8");
  } catch {
    failures.push("drift: could not read packages/cli/src/sdd-evidence.ts for sdd evidence inventory");
    return { failures };
  }
  const fnMatch = sddSrc.match(/export function registerSddEvidenceCommands[\s\S]*?^}/m);
  if (!fnMatch) {
    failures.push("drift: could not locate registerSddEvidenceCommands in sdd-evidence.ts");
    return { failures };
  }
  const subcmds = [...fnMatch[0].matchAll(/\.command\(\s*"([a-z-]+)"\s*\)/g)].map((x) => x[1]);
  if (!subcmds.includes("evidence")) {
    failures.push('drift: registerSddEvidenceCommands missing .command("evidence")');
  } else {
    cliCommands.add("sdd evidence");
    if (subcmds.includes("capture")) {
      cliCommands.add("sdd evidence capture");
    }
    if (subcmds.includes("verify")) {
      cliCommands.add("sdd evidence verify");
    }
  }
  return { failures };
}

/** 1-based line number for a character index in `text`. */
function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

/**
 * Backticked CLI citations — declared bin plus inventory path. Shared by
 * Engine-check callout bodies and the mstar-use-cli skill scan surface.
 */
export function checkCliCitationsInText(
  rel: string,
  text: string,
  opts: { cliCommands: Set<string>; binNames: string[]; lineBase?: number },
): { cliCitationsChecked: number; failures: string[] } {
  const failures: string[] = [];
  let cliCitationsChecked = 0;
  const bins = new Set(opts.binNames);
  const lineBase = opts.lineBase ?? 0;

  const citationRe = /`([a-z][a-z0-9-]*)[ \t]+([a-z][a-z0-9-]*(?:[ \t]+[a-z][a-z0-9-]*)*)/g;
  for (const cm of text.matchAll(citationRe)) {
    const bin = cm[1];
    const tokens = cm[2]!.trim().split(/[ \t]+/);
    if (!bins.has(bin)) {
      // Shorthand like `persist get` (no bin) and fence-tag artifacts are not CLI citations.
      if (!bin.startsWith("mstar")) continue;
      const line = lineBase + lineNumberAt(text, cm.index ?? 0);
      failures.push(
        `${rel}:${line} citation binary "${bin}" is not a declared CLI bin (${opts.binNames.join(" | ")})`,
      );
      continue;
    }
    cliCitationsChecked++;
    const line = lineBase + lineNumberAt(text, cm.index ?? 0);
    const unknownPath = validateCliCommandTokens(opts.cliCommands, tokens);
    if (unknownPath !== null) {
      failures.push(
        `${rel}:${line} citation references unknown CLI command "${bin} ${unknownPath}" (known: ${[...opts.cliCommands].sort().join(", ")})`,
      );
    }
  }

  return { cliCitationsChecked, failures };
}

export type UseCliSkillScanResult = {
  filesScanned: number;
  cliCitationsChecked: number;
  failures: string[];
};

/** Recursively collect `ext` files under `join(repoRoot, dir)` (not process cwd). */
function collectFilesUnder(repoRoot: string, dir: string, ext: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
  for (const entry of entries) {
    const relDir = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFilesUnder(repoRoot, relDir, ext));
    } else if (entry.name.endsWith(ext)) {
      out.push(join(repoRoot, relDir));
    }
  }
  return out;
}

/** Every `.md` file under skills/mstar-use-cli/ for Guard 1 forward.
 * Guard-or-clear-error (mirrors `readRolesCorpus` / `readDeclaredBins`): a
 * missing skill tree, an unreadable traversal, a read failure, or zero
 * markdown files each return explicit failure rows — never an empty scan
 * that lets the guard pass silently. */
export function readUseCliSkillMarkdown(
  repoRoot: string,
): { files: Array<{ rel: string; text: string }>; failures: string[] } {
  const failures: string[] = [];
  const skillDirAbs = join(repoRoot, USE_CLI_SKILL_DIR);
  try {
    if (!statSync(skillDirAbs).isDirectory()) {
      failures.push(
        `drift: ${USE_CLI_SKILL_DIR} exists but is not a directory (use-cli skill scan skipped)`,
      );
      return { files: [], failures };
    }
  } catch {
    failures.push(`drift: ${USE_CLI_SKILL_DIR} is missing (use-cli skill scan skipped)`);
    return { files: [], failures };
  }

  let paths: string[];
  try {
    paths = collectFilesUnder(repoRoot, USE_CLI_SKILL_DIR, ".md");
  } catch (error) {
    failures.push(`use-cli: traverse ${USE_CLI_SKILL_DIR} - ${(error as Error).message}`);
    return { files: [], failures };
  }
  if (paths.length === 0) {
    failures.push(`drift: ${USE_CLI_SKILL_DIR} contains no .md files (use-cli skill scan skipped)`);
    return { files: [], failures };
  }

  const files: Array<{ rel: string; text: string }> = [];
  for (const file of paths) {
    const rel = relative(repoRoot, file);
    try {
      files.push({ rel, text: readFileSync(file, "utf8") });
    } catch (error) {
      failures.push(`use-cli: read ${rel} - ${(error as Error).message}`);
    }
  }
  return { files, failures };
}

/** Guard 1 forward — full-text CLI citations in skills/mstar-use-cli/**. */
export function checkUseCliSkillCliCitations(
  files: Array<{ rel: string; text: string }>,
  opts: { cliCommands: Set<string>; binNames: string[] },
): UseCliSkillScanResult {
  const failures: string[] = [];
  let cliCitationsChecked = 0;
  for (const { rel, text } of files) {
    const row = checkCliCitationsInText(rel, text, opts);
    cliCitationsChecked += row.cliCitationsChecked;
    failures.push(...row.failures);
  }
  return { filesScanned: files.length, cliCitationsChecked, failures };
}

/** Declared CLI bin names — the manifest is SSOT, never a hardcoded list.
 * Guard-or-clear-error (mirrors `readRolesCorpus`): a missing / corrupt /
 * bin-less manifest returns one explicit failure row, never a silent skip —
 * with no declared bins the prefix check would flood every citation. */
export function readDeclaredBins(
  manifestPath: string,
): { binNames: string[]; failures: string[] } {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    return {
      binNames: [],
      failures: [`drift: could not read CLI manifest at ${manifestPath} (declared-bin prefix check skipped)`],
    };
  }
  let cliManifest: { bin?: Record<string, string> };
  try {
    cliManifest = JSON.parse(raw) as { bin?: Record<string, string> };
  } catch {
    return {
      binNames: [],
      failures: [`drift: CLI manifest at ${manifestPath} is not valid JSON (declared-bin prefix check skipped)`],
    };
  }
  const binNames = Object.keys(cliManifest.bin ?? {});
  if (binNames.length === 0) {
    return {
      binNames: [],
      failures: [`drift: CLI manifest at ${manifestPath} declares no bin names (declared-bin prefix check skipped)`],
    };
  }
  return { binNames, failures: [] };
}

/**
 * Guard 1 forward half — every `**Engine check (when available):**`
 * blockquote run in a skill file. Backticked CLI citations
 * (`mstar status validate`, `mstar-harness dispatch validate`, …) must
 * reference a **declared CLI bin** (the caller passes the `bin` names read
 * from packages/cli/package.json — the manifest is SSOT, never hardcoded)
 * and a real `.command()` path from the CLI inventory; engine imports in
 * the same callout must reference real engine exports. One failure row per
 * violation. Load-bearing: an undeclared binary prefix (e.g. `mstarr`)
 * fails drift-lint (regression-pinned by scripts/drift-lint.test.ts).
 */
export function checkEngineCallouts(
  files: Array<{ rel: string; text: string }>,
  opts: { cliCommands: Set<string>; engineExports: Set<string>; binNames: string[] },
): EngineCalloutResult {
  const failures: string[] = [];
  let calloutsChecked = 0;
  let cliCitationsChecked = 0;

  for (const { rel, text } of files) {
    const lines = text.split(/\r?\n/);

 // Blockquote runs: consecutive lines starting with `>`.
    const runs: Array<{ start: number; end: number; text: string }> = [];
    let runStart = -1;
    for (let i = 0; i <= lines.length; i++) {
      const isQuote = i < lines.length && lines[i].trimStart().startsWith(">");
      if (isQuote && runStart === -1) runStart = i;
      if (!isQuote && runStart !== -1) {
        runs.push({ start: runStart, end: i - 1, text: lines.slice(runStart, i).join("\n") });
        runStart = -1;
      }
    }

    for (const run of runs) {
      if (!run.text.includes("**Engine check (when available):**")) continue;
      calloutsChecked++;

      const cited = checkCliCitationsInText(rel, run.text, {
        cliCommands: opts.cliCommands,
        binNames: opts.binNames,
        lineBase: run.start,
      });
      cliCitationsChecked += cited.cliCitationsChecked;
      for (const row of cited.failures) {
        failures.push(row.replace(" citation references ", " callout references "));
      }

      for (const im of run.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@mstar-harness\/engine"/g)) {
        for (const raw of im[1].split(",")) {
 // Strip TS import modifiers so `import { type Foo }` / `import {
 // Foo as Bar }` resolve to the exported name `Foo`.
          const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
          if (name && !opts.engineExports.has(name)) {
            failures.push(`${rel}:${run.start + 1} callout imports unknown engine export "${name}"`);
          }
        }
      }
    }
  }

  return { calloutsChecked, cliCitationsChecked, failures };
}

/**
 * Guard 6 — Engine-check callout dedup ( * each contract's `**Engine check (when available):**` callout must
 * live in exactly one skill file. A normalized body appearing in >1 file is
 * a violation (one failure row naming every site) — the drift this guard
 * exists to catch is a copy of a canonical callout landing at a second site
 * and then drifting bilingual (Chinese `或 import` vs English `or import`).
 *
 * Normalization is deliberately light: strip the blockquote prefix, collapse
 * whitespace, and map the bilingual variant `或 import` → `or import`. The
 * trailing "On `fail` -> do not proceed" clause is part of the body, so a
 * pointer that re-runs the canonical sentence with a different tail still
 * fails; one-line pointers that carry no `**Engine check (when available):**`
 * marker are naturally exempt (they are not callouts at all).
 */
export function checkCalloutDuplication(
  files: Array<{ rel: string; text: string }>,
): { failures: string[] } {
  const failures: string[] = [];
  const bodies = new Map<string, Array<{ rel: string; line: number }>>();

  const normalize = (runText: string): string =>
    runText
      .split(/\r?\n/)
      .map((line) => line.trimStart().replace(/^>\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/或 import/g, "or import")
      .trim();

  for (const { rel, text } of files) {
    const lines = text.split(/\r?\n/);

 // Blockquote runs: consecutive lines starting with `>` (same run
 // splitter as checkEngineCallouts).
    let runStart = -1;
    for (let i = 0; i <= lines.length; i++) {
      const isQuote = i < lines.length && lines[i].trimStart().startsWith(">");
      if (isQuote && runStart === -1) runStart = i;
      if (!isQuote && runStart !== -1) {
        const runText = lines.slice(runStart, i).join("\n");
        const line = runStart + 1;
        runStart = -1;
        if (!runText.includes("**Engine check (when available):**")) continue;
        const body = normalize(runText);
        if (!bodies.has(body)) bodies.set(body, []);
        bodies.get(body)!.push({ rel, line });
      }
    }
  }

  for (const [body, sites] of bodies) {
    if (sites.length < 2) continue;
    const at = sites.map((s) => `${s.rel}:${s.line}`).join(", ");
    failures.push(`Engine-check callout body duplicated at ${at}:\n    ${body}`);
  }

  return { failures };
}

/* ------------------------------------------------------------------ */
/* Guard 7 helpers: repo text-face provenance scan */
/* ------------------------------------------------------------------ */

/** Guard 7 result: scanned tracked-text files plus one failure row per
 * provenance citation. */
export type ProvenanceScanResult = {
  filesScanned: number;
  citationsFound: number;
  failures: string[];
};

/**
 * Guard 7 exemption set — the single place provenance-scan exemptions
 * live (no scattered path strings at call sites). Why each entry exists:
 * - dirs `node_modules` / `dist` / `.git` / `.worktrees` / `.mstar` /
 *   `.tmp`: not tracked text face (installed deps, build output, git
 *   object database, sibling checkouts, the gitignored local harness root,
 *   disposable local scratch).
 * - `.changes/archive`: assembled release record — archived change
 *   fragments are appended verbatim into the changelog at release time,
 *   so they legitimately carry the ids of already-shipped changes; the
 *   guard polices new prose, not the historical record.
 * - files `CHANGELOG.md` / `CHANGELOG_CN.md` (any depth): assembled
 *   release surfaces generated from `.changes/` fragments — same
 *   historical-record rationale.
 */
const PROVENANCE_SCAN_EXEMPTS = {
  dirs: ["node_modules", "dist", ".git", ".worktrees", ".mstar", ".tmp"],
  archivedDir: ".changes/archive",
  files: new Set(["CHANGELOG.md", "CHANGELOG_CN.md"]),
};

/** Scan-face extension whitelist: `.ts` is scanned at comment lines only,
 * `.md` full text. Other extensions (lockfiles, build metadata, test
 * fixture data like the engine's JSON corpora) are not on the face. */
const PROVENANCE_SCAN_EXTS = [".ts", ".md"];

/** First `//` in `line` that starts a real trailing comment — mask-then-
 * detect: `mask` is the file-level commentMask of the whole text (`base` is
 * `line`'s offset in it), and the first `//` the mask marks as comment
 * content that is not part of a `://` URL sequence is the comment start (no
 * whitespace requirement, so `statement;// comment` qualifies). Returns -1
 * when no occurrence qualifies. simplify: detection inherits commentMask's
 * own ceiling — the regex-vs-division heuristic documented in
 * scripts/ascii-literal-utils.ts. */
function trailingCommentStart(line: string, mask: Uint8Array, base: number): number {
  let idx = line.indexOf("//");
  while (idx !== -1) {
    if (mask[base + idx] === 1 && line[idx - 1] !== ":") return idx;
    idx = line.indexOf("//", idx + 1);
  }
  return -1;
}

/** Line-level comment prefilter for the `.ts` scan face: keep lines whose
 * trimmed text starts with a comment introducer — `*` (block-comment
 * continuation and close; the same line-level heuristic as the engine's
 * COMMENT_INTRODUCER, kept unconditional), or `//` / `/*` when
 * commentMask confirms real comment content — plus the trailing-comment
 * fragment of code lines (from the first `//` the mask marks as a real
 * comment and that is not part of a `://` URL sequence —
 * trailingCommentStart). Every other line is blanked so citation line
 * numbers stay the real file lines. The mask is computed once over the
 * whole text, so a `//` or `/*` inside a template literal (backtick spans,
 * including multi-line and `${}` expressions) or a quoted string is never
 * taken for a comment introducer. simplify: the introducer test stays a
 * line-level first-token heuristic on top of the mask; residual ceilings =
 * the unconditional `*` line (over-inclusive once its block comment has
 * closed) and commentMask's own regex-vs-division heuristic
 * (scripts/ascii-literal-utils.ts). */
function tsCommentLines(text: string): string {
  const mask = commentMask(text);
  const out: string[] = [];
  let base = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    const intro = line.length - trimmed.length;
    const introducer =
      trimmed.startsWith("*") ||
      ((trimmed.startsWith("//") || trimmed.startsWith("/*")) && mask[base + intro] === 1);
    if (introducer) {
      out.push(line);
    } else {
      const idx = trailingCommentStart(line, mask, base);
      out.push(idx === -1 ? "" : line.slice(idx));
    }
    // Advance past the line plus its real separator (`\r\n` counts 2); the
    // final line has none — the overshoot is never read.
    base += line.length + (text.charCodeAt(base + line.length) === 13 ? 2 : 1);
  }
  return out.join("\n");
}

/** Tracked-file set at `repoRoot` (`git ls-files -z` with cwd = `repoRoot`).
 * NUL-delimited output preserves every legal Git path, including embedded
 * newlines. Guard-or-clear-error: a git failure returns one explicit failure
 * row and an empty set, so callers skip tracked-file scans with a loud named
 * row instead of crashing or silently passing. Exported as a test seam. */
export function readTrackedFiles(repoRoot: string): {
  tracked: Set<string>;
  failures: string[];
} {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", cwd: repoRoot });
    return {
      tracked: new Set(out.split("\0").filter(Boolean)),
      failures: [],
    };
  } catch (error) {
    return {
      tracked: new Set(),
      failures: [`provenance: git ls-files failed at ${repoRoot} - ${(error as Error).message}`],
    };
  }
}

/** Guard 7 collection — walk `repoRoot` for the `.ts`/`.md` scan face,
 * pruning exemption dirs during traversal (the same PROVENANCE_SCAN_EXEMPTS
 * the scan filters by; pruning only avoids reading ignored/derived trees).
 * The walk is intersected with `tracked` (repo-root-relative paths from
 * `git ls-files`, readTrackedFiles): untracked local files cannot leak into
 * committed history, so they must not fail the guard. Reads are
 * guard-or-clear-error (same pattern as `readRolesCorpus`): an unreadable
 * file — or an unlistable directory, which is skipped rather than walked —
 * becomes an explicit `provenance: read` row, never a raw crash mid-scan.
 * Exported as a test seam over temp trees with an injected tracked-set. */
export function collectProvenanceScanFiles(
  repoRoot: string,
  tracked: Set<string>,
): {
  entries: Array<{ rel: string; text: string }>;
  readFailures: string[];
} {
  const entries: Array<{ rel: string; text: string }> = [];
  const readFailures: string[] = [];
  const walk = (absDir: string) => {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      );
    } catch (error) {
      // Guard-or-clear-error, same idiom as the file-read branch: an
      // unlistable directory (e.g. permission-denied scratch) becomes an
      // explicit row and is skipped, never a raw crash that loses the
      // accumulated report.
      readFailures.push(`provenance: read ${relative(repoRoot, absDir)} - ${(error as Error).message}`);
      return;
    }
    for (const entry of dirents) {
      const abs = join(absDir, entry.name);
      const rel = relative(repoRoot, abs);
      if (entry.isDirectory()) {
        if (PROVENANCE_SCAN_EXEMPTS.dirs.includes(entry.name)) continue;
        if (rel === PROVENANCE_SCAN_EXEMPTS.archivedDir) continue;
        walk(abs);
      } else if (tracked.has(rel) && PROVENANCE_SCAN_EXTS.some((ext) => entry.name.endsWith(ext))) {
        try {
          entries.push({ rel, text: readFileSync(abs, "utf8") });
        } catch (error) {
          readFailures.push(`provenance: read ${rel} - ${(error as Error).message}`);
        }
      }
    }
  };
  walk(repoRoot);
  return { entries, readFailures };
}

/**
 * Guard 7 — repo-wide provenance scan over the collected text face:
 * `.md` entries are scanned full text, `.ts` entries at comment lines only
 * (tsCommentLines prefilter), exemption surfaces are skipped, and every
 * engine findProvenanceCitations hit becomes a `${rel}:${line}` failure
 * row (same row idiom as the ephemeral-citation guard). No guard-level
 * dedup or extra exemptions: sdd deeplinks stay exclusively attributed to
 * the ephemeral check by the finder contract, so the two guards cannot
 * double-report. Load-bearing: a dated plan id or a dated-instance
 * non-sdd harness deeplink on the face fails drift-lint; sdd deeplinks
 * are policed by the ephemeral check over the skills corpus, not here
 * (regression-pinned by scripts/drift-lint.test.ts).
 */
export function checkProvenanceScan(files: Array<{ rel: string; text: string }>): ProvenanceScanResult {
  const failures: string[] = [];
  let filesScanned = 0;
  let citationsFound = 0;
  for (const { rel, text } of files) {
    const segments = rel.split("/");
    if (segments.some((s) => PROVENANCE_SCAN_EXEMPTS.dirs.includes(s))) continue;
    if (rel.startsWith(`${PROVENANCE_SCAN_EXEMPTS.archivedDir}/`)) continue;
    if (PROVENANCE_SCAN_EXEMPTS.files.has(segments[segments.length - 1])) continue;
    const ext = PROVENANCE_SCAN_EXTS.find((e) => rel.endsWith(e));
    if (!ext) continue;
    filesScanned++;
    const scanText = ext === ".ts" ? tsCommentLines(text) : text;
    const citations = findProvenanceCitations(scanText);
    if (citations.length === 0) continue;
    citationsFound += citations.length;
    for (const c of citations) {
      failures.push(
        `${rel}:${c.line} provenance citation "${c.match}" (${c.kind}) — tracked text must not disclose local plan/iteration ids or harness deep paths (use synthetic forms)`,
      );
    }
  }
  return { filesScanned, citationsFound, failures };
}

if (import.meta.main) {
 /* ------------------------------------------------------------------ */
 /* Engine export inventory (packages/engine/src/index.ts) */
 /* ------------------------------------------------------------------ */

  const engineIndex = readFileSync(join(root, "packages/engine/src/index.ts"), "utf8");
  const engineExports = buildEngineExportNames(engineIndex);
  if (engineExports.size === 0) {
    console.error("drift: could not parse any exports from packages/engine/src/index.ts");
    process.exit(1);
  }

 /* ------------------------------------------------------------------ */
 /* CLI command inventory (packages/cli/src/index.ts `.command(...)`) */
 /* ------------------------------------------------------------------ */

  const cliSrc = readFileSync(join(root, "packages/cli/src/index.ts"), "utf8");
  const { cliCommands, failures: cliInventoryFailures } = buildCliCommandInventory(cliSrc);
  for (const row of cliInventoryFailures) fail(row);
  for (const row of supplementCliCommandInventory(cliCommands, root).failures) fail(row);

 /* ------------------------------------------------------------------ */
 /* Forward: skill callouts → engine exports + CLI commands + bins */
 /* ------------------------------------------------------------------ */

  const skillFiles = collectFiles("skills", ".md");

 // Declared CLI bin names — the manifest is SSOT, never a hardcoded list.
 // A missing / corrupt / bin-less manifest is a loud failure row; with no
 // declared bins the prefix check would flood every citation, so the
 // callout scan is skipped (guard-or-clear-error) — the separate
 // import-statement loop below still runs for engine exports.
  const { binNames, failures: manifestFailures } = readDeclaredBins(
    join(root, "packages/cli/package.json"),
  );
  for (const row of manifestFailures) fail(row);

  const forward =
    manifestFailures.length === 0
      ? checkEngineCallouts(
          skillFiles.map((file) => ({ rel: relative(root, file), text: readFileSync(file, "utf8") })),
          { cliCommands, engineExports, binNames },
        )
      : { calloutsChecked: 0, cliCitationsChecked: 0, failures: [] as string[] };
  calloutsChecked += forward.calloutsChecked;
  cliCitationsChecked += forward.cliCitationsChecked;
  for (const row of forward.failures) fail(row);

  const { files: useCliFiles, failures: useCliReadFailures } = readUseCliSkillMarkdown(root);
  for (const row of useCliReadFailures) fail(row);
  const useCliScan =
    manifestFailures.length === 0 && useCliReadFailures.length === 0
      ? checkUseCliSkillCliCitations(useCliFiles, { cliCommands, binNames })
      : { filesScanned: useCliFiles.length, cliCitationsChecked: 0, failures: [] as string[] };
  cliCitationsChecked += useCliScan.cliCitationsChecked;
  for (const row of useCliScan.failures) fail(row);

 // Guard 6: Engine-check callout dedup — the same normalized callout body
 // must not appear in more than one file (canonical copy + pointers; a
 // re-vendored copy with a divergent tail drifts bilingual and fails).
  for (const row of checkCalloutDuplication(
    skillFiles.map((file) => ({ rel: relative(root, file), text: readFileSync(file, "utf8") })),
  ).failures) {
    fail(row);
  }

 // Import statements anywhere in a skill file must reference real exports.
  for (const file of skillFiles) {
    const rel = relative(root, file);
    const text = readFileSync(file, "utf8");
    for (const im of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@mstar-harness\/engine"/g)) {
      for (const raw of im[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name && !engineExports.has(name)) {
          fail(`${rel}: import of unknown engine export "${name}"`);
        }
      }
    }
  }

 /* ------------------------------------------------------------------ */
 /* Reverse: engine module spec citations → skill files */
 /* ------------------------------------------------------------------ */

  /**
 * Non-skill spec sources the engine legitimately cites: generated artifact
 * types (`main.md`, `task-N-report.md`, …), root convention docs
 * (`STRATEGY.md`, `README.md`, …) and review-bundle files (`qcN.md`). These
 * are not skill files — existence is not expected under skills/.
 */
  const ARTIFACT_SPEC_SOURCES = new Set([
    "main.md",
    "task-N-report.md",
    "STRATEGY.md",
    "delivery-compass.md",
    "README.md",
    "CONCEPTS.md",
    "DESIGN.md",
    "DESIGN.dark.md",
    "qc1.md",
    "qc2.md",
    "qc3.md",
    "qc-consolidated.md",
    "schema.yaml",
  ]);

  const engineModules = collectFiles("packages/engine/src", ".ts").filter(
    (f) => !f.endsWith("/index.ts"),
  );
  const skillRefFiles = collectFiles("skills", ".md").map((f) => relative(root, f));
  const yamlRefs = collectFiles("skills", ".yaml").map((f) => relative(root, f));
  const allSkillFiles = new Set([...skillRefFiles, ...yamlRefs]);

  for (const file of engineModules) {
    const rel = relative(root, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);

 // Header block: contiguous comment lines at the top of the file.
    const header: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (header.length === 0 && (t === "" || t.startsWith("/*") || t.startsWith("//") || t.startsWith("*"))) {
        if (t !== "" || header.length > 0) header.push(line);
        if (t.startsWith("*/")) break;
      } else if (header.length > 0 && (t === "" || t.startsWith("*"))) {
        header.push(line);
        if (t.startsWith("*/")) break;
      } else if (header.length > 0) {
        break;
      } else {
        break;
      }
    }
    const headerText = header.join("\n");
    if (!/Spec|spec/.test(headerText)) continue;

 // Explicit skill paths: skills/<skill>/SKILL.md
    for (const sm of headerText.matchAll(/skills\/(mstar-[\w-]+)\/SKILL\.md/g)) {
      const p = `skills/${sm[1]}/SKILL.md`;
      if (!exists(p)) fail(`${rel}: spec citation "${p}" does not exist`);
    }
 // "<skill> SKILL.md" / "<skill> SKILL" token forms
    for (const sm of headerText.matchAll(/`?(mstar-[\w-]+)`?\s+SKILL(?:\.md)?/g)) {
      const p = `skills/${sm[1]}/SKILL.md`;
      if (!exists(p)) fail(`${rel}: spec citation "${p}" does not exist`);
    }
 // "<skill>/references/<file>" and "<skill> `references/<file>`" forms
    for (const sm of headerText.matchAll(/`?(mstar-[\w-]+)`?\s*(?:\/|\s+)`?references\/([\w.-]+)/g)) {
      const p = `skills/${sm[1]}/references/${sm[2]}`;
      if (!exists(p)) fail(`${rel}: spec citation "${p}" does not exist`);
    }
 // Bare "references/<file>" citations (no skill token): must exist under
 // some skill.
    for (const rm of headerText.matchAll(/references\/([\w.-]+)/g)) {
      const candidates = [...allSkillFiles].filter((f) => f.endsWith(`/references/${rm[1]}`));
      if (candidates.length === 0) {
        fail(`${rel}: spec citation "references/${rm[1]}" does not exist under any skill`);
      }
    }
 // Bare "<file>.md"/"<file>.yaml" next to a spec marker ("spec:" / "§"):
 // must resolve under skills/, or be a known artifact-type spec source.
    for (const bm of headerText.matchAll(/(?<![-\w])([a-zA-Z0-9][\w-]*\.(?:md|yaml))/g)) {
      const name = bm[1];
      if (name === "SKILL.md") continue;
      const nearSpec = headerText.slice(Math.max(0, bm.index - 60), (bm.index ?? 0) + name.length + 60);
      if (!/spec|§/.test(nearSpec)) continue;
      if (citesKnowledgeConventions(headerText, bm.index)) continue;
      if ([...allSkillFiles].some((f) => f.endsWith(`/${name}`))) continue;
      if (ARTIFACT_SPEC_SOURCES.has(name)) continue;
      fail(`${rel}: spec citation "${name}" does not exist under skills/ and is not a known artifact spec source`);
    }
  }

 /* ------------------------------------------------------------------ */
 /* Guard 1: `/codebase-audit` docs tokens ↔ engine AUDIT_CATEGORIES */
 /* ------------------------------------------------------------------ */

  /**
 * Category tokens in docs must be real `AUDIT_CATEGORIES` members, and
 * the migrated checks-and-lints row must enumerate the full set:
 * - skills/mstar-use-cli/references/checks-and-lints.md: the `<category>`
 * keyword-table row (set equality — a fabricated token like `deps` fails,
 * and so does an omission such as a missing `bug` / `direction`).
 * - README.md / README_CN.md: the category-focus list in the audit usage
 * line ("category focus (…)" / "按类别聚焦（…）") — membership only,
 * the list is illustrative (`…`).
 * Only lowercase-kebab tokens are scanned (`^[a-z][a-z-]*$`); the
 * placeholder `<category>` cell and the plan-field reference `Category`
 * are not category codes.
 */
  const auditCategories = new Set<string>(AUDIT_CATEGORIES);
  let categoryTokensChecked = 0;

  {
    const file = AUDIT_CATEGORY_DOC;
    if (!exists(file)) {
      fail(`${file}: missing audit category doc (expected the migrated <category> row)`);
    } else {
      const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
      const rowIdx = lines.findIndex((l) => /^\|\s*`<category>`\s*\|/.test(l));
      if (rowIdx === -1) {
        fail(`${file}: could not locate the \`<category>\` keyword-table row (expected a row starting with \`| \`<category>\` |\`)`);
      } else {
        const tokens = extractCategoryRowTokens(lines[rowIdx]);
        categoryTokensChecked += tokens.length;
        for (const t of tokens) {
          if (!auditCategories.has(t)) {
            fail(`${file}:${rowIdx + 1} category token "${t}" is not an AUDIT_CATEGORY (valid: ${AUDIT_CATEGORIES.join(", ")})`);
          }
        }
        for (const c of AUDIT_CATEGORIES) {
          if (!tokens.includes(c)) {
            fail(`${file}:${rowIdx + 1} category table omits AUDIT_CATEGORY "${c}" — add \`${c}\` to the <category> row`);
          }
        }
      }
    }
  }

  for (const file of ["README.md", "README_CN.md"]) {
    const text = readFileSync(join(root, file), "utf8");
    const fm = text.match(/(?:category\s+focus|按类别聚焦)\s*[（(]([^）)]*)[）)]/i);
    if (!fm) {
      fail(`${file}: could not locate the category-focus list (expected "category focus (\`a\`, \`b\`, …)" / "按类别聚焦（…）")`);
      continue;
    }
    const line = text.slice(0, fm.index ?? 0).split(/\r?\n/).length;
    for (const t of fm[1].matchAll(/`([^`]+)`/g)) {
      categoryTokensChecked++;
      if (!auditCategories.has(t[1])) {
        fail(`${file}:${line} category token "${t[1]}" is not an AUDIT_CATEGORY (valid: ${AUDIT_CATEGORIES.join(", ")})`);
      }
    }
  }

 /* ------------------------------------------------------------------ */
 /* Guard 2: README.md / README_CN.md bilingual pairing (AGENTS.md) */
 /* ------------------------------------------------------------------ */

  const outcome = evaluateBilingualGuard(changedFilesSinceMergeBase());
  let bilingualStatus = "skipped (no git range)";
  if (outcome.status === "checked") {
    bilingualStatus = "checked";
    for (const line of outcome.failures) fail(line);
 // Content parity (S-f): the pairing check is presence-only; when both
 // READMEs changed, their change-set sizes must mirror each other.
    const changeStats = changedFileStatsSinceMergeBase();
    if (changeStats) {
      for (const line of checkBilingualContentParity(changeStats)) fail(line);
    }
  } else if (outcome.status === "failed") {
    bilingualStatus = "failed (no git range in CI)";
    for (const line of outcome.failures) fail(line);
  } else {
    bilingualStatus = `skipped (${outcome.reason})`;
  }

 /* ------------------------------------------------------------------ */
 /* Guard 3: skills corpus — ephemeral citations (engine lint) */
 /* ------------------------------------------------------------------ */

  let ephemeralFilesScanned = 0;
  let ephemeralCitationsFound = 0;
  for (const file of skillFiles) {
    ephemeralFilesScanned++;
    const citations = findEphemeralCitations(readFileSync(file, "utf8"));
    if (citations.length === 0) continue;
    ephemeralCitationsFound += citations.length;
    const rel = relative(root, file);
    for (const c of citations) {
      fail(`${rel}:${c.line} ephemeral citation "${c.match}" (${c.kind}) — concrete task artifacts / SDD deeplinks must not appear in durable skill text`);
    }
  }

 /* ------------------------------------------------------------------ */
 /* Guard 4: skills corpus — roles / load-order (engine lint) */
 /* ------------------------------------------------------------------ */

  const { entries: rolesEntries, readFailures: rolesReadFailures } = readRolesCorpus(skillFiles, root);
  for (const row of rolesReadFailures) fail(row);
  const roles = checkRolesCorpus(rolesEntries, join(root, "skills", "mstar-roles"));
  for (const row of roles.failures) fail(row);

 /* ------------------------------------------------------------------ */
 /* Guard 5: skills corpus — five-question runtime smoke */
 /* ------------------------------------------------------------------ */

  const fiveQuestion = checkFiveQuestionCorpus(
    skillFiles.map((file) => ({ rel: relative(root, file), text: readFileSync(file, "utf8") })),
  );
  for (const row of fiveQuestion.failures) fail(row);

 /* ------------------------------------------------------------------ */
 /* Guard 7: repo text face — provenance citations (engine lint) */
 /* ------------------------------------------------------------------ */

  const tracked = readTrackedFiles(root);
  for (const row of tracked.failures) fail(row);
 // A git failure skips both tracked-file scans behind its loud named row:
 // neither an unfiltered walk nor an empty-success scan is permitted.
  const provenanceCollection =
    tracked.failures.length === 0
      ? collectProvenanceScanFiles(root, tracked.tracked)
      : { entries: [], readFailures: [] as string[] };
  for (const row of provenanceCollection.readFailures) fail(row);
  const provenance = checkProvenanceScan(provenanceCollection.entries);
  for (const row of provenance.failures) fail(row);

 /* ------------------------------------------------------------------ */
 /* Guard 8: tracked Markdown links and anchors */
 /* ------------------------------------------------------------------ */

  const markdownLinks =
    tracked.failures.length === 0
      ? checkMarkdownLinks(root, tracked.tracked)
      : { filesScanned: 0, linksChecked: 0, anchorsChecked: 0, skipped: {}, diagnostics: [] };
  for (const diagnostic of markdownLinks.diagnostics) {
    fail(
      `${diagnostic.source}:${diagnostic.line} markdown link ${diagnostic.kind} "${diagnostic.rawTarget}"`,
    );
  }

 /* ------------------------------------------------------------------ */

 // Guard 4 footer fragment: report each check's own verdict + count so a
 // load-order-only failure is never misstated as a combined/OK status.
  const rolesSummary = `${roles.skillsChecked} mstar-* skills load-order lint ${
    roles.loadOrderViolations === 0
      ? "OK"
      : `FAIL (${roles.loadOrderViolations} violation${roles.loadOrderViolations === 1 ? "" : "s"})`
  }; roles mapping ${
    roles.mappingViolations === 0 ? "OK" : `FAIL (${roles.mappingViolations} violation${roles.mappingViolations === 1 ? "" : "s"})`
  }`;

  const markdownLinksSummary = `Guard 8 Markdown links ${markdownLinks.filesScanned} files scanned, ${markdownLinks.linksChecked} links resolved, ${markdownLinks.anchorsChecked} anchors checked, ${markdownLinks.diagnostics.length} diagnostics`;

  if (failures.length > 0) {
    console.error(`drift-lint: ${failures.length} violation(s) found\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(
      `\nchecked ${calloutsChecked} Engine-check callouts (${cliCitationsChecked} CLI citations prefix-checked against ${binNames.length} declared bins; ${useCliScan.filesScanned} use-cli skill files with ${useCliScan.cliCitationsChecked} full-text citations) against ${engineExports.size} engine exports and ${cliCommands.size} CLI commands; ${categoryTokensChecked} audit category tokens; README bilingual pairing ${bilingualStatus}; ${ephemeralFilesScanned} skill files (${ephemeralCitationsFound} ephemeral citations); ${rolesSummary}; ${fiveQuestion.checked} runtime mstar-* skills pass five-question lint (${fiveQuestion.failures.length} violations); provenance scan ${provenance.filesScanned} repo text files (${provenance.citationsFound} provenance citations); ${markdownLinksSummary}`,
    );
    process.exit(1);
  }

  console.log(
    `drift-lint: OK — ${calloutsChecked} Engine-check callouts reference real exports (${engineExports.size}) and CLI commands (${cliCommands.size}); ${cliCitationsChecked} CLI citations prefix-checked against ${binNames.length} declared bins (${useCliScan.filesScanned} use-cli skill files, ${useCliScan.cliCitationsChecked} full-text citations); engine spec citations resolve; ${categoryTokensChecked} audit category tokens match AUDIT_CATEGORIES; README bilingual pairing ${bilingualStatus}; ${ephemeralFilesScanned} skill files clean of ephemeral citations; ${rolesSummary}; ${fiveQuestion.checked} runtime mstar-* skills pass five-question lint (${fiveQuestion.failures.length} violations); provenance scan ${provenance.filesScanned} repo text files (${provenance.citationsFound} provenance citations); ${markdownLinksSummary}`,
  );
}
