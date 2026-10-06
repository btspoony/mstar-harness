import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCatalogEntity } from "../src/catalog.js";
import { readCatalogCompleteness } from "../src/iteration.js";
import { resolveProcessHarnessDir } from "../src/coordination.js";
import { upgradeStoreMinimal } from "../src/execution-minimal-import.js";
import { initializeExecutionAuthority, readExecutionState } from "../src/execution-store.js";
import { initializeStore, openStore, upgradeStore, type StoreContext } from "../src/store-db.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function activeWorkspace(): Promise<{ root: string; context: StoreContext; storeId: string }> {
  const root = mkdtempSync(join(tmpdir(), "mstar-root-selection-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const context = { harnessDir: join(root, ".mstar") };
  mkdirSync(context.harnessDir);
  const created = await initializeStore(context);
  created.close();
  const authority = await initializeExecutionAuthority(context);
  return { root, context, storeId: authority.storeId };
}

/** Include the database and every journal/lock/artifact byte in the witness. */
function filesAt(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function visit(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const key = prefix + entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), `${key}/`);
      else files[key] = readFileSync(join(dir, entry.name)).toString("base64");
    }
  }
  visit(root, "");
  return files;
}

describe("explicit store-root selection", () => {
  test.each(["missing", "empty"])("a selected %s root refuses without opening an ACTIVE alternative and remains recoverable", async (shape) => {
    const { root, context: alternative, storeId: alternativeId } = await activeWorkspace();
    const selected = { harnessDir: join(root, "absent") };
    if (shape === "empty") mkdirSync(selected.harnessDir);
    // Same process address and original unavailable target: discovery would
    // find the ACTIVE alternative, but the explicit override selects absent.
    expect(resolveProcessHarnessDir(root)).toBe(alternative.harnessDir);
    expect(resolveProcessHarnessDir(root, selected.harnessDir)).toBe(selected.harnessDir);
    const before = filesAt(alternative.harnessDir);
    for (const mode of ["read", "write"] as const) {
      await expect(openStore(selected, mode)).rejects.toMatchObject({ code: "store.not-initialized" });
    }
    await expect(readExecutionState(selected)).rejects.toMatchObject({ code: "store.not-initialized" });
    await expect(upgradeStore(selected)).rejects.toMatchObject({ code: "store.not-initialized" });
    expect(filesAt(alternative.harnessDir)).toEqual(before);
    expect(existsSync(selected.harnessDir)).toBe(shape === "empty");
    if (shape === "empty") expect(readdirSync(selected.harnessDir)).toEqual([]);

    // The supported empty-workspace upgrade creates even a missing selected
    // directory, then initializes/activates that store, not the alternative.
    const recovered = await upgradeStoreMinimal({ context: selected, operator: "fixture-operator", operationId: "recover-selected" });
    expect(recovered).toMatchObject({ verdict: "upgraded", imported: 0, authorityState: "active" });
    const own = await readExecutionState(selected);
    expect(own.storeId).not.toBe(alternativeId);
    expect(filesAt(alternative.harnessDir)).toEqual(before);
  });

  test("store init and catalog discovery keep an explicitly selected root containing its own plans directory", async () => {
    const { root, context: alternative, storeId: alternativeId } = await activeWorkspace();
    const selected = { harnessDir: join(root, "selected") };
    mkdirSync(join(selected.harnessDir, "plans"), { recursive: true });
    const before = filesAt(alternative.harnessDir);
    const own = await initializeStore(selected);
    try {
      expect(own.storeId).not.toBe(alternativeId);
      expect(existsSync(join(selected.harnessDir, "store.db"))).toBe(true);
      expect(readdirSync(join(selected.harnessDir, "plans"))).toEqual([]);
    } finally {
      own.close();
    }
    writeFileSync(join(selected.harnessDir, "plans", "selected.md"), "# Selected plan\n\n**plan_id:** selected\n");
    await registerCatalogEntity(
      selected,
      { kind: "plan", id: "selected", title: "Selected plan", rootKind: "plans", relativePath: "selected.md" },
      { operationId: "register-selected", actor: "fixture-operator" },
    );
    const catalog = await readCatalogCompleteness(selected, ["plans"]);
    expect(catalog.ok).toBe(true);
    expect(catalog.discovered).toBe(1);
    expect(catalog.registered).toBe(1);
    expect(filesAt(alternative.harnessDir)).toEqual(before);
  });
});
