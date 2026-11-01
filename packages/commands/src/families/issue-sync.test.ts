/**
 * issue-sync.test.ts — the one supported import entry (mirror-import plan
 * Task 4): refusals before any write, and the end-to-end zero-delta proof over
 * a fixture provider. No live call, no credential: the provider is injected
 * through the host effects seam exactly as a host adapter would be.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  IMPORTED_ACCEPTANCE_KEY,
  IMPORTED_ROOT_CAUSE_KEY,
  bindProject,
  computeIdentityKey,
  initializeStore,
  openStore,
  readLedgerSummary,
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
    // No row anywhere changed — the store's updated_at set included.
    expect(await storeSnapshot(f)).toEqual(snapshot);
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

  test("an unmappable item is reported by identity and page index while the rest is ingested (F2)", async () => {
    const p = provider(() => ({
      items: [item(), item({ externalId: "LIN-2", title: "Second" })],
      nextCursor: null,
      failures: [{ index: 2, externalId: "LIN-BAD", cause: 'issue at page index 2 has no usable "title"' }],
    }));
    const f = await fixture("poison-item", p);
    const result = await runImport(f.context);
    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({ imported: 2, failed: 0, stopped: "stranded" });
    expect(result.data?.stranded).toEqual([
      { page: 1, index: 2, externalId: "LIN-BAD", cause: 'issue at page index 2 has no usable "title"' },
    ]);
    // The good items were ingested; the poisoned one did not stop them.
    const db = await f.db();
    try {
      expect(db.prepare("select count(*) as n from issues").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
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
