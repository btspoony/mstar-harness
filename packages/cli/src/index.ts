#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { select } from "@inquirer/prompts";
import pc from "picocolors";
import { Command } from "commander";
import {
  assertDefaultBranchProtected,
  assertIndexRows,
  assertLightDarkParity,
  assertQcAlignment,
  assertSddTddTriple,
  assertTriIdentity,
  AUDIT_CATEGORIES,
  AUDIT_EFFORTS,
  AUDIT_PRIORITIES,
  AUDIT_RISKS,
  appendProjectRegisterEntries,
  closeProjectRegisterEntry,
  completenessLevel,
  createFsStore,
  detectHarnessKind,
  detectHost,
  emitGitignoreSnippet,
  evaluatePhaseGate,
  executionModeToN,
  findEphemeralCitations,
  findSimplifyMarkers,
  findTemporaryMarkers,
  findingsCleanupGate,
  GIT_CAPTURE_MAX_BYTES,
  getArtifactStore,
  isReadOnlyAssignmentRole,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  lintFiveQuestion,
  lintFrontmatter,
  lintLoadOrder,
  lintStrategySections,
  loadStoreModule,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseBranchPolicyDirectOnBranch,
  parseCompassFrontmatter,
  planQualityBar,
  PROJECT_REGISTER_FILE,
  promoteAuditPlans,
  pushCadenceProbe,
  resolveHarnessDir,
  resolveProjectDir,
  resolveSkillRoot,
  resolveSpecsDir,
  resolveWorkflowDir,
  reviewPackage,
  scaffoldAuditPlan,
  scanSecrets,
  setArtifactStore,
  supplyChainChecks,
  scaffoldHarness,
  scopeGuard,
  SddScriptError,
  sddWorkspace,
  stripFrontmatter,
  taskBrief,
  techDebtRollup,
  computePrTally,
  prReviewReportPath,
  validatePrReviewReport,
  pickReviewBranchName,
  planReviewPost,
  PR_REVIEW_TIER_BUDGETS,
  preflightChangeset,
  prReviewSeatPrompt,
  prReviewSizing,
  resolvePrReviewTier,
  validateFindingDoc,
  validateAssignmentFields,
  validateDesignTokenFrontmatter,
  validateIntegrationMergeLease,
  validateMstarReviewV1,
  validateProjectRegister,
  validateRoleMapping,
  validateSchemaYaml,
  validateStatus,
  validateStatusV2,
  validateWorkflowSnapshot,
  WORKFLOW_SNAPSHOT_FILE,
  _DEFAULT_PROJECT,
  type ArtifactKind,
  type AuditCategory,
  type AuditEffort,
  type AuditFinding,
  type AuditPriority,
  type AuditRisk,
  type FiveQuestionMode,
  type GateResult,
  type HostId,
  type L1PreDispatchInput,
  type PrReportTarget,
  type ProjectRegisterDoc,
  type QcAlignmentAssignment,
  type MergeClass,
  type PrSizeBand,
  type ReviewChangesetMode,
  type ReviewPostPlan,
  type ToolSignal,
  type ValidationResult,
  type WorktreeTrack,
} from "@mstar-harness/engine";
import { verifyPlanExecutionLease } from "./lease-verify";
import { runMigrateCommand, type MigrateCliOptions } from "./commands/migrate";
import { validateAgentPlugin } from "./agent-plugins";
import { buildModelAssignments } from "./assignment";
import { getAdapter } from "./adapters";
import { defaultDetectVersion, ensureGlobalCli, formatCliDoctorNote } from "./global-cli";
import type { DoctorOptions, InitOptions, PluginValidateOptions, Target } from "./types";
import { SUPPORTED_TARGETS } from "./types";
import { parseCsv, readJson, writeJson, readHarnessVersion, resolveCliPath, resolveProjectRoot } from "./utils";

const packageVersion = readHarnessVersion();

const program = new Command();

function logStep(message: string) {
  console.log(pc.cyan(message));
}

async function pickTargetInteractive() {
  return select<Target>({
    message: "Select install target",
    choices: SUPPORTED_TARGETS.map((target) => ({ name: target, value: target })),
  });
}

function hasExplicitModelFlags(options: InitOptions): boolean {
  return Boolean(
    options.pmModel ||
      options.strategicModels ||
      options.devModels ||
      options.qcModels ||
      options.otherModels,
  );
}

/** Advanced override only \u2014 never calls `opencode models` (avoids silent hangs). */
function resolveExplicitModelAssignments(options: InitOptions) {
  // Trust caller-supplied ids; do not discover/validate against a live model list.
  const allow = (label: string, values: string[] | undefined, max: number, required: boolean) => {
    if (!values?.length) {
      if (required) throw new Error(`${label} is required when any --*-model flag is set.`);
      return [] as string[];
    }
    if (values.length > max) throw new Error(`${label}: pick at most ${max} model(s).`);
    return values;
  };

  return buildModelAssignments({
    pm: allow("pm-model", options.pmModel ? [options.pmModel] : undefined, 1, true),
    strategic: allow("strategic-models", parseCsv(options.strategicModels), 3, true),
    dev: allow("dev-models", parseCsv(options.devModels), 3, true),
    qc: allow("qc-models", parseCsv(options.qcModels), 3, true),
    others: allow("other-models", parseCsv(options.otherModels), 3, true),
  });
}

async function runInit(options: InitOptions) {
  const target = options.target || (options.yes ? "opencode" : await pickTargetInteractive());
  const scope = options.scope || "project";
  const adapter = getAdapter(target);

  if (!options.scope && !options.yes) {
    console.log(pc.dim("Scope not provided; defaulting to project."));
  }

  if (adapter.mode === "install") {
    logStep("Step 2/2 - Run target install flow");
    const installResult = adapter.runInstallInit?.(scope, !!options.dryRun, { noFallbacks: options.noFallbacks });
    if (!installResult) {
      throw new Error(`Adapter ${target} does not implement install init flow.`);
    }
    console.log(pc.green(`Status: ${options.dryRun ? "ready (dry-run)" : "configured"} (${scope})`));
    console.log(`Target: ${target}`);
    console.log(`Install location: ${installResult.location}`);
    for (const note of installResult.notes) {
      console.log(`  - ${note}`);
    }
    ensureGlobalCli({ version: packageVersion, dryRun: !!options.dryRun, noGlobalCli: !!options.noGlobalCli });
    return;
  }

  // OpenCode (and any future config-mode targets): default = schema + plugin only.
  // Skip interactive model picking and `opencode models` discovery (can hang with no output).
  const useExplicitModels = hasExplicitModelFlags(options);
  const assignments = useExplicitModels ? resolveExplicitModelAssignments(options) : {};

  if (useExplicitModels) {
    logStep("Step 3/4 - Apply explicit role model overrides from CLI flags");
  } else {
    logStep("Step 3/4 - Fast setup (schema + plugin; OpenCode default models)");
  }

  logStep("Step 4/4 - Update config");
  const configPath = adapter.resolveConfigPath?.(scope, options.output);
  if (!configPath) throw new Error(`Adapter ${target} does not implement config path resolution.`);
  const current = readJson(configPath);
  const updated = adapter.mutateConfigForInit?.(current, assignments);
  if (!updated) throw new Error(`Adapter ${target} does not implement init mutation.`);

  const checkErrors = adapter.validateConfig?.(updated) || [];
  if (checkErrors.length) {
    throw new Error(`Configuration verification failed:\n- ${checkErrors.join("\n- ")}`);
  }

  if (!options.dryRun) {
    writeJson(configPath, updated);
    const persistedErrors = adapter.validateConfig?.(readJson(configPath)) || [];
    if (persistedErrors.length) {
      throw new Error(`Post-write verification failed:\n- ${persistedErrors.join("\n- ")}`);
    }
  }

  console.log(pc.green(`Status: ${options.dryRun ? "ready (dry-run)" : "configured"} (${scope})`));
  console.log(`Target: ${target}`);
  console.log(`Config file: ${configPath}`);
  if (adapter.printPostSetupSummary) adapter.printPostSetupSummary(updated);
  if (Object.keys(assignments).length) {
    console.log("Assigned roles:");
    for (const [roleId, modelId] of Object.entries(assignments)) {
      console.log(`  - ${roleId}: ${modelId}`);
    }
  }
  ensureGlobalCli({ version: packageVersion, dryRun: !!options.dryRun, noGlobalCli: !!options.noGlobalCli });
}

function runDoctor(options: DoctorOptions) {
  const target = options.target || "opencode";
  const adapter = getAdapter(target);
  const scope = options.scope || "project";
  console.log(`Target: ${target}`);
  // CLI-on-PATH note (SP1-AC6): informational for every target, never part
  // of doctor errors and never affects the exit code.
  console.log(formatCliDoctorNote(defaultDetectVersion(), packageVersion));

  if (adapter.mode === "install") {
    const result = adapter.runInstallDoctor?.(scope);
    if (!result) {
      throw new Error(`Adapter ${target} does not implement install doctor flow.`);
    }
    console.log(`Install location: ${result.location}`);
    // Capability word lines (install-mode doctor notes, e.g. dsh
    // uninstalled/disabled/mounted) print on every run, healthy included \u2014
    // a `mounted` state must not be implied only by exit code 0 (AC-2).
    for (const note of result.notes ?? []) {
      console.log(`  - ${note}`);
    }
    if (!result.errors.length) {
      console.log(pc.green("Doctor result: healthy"));
      return;
    }
    console.log(pc.red(`Doctor result: ${result.errors.length} issue(s)`));
    for (const issue of result.errors) console.log(`  - ${issue}`);
    process.exitCode = 1;
    return;
  }

  const configPath = adapter.resolveConfigPath?.(scope, options.output);
  if (!configPath) {
    throw new Error(`Adapter ${target} does not implement config doctor flow.`);
  }
  const config = readJson(configPath);
  const errors = adapter.validateConfig?.(config) || [];
  console.log(`Config file: ${configPath}`);
  if (!errors.length) {
    const warnings = adapter.getDoctorWarnings?.(config) || [];
    if (warnings.length) {
      console.log(pc.yellow(`Doctor: ${warnings.length} recommendation(s) (still healthy):`));
      for (const line of warnings) console.log(`  - ${line}`);
    }
    console.log(pc.green("Doctor result: healthy"));
    return;
  }
  console.log(pc.red(`Doctor result: ${errors.length} issue(s)`));
  for (const issue of errors) console.log(`  - ${issue}`);
  process.exitCode = 1;
}

/**
 * Resolve the plugin root for `plugin validate`: explicit `--root` wins;
 * otherwise start from `resolveProjectRoot()` and walk up to the nearest
 * ancestor containing `plugin.json` (bun run --cwd rewrites PWD, so the
 * project root is not always the resolved cwd).
 */
function resolvePluginRoot(options: PluginValidateOptions): string {
  if (options.root) return path.resolve(options.root);
  let candidate = resolveProjectRoot();
  while (!fs.existsSync(path.join(candidate, "plugin.json"))) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

function runPluginValidate(options: PluginValidateOptions) {
  const root = resolvePluginRoot(options);
  const result = validateAgentPlugin(root);
  for (const warning of result.warnings) {
    console.warn(pc.yellow(warning));
  }
  if (result.ok) {
    console.log(pc.green(`OK ${root}: Agent Plugins v1.0.0 conformant`));
    return;
  }
  for (const error of result.errors) {
    console.error(pc.red(error));
  }
  process.exitCode = 1;
}
/** Minimal `.mstar/AGENTS.md` harness-layer rules template (tracked result). */
const HARNESS_AGENTS_TEMPLATE = `# AGENTS.md \u2014 .mstar/ (harness layer)

- Path symbols: {HARNESS_DIR} = .mstar/; {PLAN_DIR} = plans/; {SDD_DIR} = sdd/<plan-id>/;
  {ITERATION_DIR} = iterations/; {KNOWLEDGE_DIR} = knowledge/; {SPECS_DIR} = specs/;
  {WORKFLOW_DIR} = workflows/; {PROJECT_DIR} = projects/ (SSOT: skills/mstar-conventions).
- Process vs results: process artifacts (plans/, iterations/, sdd/, status.json, workflows/,
  projects/) stay local and gitignored; results (this file, knowledge/, specs/) are tracked
  and shared across clones.
- Done: only @project-manager or @qa-engineer may set Done; implementers set InReview.
`;

/**
 * Run `mstar harness scaffold [path]`: one-shot harness bootstrap \u2014 engine
 * `scaffoldHarness` (dirs + v2 status.json + projects/_default/ under the
 * resolved harness/project dirs; `.mstarc` `harness_dir` / `project_dir`
 * honored), the canonical `.gitignore` snippet appended when absent (only
 * for the default `.mstar/` layout \u2014 custom harness layouts manage their
 * own ignore rules), and a minimal {HARNESS_DIR}/AGENTS.md harness-layer
 * rules template when absent. Prints the resolved harness/project dirs plus
 * a created/skipped summary. Idempotent: re-running on an initialized tree
 * is a no-op except creating missing pieces. Ordering is normalized as the
 * final step of the gitignore routine: duplicate `.mstar/**` rules are
 * deduped segment-wise \u2014 a trailing duplicate is dropped only when no
 * un-crossable line lies strictly between it and the previously retained
 * broad rule (a custom `!.mstar/…` re-inclusion between two broad rules
 * makes the trailing broad semantically load-bearing: last-match-wins
 * re-ignores the custom path), and a misplaced `.mstar/**` (after one
 * or more canonical `!.mstar/…` re-includes, which gitignore's
 * last-match-wins would shadow) is relocated to sit immediately before the
 * first canonical re-include \u2014 but only when the move crosses no line
 * whose semantics we do not own. The broad rule may cross blank/comment
 * lines, other exact `.mstar/**` duplicates, the 5 canonical negations,
 * and our own `.mstarc` entry; every other line (custom `!.mstar/…`
 * negations, custom `.mstar/<path>` ignores, anything else) is
 * un-crossable. A broad rule already before every canonical negation is
 * correctly placed and never moves, regardless of surrounding custom
 * lines. Infeasible → the file keeps its user-authored order (missing
 * entries were already appended).
 */
/** The 5 canonical `!.mstar/…` re-includes (verbatim from the snippet SSOT). */
const CANONICAL_NEGATIONS: Record<string, true> = {
  "!.mstar/AGENTS.md": true,
  "!.mstar/knowledge/": true,
  "!.mstar/knowledge/**": true,
  "!.mstar/specs/": true,
  "!.mstar/specs/**": true,
};

/**
 * Git top-level of `startDir` (lexical, symlink-safe): mirrors the engine's
 * `defaultWorkspaceRoot` \u2014 `git rev-parse --show-cdup` returns the relative
 * upward path to the work-tree top, so the result stays comparable with
 * `resolve()`-based paths even when `startDir` sits under a symlinked mount
 * (macOS /var → /private/var), where `--show-toplevel` would answer with
 * the physical path. On failure (not a git work tree, or git absent) falls
 * back to `startDir` itself.
 */
function gitWorkspaceRoot(startDir: string): string {
  try {
    const cdup = execFileSync("git", ["rev-parse", "--show-cdup"], {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!cdup) return startDir; // already at the git top-level
    let boundary = startDir;
    for (const segment of cdup.split(/[\\/]/)) {
      if (segment && segment !== ".") boundary = path.dirname(boundary);
    }
    return path.resolve(boundary);
  } catch {
    // not a git work tree (or git unavailable) \u2014 fall through to startDir
  }
  return startDir;
}

function runScaffold(pathArg: string | undefined) {
  const root = pathArg ? path.resolve(pathArg) : process.cwd();
  const harnessDir = scaffoldHarness(root);
  const projectDir = resolveProjectDir(root, { harnessDir });
  const created: string[] = [];
  const skipped: string[] = [];

  // Canonical .gitignore snippet (plan-conventions § Git 跟踪策略): the
  // snippet literals are `.mstar/**`-based, so the append only makes sense
  // for the default `<workspaceRoot>/.mstar/` layout. Custom harness layouts
  // (`.mstarc` harness_dir, legacy `.agents/`) manage their own ignore rules
  // and are skipped with an explicit note. The comparison AND the fence target
  // are anchored at the git top-level of `root` (falling back to `root` when
  // not a git work tree): a repo-root `.mstarc` `harness_dir=.mstar` resolves
  // the harness dir against the config file's location, so scaffolding a
  // subdirectory path would otherwise compare `<repoRoot>/.mstar` against
  // `<subdir>/.mstar` and skip the fence while process artifacts stay
  // committable.
  const workspaceRoot = gitWorkspaceRoot(root);
  const harnessKind = detectHarnessKind(harnessDir);
  if (harnessKind === "mstar" && path.resolve(harnessDir) === path.join(workspaceRoot, ".mstar")) {
    const gitignorePath = path.join(workspaceRoot, ".gitignore");
    const snippet = emitGitignoreSnippet("mstar");
    const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const snippetLines = snippet.split("\n").map((line) => line.trim());
    const fenceEntries = snippetLines.filter(
      (line) => line.startsWith(".mstar/") || line.startsWith("!.mstar/") || line.startsWith(".mstarc"),
    );
    const commentLines = snippetLines.filter((line) => line.startsWith("#"));
    const missing = fenceEntries.filter((entry) => !lines.has(entry));
    if (missing.length > 0) {
      const missingComments = commentLines.filter((line) => !lines.has(line));
      const broadRule = ".mstar/**";
      const currentLines = current.split(/\r?\n/);
      const firstNegation = currentLines.findIndex((line) => line.trim().startsWith("!.mstar/"));
      if (!lines.has(broadRule) && firstNegation !== -1) {
        // gitignore = last matching pattern wins: appending `.mstar/**`
        // after existing `!.mstar/…` re-includes would shadow them. Splice
        // the canonical block start (comments + broad rule + missing
        // re-includes) BEFORE the first negation so the re-includes stay
        // effective. `.mstarc` is a plain ignore (no negations) \u2014 appended
        // at the end when missing.
        const blockStart = [...missingComments, broadRule, ...missing.filter((entry) => entry.startsWith("!.mstar/"))];
        currentLines.splice(firstNegation, 0, ...blockStart);
        let next = currentLines.join("\n");
        if (missing.includes(".mstarc")) next = `${next}${next.endsWith("\n") ? "" : "\n"}.mstarc\n`;
        fs.writeFileSync(gitignorePath, next, "utf8");
      } else {
        // Broad rule present (append missing entries after it) or no
        // negations to shadow (append the whole block) \u2014 both safe.
        const prefix = current && !current.endsWith("\n") ? "\n" : "";
        fs.appendFileSync(gitignorePath, `${prefix}${[...missingComments, ...missing].join("\n")}\n`, "utf8");
      }
      created.push(".gitignore (canonical harness snippet)");
    }

    // Unconditional final normalization \u2014 gitignore is last-match-wins, so a
    // misplaced `.mstar/**` (appearing after one or more canonical
    // `!.mstar/…` re-includes, whether pre-existing or just appended) would
    // shadow them. Dedupe is SEGMENTED: a duplicate `.mstar/**` is dropped
    // only when no un-crossable line lies strictly between it and the
    // previously retained broad rule \u2014 a custom `!.mstar/…` re-inclusion
    // between two broad rules makes the trailing broad semantically
    // load-bearing (last-match-wins re-ignores the custom path), so it is
    // retained exactly where it is. The kept (earliest) broad rule is then
    // relocated to sit immediately before the first canonical re-include \u2014
    // but only when the move crosses no line whose semantics we do not own.
    // The broad rule may cross blank/comment lines, other exact
    // `.mstar/**` duplicates, the 5 canonical negations, and our own
    // `.mstarc` entry; every other line (custom `!.mstar/…` negations,
    // custom `.mstar/<path>` ignores, anything else) is un-crossable. A
    // broad rule already before every canonical negation is correctly placed
    // and never moves, regardless of surrounding custom lines. Infeasible →
    // the file keeps its user-authored order (missing entries were already
    // appended above). Every other line stays byte-for-byte. Runs after
    // EVERY branch above.
    const finalLines = fs.readFileSync(gitignorePath, "utf8").split(/\r?\n/);
    const broadIndexes = finalLines
      .map((line, index) => (line.trim() === ".mstar/**" ? index : -1))
      .filter((index) => index !== -1);
    const canonicalNegationIndexes = finalLines
      .map((line, index) => (CANONICAL_NEGATIONS[line.trim()] === true ? index : -1))
      .filter((index) => index !== -1);
    const firstCanonicalNegationIndex = canonicalNegationIndexes[0] ?? -1;
    let normalized = false;
    if (broadIndexes.length > 0) {
      // Segmented dedupe: drop a duplicate `.mstar/**` only when NO
      // un-crossable line lies strictly between it and the previously
      // retained broad rule. A custom `!.mstar/…` re-inclusion (or any
      // other un-owned line) between two broad rules makes the trailing
      // broad semantically load-bearing \u2014 gitignore's last-match-wins
      // re-ignores the custom path, and deleting the broad would flip
      // that line's meaning. Retained secondary broads stay exactly
      // where they are.
      let removed = 0;
      let lastRetainedBroadIndex = broadIndexes[0];
      for (let i = 1; i < broadIndexes.length; i++) {
        const candidate = broadIndexes[i] - removed;
        let crossable = true;
        for (let j = lastRetainedBroadIndex + 1; j < candidate; j++) {
          const line = finalLines[j].trim();
          if (line === "") continue; // blank
          if (line.startsWith("#")) continue; // comment
          if (line === ".mstar/**") continue; // duplicate broad rule
          if (CANONICAL_NEGATIONS[line] === true) continue; // canonical negation
          if (line === ".mstarc") continue; // our own entry
          crossable = false;
          break;
        }
        if (crossable) {
          finalLines.splice(candidate, 1);
          removed++;
          normalized = true;
        } else {
          lastRetainedBroadIndex = candidate;
        }
      }
      const keptIndex = finalLines.findIndex((line) => line.trim() === ".mstar/**");
      // A broad rule already before every canonical negation is correctly
      // placed \u2014 never move it, regardless of surrounding custom lines.
      // Only a broad rule AFTER the first canonical negation is misplaced.
      if (firstCanonicalNegationIndex !== -1 && keptIndex > firstCanonicalNegationIndex) {
        // Feasibility: the move may only cross lines whose semantics we own
        // \u2014 blank/comment lines, other exact `.mstar/**` duplicates, the 5
        // canonical negations, and our own `.mstarc` entry. Any other line
        // (custom `!.mstar/…` negation, custom `.mstar/<path>` ignore, or
        // anything else) between the first canonical negation and the kept
        // rule makes the relocation infeasible \u2014 the file keeps its
        // user-authored order.
        let feasible = true;
        for (let i = firstCanonicalNegationIndex; i < keptIndex; i++) {
          const line = finalLines[i].trim();
          if (line === "") continue; // blank
          if (line.startsWith("#")) continue; // comment
          if (line === ".mstar/**") continue; // duplicate broad rule
          if (CANONICAL_NEGATIONS[line] === true) continue; // canonical negation
          if (line === ".mstarc") continue; // our own entry
          feasible = false;
          break;
        }
        if (feasible) {
          const [broadLine] = finalLines.splice(keptIndex, 1);
          finalLines.splice(firstCanonicalNegationIndex, 0, broadLine);
          normalized = true;
        }
      }
      // Ownership invariant, final pass. Pipeline order matters for
      // one-run convergence:
      // 1. PARTITION \u2014 user-authored targeted `.mstar/…` rules always speak
      //    LAST: relocate every targeted user rule (non-canonical
      //    `!.mstar/…` re-inclusions and `.mstar/<path>` ignores \u2014 never
      //    the bare broad rule, canonical negations, or our own
      //    `.mstarc`) to after the fence, preserving their relative order.
      //    Gitignore's last-match-wins then resolves every overlap in the
      //    user's favor while our tracked results stay re-included.
      // 2. DEDUPE \u2014 after the partition no un-owned line can sit between
      //    two broad rules, so any extra `.mstar/**` is redundant: keep
      //    the first only.
      // 3. RELOCATE \u2014 a broad rule sitting after the first canonical
      //    negation is moved before it when only owned lines lie in
      //    between.
      // 4. GUARANTEE \u2014 every canonical negation occurs at least once after
      //    the last broad rule (append missing occurrences; duplicates are
      //    harmless in gitignore).
      const isTargetedUserMstarRule = (line: string): boolean => {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) return false;
        if (trimmed === ".mstar/**" || trimmed === ".mstarc") return false;
        if (CANONICAL_NEGATIONS[trimmed] === true) return false;
        if (trimmed.startsWith("!.mstar/") || trimmed.startsWith(".mstar/")) return true;
        return false;
      };
      const isOwnedLine = (line: string): boolean => !isTargetedUserMstarRule(line);

      // 1. Partition targeted user rules to the tail (with synthesis).
      const targetedRules = finalLines.filter((line) => isTargetedUserMstarRule(line));
      if (targetedRules.length > 0) {
        const owned = finalLines.filter(isOwnedLine);
        const hadTrailingNewline = owned[owned.length - 1] === "";
        const ownedBody = hadTrailingNewline ? owned.slice(0, -1) : owned;
        // A contents-level negation like `!.mstar/custom/**` cannot take
        // effect while its parent directory stays excluded by
        // `.mstar/**` \u2014 git prunes excluded directories without descending
        // (this is why the canonical fence pairs `!.mstar/knowledge/` with
        // `!.mstar/knowledge/**`). Synthesize the missing
        // ancestor-directory re-inclusions so the relocated user rule keeps
        // working after the fence.
        const tail: string[] = [];
        const ensuredDirs = new Set<string>();
        const broadPositionsPrePartition = finalLines
          .map((line, index) => (line.trim() === ".mstar/**" ? index : -1))
          .filter((index) => index !== -1);
        const lastBroadPrePartition =
          broadPositionsPrePartition[broadPositionsPrePartition.length - 1] ?? -1;
        for (const rule of targetedRules) {
          const trimmedRule = rule.trim();
          if (trimmedRule.startsWith("!") && trimmedRule.endsWith("/**")) {
            const inner = trimmedRule.slice(1, -3); // e.g. `.mstar/custom`
            const segments = inner.split("/").slice(1); // drop the harness dir name
            let prefix = inner.split("/")[0];
            for (const segment of segments) {
              prefix += "/" + segment;
              const dirNegation = "!" + prefix + "/";
              // Idempotency: skip when the dir negation already exists
              // after the last broad rule (synthesized by an earlier run)
              // or is already queued in this pass.
              const alreadyQueued = ensuredDirs.has(dirNegation);
              const alreadyPresent =
                !alreadyQueued &&
                finalLines.some(
                  (line, index) =>
                    index > lastBroadPrePartition && line.trim() === dirNegation,
                );
              if (!alreadyQueued && !alreadyPresent) {
                ensuredDirs.add(dirNegation);
                tail.push(dirNegation);
              }
            }
          }
          tail.push(rule);
        }
        const rebuilt = [...ownedBody, ...tail];
        const current =
          finalLines[finalLines.length - 1] === "" ? finalLines.slice(0, -1) : finalLines;
        if (rebuilt.join("\n") !== current.join("\n")) {
          finalLines.length = 0;
          finalLines.push(...rebuilt);
          normalized = true;
        }
      }

      // Recompute broad positions after the partition.
      const broadAfter = finalLines
        .map((line, index) => (line.trim() === ".mstar/**" ? index : -1))
        .filter((index) => index !== -1);
      if (broadAfter.length > 1) {
        // 2. Dedupe: post-partition every line between two broad rules is
        // owned, so extra broad rules are pure redundancy. Removing them
        // can only make canonical re-inclusions effective.
        const [first, ...duplicates] = broadAfter;
        let removed = 0;
        for (const duplicate of duplicates) {
          finalLines.splice(duplicate - removed, 1);
          removed++;
        }
        if (removed > 0) normalized = true;
      }

      // Recompute once more; relocate a misplaced primary broad rule.
      const broadIndexesFinal = finalLines
        .map((line, index) => (line.trim() === ".mstar/**" ? index : -1))
        .filter((index) => index !== -1);
      const canonicalNegationIndexesFinal = finalLines
        .map((line, index) => (CANONICAL_NEGATIONS[line.trim()] === true ? index : -1))
        .filter((index) => index !== -1);
      const firstCanonicalNegationIndexFinal = canonicalNegationIndexesFinal[0] ?? -1;
      if (
        broadIndexesFinal.length > 0 &&
        firstCanonicalNegationIndexFinal !== -1 &&
        broadIndexesFinal[0] > firstCanonicalNegationIndexFinal
      ) {
        const keptIndex = broadIndexesFinal[0];
        let feasible = true;
        for (let i = firstCanonicalNegationIndexFinal; i < keptIndex; i++) {
          const line = finalLines[i].trim();
          if (line === "" || line.startsWith("#")) continue;
          if (line === ".mstar/**" || line === ".mstarc") continue;
          if (CANONICAL_NEGATIONS[line] === true) continue;
          feasible = false;
          break;
        }
        if (feasible) {
          const [broadLine] = finalLines.splice(keptIndex, 1);
          finalLines.splice(firstCanonicalNegationIndexFinal, 0, broadLine);
          normalized = true;
        }
      }

      // 4. Guarantee: every canonical negation occurs at least once AFTER
      // the last broad rule. A retained/misplaced broad sitting between
      // canonical re-inclusions would otherwise shadow them under
      // last-match-wins even though the fence was reported as installed.
      const broadIndexesLast = finalLines
        .map((line, index) => (line.trim() === ".mstar/**" ? index : -1))
        .filter((index) => index !== -1);
      if (broadIndexesLast.length > 0) {
        const lastBroadIndex = broadIndexesLast[broadIndexesLast.length - 1];
        // Insert missing negations BEFORE the partitioned user tail (the
        // first targeted user rule, if any) \u2014 appending after it would put
        // our negations past the user's rules, and the next run's partition
        // would move the user rules again (flip-flop).
        let insertIndex = finalLines.findIndex((line) => isTargetedUserMstarRule(line));
        if (insertIndex === -1) insertIndex = finalLines.length;
        for (const negation of Object.keys(CANONICAL_NEGATIONS)) {
          const covered = finalLines.some(
            (line, index) => index > lastBroadIndex && line.trim() === negation,
          );
          if (!covered) {
            finalLines.splice(insertIndex, 0, negation);
            insertIndex++;
            normalized = true;
          }
        }
      }
      // Preserve a trailing newline whenever normalization changed the
      // file (appends land after any newline the original file had).
      if (normalized && finalLines[finalLines.length - 1] !== "") finalLines.push("");
    }
    if (normalized) {
      fs.writeFileSync(gitignorePath, finalLines.join("\n"), "utf8");
      created.push(".gitignore (canonical harness snippet reordered)");
    } else if (missing.length === 0) {
      skipped.push(".gitignore (canonical harness snippet already present)");
    }
  } else {
    skipped.push(".gitignore (canonical harness snippet) \u2014 custom harness layout manages its own ignore rules");
  }

  // Minimal {HARNESS_DIR}/AGENTS.md harness-layer rules (tracked result).
  const agentsPath = path.join(harnessDir, "AGENTS.md");
  const agentsLabel = `${path.basename(harnessDir)}/AGENTS.md`;
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, HARNESS_AGENTS_TEMPLATE, "utf8");
    created.push(agentsLabel);
  } else {
    skipped.push(`${agentsLabel} (already present)`);
  }

  // Headline is created-count-aware: "initialized" only when something was
  // created; a no-op re-run on an already-initialized tree says "ensured".
  const headline =
    created.length > 0
      ? `scaffold: harness initialized at ${harnessDir}`
      : `scaffold: harness ensured at ${harnessDir}`;
  console.log(pc.green(headline));
  console.log(`  harness dir: ${harnessDir}`);
  console.log(`  project dir: ${projectDir}`);
  for (const item of created) console.log(`  created: ${item}`);
  for (const item of skipped) console.log(`  skipped: ${item}`);
}

