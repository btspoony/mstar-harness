import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCatalog, readCatalogStoreVersionsOn, registerCatalogEntity } from "../src/catalog.js";
import { readCatalogCompleteness } from "../src/iteration.js";
import { resolveProcessHarnessDir } from "../src/coordination.js";
import { upgradeStoreMinimal } from "../src/execution-minimal-import.js";
import { readExecutionState } from "../src/execution-store.js";
import { ensureCollaborationAuthority } from "../src/store-activation.js";
import { openCollaborationStore, readCollaborationAuthority, writeCollaborationBinding } from "../src/collaboration-store.js";
import { initializeStore, openStore, upgradeStore, type StoreContext } from "../src/store-db.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function activeWorkspace(): Promise<{ root: string; context: StoreContext; storeId: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mstar-root-selection-")));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(
    join(root, ".mstarc"),
    `[collaboration]\nmode=local\nrepo_id=fixture-${root.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(-110)}\n`,
  );
  const context = { harnessDir: join(root, ".mstar") };
  mkdirSync(context.harnessDir);
  const created = await initializeStore(context);
  created.close();
  await ensureCollaborationAuthority(context);
  mkdirSync(join(context.harnessDir, "plans"));
  writeFileSync(join(context.harnessDir, "plans", "alternative.md"), "# Alternative plan\n");
  await registerCatalogEntity(
    context,
    { kind: "plan", id: "alternative", title: "Alternative plan", rootKind: "plans", relativePath: "alternative.md" },
    { operationId: "register-alternative", actor: "fixture-operator" },
  );
  const authority = await readExecutionState(context);
  return { root, context, storeId: authority.storeId };
}

async function authorityFacts(context: StoreContext) {
  const authority = await readExecutionState(context);
  const catalog = await listCatalog(context);
  const handle = await openStore(context, "read");
  const collaboration = await openCollaborationStore(context, "read");
  try {
    return {
      storeId: authority.storeId,
      epoch: authority.epoch,
      root: authority.data.root,
      workflowIds: authority.data.workflows.map((workflow) => workflow.state.id),
      revisions: readCatalogStoreVersionsOn(collaboration.db),
      catalogRows: catalog.items.map(({ kind, id, title, relativePath, revision }) => ({ kind, id, title, relativePath, revision })),
      catalogTotal: catalog.total,
    };
  } finally {
    handle.close();
    collaboration.close();
  }
}

describe("explicit store-root selection", () => {
  test.each(["missing", "empty"])("a selected %s root refuses without opening an ACTIVE alternative and remains recoverable", async (shape) => {
    const { root, context: alternative, storeId: alternativeId } = await activeWorkspace();
    const selected: StoreContext = { harnessDir: join(root, "absent"), checkoutRoot: root };
    if (shape === "empty") mkdirSync(selected.harnessDir);
    // Same process address and original unavailable target: discovery would
    // find the ACTIVE alternative, but the explicit override selects absent.
    expect(resolveProcessHarnessDir(root)).toBe(alternative.harnessDir);
    expect(resolveProcessHarnessDir(root, selected.harnessDir)).toBe(selected.harnessDir);
    const before = await authorityFacts(alternative);
    expect(before.catalogRows).toEqual([expect.objectContaining({ kind: "plan", id: "alternative" })]);
    for (const mode of ["read", "write"] as const) {
      await expect(openStore(selected, mode)).rejects.toMatchObject({ code: "store.not-initialized" });
    }
    await expect(readExecutionState(selected)).rejects.toMatchObject({ code: "store.not-initialized" });
    await expect(upgradeStore(selected)).rejects.toMatchObject({ code: "store.not-initialized" });
    expect(await authorityFacts(alternative)).toEqual(before);
    expect(existsSync(selected.harnessDir)).toBe(shape === "empty");
    if (shape === "empty") expect(readdirSync(selected.harnessDir)).toEqual([]);

    // The selected checkout shares the repository's collaboration lane but has
    // no binding of its own yet; adopt it before the execution-only recovery.
    writeCollaborationBinding(selected, await readCollaborationAuthority(selected));
    // The supported empty-workspace upgrade creates even a missing selected
    // directory, then initializes/activates that store, not the alternative.
    const recovered = await upgradeStoreMinimal({ context: selected, operator: "fixture-operator", operationId: "recover-selected" });
    expect(recovered).toMatchObject({ verdict: "upgraded", imported: 0, authorityState: "active" });
    const own = await readExecutionState(selected);
    expect(own.storeId).not.toBe(alternativeId);
    expect(await authorityFacts(alternative)).toEqual(before);
  });

  test("store init and catalog discovery keep an explicitly selected root containing its own plans directory", async () => {
    const { root, context: alternative, storeId: alternativeId } = await activeWorkspace();
    const selected: StoreContext = { harnessDir: join(root, "selected"), checkoutRoot: root };
    mkdirSync(join(selected.harnessDir, "plans"), { recursive: true });
    const before = await authorityFacts(alternative);
    const own = await initializeStore(selected);
    try {
      expect(own.storeId).not.toBe(alternativeId);
      expect(existsSync(join(selected.harnessDir, "store.db"))).toBe(true);
      expect(readdirSync(join(selected.harnessDir, "plans"))).toEqual([]);
    } finally {
      own.close();
    }
    // The repository's lane is already ACTIVE through the alternative root and
    // this checkout holds no binding of its own yet; adopt what it resolved.
    writeCollaborationBinding(selected, await readCollaborationAuthority(selected));
    writeFileSync(join(selected.harnessDir, "plans", "selected.md"), "# Selected plan\n\n**plan_id:** selected\n");
    await registerCatalogEntity(
      selected,
      { kind: "plan", id: "selected", title: "Selected plan", rootKind: "plans", relativePath: "selected.md" },
      { operationId: "register-selected", actor: "fixture-operator" },
    );
    const catalog = await readCatalogCompleteness(selected, ["plans"]);
    expect(catalog.ok).toBe(true);
    // Discovery stays bounded to the selected root's own plans directory, while
    // the catalog rows are the repository's SHARED lane, which already holds the
    // alternative root's plan.
    expect(catalog.discovered).toBe(1);
    expect(catalog.registered).toBe(2);
    expect((await listCatalog(selected)).items.map((item) => item.id).sort()).toEqual(["alternative", "selected"]);
    // The alternative keeps its own execution authority; only the shared
    // collaboration lane moved.
    const after = await authorityFacts(alternative);
    expect({ storeId: after.storeId, epoch: after.epoch }).toEqual({ storeId: before.storeId, epoch: before.epoch });
  });
});
