/**
 * CLI `mstar sdd evidence capture|verify` — local collectors, capture runner
 * and read-only verification (SDD test-evidence task 2).
 *
 * Fixture-first synthetic checks: disposable primary/control/feature Git
 * checkouts with synthetic plan ids, a regular child executable, and a
 * counter child that writes OUTSIDE the declared inputs (exactly-once is
 * measurable without invalidating inputs by design). Process-local Git
 * signing is disabled in fixture subprocesses only. Never points capture or
 * verify at a live checkout.
 *
 * Contract under test (locked CLI surface):
 * - literal argv (no shell), separate raw stdout/stderr bytes, tagged
 *   outcomes (exit 7, ENOENT 127, EACCES 1, timeout 124, SIGINT 130),
 *   bounded TERM→KILL escalation and descendant-pipe drain,
 * - 8 MiB per-stream storage cap, finalization-failure honesty,
 * - usage/gate refusals before any child, canonical SDD writes only,
 * - read-only verify: artifact damage codes, no-target integrity-only
 *   semantics, target candidate/changed/uncertain lanes (expected-head
 *   mismatch, different repository, unknown declaration, unreadable
 *   inputs, missing declared roots as explicit missing entries ⇒ changed),
 * - no environment dump; selected env values (including null absence)
 *   fingerprinted,
 * - budgeted collectEvidenceInputs: shared two-pass byte allowance, entry
 *   enumeration stop, capped-snapshot representability, usage rejections.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  captureSddEvidence,
  collectEvidenceArtifacts,
  collectEvidenceInputs,
} from "../src/sdd-evidence";
import {
  evidenceInputDigest,
  readHarnessVersion,
  validateSddEvidenceRecord,
  verifySddEvidence,
  type EvidenceCaptureRequest,
  type EvidenceLimits,
  type SddEvidenceRecord,
} from "@mstar-harness/engine";

const CLI_ROOT = resolvePath(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
const PLAN_ID = "evidence-fixture-plan"; // synthetic — never a local plan id
const TASK_ID = "task-2";
const TZ_VALUE = "EVIDENCE_TZ";

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { TZ: TZ_VALUE };
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Run the real CLI entry as a subprocess; cwd + env overrides per test. */
function runCli(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd: opts.cwd ?? CLI_ROOT,
    env: cliEnv(opts.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Git with process-local signing disabled (fixtures only; no global config). */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
    },
  }).trim();
}

// ---------------------------------------------------------------------------
// Fixture: primary/control/feature checkouts + declared inputs + children.
// ---------------------------------------------------------------------------

interface EvidenceFixture {
  root: string;
  primary: string;
  control: string;
  feature: string;
  harnessDir: string;
  planFile: string;
  sddDir: string;
  evidenceDir: string;
  workingBranch: string;
  head: string;
  counterPath: string;
  request: EvidenceCaptureRequest;
  requestFile: string;
  argvRecordPath: string;
  children: { counter: string; exit7: string; ignoreTerm: string; interruptible: string; descendant: string; grandchild: string; bigOut: string; overflow: string; finalizeFail: string };
}

const DECLARED_INPUTS: EvidenceCaptureRequest["inputs"] = [
  { path: "src/app.js", kind: "file", purpose: "source" },
  { path: "config.json", kind: "file", purpose: "config" },
  { path: "tests", kind: "directory", purpose: "test" },
  { path: "deps", kind: "directory", purpose: "dependency" },
];

function buildRequest(f: EvidenceFixture, overrides: Partial<EvidenceCaptureRequest> = {}): EvidenceCaptureRequest {
  const base: EvidenceCaptureRequest = {
    context: {
      planId: PLAN_ID,
      controlHarnessRoot: f.harnessDir,
      featureCwd: f.feature,
      workingBranch: f.workingBranch,
      planFile: f.planFile,
      sddDir: f.sddDir,
    },
    taskId: TASK_ID,
    coverage: {
      acIds: ["AC-1"],
      behavior: "fixture check: counter child increments once and emits tagged output",
      declaration: "reviewed",
      sourceRationale: "declared source root src/app.js reviewed in fixture",
      dependencyRationale: "declared dependency directory deps reviewed in fixture",
      runtimeRationale: "bun runtime pinned by absolute process.execPath argv[0]",
      environmentRationale: "only TZ/NODE_ENV selected; no other inherited env input affects these claims",
    },
    inputs: DECLARED_INPUTS.map((spec) => ({ ...spec })),
    environmentKeys: ["TZ", "NODE_ENV"],
  };
  return { ...base, ...overrides };
}

