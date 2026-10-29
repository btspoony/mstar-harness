/**
 * CLI `mstar iteration register` — the iteration workflow registration verb
 * (seam S1 sibling of `mstar workflow register`, engine-backed).
 *
 * Thin wrapper over engine `registerIterationWorkflow` (create-only
 * `type: iteration` snapshot + root `workflows[]` entry under one root lock).
 * Contract pinned here:
 * - exit 0: an iteration registers end to end — root entry + snapshot on
 *   disk, both documents pass `mstar status validate`, and the registered
 *   workflow accepts a coordinator binding (`plan bind --coordinator`).
 * - exit 1: engine/IO refusals — hostile workflow id and domain-invalid rows
 *   (duplicate ids, missing fields, a supplied row status).
 * - exit 2: usage — omitted/blank required flags, malformed/non-object row
 *   JSON, unknown flags, missing option values, excess arguments. Help
 *   remains exit 0.
 *
 * Every case runs the real CLI as a subprocess against an isolated temp
 * fixture harness — no live harness is ever touched.
 */
import { describe, expect, test } from "bun:test";
import { initializeStore, openStore, readExecutionState, registerCatalogEntity, type ExecutionState } from "@mstar-harness/engine";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CLI_ROOT = resolve(import.meta.dir, "..");
const SRC_ENTRY = join(CLI_ROOT, "src/index.ts");
const WORKFLOW_ID = "20260918-iteration-register-cli";
const COMPASS_REF = "iterations/20260918-iteration-register-cli/delivery-compass.md";
/** Shared subprocess identity: a coordinator binds only through its creating session. */
const FIXTURE_SESSION_ID = "0f0e0d0c-0b0a-4901-8a7b-000000000001";
/** Invalid-input coverage spawns many CLI processes; avoid the 5s default under CI load. */
const MULTI_CLI_TEST_TIMEOUT_MS = 120_000;

/** The reviewed compass frontmatter of one iteration (the mstar-iteration §1.3 field set). */
function compassFrontmatter(iterationId: string): string {
  return "---\n" +
    `iteration_id: ${iterationId}\n` +
    "start_date: 2026-09-18\n" +
    "status: active\n" +
    "iteration_base_branch: main\n" +
    "target_branch: main\n" +
    "---\n";
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface CommandEnvelope {
  command: string;
  status: "ok" | "refused" | "usage";
  code: string;
  exitCode: number;
  message?: string;
  data?: unknown;
}

function envelope(result: RunResult): CommandEnvelope {
  return JSON.parse(result.stdout) as CommandEnvelope;
}

function message(result: RunResult): string {
  return envelope(result).message ?? "";
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
    if (key === "DSH_SESSION_ID") continue;
    if (value !== undefined) env[key] = value;
  }
  env.MSTAR_HOST_SESSION_ID = FIXTURE_SESSION_ID;
  return env;
}

