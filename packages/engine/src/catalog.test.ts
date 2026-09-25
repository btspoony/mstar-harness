/**
 * catalog.test.ts — proof for the catalog authority. Run with
 * `bun test packages/engine/src/catalog.test.ts`.
 *
 * The suite runs against the real catalog module, the real migration runner
 * and the real `node:sqlite` driver in per-test temporary harness roots. No
 * mock database exists anywhere in this proof.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  catalogRootDir,
  getCatalog,
  linkCatalogEntities,
  listCatalog,
  registerCatalogEntity,
  updateCatalogEntity,
  type CatalogEntityInput,
  type CatalogOperation,
} from "./catalog.js";
import {
  MIGRATION_2_SQL,
  MIGRATIONS,
  initializeStore,
  migrationChecksum,
  openStore,
  upgradeStore,
  type StoreContext,
} from "./store-db.js";
import { getCatalog as getCatalogFromIndex } from "./index.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-catalog-test-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * A fresh temp workspace with a real `.mstar` harness root and an initialized
 * (active) store. The `.mstar` marker matters: `resolveHarnessDir` probes a
 * `plans/` child as a harness candidate, so a fixture that creates
 * `{HARNESS_DIR}/plans` must sit under an explicit harness marker — exactly
 * like a real workspace — or the store and catalog roots would move mid-test.
 */
async function initialized(name: string): Promise<StoreContext> {
  const workspace = mkdtempSync(join(ROOT, name));
  mkdirSync(join(workspace, ".mstar"), { recursive: true });
  const context: StoreContext = { harnessDir: workspace };
  const handle = await initializeStore(context);
  handle.close();
  return context;
}

function op(operationId: string, extra: Partial<CatalogOperation> = {}): CatalogOperation {
  return { operationId, actor: "project-manager", ...extra };
}

function doc(id: string, overrides: Partial<CatalogEntityInput> = {}): CatalogEntityInput {
  return {
    kind: "document",
    id,
    title: `Document ${id}`,
    rootKind: "specs",
    relativePath: `${id}.md`,
    documentKind: "spec",
    ...overrides,
  };
}

function plan(id: string, relativePath: string, title = `Plan ${id}`): CatalogEntityInput {
  return { kind: "plan", id, title, rootKind: "plans", relativePath };
}

