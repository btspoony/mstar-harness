import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  assertDefaultBranchProtected,
  assertIndexRows,
  assertLightDarkParity,
  assertQcAlignment,
  assertSddTddTriple,
  assertTriIdentity,
  classifySkillLint,
  activeLifecyclePlanId,
  collectActiveLifecycleBranches,
  completenessLevel,
  executionModeToN,
  findEphemeralCitations,
  findProvenanceCitations,
  findSimplifyMarkers,
  findTemporaryMarkers,
  isReadOnlyAssignmentRole,
  l1PreDispatchCheck,
  l2PreDispatchCheck,
  lintFiveQuestion,
  lintFrontmatter,
  lintLoadOrder,
  lintStrategySections,
  parseAssignmentBranchForms,
  parseAssignmentFields,
  parseBranchPolicyDirectOnBranch,
  planQualityBar,
  scanActiveLifecycleBranches,
  scopeGuard,
  SddScriptError,
  stripFrontmatter,
  validateAssignmentFields,
  validateDesignTokenFrontmatter,
  validateFindingDoc,
  validateQcReport,
  validateRoleMapping,
  validateSchemaYaml,
  type GateResult,
  type ActiveLifecycleBranch,
  type QcAlignmentAssignment,
  WorkflowSnapshotValidationError,
  readWorkflowSnapshot,
  resolveProcessHarnessDir,
  type ExecutionState,
} from "@mstar-harness/engine";
import { refusalEnvelope } from "../envelope.js";
import { z } from "zod";
import { resolveCliPath } from "../host-health.js";
import { commandEnvelopeSchema } from "../definitions.js";
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
  mainBranch?: string; control?: string; l2?: boolean; tracks?: { worktreePath: string; workingBranch: string }[]; files?: string[]; mode?: string; reviewers?: string[];
  target?: string; type?: string; prVariant?: boolean; dir?: string; docPath?: string; knowledgeDir?: string;
  skillDir?: string; rolesDir?: string; skillsDir?: string; reportFile?: string;
};
type Violation = GateResult["violations"][number];
function assignmentExecutionMode(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\*\*\s*Execution mode\s*\*\*\s*:\s*(.*)$/) ?? line.match(/^Execution mode\s*:\s*(.*)$/);
    if (match) return match[1]!.trim();
  }
  return "";
}
const verbs = ["dispatch.validate", "worktree.check", "worktree.qc-alignment", "review.seats", "lint", "design-md.validate", "compound.validate", "skill.lint", "roles.validate", "qc.validate-report"] as const;
const schemas: Record<(typeof verbs)[number], z.ZodType<Input>> = {
  "dispatch.validate": z.object({ assignmentFile: z.string().optional(), branch: z.string().optional() }),
  "worktree.check": z.object({ planId: z.string().optional(), plan: z.string().optional(), workflow: z.string().optional(), harness: z.string().optional(), integration: z.string().optional(), mainBranch: z.string().optional(), control: z.string().optional(), l2: z.boolean().optional(), tracks: tracksSchema.optional() }),
  "worktree.qc-alignment": z.object({ files: z.array(z.string()).optional() }),
  "review.seats": z.object({ assignmentFile: z.string().optional(), mode: z.string().optional(), reviewers: z.array(z.string()).optional() }),
  lint: z.object({ target: z.string().optional(), type: z.string().optional(), prVariant: z.boolean().optional() }),
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
function absolute(_cwd: string, input: string): string { return resolveCliPath(input); }

const codeExtensions: Record<string, true> = Object.fromEntries([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".sh", ".bash", ".zsh", ".rb", ".java", ".kt", ".swift"].map((ext) => [ext, true]));
const provenanceExtensions: Record<string, true> = { ".md": true, ".ts": true };
const skipDirs: Record<string, true> = { node_modules: true, ".git": true, dist: true, coverage: true, ".turbo": true };
type LintType = "plan" | "skill" | "strategy" | "report" | "code" | "finding" | "provenance";
function lintType(file: string): LintType | null {
  const base = path.basename(file);
  if (base === "STRATEGY.md") return "strategy";
  if (base === "SKILL.md") return "skill";
  if (/^task-\d+-report\.md$/i.test(base)) return "report";
  const dir = path.dirname(file);
  if (dir.includes(`${path.sep}plans${path.sep}`) || dir.endsWith(`${path.sep}plans`) || /^\d{8}-[a-z0-9.-]+\.md$/i.test(base)) return "plan";
  return codeExtensions[path.extname(base).toLowerCase()] ? "code" : null;
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
function parseHeaderField(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bold = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?\\*\\*\\s*${escaped}\\s*\\*\\*\\s*:\\s*(.*)$`);
  const plain = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escaped}\\s*:\\s*(.*)$`);
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(bold) ?? line.match(plain);
    if (match) return match[1]!.trim();
  }
  return "";
}
function lintOne(file: string, type?: LintType, prVariant = false): { violations: Violation[]; markers: string[] } {
  const text = readFileSync(file, "utf8");
  const violations: Violation[] = [];
  const markers: string[] = [];
  switch (type ?? lintType(file)) {
    case "plan": violations.push(...planQualityBar(text).violations); break;
    case "skill": violations.push(...lintFrontmatter(text).violations); break;
    case "strategy": violations.push(...lintStrategySections(text).violations); break;
    case "report": violations.push(...assertSddTddTriple(text).violations); break;
    case "code": {
      for (const marker of findSimplifyMarkers(text)) markers.push(`simplify marker @${marker.line}: ${marker.text}`);
      const temporary = findTemporaryMarkers(text);
      for (const marker of temporary.markers) markers.push(`temporary marker @${marker.line}: ${marker.text} (${marker.removalPath === null ? "no removal path" : `removal: ${marker.removalPath}`})`);
      violations.push(...temporary.violations); break;
    }
    case "finding": violations.push(...validateFindingDoc(text, prVariant ? { prVariant: true } : {}).violations); break;
    case "provenance":
      for (const citation of findProvenanceCitations(text)) violations.push({ ok: false, severity: "medium", code: `lint.provenance.${citation.kind}`, message: `provenance ${citation.kind} citation at line ${citation.line}: "${citation.match}" — tracked content must not disclose local plan/iteration ids or dated harness deep paths`, fix: `rewrite "${citation.match}" as a placeholder form (e.g. task-N-report, <plan-id>) or a synthetic example slug (any -example- segment)` });
      break;
    default: throw new SddScriptError(`usage: lint <target> — unsupported file type "${path.basename(file)}" (lintable: plan files, SKILL.md, STRATEGY.md, task-N-report.md, code files)`, 2);
  }
  return { violations, markers };
}