program
  .name("mstar-harness")
  .description("Morning Star harness CLI for target-based agent bootstrap")
  .version(packageVersion);

program
  .command("init")
  .description("Interactive/non-interactive setup for target agent bootstrap")
  .option("-y, --yes", "Non-interactive mode")
  .option("--target <target>", "Install target", "opencode")
  .option("--scope <scope>", "Config scope: global|project (default: project)")
  .option("--output <path>", "Config file path override, relative to project root")
  .option("--dry-run", "Preview result without writing config")
  .option("--no-fallbacks", "Skip installing the dsh-llm-fallbacks plugin (dsh target only)")
  .option("--no-global-cli", "Skip installing the matching-version @mstar-harness/cli globally after init")
  .option("--pm-model <model>", "Optional: model for project-manager (advanced override)")
  .option("--strategic-models <a,b,c>", "Optional: models for architect/product-manager/prompt-engineer")
  .option("--dev-models <a,b,c>", "Optional: models for fullstack-dev/fullstack-dev-2/frontend-dev")
  .option("--qc-models <a,b,c>", "Optional: models for qc trio")
  .option("--other-models <a,b,c>", "Optional: models for remaining roles")
  .action(async (options: InitOptions & { fallbacks?: boolean; globalCli?: boolean }) => {
    // commander's negation `--no-fallbacks` parses as `fallbacks: false`
    // (default true); map to the canonical `noFallbacks` name at the boundary.
    // `--no-global-cli` likewise parses as `globalCli: false` (default true);
    // map to the canonical `noGlobalCli` name the same way.
    await runInit({
      ...options,
      noFallbacks: options.fallbacks === false,
      noGlobalCli: options.globalCli === false,
    });
  });

const harnessCommand = program
  .command("harness")
  .description("harness bootstrap / dir-resolution helpers (engine-backed)");

harnessCommand
  .command("scaffold")
  .description(
    "One-shot harness bootstrap: create the harness dir (default .mstar/, honoring .mstarc harness_dir/project_dir) " +
      "with dirs + v2 status.json + projects/_default/, append the canonical .gitignore snippet when absent " +
      "(skipped for non-.mstar layouts), and write a minimal {HARNESS_DIR}/AGENTS.md when absent",
  )
  .argument("[path]", "Root to scaffold (default: cwd)")
  .action((pathArg?: string) => {
    runScaffold(pathArg);
  });

program
  .command("doctor")
  .description("Validate Morning Star setup for a target agent config")
  .option("--target <target>", "Target agent for doctor checks", "opencode")
  .option("--scope <scope>", "Config scope: global|project", "project")
  .option("--output <path>", "Config file path override, relative to project root")
  .action((options: DoctorOptions) => {
    runDoctor(options);
  });

const pluginCommand = program
  .command("plugin")
  .description("Agent Plugins v1.0.0 portable package commands");

pluginCommand
  .command("validate")
  .description("Validate a plugin package against Agent Plugins v1.0.0")
  .option("--root <path>", "Plugin root directory to validate (default: project root)")
  .action((options: PluginValidateOptions) => {
    runPluginValidate(options);
  });

const pathCommand = program
  .command("path")
  .description("harness/specs dir resolution checks (engine-backed)");

pathCommand
  .command("resolve")
  .description(
    "Resolve {HARNESS_DIR} + {SPECS_DIR} + {WORKFLOW_DIR} + {PROJECT_DIR} from a start dir (exit 1 when no harness dir resolves)",
  )
  .argument("[path]", "Start dir to resolve from (default: cwd)")
  .option("--json", "Machine-readable JSON output (ok, harnessDir, specsDir, workflowDir, projectDir, guidance on failure)")
  .action((pathArg: string | undefined, options: { json?: boolean }) => {
    const startDir = pathArg ? path.resolve(pathArg) : process.cwd();
    const harnessDir = resolveHarnessDir(startDir);
    if (!harnessDir) {
      // plan-conventions § {HARNESS_DIR} 解析顺序: no .mstar/ → .agents/ →
      // .plans/|plans/ anywhere up the tree \u2014 harness not enabled from here.
      const guidance =
        "no harness dir found \u2014 the bounded probe (.mstar/, .agents/, .plans/, plans/) walked up from " +
        `${startDir} only within the workspace root (git top-level of the start dir; non-git start probes only itself) \u2014 run \`mstar harness scaffold\` to bootstrap, or pass a start dir inside a harness-enabled project`;
      if (options.json) {
        console.log(JSON.stringify({ ok: false, startDir, harnessDir: null, specsDir: null, workflowDir: null, projectDir: null, guidance }));
      } else {
        console.error(pc.red(`path resolve: no harness dir from ${startDir}`));
        console.error(`  guidance: ${guidance}`);
      }
      process.exitCode = 1;
      return;
    }
    // Read-only resolution: never create {HARNESS_DIR}/specs/ as a side
    // effect (engine resolveSpecsDir opts.create defaults to true).
    const specsDir = resolveSpecsDir(harnessDir, { create: false });
    const workflowDir = resolveWorkflowDir(startDir);
    const projectDir = resolveProjectDir(startDir);
    if (options.json) {
      console.log(JSON.stringify({ ok: true, startDir, harnessDir, specsDir, workflowDir, projectDir }));
    } else {
      console.log(pc.green(`harness dir: ${harnessDir}`));
      console.log(pc.green(`specs dir:   ${specsDir}`));
      console.log(pc.green(`workflow dir: ${workflowDir}`));
      console.log(pc.green(`project dir:  ${projectDir}`));
    }
  });

const statusCommand = program
  .command("status")
  .description("v2 status.json root / workflow snapshot / project-register checks (engine-backed)");

/** Resolve the status.json path: explicit arg wins, else the resolved {HARNESS_DIR}. */
function resolveStatusFilePath(pathArg?: string): string {
  if (pathArg) return path.resolve(pathArg);
  const harnessDir = resolveHarnessDir();
  if (!harnessDir) {
    throw new Error(`harness dir not found from ${process.cwd()} \u2014 pass a status.json path or set MSTAR_HARNESS_DIR`);
  }
  return path.join(harnessDir, "status.json");
}