describe("catalog registration identity", () => {
  test("the composite (kind,id) stays stable across updates and identical replays are no-ops", async () => {
    const context = await initialized("identity-");
    const created = await registerCatalogEntity(context, doc("doc-1"), op("reg-1"));
    expect(created).toEqual({ kind: "document", id: "doc-1", revision: 1, storeRevision: 1 });

    const updated = await updateCatalogEntity(context, { kind: "document", id: "doc-1" }, { title: "Renamed" }, 1, op("upd-1"));
    expect(updated).toEqual({ kind: "document", id: "doc-1", revision: 2, storeRevision: 2 });

    const detail = await getCatalogFromIndex(context, { kind: "document", id: "doc-1" });
    expect(detail.entity.id).toBe("doc-1");
    expect(detail.entity.title).toBe("Renamed");
    expect(detail.entity.revision).toBe(2);
    expect(detail.entity.lifecycle).toBe("active");

    // Exact replay of the same operation returns the original receipt …
    expect(await registerCatalogEntity(context, doc("doc-1"), op("reg-1"))).toEqual(created);
    // … and a fresh operation for the same identity+location is a no-op, not
    // a second row and not another revision.
    expect(await registerCatalogEntity(context, doc("doc-1"), op("reg-2"))).toEqual({
      kind: "document",
      id: "doc-1",
      revision: 2,
      storeRevision: 2,
    });
    expect((await listCatalog(context, { kind: "document" })).total).toBe(1);
  });

  test("reusing an operationId with a different request refuses store.operation-conflict", async () => {
    const context = await initialized("operation-conflict-");
    await registerCatalogEntity(context, doc("doc-1"), op("op-shared"));
    await expect(registerCatalogEntity(context, doc("doc-2"), op("op-shared"))).rejects.toMatchObject({
      code: "store.operation-conflict",
    });
    expect((await listCatalog(context, { kind: "document" })).total).toBe(1);
  });

  test("an existing id at a different location refuses catalog.duplicate instead of relocating", async () => {
    const context = await initialized("duplicate-id-");
    await registerCatalogEntity(context, doc("doc-1"), op("dup-1"));
    await expect(
      registerCatalogEntity(context, doc("doc-1", { relativePath: "elsewhere.md" }), op("dup-2")),
    ).rejects.toMatchObject({ code: "catalog.duplicate" });
    expect((await getCatalog(context, { kind: "document", id: "doc-1" })).entity.relativePath).toBe("doc-1.md");
  });

  test("a replayed import of the same canonical path attaches to the existing row", async () => {
    const context = await initialized("attach-");
    const first = await registerCatalogEntity(context, doc("doc-original"), op("import-1"));
    // A later reviewed import assigns its own id for the same canonical
    // location: the catalog attaches to the existing row, never a duplicate.
    const attached = await registerCatalogEntity(
      context,
      doc("doc-reimported", { relativePath: "doc-original.md" }),
      op("import-2"),
    );
    expect(attached.id).toBe(first.id);
    expect(attached.revision).toBe(1);
    // Same path in a different spelling normalizes to the same stored form.
    const respelled = await registerCatalogEntity(
      context,
      doc("doc-respelled", { relativePath: "./doc-original.md" }),
      op("import-3"),
    );
    expect(respelled.id).toBe(first.id);
    const page = await listCatalog(context, { kind: "document" });
    expect(page.total).toBe(1);
    expect(page.items.map((item) => item.id)).toEqual(["doc-original"]);
  });

  test("a staged store refuses catalog mutations while catalog reads still work", async () => {
    const context = await initialized("staged-");
    await registerCatalogEntity(context, doc("doc-1"), op("staged-1"));
    const handle = await openStore(context, "write");
    handle.db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
    handle.close();
    await expect(registerCatalogEntity(context, doc("doc-2"), op("staged-2"))).rejects.toMatchObject({
      code: "store.not-active",
    });
    await expect(
      updateCatalogEntity(context, { kind: "document", id: "doc-1" }, { title: "x" }, 1, op("staged-3")),
    ).rejects.toMatchObject({ code: "store.not-active" });
    expect((await listCatalog(context, { kind: "document" })).total).toBe(1);
  });

  test("unknown vocabulary and invalid identity are refused without storing", async () => {
    const context = await initialized("invalid-");
    await expect(
      registerCatalogEntity(context, doc("doc-1", { kind: "workflow" as never }), op("bad-1")),
    ).rejects.toMatchObject({ code: "catalog.invalid-entity" });
    await expect(registerCatalogEntity(context, doc("doc-2", { documentKind: null }), op("bad-2"))).rejects.toMatchObject({
      code: "catalog.invalid-entity",
    });
    await expect(
      registerCatalogEntity(context, { ...plan("plan-1", "plan-1.md", "P"), documentKind: "spec" }, op("bad-3")),
    ).rejects.toMatchObject({ code: "catalog.invalid-entity" });
    await expect(
      registerCatalogEntity(context, doc("doc-3", { documentKind: "spec", title: "   " }), op("bad-4")),
    ).rejects.toMatchObject({ code: "catalog.invalid-entity" });
    await expect(registerCatalogEntity(context, doc("../escape"), op("bad-5"))).rejects.toMatchObject({
      code: "catalog.invalid-entity",
    });
    await expect(
      registerCatalogEntity(context, doc("doc-4", { lifecycle: "obsolete" as never }), op("bad-6")),
    ).rejects.toMatchObject({ code: "catalog.invalid-entity" });
    expect((await listCatalog(context, {})).total).toBe(0);
  });
});

