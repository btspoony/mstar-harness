/**
 * catalog-import.test.ts -- P2 proof for the discovery / reviewed-mapping
 * import and versioned export transport over the P1 catalog authority (plan
 * 20260918-state-projection Task 2).
 *
 * The suite runs against the real module, the real catalog domain verbs, the
 * real migration runner and the real `node:sqlite` driver in per-test temporary
 * harness roots. No mock database and no mocked filesystem exist here.
 *
 * Run with `bun test packages/engine/src/catalog-import.test.ts`.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  CATALOG_IMPORT_PLAN_VERSION,
  catalogExportToInputs,
  discoverCatalog,
  exportCatalog,
  importCatalog,
  planCatalogImport,
  verifyCatalogImport,
  type CatalogImportInput,
  type CatalogImportPlan,
} from "./catalog-import.js";
import { getCatalog, listCatalog, registerCatalogEntity } from "./catalog.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-catalog-import-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

type Fixture = { context: StoreContext; workspace: string; harness: string };

/** A temp workspace with a real `.mstar` harness root and an active store. */
async function freshWorkspace(name: string): Promise<Fixture> {
  const workspace = mkdtempSync(join(ROOT, name));
  const harness = join(workspace, ".mstar");
  mkdirSync(harness, { recursive: true });
  const handle = await initializeStore({ harnessDir: workspace });
  handle.close();
  return { context: { harnessDir: workspace }, workspace, harness };
}

/**
 * Catalog row counts read through the store's own write connection. A refused
 * import must leave zero rows behind, and this reads that fact from the real
 * database rather than from a returned receipt.
 */
async function catalogRows(context: StoreContext): Promise<{ entities: number; links: number }> {
  const handle = await openStore(context, "write");
  try {
    const entities = handle.db.prepare("select count(*) as n from catalog_entities").get() as { n: number };
    const links = handle.db.prepare("select count(*) as n from catalog_links").get() as { n: number };
    return { entities: entities.n, links: links.n };
  } finally {
    handle.close();
  }
}

function write(harness: string, relativePath: string, text: string): string {
  const absolute = join(harness, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text.endsWith("\n") ? text : `${text}\n`);
  return absolute;
}

function md(...lines: string[]): string {
  return lines.join("\n");
}

/**
 * The mixed legacy index fixture: narrative prose, the canonical iteration
 * table, and a second unrelated table that must never be consumed (§4 keeps
 * the human report content of a mixed README).
 */
const ITERATIONS_README = md(
  "# Iterations",
  "",
  "This narrative explains the iteration program and stays human-owned prose.",
  "",
  "| Iteration | Path | Description | Status |",
  "|-----------|------|-------------|--------|",
  "| `iter-alpha` | [`iter-alpha/`](iter-alpha/) | Alpha iteration package | `active` |",
  "",
  "## Promotion log",
  "",
  "| Source | Promoted to | Date |",
  "|--------|-------------|------|",
  "| iter-alpha | knowledge/patterns | 2026-09-18 |",
);

const KNOWLEDGE_README = md(
  "# Knowledge Index",
  "",
  "| Document | Source | Description | Status |",
  "|----------|--------|-------------|--------|",
  "| `patterns/guard.md` | plan 20260918-alpha | Guard pattern notes | Active |",
  "| `patterns/old.md` | plan 20260917-alpha | Superseded pattern | superseded |",
);

const KNOWLEDGE_BODY = md("---", "category: patterns", "severity: medium", "---", "", "# Guard pattern notes", "", "Body text.");

const PACKAGE_README = md(
  "# iter-alpha",
  "",
  "Iteration package narrative stays.",
  "",
  "## Documents",
  "",
  "| Document | Kind | Description | Status |",
  "|----------|------|-------------|--------|",
  "| [delivery-compass.md](delivery-compass.md) | compass | Delivery scope | active |",
  "| [guides/notes.md](guides/notes.md) | guide | Working notes | snapshot-only |",
);

