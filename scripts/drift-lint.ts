#!/usr/bin/env bun
/**
 * drift-lint.ts — roadmap §8.7 item 4 (guards risk R1): pointer callouts in
 * skills/ must reference real engine exports, real CLI subcommands, and a
 * declared CLI bin name, and engine spec-citation comments must resolve to
 * real skill files.
 *
 * Guards added by plan 20260816-mechanical-verification (Task 3):
 *   1. docs audit enum — `/codebase-audit` category tokens in docs/cli.md
 *      (the `<category>` keyword-table row) and README.md / README_CN.md
 *      (the category-focus list) must be real AUDIT_CATEGORIES members;
 *      docs/cli.md must enumerate the full nine (fabrications like `deps`
 *      and omissions like a missing `bug` / `direction` both fail).
 *   2. README bilingual pairing — README.md and README_CN.md must change
 *      together over the committed range merge-base(origin/main, HEAD)..HEAD
 *      (AGENTS.md bilingual rule); skipped silently when git has no range
 *      (local non-commit runs), but a missing range under GITHUB_ACTIONS
 *      fails loudly — the drift-lint CI job checks out with fetch-depth: 0
 *      so origin/main exists and PR runs are the enforcement surface.
 *   3. skills corpus — no ephemeral citations anywhere in the skills/
 *      markdown tree (engine findEphemeralCitations over the full corpus),
 *      turning the manual corpus smoke into a permanent CI guard.
 *   4. roles/load-order corpus (plan 20260816-audit-003-roles-validate-cli
 *      Task 2): every `skills/mstar-*` SKILL.md must declare
 *      `mstar-harness-core` in a Load Order / First action section (engine
 *      `lintLoadOrder`) and the mstar-roles mapping / parameter tables
 *      must resolve against the on-disk `references/<role>.md` layout
 *      (engine `validateRoleMapping` on `skills/mstar-roles`).
 *   5. skills corpus — five-question runtime smoke (plan
 *      20260816-audit-001-five-question-lint Task 2, audit finding 5):
 *      every shipped runtime `skills/mstar-*` SKILL.md (excluding
 *      `mstar-harness-core` and `mstar-skill-authoring`) must pass engine
 *      `lintFiveQuestion` in runtime mode, so the corpus cannot drift out
 *      of five-question alignment without failing CI. Guard numbers are
 *      per-plan locked, not positional.
 *
 * The forward callout citation check (this plan, 20260817-cli-bin-alias
 * Task 2) also validates the **binary prefix** of every backticked CLI
 * citation in Engine-check callouts against the declared `bin` names read
 * from packages/cli/package.json — the manifest is SSOT, never a hardcoded
 * list — closing the blind spot where prose could cite a nonexistent
 * executable while every subcommand path still validated.
 *
 * Engine symbols are imported from the source entry (../packages/engine/
 * src/index.ts), NOT the "@mstar-harness/engine" package specifier: the CI
 * drift-lint job runs `bun run validation:drift` in a fresh checkout with
 * no `bun install`, and the package exports map resolves to the gitignored
 * dist build. The engine source has zero runtime deps, so bun executes it
 * directly.
 *
 * Usage: bun run scripts/drift-lint.ts
 * Exit 0 = no drift; exit 1 = drift found (one line per violation).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AUDIT_CATEGORIES,
  findEphemeralCitations,
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
/* Guard 2 helpers: README bilingual pairing (AGENTS.md)               */
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
 *   no origin/main). Locally this is a legitimate non-commit run and skips
 *   silently; under GITHUB_ACTIONS it is a wiring failure (the drift-lint
 *   job must checkout with fetch-depth: 0 so origin/main exists) and fails
 *   loudly instead of silently skipping.
 * - `changedFiles === []` — range resolved but empty (direct-to-main push
 *   where origin/main == HEAD). Uncovered by design; PR runs are the
 *   enforcement surface, so this skips in CI too.
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
/* Guard 4 helpers: roles/load-order corpus (plan audit-003 Task 2)    */
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
/* Guard 5 helpers: five-question runtime corpus smoke                 */
/* ------------------------------------------------------------------ */

