/**
 * CLI `mstar status workflow-close` — the post-merge lifecycle close verb.
 *
 * Thin wrapper over engine `closeWorkflow` + `unregisterWorkflow` (P2 T2):
 * terminal snapshot write under the snapshot lock FIRST, then the idempotent
 * v2 root unregister. Contract pinned here:
 * - exit 0: fresh close (snapshot `completed` + `ended_at`, root entry
 *   removed, root still validates) and the fully-closed retry (already-closed
 *   notice, neither file rewritten, original `ended_at` kept).
 * - exit 1 gate/IO refusals before any write: missing snapshot (no workflow
 *   dir side effect), dangling integration merge lease, unfinished plan row;
 *   an unregister failure AFTER the durable snapshot write reports a partial
 *   close and a fixed-root retry finishes the unregister without changing
 *   `ended_at`.
 * - exit 2 usage: missing `--workflow`.
 *
 * Every case runs the real CLI as a subprocess against a temp fixture
 * harness — no live workflow is ever touched.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
const WORKFLOW_ID = "wf-close";

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

function closeArgs(harness: string, extra: string[] = []): string[] {
  return ["status", "workflow-close", "--workflow", WORKFLOW_ID, "--harness", harness, ...extra];
}

/** Minimal valid running snapshot whose single plan row is fully Done. */
function snapshotDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    id: WORKFLOW_ID,
    type: "plan",
    status: "running",
    started_at: "2026-08-01",
    updated_at: "2026-08-19",
    plans: [{ id: "plan-a", title: "Plan A", file: "plans/plan-a.md", status: "Done" }],
    ...overrides,
  };
}

/** Minimal v2 root doc with the given active entries. */
function rootDoc(workflows: unknown[] = []): Record<string, unknown> {
  return { version: 2, updated_at: "2026-08-19", workflows };
}

function rootEntry(): Record<string, unknown> {
  return { id: WORKFLOW_ID, type: "plan", started_at: "2026-08-01", dir: `workflows/${WORKFLOW_ID}` };
}

interface HarnessFixture {
  /** `null` — do not create the workflow snapshot (default: running snapshot). */
  snapshot?: Record<string, unknown> | null;
  /** `null` — do not write the root file (default: v2 root with the entry). */
  root?: Record<string, unknown> | null;
}

/** Temp harness with `workflows/<id>/snapshot.json` + `status.json` fixtures. */
function setupHarness(fn: (harness: string, paths: { snapshot: string; root: string }) => void, fixture: HarnessFixture = {}): void {
  const harness = mkdtempSync(join(tmpdir(), "mstar-workflow-close-"));
  try {
    const snapshot = join(harness, "workflows", WORKFLOW_ID, "snapshot.json");
    const root = join(harness, "status.json");
    if (fixture.snapshot !== null) {
      mkdirSync(join(harness, "workflows", WORKFLOW_ID), { recursive: true });
      writeFileSync(snapshot, JSON.stringify(fixture.snapshot ?? snapshotDoc(), null, 2));
    }
    if (fixture.root !== null) {
      writeFileSync(root, JSON.stringify(fixture.root ?? rootDoc([rootEntry()]), null, 2));
    }
    fn(harness, { snapshot, root });
  } finally {
    rmSync(harness, { recursive: true, force: true });
  }
}

