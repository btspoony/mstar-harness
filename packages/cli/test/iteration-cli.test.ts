/**
 * CLI `mstar iteration gate|push-cadence` — engine-backed wrappers.
 *
 * `gate` parses status.json + delivery-compass.md frontmatter, evaluates
 * `iteration.evaluatePhaseGate`, prints the transition and both checklists,
 * and exits 1 when the engine gate verdict fails (`result.ok === false`).
 * `push-cadence` wraps `iteration.pushCadenceProbe` (§5.1a) — exit 1 when
 * CI or an AI review wave blocks the push.
 *
 * Each case runs the real CLI as a subprocess against temp fixtures.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");

/** Compass frontmatter: active iteration (no end_date) with two plans. */
const COMPASS_ACTIVE = `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans:
  - plan-a
  - plan-b
---

# v9.9.9 Delivery Compass
`;

/** Compass frontmatter: closed iteration (status completed + end_date). */
const COMPASS_COMPLETED = `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: completed
end_date: 2026-08-08
iteration_base_branch: main
target_branch: main
plans:
  - plan-a
  - plan-b
---

# v9.9.9 Delivery Compass
`;

function statusFixture(planStatuses: Array<[string, string]>): string {
  return JSON.stringify(
    {
      version: 1,
      updated_at: "2026-08-08",
      plans: planStatuses.map(([id, status]) => ({ id, status })),
      residual_findings: {},
    },
    null,
    2,
  );
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn env with ambient MSTAR_HARNESS_DIR pinned out (qc3 F-4). */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR") continue;
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

/** Temp root with status.json + delivery-compass.md fixtures written in. */
function withFixtures(fn: (dir: string, statusPath: string, compassPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mstar-iteration-cli-"));
  try {
    const statusPath = join(dir, "status.json");
    const compassPath = join(dir, "delivery-compass.md");
    writeFileSync(statusPath, statusFixture([["plan-a", "Todo"], ["plan-b", "Todo"]]));
    writeFileSync(compassPath, COMPASS_ACTIVE);
    fn(dir, statusPath, compassPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("mstar iteration gate — phase-transition evaluation", () => {
  test("plans not all Done → phase-2-execute, exit 0 (gate passes, keep executing)", () => {
    withFixtures((_dir, statusPath, compassPath) => {
      const result = runCli(["iteration", "gate", "--status", statusPath, "--compass", compassPath]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("transition: phase-2-execute");
      // Entry checklist reports the still-executing plans (expected mid-run);
      // only the gate verdict (result.ok) drives the exit code.
      expect(result.stderr).toContain("PLAN_NOT_DONE");
    });
  });

  test("all plans Done + active compass → phase-3-close required, exit 1 with exit-checklist violations", () => {
    withFixtures((dir, statusPath, compassPath) => {
      writeFileSync(statusPath, statusFixture([["plan-a", "Done"], ["plan-b", "Done"]]));
      const result = runCli(["iteration", "gate", "--status", statusPath, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("transition: phase-3-close");
      expect(result.stderr).toContain("EXIT_STATUS_NOT_COMPLETED");
      expect(result.stderr).toContain("EXIT_END_DATE_REQUIRED");
    });
  });

  test("all plans Done + completed compass + full probes → phase-4-pr-delivery, exit 0", () => {
    withFixtures((dir, statusPath, compassPath) => {
      writeFileSync(statusPath, statusFixture([["plan-a", "Done"], ["plan-b", "Done"]]));
      writeFileSync(compassPath, COMPASS_COMPLETED);
      const result = runCli([
        "iteration", "gate",
        "--status", statusPath,
        "--compass", compassPath,
        "--branch", "iteration/v9.9.9",
        "--integration", "iteration/v9.9.9",
        "--target", "main",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("transition: phase-4-pr-delivery");
      expect(result.stdout).toContain("entry (close §3.1): OK");
      expect(result.stdout).toContain("exit (close §3.5): OK");
      expect(result.stderr).toBe("");
    });
  });

  test("compass-registered plan missing from status.json → phase-2-execute with entry violation printed", () => {
    withFixtures((_dir, statusPath, compassPath) => {
      writeFileSync(statusPath, statusFixture([["plan-a", "Todo"]]));
      const result = runCli(["iteration", "gate", "--status", statusPath, "--compass", compassPath]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("transition: phase-2-execute");
      expect(result.stderr).toContain("PLAN_NOT_IN_STATUS");
      expect(result.stderr).toContain("plan-b");
    });
  });

  test("plans: [] flow-style empty array → gate runs without PLAN_NOT_IN_STATUS noise", () => {
    withFixtures((_dir, statusPath, compassPath) => {
      writeFileSync(
        compassPath,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans: []
---
`,
      );
      const result = runCli(["iteration", "gate", "--status", statusPath, "--compass", compassPath]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("transition: phase-2-execute");
      // Parsed as an empty array: the frontmatter schema accepts it, and the
      // only report is the accurate COMPASS_NO_PLANS — no string-misparse
      // COMPASS_INVALID_FIELD and no per-plan PLAN_NOT_IN_STATUS noise.
      expect(result.stderr).toContain("COMPASS_NO_PLANS");
      expect(result.stderr).not.toContain("COMPASS_INVALID_FIELD");
      expect(result.stderr).not.toContain("PLAN_NOT_IN_STATUS");
    });
  });

  test("plans: [a, b] flow-style array → gate checks those plan ids", () => {
    withFixtures((_dir, statusPath, compassPath) => {
      writeFileSync(
        compassPath,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans: [plan-a, plan-b]
---
`,
      );
      const result = runCli(["iteration", "gate", "--status", statusPath, "--compass", compassPath]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("transition: phase-2-execute");
      // Parsed as ["plan-a", "plan-b"]: both ids are looked up in status.json
      // and reported as still-executing (PLAN_NOT_DONE) — not lost to a
      // scalar misparse (COMPASS_NO_PLANS / COMPASS_INVALID_FIELD).
      expect(result.stderr).toContain("PLAN_NOT_DONE");
      expect(result.stderr).toContain("plan-a");
      expect(result.stderr).toContain("plan-b");
      expect(result.stderr).not.toContain("COMPASS_NO_PLANS");
      expect(result.stderr).not.toContain("COMPASS_INVALID_FIELD");
      expect(result.stderr).not.toContain("PLAN_NOT_IN_STATUS");
    });
  });

  test("plans: [\"hello, world\"] → exit 1: comma inside quotes is ambiguous, not split", () => {
    withFixtures((_dir, statusPath, compassPath) => {
      writeFileSync(
        compassPath,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans: ["hello, world"]
---
`,
      );
      const result = runCli(["iteration", "gate", "--status", statusPath, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ambiguous flow-style array");
      expect(result.stderr).toContain("quoted item containing comma");
      // The quote-aware guard must fire before the naive split — the gate
      // never runs, so no plan lookups for a misparsed ["hello","world"].
      expect(result.stderr).not.toContain("PLAN_NOT_IN_STATUS");
      expect(result.stderr).not.toContain("PLAN_NOT_DONE");
    });
  });

  test("plans: [\"a, b\", \"c\"] → exit 1: first quoted item's comma is ambiguous", () => {
    withFixtures((_dir, statusPath, compassPath) => {
      writeFileSync(
        compassPath,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans: ["a, b", "c"]
---
`,
      );
      const result = runCli(["iteration", "gate", "--status", statusPath, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("ambiguous flow-style array");
      expect(result.stderr).toContain("quoted item containing comma");
      expect(result.stderr).not.toContain("PLAN_NOT_IN_STATUS");
    });
  });

  test("plans: [[a]] → exit 1: nested flow-style array rejected", () => {
    withFixtures((_dir, statusPath, compassPath) => {
      writeFileSync(
        compassPath,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans: [[a]]
---
`,
      );
      const result = runCli(["iteration", "gate", "--status", statusPath, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("nested flow-style array");
    });
  });

  test("plans: [\"ok\"] → quoted item without comma parses to [\"ok\"]", () => {
    withFixtures((_dir, statusPath, compassPath) => {
      writeFileSync(
        compassPath,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans: ["ok"]
---
`,
      );
      const result = runCli(["iteration", "gate", "--status", statusPath, "--compass", compassPath]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("transition: phase-2-execute");
      // Parsed as ["ok"]: the plan id is looked up in status.json and
      // reported as missing (PLAN_NOT_IN_STATUS) — not a scalar misparse.
      expect(result.stderr).toContain("PLAN_NOT_IN_STATUS");
      expect(result.stderr).toContain("ok");
      expect(result.stderr).not.toContain("COMPASS_NO_PLANS");
      expect(result.stderr).not.toContain("COMPASS_INVALID_FIELD");
    });
  });

  test("missing status file → exit 1 with precise message", () => {
    withFixtures((dir, _statusPath, compassPath) => {
      const result = runCli(["iteration", "gate", "--status", join(dir, "nope.json"), "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("status file not found");
    });
  });

  test("compass without frontmatter fence → exit 1 with precise message", () => {
    withFixtures((_dir, statusPath, compassPath) => {
      writeFileSync(compassPath, "# no frontmatter here\n");
      const result = runCli(["iteration", "gate", "--status", statusPath, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no YAML frontmatter fence");
    });
  });
});

describe("mstar iteration push-cadence — §5.1a push gate", () => {
  test("no flags (CI idle, no review wave) → push allowed, exit 0", () => {
    const result = runCli(["iteration", "push-cadence"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("push allowed");
    expect(result.stderr).toBe("");
  });

  test("--ci-running → push blocked (PUSH_BLOCKED_CI), exit 1", () => {
    const result = runCli(["iteration", "push-cadence", "--ci-running"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("PUSH_BLOCKED_CI");
    expect(result.stderr).not.toContain("PUSH_BLOCKED_REVIEW_WAVE");
  });

  test("--review-wave → push blocked (PUSH_BLOCKED_REVIEW_WAVE), exit 1", () => {
    const result = runCli(["iteration", "push-cadence", "--review-wave"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("PUSH_BLOCKED_REVIEW_WAVE");
    expect(result.stderr).not.toContain("PUSH_BLOCKED_CI");
  });

  test("both flags → blocked with both violations, exit 1", () => {
    const result = runCli(["iteration", "push-cadence", "--ci-running", "--review-wave"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("PUSH_BLOCKED_CI");
    expect(result.stderr).toContain("PUSH_BLOCKED_REVIEW_WAVE");
  });
});
