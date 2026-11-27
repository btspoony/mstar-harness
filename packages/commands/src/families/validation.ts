import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { AdrLintFailure } from "@mstar-harness/engine";
import {
  assertDefaultBranchProtected,
  assertKnowledgeCatalogCompleteness,
  assertLightDarkParity,
  assertQcAlignment,
  assertSddTddTriple,
  assertTriIdentity,
  ADR_BUCKETS,
  ADR_CLASSES,
  catalogRootDir,
  classifySkillLint,
  activeLifecyclePlanId,
  completenessLevel,
  declaredAssignmentBranches,
  DocumentFrontmatterError,
  executionModeToN,
  extractFrontmatterAndBody,
  parseDocumentFrontmatterEntries,
  validateIntegrationMergeLease,
  workflowEntryPreDispatchCheck,
  findSimplifyMarkers,
  findTemporaryMarkers,
  findCommentedCode,
  findCommentPointers,
  findUnclassifiedComments,
  findUntrackedTodos,
  sourceDialect,
  findEphemeralCitations,
  findProvenanceCitations,
  isReadOnlyAssignmentRole,
  assertControlClean,
  CODE_FILE_EXTENSIONS,
  hasHarnessRoot,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  legacyAssignmentShape,
  legacyFormatViolation,
  readMainWorktree,
  probeCheckoutRoot,
  resolveHarnessDir,
  lintAdrTree,
  lintIterationCompass,
  lintFiveQuestion,
  lintFrontmatter,
  lintLoadOrder,
  collectLegacyArchiveReferenceTexts,
  mergeLegacyArchiveReferences,
  lintSpecsDoc,
  lintSpecsTree,
  lintStrategySections,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseBranchPolicyDirectOnBranch,
  planQualityBar,
  scopeGuard,
  SddScriptError,
  stripFrontmatter,
  readAssignmentSource,
  validateAssignmentFields,
  validateControlWriteAssignment,
  validateDesignTokenFrontmatter,
  validateDocumentFrontmatter,
  validateFindingDoc,
  validateQcReport,
  validateRoleMapping,
  validateSchemaYaml,
  type AssignmentSourceResult,
  type GateResult,
  type ActiveLifecycleBranch,
  type QcAlignmentAssignment,
  resolveProcessHarnessDir,
  type ExecutionState,
} from "@mstar-harness/engine";
import { refusalEnvelope } from "../envelope.js";
import { z } from "zod";
import { resolveCliPath } from "../host-health.js";
import { launchDirectoryRefusal, type LaunchDirectoryField } from "./launch-workspace.js";
import { commandEnvelopeSchema } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext, PayloadDescriptor } from "../types.js";

/** One contract for `worktree.check --tracks`: the typed input field drives publication and boundary validation, while the shared schema also serves the CLI's JSON decoding and the discovery descriptor. Error messages carry indexed `tracks[N].<field>` paths (the array index is the last numeric path segment, whether the schema runs wrapped in the input object or bare), so a refused request names the offending member. */
const trackPrefix = (path: readonly PropertyKey[]): string => {
  const index = path.filter((part) => typeof part === "number").at(-1);
  return typeof index === "number" ? `tracks[${index}]` : "tracks";
};
const tracksSchema = z.array(
  z.object(
    {
      worktreePath: z.string({ error: (issue) => `${trackPrefix(issue.path ?? [])}.worktreePath must be a string` }),
      workingBranch: z.string({ error: (issue) => `${trackPrefix(issue.path ?? [])}.workingBranch must be a string` }),
    },
    { error: (issue) => `${trackPrefix(issue.path ?? [])} must be an object with string worktreePath and workingBranch` },
  ),
  { error: () => "tracks must be an array of {worktreePath, workingBranch}" },
);

type Input = {
  assignmentFile?: string; branch?: string; planId?: string; plan?: string; workflow?: string; harness?: string; integration?: string;
  mainBranch?: string; control?: string; entry?: boolean; l2?: boolean; controlClean?: boolean; tracks?: { worktreePath: string; workingBranch: string }[]; files?: string[]; mode?: string; reviewers?: string[];
  target?: string; type?: string; prVariant?: boolean; diffBase?: string; dir?: string; docPath?: string; knowledgeDir?: string;
  skillDir?: string; rolesDir?: string; skillsDir?: string; reportFile?: string;
};
type Violation = GateResult["violations"][number];

const verbs = ["dispatch.validate", "worktree.check", "worktree.qc-alignment", "review.seats", "lint", "design-md.validate", "compound.validate", "skill.lint", "roles.validate", "qc.validate-report"] as const;
const schemas: Record<(typeof verbs)[number], z.ZodType<Input>> = {
  "dispatch.validate": z.object({ assignmentFile: z.string().optional(), branch: z.string().optional() }),
  "worktree.check": z.object({ planId: z.string().optional(), plan: z.string().optional(), workflow: z.string().optional(), harness: z.string().optional(), integration: z.string().optional(), mainBranch: z.string().optional(), control: z.string().optional(), entry: z.boolean().optional(), l2: z.boolean().optional(), controlClean: z.boolean().optional(), tracks: tracksSchema.optional() }),
  "worktree.qc-alignment": z.object({ files: z.array(z.string()).optional() }),
  "review.seats": z.object({ assignmentFile: z.string().optional(), mode: z.string().optional(), reviewers: z.array(z.string()).optional() }),
  lint: z.object({ target: z.string().optional(), type: z.string().optional(), prVariant: z.boolean().optional(), diffBase: z.string().optional() }),
  "design-md.validate": z.object({ dir: z.string().optional() }),
  "compound.validate": z.object({ docPath: z.string().optional(), knowledgeDir: z.string().optional() }),
  "skill.lint": z.object({ skillDir: z.string().optional() }),
  "roles.validate": z.object({ rolesDir: z.string().optional(), skillsDir: z.string().optional() }),
  "qc.validate-report": z.object({ reportFile: z.string().optional() }),
};
function ok(id: string, data: unknown): CommandEnvelope { return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data }; }
function refusal(id: string, code: string, message: string, details?: Record<string, unknown>, recovery?: string): CommandEnvelope<never> {
  return refusalEnvelope({ command: id, status: "refused", code, exitCode: 1, message, ...(details === undefined ? {} : { details }), recovery });
}
function failed(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SddScriptError && error.exitCode === 2) return refusalEnvelope({ command: id, status: "usage", code: "usage", exitCode: 2, message });
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.refused`;
  return refusalEnvelope({ command: id, status: "refused", code, exitCode: 1, message, recovery: "Read this command's contract with mstar schema --command <id>, then rerun the command after correcting the reported problem." });
}
function required(value: string | undefined, message: string): string { if (value === undefined || value.trim() === "") throw new SddScriptError(message, 2); return value; }
function rejected(id: string, result: GateResult, fallback: string): CommandEnvelope<never> {
  const first = result.violations[0];
  return refusal(id, first?.code ?? fallback, first?.message ?? fallback, { violations: result.violations }, "Correct each violation listed in the details as its fix directs, then rerun this command; read this command's contract with mstar schema --command <id>.");
}
function gateData(result: GateResult) { return { ok: result.ok, violations: result.violations }; }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function activeGraphLifecycleBranches(graph: ExecutionState): ActiveLifecycleBranch[] {
  const branches = new Map<string, ActiveLifecycleBranch>();
  for (const workflow of graph.workflows) {
    const workflowId = workflow.state.id;
    const integration = workflow.state.branch?.integration;
    if (typeof integration === "string" && integration.trim() !== "") branches.set(`${workflowId}\0`, { branch: integration, workflowId, planId: null });
    for (const view of workflow.plans) {
      const metadata = view.plan.metadata;
      if (!isPlainRecord(metadata)) continue;
      const planId = activeLifecyclePlanId(view.plan);
      const add = (branch: unknown) => {
        if (typeof branch === "string" && branch.trim() !== "") branches.set(`${workflowId}\0${planId ?? ""}\0${branch}`, { branch, workflowId, planId });
      };
      if (Array.isArray(metadata.track_branches)) for (const branch of metadata.track_branches) add(branch);
      add(metadata.working_branch);
    }
  }
  return [...branches.values()];
}
/**
 * The project root a path argument belongs to is discovered from the invocation
 * WORKSPACE (`cwd`), never from this process's own directory: on a shared MCP
 * connection the process directory is the HOST's launch checkout, so resolving
 * there read — and linted — a repository the caller never named. The CLI passes
 * the directory the operator ran from, so its `MSTAR_CLI_PROJECT_ROOT` /
 * walk-up behavior is unchanged.
 */
function absolute(cwd: string, input: string): string { return resolveCliPath(input, cwd); }
/** Physical path when the target exists, lexical `resolve` otherwise — a caller may name a directory that is not created yet, and a symlinked or `./`-spelled equal path must compare equal. */
function canonicalPath(target: string): string {
  try { return realpathSync(target); } catch { return path.resolve(target); }
}

/** One input this family reads as a path, declared once for the whole family. */
type PathInput = Readonly<{
  field: keyof Input;
  /** What the field names, for the refusal cause and the diagnostic. */
  subject: string;
  /** Omission is derived from another NAMED input, so only a relative value is refused. */
  optional?: true;
  /** The value is an ARRAY of paths: every entry is refused on its own. */
  each?: true;
}>;
/**
 * Every path input the validation family reads, declared ONCE:
 * `launchDirectoryPaths` applies the same rule to all of them, before any
 * handler branch runs.
 *
 * On a connection that declared no workspace the invocation directory is the
 * MCP server's LAUNCH directory (the host's own checkout), so a relative value
 * would read an artifact the caller never named and answer with a convincing
 * verdict for the wrong project. The CLI never trips the rule: its `cwd` is the
 * directory the operator ran from.
 *
 * `worktree.check` and `compound.validate` declare none: both read the
 * invocation control root, so the resolver refuses them on such a connection
 * before a launch-directory workspace exists.
 */
const pathInputs: Record<(typeof verbs)[number], readonly PathInput[]> = {
  "dispatch.validate": [{ field: "assignmentFile", subject: "the assignment file" }],
  "worktree.check": [],
  "worktree.qc-alignment": [{ field: "files", subject: "the assignment file", each: true }],
  "review.seats": [{ field: "assignmentFile", subject: "the assignment file" }],
  lint: [{ field: "target", subject: "the lint target" }],
  "design-md.validate": [{ field: "dir", subject: "the design directory" }],
  "compound.validate": [],
  "skill.lint": [{ field: "skillDir", subject: "the skill directory" }],
  "roles.validate": [
    { field: "rolesDir", subject: "the role corpus directory" },
    // An omitted skillsDir is the roles dir's PARENT, i.e. derived from the
    // directory the caller named above, so only a relative value is refused.
    { field: "skillsDir", subject: "the skills root", optional: true },
  ],
  "qc.validate-report": [{ field: "reportFile", subject: "the report file" }],
};
/**
 * The family's ONE application of the launch-directory rule: with no declared
 * workspace, every path this validator reads must be absolute, and every
 * offending input is reported in one refusal. A named workspace keeps
 * resolving the relative path UNDER it, unchanged.
 */
function launchDirectoryPaths(command: (typeof verbs)[number], input: Input, context: InvocationContext): CommandEnvelope<never> | undefined {
  const fields = pathInputs[command].flatMap((entry): LaunchDirectoryField[] => {
    const value: unknown = input[entry.field];
    if (entry.each === true) {
      const paths = Array.isArray(value) ? value.filter((file): file is string => typeof file === "string") : [];
      return paths.map((file, index) => ({
        field: `${entry.field}[${index}]`,
        subject: paths.length === 1 ? entry.subject : `${entry.subject} #${index + 1}`,
        value: file,
      }));
    }
    return [{
      field: entry.field,
      subject: entry.subject,
      value: typeof value === "string" ? value : undefined,
      ...(entry.optional === true ? { optional: true as const } : {}),
    }];
  });
  return fields.length === 0 ? undefined : launchDirectoryRefusal(command, context, { fields });
}

