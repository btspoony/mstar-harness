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
  bindProject,
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
  for (const [state, cause] of [
    ["service-absent", "service-absent: no Linear entry in the host MCP configuration"],
    ["access-denied", "access-denied: Linear MCP handshake answered 401"],
  ] as const) {
    test(`probe ${state} refuses linear.provider-disabled and writes nothing`, async () => {
      const calls: unknown[] = [];
      const f = await fixture(`refuse-${state}`, provider(() => ({ items: [], nextCursor: null }), { state, cause }));
      const before = await storeSnapshot(f);
      const result = await runImport(f.context as InvocationContext & { effects: { issueProvider?: () => unknown } });
      expect(result.status).toBe("refused");
      expect(result.code).toBe("linear.provider-disabled");
      expect(result.message).toContain(state);
      expect(result.message).toContain(cause);
      expect(await storeSnapshot(f)).toEqual(before);
      expect(calls).toEqual([]);
    });
  }

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

  test("a host with no adapter refuses linear.list-unimplemented", async () => {
    const f = await fixture("refuse-nohost", null);
    const result = await runImport(f.context);
    expect(result.code).toBe("linear.list-unimplemented");
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
    expect(first.data).toMatchObject({ imported: 3, updated: 0, skipped: 0, failed: 0, pages: 2, requests: 2, cursor: "c-2" });

    const snapshot = await storeSnapshot(f);
    p.requests.length = 0;
    const second = await runImport(f.context);
    expect(second.status).toBe("ok");
    // The store's cursor is resumable: run 2 re-reads only from the recorded
    // position (the overlap window), so it costs ONE request and re-ingests it
    // as a no-op.
    expect(second.data).toMatchObject({ imported: 0, updated: 0, skipped: 1, failed: 0, pages: 1, requests: 1, cursor: "c-2" });
    // No row anywhere changed — the store's updated_at set included.
    expect(await storeSnapshot(f)).toEqual(snapshot);
    // The second run is evidenced by requests, not assumed: one page request.
    expect(p.requests).toEqual(["c-2"]);
  });

  test("a single page run reports one request and resumes from the recorded cursor", async () => {
    const p = provider(() => ({ items: [item()], nextCursor: null }));
    const f = await fixture("single-page", p);
    const first = await runImport(f.context);
    expect(first.data).toMatchObject({ imported: 1, pages: 1, requests: 1, cursor: null });
    const second = await runImport(f.context);
    expect(second.data).toMatchObject({ imported: 0, updated: 0, skipped: 1, pages: 1, requests: 1 });
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

  test("--max-pages bounds one run and the reported cursor resumes it", async () => {
    const p = provider((cursor) => ({ items: [item({ externalId: `LIN-${cursor ?? "start"}` })], nextCursor: `c-${cursor ?? "start"}` }));
    const f = await fixture("max-pages", p);
    const bounded = await runImport(f.context, { maxPages: 1 });
    expect(bounded.data).toMatchObject({ imported: 1, pages: 1, requests: 1, cursor: "c-start" });
    const resumed = await runImport(f.context, { maxPages: 1 });
    expect(resumed.data).toMatchObject({ imported: 1, pages: 1, requests: 1, cursor: "c-c-start" });
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
