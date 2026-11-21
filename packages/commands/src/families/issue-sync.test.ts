/**
 * note: issue-sync.test.ts — the three local verbs of the Linear mirror: pending, apply,
 * ingest. mstar makes no Linear call, so nothing here is faked except the
 * filesystem and stdin: the fixture plays the agent that holds the host's tools,
 * and every assertion reads the store's real ledger.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodeOs from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  initializeCollaborationStore,
  openCollaborationStore,
  readItem,
  readRun,
  resolveCollaborationLocation,
  withCollaborationWrite,
  PUSH_DIRECTION,
  type ProviderItem,
  type StoreDb,
} from "@mstar-harness/engine";
import { executeCommand } from "../definitions.js";
import type { InvocationContext } from "../types.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-issue-sync-command-"));
const HOME = join(ROOT, "home");
mkdirSync(HOME);
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
const savedSystem = process.env.GIT_CONFIG_NOSYSTEM;
let homeSpy: { mockRestore(): void } | undefined;

beforeAll(() => {
  // why: The fixture's own git config decides; a developer's global identity must not.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  // The collaboration store is user-level, so the resolver's home is the fixture's.
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});

afterAll(() => {
  homeSpy?.mockRestore();
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  if (savedSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = savedSystem;
  rmSync(ROOT, { recursive: true, force: true });
});

const PROJECT = "p-mirror";
/** Each fixture's origin appends its own directory name, so no two share a collaboration store. */
const REPO_PREFIX = "acme/widgets";
const AUTHOR = "Ada Lovelace <ada@example.com>";
const BINDING = "linear:" + PROJECT;
const LOCAL_IDS = ["I-000101", "I-000102", "I-000103"];

const UNUSED_EFFECTS = {
  readInput: async () => "",
  spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
  startDashboard: async () => {
    throw new Error("unused");
  },
  openBrowser: async () => {
    throw new Error("unused");
  },
};

function git(repo: string, args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

type Fixture = {
  repo: string;
  repoRoot: string;
  harnessDir: string;
  context: InvocationContext;
  /** note:  The same invocation with its own stdin body, for the stdin route. */
  withStdin(payload: string): InvocationContext;
  read<T>(fn: (db: StoreDb) => T): Promise<T>;
};

/**
 * note: A repository with a .mstarc mirror block, a git identity and an initialized
 * store that binds one Linear project and holds three local issues — the state
 * an operator reaches after project bind and three captures.
 */
async function fixture(
  name: string,
  options: { enabled?: boolean; bind?: boolean; email?: string; collaborationMode?: "local" | "mirror" } = {},
): Promise<Fixture> {
  const dir = mkdtempSync(join(ROOT, name));
  const repoRoot = join(dir, "repo");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ["init", "-q"]);
  const repo = REPO_PREFIX + "-" + basename(dir);
  git(repoRoot, ["remote", "add", "origin", "git@github.com:" + repo + ".git"]);
  git(repoRoot, ["config", "user.name", "Ada Lovelace"]);
  git(repoRoot, ["config", "user.email", options.email ?? "ada@example.com"]);
  writeFileSync(
    join(repoRoot, ".mstarc"),
    "[linear]\nenabled=" + (options.enabled === false ? "false" : "true") + "\nmode=mirror\nworkspace=acme\nteam=ENG\n" +
      // The repository delivers to Linear, so its collaboration authority is the
      // mirror mode; the ledger and the issues live in that lane.
      "[collaboration]\nmode=" + (options.collaborationMode ?? "mirror") + "\n",
  );
  const harnessDir = join(repoRoot, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  // No execution store is created: the mirror's binding and ledger live in the
  // collaboration lane, so a checkout without one must plan and record.
  const collaboration = resolveCollaborationLocation({ harnessDir });
  await initializeCollaborationStore(collaboration);
  const staged = new DatabaseSync(collaboration.dbPath);
  try {
    staged.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(
      new Date().toISOString(),
    );
  } finally {
    staged.close();
  }
  await withCollaborationWrite({ harnessDir }, ({ db }) => {
    db.prepare(
      "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', ?, 'Mirror', 'projects', ?, 'now', 'now')",
    ).run(PROJECT, PROJECT + "/roadmap.md");
    db.prepare(
      "insert into project_bindings(project_id, provider, workspace, team, remote_project, revision, updated_at)" +
        " values (?, 'linear', 'acme', 'ENG', 'Remote', 1, ?)",
    ).run(PROJECT, new Date().toISOString());
    for (const [index, localId] of LOCAL_IDS.entries()) {
      db.prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)" +
          " values (?, ?, ?, ?, 'high', 'open', 'impact body', 'acceptance body', 'now', 'now', ?)",
      ).run(localId, PROJECT, "Issue " + localId, index === 1 ? "risk" : "bug", "sync-issue-" + localId);
    }
  });
  if (options.bind === false) {
    // A checkout whose project mirrors nothing: the binding row is the only source.
    await withCollaborationWrite({ harnessDir }, ({ db }) => {
      db.prepare("delete from project_bindings where project_id = ?").run(PROJECT);
    });
  }
  const base = {
    cwd: repoRoot,
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
  };
  return {
    repo,
    repoRoot,
    harnessDir,
    context: { ...base, effects: { ...UNUSED_EFFECTS } },
    withStdin(payload: string) {
      return { ...base, effects: { ...UNUSED_EFFECTS, readInput: async () => payload } };
    },
    async read<T>(fn: (db: StoreDb) => T): Promise<T> {
      // The ledger and the issues are the collaboration authority's; the project
      // binding still lives in the execution store until project governance moves.
      const opened = await openCollaborationStore({ harnessDir }, "read");
      try {
        return fn(opened.db);
      } finally {
        opened.close();
      }
    },
  };
}

