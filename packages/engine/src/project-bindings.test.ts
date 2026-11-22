/**
 * note: project-bindings.test.ts — the project↔provider correspondence over the
 * collaboration lane's `project_bindings` (binding-config plan Task 5).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { registerCatalogEntity, updateCatalogEntity } from "./catalog.js";
import { resolveCollaborationLocation } from "./collaboration-identity.js";
import { initializeCollaborationStore, openCollaborationStore, withCollaborationWrite, writeCollaborationBinding } from "./collaboration-store.js";
import { captureIssue, listIssues } from "./issue.js";
import { addMilestone } from "./milestone-store.js";
import { bindProject, BindingError, readProjectBinding } from "./project.js";
import { initializeStore, openStore, type StoreContext } from "./store-db.js";

const ROOT = mkdtempSync(join(nodeOs.tmpdir(), "tmp-project-bindings-"));
const HOME = join(ROOT, "home");
mkdirSync(HOME);
let homeSpy: { mockRestore(): void } | undefined;

beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});

afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

const TARGET = { provider: "linear", workspace: "acme", team: "eng", remoteProject: "Team Roadmap" };

/** note: A synthetic checkout whose origin names the collaboration repository. */
function checkout(name: string): { root: string; context: StoreContext } {
  const root = mkdtempSync(join(ROOT, name));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/acme/${name.replace(/[^a-z0-9._-]/gi, "-")}.git`], {
    cwd: root,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // note: The live selector lookup is real Git I/O; route the synthetic origin to this fixture's
  // own repository, which never publishes the selector ref.
  execFileSync(
    "git",
    ["config", `url.${root}.insteadOf`, `https://github.com/acme/${name.replace(/[^a-z0-9._-]/gi, "-")}.git`],
    { cwd: root, stdio: ["ignore", "ignore", "ignore"] },
  );
  writeFileSync(join(root, ".mstarc"), "[collaboration]\nmode=local\n");
  const harnessDir = join(root, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  return { root, context: { harnessDir } };
}

/** note: Publish the staged lane and this checkout's binding, as real activation does. */
function activate(context: StoreContext): void {
  const location = resolveCollaborationLocation(context);
  const db = new DatabaseSync(location.dbPath);
  let storeId = "";
  let epoch = 0;
  try {
    db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(new Date().toISOString());
    const row = db.prepare("select store_id, authority_epoch from collaboration_meta where id = 1").get() as
      | { store_id?: unknown; authority_epoch?: unknown }
      | undefined;
    if (typeof row?.store_id === "string") storeId = row.store_id;
    if (typeof row?.authority_epoch === "number") epoch = row.authority_epoch;
  } finally {
    db.close();
  }
  writeCollaborationBinding(context, { repoKey: location.repoKey, mode: location.mode, storeId, epoch, binding: "active" });
}

