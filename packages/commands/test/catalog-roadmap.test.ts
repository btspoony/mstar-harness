import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMilestoneCommandDefinitions } from "../src/families/milestone.js";
import {
  ensureCollaborationAuthority,
  initializeCollaborationStore,
  initializeStore,
  readCollaborationAuthority,
  registerCatalogEntity,
  resolveCollaborationLocation,
  writeCollaborationBinding,
} from "@mstar-harness/engine";
import { getCatalogCommandDefinitions, getCommandDefinitions } from "../src/index.js";
import { getProjectCommandDefinitions } from "../src/families/project.js";
import { failure as catalogFailure } from "../src/families/catalog.js";

import type { InvocationContext } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "commands-catalog-roadmap-"));
const home = join(root, "home");
mkdirSync(home);
let homeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => home);
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function invocation(cwd: string): InvocationContext {
  return {
    cwd, controlRoot: null, versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { return { exitCode: 0, signal: null, stdout: "", stderr: "" }; },
      async startDashboard() { throw new Error("not used"); },
      async openBrowser() { throw new Error("not used"); },
    },
  };
}

const catalog = Object.fromEntries(getCatalogCommandDefinitions().map((definition) => [definition.id, definition]));
const project = Object.fromEntries(getProjectCommandDefinitions().map((definition) => [definition.id, definition]));

/** note: A synthetic checkout whose origin names the collaboration repository. */
function checkout(name: string, originSlug = name): { cwd: string; harness: string } {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${originSlug}.git`], { cwd, stdio: ["ignore", "ignore", "ignore"] });
  // note: The live selector lookup is real Git I/O; route the synthetic origin to this fixture's
  // own repository, which never publishes the selector ref.
  execFileSync("git", ["config", `url.${cwd}.insteadOf`, `https://github.com/acme/${originSlug}.git`], {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
  writeFileSync(join(cwd, ".mstarc"), "[collaboration]\nmode=local\n");
  const harness = join(cwd, ".mstar");
  mkdirSync(harness, { recursive: true });
  return { cwd, harness };
}

/** note: The private staged record flipped to active: this plan ships no public activator. */
async function activeFixture(name: string): Promise<{ cwd: string; harness: string }> {
  const { cwd, harness } = checkout(name);
  const store = await initializeStore({ harnessDir: harness });
  store.close();
  // note: The supported bootstrap records this checkout's binding as well as publishing
  // the lane; a bare state flip leaves every write refusing `stale-binding`.
  await ensureCollaborationAuthority({ harnessDir: harness });
  await registerCatalogEntity({ harnessDir: harness }, {
    kind: "project", id: "proj", title: "Project", rootKind: "projects", relativePath: "proj",
  }, { operationId: `${name}-project`, actor: "test" });
  return { cwd, harness };
}