describe("catalog revision conflicts", () => {
  test("a stale, absent or unknown-key update rolls back with nothing changed", async () => {
    const context = await initialized("revision-conflict-");
    await registerCatalogEntity(context, doc("doc-1"), op("rev-1"));
    const before = await getCatalog(context, { kind: "document", id: "doc-1" });

    await expect(
      updateCatalogEntity(context, { kind: "document", id: "doc-1" }, { title: "Nope" }, 99, op("rev-2")),
    ).rejects.toMatchObject({ code: "catalog.revision-conflict" });
    await expect(
      updateCatalogEntity(context, { kind: "document", id: "doc-1" }, { title: "Nope" }, undefined as never, op("rev-3")),
    ).rejects.toMatchObject({ code: "catalog.revision-conflict" });
    await expect(
      updateCatalogEntity(context, { kind: "document", id: "doc-ghost" }, { title: "x" }, 1, op("rev-4")),
    ).rejects.toMatchObject({ code: "catalog.not-found" });

    const after = await getCatalog(context, { kind: "document", id: "doc-1" });
    expect(after.entity).toEqual(before.entity);
    expect(after.links).toEqual(before.links);
    expect(after.storeRevision).toBe(before.storeRevision);

    const reader = await openStore(context, "read");
    const journaled = reader.db
      .prepare("select count(*) as n from catalog_operations where operation_id in ('rev-2','rev-3','rev-4')")
      .get() as { n: number };
    const meta = reader.db.prepare("select revision, catalog_revision from store_meta where id = 1").get() as {
      revision: number;
      catalog_revision: number;
    };
    reader.close();
    expect(journaled.n).toBe(0);
    expect(meta).toEqual({ revision: 1, catalog_revision: 1 });
  });

  test("catalog_revision advances only for published catalog mutations", async () => {
    const context = await initialized("catalog-revision-");
    await registerCatalogEntity(context, doc("doc-1"), op("cr-1"));
    await updateCatalogEntity(context, { kind: "document", id: "doc-1" }, { title: "T2" }, 1, op("cr-2"));
    await registerCatalogEntity(context, doc("doc-1"), op("cr-3")); // counted no-op
    await expect(
      updateCatalogEntity(context, { kind: "document", id: "doc-1" }, { title: "T3" }, 1, op("cr-4")),
    ).rejects.toMatchObject({ code: "catalog.revision-conflict" });

    const reader = await openStore(context, "read");
    const meta = reader.db.prepare("select revision, catalog_revision from store_meta where id = 1").get() as {
      revision: number;
      catalog_revision: number;
    };
    const issued = reader.db.prepare("select count(*) as n from catalog_operations").get() as { n: number };
    reader.close();
    expect(meta).toEqual({ revision: 2, catalog_revision: 2 });
    expect(issued.n).toBe(3);
  });
});

