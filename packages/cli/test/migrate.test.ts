/**
 * CLI `mstar migrate` — the RETIRED verb.
 *
 * The v1-to-v2 file-staging writer is gone. `migrate` is now a mutation-free
 * refusal that names the supported replacement (`mstar store upgrade
 * --operator <name>`), so the CLI surface stays discoverable instead of
 * dropping the verb silently.
 *
 * The v1 fixture is the ENGINE's committed snapshot fixture
 * (`packages/engine/test/fixtures/migrate-real/` — the repo's single v1
 * fixture; CLI tests must not fork a second one).
 */
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readExecutionState, validateStatusV2 } from "@mstar-harness/engine";
import { resolveActiveWorkflow, resolveReadWorkflow } from "../../dsh/src/gates/workflow-selection.js";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
/** Reuse the engine's committed v1 snapshot fixture (single v1 source). */
const V1_FIXTURE = join(CLI_ROOT, "..", "engine", "test", "fixtures", "migrate-real");

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn env with ambient harness env vars pinned out: an ambient value must
 * never redirect a fixture.
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: opts.cwd ?? CLI_ROOT,
    env: { ...cliEnv(), ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function fixtureTree(): string {
  const root = mkdtempSync(join(tmpdir(), "migrate-cli-fixture-"));
  cpSync(V1_FIXTURE, root, { recursive: true });
  return root;
}

function treeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full.slice(root.length + 1));
    }
  };
  walk(root);
  return out.sort();
}

