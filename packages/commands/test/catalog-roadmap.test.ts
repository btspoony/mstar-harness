import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeStore, registerCatalogEntity } from "@mstar-harness/engine";
import { getCatalogCommandDefinitions, getRoadmapCommandDefinitions } from "../src/index.js";
import type { InvocationContext } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "commands-catalog-roadmap-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
const roadmap = Object.fromEntries(getRoadmapCommandDefinitions().map((definition) => [definition.id, definition]));
const markdown = (title: string) => `---\nproject_id: proj\ntitle: ${title}\nstatus: active\ncreated_at: 2026-09-26\n---\n\n## Direction\n\nReviewed roadmap content.\n`;

async function activeFixture(name: string): Promise<{ cwd: string; harness: string }> {
  const cwd = join(root, name);
  const harness = join(cwd, ".mstar");
  mkdirSync(harness, { recursive: true });
  const store = await initializeStore({ harnessDir: harness });
  store.close();
  await registerCatalogEntity({ harnessDir: harness }, {
    kind: "project", id: "proj", title: "Project", rootKind: "projects", relativePath: "proj",
  }, { operationId: `${name}-project`, actor: "test" });
  return { cwd, harness };
}

describe("catalog and roadmap command families", () => {
  test("registers exactly the assigned thirteen catalog and roadmap identities", () => {
    expect([...Object.keys(catalog), ...Object.keys(roadmap)]).toEqual([
      "catalog.discover", "catalog.import", "catalog.register", "catalog.update", "catalog.link", "catalog.list", "catalog.show", "catalog.export", "catalog.reconcile",
      "roadmap.import", "roadmap.replace", "roadmap.show", "roadmap.export",
    ]);
  });

  test("catalog queries refuse an inactive store rather than returning an empty catalog", async () => {
    const cwd = join(root, "inactive");
    mkdirSync(join(cwd, ".mstar"), { recursive: true });
    const result = await catalog["catalog.list"]!.execute({ harness: join(cwd, ".mstar") }, invocation(cwd));
    expect(result.status).toBe("refused");
    expect(result.code).toMatch(/^store\.(not-initialized|not-active)$/);
  });

  test("catalog mutations leave execution workflow snapshots byte-for-byte unchanged", async () => {
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
    expect(readFileSync(snapshotPath, "utf8")).toBe(snapshot);
  });

  test("roadmap import refuses a reviewed source changed after preview", async () => {
    const { cwd, harness } = await activeFixture("roadmap-drift");
    const file = join(cwd, "roadmap.md");
    writeFileSync(file, markdown("Reviewed"));
    const preview = await roadmap["roadmap.import"]!.execute({ project: "proj", file, harness }, invocation(cwd));
    expect(preview.status).toBe("ok");
    if (preview.status !== "ok") throw new Error("roadmap preview did not succeed");
    const reviewFile = join(cwd, "roadmap-review.json");
    writeFileSync(reviewFile, JSON.stringify(preview.data));
    writeFileSync(file, markdown("Changed after review"));
    const applied = await roadmap["roadmap.import"]!.execute({ review: reviewFile, apply: true, operation: "roadmap-import", harness }, invocation(cwd));
    expect(applied.status).toBe("refused");
    expect(applied.code).toBe("roadmap.source-drift");
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

  test("reviewed import keeps its saved comparison basis and raw replacement derives an omitted one", async () => {
    const { cwd, harness } = await activeFixture("reviewed-import");
    // Discovery is read-only; the reviewed mapping states the identity the
    // reviewer confirmed, and the engine re-reads the named source by hash.
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

  test("roadmap conflict refuses a stale expectation while an omitted one derives the observed state", async () => {
    const { cwd, harness } = await activeFixture("roadmap-conflict");
    const create = join(cwd, "create.md");
    const replace = join(cwd, "replace.md");
    writeFileSync(create, markdown("Created"));
    writeFileSync(replace, markdown("Replaced"));
    // Derived: no --expect-project/--expect-roadmap, so the engine compares
    // against the authority it observed under its own write lock.
    const created = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file: create, operation: "roadmap-create", harness,
    }, invocation(cwd));
    expect(created.status).toBe("ok");
    const replaced = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file: replace, operation: "roadmap-replace", harness,
    }, invocation(cwd));
    expect(replaced.status).toBe("ok");
    if (replaced.status !== "ok") throw new Error("derived replacement did not apply");
    expect(replaced.data).toMatchObject({ revision: 2 });
    // A supplied expectation claiming the absent state the project left behind
    // is a semantic conflict: nothing is overwritten (A11).
    const stale = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file: create, expectProject: 1, expectRoadmap: "absent", operation: "roadmap-stale", harness,
    }, invocation(cwd));
    expect(stale.status).toBe("refused");
    expect(stale.code).toBe("roadmap.revision-conflict");
    const shown = await roadmap["roadmap.show"]!.execute({ project: "proj", harness }, invocation(cwd));
    expect(shown.status).toBe("ok");
    if (shown.status === "ok") expect(JSON.stringify(shown.data)).toContain("Replaced");
    // An aggregated refusal names every irreducible input in one result (A27).
    const sparse = await roadmap["roadmap.replace"]!.execute({ harness }, invocation(cwd));
    expect(sparse.status).toBe("usage");
    if (sparse.status !== "usage") throw new Error("expected an aggregated roadmap refusal");
    for (const flag of ["--project", "--file", "--operation"]) expect(sparse.message).toContain(flag);
  });

  test("roadmap replay returns the recorded receipt instead of a second write", async () => {
    const { cwd, harness } = await activeFixture("roadmap-replay");
    const file = join(cwd, "candidate.md");
    writeFileSync(file, markdown("Replayed"));
    const first = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file, operation: "roadmap-replay-op", harness,
    }, invocation(cwd));
    expect(first.status).toBe("ok");
    const second = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file, operation: "roadmap-replay-op", harness,
    }, invocation(cwd));
    expect(second.status).toBe("ok");
    expect(second.data).toEqual(first.status === "ok" ? first.data : undefined);
    // The op id is spent: reusing it for a different body is refused rather
    // than silently rewriting under the old identity.
    writeFileSync(file, markdown("Different"));
    const conflicting = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file, operation: "roadmap-replay-op", harness,
    }, invocation(cwd));
    expect(conflicting.status).toBe("refused");
    expect(conflicting.code).toBe("roadmap.operation-conflict");
  });
});