describe("catalog command family", () => {
  test("catalog refusal preserves engine code and verbatim first line", () => {
    const result = catalogFailure("catalog.update", Object.assign(new Error("engine catalog refusal detail"), { code: "catalog.engine-refused" }));
    expect(result.status).toBe("refused");
    expect(result.code).toBe("catalog.engine-refused");
    expect(result.message.split("\n", 1)[0]).toBe("engine catalog refusal detail");
    expect(result.details).toHaveProperty("helpRoute");
  });

  test("registers exactly the assigned ten catalog identities and no roadmap command", () => {
    expect(Object.keys(catalog)).toEqual([
      "catalog.discover", "catalog.import", "catalog.register", "catalog.update", "catalog.link", "catalog.list", "catalog.show", "catalog.export", "catalog.reconcile", "catalog.purge-registration",
    ]);
    const ids = getCommandDefinitions().map((definition) => definition.id);
    expect(ids.some((id) => id.startsWith("roadmap"))).toBe(false);
  });

  test("catalog queries refuse an inactive store rather than returning an empty catalog", async () => {
    const { cwd, harness } = checkout("inactive");
    const result = await catalog["catalog.list"]!.execute({ harness }, invocation(cwd));
    expect(result.status).toBe("refused");
    expect(result.code).toBe("collaboration.not-initialized");
  });
  test("inactive catalog mutation exposes the collaboration activation recovery", async () => {
    const { cwd, harness } = checkout("inactive-mutation");
    // invariant: The lane exists but is staged: ordinary catalog traffic is refused at
    // admission and the recovery is the reviewed activation sequence.
    await initializeCollaborationStore(resolveCollaborationLocation({ harnessDir: harness }));
    const result = await catalog["catalog.register"]!.execute({
      harness, kind: "document", id: "doc", title: "Doc", rootKind: "specs", path: "doc.md",
      operationId: "inactive-register", actor: "test",
    }, invocation(cwd));
    expect(result.status).toBe("refused");
    expect(result.code).toBe("collaboration.not-active");
    expect(result.message).toContain("apply/activate");
  });


  test("catalog mutations preserve execution workflow state", async () => {
    const { cwd, harness } = await activeFixture("snapshot-immutability");
    const workflowDir = join(harness, "workflows", "wf-fixture");
    mkdirSync(workflowDir, { recursive: true });
    const snapshotPath = join(workflowDir, "snapshot.json");
    const snapshot = JSON.stringify({ id: "wf-fixture", plans: [{ id: "plan-fixture", status: "InProgress" }] });
    writeFileSync(snapshotPath, snapshot);
    const result = await catalog["catalog.register"]!.execute({
      harness, kind: "document", id: "doc-fixture", title: "Spec", rootKind: "specs", path: "fixture.md", documentKind: "spec",
      operationId: "register-doc", actor: "test",
    }, invocation(cwd));
    expect(result.status).toBe("ok");
    expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual(JSON.parse(snapshot));
  });

  test("catalog list, show and export expose stored authority data", async () => {
    const { cwd, harness } = await activeFixture("catalog-read-data");
    const listed = await catalog["catalog.list"]!.execute({ harness, kind: "project" }, invocation(cwd));
    const shown = await catalog["catalog.show"]!.execute({ harness, kind: "project", id: "proj" }, invocation(cwd));
    const exported = await catalog["catalog.export"]!.execute({ harness }, invocation(cwd));
    expect(listed.status).toBe("ok");
    expect(shown.status).toBe("ok");
    expect(exported.status).toBe("ok");
    if (listed.status === "ok") expect(JSON.stringify(listed.data)).toContain("proj");
    if (shown.status === "ok") expect(JSON.stringify(shown.data)).toContain("Project");
    if (exported.status === "ok") expect(JSON.stringify(exported.data)).toContain("proj");

    // note: A replacement clone with the same repository identity but no local
    // catalog content and no execution store reads the same logical rows: the
    // project location resolves against THIS checkout and is disclosed absent.
    const clone = checkout("catalog-read-data-clone", "catalog-read-data");
    // invariant: Reading a live authority requires this checkout's own recorded binding; a
    // bare clone is a foreign checkout, never an implicit reader.
    writeCollaborationBinding({ harnessDir: clone.harness }, await readCollaborationAuthority({ harnessDir: harness }));
    const cloneList = await catalog["catalog.list"]!.execute({ harness: clone.harness, kind: "project" }, invocation(clone.cwd));
    expect(cloneList.status).toBe("ok");
    const cloneShow = await catalog["catalog.show"]!.execute({ harness: clone.harness, kind: "project", id: "proj" }, invocation(clone.cwd));
    expect(cloneShow.status).toBe("ok");
    if (cloneShow.status === "ok") {
      expect(cloneShow.data).toMatchObject({ entity: { relativePath: "proj", present: false } });
    }
    // invariant: A sparse plan registration whose document is missing here is a named
    // refusal; it never mints or rebinds the registered execution location.
    const missingPlan = await catalog["catalog.register"]!.execute({
      harness: clone.harness, kind: "plan", file: join(clone.harness, "plans", "plan-missing.md"), operationId: "clone-plan", actor: "test",
    }, invocation(clone.cwd));
    expect(missingPlan.status).toBe("refused");
    expect(missingPlan.code).toBe("plan-path.not-a-file");
    expect(existsSync(join(clone.harness, "store.db"))).toBe(false);
  });

  test("sparse catalog register derives a plan row's identity, title and location from its document", async () => {
    const { cwd, harness } = await activeFixture("sparse-catalog");
    // The plan document is the authority for id/title/location: the caller
    // states only the pointer, and the derived catalog location (plans-root-
    // relative, the bare file name) is what the row stores.
    mkdirSync(join(harness, "plans"), { recursive: true });
    writeFileSync(join(harness, "plans", "plan-alpha.md"), "---\nplan_id: plan-alpha\n---\n\n# Declared Title\n\nBody.\n");
    // `MSTAR_HARNESS_DIR` pins the process root for this case: `storeDbPath`
    // (engine, outside this task's files) re-resolves an already-resolved
    // harness dir and prefers its `plans/` child once that directory exists,
    // so the pin keeps the store lookup on the harness root the fixture built.
    const prior = process.env.MSTAR_HARNESS_DIR;
    process.env.MSTAR_HARNESS_DIR = harness;
    try {
      const registered = await catalog["catalog.register"]!.execute({
        harness, kind: "plan", file: join(harness, "plans", "plan-alpha.md"), operationId: "sparse-plan", actor: "test",
      }, invocation(cwd));
      expect(registered.status).toBe("ok");
      const shown = await catalog["catalog.show"]!.execute({ harness, kind: "plan", id: "plan-alpha" }, invocation(cwd));
      expect(shown.status).toBe("ok");
      if (shown.status !== "ok") throw new Error("derived plan row was not registered");
      expect(shown.data).toMatchObject({
        entity: { kind: "plan", id: "plan-alpha", title: "Declared Title", rootKind: "plans", relativePath: "plan-alpha.md" },
      });
    } finally {
      if (prior === undefined) delete process.env.MSTAR_HARNESS_DIR;
      else process.env.MSTAR_HARNESS_DIR = prior;
    }
    // A supplied spelling that contradicts the derived location is a caller
    // error, never a silent relocation of the document's own row. This needs no
    // store write, so it runs outside the root pin.
    const contradictory = await catalog["catalog.register"]!.execute({
      harness, kind: "plan", file: join(harness, "plans", "plan-alpha.md"), path: "elsewhere.md", operationId: "sparse-plan-2", actor: "test",
    }, invocation(cwd));
    expect(contradictory.status).toBe("usage");
  });

  test("sparse catalog refusals name every irreducible field at once", async () => {
    const { cwd, harness } = await activeFixture("catalog-aggregate");
    const sparse = await catalog["catalog.register"]!.execute({ harness, kind: "document" }, invocation(cwd));
    expect(sparse.status).toBe("usage");
    if (sparse.status !== "usage") throw new Error("expected an aggregated usage refusal");
    for (const flag of ["--id", "--title", "--root-kind", "--path", "--operation-id", "--actor"]) {
      expect(sparse.message).toContain(flag);
    }
    expect(sparse.details?.paths).toEqual(["id", "title", "rootKind", "path", "operationId", "actor"]);
    // A relocation guard stays caller-owned on `catalog.update`: an omitted
    // `--expect` is aggregated rather than skipped, and a stale one refuses.
    await catalog["catalog.register"]!.execute({
      harness, kind: "document", id: "doc-a", title: "Doc", rootKind: "specs", path: "doc-a.md", documentKind: "spec",
      operationId: "doc-a", actor: "test",
    }, invocation(cwd));
    const noGuard = await catalog["catalog.update"]!.execute({
      harness, kind: "document", id: "doc-a", title: "Renamed", operationId: "doc-a-rename", actor: "test",
    }, invocation(cwd));
    expect(noGuard.status).toBe("usage");
    if (noGuard.status === "usage") expect(noGuard.message).toContain("--expect");
    const renamed = await catalog["catalog.update"]!.execute({
      harness, kind: "document", id: "doc-a", expect: 1, title: "Renamed", operationId: "doc-a-rename-2", actor: "test",
    }, invocation(cwd));
    expect(renamed.status).toBe("ok");
    const stale = await catalog["catalog.update"]!.execute({
      harness, kind: "document", id: "doc-a", expect: 1, title: "Nope", operationId: "doc-a-stale", actor: "test",
    }, invocation(cwd));
    expect(stale.status).toBe("refused");
    expect(stale.code).toBe("catalog.revision-conflict");
  });

  test("reviewed import keeps its saved comparison basis and raw replacement states its own", async () => {
    const { cwd, harness } = await activeFixture("reviewed-import");
    // Discovery is read-only; the reviewed mapping states the identity the
    // reviewer confirmed; the engine re-reads current content without a hash gate.
    mkdirSync(join(harness, "knowledge"), { recursive: true });
    writeFileSync(join(harness, "knowledge", "notes.md"), "---\ntitle: Notes\n---\n\n# Notes\n");
    const inputsFile = join(cwd, "inputs.json");
    writeFileSync(inputsFile, JSON.stringify([
      { rootKind: "knowledge", relativePath: "notes.md", mapping: { kind: "document", id: "doc-notes", documentKind: "knowledge" } },
    ]));
    const dryRun = await catalog["catalog.import"]!.execute({
      harness, inputs: inputsFile, dryRun: true, operationId: "import-notes", actor: "test",
    }, invocation(cwd));
    expect(dryRun.status).toBe("ok");
    if (dryRun.status !== "ok") throw new Error("reviewed plan did not verify");
    expect(dryRun.data).toMatchObject({ importable: true });
    const imported = await catalog["catalog.import"]!.execute({
      harness, inputs: inputsFile, operationId: "import-notes", actor: "test",
    }, invocation(cwd));
    expect(imported.status).toBe("ok");
    if (imported.status !== "ok") throw new Error("reviewed import did not apply");
    expect(imported.data).toMatchObject({ operationId: "import-notes", storeRevision: expect.any(Number) });
    // Replaying the SAME reviewed import returns the recorded receipt: current
    // success with no duplicate row or revision churn (A09).
    const replayed = await catalog["catalog.import"]!.execute({
      harness, inputs: inputsFile, operationId: "import-notes", actor: "test",
    }, invocation(cwd));
    expect(replayed.status).toBe("ok");
    expect(replayed.data).toEqual(imported.data);
    const listed = await catalog["catalog.list"]!.execute({ harness }, invocation(cwd));
    expect(listed.status).toBe("ok");
    if (listed.status === "ok") expect((listed.data as { total: number }).total).toBe(2);
  });

  test("collaboration command evidence: catalog list, catalog show and project show share their read's observation", async () => {
    const { cwd, harness } = await activeFixture("command-evidence");
    type Evidence = { scope: { kind: string; key: string }; completeness: string; asOf: string; revision: number };
    // why: The command envelope's `data`/`details` are open records; narrow once here
    // instead of asserting a fabricated shape at each read site.
    const observation = (container: unknown): Evidence => {
      if (container === null || typeof container !== "object" || !("collaboration" in container)) {
        throw new Error("the command output carries no collaboration observation");
      }
      const value = container.collaboration;
      if (value === null || typeof value !== "object") throw new Error("malformed collaboration observation");
      if (!("scope" in value) || value.scope === null || typeof value.scope !== "object") throw new Error("missing collaboration scope");
      const scope = value.scope;
      if (
        !("completeness" in value) || typeof value.completeness !== "string" ||
        !("asOf" in value) || typeof value.asOf !== "string" ||
        !("revision" in value) || typeof value.revision !== "number" ||
        !("kind" in scope) || typeof scope.kind !== "string" ||
        !("key" in scope) || typeof scope.key !== "string"
      ) {
        throw new Error("incomplete collaboration observation");
      }
      expect(value.completeness).toBe("complete");
      expect(Number.isNaN(Date.parse(value.asOf))).toBe(false);
      return { scope: { kind: scope.kind, key: scope.key }, completeness: value.completeness, asOf: value.asOf, revision: value.revision };
    };

    const listed = await catalog["catalog.list"]!.execute({ harness }, invocation(cwd));
    expect(listed.status).toBe("ok");
    if (listed.status === "ok") {
      const evidence = observation(listed.data);
      expect(evidence.scope.kind).toBe("query");
      expect(evidence.scope.key.startsWith("catalog:")).toBe(true);
    }

    const shownCatalog = await catalog["catalog.show"]!.execute({ kind: "project", id: "proj", harness }, invocation(cwd));
    expect(shownCatalog.status).toBe("ok");
    if (shownCatalog.status === "ok") {
      expect(observation(shownCatalog.data).scope).toEqual({ kind: "query", key: "catalog:project:proj" });
    }

    const binding = await project["project.show"]!.execute({ project: "proj", harness }, invocation(cwd));
    expect(binding.status).toBe("ok");
    if (binding.status === "ok") {
      expect(observation(binding.data).scope).toEqual({ kind: "project", key: "proj" });
      // why: A named absence keeps its own keys AND the observation of the read.
      expect(binding.data).toMatchObject({ kind: "absent", code: "linear.binding-absent" });
    }

    const missing = await project["project.show"]!.execute({ project: "not-registered", harness }, invocation(cwd));
    expect(missing.status).toBe("ok");
    if (missing.status === "ok") {
      // see packages/commands/test/catalog-roadmap.test.ts - // note: No fabricated record: a project with no binding answers its own absent arm.
      expect(missing.data).toMatchObject({ kind: "absent", code: "linear.binding-absent" });
      expect(observation(missing.data).scope).toEqual({ kind: "project", key: "not-registered" });
    }
  });

  test("collaboration command evidence: a catalog page reads links in the same snapshot as its rows", async () => {
    const { cwd, harness } = await activeFixture("catalog-link-snapshot");
    await registerCatalogEntity({ harnessDir: harness }, {
      kind: "document", id: "doc-late", title: "Late doc", documentKind: "spec", rootKind: "specs", relativePath: "doc-late.md",
    }, { operationId: "late-doc", actor: "test" });
    const lanePath = resolveCollaborationLocation({ harnessDir: harness }).dbPath;

    // invariant: Deterministic interleave: the newer link commits at the instant the page's
    // rows read finishes and its transaction commits. A page that reads its
    // links after that commit answers the newer revision; one that reads them
    // inside its own snapshot cannot.
    const realPrepare = DatabaseSync.prototype.prepare;
    const realExec = DatabaseSync.prototype.exec;
    let sawPageRows = false;
    let injected = false;
    const commitLateLink = () => {
      if (injected) return;
      injected = true;
      const writer = new DatabaseSync(lanePath);
      try {
        writer.exec("pragma busy_timeout=2000");
        writer.prepare(
          "insert into catalog_links(from_kind, from_id, relation, to_kind, to_id) values ('project', 'proj', 'documents', 'document', 'doc-late')",
        ).run();
        writer.prepare("update collaboration_meta set revision = revision + 1, catalog_revision = catalog_revision + 1 where id = 1").run();
      } finally {
        writer.close();
      }
    };
    const prepareSpy = spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes("from catalog_entities") && sql.includes("order by catalog_entities.kind")) sawPageRows = true;
      return realPrepare.call(this, sql);
    });
    const execSpy = spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      const result = realExec.call(this, sql);
      if (sawPageRows && sql.trim().toLowerCase() === "commit") commitLateLink();
      return result;
    });
    try {
      const listed = await catalog["catalog.list"]!.execute({ harness }, invocation(cwd));
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") return;
      expect(injected).toBe(true);
      const page = listed.data as { links: unknown[]; storeRevision: number; collaboration: { revision: number } };
      // note: The page answered before the link committed: no late link, and the
      // evidence names the revision its rows were actually read at.
      expect(page.links).toEqual([]);
      expect(page.collaboration.revision).toBe(page.storeRevision);
    } finally {
      execSpy.mockRestore();
      prepareSpy.mockRestore();
    }
  });
});