function evidenceFixture(root: string): EvidenceFixture {
  const primary = join(root, "primary");
  mkdirSync(primary);
  git(["init", "-q"], primary);
  git(["checkout", "-q", "-b", "main"], primary);
  git(["config", "user.email", "sdd-evidence-test@example.com"], primary);
  git(["config", "user.name", "SDD Evidence Test"], primary);
  writeFileSync(join(primary, ".gitignore"), ".mstar/\n");

  const control = join(root, "control");
  git(["worktree", "add", "-q", "-b", "codex/iter-integration", control], primary);
  const workingBranch = `feature/${PLAN_ID}`;
  const feature = join(root, "feature");
  git(["worktree", "add", "-q", "-b", workingBranch, feature], primary);

  // Declared inputs (committed clean) + a non-executable script (EACCES case).
  mkdirSync(join(feature, "src"));
  mkdirSync(join(feature, "tests"));
  mkdirSync(join(feature, "deps"));
  writeFileSync(join(feature, "src", "app.js"), "export const app = 'fixture-v1';\n");
  writeFileSync(join(feature, "config.json"), '{"feature":"evidence","level":1}\n');
  writeFileSync(join(feature, "tests", "unit.js"), "test('unit', () => {});\n");
  writeFileSync(join(feature, "deps", "lib.js"), "export const lib = 'dep-v1';\n");
  const nonexec = join(feature, "nonexec.sh");
  writeFileSync(nonexec, "#!/bin/sh\necho nope\n");
  chmodSync(nonexec, 0o644);
  git(["add", "-A"], feature);
  git(["commit", "-q", "-m", "fixture base"], feature);
  const head = git(["rev-parse", "HEAD"], feature);

  const harnessDir = join(control, ".mstar");
  const planFile = join(harnessDir, "plans", `${PLAN_ID}.md`);
  mkdirSync(dirname(planFile), { recursive: true });
  writeFileSync(planFile, "# Plan\n\n## Task 2\n\n- capture evidence\n");
  const sddDir = join(harnessDir, "sdd", PLAN_ID);
  mkdirSync(sddDir, { recursive: true });

  // Child scripts live OUTSIDE the feature repo (no git noise); the counter
  // lives INSIDE the feature worktree but OUTSIDE the declared inputs.
  const bin = join(root, "bin");
  mkdirSync(bin);
  const counterPath = join(feature, "counter.json");
  const argvRecordPath = join(root, "argv-record.json");
  const children = {
    counter: join(bin, "child-counter.mjs"),
    exit7: join(bin, "child-exit7.mjs"),
    ignoreTerm: join(bin, "child-ignore-term.mjs"),
    interruptible: join(bin, "child-interruptible.mjs"),
    descendant: join(bin, "child-descendant.mjs"),
    grandchild: join(bin, "grandchild.mjs"),
    bigOut: join(bin, "child-big-out.mjs"),
    overflow: join(bin, "child-overflow.mjs"),
    finalizeFail: join(bin, "child-finalize-fail.mjs"),
  };
  writeFileSync(
    children.counter,
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';\n" +
      "const [counterPath, argvRecordPath, ...rest] = process.argv.slice(2);\n" +
      "const count = existsSync(counterPath) ? JSON.parse(readFileSync(counterPath, 'utf8')).count : 0;\n" +
      "writeFileSync(counterPath, JSON.stringify({ count: count + 1 }));\n" +
      "writeFileSync(argvRecordPath, JSON.stringify({ cwd: process.cwd(), argv: rest }));\n" +
      "const out = `OUT: ${rest.join('|')}`;\n" +
      "process.stdout.write(out + '\\n');\n" +
      "process.stderr.write(out.replace('OUT:', 'ERR:') + '\\n');\n",
  );
  writeFileSync(children.exit7, "process.exit(7);\n");
  writeFileSync(
    children.ignoreTerm,
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(join(root, "ignore-term-started.txt"))}, "started\\n");\n` +
      "process.on('SIGTERM', () => {});\n" +
      "setInterval(() => {}, 1000);\n",
  );
  writeFileSync(
    children.interruptible,
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(join(root, "interrupt-started.txt"))}, "started\\n");\n` +
      "setInterval(() => {}, 1000);\n",
  );
  writeFileSync(
    children.grandchild,
    "import fs from 'node:fs';\nsetInterval(() => { try { fs.writeSync(1, 'tick\\n'); } catch {} }, 50);\n",
  );
  writeFileSync(
    children.descendant,
    `import { spawn } from 'node:child_process';\n` +
      `spawn(process.execPath, [${JSON.stringify(children.grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'] });\n` +
      "setTimeout(() => process.exit(0), 50);\n",
  );
  writeFileSync(
    children.bigOut,
    "import fs from 'node:fs';\n" +
      "const chunk = Buffer.alloc(1 << 20, 0x78);\n" +
      "for (let i = 0; i < 9; i += 1) fs.writeSync(1, chunk);\n" +
      "fs.writeSync(2, 'ERR-LINE\\n');\n",
  );
  // Chatty on both streams so a sabotaged log fd yields far more than the
  // 256-message captureErrors bound before the child exits.
  writeFileSync(
    children.overflow,
    "import fs from 'node:fs';\n" +
      "for (let i = 0; i < 500; i += 1) {\n" +
      "  try { fs.writeSync(1, `tick ${i}\\n`); fs.writeSync(2, `tick ${i}\\n`); } catch {}\n" +
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);\n" +
      "}\n",
  );
  writeFileSync(
    children.finalizeFail,
    "import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';\n" +
      "const [evidenceDir] = process.argv.slice(2);\n" +
      "const deadline = Date.now() + 15000;\n" +
      "let target = null;\n" +
      "while (Date.now() < deadline) {\n" +
      "  for (const dir of readdirSync(evidenceDir)) {\n" +
      "    const record = `${evidenceDir}/${dir}/record.json`;\n" +
      "    try {\n" +
      "      if (readFileSync(record, 'utf8').includes('\"running\"')) { target = record; break; }\n" +
      "    } catch {}\n" +
      "  }\n" +
      "  if (target) break;\n" +
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);\n" +
      "}\n" +
      "if (target) { rmSync(target); mkdirSync(target); }\n",
  );

  const f: EvidenceFixture = {
    root,
    primary,
    control,
    feature,
    harnessDir,
    planFile,
    sddDir,
    evidenceDir: join(sddDir, "evidence"),
    workingBranch,
    head,
    counterPath,
    request: buildRequest({} as EvidenceFixture),
    requestFile: join(root, "request.json"),
    argvRecordPath,
    children,
  };
  f.request = buildRequest(f);
  writeFileSync(f.requestFile, JSON.stringify(f.request, null, 2));
  return f;
}