async function execute(id: string, input: Input, context: InvocationContext): Promise<CommandEnvelope> {
  try {
    switch (id) {
      case "dispatch.validate": {
        const file = absolute(context.cwd, required(input.assignmentFile, "usage: dispatch validate <assignment-file> [--branch <branch>]"));
        if (!existsSync(file)) throw new Error(`assignment file not found: ${file}`);
        const text = readFileSync(file, "utf8");
        const readOnly = isReadOnlyAssignmentRole(parseAssignmentFields(text).executeAs ?? "");
        const violations: Violation[] = [...validateAssignmentFields(text, { writable: readOnly ? false : undefined }).violations];
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
          if (branch?.trim()) violations.push(...assertDefaultBranchProtected(branch, { directOnException: parseBranchPolicyDirectOnBranch(text) === branch.trim() }).violations);
        }
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok(id, gateData(gate)) : rejected(id, gate, "dispatch.assignment.invalid");
      }
      case "worktree.check": {
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
        if (!plan) throw new SddScriptError("usage: worktree check <plan-id> --workflow <id> [--harness <path>] [--integration <path>] [--main-branch <branch>] (or --plan <plan-id>)", 2);
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
        const { readExecutionState, resolveExecutionReadRoute } = await import("@mstar-harness/engine");
        if (await resolveExecutionReadRoute({ harnessDir: harness }) === "execution") {
          const graph = (await readExecutionState({ harnessDir: harness })).data;
          const registered = graph.workflows.find(({ state }) => state.id === workflow);
          if (!registered) return refusal(id, "worktree.l1.workflow-not-found", `workflow "${workflow}" not found in the active execution authority graph`, { workflowId: workflow, authorityGraph: harness }, "Rerun mstar worktree check --workflow <id> --plan <plan-id> with a workflow id registered in the execution authority.");
          const planView = input.planId === undefined
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
          const gateResult = gateData(gate);
          const resultData = warnings.length ? { ...gateResult, warnings } : gateResult;
          return gate.ok ? ok(id, resultData) : rejected(id, gate, "worktree.l1.invalid");
        }
        const snapshotPath = path.join(harness, "workflows", workflow, "snapshot.json");
        if (!existsSync(snapshotPath)) throw new Error(`workflow snapshot not found: ${snapshotPath}`);
        let snapshot: Record<string, any>;
        let snapshotDiagnostics: Array<{ ok: boolean; code: string; message: string }> = [];
        try {
          const read = readWorkflowSnapshot(path.dirname(snapshotPath));
          snapshot = read.snapshot as Record<string, any>;
          snapshotDiagnostics = read.diagnostics;
        } catch (error) {
          if (!(error instanceof WorkflowSnapshotValidationError)) throw error;
          const first = error.violations[0];
          return refusal(id, first?.code ?? "workflow.snapshot.invalid", first?.message ?? "invalid workflow snapshot", { violations: error.violations }, "Correct each reported workflow snapshot violation, then rerun mstar worktree check --workflow <id> --plan <plan-id>.");
        }
        for (const diagnostic of snapshotDiagnostics) {
          if (!diagnostic.ok) {
            context.effects.writeStderr?.(`[mstar-harness] ${diagnostic.code}: ${diagnostic.message}`);
            warnings.push(`${diagnostic.code}: ${diagnostic.message}`);
          }
        }
        const rows = Array.isArray(snapshot.plans) ? snapshot.plans.filter((row: Record<string, unknown>) => row?.id === plan || row?.plan_id === plan) : [];
        if (!rows.length) return refusal(id, "worktree.l1.plan-not-found", `no plan row with id/plan_id ${plan}`, { snapshotPath, planId: plan }, "Rerun mstar worktree check --plan <plan-id> --workflow <id> with a plan id present in the snapshot.");
        if (rows.length > 1) return refusal(id, "worktree.l1.ambiguous", "multiple plan rows match (id and plan_id both present)", { snapshotPath, planId: plan }, "Rerun mstar worktree check --plan <plan-id> --workflow <id> with a selector that matches exactly one row.");
        const main = await awaitSpawn(context, ["git", "worktree", "list", "--porcelain"]);
        if (!main.ok) return refusal(id, "worktree.probe.unavailable", main.stderr || "main worktree probe failed", undefined, "Rerun mstar worktree check --workflow <id> --plan <plan-id> after the main worktree and branch probes succeed.");
        const primary = main.stdout.split(/\r?\n/).find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
        if (!primary) return refusal(id, "worktree.probe.unavailable", "main worktree probe returned no worktree", undefined, "Rerun mstar worktree check --workflow <id> --plan <plan-id> after the main worktree and branch probes succeed.");
        const mainBranch = await awaitSpawn(context, ["git", "branch", "--show-current"], primary);
        if (!mainBranch.ok) return refusal(id, "worktree.probe.unavailable", mainBranch.stderr || "branch probe failed", undefined, "Rerun mstar worktree check --workflow <id> --plan <plan-id> after the main worktree and branch probes succeed.");
        const observedMainBranch = mainBranch.stdout.trim();
        const rowMetadata = isPlainRecord(rows[0].metadata) ? rows[0].metadata : {};
        const lifecycleBranches: ActiveLifecycleBranch[] = [];
        const siblingScan = scanActiveLifecycleBranches(harness, workflow);
        if (siblingScan.kind === "refusal") return refusal(id, siblingScan.code, siblingScan.detail, undefined, "Rerun mstar worktree check --workflow <id> --plan <plan-id> after correcting the reported sibling-workflow problem.");
        lifecycleBranches.push(...siblingScan.branches);
        // The selected row's source checkout/branch uses the dedicated identity
        // guard; its retained tracks and other snapshot ownership still block main.
        const snapshotWithoutSelectedSource = {
          ...snapshot,
          plans: snapshot.plans.map((row: Record<string, unknown>) =>
            row.id === plan || row.plan_id === plan ? { ...row, metadata: { track_branches: rowMetadata.track_branches } } : row,
          ),
        };
        lifecycleBranches.push(...collectActiveLifecycleBranches([snapshotWithoutSelectedSource]));
        const integrationPath = input.integration ?? input.control ?? snapshot.integration_worktree_path;
        const integrationBranch = snapshot.branch?.integration;
        const gate = l1PreDispatchCheck({
          workflowType: snapshot.type,
          integrationWorktreePath: integrationPath === undefined ? "" : path.resolve(integrationPath),
          integrationBranch: typeof integrationBranch === "string" ? integrationBranch : "",
          mainWorktree: { root: primary, branch: observedMainBranch },
          expectedMainBranch: input.mainBranch ?? String(snapshot.branch?.base ?? ""),
          lifecycleBranches,
          rowWorktreePath: String(rowMetadata.worktree_path ?? ""), rowWorkingBranch: String(rowMetadata.working_branch ?? ""), planId: plan,
        });
        if (
          observedMainBranch === (input.mainBranch ?? String(snapshot.branch?.base ?? "")) &&
          Array.isArray(rowMetadata.track_branches) && rowMetadata.track_branches.includes(observedMainBranch)
        ) {
          for (const violation of gate.violations) {
            if (violation.code !== "worktree.main.residency-switched") continue;
            const recovery =
              `workflow "${workflow}" plan "${plan}" in control harness "${harness}" records the main branch "${observedMainBranch}" as a retained track. ` +
              "Use its workflow coordinator's ordinary mstar plan show --session <coordinator-envelope> --plan <plan-id> --harness <control-root> " +
              "to read the current revision and progress, then mstar plan progress --session <coordinator-envelope> " +
              "--plan <plan-id> --harness <control-root> --expect <observed-revision> --progress <JSON> with the current status, summary, " +
              "evidence_paths and corrected complete track_branches. Keep all live tracks; use [] only when no tracks remain. " +
              "If the track is live, move it to a distinct feature branch and report that real branch; do not clear live ownership or switch main merely to satisfy this check.";
            violation.fix = recovery;
            violation.message += ` Recovery: ${recovery}`;
          }
        }
        const gateResult = gateData(gate);
        const resultData = warnings.length ? { ...gateResult, warnings } : gateResult;
        return gate.ok ? ok(id, resultData) : rejected(id, gate, "worktree.l1.invalid");
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
        const assignments: QcAlignmentAssignment[] = files.map((file) => {
          if (!existsSync(file)) throw new Error(`assignment file not found: ${file}`);
          const text = readFileSync(file, "utf8");
          const combined = parseHeaderField(text, "Review range / Diff basis");
          return { planId: parseHeaderField(text, "plan_id"), reviewRange: parseHeaderField(text, "Review range") || combined, diffBasis: parseHeaderField(text, "Diff basis") || combined };
        });
        const fields: { key: keyof QcAlignmentAssignment; label: string }[] = [
          { key: "planId", label: "plan_id" }, { key: "reviewRange", label: "Review range" }, { key: "diffBasis", label: "Diff basis" },
        ];
        for (const assignment of assignments) {
          const missing = fields.filter(({ key }) => assignment[key] === "");
          if (missing.length) return refusal(id, "qc.alignment.field.missing", `missing "${missing[0]!.label}" header field`, { fields: missing.map(({ label }) => label), assignments }, "Add the missing Assignment header fields listed in the details, then rerun mstar worktree qc-alignment <assignment-file>.");
        }
        const gate = assertQcAlignment(assignments);
        return gate.ok ? ok(id, { assignments, ...gateData(gate) }) : rejected(id, gate, "qc.alignment.mismatch");
      }
      case "review.seats": {
        const file = required(input.assignmentFile, "usage: review seats <assignment-file> [--mode sdd|inline|targeted] [--reviewers <role1,role2,...>]");
        if (!existsSync(file)) throw new Error(`assignment file not found: ${file}`);
        const text = readFileSync(file, "utf8");
        const mode = input.mode ?? assignmentExecutionMode(text);
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
        const known = ["plan", "skill", "strategy", "report", "code", "finding", "provenance"];
        if (forced !== undefined && !known.includes(forced)) throw new SddScriptError(`usage: lint --type must be one of ${known.join(" | ")}, got ${JSON.stringify(input.type)}`, 2);
        const abs = absolute(context.cwd, target);
        if (!existsSync(abs)) throw new Error(`lint target not found: ${abs}`);
        const isDir = statSync(abs).isDirectory();
        const targets = !isDir ? [abs] : forced === "provenance" ? collectTargets(abs, (file) => provenanceExtensions[path.extname(file).toLowerCase()] === true) : collectTargets(abs);
        
    const results = targets.map((file) => ({ file, ...lintOne(file, forced as LintType | undefined, input.prVariant === true) }));
        return results.some((result) => result.violations.length) ? refusal(id, results.flatMap((r) => r.violations)[0]?.code ?? "lint.violations", "lint violations found", { results }, "Resolve each reported lint violation, then rerun mstar lint <target>.") : ok(id, { results });
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
          violations.push(...assertIndexRows(knowledgeDir).violations, ...scopeGuard(docPath, [knowledgeDir]).violations);
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
        const loadOrder = lintLoadOrder(skillTexts);
        violations.push(...loadOrder.violations);
        const gate = { ok: violations.length === 0, violations };
        return gate.ok ? ok(id, { ...gateData(gate), siblingCount: Object.keys(skillTexts).length, loadOrderChecked: Object.keys(skillTexts).filter((name) => name !== "mstar-harness-core").length }) : rejected(id, gate, "roles.invalid");
      }
      case "qc.validate-report": {
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

const contract: Record<(typeof verbs)[number], { path: string[]; args: { key: string; required: boolean; variadic: boolean }[]; options: { key: string; flags: string; context?: "sessionId" }[]; effects: CommandDefinition["effects"]; description: string }> = {
  "dispatch.validate": { path: ["dispatch", "validate"], args: [{ key: "assignmentFile", required: true, variadic: false }], options: [{ key: "branch", flags: "--branch <branch>" }], effects: ["read", "validate"], description: "Validate Assignment fields and branch protection." },
  "worktree.check": { path: ["worktree", "check"], args: [{ key: "planId", required: false, variadic: false }], options: [{ key: "plan", flags: "--plan <plan-id>" }, { key: "workflow", flags: "--workflow <id>" }, { key: "harness", flags: "--harness <path>" }, { key: "integration", flags: "--integration <path>" }, { key: "mainBranch", flags: "--main-branch <branch>" }, { key: "control", flags: "--control <path>" }, { key: "l2", flags: "--l2" }, { key: "tracks", flags: "--tracks <json>" }], effects: ["read", "validate", "process"], description: "Run the existing L1/L2 worktree pre-dispatch gate." },
  "worktree.qc-alignment": { path: ["worktree", "qc-alignment"], args: [{ key: "files", required: true, variadic: true }], options: [], effects: ["read", "validate"], description: "Assert QC/QA Assignment alignment." },
  "review.seats": { path: ["review", "seats"], args: [{ key: "assignmentFile", required: true, variadic: false }], options: [{ key: "mode", flags: "--mode <mode>" }, { key: "reviewers", flags: "--reviewers <list>" }], effects: ["read", "validate"], description: "Map execution mode to QC seat count and assert tri identity." },
  lint: { path: ["lint"], args: [{ key: "target", required: true, variadic: false }], options: [{ key: "type", flags: "--type <type>" }, { key: "prVariant", flags: "--pr-variant" }], effects: ["read", "validate"], description: "Lint harness artifacts by content type." },
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
    ? { tracks: { schema: tracksSchema, help: "JSON array of {worktreePath, workingBranch}; the CLI passes the JSON string, MCP passes the object array" } }
    : undefined;
  const assignmentHeaderRequirement = {
    name: "assignmentFile",
    ownership: "caller" as const,
    constraint: "the file must use a `## Assignment` header; assignment metadata is read only before the next `##` section, thematic `---`, or top-level `#` heading, so put Execute as, Delegation, and other assignment fields in that header",
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