function markerOf(repo: string, localId: string, overrides: { author?: string } = {}): string {
  return "<!-- mstar-sync: repo=" + repo + "; local=" + localId + "; author=" + (overrides.author ?? AUTHOR) + " -->";
}

/** note:  What a Linear tool would return for one listed issue mirroring a local id. */
function record(f: Fixture, externalId: string, localId: string, overrides: Partial<ProviderItem> = {}): ProviderItem {
  return {
    externalId,
    title: "Issue " + localId,
    description: "## Impact\n\nimpact body\n\n## Acceptance\n\nacceptance body\n\n" + markerOf(f.repo, localId),
    state: "Todo",
    priority: "2",
    labels: ["bug"],
    updatedAt: "2026-11-19T12:00:00.000Z",
    url: "https://linear.app/acme/issue/" + externalId,
    ...overrides,
  };
}

type Result = { status: string; code: string; message?: string; details?: Record<string, unknown>; data?: any };

function run(verb: string, input: Record<string, unknown>, context: InvocationContext): Promise<Result> {
  return executeCommand("issue-sync." + verb, { project: PROJECT, ...input }, context) as Promise<Result>;
}

/** note:  Write a JSON body inside the fixture, for the file-path route. */
function bodyFile(f: Fixture, name: string, body: unknown): string {
  const path = join(f.repoRoot, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function rowOf(f: Fixture, localId: string) {
  return f.read((db) => readItem(db, { bindingId: BINDING, direction: PUSH_DIRECTION, localId }));
}

describe("pending", () => {
  test("hands back the payloads, the marker and the run lease, and sends nothing", async () => {
    const f = await fixture("pending-shape");
    const result = await run("pending", {}, f.context);
    expect(result.status).toBe("ok");
    const data = result.data;
    expect(data.binding).toEqual({ provider: "linear", workspace: "acme", team: "ENG", remoteProject: "Remote" });
    expect(data.identity).toEqual({ repo: f.repo, author: AUTHOR });
    expect(typeof data.runId).toBe("string");
    expect(data.skipped).toEqual([]);
    expect(data.unresolved).toEqual([]);
    expect(data.items.map((entry: { localId: string }) => entry.localId)).toEqual(LOCAL_IDS);

    const first = data.items[0];
    expect(first).toMatchObject({ localId: "I-000101", operation: "create", externalId: null });
    expect(first.marker).toBe(markerOf(f.repo, "I-000101"));
    expect(first.payload).toMatchObject({ title: "Issue I-000101", priority: 2, state: "Todo", labels: ["bug"] });
    expect(typeof first.requestHash).toBe("string");
    // why: The marker is the LAST line of what the tool writes: that is the key a
    // later listing is associated by.
    expect(first.payload.description.endsWith("\n\n" + first.marker)).toBe(true);

    // why: Planning is the intent record: the ledger holds a pending create.
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "pending", externalId: null });
  });

  test("a second run is refused by name while the first still holds the lease", async () => {
    const f = await fixture("pending-run-held");
    await run("pending", {}, f.context);
    const refusedRun = await run("pending", {}, f.context);
    expect(refusedRun.status).toBe("refused");
    expect(refusedRun.code).toBe("sync.run-held");
    expect(refusedRun.details?.recovery).toContain("--take-run");
  });

  test("refuses a disabled mirror, an unbound project and a checkout with no git author", async () => {
    const disabled = await fixture("pending-disabled", { enabled: false });
    const disabledResult = await run("pending", {}, disabled.context);
    expect(disabledResult.code).toBe("linear.provider-disabled");
    expect(disabledResult.message).toContain("enabled");

    const unbound = await fixture("pending-unbound", { bind: false });
    const unboundResult = await run("pending", {}, unbound.context);
    expect(unboundResult.code).toBe("linear.binding-absent");
    expect(unboundResult.message).toContain("project bind");

    const anonymous = await fixture("pending-anonymous", { email: "" });
    const anonymousResult = await run("pending", {}, anonymous.context);
    expect(anonymousResult.code).toBe("linear.author-unresolved");
    expect(anonymousResult.message).toContain("git config user.email");
  });

  test("nothing in the sync path opens a socket", async () => {
    // The project's hard constraint (#776): no Linear network call may remain in
    // mstar. This is an ABSENCE assertion, so it reads the sources instead of
    // observing a call that must never happen.
    const files = [
      join(import.meta.dir, "issue-sync.ts"),
      ...readdirSync(join(import.meta.dir, "../../../engine/src/issue-sync"))
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map((name) => join(import.meta.dir, "../../../engine/src/issue-sync", name)),
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of ["node:http", "node:https", "node:net", "mcp.linear.app", "fetch("]) {
        expect([file, forbidden, source.includes(forbidden)]).toEqual([file, forbidden, false]);
      }
    }
  });
});

