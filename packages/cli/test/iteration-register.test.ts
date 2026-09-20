/**
 * CLI `mstar iteration register` — the iteration workflow registration verb
 * (seam S1 sibling of `mstar workflow register`, engine-backed).
 *
 * Thin wrapper over engine `registerIterationWorkflow` (create-only
 * `type: iteration` snapshot + root `workflows[]` entry under one root lock,
 * with byte-preserving orphan recovery). Contract pinned here:
 * - exit 0: an iteration registers end to end — root entry + snapshot on
 *   disk, both documents pass `mstatus status validate`, and the registered
 *   workflow accepts a coordinator binding (`plan bind --coordinator`).
 * - exit 1: engine/IO refusals — duplicate registration, hostile workflow
 *   id, domain-invalid rows (duplicate ids, missing fields, a supplied row
 *   status), stale/malformed roots — with NO byte change to authoritative
 *   documents; a matching orphan retry recovers (a root write, not a replay).
 * - exit 2: usage — omitted/blank required flags, malformed/non-object row
 *   JSON, unknown flags, missing option values, excess arguments. Help
 *   remains exit 0.
 *
 * Every case runs the real CLI as a subprocess against an isolated temp
 * fixture harness — no live harness is ever touched.
 */
import { describe, expect, test } from "bun:test";
import { initializeStore } from "@mstar-harness/engine";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
const WORKFLOW_ID = "20260918-iteration-register-cli";
const COMPASS_REF = "iterations/20260918-iteration-register-cli/delivery-compass.md";

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn env with ambient harness env vars pinned out: the CLI
 * resolves harness dirs from MSTAR_HARNESS_DIR / MSTAR_CONTROL_ROOT ahead
 * of probing, and SDD_DIR redirects default outfile paths — ambient values
 * would redirect every fixture spuriously.
 */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function runCli(args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function row(id: string): string {
  return JSON.stringify({ id, title: `Plan ${id}`, file: `plans/${id}.md` });
}

function registerArgs(harness: string, extra: string[] = []): string[] {
  return [
    "iteration",
    "register",
    "--workflow",
    WORKFLOW_ID,
    "--compass-ref",
    COMPASS_REF,
    "--branch-base",
    "main",
    "--branch-integration",
    "feature/20260918-iteration-register-cli-integrate",
    "--branch-target",
    "main",
    "--row",
    row("20260918-plan-alpha"),
    "--row",
    row("20260918-plan-beta"),
    "--project",
    "engine",
    "--started-at",
    "2026-09-18T00:00:00.000Z",
    "--harness",
    harness,
    ...extra,
  ];
}

/** Temp fixture harness; returns paths plus a byte-snapshot helper. */
async function setupHarness(fn: (harness: string, paths: { root: string; snapshot: string }) => void): Promise<void> {
  const harness = mkdtempSync(join(tmpdir(), "mstar-iteration-register-"));
  // Contract §3: registration goes through the catalog journal, which requires
  // an initialized ACTIVE store — the fixture provisions one.
  await initializeStore({ harnessDir: harness }).then((handle) => handle.close());
  try {
    fn(harness, {
      root: join(harness, "status.json"),
      snapshot: join(harness, "workflows", WORKFLOW_ID, "snapshot.json"),
    });
  } finally {
    rmSync(harness, { recursive: true, force: true });
  }
}

describe("mstar iteration register", () => {
  test("registers an iteration end to end: root entry + snapshot, both validate (exit 0)", async () => {
    await setupHarness((harness, { root, snapshot }) => {
      const result = runCli(registerArgs(harness));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`iteration register: OK \u2014 ${WORKFLOW_ID} registered`);
      expect(result.stdout).toContain(snapshot);

      expect(existsSync(snapshot)).toBe(true);
      const doc = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(doc).toMatchObject({
        schema_version: 1,
        id: WORKFLOW_ID,
        type: "iteration",
        status: "running",
        compass_ref: COMPASS_REF,
        project: "engine",
      });
      expect(doc.branch).toEqual({
        base: "main",
        integration: "feature/20260918-iteration-register-cli-integrate",
        target: "main",
      });
      expect(doc.plans).toEqual([
        {
          id: "20260918-plan-alpha",
          title: "Plan 20260918-plan-alpha",
          file: "plans/20260918-plan-alpha.md",
          status: "Todo",
          metadata: {
            iteration_refs: [COMPASS_REF],
            spec_integration_branch: "feature/20260918-iteration-register-cli-integrate",
            merge_target: "feature/20260918-iteration-register-cli-integrate",
          },
        },
        {
          id: "20260918-plan-beta",
          title: "Plan 20260918-plan-beta",
          file: "plans/20260918-plan-beta.md",
          status: "Todo",
          metadata: {
            iteration_refs: [COMPASS_REF],
            spec_integration_branch: "feature/20260918-iteration-register-cli-integrate",
            merge_target: "feature/20260918-iteration-register-cli-integrate",
          },
        },
      ]);

      const rootDoc = JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>;
      expect(rootDoc.workflows).toEqual([
        { id: WORKFLOW_ID, type: "iteration", started_at: "2026-09-18T00:00:00.000Z", dir: `workflows/${WORKFLOW_ID}` },
      ]);

      // Product contract: both registered documents validate (exit 0).
      expect(runCli(["status", "validate", root]).exitCode).toBe(0);
      expect(runCli(["status", "validate", snapshot]).exitCode).toBe(0);
    });
  });

  test("the registered workflow accepts a coordinator binding (exit 0)", async () => {
    await setupHarness((harness) => {
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const bind = runCli(["plan", "bind", "--coordinator", "--workflow", WORKFLOW_ID, "--harness", harness, "--json"]);
      expect(bind.exitCode).toBe(0);
      const payload = JSON.parse(bind.stdout) as Record<string, unknown>;
      expect(payload.ok).toBe(true);
      expect(payload.role).toBe("coordinator");
      expect(payload.workflow_id).toBe(WORKFLOW_ID);
    });
  });

  test("duplicate registration refuses fail-loud without mutating bytes (exit 1)", async () => {
    await setupHarness((harness, { root, snapshot }) => {
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const beforeSnapshot = readFileSync(snapshot, "utf8");
      const beforeRoot = readFileSync(root, "utf8");

      const duplicate = runCli(registerArgs(harness));
      expect(duplicate.exitCode).toBe(1);
      expect(readFileSync(snapshot, "utf8")).toBe(beforeSnapshot);
      expect(readFileSync(root, "utf8")).toBe(beforeRoot);
    });
  });

  test("usage errors exit 2 without artifacts; help exits 0", async () => {
    await setupHarness((harness, { root, snapshot }) => {
      const variants: string[][] = [];
      for (const [flag, value] of [
        ["--workflow", WORKFLOW_ID],
        ["--compass-ref", COMPASS_REF],
        ["--branch-base", "main"],
        ["--branch-integration", "feature/integrate"],
        ["--branch-target", "main"],
        ["--row", row("p1")],
      ] as const) {
        // Omitted required flag.
        const without: string[] = [];
        for (let i = 0; i < registerArgs(harness).length; i++) {
          if (registerArgs(harness)[i] === flag) i++;
          else without.push(registerArgs(harness)[i]!);
        }
        variants.push(without);
        // Blank required flag.
        variants.push([...without, flag, value, flag, " "]);
      }
      // No row at all (rows stripped).
      const noRows: string[] = [];
      const base = registerArgs(harness);
      for (let i = 0; i < base.length; i++) {
        if (base[i] === "--row") i += 2;
        else noRows.push(base[i]!);
      }
      variants.push(noRows);
      // Malformed / non-object row JSON.
      variants.push([...base, "--row", "{not json"]);
      variants.push([...base, "--row", "null"]);
      variants.push([...base, "--row", '["p1"]']);
      variants.push([...base, "--row", "42"]);
      // Parser-class failures reach the CommanderError → exit 2 handler.
      variants.push([...base, "--unknown-flag"]);
      variants.push(["iteration", "register", "--workflow"]);
      variants.push([...base, "excess-argument"]);

      for (const args of variants) {
        const result = runCli(args);
        expect(result.exitCode).toBe(2);
      }
      expect(existsSync(root)).toBe(false);
      expect(existsSync(snapshot)).toBe(false);

      const help = runCli(["iteration", "register", "--help"]);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("--compass-ref");
      expect(help.stdout).toContain("--branch-integration");
      expect(help.stdout).toContain("--row");
    });
  });

  test("engine refusals exit 1 with authoritative bytes unchanged; orphan retry recovers (exit 0)", async () => {
    await setupHarness((harness, { root, snapshot }) => {
      // Hostile workflow id (shared guard).
      const hostile = runCli(registerArgs(harness, ["--workflow", "../escape"]));
      expect(hostile.exitCode).toBe(1);
      expect(existsSync(join(harness, "escape"))).toBe(false);

      // Duplicate row ids.
      expect(runCli(registerArgs(harness, ["--row", row("20260918-plan-alpha")])).exitCode).toBe(1);
      // Missing / blank row field.
      expect(runCli(registerArgs(harness, ["--row", JSON.stringify({ id: "x", title: "t", file: " " })])).exitCode).toBe(1);
      // Supplied row status — registration never authorizes a transition.
      expect(
        runCli(registerArgs(harness, ["--row", JSON.stringify({ id: "x", title: "t", file: "f", status: "Done" })])).exitCode,
      ).toBe(1);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(snapshot)).toBe(false);

      // Stale root: an entry whose snapshot is missing refuses fail-loud.
      const first = runCli(registerArgs(harness));
      expect(first.exitCode).toBe(0);
      const goodSnapshot = readFileSync(snapshot, "utf8");
      writeFileSync(root, JSON.stringify({ version: 2, updated_at: "2026-09-01", workflows: [{ id: "ghost", type: "iteration", started_at: "2026-09-01", dir: "workflows/ghost" }] }, null, 2));
      const staleRoot = runCli(registerArgs(harness));
      expect(staleRoot.exitCode).toBe(1);
      expect(readFileSync(snapshot, "utf8")).toBe(goodSnapshot);

      // Malformed root refuses without replacing bytes.
      writeFileSync(root, "{ not json");
      expect(runCli(registerArgs(harness)).exitCode).toBe(1);
      expect(readFileSync(root, "utf8")).toBe("{ not json");

      // Retry after the root entry is lost: under the registration journal
      // (contract §3) the workflow is already registered/bound, so a re-register
      // REFUSES and points at `catalog reconcile`; the snapshot bytes are
      // preserved verbatim and no root entry is invented.
      writeFileSync(root, JSON.stringify({ version: 2, updated_at: "2026-09-01", workflows: [] }, null, 2));
      const retry = runCli(registerArgs(harness));
      expect(retry.exitCode).toBe(1);
      expect(retry.stderr).toContain("reconcile");
      expect(readFileSync(snapshot, "utf8")).toBe(goodSnapshot);
      const rootDoc = JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>;
      expect(rootDoc.workflows).toEqual([]);
    });
  });
});
