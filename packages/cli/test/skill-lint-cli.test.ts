/**
 * CLI `mstar skill lint` — canonical fixture parity (spec A4).
 *
 * Each case runs the real CLI as a subprocess over a materialized fixture
 * skill (`<skillId>/SKILL.md`) from the canonical corpus
 * `packages/engine/test/fixtures/skill-lint-profiles.json` and asserts the
 * DECISION — per-check verdicts (OK / FAIL / EXEMPT) plus the exact
 * violation-code lists — never ANSI prose. The dsh suite
 * (packages/dsh/tests/skill-lint.spec.ts) and the Guard5 suite
 * (scripts/drift-lint.test.ts) consume the same rows, so equal assertions
 * across the three files prove cross-consumer decision equivalence with the
 * fixture table as the pivot.
 *
 * Profile selection under test: the CLI now classifies with the shared
 * Engine classifier `classifySkillLint(resolved directory basename)` —
 * runtime aliases, `mstar-skill-authoring` strict, core EXEMPT (five-
 * question skipped; frontmatter + ephemeral still run), non-mstar strict.
 * The seam is exercised by rows whose identical alias bodies pass under a
 * runtime basename and fail under an authoring basename.
 *
 * Row note: the `missing-identity-defaults-authoring` row (`skillId: null`)
 * pins the API-level missing-identity case engine-side (and doc-only in
 * dsh); the CLI's identity source is always the resolved basename, so this
 * suite materializes that row under the doc's own non-mstar name — the
 * classified profile (strict authoring) and expected codes are identical.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
const FIXTURE_PATH = join(CLI_ROOT, "..", "engine", "test", "fixtures", "skill-lint-profiles.json");

type FixtureRow = {
  id: string;
  skillId: string | null;
  doc: string;
  expectedKind: "core" | "runtime" | "authoring";
  expectedMode: "runtime" | "authoring" | null;
  expectedFiveQuestionCodes: string[] | null;
  expectedFrontmatterCodes: string[];
};

const FIXTURES = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  schemaVersion: number;
  rows: FixtureRow[];
};

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn env with ambient harness env vars pinned out (sdd-cli.test.ts parity). */
function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Run the real CLI entry as a subprocess. */
function runCli(args: string[]): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** One skill-lint check verdict as printed by `printChecklist` / the EXEMPT row. */
type CheckVerdict = "OK" | "FAIL" | "EXEMPT";

/** The lint DECISION (verdicts + exact codes), stripped of ANSI escapes —
 * never the prose messages. */
type CliDecision = {
  exitCode: number | null;
  frontmatter: CheckVerdict | null;
  fiveQuestion: CheckVerdict | null;
  ephemeral: CheckVerdict | null;
  codes: string[];
};