/** why: one extension source — the engine list the CI selector is asserted against, never a second literal. */
const codeExtensions: Record<string, true> = Object.fromEntries(CODE_FILE_EXTENSIONS.map((ext) => [ext, true]));
const provenanceExtensions: Record<string, true> = { ".md": true, ".ts": true };
/** why: `iteration` names ONE document — the iteration's own compass — so its
 * selector is that filename, and it governs a named file as much as a walk. */
const isCompass = (file: string): boolean => path.basename(file) === "delivery-compass.md";
/** why: a forced type selects its files — an extension set for the
 * dialect-shaped types, and the compass filename for `iteration`, whose
 * subject is one known document rather than every Markdown file a walk sees.
 * `--type code` must collect only code: a SKILL.md the same walk sees carries
 * fixtures and prose the code rules do not describe. */
const typeAccept: Partial<Record<LintType, (file: string) => boolean>> = {
  code: (file) => codeExtensions[path.extname(file).toLowerCase()] === true,
  provenance: (file) => provenanceExtensions[path.extname(file).toLowerCase()] === true,
  iteration: isCompass,
};
/** why: `fixtures` is pruned from EVERY walk this collector feeds (comment, provenance, any `--type`), not just the comment one: those trees hold deliberately broken artifacts (a `broken-skill` SKILL.md among them), so walking them would report the fixtures' own defects as the tree's, and a narrower prune would only add that noise. Other entries are build output no walk reads. The provenance guard in `scripts/drift-lint.ts` keeps its own exempt set for its own walk. */
const skipDirs: Record<string, true> = { node_modules: true, ".git": true, dist: true, coverage: true, ".turbo": true, fixtures: true };
type LintType = "plan" | "skill" | "strategy" | "report" | "code" | "finding" | "provenance" | "specs" | "adr" | "acceptance" | "iteration";
function lintType(file: string): LintType | null {
  const base = path.basename(file);
  if (base === "delivery-compass.md") return "iteration";
  if (base === "STRATEGY.md") return "strategy";
  if (base === "SKILL.md") return "skill";
  if (/^task-\d+-report\.md$/i.test(base)) return "report";
  const dir = path.dirname(file);
  if (dir.includes(`${path.sep}plans${path.sep}`) || dir.endsWith(`${path.sep}plans`) || /^\d{8}-[a-z0-9.-]+\.md$/i.test(base)) return "plan";
  return codeExtensions[path.extname(base).toLowerCase()] ? "code" : null;
}
/** The ADR root a record file belongs to: walk `{bucket}/{class}/` upward.
 * A file outside that shape has no root, so no record check applies. */
function adrRootOf(file: string): string | null {
  let dir = path.dirname(file);
  if ((ADR_CLASSES as readonly string[]).includes(path.basename(dir))) dir = path.dirname(dir);
  return (ADR_BUCKETS as readonly string[]).includes(path.basename(dir)) ? path.dirname(dir) : null;
}

/** The two document layers (`mstar-artifacts/references/knowledge-and-designs.md`):
 * a directory is the tree check, a single file is that document's own check. */
function lintDocLayer(type: "specs" | "adr", target: string, isDir: boolean): Violation[] {
  if (type === "specs") {
    return isDir ? lintSpecsTree(target).violations : lintSpecsDoc(readFileSync(target, "utf8"), target).violations;
  }
  if (isDir) {
    return lintAdrTree(target).failures.map((failure: AdrLintFailure) => ({
      ok: false as const, severity: "medium" as const, code: failure.code, message: failure.message, fix: failure.recovery,
    }));
  }
  const root = adrRootOf(target);
  if (root === null) throw new SddScriptError(`usage: lint <file> --type adr — ${target} is not under {ADR_DIR}/{bucket}/{class}/`, 2);
  const rel = path.relative(root, target).split(path.sep).join("/");
  const [bucket, kind, ...rest] = rel.split("/");
  if (
    bucket === undefined || kind === undefined ||
    !(ADR_BUCKETS as readonly string[]).includes(bucket) ||
    !(ADR_CLASSES as readonly string[]).includes(kind) ||
    rest.length !== 1 || !rest[0]!.endsWith(".md")
  ) {
    throw new SddScriptError(`usage: lint <file> --type adr — ${target} is not a record at {ADR_DIR}/{bucket}/{class}/<record>.md`, 2);
  }
  return lintAdrTree(root).failures
    .filter((failure: AdrLintFailure) => failure.file === rel)
    .map((failure) => ({ ok: false as const, severity: "medium" as const, code: failure.code, message: failure.message, fix: failure.recovery }));
}

