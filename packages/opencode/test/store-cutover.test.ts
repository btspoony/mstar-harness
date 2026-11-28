import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureCollaborationAuthority,
  initializeCollaborationStore,
  initializeStore,
  probeCollaborationAuthority,
  resolveCollaborationLocation,
} from "@mstar-harness/engine";
import {
  MorningStarHarnessPlugin,
  validateStatusWrite,
  type StatusLogger,
} from "../src/mstar.js";

/** Ambient MSTAR_HARNESS_DIR would redirect every `.mstar` fixture — pinned out. */
const ENV_KEY = "MSTAR_HARNESS_DIR";
let previousEnv: string | undefined;
beforeEach(() => {
  previousEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (previousEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousEnv;
});

const projects: string[] = [];

const FIXTURE_HOME = mkdtempSync(join(tmpdir(), "opencode-g4b-home-"));
let homeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => FIXTURE_HOME);
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(FIXTURE_HOME, { recursive: true, force: true });
});

afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

const validStatus = { version: 2, updated_at: "2026-09-08", workflows: [] };
const validRegister = { entries: {} };
const invalidRegister = { entries: { "plan-a": { id: "R1" } } };

/** Temp project rooted in a real git work tree (harness resolution boundary),
 * with the default `.mstar` layout. */