statusCommand
  .command("validate")
  .description(
    "Validate a v2 status.json root or workflow snapshot (root: version 2 + updated_at + active workflows[] with per-entry snapshot invariants; snapshot: schema_version 1 + plan rows + lease shapes; v1 input fails closed with the mstar migrate hint)",
  )
  .argument("[path]", "status.json or workflows/<id>/snapshot.json path (default: {HARNESS_DIR}/status.json)")
  .action((pathArg?: string) => {
    let statusPath: string;
    try {
      statusPath = resolveStatusFilePath(pathArg);
      if (!fs.existsSync(statusPath)) {
        throw new Error(`status file not found: ${statusPath}`);
      }
      const gate =
        path.basename(statusPath) === WORKFLOW_SNAPSHOT_FILE
          ? validateWorkflowSnapshot(readJson(statusPath))
          : validateStatus(statusPath);
      if (gate.ok) {
        console.log(pc.green(`${statusPath}: OK`));
        return;
      }
      const count = gate.violations.length;
      console.error(pc.red(`${statusPath}: FAIL (${count} violation${count === 1 ? "" : "s"})`));
      for (const violation of gate.violations) {
        console.error(`  - [${violation.severity}] ${violation.code}: ${violation.message}`);
        if (violation.fix) console.error(`    fix: ${violation.fix}`);
      }
      process.exitCode = 1;
    } catch (error) {
      console.error(pc.red(`status validate failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

statusCommand
  .command("tech-debt")
  .description(
    "Print the residual tech-debt rollup aggregated over every {PROJECT_DIR}/<id>/residuals.json register " +
      "(total_open / by_severity / by_target / by_plan; the project register is the source of truth \u2014 " +
      "no stored-summary drift check, informational exit 0)",
  )
  .argument("[path]", "Project dir (default: resolved {PROJECT_DIR})")
  .action((pathArg?: string) => {
    try {
      const projectDir = pathArg ? path.resolve(pathArg) : resolveProjectDir();
      if (!fs.existsSync(projectDir)) {
        throw new Error(`project dir not found: ${projectDir}`);
      }
      const rollup = techDebtRollup(projectDir);
      console.log(`status tech-debt: ${projectDir}`);
      console.log(`total_open: ${rollup.computed.total_open}`);
      console.log(`by_severity: ${JSON.stringify(rollup.computed.by_severity)}`);
      console.log(`by_target: ${JSON.stringify(rollup.computed.by_target)}`);
      console.log(`by_plan: ${JSON.stringify(rollup.computed.by_plan)}`);
      console.log(pc.green("project register is the source of truth \u2014 no stored summary to drift (informational)"));
    } catch (error) {
      console.error(pc.red(`status tech-debt failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

statusCommand
  .command("findings-cleanup")
  .description(
    "Enforce a plan's findings-cleanup mode on its project-register residuals (projects/<id>/residuals.json " +
      "entries keyed by plan id \u2014 the snapshot plan linkage; zero-residual via Assignment, else allow-residual; exit 1 on violations)",
  )
  .argument("<plan-id>", "Plan id whose register entries are checked against the cleanup mode")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .option("--project <id>", "Project id whose register is read (default: _default)")
  .option("--mode <mode>", "Cleanup mode override: zero-residual | allow-residual (default: allow-residual)")
  .action((planId: string, options: { harness?: string; project?: string; mode?: string }) => {
    try {
      const projectDir = resolveProjectDir(process.cwd(), options.harness ? { harnessDir: options.harness } : {});
      const registerPath = path.join(projectDir, options.project ?? _DEFAULT_PROJECT, PROJECT_REGISTER_FILE);
      if (!fs.existsSync(registerPath)) {
        throw new Error(`project register not found: ${registerPath}`);
      }
      const mode =
        options.mode === "zero-residual" || options.mode === "allow-residual" ? options.mode : undefined;
      if (options.mode !== undefined && mode === undefined) {
        throw new Error(`invalid --mode ${options.mode} (zero-residual | allow-residual)`);
      }
      const register = readJson(registerPath) as ProjectRegisterDoc;
      const gate = findingsCleanupGate(register, planId, mode ? { mode } : undefined);
      if (gate.ok) {
        console.log(pc.green(`findings-cleanup ${planId}: OK`));
        return;
      }
      printChecklist(`findings-cleanup ${planId}`, gate);
      process.exitCode = 1;
    } catch (error) {
      console.error(pc.red(`status findings-cleanup failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

/** Local calendar date `YYYY-MM-DD` (provenance `registered_at` \u2014 same convention as the engine's register dates). */
function todayString(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Commander collector for the repeatable `--entry <json>` option. */
function collectEntries(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

/**
 * Single-component project-id guard for the `--project` write commands
 * (backlog-register / backlog-close). The id is joined onto `{PROJECT_DIR}`
 * and both commands WRITE `residuals.json` + `.status-write.lockdir/` there \u2014
 * an absolute or `..`-containing id would escape the projects dir (qc2 F-003;
 * same class as the workflow-id guard in resolveSnapshotPath). Accept only one
 * safe path component: an alnum first char, then `[A-Za-z0-9._-]`. The built-in
 * `_default` project id (project-less flows) is a constant single-component
 * name that cannot escape, so it is allowed explicitly.
 */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function sanitizeProjectId(projectId: string): string {
  if (projectId === _DEFAULT_PROJECT) {
    return projectId;
  }
  if (
    projectId === "" ||
    projectId === "." ||
    projectId === ".." ||
    path.isAbsolute(projectId) ||
    !PROJECT_ID_RE.test(projectId)
  ) {
    throw new Error(
      `invalid project id ${JSON.stringify(projectId)} \u2014 expected one path component ` +
        `([A-Za-z0-9][A-Za-z0-9._-]*); "." / ".." / absolute / separator-containing ids would escape {PROJECT_DIR}`,
    );
  }
  return projectId;
}

statusCommand
  .command("backlog-register")
  .description(
    "Register deferred-PR backlog entries in a project register under the status write lock " +
      "(engine-backed: same-day key bump + entry-id uniqueness inside withStatusWriteLock; " +
      "each --entry is one residual JSON \u2014 source_plan/registered_at are filled by the CLI)",
  )
  .option("--project <id>", "Project id whose register is written (default: _default)")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .requiredOption("--key <plan-key>", "Base entries key (<plan-id>); the first free same-day key (base, base-2, \u2026) is used")
  .option("--entry <json>", "Residual entry JSON (nine fields; source_plan/registered_at filled by the CLI) \u2014 repeatable", collectEntries, [])
  .action(async (options: { project?: string; harness?: string; key: string; entry?: string[] }) => {
    try {
      const entriesRaw = options.entry ?? [];
      if (entriesRaw.length === 0) {
        throw new Error("at least one --entry is required \u2014 refusing to register an empty backlog");
      }
      const projectId = sanitizeProjectId(options.project ?? _DEFAULT_PROJECT);
      const projectRoot = resolveProjectDir(process.cwd(), options.harness ? { harnessDir: options.harness } : {});
      // Store-root pinning (plan Task 4 Part B): the engine writers put
      // through getArtifactStore(), whose default root is the cwd-resolved
      // harness \u2014 an explicit --harness must pin the store to that root.
      if (options.harness) setArtifactStore(createFsStore(options.harness));
      const projectDir = path.join(projectRoot, projectId);
      const registeredAt = todayString();
      const entries = entriesRaw.map((raw, index) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          throw new Error(`--entry ${index + 1} is not valid JSON: ${(error as Error).message}`);
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error(`--entry ${index + 1} must be a JSON object`);
        }
        // Provenance is CLI-owned: source_plan = the used key (the engine sets
        // the bumped key per B-9 ①), registered_at = today (plan Task 3 contract).
        return { ...(parsed as Record<string, unknown>), source_plan: options.key, registered_at: registeredAt };
      });
      const result = await appendProjectRegisterEntries({ projectDir, basePlanKey: options.key, entries });
      console.log(
        pc.green(`backlog-register: registered ${entries.length} entr${entries.length === 1 ? "y" : "ies"} under key ${result.key}`),
      );
    } catch (error) {
      console.error(pc.red(`status backlog-register failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

statusCommand
  .command("backlog-close")
  .description(
    "Close one project-register backlog entry in place under the status write lock " +
      "(lifecycle: resolved + closed_at: <today> + closure_note; absent id/key fails loud, exit 1)",
  )
  .option("--project <id>", "Project id whose register is updated (default: _default)")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .requiredOption("--key <plan-key>", "Entries key (<plan-id>) holding the entry to close")
  .requiredOption("--id <entry-id>", "id of the entry to close")
  .option("--note <text>", "Closure note (default: \"closed by backlog close\")")
  .action(async (options: { project?: string; harness?: string; key: string; id: string; note?: string }) => {
    try {
      const projectId = sanitizeProjectId(options.project ?? _DEFAULT_PROJECT);
      const projectRoot = resolveProjectDir(process.cwd(), options.harness ? { harnessDir: options.harness } : {});
      // Store-root pinning (plan Task 4 Part B): see backlog-register.
      if (options.harness) setArtifactStore(createFsStore(options.harness));
      const projectDir = path.join(projectRoot, projectId);
      await closeProjectRegisterEntry({
        projectDir,
        planKey: options.key,
        entryId: options.id,
        closureNote: options.note ?? "closed by backlog close",
      });
      console.log(pc.green(`backlog-close: resolved entry ${options.id} under key ${options.key}`));
    } catch (error) {
      console.error(pc.red(`status backlog-close failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

statusCommand
  .command("archive-residuals")
  .description(
    "Removed in v3 \u2014 residual close is a project-register state change; this command exits 1 and names the replacement",
  )
  .action(() => {
    console.error(
      pc.red(
        "status archive-residuals: removed in v3 \u2014 residuals live in project registers; close entries in " +
          "projects/<id>/residuals.json (set lifecycle to resolved/waived/superseded with closure fields) instead",
      ),
    );
    process.exitCode = 1;
  });

const migrateCommand = program
  .command("migrate")
  .description(
    "Migrate a v1 {HARNESS_DIR} status.json tree to v2 (engine-backed; exit 0 ok/idempotent no-op, 1 plan-invalid, 2 apply-failure)",
  )
  .option("--dry-run", "Print the migration step plan (source \u2192 destination) + planned-document validation warnings without writing anything")
  .option("--path <root>", "Harness root to migrate (default: resolved {HARNESS_DIR}, else cwd)")
  .option("--json", "Machine-readable JSON output")
  .action(async (options: MigrateCliOptions) => {
    await runMigrateCommand(options);
  });

const persistCommand = program
  .command("persist")
  .description(
    "Persist one JSON coordination doc through the ArtifactStore (status / snapshot / residuals / review / json). " +
      "Faces: put (default), get [--validate], list (keys only, no header), delete (idempotent). " +
      "The default FsStore resolves the harness dir from the cwd / MSTAR_HARNESS_DIR; --store <module> or " +
      "MSTAR_STORE_MODULE injects a module-backed store (filesystem paths only) for the process.",
  );

/** Persist kinds (unknown kind is a usage error, exit 2). */
const PERSIST_KINDS: readonly string[] = ["status", "snapshot", "residuals", "review", "json"];

function parsePersistKind(kind: string): ArtifactKind {
  if (PERSIST_KINDS.includes(kind)) return kind as ArtifactKind;
  throw new SddScriptError(
    "usage: persist <kind> --key <key> [--file <path>|--stdin] [--store <module>] [--schema <id>]\n" +
      "       persist get <kind> --key <key> [--validate] [--store <module>]\n" +
      "       persist list <kind> [--store <module>]\n" +
      "       persist delete <kind> --key <key> [--store <module>]\n" +
      `  unknown kind ${JSON.stringify(kind)} \u2014 expected status | snapshot | residuals | review | json`,
    2,
  );
}

/** Inject the store module from --store (wins) or MSTAR_STORE_MODULE; no
 * value keeps the default FsStore (cwd / MSTAR_HARNESS_DIR). */
async function resolvePersistStore(storeFlag: string | undefined): Promise<void> {
  const modulePath = storeFlag ?? process.env.MSTAR_STORE_MODULE;
  if (modulePath === undefined) return;
  setArtifactStore(await loadStoreModule(modulePath));
}

/** Read the payload JSON source: --file wins, --stdin and no flag read stdin
 * (CLI transform convention); both flags together is a usage error. */
function readPersistPayload(options: { file?: string; stdin?: boolean }): string {
  if (options.file !== undefined && options.stdin === true) {
    throw new SddScriptError("usage: persist --file <path> and --stdin are mutually exclusive", 2);
  }
  if (options.file !== undefined) {
    const filePath = path.resolve(options.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`persist payload file not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, "utf8");
  }
  return fs.readFileSync(0, "utf8");
}

/** Run the kind's existing validator before put (structure-only: the store
 * may not be FS-backed, so no harness-dir snapshot-existence checks).
 * kind=review runs validateMstarReviewV1 (no opaque JSON once SP3 lands);
 * json remains parse-only (arbitrary payloads). */
function validatePersistPayload(kind: ArtifactKind, payload: unknown): void {
  let gate: GateResult;
  if (kind === "status") gate = validateStatusV2(payload as StatusV2Doc);
  else if (kind === "snapshot") gate = validateWorkflowSnapshot(payload);
  else if (kind === "residuals") gate = validateProjectRegister(payload);
  else if (kind === "review") gate = validateMstarReviewV1(payload);
  else return; // json \u2014 arbitrary payload, parse-only
  if (gate.ok) return;
  const detail = gate.violations.map((v) => `[${v.severity}] ${v.code}: ${v.message}`).join("; ");
  throw new Error(`refusing to persist invalid ${kind} document: ${detail}`);
}

persistCommand
  .argument("<kind>", "status | snapshot | residuals | review | json")
  // Not a commander requiredOption: the `get` subcommand declares the same
  // flag, and a parent requiredOption would be validated before subcommand
  // dispatch — `persist get ... --key k` would fail the parent's check.
  // Validated in-handler below (usage, exit 2).
  .option("--key <key>", 'Stable key inside the kind (status: "root"; json: absolute file path)')
  .option("--file <path>", "Payload JSON file (default: read stdin)")
  .option("--stdin", "Read the payload JSON from stdin")
  .option("--store <module>", "Store module path (filesystem only; overrides MSTAR_STORE_MODULE)")
  .option("--schema <id>", "Optional schema id stored on the artifact doc (e.g. mstar.review/v1); stored only by store modules that persist it \u2014 the default FsStore rejects it (exit 1)")
  .action(
    async (kind: string, options: { key?: string; file?: string; stdin?: boolean; store?: string; schema?: string }) => {
      try {
        const parsedKind = parsePersistKind(kind);
        if (options.key === undefined) {
          throw new SddScriptError(
            "usage: persist <kind> --key <key> [--file <path>|--stdin] [--store <module>] [--schema <id>]",
            2,
          );
        }
        const raw = readPersistPayload(options);
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch (error) {
          throw new Error(`persist payload is not valid JSON: ${(error as Error).message}`);
        }
        validatePersistPayload(parsedKind, payload);
        await resolvePersistStore(options.store);
        await getArtifactStore().put({
          kind: parsedKind,
          key: options.key,
          payload,
          ...(options.schema !== undefined ? { schema: options.schema } : {}),
        });
        console.log(pc.green(`persist ${parsedKind}/${options.key}: OK`));
      } catch (error) {
        failScript(error, "persist");
      }
    },
  );

persistCommand
  .command("get")
  .description("Print the stored payload JSON for <kind>/<key>, or exit 1 when absent")
  .argument("<kind>", "status | snapshot | residuals | review | json")
  // --key / --store are declared on the parent `persist` command only:
  // commander parses a parent's options from the whole arg list, so a
  // subcommand's same-named declaration would never see the value. The get
  // action reads the values the parent parsed (probe-verified).
  // --validate has no parent twin, so it is declared here and read from the
  // action's own options.
  .option("--validate", "Run the kind's validator on the fetched payload (notes on stderr; invalid \u2192 exit 1)")
  .action(async (kind: string, options: { validate?: boolean }, command: Command) => {
    try {
      const parsedKind = parsePersistKind(kind);
      const parentOpts = command.parent?.opts() ?? {};
      const key = typeof parentOpts.key === "string" ? parentOpts.key : undefined;
      const store = typeof parentOpts.store === "string" ? parentOpts.store : undefined;
      if (key === undefined) {
        throw new SddScriptError("usage: persist get <kind> --key <key> [--validate] [--store <module>]", 2);
      }
      await resolvePersistStore(store);
      const payload = await getArtifactStore().get({ kind: parsedKind, key });
      if (payload === undefined) {
        throw new Error(`persist get ${parsedKind}/${key}: no stored document`);
      }
      if (options.validate === true) {
        // D1: reuse the put-gate validator (no second validator home). An
        // invalid doc throws BEFORE stdout is written, so stdout stays
        // payload-JSON-only and stderr carries the same violations list as
        // put. json is parse-only — the helper returns without validating.
        validatePersistPayload(parsedKind, payload);
        console.error(parsedKind === "json" ? "json: parse-only" : "validation: ok");
      }
      console.log(JSON.stringify(payload, null, 2));
    } catch (error) {
      failScript(error, "persist get");
    }
  });

persistCommand
  .command("list")
  .description("Print the stored keys for <kind>, one per line, ascending, no header (json is not listable)")
  .argument("<kind>", "status | snapshot | residuals | review | json")
  // --store is parsed by the parent `persist` command (same commander
  // dispatch constraint as `get` — see the note there).
  .action(async (kind: string, _options: object, command: Command) => {
    try {
      const parsedKind = parsePersistKind(kind);
      // D5: json keys are absolute paths — usage error exit 2 BEFORE
      // calling list (engine list("json") still throws for in-process
      // callers).
      if (parsedKind === "json") {
        throw new SddScriptError("ArtifactStore json keys are absolute paths and cannot be listed", 2);
      }
      const parentOpts = command.parent?.opts() ?? {};
      const store = typeof parentOpts.store === "string" ? parentOpts.store : undefined;
      await resolvePersistStore(store);
      const artifactStore = getArtifactStore();
      // D4: probe the optional method — an injected store without list is a
      // usage error exit 2, never a TypeError mapped to exit 1.
      if (typeof artifactStore.list !== "function") {
        throw new SddScriptError("store does not support list", 2);
      }
      const refs = await artifactStore.list(parsedKind);
      // Keys only, ascending, no header — pipe-friendly (D5). Sort here so
      // the contract holds for injected stores too, not just FsStore.
      for (const key of refs.map((ref) => ref.key).sort()) {
        console.log(key);
      }
    } catch (error) {
      failScript(error, "persist list");
    }
  });
persistCommand
  .command("delete")
  .description("Delete the stored document for <kind>/<key> (idempotent: absent is a no-op; no prompt)")
  .argument("<kind>", "status | snapshot | residuals | review | json")
  // --key / --store are parsed by the parent `persist` command (same
  // commander dispatch constraint as `get` — see the note there).
  .action(async (kind: string, _options: object, command: Command) => {
    try {
      const parsedKind = parsePersistKind(kind);
      const parentOpts = command.parent?.opts() ?? {};
      const key = typeof parentOpts.key === "string" ? parentOpts.key : undefined;
      const store = typeof parentOpts.store === "string" ? parentOpts.store : undefined;
      if (key === undefined) {
        throw new SddScriptError("usage: persist delete <kind> --key <key> [--store <module>]", 2);
      }
      await resolvePersistStore(store);
      const artifactStore = getArtifactStore();
      // D2: probe the optional method — an injected store without delete is
      // a usage error exit 2, never a TypeError mapped to exit 1.
      if (typeof artifactStore.delete !== "function") {
        throw new SddScriptError("store does not support delete", 2);
      }
      await artifactStore.delete({ kind: parsedKind, key });
      console.log(`deleted ${parsedKind}/${key}`);
    } catch (error) {
      failScript(error, "persist delete");
    }
  });

const leaseCommand = program
  .command("lease")
  .description("execution_lease / integration_merge_lease checks (engine-backed)");

/** Resolve the harness dir for lease commands: --harness wins, else {HARNESS_DIR} resolution. */
function resolveLeaseHarnessDir(harnessArg?: string): string {
  if (harnessArg) return path.resolve(harnessArg);
  const harnessDir = resolveHarnessDir();
  if (!harnessDir) {
    throw new Error(`harness dir not found from ${process.cwd()} \u2014 pass --harness or set MSTAR_HARNESS_DIR`);
  }
  return harnessDir;
}

/**
 * Resolve `{WORKFLOW_DIR}/<id>/snapshot.json` for the v2 `--workflow <id>`
 * inputs (lease verify / verify-integration / iteration gate / worktree
 * check). The id is a single path component \u2014 reject separators and `..`
 * so a hostile id cannot escape the workflows dir. The workflow dir comes
 * from the engine resolver (Phase-5 F1): a `.mstarc` `[config]
 * workflow_dir` declaration wins, else `{HARNESS_DIR}/workflows` \u2014 so a
 * custom layout is READ at the same location it is written.
 */
function resolveSnapshotPath(workflowId: string, harnessArg?: string): string {
  if (workflowId === "" || workflowId === "." || workflowId === ".." || workflowId.includes("/") || workflowId.includes("\\")) {
    throw new Error(`invalid workflow id ${JSON.stringify(workflowId)}`);
  }
  const harnessDir = resolveLeaseHarnessDir(harnessArg);
  const workflowDir = resolveWorkflowDir(harnessDir, { harnessDir });
  return path.join(workflowDir, workflowId, WORKFLOW_SNAPSHOT_FILE);
}

/** The sole plan row of a workflow snapshot, or null when ambiguous/absent. */
function solePlanRow(
  plans: Array<Record<string, unknown>>,
  label: string,
): { row: Record<string, unknown> } | { error: Error } {
  if (plans.length === 0) {
    return { error: new Error(`${label}: workflow snapshot has no plan rows \u2014 pass --plan <plan-id>`) };
  }
  if (plans.length > 1) {
    return { error: new Error(`${label}: workflow snapshot has ${plans.length} plan rows \u2014 pass --plan <plan-id> to pick one`) };
  }
  return { row: plans[0]! };
}

/**
 * Run the engine execution-lease gate on one snapshot plan row and print the
 * verdict (SSOT rules live in lease-verify.ts / the engine \u2014 row-level
 * `plans[].execution_lease` is the only location in v3; metadata-only and
 * dual-write were deleted with the v1 read path).
 */
function verifyLeaseRow(row: Record<string, unknown>, planId: string, snapshotPath: string): void {
  const result = verifyPlanExecutionLease(row, planId);
  if (result.ok) {
    const holder = String((result.lease as Record<string, unknown>).holder ?? "");
    console.log(pc.green(`${snapshotPath}: OK plan ${planId} \u2014 execution_lease valid (holder ${holder})`));
    return;
  }
  const count = result.violations.length;
  console.error(pc.red(`${snapshotPath}: FAIL plan ${planId} (${count} violation${count === 1 ? "" : "s"})`));
  for (const violation of result.violations) {
    console.error(`  - [${violation.severity}] ${violation.code}: ${violation.message}`);
    if (violation.fix) console.error(`    fix: ${violation.fix}`);
  }
  process.exitCode = 1;
}

leaseCommand
  .command("verify")
  .description("Verify a plan's execution_lease on the workflow snapshot's plan row (missing/invalid \u2192 exit 1 with violations)")
  .option("--workflow <id>", "Workflow id whose snapshot plan row is verified")
  .option("--plan <plan-id>", "Plan id whose execution_lease is verified (default: the snapshot's sole plan row)")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .action((options: { workflow?: string; plan?: string; harness?: string }) => {
    try {
      if (!options.workflow) {
        throw new SddScriptError("usage: lease verify --workflow <id> [--plan <plan-id>] [--harness <path>]", 2);
      }
      const snapshotPath = resolveSnapshotPath(options.workflow, options.harness);
      if (!fs.existsSync(snapshotPath)) {
        throw new Error(`workflow snapshot not found: ${snapshotPath}`);
      }
      const doc = readJson(snapshotPath);
      const plans = Array.isArray(doc.plans) ? (doc.plans as Array<Record<string, unknown>>) : [];
      const planId = options.plan;
      if (planId === undefined) {
        const sole = solePlanRow(plans, `lease verify ${options.workflow}`);
        if ("error" in sole) throw sole.error;
        const row = sole.row;
        verifyLeaseRow(row, String(row.plan_id ?? row.id ?? ""), snapshotPath);
        return;
      }
      const matches = plans.filter((row) => row?.id === planId || row?.plan_id === planId);
      if (matches.length === 0) {
        console.error(pc.red(`${snapshotPath}: FAIL plan ${planId}`));
        console.error(`  - [high] lease.verify.plan-not-found: no plan row with id/plan_id ${planId}`);
        process.exitCode = 1;
        return;
      }
      if (matches.length > 1) {
        console.error(pc.red(`${snapshotPath}: FAIL plan ${planId}`));
        console.error("  - [high] lease.verify.ambiguous: multiple plan rows match (id and plan_id both present)");
        process.exitCode = 1;
        return;
      }
      verifyLeaseRow(matches[0]!, planId, snapshotPath);
    } catch (error) {
      failScript(error, "lease verify");
    }
  });

leaseCommand
  .command("verify-integration")
  .description(
    "Verify the workflow snapshot's top-level integration_merge_lease when present (absent/unclaimed \u2192 OK; invalid lease \u2192 exit 1)",
  )
  .option("--workflow <id>", "Workflow id whose snapshot top-level lease is verified")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .action((options: { workflow?: string; harness?: string }) => {
    try {
      if (!options.workflow) {
        throw new SddScriptError("usage: lease verify-integration --workflow <id> [--harness <path>]", 2);
      }
      const snapshotPath = resolveSnapshotPath(options.workflow, options.harness);
      if (!fs.existsSync(snapshotPath)) {
        throw new Error(`workflow snapshot not found: ${snapshotPath}`);
      }
      const doc = readJson(snapshotPath);
      const lease = doc.integration_merge_lease;
      if (lease === undefined) {
        console.log(pc.green(`${snapshotPath}: OK \u2014 no integration_merge_lease (unclaimed)`));
        return;
      }
      const gate = validateIntegrationMergeLease(lease);
      if (gate.ok) {
        console.log(pc.green(`${snapshotPath}: OK \u2014 integration_merge_lease valid (holder ${String((lease as Record<string, unknown>).holder ?? "")})`));
        return;
      }
      printChecklist("lease verify-integration", gate);
      process.exitCode = 1;
    } catch (error) {
      failScript(error, "lease verify-integration");
    }
  });

/**
 * Map engine `SddScriptError` exit codes (bash-parity: 1 = resolution/
 * workspace failure, 2 = usage/bad-ref, 3 = task N missing) onto the
 * process; anything else fails gracefully with exit 1 (slice-1
 * convention: `process.exitCode`, no throw through commander).
 */
function failScript(error: unknown, context: string): void {
  if (error instanceof SddScriptError) {
    console.error(pc.red(`${context} failed: ${error.message}`));
    process.exitCode = error.exitCode;
    return;
  }
  console.error(pc.red(`${context} failed: ${(error as Error).message}`));
  process.exitCode = 1;
}

const sddCommand = program
  .command("sdd")
  .description("SDD workspace / task-brief / review-package helpers (engine-backed)");

sddCommand
  .command("workspace")
  .description("Resolve and ensure {SDD_DIR} for a plan (exit 1 on resolution failures, 2 on usage errors)")
  .argument("[plan-id]", "Plan id whose SDD dir is resolved/created")
  .argument("[control-root]", "Control worktree root (default: MSTAR_CONTROL_ROOT or the cwd's git top-level)")
  .action((planId: string | undefined, controlRoot?: string) => {
    try {
      // Optional args + explicit count check: commander's own
      // missing-argument error exits 1, which would bypass the usage
      // contract (exit 2) \u2014 validate in-handler instead (qc2 F-005).
      if (!planId) {
        throw new SddScriptError(
          "usage: mstar sdd workspace PLAN_ID [CONTROL_ROOT]\n" +
            "  Set MSTAR_CONTROL_ROOT=<control_worktree_path> when running from a feature worktree.",
          2,
        );
      }
      const sddDir = sddWorkspace(planId, controlRoot ? { controlRoot } : {});
      console.log(pc.green(`sdd dir: ${sddDir}`));
    } catch (error) {
      failScript(error, "sdd workspace");
    }
  });

sddCommand
  .command("task-brief")
  .description("Extract the `## Task N` section of a plan into a brief file (exit 3 when task N is missing)")
  .argument("[plan-file]", "Plan markdown file")
  .argument("[task-number]", "Task number whose brief is extracted")
  .argument("[outfile]", "Output file (default: {SDD_DIR}/task-N-brief.md)")
  .action((planFile: string | undefined, taskNumber: string | undefined, outfile?: string) => {
    try {
      // Optional args + explicit count check (usage exit 2).
      if (!planFile || !taskNumber) {
        throw new SddScriptError("usage: mstar sdd task-brief PLAN_FILE TASK_NUMBER [OUTFILE]", 2);
      }
      const out = taskBrief(planFile, Number(taskNumber), outfile);
      console.log(pc.green(`task ${taskNumber} brief: ${out}`));
    } catch (error) {
      failScript(error, "sdd task-brief");
    }
  });

sddCommand
  .command("review-package")
  .description("Write commits + stat + diff -U10 for BASE..HEAD into a review file (exit 2 on bad refs)")
  .argument("[base]", "Base ref (commit SHA)")
  .argument("[head]", "Head ref (commit SHA)")
  .argument("[outfile]", "Output file (default: {SDD_DIR}/review-<short-base>..<short-head>.diff)")
  .action((base: string | undefined, head: string | undefined, outfile?: string) => {
    try {
      // Optional args + explicit count check (usage exit 2).
      if (!base || !head) {
        throw new SddScriptError("usage: mstar sdd review-package BASE HEAD [OUTFILE]", 2);
      }
      const out = reviewPackage(base, head, outfile);
      console.log(pc.green(`review package: ${out}`));
    } catch (error) {
      failScript(error, "sdd review-package");
    }
  });

const iterationCommand = program
  .command("iteration")
  .description("iteration phase-gate + push-cadence checks (engine-backed)");

/** Print one §3.1 entry / §3.5 exit checklist gate (OK or FAIL + violations). */
function printChecklist(label: string, gate: GateResult): void {
  if (gate.ok) {
    console.log(pc.green(`${label}: OK`));
    return;
  }
  const count = gate.violations.length;
  console.error(pc.red(`${label}: FAIL (${count} violation${count === 1 ? "" : "s"})`));
  for (const violation of gate.violations) {
    console.error(`  - [${violation.severity}] ${violation.code}: ${violation.message}`);
    if (violation.fix) console.error(`    fix: ${violation.fix}`);
  }
}

iterationCommand
  .command("gate")
  .description(
    "Evaluate the phase-transition gate: prints the transition (phase-2-execute / phase-3-close / phase-4-pr-delivery) " +
      "plus the \u00a73.1 entry and \u00a73.5 exit checklists. Exit 1 when the gate verdict fails \u2014 during the Phase-3 window " +
      "(transition: phase-3-close) exit 1 is EXPECTED until the \u00a73.4 close items (status: completed + end_date) are " +
      "written: the exit checklist gates Phase 4, not the Phase-3 entry (qc2 F-003)",
  )
  .requiredOption("--workflow <id>", "Workflow id whose snapshot is evaluated")
  .requiredOption("--compass <path>", "delivery-compass.md path")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .option("--branch <branch>", "Current branch probe (exit \u00a73.5 item 5)")
  .option("--integration <branch>", "Spec integration branch probe (exit \u00a73.5 item 5)")
  .option("--target <branch>", "PR base branch probe (exit \u00a73.5 item 6)")
  .action(
    (options: { workflow: string; compass: string; harness?: string; branch?: string; integration?: string; target?: string }) => {
    try {
      const snapshotPath = resolveSnapshotPath(options.workflow, options.harness);
      const compassPath = path.resolve(options.compass);
      if (!fs.existsSync(snapshotPath)) throw new Error(`workflow snapshot not found: ${snapshotPath}`);
      if (!fs.existsSync(compassPath)) throw new Error(`compass file not found: ${compassPath}`);
      const result = evaluatePhaseGate(readJson(snapshotPath), parseCompassFrontmatter(compassPath), {
        currentBranch: options.branch,
        specIntegrationBranch: options.integration,
        prBaseBranch: options.target,
      });
      console.log(`transition: ${result.transition}`);
      printChecklist("entry (close \u00a73.1)", result.entry);
      printChecklist("exit (close \u00a73.5)", result.exit);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(pc.red(`iteration gate failed: ${(error as Error).message}`));
      process.exitCode = 1;
    }
  });

iterationCommand
  .command("push-cadence")
  .description("\u00a75.1a push-cadence probe: never push while CI or an AI review wave is running (exit 1 when blocked)")
  .option("--ci-running", "CI checks are still queued/in_progress on the current head")
  .option("--review-wave", "An AI/bot review wave is still running on the current head")
  .action((options: { ciRunning?: boolean; reviewWave?: boolean }) => {
    const result = pushCadenceProbe(Boolean(options.ciRunning), Boolean(options.reviewWave));
    if (result.ok) {
      console.log(pc.green("push allowed: CI idle, no AI review wave"));
      return;
    }
    const count = result.violations.length;
    console.error(pc.red(`push blocked (${count} violation${count === 1 ? "" : "s"})`));
    for (const violation of result.violations) {
      console.error(`  - [${violation.severity}] ${violation.code}: ${violation.message}`);
      if (violation.fix) console.error(`    fix: ${violation.fix}`);
    }
    process.exitCode = 1;
  });

const dispatchCommand = program
  .command("dispatch")
  .description("Assignment field + default-branch gate checks (engine-backed)");

dispatchCommand
  .command("validate")
  .description(
    "Validate an Assignment markdown file: required header fields + exactly-one branch form, " +
      "then the default-protected-branch gate (exit 1 on violations, 2 on usage)",
  )
  .argument("[assignment-file]", "Assignment markdown file")
  .option(
    "--branch <branch>",
    "Gate branch context (default: derived from the Assignment's own branch forms, then $MSTAR_WORKING_BRANCH)",
  )
  .action((assignmentFile: string | undefined, options: { branch?: string }) => {
    try {
      // Optional arg + explicit count check (bash-parity usage exit 2, slice-2
      // convention: commander's own missing-argument error would exit 1).
      if (!assignmentFile) {
        throw new SddScriptError("usage: dispatch validate <assignment-file> [--branch <branch>]", 2);
      }
      const file = resolveCliPath(assignmentFile);
      if (!fs.existsSync(file)) {
        throw new Error(`assignment file not found: ${file}`);
      }
      const text = fs.readFileSync(file, "utf8");

      // Read-only orientation roles (scout/explore, engine SSOT) skip the
      // branch-form gate AND the default-branch gate \u2014 no writable work on a
      // branch (qc3 F-1 / qc2 S-5): `mstar dispatch validate` on a scout
      // Assignment without a Working branch exits 0.
      const readOnly = isReadOnlyAssignmentRole(parseAssignmentFields(text).executeAs ?? "");
      const violations = [...validateAssignmentFields(text, { writable: readOnly ? false : undefined }).violations];

      if (!readOnly) {
        // Default-branch gate: the checked branch is derived FROM THE
        // ASSIGNMENT \u2014 create-form → the created branch, existing form → the
        // branch, `Branch policy` → the exception branch \u2014 so the documented
        // preflight invocation (`dispatch validate <assignment-file>`, no
        // --branch) actually gates (qc2 W-1). `--branch` / $MSTAR_WORKING_BRANCH
        // are context fallbacks for assignments without a branch form (qc3
        // F-2: "create feature/x from main" checks feature/x, not main). A
        // well-formed `Branch policy: direct on <branch> \u2014 <reason>` exception
        // is honored only when its branch is the one being checked.
        const forms = parseAssignmentBranchForms(text);
        const branch =
          forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch ?? options.branch ?? process.env.MSTAR_WORKING_BRANCH;
        if (branch !== undefined && branch.trim() !== "") {
          const directOnException = parseBranchPolicyDirectOnBranch(text) === branch.trim();
          violations.push(...assertDefaultBranchProtected(branch, { directOnException }).violations);
        }
      }
      printChecklist("dispatch validate", { ok: violations.length === 0, violations });
      if (violations.length > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "dispatch validate");
    }
  });

const worktreeCommand = program
  .command("worktree")
  .description("L1/L2 pre-dispatch worktree checks (engine-backed)");

/** Parse the `--tracks` JSON arg into L2 track records (arg-shape errors → usage exit 2). */
function parseTracksArg(tracksJson: string): WorktreeTrack[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tracksJson);
  } catch {
    throw new SddScriptError("usage: worktree check --l2 --tracks <json> \u2014 invalid JSON", 2);
  }
  if (!Array.isArray(parsed)) {
    throw new SddScriptError(
      "usage: worktree check --l2 --tracks <json> \u2014 expected a JSON array of {worktreePath, workingBranch}",
      2,
    );
  }
  const tracks: WorktreeTrack[] = [];
  for (const item of parsed) {
    const record = item as { worktreePath?: unknown; workingBranch?: unknown } | null;
    if (record === null || typeof record !== "object" || typeof record.worktreePath !== "string" || typeof record.workingBranch !== "string") {
      throw new SddScriptError(
        "usage: worktree check --l2 --tracks <json> \u2014 every track needs string worktreePath + workingBranch",
        2,
      );
    }
    tracks.push({ worktreePath: record.worktreePath, workingBranch: record.workingBranch });
  }
  return tracks;
}

worktreeCommand
  .command("check")
  .description(
    "L1: verify the plan's execution_lease worktree vs control path (isolation, existence, branch alignment) from the " +
      "workflow snapshot rows + snapshot control_worktree_path; --l2: verify parallel writable tracks (exit 1 on violations, 2 on usage)",
  )
  .argument("[plan-id]", "Plan id whose execution_lease drives the L1 input (alternative to --plan)")
  .option("--workflow <id>", "Workflow id whose snapshot supplies the L1 plan rows + control_worktree_path")
  .option("--plan <plan-id>", "Plan id whose execution_lease drives the L1 input")
  .option("--harness <path>", "Harness dir override (default: resolved {HARNESS_DIR})")
  .option("--control <path>", "Control worktree path override (default: snapshot control_worktree_path)")
  .option("--l2", "Run the L2 within-plan check (parallel writable tracks) instead of L1")
  .option(
    "--tracks <json>",
    'L2 tracks JSON: [{"worktreePath": "/abs/path", "workingBranch": "feature/x"}] (required with --l2)',
  )
  .action(
    (
      planId: string | undefined,
      options: { workflow?: string; plan?: string; harness?: string; control?: string; l2?: boolean; tracks?: string },
    ) => {
      try {
        if (options.l2) {
          if (!options.tracks) {
            throw new SddScriptError("usage: worktree check --l2 --tracks <json>", 2);
          }
          const gate = l2PreDispatchCheck({ tracks: parseTracksArg(options.tracks) });
          printChecklist("worktree L2 check", gate);
          if (!gate.ok) process.exitCode = 1;
          return;
        }
        // plan-id positional or --plan (option wins when both are given).
        const plan = options.plan ?? planId;
        if (!plan) {
          throw new SddScriptError(
            "usage: worktree check <plan-id> --workflow <id> [--harness <path>] [--control <path>] (or --plan <plan-id>)",
            2,
          );
        }
        if (!options.workflow) {
          throw new SddScriptError("usage: worktree check <plan-id> --workflow <id> [--harness <path>] [--control <path>] (or --plan <plan-id>)", 2);
        }
        const snapshotPath = resolveSnapshotPath(options.workflow, options.harness);
        if (!fs.existsSync(snapshotPath)) {
          throw new Error(`workflow snapshot not found: ${snapshotPath}`);
        }
        const doc = readJson(snapshotPath);
        const plans = Array.isArray(doc.plans) ? (doc.plans as Array<Record<string, unknown>>) : [];
        const matches = plans.filter((row) => row?.id === plan || row?.plan_id === plan);
        if (matches.length === 0) {
          console.error(pc.red(`${snapshotPath}: FAIL plan ${plan}`));
          console.error(`  - [high] worktree.l1.plan-not-found: no plan row with id/plan_id ${plan}`);
          process.exitCode = 1;
          return;
        }
        if (matches.length > 1) {
          console.error(pc.red(`${snapshotPath}: FAIL plan ${plan}`));
          console.error("  - [high] worktree.l1.ambiguous: multiple plan rows match (id and plan_id both present)");
          process.exitCode = 1;
          return;
        }
        const row = matches[0]!;
        const lease = (row.execution_lease ?? {}) as Record<string, unknown>;
        const input: L1PreDispatchInput = {
          controlWorktreePath: options.control ? path.resolve(options.control) : String(doc.control_worktree_path ?? ""),
          leaseWorktreePath: String(lease.worktree_path ?? ""),
          leaseWorkingBranch: String(lease.working_branch ?? ""),
          planId: plan,
        };
        const gate = l1PreDispatchCheck(input);
        printChecklist("worktree L1 check", gate);
        if (!gate.ok) process.exitCode = 1;
      } catch (error) {
        failScript(error, "worktree check");
      }
    },
  );

/** Parse one Assignment header field (`**Label**: value` or `Label: value`, list bullets tolerated). */
function parseAssignmentHeaderField(assignmentText: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boldRe = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?\\*\\*\\s*${escaped}\\s*\\*\\*\\s*:\\s*(.*)$`);
  const plainRe = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escaped}\\s*:\\s*(.*)$`);
  for (const line of assignmentText.split(/\r?\n/)) {
    const match = line.match(boldRe) ?? line.match(plainRe);
    if (match) return match[1]!.trim();
  }
  return "";
}

/** QC/QA alignment fields asserted byte-identical across QC tri + QA Assignments (engine contract). */
const QC_ALIGNMENT_FIELDS: ReadonlyArray<{ key: keyof QcAlignmentAssignment; label: string }> = [
  { key: "planId", label: "plan_id" },
  { key: "reviewRange", label: "Review range" },
  { key: "diffBasis", label: "Diff basis" },
];

worktreeCommand
  .command("qc-alignment")
  .description(
    "Assert the QC/QA alignment fields (plan_id / Review range / Diff basis) are byte-identical across the given " +
      "Assignment files (separate or combined `Review range / Diff basis` labels; exit 1 on mismatch or missing field, 2 on usage)",
  )
  .argument("[assignment-files...]", "QC tri + QA Assignment markdown files (at least one required)")
  .action((files: string[]) => {
    try {
      if (files.length === 0) {
        throw new SddScriptError("usage: worktree qc-alignment <assignment-file>...", 2);
      }
      const assignments: QcAlignmentAssignment[] = [];
      for (const fileArg of files) {
        const file = path.resolve(fileArg);
        if (!fs.existsSync(file)) {
          throw new Error(`assignment file not found: ${file}`);
        }
        const text = fs.readFileSync(file, "utf8");
        // The canonical PM label combines both range fields in one value
        // (`**Review range / Diff basis**: ...`); a separate `Review range` /
        // `Diff basis` label wins over the combined value for its own field.
        const combinedRange = parseAssignmentHeaderField(text, "Review range / Diff basis");
        const planId = parseAssignmentHeaderField(text, "plan_id");
        const reviewRange = parseAssignmentHeaderField(text, "Review range") || combinedRange;
        const diffBasis = parseAssignmentHeaderField(text, "Diff basis") || combinedRange;
        const values = { planId, reviewRange, diffBasis };
        const missing = QC_ALIGNMENT_FIELDS.filter((field) => values[field.key] === "");
        if (missing.length > 0) {
          console.error(pc.red(`worktree qc-alignment: FAIL ${file}`));
          for (const field of missing) {
            console.error(`  - [high] qc.alignment.field.missing: missing "${field.label}" header field`);
          }
          process.exitCode = 1;
          return;
        }
        assignments.push({ planId, reviewRange, diffBasis });
      }
      const gate = assertQcAlignment(assignments);
      if (gate.ok) {
        console.log(
          pc.green(
            `worktree qc-alignment: OK (${assignments.length} assignment${assignments.length === 1 ? "" : "s"}, ` +
              `${QC_ALIGNMENT_FIELDS.length} fields byte-identical)`,
          ),
        );
        return;
      }
      printChecklist("worktree qc-alignment", gate);
      process.exitCode = 1;
    } catch (error) {
      failScript(error, "worktree qc-alignment");
    }
  });

const reviewCommand = program
  .command("review")
  .description("QC seat-mapping checks (engine-backed)");

/** Parse the Assignment's `Execution mode` header field (bold or plain form). */
function parseAssignmentExecutionMode(assignmentText: string): string {
  for (const line of assignmentText.split(/\r?\n/)) {
    const match =
      line.match(/^\*\*\s*Execution mode\s*\*\*\s*:\s*(.*)$/) ?? line.match(/^Execution mode\s*:\s*(.*)$/);
    if (match) return match[1]!.trim();
  }
  return "";
}

reviewCommand
  .command("seats")
  .description(
    "Map an Assignment's execution mode to its QC seat count N; with --reviewers, verify tri identity on sdd " +
      "(exit 1 on violations, 2 on usage)",
  )
  .argument("[assignment-file]", "Assignment markdown file")
  .option("--mode <mode>", "Execution mode override (sdd | inline | targeted; default: the Assignment's Execution mode field)")
  .option("--reviewers <list>", "Comma-separated reviewer roles (targeted seats; tri-identity checked when mode is sdd)")
  .action((assignmentFile: string | undefined, options: { mode?: string; reviewers?: string }) => {
    try {
      // Optional arg + explicit count check (bash-parity usage exit 2).
      if (!assignmentFile) {
        throw new SddScriptError("usage: review seats <assignment-file> [--mode sdd|inline|targeted] [--reviewers <role1,role2,...>]", 2);
      }
      const file = path.resolve(assignmentFile);
      if (!fs.existsSync(file)) {
        throw new Error(`assignment file not found: ${file}`);
      }
      const text = fs.readFileSync(file, "utf8");
      const mode = options.mode ?? parseAssignmentExecutionMode(text);
      const reviewers = (options.reviewers ?? "")
        .split(",")
        .map((role) => role.trim())
        .filter((role) => role !== "");
      const result = executionModeToN(mode, { seats: reviewers });
      if (!result.ok) {
        printChecklist("review seats", result);
        process.exitCode = 1;
        return;
      }
      // Tri identity on sdd only when an initial-wave reviewer list is given
      // (dispatch-gates § QC tri-review: exactly qc-specialist/-2/-3).
      const normalizedMode = mode.trim().toLowerCase().split(/\s+/)[0] ?? "";
      if (normalizedMode === "sdd" && reviewers.length > 0) {
        const tri = assertTriIdentity(reviewers);
        if (!tri.ok) {
          printChecklist("review seats (tri identity)", tri);
          process.exitCode = 1;
          return;
        }
      }
      console.log(pc.green(`seats: ${result.n}`));
    } catch (error) {
      failScript(error, "review seats");
    }
  });

// ---------------------------------------------------------------------------
// Slice 4: lint / design-md / audit / compound / host / skill (engine-backed
// thin wrappers \u2014 business logic lives in @mstar-harness/engine)
// ---------------------------------------------------------------------------

/** Content types `mstar lint` knows, mapped 1:1 to engine lint.* checks. */
/** Content types `mstar lint` knows, mapped 1:1 to engine lint.* checks.
 * `finding` is explicit-only (`--type finding`) \u2014 finding docs carry no
 * classifiable name/location, so inference never selects it. */
type LintTargetType = "plan" | "skill" | "strategy" | "report" | "code" | "finding";

/** Build a static string-keyed membership lookup from an enum array. */
function lookupTable(values: readonly string[]): Record<string, true> {
  const table: Record<string, true> = {};
  for (const value of values) table[value] = true;
  return table;
}

/** Directories skipped during `mstar lint <dir>` walks (build/vendor trees). */
const LINT_SKIP_DIRS: Record<string, true> = {
  node_modules: true,
  ".git": true,
  dist: true,
  coverage: true,
  ".turbo": true,
};

/** Code-file extensions linted for `simplify:` / `temporary` markers. */
const LINT_CODE_EXTENSIONS: Record<string, true> = {
  ".ts": true, ".tsx": true, ".mts": true, ".cts": true,
  ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
  ".py": true, ".go": true, ".rs": true, ".sh": true, ".bash": true, ".zsh": true,
  ".rb": true, ".java": true, ".kt": true, ".swift": true,
};

/**
 * Classify a lint target by content type (basename first, then plan-location
 * heuristics, then code extensions). Unclassifiable files (DESIGN.md, task
 * briefs, prose docs, ...) return `null` \u2014 `mstar lint` skips them in dir
 * walks and rejects them as usage errors when named explicitly.
 */
function lintTargetType(filePath: string): LintTargetType | null {
  const base = path.basename(filePath);
  if (base === "STRATEGY.md") return "strategy";
  if (base === "SKILL.md") return "skill";
  if (/^task-\d+-report\.md$/i.test(base)) return "report";
  const dir = path.dirname(filePath);
  if (dir.includes(`${path.sep}plans${path.sep}`) || dir.endsWith(`${path.sep}plans`)) return "plan";
  if (/^\d{8}-[a-z0-9.-]+\.md$/i.test(base)) return "plan";
  if (LINT_CODE_EXTENSIONS[path.extname(base).toLowerCase()] === true) return "code";
  return null;
}

/** Recursively collect lintable files under a directory (skip build trees). */
function collectLintTargets(dir: string): string[] {
  const targets: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (LINT_SKIP_DIRS[entry.name] !== true) walk(path.join(current, entry.name));
      } else if (entry.isFile() && lintTargetType(path.join(current, entry.name)) !== null) {
        targets.push(path.join(current, entry.name));
      }
    }
  };
  walk(dir);
  return targets;
}

/** Run the content-type engine checks for one lint target. Markers are
 * advisory info (stdout); violations gate the exit code (stderr). */
function lintOneFile(filePath: string, forcedType?: LintTargetType, prVariant?: boolean): { violations: ValidationResult[]; markers: string[] } {
  const abs = path.resolve(filePath);
  const text = fs.readFileSync(abs, "utf8");
  const violations: ValidationResult[] = [];
  const markers: string[] = [];
  const effective = forcedType ?? lintTargetType(abs);
  switch (effective) {
    case "plan":
      violations.push(...planQualityBar(text).violations);
      break;
    case "skill":
      violations.push(...lintFrontmatter(text).violations);
      break;
    case "strategy":
      violations.push(...lintStrategySections(text).violations);
      break;
    case "report":
      violations.push(...assertSddTddTriple(text).violations);
      break;
    case "code": {
      for (const marker of findSimplifyMarkers(text)) {
        markers.push(`simplify marker @${marker.line}: ${marker.text}`);
      }
      const temporary = findTemporaryMarkers(text);
      for (const marker of temporary.markers) {
        const removal = marker.removalPath === null ? "no removal path" : `removal: ${marker.removalPath}`;
        markers.push(`temporary marker @${marker.line}: ${marker.text} (${removal})`);
      }
      violations.push(...temporary.violations);
      break;
    }
    case "finding":
      violations.push(...validateFindingDoc(text, { ...(prVariant ? { prVariant: true } : {}) }).violations);
      break;
    default:
      throw new SddScriptError(
        `usage: lint <target> \u2014 unsupported file type "${path.basename(abs)}" (lintable: plan files, SKILL.md, STRATEGY.md, task-N-report.md, code files)`,
        2,
      );
  }
  return { violations, markers };
}

const lintCommand = program
  .command("lint")
  .description(
    "lint harness artifacts by content type (engine-backed): plan files \u2192 quality bar, SKILL.md \u2192 frontmatter, " +
      "STRATEGY.md \u2192 required sections, task-N-report.md \u2192 SDD TDD triple, code files \u2192 simplify:/temporary markers",
  );

lintCommand
  .description(
    "Lint <target> (file or dir) \u2014 exit 1 on violations, 2 on usage. --type forces one content type " +
      "(plan | skill | strategy | report | code | finding); finding docs are explicit-only",
  )
  .argument("[target]", "File or directory to lint")
  .option("--type <type>", "Force the content type (plan | skill | strategy | report | code | finding)")
  .option("--pr-variant", "With --type finding: enforce the PR-only Merge class contract (presence, enum, placement after Confidence)")
  .action((target: string | undefined, options: { type?: string; prVariant?: boolean }) => {
    try {
      if (!target) throw new SddScriptError("usage: lint <target> (file or dir)", 2);
      let forcedType: LintTargetType | null = null;
      if (options.type !== undefined) {
        const forced = options.type.trim().toLowerCase();
        const KNOWN: readonly string[] = ["plan", "skill", "strategy", "report", "code", "finding"];
        if (!KNOWN.includes(forced)) {
          throw new SddScriptError(`usage: lint --type must be one of ${KNOWN.join(" | ")}, got ${JSON.stringify(options.type)}`, 2);
        }
        forcedType = forced as LintTargetType;
      }
      const abs = resolveCliPath(target);
      if (!fs.existsSync(abs)) throw new Error(`lint target not found: ${abs}`);
      const targets = fs.statSync(abs).isDirectory() ? collectLintTargets(abs) : [abs];
      if (targets.length === 0) {
        console.log(pc.yellow(`lint: no lintable files under ${target}`));
        return;
      }
      let violations = 0;
      for (const file of targets) {
        const label = `lint ${file}`;
        let result: { violations: ValidationResult[]; markers: string[] };
        try {
          result = lintOneFile(file, forcedType ?? undefined, options.prVariant === true);
        } catch (error) {
          if (error instanceof SddScriptError) throw error;
          console.error(pc.red(`${label}: ERROR \u2014 ${(error as Error).message}`));
          violations++;
          continue;
        }
        for (const marker of result.markers) console.log(`  ${pc.cyan(marker)}`);
        if (result.violations.length === 0) {
          console.log(pc.green(`${label}: OK`));
          continue;
        }
        violations += result.violations.length;
        const count = result.violations.length;
        console.error(pc.red(`${label}: FAIL (${count} violation${count === 1 ? "" : "s"})`));
        for (const violation of result.violations) {
          console.error(`  - [${violation.severity}] ${violation.code}: ${violation.message}`);
          if (violation.fix) console.error(`    fix: ${violation.fix}`);
        }
      }
      if (violations > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "lint");
    }
  });

const designMdCommand = program
  .command("design-md")
  .description("DESIGN.md token frontmatter / light-dark parity / completeness checks (engine-backed)");

designMdCommand
  .command("validate")
  .description(
    "Validate DESIGN.md in <dir>: token frontmatter, light/dark parity when DESIGN.dark.md exists, " +
      "and the completeness level (exit 1 on violations, 2 on usage)",
  )
  .argument("[dir]", "Directory containing DESIGN.md")
  .action((dir?: string) => {
    try {
      if (!dir) throw new SddScriptError("usage: design-md validate <dir>", 2);
      const abs = resolveCliPath(dir);
      const lightPath = path.join(abs, "DESIGN.md");
      if (!fs.existsSync(lightPath)) throw new Error(`design file not found: ${lightPath}`);
      const light = fs.readFileSync(lightPath, "utf8");
      const violations: ValidationResult[] = [];
      const tokens = validateDesignTokenFrontmatter(light);
      printChecklist("design-md validate (tokens)", tokens);
      violations.push(...tokens.violations);
      const darkPath = path.join(abs, "DESIGN.dark.md");
      if (fs.existsSync(darkPath)) {
        const parity = assertLightDarkParity(light, fs.readFileSync(darkPath, "utf8"));
        printChecklist("design-md validate (light/dark parity)", parity);
        violations.push(...parity.violations);
      }
      const level = completenessLevel(light);
      console.log(`design-md completeness level: ${level.level}`);
      if (level.missing.length > 0) console.log(`  missing for next level: ${level.missing.join(", ")}`);
      if (level.bodyUnverified) {
        console.log(pc.yellow("  note: body-only checklist items not verified \u2014 Production caps at Standard"));
      }
      if (violations.length > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "design-md validate");
    }
  });

/**
 * Parse the `audit scaffold` findings file. Two accepted shapes:
 * - a bare JSON array of finding objects (legacy), or
 * - an object `{ findings: [...], needsVerification?: [...], hardeningChecked?: [...] }`
 *   carrying the security-disposition entries documented by
 *   `mstar-audit/references/security-review.md` alongside the findings.
 *
 * `dependsOn` is validated against the Status-block contract and normalized:
 * `"none"` / `plans/NNN-*.md` pass through, a bare plan number (`002`) from
 * the scaffolded numbering scheme is rendered as `plans/002-*.md`, anything
 * else is a usage error \u2014 so every scaffolded plan round-trips through
 * `validateAuditStatusBlocks` (qc2 F-001 / qc3 F-002).
 */
type AuditScaffoldInput = {
  findings: AuditFinding[];
  needsVerification?: { lead: string; how: string; evidence?: string }[];
  hardeningChecked?: { kind: "Hardening" | "Checked and clean"; text: string }[];
};

const AUDIT_HARDENING_KINDS = ["Hardening", "Checked and clean"] as const;

function parseAuditScaffoldInput(text: string): AuditScaffoldInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SddScriptError("usage: audit scaffold \u2014 findings file is not valid JSON", 2);
  }
  let root: unknown[];
  let needsVerificationRaw: unknown;
  let hardeningCheckedRaw: unknown;
  if (Array.isArray(parsed)) {
    root = parsed;
  } else if (typeof parsed === "object" && parsed !== null) {
    const doc = parsed as Record<string, unknown>;
    if (!Array.isArray(doc.findings)) {
      throw new SddScriptError("usage: audit scaffold \u2014 findings file must be a JSON array or an object with a findings array", 2);
    }
    root = doc.findings;
    needsVerificationRaw = doc.needsVerification;
    hardeningCheckedRaw = doc.hardeningChecked;
  } else {
    throw new SddScriptError("usage: audit scaffold \u2014 findings file must be a JSON array or an object with a findings array", 2);
  }

  const findings = root.map((raw, index): AuditFinding => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}] is not an object`, 2);
    }
    const finding = raw as Record<string, unknown>;
    const title = typeof finding.title === "string" ? finding.title.trim() : "";
    const impact = typeof finding.description === "string" ? finding.description.trim() : "";
    const priority = typeof finding.priority === "string" ? finding.priority : "";
    const effort = typeof finding.effort === "string" ? finding.effort : "";
    const risk = typeof finding.risk === "string" ? finding.risk : "";
    const category = typeof finding.category === "string" ? finding.category : "";
    if (title === "" || impact === "") {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}] needs non-empty title and description`, 2);
    }
    if (AUDIT_PRIORITY_LOOKUP[priority] !== true) {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}].priority must be one of ${AUDIT_PRIORITIES.join("|")}`, 2);
    }
    if (AUDIT_EFFORT_LOOKUP[effort] !== true) {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}].effort must be one of ${AUDIT_EFFORTS.join("|")}`, 2);
    }
    if (AUDIT_RISK_LOOKUP[risk] !== true) {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}].risk must be one of ${AUDIT_RISKS.join("|")}`, 2);
    }
    if (AUDIT_CATEGORY_LOOKUP[category] !== true) {
      throw new SddScriptError(`usage: audit scaffold \u2014 findings[${index}].category must be one of ${AUDIT_CATEGORIES.join("|")}`, 2);
    }
    const rawDependsOn = typeof finding.dependsOn === "string" && finding.dependsOn.trim() !== "" ? finding.dependsOn.trim() : undefined;
    if (rawDependsOn !== undefined && !/^(?:none|plans\/\d{3}-[\w.*-]+\.md|\d{3})$/i.test(rawDependsOn)) {
      throw new SddScriptError(
        `usage: audit scaffold \u2014 findings[${index}].dependsOn must be "none", "plans/NNN-*.md", or a plan number NNN`,
        2,
      );
    }
    const dependsOn =
      rawDependsOn === undefined ? undefined : /^\d{3}$/.test(rawDependsOn) ? `plans/${rawDependsOn}-*.md` : rawDependsOn;
    // Enum memberships were validated above \u2014 cast the narrowed unions.
    return {
      title,
      category: category as AuditCategory,
      impact,
      effort: effort as AuditEffort,
      risk: risk as AuditRisk,
      confidence: "MED",
      evidence: [],
      priority: priority as AuditPriority,
      dependsOn,
    };
  });

  return { findings, needsVerification: parseNeedsVerification(needsVerificationRaw), hardeningChecked: parseHardeningChecked(hardeningCheckedRaw) };
}

function parseNeedsVerification(raw: unknown): AuditScaffoldInput["needsVerification"] {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new SddScriptError("usage: audit scaffold \u2014 needsVerification must be an array of {lead, how, evidence?}", 2);
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SddScriptError(`usage: audit scaffold \u2014 needsVerification[${index}] is not an object`, 2);
    }
    const e = entry as Record<string, unknown>;
    const lead = typeof e.lead === "string" ? e.lead.trim() : "";
    const how = typeof e.how === "string" ? e.how.trim() : "";
    if (lead === "" || how === "") {
      throw new SddScriptError(`usage: audit scaffold \u2014 needsVerification[${index}] needs non-empty lead and how`, 2);
    }
    const evidence = typeof e.evidence === "string" && e.evidence.trim() !== "" ? e.evidence.trim() : undefined;
    return { lead, how, evidence };
  });
}

function parseHardeningChecked(raw: unknown): AuditScaffoldInput["hardeningChecked"] {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new SddScriptError("usage: audit scaffold \u2014 hardeningChecked must be an array of {kind, text}", 2);
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SddScriptError(`usage: audit scaffold \u2014 hardeningChecked[${index}] is not an object`, 2);
    }
    const e = entry as Record<string, unknown>;
    const kind = typeof e.kind === "string" ? e.kind : "";
    const text = typeof e.text === "string" ? e.text.trim() : "";
    if (!AUDIT_HARDENING_KINDS.includes(kind as (typeof AUDIT_HARDENING_KINDS)[number])) {
      throw new SddScriptError(`usage: audit scaffold \u2014 hardeningChecked[${index}].kind must be one of ${AUDIT_HARDENING_KINDS.join("|")}`, 2);
    }
    if (text === "") {
      throw new SddScriptError(`usage: audit scaffold \u2014 hardeningChecked[${index}] needs non-empty text`, 2);
    }
    return { kind: kind as (typeof AUDIT_HARDENING_KINDS)[number], text };
  });
}

const auditCommand = program
  .command("audit")
  .description("audit planning operations and static security checks (engine-backed)");

/**
 * Resolve the short repo SHA for the scaffolded `Planned at` field:
 * `--sha` override wins; otherwise `git rev-parse --short HEAD` from the
 * current working directory; `unknown` only when the cwd is not inside a
 * git repo (the documented validator fallback \u2014 qc2 F-001 / qc3 F-002).
 */
function resolveAuditShortSha(cwd: string, override?: string): string {
  if (override !== undefined && override !== "") return override;
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return "unknown";
  }
}

auditCommand
  .command("scaffold")
  .description(
    "Scaffold an audit-<date>/ plan directory (numbered plan files + README index) from a JSON findings file " +
      "(exit 2 on usage)",
  )
  .argument("[findings-file]", "JSON file: array of {title, priority, effort, risk, category, dependsOn?, description}, or object {findings: [...], needsVerification?: [{lead, how, evidence?}], hardeningChecked?: [{kind, text}]}")
  .option("--dir <out-dir>", "Output directory (default: ./audit-<date> from --date or today)")
  .option("--sha <commit>", "Short commit SHA for the Planned-at field (default: git rev-parse --short HEAD)")
  .option("--date <YYYY-MM-DD>", "Audit date (default: today)")
  .option("--repo <name>", "Repository name for the README title (default: repo)")
  .action((findingsFile: string | undefined, options: { dir?: string; sha?: string; date?: string; repo?: string }) => {
    try {
      if (!findingsFile) throw new SddScriptError("usage: audit scaffold <findings-file> [--dir <out-dir>]", 2);
      const abs = resolveCliPath(findingsFile);
      if (!fs.existsSync(abs)) throw new Error(`findings file not found: ${abs}`);
      if (options.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
        throw new SddScriptError("usage: audit scaffold \u2014 --date must be YYYY-MM-DD", 2);
      }
      if (options.sha !== undefined && !/^[0-9a-f]{7,40}$/.test(options.sha)) {
        throw new SddScriptError("usage: audit scaffold \u2014 --sha must be a 7-40 char hex commit SHA", 2);
      }
      const date = options.date ?? new Date().toISOString().slice(0, 10);
      const outDir = options.dir !== undefined ? resolveCliPath(options.dir) : resolveCliPath(`audit-${date}`);
      const input = parseAuditScaffoldInput(fs.readFileSync(abs, "utf8"));
      const sha = resolveAuditShortSha(process.cwd(), options.sha);
      const result = scaffoldAuditPlan(outDir, input.findings, {
        date,
        repoName: options.repo,
        repoShortSha: sha,
        needsVerification: input.needsVerification,
        hardeningChecked: input.hardeningChecked,
      });
      const count = result.files.length;
      console.log(pc.green(`audit scaffold: OK \u2014 ${count} plan file${count === 1 ? "" : "s"} in ${result.outDir}`));
      for (const file of result.files) console.log(`  created: ${file}`);
    } catch (error) {
      failScript(error, "audit scaffold");
    }
  });

auditCommand
  .command("promote")
  .description(
    "Promote selected audit plans into the v2 workflow lifecycle: write the workflow snapshot " +
      "(type plan, Todo rows) then register the workflow in {HARNESS_DIR}/status.json " +
      "(exit 2 on usage, 1 when the harness dir cannot be resolved)",
  )
  .argument("[audit-dir]", "audit-<date>/ directory under {PLAN_DIR}")
  .option("--plans <ids>", "Comma-separated selected plan ids (README Plan column `001`, stem, or basename)")
  .option("--workflow <id>", "Workflow id (default: audit-<date> basename)")
  .option("--harness <dir>", "Harness dir containing status.json (default: resolveHarnessDir() / MSTAR_HARNESS_DIR)")
  .action(async (auditDir: string | undefined, options: { plans?: string; workflow?: string; harness?: string }) => {
    try {
      // Optional flag + explicit check (same as `lease verify-integration`):
      // commander's own missing-requiredOption error exits 1, which would
      // bypass the usage contract (exit 2) \u2014 validate in-handler instead.
      if (!auditDir) {
        throw new SddScriptError("usage: audit promote <audit-dir> --plans <ids> [--workflow <id>] [--harness <dir>]", 2);
      }
      const selected = parseCsv(options.plans);
      if (!selected || selected.length === 0) {
        throw new SddScriptError("usage: audit promote <audit-dir> --plans <ids> [--workflow <id>] [--harness <dir>]", 2);
      }
      const outDir = resolveCliPath(auditDir);
      if (!fs.existsSync(outDir)) {
        throw new Error(`audit dir not found: ${outDir}`);
      }
      const harnessDir = resolveLeaseHarnessDir(options.harness);
      // Store-root pinning (plan Task 4 Part B): the root upsert inside
      // promoteAuditPlans puts through getArtifactStore() \u2014 pin it to the
      // resolved harness root (identical to the default when --harness is absent).
      setArtifactStore(createFsStore(harnessDir));
      const result = await promoteAuditPlans(outDir, selected, {
        harnessDir,
        ...(options.workflow !== undefined ? { workflowId: options.workflow } : {}),
      });
      console.log(pc.green(`audit promote: OK \u2014 workflow ${result.workflowId} registered`));
      console.log(`  snapshot: ${result.snapshotPath}`);
    } catch (error) {
      failScript(error, "audit promote");
    }
  });

/**
 * Tracked-file walk for `audit secret-scan`: `git -C <root> ls-files -z -- .`
 * (index = the tracked file set; untracked scratch is not scanned). The
 * pathspec runs ROOT-RELATIVE (`.` from cwd=root) so emitted names are
 * already root-scoped \u2014 joining them to `root` is exact. A repository-
 * relative pathspec (`-- <root>`) would double-prefix nested roots
 * (`<root>/packages/engine/packages/engine/…`) and silently scan nothing
 * (qc1 W-001).
 *
 * Fail-closed (qc1 W-002 / qc3 W-1): a git failure (not a repository,
 * missing executable, permission error) throws a usage-class error \u2014 it
 * must never masquerade as "clean". Read failures during the scan itself
 * are counted by {@link scanSecrets} via the returned reads result.
 */
function listTrackedFiles(root: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "-z", "--", "."], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new SddScriptError("not a git repository or git unavailable \u2014 refusing to report an empty scan as clean", 2);
  }
  return out.split("\0").filter((f) => f !== "").map((f) => path.join(root, f));
}
auditCommand
  .command("secret-scan")
  .description(
    "Read-only credential-pattern scan over git-tracked files under [path] " +
      "(default cwd): prints {file, line, type} findings; never prints values. " +
      "Exit 1 on findings, 0 when clean, 2 when the tracked-file walk or reads fail",
  )
  .argument("[path]", "Directory to scan (default: cwd)")
.action((scanPath: string | undefined) => {
    try {
      const root = scanPath !== undefined ? resolveCliPath(scanPath) : process.cwd();
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new SddScriptError(`usage: audit secret-scan [path] \u2014 not a directory: ${root}`, 2);
      }
      const files = listTrackedFiles(root);
      const { findings, unreadableFiles } = scanSecrets(files);
      // Fail closed (qc1 W-002): selected-but-unreadable tracked files mean
      // the scan did NOT see the full tree \u2014 exit non-zero even when the
      // readable portion is clean. Findings are still printed first.
      if (unreadableFiles > 0) {
        console.error(pc.red(`secret-scan: failed to read ${unreadableFiles} tracked file${unreadableFiles === 1 ? "" : "s"} under ${root} \u2014 refusing to report clean`));
        for (const f of findings) console.log(JSON.stringify({ file: f.file, line: f.line, type: f.type }));
        process.exitCode = 1;
        return;
      }
      if (findings.length === 0) {
        console.log(pc.green(`secret-scan: clean \u2014 ${files.length} tracked file${files.length === 1 ? "" : "s"} scanned under ${root}`));
        return;
      }
      console.error(pc.red(`secret-scan: ${findings.length} finding${findings.length === 1 ? "" : "s"} under ${root}`));
      for (const f of findings) console.log(JSON.stringify({ file: f.file, line: f.line, type: f.type }));
      // Hard Rule 4 shape only \u2014 no secret value is ever printed.
      process.exitCode = 1;
    } catch (error) {
      failScript(error, "audit secret-scan");
    }
  });

auditCommand
  .command("supply-chain")
  .description(
    "Supply-chain checks over a repo root (read-only): root lockfile presence/duplication, " +
      "unpinned GitHub Actions refs, pull_request_target PR-head checkout. " +
      "Exit 1 on findings, 0 when clean",
  )
  .argument("[path]", "Repository root (default: cwd)")
.action((repoPath: string | undefined) => {
    try {
      const root = repoPath !== undefined ? resolveCliPath(repoPath) : process.cwd();
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new SddScriptError(`usage: audit supply-chain [path] \u2014 not a directory: ${root}`, 2);
      }
      const result = supplyChainChecks(root);
      if (result.ok) {
        console.log(pc.green(`supply-chain: OK \u2014 no findings in ${root}`));
        return;
      }
      console.error(pc.red(`supply-chain: ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"} in ${root}`));
      for (const v of result.violations) {
        console.error(pc.red(`  ${v.code}: ${v.message}`));
        if (v.fix) console.error(pc.red(`    fix: ${v.fix}`));
      }
      for (const f of result.findings) console.log(JSON.stringify(f));
      process.exitCode = 1;
    } catch (error) {
      failScript(error, "audit supply-chain");
    }
  });


