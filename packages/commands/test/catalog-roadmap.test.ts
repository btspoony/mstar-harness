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
import { getCatalogCommandDefinitions, getRoadmapCommandDefinitions } from "../src/index.js";
import { getProjectCommandDefinitions } from "../src/families/project.js";
import { failure as catalogFailure } from "../src/families/catalog.js";
import { failure as roadmapFailure } from "../src/families/roadmap.js";

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
const roadmap = Object.fromEntries(getRoadmapCommandDefinitions().map((definition) => [definition.id, definition]));
const project = Object.fromEntries(getProjectCommandDefinitions().map((definition) => [definition.id, definition]));
const markdown = (title: string) => `---\nproject_id: proj\ntitle: ${JSON.stringify(title)}\nstatus: active\ncreated_at: 2026-09-26\n---\n\n## Direction\n\nReviewed roadmap content.\n`;

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

describe("catalog and roadmap command families", () => {
  test("catalog refusal preserves engine code and verbatim first line", () => {
    const result = catalogFailure("catalog.update", Object.assign(new Error("engine catalog refusal detail"), { code: "catalog.engine-refused" }));
    expect(result.status).toBe("refused");
    expect(result.code).toBe("catalog.engine-refused");
    expect(result.message.split("\n", 1)[0]).toBe("engine catalog refusal detail");
    expect(result.details).toHaveProperty("helpRoute");
  });

  test("roadmap refusal preserves engine code and verbatim first line", () => {
    const result = roadmapFailure("roadmap.replace", Object.assign(new Error("engine roadmap refusal detail"), { code: "roadmap.engine-refused" }));
    expect(result.status).toBe("refused");
    expect(result.code).toBe("roadmap.engine-refused");
    expect(result.message.split("\n", 1)[0]).toBe("engine roadmap refusal detail");
    expect(result.details).toHaveProperty("helpRoute");
  });


  test("registers exactly the assigned fourteen catalog and roadmap identities", () => {
    expect([...Object.keys(catalog), ...Object.keys(roadmap)]).toEqual([
      "catalog.discover", "catalog.import", "catalog.register", "catalog.update", "catalog.link", "catalog.list", "catalog.show", "catalog.export", "catalog.reconcile", "catalog.purge-registration",
      "roadmap.import", "roadmap.replace", "roadmap.show", "roadmap.export",
    ]);
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

  test("roadmap import publishes current source content after a saved preview", async () => {
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
    expect(applied.status).toBe("ok");
    const shown = await roadmap["roadmap.show"]!.execute({ project: "proj", harness }, invocation(cwd));
    expect(shown.status).toBe("ok");
    if (shown.status !== "ok") throw new Error("roadmap read did not succeed");
    expect(shown.data).toMatchObject({ roadmap: { contentMarkdown: markdown("Changed after review") } });
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

  test("roadmap replace requires the caller's revision claims and refuses a stale one", async () => {
    const { cwd, harness } = await activeFixture("roadmap-conflict");
    const create = join(cwd, "create.md");
    const replace = join(cwd, "replace.md");
    writeFileSync(create, markdown("Created"));
    writeFileSync(replace, markdown("Replaced"));
    const created = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file: create, expectProject: 1, expectRoadmap: "absent", operation: "roadmap-create", harness,
    }, invocation(cwd));
    expect(created.status).toBe("ok");
    // An omitted claim is NOT derived from the transaction's own read: the
    // comparison basis is a caller fact, so a stale read cannot silently
    // overwrite a newer update (A11). Both flags are named in one refusal.
    const derived = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file: replace, operation: "roadmap-derived", harness,
    }, invocation(cwd));
    expect(derived.status).toBe("usage");
    if (derived.status !== "usage") throw new Error("expected an aggregated roadmap refusal");
    for (const flag of ["--expect-project", "--expect-roadmap"]) expect(derived.message).toContain(flag);
    const untracked = await roadmap["roadmap.show"]!.execute({ project: "proj", harness }, invocation(cwd));
    if (untracked.status === "ok") expect(JSON.stringify(untracked.data)).not.toContain("Replaced");

    const replaced = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file: replace, expectProject: 1, expectRoadmap: 1, operation: "roadmap-replace", harness,
    }, invocation(cwd));
    expect(replaced.status).toBe("ok");
    if (replaced.status !== "ok") throw new Error("claimed replacement did not apply");
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
    for (const flag of ["--project", "--file", "--expect-project", "--expect-roadmap", "--operation"]) {
      expect(sparse.message).toContain(flag);
    }
  });

  test("roadmap replay returns the recorded receipt instead of a second write", async () => {
    const { cwd, harness } = await activeFixture("roadmap-replay");
    const file = join(cwd, "candidate.md");
    writeFileSync(file, markdown("Replayed"));
    const claim = { expectProject: 1, expectRoadmap: "absent" } as const;
    const first = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file, operation: "roadmap-replay-op", harness, ...claim,
    }, invocation(cwd));
    expect(first.status).toBe("ok");
    // The replay reuses the SAME declared claim: hashing the declared intent
    // keeps an identical retry from turning into an operation conflict (A09).
    const second = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file, operation: "roadmap-replay-op", harness, ...claim,
    }, invocation(cwd));
    expect(second.status).toBe("ok");
    expect(second.data).toEqual(first.status === "ok" ? first.data : undefined);
    // The op id is spent: reusing it for a different body is refused rather
    // than silently rewriting under the old identity.
    writeFileSync(file, markdown("Different"));
    const conflicting = await roadmap["roadmap.replace"]!.execute({
      project: "proj", file, operation: "roadmap-replay-op", harness, ...claim,
    }, invocation(cwd));
    expect(conflicting.status).toBe("refused");
    expect(conflicting.code).toBe("roadmap.operation-conflict");
  });

  test("milestone grouped roadmap export retains absent prose and escapes stored text", async () => {
    const { cwd, harness } = await activeFixture("milestone-roadmap-export");
    const add = getMilestoneCommandDefinitions().find(item => item.id === "milestone.add")!;
    const added = await add.execute({ project: "proj", name: "Build | *[link]<tag>`code`", ordinal: 0, expectStore: 1, operation: "milestone-add", harness }, invocation(cwd));
    expect(added.status).toBe("ok");
    const exported = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "markdown", harness }, invocation(cwd));
    expect(exported.status).toBe("ok");
    if (exported.status === "ok") {
      expect(exported.data).toContain('project_id: "proj"');
      expect(exported.data).toContain('title: "Project"');
      expect(exported.data).toContain('status: "active"');
      expect(exported.data).toContain("created_at: ");
      const file = join(cwd, "roadmap.md");
      writeFileSync(file, String(exported.data));
      const roundTrip = await roadmap["roadmap.replace"]!.execute({ project: "proj", file, expectProject: 1, expectRoadmap: "absent", operation: "roadmap-export-roundtrip", harness }, invocation(cwd));
      expect(roundTrip.status).toBe("ok");
      expect(exported.data).toContain("Build \\| \\*\\[link\\]\\<tag\\>\\`code\\`");
      expect(exported.data).toContain("No stored Direction.");
      expect(exported.data).toContain("No linked issues.");
    }
  });

  test("direction export is byte-stable across export, replace and re-export (no escaping accumulation)", async () => {
    const { cwd, harness } = await activeFixture("direction-roundtrip");
    const directionWithSyntax = "Retained **bold** prose with [a link](https://example.test) and `code` spans — verbatim.";
    const indentedCode = "    const first = line();\n    return first;";
    const source = `---\nproject_id: proj\ntitle: Project\nstatus: active\ncreated_at: 2026-09-29\n---\n\n## Direction\n\n${indentedCode}\n\n${directionWithSyntax}\n`;
    const sourceFile = join(cwd, "direction-source.md");
    writeFileSync(sourceFile, source);
    const seed = await roadmap["roadmap.replace"]!.execute({ project: "proj", file: sourceFile, expectProject: 1, expectRoadmap: "absent", operation: "direction-seed", harness }, invocation(cwd));
    expect(seed.status).toBe("ok");

    const first = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "markdown", harness }, invocation(cwd));
    expect(first.status).toBe("ok");
    const firstMarkdown = String(first.data);
    expect(firstMarkdown).toContain(directionWithSyntax);

    const roundTripFile = join(cwd, "roadmap-roundtrip.md");
    writeFileSync(roundTripFile, firstMarkdown);
    const replace = await roadmap["roadmap.replace"]!.execute({ project: "proj", file: roundTripFile, expectProject: 1, expectRoadmap: 1, operation: "direction-roundtrip-replace", harness }, invocation(cwd));
    expect(replace.status).toBe("ok");

    const second = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "markdown", harness }, invocation(cwd));
    expect(second.status).toBe("ok");
    const firstDirection = String(first.data).split("## Direction")[1];
    const secondDirection = String(second.data).split("## Direction")[1];
    expect(secondDirection).toBe(firstDirection);
    expect(secondDirection).not.toContain("\\*\\*");
    expect(secondDirection).toContain("    const first = line();");
  });

  test("quoted and backslash roadmap titles export verbatim and can be replaced", async () => {
    const { cwd, harness } = await activeFixture("quoted-title-roundtrip");
    const title = 'He said "hi" \\ adjusted';
    const sourceFile = join(cwd, "roadmap-source.md");
    writeFileSync(sourceFile, markdown(title));
    const seed = await roadmap["roadmap.replace"]!.execute({ project: "proj", file: sourceFile, expectProject: 1, expectRoadmap: "absent", operation: "quoted-title-seed", harness }, invocation(cwd));
    expect(seed.status).toBe("ok");

    const exported = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "markdown", harness }, invocation(cwd));
    expect(exported.status).toBe("ok");
    const exportedMarkdown = String(exported.data);
    expect(exportedMarkdown.split("\n").find((line) => line.startsWith("title: "))).toBe(`title: ${JSON.stringify(title)}`);

    const roundTripFile = join(cwd, "roadmap-roundtrip.md");
    writeFileSync(roundTripFile, exportedMarkdown);
    const replace = await roadmap["roadmap.replace"]!.execute({ project: "proj", file: roundTripFile, expectProject: 1, expectRoadmap: 1, operation: "quoted-title-roundtrip-replace", harness }, invocation(cwd));
    expect(replace.status).toBe("ok");
  });

  test("quoted and bracketed roadmap titles survive export and replace", async () => {
    const titles = [
      'He said "hi" and O\'Brien said \'no\'',
      "[Phase 1] rollout",
      "plain title",
    ];
    for (const [titleIndex, title] of titles.entries()) {
      const { cwd, harness } = await activeFixture(`title-quoting-${titleIndex}`);
      const source = [
        "---",
        "project_id: proj",
        `title: ${JSON.stringify(title)}`,
        "status: active",
        "created_at: 2026-09-29",
        "---",
        "",
        "## Direction",
        "",
        "Retained prose.",
        "",
      ].join("\n");
      const sourceFile = join(cwd, "title-source.md");
      writeFileSync(sourceFile, source);
      const seeded = await roadmap["roadmap.replace"]!.execute({ project: "proj", file: sourceFile, expectProject: 1, expectRoadmap: "absent", operation: `title-seed-${title}`, harness }, invocation(cwd));
      expect(seeded.status).toBe("ok");
      const exported = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "markdown", harness }, invocation(cwd));
      expect(exported.status).toBe("ok");
      const exportedFile = join(cwd, "roadmap-exported.md");
      writeFileSync(exportedFile, String(exported.data));
      const replaced = await roadmap["roadmap.replace"]!.execute({ project: "proj", file: exportedFile, expectProject: 1, expectRoadmap: 1, operation: `title-replace-${title}`, harness }, invocation(cwd));
      expect(replaced.status).toBe("ok");
      const shown = await roadmap["roadmap.show"]!.execute({ project: "proj", harness }, invocation(cwd));
      expect(shown.status).toBe("ok");
      if (shown.status === "ok") {
        expect(shown.data.content.frontmatter.title).toBe(title);
      }
    }
  });

  test("newline title round-trips through export and replace", async () => {
    const { cwd, harness } = await activeFixture("newline-title");
    const title = "Line one\nLine two";
    const source = [
      "---",
      "project_id: proj",
      "title: " + JSON.stringify(title),
      "status: active",
      "created_at: 2026-09-29",
      "---",
      "",
      "## Direction",
      "",
      "Retained prose.",
      "",
    ].join("\n");
    const sourceFile = join(cwd, "newline-source.md");
    writeFileSync(sourceFile, source);
    const seeded = await roadmap["roadmap.replace"]!.execute({ project: "proj", file: sourceFile, expectProject: 1, expectRoadmap: "absent", operation: "newline-seed", harness }, invocation(cwd));
    expect(seeded.status).toBe("ok");
    const exported = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "markdown", harness }, invocation(cwd));
    expect(exported.status).toBe("ok");
    const exportedFile = join(cwd, "newline-exported.md");
    writeFileSync(exportedFile, String(exported.data));
    const replaced = await roadmap["roadmap.replace"]!.execute({ project: "proj", file: exportedFile, expectProject: 1, expectRoadmap: 1, operation: "newline-replace", harness }, invocation(cwd));
    expect(replaced.status).toBe("ok");
    const shown = await roadmap["roadmap.show"]!.execute({ project: "proj", harness }, invocation(cwd));
    expect(shown.status).toBe("ok");
    if (shown.status === "ok") {
      expect(shown.data.content.frontmatter.title).toBe(title);
    }
  });

  test("collaboration command evidence: catalog, roadmap export and project show share their read's observation", async () => {
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

    const shownRoadmap = await roadmap["roadmap.show"]!.execute({ project: "proj", harness }, invocation(cwd));
    expect(shownRoadmap.status).toBe("ok");
    if (shownRoadmap.status === "ok") {
      expect(observation(shownRoadmap.data).scope).toEqual({ kind: "project", key: "proj" });
      // note: Existing show fields are preserved alongside the evidence.
      expect(shownRoadmap.data).toMatchObject({ projectId: "proj", projectRevision: 1, roadmap: null, content: null });
    }

    const exported = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "json", harness }, invocation(cwd));
    expect(exported.status).toBe("ok");
    if (exported.status === "ok") {
      const evidence = observation(exported.data);
      // note: The export's counters and its evidence come from the same read; the
      // roadmap view is project-scoped.
      if (exported.data === null || typeof exported.data !== "object" || !("storeRevision" in exported.data) || typeof exported.data.storeRevision !== "number") {
        throw new Error("roadmap export carries no storeRevision");
      }
      expect(evidence.revision).toBe(exported.data.storeRevision);
      expect(evidence.scope).toEqual({ kind: "project", key: "proj" });
    }

    const binding = await project["project.show"]!.execute({ project: "proj", harness }, invocation(cwd));
    expect(binding.status).toBe("ok");
    if (binding.status === "ok") {
      expect(observation(binding.data).scope).toEqual({ kind: "project", key: "proj" });
      // why: A named absence keeps its own keys AND the observation of the read.
      expect(binding.data).toMatchObject({ kind: "absent", code: "linear.binding-absent" });
    }

    const missing = await roadmap["roadmap.export"]!.execute({ project: "not-registered", format: "json", harness }, invocation(cwd));
    expect(missing).toMatchObject({ status: "refused", code: "roadmap.project-not-found" });
    if (missing.status !== "ok") {
      // note: No fabricated record: the refusal names its own code and carries the
      // complete observation the read established.
      expect(observation(missing.details).scope).toEqual({ kind: "project", key: "not-registered" });
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

  test("roadmap export states a real created_at and omits one no stored date can fill", async () => {
    const { cwd, harness } = await activeFixture("roadmap-created-at");
    // note: A dated export round-trips: the exported document is itself replaceable and
    // re-exports the same frontmatter line.
    const dated = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "markdown", harness }, invocation(cwd));
    expect(dated.status).toBe("ok");
    const datedMarkdown = String(dated.data);
    const datedLine = datedMarkdown.split("\n").find((line) => line.startsWith("created_at: "));
    expect(datedLine).toMatch(/^created_at: "\d{4}-\d{2}-\d{2}"$/);
    const datedFile = join(cwd, "created-at-dated.md");
    writeFileSync(datedFile, datedMarkdown);
    const replaced = await roadmap["roadmap.replace"]!.execute({ project: "proj", file: datedFile, expectProject: 1, expectRoadmap: "absent", operation: "created-at-dated", harness }, invocation(cwd));
    expect(replaced.status).toBe("ok");
    const reexported = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "markdown", harness }, invocation(cwd));
    expect(String(reexported.data).split("\n").find((line) => line.startsWith("created_at: "))).toBe(datedLine);

    // invariant: A recorded identity with no usable date (a remote snapshot's null, a blank
    // legacy row) leaves the field out; an empty scalar would fail `YYYY-MM-DD`.
    const undated = await activeFixture("roadmap-created-at-absent");
    const lane = resolveCollaborationLocation({ harnessDir: undated.harness }).dbPath;
    const writer = new DatabaseSync(lane);
    try {
      writer.prepare("update catalog_entities set registered_at = '', updated_at = '' where kind = 'project' and id = 'proj'").run();
    } finally {
      writer.close();
    }
    const blank = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "markdown", harness: undated.harness }, invocation(undated.cwd));
    expect(blank.status).toBe("ok");
    const blankMarkdown = String(blank.data);
    expect(blankMarkdown).not.toContain("created_at");
    // invariant: The omitted `created_at` is an importable form, not a dead end: the exported
    // document round-trips through the same validation `roadmap.replace` runs, so export and
    // import agree for a roadmap with no usable date.
    const blankFile = join(undated.cwd, "created-at-blank.md");
    writeFileSync(blankFile, blankMarkdown);
    const blankReplaced = await roadmap["roadmap.replace"]!.execute(
      { project: "proj", file: blankFile, expectProject: 1, expectRoadmap: "absent", operation: "created-at-blank", harness: undated.harness },
      invocation(undated.cwd),
    );
    expect(blankReplaced.status).toBe("ok");
    const blankReexported = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "markdown", harness: undated.harness }, invocation(undated.cwd));
    const blankReexportedMarkdown = String(blankReexported.data);
    expect(blankReexportedMarkdown).not.toContain("created_at");
    // invariant: The undated candidate round-trips unchanged - frontmatter and authored body
    // alike - so the accepted omission is a stable document, not merely an export that parses.
    // The store's own revision footer advances with the write and is not document content.
    const documentBody = (markdown: string) =>
      markdown.split("\n").filter((line) => !line.startsWith("Store revision: ")).join("\n");
    expect(documentBody(blankReexportedMarkdown)).toBe(documentBody(blankMarkdown));
    expect(blankReexportedMarkdown).toContain('project_id: "proj"');
  });

  test("roadmap JSON export returns the v2 envelope", async () => {
    const { cwd, harness } = await activeFixture("roadmap-json-export");
    const exported = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "json", harness }, invocation(cwd));
    expect(exported).toMatchObject({ version: 1, command: "roadmap.export", status: "ok", code: "roadmap.export.ok", exitCode: 0 });
    if (exported.status === "ok") expect(exported.data).toMatchObject({ version: 2, projectId: "proj", storeRevision: expect.any(Number), catalogRevision: expect.any(Number), contentMarkdown: null, direction: null, milestones: { projectId: "proj", milestones: [], issues: [], unassignedIssues: 0 }, projection: { freshness: expect.any(String) } });
  });
});
