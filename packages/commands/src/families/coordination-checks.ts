import { existsSync } from "node:fs";
import path from "node:path";
import {
  applyMigratePlan,
  createFsStore,
  evaluatePhaseGate,
  evaluatePostMergeClose,
  migrateHarnessTree,
  parseCompassFrontmatter,
  pushCadenceProbe,
  readExecutionSource,
  readJson,
  resolveExecutionReadRoute,
  resolveProcessHarnessDir,
  resolveWorkflowDir,
  setArtifactStore,
  validateProjectRegister,
  validateIntegrationMergeLease,
  validateWorkflowSnapshot,
  WORKFLOW_DELIVERY_KINDS,
  WORKFLOW_SNAPSHOT_FILE,
  type MigratePlan,
} from "@mstar-harness/engine";
import { z } from "zod";
import { refusalEnvelope } from "../envelope.js";
import { commandEnvelopeSchema } from "../definitions.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

function ok<T>(command: string, data: T): CommandEnvelope<T> {
  return { version: 1, command, status: "ok", code: `${command}.ok`, exitCode: 0, data };
}
function engineFailure(command: string, error: unknown, fallback: string): CommandEnvelope<never> {
  if (error instanceof z.ZodError) return refusalEnvelope({ command, status: "usage", code: "command.invalid-input", exitCode: 2, message: error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") });
  const code = errorCode(error, fallback);
  const message = messageOf(error);
  const details = error !== null && typeof error === "object" && "details" in error
    && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
  return refusalEnvelope({ command, status: "refused", code: "coordination.check-refused", exitCode: 1, message, details: { ...(details ?? {}), underlyingCode: code }, recovery: "Correct the reported authority, snapshot, or compass facts, then run mstar status validate." });
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function errorCode(error: unknown, fallback: string): string {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : fallback;
}
function command<I, O>(definition: CommandDefinition<I, O>): CommandDefinition<I, O> { return definition; }
function harnessDir(context: InvocationContext, override?: string): string {
  const resolved = resolveProcessHarnessDir(context.cwd, override);
  if (!resolved) throw new Error(`harness dir not found from ${context.cwd} — pass harness or set MSTAR_HARNESS_DIR`);
  return resolved;
}
function assertWorkflowId(id: string): void {
  if (id === "" || id === "." || id === ".." || id.includes("/") || id.includes("\\")) throw new Error(`invalid workflow id ${JSON.stringify(id)}`);
}
function snapshotPath(context: InvocationContext, workflow: string, override?: string): string {
  assertWorkflowId(workflow);
  const root = harnessDir(context, override);
  return path.join(resolveWorkflowDir(root, { harnessDir: root }), workflow, WORKFLOW_SNAPSHOT_FILE);
}
function validatePlanDocs(plan: MigratePlan): string[] {
  const warnings: string[] = [];
  for (const snapshot of plan.snapshots) {
    const result = validateWorkflowSnapshot(snapshot.data);
    if (!result.ok) for (const item of result.violations) warnings.push(`[${item.severity}] ${item.code}: ${item.message} (planned snapshot ${snapshot.file})`);
  }
  if (plan.register !== null) {
    const result = validateProjectRegister(plan.register.data);
    if (!result.ok) for (const item of result.violations) warnings.push(`[${item.severity}] ${item.code}: ${item.message} (planned register ${plan.register.file})`);
  }
  return warnings;
}

export function getCoordinationChecksCommandDefinitions(): readonly CommandDefinition[] {
  const output = commandEnvelopeSchema;
  return [
    command({
      id: "migrate",
      cli: { path: ["migrate"], aliases: [], arguments: [], options: [
        { key: "dryRun", flags: "--dry-run", required: false }, { key: "path", flags: "--path <root>", required: false },
        { key: "deliveryKind", flags: "--delivery-kind <kind>", required: false }, { key: "branchSource", flags: "--branch-source <branch>", required: false },
        { key: "branchTarget", flags: "--branch-target <branch>", required: false }, { key: "completionPolicy", flags: "--completion-policy <text>", required: false },
        { key: "json", flags: "--json", required: false },
      ] },
      input: z.object({ dryRun: z.boolean().optional(), path: z.string().optional(), deliveryKind: z.string().optional(), branchSource: z.string().optional(), branchTarget: z.string().optional(), completionPolicy: z.string().optional(), json: z.boolean().optional() }),
      output, effects: ["read", "write"], description: "Migrate a v1 status tree using the engine migration plan.",
      async execute(input, context) {
        const id = "migrate";
        const root = input.path ? path.resolve(context.cwd, input.path) : resolveProcessHarnessDir(context.cwd) ?? context.cwd;
        try {
          setArtifactStore(createFsStore(root));
          const plan = migrateHarnessTree(root, {
            dryRun: input.dryRun === true,
            ...(input.deliveryKind === undefined ? {} : { deliveryKind: input.deliveryKind as (typeof WORKFLOW_DELIVERY_KINDS)[number] }),
            ...(input.branchSource === undefined ? {} : { branchSource: input.branchSource }),
            ...(input.branchTarget === undefined ? {} : { branchTarget: input.branchTarget }),
            ...(input.completionPolicy === undefined ? {} : { completionPolicy: input.completionPolicy }),
          });
          if (plan.alreadyMigrated) return ok(id, { root, dryRun: plan.dryRun, alreadyMigrated: true, applied: false, message: plan.message, steps: plan.steps, migrationNotes: plan.migrationNotes });
          if (plan.deliveryKindAmbiguous.length > 0) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `a single delivery declaration cannot describe ${plan.deliveryKindAmbiguous.length} active standalone plan lifts (${plan.deliveryKindAmbiguous.join(", ")}) — migrate them in batches of one declared plan` });
          if (plan.deliveryKindRequired.length > 0) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `${plan.deliveryKindRequired.length} active standalone plan snapshot(s) would be lifted without a declared delivery kind (${plan.deliveryKindRequired.join(", ")}) — pass deliveryKind with its evidence (development: branchSource/branchTarget; verification/report-only: completionPolicy)` });
          if (plan.dryRun) return ok(id, { root, dryRun: true, alreadyMigrated: false, applied: false, message: `dry-run: ${plan.steps.length} steps planned, zero writes`, steps: plan.steps, migrationNotes: plan.migrationNotes, roadmapCandidate: plan.roadmap, validationWarnings: validatePlanDocs(plan) });
          try {
            const result = await applyMigratePlan(plan);
            return ok(id, { root, dryRun: false, alreadyMigrated: false, applied: result.applied, message: result.message, steps: plan.steps, migrationNotes: plan.migrationNotes, roadmapCandidate: plan.roadmap });
          } catch (error) {
            return { version: 1, command: id, status: "error", code: "migrate.apply-failure", exitCode: 2, message: messageOf(error) };
          }
        } catch (error) { return engineFailure(id, error, "migrate.refused"); }
      },
    }),
    command({
      id: "lease.verify-integration",
      cli: { path: ["lease", "verify-integration"], aliases: [], arguments: [], options: [{ key: "workflow", flags: "--workflow <id>", required: true }, { key: "harness", flags: "--harness <path>", required: false }] },
      input: z.object({ workflow: z.string().min(1), harness: z.string().optional() }), output, effects: ["read", "validate"], description: "Verify the workflow integration merge lease without mutation.",
      async execute(input, context) {
        const id = "lease.verify-integration";
        let lease: unknown;
        try {
          const root = harnessDir(context, input.harness);
          const served = await readExecutionSource({ harnessDir: root }, { workflowId: input.workflow });
          if (served.route === "execution") lease = (served.read.data as { workflows?: Array<{ integrationLease?: unknown }> }).workflows?.[0]?.integrationLease ?? undefined;
          else {
            const file = snapshotPath(context, input.workflow, input.harness);
            if (!existsSync(file)) return refusalEnvelope({ command: id, status: "refused", code: "lease.verify.snapshot-not-found", exitCode: 1, message: `workflow snapshot not found: ${file}`, recovery: "The workflow snapshot must be restored at the reported path before mstar lease verify-integration --workflow <workflow-id>." });
            lease = readJson(file).integration_merge_lease;
          }
          if (lease === undefined) return ok(id, { workflow: input.workflow, claimed: false });
          const result = validateIntegrationMergeLease(lease);
          return result.ok ? ok(id, { workflow: input.workflow, claimed: true, lease }) : refusalEnvelope({ command: id, status: "refused", code: result.violations[0]?.code ?? "lease.merge-lease.invalid", exitCode: 1, message: result.violations.map((item) => `[${item.severity}] ${item.code}: ${item.message}`).join("; "), details: { violations: result.violations }, recovery: "Resolve each reported merge-lease violation, then run mstar lease verify-integration --workflow <workflow-id>." });
        } catch (error) { return engineFailure(id, error, "lease.verify-integration.refused"); }
      },
    }),
    command({
      id: "iteration.gate",
      cli: { path: ["iteration", "gate"], aliases: [], arguments: [], options: [{ key: "workflow", flags: "--workflow <id>", required: true }, { key: "compass", flags: "--compass <path>", required: false }, { key: "phase", flags: "--phase <n>", required: false }, { key: "harness", flags: "--harness <path>", required: false }, { key: "branch", flags: "--branch <branch>", required: false }, { key: "integration", flags: "--integration <branch>", required: false }, { key: "target", flags: "--target <branch>", required: false }] },
      input: z.object({ workflow: z.string().min(1), compass: z.string().optional(), phase: z.string().optional(), harness: z.string().optional(), branch: z.string().optional(), integration: z.string().optional(), target: z.string().optional() }), output, effects: ["read", "validate"], description: "Evaluate the iteration phase transition gate without mutation.",
      async execute(input, context) {
        const id = "iteration.gate";
        try {
          const phase6 = input.phase !== undefined && Number(input.phase) === 6;
          if (input.phase !== undefined && !phase6) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: `usage: iteration gate --phase only supports 6 (got ${JSON.stringify(input.phase)})` });
          if (!phase6 && (!input.compass || input.compass.trim() === "")) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: "usage: iteration gate requires --compass <path> (or --phase 6 for the post-merge close form)" });
          const root = harnessDir(context, input.harness);
          const executionRoute = await resolveExecutionReadRoute({ harnessDir: root });
          if (executionRoute === "execution") {
            if (phase6) {
              // Phase-6 close facts are evaluated by the authority-specific
              // engine form; it reads the addressed workflow regardless of registration.
              const { evaluatePostMergeCloseFromExecutionAuthority } = await import("@mstar-harness/engine");
              const gate = await evaluatePostMergeCloseFromExecutionAuthority({ harnessDir: root }, input.workflow);
              return gate.ok
                ? ok(id, { phase: 6, gate })
                : refusalEnvelope({ command: id, status: "refused", code: gate.violations[0]?.code ?? "iteration.gate.blocked", exitCode: 1, message: "phase 6 post-merge close gate is blocked", details: { gate }, recovery: "Resolve the reported phase blockers, then run mstar status validate and mstar iteration gate --workflow <workflow-id> --compass <compass-path>." });
            }

            const compassPath = path.resolve(context.cwd, input.compass!);
            if (!existsSync(compassPath)) return refusalEnvelope({ command: id, status: "refused", code: "iteration.gate.compass-not-found", exitCode: 1, message: `compass file not found: ${compassPath}`, recovery: "The compass must exist at the reported path before mstar iteration gate --workflow <workflow-id> --compass <compass-path>." });
            const { readRegisteredWorkflowFromExecutionAuthority } = await import("@mstar-harness/engine");
            const snapshot = await readRegisteredWorkflowFromExecutionAuthority({ harnessDir: root }, input.workflow);
            if (snapshot === null) {
              return refusalEnvelope({ command: id, status: "refused", code: "iteration.gate.workflow-not-found", exitCode: 1, message: `workflow '${input.workflow}' not found in the registered execution authority`, recovery: "Run mstar status validate to inspect registered workflow IDs, select the intended workflow, then run mstar iteration gate --workflow <workflow-id> --compass <compass-path>." });
            }
            const gate = evaluatePhaseGate(snapshot, parseCompassFrontmatter(compassPath), {
              currentBranch: input.branch,
              specIntegrationBranch: input.integration,
              prBaseBranch: input.target,
            });
            return gate.ok
              ? ok(id, { transition: gate.transition, entry: gate.entry, exit: gate.exit })
              : refusalEnvelope({ command: id, status: "refused", code: gate.violations[0]?.code ?? "iteration.gate.blocked", exitCode: 1, message: "iteration phase gate is blocked", details: { gate }, recovery: "Resolve the reported phase blockers, then run mstar status validate and mstar iteration gate --workflow <workflow-id> --compass <compass-path>." });
          }
          const file = snapshotPath(context, input.workflow, input.harness);
          if (!existsSync(file)) return refusalEnvelope({ command: id, status: "refused", code: "iteration.gate.snapshot-not-found", exitCode: 1, message: `workflow snapshot not found: ${file}`, recovery: "The workflow snapshot must be restored at the reported path before mstar iteration gate --workflow <workflow-id> --compass <compass-path>." });
          const snapshot = readJson(file);
          if (phase6) {
            const root = harnessDir(context, input.harness);
            let rootDoc: unknown;
            try { const rootFile = path.join(root, "status.json"); if (existsSync(rootFile)) rootDoc = readJson(rootFile); } catch { rootDoc = undefined; }
            const gate = evaluatePostMergeClose(snapshot, rootDoc);
            return gate.ok ? ok(id, { phase: 6, gate }) : refusalEnvelope({ command: id, status: "refused", code: gate.violations[0]?.code ?? "iteration.gate.blocked", exitCode: 1, message: "phase 6 post-merge close gate is blocked", details: { gate }, recovery: "Resolve the reported phase blockers, then run mstar status validate and mstar iteration gate --workflow <workflow-id> --compass <compass-path>." });
          }
          const compassPath = path.resolve(context.cwd, input.compass!);
          if (!existsSync(compassPath)) return refusalEnvelope({ command: id, status: "refused", code: "iteration.gate.compass-not-found", exitCode: 1, message: `compass file not found: ${compassPath}`, recovery: "The compass must exist at the reported path before mstar iteration gate --workflow <workflow-id> --compass <compass-path>." });
          const gate = evaluatePhaseGate(snapshot, parseCompassFrontmatter(compassPath), { currentBranch: input.branch, specIntegrationBranch: input.integration, prBaseBranch: input.target });
          return gate.ok ? ok(id, { transition: gate.transition, entry: gate.entry, exit: gate.exit }) : refusalEnvelope({ command: id, status: "refused", code: gate.violations[0]?.code ?? "iteration.gate.blocked", exitCode: 1, message: "iteration phase gate is blocked", details: { gate }, recovery: "Resolve the reported phase blockers, then run mstar status validate and mstar iteration gate --workflow <workflow-id> --compass <compass-path>." });
        } catch (error) { return engineFailure(id, error, "iteration.gate.refused"); }
      },
    }),
    command({
      id: "iteration.push-cadence",
      cli: { path: ["iteration", "push-cadence"], aliases: [], arguments: [], options: [{ key: "ciRunning", flags: "--ci-running", required: false }, { key: "reviewWave", flags: "--review-wave", required: false }] },
      input: z.object({ ciRunning: z.boolean().optional(), reviewWave: z.boolean().optional() }), output, effects: ["validate"], description: "Probe whether CI and AI review activity permit a push.",
      async execute(input) {
        const id = "iteration.push-cadence";
        const gate = pushCadenceProbe(input.ciRunning === true, input.reviewWave === true);
        return gate.ok ? ok(id, { allowed: true, violations: [] }) : refusalEnvelope({ command: id, status: "refused", code: gate.violations[0]?.code ?? "iteration.push-cadence.blocked", exitCode: 1, message: "push blocked by active CI or review wave", details: { violations: gate.violations }, recovery: "Wait for the reported CI/review wave to settle, then run mstar iteration push-cadence." });
      },
    }),
  ];
}