const compoundCommand = program
  .command("compound")
  .description("knowledge-doc schema / index / scope checks (engine-backed)");

compoundCommand
  .command("validate")
  .description(
    "Validate a knowledge doc frontmatter (schema.yaml contract); with --knowledge-dir, also assert the " +
      "knowledge README index rows and guard the doc inside the knowledge scope (exit 1 on violations, 2 on usage)",
  )
  .argument("[doc-path]", "Knowledge doc (markdown with YAML frontmatter)")
  .option("--knowledge-dir <dir>", "Knowledge directory (enables index-row asserts + scope guard)")
  .action((docPath: string | undefined, options: { knowledgeDir?: string }) => {
    try {
      if (!docPath) throw new SddScriptError("usage: compound validate <doc-path> [--knowledge-dir <dir>]", 2);
      const abs = resolveCliPath(docPath);
      if (!fs.existsSync(abs)) throw new Error(`knowledge doc not found: ${abs}`);
      const text = fs.readFileSync(abs, "utf8");
      const violations: ValidationResult[] = [];
      const schema = validateSchemaYaml(text);
      printChecklist("compound validate (schema)", schema);
      violations.push(...schema.violations);
      if (options.knowledgeDir !== undefined) {
        const knowledgeDir = resolveCliPath(options.knowledgeDir);
        const index = assertIndexRows(knowledgeDir);
        printChecklist("compound validate (index rows)", index);
        violations.push(...index.violations);
        const scope = scopeGuard(abs, [knowledgeDir]);
        printChecklist("compound validate (scope guard)", scope);
        violations.push(...scope.violations);
      }
      if (violations.length > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "compound validate");
    }
  });