/** The full mixed fixture used by the discovery and conflict cases. */
async function mixedFixture(name: string): Promise<Fixture> {
  const fixture = await freshWorkspace(name);
  const { harness } = fixture;
  write(harness, "iterations/README.md", ITERATIONS_README);
  write(harness, "iterations/iter-alpha/README.md", PACKAGE_README);
  write(harness, "iterations/iter-alpha/delivery-compass.md", md("---", "iteration_id: iter-alpha", "---", "", "# iter-alpha Delivery Compass"));
  write(harness, "iterations/iter-alpha/guides/notes.md", md("# Working notes"));
  write(harness, "knowledge/README.md", KNOWLEDGE_README);
  write(harness, "knowledge/patterns/guard.md", KNOWLEDGE_BODY);
  write(harness, "knowledge/patterns/old.md", md("# Old pattern"));
  write(harness, "knowledge/patterns/20260918-alpha-notes.md", md("# Notes named after a plan"));
  write(harness, "specs/README.md", md("# Specs", "", "| Document | Description | Status |", "|----------|-------------|--------|"));
  write(harness, "specs/contract.md", md("# Contract", "", "Spec body."));
  write(harness, "specs/notes/README.md", md("# Ordinary README inside a walked root"));
  write(harness, "specs/INSTALL.md", md("# Install notes"));
  write(harness, "plans/20260918-alpha.md", md("# Alpha plan"));
  write(harness, "projects/proj-a/roadmap.md", md("---", "project_id: proj-a", "title: Project Alpha", "status: active", "---", "", "# Project Alpha"));
  return fixture;
}

function entityAt(plan: CatalogImportPlan, relativePath: string) {
  return plan.entities.find((proposal) => proposal.relativePath === relativePath);
}

describe("catalog discovery", () => {
  test("inventories layout identities, index rows and tracked bodies as proposals", async () => {
    const { context } = await mixedFixture("discovery-");
    const plan = await discoverCatalog(context);

    expect(plan.version).toBe(CATALOG_IMPORT_PLAN_VERSION);
    expect(entityAt(plan, "iter-alpha")?.kind).toBe("iteration");
    expect(entityAt(plan, "proj-a")?.kind).toBe("project");
    expect(entityAt(plan, "proj-a")?.title).toBe("Project Alpha");
    expect(entityAt(plan, "20260918-alpha.md")?.kind).toBe("plan");
    expect(entityAt(plan, "20260918-alpha.md")?.title).toBe("Alpha plan");
    expect(entityAt(plan, "contract.md")?.documentKind).toBe("spec");
    expect(entityAt(plan, "patterns/guard.md")?.documentKind).toBe("knowledge");
    // The canonical iteration table row agrees with the directory layout.
    expect(entityAt(plan, "iter-alpha")?.description).toBe("Alpha iteration package");
    expect(plan.conflicts).toEqual([]);
    expect(plan.unknowns.some((unknown) => unknown.code === "duplicate-row")).toBe(false);
  });

  test("preserves mixed README narrative and retires only the recognized index table", async () => {
    const { context, harness } = await mixedFixture("narrative-");
    const plan = await discoverCatalog(context);

    const section = plan.retirementSections.find((candidate) => candidate.relativePath === "README.md" && candidate.rootKind === "iterations");
    expect(section).toBeDefined();
    // The table is lines 5..7 of a 13-line file; the narrative (1..4) and the
    // unrelated promotion-log table (8..13) stay outside the retired range.
    expect(section!.startLine).toBe(5);
    expect(section!.endLine).toBe(7);
    expect(section!.header).toBe("Iteration | Path | Description | Status");
    expect(section!.preservedLines).toBe(10);
    expect(plan.retirementSections.filter((candidate) => candidate.rootKind === "iterations" && candidate.relativePath === "README.md")).toHaveLength(1);

    // Nothing in the narrative or the unrelated table became a proposal.
    const texts = plan.entities.flatMap((proposal) => [proposal.title, proposal.description ?? ""]);
    expect(texts.some((text) => text.includes("narrative explains"))).toBe(false);
    expect(texts.some((text) => text.includes("Promoted to"))).toBe(false);
    expect(entityAt(plan, "iter-alpha")?.evidence.map((entry) => entry.sourceKey)).toContain("iterations:README.md");

    // The reviewed hash of the mixed file is part of the plan.
    expect(plan.sourceDigests.some((digest) => digest.sourceKey === "iterations:README.md")).toBe(true);
    expect(plan.sourceDigests.some((digest) => digest.sourceKey === "knowledge:README.md")).toBe(true);
    expect(readdirSync(join(harness, "iterations")).includes("README.md")).toBe(true);
  });

  test("excludes ordinary README/INSTALL content and never follows a symlink", async () => {
    const { context, harness } = await mixedFixture("ordinary-");
    symlinkSync(join(harness, "knowledge/patterns/guard.md"), join(harness, "specs/linked.md"));

    const plan = await discoverCatalog(context);
    expect(entityAt(plan, "notes/README.md")).toBeUndefined();
    expect(entityAt(plan, "INSTALL.md")).toBeUndefined();
    expect(entityAt(plan, "linked.md")).toBeUndefined();
    expect(plan.entities.every((proposal) => !proposal.relativePath.toLowerCase().endsWith("install.md"))).toBe(true);
  });

  test("never infers a relation from a file name or directory, only from an explicit index row", async () => {
    const { context } = await mixedFixture("relations-");
    const plan = await discoverCatalog(context);

    const notes = entityAt(plan, "patterns/20260918-alpha-notes.md");
    expect(notes).toBeDefined();
    expect(plan.links.some((link) => link.from.id === notes!.id || link.to.id === notes!.id)).toBe(false);
    // Bodies alone carry no relation: the only relations come from the package
    // Documents table, which states its iteration owner explicitly.
    expect(plan.links.every((link) => link.from.kind === "iteration" && link.relation === "documents")).toBe(true);
    expect(plan.links.length).toBe(2);
    const notesUnknowns = plan.unknowns.filter((unknown) => unknown.key === `document:${notes!.id}`);
    expect(notesUnknowns.map((unknown) => unknown.code).sort()).toEqual(["identity", "membership"]);
    expect(notesUnknowns.every((unknown) => unknown.detail.length > 0)).toBe(true);
    expect(notes!.idAssigned).toBe(true);
  });
});

