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
});