/** Audit enum membership lookups (engine enum arrays \u2014 no drift). */
const AUDIT_PRIORITY_LOOKUP = lookupTable(AUDIT_PRIORITIES);
const AUDIT_EFFORT_LOOKUP = lookupTable(AUDIT_EFFORTS);
const AUDIT_RISK_LOOKUP = lookupTable(AUDIT_RISKS);
const AUDIT_CATEGORY_LOOKUP = lookupTable(AUDIT_CATEGORIES);

/** Valid `host detect --signals` tokens (mstar-host detection table, ported
 * verbatim to the engine's ToolSignal enum). */
const HOST_SIGNALS: readonly ToolSignal[] = [
  "subagent_type",
  "question",
  "task_subagent",
  "task_agent_batch",
  "ask",
  "hub",
  "Agent",
  "AgentSwarm",
  "AskUserQuestion",
  "EnterPlanMode",
  "TodoWrite",
  "plan_slash",
  "goal",
  "functions.*",
  "tool_search",
];

/** Membership lookup for the signal list above. */
const HOST_SIGNAL_LOOKUP = lookupTable(HOST_SIGNALS);

/** Valid `host skill-root --host` ids (engine HostId union \u2014 no drift). */
const HOST_IDS: readonly HostId[] = ["opencode", "omp", "pi", "dsh", "cursor", "codex", "kimi", "zcode"];

/** Membership lookup for the host ids above. */
const HOST_ID_LOOKUP = lookupTable(HOST_IDS);

const hostCommand = program
  .command("host")
  .description("host detection from session tool shapes (engine-backed)");

hostCommand
  .command("detect")
  .description(
    "Detect the active host from --signals (comma-separated tool-shape tokens): prints the host id or " +
      "'ambiguous' (exit 2 on usage)",
  )
  .option("--signals <list>", "Comma-separated tool-shape signals (e.g. question,ask,hub)")
  .action((options: { signals?: string }) => {
    try {
      if (!options.signals) throw new SddScriptError("usage: host detect --signals <comma-list>", 2);
      const signals = options.signals
        .split(",")
        .map((signal) => signal.trim())
        .filter((signal) => signal !== "");
      if (signals.length === 0) throw new SddScriptError("usage: host detect --signals <comma-list>", 2);
      for (const signal of signals) {
        if (HOST_SIGNAL_LOOKUP[signal] !== true) {
          throw new SddScriptError(`usage: host detect \u2014 unknown signal "${signal}" (valid: ${HOST_SIGNALS.join(", ")})`, 2);
        }
      }
      const result = detectHost(signals as ToolSignal[]);
      if (result === "ambiguous") {
        console.log(pc.yellow("host: ambiguous \u2014 apply the mstar-host detection table and prompt judgment"));
      } else {
        console.log(pc.green(`host: ${result}`));
      }
    } catch (error) {
      failScript(error, "host detect");
    }
  });

hostCommand
  .command("skill-root")
  .description(
    "Resolve the loaded skill root for a host (mstar-host \u00a7 Resolve loaded skill root): prints the canonical " +
      "skill-root string for --host / --skill (exit 1 on missing required options, 2 on usage errors)",
  )
  .requiredOption("--host <id>", "Host id (opencode | omp | pi | dsh | cursor | codex | kimi | zcode)")
  .requiredOption("--skill <name>", "Skill name to resolve")
  .option("--rel <path>", "Optional skill-relative path suffix")
  .action((options: { host: string; skill: string; rel?: string }) => {
    try {
      if (HOST_ID_LOOKUP[options.host] !== true) {
        throw new SddScriptError(`usage: host skill-root \u2014 unknown host "${options.host}" (valid: ${HOST_IDS.join(", ")})`, 2);
      }
      if (options.skill.trim() === "") {
        throw new SddScriptError("usage: host skill-root \u2014 --skill must be a non-empty skill name", 2);
      }
      const root = resolveSkillRoot(options.host as HostId, { skill: options.skill, rel: options.rel });
      if (options.host === "pi") {
        console.log(pc.yellow(root));
      } else {
        console.log(pc.green(root));
      }
    } catch (error) {
      failScript(error, "host skill-root");
    }
  });

const skillCommand = program
  .command("skill")
  .description("skill-authoring lints (engine-backed)");