describe("catalog import blocking rules", () => {
  test("a conflicting path between two sources blocks the import instead of picking a winner", async () => {
    const fixture = await mixedFixture("conflict-path-");
    write(
      fixture.harness,
      "iterations/README.md",
      ITERATIONS_README.replace("[`iter-alpha/`](iter-alpha/)", "[`iter-alpha-old/`](iter-alpha-old/)"),
    );

    const plan = await discoverCatalog(fixture.context);
    const conflict = plan.conflicts.find((candidate) => candidate.field === "path");
    expect(conflict).toBeDefined();
    expect(conflict!.key).toBe("iteration:iter-alpha");
    expect(conflict!.values.map((value) => value.value).sort()).toEqual(["iterations:iter-alpha", "iterations:iter-alpha-old"]);
    expect(conflict!.values.every((value) => value.sourceKey !== "")).toBe(true);

    await expect(importCatalog(fixture.context, plan, { operationId: "imp-conflict", actor: "project-manager" })).rejects.toMatchObject({
      code: "catalog.import-conflict",
    });
    expect(await catalogRows(fixture.context)).toEqual({ entities: 0, links: 0 });
  });

  test("two explicit ids claiming one location block the import", async () => {
    const fixture = await mixedFixture("conflict-id-");
    write(
      fixture.harness,
      "iterations/README.md",
      md(
        "# Iterations",
        "",
        "| Iteration | Path | Description | Status |",
        "|-----------|------|-------------|--------|",
        "| `iter-alpha` | [`iter-alpha/`](iter-alpha/) | Alpha iteration package | `active` |",
        "| `iter-alpha-two` | [`iter-alpha/`](iter-alpha/) | Same package, second identity | `active` |",
      ),
    );

    const plan = await discoverCatalog(fixture.context);
    const conflict = plan.conflicts.find((candidate) => candidate.field === "id");
    expect(conflict).toBeDefined();
    expect(conflict!.key).toBe("iterations:iter-alpha");
    expect([...new Set(conflict!.values.map((value) => value.value))].sort()).toEqual(["iteration:iter-alpha", "iteration:iter-alpha-two"]);
    expect(conflict!.values.map((value) => value.sourceKey)).toContain("iterations:README.md");

    await expect(importCatalog(fixture.context, plan, { operationId: "imp-conflict-id", actor: "project-manager" })).rejects.toMatchObject({
      code: "catalog.import-conflict",
    });
    expect((await catalogRows(fixture.context)).entities).toBe(0);
  });

  test("source-digest drift blocks the import and writes nothing", async () => {
    const fixture = await freshWorkspace("drift-");
    const bodyPath = write(fixture.harness, "specs/contract.md", md("# Contract", "", "Reviewed body."));
    const inputs: CatalogImportInput[] = [
      {
        rootKind: "specs",
        relativePath: "contract.md",
        mapping: { kind: "document", id: "contract", documentKind: "spec", title: "Contract" },
      },
    ];
    const plan = await planCatalogImport(fixture.context, inputs);
    expect(plan.conflicts).toEqual([]);
    expect(plan.sourceDigests).toHaveLength(1);
    expect(await verifyCatalogImport(fixture.context, plan)).toEqual({ ok: true, conflicts: [], drift: [] });

    writeFileSync(bodyPath, md("# Contract", "", "Edited after review."));
    const verification = await verifyCatalogImport(fixture.context, plan);
    expect(verification.ok).toBe(false);
    expect(verification.drift).toHaveLength(1);
    expect(verification.drift[0]!.state).toBe("changed");

    await expect(importCatalog(fixture.context, plan, { operationId: "imp-drift", actor: "project-manager" })).rejects.toMatchObject({
      code: "catalog.import-source-drift",
    });
    expect((await catalogRows(fixture.context)).entities).toBe(0);

    // A source that disappeared since review is drift too.
    rmSync(bodyPath);
    await expect(importCatalog(fixture.context, plan, { operationId: "imp-drift-2", actor: "project-manager" })).rejects.toMatchObject({
      code: "catalog.import-source-drift",
    });
    expect((await catalogRows(fixture.context)).entities).toBe(0);
  });

  test("refuses an unreviewed plan version and incomplete reviewed inputs", async () => {
    const fixture = await freshWorkspace("invalid-");
    const plan = await planCatalogImport(fixture.context, [
      {
        rootKind: "specs",
        relativePath: "contract.md",
        mapping: { kind: "document", id: "contract", documentKind: "spec", title: "Contract" },
      },
    ]);
    await expect(
      importCatalog(fixture.context, { ...plan, version: 99 }, { operationId: "imp-version", actor: "project-manager" }),
    ).rejects.toMatchObject({ code: "catalog.import-invalid-plan" });
    await expect(
      importCatalog(fixture.context, { ...plan, conflicts: undefined } as unknown as CatalogImportPlan, {
        operationId: "imp-shape",
        actor: "project-manager",
      }),
    ).rejects.toMatchObject({ code: "catalog.import-invalid-plan" });
    await expect(
      planCatalogImport(fixture.context, [{ rootKind: "elsewhere" as never, relativePath: "x.md", mapping: { kind: "document", id: "x" } }]),
    ).rejects.toMatchObject({ code: "catalog.import-invalid-plan" });
    await expect(planCatalogImport(fixture.context, [{ rootKind: "specs", relativePath: "../escape.md", mapping: { kind: "plan", id: "x" } }])).rejects.toMatchObject(
      { code: "catalog.import-invalid-plan" },
    );
    // A body that is not present locally is disclosed, not invented: the plan
    // still proposes the reviewed row, and records it cannot be recovered.
    const missing = await planCatalogImport(fixture.context, [
      { rootKind: "specs", relativePath: "absent.md", mapping: { kind: "document", id: "absent", documentKind: "spec", title: "Absent" } },
    ]);
    expect(missing.sourceDigests).toEqual([]);
    expect(missing.unknowns.map((unknown) => unknown.code)).toContain("source-missing");
  });
});

