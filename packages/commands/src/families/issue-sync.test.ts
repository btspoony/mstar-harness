/**
 * note: issue-sync.test.ts — the three local verbs of the Linear mirror: pending, apply,
 * ingest. mstar makes no Linear call, so nothing here is faked except the
 * filesystem and stdin: the fixture plays the agent that holds the host's tools,
 * and every assertion reads the store's real ledger.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bindProject,
  initializeStore,
  openStore,
  readItem,
  readRun,
  PUSH_DIRECTION,
  type ProviderItem,
  type StoreDb,
} from "@mstar-harness/engine";
import { executeCommand } from "../definitions.js";
import type { InvocationContext } from "../types.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-issue-sync-command-"));
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
const savedSystem = process.env.GIT_CONFIG_NOSYSTEM;

beforeAll(() => {
  // why: The fixture's own git config decides; a developer's global identity must not.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  if (savedSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = savedSystem;
  rmSync(ROOT, { recursive: true, force: true });
});

const PROJECT = "p-mirror";
const REPO = "acme/widgets";
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
async function fixture(name: string, options: { enabled?: boolean; bind?: boolean; email?: string } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(ROOT, name));
  const repoRoot = join(dir, "repo");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["remote", "add", "origin", "git@github.com:" + REPO + ".git"]);
  git(repoRoot, ["config", "user.name", "Ada Lovelace"]);
  git(repoRoot, ["config", "user.email", options.email ?? "ada@example.com"]);
  writeFileSync(
    join(repoRoot, ".mstarc"),
    "[linear]\nenabled=" + (options.enabled === false ? "false" : "true") + "\nmode=mirror\nworkspace=acme\nteam=ENG\n",
  );
  const harnessDir = join(repoRoot, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const handle = await initializeStore({ harnessDir });
  handle.db
    .prepare(
      "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', ?, 'Mirror', 'projects', ?, 'now', 'now')",
    )
    .run(PROJECT, PROJECT + "/roadmap.md");
  for (const [index, localId] of LOCAL_IDS.entries()) {
    handle.db
      .prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)" +
          " values (?, ?, ?, ?, 'high', 'open', 'impact body', 'acceptance body', 'now', 'now', ?)",
      )
      .run(localId, PROJECT, "Issue " + localId, index === 1 ? "risk" : "bug", "sync-issue-" + localId);
  }
  handle.close();
  if (options.bind !== false) {
    await bindProject(
      { harnessDir },
      PROJECT,
      { provider: "linear", workspace: "acme", team: "ENG", remoteProject: "Remote" },
      { operationId: "bind-1" },
    );
  }
  const base = {
    cwd: repoRoot,
    controlRoot: null,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
  };
  return {
    repoRoot,
    harnessDir,
    context: { ...base, effects: { ...UNUSED_EFFECTS } },
    withStdin(payload: string) {
      return { ...base, effects: { ...UNUSED_EFFECTS, readInput: async () => payload } };
    },
    async read<T>(fn: (db: StoreDb) => T): Promise<T> {
      const opened = await openStore({ harnessDir }, "read");
      try {
        return fn(opened.db);
      } finally {
        opened.close();
      }
    },
  };
}

function markerOf(localId: string, overrides: { repo?: string; author?: string } = {}): string {
  return (
    "<!-- mstar-sync: repo=" + (overrides.repo ?? REPO) + "; local=" + localId + "; author=" + (overrides.author ?? AUTHOR) + " -->"
  );
}

/** note:  What a Linear tool would return for one listed issue mirroring a local id. */
function record(externalId: string, localId: string, overrides: Partial<ProviderItem> = {}): ProviderItem {
  return {
    externalId,
    title: "Issue " + localId,
    description: "## Impact\n\nimpact body\n\n## Acceptance\n\nacceptance body\n\n" + markerOf(localId),
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
    expect(data.identity).toEqual({ repo: REPO, author: AUTHOR });
    expect(typeof data.runId).toBe("string");
    expect(data.skipped).toEqual([]);
    expect(data.unresolved).toEqual([]);
    expect(data.items.map((entry: { localId: string }) => entry.localId)).toEqual(LOCAL_IDS);

    const first = data.items[0];
    expect(first).toMatchObject({ localId: "I-000101", operation: "create", externalId: null });
    expect(first.marker).toBe(markerOf("I-000101"));
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
    await run("pending", {}, f.context);
    const result = await run(
      "apply",
      {
        results: bodyFile(f, "bad-results.json", [
          { localId: "I-999999", outcome: "confirmed", externalId: "LIN-9" },
          { localId: "I-000101", outcome: "confirmed" },
        ]),
      },
      f.context,
    );
    expect(result.status).toBe("ok");
    expect(result.data.counts).toEqual({ applied: 0, unconfirmed: 0, refused: 2 });
    expect(result.data.items[0].cause).toContain("externalId");
    expect(result.data.items[1].cause).toContain("no push ledger row");
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "pending", externalId: null });
  });

  test("apply with no prior pending acquires its own run and still records", async () => {
    // why: The recovery branch: pending ran somewhere else and released (or crashed
    // without claiming), so there is no held run. apply must not need one - it
    // acquires a fresh lease so every ledger write still carries a run token.
    const f = await fixture("apply-no-held-run");
    expect(await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }))).toBeNull();
    // why: An unclaimed pending row would be refused (round 4's guard), so this
    // exercises the clean path: a local id with no ledger row at all is a
    // per-item refusal, and the run itself succeeds and ends.
    const result = await run(
      "apply",
      { results: bodyFile(f, "orphan.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-81" }]) },
      f.context,
    );
    expect(result.status).toBe("ok");
    expect(result.data.runId).toBeTruthy();
    expect(result.data.counts).toEqual({ applied: 0, unconfirmed: 0, refused: 1 });
    expect(result.data.items[0].cause).toContain("no push ledger row");
    expect(await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }))).toBeNull();
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
    await run("apply", { results: "-" }, f.withStdin("[]"));
    expect((await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION })))).toBeNull();
    await Bun.sleep(2);
    const later = await run("pending", {}, f.context);
    expect(later.status).toBe("ok");

    const stale = await run(
      "apply",
      { results: bodyFile(f, "stale.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-9" }]) },
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

  test("an explicit --adopt admits a stale result it covers, and keeps the newer lease", async () => {
    // why: the documented recovery composition for a residue whose planning run has
    // ended while a newer run holds the lease: adopt the identity, then record the
    // confirmed result that names the same issue. The adoption, not the older run,
    // carries the identity, so this is not the stale retry the preflight refuses.
    const f = await fixture("apply-stale-run-adopted");
    await run("pending", {}, f.context);
    await run("apply", { results: "-" }, f.withStdin("[]"));
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
      },
      f.context,
    );
    expect(result.status).toBe("ok");
    expect(result.data.adopted).toEqual([{ localId: "I-000101", externalId: "LIN-9" }]);
    expect(result.data.counts).toEqual({ applied: 1, unconfirmed: 0, refused: 0 });
    expect(await rowOf(f, "I-000101")).toMatchObject({ itemState: "applied", externalId: "LIN-9" });
    // why: the lease was borrowed, not acquired: the newer holder still owns the
    // direction when this call returns, and the report says the run was left alone.
    expect(result.data.lease).toBe("left-to-the-holder");
    const held = await f.read((db) => readRun(db, { bindingId: BINDING, direction: PUSH_DIRECTION }));
    expect(held?.runId).toBe(later.data.runId);
    expect(result.data.runId).toBe(later.data.runId);
  });

  test("an adoption naming the issue URL covers a result naming its identifier", async () => {
    // why: both sides are normalized before they are compared, so the operator may pass
    // either the URL copied from Linear or the bare identifier the record carries.
    const f = await fixture("apply-stale-run-url-adopt");
    await run("pending", {}, f.context);
    await run("apply", { results: "-" }, f.withStdin("[]"));
    await Bun.sleep(2);
    await run("pending", {}, f.context);
    const result = await run(
      "apply",
      {
        results: bodyFile(f, "url-adopt.json", [
          { localId: "I-000101", outcome: "confirmed", externalId: "LIN-9", remoteUpdatedAt: "2026-11-19T12:00:00.000Z" },
        ]),
        adopt: ["I-000101=https://linear.app/acme/issue/LIN-9/url-form"],
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
    await run("apply", { results: "-" }, f.withStdin("[]"));
    await Bun.sleep(2);
    await run("pending", {}, f.context);
    const mismatch = await run(
      "apply",
      {
        results: bodyFile(f, "mismatch.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-9" }]),
        adopt: ["I-000101=LIN-10"],
      },
      f.context,
    );
    expect(mismatch.status).toBe("refused");
    expect(mismatch.code).toBe("sync.run-held");
    expect((await rowOf(f, "I-000101"))!.externalId).toBeNull();
  });

  test("--release clears an unconfirmed create, and an associated item is not releasable", async () => {
    const f = await fixture("apply-release");
    await run("pending", {}, f.context);
    await run(
      "apply",
      {
        results: bodyFile(f, "residue.json", [
          { localId: "I-000103", outcome: "ambiguous", cause: "connection closed mid-call" },
          { localId: "I-000101", outcome: "confirmed", externalId: "LIN-11" },
        ]),
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

describe("ingest", () => {
  test("one record per bucket, and no local issue is written", async () => {
    const f = await fixture("ingest-buckets");
    // why: A confirmed push first, so this item has a recorded payload hash that a
    // remote edit can drift from.
    await run("pending", {}, f.context);
    await run(
      "apply",
      { results: bodyFile(f, "confirmed.json", [{ localId: "I-000102", outcome: "confirmed", externalId: "LIN-32" }]) },
      f.context,
    );
    const before = await f.read((db) => db.prepare("select id, title, updated_at from issues order by id").all());
    const records = [
      record("LIN-31", "I-000101"),
      record("LIN-32", "I-000102", { title: "edited in Linear" }),
      record("LIN-33", "I-000103", { description: "body\n\n" + markerOf("I-000103", { author: "Bo <bo@example.test>" }) }),
      record("LIN-34", "I-999999", { description: "body\n\n" + markerOf("I-999999") }),
      record("LIN-35", "I-000101", { description: "## Impact\n\nno marker at all" }),
      record("LIN-36", "I-000101", { description: "body\n\n<!-- mstar-sync: acme/ENG/store-alpha/I-000101 -->" }),
    ];
    const result = await run("ingest", { records: "-" }, f.withStdin(JSON.stringify(records)));
    expect(result.status).toBe("ok");
    expect(result.data.counts).toEqual({ associated: 1, drift: 1, foreign: 1, orphan: 1, unmanaged: 2 });
    expect(result.data.identity).toEqual({ repo: REPO, author: AUTHOR });
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
    await run("pending", {}, f.context);
    await run(
      "apply",
      { results: bodyFile(f, "confirmed.json", [{ localId: "I-000101", outcome: "confirmed", externalId: "LIN-41" }]) },
      f.context,
    );
    const converged = record("LIN-41", "I-000101");
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
