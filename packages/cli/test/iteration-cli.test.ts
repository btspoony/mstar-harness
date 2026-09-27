/**
 * CLI `mstar iteration gate|push-cadence` — engine-backed wrappers.
 *
 * `gate` resolves `--workflow <id>` to `{HARNESS_DIR}/workflows/<id>/snapshot.json`,
 * parses delivery-compass.md frontmatter, evaluates
 * `iteration.evaluatePhaseGate`, prints the transition and both checklists,
 * and exits 1 when the engine gate verdict fails (`result.ok === false`).
 * `push-cadence` wraps `iteration.pushCadenceProbe` (§5.1a) — exit 1 when
 * CI or an AI review wave blocks the push.
 *
 * Each case runs the real CLI as a subprocess against temp fixtures.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
const WORKFLOW_ID = "v9-9-9";

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

function snapshotFixture(planStatuses: Array<[string, string]>): string {
  return JSON.stringify(
    {
      schema_version: 1,
      id: WORKFLOW_ID,
      type: "iteration",
      status: "running",
      started_at: "2026-08-01",
      updated_at: "2026-08-08",
      plans: planStatuses.map(([id, status]) => ({ id, status })),
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

interface CommandEnvelope {
  version: number;
  command: string;
  status: "ok" | "refused" | "usage" | "error";
  code: string;
  exitCode: number;
  message?: string;
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

function envelope(result: RunResult): CommandEnvelope {
  return JSON.parse(result.stdout) as CommandEnvelope;
}

function message(result: RunResult): string {
  return envelope(result).message ?? "";
}

function data(result: RunResult): Record<string, unknown> {
  return envelope(result).data ?? {};
}

type GateViolation = { code: string; message?: string };

function violations(result: RunResult): GateViolation[] {
  const response = envelope(result);
  const sources = [response.data?.entry, response.data?.exit, response.data?.gate, response.details?.gate, response.details];
  return sources.flatMap((source) => {
    if (!source || typeof source !== "object" || !Array.isArray((source as { violations?: unknown }).violations)) return [];
    return (source as { violations: unknown[] }).violations.flatMap((violation) =>
      violation && typeof violation === "object" && typeof (violation as { code?: unknown }).code === "string"
        ? [violation as GateViolation]
        : []);
  });
}

function violationCodes(result: RunResult): string[] {
  return violations(result).map(({ code }) => code);
}

function violationMessages(result: RunResult): string[] {
  return violations(result).flatMap(({ message: text }) => typeof text === "string" ? [text] : []);
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

/** Temp root with workflows/<id>/snapshot.json + delivery-compass.md fixtures written in. */
function withFixtures(fn: (dir: string, snapshotPath: string, compassPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "mstar-iteration-cli-"));
  try {
    const workflowDir = join(dir, "workflows", WORKFLOW_ID);
    mkdirSync(workflowDir, { recursive: true });
    const snapshotPath = join(workflowDir, "snapshot.json");
    const compassPath = join(dir, "delivery-compass.md");
    writeFileSync(snapshotPath, snapshotFixture([["plan-a", "Todo"], ["plan-b", "Todo"]]));
    writeFileSync(compassPath, COMPASS_ACTIVE);
    fn(dir, snapshotPath, compassPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The `--workflow` flag form used by every gate invocation. */
function gateArgs(dir: string, compassPath: string, extra: string[] = []): string[] {
  return ["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath, ...extra];
}

describe("Phase-5 F1 — custom `.mstarc` workflow_dir (Bugbot b1f402ec)", () => {
  test("iteration gate reads the snapshot at the DECLARED layout location", () => {
    const dir = mkdtempSync(join(tmpdir(), "mstar-iteration-cli-custom-"));
    try {
      writeFileSync(join(dir, ".mstarc"), "[config]\nworkflow_dir=custom-wf\n", "utf8");
      const workflowDir = join(dir, "custom-wf", WORKFLOW_ID);
      mkdirSync(workflowDir, { recursive: true });
      const snapshotPath = join(workflowDir, "snapshot.json");
      const compassPath = join(dir, "delivery-compass.md");
      writeFileSync(snapshotPath, snapshotFixture([["plan-a", "Todo"], ["plan-b", "Todo"]]));
      writeFileSync(compassPath, COMPASS_ACTIVE);

      const result = runCli(gateArgs(dir, compassPath));
      expect(result.exitCode).toBe(0);
      expect(data(result).transition).toBe("phase-2-execute");
      // The hardcoded default-layout dir is NEVER consulted.
      expect(existsSync(join(dir, "workflows"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mstar iteration gate — phase-transition evaluation", () => {
  test("plans not all Done → phase-2-execute, exit 0 (gate passes, keep executing)", () => {
    withFixtures((dir, statusPath, compassPath) => {
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(0);
      expect(data(result).transition).toBe("phase-2-execute");
      // Entry checklist reports the still-executing plans (expected mid-run);
      // only the gate verdict (result.ok) drives the exit code.
      expect(violationCodes(result)).toContain("PLAN_NOT_DONE");
    });
  });

  test("all plans Done + active compass → phase-3-close required, exit 1 with exit-checklist violations", () => {
    withFixtures((dir, statusPath, compassPath) => {
      writeFileSync(statusPath, snapshotFixture([["plan-a", "Done"], ["plan-b", "Done"]]));
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect((envelope(result).details?.gate as { transition?: string }).transition).toBe("phase-3-close");
      expect(violationCodes(result)).toContain("EXIT_STATUS_NOT_COMPLETED");
      expect(violationCodes(result)).toContain("EXIT_END_DATE_REQUIRED");
    });
  });

  test("all plans Done + completed compass + full probes → phase-4-pr-delivery, exit 0", () => {
    withFixtures((dir, statusPath, compassPath) => {
      writeFileSync(statusPath, snapshotFixture([["plan-a", "Done"], ["plan-b", "Done"]]));
      writeFileSync(compassPath, COMPASS_COMPLETED);
      const result = runCli([
        "iteration", "gate",
        "--workflow", WORKFLOW_ID,
        "--harness", dir,
        "--compass", compassPath,
        "--branch", "iteration/v9.9.9",
        "--integration", "iteration/v9.9.9",
        "--target", "main",
      ]);
      expect(result.exitCode).toBe(0);
      const resultData = data(result);
      expect(resultData.transition).toBe("phase-4-pr-delivery");
      expect((resultData.entry as { ok?: boolean }).ok).toBe(true);
      expect((resultData.exit as { ok?: boolean }).ok).toBe(true);
    });
  });

  test("compass-registered plan missing from status.json → phase-2-execute with entry violation printed", () => {
    withFixtures((dir, statusPath, compassPath) => {
      writeFileSync(statusPath, snapshotFixture([["plan-a", "Todo"]]));
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(0);
      expect(data(result).transition).toBe("phase-2-execute");
      expect(violationCodes(result)).toContain("PLAN_NOT_IN_STATUS");
      expect(violationMessages(result).join("\n")).toContain("plan-b");
    });
  });

  test("plans: [] flow-style empty array → gate runs without PLAN_NOT_IN_STATUS noise", () => {
    withFixtures((dir, statusPath, compassPath) => {
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
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(0);
      expect(data(result).transition).toBe("phase-2-execute");
      // Parsed as an empty array: the frontmatter schema accepts it, and the
      // only report is the accurate COMPASS_NO_PLANS — no string-misparse
      // COMPASS_INVALID_FIELD and no per-plan PLAN_NOT_IN_STATUS noise.
      expect(violationCodes(result)).toContain("COMPASS_NO_PLANS");
      expect(violationCodes(result)).not.toContain("COMPASS_INVALID_FIELD");
      expect(violationCodes(result)).not.toContain("PLAN_NOT_IN_STATUS");
    });
  });

  test("plans: [a, b] flow-style array → gate checks those plan ids", () => {
    withFixtures((dir, statusPath, compassPath) => {
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
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(0);
      expect(data(result).transition).toBe("phase-2-execute");
      // Parsed as ["plan-a", "plan-b"]: both ids are looked up in status.json
      // and reported as still-executing (PLAN_NOT_DONE) — not lost to a
      // scalar misparse (COMPASS_NO_PLANS / COMPASS_INVALID_FIELD).
      expect(violationCodes(result)).toContain("PLAN_NOT_DONE");
      expect(violationMessages(result).join("\n")).toContain("plan-a");
      expect(violationMessages(result).join("\n")).toContain("plan-b");
      expect(violationCodes(result)).not.toContain("COMPASS_NO_PLANS");
      expect(violationCodes(result)).not.toContain("COMPASS_INVALID_FIELD");
      expect(violationCodes(result)).not.toContain("PLAN_NOT_IN_STATUS");
    });
  });

  test("plans: [\"hello, world\"] → exit 1: comma inside quotes is ambiguous, not split", () => {
    withFixtures((dir, statusPath, compassPath) => {
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
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(message(result)).toContain("ambiguous flow-style array");
      expect(message(result)).toContain("quoted item containing comma");
      // The quote-aware guard must fire before the naive split — the gate
      // never runs, so no plan lookups for a misparsed ["hello","world"].
      expect(violationCodes(result)).not.toContain("PLAN_NOT_IN_STATUS");
      expect(violationCodes(result)).not.toContain("PLAN_NOT_DONE");
    });
  });

  test("plans: [\"a, b\", \"c\"] → exit 1: first quoted item's comma is ambiguous", () => {
    withFixtures((dir, statusPath, compassPath) => {
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
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(message(result)).toContain("ambiguous flow-style array");
      expect(message(result)).toContain("quoted item containing comma");
      expect(violationCodes(result)).not.toContain("PLAN_NOT_IN_STATUS");
    });
  });

  test("plans: ['a, b'] → exit 1: comma inside single quotes is ambiguous, not split", () => {
    withFixtures((dir, statusPath, compassPath) => {
      writeFileSync(
        compassPath,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans: ['a, b']
---
`,
      );
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(message(result)).toContain("ambiguous flow-style array");
      expect(message(result)).toContain("quoted item containing comma");
      // The quote-aware guard must fire before the naive split — the gate
      // never runs, so no plan lookups for a misparsed ["a", "b"].
      expect(violationCodes(result)).not.toContain("PLAN_NOT_IN_STATUS");
      expect(violationCodes(result)).not.toContain("PLAN_NOT_DONE");
    });
  });

  test("plans: ['a, b', 'c'] → exit 1: first single-quoted item's comma is ambiguous", () => {
    withFixtures((dir, statusPath, compassPath) => {
      writeFileSync(
        compassPath,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans: ['a, b', 'c']
---
`,
      );
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(message(result)).toContain("ambiguous flow-style array");
      expect(violationCodes(result)).not.toContain("PLAN_NOT_IN_STATUS");
    });
  });

  test("plans: ['a\", b'] → exit 1: a foreign quote inside the quoted item must not toggle the scan", () => {
    withFixtures((dir, statusPath, compassPath) => {
      writeFileSync(
        compassPath,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans: ['a", b']
---
`,
      );
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(message(result)).toContain("ambiguous flow-style array");
      expect(violationCodes(result)).not.toContain("PLAN_NOT_IN_STATUS");
    });
  });

  test("plans: ['ok'] → single-quoted item without comma parses to ['ok']", () => {
    withFixtures((dir, statusPath, compassPath) => {
      writeFileSync(
        compassPath,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans: ['ok']
---
`,
      );
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(0);
      expect(data(result).transition).toBe("phase-2-execute");
      // Parsed as ["ok"]: the plan id is looked up in status.json and
      // reported as missing (PLAN_NOT_IN_STATUS) — not a scalar misparse.
      expect(violationCodes(result)).toContain("PLAN_NOT_IN_STATUS");
      expect(violationMessages(result).join("\n")).toContain("'ok'");
      expect(violationCodes(result)).not.toContain("COMPASS_NO_PLANS");
      expect(violationCodes(result)).not.toContain("COMPASS_INVALID_FIELD");
    });
  });

  test("plans: ['unterminated] → exit 1: unterminated single quote rejected", () => {
    withFixtures((dir, statusPath, compassPath) => {
      writeFileSync(
        compassPath,
        `---
iteration_id: v9.9.9
start_date: 2026-08-01
status: active
iteration_base_branch: main
target_branch: main
plans: ['unterminated]
---
`,
      );
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(message(result)).toContain("unterminated ' quote in flow-style array");
    });
  });

  test("plans: [[a]] → exit 1: nested flow-style array rejected", () => {
    withFixtures((dir, statusPath, compassPath) => {
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
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(message(result)).toContain("nested flow-style array");
    });
  });

  test("plans: [\"ok\"] → quoted item without comma parses to [\"ok\"]", () => {
    withFixtures((dir, statusPath, compassPath) => {
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
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(0);
      expect(data(result).transition).toBe("phase-2-execute");
      // Parsed as ["ok"]: the plan id is looked up in status.json and
      // reported as missing (PLAN_NOT_IN_STATUS) — not a scalar misparse.
      expect(violationCodes(result)).toContain("PLAN_NOT_IN_STATUS");
      expect(violationMessages(result).join("\n")).toContain("'ok'");
      expect(violationCodes(result)).not.toContain("COMPASS_NO_PLANS");
      expect(violationCodes(result)).not.toContain("COMPASS_INVALID_FIELD");
    });
  });

  test("missing workflow snapshot → exit 1 with precise message", () => {
    withFixtures((dir, _statusPath, compassPath) => {
      const result = runCli(["iteration", "gate", "--workflow", "no-such-wf", "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(message(result)).toContain("workflow snapshot not found");
    });
  });

  test("compass without frontmatter fence → exit 1 with precise message", () => {
    withFixtures((dir, statusPath, compassPath) => {
      writeFileSync(compassPath, "# no frontmatter here\n");
      const result = runCli(["iteration", "gate", "--workflow", WORKFLOW_ID, "--harness", dir, "--compass", compassPath]);
      expect(result.exitCode).toBe(1);
      expect(message(result)).toContain("no YAML frontmatter fence");
    });
  });

  test("hostile workflow id (path traversal) is rejected before any read, exit 1", () => {
    withFixtures((dir, _statusPath, compassPath) => {
      for (const bad of ["../../etc", "a/b", "..", "."]) {
        const result = runCli(["iteration", "gate", "--workflow", bad, "--harness", dir, "--compass", compassPath]);
        expect(result.exitCode).toBe(1);
        expect(message(result)).toContain("invalid workflow id");
        expect(message(result)).not.toContain("workflow snapshot not found");
      }
    });
  });
});

describe("mstar iteration push-cadence — §5.1a push gate", () => {
  test("no flags (CI idle, no review wave) → push allowed, exit 0", () => {
    const result = runCli(["iteration", "push-cadence"]);
    expect(result.exitCode).toBe(0);
    expect(data(result).allowed).toBe(true);
  });

  test("--ci-running → push blocked (PUSH_BLOCKED_CI), exit 1", () => {
    const result = runCli(["iteration", "push-cadence", "--ci-running"]);
    expect(result.exitCode).toBe(1);
    expect(violationCodes(result)).toContain("PUSH_BLOCKED_CI");
    expect(violationCodes(result)).not.toContain("PUSH_BLOCKED_REVIEW_WAVE");
  });

  test("--review-wave → push blocked (PUSH_BLOCKED_REVIEW_WAVE), exit 1", () => {
    const result = runCli(["iteration", "push-cadence", "--review-wave"]);
    expect(result.exitCode).toBe(1);
    expect(violationCodes(result)).toContain("PUSH_BLOCKED_REVIEW_WAVE");
    expect(violationCodes(result)).not.toContain("PUSH_BLOCKED_CI");
  });

  test("both flags → blocked with both violations, exit 1", () => {
    const result = runCli(["iteration", "push-cadence", "--ci-running", "--review-wave"]);
    expect(result.exitCode).toBe(1);
    expect(violationCodes(result)).toContain("PUSH_BLOCKED_CI");
    expect(violationCodes(result)).toContain("PUSH_BLOCKED_REVIEW_WAVE");
  });
});