skillCommand
  .command("lint")
  .description(
    "Lint <skill-dir>/SKILL.md: frontmatter contract (name lowercase-hyphen, description trigger contract) " +
      "+ the five-question body + ephemeral-citation scan (task-<digits>-* artifacts and .mstar/sdd/\u2026 deeplinks \u2014 " +
      "exit 1 on violations, 2 on usage)",
  )
  .argument("[skill-dir]", "Skill directory containing SKILL.md")
  .action((skillDir?: string) => {
    try {
      if (!skillDir) throw new SddScriptError("usage: skill lint <skill-dir>", 2);
      const skillFile = path.join(resolveCliPath(skillDir), "SKILL.md");
      if (!fs.existsSync(skillFile)) throw new Error(`SKILL.md not found: ${skillFile}`);
      const text = fs.readFileSync(skillFile, "utf8");
      const violations: ValidationResult[] = [];
      const frontmatter = lintFrontmatter(text);
      printChecklist("skill lint (frontmatter)", frontmatter);
      violations.push(...frontmatter.violations);
      // Five-question mode selection: runtime for shipped `mstar-*` topic
      // skills (locked alias table), authoring / strict for
      // `mstar-skill-authoring` (the standard's own definition) and for
      // non-`mstar-*` skills. `mstar-harness-core` is exempt by design
      // (hub headings) \u2014 print an explicit exempt row; frontmatter and
      // ephemeral-citation checks still run.
      const skillBase = path.basename(path.dirname(skillFile));
      const isCore = skillBase === "mstar-harness-core";
      const fiveQuestionMode: FiveQuestionMode =
        skillBase.startsWith("mstar-") && !isCore && skillBase !== "mstar-skill-authoring" ? "runtime" : "authoring";
      if (isCore) {
        console.log(pc.yellow("skill lint (five questions): EXEMPT \u2014 mstar-harness-core is exempt by design (hub headings)"));
      } else {
        const fiveQuestion = lintFiveQuestion(stripFrontmatter(text), fiveQuestionMode);
        printChecklist("skill lint (five questions)", fiveQuestion);
        violations.push(...fiveQuestion.violations);
      }
      // findEphemeralCitations is a discovery finder (array, no GateResult);
      // wrap into a GateResult like the other skill lint checklists \u2014 empty
      // array passes, each citation is one violation (codes
      // skill.ephemeral.<kind>, knowledge conventions §3).
      const ephemeral = findEphemeralCitations(text);
      const ephemeralGate: GateResult = {
        ok: ephemeral.length === 0,
        violations: ephemeral.map((citation) => ({
          ok: false,
          severity: "medium",
          code: `skill.ephemeral.${citation.kind}`,
          message: `ephemeral ${citation.kind} citation at line ${citation.line}: "${citation.match}" \u2014 task artifacts and SDD deeplinks survive nothing; durable skill text cites in-repo artifacts only (knowledge conventions/skill-content-porting-discipline.md \u00a73)`,
          fix: `rewrite "${citation.match}" as a placeholder form (e.g. task-N-report, <plan-id>, {SDD_DIR}/task-N-report.md) or cite a stable in-repo artifact instead`,
        })),
      };
      printChecklist("skill lint (ephemeral citations)", ephemeralGate);
      violations.push(...ephemeralGate.violations);
      if (violations.length > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "skill lint");
    }
  });

const rolesCommand = program
  .command("roles")
  .description("mstar-roles mapping / load-order checks (engine-backed)");

rolesCommand
  .command("validate")
  .description(
    "Validate the mstar-roles skill-dir state: role mapping / parameter tables against the on-disk " +
      "references layout plus load-order declarations across sibling mstar-* skills " +
      "(exit 1 on violations)",
  )
  .option(
    "--roles-dir <dir>",
    "mstar-roles skill directory (default: skills/mstar-roles, resolved against the project root)",
  )
  .option("--skills-dir <dir>", "Skills root scanned for sibling mstar-* skills (default: parent of the roles dir)")
  .action((options: { rolesDir?: string; skillsDir?: string }) => {
    try {
      const rolesDir = resolveCliPath(options.rolesDir ?? "skills/mstar-roles");
      const skillsRoot = options.skillsDir ? resolveCliPath(options.skillsDir) : path.dirname(rolesDir);
      // Thin mirror of the dsh seam validateRolesState (packages/dsh/src/gates/seams.ts):
      // validateRoleMapping(rolesDir) + lintLoadOrder over sibling mstar-* SKILL.md
      // texts; unreadable siblings are skipped best-effort so a bad read can never
      // take the gate down.
      const violations: ValidationResult[] = [];
      const mapping = validateRoleMapping(rolesDir);
      printChecklist("roles validate (mapping)", mapping);
      violations.push(...mapping.violations);
      const skillTexts: Record<string, string> = {};
      for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("mstar-")) continue;
        const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        try {
          skillTexts[entry.name] = fs.readFileSync(skillFile, "utf8");
        } catch {
          // skip unreadable sibling \u2014 the mapping checks still stand
        }
      }
      const loadOrder = lintLoadOrder(skillTexts);
      printChecklist("roles validate (load order)", loadOrder);
      violations.push(...loadOrder.violations);
      const total = violations.length;
      // Two distinct counts for the same corpus: siblings scanned (all
      // readable mstar-* dirs, incl. mstar-harness-core) vs skills actually
      // load-order-linted (core is exempt inside the engine) \u2014 keep the
      // labels distinct so 18-vs-17 is not misread as a discrepancy.
      const siblingCount = Object.keys(skillTexts).length;
      const loadOrderChecked = Object.keys(skillTexts).filter((name) => name !== "mstar-harness-core").length;
      const coreExempt = loadOrderChecked !== siblingCount;
      console.log(
        `roles validate: ${total === 0 ? "OK" : "FAIL"} (${total} violation${total === 1 ? "" : "s"}, ` +
          `${siblingCount} sibling skill${siblingCount === 1 ? "" : "s"} scanned; ` +
          `load-order over ${loadOrderChecked}${coreExempt ? ", core exempt" : ""})`,
      );
      if (total > 0) process.exitCode = 1;
    } catch (error) {
      failScript(error, "roles validate");
    }
  });

const prReviewCommand = program
  .command("pr-review")
  .description(
    "PR-review deterministic arithmetic and naming contracts (engine-backed): tally computation, " +
      "local-report path resolution, saved-report validation (pr-review.md \u00a7 Tally / \u00a7 Local report archive / \u00a7 Output shape)",
  );

/** Parse `--target pr:<n>|branch:<slug>|diff:<sha>|diff` into a PrReportTarget (exit 2 on a bad form). */
function parsePrReviewTarget(raw: string): PrReportTarget {
  const kind = raw.slice(0, raw.indexOf(":") === -1 ? raw.length : raw.indexOf(":"));
  const rest = kind.length + 1 <= raw.length ? raw.slice(kind.length + 1) : "";
  if (kind === "pr") {
    const n = Number(rest);
    if (!/^[0-9]+$/.test(rest) || !Number.isInteger(n) || n < 1) {
      throw new SddScriptError(`usage: pr-review report-path \u2014 --target pr requires a positive integer PR number, got ${JSON.stringify(raw)}`, 2);
    }
    return { kind: "pr", n };
  }
  if (kind === "branch") {
    if (rest === "") throw new SddScriptError(`usage: pr-review report-path \u2014 --target branch requires the branch slug, got ${JSON.stringify(raw)}`, 2);
    return { kind: "branch", slug: rest };
  }
  if (kind === "diff" && rest === "") return { kind: "diff" };
  if (kind === "diff") return { kind: "diff", headSha: rest };
  throw new SddScriptError(
    `usage: pr-review report-path \u2014 --target must be pr:<n> | branch:<slug> | diff:<sha> | diff, got ${JSON.stringify(raw)}`,
    2,
  );
}

