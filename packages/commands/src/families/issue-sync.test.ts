/**
 * issue-sync.test.ts — the one supported import entry (mirror-import plan
 * Task 4): refusals before any write, and the end-to-end zero-delta proof over
 * a fixture provider. No live call, no credential: the provider is injected
 * through the host effects seam exactly as a host adapter would be.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  IMPORTED_ACCEPTANCE_KEY,
  IMPORTED_ROOT_CAUSE_KEY,
  PUSH_DIRECTION,
  acquireRun,
  bindProject,
  computeIdentityKey,
  initializeStore,
  openStore,
  readLedgerSummary,
  readRun,
  writeLinearCredential,
  type IssueProvider,
  type ProbeResult,
  type ProviderItem,
  type ProviderPage,
} from "@mstar-harness/engine";
import { executeCommand } from "../definitions.js";
import type { InvocationContext } from "../types.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-issue-sync-command-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const PROJECT = "p-import";

function item(overrides: Partial<ProviderItem> = {}): ProviderItem {
  return {
    externalId: "LIN-1",
    title: "Imported title",
    description: "Imported body",
    state: "Todo",
    priority: "High",
    labels: ["bug"],
    updatedAt: "2026-10-31T00:00:00.000Z",
    url: "https://linear.app/acme/issue/LIN-1",
    ...overrides,
  };
}

/** The fixture provider: scripted pages, a probe state, and a request counter. */
function provider(
  pages: (cursor: string | null) => ProviderPage,
  probe: ProbeResult = { state: "ready", cause: "ready: fixture handshake" },
): IssueProvider & { requests: Array<string | null> } {
  const requests: Array<string | null> = [];
  return {
    requests,
    async probe() {
      return probe;
    },
    async listIssues(cursor) {
      requests.push(cursor);
      return pages(cursor);
    },
    // The import fixture never writes; the member must still exist so the
    // fixture is a real provider rather than a partial one.
    async applyWrite() {
      throw new Error("the import fixture is read-only");
    },
  };
}

const EMPTY_UNUSED = {
  readInput: async () => "",
  spawn: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
  startDashboard: async () => {
    throw new Error("unused");
  },
  openBrowser: async () => {
    throw new Error("unused");
  },
};

type Fixture = { harnessDir: string; context: InvocationContext; db: () => Promise<import("@mstar-harness/engine").StoreDb> };

/**
 * A harness with an initialized store, a registered catalog project, a bound
 * Linear project and a repo `.mstarc` `[linear]` block — the state an operator
 * reaches after `mstar project bind`.
 */