describe("fresh-clone tracked bodies", () => {
  test("yield proposals whose unknown metadata is disclosed, and import without inventing relations", async () => {
    const fixture = await freshWorkspace("fresh-clone-");
    write(fixture.harness, "knowledge/patterns/guard.md", KNOWLEDGE_BODY);
    write(fixture.harness, "specs/contract.md", md("# Contract", "", "Spec body."));

    const plan = await discoverCatalog(fixture.context);
    expect(plan.conflicts).toEqual([]);
    expect(plan.links).toEqual([]);
    expect(plan.retirementSections).toEqual([]);
    expect(plan.entities.map((proposal) => proposal.relativePath).sort()).toEqual(["contract.md", "patterns/guard.md"]);
    for (const proposal of plan.entities) {
      expect(proposal.idAssigned).toBe(true);
      const codes = plan.unknowns.filter((unknown) => unknown.key === `${proposal.kind}:${proposal.id}`).map((unknown) => unknown.code);
      expect(codes.sort()).toEqual(["identity", "membership"]);
      expect(proposal.sourceHash).toBe(plan.sourceDigests.find((digest) => digest.sourceKey === `${proposal.rootKind}:${proposal.relativePath}`)!.sha256);
    }

    const receipt = await importCatalog(fixture.context, plan, { operationId: "imp-fresh", actor: "project-manager" });
    expect(receipt.entities).toHaveLength(2);
    expect(receipt.links).toEqual([]);
    const page = await listCatalog(fixture.context, { kind: "document" });
    expect(page.total).toBe(2);
    expect(page.links).toEqual([]);
    expect(page.items.every((entity) => entity.sourceHash !== null && entity.present)).toBe(true);
  });
});