describe("mstar status workflow-close", () => {
  test("fixture close writes the terminal snapshot and removes the root entry (exit 0)", () => {
    setupHarness((harness, { snapshot, root }) => {
      const result = runCli(closeArgs(harness, ["--ended-at", "2026-09-12"]));
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const doc = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(doc.status).toBe("completed");
      expect(doc.ended_at).toBe("2026-09-12");
      expect(doc.updated_at).toBe("2026-09-12");
      expect((doc.plans as Array<Record<string, unknown>>).every((row) => row.status === "Done")).toBe(true);

      const rootAfter = JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>;
      expect(rootAfter.workflows).toEqual([]);

      // Fresh close (not the already-closed notice).
      expect(result.stdout).toContain(`workflow-close: ${WORKFLOW_ID} closed (status completed, ended_at 2026-09-12)`);

      // Product contract: the unregistered root still validates (exit 0).
      const validate = runCli(["status", "validate", root]);
      expect(validate.exitCode).toBe(0);
    });
  });

  test("dangling integration merge lease refuses before write (exit 1, bytes unchanged)", () => {
    setupHarness(
      (harness, { snapshot, root }) => {
        const beforeSnapshot = readFileSync(snapshot, "utf8");
        const beforeRoot = readFileSync(root, "utf8");

        const result = runCli(closeArgs(harness, ["--ended-at", "2026-09-12"]));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("terminal-dangling-merge-lease");

        // Before-write refusal preserves bytes (snapshot AND root — the
        // unregister never runs when the close refuses).
        expect(readFileSync(snapshot, "utf8")).toBe(beforeSnapshot);
        expect(readFileSync(root, "utf8")).toBe(beforeRoot);
      },
      {
        snapshot: snapshotDoc({
          integration_merge_lease: {
            holder: "pm",
            claimed_at: "2026-08-19",
            plan_id: "plan-a",
            source_branch: "feature/plan-a",
            target_branch: "main",
          },
        }),
      },
    );
  });

  test("unfinished plan row refuses before write (exit 1, bytes unchanged)", () => {
    setupHarness(
      (harness, { snapshot, root }) => {
        const beforeSnapshot = readFileSync(snapshot, "utf8");
        const beforeRoot = readFileSync(root, "utf8");

        const result = runCli(closeArgs(harness));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("every plan row must be Done");

        expect(readFileSync(snapshot, "utf8")).toBe(beforeSnapshot);
        expect(readFileSync(root, "utf8")).toBe(beforeRoot);
      },
      {
        snapshot: snapshotDoc({
          plans: [{ id: "plan-a", title: "Plan A", file: "plans/plan-a.md", status: "InProgress" }],
        }),
      },
    );
  });

  test("missing snapshot refuses without side effects (exit 1)", () => {
    setupHarness(
      (harness, { snapshot }) => {
        const result = runCli(["status", "workflow-close", "--workflow", "wf-missing", "--harness", harness]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("workflow snapshot not found");
        // No snapshot, no dir side effect for the unknown id.
        expect(existsSync(snapshot)).toBe(false);
        expect(existsSync(join(harness, "workflows", "wf-missing"))).toBe(false);
      },
      { snapshot: null, root: null },
    );
  });

  test("fully closed retry rewrites nothing and keeps ended_at (exit 0, already closed)", () => {
    setupHarness(
      (harness, { snapshot, root }) => {
        const beforeSnapshot = readFileSync(snapshot, "utf8");
        const beforeRoot = readFileSync(root, "utf8");

        // No --ended-at: the default (today) must NOT reach the files.
        const result = runCli(closeArgs(harness));
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`workflow-close: ${WORKFLOW_ID} already closed`);

        // Neither file is rewritten — the original terminal timestamps stay.
        expect(readFileSync(snapshot, "utf8")).toBe(beforeSnapshot);
        expect(readFileSync(root, "utf8")).toBe(beforeRoot);
        const doc = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
        expect(doc.ended_at).toBe("2026-09-01");
      },
      {
        snapshot: snapshotDoc({ status: "completed", updated_at: "2026-09-01", ended_at: "2026-09-01" }),
        root: rootDoc(),
      },
    );
  });

  test("unregister failure reports a partial close; the retry finishes it without changing ended_at", () => {
    setupHarness((harness, { snapshot, root }) => {
      // Round 1: a v1 root refuses the unregister — the snapshot close is
      // already durable, so the failure must surface as a partial close and
      // the root bytes must be preserved.
      const v1Root = JSON.stringify({ version: 1, updated_at: "2026-08-19", plans: [] }, null, 2);
      writeFileSync(root, v1Root);
      const partial = runCli(closeArgs(harness, ["--ended-at", "2026-09-12"]));
      expect(partial.exitCode).toBe(1);
      expect(partial.stderr).toContain("partial close");

      const afterPartial = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(afterPartial.status).toBe("completed");
      expect(afterPartial.ended_at).toBe("2026-09-12");
      expect(readFileSync(root, "utf8")).toBe(v1Root);

      // Round 2: the root is migrated (v2 + the stale entry); the retry only
      // finishes the unregister — a DIFFERENT --ended-at must not touch the
      // already-terminal snapshot.
      writeFileSync(root, JSON.stringify(rootDoc([rootEntry()]), null, 2));
      const retry = runCli(closeArgs(harness, ["--ended-at", "2026-09-20"]));
      expect(retry.exitCode).toBe(0);
      expect(retry.stdout).toContain(`workflow-close: ${WORKFLOW_ID} already closed`);
      expect(retry.stdout).toContain(`unregistered ${WORKFLOW_ID}`);

      const docAfter = JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, unknown>;
      expect(docAfter.ended_at).toBe("2026-09-12");
      expect(docAfter.updated_at).toBe("2026-09-12");
      const rootAfter = JSON.parse(readFileSync(root, "utf8")) as Record<string, unknown>;
      expect(rootAfter.workflows).toEqual([]);
    });
  });

  test("missing --workflow is a usage error (exit 2)", () => {
    setupHarness((harness) => {
      const result = runCli(["status", "workflow-close", "--harness", harness]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage");
    });
  });
});

/**
 * CLI `mstar iteration gate --phase 6` — the additive post-merge close
 * local-state gate form (P2 T4). Thin wrapper over engine
 * `evaluatePostMergeClose`: no `--compass` required (standalone plans have
 * none); exit 0 pass / 1 gate fail or error / 2 usage. The Phase 2–5
 * transition form (requires `--compass`) is pinned unchanged in the last
 * test. Every case runs the real CLI as a subprocess against a temp fixture
 * harness — no live workflow is ever touched.
 */
describe("mstar iteration gate --phase 6", () => {
  const gateArgs = (harness: string, workflow = WORKFLOW_ID): string[] =>
    ["iteration", "gate", "--phase", "6", "--workflow", workflow, "--harness", harness];

  test("closed + unregistered standalone plan passes without --compass (exit 0)", () => {
    setupHarness(
      (harness) => {
        const result = runCli(gateArgs(harness));
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("phase 6 (post-merge close): OK");
      },
      {
        snapshot: snapshotDoc({ status: "completed", ended_at: "2026-09-12", updated_at: "2026-09-12" }),
        root: rootDoc(),
      },
    );
  });

  test("running snapshot (close not yet run) → exit 1 with PHASE6_NOT_TERMINAL", () => {
    setupHarness((harness) => {
      const result = runCli(gateArgs(harness));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("PHASE6_NOT_TERMINAL");
    });
  });

  test("root entry still registered → exit 1 with PHASE6_ROOT_ENTRY_PRESENT", () => {
    setupHarness(
      (harness) => {
        const result = runCli(gateArgs(harness));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("PHASE6_ROOT_ENTRY_PRESENT");
      },
      { snapshot: snapshotDoc({ status: "completed", ended_at: "2026-09-12", updated_at: "2026-09-12" }) },
    );
  });

  test("dangling integration merge lease → exit 1 with PHASE6_DANGLING_LEASE", () => {
    setupHarness(
      (harness) => {
        const result = runCli(gateArgs(harness));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("PHASE6_DANGLING_LEASE");
      },
      {
        snapshot: snapshotDoc({
          status: "completed",
          ended_at: "2026-09-12",
          updated_at: "2026-09-12",
          integration_merge_lease: {
            holder: "pm",
            claimed_at: "2026-08-19",
            plan_id: "plan-a",
            source_branch: "feature/plan-a",
            target_branch: "main",
          },
        }),
        root: rootDoc(),
      },
    );
  });

  test("missing snapshot file refuses (exit 1)", () => {
    setupHarness(
      (harness) => {
        const result = runCli(gateArgs(harness, "wf-missing"));
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("workflow snapshot not found");
      },
      { snapshot: null, root: null },
    );
  });

  test("unsupported --phase value is a usage error (exit 2)", () => {
    setupHarness((harness) => {
      const result = runCli(["iteration", "gate", "--phase", "5", "--workflow", WORKFLOW_ID, "--harness", harness]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage");
    });
  });

  test("existing transition form is intact: --compass still required (exit 2 without it) and the evaluation still exits 0/1", () => {
    setupHarness(
      (harness) => {
        const compassPath = join(harness, "delivery-compass.md");
        writeFileSync(
          compassPath,
          "---\niteration_id: v9.9.9\nstart_date: 2026-08-01\nstatus: active\niteration_base_branch: main\ntarget_branch: main\nplans:\n  - plan-a\n---\n",
          "utf8",
        );
        // Running plan row → phase-2-execute verdict, gate passes (exit 0).
        const okRun = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--compass", compassPath, "--harness", harness]);
        expect(okRun.exitCode).toBe(0);
        expect(okRun.stdout).toContain("transition: phase-2-execute");

        // Phase 2–5 form without --compass → usage error (exit 2).
        const noCompass = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", harness]);
        expect(noCompass.exitCode).toBe(2);
        expect(noCompass.stderr).toContain("usage");
      },
      {
        snapshot: snapshotDoc({
          plans: [{ id: "plan-a", title: "Plan A", file: "plans/plan-a.md", status: "InProgress" }],
        }),
      },
    );
  });
});