/** Skills exempt from the five-question runtime corpus smoke (mirrors the
 * engine corpus test and the CLI's mode selection): `mstar-harness-core`
 * is exempt by design (hub headings), `mstar-skill-authoring` is the
 * standard's own definition and always lints in authoring/strict mode. */
export const FIVE_QUESTION_CORPUS_EXEMPT: Record<string, true> = {
  "mstar-harness-core": true,
  "mstar-skill-authoring": true,
};

/** Guard 5 result: runtime skills checked (minus the exempt pair) plus
 * one failure row per uncovered question. */
export type FiveQuestionCorpusResult = { checked: number; failures: string[] };

/** Guard 5 — five-question runtime smoke over the shipped `mstar-*`
 * corpus: every `skills/mstar-*` SKILL.md (excluding the exempt pair)
 * must pass `lintFiveQuestion` in runtime mode. Load-bearing: deleting a
 * Step-3 aligned heading or losing runtime alias coverage fails
 * drift-lint (regression-pinned by scripts/drift-lint.test.ts). */
export function checkFiveQuestionCorpus(files: Array<{ rel: string; text: string }>): FiveQuestionCorpusResult {
  const failures: string[] = [];
  let checked = 0;
  for (const { rel, text } of files) {
    const m = rel.match(/^skills\/(mstar-[\w-]+)\/SKILL\.md$/);
    if (!m || FIVE_QUESTION_CORPUS_EXEMPT[m[1]]) continue;
    checked++;
    const result = lintFiveQuestion(stripFrontmatter(text), "runtime");
    for (const v of result.violations) {
      failures.push(`${rel}: five-question runtime smoke ${v.code} - ${v.message}`);
    }
  }
  return { checked, failures };
}

/* ------------------------------------------------------------------ */
/* Guard 1 forward helpers: Engine-check callouts (bin-prefix guard)   */
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
 * `.command("name")` path (single tokens plus `parent child` composites). */