interface CliEnvelope {
  version: number;
  command: string;
  status: string;
  code: string;
  exitCode: number;
  message?: string;
  recovery?: string;
  details?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function envelopeOf(result: RunResult, status?: string, code?: string): CliEnvelope {
  const envelope = JSON.parse(result.stdout) as CliEnvelope;
  expect(envelope.version).toBe(1);
  expect(envelope.command).toBe("migrate");
  expect(envelope.exitCode).toBe(result.exitCode);
  if (status !== undefined) expect(envelope.status).toBe(status);
  if (code !== undefined) expect(envelope.code).toBe(code);
  return envelope;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function recoveryRecipe(message: string): string {
  const start = message.indexOf("mstar store upgrade --operator <name> --harness ");
  if (start < 0) throw new Error(`missing store-upgrade recipe in recovery message: ${message}`);
  const suffix = message.lastIndexOf(" for the control root");
  const end = suffix >= start ? suffix : message.lastIndexOf("`");
  if (end <= start) throw new Error(`missing complete store-upgrade recipe in recovery message: ${message}`);
  return message.slice(start, end).replace("<name>", "test-operator");
}

function runRecoveryRecipe(recipe: string): CliEnvelope {
  const result = execFileSync("/bin/sh", ["-c",
    `mstar() { ${shellQuote(process.execPath)} run ${shellQuote(SRC_ENTRY)} "$@"; }; ${recipe}`,
  ], { cwd: CLI_ROOT, env: cliEnv(), encoding: "utf8" });
  return JSON.parse(result) as CliEnvelope;
}

function fixtureBytes(root: string): Map<string, Buffer> {
  return new Map(treeFiles(root).map((file) => [file, readFileSync(join(root, file))]));
}

function hostileRoot(parent: string): string {
  return join(parent, "root $USER 'quote' $(printf injected) `printf injected`");
}

async function expectRecoveredFixture(root: string, original: Map<string, Buffer>, recipe: string, imported: boolean): Promise<void> {
  const envelope = runRecoveryRecipe(recipe);
  expect(envelope.status).toBe("ok");
  expect(envelope.command).toBe("store.upgrade");
  expect(envelope.data?.authorityState).toBe("active");
  if (!imported) expect(envelope.data?.imported).toBe(0);

  const state = await readExecutionState({ harnessDir: root });
  if (imported) {
    const legacy = JSON.parse(original.get("status.json")!.toString("utf8")) as {
      plans: { id: string; metadata?: { iteration_refs?: string[] } }[];
      metadata: { iteration_refs: string[] };
    };
    expect(state.data.root.workflows.map(({ id }) => id)).toEqual(legacy.metadata.iteration_refs);
    const expectedPlanIds = legacy.plans
      .filter((plan) => plan.metadata?.iteration_refs?.some((id) => legacy.metadata.iteration_refs.includes(id)))
      .map(({ id }) => id);
    const planIds = state.data.workflows.flatMap((workflow) => workflow.plans.map((row) => row.plan.id));
    expect(planIds.sort()).toEqual(expectedPlanIds.sort());
  } else {
    expect(state.data.workflows).toHaveLength(0);
  }
  for (const [file, bytes] of original) expect(readFileSync(join(root, file))).toEqual(bytes);
  const substitutedRoot = join(
    dirname(root),
    basename(root).replace("$USER", process.env.USER ?? "").replace("$(printf injected) `printf injected`", "injected injected"),
  );
  expect(existsSync(join(substitutedRoot, "store.db"))).toBe(false);
}

describe("mstar migrate — retired verb", () => {
  test("a v1 tree is refused without mutation", () => {
    const root = fixtureTree();
    try {
      const before = treeFiles(root);
      const result = runCli(["migrate", "--path", root]);
      expect(result.exitCode).toBe(1);
      envelopeOf(result, "refused", "migrate.verb-retired");
      expect(treeFiles(root)).toEqual(before);
      expect(existsSync(join(root, "archived", "status.v1.json"))).toBe(false);
      expect(existsSync(join(root, "workflows"))).toBe(false);
      expect(existsSync(join(root, "store.db"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses the same way with no path and keeps the verb discoverable", () => {
    const root = fixtureTree();
    try {
      const result = runCli(["migrate"], { cwd: root });
      expect(result.exitCode).toBe(1);
      envelopeOf(result, "refused", "migrate.verb-retired");
      const help = runCli(["migrate", "--help"], { cwd: root });
      expect(help.exitCode).toBe(0);
      expect(`${help.stdout}${help.stderr}`).toContain("migrate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovery recipes from retirement, engine, and Dsh consumers run the real CLI on their selected roots", async () => {
    const cases = [
      "retired-entry",
      "engine legacy-status",
      "Dsh legacy-status",
      "Dsh no-snapshot",
    ] as const;
    for (const recoveryCase of cases) {
      const parent = mkdtempSync(join(tmpdir(), `migrate-cli-${recoveryCase.replaceAll(" ", "-")}-`));
      const root = hostileRoot(parent);
      mkdirSync(root);
      try {
        if (recoveryCase === "Dsh no-snapshot") {
          writeFileSync(join(root, "status.json"), JSON.stringify({ version: 2, updated_at: "2026-10-13", workflows: [] }));
        } else {
          cpSync(V1_FIXTURE, root, { recursive: true });
        }
        const original = fixtureBytes(root);
        let recipe: string;
        if (recoveryCase === "retired-entry") {
          const refusal = runCli([
            "migrate",
            "--delivery-kind", "development",
            "--branch-source", "source",
            "--branch-target", "target",
            "--completion-policy", "complete",
            "--path", root,
          ]);
          expect(refusal.exitCode).toBe(1);
          const envelope = envelopeOf(refusal, "refused", "migrate.verb-retired");
          recipe = recoveryRecipe(envelope.message!);
        } else if (recoveryCase === "engine legacy-status") {
          const result = validateStatusV2(join(root, "status.json"));
          expect(result.ok).toBe(false);
          const violation = result.violations.find((entry) => entry.code === "status.migration-required");
          expect(violation).toBeDefined();
          recipe = recoveryRecipe(violation!.message);
        } else if (recoveryCase === "Dsh legacy-status") {
          const result = resolveActiveWorkflow(root);
          expect(result.kind).toBe("error");
          if (result.kind !== "error") throw new Error("expected legacy-status selection refusal");
          expect(result.code).toBe("status.migration-required");
          recipe = recoveryRecipe(result.message);
        } else {
          const result = resolveReadWorkflow(root);
          expect(result.kind).toBe("error");
          if (result.kind !== "error") throw new Error("expected missing-snapshot selection refusal");
          expect(result.code).toBe("workflow.selection.no-snapshot");
          recipe = recoveryRecipe(result.message);
        }
        await expectRecoveredFixture(root, original, recipe, recoveryCase !== "Dsh no-snapshot");
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  });
});