describe("catalog relation integrity", () => {
  test("allowed pairs store and read back; ill-typed, dangling and self relations are refused", async () => {
    const context = await initialized("links-");
    await registerCatalogEntity(
      context,
      { kind: "project", id: "proj-a", title: "Alpha", rootKind: "projects", relativePath: "proj-a" },
      op("lnk-1"),
    );
    await registerCatalogEntity(context, plan("plan-a", "plan-a.md"), op("lnk-2"));
    await registerCatalogEntity(context, doc("doc-spec"), op("lnk-3"));

    const membership = await linkCatalogEntities(
      context,
      { from: { kind: "plan", id: "plan-a" }, relation: "belongs-to", to: { kind: "project", id: "proj-a" } },
      op("lnk-4"),
    );
    expect(membership).toEqual({ kind: "plan", id: "plan-a", revision: 2, storeRevision: 4 });
    const specRef = await linkCatalogEntities(
      context,
      { from: { kind: "plan", id: "plan-a" }, relation: "spec-ref", to: { kind: "document", id: "doc-spec" }, ordinal: 1 },
      op("lnk-5"),
    );
    expect(specRef.revision).toBe(3);
    // Identical replay is idempotent — no third revision, no second row.
    expect(
      await linkCatalogEntities(
        context,
        { from: { kind: "plan", id: "plan-a" }, relation: "spec-ref", to: { kind: "document", id: "doc-spec" }, ordinal: 1 },
        op("lnk-6"),
      ),
    ).toEqual({ kind: "plan", id: "plan-a", revision: 3, storeRevision: 5 });

    expect((await getCatalog(context, { kind: "plan", id: "plan-a" })).links).toEqual([
      { fromKind: "plan", fromId: "plan-a", relation: "belongs-to", toKind: "project", toId: "proj-a", ordinal: null },
      { fromKind: "plan", fromId: "plan-a", relation: "spec-ref", toKind: "document", toId: "doc-spec", ordinal: 1 },
    ]);

    // Wrong direction, unknown relation, self supersession, dangling target,
    // and a supplied-but-stale expectedRevision all refuse.
    await expect(
      linkCatalogEntities(
        context,
        { from: { kind: "project", id: "proj-a" }, relation: "belongs-to", to: { kind: "plan", id: "plan-a" } },
        op("bad-link-1"),
      ),
    ).rejects.toMatchObject({ code: "catalog.link-refused" });
    await expect(
      linkCatalogEntities(
        context,
        { from: { kind: "plan", id: "plan-a" }, relation: "blocks" as never, to: { kind: "document", id: "doc-spec" } },
        op("bad-link-2"),
      ),
    ).rejects.toMatchObject({ code: "catalog.link-refused" });
    await expect(
      linkCatalogEntities(
        context,
        { from: { kind: "document", id: "doc-spec" }, relation: "supersedes", to: { kind: "document", id: "doc-spec" } },
        op("bad-link-3"),
      ),
    ).rejects.toMatchObject({ code: "catalog.link-refused" });
    await expect(
      linkCatalogEntities(
        context,
        { from: { kind: "plan", id: "plan-a" }, relation: "spec-ref", to: { kind: "document", id: "doc-ghost" } },
        op("bad-link-4"),
      ),
    ).rejects.toMatchObject({ code: "catalog.link-refused" });
    await expect(
      linkCatalogEntities(
        context,
        { from: { kind: "plan", id: "plan-a" }, relation: "documents", to: { kind: "plan", id: "plan-a" } },
        op("bad-link-5"),
      ),
    ).rejects.toMatchObject({ code: "catalog.link-refused" });
    await expect(
      linkCatalogEntities(
        context,
        { from: { kind: "plan", id: "plan-a" }, relation: "spec-ref", to: { kind: "document", id: "doc-spec" }, ordinal: 9 },
        op("bad-link-6", { expectedRevision: 1 }),
      ),
    ).rejects.toMatchObject({ code: "catalog.revision-conflict" });

    const detail = await getCatalog(context, { kind: "plan", id: "plan-a" });
    expect(detail.links).toHaveLength(2);
    expect(detail.entity.revision).toBe(3);
    expect((await getCatalog(context, { kind: "document", id: "doc-spec" })).links).toHaveLength(1);
  });

  test("the schema's own FKs and pair check refuse a raw dangling or ill-typed link", async () => {
    const context = await initialized("link-schema-");
    await registerCatalogEntity(context, plan("plan-a", "plan-a.md"), op("raw-1"));
    await registerCatalogEntity(
      context,
      { kind: "project", id: "proj-a", title: "Alpha", rootKind: "projects", relativePath: "proj-a" },
      op("raw-2"),
    );
    const handle = await openStore(context, "write");
    expect(() =>
      handle.db
        .prepare(
          "insert into catalog_links(from_kind, from_id, relation, to_kind, to_id, ordinal) " +
            "values ('plan','plan-a','spec-ref','document','doc-ghost',null)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    expect(() =>
      handle.db
        .prepare(
          "insert into catalog_links(from_kind, from_id, relation, to_kind, to_id, ordinal) " +
            "values ('project','proj-a','belongs-to','plan','plan-a',null)",
        )
        .run(),
    ).toThrow(/CHECK/i);
    handle.close();
  });
});

describe("catalog path authority", () => {
  test("root, path and symlink escapes are refused without storing", async () => {
    const context = await initialized("path-escape-");
    const specsRoot = catalogRootDir(context, "specs");
    mkdirSync(specsRoot, { recursive: true });
    const outside = mkdtempSync(join(ROOT, "outside-"));
    writeFileSync(join(outside, "secret.md"), "not a spec");
    mkdirSync(join(outside, "dir"), { recursive: true });
    writeFileSync(join(outside, "dir", "secret.md"), "not a spec");
    symlinkSync(join(outside, "secret.md"), join(specsRoot, "escape.md"));
    symlinkSync(join(outside, "dir"), join(specsRoot, "escape-dir"));
    symlinkSync(join(outside, "gone.md"), join(specsRoot, "dangling.md"));

    const cases: Array<[string, Partial<CatalogEntityInput>]> = [
      ["unknown-root", { rootKind: "elsewhere" as never }],
      ["absolute", { relativePath: "/etc/passwd" }],
      ["traversal", { relativePath: "../escape.md" }],
      ["windows-traversal", { relativePath: "..\\escape.md" }],
      ["nul", { relativePath: "a\0b.md" }],
      ["root-itself", { relativePath: "." }],
      ["symlinked-file", { relativePath: "escape.md" }],
      ["symlinked-dir", { relativePath: "escape-dir/secret.md" }],
      ["dangling-symlink", { relativePath: "dangling.md" }],
    ];
    for (const [name, overrides] of cases) {
      await expect(
        registerCatalogEntity(context, doc(`doc-${name}`, overrides), op(`path-${name}`)),
      ).rejects.toMatchObject({ code: "catalog.path-refused" });
    }
    expect((await listCatalog(context, {})).total).toBe(0);
  });

  test("a stored location that is missing still reads, with an explicit disclosure", async () => {
    const context = await initialized("missing-location-");
    const specsRoot = catalogRootDir(context, "specs");
    mkdirSync(specsRoot, { recursive: true });
    writeFileSync(join(specsRoot, "present.md"), "body");

    const present = await registerCatalogEntity(context, doc("doc-present", { relativePath: "present.md" }), op("loc-1"));
    const absent = await registerCatalogEntity(context, doc("doc-absent", { relativePath: "absent.md" }), op("loc-2"));

    const presentDetail = await getCatalog(context, { kind: "document", id: present.id });
    expect(presentDetail.entity.present).toBe(true);
    expect(presentDetail.entity.absolutePath).toBe(join(specsRoot, "present.md"));
    const absentDetail = await getCatalog(context, { kind: "document", id: absent.id });
    expect(absentDetail.entity.present).toBe(false);
    expect(absentDetail.entity.absolutePath).toBe(join(specsRoot, "absent.md"));
    expect((await listCatalog(context, { kind: "document" })).total).toBe(2);
  });
});

describe("catalog lifecycle", () => {
  test("archived and superseded stay distinct, preserved and filterable", async () => {
    const context = await initialized("lifecycle-");
    await registerCatalogEntity(context, doc("doc-old"), op("lc-1"));
    await registerCatalogEntity(context, doc("doc-new"), op("lc-2"));
    await registerCatalogEntity(context, doc("doc-parked", { description: "parked" }), op("lc-3"));
    await linkCatalogEntities(
      context,
      { from: { kind: "document", id: "doc-new" }, relation: "supersedes", to: { kind: "document", id: "doc-old" } },
      op("lc-4"),
    );
    expect((await updateCatalogEntity(context, { kind: "document", id: "doc-old" }, { lifecycle: "superseded" }, 1, op("lc-5"))).revision).toBe(2);
    expect(
      (await updateCatalogEntity(context, { kind: "document", id: "doc-parked" }, { lifecycle: "archived", description: "  " }, 1, op("lc-6"))).revision,
    ).toBe(2);

    const superseded = await getCatalog(context, { kind: "document", id: "doc-old" });
    expect(superseded.entity.lifecycle).toBe("superseded");
    expect(superseded.links).toContainEqual({
      fromKind: "document",
      fromId: "doc-new",
      relation: "supersedes",
      toKind: "document",
      toId: "doc-old",
      ordinal: null,
    });
    const archived = await getCatalog(context, { kind: "document", id: "doc-parked" });
    expect(archived.entity.lifecycle).toBe("archived");
    expect(archived.entity.description).toBeNull(); // blank description is stored as absent
    expect(archived.links).toEqual([]); // archived is a lifecycle, not a relation

    // Retention: nothing is deleted, and the lifecycle filter separates them.
    expect((await listCatalog(context, { kind: "document" })).total).toBe(3);
    expect((await listCatalog(context, { kind: "document", lifecycle: "archived" })).items.map((i) => i.id)).toEqual([
      "doc-parked",
    ]);
    expect((await listCatalog(context, { kind: "document", lifecycle: "superseded" })).items.map((i) => i.id)).toEqual([
      "doc-old",
    ]);
    expect((await listCatalog(context, { kind: "document", lifecycle: "active" })).items.map((i) => i.id)).toEqual([
      "doc-new",
    ]);
  });
});

describe("catalog queries", () => {
  test("project and iteration membership come from belongs-to links, never a directory scan", async () => {
    const context = await initialized("membership-");
    const plansRoot = catalogRootDir(context, "plans");
    await registerCatalogEntity(
      context,
      { kind: "project", id: "proj-a", title: "Alpha", rootKind: "projects", relativePath: "proj-a" },
      op("mb-1"),
    );
    await registerCatalogEntity(
      context,
      { kind: "iteration", id: "iter-a", title: "Iter A", rootKind: "iterations", relativePath: "iter-a" },
      op("mb-2"),
    );
    await registerCatalogEntity(context, plan("plan-linked", "proj-a/plan-linked.md"), op("mb-3"));
    await registerCatalogEntity(context, plan("plan-decoy", "proj-a/plan-decoy.md"), op("mb-4"));
    await registerCatalogEntity(context, plan("plan-unrelated", "plan-unrelated.md"), op("mb-5"));
    // A directory scan would call every plan under `plans/proj-a/` a member;
    // this decoy directory exists on disk.
    mkdirSync(join(plansRoot, "proj-a"), { recursive: true });
    writeFileSync(join(plansRoot, "proj-a", "plan-decoy.md"), "decoy");
    await linkCatalogEntities(
      context,
      { from: { kind: "plan", id: "plan-linked" }, relation: "belongs-to", to: { kind: "project", id: "proj-a" } },
      op("mb-6"),
    );
    await linkCatalogEntities(
      context,
      { from: { kind: "plan", id: "plan-linked" }, relation: "belongs-to", to: { kind: "iteration", id: "iter-a" } },
      op("mb-7"),
    );

    const byProject = await listCatalog(context, { projectId: "proj-a" });
    expect(byProject.items.map((item) => item.id)).toEqual(["plan-linked"]);
    expect(byProject.total).toBe(1);
    expect(byProject.links).toContainEqual({
      fromKind: "plan",
      fromId: "plan-linked",
      relation: "belongs-to",
      toKind: "project",
      toId: "proj-a",
      ordinal: null,
    });
    expect((await listCatalog(context, { iterationId: "iter-a" })).items.map((item) => item.id)).toEqual(["plan-linked"]);
    expect((await listCatalog(context, { projectId: "proj-ghost" })).total).toBe(0);
    expect((await listCatalog(context, { kind: "plan" })).total).toBe(3);
  });

  test("queries page deterministically, bound the limit, and refuse an unknown key or filter", async () => {
    const context = await initialized("paging-");
    for (const id of ["doc-c", "doc-a", "doc-b"]) {
      await registerCatalogEntity(context, doc(id, { title: id }), op(`page-${id}`));
    }
    const page = await listCatalog(context, {});
    expect(page.total).toBe(3);
    expect(page.items.map((item) => item.id)).toEqual(["doc-a", "doc-b", "doc-c"]);
    expect((await listCatalog(context, { limit: 2, offset: 0 })).items.map((item) => item.id)).toEqual(["doc-a", "doc-b"]);
    expect((await listCatalog(context, { limit: 2, offset: 2 })).items.map((item) => item.id)).toEqual(["doc-c"]);

    await expect(listCatalog(context, { limit: 0 })).rejects.toMatchObject({ code: "catalog.invalid-filter" });
    await expect(listCatalog(context, { limit: 201 })).rejects.toMatchObject({ code: "catalog.invalid-filter" });
    await expect(listCatalog(context, { offset: -1 })).rejects.toMatchObject({ code: "catalog.invalid-filter" });
    await expect(listCatalog(context, { lifecycle: "gone" as never })).rejects.toMatchObject({
      code: "catalog.invalid-filter",
    });
    await expect(listCatalog(context, { kind: "workflow" as never })).rejects.toMatchObject({
      code: "catalog.invalid-filter",
    });
    await expect(getCatalog(context, { kind: "document", id: "doc-ghost" })).rejects.toMatchObject({
      code: "catalog.not-found",
    });
    expect((await getCatalog(context, { kind: "document", id: "doc-a" })).entity.id).toBe("doc-a");
  });
});

describe("migration 2", () => {
  test("installs the catalog/registration tables through the ordered checksum-verified runner", async () => {
    const context = await initialized("migration-");
    const handle = await openStore(context, "read");
    const tables = handle.db
      .prepare("select name from sqlite_master where type='table' and name like 'catalog_%' order by name")
      .all() as Array<{ name: string }>;
    const applied = handle.db.prepare("select version, name, checksum from schema_version order by version").all() as Array<{
      version: number;
      name: string;
      checksum: string;
    }>;
    handle.close();

    expect(tables.map((table) => table.name)).toEqual([
      "catalog_entities",
      "catalog_execution_bindings",
      "catalog_links",
      "catalog_operations",
    ]);
    // The applied set is exactly the compiled set: order, names and checksums.
    expect(applied).toEqual(
      MIGRATIONS.map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: migrationChecksum(migration),
      })),
    );
    expect(applied[0]?.name).toBe("issue-core");
    expect(applied.some((row) => row.name === "catalog-authority")).toBe(true);
    const catalogMigration = MIGRATIONS.find((migration) => migration.version === 2);
    expect(catalogMigration).toMatchObject({ version: 2, name: "catalog-authority" });
    // Nullable actual, computed expected (same shape as the `applied[0]?.name`
    // assertion above): fails when the v2 row is missing or the checksum drifts.
    expect(applied.find((row) => row.version === 2)?.checksum).toBe(
      migrationChecksum({ version: 2, name: "catalog-authority", sql: MIGRATION_2_SQL }),
    );
  });

  test("upgradeStore appends every pending migration to a store that still holds only migration 1", async () => {
    const context = await initialized("migration-append-");
    const handle = await openStore(context, "write");
    // Downgrade to a v1-only store before the upgrade under test. The dropped
    // table set and version rows are derived from the compiled MIGRATIONS, so
    // this stays a v1 store when a migration is appended instead of needing a
    // new literal table name (and a new version row delete) each time.
    const createdAfterV1 = MIGRATIONS.filter((migration) => migration.version > 1)
      .flatMap((migration) =>
        [...migration.sql.matchAll(/create table ([a-z_][a-z0-9_]*)\s*\(/g)].map((match) => match[1]),
      )
      .reverse(); // dependents before the tables they reference (foreign_keys=ON)
    for (const table of createdAfterV1) handle.db.exec(`drop table ${table}`);
    handle.db.prepare("delete from schema_version where version > 1").run();
    handle.close();
    expect((await openStore(context, "read")).schemaVersion).toBe(1);

    // The upgrade replays every pending migration and settles on the compiled
    // migration count — never a hardcoded migration number.
    expect((await upgradeStore(context)).schemaVersion).toBe(MIGRATIONS.length);
    await registerCatalogEntity(context, doc("doc-1"), op("upgrade-1"));
    expect((await listCatalog(context, { kind: "document" })).total).toBe(1);
  });

  test("the catalog schema itself enforces document-kind and self-edge rules", async () => {
    const context = await initialized("schema-invariants-");
    const handle = await openStore(context, "write");
    const insertEntity = (kind: string, id: string, documentKind: string | null) =>
      handle.db
        .prepare(
          "insert into catalog_entities(kind, id, title, root_kind, relative_path, document_kind, lifecycle, revision, registered_at, updated_at) " +
            "values (?, ?, 't', 'plans', ?, ?, 'active', 1, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')",
        )
        .run(kind, id, `${kind}-${id}`, documentKind);
    insertEntity("plan", "plan-raw", null);
    expect(() => insertEntity("plan", "plan-bad", "spec")).toThrow(/CHECK/i);
    expect(() => insertEntity("document", "doc-raw", "spec")).not.toThrow();
    expect(() =>
      handle.db
        .prepare(
          "insert into catalog_links(from_kind,from_id,relation,to_kind,to_id,ordinal) " +
            "values ('document','doc-raw','supersedes','document','doc-raw',null)",
        )
        .run(),
    ).toThrow(/CHECK/i);
    handle.close();
  });
});