function collectTargets(dir: string, accept: (file: string) => boolean = (file) => lintType(file) !== null): string[] {
  const targets: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.includes(path.sep)) continue;
      const child = current + entry.name;
      if (entry.isDirectory()) { if (!skipDirs[entry.name]) visit(child + path.sep); }
      else if (entry.isFile() && accept(child)) targets.push(child);
    }
  };
  visit(dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`);
  return targets;
}
/** One refused front-matter read: the code the verb refuses with, a message
 * naming the RESOLVED source (a pointer's target, not the pointer file) and
 * its line, and the supported correction.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md */
type FrontMatterFailure = { ok: false; code: string; message: string; fix: string };

/** why: D16 — the QC alignment fields are Assignment front matter keys, so
 * this reads the fenced block ONLY; a `**Label**: value` body line is never a
 * declaration and never satisfies the alignment check. One parse for the
 * three keys. A refusal is NOT three missing fields: a duplicate key, a
 * malformed line and an unterminated fence each come back as their own
 * diagnostic naming `source` and the line, while genuinely absent keys still
 * produce the missing rows.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
function frontMatterScalars(text: string, source: string): { ok: true; planId: string; reviewRange: string; diffBasis: string } | FrontMatterFailure {
  const { frontmatter, fenced } = extractFrontmatterAndBody(text);
  // An opening fence that never closes declares an INVALID surface, not an
  // absent one — the same distinction the plan reader draws.
  // see docs/knowledge/conventions/plan-frontmatter-declarations.md
  if (!fenced && (text.startsWith("---\n") || text.startsWith("---\r\n"))) {
    return {
      ok: false,
      code: "qc.alignment.field.malformed",
      message: `${source}:1: front matter fence is never closed \u2014 the declaration is invalid, not absent`,
      fix: 'close the front matter with a second "---" line',
    };
  }
  const empty = { ok: true as const, planId: "", reviewRange: "", diffBasis: "" };
  if (frontmatter === "") return empty;
  let entries: ReturnType<typeof parseDocumentFrontmatterEntries>;
  try {
    entries = parseDocumentFrontmatterEntries(frontmatter, source);
  } catch (error) {
    if (error instanceof DocumentFrontmatterError) {
      const duplicate = error.message.includes("duplicate key");
      return {
        ok: false,
        code: duplicate ? "qc.alignment.field.duplicate" : "qc.alignment.field.malformed",
        message: duplicate
          ? `duplicate front matter key blocks the QC alignment read: ${error.message}`
          : `front matter does not parse: ${error.message}`,
        fix: error.fix,
      };
    }
    return {
      ok: false,
      code: "qc.alignment.field.malformed",
      message: `${source}: front matter does not parse: ${(error as Error).message}`,
      fix: "rewrite the reported line as a supported `key: value` front matter line",
    };
  }
  // A present-but-non-scalar key is an invalid DECLARATION, not an absent
  // one: the plan reader refuses the same shapes, so aligning on a block
  // scalar's text would pass a pack dispatch then refuses. A bare `key:` is
  // the exception — its empty container is the parser's tentative shape and
  // carries no declaration, so it reads as missing exactly as the absent key.
  // see docs/knowledge/conventions/plan-frontmatter-declarations.md
  for (const key of ["plan_id", "review_range", "diff_basis"] as const) {
    const entry = entries.get(key);
    if (entry === undefined || entry.kind === "scalar") continue;
    const value = entry.value;
    const emptyContainer = entry.rawText === "" && typeof value === "object" && value !== null &&
      (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0);
    if (emptyContainer) continue;
    return {
      ok: false,
      code: "qc.alignment.field.malformed",
      message: `${source}:${entry.line}: invalid ${key} \u2014 accepted value: a single scalar on the key line, not a ${entry.kind}`,
      fix: `rewrite the declaration as ${key}: <value> on one line`,
    };
  }
  // The RAW lexeme is the declaration, exactly as the plan reader reads it: a
  // numeric-looking plan id keeps its written spelling instead of the typed
  // scalar, and one surrounding quote pair still strips. `null` / `~` / a bare
  // key carry no declaration, so they read as absent.
  // see docs/knowledge/conventions/plan-frontmatter-declarations.md
  const scalar = (key: string): string => {
    const raw = entries.get(key)?.rawText ?? "";
    if (raw === "" || raw === "null" || raw === "~") return "";
    const text = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0]
      ? raw.slice(1, -1)
      : raw;
    return text.trim();
  };
  return { ok: true, planId: scalar("plan_id"), reviewRange: scalar("review_range"), diffBasis: scalar("diff_basis") };
}
/**
 * why: every validation verb that reads a named assignment file goes through
 * the ONE source resolver (compass D14) instead of a bare `readFileSync`. The
 * CLI's input is already a file, so its content is the resolver's inline input
 * and a pointer line inside it follows the same containment rules every
 * dispatch gate uses — a pointer-form assignment answers the same question on
 * the CLI as it does at a gate. A refusal is terminal for the verb: validating
 * a text that is not the named assignment would report fields on the wrong
 * body.
 * see docs/knowledge/architecture-patterns/assignment-file-carrier.md
 */
function resolveAssignmentFile(file: string, context: InvocationContext): AssignmentSourceResult {
  const harnessDir = context.controlRoot ?? resolveProcessHarnessDir(context.cwd);
  return readAssignmentSource(readFileSync(file, "utf8"), { harnessDir });
}
/** why: the count line sums these markers, so the wording lives here once. */
const UNCLASSIFIED_MARKER_PREFIX = "unclassified comment @";
/** see skills/mstar-coding-behavior/references/comments.md § MUST — an
 * unresolved pointer is counted on its own line, never folded into the
 * unclassified corpus, which is a detector-collapse floor. */
const UNRESOLVED_POINTER_MARKER_PREFIX = "unresolved comment pointer @";
const POINTER_PATH_PREFIX_RE = /^(?:docs|skills|packages|scripts)\//;

/** see skills/mstar-coding-behavior/references/comments.md § MUST — a path
 * pointer counts only when its target exists at HEAD and is not a git-ignored
 * build output; a git failure (not a repository) leaves the path accepted.
 * Every other pointer form (a URL, `#<n>`, `issue <n>`, `contract §`) never
 * reaches this check. */
function pointerResolves(target: string, cwd: string): boolean {
  if (!POINTER_PATH_PREFIX_RE.test(target)) return false;
  const resolved = path.join(cwd, target);
  if (!existsSync(resolved)) return false;
  try {
    execFileSync("git", ["check-ignore", "-q", "--", resolved], { cwd, stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}
/** why: the two arms are not the same question - `undefined` means no ratchet
 * (every comment is reported), an empty list means the diff does not touch this
 * file, so it reports none. */
type TouchedLines = readonly (readonly [number, number])[];
function lintOne(file: string, cwd: string, pointerCache: Map<string, boolean>, type?: LintType, prVariant = false, touched?: TouchedLines): { violations: Violation[]; markers: string[] } {
  const text = readFileSync(file, "utf8");
  // why: the comment rules are the language's, so the file name picks the
  // dialect - a Python `//` is floor division and a `#` opens its comment.
  const dialect = sourceDialect(file);
  const violations: Violation[] = [];
  const markers: string[] = [];
  switch (type ?? lintType(file)) {
    case "plan": violations.push(...planQualityBar(text).violations); break;
    case "skill": violations.push(...lintFrontmatter(text).violations); break;
    case "strategy": violations.push(...lintStrategySections(text).violations); break;
    case "report": violations.push(...assertSddTddTriple(text).violations); break;
    case "code": {
      // why: comments.md § Markers makes an unbounded marker a violation, and
      // `shortcut:` is the same label as `simplify:`, so both are gated here.
      // The untracked-TODO and commented-out-code findings stay advisory.
      for (const marker of findSimplifyMarkers(text, dialect)) {
        if (marker.bound === null) {
          violations.push({
            ok: false,
            severity: "medium",
            code: "lint.simplify.no-upgrade-path",
            message: `${marker.label} marker at line ${marker.line} records no bound - state when to upgrade or where its removal is tracked (comments.md \u00a7 Markers)`,
            fix: `state the bound on the marker or a continuation line of its comment block, e.g. "${marker.label}: <limit>, upgrade: <when>" or "removal tracked in status.json"`,
          });
          continue;
        }
        markers.push(`${marker.label} marker @${marker.line}: ${marker.text}`);
      }
      // why: this is the ratchet's whole point - without a diff base the same
      // finding stays an advisory marker and the count line is its only
      // output; under `--diff-base` a comment the change added or modified
      // (any line of a block moving counts) becomes a violation instead.
      for (const finding of findUnclassifiedComments(text, dialect)) {
        const changed = touched === undefined
          ? false
          : touched.some(([start, end]) => finding.line <= end && finding.endLine >= start);
        if (touched !== undefined && !changed) continue;
        markers.push(`${UNCLASSIFIED_MARKER_PREFIX}${finding.line}: ${finding.text}`);
        if (changed) {
          violations.push({
            ok: false,
            severity: "medium",
            code: "lint.comment.unclassified",
            message: `unclassified comment at line ${finding.line} - the shape matches none of comments.md \u00a7 MUST (marker, contract pointer, @generated, tracked TODO)`,
            fix: 'give the comment a shape: "see docs/<path>" (or skills/packages/scripts), "see https://<url>", "simplify: <ceiling>, upgrade: <when>" / "@generated \u2026", or delete it',
          });
        }
      }
      // see skills/mstar-coding-behavior/references/comments.md § MUST — a
      // pointer is a claim that must resolve at HEAD, so it rides the same
      // ratchet as an unclassified comment.
      for (const pointer of findCommentPointers(text, dialect)) {
        const changed = touched === undefined
          ? false
          : touched.some(([start, end]) => pointer.startLine <= end && pointer.endLine >= start);
        if (touched !== undefined && !changed) continue;
        let resolved = pointerCache.get(pointer.target);
        if (resolved === undefined) {
          resolved = pointerResolves(pointer.target, cwd);
          pointerCache.set(pointer.target, resolved);
        }
        if (resolved) continue;
        markers.push(`${UNRESOLVED_POINTER_MARKER_PREFIX}${pointer.line}: ${pointer.target}`);
        if (changed) {
          violations.push({
            ok: false,
            severity: "medium",
            code: "lint.comment.pointer-unresolved",
            message: `unresolved comment pointer at line ${pointer.line} - "${pointer.target}" does not resolve at HEAD (comments.md \u00a7 MUST: a contract pointer must resolve)`,
            fix: "point the comment at a target that exists (a docs/skills/packages/scripts path), or delete the pointer",
          });
        }
      }
      for (const todo of findUntrackedTodos(text, dialect)) markers.push(`untracked ${todo.marker} @${todo.line}: ${todo.text}`);
      for (const finding of findCommentedCode(text, dialect)) markers.push(`commented-out code @${finding.line}: ${finding.text}`);
      const temporary = findTemporaryMarkers(text, dialect);
      for (const marker of temporary.markers) markers.push(`temporary marker @${marker.line}: ${marker.text} (${marker.removalPath === null ? "no removal path" : `removal: ${marker.removalPath}`})`);
      violations.push(...temporary.violations); break;
    }
    case "acceptance":
      // why: the PM acceptance gate fields are one document schema, so the
      // lint type reports it under its own namespace instead of a second
      // validator.
      // see docs/knowledge/conventions/brief-acceptance-declarations.md
      for (const schemaViolation of validateDocumentFrontmatter("pm-acceptance", text, "pm-acceptance").violations) {
        violations.push({ ...schemaViolation, code: schemaViolation.code.replace(/^document\.frontmatter\./, "lint.acceptance.frontmatter.") });
      }
      break;
    case "finding": violations.push(...validateFindingDoc(text, prVariant ? { prVariant: true } : {}).violations); break;
    case "iteration": violations.push(...lintIterationCompass(text).violations); break;
    case "provenance":
      for (const citation of findProvenanceCitations(text)) violations.push({ ok: false, severity: "medium", code: `lint.provenance.${citation.kind}`, message: `provenance ${citation.kind} citation at line ${citation.line}: "${citation.match}" — tracked content must not disclose local plan/iteration ids or dated harness deep paths`, fix: `rewrite "${citation.match}" as a placeholder form (e.g. task-N-report, <plan-id>) or a synthetic example slug (any -example- segment)` });
      break;
    default: throw new SddScriptError(`usage: lint <target> — unsupported file type "${path.basename(file)}" (lintable: plan files, SKILL.md, STRATEGY.md, task-N-report.md, code files)`, 2);
  }
  return { violations, markers };
}

async function execute(id: string, input: Input, context: InvocationContext): Promise<CommandEnvelope> {
  try {
    // One rule for the whole family, before any handler branch reads a path.
    const unnamedPaths = launchDirectoryPaths(id as (typeof verbs)[number], input, context);
    if (unnamedPaths !== undefined) return unnamedPaths;
    switch (id) {
      case "dispatch.validate": {
        const file = absolute(context.cwd, required(input.assignmentFile, "usage: dispatch validate <assignment-file> [--branch <branch>]"));
        if (!existsSync(file)) throw new Error(`assignment file not found: ${file}`);
        // why: the read goes through the ONE source resolver (compass D14) —
        // the CLI's input is already a file, so its content is inline input
        // to the resolver and a pointer line inside it follows the same
        // containment rules every gate shares. The resolver's refusal is
        // terminal for this command: validating a text that is not the
        // assignment source would report field violations on the wrong body.
        // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
        const source = resolveAssignmentFile(file, context);
        if (!source.ok) {
          return rejected(
            id,
            { ok: false, violations: [{ ok: false, severity: "critical", code: source.code, message: source.message, fix: source.fix }] },
            source.code,
          );
        }
        const text = source.text;
        const violations: Violation[] = [];
        // why: D16 — the retired `**Label**` body-line format is refused with
        // the front matter recovery UP FRONT instead of the schema's generic
        // absent-fence row, so every gate the caller consults answers the same
        // code. Shape detection and the refusal text are the engine's ONE
        // copies; a fenced document keeps the schema verdict.
        // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
        const legacy = legacyAssignmentShape(text);
        if (legacy) violations.push(legacyFormatViolation());
        const fields = parseAssignmentFields(text);
        const readOnly = isReadOnlyAssignmentRole(fields.executeAs ?? "");
        violations.push(...validateAssignmentFields(text, { writable: readOnly ? false : undefined }).violations.filter(
          // why: the legacy refusal supersedes the schema's absent-fence row
          // for Assignment-shaped input — one defect, one message. Any other
          // document keeps the schema row as its whole verdict.
          // see docs/knowledge/architecture-patterns/shared-frontmatter-declaration-reader.md
          (schemaViolation) => !(legacy && schemaViolation.code === "document.frontmatter.absent"),
        ));
        if (!readOnly) {
          const forms = parseAssignmentBranchForms(text);
          const declaredBranch = forms.createForm?.name ?? forms.workingBranch ?? forms.directOn?.branch;
          const branch = declaredBranch ?? input.branch ?? process.env.MSTAR_WORKING_BRANCH;
          if (declaredBranch !== undefined && input.branch !== undefined && declaredBranch.trim() !== input.branch.trim()) {
            violations.push({
              ok: false, severity: "high", code: "dispatch.branch.conflict",
              message: `--branch "${input.branch}" conflicts with Assignment branch "${declaredBranch}"`,
              fix: "use the branch declared by the Assignment or update the Assignment",
            });
          }
          if (fields.writeDomain !== "control") {
            // EVERY declared branch is gated (a `working_branch` list is the
            // see docs/adr/implemented/architecture/2026-11-26-frontmatter-declaration-layer.md
            // parallel shape), so a second track on `main` is caught too.
            const declared = declaredAssignmentBranches(fields, forms);
            const branches = declared.length > 0 ? declared : branch?.trim() ? [branch] : [];
            const directOnBranch = parseBranchPolicyDirectOnBranch(text);
            for (const target of branches) {
              violations.push(...assertDefaultBranchProtected(target, { directOnException: directOnBranch === target.trim() }).violations);
            }
          } else {
            violations.push(...validateControlWriteAssignment(text, { cwd: context.cwd, assignmentDir: path.dirname(source.path ?? file) }));
          }
        }
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok(id, gateData(gate)) : rejected(id, gate, "dispatch.assignment.invalid");
      }
      case "worktree.check": {
        if (input.controlClean) {
          // why: standalone control-clean mode decides one question, so every
          // other selector is mutually exclusive — accepting one silently would
          // answer the control-root question and skip the selected check.
          // --harness is the one combinable anchor: it names the harness the
          // presence question is asked about.
          const conflicting = [
            input.plan === undefined ? undefined : "--plan",
            input.planId === undefined ? undefined : "the <plan-id> argument",
            input.workflow === undefined ? undefined : "--workflow",
            input.l2 === undefined ? undefined : "--l2",
            input.tracks === undefined ? undefined : "--tracks",
            input.entry === undefined ? undefined : "--entry",
            input.integration === undefined ? undefined : "--integration",
            input.mainBranch === undefined ? undefined : "--main-branch",
            input.control === undefined ? undefined : "--control",
          ].filter((option): option is string => option !== undefined);
          if (conflicting.length > 0) {
            throw new SddScriptError(`usage: worktree check --control-clean [--harness <path>] — pass --control-clean alone, not with ${conflicting.join(" / ")}; run the control-root check and ${conflicting.join(" / ")} as separate invocations`, 2);
          }
          // why: a relative anchor resolves against the invocation workspace, never
          // this process's own directory.
          const harnessAnchor = input.harness === undefined ? undefined : path.resolve(context.cwd, input.harness);
          const main = readMainWorktree(harnessAnchor ?? context.cwd);
          if (main === null) return rejected(id, assertControlClean({ controlRoot: null }), "worktree.main.invalid");
          // invariant: a named anchor counts only when the {HARNESS_DIR} chain
          // resolves that exact directory as its checkout's harness - existing is
          // not the same as being a harness. Otherwise the control root's own chain
          // decides, and no declared harness means no control-root contract: the
          // check skips.
          const anchorRoot = harnessAnchor === undefined ? undefined : probeCheckoutRoot(harnessAnchor) ?? main.root;
          const anchorHarness = anchorRoot === undefined ? undefined : resolveHarnessDir(anchorRoot, { localProbe: true, workspaceRoot: anchorRoot });
          const namedHarness = harnessAnchor !== undefined && typeof anchorHarness === "string" && canonicalPath(anchorHarness) === canonicalPath(harnessAnchor);
          if (!hasHarnessRoot(main.root) && !namedHarness) return ok(id, gateData({ ok: true, violations: [] }));
          const gate = assertControlClean({ controlRoot: main });
          // why: the literal recovery is what the refusal-quality rule can prove; each
          // violation's own fix stays in the details.
          return gate.ok
            ? ok(id, gateData(gate))
            : refusal(id, gate.violations[0]?.code ?? "worktree.main.invalid", gate.violations[0]?.message ?? "control root tracked-change check failed", gateData(gate), "The control root carries only gitignored process state; move the edits to the checkout that carries the target branch (the integration or feature worktree) and commit there. Run `mstar worktree check --control-clean`.");
        }
        if (input.l2) {
          // `tracks` reaches here already validated: the typed input field is
          // the boundary contract (published schema == enforced shape), and the
          // CLI adapter decodes the raw JSON string through the same shared
          // schema before executeCommand. Only the absent-field usage gate
          // remains family-owned.
          if (input.tracks === undefined) throw new SddScriptError("usage: worktree check --l2 --tracks <json>", 2);
          const gate = l2PreDispatchCheck({ tracks: input.tracks });
          return gate.ok ? ok(id, gateData(gate)) : rejected(id, gate, "worktree.l2.invalid");
        }
        const plan = input.plan ?? input.planId;
        if (!input.entry && !plan) throw new SddScriptError("usage: worktree check <plan-id> --workflow <id> [--harness <path>] [--integration <path>] [--main-branch <branch>] (or --plan <plan-id>)", 2);
        const workflow = required(input.workflow, "usage: worktree check <plan-id> --workflow <id> [--harness <path>] [--integration <path>] [--main-branch <branch>] (or --plan <plan-id>)");
        if (input.control !== undefined && input.integration !== undefined) throw new SddScriptError("usage: worktree check <plan-id> --workflow <id> — pass --integration or the deprecated --control alias, not both", 2);
        const warnings: string[] = [];
        if (input.control !== undefined) {
          const depMsg = "--control is deprecated; use --integration";
          context.effects.writeStderr?.(`[mstar-harness] ${depMsg}`);
          warnings.push(depMsg);
        }
        if (workflow === "." || workflow === ".." || workflow.includes("/") || workflow.includes("\\")) throw new Error(`invalid workflow id ${JSON.stringify(workflow)}`);
        const harness = resolveProcessHarnessDir(context.cwd, input.harness) ?? context.controlRoot;
        if (!harness) throw new Error("harness directory not found");
        // The pre-activation snapshot arm is retired (issue #428): the ACTIVE
        // execution authority is the only source, so a control root without one
        // refuses out of `readExecutionState` instead of reading leftover JSON.
        const { readExecutionState } = await import("@mstar-harness/engine");
        const graph = (await readExecutionState({ harnessDir: harness })).data;
        const registered = graph.workflows.find(({ state }) => state.id === workflow);
        if (!registered) return refusal(id, "worktree.l1.workflow-not-found", `workflow "${workflow}" not found in the active execution authority graph`, { workflowId: workflow, authorityGraph: harness }, "Rerun mstar worktree check --workflow <id> --plan <plan-id> with a workflow id registered in the execution authority.");
        if (input.entry) {
          const gate = workflowEntryPreDispatchCheck({
            workflowType: registered.state.type,
            workflowId: workflow,
            branch: registered.state.branch ?? {},
            integrationWorktreePath: typeof registered.state.integration_worktree_path === "string" ? registered.state.integration_worktree_path : undefined,
            mainWorktree: readMainWorktree(context.cwd),
            lifecycleBranches: activeGraphLifecycleBranches(graph),
            integrationLease: registered.integrationLease ?? undefined,
          });
          return gate.ok ? ok(id, gate) : refusal(id, gate.violations[0]?.code ?? "worktree.entry.invalid", gate.violations[0]?.message ?? "workflow-entry checks failed", { ...gate, workflowId: workflow }, "Correct every engine-enforced workflow-entry violation listed in details, then rerun mstar worktree check --workflow <id> --entry. This does not replace the full pre-dispatch checklist.");
        }
        const planView = plan === undefined
          ? registered.plans.length === 1 ? registered.plans[0] : undefined
          : registered.plans.find((candidate) => candidate.plan.id === plan);
        if (!planView) return refusal(id, "worktree.l1.plan-not-found", `plan "${plan}" not found in active execution authority graph workflow "${workflow}"`, { workflowId: workflow, planId: plan, authorityGraph: harness }, "Rerun mstar worktree check --plan <plan-id> --workflow <id> with a plan id that exists in the workflow.");
        const selectedPlanId = planView.plan.id;
        if (typeof selectedPlanId !== "string") return refusal(id, "worktree.l1.plan-not-found", `the selected plan row in workflow "${workflow}" has no string id`, { workflowId: workflow, authorityGraph: harness }, "Correct the plan row named in the details, then rerun mstar worktree check --plan <plan-id> --workflow <id>.");
        const main = await awaitSpawn(context, ["git", "worktree", "list", "--porcelain"]);
        if (!main.ok) return refusal(id, "worktree.probe.unavailable", main.stderr || "main worktree probe failed", undefined, "Rerun mstar worktree check --workflow <id> --plan <plan-id> after the main worktree and branch probes succeed.");
        const primary = main.stdout.split(/\r?\n/).find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
        if (!primary) return refusal(id, "worktree.probe.unavailable", "main worktree probe returned no worktree", undefined, "Rerun mstar worktree check --workflow <id> --plan <plan-id> after the main worktree and branch probes succeed.");
        const mainBranch = await awaitSpawn(context, ["git", "branch", "--show-current"], primary);
        if (!mainBranch.ok) return refusal(id, "worktree.probe.unavailable", mainBranch.stderr || "branch probe failed", undefined, "Rerun mstar worktree check --workflow <id> --plan <plan-id> after the main worktree and branch probes succeed.");
        const branch = registered.state.branch ?? {};
        const lifecycleBranches = activeGraphLifecycleBranches(graph);
        const metadata = isPlainRecord(planView.plan.metadata) ? planView.plan.metadata : {};
        const selectedIntegration = input.integration ?? input.control;
        const gate = l1PreDispatchCheck({
          workflowType: registered.state.type,
          integrationWorktreePath: selectedIntegration !== undefined
            ? path.resolve(selectedIntegration)
            : typeof registered.state.integration_worktree_path === "string" ? registered.state.integration_worktree_path : "",
          integrationBranch: String(branch.integration ?? ""),
          mainWorktree: { root: primary, branch: mainBranch.stdout.trim() },
          expectedMainBranch: input.mainBranch ?? String(branch.base ?? ""),
          lifecycleBranches,
          rowWorktreePath: typeof metadata.worktree_path === "string" ? metadata.worktree_path : "",
          rowWorkingBranch: typeof metadata.working_branch === "string" ? metadata.working_branch : "",
          planId: selectedPlanId,
        });
        const lease = registered.integrationLease === null ? { claimed: false as const } : { claimed: true as const, lease: registered.integrationLease };
        if (lease.claimed) {
          const leaseGate = validateIntegrationMergeLease(lease.lease);
          gate.violations.push(...leaseGate.violations);
          gate.ok = gate.violations.length === 0;
        }
        const gateResult = { ...gateData(gate), lease };
        const resultData = warnings.length ? { ...gateResult, warnings } : gateResult;
        return gate.ok ? ok(id, resultData) : refusal(id, gate.violations[0]?.code ?? "worktree.l1.invalid", gate.violations[0]?.message ?? "L1 worktree check failed", { ...gateResult, ...(warnings.length ? { warnings } : {}) }, "Correct each violation listed in the details as its fix directs, then rerun mstar worktree check.");
      }
      case "worktree.qc-alignment": {
        const files = input.files ?? [];
        if (!files.length) {
          return refusalEnvelope({
            command: id,
            status: "usage",
            code: "command.invalid-input",
            exitCode: 2,
            message: "Invalid input.",
            diagnostics: [{
              path: "files",
              code: "required",
              message: "at least one assignment file is required",
            }],
          });
        }
        // Each assignment is a FILE the caller named: `launchDirectoryPaths`
        // already refused every relative one on an unnamed workspace. The
        // alignment fields are front matter keys — plan_id, review_range and
        // diff_basis — never body labels, and the file resolves through the
        // shared source resolver (a pointer-form assignment aligns on the
        // document it names).
        // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
        const rows: { file: string; assignment: QcAlignmentAssignment }[] = [];
        // A refusal is per FILE and every file's refusal is reported: the verb
        // checks a QC tri pack, so keeping only the first malformed document
        // would hide the rest of the same round's defects. The source label is
        // the RESOLVED path — an `Assignment file:` pointer's target, which is
        // the document that actually failed to parse.
        // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
        const failures: FrontMatterFailure[] = [];
        for (const named of files) {
          const file = absolute(context.cwd, named);
          if (!existsSync(file)) throw new Error(`assignment file not found: ${file}`);
          const source = resolveAssignmentFile(file, context);
          if (!source.ok) {
            return rejected(
              id,
              { ok: false, violations: [{ ok: false, severity: source.severity, code: source.code, message: source.message, fix: source.fix }] },
              source.code,
            );
          }
          const resolved = source.path ?? file;
          const scalars = frontMatterScalars(source.text, resolved);
          if (!scalars.ok) {
            failures.push(scalars);
            continue;
          }
          rows.push({
            file: resolved,
            assignment: { planId: scalars.planId, reviewRange: scalars.reviewRange, diffBasis: scalars.diffBasis },
          });
        }
        const assignments = rows.map(({ assignment }) => assignment);
        // A malformed block blocks validation itself, so naming three absent
        // fields would send the caller after the wrong defect.
        // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
        if (failures.length) {
          const [first] = failures;
          return refusal(
            id,
            first!.code,
            failures.length === 1
              ? first!.message
              : `${failures.length} assignment files declare unreadable front matter \u2014 ${first!.message}`,
            { failures: failures.map(({ code, message }) => ({ code, message })), assignments },
            "Fix the front matter of the named assignment file (a `---`-fenced block with plan_id / review_range / diff_basis), then rerun mstar worktree qc-alignment <assignment-file> <assignment-file> with one path per seat so the pack is compared as a whole.",
          );
        }
        const fields: { key: keyof QcAlignmentAssignment; label: string }[] = [
          { key: "planId", label: "plan_id" }, { key: "reviewRange", label: "review_range" }, { key: "diffBasis", label: "diff_basis" },
        ];
        for (const { file, assignment } of rows) {
          const missing = fields.filter(({ key }) => assignment[key] === "");
          if (missing.length) return refusal(id, "qc.alignment.field.missing", `${file}: missing "${missing[0]!.label}" front matter field`, { fields: missing.map(({ label }) => label), file, assignments }, "Add the missing keys to the Assignment front matter (a `---`-fenced block declaring plan_id / review_range / diff_basis), then rerun mstar worktree qc-alignment <assignment-file> <assignment-file> with one path per seat.");
        }
        const gate = assertQcAlignment(assignments);
        return gate.ok ? ok(id, { assignments, ...gateData(gate) }) : rejected(id, gate, "qc.alignment.mismatch");
      }
      case "review.seats": {
        const named = required(input.assignmentFile, "usage: review seats <assignment-file> [--mode sdd|inline|targeted] [--reviewers <role1,role2,...>]");
        // The seat count is read FROM the caller's assignment, whose path the
        // shared rule already required to be absolute on an unnamed workspace.
        const file = absolute(context.cwd, named);
        if (!existsSync(file)) throw new Error(`assignment file not found: ${file}`);
        // why: the seat count is read from the caller's assignment through the
        // ONE source resolver — `dispatch validate` and this verb must answer
        // the same for one assignment file, including its pointer form.
        // see docs/knowledge/architecture-patterns/assignment-file-carrier.md
        const source = resolveAssignmentFile(file, context);
        if (!source.ok) {
          return rejected(
            id,
            { ok: false, violations: [{ ok: false, severity: source.severity, code: source.code, message: source.message, fix: source.fix }] },
            source.code,
          );
        }
        const mode = input.mode ?? parseAssignmentFields(source.text).executionMode ?? "";
        const reviewers = input.reviewers ?? [];
        const result = executionModeToN(mode, { seats: reviewers });
        if (!result.ok) return rejected(id, result, "review.seats.invalid");
        if ((mode.trim().toLowerCase().split(/\s+/)[0] ?? "") === "sdd" && reviewers.length) {
          const tri = assertTriIdentity(reviewers);
          if (!tri.ok) return rejected(id, tri, "review.seats.tri-identity");
        }
        return ok(id, { n: result.n, mode, reviewers });
      }
      case "lint": {
        const target = required(input.target, "usage: lint <target> (file or dir)");
        const forced = input.type?.trim().toLowerCase();
        const known = ["plan", "skill", "strategy", "report", "code", "finding", "provenance", "specs", "adr", "acceptance", "iteration"];
        if (forced !== undefined && !known.includes(forced)) throw new SddScriptError(`usage: lint --type must be one of ${known.join(" | ")}, got ${JSON.stringify(input.type)}`, 2);
        const abs = absolute(context.cwd, target);
        if (!existsSync(abs)) throw new Error(`lint target not found: ${abs}`);
        const isDir = statSync(abs).isDirectory();
        if (forced === "acceptance" && isDir) {
          // One report, one check: an acceptance sweep has no selector (no
          // extension or tree check applies), so a directory would either
          // report success over nothing or check unrelated auto-detected
          // files against the acceptance schema. Name the file instead.
          // see docs/knowledge/conventions/brief-acceptance-declarations.md
          throw new SddScriptError(`usage: lint <report.md> --type acceptance — the acceptance type validates one PM acceptance report and does not walk a directory; name the report file`, 2);
        }
        // why: the recovery must rerun the SAME check, and `acceptance` is the
        // one type whose filename inference never reproduces it, so that arm
        // names its flag verbatim. Both arms stay literal: the refusal prover
        // evaluates recovery text statically and cannot read `--type ${forced}`.
        // see docs/knowledge/conventions/brief-acceptance-declarations.md
        const rerun = forced === "acceptance"
          ? "Resolve each reported lint violation, then rerun mstar lint <target> --type acceptance."
          : "Resolve each reported lint violation, then rerun mstar lint <target>, repeating the same --type value if you supplied one.";
        if (forced === "specs" || forced === "adr") {
          // Document layers: a directory is the tree check, a file is one document.
          const results = [{ file: abs, violations: lintDocLayer(forced, abs, isDir), markers: [] as string[] }];
          return results.some((result) => result.violations.length) ? refusal(id, results[0]!.violations[0]?.code ?? "lint.violations", "lint violations found", { results }, rerun) : ok(id, { results });
        }
        const accept = forced === undefined ? undefined : typeAccept[forced as LintType];
        // why: `iteration` names ONE document, so a file the caller names is
        // no more a compass than one a walk sees — `--type iteration` on a
        // note must check nothing, never run the compass rule over prose.
        const selected = !isDir && forced === "iteration" && !isCompass(abs) ? [] : undefined;
        const targets = selected ?? (!isDir ? [abs] : accept === undefined ? collectTargets(abs) : collectTargets(abs, accept));
        // why: `--diff-base` is the ratchet - a finding is reported only when
        // the change adds or modifies a line of it, and a file the diff does
        // not mention keeps an empty range list so it reports none.
        const changed = input.diffBase === undefined ? undefined : await changedLineRanges(context, input.diffBase);
        const needsCode = targets.some((file) => (forced ?? lintType(file)) === "code");
        const repoRoot = changed?.root ?? (needsCode ? await gitTop(context) : undefined) ?? context.cwd;
        const pointerCache = new Map<string, boolean>();
        const results = targets.map((file) => {
          const touched = changed === undefined
            ? undefined
            : (changed.ranges.get(path.relative(changed.root, canonicalPath(file)).split(path.sep).join("/")) ?? []);
          return { file, ...lintOne(file, repoRoot, pointerCache, forced as LintType | undefined, input.prVariant === true, touched) };
        });
        // why: the count is a summary written beside the envelope, so it is
        // stderr only; a run that linted no code file reports no count.
        if (needsCode) {
          const unclassified = results.reduce((total, result) => total + result.markers.filter((marker) => marker.startsWith(UNCLASSIFIED_MARKER_PREFIX)).length, 0);
          context.effects.writeStderr?.(`unclassified comments: ${unclassified}`);
          const unresolved = results.reduce((total, result) => total + result.markers.filter((marker) => marker.startsWith(UNRESOLVED_POINTER_MARKER_PREFIX)).length, 0);
          if (unresolved > 0) context.effects.writeStderr?.(`unresolved comment pointers: ${unresolved}`);
        }
        return results.some((result) => result.violations.length) ? refusal(id, results.flatMap((r) => r.violations)[0]?.code ?? "lint.violations", "lint violations found", { results }, rerun) : ok(id, { results });
      }
      case "design-md.validate": {
        const dir = absolute(context.cwd, required(input.dir, "usage: design-md validate <dir>"));
        const lightPath = path.join(dir, "DESIGN.md");
        if (!existsSync(lightPath)) throw new Error(`design file not found: ${lightPath}`);
        const light = readFileSync(lightPath, "utf8");
        const violations: Violation[] = [...validateDesignTokenFrontmatter(light).violations];
        const darkPath = path.join(dir, "DESIGN.dark.md");
        if (existsSync(darkPath)) violations.push(...assertLightDarkParity(light, readFileSync(darkPath, "utf8")).violations);
        const level = completenessLevel(light);
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok(id, { ...gateData(gate), completeness: level }) : rejected(id, gate, "design-md.invalid");
      }
      case "compound.validate": {
        const docPath = absolute(context.cwd, required(input.docPath, "usage: compound validate <doc-path> [--knowledge-dir <dir>]"));
        if (!existsSync(docPath)) throw new Error(`knowledge doc not found: ${docPath}`);
        const violations: Violation[] = [...validateSchemaYaml(readFileSync(docPath, "utf8")).violations];
        if (input.knowledgeDir !== undefined) {
          const knowledgeDir = absolute(context.cwd, input.knowledgeDir);
          // Catalog completeness is a store.db query, so the check needs the
          // process harness this invocation belongs to: the root the launcher
          // pinned for the session first (a pinned MCP server must not fall back
          // to the cwd's harness), then the same process probe the CLI performs.
          // FAIL-CLOSED: without a resolvable root — or with a store the engine
          // refuses (missing / staged / corrupt) — report the refusal instead of
          // a completeness verdict the command cannot make.
          const harnessDir = context.controlRoot ?? resolveProcessHarnessDir(context.cwd);
          if (harnessDir === null) {
            violations.push({
              ok: false,
              severity: "high",
              code: "compound.catalog.unresolved-harness",
              message: `no {HARNESS_DIR} resolves for this invocation, so the knowledge catalog completeness of ${knowledgeDir} cannot be asserted`,
              fix: "run this command from the repository that owns the fixed harness root (<main worktree>/.mstar); catalog completeness is a store.db query",
            });
          } else {
            // The completeness query discovers bodies and matches catalog rows
            // under ONE root: the harness-resolved knowledge root. Its verdict
            // is that root's, so it is not a verdict about any other directory
            // as a knowledge store — answering a caller's other directory with
            // it reports a different question as if it were the named one's.
            // Only the configured root ITSELF is proven, normalized: a symlinked
            // or `./`-spelled equal path compares equal, a subdirectory does not.
            const checkoutRoot = probeCheckoutRoot(context.cwd);
            const storeContext = { harnessDir, ...(checkoutRoot === null ? {} : { checkoutRoot }) };
            const configuredRoot = catalogRootDir(storeContext, "knowledge");
            const named = canonicalPath(knowledgeDir);
            const root = canonicalPath(configuredRoot);
            if (named !== root) {
              violations.push({
                ok: false,
                severity: "high",
                code: "compound.catalog.knowledge-dir-mismatch",
                message:
                  `${knowledgeDir} is not the configured knowledge root ${configuredRoot}, so its catalog completeness cannot be asserted — ` +
                  "completeness is a store.db query that reports the configured root's verdict (the documents registered relative to it), " +
                  "which is never a verdict about a subdirectory of that root or about another directory as a knowledge store",
                fix:
                  `pass --knowledge-dir ${configuredRoot} to validate the configured root (omitting the flag validates only the document schema, with no catalog completeness check); ` +
                  `or move/declare those documents under ${configuredRoot} and register them there; ` +
                  "or point the project's knowledge root at that directory (`.mstarc` `[config] knowledge_dir`) and validate that root",
              });
            } else {
              try {
                violations.push(...(await assertKnowledgeCatalogCompleteness(storeContext)).violations);
              } catch (error) {
                const code = (error as { code?: unknown } | null | undefined)?.code;
                violations.push({
                  ok: false,
                  severity: "high",
                  code: "compound.catalog.unavailable",
                  message:
                    `the knowledge catalog completeness cannot be evaluated: ` +
                    `${typeof code === "string" && code !== "" ? `[${code}] ` : ""}${error instanceof Error ? error.message : String(error)}`,
                  fix: "restore the issue/catalog authority (`mstar store init|upgrade|migrate`) — unavailable catalog data is never read as complete",
                });
              }
            }
          }
          violations.push(...scopeGuard(docPath, [knowledgeDir]).violations);
        }
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok(id, gateData(gate)) : rejected(id, gate, "compound.invalid");
      }
      case "skill.lint": {
        const dir = absolute(context.cwd, required(input.skillDir, "usage: skill lint <skill-dir>"));
        const skillFile = path.join(dir, "SKILL.md");
        if (!existsSync(skillFile)) throw new Error(`SKILL.md not found: ${skillFile}`);
        const text = readFileSync(skillFile, "utf8");
        const violations: Violation[] = [...lintFrontmatter(text).violations];
        const profile = classifySkillLint(path.basename(dir));
        if (profile.mode !== null) violations.push(...lintFiveQuestion(stripFrontmatter(text), profile.mode).violations);
        violations.push(...findEphemeralCitations(text).map((citation) => ({ ok: false, severity: "medium" as const, code: `skill.ephemeral.${citation.kind}`, message: `ephemeral ${citation.kind} citation at line ${citation.line}: "${citation.match}" — task artifacts and SDD deeplinks survive nothing; durable skill text cites in-repo artifacts only (knowledge conventions §3)`, fix: `rewrite "${citation.match}" as a placeholder form (e.g. task-N-report, <plan-id>, {SDD_DIR}/task-N-report.md) or cite a stable in-repo artifact instead` })));
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok(id, { ...gateData(gate), exempt: profile.mode === null }) : rejected(id, gate, "skill.lint.invalid");
      }
      case "roles.validate": {
        // The no-argument form validates the CHECKOUT's own corpus (the relative
        // `skills/mstar-roles` default and that directory's parent): the shared
        // rule requires both directories on an unnamed workspace instead, since
        // a clean verdict about the host's repository is a silent wrong answer.
        const rolesDir = absolute(context.cwd, input.rolesDir ?? "skills/mstar-roles");
        const skillsRoot = absolute(context.cwd, input.skillsDir ?? path.dirname(rolesDir));
        const violations: Violation[] = [...validateRoleMapping(rolesDir).violations];
        const skillTexts: Record<string, string> = {};
        for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("mstar-")) continue;
          const file = path.join(skillsRoot, entry.name, "SKILL.md");
          if (!existsSync(file)) continue;
          try { skillTexts[entry.name] = readFileSync(file, "utf8"); } catch { /* preserve best-effort CLI behavior */ }
        }
        // The engine-absent archive is linted over its whole text face; every
        // other sibling stays SKILL.md-only. Missing/unreadable reference dirs
        // contribute nothing (the collector is best-effort).
        const loadOrder = lintLoadOrder(
          mergeLegacyArchiveReferences(skillTexts, collectLegacyArchiveReferenceTexts(skillsRoot)),
        );
        violations.push(...loadOrder.violations);
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok(id, { ...gateData(gate), siblingCount: Object.keys(skillTexts).length, loadOrderChecked: Object.keys(skillTexts).filter((name) => name !== "mstar-harness-core").length }) : rejected(id, gate, "roles.invalid");
      }
      case "qc.validate-report": {
        // The report path is required but may still be relative: the shared rule
        // already refused a relative one on an unnamed workspace.
        const file = absolute(context.cwd, required(input.reportFile, "report file is required"));
        if (!existsSync(file)) throw new Error(`report file not found: ${file}`);
        const gate = validateQcReport(readFileSync(file, "utf8"));
        return gate.ok ? ok(id, gateData(gate)) : rejected(id, gate, "qc.report.invalid");
      }
    default:
      return failed(id, new Error(`unsupported validation command: ${id}`));
    }
  } catch (error) { return failed(id, error); }
}
async function awaitSpawn(context: InvocationContext, argv: readonly string[], cwd = context.cwd): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await context.effects.spawn({ argv, cwd, env: {}, signal: context.signal });
  return { ok: result.exitCode === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
/** see skills/mstar-coding-behavior/references/comments.md § MUST — a pointer
 * resolves from the checkout root, not the invocation directory, so a run from
 * a subdirectory still proves repo-relative targets. A cwd outside a git
 * checkout, or a host whose spawn seam cannot start git, keeps the invocation
 * directory; an aborted invocation still propagates. */
async function gitTop(context: InvocationContext): Promise<string | undefined> {
  try {
    const top = await awaitSpawn(context, ["git", "rev-parse", "--show-toplevel"]);
    return top.ok && top.stdout !== "" ? canonicalPath(top.stdout) : undefined;
  } catch (error) {
    if (context.signal.aborted) throw error;
    return undefined;
  }
}
/** why: the new side's count is 0 for a deletion-only hunk, which contributes
 * no changed line, so the count is read separately from the start. */
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** why: the C string git writes beside a header when a path holds a quote,
 * a backslash or a control character — `core.quotePath=false` only turns off
 * octal escaping of non-ASCII bytes, not this quoting. */
const C_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"',
};

/** note: decode the C-quoted path git wrote into a header field, or return the field
 * as-is when it is not quoted. A quoted path may be followed by a tab git adds
 * to separate the name from the hunk context; anything after the closing quote
 * is separator. A bare path gets that one trailing tab dropped, which is the
 * only separator git writes for an unquoted name. */
function diffHeaderPath(field: string): string {
  if (!field.startsWith('"')) return field.endsWith("\t") ? field.slice(0, -1) : field;
  let out = "";
  for (let i = 1; i < field.length; i++) {
    const c = field[i]!;
    if (c === '"') return out;
    if (c !== "\\") { out += c; continue; }
    const escape = field[i + 1] ?? "";
    const octal = /^[0-7]{1,3}/.exec(field.slice(i + 1));
    if (octal !== null) {
      out += String.fromCharCode(Number.parseInt(octal[0], 8));
      i += octal[0].length;
      continue;
    }
    out += C_ESCAPES[escape] ?? escape;
    i += 1;
  }
  return out;
}

/**
 * The lines a change adds or modifies against `ref`, per repository-relative
 * path, plus the root those paths are spelled from. A zero-context diff is the
 * whole answer: a modified line is a deletion plus an addition, so the new side
 * carries both, and a deletion-only hunk (`+c,0`) contributes nothing.
 *
 * shortcut: untracked files are absent from `git diff <base>`, so a new file
 * that was never added reports no changed lines. upgrade: stage-aware diffing,
 * when a local ratchet must see files `git add` has not staged.
 */
async function changedLineRanges(context: InvocationContext, ref: string): Promise<{ root: string; ranges: Map<string, [number, number][]> }> {
  const base = await awaitSpawn(context, ["git", "merge-base", ref, "HEAD"]);
  if (!base.ok || base.stdout === "") throw new SddScriptError(`usage: lint <target> --diff-base <ref> - git merge-base ${ref} HEAD failed: ${base.stderr || "no merge base"}`, 2);
  const top = await awaitSpawn(context, ["git", "rev-parse", "--show-toplevel"]);
  if (!top.ok || top.stdout === "") throw new SddScriptError(`usage: lint <target> --diff-base <ref> - ${context.cwd} is not inside a git checkout: ${top.stderr}`, 2);
  // why: a checkout may set `diff.noprefix=true` and git still C-quotes a path
  // holding a quote, a backslash or a control character. Forcing both prefixes
  // and decoding the quoted form keeps the map key the caller's own repo
  // path; otherwise the lookup misses, defaults to an empty range list, and a
  // changed unclassified comment passes the ratchet.
  const diff = await awaitSpawn(context, ["git", "-c", "core.quotePath=false", "diff", "--src-prefix=a/", "--dst-prefix=b/", "--unified=0", "--no-color", "--no-ext-diff", base.stdout, "--"]);
  if (!diff.ok) throw new SddScriptError(`usage: lint <target> --diff-base <ref> - git diff ${base.stdout} failed: ${diff.stderr}`, 2);
  const ranges = new Map<string, [number, number][]>();
  let file: string | undefined;
  // why: a hunk body line starts with `+`, `-`, ` ` or `\` and may itself
  // spell `+++ b/x`; reading that as a header would reassign the file, drop
  // every changed line of the real file after it, and pass the ratchet
  // vacuously. Headers are therefore read only outside a hunk body.
  let inHunk = false;
  for (const line of diff.stdout.split("\n")) {
    if (inHunk) {
      if (line !== "" && /^[+\- \\]/.test(line)) continue;
      inHunk = false;
    }
    if (line.startsWith("+++ ")) {
      const target = diffHeaderPath(line.slice(4));
      file = target === "/dev/null" ? undefined : target.replace(/^b\//, "");
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk === null) continue;
    inHunk = true;
    if (file === undefined) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    const list = ranges.get(file);
    if (list === undefined) ranges.set(file, [[start, start + count - 1]]);
    else list.push([start, start + count - 1]);
  }
  // why: a symlinked checkout (`/tmp` -> `/private/tmp`) answers with its
  // physical path, so the root the caller's targets are spelled from is
  // canonicalized to match.
  return { root: canonicalPath(top.stdout), ranges };
}

const contract: Record<(typeof verbs)[number], { path: string[]; args: { key: string; required: boolean; variadic: boolean }[]; options: { key: string; flags: string; context?: "sessionId" }[]; effects: CommandDefinition["effects"]; description: string }> = {
  "dispatch.validate": { path: ["dispatch", "validate"], args: [{ key: "assignmentFile", required: true, variadic: false }], options: [{ key: "branch", flags: "--branch <branch>" }], effects: ["read", "validate"], description: "Validate an Assignment's front matter fields and branch protection. Fields live ONLY in the document's `---`-fenced YAML front matter (snake_case keys: execute_as, delegation, task_category, working_branch / branch_policy, write_domain, worktree_path, control_write_paths, execution_mode, budget, return_shape, task_budget); a retired `**Label**` body-line document refuses `dispatch.assignment.legacy-format` with the front matter recovery. The file's own content may be an `Assignment file: <abs>` pointer instead, resolved under an accepted assignment home. Write domain: control requires `worktree_path`, one branch form, and a `control_write_paths` list; paths are concrete, absolute or relative to `worktree_path`, and must be gitignored in the control checkout. A trailing / declares a directory; a path without it is checked under both file and directory ignore rules and must be ignored in both." },
  "worktree.check": { path: ["worktree", "check"], args: [{ key: "planId", required: false, variadic: false }], options: [{ key: "plan", flags: "--plan <plan-id>" }, { key: "workflow", flags: "--workflow <id>" }, { key: "entry", flags: "--entry" }, { key: "harness", flags: "--harness <path>" }, { key: "integration", flags: "--integration <path>" }, { key: "mainBranch", flags: "--main-branch <branch>" }, { key: "control", flags: "--control <path>" }, { key: "l2", flags: "--l2" }, { key: "controlClean", flags: "--control-clean" }, { key: "tracks", flags: "--tracks <json>" }], effects: ["read", "validate", "process"], description: "Check engine-enforced workflow-entry facts, the L1/L2 worktree pre-dispatch gate, or the control root tracked-change gate (--control-clean: refuses while the Git main worktree carries committable changes; a repository without .mstar/ or .mstarc has no control-root contract and skips)." },
  "worktree.qc-alignment": { path: ["worktree", "qc-alignment"], args: [{ key: "files", required: true, variadic: true }], options: [], effects: ["read", "validate"], description: "Assert QC/QA Assignment alignment." },
  "review.seats": { path: ["review", "seats"], args: [{ key: "assignmentFile", required: true, variadic: false }], options: [{ key: "mode", flags: "--mode <mode>" }, { key: "reviewers", flags: "--reviewers <list>" }], effects: ["read", "validate"], description: "Map execution mode to QC seat count and assert tri identity." },
  lint: { path: ["lint"], args: [{ key: "target", required: true, variadic: false }], options: [{ key: "type", flags: "--type <type>" }, { key: "prVariant", flags: "--pr-variant" }, { key: "diffBase", flags: "--diff-base <ref>" }], effects: ["read", "validate", "process"], description: "Lint harness artifacts by content type (plan | skill | strategy | report | code | finding | provenance | specs | adr | acceptance | iteration). A directory is walked; only `code`, `provenance` and `iteration` define a file selector (an extension set, and the `delivery-compass.md` name), so `--type` narrows that walk only for them (`--type code` is the form the comment gate runs), and `--type iteration` also selects nothing for a file that is not a `delivery-compass.md`, while every other type walks every collected file - except `specs` and `adr`, which run their own document-layer tree check instead. `--type acceptance` validates ONE PM acceptance report's front matter (plan_id, gate, verdict, generated_at) against the shared `pm-acceptance` document schema and refuses a directory target, naming the report file. An unclassified comment without `--diff-base` is an advisory marker, with one `unclassified comments: <n>` summary line on stderr; `--diff-base <ref>` turns it into a violation on any comment line the change adds or modifies (any line of a block counts), which refuses the run and exits 1." },
  "design-md.validate": { path: ["design-md", "validate"], args: [{ key: "dir", required: true, variadic: false }], options: [], effects: ["read", "validate"], description: "Validate DESIGN.md token frontmatter, parity and completeness." },
  "compound.validate": { path: ["compound", "validate"], args: [{ key: "docPath", required: true, variadic: false }], options: [{ key: "knowledgeDir", flags: "--knowledge-dir <dir>" }], effects: ["read", "validate"], description: "Validate a knowledge document and optional index scope." },
  "skill.lint": { path: ["skill", "lint"], args: [{ key: "skillDir", required: true, variadic: false }], options: [], effects: ["read", "validate"], description: "Lint a skill directory." },
  "roles.validate": { path: ["roles", "validate"], args: [], options: [{ key: "rolesDir", flags: "--roles-dir <dir>" }, { key: "skillsDir", flags: "--skills-dir <dir>" }], effects: ["read", "validate"], description: "Validate the role mapping and load-order corpus." },
  "qc.validate-report": { path: ["qc", "validate-report"], args: [{ key: "reportFile", required: true, variadic: false }], options: [], effects: ["read", "validate"], description: "Validate a saved QC seat report." },
};
function definition(verb: (typeof verbs)[number]): CommandDefinition<Input, unknown> {
  const id = verb;
  const item = contract[verb];
  const payloads: Record<string, PayloadDescriptor> | undefined = verb === "worktree.check"
    ? { tracks: { schema: tracksSchema } }
    : undefined;
  const assignmentHeaderRequirement = {
    name: "assignmentFile",
    ownership: "caller" as const,
    constraint: "the file's fields live ONLY in a `---`-fenced YAML front matter block of snake_case keys (execute_as, delegation, task_category, working_branch / branch_policy, and so on); body `**Label**` lines are prose and declare nothing. The file may instead hold a single `Assignment file: <abs>` pointer line, which is resolved under an accepted assignment home",
  };
  return {
    id,
    cli: { path: item.path, aliases: [], arguments: item.args, options: item.options.map((option) => ({ ...option, required: false })) },
    input: schemas[verb],
    output: commandEnvelopeSchema,
    effects: item.effects,
    description: item.description,
    ...(verb === "dispatch.validate" ? {
      requirements: [
        { ...assignmentHeaderRequirement, route: "cli" as const },
        { ...assignmentHeaderRequirement, route: "mcp" as const },
      ],
    } : {}),
    ...(payloads === undefined ? {} : { payloads }),
    execute: (input, context) => execute(id, input, context),
  };
}
export function getValidationCommandDefinitions(): readonly CommandDefinition[] { return verbs.map(definition); }
