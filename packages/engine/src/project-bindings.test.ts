/**
 * project-bindings.test.ts — the project↔provider correspondence over
 * migration 15's `project_bindings` (binding-config plan Task 5).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { registerCatalogEntity } from "./catalog.js";
import { bindProject, BindingError, readProjectBinding } from "./project.js";
import { initializeStore, openStore } from "./store-db.js";
import type { StoreContext } from "./store-db.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-project-bindings-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const TARGET = { provider: "linear", workspace: "acme", team: "eng", remoteProject: "Team Roadmap" };

async function workspace(name: string, projects: string[] = ["proj-a"]): Promise<StoreContext> {
  const harnessDir = join(mkdtempSync(join(ROOT, name)), ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const context: StoreContext = { harnessDir };
  (await initializeStore(context)).close();
  for (const id of projects) {
    await registerCatalogEntity(
      context,
      { kind: "project", id, title: `Project ${id}`, rootKind: "projects", relativePath: `projects/${id}` },
      { operationId: `register-${id}`, actor: "test" },
    );
  }
  return context;
}

let counter = 0;
const nextOperation = (): string => `bind-op-${++counter}`;

describe("bindProject / readProjectBinding", () => {
  test("bind then read returns the recorded correspondence", async () => {
    const context = await workspace("bound");
    const receipt = await bindProject(context, "proj-a", TARGET, { operationId: nextOperation() });
    expect(receipt).toMatchObject({ projectId: "proj-a", provider: "linear", remoteProject: "Team Roadmap", revision: 1, changed: true });

    const read = await readProjectBinding(context, "proj-a");
    expect(read.kind).toBe("bound");
    if (read.kind === "bound") {
      expect(read.binding).toMatchObject({ projectId: "proj-a", provider: "linear", workspace: "acme", team: "eng", remoteProject: "Team Roadmap" });
    }
  });

  test("an unbound project answers the NAMED absence, not a silent null", async () => {
    const context = await workspace("absent");
    const read = await readProjectBinding(context, "proj-a");
    expect(read).toMatchObject({ kind: "absent", code: "linear.binding-absent" });
    if (read.kind === "absent") expect(read.message).toContain("mstar project bind --project proj-a");
  });

  test("re-binding the identical pair is a no-op success, never a refusal", async () => {
    const context = await workspace("rebind-same");
    const first = await bindProject(context, "proj-a", TARGET, { operationId: nextOperation() });
    const second = await bindProject(context, "proj-a", TARGET, { operationId: nextOperation() });
    expect(second.changed).toBe(false);
    expect(second.revision).toBe(first.revision);
    expect(second.storeRevision).toBe(first.storeRevision);
  });

  test("a retried operationId replays the receipt instead of double-writing", async () => {
    const context = await workspace("replay");
    const operationId = nextOperation();
    const first = await bindProject(context, "proj-a", TARGET, { operationId });
    const replay = await bindProject(context, "proj-a", TARGET, { operationId });
    expect(replay).toEqual(first);
    const mismatched = bindProject(context, "proj-a", { ...TARGET, remoteProject: "Other" }, { operationId });
    await expect(mismatched).rejects.toThrow(/\[store\.operation-conflict\]/);
  });

  test("re-binding a project to a DIFFERENT remote project is refused by name", async () => {
    const context = await workspace("rebind-different");
    await bindProject(context, "proj-a", TARGET, { operationId: nextOperation() });
    const refusal = bindProject(context, "proj-a", { ...TARGET, remoteProject: "Another Roadmap" }, { operationId: nextOperation() });
    await expect(refusal).rejects.toThrow(/\[linear\.rebind-refused\] Project proj-a already mirrors linear project Team Roadmap/);
    const read = await readProjectBinding(context, "proj-a");
    expect(read.kind === "bound" ? read.binding.remoteProject : null).toBe("Team Roadmap");
  });

  test("binding an unregistered project is refused by name", async () => {
    const context = await workspace("unregistered", []);
    const refusal = bindProject(context, "ghost", TARGET, { operationId: nextOperation() });
    await expect(refusal).rejects.toThrow(/\[linear\.project-unregistered\] Project ghost is not registered in the catalog/);
    await expect(refusal).rejects.toBeInstanceOf(BindingError);
  });

  test("one external project can back only one store project", async () => {
    const context = await workspace("remote-taken", ["proj-a", "proj-b"]);
    await bindProject(context, "proj-a", TARGET, { operationId: nextOperation() });
    const refusal = bindProject(context, "proj-b", TARGET, { operationId: nextOperation() });
    await expect(refusal).rejects.toThrow(/\[linear\.binding-conflict\] linear project Team Roadmap in workspace acme already backs store project proj-a/);
  });

  test("the verb writes only the binding row and never touches issue rows", async () => {
    const context = await workspace("issue-untouched");
    const before = await snapshotIssueTables(context);
    await bindProject(context, "proj-a", TARGET, { operationId: nextOperation() });
    expect(await snapshotIssueTables(context)).toEqual(before);
  });
});

/** Row counts for every issue-bearing table, read through a fresh handle. */
async function snapshotIssueTables(context: StoreContext): Promise<Record<string, number>> {
  const handle = await openStore(context, "read");
  try {
    const tables = ["issues", "issue_transitions", "issue_occurrences", "issue_sync_state", "sync_cursor"];
    const out: Record<string, number> = {};
    for (const table of tables) {
      const exists = handle.db.prepare("select name from sqlite_master where type='table' and name=?").get(table);
      if (exists === undefined) continue;
      out[table] = (handle.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
    }
    return out;
  } finally {
    handle.close();
  }
}