describe("apply", () => {
  test("records all three outcomes and ends the run", async () => {
    const f = await fixture("apply-outcomes");
    const pending = await run("pending", {}, f.context);
    const result = await run(
      "apply",
      {
        results: bodyFile(f, "results.json", [
          { localId: "I-000101", outcome: "confirmed", externalId: "LIN-11", remoteUpdatedAt: "2026-11-19T12:00:00.000Z" },
          { localId: "I-000102", outcome: "refused", cause: "label risk does not exist in team ENG" },
          { localId: "I-000103", outcome: "ambiguous", cause: "tool call timed out after send" },
        ]),
        run: pending.data.runId,
      },
      f.context,
    );
    expect(result.status).toBe("ok");
    expect(result.data.runId).toBe(pending.data.runId);
    expect(result.data.counts).toEqual({ applied: 1, unconfirmed: 1, refused: 1 });
    // why: items[] echoes the CALLER'S word; the ledger state each produced is in counts.
    expect(result.data.items).toEqual([
      { localId: "I-000101", outcome: "confirmed", externalId: "LIN-11" },
      {
        localId: "I-000102",
        outcome: "refused",
        externalId: null,
        cause: expect.stringContaining("[linear.write-refused] label risk does not exist in team ENG"),
      },
      { localId: "I-000103", outcome: "ambiguous", externalId: null, cause: expect.stringContaining("tool call timed out") },
    ]);
    expect(result.data.counts).toEqual({ applied: 1, unconfirmed: 1, refused: 1 });
    // why: The causes are the tool's own words plus the one-line recovery: a failure
    // report that names no next step leaves the operator stuck.
    expect(result.data.items[1].cause).toContain("mstar issue-sync pending");
    expect(result.data.items[2].cause).toContain("mstar issue-sync ingest");

    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "applied", externalId: "LIN-11" });
    expect(await rowOf(f, "I-000102")).toMatchObject({ itemState: "failed", externalId: null });
    expect(await rowOf(f, "I-000103")).toMatchObject({ itemState: "pending", externalId: null });
    // why: The run ended with this verb: the next pending may claim it again.
    expect(await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }))).toBeNull();
    expect((await run("pending", {}, f.context)).status).toBe("ok");
  });

  test("an unknown local id and a missing field are per-item refusals, not a failed run", async () => {
    const f = await fixture("apply-per-item");
    const pending = await run("pending", {}, f.context);
    const result = await run(
      "apply",
      {
        results: bodyFile(f, "bad-results.json", [
          { localId: "I-999999", outcome: "confirmed", externalId: "LIN-9" },
          { localId: "I-000101", outcome: "confirmed" },
        ]),
        run: pending.data.runId,
      },
      f.context,
    );
    expect(result.status).toBe("ok");
    expect(result.data.counts).toEqual({ applied: 0, unconfirmed: 0, refused: 2 });
    expect(result.data.items[0].cause).toContain("externalId");
    expect(result.data.items[1].cause).toContain("no push ledger row");
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "pending", externalId: null });
  });

  test("results that name no run are refused as unattributed, with the reconciliation recovery", async () => {
    // why: A result only means something as the answer to a plan this repository
    // recorded. Without `--run` it belongs to no run, so recording it would adopt
    // whatever the caller cached - the one thing a one-way mirror must not guess.
    const f = await fixture("apply-unattributed");
    expect(await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }))).toBeNull();
    const result = await run(
      "apply",
      { results: bodyFile(f, "orphan.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-81" }]) },
      f.context,
    );
    expect(result.status).toBe("refused");
    expect(result.code).toBe("sync.run-held");
    expect(result.message).toContain("unattributed");
    expect(result.message).toContain("--run <runId>");
    // why: A legacy result has exactly two supported paths, and the refusal names both.
    expect(result.message).toContain("issue-sync ingest");
    expect(result.message).toContain("--adopt");
    expect(await rowOf(f, "I-000101")).toBeNull();
    expect(await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }))).toBeNull();
  });

  test("--take-run refuses to record results: a takeover only replaces a dead holder", async () => {
    const f = await fixture("apply-take-run-results");
    const pending = await run("pending", {}, f.context);
    const takeover = await run(
      "apply",
      {
        results: bodyFile(f, "takeover.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-82" }]),
        takeRun: true,
      },
      f.context,
    );
    expect(takeover.status).toBe("refused");
    expect(takeover.code).toBe("sync.run-held");
    expect(takeover.message).toContain("takeover records no results");
    // Nothing moved: the pending run still owns the direction and its item is untouched.
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "pending", externalId: null });
    const held = await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }));
    expect(held?.runId).toBe(pending.data.runId);
  });
  test("--take-run ends a dead holder's run and the next pending works", async () => {
    const f = await fixture("apply-take-run");
    await run("pending", {}, f.context);
    expect((await run("pending", {}, f.context)).code).toBe("sync.run-held");
    const takeover = await run("apply", { results: "-", takeRun: true }, f.withStdin("[]"));
    expect(takeover.status).toBe("ok");
    expect(takeover.data.counts).toEqual({ applied: 0, unconfirmed: 0, refused: 0 });
    expect(await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }))).toBeNull();
    expect((await run("pending", {}, f.context)).status).toBe("ok");
  });

  test("a stale apply cannot continue a run a later pending opened", async () => {
    // why: The reported defect: apply picked whatever run was held, so an old retry
    // wrote under a newer run's token and deleted that holder's lease on the way
    // out. The evidence is the claim timestamp of the create cycle.
    const f = await fixture("apply-stale-run");
    await run("pending", {}, f.context);
    // why: Ends the planning run without recording the item: its create stays a residue.
    await run("apply", { results: "-", takeRun: true }, f.withStdin("[]"));
    expect((await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION })))).toBeNull();
    await Bun.sleep(2);
    const later = await run("pending", {}, f.context);
    expect(later.status).toBe("ok");

    const stale = await run(
      "apply",
      {
        results: bodyFile(f, "stale.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-9" }]),
        run: later.data.runId,
      },
      f.context,
    );
    expect(stale.status).toBe("refused");
    expect(stale.code).toBe("sync.run-held");
    expect(stale.message).toContain("earlier run");
    // why: the recovery for a stale result is the identity it is about, not `--take-run`;
    // that flag would bypass the ownership check this refusal exists for.
    expect(String(stale.details?.recovery)).toContain("--adopt");
    expect(String(stale.details?.recovery)).toContain("mstar issue-sync ingest");
    expect(String(stale.details?.recovery)).toContain("not the repair here");
    // why: Nothing was recorded, and the newer holder still owns the direction.
    expect((await rowOf(f, "I-000101"))!.externalId).toBeNull();
    const held = await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }));
    expect(held?.runId).toBe(later.data.runId);
  });

  test("an explicit --adopt admits a stale result it covers, and the named run completes", async () => {
    // why: the documented recovery composition for a residue whose planning run has
    // ended while a newer run holds the lease: adopt the identity, then record the
    // confirmed result that names the same issue. The adoption, not the older run,
    // carries the identity, so this is not the stale retry the preflight refuses.
    const f = await fixture("apply-stale-run-adopted");
    await run("pending", {}, f.context);
    await run("apply", { results: "-", takeRun: true }, f.withStdin("[]"));
    await Bun.sleep(2);
    const later = await run("pending", {}, f.context);
    expect(later.status).toBe("ok");

    const result = await run(
      "apply",
      {
        results: bodyFile(f, "adopted.json", [
          { localId: "I-000101", outcome: "confirmed", externalId: "LIN-9", remoteUpdatedAt: "2026-11-19T12:00:00.000Z" },
        ]),
        adopt: ["I-000101=LIN-9"],
        run: later.data.runId,
      },
      f.context,
    );
    expect(result.status).toBe("ok");
    expect(result.data.adopted).toEqual([{ localId: "I-000101", externalId: "LIN-9" }]);
    expect(result.data.counts).toEqual({ applied: 1, unconfirmed: 0, refused: 0 });
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "applied", externalId: "LIN-9" });
    // why: the invocation named this run, so it holds its token and the run ends in
    // the commit that recorded the results; an unnamed operator-only batch is what
    // leaves a borrowed lease intact.
    expect(result.data.lease).toBe("released");
    expect(result.data.runId).toBe(later.data.runId);
    expect(await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }))).toBeNull();
  });

  test("an adoption naming the issue URL covers a result naming its identifier", async () => {
    // why: both sides are normalized before they are compared, so the operator may pass
    // either the URL copied from Linear or the bare identifier the record carries.
    const f = await fixture("apply-stale-run-url-adopt");
    await run("pending", {}, f.context);
    await run("apply", { results: "-", takeRun: true }, f.withStdin("[]"));
    await Bun.sleep(2);
    const laterUrl = await run("pending", {}, f.context);
    const result = await run(
      "apply",
      {
        results: bodyFile(f, "url-adopt.json", [
          { localId: "I-000101", outcome: "confirmed", externalId: "LIN-9", remoteUpdatedAt: "2026-11-19T12:00:00.000Z" },
        ]),
        adopt: ["I-000101=https://linear.app/acme/issue/LIN-9/url-form"],
        run: laterUrl.data.runId,
      },
      f.context,
    );
    expect(result.status).toBe("ok");
    expect(result.data.adopted).toEqual([{ localId: "I-000101", externalId: "LIN-9" }]);
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "applied", externalId: "LIN-9" });
  });

  test("a stale result the adoption does not cover is still refused", async () => {
    // why: coverage is per item and per identity; an adoption naming another issue
    // leaves this result exactly as stale as before.
    const f = await fixture("apply-stale-run-uncovered");
    await run("pending", {}, f.context);
    await run("apply", { results: "-", takeRun: true }, f.withStdin("[]"));
    await Bun.sleep(2);
    const laterMismatch = await run("pending", {}, f.context);
    const mismatch = await run(
      "apply",
      {
        results: bodyFile(f, "mismatch.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-9" }]),
        adopt: ["I-000101=LIN-10"],
        run: laterMismatch.data.runId,
      },
      f.context,
    );
    expect(mismatch.status).toBe("refused");
    expect(mismatch.code).toBe("sync.run-held");
    expect((await rowOf(f, "I-000101"))!.externalId).toBeNull();
  });

  test("--release clears an unconfirmed create, and an associated item is not releasable", async () => {
    const f = await fixture("apply-release");
    const pendingRelease = await run("pending", {}, f.context);
    await run(
      "apply",
      {
        results: bodyFile(f, "residue.json", [
          { localId: "I-000103", outcome: "ambiguous", cause: "connection closed mid-call" },
          { localId: "I-000101", outcome: "confirmed", externalId: "LIN-11" },
        ]),
        run: pendingRelease.data.runId,
      },
      f.context,
    );
    const released = await run("apply", { results: "-", release: ["I-000103"] }, f.withStdin("[]"));
    expect(released.status).toBe("ok");
    expect(released.data.released).toEqual(["I-000103"]);
    expect((await rowOf(f, "I-000103"))!.itemState).toBe("failed");

    // why: An item whose remote identity is recorded is adoption's, not release's.
    const refusedRelease = await run("apply", { results: "-", release: ["I-000101"] }, f.withStdin("[]"));
    expect(refusedRelease.code).toBe("sync.illegal-transition");
    expect(refusedRelease.message).toContain("names no unresolved create");
  });

  test("--adopt records an identity without any Linear call", async () => {
    const f = await fixture("apply-adopt");
    await run("pending", {}, f.context);
    const adopted = await run(
      "apply",
      { results: "-", adopt: ["I-000102=https://linear.app/acme/issue/LIN-77/some-slug"] },
      f.withStdin("[]"),
    );
    expect(adopted.status).toBe("ok");
    expect(adopted.data.adopted).toEqual([{ localId: "I-000102", externalId: "LIN-77" }]);
    expect((await rowOf(f, "I-000102"))!.externalId).toBe("LIN-77");
  });

  test("a malformed payload is a usage refusal that names the flag", async () => {
    const f = await fixture("apply-usage");
    const notJson = join(f.repoRoot, "broken.json");
    writeFileSync(notJson, "nope");
    const broken = await run("apply", { results: notJson }, f.context);
    expect(broken.status).toBe("usage");
    expect(broken.message).toContain("--results");
    const missing = await run("apply", { results: bodyFile(f, "not-array.json", {}) }, f.context);
    expect(missing.status).toBe("usage");
    expect(missing.message).toContain("JSON array");
  });
});

