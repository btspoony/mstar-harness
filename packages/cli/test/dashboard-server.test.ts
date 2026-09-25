/**
 * Dashboard loopback server.
 *
 * Every case drives an actual temporary loopback server (`startDashboard`)
 * over a real temporary `node:sqlite` store: the DTO envelopes, the refusal
 * statuses, the boundary protections (Host/Origin, read-only, traversal,
 * no-CORS headers), lifecycle (port conflict, staged store, shutdown) and the
 * inlined-artifact proof (the built CLI artifact serves its assets from the
 * generated module with no source asset directory in its packaging context).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { importRoadmapAuthority, initializeStore, listIssues, openStore, registerCatalogEntity, reviewRoadmapImport, type StoreContext, type StoreDb } from "@mstar-harness/engine";
import { startDashboard, type RunningDashboard } from "../src/dashboard/server";
import { dashboardCss, dashboardHtml, dashboardJs } from "../src/dashboard/assets.generated";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-dashboard-server-"));
const RECORDED_AT = "2026-09-18T02:00:00.000Z";
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

async function workspace(name: string): Promise<{ dir: string; context: StoreContext }> {
  const dir = mkdtempSync(join(ROOT, name));
  mkdirSync(join(dir, ".mstar"), { recursive: true });
  const context: StoreContext = { harnessDir: dir };
  const handle = await initializeStore(context);
  handle.close();
  // Normalize the WAL side files (same reason as `withWrite`): a read-only open
  // right after the initializing writer closed can refuse while the -wal/-shm
  // pair is still on disk, and every server read opens the store read-only.
  const probe = await openStore(context, "read");
  probe.close();
  return { dir, context };
}

async function withWrite(context: StoreContext, fn: (db: StoreDb) => void): Promise<void> {
  const handle = await openStore(context, "write");
  try {
    fn(handle.db);
  } finally {
    handle.close();
  }
  // Normalize the WAL side files: a read-only open right after a writer close
  // can refuse while the -wal/-shm pair is still on disk, so drain it with one
  // read open before any server serves this store.
  const probe = await openStore(context, "read");
  probe.close();
}

function seedIssue(db: StoreDb, id: string, title: string, severity: string, registeredAt: string | null, disposition = "open"): void {
  db.prepare(
    "insert into issues(id, project_id, title, kind, severity, disposition, impact, acceptance, registered_at, created_at, updated_at, revision, identity_key) " +
      "values (?, 'proj-a', ?, 'bug', ?, ?, 'impact', 'acceptance', ?, ?, ?, 1, ?)",
  ).run(id, title, severity, disposition, registeredAt, RECORDED_AT, RECORDED_AT, `identity-${id}`);
}

/**
 * A minimal valid harness: one declared workflow whose snapshot is the only
 * projected row this store can publish. A workspace without these sources
 * cannot publish a projection generation at all.
 */
function declareWorkflow(dir: string, id: string): void {
  mkdirSync(join(dir, ".mstar", "workflows", id), { recursive: true });
  writeFileSync(
    join(dir, ".mstar", "status.json"),
    JSON.stringify({
      version: 2,
      updated_at: "2026-09-18",
      workflows: [{ id, type: "plan", started_at: RECORDED_AT, dir: `workflows/${id}` }],
    }),
  );
  writeFileSync(
    join(dir, ".mstar", "workflows", id, "snapshot.json"),
    JSON.stringify({
      schema_version: 1,
      id,
      type: "plan",
      status: "running",
      started_at: RECORDED_AT,
      updated_at: RECORDED_AT,
      plans: [],
    }),
  );
}

/**
 * One raw request over node:http so the Host header is fully controlled
 * (browser-grade clients refuse to send a spoofed Host; an attacker does not).
 */
function raw(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.once("error", reject);
    req.end();
  });
}

async function start(
  dir: string,
  options: { port?: number; project?: string } = {},
): Promise<RunningDashboard> {
  return startDashboard({ harnessDir: dir, port: options.port, projectId: options.project });
}

