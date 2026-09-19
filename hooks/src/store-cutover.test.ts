/**
 * store-cutover.test.ts — G4b: the ZCode PreToolUse(Write|Edit) gate's
 * issue/catalog authority boundary: what the store cutover refuses once it
 * is the authority, and what it leaves untouched.
 *
 * Two runtimes are exercised deliberately:
 *
 * - the SOURCE entry under the test runner (`process.execPath`), pinning the
 *   refusal dialect (exit 2 + stderr-only 3-line block, empty stdout) for the
 *   authority paths and the untouched document paths;
 * - the COMMITTED BUNDLE (`hooks/mstar-write-gate.mjs`, rebuilt from source by
 *   `scripts/build-zcode-hooks.ts` in `beforeAll`) under NATIVE `node` — the
 *   runtime hooks.json spawns. That run carries the store-backed path under
 *   the actual Node runtime, including the in-process laziness probe
 *   (`process.moduleLoadList`: no `node:sqlite` for a non-store write).
 *
 * Stores are REAL (`initializeStore` / `openStore`, real `node:sqlite`
 * migrations); the refusals are the entry's own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, openStore } from "@mstar-harness/engine";
import { HOOK_OUTFILE_REL, buildZcodeHooks } from "../../scripts/build-zcode-hooks.ts";

const HOOK_SRC = join(import.meta.dir, "mstar-write-gate.ts");
const HOOK_BUNDLE = join(import.meta.dir, "..", "..", HOOK_OUTFILE_REL);
const SKILL_POINTER = "(skill: mstar-artifacts/references/status-and-residuals.md)";
const ENFORCEMENT_LINE =
  "Enforcement: hard \u2014 this repo opts in via .mstarc/compass; disable for this session with MSTAR_WRITE_GATE=off.";
const AUTHORITY_LINE =
  "Authority invariant (not the enforcement flag) \u2014 the issue/catalog authority is not hand-writable; disable for this session with MSTAR_WRITE_GATE=off.";

const VALID_STATUS = JSON.stringify({ version: 2, updated_at: "2026-09-08", workflows: [] });
const VALID_REGISTER = JSON.stringify({ entries: {} });
const BAD_JSON = "{ not json";

const roots: string[] = [];

beforeAll(async () => {
  await buildZcodeHooks(); // regenerate the committed artifact (deterministic)
});

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHarness(id: string, enforcement?: "hard" | "soft"): { root: string; harness: string; register: string; storeDb: string } {
  const root = mkdtempSync(join(tmpdir(), `wgate-g4b-${id}-`));
  roots.push(root);
  const harness = join(root, ".mstar");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects", "_default"), { recursive: true });
  writeFileSync(join(harness, "status.json"), VALID_STATUS);
  if (enforcement !== undefined) writeFileSync(join(root, ".mstarc"), `[config]\nenforcement=${enforcement}\n`);
  return {
    root,
    harness,
    register: join(harness, "projects", "_default", "residuals.json"),
    storeDb: join(harness, "store.db"),
  };
}

/** REAL active store, plus one read in THIS process (a child's first read of a
 * store the runner just wrote intermittently fails to open — task-3 report). */
async function seedActiveStore(harness: string): Promise<void> {
  const handle = await initializeStore({ harnessDir: harness });
  handle.close();
  const warm = await openStore({ harnessDir: harness }, "read");
  warm.close();
}