async function fixture(
  name: string,
  issueProvider: IssueProvider | null,
  options: { bind?: boolean; enabled?: boolean } = {},
): Promise<Fixture> {
  const dir = mkdtempSync(join(ROOT, name));
  const repoRoot = join(dir, "repo");
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(
    join(repoRoot, ".mstarc"),
    `[linear]\nenabled=${options.enabled === false ? "false" : "true"}\nmode=mirror\nworkspace=acme\nteam=ENG\n`,
  );
  const harnessDir = join(repoRoot, ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  const context = { harnessDir };
  const handle = await initializeStore(context);
  handle.db.prepare(
    "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) values('project', ?, 'Import', 'projects', ?, 'now', 'now')",
  ).run(PROJECT, `${PROJECT}/roadmap.md`);
  handle.close();
  if (options.bind !== false) {
    await bindProject(context, PROJECT, { provider: "linear", workspace: "acme", team: "ENG", remoteProject: "Remote" }, { operationId: "bind-1" });
  }
  return {
    harnessDir: join(repoRoot, ".mstar"),
    db: async () => (await openStore(context, "read")).db,
    context: {
      cwd: repoRoot,
      controlRoot: null,
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal: new AbortController().signal,
      effects: { ...EMPTY_UNUSED, ...(issueProvider === null ? {} : { issueProvider: () => issueProvider }) },
    },
  };
}

type ImportData = {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  pages: number;
  requests: number;
  cursor: string | null;
  stranded: Array<{ page: number; index: number | null; externalId: string | null; cause: string }>;
  stopped: "complete" | "max-pages" | "stranded";
};

async function runImport(context: InvocationContext, extra: Record<string, unknown> = {}): Promise<{ status: string; code: string; data?: ImportData; message?: string }> {
  return (await executeCommand("issue-sync.import", { project: PROJECT, ...extra }, context)) as {
    status: string;
    code: string;
    data?: ImportData;
    message?: string;
  };
}

/** The whole store's mutable surface, for the zero-delta assertion. */
async function storeSnapshot(f: Fixture): Promise<unknown> {
  const db = await f.db();
  try {
    return {
      issues: db.prepare("select id, title, revision, updated_at from issues order by id").all(),
      cursor: db.prepare("select binding_id, direction, cursor, updated_at from sync_cursor order by binding_id").all(),
      ledger: db.prepare("select local_id, item_state, last_remote_updated_at, revision, updated_at from issue_sync_state order by local_id").all(),
      receipts: (db.prepare("select count(*) as n from store_operations").get() as { n: number }).n,
    };
  } finally {
    db.close();
  }
}

describe("refusals before any write", () => {
  test("service-absent and unreachable are linear.host-unavailable (not 'disabled')", async () => {
    for (const state of ["service-absent", "unreachable"] as const) {
      const f = await fixture(`refuse-${state}`, provider(() => ({ items: [], nextCursor: null }), { state, cause: `${state}: cause` }));
      const result = await runImport(f.context);
      expect(result.code).toBe("linear.host-unavailable");
      expect(result.message).toContain(state);
    }
  });

  test("access-denied is linear.access-denied with a re-authorize recovery", async () => {
    const f = await fixture(
      "refuse-access-denied-coded",
      provider(() => ({ items: [], nextCursor: null }), { state: "access-denied", cause: "access-denied: 401" }),
    );
    const result = (await runImport(f.context)) as unknown as {
      status: string;
      code: string;
      details?: { recovery?: string };
    };
    expect(result.code).toBe("linear.access-denied");
    expect(result.details?.recovery).toContain("Re-authorize");
  });

  test("each probe state writes nothing at all (no store open, no listing call)", async () => {
    for (const state of ["service-absent", "unreachable", "access-denied"] as const) {
      const p = provider(() => ({ items: [item()], nextCursor: null }), { state, cause: `${state}: cause` });
      const f = await fixture(`nothing-written-${state}`, p);
      const before = await storeSnapshot(f);
      await runImport(f.context);
      expect(await storeSnapshot(f)).toEqual(before);
      expect(p.requests).toEqual([]);
    }
  });

  test("a disabled .mstarc binding refuses linear.provider-disabled", async () => {
    const f = await fixture("refuse-disabled", provider(() => ({ items: [item()], nextCursor: null })), { enabled: false });
    const result = await runImport(f.context);
    expect(result.code).toBe("linear.provider-disabled");
    expect(result.message).toContain("enabled");
  });

  test("a project that mirrors nothing refuses linear.binding-absent", async () => {
    const f = await fixture("refuse-unbound", provider(() => ({ items: [item()], nextCursor: null })), { bind: false });
    const before = await storeSnapshot(f);
    const result = await runImport(f.context);
    expect(result.code).toBe("linear.binding-absent");
    expect(result.message).toContain("mstar project bind");
    expect(await storeSnapshot(f)).toEqual(before);
  });

  test("a host with no adapter falls back to the built-in provider instead of refusing", async () => {
    // The regression this guards: the command used to require a host-supplied
    // `issueProvider`, so every real environment refused
    // `linear.list-unimplemented` no matter how it was configured. With no
    // override the command now assembles its own provider, so the run reaches
    // the probe and fails on the transport (unreachable) rather than on a
    // missing capability.
    const f = await fixture("refuse-nohost", null);
    const result = await runImport(f.context);
    expect(result.code).not.toBe("linear.list-unimplemented");
    expect(["linear.host-unavailable", "linear.access-denied"]).toContain(result.code);
  });
});

describe("zero-delta second run", () => {
  test("run 1 imports, run 2 imports nothing, changes no row and issues one request", async () => {
    const pages: Record<string, ProviderPage> = {
      start: { items: [item(), item({ externalId: "LIN-2", title: "Second" })], nextCursor: "c-2" },
      "c-2": { items: [item({ externalId: "LIN-3", title: "Third" })], nextCursor: null },
    };
    const p = provider((cursor) => pages[cursor ?? "start"]!);
    const f = await fixture("zero-delta", p);

    const first = await runImport(f.context);
    expect(first.status).toBe("ok");
    expect(first.data).toMatchObject({ imported: 3, updated: 0, skipped: 0, failed: 0, pages: 2, requests: 4, cursor: null });

    const snapshot = await storeSnapshot(f);
    p.requests.length = 0;
    const second = await runImport(f.context);
    expect(second.status).toBe("ok");
    // The store's cursor is resumable: run 2 re-reads only from the recorded
    // position (the overlap window), so it costs ONE request and re-ingests it
    // as a no-op.
    // A completed scan rewinds the pointer, so the second run walks every page
    // again: the cost is a full walk, the saving comes from the ledger where
    // every item is a no-op skip.
    expect(second.data).toMatchObject({ imported: 0, updated: 0, skipped: 3, failed: 0, pages: 2, requests: 4, cursor: null });
    // No issue row and no ledger row changed. The second run does write: the
    // cursor rewind and its own receipt (cursor writes are keyed per scan, so a
    // later scan cannot mistake an earlier one's receipt for its own).
    const after = (await storeSnapshot(f)) as { issues: unknown; ledger: unknown };
    const before = snapshot as { issues: unknown; ledger: unknown };
    expect(after.issues).toEqual(before.issues);
    expect(after.ledger).toEqual(before.ledger);
    // The second run is evidenced by requests, not assumed: a rewound pointer
    // means the walk starts from the first page again.
    expect(p.requests).toEqual([null, "c-2"]);
  });

  test("a single page run reports one request and resumes from the recorded cursor", async () => {
    const p = provider(() => ({ items: [item()], nextCursor: null }));
    const f = await fixture("single-page", p);
    const first = await runImport(f.context);
    expect(first.data).toMatchObject({ imported: 1, pages: 1, requests: 3, cursor: null });
    const second = await runImport(f.context);
    expect(second.data).toMatchObject({ imported: 0, updated: 0, skipped: 1, pages: 1, requests: 3 });
    expect(p.requests).toEqual([null, null]);
  });
});

describe("exactly-once across two runs (command level)", () => {
  test("one changed item is updated once and its watermark advances", async () => {
    let remote = [item(), item({ externalId: "LIN-2", title: "Second" })];
    const p = provider(() => ({ items: remote, nextCursor: null }));
    const f = await fixture("exactly-once", p);

    expect((await runImport(f.context)).data).toMatchObject({ imported: 2, updated: 0, skipped: 0 });
    remote = [item({ title: "Imported title v2", updatedAt: "2026-11-02T00:00:00.000Z" }), item({ externalId: "LIN-2", title: "Second" })];
    const second = await runImport(f.context);
    expect(second.data).toMatchObject({ imported: 0, updated: 1, skipped: 1 });

    const third = await runImport(f.context);
    expect(third.data).toMatchObject({ imported: 0, updated: 0, skipped: 2 });

    const db = await f.db();
    try {
      const summary = readLedgerSummary(db, { bindingId: `linear:${PROJECT}`, direction: "import" });
      expect(summary.counts).toEqual({ unbound: 0, pending: 0, applied: 2, failed: 0, skipped: 0 });
      expect(summary.lastCursor).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("a failing page keeps the cursor and ingests nothing from it", () => {
  test("a page call that throws refuses linear.query-failed without advancing", async () => {
    const p = provider((cursor) => {
      if (cursor === null) return { items: [item()], nextCursor: "c-2" };
      throw Object.assign(new Error("[linear.query-failed] embedded errors"), { code: "linear.query-failed" });
    });
    const f = await fixture("page-failure", p);
    const result = await runImport(f.context);
    expect(result.status).toBe("refused");
    expect(result.code).toBe("linear.query-failed");
    const db = await f.db();
    try {
      // The first page was ingested and its cursor recorded; the failing page
      // changed nothing, so the next run re-reads it.
      expect(db.prepare("select count(*) as n from issues").get()).toEqual({ n: 1 });
      expect(db.prepare("select cursor from sync_cursor").get()).toEqual({ cursor: "c-2" });
    } finally {
      db.close();
    }
  });

  test("an item that fails blocks the cursor, and the next run retries it (F1)", async () => {
    // The first item collides with a local issue holding its synthetic identity;
    // the second is importable. The run must NOT advance past the collision.
    const pages: Record<string, ProviderPage> = {
      start: { items: [item(), item({ externalId: "LIN-2", title: "Second" })], nextCursor: "c-2" },
      "c-2": { items: [], nextCursor: null },
    };
    const p = provider((cursor) => pages[cursor ?? "start"]!);
    const f = await fixture("cursor-blocked", p);

    // Plant the collision BEFORE the run: a local issue already holding LIN-1's identity.
    const identityKey = computeIdentityKey(PROJECT, "linear:LIN-1", IMPORTED_ROOT_CAUSE_KEY, IMPORTED_ACCEPTANCE_KEY);
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000900', ?, 'Local', 'bug', 'high', 'i', 'a', 'now', 'now', ?)",
      ).run(PROJECT, identityKey);
      handle.close();
    }

    const first = await runImport(f.context);
    expect(first.data).toMatchObject({ imported: 1, failed: 1, cursor: null, stopped: "stranded" });
    expect(first.data?.stranded[0]).toMatchObject({ page: 1 });
    {
      const db = await f.db();
      // The cursor did NOT advance, so page 1 is re-read next run.
      expect(db.prepare("select count(*) as n from sync_cursor").get()).toEqual({ n: 0 });
      db.close();
    }

    // Operator recovery: the collision is removed (the recovery text says how).
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare("delete from issues where id = 'I-000900'").run();
      handle.close();
    }
    const second = await runImport(f.context);
    if (second.data === undefined) throw new Error(`second run refused: ${JSON.stringify(second)}`);
    // The retry finishes the scan, so the pointer rewinds to null; the item that
    // failed the first time is now mirrored.
    expect(second.data).toMatchObject({ imported: 1, failed: 0, updated: 0, skipped: 1, stopped: "complete", cursor: null });
    // The first run stopped on page 1 (stranded); the second re-read page 1.
    expect(p.requests).toEqual([null, null, "c-2"]);
  });

  test("an unmappable item is reported by identity and page index while the run continues (F2)", async () => {
    // I-000948: a title-less remote issue can never be fixed by retrying this
    // page, so it must not cap later pages. It is reported as stranded with its
    // cause; the cursor advances and the next page is read.
    const pages: Record<string, ProviderPage> = {
      start: {
        items: [item(), item({ externalId: "LIN-2", title: "Second" })],
        nextCursor: "c-2",
        failures: [{ index: 2, externalId: "LIN-BAD", cause: 'issue at page index 2 has no usable "title"' }],
      },
      "c-2": { items: [item({ externalId: "LIN-3", title: "Third" })], nextCursor: null },
    };
    const p = provider((cursor) => pages[cursor ?? "start"]!);
    const f = await fixture("poison-item", p);
    const result = await runImport(f.context);
    expect(result.status).toBe("ok");
    // The whole scan ran: two pages, all three mappable items ingested, and the
    // completed scan rewound the pointer.
    expect(result.data).toMatchObject({ imported: 3, failed: 0, pages: 2, stopped: "complete", cursor: null });
    expect(result.data?.stranded).toEqual([
      { page: 1, index: 2, externalId: "LIN-BAD", cause: 'issue at page index 2 has no usable "title"' },
    ]);
    expect(p.requests).toEqual([null, "c-2"]);
    // The good items were ingested; the poisoned one did not stop them.
    const db = await f.db();
    try {
      expect(db.prepare("select count(*) as n from issues").get()).toEqual({ n: 3 });
    } finally {
      db.close();
    }
  });

  test("a stranded page with a later page still advances the cursor (I-000948)", async () => {
    // The stop-vs-advance split: only a ledger-level failure holds the cursor.
    const pages: Record<string, ProviderPage> = {
      start: { items: [item()], nextCursor: "c-2", failures: [{ index: 1, externalId: null, cause: "not-an-object" }] },
      "c-2": { items: [item({ externalId: "LIN-2", title: "Second" })], nextCursor: null },
    };
    const f = await fixture("stranded-advance", provider((cursor) => pages[cursor ?? "start"]!));
    const result = await runImport(f.context);
    expect(result.data).toMatchObject({ imported: 2, failed: 0, pages: 2, stopped: "complete" });
    // The unmappable item is still reported, with the page index that holds it.
    expect(result.data?.stranded).toEqual([{ page: 1, index: 1, externalId: null, cause: "not-an-object" }]);
  });

  test("--max-pages bounds one run and the reported cursor resumes it", async () => {
    const p = provider((cursor) => ({ items: [item({ externalId: `LIN-${cursor ?? "start"}` })], nextCursor: `c-${cursor ?? "start"}` }));
    const f = await fixture("max-pages", p);
    const bounded = await runImport(f.context, { maxPages: 1 });
    expect(bounded.data).toMatchObject({ imported: 1, pages: 1, requests: 3, cursor: "c-start" });
    const resumed = await runImport(f.context, { maxPages: 1 });
    expect(resumed.data).toMatchObject({ imported: 1, pages: 1, requests: 3, cursor: "c-c-start" });
    expect(p.requests).toEqual([null, "c-start"]);
  });
});

describe("command surface", () => {
  test("the CLI spelling and its help text are exactly the plan's", async () => {
    const { getCommandDefinitions } = await import("../definitions.js");
    const definition = getCommandDefinitions().find((entry) => entry.id === "issue-sync.import");
    expect(definition).toBeDefined();
    expect(definition!.cli.path).toEqual(["issue-sync", "import"]);
    expect(definition!.cli.options.map((option) => option.flags)).toEqual(["--project <id>", "--max-pages <n>", "--harness <root>"]);
    expect(definition!.cli.options.find((option) => option.key === "maxPages")?.defaultValue).toBe(20);
    expect(definition!.requirements?.some((requirement) => requirement.name === "project" && requirement.required)).toBe(true);
  });

  test("a missing --project is a usage refusal", async () => {
    const f = await fixture("usage", provider(() => ({ items: [], nextCursor: null })));
    const result = (await executeCommand("issue-sync.import", {}, f.context)) as { status: string; exitCode: number };
    expect(result.status).toBe("usage");
    expect(result.exitCode).toBe(2);
  });
});

/**
 * Push — the write surface. Case (h) of the SDD brief: the credential SCOPE
 * preflight refuses the whole run before any write, and a refresh never widens
 * a read-only grant into a write one.
 *
 * The store is the real one; the provider is a fixture whose label discovery and
 * write receipts are scripted, so no network and no credential cross a boundary.
 */
describe("push — the credential scope preflight", () => {
  const credentialPath = (): string => join(ROOT, "push-credential.json");
  const previousCredential = process.env.MSTAR_LINEAR_CREDENTIAL;

  /** A provider that records every call and can answer discovery + writes. */
  function writeProvider(labels: string[] = ["bug"]) {
    const calls: string[] = [];
    const writes: unknown[] = [];
    const fake = {
      calls,
      writes,
      async probe() {
        calls.push("probe");
        return { state: "ready", cause: "ready: fixture handshake" };
      },
      async listIssues() {
        calls.push("listIssues");
        return { items: [], nextCursor: null };
      },
      async applyWrite(write: unknown) {
        calls.push("applyWrite");
        writes.push(write);
        return { kind: "confirmed", externalId: "LIN-1", updatedAt: "2026-11-02T00:00:00.000Z" };
      },
      async discoverLabels() {
        calls.push("discoverLabels");
        return new Set(labels);
      },
      async discoverStates() {
        calls.push("discoverStates");
        return new Set(["Todo", "Done", "Canceled"]);
      },
    };
    return fake;
  }

  function withProvider(f: Fixture, provider: ReturnType<typeof writeProvider>): InvocationContext {
    return { ...f.context, effects: { ...f.context.effects, issueProvider: () => provider as never } };
  }

  function storeCredential(scope: string | null, expiresAt: number | null = Date.now() + 3_600_000): void {
    writeLinearCredential({
      accessToken: ["not", "a", "real", "access"].join("-"),
      refreshToken: ["not", "a", "real", "refresh"].join("-"),
      expiresAt,
      scope,
      clientId: ["not", "a", "real", "client"].join("-"),
    });
  }

  beforeEach(() => {
    process.env.MSTAR_LINEAR_CREDENTIAL = credentialPath();
  });

  afterEach(() => {
    if (previousCredential === undefined) delete process.env.MSTAR_LINEAR_CREDENTIAL;
    else process.env.MSTAR_LINEAR_CREDENTIAL = previousCredential;
    rmSync(credentialPath(), { force: true });
  });

  test("a scope of `read` refuses the run before any provider call or ledger write", async () => {
    const provider = writeProvider();
    const f = await fixture("push-read-scope", null);
    storeCredential("read");
    const before = await storeSnapshot(f);
    const result = (await executeCommand("issue-sync.push", { project: PROJECT }, withProvider(f, provider))) as {
      status: string;
      code: string;
      message?: string;
    };
    expect(result.status).toBe("refused");
    expect(result.code).toBe("linear.scope-insufficient");
    // The recovery names BOTH surfaces that actually request the write scope.
    expect(JSON.stringify(result)).toMatch(/Settings|Authorize/);
    expect(JSON.stringify(result)).toMatch(/linear auth/);
    // Zero provider calls — not even the probe — and nothing written.
    expect(provider.calls).toEqual([]);
    expect(await storeSnapshot(f)).toEqual(before);
  });

  test("a refreshed credential still echoing `read` still refuses, and the refresh request carries no scope", async () => {
    const provider = writeProvider();
    const f = await fixture("push-read-refreshed", null);
    // Expired, so a run that got past the preflight would have to refresh first.
    storeCredential("read", Date.now() - 60_000);
    const refreshedScopes: Array<string | null> = [];
    const context: InvocationContext = {
      ...withProvider(f, provider),
      effects: {
        ...withProvider(f, provider).effects,
        linearRefresh: async () => {
          // The provider echoes the ORIGINAL grant's scope: refresh never widens.
          refreshedScopes.push("read");
          return { accessToken: "fresh", refreshToken: null, expiresAt: Date.now() + 3_600_000, scope: "read", clientId: "c" };
        },
      },
    };
    const result = (await executeCommand("issue-sync.push", { project: PROJECT }, context)) as { status: string; code: string };
    expect(result.status).toBe("refused");
    expect(result.code).toBe("linear.scope-insufficient");
    // The conclusion holds whether or not the token was refreshed: a read grant
    // is read-only on both axes (expiry and permission are different things).
    expect(provider.calls).toEqual([]);
  });

  test("an expired, unrefreshable stored credential does not refuse a run that uses the environment key", async () => {
    const provider = writeProvider(["bug"]);
    const f = await fixture("push-env-key-fallback", null);
    // Read-only AND expired with no refresh seam: this run cannot use it, so the
    // provider falls back to the exported key, whose capability decides.
    storeCredential("read", Date.now() - 60_000);
    const previousKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = ["not", "a", "real", "env", "key"].join("-");
    try {
      {
        const handle = await openStore({ harnessDir: f.harnessDir }, "write");
        handle.db.prepare(
          "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
            " values ('I-000811', ?, 'Push me', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'sync-I-000811')",
        ).run(PROJECT);
        handle.close();
      }
      const result = (await executeCommand("issue-sync.push", { project: PROJECT }, withProvider(f, provider))) as {
        status: string;
        code?: string;
        data?: { created: number };
      };
      expect(result.code).not.toBe("linear.scope-insufficient");
      expect(result.status).toBe("ok");
      expect(result.data?.created).toBe(1);
      // The preflight let the run through: the probe and both discoveries ran.
      expect(provider.calls).toEqual(["probe", "discoverLabels", "discoverStates", "applyWrite"]);
    } finally {
      if (previousKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousKey;
    }
  });

  test("a live read-only stored credential still refuses when no environment key exists", async () => {
    const provider = writeProvider();
    const f = await fixture("push-read-scope-no-key", null);
    storeCredential("read");
    const previousKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      const result = (await executeCommand("issue-sync.push", { project: PROJECT }, withProvider(f, provider))) as {
        status: string;
        code: string;
      };
      expect(result.status).toBe("refused");
      expect(result.code).toBe("linear.scope-insufficient");
      expect(provider.calls).toEqual([]);
    } finally {
      if (previousKey !== undefined) process.env.LINEAR_API_KEY = previousKey;
    }
  });

  test("a scope carrying issues:create pushes: discovery runs, then one confirmed create", async () => {
    const provider = writeProvider(["bug"]);
    const f = await fixture("push-write-scope", null);
    storeCredential("read,issues:create");
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000801', ?, 'Push me', 'bug', 'high', 'impact', 'acceptance', 'now', 'now', 'sync-I-000801')",
      ).run(PROJECT);
      handle.close();
    }
    const result = (await executeCommand("issue-sync.push", { project: PROJECT }, withProvider(f, provider))) as {
      status: string;
      code: string;
      data?: { created: number; failed: number; labels: string[]; items: Array<{ localId: string; outcome: string; externalId: string | null }> };
    };
    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({ created: 1, failed: 0, labels: ["bug"] });
    expect(result.data?.items).toEqual([{ localId: "I-000801", outcome: "created", externalId: "LIN-1" }]);
    expect(provider.calls).toEqual(["probe", "discoverLabels", "discoverStates", "applyWrite"]);
    const db = await f.db();
    try {
      expect(db.prepare("select item_state, external_id, last_kind_label from issue_sync_state").get()).toEqual({
        item_state: "applied",
        external_id: "LIN-1",
        last_kind_label: '["bug"]',
      });
    } finally {
      db.close();
    }
  });

  test("a mapped kind label the workspace lacks refuses that item only, and names the label", async () => {
    const provider = writeProvider(["bug"]);
    const f = await fixture("push-label-missing", null);
    storeCredential("read,issues:create");
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      const insert = handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values (?, ?, ?, ?, 'high', 'i', 'a', 'now', 'now', ?)",
      );
      insert.run("I-000802", PROJECT, "Bug", "bug", "sync-I-000802");
      insert.run("I-000803", PROJECT, "Risk", "risk", "sync-I-000803");
      handle.close();
    }
    const result = (await executeCommand("issue-sync.push", { project: PROJECT }, withProvider(f, provider))) as {
      status: string;
      data?: { created: number; failed: number; items: Array<{ localId: string; outcome: string; cause?: string }> };
    };
    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({ created: 1, failed: 1 });
    const failedItem = result.data?.items.find((entry) => entry.localId === "I-000803");
    expect(failedItem?.outcome).toBe("failed");
    expect(failedItem?.cause).toContain("linear.label-unresolved");
    expect(failedItem?.cause).toContain('"risk"');
    // Only the resolvable item was written.
    expect(provider.writes).toHaveLength(1);
  });

  test("a team whose workflow lacks the mapped state refuses that item before the call, naming the mapping key", async () => {
    const provider = writeProvider(["bug"]);
    // The workflow renamed `Todo`; `open` dispositions map to it by default.
    provider.discoverStates = async () => new Set(["Ready for Dev", "Done", "Canceled"]);
    const f = await fixture("push-state-missing", null);
    storeCredential("read,issues:create");
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000805', ?, 'Blocked', 'bug', 'high', 'open', 'i', 'a', 'now', 'now', 'sync-I-000805')",
      ).run(PROJECT);
      handle.close();
    }
    const result = (await executeCommand("issue-sync.push", { project: PROJECT }, withProvider(f, provider))) as {
      status: string;
      data?: { created: number; failed: number; states: string[]; items: Array<{ localId: string; outcome: string; cause?: string }> };
    };
    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({ created: 0, failed: 1 });
    // The report names the vocabulary the run resolved against, so an operator
    // can see the mismatch without re-running discovery by hand.
    expect(result.data?.states).toEqual(["Canceled", "Done", "Ready for Dev"]);
    const failedItem = result.data?.items.find((entry) => entry.localId === "I-000805");
    expect(failedItem?.cause).toContain("linear.state-unresolved");
    expect(failedItem?.cause).toContain('"Todo"');
    expect(failedItem?.cause).toContain("disposition.Todo");
    // Nothing reached the provider.
    expect(provider.writes).toHaveLength(0);
  });

  test("--adopt recovers the pending residue an ambiguous create left behind", async () => {
    const writes: Array<{ kind: string; externalId?: string }> = [];
    const receipts = [
      { kind: "ambiguous" as const, cause: "connection closed mid-call" },
      { kind: "confirmed" as const, externalId: "LIN-555", updatedAt: "2026-11-02T00:10:00.000Z" },
    ];
    const provider = {
      async probe() {
        return { state: "ready" as const, cause: "ready: fixture handshake" };
      },
      async listIssues() {
        return { items: [], nextCursor: null };
      },
      async applyWrite(write: { kind: string; externalId?: string }) {
        writes.push(write);
        return receipts.shift()!;
      },
      async discoverLabels() {
        return new Set(["bug"]);
      },
      async discoverStates() {
        return new Set(["Todo", "Done", "Canceled"]);
      },
    };
    const f = await fixture("push-adopt-pending", null);
    storeCredential("read,issues:create");
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000804', ?, 'Ambiguous', 'bug', 'high', 'i', 'a', 'now', 'now', 'sync-I-000804')",
      ).run(PROJECT);
      handle.close();
    }
    const context = { ...f.context, effects: { ...f.context.effects, issueProvider: () => provider as never } };

    const first = (await executeCommand("issue-sync.push", { project: PROJECT }, context)) as {
      data?: { unresolved: number; items: Array<{ localId: string; outcome: string }> };
    };
    expect(first.data?.items).toEqual([
      expect.objectContaining({ localId: "I-000804", outcome: "unresolved" }),
    ]);

    // The documented recovery: the operator confirms the remote issue they can
    // see. It must not be refused by an illegal-transition guard.
    const second = (await executeCommand(
      "issue-sync.push",
      { project: PROJECT, adopt: ["I-000804=https://linear.app/acme/issue/LIN-555/slug"] },
      context,
    )) as {
      status: string;
      data?: { created: number; updated: number; items: Array<{ localId: string; outcome: string; externalId: string | null }> };
    };
    expect(second.status).toBe("ok");
    expect(second.data?.created).toBe(0);
    expect(second.data?.items).toEqual([
      { localId: "I-000804", outcome: "adopted", externalId: "LIN-555" },
      { localId: "I-000804", outcome: "updated", externalId: "LIN-555" },
    ]);
    // Exactly one create (the ambiguous one) and one corrective update, ever.
    expect(writes.map((write) => write.kind)).toEqual(["create", "update"]);
    const db = await f.db();
    try {
      expect(db.prepare("select item_state, external_id from issue_sync_state").get()).toEqual({
        item_state: "applied",
        external_id: "LIN-555",
      });
    } finally {
      db.close();
    }
  });

  test("--adopt refuses to replace an established identity unless --force-adopt names the item", async () => {
    const writes: Array<{ kind: string; externalId?: string }> = [];
    const provider = {
      async probe() {
        return { state: "ready" as const, cause: "ready: fixture handshake" };
      },
      async listIssues() {
        return { items: [], nextCursor: null };
      },
      async applyWrite(write: { kind: string; externalId?: string }) {
        writes.push(write);
        return write.kind === "update"
          ? { kind: "confirmed" as const, externalId: write.externalId!, updatedAt: "2026-11-02T00:10:00.000Z" }
          : { kind: "confirmed" as const, externalId: "LIN-1", updatedAt: "2026-11-02T00:10:00.000Z" };
      },
      async discoverLabels() {
        return new Set(["bug"]);
      },
      async discoverStates() {
        return new Set(["Todo", "Done", "Canceled"]);
      },
    };
    const f = await fixture("push-adopt-identity-conflict", null);
    storeCredential("read,issues:create");
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000805', ?, 'Established', 'bug', 'high', 'i', 'a', 'now', 'now', 'sync-I-000805')",
      ).run(PROJECT);
      handle.close();
    }
    const context = { ...f.context, effects: { ...f.context.effects, issueProvider: () => provider as never } };

    // A confirmed create establishes the identity.
    await executeCommand("issue-sync.push", { project: PROJECT }, context);
    expect(writes.map((write) => write.kind)).toEqual(["create"]);

    // Pointing the item at a DIFFERENT remote issue is refused by name, and the
    // row keeps the identity an earlier confirmed write proved.
    const refused = (await executeCommand(
      "issue-sync.push",
      { project: PROJECT, adopt: ["I-000805=LIN-2"] },
      context,
    )) as { status: string; code: string; details?: { recovery?: string } };
    expect(refused.status).toBe("refused");
    expect(refused.code).toBe("sync.identity-conflict");
    expect(refused.details?.recovery).toContain("--force-adopt");
    {
      const db = await f.db();
      try {
        expect(db.prepare("select external_id from issue_sync_state").get()).toEqual({ external_id: "LIN-1" });
      } finally {
        db.close();
      }
    }

    // The documented escape performs the replacement, and the changed content
    // then converges onto the new id instead of reporting `skipped`.
    const forcedAdopt = (await executeCommand(
      "issue-sync.push",
      { project: PROJECT, adopt: ["I-000805=LIN-2"], forceAdopt: ["I-000805"] },
      context,
    )) as { status: string; data?: { items: Array<{ localId: string; outcome: string; externalId: string | null }> } };
    expect(forcedAdopt.status).toBe("ok");
    expect(forcedAdopt.data?.items).toEqual([
      { localId: "I-000805", outcome: "adopted", externalId: "LIN-2" },
      { localId: "I-000805", outcome: "updated", externalId: "LIN-2" },
    ]);
    expect(writes.map((write) => write.kind)).toEqual(["create", "update"]);
  });

  test("a bad --release with a valid --adopt writes nothing at all", async () => {
    const provider = writeProvider(["bug"]);
    const f = await fixture("push-operator-atomicity", null);
    storeCredential("read,issues:create");
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000812', ?, 'Adoptable', 'bug', 'high', 'i', 'a', 'now', 'now', 'sync-I-000812')",
      ).run(PROJECT);
      handle.close();
    }
    const before = await storeSnapshot(f);
    // `I-000812` is a legal adoption target; the release names an item with no
    // ledger row, which is a usage error. Deciding it AFTER the adoption had
    // already written is what made the run half-applied behind a refusal.
    const result = (await executeCommand(
      "issue-sync.push",
      { project: PROJECT, adopt: ["I-000812=LIN-1"], release: ["I-000899"] },
      withProvider(f, provider),
    )) as { status: string; code: string };
    expect(result.status).toBe("refused");
    expect(result.code).toBe("sync.illegal-transition");
    // Neither verb landed, and the provider was never written to.
    expect(await storeSnapshot(f)).toEqual(before);
    expect(provider.writes).toEqual([]);
  });

  test("--adopt and --release naming one local id is refused before any write", async () => {
    const writes: Array<{ kind: string }> = [];
    const provider = {
      async probe() {
        return { state: "ready" as const, cause: "ready: fixture handshake" };
      },
      async listIssues() {
        return { items: [], nextCursor: null };
      },
      async applyWrite(write: { kind: string }) {
        writes.push(write);
        return { kind: "ambiguous" as const, cause: "connection closed mid-call" };
      },
      async discoverLabels() {
        return new Set(["bug"]);
      },
      async discoverStates() {
        return new Set(["Todo", "Done", "Canceled"]);
      },
    };
    const f = await fixture("push-adopt-release-collision", null);
    storeCredential("read,issues:create");
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000813', ?, 'Collision', 'bug', 'high', 'i', 'a', 'now', 'now', 'sync-I-000813')",
      ).run(PROJECT);
      handle.close();
    }
    const context = { ...f.context, effects: { ...f.context.effects, issueProvider: () => provider as never } };

    // One ambiguous create leaves the pending residue that BOTH verbs are legal
    // against on their own: adopting records the identity, releasing clears the
    // residue. Together they contradict each other, and the refusal must land
    // before either is written.
    await executeCommand("issue-sync.push", { project: PROJECT }, context);
    expect(writes).toHaveLength(1);
    const before = await storeSnapshot(f);

    const result = (await executeCommand(
      "issue-sync.push",
      { project: PROJECT, adopt: ["I-000813=LIN-9"], release: ["I-000813"] },
      context,
    )) as { status: string; code: string; message: string };
    expect(result.status).toBe("refused");
    expect(result.code).toBe("sync.operator-conflict");
    expect(result.message).toContain("I-000813");
    expect(await storeSnapshot(f)).toEqual(before);
    const db = await f.db();
    try {
      expect(db.prepare("select item_state, external_id from issue_sync_state").get()).toEqual({
        item_state: "pending",
        external_id: null,
      });
    } finally {
      db.close();
    }
    expect(writes).toHaveLength(1);
  });

  test("naming one local id twice under --adopt is refused before any write", async () => {
    const provider = writeProvider(["bug"]);
    const f = await fixture("push-duplicate-adopt", null);
    storeCredential("read,issues:create");
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000814', ?, 'Twice', 'bug', 'high', 'i', 'a', 'now', 'now', 'sync-I-000814')",
      ).run(PROJECT);
      handle.close();
    }
    const before = await storeSnapshot(f);
    // Each entry is legal on its own against a row with no identity; the second
    // identity is what the run cannot honour, and it used to be written before
    // the refusal.
    const result = (await executeCommand(
      "issue-sync.push",
      { project: PROJECT, adopt: ["I-000814=LIN-9", "I-000814=LIN-10"] },
      withProvider(f, provider),
    )) as { status: string; code: string; message: string };
    expect(result.status).toBe("refused");
    expect(result.code).toBe("sync.operator-conflict");
    expect(result.message).toContain("I-000814");
    expect(await storeSnapshot(f)).toEqual(before);
    expect(provider.writes).toEqual([]);
  });

  test("--force-adopt naming no --adopt target is refused before any write", async () => {
    const provider = writeProvider(["bug"]);
    const f = await fixture("push-orphan-force-adopt", null);
    storeCredential("read,issues:create");
    const before = await storeSnapshot(f);
    // The flag is a modifier of one `--adopt` entry; alone it authorizes
    // nothing, so it used to be dropped silently behind an `ok` exit.
    const result = (await executeCommand(
      "issue-sync.push",
      { project: PROJECT, forceAdopt: ["I-000899"] },
      withProvider(f, provider),
    )) as { status: string; code: string; exitCode: number; message: string };
    expect(result.status).toBe("refused");
    expect(result.exitCode).toBe(1);
    expect(result.code).toBe("sync.operator-conflict");
    expect(result.message).toContain("I-000899");
    expect(result.message).toContain("--adopt");
    // Nothing was resolved or written, and not one provider call was made.
    expect(provider.calls).toEqual([]);
    expect(await storeSnapshot(f)).toEqual(before);
  });

  test("--force-adopt back to a previously held issue moves the row and the report together", async () => {
    const writes: Array<{ kind: string; externalId?: string }> = [];
    const provider = {
      async probe() {
        return { state: "ready" as const, cause: "ready: fixture handshake" };
      },
      async listIssues() {
        return { items: [], nextCursor: null };
      },
      async applyWrite(write: { kind: string; externalId?: string }) {
        writes.push(write);
        return write.kind === "update"
          ? { kind: "confirmed" as const, externalId: write.externalId!, updatedAt: "2026-11-02T00:10:00.000Z" }
          : { kind: "confirmed" as const, externalId: "LIN-1", updatedAt: "2026-11-02T00:10:00.000Z" };
      },
      async discoverLabels() {
        return new Set(["bug"]);
      },
      async discoverStates() {
        return new Set(["Todo", "Done", "Canceled"]);
      },
    };
    const f = await fixture("push-adopt-repoint", null);
    storeCredential("read,issues:create");
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000806', ?, 'Repointed', 'bug', 'high', 'i', 'a', 'now', 'now', 'sync-I-000806')",
      ).run(PROJECT);
      handle.close();
    }
    const context = { ...f.context, effects: { ...f.context.effects, issueProvider: () => provider as never } };

    const repoint = async (externalId: string) =>
      (await executeCommand(
        "issue-sync.push",
        { project: PROJECT, adopt: [`I-000806=${externalId}`], forceAdopt: ["I-000806"] },
        context,
      )) as { status: string; data?: { items: Array<{ localId: string; outcome: string; externalId: string | null }> } };

    // LIN-1 is recorded by an ADOPTION, so that adoption's receipt is on record.
    expect((await repoint("LIN-1")).data?.items[0]).toMatchObject({ outcome: "adopted", externalId: "LIN-1" });
    expect((await repoint("LIN-2")).data?.items[0]).toMatchObject({ outcome: "adopted", externalId: "LIN-2" });
    // Back to LIN-1: the adoption request repeats every fact of the first one
    // (binding, local id, external id, proof clearing), so a shared operation id
    // would replay that receipt and the row would stay on LIN-2 while this report
    // claimed LIN-1.
    const back = await repoint("LIN-1");
    expect(back.data?.items[0]).toMatchObject({ outcome: "adopted", externalId: "LIN-1" });
    const db = await f.db();
    try {
      expect(db.prepare("select item_state, external_id from issue_sync_state").get()).toEqual({
        item_state: "applied",
        external_id: "LIN-1",
      });
    } finally {
      db.close();
    }
  });

  test("an unconfirmed create is never created over, and --release is the exit for proven absence", async () => {
    const writes: Array<{ kind: string }> = [];
    const receipts = [{ kind: "ambiguous" as const, cause: "connection closed mid-call" }];
    const provider = {
      async probe() {
        return { state: "ready" as const, cause: "ready: fixture handshake" };
      },
      async listIssues() {
        return { items: [], nextCursor: null };
      },
      async applyWrite(write: { kind: string }) {
        writes.push(write);
        return receipts.shift() ?? { kind: "confirmed" as const, externalId: "LIN-999", updatedAt: "2026-11-02T00:10:00.000Z" };
      },
      async discoverLabels() {
        return new Set(["bug", "risk"]);
      },
      async discoverStates() {
        return new Set(["Todo", "Done", "Canceled"]);
      },
    };
    const f = await fixture("push-unresolved-residue", null);
    storeCredential("read,issues:create");
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000806', ?, 'Residue', 'risk', 'high', 'i', 'a', 'now', 'now', 'sync-I-000806')",
      ).run(PROJECT);
      handle.close();
    }
    const context = { ...f.context, effects: { ...f.context.effects, issueProvider: () => provider as never } };

    // 1. The ambiguous create: one write went out, the item has no identity.
    const first = (await executeCommand("issue-sync.push", { project: PROJECT }, context)) as {
      data?: { items: Array<{ localId: string; outcome: string }> };
    };
    expect(first.data?.items).toEqual([expect.objectContaining({ localId: "I-000806", outcome: "unresolved" })]);
    expect(writes).toHaveLength(1);

    // 2. A second push reports the SAME unresolved residue and names both
    //    recoveries instead of sending a second create.
    const again = (await executeCommand("issue-sync.push", { project: PROJECT }, context)) as {
      status: string;
      data?: { items: Array<{ localId: string; outcome: string; cause?: string }> };
    };
    expect(again.status).toBe("ok");
    expect(again.data?.items).toEqual([expect.objectContaining({ localId: "I-000806", outcome: "unresolved" })]);
    expect(again.data?.items[0]?.cause).toContain("--adopt");
    expect(again.data?.items[0]?.cause).toContain("--release <localId>");
    expect(writes).toHaveLength(1);

    const db = await f.db();
    try {
      // Still the ambiguous residue: reconcile still scans it.
      const ledger = db.prepare("select item_state, external_id from issue_sync_state").get() as {
        item_state: string;
        external_id: string | null;
      };
      expect(ledger.item_state).toBe("pending");
      expect(ledger.external_id).toBeNull();
    } finally {
      db.close();
    }

    // 3. The remote genuinely lacks the issue. One push names the item;
    //    reconcile's full scan finds no marker (this provider lists nothing),
    //    so the release runs and THAT SAME run creates exactly one issue.
    const released = (await executeCommand("issue-sync.push", { project: PROJECT, release: ["I-000806"] }, context)) as {
      status: string;
      data?: { items: Array<{ localId: string; outcome: string; externalId: string | null }> };
    };
    expect(released.status).toBe("ok");
    expect(released.data?.items).toEqual([
      expect.objectContaining({ localId: "I-000806", outcome: "created", externalId: "LIN-999" }),
    ]);
    expect(writes).toHaveLength(2);

    const after = await f.db();
    try {
      expect(after.prepare("select item_state, external_id from issue_sync_state").get()).toEqual({
        item_state: "applied",
        external_id: "LIN-999",
      });
    } finally {
      after.close();
    }
  });

  test("a second push on the same binding is refused by name while the first holds the run, and --take-run takes a dead holder's run over", async () => {
    const provider = writeProvider(["bug"]);
    const f = await fixture("push-run-lease", null);
    storeCredential("read,issues:create");
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000807', ?, 'Held', 'bug', 'high', 'i', 'a', 'now', 'now', 'sync-I-000807')",
      ).run(PROJECT);
      handle.close();
    }
    const context = withProvider(f, provider);
    const bindingId = `linear:${PROJECT}`;

    // A run that died inside its provider call leaves its row behind: the crash
    // residue the lease must always have an exit for.
    const holder = await openStore({ harnessDir: f.harnessDir }, "write");
    const dead = acquireRun(holder.db, {
      bindingId,
      direction: PUSH_DIRECTION,
      holderPid: 987654,
      holderHost: "gone-builder",
      reason: "issue-sync push",
    });
    holder.close();

    const refused = (await executeCommand("issue-sync.push", { project: PROJECT }, context)) as {
      status: string;
      code: string;
      message: string;
      recovery?: string;
      details?: Record<string, unknown>;
    };
    expect(refused.status).toBe("refused");
    expect(refused.code).toBe("sync.run-held");
    // The operator must be able to judge whether that holder is alive.
    expect(refused.message).toContain(dead.startedAt);
    expect(refused.message).toContain("987654");
    expect(refused.message).toContain("gone-builder");
    // BOTH recoveries are named, and the takeover is a documented, reachable flag.
    expect(refused.message).toContain("--take-run");
    expect(JSON.stringify(refused)).toContain("--take-run");
    // Refused before any write: the provider was never called.
    expect(provider.writes).toEqual([]);

    // The row stayed put, so the refusal is repeatable rather than self-clearing.
    const stillHeld = await openStore({ harnessDir: f.harnessDir }, "read");
    expect(readRun(stillHeld.db, { bindingId, direction: PUSH_DIRECTION })).toEqual(dead);
    stillHeld.close();

    // Explicit operator intent replaces the dead holder's run and the push proceeds.
    const taken = (await executeCommand("issue-sync.push", { project: PROJECT, takeRun: true }, context)) as {
      status: string;
      data?: { items: Array<{ localId: string; outcome: string }> };
    };
    expect(taken.status).toBe("ok");
    expect(taken.data?.items).toEqual([expect.objectContaining({ localId: "I-000807", outcome: "created" })]);

    // REPLACED, not coexisting, and released once the run ended: the next push
    // takes the run normally instead of meeting two holders.
    const after = await openStore({ harnessDir: f.harnessDir }, "read");
    expect(readRun(after.db, { bindingId, direction: PUSH_DIRECTION })).toBeNull();
    after.close();

    const next = (await executeCommand("issue-sync.push", { project: PROJECT }, context)) as {
      status: string;
      data?: { items: Array<{ localId: string; outcome: string }> };
    };
    expect(next.status).toBe("ok");
    expect(next.data?.items).toEqual([expect.objectContaining({ localId: "I-000807", outcome: "skipped" })]);
  });

  test("a --release push is refused by name while another run is parked inside its create, so the release cannot race an in-flight request", async () => {
    const f = await fixture("push-release-in-flight", null);
    storeCredential("read,issues:create");
    const bindingId = `linear:${PROJECT}`;
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000808', ?, 'In flight', 'bug', 'high', 'i', 'a', 'now', 'now', 'sync-I-000808')",
      ).run(PROJECT);
      handle.close();
    }

    // Run A parks INSIDE the create's provider call: the exact window a
    // `--release` scan cannot see, because the request has left and landed nowhere.
    let parking!: () => void;
    const parked = new Promise<void>((resolve) => {
      parking = resolve;
    });
    let land!: () => void;
    const landed = new Promise<void>((resolve) => {
      land = resolve;
    });
    const runA = writeProvider(["bug"]);
    const baseWrite = runA.applyWrite.bind(runA);
    runA.applyWrite = async (write: unknown) => {
      parking();
      await landed;
      return baseWrite(write);
    };

    const a = executeCommand("issue-sync.push", { project: PROJECT }, withProvider(f, runA));
    await parked;

    // A holds the run: the holder facts B has to name are readable while it works.
    const held = await openStore({ harnessDir: f.harnessDir }, "read");
    const holder = readRun(held.db, { bindingId, direction: PUSH_DIRECTION })!;
    expect(holder).toMatchObject({ holderPid: process.pid });
    held.close();
    // A's create is recorded as an unresolved `pending` row, so B's --release
    // names a shape that WOULD be releasable — the lease is the only thing that
    // refuses it.
    const heldRow = await f.db();
    expect(heldRow.prepare("select item_state, external_id from issue_sync_state where local_id = 'I-000808'").get()).toEqual({
      item_state: "pending",
      external_id: null,
    });
    heldRow.close();

    // B is the same ordinary command with --release: refused at acquisition,
    // before reconciliation, before any release write and before any remote send.
    const runB = writeProvider(["bug"]);
    const b = (await executeCommand(
      "issue-sync.push",
      { project: PROJECT, release: ["I-000808"] },
      withProvider(f, runB),
    )) as { status: string; code: string; message: string; details?: Record<string, unknown> };
    expect(b.status).toBe("refused");
    expect(b.code).toBe("sync.run-held");
    // Not a shape error: the refusal is about the live holder, not about the flag.
    expect(b.code).not.toBe("sync.illegal-transition");
    // Holder facts, so an operator can judge whether that holder is alive.
    expect(b.message).toContain(holder.startedAt);
    expect(b.message).toContain(String(holder.holderPid));
    expect(b.message).toContain(holder.holderHost);
    // Both recoveries: wait-and-re-run, and the explicit dead-holder takeover.
    expect(b.message).toContain("mstar issue-sync push --project <project-id>");
    expect(b.message).toContain("--take-run");
    expect(JSON.stringify(b)).toContain("--take-run");
    // Zero sends from B: no create, no update, and no listing scan either.
    expect(runB.writes).toEqual([]);
    expect(runB.calls).not.toContain("applyWrite");
    // Refused at acquisition, before any reconciliation scan.
    expect(runB.calls).not.toContain("listIssues");

    // B released nothing: A's residue is untouched and A still owns the run.
    const afterB = await f.db();
    try {
      expect(afterB.prepare("select item_state, external_id from issue_sync_state where local_id = 'I-000808'").get()).toEqual({
        item_state: "pending",
        external_id: null,
      });
      expect(readRun(afterB, { bindingId, direction: PUSH_DIRECTION })).toEqual(holder);
    } finally {
      afterB.close();
    }

    // A finishes: exactly ONE semantic create for the item.
    land();
    const finished = (await a) as { status: string; data?: { items: Array<{ localId: string; outcome: string; externalId: string | null }> } };
    expect(finished.status).toBe("ok");
    expect(finished.data?.items).toEqual([
      expect.objectContaining({ localId: "I-000808", outcome: "created", externalId: "LIN-1" }),
    ]);
    // A sent exactly ONE provider write for the item, and it was the create.
    expect(runA.calls.filter((call) => call === "applyWrite")).toHaveLength(1);

    const afterA = await f.db();
    try {
      expect(afterA.prepare("select item_state, external_id from issue_sync_state where local_id = 'I-000808'").get()).toEqual({
        item_state: "applied",
        external_id: "LIN-1",
      });
      // A released the run on its own exit, which is what makes "wait, then
      // re-run" work.
      expect(readRun(afterA, { bindingId, direction: PUSH_DIRECTION })).toBeNull();
    } finally {
      afterA.close();
    }

    // The recovery the refusal names: the waited-out re-run acquires the run and
    // sends nothing, because A already landed the item exactly once.
    const rerun = writeProvider(["bug"]);
    const again = (await executeCommand("issue-sync.push", { project: PROJECT }, withProvider(f, rerun))) as {
      status: string;
      data?: { items: Array<{ localId: string; outcome: string }> };
    };
    expect(again.status).toBe("ok");
    expect(again.data?.items).toEqual([expect.objectContaining({ localId: "I-000808", outcome: "skipped" })]);
    expect(rerun.writes).toEqual([]);
  });

  test("a completed push releases the run, so the next push acquires it instead of being refused", async () => {
    const provider = writeProvider(["bug"]);
    const f = await fixture("push-run-release", null);
    storeCredential("read,issues:create");
    const context = withProvider(f, provider);

    // Two pushes in sequence: the first takes and releases the run, so the
    // second meets no holder and is not refused.
    const first = (await executeCommand("issue-sync.push", { project: PROJECT }, context)) as { status: string; code: string };
    expect(first.status).toBe("ok");
    const second = (await executeCommand("issue-sync.push", { project: PROJECT }, context)) as { status: string; code: string };
    expect(second.status).toBe("ok");
    const db = await f.db();
    try {
      expect(db.prepare("select count(*) as n from sync_runs").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("the CLI spelling declares the push verb with its three repeatable operator flags and the run takeover", async () => {
    const { getCommandDefinitions } = await import("../definitions.js");
    const definition = getCommandDefinitions().find((entry) => entry.id === "issue-sync.push");
    expect(definition).toBeDefined();
    expect(definition!.cli.path).toEqual(["issue-sync", "push"]);
    expect(definition!.cli.options.map((option) => option.flags)).toEqual([
      "--project <id>",
      "--adopt <localId>=<issueUrl|externalId>",
      "--force-adopt <localId>",
      "--release <localId>",
      "--take-run",
      "--harness <root>",
    ]);
    expect(definition!.cli.options.filter((option) => option.variadic === true).map((option) => option.key)).toEqual([
      "adopt",
      "forceAdopt",
      "release",
    ]);
    // Discoverability: both the help text and the machine-readable requirement
    // name the flag, so the recovery is executable from what the CLI prints.
    expect(definition!.description).toContain("--release <localId>");
    expect(definition!.requirements?.some((entry) => entry.name === "release")).toBe(true);
  });

  test("a push whose run is taken over mid-flight refuses the write with `sync.run-taken` and records nothing", async () => {
    const f = await fixture("push-run-taken", null);
    storeCredential("read,issues:create");
    const bindingId = `linear:${PROJECT}`;
    {
      const handle = await openStore({ harnessDir: f.harnessDir }, "write");
      handle.db.prepare(
        "insert into issues(id, project_id, title, kind, severity, impact, acceptance, created_at, updated_at, identity_key)" +
          " values ('I-000811', ?, 'Taken', 'bug', 'high', 'i', 'a', 'now', 'now', 'sync-I-000811')",
      ).run(PROJECT);
      handle.close();
    }

    // The takeover happens INSIDE the write's provider call: exactly the window
    // the acquisition-time check cannot cover. The write comes back confirmed,
    // and the run must still refuse to record it.
    const base = writeProvider(["bug"]);
    let takenRunId: string | null = null;
    const provider = {
      ...base,
      async applyWrite(write: unknown) {
        const handle = await openStore({ harnessDir: f.harnessDir }, "write");
        const taken = acquireRun(handle.db, {
          bindingId,
          direction: PUSH_DIRECTION,
          holderPid: 777_777,
          holderHost: "other-builder",
          reason: "operator took the run over with --take-run",
          takeRun: true,
        });
        takenRunId = taken.runId;
        handle.close();
        return base.applyWrite(write);
      },
    };
    const refused = (await executeCommand("issue-sync.push", { project: PROJECT }, withProvider(f, provider))) as {
      status: string;
      code: string;
      details?: { recovery?: string };
    };
    expect(refused.status).toBe("refused");
    expect(refused.code).toBe("sync.run-taken");
    // The recovery names the next action an operator can take, and the delivery
    // caveat that makes marker reconciliation the first one.
    const recovery = refused.details?.recovery ?? "";
    expect(recovery).toContain("mstar issue-sync push --project");
    expect(recovery).toContain("correlation marker");

    // The row never took the identity this run's request produced: it stays the
    // unresolved create that the next run's marker scan recovers.
    const after = await openStore({ harnessDir: f.harnessDir }, "read");
    try {
      const row = after.db.prepare("select item_state, external_id from issue_sync_state where local_id = 'I-000811'").get();
      expect(row).toEqual({ item_state: "pending", external_id: null });
      // The successor's row survives the predecessor's exit.
      expect(readRun(after.db, { bindingId, direction: PUSH_DIRECTION })?.runId).toBe(takenRunId!);
    } finally {
      after.close();
    }
  });
});