prReviewCommand
  .command("tally")
  .description(
    "Compute the locked-formula tally, verdict and score from accepted findings JSON ([{mergeClass}]) plus the " +
      "leftover unmet-AC / unverified counts; prints the two-line chat header + structured result (pr-review.md \u00a7 Tally)",
  )
  .requiredOption("--findings <file.json>", "Accepted findings JSON \u2014 array of {mergeClass: must-fix|should-fix|nit}")
  .option("--unverified <n>", "Count of residual - unverified: items (default 0)")
  .option("--unmet-ac-unsafe <n>", "Leftover unmet ACs that are unsafe-to-ship (each \u2192 must_fix + 1)")
  .option("--unmet-ac-safe <n>", "Leftover unmet ACs that are ship-safe (each \u2192 should_fix + 1)")
  .action((options: { findings: string; unverified?: string; unmetAcUnsafe?: string; unmetAcSafe?: string }) => {
    try {
      const findingsPath = resolveCliPath(options.findings);
      if (!fs.existsSync(findingsPath)) throw new Error(`findings file not found: ${findingsPath}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(findingsPath, "utf8"));
      } catch (error) {
        throw new Error(`--findings is not valid JSON: ${(error as Error).message}`);
      }
      if (!Array.isArray(parsed)) {
        throw new Error("findings file must be a JSON array of {mergeClass} objects");
      }
      const MERGE_CLASS_SET: readonly string[] = ["must-fix", "should-fix", "nit"];
      const findings = parsed.map((entry, index) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          throw new Error(`findings[${index}] must be an object with a mergeClass field`);
        }
        const mergeClass = (entry as Record<string, unknown>).mergeClass;
        if (typeof mergeClass !== "string" || !MERGE_CLASS_SET.includes(mergeClass)) {
          throw new Error(
            `findings[${index}].mergeClass ${JSON.stringify(String(mergeClass))} must be one of ${MERGE_CLASS_SET.join(" | ")}`,
          );
        }
        return { mergeClass: mergeClass as MergeClass };
      });
      // Plain decimal digits only (plan-QC F-004) \u2014 same integer grammar as
      // parsePrReviewTarget and the validator's tally parser; Number() would
      // accept `1e2`, `0x10` or `1.0`.
      // Cap at the engine's TALLY_CAP (plan-QC S-02): absurd counts would
      // materialize that many unmetAc objects before computePrTally.
      const TALLY_COUNT_CAP = 50;
      const countOption = (flag: string, raw: string | undefined): number | undefined => {
        if (raw === undefined) return undefined;
        if (!/^\d+$/.test(raw)) {
          throw new Error(`${flag} must be a non-negative integer, got ${JSON.stringify(raw)}`);
        }
        const n = Number(raw);
        if (n > TALLY_COUNT_CAP) {
          throw new Error(`too many ${flag} values (cap ${TALLY_COUNT_CAP}) - got ${JSON.stringify(raw)}`);
        }
        return n;
      };
      const unverifiedCount = countOption("--unverified", options.unverified);
      const unmetUnsafe = countOption("--unmet-ac-unsafe", options.unmetAcUnsafe) ?? 0;
      const unmetSafe = countOption("--unmet-ac-safe", options.unmetAcSafe) ?? 0;
      const result = computePrTally({
        findings,
        ...(unverifiedCount !== undefined ? { unverifiedCount } : {}),
        unmetAc: [
          ...Array.from({ length: unmetUnsafe }, () => ({ unsafeToShip: true })),
          ...Array.from({ length: unmetSafe }, () => ({ unsafeToShip: false })),
        ],
      });
      console.log(result.chatHeader);
      console.log(JSON.stringify({ verdict: result.verdict, scorePct: result.scorePct, tally: result.tally }, null, 2));
    } catch (error) {
      failScript(error, "pr-review tally");
    }
  });

prReviewCommand
  .command("report-path")
  .description(
    "Resolve the local-report (or evidence-file) path for a reviewed target per pr-review.md \u00a7 Local report archive \u2014 " +
      "pure resolver, prints the path and never writes; appends -r2/-r3 on same-day collisions",
  )
  .requiredOption("--reports-dir <dir>", "Reports directory ({PROJECT_DIR}/<project-id>/reports/pr-review); created on demand by the caller, scanned read-only here")
  .requiredOption("--target <spec>", "Reviewed target: pr:<n> | branch:<slug> | diff:<short-sha> | diff")
  .option("--stage <1|2>", "Evidence-file stage (requires --slug)")
  .option("--slug <domain-seat>", "Seat slug <domain>-<seat> (required with --stage)")
  .option("--date <YYYY-MM-DD>", "Archive date (default: today)")
  .action((options: { reportsDir: string; target: string; stage?: string; slug?: string; date?: string }) => {
    try {
      let stage: 1 | 2 | undefined;
      if (options.stage !== undefined) {
        if (options.stage !== "1" && options.stage !== "2") {
          throw new SddScriptError(`usage: pr-review report-path \u2014 --stage must be 1 or 2, got ${JSON.stringify(options.stage)}`, 2);
        }
        stage = options.stage === "1" ? 1 : 2;
      }
      if ((stage !== undefined) !== (options.slug !== undefined)) {
        throw new SddScriptError("usage: pr-review report-path \u2014 --stage and --slug go together (--slug <domain-seat> required with --stage)", 2);
      }
      if (options.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
        throw new SddScriptError(`usage: pr-review report-path \u2014 --date must be YYYY-MM-DD, got ${JSON.stringify(options.date)}`, 2);
      }
      const resolved = prReviewReportPath({
        reportsDir: resolveCliPath(options.reportsDir),
        target: parsePrReviewTarget(options.target),
        ...(stage !== undefined ? { stage } : {}),
        ...(options.slug !== undefined ? { slug: options.slug } : {}),
        ...(options.date !== undefined ? { date: options.date } : {}),
      });
      console.log(resolved);
    } catch (error) {
      failScript(error, "pr-review report-path");
    }
  });

prReviewCommand
  .command("validate-report")
  .description(
    "Validate a saved local PR-review report against the machine-readable contract (frontmatter fields, verdict-from-tally, " +
      "locked-formula score recompute, comments tri-state; exit 1 with violations printed)",
  )
  .argument("<file.md>", "Saved report markdown file")
  .action((reportFile: string) => {
    try {
      const abs = resolveCliPath(reportFile);
      if (!fs.existsSync(abs)) throw new Error(`report file not found: ${abs}`);
      const gate = validatePrReviewReport(fs.readFileSync(abs, "utf8"));
      printChecklist(abs, gate);
      if (!gate.ok) process.exitCode = 1;
    } catch (error) {
      failScript(error, "pr-review validate-report");
    }
  });

// ---------------------------------------------------------------------------
// Task 3 (20260826-prreview-execution): pr-review post / worktree-setup /
// worktree-cleanup / size / seat-prompt \u2014 thin CLI wrappers; the
// deterministic part lives in @mstar-harness/engine prreview.ts, the CLI owns
// process/git/gh side effects only.
// ---------------------------------------------------------------------------

/** Run a git command in `cwd`, returning trimmed stdout. Throws on failure. */
function gitSync(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Git capture ceiling for snapshot bytes — imported from the engine
 * (packages/engine/src/sdd.ts, the same 64 MiB ceiling `reviewPackage`
 * uses): Node's default 1 MiB `maxBuffer` ENOBUFS'd on large review
 * ranges. Captures beyond that fail the setup.
 */

/** Run a git command in `cwd`, returning UNTRIMMED stdout bytes (snapshot
 * capture — same maxBuffer ceiling as the engine's `reviewPackage`). */
function gitRaw(args: string[], cwd: string): Buffer {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_CAPTURE_MAX_BYTES });
}

/** Run `gh` with `input` on stdin, returning parsed stdout. Throws on failure. */
function ghSync(args: string[], input?: string): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(input !== undefined ? { input } : {}) }).trim();
}

/** Local calendar date YYYY-MM-DD (branch-collision loop date segment). */
function cliToday(): string {
  const iso = new Date().toISOString();
  return iso.slice(0, 10);
}

/** All local branch names (`git for-await --format=%(refname:short)`) minus the "heads/" prefix. */
function listLocalBranches(cwd: string): Set<string> {
  const out = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Set(out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ""));
}

/** True when `ref` resolves (`git rev-parse --verify --quiet`). */
function refResolves(ref: string, cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Changeset non-emptiness probe per mode (pr-review.md § Worktree isolation):
 * - working-tree: `git diff` + `git diff --cached`, FOLDED WITH untracked
 *   output from `git ls-files --others --exclude-standard` (untracked-only
 *   counts as a non-empty changeset)
 * - every other mode: the recorded diffCmd must produce at least one line
 */
function probeChangesetEmpty(diffCmdArgs: string[], cwd: string, worktreePath: string): boolean {
  if (diffCmdArgs[0] === "__working_tree__") {
    // A probe that cannot run (broken git / >64 MiB overflow) must NOT read
    // as "empty changeset" — null → not empty → proceed; the snapshot
    // capture then fails loudly at the same ceiling and rolls back.
    const diffOut = gitProbe(["diff"], worktreePath);
    const cachedOut = gitProbe(["diff", "--cached"], worktreePath);
    if (diffOut === null || cachedOut === null) return false;
    const dirty = diffOut.length > 0 || cachedOut.length > 0;
    if (dirty) return false;
    let untracked = "";
    try {
      untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
    } catch { /* read-only failure counts as empty */ }
    return untracked.trim() === "";
  }
  // commit mode (`git show <sha>`): git always emits the commit header even
  // for an empty commit \u2014 only hunks count as a changeset. Probe a header-free
  // diff instead: parent→commit where a parent resolves, otherwise (history
  // root) the canonical empty tree → commit.
  if (diffCmdArgs[0] === "show") {
    const sha = diffCmdArgs[1]!;
    const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const diffFrom = refResolves(`${sha}^`, worktreePath) ? `${sha}^` : EMPTY_TREE;
    const probe = gitProbe(["diff", diffFrom, sha], worktreePath);
    return probe === null ? false : probe.trim().length === 0;
  }
  const probe = gitProbe(diffCmdArgs, worktreePath);
  return probe === null ? false : probe.length === 0;
}

/** Like {@link gitSync} but returns "" instead of throwing (probe paths).
 * Carries the same 64 MiB capture ceiling as the engine's `gitOut` — a
 * changeset-emptiness probe on a large diff must not ENOBUFS into a false
 * "empty" verdict. */
function gitIf(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: GIT_CAPTURE_MAX_BYTES });
  } catch {
    return "";
  }
}

/** Like {@link gitIf} but returns null instead of "" when git fails — a
 * probe that cannot run must NOT read as an empty changeset (a broken-git
 * or >64 MiB-overflow probe would otherwise false-empty the preflight and
 * report "no changes to review" on a real changeset). */
function gitProbe(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: GIT_CAPTURE_MAX_BYTES });
  } catch {
    return null;
  }
}

/**
 * Changeset emptiness probe BEFORE the worktree exists (setup pre-gate):
 * working-tree probes the live checkout (tracked + staged + untracked);
 * `--diff` is the caller's contract (the CLI never sees its contents);
 * ref-carrying modes cannot know emptiness until the worktree exists, so
 * the pre-gate reports not-empty and the post-`worktree add` probe decides.
 */
function probeChangesetEmptyPreworktree(mode: ReviewChangesetMode, headSpec: string, cwd: string): boolean {
  if (mode === "working-tree") return probeChangesetEmpty(["__working_tree__"], cwd, cwd);
  if (mode === "diff") return false;
  void headSpec;
  return false;
}

/** Validate one findings-file entry shape; returns normalized inline comment. */
function parseFindingEntry(entry: unknown, index: number): ReviewPostPlan["inlineComments"][number] | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const rec = entry as Record<string, unknown>;
  if (rec.path === undefined && rec.body === undefined && rec.line === undefined) return null;
  const path = typeof rec.path === "string" ? rec.path : "";
  const body = typeof rec.body === "string" ? rec.body : "";
  const line = typeof rec.line === "number" ? rec.line : Number.NaN;
  if (!path.trim() || !body.trim() || !Number.isInteger(line) || line < 1) {
    throw new Error(
      `findings[${index}] must be an object {path: string, line: number >= 1, body: string} - got ${JSON.stringify(entry)}`,
    );
  }
  return { path, line, side: "RIGHT", body };
}

prReviewCommand
  .command("post")
  .description(
    "Build and POST the GitHub Review per pr-review.md \u00a7 Comment posting procedure: resolves the BASE owner/repo " +
      "from the PR url only (never headRepository), event is always COMMENT, posts via gh api with the payload on stdin, " +
      "applies the at-most-once 422 fallback (drop rejected inline entries and fold them into the body); prints review_url " +
      "(exit 1 = auth/API failure -> comments: failed)",
  )
  .requiredOption("--pr <n>", "PR number")
  .requiredOption("--body-file <path>", "Review body markdown file")
  .option("--findings <file.json>", "Optional inline comments JSON \u2014 array of {path, line, body} entries")
  .action((options: { pr: string; bodyFile: string; findings?: string }) => {
    try {
      if (!/^\d+$/.test(options.pr)) {
        throw new SddScriptError(`usage: pr-review post \u2014 --pr requires a positive integer PR number, got ${JSON.stringify(options.pr)}`, 2);
      }
      const prNumber = Number(options.pr);
      const bodyPath = resolveCliPath(options.bodyFile);
      if (!fs.existsSync(bodyPath)) throw new Error(`body file not found: ${bodyPath}`);
      const body = fs.readFileSync(bodyPath, "utf8");
      let comments: ReviewPostPlan["inlineComments"] = [];
      if (options.findings !== undefined) {
        const findingsPath = resolveCliPath(options.findings);
        if (!fs.existsSync(findingsPath)) throw new Error(`findings file not found: ${findingsPath}`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(fs.readFileSync(findingsPath, "utf8"));
        } catch (error) {
          throw new Error(`--findings is not valid JSON: ${(error as Error).message}`);
        }
        if (!Array.isArray(parsed)) throw new Error("findings file must be a JSON array of {path, line, body} objects");
        // File may also carry folded plan entries or section notes \u2014 only
        // well-shaped {path,line,body} objects become inline comments.
        comments = parsed.flatMap((entry, index) => {
          const parsedEntry = parseFindingEntry(entry, index);
          return parsedEntry === null ? [] : [parsedEntry];
        });
        if (parsed.length > 0 && comments.length === 0) {
          console.error(pc.yellow("pr-review post \u2014 no valid inline comment entries found in --findings (array is non-empty but every entry lacks path/line/body); posting the summary body with zero inline comments"));
        }
      }

      // Step 1 \u2014 resolve target: base owner/repo comes from url ONLY.
      // planReviewPost IGNORES prView.headRepository by contract (fork-PR
      // data must never feed owner/repo \u2014 see planReviewPost JSDoc); do not
      // add `headRepository` to this fetch or pass it downstream.
      const viewJson = ghSync(["pr", "view", String(prNumber), "--json", "url,headRefOid"]);
      let prView: { url?: string; headRepository?: unknown; headRefOid?: string };
      try {
        prView = JSON.parse(viewJson) as typeof prView;
      } catch (error) {
        throw new Error(`gh pr view returned invalid JSON: ${(error as Error).message}`);
      }
      const plan = planReviewPost(prView, { body, comments });

      // Step 2+3 \u2014 POST with payload on stdin; step 4 = at-most-ONE fallback retry.
      const apiPath = `repos/${plan.ownerRepo}/pulls/${plan.pr}/reviews`;
      const buildPayload = (kept: ReviewPostPlan["inlineComments"], dropped: ReviewPostPlan["inlineComments"]): string =>
        JSON.stringify({
          commit_id: plan.commitId,
          event: plan.event,
          body: dropped.length === 0 ? plan.body : foldIntoBody(plan.body, dropped),
          ...(kept.length > 0 ? { comments: kept.map((comment) => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body })) } : {}),
        });

      // gh prints its API-error line to STDERR (`gh: HTTP 422: ...`), and
      // GitHub's 422 JSON body typically carries no `"status"` field \u2014 scan
      // stderr, then stdout, then the process exit status for the code.
      type GhApiError = Error & { status?: number; stderr?: Buffer | string; stdout?: Buffer | string };
      const errorStreamText = (value?: Buffer | string): string => (typeof value === "string" ? value : value?.toString() ?? "");
      let reviewResponse: string;
      let remaining = plan.inlineComments;
      try {
        reviewResponse = ghApi(apiPath, buildPayload(remaining, []));
      } catch (error) {
        const ghError = error as GhApiError;
        const combinedErrorText = `${errorStreamText(ghError.stderr)}\n${errorStreamText(ghError.stdout)}${typeof ghError.status === "number" ? `\nexit status ${ghError.status}` : ""}`;
        const statusMatch = /HTTP\s+(\d{3})/.exec(combinedErrorText) ?? /"status":\s*(\d{3})/.exec(combinedErrorText);
        const rejectedStatus = statusMatch?.[1];
        if (rejectedStatus !== "422" && ghError.status !== 422) throw error;
        if (remaining.length === 0) throw error;
        const dropped = remaining;
        console.error(pc.yellow(`${dropped.length} inline comment(s) rejected (HTTP 422) - dropping inline comments and folding them into the body, retrying once`));
        remaining = [];
        reviewResponse = ghApi(apiPath, buildPayload(remaining, dropped));
      }
      let reviewUrl = "";
      try {
        const parsedReview = JSON.parse(reviewResponse) as { html_url?: unknown };
        reviewUrl = typeof parsedReview.html_url === "string" ? parsedReview.html_url : "";
      } catch {
        // keep stdout text as the url line content \u2014 never fail after a good POST
        reviewUrl = reviewResponse;
      }
      console.log(JSON.stringify({ posted: true, comments: "posted", review_url: reviewUrl || "(gh response)" }, null, 2));
    } catch (error) {
      if (error instanceof SddScriptError) {
        failScript(error, "pr-review post");
        return;
      }
      console.error(pc.red(`pr-review post failed: ${(error as Error).message}`));
      console.error(JSON.stringify({ posted: false, comments: "failed" }, null, 2));
      process.exitCode = 1;
    }
  });

/** Fold dropped inline entries into the summary body (\u00a7 Procedure step 4). */
function foldIntoBody(body: string, entries: ReviewPostPlan["inlineComments"]): string {
  if (entries.length === 0) return body;
  const lines = [
    ...body.split(/\r?\n/),
    "",
    "## Inline comments folded into this summary",
    "",
    ...entries.map((entry) => `- \`${entry.path}:${entry.line}\` \u2014 ${entry.body}`),
  ];
  return lines.join("\n");
}

/** POST to the Reviews API through gh; throws with gh's stderr on failure. */
function ghApi(apiPath: string, payload: string): string {
  return execFileSync("gh", ["api", "--method", "POST", apiPath, "--input", "-"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    input: payload,
  });
}

/** Sidecar state recorded by `worktree-setup`, consumed by `worktree-cleanup`. */
type ReviewWorktreeSidecar = {
  reviewBranch: string;
  worktreePath: string;
  base: string;
  mergeBase: string;
  diffCmd: string;
  reportSaved: boolean;
  createdAt: string;
  /** Git repo root that created this sidecar \u2014 every cleanup git command runs from here. */
  repoRoot: string;
  /** Absolute path to the pinned diff snapshot (review artifact beside the sidecar). */
  diffFile?: string;
  /** sha-256 of the diff snapshot this setup wrote - informational only, never an ownership gate. */
  diffFileSha256?: string;
  /** Device id of the snapshot file this setup wrote - inode identity for cleanup ownership. */
  diffFileDev?: number;
  /** Inode number of the snapshot file this setup wrote (string - ino can exceed JSON number safety). */
  diffFileIno?: string;
  /** mtime (ms) of the snapshot file this setup wrote - closes the ext4 inode-reuse hole (a replacement can inherit dev+ino, never the mtime). */
  diffFileMtimeMs?: number;
};

prReviewCommand
  .command("worktree-setup")
  .description(
    "Create the isolated review worktree per pr-review.md \u00a7 Worktree isolation: resolves the real base, picks a " +
      "collision-free branch name, fetches with explicit refspecs, creates the worktree, computes the diff basis INSIDE it, " +
      "and records a sidecar json consumed by worktree-cleanup; prints {reviewBranch, worktreePath, base, mergeBase, diffCmd, diffFile} " +
      "(input modes: --pr <n> | --branch <b> | --diff | --working-tree | --commit <sha>)",
  )
  .option("--pr <n>", "PR number input mode (pull/<n>/head via gh)")
  .option("--branch <name>", "Bare remote-branch input mode")
  .option("--diff", "Arbitrary diff input mode \u2014 no worktree, no refs")
  .option("--working-tree", "Uncommitted working-tree input mode \u2014 no worktree, no refs")
  .option("--commit <sha>", "Single-commit input mode")
  .option("--path <dir>", "Worktree target directory (default: <repo>/.worktrees/review-<branch>)")
  .action((options: { pr?: string; branch?: string; diff?: boolean; workingTree?: boolean; commit?: string; path?: string }) => {
    try {
      const modesDeclared = [
        options.pr !== undefined,
        options.branch !== undefined,
        options.diff === true,
        options.workingTree === true,
        options.commit !== undefined,
      ].filter(Boolean).length;
      if (modesDeclared === 0) {
        throw new SddScriptError("usage: pr-review worktree-setup \u2014 one of --pr <n> | --branch <b> | --diff | --working-tree | --commit <sha> is required", 2);
      }
      if (modesDeclared > 1) {
        throw new SddScriptError("usage: pr-review worktree-setup \u2014 the five input modes are mutually exclusive", 2);
      }
      // The review target is whatever git repo contains the cwd the user
      // invoked us from \u2014 resolve BEFORE any other command (an ambient repo,
      // like the harness checkout itself, must never be mistaken for it).
      const startDir = process.cwd();
      if (!fs.existsSync(path.join(startDir, ".git")) && gitIf(["rev-parse", "--git-dir"], startDir) === "") {
        throw new Error(`not a git repository: ${startDir}`);
      }
      const repoRoot = gitSync(["rev-parse", "--show-toplevel"], startDir);
      let mode: ReviewChangesetMode;
      if (options.pr !== undefined) {
        if (!/^\d+$/.test(options.pr)) {
          throw new SddScriptError(`usage: pr-review worktree-setup \u2014 --pr requires a positive integer PR number, got ${JSON.stringify(options.pr)}`, 2);
        }
        mode = "pr";
      } else if (options.branch !== undefined) mode = "branch";
      else if (options.diff === true) mode = "diff";
      else if (options.workingTree === true) mode = "working-tree";
      else mode = "commit";

      // No-worktree modes: preflight the changeset BEFORE reporting success \u2014
      // pr-review.md § Worktree isolation Pre-flight applies in ALL modes, and
      // an empty changeset must stop before any lens fan-out. `--diff` has no
      // CLI-owned file contents to probe (the caller hands over a changeset),
      // so its emptiness is the caller's contract; working-tree is probeable.
      if (mode === "diff" || mode === "working-tree") {
        if (mode === "working-tree" && probeChangesetEmpty(["__working_tree__"], repoRoot, repoRoot)) {
          printChecklist("pr-review worktree-setup preflight", preflightChangeset(mode, { refsResolve: true, changesetEmpty: true }));
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ reviewBranch: null, worktreePath: repoRoot, base: null, mergeBase: null, diffCmd: mode === "diff" ? "(provided changeset)" : "git diff + git diff --cached + ls-files --others", diffFile: null }, null, 2));
        return;
      }

      // Resolve the real base first \u2014 never assume main.
      let prNumber = 0;
      let baseRef = "";
      let headSpec = "";
      if (mode === "pr") {
        prNumber = Number(options.pr);
        baseRef = execFileSync("gh", ["pr", "view", String(prNumber), "--json", "baseRefName", "--jq", ".baseRefName"], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        if (baseRef === "") throw new Error(`gh pr view returned an empty base ref for PR ${prNumber}`);
        headSpec = `pull/${prNumber}/head`;
      } else if (mode === "branch") {
        const branchName = options.branch!;
        // Real base first \u2014 git symbolic-ref origin/HEAD, then a remote-ls
        // probe, then origin/main only when it genuinely resolves.
        let originDefault = gitIf(["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot).replace("refs/remotes/origin/", "").trim();
        if (originDefault === "") {
          const remoteHeads = gitIf(["ls-remote", "--symref", "origin", "HEAD"], repoRoot);
          const symrefMatch = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(remoteHeads);
          originDefault = symrefMatch !== null ? symrefMatch[1]! : "";
        }
        if (originDefault === "" && refResolves("origin/main", repoRoot)) originDefault = "main";
        if (originDefault === "") {
          printChecklist("pr-review worktree-setup preflight", preflightChangeset(mode, { refsResolve: false, changesetEmpty: false }));
          process.exitCode = 1;
          return;
        }
        baseRef = originDefault;
        headSpec = branchName;
      } else {
        const commitSha = options.commit!;
        if (!refResolves(commitSha, repoRoot)) {
          printChecklist("pr-review worktree-setup preflight", preflightChangeset(mode, { refsResolve: false, changesetEmpty: true }));
          process.exitCode = 1;
          return;
        }
        let originDefault = gitIf(["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot).replace("refs/remotes/origin/", "").trim();
        if (originDefault !== "" && !refResolves(`origin/${originDefault}`, repoRoot)) originDefault = "";
        baseRef = originDefault !== "" ? `origin/${originDefault}` : `${commitSha}^`;
        headSpec = commitSha;
      }

      // Collision-free branch name BEFORE any fetch.
      const existing = listLocalBranches(repoRoot);
      // pr-<n> naming only applies to PR input; non-PR modes still want a
      // collision-free name \u2014 derive it from the head spec with the same
      // date-suffix loop semantics (n=0 never reaches the engine, which
      // requires a positive integer).
      const namePrNumber = prNumber >= 1 ? prNumber : 1;
      const baseCandidate =
        mode === "pr" ? namePrNumber
        : Number(String(Math.abs([...headSpec].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1_000_003, 7))));
      const reviewBranch = pickReviewBranchName(existing, baseCandidate === 0 ? 1 : baseCandidate, cliToday().replace(/-/g, ""));
      const branchSuffix = mode === "pr" ? "" : `-${headSpec.slice(0, 8)}`;
      const worktreePath = path.resolve(options.path ?? path.join(repoRoot, ".worktrees", `review-${reviewBranch}${branchSuffix}`));
      // Default review worktrees live under <repoRoot>/.worktrees/ per the
      // mstar-branch-worktree convention. The target repo may not gitignore
      // that directory — ensure it exists and, when the repo does not already
      // ignore it, add `.worktrees/` to .git/info/exclude (idempotent,
      // local-only; never touch a tracked .gitignore).
      if (options.path === undefined) {
        fs.mkdirSync(path.join(repoRoot, ".worktrees"), { recursive: true });
        if (gitIf(["check-ignore", ".worktrees/"], repoRoot) === "") {
          const excludePath = path.join(repoRoot, ".git", "info", "exclude");
          const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
          if (!existing.split("\n").some((line) => line.trim() === ".worktrees/")) {
            fs.appendFileSync(excludePath, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}.worktrees/\n`);
          }
        }
      }

      // Establish named refs with explicit refspecs FIRST (pr-review.md §
      // Worktree isolation: "+refs/heads/<base>:refs/remotes/origin/<base>
      // updates the remote-tracking ref even on narrowed fetch configs"),
      // THEN run the pre-flight re-probe before creating anything.
      const originUrl = gitIf(["remote", "get-url", "origin"], repoRoot);
      let fetched = true;
      try {
        if (originUrl !== "") {
          // ALWAYS refresh the base's remote-tracking ref explicitly \u2014
          // baseRef is usually a SHORT name (`gh pr view --json baseRefName`
          // → "main"), and the stale-or-missing case is exactly what the
          // explicit refspec exists to prevent.
          const baseShort = baseRef.replace(/^origin\//, "");
          gitSync(["fetch", "origin", `+refs/heads/${baseShort}:refs/remotes/origin/${baseShort}`], repoRoot);
          if (mode === "pr") {
            gitSync(["fetch", "origin", `+${headSpec}:${reviewBranch}`], repoRoot);
          } else if (mode === "branch") {
            gitSync(["fetch", "origin", `+refs/heads/${headSpec}:refs/remotes/origin/${headSpec}`], repoRoot);
          }
        }
      } catch {
        fetched = false; // resolution gate below reports it
      }

      // Ownership gates for the review artifacts: set only after THIS process
      // successfully wrote the file. Rollback must never unlink a pre-existing
      // file or directory at the deterministic artifact paths (empty-changeset
      // rollback, capture throw, EEXIST/EISDIR write failure) \u2014 the sidecar
      // only when THIS setup created it, the snapshot only when THIS setup
      // created it (inode-identified via the in-memory sidecar).
      let wroteSnapshot = false;
      let wroteSidecar = false;
      // The in-memory sidecar (with the snapshot's inode identity) once the
      // snapshot write succeeded \u2014 lets rollback verify ownership by inode.
      let pendingSidecar: ReviewWorktreeSidecar | undefined;
      // ONE fd held from exclusive creation through the final identity
      // rewrite: every sidecar write targets this verified inode, never the
      // pathname, so a concurrent replacement of the path cannot be
      // truncated. The fd IS the identity - rollback proves ownership by
      // fstat on it, never by a pathname read a replacement could spoof.
      // Closed by the final rewrite (success); a failure leaves it open for
      // removeOwnedFreshSidecarFile to close on every rollback path.
      let sidecarFd: number | undefined;

      /** Remove a just-created worktree + branch when setup fails late. */
      const cleanupOnFailure = (branchToDelete: string): void => {
        try {
          if (fs.existsSync(worktreePath)) gitSync(["worktree", "remove", "--force", worktreePath], repoRoot);
          gitSync(["worktree", "prune"], repoRoot);
          if (branchToDelete !== "" && !existing.has(branchToDelete)) {
            gitSync(["branch", "-D", branchToDelete], repoRoot);
          }
          // A FAILing setup must not leave the review artifacts it wrote
          // behind either (they live beside the worktree, outside it) \u2014 but
          // ONLY this process's artifacts: the sidecar only when THIS setup
          // created it (exclusive create \u2014 a pre-existing sidecar is foreign
          // and stays), the snapshot only when THIS setup wrote it (inode
          // verified). Anything pre-existing at the paths is unowned and
          // stays untouched (never recursive).
          if (wroteSidecar && sidecarFd !== undefined) {
            // Verified detach-unlink through the held fd - the accepted
            // removeOwnedSnapshotFile doctrine, second application: identity
            // is proven by fstat on the fd (never by a pathname read), the
            // verified inode's only name is detached to an unguessable tmp,
            // and a replacement swapped in between is restored without ever
            // overwriting. The helper closes the fd on every rollback path.
            removeOwnedFreshSidecarFile(sidecarFd, worktreePath);
            sidecarFd = undefined;
          }
          if (wroteSnapshot && pendingSidecar !== undefined) removeOwnedSnapshotFile(worktreePath, pendingSidecar);
        } catch {
          // rollback best-effort; the preflight FAIL below still exits non-zero
        }
      };

      const fetchedHeadResolves =
        mode === "pr" ? refResolves(reviewBranch, repoRoot)
        : mode === "branch" ? originUrl !== "" && refResolves(`origin/${options.branch}`, repoRoot)
        : mode === "commit" ? Boolean(gitIf(["rev-parse", "--verify", "--quiet", `${headSpec}^{commit}`], repoRoot).trim())
        : refResolves(headSpec, repoRoot);
      const gate = preflightChangeset(mode, { refsResolve: fetchedHeadResolves && fetched, changesetEmpty: probeChangesetEmptyPreworktree(mode, headSpec, repoRoot) });
      if (!gate.ok) {
        printChecklist("pr-review worktree-setup preflight", gate);
        process.exitCode = 1;
        return;
      }

      if (mode === "pr") {
        gitSync(["worktree", "add", worktreePath, reviewBranch], repoRoot);
      } else if (mode === "branch") {
        gitSync(["worktree", "add", "--detach", worktreePath, `origin/${options.branch}`], repoRoot);
      } else {
        gitSync(["worktree", "add", "--detach", worktreePath, headSpec], repoRoot);
      }

      // Diff basis computed INSIDE the worktree against recorded refs.
      let mergeBase = "";
      let diffArgs: string[];
      if (mode === "pr") {
        mergeBase = gitSync(["merge-base", `origin/${baseRef}`, reviewBranch], worktreePath);
        diffArgs = ["diff", `origin/${baseRef}...${reviewBranch}`];
      } else if (mode === "branch") {
        mergeBase = gitSync(["merge-base", `origin/${baseRef}`, `origin/${options.branch}`], worktreePath);
        diffArgs = ["diff", `origin/${baseRef}...origin/${options.branch}`];
      } else {
        mergeBase = gitIf(["merge-base", baseRef, headSpec], worktreePath);
        diffArgs = ["show", headSpec];
      }
      const diffCmd = `git ${diffArgs.join(" ")}`;

      const changesetEmpty = probeChangesetEmpty(diffArgs, worktreePath, worktreePath);
      const emptyGate = preflightChangeset(mode, { refsResolve: true, changesetEmpty });
      if (changesetEmpty) {
        // Discovered only AFTER the worktree exists \u2014 roll it back so a FAIL
        // never leaves an orphaned worktree + freshly created branch behind.
        cleanupOnFailure(mode === "pr" ? reviewBranch : "");
      }
      if (!emptyGate.ok && emptyGate.violations.some((v) => v.code === "prreview.preflight.changeset-empty")) {
        printChecklist("pr-review worktree-setup preflight", emptyGate);
        process.exitCode = 1;
        return;
      }

      // Diff snapshot: review artifact beside the sidecar (never inside the
      // worktree). Mirrors SDD reviewPackage section layout AND its capture
      // mechanics (Buffer parts + 64 MiB maxBuffer); commit mode has no
      // range, so its Commits section is the single commit line.
      const captureAndRecordSnapshot = (): ReviewWorktreeSidecar => {
        const diffFile = prReviewArtifactPathFor(worktreePath, "diff");
        const sidecarPath = prReviewArtifactPathFor(worktreePath, "json");
        const snapshotParts: Buffer[] = [];
        if (mode === "commit") {
          snapshotParts.push(
            Buffer.from(`# Review package: ${baseRef} (single commit)\n\n## Commits\n`),
            gitRaw(["log", "--oneline", "-1", headSpec], worktreePath),
            Buffer.from("\n## Files changed\n"),
            gitRaw(["show", "--stat", headSpec], worktreePath),
            Buffer.from("\n## Diff\n"),
            gitRaw(["show", "-U10", headSpec], worktreePath),
          );
        } else {
          const range = diffArgs[1]!;
          const [rangeBase, rangeHead] = range.split("...");
          snapshotParts.push(
            Buffer.from(`# Review package: ${baseRef}..${headSpec}\n\n## Commits\n`),
            gitRaw(["log", "--oneline", `${rangeBase}..${rangeHead}`], worktreePath),
            Buffer.from("\n## Files changed\n"),
            gitRaw(["diff", "--stat", range], worktreePath),
            Buffer.from("\n## Diff\n"),
            gitRaw(["diff", "-U10", range], worktreePath),
          );
        }
        const snapshot = Buffer.concat(snapshotParts);
        const recordedBase =
          mode === "pr" || (mode !== "commit" && !baseRef.startsWith("origin/")) ? `origin/${baseRef}` : baseRef;
        const sidecar: ReviewWorktreeSidecar = {
          reviewBranch: mode === "pr" ? reviewBranch : "",
          worktreePath,
          base: recordedBase,
          mergeBase,
          diffCmd,
          reportSaved: false,
          createdAt: new Date().toISOString(),
          repoRoot,
          diffFile,
          diffFileSha256: createHash("sha256").update(snapshot).digest("hex"),
        };
        // Sidecar FIRST, exclusive create through ONE held fd ("wx+" =
        // O_CREAT|O_EXCL|O_RDWR). Ownership of the deterministic artifact
        // paths is established by creation order, never by content sniffing:
        // a pre-existing sidecar is by definition foreign (an earlier review
        // never cleaned) — refuse and point at the documented cleanup path;
        // never clean a foreign review. On EEXIST / EISDIR this throws with
        // wroteSidecar still false, so rollback leaves the occupant
        // byte-untouched. The fd stays open through setup — every later
        // sidecar write (the initial JSON here, the identity rewrite after
        // the snapshot) targets this verified inode, never the pathname.
        try {
          sidecarFd = fs.openSync(sidecarPath, "wx+");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EISDIR") throw error;
          throw new Error(`cannot record setup sidecar at ${sidecarPath} - run mstar pr-review worktree-cleanup first (never cleaning a foreign review)`);
        }
        // No recorded identity snapshot needed: the held fd IS the identity
        // (rollback verifies through it, see removeOwnedFreshSidecarFile).
        writeFdSync(sidecarFd, Buffer.from(JSON.stringify(sidecar, null, 2), "utf8"));
        wroteSidecar = true; // the sidecar at sidecarPath is now owned by this process
        // Snapshot SECOND, exclusive create. Our own sidecar was JUST created
        // above, so any occupant at the snapshot path is by definition not
        // ours — refuse and leave it byte-untouched (never truncate, never
        // unlink, never shape-sniff).
        try {
          fs.writeFileSync(diffFile, snapshot, { flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EISDIR") throw error;
          throw new Error(`refusing to overwrite pre-existing non-snapshot path ${diffFile}`);
        }
        wroteSnapshot = true; // the file at diffFile is now owned by this process
        // Record the snapshot's identity on the in-memory sidecar, then
        // rewrite the sidecar through the SAME held fd (ftruncate + full
        // write, positional from offset 0) — no pathname write anywhere after
        // creation, so a concurrent replacement of the path cannot be
        // truncated. Cleanup proves ownership by identity, never by content:
        // identical bytes on a new inode are a replacement, not our snapshot.
        // The mtime closes the ext4 inode-reuse hole — a replacement can
        // inherit dev+ino, never the mtime of the file this setup wrote.
        const snapshotStat = fs.lstatSync(diffFile);
        sidecar.diffFileDev = snapshotStat.dev;
        sidecar.diffFileIno = String(snapshotStat.ino);
        sidecar.diffFileMtimeMs = snapshotStat.mtimeMs;
        pendingSidecar = sidecar;
        // Close here; a failure before this close leaves the fd to rollback,
        // which closes it before the verified unlink.
        fs.ftruncateSync(sidecarFd, 0);
        writeFdSync(sidecarFd, Buffer.from(JSON.stringify(sidecar, null, 2), "utf8"));
        fs.closeSync(sidecarFd);
        sidecarFd = undefined;
        return sidecar;
      };
      // Snapshot capture, write, and the sidecar write are the last failure
      // points after the worktree exists — a FAIL here must roll the new
      // worktree back (never an orphaned worktree + no sidecar), then fail.
      let sidecar: ReviewWorktreeSidecar;
      try {
        sidecar = captureAndRecordSnapshot();
      } catch (error) {
        cleanupOnFailure(mode === "pr" ? reviewBranch : "");
        throw error;
      }
      console.log(JSON.stringify({
        reviewBranch: sidecar.reviewBranch === "" ? null : sidecar.reviewBranch,
        worktreePath: sidecar.worktreePath,
        base: sidecar.base,
        mergeBase: sidecar.mergeBase === "" ? null : sidecar.mergeBase,
        diffCmd: sidecar.diffCmd,
        diffFile: sidecar.diffFile,
      }, null, 2));
    } catch (error) {
      failScript(error, "pr-review worktree-setup");
    }
  });

/** Review artifact path beside the worktree: <parent-of-worktree>/.<worktree-dirname>.prreview.<suffix> */
function prReviewArtifactPathFor(worktreePath: string, suffix: "json" | "diff"): string {
  const parent = path.dirname(path.resolve(worktreePath));
  const name = path.basename(path.resolve(worktreePath));
  return path.join(parent, `.${name}.prreview.${suffix}`);
}

/**
 * Write a whole buffer through an fd as ONE file image: looped `writeSync`,
 * positional from offset 0 (writeSync may write partially; the explicit
 * position keeps the file offset irrelevant, so an ftruncate-then-rewrite
 * never leaves a hole from a stale offset).
 */
function writeFdSync(fd: number, buf: Buffer): void {
  let written = 0;
  while (written < buf.length) written += fs.writeSync(fd, buf, written, buf.length - written, written);
}

/**
 * Remove the diff snapshot at the computed artifact path ONLY when it is
 * provably this flow's snapshot: a regular file whose identity equals the
 * sidecar's recorded `diffFileDev` / `diffFileIno` / `diffFileMtimeMs`.
 * Identical bytes are not identity \u2014 a replacement file with the same
 * contents (new inode) is unowned. A replacement file, a sidecar without
 * recorded identity, and any non-regular entry at the deterministic path are
 * left in place (with a note); missing is a no-op. Never recursive; always
 * the computed path (never `sidecar.diffFile`).
 *
 * The check and the deletion are bound to ONE filesystem object via an open
 * fd: `lstat(path)` then `unlink(path)` is a TOCTOU pair (the path can be
 * swapped between the two calls), and a dev+ino match alone is unsound on
 * filesystems that reuse inode numbers (ext4) \u2014 a replacement can
 * inherit the recorded dev+ino. The mtime check closes that hole (a
 * replacement is written at a different time), and the post-rename fd check
 * proves the rename detached the inode we verified: the inode now at tmp
 * must BE the inode we opened, so unlinking tmp removes exactly our
 * snapshot \u2014 a replacement swapped in between open and rename is
 * restored via hard link (never overwriting a concurrent occupant of the
 * path; EEXIST leaves both files in place, nothing deleted).
 *
 * The tmp name is unguessable (`<snapshot>.cleanup.<pid>.<randomUUID>`), so
 * a pre-swapped entry at a predictable name can no longer be targeted, and
 * the unlink itself is bound to the verified inode twice: immediately
 * before it, the fd must still hold exactly its tmp link (fstat `nlink ===
 * 1`) AND `lstat(tmp)` must show the same `ino`/`dev` with `nlink === 1`;
 * immediately after it, `fstat(fd).nlink === 0` must hold \u2014 proof the
 * unlink detached OUR inode. A post-unlink nlink > 0 means a pathname
 * replacement was detached instead (best-effort detection \u2014 POSIX/Node
 * has no fd-bound unlink; the window is a microsecond-scale lstat\u2192unlink
 * gap on an unguessable name): a loud yellow error names both paths.
 */
function removeOwnedSnapshotFile(worktreePath: string, sidecar: ReviewWorktreeSidecar): void {
  const snapshotPath = prReviewArtifactPathFor(worktreePath, "diff");
  let fd: number;
  try {
    fd = fs.openSync(snapshotPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // missing \u2192 no-op
    console.error(pc.yellow(`worktree-cleanup: snapshot at ${snapshotPath} left in place (cannot open: ${(error as Error).message})`));
    return;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return; // non-regular \u2192 unowned, leave in place
    const recordedIno = sidecar.diffFileIno;
    const recordedDev = sidecar.diffFileDev;
    const recordedMtimeMs = sidecar.diffFileMtimeMs;
    const owned = typeof recordedIno === "string" && recordedIno !== ""
      && typeof recordedDev === "number" && Number.isFinite(recordedDev)
      && typeof recordedMtimeMs === "number" && Number.isFinite(recordedMtimeMs)
      && String(st.ino) === recordedIno && st.dev === recordedDev
      && st.mtimeMs === recordedMtimeMs;
    if (!owned) {
      // Replacement file (new inode \u2014 even with a reused inode number,
      // the mtime differs), or a sidecar without recorded identity:
      // ownership cannot be proven \u2014 leave the path in place, never
      // unlink by content (identical bytes are not identity).
      console.error(pc.yellow(`worktree-cleanup: snapshot at ${snapshotPath} left in place (file identity does not match the recorded snapshot)`));
      return;
    }
    if (st.nlink !== 1) {
      // 0 = our inode was already unlinked (the path holds a replacement);
      // >1 = unexpected hardlink. Either way ownership is not provable.
      console.error(pc.yellow(`worktree-cleanup: snapshot at ${snapshotPath} left in place (link count does not match the recorded snapshot)`));
      return;
    }
    // The verified inode's only link is the path we created it at. Detach it
    // to an UNGUESSABLE sibling name (pid + randomUUID \u2014 a pre-swapped
    // entry at a predictable name can no longer be targeted), then re-check
    // the fd: the inode now at tmp must BE the inode we opened \u2014 only
    // then is unlinking tmp removing exactly our snapshot. Anything else at
    // tmp is a replacement swapped in between open and rename \u2014 restore
    // it byte-identical, never delete.
    const tmp = `${snapshotPath}.cleanup.${process.pid}.${randomUUID()}`;
    try {
      fs.renameSync(snapshotPath, tmp);
    } catch (error) {
      console.error(pc.yellow(`worktree-cleanup: snapshot at ${snapshotPath} left in place (cannot detach: ${(error as Error).message})`));
      return;
    }
    const st2 = fs.fstatSync(fd);
    let tmpStat: fs.Stats | undefined;
    try {
      tmpStat = fs.lstatSync(tmp);
    } catch {
      tmpStat = undefined;
    }
    // Pre-unlink binding: the inode at tmp must BE the inode we opened AND
    // still hold exactly its tmp link (fstat nlink === 1 AND lstat tmp
    // nlink === 1) \u2014 only then does unlinking tmp remove exactly our
    // snapshot. Any mismatch (a replacement swapped in between open and
    // rename, or a hardlink added) takes the restore branch below.
    if (tmpStat !== undefined && tmpStat.ino === st2.ino && tmpStat.dev === st2.dev && st2.nlink === 1 && tmpStat.nlink === 1) {
      // Portable ceiling: Node has no fd-bound unlink, so the unlink below is
      // pathname-based. The unguessable tmp name + the pre-unlink nlink/inode
      // checks above + the post-unlink nlink === 0 verification below
      // minimize the lstat\u2192unlink window to microseconds.
      fs.unlinkSync(tmp);
      // Post-unlink verification: the unlink must have detached OUR verified
      // inode (nlink 1 \u2192 0). If the fd still has a link, the unlink
      // detached a pathname replacement \u2014 detection is best-effort
      // (POSIX/Node has no fd-bound unlink); name both paths loudly.
      const st3 = fs.fstatSync(fd);
      if (st3.nlink !== 0) {
        console.error(pc.yellow(`worktree-cleanup: unlink at ${tmp} detached a pathname replacement, not the verified snapshot inode (${snapshotPath} still holds ${st3.nlink} link(s)) - the replacement is gone, the verified snapshot was NOT deleted`));
      }
    } else {
      // The inode at tmp is NOT the one we opened — a replacement was
      // swapped in between open and rename. Restore it to the snapshot
      // path WITHOUT overwriting: link() fails with EEXIST if a concurrent
      // creator took the path (POSIX rename would silently replace it).
      // Only tmp (our own unique name) is ever unlinked, and only after
      // link() proved it now shares the inode with the path.
      try {
        fs.linkSync(tmp, snapshotPath); // EEXIST if a concurrent creator took the path — never overwrites
        fs.unlinkSync(tmp); // inode is back at the snapshot path; drop the tmp name
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          console.error(pc.yellow(`worktree-cleanup: snapshot replacement left at ${tmp} (snapshot path was recreated concurrently)`));
          // tmp keeps the earlier replacement; path keeps the concurrent file. Nothing deleted.
        } else {
          console.error(pc.yellow(`worktree-cleanup: snapshot replacement left at ${tmp} (restore failed: ${(error as Error).message})`));
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Remove the fresh setup sidecar through the held file descriptor - the
 * accepted `removeOwnedSnapshotFile` doctrine applied to the setup-rollback
 * ownership proof. `fd` stays open from exclusive creation, so identity is
 * proven by fstat on the fd, never by a pathname read a concurrent
 * replacement could spoof. When the inode still holds exactly one link (the
 * sidecar path), its only name is detached to an UNGUESSABLE sibling (pid +
 * randomUUID - a pre-swapped entry at a predictable name can no longer be
 * targeted), re-verified through the fd, and only then unlinked. A
 * replacement that swapped the path between rename and verify is restored
 * byte-identical via link (never overwriting) or left under the tmp name.
 * Closes the fd on every path.
 */
function removeOwnedFreshSidecarFile(sidecarFd: number, worktreePath: string): void {
  const sidecarPath = prReviewArtifactPathFor(worktreePath, "json");
  try {
    const st = fs.fstatSync(sidecarFd);
    if (!st.isFile() || st.nlink !== 1) {
      // nlink 0 = our inode is already detached (the path holds a
      // replacement); >1 = unexpected hardlink. Either way the path occupant
      // is not exclusively ours - never touch it.
      console.error(pc.yellow(`worktree-setup rollback: sidecar at ${sidecarPath} left in place (identity no longer held)`));
      return;
    }
    // The verified inode's only link is the sidecar path this setup created
    // it at. Detach it to an unguessable sibling name, then re-check the fd:
    // the inode now at tmp must BE the inode we opened - only then is
    // unlinking tmp removing exactly our sidecar. Anything else at tmp is a
    // replacement swapped in between creation and rename - restore it
    // byte-identical, never delete.
    const tmp = `${sidecarPath}.cleanup.${process.pid}.${randomUUID()}`;
    try {
      fs.renameSync(sidecarPath, tmp);
    } catch (error) {
      console.error(pc.yellow(`worktree-setup rollback: sidecar at ${sidecarPath} left in place (cannot detach: ${(error as Error).message})`));
      return;
    }
    const st2 = fs.fstatSync(sidecarFd);
    let tmpStat: fs.Stats | undefined;
    try {
      tmpStat = fs.lstatSync(tmp);
    } catch {
      tmpStat = undefined; // ENOENT -> nothing at tmp
    }
    // Pre-unlink binding: the inode at tmp must BE the inode this setup
    // created (fstat on the held fd) - only then does unlinking tmp remove
    // exactly our sidecar. Any mismatch (a replacement swapped in before the
    // rename) takes the restore branch below.
    if (tmpStat !== undefined && tmpStat.ino === st2.ino && tmpStat.dev === st2.dev) {
      // Portable ceiling: Node has no fd-bound unlink, so the unlink below is
      // pathname-based. The unguessable tmp name + the pre-unlink fd/lstat
      // identity check above + the post-unlink nlink === 0 verification below
      // minimize the lstat->unlink window to microseconds.
      fs.unlinkSync(tmp);
      // Post-unlink verification: the unlink must have detached OUR verified
      // inode (nlink 1 -> 0). If the fd still has a link, the unlink detached
      // a pathname replacement - detection is best-effort (POSIX/Node has no
      // fd-bound unlink); name both paths loudly.
      const st3 = fs.fstatSync(sidecarFd);
      if (st3.nlink !== 0) {
        console.error(pc.yellow(`worktree-setup rollback: unlink at ${tmp} detached a pathname replacement, not the verified sidecar inode (${sidecarPath} still holds ${st3.nlink} link(s)) - the replacement is gone, the verified sidecar was NOT deleted`));
      }
    } else {
      // The inode at tmp is NOT the one this setup created - a replacement
      // was swapped in between the fd's creation and the rename. Restore it
      // to the sidecar path WITHOUT overwriting: link() fails with EEXIST if
      // a concurrent creator took the path (POSIX rename would silently
      // replace it). Only tmp (our own unique name) is ever unlinked, and
      // only after link() proved it now shares the inode with the path.
      try {
        fs.linkSync(tmp, sidecarPath); // EEXIST if a concurrent creator took the path - never overwrites
        fs.unlinkSync(tmp); // inode is back at the sidecar path; drop the tmp name
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          console.error(pc.yellow(`worktree-setup rollback: sidecar replacement left at ${tmp} (sidecar path was recreated concurrently)`));
          // tmp keeps the earlier replacement; path keeps the concurrent file. Nothing deleted.
        } else {
          console.error(pc.yellow(`worktree-setup rollback: sidecar replacement left at ${tmp} (restore failed: ${(error as Error).message})`));
        }
      }
    }
  } finally {
    try {
      fs.closeSync(sidecarFd);
    } catch { /* already closed - rollback is best-effort */ }
  }
}

prReviewCommand
  .command("worktree-cleanup")
  .description(
    "Remove the review worktree per pr-review.md \u00a7 Worktree isolation cleanup: refuses unless --report-saved is given OR the " +
      "setup sidecar records report-saved; removes the worktree, prunes, and deletes EXACTLY the recorded review branch \u2014 a " +
      "--branch argument that disagrees with the sidecar is refused (never delete a foreign/pre-existing branch)",
  )
  .requiredOption("--path <dir>", "Worktree directory created by worktree-setup")
  .requiredOption("--branch <name>", "The recorded review branch (must match the setup sidecar for PR mode)")
  .option("--report-saved", "Assert the local report has been saved before removal")
  .action((options: { path: string; branch: string; reportSaved?: boolean }) => {
    try {
      const worktreePath = path.resolve(resolveCliPath(options.path));
      const sidecarPath = prReviewArtifactPathFor(worktreePath, "json");
      if (!fs.existsSync(sidecarPath)) {
        throw new Error(`no setup sidecar found at ${sidecarPath} - run pr-review worktree-setup first (foreign worktrees are never cleaned here)`);
      }
      let sidecar: ReviewWorktreeSidecar;
      try {
        sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as ReviewWorktreeSidecar;
      } catch (error) {
        throw new Error(`setup sidecar at ${sidecarPath} is not valid JSON: ${(error as Error).message}`);
      }
      // All git below runs from the REPO ROOT recorded at setup \u2014 never the
      // worktree being removed, never the user's cwd (which may even be
      // deleted after a successful remove). Legacy sidecars without the field
      // fall back to the worktree's parent directory.
      const gitRoot = typeof sidecar.repoRoot === "string" && sidecar.repoRoot !== ""
        ? sidecar.repoRoot
        : path.dirname(worktreePath);
      if (sidecar.reviewBranch === "") {
        // Detached review worktree (branch / commit mode): nothing to delete,
        // and any claimed --branch is by definition foreign.
        if (options.branch !== "") {
          throw new Error(
            `this setup recorded no review branch (detached review) - refusing ${JSON.stringify(options.branch)} as a foreign branch`,
          );
        }
      } else if (options.branch !== sidecar.reviewBranch) {
        throw new Error(
          `--branch ${JSON.stringify(options.branch)} does not match the recorded review branch ${JSON.stringify(sidecar.reviewBranch)} - refusing to delete a foreign branch`,
        );
      }
      const savedOk = options.reportSaved === true || sidecar.reportSaved === true;
      if (!savedOk) {
        throw new Error("refusing cleanup: the local report is not saved yet - save it first or pass --report-saved (\u00a7 Local report archive)");
      }
      if (fs.existsSync(worktreePath)) {
        gitSync(["worktree", "remove", worktreePath], gitRoot);
      }
      gitSync(["worktree", "prune"], gitRoot);
      if (sidecar.reviewBranch !== "") {
        if (!refResolves(`refs/heads/${sidecar.reviewBranch}`, gitRoot)) {
          throw new Error(`recorded review branch ${sidecar.reviewBranch} no longer resolves - refusing ambiguous cleanup`);
        }
        gitSync(["branch", "-D", sidecar.reviewBranch], gitRoot);
      }
      // The diff snapshot is a review artifact beside the sidecar \u2014 remove it
      // BEFORE the sidecar (a snapshot-rm failure must not strand an orphan a
      // retry can't reach: once the sidecar is gone, cleanup refuses). Use the
      // SAME computed path the rollback uses \u2014 immune to doctored sidecar
      // fields and symlink-spelled paths (macOS /tmp vs /private/tmp). Only a
      // regular file at that path is a snapshot this flow wrote; directories /
      // symlinks / other entries are unowned and left in place (never recursive).
      removeOwnedSnapshotFile(worktreePath, sidecar);
      fs.rmSync(sidecarPath, { force: true });
      console.log(pc.green(`worktree-cleanup: removed ${worktreePath}${sidecar.reviewBranch !== "" ? ` + deleted ${sidecar.reviewBranch}` : " (no local branch to delete)"}`));
    } catch (error) {
      failScript(error, "pr-review worktree-cleanup");
    }
  });

/** Count changed lines for `size`: added + deleted taken straight from a
 * `git diff --numstat` run (exact counts \u2014 handles lines whose CONTENT
 * starts with +/- markers and empty added lines; binary rows skipped). */
function countChangedLines(numstatOutput: string): number {
  let changed = 0;
  for (const line of numstatOutput.split(/\r?\n/)) {
    const entry = /^(\d+)\t(\d+)\t/.exec(line);
    if (entry === null) continue;
    changed += Number(entry[1]!) + Number(entry[2]!);
  }
  return changed;
}

prReviewCommand
  .command("size")
  .description(
    "Classify a changeset into the sizing bands (~100 / ~300 / ~1000 \u2014 single set of numbers) and derive the kept-wave Stage-1 seat plan " +
      "(collect seats apply only when the deep collect wave is kept \u2014 the default fold dispatches none; pr-review.md \u00a7 Review pipeline), " +
      "split advice and file-size watch, plus the SP-A inferred tier; prints band + seats + adviseSplit (+ tier)",
  )
  .requiredOption("--base <ref>", "Base ref (three-dot diff side A)")
  .requiredOption("--head <ref>", "Head ref (three-dot diff side B)")
  .option("--largest-file-total <n>", "Override the largest touched file's TOTAL line count (default: measured at the --head ref)")
  .action((options: { base: string; head: string; largestFileTotal?: string }) => {
    try {
      const repoRoot = gitSync(["rev-parse", "--show-toplevel"], process.cwd());
      const diffOutput = gitSync(["diff", `${options.base}...${options.head}`], repoRoot);
      const changedLines = countChangedLines(gitSync(["diff", "--numstat", `${options.base}...${options.head}`], repoRoot));
      let largestTouchedFileTotal: number | undefined;
      if (options.largestFileTotal !== undefined) {
        if (!/^\d+$/.test(options.largestFileTotal)) {
          throw new SddScriptError(`usage: pr-review size \u2014 --largest-file-total requires a non-negative integer, got ${JSON.stringify(options.largestFileTotal)}`, 2);
        }
        largestTouchedFileTotal = Number(options.largestFileTotal);
      } else {
        largestTouchedFileTotal = measureLargestTouchedTotal(diffOutput, options.head, repoRoot);
      }
      const sizing = prReviewSizing({ changedLines, ...(largestTouchedFileTotal !== undefined ? { largestTouchedFileTotal } : {}) });
      const tier = resolvePrReviewTier({ band: sizing.band });
      console.log(JSON.stringify({ ...sizing, tier, changedLines }, null, 2));
    } catch (error) {
      failScript(error, "pr-review size");
    }
  });

/** Measure the largest diff-touched file's TOTAL lines, read from the
 * `--head` ref's tree (`git show <headRef>:<file>`) so the file-size watch
 * always reflects the reviewed tip \u2014 never the checkout HEAD. */
function measureLargestTouchedTotal(diffOutput: string, headRef: string, cwd: string): number | undefined {
  const files = [...new Set([...diffOutput.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!))];
  let maxTotal: number | undefined;
  for (const file of files) {
    const content = gitIf(["show", `${headRef}:${file}`], cwd);
    const total = content === "" ? 0 : content.split("\n").length;
    if (maxTotal === undefined || total > maxTotal) maxTotal = total;
  }
  return maxTotal;
}

prReviewCommand
  .command("seat-prompt")
  .description(
    "Generate the read-only audit-seat prompt per pr-review.md \u00a7 Seat prompts (Hard Rules 4/5 verbatim, payload-return contract, " +
      "no-verdict/no-post clauses, slug <domain>-<seat>, Merge-class instruction on stage 2); prints the prompt",
  )
  .requiredOption("--stage <1|2>", "Pipeline stage (1 = collect, 2 = domain/security)")
  .requiredOption("--domain <d>", "Review domain for this seat")
  .requiredOption("--seat <id>", "Seat id (slug becomes <domain>-<seat>)")
  .requiredOption("--worktree <path>", "Absolute review worktree path")
  .option("--security", "Mark this seat as the security-lens seat (stage 2)")
  .option("--skill-root <dir>", "Skill root containing references/pr-review.md (default: resolved skills/mstar-audit)")
  .option("--recon <facts...>", "Recon facts (variadic: --recon fact1 fact2 ...)")
  .option("--tier <quick|default|deep>", "Prompt tier (SP-A): quick shrinks read-first + folds the security lens in-seat; deep adds cross-domain security seat + stage-as-wave (default: default)")
  .option("--diff-file <path>", "Absolute path to the pinned diff snapshot written by worktree-setup (read-first ingredient)")
  .option("--collect-folded", "Fold the collect wave onto this stage-2 domain seat: the prompt gains a self-collection bullet after the budget block (requires --diff-file; refused on stage 1 and security seats)")
  .action((options: { stage: string; domain: string; seat: string; worktree: string; security?: boolean; skillRoot?: string; recon?: string[]; tier?: string; diffFile?: string; collectFolded?: boolean }) => {
    try {
      if (options.stage !== "1" && options.stage !== "2") {
        throw new SddScriptError(`usage: pr-review seat-prompt \u2014 --stage must be 1 or 2, got ${JSON.stringify(options.stage)}`, 2);
      }
      const tier = options.tier;
      if (tier !== undefined && tier !== "quick" && tier !== "default" && tier !== "deep") {
        throw new SddScriptError(`usage: pr-review seat-prompt \u2014 --tier must be quick | default | deep, got ${JSON.stringify(tier)}`, 2);
      }
      const auditSkillRoot = options.skillRoot !== undefined
        ? path.resolve(resolveCliPath(options.skillRoot))
        : path.resolve(resolveCliPath("skills/mstar-audit"));
      const prompt = prReviewSeatPrompt({
        stage: options.stage === "1" ? 1 : 2,
        domain: options.domain,
        seat: options.seat,
        skillRoot: auditSkillRoot,
        worktreePath: path.resolve(options.worktree),
        reconFacts: options.recon ?? [],
        ...(options.security === true ? { securitySeat: true } : {}),
        ...(tier !== undefined ? { tier } : {}),
        ...(options.diffFile !== undefined && options.diffFile !== "" ? { diffFile: path.resolve(resolveCliPath(options.diffFile)) } : {}),
        ...(options.collectFolded === true ? { collectFolded: true } : {}),
      });
      console.log(prompt);
    } catch (error) {
      failScript(error, "pr-review seat-prompt");
    }
  });

prReviewCommand
  .command("budget")
  .description(
    "Print the per-tier time-budget table (wall-clock target + per-seat caps) from PR_REVIEW_TIER_BUDGETS \u2014 " +
      "for humans and drift checks (pr-review.md \u00a7 Review depth Budget column)",
  )
  .action(() => {
    for (const [tier, budget] of Object.entries(PR_REVIEW_TIER_BUDGETS)) {
      console.log(
        `${tier}: <=${budget.wallClockMinutes}min wall-clock, max ${budget.maxSeats} review seats, ` +
          `<=${budget.perSeatFindingsCap} findings/seat, ~${budget.evidenceTokensCap} tokens evidence/seat, ` +
          `<=${budget.fileOpenCap} file opens/seat (baseline 100 tok/s)`,
      );
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(pc.red(`Setup failed: ${(error as Error).message}`));
  process.exitCode = 1;
});