/** Unreadable authority through the REAL engine channel (`store.corrupt`). */
function corruptStore(harness: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(join(harness, `store.db${suffix}`), { force: true });
  mkdirSync(join(harness, "store.db"), { recursive: true });
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run one hook entry (`binary` = the runtime that would spawn it) with a
 * synthetic stdin envelope; harness-affecting env vars are scrubbed. */
function runGate(
  binary: string,
  entry: string,
  payload: unknown,
  env: Record<string, string> = {},
  extraArgs: string[] = [],
): RunResult {
  const merged = { ...process.env };
  delete merged.MSTAR_WRITE_GATE;
  delete merged.MSTAR_HARNESS_DIR;
  Object.assign(merged, env);
  const proc = spawnSync(binary, [...extraArgs, entry], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: merged,
    encoding: "utf8",
  });
  return { exitCode: proc.status ?? -1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function writeEvent(filePath: string, content: string): unknown {
  return { tool_name: "Write", tool_input: { file_path: filePath, content } };
}

function lines(run: RunResult): string[] {
  return run.stderr.trimEnd().split("\n");
}

describe("ZCode write gate \u2014 authority paths (source entry)", () => {
  test("store.db write is refused unconditionally: exit 2, empty stdout, authority line", () => {
    const fixture = makeHarness("store-db-hard", "hard");
    const run = runGate(process.execPath, HOOK_SRC, writeEvent(fixture.storeDb, "not a database"));
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    const out = lines(run);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("[Morning Star write gate] blocked Write to store.db");
    expect(out[1]!.startsWith("[high] store.direct-write-refused: ")).toBe(true);
    expect(out[1]!.endsWith(SKILL_POINTER)).toBe(true);
    expect(out[2]).toBe(AUTHORITY_LINE);
  });

  test("the WAL sidecars are the authority too, and soft mode does not excuse them", () => {
    const fixture = makeHarness("store-db-soft", "soft");
    for (const target of [`${fixture.storeDb}-wal`, `${fixture.storeDb}-shm`]) {
      const run = runGate(process.execPath, HOOK_SRC, writeEvent(target, "not a database"));
      expect(run.exitCode).toBe(2);
      expect(run.stderr).toContain("store.direct-write-refused");
      expect(run.stderr).toContain(AUTHORITY_LINE);
    }
  });

  test("a CASE-VARIANT authority basename (Store.db) is refused like the file itself (FW-3)", () => {
    const fixture = makeHarness("store-case", "soft");
    // On a case-insensitive volume (Darwin/APFS) this write lands on the
    // authority database itself; the folded basename match refuses it on a
    // case-sensitive volume too (the authority name is volume-invariant).
    const run = runGate(process.execPath, HOOK_SRC, writeEvent(join(fixture.harness, "Store.db"), "not a database"));
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("store.direct-write-refused");
    expect(run.stderr).toContain(AUTHORITY_LINE);
  });

  test("a CASE-VARIANT register (RESIDUALS.json) takes the authority route (FW-3)", async () => {
    const fixture = makeHarness("register-case", "soft");
    await seedActiveStore(fixture.harness);
    const run = runGate(
      process.execPath,
      HOOK_SRC,
      writeEvent(join(fixture.harness, "projects", "_default", "RESIDUALS.json"), VALID_REGISTER),
    );
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("project.register.retired");
    expect(run.stderr).toContain(AUTHORITY_LINE);
  });

  test("a CASE-VARIANT register on the pre-activation fall-through keeps its document validator (qc2-F-005)", () => {
    const caseVariant = (harness: string): string => join(harness, "projects", "_default", "RESIDUALS.json");

    // The FW-3 folded shape walk classifies the case-variant basename as a
    // register document (dsh/omp parity): the register shape validator
    // decides — not the authority route, not silence.
    const hard = makeHarness("register-case-legacy-hard", "hard");
    const blocked = runGate(process.execPath, HOOK_SRC, writeEvent(caseVariant(hard.harness), BAD_JSON));
    expect(blocked.exitCode).toBe(2);
    const out = lines(blocked);
    expect(out[1]!.startsWith("[high] status.invalid-json: ")).toBe(true);
    expect(out[2]).toBe(ENFORCEMENT_LINE); // the enforcement axis, not the authority invariant
    expect(runGate(process.execPath, HOOK_SRC, writeEvent(caseVariant(hard.harness), VALID_REGISTER)).exitCode).toBe(0);

    const soft = makeHarness("register-case-legacy-soft", "soft");
    const silent = runGate(process.execPath, HOOK_SRC, writeEvent(caseVariant(soft.harness), BAD_JSON));
    expect(silent.exitCode).toBe(0);
    expect(silent.stdout).toBe("");
    expect(silent.stderr).toBe("");
  });

  test("a retired register write on an ACTIVE store is refused (soft mode included)", async () => {
    const fixture = makeHarness("register-active", "soft");
    await seedActiveStore(fixture.harness);
    const run = runGate(process.execPath, HOOK_SRC, writeEvent(fixture.register, VALID_REGISTER));
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("project.register.retired");
    expect(run.stderr).toContain("store.db");
    expect(run.stderr).toContain(AUTHORITY_LINE);
  });

  test("an unreadable authority refuses fail-closed, carrying the engine refusal", async () => {
    const fixture = makeHarness("register-corrupt", "soft");
    corruptStore(fixture.harness);
    const run = runGate(process.execPath, HOOK_SRC, writeEvent(fixture.register, VALID_REGISTER));
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("store.authority-unavailable");
    expect(run.stderr).toContain("store.corrupt");
  });

  test("pre-activation register writes keep their document validator and enforcement axis", () => {
    const hard = makeHarness("register-legacy-hard", "hard");
    const blocked = runGate(process.execPath, HOOK_SRC, writeEvent(hard.register, BAD_JSON));
    expect(blocked.exitCode).toBe(2);
    const out = lines(blocked);
    expect(out[1]!.startsWith("[high] status.invalid-json: ")).toBe(true);
    expect(out[2]).toBe(ENFORCEMENT_LINE); // the enforcement axis, not the authority invariant

    const soft = makeHarness("register-legacy-soft", "soft");
    const silent = runGate(process.execPath, HOOK_SRC, writeEvent(soft.register, BAD_JSON));
    expect(silent.exitCode).toBe(0);
    expect(silent.stdout).toBe("");
    expect(silent.stderr).toBe("");
  });

  test("a symlink alias that resolves into the harness is refused like the authority (S-G4b-03)", async () => {
    const fixture = makeHarness("alias", "soft");
    await seedActiveStore(fixture.harness);
    writeFileSync(fixture.register, VALID_REGISTER);
    const aliases = join(fixture.root, "aliases");
    mkdirSync(aliases, { recursive: true });
    const storeAlias = join(aliases, "cache.db");
    symlinkSync(fixture.storeDb, storeAlias);
    const registerAlias = join(aliases, "carry-over.json");
    symlinkSync(fixture.register, registerAlias);

    const store = runGate(process.execPath, HOOK_SRC, writeEvent(storeAlias, "not a database"));
    expect(store.exitCode).toBe(2);
    expect(store.stdout).toBe("");
    expect(store.stderr).toContain("store.direct-write-refused");
    expect(lines(store)[2]).toBe(AUTHORITY_LINE);

    // Document-valid register bytes prove the DB-aware route, not a shape hit.
    const register = runGate(process.execPath, HOOK_SRC, writeEvent(registerAlias, VALID_REGISTER));
    expect(register.exitCode).toBe(2);
    expect(register.stderr).toContain("project.register.retired");

    // An unrelated alias keeps the silent pass (non-authority unchanged).
    writeFileSync(join(fixture.root, "notes.md"), "# notes\n");
    const notesAlias = join(aliases, "notes.md");
    symlinkSync(join(fixture.root, "notes.md"), notesAlias);
    const unrelated = runGate(process.execPath, HOOK_SRC, writeEvent(notesAlias, BAD_JSON));
    expect(unrelated.exitCode).toBe(0);
    expect(unrelated.stdout).toBe("");
    expect(unrelated.stderr).toBe("");
  });

  test("a fresh authority write through a SYMLINKED PARENT is refused by the landed classification (S-G4b-03)", async () => {
    // The final component is simply ABSENT: realpath fails and the target is
    // not itself a link, but an ANCESTOR directory is a symlink INTO the
    // harness tree — the filesystem lands the write at the protected
    // destination, so the landed classification must canonicalize the nearest
    // existing ancestor instead of trusting the textual path.
    const fixture = makeHarness("alias-fresh-parent", "soft");
    const outside = join(fixture.root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(fixture.harness, join(outside, "link")); // directory symlink into the harness root

    // store.db is still absent at this point (seeded below): the walk hits.
    const store = runGate(
      process.execPath,
      HOOK_SRC,
      writeEvent(join(outside, "link", "store.db"), "not a database"),
    );
    expect(store.exitCode).toBe(2);
    expect(store.stdout).toBe("");
    expect(store.stderr).toContain("store.direct-write-refused");
    expect(lines(store)[2]).toBe(AUTHORITY_LINE);

    // A case-variant register name under the symlinked parent takes the same
    // landed route (the folded shape walk runs on the canonicalized path); an
    // ACTIVE store makes the landed route retire the register.
    await seedActiveStore(fixture.harness);
    const caseVariant = runGate(
      process.execPath,
      HOOK_SRC,
      writeEvent(join(outside, "link", "projects", "_default", "RESIDUALS.json"), VALID_REGISTER),
    );
    expect(caseVariant.exitCode).toBe(2);
    expect(caseVariant.stderr).toContain("project.register.retired");

    // The shape the textual probes CANNOT see: the link points INTO the
    // harness at a non-root directory, so no harness marker is stat-reachable
    // on the textual path — only the canonicalized landed path classifies.
    symlinkSync(join(fixture.harness, "projects", "_default"), join(outside, "into-link"));
    const into = runGate(
      process.execPath,
      HOOK_SRC,
      writeEvent(join(outside, "into-link", "residuals.json"), VALID_REGISTER),
    );
    expect(into.exitCode).toBe(2);
    expect(into.stderr).toContain("project.register.retired");

    // A plain fresh file with NO symlinked ancestor keeps the silent pass —
    // the walk only canonicalizes when an ancestor actually exists.
    const fresh = runGate(process.execPath, HOOK_SRC, writeEvent(join(outside, "fresh.db"), "not a database"));
    expect(fresh.exitCode).toBe(0);
    expect(fresh.stdout).toBe("");
    expect(fresh.stderr).toBe("");
  });

  test("a pre-activation register whose alias lands on an ACTIVE harness's register is vetoed (stricter-wins)", async () => {
    // RV-2: the source harness is pre-activation (legacy route), but its
    // register is a symlink to ANOTHER harness's register whose store is
    // active — the write lands there with only the source authority checked.
    // The landed context's authority refusals veto the legacy fall-through.
    const source = makeHarness("cross-src-legacy", "hard");
    const dest = makeHarness("cross-dest-active", "soft");
    await seedActiveStore(dest.harness);
    writeFileSync(dest.register, VALID_REGISTER);
    symlinkSync(dest.register, source.register);

    const vetoed = runGate(process.execPath, HOOK_SRC, writeEvent(source.register, VALID_REGISTER));
    expect(vetoed.exitCode).toBe(2);
    expect(vetoed.stdout).toBe("");
    // Document-valid register bytes prove the veto is the landed authority
    // route, not a shape violation.
    expect(vetoed.stderr).toContain("project.register.retired");
    expect(vetoed.stderr).toContain(AUTHORITY_LINE);

    // Both contexts pre-activation keep the legacy path (issue contract §7):
    // the landed register's own document validator decides, on the source's
    // enforcement axis.
    const legacyDest = makeHarness("cross-dest-legacy", "soft");
    writeFileSync(legacyDest.register, VALID_REGISTER);
    const legacySource = makeHarness("cross-src-legacy-2", "hard");
    symlinkSync(legacyDest.register, legacySource.register);
    expect(runGate(process.execPath, HOOK_SRC, writeEvent(legacySource.register, VALID_REGISTER)).exitCode).toBe(0);
    const invalid = runGate(process.execPath, HOOK_SRC, writeEvent(legacySource.register, BAD_JSON));
    expect(invalid.exitCode).toBe(2);
    expect(lines(invalid)[2]).toBe(ENFORCEMENT_LINE); // the enforcement axis, not the authority invariant
  });

  test("unrelated targets and MSTAR_WRITE_GATE=off still pass silently", async () => {
    const fixture = makeHarness("unrelated", "hard");
    await seedActiveStore(fixture.harness);
    const readme = runGate(process.execPath, HOOK_SRC, writeEvent(join(fixture.root, "README.md"), BAD_JSON));
    expect(readme.exitCode).toBe(0);
    expect(readme.stderr).toBe("");

    const off = runGate(process.execPath, HOOK_SRC, writeEvent(fixture.storeDb, "not a database"), { MSTAR_WRITE_GATE: "off" });
    expect(off.exitCode).toBe(0);
    expect(off.stderr).toBe("");
  });
});

describe("ZCode write gate \u2014 committed bundle under native node", () => {
  test("the node on PATH meets the store floor this gate advertises", () => {
    const version = spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim().replace(/^v/, "");
    const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
    expect(major > 24 || (major === 24 && minor >= 18)).toBe(true);
  });

  test("bundle refuses the authority database and the retired register, and passes unrelated targets", async () => {
    const fixture = makeHarness("bundle", "hard");
    await seedActiveStore(fixture.harness);

    const storeDb = runGate("node", HOOK_BUNDLE, writeEvent(fixture.storeDb, "not a database"));
    expect(storeDb.exitCode).toBe(2);
    expect(storeDb.stdout).toBe("");
    expect(lines(storeDb)[2]).toBe(AUTHORITY_LINE);

    const register = runGate("node", HOOK_BUNDLE, writeEvent(fixture.register, VALID_REGISTER));
    expect(register.exitCode).toBe(2);
    expect(register.stderr).toContain("project.register.retired");

    const unrelated = runGate("node", HOOK_BUNDLE, writeEvent(join(fixture.root, "notes.md"), "# notes"));
    expect(unrelated.exitCode).toBe(0);
    expect(unrelated.stdout).toBe("");
    expect(unrelated.stderr).toBe("");

    // The committed artifact carries the same canonicalization (S-G4b-03).
    const aliases = join(fixture.root, "aliases");
    mkdirSync(aliases, { recursive: true });
    const storeAlias = join(aliases, "cache.db");
    symlinkSync(fixture.storeDb, storeAlias);
    const aliased = runGate("node", HOOK_BUNDLE, writeEvent(storeAlias, "not a database"));
    expect(aliased.exitCode).toBe(2);
    expect(aliased.stdout).toBe("");
    expect(aliased.stderr).toContain("store.direct-write-refused");
  });

  test("bundle preserves the document validator for a pre-activation register", () => {
    const fixture = makeHarness("bundle-legacy", "hard");
    const run = runGate("node", HOOK_BUNDLE, writeEvent(fixture.register, BAD_JSON));
    expect(run.exitCode).toBe(2);
    expect(lines(run)[2]).toBe(ENFORCEMENT_LINE);
    expect(run.stderr).toContain("status.invalid-json");
  });

  test("the store is acquired ONLY on the store-backed route (moduleLoadList, in-process)", async () => {
    const fixture = makeHarness("bundle-lazy", "hard");
    await seedActiveStore(fixture.harness);
    const probeDir = mkdtempSync(join(tmpdir(), "wgate-g4b-probe-"));
    roots.push(probeDir);
    const preload = join(probeDir, "preload.mjs");
    const outPath = join(probeDir, "probe.json");
    // The preload runs INSIDE the hook process; `process.moduleLoadList` is
    // Node's own record of loaded native modules, so this observes the exact
    // committed artifact's acquisition instead of inferring it from behaviour.
    writeFileSync(
      preload,
      [
        'import { writeFileSync } from "node:fs";',
        "process.on(\"exit\", () => {",
        "  const loaded = (process.moduleLoadList ?? []).some((name) => /sqlite/i.test(name));",
        "  try { writeFileSync(process.env.MSTAR_G4B_PROBE_OUT, JSON.stringify({ sqlite: loaded })); } catch {}",
        "});",
        "",
      ].join("\n"),
    );

    const statusWrite = runGate(
      "node",
      HOOK_BUNDLE,
      writeEvent(join(fixture.harness, "status.json"), BAD_JSON),
      { MSTAR_G4B_PROBE_OUT: outPath },
      ["--import", preload],
    );
    expect(statusWrite.exitCode).toBe(2); // document validator still fires
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({ sqlite: false });

    const registerWrite = runGate(
      "node",
      HOOK_BUNDLE,
      writeEvent(fixture.register, VALID_REGISTER),
      { MSTAR_G4B_PROBE_OUT: outPath },
      ["--import", preload],
    );
    expect(registerWrite.exitCode).toBe(2);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({ sqlite: true });
  });
});

