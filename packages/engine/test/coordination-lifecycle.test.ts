/**
 * Engine coordinator plan coordination — the shared Git read's failure
 * classification (§D2).
 *
 * The FILE execution route is retired: the iteration/standalone/report-only
 * completion routes and the file-route scope machinery are gone, superseded by
 * the ACTIVE route's own completion suites. What remains here is the shared
 * `gitRead` subprocess classification every route's proof machinery depends on:
 * a Git read that never answers is unavailable evidence, not a repository
 * answer. Each case drives the real child with an isolated `PATH`; no case reads
 * or writes this checkout's control store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRead } from "../src/coordination.js";
import { sleep } from "./support/coordination-fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** How long a case child may run before the test kills and reaps it. */
const CHILD_DEADLINE_MS = 60_000;

/** What the child prints: the read's answer or the surfaced error shape. */
type ChildReadReport = { answer?: string | null; code?: string; message?: string; cause?: string; details?: { path?: string } };

function newRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function writeExecutable(path: string, lines: string[]): void {
  Bun.write(path, `${lines.join("\n")}\n`);
  chmodSync(path, 0o755);
}

/**
 * The fixture `git`: records every invocation and delegates to the real Git
 * binary, handling only the read's target invocation with the given body — so
 * the child really resolves `git` through its isolated PATH.
 */
function writeFixtureGit(binDir: string, recordPath: string, targetCwd: string, targetBody: string[]): void {
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("fixture delegation shim needs a real git on the runner PATH");
  writeExecutable(join(binDir, "git"), [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(recordPath)}`,
    `if [ "$1" = "-C" ] && [ "$2" = ${JSON.stringify(targetCwd)} ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then`,
    ...targetBody.map((line) => `  ${line}`),
    "fi",
    `exec ${JSON.stringify(realGit)} "$@"`,
  ]);
}

/**
 * Run one `gitRead` in a child process with `PATH` pointing only at `binDir`,
 * and report the answer or the surfaced error shape (code, cause, message) as
 * one JSON line.
 */
async function readInChildWithBinDir(targetCwd: string, binDir: string): Promise<{ report: ChildReadReport; stderr: string; elapsedMs: number }> {
  const root = newRoot("mstar-gitread-");
  const scriptPath = join(root, "child-read.ts");
  Bun.write(scriptPath, [
    `import { gitRead } from ${JSON.stringify(join(import.meta.dir, "..", "src", "coordination.ts"))};`,
    `const [targetCwd] = process.argv.slice(2);`,
    `try {`,
    `  const answer = gitRead(targetCwd, ["rev-parse", "HEAD"]);`,
    `  console.log(JSON.stringify({ answer: answer === undefined ? null : answer }));`,
    `} catch (error) {`,
    `  const code = (error as { code?: unknown } | null)?.code;`,
    `  const details = (error as { details?: unknown } | null)?.details as { cause?: unknown; path?: unknown } | undefined;`,
    `  const cause = details?.cause;`,
    `  console.log(JSON.stringify({`,
    `    code: typeof code === "string" ? code : undefined,`,
    `    message: error instanceof Error ? error.message : String(error),`,
    `    cause: typeof cause === "string" ? cause : undefined,`,
    `    details: details ? { path: typeof details.path === "string" ? details.path : undefined } : undefined,`,
    `  }));`,
    `}`,
    ``,
  ].join("\n"));

  const startedAt = Date.now();
  const child = Bun.spawn([process.execPath, scriptPath, targetCwd], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: binDir },
  });
  const exitedInTime = await Promise.race([child.exited.then(() => true), sleep(CHILD_DEADLINE_MS).then(() => false)]);
  if (!exitedInTime) child.kill();
  const exitCode = await child.exited;
  const elapsedMs = Date.now() - startedAt;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(exitCode, `child stderr: ${stderr}\nchild stdout: ${stdout}`).toBe(0);
  return { report: JSON.parse(stdout) as ChildReadReport, stderr, elapsedMs };
}

describe("gitRead subprocess failure classification", () => {
  test("a non-zero git exit stays a repository fact (not an environment failure)", async () => {
    const root = newRoot("mstar-gitread-nonzero-");
    const binDir = join(root, "bin-nonzero");
    const recordPath = join(root, "shim-invocations.log");
    mkdirSync(binDir);
    writeFixtureGit(binDir, recordPath, root, ["exit 3"]);

    const { report } = await readInChildWithBinDir(root, binDir);

    // The isolated PATH really was in effect, and the read reached the fixture git.
    expect(readFileSync(recordPath, "utf8")).toContain("-C " + root + " rev-parse HEAD");
    // `git` answered with a numeric status, so `gitRead` resolves `undefined`
    // rather than the environment code.
    expect(report.answer).toBeNull();
    expect(report.code).toBeUndefined();
  }, 90_000);

  test("a git read that outlives the production timeout is refused as git-unavailable", async () => {
    const root = newRoot("mstar-gitread-hang-");
    const binDir = join(root, "bin-hanging");
    const recordPath = join(root, "shim-invocations.log");
    mkdirSync(binDir);
    const hangScript = join(root, "hang-forever.js");
    Bun.write(hangScript, "setInterval(() => {}, 600000);\n");
    writeFixtureGit(binDir, recordPath, root, [
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(hangScript)}`,
    ]);

    const { report, elapsedMs } = await readInChildWithBinDir(root, binDir);

    expect(readFileSync(recordPath, "utf8")).toContain("-C " + root + " rev-parse HEAD");
    // The refusal came from the production timeout firing, not an instant failure.
    expect(elapsedMs).toBeGreaterThanOrEqual(9_000);
    expect(elapsedMs).toBeLessThan(CHILD_DEADLINE_MS);
    expect(report.code).toBe("coordination.git-unavailable");
    expect(report.cause).toContain("git did not answer within 10000ms");
  }, 90_000);

  test("a missing git executable is refused as git-unavailable at the read", async () => {
    const root = newRoot("mstar-gitread-empty-");
    const binDir = join(root, "bin-empty");
    mkdirSync(binDir);

    const { report } = await readInChildWithBinDir(root, binDir);

    expect(report.code).toBe("coordination.git-unavailable");
    expect(report.code).not.toBe("coordination.git-proof");
    expect(report.cause).toContain("ENOENT");
    expect(report.message).toContain("Git state cannot be read. Inspect workflow registration with mstar status validate.");
    expect(report.details?.path).toBe(root);
  }, 90_000);
});