function runCli(args: string[], cwd = CLI_ROOT): RunResult {
  const proc = Bun.spawnSync([process.execPath, "run", SRC_ENTRY, ...args], {
    cwd,
    env: cliEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function row(id: string): string {
  return JSON.stringify({ id, title: `Plan ${id}`, file: `plans/${id}.md` });
}

function registerArgs(harness: string, extra: string[] = [], compassRef = COMPASS_REF, workflowId = WORKFLOW_ID): string[] {
  return [
    "iteration",
    "register",
    "--workflow",
    workflowId,
    "--compass-ref",
    compassRef,
    "--branch-base",
    "main",
    "--branch-integration",
    "feature/20260918-iteration-register-cli-integrate",
    "--branch-target-iteration",
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
async function setupHarness(fn: (harness: string, paths: { root: string; snapshot: string }) => void | Promise<void>): Promise<void> {
  const harness = mkdtempSync(join(tmpdir(), "mstar-iteration-register-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: harness, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture source"], { cwd: harness, stdio: "ignore" });
  // Contract §4: the row pointers are resolved against `{PLAN_DIR}` and the
  // declaration is read, so the fixture owns the registered plan markdown.
  mkdirSync(join(harness, "plans"), { recursive: true });
  for (const id of ["20260918-plan-alpha", "20260918-plan-beta", "20260918-plan-gamma"]) {
    writeFileSync(join(harness, "plans", `${id}.md`), `# Plan ${id}\n\n**plan_id:** ${id}\n`);
  }
  // Registration proves the named document IS this iteration's reviewed
  // compass, so the fixture states one like any real registration does.
  mkdirSync(dirname(join(harness, COMPASS_REF)), { recursive: true });
  writeFileSync(join(harness, COMPASS_REF), `${compassFrontmatter(WORKFLOW_ID)}\n# Iteration compass\n`);
  // Contract §3: registration goes through the catalog journal, which requires
  // an initialized ACTIVE store — the fixture provisions one. Registration also
  // writes `iteration belongs-to project` links, and a catalog relation may not
  // dangle, so the named project is registered like any real workspace does.
  await initializeStore({ harnessDir: harness }).then((handle) => handle.close());
  await registerCatalogEntity(
    { harnessDir: harness },
    { kind: "project", id: "engine", title: "engine", rootKind: "projects", relativePath: "engine" },
    { actor: "project-manager", operationId: "fixture-register-project-engine" },
  );
  expect(existsSync(join(harness, "store.db"))).toBe(true);
  try {
    await fn(harness, {
      root: join(harness, "status.json"),
      snapshot: join(harness, "workflows", WORKFLOW_ID, "snapshot.json"),
    });
  } finally {
    rmSync(harness, { recursive: true, force: true });
  }
}

/**
 * One read open settles the WAL side files: a read-only open right after a
 * writer close (initializeStore or a CLI subprocess) can otherwise refuse
 * `store.corrupt` while the -wal/-shm pair is still on disk (Bun 1.4.0). The
 * just-closed writer's deferred cleanup can race the first read open, so a
 * `store.corrupt` (SQLITE_CANTOPEN) read retries briefly before giving up.
 */
async function registeredState(harness: string): Promise<ExecutionState> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await openStore({ harnessDir: harness }, "read").then((handle) => handle.close());
      return await readExecutionState({ harnessDir: harness });
    } catch (error) {
      lastError = error;
      if ((error as { code?: string }).code !== "store.corrupt") throw error;
      // Real-time backoff is required here: the competing writer is an exited
      // external CLI subprocess whose deferred WAL cleanup exposes no signal,
      // so no event or fake timer can deterministically order this retry.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
    }
  }
  throw lastError;
}

describe("mstar iteration register", () => {
  test("registers an iteration end to end: root entry + snapshot, both validate (exit 0)", async () => {
    await setupHarness(async (harness, { root, snapshot }) => {
      const result = runCli(registerArgs(harness));
      expect(result.exitCode).toBe(0);
      expect(envelope(result)).toMatchObject({ command: "iteration.register", status: "ok", code: "iteration.register.ok" });

      // DB-only route: the retired file artifacts are never written.
      expect(existsSync(snapshot)).toBe(false);
      expect(existsSync(root)).toBe(false);

      const registered = await registeredState(harness);
      const view = registered.data.workflows[0]!;
      expect(view.state).toMatchObject({
        schema_version: 1,
        id: WORKFLOW_ID,
        type: "iteration",
        status: "running",
        compass_ref: COMPASS_REF,
        project: "engine",
      });
      expect(view.state.branch).toEqual({
        base: "main",
        integration: "feature/20260918-iteration-register-cli-integrate",
        target: "main",
      });
      expect(view.plans.map((item) => item.plan)).toEqual([
        {
          id: "20260918-plan-alpha",
          title: "Plan 20260918-plan-alpha",
          file: realpathSync(join(harness, "plans", "20260918-plan-alpha.md")),
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
          file: realpathSync(join(harness, "plans", "20260918-plan-beta.md")),
          status: "Todo",
          metadata: {
            iteration_refs: [COMPASS_REF],
            spec_integration_branch: "feature/20260918-iteration-register-cli-integrate",
            merge_target: "feature/20260918-iteration-register-cli-integrate",
          },
        },
      ]);
      expect(registered.data.root.workflows).toEqual([
        { id: WORKFLOW_ID, type: "iteration", started_at: "2026-09-18T00:00:00.000Z", dir: `workflows/${WORKFLOW_ID}` },
      ]);
    });
  });

  test("the registered workflow accepts a coordinator binding (exit 0)", async () => {
    await setupHarness(async (harness) => {
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const bind = runCli(["plan", "bind", "--coordinator", "--execution", "--workflow", WORKFLOW_ID, "--harness", harness, "--session-id", FIXTURE_SESSION_ID], harness);
      expect(bind.exitCode).toBe(0);
      const payload = envelope(bind).data;
      if (!payload || typeof payload !== "object" || !("data" in payload)) throw new Error("bind receipt carries no session record");
      const session = payload.data;
      if (!session || typeof session !== "object" || !("role" in session) || !("workflowId" in session)) throw new Error("bind receipt carries no session record");
      expect(session.role).toBe("coordinator");
      expect(session.workflowId).toBe(WORKFLOW_ID);
    });
  });
  test("an exact retry replays the same ACTIVE registration without changing state", async () => {
    await setupHarness(async (harness) => {
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const before = await registeredState(harness);

      const retry = runCli(registerArgs(harness));
      expect(retry.exitCode).toBe(0);
      expect(envelope(retry)).toMatchObject({ command: "iteration.register", status: "ok", code: "iteration.register.ok" });
      expect(await registeredState(harness)).toEqual(before);
    });
  });

  test("a committed registration replays through the CLI once its compass is deleted", async () => {
    await setupHarness(async (harness) => {
      // A pointer that escapes the harness root is the producer's refusal now:
      // the transport only checks the flag's shape, so the real-path
      // containment proof decides (PR #578).
      const escaping = runCli(registerArgs(harness, ["--compass-ref", "../outside-compass.md"]));
      expect(escaping.exitCode).toBe(1);
      expect(message(escaping)).toContain("[catalog.registration-invalid]");

      const operation = ["--operation", "op-iteration-register-compass-deleted"];
      const first = runCli(registerArgs(harness, operation));
      expect(first.exitCode).toBe(0);
      const before = await registeredState(harness);

      // The reviewed compass is removed after the commit: the identical
      // operation id still returns its recorded receipt instead of resolving a
      // document the committed intent already proved (I-000868).
      rmSync(join(harness, COMPASS_REF));
      const retry = runCli(registerArgs(harness, operation));
      expect(retry.exitCode).toBe(0);
      expect(envelope(retry).data).toEqual(envelope(first).data);
      expect(await registeredState(harness)).toEqual(before);

      // A NEW operation id against the now-missing compass is still refused,
      // and the refusal publishes nothing.
      const refused = runCli(registerArgs(harness, ["--operation", "op-iteration-register-compass-deleted-new"]));
      expect(refused.exitCode).toBe(1);
      expect(message(refused)).toContain("[catalog.registration-invalid]");
      expect(await registeredState(harness)).toEqual(before);
    });
  });

  test("a committed registration through a symlink alias replays once its target is deleted", async () => {
    await setupHarness(async (harness) => {
      const aliasRef = "iterations/20260918-iteration-register-cli/alias-compass.md";
      symlinkSync("delivery-compass.md", join(harness, aliasRef));
      const operation = ["--operation", "op-iteration-register-symlink-alias"];

      const first = runCli(registerArgs(harness, operation, aliasRef));
      expect(first.exitCode).toBe(0);
      // The producer stores the canonical pointer of the document the alias
      // names; only the fingerprint keeps the caller's alias spelling.
      const before = await registeredState(harness);
      expect(before.data.workflows[0]!.state.compass_ref).toBe(COMPASS_REF);

      // Deleting the target leaves the alias dangling: the identical operation
      // id still replays its receipt, because the transport handed the
      // caller's spelling to the fingerprint instead of resolving it.
      rmSync(join(harness, COMPASS_REF));
      const retry = runCli(registerArgs(harness, operation, aliasRef));
      expect(retry.exitCode).toBe(0);
      expect(envelope(retry).data).toEqual(envelope(first).data);
      expect(await registeredState(harness)).toEqual(before);

      // A new operation id cannot commit against the dangling alias.
      const refused = runCli(registerArgs(harness, ["--operation", "op-iteration-register-symlink-alias-new"], aliasRef));
      expect(refused.exitCode).toBe(1);
      expect(message(refused)).toContain("[catalog.registration-invalid]");
      expect(await registeredState(harness)).toEqual(before);

      // An escaping pointer is still refused, now by the producer's real-path
      // containment proof rather than the transport's lexical check.
      const escaping = runCli(registerArgs(harness, ["--compass-ref", "../outside-compass.md"]));
      expect(escaping.exitCode).toBe(1);
      expect(message(escaping)).toContain("[catalog.registration-invalid]");
    });
  });

  test("valid compass spellings under a symlinked --harness register (exit 0)", async () => {
    await setupHarness(async (harness) => {
      // `--harness` may name a symlink to the real harness. An absolute
      // `--compass-ref` under that real harness names an in-root document, so
      // the transport's lexical containment check must not refuse it (PR #578).
      const realHarness = realpathSync(harness);
      const linkedRoot = mkdtempSync(join(tmpdir(), "mstar-iteration-register-link-"));
      const harnessLink = join(linkedRoot, "harness");
      symlinkSync(realHarness, harnessLink);
      try {
        const absolute = runCli(registerArgs(harnessLink, ["--compass-ref", join(realHarness, COMPASS_REF)]));
        expect(absolute.exitCode).toBe(0);
        expect(envelope(absolute)).toMatchObject({ command: "iteration.register", status: "ok" });

        // An EXTERNAL alias onto an in-root compass is the same document: the
        // producer stores its canonical in-root pointer, so the registration
        // succeeds instead of being refused at the transport.
        const externalId = "20260918-iteration-register-external";
        const externalCompass = join(harness, `iterations/${externalId}/delivery-compass.md`);
        mkdirSync(dirname(externalCompass), { recursive: true });
        writeFileSync(externalCompass, `${compassFrontmatter(externalId)}\n# External alias compass\n`);
        const externalAlias = join(linkedRoot, "external-compass.md");
        symlinkSync(externalCompass, externalAlias);
        const viaAlias = runCli(registerArgs(harnessLink, [], externalAlias, externalId));
        expect(viaAlias.exitCode).toBe(0);

        const registered = await registeredState(realHarness);
        expect(registered.data.workflows.map((view) => [view.state.id, view.state.compass_ref])).toEqual([
          [WORKFLOW_ID, COMPASS_REF],
          [externalId, `iterations/${externalId}/delivery-compass.md`],
        ]);
      } finally {
        rmSync(linkedRoot, { recursive: true, force: true });
      }
    });
  });

  test("a distinct registration intent refuses an occupied ACTIVE workflow identity", async () => {
    await setupHarness(async (harness) => {
      expect(runCli(registerArgs(harness)).exitCode).toBe(0);
      const before = await registeredState(harness);

      // The workflow identity is create-only: a distinct plan set cannot
      // replace its ACTIVE registration or alter the stored state.
      const distinct = runCli(registerArgs(harness, ["--row", row("20260918-plan-gamma")]));
      expect(distinct.exitCode).toBe(1);
      expect(message(distinct)).toContain("[execution.not-empty]");
      expect(await registeredState(harness)).toEqual(before);
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
        ["--branch-target-iteration", "main"],
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
        if (result.exitCode !== 2) throw new Error(`expected usage for ${args.join(" ")}, got: ${result.stdout}`);
      }
      expect(existsSync(root)).toBe(false);
      expect(existsSync(snapshot)).toBe(false);

      const help = runCli(["iteration", "register", "--help"]);
      expect(help.exitCode).toBe(0);
    });
  }, MULTI_CLI_TEST_TIMEOUT_MS);

  test("engine refusals exit 1 without creating artifacts", async () => {
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

    });
  });
});