describe("static shell and inlined assets", () => {
  let server: RunningDashboard;
  beforeAll(async () => {
    server = await start((await workspace("static-")).dir);
  });
  afterAll(() => server.close());

  test("GET / serves the D1 shell with the exact CSP and no CORS header", async () => {
    const res = await raw(server.url);
    expect(res.status).toBe(200);
    expect(res.body).toBe(dashboardHtml);
    expect(res.headers["content-security-policy"]).toBe(CSP);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("HEAD works for static resources and returns no body", async () => {
    const res = await raw(server.url, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
    expect(res.headers["content-type"]).toContain("text/html");
  });

  test("fixed asset routes serve the bundled strings; other paths never touch the filesystem", async () => {
    const js = await raw(new URL("/assets/app.js", server.url).href);
    expect(js.status).toBe(200);
    expect(js.body).toBe(dashboardJs);
    const css = await raw(new URL("/assets/app.css", server.url).href);
    expect(css.status).toBe(200);
    expect(css.body).toBe(dashboardCss);
    for (const pathname of ["/assets/app.mjs", "/assets/../web/shell.html", "/web/shell.html", "/style.css", "/%2e%2e/etc/passwd"]) {
      const res = await raw(new URL(pathname, server.url).href);
      expect(res.status).toBe(404);
    }
  });

  test("POST to a static route is refused", async () => {
    const res = await raw(server.url, { method: "POST" });
    expect(res.status).toBe(405);
    expect(JSON.parse(res.body).error.code).toBe("method-not-allowed");
  });
});

describe("API over a real store", () => {
  let server: RunningDashboard;
  let dir: string;
  let context: StoreContext;
  beforeAll(async () => {
    ({ dir, context } = await workspace("api-"));
    await withWrite(context, (db) => {
      seedIssue(db, "I-000001", "critical open", "critical", "2026-09-01");
      seedIssue(db, "I-000002", "medium open", "medium", "2026-09-02");
      seedIssue(db, "I-000003", "resolved", "high", "2026-09-03");
    });
    await withWrite(context, (db) => {
      db.prepare("update issues set disposition = 'resolved', closed_at = ? where id = 'I-000003'").run(RECORDED_AT);
    });
    server = await start(dir);
  });
  afterAll(() => server.close());

  test("GET /api/issues answers the P6 envelope matching the authoritative rows", async () => {
    const before = await listIssues(context, {});
    const res = await raw(new URL("/api/issues", server.url).href);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toBe(CSP);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const envelope = JSON.parse(res.body) as { data: { items: Array<{ id: string }>; total: number }; storeRevision: number; catalogRevision: number; projection: { freshness: string; diagnostics: unknown[] } };
    expect(envelope.data.items.map((row) => row.id)).toEqual(before.items.map((row) => row.id));
    expect(envelope.storeRevision).toBe(before.storeRevision);

    // Read-only: the authoritative rows and revisions are unchanged after the GET.
    const after = await listIssues(context, {});
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("GET /api/issues/:id answers the detail DTO; unknown id is a structured 404", async () => {
    const found = await raw(new URL("/api/issues/I-000001", server.url).href);
    expect(found.status).toBe(200);
    expect((JSON.parse(found.body) as { data: { id: string } }).data.id).toBe("I-000001");
    const missing = await raw(new URL("/api/issues/I-999999", server.url).href);
    expect(missing.status).toBe(404);
    expect((JSON.parse(missing.body) as { error: { code: string } }).error.code).toBe("issue.not-found");
  });

  test("HEAD to the API is refused without executing a store read", async () => {
    const head = await raw(new URL("/api/issues", server.url).href, { method: "HEAD" });
    expect(head.status).toBe(405);
    // A HEAD response carries no body by spec; the structured method refusal
    // is observable via the same 405 code on a non-HEAD method (tested below).
    expect(head.body).toBe("");
    // Prove the refusal precedes store access: on a server whose store is
    // missing, a GET reaches the store (503) while HEAD never does (405).
    const dir = mkdtempSync(join(ROOT, "no-store-"));
    mkdirSync(join(dir, ".mstar"), { recursive: true });
    const noStore = await startDashboard({ harnessDir: dir });
    try {
      const get = await raw(new URL("/api/issues", noStore.url).href);
      expect(get.status).toBe(503);
      const headNoStore = await raw(new URL("/api/issues", noStore.url).href, { method: "HEAD" });
      expect(headNoStore.status).toBe(405);
      expect(headNoStore.body).toBe("");
    } finally {
      await noStore.close();
    }
  });

  test("POST to the API is refused: the dashboard is read-only", async () => {
    for (const pathname of ["/api/issues", "/api/workflows"]) {
      const res = await raw(new URL(pathname, server.url).href, { method: "POST", headers: { "content-type": "application/json" } });
      expect(res.status).toBe(405);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("method-not-allowed");
      expect(body.error.message).toMatch(/read-only/);
    }
  });

  test("wrong Host and wrong Origin are refused (no CORS header is ever sent)", async () => {
    const wrongHost = await raw(new URL("/api/issues", server.url).href, { headers: { host: "evil.example" } });
    expect(wrongHost.status).toBe(403);
    expect((JSON.parse(wrongHost.body) as { error: { code: string } }).error.code).toBe("forbidden");
    const rebound = await raw(new URL("/api/issues", server.url).href, { headers: { host: "127.0.0.1:1" } });
    expect(rebound.status).toBe(403);
    const wrongOrigin = await raw(new URL("/api/issues", server.url).href, { headers: { origin: "http://evil.example" } });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.headers["access-control-allow-origin"]).toBeUndefined();
    const sameOrigin = await raw(new URL("/api/issues", server.url).href, {
      headers: { origin: new URL(server.url).origin },
    });
    expect(sameOrigin.status).toBe(200);
  });

  test("traversal and unknown paths are refused without touching the filesystem", async () => {
    for (const pathname of ["/api/issues/../../etc/passwd", "/api/projects", "/api/issues/%2e%2e", "/api/issues/a%2Fb", "/api/roadmap/deep/path"]) {
      const res = await raw(new URL(`http://127.0.0.1:${new URL(server.url).port}${pathname}`));
      expect([400, 404]).toContain(res.status);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(["usage", "not-found"]).toContain(body.error.code);
    }
    // Malformed percent-escaping is a usage refusal.
    const malformed = await raw(new URL(`http://127.0.0.1:${new URL(server.url).port}/api/issues/%zz`));
    expect(malformed.status).toBe(400);
    expect((JSON.parse(malformed.body) as { error: { code: string } }).error.code).toBe("usage");
  });

  test("query refusals: unknown enum, excessive search and over-limit pagination", async () => {
    const cases: Array<[string, number, string]> = [
      ["/api/issues?disposition=fixed", 400, "disposition must be one of"],
      ["/api/issues?severity=blocker", 400, "severity must be one of"],
      [`/api/issues?q=${"x".repeat(201)}`, 400, "at most 200 characters"],
      ["/api/issues?limit=201", 400, "limit must be an integer between 1 and 200"],
      ["/api/issues?bogus=1", 400, "not a supported issues query parameter"],
      ["/api/roadmap", 400, "requires a project query parameter"],
    ];
    for (const [pathname, status, message] of cases) {
      const res = await raw(`http://127.0.0.1:${new URL(server.url).port}${pathname}`);
      expect(res.status).toBe(status);
      expect((JSON.parse(res.body) as { error: { message: string } }).error.message).toContain(message);
    }
  });

  test("stale projection is disclosed in the envelope, never hidden", async () => {
    await withWrite(context, (db) => {
      db.prepare(
        "update projection_meta set freshness = 'stale', last_error_json = ? where id = 1",
      ).run(
        JSON.stringify({ sources: [{ sourceKey: "workflows", reason: "source-unreadable", message: "snapshot.json is unreadable" }] }),
      );
    });
    const res = await raw(new URL("/api/issues", server.url).href);
    expect(res.status).toBe(200);
    const envelope = JSON.parse(res.body) as { projection: { freshness: string; diagnostics: Array<{ sourceKey: string; reason: string }> } };
    expect(envelope.projection.freshness).toBe("stale");
    expect(envelope.projection.diagnostics[0]?.sourceKey).toBe("workflows");
  });
});

describe("roadmap authority API", () => {
  test("serves imported content without a projection or source file", async () => {
    const { dir, context } = await workspace("roadmap-authority-");
    await registerCatalogEntity(context, {
      kind: "project", id: "proj-roadmap", title: "Roadmap", rootKind: "projects", relativePath: "proj-roadmap",
    }, { operationId: "register-roadmap-api", actor: "dashboard-test" });
    const source = join(dir, "roadmap.md");
    writeFileSync(source, "---\nproject_id: proj-roadmap\ntitle: Roadmap\nstatus: active\ncreated_at: 2026-09-25\n---\n\n## Direction\n\nAuthority survives source removal.\n\n## Notes\n\nVisible explanatory content.\n");
    const review = await reviewRoadmapImport(context, "proj-roadmap", source);
    await importRoadmapAuthority(context, review, { operationId: "import-roadmap-api" });
    unlinkSync(source);

    const server = await start(dir, { project: "proj-roadmap" });
    try {
      const response = await raw(new URL("/api/roadmap?project=proj-roadmap", server.url).href);
      expect(response.status).toBe(200);
      const envelope = JSON.parse(response.body) as {
        data: { authority: { state: string }; content: { contentMarkdown: string; sections: Array<{ heading: string }> } };
      };
      expect(envelope.data.authority.state).toBe("present");
      expect(envelope.data.content.contentMarkdown).toContain("Authority survives source removal.");
      expect(envelope.data.content.sections.map((section) => section.heading)).toContain("Notes");
    } finally {
      await server.close();
    }
  });
});

describe("workflow detail and the projection generation", () => {
  test("a bookmarked workflow detail answers the unavailable envelope, not a missing record", async () => {
    // No harness sources: no generation can be published, so a workflow row
    // cannot be read at all. The detail must disclose that (the envelope's own
    // projection block) instead of claiming the record does not exist.
    const { dir } = await workspace("workflow-unavailable-");
    const server = await start(dir);
    try {
      const res = await raw(new URL("/api/workflows/wf-bookmarked", server.url).href);
      expect(res.status).toBe(200);
      const envelope = JSON.parse(res.body) as {
        data: null;
        projection: { generation: number | null; freshness: string };
      };
      expect(envelope.data).toBeNull();
      expect(envelope.projection.generation).toBeNull();
      expect(envelope.projection.freshness).toBe("unavailable");
      // The matching list route answers the same fact as an unlisted page: no
      // rows are claimed in either place.
      const list = await raw(new URL("/api/workflows", server.url).href);
      expect(list.status).toBe(200);
      expect((JSON.parse(list.body) as { data: { items: unknown[] } }).data.items).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("with a published generation an unknown id is still a structured 404", async () => {
    const { dir } = await workspace("workflow-published-");
    declareWorkflow(dir, "wf-demo");
    const server = await start(dir);
    try {
      const found = await raw(new URL("/api/workflows/wf-demo", server.url).href);
      expect(found.status).toBe(200);
      expect((JSON.parse(found.body) as { data: { id: string } }).data.id).toBe("wf-demo");
      const missing = await raw(new URL("/api/workflows/wf-absent", server.url).href);
      expect(missing.status).toBe(404);
      const body = JSON.parse(missing.body) as { data?: unknown; error?: { code: string } };
      expect(body.data).toBeUndefined();
      expect(body.error?.code).toBe("not-found");
    } finally {
      await server.close();
    }
  });
});

describe("boundary and lifecycle", () => {

  test("a staged store refuses reads with store.not-active (never an empty page)", async () => {
    const { dir, context } = await workspace("staged-");
    await withWrite(context, (db) => {
      db.prepare("update store_meta set authority_state = 'staged' where id = 1").run();
    });
    const server = await start(dir);
    try {
      const res = await raw(new URL("/api/issues", server.url).href);
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("store.not-active");
      // No local filesystem path leaks in the refusal.
      expect(body.error.message).not.toContain(dir);
    } finally {
      await server.close();
    }
  });

  test("a missing store refuses reads with store.not-initialized", async () => {
    const dir = mkdtempSync(join(ROOT, "missing-"));
    mkdirSync(join(dir, ".mstar"), { recursive: true });
    const server = await startDashboard({ harnessDir: dir });
    try {
      const res = await raw(new URL("/api/issues", server.url).href);
      expect(res.status).toBe(503);
      expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe("store.not-initialized");
    } finally {
      await server.close();
    }
  });

  test("an unknown project fails before the server starts", async () => {
    const { dir } = await workspace("project-");
    await expect(startDashboard({ harnessDir: dir, projectId: "no-such-project" })).rejects.toThrow(/Unknown project/);
  });

  test("without --project the served URL carries no selector", async () => {
    const { dir } = await workspace("unscoped-");
    const server = await start(dir);
    try {
      expect(new URL(server.url).search).toBe("");
    } finally {
      await server.close();
    }
  });

  test("a known project starts, seeds the served URL and scopes the issue list", async () => {
    const { dir, context } = await workspace("scoped-");
    await withWrite(context, (db) => {
      db.prepare(
        "insert into catalog_entities(kind, id, title, root_kind, relative_path, registered_at, updated_at) " +
          "values ('project', 'proj-a', 'Project A', 'repository', 'proj-a', ?, ?)",
      ).run(RECORDED_AT, RECORDED_AT);
      seedIssue(db, "I-000001", "scoped", "high", "2026-09-01");
    });
    const server = await startDashboard({ harnessDir: dir, projectId: "proj-a" });
    try {
      // The selector travels in the served URL: the shell parses
      // `location.search` as its initial Issues filter, and `--open` opens
      // exactly this URL, so the seeded filter is the one the browser applies.
      expect(new URL(server.url).searchParams.get("project")).toBe("proj-a");
      const shell = await raw(server.url);
      expect(shell.status).toBe(200);
      expect(shell.body).toBe(dashboardHtml);
      const res = await raw(new URL("/api/issues?project=proj-a", server.url).href);
      expect(res.status).toBe(200);
      expect((JSON.parse(res.body) as { data: { total: number } }).data.total).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("a port conflict refuses with an actionable message and leaves the other server running", async () => {
    const { dir } = await workspace("conflict-");
    const first = await startDashboard({ harnessDir: dir, port: 0 });
    try {
      const usedPort = new URL(first.url).port;
      await expect(startDashboard({ harnessDir: dir, port: Number(usedPort) })).rejects.toThrow(/already in use/);
      const stillUp = await raw(new URL("/api/issues", first.url).href);
      expect(stillUp.status).toBe(200); // the empty store answers: the socket is alive
      expect((JSON.parse(stillUp.body) as { data: { total: number } }).data.total).toBe(0);
    } finally {
      await first.close();
    }
  });

  test("close() is idempotent and the socket stops accepting", async () => {
    const { dir } = await workspace("close-");
    const server = await startDashboard({ harnessDir: dir });
    const url = server.url;
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
    await expect(raw(new URL("/api/issues", url).href)).rejects.toThrow();
  });

  test("out-of-range ports refuse before listening", async () => {
    for (const port of [-1, 65536, 1.5]) {
      await expect(startDashboard({ harnessDir: ROOT, port })).rejects.toThrow(/--port/);
    }
  });
});

describe("inlined-artifact serving (built CLI, no source asset directory)", () => {
  test(
    "the built CLI artifact serves the bundled assets from a temp packaging context without any asset directory",
    async () => {
      // Build once, then copy ONLY the bundle into a packaging context that has
      // no web/ sources and no assets directory.
      const cliDir = join(import.meta.dir, "..");
      const build = spawnSync("bun", ["run", "build"], { cwd: cliDir, encoding: "utf8" });
      expect(build.status).toBe(0);
      const bundle = join(cliDir, "dist", "mstar-harness.js");
      expect(existsSync(bundle)).toBe(true);
      const packaging = mkdtempSync(join(ROOT, "packaging-"));
      const packaged = join(packaging, "mstar-harness.js");
      const { copyFileSync } = await import("node:fs");
      copyFileSync(bundle, packaged);

      // A real workspace for the CLI process to serve.
      const { dir, context } = await workspace("artifact-");
      await withWrite(context, (db) => {
        seedIssue(db, "I-000001", "artifact", "high", "2026-09-01");
      });

      const child = spawn("bun", [packaged, "dashboard", "--port", "0"], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`dashboard did not announce a URL; output:\n${out}`)), 30_000);
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString("utf8");
          const match = out.match(/dashboard at (http:\/\/127\.0\.0\.1:\d+\/)/);
          if (match) {
            clearTimeout(timer);
            resolve(match[1] as string);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`dashboard exited early (${code})`));
        });
      });

      try {
        const shell = await raw(url);
        expect(shell.status).toBe(200);
        expect(shell.body).toBe(dashboardHtml);
        const js = await raw(new URL("/assets/app.js", url).href);
        expect(js.status).toBe(200);
        expect(js.body).toBe(dashboardJs);
        const css = await raw(new URL("/assets/app.css", url).href);
        expect(css.status).toBe(200);
        expect(css.body).toBe(dashboardCss);
        const issues = await raw(new URL("/api/issues", url).href);
        expect(issues.status).toBe(200);
        expect((JSON.parse(issues.body) as { data: { total: number } }).data.total).toBe(1);
      } finally {
        child.kill("SIGTERM");
        const exited = await new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => resolve("timeout"), 10_000);
          child.once("exit", (code) => {
            clearTimeout(timer);
            resolve(code === null ? "signal" : String(code));
          });
        });
        // SIGTERM closes the server once and the CLI exits cleanly.
        expect(exited).toBe("0");
        await expect(raw(url)).rejects.toThrow();
        rmSync(packaging, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 },
  );
});