describe("mirror stale run", () => {
  test("--run continues the exact run `pending` returned", async () => {
    const f = await fixture("run-correlated");
    const pending = await run("pending", {}, f.context);
    const accepted = await run(
      "apply",
      {
        results: bodyFile(f, "correlated.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-51" }]),
        run: pending.data.runId,
      },
      f.context,
    );
    expect(accepted.status).toBe("ok");
    expect(accepted.data.runId).toBe(pending.data.runId);
    expect(accepted.data.counts.applied).toBe(1);
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "applied", externalId: "LIN-51" });
    // The run ended with the apply that named it.
    expect(await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }))).toBeNull();
  });

  test("results naming an earlier or foreign run are refused, and nothing is recorded", async () => {
    const f = await fixture("run-stale");
    const pending = await run("pending", {}, f.context);
    const stale = await run(
      "apply",
      {
        results: bodyFile(f, "stale.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-52" }]),
        run: "run-from-an-earlier-attempt",
      },
      f.context,
    );
    expect(stale.status).toBe("refused");
    expect(stale.code).toBe("sync.run-held");
    // The refusal names the run that WOULD accept these results.
    expect(stale.message).toContain(pending.data.runId);
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "pending", externalId: null });
    // The pending run still holds the direction: a refused apply never ends it.
    const held = await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }));
    expect(held?.runId).toBe(pending.data.runId);
  });

  test("a rebind between pending and apply refuses, and the superseded run is retired before re-planning", async () => {
    const f = await fixture("run-rebind");
    const pending = await run("pending", {}, f.context);
    // The operator rebinds the project to another team between planning and recording.
    await withCollaborationWrite({ harnessDir: f.harnessDir }, ({ db }) => {
      db.prepare(
        "update project_bindings set team = ?, revision = revision + 1, updated_at = ? where project_id = ?",
      ).run("ENG-OPS", new Date().toISOString(), PROJECT);
    });
    const stale = await run(
      "apply",
      {
        results: bodyFile(f, "rebound.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-71" }]),
        run: pending.data.runId,
      },
      f.context,
    );
    expect(stale.status).toBe("refused");
    expect(stale.code).toBe("collaboration.stale-binding");
    expect(stale.message).toContain("different destination or collaboration generation");
    // Nothing was recorded under the old destination.
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "pending", externalId: null });

    // The documented recovery: retire the superseded run (a takeover records
    // nothing), re-plan under the binding in force, then record these results.
    const retired = await run("apply", { results: "-", takeRun: true }, f.withStdin("[]"));
    expect(retired.status).toBe("ok");
    const replanned = await run("pending", {}, f.context);
    expect(replanned.status).toBe("ok");
    // The create cycle the retired run opened is still its residue, so recording
    // it needs the explicit identity the operator confirmed.
    const unadopted = await run(
      "apply",
      {
        results: bodyFile(f, "rebound-2.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-71" }]),
        run: replanned.data.runId,
      },
      f.context,
    );
    expect(unadopted.status).toBe("refused");
    expect(unadopted.code).toBe("sync.run-held");
    expect(unadopted.message).toContain("earlier run");
    const applied = await run(
      "apply",
      {
        results: bodyFile(f, "rebound-3.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-71" }]),
        adopt: ["I-000101=LIN-71"],
        run: replanned.data.runId,
      },
      f.context,
    );
    expect(applied.status).toBe("ok");
    expect(applied.data.counts.applied).toBe(1);
  });

  test("an update result from an earlier run is refused instead of proving the current payload", async () => {
    const f = await fixture("run-old-update");
    const first = await run("pending", {}, f.context);
    const confirmed = await run(
      "apply",
      {
        results: bodyFile(f, "first.json", [
          { localId: "I-000101", outcome: "confirmed", externalId: "LIN-61", remoteUpdatedAt: "2026-11-19T12:00:00.000Z" },
        ]),
        run: first.data.runId,
      },
      f.context,
    );
    expect(confirmed.data.counts.applied).toBe(1);
    const provenHash = (await rowOf(f, "I-000101"))!.lastRequestHash;

    // The local content moved on, so the next run plans an UPDATE of the same issue.
    await withCollaborationWrite({ harnessDir: f.harnessDir }, ({ db }) => {
      db.prepare("update issues set title = ?, updated_at = ? where id = ?").run(
        "Issue I-000101 (edited)",
        new Date().toISOString(),
        "I-000101",
      );
    });
    const second = await run("pending", {}, f.context);
    expect(second.data.items).toEqual([
      expect.objectContaining({ localId: "I-000101", operation: "update", externalId: "LIN-61" }),
    ]);

    // The cached result of the FIRST run cannot prove this run's write.
    const stale = await run(
      "apply",
      {
        results: bodyFile(f, "stale-update.json", [
          { localId: "I-000101", outcome: "confirmed", externalId: "LIN-61", remoteUpdatedAt: "2026-11-19T12:00:00.000Z" },
        ]),
        run: first.data.runId,
      },
      f.context,
    );
    expect(stale.status).toBe("refused");
    expect(stale.code).toBe("sync.run-held");
    // The payload proof still belongs to the confirmed write, not to this attempt.
    expect((await rowOf(f, "I-000101"))!.lastRequestHash).toBe(provenHash);
    expect((await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION })))?.runId).toBe(
      second.data.runId,
    );
  });

  test("one pending command advances the collaboration revision once for its whole batch", async () => {
    const f = await fixture("run-batch-revision");
    const revision = (): Promise<number> =>
      f.read(
        (db) =>
          (db.prepare("select revision from collaboration_meta where id = 1").get() as { revision: number }).revision,
      );
    expect(await revision()).toBe(0);
    const planned = await run("pending", {}, f.context);
    // Three items, one transaction: one advance, not one per item.
    expect(planned.data.items).toHaveLength(3);
    expect(await revision()).toBe(1);
  });

  test("--run with no run holding the binding refuses instead of continuing a guess", async () => {
    const f = await fixture("run-absent");
    const result = await run(
      "apply",
      {
        results: bodyFile(f, "nobody.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-91" }]),
        run: "nobody",
      },
      f.context,
    );
    expect(result.status).toBe("refused");
    expect(result.code).toBe("sync.run-held");
    expect(result.message).toContain("continues nothing");
  });

  test("--run and --take-run are contradictory flags", async () => {
    const f = await fixture("run-contradiction");
    await run("pending", {}, f.context);
    const result = await run("apply", { results: bodyFile(f, "none.json", []), run: "x", takeRun: true }, f.context);
    expect(result.status).toBe("usage");
    expect(result.message).toContain("--take-run");
  });

  test("a changed [linear] connection between pending and apply refuses", async () => {
    const f = await fixture("run-changed-connection");
    const pending = await run("pending", {}, f.context);
    // Same project binding row, different connection: the run's proof no longer holds.
    writeFileSync(
      join(f.repoRoot, ".mstarc"),
      "[linear]\nenabled=true\nmode=mirror\nworkspace=other\nteam=ENG\n[collaboration]\nmode=mirror\n",
    );
    const stale = await run(
      "apply",
      {
        results: bodyFile(f, "changed.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-93" }]),
        run: pending.data.runId,
      },
      f.context,
    );
    expect(stale.status).toBe("refused");
    expect(stale.code).toBe("collaboration.stale-binding");
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "pending", externalId: null });
  });

  test("a restored collaboration generation retires the pending run", async () => {
    const f = await fixture("run-epoch");
    const pending = await run("pending", {}, f.context);
    // A verified restore publishes a new epoch; a run from the previous generation
    // names an authority that no longer exists.
    await withCollaborationWrite({ harnessDir: f.harnessDir }, ({ db }) => {
      db.prepare("update collaboration_meta set authority_epoch = authority_epoch + 1 where id = 1").run();
    });
    const stale = await run(
      "apply",
      {
        results: bodyFile(f, "restored.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-94" }]),
        run: pending.data.runId,
      },
      f.context,
    );
    expect(stale.status).toBe("refused");
    expect(stale.code).toBe("collaboration.stale-binding");
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "pending", externalId: null });
  });

  test("an empty batch and an invalid-only batch leave a live run intact", async () => {
    const f = await fixture("run-borrowed-live");
    const pending = await run("pending", {}, f.context);
    const empty = await run("apply", { results: "-" }, f.withStdin("[]"));
    expect(empty.status).toBe("usage");
    expect(empty.message).toContain("nothing to record");
    // One entry that parses but attributes to no run: refused, never borrowed.
    const invalid = await run(
      "apply",
      { results: bodyFile(f, "invalid.json", [{ localId: "I-999999", outcome: "confirmed", externalId: "LIN-95" }]) },
      f.context,
    );
    expect(invalid.status).toBe("refused");
    expect(invalid.code).toBe("sync.run-held");
    expect((await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION })))?.runId).toBe(
      pending.data.runId,
    );
  });

  test("an operator-only batch leaves a borrowed run intact and says so", async () => {
    const f = await fixture("run-operator-borrow");
    const pending = await run("pending", {}, f.context);
    const adopted = await run("apply", { results: "-", adopt: ["I-000102=LIN-77"] }, f.withStdin("[]"));
    expect(adopted.status).toBe("ok");
    expect(adopted.data.lease).toBe("left-to-the-holder");
    // The holder's run survives: its own exact-token results are still recordable.
    expect((await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION })))?.runId).toBe(
      pending.data.runId,
    );
  });

  test("the mirror runs on a checkout with no execution store", async () => {
    const f = await fixture("run-no-execution-store");
    expect(existsSync(join(f.harnessDir, "store.db"))).toBe(false);
    const pending = await run("pending", {}, f.context);
    expect(pending.status).toBe("ok");
    const applied = await run(
      "apply",
      {
        results: bodyFile(f, "no-exec.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-96" }]),
        run: pending.data.runId,
      },
      f.context,
    );
    expect(applied.status).toBe("ok");
    expect(applied.data.counts.applied).toBe(1);
    expect(existsSync(join(f.harnessDir, "store.db"))).toBe(false);
  });

  test("a mirror command refuses a local-mode repository", async () => {
    const f = await fixture("run-local-mode", { collaborationMode: "local" });
    const result = await run("pending", {}, f.context);
    expect(result.status).toBe("refused");
    expect(result.code).toBe("collaboration.mode-unavailable");
    expect(result.message).toContain("local");
    // Nothing was planned: the local authority never pushes.
    expect(await rowOf(f, "I-000101")).toBeNull();
  });
});

