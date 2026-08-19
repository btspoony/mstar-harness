/**
 * CLI `mstar migrate [--dry-run] [--path <root>] [--json]` — thin wrapper
 * over the engine v1 -> v2 migration planner/executor (`migrateHarnessTree`
 * / `applyMigratePlan`, engine P1 Task 6).
 *
 * Exit-code contract:
 * - 0 = ok, or idempotent no-op (root status.json already at schema v2)
 * - 1 = plan-invalid (planner refused: no/unrecognized v1 status.json,
 *   unliftable or duplicate plans[] rows, unsafe ids)
 * - 2 = apply-failure (executor threw mid-apply; the root v2 replacement
 *   is the commit point, so the v1 root stays intact for a re-run)
 *
 * `--dry-run` prints the ordered step plan (source -> destination) and
 * writes nothing; `--json` emits the machine-readable shape on stdout for
 * both success and failure paths.
 */
import { applyMigratePlan, migrateHarnessTree, type MigratePlan } from "@mstar-harness/engine";
import { resolve } from "node:path";
import pc from "picocolors";

export type MigrateCliOptions = {
  dryRun?: boolean;
  path?: string;
  json?: boolean;
};

export async function runMigrateCommand(options: MigrateCliOptions): Promise<void> {
  const root = options.path ? resolve(options.path) : process.cwd();

  let plan: MigratePlan;
  try {
    plan = migrateHarnessTree(root, { dryRun: options.dryRun === true });
  } catch (error) {
    const message = (error as Error).message;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, root, phase: "plan", exitCode: 1, error: message }));
    } else {
      console.error(pc.red(`migrate plan failed: ${message}`));
      console.error(
        "  hint: a valid tree has a v1 status.json under the root \u2014 run `mstar migrate --dry-run` to inspect the step plan",
      );
    }
    process.exitCode = 1;
    return;
  }

  if (plan.alreadyMigrated) {
    if (options.json) {
      console.log(
        JSON.stringify({
          ok: true,
          root,
          dryRun: plan.dryRun,
          alreadyMigrated: true,
          applied: false,
          message: plan.message,
          steps: plan.steps,
          migrationNotes: plan.migrationNotes,
        }),
      );
    } else {
      console.log(pc.yellow(`migrate: ${plan.message}`));
    }
    return;
  }

  if (plan.dryRun) {
    const header = `dry-run: ${plan.steps.length} steps planned (source \u2192 destination), zero writes`;
    if (options.json) {
      console.log(
        JSON.stringify({
          ok: true,
          root,
          dryRun: true,
          alreadyMigrated: false,
          applied: false,
          message: header,
          steps: plan.steps,
          migrationNotes: plan.migrationNotes,
        }),
      );
    } else {
      console.log(pc.cyan(`migrate: ${header}`));
      for (const step of plan.steps) {
        console.log(`  ${step.kind}: ${step.source} \u2192 ${step.destination}`);
      }
      for (const note of plan.migrationNotes) {
        console.log(pc.yellow(`  note: ${note}`));
      }
    }
    return;
  }

  try {
    const result = await applyMigratePlan(plan);
    if (options.json) {
      console.log(
        JSON.stringify({
          ok: true,
          root,
          dryRun: false,
          alreadyMigrated: false,
          applied: result.applied,
          message: result.message,
          steps: plan.steps,
          migrationNotes: plan.migrationNotes,
        }),
      );
    } else {
      console.log(pc.green(`migrate: ${result.message}`));
    }
  } catch (error) {
    const message = (error as Error).message;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, root, phase: "apply", exitCode: 2, error: message }));
    } else {
      console.error(pc.red(`migrate apply failed: ${message}`));
      console.error(
        "  hint: the root status.json was not replaced (the v2 replacement is the commit point) \u2014 fix the blocker and re-run",
      );
    }
    process.exitCode = 2;
  }
}