const ANSI_RE = /\u001B\[[0-9;]*m/g;

function decide(res: RunResult): CliDecision {
  const out = res.stdout.replace(ANSI_RE, "");
  const err = res.stderr.replace(ANSI_RE, "");
  const all = `${out}\n${err}`;
  const verdict = (label: string): CheckVerdict | null => {
    if (all.includes(`${label}: EXEMPT`)) return "EXEMPT";
    if (all.includes(`${label}: OK`)) return "OK";
    if (all.includes(`${label}: FAIL`)) return "FAIL";
    return null;
  };
  // Violation rows print as `  - [<severity>] <code>: <message>` (plain,
  // uncolored) — the code is the decision token.
  const codes = [...err.matchAll(/^\s+- \[[a-z]+\] ([\w.-]+):/gm)].map((m) => m[1]);
  return {
    exitCode: res.exitCode,
    frontmatter: verdict("skill lint (frontmatter)"),
    fiveQuestion: verdict("skill lint (five questions)"),
    ephemeral: verdict("skill lint (ephemeral citations)"),
    codes,
  };
}

/** Materialize a fixture row as `<dir>/<skillName>/SKILL.md` and lint it. */
function lintFixtureRow(row: FixtureRow, dir: string): CliDecision {
  const skillName = row.skillId ?? "unparented-skill";
  mkdirSync(join(dir, skillName), { recursive: true });
  writeFileSync(join(dir, skillName, "SKILL.md"), row.doc);
  return decide(runCli(["skill", "lint", join(dir, skillName)]));
}

describe("mstar skill lint — canonical fixture decisions (spec A4)", () => {
  const tmpRoots: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-lint-cli-"));
    tmpRoots.push(dir);
    return dir;
  };

  for (const row of FIXTURES.rows) {
    test(`fixture ${row.id}: ${row.expectedKind}/${row.expectedMode ?? "null"} decision`, () => {
      const decision = lintFixtureRow(row, tempDir());

      // Frontmatter stays active in every profile.
      expect(decision.frontmatter).toBe(row.expectedFrontmatterCodes.length === 0 ? "OK" : "FAIL");
      expect(decision.codes.filter((c) => c.startsWith("lint.frontmatter."))).toEqual(row.expectedFrontmatterCodes);

      // Five-question verdict follows the classified mode: EXEMPT = core
      // skip (mode null), OK/FAIL = ran with the classified mode.
      const wantFive: CheckVerdict =
        row.expectedMode === null ? "EXEMPT" : row.expectedFiveQuestionCodes!.length === 0 ? "OK" : "FAIL";
      expect(decision.fiveQuestion).toBe(wantFive);
      expect(decision.codes.filter((c) => c.startsWith("skill-authoring.five-question."))).toEqual(
        row.expectedFiveQuestionCodes ?? [],
      );

      // Ephemeral-citation check stays wired and clean on the fixture corpus.
      expect(decision.ephemeral).toBe("OK");
      expect(decision.codes.filter((c) => c.startsWith("skill.ephemeral."))).toEqual([]);

      // Exit decision: 1 iff any check failed.
      expect(decision.exitCode).toBe(wantFive === "FAIL" || decision.frontmatter === "FAIL" ? 1 : 0);
    });
  }

  test("classify-then-lint seam: identical alias body flips with the resolved basename (load-bearing)", () => {
    const row = FIXTURES.rows.find((r) => r.id === "runtime-alias-pass");
    expect(row).toBeDefined();
    const aliasDoc = row!.doc;

    // Runtime basename: alias headings cover — the lint ran in runtime mode.
    const runtimeDir = tempDir();
    mkdirSync(join(runtimeDir, "mstar-alias-body"), { recursive: true });
    writeFileSync(join(runtimeDir, "mstar-alias-body", "SKILL.md"), aliasDoc);
    const runtimeDecision = decide(runCli(["skill", "lint", join(runtimeDir, "mstar-alias-body")]));
    expect(runtimeDecision.exitCode).toBe(0);
    expect(runtimeDecision.fiveQuestion).toBe("OK");

    // Authoring basename: the SAME body fails strict with exactly the
    // uncovered-question codes (runtime aliases do not rescue it).
    const authoringDir = tempDir();
    mkdirSync(join(authoringDir, "plain-skill"), { recursive: true });
    writeFileSync(join(authoringDir, "plain-skill", "SKILL.md"), aliasDoc);
    const authoringDecision = decide(runCli(["skill", "lint", join(authoringDir, "plain-skill")]));
    expect(authoringDecision.fiveQuestion).toBe("FAIL");
    expect(
      authoringDecision.codes.filter((c) => c.startsWith("skill-authoring.five-question.")),
    ).toEqual([
      "skill-authoring.five-question.workflow",
      "skill-authoring.five-question.decision-rules",
      "skill-authoring.five-question.evidence",
      "skill-authoring.five-question.references",
    ]);
  });

  test("identity source is the resolved directory basename, never the YAML name (load-bearing)", () => {
    // `misleading-yaml-core-third-party`: YAML `name: mstar-harness-core`
    // under a third-party basename stays authoring — the core exemption is
    // NOT reachable through frontmatter.
    const row = FIXTURES.rows.find((r) => r.id === "misleading-yaml-core-third-party");
    expect(row).toBeDefined();
    const decision = lintFixtureRow(row!, tempDir());
    expect(decision.fiveQuestion).toBe("FAIL");
    expect(decision.codes.filter((c) => c.startsWith("skill-authoring.five-question."))).toEqual(
      row!.expectedFiveQuestionCodes,
    );
  });

  afterAll(() => {
    for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  });
});