export function buildCliCommandInventory(cliSrc: string): {
  cliCommands: Set<string>;
  failures: string[];
} {
  const cliCommands = new Set<string>();
  const varPaths = new Map<string, string>();
  const failures: string[] = [];
  const commandRe = /(?:const\s+(\w+)\s*=\s*program\s*|(\w+)\s*)\.command\(\s*"([a-z-]+)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = commandRe.exec(cliSrc))) {
    const [, declared, receiver, name] = m;
    if (declared) {
      varPaths.set(declared, name);
      cliCommands.add(name);
    } else if (receiver === "program") {
      cliCommands.add(name);
    } else {
      const parent = varPaths.get(receiver);
      if (parent === undefined) {
        failures.push(`CLI parent of "${receiver}.command("${name}")" is not a known command var`);
        continue;
      }
      cliCommands.add(parent ? `${parent} ${name}` : name);
    }
  }
  return { cliCommands, failures };
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
  const bins = new Set(opts.binNames);

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

      // Backticked CLI citations — anchored to the opening backtick so the
      // prefix capture is exact (prose word pairs are never counted as
      // citations). `<bin> <cmd>` with at most a two-word command path,
      // preserving the pre-existing match surface (`mstar audit scaffold
      // <file>` → prefix `mstar`, path `audit scaffold`).
      for (const cm of run.text.matchAll(/`([a-z][a-z0-9-]*)\s+([a-z-]+(?:\s+[a-z-]+)?)/g)) {
        const bin = cm[1];
        const cmd = cm[2];
        cliCitationsChecked++;
        if (!bins.has(bin)) {
          failures.push(
            `${rel}:${run.start + 1} citation binary "${bin}" is not a declared CLI bin (${opts.binNames.join(" | ")})`,
          );
          continue;
        }
        if (!opts.cliCommands.has(cmd)) {
          failures.push(
            `${rel}:${run.start + 1} callout references unknown CLI command "${bin} ${cmd}" (known: ${[...opts.cliCommands].sort().join(", ")})`,
          );
        }
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

if (import.meta.main) {
  /* ------------------------------------------------------------------ */
  /* Engine export inventory (packages/engine/src/index.ts)               */
  /* ------------------------------------------------------------------ */

  const engineIndex = readFileSync(join(root, "packages/engine/src/index.ts"), "utf8");
  const engineExports = buildEngineExportNames(engineIndex);
  if (engineExports.size === 0) {
    console.error("drift: could not parse any exports from packages/engine/src/index.ts");
    process.exit(1);
  }

  /* ------------------------------------------------------------------ */
  /* CLI command inventory (packages/cli/src/index.ts `.command(...)`)    */
  /* ------------------------------------------------------------------ */

  const cliSrc = readFileSync(join(root, "packages/cli/src/index.ts"), "utf8");
  const { cliCommands, failures: cliInventoryFailures } = buildCliCommandInventory(cliSrc);
  for (const row of cliInventoryFailures) fail(row);

  /* ------------------------------------------------------------------ */
  /* Forward: skill callouts → engine exports + CLI commands + bins      */
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
  /* Reverse: engine module spec citations → skill files                  */
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
  /* Guard 1: `/codebase-audit` docs tokens ↔ engine AUDIT_CATEGORIES     */
  /* ------------------------------------------------------------------ */

  /**
   * Category tokens in docs must be real `AUDIT_CATEGORIES` members, and
   * docs/cli.md must enumerate the full set:
   * - docs/cli.md: the `<category>` keyword-table row (set equality — a
   *   fabricated token like `deps` fails, and so does an omission such as
   *   a missing `bug` / `direction`).
   * - README.md / README_CN.md: the category-focus list in the audit usage
   *   line ("category focus (…)" / "按类别聚焦（…）") — membership only,
   *   the list is illustrative (`…`).
   * Only lowercase-kebab tokens are scanned (`^[a-z][a-z-]*$`); the
   * placeholder `<category>` cell and the plan-field reference `Category`
   * are not category codes.
   */
  const auditCategories = new Set<string>(AUDIT_CATEGORIES);
  let categoryTokensChecked = 0;

  {
    const file = "docs/cli.md";
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
  /* Guard 2: README.md / README_CN.md bilingual pairing (AGENTS.md)      */
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
  /* Guard 3: skills corpus — ephemeral citations (engine lint)          */
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
  /* Guard 4: skills corpus — roles / load-order (engine lint)           */
  /* ------------------------------------------------------------------ */

  const { entries: rolesEntries, readFailures: rolesReadFailures } = readRolesCorpus(skillFiles, root);
  for (const row of rolesReadFailures) fail(row);
  const roles = checkRolesCorpus(rolesEntries, join(root, "skills", "mstar-roles"));
  for (const row of roles.failures) fail(row);

  /* ------------------------------------------------------------------ */
  /* Guard 5: skills corpus — five-question runtime smoke                */
  /* ------------------------------------------------------------------ */

  const fiveQuestion = checkFiveQuestionCorpus(
    skillFiles.map((file) => ({ rel: relative(root, file), text: readFileSync(file, "utf8") })),
  );
  for (const row of fiveQuestion.failures) fail(row);

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

  if (failures.length > 0) {
    console.error(`drift-lint: ${failures.length} violation(s) found\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(
      `\nchecked ${calloutsChecked} Engine-check callouts (${cliCitationsChecked} CLI citations prefix-checked against ${binNames.length} declared bins) against ${engineExports.size} engine exports and ${cliCommands.size} CLI commands; ${categoryTokensChecked} audit category tokens; README bilingual pairing ${bilingualStatus}; ${ephemeralFilesScanned} skill files (${ephemeralCitationsFound} ephemeral citations); ${rolesSummary}; ${fiveQuestion.checked} runtime mstar-* skills pass five-question lint (${fiveQuestion.failures.length} violations)`,
    );
    process.exit(1);
  }

  console.log(
    `drift-lint: OK — ${calloutsChecked} Engine-check callouts reference real exports (${engineExports.size}) and CLI commands (${cliCommands.size}); ${cliCitationsChecked} CLI citations prefix-checked against ${binNames.length} declared bins; engine spec citations resolve; ${categoryTokensChecked} audit category tokens match AUDIT_CATEGORIES; README bilingual pairing ${bilingualStatus}; ${ephemeralFilesScanned} skill files clean of ephemeral citations; ${rolesSummary}; ${fiveQuestion.checked} runtime mstar-* skills pass five-question lint (${fiveQuestion.failures.length} violations)`,
  );
}