function makeHarnessProject(enforcement?: "hard" | "soft"): { project: string; harness: string; statusPath: string; registerPath: string; storeDb: string } {
  const project = mkdtempSync(join(tmpdir(), "mstar-opencode-g4b-"));
  projects.push(project);
  execFileSync("git", ["init", "-q", project], { stdio: "ignore" });
  const harness = join(project, ".mstar");
  mkdirSync(join(harness, "workflows"), { recursive: true });
  mkdirSync(join(harness, "projects", "_default"), { recursive: true });
  const statusPath = join(harness, "status.json");
  writeFileSync(statusPath, JSON.stringify(validStatus, null, 2));
  const repoId = `opencode-${project.split(/[\\/]/).pop()!.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
  writeFileSync(
    join(project, ".mstarc"),
    `${enforcement === undefined ? "" : `[config]\nenforcement=${enforcement}\n\n`}[collaboration]\nmode=local\nrepo_id=${repoId}\n`,
  );
  return {
    project,
    harness,
    statusPath,
    registerPath: join(harness, "projects", "_default", "residuals.json"),
    storeDb: join(harness, "store.db"),
  };
}

async function seedActiveStore(harness: string): Promise<void> {
  await ensureCollaborationAuthority({ harnessDir: harness });
  const handle = await initializeStore({ harnessDir: harness });
  handle.close();
}

async function seedStagedStore(harness: string): Promise<void> {
  await initializeCollaborationStore(resolveCollaborationLocation({ harnessDir: harness }));
}

function corruptCollaboration(harness: string): void {
  const dbPath = resolveCollaborationLocation({ harnessDir: harness }).dbPath;
  rmSync(dbPath, { force: true });
  mkdirSync(dbPath, { recursive: true });
}

/** Capture `[mstar-harness]` log lines by level. */
function capture(): { entries: Array<[string, string]>; log: StatusLogger } {
  const entries: Array<[string, string]> = [];
  return { entries, log: (level, message) => entries.push([level, message]) };
}

describe("opencode authority boundary — store/retired-register direct writes (G4b)", () => {
  test("an ACTIVE store retires the register: refused unconditionally, no enforcement flag involved", async () => {
    const fixture = makeHarnessProject(); // no compass, no `.mstarc` — soft by default
    await seedActiveStore(fixture.harness);
    const { entries, log } = capture();

    // Document-VALID register bytes prove the refusal is the authority route.
    const result = await validateStatusWrite(fixture.registerPath, { doc: validRegister, log });
    expect(result?.ok).toBe(false);
    expect(result?.hardBlocked).toBe(true);
    expect(result?.violations.map((violation) => violation.code)).toEqual(["project.register.retired"]);
    expect(entries.filter(([level]) => level === "error").length).toBe(1);
    expect(entries[0]![1]).toContain("project.register.retired");
  });

  test("an unreadable collaboration authority refuses fail-closed with the engine refusal", async () => {
    const fixture = makeHarnessProject();
    await seedActiveStore(fixture.harness);
    corruptCollaboration(fixture.harness);
    const { entries, log } = capture();

    const result = await validateStatusWrite(fixture.registerPath, { doc: validRegister, log });
    expect(result?.hardBlocked).toBe(true);
    expect(result?.violations[0]!.code).toBe("store.authority-unavailable");
    expect(result?.violations[0]!.message).toContain("collaboration.unreadable");
    expect(entries.some(([level]) => level === "error")).toBe(true);
  });

  test("without an ACTIVE collaboration lane the register is refused by authority in both enforcement modes", async () => {
    for (const state of ["missing", "staged"] as const) {
      for (const enforcement of ["hard", "soft"] as const) {
        const fixture = makeHarnessProject(enforcement);
        if (state === "staged") await seedStagedStore(fixture.harness);
        const { entries, log } = capture();

        const result = await validateStatusWrite(fixture.registerPath, { doc: invalidRegister, log });
        expect(result?.ok).toBe(false);
        expect(result?.hardBlocked).toBe(true);
        expect(result?.violations[0]!.code).toBe("store.authority-unavailable");
        expect(result?.violations[0]!.message).toContain(
          state === "staged" ? "collaboration.not-active" : "collaboration.not-initialized",
        );
        expect(entries.some(([level]) => level === "error")).toBe(true);
      }
    }
  });

  test("the authority database is never hand-writable (store.db / -wal / -shm)", async () => {
    const fixture = makeHarnessProject();
    await seedActiveStore(fixture.harness);

    for (const target of [fixture.storeDb, `${fixture.storeDb}-wal`, `${fixture.storeDb}-shm`]) {
      const { entries, log } = capture();
      const result = await validateStatusWrite(target, { doc: "not a database", log });
      expect(result?.ok).toBe(false);
      expect(result?.hardBlocked).toBe(true);
      expect(result?.violations[0]!.code).toBe("store.direct-write-refused");
      expect(entries.some(([level, message]) => level === "error" && message.includes("store.direct-write-refused"))).toBe(
        true,
      );
    }
    // A same-named file outside a harness root is not the authority.
    expect(await validateStatusWrite(join(fixture.project, "store.db"), { doc: "x" })).toBeNull();
  });

  test("a CASE-VARIANT authority basename (Store.db) is decided like the file itself (qc2-F-004)", async () => {
    const fixture = makeHarnessProject();
    await seedActiveStore(fixture.harness);
    const { entries, log } = capture();

    // On a case-insensitive volume (Darwin/APFS) this write lands on the
    // authority database itself; the folded basename match decides it on a
    // case-sensitive volume too (the authority name is volume-invariant).
    // This host is warn-only — the decision IS the error-log/hardBlocked
    // audit trail, and a case-variant alias must not skip even that.
    const result = await validateStatusWrite(join(fixture.harness, "Store.db"), { doc: "not a database", log });
    expect(result?.ok).toBe(false);
    expect(result?.hardBlocked).toBe(true);
    expect(result?.violations[0]!.code).toBe("store.direct-write-refused");
    expect(
      entries.some(([level, message]) => level === "error" && message.includes("store.direct-write-refused")),
    ).toBe(true);
  });

  test("a CASE-VARIANT register (RESIDUALS.json) takes the authority route (qc2-F-004)", async () => {
    const fixture = makeHarnessProject();
    await seedActiveStore(fixture.harness);
    const { entries, log } = capture();

    const result = await validateStatusWrite(join(fixture.harness, "projects", "_default", "RESIDUALS.json"), {
      doc: validRegister,
      log,
    });
    expect(result?.hardBlocked).toBe(true);
    expect(result?.violations[0]!.code).toBe("project.register.retired");
    expect(entries.some(([level]) => level === "error")).toBe(true);
  });

  test("a CASE-VARIANT register without an ACTIVE lane still refuses by authority (qc2-F-004)", async () => {
    for (const state of ["missing", "staged"] as const) {
      const fixture = makeHarnessProject();
      if (state === "staged") await seedStagedStore(fixture.harness);
      const { entries, log } = capture();
      const caseVariant = join(fixture.harness, "projects", "_default", "RESIDUALS.json");

      const result = await validateStatusWrite(caseVariant, { doc: invalidRegister, log });
      expect(result?.ok).toBe(false);
      expect(result?.hardBlocked).toBe(true);
      expect(result?.violations[0]!.code).toBe("store.authority-unavailable");
      expect(entries.some(([level]) => level === "error")).toBe(true);
    }
  });

  test("unrelated writes bypass the authority route; a missing lane still refuses the register (plan S4)", async () => {
    const fixture = makeHarnessProject();
    const { log } = capture();

    writeFileSync(join(fixture.project, "notes.md"), "# notes\n");
    expect(await validateStatusWrite(join(fixture.project, "notes.md"), { doc: "x", log })).toBeNull();

    const status = await validateStatusWrite(fixture.statusPath, { doc: validStatus, log });
    expect(status?.ok).toBe(true);
    expect(status?.hardBlocked).toBe(false);

    const snapshotPath = join(fixture.harness, "workflows", "wf-a", "snapshot.json");
    mkdirSync(join(snapshotPath, ".."), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({ schema_version: 1, id: "wf-a", type: "plan" }));
    const snapshot = await validateStatusWrite(snapshotPath, { log });
    expect(snapshot?.ok).toBe(false);
    expect(snapshot?.violations[0]?.code).toBe("workflow.snapshot.missing-status");

    const register = await validateStatusWrite(fixture.registerPath, { doc: validRegister, log });
    expect(register?.hardBlocked).toBe(true);
    expect(register?.violations[0]!.code).toBe("store.authority-unavailable");
    expect(register?.violations[0]!.message).toContain("collaboration.not-initialized");
  })

  test("collaboration-only: the register is retired without an execution store", async () => {
    const fixture = makeHarnessProject();
    await ensureCollaborationAuthority({ harnessDir: fixture.harness });
    expect(await probeCollaborationAuthority({ harnessDir: fixture.harness })).toMatchObject({ kind: "active" });
    const result = await validateStatusWrite(fixture.registerPath, { doc: validRegister });
    expect(result?.hardBlocked).toBe(true);
    expect(result?.violations[0]!.code).toBe("project.register.retired");
  })

  test("a symlink alias that resolves into the harness is the authority itself (S-G4b-03)", async () => {
    const fixture = makeHarnessProject(); // no compass — soft by default
    await seedActiveStore(fixture.harness);
    writeFileSync(fixture.registerPath, JSON.stringify(validRegister));
    const aliases = join(fixture.project, "aliases");
    mkdirSync(aliases, { recursive: true });
    const storeAlias = join(aliases, "cache.db");
    symlinkSync(fixture.storeDb, storeAlias);
    const registerAlias = join(aliases, "carry-over.json");
    symlinkSync(fixture.registerPath, registerAlias);

    // Both aliases land on authority files: refused unconditionally, as the
    // files themselves are (document-valid register bytes prove the route).
    const store = await validateStatusWrite(storeAlias, { doc: "not a database" });
    expect(store?.hardBlocked).toBe(true);
    expect(store?.violations[0]!.code).toBe("store.direct-write-refused");

    const register = await validateStatusWrite(registerAlias, { doc: validRegister });
    expect(register?.hardBlocked).toBe(true);
    expect(register?.violations[0]!.code).toBe("project.register.retired");

    // Non-authority behaviour is unchanged: an unrelated alias stays ungated,
    // and the canonical status.json keeps its document validator.
    writeFileSync(join(fixture.project, "notes.md"), "# notes\n");
    const notesAlias = join(aliases, "notes.md");
    symlinkSync(join(fixture.project, "notes.md"), notesAlias);
    expect(await validateStatusWrite(notesAlias, { doc: "x" })).toBeNull();
    const invalidStatus = await validateStatusWrite(fixture.statusPath, {
      doc: { version: 2, updated_at: "2026-09-08", workflows: [{ id: "wf-1", type: "sprint" }] },
    });
    expect(invalidStatus?.ok).toBe(false);
    expect(invalidStatus?.violations[0]!.code).toBe("execution.direct-write-refused");
  });

  test("a fresh authority write through a SYMLINKED PARENT is decided by the landed classification (S-G4b-03)", async () => {
    // The final component is simply ABSENT: realpath fails and the target is
    // not itself a link, but an ANCESTOR directory is a symlink INTO the
    // harness tree — the filesystem lands the write at the protected
    // destination, so the landed classification must canonicalize the nearest
    // existing ancestor instead of trusting the textual path. The store is
    // seeded AFTER the fresh store.db case below, so that target is genuinely
    // absent when it runs.
    const fixture = makeHarnessProject(); // no compass — soft by default
    const outside = join(fixture.project, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(fixture.harness, join(outside, "link")); // directory symlink into the harness root

    const store = await validateStatusWrite(join(outside, "link", "store.db"), { doc: "not a database" });
    expect(store?.hardBlocked).toBe(true);
    expect(store?.violations[0]!.code).toBe("store.direct-write-refused");

    // A case-variant register name under the symlinked parent takes the same
    // landed route (the folded shape walk runs on the canonicalized path); an
    // ACTIVE store makes the landed route retire the register.
    await seedActiveStore(fixture.harness);
    const register = await validateStatusWrite(join(outside, "link", "projects", "_default", "RESIDUALS.json"), {
      doc: validRegister,
    });
    expect(register?.hardBlocked).toBe(true);
    expect(register?.violations[0]!.code).toBe("project.register.retired");

    // The shape the textual probes CANNOT see: the link points INTO the
    // harness at a non-root directory, so no harness marker is stat-reachable
    // on the textual path — only the canonicalized landed path classifies.
    // The linked project dir holds no register file, so the target is absent.
    mkdirSync(join(fixture.harness, "projects", "other"), { recursive: true });
    symlinkSync(join(fixture.harness, "projects", "other"), join(outside, "into-link"));
    const into = await validateStatusWrite(join(outside, "into-link", "residuals.json"), { doc: validRegister });
    expect(into?.hardBlocked).toBe(true);
    expect(into?.violations[0]!.code).toBe("project.register.retired");

    // A plain fresh file with NO symlinked ancestor stays ungated — the walk
    // only canonicalizes when an ancestor actually exists.
    expect(await validateStatusWrite(join(outside, "fresh.db"), { doc: "x" })).toBeNull();
  });

  test("a chained symlink alias landing on the authority database is refused (issue #442)", async () => {
    // One hop is not enough: the outer link points at another link, which
    // points at the harness store sidecar. The chained resolver follows the
    // chain to the authority file; the one-hop variant stopped at the middle
    // link and let the write through.
    const fixture = makeHarnessProject();
    symlinkSync(join(fixture.harness, "store.db-wal"), join(fixture.project, "chain-inner"));
    symlinkSync("chain-inner", join(fixture.project, "chain-outer"));
    const result = await validateStatusWrite(join(fixture.project, "chain-outer"), { doc: "not a database" });
    expect(result?.hardBlocked).toBe(true);
    expect(result?.violations[0]!.code).toBe("store.direct-write-refused");
  });

  test("plugin wiring: a store.db write through tool.execute.before is refused, never silent", async () => {
    const fixture = makeHarnessProject();
    await seedActiveStore(fixture.harness);
    const plugin = await MorningStarHarnessPlugin();
    const beforeWrite = plugin["tool.execute.before"];
    const errors: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      await beforeWrite!(
        { tool: "write", sessionID: "s1", callID: "c1" },
        { args: { filePath: fixture.storeDb, content: "not a database" } },
      );
    } finally {
      console.error = original;
    }
    expect(errors.some((line) => line.includes("store.direct-write-refused"))).toBe(true);
    expect(errors.some((line) => line.includes("hard-gate blocked (hardBlocked=true)"))).toBe(true);
  });

  test("plugin wiring: an edit touching a retired register is refused too (not only writes)", async () => {
    const fixture = makeHarnessProject();
    await seedActiveStore(fixture.harness);
    writeFileSync(fixture.registerPath, JSON.stringify(validRegister));
    const plugin = await MorningStarHarnessPlugin();
    const beforeWrite = plugin["tool.execute.before"];
    const errors: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      await beforeWrite!(
        { tool: "edit", sessionID: "s1", callID: "c1" },
        { args: { filePath: fixture.registerPath, oldString: "{}", newString: '{"plan-a":[{"id":"R1"}]}' } },
      );
    } finally {
      console.error = original;
    }
    expect(errors.some((line) => line.includes("project.register.retired"))).toBe(true);
  });
});
