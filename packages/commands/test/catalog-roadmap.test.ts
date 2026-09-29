import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMilestoneCommandDefinitions } from "../src/families/milestone.js";
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
const markdown = (title: string) => `---\nproject_id: proj\ntitle: ${JSON.stringify(title)}\nstatus: active\ncreated_at: 2026-09-26\n---\n\n## Direction\n\nReviewed roadmap content.\n`;

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

  test("reviewed import keeps its saved comparison basis and raw replacement states its own", async () => {
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

  test("roadmap JSON export returns the v2 envelope", async () => {
    const { cwd, harness } = await activeFixture("roadmap-json-export");
    const exported = await roadmap["roadmap.export"]!.execute({ project: "proj", format: "json", harness }, invocation(cwd));
    expect(exported).toMatchObject({ version: 1, command: "roadmap.export", status: "ok", code: "roadmap.export.ok", exitCode: 0 });
    if (exported.status === "ok") expect(exported.data).toMatchObject({ version: 2, projectId: "proj", storeRevision: expect.any(Number), catalogRevision: expect.any(Number), contentMarkdown: null, direction: null, milestones: { projectId: "proj", milestones: [], issues: [], unassignedIssues: 0 }, projection: { freshness: expect.any(String) } });
  });
});