/** Direct captureSddEvidence call with the observed cwd pinned to the feature worktree. */
function captureDirect(
  f: EvidenceFixture,
  argv: string[],
  opts: { timeoutMs?: number; request?: EvidenceCaptureRequest; env?: Record<string, string | undefined> } = {},
): Promise<{ runDir: string; record: SddEvidenceRecord; exitCode: number }> {
  // The collector fingerprints the observed process environment; pin TZ the
  // same way the CLI subprocess env does so direct and CLI lanes match.
  const env = { TZ: TZ_VALUE, ...opts.env };
  const savedEnv: Array<[string, string | undefined]> = [];
  for (const [key, value] of Object.entries(env)) {
    savedEnv.push([key, process.env[key]]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const prevCwd = process.cwd();
  process.chdir(f.feature);
  const request = opts.request ?? (opts.timeoutMs !== undefined ? { ...f.request, timeoutMs: opts.timeoutMs } : f.request);
  return captureSddEvidence(request, argv).finally(() => {
    process.chdir(prevCwd);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const counterArgv = (f: EvidenceFixture): string[] => [
  process.execPath,
  f.children.counter,
  f.counterPath,
  f.argvRecordPath,
  "a b",
  "$(touch pwn.txt)",
  "`touch pwn.txt`",
  "*",
];

function readRecord(runDir: string): SddEvidenceRecord {
  return JSON.parse(readFileSync(join(runDir, "record.json"), "utf8")) as SddEvidenceRecord;
}

function runDirFromStderr(stderr: string): string {
  const match = /evidence run: (.+)/.exec(stderr);
  if (!match) throw new Error(`no evidence run path in stderr: ${stderr}`);
  return match[1]!.trim();
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const p = join(current, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function targetFileFor(root: string, cwd: string, expectedHead: string): string {
  const p = join(root, `target-${expectedHead.slice(0, 6)}.json`);
  writeFileSync(p, JSON.stringify({ cwd, expectedHead, rationale: "current integration checkout of the same feature" }));
  return p;
}

function verifyCli(
  f: EvidenceFixture,
  runId: string,
  opts: { target?: string; sddDir?: string; env?: Record<string, string> } = {},
): RunResult {
  const args = [
    "sdd", "evidence", "verify",
    "--sdd-dir", opts.sddDir ?? f.sddDir,
    "--plan", PLAN_ID,
    "--task", TASK_ID,
    "--run", runId,
  ];
  if (opts.target !== undefined) args.push("--target", opts.target);
  return runCli(args, { cwd: f.control, env: opts.env });
}

async function waitForMarker(marker: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(50);
  expect(existsSync(marker)).toBe(true);
}

// ---------------------------------------------------------------------------
// Command surface.
// ---------------------------------------------------------------------------

describe("sdd evidence command surface (registrar)", () => {
  test("help advertises --request and literal argv placement for capture", () => {
    const result = runCli(["sdd", "evidence", "capture", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--request");
    expect(result.stdout).toContain("--");
  });

  test("help advertises --sdd-dir/--plan/--task/--run/--target for verify", () => {
    const result = runCli(["sdd", "evidence", "verify", "--help"]);
    expect(result.exitCode).toBe(0);
    for (const flag of ["--sdd-dir", "--plan", "--task", "--run", "--target"]) {
      expect(result.stdout).toContain(flag);
    }
  });
});

// ---------------------------------------------------------------------------
// Capture happy path.
// ---------------------------------------------------------------------------

describe("capture — one execution, durable facts", () => {
  test(
    "literal argv, separate raw logs, counter exactly once, fixed v1 limits, stable before/after digests",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-capture-");
      try {
        const f = evidenceFixture(root);
        const result = await captureDirect(f, counterArgv(f), { env: { NODE_ENV: undefined } });
        expect(result.exitCode).toBe(0);
        const record = result.record;

        // Record shape and identity.
        expect(record.schema).toBe("mstar.sdd-evidence/v1");
        expect(record.producer.name).toBe("mstar-harness");
        expect(record.producer.version).toBe(readHarnessVersion());
        expect(record.state).toBe("finished");
        expect(record.outcome).toEqual({ kind: "exit", code: 0 });
        expect(record.counts).toBeNull();
        expect(record.captureErrors).toEqual([]);
        expect(record.command.cwd).toBe(realpathSync(f.feature));
        expect(record.request.context.featureCwd).toBe(realpathSync(f.feature));
        expect(record.request.taskId).toBe(TASK_ID);
        expect(record.request.coverage.declaration).toBe("reviewed");
        expect(record.request.inputs).toHaveLength(4);
        expect(record.request.environmentKeys).toEqual(["TZ", "NODE_ENV"]);
        expect(record.limits).toEqual({
          timeoutMs: 600000,
          maxLogBytesPerStream: 8388608,
          maxInputBytes: 536870912,
          maxInputEntries: 10000,
          maxInputMs: 30000,
          maxSnapshotBytes: 2097152,
        });

        // Literal argv, no shell synthesis.
        expect(record.command.argv).toEqual(counterArgv(f));
        expect(existsSync(join(f.feature, "pwn.txt"))).toBe(false);
        const childView = JSON.parse(readFileSync(f.argvRecordPath, "utf8")) as { cwd: string; argv: string[] };
        expect(childView.cwd).toBe(realpathSync(f.feature));
        expect(childView.argv).toEqual(["a b", "$(touch pwn.txt)", "`touch pwn.txt`", "*"]);

        // Separate raw stdout/stderr bytes, non-truncated, hashed.
        expect(record.logs.stdout.path).toBe("stdout.log");
        expect(record.logs.stderr.path).toBe("stderr.log");
        expect(record.logs.stdout.truncated).toBe(false);
        expect(record.logs.stderr.truncated).toBe(false);
        const stdoutOnDisk = readFileSync(join(result.runDir, "stdout.log"));
        const stderrOnDisk = readFileSync(join(result.runDir, "stderr.log"));
        expect(stdoutOnDisk.toString()).toContain("OUT: a b|$(touch pwn.txt)|`touch pwn.txt`|*");
        expect(stderrOnDisk.toString()).toContain("ERR: a b");
        expect(stderrOnDisk.toString()).not.toContain("OUT:");
        expect(record.logs.stdout.bytes).toBe(stdoutOnDisk.length);
        expect(record.logs.stdout.sha256).toBe(sha256(stdoutOnDisk));
        expect(record.logs.stderr.sha256).toBe(sha256(stderrOnDisk));

        // The counter child ran exactly once, outside the declared inputs.
        expect(JSON.parse(readFileSync(f.counterPath, "utf8"))).toEqual({ count: 1 });

        // Input stability: the counter write does not invalidate declared inputs.
        expect(record.before.stable).toBe(true);
        expect(record.after!.stable).toBe(true);
        expect(record.before.digest).toBe(record.after!.digest);
        expect(record.before.environment).toEqual({ TZ: TZ_VALUE, NODE_ENV: null });

        // The engine validator accepts the captured record as-is.
        expect(validateSddEvidenceRecord(record).ok).toBe(true);
        const onDisk = readRecord(result.runDir);
        expect(onDisk.runId).toBe(record.runId);
        expect(onDisk.state).toBe("finished");

        // Canonical SDD writes only: exactly the three fixed files under
        // the evidence run dir (the fixture writes nothing else here).
        expect(
          readdirSync(f.evidenceDir).flatMap((run) => [
            `evidence/${run}/record.json`,
            `evidence/${run}/stderr.log`,
            `evidence/${run}/stdout.log`,
          ]).sort(),
        ).toEqual(
          listFilesRecursive(f.sddDir).map((p) => p.slice(f.sddDir.length + 1)).sort(),
        );
        const status = git(["status", "--porcelain"], f.feature);
        expect(status).toBe("?? counter.json");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  test("every explicit retry uses a new run id and increments the counter again", async () => {
    const root = tmpRoot("mstar-sdd-ev-retry-");
    try {
      const f = evidenceFixture(root);
      const first = await captureDirect(f, counterArgv(f));
      const second = await captureDirect(f, counterArgv(f));
      expect(first.runDir).not.toBe(second.runDir);
      expect(first.record.runId).not.toBe(second.record.runId);
      expect(existsSync(first.runDir)).toBe(true);
      expect(existsSync(second.runDir)).toBe(true);
      expect(JSON.parse(readFileSync(f.counterPath, "utf8"))).toEqual({ count: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Outcomes and escalation bounds.
// ---------------------------------------------------------------------------

describe("capture — outcomes", () => {
  test(
    "exit7 is retained as a valid failed run; no-target verify is integrity-only with mandatory failed outcome",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-exit7-");
      try {
        const f = evidenceFixture(root);
        const result = await captureDirect(f, [process.execPath, f.children.exit7]);
        expect(result.exitCode).toBe(7);
        expect(result.record.outcome).toEqual({ kind: "exit", code: 7 });

        const verify = verifyCli(f, result.record.runId);
        expect(verify.exitCode).toBe(0);
        const assessment = JSON.parse(verify.stdout) as { outcome: string; applicability: string; changedInputs: string[]; coverage: string };
        expect(assessment.outcome).toBe("failed");
        expect(assessment.applicability).toBe("not-assessed");
        expect(assessment.coverage).toBe("review-required");
        expect(assessment.changedInputs).toEqual([]);
        expect(verify.stderr).toContain("integrity only; outcome=failed; acceptance not assessed");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  test("missing executable keeps spawn-error ENOENT with logs and unknown tool (exit 127)", async () => {
    const root = tmpRoot("mstar-sdd-ev-enoent-");
    try {
      const f = evidenceFixture(root);
      const result = await captureDirect(f, ["definitely-not-a-real-binary-xyz"]);
      expect(result.exitCode).toBe(127);
      expect(result.record.outcome).toEqual({ kind: "spawn-error", code: "ENOENT" });
      expect(result.record.state).toBe("finished");
      expect(result.record.before.tool.resolvedPath).toBeNull();
      expect(result.record.before.tool.sha256).toBeNull();
      expect(result.record.before.tool.error).not.toBeNull();
      expect(result.record.logs.stdout.bytes).toBe(0);
      expect(result.record.logs.stderr.sha256).toBe(sha256(""));
      expect(validateSddEvidenceRecord(result.record).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("PATH-bound overflow without a resolved path retains spawn-error ERESOLUTIONLIMIT (exit 1)", async () => {
    const root = tmpRoot("mstar-sdd-ev-reslim-");
    try {
      const f = evidenceFixture(root);
      const gitPath = execFileSync("which", ["git"]).toString().trim();
      const paddedPath = [dirname(gitPath), ...Array.from({ length: 300 }, () => "/nonexistent-evidence-xyz")].join(":");
      const result = await captureDirect(f, ["no-such-tool-evidence-xyz"], { env: { PATH: paddedPath } });
      expect(result.exitCode).toBe(1);
      expect(result.record.outcome).toEqual({ kind: "spawn-error", code: "ERESOLUTIONLIMIT" });
      expect(result.record.before.tool.resolvedPath).toBeNull();
      expect(result.record.before.unknowns.join("\n")).toContain("tool.resolution-limit");
      expect(existsSync(f.counterPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("permission failure retains spawn-error EACCES with a hashed tool (exit 1)", async () => {
    const root = tmpRoot("mstar-sdd-ev-eacces-");
    try {
      const f = evidenceFixture(root);
      const result = await captureDirect(f, ["./nonexec.sh"]);
      expect(result.exitCode).toBe(1);
      expect(result.record.outcome).toEqual({ kind: "spawn-error", code: "EACCES" });
      expect(result.record.before.tool.resolvedPath).not.toBeNull();
      expect(result.record.before.tool.sha256).not.toBeNull();
      expect(existsSync(f.counterPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test(
    "timeout with a TERM-ignoring child escalates to KILL and settles bounded (exit 124)",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-timeout-");
      try {
        const f = evidenceFixture(root);
        const started = Date.now();
        const result = await captureDirect(f, [process.execPath, f.children.ignoreTerm], { timeoutMs: 700 });
        const elapsed = Date.now() - started;
        expect(result.exitCode).toBe(124);
        expect(result.record.outcome).toEqual({ kind: "timeout" });
        expect(elapsed).toBeLessThan(15000);
        expect(elapsed).toBeGreaterThan(2700 - 1500); // bounded: timeout + TERM grace, with margin
        expect(validateSddEvidenceRecord(result.record).ok).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  test(
    "parent SIGINT is forwarded to the owned group and settles at 130 (interrupted)",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-sigint-");
      try {
        const f = evidenceFixture(root);
        const marker = join(root, "interrupt-started.txt");
        const proc = Bun.spawn(
          [process.execPath, "run", SRC_ENTRY, "sdd", "evidence", "capture", "--request", f.requestFile, "--", process.execPath, f.children.interruptible],
          { cwd: f.feature, env: cliEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
        await waitForMarker(marker);
        proc.kill("SIGINT");
        const code = await proc.exited;
        expect(code).toBe(130);
        const stderr = await new Response(proc.stderr as unknown as ReadableStream).text();
        expect(stderr).toContain("evidence run: ");
        const runDir = runDirFromStderr(stderr);
        const record = readRecord(runDir);
        expect(record.outcome).toEqual({ kind: "interrupted", signal: "SIGINT" });
        expect(record.state).toBe("finished");
        expect(validateSddEvidenceRecord(record).ok).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  test(
    "direct-child exit with descendant-held pipes drains bounded and keeps the direct outcome (drain-incomplete, exit 1)",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-drain-");
      try {
        const f = evidenceFixture(root);
        const started = Date.now();
        const result = await captureDirect(f, [process.execPath, f.children.descendant]);
        const elapsed = Date.now() - started;
        expect(elapsed).toBeLessThan(15000);
        expect(elapsed).toBeGreaterThan(1800); // the 2 s drain bound actually elapsed
        expect(result.record.outcome).toEqual({ kind: "exit", code: 0 });
        expect(result.exitCode).toBe(1);
        expect(result.record.captureErrors.join("\n")).toContain("capture.drain-incomplete");
        expect(validateSddEvidenceRecord(result.record).ok).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  test(
    "output beyond the per-stream cap is stored capped, hashed over stored bytes, and marked truncated",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-cap-");
      try {
        const f = evidenceFixture(root);
        const result = await captureDirect(f, [process.execPath, f.children.bigOut]);
        expect(result.record.outcome).toEqual({ kind: "exit", code: 0 });
        expect(result.exitCode).toBe(1); // child passed but capture incomplete
        expect(result.record.logs.stdout.bytes).toBe(8388608);
        expect(result.record.logs.stdout.truncated).toBe(true);
        expect(result.record.logs.stderr.truncated).toBe(false);
        const onDisk = readFileSync(join(result.runDir, "stdout.log"));
        expect(onDisk.length).toBe(8388608);
        expect(result.record.logs.stdout.sha256).toBe(sha256(onDisk));
        expect(validateSddEvidenceRecord(result.record).ok).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  test(
    "captureErrors beyond the record bound finalize capped with an explicit overflow marker (never a finalization failure)",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-caperr-");
      try {
        const f = evidenceFixture(root);
        // Sabotage the capture log fds (in-process lane) as soon as the run
        // dir appears: closing them turns every subsequent stream chunk into
        // a capture.log-write-error, overflowing the 256-message bound.
        const knownRuns = new Set(existsSync(f.evidenceDir) ? readdirSync(f.evidenceDir) : []);
        let closed = 0;
        const saboteur = setInterval(() => {
          // Exactly one open fd per log slot; nothing left to do after both.
          if (closed >= 2) return;
          try {
            if (!existsSync(f.evidenceDir)) return;
            for (const run of readdirSync(f.evidenceDir)) {
              if (knownRuns.has(run)) continue;
              for (const slot of ["stdout.log", "stderr.log"]) {
                let target: { ino: number; dev: number };
                try {
                  const st = lstatSync(join(f.evidenceDir, run, slot));
                  if (!st.isFile()) continue;
                  target = { ino: st.ino, dev: st.dev };
                } catch {
                  continue;
                }
                for (let fd = 3; fd < 1024; fd += 1) {
                  try {
                    const st = fstatSync(fd);
                    if (st.isFile() && st.ino === target.ino && st.dev === target.dev) {
                      closeSync(fd);
                      closed += 1;
                    }
                  } catch {
                    // fd not open in this process
                  }
                }
              }
            }
          } catch {
            // the attempt dir may not exist yet; retry on the next tick
          }
        }, 5);
        let result: Awaited<ReturnType<typeof captureDirect>>;
        try {
          result = await captureDirect(f, [process.execPath, f.children.overflow]);
        } finally {
          clearInterval(saboteur);
        }
        expect(closed).toBeGreaterThan(0);
        // The capture still finalizes a schema-valid record instead of
        // failing record self-validation after the child already ran.
        expect(result.record.state).toBe("finished");
        expect(result.record.outcome).toEqual({ kind: "exit", code: 0 });
        expect(result.record.captureErrors).toHaveLength(256);
        expect(result.record.captureErrors[254]).toContain("capture.log-write-error");
        expect(result.record.captureErrors[255]).toContain("capture.errors-truncated:");
        expect(result.record.captureErrors[255]).toContain("additional capture errors were dropped");
        expect(validateSddEvidenceRecord(result.record).ok).toBe(true);
        expect(result.exitCode).toBe(1); // child passed but capture incomplete
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  test(
    "finalization write failure throws with the run dir, preserving running artifacts (no catch-and-success)",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-final-");
      try {
        const f = evidenceFixture(root);
        let thrown: Error | null = null;
        try {
          await captureDirect(f, [process.execPath, f.children.finalizeFail, f.evidenceDir]);
        } catch (error) {
          thrown = error as Error;
        }
        expect(thrown).not.toBeNull();
        expect(thrown!.message).toContain("evidence finalization write failed");
        const match = /evidence[\\/]([0-9a-f-]{36})/.exec(thrown!.message);
        expect(match).not.toBeNull();
        const runDir = join(f.evidenceDir, match![1]!);
        expect(lstatSync(join(runDir, "record.json")).isDirectory()).toBe(true); // child's sabotage, preserved
        expect(existsSync(join(runDir, "stdout.log"))).toBe(true);
        expect(existsSync(join(runDir, "stderr.log"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});

// ---------------------------------------------------------------------------
// Refusals before any child.
// ---------------------------------------------------------------------------

describe("capture — usage and gate refusals launch no child", () => {
  test("usage errors exit 2 before creating an attempt", () => {
    const root = tmpRoot("mstar-sdd-ev-usage-");
    try {
      const f = evidenceFixture(root);
      const captureArgs = (requestFile: string, cwd: string, argv: string[] = counterArgv(f)) =>
        runCli(["sdd", "evidence", "capture", "--request", requestFile, "--", ...argv], { cwd });

      expect(runCli(["sdd", "evidence", "capture", "--", "true"], { cwd: f.feature }).exitCode).toBe(2);
      expect(captureArgs("relative-request.json", f.feature).exitCode).toBe(2);
      expect(captureArgs(join(root, "no-such.json"), f.feature).exitCode).toBe(2);
      const bad = join(root, "bad.json");
      writeFileSync(bad, "{ not json");
      expect(captureArgs(bad, f.feature).exitCode).toBe(2);

      const big = join(root, "big.json");
      writeFileSync(big, JSON.stringify({ ...f.request, coverage: { ...f.request.coverage, behavior: "x".repeat(520000) } }));
      expect(captureArgs(big, f.feature).exitCode).toBe(2);

      const missingKeys = join(root, "missing-keys.json");
      const { environmentKeys: _omitted, ...rest } = f.request;
      void _omitted;
      writeFileSync(missingKeys, JSON.stringify(rest));
      expect(captureArgs(missingKeys, f.feature).exitCode).toBe(2);

      const badKey = join(root, "bad-key.json");
      writeFileSync(badKey, JSON.stringify({ ...f.request, environmentKeys: ["NOPE"] }));
      expect(captureArgs(badKey, f.feature).exitCode).toBe(2);

      const emptyInputs = join(root, "empty-inputs.json");
      writeFileSync(emptyInputs, JSON.stringify({ ...f.request, inputs: [] }));
      expect(captureArgs(emptyInputs, f.feature).exitCode).toBe(2);

      const dupRoots = join(root, "dup-roots.json");
      writeFileSync(dupRoots, JSON.stringify({ ...f.request, inputs: [DECLARED_INPUTS[0], DECLARED_INPUTS[0]] }));
      expect(captureArgs(dupRoots, f.feature).exitCode).toBe(2);

      const overlap = join(root, "overlap.json");
      writeFileSync(overlap, JSON.stringify({ ...f.request, inputs: [...DECLARED_INPUTS, { path: "deps/lib.js", kind: "file", purpose: "dependency" }] }));
      expect(captureArgs(overlap, f.feature).exitCode).toBe(2);

      const absolute = join(root, "absolute.json");
      writeFileSync(absolute, JSON.stringify({ ...f.request, inputs: [{ path: "/etc/passwd", kind: "file", purpose: "config" }] }));
      expect(captureArgs(absolute, f.feature).exitCode).toBe(2);

      const glob = join(root, "glob.json");
      writeFileSync(glob, JSON.stringify({ ...f.request, inputs: [{ path: "src/*.js", kind: "file", purpose: "source" }] }));
      expect(captureArgs(glob, f.feature).exitCode).toBe(2);

      const zeroTimeout = join(root, "zero-timeout.json");
      writeFileSync(zeroTimeout, JSON.stringify({ ...f.request, timeoutMs: 0 }));
      expect(captureArgs(zeroTimeout, f.feature).exitCode).toBe(2);

      // Unknown request keys are a usage error BEFORE the child runs (not a
      // late finalization failure after execution).
      const unknownKey = join(root, "unknown-key.json");
      writeFileSync(unknownKey, JSON.stringify({ ...f.request, unrequested: true }));
      expect(captureArgs(unknownKey, f.feature).exitCode).toBe(2);

      // No durable attempt was created by any usage refusal.
      expect(existsSync(f.evidenceDir)).toBe(false);
      expect(existsSync(f.counterPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("wrong observed cwd is refused before the child (exit 1, nothing created)", () => {
    const root = tmpRoot("mstar-sdd-ev-cwd-");
    try {
      const f = evidenceFixture(root);
      const result = runCli(["sdd", "evidence", "capture", "--request", f.requestFile, "--", ...counterArgv(f)], { cwd: f.control });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("outside the feature worktree");
      expect(existsSync(f.evidenceDir)).toBe(false);
      expect(existsSync(f.counterPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("wrong feature branch is refused before the child (exit 1, nothing created)", () => {
    const root = tmpRoot("mstar-sdd-ev-branch-");
    try {
      const f = evidenceFixture(root);
      git(["checkout", "-q", "-b", "feature/detour"], f.feature);
      const result = runCli(["sdd", "evidence", "capture", "--request", f.requestFile, "--", ...counterArgv(f)], { cwd: f.feature });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("branch");
      expect(existsSync(f.evidenceDir)).toBe(false);
      expect(existsSync(f.counterPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("mismatched context declaration is refused (exit 2)", () => {
    const root = tmpRoot("mstar-sdd-ev-ctx-");
    try {
      const f = evidenceFixture(root);
      const wrong = join(root, "wrong-context.json");
      writeFileSync(wrong, JSON.stringify({ ...f.request, context: { ...f.request.context, planId: "other-plan" } }));
      const result = runCli(["sdd", "evidence", "capture", "--request", wrong, "--", ...counterArgv(f)], { cwd: f.feature });
      expect(result.exitCode).toBe(2);
      expect(existsSync(f.evidenceDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("capture writes only under the canonical control SDD dir", async () => {
    const root = tmpRoot("mstar-sdd-ev-canonical-");
    try {
      const f = evidenceFixture(root);
      const result = await captureDirect(f, counterArgv(f));
      const relative = listFilesRecursive(f.sddDir).map((p) => p.slice(f.sddDir.length + 1)).sort();
      expect(relative).toEqual([
        `evidence/${result.record.runId}/record.json`,
        `evidence/${result.record.runId}/stderr.log`,
        `evidence/${result.record.runId}/stdout.log`,
      ]);
      // No harness mirror under the feature checkout.
      expect(existsSync(join(f.feature, ".mstar"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("no environment dump: only selected keys (with null absence) are fingerprinted", async () => {
    const root = tmpRoot("mstar-sdd-ev-env-");
    try {
      const f = evidenceFixture(root);
      const sentinel = "MSTAR_EVIDENCE_SENTINEL_SECRET";
      const result = await captureDirect(f, counterArgv(f), { env: { [sentinel]: "do-not-dump", NODE_ENV: undefined } });
      const raw = readFileSync(join(result.runDir, "record.json"), "utf8");
      expect(raw).not.toContain(sentinel);
      expect(raw).not.toContain("do-not-dump");
      expect(result.record.before.environment).toEqual({ TZ: TZ_VALUE, NODE_ENV: null });
      expect(result.record.after!.environment).toEqual({ TZ: TZ_VALUE, NODE_ENV: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Read-only verification: artifact facts, integrity codes, applicability.
// ---------------------------------------------------------------------------

describe("verify — artifact integrity is read-only and code-exact", () => {
  test("collectEvidenceArtifacts reports missing/symlink/oversized facts without reading full oversized files", async () => {
    const root = tmpRoot("mstar-sdd-ev-facts-");
    try {
      const runDir = join(root, "run");
      mkdirSync(runDir);
      symlinkSync(join(root, "elsewhere.log"), join(runDir, "stdout.log"));
      const facts = await collectEvidenceArtifacts(runDir);
      expect(facts).toHaveLength(2);
      expect(facts[0]).toEqual({ path: "stdout.log", state: "symlink", bytes: null, sha256: null });
      expect(facts[1]).toEqual({ path: "stderr.log", state: "missing", bytes: null, sha256: null });

      const big = join(root, "big-run");
      mkdirSync(big);
      writeFileSync(join(big, "stdout.log"), Buffer.alloc(8388608 + 1024, 0x61));
      writeFileSync(join(big, "stderr.log"), "");
      const bigFacts = await collectEvidenceArtifacts(big);
      expect(bigFacts[0]).toEqual({ path: "stdout.log", state: "regular", bytes: 8388608 + 1024, sha256: null });
      expect(bigFacts[1]).toEqual({ path: "stderr.log", state: "regular", bytes: 0, sha256: sha256("") });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("altered log content fails integrity with the exact hash code; missing log fails with the missing code", async () => {
    const root = tmpRoot("mstar-sdd-ev-damage-");
    try {
      const f = evidenceFixture(root);
      const result = await captureDirect(f, counterArgv(f));

      // Alter stdout.log after capture.
      const stdoutPath = join(result.runDir, "stdout.log");
      writeFileSync(stdoutPath, readFileSync(stdoutPath).toString() + "tampered\n");
      const facts = await collectEvidenceArtifacts(result.runDir);
      const gate = verifySddEvidence(readRecord(result.runDir), facts, { planId: PLAN_ID, taskId: TASK_ID, runId: result.record.runId });
      expect(gate.ok).toBe(false);
      expect(gate.violations.map((v) => v.code)).toContain("evidence.artifact.hash");

      // Missing stderr.log after restore of stdout.
      writeFileSync(stdoutPath, readFileSync(stdoutPath).toString().replace("tampered\n", ""));
      rmSync(join(result.runDir, "stderr.log"));
      const facts2 = await collectEvidenceArtifacts(result.runDir);
      const gate2 = verifySddEvidence(readRecord(result.runDir), facts2, { planId: PLAN_ID, taskId: TASK_ID, runId: result.record.runId });
      expect(gate2.ok).toBe(false);
      expect(gate2.violations.map((v) => v.code)).toContain("evidence.artifact.missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("verify never mutates the fixture, Git state, bundle or counter (read-only)", async () => {
    const root = tmpRoot("mstar-sdd-ev-readonly-");
    try {
      const f = evidenceFixture(root);
      const result = await captureDirect(f, counterArgv(f));
      const snapshotState = () => ({
        counter: readFileSync(f.counterPath, "utf8"),
        argvRecord: sha256(readFileSync(f.argvRecordPath)),
        record: sha256(readFileSync(join(result.runDir, "record.json"))),
        stdout: sha256(readFileSync(join(result.runDir, "stdout.log"))),
        stderr: sha256(readFileSync(join(result.runDir, "stderr.log"))),
        sddListing: listFilesRecursive(f.sddDir).join("\n"),
        status: git(["status", "--porcelain"], f.feature),
        childView: readFileSync(f.argvRecordPath, "utf8"),
      });
      const before = snapshotState();

      const noTarget = verifyCli(f, result.record.runId);
      expect(noTarget.exitCode).toBe(0);
      const target = targetFileFor(root, f.feature, f.head);
      const withTarget = verifyCli(f, result.record.runId, { target });
      expect(withTarget.exitCode).toBe(0);
      expect(JSON.parse(withTarget.stdout).applicability).toBe("candidate");

      expect(snapshotState()).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Target applicability lanes.
// ---------------------------------------------------------------------------

describe("verify — target applicability", () => {
  test(
    "equal inputs in the same repository with reviewed declaration is a candidate (exit 0)",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-cand-");
      try {
        const f = evidenceFixture(root);
        // Selected env must be identical on both lanes (capture + verify):
        // pin NODE_ENV explicitly instead of relying on the runner's value.
        const env = { NODE_ENV: "EVIDENCE_NODE_ENV" };
        const result = await captureDirect(f, counterArgv(f), { env });
        const target = targetFileFor(root, f.feature, f.head);
        const verify = verifyCli(f, result.record.runId, { target, env });
        expect(verify.exitCode).toBe(0);
        const assessment = JSON.parse(verify.stdout) as { applicability: string; outcome: string; reasons: string[]; changedInputs: string[] };
        expect(assessment.applicability).toBe("candidate");
        expect(assessment.outcome).toBe("passed");
        expect(assessment.reasons).toContain("reuse.candidate");
        expect(assessment.changedInputs).toEqual([]);
        expect(verify.stderr).toContain("reuse candidate; coverage review required");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  test("expected-head mismatch is uncertain with the explicit reason (exit 1)", async () => {
    const root = tmpRoot("mstar-sdd-ev-head-");
    try {
      const f = evidenceFixture(root);
      const result = await captureDirect(f, counterArgv(f));
      const wrongHead = "0".repeat(40);
      const target = targetFileFor(root, f.feature, wrongHead);
      const verify = verifyCli(f, result.record.runId, { target });
      expect(verify.exitCode).toBe(1);
      const assessment = JSON.parse(verify.stdout) as { applicability: string; reasons: string[] };
      expect(assessment.applicability).toBe("uncertain");
      expect(assessment.reasons).toContain("target.expected-head-mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("identical bytes in a different repository are uncertain with $repository disclosure", async () => {
    const root = tmpRoot("mstar-sdd-ev-repo-");
    try {
      const f = evidenceFixture(root);
      const result = await captureDirect(f, counterArgv(f));
      // Second repo with identical declared-input bytes.
      const other = join(root, "other-repo");
      mkdirSync(other);
      git(["init", "-q"], other);
      git(["config", "user.email", "sdd-evidence-test@example.com"], other);
      git(["config", "user.name", "SDD Evidence Test"], other);
      mkdirSync(join(other, "src"));
      mkdirSync(join(other, "tests"));
      mkdirSync(join(other, "deps"));
      writeFileSync(join(other, "src", "app.js"), "export const app = 'fixture-v1';\n");
      writeFileSync(join(other, "config.json"), '{"feature":"evidence","level":1}\n');
      writeFileSync(join(other, "tests", "unit.js"), "test('unit', () => {});\n");
      writeFileSync(join(other, "deps", "lib.js"), "export const lib = 'dep-v1';\n");
      git(["add", "-A"], other);
      git(["commit", "-q", "-m", "other base"], other);
      const otherHead = git(["rev-parse", "HEAD"], other);

      const target = targetFileFor(root, other, otherHead);
      const verify = verifyCli(f, result.record.runId, { target });
      expect(verify.exitCode).toBe(1);
      const assessment = JSON.parse(verify.stdout) as { applicability: string; reasons: string[]; changedInputs: string[] };
      expect(assessment.applicability).toBe("uncertain");
      expect(assessment.reasons).toContain("input.repository");
      expect(assessment.changedInputs).toContain("$repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test(
    "changed and missing declared inputs are known differences (changed), including explicit missing entries",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-changed-");
      try {
        const f = evidenceFixture(root);
        const result = await captureDirect(f, counterArgv(f), { env: { NODE_ENV: undefined } });

        // Known content change in a declared input.
        writeFileSync(join(f.feature, "src", "app.js"), "export const app = 'fixture-v2';\n");
        const target1 = targetFileFor(root, f.feature, f.head);
        const verify1 = verifyCli(f, result.record.runId, { target: target1 });
        expect(verify1.exitCode).toBe(1);
        const assessment1 = JSON.parse(verify1.stdout) as { applicability: string; changedInputs: string[] };
        expect(assessment1.applicability).toBe("changed");
        expect(assessment1.changedInputs).toContain("src/app.js");

        // A declared root that disappeared is an explicit missing entry ⇒ changed.
        rmSync(join(f.feature, "deps", "lib.js"));
        const target2 = targetFileFor(root, f.feature, f.head);
        const verify2 = verifyCli(f, result.record.runId, { target: target2 });
        expect(verify2.exitCode).toBe(1);
        const assessment2 = JSON.parse(verify2.stdout) as { applicability: string; changedInputs: string[] };
        expect(assessment2.applicability).toBe("changed");
        expect(assessment2.changedInputs).toContain("deps/lib.js");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  test(
    "a wholly-missing declared root is an explicit missing entry and its appearance is a known difference (changed)",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-missingroot-");
      try {
        const f = evidenceFixture(root);
        const request = buildRequest(f, {
          inputs: [...DECLARED_INPUTS, { path: "ghost", kind: "directory", purpose: "fixture" }],
        });
        const result = await captureDirect(f, counterArgv(f), { request, env: { NODE_ENV: undefined } });

        // Absent at capture: an explicit missing entry with null facts in the
        // retained snapshot — distinct from a member disappearing inside a
        // declared directory root.
        expect(result.record.before.entries).toContainEqual({
          path: "ghost",
          kind: "missing",
          sha256: null,
          bytes: null,
          executable: null,
          linkText: null,
          resolvedRelativePath: null,
          error: null,
        });
        expect(result.record.before.stable).toBe(true);

        // The root existing in the target checkout is a known difference ⇒ changed.
        mkdirSync(join(f.feature, "ghost"));
        const target = targetFileFor(root, f.feature, f.head);
        const verify = verifyCli(f, result.record.runId, { target });
        expect(verify.exitCode).toBe(1);
        const assessment = JSON.parse(verify.stdout) as { applicability: string; changedInputs: string[] };
        expect(assessment.applicability).toBe("changed");
        expect(assessment.changedInputs).toContain("ghost");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );

  test("unknown coverage declaration is a noncandidate even with equal inputs", async () => {
    const root = tmpRoot("mstar-sdd-ev-unknown-");
    try {
      const f = evidenceFixture(root);
      const request = buildRequest(f, { coverage: { ...f.request.coverage, declaration: "unknown" } });
      const result = await captureDirect(f, counterArgv(f), { request, env: { NODE_ENV: undefined } });
      const target = targetFileFor(root, f.feature, f.head);
      const verify = verifyCli(f, result.record.runId, { target });
      expect(verify.exitCode).toBe(1);
      const assessment = JSON.parse(verify.stdout) as { applicability: string; reasons: string[] };
      expect(assessment.applicability).toBe("uncertain");
      expect(assessment.reasons).toContain("coverage.unknown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("unreadable declared input hashes are unknowns and never produce a candidate", async () => {
    const root = tmpRoot("mstar-sdd-ev-unreadable-");
    try {
      const f = evidenceFixture(root);
      const unreadable = join(f.feature, "deps", "lib.js");
      chmodSync(unreadable, 0o000);
      let result: Awaited<ReturnType<typeof captureDirect>> | null = null;
      try {
        result = await captureDirect(f, counterArgv(f), { env: { NODE_ENV: undefined } });
      } finally {
        chmodSync(unreadable, 0o644);
      }
      expect(result).not.toBeNull();
      // The child still ran with uncertain input provenance.
      expect(JSON.parse(readFileSync(f.counterPath, "utf8"))).toEqual({ count: 1 });
      const unknownEntry = result!.record.before.entries.find((entry) => entry.path === "deps/lib.js");
      expect(unknownEntry!.kind).toBe("unknown");
      expect(unknownEntry!.error).not.toBeNull();

      const target = targetFileFor(root, f.feature, f.head);
      const verify = verifyCli(f, result!.record.runId, { target });
      expect(verify.exitCode).toBe(1);
      const assessment = JSON.parse(verify.stdout) as { applicability: string; reasons: string[] };
      expect(assessment.applicability).toBe("uncertain");
      expect(assessment.reasons).toContain("input.unknown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("verify usage errors exit 2; record IO failures emit a structured non-success assessment", async () => {
    const root = tmpRoot("mstar-sdd-ev-usage2-");
    try {
      const f = evidenceFixture(root);
      const result = await captureDirect(f, counterArgv(f));

      const missingArgs = runCli(["sdd", "evidence", "verify", "--sdd-dir", f.sddDir, "--plan", PLAN_ID], { cwd: f.control });
      expect(missingArgs.exitCode).toBe(2);
      const relativeSdd = runCli(
        ["sdd", "evidence", "verify", "--sdd-dir", "relative/sdd", "--plan", PLAN_ID, "--task", TASK_ID, "--run", result.record.runId],
        { cwd: f.control },
      );
      expect(relativeSdd.exitCode).toBe(2);
      const badRun = verifyCli(f, "not-a-uuid");
      expect(badRun.exitCode).toBe(2);
      const badTarget = verifyCli(f, result.record.runId, { target: join(root, "no-such-target.json") });
      expect(badTarget.exitCode).toBe(2);
      const badHead = join(root, "bad-head.json");
      writeFileSync(badHead, JSON.stringify({ cwd: f.feature, expectedHead: "nothex", rationale: "r" }));
      expect(verifyCli(f, result.record.runId, { target: badHead }).exitCode).toBe(2);

      // Unknown run id: structured assessment, exit 1, non-empty stdout.
      const foreignUuid = "00000000-0000-4000-8000-000000000000";
      const missingRun = verifyCli(f, foreignUuid);
      expect(missingRun.exitCode).toBe(1);
      const assessment = JSON.parse(missingRun.stdout) as { integrity: { ok: boolean }; outcome: string; applicability: string };
      expect(assessment.integrity.ok).toBe(false);
      expect(assessment.applicability).toBe("uncertain");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// Canonical sdd-dir containment (verify).
// ---------------------------------------------------------------------------

describe("verify — canonical sdd-dir containment", () => {
  test(
    "a bundle copied to a different control root is refused (exit 2); verifying in place still passes",
    async () => {
      const root = tmpRoot("mstar-sdd-ev-relocate-");
      try {
        const f = evidenceFixture(root);
        // Selected env must be identical on both lanes (capture + verify).
        const env = { NODE_ENV: "EVIDENCE_NODE_ENV" };
        const result = await captureDirect(f, counterArgv(f), { env });
        const target = targetFileFor(root, f.feature, f.head);

        // In place: the canonical location recorded at capture time still verifies.
        const inPlace = verifyCli(f, result.record.runId, { target, env });
        expect(inPlace.exitCode).toBe(0);
        expect((JSON.parse(inPlace.stdout) as { applicability: string }).applicability).toBe("candidate");

        // The same bundle copied to another control root with the layout
        // preserved (basename still the plan id, parent still "sdd") must be
        // refused before any assessment; stdout stays empty (no JSON verdict).
        const relocatedSdd = join(root, "elsewhere", "sdd", PLAN_ID);
        mkdirSync(relocatedSdd, { recursive: true });
        cpSync(join(f.sddDir, "evidence"), join(relocatedSdd, "evidence"), { recursive: true });
        const relocated = verifyCli(f, result.record.runId, { target, sddDir: relocatedSdd, env });
        expect(relocated.exitCode).toBe(2);
        expect(relocated.stdout).toBe("");
        expect(relocated.stderr).toContain("canonical");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});

// ---------------------------------------------------------------------------
// collectEvidenceInputs budgets and usage.
// ---------------------------------------------------------------------------

interface BudgetDir {
  root: string;
  tool: string;
  toolBytes: number;
  b1: string;
  b2: string;
  e: string;
  s: string;
}

function budgetFixture(root: string): BudgetDir {
  const dir = join(root, "budget");
  mkdirSync(join(dir, "e"), { recursive: true });
  mkdirSync(join(dir, "s"), { recursive: true });
  const tool = join(dir, "tool.mjs");
  const toolBody = "process.exit(0);\n";
  writeFileSync(tool, toolBody);
  writeFileSync(join(dir, "b1.txt"), "b".repeat(40));
  writeFileSync(join(dir, "b2.txt"), "c".repeat(1000));
  for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, "e", `f${i}.txt`), "e".repeat(10));
  for (let i = 0; i < 50; i += 1) writeFileSync(join(dir, "s", `f${String(i).padStart(2, "0")}.txt`), "s".repeat(10));
  return { root: dir, tool, toolBytes: Buffer.byteLength(toolBody), b1: join(dir, "b1.txt"), b2: join(dir, "b2.txt"), e: join(dir, "e"), s: join(dir, "s") };
}

function budgetLimits(overrides: Partial<EvidenceLimits>): EvidenceLimits {
  return {
    timeoutMs: 1000,
    maxLogBytesPerStream: 1024,
    maxInputBytes: 536870912,
    maxInputEntries: 10000,
    maxInputMs: 5000,
    maxSnapshotBytes: 2097152,
    ...overrides,
  };
}

describe("collectEvidenceInputs — bounded collection", () => {
  test("tool + roots share the two-pass byte allowance; both passes stop identically and stay stable", async () => {
    const root = tmpRoot("mstar-sdd-ev-bytes-");
    try {
      const b = budgetFixture(root);
      const snapshot = await collectEvidenceInputs({
        cwd: b.root,
        inputs: [
          { path: "b1.txt", kind: "file", purpose: "fixture" },
          { path: "b2.txt", kind: "file", purpose: "fixture" },
        ],
        argv: [b.tool],
        environmentKeys: [],
        limits: budgetLimits({ maxInputBytes: 2 * (b.toolBytes + 40 + 16) }),
      });
      const b1 = snapshot.entries.find((entry) => entry.path === "b1.txt");
      const b2 = snapshot.entries.find((entry) => entry.path === "b2.txt");
      expect(b1!.kind).toBe("file");
      expect(b1!.sha256).toBe(sha256(readFileSync(b.b1)));
      expect(b2!.kind).toBe("unknown");
      expect(b2!.error).toContain("input.limit.bytes");
      expect(snapshot.unknowns.join("\n")).toContain("input.limit.bytes");
      expect(snapshot.stable).toBe(true);
      expect(snapshot.digest).toBe(evidenceInputDigest(snapshot));
      expect(snapshot.tool.sha256).toBe(sha256(readFileSync(b.tool)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("entry enumeration stops within the budget without reading an unbounded directory", async () => {
    const root = tmpRoot("mstar-sdd-ev-entries-");
    try {
      const b = budgetFixture(root);
      const snapshot = await collectEvidenceInputs({
        cwd: b.root,
        inputs: [{ path: "e", kind: "directory", purpose: "test" }],
        argv: [b.tool],
        environmentKeys: [],
        limits: budgetLimits({ maxInputEntries: 6 }),
      });
      expect(snapshot.entries).toHaveLength(3); // root dir + two children
      expect(snapshot.entries[0]!.path).toBe("e");
      expect(snapshot.entries.map((entry) => entry.path)).not.toContain("e/f2.txt");
      expect(snapshot.unknowns.join("\n")).toContain("input.limit.entries");
      expect(snapshot.stable).toBe(true);
      expect(snapshot.digest).toBe(evidenceInputDigest(snapshot));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("snapshot-byte cap keeps the snapshot representable with an explicit limit unknown", async () => {
    const root = tmpRoot("mstar-sdd-ev-snapcap-");
    try {
      const b = budgetFixture(root);
      const call = (maxSnapshotBytes: number) =>
        collectEvidenceInputs({
          cwd: b.root,
          inputs: [{ path: "s", kind: "directory", purpose: "test" }],
          argv: [b.tool],
          environmentKeys: [],
          limits: budgetLimits({ maxSnapshotBytes }),
        });
      const fullyCapped = await call(262144);
      expect(fullyCapped.entries).toHaveLength(0);
      expect(fullyCapped.unknowns.join("\n")).toContain("input.limit.snapshot-bytes");
      expect(fullyCapped.digest).toBe(evidenceInputDigest(fullyCapped));

      const partiallyCapped = await call(262144 + 5000);
      expect(partiallyCapped.entries.length).toBeGreaterThan(0);
      expect(partiallyCapped.entries.length).toBeLessThan(51);
      expect(partiallyCapped.unknowns.join("\n")).toContain("input.limit.snapshot-bytes");
      expect(partiallyCapped.digest).toBe(evidenceInputDigest(partiallyCapped));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("malformed collector options reject with usage exit 2 before collection", async () => {
    const root = tmpRoot("mstar-sdd-ev-limitusage-");
    try {
      const b = budgetFixture(root);
      const call = (limits: EvidenceLimits, inputs: EvidenceCaptureRequest["inputs"] = [{ path: "b1.txt", kind: "file", purpose: "fixture" }], argv: string[] = [b.tool], environmentKeys: string[] = []) =>
        collectEvidenceInputs({ cwd: b.root, inputs, argv, environmentKeys, limits });
      const cases: EvidenceLimits[] = [
        budgetLimits({ maxInputBytes: 1 }), // total must be at least 2
        budgetLimits({ maxInputEntries: 1 }),
        budgetLimits({ maxInputBytes: 536870913 }), // over the v1 ceiling
        budgetLimits({ maxInputEntries: 10001 }),
        budgetLimits({ maxInputMs: 30001 }),
        budgetLimits({ maxInputMs: 0 }),
        budgetLimits({ maxSnapshotBytes: 262143 }), // below the representability floor
        budgetLimits({ maxSnapshotBytes: 2097153 }),
        budgetLimits({ maxLogBytesPerStream: 0 }),
        budgetLimits({ timeoutMs: 0 }),
        budgetLimits({ timeoutMs: 3600001 }),
      ];
      for (const limits of cases) {
        let error: Error | null = null;
        try {
          await call(limits);
        } catch (err) {
          error = err as Error;
        }
        expect(error).not.toBeNull();
        expect((error as { exitCode?: number }).exitCode).toBe(2);
      }
      for (const bad of [
        { inputs: [] },
        { inputs: [{ path: "b1.txt", kind: "file", purpose: "fixture" }, { path: "b1.txt", kind: "file", purpose: "fixture" }] },
        { inputs: [{ path: "/abs/x", kind: "file", purpose: "fixture" }] },
        { inputs: [{ path: "b*.txt", kind: "file", purpose: "fixture" }] },
        { environmentKeys: ["NOPE"] },
        { environmentKeys: ["TZ", "TZ"] },
        { argv: [] },
      ] as Array<Partial<{ inputs: EvidenceCaptureRequest["inputs"]; environmentKeys: string[]; argv: string[] }>>) {
        let error: Error | null = null;
        try {
          await call(budgetLimits(), bad.inputs, bad.argv, bad.environmentKeys);
        } catch (err) {
          error = err as Error;
        }
        expect(error).not.toBeNull();
        expect((error as { exitCode?: number }).exitCode).toBe(2);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