async function workspace(name: string, projects: string[] = ["proj-a"]): Promise<StoreContext> {
  const { context } = checkout(name);
  (await initializeStore(context)).close();
  await initializeCollaborationStore(resolveCollaborationLocation(context));
  activate(context);
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

async function collaborationRevision(context: StoreContext): Promise<number> {
  const handle = await openCollaborationStore(context, "read");
  try {
    const row = handle.db.prepare("select revision from collaboration_meta where id = 1").get() as { revision: number };
    return row.revision;
  } finally {
    handle.close();
  }
}

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

describe("collaboration governance", () => {
  test("stable keys: a catalog revision move keeps the binding identity and its lane revision", async () => {
    const context = await workspace("governance-stable");
    const beforeBind = await collaborationRevision(context);
    const receipt = await bindProject(context, "proj-a", TARGET, { operationId: nextOperation() });
    const catalogBefore = await readCatalogRevisions(context);

    // why: A catalog metadata edit moves the catalog revision; the correspondence
    // keeps its own id and revision, and the receipt names the lane counter.
    await updateCatalogEntity(context, { kind: "project", id: "proj-a" }, { description: "moved" }, 1, {
      operationId: nextOperation(),
      actor: "test",
    });
    const catalogAfter = await readCatalogRevisions(context);
    expect(catalogAfter.catalogRevision).toBe(catalogBefore.catalogRevision + 1);
    expect(receipt.storeRevision).toBe(beforeBind + 1);

    const read = await readProjectBinding(context, "proj-a");
    expect(read.kind).toBe("bound");
    if (read.kind === "bound") {
      expect(read.binding).toMatchObject({ projectId: "proj-a", revision: 1, remoteProject: "Team Roadmap" });
    }
  });

  test("source absence stays a named absence and is never adopted implicitly", async () => {
    const context = await workspace("governance-absence", ["proj-a", "_default"]);
    expect(await readProjectBinding(context, "_default")).toMatchObject({ kind: "absent", code: "linear.binding-absent" });
    expect(await readProjectBinding(context, "ghost")).toMatchObject({ kind: "absent", code: "linear.binding-absent" });

    await bindProject(context, "proj-a", TARGET, { operationId: nextOperation() });
    // note: Binding one project neither adopts `_default` nor mints a row for a
    // project the catalog does not hold.
    expect(await readProjectBinding(context, "_default")).toMatchObject({ kind: "absent" });
    await expect(bindProject(context, "ghost", TARGET, { operationId: nextOperation() })).rejects.toMatchObject({
      code: "linear.project-unregistered",
    });
    await expect(bindProject(context, "_default", TARGET, { operationId: nextOperation() })).rejects.toMatchObject({
      code: "linear.binding-conflict",
    });
  });

  test("stale lane revisions: the execution store revision is never the collaboration CAS", async () => {
    const context = await workspace("governance-cas", ["proj-a", "proj-b"]);
    const execution = await openStore(context, "read");
    let executionRevision: number;
    try {
      const row = execution.db.prepare("select revision from store_meta where id = 1").get() as { revision: number };
      executionRevision = row.revision;
    } finally {
      execution.close();
    }
    const first = await bindProject(context, "proj-a", TARGET, { operationId: nextOperation() });
    expect(first.storeRevision).not.toBe(executionRevision);

    // note: The execution counter is not a collaboration CAS: carrying it is stale.
    await expect(
      bindProject(context, "proj-b", { ...TARGET, remoteProject: "Second Roadmap" }, { operationId: nextOperation(), expectedStoreRevision: executionRevision }),
    ).rejects.toMatchObject({ code: "linear.revision-conflict" });

    const accepted = await bindProject(context, "proj-b", { ...TARGET, remoteProject: "Second Roadmap" }, {
      operationId: nextOperation(),
      expectedStoreRevision: first.storeRevision,
    });
    expect(accepted.storeRevision).toBe(first.storeRevision + 1);
    // note: The revision the accepted write consumed is stale for the next request.
    await expect(
      bindProject(context, "proj-b", { ...TARGET, remoteProject: "Second Roadmap" }, {
        operationId: nextOperation(),
        expectedStoreRevision: first.storeRevision,
      }),
    ).rejects.toMatchObject({ code: "linear.revision-conflict" });
  });

  test("`_default` keeps its own issue scope and a missing milestone parent is refused", async () => {
    const context = await workspace("governance-default", ["_default", "proj-a"]);
    const captured = await captureIssue(
      context,
      {
        projectId: "_default",
        title: "Fallback scope finding",
        kind: "bug",
        severity: "low",
        impact: "project-less flow records a finding",
        acceptance: "the finding stays in _default",
        sourceIdentity: "governance/default",
        rootCauseKey: "default-scope",
        acceptanceKey: "default-scope-guard",
        occurrenceKey: "default-scope-run-1",
        sourceKind: "test",
        location: "project-bindings.test.ts",
        observedBehavior: "recorded under _default",
        evidence: [],
        discoveredAt: "2026-11-21T00:00:00.000Z",
      },
      { operationId: nextOperation(), actor: "project-manager" },
    );
    expect((await listIssues(context, { projectId: "_default" })).items.map((issue) => issue.id)).toEqual([captured.issueId]);
    expect((await listIssues(context, { projectId: "proj-a" })).items).toEqual([]);

    const milestone = await addMilestone(
      context,
      { projectId: "_default", name: "Fallback milestone", target: null, ordinal: 0 },
      { operationId: nextOperation(), expectedStoreRevision: await collaborationRevision(context) },
    );
    expect(milestone.storeRevision).toBe(captured.storeRevision + 1);

    // invariant: A milestone never adopts a project the catalog does not hold.
    await expect(
      addMilestone(context, { projectId: "missing", name: "Orphan", target: null, ordinal: 0 }, {
        operationId: nextOperation(),
        expectedStoreRevision: milestone.storeRevision,
      }),
    ).rejects.toMatchObject({ code: "milestone.project-not-found" });
    expect(await collaborationRevision(context)).toBe(milestone.storeRevision);
  });
});

/** note: The collaboration-revision pair a catalog edit reports. */
async function readCatalogRevisions(context: StoreContext): Promise<{ storeRevision: number; catalogRevision: number }> {
  return withCollaborationWrite(context, (handle) => {
    const row = handle.db.prepare("select revision, catalog_revision from collaboration_meta where id = 1").get() as {
      revision: number;
      catalog_revision: number;
    };
    return { storeRevision: row.revision, catalogRevision: row.catalog_revision };
  });
}

/** note: Row counts for every issue-bearing collaboration table, through a fresh handle. */
async function snapshotIssueTables(context: StoreContext): Promise<Record<string, number>> {
  const handle = await openCollaborationStore(context, "read");
  try {
    const tables = ["issues", "issue_transitions", "occurrences", "issue_sync_state", "sync_cursor"];
    const out: Record<string, number> = {};
    for (const table of tables) {
      const row = handle.db.prepare(`select count(*) as n from ${table}`).get() as { n: number };
      out[table] = row.n;
    }
    return out;
  } finally {
    handle.close();
  }
}