describe("catalog export and portability", () => {
  test("export/import preserves ids, relations and provenance without creating an execution session", async () => {
    const source = await freshWorkspace("export-source-");
    write(source.harness, "projects/proj-a/roadmap.md", md("# Project Alpha"));
    write(source.harness, "specs/contract.md", md("# Contract", "", "Spec body."));
    const reviewed: CatalogImportInput[] = [
      { rootKind: "projects", relativePath: "proj-a", mapping: { kind: "project", id: "proj-a", title: "Project Alpha" } },
      {
        rootKind: "specs",
        relativePath: "contract.md",
        mapping: { kind: "document", id: "doc-contract", documentKind: "spec", title: "Contract" },
        links: [{ relation: "belongs-to", to: { kind: "project", id: "proj-a" } }],
      },
    ];
    const planned = await planCatalogImport(source.context, reviewed);
    expect(planned.conflicts).toEqual([]);
    await importCatalog(source.context, planned, { operationId: "imp-source", actor: "project-manager" });

    // Local metadata moved on after registration: the export records the
    // revision, the reimport must not treat it as local authority.
    await registerCatalogEntity(
      source.context,
      { kind: "document", id: "doc-extra", title: "Extra", rootKind: "specs", relativePath: "extra.md", documentKind: "spec" },
      { operationId: "extra", actor: "project-manager" },
    );
    const payload = await exportCatalog(source.context);
    expect(payload.version).toBe(1);
    expect(payload.entities.map((entity) => entity.id).sort()).toEqual(["doc-contract", "doc-extra", "proj-a"]);
    expect(payload.links).toEqual([
      { fromKind: "document", fromId: "doc-contract", relation: "belongs-to", toKind: "project", toId: "proj-a", ordinal: null },
    ]);

    // A second clone holding the same tracked bodies.
    const clone = await freshWorkspace("export-clone-");
    write(clone.harness, "projects/proj-a/roadmap.md", md("# Project Alpha"));
    write(clone.harness, "specs/contract.md", md("# Contract", "", "Spec body."));
    const imported = await planCatalogImport(clone.context, catalogExportToInputs(payload));
    expect(imported.conflicts).toEqual([]);
    expect(imported.entities.map((proposal) => proposal.id).sort()).toEqual(["doc-contract", "doc-extra", "proj-a"]);
    // The exported revision travels as provenance, never as local state.
    expect(catalogExportToInputs(payload).every((input) => input.provenance !== undefined)).toBe(true);

    const receipt = await importCatalog(clone.context, imported, { operationId: "imp-clone", actor: "project-manager" });
    expect(receipt.entities.map((entity) => entity.id).sort()).toEqual(["doc-contract", "doc-extra", "proj-a"]);
    expect(receipt.entities.every((entity) => entity.revision === 1)).toBe(true);
    expect(receipt.links).toEqual([{ fromKind: "document", fromId: "doc-contract", relation: "belongs-to", toKind: "project", toId: "proj-a", ordinal: null }]);
    const detail = await getCatalog(clone.context, { kind: "document", id: "doc-contract" });
    expect(detail.links).toEqual([{ fromKind: "document", fromId: "doc-contract", relation: "belongs-to", toKind: "project", toId: "proj-a", ordinal: null }]);
    // The clone carries the body; the export-only row does not, and says so.
    expect(detail.entity.present).toBe(true);
    expect(imported.unknowns.some((unknown) => unknown.code === "source-missing" && unknown.key === "specs:extra.md")).toBe(true);

    // No workflow session, no execution binding, no root registration.
    const reader = await openStore(clone.context, "read");
    const bindings = reader.db.prepare("select count(*) as n from catalog_execution_bindings").get() as { n: number };
    const workflows = reader.db.prepare("select count(*) as n from catalog_operations where phase <> 'committed'").get() as { n: number };
    reader.close();
    expect(bindings.n).toBe(0);
    expect(workflows.n).toBe(0);
    expect(readdirSync(clone.harness)).not.toContain("workflows");
    expect(readdirSync(clone.harness)).not.toContain("status.json");
  });

  test("a reimport attaches to the row that owns the location and relations follow the effective id", async () => {
    const fixture = await freshWorkspace("attach-");
    write(fixture.harness, "specs/contract.md", md("# Contract", "", "Spec body."));
    write(fixture.harness, "plans/20260918-alpha.md", md("# Alpha plan"));

    const first = await planCatalogImport(fixture.context, [
      { rootKind: "specs", relativePath: "contract.md", mapping: { kind: "document", id: "doc-original", documentKind: "spec", title: "Contract" } },
    ]);
    await importCatalog(fixture.context, first, { operationId: "imp-first", actor: "project-manager" });

    // A second reviewed import assigns its own id at the same canonical
    // location: it attaches, and the relation must target the retained id.
    const second = await planCatalogImport(fixture.context, [
      {
        rootKind: "plans",
        relativePath: "20260918-alpha.md",
        mapping: { kind: "plan", id: "20260918-alpha", title: "Alpha plan" },
        links: [{ relation: "spec-ref", to: { kind: "document", id: "doc-reimported" } }],
      },
      { rootKind: "specs", relativePath: "contract.md", mapping: { kind: "document", id: "doc-reimported", documentKind: "spec", title: "Contract" } },
    ]);
    expect(second.conflicts).toEqual([]);
    const receipt = await importCatalog(fixture.context, second, { operationId: "imp-second", actor: "project-manager" });

    expect(receipt.entities.map((entity) => entity.id).sort()).toEqual(["20260918-alpha", "doc-original"]);
    expect(receipt.links).toEqual([
      { fromKind: "plan", fromId: "20260918-alpha", relation: "spec-ref", toKind: "document", toId: "doc-original", ordinal: null },
    ]);
    expect((await listCatalog(fixture.context, { kind: "document" })).total).toBe(1);
    expect((await getCatalog(fixture.context, { kind: "plan", id: "20260918-alpha" })).links).toEqual([
      { fromKind: "plan", fromId: "20260918-alpha", relation: "spec-ref", toKind: "document", toId: "doc-original", ordinal: null },
    ]);
  });

  test("a reviewed relation whose target is neither planned nor local is reported, not fabricated", async () => {
    const fixture = await freshWorkspace("dangling-");
    write(fixture.harness, "specs/contract.md", md("# Contract"));
    const plan = await planCatalogImport(fixture.context, [
      {
        rootKind: "specs",
        relativePath: "contract.md",
        mapping: { kind: "document", id: "doc-contract", documentKind: "spec", title: "Contract" },
        links: [{ relation: "belongs-to", to: { kind: "project", id: "proj-ghost" } }],
      },
    ]);
    expect(plan.links).toEqual([]);
    expect(plan.unknowns.filter((unknown) => unknown.code === "reference-missing")).toHaveLength(1);
    const receipt = await importCatalog(fixture.context, plan, { operationId: "imp-dangling", actor: "project-manager" });
    expect(receipt.links).toEqual([]);
    expect(receipt.unknowns.some((unknown) => unknown.code === "reference-missing")).toBe(true);
    expect((await listCatalog(fixture.context, {})).total).toBe(1);
  });
});