describe("ingest", () => {
  test("one record per bucket, and no local issue is written", async () => {
    const f = await fixture("ingest-buckets");
    // why: A confirmed push first, so this item has a recorded payload hash that a
    // remote edit can drift from.
    const planned = await run("pending", {}, f.context);
    await run(
      "apply",
      {
        results: bodyFile(f, "confirmed.json", [{ localId: "I-000102", outcome: "confirmed", externalId: "LIN-32" }]),
        run: planned.data.runId,
      },
      f.context,
    );
    const before = await f.read((db) => db.prepare("select id, title, updated_at from issues order by id").all());
    const records = [
      record(f, "LIN-31", "I-000101"),
      record(f, "LIN-32", "I-000102", { title: "edited in Linear" }),
      record(f, "LIN-33", "I-000103", { description: "body\n\n" + markerOf(f.repo, "I-000103", { author: "Bo <bo@example.test>" }) }),
      record(f, "LIN-34", "I-999999", { description: "body\n\n" + markerOf(f.repo, "I-999999") }),
      record(f, "LIN-35", "I-000101", { description: "## Impact\n\nno marker at all" }),
      record(f, "LIN-36", "I-000101", { description: "body\n\n<!-- mstar-sync: acme/ENG/store-alpha/I-000101 -->" }),
    ];
    const result = await run("ingest", { records: "-" }, f.withStdin(JSON.stringify(records)));
    expect(result.status).toBe("ok");
    expect(result.data.counts).toEqual({ associated: 1, drift: 1, foreign: 1, orphan: 1, unmanaged: 2 });
    expect(result.data.identity).toEqual({ repo: f.repo, author: AUTHOR });
    expect(result.data.associated).toEqual([
      { localId: "I-000101", externalId: "LIN-31", url: "https://linear.app/acme/issue/LIN-31" },
    ]);
    expect(result.data.drift[0]).toMatchObject({ localId: "I-000102", externalId: "LIN-32" });
    expect(result.data.foreign[0].cause).toContain("Bo <bo@example.test>");
    expect(result.data.orphan[0].localId).toBe("I-999999");
    expect(result.data.unmanaged.map((entry: { externalId: string }) => entry.externalId)).toEqual(["LIN-35", "LIN-36"]);

    // why: The ledger is the only effect: the association is recorded...
    expect((await rowOf(f, "I-000101"))!.externalId).toBe("LIN-31");
    // why: ...and no local issue was created, retitled or touched.
    expect(await f.read((db) => db.prepare("select id, title, updated_at from issues order by id").all())).toEqual(before);
  });

  test("remote content equal to the confirmed payload is associated, and an edit drifts", async () => {
    const f = await fixture("ingest-converged");
    const planned = await run("pending", {}, f.context);
    await run(
      "apply",
      {
        results: bodyFile(f, "confirmed.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-41" }]),
        run: planned.data.runId,
      },
      f.context,
    );
    const converged = record(f, "LIN-41", "I-000101");
    const first = await run("ingest", { records: bodyFile(f, "converged.json", [converged]) }, f.context);
    expect(first.data.counts).toEqual({ associated: 1, drift: 0, foreign: 0, orphan: 0, unmanaged: 0 });
    const edited = await run(
      "ingest",
      { records: bodyFile(f, "edited.json", [{ ...converged, title: "edited in Linear" }]) },
      f.context,
    );
    expect(edited.data.counts).toEqual({ associated: 0, drift: 1, foreign: 0, orphan: 0, unmanaged: 0 });
    expect(edited.data.drift[0].cause).toContain("no longer matches");
  });

  test("an ill-formed listing is a usage refusal naming the entry", async () => {
    const f = await fixture("ingest-usage");
    const missingUpdatedAt = await run(
      "ingest",
      { records: bodyFile(f, "no-updated.json", [{ externalId: "LIN-1", description: "x" }]) },
      f.context,
    );
    expect(missingUpdatedAt.status).toBe("usage");
    expect(missingUpdatedAt.message).toContain("--records[0]");
    expect(missingUpdatedAt.message).toContain("updatedAt");
    const noExternalId = await run("ingest", { records: bodyFile(f, "no-external.json", [{ updatedAt: 1 }]) }, f.context);
    expect(noExternalId.status).toBe("usage");
    expect(noExternalId.message).toContain("externalId");
  });
});
